/**
 * Subset variance chart: grouped bars showing per-subset tau_rise and tau_decay,
 * with horizontal dashed lines at the merged median values.
 */

import { createMemo, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import { subsetVarianceData, currentTauRise, currentTauDecay } from '../../lib/iteration-store.ts';
import { AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '@calab/ui/chart';

const TAU_RISE_COLOR = '#42a5f5';
const TAU_DECAY_COLOR = '#ef5350';

/** Plugin that draws horizontal dashed lines at merged median values. */
function medianLinesPlugin(
  getMergedTauR: () => number | null,
  getMergedTauD: () => number | null,
): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { left, width } = u.bbox;

        ctx.save();
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);

        const tauR = getMergedTauR();
        if (tauR != null) {
          const y = u.valToPos(tauR * 1000, 'y', true);
          ctx.strokeStyle = TAU_RISE_COLOR;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(left + width, y);
          ctx.stroke();
        }

        const tauD = getMergedTauD();
        if (tauD != null) {
          const y = u.valToPos(tauD * 1000, 'y', true);
          ctx.strokeStyle = TAU_DECAY_COLOR;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(left + width, y);
          ctx.stroke();
        }

        ctx.restore();
      },
    },
  };
}

export function SubsetVariance(): JSX.Element {
  const chartData = createMemo((): uPlot.AlignedData => {
    const data = subsetVarianceData();
    if (data.length === 0) return [[], [], []];
    return [data.map((d) => d.subsetIdx), data.map((d) => d.tauRise), data.map((d) => d.tauDecay)];
  });

  const barPlugin = createMemo(() =>
    medianLinesPlugin(
      () => currentTauRise(),
      () => currentTauDecay(),
    ),
  );

  const series: uPlot.Series[] = [
    {},
    {
      label: 'tau rise (ms)',
      stroke: TAU_RISE_COLOR,
      fill: 'rgba(66, 165, 245, 0.3)',
      width: 1,
      paths: (u: uPlot, sidx: number) => {
        const xdata = u.data[0];
        const ydata = u.data[sidx];
        const p = new Path2D();
        for (let i = 0; i < xdata.length; i++) {
          const v = ydata[i];
          if (v == null) continue;
          // Offset bars slightly left for grouped effect
          const xL = u.valToPos(xdata[i] - 0.2, 'x', true);
          const xR = u.valToPos(xdata[i] + 0.05, 'x', true);
          const y0 = u.valToPos(0, 'y', true);
          const y1 = u.valToPos(v as number, 'y', true);
          p.rect(xL, y1, xR - xL, y0 - y1);
        }
        return { stroke: p, fill: p, clip: undefined, flags: 0 };
      },
    },
    {
      label: 'tau decay (ms)',
      stroke: TAU_DECAY_COLOR,
      fill: 'rgba(239, 83, 80, 0.3)',
      width: 1,
      paths: (u: uPlot, sidx: number) => {
        const xdata = u.data[0];
        const ydata = u.data[sidx];
        const p = new Path2D();
        for (let i = 0; i < xdata.length; i++) {
          const v = ydata[i];
          if (v == null) continue;
          // Offset bars slightly right for grouped effect
          const xL = u.valToPos(xdata[i] - 0.05, 'x', true);
          const xR = u.valToPos(xdata[i] + 0.2, 'x', true);
          const y0 = u.valToPos(0, 'y', true);
          const y1 = u.valToPos(v as number, 'y', true);
          p.rect(xL, y1, xR - xL, y0 - y1);
        }
        return { stroke: p, fill: p, clip: undefined, flags: 0 };
      },
    },
  ];

  const axes: uPlot.Axis[] = [
    {
      stroke: AXIS_TEXT,
      grid: { show: false },
      ticks: { stroke: AXIS_TICK },
      label: 'Subset',
      labelSize: 10,
      labelFont: '10px sans-serif',
      size: 24,
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'ms',
      labelSize: 10,
      labelFont: '10px sans-serif',
      size: 35,
    },
  ];

  const scales: uPlot.Scales = { x: { time: false } };
  const cursor: uPlot.Cursor = { drag: { x: false, y: false } };

  return (
    <div class="histogram-card">
      <div class="histogram-card__title">Subset Variance</div>
      <Show
        when={subsetVarianceData().length > 0}
        fallback={<div class="histogram-card__empty">No data</div>}
      >
        <div class="histogram-card__chart">
          <SolidUplot
            data={chartData()}
            series={series}
            scales={scales}
            axes={axes}
            cursor={cursor}
            plugins={[barPlugin()]}
            height={80}
            autoResize={true}
          />
        </div>
      </Show>
    </div>
  );
}
