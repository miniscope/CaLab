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
