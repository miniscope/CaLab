// Reactive spectrum store: computes periodogram from selected cell trace.
// Watches cell results and kernel parameters, debounces to avoid churn.

import { createSignal, createEffect, on } from 'solid-js';
import { multiCellResults } from '../multi-cell-store';
import { samplingRate } from '../data-store';
import { tauRise, tauDecay, selectedCell } from '../viz-store';
import { computePeriodogram } from './fft';
import { computeFilterCutoffs } from './filter-cutoffs';

export interface SpectrumData {
  freqs: Float64Array;
  psd: Float64Array;
  highPassHz: number;
  lowPassHz: number;
  cellIndex: number;
}

const [spectrumData, setSpectrumData] = createSignal<SpectrumData | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function initSpectrumStore(): void {
  createEffect(
    on([multiCellResults, samplingRate, tauRise, tauDecay, selectedCell], () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(computeSpectrum, 250);
    }),
  );
}

function computeSpectrum(): void {
  const results = multiCellResults();
  const fs = samplingRate();
  const cellIdx = selectedCell();
  const tr = tauRise();
  const td = tauDecay();

  if (!fs || results.size === 0) {
    setSpectrumData(null);
    return;
  }

  // Use the selected cell's raw trace
  const cellTraces = results.get(cellIdx);
  if (!cellTraces) {
    // Fall back to first available cell
    const first = results.values().next().value;
    if (!first) { setSpectrumData(null); return; }
    computeFromTrace(first.raw, first.cellIndex, fs, tr, td);
    return;
  }

  computeFromTrace(cellTraces.raw, cellIdx, fs, tr, td);
}

function computeFromTrace(
  raw: Float64Array,
  cellIndex: number,
  fs: number,
  tr: number,
  td: number,
): void {
  if (raw.length < 16) { setSpectrumData(null); return; }

  const { freqs, psd } = computePeriodogram(raw, fs);
  const { highPass, lowPass } = computeFilterCutoffs(tr, td);

  setSpectrumData({
    freqs,
    psd,
    highPassHz: highPass,
    lowPassHz: Math.min(lowPass, fs / 2),
    cellIndex,
  });
}

export { spectrumData };
