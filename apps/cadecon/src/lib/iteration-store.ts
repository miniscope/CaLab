import { createSignal, createMemo } from 'solid-js';

// --- Types ---

export type RunState = 'idle' | 'running' | 'paused' | 'stopping' | 'complete';

export interface KernelSnapshot {
  iteration: number;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
}

export interface TraceResultEntry {
  sCounts: Float32Array;
  alpha: number;
  baseline: number;
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

// --- Derived ---

const isRunning = createMemo(() => runState() === 'running');
const isPaused = createMemo(() => runState() === 'paused');
const progress = createMemo(() => {
  const total = totalSubsetTraceJobs();
  if (total === 0) return 0;
  return completedSubsetTraceJobs() / total;
});

// --- Actions ---

function resetIterationState(): void {
  setRunState('idle');
  setCurrentIteration(0);
  setTotalSubsetTraceJobs(0);
  setCompletedSubsetTraceJobs(0);
  setConvergenceHistory([]);
  setCurrentTauRise(null);
  setCurrentTauDecay(null);
  setPerTraceResults({});
}

function addConvergenceSnapshot(snapshot: KernelSnapshot): void {
  setConvergenceHistory((prev) => [...prev, snapshot]);
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
  isRunning,
  isPaused,
  progress,
  resetIterationState,
  addConvergenceSnapshot,
  updateTraceResult,
};
