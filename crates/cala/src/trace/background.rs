//! Background models for the trace solve, and learning their spatial maps.
//!
//! On real 1-photon data the light left after the σ = 20 px high-pass that is
//! not explained by cells is dominated by one global mode (about 90 % of the
//! non-noise variance on the workshop CA1 recording: common-mode flicker and
//! slow gain changes, spatially a smooth vignetted gain map), then a smooth
//! local field with a ~100-120 px correlation length. So the default model is
//! a few smooth spatial maps with a free coefficient each per frame
//! ([`BackgroundModel::Basis`]): the leading one is the global mode, the rest
//! a low-rank local field. A CNMF-E-style ring (the mean of the residual in an
//! annulus around each cell, [`BackgroundModel::Ring`]) is the alternative.
//!
//! On the calibrated minisim recordings (`examples/trace_eval.rs`, oracle
//! footprints) the ring is the most accurate (median trace r 0.955-0.968,
//! 90th-percentile crosstalk ~0.11) and global + rank-k is close behind
//! (0.948-0.960, ~0.18), both far ahead of no background (0.90-0.92, ~0.37).
//! The ring wins there because what it removes is mostly *local*: neighbours'
//! filtered tails outside their tight supports and cells missing from the
//! library. Which wins on real data (where the global mode is much stronger
//! than in the simulator) is still open, so both stay.
//!
//! [`BackgroundLearner`] finds the maps: feed it the residual
//! `y − Σ ã_i c_i` of some frames (e.g. a warm-up solved without a
//! background), then [`BackgroundLearner::fit`] returns the leading principal
//! components of the spatially smoothed residual (uncentred, so a static
//! offset left by the floor subtraction is part of the span). Learn, solve
//! the same frames again with the learned maps, and learn from that residual:
//! the first residual is biased because the traces soaked up part of the
//! background (three rounds lift the median trace r from 0.926 to 0.951 at
//! halo fraction 0.45). The residual is
//! stored block-averaged (`factor` x `factor`), so 400 frames of 600 x 600
//! cost 9 MB at the default factor 4.

use super::{check_len, TraceError};
use crate::preprocess::gaussian::RecursiveGaussian;
use crate::preprocess::Dims;

/// The background part of the forward model.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum BackgroundModel {
    /// No background term.
    #[default]
    None,
    /// Fixed spatial maps (full frame each), one free coefficient per map and
    /// frame. One map = the global mode; more = global + low-rank.
    Basis(Vec<Vec<f32>>),
    /// Per-cell local background: the mean of the residual over an annulus
    /// `inner_px..outer_px` around each cell (inner is raised to just outside
    /// the cell's support when smaller), as a constant under the cell.
    Ring { inner_px: f32, outer_px: f32 },
}

/// Leading spatial components of smoothed residual frames.
#[derive(Debug, Clone)]
pub struct BackgroundLearner {
    dims: Dims,
    factor: usize,
    coarse: Dims,
    max_frames: usize,
    smooth_px: f32,
    /// Coarse in-FOV weight (fraction of the block inside the mask).
    weight: Vec<f32>,
    frames: Vec<f32>,
    count: usize,
}

/// What [`BackgroundLearner::fit`] found.
#[derive(Debug, Clone)]
pub struct BackgroundFit {
    /// Full-resolution maps, strongest first, each scaled to max |value| 1.
    pub maps: Vec<Vec<f32>>,
    /// Energy (sum of squares over frames) of each component, same order.
    pub energy: Vec<f64>,
    /// Total energy of the smoothed residual.
    pub total_energy: f64,
}

impl BackgroundLearner {
    /// `factor`: block size of the stored residual; `smooth_px`: Gaussian σ
    /// (full-resolution px) applied before the decomposition; `max_frames`:
    /// frames kept (later pushes are ignored). `fov`: in-FOV mask or `None`.
    pub fn new(
        dims: Dims,
        fov: Option<&[u8]>,
        factor: usize,
        smooth_px: f32,
        max_frames: usize,
    ) -> Result<BackgroundLearner, TraceError> {
        if factor == 0 || max_frames == 0 || !(smooth_px.is_finite() && smooth_px >= 0.0) {
            return Err(TraceError::InvalidConfig(format!(
                "background learner: factor {factor}, smooth {smooth_px}, frames {max_frames}"
            )));
        }
        let coarse = Dims::new(dims.width.div_ceil(factor), dims.height.div_ceil(factor))?;
        let mut weight = vec![0.0f32; coarse.pixels()];
        let mut area = vec![0.0f32; coarse.pixels()];
        for y in 0..dims.height {
            for x in 0..dims.width {
                let c = (y / factor) * coarse.width + x / factor;
                area[c] += 1.0;
                if fov.is_none_or(|m| m[y * dims.width + x] != 0) {
                    weight[c] += 1.0;
                }
            }
        }
        if let Some(m) = fov {
            check_len("fov mask", dims.pixels(), m.len())?;
        }
        for (w, a) in weight.iter_mut().zip(&area) {
            *w /= a.max(1.0);
        }
        Ok(BackgroundLearner {
            dims,
            factor,
            coarse,
            max_frames,
            smooth_px,
            weight,
            frames: Vec::new(),
            count: 0,
        })
    }

    pub fn frames(&self) -> usize {
        self.count
    }

    /// Add one residual frame (`y − Σ ã_i c_i`, full resolution).
    pub fn push(&mut self, residual: &[f32]) -> Result<(), TraceError> {
        check_len("residual", self.dims.pixels(), residual.len())?;
        if self.count >= self.max_frames {
            return Ok(());
        }
        let cp = self.coarse.pixels();
        let o = self.frames.len();
        self.frames.resize(o + cp, 0.0);
        let block = &mut self.frames[o..];
        let f = self.factor;
        for y in 0..self.dims.height {
            let row = &residual[y * self.dims.width..(y + 1) * self.dims.width];
            let crow = (y / f) * self.coarse.width;
            for (x, &v) in row.iter().enumerate() {
                block[crow + x / f] += v;
            }
        }
        // Block sums -> mean over in-FOV pixels (outside pixels are 0).
        for (b, &w) in block.iter_mut().zip(&self.weight) {
            *b = if w > 0.0 {
                *b / (w * (f * f) as f32)
            } else {
                0.0
            };
        }
        self.count += 1;
        Ok(())
    }

    /// The `k` leading components of the smoothed residual.
    pub fn fit(&self, k: usize) -> Result<BackgroundFit, TraceError> {
        let t = self.count;
        if k == 0 || k > t {
            return Err(TraceError::InvalidConfig(format!(
                "background fit: {k} components from {t} frames"
            )));
        }
        let cp = self.coarse.pixels();
        // Normalized-convolution smoothing inside the FOV.
        let sigma = self.smooth_px / self.factor as f32;
        let mut sm = self.frames.clone();
        if sigma >= 0.5 {
            let mut g = RecursiveGaussian::new(self.coarse, sigma)?;
            let mut norm = vec![0.0f32; cp];
            g.blur(&self.weight, &mut norm)?;
            let mut tmp = vec![0.0f32; cp];
            let mut src = vec![0.0f32; cp];
            for s in 0..t {
                let fr = &mut sm[s * cp..(s + 1) * cp];
                for ((d, &v), &w) in src.iter_mut().zip(fr.iter()).zip(&self.weight) {
                    *d = v * w;
                }
                g.blur(&src, &mut tmp)?;
                for ((o, &v), (&nm, &w)) in
                    fr.iter_mut().zip(&tmp).zip(norm.iter().zip(&self.weight))
                {
                    *o = if w > 0.0 && nm > 1e-6 { v / nm } else { 0.0 };
                }
            }
        }
        // Frame Gram matrix (weighted by the in-FOV fraction) and its eigenvectors.
        let mut gram = vec![0.0f64; t * t];
        for a in 0..t {
            for b in a..t {
                let s: f64 = sm[a * cp..(a + 1) * cp]
                    .iter()
                    .zip(&sm[b * cp..(b + 1) * cp])
                    .zip(&self.weight)
                    .map(|((&u, &v), &w)| f64::from(u) * f64::from(v) * f64::from(w))
                    .sum();
                gram[a * t + b] = s;
                gram[b * t + a] = s;
            }
        }
        let total_energy: f64 = (0..t).map(|a| gram[a * t + a]).sum();
        let (evals, evecs) = jacobi_eigen(gram, t);
        let mut order: Vec<usize> = (0..t).collect();
        order.sort_by(|&a, &b| evals[b].total_cmp(&evals[a]));
        let mut maps = Vec::with_capacity(k);
        let mut energy = Vec::with_capacity(k);
        for &e in order.iter().take(k) {
            let mut cmap = vec![0.0f64; cp];
            for s in 0..t {
                let v = evecs[s * t + e];
                for (m, &r) in cmap.iter_mut().zip(&sm[s * cp..(s + 1) * cp]) {
                    *m += v * f64::from(r);
                }
            }
            let cmap: Vec<f32> = cmap.iter().map(|&v| v as f32).collect();
            maps.push(self.upsample(&cmap));
            energy.push(evals[e].max(0.0));
        }
        Ok(BackgroundFit {
            maps,
            energy,
            total_energy,
        })
    }

    /// Bilinear upsampling of a coarse map (block centres) to full resolution,
    /// zero outside the FOV, scaled to max |value| 1.
    fn upsample(&self, cmap: &[f32]) -> Vec<f32> {
        let (w, h) = (self.dims.width, self.dims.height);
        let (cw, ch) = (self.coarse.width, self.coarse.height);
        let f = self.factor as f32;
        let mut out = vec![0.0f32; w * h];
        for y in 0..h {
            let fy = ((y as f32 + 0.5) / f - 0.5).clamp(0.0, (ch - 1) as f32);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(ch - 1);
            let ty = fy - y0 as f32;
            for x in 0..w {
                let fx = ((x as f32 + 0.5) / f - 0.5).clamp(0.0, (cw - 1) as f32);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(cw - 1);
                let tx = fx - x0 as f32;
                let a = cmap[y0 * cw + x0] * (1.0 - tx) + cmap[y0 * cw + x1] * tx;
                let b = cmap[y1 * cw + x0] * (1.0 - tx) + cmap[y1 * cw + x1] * tx;
                out[y * w + x] = a * (1.0 - ty) + b * ty;
            }
        }
        // Zero outside the FOV (where the coarse weight of the pixel's block is 0).
        for y in 0..h {
            for x in 0..w {
                if self.weight[(y / self.factor) * cw + x / self.factor] <= 0.0 {
                    out[y * w + x] = 0.0;
                }
            }
        }
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        if peak > 0.0 {
            out.iter_mut().for_each(|v| *v /= peak);
        }
        out
    }
}

/// Eigen-decomposition of a symmetric `n x n` matrix by cyclic Jacobi
/// rotations: `(eigenvalues, eigenvectors)` with eigenvector `j` in column `j`.
fn jacobi_eigen(mut a: Vec<f64>, n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut v = vec![0.0f64; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    let total: f64 = a.iter().map(|x| x * x).sum::<f64>().max(f64::MIN_POSITIVE);
    for _ in 0..50 {
        let off: f64 = (0..n)
            .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| a[i * n + j] * a[i * n + j])
            .sum();
        if off <= 1e-22 * total {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq.abs() <= 1e-300 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let akp = a[k * n + p];
                    let akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let apk = a[p * n + k];
                    let aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for k in 0..n {
                    let vkp = v[k * n + p];
                    let vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    ((0..n).map(|i| a[i * n + i]).collect(), v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jacobi_recovers_eigenpairs() {
        let a = vec![4.0, 1.0, 0.0, 1.0, 3.0, 1.0, 0.0, 1.0, 2.0];
        let (e, v) = jacobi_eigen(a.clone(), 3);
        for j in 0..3 {
            for i in 0..3 {
                let av: f64 = (0..3).map(|k| a[i * 3 + k] * v[k * 3 + j]).sum();
                assert!((av - e[j] * v[i * 3 + j]).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn learner_finds_a_global_mode() {
        let dims = Dims::new(64, 48).unwrap();
        let map: Vec<f32> = (0..dims.pixels())
            .map(|i| 1.0 + 0.3 * ((i % 64) as f32 / 64.0))
            .collect();
        let mut l = BackgroundLearner::new(dims, None, 4, 4.0, 50).unwrap();
        for t in 0..40 {
            let s = (t as f32 * 0.7).sin() + 2.0;
            let fr: Vec<f32> = map.iter().map(|&m| m * s).collect();
            l.push(&fr).unwrap();
        }
        let fit = l.fit(2).unwrap();
        assert!(fit.energy[0] > 0.999 * fit.total_energy);
        // The map matches the planted one up to scale.
        let m = &fit.maps[0];
        let r = m[100] / map[100];
        for i in (0..dims.pixels()).step_by(97) {
            assert!((m[i] - r * map[i]).abs() < 0.02 * r.abs(), "pixel {i}");
        }
    }
}
