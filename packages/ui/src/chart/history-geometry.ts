// Pure geometry and formatting helpers for HistoryPlot / WholeRunStrip.

import type { BinValue, DisplayRange, SeriesKind } from '@calab/compute';
import { formatElapsed } from './time-axis-format.ts';

/** (v - lo) / (hi - lo); 0.5 for a degenerate range. Not clipped. */
export function normalise(v: number, range: { lo: number; hi: number }): number {
  const d = range.hi - range.lo;
  return d > 0 ? (v - range.lo) / d : 0.5;
}

/** Text of a range, e.g. "0–200 cells" or "±10 px". */
export function rangeText(lo: number, hi: number, unit = ''): string {
  const f = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(2)));
  const body = lo < 0 && lo === -hi ? `±${f(hi)}` : `${f(lo)}–${f(hi)}`;
  return unit ? `${body} ${unit}` : body;
}

export interface ExpansionMark {
  /** Normalised position of the OLD limit against the CURRENT range (0..1). */
  u: number;
  /** The old limit value. */
  v: number;
  /** Stream time of the step, s. */
  t: number;
  /** "range expanded from ±10 at d2 03:10". */
  label: string;
}

/**
 * Markers for the range steps of one series: an amber dashed line at each old
 * limit (the upper one always; the lower one too when the range stepped down).
 */
export function expansionMarks(range: DisplayRange, unit = '', spanS?: number): ExpansionMark[] {
  const out: ExpansionMark[] = [];
  for (const e of range.expansions) {
    const label = `range expanded from ${rangeText(e.from[0], e.from[1], unit)} at ${formatElapsed(e.t, spanS)}`;
    out.push({ u: normalise(e.from[1], range), v: e.from[1], t: e.t, label });
    if (e.from[0] !== e.to[0]) {
      out.push({ u: normalise(e.from[0], range), v: e.from[0], t: e.t, label });
    }
  }
  return out;
}

/** Compact tick text for y-axis labels. */
export function formatTick(v: number): string {
  if (Number.isInteger(v) || Math.abs(v) >= 100) return v.toFixed(0);
  return v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

/** The number a bin shows in a chip or tooltip, by series kind. */
export function binDisplayValue(kind: SeriesKind, b: BinValue): number {
  switch (kind) {
    case 'band':
    case 'step':
      return b.last;
    case 'stem':
      return b.max;
    default:
      return b.mean;
  }
}

export function formatValue(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}
