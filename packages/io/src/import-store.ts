/**
 * Reactive import store shared by the CaLab apps.
 *
 * Owns everything between "no data" and "data ready": the dropped file and how
 * it was parsed, .npz/.mat array selection, dimension swap/confirmation, the
 * sampling rate, validation, demo-data generation (with ground truth), and
 * loading from the Python bridge. It also tracks where the data came from
 * (`dataSource`), which the community submission flow maps to its own
 * vocabulary with `toCommunityDataSource` (@calab/community-ui).
 *
 * Each app creates one store at module scope (`lib/data-store.ts`) and
 * re-exports its members, so app code keeps importing plain signals:
 *
 *   export const importStore = createImportStore({ appName: 'CaTune', simulate });
 *   export const { parsedData, samplingRate, ... } = importStore;
 *
 * The shared import components in `@calab/ui/import` take the store as a prop.
 */

import { createMemo, createSignal } from 'solid-js';
import type { DataSource, ImportStep, NpyResult, NpzResult, ValidationResult } from '@calab/core';
import { buildSimulationConfig, DEFAULT_QUALITATIVE_CONFIG } from '@calab/compute';
import type {
  IndicatorId,
  QualitativeSimConfig,
  SimulationConfig,
  SimulationResult,
} from '@calab/compute';
import { parseNpy } from './npy-parser.ts';
import { parseNpz } from './npz-parser.ts';
import { parseMat } from './mat-parser.ts';
import { processNpyResult } from './array-utils.ts';
import { validateTraceData } from './validation.ts';
import { fetchBridgeData as defaultFetchBridgeData } from './bridge.ts';
import { soleTraceCandidate, traceCandidates } from './trace-candidates.ts';

/** File extensions the import pipeline accepts (lower case, no dot). */
export const IMPORT_FILE_EXTENSIONS = ['npy', 'npz', 'mat'] as const;

/** Options for {@link ImportStore.loadDemoData}. Every field has a default. */
export interface DemoDataOptions {
  numCells?: number;
  durationMinutes?: number;
  fps?: number;
  qualitativeConfig?: QualitativeSimConfig;
  seed?: number | 'random';
}

export interface ImportStoreOptions {
  /** App display name used in user-facing messages, e.g. 'CaTune'. */
  appName: string;
  /**
   * Run the simulator for demo data, normally `simulate_traces` from
   * `@calab/core/wasm` after `initWasm()`. Injected rather than imported so
   * this package (and every bundle that only parses files with it) stays free
   * of the wasm glue, the same rule as the `@calab/core` barrel.
   */
  simulate: (config: SimulationConfig) => Promise<SimulationResult>;
  /** Fetch traces + metadata from the bridge. Defaults to `fetchBridgeData`. */
  fetchBridgeData?: typeof defaultFetchBridgeData;
}

/**
 * Create an import store. Call once per app, at module scope (Solid signals
 * created outside a root live for the page's lifetime, which is intended).
 */
export function createImportStore(options: ImportStoreOptions) {
  const fetchBridge = options.fetchBridgeData ?? defaultFetchBridgeData;

  // --- Core signals ---
  const [rawFile, setRawFile] = createSignal<File | null>(null);
  const [parsedData, setParsedData] = createSignal<NpyResult | null>(null);
  const [dimensionsConfirmed, setDimensionsConfirmed] = createSignal<boolean>(false);
  const [swapped, setSwapped] = createSignal<boolean>(false);
  const [samplingRate, setSamplingRate] = createSignal<number | null>(null);
  const [validationResult, setValidationResult] = createSignal<ValidationResult | null>(null);
  const [npzArrays, setNpzArrays] = createSignal<NpzResult | null>(null);
  const [selectedNpzArray, setSelectedNpzArray] = createSignal<string | null>(null);
  const [importError, setImportError] = createSignal<string | null>(null);
  const [demoConfig, setDemoConfig] = createSignal<SimulationConfig | null>(null);
  /** The simulator settings the current demo dataset was generated from.
   *  `demoConfig` is built from these but drops the indicator id the community
   *  browser filters on, so keep the source config too. */
  const [demoSimConfig, setDemoSimConfig] = createSignal<QualitativeSimConfig | null>(null);
  const demoIndicator = (): IndicatorId | null => demoSimConfig()?.indicator ?? null;

  // --- Bridge signals ---
  const [bridgeUrl, setBridgeUrl] = createSignal<string | null>(null);
  const [bridgeExportDone, setBridgeExportDone] = createSignal(false);
  const [bridgeExportError, setBridgeExportError] = createSignal<string | null>(null);

  /** How the current data was loaded; null before any load. */
  const [dataSource, setDataSource] = createSignal<DataSource | null>(null);

  // --- Ground truth (demo data only) ---
  const [groundTruthSpikes, setGroundTruthSpikes] = createSignal<Float64Array | null>(null);
  const [groundTruthCalcium, setGroundTruthCalcium] = createSignal<Float64Array | null>(null);
  const [groundTruthVisible, setGroundTruthVisible] = createSignal(false);
  const [groundTruthLocked, setGroundTruthLocked] = createSignal(false);
  const [groundTruthTauRise, setGroundTruthTauRise] = createSignal<number | null>(null);
  const [groundTruthTauDecay, setGroundTruthTauDecay] = createSignal<number | null>(null);

  // --- Derived state ---
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

  // --- Ground truth actions ---
  function revealGroundTruth(): void {
    setGroundTruthVisible(true);
    setGroundTruthLocked(true);
  }

  function toggleGroundTruthVisibility(): void {
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

  // --- File import ---

  /** Load the trace matrix from a multi-array container (.npz / .mat), or
   *  hand off to the array selector when the choice is ambiguous. */
  function handleMultiArrayResult(result: NpzResult, ext: string): void {
    if (traceCandidates(result).length === 0) {
      setImportError(
        `No trace matrix found in .${ext} file. ${options.appName} requires a 2D array (cells x timepoints).`,
      );
      return;
    }
    const sole = soleTraceCandidate(result);
    if (sole !== null) {
      setParsedData(processNpyResult(result.arrays[sole]));
    } else {
      setNpzArrays(result);
    }
  }

  /**
   * Parse a dropped/selected .npy, .npz or .mat file into the store. Errors are
   * reported through `importError`, never thrown.
   */
  async function importFile(file: File): Promise<void> {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !(IMPORT_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      setImportError(
        `Unsupported file format: .${ext ?? 'unknown'}. Please use .npy, .npz, or .mat files.`,
      );
      return;
    }

    setImportError(null);
    setRawFile(file);
    setDataSource('file');

    try {
      const buffer = await file.arrayBuffer();
      if (ext === 'npz') {
        handleMultiArrayResult(parseNpz(buffer), 'npz');
      } else if (ext === 'mat') {
        handleMultiArrayResult(parseMat(buffer), 'mat');
      } else {
        setParsedData(processNpyResult(parseNpy(buffer)));
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unknown error reading file');
    }
  }

  /** Load one array from the pending .npz/.mat container (the array selector). */
  function selectNpzArray(name: string): void {
    const npz = npzArrays();
    if (!npz) return;
    try {
      setParsedData(processNpyResult(npz.arrays[name]));
      setSelectedNpzArray(name);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Error loading array');
    }
  }

  // --- Demo data ---
  async function loadDemoData(opts?: DemoDataOptions): Promise<void> {
    const q = opts?.qualitativeConfig ?? DEFAULT_QUALITATIVE_CONFIG;
    const fs = opts?.fps ?? 30;
    const cellCount = opts?.numCells ?? 100;
    const durationMin = opts?.durationMinutes ?? 15;
    const timepointCount = Math.round(durationMin * 60 * fs);
    const resolvedSeed =
      opts?.seed === 'random' ? Math.floor(Math.random() * 2 ** 31) : (opts?.seed ?? 42);

    const cfg = buildSimulationConfig(q, {
      fs_hz: fs,
      num_timepoints: timepointCount,
      num_cells: cellCount,
      seed: resolvedSeed,
    });

    const result = await options.simulate(cfg);

    // Flat ground-truth arrays for the per-cell accessor.
    const gtSpikes = new Float64Array(cellCount * timepointCount);
    const gtCalcium = new Float64Array(cellCount * timepointCount);
    for (let c = 0; c < result.ground_truth.length; c++) {
      const gt = result.ground_truth[c];
      const offset = c * timepointCount;
      gtSpikes.set(gt.spikes, offset);
      gtCalcium.set(gt.clean_calcium, offset);
    }

    // f32 traces -> f64 for NpyResult compatibility.
    const data = Float64Array.from(result.traces);

    setGroundTruthSpikes(gtSpikes);
    setGroundTruthCalcium(gtCalcium);
    setGroundTruthVisible(false);
    setGroundTruthLocked(false);
    setGroundTruthTauRise(cfg.kernel.tau_rise_s);
    setGroundTruthTauDecay(cfg.kernel.tau_decay_s);
    setDemoConfig(cfg);
    setDemoSimConfig(q);
    setDataSource('demo');
    setParsedData({ data, shape: [cellCount, timepointCount], dtype: '<f8', fortranOrder: false });
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

  // --- Bridge data ---
  async function loadFromBridge(url: string): Promise<void> {
    setBridgeUrl(url);
    setDataSource('bridge');
    try {
      const { traces, metadata } = await fetchBridge(url);
      setParsedData(traces);
      setDimensionsConfirmed(true);
      setSwapped(false);
      setSamplingRate(metadata.sampling_rate_hz);
      const data = traces.data as Float64Array | Float32Array;
      setValidationResult(validateTraceData(data, traces.shape));
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
    setDemoConfig(null);
    setDemoSimConfig(null);
    setGroundTruthSpikes(null);
    setGroundTruthCalcium(null);
    setGroundTruthVisible(false);
    setGroundTruthLocked(false);
    setGroundTruthTauRise(null);
    setGroundTruthTauDecay(null);
  }

  return {
    // Signals
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
    demoConfig,
    demoIndicator,
    // Actions
    importFile,
    selectNpzArray,
    resetImport,
    loadDemoData,
    loadFromBridge,
    // Bridge
    bridgeUrl,
    bridgeExportDone,
    setBridgeExportDone,
    bridgeExportError,
    setBridgeExportError,
    // Data source tracking
    dataSource,
    setDataSource,
    // Ground truth
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
}

/** The store returned by {@link createImportStore}. */
export type ImportStore = ReturnType<typeof createImportStore>;
