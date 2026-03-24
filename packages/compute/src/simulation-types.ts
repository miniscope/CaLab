/**
 * TypeScript interfaces mirroring the Rust/Pydantic simulation config and result types.
 * These are the canonical types used by the WASM `simulate_traces()` binding.
 */

// ── Spike Models ────────────────────────────────────────────────

/** Two-state HMM spike generator. Attribution: CaLab web simulator. */
export interface MarkovConfig {
  model_type: 'markov';
  p_silent_to_active: number;
  p_active_to_silent: number;
  p_spike_when_active: number;
  p_spike_when_silent: number;
}

/** Homogeneous Poisson generator. Attribution: OASIS/CaImAn. */
export interface PoissonConfig {
  model_type: 'poisson';
  rate_hz: number;
}

export type SpikeModel = MarkovConfig | PoissonConfig;

// ── Kernel ──────────────────────────────────────────────────────

/** Double-exponential kernel h(t) = exp(-t/tau_d) - exp(-t/tau_r). */
export interface KernelConfig {
  tau_rise_s: number;
  tau_decay_s: number;
}

// ── Noise ───────────────────────────────────────────────────────

/** Gaussian + optional Poisson shot noise. Attribution: CaLab + CASCADE. */
export interface NoiseConfig {
  snr: number;
  shot_noise_enabled: boolean;
  shot_noise_fraction: number;
}

// ── Drift ───────────────────────────────────────────────────────

/** Sinusoidal baseline drift. Attribution: CaLab web simulator. */
export interface SinusoidalDrift {
  model_type: 'sinusoidal';
  amplitude_fraction: number;
  cycles_min: number;
  cycles_max: number;
}

/** Random walk drift. Attribution: MLspike (Deneux et al., 2016). */
export interface RandomWalkDrift {
  model_type: 'random_walk';
  step_std_fraction: number;
  mean_reversion: number;
}

export type DriftModel = SinusoidalDrift | RandomWalkDrift;

// ── Photobleaching ──────────────────────────────────────────────

/** Exponential photobleaching. Attribution: NAOMi (Charles et al., 2019). */
export interface PhotobleachingConfig {
  enabled: boolean;
  decay_time_constant_s: number;
  amplitude_fraction: number;
}

// ── Saturation ──────────────────────────────────────────────────

/** Hill equation saturation. Attribution: MLspike (Deneux et al., 2016). */
export interface SaturationConfig {
  enabled: boolean;
  hill_coefficient: number;
  k_d: number;
}

// ── Cell Variation ──────────────────────────────────────────────

/** Per-cell parameter variation (alpha, kernel, SNR). */
export interface CellVariationConfig {
  alpha_mean: number;
  alpha_cv: number;
  tau_rise_cv: number;
  tau_decay_cv: number;
  snr_spread: number;
  drift_cv: number;
  bleach_cv: number;
  saturation_cv: number;
  spike_rate_cv: number;
}

// ── Top-Level Config ────────────────────────────────────────────

export interface SimulationConfig {
  fs_hz: number;
  num_timepoints: number;
  num_cells: number;
  kernel: KernelConfig;
  spike_model: SpikeModel;
  noise: NoiseConfig;
  drift: DriftModel;
  photobleaching: PhotobleachingConfig;
  saturation: SaturationConfig;
  cell_variation: CellVariationConfig;
  seed: number;
  spike_sim_hz: number;
}

// ── Ground Truth ────────────────────────────────────────────────

export interface CellGroundTruth {
  spikes: number[];
  clean_calcium: number[];
  alpha: number;
  baseline: number;
  snr: number;
  tau_rise_s: number;
  tau_decay_s: number;
}

export interface SimulationResult {
  traces: number[];
  num_cells: number;
  num_timepoints: number;
  ground_truth: CellGroundTruth[];
}
