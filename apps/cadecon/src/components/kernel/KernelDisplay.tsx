/**
 * Kernel display: shows per-subset h_free curves and merged bi-exp fit.
 * Replaces the old DebugKernelChart canvas component.
 */

import { createMemo, Show, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '@calab/ui/chart/chart-theme.css';
import { convergenceHistory, currentTauRise, currentTauDecay } from '../../lib/iteration-store.ts';
import { viewedIteration } from '../../lib/viz-store.ts';
import { samplingRate } from '../../lib/data-store.ts';
import { selectedSubsetIdx } from '../../lib/subset-store.ts';
import { createKernelFitSeries } from '../../lib/chart/series-config.ts';
import { D3_CATEGORY10, withOpacity } from '@calab/ui/chart';
import { wheelZoomPlugin, AXIS_TEXT, AXIS_GRID, AXIS_TICK } from '@calab/ui/chart';

export function KernelDisplay(): JSX.Element {
  const snapshot = createMemo(() => {
    const history = convergenceHistory();
    if (history.length === 0) return null;
    const viewIter = viewedIteration();
    if (viewIter != null) {
      return history.find((s) => s.iteration === viewIter) ?? history[history.length - 1];
    }
    return history[history.length - 1];
  });

  const chartData = createMemo((): uPlot.AlignedData => {
    const snap = snapshot();
    if (!snap || snap.subsets.length === 0) return [[]];

    const fs = samplingRate() ?? snap.fs;
    const tauR = snap.tauRise;
    const tauD = snap.tauDecay;
    const beta = snap.beta;

    // Find the max kernel length across subsets
    const maxLen = Math.max(...snap.subsets.map((s) => s.hFree.length));
    if (maxLen === 0) return [[]];

    // X-axis in ms
    const xAxis = new Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      xAxis[i] = (i / fs) * 1000;
    }

    // Per-subset h_free arrays (padded with null)
    const subsetArrays: (number | null)[][] = snap.subsets.map((s) => {
      const arr: (number | null)[] = new Array(maxLen).fill(null);
      for (let i = 0; i < s.hFree.length; i++) {
        arr[i] = s.hFree[i];
      }
      return arr;
    });

    // Fitted bi-exp from merged params
    const fitArray = new Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      const t = i / fs;
      fitArray[i] = beta * (Math.exp(-t / tauD) - Math.exp(-t / tauR));
    }

    return [xAxis, ...subsetArrays, fitArray] as uPlot.AlignedData;
  });

  const series = createMemo((): uPlot.Series[] => {
    const snap = snapshot();
    if (!snap) return [{}];
    const selected = selectedSubsetIdx();
    const s: uPlot.Series[] = [{}];
    for (let i = 0; i < snap.subsets.length; i++) {
      const color = D3_CATEGORY10[i % D3_CATEGORY10.length];
      const isSelected = selected === i;
      const hasSelection = selected != null;
      s.push({
        label: `Subset ${i}`,
        stroke: withOpacity(color, hasSelection ? (isSelected ? 1.0 : 0.15) : 0.4),
        width: isSelected ? 2.5 : 1,
      });
    }
    s.push(createKernelFitSeries());
    return s;
  });

  const axes: uPlot.Axis[] = [
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
      label: 'Time (ms)',
      labelSize: 10,
      labelFont: '10px sans-serif',
    },
    {
      stroke: AXIS_TEXT,
      grid: { stroke: AXIS_GRID },
      ticks: { stroke: AXIS_TICK },
    },
  ];

  const scales: uPlot.Scales = { x: { time: false } };
  const plugins = [wheelZoomPlugin()];
  const cursor: uPlot.Cursor = { sync: { key: 'cadecon-kernel', setSeries: true } };

  const tauRMs = () => {
    const v = currentTauRise();
    return v != null ? (v * 1000).toFixed(1) : '--';
  };
  const tauDMs = () => {
    const v = currentTauDecay();
    return v != null ? (v * 1000).toFixed(1) : '--';
  };

  return (
    <Show
      when={snapshot() != null}
      fallback={
        <div class="kernel-display__empty">
          <span>No kernel data yet.</span>
        </div>
      }
    >
      <div class="kernel-display">
        <div class="kernel-display__stats">
          <span>
            tau_r: <strong>{tauRMs()}</strong> ms
          </span>
          <span>
            tau_d: <strong>{tauDMs()}</strong> ms
          </span>
          <span>
            beta: <strong>{snapshot()?.beta.toFixed(3) ?? '--'}</strong>
          </span>
        </div>
        <SolidUplot
          data={chartData()}
          series={series()}
          scales={scales}
          axes={axes}
          plugins={plugins}
          cursor={cursor}
          height={200}
          autoResize={true}
        />
      </div>
    </Show>
  );
}
