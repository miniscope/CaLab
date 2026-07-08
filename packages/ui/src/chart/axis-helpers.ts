// Shared uPlot axis / cursor / scale-range helpers. The theme axis chrome
// (stroke + grid + ticks) and the degenerate-span guard were previously
// copy-pasted into every chart component across the apps; these collapse that
// duplication into one place.

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
