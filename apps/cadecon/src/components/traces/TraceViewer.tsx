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
  convergenceHistory,
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
import { transientZonePlugin } from '../../lib/chart/transient-zone-plugin.ts';

const DOWNSAMPLE_TARGET = 2000;
const TRACE_SYNC_KEY = 'cadecon-trace';

/** Reconvolve spikes through AR2 model (same as iteration-manager). */
function reconvolveAR2(
  sCounts: Float32Array,
  tauR: number,
  tauD: number,
  fs: number,
  alpha: number,
  baseline: number,
): Float32Array {
  const dt = 1 / fs;
  const d = Math.exp(-dt / tauD);
  const r = Math.exp(-dt / tauR);
  const g1 = d + r;
  const g2 = -(d * r);

  let impPeak = 1.0;
  let cPrev2 = 0;
  let cPrev1 = 1;
  const maxSteps = Math.ceil(5 * tauD * fs) + 10;
  for (let i = 1; i < maxSteps; i++) {
    const cv = g1 * cPrev1 + g2 * cPrev2;
    if (cv > impPeak) impPeak = cv;
    if (cv < impPeak * 0.95) break;
    cPrev2 = cPrev1;
    cPrev1 = cv;
  }

  const n = sCounts.length;
  const reconvolved = new Float32Array(n);
  const c = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    c[t] = sCounts[t] + (t >= 1 ? g1 * c[t - 1] : 0) + (t >= 2 ? g2 * c[t - 2] : 0);
    reconvolved[t] = alpha * (c[t] / impPeak) + baseline;
  }
  return reconvolved;
}

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
    const series: number[][] = [];
    const rawArr = Array.from(raw);

    // Downsample if needed
    if (raw.length > DOWNSAMPLE_TARGET * 2) {
      const [dsX, dsRaw] = downsampleMinMax(timeAxis, rawArr, DOWNSAMPLE_TARGET);
      const result: number[][] = [];

      if (showRawTrace()) result.push(dsRaw);
      else result.push(dsRaw.map(() => NaN));

      // Reconvolved
      const recon = reconvolvedTrace();
      if (showReconvolved() && recon) {
        const [, dsRecon] = downsampleMinMax(timeAxis, Array.from(recon), DOWNSAMPLE_TARGET);
        result.push(dsRecon);
      } else {
        result.push(dsRaw.map(() => NaN));
      }

      // Residual
      const resid = residualTrace();
      if (showResidual() && resid) {
        const [, dsResid] = downsampleMinMax(timeAxis, Array.from(resid), DOWNSAMPLE_TARGET);
        result.push(dsResid);
      } else {
        result.push(dsRaw.map(() => NaN));
      }

      return [dsX, ...result];
    }

    if (showRawTrace()) series.push(rawArr);
    else series.push(rawArr.map(() => NaN));

    const recon = reconvolvedTrace();
    if (showReconvolved() && recon) series.push(Array.from(recon));
    else series.push(rawArr.map(() => NaN));

    const resid = residualTrace();
    if (showResidual() && resid) series.push(Array.from(resid));
    else series.push(rawArr.map(() => NaN));

    return [timeAxis, ...series];
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
          <div style={{ padding: '2rem', 'text-align': 'center', color: 'var(--text-tertiary)' }}>
            No trace data available. Start a run to see traces.
          </div>
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
            yRange={[0, undefined as unknown as number]}
            hideYValues
          />
        </Show>
      </Show>
    </div>
  );
}
