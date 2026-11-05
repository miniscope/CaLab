import { describe, it, expect } from 'vitest';
import { ceilingAt } from '@calab/core';
import {
  pveSnrPoints,
  fitFromPoints,
  ceilingBand,
  ceilingVerdict,
  BELOW_GAP,
} from '../results-ceiling.ts';
import type { TraceResultEntry } from '../iteration-store.ts';

function entry(cell: number, pve: number, pveCeiling: number | null): TraceResultEntry {
  return {
    cellIndex: cell,
    subsetIdx: -1,
    sCounts: new Float32Array(0),
    alpha: 1,
    baseline: 0,
    threshold: 0,
    pve,
    pveCeiling,
  };
}

describe('PVE vs SNR helpers', () => {
  const c = 0.1;
  const snr = Array.from({ length: 12 }, (_, i) => 3 + 2 * i);
  const results = new Map<number, TraceResultEntry>(
    snr.map((s, i) => [i, entry(i, 0.5, ceilingAt(c, s))]),
  );

  it('joins results with overview SNR and skips cells without SNR', () => {
    expect(pveSnrPoints(results, null)).toEqual([]);
    const withGap = [...snr];
    withGap[3] = NaN;
    const pts = pveSnrPoints(results, withGap);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toMatchObject({ cell: 0, snr: 3, pve: 0.5 });
  });

  it('fits c from the processed ceilings, not the observed PVE', () => {
    const fit = fitFromPoints(pveSnrPoints(results, snr))!;
    expect(fit.c).toBeCloseTo(c, 10);
  });

  it('needs enough cells with a noise floor', () => {
    const few = new Map([...results].slice(0, 3));
    expect(fitFromPoints(pveSnrPoints(few, snr))).toBeNull();
    const noCeil = new Map([...results].map(([k, r]) => [k, { ...r, pveCeiling: null }]));
    expect(fitFromPoints(pveSnrPoints(noCeil, snr))).toBeNull();
  });

  it('band brackets the curve and verdicts follow the gaps', () => {
    const fit = { c, logCSe: 0.1, n: 12 };
    const b = ceilingBand(fit, 10);
    expect(b.lo).toBeLessThan(b.mid);
    expect(b.hi).toBeGreaterThan(b.mid);
    expect(b.mid).toBeCloseTo(ceilingAt(c, 10));
    expect(ceilingVerdict(fit, 10, b.mid)).toBe('near');
    expect(ceilingVerdict(fit, 10, b.lo - BELOW_GAP - 0.01)).toBe('below');
    expect(ceilingVerdict(fit, 10, b.hi + 0.05)).toBe('above');
  });
});
