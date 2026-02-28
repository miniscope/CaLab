/**
 * Kernel convergence chart: shows tau_rise and tau_decay evolving over iterations.
 * Uses uPlot with per-subset scatter and convergence marker.
 */

import { createMemo, createSignal, createEffect, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import { convergenceHistory, convergedAtIteration } from '../../lib/iteration-store.ts';
import { viewedIteration } from '../../lib/viz-store.ts';
import {
  groundTruthVisible,
  isDemo,
  groundTruthTauRise,
  groundTruthTauDecay,
} from '../../lib/data-store.ts';
import { wheelZoomPlugin, AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

const TAU_RISE_COLOR = '#42a5f5';
const TAU_DECAY_COLOR = '#ef5350';
const RESIDUAL_COLOR = '#9e9e9e';
const TAU_RISE_FAINT = 'rgba(66, 165, 245, 0.3)';
const TAU_DECAY_FAINT = 'rgba(239, 83, 80, 0.3)';

/** Draw a single horizontal line at `yVal` on scale `'y'`. Caller must save/restore ctx. */
function drawHLine(ctx: CanvasRenderingContext2D, u: uPlot, yVal: number, color: string): void {
  ctx.strokeStyle = color;
  const yPx = u.valToPos(yVal, 'y', true);
  ctx.beginPath();
  ctx.moveTo(u.bbox.left, yPx);
  ctx.lineTo(u.bbox.left + u.bbox.width, yPx);
  ctx.stroke();
}

/** Plugin that draws horizontal dashed lines at ground truth tau_rise (blue) and tau_decay (red). */
function groundTruthPlugin(): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        if (!groundTruthVisible() || !isDemo()) return;
        const gtTauR = groundTruthTauRise();
        const gtTauD = groundTruthTauDecay();
        if (gtTauR == null && gtTauD == null) return;

        const dpr = devicePixelRatio;
        const ctx = u.ctx;
        ctx.save();
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);

        if (gtTauR != null) drawHLine(ctx, u, gtTauR * 1000, TAU_RISE_COLOR);
        if (gtTauD != null) drawHLine(ctx, u, gtTauD * 1000, TAU_DECAY_COLOR);

        ctx.restore();
      },
    },
  };
}

/** Plugin that draws faint per-subset scatter circles behind the main lines. */
function subsetScatterPlugin(): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const history = convergenceHistory();
        if (history.length === 0) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;

        for (const snap of history) {
          if (!snap.subsets) continue;
          const xPx = u.valToPos(snap.iteration, 'x', true);

          for (const sub of snap.subsets) {
            // tau rise scatter
            ctx.fillStyle = TAU_RISE_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(sub.tauRise * 1000, 'y', true), 4 * dpr, 0, 2 * Math.PI);
            ctx.fill();

            // tau decay scatter
            ctx.fillStyle = TAU_DECAY_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(sub.tauDecay * 1000, 'y', true), 4 * dpr, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
      },
    },
  };
}

export function KernelConvergence(): JSX.Element {
  const [uplotRef, setUplotRef] = createSignal<uPlot | null>(null);

  // Redraw when viewedIteration or ground truth visibility changes so overlay markers update
  createEffect(() => {
    viewedIteration(); // track
    groundTruthVisible(); // track
    uplotRef()?.redraw();
  });

  const filteredHistory = createMemo(() => convergenceHistory().filter((s) => s.iteration > 0));

  const chartData = createMemo((): uPlot.AlignedData => {
    const h = filteredHistory();
    if (h.length === 0) return [[], [], [], []];
    return [
      h.map((s) => s.iteration),
      h.map((s) => s.tauRise * 1000),
      h.map((s) => s.tauDecay * 1000),
      h.map((s) => s.residual),
    ];
  });

  const series: uPlot.Series[] = [
    {},
    { label: 'tau rise (ms)', stroke: TAU_RISE_COLOR, width: 2, points: { show: true, size: 6 } },
    { label: 'tau decay (ms)', stroke: TAU_DECAY_COLOR, width: 2, points: { show: true, size: 6 } },
    {
      label: 'residual',
      stroke: RESIDUAL_COLOR,
      width: 1,
      scale: 'res',
      dash: [4, 2],
    },
  ];

  const scales: uPlot.Scales = {
    x: { time: false },
    y: {},
    res: {},
  };

  const axes: uPlot.Axis[] = [
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'Iteration',
      labelSize: 10,
      labelFont: '10px sans-serif',
      values: (_u: uPlot, splits: number[]) =>
        splits.map((v) => (Number.isInteger(v) ? String(v) : '')),
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'ms',
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
    {
      stroke: RESIDUAL_COLOR,
      scale: 'res',
      side: 1,
      grid: { show: false },
      ticks: { stroke: AXIS_TICK },
      label: 'Residual',
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
  ];

  const plugins = [
    subsetScatterPlugin(),
    groundTruthPlugin(),
    convergenceMarkerPlugin(() => convergedAtIteration()),
    viewedIterationPlugin(() => viewedIteration()),
    wheelZoomPlugin(),
  ];

  const cursor: uPlot.Cursor = {
    sync: { key: 'cadecon-convergence', setSeries: true },
  };

  return (
    <Show
      when={filteredHistory().length > 0}
      fallback={
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          <span>Run deconvolution to see kernel convergence.</span>
        </div>
      }
    >
      <div class="kernel-chart-wrapper">
        <SolidUplot
          data={chartData()}
          series={series}
          scales={scales}
          axes={axes}
          plugins={plugins}
          cursor={cursor}
          height={160}
          autoResize={true}
          onCreate={setUplotRef}
        />
      </div>
    </Show>
  );
}
