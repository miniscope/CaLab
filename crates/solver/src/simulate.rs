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
//!   6. Add baseline + drift
//!   7. Apply photobleaching (optional, multiplicative)
//!   8. Add noise (Gaussian + optional Poisson shot noise)

use crate::kernel::build_kernel;

// ── Conditional serde ────────────────────────────────────────────
// Both jsbindings and pybindings features include serde.
macro_rules! serde_derive {
    ($(#[$meta:meta])* $vis:vis struct $name:ident { $($body:tt)* }) => {
        #[derive(Clone, Debug)]
        #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
        $(#[$meta])*
        $vis struct $name { $($body)* }
    };
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($body:tt)* }) => {
        #[derive(Clone, Debug)]
        #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
        $(#[$meta])*
        $vis enum $name { $($body)* }
    };
}

// ── PRNG ─────────────────────────────────────────────────────────

/// xorshift32 PRNG — deterministic across WASM and native targets.
///
/// Attribution: ported from CaLab web simulator
/// (`packages/compute/src/mock-traces.ts`). Same seed produces
/// bit-identical sequences in Rust, WASM, and the original TypeScript.
#[derive(Clone)]
struct Xorshift32 {
    state: u32,
}

impl Xorshift32 {
    fn new(seed: u32) -> Self {
        // Match TypeScript: `seed | 0 || 1` — zero seed becomes 1.
        let state = if seed == 0 { 1 } else { seed };
        Self { state }
    }

    /// Advance state and return raw u32.
    #[inline]
    fn next_u32(&mut self) -> u32 {
        // Must match TypeScript xorshift32 exactly for cross-platform determinism.
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        self.state
    }

    /// Uniform float in [0, 1). Matches TypeScript: `(s >>> 0) / 4294967296`.
    #[inline]
    fn next_f64(&mut self) -> f64 {
        (self.next_u32() as f64) / 4_294_967_296.0
    }

    /// Standard normal via Box-Muller transform.
    /// Matches TypeScript implementation in mock-traces.ts.
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

serde_derive! {
    /// Two-state HMM spike generator (silent/active) with bursty firing.
    ///
    /// Attribution: CaLab web simulator Markov spike model.
    /// Transition probabilities are specified per imaging frame and internally
    /// rescaled to the high-resolution simulation rate (spike_sim_hz).
    pub struct MarkovConfig {
        /// Silent→active transition probability per imaging frame.
        /// Controls burst frequency. Higher = more frequent bursts.
        /// Units: probability per frame. Default: 0.01.
        #[cfg_attr(feature = "serde", serde(default = "default_p_s2a"))]
        pub p_silent_to_active: f64,

        /// Active→silent transition probability per imaging frame.
        /// Controls burst duration. Higher = shorter bursts.
        /// Units: probability per frame. Default: 0.2.
        #[cfg_attr(feature = "serde", serde(default = "default_p_a2s"))]
        pub p_active_to_silent: f64,

        /// Spike probability per high-resolution timestep when in active state.
        /// Units: probability per step at spike_sim_hz. Default: 0.7.
        #[cfg_attr(feature = "serde", serde(default = "default_p_spike_active"))]
        pub p_spike_when_active: f64,

        /// Spike probability per high-resolution timestep when in silent state.
        /// Controls sparse background firing.
        /// Units: probability per step at spike_sim_hz. Default: 0.005.
        #[cfg_attr(feature = "serde", serde(default = "default_p_spike_silent"))]
        pub p_spike_when_silent: f64,
    }
}

fn default_p_s2a() -> f64 { 0.01 }
fn default_p_a2s() -> f64 { 0.2 }
fn default_p_spike_active() -> f64 { 0.7 }
fn default_p_spike_silent() -> f64 { 0.005 }

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

serde_derive! {
    /// Homogeneous Poisson spike generator.
    ///
    /// Attribution: standard model used in OASIS (Friedrich et al., 2017)
    /// and CaImAn (Giovannucci et al., 2019).
    pub struct PoissonConfig {
        /// Mean firing rate. Units: Hz (spikes per second). Default: 1.0.
        #[cfg_attr(feature = "serde", serde(default = "default_rate_hz"))]
        pub rate_hz: f64,
    }
}

fn default_rate_hz() -> f64 { 1.0 }

impl Default for PoissonConfig {
    fn default() -> Self {
        Self { rate_hz: 1.0 }
    }
}

serde_derive! {
    /// Spike train generation model.
    #[cfg_attr(feature = "serde", serde(tag = "model_type"))]
    pub enum SpikeModel {
        /// Two-state HMM with bursty firing patterns.
        #[cfg_attr(feature = "serde", serde(rename = "markov"))]
        Markov(MarkovConfig),
        /// Homogeneous Poisson process.
        #[cfg_attr(feature = "serde", serde(rename = "poisson"))]
        Poisson(PoissonConfig),
    }
}

impl Default for SpikeModel {
    fn default() -> Self {
        Self::Markov(MarkovConfig::default())
    }
}

serde_derive! {
    /// Double-exponential kernel parameters: h(t) = exp(-t/tau_decay) - exp(-t/tau_rise).
    ///
    /// Attribution: standard calcium response model used in CaImAn, OASIS, Suite2p,
    /// and the CaLab web simulator.
    pub struct KernelConfig {
        /// Rise time constant. Units: seconds. Default: 0.1.
        #[cfg_attr(feature = "serde", serde(default = "default_tau_rise"))]
        pub tau_rise_s: f64,
        /// Decay time constant. Units: seconds. Default: 0.6.
        #[cfg_attr(feature = "serde", serde(default = "default_tau_decay"))]
        pub tau_decay_s: f64,
    }
}

fn default_tau_rise() -> f64 { 0.1 }
fn default_tau_decay() -> f64 { 0.6 }

impl Default for KernelConfig {
    fn default() -> Self {
        Self { tau_rise_s: 0.1, tau_decay_s: 0.6 }
    }
}

serde_derive! {
    /// Noise model: Gaussian + optional Poisson (shot) noise.
    ///
    /// Attribution: Gaussian noise from CaLab web simulator.
    /// Shot noise model from CASCADE (Rupprecht et al., 2021).
    pub struct NoiseConfig {
        /// Signal-to-noise ratio: peak_signal / noise_std.
        /// Higher = cleaner traces. Units: dimensionless ratio. Default: 8.0.
        #[cfg_attr(feature = "serde", serde(default = "default_snr"))]
        pub snr: f64,

        /// Enable Poisson (shot) noise in addition to Gaussian.
        /// Models photon counting noise in fluorescence microscopy.
        /// Attribution: CASCADE (Rupprecht et al., 2021).
        /// Default: false.
        #[cfg_attr(feature = "serde", serde(default))]
        pub shot_noise_enabled: bool,

        /// Fraction of total noise variance from shot noise (0..1).
        /// Only used when shot_noise_enabled = true.
        /// Units: dimensionless fraction. Default: 0.3.
        #[cfg_attr(feature = "serde", serde(default = "default_shot_fraction"))]
        pub shot_noise_fraction: f64,
    }
}

fn default_snr() -> f64 { 8.0 }
fn default_shot_fraction() -> f64 { 0.3 }

impl Default for NoiseConfig {
    fn default() -> Self {
        Self { snr: 8.0, shot_noise_enabled: false, shot_noise_fraction: 0.3 }
    }
}

serde_derive! {
    /// Slow sinusoidal baseline drift.
    ///
    /// Attribution: CaLab web simulator.
    pub struct SinusoidalDrift {
        /// Drift amplitude as fraction of peak signal (0 = no drift).
        /// Units: dimensionless fraction. Default: 0.1.
        #[cfg_attr(feature = "serde", serde(default = "default_drift_amp"))]
        pub amplitude_fraction: f64,
        /// Minimum number of drift cycles over the trace duration.
        /// Units: count. Default: 2.0.
        #[cfg_attr(feature = "serde", serde(default = "default_cycles_min"))]
        pub cycles_min: f64,
        /// Maximum number of drift cycles over the trace duration.
        /// Units: count. Default: 4.0.
        #[cfg_attr(feature = "serde", serde(default = "default_cycles_max"))]
        pub cycles_max: f64,
    }
}

fn default_drift_amp() -> f64 { 0.1 }
fn default_cycles_min() -> f64 { 2.0 }
fn default_cycles_max() -> f64 { 4.0 }

impl Default for SinusoidalDrift {
    fn default() -> Self {
        Self { amplitude_fraction: 0.1, cycles_min: 2.0, cycles_max: 4.0 }
    }
}

serde_derive! {
    /// Gaussian random walk baseline drift with optional mean reversion.
    ///
    /// Attribution: MLspike (Deneux et al., 2016).
    pub struct RandomWalkDrift {
        /// Standard deviation of drift step per frame, as fraction of peak signal.
        /// Units: dimensionless (fraction per frame). Default: 0.002.
        #[cfg_attr(feature = "serde", serde(default = "default_step_std"))]
        pub step_std_fraction: f64,
        /// Mean-reversion rate (0 = pure random walk, 1 = fully pulled back each frame).
        /// Units: dimensionless. Default: 0.001.
        #[cfg_attr(feature = "serde", serde(default = "default_mean_reversion"))]
        pub mean_reversion: f64,
    }
}

fn default_step_std() -> f64 { 0.002 }
fn default_mean_reversion() -> f64 { 0.001 }

impl Default for RandomWalkDrift {
    fn default() -> Self {
        Self { step_std_fraction: 0.002, mean_reversion: 0.001 }
    }
}

serde_derive! {
    /// Baseline drift model.
    #[cfg_attr(feature = "serde", serde(tag = "model_type"))]
    pub enum DriftModel {
        /// Slow sinusoidal drift. Attribution: CaLab web simulator.
        #[cfg_attr(feature = "serde", serde(rename = "sinusoidal"))]
        Sinusoidal(SinusoidalDrift),
        /// Gaussian random walk. Attribution: MLspike (Deneux et al., 2016).
        #[cfg_attr(feature = "serde", serde(rename = "random_walk"))]
        RandomWalk(RandomWalkDrift),
    }
}

impl Default for DriftModel {
    fn default() -> Self {
        Self::Sinusoidal(SinusoidalDrift::default())
    }
}

serde_derive! {
    /// Exponential photobleaching: multiplicative decay of fluorescence.
    ///
    /// F_bleach(t) = 1 - amplitude_fraction * (1 - exp(-t / decay_time_constant_s))
    /// At t=0: F=1 (no bleaching). As t→∞: F → 1 - amplitude_fraction.
    ///
    /// Attribution: NAOMi (Charles et al., 2019) exponential bleaching model.
    pub struct PhotobleachingConfig {
        /// Whether to apply photobleaching. Default: false.
        #[cfg_attr(feature = "serde", serde(default))]
        pub enabled: bool,
        /// Time constant of bleaching decay. Units: seconds. Default: 600.0 (10 minutes).
        #[cfg_attr(feature = "serde", serde(default = "default_bleach_tau"))]
        pub decay_time_constant_s: f64,
        /// Maximum fractional signal loss at t→∞.
        /// Units: dimensionless fraction (0..1). Default: 0.15.
        #[cfg_attr(feature = "serde", serde(default = "default_bleach_amp"))]
        pub amplitude_fraction: f64,
    }
}

fn default_bleach_tau() -> f64 { 600.0 }
fn default_bleach_amp() -> f64 { 0.15 }

impl Default for PhotobleachingConfig {
    fn default() -> Self {
        Self { enabled: false, decay_time_constant_s: 600.0, amplitude_fraction: 0.15 }
    }
}

serde_derive! {
    /// Indicator saturation via Hill equation.
    ///
    /// F_saturated = F^n / (F^n + K_d^n)
    /// Models the nonlinear calcium-to-fluorescence response at high [Ca2+].
    ///
    /// Attribution: MLspike (Deneux et al., 2016) Hill saturation model.
    pub struct SaturationConfig {
        /// Whether to apply indicator saturation. Default: false.
        #[cfg_attr(feature = "serde", serde(default))]
        pub enabled: bool,
        /// Hill coefficient (cooperativity). n=1 non-cooperative, n>1 cooperative.
        /// Units: dimensionless. Default: 1.0.
        #[cfg_attr(feature = "serde", serde(default = "default_hill_n"))]
        pub hill_coefficient: f64,
        /// Half-saturation level: signal at 50% of max response.
        /// Units: same as clean signal amplitude. Default: 5.0.
        #[cfg_attr(feature = "serde", serde(default = "default_k_d"))]
        pub k_d: f64,
    }
}

fn default_hill_n() -> f64 { 1.0 }
fn default_k_d() -> f64 { 5.0 }

impl Default for SaturationConfig {
    fn default() -> Self {
        Self { enabled: false, hill_coefficient: 1.0, k_d: 5.0 }
    }
}

serde_derive! {
    /// Per-cell parameter variation for multi-cell simulations.
    ///
    /// Tests CaDecon's assumptions: single-kernel across all cells and
    /// per-cell amplitude (alpha) estimation.
    pub struct CellVariationConfig {
        /// Mean per-cell amplitude scaling factor.
        /// Each cell's alpha is drawn from LogNormal(ln(alpha_mean), alpha_cv).
        /// CaDecon's alpha term accounts for this variation.
        /// Units: dimensionless. Default: 1.0.
        #[cfg_attr(feature = "serde", serde(default = "default_alpha_mean"))]
        pub alpha_mean: f64,

        /// Coefficient of variation for alpha distribution (std/mean).
        /// 0 = all cells have identical alpha. 0.3 = moderate variation.
        /// Units: dimensionless. Default: 0.3.
        #[cfg_attr(feature = "serde", serde(default = "default_alpha_cv"))]
        pub alpha_cv: f64,

        /// Relative spread of tau_rise across cells (log-space CV).
        /// Each cell's tau_rise = nominal * exp(N(0, tau_rise_cv)).
        /// 0 = all cells share the same kernel rise time.
        /// Non-zero values test CaDecon's single-kernel assumption.
        /// Units: dimensionless. Default: 0.0.
        #[cfg_attr(feature = "serde", serde(default))]
        pub tau_rise_cv: f64,

        /// Relative spread of tau_decay across cells (log-space CV).
        /// Each cell's tau_decay = nominal * exp(N(0, tau_decay_cv)).
        /// 0 = all cells share the same kernel decay time.
        /// Non-zero values test CaDecon's single-kernel assumption.
        /// Units: dimensionless. Default: 0.0.
        #[cfg_attr(feature = "serde", serde(default))]
        pub tau_decay_cv: f64,

        /// Additive SNR spread: each cell's SNR = nominal + Uniform(-spread, +spread).
        /// 0 = all cells have the same SNR.
        /// Units: same as SNR (dimensionless ratio). Default: 0.0.
        #[cfg_attr(feature = "serde", serde(default))]
        pub snr_spread: f64,
    }
}

fn default_alpha_mean() -> f64 { 1.0 }
fn default_alpha_cv() -> f64 { 0.3 }

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

serde_derive! {
    /// Complete configuration for synthetic calcium trace generation.
    ///
    /// Every parameter has physical units and intuitive meaning.
    /// Default values produce a reasonable GCaMP6f-like simulation.
    pub struct SimulationConfig {
        /// Sampling rate of the output traces. Units: Hz. Default: 30.0.
        #[cfg_attr(feature = "serde", serde(default = "default_fs"))]
        pub fs_hz: f64,

        /// Number of timepoints per trace. Units: count. Default: 27000 (15 min at 30 Hz).
        #[cfg_attr(feature = "serde", serde(default = "default_num_timepoints"))]
        pub num_timepoints: usize,

        /// Number of cells to simulate. Units: count. Default: 100.
        #[cfg_attr(feature = "serde", serde(default = "default_num_cells"))]
        pub num_cells: usize,

        /// Nominal kernel parameters (population mean).
        #[cfg_attr(feature = "serde", serde(default))]
        pub kernel: KernelConfig,

        /// Spike generation model.
        #[cfg_attr(feature = "serde", serde(default))]
        pub spike_model: SpikeModel,

        /// Noise model.
        #[cfg_attr(feature = "serde", serde(default))]
        pub noise: NoiseConfig,

        /// Baseline drift model.
        #[cfg_attr(feature = "serde", serde(default))]
        pub drift: DriftModel,

        /// Photobleaching (optional, multiplicative).
        #[cfg_attr(feature = "serde", serde(default))]
        pub photobleaching: PhotobleachingConfig,

        /// Indicator saturation (optional, Hill equation).
        #[cfg_attr(feature = "serde", serde(default))]
        pub saturation: SaturationConfig,

        /// Per-cell parameter variation (alpha, kernel, SNR).
        #[cfg_attr(feature = "serde", serde(default))]
        pub cell_variation: CellVariationConfig,

        /// RNG seed for reproducibility. Default: 42.
        #[cfg_attr(feature = "serde", serde(default = "default_seed"))]
        pub seed: u32,

        /// Internal spike simulation rate. Higher = finer spike timing.
        /// Units: Hz. Default: 300.0 (~3.3ms resolution).
        #[cfg_attr(feature = "serde", serde(default = "default_spike_sim_hz"))]
        pub spike_sim_hz: f64,
    }
}

fn default_fs() -> f64 { 30.0 }
fn default_num_timepoints() -> usize { 27000 }
fn default_num_cells() -> usize { 100 }
fn default_seed() -> u32 { 42 }
fn default_spike_sim_hz() -> f64 { 300.0 }

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

serde_derive! {
    /// Ground truth for a single simulated cell.
    pub struct CellGroundTruth {
        /// Spike counts at imaging rate (one value per timepoint).
        pub spikes: Vec<f32>,
        /// Clean calcium signal: kernel * spikes, before noise/drift/bleaching.
        pub clean_calcium: Vec<f32>,
        /// Amplitude scaling factor for this cell.
        pub alpha: f64,
        /// Baseline fluorescence level (before drift).
        pub baseline: f64,
        /// Actual SNR for this cell (may differ from nominal if snr_spread > 0).
        pub snr: f64,
        /// Actual rise time constant for this cell (seconds).
        pub tau_rise_s: f64,
        /// Actual decay time constant for this cell (seconds).
        pub tau_decay_s: f64,
    }
}

serde_derive! {
    /// Complete simulation result with observed traces and per-cell ground truth.
    pub struct SimulationResult {
        /// Observed (noisy) fluorescence traces. Row-major: [num_cells * num_timepoints].
        pub traces: Vec<f32>,
        /// Number of cells.
        pub num_cells: usize,
        /// Number of timepoints per trace.
        pub num_timepoints: usize,
        /// Per-cell ground truth.
        pub ground_truth: Vec<CellGroundTruth>,
    }
}

// ── Core simulation ──────────────────────────────────────────────

/// Generate synthetic calcium imaging traces with full ground truth.
///
/// See module-level docs for the per-cell pipeline.
pub fn simulate(config: &SimulationConfig) -> SimulationResult {
    let n_cells = config.num_cells;
    let n_tp = config.num_timepoints;
    let mut traces = Vec::with_capacity(n_cells * n_tp);
    let mut ground_truth = Vec::with_capacity(n_cells);

    for cell_idx in 0..n_cells {
        // Per-cell seed: prime offset for independence.
        // Attribution: CaLab web simulator convention (seed + idx * 7919).
        let cell_seed = config.seed.wrapping_add((cell_idx as u32).wrapping_mul(7919));
        let mut rng = Xorshift32::new(cell_seed);

        // 1. Draw per-cell parameters
        let var = &config.cell_variation;

        let alpha = if var.alpha_cv > 0.0 {
            // LogNormal: mean = alpha_mean, cv = alpha_cv
            // sigma^2 = ln(1 + cv^2), mu = ln(mean) - sigma^2/2
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
            let u = rng.next_f64() * 2.0 - 1.0; // Uniform(-1, 1)
            (config.noise.snr + u * var.snr_spread).max(1.0) // floor at 1.0
        } else {
            config.noise.snr
        };

        // 2. Generate spike train
        let spikes = generate_spikes(&config.spike_model, n_tp, config.fs_hz, config.spike_sim_hz, &mut rng);

        // 3. Convolve with per-cell kernel (reuses existing build_kernel)
        let kernel = build_kernel(cell_tau_rise, cell_tau_decay, config.fs_hz);
        let mut clean_calcium = convolve_spikes(&spikes, &kernel, n_tp);

        // 4. Scale by alpha
        for v in clean_calcium.iter_mut() {
            *v *= alpha as f32;
        }

        // 5. Apply indicator saturation (optional)
        if config.saturation.enabled {
            apply_saturation(&mut clean_calcium, &config.saturation);
        }

        // Find peak of clean signal (needed for noise/drift scaling)
        let signal_max = clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        let signal_max_f64 = signal_max as f64;

        // 6. Build observed trace: start from clean calcium
        let mut trace = vec![0.0_f64; n_tp];
        for (i, &c) in clean_calcium.iter().enumerate() {
            trace[i] = c as f64;
        }

        // Add baseline + drift
        let baseline = 0.0_f64; // baseline is implicit in the drift
        add_drift(&mut trace, &config.drift, signal_max_f64, n_tp, &mut rng);

        // 7. Apply photobleaching (multiplicative)
        if config.photobleaching.enabled {
            apply_photobleaching(&mut trace, &config.photobleaching, config.fs_hz);
        }

        // 8. Add noise
        add_noise(&mut trace, &config.noise, cell_snr, signal_max_f64, &mut rng);

        // Store results
        for &v in trace.iter() {
            traces.push(v as f32);
        }

        ground_truth.push(CellGroundTruth {
            spikes,
            clean_calcium,
            alpha,
            baseline,
            snr: cell_snr,
            tau_rise_s: cell_tau_rise,
            tau_decay_s: cell_tau_decay,
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

fn generate_spikes(
    model: &SpikeModel,
    num_timepoints: usize,
    fs_hz: f64,
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
) -> Vec<f32> {
    match model {
        SpikeModel::Markov(cfg) => generate_markov_spikes(cfg, num_timepoints, fs_hz, spike_sim_hz, rng),
        SpikeModel::Poisson(cfg) => generate_poisson_spikes(cfg, num_timepoints, fs_hz, spike_sim_hz, rng),
    }
}

/// Two-state Markov chain spike generation.
///
/// Attribution: CaLab web simulator (`packages/compute/src/mock-traces.ts`).
/// Generates high-resolution binary spikes at spike_sim_hz, then bins to fs_hz.
fn generate_markov_spikes(
    cfg: &MarkovConfig,
    num_timepoints: usize,
    fs_hz: f64,
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
) -> Vec<f32> {
    let bins_per_frame = (spike_sim_hz / fs_hz).round() as usize;
    let num_high_res = num_timepoints * bins_per_frame;

    // Scale per-frame transition probabilities to high-res timestep.
    // p_scaled = 1 - (1 - p_frame)^(1/bins_per_frame)
    // Attribution: CaLab web simulator rescaling logic.
    let p_s2a = 1.0 - (1.0 - cfg.p_silent_to_active).powf(1.0 / bins_per_frame as f64);
    let p_a2s = 1.0 - (1.0 - cfg.p_active_to_silent).powf(1.0 / bins_per_frame as f64);

    // Generate binary spike train at high resolution
    let mut high_res_spikes = vec![0u8; num_high_res];
    let mut state = 0u8; // 0 = silent, 1 = active

    for i in 0..num_high_res {
        // State transition
        if state == 0 {
            if rng.next_f64() < p_s2a {
                state = 1;
            }
        } else if rng.next_f64() < p_a2s {
            state = 0;
        }

        // Spike emission
        let p_spike = if state == 1 { cfg.p_spike_when_active } else { cfg.p_spike_when_silent };
        if rng.next_f64() < p_spike {
            high_res_spikes[i] = 1;
        }
    }

    // Bin to imaging rate: count spikes per frame
    let mut spikes = vec![0.0_f32; num_timepoints];
    for f in 0..num_timepoints {
        let start = f * bins_per_frame;
        let end = (start + bins_per_frame).min(num_high_res);
        let mut count = 0u32;
        for j in start..end {
            count += high_res_spikes[j] as u32;
        }
        if count > 0 {
            spikes[f] = count as f32;
        }
    }

    spikes
}

/// Homogeneous Poisson spike generation.
///
/// Attribution: standard model used in OASIS (Friedrich et al., 2017)
/// and CaImAn (Giovannucci et al., 2019).
fn generate_poisson_spikes(
    cfg: &PoissonConfig,
    num_timepoints: usize,
    fs_hz: f64,
    spike_sim_hz: f64,
    rng: &mut Xorshift32,
) -> Vec<f32> {
    let bins_per_frame = (spike_sim_hz / fs_hz).round() as usize;
    let num_high_res = num_timepoints * bins_per_frame;

    // Probability of spike per high-res timestep
    let p_spike = cfg.rate_hz / spike_sim_hz;

    let mut high_res_spikes = vec![0u8; num_high_res];
    for i in 0..num_high_res {
        if rng.next_f64() < p_spike {
            high_res_spikes[i] = 1;
        }
    }

    // Bin to imaging rate
    let mut spikes = vec![0.0_f32; num_timepoints];
    for f in 0..num_timepoints {
        let start = f * bins_per_frame;
        let end = (start + bins_per_frame).min(num_high_res);
        let mut count = 0u32;
        for j in start..end {
            count += high_res_spikes[j] as u32;
        }
        if count > 0 {
            spikes[f] = count as f32;
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
///
/// F_sat = F^n / (F^n + Kd^n)
///
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

/// Add baseline drift to the trace in-place.
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
            // Random drift period within [cycles_min, cycles_max]
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

/// Apply exponential photobleaching multiplicatively.
///
/// F_bleach(t) = 1 - amplitude * (1 - exp(-t / tau))
///
/// Attribution: NAOMi (Charles et al., 2019).
fn apply_photobleaching(trace: &mut [f64], cfg: &PhotobleachingConfig, fs_hz: f64) {
    let tau = cfg.decay_time_constant_s;
    let amp = cfg.amplitude_fraction;
    for (i, v) in trace.iter_mut().enumerate() {
        let t = i as f64 / fs_hz;
        let bleach_factor = 1.0 - amp * (1.0 - (-t / tau).exp());
        *v *= bleach_factor;
    }
}

// ── Noise ────────────────────────────────────────────────────────

/// Add noise to the trace in-place.
///
/// Gaussian noise is always applied. Poisson shot noise is optional
/// (signal-dependent, split by shot_noise_fraction).
///
/// Attribution: Gaussian from CaLab web simulator.
/// Shot noise from CASCADE (Rupprecht et al., 2021).
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
        // Split variance between Gaussian and Poisson
        let total_var = noise_std * noise_std;
        let gauss_var = total_var * (1.0 - cfg.shot_noise_fraction);
        let shot_var = total_var * cfg.shot_noise_fraction;
        let gauss_std = gauss_var.sqrt();

        for v in trace.iter_mut() {
            // Gaussian component
            let gauss = gauss_std * rng.gaussian();

            // Poisson shot noise: signal-dependent.
            // Scale signal so that Var[noise] = shot_var at the signal peak.
            // For Poisson(lambda), Var = lambda, so we scale:
            //   lambda = |v| * (shot_var / signal_max)
            // Then noise = Poisson(lambda) - lambda (zero-centered).
            let abs_v = (*v).abs();
            let lambda = abs_v * shot_var / signal_max;
            let poisson_sample = poisson_sample_knuth(lambda, rng);
            let shot = poisson_sample - lambda;

            *v += gauss + shot;
        }
    } else {
        // Pure Gaussian noise (matches original CaLab web simulator)
        for v in trace.iter_mut() {
            *v += noise_std * rng.gaussian();
        }
    }
}

/// Poisson random variate via Knuth's algorithm.
/// For small lambda (<= 30), this is efficient and simple.
/// For larger lambda, falls back to Gaussian approximation.
fn poisson_sample_knuth(lambda: f64, rng: &mut Xorshift32) -> f64 {
    if lambda <= 0.0 {
        return 0.0;
    }
    if lambda > 30.0 {
        // Gaussian approximation for large lambda
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

/// Built-in indicator presets.
///
/// Each returns a complete SimulationConfig with sensible defaults
/// for a specific calcium indicator. Users can clone and modify.
pub mod presets {
    use super::*;

    /// GCaMP6f at 30 Hz. Time constants from Chen et al., 2013, Nature.
    pub fn gcamp6f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6 },
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// GCaMP6s at 30 Hz. Slow kinetics, high SNR.
    /// Time constants from Chen et al., 2013, Nature.
    pub fn gcamp6s() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.4, tau_decay_s: 1.8 },
            noise: NoiseConfig { snr: 25.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// GCaMP6m at 30 Hz. Moderate kinetics.
    /// Time constants from Chen et al., 2013, Nature.
    pub fn gcamp6m() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.15, tau_decay_s: 0.9 },
            noise: NoiseConfig { snr: 22.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// jGCaMP8f at 30 Hz. Fast indicator, noisier signal.
    /// Time constants from Zhang et al., 2023, Nature.
    pub fn jgcamp8f() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 0.3 },
            noise: NoiseConfig { snr: 12.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// OGB-1 synthetic dye at 30 Hz. Fast rise, slow decay.
    /// Time constants from Stosiek et al., 2003.
    pub fn ogb1() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.05, tau_decay_s: 1.5 },
            noise: NoiseConfig { snr: 15.0, ..Default::default() },
            ..Default::default()
        }
    }

    /// Near-ideal traces: minimal noise, no baseline drift.
    /// For algorithm debugging and testing.
    pub fn clean() -> SimulationConfig {
        SimulationConfig {
            kernel: KernelConfig { tau_rise_s: 0.1, tau_decay_s: 0.6 },
            noise: NoiseConfig { snr: 200.0, ..Default::default() },
            drift: DriftModel::Sinusoidal(SinusoidalDrift {
                amplitude_fraction: 0.0,
                cycles_min: 1.0,
                cycles_max: 1.0,
            }),
            cell_variation: CellVariationConfig {
                alpha_cv: 0.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// All built-in presets as (name, config) pairs.
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
            num_timepoints: 900, // 30 seconds
            num_cells: 3,
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            cell_variation: CellVariationConfig {
                alpha_cv: 0.0, // deterministic alpha for basic tests
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn determinism_same_seed_same_output() {
        let cfg = small_config();
        let r1 = simulate(&cfg);
        let r2 = simulate(&cfg);
        assert_eq!(r1.traces, r2.traces, "Same seed must produce identical traces");
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
        let cfg = small_config();
        let result = simulate(&cfg);
        for gt in &result.ground_truth {
            for &s in &gt.spikes {
                assert!(s >= 0.0, "Spikes must be non-negative, got {}", s);
            }
        }
    }

    #[test]
    fn clean_calcium_is_non_negative() {
        let cfg = small_config();
        let result = simulate(&cfg);
        for gt in &result.ground_truth {
            for &c in &gt.clean_calcium {
                assert!(c >= -1e-6, "Clean calcium must be non-negative, got {}", c);
            }
        }
    }

    #[test]
    fn markov_produces_spikes() {
        let cfg = SimulationConfig {
            num_timepoints: 9000, // 5 minutes at 30 Hz
            num_cells: 1,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let total_spikes: f32 = result.ground_truth[0].spikes.iter().sum();
        assert!(total_spikes > 0.0, "Markov model should produce at least some spikes");
    }

    #[test]
    fn poisson_mean_rate() {
        let cfg = SimulationConfig {
            num_timepoints: 30000, // ~16 min at 30 Hz
            num_cells: 1,
            spike_model: SpikeModel::Poisson(PoissonConfig { rate_hz: 2.0 }),
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let total_spikes: f32 = result.ground_truth[0].spikes.iter().sum();
        let duration_s = cfg.num_timepoints as f64 / cfg.fs_hz;
        let measured_rate = total_spikes as f64 / duration_s;
        // Within 50% of target (stochastic, allow wide tolerance)
        assert!(
            (measured_rate - 2.0).abs() < 1.0,
            "Poisson rate should be ~2.0 Hz, got {:.2}",
            measured_rate
        );
    }

    #[test]
    fn snr_approximately_correct() {
        let cfg = SimulationConfig {
            num_timepoints: 9000,
            num_cells: 1,
            noise: NoiseConfig { snr: 20.0, ..Default::default() },
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let gt = &result.ground_truth[0];
        let n = cfg.num_timepoints;

        // Compute signal peak
        let signal_max = gt.clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        if signal_max < 1e-6 {
            return; // degenerate case, skip
        }

        // Compute noise std from residual (trace - clean)
        let trace = &result.traces[0..n];
        let mut sum_sq = 0.0_f64;
        let mut count = 0;
        for i in 0..n {
            // Only use samples where clean signal is near zero (noise-dominated)
            if gt.clean_calcium[i] < 0.01 * signal_max {
                let residual = trace[i] as f64 - gt.clean_calcium[i] as f64;
                sum_sq += residual * residual;
                count += 1;
            }
        }

        if count > 100 {
            let noise_std = (sum_sq / count as f64).sqrt();
            let measured_snr = signal_max as f64 / noise_std;
            // Within 50% of target (drift adds variance)
            assert!(
                measured_snr > 10.0 && measured_snr < 40.0,
                "Measured SNR should be ~20, got {:.1}",
                measured_snr
            );
        }
    }

    #[test]
    fn alpha_variation_produces_spread() {
        let cfg = SimulationConfig {
            num_timepoints: 900,
            num_cells: 50,
            cell_variation: CellVariationConfig {
                alpha_mean: 1.0,
                alpha_cv: 0.3,
                ..Default::default()
            },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let alphas: Vec<f64> = result.ground_truth.iter().map(|gt| gt.alpha).collect();
        let mean = alphas.iter().sum::<f64>() / alphas.len() as f64;
        let var = alphas.iter().map(|a| (a - mean).powi(2)).sum::<f64>() / alphas.len() as f64;
        let cv = var.sqrt() / mean;
        // CV should be roughly 0.3 (allow 0.1 to 0.6 for stochastic test)
        assert!(cv > 0.1 && cv < 0.6, "Alpha CV should be ~0.3, got {:.3}", cv);
    }

    #[test]
    fn kernel_variation_produces_spread() {
        let cfg = SimulationConfig {
            num_timepoints: 900,
            num_cells: 50,
            cell_variation: CellVariationConfig {
                alpha_cv: 0.0,
                tau_decay_cv: 0.15,
                ..Default::default()
            },
            ..Default::default()
        };
        let result = simulate(&cfg);
        let taus: Vec<f64> = result.ground_truth.iter().map(|gt| gt.tau_decay_s).collect();
        let mean = taus.iter().sum::<f64>() / taus.len() as f64;
        let min = taus.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = taus.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        // With CV=0.15, tau values should spread around the nominal
        assert!(
            max > mean * 1.05 && min < mean * 0.95,
            "Tau spread too narrow: min={:.4}, mean={:.4}, max={:.4}",
            min, mean, max
        );
    }

    #[test]
    fn photobleaching_decreases_signal() {
        // Compare traces with vs. without photobleaching using the same seed.
        // Bleached trace should have lower values at the end of the recording.
        let base_cfg = SimulationConfig {
            num_timepoints: 9000,
            num_cells: 1,
            noise: NoiseConfig { snr: 200.0, ..Default::default() },
            drift: DriftModel::Sinusoidal(SinusoidalDrift {
                amplitude_fraction: 0.0, ..Default::default()
            }),
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };

        let cfg_no_bleach = SimulationConfig {
            photobleaching: PhotobleachingConfig { enabled: false, ..Default::default() },
            ..base_cfg.clone()
        };
        let cfg_bleach = SimulationConfig {
            photobleaching: PhotobleachingConfig {
                enabled: true,
                decay_time_constant_s: 30.0,
                amplitude_fraction: 0.3,
            },
            ..base_cfg
        };

        let r_no = simulate(&cfg_no_bleach);
        let r_yes = simulate(&cfg_bleach);
        let n = cfg_no_bleach.num_timepoints;

        // In the last 10% of the trace, bleached should be systematically lower
        let last_start = n - n / 10;
        let mut lower_count = 0;
        for i in last_start..n {
            if r_yes.traces[i] < r_no.traces[i] {
                lower_count += 1;
            }
        }
        let frac_lower = lower_count as f64 / (n - last_start) as f64;
        assert!(
            frac_lower > 0.8,
            "Bleached trace should be lower in >80% of last samples, got {:.1}%",
            frac_lower * 100.0
        );
    }

    #[test]
    fn saturation_compresses_signal() {
        let cfg_linear = SimulationConfig {
            num_timepoints: 900,
            num_cells: 1,
            saturation: SaturationConfig { enabled: false, ..Default::default() },
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let cfg_sat = SimulationConfig {
            saturation: SaturationConfig {
                enabled: true,
                hill_coefficient: 1.0,
                k_d: 0.5, // low Kd = strong saturation
            },
            ..cfg_linear.clone()
        };

        let r_linear = simulate(&cfg_linear);
        let r_sat = simulate(&cfg_sat);

        let max_linear = r_linear.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);
        let max_sat = r_sat.ground_truth[0].clean_calcium.iter().cloned().fold(0.0_f32, f32::max);

        assert!(
            max_sat < max_linear || max_linear < 1e-6,
            "Saturation should compress signal: linear_max={:.4}, sat_max={:.4}",
            max_linear, max_sat
        );
    }

    #[test]
    fn presets_produce_valid_configs() {
        for (name, cfg) in presets::all() {
            assert!(cfg.fs_hz > 0.0, "Preset {} has invalid fs", name);
            assert!(cfg.kernel.tau_rise_s > 0.0, "Preset {} has invalid tau_rise", name);
            assert!(cfg.kernel.tau_decay_s > 0.0, "Preset {} has invalid tau_decay", name);
            assert!(cfg.noise.snr > 0.0, "Preset {} has invalid snr", name);
        }
    }

    #[test]
    fn xorshift32_deterministic() {
        // Verify the PRNG is deterministic and produces a valid sequence.
        // Manual trace for seed=42:
        //   s=42 → ^=(42<<13)=344106 → ^=(344106>>17)=344104 → ^=(344104<<5)=11355432
        let mut rng = Xorshift32::new(42);
        let v1 = rng.next_u32();
        assert_eq!(v1, 11355432, "First xorshift32 value mismatch");

        let v2 = rng.next_u32();
        let v3 = rng.next_u32();
        assert!(v2 != v1 && v3 != v2, "PRNG should produce different values");

        // Same seed → same sequence
        let mut rng2 = Xorshift32::new(42);
        assert_eq!(rng2.next_u32(), v1);
        assert_eq!(rng2.next_u32(), v2);
        assert_eq!(rng2.next_u32(), v3);
    }

    #[test]
    fn ground_truth_fields_populated() {
        let cfg = small_config();
        let result = simulate(&cfg);
        for gt in &result.ground_truth {
            assert!(gt.alpha > 0.0, "Alpha should be positive");
            assert!(gt.snr > 0.0, "SNR should be positive");
            assert!(gt.tau_rise_s > 0.0, "tau_rise should be positive");
            assert!(gt.tau_decay_s > 0.0, "tau_decay should be positive");
        }
    }

    #[test]
    fn single_cell_single_timepoint() {
        let cfg = SimulationConfig {
            num_timepoints: 1,
            num_cells: 1,
            cell_variation: CellVariationConfig { alpha_cv: 0.0, ..Default::default() },
            ..Default::default()
        };
        let result = simulate(&cfg);
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
