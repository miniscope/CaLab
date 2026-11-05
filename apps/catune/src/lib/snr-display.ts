// Presentation helpers for the shared measured SNR in CaTune.
//
// There are no absolute good/fair/poor tiers: measured SNR compares cells that
// share a burst-size distribution, so a cell is coloured by its quantile within
// the dataset. The only absolute statement is "indistinguishable from noise"
// (pure noise measures about 2.7).

import { isNearNoiseFloor, OVERVIEW_PARAMS } from '@calab/core';

/** English ordinal ("1st", "62nd", "93rd"). */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Percentile label of a [0, 1] rank, clamped to 1..99 so it never reads "0th" or "100th". */
export function percentileLabel(rank: number): string {
  if (!Number.isFinite(rank)) return '';
  return `${ordinal(Math.min(99, Math.max(1, Math.round(rank * 100))))} percentile`;
}

export interface SnrDescription {
  snr: number;
  rank?: number;
  silent?: boolean;
  nCells?: number;
}

/** Tooltip text for a cell's SNR badge or table row. */
export function describeSnr(d: SnrDescription): string {
  const parts = [`Measured SNR ${d.snr.toFixed(1)}`];
  if (d.rank != null && Number.isFinite(d.rank)) {
    parts[0] += `, ${percentileLabel(d.rank)}${d.nCells ? ` of ${d.nCells} cells` : ''}`;
  }
  parts[0] +=
    ': mean of the top 1 % of samples above the median, over the noise σ. ' +
    'It compares cells within this dataset (shared burst-size assumption); the colour is the quantile, not a grade.';
  if (isNearNoiseFloor(d.snr)) {
    parts.push(
      `≈ noise: pure noise measures about ${OVERVIEW_PARAMS.noiseFloorSnr}, so this cell is close to indistinguishable from noise.`,
    );
  }
  if (d.silent) parts.push('Silent: no event clears the noise-derived floor.');
  return parts.join(' ');
}

/** Short tag shown beside the SNR label: "silent" beats "≈ noise"; empty when neither applies. */
export function snrTag(d: Pick<SnrDescription, 'snr' | 'silent'>): '' | 'silent' | '≈ noise' {
  if (d.silent) return 'silent';
  return isNearNoiseFloor(d.snr) ? '≈ noise' : '';
}
