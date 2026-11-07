//! Glow flattening: subtract a broad, FOV-normalized Gaussian low-pass.
//!
//! A 1-photon frame is dominated by smooth light that is not cells: the LED's
//! uneven excitation, the vignette of the collection optics, stray light
//! (leakage) and out-of-focus fluorescence. All of it varies over hundreds of
//! pixels, while a soma spans ~10. Subtracting a low-pass estimate of each
//! frame leaves the cells (and other sharp structure) on a flat zero floor.
//!
//! # Method: normalized convolution, first order
//!
//! ```text
//! order 0:  low = G_σ * (frame · M) / G_σ * M          (inside the FOV mask M)
//! order 1:  low = a, where a + b·dx + c·dy is the G_σ·M-weighted
//!           least-squares plane through the frame around each pixel
//! out = frame − low  inside the mask, 0 outside
//! ```
//!
//! A plain blur near the lens edge averages in the dark outside, so `low`
//! sags there and `frame − low` turns into a bright ring just inside the edge.
//! Dividing by the blurred mask (order 0; Knutsson & Westin 1993) makes `low`
//! a weighted average of in-FOV pixels only. That removes the sag, but near the
//! edge the average is one-sided: its centroid sits ~0.8σ inward, and on the
//! steep vignette slope there (0.6-0.8 grey levels/px on the CA1 data) the
//! inward pixels are brighter, so `low` overshoots and leaves a *dark* ring of
//! roughly slope · 0.8σ ≈ 10 grey levels. Order 1 fits a plane instead of a
//! constant ("normalized differential convolution", Westin et al. 1994), which
//! cancels that first-order bias, so the estimate follows the vignette up to
//! the edge. In the interior the plane's slope terms vanish by symmetry and
//! order 1 equals order 0. Both handle the frame border the same way, since
//! the Gaussian treats it as zero padding ([`super::gaussian`]). Order 1 is
//! the default; order 0 is kept for comparison.
//!
//! The plane fit costs no extra blurs. With `N = G_σ * (M·f)`, the weighted
//! first moments are derivatives of the blur:
//! `Σ g(x−x′) (x′−x) M f = σ² ∂ₓN` (because `∂ₓg = (x′−x)/σ² · g`), and the
//! second moments of the mask similarly come from `σ⁴ ∂²G*M + σ² G*M`. The
//! derivatives are central differences of very smooth images (σ = 20), so
//! they are accurate; the blur runs on a canvas with a 2-pixel zero margin so
//! the differences are central at the frame border too. The 3x3 normal equations depend only on the frozen
//! mask, so the first row of their inverse is precomputed per pixel and each
//! frame costs one recursive blur plus one pass:
//! `low = r₀ N + r₁ σ² ∂ₓN + r₂ σ² ∂ᵧN`. Where the system is ill-conditioned
//! (a pixel whose in-mask neighbourhood is too thin to fit a plane) the pixel
//! falls back to order 0.
//!
//! What no low-pass subtraction removes is curvature: a smooth field `f`
//! leaves `≈ −σ²/2 ∇²f` behind. On the CA1 vignette that is a gentle bowl of a
//! few grey levels, which the background stage ([`super::background`]) then
//! absorbs because it is static.
//!
//! This is a stand-in for cala's Butterworth high-pass: a Gaussian is not as
//! sharp a cutoff, but it has no ringing (no dark halo around bright cells),
//! needs no FFT, and costs O(pixels) for any σ.
//!
//! # Choosing σ
//!
//! The low-pass must not see the cells. For a roughly Gaussian soma of width
//! σ_c, a σ_b blur keeps a fraction `σ_c² / (σ_c² + σ_b²)` of its peak, which
//! the subtraction removes. A soma of diameter `d` has σ_c ≈ d/4, so with
//! σ_b = 2d the loss is 1/65 ≈ 1.5 % of the peak for an isolated cell, and a
//! dense cluster of cells still loses only a few percent. Going much larger
//! buys little and lets more of the vignette's curvature through (the
//! curvature residual grows as σ²).
//!
//! Default: `cell_diameter_px` = 10 (a CA1 pyramidal soma of ~15 µm at the
//! ~1.6 µm/px of a 600x600 Miniscope V4 frame), so σ = 20 px. That matches the
//! two references on this data: minian's tophat window (radius 20 px) and
//! cala's Butterworth cutoff of 0.01 cycles/px, whose half-power point equals
//! a Gaussian of σ = √(ln 2 / 2) / (π · 0.01) ≈ 18.7 px.
//!
//! # Precision
//!
//! The recursion runs in `f64` ([`super::gaussian`]): in `f32` its rounding
//! error (~10⁻³ relative at σ = 20) is amplified by the derivatives of the
//! plane fit.

use super::fov::FovMask;
use super::gaussian::RecursiveGaussian;
use super::{Dims, PreprocessError};

/// Default soma diameter in pixels (see the module docs).
pub const DEFAULT_CELL_DIAMETER_PX: f32 = 10.0;
/// Default σ / cell diameter.
pub const SIGMA_PER_DIAMETER: f32 = 2.0;

/// Settings for [`GlowFlattener`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlattenConfig {
    /// Expected soma diameter in pixels; sets the default σ.
    pub cell_diameter_px: f32,
    /// Explicit low-pass σ in pixels; `None` = `2 · cell_diameter_px`.
    pub sigma_px: Option<f32>,
    /// First-order (plane-fitting) normalized convolution; `false` = order 0.
    pub local_linear: bool,
}

impl Default for FlattenConfig {
    fn default() -> FlattenConfig {
        FlattenConfig {
            cell_diameter_px: DEFAULT_CELL_DIAMETER_PX,
            sigma_px: None,
            local_linear: true,
        }
    }
}

impl FlattenConfig {
    /// The σ actually used.
    pub fn sigma(&self) -> f32 {
        self.sigma_px
            .unwrap_or(SIGMA_PER_DIAMETER * self.cell_diameter_px)
    }

    pub fn validate(&self) -> Result<(), PreprocessError> {
        let s = self.sigma();
        if !(self.cell_diameter_px.is_finite() && self.cell_diameter_px > 0.0)
            || !(s.is_finite() && s >= 0.5)
        {
            return Err(PreprocessError::InvalidConfig(format!(
                "flatten sigma must be >= 0.5 px (cell diameter {}, sigma {s})",
                self.cell_diameter_px
            )));
        }
        Ok(())
    }
}

/// Per-frame numbers from [`GlowFlattener::apply`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FlattenStats {
    /// Mean of the input inside the FOV (global brightness; flashes show here).
    pub input_mean: f32,
    /// Mean of the subtracted low-pass inside the FOV.
    pub lowpass_mean: f32,
}

/// Margin (pixels) of zero padding around the frame on the blur canvas, so
/// the first and second central differences are defined at the frame border.
const MARGIN: usize = 2;

/// The flattening stage for one frame size and FOV mask.
#[derive(Debug, Clone)]
pub struct GlowFlattener {
    dims: Dims,
    /// The blur canvas: the frame plus [`MARGIN`] on every side.
    canvas: Dims,
    sigma: f32,
    blur: RecursiveGaussian,
    /// The FOV mask on the canvas (0 in the margin).
    weight: Vec<f32>,
    /// The FOV mask on the frame.
    inside: Vec<f32>,
    /// Per frame pixel `[r0, r1·σ², r2·σ²]`: `low = r0 N + r1σ² ∂ₓN + r2σ² ∂ᵧN`
    /// (`r1 = r2 = 0` for order 0 and in the fallback); all 0 outside.
    coef: Vec<[f32; 3]>,
    /// Canvas input (the frame in the middle, zeros in the margin).
    input: Vec<f32>,
    /// `N = G_σ * (M·f)` on the canvas, from the last frame.
    n: Vec<f32>,
    area: usize,
}

/// Central differences along x and y of a canvas image (0 on its outer ring).
fn central(img: &[f64], c: Dims) -> (Vec<f64>, Vec<f64>) {
    let Dims {
        width: w,
        height: h,
    } = c;
    let mut dx = vec![0.0; img.len()];
    let mut dy = vec![0.0; img.len()];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            dx[i] = 0.5 * (img[i + 1] - img[i - 1]);
            dy[i] = 0.5 * (img[i + w] - img[i - w]);
        }
    }
    (dx, dy)
}

impl GlowFlattener {
    pub fn new(fov: &FovMask, cfg: &FlattenConfig) -> Result<GlowFlattener, PreprocessError> {
        cfg.validate()?;
        let dims = fov.dims();
        let canvas = Dims::new(dims.width + 2 * MARGIN, dims.height + 2 * MARGIN)?;
        let sigma = cfg.sigma();
        let mut blur = RecursiveGaussian::new(canvas, sigma)?;
        let inside = fov.weights();
        let mut weight = vec![0.0f32; canvas.pixels()];
        for y in 0..dims.height {
            let o = (y + MARGIN) * canvas.width + MARGIN;
            weight[o..o + dims.width]
                .copy_from_slice(&inside[y * dims.width..(y + 1) * dims.width]);
        }
        let mut norm = vec![0.0f32; canvas.pixels()];
        blur.blur(&weight, &mut norm)?;
        let m: Vec<f64> = norm.iter().map(|&v| f64::from(v)).collect();
        let s2 = f64::from(sigma) * f64::from(sigma);
        // Moments of the mask: S0 = M, Sx = σ² ∂ₓM, Sxx = σ⁴ ∂ₓ²M + σ² M, ...
        let (mx, my) = central(&m, canvas);
        let (mxx, mxy) = central(&mx, canvas);
        let (_, myy) = central(&my, canvas);
        let mut coef = vec![[0.0f32; 3]; dims.pixels()];
        for y in 0..dims.height {
            for x in 0..dims.width {
                let i = y * dims.width + x;
                let j = (y + MARGIN) * canvas.width + x + MARGIN;
                let s0 = m[j];
                if inside[i] <= 0.0 || s0 <= 1e-12 {
                    continue;
                }
                let order0 = [(1.0 / s0) as f32, 0.0, 0.0];
                if !cfg.local_linear {
                    coef[i] = order0;
                    continue;
                }
                let sx = s2 * mx[j];
                let sy = s2 * my[j];
                let sxx = s2 * s2 * mxx[j] + s2 * s0;
                let syy = s2 * s2 * myy[j] + s2 * s0;
                let sxy = s2 * s2 * mxy[j];
                let c00 = sxx * syy - sxy * sxy;
                let c01 = sy * sxy - sx * syy;
                let c02 = sx * sxy - sy * sxx;
                let det = s0 * c00 + sx * c01 + sy * c02;
                // Relative conditioning: det against the product of the diagonal.
                let scale = s0 * sxx.max(0.0) * syy.max(0.0);
                if !(det.is_finite() && det > 1e-3 * scale) || c00 <= 0.0 {
                    coef[i] = order0;
                    continue;
                }
                coef[i] = [
                    (c00 / det) as f32,
                    (c01 / det * s2) as f32,
                    (c02 / det * s2) as f32,
                ];
            }
        }
        Ok(GlowFlattener {
            dims,
            canvas,
            sigma,
            blur,
            weight,
            inside,
            coef,
            input: vec![0.0; canvas.pixels()],
            n: vec![0.0; canvas.pixels()],
            area: fov.area(),
        })
    }

    pub fn sigma(&self) -> f32 {
        self.sigma
    }

    /// Flatten `frame` in place (stateless: depends only on the frozen mask).
    pub fn apply(&mut self, frame: &mut [f32]) -> Result<FlattenStats, PreprocessError> {
        self.dims.check("frame", frame.len())?;
        let Dims {
            width: w,
            height: h,
        } = self.dims;
        let cw = self.canvas.width;
        for y in 0..h {
            let o = (y + MARGIN) * cw + MARGIN;
            self.input[o..o + w].copy_from_slice(&frame[y * w..(y + 1) * w]);
        }
        self.blur
            .blur_weighted(&self.input, &self.weight, &mut self.n)?;
        let mut sum_in = 0.0f64;
        let mut sum_low = 0.0f64;
        for y in 0..h {
            let o = (y + MARGIN) * cw + MARGIN;
            let up = &self.n[o - cw..o - cw + w];
            let dn = &self.n[o + cw..o + cw + w];
            let mid = &self.n[o - 1..o + w + 1];
            let fr = &mut frame[y * w..(y + 1) * w];
            let co = &self.coef[y * w..(y + 1) * w];
            let ins = &self.inside[y * w..(y + 1) * w];
            let (mut si, mut sl) = (0.0f32, 0.0f32);
            for x in 0..w {
                let c = co[x];
                let dx = 0.5 * (mid[x + 2] - mid[x]);
                let dy = 0.5 * (dn[x] - up[x]);
                let l = c[0] * mid[x + 1] + c[1] * dx + c[2] * dy;
                let m = ins[x];
                si += fr[x] * m;
                sl += l;
                fr[x] = (fr[x] - l) * m;
            }
            sum_in += f64::from(si);
            sum_low += f64::from(sl);
        }
        let n = self.area.max(1) as f64;
        Ok(FlattenStats {
            input_mean: (sum_in / n) as f32,
            lowpass_mean: (sum_low / n) as f32,
        })
    }

    /// The low-pass of the last frame (0 outside the FOV).
    pub fn lowpass(&self) -> Vec<f32> {
        let Dims {
            width: w,
            height: h,
        } = self.dims;
        let cw = self.canvas.width;
        let mut out = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let j = (y + MARGIN) * cw + x + MARGIN;
                let c = self.coef[i];
                let dx = 0.5 * (self.n[j + 1] - self.n[j - 1]);
                let dy = 0.5 * (self.n[j + cw] - self.n[j - cw]);
                out[i] = c[0] * self.n[j] + c[1] * dx + c[2] * dy;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preprocess::fov::FovConfig;

    /// Vignetted disk (a cone: centre 100, edge 10, outside 0; slope 1 px⁻¹
    /// like the steep CA1 vignette edge) plus small "cells".
    fn scene(w: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let c = (w as f32 - 1.0) / 2.0;
        let r = 0.45 * w as f32;
        let mut glow = vec![0.0f32; w * w];
        let mut cells = vec![0.0f32; w * w];
        for y in 0..w {
            for x in 0..w {
                let d = ((y as f32 - c).powi(2) + (x as f32 - c).powi(2)).sqrt();
                if d < r {
                    glow[y * w + x] = 10.0 + 90.0 * (1.0 - d / r);
                }
            }
        }
        for &(cy, cx) in &[
            (60.0f32, 60.0f32),
            (100.0, 140.0),
            (150.0, 80.0),
            (100.0, 30.0),
        ] {
            for y in 0..w {
                for x in 0..w {
                    let d2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                    cells[y * w + x] += 20.0 * (-d2 / (2.0 * 2.5 * 2.5)).exp();
                }
            }
        }
        let frame = glow.iter().zip(&cells).map(|(g, c)| g + c).collect();
        (frame, glow, cells)
    }

    /// Worst |residual| away from cells inside the FOV, and that within 2σ of
    /// the FOV edge.
    fn residuals(out: &[f32], cells: &[f32], fov: &FovMask, w: usize) -> (f32, f32) {
        let c = (w as f32 - 1.0) / 2.0;
        let r = 0.45 * w as f32;
        let (mut worst, mut edge) = (0.0f32, 0.0f32);
        for i in 0..w * w {
            if fov.contains(i) && cells[i] < 0.05 {
                let d = (((i / w) as f32 - c).powi(2) + ((i % w) as f32 - c).powi(2)).sqrt();
                worst = worst.max(out[i].abs());
                if d > r - 40.0 {
                    edge = edge.max(out[i].abs());
                }
            }
        }
        (worst, edge)
    }

    #[test]
    fn removes_vignette_without_edge_ring_and_keeps_cells() {
        let w = 200;
        let dims = Dims::new(w, w).unwrap();
        let (frame, glow, cells) = scene(w);
        let fcfg = FovConfig {
            rel_threshold: 0.05,
            open_radius: 0,
            ..FovConfig::default()
        };
        let fov = FovMask::from_mean(dims, &glow, &fcfg).unwrap();
        let run = |local_linear: bool| {
            let cfg = FlattenConfig {
                local_linear,
                ..FlattenConfig::default()
            };
            let mut fl = GlowFlattener::new(&fov, &cfg).unwrap();
            let mut out = frame.clone();
            fl.apply(&mut out).unwrap();
            // apply's output and the stored low-pass agree.
            let low = fl.lowpass();
            for i in (0..w * w).step_by(97) {
                if fov.contains(i) {
                    assert!((frame[i] - low[i] - out[i]).abs() < 1e-3);
                }
            }
            out
        };
        let out1 = run(true);
        let out0 = run(false);
        let (worst1, edge1) = residuals(&out1, &cells, &fov, w);
        let (_, edge0) = residuals(&out0, &cells, &fov, w);
        // The cone leaves its curvature term σ²/2·|∇²f| = 200·(90/r)/d, a few
        // levels away from the apex; at the edge order 0 adds slope·~0.8σ.
        assert!(
            edge1 < 5.0,
            "order-1 edge residual {edge1} (worst {worst1})"
        );
        assert!(
            edge0 > 2.0 * edge1,
            "edge: order 0 {edge0} vs order 1 {edge1}"
        );
        // Cell peaks survive (>= 85 %).
        for &(cy, cx) in &[(60usize, 60usize), (100, 140), (150, 80)] {
            let i = cy * w + cx;
            let base = (out1[i - 8 * w] + out1[i + 8 * w] + out1[i - 8] + out1[i + 8]) / 4.0;
            assert!(
                out1[i] - base > 0.85 * 20.0,
                "cell at {cy},{cx}: {}",
                out1[i] - base
            );
        }

        // A naive (un-normalized) blur sags at the edge: a bright ring.
        let mut g = RecursiveGaussian::new(dims, 20.0).unwrap();
        let mut low = vec![0.0; w * w];
        let mut lifted = frame.clone();
        for (v, &m) in lifted.iter_mut().zip(fov.mask()) {
            *v += 40.0 * f32::from(m); // a brighter edge, like a 1p glow on top
        }
        g.blur(&lifted, &mut low).unwrap();
        let naive: Vec<f32> = lifted.iter().zip(&low).map(|(f, l)| f - l).collect();
        let (_, edge_naive) = residuals(&naive, &cells, &fov, w);
        assert!(edge_naive > 4.0 * edge1, "naive {edge_naive} vs {edge1}");
    }

    #[test]
    fn linear_ramp_is_removed_exactly_up_to_the_edge() {
        // A plane inside an off-centre mask clipped by the frame: order 1
        // reproduces it everywhere (order 0 only in the interior).
        let (w, h) = (120usize, 90usize);
        let dims = Dims::new(w, h).unwrap();
        let mut mask = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((y as f32 - 40.0).powi(2) + (x as f32 - 70.0).powi(2)).sqrt();
                mask[y * w + x] = u8::from(d < 55.0);
            }
        }
        let fov = FovMask::from_mask(dims, &mask).unwrap();
        let ramp: Vec<f32> = (0..w * h)
            .map(|i| 50.0 + 0.4 * (i % w) as f32 - 0.3 * (i / w) as f32)
            .collect();
        let mut out = ramp.clone();
        GlowFlattener::new(&fov, &FlattenConfig::default())
            .unwrap()
            .apply(&mut out)
            .unwrap();
        let worst = out.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!(worst < 1.5, "order-1 ramp residual {worst}");
    }

    #[test]
    fn outside_fov_is_zero_and_config_checked() {
        let dims = Dims::new(30, 30).unwrap();
        let mut mask = vec![0u8; 900];
        mask[300..600].fill(1);
        let fov = FovMask::from_mask(dims, &mask).unwrap();
        for local_linear in [false, true] {
            let cfg = FlattenConfig {
                local_linear,
                ..FlattenConfig::default()
            };
            let mut fl = GlowFlattener::new(&fov, &cfg).unwrap();
            let mut f = vec![50.0f32; 900];
            let st = fl.apply(&mut f).unwrap();
            assert!((st.input_mean - 50.0).abs() < 1e-3);
            assert!(f[..300].iter().all(|&v| v == 0.0));
            assert!(
                f[300..600].iter().all(|&v| v.abs() < 1e-3),
                "{:?}",
                &f[300..304]
            );
        }
        let bad = FlattenConfig {
            cell_diameter_px: 0.0,
            ..FlattenConfig::default()
        };
        assert!(GlowFlattener::new(&fov, &bad).is_err());
        let mut fl = GlowFlattener::new(&fov, &FlattenConfig::default()).unwrap();
        assert!(fl.apply(&mut [0.0; 5]).is_err());
        // One-pixel frames.
        let d1 = Dims::new(1, 1).unwrap();
        let mut fl = GlowFlattener::new(&FovMask::full(d1), &FlattenConfig::default()).unwrap();
        let mut f = [7.0f32];
        fl.apply(&mut f).unwrap();
        assert!(f[0].abs() < 1e-3);
    }
}
