import { createSignal, createMemo } from 'solid-js';
import type { NpyResult, NpzResult, ValidationResult, ImportStep } from '@calab/core';
import { generateSyntheticDataset, getPresetById, DEFAULT_PRESET_ID } from '@calab/compute';
import { fetchBridgeData, validateTraceData } from '@calab/io';
import type { DemoPreset } from '@calab/compute';

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
const [bridgeUrl, setBridgeUrl] = createSignal<string | null>(null);

/** Tracks how data was loaded: 'file' (user upload), 'demo' (generated), 'bridge' (Python calab.tune). */
export type DataSource = 'file' | 'demo' | 'bridge' | null;
const [dataSource, setDataSource] = createSignal<DataSource>(null);

// ── Phase 2: ground truth & advanced features (not yet wired to UI) ────────

const [demoPreset, setDemoPreset] = createSignal<DemoPreset | null>(null);
const [bridgeExportDone, setBridgeExportDone] = createSignal(false);
const [groundTruthSpikes, setGroundTruthSpikes] = createSignal<Float64Array | null>(null);
const [groundTruthCalcium, setGroundTruthCalcium] = createSignal<Float64Array | null>(null);
const [groundTruthVisible, setGroundTruthVisible] = createSignal(false);
const [groundTruthLocked, setGroundTruthLocked] = createSignal(false);
const [groundTruthTauRise, setGroundTruthTauRise] = createSignal<number | null>(null);
const [groundTruthTauDecay, setGroundTruthTauDecay] = createSignal<number | null>(null);

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

// ── Phase 2: ground truth actions (not yet wired to UI) ────────────────────

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
  const fs = opts?.fps ?? 30;
  const cellCount = opts?.numCells ?? 100;
  const durationMin = opts?.durationMinutes ?? 15;
  const timepointCount = Math.round(durationMin * 60 * fs);

  const preset = getPresetById(opts?.presetId ?? DEFAULT_PRESET_ID);
  if (!preset) return;

  const resolvedSeed =
    opts?.seed === 'random' ? Math.floor(Math.random() * 2 ** 31) : (opts?.seed ?? 42);

  const {
    data,
    shape,
    groundTruthSpikes: gtSpikes,
    groundTruthCalcium: gtCalcium,
  } = generateSyntheticDataset(cellCount, timepointCount, preset.params, fs, resolvedSeed);

  setGroundTruthSpikes(gtSpikes);
  setGroundTruthCalcium(gtCalcium);
  setGroundTruthVisible(false);
  setGroundTruthLocked(false);
  setGroundTruthTauRise(preset.params.tauRise);
  setGroundTruthTauDecay(preset.params.tauDecay);
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
  setGroundTruthTauRise(null);
  setGroundTruthTauDecay(null);
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
  // Actions
  resetImport,
  loadDemoData,
  loadFromBridge,
  // Bridge
  bridgeUrl,
  // Data source tracking
  dataSource,
  setDataSource,

  // ── Phase 2: ground truth & advanced features (not yet wired to UI) ──
  selectedNpzArray,
  demoPreset,
  bridgeExportDone,
  setBridgeExportDone,
  groundTruthSpikes,
  groundTruthCalcium,
  groundTruthVisible,
  groundTruthLocked,
  groundTruthTauRise,
  groundTruthTauDecay,
  revealGroundTruth,
  toggleGroundTruthVisibility,
  getGroundTruthForCell,
};
