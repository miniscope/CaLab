import { createSignal, createMemo } from 'solid-js';

// --- Types ---

export type RunState = 'idle' | 'running' | 'paused' | 'stopping' | 'complete';
export type RunPhase = 'idle' | 'inference' | 'kernel-update' | 'merge' | 'finalization';

export interface SubsetKernelSnapshot {
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  hFree: Float32Array;
}

export interface KernelSnapshot {
  iteration: number;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  fs: number;
  subsets: SubsetKernelSnapshot[];
}

export interface TraceResultEntry {
  sCounts: Float32Array;
  alpha: number;
  baseline: number;
  pve: number;
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

// --- Signals ---

const [runState, setRunState] = createSignal<RunState>('idle');
const [currentIteration, setCurrentIteration] = createSignal(0);
const [totalSubsetTraceJobs, setTotalSubsetTraceJobs] = createSignal(0);
const [completedSubsetTraceJobs, setCompletedSubsetTraceJobs] = createSignal(0);
const [convergenceHistory, setConvergenceHistory] = createSignal<KernelSnapshot[]>([]);
const [currentTauRise, setCurrentTauRise] = createSignal<number | null>(null);
const [currentTauDecay, setCurrentTauDecay] = createSignal<number | null>(null);
const [perTraceResults, setPerTraceResults] = createSignal<Record<number, TraceResultEntry>>({});
const [debugTraceSnapshots, setDebugTraceSnapshots] = createSignal<DebugTraceSnapshot[]>([]);
const [runPhase, setRunPhase] = createSignal<RunPhase>('idle');
const [convergedAtIteration, setConvergedAtIteration] = createSignal<number | null>(null);

// --- Derived ---

const progress = createMemo(() => {
  const total = totalSubsetTraceJobs();
  if (total === 0) return 0;
  return completedSubsetTraceJobs() / total;
});

// Distribution memos derived from perTraceResults
const alphaValues = createMemo(() => Object.values(perTraceResults()).map((r) => r.alpha));

const pveValues = createMemo(() => Object.values(perTraceResults()).map((r) => r.pve));

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
}

function addConvergenceSnapshot(snapshot: KernelSnapshot): void {
  setConvergenceHistory((prev) => [...prev, snapshot]);
}

function addDebugTraceSnapshot(snapshot: DebugTraceSnapshot): void {
  setDebugTraceSnapshots((prev) => [...prev, snapshot]);
}

function updateTraceResult(cellIndex: number, result: TraceResultEntry): void {
  setPerTraceResults((prev) => ({ ...prev, [cellIndex]: result }));
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
  perTraceResults,
  debugTraceSnapshots,
  runPhase,
  setRunPhase,
  convergedAtIteration,
  setConvergedAtIteration,
  alphaValues,
  pveValues,
  subsetVarianceData,
  progress,
  resetIterationState,
  addConvergenceSnapshot,
  addDebugTraceSnapshot,
  updateTraceResult,
};
