/**
 * SVG histogram whose bins keep cell ids: dragging across it brushes a range
 * and returns the cells in it; a click clears. Highlighted cells are drawn as
 * an accent overlay inside each bar. N-independent: cost is O(N) to bin.
 */

import { createMemo, For, Show, type JSX } from 'solid-js';
import {
  binValues,
  extent,
  formatTick,
  labeledTicks,
  makeScale,
  scaleTicks,
  tickTarget,
  type Bin,
} from './chart-scales.ts';
import { createBrush, createElementSize } from './OverviewCard.tsx';

export interface HistogramMarker {
  x: number;
  label?: string;
  /** CSS colour; defaults to the secondary text colour. */
  color?: string;
  dashed?: boolean;
}

export interface BrushHistogramProps {
  values: () => readonly number[];
  /** Cell id of each value (defaults to the value's index). */
  ids?: () => readonly number[];
  domain?: [number, number];
  log?: boolean;
  binCount?: number;
  /** Fill colour per bin (default: accent). */
  binColor?: (bin: Bin, k: number) => string;
  /** Shaded x-interval with a label (e.g. the noise floor). */
  shade?: { lo: number; hi: number; label?: string };
  markers?: () => HistogramMarker[];
  highlighted?: () => ReadonlySet<number> | null;
  onBrush?: (ids: number[] | null) => void;
  xLabel?: string;
  /** Rotated y-axis label (e.g. "cells"). */
  yLabel?: string;
  /** Minimum height for the plot (px). */
  minHeight?: number;
  ariaLabel?: string;
}

const M0 = { l: 28, r: 8, t: 8, b: 26 };
/** Extra left margin that makes room for a rotated y label. */
const Y_LABEL_PX = 8;
/** Height of one row of marker/shade labels above the bars. */
const LABEL_ROW_PX = 11;
/** Rough advance of a 9 px label glyph, for collision checks. */
const LABEL_CHAR_PX = 5.4;

export interface LabelSlot {
  anchor: 'start' | 'end';
  /** 0 = top row; later rows sit below so close labels never overprint. */
  row: number;
}

/**
 * Place marker labels beside their lines (flipping to the left near the right
 * edge) and push a label to the next row when it would overlap one already
 * placed. `reserved` spans (e.g. the shade label) occupy row 0.
 */
export function layoutMarkerLabels(
  items: readonly { px: number; label: string }[],
  plotRight: number,
  reserved: readonly [number, number][] = [],
): LabelSlot[] {
  const rows: [number, number][][] = [[...reserved]];
  const order = items.map((_, i) => i).sort((a, b) => items[a].px - items[b].px);
  const out: LabelSlot[] = new Array(items.length);
  for (const i of order) {
    const { px, label } = items[i];
    const w = label.length * LABEL_CHAR_PX;
    const anchor = px + 3 + w > plotRight ? 'end' : 'start';
    const span: [number, number] = anchor === 'end' ? [px - 3 - w, px - 3] : [px + 3, px + 3 + w];
    let row = rows.findIndex((r) => r.every(([a, b]) => span[1] + 4 < a || span[0] > b + 4));
    if (row < 0) {
      row = rows.length;
      rows.push([]);
    }
    rows[row].push(span);
    out[i] = { anchor, row };
  }
  return out;
}

export function BrushHistogram(props: BrushHistogramProps): JSX.Element {
  let host: HTMLDivElement | undefined;
  const size = createElementSize(() => host);
  const W = () => size().width;
  const H = () => Math.max(props.minHeight ?? 60, size().height);
  const M = {
    ...M0,
    get l() {
      return M0.l + (props.yLabel ? Y_LABEL_PX : 0);
    },
  };

  const domain = createMemo<[number, number]>(() => {
    if (props.domain) return props.domain;
    return extent(props.values(), !!props.log) ?? (props.log ? [1, 10] : [0, 1]);
  });
  const bins = createMemo(() =>
    binValues(props.values(), domain(), props.binCount ?? 24, !!props.log, props.ids?.()),
  );
  const maxCount = createMemo(() => bins().reduce((m, b) => Math.max(m, b.ids.length), 0) || 1);
  const x = createMemo(() => makeScale(domain(), M.l, W() - M.r, !!props.log));
  const visibleMarkers = createMemo(() =>
    (props.markers?.() ?? []).filter((m) => m.x >= domain()[0] && m.x <= domain()[1]),
  );
  const labelSlots = createMemo(() => {
    const shadeLabel = props.shade?.label;
    const reserved: [number, number][] = shadeLabel
      ? [
          [
            x()(Math.max(props.shade!.lo, domain()[0])),
            x()(Math.max(props.shade!.lo, domain()[0])) + 3 + shadeLabel.length * LABEL_CHAR_PX,
          ],
        ]
      : [];
    return layoutMarkerLabels(
      visibleMarkers().map((m) => ({ px: x()(m.x), label: m.label ?? '' })),
      W() - M.r,
      reserved,
    );
  });
  // Marker and shade labels sit in rows above the tallest bar, never on it.
  const labelRows = () => {
    const labeled = visibleMarkers()
      .map((m, i) => (m.label ? labelSlots()[i].row + 1 : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    return Math.max(labeled, props.shade?.label ? 1 : 0);
  };
  const y = createMemo(() =>
    makeScale([0, maxCount()], H() - M.b, M.t + labelRows() * LABEL_ROW_PX + 1),
  );
  const yTicks = createMemo(() => scaleTicks(y(), 2).filter((v) => Number.isInteger(v)));

  const brush = createBrush({
    onBrush(r) {
      const a = x().invert(Math.min(r.x0, r.x1));
      const b = x().invert(Math.max(r.x0, r.x1));
      const out: number[] = [];
      for (const bin of bins()) {
        // A bin is in the brush when its centre is.
        const mid = props.log ? Math.sqrt(bin.x0 * bin.x1) : (bin.x0 + bin.x1) / 2;
        if (mid >= a && mid <= b) out.push(...bin.ids);
      }
      props.onBrush?.(out);
    },
    onClick() {
      props.onBrush?.(null);
    },
  });

  return (
    <div class="ov-hist" ref={host} style={{ 'min-height': `${props.minHeight ?? 60}px` }}>
      <svg
        class="ov-svg"
        width={W()}
        height={H()}
        role="img"
        aria-label={props.ariaLabel ?? 'histogram'}
        {...brush.handlers}
      >
        <Show when={props.shade}>
          {(s) => {
            const x0 = () => Math.max(M.l, x()(Math.max(s().lo, domain()[0])));
            const x1 = () => Math.min(W() - M.r, x()(s().hi));
            return (
              <Show when={x1() > x0()}>
                <rect
                  class="ov-shade"
                  x={x0()}
                  y={M.t}
                  width={x1() - x0()}
                  height={H() - M.t - M.b}
                />
                <Show when={s().label}>
                  <text class="ov-shade__label" x={x0() + 3} y={M.t + 9}>
                    {s().label}
                  </text>
                </Show>
              </Show>
            );
          }}
        </Show>
        <For each={yTicks()}>
          {(v) => (
            <>
              <line class="ov-grid" x1={M.l} x2={W() - M.r} y1={y()(v)} y2={y()(v)} />
              <text class="ov-tick" x={M.l - 4} y={y()(v) + 3} text-anchor="end">
                {formatTick(v)}
              </text>
            </>
          )}
        </For>
        <For each={bins()}>
          {(bin, k) => {
            const hl = () => {
              const set = props.highlighted?.();
              if (!set) return 0;
              let n = 0;
              for (const id of bin.ids) if (set.has(id)) n++;
              return n;
            };
            const bx = () => x()(bin.x0) + 0.5;
            const bw = () => Math.max(1, x()(bin.x1) - x()(bin.x0) - 1);
            return (
              <Show when={bin.ids.length > 0}>
                <rect
                  class="ov-bar"
                  classList={{ 'ov-bar--dim': props.highlighted?.() != null }}
                  x={bx()}
                  y={y()(bin.ids.length)}
                  width={bw()}
                  height={H() - M.b - y()(bin.ids.length)}
                  fill={props.binColor?.(bin, k()) ?? 'var(--accent)'}
                >
                  <title>
                    {formatTick(bin.x0)}–{formatTick(bin.x1)}: {bin.ids.length} cells
                  </title>
                </rect>
                <Show when={hl() > 0}>
                  <rect
                    class="ov-bar--hl"
                    x={bx()}
                    y={y()(hl())}
                    width={bw()}
                    height={H() - M.b - y()(hl())}
                  />
                </Show>
              </Show>
            );
          }}
        </For>
        <For each={visibleMarkers()}>
          {(m, i) => (
            <>
              <line
                class="ov-marker"
                classList={{ 'ov-marker--dashed': !!m.dashed }}
                x1={x()(m.x)}
                x2={x()(m.x)}
                y1={M.t}
                y2={H() - M.b}
                style={m.color ? { stroke: m.color } : undefined}
              />
              <Show when={m.label}>
                <text
                  class="ov-marker__label"
                  x={x()(m.x) + (labelSlots()[i()]?.anchor === 'end' ? -3 : 3)}
                  text-anchor={labelSlots()[i()]?.anchor ?? 'start'}
                  y={M.t + 9 + (labelSlots()[i()]?.row ?? 0) * LABEL_ROW_PX}
                  style={m.color ? { fill: m.color } : undefined}
                >
                  {m.label}
                </text>
              </Show>
            </>
          )}
        </For>
        <line class="ov-axis" x1={M.l} x2={W() - M.r} y1={H() - M.b} y2={H() - M.b} />
        <For each={labeledTicks(x(), tickTarget(W() - M.l - M.r))}>
          {(t) => (
            <text class="ov-tick" x={x()(t.v)} y={H() - M.b + 11} text-anchor="middle">
              {t.label}
            </text>
          )}
        </For>
        <Show when={props.xLabel}>
          <text class="ov-axis-label" x={(M.l + W() - M.r) / 2} y={H() - 2} text-anchor="middle">
            {props.xLabel}
          </text>
        </Show>
        <Show when={props.yLabel}>
          <text
            class="ov-axis-label"
            transform={`translate(8 ${(M.t + H() - M.b) / 2}) rotate(-90)`}
            text-anchor="middle"
          >
            {props.yLabel}
          </text>
        </Show>
        <Show when={brush.active()}>
          {(b) => (
            <rect
              class="ov-brush"
              x={Math.min(b().x0, b().x1)}
              y={M.t}
              width={Math.abs(b().x1 - b().x0)}
              height={H() - M.t - M.b}
            />
          )}
        </Show>
      </svg>
    </div>
  );
}
