/**
 * Plain-TypeScript model of the GPU's chunked-scan AR(2) operators.
 *
 * The AR(2) is carried as one 2-state linear system instead of two cascaded
 * first-order scans. With x_j = src[j] / peak, the forward state
 * s_j = (u_j, w_j) obeys
 *
 *   u_j = d u_{j-1} + x_j,  w_j = r w_{j-1} + u_j   <=>   s_j = A s_{j-1} + e x_j,
 *
 * A = [[d, 0], [d, r]], e = (1, 1), and c[t] = w_{t-1} (c[0] = 0). The adjoint
 * runs the same system in reverse: q_t = (v_t, a_t) = A q_{t+1} + e z_t with
 * z_t = resid[t] / peak, and gradient[t] = a_{t+1} (a_T = 0).
 *
 * Inside a thread the recursion is sequential (the exact cascade arithmetic).
 * Across the WG threads of a block a Hillis-Steele scan combines 2-vectors
 * with hop matrices A^(K·2^i); the block's carry-in seeds the first thread
 * (the last one, in reverse). Across blocks, one thread per cell walks the
 * blocks with A^C. All matrix powers are computed on the host in f64 and
 * uploaded as f32 (`buildScanTables`).
 *
 * The functions below mirror the WGSL (src/shaders/fista-wgsl.ts) block by
 * block, with every operation rounded to f32, so they can be checked in Node
 * against the serial Rust recursion before any GPU is involved.
 */
import type { BandedParams } from './banded-params.ts';

export const WG = 256;
export const K = 4;
export const BLOCK = WG * K;

const f = Math.fround;

/** Column-major 2x2: [m00, m10, m01, m11]. f64 helpers for the host tables. */
type Mat = [number, number, number, number];
type Vec = [number, number];

function matMul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
  ];
}

function matVec(m: Mat, v: Vec): Vec {
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}

/**
 * Layout of the f32 table buffer, in vec4 slots:
 *
 *   [HOP + i]      A^(K·2^i), i < log2(WG)          (column-major mat2)
 *   [AC]           A^C
 *   [ALAST]        A^L, L = length of the last block
 *   [GFULL/GLAST]  G = Σ_{k<L} A^k e e2ᵀ A^k        (full / last block)
 *   [GAM]          (γ_full, γ_last), γ = Σ_{k<L} (e2ᵀ A^k)ᵀ
 *   [OSUM]         (O_full, O_last), O = Σ_{k<L} A^k e
 *   [POS0 + p]     (A^(C-1-p) e, A^p e)
 *   [POS1 + p]     (β_full[p], β_last[p]), β[p] = Σ_{k=p+1}^{L-1} A^k e h[k-1-p]
 *   [POS2 + p]     (δ_full[p], δ_last[p], 0, 0), δ[p] = Σ_{n=0}^{L-2-p} h[n]
 *
 * with e2 = (0, 1) and h[n] = e2ᵀ A^n e the impulse response.
 */
export interface ScanTables {
  wg: number;
  k: number;
  C: number;
  T: number;
  nBlocks: number;
  lastLen: number;
  logWg: number;
  data: Float32Array;
  HOP: number;
  AC: number;
  ALAST: number;
  GFULL: number;
  GLAST: number;
  GAM: number;
  OSUM: number;
  POS0: number;
  POS1: number;
  POS2: number;
}

/** Header vec4 slots before the per-position tables. */
export function tableHeaderSlots(wg: number): number {
  return Math.log2(wg) + 6;
}

export function buildScanTables(
  d: number,
  r: number,
  T: number,
  wg: number = WG,
  k: number = K,
): ScanTables {
  const C = wg * k;
  const logWg = Math.round(Math.log2(wg));
  if (1 << logWg !== wg) throw new Error('WG must be a power of two');
  const nBlocks = Math.max(1, Math.ceil(T / C));
  const lastLen = T - (nBlocks - 1) * C;
  const HOP = 0;
  const AC = logWg;
  const ALAST = AC + 1;
  const GFULL = AC + 2;
  const GLAST = AC + 3;
  const GAM = AC + 4;
  const OSUM = AC + 5;
  const POS0 = AC + 6;
  const POS1 = POS0 + C;
  const POS2 = POS1 + C;
  const data = new Float32Array(4 * (POS2 + C));

  const A: Mat = [d, d, 0, r];
  const pw: Mat[] = [[1, 0, 0, 1]];
  for (let n = 1; n <= C; n++) pw.push(matMul(A, pw[n - 1]));
  const Ae = pw.map((m) => matVec(m, [1, 1])); // A^n e
  const h = Ae.map((v) => v[1]); // e2ᵀ A^n e

  const put = (slot: number, v: number[]) => data.set(v, 4 * slot);
  for (let i = 0; i < logWg; i++) put(HOP + i, pw[k << i]);
  put(AC, pw[C]);
  put(ALAST, pw[lastLen]);

  const blockSums = (L: number) => {
    const G: Mat = [0, 0, 0, 0];
    const gam: Vec = [0, 0];
    const O: Vec = [0, 0];
    for (let kk = 0; kk < L; kk++) {
      const m = pw[kk];
      // A^k e e2ᵀ A^k: column j = A^k e * (e2ᵀ A^k)_j = Ae[k] * m[row 1, col j]
      const rowW: Vec = [m[1], m[3]];
      G[0] += Ae[kk][0] * rowW[0];
      G[1] += Ae[kk][1] * rowW[0];
      G[2] += Ae[kk][0] * rowW[1];
      G[3] += Ae[kk][1] * rowW[1];
      gam[0] += rowW[0];
      gam[1] += rowW[1];
      O[0] += Ae[kk][0];
      O[1] += Ae[kk][1];
    }
    const beta: Vec[] = [];
    const delta: number[] = [];
    // hPrefix[n] = Σ_{i<=n} h[i]
    const hPrefix: number[] = [];
    let acc = 0;
    for (let n = 0; n < C; n++) hPrefix.push((acc += h[n]));
    for (let p = 0; p < C; p++) {
      let b0 = 0;
      let b1 = 0;
      for (let kk = p + 1; kk < L; kk++) {
        const hv = h[kk - 1 - p];
        b0 += Ae[kk][0] * hv;
        b1 += Ae[kk][1] * hv;
      }
      beta.push([b0, b1]);
      delta.push(L - 2 - p >= 0 ? hPrefix[L - 2 - p] : 0);
    }
    return { G, gam, O, beta, delta };
  };
  const full = blockSums(C);
  const last = blockSums(lastLen);
  put(GFULL, full.G);
  put(GLAST, last.G);
  put(GAM, [...full.gam, ...last.gam]);
  put(OSUM, [...full.O, ...last.O]);
  for (let p = 0; p < C; p++) {
    put(POS0 + p, [...Ae[C - 1 - p], ...Ae[p]]);
    put(POS1 + p, [...full.beta[p], ...last.beta[p]]);
    put(POS2 + p, [full.delta[p], last.delta[p], 0, 0]);
  }
  return {
    wg,
    k,
    C,
    T,
    nBlocks,
    lastLen,
    logWg,
    data,
    HOP,
    AC,
    ALAST,
    GFULL,
    GLAST,
    GAM,
    OSUM,
    POS0,
    POS1,
    POS2,
  };
}

/** f32 mat2 (column-major, at vec4 slot) times vec2. */
export function mv(tb: ScanTables, slot: number, v0: number, v1: number): Vec {
  const m = tb.data;
  const o = 4 * slot;
  return [f(f(m[o] * v0) + f(m[o + 2] * v1)), f(f(m[o + 1] * v0) + f(m[o + 3] * v1))];
}

/**
 * Forward scan of one block, as one workgroup runs it. `xin` holds the C
 * prescaled inputs x_j (zero past T); `sIn` is the state before the block.
 * Returns c at each position: c[p] = w before x_p is consumed.
 */
export function blockForward(
  xin: Float32Array,
  sIn: Vec,
  d: number,
  r: number,
  tb: ScanTables,
): Float32Array {
  const { wg, k, C } = tb;
  const df = f(d);
  const rf = f(r);
  let sh: Vec[] = [];
  for (let tid = 0; tid < wg; tid++) {
    let u = tid === 0 ? sIn[0] : 0;
    let w = tid === 0 ? sIn[1] : 0;
    for (let kk = 0; kk < k; kk++) {
      u = f(f(df * u) + xin[tid * k + kk]);
      w = f(f(rf * w) + u);
    }
    sh.push([u, w]);
  }
  for (let i = 0; i < tb.logWg; i++) {
    const o = 1 << i;
    sh = sh.map((v, tid) => {
      if (tid < o) return v;
      const m = mv(tb, tb.HOP + i, sh[tid - o][0], sh[tid - o][1]);
      return [f(v[0] + m[0]), f(v[1] + m[1])];
    });
  }
  const c = new Float32Array(C);
  for (let tid = 0; tid < wg; tid++) {
    let [u, w] = tid === 0 ? sIn : sh[tid - 1];
    for (let kk = 0; kk < k; kk++) {
      c[tid * k + kk] = w;
      u = f(f(df * u) + xin[tid * k + kk]);
      w = f(f(rf * w) + u);
    }
  }
  return c;
}

/**
 * Reverse scan of one block. `z` holds the C prescaled adjoint inputs (zero
 * past T); `qIn` is the state entering the block from above. Returns
 * g[p] = a_{p+1}, i.e. the gradient at p.
 */
export function blockReverse(
  z: Float32Array,
  qIn: Vec,
  d: number,
  r: number,
  tb: ScanTables,
): Float32Array {
  const { wg, k, C } = tb;
  const df = f(d);
  const rf = f(r);
  let sh: Vec[] = [];
  for (let tid = 0; tid < wg; tid++) {
    let v = tid === wg - 1 ? qIn[0] : 0;
    let a = tid === wg - 1 ? qIn[1] : 0;
    for (let kk = k - 1; kk >= 0; kk--) {
      v = f(f(df * v) + z[tid * k + kk]);
      a = f(f(rf * a) + v);
    }
    sh.push([v, a]);
  }
  for (let i = 0; i < tb.logWg; i++) {
    const o = 1 << i;
    sh = sh.map((q, tid) => {
      if (tid + o >= wg) return q;
      const m = mv(tb, tb.HOP + i, sh[tid + o][0], sh[tid + o][1]);
      return [f(q[0] + m[0]), f(q[1] + m[1])];
    });
  }
  const g = new Float32Array(C);
  for (let tid = 0; tid < wg; tid++) {
    let [v, a] = tid === wg - 1 ? qIn : sh[tid + 1];
    for (let kk = k - 1; kk >= 0; kk--) {
      g[tid * k + kk] = a;
      v = f(f(df * v) + z[tid * k + kk]);
      a = f(f(rf * a) + v);
    }
  }
  return g;
}

/**
 * Workgroup reduction of per-element terms, the way the WGSL does it: each
 * thread sums its K elements in order, then a tree over the WG threads.
 * `term(p, out)` adds element p's contributions into `out` (length n).
 */
export function blockReduce(
  tb: ScanTables,
  n: number,
  term: (p: number, out: Float32Array) => void,
): Float32Array {
  const { wg, k } = tb;
  const red = Array.from({ length: wg }, () => new Float32Array(n));
  for (let tid = 0; tid < wg; tid++) {
    for (let kk = 0; kk < k; kk++) term(tid * k + kk, red[tid]);
  }
  for (let s = wg / 2; s > 0; s >>= 1) {
    for (let tid = 0; tid < s; tid++) {
      for (let j = 0; j < n; j++) red[tid][j] = f(red[tid][j] + red[tid + s][j]);
    }
  }
  return red[0];
}

/** Copy block b of `src` (scaled by `scale`) into a zero-padded block buffer. */
function blockSlice(src: Float32Array, b: number, C: number, scale: number): Float32Array {
  const out = new Float32Array(C);
  for (let p = 0; p < C; p++) {
    const t = b * C + p;
    if (t < src.length) out[p] = f(src[t] * scale);
  }
  return out;
}

/** Forward block aggregate Σ_p A^(C-1-p) e x_p (the state change over a full block). */
export function forwardAggregate(tb: ScanTables, xin: Float32Array): Vec {
  const r = blockReduce(tb, 2, (p, o) => {
    const w = 4 * (tb.POS0 + p);
    o[0] = f(o[0] + f(tb.data[w] * xin[p]));
    o[1] = f(o[1] + f(tb.data[w + 1] * xin[p]));
  });
  return [r[0], r[1]];
}

/** Reverse block aggregate Σ_p A^p e z_p (state at the block bottom, zero from above). */
export function reverseAggregate(tb: ScanTables, z: Float32Array): Vec {
  const r = blockReduce(tb, 2, (p, o) => {
    const w = 4 * (tb.POS0 + p) + 2;
    o[0] = f(o[0] + f(tb.data[w] * z[p]));
    o[1] = f(o[1] + f(tb.data[w + 1] * z[p]));
  });
  return [r[0], r[1]];
}

/** Scan-based forward operator: c[t] = (K src)[t]. */
export function scanForward(src: Float32Array, p: BandedParams, wg = WG, k = K): Float32Array {
  const T = src.length;
  const d = p.decayRootF32;
  const r = p.riseRootF32;
  const tb = buildScanTables(d, r, T, wg, k);
  const out = new Float32Array(T);
  let s: Vec = [0, 0];
  for (let b = 0; b < tb.nBlocks; b++) {
    const xin = blockSlice(src, b, tb.C, p.invPeakF32);
    const c = blockForward(xin, s, d, r, tb);
    for (let q = 0; q < tb.C && b * tb.C + q < T; q++) out[b * tb.C + q] = c[q];
    const F = forwardAggregate(tb, xin);
    const m = mv(tb, tb.AC, s[0], s[1]);
    s = [f(m[0] + F[0]), f(m[1] + F[1])];
  }
  return out;
}

/** Scan-based adjoint: out[t] = a_{t+1}, out[T-1] = 0. */
export function scanAdjoint(src: Float32Array, p: BandedParams, wg = WG, k = K): Float32Array {
  const T = src.length;
  const d = p.decayRootF32;
  const r = p.riseRootF32;
  const tb = buildScanTables(d, r, T, wg, k);
  const out = new Float32Array(T);
  let q: Vec = [0, 0];
  for (let b = tb.nBlocks - 1; b >= 0; b--) {
    const z = blockSlice(src, b, tb.C, p.invPeakF32);
    const g = blockReverse(z, q, d, r, tb);
    for (let i = 0; i < tb.C && b * tb.C + i < T; i++) out[b * tb.C + i] = g[i];
    const Q = reverseAggregate(tb, z);
    const m = mv(tb, b === tb.nBlocks - 1 ? tb.ALAST : tb.AC, q[0], q[1]);
    q = [f(m[0] + Q[0]), f(m[1] + Q[1])];
  }
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
