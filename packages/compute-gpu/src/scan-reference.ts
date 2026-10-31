/**
 * Plain-TypeScript model of the GPU's chunked-scan AR(2) operators.
 *
 * It mirrors the WGSL dispatch structure (src/shaders/fista-wgsl.ts) step for
 * step, so it can be tested in Node against the serial Rust recursion before
 * any GPU is involved:
 *
 *   1. local pass: each workgroup owns one block of C = WG*K samples; each of
 *      its WG threads runs the recursion sequentially over K samples with zero
 *      carry-in, then a Hillis-Steele scan over the WG thread end values
 *      (coefficient a^K per hop) gives each thread its carry-in, which is
 *      folded back as a^(k+1) * carry. Output: block-local values (zero
 *      carry-in at the block start) and each block's end value.
 *   2. carry pass: one thread per cell walks the blocks sequentially:
 *      carry_in[j] = a^C * carry_in[j-1] + end[j-1].
 *   3. fix-up: value[p] += a^(p+1) * carry_in[block], p = position in block.
 *
 * All arithmetic is rounded to f32 (Math.fround / Float32Array) to match the
 * GPU. The adjoint runs the same machinery on a reversed logical index.
 */
import type { BandedParams } from './banded-params.ts';

export const WG = 256;
export const K = 4;
export const BLOCK = WG * K;

const f = Math.fround;

/** a^0 .. a^C as f32, computed in f64. */
export function powTable(a: number, c: number = BLOCK): Float32Array {
  const out = new Float32Array(c + 1);
  for (let j = 0; j <= c; j++) out[j] = Math.pow(a, j);
  return out;
}

export interface ScanResult {
  /** Block-local values (zero carry-in at each block start), logical order. */
  local: Float32Array;
  /** Per-block end values. */
  ends: Float32Array;
}

/** Pass 1: block-local scan of x[l] = a*x[l-1] + input[l], logical order. */
export function localBlockScan(
  input: Float32Array,
  a: number,
  pows: Float32Array,
  wg = WG,
  k = K,
): ScanResult {
  const T = input.length;
  const c = wg * k;
  const nBlocks = Math.ceil(T / c);
  const local = new Float32Array(T);
  const ends = new Float32Array(nBlocks);
  const af = f(a);
  const vals = new Float32Array(wg * k);
  const sh = new Float32Array(wg);
  const next = new Float32Array(wg);
  for (let b = 0; b < nBlocks; b++) {
    // Per-thread sequential recursion.
    for (let tid = 0; tid < wg; tid++) {
      let acc = 0;
      for (let kk = 0; kk < k; kk++) {
        const l = b * c + tid * k + kk;
        const v = l < T ? input[l] : 0;
        acc = f(f(af * acc) + v);
        vals[tid * k + kk] = acc;
      }
      sh[tid] = acc;
    }
    // Hillis-Steele inclusive scan over thread ends.
    for (let o = 1; o < wg; o <<= 1) {
      const ao = pows[k * o];
      for (let tid = 0; tid < wg; tid++) {
        next[tid] = tid >= o ? f(sh[tid] + f(ao * sh[tid - o])) : sh[tid];
      }
      sh.set(next);
    }
    // Fold each thread's exclusive carry back in.
    for (let tid = 0; tid < wg; tid++) {
      const carry = tid > 0 ? sh[tid - 1] : 0;
      for (let kk = 0; kk < k; kk++) {
        const l = b * c + tid * k + kk;
        if (l < T) local[l] = f(vals[tid * k + kk] + f(pows[kk + 1] * carry));
      }
    }
    ends[b] = sh[wg - 1];
  }
  return { local, ends };
}

/** Pass 2: turn block end values into block carry-ins, in place. */
export function carryPass(ends: Float32Array, aC: number): Float32Array {
  const acf = f(aC);
  let carry = 0;
  for (let j = 0; j < ends.length; j++) {
    const e = ends[j];
    ends[j] = carry;
    carry = f(f(acf * carry) + e);
  }
  return ends;
}

/** Pass 3 value at logical index l: local[l] + a^(p+1) * carry[block]. */
export function fixed(
  local: Float32Array,
  carries: Float32Array,
  pows: Float32Array,
  l: number,
  c = BLOCK,
): number {
  const b = Math.floor(l / c);
  const p = l - b * c;
  return f(local[l] + f(pows[p + 1] * carries[b]));
}

/** Full first-order scan (passes 1-3). */
export function scanIir(input: Float32Array, a: number, wg = WG, k = K): Float32Array {
  const c = wg * k;
  const pows = powTable(a, c);
  const { local, ends } = localBlockScan(input, a, pows, wg, k);
  carryPass(ends, Math.pow(a, c));
  const out = new Float32Array(input.length);
  for (let l = 0; l < input.length; l++) out[l] = fixed(local, ends, pows, l, c);
  return out;
}

/** Scan-based forward operator: delayed, 1/peak-prescaled cascade d then r. */
export function scanForward(src: Float32Array, p: BandedParams, wg = WG, k = K): Float32Array {
  const T = src.length;
  const x = new Float32Array(T);
  for (let t = 1; t < T; t++) x[t] = f(src[t - 1] * p.invPeakF32);
  return scanIir(scanIir(x, p.decayRootF32, wg, k), p.riseRootF32, wg, k);
}

/** Scan-based adjoint: reverse cascade, then out[t-1] = a[t], out[T-1] = 0. */
export function scanAdjoint(src: Float32Array, p: BandedParams, wg = WG, k = K): Float32Array {
  const T = src.length;
  const rev = new Float32Array(T);
  for (let l = 0; l < T; l++) rev[l] = f(src[T - 1 - l] * p.invPeakF32);
  const aRev = scanIir(scanIir(rev, p.decayRootF32, wg, k), p.riseRootF32, wg, k);
  const out = new Float32Array(T);
  for (let t = 1; t < T; t++) out[t - 1] = aRev[T - 1 - t];
  return out;
}

/** Serial port of `BandedAR2::convolve_forward` (f32 arithmetic). */
export function serialForward(src: Float32Array, p: BandedParams): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const g1 = p.g1F32;
  const g2 = p.g2F32;
  const inv = p.invPeakF32;
  out[0] = 0;
  if (n > 1) out[1] = f(f(g1 * out[0]) + f(src[0] * inv));
  for (let t = 2; t < n; t++) {
    out[t] = f(f(f(g1 * out[t - 1]) + f(g2 * out[t - 2])) + f(src[t - 1] * inv));
  }
  return out;
}

/** Serial port of `BandedAR2::convolve_adjoint` (f32 arithmetic). */
export function serialAdjoint(src: Float32Array, p: BandedParams): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const g1 = p.g1F32;
  const g2 = p.g2F32;
  const inv = p.invPeakF32;
  out[n - 1] = 0;
  let a1 = 0;
  let a2 = 0;
  for (let t = n - 1; t >= 0; t--) {
    const at = f(f(f(src[t] * inv) + f(g1 * a1)) + f(g2 * a2));
    if (t >= 1) out[t - 1] = at;
    a2 = a1;
    a1 = at;
  }
  return out;
}

/** Relative L2 error ||a - b|| / max(||b||, tiny). */
export function relL2(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    num += d * d;
    den += b[i] * b[i];
  }
  return Math.sqrt(num) / Math.max(Math.sqrt(den), 1e-30);
}

/** Max absolute difference. */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
