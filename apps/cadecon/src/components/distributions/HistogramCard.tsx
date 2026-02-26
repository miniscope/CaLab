/**
 * Reusable histogram card: binned bar chart with summary stats.
 * Updates live as values change reactively.
 */

import { createMemo, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import { withOpacity } from '../../lib/chart/series-config.ts';
import { AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '../../lib/chart/theme-colors.ts';
import { median, iqr } from '../../lib/math-utils.ts';

export interface HistogramCardProps {
  title: string;
  values: () => number[];
  binCount?: number;
  xLabel?: string;
  color?: string;
}

function computeBins(values: number[], binCount: number): { centers: number[]; counts: number[] } {
  if (values.length === 0) return { centers: [], counts: [] };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / binCount;

  const counts = new Array(binCount).fill(0);
  const centers = new Array(binCount);

  for (let i = 0; i < binCount; i++) {
    centers[i] = min + (i + 0.5) * binWidth;
  }

  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= binCount) idx = binCount - 1;
    counts[idx]++;
  }

  return { centers, counts };
}

export function HistogramCard(props: HistogramCardProps): JSX.Element {
  const color = () => props.color ?? '#1f77b4';
  const bins = () => props.binCount ?? 15;

  const binData = createMemo(() => computeBins(props.values(), bins()));

  const chartData = createMemo((): uPlot.AlignedData => {
    const { centers, counts } = binData();
    if (centers.length === 0) return [[], []];
    return [centers, counts];
  });

  const barWidth = createMemo(() => {
    const { centers } = binData();
    if (centers.length < 2) return 1;
    return (centers[1] - centers[0]) * 0.85;
  });

  const series = createMemo((): uPlot.Series[] => {
    const c = color();
    return [
      {},
      {
        label: props.title,
        stroke: c,
        fill: withOpacity(c, 0.3),
        width: 1,
        paths: (u: uPlot, sidx: number) => {
          const xdata = u.data[0];
          const ydata = u.data[sidx];
          const p = new Path2D();
          const halfW = barWidth() / 2;
          for (let i = 0; i < xdata.length; i++) {
            const v = ydata[i];
            if (v == null || v === 0) continue;
            const xL = u.valToPos(xdata[i] - halfW, 'x', true);
            const xR = u.valToPos(xdata[i] + halfW, 'x', true);
            const y0 = u.valToPos(0, 'y', true);
            const y1 = u.valToPos(v as number, 'y', true);
            p.rect(xL, y1, xR - xL, y0 - y1);
          }
          return { stroke: p, fill: p, clip: undefined, flags: 0 };
        },
      },
    ];
  });

  const axes: uPlot.Axis[] = [
    {
      stroke: AXIS_TEXT,
      grid: { show: false },
      ticks: { stroke: AXIS_TICK },
      size: 24,
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      size: 30,
    },
  ];

  const scales: uPlot.Scales = { x: { time: false } };
  const cursor: uPlot.Cursor = { drag: { x: false, y: false } };

  const medVal = createMemo(() => median(props.values()));
  const iqrVal = createMemo(() => iqr(props.values()));

  return (
    <div class="histogram-card">
      <div class="histogram-card__title">{props.title}</div>
      <Show
        when={props.values().length > 0}
        fallback={<div class="histogram-card__empty">No data</div>}
      >
        <div class="histogram-card__chart">
          <SolidUplot
            data={chartData()}
            series={series()}
            scales={scales}
            axes={axes}
            cursor={cursor}
            height={80}
            autoResize={true}
          />
        </div>
        <div class="histogram-card__stats">
          <span>Median: {medVal().toFixed(3)}</span>
          <span>
            IQR: [{iqrVal()[0].toFixed(3)}, {iqrVal()[1].toFixed(3)}]
          </span>
          <span>N: {props.values().length}</span>
        </div>
      </Show>
    </div>
  );
}
