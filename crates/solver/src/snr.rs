//! Robust noise and SNR metrics for calcium-imaging traces.
//!
//! The noise estimator and the SNR definition follow Krisha Aghi's derivation
//! ("Signal-to-Noise Ratio Derivation for Calcium Imaging Data", Aharoni lab,
//! April 2026), which builds on the frame-rate-normalised noise level of
//! Rupprecht et al. (2021, CASCADE, Nat. Neurosci. 24:1324):
//!
//! - **Noise σ** ([`noise_sigma_mad_diff`]): the median absolute frame-to-frame
//!   difference, divided by the Gaussian consistency constant Φ⁻¹(0.75) ≈ 0.6745
//!   and by √2 (the difference of two iid samples has variance 2σ²).
//!   Differencing removes slow signal and baseline, and the median ignores the
//!   few large differences at transient onsets.
//! - **Noise level ν** ([`noise_level_nu`]): CASCADE's
//!   `median|ΔF/F_{t+1} − ΔF/F_t| / √fs`. Shot-noise-limited per-frame noise
//!   grows as √fs, so ν compares recordings across frame rates. With ΔF/F in
//!   percent, ν ≈ 1 %·Hz^-½ is a very good recording, ≈ 2–4 typical, ≈ 8
//!   large-scale population imaging (Rupprecht et al. 2021).
//! - **Peak SNR** ([`peak_snr`], [`measured_snr`]): `(mean of the top slice of
//!   the trace − median) / σ`. The top slice is a *fraction* of the samples
//!   ([`DEFAULT_TOP_FRACTION`] = 1 %) rather than Krisha's fixed N = 10: a
//!   fixed count is a different quantile of a 5-minute 30 Hz trace than of a
//!   30-minute 60 Hz trace, and in simulation the N = 10 version rose 35–90 %
//!   from 5 to 30 minutes of the same cell, while the 1 % version moved < 7 %.
//!
//! ## Slow drift is removed before the signal is read
//!
//! The signal side (top slice minus median) is computed on the trace minus a
//! slow baseline, a centred rolling 20th percentile over [`DETREND_WINDOW_S`]
//! (60 s; rationale on the constant). Without it, photobleaching of a few
//! percent of F0 moves the top 1 % away from the median and a silent cell
//! measures well above the noise floor: pure noise (σ = 0.01 F0, 30 minutes
//! at 30 Hz) with a 5 % F0 linear drift read 4.18 and with an exponential
//! bleach 3.33, against 2.67 without drift; detrended, both read 2.67
//! (2.63-2.71 over 30 seeds). The noise σ is a median of frame-to-frame
//! differences and needs no such correction. The functions therefore take the
//! frame rate `fs`; an invalid `fs` (not positive and finite) skips the
//! detrending. The simulator's measured-SNR calibration applies the same
//! detrending, so simulated and measured SNR keep one definition.
//!
//! ## What the measured SNR means, and the assumption behind it
//!
//! The signal side is burst-based: it reads the strongest transients, as a
//! person would off a plot, because on real data a single action potential
//! usually sits inside the noise and cannot be measured. So the number is a
//! **comparison across cells that share a burst-size distribution** (cells of
//! one type in one dataset), not an absolute per-spike quantity. At the same
//! per-spike noise, a cell that fires larger bursts measures higher and a
//! sparsely firing cell measures lower; that shift is real and appears on real
//! data exactly as in the simulator. Nothing here estimates per-spike SNR.
//!
//! ## The noise floor of the metric, and the silent flag
//!
//! Pure white noise does not measure 0: the top 1 % of N(0, 1) averages
//! φ(z₀.₉₉)/0.01 ≈ 2.67 above the median. Measured on pure Gaussian noise
//! (40 traces per length, median and 5–95 % range), without drift and with a
//! 5 % of F0 linear or exponential drift (noise σ = 1 % of F0) over the trace:
//!
//! | trace | samples | no drift | linear drift | exponential drift |
//! |---|---|---|---|---|
//! | 1 min at 30 Hz | 1 800 | 2.73 (2.52–2.89) | not detrended (shorter than the window) | not detrended |
//! | 5 min at 30 Hz | 9 000 | 2.66 (2.59–2.76) | 2.68 (2.60–2.78) | 2.68 (2.61–2.78) |
//! | 10 min at 30 Hz | 18 000 | 2.66 (2.61–2.74) | 2.67 (2.61–2.74) | 2.67 (2.61–2.74) |
//! | 30 min at 30 Hz | 54 000 | 2.66 (2.64–2.70) | 2.66 (2.64–2.70) | 2.66 (2.64–2.70) |
//! | 30 min at 60 Hz | 108 000 | 2.67 (2.64–2.68) | 2.67 (2.64–2.68) | 2.67 (2.64–2.68) |
//!
//! (Without the detrending the same 30-minute drifts read 4.18 and 3.33.)
//!
//! So values near 2.7 mean "indistinguishable from noise" and no trace
//! measures below about 2.5 (real, correlated noise can read a little higher).
//! The SNR value itself stays the top-slice number everywhere; the explicit
//! answer to "is anything there?" is [`SnrReport::is_silent`] from
//! [`measured_snr_report`], true when [`detect_events`] finds no event above
//! its noise-derived floor. Use it rather than a threshold on the SNR.
//!
//! At the top, a very clean trace whose own frame-to-frame changes dominate
//! the MAD-diff σ has a finite ceiling (e.g. jGCaMP8f firing at 1.9 Hz at
//! 30 Hz tops out near 25–30).
//!
//! The simulator's default noise convention
//! (`simulate::NoiseReference::MeasuredSnr`) targets [`measured_snr`], so a
//! trace simulated at SNR X measures X with this function. The solver's own
//! noise budget does not use this module; it uses the high-band periodogram
//! estimator `indeca::high_band_sigma`.

/// Φ⁻¹(0.75): the MAD of a standard normal.
pub const MAD_GAUSSIAN: f64 = 0.674_489_750_196_081_7;

/// Default top slice for [`peak_snr`]: the top 1 % of samples.
///
/// A fraction keeps the statistic a fixed quantile of the recording, so it is
/// stable across trace length (5–30 min) and frame rate for a cell with
/// stationary firing. 1 % is ~3 s of a 5-minute recording and ~18 s of a
/// 30-minute one: large enough to average over several transients and the
/// noise on them, small enough to stay on the transients of a cell that is
/// active a few percent of the time.
pub const DEFAULT_TOP_FRACTION: f64 = 0.01;

/// Quantile of the slow-baseline estimate subtracted before the top slice is
/// read (see [`DETREND_WINDOW_S`]). 20 %, the same floor quantile the solver's
/// own rolling baseline uses (`baseline::DEFAULT_BASELINE_QUANTILE`): low
/// enough to track the floor under sparse transients, high enough to be a
/// stable order statistic of the noise.
pub const DETREND_QUANTILE: f64 = 0.2;

/// Window (seconds) of the rolling low quantile that removes slow drift
/// (photobleaching, focus and illumination wander) from the trace before the
/// top slice is read.
///
/// 60 s is chosen against two scales, using no kernel or indicator model:
///
/// - **Long against transients.** A low quantile (20 %) only follows the floor
///   if the trace is at its floor for more than 20 % of the window. The slowest
///   indicators decay in 1–2 s (GCaMP6s, OGB-1), so a window of 30–60 decay
///   times keeps the quantile on the floor even in a burst-dense stretch.
///   Measured on simulated 30-minute traces (all presets, Poisson 0.3 and
///   1.9 Hz and bursting firing, 5 % of F0 drift removed by the detrend): the
///   detrended signal is within 2 % of the undetrended one at 60 s, but loses
///   up to 6 % at 30 s and 13 % at 15 s on the slowest indicators at 1.9 Hz,
///   where the tails of one transient lift the floor under the next. 120 s is no
///   better than 60 s. It also matches the solver's own rolling baseline
///   (`baseline::baseline_window`, 25 decay times = 25–50 s for these kernels).
/// - **Short against drift.** Photobleaching and focus/illumination wander
///   change over minutes to the whole recording (a 5 % drop over 30 minutes is
///   0.17 % per minute), and the centred window follows a linear or
///   exponential trend with no measurable residual (tested to 5 % of F0 over
///   30 minutes).
///
/// Traces shorter than the window are not detrended: a one-minute trace has
/// no drift worth removing, and a global quantile is just a constant.
pub const DETREND_WINDOW_S: f64 = 60.0;

pub(crate) fn finite_f64(trace: &[f32]) -> Vec<f64> {
    trace
        .iter()
        .filter(|v| v.is_finite())
        .map(|&v| v as f64)
        .collect()
}

/// Median of a slice (reorders it). Empty input returns 0.
pub(crate) fn median_in_place(v: &mut [f64]) -> f64 {
    let n = v.len();
    if n == 0 {
        return 0.0;
    }
    let mid = n / 2;
    let (lo, m, _) = v.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    let upper = *m;
    if n % 2 == 1 {
        upper
    } else {
        let lower = lo.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        0.5 * (lower + upper)
    }
}

/// Median of |x[t+1] − x[t]| over consecutive samples.
pub(crate) fn median_abs_diff(x: &[f64]) -> f64 {
    if x.len() < 2 {
        return 0.0;
    }
    let mut d: Vec<f64> = x.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
    median_in_place(&mut d)
}

/// Noise standard deviation from the MAD of first differences
/// (Krisha Aghi's estimator): `median|Δx| / (0.6745·√2)`.
///
/// Unbiased for white Gaussian noise. It overestimates σ when the signal
/// itself changes by more than ~σ between many pairs of frames (fast rises at
/// low frame rates on very clean, very active traces); in the simulated
/// presets the bias is ≤ 6 % (≤ 12 % for bursting cells at 30 Hz) while the
/// single-spike SNR is ≤ 4, and grows to
/// 1.1–1.6× at single-spike SNR 16. Non-finite samples are dropped; fewer than
/// two finite samples return 0.
pub fn noise_sigma_mad_diff(trace: &[f32]) -> f64 {
    let x = finite_f64(trace);
    median_abs_diff(&x) / (MAD_GAUSSIAN * std::f64::consts::SQRT_2)
}

/// CASCADE noise level ν = `median|Δ(ΔF/F)| / √fs` (Rupprecht et al. 2021).
///
/// `trace_dff` must be ΔF/F; pass it in percent to get ν in the units CASCADE
/// reports (%·Hz^-½). For white noise, σ_frame = ν·√fs / (0.6745·√2).
/// Returns 0 for `fs <= 0` or fewer than two finite samples.
pub fn noise_level_nu(trace_dff: &[f32], fs: f64) -> f64 {
    if !fs.is_finite() || fs <= 0.0 {
        return 0.0;
    }
    let x = finite_f64(trace_dff);
    median_abs_diff(&x) / fs.sqrt()
}

/// Robust signal amplitude: mean of the top `top_fraction` of samples minus the
/// median, read on the trace minus its slow baseline (see
/// [`DETREND_WINDOW_S`]; `fs` is the frame rate in Hz, and an invalid `fs`
/// skips the detrending). The top slice holds `max(1, round(top_fraction·n))`
/// samples.
pub fn robust_signal(trace: &[f32], top_fraction: f64, fs: f64) -> f64 {
    let x = finite_f64(trace);
    robust_signal_f64(&x, top_fraction, fs)
}

/// The trace minus its slow baseline: a centred rolling [`DETREND_QUANTILE`]
/// over [`DETREND_WINDOW_S`] seconds. `None` (use the trace as is) when `fs`
/// is not a positive finite rate or the window covers the whole trace (a
/// global quantile is a constant, which the median subtraction removes anyway).
fn detrend_f64(x: &[f64], fs: f64) -> Option<Vec<f64>> {
    detrend_with(x, fs, DETREND_WINDOW_S, DETREND_QUANTILE)
}

pub(crate) fn detrend_with(x: &[f64], fs: f64, window_s: f64, quantile: f64) -> Option<Vec<f64>> {
    if !fs.is_finite() || fs <= 0.0 || !window_s.is_finite() || window_s <= 0.0 {
        return None;
    }
    let n = x.len();
    let w = (window_s * fs).round() as usize;
    if w < 2 || w >= n {
        return None;
    }
    let x32: Vec<f32> = x.iter().map(|&v| v as f32).collect();
    let mut rq = crate::baseline::RollingQuantile::new();
    let causal = rq.baselines(&x32, w, quantile);
    // Centre the causal window: baseline at t is the window ending at t + w/2.
    let half = w / 2;
    Some(
        x.iter()
            .enumerate()
            .map(|(t, &v)| v - causal[(t + half).min(n - 1)] as f64)
            .collect(),
    )
}

pub(crate) fn robust_signal_f64(x: &[f64], top_fraction: f64, fs: f64) -> f64 {
    let detrended = detrend_f64(x, fs);
    let x = detrended.as_deref().unwrap_or(x);
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    let q = if top_fraction.is_finite() {
        top_fraction.clamp(0.0, 1.0)
    } else {
        DEFAULT_TOP_FRACTION
    };
    let k = ((q * n as f64).round() as usize).clamp(1, n);
    let mut v = x.to_vec();
    // Top k: partition so the last k elements are the k largest.
    let split = n - k;
    if split > 0 {
        v.select_nth_unstable_by(split, |a, b| a.total_cmp(b));
    }
    let top_mean = v[split..].iter().sum::<f64>() / k as f64;
    let med = median_in_place(&mut v);
    top_mean - med
}

/// Descriptive peak SNR: [`robust_signal`] / `sigma`.
///
/// Pass `sigma` from [`noise_sigma_mad_diff`] for the real-data metric. This is
/// a *peak* SNR: it depends on the firing regime (see the module docs) and
/// must not be read as a per-spike SNR. Returns `f64::INFINITY` when
/// `sigma <= 0` and the signal is positive, and 0 for an empty trace.
pub fn peak_snr(trace: &[f32], sigma: f64, top_fraction: f64, fs: f64) -> f64 {
    let s = robust_signal(trace, top_fraction, fs);
    ratio(s, sigma)
}

/// [`peak_snr`] with the MAD-diff noise σ and the default top fraction: the
/// measured SNR a user gets on their own recording, and the quantity the
/// simulator's default noise convention targets.
pub fn measured_snr(trace: &[f32], fs: f64) -> f64 {
    let x = finite_f64(trace);
    measured_snr_f64(&x, DEFAULT_TOP_FRACTION, fs)
}

pub(crate) fn measured_snr_f64(x: &[f64], top_fraction: f64, fs: f64) -> f64 {
    let sigma = median_abs_diff(x) / (MAD_GAUSSIAN * std::f64::consts::SQRT_2);
    ratio(robust_signal_f64(x, top_fraction, fs), sigma)
}

// ── Event detection and the silent flag ──────────────────────────

/// Default expected number of false (pure-noise) events per trace allowed by
/// the height floor of [`detect_events`].
pub const DEFAULT_FALSE_EVENTS: f64 = 0.1;

/// A detected calcium event.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Event {
    /// Sample index of the event's peak in the (lightly smoothed) trace.
    pub time_index: usize,
    /// Peak height above the local pre-event baseline, in trace units.
    pub height: f64,
    /// The local pre-event baseline the height is measured from: the minimum
    /// of the smoothed trace over the preceding separation window, so on a
    /// noisy trace it sits a little (about 1–2 σ/√w) below the typical baseline.
    pub baseline: f64,
}

/// What [`measured_snr_report`] returns: the SNR plus whether the trace is
/// silent.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SnrReport {
    /// [`measured_snr`] (top-slice SNR). Near its pure-noise floor (see the
    /// module docs) it means "indistinguishable from noise".
    pub snr: f64,
    /// Noise σ ([`noise_sigma_mad_diff`]).
    pub sigma: f64,
    /// Number of events that clear the noise floor.
    pub n_events: usize,
    /// True when no event clears the floor: the trace shows no activity a
    /// pure-noise trace of this length would not. The SNR is still reported.
    pub is_silent: bool,
}

/// Upper-tail standard normal probability Q(z) = P(Z > z), via erfc
/// (Numerical Recipes Chebyshev fit, relative error < 1.2e-7).
fn normal_sf(z: f64) -> f64 {
    let x = z / std::f64::consts::SQRT_2;
    let ax = x.abs();
    let t = 1.0 / (1.0 + 0.5 * ax);
    let poly = -ax * ax - 1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let erfc = t * poly.exp();
    0.5 * if x >= 0.0 { erfc } else { 2.0 - erfc }
}

/// z such that Q(z) = p, for 0 < p < 0.5 (bisection on [0, 40]).
fn normal_isf(p: f64) -> f64 {
    if p.is_nan() || p <= 0.0 {
        return 40.0;
    }
    if p >= 0.5 {
        return 0.0;
    }
    let (mut lo, mut hi) = (0.0_f64, 40.0_f64);
    for _ in 0..100 {
        let mid = 0.5 * (lo + hi);
        if normal_sf(mid) > p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Centered moving average of odd width `w` (the window shrinks at the edges).
fn moving_average(x: &[f64], w: usize) -> Vec<f64> {
    let n = x.len();
    let h = w / 2;
    let mut prefix = Vec::with_capacity(n + 1);
    prefix.push(0.0);
    for &v in x {
        prefix.push(prefix.last().copied().unwrap_or(0.0) + v);
    }
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(h);
            let hi = (i + h + 1).min(n);
            (prefix[hi] - prefix[lo]) / (hi - lo) as f64
        })
        .collect()
}

/// Sliding-window extreme over `[i - left, i + right]` (monotonic deque).
fn sliding_extreme(x: &[f64], left: usize, right: usize, is_max: bool) -> Vec<f64> {
    use std::collections::VecDeque;
    let n = x.len();
    let better = |a: f64, b: f64| if is_max { a >= b } else { a <= b };
    let mut out = vec![0.0; n];
    let mut dq: VecDeque<usize> = VecDeque::new();
    let mut next = 0usize;
    for (i, o) in out.iter_mut().enumerate() {
        let hi = (i + right).min(n - 1);
        while next <= hi {
            while let Some(&b) = dq.back() {
                if better(x[next], x[b]) {
                    dq.pop_back();
                } else {
                    break;
                }
            }
            dq.push_back(next);
            next += 1;
        }
        let lo = i.saturating_sub(left);
        while let Some(&f) = dq.front() {
            if f < lo {
                dq.pop_front();
            } else {
                break;
            }
        }
        *o = x[dq.front().copied().unwrap_or(i)];
    }
    out
}

/// Height floor θ (trace units) below which a candidate is not an event.
///
/// Under pure white noise of std σ, a moving average of width `w` has std
/// σ_s = σ/√w and about one independent sample per `w` frames. A candidate's
/// height is (max over its 2·sep+1 window) − (min over the `sep` frames before
/// it), which exceeds θ only if the max exceeds θ/2 or the min falls below
/// −θ/2. A union bound over m = ⌈(3·sep+1)/w⌉ independent samples per
/// candidate and at most M = n/(sep+1) candidates gives
/// E[false events] ≤ M·m·Q(θ/(2σ_s)); setting that to `false_events` solves
/// for θ = 2σ_s·Q⁻¹(false_events/(M·m)). The bound is conservative (the
/// measured false-event rate is below it), so θ errs toward silence.
pub(crate) fn event_floor(n: usize, sigma: f64, sep: usize, w: usize, false_events: f64) -> f64 {
    let sigma_s = sigma / (w as f64).sqrt();
    let m = (3 * sep + 1).div_ceil(w) as f64;
    let big_m = n as f64 / (sep + 1) as f64;
    2.0 * sigma_s * normal_isf(false_events / (big_m * m))
}

/// Smoothing width used by [`detect_events`] for a given separation: about a
/// quarter of the separation, odd, at least 1. The separation is meant to be
/// the indicator's decay time, and GCaMP rise times are roughly an eighth to a
/// quarter of that, so this is a light smooth that suppresses single-sample
/// noise maxima without blurring the rise.
fn default_smooth_width(min_separation: usize) -> usize {
    ((min_separation / 4).max(1)) | 1
}

pub(crate) fn detect_events_f64(
    x: &[f64],
    sigma: f64,
    min_separation: usize,
    false_events: f64,
) -> Vec<Event> {
    let n = x.len();
    if n < 3 || !sigma.is_finite() || sigma <= 0.0 {
        return Vec::new();
    }
    let sep = min_separation.clamp(1, n);
    let w = default_smooth_width(sep).min(n | 1);
    let y = moving_average(x, w);
    let local_max = sliding_extreme(&y, sep, sep, true);
    let pre_min = sliding_extreme(&y, sep, 0, false);
    let theta = event_floor(n, sigma, sep, w, false_events);

    let mut events = Vec::new();
    let mut last_peak: Option<usize> = None;
    for p in 1..n {
        if y[p] < local_max[p] {
            continue;
        }
        if let Some(lp) = last_peak {
            if p - lp <= sep {
                continue; // plateau or tie: count the event once
            }
        }
        last_peak = Some(p);
        let h = y[p] - pre_min[p];
        if h > theta {
            events.push(Event {
                time_index: p,
                height: h,
                baseline: pre_min[p],
            });
        }
    }
    events
}

/// Finite copy of `trace` with non-finite samples replaced by the median, so
/// sample indices still refer to the input.
fn finite_filled_f64(trace: &[f32]) -> Vec<f64> {
    let mut fin = finite_f64(trace);
    let med = median_in_place(&mut fin);
    trace
        .iter()
        .map(|&v| if v.is_finite() { v as f64 } else { med })
        .collect()
}

/// Detect calcium events: the transients that rise clearly above the noise.
///
/// 1. Smooth lightly (centered moving average about a quarter of
///    `min_separation_samples` wide) so single-sample noise maxima do not
///    count.
/// 2. Candidates are local maxima of the smoothed trace over
///    ±`min_separation_samples`, so a transient counts once however many
///    samples it spans and two events are never closer than that.
/// 3. An event's `height` is measured above its own local pre-event baseline
///    (the minimum of the smoothed trace over the `min_separation_samples`
///    before the peak), so drift and the tail of an earlier transient do not
///    inflate it.
/// 4. A candidate is kept only if its height exceeds a floor derived from
///    `sigma` so that a pure-noise trace of the same length yields about
///    [`DEFAULT_FALSE_EVENTS`] (0.1) false events in expectation (derivation
///    on `event_floor`). The floor is a few σ/√w, so it is set by the trace
///    length and the smoothing, not by a tuned constant.
///
/// `sigma` is the noise std (pass [`noise_sigma_mad_diff`]);
/// `min_separation_samples` should be about the indicator's decay time in
/// samples. Non-finite samples are replaced by the median so `time_index`
/// still indexes the input. Returns no events for `sigma <= 0` or fewer than
/// three samples.
pub fn detect_events(trace: &[f32], sigma: f64, min_separation_samples: usize) -> Vec<Event> {
    let x = finite_filled_f64(trace);
    detect_events_f64(&x, sigma, min_separation_samples, DEFAULT_FALSE_EVENTS)
}

/// [`measured_snr`] together with the silent flag: `is_silent` is true when
/// [`detect_events`] (with σ from [`noise_sigma_mad_diff`]) finds no event.
///
/// The SNR is still the top-slice number; a silent trace measures near the
/// metric's pure-noise floor (see the module docs).
pub fn measured_snr_report(trace: &[f32], fs: f64, min_separation_samples: usize) -> SnrReport {
    let sigma = noise_sigma_mad_diff(trace);
    let events = detect_events(trace, sigma, min_separation_samples);
    SnrReport {
        snr: measured_snr(trace, fs),
        sigma,
        n_events: events.len(),
        is_silent: events.is_empty(),
    }
}

pub(crate) fn ratio(signal: f64, sigma: f64) -> f64 {
    if sigma > 0.0 {
        signal / sigma
    } else if signal > 0.0 {
        f64::INFINITY
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulate::{
        simulate, DriftModel, NoiseConfig, NoiseReference, PoissonConfig, RandomWalkDrift,
        SimulationConfig, SpikeModel,
    };
    use crate::test_util::white;

    /// Deterministic standard normals (xorshift + Box–Muller).
    #[test]
    fn mad_diff_recovers_white_noise_sigma() {
        for (sigma, seed) in [(1.0, 1u64), (0.05, 2), (37.0, 3)] {
            let x = white(18_000, sigma, seed);
            let est = noise_sigma_mad_diff(&x);
            assert!(
                (est / sigma - 1.0).abs() < 0.03,
                "σ={sigma}: estimate {est}"
            );
        }
    }

    #[test]
    fn mad_diff_ignores_offset_and_slow_drift() {
        let n = 18_000;
        let x: Vec<f32> = white(n, 0.2, 9)
            .iter()
            .enumerate()
            .map(|(i, &v)| v + 500.0 + 3.0 * (i as f32 / n as f32))
            .collect();
        let est = noise_sigma_mad_diff(&x);
        assert!((est / 0.2 - 1.0).abs() < 0.03, "estimate {est}");
    }

    #[test]
    fn nu_matches_its_definition_and_sigma_relation() {
        let fs = 30.0;
        let sigma = 2.0; // percent ΔF/F
        let x = white(27_000, sigma, 4);
        let nu = noise_level_nu(&x, fs);
        let expected = sigma * MAD_GAUSSIAN * std::f64::consts::SQRT_2 / fs.sqrt();
        assert!((nu / expected - 1.0).abs() < 0.03, "ν {nu} vs {expected}");
        assert_eq!(noise_level_nu(&x, 0.0), 0.0);
        assert_eq!(noise_level_nu(&x, f64::NAN), 0.0);
    }

    #[test]
    fn pure_noise_peak_snr_sits_at_the_gaussian_floor() {
        // Mean of the top 1 % of N(0,1) is φ(z_0.99)/0.01 ≈ 2.665.
        let x = white(100_000, 1.0, 5);
        let snr = measured_snr(&x, 30.0);
        assert!((snr - 2.665).abs() < 0.08, "floor {snr}");
    }

    #[test]
    fn degenerate_inputs() {
        assert_eq!(noise_sigma_mad_diff(&[]), 0.0);
        assert_eq!(noise_sigma_mad_diff(&[1.0]), 0.0);
        assert_eq!(robust_signal(&[], 0.01, 30.0), 0.0);
        assert_eq!(peak_snr(&[1.0, 1.0, 1.0], 0.0, 0.01, 30.0), 0.0);
        assert_eq!(peak_snr(&[0.0, 0.0, 5.0], 0.0, 0.01, 30.0), f64::INFINITY);
        // NaNs are dropped, not propagated.
        assert!(noise_sigma_mad_diff(&[1.0, f32::NAN, 2.0, 1.5, 0.5]).is_finite());
        assert!(robust_signal(&[1.0, 2.0], f64::NAN, 30.0).is_finite());
    }

    #[test]
    fn robust_signal_uses_the_top_fraction() {
        let mut x = vec![0.0f32; 1000];
        for v in x.iter_mut().take(10) {
            *v = 10.0;
        }
        assert!((robust_signal(&x, 0.01, 30.0) - 10.0).abs() < 1e-9);
        assert!((robust_signal(&x, 0.02, 30.0) - 5.0).abs() < 1e-9);
    }

    fn noisy_sim(
        reference: NoiseReference,
        snr: f64,
        spikes: SpikeModel,
        fs: f64,
    ) -> SimulationConfig {
        SimulationConfig {
            fs_hz: fs,
            num_timepoints: (300.0 * fs) as usize,
            num_cells: 4,
            spike_model: spikes,
            noise: NoiseConfig {
                snr,
                reference,
                ..Default::default()
            },
            drift: DriftModel::RandomWalk(RandomWalkDrift {
                step_std_fraction: 0.0,
                ..Default::default()
            }),
            seed: 11,
            ..Default::default()
        }
    }

    /// σ recovery on simulated traces at realistic noise (single-spike SNR ≤ 4):
    /// within −4/+8 % at single-spike SNR 2 (task-1 measurements: ≤ +6 % mean).
    #[test]
    fn mad_diff_recovers_simulated_sigma_at_realistic_noise() {
        for spikes in [
            SpikeModel::Poisson(PoissonConfig { rate_hz: 1.9 }),
            SpikeModel::default(),
        ] {
            for fs in [30.0, 60.0] {
                let cfg = noisy_sim(NoiseReference::SingleSpike, 2.0, spikes.clone(), fs);
                let r = simulate(&cfg);
                let n = r.num_timepoints;
                for (c, gt) in r.ground_truth.iter().enumerate() {
                    let tr = &r.traces[c * n..(c + 1) * n];
                    let est = noise_sigma_mad_diff(tr);
                    let ratio = est / gt.noise_sigma;
                    assert!(
                        (0.96..1.08).contains(&ratio),
                        "fs {fs} cell {c}: ratio {ratio}"
                    );
                }
            }
        }
    }

    /// The simulator's default convention: the measured SNR of each noisy
    /// trace equals the requested SNR.
    #[test]
    fn simulated_traces_measure_at_the_requested_snr() {
        for spikes in [
            SpikeModel::Poisson(PoissonConfig { rate_hz: 0.3 }),
            SpikeModel::Poisson(PoissonConfig { rate_hz: 1.9 }),
            SpikeModel::default(),
        ] {
            for target in [5.0, 12.0, 30.0] {
                let cfg = noisy_sim(NoiseReference::MeasuredSnr, target, spikes.clone(), 30.0);
                let r = simulate(&cfg);
                let n = r.num_timepoints;
                for c in 0..r.num_cells {
                    let m = measured_snr(&r.traces[c * n..(c + 1) * n], 30.0);
                    assert!(
                        (m / target - 1.0).abs() < 0.01,
                        "target {target}: measured {m}"
                    );
                }
            }
        }
    }

    /// Round trip on an independent noise draw: simulate at a target measured
    /// SNR, rebuild the same noise-free trace, add *fresh* Gaussian noise at
    /// the σ the simulator chose, and measure. This is the agreement a user
    /// sees, not the solve's own fit (task-1 sweep: within ±10 % per 300 s
    /// trace, ±4 % per 30 min trace, for targets 3–40).
    #[test]
    fn measured_snr_round_trips_on_a_fresh_noise_draw() {
        for &target in &[3.0, 8.0, 20.0] {
            let cfg = SimulationConfig {
                num_timepoints: 9000, // 300 s at 30 Hz
                num_cells: 3,
                noise: NoiseConfig {
                    snr: target,
                    ..Default::default()
                },
                seed: 7,
                ..Default::default()
            };
            let r = simulate(&cfg);
            let base = simulate(&SimulationConfig {
                noise: NoiseConfig {
                    snr: 1e12,
                    reference: NoiseReference::Peak,
                    ..Default::default()
                },
                ..cfg.clone()
            });
            let n = r.num_timepoints;
            for c in 0..r.num_cells {
                let sigma = r.ground_truth[c].noise_sigma;
                let fresh: Vec<f32> = base.traces[c * n..(c + 1) * n]
                    .iter()
                    .zip(white(n, sigma, 1000 + c as u64))
                    .map(|(&b, w)| b + w)
                    .collect();
                let m = measured_snr(&fresh, 30.0) / target;
                assert!(
                    (0.88..1.12).contains(&m),
                    "target {target} cell {c}: ratio {m}"
                );
            }
        }
    }

    #[test]
    fn peak_reference_reproduces_the_legacy_noise_level() {
        let cfg = noisy_sim(NoiseReference::Peak, 20.0, SpikeModel::default(), 30.0);
        let r = simulate(&cfg);
        for gt in &r.ground_truth {
            let max = gt.clean_calcium.iter().cloned().fold(0.0f32, f32::max) as f64;
            assert!((gt.noise_sigma - max / 20.0).abs() < 1e-9 * max.max(1.0));
        }
    }

    #[test]
    fn single_spike_reference_sets_the_single_spike_snr() {
        let cfg = noisy_sim(
            NoiseReference::SingleSpike,
            2.5,
            SpikeModel::default(),
            30.0,
        );
        for gt in &simulate(&cfg).ground_truth {
            assert!((gt.snr_1ap - 2.5).abs() < 1e-9, "{}", gt.snr_1ap);
        }
    }

    /// Below the pure-noise floor the target is unreachable; the trace still
    /// gets noise and measures near the floor instead of failing.
    #[test]
    fn targets_below_the_noise_floor_clamp_to_it() {
        let cfg = noisy_sim(
            NoiseReference::MeasuredSnr,
            1.5,
            SpikeModel::default(),
            30.0,
        );
        let r = simulate(&cfg);
        let n = r.num_timepoints;
        for c in 0..r.num_cells {
            assert!(r.ground_truth[c].noise_sigma > 0.0);
            let m = measured_snr(&r.traces[c * n..(c + 1) * n], 30.0);
            assert!((2.5..4.0).contains(&m), "measured {m}");
        }
    }

    /// Synthetic trace: white noise plus unit-amplitude-times-`amp` transients
    /// (instant rise, exponential decay) at known sample indices.
    fn trace_with_events(
        n: usize,
        sigma: f64,
        amp: f64,
        at: &[usize],
        tau: f64,
        seed: u64,
    ) -> Vec<f32> {
        let mut x = white(n, sigma, seed);
        for &t in at {
            for (k, v) in x.iter_mut().enumerate().skip(t) {
                *v += (amp * (-((k - t) as f64) / tau).exp()) as f32;
            }
        }
        x
    }

    #[test]
    fn detect_events_recovers_known_events() {
        let sigma = 1.0;
        let at = [500usize, 1400, 2300, 3100, 4000, 5200, 6100, 7300];
        let x = trace_with_events(9000, sigma, 10.0 * sigma, &at, 10.0, 21);
        let sig = noise_sigma_mad_diff(&x);
        let ev = detect_events(&x, sig, 12);
        assert_eq!(ev.len(), at.len(), "events {ev:?}");
        for (e, &t) in ev.iter().zip(at.iter()) {
            assert!(
                e.time_index.abs_diff(t) <= 3,
                "event at {} expected near {t}",
                e.time_index
            );
            assert!((6.0..11.0).contains(&e.height), "height {}", e.height);
            // The baseline is a minimum of smoothed noise, so it sits ~1-2 σ low.
            assert!((-2.5..0.5).contains(&e.baseline), "baseline {}", e.baseline);
        }
        // Events are separated by at least the minimum separation.
        assert!(ev
            .windows(2)
            .all(|w| w[1].time_index - w[0].time_index > 12));
    }

    #[test]
    fn detect_events_measures_height_above_the_local_baseline() {
        // Same events on a +50 offset and a slow ramp: heights must not change.
        let at = [800usize, 2500, 4200, 6000];
        let base = trace_with_events(9000, 1.0, 10.0, &at, 10.0, 22);
        let shifted: Vec<f32> = base
            .iter()
            .enumerate()
            .map(|(i, &v)| v + 50.0 + 4.0 * (i as f32 / 9000.0))
            .collect();
        let sig = noise_sigma_mad_diff(&shifted);
        let ev = detect_events(&shifted, sig, 12);
        assert_eq!(ev.len(), at.len(), "events {ev:?}");
        assert!(ev.iter().all(|e| (5.0..11.0).contains(&e.height)));
    }

    /// Pure white noise: the floor is derived for ≤ 0.1 expected false events
    /// per trace, and the union bound is conservative.
    #[test]
    fn pure_noise_yields_about_the_expected_false_event_count() {
        let (mut total, mut silent, trials) = (0usize, 0usize, 60usize);
        for seed in 0..trials as u64 {
            let x = white(9000, 3.0, 100 + seed);
            let r = measured_snr_report(&x, 30.0, 12);
            total += r.n_events;
            silent += r.is_silent as usize;
        }
        let per_trace = total as f64 / trials as f64;
        assert!(per_trace <= 0.1 + 0.1, "false events per trace {per_trace}");
        assert!(silent >= trials - 6, "silent {silent}/{trials}");
    }

    #[test]
    fn report_flags_silent_and_active_traces() {
        let noise = white(9000, 1.0, 31);
        assert!(measured_snr_report(&noise, 30.0, 12).is_silent);
        let active = trace_with_events(9000, 1.0, 8.0, &[900, 3000, 5200, 7400], 10.0, 32);
        let r = measured_snr_report(&active, 30.0, 12);
        assert!(!r.is_silent && r.n_events == 4, "{r:?}");
        assert_eq!(r.snr, measured_snr(&active, 30.0));
        assert!((r.sigma - 1.0).abs() < 0.05);
    }

    #[test]
    fn detect_events_degenerate_inputs() {
        assert!(detect_events(&[], 1.0, 10).is_empty());
        assert!(detect_events(&[1.0, 2.0], 1.0, 10).is_empty());
        assert!(detect_events(&[0.0, 5.0, 0.0, 5.0, 0.0], 0.0, 10).is_empty());
        assert!(detect_events(&[0.0; 100], f64::NAN, 0).is_empty());
        // NaNs keep indices stable and never panic.
        let mut x = white(2000, 1.0, 5);
        x[10] = f32::NAN;
        x[11] = f32::INFINITY;
        let _ = detect_events(&x, 1.0, 0);
        assert!(measured_snr_report(&[f32::NAN; 50], 30.0, 5).is_silent);
    }

    /// Prints the pure-noise floor of the top-slice SNR by trace length, with
    /// and without 5 % of F0 drift (run with `--ignored --nocapture`); the
    /// numbers feed the module docs.
    #[test]
    #[ignore]
    fn print_pure_noise_floor_by_length() {
        for (label, n, fs) in [
            ("1 min  30 Hz", 1800usize, 30.0),
            ("5 min  30 Hz", 9000, 30.0),
            ("10 min 30 Hz", 18_000, 30.0),
            ("30 min 30 Hz", 54_000, 30.0),
            ("30 min 60 Hz", 108_000, 60.0),
        ] {
            for (drift, exponential) in
                [("none", None), ("linear", Some(false)), ("exp", Some(true))]
            {
                let mut v: Vec<f64> = (0..40)
                    .map(|s| {
                        let x = white(n, 1.0, 900 + s);
                        match exponential {
                            None => measured_snr(&x, fs),
                            Some(e) => measured_snr(&add_drift(&x, 100.0, 0.05, e), fs),
                        }
                    })
                    .collect();
                v.sort_by(|a, b| a.total_cmp(b));
                println!(
                    "FLOOR {label} n={n} drift {drift}: median {:.3} p5 {:.3} p95 {:.3}",
                    v[20], v[2], v[37]
                );
            }
        }
    }

    /// Drift is scaled by the robust signal: its amplitude relative to the
    /// metric's own signal is the configured fraction in every firing regime
    /// (scaling by max(clean) made it 13-21x smaller per spike under bursts).
    #[test]
    fn drift_amplitude_scales_with_the_robust_signal() {
        use crate::simulate::SinusoidalDrift;
        for spikes in [
            SpikeModel::Poisson(PoissonConfig { rate_hz: 0.3 }),
            SpikeModel::Poisson(PoissonConfig { rate_hz: 1.9 }),
            SpikeModel::default(),
        ] {
            let cfg = SimulationConfig {
                num_timepoints: 9000,
                num_cells: 3,
                spike_model: spikes,
                noise: NoiseConfig {
                    snr: 0.0, // no noise: trace - clean_calcium is the drift
                    ..Default::default()
                },
                drift: DriftModel::Sinusoidal(SinusoidalDrift {
                    amplitude_fraction: 0.2,
                    ..Default::default()
                }),
                seed: 5,
                ..Default::default()
            };
            let r = simulate(&cfg);
            let n = r.num_timepoints;
            for c in 0..r.num_cells {
                let gt = &r.ground_truth[c];
                let robust = robust_signal(&gt.clean_calcium, DEFAULT_TOP_FRACTION, 30.0);
                let drift_peak = r.traces[c * n..(c + 1) * n]
                    .iter()
                    .zip(&gt.clean_calcium)
                    .map(|(&t, &cl)| (t - cl).abs() as f64)
                    .fold(0.0, f64::max);
                assert!(
                    (drift_peak / (0.2 * robust) - 1.0).abs() < 0.02,
                    "drift {drift_peak} vs 0.2 x robust {robust}"
                );
            }
        }
    }

    /// Slow drift on a trace: `frac` of F0 over the whole trace, linear or an
    /// exponential bleach (time constant a third of the trace).
    fn add_drift(x: &[f32], f0: f64, frac: f64, exponential: bool) -> Vec<f32> {
        let n = x.len() as f64;
        x.iter()
            .enumerate()
            .map(|(i, &v)| {
                let t = i as f64 / n;
                let shape = if exponential {
                    (1.0 - (-3.0 * t).exp()) / (1.0 - (-3.0f64).exp())
                } else {
                    t
                };
                v + (f0 * frac * shape) as f32
            })
            .collect()
    }

    /// A silent trace with photobleaching-scale drift must read at the
    /// pure-noise floor, as it does without drift (30 min at 30 Hz, noise
    /// σ = 1 % of F0 so the 5 % drift is 5σ). Without the detrend it read 4.2
    /// (linear) and 3.3 (exponential).
    #[test]
    fn drift_does_not_inflate_a_silent_trace() {
        let (fs, n, f0, sigma) = (30.0, 54_000, 100.0, 1.0);
        for seed in 0..5u64 {
            let x = white(n, sigma, 700 + seed);
            for (label, d) in [
                ("none", x.clone()),
                ("linear", add_drift(&x, f0, 0.05, false)),
                ("exp", add_drift(&x, f0, 0.05, true)),
                ("linear 2%", add_drift(&x, f0, 0.02, false)),
            ] {
                let snr = measured_snr(&d, fs);
                assert!((2.58..2.78).contains(&snr), "{label} seed {seed}: {snr}");
                assert!(measured_snr_report(&d, fs, 12).is_silent, "{label}");
            }
            // The undetrended metric is what drift inflates.
            let raw = measured_snr(&add_drift(&x, f0, 0.05, false), 0.0);
            assert!(raw > 3.5, "undetrended linear drift read {raw}");
        }
    }

    /// An active trace's SNR moves by < 3 % when the same drift is added.
    #[test]
    fn drift_barely_moves_an_active_trace() {
        let (fs, n, sigma) = (30.0, 54_000, 1.0);
        // 90 events spread over the trace at three amplitudes; F0 =
        // 40σ makes the 5 % drift 2σ.
        let at: Vec<usize> = (0..90).map(|k| 300 + k * 590 + (k * 37) % 90).collect();
        for amp in [6.0, 12.0, 25.0] {
            let x = trace_with_events(n, sigma, amp, &at, 40.0, 41);
            let base = measured_snr(&x, fs);
            for (label, exponential) in [("linear", false), ("exp", true)] {
                let d = add_drift(&x, 40.0 * sigma, 0.05, exponential);
                let m = measured_snr(&d, fs);
                assert!(
                    (m / base - 1.0).abs() < 0.03,
                    "amp {amp} {label}: {m} vs {base}"
                );
            }
        }
    }

    /// Simulated active cells (slowest and fastest indicator, sparse and dense
    /// firing): the same 5 % F0 drift (F0 = 2 × the robust signal) moves the
    /// measured SNR by < 3 %.
    #[test]
    fn drift_barely_moves_simulated_cells() {
        use crate::simulate::presets;
        for name in ["gcamp6s", "jgcamp8f"] {
            let p = presets::all()
                .into_iter()
                .find(|(n, _)| *n == name)
                .unwrap()
                .1;
            for rate in [0.3, 1.9] {
                let mut cfg = p.clone();
                cfg.fs_hz = 30.0;
                cfg.num_timepoints = 18_000;
                cfg.num_cells = 3;
                cfg.noise.snr = 8.0;
                cfg.noise.reference = NoiseReference::MeasuredSnr;
                cfg.drift = DriftModel::RandomWalk(RandomWalkDrift {
                    step_std_fraction: 0.0,
                    ..Default::default()
                });
                cfg.spike_model = SpikeModel::Poisson(PoissonConfig { rate_hz: rate });
                let r = simulate(&cfg);
                let n = r.num_timepoints;
                for c in 0..r.num_cells {
                    let x = &r.traces[c * n..(c + 1) * n];
                    let f0 = 2.0 * robust_signal(x, DEFAULT_TOP_FRACTION, 30.0);
                    let base = measured_snr(x, 30.0);
                    for exponential in [false, true] {
                        let m = measured_snr(&add_drift(x, f0, 0.05, exponential), 30.0);
                        assert!(
                            (m / base - 1.0).abs() < 0.03,
                            "{name} {rate} Hz cell {c}: {m} vs {base}"
                        );
                    }
                }
            }
        }
    }
}
