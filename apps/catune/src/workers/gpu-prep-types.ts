// Protocol for gpu-prep-worker.ts (dev-only GPU backend support): computes
// working traces for the GPU solver, and runs WASM reference solves for the
// GPU-vs-WASM comparison in the dev readout.

import type { SolverParams } from '@calab/core';

export type GpuPrepInbound =
  | { type: 'prep'; id: number; trace: Float32Array; params: SolverParams }
  | {
      type: 'reference';
      id: number;
      trace: Float32Array;
      params: SolverParams;
      maxIters: number;
      /** Same warm start the GPU had (export_state layout); momentum is reset, as on the GPU. */
      warmState?: Uint8Array | null;
    };

export type GpuPrepOutbound =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'prepped'; id: number; working: Float32Array }
  | {
      type: 'referenced';
      id: number;
      working: Float32Array;
      solution: Float32Array;
      iterations: number;
      converged: boolean;
      ms: number;
    }
  | { type: 'error'; id: number; message: string };
