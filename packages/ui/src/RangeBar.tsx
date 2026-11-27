import { createMemo, Show, type JSX } from 'solid-js';
import { assertRange, pct, rangePosition, type FixedRange, type RangeScale } from './range.ts';
import { toneColor, type Tone } from './tones.ts';

export interface RangeBarProps {
  /** Low and high end of the span (e.g. mean and p99); non-finite draws no span. */
  lo: number | null | undefined;
  hi: number | null | undefined;
  /** A dot inside the span (e.g. the median or mean). */
  mark?: number | null;
  /** A reference line across the bar (e.g. the frame budget). */
  reference?: number;
  /** Declared domain; ends outside it are drawn at the edge and flagged with `data-clamped`. */
  min: number;
  max: number;
  scale?: RangeScale;
  /** Colour role of the span (default neutral). */
  tone?: Tone;
  /** Accessible name; the values follow it in the accessible text. */
  label: string;
  format?: (v: number) => string;
  class?: string;
  testid?: string;
}

/**
 * A span from `lo` to `hi` on a declared domain, with an optional mark and reference line.
 * Positions depend only on the declared domain; ends outside it are clamped and
 * `data-clamped` names the clamped side (`under`, `over` or `both`).
 */
export function RangeBar(p: RangeBarProps): JSX.Element {
  const range = (): FixedRange => ({ min: p.min, max: p.max, scale: p.scale });
  const span = createMemo(() => {
    const a = rangePosition(p.lo, range());
    const b = rangePosition(p.hi, range());
    if (!a || !b) return null;
    const left = Math.min(a.t, b.t);
    const clamped = [a.clamped, b.clamped].filter((c) => c !== null);
    const side =
      clamped.length === 0
        ? undefined
        : clamped.includes('under') && clamped.includes('over')
          ? 'both'
          : clamped[0];
    return { left, width: Math.abs(b.t - a.t), side };
  });
  const mark = createMemo(() => rangePosition(p.mark, range()));
  const ref = createMemo(() =>
    p.reference === undefined ? null : rangePosition(p.reference, range()),
  );
  const fmt = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? 'not measured' : (p.format ?? String)(v);
  const name = () =>
    `${p.label}: ${fmt(p.lo)} to ${fmt(p.hi)}` +
    (p.mark != null ? `, mark ${fmt(p.mark)}` : '') +
    (p.reference !== undefined ? `, reference ${fmt(p.reference)}` : '');
  assertRange(range());
  return (
    <div
      class={`range-bar${p.class ? ' ' + p.class : ''}`}
      role="img"
      aria-label={name()}
      data-clamped={span()?.side}
      data-testid={p.testid}
      style={{ '--range-color': toneColor(p.tone ?? 'neutral') }}
    >
      <Show when={span()}>
        {(s) => (
          <span class="range-bar__span" style={{ left: pct(s().left), width: pct(s().width) }} />
        )}
      </Show>
      <Show when={mark()}>
        {(m) => <span class="range-bar__mark" style={{ left: pct(m().t) }} />}
      </Show>
      <Show when={ref()}>
        {(r) => <span class="range-bar__ref" style={{ left: pct(r().t) }} />}
      </Show>
    </div>
  );
}
