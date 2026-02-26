import { createSignal, createMemo } from 'solid-js';
import { resolveWorkerCount } from '@calab/compute';
import { numCells, numTimepoints } from './data-store.ts';

// --- Types ---

export interface SubsetRectangle {
  tStart: number;
  tEnd: number;
  cellStart: number;
  cellEnd: number;
  idx: number;
}

// --- Config Signals ---

const [numSubsets, setNumSubsets] = createSignal(resolveWorkerCount());
const [targetCoverage, setTargetCoverage] = createSignal(0.5);
const [aspectRatio, setAspectRatio] = createSignal(1.0);
const [seed, setSeed] = createSignal(42);

// --- UI Signal ---

const [selectedSubsetIdx, setSelectedSubsetIdx] = createSignal<number | null>(null);

// --- Derived ---

// Sizing from coverage + aspect ratio:
//   base scale = sqrt(coverage / K)
//   tSub = T * scale * sqrt(aspectRatio)
//   nSub = N * scale / sqrt(aspectRatio)
// aspectRatio = 1 preserves dataset proportions; >1 = wider (more time); <1 = taller (more cells)

const effectiveTSub = createMemo(() => {
  const T = numTimepoints();
  if (T === 0) return 100;
  const K = numSubsets();
  const scale = Math.sqrt(targetCoverage() / K);
  return Math.max(100, Math.min(T, Math.floor(T * scale * Math.sqrt(aspectRatio()))));
});

const effectiveNSub = createMemo(() => {
  const N = numCells();
  if (N === 0) return 10;
  const K = numSubsets();
  const scale = Math.sqrt(targetCoverage() / K);
  return Math.max(10, Math.min(N, Math.floor((N * scale) / Math.sqrt(aspectRatio()))));
});

// Seeded LCG for deterministic pseudo-random placement
function lcg(s: number): () => number {
  let state = s;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * Place K non-overlapping subset rectangles using a grid tiling strategy
 * with seeded random jitter within each tile.
 *
 * Strategy: compute how many tiles fit along each axis (time x cells),
 * assign subsets to tiles in raster order, then jitter each rectangle
 * within its tile so placement varies with the seed.
 */
function tileSubsets(
  K: number,
  T: number,
  N: number,
  tSub: number,
  nSub: number,
  rng: () => number,
): SubsetRectangle[] {
  // Figure out grid dimensions that fit K tiles
  // Prefer more columns (time axis) than rows (cell axis) since T >> N typically
  const maxCols = Math.max(1, Math.floor(T / tSub));
  const maxRows = Math.max(1, Math.floor(N / nSub));
  const maxTiles = maxCols * maxRows;

  if (K <= maxTiles) {
    // We can fit all K subsets without overlap using the grid
    let cols = Math.min(K, maxCols);
    let rows = Math.ceil(K / cols);
    // If rows exceed capacity, widen
    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.ceil(K / rows);
    }

    const baseTileW = Math.floor(T / cols);
    const baseTileH = Math.floor(N / rows);
    const rects: SubsetRectangle[] = [];

    for (let k = 0; k < K; k++) {
      const col = k % cols;
      const row = Math.floor(k / cols);

      // Last column/row extends to data edge to eliminate fringe gap
      const tileW = col === cols - 1 ? T - col * baseTileW : baseTileW;
      const tileH = row === rows - 1 ? N - row * baseTileH : baseTileH;

      // Jitter within the tile (ensure the subset fits within the tile)
      const tSlack = Math.max(0, tileW - tSub);
      const nSlack = Math.max(0, tileH - nSub);
      const tStart = col * baseTileW + Math.floor(rng() * (tSlack + 1));
      const cellStart = row * baseTileH + Math.floor(rng() * (nSlack + 1));

      rects.push({
        tStart,
        tEnd: tStart + tSub,
        cellStart,
        cellEnd: cellStart + nSub,
        idx: k,
      });
    }
    return rects;
  }

  // More subsets than tiles: pack as many as possible, extras get random placement
  const rects: SubsetRectangle[] = [];
  for (let k = 0; k < Math.min(K, maxTiles); k++) {
    const col = k % maxCols;
    const row = Math.floor(k / maxCols);
    const baseTileW = Math.floor(T / maxCols);
    const baseTileH = Math.floor(N / maxRows);
    const tileW = col === maxCols - 1 ? T - col * baseTileW : baseTileW;
    const tileH = row === maxRows - 1 ? N - row * baseTileH : baseTileH;
    const tSlack = Math.max(0, tileW - tSub);
    const nSlack = Math.max(0, tileH - nSub);
    const tStart = col * baseTileW + Math.floor(rng() * (tSlack + 1));
    const cellStart = row * baseTileH + Math.floor(rng() * (nSlack + 1));

    rects.push({ tStart, tEnd: tStart + tSub, cellStart, cellEnd: cellStart + nSub, idx: k });
  }

  // Remaining subsets: random placement (may overlap)
  for (let k = maxTiles; k < K; k++) {
    const tStart = Math.floor(rng() * (T - tSub + 1));
    const cellStart = Math.floor(rng() * (N - nSub + 1));
    rects.push({ tStart, tEnd: tStart + tSub, cellStart, cellEnd: cellStart + nSub, idx: k });
  }

  return rects;
}

const subsetRectangles = createMemo<SubsetRectangle[]>(() => {
  const K = numSubsets();
  const T = numTimepoints();
  const N = numCells();
  if (T === 0 || N === 0 || K === 0) return [];

  const tSub = Math.min(effectiveTSub(), T);
  const nSub = Math.min(effectiveNSub(), N);

  const rng = lcg(seed());
  return tileSubsets(K, T, N, tSub, nSub, rng);
});

const coverageStats = createMemo(() => {
  const T = numTimepoints();
  const N = numCells();
  const K = numSubsets();
  const tSub = Math.min(effectiveTSub(), T);
  const nSub = Math.min(effectiveNSub(), N);
  if (T === 0 || N === 0) return { cellPct: 0, timePct: 0, totalPct: 0 };

  const cellPct = Math.min(100, (nSub / N) * 100);
  const timePct = Math.min(100, (tSub / T) * 100);
  // Aggregate: union of non-overlapping tiles as fraction of full matrix
  const totalPct = Math.min(100, ((K * tSub * nSub) / (T * N)) * 100);
  return { cellPct, timePct, totalPct };
});

const maxNonOverlappingK = createMemo(() => {
  const T = numTimepoints();
  const N = numCells();
  const tSub = Math.min(effectiveTSub(), T);
  const nSub = Math.min(effectiveNSub(), N);
  if (T === 0 || N === 0) return 0;
  return Math.floor(T / tSub) * Math.floor(N / nSub);
});

export {
  numSubsets,
  setNumSubsets,
  targetCoverage,
  setTargetCoverage,
  aspectRatio,
  setAspectRatio,
  seed,
  setSeed,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
  effectiveTSub,
  effectiveNSub,
  subsetRectangles,
  coverageStats,
  maxNonOverlappingK,
};
