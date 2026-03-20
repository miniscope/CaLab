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
}

/** Results from peak-seeded spike detection on a single trace. */
export interface SeedTraceResult {
  sCounts: Float32Array;
  alpha: number;
  baseline: number;
}

/** Results from kernel estimation + bi-exponential fitting. */
export interface KernelResult {
  hFree: Float32Array;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  tauRiseFast: number;
  tauDecayFast: number;
  betaFast: number;
}

/** Previous biexponential result for warm-starting the next fit. */
export type WarmBiexp = Omit<KernelResult, 'hFree'>;

/** Messages sent TO a CaDecon worker. */
export type CaDeconWorkerInbound =
  | {
      type: 'trace-job';
      jobId: number;
      trace: Float32Array;
      tauRise: number;
      tauDecay: number;
      fs: number;
      upsampleFactor: number;
      maxIters: number;
      tol: number;
      hpEnabled: boolean;
      lpEnabled: boolean;
      /** L1 sparsity penalty on spike solution. */
      lambda: number;
      /** Previous iteration's s_counts at original rate for warm-start. */
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
  | { type: 'cancel' };

/** Messages sent FROM a CaDecon worker. */
export type CaDeconWorkerOutbound =
  | { type: 'ready' }
  | { type: 'trace-complete'; jobId: number; result: TraceResult }
  | { type: 'kernel-complete'; jobId: number; result: KernelResult }
  | { type: 'seed-trace-complete'; jobId: number; result: SeedTraceResult }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
