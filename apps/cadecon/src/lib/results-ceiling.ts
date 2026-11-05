// PVE-vs-SNR helpers for the Results tab. The ceiling constant c is fitted to
// each cell's PROCESSED-space ceiling (solver noise budget), never to the
// observed PVE; the x axis is the model-free overview SNR (display only).

import { ceilingAt, fitCeilingC, type CeilingFit } from '@calab/core';
import type { TraceResultEntry } from './iteration-store.ts';

export interface PveSnrPoint {
  cell: number;
  snr: number;
  pve: number;
  ceiling: number | null;
  noisePath?: boolean;
}

/** Join solver results with overview SNR (cells without either are skipped). */
export function pveSnrPoints(
  results: ReadonlyMap<number, TraceResultEntry>,
  snr: readonly number[] | null,
): PveSnrPoint[] {
  if (!snr) return [];
  const out: PveSnrPoint[] = [];
  for (const [cell, r] of results) {
    const s = snr[cell];
    if (!Number.isFinite(s) || !Number.isFinite(r.pve)) continue;
    out.push({ cell, snr: s, pve: r.pve, ceiling: r.pveCeiling ?? null, noisePath: r.noisePath });
  }
  return out.sort((a, b) => a.cell - b.cell);
}

/** Dataset-level ceiling fit from the points' processed ceilings. */
export function fitFromPoints(points: readonly PveSnrPoint[]): CeilingFit | null {
  return fitCeilingC(
    points
      .filter((p) => p.ceiling != null)
      .map((p) => ({ snr: p.snr, ceiling: p.ceiling as number })),
  );
}

/** Ceiling band at one SNR: c scaled by exp(±SE of log c). */
export function ceilingBand(fit: CeilingFit, snr: number): { lo: number; mid: number; hi: number } {
  return {
    lo: ceilingAt(fit.c * Math.exp(-fit.logCSe), snr),
    mid: ceilingAt(fit.c, snr),
    hi: ceilingAt(fit.c * Math.exp(fit.logCSe), snr),
  };
}

/** How far below the curve counts as "well below" (PVE fraction). */
export const BELOW_GAP = 0.15;
/** Tolerance above the band before "above the ceiling" is called. */
export const ABOVE_GAP = 0.02;

export type CeilingVerdict = 'near' | 'below' | 'above';

export function ceilingVerdict(fit: CeilingFit, snr: number, pve: number): CeilingVerdict {
  const b = ceilingBand(fit, snr);
  if (pve > b.hi + ABOVE_GAP) return 'above';
  if (pve < b.lo - BELOW_GAP) return 'below';
  return 'near';
}

export const VERDICT_TEXT: Record<CeilingVerdict, string> = {
  near: 'near the ceiling',
  below: 'well below the ceiling: fallback or misfit?',
  above: 'above the ceiling: fitting noise?',
};

/** Short per-cell readout of the noise-floor guard; null when the solver did not report it. */
export function noiseGuardText(noisePath: boolean | undefined): string | null {
  if (noisePath === undefined) return null;
  return noisePath ? 'noise guard: active' : 'noise guard: no effect';
}

/** Cells where the guard fired / cells that report the flag. */
export function noiseGuardCounts(points: readonly PveSnrPoint[]): {
  active: number;
  total: number;
} {
  let active = 0;
  let total = 0;
  for (const p of points) {
    if (p.noisePath === undefined) continue;
    total++;
    if (p.noisePath) active++;
  }
  return { active, total };
}
