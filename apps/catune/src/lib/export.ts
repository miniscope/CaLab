/**
 * JSON export schema construction and Blob download trigger.
 *
 * Produces a scientifically complete JSON file containing:
 * - Parameter values (tau_rise, tau_decay, lambda, sampling_rate)
 * - AR2 coefficients derived from tau values
 * - Mathematical formulation strings for reproducibility
 * - Metadata for forward compatibility with Phase 7 (community DB)
 */

import * as v from 'valibot';
import { computeAR2 } from './ar2.ts';
import type { AR2Coefficients } from './ar2.ts';
import { CaTuneExportSchema } from '@catune/core';

export interface CaTuneExport {
  schema_version: string;
  catune_version: string;
  export_date: string;
  parameters: {
    tau_rise_s: number;
    tau_decay_s: number;
    lambda: number;
    sampling_rate_hz: number;
    filter_enabled: boolean;
  };
  ar2_coefficients: AR2Coefficients;
  formulation: {
    model: string;
    objective: string;
    kernel: string;
    ar2_relation: string;
    lambda_definition: string;
    convergence: string;
  };
  metadata: {
    source_filename?: string;
    num_cells?: number;
    num_timepoints?: number;
  };
}

export function buildExportData(
  tauRise: number,
  tauDecay: number,
  lambda: number,
  fs: number,
  filterEnabled: boolean,
  metadata?: {
    sourceFilename?: string;
    numCells?: number;
    numTimepoints?: number;
  },
): CaTuneExport {
  const ar2 = computeAR2(tauRise, tauDecay, fs);

  return {
    schema_version: '1.1.0',
    catune_version: import.meta.env.VITE_APP_VERSION || 'dev',
    export_date: new Date().toISOString(),
    parameters: {
      tau_rise_s: tauRise,
      tau_decay_s: tauDecay,
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
      lambda_definition: 'L1 penalty weight on spike train s in the FISTA objective function',
      convergence: 'Relative objective change < 1e-6 or max 2000 iterations',
    },
    metadata: {
      source_filename: metadata?.sourceFilename,
      num_cells: metadata?.numCells,
      num_timepoints: metadata?.numTimepoints,
    },
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

  // Prevent memory leak
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
  return result.output as CaTuneExport;
}
