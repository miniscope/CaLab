/**
 * WGSL kernels of the GPU window compressor (`gpu-compress.ts`): the 24 Nov
 * probe's kernels generalised to tiles of any size up to 64 x 64, a ring of
 * frames held in blocks, `stride` sketch columns (a multiple of 64), the mean
 * per frame pixel and missing samples.
 *
 * Every product is per tile *slot* (`workgroup_id.z`): slot `s` of a batch
 * owns rows `[s * rows, (s + 1) * rows)` of each work buffer, `stride`
 * columns wide, row-major.
 */

/** Rows of a slot of `Y` / `Q`: the pixels of the largest tile. */
export const TILE_ROWS = 4096;

/**
 * One ring block's share of a product with the window's centred data `A`
 * (`p x T`, a tile's pixels by the window's frames). The block holds frames
 * as packed i16 (two per u32 word); window frame `o + k` of this dispatch is
 * block slot `s0 + k`.
 *
 * - `trans = 0`: `C (4096 x stride) (+)= A[:, o..o+K) B[o..o+K, :]`, `B` is
 *   `T x stride` per slot, `M = 4096`, `K` = the block's frames; `add = 1`
 *   adds to `C` (every block after the first).
 * - `trans = 1`: `C[o..o+M, :] = A[:, o..o+M)ᵀ B`, `B` is `4096 x stride` per
 *   slot, `C` is `T x stride` per slot, `M` = the block's frames, `K = 4096`.
 *
 * Uniforms: 12 x u32 (`invq` as f32 at index 6). Dispatch
 * `(ceil(M / 64), stride / 64, slots)`.
 */
export const GEMM = /* wgsl */ `
struct Dims { M: u32, K: u32, trans: u32, T: u32, W: u32, HWp: u32, invq: f32, s0: u32, o: u32, add: u32, stride: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> frames: array<u32>;
@group(0) @binding(1) var<storage, read> tiles: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> mean: array<f32>;
@group(0) @binding(3) var<storage, read> B: array<f32>;
@group(0) @binding(4) var<storage, read_write> C: array<f32>;
@group(0) @binding(5) var<uniform> d: Dims;
const P: u32 = ${TILE_ROWS}u;
var<workgroup> As: array<array<f32, 16>, 64>;
var<workgroup> Bs: array<array<f32, 64>, 16>;
fn aval(slot: u32, p: u32, t: u32) -> f32 {
  let tl = tiles[slot];
  if (p >= tl.z * tl.w) { return 0.0; }
  let pix = (tl.y + p / tl.z) * d.W + tl.x + (p % tl.z);
  let idx = (d.s0 + t) * d.HWp + pix;
  let word = frames[idx >> 1u];
  var v: u32 = word >> 16u;
  if ((idx & 1u) == 0u) { v = word & 0xffffu; }
  let s = bitcast<i32>(v << 16u) >> 16u;
  if (s == -32768) { return 0.0; }
  return f32(s) * d.invq - mean[pix];
}
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let slot = wg.z; let row0 = wg.x * 64u; let col0 = wg.y * 64u;
  let tx = lid.x; let ty = lid.y; let li = ty * 16u + tx;
  let bRows = select(P, d.T, d.trans == 0u);
  let cRows = select(d.T, P, d.trans == 0u);
  var acc: array<array<f32, 4>, 4>;
  for (var k0 = 0u; k0 < d.K; k0 += 16u) {
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e;
      var r: u32; var k: u32;
      if (d.trans == 0u) { r = flat % 64u; k = flat / 64u; } else { k = flat % 16u; r = flat / 16u; }
      let gr = row0 + r; let gk = k0 + k;
      var v = 0.0;
      if (gr < d.M && gk < d.K) {
        if (d.trans == 0u) { v = aval(slot, gr, gk); } else { v = aval(slot, gk, gr); }
      }
      As[r][k] = v;
    }
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e; let k = flat / 64u; let c = flat % 64u;
      let gk = k0 + k;
      var v = 0.0;
      if (gk < d.K) {
        let br = select(gk, d.o + gk, d.trans == 0u);
        v = B[(slot * bRows + br) * d.stride + col0 + c];
      }
      Bs[k][c] = v;
    }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) {
      for (var i = 0u; i < 4u; i++) {
        let a = As[ty * 4u + i][k];
        for (var j = 0u; j < 4u; j++) { acc[i][j] += a * Bs[k][tx * 4u + j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let gr = row0 + ty * 4u + i;
    if (gr < d.M) {
      let cr = select(d.o + gr, gr, d.trans == 0u);
      let cb = (slot * cRows + cr) * d.stride + col0 + tx * 4u;
      for (var j = 0u; j < 4u; j++) {
        if (d.add == 1u) { C[cb + j] += acc[i][j]; } else { C[cb + j] = acc[i][j]; }
      }
    }
  }
}`;

/** `G = Yᵀ Y` per slot (`stride x stride`), `Y` is `M x stride`. Dispatch (stride/64, stride/64, slots). */
export const GRAM = /* wgsl */ `
struct G { M: u32, stride: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> Y: array<f32>;
@group(0) @binding(1) var<storage, read_write> Gm: array<f32>;
@group(0) @binding(2) var<uniform> g: G;
var<workgroup> Ya: array<array<f32, 64>, 16>;
var<workgroup> Yb: array<array<f32, 64>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let slot = wg.z; let a0 = wg.x * 64u; let b0 = wg.y * 64u;
  let tx = lid.x; let ty = lid.y; let li = ty * 16u + tx;
  var acc: array<array<f32, 4>, 4>;
  for (var r0 = 0u; r0 < g.M; r0 += 16u) {
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e; let r = flat / 64u; let c = flat % 64u;
      var va = 0.0; var vb = 0.0;
      if (r0 + r < g.M) {
        let o = slot * g.M * g.stride + (r0 + r) * g.stride;
        va = Y[o + a0 + c]; vb = Y[o + b0 + c];
      }
      Ya[r][c] = va; Yb[r][c] = vb;
    }
    workgroupBarrier();
    for (var r = 0u; r < 16u; r++) {
      for (var i = 0u; i < 4u; i++) {
        let a = Ya[r][ty * 4u + i];
        for (var j = 0u; j < 4u; j++) { acc[i][j] += a * Yb[r][tx * 4u + j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    for (var j = 0u; j < 4u; j++) {
      Gm[slot * g.stride * g.stride + (a0 + ty * 4u + i) * g.stride + b0 + tx * 4u + j] = acc[i][j];
    }
  }
}`;

/** `Q = Y R⁻¹` per slot (`R⁻¹` upper triangular, `stride x stride`). Dispatch (stride/64, ceil(M/4), slots). */
export const APPLY = /* wgsl */ `
struct G { M: u32, stride: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> Y: array<f32>;
@group(0) @binding(1) var<storage, read> R: array<f32>;
@group(0) @binding(2) var<storage, read_write> Q: array<f32>;
@group(0) @binding(3) var<uniform> g: G;
@compute @workgroup_size(64, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wg: vec3<u32>) {
  let slot = wg.z; let c = gid.x; let r = gid.y;
  if (r >= g.M || c >= g.stride) { return; }
  let yo = slot * g.M * g.stride + r * g.stride;
  let ro = slot * g.stride * g.stride;
  var s = 0.0;
  for (var k = 0u; k <= c; k++) { s += Y[yo + k] * R[ro + k * g.stride + c]; }
  Q[yo + c] = s;
}`;

/** Invocations of a `CHOL` workgroup (WebGPU's default limit). */
export const CHOL_THREADS = 256;

/**
 * CholeskyQR's `R⁻¹` per slot from its Gram block, one workgroup per slot:
 * `chol_inv_upper` (Rust, `compress/mod.rs`) in f32. A slot whose leading
 * `l x l` block is all zero gets a zero `R⁻¹` (a tile without variance);
 * otherwise the upper Cholesky factor of `G + shift * trace * I` for the
 * first shift of `[0, 1e-10, 1e-8, 1e-6, 1e-4, 1e-2]` whose every pivot is
 * positive and finite, then its inverse by back substitution, a column per
 * invocation. A slot that fails at every shift sets `flags[slot] = 1` (and
 * a zero `R⁻¹`); `flags` is never cleared here.
 *
 * `G`, `Rw` (the factor, scratch) and `Rinv` are `stride x stride` per slot,
 * row-major; entries outside the leading `l x l` block of `Rinv` are zero.
 * The blocks stay in storage buffers: at `l = 320` one is 400 KB, far over
 * the 16 KB of workgroup memory WebGPU guarantees. Dispatch `(slots, 1, 1)`.
 */
export const CHOL = /* wgsl */ `
struct C { stride: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> G: array<f32>;
@group(0) @binding(1) var<storage, read> ls: array<u32>;
@group(0) @binding(2) var<storage, read_write> Rw: array<f32>;
@group(0) @binding(3) var<storage, read_write> Rinv: array<f32>;
@group(0) @binding(4) var<storage, read_write> flags: array<u32>;
@group(0) @binding(5) var<uniform> c: C;
const NT: u32 = ${CHOL_THREADS}u;
var<workgroup> sumTr: array<f32, ${CHOL_THREADS}>;
var<workgroup> sumNz: array<u32, ${CHOL_THREADS}>;
var<workgroup> wl: u32;
var<workgroup> wtr: f32;
var<workgroup> wnz: u32;
var<workgroup> wpiv: f32;
// Finite by its exponent bits: comparisons with NaN may be folded away.
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }
fn shiftAt(i: u32) -> f32 {
  switch i {
    case 0u: { return 0.0; }
    case 1u: { return 1e-10; }
    case 2u: { return 1e-8; }
    case 3u: { return 1e-6; }
    case 4u: { return 1e-4; }
    default: { return 1e-2; }
  }
}
fn zeroRinv(g0: u32, li: u32) {
  for (var e = li; e < c.stride * c.stride; e += NT) { Rinv[g0 + e] = 0.0; }
}
@compute @workgroup_size(${CHOL_THREADS})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let slot = wg.x;
  let st = c.stride;
  let g0 = slot * st * st;
  if (li == 0u) { wl = ls[slot]; }
  let l = workgroupUniformLoad(&wl);
  // The trace and the non-zero entries (NaN counts as non-zero) of the l x l block.
  var tr = 0.0;
  var nz = 0u;
  for (var i = li; i < l; i += NT) { tr += G[g0 + i * st + i]; }
  for (var e = li; e < l * l; e += NT) {
    if ((bitcast<u32>(G[g0 + (e / l) * st + e % l]) & 0x7fffffffu) != 0u) { nz += 1u; }
  }
  sumTr[li] = tr;
  sumNz[li] = nz;
  workgroupBarrier();
  for (var h = NT / 2u; h > 0u; h >>= 1u) {
    if (li < h) { sumTr[li] += sumTr[li + h]; sumNz[li] += sumNz[li + h]; }
    workgroupBarrier();
  }
  if (li == 0u) { wtr = sumTr[0]; wnz = sumNz[0]; }
  let trace = workgroupUniformLoad(&wtr);
  if (workgroupUniformLoad(&wnz) == 0u) {
    zeroRinv(g0, li); // nothing to sketch: Q = 0, as compress_tile's tile
    return;
  }
  var ok = false;
  for (var si = 0u; si < 6u; si++) {
    let shift = shiftAt(si) * trace;
    var failed = false;
    // Upper R row by row: R[i, j] = (G[i, j] (+ shift) - sum_k<i R[k, i] R[k, j]) / R[i, i].
    for (var i = 0u; i < l; i++) {
      for (var j = i + li; j < l; j += NT) {
        var s = G[g0 + i * st + j];
        if (j == i) { s += shift; }
        for (var k = 0u; k < i; k++) { s -= Rw[g0 + k * st + i] * Rw[g0 + k * st + j]; }
        Rw[g0 + i * st + j] = s;
        if (j == i) { wpiv = s; }
      }
      let piv = workgroupUniformLoad(&wpiv);
      if (!(piv > 0.0) || !finite(piv)) {
        failed = true;
        break;
      }
      let d = sqrt(piv);
      for (var j = i + li; j < l; j += NT) {
        if (j == i) { Rw[g0 + i * st + i] = d; } else { Rw[g0 + i * st + j] /= d; }
      }
      storageBarrier();
    }
    if (!failed) {
      ok = true;
      break;
    }
    storageBarrier();
  }
  if (!ok) {
    if (li == 0u) { flags[slot] = 1u; }
    zeroRinv(g0, li);
    return;
  }
  // R⁻¹ column j by back substitution of R x = e_j; zero below and beyond l.
  for (var j = li; j < st; j += NT) {
    var top = 0u;
    if (j < l) {
      for (var ii = 0u; ii <= j; ii++) {
        let i = j - ii;
        var s = select(0.0, 1.0, i == j);
        for (var k = i + 1u; k <= j; k++) { s -= Rw[g0 + i * st + k] * Rinv[g0 + k * st + j]; }
        Rinv[g0 + i * st + j] = s / Rw[g0 + i * st + i];
      }
      top = j + 1u;
    }
    for (var i = top; i < st; i++) { Rinv[g0 + i * st + j] = 0.0; }
  }
}`;
