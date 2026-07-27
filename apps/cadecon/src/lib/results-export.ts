/**
 * Standalone results download for the CaDecon GUI.
 *
 * Bundles the same payload the Python bridge receives -- the activity matrix
 * plus the results JSON (see export-utils.ts) -- into a single ZIP:
 *
 *   <source>_cadecon_results.zip
 *     activity.<ext>   the activity matrix, in the imported file's format
 *     results.json     buildCaDeconResultsPayload() + self-documenting descriptions
 *
 * The array format mirrors the imported file (.npy / .npz / .mat), falling back
 * to .npy for demo- or bridge-loaded runs with no source file (which is exactly
 * what the bridge itself emits).
 */

import { writeNpy, writeNpz, writeMat, zipFiles } from '@calab/io';
import { buildCaDeconActivityMatrix, buildCaDeconResultsPayload } from './export-utils.ts';
import { rawFile } from './data-store.ts';

type ArrayFormat = 'npy' | 'npz' | 'mat';

/**
 * Human-readable explanation of every field in results.json (and the sibling
 * activity array). Definitions are sourced from the solver, not inferred:
 * the kernel fit is the two-component bi-exponential of crates/solver/biexp_fit.rs.
 */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  activity:
    'Deconvolved per-cell activity (event counts), shape [n_cells, n_timepoints], float32. ' +
    'Stored in the sibling activity.<ext> file. Rows are ordered by ascending cell index and ' +
    'their orientation matches the imported traces; row i corresponds to alphas[i]/baselines[i]/pves[i].',
  fs: 'Sampling rate of the traces, in Hz.',
  alphas:
    'Per-cell amplitude scale relating deconvolved event counts to fluorescence units (length n_cells).',
  baselines:
    'Per-cell fluorescence baseline offset subtracted before deconvolution (length n_cells).',
  pves: 'Per-cell proportion of variance explained by the fit, 0-1; a per-cell fit-quality measure (length n_cells).',
  tau_rise:
    'Rise time constant (seconds) of the slow calcium kernel component T_s(t) = exp(-t/tau_decay) - exp(-t/tau_rise).',
  tau_decay: 'Decay time constant (seconds) of the slow calcium kernel component.',
  beta:
    'Amplitude of the slow (calcium) component in the two-component kernel fit ' +
    'h(t) = beta*T_s(t) + beta_fast*T_f(t); beta <= 0 indicates a degenerate fit.',
  tau_rise_fast:
    'Rise time constant (seconds) of the fast kernel component T_f, whose independent ' +
    'time constants absorb a rising-edge noise/false-spike artifact (0 if unused).',
  tau_decay_fast: 'Decay time constant (seconds) of the fast kernel component (0 if unused).',
  beta_fast:
    'Amplitude of the fast artifact component; ~0 when the data is clean (the fit then reduces ' +
    'to a single bi-exponential).',
  residual:
    'Residual of the two-component bi-exponential fit to the free-form kernel h_free ' +
    '(lower is a better fit; very large/infinite indicates a degenerate or empty fit).',
  h_free:
    'Free-form (nonparametric) calcium kernel re-estimated from the current spike solution ' +
    'each iteration; the parametric bi-exponential (tau_*, beta) is fit to this shape.',
  num_iterations: 'Total CaDecon iterations run.',
  converged: 'Whether the run met the convergence criterion.',
  converged_at_iteration:
    'Iteration index at which convergence was reached, or null if the iteration cap was hit.',
  schema_version: 'Version of this results JSON schema.',
  export_date: 'ISO 8601 timestamp of when this file was exported.',
};

/** Determine the output array format + base filename from the imported file. */
function resolveOutput(): { format: ArrayFormat; base: string } {
  const file = rawFile();
  if (!file) return { format: 'npy', base: 'cadecon' };
  const dot = file.name.lastIndexOf('.');
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  const format: ArrayFormat = ext === 'npz' ? 'npz' : ext === 'mat' ? 'mat' : 'npy';
  return { format, base };
}

/** Serialize the activity matrix into the chosen container format. */
function serializeActivity(
  format: ArrayFormat,
  data: Float32Array,
  shape: [number, number],
): ArrayBuffer {
  switch (format) {
    case 'npz':
      return writeNpz({ activity: { data, shape } });
    case 'mat':
      return writeMat('activity', data, shape);
    case 'npy':
    default:
      return writeNpy(data, shape);
  }
}

function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Build and download the CaDecon results ZIP for the completed run.
 * Safe to call only when a run has finished (activity matrix populated).
 */
export function downloadResults(): void {
  const { format, base } = resolveOutput();
  const { data, shape } = buildCaDeconActivityMatrix();

  const activityBuffer = serializeActivity(format, data, shape);
  const results = { ...buildCaDeconResultsPayload(), field_descriptions: FIELD_DESCRIPTIONS };
  const resultsJson = new TextEncoder().encode(JSON.stringify(results, null, 2));

  const zip = zipFiles({
    [`activity.${format}`]: new Uint8Array(activityBuffer),
    'results.json': resultsJson,
  });

  triggerDownload(zip, `${base}_cadecon_results.zip`);
}
