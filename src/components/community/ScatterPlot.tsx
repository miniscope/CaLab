/**
 * Community scatter plot: tau_rise (x) vs tau_decay (y) with lambda color coding.
 * Uses uPlot mode:2 with a custom paths draw function for per-point coloring.
 * Optionally overlays the user's current parameters as a larger marker.
 */

import { createEffect, createMemo, onCleanup } from 'solid-js';
import type { CommunitySubmission } from '../../lib/community/types';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import uPlot from 'uplot';

/** Read CSS custom property values from :root for uPlot programmatic styling. */
function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim() || undefined;
  return {
    textPrimary:   v('--text-primary')   ?? '#1a1a1a',
    textSecondary: v('--text-secondary') ?? '#616161',
    borderSubtle:  v('--border-subtle')  ?? '#e8e8e8',
    borderDefault: v('--border-default') ?? '#d4d4d4',
  };
}

export interface ScatterPlotProps {
  submissions: CommunitySubmission[];
  userParams?: { tauRise: number; tauDecay: number; lambda: number } | null;
}

/** Map a lambda value to a viridis-inspired HSLA color on a log scale. */
function lambdaToColor(
  lambda: number,
  minL: number,
  maxL: number,
): string {
  const logMin = Math.log10(minL);
  const logMax = Math.log10(maxL);
  const range = logMax - logMin;
  const t =
    range === 0 ? 0.5 : (Math.log10(lambda) - logMin) / range;
  const clamped = Math.max(0, Math.min(1, t));
  // Viridis-inspired: purple (270) -> yellow (60)
  const h = 270 - clamped * 210;
  return `hsla(${h}, 80%, 55%, 0.7)`;
}

/** Pre-compute lambda color array for all submissions. */
function computeLambdaColors(submissions: CommunitySubmission[]): string[] {
  if (submissions.length === 0) return [];
  const lambdas = submissions.map((s) => s.lambda);
  const minL = Math.min(...lambdas);
  const maxL = Math.max(...lambdas);
  return lambdas.map((l) => lambdaToColor(l, minL, maxL));
}

export function ScatterPlot(props: ScatterPlotProps) {
  let containerRef: HTMLDivElement | undefined;
  let uplotInstance: uPlot | undefined;

  const lambdaColors = createMemo(() =>
    computeLambdaColors(props.submissions),
  );

  const lambdaRange = createMemo(() => {
    if (props.submissions.length === 0) return { min: 0, max: 1 };
    const lambdas = props.submissions.map((s) => s.lambda);
    return { min: Math.min(...lambdas), max: Math.max(...lambdas) };
  });

  /** Build mode:2 data: [[x0,x1,...],[y0,y1,...]] per series facet. */
  const chartData = createMemo((): uPlot.AlignedData => {
    const subs = props.submissions;
    if (subs.length === 0) {
      return [
        [null] as unknown as number[],
        [
          [null] as unknown as number[],
          [null] as unknown as number[],
        ] as unknown as number[],
      ];
    }
    const xs = subs.map((s) => s.tau_rise);
    const ys = subs.map((s) => s.tau_decay);
    // mode:2 data format: [xValues, [xFacetValues, yFacetValues]]
    return [xs, [xs, ys] as unknown as number[]];
  });

  /** Create custom paths draw function for colored scatter points. */
  function makeDrawPoints(colors: () => string[], userParams: () => ScatterPlotProps['userParams'], markerStroke: string) {
    return (u: uPlot, seriesIdx: number, _idx0: number, _idx1: number) => {
      const ctx = u.ctx;
      const size = 10 * devicePixelRatio;

      uPlot.orient(
        u,
        seriesIdx,
        (
          _series, _dataX, _dataY, scaleX, scaleY,
          valToPosX, valToPosY, xOff, yOff,
          xDim, yDim,
        ) => {
          const d = u.data[seriesIdx] as unknown as number[][];
          if (!d || !d[0] || !d[1]) return;
          const xVals = d[0];
          const yVals = d[1];
          const cols = colors();

          // Draw community points
          for (let i = 0; i < xVals.length; i++) {
            const xVal = xVals[i];
            const yVal = yVals[i];
            if (
              xVal == null || yVal == null ||
              scaleX.min == null || scaleX.max == null ||
              scaleY.min == null || scaleY.max == null
            ) continue;
            if (xVal < scaleX.min || xVal > scaleX.max) continue;
            if (yVal < scaleY.min || yVal > scaleY.max) continue;

            const cx = valToPosX(xVal, scaleX, xDim, xOff);
            const cy = valToPosY(yVal, scaleY, yDim, yOff);
            ctx.fillStyle = cols[i] || 'hsla(200, 80%, 55%, 0.7)';
            ctx.beginPath();
            ctx.arc(cx, cy, size / 2, 0, 2 * Math.PI);
            ctx.fill();
          }

          // Draw user parameter marker on top if provided
          const up = userParams();
          if (up) {
            const ux = up.tauRise;
            const uy = up.tauDecay;
            if (
              scaleX.min != null && scaleX.max != null &&
              scaleY.min != null && scaleY.max != null &&
              ux >= scaleX.min && ux <= scaleX.max &&
              uy >= scaleY.min && uy <= scaleY.max
            ) {
              const ucx = valToPosX(ux, scaleX, xDim, xOff);
              const ucy = valToPosY(uy, scaleY, yDim, yOff);
              const uSize = 14 * devicePixelRatio;

              ctx.fillStyle = lambdaToColor(
                up.lambda,
                lambdaRange().min || up.lambda,
                lambdaRange().max || up.lambda,
              );
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

    // Destroy previous instance
    if (uplotInstance) {
      uplotInstance.destroy();
      uplotInstance = undefined;
    }

    if (!containerRef || subs.length === 0) return;

    // Read CSS custom properties for theme-aware colors
    const theme = getThemeColors();

    const drawFn = makeDrawPoints(lambdaColors, () => props.userParams, theme.textPrimary);

    // Compute padded ranges so points aren't on the edge
    const xVals = subs.map((s) => s.tau_rise);
    const yVals = subs.map((s) => s.tau_decay);
    const up = props.userParams;
    if (up) { xVals.push(up.tauRise); yVals.push(up.tauDecay); }
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

  // ResizeObserver: resize chart when sidebar opens/closes
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
          <div
            ref={containerRef}
            class="scatter-plot__canvas"
          />
          <LambdaLegend
            min={lambdaRange().min}
            max={lambdaRange().max}
          />
        </>
      )}
    </div>
  );
}

/** Color legend bar showing the lambda gradient. */
function LambdaLegend(props: { min: number; max: number }) {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw gradient bar
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const hue = 270 - t * 210;
      ctx.fillStyle = `hsla(${hue}, 80%, 55%, 0.9)`;
      ctx.fillRect(x, 0, 1, h);
    }
  });

  const formatVal = (v: number) => {
    if (v >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
  };

  return (
    <div class="scatter-plot__legend">
      <span class="scatter-plot__legend-label">{formatVal(props.min)}</span>
      <canvas
        ref={canvasRef}
        width={200}
        height={12}
        class="scatter-plot__legend-bar"
      />
      <span class="scatter-plot__legend-label">{formatVal(props.max)}</span>
      <span class="scatter-plot__legend-title">&lambda;</span>
    </div>
  );
}
