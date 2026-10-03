/**
 * Collects CaDecon iteration results for export to the Python bridge.
 */

import { cellResultLookup, convergenceHistory, convergedAtIteration } from './iteration-store.ts';
import { samplingRate, numTimepoints } from './data-store.ts';

/** Sorted cell indices for deterministic row order across both export functions. */
function sortedCellIndices(): number[] {
  return [...cellResultLookup().keys()].sort((a, b) => a - b);
}

/**
 * Build a contiguous Float32Array activity matrix from per-cell sCounts.
 * Returns the flat array and its [n_cells, n_timepoints] shape.
 */
export function buildCaDeconActivityMatrix(): {
  data: Float32Array;
  shape: [number, number];
} {
  const lookup = cellResultLookup();
  const nTime = numTimepoints() ?? 0;

  const sortedCells = sortedCellIndices();
  const data = new Float32Array(sortedCells.length * nTime);

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
export function buildCaDeconResultsPayload(solverVersion?: string): Record<string, unknown> {
  const lookup = cellResultLookup();
  const history = convergenceHistory();
  const fs = samplingRate() ?? 30;

  const sortedCells = sortedCellIndices();
  const alphas: number[] = [];
  const baselines: number[] = [];
  const pves: number[] = [];

  for (const cellIdx of sortedCells) {
    const entry = lookup.get(cellIdx)!;
    alphas.push(entry.alpha);
    baselines.push(entry.baseline);
    pves.push(entry.pve);
  }

  // Kernel params from the last convergence snapshot.
  //
  // `null` when there is nothing to report, never a stand-in number. A run
  // stopped before its first iteration completed has no fit: either no
  // snapshot at all (stopped during the seed phase, which returns before
  // iteration 0 is recorded) or only the iteration-0 snapshot, which holds the
  // seed kernel and a null residual.
  //
  // The previous fallbacks made that case indistinguishable from a good
  // result. `residual ?? 0` was the worst of them, because `field_descriptions`
  // in this same export tells the reader that lower is a better fit and that a
  // failed fit shows up as very large or infinite — so a run that fit nothing
  // reported the best possible value, inverting the rule the file documents.
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const tauRise = latest?.tauRise ?? null;
  const tauDecay = latest?.tauDecay ?? null;
  const beta = latest?.beta ?? null;
  const tauRiseFast = latest?.tauRiseFast ?? null;
  const tauDecayFast = latest?.tauDecayFast ?? null;
  const betaFast = latest?.betaFast ?? null;
  const residual = latest ? latest.residual : null;

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
    schema_version: 2,
    export_date: new Date().toISOString(),
    // Optional: WASM solver_version(), checked by the Python bridge handshake.
    ...(solverVersion !== undefined ? { solver_version: solverVersion } : {}),
  };
}
