import { createSignal, createMemo } from 'solid-js';
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

const [numSubsets, setNumSubsets] = createSignal(4);
const [subsetTimeFrames, setSubsetTimeFrames] = createSignal<number | null>(null);
const [subsetCellCount, setSubsetCellCount] = createSignal<number | null>(null);
const [overlapAllowed, setOverlapAllowed] = createSignal(true);
const [circularShiftEnabled, setCircularShiftEnabled] = createSignal(false);
const [autoMode, setAutoMode] = createSignal(true);
const [seed, setSeed] = createSignal(42);

// --- UI Signal ---

const [selectedSubsetIdx, setSelectedSubsetIdx] = createSignal<number | null>(null);

// --- Derived ---

const effectiveTSub = createMemo(() => {
  if (!autoMode()) return subsetTimeFrames() ?? 100;
  const T = numTimepoints();
  if (T === 0) return 100;
  return Math.max(100, Math.round(T * 0.25));
});

const effectiveNSub = createMemo(() => {
  if (!autoMode()) return subsetCellCount() ?? 10;
  const N = numCells();
  if (N === 0) return 10;
  return Math.max(10, Math.round(N * 0.5));
});

// Seeded LCG for deterministic pseudo-random placement
function lcg(s: number): () => number {
  let state = s;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 0) / 0x100000000;
  };
}

const subsetRectangles = createMemo<SubsetRectangle[]>(() => {
  const K = numSubsets();
  const T = numTimepoints();
  const N = numCells();
  if (T === 0 || N === 0 || K === 0) return [];

  const tSub = Math.min(effectiveTSub(), T);
  const nSub = Math.min(effectiveNSub(), N);

  const rng = lcg(seed());
  const rects: SubsetRectangle[] = [];

  for (let k = 0; k < K; k++) {
    let tStart: number;
    let cellStart: number;
    let attempts = 0;
    const maxAttempts = overlapAllowed() ? 1 : 100;

    do {
      tStart = Math.floor(rng() * (T - tSub + 1));
      cellStart = Math.floor(rng() * (N - nSub + 1));
      attempts++;

      if (overlapAllowed()) break;

      // Check overlap with existing rects
      const overlaps = rects.some(
        (r) =>
          tStart < r.tEnd &&
          tStart + tSub > r.tStart &&
          cellStart < r.cellEnd &&
          cellStart + nSub > r.cellStart,
      );
      if (!overlaps) break;
    } while (attempts < maxAttempts);

    rects.push({
      tStart,
      tEnd: tStart + tSub,
      cellStart,
      cellEnd: cellStart + nSub,
      idx: k,
    });
  }

  return rects;
});

const coverageStats = createMemo(() => {
  const T = numTimepoints();
  const N = numCells();
  const rects = subsetRectangles();
  if (T === 0 || N === 0 || rects.length === 0) return { cellPct: 0, timePct: 0 };

  const cellsCovered = new Set<number>();
  let totalTimeCovered = 0;

  for (const r of rects) {
    for (let c = r.cellStart; c < r.cellEnd; c++) cellsCovered.add(c);
    totalTimeCovered += r.tEnd - r.tStart;
  }

  return {
    cellPct: (cellsCovered.size / N) * 100,
    // Clamp to 100% since overlapping rects can double-count
    timePct: Math.min(100, (totalTimeCovered / T) * 100),
  };
});

export {
  numSubsets,
  setNumSubsets,
  subsetTimeFrames,
  setSubsetTimeFrames,
  subsetCellCount,
  setSubsetCellCount,
  overlapAllowed,
  setOverlapAllowed,
  circularShiftEnabled,
  setCircularShiftEnabled,
  autoMode,
  setAutoMode,
  seed,
  setSeed,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
  effectiveTSub,
  effectiveNSub,
  subsetRectangles,
  coverageStats,
};
