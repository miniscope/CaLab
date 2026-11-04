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
//! Range: pure noise measures ≈ φ(z₀.₉₉)/0.01 ≈ 2.67 (≈ 3 on a 5-minute trace),
//! so values near 3 mean "no detectable activity" and SNRs below ≈ 2.7 do not
//! exist under this metric. At the top, a very clean trace whose own
//! frame-to-frame changes dominate the MAD-diff σ has a finite ceiling (e.g.
//! jGCaMP8f firing at 1.9 Hz at 30 Hz tops out near 25–30).
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

fn finite_f64(trace: &[f32]) -> Vec<f64> {
    trace
        .iter()
        .filter(|v| v.is_finite())
        .map(|&v| v as f64)
        .collect()
}

/// Median of a slice (reorders it). Empty input returns 0.
fn median_in_place(v: &mut [f64]) -> f64 {
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
fn median_abs_diff(x: &[f64]) -> f64 {
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
/// median. The top slice holds `max(1, round(top_fraction·n))` samples.
pub fn robust_signal(trace: &[f32], top_fraction: f64) -> f64 {
    let x = finite_f64(trace);
    robust_signal_f64(&x, top_fraction)
}

pub(crate) fn robust_signal_f64(x: &[f64], top_fraction: f64) -> f64 {
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
pub fn peak_snr(trace: &[f32], sigma: f64, top_fraction: f64) -> f64 {
    let s = robust_signal(trace, top_fraction);
    ratio(s, sigma)
}

/// [`peak_snr`] with the MAD-diff noise σ and the default top fraction: the
/// measured SNR a user gets on their own recording, and the quantity the
/// simulator's default noise convention targets.
pub fn measured_snr(trace: &[f32]) -> f64 {
    let x = finite_f64(trace);
    measured_snr_f64(&x, DEFAULT_TOP_FRACTION)
}

pub(crate) fn measured_snr_f64(x: &[f64], top_fraction: f64) -> f64 {
    let sigma = median_abs_diff(x) / (MAD_GAUSSIAN * std::f64::consts::SQRT_2);
    ratio(robust_signal_f64(x, top_fraction), sigma)
}

fn ratio(signal: f64, sigma: f64) -> f64 {
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

    /// Deterministic standard normals (xorshift + Box–Muller).
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
        let snr = measured_snr(&x);
        assert!((snr - 2.665).abs() < 0.08, "floor {snr}");
    }

    #[test]
    fn degenerate_inputs() {
        assert_eq!(noise_sigma_mad_diff(&[]), 0.0);
        assert_eq!(noise_sigma_mad_diff(&[1.0]), 0.0);
        assert_eq!(robust_signal(&[], 0.01), 0.0);
        assert_eq!(peak_snr(&[1.0, 1.0, 1.0], 0.0, 0.01), 0.0);
        assert_eq!(peak_snr(&[0.0, 0.0, 5.0], 0.0, 0.01), f64::INFINITY);
        // NaNs are dropped, not propagated.
        assert!(noise_sigma_mad_diff(&[1.0, f32::NAN, 2.0, 1.5, 0.5]).is_finite());
        assert!(robust_signal(&[1.0, 2.0], f64::NAN).is_finite());
    }

    #[test]
    fn robust_signal_uses_the_top_fraction() {
        let mut x = vec![0.0f32; 1000];
        for v in x.iter_mut().take(10) {
            *v = 10.0;
        }
        assert!((robust_signal(&x, 0.01) - 10.0).abs() < 1e-9);
        assert!((robust_signal(&x, 0.02) - 5.0).abs() < 1e-9);
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
                    let m = measured_snr(&r.traces[c * n..(c + 1) * n]);
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
                let m = measured_snr(&fresh) / target;
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
            let m = measured_snr(&r.traces[c * n..(c + 1) * n]);
            assert!((2.5..4.0).contains(&m), "measured {m}");
        }
    }
}
