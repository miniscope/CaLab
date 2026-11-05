// Shared uPlot axis / cursor / scale-range helpers: the theme axis chrome
// (stroke + grid + ticks) and the degenerate-span guard, in one place for
// every chart.

import type uPlot from 'uplot';
import { AXIS_TEXT, AXIS_GRID, AXIS_TICK } from './theme-colors.ts';

const LABEL_FONT = '10px sans-serif';

/** Base axis chrome (theme stroke / grid / ticks), merged with `overrides`. */
export function chartAxis(overrides: uPlot.Axis = {}): uPlot.Axis {
  return {
    stroke: AXIS_TEXT,
    grid: { stroke: AXIS_GRID },
    ticks: { stroke: AXIS_TICK },
    ...overrides,
  };
}

/** Axis chrome plus a consistently-styled axis label. */
export function labeledAxis(label: string, overrides: uPlot.Axis = {}): uPlot.Axis {
  return chartAxis({ label, labelSize: 10, labelFont: LABEL_FONT, ...overrides });
}

/** Axis `values` formatter that shows only integer splits (e.g. an iteration axis). */
export function integerTickValues(_u: uPlot, splits: number[]): string[] {
  return (splits ?? []).map((v) => (Number.isInteger(v) ? String(v) : ''));
}

/** Axis `values` formatter that hides all tick labels (keeps gridlines). */
export function hiddenTickValues(_u: uPlot, splits: number[]): string[] {
  return (splits ?? []).map(() => '');
}

/** Cursor that syncs across charts sharing `key`; pass `drag: false` for static charts. */
export function syncCursor(key: string, opts: { drag?: boolean } = {}): uPlot.Cursor {
  const cursor: uPlot.Cursor = { sync: { key, setSeries: true } };
  if (opts.drag === false) cursor.drag = { x: false, y: false };
  return cursor;
}

/** Cursor for a static (non-synced) chart with drag-zoom disabled. */
export const staticCursor: uPlot.Cursor = { drag: { x: false, y: false } };

/**
 * Tick positions for a log-scaled axis (`distr: 3`), replacing uPlot's built-in
 * `logAxisSplits`.
 *
 * uPlot's version can loop without terminating even when handed perfectly valid
 * bounds; the `splits.push` then throws `RangeError: Invalid array length` from
 * inside `axesCalc`, which kills the page mid-render. That was reproduced on
 * this app's only log axis with `scaleMin` and `scaleMax` both positive, finite
 * and under 12 decades apart on every call — so the bounds were never at fault.
 *
 * Emits 1–9 per decade within [scaleMin, scaleMax], the same shape uPlot
 * produces, but refuses to run away: non-finite or non-positive bounds fall back
 * to a two-tick range, an increment that stops making forward progress breaks
 * the loop, and the tick count is hard-capped.
 */
export function logSplits(
  _u: uPlot,
  _axisIdx: number,
  scaleMin: number,
  scaleMax: number,
): number[] {
  const MAX_TICKS = 2000;

  if (
    !Number.isFinite(scaleMin) ||
    !Number.isFinite(scaleMax) ||
    scaleMin <= 0 ||
    scaleMax <= scaleMin
  ) {
    const lo = Number.isFinite(scaleMin) && scaleMin > 0 ? scaleMin : 1e-6;
    return [lo, lo * 10];
  }

  let incr = Math.pow(10, Math.floor(Math.log10(scaleMin)));
  // Underflow: 10 ** -400 is exactly 0, which would make the loop stand still.
  if (!(incr > 0)) return [scaleMin, scaleMax];

  const splits: number[] = [];
  let split = incr;
  while (split <= scaleMax && splits.length < MAX_TICKS) {
    // `incr` starts at the decade floor, which can sit up to a full decade
    // below scaleMin. uPlot does not clip splits to the scale range — axesCalc
    // feeds them straight to getPos — so an out-of-range tick draws its label
    // and gridline outside the plot rect.
    if (split >= scaleMin) splits.push(split);
    const next = split + incr;
    if (!(next > split)) break; // no forward progress
    if (next >= incr * 10) incr = next;
    split = next;
  }

  return splits.length > 0 ? splits : [scaleMin, scaleMax];
}

/**
 * uPlot scale-range fn that never returns a zero span — a degenerate [v, v]
 * range crashes uPlot's drawAxesGrid. Non-finite/absent bounds fall back to
 * [0, 1]; an equal min/max is padded; otherwise the span is padded by
 * `padFrac` (use 0 for an exact-extent axis).
 */
export function safeRange(
  padFrac = 0.1,
): (u: uPlot, dataMin: number, dataMax: number) => [number, number] {
  return (_u, dataMin, dataMax) => {
    if (dataMin == null || dataMax == null || !isFinite(dataMin) || !isFinite(dataMax)) {
      return [0, 1];
    }
    if (dataMin === dataMax) {
      const pad = Math.abs(dataMin) * 0.05 || 0.5;
      return [dataMin - pad, dataMax + pad];
    }
    const pad = (dataMax - dataMin) * padFrac;
    return [dataMin - pad, dataMax + pad];
  };
}
