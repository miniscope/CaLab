/**
 * CPU model of the GPU FISTA iteration (one cell). It follows the WGSL
 * decomposition (src/shaders/fista-wgsl.ts) block by block, with the same
 * f32 reduction structure (per-thread partials, workgroup tree, per-cell
 * sequential sum over blocks):
 *
 *   iter   one pass per block: rebuild y from x_k, x_{k-1}; forward scan with
 *          the block's carry-in state; residual in registers; reverse scan
 *          with the block's carry-in; prox; partial reductions; and, for the
 *          next iteration, per-block functionals of both candidate sources
 *          (x_{k+1} after a restart, y_{k+1} otherwise).
 *   fin    one thread per cell: FISTA bookkeeping, then the carries for the
 *          next iteration: forward states s_in[b] by walking blocks with A^C,
 *          the baseline (unfiltered), the reverse block aggregates
 *          Q_b = (G s_in[b] + Σ β_p x_p + bl·O - Tr_b) / peak, and the
 *          reverse carries q_in[b] walking down with A^L.
 *
 * Q_b is the residual's reverse aggregate computed without reading the
 * residual: it is linear in the block's carry-in state, its inputs x_p, the
 * baseline, and the trace (whose term Tr_b is computed once at load).
 *
 * Its job is to validate the algorithm in Node against the Rust/WASM solver
 * (`step_batch` in crates/solver/src/fista.rs) and to document the
 * per-iteration semantics the shaders implement.
 */
import { computeBandedParams } from './banded-params.ts';
import {
  K,
  WG,
  blockForward,
  blockReduce,
  blockReverse,
  buildScanTables,
  mv,
  type ScanTables,
} from './scan-reference.ts';
import type { GpuFistaParams } from './types.ts';

const f = Math.fround;

export interface ReferenceResult {
  solution: Float32Array;
  iterations: number;
  converged: boolean;
}

/** Per-block functionals of one candidate source: F (2), Σβx (2), Σδx (1). */
type Cand = Float32Array;

/** Functionals of the prescaled inputs xin of block b. */
function candidate(tb: ScanTables, b: number, xin: Float32Array): Cand {
  const last = b === tb.nBlocks - 1;
  const D = tb.data;
  return blockReduce(tb, 5, (p, o) => {
    const x = xin[p];
    const w0 = 4 * (tb.POS0 + p);
    const w1 = 4 * (tb.POS1 + p) + (last ? 2 : 0);
    const w2 = 4 * (tb.POS2 + p) + (last ? 1 : 0);
    o[0] = f(o[0] + f(D[w0] * x));
    o[1] = f(o[1] + f(D[w0 + 1] * x));
    o[2] = f(o[2] + f(D[w1] * x));
    o[3] = f(o[3] + f(D[w1 + 1] * x));
    o[4] = f(o[4] + f(D[w2] * x));
  });
}

export function referenceFista(
  trace: Float32Array,
  params: GpuFistaParams,
  warmStart?: Float32Array,
  wg = WG,
  k = K,
): ReferenceResult {
  const T = trace.length;
  const bp = computeBandedParams(params.tauRise, params.tauDecay, params.fs, params.lambda);
  const d = bp.decayRootF32;
  const r = bp.riseRootF32;
  const inv = bp.invPeakF32;
  const tb = buildScanTables(d, r, T, wg, k);
  const { C, nBlocks: nb } = tb;
  const D = tb.data;
  const lo = 0;
  const hi = params.constraint === 'box01' ? 1 : Infinity;
  const clampC = (v: number) => Math.min(Math.max(v, lo), hi);
  const step = bp.stepF32;
  const thresh = bp.threshF32;
  const tolSq = f(params.tol * params.tol);
  const invT = f(1 / T);

  let xk = warmStart ? Float32Array.from(warmStart) : new Float32Array(T);
  let xPrev = new Float32Array(T);
  let t = 1;
  let m = 0;
  let iter = 0;
  let converged = false;
  let useX = true; // y_0 = x_0
  let baseline = 0;

  const slice = (src: Float32Array, b: number, scale: number) => {
    const out = new Float32Array(C);
    for (let p = 0; p < C; p++) {
      const i = b * C + p;
      if (i < T) out[p] = f(src[i] * scale);
    }
    return out;
  };

  // Load-time pass: trace terms and the x_0 candidate.
  const tr: Float32Array[] = []; // per block: Tr (2), Σ trace (1)
  let candX: Cand[] = [];
  let candY: Cand[] = [];
  for (let b = 0; b < nb; b++) {
    const tb_ = slice(trace, b, 1);
    tr.push(
      blockReduce(tb, 3, (p, o) => {
        const w = 4 * (tb.POS0 + p) + 2;
        o[0] = f(o[0] + f(D[w] * tb_[p]));
        o[1] = f(o[1] + f(D[w + 1] * tb_[p]));
        o[2] = f(o[2] + tb_[p]);
      }),
    );
    candX.push(candidate(tb, b, slice(xk, b, inv)));
  }

  // Per-cell carry pass.
  const sIn: [number, number][] = new Array(nb);
  const qIn: [number, number][] = new Array(nb);
  const carry = () => {
    const cand = useX ? candX : candY;
    let s: [number, number] = [0, 0];
    let acc = 0;
    for (let b = 0; b < nb; b++) {
      sIn[b] = s;
      if (!params.filtered) {
        const g = 4 * tb.GAM + (b === nb - 1 ? 2 : 0);
        const cSum = f(f(f(D[g] * s[0]) + f(D[g + 1] * s[1])) + cand[b][4]);
        acc = f(acc + f(tr[b][2] - cSum));
      }
      const am = mv(tb, tb.AC, s[0], s[1]);
      s = [f(am[0] + cand[b][0]), f(am[1] + cand[b][1])];
    }
    baseline = params.filtered ? 0 : f(acc * invT);
    let q: [number, number] = [0, 0];
    for (let b = nb - 1; b >= 0; b--) {
      qIn[b] = q;
      const last = b === nb - 1;
      const gs = mv(tb, last ? tb.GLAST : tb.GFULL, sIn[b][0], sIn[b][1]);
      const o = 4 * tb.OSUM + (last ? 2 : 0);
      const Q0 = f(inv * f(f(f(gs[0] + cand[b][2]) + f(baseline * D[o])) - tr[b][0]));
      const Q1 = f(inv * f(f(f(gs[1] + cand[b][3]) + f(baseline * D[o + 1])) - tr[b][1]));
      const am = mv(tb, last ? tb.ALAST : tb.AC, q[0], q[1]);
      q = [f(am[0] + Q0), f(am[1] + Q1)];
    }
  };
  carry();

  while (iter < params.maxIters && !converged) {
    const tNew = f((1 + Math.sqrt(f(1 + f(4 * f(t * t))))) / 2);
    const mNew = f(f(t - 1) / tNew);
    const xNext = new Float32Array(T);
    const nextX: Cand[] = [];
    const nextY: Cand[] = [];
    let diffSq = 0;
    let xkSq = 0;
    let dot = 0;
    for (let b = 0; b < nb; b++) {
      const y = new Float32Array(C);
      const xb = new Float32Array(C);
      const trb = slice(trace, b, 1);
      for (let p = 0; p < C; p++) {
        const i = b * C + p;
        if (i >= T) continue;
        xb[p] = xk[i];
        y[p] = useX ? xk[i] : clampC(f(xk[i] + f(m * f(xk[i] - xPrev[i]))));
      }
      const xin = new Float32Array(C);
      for (let p = 0; p < C; p++) xin[p] = f(y[p] * inv);
      const c = blockForward(xin, sIn[b], d, r, tb);
      const z = new Float32Array(C);
      for (let p = 0; p < C; p++) {
        if (b * C + p < T) z[p] = f(f(f(c[p] + baseline) - trb[p]) * inv);
      }
      const g = blockReverse(z, qIn[b], d, r, tb);
      const xn = new Float32Array(C);
      const yn = new Float32Array(C);
      for (let p = 0; p < C; p++) {
        if (b * C + p >= T) continue;
        xn[p] = clampC(f(f(y[p] - f(step * g[p])) - thresh));
        yn[p] = clampC(f(xn[p] + f(mNew * f(xn[p] - xb[p]))));
        xNext[b * C + p] = xn[p];
      }
      const part = blockReduce(tb, 3, (p, o) => {
        if (b * C + p >= T) return;
        const dd = f(xn[p] - xb[p]);
        o[0] = f(o[0] + f(dd * dd));
        o[1] = f(o[1] + f(xb[p] * xb[p]));
        o[2] = f(o[2] + f(f(y[p] - xn[p]) * dd));
      });
      diffSq = f(diffSq + part[0]);
      xkSq = f(xkSq + part[1]);
      dot = f(dot + part[2]);
      const sx = new Float32Array(C);
      const sy = new Float32Array(C);
      for (let p = 0; p < C; p++) {
        sx[p] = f(xn[p] * inv);
        sy[p] = f(yn[p] * inv);
      }
      nextX.push(candidate(tb, b, sx));
      nextY.push(candidate(tb, b, sy));
    }
    xPrev = xk;
    xk = xNext;
    candX = nextX;
    candY = nextY;

    iter += 1;
    m = mNew;
    if (iter > 1 && dot > 0) {
      t = 1;
      useX = true;
    } else {
      t = tNew;
      useX = false;
    }
    if (iter > 5 && diffSq < f(tolSq * f(xkSq + 1e-20))) converged = true;
    if (!converged) carry();
  }
  return { solution: xk, iterations: iter, converged };
}
