/**
 * TypeScript interfaces mirroring the Rust simulation config and result types.
 *
 * Each config struct co-locates its nominal values with optional _cv fields
 * for per-cell variation. CV=0 means all cells share the same value.
 */

// ── Spike Models ────────────────────────────────────────────────

export interface MarkovConfig {
  model_type: 'markov';
  p_silent_to_active: number;
  p_active_to_silent: number;
  p_spike_when_active: number;
  p_spike_when_silent: number;
  /** Per-cell log-normal CV on p_silent_to_active. Default: 0. */
  p_silent_to_active_cv: number;
}

export interface PoissonConfig {
  model_type: 'poisson';
  rate_hz: number;
}

export type SpikeModel = MarkovConfig | PoissonConfig;

// ── Kernel ──────────────────────────────────────────────────────

export interface KernelConfig {
  tau_rise_s: number;
  tau_decay_s: number;
  /** Per-cell log-normal CV on tau_rise. Default: 0. */
  tau_rise_cv: number;
  /** Per-cell log-normal CV on tau_decay. Default: 0. */
  tau_decay_cv: number;
}

// ── Noise ───────────────────────────────────────────────────────

export interface NoiseConfig {
  snr: number;
  shot_noise_enabled: boolean;
  shot_noise_fraction: number;
  /** Per-cell additive SNR spread (+/- this value). Default: 0. */
  snr_spread: number;
}

// ── Drift ───────────────────────────────────────────────────────

export interface SinusoidalDrift {
  model_type: 'sinusoidal';
  amplitude_fraction: number;
  cycles_min: number;
  cycles_max: number;
  /** Per-cell log-normal CV on amplitude. Default: 0. */
  amplitude_cv: number;
}

export interface RandomWalkDrift {
  model_type: 'random_walk';
  step_std_fraction: number;
  mean_reversion: number;
  /** Per-cell log-normal CV on step_std. Default: 0. */
  step_std_cv: number;
}

export type DriftModel = SinusoidalDrift | RandomWalkDrift;

// ── Photobleaching ──────────────────────────────────────────────

export interface PhotobleachingConfig {
  enabled: boolean;
  decay_time_constant_s: number;
  amplitude_fraction: number;
  /** Per-cell log-normal CV on amplitude. Default: 0. */
  amplitude_cv: number;
}

// ── Saturation ──────────────────────────────────────────────────

export interface SaturationConfig {
  enabled: boolean;
  hill_coefficient: number;
  k_d: number;
  /** Per-cell log-normal CV on k_d. Default: 0. */
  k_d_cv: number;
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
  /** Mean per-cell amplitude scaling factor. Default: 1.0. */
  alpha_mean: number;
  /** Per-cell log-normal CV on alpha. Default: 0.3. */
  alpha_cv: number;
  seed: number;
  spike_sim_hz: number;
}

// ── Ground Truth ────────────────────────────────────────────────

export interface CellGroundTruth {
  spikes: number[];
  clean_calcium: number[];
  alpha: number;
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
