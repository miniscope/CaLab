//! Statistics of one trace window (pure functions, chronological samples).
//!
//! The noise and SNR definitions follow CaLab's shipped convention
//! (`crates/solver/src/snr.rs`): σ is the MAD of frame-to-frame differences
//! over 0.6745 · √2, and the peak SNR is (mean of the top 1 % − median) / σ.
//! The window is short (one minute by default), so the slow detrending of the
//! shipped metric is not needed. One change for fast-loop traces: they are
//! non-negative, and a silent cell sits at exactly zero for long stretches,
//! where every difference is zero and the plain MAD collapses. Pairs of
//! consecutive zeros carry no noise information and are left out.

/// Gaussian consistency constant Φ⁻¹(0.75).
const MAD_GAUSSIAN: f32 = 0.674_489_75;

/// Statistics of a trace window. NaN where a value is undefined (no events,
/// too few samples).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TraceStats {
    /// MAD-of-differences noise σ (trace units).
    pub sigma: f32,
    /// Median.
    pub baseline: f32,
    /// (mean of the top 1 % − median) / σ.
    pub peak_snr: f32,
    /// Number of events (excursions above `event_z` σ).
    pub events: u32,
    /// Median frames from half height to 80 % of the peak, over events.
    pub rise_frames: f32,
    /// Median frames from 80 % of the peak back down to half height.
    pub decay_frames: f32,
    /// Median of per-event decay / rise (calcium: fast rise, slow decay, so
    /// well above 1; a symmetric hump reads about 1).
    pub asymmetry: f32,
    /// Median full width at half height of events, frames.
    pub width_frames: f32,
    /// Skewness of the first difference (calcium: a few large positive
    /// steps, many small negative ones, so positive).
    pub diff_skew: f32,
    /// Fraction of samples at (numerically) zero.
    pub zero_frac: f32,
    /// Fraction of the trace's variance above noise in a slow moving average
    /// (`slow_frames` wide).
    pub slow_frac: f32,
}

impl TraceStats {
    pub const NAN: TraceStats = TraceStats {
        sigma: f32::NAN,
        baseline: f32::NAN,
        peak_snr: f32::NAN,
        events: 0,
        rise_frames: f32::NAN,
        decay_frames: f32::NAN,
        asymmetry: f32::NAN,
        width_frames: f32::NAN,
        diff_skew: f32::NAN,
        zero_frac: f32::NAN,
        slow_frac: f32::NAN,
    };
}

/// Median of `v` (reordered in place); NaN when empty.
pub(crate) fn median_inplace(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return f32::NAN;
    }
    let k = v.len() / 2;
    let (_, m, _) = v.select_nth_unstable_by(k, f32::total_cmp);
    *m
}

/// MAD-of-differences σ with zero-zero pairs left out; `scratch` is resized.
pub(crate) fn sigma_mad_diff(x: &[f32], zero: f32, scratch: &mut Vec<f32>) -> f32 {
    scratch.clear();
    for w in x.windows(2) {
        if w[0] <= zero && w[1] <= zero {
            continue;
        }
        scratch.push((w[1] - w[0]).abs());
    }
    if scratch.len() < 8 {
        return f32::NAN;
    }
    median_inplace(scratch) / MAD_GAUSSIAN / std::f32::consts::SQRT_2
}

/// Statistics of `x`. `zero_tol` is the level counted as zero (a small
/// fraction of the model noise σ); `fallback_sigma` is used when the window
/// is too flat to measure σ.
pub fn trace_stats(
    x: &[f32],
    event_z: f32,
    slow_frames: usize,
    zero_tol: f32,
    fallback_sigma: f32,
    scratch: &mut Vec<f32>,
) -> TraceStats {
    let n = x.len();
    if n < 16 {
        return TraceStats::NAN;
    }
    let mut out = TraceStats::NAN;
    let zeros = x.iter().filter(|&&v| v <= zero_tol).count();
    out.zero_frac = zeros as f32 / n as f32;
    let mut sigma = sigma_mad_diff(x, zero_tol, scratch);
    if !(sigma > 0.0) {
        sigma = fallback_sigma;
    }
    out.sigma = sigma;
    scratch.clear();
    scratch.extend_from_slice(x);
    let med = median_inplace(scratch);
    out.baseline = med;
    // Top 1 % (at least 3 samples).
    let top = (n / 100).max(3).min(n);
    scratch.select_nth_unstable_by(n - top, f32::total_cmp);
    let top_sum: f64 = scratch[n - top..].iter().map(|&v| f64::from(v)).sum();
    let top_mean = (top_sum / top as f64) as f32;
    out.peak_snr = if sigma > 0.0 {
        (top_mean - med) / sigma
    } else {
        f32::NAN
    };

    // Skewness of the differences.
    {
        let m = (n - 1) as f64;
        let mean: f64 = x.windows(2).map(|w| f64::from(w[1] - w[0])).sum::<f64>() / m;
        let (mut s2, mut s3) = (0.0f64, 0.0f64);
        for w in x.windows(2) {
            let d = f64::from(w[1] - w[0]) - mean;
            s2 += d * d;
            s3 += d * d * d;
        }
        s2 /= m;
        s3 /= m;
        out.diff_skew = if s2 > 0.0 {
            (s3 / s2.powf(1.5)) as f32
        } else {
            f32::NAN
        };
    }

    // Slow share: variance of a centred moving average over the variance,
    // both above the noise floor the average keeps (σ² / width).
    if sigma > 0.0 && slow_frames >= 3 && n > 2 * slow_frames {
        let w = slow_frames;
        let mean: f64 = x.iter().map(|&v| f64::from(v)).sum::<f64>() / n as f64;
        let var: f64 = x
            .iter()
            .map(|&v| (f64::from(v) - mean).powi(2))
            .sum::<f64>()
            / n as f64;
        let mut acc: f64 = x[..w].iter().map(|&v| f64::from(v)).sum();
        let (mut sm, mut sm2, mut cnt) = (0.0f64, 0.0f64, 0usize);
        for k in w..=n {
            let a = acc / w as f64;
            sm += a;
            sm2 += a * a;
            cnt += 1;
            if k < n {
                acc += f64::from(x[k]) - f64::from(x[k - w]);
            }
        }
        let ms = sm / cnt as f64;
        let var_s = sm2 / cnt as f64 - ms * ms;
        let s2 = f64::from(sigma) * f64::from(sigma);
        let sig_total = var - s2;
        let sig_slow = var_s - s2 / w as f64;
        out.slow_frac = if sig_total > 0.0 {
            (sig_slow / sig_total).clamp(0.0, 1.0) as f32
        } else {
            f32::NAN
        };
    }

    // Events: maximal runs of the 3-frame running mean above med + 2σ whose
    // raw peak reaches med + event_z σ. Per event, the half-height crossings
    // of the running mean around the peak give rise, decay and width
    // (bounded by the run, so overlapping transients split there). The
    // running mean keeps single noisy samples from cutting a slow event.
    if sigma > 0.0 {
        let mut sm = Vec::with_capacity(n);
        sm.push(x[0]);
        for k in 1..n - 1 {
            sm.push((x[k - 1] + x[k] + x[k + 1]) / 3.0);
        }
        sm.push(x[n - 1]);
        let lo = med + 2.0 * sigma;
        let on = med + event_z * sigma;
        let (mut rises, mut decays, mut asyms, mut widths) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut k = 0;
        let mut events = 0u32;
        while k < n {
            if sm[k] <= lo {
                k += 1;
                continue;
            }
            let start = k;
            while k < n && sm[k] > lo {
                k += 1;
            }
            let end = k; // exclusive
            let peak = x[start..end].iter().copied().fold(f32::MIN, f32::max);
            if peak <= on {
                continue;
            }
            events += 1;
            // Shape on the running mean: half-height crossings around its
            // peak; rise = half height to the first sample at 80 %, decay =
            // last sample at 80 % back to half height (the 80 % plateau keeps
            // the argmax of a flat-topped hump from deciding its symmetry).
            let (p, peak_s) = sm[start..end]
                .iter()
                .enumerate()
                .fold((0, f32::MIN), |b, (i, &v)| if v > b.1 { (i, v) } else { b });
            let p = start + p;
            let half = med + 0.5 * (peak_s - med);
            let top = med + 0.8 * (peak_s - med);
            let mut l = p;
            while l > start && sm[l - 1] >= half {
                l -= 1;
            }
            let mut r = p;
            while r + 1 < end && sm[r + 1] >= half {
                r += 1;
            }
            // Events cut by the window edge have unknown shape.
            if start == 0 || end == n {
                continue;
            }
            let a = (l..=r).find(|&k| sm[k] >= top).unwrap_or(p);
            let b = (l..=r).rev().find(|&k| sm[k] >= top).unwrap_or(p);
            let rise = (a - l) as f32 + 0.5;
            let decay = (r - b) as f32 + 0.5;
            rises.push(rise);
            decays.push(decay);
            asyms.push(decay / rise);
            widths.push((r - l + 1) as f32);
        }
        out.events = events;
        out.rise_frames = median_inplace(&mut rises);
        out.decay_frames = median_inplace(&mut decays);
        out.asymmetry = median_inplace(&mut asyms);
        out.width_frames = median_inplace(&mut widths);
    }
    out
}

/// Pearson correlation; NaN when either side is constant.
pub(crate) fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n < 3 {
        return f32::NAN;
    }
    let (a, b) = (&a[..n], &b[..n]);
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n as f64;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n as f64;
    let (mut sab, mut saa, mut sbb) = (0.0f64, 0.0f64, 0.0f64);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        f32::NAN
    } else {
        (sab / (saa * sbb).sqrt()) as f32
    }
}
