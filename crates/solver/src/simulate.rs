//! Synthetic calcium trace simulation with full ground truth.
//!
//! Generates realistic fluorescence traces for testing deconvolution algorithms.
//! Shared engine: exposed to both WASM (web) and Python (PyO3) via bindings.
//!
//! ## Pipeline per cell
//!
//!   1. **Spike generation** at high-res rate (default 300 Hz).
//!      - *Markov HMM* (default): two-state silent/active model producing bursty
//!        firing patterns. Original CaLab web simulator model.
//!      - *Poisson*: homogeneous process at a fixed rate. Standard model in
//!        OASIS (Friedrich et al., 2017) and CaImAn (Giovannucci et al., 2019).
//!   2. **Convolution** with double-exponential calcium kernel at high-res rate.
//!      h(t) = exp(-t/τ_d) − exp(-t/τ_r), peak-normalized to 1.0.
//!      Convolution happens before downsampling so sub-frame spike timing is
//!      preserved — important for fast indicators (e.g. jGCaMP8f).
//!   3. **Downsample** calcium signal to imaging rate via bin-averaging, which
//!      simulates camera exposure integration.
//!   4. **Scale by alpha** (per-cell amplitude). CaDecon's solver estimates
//!      alpha via least-squares; varying it across cells tests that estimation.
//!   5. **Indicator saturation** (optional). Hill equation F^n / (F^n + Kd^n).
//!      From MLspike (Deneux et al., 2016).
//!   6. **Baseline drift**. Mean-reverting Gaussian random walk (default).
//!      From MLspike (Deneux et al., 2016).
//!   7. **Photobleaching** (optional). Multiplicative exponential decay.
//!      From NAOMi (Charles et al., 2019).
//!   8. **Noise**. Additive Gaussian + optional Poisson (shot) noise.
//!      From CASCADE (Rupprecht et al., 2021).
//!
//! ## Per-cell variation
//!
//! Each config struct co-locates its nominal value with an optional `_cv` field
//! controlling per-cell variation. CV=0 means all cells share the same value.
//! CV>0 draws per-cell values from a log-normal distribution centered on the
//! nominal: `cell_value = nominal * exp(N(0, cv))`.

use crate::kernel::build_kernel;
use crate::upsample::downsample_average;

// ── PRNG ─────────────────────────────────────────────────────────

/// xorshift32 PRNG — deterministic across WASM and native targets.
/// Ported from CaLab web simulator (`packages/compute/src/mock-traces.ts`).
#[derive(Clone)]
struct Xorshift32 {
    state: u32,
    cached_gaussian: Option<f64>,
}

impl Xorshift32 {
    fn new(seed: u32) -> Self {
        let state = if seed == 0 { 1 } else { seed };
        Self {
            state,
            cached_gaussian: None,
        }
    }

    #[inline]
    fn next_u32(&mut self) -> u32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        self.state
    }

    #[inline]
    fn next_f64(&mut self) -> f64 {
        (self.next_u32() as f64) / 4_294_967_296.0
    }

    fn gaussian(&mut self) -> f64 {
        if let Some(cached) = self.cached_gaussian.take() {
            return cached;
        }
        let u1 = {
            let v = self.next_f64();
            if v == 0.0 {
                1e-10
            } else {
                v
            }
        };
        let u2 = self.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = 2.0 * std::f64::consts::PI * u2;
        self.cached_gaussian = Some(r * theta.sin());
        r * theta.cos()
    }
}

/// Draw a per-cell value with log-normal variation: nominal * exp(N(0, cv)).
/// Returns nominal unchanged when cv <= 0.
#[inline]
/// Clamp a per-cell (tau_rise, tau_decay) draw so its kernel at `kernel_fs`
/// stays within `validate::MAX_KERNEL_LEN` and `0 < tau_rise < tau_decay`.
/// Only extreme log-normal draws are affected; the nominal taus have already
/// passed `validate_simulation_config`.
fn bound_cell_taus(tau_rise: f64, tau_decay: f64, kernel_fs: f64) -> (f64, f64) {
    // ceil(-ln(1e-6) · tau_decay · fs) <= MAX_KERNEL_LEN, with a little slack.
    let max_tau_decay =
        (crate::validate::MAX_KERNEL_LEN as f64 - 1.0) / (-(1e-6_f64.ln()) * kernel_fs);
    let tau_decay = tau_decay.min(max_tau_decay);
    let tau_rise = if tau_rise < tau_decay {
        tau_rise
    } else {
        0.5 * tau_decay
    };
    (tau_rise.max(f64::MIN_POSITIVE), tau_decay)
}

fn vary_lognormal(nominal: f64, cv: f64, rng: &mut Xorshift32) -> f64 {
    if cv > 0.0 {
        nominal * (cv * rng.gaussian()).exp()
    } else {
        nominal
    }
}

// ── Configuration structs ────────────────────────────────────────
//
// Each struct co-locates nominal values with optional per-cell variation
// fields (*_cv). All CV fields default to 0 (no variation).

/// Two-state HMM spike generator (silent/active) with bursty firing.
/// Attribution: CaLab web simulator Markov spike model.
///
/// All cells of one simulation share these parameters, so they share one
/// burst-size distribution (set by `p_active_to_silent` and
/// `p_spike_when_active`). The only per-cell variation is
/// `p_silent_to_active_cv`, which changes how often a cell bursts, not how big
/// its bursts are. That is the assumption under which the measured SNR
/// ([`NoiseReference::MeasuredSnr`]) compares cells. Note the transition
/// probabilities are per imaging frame, so the mean burst lasts
/// 1/`p_active_to_silent` frames: bursts are half as long at 60 Hz as at 30 Hz.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct MarkovConfig {
    /// Silent→active transition probability per imaging frame. Default: 0.005.
    pub p_silent_to_active: f64,
    /// Active→silent transition probability per imaging frame. Default: 0.3.
    pub p_active_to_silent: f64,
    /// Spike probability per high-resolution timestep in active state. Default: 0.5.
    pub p_spike_when_active: f64,
    /// Spike probability per high-resolution timestep in silent state. Default: 0.002.
    pub p_spike_when_silent: f64,
    /// Per-cell log-normal CV on p_silent_to_active (0 = no variation). Default: 0.0.
    pub p_silent_to_active_cv: f64,
}

impl Default for MarkovConfig {
    fn default() -> Self {
        Self {
            p_silent_to_active: 0.005,
            p_active_to_silent: 0.3,
            p_spike_when_active: 0.5,
            p_spike_when_silent: 0.002,
            p_silent_to_active_cv: 0.0,
        }
    }
}

/// Homogeneous Poisson spike generator.
/// Attribution: OASIS (Friedrich et al., 2017), CaImAn (Giovannucci et al., 2019).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct PoissonConfig {
    /// Mean firing rate (Hz). Default: 1.0.
    pub rate_hz: f64,
}

impl Default for PoissonConfig {
    fn default() -> Self {
        Self { rate_hz: 1.0 }
    }
}

/// Spike train generation model.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "model_type"))]
pub enum SpikeModel {
    #[cfg_attr(feature = "serde", serde(rename = "markov"))]
    Markov(MarkovConfig),
    #[cfg_attr(feature = "serde", serde(rename = "poisson"))]
    Poisson(PoissonConfig),
}

impl Default for SpikeModel {
    fn default() -> Self {
        Self::Markov(MarkovConfig::default())
    }
}

/// Double-exponential kernel: h(t) = exp(-t/tau_decay) - exp(-t/tau_rise).
/// Attribution: standard calcium response model (CaImAn, OASIS, Suite2p, CaLab).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct KernelConfig {
    /// Rise time constant (seconds). Default: 0.1.
    pub tau_rise_s: f64,
    /// Decay time constant (seconds). Default: 0.6.
    pub tau_decay_s: f64,
    /// Per-cell log-normal CV on tau_rise (0 = no variation). Default: 0.0.
    pub tau_rise_cv: f64,
    /// Per-cell log-normal CV on tau_decay (0 = no variation). Default: 0.0.
    pub tau_decay_cv: f64,
}

impl Default for KernelConfig {
    fn default() -> Self {
        Self {
            tau_rise_s: 0.1,
            tau_decay_s: 0.6,
            tau_rise_cv: 0.0,
            tau_decay_cv: 0.0,
        }
    }
}

/// What the `NoiseConfig::snr` knob is measured against.
///
/// The default, [`NoiseReference::MeasuredSnr`], makes the simulator speak the
/// same SNR as the real-data metric: every simulated trace measures at the
/// requested SNR with [`crate::snr::measured_snr`], the tool a user runs on
/// their own recording. That metric is burst-based (signal = mean of the top
/// 1 % of samples minus the median, noise = MAD of first differences), so it
/// compares cells that share a firing statistic: cells of one simulated
/// dataset share the burst-size distribution (one spike model per dataset),
/// and at a fixed per-spike noise a burstier spike model measures higher.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum NoiseReference {
    /// σ is chosen per cell so that the measured SNR of the final noisy trace
    /// (`snr::measured_snr`: robust peak signal / MAD-diff σ) equals `snr`.
    /// Solved by bisection on the drawn noise realisation, so the match is
    /// exact up to the reachable range: pure noise measures ≈ 2.67, so lower
    /// targets clamp to that floor, and a trace whose own frame-to-frame
    /// changes dominate the MAD-diff estimate has a finite ceiling; outside the
    /// range σ falls back to `robust_signal(clean) / snr`.
    #[default]
    MeasuredSnr,
    /// Legacy: σ = max(clean signal) / snr. Kept to reproduce results made
    /// before the measured-SNR convention. The max of a bursting cell is a
    /// burst of many spikes, so the same knob gives 20–30x more noise per
    /// spike under Markov firing than under sparse Poisson firing.
    Peak,
    /// σ = A₁ / snr, where A₁ is the cell's single-spike response (kernel peak
    /// after frame integration, averaged over the spike's sub-frame phase,
    /// times alpha, through saturation if enabled). Regime-independent per
    /// spike, but not measurable on real data, where single spikes usually
    /// sit inside the noise.
    SingleSpike,
}

/// Noise model: Gaussian + optional shot noise.
/// Attribution: Gaussian from CaLab web simulator; shot noise from CASCADE (Rupprecht et al., 2021).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct NoiseConfig {
    /// Target SNR, measured against `reference`. Default: 8.0.
    ///
    /// With the default [`NoiseReference::MeasuredSnr`] this is the robust peak
    /// SNR the noisy trace measures at (`snr::measured_snr`).
    pub snr: f64,
    /// What `snr` is measured against. Default: [`NoiseReference::MeasuredSnr`].
    pub reference: NoiseReference,
    /// Enable shot noise (signal-dependent variance). Default: false.
    ///
    /// Under `Peak` and `SingleSpike` it is Poisson (Knuth); under
    /// `MeasuredSnr` it is its Gaussian approximation (variance ∝ |signal|), so
    /// the total noise scales with σ and the target can be solved exactly.
    pub shot_noise_enabled: bool,
    /// Fraction of total noise variance from shot noise (0..1). Default: 0.3.
    pub shot_noise_fraction: f64,
    /// Per-cell additive SNR spread: cell_snr = snr + U(-spread, +spread). Default: 0.0.
    pub snr_spread: f64,
}

impl Default for NoiseConfig {
    fn default() -> Self {
        Self {
            snr: 8.0,
            reference: NoiseReference::default(),
            shot_noise_enabled: false,
            shot_noise_fraction: 0.3,
            snr_spread: 0.0,
        }
    }
}

/// Deterministic sinusoidal baseline drift. Useful as a simple test signal
/// but not physically motivated — real baseline fluctuations are irregular.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct SinusoidalDrift {
    /// Drift amplitude as a fraction of the robust signal (mean of the top 1 % of
    /// clean-trace samples minus the median; max(clean) under
    /// `NoiseReference::Peak`). Default: 0.1.
    pub amplitude_fraction: f64,
    /// Minimum drift cycles over the trace duration. Default: 2.0.
    pub cycles_min: f64,
    /// Maximum drift cycles over the trace duration. Default: 4.0.
    pub cycles_max: f64,
    /// Per-cell log-normal CV on amplitude (0 = no variation). Default: 0.0.
    pub amplitude_cv: f64,
}

impl Default for SinusoidalDrift {
    fn default() -> Self {
        Self {
            amplitude_fraction: 0.1,
            cycles_min: 2.0,
            cycles_max: 4.0,
            amplitude_cv: 0.0,
        }
    }
}

/// Mean-reverting Gaussian random walk baseline drift.
/// From MLspike (Deneux et al., 2016, Nature Communications).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct RandomWalkDrift {
    /// Step std per frame as a fraction of the robust signal (mean of the top
    /// 1 % of clean-trace samples minus the median; max(clean) under
    /// `NoiseReference::Peak`). Default: 0.002.
    pub step_std_fraction: f64,
    /// Mean-reversion rate (0=pure walk, 1=reset). Default: 0.001.
    pub mean_reversion: f64,
    /// Per-cell log-normal CV on step_std (0 = no variation). Default: 0.0.
    pub step_std_cv: f64,
}

impl Default for RandomWalkDrift {
    fn default() -> Self {
        Self {
            step_std_fraction: 0.002,
            mean_reversion: 0.001,
            step_std_cv: 0.0,
        }
    }
}

/// Baseline drift model.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "model_type"))]
pub enum DriftModel {
    #[cfg_attr(feature = "serde", serde(rename = "sinusoidal"))]
    Sinusoidal(SinusoidalDrift),
    #[cfg_attr(feature = "serde", serde(rename = "random_walk"))]
    RandomWalk(RandomWalkDrift),
}

impl Default for DriftModel {
    fn default() -> Self {
        Self::RandomWalk(RandomWalkDrift::default())
    }
}

/// Exponential photobleaching: F(t) *= 1 - amp * (1 - exp(-t/tau)).
/// Attribution: NAOMi (Charles et al., 2019).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct PhotobleachingConfig {
    /// Whether to apply photobleaching. Default: false.
    pub enabled: bool,
    /// Bleaching time constant (seconds). Default: 600.0.
    pub decay_time_constant_s: f64,
    /// Max fractional signal loss (0..1). Default: 0.15.
    pub amplitude_fraction: f64,
    /// Per-cell log-normal CV on amplitude (0 = no variation). Default: 0.0.
    pub amplitude_cv: f64,
}

impl Default for PhotobleachingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            decay_time_constant_s: 600.0,
            amplitude_fraction: 0.15,
            amplitude_cv: 0.0,
        }
    }
}

/// Hill equation indicator saturation: F_sat = F^n / (F^n + Kd^n).
/// Attribution: MLspike (Deneux et al., 2016).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct SaturationConfig {
    /// Whether to apply indicator saturation. Default: false.
    pub enabled: bool,
    /// Hill coefficient n. Default: 1.0.
    pub hill_coefficient: f64,
    /// Half-saturation level (signal units). Default: 5.0.
    pub k_d: f64,
    /// Per-cell log-normal CV on k_d (0 = no variation). Default: 0.0.
    pub k_d_cv: f64,
}

impl Default for SaturationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            hill_coefficient: 1.0,
            k_d: 5.0,
            k_d_cv: 0.0,
        }
    }
}

/// Complete configuration for synthetic calcium trace generation.
///
/// Per-cell variation fields (_cv) live on each config struct alongside
/// the nominal value they modify. Alpha (amplitude scaling) is here
/// because it doesn't belong to any pipeline step.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct SimulationConfig {
    /// Sampling rate (Hz). Default: 30.0.
    pub fs_hz: f64,
    /// Number of timepoints. Default: 27000 (15 min at 30 Hz).
    pub num_timepoints: usize,
    /// Number of cells. Default: 100.
    pub num_cells: usize,
    /// Kernel parameters + per-cell tau variation.
    pub kernel: KernelConfig,
    /// Spike generation model + per-cell rate variation.
    pub spike_model: SpikeModel,
    /// Noise model + per-cell SNR spread.
    pub noise: NoiseConfig,
    /// Baseline drift + per-cell intensity variation.
    pub drift: DriftModel,
    /// Photobleaching + per-cell amplitude variation.
    pub photobleaching: PhotobleachingConfig,
    /// Indicator saturation + per-cell Kd variation.
    pub saturation: SaturationConfig,
    /// Mean per-cell amplitude scaling factor. Default: 1.0.
    pub alpha_mean: f64,
    /// Per-cell log-normal CV on alpha (0 = no variation). Default: 0.3.
    pub alpha_cv: f64,
    /// RNG seed for reproducibility. Default: 42.
    pub seed: u32,
    /// Internal spike simulation rate (Hz). Default: 300.0.
    pub spike_sim_hz: f64,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            fs_hz: 30.0,
            num_timepoints: 27000,
            num_cells: 100,
            kernel: KernelConfig::default(),
            spike_model: SpikeModel::default(),
            noise: NoiseConfig::default(),
            drift: DriftModel::default(),
            photobleaching: PhotobleachingConfig::default(),
            saturation: SaturationConfig::default(),
            alpha_mean: 1.0,
            alpha_cv: 0.3,
            seed: 42,
            spike_sim_hz: 300.0,
        }
    }
}

// ── Result structs ───────────────────────────────────────────────

/// Ground truth for a single simulated cell.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct CellGroundTruth {
    pub spikes: Vec<f32>,
    pub clean_calcium: Vec<f32>,
    pub alpha: f64,
    /// The cell's target SNR (after `snr_spread`), in the units of
    /// `NoiseConfig::reference`.
    pub snr: f64,
    pub tau_rise_s: f64,
    pub tau_decay_s: f64,
    /// Standard deviation of the noise actually added (total, Gaussian + shot).
    pub noise_sigma: f64,
    /// Ground-truth diagnostic: single-spike response amplitude A₁ (see
    /// [`NoiseReference::SingleSpike`]) over `noise_sigma`. Only knowable in
    /// simulation; there is no real-data counterpart.
    pub snr_1ap: f64,
}

/// Complete simulation result with observed traces and per-cell ground truth.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SimulationResult {
    pub traces: Vec<f32>,
    pub num_cells: usize,
    pub num_timepoints: usize,
    pub ground_truth: Vec<CellGroundTruth>,
}

// ── Core simulation ──────────────────────────────────────────────

/// Generate synthetic calcium imaging traces with full ground truth.
pub fn simulate(config: &SimulationConfig) -> SimulationResult {
    let n_cells = config.num_cells;
    let n_tp = config.num_timepoints;
    let has_kernel_variation = config.kernel.tau_rise_cv > 0.0 || config.kernel.tau_decay_cv > 0.0;

    let mut traces = Vec::with_capacity(n_cells * n_tp);
    let mut ground_truth = Vec::with_capacity(n_cells);

    // Clamp to >= 1: `spike_sim_hz` and `fs_hz` come from a user-supplied
    // config, and a spike rate below half the frame rate would otherwise round
    // to 0, producing a zero-length high-resolution buffer and a degenerate
    // (empty) simulation rather than a usable result.
    let bins_per_frame = ((config.spike_sim_hz / config.fs_hz).round() as usize).max(1);
    let num_high_res = n_tp * bins_per_frame;

    let shared_kernel = if !has_kernel_variation {
        Some(build_kernel(
            config.kernel.tau_rise_s,
            config.kernel.tau_decay_s,
            config.spike_sim_hz,
        ))
    } else {
        None
    };

    let mut high_res_buf = vec![0u8; num_high_res];
    let mut trace_buf: Vec<f64> = Vec::with_capacity(n_tp);

    for cell_idx in 0..n_cells {
        let cell_seed = config
            .seed
            .wrapping_add((cell_idx as u32).wrapping_mul(7919));
        let mut rng = Xorshift32::new(cell_seed);

        // 1. Per-cell alpha
        let alpha = if config.alpha_cv > 0.0 {
            let sigma2 = (1.0 + config.alpha_cv * config.alpha_cv).ln();
            let mu = config.alpha_mean.ln() - sigma2 / 2.0;
            (mu + sigma2.sqrt() * rng.gaussian()).exp()
        } else {
            config.alpha_mean
        };

        // 2. Per-cell kernel
        let cell_tau_rise = vary_lognormal(
            config.kernel.tau_rise_s,
            config.kernel.tau_rise_cv,
            &mut rng,
        );
        let cell_tau_decay = vary_lognormal(
            config.kernel.tau_decay_s,
            config.kernel.tau_decay_cv,
            &mut rng,
        );
        // A heavy log-normal tail can push a per-cell draw outside what the
        // nominal values were validated against: keep the per-cell kernel
        // within the length cap and keep rise < decay. No-op for typical CVs.
        let (cell_tau_rise, cell_tau_decay) =
            bound_cell_taus(cell_tau_rise, cell_tau_decay, config.spike_sim_hz);

        // 3. Per-cell SNR
        let cell_snr = if config.noise.snr_spread > 0.0 {
            let u = rng.next_f64() * 2.0 - 1.0;
            (config.noise.snr + u * config.noise.snr_spread).max(1.0)
        } else {
            config.noise.snr
        };

        // 4. Per-cell spike rate
        let cell_spike_model = match &config.spike_model {
            SpikeModel::Markov(cfg) if cfg.p_silent_to_active_cv > 0.0 => {
                let mult = vary_lognormal(1.0, cfg.p_silent_to_active_cv, &mut rng);
                SpikeModel::Markov(MarkovConfig {
                    p_silent_to_active: (cfg.p_silent_to_active * mult).min(1.0),
                    ..*cfg
                })
            }
            other => other.clone(),
        };

        // 5. Generate high-res spikes
        generate_high_res_spikes(
            &cell_spike_model,
            num_high_res,
            bins_per_frame,
            config.spike_sim_hz,
            &mut rng,
            &mut high_res_buf,
        );
        let spikes = bin_to_imaging_rate(&high_res_buf[..num_high_res], n_tp, bins_per_frame);

        // 6. Convolve at high-res, downsample
        let per_cell_kernel;
        let kernel_ref = if has_kernel_variation {
            per_cell_kernel = build_kernel(cell_tau_rise, cell_tau_decay, config.spike_sim_hz);
            &per_cell_kernel
        } else {
            shared_kernel.as_deref().unwrap()
        };
        let high_res_calcium = convolve_binary_spikes(&high_res_buf[..num_high_res], kernel_ref);
        let mut clean_calcium = downsample_average(&high_res_calcium, bins_per_frame);

        // 7. Scale by alpha
        for v in clean_calcium.iter_mut() {
            *v *= alpha as f32;
        }

        // 8. Per-cell saturation Kd
        let mut cell_kd = config.saturation.k_d;
        if config.saturation.enabled {
            cell_kd = vary_lognormal(config.saturation.k_d, config.saturation.k_d_cv, &mut rng);
            apply_saturation(
                &mut clean_calcium,
                config.saturation.hill_coefficient,
                cell_kd,
            );
        }

        let signal_max = clean_calcium.iter().cloned().fold(0.0_f32, f32::max) as f64;
        let single_spike_amp = {
            let a1 = alpha * kernel_frame_peak(kernel_ref, bins_per_frame);
            if config.saturation.enabled {
                let mut v = [a1 as f32];
                apply_saturation(&mut v, config.saturation.hill_coefficient, cell_kd);
                v[0] as f64
            } else {
                a1
            }
        };

        // Reuse trace buffer across cells
        trace_buf.clear();
        trace_buf.extend(clean_calcium.iter().map(|&c| c as f64));

        // 9. Per-cell drift intensity
        let cell_drift = match &config.drift {
            DriftModel::RandomWalk(cfg) => {
                let cell_step = vary_lognormal(cfg.step_std_fraction, cfg.step_std_cv, &mut rng);
                DriftModel::RandomWalk(RandomWalkDrift {
                    step_std_fraction: cell_step,
                    ..*cfg
                })
            }
            DriftModel::Sinusoidal(cfg) => {
                let cell_amp = vary_lognormal(cfg.amplitude_fraction, cfg.amplitude_cv, &mut rng);
                DriftModel::Sinusoidal(SinusoidalDrift {
                    amplitude_fraction: cell_amp,
                    ..*cfg
                })
            }
        };
        // Drift is scaled by the same robust signal the measured SNR uses
        // (top-slice of the clean trace) so that drift/σ = fraction × SNR in
        // every firing regime. The legacy `Peak` convention keeps max(clean).
        let drift_scale = match config.noise.reference {
            NoiseReference::Peak => signal_max,
            _ => crate::snr::robust_signal_f64(
                &trace_buf,
                crate::snr::DEFAULT_TOP_FRACTION,
                config.fs_hz,
            ),
        };
        add_drift(&mut trace_buf, &cell_drift, drift_scale, n_tp, &mut rng);

        // 10. Per-cell photobleaching amplitude
        if config.photobleaching.enabled {
            let cell_amp = vary_lognormal(
                config.photobleaching.amplitude_fraction,
                config.photobleaching.amplitude_cv,
                &mut rng,
            )
            .min(1.0);
            let cell_pb = PhotobleachingConfig {
                amplitude_fraction: cell_amp,
                ..config.photobleaching
            };
            apply_photobleaching(&mut trace_buf, &cell_pb, config.fs_hz);
        }

        // 11. Add noise
        let noise_sigma = add_noise(
            &mut trace_buf,
            &config.noise,
            cell_snr,
            signal_max,
            single_spike_amp,
            config.fs_hz,
            &mut rng,
        );

        traces.extend(trace_buf.iter().map(|&v| v as f32));
        ground_truth.push(CellGroundTruth {
            spikes,
            clean_calcium,
            alpha,
            snr: cell_snr,
            tau_rise_s: cell_tau_rise,
            tau_decay_s: cell_tau_decay,
            noise_sigma,
            snr_1ap: if noise_sigma > 0.0 {
                single_spike_amp / noise_sigma
            } else {
                f64::INFINITY
            },
        });
    }

    SimulationResult {
        traces,
        num_cells: n_cells,
        num_timepoints: n_tp,
        ground_truth,
    }
}

// ── Spike generation ─────────────────────────────────────────────

fn generate_high_res_spikes(
    model: &SpikeModel,
    num_high_res: usize,
    bins_per_frame: usize,
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
    high_res_buf: &mut [u8],
) {
    high_res_buf[..num_high_res].fill(0);
    let buf = &mut high_res_buf[..num_high_res];
    match model {
        SpikeModel::Markov(cfg) => fill_markov_spikes(cfg, buf, bins_per_frame, rng),
        SpikeModel::Poisson(cfg) => fill_poisson_spikes(cfg, buf, spike_sim_hz, rng),
    }
}

fn fill_markov_spikes(
    cfg: &MarkovConfig,
    buf: &mut [u8],
    bins_per_frame: usize,
    rng: &mut Xorshift32,
) {
    let p_s2a = 1.0 - (1.0 - cfg.p_silent_to_active).powf(1.0 / bins_per_frame as f64);
    let p_a2s = 1.0 - (1.0 - cfg.p_active_to_silent).powf(1.0 / bins_per_frame as f64);
    let mut state = 0u8;
    for spike in buf.iter_mut() {
        if state == 0 {
            if rng.next_f64() < p_s2a {
                state = 1;
            }
        } else if rng.next_f64() < p_a2s {
            state = 0;
        }
        let p_spike = if state == 1 {
            cfg.p_spike_when_active
        } else {
            cfg.p_spike_when_silent
        };
        if rng.next_f64() < p_spike {
            *spike = 1;
        }
    }
}

fn fill_poisson_spikes(
    cfg: &PoissonConfig,
    buf: &mut [u8],
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
) {
    let p_spike = cfg.rate_hz / spike_sim_hz;
    for spike in buf.iter_mut() {
        if rng.next_f64() < p_spike {
            *spike = 1;
        }
    }
}

fn bin_to_imaging_rate(high_res: &[u8], num_timepoints: usize, bins_per_frame: usize) -> Vec<f32> {
    let mut spikes = vec![0.0_f32; num_timepoints];
    for (f, spike_count) in spikes.iter_mut().enumerate() {
        let start = f * bins_per_frame;
        let end = (start + bins_per_frame).min(high_res.len());
        let count: u32 = high_res[start..end].iter().map(|&s| s as u32).sum();
        if count > 0 {
            *spike_count = count as f32;
        }
    }
    spikes
}

// ── Convolution ──────────────────────────────────────────────────

fn convolve_binary_spikes(spikes: &[u8], kernel: &[f32]) -> Vec<f32> {
    let n = spikes.len();
    let k_len = kernel.len();
    let mut out = vec![0.0_f32; n];
    for t in 0..n {
        if spikes[t] == 0 {
            continue;
        }
        let end = (t + k_len).min(n);
        for k in 0..(end - t) {
            out[t + k] += kernel[k];
        }
    }
    out
}

// ── Saturation ───────────────────────────────────────────────────

fn apply_saturation(signal: &mut [f32], hill_n: f64, k_d: f64) {
    let kd_n = k_d.powf(hill_n);
    // Fast-path for common integer Hill coefficients
    let hill_int = if (hill_n - hill_n.round()).abs() < 1e-9 {
        Some(hill_n.round() as i32)
    } else {
        None
    };
    for v in signal.iter_mut() {
        let f = (*v as f64).max(0.0);
        let f_n = match hill_int {
            Some(1) => f,
            Some(2) => f * f,
            Some(3) => f * f * f,
            _ => f.powf(hill_n),
        };
        *v = (f_n / (f_n + kd_n)) as f32;
    }
}

// ── Drift ────────────────────────────────────────────────────────

fn add_drift(
    trace: &mut [f64],
    model: &DriftModel,
    drift_scale: f64,
    n: usize,
    rng: &mut Xorshift32,
) {
    match model {
        DriftModel::Sinusoidal(cfg) => {
            if cfg.amplitude_fraction <= 0.0 || drift_scale <= 0.0 {
                return;
            }
            let cycles = cfg.cycles_min + rng.next_f64() * (cfg.cycles_max - cfg.cycles_min);
            let period = n as f64 / cycles;
            let amp = cfg.amplitude_fraction * drift_scale;
            let two_pi = 2.0 * std::f64::consts::PI;
            for i in 0..n {
                trace[i] += amp * (two_pi * i as f64 / period).sin();
            }
        }
        DriftModel::RandomWalk(cfg) => {
            if cfg.step_std_fraction <= 0.0 || drift_scale <= 0.0 {
                return;
            }
            let step_std = cfg.step_std_fraction * drift_scale;
            let mr = cfg.mean_reversion;
            let mut drift = 0.0_f64;
            for i in 0..n {
                drift = drift * (1.0 - mr) + step_std * rng.gaussian();
                trace[i] += drift;
            }
        }
    }
}

// ── Photobleaching ───────────────────────────────────────────────

fn apply_photobleaching(trace: &mut [f64], cfg: &PhotobleachingConfig, fs_hz: f64) {
    let amp = cfg.amplitude_fraction;
    let decay_per_step = (-1.0 / (fs_hz * cfg.decay_time_constant_s)).exp();
    let mut bleach_exp = 1.0_f64; // exp(-t/tau), starts at 1.0 and decays
    for v in trace.iter_mut() {
        *v *= 1.0 - amp * (1.0 - bleach_exp);
        bleach_exp *= decay_per_step;
    }
}

// ── Noise ────────────────────────────────────────────────────────

/// Peak of the frame-averaged response to one spike, for a kernel sampled at
/// the high-resolution rate, averaged over the spike's phase within the frame
/// (a spike late in a frame is split across two frames and peaks lower).
pub fn kernel_frame_peak(kernel: &[f32], bins_per_frame: usize) -> f64 {
    let bpf = bins_per_frame.max(1);
    let mut acc = 0.0_f64;
    for phase in 0..bpf {
        // Frame f averages high-res bins [f·bpf, (f+1)·bpf); the spike sits at
        // bin `phase`, so kernel index = bin − phase.
        let n_frames = (kernel.len() + phase).div_ceil(bpf);
        let mut best = 0.0_f64;
        for f in 0..n_frames {
            let lo = (f * bpf).max(phase) - phase;
            let hi = ((f + 1) * bpf - phase).min(kernel.len());
            if hi <= lo {
                continue;
            }
            let sum: f64 = kernel[lo..hi].iter().map(|&v| v as f64).sum();
            best = best.max(sum / bpf as f64);
        }
        acc += best;
    }
    acc / bpf as f64
}

/// Add noise to `trace` and return the total noise σ used.
fn add_noise(
    trace: &mut [f64],
    cfg: &NoiseConfig,
    cell_snr: f64,
    signal_max: f64,
    single_spike_amp: f64,
    fs_hz: f64,
    rng: &mut Xorshift32,
) -> f64 {
    if cell_snr <= 0.0 {
        return 0.0;
    }
    match cfg.reference {
        NoiseReference::Peak => {
            add_noise_legacy(trace, cfg, signal_max / cell_snr, signal_max, rng)
        }
        NoiseReference::SingleSpike => add_noise_legacy(
            trace,
            cfg,
            single_spike_amp / cell_snr,
            single_spike_amp,
            rng,
        ),
        NoiseReference::MeasuredSnr => {
            add_noise_measured(trace, cfg, cell_snr, single_spike_amp, fs_hz, rng)
        }
    }
}

/// Noise at a fixed σ. `scale` sets the shot-noise variance: a sample at
/// |v| = scale gets shot variance `shot_noise_fraction · σ²`.
fn add_noise_legacy(
    trace: &mut [f64],
    cfg: &NoiseConfig,
    noise_std: f64,
    scale: f64,
    rng: &mut Xorshift32,
) -> f64 {
    if noise_std.is_nan() || scale.is_nan() || noise_std <= 0.0 || scale <= 0.0 {
        return 0.0;
    }
    if cfg.shot_noise_enabled && cfg.shot_noise_fraction > 0.0 {
        let total_var = noise_std * noise_std;
        let gauss_std = (total_var * (1.0 - cfg.shot_noise_fraction)).sqrt();
        let shot_var = total_var * cfg.shot_noise_fraction;
        for v in trace.iter_mut() {
            let gauss = gauss_std * rng.gaussian();
            let lambda = (*v).abs() * shot_var / scale;
            let shot = poisson_sample_knuth(lambda, rng) - lambda;
            *v += gauss + shot;
        }
    } else {
        for v in trace.iter_mut() {
            *v += noise_std * rng.gaussian();
        }
    }
    noise_std
}

/// [`NoiseReference::MeasuredSnr`]: draw one noise realisation in units of σ,
/// then solve for the σ at which the noisy trace measures at `target`.
fn add_noise_measured(
    trace: &mut [f64],
    cfg: &NoiseConfig,
    target: f64,
    single_spike_amp: f64,
    fs_hz: f64,
    rng: &mut Xorshift32,
) -> f64 {
    use crate::snr::{measured_snr_f64, robust_signal_f64, DEFAULT_TOP_FRACTION};
    let n = trace.len();
    if n == 0 {
        return 0.0;
    }
    let shot = cfg.shot_noise_enabled && cfg.shot_noise_fraction > 0.0;
    let frac = if shot {
        cfg.shot_noise_fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let signal = robust_signal_f64(trace, DEFAULT_TOP_FRACTION, fs_hz);
    // Shot-noise scale: the trace's robust signal (falls back to A₁).
    let scale = if signal > 0.0 {
        signal
    } else {
        single_spike_amp
    };
    // Unit-σ noise shape: Gaussian part + Gaussian-approximated shot part.
    let g_std = (1.0 - frac).sqrt();
    let unit: Vec<f64> = trace
        .iter()
        .map(|&v| {
            let g = g_std * rng.gaussian();
            if shot && scale > 0.0 {
                g + (frac * v.abs() / scale).sqrt() * rng.gaussian()
            } else {
                g
            }
        })
        .collect();

    // No measurable activity: reference the single-spike amplitude instead.
    let sigma0 = if signal > 0.0 {
        signal / target
    } else {
        single_spike_amp / target
    };
    if !sigma0.is_finite() || sigma0 <= 0.0 {
        return 0.0;
    }
    let mut buf = vec![0.0_f64; n];
    let measure = |sigma: f64, buf: &mut Vec<f64>| -> f64 {
        for ((b, &t), &u) in buf.iter_mut().zip(trace.iter()).zip(unit.iter()) {
            *b = t + sigma * u;
        }
        measured_snr_f64(buf, DEFAULT_TOP_FRACTION, fs_hz)
    };
    let sigma = if signal > 0.0 {
        // Measured SNR falls from a ceiling (signal-dominated MAD) to the
        // pure-noise floor as σ grows. Bisect in log σ over a wide bracket.
        let (mut lo, mut hi) = (sigma0 / 1e3, sigma0 * 1e3);
        let (f_lo, f_hi) = (measure(lo, &mut buf), measure(hi, &mut buf));
        if f_lo < target || f_hi > target {
            // Target outside the reachable range: keep the clean-trace estimate.
            sigma0
        } else {
            for _ in 0..60 {
                let mid = (lo * hi).sqrt();
                let f = measure(mid, &mut buf);
                if (f / target - 1.0).abs() < 1e-5 {
                    lo = mid;
                    hi = mid;
                    break;
                }
                if f > target {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            (lo * hi).sqrt()
        }
    } else {
        sigma0
    };
    // Total σ (RMS over the trace): Gaussian part plus the mean shot variance.
    let total_sigma = if shot && scale > 0.0 {
        let mean_abs = trace.iter().map(|v| v.abs()).sum::<f64>() / n as f64;
        sigma * ((1.0 - frac) + frac * mean_abs / scale).sqrt()
    } else {
        sigma
    };
    for (v, &u) in trace.iter_mut().zip(unit.iter()) {
        *v += sigma * u;
    }
    total_sigma
}

fn poisson_sample_knuth(lambda: f64, rng: &mut Xorshift32) -> f64 {
    if lambda <= 0.0 {
        return 0.0;
    }
    if lambda > 30.0 {
        return (lambda + lambda.sqrt() * rng.gaussian()).max(0.0);
    }
    let l = (-lambda).exp();
    let mut k = 0.0_f64;
    let mut p = 1.0_f64;
    loop {
        k += 1.0;
        p *= rng.next_f64();
        if p <= l {
            return k - 1.0;
        }
    }
}

// ── Presets ──────────────────────────────────────────────────────

/// Indicator presets.
///
/// Noise is set as a measured SNR ([`NoiseReference::MeasuredSnr`]) typical of
/// real recordings: the value each preset measures at, under the default
/// Markov firing at 30 Hz, when the noise is CASCADE's typical level
/// ν ≈ 4 %·Hz^-½ (Rupprecht et al. 2021: ν ≈ 1–2 high quality, ≈ 4 typical,
/// ≈ 8 large-scale population imaging). The kernel peak (alpha = 1) is taken
/// to be the indicator's published single-AP ΔF/F, so per-frame
/// σ = ν·√fs / (0.6745·√2) in ΔF/F:
///
/// | preset   | 1-AP ΔF/F | source                                             | snr (ν≈4) |
/// |----------|-----------|----------------------------------------------------|-----------|
/// | gcamp6f  | 19 %      | Chen et al. 2013, in vivo V1 (as tabulated in reviews) | 30    |
/// | gcamp6m  | 13 %      | Chen et al. 2013                                   | 22        |
/// | gcamp6s  | 23 %      | Chen et al. 2013                                   | 50        |
/// | jgcamp8f | 41 %      | Zhang et al. 2023 (Janelia in vivo cell-attached)  | 45        |
/// | ogb1     | ~8 %      | proposal: in vivo OGB-1 reports span ~5–10 %       | 14        |
///
/// These are judgement calls for the PI to confirm; the measured SNR scales as
/// 1/ν (≈ 2× at ν = 2, ≈ ½ at ν = 8) and depends on the firing statistics (the
/// default Markov bursts are large; sparse Poisson cells at the same ν measure
/// 3–10). [`legacy_peak_all`] returns the pre-change presets.
pub mod presets {
    use super::*;

    /// The presets as they were before the measured-SNR convention: legacy
    /// [`NoiseReference::Peak`] noise at the old SNR values. For reproducing
    /// earlier results and for tests characterised against them.
    pub fn legacy_peak_all() -> Vec<(&'static str, SimulationConfig)> {
        let old = [
            ("gcamp6f", 20.0),
            ("gcamp6s", 25.0),
            ("gcamp6m", 22.0),
            ("jgcamp8f", 12.0),
            ("ogb1", 15.0),
            ("clean", 200.0),
        ];
        all()
            .into_iter()
            .map(|(name, mut cfg)| {
                let snr = old.iter().find(|o| o.0 == name).map(|o| o.1).unwrap();
                cfg.noise.snr = snr;
                cfg.noise.reference = NoiseReference::Peak;
                (name, cfg)
            })
            .collect()
    }

    pub fn gcamp6f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.1,
                tau_decay_s: 0.6,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 30.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn gcamp6s() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.4,
                tau_decay_s: 1.8,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 50.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn gcamp6m() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.15,
                tau_decay_s: 0.9,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 22.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn jgcamp8f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.05,
                tau_decay_s: 0.3,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 45.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn ogb1() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.05,
                tau_decay_s: 1.5,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 14.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    pub fn clean() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig {
                tau_rise_s: 0.1,
                tau_decay_s: 0.6,
                ..Default::default()
            },
            noise: NoiseConfig {
                snr: 200.0,
                ..Default::default()
            },
            drift: DriftModel::RandomWalk(RandomWalkDrift {
                step_std_fraction: 0.0,
                ..Default::default()
            }),
            alpha_cv: 0.0,
            ..Default::default()
        }
    }

    pub fn all() -> Vec<(&'static str, SimulationConfig)> {
        vec![
            ("gcamp6f", gcamp6f()),
            ("gcamp6s", gcamp6s()),
            ("gcamp6m", gcamp6m()),
            ("jgcamp8f", jgcamp8f()),
            ("ogb1", ogb1()),
            ("clean", clean()),
        ]
    }
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn small_config() -> SimulationConfig {
        SimulationConfig {
            fs_hz: 30.0,
            num_timepoints: 900,
            num_cells: 3,
            noise: NoiseConfig {
                snr: 20.0,
                ..Default::default()
            },
            alpha_cv: 0.0,
            ..Default::default()
        }
    }

    #[test]
    fn determinism() {
        let cfg = small_config();
        assert_eq!(simulate(&cfg).traces, simulate(&cfg).traces);
    }

    #[test]
    fn correct_shape() {
        let r = simulate(&small_config());
        assert_eq!(r.traces.len(), 3 * 900);
        assert_eq!(r.ground_truth.len(), 3);
        for gt in &r.ground_truth {
            assert_eq!(gt.spikes.len(), 900);
            assert_eq!(gt.clean_calcium.len(), 900);
        }
    }

    #[test]
    fn low_spike_sim_hz_does_not_degenerate() {
        // spike_sim_hz below fs_hz/2 rounds bins_per_frame to 0; the clamp
        // keeps the high-resolution buffer non-empty so the simulation still
        // produces full-length, finite traces instead of a degenerate result.
        let cfg = SimulationConfig {
            fs_hz: 30.0,
            spike_sim_hz: 10.0,
            num_timepoints: 300,
            num_cells: 2,
            alpha_cv: 0.0,
            ..Default::default()
        };
        let r = simulate(&cfg);
        assert_eq!(r.traces.len(), 2 * 300);
        assert!(r.traces.iter().all(|v| v.is_finite()));
        for gt in &r.ground_truth {
            assert_eq!(gt.spikes.len(), 300);
        }
    }

    #[test]
    fn spikes_non_negative() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.spikes.iter().all(|&s| s >= 0.0));
        }
    }

    #[test]
    fn clean_calcium_non_negative() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.clean_calcium.iter().all(|&c| c >= -1e-6));
        }
    }

    #[test]
    fn markov_produces_spikes() {
        let cfg = SimulationConfig {
            num_timepoints: 9000,
            num_cells: 1,
            alpha_cv: 0.0,
            ..Default::default()
        };
        assert!(simulate(&cfg).ground_truth[0].spikes.iter().sum::<f32>() > 0.0);
    }

    #[test]
    fn poisson_mean_rate() {
        let cfg = SimulationConfig {
            num_timepoints: 30000,
            num_cells: 1,
            alpha_cv: 0.0,
            spike_model: SpikeModel::Poisson(PoissonConfig { rate_hz: 2.0 }),
            ..Default::default()
        };
        let rate =
            simulate(&cfg).ground_truth[0].spikes.iter().sum::<f32>() as f64 / (30000.0 / 30.0);
        assert!((rate - 2.0).abs() < 1.0, "Expected ~2.0 Hz, got {rate:.2}");
    }

    #[test]
    fn alpha_variation() {
        let cfg = SimulationConfig {
            num_timepoints: 900,
            num_cells: 50,
            alpha_cv: 0.3,
            ..Default::default()
        };
        let alphas: Vec<f64> = simulate(&cfg)
            .ground_truth
            .iter()
            .map(|gt| gt.alpha)
            .collect();
        let mean = alphas.iter().sum::<f64>() / alphas.len() as f64;
        let cv = (alphas.iter().map(|a| (a - mean).powi(2)).sum::<f64>() / alphas.len() as f64)
            .sqrt()
            / mean;
        assert!(cv > 0.1 && cv < 0.6, "Alpha CV ~0.3, got {cv:.3}");
    }

    #[test]
    fn kernel_variation() {
        let cfg = SimulationConfig {
            num_timepoints: 900,
            num_cells: 50,
            alpha_cv: 0.0,
            kernel: KernelConfig {
                tau_decay_cv: 0.15,
                ..Default::default()
            },
            ..Default::default()
        };
        let taus: Vec<f64> = simulate(&cfg)
            .ground_truth
            .iter()
            .map(|gt| gt.tau_decay_s)
            .collect();
        let mean = taus.iter().sum::<f64>() / taus.len() as f64;
        assert!(taus.iter().cloned().fold(f64::NEG_INFINITY, f64::max) > mean * 1.05);
        assert!(taus.iter().cloned().fold(f64::INFINITY, f64::min) < mean * 0.95);
    }

    #[test]
    fn photobleaching() {
        let base = SimulationConfig {
            num_timepoints: 9000,
            num_cells: 1,
            alpha_cv: 0.0,
            noise: NoiseConfig {
                snr: 200.0,
                ..Default::default()
            },
            drift: DriftModel::RandomWalk(RandomWalkDrift {
                step_std_fraction: 0.0,
                ..Default::default()
            }),
            ..Default::default()
        };
        let r_no = simulate(&SimulationConfig {
            photobleaching: PhotobleachingConfig {
                enabled: false,
                ..Default::default()
            },
            ..base.clone()
        });
        let r_yes = simulate(&SimulationConfig {
            photobleaching: PhotobleachingConfig {
                enabled: true,
                decay_time_constant_s: 30.0,
                amplitude_fraction: 0.3,
                amplitude_cv: 0.0,
            },
            ..base
        });
        let n = 9000;
        let last = n - n / 10;
        let frac = (last..n)
            .filter(|&i| r_yes.traces[i] < r_no.traces[i])
            .count() as f64
            / (n - last) as f64;
        assert!(frac > 0.8);
    }

    #[test]
    fn saturation() {
        let base = SimulationConfig {
            num_timepoints: 900,
            num_cells: 1,
            alpha_cv: 0.0,
            ..Default::default()
        };
        let r_lin = simulate(&SimulationConfig {
            saturation: SaturationConfig {
                enabled: false,
                ..Default::default()
            },
            ..base.clone()
        });
        let r_sat = simulate(&SimulationConfig {
            saturation: SaturationConfig {
                enabled: true,
                hill_coefficient: 1.0,
                k_d: 0.5,
                k_d_cv: 0.0,
            },
            ..base
        });
        let max_lin = r_lin.ground_truth[0]
            .clean_calcium
            .iter()
            .cloned()
            .fold(0.0_f32, f32::max);
        let max_sat = r_sat.ground_truth[0]
            .clean_calcium
            .iter()
            .cloned()
            .fold(0.0_f32, f32::max);
        assert!(max_sat < max_lin || max_lin < 1e-6);
    }

    #[test]
    fn presets_valid() {
        for (name, cfg) in presets::all() {
            assert!(
                cfg.fs_hz > 0.0
                    && cfg.kernel.tau_rise_s > 0.0
                    && cfg.kernel.tau_decay_s > 0.0
                    && cfg.noise.snr > 0.0,
                "Preset {name} invalid"
            );
        }
    }

    #[test]
    fn xorshift32_deterministic() {
        let mut rng = Xorshift32::new(42);
        let v1 = rng.next_u32();
        assert_eq!(v1, 11355432);
        let v2 = rng.next_u32();
        let v3 = rng.next_u32();
        assert!(v2 != v1 && v3 != v2);
        let mut rng2 = Xorshift32::new(42);
        assert_eq!(rng2.next_u32(), v1);
        assert_eq!(rng2.next_u32(), v2);
        assert_eq!(rng2.next_u32(), v3);
    }

    #[test]
    fn ground_truth_populated() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.alpha > 0.0 && gt.snr > 0.0 && gt.tau_rise_s > 0.0 && gt.tau_decay_s > 0.0);
        }
    }

    #[test]
    fn single_cell_single_timepoint() {
        let r = simulate(&SimulationConfig {
            num_timepoints: 1,
            num_cells: 1,
            alpha_cv: 0.0,
            ..Default::default()
        });
        assert_eq!(r.traces.len(), 1);
    }

    #[cfg(feature = "serde")]
    #[test]
    fn serde_roundtrip() {
        let cfg = SimulationConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let cfg2: SimulationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg.fs_hz, cfg2.fs_hz);
        assert_eq!(cfg.num_cells, cfg2.num_cells);
    }
}
