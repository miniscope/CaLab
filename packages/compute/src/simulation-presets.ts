/**
 * Built-in simulation presets matching Rust `simulate::presets`.
 * Each preset is a complete SimulationConfig for a specific calcium indicator.
 */
import type { SimulationConfig } from './simulation-types.ts';

const DEFAULT_MARKOV = {
  model_type: 'markov' as const,
  p_silent_to_active: 0.01,
  p_active_to_silent: 0.2,
  p_spike_when_active: 0.7,
  p_spike_when_silent: 0.005,
};

const DEFAULT_NOISE = {
  snr: 8.0,
  shot_noise_enabled: false,
  shot_noise_fraction: 0.3,
  snr_spread: 0,
};
const DEFAULT_DRIFT = {
  model_type: 'random_walk' as const,
  step_std_fraction: 0.002,
  mean_reversion: 0.001,
  step_std_cv: 0,
};
const DEFAULT_PHOTOBLEACHING = {
  enabled: false,
  decay_time_constant_s: 600.0,
  amplitude_fraction: 0.15,
  amplitude_cv: 0,
};
const DEFAULT_SATURATION = { enabled: false, hill_coefficient: 1.0, k_d: 5.0, k_d_cv: 0 };

function makeConfig(overrides: Partial<SimulationConfig>): SimulationConfig {
  return {
    fs_hz: 30.0,
    num_timepoints: 27000,
    num_cells: 100,
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6, tau_rise_cv: 0, tau_decay_cv: 0 },
    spike_model: { ...DEFAULT_MARKOV, p_silent_to_active_cv: 0 },
    noise: { ...DEFAULT_NOISE },
    drift: { ...DEFAULT_DRIFT },
    photobleaching: { ...DEFAULT_PHOTOBLEACHING },
    saturation: { ...DEFAULT_SATURATION },
    alpha_mean: 1.0,
    alpha_cv: 0.3,
    seed: 42,
    spike_sim_hz: 300.0,
    ...overrides,
  };
}

export interface SimulationPreset {
  id: string;
  label: string;
  description: string;
  config: SimulationConfig;
}

/** GCaMP6f at 30 Hz. Chen et al., 2013, Nature. */
export const PRESET_GCAMP6F: SimulationPreset = {
  id: 'gcamp6f',
  label: 'GCaMP6f',
  description: 'Fast genetically encoded indicator (default)',
  config: makeConfig({
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 20.0 },
  }),
};

/** GCaMP6s at 30 Hz. Chen et al., 2013. */
export const PRESET_GCAMP6S: SimulationPreset = {
  id: 'gcamp6s',
  label: 'GCaMP6s',
  description: 'Slow genetically encoded indicator, high SNR',
  config: makeConfig({
    kernel: { tau_rise_s: 0.4, tau_decay_s: 1.8, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 25.0 },
  }),
};

/** GCaMP6m at 30 Hz. Chen et al., 2013. */
export const PRESET_GCAMP6M: SimulationPreset = {
  id: 'gcamp6m',
  label: 'GCaMP6m',
  description: 'Moderate kinetics genetically encoded indicator',
  config: makeConfig({
    kernel: { tau_rise_s: 0.15, tau_decay_s: 0.9, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 22.0 },
  }),
};

/** jGCaMP8f at 30 Hz. Zhang et al., 2023. */
export const PRESET_JGCAMP8F: SimulationPreset = {
  id: 'jgcamp8f',
  label: 'jGCaMP8f',
  description: 'Fast next-gen indicator, noisier',
  config: makeConfig({
    kernel: { tau_rise_s: 0.05, tau_decay_s: 0.3, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 12.0 },
  }),
};

/** OGB-1 at 30 Hz. Stosiek et al., 2003. */
export const PRESET_OGB1: SimulationPreset = {
  id: 'ogb1',
  label: 'OGB-1',
  description: 'Synthetic calcium dye, fast rise',
  config: makeConfig({
    kernel: { tau_rise_s: 0.05, tau_decay_s: 1.5, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 15.0 },
  }),
};

/** Near-ideal traces for algorithm debugging. */
export const PRESET_CLEAN: SimulationPreset = {
  id: 'clean',
  label: 'Clean (Debug)',
  description: 'Minimal noise, no drift — for algorithm debugging',
  config: makeConfig({
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6, tau_rise_cv: 0, tau_decay_cv: 0 },
    noise: { ...DEFAULT_NOISE, snr: 200.0 },
    drift: {
      model_type: 'random_walk',
      step_std_fraction: 0.0,
      mean_reversion: 0.001,
      step_std_cv: 0,
    },
    alpha_cv: 0.0,
  }),
};

export const SIMULATION_PRESETS: SimulationPreset[] = [
  PRESET_GCAMP6F,
  PRESET_GCAMP6S,
  PRESET_GCAMP6M,
  PRESET_JGCAMP8F,
  PRESET_OGB1,
  PRESET_CLEAN,
];

export const DEFAULT_SIMULATION_PRESET_ID = 'gcamp6f';

export function getSimulationPresetById(id: string): SimulationPreset | undefined {
  return SIMULATION_PRESETS.find((p) => p.id === id);
}

const SIMULATION_PRESET_LABELS: { id: string; label: string }[] = SIMULATION_PRESETS.map((p) => ({
  id: p.id,
  label: p.label,
}));

export function getSimulationPresetLabels(): { id: string; label: string }[] {
  return SIMULATION_PRESET_LABELS;
}
