// Sizes GPU submissions to a wall-clock target instead of a fixed iteration
// count. One "quantum" is the work between two readbacks; its length sets the
// intermediate-result cadence and the time a single submission can occupy the
// GPU (Windows resets the device when one runs past ~2 s, and integrated GPUs
// are an order of magnitude slower than discrete ones, so a fixed count that is
// fine on one machine can hang another).

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
  /** Iterations to run in the next quantum. */
  next(): number;
  /** Report a finished quantum. */
  record(iterations: number, elapsedMs: number): void;
  /** Smoothed ms per iteration, or null before the first measurement. */
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
    next() {
      if (msPerIter === null || msPerIter <= 0) return Math.min(max, Math.max(min, initial));
      return Math.min(max, Math.max(min, Math.round(targetMs / msPerIter)));
    },
    record(iterations, elapsedMs) {
      if (iterations <= 0 || !(elapsedMs >= 0)) return;
      const sample = elapsedMs / iterations;
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
