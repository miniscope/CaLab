//! InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
//!
//! The relaxed problem is
//!
//! ```text
//! min over s >= 0 (boxed), alpha >= 0:  || y - alpha K s ||^2
//! ```
//!
//! (`y` the filtered, baseline-subtracted trace, `K` the peak-normalized
//! AR(2) kernel), followed by one terminal binarization at the spike
//! resolution rate (300 Hz): the threshold search, which also fits the
//! reported amplitude and offset. The binarization scores every candidate
//! train through the trace's own preprocessing chain ([`Scoring::Chain`],
//! the `chain` module): the bandpass and the rolling-quantile baseline are
//! applied to `K s` exactly as they were to the trace, so the candidate and
//! the trace carry the same filter-injected structure.
//!
//! # Where the relaxed problem is solved
//!
//! The relaxed problem is solved at the **recorded** rate: one Box[0, n_max]
//! FISTA on `y / alpha` with `n_max` the refractory cap
//! ([`max_spikes_per_frame`]), at the peak-to-trough prescale (where the box
//! cannot bind, so the fit is the scale-free non-negative one). The frame
//! masses are then spread over the 300 Hz sub-bins by linear interpolation
//! ([`crate::spread::Spread::Interp`], the tent the trace upsampler applies)
//! and binarized. One round: the spread is scale-free (its normalized shape
//! does not depend on the prescale), so an amplitude step cannot change the
//! binarization. The amplitude is identified only by the binarization.
//!
//! At the recorded rate the relaxed problem has no sub-frame directions the
//! data cannot determine, and the solve converges: it stops on a
//! convergence certificate ([`crate::native_solve`]: the remaining movement
//! of the fit, bounded by a dual gap, can no longer change the grid
//! residual energy by one standard error of the noise energy, the
//! selection's own resolution). The caller's relative-step tolerance applies
//! only when the trace has no measurable noise (no certificate). If the
//! certificate cannot be met in f64, a stall detector on the certificate's
//! own bound stops the solve unconverged (`converged = false`); the
//! iteration cap is derived from the problem
//! ([`crate::native_solve::iteration_cap`], 1e5-1e9, with the caller's
//! `max_iters` as a floor on it) and is an outer guard only. The output
//! does not depend on the cap (measured: zero cap hits and zero stalls at
//! 15, 30 and 60 Hz on the simulation presets, 400-4,000 iterations at
//! 30 Hz, up to 34,000 for GCaMP6s at 60 Hz) nor on the tolerance.
//!
//! Solving at the 300 Hz rate instead (Box[0,1] FISTA on the upsampled
//! trace) is ill-posed with `lambda = 0`: sub-bin rearrangements barely
//! change the fit, the relative-step rule does not fire within a usual
//! budget, and the iteration cap becomes an early-stopping regularizer the
//! output depends on (counts move 7-11% between a 500 and a 2000 cap).
//!
//! The AR2 forward model is peak-normalized so that a single spike produces
//! a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
use crate::banded::BandedAR2;
use crate::chain::{Chain, Scorer};
use crate::filter::BandpassFilter;
use crate::native_solve::{self, Stop};
use crate::spread::{spread, Spread};
use crate::threshold::{
    threshold_search_scored, NoiseModel, Selection, SelectionDiag, ThresholdResult,
};
use crate::upsample::{downsample_average, downsample_binary, upsample_trace};
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
    /// `grid` with the rolling-quantile stage's gain on the noise energy
    /// folded in ([`chain_noise_gain`]): `sigma` scaled by `sqrt(chain_gain)`.
    /// `grid` itself describes the linear part of the chain only.
    pub grid_chain: NoiseModel,
    /// Residual noise energy through the full chain relative to its linear
    /// part (1 when not measured).
    pub chain_gain: f64,
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
///
/// `h` is measured exactly by pushing a unit impulse through the same
/// upsample → filter path (no random probe). The rolling-quantile baseline
/// that follows is nonlinear and is not part of `h`; its gain on the noise
/// energy is measured separately on the trace by [`chain_noise_gain`] and
/// folded into `grid_chain`.
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
        grid_chain: NoiseModel {
            sigma: 0.0,
            corr_sum: 1.0,
        },
        chain_gain: 1.0,
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
    let grid = NoiseModel {
        sigma: sigma_raw * grid_gain.sqrt(),
        corr_sum: (n as f64 * s4 / (s2 * s2)).max(1.0),
    };
    NoiseEstimate {
        grid,
        grid_chain: grid,
        chain_gain: 1.0,
    }
}

impl NoiseEstimate {
    /// Fold the measured chain gain into `grid_chain`.
    fn with_chain_gain(mut self, gain: f64) -> Self {
        self.chain_gain = gain;
        self.grid_chain = NoiseModel {
            sigma: self.grid.sigma * gain.sqrt(),
            corr_sum: self.grid.corr_sum,
        };
        self
    }

    /// Per-sample noise variance of the preprocessed (working) trace at the
    /// recorded-rate grid positions: the linear chain's grid variance times
    /// the rolling-quantile stage's measured gain. 0 without a noise model.
    pub(crate) fn processed_var(&self) -> f64 {
        self.grid_chain.sigma * self.grid_chain.sigma
    }
}

/// Deterministic white Gaussian probe (LCG + Box-Muller) of `n` samples with
/// std `sigma`: the synthetic noise [`chain_noise_gain`] pushes through the
/// chain. The seed is fixed so a trace always gets the same budget; the
/// probe's length and std come from the trace.
fn gaussian_probe(n: usize, sigma: f64) -> Vec<f32> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64) / (1u64 << 53) as f64
    };
    (0..n)
        .map(|_| {
            let u1 = next().max(1e-300);
            let u2 = next();
            let r = (-2.0 * u1.ln()).sqrt();
            (sigma * r * (2.0 * std::f64::consts::PI * u2).cos()) as f32
        })
        .collect()
}

/// `||d - mean(d)||^2` over the interior grid positions (every `stride`-th
/// sample of `[pad, n - pad)`): the residual energy a vector carries once
/// the fit's offset has absorbed its mean.
fn centered_grid_energy(d: &[f32], pad: usize, stride: usize) -> f64 {
    let n = d.len();
    let idx = (pad..n.saturating_sub(pad)).step_by(stride.max(1));
    let count = idx.clone().count();
    if count == 0 {
        return 0.0;
    }
    let mean = idx.clone().map(|i| d[i] as f64).sum::<f64>() / count as f64;
    idx.map(|i| (d[i] as f64 - mean).powi(2)).sum()
}

/// The rolling-quantile stage's gain on the noise energy, measured on the
/// trace itself.
///
/// The chain `C(z) = F(z) - RQ(F(z))` is linear up to the rolling quantile.
/// For a trace `y = s + e` (signal plus white noise) and a candidate scored
/// through the chain, the residual noise is `F(e) - [RQ(F(s) + F(e)) -
/// RQ(F(s))]`: the filtered noise minus the shift the noise gives the rolling
/// quantile. Over a window where the signal is flat the shift is the noise's
/// own sample quantile, `z_0.2 * sigma_F` plus a sampling fluctuation of
/// variance `p (1 - p) / (n_eff phi(z_p)^2) * sigma_F^2 ~ 2 sigma_F^2 / n_eff`,
/// negligible for the `25 tau_d fs` window; where the signal varies within
/// the window the shift depends on the window's signal distribution and
/// ranges between 0 and `z_0.2 * sigma_F`, a slowly varying term whose
/// variance is a few percent of `sigma_F^2` on the simulation presets. The
/// shift cannot be computed without the signal, so it is measured: white
/// Gaussian noise `e'` at the trace's own `sigma_raw` is added to the trace
/// and the energy of `C(y + e') - C(y)` on the selection grid is compared
/// with the energy of `F(e')`, the same realization through the linear part
/// alone (sharing the realization cancels its sampling error). The ratio is
/// the gain; the budget is the linear model's times the gain.
///
/// `working` is `C(y)` on the upsampled grid (`n * k` samples) and `filter`
/// the trace's bandpass (`None` when it was not applied).
fn chain_noise_gain(
    trace: &[f32],
    working: &[f32],
    filter: Option<&mut BandpassFilter>,
    upsample_factor: usize,
    bl_window: usize,
    pad: usize,
    sigma_raw: f64,
) -> f64 {
    let k = upsample_factor.max(1);
    let n = trace.len();
    if n == 0 || sigma_raw <= 0.0 || working.len() != n * k {
        return 1.0;
    }
    let probe = gaussian_probe(n, sigma_raw);
    let mut lin = upsample_trace(&probe, k);
    let added: Vec<f32> = trace.iter().zip(&probe).map(|(&t, &v)| t + v).collect();
    let mut full = upsample_trace(&added, k);
    if let Some(f) = filter {
        f.apply(&mut lin);
        f.apply(&mut full);
    }
    crate::baseline::subtract_rolling_baseline(
        &mut full,
        bl_window,
        crate::baseline::DEFAULT_BASELINE_QUANTILE,
    );
    for (v, &w) in full.iter_mut().zip(working) {
        *v -= w;
    }
    let e_lin = centered_grid_energy(&lin, pad, k);
    let e_full = centered_grid_energy(&full, pad, k);
    if e_lin > 0.0 && e_full.is_finite() && e_full > 0.0 {
        e_full / e_lin
    } else {
        1.0
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
    /// Always `true`: the solve is a single round with no outer loop cap.
    /// Kept so the result's serialized shape is unchanged.
    pub loop_converged: bool,
    /// Noise variance of the processed (working) trace per sample at the
    /// recorded-rate grid positions: `sigma_raw^2` through the linear chain
    /// (bandpass) times `chain_noise_gain`. The working trace is the
    /// baseline-subtracted trace `filtered_trace` reports, so
    /// `1 - noise_var_processed / var(filtered_trace)` bounds the PVE a fit
    /// can reach without fitting noise. 0 when no noise floor is measurable.
    pub noise_var_processed: f64,
    /// Gain of the full chain (bandpass and rolling quantile) on the noise
    /// energy relative to the bandpass alone (`chain_noise_gain`); 1 when not
    /// measured.
    pub chain_noise_gain: f64,
    /// The reported threshold pick came from the noise-constrained path: the
    /// best candidate overfit the noise floor by more than one SE, so the
    /// sparsest candidate within the budget was chosen instead of the max-PVE
    /// one. `false` means the selection equals max-PVE (always `false` when
    /// `noise_constrained` is off or the trace has no measurable noise floor).
    pub noise_path: bool,
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
///    module docs)
/// 4. Spread the frame masses over the `upsample_factor` sub-bins per frame,
///    binarize (threshold search at the upsampled rate) and downsample the
///    binary train to counts per frame
///
/// `max_iters` and `tol`: the relaxed solve stops on the data-derived
/// convergence certificate ([`crate::native_solve`]); `tol` (the
/// relative-step rule) is used only when the trace has no measurable noise
/// floor and so no certificate; `max_iters` is a floor on the safety cap,
/// which is derived from the problem ([`crate::native_solve::iteration_cap`])
/// so that a small caller cap (the apps pass 500) cannot truncate the solve.
/// The reported `iterations` is the native-rate FISTA iteration count
/// (400-4,000 at 30 Hz on the simulation presets, more on slow kernels at
/// high frame rates) and `converged` says the certificate (or, without
/// noise, the step rule) fired; it is `false` when the certificate's bound
/// stalled at its f64 floor (the stall detector, which is what stops an
/// unconvergeable solve in practice) or the cap was reached.
///
/// `warm_counts` is accepted for API compatibility (the WASM and Python
/// bindings pass it) and ignored: the solve converges on the certificate, so
/// a seed could only move where the certificate is first met, and the
/// output stays a deterministic function of the data.
#[allow(clippy::too_many_arguments)]
pub fn solve_trace_opts(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    _warm_counts: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    lambda: f64,
    opts: SolveOptions,
) -> InDecaResult {
    solve_trace_cfg(
        trace,
        tau_r,
        tau_d,
        fs,
        upsample_factor,
        max_iters,
        tol,
        hp_enabled,
        lp_enabled,
        lambda,
        opts,
        SolveConfig::default(),
    )
    .0
}

/// How the first round's prescale is chosen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AlphaInit {
    /// Peak-to-trough of the working trace's interior. The kernel is
    /// peak-normalized and the relaxed solution non-negative, so no relaxed
    /// bin can exceed this amplitude: the box upper bound cannot bind.
    PeakToTrough,
    /// A given prescale (tests of the prescale invariance).
    #[cfg(test)]
    Fixed(f64),
}

/// What candidate trains are scored against (see the `chain` module).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scoring {
    /// The bare reconstruction `K s` against the preprocessed trace (tests
    /// that measure what chain scoring changes).
    #[cfg(test)]
    Plain,
    /// Every reconstruction passed through the trace's own preprocessing
    /// chain (bandpass, rolling-quantile baseline) before the residual. The
    /// shipped rule.
    Chain,
}

/// When the native-rate relaxed solve stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeStop {
    /// The convergence certificate ([`crate::native_solve`]): the remaining
    /// movement of the fit is below one standard error of the noise energy.
    /// The caller's `tol` applies only without a noise model.
    Certificate,
    /// The relative-step rule at the caller's `tol` alone (tests: the
    /// fixed-tolerance reference the certificate is measured against).
    #[cfg(test)]
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

/// Settings of [`solve_trace_cfg`]. `Default` is the shipped behavior; the
/// other variants exist only for the tests that characterize it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SolveConfig {
    /// When the native-rate solve stops.
    pub native_stop: NativeStop,
    pub alpha_init: AlphaInit,
    /// How the binarization candidates are scored.
    pub scoring: Scoring,
}

impl Default for SolveConfig {
    /// The native-rate relaxed solve, spread and binarized at the upsampled
    /// rate with chain scoring (see the module docs).
    fn default() -> Self {
        Self {
            native_stop: NativeStop::Certificate,
            alpha_init: AlphaInit::PeakToTrough,
            scoring: Scoring::Chain,
        }
    }
}

/// Diagnostics of one [`solve_trace_cfg`] call.
#[derive(Clone, Debug, Default)]
pub(crate) struct SolveStats {
    /// The prescale the relaxed problem was solved at.
    pub alpha_est: f64,
    /// Smallest prescale at which the relaxed solution fits in the box
    /// (`alpha_est` times the relaxed interior peak).
    pub alpha_sat: f64,
    pub iterations: u32,
    pub converged: bool,
    /// Some interior bin of the relaxed solution sits at the box upper bound.
    pub upper_bound_active: bool,
    /// The threshold pick came from the noise budget.
    pub noise_path: bool,
    /// Joint objective `||y - alpha_est K s||^2` on the interior grid,
    /// after the s-step (trace units).
    pub objective: f64,
    /// Grid residual energy of the binarized train (selection statistic).
    pub binary_error: f64,
    /// Noise budget of the grid residual (0 without a noise model).
    pub budget: f64,
    /// The chain's measured noise gain (`NoiseEstimate::chain_gain`).
    pub chain_gain: f64,
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
    /// The selection's noise model: the linear chain's model with the
    /// rolling-quantile stage's measured gain folded in ([`chain_noise_gain`];
    /// `None` without noise).
    pub(crate) fn chain_noise_model(&self) -> Option<NoiseModel> {
        self.noise_model.map(|_| self.noise.grid_chain)
    }

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
    // It sets the threshold search's noise budget and standard error, and
    // the relaxed solve's convergence certificate.
    let noise = estimate_noise_model(trace, upsample_factor, filter.as_mut());
    // The rolling-quantile stage's gain on that noise, measured on the trace
    // ([`Budget::Chain`]).
    let gain = chain_noise_gain(
        trace,
        &working,
        filter.as_mut(),
        upsample_factor,
        bl_window,
        pad,
        high_band_sigma(trace),
    );
    let noise = noise.with_chain_gain(gain);
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

/// [`solve_trace_opts`] with explicit [`SolveConfig`] settings, plus
/// diagnostics. `upsample_factor` is the number of sub-bins per frame of the
/// binarization (the spike-resolution rate is `fs * upsample_factor`).
///
/// One preprocessing: the trace is upsampled, filtered and baseline-
/// subtracted, and the candidates are scored against that working trace
/// through the same chain. The relaxed solve fits the **grid samples** of
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
/// non-negative fit and one round is the whole solve: the spread is scale
/// free and the binarization fits every candidate its own amplitude, so a
/// second round at the binarized amplitude would binarize the same
/// normalized vector. (A round at the binarized amplitude could only differ
/// if the refractory box bound there, i.e. the pick put more than `n_max`
/// spikes' worth of mass in one frame, which the binarization itself caps
/// at `upsample_factor` spikes per frame.)
#[allow(clippy::too_many_arguments)]
pub(crate) fn solve_trace_cfg(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    lambda: f64,
    opts: SolveOptions,
    cfg: SolveConfig,
) -> (InDecaResult, SolveStats) {
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
    let noise_model = up.chain_noise_model();
    let budget = noise_model.map_or(0.0, |nm| nm.budget(n_grid));
    // The selection's resolution: one standard error of the noise energy
    // over the grid it scores on (trace units).
    let std_error = noise_model.map_or(0.0, |nm| nm.std_error(n_grid));
    let mut chain_up = (cfg.scoring == Scoring::Chain).then(|| up.take_chain());

    let alpha_est = match cfg.alpha_init {
        AlphaInit::PeakToTrough => estimate_alpha_interior(&y, lo),
        #[cfg(test)]
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
        #[cfg(test)]
        NativeStop::Step => None,
        NativeStop::Certificate => None,
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

    // ── Spread to the spike-resolution rate; normalize to the interior peak
    // before the threshold search ──
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
        alpha: _,
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
            noise_model,
        )
    };
    let s_counts = downsample_binary(&s_binary, k);

    let stats = SolveStats {
        alpha_est,
        alpha_sat: alpha_est * u_peak * cap,
        iterations,
        converged,
        upper_bound_active: u_peak >= 1.0,
        noise_path,
        objective,
        binary_error: error,
        budget,
        chain_gain: up.noise.chain_gain,
        selection: diag,
    };

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
            // The upsampled working trace at the recorded rate.
            filtered_trace: Some(downsample_average(&up.working, k)),
            alpha: alpha_out,
            baseline: baseline_out,
            threshold,
            pve,
            iterations,
            converged,
            // One round: there is no outer loop cap to hit; the inner
            // solve's stop is reported by `converged`.
            loop_converged: true,
            noise_var_processed: up.noise.processed_var(),
            chain_noise_gain: up.noise.chain_gain,
            noise_path,
        },
        stats,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::build_kernel;

    /// [`solve_trace_opts`] with the default options.
    #[allow(clippy::too_many_arguments)]
    fn solve_trace(
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

    /// [`solve_trace_cfg`] with the shipped settings.
    #[allow(clippy::too_many_arguments)]
    fn solve_trace_stats(
        trace: &[f32],
        tau_r: f64,
        tau_d: f64,
        fs: f64,
        upsample_factor: usize,
        max_iters: u32,
        tol: f64,
        hp_enabled: bool,
        lp_enabled: bool,
        lambda: f64,
        opts: SolveOptions,
    ) -> (InDecaResult, SolveStats) {
        solve_trace_cfg(
            trace,
            tau_r,
            tau_d,
            fs,
            upsample_factor,
            max_iters,
            tol,
            hp_enabled,
            lp_enabled,
            lambda,
            opts,
            SolveConfig::default(),
        )
    }

    /// Characterization: score a reconstruction `recon` (trace units, before any
    /// preprocessing, at the upsampled rate; e.g. `K n` of the true train, or the
    /// clean calcium) against `trace` exactly as candidates are scored under
    /// `scoring`. Returns `(residual energy, noise budget, amplitude)`.
    #[allow(clippy::too_many_arguments)]
    fn score_reconstruction_on_trace(
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

    #[test]
    fn chain_noise_gain_is_near_unity_on_white_noise_and_modest_on_a_trace() {
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let fs_up = fs * k as f64;
        // Pure noise: the rolling quantile subtracts a constant (absorbed by
        // the fit's offset) plus a negligible sampling fluctuation; the probe
        // adds its own quantile sampling fluctuation on top of F(e').
        let noise = lcg_noise(6000, 1.0, 0x5EED);
        let p = prepare(&noise, tr, td, fs_up, k, true, true);
        let g0 = p.noise.chain_gain;
        assert!(g0.is_finite() && (0.95..1.1).contains(&g0), "{g0}");
        // A spiking trace: the quantile's shift under noise varies with the
        // window's signal; a few percent of the linear budget.
        let trace = noisy_spiking_trace(6000, 0x1234);
        let p = prepare(&trace, tr, td, fs_up, k, true, true);
        let g = p.noise.chain_gain;
        assert!(g.is_finite() && (0.98..1.5).contains(&g), "{g}");
        assert!((p.noise.grid_chain.sigma / p.noise.grid.sigma - g.sqrt()).abs() < 1e-6);
        assert_eq!(p.noise.grid_chain.corr_sum, p.noise.grid.corr_sum);
        // The processed-space noise variance is the linear grid variance
        // times the gain.
        assert!((p.noise.processed_var() / (p.noise.grid.sigma.powi(2)) - g).abs() < 1e-9);
        // Deterministic (fixed probe seed).
        let p2 = prepare(&trace, tr, td, fs_up, k, true, true);
        assert_eq!(p2.noise.chain_gain, g);
        // The default selection budget carries the gain, and the result
        // exposes it.
        let n_up = p.working.len();
        let (lo, hi) = native_grid(n_up, p.pad, k);
        let opts = SolveOptions {
            noise_constrained: true,
        };
        let (r, st) = solve_trace_stats(&trace, tr, td, fs, k, 100_000, 0.0, true, true, 0.0, opts);
        let linear = p.noise.grid.budget(hi - lo);
        assert!(
            (st.budget / linear - g).abs() < 1e-6,
            "{} {}",
            st.budget / linear,
            g
        );
        assert_eq!(st.chain_gain, g);
        assert_eq!(r.chain_noise_gain, g);
        assert!((r.noise_var_processed - p.noise.processed_var()).abs() < 1e-12);
    }

    #[test]
    fn chain_noise_gain_is_one_without_noise_or_data() {
        assert_eq!(chain_noise_gain(&[], &[], None, 4, 10, 0, 1.0), 1.0);
        let flat = vec![1.0_f32; 200];
        let p = prepare(&flat, 0.1, 0.6, 300.0, 10, true, true);
        assert_eq!(p.noise.chain_gain, 1.0);
        assert_eq!(p.noise.processed_var(), 0.0);
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

    // ── Solve structure on the presets ──────────────────────────────────

    /// Short simulated cells from every preset (true taus), at the CaDecon
    /// upsampling target of 300 Hz: (preset, trace, tau_r, tau_d, fs, k).
    fn preset_cells(
        n_cells: usize,
        n_tp: usize,
    ) -> Vec<(&'static str, Vec<f32>, f64, f64, f64, usize)> {
        let mut out = Vec::new();
        for (name, mut cfg) in crate::simulate::presets::legacy_peak_all() {
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

    fn run_cfg(
        trace: &[f32],
        (tr, td, fs, k): (f64, f64, f64, usize),
        max_iters: u32,
        cfg: SolveConfig,
    ) -> (InDecaResult, SolveStats) {
        solve_trace_cfg(
            trace,
            tr,
            td,
            fs,
            k,
            max_iters,
            1e-4,
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
    fn solve_ignores_warm_counts() {
        // The solve does not take the caller's warm start, so the output is a
        // deterministic function of the data.
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
    fn peak_to_trough_prescale_leaves_the_box_inactive_on_presets() {
        // One s-step at the peak-to-trough prescale is already a fixed point:
        // the box upper bound does not bind on any preset cell.
        for (name, trace, tr, td, fs, k) in preset_cells(2, 900) {
            let (r, st) = solve_trace_stats(
                &trace,
                tr,
                td,
                fs,
                k,
                300,
                1e-4,
                true,
                true,
                0.0,
                SolveOptions {
                    noise_constrained: true,
                },
            );
            assert!(!st.upper_bound_active, "{name}: {st:?}");
            assert!(r.alpha > 0.0 && r.s_counts.iter().sum::<f32>() > 0.0);
        }
    }

    #[test]
    fn result_noise_path_reports_the_reported_rounds_pick() {
        // The per-trace `noise_path` flag on InDecaResult must equal the
        // reported round's flag, and must be false when the noise-constrained
        // option is off (selection is then plain max-PVE).
        for (name, trace, tr, td, fs, k) in preset_cells(2, 900) {
            let run = |noise_constrained| {
                solve_trace_stats(
                    &trace,
                    tr,
                    td,
                    fs,
                    k,
                    300,
                    1e-4,
                    true,
                    true,
                    0.0,
                    SolveOptions { noise_constrained },
                )
            };
            let (on, st_on) = run(true);
            assert_eq!(on.noise_path, st_on.noise_path, "{name}");
            let (off, _) = run(false);
            assert!(!off.noise_path, "{name}: flag set with the option off");
        }
    }

    // ── Chain-consistent scoring ────────────────────────────────────────

    /// Drift-free preset cells: (name, trace, clean calcium, tau_r, tau_d, fs).
    fn drift_free_cells(n_tp: usize) -> Vec<(&'static str, Vec<f32>, Vec<f32>, f64, f64, f64)> {
        let mut out = Vec::new();
        for (name, mut cfg) in crate::simulate::presets::legacy_peak_all() {
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
        assert_eq!(SolveConfig::default().scoring, Scoring::Chain);
        let plain = SolveConfig {
            scoring: Scoring::Plain,
            ..SolveConfig::default()
        };
        let mut differs = false;
        for (_, trace, _, tr, td, fs) in drift_free_cells(1500) {
            let k = ((300.0 / fs).round() as usize).max(1);
            let (a, st) = run_cfg(&trace, (tr, td, fs, k), 500, SolveConfig::default());
            let (b, _) = run_cfg(&trace, (tr, td, fs, k), 500, plain);
            assert!(a.s_counts.iter().sum::<f32>() > 0.0);
            assert!(b.s_counts.iter().sum::<f32>() > 0.0);
            // The chain is amplitude-invariant, so the fitted amplitude stays
            // a least-squares fit of the chain-transformed reconstruction.
            assert!(a.alpha > 0.0 && st.binary_error.is_finite());
            differs |= a.s_counts != b.s_counts;
        }
        assert!(differs, "chain scoring never changed a pick");
    }

    #[test]
    fn chain_scoring_without_a_filter_is_the_quantile_alone() {
        // With the bandpass off the chain is the rolling quantile only; the
        // scorer must not require a filter.
        let trace = noisy_spiking_trace(900, 0xC0DE);
        let (r, _) = solve_trace_cfg(
            &trace,
            0.1,
            0.6,
            30.0,
            10,
            300,
            1e-4,
            false,
            false,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
            SolveConfig::default(),
        );
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
        for (name, mut cfg) in crate::simulate::presets::legacy_peak_all() {
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
        cfg: SolveConfig,
    ) -> (InDecaResult, SolveStats) {
        let (r, st) = solve_trace_cfg(
            trace,
            tr,
            td,
            fs,
            k,
            max_iters,
            tol,
            true,
            true,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
            cfg,
        );
        (r, st)
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
                let (a, sa) = run_native(&trace, p, u32::MAX, 1e-4, SolveConfig::default());
                assert!(sa.converged, "{name} @ {fs} Hz hit the cap: {sa:?}");
                assert!(
                    sa.iterations > 0 && sa.iterations < 100_000,
                    "{name} @ {fs} Hz: {sa:?}"
                );
                assert!(a.s_counts.iter().sum::<f32>() > 0.0, "{name} @ {fs} Hz");
                let (b, sb) = run_native(&trace, p, sa.iterations, 0.0, SolveConfig::default());
                assert_eq!(a.s_counts, b.s_counts, "{name} @ {fs} Hz: cap");
                assert_eq!(
                    a.alpha.to_bits(),
                    b.alpha.to_bits(),
                    "{name} @ {fs} Hz: cap"
                );
                assert_eq!(sa.iterations, sb.iterations);
                assert!(sb.converged);
                // The UI's cap of 500 does not truncate the solve either.
                let (c, sc) = run_native(&trace, p, 500, 1e-4, SolveConfig::default());
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
            let (a, sa) = run_native(trace, p, u32::MAX, 0.0, SolveConfig::default());
            let step = SolveConfig {
                native_stop: NativeStop::Step,
                ..SolveConfig::default()
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
            let (base, st) = run_native(&trace, p, u32::MAX, 0.0, SolveConfig::default());
            assert!(!st.upper_bound_active, "{name}");
            for m in [0.25, 4.0] {
                let cfg = SolveConfig {
                    alpha_init: AlphaInit::Fixed(st.alpha_est * m),
                    ..SolveConfig::default()
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
        let cfg = SolveConfig {
            native_stop: NativeStop::Step,
            ..SolveConfig::default()
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

    // ── Degenerate traces ───────────────────────────────────────────────

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
        assert!(
            st.alpha_est.is_finite() && st.objective.is_finite(),
            "{label}"
        );
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

    // ── Degenerate selection cases with a noise model ───────────────────

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
