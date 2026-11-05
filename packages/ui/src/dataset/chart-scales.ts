// Pure scale/binning helpers for the SVG overview cards (no DOM).

import { niceTicks } from '../chart/chart-math.ts';

export interface Scale {
  (v: number): number;
  invert(px: number): number;
  domain: [number, number];
  log: boolean;
}

/** Linear or log10 scale from `domain` to the pixel range [r0, r1]. */
export function makeScale(domain: [number, number], r0: number, r1: number, log = false): Scale {
  const f = (v: number) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
  const d0 = f(domain[0]);
  const d1 = f(domain[1]);
  const span = d1 - d0 || 1;
  const s = ((v: number) => r0 + ((f(v) - d0) / span) * (r1 - r0)) as Scale;
  s.invert = (px: number) => {
    const u = d0 + ((px - r0) / (r1 - r0 || 1)) * span;
    return log ? Math.pow(10, u) : u;
  };
  s.domain = domain;
  s.log = log;
  return s;
}

/** Tick values for a scale: 1/2/5 decades on log axes, nice ticks otherwise. */
export function scaleTicks(scale: Scale, target = 5): number[] {
  const [a, b] = scale.domain;
  if (!scale.log) return niceTicks(a, b, target);
  const out: number[] = [];
  const lo = Math.floor(Math.log10(a));
  const hi = Math.ceil(Math.log10(b));
  const mults = hi - lo > 2 ? [1] : [1, 2, 5];
  for (let e = lo; e <= hi; e++) {
    for (const m of mults) {
      const v = m * Math.pow(10, e);
      if (v >= a * (1 - 1e-9) && v <= b * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

/** Labels for a tick set with one shared number of decimals (so 0.98/0.99/1.00 stay distinct). */
export function formatTicks(ticks: readonly number[], log = false): string[] {
  if (log || ticks.length < 2) return ticks.map(formatTick);
  let step = Infinity;
  for (let i = 1; i < ticks.length; i++) step = Math.min(step, Math.abs(ticks[i] - ticks[i - 1]));
  if (!(step > 0) || step >= 1) return ticks.map(formatTick);
  const dec = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  return ticks.map((v) => (Math.abs(v) >= 1000 ? formatTick(v) : v.toFixed(dec)));
}

/** Tick count that fits `px` pixels at about `perTick` px per label. */
export function tickTarget(px: number, perTick = 48): number {
  return Math.max(2, Math.min(8, Math.floor(px / perTick)));
}

/** Compact tick label. */
export function formatTick(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return `${Math.round(v / 100) / 10}k`;
  if (a >= 10 || Number.isInteger(v)) return String(Math.round(v * 10) / 10);
  if (a >= 1) return v.toFixed(1).replace(/\.0$/, '');
  return String(Number(v.toPrecision(2)));
}

/** Finite min/max of values (with padding fallback for a single value). */
export function extent(values: readonly number[], positiveOnly = false): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v) || (positiveOnly && v <= 0)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return null;
  if (lo === hi) return positiveOnly ? [lo / 1.5, hi * 1.5] : [lo - 0.5, hi + 0.5];
  return [lo, hi];
}

export interface Bin {
  x0: number;
  x1: number;
  ids: number[];
}

/**
 * Histogram with id lists per bin (so a brush returns cells). Bins are equal
 * width in log10 space when `log`. Values outside the domain are clamped into
 * the edge bins; non-finite values are skipped.
 */
export function binValues(
  values: readonly number[],
  domain: [number, number],
  count: number,
  log = false,
  ids?: readonly number[],
): Bin[] {
  const f = (v: number) => (log ? Math.log10(v) : v);
  const g = (u: number) => (log ? Math.pow(10, u) : u);
  const d0 = f(domain[0]);
  const d1 = f(domain[1]);
  const w = (d1 - d0) / count || 1;
  const bins: Bin[] = Array.from({ length: count }, (_, k) => ({
    x0: g(d0 + k * w),
    x1: g(d0 + (k + 1) * w),
    ids: [],
  }));
  values.forEach((v, i) => {
    if (!Number.isFinite(v) || (log && v <= 0)) return;
    const k = Math.min(count - 1, Math.max(0, Math.floor((f(v) - d0) / w)));
    bins[k].ids.push(ids ? ids[i] : i);
  });
  return bins;
}

/** Ticks with labels that share one precision. */
export function labeledTicks(scale: Scale, target = 5): { v: number; label: string }[] {
  const ticks = scaleTicks(scale, target);
  const labels = formatTicks(ticks, scale.log);
  return ticks.map((v, i) => ({ v, label: labels[i] }));
}
