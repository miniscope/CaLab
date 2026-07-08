/**
 * Asymptote dashboard: small-multiples view of the four quantities that should
 * stabilize across iterations —
 *   1. kernel shape (peak time + FWHM)
 *   2. normalized bi-exponential fit quality of the free kernel (kernel-fit R²)
 *   3. reconstruction quality (median PVE)
 *   4. stability of the deconvolved activity traces (iteration-to-iteration Δ)
 *
 * All panels share the iteration x-axis, the convergence marker, and the
 * viewed-iteration marker so a reader can see everything settle together.
 */

import { createMemo, createEffect, For, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import {
  convergenceHistory,
  convergedAtIteration,
  type KernelSnapshot,
} from '../../lib/iteration-store.ts';
import { viewedIteration } from '../../lib/viz-store.ts';
import {
  wheelZoomPlugin,
  chartAxis,
  labeledAxis,
  integerTickValues,
  syncCursor,
  safeRange,
  METRIC_COLORS,
} from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

// Colorblind-safe Okabe-Ito metric colors (shared palette). t_peak and FWHM
// never appear as a red/green pair.
const TPEAK_COLOR = METRIC_COLORS.tPeak;
const FWHM_COLOR = METRIC_COLORS.fwhm;
const R2_COLOR = METRIC_COLORS.r2;
const PVE_COLOR = METRIC_COLORS.pve;
const STABILITY_COLOR = METRIC_COLORS.stability;

interface SeriesDef {
  label: string;
  color: string;
  pick: (s: KernelSnapshot) => number | null;
  scale?: number;
}

interface PanelDef {
  title: string;
  unit: string;
  series: SeriesDef[];
}

// Static panel descriptors — defined once so <For> never recreates the charts.
const PANELS: PanelDef[] = [
  {
    title: 'Kernel shape',
    unit: 'ms',
    series: [
      { label: 't_peak', color: TPEAK_COLOR, pick: (s) => s.tPeak, scale: 1000 },
      { label: 'FWHM', color: FWHM_COLOR, pick: (s) => s.fwhm, scale: 1000 },
    ],
  },
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
  {
    title: 'Activity stability',
    unit: 'Δ (norm.)',
    series: [{ label: 'trace Δ', color: STABILITY_COLOR, pick: (s) => s.traceStability }],
  },
];

// Degenerate-span guards (uPlot throws in drawAxesGrid on a zero span). Y pads
// 10%; X uses the exact iteration extent (the createEffect below drives the
// real x-scale — these are the fallbacks).
const yRange = safeRange(0.1);
const xRange = safeRange(0);

/** One compact trend chart; reads convergence history reactively. */
function MiniTrend(props: { panel: PanelDef }): JSX.Element {
  let uplot: uPlot | null = null;

  const history = createMemo(() => convergenceHistory().filter((s) => s.iteration > 0));

  const data = createMemo(() => {
    const h = history();
    const x = h.map((s) => s.iteration);
    const cols = props.panel.series.map((sd) =>
      h.map((s) => {
        const v = sd.pick(s);
        return v == null ? null : v * (sd.scale ?? 1);
      }),
    );
    return [x, ...cols] as uPlot.AlignedData;
  });

  // Keep the scales tracking the data. SolidUplot updates data without resetting
  // scales (to preserve zoom), so the x-scale would otherwise stay frozen at the
  // extent from an earlier iteration count. Recompute both scales from the data,
  // and redraw so the convergence / viewed-iteration markers stay in sync.
  createEffect(() => {
    const d = data();
    viewedIteration();
    convergedAtIteration();
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
    const [yLo, yHi] = isFinite(ymin) ? yRange(u, ymin, ymax) : [0, 1];
    u.batch(() => {
      u.setScale('x', { min: xmin, max: xmax });
      u.setScale('y', { min: yLo, max: yHi });
    });
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

  const cursor = syncCursor('cadecon-asymptote');

  return (
    <div class="asymptote-cell">
      <div class="asymptote-cell__title">
        <span>{props.panel.title}</span>
        <Show when={props.panel.series.length > 1}>
          <span class="asymptote-cell__legend">
            <For each={props.panel.series}>
              {(s) => (
                <span class="asymptote-cell__legend-item">
                  <span class="asymptote-cell__swatch" style={{ background: s.color }} />
                  {s.label}
                </span>
              )}
            </For>
          </span>
        </Show>
      </div>
      <SolidUplot
        data={data()}
        series={series}
        scales={{ x: { time: false, range: xRange }, y: { range: yRange } }}
        axes={axes}
        plugins={plugins}
        cursor={cursor}
        legend={{ show: false }}
        height={104}
        autoResize={true}
        onCreate={(u) => (uplot = u)}
      />
    </div>
  );
}

export function AsymptoteTrends(): JSX.Element {
  const hasData = createMemo(() => convergenceHistory().some((s) => s.iteration > 0));

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
        <For each={PANELS}>{(panel) => <MiniTrend panel={panel} />}</For>
      </div>
    </Show>
  );
}
