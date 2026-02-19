// Reactive spectrum store: computes periodogram from selected cell trace.
// Cutoffs update immediately on parameter change; expensive FFT only
// recomputes when the underlying raw trace or selected cell changes.

import { createSignal, createEffect, on } from 'solid-js';
import { multiCellResults } from '../multi-cell-store.ts';
import { samplingRate } from '../data-store.ts';
import { tauRise, tauDecay, selectedCell } from '../viz-store.ts';
import { computePeriodogram } from './fft.ts';

// Margin factors kept in sync with filter.rs
const MARGIN_FACTOR_HP = 16.0;
const MARGIN_FACTOR_LP = 4.0;

function computeFilterCutoffs(
  tauRise: number,
  tauDecay: number,
): { highPass: number; lowPass: number } {
  return {
    highPass: 1 / (2 * Math.PI * tauDecay * MARGIN_FACTOR_HP),
    lowPass: MARGIN_FACTOR_LP / (2 * Math.PI * tauRise),
  };
}

export interface SpectrumData {
  freqs: Float64Array;
  psd: Float64Array;
  allPsd: Float64Array;
  highPassHz: number;
  lowPassHz: number;
  cellIndex: number;
}

const [spectrumData, setSpectrumData] = createSignal<SpectrumData | null>(null);

// Cache to avoid redundant FFT when solver updates don't change the raw trace
let lastRaw: Float64Array | null = null;
let lastCellIdx = -1;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function initSpectrumStore(): void {
  // Effect 1: Cutoff lines — update immediately, no debounce
  createEffect(
    on([tauRise, tauDecay, samplingRate], () => {
      const current = spectrumData();
      if (!current) return;
      const { highPass, lowPass } = computeFilterCutoffs(tauRise(), tauDecay());
      const fs = samplingRate() ?? 30;
      setSpectrumData({
        ...current,
        highPassHz: highPass,
        lowPassHz: Math.min(lowPass, fs / 2),
      });
    }),
  );

  // Effect 2: FFT recomputation — debounced, skips if raw trace unchanged.
  // multiCellResults is a store proxy, so we read the selected cell's entry
  // to establish a reactive dependency on the specific cell trace.
  createEffect(
    on([() => multiCellResults[selectedCell()], samplingRate, selectedCell], () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(computeSpectrum, 250);
    }),
  );
}

function computeSpectrum(): void {
  const results = multiCellResults;
  const fs = samplingRate();
  const cellIdx = selectedCell();
  const resultKeys = Object.keys(results);

  if (!fs || resultKeys.length === 0) {
    lastRaw = null;
    lastCellIdx = -1;
    setSpectrumData(null);
    return;
  }

  // Resolve raw trace for the target cell
  const cellTraces = results[cellIdx];
  const target = cellTraces ?? results[Number(resultKeys[0])];
  if (!target) {
    setSpectrumData(null);
    return;
  }

  const raw = target.raw;
  const resolvedIdx = target.cellIndex;

  // Skip FFT if raw trace reference and cell haven't changed
  if (raw === lastRaw && resolvedIdx === lastCellIdx) return;
  lastRaw = raw;
  lastCellIdx = resolvedIdx;

  if (raw.length < 16) {
    setSpectrumData(null);
    return;
  }

  const { freqs, psd } = computePeriodogram(raw, fs);

  // Average PSD across all loaded cells
  const allTraces = resultKeys
    .map((k) => results[Number(k)]?.raw)
    .filter((t): t is Float64Array => t != null && t.length >= 16);
  let allPsd: Float64Array;
  if (allTraces.length <= 1) {
    allPsd = psd;
  } else {
    const first = computePeriodogram(allTraces[0], fs);
    const avgPsd = new Float64Array(first.psd.length);
    for (let i = 0; i < avgPsd.length; i++) avgPsd[i] = first.psd[i];
    for (let t = 1; t < allTraces.length; t++) {
      const { psd: cellPsd } = computePeriodogram(allTraces[t], fs);
      for (let i = 0; i < avgPsd.length; i++) avgPsd[i] += cellPsd[i];
    }
    for (let i = 0; i < avgPsd.length; i++) avgPsd[i] /= allTraces.length;
    allPsd = avgPsd;
  }

  const { highPass, lowPass } = computeFilterCutoffs(tauRise(), tauDecay());

  setSpectrumData({
    freqs,
    psd,
    allPsd,
    highPassHz: highPass,
    lowPassHz: Math.min(lowPass, fs / 2),
    cellIndex: resolvedIdx,
  });
}

export { spectrumData };
