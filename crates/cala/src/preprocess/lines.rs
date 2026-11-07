//! Line artifacts: per-frame row and column offsets inside the FOV.
//!
//! CMOS readout can add an offset shared by a whole row (row-wise reset or
//! supply noise, which changes every frame) or a whole column (column
//! amplifier fixed-pattern noise, which is static). After glow flattening the
//! frame floor is ~0, so such an offset shows up directly in the level of its
//! row or column over the field of view. This stage subtracts, per frame:
//!
//! 1. from every row, the robust level of that row's FOV pixels, then
//! 2. from every column, the robust level of that column's FOV pixels (of
//!    the result).
//!
//! Only FOV pixels are measured or changed. A line with fewer than
//! [`MIN_LINE_PIXELS`] FOV pixels is left alone. The stage is stateless.
//!
//! # Robust level: a clipped mean
//!
//! A plain mean is pulled up by the cells on the line: a bright cell lifts its
//! row's and column's mean by (its extent on the line / line length) of its
//! amplitude, and subtracting that along the whole line draws a dark cross
//! through every bright cell. On an early version of the minisim fixture
//! (dense cells twice as bright as their background)
//! plain column means removed the column fixed-pattern noise but left *more*
//! column structure on the background than they removed. So the level is the
//! mean of the pixels below `m + 2.5 σ̂`, where `m` is the line mean and
//! `σ̂ = √(π/2) · mean|x − m|` (the Gaussian σ from the mean absolute
//! deviation): cells, which are bright outliers on a ~0 floor, drop out, and
//! the clipped mean of the noise is biased by only −0.02 σ. Three passes over
//! the line instead of one; a median would be exact but needs a selection per
//! line per frame.
//!
//! Whether it helps depends on the sensor, so it is optional ([`LineMode`]).
//! Its default (both) comes from the workshop CA1 recording, measured by
//! `examples/preprocess_eval.rs` on 2000 frames after flattening:
//!
//! * **Rows carry per-frame noise.** The frame-to-frame MAD-diff σ of a row's
//!   mean is 0.42 grey levels where white pixel noise alone gives 0.13
//!   (3.3x); for columns it is 0.17 against 0.13. Shared row noise couples
//!   the noise of cells on the same rows: 9x9-pixel blocks on the same rows
//!   had a noise correlation of 0.035 (0.000 across rows). Correcting rows
//!   brings it to −0.016 and lowers the block-trace noise by 2.6 % (3.3 %
//!   with columns too).
//! * **Columns carry static fixed-pattern noise.** The column profile of the
//!   flattened mean image has 0.85 grey levels of column-to-column structure
//!   (rows: 0.15). Without motion the background stage absorbs it (it is
//!   static per pixel), but the background lives in tissue coordinates:
//!   once frames are registered, a sensor-fixed column pattern moves against
//!   the tissue and can no longer be absorbed, so it has to go here, before
//!   registration.
//!
//! The cost is 0.34 ms per 600x600 frame for both.

use super::fov::FovMask;
use super::{Dims, PreprocessError};

/// A row or column needs at least this many FOV pixels to be corrected.
pub const MIN_LINE_PIXELS: usize = 16;
/// Clip at the line mean plus this many σ̂.
const CLIP_SIGMA: f64 = 2.5;
/// σ / mean absolute deviation for a Gaussian.
const SIGMA_PER_MAD: f64 = 1.253_314_137_315_500_3;

/// Which lines to correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineMode {
    Off,
    Rows,
    Columns,
    Both,
}

impl Default for LineMode {
    /// Both: rows for the per-frame row noise, columns for the static column
    /// pattern that registration would otherwise smear (see the module docs).
    fn default() -> LineMode {
        LineMode::Both
    }
}

impl LineMode {
    pub fn code(self) -> u8 {
        match self {
            LineMode::Off => 0,
            LineMode::Rows => 1,
            LineMode::Columns => 2,
            LineMode::Both => 3,
        }
    }

    pub fn from_code(c: u8) -> Option<LineMode> {
        Some(match c {
            0 => LineMode::Off,
            1 => LineMode::Rows,
            2 => LineMode::Columns,
            3 => LineMode::Both,
            _ => return None,
        })
    }
}

/// Per-frame numbers from [`LineCorrector::apply`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LineStats {
    /// RMS of the subtracted row offsets (0 if rows were not corrected).
    pub row_rms: f32,
    /// RMS of the subtracted column offsets.
    pub col_rms: f32,
}

/// The line-offset stage.
#[derive(Debug, Clone)]
pub struct LineCorrector {
    dims: Dims,
    mode: LineMode,
    /// The FOV mask as 0.0 / 1.0 (branch-free accumulation).
    w: Vec<f32>,
    row_n: Vec<u32>,
    col_n: Vec<u32>,
    col_a: Vec<f32>,
    col_b: Vec<f32>,
    col_c: Vec<f32>,
}

/// Lanes of the partial sums in [`lane_sum`]: a single running sum along a
/// row is a serial dependency chain that cannot be vectorized (float addition
/// is not reassociated), eight independent ones can.
const LANES: usize = 8;

/// `Σ f(v[i], w[i])` with [`LANES`] partial sums.
#[inline]
fn lane_sum(v: &[f32], w: &[f32], f: impl Fn(f32, f32) -> f32) -> f32 {
    let mut acc = [0.0f32; LANES];
    let (vc, vr) = v.as_chunks::<LANES>();
    let (wc, wr) = w.as_chunks::<LANES>();
    for (a, b) in vc.iter().zip(wc) {
        for ((s, &x), &m) in acc.iter_mut().zip(a).zip(b) {
            *s += f(x, m);
        }
    }
    let tail: f32 = vr.iter().zip(wr).map(|(&x, &m)| f(x, m)).sum();
    acc.iter().sum::<f32>() + tail
}

/// Clipped mean of the masked samples of one line (`n` ≥ 1 of them).
fn clipped_mean_line(v: &[f32], w: &[f32], n: usize) -> f32 {
    let inv = 1.0 / n as f32;
    let mean = lane_sum(v, w, |x, m| x * m) * inv;
    let dev = lane_sum(v, w, |x, m| (x - mean).abs() * m) * inv;
    let cut = mean + (CLIP_SIGMA * SIGMA_PER_MAD) as f32 * dev;
    let s = lane_sum(v, w, |x, m| if x <= cut { x * m } else { 0.0 });
    let k = lane_sum(v, w, |x, m| if x <= cut { m } else { 0.0 });
    if k > 0.0 {
        s / k
    } else {
        mean
    }
}

impl LineCorrector {
    pub fn new(fov: &FovMask, mode: LineMode) -> LineCorrector {
        let dims = fov.dims();
        let w = fov.weights();
        let mut row_n = vec![0u32; dims.height];
        let mut col_n = vec![0u32; dims.width];
        for (y, row) in fov.mask().chunks_exact(dims.width).enumerate() {
            for (x, &m) in row.iter().enumerate() {
                if m != 0 {
                    row_n[y] += 1;
                    col_n[x] += 1;
                }
            }
        }
        LineCorrector {
            dims,
            mode,
            w,
            row_n,
            col_n,
            col_a: vec![0.0; dims.width],
            col_b: vec![0.0; dims.width],
            col_c: vec![0.0; dims.width],
        }
    }

    pub fn mode(&self) -> LineMode {
        self.mode
    }

    /// Subtract the line offsets in place (stateless).
    pub fn apply(&mut self, frame: &mut [f32]) -> Result<LineStats, PreprocessError> {
        self.dims.check("frame", frame.len())?;
        let mut st = LineStats::default();
        if matches!(self.mode, LineMode::Rows | LineMode::Both) {
            st.row_rms = self.rows(frame);
        }
        if matches!(self.mode, LineMode::Columns | LineMode::Both) {
            st.col_rms = self.columns(frame);
        }
        Ok(st)
    }

    fn rows(&self, frame: &mut [f32]) -> f32 {
        let width = self.dims.width;
        let (mut ss, mut k) = (0.0f64, 0usize);
        for (y, (row, wrow)) in frame
            .chunks_exact_mut(width)
            .zip(self.w.chunks_exact(width))
            .enumerate()
        {
            let n = self.row_n[y] as usize;
            if n < MIN_LINE_PIXELS {
                continue;
            }
            let off = clipped_mean_line(row, wrow, n);
            for (v, &m) in row.iter_mut().zip(wrow) {
                *v -= off * m;
            }
            ss += f64::from(off) * f64::from(off);
            k += 1;
        }
        if k > 0 {
            (ss / k as f64).sqrt() as f32
        } else {
            0.0
        }
    }

    /// The same clipped mean per column, accumulated row by row so the frame
    /// is read in memory order (three passes).
    fn columns(&mut self, frame: &mut [f32]) -> f32 {
        let width = self.dims.width;
        let inv_n: Vec<f32> = self.col_n.iter().map(|&n| 1.0 / n.max(1) as f32).collect();
        // Pass 1: means.
        let mean = &mut self.col_a;
        mean.iter_mut().for_each(|s| *s = 0.0);
        for (row, wrow) in frame.chunks_exact(width).zip(self.w.chunks_exact(width)) {
            for ((s, &v), &m) in mean.iter_mut().zip(row).zip(wrow) {
                *s += v * m;
            }
        }
        mean.iter_mut().zip(&inv_n).for_each(|(s, &i)| *s *= i);
        // Pass 2: mean absolute deviations -> clip levels.
        let cut = &mut self.col_b;
        cut.iter_mut().for_each(|s| *s = 0.0);
        for (row, wrow) in frame.chunks_exact(width).zip(self.w.chunks_exact(width)) {
            for (((d, &v), &m), &mu) in cut.iter_mut().zip(row).zip(wrow).zip(mean.iter()) {
                *d += (v - mu).abs() * m;
            }
        }
        let clip = (CLIP_SIGMA * SIGMA_PER_MAD) as f32;
        for ((d, &mu), &i) in cut.iter_mut().zip(mean.iter()).zip(&inv_n) {
            *d = mu + clip * *d * i;
        }
        // Pass 3: clipped sums and counts.
        let sum = &mut self.col_c;
        sum.iter_mut().for_each(|s| *s = 0.0);
        let mut cnt = vec![0.0f32; width];
        for (row, wrow) in frame.chunks_exact(width).zip(self.w.chunks_exact(width)) {
            for ((((s, c), &v), &m), &ct) in sum
                .iter_mut()
                .zip(cnt.iter_mut())
                .zip(row)
                .zip(wrow)
                .zip(cut.iter())
            {
                let keep = if v <= ct { m } else { 0.0 };
                *s += v * keep;
                *c += keep;
            }
        }
        let (mut ss, mut k) = (0.0f64, 0usize);
        for (((s, &c), &n), &mu) in sum.iter_mut().zip(&cnt).zip(&self.col_n).zip(mean.iter()) {
            if (n as usize) < MIN_LINE_PIXELS {
                *s = 0.0;
                continue;
            }
            *s = if c > 0.0 { *s / c } else { mu };
            ss += f64::from(*s) * f64::from(*s);
            k += 1;
        }
        for (row, wrow) in frame
            .chunks_exact_mut(width)
            .zip(self.w.chunks_exact(width))
        {
            for ((v, &off), &m) in row.iter_mut().zip(sum.iter()).zip(wrow) {
                *v -= off * m;
            }
        }
        if k > 0 {
            (ss / k as f64).sqrt() as f32
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_row_and_column_offsets() {
        let dims = Dims::new(40, 30).unwrap();
        let fov = FovMask::full(dims);
        let mut frame = vec![0.0f32; dims.pixels()];
        for y in 0..30 {
            for x in 0..40 {
                frame[y * 40 + x] = (y as f32 * 0.37).sin() * 3.0 + (x as f32 * 0.91).cos() * 2.0;
            }
        }
        let mut lc = LineCorrector::new(&fov, LineMode::Both);
        let st = lc.apply(&mut frame).unwrap();
        assert!(st.row_rms > 1.0 && st.col_rms > 0.5);
        // The clipped mean of a deterministic pattern is not exactly its
        // mean; what is left is small next to the offsets.
        let rms = (frame.iter().map(|v| v * v).sum::<f32>() / frame.len() as f32).sqrt();
        assert!(rms < 0.6, "residual rms {rms}");
    }

    #[test]
    fn bright_cell_does_not_set_the_offset() {
        let dims = Dims::new(100, 100).unwrap();
        let fov = FovMask::full(dims);
        // Column offsets of ±1 and one bright cell of +50 spanning 10 rows
        // of columns 40-49.
        let mut frame = vec![0.0f32; dims.pixels()];
        for y in 0..100 {
            for x in 0..100 {
                let noise = (((y * 100 + x) * 2654435761usize % 1000) as f32 / 1000.0 - 0.5) * 2.0;
                let off = if x % 2 == 0 { 1.0 } else { -1.0 };
                let cell = if (40..50).contains(&x) && (40..50).contains(&y) {
                    50.0
                } else {
                    0.0
                };
                frame[y * 100 + x] = off + cell + noise;
            }
        }
        let mut lc = LineCorrector::new(&fov, LineMode::Columns);
        lc.apply(&mut frame).unwrap();
        // Off-cell pixels of the cell's columns are not pushed down by the cell
        // (a plain mean would subtract 5).
        let below: f32 = (0..40).map(|y| frame[y * 100 + 45]).sum::<f32>() / 40.0;
        assert!(below.abs() < 0.5, "cross artifact {below}");
        // The ±1 offsets are gone.
        let even: f32 = (0..40).map(|y| frame[y * 100 + 10]).sum::<f32>() / 40.0;
        let odd: f32 = (0..40).map(|y| frame[y * 100 + 11]).sum::<f32>() / 40.0;
        assert!((even - odd).abs() < 0.3, "{even} {odd}");
    }

    #[test]
    fn off_is_identity_and_short_lines_skipped() {
        let dims = Dims::new(20, 20).unwrap();
        let mut mask = vec![0u8; 400];
        mask[0..10].fill(1); // row 0 has only 10 FOV pixels
        let fov = FovMask::from_mask(dims, &mask).unwrap();
        let mut f = vec![5.0f32; 400];
        LineCorrector::new(&fov, LineMode::Off)
            .apply(&mut f)
            .unwrap();
        assert!(f.iter().all(|&v| v == 5.0));
        LineCorrector::new(&fov, LineMode::Both)
            .apply(&mut f)
            .unwrap();
        assert!(f.iter().all(|&v| v == 5.0));
        assert!(LineCorrector::new(&fov, LineMode::Rows)
            .apply(&mut [0.0; 3])
            .is_err());
        for c in 0..4 {
            assert_eq!(LineMode::from_code(c).unwrap().code(), c);
        }
        assert!(LineMode::from_code(9).is_none());
    }
}
