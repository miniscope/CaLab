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
        Self { state, cached_gaussian: None }
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
            if v == 0.0 { 1e-10 } else { v }
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
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct MarkovConfig {
    /// Silent→active transition probability per imaging frame. Default: 0.01.
    pub p_silent_to_active: f64,
    /// Active→silent transition probability per imaging frame. Default: 0.2.
    pub p_active_to_silent: f64,
    /// Spike probability per high-resolution timestep in active state. Default: 0.7.
    pub p_spike_when_active: f64,
    /// Spike probability per high-resolution timestep in silent state. Default: 0.005.
    pub p_spike_when_silent: f64,
    /// Per-cell log-normal CV on p_silent_to_active (0 = no variation). Default: 0.0.
    pub p_silent_to_active_cv: f64,
}

impl Default for MarkovConfig {
    fn default() -> Self {
        Self {
            p_silent_to_active: 0.01,
            p_active_to_silent: 0.2,
            p_spike_when_active: 0.7,
            p_spike_when_silent: 0.005,
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
    fn default() -> Self { Self { rate_hz: 1.0 } }
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
    fn default() -> Self { Self::Markov(MarkovConfig::default()) }
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
        Self { tau_rise_s: 0.1, tau_decay_s: 0.6, tau_rise_cv: 0.0, tau_decay_cv: 0.0 }
    }
}

/// Noise model: Gaussian + optional Poisson (shot) noise.
/// Attribution: Gaussian from CaLab web simulator; shot noise from CASCADE (Rupprecht et al., 2021).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct NoiseConfig {
    /// Signal-to-noise ratio (peak_signal / noise_std). Default: 8.0.
    pub snr: f64,
    /// Enable Poisson (shot) noise. Default: false.
    pub shot_noise_enabled: bool,
    /// Fraction of total noise variance from shot noise (0..1). Default: 0.3.
    pub shot_noise_fraction: f64,
    /// Per-cell additive SNR spread: cell_snr = snr + U(-spread, +spread). Default: 0.0.
    pub snr_spread: f64,
}

impl Default for NoiseConfig {
    fn default() -> Self {
        Self { snr: 8.0, shot_noise_enabled: false, shot_noise_fraction: 0.3, snr_spread: 0.0 }
    }
}

/// Deterministic sinusoidal baseline drift. Useful as a simple test signal
/// but not physically motivated — real baseline fluctuations are irregular.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct SinusoidalDrift {
    /// Drift amplitude as fraction of peak signal. Default: 0.1.
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
        Self { amplitude_fraction: 0.1, cycles_min: 2.0, cycles_max: 4.0, amplitude_cv: 0.0 }
    }
}

/// Mean-reverting Gaussian random walk baseline drift.
/// From MLspike (Deneux et al., 2016, Nature Communications).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct RandomWalkDrift {
    /// Step std as fraction of peak signal per frame. Default: 0.002.
    pub step_std_fraction: f64,
    /// Mean-reversion rate (0=pure walk, 1=reset). Default: 0.001.
    pub mean_reversion: f64,
    /// Per-cell log-normal CV on step_std (0 = no variation). Default: 0.0.
    pub step_std_cv: f64,
}

impl Default for RandomWalkDrift {
    fn default() -> Self {
        Self { step_std_fraction: 0.002, mean_reversion: 0.001, step_std_cv: 0.0 }
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
    fn default() -> Self { Self::RandomWalk(RandomWalkDrift::default()) }
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
        Self { enabled: false, decay_time_constant_s: 600.0, amplitude_fraction: 0.15, amplitude_cv: 0.0 }
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
        Self { enabled: false, hill_coefficient: 1.0, k_d: 5.0, k_d_cv: 0.0 }
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
    pub snr: f64,
    pub tau_rise_s: f64,
    pub tau_decay_s: f64,
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

    let bins_per_frame = (config.spike_sim_hz / config.fs_hz).round() as usize;
    let num_high_res = n_tp * bins_per_frame;

    let shared_kernel = if !has_kernel_variation {
        Some(build_kernel(config.kernel.tau_rise_s, config.kernel.tau_decay_s, config.spike_sim_hz))
    } else {
        None
    };

    let mut high_res_buf = vec![0u8; num_high_res];
    let mut trace_buf: Vec<f64> = Vec::with_capacity(n_tp);

    for cell_idx in 0..n_cells {
        let cell_seed = config.seed.wrapping_add((cell_idx as u32).wrapping_mul(7919));
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
        let cell_tau_rise = vary_lognormal(config.kernel.tau_rise_s, config.kernel.tau_rise_cv, &mut rng);
        let cell_tau_decay = vary_lognormal(config.kernel.tau_decay_s, config.kernel.tau_decay_cv, &mut rng);

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
            &cell_spike_model, num_high_res, bins_per_frame,
            config.spike_sim_hz, &mut rng, &mut high_res_buf,
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
        if config.saturation.enabled {
            let cell_kd = vary_lognormal(config.saturation.k_d, config.saturation.k_d_cv, &mut rng);
            apply_saturation(&mut clean_calcium, config.saturation.hill_coefficient, cell_kd);
        }

        let signal_max = clean_calcium.iter().cloned().fold(0.0_f32, f32::max) as f64;

        // Reuse trace buffer across cells
        trace_buf.clear();
        trace_buf.extend(clean_calcium.iter().map(|&c| c as f64));

        // 9. Per-cell drift intensity
        let cell_drift = match &config.drift {
            DriftModel::RandomWalk(cfg) => {
                let cell_step = vary_lognormal(cfg.step_std_fraction, cfg.step_std_cv, &mut rng);
                DriftModel::RandomWalk(RandomWalkDrift { step_std_fraction: cell_step, ..*cfg })
            }
            DriftModel::Sinusoidal(cfg) => {
                let cell_amp = vary_lognormal(cfg.amplitude_fraction, cfg.amplitude_cv, &mut rng);
                DriftModel::Sinusoidal(SinusoidalDrift { amplitude_fraction: cell_amp, ..*cfg })
            }
        };
        add_drift(&mut trace_buf, &cell_drift, signal_max, n_tp, &mut rng);

        // 10. Per-cell photobleaching amplitude
        if config.photobleaching.enabled {
            let cell_amp = vary_lognormal(
                config.photobleaching.amplitude_fraction,
                config.photobleaching.amplitude_cv,
                &mut rng,
            ).min(1.0);
            let cell_pb = PhotobleachingConfig { amplitude_fraction: cell_amp, ..config.photobleaching };
            apply_photobleaching(&mut trace_buf, &cell_pb, config.fs_hz);
        }

        // 11. Add noise
        add_noise(&mut trace_buf, &config.noise, cell_snr, signal_max, &mut rng);

        traces.extend(trace_buf.iter().map(|&v| v as f32));
        ground_truth.push(CellGroundTruth {
            spikes, clean_calcium, alpha,
            snr: cell_snr, tau_rise_s: cell_tau_rise, tau_decay_s: cell_tau_decay,
        });
    }

    SimulationResult { traces, num_cells: n_cells, num_timepoints: n_tp, ground_truth }
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

fn fill_markov_spikes(cfg: &MarkovConfig, buf: &mut [u8], bins_per_frame: usize, rng: &mut Xorshift32) {
    let p_s2a = 1.0 - (1.0 - cfg.p_silent_to_active).powf(1.0 / bins_per_frame as f64);
    let p_a2s = 1.0 - (1.0 - cfg.p_active_to_silent).powf(1.0 / bins_per_frame as f64);
    let mut state = 0u8;
    for spike in buf.iter_mut() {
        if state == 0 {
            if rng.next_f64() < p_s2a { state = 1; }
        } else if rng.next_f64() < p_a2s {
            state = 0;
        }
        let p_spike = if state == 1 { cfg.p_spike_when_active } else { cfg.p_spike_when_silent };
        if rng.next_f64() < p_spike { *spike = 1; }
    }
}

fn fill_poisson_spikes(cfg: &PoissonConfig, buf: &mut [u8], spike_sim_hz: f64, rng: &mut Xorshift32) {
    let p_spike = cfg.rate_hz / spike_sim_hz;
    for spike in buf.iter_mut() {
        if rng.next_f64() < p_spike { *spike = 1; }
    }
}

fn bin_to_imaging_rate(high_res: &[u8], num_timepoints: usize, bins_per_frame: usize) -> Vec<f32> {
    let mut spikes = vec![0.0_f32; num_timepoints];
    for (f, spike_count) in spikes.iter_mut().enumerate() {
        let start = f * bins_per_frame;
        let end = (start + bins_per_frame).min(high_res.len());
        let count: u32 = high_res[start..end].iter().map(|&s| s as u32).sum();
        if count > 0 { *spike_count = count as f32; }
    }
    spikes
}

// ── Convolution ──────────────────────────────────────────────────

fn convolve_binary_spikes(spikes: &[u8], kernel: &[f32]) -> Vec<f32> {
    let n = spikes.len();
    let k_len = kernel.len();
    let mut out = vec![0.0_f32; n];
    for t in 0..n {
        if spikes[t] == 0 { continue; }
        let end = (t + k_len).min(n);
        for k in 0..(end - t) { out[t + k] += kernel[k]; }
    }
    out
}

// ── Saturation ───────────────────────────────────────────────────

fn apply_saturation(signal: &mut [f32], hill_n: f64, k_d: f64) {
    let kd_n = k_d.powf(hill_n);
    // Fast-path for common integer Hill coefficients
    let hill_int = if (hill_n - hill_n.round()).abs() < 1e-9 { Some(hill_n.round() as i32) } else { None };
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

fn add_drift(trace: &mut [f64], model: &DriftModel, signal_max: f64, n: usize, rng: &mut Xorshift32) {
    match model {
        DriftModel::Sinusoidal(cfg) => {
            if cfg.amplitude_fraction <= 0.0 || signal_max <= 0.0 { return; }
            let cycles = cfg.cycles_min + rng.next_f64() * (cfg.cycles_max - cfg.cycles_min);
            let period = n as f64 / cycles;
            let amp = cfg.amplitude_fraction * signal_max;
            let two_pi = 2.0 * std::f64::consts::PI;
            for i in 0..n { trace[i] += amp * (two_pi * i as f64 / period).sin(); }
        }
        DriftModel::RandomWalk(cfg) => {
            if cfg.step_std_fraction <= 0.0 || signal_max <= 0.0 { return; }
            let step_std = cfg.step_std_fraction * signal_max;
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

fn add_noise(trace: &mut [f64], cfg: &NoiseConfig, cell_snr: f64, signal_max: f64, rng: &mut Xorshift32) {
    if cell_snr <= 0.0 || signal_max <= 0.0 { return; }
    let noise_std = signal_max / cell_snr;

    if cfg.shot_noise_enabled && cfg.shot_noise_fraction > 0.0 {
        let total_var = noise_std * noise_std;
        let gauss_std = (total_var * (1.0 - cfg.shot_noise_fraction)).sqrt();
        let shot_var = total_var * cfg.shot_noise_fraction;
        for v in trace.iter_mut() {
            let gauss = gauss_std * rng.gaussian();
            let lambda = (*v).abs() * shot_var / signal_max;
            let shot = poisson_sample_knuth(lambda, rng) - lambda;
            *v += gauss + shot;
        }
    } else {
        for v in trace.iter_mut() { *v += noise_std * rng.gaussian(); }
    }
}

fn poisson_sample_knuth(lambda: f64, rng: &mut Xorshift32) -> f64 {
    if lambda <= 0.0 { return 0.0; }
    if lambda > 30.0 { return (lambda + lambda.sqrt() * rng.gaussian()).max(0.0); }
    let l = (-lambda).exp();
    let mut k = 0.0_f64;
    let mut p = 1.0_f64;
    loop {
        k += 1.0;
        p *= rng.next_f64();
        if p <= l { return k - 1.0; }
    }
}

// ── Presets ──────────────────────────────────────────────────────

pub mod presets {
    use super::*;

    pub fn gcamp6f() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6, ..Default::default() },
        noise: NoiseConfig { snr: 20.0, ..Default::default() },
        ..Default::default()
    }}

    pub fn gcamp6s() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.4, tau_decay_s: 1.8, ..Default::default() },
        noise: NoiseConfig { snr: 25.0, ..Default::default() },
        ..Default::default()
    }}

    pub fn gcamp6m() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.15, tau_decay_s: 0.9, ..Default::default() },
        noise: NoiseConfig { snr: 22.0, ..Default::default() },
        ..Default::default()
    }}

    pub fn jgcamp8f() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 0.3, ..Default::default() },
        noise: NoiseConfig { snr: 12.0, ..Default::default() },
        ..Default::default()
    }}

    pub fn ogb1() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 1.5, ..Default::default() },
        noise: NoiseConfig { snr: 15.0, ..Default::default() },
        ..Default::default()
    }}

    pub fn clean() -> SimulationConfig { SimulationConfig {
        kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6, ..Default::default() },
        noise: NoiseConfig { snr: 200.0, ..Default::default() },
        drift: DriftModel::RandomWalk(RandomWalkDrift { step_std_fraction: 0.0, ..Default::default() }),
        alpha_cv: 0.0,
        ..Default::default()
    }}

    pub fn all() -> Vec<(&'static str, SimulationConfig)> {
        vec![("gcamp6f", gcamp6f()), ("gcamp6s", gcamp6s()), ("gcamp6m", gcamp6m()),
             ("jgcamp8f", jgcamp8f()), ("ogb1", ogb1()), ("clean", clean())]
    }
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn small_config() -> SimulationConfig {
        SimulationConfig {
            fs_hz: 30.0, num_timepoints: 900, num_cells: 3,
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            alpha_cv: 0.0,
            ..Default::default()
        }
    }

    #[test] fn determinism() {
        let cfg = small_config();
        assert_eq!(simulate(&cfg).traces, simulate(&cfg).traces);
    }

    #[test] fn correct_shape() {
        let r = simulate(&small_config());
        assert_eq!(r.traces.len(), 3 * 900);
        assert_eq!(r.ground_truth.len(), 3);
        for gt in &r.ground_truth {
            assert_eq!(gt.spikes.len(), 900);
            assert_eq!(gt.clean_calcium.len(), 900);
        }
    }

    #[test] fn spikes_non_negative() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.spikes.iter().all(|&s| s >= 0.0));
        }
    }

    #[test] fn clean_calcium_non_negative() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.clean_calcium.iter().all(|&c| c >= -1e-6));
        }
    }

    #[test] fn markov_produces_spikes() {
        let cfg = SimulationConfig { num_timepoints: 9000, num_cells: 1, alpha_cv: 0.0, ..Default::default() };
        assert!(simulate(&cfg).ground_truth[0].spikes.iter().sum::<f32>() > 0.0);
    }

    #[test] fn poisson_mean_rate() {
        let cfg = SimulationConfig {
            num_timepoints: 30000, num_cells: 1, alpha_cv: 0.0,
            spike_model: SpikeModel::Poisson(PoissonConfig { rate_hz: 2.0 }),
            ..Default::default()
        };
        let rate = simulate(&cfg).ground_truth[0].spikes.iter().sum::<f32>() as f64 / (30000.0 / 30.0);
        assert!((rate - 2.0).abs() < 1.0, "Expected ~2.0 Hz, got {rate:.2}");
    }

    #[test] fn alpha_variation() {
        let cfg = SimulationConfig {
            num_timepoints: 900, num_cells: 50, alpha_cv: 0.3, ..Default::default()
        };
        let alphas: Vec<f64> = simulate(&cfg).ground_truth.iter().map(|gt| gt.alpha).collect();
        let mean = alphas.iter().sum::<f64>() / alphas.len() as f64;
        let cv = (alphas.iter().map(|a| (a - mean).powi(2)).sum::<f64>() / alphas.len() as f64).sqrt() / mean;
        assert!(cv > 0.1 && cv < 0.6, "Alpha CV ~0.3, got {cv:.3}");
    }

    #[test] fn kernel_variation() {
        let cfg = SimulationConfig {
            num_timepoints: 900, num_cells: 50, alpha_cv: 0.0,
            kernel: KernelConfig { tau_decay_cv: 0.15, ..Default::default() },
            ..Default::default()
        };
        let taus: Vec<f64> = simulate(&cfg).ground_truth.iter().map(|gt| gt.tau_decay_s).collect();
        let mean = taus.iter().sum::<f64>() / taus.len() as f64;
        assert!(taus.iter().cloned().fold(f64::NEG_INFINITY, f64::max) > mean * 1.05);
        assert!(taus.iter().cloned().fold(f64::INFINITY, f64::min) < mean * 0.95);
    }

    #[test] fn photobleaching() {
        let base = SimulationConfig {
            num_timepoints: 9000, num_cells: 1, alpha_cv: 0.0,
            noise: NoiseConfig { snr: 200.0, ..Default::default() },
            drift: DriftModel::RandomWalk(RandomWalkDrift { step_std_fraction: 0.0, ..Default::default() }),
            ..Default::default()
        };
        let r_no = simulate(&SimulationConfig { photobleaching: PhotobleachingConfig { enabled: false, ..Default::default() }, ..base.clone() });
        let r_yes = simulate(&SimulationConfig { photobleaching: PhotobleachingConfig { enabled: true, decay_time_constant_s: 30.0, amplitude_fraction: 0.3, amplitude_cv: 0.0 }, ..base });
        let n = 9000;
        let last = n - n / 10;
        let frac = (last..n).filter(|&i| r_yes.traces[i] < r_no.traces[i]).count() as f64 / (n - last) as f64;
        assert!(frac > 0.8);
    }

    #[test] fn saturation() {
        let base = SimulationConfig { num_timepoints: 900, num_cells: 1, alpha_cv: 0.0, ..Default::default() };
        let r_lin = simulate(&SimulationConfig { saturation: SaturationConfig { enabled: false, ..Default::default() }, ..base.clone() });
        let r_sat = simulate(&SimulationConfig { saturation: SaturationConfig { enabled: true, hill_coefficient: 1.0, k_d: 0.5, k_d_cv: 0.0 }, ..base });
        let max_lin = r_lin.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        let max_sat = r_sat.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        assert!(max_sat < max_lin || max_lin < 1e-6);
    }

    #[test] fn presets_valid() {
        for (name, cfg) in presets::all() {
            assert!(cfg.fs_hz > 0.0 && cfg.kernel.tau_rise_s > 0.0 && cfg.kernel.tau_decay_s > 0.0 && cfg.noise.snr > 0.0, "Preset {name} invalid");
        }
    }

    #[test] fn xorshift32_deterministic() {
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

    #[test] fn ground_truth_populated() {
        for gt in &simulate(&small_config()).ground_truth {
            assert!(gt.alpha > 0.0 && gt.snr > 0.0 && gt.tau_rise_s > 0.0 && gt.tau_decay_s > 0.0);
        }
    }

    #[test] fn single_cell_single_timepoint() {
        let r = simulate(&SimulationConfig { num_timepoints: 1, num_cells: 1, alpha_cv: 0.0, ..Default::default() });
        assert_eq!(r.traces.len(), 1);
    }

    #[cfg(feature = "serde")]
    #[test] fn serde_roundtrip() {
        let cfg = SimulationConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let cfg2: SimulationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg.fs_hz, cfg2.fs_hz);
        assert_eq!(cfg.num_cells, cfg2.num_cells);
    }
}
