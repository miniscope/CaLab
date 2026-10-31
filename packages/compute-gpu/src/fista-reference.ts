/**
 * CPU model of the GPU FISTA iteration (one cell), built on the scan-based
 * operators in scan-reference.ts and using the same f32 reduction structure
 * as the WGSL (per-thread partials, workgroup tree, per-cell block sum).
 *
 * Its job is to validate the algorithm in Node against the Rust/WASM solver
 * (`step_batch` in crates/solver/src/fista.rs) before the WGSL port, and to
 * document the per-iteration semantics the shaders implement.
 */
import { computeBandedParams } from './banded-params.ts';
import { BLOCK, K, WG, scanAdjoint, scanForward } from './scan-reference.ts';
import type { GpuFistaParams } from './types.ts';

const f = Math.fround;

/** Sum `vals(i)` for i in [0,T) the way the GPU does: thread, tree, block. */
function gpuSum(T: number, vals: (i: number) => number): number {
  const nBlocks = Math.ceil(T / BLOCK);
  const red = new Float32Array(WG);
  let total = 0;
  for (let b = 0; b < nBlocks; b++) {
    for (let tid = 0; tid < WG; tid++) {
      let acc = 0;
      for (let k = 0; k < K; k++) {
        const i = b * BLOCK + tid * K + k;
        if (i < T) acc = f(acc + vals(i));
      }
      red[tid] = acc;
    }
    for (let s = WG / 2; s > 0; s >>= 1) {
      for (let tid = 0; tid < s; tid++) red[tid] = f(red[tid] + red[tid + s]);
    }
    total = f(total + red[0]);
  }
  return total;
}

export interface ReferenceResult {
  solution: Float32Array;
  iterations: number;
  converged: boolean;
}

export function referenceFista(
  trace: Float32Array,
  params: GpuFistaParams,
  warmStart?: Float32Array,
): ReferenceResult {
  const T = trace.length;
  const bp = computeBandedParams(params.tauRise, params.tauDecay, params.fs, params.lambda);
  const lo = 0;
  const hi = params.constraint === 'box01' ? 1 : Infinity;
  const clampC = (v: number) => Math.min(Math.max(v, lo), hi);
  const step = bp.stepF32;
  const thresh = bp.threshF32;
  const tolSq = f(params.tol * params.tol);

  const x = warmStart ? Float32Array.from(warmStart) : new Float32Array(T);
  let y = Float32Array.from(x);
  let t = 1;
  let iter = 0;
  let converged = false;
  let useX = false;

  while (iter < params.maxIters && !converged) {
    const src = useX ? x : y;
    const c = scanForward(src, bp);
    let b = 0;
    if (!params.filtered) {
      b = f(gpuSum(T, (i) => f(trace[i] - c[i])) / T);
    }
    const resid = new Float32Array(T);
    for (let i = 0; i < T; i++) resid[i] = f(f(c[i] + b) - trace[i]);
    const grad = scanAdjoint(resid, bp);

    const tNew = f((1 + Math.sqrt(f(1 + f(4 * f(t * t))))) / 2);
    const m = f(f(t - 1) / tNew);
    const xOld = Float32Array.from(x);
    const yIn = useX ? xOld : y;
    const yNext = new Float32Array(T);
    for (let i = 0; i < T; i++) {
      const z = f(yIn[i] - f(step * grad[i]));
      const xn = clampC(f(z - thresh));
      x[i] = xn;
      yNext[i] = clampC(f(xn + f(m * f(xn - xOld[i]))));
    }
    const diffSq = gpuSum(T, (i) => f(f(x[i] - xOld[i]) * f(x[i] - xOld[i])));
    const xkSq = gpuSum(T, (i) => f(xOld[i] * xOld[i]));
    const dot = gpuSum(T, (i) => f(f(yIn[i] - x[i]) * f(x[i] - xOld[i])));
    y = yNext;

    iter += 1;
    if (iter > 1 && dot > 0) {
      t = 1;
      useX = true;
    } else {
      t = tNew;
      useX = false;
    }
    if (iter > 5 && diffSq < f(tolSq * f(xkSq + 1e-20))) converged = true;
  }
  return { solution: x, iterations: iter, converged };
}
