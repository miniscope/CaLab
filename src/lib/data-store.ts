// Reactive data store for the CaTune import pipeline
// Uses SolidJS signals for fine-grained reactivity

import { createSignal, createMemo } from 'solid-js';
import type { NpyResult, NpzResult, ValidationResult, ImportStep } from './types.ts';
import { generateSyntheticDataset } from './chart/mock-traces.ts';
import type { DemoPreset } from './chart/demo-presets.ts';
import { getPresetById, DEFAULT_PRESET_ID } from './chart/demo-presets.ts';

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
const [demoPreset, setDemoPreset] = createSignal<DemoPreset | null>(null);

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

/** True when loaded data is demo-generated (parsedData present but no rawFile). */
const isDemo = createMemo(() => parsedData() !== null && rawFile() === null);

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
  const fs = opts?.fps ?? 30;
  const numCells = opts?.numCells ?? 20;
  const durationMin = opts?.durationMinutes ?? 5;
  const numTimepoints = Math.round(durationMin * 60 * fs);

  const preset = getPresetById(opts?.presetId ?? DEFAULT_PRESET_ID);
  if (!preset) return;

  const resolvedSeed =
    opts?.seed === 'random' ? Math.floor(Math.random() * 2 ** 31) : (opts?.seed ?? 42);

  const {
    data,
    shape,
    groundTruthSpikes: gtSpikes,
    groundTruthCalcium: gtCalcium,
  } = generateSyntheticDataset(numCells, numTimepoints, preset.params, fs, resolvedSeed);

  setGroundTruthSpikes(gtSpikes);
  setGroundTruthCalcium(gtCalcium);
  setGroundTruthVisible(false);
  setGroundTruthLocked(false);
  setDemoPreset(preset);
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
      totalElements: numCells * numTimepoints,
    },
  });
}

// --- Reset ---

function resetImport(): void {
  setRawFile(null);
  setParsedData(null);
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
};
