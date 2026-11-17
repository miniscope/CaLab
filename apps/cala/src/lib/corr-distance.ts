/**
 * Pairwise trace correlation against centre distance: a diagnostic for
 * incomplete demixing of neighbouring cells (docs/stages.md, "Correlation vs
 * distance"). Two cells that are well separated have unrelated traces, so the
 * median Pearson r of far pairs sits near 0; neighbours whose light is shared
 * between their traces show excess r at close range.
 *
 * Definitions (the PI's reference analysis):
 * - traces are high-passed by subtracting a 15 s centred moving average (edges
 *   extended with the nearest sample), so slow drift does not correlate cells;
 * - r is the Pearson correlation of two high-passed traces over all frames;
 * - the distance is centre to centre in soma diameters D, where D is the
 *   median equivalent diameter at half maximum of the cells' footprints;
 * - pairs fall into the bins `CORR_BINS`; each bin reports median and IQR; the
 *   far-pair level is the median over the pairs at 1.5-3 D.
 *
 * Cost control: all pairs within `NEAR_D` (3 D) are used, plus a seeded random
 * sample of at most `maxFar` farther pairs. It runs once, on demand, in a
 * worker; never in the per-frame loop. Pure, unit-tested.
 */
import type { LibraryView } from '../workers/slow-types.ts';

/** Bin edges in soma diameters (the last bin is open-ended). */
export const CORR_EDGES = [0, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const CORR_BIN_LABELS = [
  '<0.5',
  '0.5-0.75',
  '0.75-1',
  '1-1.25',
  '1.25-1.5',
  '1.5-2',
  '2-3',
  '>3',
] as const;
/** The far-pair reference range, in D: bins 1.5-2 and 2-3. */
export const FAR_LO = 1.5;
export const FAR_HI = 3;
/** All pairs closer than this are used; the rest are sampled. */
export const NEAR_D = 3;
/** High-pass window, seconds. */
export const HP_SECONDS = 15;
/** Far (> 3 D) pairs sampled by default. */
export const DEFAULT_MAX_FAR = 20000;
/** A cell needs this many finite frames beyond the high-pass window to count. */
const MIN_FRAMES_FACTOR = 2;

export interface CorrBin {
  label: string;
  lo: number;
  /** Infinity for the last bin. */
  hi: number;
  n: number;
  median: number | null;
  q25: number | null;
  q75: number | null;
}

export interface CorrDistanceResult {
  bins: CorrBin[];
  /** Median r of the pairs at 1.5-3 D, the dotted reference (null: no such pairs). */
  farMedian: number | null;
  /** Soma diameter D, px (0: unknown, the distances are in px). */
  diameterPx: number;
  cells: number;
  /** Cells left out (too short or flat trace). */
  skipped: number;
  frames: number;
  pairsNear: number;
  pairsFar: number;
  /** Far pairs available before sampling. */
  pairsFarTotal: number;
  /** Wall time of the computation and the bytes it held, set by the caller. */
  ms?: number;
  bytes?: number;
}

/** Median equivalent diameter (px) of the footprints at half their maximum; 0 with none. */
export function somaDiameter(lib: Pick<LibraryView, 'starts' | 'values' | 'ids'>): number {
  const d: number[] = [];
  for (let i = 0; i < lib.ids.length; i++) {
    let max = 0;
    for (let k = lib.starts[i]; k < lib.starts[i + 1]; k++)
      if (lib.values[k] > max) max = lib.values[k];
    if (!(max > 0)) continue;
    let area = 0;
    for (let k = lib.starts[i]; k < lib.starts[i + 1]; k++) if (lib.values[k] >= 0.5 * max) area++;
    if (area > 0) d.push(2 * Math.sqrt(area / Math.PI));
  }
  return (
    quantile(
      d.sort((a, b) => a - b),
      0.5,
    ) ?? 0
  );
}

/** Linear-interpolated quantile of an ascending array (null when empty). */
export function quantile(sorted: ArrayLike<number>, q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * `x` minus its centred moving average of `window` frames (edges extended with
 * the nearest sample), written to `out`. Same as scipy's
 * `x - uniform_filter1d(x, window, mode='nearest')`.
 */
export function highPass(x: ArrayLike<number>, window: number, out: Float64Array): Float64Array {
  const n = x.length;
  const w = Math.max(1, Math.floor(window));
  const left = Math.floor(w / 2);
  // Prefix sums of the edge-extended signal over [-left, n + w - left).
  const ext = n + w;
  const prefix = new Float64Array(ext + 1);
  for (let k = 0; k < ext; k++) {
    const i = Math.min(n - 1, Math.max(0, k - left));
    prefix[k + 1] = prefix[k] + x[i];
  }
  for (let i = 0; i < n; i++) out[i] = x[i] - (prefix[i + w] - prefix[i]) / w;
  return out;
}

/** Bin index of a distance in D. */
export function binOf(d: number): number {
  for (let b = CORR_EDGES.length - 1; b >= 0; b--) if (d >= CORR_EDGES[b]) return b;
  return 0;
}

/** Small seeded generator (mulberry32), so the sample is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairSet {
  /** Cell indices (rows of the matrix) of each pair, and its distance in D. */
  a: Uint32Array;
  b: Uint32Array;
  dist: Float32Array;
  near: number;
  far: number;
  farTotal: number;
}

/**
 * The pairs to correlate: every pair closer than `NEAR_D` plus at most `maxFar`
 * pairs from the rest, drawn uniformly without replacement (seeded).
 * `centers` is `(y, x)` per cell in px; `diameter` the soma diameter in px.
 */
export function selectPairs(
  centers: ArrayLike<number>,
  count: number,
  diameter: number,
  maxFar = DEFAULT_MAX_FAR,
  seed = 1,
): PairSet {
  const D = diameter > 0 ? diameter : 1;
  const nearA: number[] = [];
  const nearB: number[] = [];
  const nearD: number[] = [];
  const dist = (i: number, j: number) =>
    Math.hypot(centers[2 * i] - centers[2 * j], centers[2 * i + 1] - centers[2 * j + 1]) / D;
  // Reservoir sample of the far pairs, in one pass over all pairs.
  const rand = rng(seed);
  const cap = Math.max(0, Math.floor(maxFar));
  const farA = new Uint32Array(cap);
  const farB = new Uint32Array(cap);
  const farD = new Float32Array(cap);
  let seen = 0;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const d = dist(i, j);
      if (d < NEAR_D) {
        nearA.push(i);
        nearB.push(j);
        nearD.push(d);
      } else if (cap > 0) {
        if (seen < cap) {
          farA[seen] = i;
          farB[seen] = j;
          farD[seen] = d;
        } else {
          const r = Math.floor(rand() * (seen + 1));
          if (r < cap) {
            farA[r] = i;
            farB[r] = j;
            farD[r] = d;
          }
        }
        seen++;
      } else seen++;
    }
  }
  const nFar = Math.min(seen, cap);
  const total = nearA.length + nFar;
  const a = new Uint32Array(total);
  const b = new Uint32Array(total);
  const dd = new Float32Array(total);
  a.set(nearA);
  b.set(nearB);
  dd.set(nearD);
  a.set(farA.subarray(0, nFar), nearA.length);
  b.set(farB.subarray(0, nFar), nearA.length);
  dd.set(farD.subarray(0, nFar), nearA.length);
  return { a, b, dist: dd, near: nearA.length, far: nFar, farTotal: seen };
}

/** Median and quartiles per bin, and the 1.5-3 D far-pair median, from pair distances and r. */
export function binStats(
  dist: ArrayLike<number>,
  r: ArrayLike<number>,
): { bins: CorrBin[]; farMedian: number | null } {
  const groups: number[][] = CORR_EDGES.map(() => []);
  const far: number[] = [];
  for (let k = 0; k < dist.length; k++) {
    if (!Number.isFinite(r[k])) continue;
    groups[binOf(dist[k])].push(r[k]);
    if (dist[k] >= FAR_LO && dist[k] < FAR_HI) far.push(r[k]);
  }
  const bins = groups.map((g, b): CorrBin => {
    g.sort((x, y) => x - y);
    return {
      label: CORR_BIN_LABELS[b],
      lo: CORR_EDGES[b],
      hi: b + 1 < CORR_EDGES.length ? CORR_EDGES[b + 1] : Infinity,
      n: g.length,
      median: quantile(g, 0.5),
      q25: quantile(g, 0.25),
      q75: quantile(g, 0.75),
    };
  });
  far.sort((x, y) => x - y);
  return { bins, farMedian: quantile(far, 0.5) };
}

export interface CorrInput {
  /** Row-major `cells x frames` traces; NaN marks a missing frame. */
  traces: Float32Array;
  cells: number;
  frames: number;
  fps: number;
  /** `(y, x)` px per cell, interleaved. */
  centers: ArrayLike<number>;
  diameter: number;
  maxFar?: number;
  seed?: number;
}

/**
 * The whole computation. Each trace is high-passed, centred and scaled to unit
 * norm (a missing frame takes the cell's mean first, so it adds nothing), then
 * r of a pair is a dot product. Cells with fewer than two high-pass windows of
 * finite frames or a flat trace are skipped. Memory: one f32 copy of the
 * traces (the input buffer is reused in place).
 */
export function computeCorrDistance(input: CorrInput): CorrDistanceResult {
  const { traces, cells, frames } = input;
  const win = Math.max(2, Math.round(HP_SECONDS * (input.fps > 0 ? input.fps : 20)));
  const minFrames = MIN_FRAMES_FACTOR * win;
  const x = new Float64Array(frames);
  const y = new Float64Array(frames);
  const ok = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    const row = traces.subarray(c * frames, (c + 1) * frames);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < frames; t++)
      if (Number.isFinite(row[t])) {
        sum += row[t];
        n++;
      }
    if (n < minFrames) continue;
    const mean = sum / n;
    for (let t = 0; t < frames; t++) x[t] = Number.isFinite(row[t]) ? row[t] : mean;
    highPass(x, win, y);
    let m = 0;
    for (let t = 0; t < frames; t++) m += y[t];
    m /= frames;
    let ss = 0;
    for (let t = 0; t < frames; t++) {
      y[t] -= m;
      ss += y[t] * y[t];
    }
    const norm = Math.sqrt(ss);
    if (!(norm > 1e-9)) continue;
    for (let t = 0; t < frames; t++) row[t] = y[t] / norm;
    ok[c] = 1;
  }
  // Only the cells that count take part in the pairs.
  const rows: number[] = [];
  for (let c = 0; c < cells; c++) if (ok[c]) rows.push(c);
  const centers = new Float32Array(2 * rows.length);
  rows.forEach((c, k) => {
    centers[2 * k] = input.centers[2 * c];
    centers[2 * k + 1] = input.centers[2 * c + 1];
  });
  const pairs = selectPairs(centers, rows.length, input.diameter, input.maxFar, input.seed);
  const r = new Float64Array(pairs.a.length);
  for (let p = 0; p < r.length; p++) {
    const ia = rows[pairs.a[p]] * frames;
    const ib = rows[pairs.b[p]] * frames;
    let s = 0;
    for (let t = 0; t < frames; t++) s += traces[ia + t] * traces[ib + t];
    r[p] = s;
  }
  const { bins, farMedian } = binStats(pairs.dist, r);
  return {
    bins,
    farMedian,
    diameterPx: input.diameter,
    cells: rows.length,
    skipped: cells - rows.length,
    frames,
    pairsNear: pairs.near,
    pairsFar: pairs.far,
    pairsFarTotal: pairs.farTotal,
  };
}
