import { createMemo, Show, type JSX } from 'solid-js';
import { assertRange, pct, rangePosition, type FixedRange, type RangeScale } from './range.ts';
import { toneColor, type Tone } from './tones.ts';

export interface MeterProps {
  /** The measured value; null, undefined or non-finite draws "not measured" (no fill). */
  value: number | null | undefined;
  /** Declared range: the meter never rescales to the data. */
  min: number;
  max: number;
  scale?: RangeScale;
  /** Accessible name (required: a meter without a name is unreadable to assistive tech). */
  label: string;
  /** aria-valuetext; default: the value as formatted by `format`, or "not measured". */
  valueText?: string;
  /** Formats the value for the default aria-valuetext (default: String). */
  format?: (v: number) => string;
  /** A tick at this value (the target or the limit). Clamped to the range. */
  target?: number;
  /** A shaded band [lo, hi] (an expected or allowed zone). Clamped to the range. */
  band?: [number, number];
  /** Colour role of the fill (default neutral). */
  tone?: Tone;
  /** Track height: 'sm' 4 px, 'md' 6 px (default). */
  size?: 'sm' | 'md';
  class?: string;
  testid?: string;
}

/**
 * A horizontal meter on a declared range: fill from `min` to the value, an optional target
 * tick and band. Values outside the range fill to the nearest end and set `data-clamped`
 * (`under` or `over`), which draws an end cap; geometry depends only on the declared range.
 */
export function Meter(p: MeterProps): JSX.Element {
  const range = (): FixedRange => ({ min: p.min, max: p.max, scale: p.scale });
  const pos = createMemo(() => rangePosition(p.value, range()));
  const tick = createMemo(() => (p.target === undefined ? null : rangePosition(p.target, range())));
  const band = createMemo(() => {
    if (!p.band) return null;
    const a = rangePosition(p.band[0], range());
    const b = rangePosition(p.band[1], range());
    if (!a || !b) return null;
    return { left: Math.min(a.t, b.t), width: Math.abs(b.t - a.t) };
  });
  const text = () => {
    if (p.valueText !== undefined) return p.valueText;
    const v = p.value;
    if (v == null || !Number.isFinite(v)) return 'not measured';
    return (p.format ?? String)(v);
  };
  assertRange(range());
  return (
    <div
      class={`meter meter--${p.size ?? 'md'}${pos() === null ? ' meter--empty' : ''}${p.class ? ' ' + p.class : ''}`}
      role="meter"
      aria-label={p.label}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      aria-valuenow={
        pos() === null ? undefined : Math.min(p.max, Math.max(p.min, p.value as number))
      }
      aria-valuetext={text()}
      data-clamped={pos()?.clamped ?? undefined}
      data-testid={p.testid}
      style={{ '--meter-color': toneColor(p.tone ?? 'neutral') }}
    >
      <Show when={band()}>
        {(b) => (
          <span
            class="meter__band"
            style={{ left: pct(b().left), width: pct(b().width) }}
            aria-hidden="true"
          />
        )}
      </Show>
      <Show when={pos()}>
        {(q) => <span class="meter__fill" style={{ width: pct(q().t) }} aria-hidden="true" />}
      </Show>
      <Show when={tick()}>
        {(t) => <span class="meter__tick" style={{ left: pct(t().t) }} aria-hidden="true" />}
      </Show>
    </div>
  );
}

export interface MeterRowProps extends Omit<MeterProps, 'label'> {
  /** Visible label; also the meter's accessible name. */
  label: string;
  /** Visible figure; default: `format(value)`, or a grey dash when not measured. */
  display?: JSX.Element;
  /** Unit shown after the figure in the secondary ink. */
  unit?: string;
}

/** One labelled meter row: label, meter, then the figure in tabular figures. */
export function MeterRow(p: MeterRowProps): JSX.Element {
  const measured = () => p.value != null && Number.isFinite(p.value);
  return (
    <div class="meter-row" data-testid={p.testid}>
      <span class="meter-row__label">{p.label}</span>
      <Meter
        value={p.value}
        min={p.min}
        max={p.max}
        scale={p.scale}
        label={p.label}
        valueText={p.valueText}
        format={p.format}
        target={p.target}
        band={p.band}
        tone={p.tone}
        size={p.size}
        class={p.class}
      />
      <span class="meter-row__value num">
        <Show
          when={measured()}
          fallback={
            <span class="meter-row__dash" aria-hidden="true">
              –
            </span>
          }
        >
          {p.display ?? (p.format ?? String)(p.value as number)}
          <Show when={p.unit}>
            <span class="unit"> {p.unit}</span>
          </Show>
        </Show>
      </span>
    </div>
  );
}
