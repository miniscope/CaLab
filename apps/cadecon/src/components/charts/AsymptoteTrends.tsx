/**
 * Asymptote dashboard: small-multiples view of the quantities that should
 * stabilize across iterations, laid out as two rows:
 *   Top — the convergence signals (decay toward 0, log-y):
 *     1. kernel-shape change (peak-normalized RMSE vs the previous iteration) —
 *        the actual convergence metric, with the tolerance band drawn in
 *     2. deconvolved-activity change vs the previous iteration — it trails the
 *        kernel by ~1 iteration (spikes are inferred from the prior kernel), so
 *        its marker shows both the gate iteration and where activity settles
 *   Bottom — the fit-quality signals (rise toward a plateau, linear):
 *     3. normalized bi-exponential fit quality of the free kernel (kernel-fit R²)
 *     4. reconstruction quality (median PVE)
 *
 * All panels share the iteration x-axis and cursor. The raw kernel parameters
 * (τ_rise, τ_decay, t_peak, FWHM) live on the Kernel tab.
 */

import { createMemo, createEffect, For, Show, type JSX, type Accessor } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import {
  convergenceHistory,
  convergedAtIteration,
  type KernelSnapshot,
} from '../../lib/iteration-store.ts';
import { convergenceTol, convergencePatience } from '../../lib/algorithm-store.ts';
import { viewedIteration } from '../../lib/viz-store.ts';
import {
  wheelZoomPlugin,
  chartAxis,
  labeledAxis,
  integerTickValues,
  syncCursor,
  safeRange,
  METRIC_COLORS,
  withOpacity,
} from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { drawVerticalMarker } from '../../lib/chart/vertical-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

// Colorblind-safe Okabe-Ito metric colors (shared palette).
const RMSE_COLOR = METRIC_COLORS.tPeak;
const STABILITY_COLOR = METRIC_COLORS.stability;
const R2_COLOR = METRIC_COLORS.r2;
const PVE_COLOR = METRIC_COLORS.pve;
/** Convergence green — matches the vertical convergence marker. */
const CONVERGED_COLOR = '#4caf50';
const CONVERGED_LABEL = '#388e3c';
/**
 * Iterations by which activity trails the kernel: spikes at iteration k are
 * inferred from iteration k−1's kernel, so activity settles exactly one
 * iteration after the kernel-RMSE gate fires.
 */
const ACTIVITY_LAG_ITERS = 1;

type HistoryAccessor = Accessor<KernelSnapshot[]>;

interface SeriesDef {
  label: string;
  color: string;
  pick: (s: KernelSnapshot) => number | null;
}

interface PanelDef {
  title: string;
  unit: string;
  series: SeriesDef[];
}

// Linear plateau panels (bottom row). The two decay signals are dedicated log-y
// panels rendered directly in AsymptoteTrends.
const PANELS: PanelDef[] = [
  {
    title: 'Kernel fit R²',
    unit: 'R²',
    series: [{ label: 'kernel fit R²', color: R2_COLOR, pick: (s) => s.kernelFitR2 }],
  },
  {
    title: 'Reconstruction (PVE)',
    unit: 'PVE',
    series: [{ label: 'median PVE', color: PVE_COLOR, pick: (s) => s.medianPve }],
  },
];

// Degenerate-span guards (uPlot throws in drawAxesGrid on a zero span). Y pads
// 10%; X uses the exact iteration extent (TrendChart's effect drives the real
// x-scale — these are the fallbacks).
const yRange = safeRange(0.1);
const xRange = safeRange(0);

/** Positive log-y range fallback (used only before the reactive effect sets the scale). */
function logYRangeFallback(_u: uPlot, dataMin: number, dataMax: number): [number, number] {
  const lo = dataMin > 0 && isFinite(dataMin) ? dataMin / 10 : 1e-4;
  const hi = dataMax > 0 && isFinite(dataMax) ? dataMax * 1.5 : 1e-1;
  return [Math.max(1e-6, lo), Math.max(hi, lo * 10)];
}

/** Compact log-axis tick formatter (e.g. 0.1, 0.01, 1e-3). */
function logAxisValues(_u: uPlot, splits: number[]): (string | null)[] {
  return (splits ?? []).map((v) => {
    if (v <= 0) return '';
    const rounded = Number(v.toPrecision(1));
    return rounded >= 0.001 ? String(rounded) : rounded.toExponential(0);
  });
}

/**
 * Shade the "within tolerance" region (RMSE below convTol) and draw the
 * threshold line. Reactive to the convTol parameter via `getTol`.
 */
function toleranceBandPlugin(getTol: () => number): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const tol = getTol();
        if (!tol || !isFinite(tol)) return;
        const yMin = u.scales.y.min;
        const yMax = u.scales.y.max;
        if (yMin == null || yMax == null) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { left, width, top, height } = u.bbox;
        const bottom = top + height;
        const tolClamped = Math.min(Math.max(tol, yMin), yMax);
        const yTol = u.valToPos(tolClamped, 'y', true);

        ctx.save();
        ctx.fillStyle = withOpacity(CONVERGED_COLOR, 0.1);
        ctx.fillRect(left, yTol, width, bottom - yTol);
        ctx.strokeStyle = CONVERGED_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(left, yTol);
        ctx.lineTo(left + width, yTol);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `${9 * dpr}px sans-serif`;
        ctx.fillStyle = CONVERGED_COLOR;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`tol ${tol.toFixed(3)}`, left + width - 2 * dpr, yTol - 2 * dpr);
        ctx.restore();
      },
    },
  };
}

/** Faintly shade the iteration span [a, b] (in x-scale units). */
function shadeIterSpan(u: uPlot, a: number, b: number, fill: string): void {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null) return;
  const lo = Math.max(a, xMin);
  const hi = Math.min(b, xMax);
  if (hi < lo) return;
  const ctx = u.ctx;
  const { top, height } = u.bbox;
  const xa = u.valToPos(lo, 'x', true);
  const xb = u.valToPos(hi, 'x', true);
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(xa, top, Math.max(xb - xa, 1), height);
  ctx.restore();
}

/**
 * Highlight the `patience` consecutive in-band iterations that triggered
 * convergence — [convergedAt, convergedAt + patience − 1].
 */
function patienceBandPlugin(
  getConvergedAt: () => number | null,
  getPatience: () => number,
): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const c = getConvergedAt();
        if (c == null) return;
        const p = Math.max(1, getPatience());
        shadeIterSpan(u, c, c + p - 1, withOpacity(CONVERGED_COLOR, 0.08));
      },
    },
  };
}

/**
 * Convergence marker for the activity panel. Because activity trails the kernel
 * by ACTIVITY_LAG_ITERS (spikes are inferred from the previous iteration's
 * kernel), this draws the gate iteration where the kernel converged AND a fainter
 * marker where the activity actually settles, with the lag shaded between them —
 * so it's clear the gate fired a step before activity flattens.
 */
function laggedActivityMarkerPlugin(getConvergedAt: () => number | null): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const c = getConvergedAt();
        if (c == null) return;
        const cLag = c + ACTIVITY_LAG_ITERS;
        shadeIterSpan(u, c, cLag, withOpacity(CONVERGED_COLOR, 0.08));
        drawVerticalMarker(u, c, {
          stroke: CONVERGED_COLOR,
          labelColor: CONVERGED_LABEL,
          label: 'gate',
          dash: [4, 3],
        });
        drawVerticalMarker(u, cLag, {
          stroke: withOpacity(CONVERGED_COLOR, 0.5),
          labelColor: withOpacity(CONVERGED_LABEL, 0.8),
          label: `settles +${ACTIVITY_LAG_ITERS}`,
          dash: [4, 3],
        });
      },
    },
  };
}

/**
 * Shared compact trend chart: owns the uPlot ref, cursor, cell markup, and the
 * x-scale sync. Callers supply the data, series/axes/scales/plugins, and a
 * y-range computed from the data (log or linear). `track` names extra reactive
 * signals that should force a redraw (e.g. viewed iteration, convergence marker).
 */
function TrendChart(props: {
  title: string;
  data: Accessor<uPlot.AlignedData>;
  series: uPlot.Series[];
  axes: uPlot.Axis[];
  scales: uPlot.Scales;
  plugins: uPlot.Plugin[];
  computeYRange: (data: uPlot.AlignedData, u: uPlot) => [number, number];
  track?: () => void;
}): JSX.Element {
  let uplot: uPlot | null = null;

  // SolidUplot preserves scales across data updates (to keep zoom), so recompute
  // both scales from the data and redraw so markers/bands stay in sync.
  createEffect(() => {
    const d = props.data();
    props.track?.();
    const u = uplot;
    if (!u) return;
    const xs = d[0];
    if (xs.length === 0) {
      u.redraw();
      return;
    }
    let xmin = xs[0];
    let xmax = xs[xs.length - 1];
    if (xmin === xmax) {
      xmin -= 0.5;
      xmax += 0.5;
    }
    const [yLo, yHi] = props.computeYRange(d, u);
    u.batch(() => {
      u.setScale('x', { min: xmin, max: xmax });
      u.setScale('y', { min: yLo, max: yHi });
    });
  });

  const cursor = syncCursor('cadecon-asymptote');

  return (
    <div class="asymptote-cell">
      <div class="asymptote-cell__title">
        <span>{props.title}</span>
      </div>
      <SolidUplot
        data={props.data()}
        series={props.series}
        scales={props.scales}
        axes={props.axes}
        plugins={props.plugins}
        cursor={cursor}
        legend={{ show: false }}
        height={104}
        autoResize={true}
        onCreate={(u) => (uplot = u)}
      />
    </div>
  );
}

/** A log-y "decay toward 0" panel (kernel RMSE, activity change). */
function LogDecayTrend(props: {
  history: HistoryAccessor;
  title: string;
  unit: string;
  seriesLabel: string;
  color: string;
  pick: (s: KernelSnapshot) => number | null;
  includeTolInRange?: boolean;
  extraPlugins: uPlot.Plugin[];
}): JSX.Element {
  const data = createMemo(() => {
    const h = props.history();
    const x = h.map((s) => s.iteration);
    // Non-positive values are invalid on a log axis; drop them to gaps.
    const y = h.map((s) => {
      const v = props.pick(s);
      return v != null && v > 0 ? v : null;
    });
    return [x, y] as uPlot.AlignedData;
  });

  const series: uPlot.Series[] = [
    {},
    { label: props.seriesLabel, stroke: props.color, width: 2, points: { show: true, size: 5 } },
  ];
  const axes: uPlot.Axis[] = [
    chartAxis({ size: 24, values: integerTickValues }),
    labeledAxis(props.unit, { size: 44, values: logAxisValues }),
  ];
  const plugins = [
    ...props.extraPlugins,
    viewedIterationPlugin(() => viewedIteration()),
    wheelZoomPlugin(),
  ];

  const computeYRange = (d: uPlot.AlignedData): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of d[1] as (number | null)[]) {
      if (v != null && isFinite(v) && v > 0) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (props.includeTolInRange) {
      const tol = convergenceTol();
      if (isFinite(tol) && tol > 0) {
        lo = Math.min(lo, tol);
        hi = Math.max(hi, tol);
      }
    }
    return isFinite(lo) ? [Math.max(1e-6, lo / 10), hi * 1.5] : [1e-4, 1e-1];
  };

  return (
    <TrendChart
      title={props.title}
      data={data}
      series={series}
      axes={axes}
      scales={{ x: { time: false, range: xRange }, y: { distr: 3, range: logYRangeFallback } }}
      plugins={plugins}
      computeYRange={computeYRange}
      track={() => {
        viewedIteration();
        convergedAtIteration();
        convergencePatience();
      }}
    />
  );
}

/** A linear "rise toward a plateau" panel (R², PVE). */
function MiniTrend(props: { history: HistoryAccessor; panel: PanelDef }): JSX.Element {
  const data = createMemo(() => {
    const h = props.history();
    const x = h.map((s) => s.iteration);
    const cols = props.panel.series.map((sd) => h.map((s) => sd.pick(s)));
    return [x, ...cols] as uPlot.AlignedData;
  });

  const series: uPlot.Series[] = [
    {},
    ...props.panel.series.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: 2,
      points: { show: true, size: 5 },
    })),
  ];
  const axes: uPlot.Axis[] = [
    chartAxis({ size: 24, values: integerTickValues }),
    labeledAxis(props.panel.unit, { size: 38 }),
  ];
  const plugins = [
    convergenceMarkerPlugin(() => convergedAtIteration()),
    viewedIterationPlugin(() => viewedIteration()),
    wheelZoomPlugin(),
  ];

  const computeYRange = (d: uPlot.AlignedData, u: uPlot): [number, number] => {
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let si = 1; si < d.length; si++) {
      for (const v of d[si]) {
        if (v != null && isFinite(v)) {
          if (v < ymin) ymin = v;
          if (v > ymax) ymax = v;
        }
      }
    }
    return isFinite(ymin) ? yRange(u, ymin, ymax) : [0, 1];
  };

  return (
    <TrendChart
      title={props.panel.title}
      data={data}
      series={series}
      axes={axes}
      scales={{ x: { time: false, range: xRange }, y: { range: yRange } }}
      plugins={plugins}
      computeYRange={computeYRange}
      track={() => {
        viewedIteration();
        convergedAtIteration();
      }}
    />
  );
}

export function AsymptoteTrends(): JSX.Element {
  const history = createMemo(() => convergenceHistory().filter((s) => s.iteration > 0));
  const hasData = createMemo(() => history().length > 0);

  const kernelPlugins = [
    toleranceBandPlugin(() => convergenceTol()),
    patienceBandPlugin(
      () => convergedAtIteration(),
      () => convergencePatience(),
    ),
    convergenceMarkerPlugin(() => convergedAtIteration()),
  ];
  const activityPlugins = [laggedActivityMarkerPlugin(() => convergedAtIteration())];

  return (
    <Show
      when={hasData()}
      fallback={
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          <span>Run deconvolution to see the asymptote dashboard.</span>
        </div>
      }
    >
      <div class="asymptote-grid">
        <LogDecayTrend
          history={history}
          title="Kernel change (RMSE)"
          unit="frac. peak"
          seriesLabel="kernel RMSE"
          color={RMSE_COLOR}
          pick={(s) => s.kernelRmse}
          includeTolInRange
          extraPlugins={kernelPlugins}
        />
        <LogDecayTrend
          history={history}
          title="Activity change"
          unit="rel. Δ"
          seriesLabel="trace Δ"
          color={STABILITY_COLOR}
          pick={(s) => s.traceStability}
          extraPlugins={activityPlugins}
        />
        <For each={PANELS}>{(panel) => <MiniTrend history={history} panel={panel} />}</For>
      </div>
    </Show>
  );
}
