/**
 * Zoomed analysis window showing raw + deconvolved + reconvolved traces
 * for a configurable time window. Uses uPlot via TracePanel.
 */

import { createMemo, createSignal, Show } from 'solid-js';
import type uPlot from 'uplot';
import { TracePanel } from '../traces/TracePanel';
import { downsampleMinMax } from '../../lib/chart/downsample';
import { createRawSeries, createFitSeries, createDeconvolvedSeries, createResidualSeries, createPinnedOverlaySeries } from '../../lib/chart/series-config';

export interface ZoomWindowProps {
  rawTrace: Float64Array;
  deconvolvedTrace?: Float32Array;
  reconvolutionTrace?: Float32Array;
  samplingRate: number;
  /** Zoom window start time (seconds) */
  startTime: number;
  /** Zoom window end time (seconds) */
  endTime: number;
  height?: number;
  syncKey: string;
  /** Called when the user scrolls to zoom in/out in time */
  onZoomChange?: (startTime: number, endTime: number) => void;
  /** Sample offset of deconv/reconv within the raw trace (for windowed solver results) */
  deconvWindowOffset?: number;
  /** Pinned deconvolved trace for dashed overlay comparison */
  pinnedDeconvolved?: Float32Array;
  /** Pinned reconvolution trace for dashed overlay comparison */
  pinnedReconvolution?: Float32Array;
  /** Sample offset for pinned windowed solver results */
  pinnedWindowOffset?: number;
  /** Tutorial targeting attribute for driver.js tour steps. */
  'data-tutorial'?: string;
}

const ZOOM_BUCKET_WIDTH = 800;
const DECONV_GAP = -2; // z-score offset: negative = deconv peaks overlap raw range
const DECONV_SCALE = 0.35; // scale deconvolved to this fraction of raw z-range
const RESID_GAP = 0.5; // gap between deconv band bottom and residual band top
const RESID_SCALE = 0.25; // scale residuals to this fraction of raw z-range

export function ZoomWindow(props: ZoomWindowProps) {
  const height = () => props.height ?? 150;

  // Z-score stats from full raw trace — consistent across zoom levels.
  // Includes zMin/zMax so the z-score range is computed exactly ONCE.
  const rawStats = createMemo(() => {
    const raw = props.rawTrace;
    if (!raw || raw.length === 0) return { mean: 0, std: 1, zMin: 0, zMax: 0 };
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i];
    const mean = sum / raw.length;
    let ssq = 0;
    for (let i = 0; i < raw.length; i++) ssq += (raw[i] - mean) ** 2;
    const std = Math.sqrt(ssq / raw.length) || 1;

    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const z = (raw[i] - mean) / std;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    return { mean, std, zMin, zMax };
  });

  // Global y-range in z-score space, with room for deconv offset below
  const globalYRange = createMemo<[number, number]>(() => {
    const raw = props.rawTrace;
    const { zMin, zMax } = rawStats();
    if (!raw || raw.length === 0) return [-4, 6];

    const rawRange = zMax - zMin;
    const deconvHeight = rawRange * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;

    const residHeight = rawRange * RESID_SCALE;
    const residBottom = deconvBottom - RESID_GAP - residHeight;
    return [residBottom, zMax + rawRange * 0.02];
  });

  /**
   * Slice a trace for the current zoom window, downsample, and apply a transform.
   *
   * Handles windowed solver results (offset != 0), full-length traces, and missing
   * traces (returns array of nulls). This pattern was repeated 4+ times in the
   * original code for reconv, deconv, pinned reconv, and pinned deconv.
   */
  const sliceAndDownsample = (
    trace: Float32Array | undefined,
    x: Float64Array,
    startSample: number,
    endSample: number,
    offset: number,
    rawLength: number,
    dsXLength: number,
    transform: (dsValues: number[]) => number[],
  ): number[] => {
    if (!trace || trace.length === 0) {
      return new Array(dsXLength).fill(null) as number[];
    }

    const windowStart = startSample - offset;
    const windowEnd = endSample - offset;

    // Windowed result: solver output is shorter than raw, offset-aligned
    if (windowStart >= 0 && windowEnd <= trace.length) {
      const slice = trace.subarray(windowStart, windowEnd);
      const [, dsValues] = downsampleMinMax(x, slice, ZOOM_BUCKET_WIDTH);
      return transform(dsValues);
    }

    // Full-length fallback: solver output is same length as raw
    if (trace.length === rawLength) {
      const slice = trace.subarray(startSample, endSample);
      const [, dsValues] = downsampleMinMax(x, slice, ZOOM_BUCKET_WIDTH);
      return transform(dsValues);
    }

    return new Array(dsXLength).fill(null) as number[];
  };

  /**
   * Scale deconvolved values into the deconv band below the raw z-score range.
   * Maps the full deconv trace's own [min,max] into [deconvBottom, deconvTop].
   */
  const scaleToDeconvBand = (
    dsDeconvRaw: number[],
    deconvFull: Float32Array,
    zMin: number,
    zMax: number,
  ): number[] => {
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < deconvFull.length; i++) {
      if (deconvFull[i] < dMin) dMin = deconvFull[i];
      if (deconvFull[i] > dMax) dMax = deconvFull[i];
    }
    const dRange = dMax - dMin || 1;

    const deconvHeight = (zMax - zMin) * DECONV_SCALE;
    const deconvTop = zMin - DECONV_GAP;
    const deconvBottom = deconvTop - deconvHeight;

    return dsDeconvRaw.map(v => {
      const norm = (v - dMin) / dRange;
      return deconvBottom + norm * deconvHeight;
    });
  };

  /**
   * Compute residuals (raw - reconvolution in z-score space) and map them
   * into the residual band below the deconv band.
   */
  const computeResiduals = (
    dsRaw: number[],
    dsReconv: number[],
    zMin: number,
    zMax: number,
    dsXLength: number,
  ): number[] => {
    if (!dsReconv.some(v => v !== null)) {
      return new Array(dsXLength).fill(null) as number[];
    }

    const rawRange = zMax - zMin;
    const deconvHeight = rawRange * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;
    const residHeight = rawRange * RESID_SCALE;
    const residTop = deconvBottom - RESID_GAP;
    const residBottom = residTop - residHeight;

    // Compute raw residuals and find their range
    const rawResid: number[] = [];
    let rMin = Infinity;
    let rMax = -Infinity;
    for (let i = 0; i < dsRaw.length; i++) {
      if (dsReconv[i] === null || dsReconv[i] === undefined) {
        rawResid.push(0);
      } else {
        const r = dsRaw[i] - (dsReconv[i] as number);
        rawResid.push(r);
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
      }
    }
    const rRange = rMax - rMin || 1;

    return rawResid.map(r => {
      const norm = (r - rMin) / rRange;
      return residBottom + norm * residHeight;
    });
  };

  const zoomData = createMemo<[number[], ...number[][]]>(() => {
    const raw = props.rawTrace;
    const fs = props.samplingRate;
    if (!raw || raw.length === 0) return [[], [], [], [], [], [], []];

    const startSample = Math.max(0, Math.floor(props.startTime * fs));
    const endSample = Math.min(raw.length, Math.ceil(props.endTime * fs));
    if (startSample >= endSample) return [[], [], [], [], [], [], []];

    const len = endSample - startSample;
    const { mean, std, zMin, zMax } = rawStats();

    // Build time axis for the window
    const x = new Float64Array(len);
    const dt = 1 / fs;
    for (let i = 0; i < len; i++) {
      x[i] = (startSample + i) * dt;
    }

    // Raw trace — z-score normalized
    const rawSlice = raw.subarray(startSample, endSample);
    const [dsX, dsRawRaw] = downsampleMinMax(x, rawSlice, ZOOM_BUCKET_WIDTH);
    const dsRaw = dsRawRaw.map(v => (v - mean) / std);

    const offset = props.deconvWindowOffset ?? 0;
    const pinnedOffset = props.pinnedWindowOffset ?? 0;

    // z-score transform for traces in raw-space (reconv, pinned reconv)
    const toZScore = (values: number[]) => values.map(v => (v - mean) / std);

    // Reconvolution trace — same z-score space as raw
    const dsReconv = sliceAndDownsample(
      props.reconvolutionTrace, x, startSample, endSample,
      offset, raw.length, dsX.length, toZScore,
    );

    // Deconvolved trace — scaled into deconv band below raw
    const dsDeconv = sliceAndDownsample(
      props.deconvolvedTrace, x, startSample, endSample,
      offset, raw.length, dsX.length,
      (vals) => scaleToDeconvBand(vals, props.deconvolvedTrace!, zMin, zMax),
    );

    // Residuals — raw minus reconvolution, scaled into residual band
    const dsResid = computeResiduals(dsRaw, dsReconv, zMin, zMax, dsX.length);

    // Pinned reconvolution — same z-score space as raw
    const dsPinnedReconv = sliceAndDownsample(
      props.pinnedReconvolution, x, startSample, endSample,
      pinnedOffset, raw.length, dsX.length, toZScore,
    );

    // Pinned deconvolved — scaled into deconv band using pinned trace's own range
    const dsPinnedDeconv = sliceAndDownsample(
      props.pinnedDeconvolved, x, startSample, endSample,
      pinnedOffset, raw.length, dsX.length,
      (vals) => scaleToDeconvBand(vals, props.pinnedDeconvolved!, zMin, zMax),
    );

    return [dsX, dsRaw, dsDeconv, dsReconv, dsResid, dsPinnedDeconv, dsPinnedReconv];
  });

  const seriesConfig = createMemo<uPlot.Series[]>(() => {
    const base = [{}, createRawSeries(), createDeconvolvedSeries(), createFitSeries(), createResidualSeries()];
    // Always include pinned series slots (null data renders nothing)
    base.push(createPinnedOverlaySeries('Pinned Deconv', '#2ca02c', 1));
    base.push(createPinnedOverlaySeries('Pinned Fit', '#ff7f0e', 1.5));
    return base;
  });

  const ZOOM_FACTOR = 0.75;
  const MIN_WINDOW_S = 1; // minimum 1 second zoom window

  const [showHint, setShowHint] = createSignal(false);
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const handleWheel = (e: WheelEvent) => {
    if (!props.onZoomChange) return;

    // Require Ctrl (or Cmd on Mac) for zoom — bare scroll passes through for page scrolling
    if (!e.ctrlKey && !e.metaKey) {
      // Show hint briefly
      setShowHint(true);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setShowHint(false), 1500);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const totalDuration = props.rawTrace.length / props.samplingRate;
    const currentRange = props.endTime - props.startTime;

    // Zoom in (scroll up) or out (scroll down)
    const newRange = e.deltaY < 0
      ? Math.max(MIN_WINDOW_S, currentRange * ZOOM_FACTOR)
      : Math.min(totalDuration, currentRange / ZOOM_FACTOR);

    // Center zoom on cursor horizontal position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cursorFraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const cursorTime = props.startTime + cursorFraction * currentRange;

    let newStart = cursorTime - cursorFraction * newRange;
    let newEnd = newStart + newRange;

    // Clamp to data bounds
    if (newStart < 0) { newStart = 0; newEnd = newRange; }
    if (newEnd > totalDuration) { newEnd = totalDuration; newStart = Math.max(0, totalDuration - newRange); }

    props.onZoomChange(newStart, newEnd);
  };

  return (
    <div class="zoom-window" onWheel={handleWheel} style={{ position: 'relative' }} data-tutorial={props['data-tutorial']}>
      <TracePanel
        data={() => zoomData()}
        series={seriesConfig()}
        height={height()}
        syncKey={props.syncKey}
        disableWheelZoom={!!props.onZoomChange}
        yRange={globalYRange()}
        hideYValues
        xLabel="Time (s)"
      />
      <Show when={showHint()}>
        <div class="zoom-hint">Hold Ctrl to zoom</div>
      </Show>
    </div>
  );
}
