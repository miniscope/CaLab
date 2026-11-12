import { createMemo, For, Show, type JSX } from 'solid-js';

const W = 150;
const H = 30;

export interface SparkLine {
  values: number[];
  color: string;
  dash?: string;
}

/**
 * Y range of a sparkline: the fixed `range` if given, else from min(0, lowest)
 * to the 98th percentile of the finite values (one early spike must not flatten
 * the rest). hi <= lo becomes lo + 1.
 */
export function sparkRange(
  lines: SparkLine[],
  range?: [number, number],
): { lo: number; hi: number } {
  if (range) return { lo: range[0], hi: range[1] > range[0] ? range[1] : range[0] + 1 };
  let lo = 0;
  let hi = -Infinity;
  const v = lines.flatMap((l) => l.values.filter(Number.isFinite)).sort((a, b) => a - b);
  if (v.length > 0) {
    lo = Math.min(0, v[0]);
    hi = v[Math.floor(0.98 * (v.length - 1))];
  }
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  return { lo, hi };
}

/** SVG path of `values` against `x` (0..x1) scaled into a w by h box; gaps at non-finite values. */
export function sparkPath(
  x: number[],
  values: number[],
  x1: number,
  lo: number,
  hi: number,
  w: number = W,
  h: number = H,
): string {
  let d = '';
  let pen = false;
  const span = hi > lo ? hi - lo : 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const px = x1 > 0 ? (x[i] / x1) * w : 0;
    const py = h - 1 - Math.min(1, (v - lo) / span) * (h - 2);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  }
  return d;
}

export interface MetricTileProps {
  title: JSX.Element;
  value: JSX.Element;
  hint?: string;
  x?: number[];
  lines?: SparkLine[];
  /** Fixed y range (else from 0 to the data's 98th percentile). */
  range?: [number, number];
  /** x value at the right edge (default: the last x). */
  xMax?: number;
  testid?: string;
  class?: string;
}

/** Small multiple: title, current value, and optional sparkline(s). */
export function MetricTile(p: MetricTileProps): JSX.Element {
  const box = createMemo(() => ({
    x1: p.xMax ?? p.x?.at(-1) ?? 0,
    ...sparkRange(p.lines ?? [], p.range),
  }));
  return (
    <div class={`metric-tile${p.class ? ' ' + p.class : ''}`} title={p.hint} data-testid={p.testid}>
      <div class="metric-tile__head">
        <span class="metric-tile__title">{p.title}</span>
        <span class="metric-tile__value">{p.value}</span>
      </div>
      <Show when={p.lines}>
        {(lines) => (
          <svg class="metric-tile__plot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <For each={lines()}>
              {(l) => (
                <path
                  d={sparkPath(p.x ?? [], l.values, box().x1, box().lo, box().hi)}
                  fill="none"
                  stroke={l.color}
                  stroke-width="1.4"
                  stroke-dasharray={l.dash}
                  vector-effect="non-scaling-stroke"
                />
              )}
            </For>
          </svg>
        )}
      </Show>
    </div>
  );
}
