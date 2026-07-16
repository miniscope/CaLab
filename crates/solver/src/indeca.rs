/// InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
///
/// Uses a scale iteration loop mirroring the original Python InDeCa:
///
/// 1. Estimate initial alpha from trace peak-to-trough
/// 2. Iterate: prescale by alpha_est → Box[0,1] FISTA → threshold search
///    → lstsq recovers alpha_lstsq → update alpha_est *= alpha_lstsq
/// 3. Converges when alpha_lstsq ≈ 1.0 (prescale matches true amplitude)
///
/// The iteration prevents the single-pass problem where an inaccurate initial
/// prescale causes the solver to settle on high alpha with too few spikes.
///
/// The AR2 forward model is peak-normalized so that a single spike produces
/// a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
use crate::banded::BandedAR2;
use crate::threshold::{lstsq_alpha_baseline, threshold_search_opts, Selection, ThresholdResult};
use crate::upsample::{
    downsample_average, downsample_binary, upsample_counts_to_binary, upsample_trace,
};
use crate::{Constraint, ConvMode, Solver};
use realfft::RealFftPlanner;

/// Optional spike-inference behaviors. The library default is off (`MaxPve`,
/// preserving the historical output); the CaDecon app enables `noise_constrained`
/// by default.
///
/// `noise_constrained` chooses the binarization threshold at the data-derived
/// noise floor instead of maximizing fit, suppressing low-SNR spurious spikes
/// without changing the default (max-PVE) output.
///
/// `mass_count` replaces the per-bin binarize→bin-sum readout with a mass-based
/// count: on an upsampled grid the shifted-kernel dictionary is coherent, so a
/// single spike's mass smears across adjacent bins and bin-summing overcounts it
/// (inflating the count ~k× and halving alpha to conserve α·count). Instead, each
/// contiguous supra-threshold run is an event whose spike count is its mass
/// divided by the calibrated single-spike mass, and alpha is refit against
/// that event train. Restores an unbiased, rate-independent count and alpha while
/// preserving genuine multiplicity for temporally resolvable bursts.
#[derive(Clone, Copy, Default)]
pub struct SolveOptions {
    pub noise_constrained: bool,
    pub mass_count: bool,
}

/// Raw measurement-noise std from the high-frequency band of the periodogram
/// (standard OASIS / CaImAn approach). Calcium signal energy sits at low
/// frequencies; averaging power in the top half of the spectrum (≈[0.25,0.5]·fs)
/// isolates the white-noise floor and is unaffected by how busy the trace is
/// (unlike MAD-of-differences, which transient onsets inflate). Runs on the
/// UNFILTERED trace, so it is immune to any HP/LP applied downstream.
///
/// For a plain periodogram P_k = |X_k|²/N with an unnormalized DFT, white noise
/// of variance σ² has E[P_k] = σ², so σ² = mean of P_k over the high band.
pub fn high_band_sigma(raw_trace: &[f32]) -> f64 {
    let n = raw_trace.len();
    if n < 8 {
        return 0.0;
    }
    let mean = raw_trace.iter().map(|&v| v as f64).sum::<f64>() / n as f64;
    let mut input: Vec<f32> = raw_trace.iter().map(|&v| v - mean as f32).collect();

    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(n);
    let mut spectrum = r2c.make_output_vec();
    if r2c.process(&mut input, &mut spectrum).is_err() {
        return 0.0;
    }

    let nyq = spectrum.len(); // n/2 + 1
    let lo = nyq / 2;
    let mut acc = 0.0_f64;
    let mut cnt = 0usize;
    for c in &spectrum[lo..nyq] {
        acc += (c.re as f64 * c.re as f64 + c.im as f64 * c.im as f64) / n as f64;
        cnt += 1;
    }
    if cnt == 0 {
        return 0.0;
    }
    (acc / cnt as f64).max(0.0).sqrt()
}

fn variance(x: &[f32]) -> f64 {
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    let mean = x.iter().map(|&v| v as f64).sum::<f64>() / n as f64;
    x.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n as f64
}

/// Per-sample noise std of the FILTERED trace at original-grid positions — the
/// quantity the residual budget needs. Estimates the raw noise std from the
/// unfiltered trace (LP-immune) and scales by the empirically-measured
/// noise-variance gain of the actual upsample→HP/LP chain: a deterministic
/// white probe is pushed through the same path and its grid-sample variance
/// ratio gives the gain. This makes the budget track whatever noise survives
/// the filters, regardless of where the (kernel-derived) LP cutoff falls.
/// (The rolling-baseline subtraction is a mild high-pass and is not replicated
/// in the probe; its effect on noise variance is negligible.)
fn estimate_grid_noise_sigma(
    raw_trace: &[f32],
    upsample_factor: usize,
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    hp: bool,
    lp: bool,
) -> f64 {
    let sigma_raw = high_band_sigma(raw_trace);
    if sigma_raw <= 0.0 {
        return 0.0;
    }
    // No filtering: grid samples equal the raw samples, so gain is 1.
    if !hp && !lp {
        return sigma_raw;
    }

    // Deterministic unit-ish white probe (LCG); absolute scale cancels in the ratio.
    let n = raw_trace.len();
    let mut probe = vec![0.0_f32; n];
    let mut state: u64 = 0x9E3779B97F4A7C15;
    for v in probe.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *v = (((state >> 33) as f64) / ((1u64 << 31) as f64) - 1.0) as f32;
    }

    let up = upsample_trace(&probe, upsample_factor);
    let mut solver = Solver::new();
    solver.set_conv_mode(ConvMode::BandedAR2);
    solver.set_params(tau_r, tau_d, 0.0, fs_up);
    solver.set_trace(&up);
    solver.set_hp_filter_enabled(hp);
    solver.set_lp_filter_enabled(lp);
    solver.apply_filter();
    let filt = solver.get_trace();

    let grid: Vec<f32> = filt
        .iter()
        .step_by(upsample_factor.max(1))
        .copied()
        .collect();
    let var_probe = variance(&probe);
    if var_probe <= 0.0 {
        return sigma_raw;
    }
    let gain = (variance(&grid) / var_probe).max(0.0);
    sigma_raw * gain.sqrt()
}

#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct InDecaResult {
    pub s_counts: Vec<f32>,
    /// Calibrated continuous firing-rate estimate (graded), on the same absolute scale
    /// as `s_counts` but not rounded. Populated only by the `mass_count` path; empty
    /// otherwise. See docs/masscount_R_metrics.pdf.
    pub s_rate: Vec<f32>,
    pub filtered_trace: Option<Vec<f32>>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    pub iterations: u32,
    pub converged: bool,
}

/// Run bounded FISTA on a (possibly upsampled) trace.
///
/// Uses Box01 constraint with lambda=0 and BandedAR2 convolution.
/// Returns (relaxed_solution, filtered_trace_if_filtering, iterations, converged).
pub fn solve_bounded(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    let upsampled = upsample_trace(trace, upsample_factor);
    let fs_up = fs * upsample_factor as f64;
    let mut solver = Solver::new();
    solve_upsampled(
        &mut solver,
        &upsampled,
        tau_r,
        tau_d,
        fs_up,
        max_iters,
        tol,
        warm_start,
        hp_enabled,
        lp_enabled,
        Constraint::Box01,
        false,
        0.0,
    )
}

/// Inner FISTA solver operating on an already-upsampled trace.
///
/// Called by `solve_bounded` (public API) and by `solve_trace` (scale iteration).
/// Accepts `solver` by mutable reference so callers can reuse a single allocation
/// across multiple calls (`set_trace` resets all state; buffers grow but never shrink).
///
/// `baseline_subtracted`: when true, the trace has already had its baseline
/// removed externally (via rolling-percentile subtraction), so FISTA should
/// skip its internal baseline estimation (sets `solver.filtered = true`).
fn solve_upsampled(
    solver: &mut Solver,
    upsampled: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    constraint: Constraint,
    baseline_subtracted: bool,
    lambda: f64,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    solver.set_conv_mode(ConvMode::BandedAR2);
    solver.set_params(tau_r, tau_d, lambda, fs_up);
    solver.set_constraint(constraint);
    solver.set_trace(upsampled);

    if baseline_subtracted {
        solver.filtered = true;
    }

    let filtered = if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
        Some(solver.get_trace())
    } else {
        None
    };

    // Apply warm-start if provided (must match trace length)
    if let Some(warm) = warm_start {
        if warm.len() == upsampled.len() {
            solver.solution[..warm.len()].copy_from_slice(warm);
            solver.solution_prev[..warm.len()].copy_from_slice(warm);
        }
    }

    solver.tolerance = tol;

    // Run FISTA in batches
    let batch_size = 50;
    let max_batches = max_iters.div_ceil(batch_size);
    for _ in 0..max_batches {
        if solver.step_batch(batch_size) {
            break;
        }
        if solver.iteration_count() >= max_iters {
            break;
        }
    }

    let solution = solver.get_solution();
    let iterations = solver.iteration_count();
    let converged = solver.converged();

    (solution, filtered, iterations, converged)
}

/// Return the interior slice of `s` excluding `pad` samples from each end.
/// Falls back to the full slice when the interior is empty.
fn interior_slice(s: &[f32], pad: usize) -> &[f32] {
    let n = s.len();
    let lo = pad.min(n);
    let hi = n.saturating_sub(pad).max(lo);
    if hi > lo {
        &s[lo..hi]
    } else {
        s
    }
}

/// Estimate alpha from the interior of the trace (excluding boundary padding).
///
/// Uses peak-to-trough of the inner region to avoid edge artifacts that occur
/// when solving trace subsets that start or end mid-transient.
/// Since the kernel is peak-normalized, peak-to-trough >= alpha, making this
/// a safe overestimate. Returns 1.0 for flat traces.
fn estimate_alpha_interior(trace: &[f32], pad: usize) -> f64 {
    let inner = interior_slice(trace, pad);
    let lo = inner.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = inner.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let ptp = (hi - lo) as f64;
    if ptp < 1e-10 {
        1.0
    } else {
        ptp
    }
}

/// Maximum value in the interior of a slice, excluding `pad` samples from each end.
///
/// Falls back to the full slice when the interior is empty.
fn interior_peak(s: &[f32], pad: usize) -> f32 {
    interior_slice(s, pad)
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
}

/// Full InDeCa trace processing pipeline with scale iteration.
///
/// Mirrors InDeCa's `solve_scale` loop:
/// 1. Upsample, apply optional bandpass filter
/// 2. Estimate initial alpha from trace peak-to-trough
/// 3. Iterate: prescale → Box[0,1] FISTA → threshold search → update alpha
///    until alpha_lstsq converges near 1.0 (prescale matches true amplitude)
/// 4. Recover original-scale alpha, downsample spike train
///
/// The iteration loop is the key difference from the single-pass approach:
/// each round refines the prescale so Box[0,1] maps correctly, preventing
/// the solver from settling on high alpha with too few spikes.
///
/// `warm_counts`: optional spike counts from a previous iteration at the **original**
/// sampling rate. These are upsampled to a binary trace at the upsampled rate and
/// used as FISTA warm-start, which typically reduces iterations by 30-60%.
#[allow(clippy::too_many_arguments)]
pub fn solve_trace(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    warm_counts: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    lambda: f64,
) -> InDecaResult {
    solve_trace_opts(
        trace,
        tau_r,
        tau_d,
        fs,
        upsample_factor,
        max_iters,
        tol,
        warm_counts,
        hp_enabled,
        lp_enabled,
        lambda,
        SolveOptions::default(),
    )
}

/// Mass of a single isolated spike, used to calibrate the
/// mass-based count. Deconvolves a synthetic peak-normalized single-spike
/// transient through the identical Box[0,1] FISTA path, normalizes the relaxed
/// solution to unit interior peak, and integrates it above `mass_floor` (the fixed
/// low floor also used for the events, so both masses cover the whole bump
/// and are comparable).
/// Depends only on (tau, fs_up, mass_floor)
#[allow(clippy::too_many_arguments)]
fn single_spike_mass(
    solver: &mut Solver,
    banded: &BandedAR2,
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    max_iters: u32,
    tol: f64,
    lambda: f64,
    mass_floor: f64,
) -> f64 {
    let n = ((8.0 * tau_d * fs_up).ceil() as usize).max(64);
    let mut s = vec![0.0_f32; n];
    s[n / 2] = 1.0;
    let mut transient = vec![0.0_f32; n];
    banded.convolve_forward(&s, &mut transient); // peak-normalized (peak = 1.0)

    let (relaxed, _, _, _) = solve_upsampled(
        solver,
        &transient,
        tau_r,
        tau_d,
        fs_up,
        max_iters,
        tol,
        None,
        false,
        false,
        Constraint::Box01,
        true,
        lambda,
    );

    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(n / 4);
    let peak = interior_peak(&relaxed, pad);
    if peak <= 1e-10 {
        return 1.0;
    }
    let thr = mass_floor as f32;
    let mass: f64 = relaxed
        .iter()
        .map(|&v| v / peak)
        .filter(|&v| v >= thr)
        .map(|v| v as f64)
        .sum();
    mass.max(1e-6)
}

/// Mass-based count readout. Each maximal contiguous run of the relaxed solution
/// above the low floor `mass_floor` is one event (kept only if its peak clears the
/// realness gate `theta`); its spike count is `round(run_mass / calibration_mass)`
/// (at least 1), where `run_mass` is the integral of the relaxed solution over the
/// run. The `count` spikes are placed within the run (single events at the run peak;
/// bursts spread across the run span) and alpha/baseline are refit by least squares
/// against the resulting event train, so alpha becomes the per-spike amplitude rather
/// than the mass-conserving halved value. `s_rate` is the graded relaxed/calibration_mass
/// over the kept runs — a continuous firing-rate estimate on the same absolute scale.
///
/// Returns `(s_counts, s_rate, alpha, baseline, pve)` at the original rate.
#[allow(clippy::too_many_arguments)]
fn mass_count_readout(
    relaxed: &[f32],
    theta: f64,
    mass_floor: f64,
    working_trace: &[f32],
    banded: &BandedAR2,
    tau_d: f64,
    fs_up: f64,
    upsample_factor: usize,
    calibration_mass: f64,
) -> (Vec<f32>, Vec<f32>, f64, f64, f64) {
    let n = relaxed.len();
    // Runs (events) are extracted down to the low floor mass_floor so the mass covers the
    // whole bump; theta only gates realness (a run is kept iff its peak clears theta). 
    let flo = mass_floor as f32;
    let mut s_events = vec![0.0_f32; n];
    // Graded s_rate: the s_relaxed is scaled by the single-spike
    // calibration mass. Each run integrates to
    // mass/calibration_mass ≈ true count, so summed to the frame rate it is a
    // continuous firing-rate estimate on the correct scale. 
    let mut s_soft = vec![0.0_f32; n];
    let inv_calibration_mass = (1.0 / calibration_mass) as f32;

    let mut i = 0;
    while i < n {
        if relaxed[i] >= flo {
            let start = i;
            let mut mass = 0.0_f64;
            let mut peak = 0.0_f32;
            let mut arg = i;
            while i < n && relaxed[i] >= flo {
                mass += relaxed[i] as f64;
                if relaxed[i] > peak {
                    peak = relaxed[i];
                    arg = i;
                }
                i += 1;
            }
            let end = i; // exclusive
            let span = end - start;
            // Drop runs whose peak never clears the noise/selection floor.
            if (peak as f64) < theta {
                continue;
            }
            // Graded rate over the whole run.
            for t in start..end {
                s_soft[t] = relaxed[t] * inv_calibration_mass;
            }
            let count = (mass / calibration_mass).round().max(1.0) as usize;

            if count <= 1 || span <= 1 {
                s_events[arg] += 1.0; // single event at the run peak
            } else {
                // Spread the events across the run so the reconvolution matches a
                // burst rather than a single tall spike.
                let placeable = count.min(span);
                for j in 0..placeable {
                    let idx = start + (j * span) / placeable + span / (2 * placeable);
                    s_events[idx.min(end - 1)] += 1.0;
                }
                // If there are more events than distinct bins, stack the remainder at the peak.
                if count > placeable {
                    s_events[arg] += (count - placeable) as f32;
                }
            }
        } else {
            i += 1;
        }
    }

    // Refit alpha + baseline against the event train.
    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(n / 4);
    let mut conv = vec![0.0_f32; n];
    banded.convolve_forward(&s_events, &mut conv);
    let (alpha, baseline) = lstsq_alpha_baseline(&conv, working_trace, pad, f64::INFINITY);

    // PVE over the interior.
    let lo = pad;
    let hi = n.saturating_sub(pad);
    let mut pve = 0.0;
    if hi > lo {
        let len = (hi - lo) as f64;
        let mut y_sum = 0.0_f64;
        for i in lo..hi {
            y_sum += working_trace[i] as f64;
        }
        let y_mean = y_sum / len;
        let mut ss_tot = 0.0_f64;
        let mut ss_res = 0.0_f64;
        for i in lo..hi {
            let yi = working_trace[i] as f64;
            let d = yi - y_mean;
            ss_tot += d * d;
            let pred = alpha * conv[i] as f64 + baseline;
            let r = yi - pred;
            ss_res += r * r;
        }
        pve = if ss_tot > 1e-20 { 1.0 - ss_res / ss_tot } else { 0.0 };
    }

    let s_counts = downsample_binary(&s_events, upsample_factor);
    let s_rate = downsample_binary(&s_soft, upsample_factor); // sum graded values per frame
    (s_counts, s_rate, alpha, baseline, pve)
}

/// See [`solve_trace`]; adds optional [`SolveOptions`] for noise-constrained
/// threshold selection.
#[allow(clippy::too_many_arguments)]
pub fn solve_trace_opts(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    warm_counts: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    lambda: f64,
    opts: SolveOptions,
) -> InDecaResult {
    let fs_up = fs * upsample_factor as f64;
    let upsampled = upsample_trace(trace, upsample_factor);

    // Single solver allocation reused across all solve_upsampled calls.
    // set_trace() resets all state; buffers grow but never shrink.
    let mut solver = Solver::new();

    // ── Step 1: Apply optional bandpass filter + rolling baseline subtraction ──
    // Apply bandpass filter directly (if HP/LP enabled), then
    // subtract the rolling-percentile baseline so the floor is ~0.
    let mut working_trace = if hp_enabled || lp_enabled {
        // Apply bandpass filter directly — no need for a full FISTA solve
        solver.set_conv_mode(ConvMode::BandedAR2);
        solver.set_params(tau_r, tau_d, 0.0, fs_up);
        solver.set_trace(&upsampled);
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
        solver.get_trace()
    } else {
        upsampled
    };

    // Rolling-percentile baseline subtraction: brings the floor to ~0.
    let bl_window = crate::baseline::baseline_window(tau_d, fs_up);
    crate::baseline::subtract_rolling_baseline(
        &mut working_trace,
        bl_window,
        crate::baseline::DEFAULT_BASELINE_QUANTILE,
    );

    // ── Step 2: Boundary padding + initial alpha estimate ───────────────
    // Compute boundary padding: edge effects from AR2 convolution make the first
    // and last `pad` samples unreliable. When solving trace subsets (common in
    // CaDecon iteration), the trace may start mid-transient, creating a large
    // spurious spike at position 0. Zeroing the boundary region of the FISTA
    // solution prevents these edge artifacts from corrupting the threshold search.
    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(working_trace.len() / 4);

    // Estimate alpha from the interior of the trace only (excluding edges).
    let mut alpha_est = estimate_alpha_interior(&working_trace, pad);

    // Convert original-rate spike counts to upsampled-rate binary for warm-start.
    // upsample_counts_to_binary centers spikes on original sample positions,
    // matching the centered bins used by downsample_binary.
    let warm_binary = warm_counts.map(|counts| upsample_counts_to_binary(counts, upsample_factor));

    let banded = BandedAR2::new(tau_r, tau_d, fs_up);

    // Noise-constrained threshold selection needs the per-sample noise std of the
    // filtered trace at the original grid. Estimated LP-cutoff-agnostically from
    // the raw trace's high band scaled by the filter chain's measured noise gain.
    // Fully data-derived — no knob.
    let selection = if opts.noise_constrained {
        Selection::NoiseFloor {
            sigma: estimate_grid_noise_sigma(
                trace,
                upsample_factor,
                tau_r,
                tau_d,
                fs_up,
                hp_enabled,
                lp_enabled,
            ),
        }
    } else {
        Selection::MaxPve
    };

    // ── Step 3: Scale iteration loop ────────────────────────────────────
    // Each round: prescale by alpha_est → Box[0,1] FISTA → threshold search
    // against the *original* trace → lstsq recovers alpha directly.
    // Converges when alpha_lstsq ≈ alpha_est (prescale matches true amplitude).
    const MAX_SCALE_ITERS: usize = 10;
    const SCALE_RTOL: f64 = 0.05;

    let mut best_pve = f64::NEG_INFINITY;
    let mut best_scale_err = f64::INFINITY;
    let mut best_result: Option<(Vec<f32>, f64, f64, f64, f64, u32, bool)> = None;
    // Relaxed (normalized) solution of the selected iterate — only needed for
    // the mass-count readout, so captured only when that mode is on.
    let mut best_relaxed: Vec<f32> = Vec::new();

    // Pre-allocate scratch buffers reused across scale iterations.
    let wt_len = working_trace.len();
    let mut scaled = vec![0.0_f32; wt_len];
    let mut s_normalized = vec![0.0_f32; wt_len];

    for scale_iter in 0..MAX_SCALE_ITERS {
        // Fill scaled buffer in-place (multiply by reciprocal instead of dividing).
        let inv_alpha = 1.0 / alpha_est as f32;
        for i in 0..wt_len {
            scaled[i] = working_trace[i] * inv_alpha;
        }

        // Use warm-start from user on first iteration only;
        // subsequent iterations start fresh with the refined prescale.
        let warm_start = if scale_iter == 0 {
            warm_binary.as_deref()
        } else {
            None
        };

        let (s_relaxed, _, iterations, converged) = solve_upsampled(
            &mut solver,
            &scaled,
            tau_r,
            tau_d,
            fs_up,
            max_iters,
            tol,
            warm_start,
            false,
            false,
            Constraint::Box01,
            true, // trace is baseline-subtracted → skip FISTA baseline estimation
            lambda,
        );

        // Normalize relaxed solution to [0,1] before threshold search.
        // Use the interior peak only (excluding boundary padding) so that edge
        // artifacts from trace subsets starting mid-transient don't dominate.
        let s_peak = interior_peak(&s_relaxed, pad);
        if s_peak > 1e-10 {
            let inv_peak = 1.0 / s_peak;
            for i in 0..s_relaxed.len() {
                s_normalized[i] = s_relaxed[i] * inv_peak;
            }
        } else {
            s_normalized[..s_relaxed.len()].copy_from_slice(&s_relaxed);
        }
        let s_norm_slice = &s_normalized[..s_relaxed.len()];

        // Threshold search fits binarized spikes against the ORIGINAL trace.
        let ThresholdResult {
            s_binary,
            alpha: alpha_lstsq,
            baseline: baseline_lstsq,
            threshold,
            pve,
            ..
        } = threshold_search_opts(
            s_norm_slice,
            &working_trace,
            &banded,
            tau_d,
            fs_up,
            upsample_factor,
            f64::INFINITY,
            selection,
        );

        // Scale-loop convergence error: how close the lstsq-recovered alpha is to
        // the prescale used this round. This is the loop's own objective.
        let scale_err = if alpha_est > 1e-10 {
            (alpha_lstsq / alpha_est - 1.0).abs()
        } else {
            f64::INFINITY
        };

        // Select the best iterate across scale rounds. alpha_lstsq is already the
        // true alpha (fit against the original trace).
        //
        // MaxPve keeps the highest-PVE iterate (historical behavior). Under
        // NoiseFloor, ranking by PVE would defeat the criterion — the inner search
        // deliberately stops at the noise floor (below max PVE), so a max-PVE outer
        // pick would re-select the densest-fitting iteration and re-launder the
        // sparsity. Instead select the best-calibrated prescale (smallest scale
        // error) — the scale loop's own fixed point, which is criterion-neutral.
        let is_better = match selection {
            Selection::MaxPve => pve > best_pve,
            Selection::NoiseFloor { .. } => scale_err < best_scale_err,
        };
        if is_better {
            if opts.mass_count {
                best_relaxed = s_norm_slice.to_vec();
            }
            best_pve = pve;
            best_scale_err = scale_err;
            best_result = Some((
                s_binary,
                alpha_lstsq,
                baseline_lstsq,
                threshold,
                pve,
                iterations,
                converged,
            ));
        }

        // Converged: alpha_lstsq ≈ alpha_est means the prescale was correct.
        if scale_err < SCALE_RTOL {
            break;
        }

        // Update alpha_est to the lstsq-recovered value for the next round.
        if alpha_lstsq < 1e-10 {
            break;
        }
        alpha_est = alpha_lstsq;
    }

    // ── Step 4: Extract best result ─────────────────────────────────────
    let (s_binary, mut alpha, mut baseline, threshold, mut pve, iterations, converged) = best_result
        .unwrap_or_else(|| {
            // Fallback: no valid result found (shouldn't happen)
            (vec![0.0; wt_len], 0.0, 0.0, 0.0, 0.0, 0, false)
        });

    // ── Step 4b (optional): mass-based count readout ────────────────────
    // Replace the bin-summed binary count with a mass-based event count that
    // undoes the coherent-grid overcount (see [`SolveOptions::mass_count`]).
    // `s_rate` (mass_count only): calibrated continuous firing-rate estimate — graded and
    // on the correct absolute scale, complementary to the integer `s_counts` (empty otherwise).
    let (s_counts, s_rate) = if opts.mass_count && !best_relaxed.is_empty() && threshold > 1e-9 {
        // Mass is integrated over the WHOLE bump down to a fixed low floor mass_floor,
        // not the (possibly near-peak) selection threshold — integrating at the tip
        // is ill-conditioned (see docs/cadecon-mass-count.md §"calibration floor").
        // The selection threshold is used only as a realness gate (peak >= threshold).
        let mass_floor = (0.5 / upsample_factor.max(1) as f64).min(0.15);
        let calibration_mass = single_spike_mass(
            &mut solver, &banded, tau_r, tau_d, fs_up, max_iters, tol, lambda, mass_floor,
        );
        let (s_counts_mc, s_rate_mc, alpha_mc, baseline_mc, pve_mc) = mass_count_readout(
            &best_relaxed,
            threshold, // realness gate (peak >= threshold)
            mass_floor,
            &working_trace,
            &banded,
            tau_d,
            fs_up,
            upsample_factor,
            calibration_mass,
        );
        alpha = alpha_mc;
        baseline = baseline_mc;
        pve = pve_mc;
        (s_counts_mc, s_rate_mc)
    } else {
        // Downsample binary spike train to original rate using centered bins.
        // s_rate is only produced by the mass-count path.
        (downsample_binary(&s_binary, upsample_factor), Vec::new())
    };

    // Downsample filtered trace to original rate directly from working_trace
    // (working_trace is not modified after baseline subtraction).
    let filtered_trace = Some(downsample_average(&working_trace, upsample_factor));

    InDecaResult {
        s_counts,
        s_rate,
        filtered_trace,
        alpha,
        baseline,
        threshold,
        pve,
        iterations,
        converged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::build_kernel;

    /// Build a clean trace: convolve spikes through the kernel.
    fn make_trace(tau_r: f64, tau_d: f64, fs: f64, n: usize, spike_pos: &[usize]) -> Vec<f32> {
        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![0.0_f32; n];
        for &s in spike_pos {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }
        trace
    }

    #[test]
    fn outputs_in_range() {
        let trace = make_trace(0.02, 0.4, 30.0, 300, &[20, 80, 150, 220]);
        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 500, 1e-4, None, false, false, 0.0,
        );

        // Spike counts should be non-negative
        for (i, &v) in result.s_counts.iter().enumerate() {
            assert!(v >= 0.0, "Negative spike count at {}: {}", i, v);
        }

        // Output length should match input
        assert_eq!(result.s_counts.len(), trace.len());
    }

    #[test]
    fn known_spike_detection() {
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }
        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 1000, 1e-4, None, false, false, 0.0,
        );

        // Check that spikes are detected near the true positions
        let mut detected = 0;
        for &pos in &spike_positions {
            // Check a window around the true position
            let lo = pos.saturating_sub(3);
            let hi = (pos + 3).min(result.s_counts.len());
            let max_in_window: f32 = result.s_counts[lo..hi].iter().copied().fold(0.0, f32::max);
            if max_in_window > 0.1 {
                detected += 1;
            }
        }

        assert!(
            detected >= 2,
            "Should detect at least 2 of 3 spikes, detected {}",
            detected
        );
    }

    #[test]
    fn warm_start_converges_faster() {
        let trace = make_trace(0.02, 0.4, 30.0, 200, &[20, 80, 150]);

        // Get the cold solution for warm-start
        let (cold_sol, _, _, _) =
            solve_bounded(&trace, 0.02, 0.4, 30.0, 1, 500, 1e-4, None, false, false);

        // Warm solve with slightly different taus
        let (_, _, warm_iters, _) = solve_bounded(
            &trace,
            0.025,
            0.45,
            30.0,
            1,
            500,
            1e-4,
            Some(&cold_sol),
            false,
            false,
        );

        // Warm-start may or may not be faster depending on how different the params are,
        // but it should at least produce a valid result
        assert!(warm_iters > 0, "Should run at least 1 iteration");
        // For very similar params, warm-start should typically help
        // (but not guaranteed in all cases, so we just check it runs)
    }

    #[test]
    fn upsampled_output_length() {
        let trace = make_trace(0.02, 0.4, 30.0, 100, &[20, 50]);
        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 10, 200, 1e-3, None, false, false, 0.0,
        );

        // Output should be same length as input regardless of upsample factor
        assert_eq!(
            result.s_counts.len(),
            trace.len(),
            "Output length should match input after downsampling"
        );
    }

    #[test]
    fn zero_trace() {
        let trace = vec![0.0_f32; 100];
        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 100, 1e-4, None, false, false, 0.0,
        );
        let total_spikes: f32 = result.s_counts.iter().sum();
        assert!(
            total_spikes < 1e-6,
            "Zero trace should produce no spikes, got {}",
            total_spikes
        );
    }

    /// High alpha + upsampling should not overcount.
    ///
    /// Before the fix, alpha=5 + upsample=10x produced ~41 detected spikes because
    /// Box[0,1] FISTA spread energy to neighboring upsampled bins. Pre-dividing by
    /// alpha_est before threshold search fixes this.
    #[test]
    fn high_alpha_upsampled_no_overcounting() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n = 300;
        let spike_positions = [20, 80, 150, 220];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(
            &trace, tau_r, tau_d, fs, 10, 500, 1e-4, None, false, false, 0.0,
        );

        let total_counts: f32 = result.s_counts.iter().sum();

        // With 10x upsampling + baseline subtraction, each spike can spread to
        // several upsampled bins. The count may exceed the true spike count, but
        // alpha × count (total energy) should still be conserved.
        assert!(
            total_counts >= 2.0 && total_counts <= 30.0,
            "Expected spike counts in [2, 30] at 10x upsample, got {}",
            total_counts
        );

        // Alpha × spike_count should approximate the total transient energy.
        // true energy = 4 spikes × alpha 10 = 40
        let total_energy = result.alpha * total_counts as f64;
        let expected_energy = spike_positions.len() as f64 * alpha_true as f64;
        assert!(
            (total_energy - expected_energy).abs() < expected_energy * 0.5,
            "Total energy (alpha×count) should be ~{}, got {} (alpha={}, counts={})",
            expected_energy,
            total_energy,
            result.alpha,
            total_counts
        );

        // PVE should be very high on clean synthetic data
        assert!(
            result.pve > 0.95,
            "PVE should be > 0.95, got {}",
            result.pve
        );
    }

    /// Trace subset starting mid-transient should not produce spurious edge spikes.
    /// In CaDecon, each cell is solved on a time-window subset. When the subset
    /// starts during a calcium transient, the first samples are mid-decay and FISTA
    /// may try to explain them with a spike at position 0. The boundary masking
    /// should prevent this from dominating the result.
    #[test]
    fn trace_subset_mid_transient() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n_full = 600;
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let spike_positions = [10, 80, 160, 250, 340, 450, 550];
        let mut full_trace = vec![baseline_true; n_full];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n_full {
                    full_trace[pos + k] += alpha_true * kv;
                }
            }
        }

        // Take a subset that starts mid-transient (during the decay after spike at 10)
        let subset_start = 15; // 5 samples after the spike — deep in the decay
        let subset_end = 400;
        let subset = &full_trace[subset_start..subset_end];

        let result = solve_trace(
            subset, tau_r, tau_d, fs, 1, 1000, 1e-4, None, false, false, 0.0,
        );
        let total_spikes: f32 = result.s_counts.iter().sum();

        // Should detect interior spikes, not just the edge artifact
        assert!(
            total_spikes >= 3.0,
            "Should detect at least 3 interior spikes from subset, got {} (alpha={:.2}, threshold={:.4}, pve={:.4})",
            total_spikes, result.alpha, result.threshold, result.pve
        );

        // PVE should be reasonable (not garbage from a single edge spike)
        assert!(result.pve > 0.7, "PVE should be > 0.7, got {}", result.pve);
    }

    /// High baseline should not prevent spike detection.
    /// Real calcium traces often have baseline >> transient amplitude.
    #[test]
    fn high_baseline_spike_detection() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n = 300;
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 100.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(
            &trace, tau_r, tau_d, fs, 1, 1000, 1e-4, None, false, false, 0.0,
        );
        let total_spikes: f32 = result.s_counts.iter().sum();

        assert!(
            total_spikes >= 2.0,
            "Should detect at least 2 spikes with high baseline, got {} (alpha={:.2}, threshold={:.4}, pve={:.4})",
            total_spikes, result.alpha, result.threshold, result.pve
        );
    }

    /// Fast guard for the readout logic (no FISTA): a run of mass ≈ calibration_mass
    /// counts as one spike, a run of mass ≈ 2·calibration_mass as two, a sub-threshold
    /// run is dropped, and s_rate is the graded relaxed/calibration_mass over kept runs.
    #[test]
    fn mass_count_readout_counts_and_gates() {
        use crate::banded::BandedAR2;
        let (tau_d, fs_up, factor) = (0.6, 300.0, 10usize);
        let banded = BandedAR2::new(0.1, tau_d, fs_up);
        let n = 300;
        let calibration_mass = 3.0; // mass of the unit bump below
        let (theta, mass_floor) = (0.5, 0.05);

        let mut relaxed = vec![0.0_f32; n];
        for (o, &v) in [0.3, 0.7, 1.0, 0.7, 0.3].iter().enumerate() {
            relaxed[90 + o] = v; // event A: mass 3.0 = calibration_mass → count 1
        }
        for (o, &v) in [0.6, 1.0, 1.0, 1.0, 1.0, 1.0, 0.4].iter().enumerate() {
            relaxed[130 + o] = v; // burst B: one run, mass 6.0 = 2·calibration_mass → count 2
        }
        relaxed[190] = 0.3; // sub-threshold C: peak 0.3 < theta → gated out
        relaxed[191] = 0.3;

        // Working trace correlated with the events so the alpha refit is well-posed.
        let mut probe = vec![0.0_f32; n];
        for &p in &[92usize, 131, 134] {
            probe[p] = 1.0;
        }
        let mut wt = vec![0.0_f32; n];
        banded.convolve_forward(&probe, &mut wt);
        for v in wt.iter_mut() {
            *v = 5.0 * *v + 2.0;
        }

        let (s_counts, s_rate, alpha, _b, _pve) = mass_count_readout(
            &relaxed, theta, mass_floor, &wt, &banded, tau_d, fs_up, factor, calibration_mass,
        );

        // counts: A → 1, B → 2, C gated → total 3
        assert!((s_counts.iter().sum::<f32>() - 3.0).abs() < 1e-6);
        // s_rate integrates to (3+6)/calibration_mass = 3 over kept runs, graded (fractional)
        assert!((s_rate.iter().sum::<f32>() - 3.0).abs() < 1e-2);
        assert!(s_rate.iter().any(|&v| (v - v.round()).abs() > 0.05));
        assert!(alpha.is_finite() && alpha > 0.0);
    }

    /// mass_count readout restores an unbiased alpha and spike count at the
    /// default 10x upsample, where the bin-sum readout inflates the count ~k x
    /// and halves alpha. Uses moderate (~1 Hz) firing where events are mostly
    /// temporally resolvable, so both count and alpha should recover.
    #[test]
    #[ignore = "slow end-to-end regression (2 full + 2 calibration solves); run in CI with `cargo test -- --ignored`"]
    fn mass_count_restores_alpha_and_count() {
        let tau_r = 0.1;
        let tau_d = 0.6;
        let fs = 30.0;
        let n = 1500;
        let factor = 10;
        let alpha_true = 5.0_f32;
        let baseline = 2.0_f32;
        let kernel = build_kernel(tau_r, tau_d, fs);

        // Deterministic ~1 Hz spike train (xorshift; no rand/Date dependency).
        let mut seed: u64 = 0x51A5_2025;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let p = 1.0 / fs; // ~1 Hz
        let mut s_true = vec![0.0_f32; n];
        for v in s_true.iter_mut() {
            if next() < p {
                *v = 1.0;
            }
        }
        let n_true: f32 = s_true.iter().sum();
        let mut trace = vec![baseline; n];
        for i in 0..n {
            if s_true[i] > 0.5 {
                for (k, &kv) in kernel.iter().enumerate() {
                    if i + k < n {
                        trace[i + k] += alpha_true * kv;
                    }
                }
            }
        }
        // SNR ~20 additive Gaussian noise.
        let sigma = alpha_true / 20.0;
        for v in trace.iter_mut() {
            let u1 = next().max(1e-12);
            let u2 = next();
            let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
            *v += (z as f32) * sigma;
        }

        let solve = |mass_count: bool| {
            solve_trace_opts(
                &trace, tau_r, tau_d, fs, factor, 1000, 1e-4, None, false, false, 0.0,
                SolveOptions { noise_constrained: true, mass_count },
            )
        };

        // Baseline (current behavior): alpha collapses, count inflates.
        let off = solve(false);
        let count_off: f32 = off.s_counts.iter().sum();
        let alpha_ratio_off = off.alpha / alpha_true as f64;
        assert!(
            alpha_ratio_off < 0.4,
            "sanity: without mass_count alpha should be badly under-estimated, got ratio {:.3}",
            alpha_ratio_off
        );
        assert!(
            count_off as f32 / n_true > 2.0,
            "sanity: without mass_count count should be inflated, got ratio {:.2}",
            count_off / n_true
        );

        // Fixed: alpha and count both recover.
        let on = solve(true);
        let count_on: f32 = on.s_counts.iter().sum();
        let alpha_ratio_on = on.alpha / alpha_true as f64;
        let count_ratio_on = count_on / n_true;
        assert!(
            (0.8..=1.2).contains(&alpha_ratio_on),
            "mass_count alpha ratio should be ~1, got {:.3} (count_ratio {:.2})",
            alpha_ratio_on,
            count_ratio_on
        );
        assert!(
            (0.75..=1.25).contains(&count_ratio_on),
            "mass_count count ratio should be ~1 at 1 Hz, got {:.2} (alpha_ratio {:.3})",
            count_ratio_on,
            alpha_ratio_on
        );
    }

    /// HP+LP filter path should produce valid results and return a filtered trace.
    #[test]
    fn filter_path_hp_lp() {
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 1000, 1e-4, None, true, true, 0.0,
        );

        // Output length should match input
        assert_eq!(result.s_counts.len(), trace.len());

        // Spike counts should be non-negative
        for (i, &v) in result.s_counts.iter().enumerate() {
            assert!(v >= 0.0, "Negative spike count at {}: {}", i, v);
        }

        // Filtered trace should be returned and have the correct length
        let filtered = result
            .filtered_trace
            .as_ref()
            .expect("filtered_trace should be Some when filters are enabled");
        assert_eq!(filtered.len(), trace.len());

        // Should still detect spikes through the filter
        let total_spikes: f32 = result.s_counts.iter().sum();
        assert!(
            total_spikes >= 1.0,
            "Should detect at least 1 spike with HP+LP filter, got {} (pve={:.4})",
            total_spikes,
            result.pve
        );
    }

    /// HP-only filter path should remove DC and still detect spikes.
    #[test]
    fn filter_path_hp_only() {
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 50.0_f32; // high DC offset
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 1000, 1e-4, None, true, false, 0.0,
        );

        assert_eq!(result.s_counts.len(), trace.len());

        // Filtered trace should be returned
        assert!(result.filtered_trace.is_some());

        // Should still detect spikes
        let total_spikes: f32 = result.s_counts.iter().sum();
        assert!(
            total_spikes >= 1.0,
            "Should detect at least 1 spike with HP-only filter, got {} (pve={:.4})",
            total_spikes,
            result.pve
        );
    }

    /// LP-only filter path should preserve DC and detect spikes.
    #[test]
    fn filter_path_lp_only() {
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(
            &trace, 0.02, 0.4, 30.0, 1, 1000, 1e-4, None, false, true, 0.0,
        );

        assert_eq!(result.s_counts.len(), trace.len());
        assert!(result.filtered_trace.is_some());

        // Should still detect spikes
        let total_spikes: f32 = result.s_counts.iter().sum();
        assert!(
            total_spikes >= 1.0,
            "Should detect at least 1 spike with LP-only filter, got {} (pve={:.4})",
            total_spikes,
            result.pve
        );
    }

    /// Deterministic white-ish noise in [-amp, amp) (variance ≈ amp²/3).
    fn lcg_noise(n: usize, amp: f32, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let u = ((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0;
                (u as f32) * amp
            })
            .collect()
    }

    #[test]
    fn high_band_sigma_recovers_white_noise_std() {
        // On pure white noise the high-band periodogram mean estimates the noise
        // variance, so its sqrt should recover the injected std.
        let n = 4096;
        let amp = 0.3_f32;
        let noise = lcg_noise(n, amp, 0x1234_5678);
        let sigma_true = (amp as f64) / 3.0_f64.sqrt();
        let sigma_est = high_band_sigma(&noise);
        let rel = (sigma_est - sigma_true).abs() / sigma_true;
        assert!(
            rel < 0.15,
            "estimated sigma {:.4} should match injected {:.4} (rel err {:.3})",
            sigma_est,
            sigma_true,
            rel
        );
    }

    #[test]
    fn noise_constrained_recovers_events_on_noisy_trace() {
        // Exercise the noise-floor selection path end-to-end (solve_trace_opts →
        // estimate_grid_noise_sigma → Selection::NoiseFloor) on a genuinely noisy
        // trace. It should recover the real events with a reasonable fit and not
        // wildly overcount. The per-trace count is NOT guaranteed to be below the
        // max-PVE default — the two criteria use different search strategies — so
        // the sparsity ordering is asserted deterministically in the threshold
        // unit test `noise_floor_larger_budget_is_sparser` instead.
        let spike_positions = [30usize, 100, 200, 260];
        let alpha_true = 6.0_f32;
        let baseline_true = 2.0_f32;
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }
        let noise = lcg_noise(n, 0.4, 0x0BADC0DE);
        for (t, &e) in trace.iter_mut().zip(&noise) {
            *t += e;
        }

        let constrained = solve_trace_opts(
            &trace,
            0.02,
            0.4,
            30.0,
            1,
            500,
            1e-4,
            None,
            false,
            false,
            0.0,
            SolveOptions {
                noise_constrained: true,
                mass_count: false,
            },
        );

        assert_eq!(constrained.s_counts.len(), n);
        let count: f32 = constrained.s_counts.iter().sum();
        assert!(
            (1.0..=(spike_positions.len() as f32 * 2.0)).contains(&count),
            "should recover the events without gross overcounting, got {}",
            count
        );
        assert!(
            constrained.pve > 0.5,
            "fit should be reasonable, pve {}",
            constrained.pve
        );
    }
}
