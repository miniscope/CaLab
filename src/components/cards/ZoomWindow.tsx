/**
 * Zoomed analysis window showing raw + deconvolved + reconvolved traces
 * for a configurable time window. Uses uPlot via TracePanel.
 */

import { createMemo, createSignal, Show } from 'solid-js';
import type uPlot from 'uplot';
import { TracePanel } from '../traces/TracePanel';
import { downsampleMinMax } from '../../lib/chart/downsample';
import { createRawSeries, createFitSeries, createDeconvolvedSeries } from '../../lib/chart/series-config';

export interface ZoomWindowProps {
  rawTrace: Float64Array;
  deconvolvedTrace?: Float64Array;
  reconvolutionTrace?: Float64Array;
  samplingRate: number;
  /** Zoom window start time (seconds) */
  startTime: number;
  /** Zoom window end time (seconds) */
  endTime: number;
  height?: number;
  syncKey: string;
  /** Called when the user scrolls to zoom in/out in time */
  onZoomChange?: (startTime: number, endTime: number) => void;
}

const ZOOM_BUCKET_WIDTH = 800;
const DECONV_GAP = -2; // z-score offset: negative = deconv peaks overlap raw range
const DECONV_SCALE = 0.35; // scale deconvolved to this fraction of raw z-range

export function ZoomWindow(props: ZoomWindowProps) {
  const height = () => props.height ?? 150;

  // Z-score stats from full raw trace — consistent across zoom levels
  const rawStats = createMemo(() => {
    const raw = props.rawTrace;
    if (!raw || raw.length === 0) return { mean: 0, std: 1 };
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i];
    const mean = sum / raw.length;
    let ssq = 0;
    for (let i = 0; i < raw.length; i++) ssq += (raw[i] - mean) ** 2;
    const std = Math.sqrt(ssq / raw.length) || 1;
    return { mean, std };
  });

  // Global y-range in z-score space, with room for deconv offset below
  const globalYRange = createMemo<[number, number]>(() => {
    const raw = props.rawTrace;
    const { mean, std } = rawStats();
    if (!raw || raw.length === 0) return [-4, 6];

    // Find z-scored min/max of raw trace
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const z = (raw[i] - mean) / std;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }

    // Deconv sits below raw: baseline at deconvBottom, peaks up to deconvTop
    const deconvHeight = (zMax - zMin) * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;
    return [deconvBottom, zMax + (zMax - zMin) * 0.02];
  });

  const zoomData = createMemo<[number[], ...number[][]]>(() => {
    const raw = props.rawTrace;
    const fs = props.samplingRate;
    if (!raw || raw.length === 0) return [[], [], [], []];

    const startSample = Math.max(0, Math.floor(props.startTime * fs));
    const endSample = Math.min(raw.length, Math.ceil(props.endTime * fs));
    if (startSample >= endSample) return [[], [], [], []];

    const len = endSample - startSample;
    const { mean, std } = rawStats();

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

    // Reconvolution trace — same z-score as raw (it approximates the raw)
    const reconv = props.reconvolutionTrace;
    let dsReconv: number[];
    if (reconv && reconv.length === raw.length) {
      const reconvSlice = reconv.subarray(startSample, endSample);
      let dsReconvRaw: number[];
      [, dsReconvRaw] = downsampleMinMax(x, reconvSlice, ZOOM_BUCKET_WIDTH);
      dsReconv = dsReconvRaw.map(v => (v - mean) / std);
    } else {
      dsReconv = new Array(dsX.length).fill(null) as number[];
    }

    // Deconvolved trace — normalize to [0,1] then scale + offset below raw
    const deconv = props.deconvolvedTrace;
    let dsDeconv: number[];
    if (deconv && deconv.length === raw.length) {
      const deconvSlice = deconv.subarray(startSample, endSample);
      let dsDeconvRaw: number[];
      [, dsDeconvRaw] = downsampleMinMax(x, deconvSlice, ZOOM_BUCKET_WIDTH);

      // Find global deconv min/max for consistent normalization
      let dMin = Infinity;
      let dMax = -Infinity;
      for (let i = 0; i < deconv.length; i++) {
        if (deconv[i] < dMin) dMin = deconv[i];
        if (deconv[i] > dMax) dMax = deconv[i];
      }
      const dRange = dMax - dMin || 1;

      // Find raw z-range for proportional scaling
      let zMin = Infinity;
      let zMax = -Infinity;
      for (let i = 0; i < raw.length; i++) {
        const z = (raw[i] - mean) / std;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }

      // Deconv peaks point UP from a baseline below the raw trace
      const deconvHeight = (zMax - zMin) * DECONV_SCALE;
      const deconvTop = zMin - DECONV_GAP;           // top of deconv peaks
      const deconvBottom = deconvTop - deconvHeight;  // baseline of deconv
      dsDeconv = dsDeconvRaw.map(v => {
        const norm = (v - dMin) / dRange; // [0, 1]
        return deconvBottom + norm * deconvHeight;    // peaks go up
      });
    } else {
      dsDeconv = new Array(dsX.length).fill(null) as number[];
    }

    return [dsX, dsRaw, dsDeconv, dsReconv];
  });

  const seriesConfig = createMemo<uPlot.Series[]>(() => {
    return [{}, createRawSeries(), createDeconvolvedSeries(), createFitSeries()];
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
    <div class="zoom-window" onWheel={handleWheel} style={{ position: 'relative' }}>
      <TracePanel
        data={() => zoomData()}
        series={seriesConfig()}
        height={height()}
        syncKey={props.syncKey}
        disableWheelZoom={!!props.onZoomChange}
        yRange={globalYRange()}
        hideYValues
      />
      <Show when={showHint()}>
        <div class="zoom-hint">Hold Ctrl to zoom</div>
      </Show>
    </div>
  );
}
