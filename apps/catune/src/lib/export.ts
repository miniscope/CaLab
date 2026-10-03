/**
 * CaTune JSON export: payload construction and Blob download trigger.
 * Also the payload `postParamsToBridge` sends back to `calab.tune()`; the
 * Python bridge registry pins `schema_version` below
 * (python/tests/test_bridge_registry.py reads this file).
 *
 * Produces a scientifically complete JSON file containing:
 * - Parameter values (tau_rise, tau_decay, lambda, sampling_rate)
 * - AR2 coefficients derived from tau values
 * - Mathematical formulation strings for reproducibility
 * - Metadata for forward compatibility with Phase 7 (community DB)
 */

import * as v from 'valibot';
import { computeAR2 } from '@calab/core';
import { shapeToTau } from '@calab/compute';
import { CaTuneExportSchema } from './export-schema.ts';
import type { CaTuneExportData } from './export-schema.ts';

/**
 * CaTune export payload. `solver_version` (the WASM build's
 * `solver_version()`) is optional and only set by callers that have it, e.g.
 * the bridge export, where the Python side checks it against its own solver.
 */
export type CaTuneExport = CaTuneExportData & { solver_version?: string };

export function buildExportData(
  tPeak: number,
  fwhm: number,
  lambda: number,
  fs: number,
  filterEnabled: boolean,
  metadata?: {
    sourceFilename?: string;
    numCells?: number;
    numTimepoints?: number;
  },
  version: string = 'dev',
  solverVersion?: string,
): CaTuneExport {
  const tau = shapeToTau(tPeak, fwhm);
  if (!tau) {
    throw new Error(`Invalid kernel shape: tPeak=${tPeak}, fwhm=${fwhm}`);
  }
  const { tauRise, tauDecay } = tau;
  const ar2 = computeAR2(tauRise, tauDecay, fs);

  return {
    schema_version: '1.2.0',
    catune_version: version,
    export_date: new Date().toISOString(),
    parameters: {
      tau_rise_s: tauRise,
      tau_decay_s: tauDecay,
      t_peak_s: tPeak,
      fwhm_s: fwhm,
      lambda,
      sampling_rate_hz: fs,
      filter_enabled: filterEnabled,
    },
    ar2_coefficients: ar2,
    formulation: {
      model: 'FISTA with adaptive restart and non-negativity constraint',
      objective: 'min_{s>=0} (1/2)||y - K*s||_2^2 + lambda*||s||_1',
      kernel: 'h(t) = exp(-t/tau_decay) - exp(-t/tau_rise), normalized to unit peak',
      ar2_relation:
        'c[t] = g1*c[t-1] + g2*c[t-2] + s[t], where g1 = decayRoot+riseRoot, g2 = -(decayRoot*riseRoot), decayRoot = exp(-dt/tau_decay), riseRoot = exp(-dt/tau_rise)',
      lambda_definition:
        'L1 penalty weight on the activity signal s in the FISTA objective function',
      convergence: 'Relative objective change < 1e-6 or max 2000 iterations',
    },
    metadata: {
      source_filename: metadata?.sourceFilename,
      num_cells: metadata?.numCells,
      num_timepoints: metadata?.numTimepoints,
    },
    ...(solverVersion !== undefined ? { solver_version: solverVersion } : {}),
  };
}

export function downloadExport(exportData: CaTuneExport, filename?: string): void {
  const defaultFilename = `catune-params-${new Date().toISOString().slice(0, 10)}.json`;
  const fname = filename ?? defaultFilename;

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fname;

  // Append to body before click for Firefox compatibility
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  URL.revokeObjectURL(url);
}

/**
 * Validate and parse a JSON object as a CaTune export.
 * Use this when importing a previously exported JSON file to catch
 * malformed or incompatible data at the system boundary.
 */
export function parseExport(data: unknown): CaTuneExport {
  const result = v.safeParse(CaTuneExportSchema, data);
  if (!result.success) {
    const issues = result.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid CaTune export: ${issues}`);
  }
  return result.output;
}
