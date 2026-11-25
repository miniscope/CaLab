/**
 * The GPU compressor's factors against the CPU's (`?debug&gpucheck=N`): a
 * tile's quantized frames cut out of frame-order frames, a tile's bytes
 * (`TileFactors.toBytes()`, `CTF2`) read back, and the distance between two
 * reconstructions of the same tile. Pure.
 *
 * A tile reconstructs as `Ŷ = mean · 1ᵀ + S · Tᵀ` (`P x T`; `S`: `P x rank`,
 * `T`: `frames x rank`). Distances go through the `rank x rank` Gram
 * matrices, never the `P x T` frames: `‖S_a T_aᵀ − S_b T_bᵀ‖²` is
 * `Σ (S_aᵀS_a ∘ T_aᵀT_a) + Σ (S_bᵀS_b ∘ T_bᵀT_b) − 2 Σ (S_aᵀS_b ∘ T_aᵀT_b)`.
 */

/** The parts of a `CTF2` (or `CTF1`) tile the check reads. */
export interface TileView {
  w: number;
  h: number;
  rank: number;
  /** `Σ (y − mean)²` the kept components hold. */
  keptEnergy: number;
  frames: number;
  mean: Float32Array;
  /** `P x rank`, row-major. */
  spatial: Float32Array;
  /** `frames x rank`, row-major. */
  temporal: Float32Array;
}

/** Read a tile's bytes (the layout of `TileFactors::to_bytes`). */
export function readTile(bytes: Uint8Array): TileView {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'CTF2' && magic !== 'CTF1') throw new Error(`not a tile (${magic})`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u = (i: number): number => dv.getUint32(4 + 4 * i, true);
  const [w, h, rank, frames] = [u(2), u(3), u(4), u(5)];
  const p = w * h;
  const head = magic === 'CTF2' ? 3 * p : p;
  const n = head + p * rank + frames * rank;
  if (bytes.length !== 48 + 4 * n) throw new Error('a tile of the wrong length');
  // A copy: the bytes may sit at an offset that is not a multiple of 4.
  const vals = new Float32Array(bytes.slice(48).buffer);
  return {
    w,
    h,
    rank,
    keptEnergy: dv.getFloat64(40, true),
    frames,
    mean: vals.subarray(0, p),
    spatial: vals.subarray(head, head + p * rank),
    temporal: vals.subarray(head + p * rank),
  };
}

/** `Xᵀ Y` of `X` (`n x a`) and `Y` (`n x b`), row-major, in f64. */
function gram(x: Float32Array, a: number, y: Float32Array, b: number, n: number): Float64Array {
  const g = new Float64Array(a * b);
  for (let r = 0; r < n; r++) {
    const xr = r * a;
    const yr = r * b;
    for (let i = 0; i < a; i++) {
      const xi = x[xr + i];
      if (xi === 0) continue;
      const gi = i * b;
      for (let j = 0; j < b; j++) g[gi + j] += xi * y[yr + j];
    }
  }
  return g;
}

/** `Σ (g ∘ k)` of two matrices of one shape. */
function dot(g: Float64Array, k: Float64Array): number {
  let s = 0;
  for (let i = 0; i < g.length; i++) s += g[i] * k[i];
  return s;
}

/** `S · (Tᵀ 1)`: each pixel's sum over the frames of the low-rank part. */
function rowSums(t: TileView): Float64Array {
  const { rank, frames, spatial, temporal } = t;
  const colSum = new Float64Array(rank);
  for (let f = 0; f < frames; f++)
    for (let k = 0; k < rank; k++) colSum[k] += temporal[f * rank + k];
  const p = t.w * t.h;
  const out = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let s = 0;
    for (let k = 0; k < rank; k++) s += spatial[i * rank + k] * colSum[k];
    out[i] = s;
  }
  return out;
}

/** `‖S Tᵀ‖²` of a tile, and `⟨S_a T_aᵀ, S_b T_bᵀ⟩` of two. */
function lowRankDot(a: TileView, b: TileView): number {
  const p = a.w * a.h;
  return dot(
    gram(a.spatial, a.rank, b.spatial, b.rank, p),
    gram(a.temporal, a.rank, b.temporal, b.rank, a.frames),
  );
}

/**
 * Two reconstructions of one tile: `diff` = `‖Ŷ_a − Ŷ_b‖²`, `ref` = `‖Ŷ_b‖²`
 * and `signal` = `‖Ŷ_b − mean_b · 1ᵀ‖²` (what `b`'s factors kept).
 */
export function tileDiff(a: TileView, b: TileView): { diff: number; ref: number; signal: number } {
  const p = a.w * a.h;
  if (b.w * b.h !== p || a.frames !== b.frames) throw new Error('tiles of different shapes');
  const t = a.frames;
  const aa = lowRankDot(a, a);
  const bb = lowRankDot(b, b);
  const ab = lowRankDot(a, b);
  const ra = rowSums(a);
  const rb = rowSums(b);
  // ‖dm 1ᵀ + (A − B)‖² = T ‖dm‖² + ‖A − B‖² + 2 dmᵀ (A 1 − B 1); ‖m 1ᵀ + B‖² likewise.
  let dm2 = 0;
  let cross = 0;
  let m2 = 0;
  let mb = 0;
  for (let i = 0; i < p; i++) {
    const dm = a.mean[i] - b.mean[i];
    dm2 += dm * dm;
    cross += dm * (ra[i] - rb[i]);
    m2 += b.mean[i] * b.mean[i];
    mb += b.mean[i] * rb[i];
  }
  const signal = Math.max(0, bb);
  return {
    diff: Math.max(0, t * dm2 + (aa + bb - 2 * ab) + 2 * cross),
    ref: Math.max(0, t * m2 + bb + 2 * mb),
    signal,
  };
}

/**
 * Tile `(x0, y0, w, h)` of `count` frames (frame layout, `width` px wide) into
 * `out` (`count x w*h`, a frame per row): what `quantizeTiles` gives the CPU.
 */
export function cutTile(
  frames: Int16Array,
  width: number,
  height: number,
  count: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  out: Int16Array,
): void {
  const hw = width * height;
  let o = 0;
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < h; y++) {
      const row = t * hw + (y0 + y) * width + x0;
      out.set(frames.subarray(row, row + w), o);
      o += w;
    }
  }
}
