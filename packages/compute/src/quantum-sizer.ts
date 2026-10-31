// Sizes GPU submissions to a wall-clock target instead of a fixed iteration
// count. One "quantum" is the work between two readbacks; its length sets the
// intermediate-result cadence and the time a single submission can occupy the
// GPU (Windows resets the device when one runs past ~2 s, and integrated GPUs
// are an order of magnitude slower than discrete ones, so a fixed count that is
// fine on one machine can hang another).
//
// The cost model is per unit of work (callers pass the active cells x samples
// of the quantum): a 1-cell batch's measurement then sizes a following
// 1000-cell batch at ~1/1000 of the iterations instead of the same count. Per
// sample, small batches look expensive (fixed dispatch overhead), so the
// first quantum after a jump in batch size errs short, which is the safe side.

export interface QuantumSizerOptions {
  /** Target wall-clock per quantum, ms. Default 100 (CaTune's intermediate cadence). */
  targetMs?: number;
  /** Iterations for the first quantum, before anything has been measured. Default 10. */
  initialIterations?: number;
  minIterations?: number;
  maxIterations?: number;
  /** Weight of the newest measurement in the ms-per-iteration EMA. Default 0.5. */
  smoothing?: number;
}

export interface QuantumSizer {
  /** Iterations to run in the next quantum of `work` units (e.g. active cells x samples; default 1). */
  next(work?: number): number;
  /** Report a finished quantum of `iterations` over `work` units (default 1). */
  record(iterations: number, elapsedMs: number, work?: number): void;
  /** Smoothed ms per iteration per work unit, or null before the first measurement. */
  readonly msPerIteration: number | null;
  reset(): void;
}

export function createQuantumSizer(options: QuantumSizerOptions = {}): QuantumSizer {
  const targetMs = options.targetMs ?? 100;
  const initial = options.initialIterations ?? 10;
  const min = options.minIterations ?? 1;
  const max = options.maxIterations ?? 1000;
  const alpha = options.smoothing ?? 0.5;
  let msPerIter: number | null = null;

  return {
    next(work = 1) {
      if (msPerIter === null || msPerIter <= 0) return Math.min(max, Math.max(min, initial));
      const perIter = msPerIter * Math.max(work, 1e-12);
      return Math.min(max, Math.max(min, Math.round(targetMs / perIter)));
    },
    record(iterations, elapsedMs, work = 1) {
      if (iterations <= 0 || !(elapsedMs >= 0) || !(work > 0)) return;
      const sample = elapsedMs / iterations / work;
      msPerIter = msPerIter === null ? sample : alpha * sample + (1 - alpha) * msPerIter;
    },
    get msPerIteration() {
      return msPerIter;
    },
    reset() {
      msPerIter = null;
    },
  };
}
