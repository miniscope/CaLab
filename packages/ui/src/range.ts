/**
 * Fixed-range contract shared by the instrument primitives (Meter, Sparkline, RangeBar,
 * SegmentedBar, StageTrack).
 *
 * Every range is declared by the caller (from physics, biology or a fixed budget) and never
 * derived from the data, so a spike cannot rescale the other marks or be clipped silently:
 * a value outside the range is drawn at the nearest end and flagged `under` or `over`.
 */

/** Linear or logarithmic mapping of a declared range onto [0, 1]. */
export type RangeScale = 'linear' | 'log';

/** A declared display range. `min < max`; with `scale: 'log'`, `min > 0`. */
export interface FixedRange {
  min: number;
  max: number;
  scale?: RangeScale;
}

/** Where a value sits on a declared range. */
export interface RangePosition {
  /** Position in [0, 1] from `min` to `max`, clamped. */
  t: number;
  /** Which end the value was clamped to, or null when it lies inside the range. */
  clamped: 'under' | 'over' | null;
}

/**
 * Throws a RangeError unless `range` is a valid declared range: finite, `min < max`, and
 * `min > 0` on a log scale. Declared ranges are constants, so a violation is a caller bug.
 */
export function assertRange(range: FixedRange): void {
  const { min, max } = range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
    throw new RangeError(`display range needs finite min < max, got [${min}, ${max}]`);
  }
  if (range.scale === 'log' && min <= 0) {
    throw new RangeError(`a log display range needs min > 0, got ${min}`);
  }
}

/**
 * Position of `value` on the declared range, clamped to [0, 1] with the clamped end named;
 * null when `value` is missing or not finite (the caller draws "not measured"). On a log
 * scale a value at or below zero is clamped `under`.
 */
export function rangePosition(
  value: number | null | undefined,
  range: FixedRange,
): RangePosition | null {
  assertRange(range);
  if (value == null || !Number.isFinite(value)) return null;
  let t: number;
  if (range.scale === 'log') {
    t =
      value <= 0
        ? -Infinity
        : (Math.log(value) - Math.log(range.min)) / (Math.log(range.max) - Math.log(range.min));
  } else {
    t = (value - range.min) / (range.max - range.min);
  }
  if (t < 0) return { t: 0, clamped: 'under' };
  if (t > 1) return { t: 1, clamped: 'over' };
  return { t, clamped: null };
}

/** `t` in [0, 1] as a CSS percentage with at most three decimals. */
export function pct(t: number): string {
  return `${Math.round(t * 100_000) / 1000}%`;
}
