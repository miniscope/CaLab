import { createSignal, createMemo } from 'solid-js';

// --- Types ---

export type RunState = 'idle' | 'running' | 'paused' | 'stopping' | 'complete';
export type RunPhase = 'idle' | 'inference' | 'kernel-update' | 'merge' | 'finalization';

export interface SubsetKernelSnapshot {
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  tauRiseFast: number;
  tauDecayFast: number;
  betaFast: number;
  hFree: Float32Array;
}

export interface KernelSnapshot {
  iteration: number;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  tauRiseFast: number;
  tauDecayFast: number;
  betaFast: number;
  fs: number;
  subsets: SubsetKernelSnapshot[];
}

export interface TraceResultEntry {
  cellIndex: number;
  subsetIdx: number; // -1 during finalization (no subset)
  sCounts: Float32Array;
  filteredTrace?: Float32Array;
  alpha: number;
  baseline: number;
  threshold: number;
  pve: number;
}

function cellSubsetKey(cellIndex: number, subsetIdx: number): string {
  return `${cellIndex}:${subsetIdx}`;
}

/** Snapshot of one cell's raw trace + deconvolved activity at a given iteration (for debug plotting). */
export interface DebugTraceSnapshot {
  iteration: number;
  cellIndex: number;
  rawTrace: Float32Array;
  sCounts: Float32Array;
  reconvolved: Float32Array;
  alpha: number;
  baseline: number;
  threshold: number;
  pve: number;
}

// --- Iteration History ---

export interface IterationHistoryEntry {
  iteration: number;
  results: Record<string, TraceResultEntry>;
  tauRise: number;
  tauDecay: number;
}

const MAX_HISTORY_ITERATIONS = 50;

// --- Signals ---

const [iterationHistory, setIterationHistory] = createSignal<IterationHistoryEntry[]>([]);
const [runState, setRunState] = createSignal<RunState>('idle');
const [currentIteration, setCurrentIteration] = createSignal(0);
const [totalSubsetTraceJobs, setTotalSubsetTraceJobs] = createSignal(0);
const [completedSubsetTraceJobs, setCompletedSubsetTraceJobs] = createSignal(0);
const [convergenceHistory, setConvergenceHistory] = createSignal<KernelSnapshot[]>([]);
const [currentTauRise, setCurrentTauRise] = createSignal<number | null>(null);
const [currentTauDecay, setCurrentTauDecay] = createSignal<number | null>(null);
const [perTraceResults, setPerTraceResults] = createSignal<Record<string, TraceResultEntry>>({});
const [debugTraceSnapshots, setDebugTraceSnapshots] = createSignal<DebugTraceSnapshot[]>([]);
const [runPhase, setRunPhase] = createSignal<RunPhase>('idle');
const [convergedAtIteration, setConvergedAtIteration] = createSignal<number | null>(null);

// --- Derived ---

/** True when the algorithm is actively running (not idle or complete). */
const isRunLocked = createMemo(() => runState() !== 'idle' && runState() !== 'complete');

const progress = createMemo(() => {
  const total = totalSubsetTraceJobs();
  if (total === 0) return 0;
  return completedSubsetTraceJobs() / total;
});

/** Per-cell lookup: returns the best result for a given cell (finalization preferred, else first seen). */
const cellResultLookup = createMemo(() => {
  const results = perTraceResults();
  const lookup = new Map<number, TraceResultEntry>();
  for (const entry of Object.values(results)) {
    const existing = lookup.get(entry.cellIndex);
    if (!existing || entry.subsetIdx === -1) {
      lookup.set(entry.cellIndex, entry);
    }
  }
  return lookup;
});

// Distribution memos derived from deduplicated per-cell results
const alphaValues = createMemo(() => [...cellResultLookup().values()].map((r) => r.alpha));

const pveValues = createMemo(() => [...cellResultLookup().values()].map((r) => r.pve));

const subsetVarianceData = createMemo(() => {
  const history = convergenceHistory();
  if (history.length === 0) return [];
  const latest = history[history.length - 1];
  return latest.subsets.map((s, idx) => ({
    subsetIdx: idx,
    tauRise: s.tauRise * 1000,
    tauDecay: s.tauDecay * 1000,
  }));
});

// --- Actions ---

function resetIterationState(): void {
  setRunState('idle');
  setRunPhase('idle');
  setCurrentIteration(0);
  setTotalSubsetTraceJobs(0);
  setCompletedSubsetTraceJobs(0);
  setConvergenceHistory([]);
  setCurrentTauRise(null);
  setCurrentTauDecay(null);
  setPerTraceResults({});
  setDebugTraceSnapshots([]);
  setConvergedAtIteration(null);
  setIterationHistory([]);
}

/** Snapshot current perTraceResults into the iteration history.
 *  Safe as a shallow copy: TraceResultEntry objects are replaced wholesale (never mutated),
 *  so historical snapshots remain stable. Consumers are read-only. */
function snapshotIteration(iteration: number, tauRise: number, tauDecay: number): void {
  const results = perTraceResults();
  setIterationHistory((prev) => {
    const next = [...prev, { iteration, results: { ...results }, tauRise, tauDecay }];
    return next.slice(-MAX_HISTORY_ITERATIONS);
  });
}

function addConvergenceSnapshot(snapshot: KernelSnapshot): void {
  setConvergenceHistory((prev) => [...prev, snapshot]);
}

function addDebugTraceSnapshot(snapshot: DebugTraceSnapshot): void {
  setDebugTraceSnapshots((prev) => [...prev, snapshot]);
}

function updateTraceResult(key: string, result: TraceResultEntry): void {
  setPerTraceResults((prev) => ({ ...prev, [key]: result }));
}

/** Merge many entries into perTraceResults in a single spread (one reactive update). */
function bulkUpdateTraceResults(entries: Record<string, TraceResultEntry>): void {
  setPerTraceResults((prev) => ({ ...prev, ...entries }));
}

export {
  runState,
  setRunState,
  currentIteration,
  setCurrentIteration,
  totalSubsetTraceJobs,
  setTotalSubsetTraceJobs,
  completedSubsetTraceJobs,
  setCompletedSubsetTraceJobs,
  convergenceHistory,
  currentTauRise,
  setCurrentTauRise,
  currentTauDecay,
  setCurrentTauDecay,
  debugTraceSnapshots,
  runPhase,
  setRunPhase,
  convergedAtIteration,
  setConvergedAtIteration,
  alphaValues,
  pveValues,
  cellResultLookup,
  subsetVarianceData,
  isRunLocked,
  progress,
  iterationHistory,
  resetIterationState,
  addConvergenceSnapshot,
  addDebugTraceSnapshot,
  updateTraceResult,
  bulkUpdateTraceResults,
  snapshotIteration,
  cellSubsetKey,
};
