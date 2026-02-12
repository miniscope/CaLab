/**
 * Demo data simulation presets.
 * Each preset defines biophysical parameters for synthetic trace generation.
 *
 * Internal reference (not exposed to users):
 *   config-1 → modeled on GCaMP6f
 *   config-2 → modeled on GCaMP6s
 *   config-3 → modeled on GCaMP6m
 *   config-4 → modeled on jGCaMP8f
 *   config-5 → modeled on OGB-1 (synthetic dye)
 *   config-6 → legacy hardcoded values
 */

export interface MarkovParams {
  pSilentToActive: number;
  pActiveToSilent: number;
  pSpikeWhenActive: number;
  pSpikeWhenSilent: number;
}

export interface NoiseParams {
  amplitudeSigma: number;
  driftAmplitude: number;
  driftCyclesMin: number;
  driftCyclesMax: number;
}

export interface SimulationParams {
  tauRise: number;
  tauDecay: number;
  snrBase: number;
  snrStep: number;
  markov: MarkovParams;
  noise: NoiseParams;
}

export interface DemoPreset {
  id: string;
  label: string;
  description: string;
  params: SimulationParams;
}

const DEFAULT_MARKOV: MarkovParams = {
  pSilentToActive: 0.02,
  pActiveToSilent: 0.15,
  pSpikeWhenActive: 0.7,
  pSpikeWhenSilent: 0.005,
};

const DEFAULT_NOISE: NoiseParams = {
  amplitudeSigma: 0.3,
  driftAmplitude: 0.1,
  driftCyclesMin: 2,
  driftCyclesMax: 4,
};

export const DEMO_PRESETS: DemoPreset[] = [
  // modeled on GCaMP6f
  {
    id: 'config-1',
    label: 'Demo Config 1',
    description: 'Default configuration',
    params: {
      tauRise: 0.10,
      tauDecay: 0.60,
      snrBase: 20,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
  // modeled on GCaMP6s
  {
    id: 'config-2',
    label: 'Demo Config 2',
    description: 'Configuration 2',
    params: {
      tauRise: 0.40,
      tauDecay: 1.80,
      snrBase: 25,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
  // modeled on GCaMP6m
  {
    id: 'config-3',
    label: 'Demo Config 3',
    description: 'Configuration 3',
    params: {
      tauRise: 0.15,
      tauDecay: 0.90,
      snrBase: 22,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
  // modeled on jGCaMP8f
  {
    id: 'config-4',
    label: 'Demo Config 4',
    description: 'Configuration 4',
    params: {
      tauRise: 0.03,
      tauDecay: 0.30,
      snrBase: 18,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
  // modeled on OGB-1 (synthetic dye)
  {
    id: 'config-5',
    label: 'Demo Config 5',
    description: 'Configuration 5',
    params: {
      tauRise: 0.05,
      tauDecay: 1.50,
      snrBase: 15,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
  // legacy hardcoded values
  {
    id: 'config-6',
    label: 'Demo Config 6',
    description: 'Legacy configuration',
    params: {
      tauRise: 0.02,
      tauDecay: 0.40,
      snrBase: 20,
      snrStep: 2,
      markov: { ...DEFAULT_MARKOV },
      noise: { ...DEFAULT_NOISE },
    },
  },
];

export const DEFAULT_PRESET_ID = 'config-1';

export function getPresetById(id: string): DemoPreset | undefined {
  return DEMO_PRESETS.find((p) => p.id === id);
}

export function getPresetLabels(): { id: string; label: string }[] {
  return DEMO_PRESETS.map((p) => ({ id: p.id, label: p.label }));
}
