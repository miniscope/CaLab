/**
 * Qualitative simulation presets per pipeline step.
 *
 * Each step has a flat array of level definitions. To add a level, add one
 * object to the array. To adjust values, edit the numbers here. Types are
 * derived from the arrays so they update automatically.
 *
 * All steps use dual-thumb range sliders in the UI. Each cell draws its
 * parameter value from within the selected range. When both thumbs are on
 * the same tick, all cells share that exact value (no variation).
 */

import type {
  SimulationConfig,
  MarkovConfig,
  NoiseConfig,
  RandomWalkDrift,
  PhotobleachingConfig,
  SaturationConfig,
} from './simulation-types.ts';
import { getSimulationPresetById } from './simulation-presets.ts';

// ── Indicator ───────────────────────────────────────────────────

export const INDICATOR_OPTIONS = [
  { id: 'gcamp6f', label: 'GCaMP6f', description: 'Fast GECI (Chen et al., 2013)' },
  { id: 'gcamp6s', label: 'GCaMP6s', description: 'Slow GECI, high SNR (Chen et al., 2013)' },
  { id: 'gcamp6m', label: 'GCaMP6m', description: 'Moderate GECI (Chen et al., 2013)' },
  { id: 'jgcamp8f', label: 'jGCaMP8f', description: 'Ultra-fast GECI (Zhang et al., 2023)' },
  { id: 'ogb1', label: 'OGB-1', description: 'Synthetic dye (Stosiek et al., 2003)' },
] as const;

export type IndicatorId = (typeof INDICATOR_OPTIONS)[number]['id'];

// ══════════════════════════════════════════════════════════════════
// LEVEL DEFINITIONS (one array per step — edit here to adjust values)
// ══════════════════════════════════════════════════════════════════

// ── Spike Activity (Markov HMM) ─────────────────────────────────

export const SPIKE_ACTIVITY_LEVELS = [
  {
    id: 'sparse',
    label: 'Sparse',
    p_silent_to_active: 0.005,
    p_active_to_silent: 0.3,
    p_spike_when_active: 0.5,
    p_spike_when_silent: 0.002,
  },
  {
    id: 'moderate',
    label: 'Moderate',
    p_silent_to_active: 0.01,
    p_active_to_silent: 0.2,
    p_spike_when_active: 0.7,
    p_spike_when_silent: 0.005,
  },
  {
    id: 'dense',
    label: 'Dense',
    p_silent_to_active: 0.03,
    p_active_to_silent: 0.1,
    p_spike_when_active: 0.8,
    p_spike_when_silent: 0.01,
  },
] as const;

export type SpikeActivityLevel = (typeof SPIKE_ACTIVITY_LEVELS)[number]['id'];

// ── Noise ───────────────────────────────────────────────────────

export const NOISE_LEVELS = [
  { id: 'clean', label: 'Clean', snr: 200, shot_noise_enabled: false, shot_noise_fraction: 0 },
  { id: 'low', label: 'Low', snr: 40, shot_noise_enabled: false, shot_noise_fraction: 0 },
  {
    id: 'moderate',
    label: 'Moderate',
    snr: 15,
    shot_noise_enabled: false,
    shot_noise_fraction: 0.3,
  },
  { id: 'high', label: 'High', snr: 8, shot_noise_enabled: true, shot_noise_fraction: 0.3 },
  {
    id: 'very_high',
    label: 'Very High',
    snr: 5,
    shot_noise_enabled: true,
    shot_noise_fraction: 0.5,
  },
] as const;

export type NoiseLevel = (typeof NOISE_LEVELS)[number]['id'];

// ── Drift (random walk) ─────────────────────────────────────────

export const DRIFT_LEVELS = [
  { id: 'none', label: 'None', step_std_fraction: 0.0, mean_reversion: 0.001 },
  { id: 'subtle', label: 'Subtle', step_std_fraction: 0.001, mean_reversion: 0.002 },
  { id: 'moderate', label: 'Moderate', step_std_fraction: 0.003, mean_reversion: 0.001 },
  { id: 'strong', label: 'Strong', step_std_fraction: 0.008, mean_reversion: 0.0005 },
] as const;

export type DriftLevel = (typeof DRIFT_LEVELS)[number]['id'];

// ── Photobleaching ──────────────────────────────────────────────

export const PHOTOBLEACHING_LEVELS = [
  { id: 'none', label: 'None', enabled: false, decay_time_constant_s: 600, amplitude_fraction: 0 },
  {
    id: 'mild',
    label: 'Mild',
    enabled: true,
    decay_time_constant_s: 900,
    amplitude_fraction: 0.08,
  },
  {
    id: 'moderate',
    label: 'Moderate',
    enabled: true,
    decay_time_constant_s: 600,
    amplitude_fraction: 0.15,
  },
  {
    id: 'severe',
    label: 'Severe',
    enabled: true,
    decay_time_constant_s: 300,
    amplitude_fraction: 0.3,
  },
] as const;

export type PhotobleachingLevel = (typeof PHOTOBLEACHING_LEVELS)[number]['id'];

// ── Saturation ──────────────────────────────────────────────────

export const SATURATION_LEVELS = [
  { id: 'none', label: 'None', enabled: false, hill_coefficient: 1.0, k_d: 5.0 },
  { id: 'mild', label: 'Mild', enabled: true, hill_coefficient: 1.5, k_d: 8.0 },
  { id: 'strong', label: 'Strong', enabled: true, hill_coefficient: 2.5, k_d: 3.0 },
] as const;

export type SaturationLevel = (typeof SATURATION_LEVELS)[number]['id'];

// ── Amplitude Variation ─────────────────────────────────────────

export const AMPLITUDE_VARIATION_LEVELS = [
  { id: 'none', label: 'None', alpha_cv: 0 },
  { id: 'low', label: 'Low', alpha_cv: 0.15 },
  { id: 'moderate', label: 'Moderate', alpha_cv: 0.3 },
  { id: 'high', label: 'High', alpha_cv: 0.5 },
] as const;

export type AmplitudeVariationLevel = (typeof AMPLITUDE_VARIATION_LEVELS)[number]['id'];

// ── Kernel Variation ────────────────────────────────────────────

export const KERNEL_VARIATION_LEVELS = [
  { id: 'none', label: 'None', tau_rise_cv: 0, tau_decay_cv: 0 },
  { id: 'low', label: 'Low', tau_rise_cv: 0.05, tau_decay_cv: 0.05 },
  { id: 'moderate', label: 'Moderate', tau_rise_cv: 0.1, tau_decay_cv: 0.1 },
  { id: 'high', label: 'High', tau_rise_cv: 0.2, tau_decay_cv: 0.2 },
] as const;

export type KernelVariationLevel = (typeof KERNEL_VARIATION_LEVELS)[number]['id'];

// ══════════════════════════════════════════════════════════════════
// CONFIG & BUILDER
// ══════════════════════════════════════════════════════════════════

/**
 * All steps use [lowIndex, highIndex] ranges into their level arrays.
 * When both indices are the same, all cells get that exact value.
 * When they differ, per-cell values are drawn from within the range.
 */
export interface QualitativeSimConfig {
  indicator: IndicatorId;
  spikeActivity: [number, number];
  noise: [number, number];
  drift: [number, number];
  photobleaching: [number, number];
  saturation: [number, number];
  amplitudeVariation: [number, number];
  kernelVariation: [number, number];
}

export const DEFAULT_QUALITATIVE_CONFIG: QualitativeSimConfig = {
  indicator: 'gcamp6f',
  spikeActivity: [1, 1], // Moderate
  noise: [1, 1], // Low
  drift: [1, 1], // Subtle
  photobleaching: [0, 0], // None
  saturation: [0, 0], // None
  amplitudeVariation: [1, 1], // Low
  kernelVariation: [0, 0], // None
};

// ── Helpers ──────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampIdx<T>(levels: readonly T[], idx: number): number {
  return Math.max(0, Math.min(idx, levels.length - 1));
}

/**
 * Get the midpoint value between two level indices for a numerical field.
 * When both indices are the same, returns the exact level value.
 */
function midpoint<T>(levels: readonly T[], range: [number, number], field: keyof T): number {
  const lo = levels[clampIdx(levels, range[0])];
  const hi = levels[clampIdx(levels, range[1])];
  return lerp(lo[field] as number, hi[field] as number, 0.5);
}

/**
 * Get the CV (spread) implied by a range: half the distance between bounds.
 * Used to encode per-cell variation into CellVariationConfig spread fields.
 */
function rangeCv<T>(levels: readonly T[], range: [number, number], field: keyof T): number {
  const lo = levels[clampIdx(levels, range[0])];
  const hi = levels[clampIdx(levels, range[1])];
  return Math.abs((hi[field] as number) - (lo[field] as number)) / 2;
}

/**
 * Compose a full SimulationConfig from qualitative choices.
 *
 * For each step, the midpoint of the selected range sets the nominal value.
 * The width of the range sets the per-cell variation (CV field on each struct).
 */
export function buildSimulationConfig(
  q: QualitativeSimConfig,
  overrides?: {
    fs_hz?: number;
    num_timepoints?: number;
    num_cells?: number;
    seed?: number;
    spike_sim_hz?: number;
  },
): SimulationConfig {
  const preset = getSimulationPresetById(q.indicator);
  const presetKernel = preset
    ? preset.config.kernel
    : { tau_rise_s: 0.1, tau_decay_s: 0.6, tau_rise_cv: 0, tau_decay_cv: 0 };

  // Spike activity
  const spkLo = SPIKE_ACTIVITY_LEVELS[clampIdx(SPIKE_ACTIVITY_LEVELS, q.spikeActivity[0])];
  const spkHi = SPIKE_ACTIVITY_LEVELS[clampIdx(SPIKE_ACTIVITY_LEVELS, q.spikeActivity[1])];
  const pS2aMid = lerp(spkLo.p_silent_to_active, spkHi.p_silent_to_active, 0.5);
  const spikeModel: MarkovConfig = {
    model_type: 'markov',
    p_silent_to_active: pS2aMid,
    p_active_to_silent: lerp(spkLo.p_active_to_silent, spkHi.p_active_to_silent, 0.5),
    p_spike_when_active: lerp(spkLo.p_spike_when_active, spkHi.p_spike_when_active, 0.5),
    p_spike_when_silent: lerp(spkLo.p_spike_when_silent, spkHi.p_spike_when_silent, 0.5),
    p_silent_to_active_cv:
      rangeCv(SPIKE_ACTIVITY_LEVELS, q.spikeActivity, 'p_silent_to_active') /
      Math.max(pS2aMid, 1e-6),
  };

  // Noise
  const snrMid = midpoint(NOISE_LEVELS, q.noise, 'snr');
  const noiseLo = NOISE_LEVELS[clampIdx(NOISE_LEVELS, q.noise[0])];
  const noiseHi = NOISE_LEVELS[clampIdx(NOISE_LEVELS, q.noise[1])];
  const noiseConfig: NoiseConfig = {
    snr: snrMid,
    shot_noise_enabled: noiseLo.shot_noise_enabled || noiseHi.shot_noise_enabled,
    shot_noise_fraction: Math.max(noiseLo.shot_noise_fraction, noiseHi.shot_noise_fraction),
    snr_spread: rangeCv(NOISE_LEVELS, q.noise, 'snr'),
  };

  // Drift
  const driftMidStep = midpoint(DRIFT_LEVELS, q.drift, 'step_std_fraction');
  const driftConfig: RandomWalkDrift = {
    model_type: 'random_walk',
    step_std_fraction: driftMidStep,
    mean_reversion: midpoint(DRIFT_LEVELS, q.drift, 'mean_reversion'),
    step_std_cv:
      driftMidStep > 0 ? rangeCv(DRIFT_LEVELS, q.drift, 'step_std_fraction') / driftMidStep : 0,
  };

  // Photobleaching
  const pbLo = PHOTOBLEACHING_LEVELS[clampIdx(PHOTOBLEACHING_LEVELS, q.photobleaching[0])];
  const pbHi = PHOTOBLEACHING_LEVELS[clampIdx(PHOTOBLEACHING_LEVELS, q.photobleaching[1])];
  const pbAmpMid = lerp(pbLo.amplitude_fraction, pbHi.amplitude_fraction, 0.5);
  const photobleachingConfig: PhotobleachingConfig = {
    enabled: pbLo.enabled || pbHi.enabled,
    decay_time_constant_s: lerp(pbLo.decay_time_constant_s, pbHi.decay_time_constant_s, 0.5),
    amplitude_fraction: pbAmpMid,
    amplitude_cv:
      pbAmpMid > 0
        ? rangeCv(PHOTOBLEACHING_LEVELS, q.photobleaching, 'amplitude_fraction') / pbAmpMid
        : 0,
  };

  // Saturation
  const satLo = SATURATION_LEVELS[clampIdx(SATURATION_LEVELS, q.saturation[0])];
  const satHi = SATURATION_LEVELS[clampIdx(SATURATION_LEVELS, q.saturation[1])];
  const kdMid = lerp(satLo.k_d, satHi.k_d, 0.5);
  const saturationConfig: SaturationConfig = {
    enabled: satLo.enabled || satHi.enabled,
    hill_coefficient: lerp(satLo.hill_coefficient, satHi.hill_coefficient, 0.5),
    k_d: kdMid,
    k_d_cv: kdMid > 0 ? rangeCv(SATURATION_LEVELS, q.saturation, 'k_d') / kdMid : 0,
  };

  // Amplitude variation
  const alphaCv = midpoint(AMPLITUDE_VARIATION_LEVELS, q.amplitudeVariation, 'alpha_cv');

  // Kernel variation (CV fields co-located on KernelConfig)
  const kernel = {
    tau_rise_s: presetKernel.tau_rise_s,
    tau_decay_s: presetKernel.tau_decay_s,
    tau_rise_cv: midpoint(KERNEL_VARIATION_LEVELS, q.kernelVariation, 'tau_rise_cv'),
    tau_decay_cv: midpoint(KERNEL_VARIATION_LEVELS, q.kernelVariation, 'tau_decay_cv'),
  };

  return {
    fs_hz: overrides?.fs_hz ?? 30,
    num_timepoints: overrides?.num_timepoints ?? 27000,
    num_cells: overrides?.num_cells ?? 100,
    seed: overrides?.seed ?? 42,
    spike_sim_hz: overrides?.spike_sim_hz ?? 300,
    kernel,
    spike_model: spikeModel,
    noise: noiseConfig,
    drift: driftConfig,
    photobleaching: photobleachingConfig,
    saturation: saturationConfig,
    alpha_mean: 1.0,
    alpha_cv: alphaCv,
  };
}
