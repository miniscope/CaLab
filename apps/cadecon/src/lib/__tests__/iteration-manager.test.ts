/**
 * Tests for iteration-manager state transitions and dispatch sequencing.
 *
 * The module holds internal state (worker pool, pause resolver, job counter)
 * across calls, so each test calls `resetRun()` in afterEach to leave the
 * module clean for the next test. Stores are also module singletons; we reset
 * the iteration store explicitly and only touch data-store / subset-store in
 * the mocked-pool integration tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the worker-pool factory before importing iteration-manager so the
// module picks up the fake pool on its first reference.
vi.mock('../cadecon-pool.ts', () => {
  return { createCaDeconWorkerPool: () => createFakePool() };
});

import type { CaDeconPoolJob } from '../cadecon-pool.ts';
import { pauseRun, resumeRun, stopRun, resetRun, startRun } from '../iteration-manager.ts';
import {
  runState,
  setRunState,
  runPhase,
  setRunPhase,
  currentIteration,
  setCurrentIteration,
  convergenceHistory,
  convergedAtIteration,
  resetIterationState,
} from '../iteration-store.ts';
import {
  setParsedData,
  setDimensionsConfirmed,
  setSamplingRate,
  setSwapped,
  resetImport,
} from '../data-store.ts';
import { setNumSubsets } from '../subset-store.ts';
import { setMaxIterations, setConvergenceTol } from '../algorithm-store.ts';

// ── Fake pool ──────────────────────────────────────────────────────────────

type DispatchedJob = CaDeconPoolJob;

interface FakePool {
  dispatch(job: DispatchedJob): void;
  cancelAll(): void;
  dispose(): void;
  jobs: DispatchedJob[];
  cancelCount: number;
  disposeCount: number;
}

let fakePool: FakePool | null = null;

function createFakePool(): FakePool {
  const pool: FakePool = {
    jobs: [],
    cancelCount: 0,
    disposeCount: 0,
    dispatch(job) {
      pool.jobs.push(job);
      // Resolve on a microtask so the iteration manager can continue its async
      // loop naturally (no synchronous re-entry from inside dispatch).
      queueMicrotask(() => completeJob(job));
    },
    cancelAll() {
      pool.cancelCount++;
    },
    dispose() {
      pool.disposeCount++;
    },
  };
  fakePool = pool;
  return pool;
}

function completeJob(job: DispatchedJob): void {
  if (job.kind === 'trace') {
    const n = job.trace.length;
    // Emit a plausible but simple result: small sparse spike, alpha=1
    const sCounts = new Float32Array(n);
    sCounts[Math.floor(n / 2)] = 1;
    job.onComplete({
      sCounts,
      filteredTrace: new Float32Array(job.trace),
      alpha: 1,
      baseline: 0,
      threshold: 0.1,
      pve: 0.9,
      iterations: 10,
      converged: true,
    });
  } else if (job.kind === 'kernel') {
    const hFree = new Float32Array(job.kernelLength);
    hFree[1] = 1;
    job.onComplete({
      hFree,
      tauRise: 0.05,
      tauDecay: 0.4,
      beta: 1,
      residual: 0.01,
      tauRiseFast: 0.05,
      tauDecayFast: 0.4,
      betaFast: 1,
    });
  } else {
    // seed-trace
    const n = job.trace.length;
    const sCounts = new Float32Array(n);
    sCounts[1] = 1;
    job.onComplete({ sCounts, alpha: 1, baseline: 0 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function seedMinimalRun(opts?: { numCells?: number; numTimepoints?: number; fs?: number }): void {
  const numCells = opts?.numCells ?? 2;
  const numTimepoints = opts?.numTimepoints ?? 60;
  const fs = opts?.fs ?? 30;
  const data = new Float64Array(numCells * numTimepoints);
  // Simple bump pattern so the fake pool sees non-trivial input
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.1);
  setParsedData({ data, shape: [numCells, numTimepoints], dtype: '<f8', fortranOrder: false });
  setDimensionsConfirmed(true);
  setSwapped(false);
  setSamplingRate(fs);
  setNumSubsets(1);
  setMaxIterations(2);
  setConvergenceTol(0.01);
}

// ── State transition tests (no pool) ───────────────────────────────────────

describe('iteration-manager: state transitions', () => {
  beforeEach(() => {
    resetIterationState();
  });

  afterEach(() => {
    resetRun();
  });

  describe('pauseRun', () => {
    it('transitions running → paused', () => {
      setRunState('running');
      pauseRun();
      expect(runState()).toBe('paused');
    });

    it.each(['idle', 'paused', 'stopping', 'complete'] as const)('is a no-op from %s', (state) => {
      setRunState(state);
      pauseRun();
      expect(runState()).toBe(state);
    });
  });

  describe('resumeRun', () => {
    it('transitions paused → running', () => {
      setRunState('paused');
      resumeRun();
      expect(runState()).toBe('running');
    });

    it.each(['idle', 'running', 'stopping', 'complete'] as const)('is a no-op from %s', (state) => {
      setRunState(state);
      resumeRun();
      expect(runState()).toBe(state);
    });
  });

  describe('stopRun', () => {
    it('sets runState to stopping and runPhase to idle', () => {
      setRunState('running');
      setRunPhase('inference');
      stopRun();
      expect(runState()).toBe('stopping');
      expect(runPhase()).toBe('idle');
    });

    it('is safe when no pool has been created', () => {
      setRunState('idle');
      expect(() => stopRun()).not.toThrow();
      expect(runState()).toBe('stopping');
    });
  });

  describe('resetRun', () => {
    it('clears iteration state back to defaults', () => {
      setRunState('complete');
      setRunPhase('finalization');
      setCurrentIteration(5);
      resetRun();
      expect(runState()).toBe('idle');
      expect(runPhase()).toBe('idle');
      expect(currentIteration()).toBe(0);
      expect(convergenceHistory()).toEqual([]);
      expect(convergedAtIteration()).toBeNull();
    });
  });
});

// ── startRun early exits ───────────────────────────────────────────────────

describe('iteration-manager: startRun prerequisites', () => {
  beforeEach(() => {
    resetIterationState();
    resetImport();
  });

  afterEach(() => {
    resetRun();
    resetImport();
  });

  it('exits immediately when no data is loaded', async () => {
    await startRun();
    expect(runState()).toBe('idle');
    expect(fakePool).toBeNull(); // pool was never created
  });
});

// ── startRun integration with mocked pool ──────────────────────────────────

describe('iteration-manager: startRun dispatch sequence', () => {
  beforeEach(() => {
    resetIterationState();
    resetImport();
  });

  afterEach(() => {
    resetRun();
    resetImport();
    fakePool = null;
  });

  it('runs through seed → iterate → finalize and reaches complete', async () => {
    seedMinimalRun();
    await startRun();

    expect(runState()).toBe('complete');
    expect(runPhase()).toBe('idle');
    expect(fakePool).not.toBeNull();
    // Jobs were dispatched: seed-trace + kernel seed + at least one iteration
    // of trace/kernel jobs + finalization trace jobs.
    const kinds = fakePool!.jobs.map((j) => j.kind);
    expect(kinds).toContain('seed-trace');
    expect(kinds).toContain('kernel');
    expect(kinds).toContain('trace');
    // Convergence history records iteration 0 + at least one iteration
    expect(convergenceHistory().length).toBeGreaterThanOrEqual(2);
  });

  it('converges and stops early when tau stabilises', async () => {
    // Fake pool always returns the same tauRise/tauDecay, so iteration 2
    // shows ~0% relative change and the loop should exit via the convergence
    // branch (iter > 0 && maxRelChange < convTol).
    seedMinimalRun();
    setMaxIterations(10);
    setConvergenceTol(0.1);
    await startRun();
    expect(convergedAtIteration()).not.toBeNull();
    expect(convergedAtIteration()!).toBeLessThanOrEqual(3);
  });

  it('stopRun mid-run transitions through stopping into complete', async () => {
    seedMinimalRun();
    setMaxIterations(50);
    const runPromise = startRun();
    // Give the microtask queue a chance to dispatch the seed jobs
    await Promise.resolve();
    stopRun();
    await runPromise;
    expect(runState()).toBe('complete');
    expect(fakePool!.cancelCount).toBeGreaterThan(0);
  });

  it('resetRun after completion disposes the pool', async () => {
    seedMinimalRun();
    await startRun();
    const pool = fakePool!;
    resetRun();
    expect(pool.disposeCount).toBe(1);
    expect(runState()).toBe('idle');
  });
});
