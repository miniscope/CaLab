//! Synthetic calcium trace simulation with full ground truth.
//!
//! Generates realistic fluorescence traces for testing deconvolution algorithms.
//! Shared engine: exposed to both WASM (web) and Python (PyO3) via bindings.
//!
//! Pipeline per cell:
//!   1. Draw per-cell parameters (alpha, tau, SNR) from variation distributions
//!   2. Generate spike train at high resolution, bin to imaging rate
//!   3. Convolve with per-cell kernel
//!   4. Scale by alpha
//!   5. Apply indicator saturation (optional)
//!   6. Add drift
//!   7. Apply photobleaching (optional, multiplicative)
//!   8. Add noise (Gaussian + optional Poisson shot noise)

use crate::kernel::build_kernel;

// ── PRNG ─────────────────────────────────────────────────────────

/// xorshift32 PRNG — deterministic across WASM and native targets.
/// Ported from CaLab web simulator (`packages/compute/src/mock-traces.ts`).
#[derive(Clone)]
struct Xorshift32 {
    state: u32,
}

impl Xorshift32 {
    fn new(seed: u32) -> Self {
        let state = if seed == 0 { 1 } else { seed };
        Self { state }
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
        let u1 = {
            let v = self.next_f64();
            if v == 0.0 { 1e-10 } else { v }
        };
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

// ── Configuration structs ────────────────────────────────────────
//
// All config structs use `#[serde(default)]` at the struct level so that
// missing fields in JSON are filled from `Default::default()`. This avoids
// per-field default functions while keeping deserialization flexible.

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
}

impl Default for MarkovConfig {
    fn default() -> Self {
        Self {
            p_silent_to_active: 0.01,
            p_active_to_silent: 0.2,
            p_spike_when_active: 0.7,
            p_spike_when_silent: 0.005,
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
}

impl Default for KernelConfig {
    fn default() -> Self { Self { tau_rise_s: 0.1, tau_decay_s: 0.6 } }
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
}

impl Default for NoiseConfig {
    fn default() -> Self {
        Self { snr: 8.0, shot_noise_enabled: false, shot_noise_fraction: 0.3 }
    }
}

/// Slow sinusoidal baseline drift. Attribution: CaLab web simulator.
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
}

impl Default for SinusoidalDrift {
    fn default() -> Self {
        Self { amplitude_fraction: 0.1, cycles_min: 2.0, cycles_max: 4.0 }
    }
}

/// Gaussian random walk baseline drift with mean reversion.
/// Attribution: MLspike (Deneux et al., 2016).
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct RandomWalkDrift {
    /// Step std as fraction of peak signal per frame. Default: 0.002.
    pub step_std_fraction: f64,
    /// Mean-reversion rate (0=pure walk, 1=reset). Default: 0.001.
    pub mean_reversion: f64,
}

impl Default for RandomWalkDrift {
    fn default() -> Self {
        Self { step_std_fraction: 0.002, mean_reversion: 0.001 }
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
    fn default() -> Self { Self::Sinusoidal(SinusoidalDrift::default()) }
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
}

impl Default for PhotobleachingConfig {
    fn default() -> Self {
        Self { enabled: false, decay_time_constant_s: 600.0, amplitude_fraction: 0.15 }
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
}

impl Default for SaturationConfig {
    fn default() -> Self {
        Self { enabled: false, hill_coefficient: 1.0, k_d: 5.0 }
    }
}

/// Per-cell parameter variation for multi-cell simulations.
/// Tests CaDecon's single-kernel assumption and alpha estimation.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct CellVariationConfig {
    /// Mean amplitude scaling factor (LogNormal mean). Default: 1.0.
    pub alpha_mean: f64,
    /// Alpha coefficient of variation (std/mean). Default: 0.3.
    pub alpha_cv: f64,
    /// Tau_rise log-space CV (0 = no variation). Default: 0.0.
    pub tau_rise_cv: f64,
    /// Tau_decay log-space CV (0 = no variation). Default: 0.0.
    pub tau_decay_cv: f64,
    /// Additive SNR spread (+/- this value). Default: 0.0.
    pub snr_spread: f64,
}

impl Default for CellVariationConfig {
    fn default() -> Self {
        Self {
            alpha_mean: 1.0,
            alpha_cv: 0.3,
            tau_rise_cv: 0.0,
            tau_decay_cv: 0.0,
            snr_spread: 0.0,
        }
    }
}

/// Complete configuration for synthetic calcium trace generation.
/// Default values produce a reasonable GCaMP6f-like simulation.
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
    /// Nominal kernel parameters (population mean).
    pub kernel: KernelConfig,
    /// Spike generation model.
    pub spike_model: SpikeModel,
    /// Noise model.
    pub noise: NoiseConfig,
    /// Baseline drift model.
    pub drift: DriftModel,
    /// Photobleaching (optional, multiplicative).
    pub photobleaching: PhotobleachingConfig,
    /// Indicator saturation (optional, Hill equation).
    pub saturation: SaturationConfig,
    /// Per-cell parameter variation (alpha, kernel, SNR).
    pub cell_variation: CellVariationConfig,
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
            cell_variation: CellVariationConfig::default(),
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
    /// Observed (noisy) fluorescence traces. Row-major: [num_cells * num_timepoints].
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
    let var = &config.cell_variation;
    let has_kernel_variation = var.tau_rise_cv > 0.0 || var.tau_decay_cv > 0.0;

    let mut traces = Vec::with_capacity(n_cells * n_tp);
    let mut ground_truth = Vec::with_capacity(n_cells);

    // Cache kernel when all cells share the same tau values
    let shared_kernel = if !has_kernel_variation {
        Some(build_kernel(config.kernel.tau_rise_s, config.kernel.tau_decay_s, config.fs_hz))
    } else {
        None
    };

    // Reusable high-res spike buffer (avoids per-cell allocation)
    let bins_per_frame = (config.spike_sim_hz / config.fs_hz).round() as usize;
    let num_high_res = n_tp * bins_per_frame;
    let mut high_res_buf = vec![0u8; num_high_res];

    for cell_idx in 0..n_cells {
        // Per-cell seed: prime offset for independence (CaLab convention).
        let cell_seed = config.seed.wrapping_add((cell_idx as u32).wrapping_mul(7919));
        let mut rng = Xorshift32::new(cell_seed);

        // 1. Draw per-cell parameters
        let alpha = if var.alpha_cv > 0.0 {
            let sigma2 = (1.0 + var.alpha_cv * var.alpha_cv).ln();
            let mu = var.alpha_mean.ln() - sigma2 / 2.0;
            (mu + sigma2.sqrt() * rng.gaussian()).exp()
        } else {
            var.alpha_mean
        };

        let cell_tau_rise = if var.tau_rise_cv > 0.0 {
            config.kernel.tau_rise_s * (var.tau_rise_cv * rng.gaussian()).exp()
        } else {
            config.kernel.tau_rise_s
        };

        let cell_tau_decay = if var.tau_decay_cv > 0.0 {
            config.kernel.tau_decay_s * (var.tau_decay_cv * rng.gaussian()).exp()
        } else {
            config.kernel.tau_decay_s
        };

        let cell_snr = if var.snr_spread > 0.0 {
            let u = rng.next_f64() * 2.0 - 1.0;
            (config.noise.snr + u * var.snr_spread).max(1.0)
        } else {
            config.noise.snr
        };

        // 2. Generate spike train (reuses high_res_buf)
        let spikes = generate_spikes(
            &config.spike_model, n_tp, config.fs_hz, config.spike_sim_hz,
            &mut rng, &mut high_res_buf,
        );

        // 3. Convolve with kernel
        let kernel = shared_kernel.as_deref().unwrap_or_else(||
            // Leak avoided: this branch only runs when has_kernel_variation is true
            &[]
        );
        let per_cell_kernel;
        let kernel_ref = if has_kernel_variation {
            per_cell_kernel = build_kernel(cell_tau_rise, cell_tau_decay, config.fs_hz);
            &per_cell_kernel
        } else {
            kernel
        };
        let mut clean_calcium = convolve_spikes(&spikes, kernel_ref, n_tp);

        // 4. Scale by alpha
        for v in clean_calcium.iter_mut() {
            *v *= alpha as f32;
        }

        // 5. Apply indicator saturation (optional)
        if config.saturation.enabled {
            apply_saturation(&mut clean_calcium, &config.saturation);
        }

        // Find peak of clean signal (needed for noise/drift scaling)
        let signal_max = clean_calcium.iter().cloned().fold(0.0_f32, f32::max) as f64;

        // 6. Build observed trace in f64 (precision for drift/noise calculations)
        let mut trace: Vec<f64> = clean_calcium.iter().map(|&c| c as f64).collect();

        add_drift(&mut trace, &config.drift, signal_max, n_tp, &mut rng);

        // 7. Apply photobleaching (multiplicative)
        if config.photobleaching.enabled {
            apply_photobleaching(&mut trace, &config.photobleaching, config.fs_hz);
        }

        // 8. Add noise
        add_noise(&mut trace, &config.noise, cell_snr, signal_max, &mut rng);

        // Store results
        traces.extend(trace.iter().map(|&v| v as f32));

        ground_truth.push(CellGroundTruth {
            spikes,
            clean_calcium,
            alpha,
            snr: cell_snr,
            tau_rise_s: cell_tau_rise,
            tau_decay_s: cell_tau_decay,
        });
    }

    SimulationResult { traces, num_cells: n_cells, num_timepoints: n_tp, ground_truth }
}

// ── Spike generation ─────────────────────────────────────────────

fn generate_spikes(
    model: &SpikeModel,
    num_timepoints: usize,
    fs_hz: f64,
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
    high_res_buf: &mut [u8],
) -> Vec<f32> {
    let bins_per_frame = (spike_sim_hz / fs_hz).round() as usize;
    let num_high_res = num_timepoints * bins_per_frame;

    // Zero the reusable buffer
    high_res_buf[..num_high_res].fill(0);
    let buf = &mut high_res_buf[..num_high_res];

    match model {
        SpikeModel::Markov(cfg) => fill_markov_spikes(cfg, buf, bins_per_frame, rng),
        SpikeModel::Poisson(cfg) => fill_poisson_spikes(cfg, buf, spike_sim_hz, rng),
    }

    // Bin high-res spikes to imaging rate
    bin_to_imaging_rate(buf, num_timepoints, bins_per_frame)
}

/// Fill high-res buffer with Markov HMM spikes.
/// Attribution: CaLab web simulator (`packages/compute/src/mock-traces.ts`).
fn fill_markov_spikes(
    cfg: &MarkovConfig,
    buf: &mut [u8],
    bins_per_frame: usize,
    rng: &mut Xorshift32,
) {
    // Scale per-frame transition probabilities to high-res timestep
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
        if rng.next_f64() < p_spike {
            *spike = 1;
        }
    }
}

/// Fill high-res buffer with Poisson spikes.
/// Attribution: OASIS (Friedrich et al., 2017), CaImAn (Giovannucci et al., 2019).
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

/// Bin high-resolution binary spikes to imaging-rate spike counts.
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

/// Time-domain convolution of spike train with kernel.
fn convolve_spikes(spikes: &[f32], kernel: &[f32], n: usize) -> Vec<f32> {
    let k_len = kernel.len();
    let mut clean = vec![0.0_f32; n];
    for t in 0..n {
        let j_max = k_len.min(t + 1);
        let mut sum = 0.0_f32;
        for k in 0..j_max {
            sum += spikes[t - k] * kernel[k];
        }
        clean[t] = sum;
    }
    clean
}

// ── Saturation ───────────────────────────────────────────────────

/// Apply Hill equation indicator saturation in-place.
/// Attribution: MLspike (Deneux et al., 2016).
fn apply_saturation(signal: &mut [f32], cfg: &SaturationConfig) {
    let n = cfg.hill_coefficient;
    let kd_n = cfg.k_d.powf(n);
    for v in signal.iter_mut() {
        let f = (*v as f64).max(0.0);
        let f_n = f.powf(n);
        *v = (f_n / (f_n + kd_n)) as f32;
    }
}

// ── Drift ────────────────────────────────────────────────────────

fn add_drift(
    trace: &mut [f64],
    model: &DriftModel,
    signal_max: f64,
    n: usize,
    rng: &mut Xorshift32,
) {
    match model {
        DriftModel::Sinusoidal(cfg) => {
            if cfg.amplitude_fraction <= 0.0 || signal_max <= 0.0 {
                return;
            }
            let cycles = cfg.cycles_min + rng.next_f64() * (cfg.cycles_max - cfg.cycles_min);
            let period = n as f64 / cycles;
            let amp = cfg.amplitude_fraction * signal_max;
            let two_pi = 2.0 * std::f64::consts::PI;
            for i in 0..n {
                trace[i] += amp * (two_pi * i as f64 / period).sin();
            }
        }
        DriftModel::RandomWalk(cfg) => {
            if cfg.step_std_fraction <= 0.0 || signal_max <= 0.0 {
                return;
            }
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

/// Attribution: NAOMi (Charles et al., 2019).
fn apply_photobleaching(trace: &mut [f64], cfg: &PhotobleachingConfig, fs_hz: f64) {
    let tau = cfg.decay_time_constant_s;
    let amp = cfg.amplitude_fraction;
    for (i, v) in trace.iter_mut().enumerate() {
        let t = i as f64 / fs_hz;
        *v *= 1.0 - amp * (1.0 - (-t / tau).exp());
    }
}

// ── Noise ────────────────────────────────────────────────────────

/// Attribution: Gaussian from CaLab web simulator; shot noise from CASCADE (Rupprecht et al., 2021).
fn add_noise(
    trace: &mut [f64],
    cfg: &NoiseConfig,
    cell_snr: f64,
    signal_max: f64,
    rng: &mut Xorshift32,
) {
    if cell_snr <= 0.0 || signal_max <= 0.0 {
        return;
    }

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
        for v in trace.iter_mut() {
            *v += noise_std * rng.gaussian();
        }
    }
}

/// Poisson random variate via Knuth's algorithm (small lambda) or Gaussian approximation.
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

pub mod presets {
    use super::*;

    /// GCaMP6f at 30 Hz. Chen et al., 2013, Nature.
    pub fn gcamp6f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6 },
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// GCaMP6s at 30 Hz. Chen et al., 2013, Nature.
    pub fn gcamp6s() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.4, tau_decay_s: 1.8 },
            noise: NoiseConfig { snr: 25.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// GCaMP6m at 30 Hz. Chen et al., 2013, Nature.
    pub fn gcamp6m() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.15, tau_decay_s: 0.9 },
            noise: NoiseConfig { snr: 22.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// jGCaMP8f at 30 Hz. Zhang et al., 2023, Nature.
    pub fn jgcamp8f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 0.3 },
            noise: NoiseConfig { snr: 12.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// OGB-1 at 30 Hz. Stosiek et al., 2003.
    pub fn ogb1() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 1.5 },
            noise: NoiseConfig { snr: 15.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// Near-ideal traces for algorithm debugging.
    pub fn clean() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6 },
            noise: NoiseConfig { snr: 200.0, ..Default::default() },
            drift: DriftModel::Sinusoidal(SinusoidalDrift {
                amplitude_fraction: 0.0, cycles_min: 1.0, cycles_max: 1.0,
            }),
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
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
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn determinism_same_seed_same_output() {
        let cfg = small_config();
        let r1 = simulate(&cfg);
        let r2 = simulate(&cfg);
        assert_eq!(r1.traces, r2.traces);
    }

    #[test]
    fn correct_output_shape() {
        let cfg = small_config();
        let result = simulate(&cfg);
        assert_eq!(result.traces.len(), cfg.num_cells * cfg.num_timepoints);
        assert_eq!(result.ground_truth.len(), cfg.num_cells);
        for gt in &result.ground_truth {
            assert_eq!(gt.spikes.len(), cfg.num_timepoints);
            assert_eq!(gt.clean_calcium.len(), cfg.num_timepoints);
        }
    }

    #[test]
    fn spikes_are_non_negative() {
        let result = simulate(&small_config());
        for gt in &result.ground_truth {
            assert!(gt.spikes.iter().all(|&s| s >= 0.0));
        }
    }

    #[test]
    fn clean_calcium_is_non_negative() {
        let result = simulate(&small_config());
        for gt in &result.ground_truth {
            assert!(gt.clean_calcium.iter().all(|&c| c >= -1e-6));
        }
    }

    #[test]
    fn markov_produces_spikes() {
        let cfg = SimulationConfig {
            num_timepoints: 9000, num_cells: 1,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let total: f32 = simulate(&cfg).ground_truth[0].spikes.iter().sum();
        assert!(total > 0.0);
    }

    #[test]
    fn poisson_mean_rate() {
        let cfg = SimulationConfig {
            num_timepoints: 30000, num_cells: 1,
            spike_model: SpikeModel::Poisson(PoissonConfig { rate_hz: 2.0 }),
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let total: f32 = simulate(&cfg).ground_truth[0].spikes.iter().sum();
        let rate = total as f64 / (30000.0 / 30.0);
        assert!((rate - 2.0).abs() < 1.0, "Expected ~2.0 Hz, got {rate:.2}");
    }

    #[test]
    fn snr_approximately_correct() {
        let cfg = SimulationConfig {
            num_timepoints: 9000, num_cells: 1,
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let gt = &result.ground_truth[0];
        let n = cfg.num_timepoints;
        let signal_max = gt.clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        if signal_max < 1e-6 { return; }

        let trace = &result.traces[0..n];
        let mut sum_sq = 0.0_f64;
        let mut count = 0;
        for i in 0..n {
            if gt.clean_calcium[i] < 0.01 * signal_max {
                let r = trace[i] as f64 - gt.clean_calcium[i] as f64;
                sum_sq += r * r;
                count += 1;
            }
        }
        if count > 100 {
            let measured_snr = signal_max as f64 / (sum_sq / count as f64).sqrt();
            assert!(measured_snr > 10.0 && measured_snr < 40.0, "SNR ~20, got {measured_snr:.1}");
        }
    }

    #[test]
    fn alpha_variation_produces_spread() {
        let cfg = SimulationConfig {
            num_timepoints: 900, num_cells: 50,
            cell_variation: CellVariationConfig { alpha_mean: 1.0, alpha_cv: 0.3, ..Default::default() },
            ..Default::default()
        };
        let alphas: Vec<f64> = simulate(&cfg).ground_truth.iter().map(|gt| gt.alpha).collect();
        let mean = alphas.iter().sum::<f64>() / alphas.len() as f64;
        let var = alphas.iter().map(|a| (a - mean).powi(2)).sum::<f64>() / alphas.len() as f64;
        let cv = var.sqrt() / mean;
        assert!(cv > 0.1 && cv < 0.6, "Alpha CV ~0.3, got {cv:.3}");
    }

    #[test]
    fn kernel_variation_produces_spread() {
        let cfg = SimulationConfig {
            num_timepoints: 900, num_cells: 50,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, tau_decay_cv: 0.15, ..Default::default() },
            ..Default::default()
        };
        let taus: Vec<f64> = simulate(&cfg).ground_truth.iter().map(|gt| gt.tau_decay_s).collect();
        let mean = taus.iter().sum::<f64>() / taus.len() as f64;
        let min = taus.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = taus.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(max > mean * 1.05 && min < mean * 0.95,
            "Spread too narrow: min={min:.4}, mean={mean:.4}, max={max:.4}");
    }

    #[test]
    fn photobleaching_decreases_signal() {
        let base = SimulationConfig {
            num_timepoints: 9000, num_cells: 1,
            noise: NoiseConfig { snr: 200.0, ..Default::default() },
            drift: DriftModel::Sinusoidal(SinusoidalDrift { amplitude_fraction: 0.0, ..Default::default() }),
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let r_no = simulate(&SimulationConfig { photobleaching: PhotobleachingConfig { enabled: false, ..Default::default() }, ..base.clone() });
        let r_yes = simulate(&SimulationConfig { photobleaching: PhotobleachingConfig { enabled: true, decay_time_constant_s: 30.0, amplitude_fraction: 0.3 }, ..base });
        let n = 9000;
        let last = n - n / 10;
        let frac_lower = (last..n).filter(|&i| r_yes.traces[i] < r_no.traces[i]).count() as f64 / (n - last) as f64;
        assert!(frac_lower > 0.8, "Bleached should be lower in >80%, got {:.1}%", frac_lower * 100.0);
    }

    #[test]
    fn saturation_compresses_signal() {
        let base = SimulationConfig {
            num_timepoints: 900, num_cells: 1,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let r_lin = simulate(&SimulationConfig { saturation: SaturationConfig { enabled: false, ..Default::default() }, ..base.clone() });
        let r_sat = simulate(&SimulationConfig { saturation: SaturationConfig { enabled: true, hill_coefficient: 1.0, k_d: 0.5 }, ..base });
        let max_lin = r_lin.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        let max_sat = r_sat.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        assert!(max_sat < max_lin || max_lin < 1e-6, "sat_max={max_sat:.4} should be < lin_max={max_lin:.4}");
    }

    #[test]
    fn presets_produce_valid_configs() {
        for (name, cfg) in presets::all() {
            assert!(cfg.fs_hz > 0.0 && cfg.kernel.tau_rise_s > 0.0 && cfg.kernel.tau_decay_s > 0.0 && cfg.noise.snr > 0.0, "Preset {name} invalid");
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
    fn ground_truth_fields_populated() {
        let result = simulate(&small_config());
        for gt in &result.ground_truth {
            assert!(gt.alpha > 0.0 && gt.snr > 0.0 && gt.tau_rise_s > 0.0 && gt.tau_decay_s > 0.0);
        }
    }

    #[test]
    fn single_cell_single_timepoint() {
        let result = simulate(&SimulationConfig {
            num_timepoints: 1, num_cells: 1,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        });
        assert_eq!(result.traces.len(), 1);
        assert_eq!(result.ground_truth.len(), 1);
    }

    #[cfg(feature = "serde")]
    #[test]
    fn config_serde_roundtrip() {
        let cfg = SimulationConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let cfg2: SimulationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg.fs_hz, cfg2.fs_hz);
        assert_eq!(cfg.num_cells, cfg2.num_cells);
        assert_eq!(cfg.seed, cfg2.seed);
    }
}
