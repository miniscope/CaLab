/**
 * CaDecon community scatter plot: tau_rise (x) vs tau_decay (y) with median_pve color coding.
 * Uses uPlot mode:2 with a custom paths draw function for per-point coloring.
 * Optionally overlays the user's current run parameters as a larger marker.
 */

import { createEffect, createMemo, on, onCleanup } from 'solid-js';
import type { CadeconSubmission } from '../../lib/community/index.ts';
import { median } from '../../lib/math-utils.ts';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import uPlot from 'uplot';
import { getThemeColors } from '@calab/ui/chart';

export interface ScatterPlotProps {
  submissions: CadeconSubmission[];
  userParams?: { tauRise: number; tauDecay: number } | null;
  highlightFlags?: boolean[] | null;
}

/** Map a PVE value (0–1) to a viridis-inspired HSLA color. */
function pveToColor(pve: number | null): string {
  if (pve == null) return 'hsla(200, 10%, 60%, 0.5)';
  const clamped = Math.max(0, Math.min(1, pve));
  // Viridis-inspired: purple (270) -> yellow (60)
  const h = 270 - clamped * 210;
  return `hsla(${h}, 80%, 55%, 0.7)`;
}

/** Pre-compute PVE color array for all submissions. */
function computePveColors(submissions: CadeconSubmission[]): string[] {
  return submissions.map((s) => pveToColor(s.median_pve));
}

export function ScatterPlot(props: ScatterPlotProps) {
  let containerRef: HTMLDivElement | undefined;
  let uplotInstance: uPlot | undefined;

  const pveColors = createMemo(() => computePveColors(props.submissions));

  const medianPoint = createMemo(() => {
    const subs = props.submissions;
    if (subs.length === 0) return null;
    return {
      x: median(subs.map((s) => s.tau_rise)),
      y: median(subs.map((s) => s.tau_decay)),
    };
  });

  const chartData = createMemo((): uPlot.AlignedData => {
    const subs = props.submissions;
    if (subs.length === 0) {
      return [
        [null] as unknown as number[],
        [[null] as unknown as number[], [null] as unknown as number[]] as unknown as number[],
      ];
    }
    const xs = subs.map((s) => s.tau_rise);
    const ys = subs.map((s) => s.tau_decay);
    return [xs, [xs, ys] as unknown as number[]];
  });

  function makeDrawPoints(
    colors: () => string[],
    userParams: () => ScatterPlotProps['userParams'],
    medianPt: () => { x: number; y: number } | null,
    highlightFlags: () => boolean[] | null,
    markerStroke: string,
    medianColor: string,
  ) {
    return (u: uPlot, seriesIdx: number, _idx0: number, _idx1: number) => {
      const ctx = u.ctx;
      const size = 10 * devicePixelRatio;

      uPlot.orient(
        u,
        seriesIdx,
        (_series, _dataX, _dataY, scaleX, scaleY, valToPosX, valToPosY, xOff, yOff, xDim, yDim) => {
          const d = u.data[seriesIdx] as unknown as number[][];
          if (!d || !d[0] || !d[1]) return;
          const xVals = d[0];
          const yVals = d[1];
          const cols = colors();

          const scaleValid =
            scaleX.min != null && scaleX.max != null && scaleY.min != null && scaleY.max != null;

          // Median crosshairs
          const mp = medianPt();
          if (mp && scaleValid) {
            const mcx = valToPosX(mp.x, scaleX, xDim, xOff);
            const mcy = valToPosY(mp.y, scaleY, yDim, yOff);

            ctx.save();
            ctx.strokeStyle = medianColor;
            ctx.lineWidth = 1 * devicePixelRatio;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(mcx, yOff);
            ctx.lineTo(mcx, yOff + yDim);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xOff, mcy);
            ctx.lineTo(xOff + xDim, mcy);
            ctx.stroke();
            ctx.restore();
          }

          // Community points
          const flags = highlightFlags();
          const highlighting = flags != null && flags.length > 0;

          for (let i = 0; i < xVals.length; i++) {
            const xVal = xVals[i];
            const yVal = yVals[i];
            if (xVal == null || yVal == null || !scaleValid) continue;
            if (xVal < scaleX.min! || xVal > scaleX.max!) continue;
            if (yVal < scaleY.min! || yVal > scaleY.max!) continue;

            const cx = valToPosX(xVal, scaleX, xDim, xOff);
            const cy = valToPosY(yVal, scaleY, yDim, yOff);
            const isOwned = highlighting && flags[i];

            ctx.globalAlpha = highlighting && !isOwned ? 0.25 : 1;
            ctx.fillStyle = cols[i] || 'hsla(200, 80%, 55%, 0.7)';
            const r = isOwned ? (size * 1.3) / 2 : size / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.fill();

            if (isOwned) {
              ctx.strokeStyle = markerStroke;
              ctx.lineWidth = 2 * devicePixelRatio;
              ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;

          // Median marker
          if (mp && scaleValid) {
            const mcx = valToPosX(mp.x, scaleX, xDim, xOff);
            const mcy = valToPosY(mp.y, scaleY, yDim, yOff);
            const mSize = 8 * devicePixelRatio;
            ctx.fillStyle = medianColor;
            ctx.strokeStyle = markerStroke;
            ctx.lineWidth = 1.5 * devicePixelRatio;
            ctx.beginPath();
            ctx.arc(mcx, mcy, mSize / 2, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
          }

          // User overlay marker
          const up = userParams();
          if (up) {
            const ux = up.tauRise;
            const uy = up.tauDecay;
            if (
              scaleValid &&
              ux >= scaleX.min! &&
              ux <= scaleX.max! &&
              uy >= scaleY.min! &&
              uy <= scaleY.max!
            ) {
              const ucx = valToPosX(ux, scaleX, xDim, xOff);
              const ucy = valToPosY(uy, scaleY, yDim, yOff);
              const uSize = 14 * devicePixelRatio;

              ctx.fillStyle = 'hsla(30, 100%, 55%, 0.9)'; // Orange marker for user's run
              ctx.strokeStyle = markerStroke;
              ctx.lineWidth = 2 * devicePixelRatio;
              ctx.beginPath();
              ctx.arc(ucx, ucy, uSize / 2, 0, 2 * Math.PI);
              ctx.fill();
              ctx.stroke();
            }
          }
        },
      );
      return null;
    };
  }

  createEffect(() => {
    const subs = props.submissions;
    const data = chartData();

    if (uplotInstance) {
      uplotInstance.destroy();
      uplotInstance = undefined;
    }

    if (!containerRef || subs.length === 0) return;

    const theme = getThemeColors();

    const drawFn = makeDrawPoints(
      pveColors,
      () => props.userParams,
      medianPoint,
      () => props.highlightFlags ?? null,
      theme.textPrimary,
      theme.textSecondary,
    );

    const xVals = subs.map((s) => s.tau_rise);
    const yVals = subs.map((s) => s.tau_decay);
    const up = props.userParams;
    if (up) {
      xVals.push(up.tauRise);
      yVals.push(up.tauDecay);
    }
    const xMin = Math.min(...xVals);
    const xMax = Math.max(...xVals);
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const xPad = (xMax - xMin) * 0.15 || xMin * 0.1;
    const yPad = (yMax - yMin) * 0.15 || yMin * 0.1;

    const opts: uPlot.Options = {
      mode: 2,
      width: containerRef.clientWidth || 500,
      height: 340,
      scales: {
        x: { time: false, range: [xMin - xPad, xMax + xPad] },
        y: { range: [yMin - yPad, yMax + yPad] },
      },
      series: [
        {},
        {
          label: 'Community',
          stroke: 'transparent',
          fill: 'transparent',
          paths: drawFn,
        },
      ],
      axes: [
        {
          label: 'tau_rise (s)',
          stroke: theme.textSecondary,
          grid: { stroke: theme.borderSubtle },
          ticks: { stroke: theme.borderDefault },
          size: 40,
          space: 80,
          values: (_u: uPlot, vals: number[]) => vals.map((v) => v.toFixed(4)),
        },
        {
          label: 'tau_decay (s)',
          stroke: theme.textSecondary,
          grid: { stroke: theme.borderSubtle },
          ticks: { stroke: theme.borderDefault },
          size: 60,
          space: 50,
          values: (_u: uPlot, vals: number[]) => vals.map((v) => v.toFixed(3)),
        },
      ],
      legend: { show: false },
    };

    uplotInstance = new uPlot(opts, data, containerRef);
  });

  createEffect(
    on(
      () => props.highlightFlags,
      () => {
        if (uplotInstance) uplotInstance.redraw();
      },
      { defer: true },
    ),
  );

  let resizeRaf: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (uplotInstance && containerRef) {
        const w = containerRef.clientWidth;
        if (w > 0) uplotInstance.setSize({ width: w, height: 340 });
      }
    });
  });

  createEffect(() => {
    if (containerRef) resizeObserver.observe(containerRef);
  });

  onCleanup(() => {
    resizeObserver.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (uplotInstance) {
      uplotInstance.destroy();
      uplotInstance = undefined;
    }
  });

  return (
    <div class="scatter-plot">
      {props.submissions.length === 0 ? (
        <div class="scatter-plot__empty">No community data yet</div>
      ) : (
        <>
          <div ref={containerRef} class="scatter-plot__canvas" />
          <PVELegend />
        </>
      )}
    </div>
  );
}

/** Color legend bar showing the PVE gradient (0 to 1). */
function PVELegend() {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const hue = 270 - t * 210;
      ctx.fillStyle = `hsla(${hue}, 80%, 55%, 0.9)`;
      ctx.fillRect(x, 0, 1, h);
    }
  });

  return (
    <div class="scatter-plot__legend">
      <span class="scatter-plot__legend-label">0</span>
      <canvas ref={canvasRef} width={200} height={12} class="scatter-plot__legend-bar" />
      <span class="scatter-plot__legend-label">1</span>
      <span class="scatter-plot__legend-title">median PVE</span>
    </div>
  );
}
