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
import {
  samplingRate,
  groundTruthVisible,
  isDemo,
  groundTruthTauRise,
  groundTruthTauDecay,
} from '../../lib/data-store.ts';
import { selectedSubsetIdx } from '../../lib/subset-store.ts';
import {
  createKernelFitSeries,
  createDirectBiexpFitSeries,
  createGroundTruthKernelSeries,
  peakNormalize,
} from '../../lib/chart/series-config.ts';
import {
  D3_CATEGORY10,
  withOpacity,
  wheelZoomPlugin,
  AXIS_TEXT,
  AXIS_GRID,
  AXIS_TICK,
} from '@calab/ui/chart';

/** Format a tau value in seconds to a display string in ms, or a fallback. */
function formatTauMs(tau: number | null, fallback: string = '--'): string {
  return tau != null ? (tau * 1000).toFixed(1) : fallback;
}

export function KernelDisplay(): JSX.Element {
  /** Whether ground truth overlay should be shown on this chart. */
  const showGroundTruth = createMemo(
    () => groundTruthVisible() && isDemo() && groundTruthTauRise() != null,
  );

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

    // Find the max kernel length across subsets. In direct-biexp mode hFree
    // is empty, so fall back to a display length derived from the fit taus.
    let maxLen = Math.max(...snap.subsets.map((s) => s.hFree.length));
    if (maxLen === 0) {
      maxLen = Math.max(10, Math.ceil(5 * tauD * fs));
    }

    // X-axis in ms
    const xAxis = new Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      xAxis[i] = (i / fs) * 1000;
    }

    // Per-subset h_free arrays (peak-normalized, padded with null).
    // When hFree is empty (direct-biexp mode), fill with null so series count matches.
    const subsetArrays: (number | null)[][] = snap.subsets.map((s) => {
      if (s.hFree.length === 0) {
        return new Array(maxLen).fill(null);
      }
      const raw = s.hFree.slice();
      peakNormalize(raw);
      const arr: (number | null)[] = new Array(maxLen).fill(null);
      for (let i = 0; i < raw.length; i++) {
        arr[i] = raw[i];
      }
      return arr;
    });

    // Fitted bi-exp from merged params (peak-normalized)
    const fitArray = new Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      const t = i / fs;
      fitArray[i] = beta * (Math.exp(-t / tauD) - Math.exp(-t / tauR));
    }
    peakNormalize(fitArray);

    // Direct biexp fit curve (always present for series stability; null-filled when not hybrid)
    const directTauR = snap.directTauRise;
    const directTauD = snap.directTauDecay;
    let directFitArray: (number | null)[];
    if (directTauR != null && directTauD != null) {
      directFitArray = new Array(maxLen);
      for (let i = 0; i < maxLen; i++) {
        const t = i / fs;
        directFitArray[i] = Math.exp(-t / directTauD) - Math.exp(-t / directTauR);
      }
      peakNormalize(directFitArray as number[]);
    } else {
      directFitArray = new Array(maxLen).fill(null);
    }

    const columns: (number | null)[][] = [...subsetArrays, fitArray, directFitArray];

    // Ground truth kernel overlay (peak-normalized to 1.0 to match free/fit kernels)
    if (showGroundTruth()) {
      const gtTauR = groundTruthTauRise()!;
      const gtTauD = groundTruthTauDecay()!;
      const gtArray = new Array(maxLen);
      for (let i = 0; i < maxLen; i++) {
        const t = i / fs;
        gtArray[i] = Math.exp(-t / gtTauD) - Math.exp(-t / gtTauR);
      }
      peakNormalize(gtArray);
      columns.push(gtArray);
    }

    return [xAxis, ...columns] as uPlot.AlignedData;
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
    s.push(createDirectBiexpFitSeries());
    if (showGroundTruth()) {
      s.push(createGroundTruthKernelSeries());
    }
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

  const tauRMs = () => formatTauMs(currentTauRise());
  const tauDMs = () => formatTauMs(currentTauDecay());
  const directTauRMs = () => formatTauMs(snapshot()?.directTauRise ?? null);
  const directTauDMs = () => formatTauMs(snapshot()?.directTauDecay ?? null);
  const gtTauRMs = () => formatTauMs(groundTruthTauRise());
  const gtTauDMs = () => formatTauMs(groundTruthTauDecay());
  const hasDirectTaus = () => snapshot()?.directTauRise != null;

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
          <Show when={hasDirectTaus()}>
            <span style={{ color: '#e91e63' }}>
              direct tau_r: <strong>{directTauRMs()}</strong> ms
            </span>
            <span style={{ color: '#e91e63' }}>
              direct tau_d: <strong>{directTauDMs()}</strong> ms
            </span>
            <Show when={snapshot()?.directAgreed}>
              <span style={{ color: '#4caf50', 'font-weight': 'bold' }}>agreed</span>
            </Show>
          </Show>
          <Show when={showGroundTruth()}>
            <span class="kernel-display__gt-stat">
              true tau_r: <strong>{gtTauRMs()}</strong> ms
            </span>
            <span class="kernel-display__gt-stat">
              true tau_d: <strong>{gtTauDMs()}</strong> ms
            </span>
          </Show>
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
