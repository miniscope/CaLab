//! Field-of-view mask: the lit lens region of the sensor.
//!
//! A Miniscope's GRIN lens images a disk onto a square sensor. Outside it the
//! sensor reads only its dark level (the workshop CA1 data: corners ~0 against
//! ~115 in the centre), and every later stage should ignore those pixels: they
//! carry no tissue, and if they enter a spatial filter they pull the
//! illumination estimate down and draw a dark ring at the lens edge.
//!
//! # Method (once, on the warm-up mean image)
//!
//! 1. **Relative threshold.** `lo` and `hi` are the 1st and 99th percentiles
//!    of the mean image (robust to hot pixels and a few saturated cells); a
//!    pixel is lit if it exceeds `lo + rel_threshold · (hi − lo)`. A relative
//!    threshold carries across gain settings, LED powers and bit depths. The
//!    default 0.15 sits where the CA1 vignette is still clearly above the dark
//!    floor (~19 grey levels against a 0 floor and a 126 centre) but below the
//!    dimmest tissue that still shows cells.
//! 2. **Opening** (erode, then dilate, with a square of radius `open_radius`)
//!    removes isolated lit specks outside the lens, e.g. hot pixels, and thin
//!    bridges between them and the disk.
//! 3. **Largest 4-connected component**: the lens is one connected region.
//! 4. **Hole filling**: dark vessels and dim tissue inside the lens are still
//!    in the field of view; anything not connected to the frame border
//!    through unlit pixels is filled.
//! 5. Optionally **fit a disk** to the mask boundary (algebraic least-squares
//!    circle, Kåsa 1976), ignoring boundary pixels on the frame edge, where
//!    the frame and not the lens cuts the disk. This gives a smooth, convex
//!    edge when the threshold contour is ragged. Off by default: the lit area
//!    is not always a disk (tilted lens, a baseplate shadow), and the
//!    threshold mask follows whatever is actually lit.
//! 6. Optionally erode by `margin_px` to drop the steep vignette edge.
//!
//! A flat image (`hi ≈ lo`, e.g. already flat-fielded) has no edge to find and
//! yields the full frame.
//!
//! The mask is frozen after warm-up: it is a property of the optics, not the
//! tissue, and changing it mid-recording would change every downstream stage.

use super::stats::quantile;
use super::{Dims, PreprocessError};

/// Settings for [`FovMask::from_mean`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FovConfig {
    /// Lit if above `lo + rel_threshold · (hi − lo)`; in (0, 1).
    pub rel_threshold: f32,
    /// Opening radius in pixels (0 = no opening).
    pub open_radius: usize,
    /// Replace the mask by a least-squares disk fitted to its boundary.
    pub fit_disk: bool,
    /// Erode the final mask by this many pixels.
    pub margin_px: usize,
}

impl Default for FovConfig {
    fn default() -> FovConfig {
        FovConfig {
            rel_threshold: 0.15,
            open_radius: 2,
            fit_disk: false,
            margin_px: 0,
        }
    }
}

impl FovConfig {
    pub fn validate(&self) -> Result<(), PreprocessError> {
        if !(self.rel_threshold > 0.0 && self.rel_threshold < 1.0) {
            return Err(PreprocessError::InvalidConfig(format!(
                "fov rel_threshold must be in (0, 1), got {}",
                self.rel_threshold
            )));
        }
        Ok(())
    }
}

/// A frozen binary field-of-view mask.
#[derive(Debug, Clone, PartialEq)]
pub struct FovMask {
    dims: Dims,
    /// 1 inside the field of view, 0 outside.
    mask: Vec<u8>,
    /// The absolute threshold that was applied (0 for a full-frame mask).
    threshold: f32,
    /// `(cy, cx, r)` when a disk was fitted.
    disk: Option<(f32, f32, f32)>,
}

impl FovMask {
    /// Every pixel is in the field of view.
    pub fn full(dims: Dims) -> FovMask {
        FovMask {
            dims,
            mask: vec![1; dims.pixels()],
            threshold: 0.0,
            disk: None,
        }
    }

    /// Rebuild from a stored mask (any non-zero byte is inside).
    pub fn from_mask(dims: Dims, mask: &[u8]) -> Result<FovMask, PreprocessError> {
        dims.check("fov mask", mask.len())?;
        Ok(FovMask {
            dims,
            mask: mask.iter().map(|&m| u8::from(m != 0)).collect(),
            threshold: 0.0,
            disk: None,
        })
    }

    /// Estimate from a warm-up mean image (see the module docs).
    pub fn from_mean(
        dims: Dims,
        mean: &[f32],
        cfg: &FovConfig,
    ) -> Result<FovMask, PreprocessError> {
        dims.check("mean image", mean.len())?;
        cfg.validate()?;
        let (Some(lo), Some(hi)) = (quantile(mean, 0.01), quantile(mean, 0.99)) else {
            return Ok(FovMask::full(dims));
        };
        if hi - lo <= 1e-6 * hi.abs().max(1.0) {
            return Ok(FovMask::full(dims));
        }
        let threshold = lo + cfg.rel_threshold * (hi - lo);
        let mut m: Vec<u8> = mean.iter().map(|&v| u8::from(v > threshold)).collect();
        if cfg.open_radius > 0 {
            m = erode(&m, dims, cfg.open_radius);
            m = dilate(&m, dims, cfg.open_radius);
        }
        m = largest_component(&m, dims);
        if m.iter().all(|&v| v == 0) {
            return Ok(FovMask::full(dims));
        }
        fill_holes(&mut m, dims);
        let mut disk = None;
        if cfg.fit_disk {
            if let Some((cy, cx, r)) = fit_disk(&m, dims) {
                for y in 0..dims.height {
                    for x in 0..dims.width {
                        let dy = y as f32 - cy;
                        let dx = x as f32 - cx;
                        m[y * dims.width + x] = u8::from(dy * dy + dx * dx <= r * r);
                    }
                }
                disk = Some((cy, cx, r));
            }
        }
        if cfg.margin_px > 0 {
            m = erode(&m, dims, cfg.margin_px);
        }
        if m.iter().all(|&v| v == 0) {
            return Ok(FovMask::full(dims));
        }
        Ok(FovMask {
            dims,
            mask: m,
            threshold,
            disk,
        })
    }

    /// Attach the diagnostics of a mask restored from storage.
    pub(crate) fn with_details(mut self, threshold: f32, disk: Option<(f32, f32, f32)>) -> FovMask {
        self.threshold = threshold;
        self.disk = disk;
        self
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    /// 1 inside, 0 outside, row-major.
    pub fn mask(&self) -> &[u8] {
        &self.mask
    }

    /// The mask as 0.0 / 1.0 weights.
    pub fn weights(&self) -> Vec<f32> {
        self.mask.iter().map(|&m| f32::from(m)).collect()
    }

    /// Pixels inside.
    pub fn area(&self) -> usize {
        self.mask.iter().filter(|&&m| m != 0).count()
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    /// `(cy, cx, r)` of the fitted disk, if one was fitted.
    pub fn disk(&self) -> Option<(f32, f32, f32)> {
        self.disk
    }

    #[inline]
    pub fn contains(&self, i: usize) -> bool {
        self.mask.get(i).is_some_and(|&m| m != 0)
    }
}

/// Square (Chebyshev) erosion; out-of-frame counts as outside.
fn erode(m: &[u8], dims: Dims, r: usize) -> Vec<u8> {
    morph(m, dims, r, true)
}

/// Square dilation.
fn dilate(m: &[u8], dims: Dims, r: usize) -> Vec<u8> {
    morph(m, dims, r, false)
}

/// Separable square min (erode) or max (dilate) of radius `r`.
fn morph(m: &[u8], dims: Dims, r: usize, erode: bool) -> Vec<u8> {
    let Dims { width, height } = dims;
    let pick = |acc: u8, v: u8| if erode { acc.min(v) } else { acc.max(v) };
    let init = u8::from(erode);
    let mut tmp = vec![0u8; m.len()];
    for y in 0..height {
        for x in 0..width {
            let mut acc = init;
            for xx in x as isize - r as isize..=(x + r) as isize {
                let v = if xx < 0 || xx >= width as isize {
                    0
                } else {
                    m[y * width + xx as usize]
                };
                acc = pick(acc, v);
            }
            tmp[y * width + x] = acc;
        }
    }
    let mut out = vec![0u8; m.len()];
    for y in 0..height {
        for x in 0..width {
            let mut acc = init;
            for yy in y as isize - r as isize..=(y + r) as isize {
                let v = if yy < 0 || yy >= height as isize {
                    0
                } else {
                    tmp[yy as usize * width + x]
                };
                acc = pick(acc, v);
            }
            out[y * width + x] = acc;
        }
    }
    out
}

/// 4-connected neighbours of pixel `i`.
fn neighbours4(i: usize, dims: Dims) -> impl Iterator<Item = usize> {
    let (w, h) = (dims.width, dims.height);
    let (y, x) = (i / w, i % w);
    [
        (y > 0).then(|| i - w),
        (y + 1 < h).then(|| i + w),
        (x > 0).then(|| i - 1),
        (x + 1 < w).then(|| i + 1),
    ]
    .into_iter()
    .flatten()
}

/// Keep only the largest 4-connected component of non-zero pixels.
fn largest_component(m: &[u8], dims: Dims) -> Vec<u8> {
    let mut label = vec![0u32; m.len()];
    let mut best = (0u32, 0usize);
    let mut next = 0u32;
    let mut stack = Vec::new();
    for start in 0..m.len() {
        if m[start] == 0 || label[start] != 0 {
            continue;
        }
        next += 1;
        let mut size = 0usize;
        label[start] = next;
        stack.push(start);
        while let Some(i) = stack.pop() {
            size += 1;
            for j in neighbours4(i, dims) {
                if m[j] != 0 && label[j] == 0 {
                    label[j] = next;
                    stack.push(j);
                }
            }
        }
        if size > best.1 {
            best = (next, size);
        }
    }
    label
        .iter()
        .map(|&l| u8::from(l != 0 && l == best.0))
        .collect()
}

/// Set every zero pixel not 4-connected to the frame border through zeros.
fn fill_holes(m: &mut [u8], dims: Dims) {
    let Dims { width, height } = dims;
    let mut outside = vec![false; m.len()];
    let mut stack = Vec::new();
    let seed = |i: usize, stack: &mut Vec<usize>, outside: &mut Vec<bool>| {
        if m[i] == 0 && !outside[i] {
            outside[i] = true;
            stack.push(i);
        }
    };
    for x in 0..width {
        seed(x, &mut stack, &mut outside);
        seed((height - 1) * width + x, &mut stack, &mut outside);
    }
    for y in 0..height {
        seed(y * width, &mut stack, &mut outside);
        seed(y * width + width - 1, &mut stack, &mut outside);
    }
    while let Some(i) = stack.pop() {
        for j in neighbours4(i, dims) {
            if m[j] == 0 && !outside[j] {
                outside[j] = true;
                stack.push(j);
            }
        }
    }
    for (v, &o) in m.iter_mut().zip(&outside) {
        if !o {
            *v = 1;
        }
    }
}

/// Kåsa circle fit to the mask's boundary pixels that are not on the frame
/// edge: least squares on `x² + y² + D x + E y + F = 0`. `None` if there are
/// too few points or the system is singular.
fn fit_disk(m: &[u8], dims: Dims) -> Option<(f32, f32, f32)> {
    let Dims { width, height } = dims;
    // Normal equations for [D, E, F] with rows [x, y, 1] and rhs -(x² + y²).
    let mut ata = [[0.0f64; 3]; 3];
    let mut atb = [0.0f64; 3];
    let mut n = 0usize;
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let i = y * width + x;
            if m[i] == 0 || neighbours4(i, dims).all(|j| m[j] != 0) {
                continue;
            }
            let (fx, fy) = (x as f64, y as f64);
            let row = [fx, fy, 1.0];
            let rhs = -(fx * fx + fy * fy);
            for a in 0..3 {
                for b in 0..3 {
                    ata[a][b] += row[a] * row[b];
                }
                atb[a] += row[a] * rhs;
            }
            n += 1;
        }
    }
    if n < 8 {
        return None;
    }
    let sol = solve3(ata, atb)?;
    let cx = -sol[0] / 2.0;
    let cy = -sol[1] / 2.0;
    let r2 = cx * cx + cy * cy - sol[2];
    if !(r2.is_finite() && r2 > 1.0) {
        return None;
    }
    Some((cy as f32, cx as f32, r2.sqrt() as f32))
}

/// Gaussian elimination with partial pivoting for a 3x3 system.
fn solve3(mut a: [[f64; 3]; 3], mut b: [f64; 3]) -> Option<[f64; 3]> {
    for col in 0..3 {
        let piv = (col..3).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        for row in col + 1..3 {
            let f = a[row][col] / a[col][col];
            let pivot = a[col];
            for (x, p) in a[row][col..].iter_mut().zip(&pivot[col..]) {
                *x -= f * p;
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = [0.0f64; 3];
    for row in (0..3).rev() {
        let mut s = b[row];
        for k in row + 1..3 {
            s -= a[row][k] * x[k];
        }
        x[row] = s / a[row][row];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vignetted disk of radius `r` centred in a `w x w` frame, a hot pixel
    /// in the dark corner, and a dark "vessel" crossing the middle.
    fn lens_image(w: usize, r: f32) -> Vec<f32> {
        let c = (w as f32 - 1.0) / 2.0;
        let mut img = vec![0.0f32; w * w];
        for y in 0..w {
            for x in 0..w {
                let d = ((y as f32 - c).powi(2) + (x as f32 - c).powi(2)).sqrt();
                img[y * w + x] = if d < r {
                    100.0 * (1.0 - (d / r).powi(4)) + 5.0
                } else {
                    0.5
                };
            }
        }
        img[2 * w + 2] = 200.0;
        for x in (w / 4)..(3 * w / 4) {
            img[(w / 2) * w + x] = 2.0;
        }
        img
    }

    #[test]
    fn finds_disk_ignores_hot_pixel_and_fills_vessel() {
        let w = 120;
        let dims = Dims::new(w, w).unwrap();
        let img = lens_image(w, 50.0);
        let fov = FovMask::from_mean(dims, &img, &FovConfig::default()).unwrap();
        assert!(!fov.contains(2 * w + 2), "hot pixel outside lens kept");
        assert!(fov.contains((w / 2) * w + w / 2), "vessel not filled");
        let area = fov.area() as f32;
        let disk = std::f32::consts::PI * 50.0 * 50.0;
        assert!(
            area > 0.8 * disk && area < 1.02 * disk,
            "area {area} vs {disk}"
        );
    }

    #[test]
    fn disk_fit_recovers_centre_and_radius_even_when_clipped() {
        let w = 100;
        let dims = Dims::new(w, w).unwrap();
        // Radius larger than half the frame: the frame clips the disk.
        let img = lens_image(w, 58.0);
        let cfg = FovConfig {
            fit_disk: true,
            ..FovConfig::default()
        };
        let fov = FovMask::from_mean(dims, &img, &cfg).unwrap();
        let (cy, cx, r) = fov.disk().expect("disk fitted");
        assert!(
            (cy - 49.5).abs() < 1.5 && (cx - 49.5).abs() < 1.5,
            "{cy} {cx}"
        );
        // The threshold contour sits inside the true edge (vignette falloff).
        assert!(r > 45.0 && r < 59.0, "r {r}");
    }

    #[test]
    fn flat_or_degenerate_images_give_full_frame() {
        let dims = Dims::new(10, 8).unwrap();
        let fov = FovMask::from_mean(dims, &[7.0; 80], &FovConfig::default()).unwrap();
        assert_eq!(fov.area(), 80);
        let fov = FovMask::from_mean(dims, &[f32::NAN; 80], &FovConfig::default()).unwrap();
        assert_eq!(fov.area(), 80);
        let dims1 = Dims::new(1, 1).unwrap();
        let fov = FovMask::from_mean(dims1, &[3.0], &FovConfig::default()).unwrap();
        assert_eq!(fov.area(), 1);
        assert!(FovMask::from_mean(dims, &[1.0; 3], &FovConfig::default()).is_err());
        let bad = FovConfig {
            rel_threshold: 1.5,
            ..FovConfig::default()
        };
        assert!(FovMask::from_mean(dims, &[1.0; 80], &bad).is_err());
    }

    #[test]
    fn margin_shrinks_mask() {
        let w = 80;
        let dims = Dims::new(w, w).unwrap();
        let img = lens_image(w, 30.0);
        let a0 = FovMask::from_mean(dims, &img, &FovConfig::default())
            .unwrap()
            .area();
        let cfg = FovConfig {
            margin_px: 3,
            ..FovConfig::default()
        };
        let a1 = FovMask::from_mean(dims, &img, &cfg).unwrap().area();
        assert!(a1 < a0);
    }
}
