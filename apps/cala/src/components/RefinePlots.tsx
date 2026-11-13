/**
 * The Refine plots of the Run panel (docs/stages.md, "Refine plots"):
 *
 * - **This run** (`RefineRunPlot`): the current or last Refine run over its
 *   replay, in the History's `HistoryPlot` (refines per minute, footprint
 *   change median and 90th percentile at each publish, share of cells refined
 *   so far). Declared ranges, as every History series.
 * - **Across runs** (`RefineRunsChart`): refines per minute (Discover, then
 *   each Refine run) and the median footprint change per Refine run, two
 *   small plots with one y axis each, anchored at 0 (a 1/2/5 top that only
 *   grows), so convergence across runs is visible at a glance. The settled
 *   hint sits under it.
 */
import { createMemo, For, Show, type JSX } from 'solid-js';
import { HistoryPlot } from '@calab/ui/chart';
import {
  REFINE_SERIES_KEYS,
  refineHistory,
  runComparison,
  type RefineSample,
  type RunPoint,
} from '../lib/refine-metrics.ts';
import type { StageRun } from '../lib/run-stages.ts';

export function RefineRunPlot(props: {
  series: { samples: readonly RefineSample[]; end: number };
  /** The run is still going (a "now" line at the newest sample). */
  live: boolean;
  label: string;
  height?: number;
}): JSX.Element {
  const history = createMemo(() => refineHistory(props.series.samples, props.series.end));
  const now = () =>
    props.live ? (props.series.samples.at(-1)?.t ?? 0) : Math.max(props.series.end, 1);
  return (
    <div class="cala-refine-plot" data-testid="refine-run-plot">
      <span class="cala-muted cala-refine-plot__title">{props.label}</span>
      <HistoryPlot
        history={history}
        keys={REFINE_SERIES_KEYS}
        window={() => ({ t0: 0, t1: Math.max(props.series.end, 1) })}
        now={now}
        runEnd={() => Math.max(props.series.end, 1)}
        tick={() => props.series.samples.length}
        height={props.height ?? 90}
        compact
        label={props.label}
        testid="refine-history"
      />
    </div>
  );
}

const W = 150;
const H = 70;
const PAD_L = 30;
const PAD_R = 6;
const PAD_T = 6;
const PAD_B = 16;

function fmt(v: number, digits: number): string {
  return v.toFixed(digits);
}

/** One measure per run: dots joined by a line, y from 0 to `top`. */
function RunDots(props: {
  points: RunPoint[];
  value: (p: RunPoint) => number | null;
  top: number;
  digits: number;
  title: string;
  unit: string;
  color: string;
  testid: string;
}): JSX.Element {
  const n = () => Math.max(props.points.length, 2);
  const x = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * (i + 0.5)) / n();
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - Math.min(v, props.top) / props.top);
  const path = () => {
    let d = '';
    props.points.forEach((p, i) => {
      const v = props.value(p);
      if (v === null) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };
  return (
    <figure class="cala-refine-runs__plot" data-testid={props.testid}>
      <figcaption class="cala-muted">{props.title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${props.title}: ${props.points
          .map((p) => {
            const v = props.value(p);
            return `${p.label === 'D' ? 'Discover' : `Refine ${p.label}`} ${v === null ? 'none' : fmt(v, props.digits)}`;
          })
          .join(', ')}`}
      >
        <line class="cala-refine-runs__grid" x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} />
        <line
          class="cala-refine-runs__grid"
          x1={PAD_L}
          x2={W - PAD_R}
          y1={y(props.top)}
          y2={y(props.top)}
        />
        <text class="cala-refine-runs__tick" x={PAD_L - 3} y={y(0) + 3} text-anchor="end">
          0
        </text>
        <text class="cala-refine-runs__tick" x={PAD_L - 3} y={y(props.top) + 3} text-anchor="end">
          {fmt(props.top, props.top < 1 ? 2 : 0)}
        </text>
        <path d={path()} fill="none" stroke={props.color} stroke-width="2" />
        <For each={props.points}>
          {(p, i) => {
            const v = () => props.value(p);
            return (
              <>
                <Show when={v() !== null}>
                  <circle
                    cx={x(i())}
                    cy={y(v()!)}
                    r={4}
                    fill={p.outcome === 'done' ? props.color : 'var(--bg-primary, #fff)'}
                    stroke={props.color}
                    stroke-width="2"
                  >
                    <title>
                      {`${p.label === 'D' ? 'Discover' : `Refine ${p.label}`}${p.outcome === 'done' ? '' : ` (${p.outcome})`}: ${fmt(v()!, props.digits)}${props.unit}`}
                    </title>
                  </circle>
                </Show>
                <text class="cala-refine-runs__tick" x={x(i())} y={H - 4} text-anchor="middle">
                  {p.label}
                </text>
              </>
            );
          }}
        </For>
      </svg>
    </figure>
  );
}

/** Refines per minute and median footprint change, per run (Discover, Refine 1, 2, ...). */
export function RefineRunsChart(props: { runs: readonly StageRun[] }): JSX.Element {
  const cmp = createMemo(() => runComparison(props.runs));
  return (
    <Show when={cmp().points.some((p) => p.stage === 'refine')}>
      <div class="cala-refine-runs" data-testid="refine-runs-chart">
        <RunDots
          points={cmp().points}
          value={(p) => p.refinesPerMin}
          top={cmp().rateTop}
          digits={1}
          title="Refines per minute, by run"
          unit="/min"
          color="#0072b2"
          testid="refine-runs-rate"
        />
        <RunDots
          points={cmp().points}
          value={(p) => p.medianChange}
          top={cmp().changeTop}
          digits={3}
          title="Median footprint change, by run"
          unit=""
          color="#e69f00"
          testid="refine-runs-change"
        />
      </div>
    </Show>
  );
}
