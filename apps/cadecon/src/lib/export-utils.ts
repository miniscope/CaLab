/**
 * Collects CaDecon iteration results for export to the Python bridge.
 */

import { cellResultLookup, convergenceHistory, convergedAtIteration } from './iteration-store.ts';
import { samplingRate, numCells, numTimepoints } from './data-store.ts';

/**
 * Build a contiguous Float32Array activity matrix from per-cell sCounts.
 * Returns the flat array and its [n_cells, n_timepoints] shape.
 */
export function buildCaDeconActivityMatrix(): {
  data: Float32Array;
  shape: [number, number];
} {
  const lookup = cellResultLookup();
  const nCells = numCells() ?? 0;
  const nTime = numTimepoints() ?? 0;

  const data = new Float32Array(nCells * nTime);

  // Sorted cell indices for deterministic row order
  const sortedCells = [...lookup.keys()].sort((a, b) => a - b);
  for (let row = 0; row < sortedCells.length; row++) {
    const entry = lookup.get(sortedCells[row])!;
    const offset = row * nTime;
    const len = Math.min(entry.sCounts.length, nTime);
    data.set(entry.sCounts.subarray(0, len), offset);
  }

  return { data, shape: [sortedCells.length, nTime] };
}

/**
 * Build the JSON results payload with per-cell scalars, kernel params, and metadata.
 */
export function buildCaDeconResultsPayload(): Record<string, unknown> {
  const lookup = cellResultLookup();
  const history = convergenceHistory();
  const fs = samplingRate() ?? 30;

  const sortedCells = [...lookup.keys()].sort((a, b) => a - b);
  const alphas: number[] = [];
  const baselines: number[] = [];
  const pves: number[] = [];

  for (const cellIdx of sortedCells) {
    const entry = lookup.get(cellIdx)!;
    alphas.push(entry.alpha);
    baselines.push(entry.baseline);
    pves.push(entry.pve);
  }

  // Kernel params from last convergence snapshot
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const tauRise = latest?.tauRise ?? 0;
  const tauDecay = latest?.tauDecay ?? 0;
  const beta = latest?.beta ?? 1;
  const tauRiseFast = latest?.tauRiseFast ?? 0;
  const tauDecayFast = latest?.tauDecayFast ?? 0;
  const betaFast = latest?.betaFast ?? 0;
  const residual = latest?.residual ?? 0;

  // h_free from first subset (data-driven kernel shape)
  const hFree = latest && latest.subsets.length > 0 ? Array.from(latest.subsets[0].hFree) : [];

  const convergedAt = convergedAtIteration();

  return {
    alphas,
    baselines,
    pves,
    fs,
    tau_rise: tauRise,
    tau_decay: tauDecay,
    beta,
    tau_rise_fast: tauRiseFast,
    tau_decay_fast: tauDecayFast,
    beta_fast: betaFast,
    residual,
    h_free: hFree,
    num_iterations: history.length,
    converged: convergedAt !== null,
    converged_at_iteration: convergedAt,
    schema_version: 1,
    export_date: new Date().toISOString(),
  };
}
