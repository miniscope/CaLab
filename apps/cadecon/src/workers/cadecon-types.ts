// --- CaDecon Worker Message Protocol ---

/** Results from InDeCa trace inference (mirrors Rust InDecaResult). */
export interface TraceResult {
  sCounts: Float32Array;
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
      filterEnabled: boolean;
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
    }
  | { type: 'cancel' };

/** Messages sent FROM a CaDecon worker. */
export type CaDeconWorkerOutbound =
  | { type: 'ready' }
  | { type: 'trace-complete'; jobId: number; result: TraceResult }
  | { type: 'kernel-complete'; jobId: number; result: KernelResult }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
