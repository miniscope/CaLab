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

const DEFAULT_NOISE = { snr: 8.0, shot_noise_enabled: false, shot_noise_fraction: 0.3 };
const DEFAULT_DRIFT = {
  model_type: 'random_walk' as const,
  step_std_fraction: 0.002,
  mean_reversion: 0.001,
};
const DEFAULT_PHOTOBLEACHING = {
  enabled: false,
  decay_time_constant_s: 600.0,
  amplitude_fraction: 0.15,
};
const DEFAULT_SATURATION = { enabled: false, hill_coefficient: 1.0, k_d: 5.0 };
const DEFAULT_VARIATION = {
  alpha_mean: 1.0,
  alpha_cv: 0.3,
  tau_rise_cv: 0.0,
  tau_decay_cv: 0.0,
  snr_spread: 0.0,
};

function makeConfig(overrides: Partial<SimulationConfig>): SimulationConfig {
  return {
    fs_hz: 30.0,
    num_timepoints: 27000,
    num_cells: 100,
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6 },
    spike_model: { ...DEFAULT_MARKOV },
    noise: { ...DEFAULT_NOISE },
    drift: { ...DEFAULT_DRIFT },
    photobleaching: { ...DEFAULT_PHOTOBLEACHING },
    saturation: { ...DEFAULT_SATURATION },
    cell_variation: { ...DEFAULT_VARIATION },
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
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6 },
    noise: { ...DEFAULT_NOISE, snr: 20.0 },
  }),
};

/** GCaMP6s at 30 Hz. Chen et al., 2013. */
export const PRESET_GCAMP6S: SimulationPreset = {
  id: 'gcamp6s',
  label: 'GCaMP6s',
  description: 'Slow genetically encoded indicator, high SNR',
  config: makeConfig({
    kernel: { tau_rise_s: 0.4, tau_decay_s: 1.8 },
    noise: { ...DEFAULT_NOISE, snr: 25.0 },
  }),
};

/** GCaMP6m at 30 Hz. Chen et al., 2013. */
export const PRESET_GCAMP6M: SimulationPreset = {
  id: 'gcamp6m',
  label: 'GCaMP6m',
  description: 'Moderate kinetics genetically encoded indicator',
  config: makeConfig({
    kernel: { tau_rise_s: 0.15, tau_decay_s: 0.9 },
    noise: { ...DEFAULT_NOISE, snr: 22.0 },
  }),
};

/** jGCaMP8f at 30 Hz. Zhang et al., 2023. */
export const PRESET_JGCAMP8F: SimulationPreset = {
  id: 'jgcamp8f',
  label: 'jGCaMP8f',
  description: 'Fast next-gen indicator, noisier',
  config: makeConfig({
    kernel: { tau_rise_s: 0.05, tau_decay_s: 0.3 },
    noise: { ...DEFAULT_NOISE, snr: 12.0 },
  }),
};

/** OGB-1 at 30 Hz. Stosiek et al., 2003. */
export const PRESET_OGB1: SimulationPreset = {
  id: 'ogb1',
  label: 'OGB-1',
  description: 'Synthetic calcium dye, fast rise',
  config: makeConfig({
    kernel: { tau_rise_s: 0.05, tau_decay_s: 1.5 },
    noise: { ...DEFAULT_NOISE, snr: 15.0 },
  }),
};

/** Near-ideal traces for algorithm debugging. */
export const PRESET_CLEAN: SimulationPreset = {
  id: 'clean',
  label: 'Clean (Debug)',
  description: 'Minimal noise, no drift — for algorithm debugging',
  config: makeConfig({
    kernel: { tau_rise_s: 0.1, tau_decay_s: 0.6 },
    noise: { ...DEFAULT_NOISE, snr: 200.0 },
    drift: { model_type: 'random_walk', step_std_fraction: 0.0, mean_reversion: 0.001 },
    cell_variation: { ...DEFAULT_VARIATION, alpha_cv: 0.0 },
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

export function getSimulationPresetLabels(): { id: string; label: string }[] {
  return SIMULATION_PRESETS.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Convert a SimulationConfig to the legacy SimulationParams shape
 * used by the TypeScript generateSyntheticDataset() function.
 */
export function simulationConfigToLegacyParams(cfg: SimulationConfig): {
  tauRise: number;
  tauDecay: number;
  snrBase: number;
  snrStep: number;
  markov: {
    pSilentToActive: number;
    pActiveToSilent: number;
    pSpikeWhenActive: number;
    pSpikeWhenSilent: number;
  };
  noise: {
    amplitudeSigma: number;
    driftAmplitude: number;
    driftCyclesMin: number;
    driftCyclesMax: number;
  };
} {
  return {
    tauRise: cfg.kernel.tau_rise_s,
    tauDecay: cfg.kernel.tau_decay_s,
    snrBase: cfg.noise.snr,
    snrStep: cfg.cell_variation.snr_spread > 0 ? cfg.cell_variation.snr_spread / 2.5 : 2,
    markov:
      cfg.spike_model.model_type === 'markov'
        ? {
            pSilentToActive: cfg.spike_model.p_silent_to_active,
            pActiveToSilent: cfg.spike_model.p_active_to_silent,
            pSpikeWhenActive: cfg.spike_model.p_spike_when_active,
            pSpikeWhenSilent: cfg.spike_model.p_spike_when_silent,
          }
        : {
            pSilentToActive: 0.01,
            pActiveToSilent: 0.2,
            pSpikeWhenActive: 0.7,
            pSpikeWhenSilent: 0.005,
          },
    noise:
      cfg.drift.model_type === 'sinusoidal'
        ? {
            amplitudeSigma: 0.3,
            driftAmplitude: cfg.drift.amplitude_fraction,
            driftCyclesMin: cfg.drift.cycles_min,
            driftCyclesMax: cfg.drift.cycles_max,
          }
        : { amplitudeSigma: 0.3, driftAmplitude: 0.1, driftCyclesMin: 2, driftCyclesMax: 4 },
  };
}
