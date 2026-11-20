// --- CaDecon Worker Message Protocol ---

/** Results from InDeCa trace inference (mirrors Rust InDecaResult). */
export interface TraceResult {
  sCounts: Float32Array;
  filteredTrace?: Float32Array;
  alpha: number;
  baseline: number;
  threshold: number;
  pve: number;
  iterations: number;
  converged: boolean;
  /** Per-sample noise variance of the processed working trace (the trace
   *  `filteredTrace` reports): raw high-band noise variance through the
   *  bandpass times `chainNoiseGain`; 0 without a measurable noise floor.
   *  PVE ceiling = 1 - noiseVarProcessed / var(filteredTrace). */
  noiseVarProcessed?: number;
  /** Gain of the rolling-quantile baseline stage on the noise energy
   *  (the factor the selection's noise budget carries; 1 when not measured). */
  chainNoiseGain?: number;
  /** Diagnostics (display only, never change results). The binarization hit the
   *  per-frame cap (max firing rate) so the busiest frames are clipped. */
  capLimited?: boolean;
  /** No spike size passed the one-standard-error test (the best-fitting size was used, usually the floor). */
  noSizeFit?: boolean;
  /** Tallest event peak relative to the typical event peak; large = one outlier
   *  event sets the spike size for the whole trace. */
  peakOutlierRatio?: number;
  /** Spikes that could not be placed (no frame with room) and were dropped. */
  droppedSpikes?: number;
  /** The input trace looks rectified at zero (non-negative, many exact zeros:
   *  clipped or already denoised). Unsupported input; a warning only. */
  rectifiedInput?: boolean;
}

/** Results from peak-seeded spike detection on a single trace. */
export interface SeedTraceResult {
  sCounts: Float32Array;
  alpha: number;
  baseline: number;
}

/** Results from kernel estimation + bi-exponential fitting. */
/** Outcome of the bi-exponential fit; mirrors the Rust FitMode enum. */
export type FitMode = 'TwoComponent' | 'SlowOnly' | 'Degenerate' | 'Empty';

export interface KernelResult {
  hFree: Float32Array;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  tauRiseFast: number;
  tauDecayFast: number;
  betaFast: number;
  fitMode: FitMode;
}

/** Previous biexponential result for warm-starting the next fit (fit_mode not needed). */
export type WarmBiexp = Omit<KernelResult, 'hFree' | 'fitMode'>;

/** Model-free per-cell overview metrics (display only; never fed to the solver). */
export type { CellOverview } from '@calab/core';

/** Messages sent TO a CaDecon worker. */
export type CaDeconWorkerInbound =
  | {
      type: 'trace-job';
      jobId: number;
      trace: Float32Array;
      tauRise: number;
      tauDecay: number;
      fs: number;
      /** Highest burst rate (spikes/s): caps spikes per frame at max(1, round(rate / fs)). */
      maxFiringRate: number;
      maxIters: number;
      tol: number;
      hpEnabled: boolean;
      lpEnabled: boolean;
      /** L1 sparsity penalty on spike solution. */
      lambda: number;
      /** Previous iteration s_counts (per native frame) for warm-start. */
      warmCounts?: Float32Array;
    }
  | {
      type: 'kernel-job';
      jobId: number;
      tracesFlat: Float32Array;
      spikesFlat: Float32Array;
      traceLengths: Uint32Array;
      alphas: Float64Array;
      baselines: Float64Array;
      kernelLength: number;
      fs: number;
      maxIters: number;
      tol: number;
      refine: boolean;
      /** TV-L1 smoothness penalty weight for kernel estimation. */
      smoothLambda: number;
      /** Number of early free-kernel samples to skip in bi-exponential fitting. */
      biexpSkip: number;
      /** Previous iteration's free kernel for warm-start. */
      warmKernel?: Float32Array;
      /** Previous biexp result for warm-starting the fit. */
      warmBiexp?: WarmBiexp;
    }
  | {
      type: 'seed-trace-job';
      jobId: number;
      trace: Float32Array;
      fs: number;
    }
  | {
      /** Dataset overview pass: model-free metrics for a chunk of cells. */
      type: 'overview-job';
      jobId: number;
      /** nCells traces of nTimepoints samples each, cell-major. */
      tracesFlat: Float32Array;
      nCells: number;
      nTimepoints: number;
      fs: number;
      minSeparationSamples: number;
      isDff: boolean;
      baselineBins: number;
    }
  | { type: 'cancel' };

/** Messages sent FROM a CaDecon worker. */
export type CaDeconWorkerOutbound =
  | { type: 'ready' }
  | { type: 'trace-complete'; jobId: number; result: TraceResult }
  | { type: 'kernel-complete'; jobId: number; result: KernelResult }
  | { type: 'seed-trace-complete'; jobId: number; result: SeedTraceResult }
  | { type: 'overview-complete'; jobId: number; cells: import('@calab/core').CellOverview[] }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
