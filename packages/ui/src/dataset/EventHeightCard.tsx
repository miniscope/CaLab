/**
 * Card (b): event-height distributions, each cell's heights divided by its
 * own median height, drawn as quantile curves (an ECDF on its side). The
 * population is summarised by the median curve and its 10–90 % band across
 * cells; only flagged and selected cells get their own curve, so the card
 * does not grow with N. Clicking a curve picks that cell.
 */

import { createMemo, For, Show, type JSX } from 'solid-js';
import { OVERVIEW_PARAMS } from '@calab/core';
import { labeledTicks, makeScale, tickTarget } from './chart-scales.ts';
import { OverviewCard, createElementSize } from './OverviewCard.tsx';
import { ChartLegend, type LegendItem } from './ChartLegend.tsx';

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
  /** Median event count of the cells with a curve; below
   *  `OVERVIEW_PARAMS.heightVerdictMinEvents` the takeaway gives no verdict. */
  medianEvents?: () => number;
  /** Band spread (see `heightBandSpread`) at or below which cells read as
   *  consistent. Defaults to `OVERVIEW_PARAMS.heightBandConsistentRatio`. */
  consistentRatio?: number;
}

export type HeightVerdict = 'consistent' | 'varies' | 'few-events';

/** Display-only reading of the band: see `OVERVIEW_PARAMS.heightBandConsistentRatio`. */
export function heightVerdict(
  spread: number,
  medianEvents: number | undefined,
  consistentRatio: number = OVERVIEW_PARAMS.heightBandConsistentRatio,
  minEvents: number = OVERVIEW_PARAMS.heightVerdictMinEvents,
): HeightVerdict | null {
  if (!Number.isFinite(spread)) return null;
  if (medianEvents != null && medianEvents < minEvents) return 'few-events';
  return spread <= consistentRatio ? 'consistent' : 'varies';
}

const M = { l: 26, r: 8, t: 8, b: 26 };
/** Quantile at which the band width is read for the takeaway line. */
const SPREAD_PROB = 0.9;

/**
 * Width of the 10–90 % band at the 90th-percentile event: the 90th-percentile
 * cell's relative height over the 10th-percentile cell's. 1 = every cell's
 * large events sit the same distance above its median. NaN without data.
 */
export function heightBandSpread(
  probs: readonly number[],
  pooled: { p10: readonly number[]; p90: readonly number[] } | null,
): number {
  if (!pooled || probs.length === 0) return NaN;
  let k = 0;
  for (let i = 1; i < probs.length; i++) {
    if (Math.abs(probs[i] - SPREAD_PROB) < Math.abs(probs[k] - SPREAD_PROB)) k = i;
  }
  const lo = pooled.p10[k];
  const hi = pooled.p90[k];
  return lo > 0 && hi > 0 ? hi / lo : NaN;
}

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

  const spread = createMemo(() => heightBandSpread(props.probs, props.pooled()));
  const verdict = createMemo(() =>
    heightVerdict(spread(), props.medianEvents?.(), props.consistentRatio),
  );
  const takeaway = () => {
    const sp = spread().toFixed(1);
    switch (verdict()) {
      case 'consistent':
        return `Cells look consistent (${sp}× spread): SNR is comparable`;
      case 'varies':
        return `Event-size spread varies across cells (${sp}×): compare SNR with care`;
      case 'few-events':
        return `Too few events per cell (median ${Math.round(props.medianEvents!())}) to judge consistency`;
      default:
        return '';
    }
  };

  const legend = createMemo((): LegendItem[] => {
    const items: LegendItem[] = [
      { mark: 'line', className: 'ov-line', label: 'median cell' },
      { mark: 'area', className: 'ov-band', label: '10–90 % of cells' },
    ];
    const kinds = new Set(props.curves().map((c) => c.kind));
    if (kinds.has('flag'))
      items.push({ mark: 'line', className: 'ov-curve ov-curve--flag', label: 'flagged cell' });
    if (kinds.has('highlight'))
      items.push({
        mark: 'line',
        className: 'ov-curve ov-curve--highlight',
        label: 'highlighted',
      });
    if (kinds.has('selected'))
      items.push({ mark: 'line', className: 'ov-curve ov-curve--selected', label: 'inspected' });
    return items;
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
      title="Event-size consistency"
      subtitle="Do cells share a similar spread of event sizes?"
      data-testid="overview-heights"
      legend={
        <Show when={props.pooled()}>
          <ChartLegend items={legend()} />
        </Show>
      }
      help={
        <>
          <p>
            Each cell's event heights divided by its own median height, as quantile curves
            (cumulative fraction of events, y, against relative height, x). Dividing by the median
            compares the <em>shape</em> of the distributions, the shared-burst-distribution
            assumption behind comparing SNR across cells. Line: median across cells; band: 10–90 %
            of cells. Red curves are cells flagged as shape outliers; click one to inspect it.
            Events are at least {props.eventSeparationS ?? 0.5} s apart (a fixed default: no kernel
            exists yet).
          </p>
          <p>
            The line under the plot reads the band's width at the 90th-percentile event
            (90th-percentile cell ÷ 10th-percentile cell): consistent at or below{' '}
            {props.consistentRatio ?? OVERVIEW_PARAMS.heightBandConsistentRatio}×. With fewer than{' '}
            {OVERVIEW_PARAMS.heightVerdictMinEvents} events in the median cell, the band is mostly
            sampling noise and no verdict is given.
          </p>
        </>
      }
      footer={
        <>
          <Show when={verdict()}>
            <span
              class="ov-takeaway"
              classList={{ 'ov-takeaway--warn': verdict() === 'varies' }}
              data-testid="overview-heights-takeaway"
              title={takeaway()}
            >
              {takeaway()}
            </span>
          </Show>
          <Show when={props.nWithShape}>
            <span title="cells with at least 3 events">N {props.nWithShape!()}</span>
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
              {(p) => <line class="ov-grid" x1={M.l} x2={W() - M.r} y1={y()(p)} y2={y()(p)} />}
            </For>
            <For each={[0, 0.5, 1]}>
              {(p) => (
                <text class="ov-tick" x={M.l - 4} y={y()(p) + 3} text-anchor="end">
                  {p}
                </text>
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
              event height ÷ cell's median event (log scale)
            </text>
            {/* y title sits horizontally in the empty top-left corner of an ECDF. */}
            <text class="ov-axis-label ov-halo-text" x={M.l + 3} y={M.t + 8}>
              ↑ fraction of events below
            </text>
          </svg>
        </Show>
      </div>
    </OverviewCard>
  );
}
