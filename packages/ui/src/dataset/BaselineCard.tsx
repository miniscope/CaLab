/**
 * Card (d): population baseline over time (median and IQR across cells of
 * each cell's normalised low-quantile baseline) beside a brushable histogram
 * of the per-cell start→end baseline change.
 */

import { createMemo, For, Show, type JSX } from 'solid-js';
import { BrushHistogram } from './BrushHistogram.tsx';
import { labeledTicks, makeScale, tickTarget } from './chart-scales.ts';
import { OverviewCard, createElementSize } from './OverviewCard.tsx';

export interface BaselineCardProps {
  data: () => {
    mode: 'ratio' | 'sigma';
    time: number[];
    median: number[];
    q25: number[];
    q75: number[];
    drift: number[];
  } | null;
  highlighted?: () => ReadonlySet<number> | null;
  onBrush?: (ids: number[] | null) => void;
}

const M = { l: 34, r: 6, t: 8, b: 26 };

export function BaselineCard(props: BaselineCardProps): JSX.Element {
  let host: HTMLDivElement | undefined;
  const size = createElementSize(() => host, { width: 200, height: 120 });
  const W = () => size().width;
  const H = () => Math.max(60, size().height);

  const ratio = () => props.data()?.mode === 'ratio';
  const yDomain = createMemo<[number, number]>(() => {
    const d = props.data();
    if (!d) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const arr of [d.q25, d.q75, d.median]) {
      for (const v of arr) {
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const ref = ratio() ? 1 : 0;
    lo = Math.min(lo, ref);
    hi = Math.max(hi, ref);
    const pad = (hi - lo) * 0.15 || (ratio() ? 0.05 : 0.5);
    return [lo - pad, hi + pad];
  });
  const x = createMemo(() => {
    const t = props.data()?.time ?? [0, 1];
    return makeScale([0, (t[t.length - 1] ?? 1) + (t[0] ?? 0)], M.l, W() - M.r);
  });
  const y = createMemo(() => makeScale(yDomain(), H() - M.b, M.t));

  const path = (vals: number[]) => {
    const d = props.data()!;
    let s = '';
    let pen = false;
    vals.forEach((v, k) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      s += `${pen ? 'L' : 'M'}${x()(d.time[k]).toFixed(1)},${y()(v).toFixed(1)}`;
      pen = true;
    });
    return s;
  };
  const band = () => {
    const d = props.data()!;
    const pts: string[] = [];
    const back: string[] = [];
    d.time.forEach((t, k) => {
      if (Number.isFinite(d.q25[k]) && Number.isFinite(d.q75[k])) {
        pts.push(`${x()(t).toFixed(1)},${y()(d.q75[k]).toFixed(1)}`);
        back.push(`${x()(t).toFixed(1)},${y()(d.q25[k]).toFixed(1)}`);
      }
    });
    return pts.length ? `M${pts.join('L')}L${back.reverse().join('L')}Z` : '';
  };

  const yLabel = () => (ratio() ? 'F₀ ÷ cell median' : 'Δ baseline (σ)');
  const driftLabel = () => (ratio() ? 'end ÷ start' : 'end − start (σ)');

  return (
    <OverviewCard
      title="Baseline over time"
      data-testid="overview-baseline"
      help={
        <p>
          Each cell's baseline is the 10th percentile of its trace in 200 time bins.
          {ratio()
            ? ' Each cell is divided by its own median baseline (raw fluorescence), so 1 = typical F₀; a downward trend is bleaching.'
            : ' The data look like ΔF/F or detrended (baseline near 0), so each cell is shown as its offset from its median baseline in units of its noise σ.'}{' '}
          Line: median across cells; band: interquartile range. Right: each cell's change from the
          first to the last 10 % of the recording; drag to highlight cells.
        </p>
      }
      footer={
        <Show when={props.data()}>
          <span>
            {props.data()!.drift.length} cells · y: {yLabel()}
          </span>
        </Show>
      }
    >
      <Show when={props.data()} fallback={<div class="ov-empty">No baseline estimate</div>}>
        <div class="ov-split">
          <div class="ov-hist ov-split__main" ref={host}>
            <svg
              class="ov-svg"
              width={W()}
              height={H()}
              role="img"
              aria-label="population baseline"
            >
              <For each={labeledTicks(y(), 3)}>
                {(t) => (
                  <>
                    <line class="ov-grid" x1={M.l} x2={W() - M.r} y1={y()(t.v)} y2={y()(t.v)} />
                    <text class="ov-tick" x={M.l - 4} y={y()(t.v) + 3} text-anchor="end">
                      {t.label}
                    </text>
                  </>
                )}
              </For>
              <path class="ov-band" d={band()} />
              <path class="ov-line" d={path(props.data()!.median)} />
              <line class="ov-axis" x1={M.l} x2={W() - M.r} y1={H() - M.b} y2={H() - M.b} />
              <For each={labeledTicks(x(), tickTarget(W() - M.l - M.r))}>
                {(t) => (
                  <text class="ov-tick" x={x()(t.v)} y={H() - M.b + 11} text-anchor="middle">
                    {t.label}
                  </text>
                )}
              </For>
              <text
                class="ov-axis-label"
                x={(M.l + W() - M.r) / 2}
                y={H() - 2}
                text-anchor="middle"
              >
                time (s)
              </text>
            </svg>
          </div>
          <div class="ov-split__side">
            <BrushHistogram
              values={() => props.data()!.drift}
              binCount={14}
              markers={() => [{ x: ratio() ? 1 : 0, dashed: true }]}
              highlighted={props.highlighted}
              onBrush={props.onBrush}
              xLabel={driftLabel()}
              ariaLabel="baseline change histogram"
            />
          </div>
        </div>
      </Show>
    </OverviewCard>
  );
}
