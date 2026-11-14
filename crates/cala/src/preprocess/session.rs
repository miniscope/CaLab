//! Session boundaries: carrying the preprocessing state into a new session.
//!
//! When sessions of one animal run as one recording (a Joint run), the
//! light can step at the boundary (the LED or focus was set again). The
//! stateful stages read a step as a slow change and take seconds to minutes
//! to follow it. Measured on stitched sims
//! (`tools/cala-eval/results/2026-11-13-session-boundary.md`): a ×1.25 step
//! lifts every cell's baseline by ~5 % of its peak for ~150 frames, mostly
//! because the background floor (a running minimum) drops at once but rises
//! with τ = 120 s; the flicker reference holds the step for ~1 s first; the
//! noise map needs ~800 frames to follow.
//!
//! The fixes here run once, at the session's first frame, and never within
//! a session:
//!
//! * **Flicker** ([`super::Preprocessor::begin_session_front`]): the
//!   reference is re-seated on the new session's frames, as at the start of
//!   a recording, so the step is not read as flicker and released over 1 s.
//! * **Background floor** ([`fit_gain_offset`],
//!   [`super::background::RunningMinBackground::rescale`]): a gain and offset
//!   fitted between the new session's first frames and the floor's own
//!   boxcar of the previous session's last frames (robust: active pixels
//!   drop out) map the old floor into the new session's brightness. A cold
//!   reset would also remove the bump (measured: +5.1 % → +1.4 %) but warms
//!   up on frames that hold activity and dips by ~1 %; a rescaled floor
//!   keeps everything the old one had learned.
//! * **Noise map** ([`noise_ratio`], [`super::noise::NoiseMap::rescale`]):
//!   the new session's frame-to-frame differences, in units of the old map,
//!   give one robust ratio that scales the whole map. The map keeps its
//!   per-pixel detail and its tracker follows any spatial change from there.

use super::stats::{quantile_in_place, MAD_GAUSSIAN};

/// A robust straight-line fit `y ≈ gain · x + offset`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GainOffset {
    pub gain: f32,
    pub offset: f32,
    /// Pixels fitted, and the share kept by the trimming.
    pub pixels: usize,
    pub kept_fraction: f32,
}

impl GainOffset {
    pub const IDENTITY: GainOffset = GainOffset {
        gain: 1.0,
        offset: 0.0,
        pixels: 0,
        kept_fraction: 0.0,
    };
}

/// Rounds of trimming in [`fit_gain_offset`].
const FIT_ROUNDS: usize = 6;
/// Residuals beyond this many robust σ are dropped.
const CLIP_SIGMA: f32 = 2.5;
/// Fewer pixels than this: no fit (identity).
const MIN_PIXELS: usize = 100;

/// Fit `y = g x + o` over the pairs where both are finite, by trimmed least
/// squares: start from `g = 1` and the median offset, then refit on the
/// pairs whose residual is within [`CLIP_SIGMA`] robust σ (MAD), for
/// [`FIT_ROUNDS`] rounds. Pixels of cells that were active on one side
/// only are large residuals and drop out, so the fit follows the static
/// tissue. Falls back to the identity on too few pixels or a degenerate
/// spread.
///
/// `x_var` is the noise variance of each `x` (`None`: noise-free). Noise in
/// `x` biases a least-squares slope towards 0 by `var(x) / (var(x) +
/// noise)` (regression dilution); after flattening the tissue texture is
/// not much larger than the noise of a few frames' mean, so the bias is
/// large (×1.25 read as ×1.15 on the stitched sims with a 5-frame `x`). The
/// fit subtracts the kept pixels' noise variance from the spread of `x`.
pub fn fit_gain_offset(x: &[f32], y: &[f32], x_var: Option<&[f32]>) -> GainOffset {
    let pairs: Vec<(f32, f32, f32)> = x
        .iter()
        .zip(y)
        .enumerate()
        .filter(|(_, (a, b))| a.is_finite() && b.is_finite())
        .map(|(i, (&a, &b))| {
            let v = x_var.map_or(0.0, |v| v[i]);
            (a, b, if v.is_finite() && v > 0.0 { v } else { 0.0 })
        })
        .collect();
    let n = pairs.len();
    if n < MIN_PIXELS {
        return GainOffset::IDENTITY;
    }
    let mut resid: Vec<f32> = pairs.iter().map(|&(a, b, _)| b - a).collect();
    let mut g = 1.0f64;
    let mut o = f64::from(quantile_in_place(&mut resid, 0.5).unwrap_or(0.0));
    let mut kept = n;
    for _ in 0..FIT_ROUNDS {
        resid.clear();
        resid.extend(
            pairs
                .iter()
                .map(|&(a, b, _)| (f64::from(b) - g * f64::from(a) - o).abs() as f32),
        );
        let mad = quantile_in_place(&mut resid, 0.5).unwrap_or(0.0) / MAD_GAUSSIAN;
        let lim = f64::from(CLIP_SIGMA * mad.max(f32::MIN_POSITIVE));
        let (mut sx, mut sy, mut sxx, mut sxy, mut sv) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut k = 0usize;
        for &(a, b, v) in &pairs {
            let (a, b) = (f64::from(a), f64::from(b));
            if (b - g * a - o).abs() <= lim {
                sx += a;
                sy += b;
                sxx += a * a;
                sxy += a * b;
                sv += f64::from(v);
                k += 1;
            }
        }
        if k < MIN_PIXELS {
            break;
        }
        let kf = k as f64;
        let spread = sxx - sx * sx / kf;
        // The noise share is capped so a texture-free frame cannot blow the
        // slope up.
        let var = spread - sv.min(0.8 * spread);
        if var.is_nan() || var <= 0.0 {
            break;
        }
        g = (sxy - sx * sy / kf) / var;
        o = (sy - g * sx) / kf;
        kept = k;
    }
    if !(g.is_finite() && o.is_finite() && g > 0.0) {
        return GainOffset::IDENTITY;
    }
    GainOffset {
        gain: g as f32,
        offset: o as f32,
        pixels: n,
        kept_fraction: kept as f32 / n as f32,
    }
}

/// Per-pixel mean of `count` frames over their valid samples (`valid`:
/// `count` masks, nonzero = data; `None`: every finite sample). NaN where a
/// pixel has none.
pub fn valid_mean(frames: &[f32], valid: Option<&[u8]>, px: usize) -> Vec<f32> {
    let mut sum = vec![0.0f64; px];
    let mut cnt = vec![0u32; px];
    for (k, f) in frames.chunks_exact(px).enumerate() {
        let m = valid.map(|v| &v[k * px..(k + 1) * px]);
        for i in 0..px {
            let v = f[i];
            if v.is_finite() && m.is_none_or(|m| m[i] != 0) {
                sum[i] += f64::from(v);
                cnt[i] += 1;
            }
        }
    }
    sum.iter()
        .zip(&cnt)
        .map(|(&s, &c)| {
            if c > 0 {
                (s / f64::from(c)) as f32
            } else {
                f32::NAN
            }
        })
        .collect()
}

/// The ratio of the noise in `frames` to the noise map `sigma`: the median
/// over every pixel and consecutive pair of valid samples of `|Δ| / σ`,
/// divided by its value for Gaussian noise (`√2 · Φ⁻¹(0.75)`). Robust to
/// transients (a few large differences). `None` without enough samples.
pub fn noise_ratio(frames: &[f32], valid: Option<&[u8]>, sigma: &[f32], px: usize) -> Option<f32> {
    let count = frames.len() / px.max(1);
    if count < 2 {
        return None;
    }
    let mut z = Vec::new();
    for k in 1..count {
        let (a, b) = (&frames[(k - 1) * px..k * px], &frames[k * px..(k + 1) * px]);
        let ok = |j: usize, i: usize| valid.is_none_or(|v| v[j * px + i] != 0);
        for i in 0..px {
            let s = sigma[i];
            if s > 0.0
                && s.is_finite()
                && a[i].is_finite()
                && b[i].is_finite()
                && ok(k - 1, i)
                && ok(k, i)
            {
                z.push((b[i] - a[i]).abs() / s);
            }
        }
    }
    if z.len() < MIN_PIXELS {
        return None;
    }
    let med = quantile_in_place(&mut z, 0.5)?;
    let r = med / (MAD_GAUSSIAN * std::f32::consts::SQRT_2);
    (r.is_finite() && r > 0.0).then_some(r)
}

/// What [`super::Preprocessor::begin_session_back`] did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionBackFit {
    /// The background floor's map (identity when not rescaled).
    pub floor: GainOffset,
    /// Factor applied to the noise map (1 when not rescaled).
    pub noise_ratio: f32,
}

/// Which back-half fixes run at a session boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionBackConfig {
    pub rescale_floor: bool,
    pub rescale_noise: bool,
}

impl Default for SessionBackConfig {
    fn default() -> Self {
        SessionBackConfig {
            rescale_floor: true,
            rescale_noise: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_ignores_active_pixels() {
        let n = 5000;
        let x: Vec<f32> = (0..n)
            .map(|i| ((i * 37) % 101) as f32 / 10.0 - 5.0)
            .collect();
        let mut y: Vec<f32> = x.iter().map(|&v| 1.25 * v + 0.3).collect();
        // 10 % active on one side only.
        for v in y.iter_mut().step_by(10) {
            *v += 20.0;
        }
        let f = fit_gain_offset(&x, &y, None);
        assert!((f.gain - 1.25).abs() < 1e-3, "{f:?}");
        assert!((f.offset - 0.3).abs() < 1e-3, "{f:?}");
        assert!(f.kept_fraction > 0.85 && f.kept_fraction < 0.95, "{f:?}");
        assert_eq!(
            fit_gain_offset(&x[..10], &y[..10], None),
            GainOffset::IDENTITY
        );
    }

    #[test]
    fn fit_corrects_for_noise_in_x() {
        let n = 40_000;
        let mut s = 9u64;
        let mut normal = || {
            let mut u = || {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64
            };
            let (a, b) = (u(), u());
            ((-2.0 * a.ln()).sqrt() * (2.0 * std::f64::consts::PI * b).cos()) as f32
        };
        let tex: Vec<f32> = (0..n).map(|_| normal()).collect();
        // x: texture plus noise of 0.4 of its σ (as a 5-frame boxcar after
        // flattening on the sims); y = 1.25 · texture.
        let x: Vec<f32> = tex.iter().map(|&t| t + 0.4 * normal()).collect();
        let y: Vec<f32> = tex.iter().map(|&t| 1.25 * t + 0.3 * normal()).collect();
        let naive = fit_gain_offset(&x, &y, None);
        assert!(naive.gain < 1.12, "{naive:?}");
        let var = vec![0.16f32; n];
        let f = fit_gain_offset(&x, &y, Some(&var));
        assert!((f.gain - 1.25).abs() < 0.03, "{f:?}");
    }

    #[test]
    fn noise_ratio_reads_the_new_noise() {
        let px = 4000;
        let mut s = 1u64;
        let mut normal = || {
            let mut u = || {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64
            };
            let (a, b) = (u(), u());
            ((-2.0 * a.ln()).sqrt() * (2.0 * std::f64::consts::PI * b).cos()) as f32
        };
        let frames: Vec<f32> = (0..8 * px).map(|_| 2.5 * normal()).collect();
        let sigma = vec![2.0f32; px];
        let r = noise_ratio(&frames, None, &sigma, px).unwrap();
        assert!((r - 1.25).abs() < 0.03, "{r}");
        assert!(noise_ratio(&frames[..px], None, &sigma, px).is_none());
    }
}
