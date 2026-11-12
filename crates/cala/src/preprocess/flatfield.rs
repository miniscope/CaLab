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

use super::gaussian::RecursiveGaussian;
use super::{Dims, PreprocessError, RawPixel};

/// Distance (px) from the FOV beyond which unlit pixels give the dark level.
const DARK_MARGIN: usize = 20;

/// Parameters of [`DitherFlatField::solve`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlatFieldConfig {
    /// Largest |integer shift| per axis that is binned.
    pub radius: i32,
    /// A shift bin enters the solve with at least this many frames.
    pub min_bin_frames: u64,
    /// σ (px) of the high-pass applied to the log images and the gain.
    pub highpass_sigma: f32,
    /// Alternating least-squares iterations.
    pub iterations: usize,
    /// The gain map is clipped to `[clip_lo, clip_hi]`.
    pub clip_lo: f32,
    pub clip_hi: f32,
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
        }
    }
}

/// The result of [`DitherFlatField::solve`].
#[derive(Debug, Clone)]
pub struct FlatField {
    /// Per-pixel gain (1 = nominal, 1 outside the FOV).
    pub gain: Vec<f32>,
    /// Shift bins and frames that entered the solve.
    pub bins_used: usize,
    pub frames_used: u64,
    /// SD of `log gain` inside the FOV, and of the tissue part `t`.
    pub gain_sd: f64,
    pub tissue_sd: f64,
    /// Mean squared misfit of the model per pixel (log units²).
    pub residual: f64,
    /// Dark level subtracted before the logs (grey levels).
    pub dark: f64,
}

/// Accumulates raw frames by their integer rigid shift.
#[derive(Debug, Clone)]
pub struct DitherFlatField {
    dims: Dims,
    mask: Vec<u8>,
    /// Pixels whose mean is the dark level.
    dark_px: Vec<u32>,
    cfg: FlatFieldConfig,
    /// Per bin `(iy + R) * (2R + 1) + (ix + R)`: sum of scaled raw frames.
    sums: Vec<Option<Vec<f64>>>,
    counts: Vec<u64>,
    /// Mean of the outside-FOV pixels (dark level), summed over frames.
    dark_sum: f64,
    ref_mean: Option<f64>,
    frames: u64,
}

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
        Ok(DitherFlatField {
            dims,
            dark_px,
            mask: fov_mask.to_vec(),
            cfg,
            sums: vec![None; nb * nb],
            counts: vec![0; nb * nb],
            dark_sum: 0.0,
            ref_mean: None,
            frames: 0,
        })
    }

    /// Frames pushed (whether or not their shift fell in a bin).
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Add a raw (sensor-coordinate) frame registered by the rigid shift
    /// `(dy, dx)` (a `MotionRecord`'s `dy`, `dx`). Returns whether it was
    /// binned (|round(shift)| ≤ radius on both axes). The frame is scaled to
    /// the first frame's FOV mean, which takes out the global LED flicker.
    pub fn push<T: RawPixel>(
        &mut self,
        raw: &[T],
        (dy, dx): (f32, f32),
    ) -> Result<bool, PreprocessError> {
        self.dims.check("raw frame", raw.len())?;
        self.frames += 1;
        let (mut s_in, mut n_in, mut s_out, mut n_out) = (0.0f64, 0u64, 0.0f64, 0u64);
        for (&r, &m) in raw.iter().zip(&self.mask) {
            let v = f64::from(r.to_f32());
            if v.is_finite() && m != 0 {
                s_in += v;
                n_in += 1;
            }
        }
        for &p in &self.dark_px {
            let v = f64::from(raw[p as usize].to_f32());
            if v.is_finite() {
                s_out += v;
                n_out += 1;
            }
        }
        if n_in == 0 {
            return Ok(false);
        }
        let mean = s_in / n_in as f64;
        if n_out > 0 {
            self.dark_sum += s_out / n_out as f64;
        }
        let r = self.cfg.radius;
        let (iy, ix) = (dy.round() as i32, dx.round() as i32);
        if !dy.is_finite() || !dx.is_finite() || iy.abs() > r || ix.abs() > r || mean <= 0.0 {
            return Ok(false);
        }
        let reference = *self.ref_mean.get_or_insert(mean);
        let scale = reference / mean;
        let nb = (2 * r + 1) as usize;
        let b = (iy + r) as usize * nb + (ix + r) as usize;
        let n = self.dims.pixels();
        let acc = self.sums[b].get_or_insert_with(|| vec![0.0; n]);
        for (a, &v) in acc.iter_mut().zip(raw) {
            let v = f64::from(v.to_f32());
            if v.is_finite() {
                *a += v * scale;
            }
        }
        self.counts[b] += 1;
        Ok(true)
    }

    /// Solve for the gain map (see the module docs).
    pub fn solve(&self) -> Result<FlatField, PreprocessError> {
        let Dims {
            width: w,
            height: h,
        } = self.dims;
        let n = self.dims.pixels();
        let r = self.cfg.radius;
        let nb = (2 * r + 1) as usize;
        let dark = if self.frames > 0 && !self.dark_px.is_empty() {
            (self.dark_sum / self.frames as f64).max(0.0)
        } else {
            0.0
        };
        let mut used: Vec<((i32, i32), f64, Vec<f32>)> = Vec::new();
        let mut hp = HighPass::new(self.dims, &self.mask, self.cfg.highpass_sigma)?;
        for (b, s) in self.sums.iter().enumerate() {
            let c = self.counts[b];
            let Some(s) = s else { continue };
            if c < self.cfg.min_bin_frames {
                continue;
            }
            let mut l: Vec<f32> = s
                .iter()
                .zip(&self.mask)
                .map(|(&v, &m)| {
                    if m != 0 {
                        ((v / c as f64 - dark).max(1.0)).ln() as f32
                    } else {
                        0.0
                    }
                })
                .collect();
            hp.apply(&mut l)?;
            let shift = ((b / nb) as i32 - r, (b % nb) as i32 - r);
            used.push((shift, c as f64, l));
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
        let mut g = vec![0.0f32; n];
        let mut t = vec![0.0f32; n];
        let mut tw = vec![0.0f64; n];
        let mut acc = vec![0.0f64; n];
        for _ in 0..self.cfg.iterations {
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
            bins_used: used.len(),
            frames_used: used.iter().map(|u| u.1 as u64).sum(),
            gain_sd: sd(&g),
            tissue_sd: sd(&t),
            residual: if rn > 0.0 { res / rn } else { f64::NAN },
            dark,
        })
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
}
