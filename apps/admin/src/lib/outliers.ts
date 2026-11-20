// IQR outlier flags for community submissions.

import type { CadeconSubmissionRow, SubmissionRow } from './types.ts';
import { quantile } from './stats.ts';

/** Flag CaDecon submission IDs as outliers using the IQR method (1.5x IQR from Q1/Q3). */
export function computeCadeconOutliers(submissions: CadeconSubmissionRow[]): Set<string> {
  if (submissions.length < 4) return new Set();

  const outlierIds = new Set<string>();
  const fields = ['tau_rise', 'tau_decay', 'sampling_rate'] as const;

  for (const field of fields) {
    const values = submissions.map((s) => s[field]).filter((v): v is number => v != null);
    if (values.length < 4) continue;

    values.sort((a, b) => a - b);
    const q1 = quantile(values, 0.25)!;
    const q3 = quantile(values, 0.75)!;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    for (const s of submissions) {
      const v = s[field];
      if (v != null && (v < lower || v > upper)) {
        outlierIds.add(s.id);
      }
    }
  }

  return outlierIds;
}

/** Flag submission IDs as outliers using the IQR method (1.5x IQR from Q1/Q3). */
export function computeOutliers(submissions: SubmissionRow[]): Set<string> {
  if (submissions.length < 4) return new Set();

  const outlierIds = new Set<string>();
  const fields = ['tau_rise', 'tau_decay', 'lambda', 'sampling_rate'] as const;

  for (const field of fields) {
    const values = submissions.map((s) => s[field]).filter((v): v is number => v != null);
    if (values.length < 4) continue;

    values.sort((a, b) => a - b);
    const q1 = quantile(values, 0.25)!;
    const q3 = quantile(values, 0.75)!;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    for (const s of submissions) {
      const v = s[field];
      if (v != null && (v < lower || v > upper)) {
        outlierIds.add(s.id);
      }
    }
  }

  return outlierIds;
}
