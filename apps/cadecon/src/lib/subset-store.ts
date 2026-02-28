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
const [targetCoverage, setTargetCoverage] = createSignal(0.25);
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
  return Math.max(1, Math.min(T, Math.floor(T * scale * Math.sqrt(aspectRatio()))));
});

const effectiveNSub = createMemo(() => {
  const N = numCells();
  if (N === 0) return 10;
  const K = numSubsets();
  const scale = Math.sqrt(targetCoverage() / K);
  return Math.max(1, Math.min(N, Math.floor((N * scale) / Math.sqrt(aspectRatio()))));
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
 * Place K non-overlapping subset rectangles that evenly sample the full data.
 *
 * Strategy: build a grid of all possible non-overlapping slots, shuffle them
 * with a seeded RNG, then pick the first K. Each subset is jittered within
 * its slot for seed-dependent variation. This guarantees even spatial coverage
 * regardless of K relative to the grid size.
 */
function tileSubsets(
  K: number,
  T: number,
  N: number,
  tSub: number,
  nSub: number,
  rng: () => number,
): SubsetRectangle[] {
  const cols = Math.max(1, Math.floor(T / tSub));
  const rows = Math.max(1, Math.floor(N / nSub));
  const totalSlots = cols * rows;

  // Build list of all grid slots and shuffle (Fisher-Yates)
  const slots = Array.from({ length: totalSlots }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  const tileW = Math.floor(T / cols);
  const tileH = Math.floor(N / rows);
  const rects: SubsetRectangle[] = [];

  for (let k = 0; k < Math.min(K, totalSlots); k++) {
    const col = slots[k] % cols;
    const row = Math.floor(slots[k] / cols);

    // Last col/row extends to data edge to eliminate fringe gap
    const effW = col === cols - 1 ? T - col * tileW : tileW;
    const effH = row === rows - 1 ? N - row * tileH : tileH;

    // Jitter within the slot
    const tSlack = Math.max(0, effW - tSub);
    const nSlack = Math.max(0, effH - nSub);
    const tStart = col * tileW + Math.floor(rng() * (tSlack + 1));
    const cellStart = row * tileH + Math.floor(rng() * (nSlack + 1));

    rects.push({
      tStart,
      tEnd: tStart + tSub,
      cellStart,
      cellEnd: cellStart + nSub,
      idx: k,
    });
  }

  // Overflow: more subsets than grid slots — random placement for extras
  for (let k = totalSlots; k < K; k++) {
    const tStart = Math.floor(rng() * Math.max(1, T - tSub + 1));
    const cellStart = Math.floor(rng() * Math.max(1, N - nSub + 1));
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
