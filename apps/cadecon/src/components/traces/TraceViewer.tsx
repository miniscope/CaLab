/**
 * TraceViewer: CellCard-inspired trace inspector for CaDecon.
 * Shows raw trace + reconvolved + residual + spikes for a selected cell.
 * Dual mode: during run (debug cell) and after finalization (any cell).
 */

import { createMemo, Show, type JSX } from 'solid-js';
import type uPlot from 'uplot';
import { makeTimeAxis, downsampleMinMax } from '@calab/compute';
import {
  runState,
  perTraceResults,
  debugTraceSnapshots,
  currentTauRise,
  currentTauDecay,
} from '../../lib/iteration-store.ts';
import {
  samplingRate,
  numCells,
  numTimepoints,
  parsedData,
  swapped,
} from '../../lib/data-store.ts';
import {
  inspectedCellIndex,
  setInspectedCellIndex,
  showRawTrace,
  showReconvolved,
  showResidual,
  showSpikes,
} from '../../lib/viz-store.ts';
import { subsetRectangles } from '../../lib/subset-store.ts';
import { dataIndex } from '../../lib/data-utils.ts';
import { TracePanel } from './TracePanel.tsx';
import { CellSelector } from './CellSelector.tsx';
import { SeriesToggleBar } from './SeriesToggleBar.tsx';
import {
  createRawTraceSeries,
  createReconvolvedSeries,
  createResidualSeries,
} from '../../lib/chart/series-config.ts';
import { transientZonePlugin } from '@calab/ui/chart';
import { reconvolveAR2 } from '../../lib/reconvolve.ts';

const DOWNSAMPLE_TARGET = 2000;
const TRACE_SYNC_KEY = 'cadecon-trace';

export function TraceViewer(): JSX.Element {
  const isFinalized = () => runState() === 'complete';

  // Available cell indices
  const cellIndices = createMemo((): number[] => {
    if (isFinalized()) {
      const n = numCells();
      return Array.from({ length: n }, (_, i) => i);
    }
    // During run: union of subset cells
    const rects = subsetRectangles();
    const set = new Set<number>();
    for (const r of rects) {
      for (let c = r.cellStart; c < r.cellEnd; c++) set.add(c);
    }
    return [...set].sort((a, b) => a - b);
  });

  // Auto-select first cell if nothing is selected
  const effectiveCellIndex = createMemo(() => {
    const idx = inspectedCellIndex();
    const indices = cellIndices();
    if (idx != null && indices.includes(idx)) return idx;
    return indices.length > 0 ? indices[0] : null;
  });

  // Extract raw trace for the selected cell from full data matrix
  const fullRawTrace = createMemo((): Float32Array | null => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;

    // During run: use debug snapshot trace
    if (!isFinalized()) {
      const snaps = debugTraceSnapshots();
      if (snaps.length === 0) return null;
      const latest = snaps[snaps.length - 1];
      if (latest.cellIndex === cellIdx) return latest.rawTrace;
      return null;
    }

    // After finalization: extract from full data
    const data = parsedData();
    const nTp = numTimepoints();
    if (!data || nTp === 0) return null;
    const isSwap = swapped();
    const rawCols = data.shape[1];
    const trace = new Float32Array(nTp);
    for (let t = 0; t < nTp; t++) {
      trace[t] = Number(data.data[dataIndex(cellIdx, t, rawCols, isSwap)]);
    }
    return trace;
  });

  // Get result for selected cell
  const cellResult = createMemo(() => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;

    if (!isFinalized()) {
      const snaps = debugTraceSnapshots();
      if (snaps.length === 0) return null;
      const latest = snaps[snaps.length - 1];
      if (latest.cellIndex === cellIdx) {
        return {
          sCounts: latest.sCounts,
          alpha: latest.alpha,
          baseline: latest.baseline,
          pve: latest.pve,
        };
      }
      return null;
    }

    const results = perTraceResults();
    return results[cellIdx] ?? null;
  });

  // Reconvolved trace
  const reconvolvedTrace = createMemo((): Float32Array | null => {
    const result = cellResult();
    if (!result) return null;
    const tauR = currentTauRise();
    const tauD = currentTauDecay();
    const fs = samplingRate();
    if (tauR == null || tauD == null || !fs) return null;
    return reconvolveAR2(result.sCounts, tauR, tauD, fs, result.alpha, result.baseline);
  });

  // Residual = raw - reconvolved
  const residualTrace = createMemo((): Float32Array | null => {
    const raw = fullRawTrace();
    const recon = reconvolvedTrace();
    if (!raw || !recon) return null;
    const minLen = Math.min(raw.length, recon.length);
    const res = new Float32Array(minLen);
    for (let i = 0; i < minLen; i++) res[i] = raw[i] - recon[i];
    return res;
  });

  // Transient end time for zone shading
  const transientEndS = createMemo(() => {
    const tauD = currentTauDecay();
    const fs = samplingRate();
    if (tauD == null || !fs) return 0;
    return Math.ceil(2 * tauD * fs) / fs;
  });

  // Top chart data: time + visible series
  const traceChartData = createMemo((): [number[], ...number[][]] => {
    const raw = fullRawTrace();
    if (!raw) return [[]];
    const fs = samplingRate();
    if (!fs) return [[]];

    const timeAxis = Array.from(makeTimeAxis(raw.length, fs));
    const rawArr = Array.from(raw);
    const needsDownsample = raw.length > DOWNSAMPLE_TARGET * 2;

    // Build each series: visible data or NaN placeholder
    const recon = reconvolvedTrace();
    const resid = residualTrace();

    const entries: { visible: boolean; source: Float32Array | null }[] = [
      { visible: showRawTrace(), source: raw },
      { visible: showReconvolved(), source: recon },
      { visible: showResidual(), source: resid },
    ];

    if (needsDownsample) {
      const [dsX, dsRaw] = downsampleMinMax(timeAxis, rawArr, DOWNSAMPLE_TARGET);
      const nanArr = dsRaw.map(() => NaN);

      const seriesArrays = entries.map((e) => {
        if (e.visible && e.source) {
          const [, ds] = downsampleMinMax(timeAxis, Array.from(e.source), DOWNSAMPLE_TARGET);
          return ds;
        }
        return nanArr;
      });
      return [dsX, ...seriesArrays];
    }

    const nanArr = rawArr.map(() => NaN);
    const seriesArrays = entries.map((e) => {
      if (e.visible && e.source) return Array.from(e.source);
      return nanArr;
    });
    return [timeAxis, ...seriesArrays];
  });

  const traceSeries: uPlot.Series[] = [
    {},
    createRawTraceSeries(),
    createReconvolvedSeries(),
    createResidualSeries(),
  ];

  // Bottom chart: spikes
  const spikeChartData = createMemo((): [number[], ...number[][]] => {
    const result = cellResult();
    if (!result) return [[]];
    const fs = samplingRate();
    if (!fs) return [[]];
    const timeAxis = Array.from(makeTimeAxis(result.sCounts.length, fs));
    return [timeAxis, Array.from(result.sCounts)];
  });

  const spikeSeries: uPlot.Series[] = [
    {},
    {
      label: 'Spikes',
      stroke: '#2ca02c',
      width: 1,
      paths: (u: uPlot, sidx: number) => {
        const xdata = u.data[0];
        const ydata = u.data[sidx];
        const p = new Path2D();
        for (let i = 0; i < xdata.length; i++) {
          const v = ydata[i];
          if (v == null || v === 0) continue;
          const x = u.valToPos(xdata[i], 'x', true);
          const y0 = u.valToPos(0, 'y', true);
          const y1 = u.valToPos(v as number, 'y', true);
          p.moveTo(x, y0);
          p.lineTo(x, y1);
        }
        return { stroke: p, fill: undefined, clip: undefined, flags: 0 };
      },
    },
  ];

  const tracePlugins = [transientZonePlugin(transientEndS)];

  // Stats
  const alpha = () => cellResult()?.alpha.toFixed(2) ?? '--';
  const pve = () => {
    const v = cellResult()?.pve;
    return v != null ? (v * 100).toFixed(1) + '%' : '--';
  };
  const spikeCount = () => {
    const r = cellResult();
    return r ? r.sCounts.reduce((s, v) => s + v, 0).toFixed(0) : '--';
  };

  return (
    <div class="trace-viewer">
      <div class="trace-viewer__header">
        <CellSelector
          cellIndices={cellIndices}
          selectedIndex={effectiveCellIndex}
          onSelect={setInspectedCellIndex}
        />
        <SeriesToggleBar />
        <div class="trace-viewer__stats">
          <span>alpha: {alpha()}</span>
          <span>PVE: {pve()}</span>
          <span>spikes: {spikeCount()}</span>
        </div>
      </div>

      <Show
        when={fullRawTrace() != null}
        fallback={
          <div class="trace-viewer__empty">No trace data available. Start a run to see traces.</div>
        }
      >
        <TracePanel
          data={traceChartData}
          series={traceSeries}
          height={120}
          syncKey={TRACE_SYNC_KEY}
          plugins={tracePlugins}
          xLabel="Time (s)"
        />
        <Show when={showSpikes() && cellResult() != null}>
          <TracePanel
            data={spikeChartData}
            series={spikeSeries}
            height={60}
            syncKey={TRACE_SYNC_KEY}
            yRange={[0, undefined]}
            hideYValues
          />
        </Show>
      </Show>
    </div>
  );
}
