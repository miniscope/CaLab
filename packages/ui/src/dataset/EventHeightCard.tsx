/**
 * Card (b): event-height distributions, each cell's heights divided by its
 * own median height, drawn as quantile curves (an ECDF on its side). The
 * population is summarised by the median curve and its 10–90 % band across
 * cells; only flagged and selected cells get their own curve, so the card
 * does not grow with N. Clicking a curve picks that cell.
 */

import { createMemo, For, Show, type JSX } from 'solid-js';
import { labeledTicks, makeScale, tickTarget } from './chart-scales.ts';
import { OverviewCard, createElementSize } from './OverviewCard.tsx';

export interface HeightCurve {
  id: number;
  quantiles: readonly number[];
  kind: 'flag' | 'selected' | 'highlight';
}

export interface EventHeightCardProps {
  /** Probabilities of the quantiles (e.g. .05 … .95). */
  probs: readonly number[];
  pooled: () => { p10: number[]; p50: number[]; p90: number[] } | null;
  curves: () => HeightCurve[];
  onPick?: (id: number) => void;
  /** Cells with enough events to have a curve. */
  nWithShape?: () => number;
  eventSeparationS?: number;
}

const M = { l: 30, r: 8, t: 8, b: 26 };

export function EventHeightCard(props: EventHeightCardProps): JSX.Element {
  let host: HTMLDivElement | undefined;
  const size = createElementSize(() => host);
  const W = () => size().width;
  const H = () => Math.max(60, size().height);

  const domain = createMemo<[number, number]>(() => {
    let lo = 1;
    let hi = 1;
    const take = (q: readonly number[]) => {
      for (const v of q) {
        if (v > 0 && Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    };
    const p = props.pooled();
    if (p) {
      take(p.p10);
      take(p.p90);
    }
    for (const c of props.curves()) take(c.quantiles);
    return [Math.max(lo / 1.2, 0.02), Math.min(hi * 1.2, 1000)];
  });
  const x = createMemo(() => makeScale(domain(), M.l, W() - M.r, true));
  const y = createMemo(() => makeScale([0, 1], H() - M.b, M.t));

  const line = (q: readonly number[]) =>
    q
      .map(
        (v, k) =>
          `${k ? 'L' : 'M'}${x()(Math.max(v, 1e-6)).toFixed(1)},${y()(props.probs[k]).toFixed(1)}`,
      )
      .join('');
  const band = createMemo(() => {
    const p = props.pooled();
    if (!p) return '';
    const up = p.p10.map((v, k) => `${x()(v).toFixed(1)},${y()(props.probs[k]).toFixed(1)}`);
    const down = p.p90
      .map((v, k) => `${x()(v).toFixed(1)},${y()(props.probs[k]).toFixed(1)}`)
      .reverse();
    return `M${up.join('L')}L${down.join('L')}Z`;
  });

  const handleClick = (e: MouseEvent) => {
    if (!props.onPick) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best: { id: number; d: number } | null = null;
    for (const c of props.curves()) {
      c.quantiles.forEach((v, k) => {
        const d = Math.hypot(x()(v) - mx, y()(props.probs[k]) - my);
        if (!best || d < best.d) best = { id: c.id, d };
      });
    }
    const hit = best as { id: number; d: number } | null;
    if (hit && hit.d < 10) props.onPick(hit.id);
  };

  return (
    <OverviewCard
      title="Event heights (÷ own median)"
      data-testid="overview-heights"
      help={
        <p>
          Each cell's event heights divided by its own median height, as quantile curves (cumulative
          fraction of events, y, against relative height, x). Dividing by the median compares the{' '}
          <em>shape</em> of the distributions, the shared-burst-distribution assumption behind
          comparing SNR across cells. Line: median across cells; band: 10–90 % of cells. Red curves
          are cells flagged as shape outliers; click one to inspect it. Events are at least{' '}
          {props.eventSeparationS ?? 0.5} s apart (a fixed default: no kernel exists yet).
        </p>
      }
      footer={
        <>
          <span>median curve + 10–90 % band</span>
          <Show when={props.nWithShape}>
            <span>N {props.nWithShape!()} cells with ≥ 3 events</span>
          </Show>
        </>
      }
    >
      <div class="ov-hist" ref={host}>
        <Show
          when={props.pooled()}
          fallback={<div class="ov-empty">Too few events to compare shapes</div>}
        >
          <svg
            class="ov-svg"
            width={W()}
            height={H()}
            role="img"
            aria-label="event height distributions"
            onClick={handleClick}
          >
            <For each={[0.25, 0.5, 0.75]}>
              {(p) => (
                <>
                  <line class="ov-grid" x1={M.l} x2={W() - M.r} y1={y()(p)} y2={y()(p)} />
                  <text class="ov-tick" x={M.l - 4} y={y()(p) + 3} text-anchor="end">
                    {p}
                  </text>
                </>
              )}
            </For>
            <path class="ov-band" d={band()} />
            <path class="ov-line" d={line(props.pooled()!.p50)} />
            <For each={props.curves()}>
              {(c) => (
                <path class={`ov-curve ov-curve--${c.kind}`} d={line(c.quantiles)} data-cell={c.id}>
                  <title>Cell {c.id}</title>
                </path>
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
            <text class="ov-axis-label" x={(M.l + W() - M.r) / 2} y={H() - 2} text-anchor="middle">
              height ÷ cell median (log)
            </text>
          </svg>
        </Show>
      </div>
    </OverviewCard>
  );
}
