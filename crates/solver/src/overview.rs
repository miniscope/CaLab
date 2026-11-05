//! Model-free, display-only per-cell overview metrics.
//!
//! [`cell_overview`] summarises one raw trace for a dataset-overview screen:
//! the shipped SNR and noise σ, the detected-event statistics, a coarse
//! baseline curve, and saturation / missing-data evidence. It **never reads
//! solver state** (no kernel, no deconvolution result, no fitted parameters)
//! and must not feed back into the solver; every number is computed from the
//! trace alone with the estimators in [`crate::snr`].
//!
//! Notes on individual fields:
//!
//! - `baseline_bins` is the 10th percentile of the finite samples in each of
//!   `n_baseline_bins` equal time bins. That is a *coarse rolling low
//!   quantile*: it follows slow drift and bleaching, but it is not the
//!   solver's baseline and it sits a little below the true baseline on noisy
//!   traces (the 10th percentile of N(0, σ²) is about −1.28 σ). Compare bins
//!   to each other, not to an absolute baseline.
//! - `n_at_max` counts finite samples within `1e-6 · (max − min)` of the trace
//!   maximum. A healthy trace has a handful (the single peak, possibly a few
//!   ties on quantised data); a detector that saturated or a trace clipped at
//!   a ceiling has many samples pinned at the same maximum value. A constant
//!   trace (zero range) has every finite sample at its maximum.
//!
//! Degenerate input never panics: an empty or all-NaN trace gives zero counts,
//! `snr = 0`, `sigma = 0`, no events, empty `height_quantiles`, and NaN
//! `baseline_start` / `baseline_end` (and NaN bins) because there is no data
//! to take a baseline from. A constant trace has `sigma = 0`, hence no events,
//! and an `snr` of 0 (or infinity if the constant is above its own median,
//! which cannot happen). `n_baseline_bins = 0` is treated as 1.

use crate::snr::{
    detect_events_f64, finite_f64, median_abs_diff, median_in_place, ratio, robust_signal_f64,
    DEFAULT_FALSE_EVENTS, DEFAULT_TOP_FRACTION, MAD_GAUSSIAN,
};

/// Number of event-height quantiles reported (p = 0.05 … 0.95).
pub const N_HEIGHT_QUANTILES: usize = 19;

/// Minimum number of events for `height_quantiles` to be reported.
pub const MIN_EVENTS_FOR_QUANTILES: usize = 3;

/// Percentile used for each baseline bin.
pub const BASELINE_PERCENTILE: f64 = 0.10;

/// Per-cell overview metrics (see the module docs).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct CellOverview {
    /// [`crate::snr::measured_snr`] (top-slice SNR), the shipped metric.
    pub snr: f64,
    /// [`crate::snr::noise_sigma_mad_diff`].
    pub sigma: f64,
    /// [`crate::snr::noise_level_nu`], only when the trace is ΔF/F.
    pub nu: Option<f64>,
    /// Events from [`crate::snr::detect_events`] with the σ above.
    pub n_events: usize,
    /// `n_events == 0`; equals `measured_snr_report(..).is_silent`.
    pub is_silent: bool,
    /// `n_events / (n_samples / fs)`; 0 for `fs <= 0` or an empty trace.
    pub event_rate_hz: f64,
    /// Median raw event height; 0 when there are no events.
    pub median_event_height: f64,
    /// 19 quantiles (p = 0.05 … 0.95, linear interpolation) of event heights
    /// divided by this cell's own median height; empty when `n_events < 3`.
    pub height_quantiles: Vec<f64>,
    /// 10th percentile of the finite samples per equal time bin (raw units;
    /// NaN for a bin with no finite sample).
    pub baseline_bins: Vec<f64>,
    /// Median of the finite bins in the first 10 % of the trace (at least the
    /// first bin); NaN when there are none.
    pub baseline_start: f64,
    /// Median of the finite bins in the last 10 % of the trace (at least the
    /// last bin); NaN when there are none.
    pub baseline_end: f64,
    /// Finite samples within `1e-6 · (max − min)` of the trace maximum.
    pub n_at_max: usize,
    /// `n_at_max` / number of finite samples (0 when there are none).
    pub clip_fraction: f64,
    /// Non-finite samples.
    pub nan_count: usize,
    /// Longest run of consecutive non-finite samples.
    pub longest_gap_frames: usize,
}

/// Quantile `p` (linear interpolation, type 7) of `v`, reordering it.
/// Uses selection, not a full sort. Empty input returns NaN.
fn quantile_in_place(v: &mut [f64], p: f64) -> f64 {
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    let pos = p.clamp(0.0, 1.0) * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let frac = pos - lo as f64;
    let (_, m, upper) = v.select_nth_unstable_by(lo, |a, b| a.total_cmp(b));
    let a = *m;
    if frac > 0.0 && !upper.is_empty() {
        let b = upper.iter().cloned().fold(f64::INFINITY, f64::min);
        a + frac * (b - a)
    } else {
        a
    }
}

/// Model-free, display-only per-cell overview. Never reads solver state.
///
/// `fs` is the frame rate in Hz, `min_separation_samples` the event
/// separation (about the indicator decay in samples), `is_dff` whether the
/// trace is ΔF/F (enables `nu`), `n_baseline_bins` the number of equal time
/// bins for the baseline curve (0 is treated as 1; more bins than samples
/// uses one bin per sample).
pub fn cell_overview(
    trace: &[f32],
    fs: f64,
    min_separation_samples: usize,
    is_dff: bool,
    n_baseline_bins: usize,
) -> CellOverview {
    let n = trace.len();

    // Missing-data bookkeeping.
    let mut nan_count = 0usize;
    let mut longest_gap = 0usize;
    let mut run = 0usize;
    for v in trace {
        if v.is_finite() {
            run = 0;
        } else {
            nan_count += 1;
            run += 1;
            longest_gap = longest_gap.max(run);
        }
    }

    // σ, SNR and ν share one finite copy and one σ.
    let fin = finite_f64(trace);
    let mad = median_abs_diff(&fin);
    let sigma = mad / (MAD_GAUSSIAN * std::f64::consts::SQRT_2);
    let snr = ratio(robust_signal_f64(&fin, DEFAULT_TOP_FRACTION), sigma);
    let nu = if is_dff {
        Some(if fs.is_finite() && fs > 0.0 {
            mad / fs.sqrt()
        } else {
            0.0
        })
    } else {
        None
    };

    // Events (non-finite samples replaced by the median so indices hold).
    let mut tmp = fin.clone();
    let med = median_in_place(&mut tmp);
    let filled: Vec<f64> = trace
        .iter()
        .map(|&v| if v.is_finite() { v as f64 } else { med })
        .collect();
    let events = detect_events_f64(&filled, sigma, min_separation_samples, DEFAULT_FALSE_EVENTS);
    let n_events = events.len();
    let mut heights: Vec<f64> = events.iter().map(|e| e.height).collect();
    let median_event_height = median_in_place(&mut heights);
    let event_rate_hz = if fs.is_finite() && fs > 0.0 && n > 0 {
        n_events as f64 / (n as f64 / fs)
    } else {
        0.0
    };
    let height_quantiles = if n_events >= MIN_EVENTS_FOR_QUANTILES && median_event_height > 0.0 {
        (1..=N_HEIGHT_QUANTILES)
            .map(|i| quantile_in_place(&mut heights, i as f64 * 0.05) / median_event_height)
            .collect()
    } else {
        Vec::new()
    };

    // Baseline curve: 10th percentile per equal time bin.
    let nb = n_baseline_bins.max(1).min(n);
    let mut baseline_bins = Vec::with_capacity(nb);
    if let Some(len) = n.checked_div(nb) {
        let mut buf: Vec<f64> = Vec::with_capacity(len + nb);
        for i in 0..nb {
            let start = i * len;
            let end = if i + 1 == nb { n } else { start + len };
            buf.clear();
            buf.extend(
                trace[start..end]
                    .iter()
                    .filter(|v| v.is_finite())
                    .map(|&v| v as f64),
            );
            baseline_bins.push(quantile_in_place(&mut buf, BASELINE_PERCENTILE));
        }
    }
    let edge = ((nb as f64 * 0.1).round() as usize).max(1);
    let edge_median = |range: std::ops::Range<usize>| -> f64 {
        let mut v: Vec<f64> = baseline_bins[range]
            .iter()
            .cloned()
            .filter(|b| b.is_finite())
            .collect();
        if v.is_empty() {
            f64::NAN
        } else {
            median_in_place(&mut v)
        }
    };
    let (baseline_start, baseline_end) = if nb == 0 {
        (f64::NAN, f64::NAN)
    } else {
        (
            edge_median(0..edge.min(nb)),
            edge_median(nb - edge.min(nb)..nb),
        )
    };

    // Saturation evidence.
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for &v in &fin {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    let n_at_max = if fin.is_empty() {
        0
    } else {
        let thr = hi - 1e-6 * (hi - lo);
        fin.iter().filter(|&&v| v >= thr).count()
    };
    let clip_fraction = if fin.is_empty() {
        0.0
    } else {
        n_at_max as f64 / fin.len() as f64
    };

    CellOverview {
        snr,
        sigma,
        nu,
        n_events,
        is_silent: n_events == 0,
        event_rate_hz,
        median_event_height,
        height_quantiles,
        baseline_bins,
        baseline_start,
        baseline_end,
        n_at_max,
        clip_fraction,
        nan_count,
        longest_gap_frames: longest_gap,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snr::{measured_snr_report, noise_level_nu};

    fn white(n: usize, sigma: f64, seed: u64) -> Vec<f32> {
        let mut s = seed.max(1);
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        (0..n)
            .map(|_| {
                let u1 = next().max(1e-12);
                let u2 = next();
                (sigma * (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()) as f32
            })
            .collect()
    }

    fn with_events(n: usize, amp: f64, at: &[usize], tau: f64, seed: u64) -> Vec<f32> {
        let mut x = white(n, 1.0, seed);
        for &t in at {
            for (k, v) in x.iter_mut().enumerate().skip(t) {
                *v += (amp * (-((k - t) as f64) / tau).exp()) as f32;
            }
        }
        x
    }

    fn twenty_events() -> (Vec<f32>, usize) {
        let at: Vec<usize> = (0..20).map(|i| 300 + i * 450).collect();
        (with_events(9600, 10.0, &at, 10.0, 7), 20)
    }

    #[test]
    fn white_noise_is_silent_at_the_floor() {
        let x = white(9000, 1.0, 3);
        let o = cell_overview(&x, 30.0, 15, false, 50);
        assert!(o.is_silent);
        assert!(o.snr > 2.5 && o.snr < 3.0, "snr {}", o.snr);
        assert!(o.height_quantiles.is_empty());
        assert!(o.nu.is_none());
    }

    #[test]
    fn injected_events_are_counted_and_summarised() {
        let (x, k) = twenty_events();
        let o = cell_overview(&x, 30.0, 15, false, 100);
        assert!(!o.is_silent);
        assert!((o.n_events as i64 - k as i64).abs() <= 1, "{}", o.n_events);
        let expect = o.n_events as f64 / (x.len() as f64 / 30.0);
        assert!((o.event_rate_hz - expect).abs() < 1e-12);
        assert_eq!(o.height_quantiles.len(), N_HEIGHT_QUANTILES);
        assert!(o.height_quantiles.windows(2).all(|w| w[0] <= w[1]));
        assert!((o.height_quantiles[9] - 1.0).abs() < 0.1);
        assert!(o.median_event_height > 5.0);
        assert_eq!(o.baseline_bins.len(), 100);
    }

    #[test]
    fn agrees_with_measured_snr_report() {
        let (a, _) = twenty_events();
        for x in [white(5000, 1.0, 1), white(20000, 0.3, 2), a] {
            let o = cell_overview(&x, 30.0, 15, false, 20);
            let r = measured_snr_report(&x, 15);
            assert_eq!(o.snr, r.snr);
            assert_eq!(o.sigma, r.sigma);
            assert_eq!(o.n_events, r.n_events);
            assert_eq!(o.is_silent, r.is_silent);
        }
        // With a NaN run too.
        let mut x = with_events(6000, 8.0, &[1000, 3000, 4500], 10.0, 9);
        x[2000..2050].fill(f32::NAN);
        let o = cell_overview(&x, 30.0, 15, false, 20);
        let r = measured_snr_report(&x, 15);
        assert_eq!((o.snr, o.sigma, o.n_events), (r.snr, r.sigma, r.n_events));
    }

    #[test]
    fn linear_drift_shows_in_baseline_ends() {
        let n = 9000;
        let mut x = white(n, 1.0, 5);
        for (i, v) in x.iter_mut().enumerate() {
            *v += (50.0 * i as f64 / n as f64) as f32;
        }
        let o = cell_overview(&x, 30.0, 15, false, 100);
        let d = o.baseline_end - o.baseline_start;
        // Bin centres of the first and last 10 % are about 90 % of the drift apart.
        assert!(d > 38.0 && d < 50.0, "d {d}");
    }

    #[test]
    fn nan_run_is_counted() {
        let mut x = white(6000, 1.0, 4);
        x[1000..1050].fill(f32::NAN);
        let o = cell_overview(&x, 30.0, 15, true, 30);
        assert_eq!(o.nan_count, 50);
        assert_eq!(o.longest_gap_frames, 50);
        assert!(o.snr.is_finite() && o.sigma.is_finite());
        assert!(o.baseline_start.is_finite() && o.baseline_end.is_finite());
        assert!(o.baseline_bins.iter().all(|b| b.is_finite()));
    }

    #[test]
    fn clipping_is_detected() {
        let mut x = with_events(6000, 10.0, &[500, 1500, 2500, 3500, 4500], 20.0, 6);
        for v in x.iter_mut() {
            *v = v.min(3.0);
        }
        let o = cell_overview(&x, 30.0, 15, false, 30);
        assert!(o.n_at_max >= 30, "{}", o.n_at_max);
        assert!(o.clip_fraction > 0.005);
        let clean = cell_overview(&white(6000, 1.0, 6), 30.0, 15, false, 30);
        assert!(clean.n_at_max <= 2);
    }

    #[test]
    fn nu_only_for_dff() {
        let x = white(3000, 0.01, 8);
        assert!(cell_overview(&x, 30.0, 15, false, 10).nu.is_none());
        let nu = cell_overview(&x, 30.0, 15, true, 10).nu.unwrap();
        assert!(nu.is_finite());
        assert_eq!(nu, noise_level_nu(&x, 30.0));
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        let e = cell_overview(&[], 30.0, 15, true, 10);
        assert_eq!((e.n_events, e.nan_count, e.n_at_max), (0, 0, 0));
        assert!(e.is_silent && e.baseline_bins.is_empty());
        assert_eq!(e.event_rate_hz, 0.0);
        let c = cell_overview(&vec![5.0; 500], 30.0, 15, false, 0);
        assert!(c.is_silent);
        assert_eq!(c.sigma, 0.0);
        assert_eq!(c.baseline_bins, vec![5.0]);
        assert_eq!(c.n_at_max, 500);
        let nan = cell_overview(&vec![f32::NAN; 100], 0.0, 15, true, 5);
        assert_eq!(
            (nan.nan_count, nan.longest_gap_frames, nan.n_at_max),
            (100, 100, 0)
        );
        assert!(nan.baseline_start.is_nan());
        let short = cell_overview(&[1.0, 2.0, 3.0], 30.0, 15, false, 50);
        assert_eq!(short.baseline_bins.len(), 3);
    }

    #[test]
    #[ignore]
    fn time_cell_overview() {
        let (x, _) = twenty_events();
        let mut big = Vec::new();
        while big.len() < 54_000 {
            big.extend_from_slice(&x);
        }
        big.truncate(54_000);
        let t = std::time::Instant::now();
        let reps = 50;
        for _ in 0..reps {
            std::hint::black_box(cell_overview(
                std::hint::black_box(&big),
                30.0,
                15,
                true,
                200,
            ));
        }
        println!(
            "cell_overview: {:.0} us/cell",
            t.elapsed().as_secs_f64() * 1e6 / reps as f64
        );
    }
}
