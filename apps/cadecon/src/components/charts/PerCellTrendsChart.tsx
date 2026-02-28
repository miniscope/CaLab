/**
 * Shared per-cell×subset trends chart used by AlphaTrends and ThresholdTrends.
 * Displays faint individual cell lines, median + IQR band,
 * highlights the inspected cell and selected subset.
 */

import { createMemo, createSignal, createEffect, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import {
  iterationHistory,
  convergedAtIteration,
  type IterationHistoryEntry,
  type TraceResultEntry,
} from '../../lib/iteration-store.ts';
import { inspectedCellIndex, viewedIteration } from '../../lib/viz-store.ts';
import { selectedSubsetIdx } from '../../lib/subset-store.ts';
import {
  wheelZoomPlugin,
  D3_CATEGORY10,
  withOpacity,
  AXIS_TEXT,
  AXIS_GRID,
  AXIS_TICK,
} from '@calab/ui/chart';
import { convergenceMarkerPlugin } from '../../lib/chart/convergence-marker-plugin.ts';
import { viewedIterationPlugin } from '../../lib/chart/viewed-iteration-plugin.ts';

const IQR_FILL = 'rgba(31, 119, 180, 0.08)';
const Q_COLOR = 'rgba(31, 119, 180, 0.3)';

export interface TrendsData {
  iterations: number[];
  perKey: Map<string, (number | null)[]>;
  median: number[];
  q25: number[];
  q75: number[];
  yMin: number;
  yMax: number;
}

/** Extract a numeric field from TraceResultEntry history into TrendsData. */
export function deriveTrendsData(
  history: IterationHistoryEntry[],
  accessor: (entry: TraceResultEntry) => number,
): TrendsData {
  if (history.length === 0) {
    return {
      iterations: [],
      perKey: new Map(),
      median: [],
      q25: [],
      q75: [],
      yMin: 0,
      yMax: 1,
    };
  }

  const keySet = new Set<string>();
  for (const entry of history) {
    for (const key of Object.keys(entry.results)) {
      // Exclude stitched entries (subsetIdx=-1) — only per-subset keys for trends
      if (!key.endsWith(':-1')) keySet.add(key);
    }
  }
  const keys = [...keySet].sort();

  const iterations = history.map((h) => h.iteration);
  const perKey = new Map<string, (number | null)[]>();
  const median: number[] = [];
  const q25: number[] = [];
  const q75: number[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;

  for (const key of keys) {
    perKey.set(key, []);
  }

  for (let i = 0; i < history.length; i++) {
    const results = history[i].results;
    const values: number[] = [];

    for (const key of keys) {
      const entry = results[key];
      const val = entry != null ? accessor(entry) : null;
      perKey.get(key)!.push(val);
      if (val != null) {
        values.push(val);
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
    }

    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median.push(sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
      q25.push(sorted[Math.floor(sorted.length * 0.25)]);
      q75.push(sorted[Math.floor(sorted.length * 0.75)]);
    } else {
      median.push(0);
      q25.push(0);
      q75.push(0);
    }
  }

  if (!isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }

  return { iterations, perKey, median, q25, q75, yMin, yMax };
}

function cellFromKey(key: string): number {
  return parseInt(key.split(':')[0], 10);
}

function subsetFromKey(key: string): number {
  return parseInt(key.split(':')[1], 10);
}

/** Plugin that draws faint per-cell×subset lines with inspected cell + selected subset highlights. */
function cellLinesPlugin(
  getData: () => TrendsData,
  getInspected: () => number | null,
  getSelectedSubset: () => number | null,
): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const data = getData();
        if (data.iterations.length === 0) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const inspected = getInspected();
        const selSubset = getSelectedSubset();

        // Pass 1: faint background lines (skip inspected cell and selected subset)
        for (const [key, values] of data.perKey) {
          const cellIdx = cellFromKey(key);
          const subIdx = subsetFromKey(key);
          if (cellIdx === inspected) continue;
          if (selSubset != null && subIdx === selSubset) continue;

          const color = D3_CATEGORY10[cellIdx % D3_CATEGORY10.length];
          ctx.strokeStyle = withOpacity(color, 0.12);
          ctx.lineWidth = dpr;
          drawLine(ctx, u, data.iterations, values);
        }

        // Pass 2: selected subset lines at medium opacity
        if (selSubset != null) {
          for (const [key, values] of data.perKey) {
            const cellIdx = cellFromKey(key);
            const subIdx = subsetFromKey(key);
            if (subIdx !== selSubset) continue;
            if (cellIdx === inspected) continue; // inspected drawn last

            const color = D3_CATEGORY10[cellIdx % D3_CATEGORY10.length];
            ctx.strokeStyle = withOpacity(color, 0.55);
            ctx.lineWidth = 1.5 * dpr;
            drawLine(ctx, u, data.iterations, values);
          }
        }

        // Pass 3: inspected cell on top at full opacity
        if (inspected != null) {
          for (const [key, values] of data.perKey) {
            const cellIdx = cellFromKey(key);
            if (cellIdx !== inspected) continue;
            const subIdx = subsetFromKey(key);

            const color = D3_CATEGORY10[cellIdx % D3_CATEGORY10.length];
            // Inspected+selected subset: thickest; inspected+other: bold
            const isSelSub = selSubset != null && subIdx === selSubset;
            ctx.strokeStyle = withOpacity(color, isSelSub ? 1.0 : 0.7);
            ctx.lineWidth = (isSelSub ? 2.5 : 1.5) * dpr;
            drawLine(ctx, u, data.iterations, values);
          }
        }
      },
    },
  };
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  u: uPlot,
  iterations: number[],
  values: (number | null)[],
): void {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < iterations.length; i++) {
    const v = values[i];
    if (v == null) {
      started = false;
      continue;
    }
    const x = u.valToPos(iterations[i], 'x', true);
    const y = u.valToPos(v, 'y', true);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

/** Plugin that fills the IQR band between Q25 and Q75. */
function iqrBandPlugin(getData: () => TrendsData): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const data = getData();
        if (data.iterations.length < 2) return;

        const ctx = u.ctx;
        ctx.fillStyle = IQR_FILL;
        ctx.beginPath();

        for (let i = 0; i < data.iterations.length; i++) {
          const x = u.valToPos(data.iterations[i], 'x', true);
          const y = u.valToPos(data.q75[i], 'y', true);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = data.iterations.length - 1; i >= 0; i--) {
          const x = u.valToPos(data.iterations[i], 'x', true);
          const y = u.valToPos(data.q25[i], 'y', true);
          ctx.lineTo(x, y);
        }

        ctx.closePath();
        ctx.fill();
      },
    },
  };
}

// --- Public component ---

export interface PerCellTrendsChartProps {
  /** Field accessor to extract the value from each TraceResultEntry. */
  accessor: (entry: TraceResultEntry) => number;
  /** Y-axis label (e.g. "Alpha", "Threshold"). */
  yLabel: string;
  /** Median series label (e.g. "Median Alpha"). */
  medianLabel: string;
  /** Color for median line. */
  medianColor: string;
  /** Fallback message when no data. */
  emptyMessage: string;
}

export function PerCellTrendsChart(props: PerCellTrendsChartProps): JSX.Element {
  const [uplotRef, setUplotRef] = createSignal<uPlot | null>(null);

  const trendsData = createMemo(() => {
    const history = iterationHistory().filter((h) => h.iteration > 0);
    return deriveTrendsData(history, props.accessor);
  });

  // Redraw when overlay state changes
  createEffect(() => {
    viewedIteration();
    inspectedCellIndex();
    selectedSubsetIdx();
    uplotRef()?.redraw();
  });

  const chartData = createMemo((): uPlot.AlignedData => {
    const d = trendsData();
    if (d.iterations.length === 0) return [[], [], [], []];
    return [d.iterations, d.median, d.q25, d.q75];
  });

  const series: uPlot.Series[] = [
    {},
    {
      label: props.medianLabel,
      stroke: props.medianColor,
      width: 2,
      points: { show: true, size: 5 },
    },
    { label: 'Q25', stroke: Q_COLOR, width: 1, dash: [4, 2], show: false },
    { label: 'Q75', stroke: Q_COLOR, width: 1, dash: [4, 2], show: false },
  ];

  const scales = createMemo((): uPlot.Scales => {
    const d = trendsData();
    const pad = (d.yMax - d.yMin) * 0.05 || 0.1;
    return {
      x: { time: false },
      y: { range: [d.yMin - pad, d.yMax + pad] },
    };
  });

  const axes: uPlot.Axis[] = [
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'Iteration',
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: props.yLabel,
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
  ];

  const plugins = [
    iqrBandPlugin(trendsData),
    cellLinesPlugin(trendsData, inspectedCellIndex, selectedSubsetIdx),
    convergenceMarkerPlugin(convergedAtIteration),
    viewedIterationPlugin(viewedIteration),
    wheelZoomPlugin(),
  ];

  const cursor: uPlot.Cursor = {
    sync: { key: 'cadecon-convergence', setSeries: true },
  };

  return (
    <Show
      when={iterationHistory().length > 0}
      fallback={
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          <span>{props.emptyMessage}</span>
        </div>
      }
    >
      <div class="kernel-chart-wrapper">
        <SolidUplot
          data={chartData()}
          series={series}
          scales={scales()}
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
