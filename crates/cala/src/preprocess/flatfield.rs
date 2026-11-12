//! Sensor flat field (pixel gain, PRNU) estimated from the motion dither.
//!
//! # Why
//!
//! Each sensor pixel converts light to grey levels with its own gain, a few
//! per cent off nominal (photo-response non-uniformity, plus column structure).
//! The pattern is fixed to the sensor and multiplies all the light that lands
//! on it, mostly the bright neuropil/background. Registration moves the tissue
//! back into place and so moves the pattern over the tissue by the frame's
//! shift: in tissue coordinates every pixel's value then depends on the
//! motion, `y(u, t) ≈ B(u) · gain(u − d_t)`. That motion-locked shimmer is
//! fixed in tissue coordinates as a function of `d`, so it repeats across any
//! split of the recording; a footprint whose trace correlates with motion
//! picks up `B · ∇gain` as a high-frequency texture with no compact core. On
//! the workshop CA1 recording (D4 diagnosis, Nov 2026) the motion-response
//! images of the registered video are explained by this pattern (R² 0.55-0.65
//! of their high-passed variance) and not at all by misregistered tissue
//! (R² 0.001), and 75 % of the texture-flagged cells had traces with a
//! cross-validated motion R² above 0.2 (6 % of the others).
//!
//! # Method: self-calibration from shifted frames (Kuhn, Lin & Loranz 1991)
//!
//! The brain's own motion dithers the tissue over the sensor. Averaging the
//! raw frames by integer rigid shift `s` gives images
//! `M_s(x) = gain(x) · T(x + s)` (`T`: the time-averaged tissue light in the
//! template's coordinates; `s` is the motion record's shift rounded, so the
//! sensor pixel `x` sees tissue `x + s`). In logs, `L_s = g + t(· + s)`, and
//! alternating the two least-squares updates
//!
//! ```text
//! t(u) = Σ_s w_s (L_s(u − s) − g(u − s)) / Σ_s w_s
//! g(x) = Σ_s w_s (L_s(x) − t(x + s)) / Σ_s w_s
//! ```
//!
//! separates what stays with the sensor (`g`) from what moves with the tissue
//! (`t`). Only spatial frequencies the dither can resolve are identifiable, so
//! both logs are high-passed (normalized convolution in the FOV, σ = 8 px by
//! default): the slow gain (vignette, LED) is the glow flattener's job. The
//! gain map is `exp(g)`, clipped to a plausible range so the few pixels at the
//! FOV edge with too little dither cannot inject spikes.
//!
//! Apply it with [`super::Preprocessor::set_flat_field`]; it divides the raw
//! frame before every other stage.
//!
//! # Dark offsets
//!
//! The model above is multiplicative; the sensor also adds a fixed-pattern
//! dark offset (DSNU), part of it per column, and it drifts with
//! temperature. On the workshop recording the column profile is 12 % of the
//! high-passed log-gain variance, and the column offsets measured in the
//! unlit rows explain about a sixth of that (r .41, slope .74 where a pure
//! offset predicts 1): the column structure is part offset, part gain.
//! Offsets inside the FOV are only identifiable per column (from the unlit
//! rows of the same column); a per-pixel offset cannot be told from gain
//! without a change of illumination. With
//! [`FlatFieldConfig::offset_half_life_frames`] > 0 the estimator keeps a
//! running mean of every unlit pixel (its own, shorter half-life), takes the
//! per-column median as the column offset, subtracts it from every frame
//! before binning, and the correction becomes `(raw − offset) / gain + dark`.
//!
//! # Online (streaming) use: [`OnlineFlatField`]
//!
//! Recordings run for days, so the map is never frozen: the bin sums forget
//! exponentially (gain half-life hours, [`GAIN_HALF_LIFE_S`]; offsets
//! minutes, [`OFFSET_HALF_LIFE_S`]), and a warm-started solve runs every
//! [`REFINE_EVERY_S`]. Each push costs a pass over the frame; each solve is
//! bounded (bins × pixels × iterations) and runs off the frame path. A solve
//! needs two shift bins with fresh frames since the last one: still
//! stretches carry no information that separates gain from tissue, and the
//! map is kept as it is. A stored map of the same sensor (a seed) is applied
//! from the first frame and blended into every solve by its weight, decayed
//! with the gain half-life.
//!
//! Before the first map the data are uncorrected; the first map is a single
//! switch at a batch boundary (on the workshop recording it moves the
//! corrected mean image by 0.8 σ median per pixel), later refinements are
//! small (median 0.07 σ falling to 0.02 σ, 99th percentile below 0.35 σ;
//! [`FlatFieldUpdate`]). What the slow loop accumulated across a change:
//! the running footprint statistics are centred covariances with a
//! half-life (`stats_half_life_frames`, 6000 frames), so the static light a
//! map change moves cancels in the centring, and the motion-locked texture
//! learnt before the first map is forgotten with that half-life; the
//! ledger's running baseline and noise scale follow a step the same way.
//! Changes far below the noise (the refinements) are a slow drift to both.

use super::gaussian::RecursiveGaussian;
use super::{Dims, PreprocessError, RawPixel};

/// Distance (px) from the FOV beyond which unlit pixels give the dark level.
const DARK_MARGIN: usize = 20;

/// Parameters of [`DitherFlatField::solve`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlatFieldConfig {
    /// Largest |integer shift| per axis that is binned.
    pub radius: i32,
    /// A shift bin enters the solve with at least this many (effective) frames.
    pub min_bin_frames: u64,
    /// σ (px) of the high-pass applied to the log images and the gain.
    pub highpass_sigma: f32,
    /// Alternating least-squares iterations (from zero).
    pub iterations: usize,
    /// The gain map is clipped to `[clip_lo, clip_hi]`.
    pub clip_lo: f32,
    pub clip_hi: f32,
    /// Exponential forgetting of the shift-bin sums: half-life in frames
    /// (0: none, every frame counts the same). A frame's weight halves every
    /// `half_life_frames` frames pushed after it, so the estimate follows a
    /// slow drift of the sensor (or of the tissue under it).
    pub half_life_frames: f64,
    /// Fixed-pattern dark offset model: half-life (frames) of the running
    /// mean of the unlit pixels from which per-column offsets are taken
    /// (0: one global dark level, averaged over all frames). With it on,
    /// every frame has its column offsets subtracted before it is binned, the
    /// gain is fitted to offset-free light, and [`FlatField::offset`] holds
    /// the offsets to subtract before dividing by the gain.
    pub offset_half_life_frames: f64,
}

impl Default for FlatFieldConfig {
    fn default() -> Self {
        FlatFieldConfig {
            radius: 4,
            min_bin_frames: 100,
            highpass_sigma: 8.0,
            iterations: 30,
            clip_lo: 0.8,
            clip_hi: 1.25,
            half_life_frames: 0.0,
            offset_half_life_frames: 0.0,
        }
    }
}

/// The result of [`DitherFlatField::solve`].
#[derive(Debug, Clone)]
pub struct FlatField {
    /// Per-pixel gain (1 = nominal, 1 outside the FOV).
    pub gain: Vec<f32>,
    /// High-passed log gain before clipping (0 outside the FOV): the warm
    /// start of the next solve.
    pub log_gain: Vec<f32>,
    /// Per-pixel dark offset to subtract before dividing by the gain
    /// (column offsets, broadcast down each column), when the offset model
    /// is on ([`FlatFieldConfig::offset_half_life_frames`]).
    pub offset: Option<Vec<f32>>,
    /// Shift bins and (effective) frames that entered the solve.
    pub bins_used: usize,
    pub frames_used: u64,
    /// SD of `log gain` inside the FOV, and of the tissue part `t`.
    pub gain_sd: f64,
    pub tissue_sd: f64,
    /// Mean squared misfit of the model per pixel (log units²).
    pub residual: f64,
    /// Dark level (grey levels): subtracted before the logs, or with the
    /// offset model the median unlit level, added back after the correction.
    pub dark: f64,
}

impl FlatField {
    /// The identity map (no correction).
    pub fn identity(dims: Dims) -> FlatField {
        let n = dims.pixels();
        FlatField {
            gain: vec![1.0; n],
            log_gain: vec![0.0; n],
            offset: None,
            bins_used: 0,
            frames_used: 0,
            gain_sd: 0.0,
            tissue_sd: 0.0,
            residual: f64::NAN,
            dark: 0.0,
        }
    }

    /// Set this map on a preprocessor: `(raw − offset) / gain + dark` with
    /// the offset model, `raw / gain` without.
    pub fn apply(&self, pre: &mut super::Preprocessor) -> Result<(), PreprocessError> {
        match &self.offset {
            Some(o) => pre.set_flat_field_map(Some((&self.gain, Some(o), self.dark as f32))),
            None => pre.set_flat_field_map(Some((&self.gain, None, 0.0))),
        }
    }

    /// What the map does to a raw value `v` at pixel `p`.
    pub fn correct(&self, p: usize, v: f32) -> f32 {
        match &self.offset {
            Some(o) => (v - o[p]) / self.gain[p] + self.dark as f32,
            None => v / self.gain[p],
        }
    }
}

/// Accumulates raw frames by their integer rigid shift.
#[derive(Debug, Clone)]
pub struct DitherFlatField {
    dims: Dims,
    mask: Vec<u8>,
    /// Pixels whose mean is the dark level.
    dark_px: Vec<u32>,
    cfg: FlatFieldConfig,
    /// Per bin `(iy + R) * (2R + 1) + (ix + R)`: weighted sum of scaled raw frames.
    sums: Vec<Option<Vec<f64>>>,
    /// Per bin: weighted frame count (divide by `wscale` for effective frames).
    counts: Vec<f64>,
    /// Per bin: frames binned since [`Self::take_recent`].
    recent: Vec<u64>,
    /// Mean of the outside-FOV pixels (dark level), weighted sum over frames.
    dark_sum: f64,
    dark_w: f64,
    ref_mean: Option<f64>,
    frames: u64,
    /// Weight of the newest frame (grows by the inverse forgetting factor
    /// per frame; everything is rescaled when it gets large).
    wscale: f64,
    grow: f64,
    /// Offset model: running mean of each unlit pixel (weighted sums) and
    /// its weight, the per-frame decay, and the column offsets subtracted now.
    dark_px_sum: Vec<f64>,
    dark_px_w: f64,
    dark_decay: f64,
    col_offset: Vec<f32>,
    dark_level: f32,
}

/// Frames between refreshes of the column offsets (offset model).
const OFFSET_REFRESH_FRAMES: u64 = 50;
/// A column needs this many unlit pixels for its own offset (else the global level).
const MIN_DARK_PER_COLUMN: usize = 8;

impl DitherFlatField {
    pub fn new(
        dims: Dims,
        fov_mask: &[u8],
        cfg: FlatFieldConfig,
    ) -> Result<DitherFlatField, PreprocessError> {
        dims.check("FOV mask", fov_mask.len())?;
        if cfg.radius < 1
            || cfg.iterations == 0
            || !(cfg.clip_lo > 0.0 && cfg.clip_lo < 1.0 && cfg.clip_hi > 1.0)
            || !(cfg.half_life_frames >= 0.0 && cfg.half_life_frames.is_finite())
            || !(cfg.offset_half_life_frames >= 0.0 && cfg.offset_half_life_frames.is_finite())
        {
            return Err(PreprocessError::InvalidConfig(format!(
                "flat field config {cfg:?}"
            )));
        }
        let nb = (2 * cfg.radius + 1) as usize;
        // Dark-level pixels: outside the FOV and at least DARK_MARGIN px from
        // it (the lens edge's vignetted ring is not dark); all outside pixels
        // when there are none that far.
        let mut near: Vec<bool> = fov_mask.iter().map(|&m| m != 0).collect();
        let (w, h) = (dims.width, dims.height);
        for _ in 0..DARK_MARGIN {
            let prev = near.clone();
            for y in 0..h {
                for x in 0..w {
                    if prev[y * w + x] {
                        continue;
                    }
                    let hit = (y > 0 && prev[(y - 1) * w + x])
                        || (y + 1 < h && prev[(y + 1) * w + x])
                        || (x > 0 && prev[y * w + x - 1])
                        || (x + 1 < w && prev[y * w + x + 1]);
                    near[y * w + x] = hit;
                }
            }
        }
        let mut dark_px: Vec<u32> = (0..dims.pixels())
            .filter(|&p| !near[p])
            .map(|p| p as u32)
            .collect();
        if dark_px.is_empty() {
            dark_px = (0..dims.pixels())
                .filter(|&p| fov_mask[p] == 0)
                .map(|p| p as u32)
                .collect();
        }
        let nd = dark_px.len();
        let offsets = cfg.offset_half_life_frames > 0.0 && nd > 0;
        Ok(DitherFlatField {
            dims,
            dark_px,
            mask: fov_mask.to_vec(),
            cfg,
            sums: vec![None; nb * nb],
            counts: vec![0.0; nb * nb],
            recent: vec![0; nb * nb],
            dark_sum: 0.0,
            dark_w: 0.0,
            ref_mean: None,
            frames: 0,
            wscale: 1.0,
            grow: if cfg.half_life_frames > 0.0 {
                2f64.powf(1.0 / cfg.half_life_frames)
            } else {
                1.0
            },
            dark_px_sum: if offsets { vec![0.0; nd] } else { Vec::new() },
            dark_px_w: 0.0,
            dark_decay: if offsets {
                0.5f64.powf(1.0 / cfg.offset_half_life_frames)
            } else {
                1.0
            },
            col_offset: vec![0.0; w],
            dark_level: 0.0,
        })
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    pub fn fov_mask(&self) -> &[u8] {
        &self.mask
    }

    pub fn config(&self) -> &FlatFieldConfig {
        &self.cfg
    }

    /// Frames pushed (whether or not their shift fell in a bin).
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Frames binned per shift bin since the last call; resets the counts.
    pub fn take_recent(&mut self) -> Vec<u64> {
        std::mem::replace(&mut self.recent, vec![0; self.counts.len()])
    }

    /// Frames binned per shift bin since the last [`Self::take_recent`].
    pub fn recent(&self) -> &[u64] {
        &self.recent
    }

    /// The per-pixel offsets the offset model subtracts now (`None` without it).
    pub fn offset_map(&self) -> Option<Vec<f32>> {
        if self.dark_px_sum.is_empty() {
            return None;
        }
        let w = self.dims.width;
        Some(
            (0..self.dims.pixels())
                .map(|p| self.col_offset[p % w])
                .collect(),
        )
    }

    /// The median unlit level (offset model; 0 without it).
    pub fn dark_level(&self) -> f32 {
        self.dark_level
    }

    /// The forgetting-weighted mean of the binned frames (offset-free with
    /// the offset model, flicker-scaled): the brightness the gain multiplies.
    pub fn mean_image(&self) -> Vec<f32> {
        let n = self.dims.pixels();
        let mut acc = vec![0.0f64; n];
        let mut c = 0.0;
        for (s, &k) in self.sums.iter().zip(&self.counts) {
            if let Some(s) = s {
                for (a, &v) in acc.iter_mut().zip(s) {
                    *a += v;
                }
                c += k;
            }
        }
        acc.iter()
            .map(|&a| if c > 0.0 { (a / c) as f32 } else { 0.0 })
            .collect()
    }

    /// Recompute the column offsets from the running means of the unlit
    /// pixels (median per column: robust to hot pixels).
    fn refresh_offsets(&mut self) {
        if self.dark_px_sum.is_empty() || self.dark_px_w <= 0.0 {
            return;
        }
        let w = self.dims.width;
        let mut cols: Vec<Vec<f32>> = vec![Vec::new(); w];
        let mut all: Vec<f32> = Vec::with_capacity(self.dark_px.len());
        for (&p, &s) in self.dark_px.iter().zip(&self.dark_px_sum) {
            let v = (s / self.dark_px_w) as f32;
            cols[p as usize % w].push(v);
            all.push(v);
        }
        let median = |v: &mut Vec<f32>| {
            let k = v.len() / 2;
            *v.select_nth_unstable_by(k, f32::total_cmp).1
        };
        let level = median(&mut all);
        self.dark_level = level;
        for (o, c) in self.col_offset.iter_mut().zip(cols.iter_mut()) {
            *o = if c.len() >= MIN_DARK_PER_COLUMN {
                median(c)
            } else {
                level
            };
        }
    }

    /// Add a raw (sensor-coordinate) frame registered by the rigid shift
    /// `(dy, dx)` (a `MotionRecord`'s `dy`, `dx`). Returns whether it was
    /// binned (|round(shift)| ≤ radius on both axes). The frame is scaled to
    /// the first frame's FOV mean, which takes out the global LED flicker.
    /// Cost: two passes over the frame, plus (offset model) one over the
    /// unlit pixels and every 50 frames a median per column of them.
    pub fn push<T: RawPixel>(
        &mut self,
        raw: &[T],
        (dy, dx): (f32, f32),
    ) -> Result<bool, PreprocessError> {
        self.dims.check("raw frame", raw.len())?;
        self.frames += 1;
        if self.grow != 1.0 {
            self.wscale *= self.grow;
            if self.wscale > 1e100 {
                let k = 1.0 / self.wscale;
                for s in self.sums.iter_mut().flatten() {
                    s.iter_mut().for_each(|v| *v *= k);
                }
                self.counts.iter_mut().for_each(|c| *c *= k);
                self.dark_sum *= k;
                self.dark_w *= k;
                self.wscale = 1.0;
            }
        }
        let wt = self.wscale;
        let offsets = !self.dark_px_sum.is_empty();
        if offsets {
            // Running mean of every unlit pixel (its own, faster forgetting).
            let k = self.dark_decay;
            for (s, &p) in self.dark_px_sum.iter_mut().zip(&self.dark_px) {
                let v = f64::from(raw[p as usize].to_f32());
                *s = *s * k + if v.is_finite() { v } else { 0.0 };
            }
            self.dark_px_w = self.dark_px_w * k + 1.0;
            if self.frames == 1 || self.frames.is_multiple_of(OFFSET_REFRESH_FRAMES) {
                self.refresh_offsets();
            }
        }
        let w = self.dims.width;
        let col = &self.col_offset;
        let off = |p: usize| if offsets { col[p % w] } else { 0.0 };
        let (mut s_in, mut n_in, mut s_out, mut n_out) = (0.0f64, 0u64, 0.0f64, 0u64);
        for (p, (&r, &m)) in raw.iter().zip(&self.mask).enumerate() {
            let v = f64::from(r.to_f32() - off(p));
            if v.is_finite() && m != 0 {
                s_in += v;
                n_in += 1;
            }
        }
        if !offsets {
            for &p in &self.dark_px {
                let v = f64::from(raw[p as usize].to_f32());
                if v.is_finite() {
                    s_out += v;
                    n_out += 1;
                }
            }
        }
        if n_in == 0 {
            return Ok(false);
        }
        let mean = s_in / n_in as f64;
        if n_out > 0 {
            self.dark_sum += wt * s_out / n_out as f64;
            self.dark_w += wt;
        }
        let r = self.cfg.radius;
        let (iy, ix) = (dy.round() as i32, dx.round() as i32);
        if !dy.is_finite() || !dx.is_finite() || iy.abs() > r || ix.abs() > r || mean <= 0.0 {
            return Ok(false);
        }
        let reference = *self.ref_mean.get_or_insert(mean);
        let scale = wt * reference / mean;
        let nb = (2 * r + 1) as usize;
        let b = (iy + r) as usize * nb + (ix + r) as usize;
        let n = self.dims.pixels();
        let acc = self.sums[b].get_or_insert_with(|| vec![0.0; n]);
        for (p, (a, &v)) in acc.iter_mut().zip(raw).enumerate() {
            let v = f64::from(v.to_f32() - off(p));
            if v.is_finite() {
                *a += v * scale;
            }
        }
        self.counts[b] += wt;
        self.recent[b] += 1;
        Ok(true)
    }

    /// Solve for the gain map from zero (see the module docs).
    pub fn solve(&self) -> Result<FlatField, PreprocessError> {
        self.solve_from(None, self.cfg.iterations)
    }

    /// Solve for the gain map with `iterations` alternating updates,
    /// starting from the high-passed log gain `warm` (a previous
    /// [`FlatField::log_gain`]) or from zero.
    pub fn solve_from(
        &self,
        warm: Option<&[f32]>,
        iterations: usize,
    ) -> Result<FlatField, PreprocessError> {
        let Dims {
            width: w,
            height: h,
        } = self.dims;
        let n = self.dims.pixels();
        let r = self.cfg.radius;
        let nb = (2 * r + 1) as usize;
        let offsets = !self.dark_px_sum.is_empty();
        // Without the offset model the dark level is subtracted here; with
        // it the frames were binned offset-free already.
        let dark = if offsets {
            0.0
        } else if self.dark_w > 0.0 {
            (self.dark_sum / self.dark_w).max(0.0)
        } else {
            0.0
        };
        let mut used: Vec<((i32, i32), f64, Vec<f32>)> = Vec::new();
        let mut hp = HighPass::new(self.dims, &self.mask, self.cfg.highpass_sigma)?;
        for (b, s) in self.sums.iter().enumerate() {
            let c = self.counts[b];
            let Some(s) = s else { continue };
            if c / self.wscale < self.cfg.min_bin_frames as f64 {
                continue;
            }
            let mut l: Vec<f32> = s
                .iter()
                .zip(&self.mask)
                .map(|(&v, &m)| {
                    if m != 0 {
                        ((v / c - dark).max(1.0)).ln() as f32
                    } else {
                        0.0
                    }
                })
                .collect();
            hp.apply(&mut l)?;
            let shift = ((b / nb) as i32 - r, (b % nb) as i32 - r);
            used.push((shift, c / self.wscale, l));
        }
        if used.len() < 2 {
            return Err(PreprocessError::InvalidConfig(format!(
                "flat field: {} shift bins with >= {} frames, need 2 or more (too little motion)",
                used.len(),
                self.cfg.min_bin_frames
            )));
        }
        let inside = |y: isize, x: isize| -> Option<usize> {
            (y >= 0 && x >= 0 && (y as usize) < h && (x as usize) < w)
                .then(|| y as usize * w + x as usize)
        };
        let mut g = match warm {
            Some(w0) => {
                self.dims.check("warm-start gain", w0.len())?;
                w0.to_vec()
            }
            None => vec![0.0f32; n],
        };
        let mut t = vec![0.0f32; n];
        let mut tw = vec![0.0f64; n];
        let mut acc = vec![0.0f64; n];
        for _ in 0..iterations.max(1) {
            // t(u) = mean over bins of (L_s - g)(u - s), sensor pixel u - s in the FOV.
            acc.fill(0.0);
            tw.fill(0.0);
            for &((sy, sx), wgt, ref l) in &used {
                for y in 0..h {
                    for x in 0..w {
                        let Some(p) = inside(y as isize - sy as isize, x as isize - sx as isize)
                        else {
                            continue;
                        };
                        if self.mask[p] == 0 {
                            continue;
                        }
                        let u = y * w + x;
                        acc[u] += wgt * f64::from(l[p] - g[p]);
                        tw[u] += wgt;
                    }
                }
            }
            for u in 0..n {
                t[u] = if tw[u] > 0.0 {
                    (acc[u] / tw[u]) as f32
                } else {
                    0.0
                };
            }
            // g(x) = mean over bins of L_s(x) - t(x + s), tissue x + s seen.
            acc.fill(0.0);
            let mut gw = vec![0.0f64; n];
            for &((sy, sx), wgt, ref l) in &used {
                for y in 0..h {
                    for x in 0..w {
                        let p = y * w + x;
                        if self.mask[p] == 0 {
                            continue;
                        }
                        let Some(u) = inside(y as isize + sy as isize, x as isize + sx as isize)
                        else {
                            continue;
                        };
                        if tw[u] <= 0.0 {
                            continue;
                        }
                        acc[p] += wgt * f64::from(l[p] - t[u]);
                        gw[p] += wgt;
                    }
                }
            }
            for p in 0..n {
                g[p] = if gw[p] > 0.0 {
                    (acc[p] / gw[p]) as f32
                } else {
                    0.0
                };
            }
            hp.apply(&mut g)?;
        }
        // Misfit and spreads.
        let (mut res, mut rn) = (0.0f64, 0.0f64);
        for &((sy, sx), wgt, ref l) in &used {
            for y in 0..h {
                for x in 0..w {
                    let p = y * w + x;
                    if self.mask[p] == 0 {
                        continue;
                    }
                    let Some(u) = inside(y as isize + sy as isize, x as isize + sx as isize) else {
                        continue;
                    };
                    if tw[u] <= 0.0 {
                        continue;
                    }
                    let e = f64::from(l[p] - g[p] - t[u]);
                    res += wgt * e * e;
                    rn += wgt;
                }
            }
        }
        let sd = |v: &[f32]| {
            let xs: Vec<f64> = v
                .iter()
                .zip(&self.mask)
                .filter(|(_, &m)| m != 0)
                .map(|(&a, _)| f64::from(a))
                .collect();
            let m = xs.iter().sum::<f64>() / xs.len().max(1) as f64;
            (xs.iter().map(|a| (a - m) * (a - m)).sum::<f64>() / xs.len().max(1) as f64).sqrt()
        };
        let gain = g
            .iter()
            .zip(&self.mask)
            .map(|(&v, &m)| {
                if m != 0 {
                    v.exp().clamp(self.cfg.clip_lo, self.cfg.clip_hi)
                } else {
                    1.0
                }
            })
            .collect();
        Ok(FlatField {
            gain,
            gain_sd: sd(&g),
            log_gain: g,
            offset: self.offset_map(),
            bins_used: used.len(),
            frames_used: used.iter().map(|u| u.1.round() as u64).sum(),
            tissue_sd: sd(&t),
            residual: if rn > 0.0 { res / rn } else { f64::NAN },
            dark: if offsets {
                f64::from(self.dark_level)
            } else {
                dark
            },
        })
    }
}

/// Default half-life of the gain estimate's forgetting, seconds (2 h). The
/// pixel gain (PRNU) is a property of the sensor and barely changes; the
/// forgetting is there so a slow drift (temperature, the tissue under the
/// lens changing over a multi-day recording) is followed within hours.
pub const GAIN_HALF_LIFE_S: f32 = 7200.0;
/// Default half-life of the dark-offset tracker, seconds (dark current and
/// column offsets drift with temperature on a scale of minutes).
pub const OFFSET_HALF_LIFE_S: f32 = 120.0;
/// Default frames before the first map, seconds (3000 frames at 20 fps:
/// the D4 measurement, 7 shift bins with a dither of ~1 px).
pub const FIRST_MAP_S: f32 = 150.0;
/// Default time between refinements, seconds.
pub const REFINE_EVERY_S: f32 = 60.0;

/// Settings of [`OnlineFlatField`]: the flat field as a streaming pipeline
/// runs it (on by default).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OnlineFlatFieldConfig {
    /// The estimator (half-lives in frames).
    pub estimator: FlatFieldConfig,
    /// Frames before the first solve.
    pub first_frames: u64,
    /// Frames between later solves.
    pub refine_every_frames: u64,
    /// A solve needs at least two shift bins that each received this many
    /// frames since the last one: frames without motion carry no
    /// information that separates gain from tissue, so a still stretch
    /// keeps the map as it is instead of re-fitting it to one bin.
    pub min_new_bin_frames: u64,
    /// Iterations of a warm-started solve (the first one runs
    /// `estimator.iterations` from zero).
    pub warm_iterations: usize,
}

impl OnlineFlatFieldConfig {
    /// Defaults with the time-based settings converted at `fps` (20 when
    /// unknown or not positive).
    pub fn for_fps(fps: f32) -> OnlineFlatFieldConfig {
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            20.0
        };
        let frames = |s: f32| (s * fps).round().max(1.0);
        OnlineFlatFieldConfig {
            estimator: FlatFieldConfig {
                half_life_frames: f64::from(frames(GAIN_HALF_LIFE_S)),
                offset_half_life_frames: f64::from(frames(OFFSET_HALF_LIFE_S)),
                ..FlatFieldConfig::default()
            },
            first_frames: frames(FIRST_MAP_S) as u64,
            refine_every_frames: frames(REFINE_EVERY_S) as u64,
            min_new_bin_frames: 25,
            warm_iterations: 10,
        }
    }
}

impl Default for OnlineFlatFieldConfig {
    fn default() -> Self {
        OnlineFlatFieldConfig::for_fps(20.0)
    }
}

/// A stored map that starts a session (the per-device cache).
#[derive(Debug, Clone)]
pub struct FlatFieldSeed {
    pub gain: Vec<f32>,
    pub offset: Option<Vec<f32>>,
    pub dark: f32,
    /// Effective frames behind the map: its weight against new data.
    pub frames: f64,
}

/// What one refinement did.
#[derive(Debug, Clone, PartialEq)]
pub struct FlatFieldUpdate {
    /// Frames pushed when it was made.
    pub frame: u64,
    /// The first map of the session (before it the data were uncorrected,
    /// or corrected by the seed).
    pub first: bool,
    /// How much the corrected mean image moved, per FOV pixel, in units of
    /// the pixel's frame-to-frame noise σ (`sqrt(mean (x_t − x_{t−1})² / 2)`):
    /// median, 99th percentile and maximum.
    pub change_median: f64,
    pub change_p99: f64,
    pub change_max: f64,
}

/// The outcome of [`OnlineFlatField::refine`].
#[derive(Debug, Clone, PartialEq)]
pub enum RefineOutcome {
    /// A new map is current.
    Updated(FlatFieldUpdate),
    /// No new map (the reason); the current one (if any) stays.
    Skipped(String),
}

/// The flat field of a streaming run: continuous estimation with
/// forgetting, a solve every `refine_every_frames` (warm-started, bounded
/// cost), an optional seed (a stored map of the same sensor) that is
/// applied from the first frame and blended with the new estimate by its
/// weight, decayed with the gain half-life.
///
/// [`Self::push`] is cheap (a few passes over the frame); [`Self::refine`]
/// is the expensive part (a solve over every shift bin) and is meant to run
/// off the frame path (a worker), its result applied at a batch boundary.
#[derive(Debug, Clone)]
pub struct OnlineFlatField {
    est: DitherFlatField,
    cfg: OnlineFlatFieldConfig,
    current: Option<FlatField>,
    /// Seed log gain and its weight (effective frames when seeded).
    prior: Option<(Vec<f32>, f64)>,
    /// Frames pushed when the next solve is due.
    next_at: u64,
    /// Frame-to-frame noise: previous frame and summed squared differences.
    prev: Vec<f32>,
    diff_sq: Vec<f64>,
    diff_n: u64,
    updates: u32,
}

impl OnlineFlatField {
    pub fn new(
        dims: Dims,
        fov_mask: &[u8],
        cfg: OnlineFlatFieldConfig,
        seed: Option<FlatFieldSeed>,
    ) -> Result<OnlineFlatField, PreprocessError> {
        if cfg.first_frames == 0 || cfg.refine_every_frames == 0 || cfg.warm_iterations == 0 {
            return Err(PreprocessError::InvalidConfig(format!(
                "online flat field config {cfg:?}"
            )));
        }
        let est = DitherFlatField::new(dims, fov_mask, cfg.estimator)?;
        let n = dims.pixels();
        let (current, prior) = match seed {
            None => (None, None),
            Some(s) => {
                dims.check("seed gain", s.gain.len())?;
                if let Some(o) = &s.offset {
                    dims.check("seed offset", o.len())?;
                }
                let log_gain: Vec<f32> = s
                    .gain
                    .iter()
                    .zip(fov_mask)
                    .map(|(&g, &m)| {
                        if m != 0 && g.is_finite() && g > 0.0 {
                            g.ln()
                        } else {
                            0.0
                        }
                    })
                    .collect();
                let gain = log_gain
                    .iter()
                    .map(|&l| l.exp().clamp(cfg.estimator.clip_lo, cfg.estimator.clip_hi))
                    .collect();
                let ff = FlatField {
                    gain,
                    log_gain: log_gain.clone(),
                    offset: s.offset,
                    dark: f64::from(s.dark),
                    frames_used: s.frames.max(0.0).round() as u64,
                    ..FlatField::identity(dims)
                };
                (Some(ff), Some((log_gain, s.frames.max(0.0))))
            }
        };
        Ok(OnlineFlatField {
            est,
            cfg,
            current,
            prior,
            next_at: cfg.first_frames,
            prev: Vec::new(),
            diff_sq: vec![0.0; n],
            diff_n: 0,
            updates: 0,
        })
    }

    pub fn config(&self) -> &OnlineFlatFieldConfig {
        &self.cfg
    }

    pub fn estimator(&self) -> &DitherFlatField {
        &self.est
    }

    /// The map in force (the seed until the first solve), if any.
    pub fn current(&self) -> Option<&FlatField> {
        self.current.as_ref()
    }

    /// Solves that produced a map.
    pub fn updates(&self) -> u32 {
        self.updates
    }

    /// Frames pushed.
    pub fn frames(&self) -> u64 {
        self.est.frames()
    }

    /// Add a raw frame and its rigid shift; see [`DitherFlatField::push`].
    pub fn push<T: RawPixel>(
        &mut self,
        raw: &[T],
        shift: (f32, f32),
    ) -> Result<bool, PreprocessError> {
        let binned = self.est.push(raw, shift)?;
        if self.prev.len() == raw.len() {
            for ((d, p), &r) in self.diff_sq.iter_mut().zip(&mut self.prev).zip(raw) {
                let v = r.to_f32();
                if v.is_finite() {
                    let e = f64::from(v - *p);
                    *d += e * e;
                    *p = v;
                }
            }
            self.diff_n += 1;
        } else {
            self.prev = raw.iter().map(|r| r.to_f32()).collect();
        }
        Ok(binned)
    }

    /// Whether [`Self::refine`] should run now.
    pub fn due(&self) -> bool {
        self.est.frames() >= self.next_at
    }

    /// Solve for a new map (the expensive step). On success the new map is
    /// [`Self::current`]; the update reports how much it moves the data.
    pub fn refine(&mut self) -> RefineOutcome {
        self.next_at = self.est.frames() + self.cfg.refine_every_frames;
        let moving = self
            .est
            .recent()
            .iter()
            .filter(|&&c| c >= self.cfg.min_new_bin_frames)
            .count();
        if moving < 2 {
            return RefineOutcome::Skipped(format!(
                "too little motion: {moving} shift bins with >= {} new frames, need 2",
                self.cfg.min_new_bin_frames
            ));
        }
        let first = self.updates == 0;
        // Warm start from the last solve (or the seed); cold the first time
        // without a seed.
        let warm = self.current.as_ref().map(|c| c.log_gain.as_slice());
        let iters = if warm.is_some() {
            self.cfg.warm_iterations
        } else {
            self.cfg.estimator.iterations
        };
        let mut ff = match self.est.solve_from(warm, iters) {
            Ok(ff) => ff,
            Err(e) => return RefineOutcome::Skipped(e.to_string()),
        };
        if let Some((lp, w0)) = &self.prior {
            let hl = self.cfg.estimator.half_life_frames;
            let wp = if hl > 0.0 {
                w0 * 0.5f64.powf(self.est.frames() as f64 / hl)
            } else {
                *w0
            };
            let wn = ff.frames_used as f64;
            if wp > 0.0 && wp + wn > 0.0 {
                let (a, b) = ((wp / (wp + wn)) as f32, (wn / (wp + wn)) as f32);
                let mask = self.est.fov_mask();
                for ((l, &p), &m) in ff.log_gain.iter_mut().zip(lp).zip(mask) {
                    if m != 0 {
                        *l = a * p + b * *l;
                    }
                }
                let (lo, hi) = (self.cfg.estimator.clip_lo, self.cfg.estimator.clip_hi);
                for ((g, &l), &m) in ff.gain.iter_mut().zip(&ff.log_gain).zip(mask) {
                    *g = if m != 0 { l.exp().clamp(lo, hi) } else { 1.0 };
                }
            }
        }
        let (change_median, change_p99, change_max) = self.change(&ff);
        self.est.take_recent();
        self.current = Some(ff);
        self.updates += 1;
        RefineOutcome::Updated(FlatFieldUpdate {
            frame: self.est.frames(),
            first,
            change_median,
            change_p99,
            change_max,
        })
    }

    /// How far `new` moves the corrected mean image from the current map
    /// (or from no correction), per FOV pixel in noise units.
    fn change(&self, new: &FlatField) -> (f64, f64, f64) {
        if self.diff_n == 0 {
            return (f64::NAN, f64::NAN, f64::NAN);
        }
        let b = self.est.mean_image();
        let off = self.est.offset_map();
        let mask = self.est.fov_mask();
        let mut d: Vec<f64> = Vec::new();
        for p in 0..b.len() {
            if mask[p] == 0 {
                continue;
            }
            let sigma = (self.diff_sq[p] / self.diff_n as f64 / 2.0).sqrt();
            if sigma.is_nan() || sigma <= 0.0 {
                continue;
            }
            let raw = b[p] + off.as_ref().map_or(0.0, |o| o[p]);
            let old = self.current.as_ref().map_or(raw, |c| c.correct(p, raw));
            let now = new.correct(p, raw);
            d.push(f64::from((now - old).abs() * new.gain[p]) / sigma);
        }
        if d.is_empty() {
            return (f64::NAN, f64::NAN, f64::NAN);
        }
        d.sort_by(f64::total_cmp);
        let q = |f: f64| d[((d.len() - 1) as f64 * f).round() as usize];
        (q(0.5), q(0.99), d[d.len() - 1])
    }
}

/// `img − G_σ*(img·M)/G_σ*M` inside the mask `M`, 0 outside.
struct HighPass {
    blur: RecursiveGaussian,
    weight: Vec<f32>,
    norm: Vec<f32>,
    tmp: Vec<f32>,
}

impl HighPass {
    fn new(dims: Dims, mask: &[u8], sigma: f32) -> Result<HighPass, PreprocessError> {
        let mut blur = RecursiveGaussian::new(dims, sigma)?;
        let weight: Vec<f32> = mask.iter().map(|&m| f32::from(u8::from(m != 0))).collect();
        let mut norm = vec![0.0; dims.pixels()];
        blur.blur(&weight, &mut norm)?;
        Ok(HighPass {
            blur,
            weight,
            norm,
            tmp: vec![0.0; dims.pixels()],
        })
    }

    fn apply(&mut self, img: &mut [f32]) -> Result<(), PreprocessError> {
        self.blur.blur_weighted(img, &self.weight, &mut self.tmp)?;
        for ((v, &lo), (&nm, &m)) in img
            .iter_mut()
            .zip(&self.tmp)
            .zip(self.norm.iter().zip(&self.weight))
        {
            *v = if m > 0.0 && nm > 1e-6 {
                *v - lo / nm
            } else {
                0.0
            };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random field in [-1, 1].
    fn noise(n: usize, seed: u64) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((s >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
            })
            .collect()
    }

    /// Frames `gain(x) · T(x + s)` for a set of integer shifts: the solve
    /// recovers the gain pattern and not the tissue texture.
    #[test]
    fn recovers_sensor_gain_from_dithered_frames() {
        let (h, w) = (96usize, 96usize);
        let dims = Dims::new(w, h).unwrap();
        let n = h * w;
        let mask = vec![1u8; n];
        let gn = noise(n, 1);
        let gain: Vec<f32> = gn.iter().map(|v| 1.0 + 0.04 * v).collect();
        // Tissue: smooth-ish blobs plus fine texture, in a larger canvas.
        let (th, tw) = (h + 12, w + 12);
        let tn = noise(th * tw, 2);
        let tissue: Vec<f32> = (0..th * tw)
            .map(|i| {
                let (y, x) = ((i / tw) as f32, (i % tw) as f32);
                60.0 + 20.0 * ((y * 0.3).sin() * (x * 0.25).cos()) + 5.0 * tn[i]
            })
            .collect();
        let mut ff = DitherFlatField::new(
            dims,
            &mask,
            FlatFieldConfig {
                min_bin_frames: 1,
                ..FlatFieldConfig::default()
            },
        )
        .unwrap();
        for (sy, sx) in [
            (0, 0),
            (1, 0),
            (0, 1),
            (-1, 0),
            (0, -1),
            (1, 1),
            (-2, 1),
            (2, -1),
            (-1, -2),
        ] {
            let frame: Vec<f32> = (0..n)
                .map(|p| {
                    let (y, x) = ((p / w) as i32 + sy + 6, (p % w) as i32 + sx + 6);
                    gain[p] * tissue[y as usize * tw + x as usize]
                })
                .collect();
            assert!(ff.push(&frame, (sy as f32, sx as f32)).unwrap());
        }
        let out = ff.solve().unwrap();
        assert_eq!(out.bins_used, 9);
        // Compare in the interior (high-pass edge effects aside).
        let (mut a, mut b, mut c) = (Vec::new(), Vec::new(), Vec::new());
        for y in 12..h - 12 {
            for x in 12..w - 12 {
                let p = y * w + x;
                a.push(f64::from(out.gain[p].ln()));
                b.push(f64::from(gain[p].ln()));
                c.push(f64::from(tissue[(y + 6) * tw + x + 6]));
            }
        }
        let corr = |u: &[f64], v: &[f64]| {
            let (mu, mv) = (
                u.iter().sum::<f64>() / u.len() as f64,
                v.iter().sum::<f64>() / v.len() as f64,
            );
            let cov: f64 = u.iter().zip(v).map(|(p, q)| (p - mu) * (q - mv)).sum();
            let su: f64 = u.iter().map(|p| (p - mu).powi(2)).sum::<f64>().sqrt();
            let sv: f64 = v.iter().map(|q| (q - mv).powi(2)).sum::<f64>().sqrt();
            cov / (su * sv)
        };
        let r_gain = corr(&a, &b);
        let r_tissue = corr(&a, &c);
        assert!(r_gain > 0.9, "gain r {r_gain}");
        assert!(
            r_tissue.abs() < 0.2,
            "tissue leaks into the gain: r {r_tissue}"
        );
    }

    #[test]
    fn needs_motion() {
        let dims = Dims::new(16, 16).unwrap();
        let mut ff = DitherFlatField::new(
            dims,
            &[1u8; 256],
            FlatFieldConfig {
                min_bin_frames: 1,
                ..FlatFieldConfig::default()
            },
        )
        .unwrap();
        ff.push(&[10.0f32; 256], (0.2, -0.1)).unwrap();
        assert!(ff.solve().is_err());
    }

    const SHIFTS: [(i32, i32); 9] = [
        (0, 0),
        (1, 0),
        (0, 1),
        (-1, 0),
        (0, -1),
        (1, 1),
        (-2, 1),
        (2, -1),
        (-1, -2),
    ];

    /// A 64 x 96 sensor whose FOV is a 56 x 20 band (rows 22..42; the unlit
    /// rows above and below give the column offsets), viewing tissue
    /// shifted by `s`: `gain · T(x + s) + col_offset`.
    struct Scene {
        w: usize,
        h: usize,
        mask: Vec<u8>,
        tissue: Vec<f32>,
        tw: usize,
    }

    impl Scene {
        fn new() -> Scene {
            let (w, h) = (64usize, 96usize);
            let mask = (0..w * h)
                .map(|p| {
                    let (y, x) = (p / w, p % w);
                    u8::from((22..42).contains(&y) && (4..60).contains(&x))
                })
                .collect();
            let (th, tw) = (h + 12, w + 12);
            let tn = noise(th * tw, 2);
            let tissue = (0..th * tw)
                .map(|i| {
                    let (y, x) = ((i / tw) as f32, (i % tw) as f32);
                    60.0 + 20.0 * ((y * 0.3).sin() * (x * 0.25).cos()) + 5.0 * tn[i]
                })
                .collect();
            Scene {
                w,
                h,
                mask,
                tissue,
                tw,
            }
        }

        fn frame(&self, gain: &[f32], col: &[f32], (sy, sx): (i32, i32)) -> Vec<f32> {
            (0..self.w * self.h)
                .map(|p| {
                    let (y, x) = ((p / self.w) as i32 + sy + 6, (p % self.w) as i32 + sx + 6);
                    let light = if self.mask[p] != 0 {
                        self.tissue[y as usize * self.tw + x as usize]
                    } else {
                        0.0
                    };
                    gain[p] * light + col[p % self.w]
                })
                .collect()
        }

        /// Correlation of two log-gain maps in the FOV interior.
        fn corr(&self, a: &[f32], b: &[f32]) -> f64 {
            let (mut u, mut v) = (Vec::new(), Vec::new());
            for p in 0..self.w * self.h {
                let (y, x) = (p / self.w, p % self.w);
                if (25..39).contains(&y) && (8..56).contains(&x) {
                    u.push(f64::from(a[p]));
                    v.push(f64::from(b[p]));
                }
            }
            let (mu, mv) = (
                u.iter().sum::<f64>() / u.len() as f64,
                v.iter().sum::<f64>() / v.len() as f64,
            );
            let cov: f64 = u.iter().zip(&v).map(|(p, q)| (p - mu) * (q - mv)).sum();
            let su: f64 = u.iter().map(|p| (p - mu).powi(2)).sum::<f64>().sqrt();
            let sv: f64 = v.iter().map(|q| (q - mv).powi(2)).sum::<f64>().sqrt();
            cov / (su * sv)
        }
    }

    fn online_cfg(half_life: f64, offsets: f64) -> OnlineFlatFieldConfig {
        OnlineFlatFieldConfig {
            estimator: FlatFieldConfig {
                min_bin_frames: 2,
                half_life_frames: half_life,
                offset_half_life_frames: offsets,
                ..FlatFieldConfig::default()
            },
            first_frames: 36,
            refine_every_frames: 36,
            min_new_bin_frames: 2,
            warm_iterations: 10,
        }
    }

    /// The online estimate follows a change of the sensor gain with its
    /// half-life, and updates once converged move the data by little.
    #[test]
    fn online_map_tracks_a_gain_change() {
        let sc = Scene::new();
        let dims = Dims::new(sc.w, sc.h).unwrap();
        let n = sc.w * sc.h;
        let g1: Vec<f32> = noise(n, 1).iter().map(|v| 1.0 + 0.04 * v).collect();
        let g2: Vec<f32> = noise(n, 7).iter().map(|v| 1.0 + 0.04 * v).collect();
        let col = vec![0.0f32; sc.w];
        let mut on = OnlineFlatField::new(dims, &sc.mask, online_cfg(40.0, 0.0), None).unwrap();
        let mut updates = Vec::new();
        for k in 0..720 {
            let g = if k < 360 { &g1 } else { &g2 };
            let s = SHIFTS[k % SHIFTS.len()];
            let f = sc.frame(g, &col, s);
            on.push(&f, (s.0 as f32, s.1 as f32)).unwrap();
            if on.due() {
                match on.refine() {
                    RefineOutcome::Updated(u) => updates.push((k, u)),
                    RefineOutcome::Skipped(m) => panic!("skipped: {m}"),
                }
            }
            if k == 359 {
                let lg = &on.current().unwrap().log_gain;
                let l1: Vec<f32> = g1.iter().map(|v| v.ln()).collect();
                assert!(
                    sc.corr(lg, &l1) > 0.9,
                    "before the change: r {}",
                    sc.corr(lg, &l1)
                );
            }
        }
        let lg = &on.current().unwrap().log_gain;
        let l1: Vec<f32> = g1.iter().map(|v| v.ln()).collect();
        let l2: Vec<f32> = g2.iter().map(|v| v.ln()).collect();
        // 360 frames after the change is 9 half-lives: the new gain dominates.
        assert!(sc.corr(lg, &l2) > 0.9, "after: r {}", sc.corr(lg, &l2));
        assert!(
            sc.corr(lg, &l1).abs() < 0.3,
            "old gain lingers: r {}",
            sc.corr(lg, &l1)
        );
        assert!(updates[0].1.first && !updates[1].1.first);
        // No noise in this scene: the change is measured against the
        // frame-to-frame differences of the dither, so only its ordering
        // matters here: a converged update moves less than the first map.
        let steady = &updates[8].1;
        assert!(steady.change_p99 < updates[0].1.change_p99);
    }

    /// Column offsets of the unlit rows are taken out before the gain fit:
    /// the gain is not biased by them, and `apply` removes them.
    #[test]
    fn column_offsets_are_modelled_separately() {
        let sc = Scene::new();
        let dims = Dims::new(sc.w, sc.h).unwrap();
        let n = sc.w * sc.h;
        let g: Vec<f32> = noise(n, 1).iter().map(|v| 1.0 + 0.04 * v).collect();
        let col: Vec<f32> = noise(sc.w, 9).iter().map(|v| 5.0 + 3.0 * v).collect();
        let mut on = OnlineFlatField::new(dims, &sc.mask, online_cfg(0.0, 20.0), None).unwrap();
        for k in 0..72 {
            let s = SHIFTS[k % SHIFTS.len()];
            on.push(&sc.frame(&g, &col, s), (s.0 as f32, s.1 as f32))
                .unwrap();
            if on.due() {
                assert!(matches!(on.refine(), RefineOutcome::Updated(_)));
            }
        }
        let ff = on.current().unwrap();
        let off = ff.offset.as_ref().expect("offset model on");
        for x in 0..sc.w {
            assert!(
                (off[x] - col[x]).abs() < 1e-3,
                "column {x}: {} vs {}",
                off[x],
                col[x]
            );
        }
        let lg: Vec<f32> = g.iter().map(|v| v.ln()).collect();
        assert!(sc.corr(&ff.log_gain, &lg) > 0.9);
        // Without the offset model the column pattern leaks into the gain.
        let mut plain = OnlineFlatField::new(dims, &sc.mask, online_cfg(0.0, 0.0), None).unwrap();
        for k in 0..72 {
            let s = SHIFTS[k % SHIFTS.len()];
            plain
                .push(&sc.frame(&g, &col, s), (s.0 as f32, s.1 as f32))
                .unwrap();
            if plain.due() {
                plain.refine();
            }
        }
        let r_plain = sc.corr(&plain.current().unwrap().log_gain, &lg);
        assert!(r_plain < sc.corr(&ff.log_gain, &lg), "plain r {r_plain}");
    }

    /// A still stretch (one shift bin) keeps the map; a seed is in force
    /// from the first frame.
    #[test]
    fn still_frames_keep_the_map_and_a_seed_starts_it() {
        let sc = Scene::new();
        let dims = Dims::new(sc.w, sc.h).unwrap();
        let n = sc.w * sc.h;
        let g: Vec<f32> = noise(n, 1).iter().map(|v| 1.0 + 0.04 * v).collect();
        let col = vec![0.0f32; sc.w];
        let seed = FlatFieldSeed {
            gain: g.clone(),
            offset: None,
            dark: 0.0,
            frames: 100.0,
        };
        let mut on =
            OnlineFlatField::new(dims, &sc.mask, online_cfg(0.0, 0.0), Some(seed)).unwrap();
        assert!(on.current().is_some());
        for _ in 0..36 {
            on.push(&sc.frame(&g, &col, (0, 0)), (0.1, 0.0)).unwrap();
        }
        assert!(on.due());
        assert!(matches!(on.refine(), RefineOutcome::Skipped(_)));
        assert_eq!(on.updates(), 0);
        for k in 0..72 {
            let s = SHIFTS[k % SHIFTS.len()];
            on.push(&sc.frame(&g, &col, s), (s.0 as f32, s.1 as f32))
                .unwrap();
        }
        assert!(matches!(on.refine(), RefineOutcome::Updated(_)));
        let lg: Vec<f32> = g.iter().map(|v| v.ln()).collect();
        assert!(sc.corr(&on.current().unwrap().log_gain, &lg) > 0.9);
    }
}
