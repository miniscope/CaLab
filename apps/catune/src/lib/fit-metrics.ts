// Per-cell solver fit metrics for the Dataset table.
//
// The solver fits its WORKING trace (rolling-percentile baseline subtracted,
// optionally bandpass-filtered) over the visible window. Fit quality must be
// scored against that working trace over the same window. Scoring the full raw
// trace against the windowed reconvolution compares different quantities (and,
// before this was fixed, silently reported 0 whenever the lengths differed).

import { computeFitMetrics, computeSparsityRatio, type FitMetricsResult } from '@calab/core';
import type { CellTraces } from './multi-cell-store.ts';

export interface CellFitMetrics {
  cellIndex: number;
  sparsity: number;
  fit: FitMetricsResult;
}

export function computeCellFitMetrics(
  cellIndex: number,
  traces: Pick<CellTraces, 'filteredTrace' | 'deconvolved' | 'reconvolution'>,
): CellFitMetrics {
  return {
    cellIndex,
    sparsity: computeSparsityRatio(traces.deconvolved),
    fit: computeFitMetrics(traces.filteredTrace, traces.reconvolution),
  };
}

/** Why a fit metric is missing, for a tooltip. */
export function fitUnavailableReason(fit: FitMetricsResult): string {
  if (fit.ok) return '';
  return fit.reason === 'no-reference'
    ? 'No solver working trace for this cell yet'
    : `Fit (${fit.fitLength} samples) and working trace (${fit.referenceLength} samples) differ in length`;
}
