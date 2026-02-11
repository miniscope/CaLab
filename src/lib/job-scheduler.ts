import * as Comlink from 'comlink';
import type { SolverParams } from './solver-types';
import { WarmStartCache, computePaddedWindow } from './warm-start-cache';
import { createSolverWorker } from '../workers/solver-api';

/**
 * Solver job scheduler with debounce, cancellation, windowed computation,
 * warm-start management, and intermediate result streaming.
 *
 * This is the intelligence layer between the UI and the solver worker.
 * Rapid parameter changes (e.g., slider dragging) are debounced into a single
 * solve dispatch. Stale jobs are discarded (never terminated -- the worker
 * singleton persists). Intermediate results are window-extracted so the UI
 * only receives the visible portion, not the padding.
 */
export class SolverJobScheduler {
  private jobCounter = 0;
  private activeJobId = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private warmStartCache = new WarmStartCache();
  private debounceMs: number;

  constructor(debounceMs: number = 30) {
    this.debounceMs = debounceMs;
  }

  /**
   * Dispatch a solver job for the visible region of a trace.
   *
   * The job is debounced -- rapid calls within `debounceMs` only trigger one solve.
   * Stale jobs (superseded by a newer dispatch) are silently discarded on completion.
   *
   * @param fullTrace - The complete calcium trace (not copied; a subarray view is extracted)
   * @param params - Solver parameters (tauRise, tauDecay, lambda, fs)
   * @param visibleStart - First sample index of the visible window
   * @param visibleEnd - One-past-last sample index of the visible window
   * @param onIntermediate - Called at ~10Hz with visible-region-only intermediate results
   * @param onComplete - Called once when solver converges with visible-region-only results
   * @param onError - Optional error handler
   */
  async dispatch(
    fullTrace: Float64Array,
    params: SolverParams,
    visibleStart: number,
    visibleEnd: number,
    onIntermediate: (solution: Float64Array, reconvolution: Float64Array, iteration: number) => void,
    onComplete: (solution: Float64Array, reconvolution: Float64Array, converged: boolean, iterations: number) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    // Cancel any pending debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Increment job counter and record as current active job
    this.jobCounter++;
    const currentJobId = this.jobCounter;
    this.activeJobId = currentJobId;

    // Debounce: wait before dispatching to group rapid parameter changes
    return new Promise<void>((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;

        try {
          // Compute padded window for overlap-and-discard
          const { paddedStart, paddedEnd, resultOffset, resultLength } =
            computePaddedWindow(visibleStart, visibleEnd, fullTrace.length, params.tauDecay, params.fs);

          // Extract and COPY the subarray -- required because subarray shares the
          // underlying buffer and transfer would detach the entire fullTrace
          const paddedTrace = new Float64Array(fullTrace.subarray(paddedStart, paddedEnd));

          // Get warm-start strategy and state
          const { strategy, state: warmState } =
            this.warmStartCache.getStrategy(params, paddedStart, paddedEnd);

          // Get worker (lazy init on first call)
          const worker = await createSolverWorker();

          // Call solver with intermediate callback
          const result = await worker.solve(
            Comlink.transfer(paddedTrace, [paddedTrace.buffer]),
            params,
            warmState,
            strategy,
            Comlink.proxy((intermediate) => {
              // Stale check: discard if a newer job has been dispatched
              if (currentJobId !== this.activeJobId) return;

              // Extract visible region from padded intermediate result
              const visibleSolution = intermediate.solution.subarray(resultOffset, resultOffset + resultLength);
              const visibleReconv = intermediate.reconvolution.subarray(resultOffset, resultOffset + resultLength);
              onIntermediate(visibleSolution, visibleReconv, intermediate.iteration);
            }),
          );

          // Stale check: discard result if a newer job superseded this one
          if (currentJobId !== this.activeJobId) {
            resolve();
            return;
          }

          // Extract visible region from padded result
          const visibleSolution = result.solution.subarray(resultOffset, resultOffset + resultLength);
          const visibleReconv = result.reconvolution.subarray(resultOffset, resultOffset + resultLength);

          // Cache warm-start state for next solve
          this.warmStartCache.store(result.state, params, paddedStart, paddedEnd);

          // Deliver final result
          onComplete(visibleSolution, visibleReconv, result.converged, result.iterations);
        } catch (err) {
          // Stale check for errors too
          if (currentJobId !== this.activeJobId) {
            resolve();
            return;
          }

          if (onError) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        }

        resolve();
      }, this.debounceMs);
    });
  }

  /**
   * Cancel any pending or in-flight job.
   *
   * Clears the debounce timer and increments the job counter so any
   * in-flight solve results will be discarded as stale.
   */
  cancel(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Increment counter to make any in-flight job stale
    this.jobCounter++;
    this.activeJobId = this.jobCounter;
  }
}
