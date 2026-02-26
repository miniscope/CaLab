/**
 * TraceInspector: CaTune-style trace viewer for CaDecon.
 * Uses shared minimap (TraceOverview), zoom window (ZoomWindow), and legend (TraceLegend).
 * Shows raw + filtered + fit + deconvolved + residual with multi-band Y layout.
 * Supports iteration history scrubbing.
 */

import { createMemo, createSignal, createEffect, on, Show, type JSX } from 'solid-js';
import type uPlot from 'uplot';
import { makeTimeAxis, downsampleMinMax } from '@calab/compute';
import { TraceOverview, ZoomWindow, ROW_DURATION_S, type HighlightZone } from '@calab/ui/chart';
import { TraceLegend, type LegendItemConfig } from '@calab/ui';
import { transientZonePlugin } from '@calab/ui/chart';
import {
  runState,
  perTraceResults,
  currentTauRise,
  currentTauDecay,
  iterationHistory,
  type TraceResultEntry,
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
  showRaw,
  setShowRaw,
  showFiltered,
  setShowFiltered,
  showFit,
  setShowFit,
  showDeconv,
  setShowDeconv,
  showResidual,
  setShowResidual,
  viewedIteration,
} from '../../lib/viz-store.ts';
import { subsetRectangles } from '../../lib/subset-store.ts';
import { dataIndex } from '../../lib/data-utils.ts';
import { reconvolveAR2 } from '../../lib/reconvolve.ts';
import { CellSelector } from './CellSelector.tsx';
import { IterationScrubber } from './IterationScrubber.tsx';
import '../../styles/trace-inspector.css';

const DECONV_GAP = -2;
const DECONV_SCALE = 0.35;
const RESID_GAP = 0.5;
const RESID_SCALE = 0.25;
const TRANSIENT_TAU_MULTIPLIER = 2;
const MIN_BUCKET_WIDTH = 300;
const MAX_BUCKET_WIDTH = 1200;
const DEFAULT_ZOOM_WINDOW_S = 60;

export function TraceInspector(): JSX.Element {
  const isFinalized = () => runState() === 'complete';

  // Available cell indices
  const cellIndices = createMemo((): number[] => {
    if (isFinalized()) {
      const n = numCells();
      return Array.from({ length: n }, (_, i) => i);
    }
    const rects = subsetRectangles();
    const set = new Set<number>();
    for (const r of rects) {
      for (let c = r.cellStart; c < r.cellEnd; c++) set.add(c);
    }
    return [...set].sort((a, b) => a - b);
  });

  const effectiveCellIndex = createMemo(() => {
    const idx = inspectedCellIndex();
    const indices = cellIndices();
    if (idx != null && indices.includes(idx)) return idx;
    return indices.length > 0 ? indices[0] : null;
  });

  // Effective result: from iteration history or latest
  const effectiveResult = createMemo((): TraceResultEntry | null => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;

    const iter = viewedIteration();
    if (iter != null) {
      const history = iterationHistory();
      const entry = history.find((h) => h.iteration === iter);
      if (entry) return entry.results[cellIdx] ?? null;
      return null;
    }

    return perTraceResults()[cellIdx] ?? null;
  });

  const effectiveTauRise = createMemo(() => {
    const iter = viewedIteration();
    if (iter != null) {
      const history = iterationHistory();
      const entry = history.find((h) => h.iteration === iter);
      if (entry) return entry.tauRise;
    }
    return currentTauRise();
  });

  const effectiveTauDecay = createMemo(() => {
    const iter = viewedIteration();
    if (iter != null) {
      const history = iterationHistory();
      const entry = history.find((h) => h.iteration === iter);
      if (entry) return entry.tauDecay;
    }
    return currentTauDecay();
  });

  // Whether we have any result for the selected cell (used as a gate, but
  // kept separate so the expensive trace extraction below doesn't re-run
  // every time perTraceResults updates with new iteration data).
  const hasResult = createMemo(() => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return false;
    if (isFinalized()) return true;
    return effectiveResult() != null;
  });

  // Extract raw trace for the selected cell from the full data matrix.
  // Only depends on cell index + data shape — NOT on effectiveResult — so
  // it won't produce a new Float64Array when an iteration updates.
  const fullRawTrace = createMemo((): Float64Array | null => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;
    if (!hasResult()) return null;

    const data = parsedData();
    const nTp = numTimepoints();
    if (!data || nTp === 0) return null;
    const isSwap = swapped();
    const rawCols = data.shape[1];
    const trace = new Float64Array(nTp);
    for (let t = 0; t < nTp; t++) {
      trace[t] = Number(data.data[dataIndex(cellIdx, t, rawCols, isSwap)]);
    }
    return trace;
  });

  // Reconvolved trace
  const reconvolvedTrace = createMemo((): Float32Array | null => {
    const result = effectiveResult();
    if (!result) return null;
    const tauR = effectiveTauRise();
    const tauD = effectiveTauDecay();
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

  // Zoom window state
  const totalDuration = createMemo(() => {
    const raw = fullRawTrace();
    const fs = samplingRate();
    if (!raw || !fs) return 0;
    return raw.length / fs;
  });

  const transientEnd = createMemo(() => {
    const tauD = effectiveTauDecay();
    return tauD != null ? Math.min(2 * tauD, totalDuration()) : 0;
  });

  const [zoomStart, setZoomStart] = createSignal(0);
  const [zoomEnd, setZoomEnd] = createSignal(DEFAULT_ZOOM_WINDOW_S);

  // Reset zoom only when the selected cell changes — NOT on iteration updates.
  // Uses `on()` with explicit deps to avoid tracking totalDuration/transientEnd
  // (which change every iteration due to tauDecay updates).
  createEffect(
    on(effectiveCellIndex, () => {
      const dur = totalDuration();
      if (dur <= 0) return;
      const te = transientEnd();
      setZoomStart(te);
      setZoomEnd(Math.min(te + DEFAULT_ZOOM_WINDOW_S, dur));
    }),
  );

  const handleZoomChange = (start: number, end: number) => {
    setZoomStart(start);
    setZoomEnd(end);
  };

  // --- Z-score stats ---
  const rawStats = createMemo(() => {
    const raw = fullRawTrace();
    if (!raw || raw.length === 0) return { mean: 0, std: 1, zMin: 0, zMax: 0 };
    let sum = 0;
    let sumSq = 0;
    let rawMin = Infinity;
    let rawMax = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      sum += v;
      sumSq += v * v;
      if (v < rawMin) rawMin = v;
      if (v > rawMax) rawMax = v;
    }
    const n = raw.length;
    const mean = sum / n;
    const std = Math.sqrt(sumSq / n - mean * mean) || 1;
    return { mean, std, zMin: (rawMin - mean) / std, zMax: (rawMax - mean) / std };
  });

  const deconvMinMax = createMemo<[number, number]>(() => {
    const result = effectiveResult();
    if (!result || result.sCounts.length === 0) return [0, 1];
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < result.sCounts.length; i++) {
      if (result.sCounts[i] < dMin) dMin = result.sCounts[i];
      if (result.sCounts[i] > dMax) dMax = result.sCounts[i];
    }
    return [dMin, dMax];
  });

  const globalYRange = createMemo<[number, number]>(() => {
    const { zMin, zMax } = rawStats();
    if (zMin === 0 && zMax === 0) return [-4, 6];
    const rawRange = zMax - zMin;
    const deconvHeight = rawRange * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;
    const residHeight = rawRange * RESID_SCALE;
    const residBottom = deconvBottom - RESID_GAP - residHeight;
    return [residBottom, zMax + rawRange * 0.02];
  });

  const scaleToDeconvBand = (
    values: number[],
    minMax: [number, number],
    zMin: number,
    zMax: number,
  ): number[] => {
    const [dMin, dMax] = minMax;
    const dRange = dMax - dMin || 1;
    const deconvHeight = (zMax - zMin) * DECONV_SCALE;
    const deconvTop = zMin - DECONV_GAP;
    const deconvBottom = deconvTop - deconvHeight;
    return values.map((v) => {
      const norm = (v - dMin) / dRange;
      return deconvBottom + norm * deconvHeight;
    });
  };

  const computeResiduals = (
    dsRaw: number[],
    dsReconv: (number | null)[],
    zMin: number,
    zMax: number,
    len: number,
  ): number[] => {
    if (!dsReconv.some((v) => v !== null)) return new Array(len).fill(null) as number[];
    const rawRange = zMax - zMin;
    const deconvHeight = rawRange * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;
    const residHeight = rawRange * RESID_SCALE;
    const residTop = deconvBottom - RESID_GAP;
    const residBottom = residTop - residHeight;
    const rawResid: (number | null)[] = [];
    let rMin = Infinity;
    let rMax = -Infinity;
    for (let i = 0; i < dsRaw.length; i++) {
      if (dsReconv[i] === null || dsReconv[i] === undefined) {
        rawResid.push(null);
      } else {
        const r = dsRaw[i] - (dsReconv[i] as number);
        rawResid.push(r);
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
      }
    }
    const rRange = rMax - rMin || 1;
    return rawResid.map((r) => {
      if (r === null) return null as unknown as number;
      return residBottom + ((r - rMin) / rRange) * residHeight;
    });
  };

  // Container width tracking for adaptive downsampling
  let containerRef: HTMLDivElement | undefined;
  const [chartWidth, setChartWidth] = createSignal(600);

  // --- Zoom window data (5 series: raw, fit, deconv, residual — filtered hidden for now) ---
  // Series order: x, raw, fit, deconv, residual
  const SERIES_COUNT = 5;
  const emptyData = (): [number[], ...number[][]] =>
    Array.from({ length: SERIES_COUNT }, () => []) as unknown as [number[], ...number[][]];

  const bucketWidth = () =>
    Math.max(MIN_BUCKET_WIDTH, Math.min(MAX_BUCKET_WIDTH, Math.round(chartWidth())));

  const zoomData = createMemo<[number[], ...number[][]]>(() => {
    const raw = fullRawTrace();
    const fs = samplingRate();
    if (!raw || !fs || raw.length === 0) return emptyData();

    const startSample = Math.max(0, Math.floor(zoomStart() * fs));
    const endSample = Math.min(raw.length, Math.ceil(zoomEnd() * fs));
    if (startSample >= endSample) return emptyData();

    const len = endSample - startSample;
    const { mean, std, zMin, zMax } = rawStats();

    const x = new Float64Array(len);
    const dt = 1 / fs;
    for (let i = 0; i < len; i++) x[i] = (startSample + i) * dt;

    const rawSlice = raw.subarray(startSample, endSample);
    const [dsX, dsRawRaw] = downsampleMinMax(x, rawSlice, bucketWidth());
    const dsRaw = dsRawRaw.map((v) => (v - mean) / std);

    // Reconvolved (fit) — z-score
    const recon = reconvolvedTrace();
    let dsFit: (number | null)[];
    if (recon && recon.length >= endSample) {
      const reconSlice = recon.subarray(startSample, endSample);
      const [, dsFitRaw] = downsampleMinMax(x, reconSlice, bucketWidth());
      dsFit = dsFitRaw.map((v) => (v - mean) / std);
    } else {
      dsFit = new Array(dsX.length).fill(null) as (number | null)[];
    }

    // Mask transient
    const tauD = effectiveTauDecay();
    const transientTime = tauD != null ? TRANSIENT_TAU_MULTIPLIER * tauD : 0;
    if (startSample < transientTime * fs) {
      for (let i = 0; i < dsFit.length; i++) {
        if (dsX[i] < transientTime) dsFit[i] = null;
        else break;
      }
    }

    // Deconv — scaled to band
    const result = effectiveResult();
    let dsDeconv: number[];
    if (result && result.sCounts.length >= endSample) {
      const deconvSlice = result.sCounts.subarray(startSample, endSample);
      const [, dsDeconvRaw] = downsampleMinMax(x, deconvSlice, bucketWidth());
      dsDeconv = scaleToDeconvBand(dsDeconvRaw, deconvMinMax(), zMin, zMax);
    } else {
      dsDeconv = new Array(dsX.length).fill(null) as number[];
    }

    // Residual
    const dsResid = computeResiduals(dsRaw, dsFit, zMin, zMax, dsX.length);

    return [dsX, dsRaw, dsFit as number[], dsDeconv, dsResid];
  });

  const seriesConfig = createMemo<uPlot.Series[]>(() => [
    {},
    { label: 'Raw', stroke: '#1f77b4', width: 1, show: showRaw() },
    { label: 'Fit', stroke: '#ff7f0e', width: 1.5, show: showFit() },
    { label: 'Deconv', stroke: '#2ca02c', width: 1, show: showDeconv() },
    { label: 'Residual', stroke: '#d62728', width: 1, show: showResidual() },
  ]);

  // Legend items
  const legendItems = createMemo((): LegendItemConfig[] => [
    { key: 'raw', color: '#1f77b4', label: 'Raw', visible: showRaw, setVisible: setShowRaw },
    { key: 'fit', color: '#ff7f0e', label: 'Fit', visible: showFit, setVisible: setShowFit },
    {
      key: 'deconv',
      color: '#2ca02c',
      label: 'Deconv',
      visible: showDeconv,
      setVisible: setShowDeconv,
    },
    {
      key: 'resid',
      color: '#d62728',
      label: 'Resid',
      visible: showResidual,
      setVisible: setShowResidual,
    },
  ]);

  // Stats
  const alpha = () => effectiveResult()?.alpha.toFixed(2) ?? '--';
  const pve = () => {
    const v = effectiveResult()?.pve;
    return v != null ? (v * 100).toFixed(1) + '%' : '--';
  };
  const spikeCount = () => {
    const r = effectiveResult();
    return r ? r.sCounts.reduce((s, v) => s + v, 0).toFixed(0) : '--';
  };

  // Subset highlight zones for the minimap — show which time regions
  // the algorithm operates on for the currently selected cell.
  const subsetZones = createMemo((): HighlightZone[] => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return [];
    const fs = samplingRate();
    if (!fs) return [];
    const rects = subsetRectangles();
    const zones: HighlightZone[] = [];
    for (const r of rects) {
      if (cellIdx >= r.cellStart && cellIdx < r.cellEnd) {
        zones.push({
          startTime: r.tStart / fs,
          endTime: r.tEnd / fs,
          color: 'rgba(255, 152, 0, 0.12)',
          borderColor: 'rgba(255, 152, 0, 0.35)',
        });
      }
    }
    return zones;
  });

  const transientEndS = createMemo(() => {
    const tauD = effectiveTauDecay();
    const fs = samplingRate();
    if (tauD == null || !fs) return 0;
    return Math.ceil(TRANSIENT_TAU_MULTIPLIER * tauD * fs) / fs;
  });

  return (
    <div class="trace-inspector" ref={containerRef}>
      <div class="trace-inspector__header">
        <CellSelector
          cellIndices={cellIndices}
          selectedIndex={effectiveCellIndex}
          onSelect={setInspectedCellIndex}
        />
        <TraceLegend items={legendItems()} />
        <div class="trace-inspector__stats">
          <span>alpha: {alpha()}</span>
          <span>PVE: {pve()}</span>
          <span>spikes: {spikeCount()}</span>
        </div>
      </div>

      <Show
        when={fullRawTrace() != null}
        fallback={
          <div class="trace-inspector__empty">
            No trace data available. Start a run to see traces.
          </div>
        }
      >
        <div class="trace-inspector__overview">
          <TraceOverview
            trace={fullRawTrace()!}
            samplingRate={samplingRate()!}
            zoomStart={zoomStart()}
            zoomEnd={zoomEnd()}
            onZoomChange={handleZoomChange}
            highlightZones={subsetZones()}
          />
        </div>

        <div class="trace-inspector__zoom">
          <ZoomWindow
            data={() => zoomData()}
            series={seriesConfig}
            totalDuration={totalDuration()}
            startTime={zoomStart()}
            endTime={zoomEnd()}
            height={150}
            syncKey="cadecon-trace"
            onZoomChange={handleZoomChange}
            yRange={globalYRange()}
            plugins={[transientZonePlugin(transientEndS)]}
          />
        </div>

        <IterationScrubber />
      </Show>
    </div>
  );
}
