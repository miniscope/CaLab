import { createMemo, Show, type JSX } from 'solid-js';
import { assertRange, rangePosition } from './range.ts';

export interface SparklineProps {
  /** y values; non-finite values break the line. */
  values: number[];
  /** x of each value (default: the index). */
  x?: number[];
  /** Declared y range [min, max] (required: never from the data). Values outside it are clamped to the edge. */
  range: [number, number];
  /** x at the right edge (default: the last x). */
  xMax?: number;
  /** Line colour (a CSS colour or token reference; default the secondary ink). */
  color?: string;
  /** Box size in px (default 120 x 28). */
  width?: number;
  height?: number;
  /** Accessible name; the last value is appended (formatted by `format`). */
  label: string;
  format?: (v: number) => string;
  class?: string;
  testid?: string;
}

interface Pt {
  px: number;
  py: number;
}

/**
 * A 1.5 px line on a declared y range with a dot on the last finite point. The y position of
 * every point depends only on its own value and the declared range, so a spike moves nothing
 * else; a value outside the range is drawn at the edge.
 */
export function Sparkline(p: SparklineProps): JSX.Element {
  const w = () => p.width ?? 120;
  const h = () => p.height ?? 28;
  const geom = createMemo(() => {
    const range = { min: p.range[0], max: p.range[1] };
    assertRange(range);
    const xs = p.x ?? p.values.map((_, i) => i);
    const x1 = p.xMax ?? xs.at(-1) ?? 0;
    const pad = 2;
    let d = '';
    let pen = false;
    let last: Pt | null = null;
    let lastValue: number | null = null;
    for (let i = 0; i < p.values.length; i++) {
      const pos = rangePosition(p.values[i], range);
      if (!pos) {
        pen = false;
        continue;
      }
      const px = x1 > 0 ? (xs[i] / x1) * w() : 0;
      const py = h() - pad - pos.t * (h() - 2 * pad);
      d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
      pen = true;
      last = { px, py };
      lastValue = p.values[i];
    }
    return { d, last, lastValue };
  });
  const name = () => {
    const v = geom().lastValue;
    return v === null ? `${p.label}: not measured` : `${p.label}: ${(p.format ?? String)(v)}`;
  };
  return (
    <svg
      class={`sparkline${p.class ? ' ' + p.class : ''}`}
      width={w()}
      height={h()}
      viewBox={`0 0 ${w()} ${h()}`}
      role="img"
      aria-label={name()}
      data-testid={p.testid}
      style={{ '--spark-color': p.color ?? 'var(--ink-2)' }}
    >
      <path class="sparkline__line" d={geom().d} />
      <Show when={geom().last}>
        {(pt) => <circle class="sparkline__dot" cx={pt().px} cy={pt().py} r="2" />}
      </Show>
    </svg>
  );
}
