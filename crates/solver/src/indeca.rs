/// InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
///
/// The scale loop is block-coordinate descent on the relaxed problem
///
/// ```text
/// min over s in [0,1]^T, alpha >= 0:  || y - alpha K s ||^2
/// ```
///
/// (`y` the upsampled, filtered, baseline-subtracted trace, `K` the
/// peak-normalized AR(2) kernel), followed by one terminal binarization (the
/// threshold search, which also fits the reported amplitude and offset).
/// The binarization scores every candidate train through the trace's own
/// preprocessing chain ([`Scoring::Chain`], the `chain` module): the
/// bandpass and the rolling-quantile baseline are applied to `K s` exactly
/// as they were to the trace, so the candidate and the trace carry the same
/// filter-injected structure.
///
/// - s-step: Box[0,1] FISTA on `y / alpha`.
/// - alpha-step: least squares of `y` on the relaxed reconvolution `K s`.
///
/// The relaxed objective cannot identify the amplitude: any `alpha` at or
/// above the saturation amplitude (where the box upper bound stops binding)
/// gives the same fit, and the s-step there is the scale-free non-negative fit,
/// so its normalized solution, and the binarization, do not depend on
/// `alpha`. The fixed points are exactly that set. Starting from the trace's
/// peak-to-trough (which no relaxed bin can exceed, since the kernel is
/// peak-normalized) the loop is at a fixed point after its first round; from a
/// binding start it raises `alpha` with a non-increasing objective until the
/// box is inactive. The amplitude is identified only by the binarization.
///
/// The original InDeCa update takes `alpha` from the binarized train instead.
/// That map is not a descent step on the relaxed objective; on the simulation
/// presets its fixed point lies at 0.15-0.4x the true spike amplitude, with
/// several bins per spike (the overfit regime the InDeCa paper describes), and
/// stopping it at a 5% tolerance stops it at an arbitrary round. It remains
/// available as [`ScaleLoop::binary_alpha`] for characterization.
///
/// The AR2 forward model is peak-normalized so that a single spike produces
/// a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
use crate::banded::BandedAR2;
use crate::chain::{Chain, Scorer};
use crate::filter::BandpassFilter;
use crate::threshold::{threshold_search_scored, NoiseModel, Selection, ThresholdResult};
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
/// that follows is a slow, mild high-pass and is not modelled.)
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
/// 1. Upsample, apply optional bandpass filter, subtract rolling baseline
/// 2. Prescale by the trace's peak-to-trough
/// 3. Scale loop (see the module docs): Box[0,1] FISTA, relaxed amplitude
///    step, until a fixed point (normally after one round)
/// 4. Binarize the last relaxed solution (threshold search) and downsample
///
/// `max_iters` and `tol` set the inner FISTA solve (relative-step rule). With
/// `lambda = 0` the relaxed problem is ill-posed at the upsampled rate (sub-bin
/// rearrangements barely change the fit), so the solve does not reach the
/// step tolerance within the usual budget (500 iterations; it fires only
/// around 3,300-4,100 iterations on the simulation presets), so `max_iters`
/// acts as an early-stopping regularizer: the binarized output depends on it. A data-dependent stop
/// (the noise-scaled fit-window rule) is available as
/// [`ScaleLoop::fit_stop`] but makes the output sensitive to tiny input
/// changes, because it moves the stopping point along that drift.
///
/// `warm_counts`: optional spike counts from a previous iteration at the **original**
/// sampling rate. These are upsampled to a binary trace at the upsampled rate and
/// used as the first round's FISTA warm-start **only on the non-default
/// `binary_alpha` loop**. The default loop ignores it: with a fixed iteration
/// budget acting as the regularizer, a binary (all 1.0) seed at the
/// peak-to-trough prescale (relaxed peak ~0.02) is a 40-100x mismatch and
/// makes the output depend on the seed, with no speed benefit. Every outer
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

/// Structure of the scale loop. `Default` is the shipped behavior; the other
/// settings exist for characterization and are crate-internal.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ScaleLoop {
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
    /// Safety net on the number of rounds.
    pub max_rounds: usize,
    /// How the binarization candidates are scored.
    pub scoring: Scoring,
}

impl ScaleLoop {
    /// The loop before this module's rework, with the noise-scaled inner stop
    /// and warm-started rounds (the loop shipped before the scale-loop rework).
    pub(crate) fn binary_alpha() -> Self {
        Self {
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
}

impl Default for ScaleLoop {
    /// Block-coordinate descent on the relaxed objective with a fixed inner
    /// iteration budget (see the module docs).
    fn default() -> Self {
        Self {
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

    fn relaxed_loop() -> ScaleLoop {
        ScaleLoop::default()
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
            let (_, st) = run_cfg(&trace, (tr, td, fs, k), 300, relaxed_loop());
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
        let (base, st) = run_cfg(&trace, p, 300, relaxed_loop());
        assert_eq!(st.len(), 1, "fixed point after one round: {st:?}");
        for m in [2.0, 8.0] {
            let cfg = ScaleLoop {
                alpha_init: AlphaInit::Fixed(st[0].alpha_est * m),
                ..relaxed_loop()
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
        let (base, st) = run_cfg(&trace, p, 300, relaxed_loop());
        let total = base.s_counts.iter().sum::<f32>();
        for m in [1.5, 3.0] {
            let cfg = ScaleLoop {
                alpha_init: AlphaInit::Fixed(st[0].alpha_est * m),
                ..relaxed_loop()
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
        let (_, st) = run_cfg(&trace, p, 300, relaxed_loop());
        let sat = st[0].alpha_sat;
        let cfg = ScaleLoop {
            alpha_init: AlphaInit::Fixed(sat / 8.0),
            warm_rounds: true,
            ..relaxed_loop()
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
        let (relaxed, _) = run_cfg(&trace, p, 300, relaxed_loop());
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
                    ..relaxed_loop()
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
            ..relaxed_loop()
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
        // On the fast-indicator preset the binarized train reaches the noise
        // floor, so the noise-constrained selection takes the noise path.
        for (name, trace, tr, td, fs, k) in preset_cells(3, 1500) {
            if name != "jgcamp8f" {
                continue;
            }
            let (_, st) = run_cfg(&trace, (tr, td, fs, k), 500, relaxed_loop());
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
}
