//! Hot, cold and stuck pixels: detected once from warm-up statistics, then
//! replaced in every frame by the median of their good neighbours.
//!
//! These defects belong to the sensor, so they must go before motion
//! correction: a hot pixel registered with the tissue is smeared into a
//! bright streak along the motion path and looks like a small active cell.
//!
//! # Detection
//!
//! * **Hot / cold.** A hot pixel has extra dark current, so its *temporal
//!   mean* stands above its neighbourhood. The residual is
//!   `r = mean − median₅ₓ₅(mean)`: the local median follows the vignette,
//!   cells and vessels (all wider than one pixel) but ignores a single-pixel
//!   outlier. The residual is divided by a robust *spatial* noise level σ_r,
//!   which measures how much one pixel normally differs from its
//!   neighbourhood in this recording (tissue and cell texture, PRNU, the
//!   residual temporal noise of the mean); a pixel is hot if `r > k·σ_r` and
//!   cold if `r < −k·σ_r`. Being noise-relative, the same `k` carries across
//!   gains and bit depths.
//!
//!   σ_r depends on brightness. Texture is multiplicative (it scales with the
//!   local intensity: bright cells show pixel-scale structure that dim
//!   neuropil does not), while a hot pixel's excess is additive dark current
//!   that does not. A single global σ_r therefore flags the texture inside
//!   bright cells (on an early, brighter-celled version of the minisim
//!   fixture: 26 false positives against 34 true
//!   hot pixels) or misses hot pixels in the dim periphery. So the FOV pixels
//!   are split into 16 equal-count bins of local brightness (the 5x5 median),
//!   `σ_r = 1.4826 · MAD(r)` is measured per bin, and each pixel uses σ_r
//!   interpolated at its own local brightness. σ_r is floored at
//!   `sigma_floor` so a noiseless synthetic image does not flag rounding
//!   differences.
//!
//!   Default `k = 5`: on the workshop CA1 data (global σ_r ≈ 2.25 grey
//!   levels) the cut is ≈ 11 levels, close to the +10 reference used to
//!   describe that recording, and far beyond the Gaussian tail of the texture
//!   (a 5σ one-sided tail is 3 pixels in 10⁷).
//! * **Stuck / dead.** Inside the field of view every live pixel shows shot
//!   and read noise. A pixel whose temporal standard deviation is below
//!   `stuck_rel_std` (default 0.1) times the median standard deviation over
//!   the field of view is stuck (saturated, or dead at 0), whatever its mean.
//!
//! # Replacement
//!
//! Each flagged pixel is replaced by the median of the unflagged pixels in its
//! 3x3 neighbourhood, or in its 5x5 neighbourhood if all eight are flagged
//! (clusters). The neighbour lists are computed once, so the per-frame cost is
//! a few hundred small medians. A pixel with no good neighbour within 5x5 is
//! left unchanged. The median (not the mean) keeps a flagged pixel on the edge
//! of a bright cell from taking the cell's peak or the background alone.
//!
//! The map is frozen after warm-up and serializable (it is just the flag
//! image; the neighbour lists are rebuilt from it).

use super::fov::FovMask;
use super::stats::{median_filter, median_small, quantile, robust_sigma};
use super::{Dims, PreprocessError};

/// Pixel classification in [`HotPixelMap::flags`].
pub const FLAG_OK: u8 = 0;
/// Temporal mean far above the local median.
pub const FLAG_HOT: u8 = 1;
/// Temporal mean far below the local median.
pub const FLAG_COLD: u8 = 2;
/// (Nearly) no temporal variation inside the field of view.
pub const FLAG_STUCK: u8 = 3;

/// Settings for [`HotPixelMap::detect`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HotPixelConfig {
    /// Threshold on `|mean − local median| / σ_r`.
    pub k_sigma: f32,
    /// Floor on σ_r, in grey levels.
    pub sigma_floor: f32,
    /// Stuck if temporal std < `stuck_rel_std` · median std in the FOV (0 = off).
    pub stuck_rel_std: f32,
    /// Also flag cold (dark) outliers.
    pub detect_cold: bool,
}

impl Default for HotPixelConfig {
    fn default() -> HotPixelConfig {
        HotPixelConfig {
            k_sigma: 5.0,
            sigma_floor: 0.5,
            stuck_rel_std: 0.1,
            detect_cold: true,
        }
    }
}

impl HotPixelConfig {
    pub fn validate(&self) -> Result<(), PreprocessError> {
        if !(self.k_sigma.is_finite() && self.k_sigma > 0.0) {
            return Err(PreprocessError::InvalidConfig(format!(
                "hot-pixel k_sigma must be > 0, got {}",
                self.k_sigma
            )));
        }
        if !(self.sigma_floor.is_finite() && self.sigma_floor >= 0.0) {
            return Err(PreprocessError::InvalidConfig(
                "hot-pixel sigma_floor must be >= 0".into(),
            ));
        }
        if !(self.stuck_rel_std.is_finite() && (0.0..1.0).contains(&self.stuck_rel_std)) {
            return Err(PreprocessError::InvalidConfig(
                "stuck_rel_std must be in [0, 1)".into(),
            ));
        }
        Ok(())
    }
}

/// Brightness bins for the spatial noise level (see the module docs).
const BRIGHTNESS_BINS: usize = 16;
/// Fewest pixels per bin; smaller FOVs use fewer bins.
const MIN_BIN_PIXELS: usize = 64;

/// σ_r as a piecewise-linear function of local brightness.
struct BrightnessScale {
    /// `(bin median brightness, σ_r)`, increasing in brightness.
    knots: Vec<(f32, f32)>,
    fallback: f32,
}

impl BrightnessScale {
    fn fit(
        local: &[f32],
        resid: &[f32],
        fov: &FovMask,
        floor: f32,
        fallback: f32,
    ) -> BrightnessScale {
        let mut px: Vec<(f32, f32)> = local
            .iter()
            .zip(resid)
            .enumerate()
            .filter(|&(i, (l, r))| fov.contains(i) && l.is_finite() && r.is_finite())
            .map(|(_, (&l, &r))| (l, r))
            .collect();
        let bins = (px.len() / MIN_BIN_PIXELS).clamp(1, BRIGHTNESS_BINS);
        px.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut knots = Vec::with_capacity(bins);
        if !px.is_empty() {
            for b in 0..bins {
                let chunk = &px[b * px.len() / bins..(b + 1) * px.len() / bins];
                if chunk.is_empty() {
                    continue;
                }
                let centre = chunk[chunk.len() / 2].0;
                let r: Vec<f32> = chunk.iter().map(|p| p.1).collect();
                let s = robust_sigma(&r).unwrap_or(fallback).max(floor);
                knots.push((centre, s));
            }
        }
        BrightnessScale { knots, fallback }
    }

    /// σ_r at local brightness `l` (clamped at the end bins).
    fn at(&self, l: f32) -> f32 {
        let k = &self.knots;
        match k.len() {
            0 => self.fallback,
            1 => k[0].1,
            _ => {
                if l.is_nan() || l <= k[0].0 {
                    return k[0].1;
                }
                if l >= k[k.len() - 1].0 {
                    return k[k.len() - 1].1;
                }
                let j = k.partition_point(|p| p.0 <= l).max(1);
                let (x0, y0) = k[j - 1];
                let (x1, y1) = k[j];
                if x1 > x0 {
                    y0 + (y1 - y0) * (l - x0) / (x1 - x0)
                } else {
                    y0.max(y1)
                }
            }
        }
    }
}

/// One flagged pixel and the slice of [`HotPixelMap::neighbours`] used to fix it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Fix {
    index: u32,
    start: u32,
    len: u32,
}

/// A frozen defect map and its replacement plan.
#[derive(Debug, Clone, PartialEq)]
pub struct HotPixelMap {
    dims: Dims,
    flags: Vec<u8>,
    fixes: Vec<Fix>,
    neighbours: Vec<u32>,
    sigma: f32,
}

impl HotPixelMap {
    /// No defects.
    pub fn empty(dims: Dims) -> HotPixelMap {
        HotPixelMap {
            dims,
            flags: vec![FLAG_OK; dims.pixels()],
            fixes: Vec::new(),
            neighbours: Vec::new(),
            sigma: 0.0,
        }
    }

    /// Detect from the warm-up mean and variance images (see the module docs).
    pub fn detect(
        dims: Dims,
        mean: &[f32],
        variance: &[f32],
        fov: &FovMask,
        cfg: &HotPixelConfig,
    ) -> Result<HotPixelMap, PreprocessError> {
        dims.check("mean image", mean.len())?;
        dims.check("variance image", variance.len())?;
        dims.check("fov mask", fov.mask().len())?;
        cfg.validate()?;
        let local = median_filter(mean, dims, 2);
        let resid: Vec<f32> = mean.iter().zip(&local).map(|(&m, &l)| m - l).collect();
        let inside: Vec<f32> = resid
            .iter()
            .enumerate()
            .filter(|&(i, _)| fov.contains(i))
            .map(|(_, &r)| r)
            .collect();
        let floor = cfg.sigma_floor.max(f32::MIN_POSITIVE);
        let sigma = robust_sigma(&inside).unwrap_or(0.0).max(floor);
        let scale = BrightnessScale::fit(&local, &resid, fov, floor, sigma);
        let mut flags = vec![FLAG_OK; dims.pixels()];
        for ((f, &r), &l) in flags.iter_mut().zip(&resid).zip(&local) {
            let cut = cfg.k_sigma * scale.at(l);
            if r > cut {
                *f = FLAG_HOT;
            } else if cfg.detect_cold && r < -cut {
                *f = FLAG_COLD;
            }
        }
        if cfg.stuck_rel_std > 0.0 {
            let stds: Vec<f32> = variance
                .iter()
                .enumerate()
                .filter(|&(i, _)| fov.contains(i))
                .map(|(_, &v)| v.max(0.0).sqrt())
                .collect();
            if let Some(med) = quantile(&stds, 0.5) {
                let floor = cfg.stuck_rel_std * med;
                if med > 0.0 {
                    for (i, (f, &v)) in flags.iter_mut().zip(variance).enumerate() {
                        if fov.contains(i) && v.max(0.0).sqrt() < floor {
                            *f = FLAG_STUCK;
                        }
                    }
                }
            }
        }
        let mut map = HotPixelMap::from_flags(dims, &flags)?;
        map.sigma = sigma;
        Ok(map)
    }

    /// Rebuild the replacement plan from a stored flag image.
    pub fn from_flags(dims: Dims, flags: &[u8]) -> Result<HotPixelMap, PreprocessError> {
        dims.check("hot-pixel flags", flags.len())?;
        let Dims { width, height } = dims;
        let mut fixes = Vec::new();
        let mut neighbours = Vec::new();
        for (i, &f) in flags.iter().enumerate() {
            if f == FLAG_OK {
                continue;
            }
            let (y, x) = (i / width, i % width);
            let start = neighbours.len();
            for radius in 1..=2usize {
                for yy in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
                    for xx in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
                        let j = yy * width + xx;
                        if j != i && flags[j] == FLAG_OK {
                            neighbours.push(j as u32);
                        }
                    }
                }
                if neighbours.len() > start {
                    break;
                }
            }
            let len = neighbours.len() - start;
            if len > 0 {
                fixes.push(Fix {
                    index: i as u32,
                    start: start as u32,
                    len: len as u32,
                });
            }
        }
        Ok(HotPixelMap {
            dims,
            flags: flags.to_vec(),
            fixes,
            neighbours,
            sigma: 0.0,
        })
    }

    /// Attach the detection σ_r of a map restored from storage.
    pub(crate) fn with_sigma(mut self, sigma: f32) -> HotPixelMap {
        self.sigma = sigma;
        self
    }

    /// Replace every flagged pixel in place (stateless given the map).
    pub fn apply(&self, frame: &mut [f32]) -> Result<(), PreprocessError> {
        self.dims.check("frame", frame.len())?;
        let mut buf = [0.0f32; 24];
        for fix in &self.fixes {
            let nb = &self.neighbours[fix.start as usize..(fix.start + fix.len) as usize];
            for (b, &j) in buf.iter_mut().zip(nb) {
                *b = frame[j as usize];
            }
            if let Some(m) = median_small(&mut buf[..nb.len()]) {
                frame[fix.index as usize] = m;
            }
        }
        Ok(())
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    /// Per-pixel [`FLAG_OK`] / [`FLAG_HOT`] / [`FLAG_COLD`] / [`FLAG_STUCK`].
    pub fn flags(&self) -> &[u8] {
        &self.flags
    }

    /// Pixels with the given flag.
    pub fn count(&self, flag: u8) -> usize {
        self.flags.iter().filter(|&&f| f == flag).count()
    }

    /// All flagged pixels.
    pub fn flagged(&self) -> usize {
        self.flags.iter().filter(|&&f| f != FLAG_OK).count()
    }

    /// The global robust spatial noise level σ_r over the FOV, for reporting
    /// (detection uses its brightness-dependent version; 0 if rebuilt from flags).
    pub fn sigma(&self) -> f32 {
        self.sigma
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_replaces() {
        let w = 40;
        let dims = Dims::new(w, w).unwrap();
        // Smooth ramp plus deterministic texture of ~1 level.
        let mean: Vec<f32> = (0..w * w)
            .map(|i| 50.0 + (i % w) as f32 * 0.5 + ((i * 7919 % 13) as f32 - 6.0) * 0.3)
            .collect();
        let mut m = mean.clone();
        m[10 * w + 10] += 40.0; // hot
        m[20 * w + 30] -= 30.0; // cold
        let mut var = vec![9.0f32; w * w];
        var[5 * w + 5] = 0.0; // stuck
        let fov = FovMask::full(dims);
        let map = HotPixelMap::detect(dims, &m, &var, &fov, &HotPixelConfig::default()).unwrap();
        assert_eq!(map.flags()[10 * w + 10], FLAG_HOT);
        assert_eq!(map.flags()[20 * w + 30], FLAG_COLD);
        assert_eq!(map.flags()[5 * w + 5], FLAG_STUCK);
        assert_eq!(map.flagged(), 3);

        let mut frame = m.clone();
        map.apply(&mut frame).unwrap();
        assert!((frame[10 * w + 10] - mean[10 * w + 10]).abs() < 2.0);
        assert!((frame[20 * w + 30] - mean[20 * w + 30]).abs() < 2.0);

        let rebuilt = HotPixelMap::from_flags(dims, map.flags()).unwrap();
        let mut f2 = m.clone();
        rebuilt.apply(&mut f2).unwrap();
        assert_eq!(frame, f2);
    }

    #[test]
    fn clusters_and_isolated_corners() {
        let dims = Dims::new(6, 6).unwrap();
        let mut flags = vec![FLAG_OK; 36];
        // A 3x3 block of hot pixels: the centre needs the 5x5 ring.
        for y in 1..4 {
            for x in 1..4 {
                flags[y * 6 + x] = FLAG_HOT;
            }
        }
        let map = HotPixelMap::from_flags(dims, &flags).unwrap();
        let mut frame: Vec<f32> = flags
            .iter()
            .map(|&f| if f != 0 { 99.0 } else { 1.0 })
            .collect();
        map.apply(&mut frame).unwrap();
        assert!(frame.iter().all(|&v| v == 1.0));

        // Everything flagged: nothing to replace with, frame unchanged.
        let all = HotPixelMap::from_flags(dims, &[FLAG_HOT; 36]).unwrap();
        let mut f = vec![3.0f32; 36];
        all.apply(&mut f).unwrap();
        assert!(f.iter().all(|&v| v == 3.0));
        assert!(all.apply(&mut [0.0; 4]).is_err());
    }

    #[test]
    fn noiseless_image_flags_nothing() {
        let dims = Dims::new(12, 12).unwrap();
        let mean = vec![10.0f32; 144];
        let var = vec![0.0f32; 144];
        let map = HotPixelMap::detect(
            dims,
            &mean,
            &var,
            &FovMask::full(dims),
            &HotPixelConfig::default(),
        )
        .unwrap();
        // Median std is 0, so the stuck test is skipped too.
        assert_eq!(map.flagged(), 0);
    }
}
