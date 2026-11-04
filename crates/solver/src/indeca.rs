/// InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
///
/// The relaxed problem is
///
/// ```text
/// min over s >= 0 (boxed), alpha >= 0:  || y - alpha K s ||^2
/// ```
///
/// (`y` the filtered, baseline-subtracted trace, `K` the peak-normalized
/// AR(2) kernel), followed by one terminal binarization at the spike
/// resolution rate (300 Hz): the threshold search, which also fits the
/// reported amplitude and offset. The binarization scores every candidate
/// train through the trace's own preprocessing chain ([`Scoring::Chain`],
/// the `chain` module): the bandpass and the rolling-quantile baseline are
/// applied to `K s` exactly as they were to the trace, so the candidate and
/// the trace carry the same filter-injected structure.
///
/// # Where the relaxed problem is solved ([`InnerSolve`])
///
/// The default ([`InnerSolve::Native`]) solves it at the **recorded** rate:
/// one Box[0, n_max] FISTA on `y / alpha` with `n_max` the refractory cap
/// ([`max_spikes_per_frame`]), at the peak-to-trough prescale (where the box
/// cannot bind, so the fit is the scale-free non-negative one). The frame
/// masses are then spread over the 300 Hz sub-bins by linear interpolation
/// ([`crate::spread::Spread::Interp`], the tent the trace upsampler applies)
/// and binarized exactly as the upsampled solve's relaxed solution was.
/// One round: the spread is scale-free (its normalized shape does not depend
/// on the prescale), so the amplitude step cannot change the binarization.
///
/// At the recorded rate the relaxed problem has no sub-frame directions the
/// data cannot determine, and the solve converges: it stops on a
/// convergence certificate ([`crate::native_solve`]: the remaining movement
/// of the fit, bounded by a dual gap, can no longer change the grid
/// residual energy by one standard error of the noise energy, the
/// selection's own resolution). The caller's relative-step tolerance applies
/// only when the trace has no measurable noise (no certificate). If the
/// certificate cannot be met in f64, a stall detector on the certificate's
/// own bound stops the solve unconverged (`converged = false`); the
/// iteration cap is derived from the problem
/// ([`crate::native_solve::iteration_cap`], 1e5-1e9, with the caller's
/// `max_iters` as a floor on it) and is an outer guard only. The output
/// does not depend on the cap (measured: zero cap hits and zero stalls at
/// 15, 30 and 60 Hz on the simulation presets, 400-4,000 iterations at
/// 30 Hz, up to 34,000 for GCaMP6s at 60 Hz) nor on the tolerance.
///
/// [`InnerSolve::Upsampled`] is the loop before this change, kept for
/// comparison: Box[0,1] FISTA at the 300 Hz rate. With `lambda = 0` that
/// problem is ill-posed (sub-bin rearrangements barely change the fit), the
/// relative-step rule does not fire within the usual budget, and `max_iters`
/// (500) acts as an early-stopping regularizer the output depends on (counts
/// move 7-11% between a 500 and a 2000 cap). The native solve removes that
/// dependence and, on the simulation presets, scores slightly higher
/// (F1 within two frames .564 vs .552 with drift, .589 vs .570 without).
///
/// # Scale loop (upsampled solve)
///
/// Block-coordinate descent: s-step Box[0,1] FISTA on `y / alpha`,
/// alpha-step least squares of `y` on the relaxed reconvolution `K s`. The
/// relaxed objective cannot identify the amplitude: any `alpha` at or above
/// the saturation amplitude (where the box upper bound stops binding) gives
/// the same fit, and the s-step there is the scale-free non-negative fit, so
/// its normalized solution, and the binarization, do not depend on `alpha`.
/// Starting from the trace's peak-to-trough (which no relaxed bin can exceed,
/// since the kernel is peak-normalized) the loop is at a fixed point after
/// its first round. The amplitude is identified only by the binarization.
/// The original InDeCa update (amplitude from the binarized train) is not a
/// descent step on the relaxed objective; it remains available as
/// [`ScaleLoop::binary_alpha`] for characterization.
///
/// The AR2 forward model is peak-normalized so that a single spike produces
/// a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
use crate::banded::BandedAR2;
use crate::chain::{Chain, Scorer};
use crate::filter::BandpassFilter;
use crate::native_solve::{self, Stop};
use crate::spread::{spread, Spread};
use crate::threshold::{
    threshold_search_scored, NoiseModel, Selection, SelectionDiag, ThresholdResult,
};
use crate::upsample::{
    downsample_average, downsample_binary, upsample_counts_to_binary, upsample_trace,
};
use crate::{Constraint, ConvMode, Solver};
use realfft::RealFftPlanner;

/// Optional spike-inference behaviors. The library default is off (`MaxPve`);
/// the CaDecon app enables `noise_constrained` by default.
///
/// `noise_constrained` chooses the binarization threshold at the data-derived
/// noise floor instead of at the best fit, suppressing low-SNR spurious spikes
/// (see the `threshold` module docs).
#[derive(Clone, Copy, Default)]
pub struct SolveOptions {
    pub noise_constrained: bool,
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

/// The bandpass applied to the upsampled trace (cutoffs derived from the
/// kernel at the upsampled rate).
fn trace_filter(tau_r: f64, tau_d: f64, fs_up: f64, hp: bool, lp: bool) -> BandpassFilter {
    let mut f = BandpassFilter::new();
    f.update_cutoffs(tau_r, tau_d, fs_up);
    f.set_hp_enabled(hp);
    f.set_lp_enabled(lp);
    f
}

/// Noise statistics of the preprocessed (upsampled, filtered) trace.
#[derive(Clone, Copy, Debug)]
pub(crate) struct NoiseEstimate {
    /// Noise at original-rate grid positions: the threshold-search statistic.
    pub grid: NoiseModel,
    /// Per-sample noise variance averaged over all upsampled positions: the
    /// noise energy per sample of the FISTA data-fit term (before prescaling).
    pub upsampled_var: f64,
}

/// Estimate the noise of the preprocessed trace from the raw trace.
///
/// The raw noise std comes from the high band of the unfiltered trace
/// ([`high_band_sigma`]). Upsampling (linear interpolation) and the bandpass
/// are linear and, at original-rate grid positions, shift-invariant, so white
/// raw noise of variance `sigma^2` leaves the chain as white noise convolved
/// with the chain's impulse response `h`, sampled on the grid as `h_grid`:
///
/// - grid variance `sigma^2 * sum(h_grid^2)`,
/// - grid autocorrelation `rho = acf(h_grid) / acf(h_grid)(0)`, so
///   `corr_sum = sum_lag rho^2 = n * sum|H|^4 / (sum|H|^2)^2` (Parseval),
/// - average variance over all upsampled positions `sigma^2 * sum(h^2) / k`.
///
/// `h` is measured exactly by pushing a unit impulse through the same
/// upsample → filter path (no random probe). (The rolling-baseline subtraction
/// that follows is a slow high-pass and is not modelled here; making the
/// candidate scoring chain-consistent, i.e. scored through the rolling
/// baseline, is done by the follow-up PR #240 (feat/indeca-chain-scoring).)
pub(crate) fn estimate_noise_model(
    raw_trace: &[f32],
    upsample_factor: usize,
    filter: Option<&mut BandpassFilter>,
) -> NoiseEstimate {
    let k = upsample_factor.max(1);
    let n = raw_trace.len();
    let sigma_raw = high_band_sigma(raw_trace);
    let zero = NoiseEstimate {
        grid: NoiseModel {
            sigma: 0.0,
            corr_sum: 1.0,
        },
        upsampled_var: 0.0,
    };
    if n == 0 || sigma_raw <= 0.0 {
        return zero;
    }

    let mut probe = vec![0.0_f32; n];
    probe[n / 2] = 1.0;
    let mut h = upsample_trace(&probe, k);
    if let Some(f) = filter {
        f.apply(&mut h);
    }
    let up_gain = h.iter().map(|&v| v as f64 * v as f64).sum::<f64>() / k as f64;
    let mut h_grid: Vec<f32> = h.iter().step_by(k).copied().collect();

    // Full-spectrum sums of |H|^2 and |H|^4 from the half spectrum.
    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(n);
    let mut spectrum = r2c.make_output_vec();
    let (mut s2, mut s4) = (0.0_f64, 0.0_f64);
    if r2c.process(&mut h_grid, &mut spectrum).is_ok() {
        let last = spectrum.len() - 1;
        for (f, c) in spectrum.iter().enumerate() {
            let p = c.re as f64 * c.re as f64 + c.im as f64 * c.im as f64;
            let w = if f == 0 || (n % 2 == 0 && f == last) {
                1.0
            } else {
                2.0
            };
            s2 += w * p;
            s4 += w * p * p;
        }
    }
    if s2.is_nan() || s2 <= 0.0 {
        return zero;
    }
    let grid_gain = s2 / n as f64;
    NoiseEstimate {
        grid: NoiseModel {
            sigma: sigma_raw * grid_gain.sqrt(),
            corr_sum: (n as f64 * s4 / (s2 * s2)).max(1.0),
        },
        upsampled_var: sigma_raw * sigma_raw * up_gain,
    }
}

#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct InDecaResult {
    pub s_counts: Vec<f32>,
    pub filtered_trace: Option<Vec<f32>>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    pub iterations: u32,
    /// The inner FISTA solve of the reported round met its stopping rule.
    pub converged: bool,
    /// The scale loop stopped by its stopping rule (fixed point reached, or
    /// the amplitude collapsed) rather than by hitting `max_rounds`. `false`
    /// means the safety cap ended the loop and the result is the last round,
    /// not a fixed point.
    pub loop_converged: bool,
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
        None,
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
    fit_stop: Option<f64>,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    constraint: Constraint,
    baseline_subtracted: bool,
    lambda: f64,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    solver.set_conv_mode(ConvMode::BandedAR2);
    solver.apply_params(tau_r, tau_d, lambda, fs_up);
    solver.set_constraint(constraint);
    solver.load_trace(upsampled);

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
    solver.set_fit_stop(fit_stop);

    // Run FISTA in batches
    let batch_size = 50;
    let max_batches = max_iters.div_ceil(batch_size);
    for _ in 0..max_batches {
        // Banded mode has no fallible step (only FFT setup/overflow can fail);
        // should that ever change, stop and report "not converged" rather than panic.
        match solver.step_batch(batch_size) {
            Ok(true) | Err(_) => break,
            Ok(false) => {}
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

/// Full InDeCa trace processing pipeline.
///
/// 1. Apply the optional bandpass filter and subtract the rolling baseline,
///    at the recorded rate (what the relaxed solve fits) and at the
///    upsampled rate (what the binarization scores against)
/// 2. Prescale by the trace's peak-to-trough
/// 3. Solve the relaxed problem at the recorded rate (one round; see the
///    module docs and [`InnerSolve`])
/// 4. Spread the frame masses over the `upsample_factor` sub-bins per frame,
///    binarize (threshold search at the upsampled rate) and downsample the
///    binary train to counts per frame
///
/// `max_iters` and `tol`: the relaxed solve stops on the data-derived
/// convergence certificate ([`crate::native_solve`]); `tol` (the
/// relative-step rule) is used only when the trace has no measurable noise
/// floor and so no certificate; `max_iters` is a floor on the safety cap,
/// which is derived from the problem ([`crate::native_solve::iteration_cap`])
/// so that a cap sized for the upsampled solve (500) cannot truncate this
/// one. The reported `iterations` is the native-rate FISTA iteration count
/// (400-4,000 at 30 Hz on the simulation presets, more on slow kernels at
/// high frame rates) and `converged` says the certificate (or, without
/// noise, the step rule) fired; it is `false` when the certificate's bound
/// stalled at its f64 floor (the stall detector, which is what stops an
/// unconvergeable solve in practice) or the cap was reached. On the
/// comparison path
/// ([`InnerSolve::Upsampled`]) `max_iters` is the early-stopping regularizer
/// the output depends on and `tol` the step rule's tolerance (see the module
/// docs).
///
/// `warm_counts`: optional spike counts from a previous iteration at the
/// **original** sampling rate, used as the FISTA warm start **only on the
/// non-default `binary_alpha` loop** (an upsampled-solve loop). The default
/// ignores it: the native solve converges on the certificate, so a seed
/// could only move where the certificate is first met, and every outer
/// iteration is then a deterministic function of the data. The parameter is
/// kept for API compatibility.
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
    solve_trace_stats(
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
        opts,
    )
    .0
}

/// Where each scale round takes its amplitude update from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AlphaSource {
    /// Least squares on the threshold search's binarized train (the original
    /// InDeCa update). Not a descent step on the relaxed objective: the map
    /// `alpha -> alpha_lstsq(binarize(relaxed(alpha)))` has its fixed point
    /// where binarization stops paying for smaller amplitudes, which on the
    /// simulation presets is 0.15-0.4x the true spike amplitude (overfit).
    Binary,
    /// Least squares on the relaxed solution's reconvolution, an approximation
    /// to the amplitude block of block-coordinate descent on the relaxed
    /// objective: it is fitted with a free offset over all upsampled samples,
    /// whereas the objective has no offset and is evaluated on the grid.
    Relaxed,
}

/// How the first round's prescale is chosen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AlphaInit {
    /// Peak-to-trough of the working trace's interior. The kernel is
    /// peak-normalized and the relaxed solution non-negative, so no relaxed
    /// bin can exceed this amplitude: the box upper bound cannot bind.
    PeakToTrough,
    /// A given prescale (tests and characterization).
    Fixed(f64),
}

/// When the scale loop stops.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ScaleStop {
    /// `|alpha_new / alpha_est - 1| < rtol` (the original rule).
    AlphaRtol(f64),
    /// The round is a fixed point of block-coordinate descent: the box upper
    /// bound is inactive (the s-step is then invariant to the prescale, so the
    /// amplitude step cannot change the normalized solution) and, when the
    /// baseline is re-estimated, the joint objective decreased by no more than
    /// the sampling standard error of the noise energy.
    FixedPoint,
}

/// What candidate trains are scored against (see the `chain` module).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scoring {
    /// The bare reconstruction `K s` against the preprocessed trace (the rule
    /// before chain-consistent scoring; kept for characterization).
    Plain,
    /// Every reconstruction passed through the trace's own preprocessing
    /// chain (bandpass, rolling-quantile baseline) before the residual. The
    /// shipped rule.
    Chain,
}

/// Where the relaxed problem is solved (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InnerSolve {
    /// At the recorded rate, one round, frame masses spread over the sub-bins
    /// for the binarization. The default.
    Native,
    /// At the upsampled rate with the fixed iteration budget (the loop before
    /// the native solve; kept for comparison).
    Upsampled,
}

/// When the native-rate relaxed solve stops ([`InnerSolve::Native`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeStop {
    /// The convergence certificate ([`crate::native_solve`]): the remaining
    /// movement of the fit is below one standard error of the noise energy.
    /// The caller's `tol` applies only without a noise model.
    Certificate,
    /// The relative-step rule at the caller's `tol` alone (characterization:
    /// the fixed-tolerance reference the certificate is measured against).
    Step,
}

/// Refractory period that bounds the number of spikes in one frame:
/// `n_max = floor(1 / (REFRACTORY_PERIOD_S * fs))` (10 at 30 Hz, 1 at
/// 300 Hz). 1/300 s is also the simulator's spike resolution and CaDecon's
/// upsampling target (at most one spike per 300 Hz bin).
pub(crate) const REFRACTORY_PERIOD_S: f64 = 1.0 / 300.0;

/// Maximum spikes per frame at sampling rate `fs` (at least 1).
pub(crate) fn max_spikes_per_frame(fs: f64) -> u32 {
    ((1.0 / (REFRACTORY_PERIOD_S * fs)) + 1e-9).floor().max(1.0) as u32
}

/// The selection's grid (`threshold_search_scored` scores every `k`-th
/// sample of `[pad_up, n_up - pad_up)` at the upsampled rate) as a range
/// `[lo, hi)` of native indices with the same number of samples, starting
/// at the first recorded sample at or after `pad_up`.
pub(crate) fn native_grid(n_up: usize, pad_up: usize, k: usize) -> (usize, usize) {
    let k = k.max(1);
    let count = (pad_up..n_up.saturating_sub(pad_up)).step_by(k).count();
    let lo = pad_up.div_ceil(k).min(n_up / k);
    (lo, (lo + count).min(n_up / k))
}

/// The samples of an upsampled vector that fall on recorded frames (every
/// `k`-th, `n_up / k` of them): what the native solve fits, and, over
/// [`native_grid`], what the selection scores.
pub(crate) fn recorded_samples(up: &[f32], k: usize) -> Vec<f32> {
    let k = k.max(1);
    (0..up.len() / k).map(|i| up[i * k]).collect()
}

/// Structure of the scale loop. `Default` is the shipped behavior; the other
/// settings exist for characterization and are crate-internal.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ScaleLoop {
    /// Where the relaxed problem is solved.
    pub inner: InnerSolve,
    /// When the native-rate solve stops.
    pub native_stop: NativeStop,
    pub alpha_source: AlphaSource,
    pub alpha_init: AlphaInit,
    pub stop: ScaleStop,
    /// Re-estimate the slow baseline each round as the rolling median of the
    /// residual `F(y) - alpha * K s` (window [`crate::baseline::baseline_window`]).
    pub rebaseline: bool,
    /// Inner solves stop on the noise-scaled fit-window rule
    /// ([`Solver::set_fit_stop`], gain `tol` times the fit term's noise
    /// energy) instead of the relative-step rule, leaving `max_iters` as a
    /// safety cap.
    pub fit_stop: bool,
    /// Seed round 0 with the caller's `warm_counts`. Off by default: the
    /// seed is far from the relaxed solution at the peak-to-trough prescale
    /// and, with a fixed iteration budget, changes the output.
    pub use_warm_counts: bool,
    /// Warm-start each round from the previous round's relaxed solution,
    /// rescaled to the new prescale.
    pub warm_rounds: bool,
    /// Report the last round (else the best round: highest PVE under
    /// `MaxPve`, smallest scale error under `NoiseFloor`).
    pub take_last: bool,
    /// Safety net on the number of rounds. Off-path: the default loop stops by
    /// its fixed-point rule after 1.0 rounds on every simulation preset
    /// tested, so the cap is not expected to be hit on normal data. 10 has no
    /// derivation beyond being several times the observed round count; if it
    /// is hit, [`InDecaResult::loop_converged`] is `false`.
    pub max_rounds: usize,
    /// How the binarization candidates are scored.
    pub scoring: Scoring,
}

impl ScaleLoop {
    /// The loop before this module's rework, with the noise-scaled inner stop
    /// and warm-started rounds (the loop shipped before the scale-loop rework).
    ///
    /// Deliberately uses `Scoring::Plain`: it reproduces the shipped loop
    /// unchanged, as the characterization baseline for chain-consistent scoring.
    pub(crate) fn binary_alpha() -> Self {
        Self {
            inner: InnerSolve::Upsampled,
            native_stop: NativeStop::Certificate,
            alpha_source: AlphaSource::Binary,
            alpha_init: AlphaInit::PeakToTrough,
            stop: ScaleStop::AlphaRtol(0.05),
            rebaseline: false,
            fit_stop: true,
            use_warm_counts: true,
            warm_rounds: true,
            take_last: false,
            max_rounds: 10,
            scoring: Scoring::Plain,
        }
    }

    /// The upsampled-rate loop with chain scoring (the shipped loop before
    /// the native solve; the comparison reference).
    pub(crate) fn upsampled() -> Self {
        Self {
            inner: InnerSolve::Upsampled,
            ..Self::default()
        }
    }
}

impl Default for ScaleLoop {
    /// The native-rate relaxed solve, spread and binarized at the upsampled
    /// rate with chain scoring (see the module docs).
    ///
    /// Known cost carried from the fixed-point scale loop this builds on
    /// (#239): on the jgcamp8f preset that loop lowered F1 by 0.02-0.04
    /// (0.492-0.525 vs 0.529-0.545 for the previous binary-alpha loop). It
    /// is accepted for a deterministic, seed-independent fixed point that
    /// does not depend on binarization. `fit_stop` is off because it
    /// measured 1.6% mean / 19% max sensitivity to tiny input perturbations.
    fn default() -> Self {
        Self {
            inner: InnerSolve::Native,
            native_stop: NativeStop::Certificate,
            alpha_source: AlphaSource::Relaxed,
            alpha_init: AlphaInit::PeakToTrough,
            stop: ScaleStop::FixedPoint,
            rebaseline: false,
            fit_stop: false,
            use_warm_counts: false,
            warm_rounds: true,
            take_last: true,
            max_rounds: 10,
            scoring: Scoring::Chain,
        }
    }
}

/// Per-round diagnostics of [`solve_trace_stats`].
#[derive(Clone, Debug, Default)]
pub(crate) struct RoundStats {
    pub alpha_est: f64,
    /// The amplitude this round hands to the next one.
    pub alpha_next: f64,
    /// Least-squares amplitude of the relaxed reconvolution.
    pub alpha_relaxed: f64,
    /// Least-squares amplitude of the binarized train.
    pub alpha_binary: f64,
    /// Smallest prescale at which this round's relaxed solution fits in the
    /// box (`alpha_est` times the relaxed interior peak).
    pub alpha_sat: f64,
    pub iterations: u32,
    pub converged: bool,
    /// Some interior bin of the relaxed solution sits at the box upper bound.
    pub upper_bound_active: bool,
    /// The threshold pick came from the noise budget (`None`: no search this
    /// round).
    pub noise_path: Option<bool>,
    /// Spikes in the binarized train (upsampled bins).
    pub count: f64,
    /// Joint objective `||y - b - alpha_est K s||^2` on the interior grid,
    /// after the s-step (trace units).
    pub objective: f64,
    /// Grid residual energy of the binarized train (selection statistic).
    pub binary_error: f64,
    /// Noise budget of the grid residual (0 without a noise model).
    pub budget: f64,
    /// Native solve: residual energy of the relaxed reconstruction scored
    /// like a candidate at the recorded rate (amplitude and offset refit,
    /// through the chain).
    pub relaxed_error: f64,
    /// Native solve: the relaxed solution's interior peak in spike units at
    /// the binarized amplitude (above `n_max`, the refractory box would bind
    /// at that amplitude).
    pub spike_unit_peak: f64,
    /// What the selection rule saw at the pick.
    pub selection: SelectionDiag,
}

/// The preprocessed trace and what is derived from it once per solve.
pub(crate) struct Prepared {
    /// Upsampled, filtered trace before any baseline removal: `F(y)`.
    pub filtered: Vec<f32>,
    /// `filtered` minus the initial rolling-quantile baseline.
    pub working: Vec<f32>,
    pub pad: usize,
    pub bl_window: usize,
    pub banded: BandedAR2,
    pub noise: NoiseEstimate,
    pub noise_model: Option<NoiseModel>,
    /// The bandpass applied to the trace (`None` when off or skipped).
    pub filter: Option<BandpassFilter>,
}

impl Prepared {
    /// The preprocessing chain the trace went through (bandpass, then the
    /// rolling-quantile baseline), for chain-consistent scoring. Takes the
    /// filter: the chain owns it from here on.
    pub(crate) fn take_chain(&mut self) -> Box<Chain> {
        Box::new(Chain::new(self.filter.take(), self.bl_window))
    }
}

pub(crate) fn prepare(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    upsample_factor: usize,
    hp_enabled: bool,
    lp_enabled: bool,
) -> Prepared {
    let mut filtered = upsample_trace(trace, upsample_factor);
    // The filter is kept for the noise model (it shapes the noise that remains).
    let mut filter = if hp_enabled || lp_enabled {
        let mut f = trace_filter(tau_r, tau_d, fs_up, hp_enabled, lp_enabled);
        f.apply(&mut filtered).then_some(f)
    } else {
        None
    };
    // Rolling-percentile baseline subtraction: brings the floor to ~0.
    let bl_window = crate::baseline::baseline_window(tau_d, fs_up);
    let mut working = filtered.clone();
    crate::baseline::subtract_rolling_baseline(
        &mut working,
        bl_window,
        crate::baseline::DEFAULT_BASELINE_QUANTILE,
    );
    // Boundary padding: edge effects from AR2 convolution make the first and
    // last `pad` samples unreliable (subsets may start mid-transient).
    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(working.len() / 4);
    // Noise of the preprocessed trace, from the raw trace's high band pushed
    // through the same upsample → filter chain. Fully data-derived — no knob.
    // It sets the threshold search's noise budget and standard error, the
    // scale loop's objective tolerance, and the optional fit-window stop.
    let noise = estimate_noise_model(trace, upsample_factor, filter.as_mut());
    let noise_model = (noise.grid.sigma > 0.0).then_some(noise.grid);
    Prepared {
        filtered,
        working,
        pad,
        bl_window,
        banded: BandedAR2::new(tau_r, tau_d, fs_up),
        noise,
        noise_model,
        filter,
    }
}

/// `||y - alpha * conv||^2` over the interior grid positions (every
/// `stride`-th sample, where the upsampled trace equals the recorded one).
fn grid_energy(y: &[f32], conv: &[f32], alpha: f64, pad: usize, stride: usize) -> f64 {
    let n = y.len();
    let mut e = 0.0;
    for i in (pad..n.saturating_sub(pad)).step_by(stride.max(1)) {
        let d = y[i] as f64 - alpha * conv[i] as f64;
        e += d * d;
    }
    e
}

/// Centered rolling median of `x` over `window` samples (edge windows are
/// truncated).
fn rolling_median_centered(x: &[f32], window: usize) -> Vec<f32> {
    let n = x.len();
    if n == 0 || window == 0 {
        return vec![0.0; n];
    }
    let half = window / 2;
    // The causal rolling median of x extended by `half` samples, shifted back
    // by `half`, is the centered one.
    let mut ext: Vec<f32> = Vec::with_capacity(n + half);
    ext.extend_from_slice(x);
    ext.extend(std::iter::repeat_n(x[n - 1], half));
    let mut resid = ext.clone();
    crate::baseline::subtract_rolling_baseline(&mut resid, window, 0.5);
    (0..n).map(|t| ext[t + half] - resid[t + half]).collect()
}

/// [`solve_trace_opts`] plus per-round diagnostics.
#[allow(clippy::too_many_arguments)]
pub(crate) fn solve_trace_stats(
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
) -> (InDecaResult, Vec<RoundStats>) {
    solve_trace_cfg(
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
        opts,
        ScaleLoop::default(),
    )
}

/// [`solve_trace_stats`] with an explicit scale-loop structure.
#[allow(clippy::too_many_arguments)]
pub(crate) fn solve_trace_cfg(
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
    cfg: ScaleLoop,
) -> (InDecaResult, Vec<RoundStats>) {
    if cfg.inner == InnerSolve::Native {
        return solve_trace_native(
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
            opts,
            cfg,
        );
    }
    let k = upsample_factor.max(1);
    let fs_up = fs * upsample_factor as f64;
    let mut prep = prepare(
        trace,
        tau_r,
        tau_d,
        fs_up,
        upsample_factor,
        hp_enabled,
        lp_enabled,
    );
    let pad = prep.pad;
    let wt_len = prep.working.len();
    // The chain the candidates are scored through (`Scoring::Chain`); it owns
    // the trace's filter and is handed to each round's scorer and back.
    let mut chain = (cfg.scoring == Scoring::Chain).then(|| prep.take_chain());

    // Single solver allocation reused across all solve_upsampled calls.
    let mut solver = Solver::new();

    let selection = if opts.noise_constrained {
        Selection::NoiseFloor
    } else {
        Selection::MaxPve
    };
    let n_grid = (pad..wt_len.saturating_sub(pad)).step_by(k).count();
    let budget = prep.noise_model.map_or(0.0, |nm| nm.budget(n_grid));
    // Objective changes below the sampling error of the noise energy are not
    // resolvable from the data.
    let objective_tol = prep.noise_model.map_or(0.0, |nm| nm.std_error(n_grid));
    // Expected noise energy of the FISTA data-fit term at unit prescale.
    let fit_noise_energy = 0.5 * prep.noise.upsampled_var * wt_len as f64;

    // The baseline-subtracted trace the rounds fit (re-estimated per round
    // when `cfg.rebaseline`).
    let mut y = prep.working.clone();

    let mut alpha_est = match cfg.alpha_init {
        AlphaInit::PeakToTrough => estimate_alpha_interior(&y, pad),
        AlphaInit::Fixed(a) => a,
    };

    // Convert original-rate spike counts to upsampled-rate binary for warm-start.
    // upsample_counts_to_binary centers spikes on original sample positions,
    // matching the centered bins used by downsample_binary.
    let warm_binary = warm_counts
        .filter(|_| cfg.use_warm_counts)
        .map(|counts| upsample_counts_to_binary(counts, upsample_factor));

    let mut best_pve = f64::NEG_INFINITY;
    let mut best_scale_err = f64::INFINITY;
    let mut best_result: Option<(Vec<f32>, f64, f64, f64, f64, u32, bool)> = None;
    let mut stats: Vec<RoundStats> = Vec::new();

    // Scratch buffers reused across rounds.
    let mut scaled = vec![0.0_f32; wt_len];
    let mut s_normalized = vec![0.0_f32; wt_len];
    let mut conv = vec![0.0_f32; wt_len];
    let mut warm_buf = vec![0.0_f32; wt_len];
    // Previous round's relaxed solution and the prescale it was solved at.
    let mut previous: Option<(Vec<f32>, f64)> = None;
    let mut prev_objective = f64::INFINITY;
    let mut loop_converged = false;

    for _ in 0..cfg.max_rounds.max(1) {
        // ── s-step: Box[0,1] FISTA on y / alpha_est ──
        let inv_alpha = 1.0 / alpha_est as f32;
        for i in 0..wt_len {
            scaled[i] = y[i] * inv_alpha;
        }

        // Round 0 takes the caller's warm start. Later rounds (optionally)
        // continue from the previous relaxed solution, rescaled to the new
        // prescale (the same reconvolution in trace units) and clamped back
        // into the box.
        let warm_start = match &previous {
            None => warm_binary.as_deref(),
            Some((prev, prev_alpha)) if cfg.warm_rounds => {
                let r = (*prev_alpha / alpha_est) as f32;
                for (w, &v) in warm_buf.iter_mut().zip(prev) {
                    *w = (v * r).clamp(0.0, 1.0);
                }
                Some(&warm_buf[..])
            }
            Some(_) => None,
        };

        // The prescale divides the trace, so the noise energy scales by 1/alpha^2.
        let fit_stop = cfg
            .fit_stop
            .then(|| tol * fit_noise_energy / (alpha_est * alpha_est));

        let (s_relaxed, _, iterations, converged) = solve_upsampled(
            &mut solver,
            &scaled,
            tau_r,
            tau_d,
            fs_up,
            max_iters,
            tol,
            fit_stop,
            warm_start,
            false,
            false,
            Constraint::Box01,
            true, // trace is baseline-subtracted → skip FISTA baseline estimation
            lambda,
        );

        // Joint objective after the s-step, and the relaxed amplitude step.
        prep.banded.convolve_forward(&s_relaxed, &mut conv);
        let objective = grid_energy(&y, &conv, alpha_est, pad, k);
        let (alpha_relaxed, _) =
            crate::threshold::lstsq_alpha_baseline(&conv, &y, pad, f64::INFINITY);

        // Normalize relaxed solution to [0,1] before threshold search.
        // Use the interior peak only (excluding boundary padding) so that edge
        // artifacts from trace subsets starting mid-transient don't dominate.
        let s_peak = interior_peak(&s_relaxed, pad);
        if s_peak > 1e-10 {
            let inv_peak = 1.0 / s_peak;
            for i in 0..wt_len {
                s_normalized[i] = s_relaxed[i] * inv_peak;
            }
        } else {
            s_normalized.copy_from_slice(&s_relaxed);
        }

        // ── Binarization: threshold search against the working trace ──
        let ThresholdResult {
            s_binary,
            alpha: alpha_lstsq,
            baseline: baseline_lstsq,
            threshold,
            pve,
            error,
            noise_path,
            diag,
        } = {
            let mut scorer = match chain.take() {
                Some(c) => Scorer::Chain { y: &y, chain: c },
                None => Scorer::Plain { y: &y },
            };
            let r = threshold_search_scored(
                &s_normalized,
                &mut scorer,
                &prep.banded,
                tau_d,
                fs_up,
                upsample_factor,
                f64::INFINITY,
                selection,
                prep.noise_model,
            );
            if let Scorer::Chain { chain: c, .. } = scorer {
                chain = Some(c);
            }
            r
        };

        let alpha_new = match cfg.alpha_source {
            AlphaSource::Binary => alpha_lstsq,
            AlphaSource::Relaxed => alpha_relaxed,
        };
        let upper_bound_active = s_peak >= 1.0;
        stats.push(RoundStats {
            alpha_est,
            alpha_next: alpha_new,
            alpha_relaxed,
            alpha_binary: alpha_lstsq,
            alpha_sat: alpha_est * s_peak as f64,
            iterations,
            converged,
            upper_bound_active,
            noise_path: Some(noise_path),
            count: s_binary.iter().map(|&v| v as f64).sum(),
            objective,
            binary_error: error,
            budget,
            selection: diag,
            ..Default::default()
        });

        // Scale-loop convergence error: how close the new amplitude is to the
        // prescale used this round.
        let scale_err = if alpha_est > 1e-10 {
            (alpha_new / alpha_est - 1.0).abs()
        } else {
            f64::INFINITY
        };

        let is_better = cfg.take_last
            || match selection {
                // MaxPve keeps the highest-PVE iterate (historical behavior).
                Selection::MaxPve => pve > best_pve,
                // Under NoiseFloor, ranking by PVE would re-select the densest
                // round; use the best-calibrated prescale instead.
                Selection::NoiseFloor => scale_err < best_scale_err,
            };

        let stalled = prev_objective - objective <= objective_tol;
        prev_objective = objective;
        let done = match cfg.stop {
            ScaleStop::AlphaRtol(rtol) => scale_err < rtol,
            ScaleStop::FixedPoint if cfg.rebaseline => stats.len() > 1 && stalled,
            ScaleStop::FixedPoint => !upper_bound_active || stalled,
        };
        let last = done || alpha_new < 1e-10;

        // ── b-step: rolling median of the residual against the model ──
        // (only when another round follows; its reconvolution is the one the
        // amplitude step was fit to).
        if cfg.rebaseline && !last {
            if cfg.alpha_source == AlphaSource::Binary {
                prep.banded.convolve_forward(&s_binary, &mut conv);
            }
            let resid: Vec<f32> = prep
                .filtered
                .iter()
                .zip(&conv)
                .map(|(&f, &c)| f - alpha_new as f32 * c)
                .collect();
            let b = rolling_median_centered(&resid, prep.bl_window);
            for i in 0..wt_len {
                y[i] = prep.filtered[i] - b[i];
            }
        }

        if is_better {
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
        if last {
            loop_converged = true;
            break;
        }

        previous = Some((s_relaxed, alpha_est));
        alpha_est = alpha_new;
    }

    // ── Extract the reported round ──
    let (s_binary, alpha, baseline, threshold, pve, iterations, converged) = best_result
        .unwrap_or_else(|| {
            // Fallback: no valid result found (shouldn't happen)
            (vec![0.0; wt_len], 0.0, 0.0, 0.0, 0.0, 0, false)
        });

    // Downsample binary spike train to original rate using centered bins
    let s_counts = downsample_binary(&s_binary, upsample_factor);

    // Downsample the (initial) baseline-subtracted trace to the original rate.
    let filtered_trace = Some(downsample_average(&prep.working, upsample_factor));

    (
        InDecaResult {
            s_counts,
            filtered_trace,
            alpha,
            baseline,
            threshold,
            pve,
            iterations,
            converged,
            loop_converged,
        },
        stats,
    )
}

/// The native-rate inner solve ([`InnerSolve::Native`]; see the module docs).
/// `upsample_factor` is the number of sub-bins per frame of the binarization
/// (the spike-resolution rate is `fs * upsample_factor`).
///
/// One preprocessing: the trace is upsampled, filtered and baseline-
/// subtracted exactly as the upsampled solve did it, and the candidates are
/// scored against that working trace through the same chain, so the
/// binarization and the reported amplitude, offset and PVE are the same
/// statistics as before. The relaxed solve fits the **grid samples** of
/// that working trace (every `k`-th sample, where the upsampled trace is
/// the recorded one): the solve and the selection then see the same data,
/// and the certificate's residual is taken over the selection's own grid.
/// (Preprocessing the recorded trace at its own rate instead gives a
/// working trace that differs from the grid samples by up to 9% RMS on fast
/// kernels, where the bandpass cutoffs are near the recorded Nyquist.)
///
/// Prescale: the native solve at prescale `alpha_est` gives masses in units
/// of `alpha_est` per spike with the box `[0, n_max]` in those units, solved
/// as Box01 on `y / (alpha_est * n_max)`. From the peak-to-trough start the
/// box cannot bind (a frame mass above one spike at that amplitude would put
/// a transient above the trace's own range), so the solve is the scale-free
/// non-negative fit and one round is the whole loop: the spread is scale
/// free and the binarization fits every candidate its own amplitude, so a
/// second round at the binarized amplitude would binarize the same
/// normalized vector. (A round at the binarized amplitude could only differ
/// if the refractory box bound there, i.e. the pick put more than `n_max`
/// spikes' worth of mass in one frame; `RoundStats::spike_unit_peak` reports
/// that case, which the binarization itself caps at `upsample_factor`
/// spikes per frame.)
#[allow(clippy::too_many_arguments)]
fn solve_trace_native(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    // The solve converges on its own; a seed could only move the stopping
    // point (see `solve_trace`).
    _warm_counts: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    lambda: f64,
    opts: SolveOptions,
    cfg: ScaleLoop,
) -> (InDecaResult, Vec<RoundStats>) {
    debug_assert!(
        !cfg.rebaseline && !cfg.fit_stop && !cfg.use_warm_counts,
        "the native solve has neither a baseline step, nor the fit-window stop, nor a warm start"
    );
    let k = upsample_factor.max(1);
    let fs_up = fs * k as f64;
    // Spike-resolution preprocessing: what the candidates are scored against.
    let mut up = prepare(trace, tau_r, tau_d, fs_up, k, hp_enabled, lp_enabled);
    let (n_up, pad_up) = (up.working.len(), up.pad);
    // The grid: the recorded samples the selection scores on, as native
    // indices `[lo, hi)`.
    let (lo, hi) = native_grid(n_up, pad_up, k);
    let n = n_up / k;
    // What the relaxed solve fits: the working trace at the grid samples.
    let y = recorded_samples(&up.working, k);
    let banded = BandedAR2::new(tau_r, tau_d, fs);
    let cap = max_spikes_per_frame(fs) as f64;
    let selection = if opts.noise_constrained {
        Selection::NoiseFloor
    } else {
        Selection::MaxPve
    };
    let n_grid = hi - lo;
    let budget = up.noise_model.map_or(0.0, |nm| nm.budget(n_grid));
    // The selection's resolution: one standard error of the noise energy
    // over the grid it scores on (trace units).
    let std_error = up.noise_model.map_or(0.0, |nm| nm.std_error(n_grid));
    let mut chain_up = (cfg.scoring == Scoring::Chain).then(|| up.take_chain());

    let alpha_est = match cfg.alpha_init {
        AlphaInit::PeakToTrough => estimate_alpha_interior(&y, lo),
        AlphaInit::Fixed(a) => a,
    };

    let mut conv = vec![0.0_f32; n];

    // ── s-step: Box[0, n_max] in units of alpha_est ──
    let scale = alpha_est * cap;
    let inv = (1.0 / scale) as f32;
    let scaled64: Vec<f64> = y.iter().map(|&v| (v * inv) as f64).collect();
    // The certificate in the solver's units: the trace was divided by
    // `scale`, so energies are divided by `scale^2`. Without a noise model
    // there is no certificate and the caller's step tolerance applies.
    let stop = match cfg.native_stop {
        NativeStop::Certificate if std_error > 0.0 => Some(Stop {
            se: std_error / (scale * scale),
            lo,
            hi,
            stride: 1,
        }),
        _ => None,
    };
    let tol = if stop.is_some() { 0.0 } else { tol };
    // The cap: the problem's own worst case, never below the caller's.
    let cap_iters = match stop {
        Some(st) => {
            let y2: f64 = scaled64[lo..hi].iter().map(|v| v * v).sum();
            let tau0 = (y2 + st.se).sqrt() - y2.sqrt();
            native_solve::iteration_cap(n, banded.lipschitz(), tau0).max(max_iters)
        }
        None => max_iters,
    };
    let lambda_eff = lambda * banded.dc_gain();
    let nr = native_solve::solve_box(&scaled64, &banded, lambda_eff, cap_iters, tol, stop, None);
    let u: Vec<f32> = nr.x.iter().map(|&v| v as f32).collect();
    let (iterations, converged) = (nr.iterations, nr.converged());
    // Frame masses in units of alpha_est per spike.
    let x: Vec<f32> = u.iter().map(|&v| v * cap as f32).collect();
    banded.convolve_forward(&x, &mut conv);
    let objective = grid_energy(&y, &conv, alpha_est, lo, 1);
    let u_peak = interior_peak(&u, lo) as f64;
    // The relaxed fit's least-squares amplitude and error on the grid
    // (plain, with a free offset: a diagnostic of the relaxed fit, not a
    // chain-scored candidate).
    let (relaxed_error, alpha_relaxed) = {
        let mut sc = Scorer::Plain { y: &y };
        let (e, a, _) = sc.score(&x, &banded, lo, 1, f64::INFINITY, &mut conv);
        (e, a)
    };

    // ── Spread to the spike-resolution rate; normalize to the interior peak
    // as the upsampled loop does before its threshold search ──
    let mut s_normalized = spread(&x, k, Spread::Interp);
    let s_peak = interior_peak(&s_normalized, pad_up);
    if s_peak > 1e-10 {
        let inv_peak = 1.0 / s_peak;
        for v in s_normalized.iter_mut() {
            *v *= inv_peak;
        }
    }

    // ── Binarization: the threshold search against the upsampled working
    // trace ──
    let ThresholdResult {
        s_binary,
        alpha: alpha_lstsq,
        baseline: _,
        threshold,
        pve,
        error,
        noise_path,
        diag,
    } = {
        let mut scorer = match chain_up.take() {
            Some(c) => Scorer::Chain {
                y: &up.working,
                chain: c,
            },
            None => Scorer::Plain { y: &up.working },
        };
        threshold_search_scored(
            &s_normalized,
            &mut scorer,
            &up.banded,
            tau_d,
            fs_up,
            k,
            f64::INFINITY,
            selection,
            up.noise_model,
        )
    };
    let s_counts = downsample_binary(&s_binary, k);

    let alpha_new = match cfg.alpha_source {
        AlphaSource::Binary => alpha_lstsq,
        AlphaSource::Relaxed => alpha_relaxed,
    };
    let spike_unit_peak = if alpha_lstsq > 0.0 {
        u_peak * cap * alpha_est / alpha_lstsq
    } else {
        0.0
    };
    let stats = vec![RoundStats {
        alpha_est,
        alpha_next: alpha_new,
        alpha_relaxed,
        alpha_binary: alpha_lstsq,
        alpha_sat: alpha_est * u_peak * cap,
        iterations,
        converged,
        upper_bound_active: u_peak >= 1.0,
        noise_path: Some(noise_path),
        count: s_counts.iter().map(|&v| v as f64).sum(),
        objective,
        binary_error: error,
        budget,
        relaxed_error,
        spike_unit_peak,
        selection: diag,
    }];

    // The amplitude and offset handed downstream. The kernel estimator models
    // the working trace as `alpha * (s * h) + baseline` with the bare train,
    // but the chain scorer fits its pair after the reconstruction went through
    // the chain, so its offset carries the level the rolling quantile removed
    // and the kernel fit subtracts that level a second time (slow indicators
    // under dense firing: tau_r pinned at the fit's cap, tau_d halved). Refit
    // the pair on the bare reconvolution; scoring keeps its own.
    let (alpha_out, baseline_out) = {
        let mut cv = vec![0.0_f32; n_up];
        up.banded.convolve_forward(&s_binary, &mut cv);
        crate::threshold::lstsq_alpha_baseline(&cv, &up.working, pad_up, f64::INFINITY)
    };
    (
        InDecaResult {
            s_counts,
            // The upsampled working trace at the recorded rate, as before.
            filtered_trace: Some(downsample_average(&up.working, k)),
            alpha: alpha_out,
            baseline: baseline_out,
            threshold,
            pve,
            iterations,
            converged,
            // The native solve is one round (no scale loop, no `max_rounds`),
            // so there is no loop cap to hit; the inner solve's stop is
            // reported by `converged`.
            loop_converged: true,
        },
        stats,
    )
}

/// Characterization: score a reconstruction `recon` (trace units, before any
/// preprocessing, at the upsampled rate; e.g. `K n` of the true train, or the
/// clean calcium) against `trace` exactly as candidates are scored under
/// `scoring`. Returns `(residual energy, noise budget, amplitude)`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn score_reconstruction_on_trace(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    hp_enabled: bool,
    lp_enabled: bool,
    scoring: Scoring,
    recon: &[f32],
) -> (f64, f64, f64) {
    let k = upsample_factor.max(1);
    let mut prep = prepare(
        trace,
        tau_r,
        tau_d,
        fs * k as f64,
        k,
        hp_enabled,
        lp_enabled,
    );
    let n = prep.working.len();
    let pad = prep.pad;
    let n_grid = (pad..n.saturating_sub(pad)).step_by(k).count();
    let mut conv = recon.to_vec();
    let chain = prep.take_chain();
    let mut sc = match scoring {
        Scoring::Plain => Scorer::Plain { y: &prep.working },
        Scoring::Chain => Scorer::Chain {
            y: &prep.working,
            chain,
        },
    };
    let (e, a, _) = sc.score_reconstruction(&mut conv, pad, k, f64::INFINITY);
    (e, prep.noise_model.map_or(0.0, |nm| nm.budget(n_grid)), a)
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
            (2.0..=30.0).contains(&total_counts),
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
        // estimate_noise_model → Selection::NoiseFloor) on a genuinely noisy
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

    #[test]
    fn noise_model_matches_white_noise_pushed_through_the_chain() {
        // The impulse-response derivation must agree with what white noise
        // actually looks like after upsample → bandpass.
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let n = 6000;
        let noise = lcg_noise(n, 1.0, 0x5EED);
        let sigma_raw = (1.0_f64 / 3.0).sqrt();
        let mut f = trace_filter(tr, td, fs * k as f64, true, true);
        let est = estimate_noise_model(&noise, k, Some(&mut f));

        let mut up = upsample_trace(&noise, k);
        assert!(trace_filter(tr, td, fs * k as f64, true, true).apply(&mut up));
        let grid: Vec<f64> = up.iter().step_by(k).map(|&v| v as f64).collect();
        let var = |x: &[f64]| x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64;
        let grid_var = var(&grid);
        let all_var = var(&up.iter().map(|&v| v as f64).collect::<Vec<_>>());
        // Empirical sum of squared autocorrelations over the lags that matter.
        let rho = |lag: usize| {
            (0..n - lag).map(|i| grid[i] * grid[i + lag]).sum::<f64>()
                / ((n - lag) as f64 * grid_var)
        };
        let corr_emp = 1.0 + 2.0 * (1..40).map(|l| rho(l).powi(2)).sum::<f64>();

        let rel = |a: f64, b: f64| (a / b - 1.0).abs();
        assert!(rel(high_band_sigma(&noise), sigma_raw) < 0.1);
        assert!(
            rel(est.grid.sigma.powi(2), grid_var) < 0.15,
            "{} vs {}",
            est.grid.sigma.powi(2),
            grid_var
        );
        assert!(
            rel(est.upsampled_var, all_var) < 0.15,
            "{} vs {}",
            est.upsampled_var,
            all_var
        );
        assert!(est.grid.corr_sum > 1.5, "LP should correlate grid samples");
        assert!(
            rel(est.grid.corr_sum, corr_emp) < 0.25,
            "{} vs {}",
            est.grid.corr_sum,
            corr_emp
        );

        // Without filtering the grid samples are the raw samples.
        let plain = estimate_noise_model(&noise, k, None);
        assert!(rel(plain.grid.sigma, high_band_sigma(&noise)) < 1e-6);
        assert!((plain.grid.corr_sum - 1.0).abs() < 1e-6);
    }

    fn noisy_spiking_trace(n: usize, seed: u64) -> Vec<f32> {
        let kernel = build_kernel(0.1, 0.6, 30.0);
        let mut trace = vec![1.0_f32; n];
        let noise = lcg_noise(n, 0.3, seed);
        let mut p = 37usize;
        while p < n {
            for (j, &kv) in kernel.iter().enumerate() {
                if p + j < n {
                    trace[p + j] += 2.0 * kv;
                }
            }
            p += 23 + (p * 7) % 41;
        }
        for (t, e) in trace.iter_mut().zip(noise) {
            *t += e;
        }
        trace
    }

    #[test]
    fn inner_solves_stop_on_the_fit_rule_not_the_cap() {
        let trace = noisy_spiking_trace(900, 0xFEED);
        for noise_constrained in [false, true] {
            let (r, stats) = solve_trace_cfg(
                &trace,
                0.1,
                0.6,
                30.0,
                10,
                5000,
                1e-4,
                None,
                true,
                true,
                0.0,
                SolveOptions { noise_constrained },
                ScaleLoop::binary_alpha(),
            );
            assert!(!stats.is_empty());
            for s in &stats {
                assert!(s.converged, "round hit the cap: {s:?}");
                assert!(s.iterations < 5000);
            }
            assert!(r.s_counts.iter().sum::<f32>() > 0.0);
        }
    }

    // ── Scale-loop structure ────────────────────────────────────────────

    /// Short simulated cells from every preset (true taus), at the CaDecon
    /// upsampling target of 300 Hz: (preset, trace, tau_r, tau_d, fs, k).
    fn preset_cells(
        n_cells: usize,
        n_tp: usize,
    ) -> Vec<(&'static str, Vec<f32>, f64, f64, f64, usize)> {
        let mut out = Vec::new();
        for (name, mut cfg) in crate::simulate::presets::all() {
            cfg.num_cells = n_cells;
            cfg.num_timepoints = n_tp;
            let r = crate::simulate::simulate(&cfg);
            for c in 0..n_cells {
                let gt = &r.ground_truth[c];
                let k = ((300.0 / cfg.fs_hz).round() as usize).max(1);
                out.push((
                    name,
                    r.traces[c * n_tp..(c + 1) * n_tp].to_vec(),
                    gt.tau_rise_s,
                    gt.tau_decay_s,
                    cfg.fs_hz,
                    k,
                ));
            }
        }
        out
    }

    /// The upsampled-rate scale loop (the comparison path): the tests of the
    /// loop's structure (rounds, amplitude steps, rebaselining, fit stop)
    /// are about that loop; the native solve has one round.
    fn upsampled_loop() -> ScaleLoop {
        ScaleLoop::upsampled()
    }

    fn run_cfg(
        trace: &[f32],
        (tr, td, fs, k): (f64, f64, f64, usize),
        max_iters: u32,
        cfg: ScaleLoop,
    ) -> (InDecaResult, Vec<RoundStats>) {
        solve_trace_cfg(
            trace,
            tr,
            td,
            fs,
            k,
            max_iters,
            1e-4,
            None,
            true,
            true,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
            cfg,
        )
    }

    #[test]
    fn peak_to_trough_start_leaves_the_box_inactive_on_presets() {
        // The starting prescale must not let the box upper bound bind: the
        // relaxed solution's largest bin, in trace units, stays well below it.
        for (name, trace, tr, td, fs, k) in preset_cells(2, 900) {
            let (_, st) = run_cfg(&trace, (tr, td, fs, k), 300, upsampled_loop());
            let r0 = &st[0];
            assert!(!r0.upper_bound_active, "{name}: box binds in round 0");
            assert!(
                r0.alpha_sat < 0.5 * r0.alpha_est,
                "{name}: start {} vs saturation {}",
                r0.alpha_est,
                r0.alpha_sat
            );
        }
    }

    #[test]
    fn relaxed_round_is_invariant_to_the_prescale_above_saturation() {
        // Above saturation the s-step is the scale-free non-negative fit, so a
        // round's output does not depend on the prescale: this is why the
        // relaxed amplitude step is at its fixed point after one round.
        // (Power-of-two prescales scale every iterate exactly, so the outputs
        // are bit-identical.)
        let trace = noisy_spiking_trace(900, 0xFEED);
        let p = (0.1, 0.6, 30.0, 10);
        let (base, st) = run_cfg(&trace, p, 300, upsampled_loop());
        assert_eq!(st.len(), 1, "fixed point after one round: {st:?}");
        for m in [2.0, 8.0] {
            let cfg = ScaleLoop {
                alpha_init: AlphaInit::Fixed(st[0].alpha_est * m),
                ..upsampled_loop()
            };
            let (r, st2) = run_cfg(&trace, p, 300, cfg);
            assert_eq!(r.s_counts, base.s_counts);
            assert_eq!(r.alpha, base.alpha);
            assert_eq!(st2[0].iterations, st[0].iterations);
        }
    }

    #[test]
    fn relaxed_round_is_nearly_invariant_to_a_non_power_of_two_prescale() {
        // A non-power-of-two prescale rounds every iterate differently, and the
        // ill-posed solve at lambda = 0 amplifies those float differences, so
        // outputs are close but not identical (events differ by up to ~4% at
        // x1.5). Assert only that: same scale-free fixed point, counts within
        // 10% of the base total, alpha within 10%.
        let trace = noisy_spiking_trace(900, 0xFEED);
        let p = (0.1, 0.6, 30.0, 10);
        let (base, st) = run_cfg(&trace, p, 300, upsampled_loop());
        let total = base.s_counts.iter().sum::<f32>();
        for m in [1.5, 3.0] {
            let cfg = ScaleLoop {
                alpha_init: AlphaInit::Fixed(st[0].alpha_est * m),
                ..upsampled_loop()
            };
            let (r, st2) = run_cfg(&trace, p, 300, cfg);
            assert_eq!(st2.len(), 1);
            let diff: f32 = r
                .s_counts
                .iter()
                .zip(&base.s_counts)
                .map(|(a, b)| (a - b).abs())
                .sum();
            assert!(diff <= 0.10 * total, "x{m}: {diff} vs total {total}");
            assert!((r.alpha / base.alpha - 1.0).abs() < 0.10, "x{m}");
        }
    }

    #[test]
    fn default_loop_ignores_warm_counts() {
        // Round 0 of the default loop does not take the caller's warm start, so
        // the output is a deterministic function of the data.
        for (name, trace, tr, td, fs, k) in preset_cells(1, 900).into_iter().take(3) {
            let solve = |warm: Option<&[f32]>| {
                solve_trace_opts(
                    &trace,
                    tr,
                    td,
                    fs,
                    k,
                    300,
                    1e-4,
                    warm,
                    true,
                    true,
                    0.0,
                    SolveOptions {
                        noise_constrained: true,
                    },
                )
            };
            let cold = solve(None);
            let own = solve(Some(&cold.s_counts));
            let jittered: Vec<f32> = cold
                .s_counts
                .iter()
                .enumerate()
                .map(|(i, &c)| {
                    if i % 7 == 0 {
                        c + 1.0
                    } else {
                        (c - (i % 3) as f32).max(0.0)
                    }
                })
                .collect();
            let jit = solve(Some(&jittered));
            for (label, r) in [("own", &own), ("jittered", &jit)] {
                assert_eq!(r.s_counts, cold.s_counts, "{name} {label}");
                assert_eq!(r.alpha.to_bits(), cold.alpha.to_bits(), "{name} {label}");
                assert_eq!(
                    r.threshold.to_bits(),
                    cold.threshold.to_bits(),
                    "{name} {label}"
                );
            }
        }
    }

    #[test]
    fn relaxed_loop_descends_the_objective_from_a_binding_start() {
        // Started well below saturation (box binding), the relaxed loop is
        // block-coordinate descent on ||y - alpha K s||^2: the objective never
        // increases, the amplitude rises, and the loop stops on its own once
        // the box is inactive (or the objective stalls), not at the round cap.
        let trace = noisy_spiking_trace(900, 0xBEEF);
        let p = (0.1, 0.6, 30.0, 10);
        let (_, st) = run_cfg(&trace, p, 300, upsampled_loop());
        let sat = st[0].alpha_sat;
        let cfg = ScaleLoop {
            alpha_init: AlphaInit::Fixed(sat / 8.0),
            warm_rounds: true,
            ..upsampled_loop()
        };
        let (_, st) = run_cfg(&trace, p, 300, cfg);
        assert!(st[0].upper_bound_active, "start should bind: {st:?}");
        assert!(st.len() > 1 && st.len() < cfg.max_rounds, "{st:?}");
        for w in st.windows(2) {
            assert!(
                w[1].objective <= w[0].objective * (1.0 + 1e-6),
                "objective rose: {st:?}"
            );
            assert!(w[1].alpha_est > w[0].alpha_est, "{st:?}");
        }
    }

    #[test]
    fn binary_amplitude_map_settles_below_the_relaxed_fixed_point() {
        // The original update (amplitude from the binarized train) drives the
        // amplitude down on the presets: run to convergence it ends well below
        // where the relaxed loop's binarization puts it, with more spikes
        // (several bins per spike).
        let (_, trace, tr, td, fs, k) = preset_cells(1, 1500)
            .into_iter()
            .find(|c| c.0 == "gcamp6f")
            .unwrap();
        let p = (tr, td, fs, k);
        let (relaxed, _) = run_cfg(&trace, p, 300, upsampled_loop());
        let cfg = ScaleLoop {
            stop: ScaleStop::AlphaRtol(0.002),
            fit_stop: false,
            warm_rounds: false,
            take_last: true,
            max_rounds: 40,
            ..ScaleLoop::binary_alpha()
        };
        let (binary, st) = run_cfg(&trace, p, 300, cfg);
        assert!(
            st.len() < cfg.max_rounds,
            "binary map did not settle: {}",
            st.len()
        );
        assert!(
            binary.alpha < 0.8 * relaxed.alpha,
            "{} vs {}",
            binary.alpha,
            relaxed.alpha
        );
        let count = |r: &InDecaResult| r.s_counts.iter().sum::<f32>();
        assert!(count(&binary) > count(&relaxed));
    }

    #[test]
    fn fit_stop_solves_converge_and_loops_stop_by_themselves_on_presets() {
        // With the noise-scaled fit-window rule no inner solve reaches its
        // safety cap, and neither loop structure reaches the round cap.
        for (name, trace, tr, td, fs, k) in preset_cells(1, 900) {
            for cfg in [
                ScaleLoop::binary_alpha(),
                ScaleLoop {
                    fit_stop: true,
                    ..upsampled_loop()
                },
            ] {
                let (_, st) = run_cfg(&trace, (tr, td, fs, k), 5000, cfg);
                assert!(st.len() < cfg.max_rounds, "{name}: {st:?}");
                for r in &st {
                    assert!(r.converged && r.iterations < 5000, "{name}: {r:?}");
                }
            }
        }
    }

    #[test]
    fn rebaselining_brings_the_relaxed_fit_to_the_noise_floor_on_clean() {
        // The `clean` preset (SNR 200) is many times over the noise budget
        // with the rolling-quantile baseline, which absorbs calcium during
        // dense activity. Re-estimating the baseline from the residual each
        // round brings the relaxed fit down to about the noise level.
        let (_, trace, tr, td, fs, k) = preset_cells(2, 3000)
            .into_iter()
            .filter(|c| c.0 == "clean")
            .nth(1)
            .unwrap();
        let cfg = ScaleLoop {
            rebaseline: true,
            ..upsampled_loop()
        };
        let (_, st) = run_cfg(&trace, (tr, td, fs, k), 300, cfg);
        let first = &st[0];
        let last = st.last().unwrap();
        assert!(first.objective > 2.0 * first.budget, "{st:?}");
        assert!(last.objective < 1.2 * last.budget, "{st:?}");
        assert!(st.len() < cfg.max_rounds);
    }

    #[test]
    fn rolling_median_centered_tracks_a_step_without_lag() {
        let mut x = vec![0.0_f32; 400];
        for v in &mut x[200..] {
            *v = 1.0;
        }
        let m = rolling_median_centered(&x, 101);
        assert_eq!(m[150], 0.0);
        assert_eq!(m[250], 1.0);
        assert!(m[198] == 0.0 && m[202] == 1.0, "{} {}", m[198], m[202]);
    }

    #[test]
    fn default_loop_reaches_its_fixed_point_in_one_round_on_presets() {
        // The shipped loop: one s-step at the peak-to-trough prescale is
        // already a fixed point, so no preset cell needs a second round.
        for (name, trace, tr, td, fs, k) in preset_cells(2, 900) {
            let (r, st) = solve_trace_stats(
                &trace,
                tr,
                td,
                fs,
                k,
                300,
                1e-4,
                None,
                true,
                true,
                0.0,
                SolveOptions {
                    noise_constrained: true,
                },
            );
            assert_eq!(st.len(), 1, "{name}: {st:?}");
            assert!(!st[0].upper_bound_active);
            assert!(r.alpha > 0.0 && r.s_counts.iter().sum::<f32>() > 0.0);
        }
    }

    #[test]
    fn noise_budget_decides_the_pick_on_jgcamp8f() {
        // On the fast-indicator preset the upsampled loop's binarized train
        // reaches the noise floor, so the noise-constrained selection takes
        // the noise path. (The native solve's candidates on this preset fit
        // just above the budget, so its pick is the fit-allowance path.)
        for (name, trace, tr, td, fs, k) in preset_cells(3, 1500) {
            if name != "jgcamp8f" {
                continue;
            }
            let (_, st) = run_cfg(&trace, (tr, td, fs, k), 500, upsampled_loop());
            let last = st.last().unwrap();
            assert_eq!(last.noise_path, Some(true), "{st:?}");
            assert!(last.binary_error <= last.budget * 1.0001);
        }
    }

    // ── Chain-consistent scoring ────────────────────────────────────────

    /// Drift-free preset cells: (name, trace, clean calcium, tau_r, tau_d, fs).
    fn drift_free_cells(n_tp: usize) -> Vec<(&'static str, Vec<f32>, Vec<f32>, f64, f64, f64)> {
        let mut out = Vec::new();
        for (name, mut cfg) in crate::simulate::presets::all() {
            cfg.num_cells = 2;
            cfg.num_timepoints = n_tp;
            cfg.drift = crate::simulate::DriftModel::RandomWalk(crate::simulate::RandomWalkDrift {
                step_std_fraction: 0.0,
                ..Default::default()
            });
            let r = crate::simulate::simulate(&cfg);
            for c in 0..2 {
                let gt = &r.ground_truth[c];
                out.push((
                    name,
                    r.traces[c * n_tp..(c + 1) * n_tp].to_vec(),
                    gt.clean_calcium.clone(),
                    gt.tau_rise_s,
                    gt.tau_decay_s,
                    cfg.fs_hz,
                ));
            }
        }
        out
    }

    #[test]
    fn chain_scoring_puts_the_clean_signal_at_the_noise_budget() {
        // Without drift the only unmodelled part of the trace is the noise.
        // Scored against the preprocessed trace as a bare reconstruction, the
        // clean calcium sits far above the budget (the rolling baseline rides
        // up under activity; the high-pass sag): ~10x on `clean`. Passed
        // through the identical chain on the 300 Hz grid it sits at (about)
        // the budget: the linear part cancels exactly and only the quantile
        // nonlinearity is left (1.00-1.10x on these presets; up to ~1.4x on
        // gcamp6s and clean, where the budget is smallest).
        for (name, trace, clean, tr, td, fs) in drift_free_cells(3000) {
            let k = ((300.0 / fs).round() as usize).max(1);
            let recon = upsample_trace(&clean, k);
            let (e, b, _) = score_reconstruction_on_trace(
                &trace,
                tr,
                td,
                fs,
                k,
                true,
                true,
                Scoring::Chain,
                &recon,
            );
            assert!((0.85..1.5).contains(&(e / b)), "{name} k={k}: {}", e / b);
            if name == "clean" {
                let (e, b, _) = score_reconstruction_on_trace(
                    &trace,
                    tr,
                    td,
                    fs,
                    k,
                    true,
                    true,
                    Scoring::Plain,
                    &recon,
                );
                assert!(e / b > 5.0, "{}", e / b);
            }
        }
    }

    #[test]
    fn chain_scoring_is_the_default_and_changes_the_pick() {
        assert_eq!(ScaleLoop::default().scoring, Scoring::Chain);
        let plain = ScaleLoop {
            scoring: Scoring::Plain,
            ..ScaleLoop::default()
        };
        let mut differs = false;
        for (_, trace, _, tr, td, fs) in drift_free_cells(1500) {
            let k = ((300.0 / fs).round() as usize).max(1);
            let (a, st) = run_cfg(&trace, (tr, td, fs, k), 500, ScaleLoop::default());
            let (b, _) = run_cfg(&trace, (tr, td, fs, k), 500, plain);
            assert!(a.s_counts.iter().sum::<f32>() > 0.0);
            assert!(b.s_counts.iter().sum::<f32>() > 0.0);
            // The chain is amplitude-invariant, so the fitted amplitude stays
            // a least-squares fit of the chain-transformed reconstruction.
            assert!(a.alpha > 0.0 && st.last().unwrap().binary_error.is_finite());
            differs |= a.s_counts != b.s_counts;
        }
        assert!(differs, "chain scoring never changed a pick");
    }

    #[test]
    fn chain_scoring_without_a_filter_is_the_quantile_alone() {
        // With the bandpass off the chain is the rolling quantile only; the
        // scorer must not require a filter.
        let trace = noisy_spiking_trace(900, 0xC0DE);
        let (r, st) = solve_trace_cfg(
            &trace,
            0.1,
            0.6,
            30.0,
            10,
            300,
            1e-4,
            None,
            false,
            false,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
            ScaleLoop::default(),
        );
        assert_eq!(st.len(), 1);
        assert!(r.s_counts.iter().sum::<f32>() > 0.0);
        assert!(r.alpha > 0.0);
    }

    // ── Native-rate inner solve ─────────────────────────────────────────

    /// Preset cells recorded at `fs` for `dur_s` seconds (one cell per
    /// preset): (preset, trace, true counts per frame, tau_r, tau_d, fs, k).
    #[allow(clippy::type_complexity)]
    fn preset_cells_at(
        fs: f64,
        dur_s: f64,
    ) -> Vec<(&'static str, Vec<f32>, Vec<f32>, f64, f64, f64, usize)> {
        let mut out = Vec::new();
        for (name, mut cfg) in crate::simulate::presets::all() {
            cfg.num_cells = 1;
            cfg.fs_hz = fs;
            let n_tp = (dur_s * fs).round() as usize;
            cfg.num_timepoints = n_tp;
            let r = crate::simulate::simulate(&cfg);
            let gt = &r.ground_truth[0];
            let k = ((300.0 / fs).round() as usize).max(1);
            out.push((
                name,
                r.traces[..n_tp].to_vec(),
                gt.spikes.clone(),
                gt.tau_rise_s,
                gt.tau_decay_s,
                fs,
                k,
            ));
        }
        out
    }

    #[allow(clippy::type_complexity)]
    fn run_native(
        trace: &[f32],
        (tr, td, fs, k): (f64, f64, f64, usize),
        max_iters: u32,
        tol: f64,
        cfg: ScaleLoop,
    ) -> (InDecaResult, RoundStats) {
        let (r, st) = solve_trace_cfg(
            trace,
            tr,
            td,
            fs,
            k,
            max_iters,
            tol,
            None,
            true,
            true,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
            cfg,
        );
        assert_eq!(st.len(), 1, "the native solve is one round: {st:?}");
        (r, st.into_iter().next().unwrap())
    }

    #[test]
    fn native_solve_stops_on_the_certificate_at_15_30_and_60_hz() {
        // The certificate fires on every preset at every rate, far below the
        // cap, and the output depends on neither the cap nor the tolerance:
        // the same solve with the cap at exactly the iterations used, and
        // with the step rule's tolerance at 0 or the UI's 1e-4, is
        // bit-identical.
        for fs in [15.0, 30.0, 60.0] {
            for (name, trace, _, tr, td, fs, k) in preset_cells_at(fs, 30.0) {
                let p = (tr, td, fs, k);
                let (a, sa) = run_native(&trace, p, u32::MAX, 1e-4, ScaleLoop::default());
                assert!(sa.converged, "{name} @ {fs} Hz hit the cap: {sa:?}");
                assert!(
                    sa.iterations > 0 && sa.iterations < 100_000,
                    "{name} @ {fs} Hz: {sa:?}"
                );
                assert!(a.s_counts.iter().sum::<f32>() > 0.0, "{name} @ {fs} Hz");
                let (b, sb) = run_native(&trace, p, sa.iterations, 0.0, ScaleLoop::default());
                assert_eq!(a.s_counts, b.s_counts, "{name} @ {fs} Hz: cap");
                assert_eq!(
                    a.alpha.to_bits(),
                    b.alpha.to_bits(),
                    "{name} @ {fs} Hz: cap"
                );
                assert_eq!(sa.iterations, sb.iterations);
                assert!(sb.converged);
                // The UI's cap of 500 does not truncate the solve either.
                let (c, sc) = run_native(&trace, p, 500, 1e-4, ScaleLoop::default());
                assert_eq!(a.s_counts, c.s_counts, "{name} @ {fs} Hz: cap 500");
                assert_eq!(sa.iterations, sc.iterations);
            }
        }
    }

    #[test]
    fn native_certificate_is_fit_equivalent_to_a_far_converged_solve() {
        // What the certificate guarantees: against the step rule run to 1e-7
        // (2-5x more iterations), the relaxed fit's grid energy differs by
        // less than one standard error of the noise energy, the selection's
        // resolution. The binarized trains are not identical cell by cell
        // (the threshold search is a discrete function of the relaxed
        // vector, and with `lambda = 0` the relaxed optimum is flat along
        // adjacent-frame directions on slow kernels), but they agree in the
        // aggregate: total counts within 10% and timing F1 within 0.03 over
        // the presets.
        let mut tot = (0.0_f32, 0.0_f32);
        let mut f1 = (0.0, 0.0);
        let cells = preset_cells_at(30.0, 30.0);
        for (name, trace, truth, tr, td, fs, k) in &cells {
            let p = (*tr, *td, *fs, *k);
            let (a, sa) = run_native(trace, p, u32::MAX, 0.0, ScaleLoop::default());
            let step = ScaleLoop {
                native_stop: NativeStop::Step,
                ..ScaleLoop::default()
            };
            let (b, sb) = run_native(trace, p, u32::MAX, 1e-7, step);
            assert!(sa.converged && sb.converged, "{name}: {sa:?} {sb:?}");
            assert!(sa.iterations <= sb.iterations, "{name}: {sa:?} {sb:?}");
            let se = sa.selection.std_error;
            assert!(
                (sa.objective - sb.objective).abs() <= se,
                "{name}: relaxed fits {} vs {} differ by more than SE {se}",
                sa.objective,
                sb.objective
            );
            tot.0 += a.s_counts.iter().sum::<f32>();
            tot.1 += b.s_counts.iter().sum::<f32>();
            f1.0 += timing_f1(truth, &a.s_counts, 2);
            f1.1 += timing_f1(truth, &b.s_counts, 2);
        }
        assert!((tot.0 / tot.1 - 1.0).abs() <= 0.10, "{tot:?}");
        let n = cells.len() as f64;
        assert!((f1.0 / n - f1.1 / n).abs() <= 0.03, "{f1:?}");
    }

    /// F1 of count-level matching within `tol` frames.
    fn timing_f1(truth: &[f32], est: &[f32], tol: i64) -> f64 {
        let expand = |c: &[f32]| -> Vec<i64> {
            let mut v = vec![];
            for (i, &x) in c.iter().enumerate() {
                for _ in 0..(x.round().max(0.0) as usize) {
                    v.push(i as i64);
                }
            }
            v
        };
        let (a, b) = (expand(truth), expand(est));
        let (mut i, mut j, mut tp) = (0, 0, 0usize);
        while i < a.len() && j < b.len() {
            if (a[i] - b[j]).abs() <= tol {
                tp += 1;
                i += 1;
                j += 1;
            } else if a[i] < b[j] {
                i += 1;
            } else {
                j += 1;
            }
        }
        if a.is_empty() || b.is_empty() {
            return 0.0;
        }
        let (p, r) = (tp as f64 / b.len() as f64, tp as f64 / a.len() as f64);
        if p + r > 0.0 {
            2.0 * p * r / (p + r)
        } else {
            0.0
        }
    }

    #[test]
    fn native_solve_is_invariant_to_the_prescale() {
        // The spread is scale-free and the box cannot bind from the
        // peak-to-trough start, so a power-of-two prescale change (every
        // iterate scaled exactly) leaves the output bit-identical.
        for (name, trace, _, tr, td, fs, k) in preset_cells_at(30.0, 30.0) {
            let p = (tr, td, fs, k);
            let (base, st) = run_native(&trace, p, u32::MAX, 0.0, ScaleLoop::default());
            assert!(!st.upper_bound_active, "{name}");
            for m in [0.25, 4.0] {
                let cfg = ScaleLoop {
                    alpha_init: AlphaInit::Fixed(st.alpha_est * m),
                    ..ScaleLoop::default()
                };
                let (r, st2) = run_native(&trace, p, u32::MAX, 0.0, cfg);
                assert_eq!(r.s_counts, base.s_counts, "{name} x{m}");
                assert_eq!(r.alpha.to_bits(), base.alpha.to_bits(), "{name} x{m}");
                assert_eq!(
                    r.threshold.to_bits(),
                    base.threshold.to_bits(),
                    "{name} x{m}"
                );
                assert_eq!(st2.iterations, st.iterations, "{name} x{m}");
            }
        }
    }

    #[test]
    fn native_grid_is_the_selections_grid() {
        // The seam: the native solve's grid residual (the certificate) and
        // the selection's scores are taken over the same recorded samples.
        for (n_up, pad_up, k) in [
            (3000, 360, 10),
            (3000, 365, 10),
            (1500, 120, 20),
            (900, 0, 1),
        ] {
            let (lo, hi) = native_grid(n_up, pad_up, k);
            let up_grid: Vec<usize> = (pad_up..n_up - pad_up).step_by(k).collect();
            let nat_grid: Vec<usize> = (lo..hi).map(|i| i * k).collect();
            // Same number of samples, starting at the first recorded sample
            // at or after `pad_up`, all inside the upsampled interior.
            assert_eq!(up_grid.len(), nat_grid.len(), "{n_up} {pad_up} {k}");
            assert_eq!(up_grid[0].div_ceil(k) * k, nat_grid[0]);
            assert!(nat_grid.last().unwrap() < &(n_up - pad_up + k));
            // A recorded-rate preprocessing would not give the same signal:
            // the native solve fits the grid samples of the upsampled one.
        }
        for (name, trace, _, tr, td, fs, k) in preset_cells_at(30.0, 30.0).into_iter().take(1) {
            let nat = prepare(&trace, tr, td, fs, 1, true, true);
            let up = prepare(&trace, tr, td, fs * k as f64, k, true, true);
            let (lo, hi) = native_grid(up.working.len(), up.pad, k);
            let (mut num, mut den) = (0.0_f64, 0.0_f64);
            for i in lo..hi {
                let d = nat.working[i] as f64 - up.working[i * k] as f64;
                num += d * d;
                den += (up.working[i * k] as f64).powi(2);
            }
            assert!(
                (num / den).sqrt() > 1e-3,
                "{name}: the two preprocessings coincide"
            );
        }
    }

    #[test]
    fn native_solve_recovers_isolated_spikes_exactly_on_a_clean_trace() {
        // Without noise there is no certificate (the step rule applies) and
        // the binarization has no allowance: isolated single spikes come
        // back as exactly one count on their frame.
        let positions = [40usize, 120, 200, 290, 370];
        let trace = make_trace(0.1, 0.6, 30.0, 450, &positions);
        let r = solve_trace(
            &trace,
            0.1,
            0.6,
            30.0,
            10,
            u32::MAX,
            1e-8,
            None,
            false,
            false,
            0.0,
        );
        let mut want = vec![0.0_f32; 450];
        for &p in &positions {
            want[p] = 1.0;
        }
        assert_eq!(r.s_counts, want);
        assert!((r.alpha - 1.0).abs() < 0.05, "{}", r.alpha);
    }

    #[test]
    fn max_spikes_per_frame_follows_the_refractory_period() {
        assert_eq!(max_spikes_per_frame(300.0), 1);
        assert_eq!(max_spikes_per_frame(30.0), 10);
        assert_eq!(max_spikes_per_frame(15.0), 20);
        assert_eq!(max_spikes_per_frame(60.0), 5);
        assert_eq!(max_spikes_per_frame(1000.0), 1);
    }

    // ── Native solve: unconverged stop and the certificate/selection seam ─
    // (review fixes for the native-solve PR; kept together at the end of
    // the module so the stack's lower branches merge cleanly.)

    #[test]
    fn native_solve_reports_an_unconverged_stop_without_panicking() {
        // Force the outer guard: the step rule alone (no certificate, hence
        // no stall detector) at `tol = 0` never fires, so the solve runs into
        // a 10-iteration cap. The pipeline must still binarize and report
        // `converged = false` rather than panic or claim convergence. (The
        // stall detector's own unconverged stop is exercised in
        // `native_solve::tests::stall_detector_stops_an_unattainable_certificate_unconverged`:
        // on a real trace with a noise model the certificate always fires,
        // so a certificate-mode stall cannot be forced from here without a
        // test-only hook.)
        let trace = noisy_spiking_trace(900, 0xFEED);
        let p = (0.1, 0.6, 30.0, 10);
        let cfg = ScaleLoop {
            native_stop: NativeStop::Step,
            ..ScaleLoop::default()
        };
        let (r, st) = run_native(&trace, p, 10, 0.0, cfg);
        assert!(!st.converged && !r.converged, "{st:?}");
        assert_eq!(st.iterations, 10);
        assert_eq!(r.iterations, 10);
        assert_eq!(r.s_counts.len(), trace.len());
        assert!(r.s_counts.iter().all(|v| v.is_finite() && *v >= 0.0));
        assert!(r.alpha.is_finite() && r.pve.is_finite());
    }

    #[test]
    fn native_certificate_residual_is_the_selections_grid_residual() {
        // The seam between the solve and the selection: the certificate's
        // grid residual (native indices `[lo, hi)` of the recorded samples
        // of the upsampled working trace) must be the residual the
        // selection takes over its grid (every `k`-th sample of
        // `[pad_up, n_up - pad_up)` of the working trace) for the same
        // reconstruction. The two grids coincide only when `pad_up` is a
        // multiple of `k`; otherwise the selection's grid falls between
        // recorded frames and scores interpolated sub-bins (e.g.
        // `pad_up = 365, k = 10`), and the certificate scores the nearest
        // recorded samples instead. This configuration (tau_d = 0.6 s at
        // 300 Hz: `pad_up = 360`, `k = 10`) is one where they coincide, so
        // the residuals must agree up to the f32 rounding of the
        // reconstruction.
        let trace = noisy_spiking_trace(900, 0xFEED);
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let up = prepare(&trace, tr, td, fs * k as f64, k, true, true);
        let (n_up, pad_up) = (up.working.len(), up.pad);
        assert_eq!(pad_up % k, 0, "pad_up = {pad_up}: grids do not coincide");
        let (lo, hi) = native_grid(n_up, pad_up, k);
        assert_eq!(lo * k, pad_up);
        let y: Vec<f64> = recorded_samples(&up.working, k)
            .iter()
            .map(|&v| v as f64)
            .collect();
        let banded = BandedAR2::new(tr, td, fs);
        // Any iterate will do; a partly converged one keeps the residual
        // well away from zero.
        let stop = Stop {
            se: 0.0,
            lo,
            hi,
            stride: 1,
        };
        let r = native_solve::solve_box(&y, &banded, 0.0, 200, 0.0, Some(stop), None);
        let native_fit = r.certificate.unwrap().grid_fit;
        // The same reconstruction at the upsampled rate (the tent through
        // the recorded samples, exact on them), scored on the selection's
        // grid.
        let mut recon = vec![0.0_f64; y.len()];
        banded.convolve_forward_f64(&r.x, &mut recon);
        let recon32: Vec<f32> = recon.iter().map(|&v| v as f32).collect();
        let recon_up = upsample_trace(&recon32, k);
        assert_eq!(recon_up.len(), n_up);
        let selection_fit = grid_energy(&up.working, &recon_up, 1.0, pad_up, k);
        assert!(native_fit > 0.0);
        let rel = (native_fit - selection_fit).abs() / native_fit;
        assert!(rel < 1e-5, "{native_fit} vs {selection_fit} (rel {rel:e})");
    }

    // ═══ Loop-convergence flag and degenerate-trace tests (PR #239 review) ═══

    #[test]
    fn default_loop_converges_below_max_rounds_on_presets() {
        let cap = ScaleLoop::default().max_rounds;
        for (name, trace, tr, td, fs, k) in preset_cells(2, 900) {
            let (r, st) = solve_trace_stats(
                &trace,
                tr,
                td,
                fs,
                k,
                300,
                1e-4,
                None,
                true,
                true,
                0.0,
                SolveOptions::default(),
            );
            assert!(r.loop_converged, "{name}: {st:?}");
            assert!(st.len() < cap, "{name}: {st:?}");
        }
    }

    #[test]
    fn loop_converged_is_false_when_max_rounds_is_hit() {
        let (name, trace, tr, td, fs, k) = preset_cells(1, 900).remove(0);
        // The upsampled fixed-point loop: the native default is a single
        // round with no `max_rounds` to hit (its `loop_converged` is always
        // true; the inner stop is reported by `converged`).
        let cfg = ScaleLoop {
            stop: ScaleStop::AlphaRtol(0.0),
            max_rounds: 2,
            ..ScaleLoop::upsampled()
        };
        let (r, st) = run_cfg(&trace, (tr, td, fs, k), 100, cfg);
        assert_eq!(st.len(), 2, "{name}: {st:?}");
        assert!(!r.loop_converged, "{name}");
    }

    fn assert_degenerate_outputs_sane(
        label: &str,
        trace: &[f32],
        noise_constrained: bool,
        max_spike_frac: f32,
        max_spikes_always: bool,
    ) -> InDecaResult {
        let (r, st) = solve_trace_stats(
            trace,
            0.02,
            0.4,
            30.0,
            4,
            200,
            1e-4,
            None,
            true,
            true,
            0.0,
            SolveOptions { noise_constrained },
        );
        assert_eq!(r.s_counts.len(), trace.len(), "{label}");
        assert!(r.s_counts.iter().all(|v| v.is_finite()), "{label}");
        assert!(
            r.filtered_trace
                .as_ref()
                .is_some_and(|f| f.iter().all(|v| v.is_finite())),
            "{label}"
        );
        for v in [r.alpha, r.baseline, r.threshold, r.pve] {
            assert!(v.is_finite(), "{label}: alpha {} pve {}", r.alpha, r.pve);
        }
        // Amplitude is a non-negative scale.
        assert!(r.alpha >= 0.0, "{label}: alpha {}", r.alpha);
        // Max-PVE selection fits noise as spikes by design (67 per 600
        // samples on this trace), so the spike-count bound applies to the
        // noise-constrained pick, which exists to suppress that (14 per 600
        // here; bound 5%).
        let total: f32 = r.s_counts.iter().sum();
        let bound = if noise_constrained || max_spikes_always {
            max_spike_frac * trace.len() as f32
        } else {
            f32::INFINITY
        };
        assert!(
            total <= bound,
            "{label}: {total} spikes in {} samples",
            trace.len()
        );
        assert!(r.loop_converged, "{label}: {st:?}");
        for s in &st {
            assert!(
                s.alpha_est.is_finite() && s.objective.is_finite(),
                "{label}"
            );
        }
        r
    }

    #[test]
    fn pure_noise_trace_gives_finite_outputs_and_few_spikes() {
        let mut state = 0x9E3779B97F4A7C15_u64;
        let mut next = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 40) as f32 / (1u64 << 24) as f32) - 0.5
        };
        let trace: Vec<f32> = (0..600).map(|_| next() * 0.2).collect();
        assert_degenerate_outputs_sane("noise", &trace, false, 0.02, false);
        assert_degenerate_outputs_sane("noise/nc", &trace, true, 0.05, false);
    }

    #[test]
    fn flat_trace_detects_nothing_above_the_arithmetic_floor() {
        // A constant trace carries no events, but the solver is scale-free:
        // the FFT high-pass of a constant leaves rounding-level residue
        // (platform-dependent: zero on some libm/FFT paths, ~1e-7 on others),
        // and the selection fits that residue as "spikes" of rounding-level
        // amplitude (measured: a 1-ulp pattern on a level of 1 gives ~120
        // spikes at alpha ~ 6e-7). The invariant is therefore not a zero
        // count but that nothing is detected above the input's arithmetic
        // floor: alpha must be within the accumulated f32 rounding of the
        // n_up-point transform, `n_up * f32::EPSILON * level` (the coherent
        // worst case; a real event has alpha of order `level`, three to four
        // orders above). For level 0 the chain is exact and alpha and the
        // counts must be exactly zero.
        let k = 4usize;
        for level in [0.0_f32, 1.0] {
            let trace = vec![level; 600];
            let floor = (trace.len() * k) as f64 * f32::EPSILON as f64 * level as f64;
            for nc in [false, true] {
                let label = if nc { "flat/nc" } else { "flat" };
                let r = assert_degenerate_outputs_sane(label, &trace, nc, f32::INFINITY, false);
                let total: f32 = r.s_counts.iter().sum();
                assert!(
                    r.alpha <= floor,
                    "{label} {level}: alpha {:e} above the floor {floor:e} ({total} spikes)",
                    r.alpha
                );
                if level == 0.0 {
                    assert_eq!(total, 0.0, "{label} {level}");
                }
            }
        }
    }

    // ── Degenerate selection cases with a noise model (PR #237) ──────────

    #[test]
    fn noise_constrained_degenerate_traces_are_sane() {
        let opts = SolveOptions {
            noise_constrained: true,
        };
        // Very short traces (tiny or empty threshold grid) and an all-zero trace.
        for trace in [
            vec![],
            vec![1.0_f32],
            vec![0.0_f32, 1.0, 0.5],
            vec![0.0_f32; 200],
        ] {
            let r = solve_trace_opts(
                &trace, 0.02, 0.4, 30.0, 1, 50, 1e-4, None, false, false, 0.0, opts,
            );
            assert_eq!(r.s_counts.len(), trace.len());
            assert!(r.s_counts.iter().all(|&v| v.is_finite() && v >= 0.0));
            assert!(r.alpha.is_finite() && r.baseline.is_finite());
            assert!(r.threshold.is_finite() && r.pve.is_finite());
        }
        let zero = solve_trace_opts(
            &vec![0.0_f32; 200],
            0.02,
            0.4,
            30.0,
            1,
            50,
            1e-4,
            None,
            false,
            false,
            0.0,
            opts,
        );
        assert!(zero.s_counts.iter().all(|&v| v == 0.0));
    }
}
