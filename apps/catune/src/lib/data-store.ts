// Reactive data store for the CaTune import pipeline
// Uses SolidJS signals for fine-grained reactivity

import { createSignal, createMemo } from 'solid-js';
import type { NpyResult, NpzResult, ValidationResult, ImportStep } from '@calab/core';
import {
  generateSyntheticDataset,
  getSimulationPresetById,
  DEFAULT_SIMULATION_PRESET_ID,
} from '@calab/compute';
import { fetchBridgeData, validateTraceData } from '@calab/io';
import type { SimulationPreset } from '@calab/compute';

// --- Core Signals ---

const [rawFile, setRawFile] = createSignal<File | null>(null);
const [parsedData, setParsedData] = createSignal<NpyResult | null>(null);
const [dimensionsConfirmed, setDimensionsConfirmed] = createSignal<boolean>(false);
const [swapped, setSwapped] = createSignal<boolean>(false);
const [samplingRate, setSamplingRate] = createSignal<number | null>(null);
const [validationResult, setValidationResult] = createSignal<ValidationResult | null>(null);
const [npzArrays, setNpzArrays] = createSignal<NpzResult | null>(null);
const [selectedNpzArray, setSelectedNpzArray] = createSignal<string | null>(null);
const [importError, setImportError] = createSignal<string | null>(null);
const [demoPreset, setDemoPreset] = createSignal<SimulationPreset | null>(null);
const [bridgeUrl, setBridgeUrl] = createSignal<string | null>(null);
const [bridgeExportDone, setBridgeExportDone] = createSignal(false);

/** Tracks how data was loaded: 'file' (user upload), 'demo' (generated), 'bridge' (Python calab.tune). */
export type DataSource = 'file' | 'demo' | 'bridge' | null;
const [dataSource, setDataSource] = createSignal<DataSource>(null);

// --- Ground Truth Signals ---

const [groundTruthSpikes, setGroundTruthSpikes] = createSignal<Float64Array | null>(null);
const [groundTruthCalcium, setGroundTruthCalcium] = createSignal<Float64Array | null>(null);
const [groundTruthVisible, setGroundTruthVisible] = createSignal(false);
const [groundTruthLocked, setGroundTruthLocked] = createSignal(false);

// --- Derived State ---

const effectiveShape = createMemo<[number, number] | null>(() => {
  const data = parsedData();
  if (!data || data.shape.length < 2) return null;
  const [rows, cols] = data.shape;
  return swapped() ? [cols, rows] : [rows, cols];
});

const numCells = createMemo(() => effectiveShape()?.[0] ?? 0);

const numTimepoints = createMemo(() => effectiveShape()?.[1] ?? 0);

const durationSeconds = createMemo<number | null>(() => {
  const rate = samplingRate();
  const tp = numTimepoints();
  return rate && tp ? tp / rate : null;
});

/** True when loaded data is demo-generated. */
const isDemo = createMemo(() => dataSource() === 'demo');

const importStep = createMemo<ImportStep>(() => {
  if (!parsedData()) return 'drop';
  if (!dimensionsConfirmed()) return 'confirm-dims';
  if (!samplingRate()) return 'sampling-rate';
  if (!validationResult()) return 'validation';
  return 'ready';
});

// --- Ground Truth Actions ---

function revealGroundTruth() {
  setGroundTruthVisible(true);
  setGroundTruthLocked(true);
}

function toggleGroundTruthVisibility() {
  if (groundTruthLocked()) setGroundTruthVisible((v) => !v);
}

function getGroundTruthForCell(
  cellIndex: number,
): { spikes: Float64Array; calcium: Float64Array } | null {
  const spikes = groundTruthSpikes();
  const calcium = groundTruthCalcium();
  const tp = numTimepoints();
  if (!spikes || !calcium || tp === 0) return null;
  const offset = cellIndex * tp;
  return {
    spikes: spikes.subarray(offset, offset + tp),
    calcium: calcium.subarray(offset, offset + tp),
  };
}

// --- Demo Data ---

function loadDemoData(opts?: {
  numCells?: number;
  durationMinutes?: number;
  fps?: number;
  presetId?: string;
  seed?: number | 'random';
}): void {
  const preset = getSimulationPresetById(opts?.presetId ?? DEFAULT_SIMULATION_PRESET_ID);
  if (!preset) return;

  const cfg = preset.config;
  const fs = opts?.fps ?? cfg.fs_hz;
  const cellCount = opts?.numCells ?? cfg.num_cells;
  const durationMin = opts?.durationMinutes ?? 15;
  const timepointCount = Math.round(durationMin * 60 * fs);

  const resolvedSeed =
    opts?.seed === 'random' ? Math.floor(Math.random() * 2 ** 31) : (opts?.seed ?? cfg.seed);

  // Generate using TS engine with params extracted from the new SimulationConfig
  const simParams = {
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

  const {
    data,
    shape,
    groundTruthSpikes: gtSpikes,
    groundTruthCalcium: gtCalcium,
  } = generateSyntheticDataset(cellCount, timepointCount, simParams, fs, resolvedSeed);

  setGroundTruthSpikes(gtSpikes);
  setGroundTruthCalcium(gtCalcium);
  setGroundTruthVisible(false);
  setGroundTruthLocked(false);
  setDemoPreset(preset);
  setDataSource('demo');
  setParsedData({ data, shape, dtype: '<f8', fortranOrder: false });
  setDimensionsConfirmed(true);
  setSwapped(false);
  setSamplingRate(fs);
  setValidationResult({
    isValid: true,
    warnings: [],
    errors: [],
    stats: {
      min: -1,
      max: 5,
      mean: 0.5,
      nanCount: 0,
      infCount: 0,
      negativeCount: 0,
      totalElements: cellCount * timepointCount,
    },
  });
}

// --- Bridge Data ---

async function loadFromBridge(url: string): Promise<void> {
  setBridgeUrl(url);
  setDataSource('bridge');
  try {
    const { traces, metadata } = await fetchBridgeData(url);
    const fs = metadata.sampling_rate_hz;

    setParsedData(traces);
    setDimensionsConfirmed(true);
    setSwapped(false);
    setSamplingRate(fs);

    // Run validation on the loaded data
    const data = traces.data as Float64Array | Float32Array;
    const validation = validateTraceData(data, traces.shape);
    setValidationResult(validation);
  } catch (err) {
    setImportError(err instanceof Error ? err.message : 'Bridge loading failed');
    setBridgeUrl(null);
  }
}

// --- Reset ---

function resetImport(): void {
  setRawFile(null);
  setParsedData(null);
  setDataSource(null);
  setDimensionsConfirmed(false);
  setSwapped(false);
  setSamplingRate(null);
  setValidationResult(null);
  setNpzArrays(null);
  setSelectedNpzArray(null);
  setImportError(null);
  setDemoPreset(null);
  setGroundTruthSpikes(null);
  setGroundTruthCalcium(null);
  setGroundTruthVisible(false);
  setGroundTruthLocked(false);
}

// --- Exports ---

export {
  // Getters (signals)
  rawFile,
  parsedData,
  dimensionsConfirmed,
  swapped,
  samplingRate,
  validationResult,
  npzArrays,
  selectedNpzArray,
  importError,
  // Setters
  setRawFile,
  setParsedData,
  setDimensionsConfirmed,
  setSwapped,
  setSamplingRate,
  setValidationResult,
  setNpzArrays,
  setSelectedNpzArray,
  setImportError,
  // Derived
  effectiveShape,
  numCells,
  numTimepoints,
  durationSeconds,
  importStep,
  isDemo,
  demoPreset,
  // Ground Truth
  groundTruthSpikes,
  groundTruthCalcium,
  groundTruthVisible,
  groundTruthLocked,
  revealGroundTruth,
  toggleGroundTruthVisibility,
  getGroundTruthForCell,
  // Actions
  resetImport,
  loadDemoData,
  loadFromBridge,
  // Bridge
  bridgeUrl,
  bridgeExportDone,
  setBridgeExportDone,
  // Data source tracking
  dataSource,
  setDataSource,
};
