/**
 * Reactivity tests for iteration-store.
 *
 * Every derived memo (progress, isRunLocked, cellResultLookup, alphaValues,
 * pveValues, subsetVarianceData) is verified to track its source signals.
 * Writes go through the exported actions (setRunState, setCurrentIteration,
 * updateTraceResult, addConvergenceSnapshot, snapshotIteration, ...) and
 * reads happen inside createRoot scopes so the memos are subscribed and do
 * not produce "computation created outside a createRoot" warnings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import {
  runState,
  setRunState,
  runPhase,
  setRunPhase,
  currentIteration,
  setCurrentIteration,
  totalSubsetTraceJobs,
  setTotalSubsetTraceJobs,
  setCompletedSubsetTraceJobs,
  progress,
  isRunLocked,
  convergenceHistory,
  addConvergenceSnapshot,
  debugTraceSnapshots,
  addDebugTraceSnapshot,
  currentTauRise,
  setCurrentTauRise,
  currentTauDecay,
  setCurrentTauDecay,
  convergedAtIteration,
  setConvergedAtIteration,
  cellResultLookup,
  alphaValues,
  pveValues,
  subsetVarianceData,
  iterationHistory,
  snapshotIteration,
  updateTraceResult,
  bulkUpdateTraceResults,
  resetIterationState,
  cellSubsetKey,
} from '../iteration-store.ts';

// ── helpers ────────────────────────────────────────────────────────────────

/** Run `fn` inside a createRoot scope that disposes immediately after. */
function withRoot<T>(fn: () => T): T {
  return createRoot((dispose) => {
    try {
      return fn();
    } finally {
      dispose();
    }
  });
}

function makeTraceEntry(
  cellIndex: number,
  subsetIdx: number,
  alpha: number,
  pve: number,
): import('../iteration-store.ts').TraceResultEntry {
  return {
    cellIndex,
    subsetIdx,
    sCounts: new Float32Array(0),
    alpha,
    baseline: 0,
    threshold: 0,
    pve,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('iteration-store: core signals', () => {
  beforeEach(() => resetIterationState());

  it('setRunState updates the runState signal', () => {
    withRoot(() => {
      expect(runState()).toBe('idle');
      setRunState('running');
      expect(runState()).toBe('running');
      setRunState('paused');
      expect(runState()).toBe('paused');
      setRunState('stopping');
      expect(runState()).toBe('stopping');
    });
  });

  it('setCurrentIteration updates its signal', () => {
    setCurrentIteration(7);
    expect(currentIteration()).toBe(7);
  });

  it('tau signals update independently', () => {
    setCurrentTauRise(0.03);
    setCurrentTauDecay(0.6);
    expect(currentTauRise()).toBe(0.03);
    expect(currentTauDecay()).toBe(0.6);
  });
});

describe('iteration-store: derived memos', () => {
  beforeEach(() => resetIterationState());

  it('progress = completed / total and is 0 when total=0', () => {
    withRoot(() => {
      expect(progress()).toBe(0);
      setTotalSubsetTraceJobs(10);
      setCompletedSubsetTraceJobs(3);
      expect(progress()).toBeCloseTo(0.3);
      setCompletedSubsetTraceJobs(10);
      expect(progress()).toBe(1);
    });
  });

  it('progress reacts to both numerator and denominator', () => {
    withRoot(() => {
      setTotalSubsetTraceJobs(4);
      setCompletedSubsetTraceJobs(2);
      expect(progress()).toBe(0.5);
      setCompletedSubsetTraceJobs(4);
      expect(progress()).toBe(1);
      expect(totalSubsetTraceJobs()).toBe(4);
    });
  });

  it('isRunLocked is true only while running/paused/stopping', () => {
    withRoot(() => {
      setRunState('idle');
      expect(isRunLocked()).toBe(false);
      setRunState('running');
      expect(isRunLocked()).toBe(true);
      setRunState('paused');
      expect(isRunLocked()).toBe(true);
      setRunState('stopping');
      expect(isRunLocked()).toBe(true);
      setRunState('complete');
      expect(isRunLocked()).toBe(false);
    });
  });

  it('cellResultLookup dedupes by cellIndex, preferring finalization (subsetIdx=-1)', () => {
    withRoot(() => {
      bulkUpdateTraceResults({
        [cellSubsetKey(0, 0)]: makeTraceEntry(0, 0, 1, 0.5),
        [cellSubsetKey(0, 1)]: makeTraceEntry(0, 1, 2, 0.6),
        [cellSubsetKey(0, -1)]: makeTraceEntry(0, -1, 99, 0.99),
        [cellSubsetKey(1, 0)]: makeTraceEntry(1, 0, 3, 0.7),
      });
      const lookup = cellResultLookup();
      expect(lookup.get(0)?.alpha).toBe(99);
      expect(lookup.get(0)?.pve).toBe(0.99);
      expect(lookup.get(1)?.alpha).toBe(3);
    });
  });

  it('alphaValues/pveValues derive from cellResultLookup', () => {
    withRoot(() => {
      bulkUpdateTraceResults({
        [cellSubsetKey(0, 0)]: makeTraceEntry(0, 0, 1, 0.1),
        [cellSubsetKey(1, 0)]: makeTraceEntry(1, 0, 2, 0.2),
      });
      expect(alphaValues().sort()).toEqual([1, 2]);
      expect(pveValues().sort()).toEqual([0.1, 0.2]);
    });
  });

  it('subsetVarianceData tracks the latest convergence snapshot and exposes ms units', () => {
    withRoot(() => {
      expect(subsetVarianceData()).toEqual([]);
      addConvergenceSnapshot({
        iteration: 1,
        tauRise: 0.05,
        tauDecay: 0.4,
        beta: 1,
        residual: 0.01,
        tauRiseFast: 0.05,
        tauDecayFast: 0.4,
        betaFast: 1,
        fs: 30,
        tPeak: 0.05,
        fwhm: 0.2,
        shapeDelta: null,
        riseUnresolved: false,
        // subsetIdx deliberately does not match array position — kernel results
        // arrive in worker-completion order, so subsetVarianceData must read the
        // subsetIdx field, not the array index.
        subsets: [
          {
            subsetIdx: 2,
            tauRise: 0.05,
            tauDecay: 0.4,
            beta: 1,
            residual: 0.01,
            tauRiseFast: 0.05,
            tauDecayFast: 0.4,
            betaFast: 1,
            hFree: new Float32Array(),
          },
          {
            subsetIdx: 0,
            tauRise: 0.06,
            tauDecay: 0.5,
            beta: 1,
            residual: 0.01,
            tauRiseFast: 0.06,
            tauDecayFast: 0.5,
            betaFast: 1,
            hFree: new Float32Array(),
          },
        ],
      });
      const variance = subsetVarianceData();
      expect(variance).toHaveLength(2);
      expect(variance[0].subsetIdx).toBe(2);
      expect(variance[1].subsetIdx).toBe(0);
      expect(variance[0].tauRise).toBeCloseTo(50); // ms
      expect(variance[0].tauDecay).toBeCloseTo(400);
      expect(variance[1].tauRise).toBeCloseTo(60);
    });
  });
});

describe('iteration-store: history actions', () => {
  beforeEach(() => resetIterationState());

  it('addConvergenceSnapshot / addDebugTraceSnapshot append', () => {
    withRoot(() => {
      expect(convergenceHistory()).toHaveLength(0);
      addConvergenceSnapshot({
        iteration: 0,
        tauRise: 0,
        tauDecay: 0,
        beta: 0,
        residual: 0,
        tauRiseFast: 0,
        tauDecayFast: 0,
        betaFast: 0,
        fs: 30,
        tPeak: null,
        fwhm: null,
        shapeDelta: null,
        riseUnresolved: false,
        subsets: [],
      });
      expect(convergenceHistory()).toHaveLength(1);

      expect(debugTraceSnapshots()).toHaveLength(0);
      addDebugTraceSnapshot({
        iteration: 1,
        cellIndex: 0,
        rawTrace: new Float32Array(),
        sCounts: new Float32Array(),
        reconvolved: new Float32Array(),
        alpha: 1,
        baseline: 0,
        threshold: 0,
        pve: 0,
      });
      expect(debugTraceSnapshots()).toHaveLength(1);
    });
  });

  it('snapshotIteration caps history at MAX_HISTORY_ITERATIONS (50)', () => {
    withRoot(() => {
      for (let i = 0; i < 55; i++) {
        snapshotIteration(i, 0.05 + i * 0.001, 0.4);
      }
      const history = iterationHistory();
      expect(history).toHaveLength(50);
      // Oldest entries were dropped: iteration numbers start at 5
      expect(history[0].iteration).toBe(5);
      expect(history[history.length - 1].iteration).toBe(54);
    });
  });

  it('snapshotIteration captures current perTraceResults as a shallow copy', () => {
    withRoot(() => {
      const e1 = makeTraceEntry(0, -1, 1, 0.5);
      updateTraceResult(cellSubsetKey(0, -1), e1);
      snapshotIteration(1, 0.05, 0.4);

      // Mutate the source: should NOT leak into the snapshot
      const e2 = makeTraceEntry(0, -1, 99, 0.99);
      updateTraceResult(cellSubsetKey(0, -1), e2);

      const snap = iterationHistory()[0].results;
      expect(snap[cellSubsetKey(0, -1)].alpha).toBe(1);
    });
  });
});

describe('iteration-store: updateTraceResult / bulkUpdateTraceResults', () => {
  beforeEach(() => resetIterationState());

  it('updateTraceResult merges one entry into cellResultLookup', () => {
    withRoot(() => {
      expect(cellResultLookup().size).toBe(0);
      updateTraceResult(cellSubsetKey(3, 0), makeTraceEntry(3, 0, 5, 0.5));
      expect(cellResultLookup().get(3)?.alpha).toBe(5);
      updateTraceResult(cellSubsetKey(4, 0), makeTraceEntry(4, 0, 6, 0.6));
      expect(cellResultLookup().size).toBe(2);
    });
  });

  it('bulkUpdateTraceResults writes all entries in one pass', () => {
    withRoot(() => {
      bulkUpdateTraceResults({
        [cellSubsetKey(0, 0)]: makeTraceEntry(0, 0, 1, 0.1),
        [cellSubsetKey(1, 0)]: makeTraceEntry(1, 0, 2, 0.2),
        [cellSubsetKey(2, 0)]: makeTraceEntry(2, 0, 3, 0.3),
      });
      expect(cellResultLookup().size).toBe(3);
      expect(alphaValues().sort()).toEqual([1, 2, 3]);
    });
  });
});

describe('iteration-store: resetIterationState', () => {
  it('restores every tracked signal to its initial value', () => {
    withRoot(() => {
      setRunState('complete');
      setRunPhase('finalization');
      setCurrentIteration(9);
      setTotalSubsetTraceJobs(10);
      setCompletedSubsetTraceJobs(5);
      setCurrentTauRise(0.05);
      setCurrentTauDecay(0.4);
      setConvergedAtIteration(3);
      addConvergenceSnapshot({
        iteration: 1,
        tauRise: 0,
        tauDecay: 0,
        beta: 0,
        residual: 0,
        tauRiseFast: 0,
        tauDecayFast: 0,
        betaFast: 0,
        fs: 30,
        tPeak: null,
        fwhm: null,
        shapeDelta: null,
        riseUnresolved: false,
        subsets: [],
      });
      updateTraceResult(cellSubsetKey(0, 0), makeTraceEntry(0, 0, 1, 0.5));
      snapshotIteration(1, 0.05, 0.4);

      resetIterationState();

      expect(runState()).toBe('idle');
      expect(runPhase()).toBe('idle');
      expect(currentIteration()).toBe(0);
      expect(totalSubsetTraceJobs()).toBe(0);
      expect(progress()).toBe(0);
      expect(convergenceHistory()).toEqual([]);
      expect(debugTraceSnapshots()).toEqual([]);
      expect(currentTauRise()).toBeNull();
      expect(currentTauDecay()).toBeNull();
      expect(convergedAtIteration()).toBeNull();
      expect(cellResultLookup().size).toBe(0);
      expect(iterationHistory()).toEqual([]);
    });
  });
});
