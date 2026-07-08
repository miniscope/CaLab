/**
 * Asymptote dashboard: small-multiples view of the four quantities that should
 * stabilize across iterations —
 *   1. kernel shape (peak time + FWHM)
 *   2. normalized bi-exponential fit quality of the free kernel (kernel-fit R²)
 *   3. reconstruction quality (median PVE)
 *   4. stability of the deconvolved activity traces (iteration-to-iteration Δ)
 *
 * All panels share the iteration x-axis, the convergence marker, the
 * viewed-iteration marker, and the cursor-sync group with the other convergence
 * charts, so a reader can see everything settle together.
 */

import { createMemo, createEffect, For, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import { convergenceHistory, convergedAtIteration, type KernelSnapshot } from '../../lib/iteration-store.ts';
import { viewedIteration } from '../../lib/viz-store.ts';
import { wheelZoomPlugin, AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

const TPEAK_COLOR = '#42a5f5'; // blue
const FWHM_COLOR = '#ef5350'; // red
const R2_COLOR = '#26a69a'; // teal
const PVE_COLOR = '#66bb6a'; // green
const STABILITY_COLOR = '#ab47bc'; // purple

interface MiniSeries {
  label: string;
  color: string;
  values: (number | null)[];
}

interface MiniPanel {
  title: string;
  unit: string;
  series: MiniSeries[];
}

/** One compact trend chart sharing the convergence x-axis and markers. */
function MiniTrend(props: { iterations: number[]; panel: MiniPanel }): JSX.Element {
  let uplot: uPlot | null = null;

  // Redraw so the convergence / viewed-iteration markers follow store changes.
  createEffect(() => {
    viewedIteration();
    convergedAtIteration();
    uplot?.redraw();
  });

  const data = createMemo(
    () => [props.iterations, ...props.panel.series.map((s) => s.values)] as uPlot.AlignedData,
  );

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
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'Iteration',
      labelSize: 10,
      labelFont: '10px sans-serif',
      values: (_u, splits) => splits.map((v) => (Number.isInteger(v) ? String(v) : '')),
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: props.panel.unit,
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
  ];

  const plugins = [
    convergenceMarkerPlugin(() => convergedAtIteration()),
    viewedIterationPlugin(() => viewedIteration()),
    wheelZoomPlugin(),
  ];

  const cursor: uPlot.Cursor = { sync: { key: 'cadecon-convergence', setSeries: true } };

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
        scales={{ x: { time: false }, y: {} }}
        axes={axes}
        plugins={plugins}
        cursor={cursor}
        legend={{ show: false }}
        height={120}
        autoResize={true}
        onCreate={(u) => (uplot = u)}
      />
    </div>
  );
}

export function AsymptoteTrends(): JSX.Element {
  const history = createMemo(() => convergenceHistory().filter((s) => s.iteration > 0));

  const iterations = createMemo(() => history().map((s) => s.iteration));

  const panels = createMemo((): MiniPanel[] => {
    const h = history();
    const col = (pick: (s: KernelSnapshot) => number | null, scale = 1): (number | null)[] =>
      h.map((s) => {
        const v = pick(s);
        return v == null ? null : v * scale;
      });
    return [
      {
        title: 'Kernel shape',
        unit: 'ms',
        series: [
          { label: 't_peak', color: TPEAK_COLOR, values: col((s) => s.tPeak, 1000) },
          { label: 'FWHM', color: FWHM_COLOR, values: col((s) => s.fwhm, 1000) },
        ],
      },
      {
        title: 'Kernel fit R²',
        unit: 'R²',
        series: [{ label: 'kernel fit R²', color: R2_COLOR, values: col((s) => s.kernelFitR2) }],
      },
      {
        title: 'Reconstruction (PVE)',
        unit: 'PVE',
        series: [{ label: 'median PVE', color: PVE_COLOR, values: col((s) => s.medianPve) }],
      },
      {
        title: 'Activity stability',
        unit: 'Δ (norm.)',
        series: [
          { label: 'trace Δ', color: STABILITY_COLOR, values: col((s) => s.traceStability) },
        ],
      },
    ];
  });

  return (
    <Show
      when={history().length > 0}
      fallback={
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          <span>Run deconvolution to see the asymptote dashboard.</span>
        </div>
      }
    >
      <div class="asymptote-grid">
        <For each={panels()}>{(panel) => <MiniTrend iterations={iterations()} panel={panel} />}</For>
      </div>
    </Show>
  );
}
