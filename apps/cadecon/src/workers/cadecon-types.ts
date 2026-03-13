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

/** Results from kernel estimation + bi-exponential fitting. */
export interface KernelResult {
  hFree: Float32Array;
  tauRise: number;
  tauDecay: number;
  beta: number;
  residual: number;
  /** Direct biexp tau values (hybrid mode only). */
  directTauRise?: number;
  directTauDecay?: number;
  directBeta?: number;
  directResidual?: number;
}

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
      /** Kernel estimation mode: 'free-kernel' runs the two-step free-kernel + biexp fit;
       *  'direct-biexp' optimizes (tau_r, tau_d) directly against trace reconstruction. */
      kernelMode: 'free-kernel' | 'direct-biexp' | 'hybrid';
    }
  | { type: 'cancel' };

/** Messages sent FROM a CaDecon worker. */
export type CaDeconWorkerOutbound =
  | { type: 'ready' }
  | { type: 'trace-complete'; jobId: number; result: TraceResult }
  | { type: 'kernel-complete'; jobId: number; result: KernelResult }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
