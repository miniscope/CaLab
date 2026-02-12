// Reactive data store for the CaTune import pipeline
// Uses SolidJS signals for fine-grained reactivity

import { createSignal, createMemo } from 'solid-js';
import type {
  NpyResult,
  NpzResult,
  ValidationResult,
  ImportStep,
} from './types';
import { generateSyntheticDataset } from './chart/mock-traces';

// --- Core Signals ---

const [rawFile, setRawFile] = createSignal<File | null>(null);
const [parsedData, setParsedData] = createSignal<NpyResult | null>(null);
const [dimensionsConfirmed, setDimensionsConfirmed] =
  createSignal<boolean>(false);
const [swapped, setSwapped] = createSignal<boolean>(false);
const [samplingRate, setSamplingRate] = createSignal<number | null>(null);
const [validationResult, setValidationResult] =
  createSignal<ValidationResult | null>(null);
const [npzArrays, setNpzArrays] = createSignal<NpzResult | null>(null);
const [selectedNpzArray, setSelectedNpzArray] = createSignal<string | null>(
  null,
);
const [importError, setImportError] = createSignal<string | null>(null);

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

const importStep = createMemo<ImportStep>(() => {
  if (!parsedData()) return 'drop';
  if (!dimensionsConfirmed()) return 'confirm-dims';
  if (!samplingRate()) return 'sampling-rate';
  if (!validationResult()) return 'validation';
  return 'ready';
});

// --- Demo Data ---

function loadDemoData(opts?: { numCells?: number; durationMinutes?: number; fps?: number }): void {
  const fs = opts?.fps ?? 30;
  const numCells = opts?.numCells ?? 20;
  const durationMin = opts?.durationMinutes ?? 5;
  const numTimepoints = Math.round(durationMin * 60 * fs);
  const { data, shape } = generateSyntheticDataset(numCells, numTimepoints, 0.02, 0.4, fs);

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
  // Actions
  resetImport,
  loadDemoData,
};
