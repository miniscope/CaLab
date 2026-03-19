/**
 * Kernel convergence chart: shows tau_rise, tau_decay, tPeak, and FWHM
 * evolving over iterations. Uses uPlot with per-subset scatter and
 * convergence marker.
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
import { tauToShape } from '@calab/compute';
import { wheelZoomPlugin, AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

const TAU_RISE_COLOR = '#66bb6a'; // green
const TAU_DECAY_COLOR = '#ffa726'; // orange
const TPEAK_COLOR = '#42a5f5'; // blue
const FWHM_COLOR = '#ef5350'; // red
const BETA_FAST_COLOR = '#ab47bc'; // purple
const RESIDUAL_COLOR = '#9e9e9e';

const TAU_RISE_FAINT = 'rgba(102, 187, 106, 0.3)';
const TAU_DECAY_FAINT = 'rgba(255, 167, 38, 0.3)';
const TPEAK_FAINT = 'rgba(66, 165, 245, 0.3)';
const FWHM_FAINT = 'rgba(239, 83, 80, 0.3)';

/** Draw a single horizontal line at `yVal` on scale `'y'`. Caller must save/restore ctx. */
function drawHLine(ctx: CanvasRenderingContext2D, u: uPlot, yVal: number, color: string): void {
  ctx.strokeStyle = color;
  const yPx = u.valToPos(yVal, 'y', true);
  ctx.beginPath();
  ctx.moveTo(u.bbox.left, yPx);
  ctx.lineTo(u.bbox.left + u.bbox.width, yPx);
  ctx.stroke();
}

interface GroundTruthValues {
  tauRiseMs: number;
  tauDecayMs: number;
  tPeakMs: number;
  fwhmMs: number;
}

/** Series indices for visibility checks in plugins. */
const SI_TAU_RISE = 1;
const SI_TAU_DECAY = 2;
const SI_TPEAK = 3;
const SI_FWHM = 4;

/** Plugin that draws horizontal dashed lines at ground truth values. */
function groundTruthPlugin(gtValues: () => GroundTruthValues | null): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const gt = gtValues();
        if (!gt) return;

        const dpr = devicePixelRatio;
        const ctx = u.ctx;
        ctx.save();
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);

        if (u.series[SI_TAU_RISE].show) drawHLine(ctx, u, gt.tauRiseMs, TAU_RISE_COLOR);
        if (u.series[SI_TAU_DECAY].show) drawHLine(ctx, u, gt.tauDecayMs, TAU_DECAY_COLOR);
        if (u.series[SI_TPEAK].show) drawHLine(ctx, u, gt.tPeakMs, TPEAK_COLOR);
        if (u.series[SI_FWHM].show) drawHLine(ctx, u, gt.fwhmMs, FWHM_COLOR);

        ctx.restore();
      },
    },
  };
}

/** Pre-converted subset scatter data to avoid tauToShape calls in the draw hook. */
interface SubsetScatterPoint {
  iteration: number;
  tauRiseMs: number;
  tauDecayMs: number;
  tPeakMs: number;
  fwhmMs: number;
}

/** Plugin that draws faint per-subset scatter circles behind the main lines. */
function subsetScatterPlugin(points: () => SubsetScatterPoint[]): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const pts = points();
        if (pts.length === 0) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const r = 4 * dpr;

        const showTauR = u.series[SI_TAU_RISE].show;
        const showTauD = u.series[SI_TAU_DECAY].show;
        const showTPeak = u.series[SI_TPEAK].show;
        const showFwhm = u.series[SI_FWHM].show;

        for (const pt of pts) {
          const xPx = u.valToPos(pt.iteration, 'x', true);

          if (showTauR) {
            ctx.fillStyle = TAU_RISE_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(pt.tauRiseMs, 'y', true), r, 0, 2 * Math.PI);
            ctx.fill();
          }

          if (showTauD) {
            ctx.fillStyle = TAU_DECAY_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(pt.tauDecayMs, 'y', true), r, 0, 2 * Math.PI);
            ctx.fill();
          }

          if (showTPeak) {
            ctx.fillStyle = TPEAK_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(pt.tPeakMs, 'y', true), r, 0, 2 * Math.PI);
            ctx.fill();
          }

          if (showFwhm) {
            ctx.fillStyle = FWHM_FAINT;
            ctx.beginPath();
            ctx.arc(xPx, u.valToPos(pt.fwhmMs, 'y', true), r, 0, 2 * Math.PI);
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

  // Pre-compute ground truth values so the draw hook does zero tauToShape calls.
  const gtValues = createMemo((): GroundTruthValues | null => {
    if (!groundTruthVisible() || !isDemo()) return null;
    const gtTauR = groundTruthTauRise();
    const gtTauD = groundTruthTauDecay();
    if (gtTauR == null || gtTauD == null) return null;
    const shape = tauToShape(gtTauR, gtTauD);
    if (!shape) return null;
    return {
      tauRiseMs: gtTauR * 1000,
      tauDecayMs: gtTauD * 1000,
      tPeakMs: shape.tPeak * 1000,
      fwhmMs: shape.fwhm * 1000,
    };
  });

  // Single pass: build both aligned chart data and subset scatter points.
  const convergenceData = createMemo(() => {
    const h = filteredHistory();
    if (h.length === 0)
      return {
        aligned: [[], [], [], [], [], [], []] as uPlot.AlignedData,
        scatter: [] as SubsetScatterPoint[],
      };

    const iterations: number[] = new Array(h.length);
    const tauRises: number[] = new Array(h.length);
    const tauDecays: number[] = new Array(h.length);
    const tPeaks: number[] = new Array(h.length);
    const fwhms: number[] = new Array(h.length);
    const residuals: number[] = new Array(h.length);
    const betaFasts: number[] = new Array(h.length);
    const pts: SubsetScatterPoint[] = [];

    for (let i = 0; i < h.length; i++) {
      const s = h[i];
      iterations[i] = s.iteration;
      tauRises[i] = s.tauRise * 1000;
      tauDecays[i] = s.tauDecay * 1000;
      const shape = tauToShape(s.tauRise, s.tauDecay);
      tPeaks[i] = shape ? shape.tPeak * 1000 : 0;
      fwhms[i] = shape ? shape.fwhm * 1000 : 0;
      residuals[i] = s.residual;
      betaFasts[i] = s.betaFast;

      if (s.subsets) {
        for (const sub of s.subsets) {
          const subShape = tauToShape(sub.tauRise, sub.tauDecay);
          pts.push({
            iteration: s.iteration,
            tauRiseMs: sub.tauRise * 1000,
            tauDecayMs: sub.tauDecay * 1000,
            tPeakMs: subShape ? subShape.tPeak * 1000 : 0,
            fwhmMs: subShape ? subShape.fwhm * 1000 : 0,
          });
        }
      }
    }

    return {
      aligned: [
        iterations,
        tauRises,
        tauDecays,
        tPeaks,
        fwhms,
        residuals,
        betaFasts,
      ] as uPlot.AlignedData,
      scatter: pts,
    };
  });

  const series: uPlot.Series[] = [
    {},
    {
      label: 'τ_rise',
      stroke: TAU_RISE_COLOR,
      width: 2,
      points: { show: true, size: 6 },
    },
    {
      label: 'τ_decay',
      stroke: TAU_DECAY_COLOR,
      width: 2,
      points: { show: true, size: 6 },
    },
    {
      label: 't_peak',
      stroke: TPEAK_COLOR,
      width: 2,
      points: { show: true, size: 6 },
    },
    {
      label: 'FWHM',
      stroke: FWHM_COLOR,
      width: 2,
      points: { show: true, size: 6 },
    },
    {
      label: 'residual',
      stroke: RESIDUAL_COLOR,
      width: 1,
      scale: 'res',
      dash: [4, 2],
    },
    {
      label: 'β_fast',
      stroke: BETA_FAST_COLOR,
      width: 1,
      scale: 'res',
      dash: [4, 2],
      show: false,
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
    subsetScatterPlugin(() => convergenceData().scatter),
    groundTruthPlugin(gtValues),
    convergenceMarkerPlugin(() => convergedAtIteration()),
    viewedIterationPlugin(() => viewedIteration()),
    wheelZoomPlugin(),
  ];

  const cursor: uPlot.Cursor = {
    sync: { key: 'cadecon-convergence', setSeries: true },
  };

  return (
    <Show
      when={convergenceData().aligned[0].length > 0}
      fallback={
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          <span>Run deconvolution to see kernel convergence.</span>
        </div>
      }
    >
      <div class="kernel-chart-wrapper">
        <SolidUplot
          data={convergenceData().aligned}
          series={series}
          scales={scales}
          axes={axes}
          plugins={plugins}
          cursor={cursor}
          legend={{ show: true }}
          height={160}
          autoResize={true}
          onCreate={setUplotRef}
        />
      </div>
    </Show>
  );
}
