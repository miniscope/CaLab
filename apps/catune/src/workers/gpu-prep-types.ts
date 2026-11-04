// Protocol for gpu-prep-worker.ts (dev-only GPU backend support): computes
// working traces for the GPU solver, and runs WASM reference solves for the
// GPU-vs-WASM comparison in the dev readout.

import type { SolverParams, WarmStartStrategy } from '@calab/core';

export type GpuPrepInbound =
  | { type: 'prep'; id: number; trace: Float32Array; params: SolverParams }
  | {
      type: 'reference';
      id: number;
      trace: Float32Array;
      params: SolverParams;
      maxIters: number;
      /** Same warm start the GPU had (export_state layout). */
      warmState?: Uint8Array | null;
      /** Same strategy as the GPU: 'warm' continues momentum, 'warm-no-momentum' resets it. */
      warmStrategy?: WarmStartStrategy;
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
      /** Cumulative count (including iterations carried in by the warm start). */
      iterations: number;
      /** Iterations this solve ran. */
      iterationsRun: number;
      converged: boolean;
      /** Whole request (preprocessing + solve). */
      ms: number;
      /** step_batch loop only. */
      solveMs: number;
    }
  | { type: 'error'; id: number; message: string };
