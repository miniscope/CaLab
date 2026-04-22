/**
 * CaTune-specific zoom window: z-score normalization, multi-band Y layout
 * (raw + filtered + fit in upper band, deconv below, residuals below that),
 * ground truth overlays, and pinned snapshot comparison.
 * Wraps the shared ZoomWindow from @calab/ui/chart.
 */

import { createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type uPlot from 'uplot';
import { ZoomWindow, transientZonePlugin } from '@calab/ui/chart';
import { downsampleMinMax } from '@calab/compute';
import {
  createRawSeries,
  createFilteredSeries,
  createFitSeries,
  createDeconvolvedSeries,
  createResidualSeries,
  createPinnedOverlaySeries,
  createGroundTruthSpikesSeries,
  createGroundTruthCalciumSeries,
} from '../../lib/chart/series-config.ts';
import {
  showRaw,
  showFiltered,
  showFit,
  showDeconv,
  showResid,
  showGTCalcium,
  showGTSpikes,
  currentTau,
} from '../../lib/viz-store.ts';
import type { RawTraceStats } from '../../lib/multi-cell-store.ts';

export interface CaTuneZoomWindowProps {
  rawTrace: Float64Array;
  /** Precomputed z-score stats for the raw trace — immutable per session. */
  rawStats: RawTraceStats;
  deconvolvedTrace?: Float32Array;
  /** [min, max] of the deconvolved trace, precomputed on solver write. */
  deconvMinMax: [number, number];
  reconvolutionTrace?: Float32Array;
  filteredTrace?: Float32Array;
  samplingRate: number;
  startTime: number;
  endTime: number;
  height?: number;
  syncKey: string;
  onZoomChange?: (startTime: number, endTime: number) => void;
  deconvWindowOffset?: number;
  pinnedDeconvolved?: Float32Array;
  /** [min, max] of the pinned deconvolved trace, snapshotted on pin. */
  pinnedDeconvMinMax?: [number, number];
  pinnedReconvolution?: Float32Array;
  pinnedWindowOffset?: number;
  'data-tutorial'?: string;
  groundTruthSpikes?: Float64Array;
  groundTruthCalcium?: Float64Array;
}

const MIN_BUCKET_WIDTH = 300;
const MAX_BUCKET_WIDTH = 1200;
const DECONV_GAP = -2;
const DECONV_SCALE = 0.35;
const RESID_GAP = 0.5;
const RESID_SCALE = 0.25;
const TRANSIENT_TAU_MULTIPLIER = 2;

const SERIES_COUNT = 10;

function emptySeriesData(): [number[], ...number[][]] {
  return Array.from({ length: SERIES_COUNT }, () => []) as unknown as [number[], ...number[][]];
}

/** Compute [min, max] of a typed array, returning [0, 1] for empty/missing input. */
function typedArrayMinMax(arr: ArrayLike<number> | undefined): [number, number] {
  if (!arr || arr.length === 0) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < lo) lo = arr[i];
    if (arr[i] > hi) hi = arr[i];
  }
  return [lo, hi];
}

export function CaTuneZoomWindow(props: CaTuneZoomWindowProps) {
  let containerRef: HTMLDivElement | undefined;
  const [chartWidth, setChartWidth] = createSignal(600);

  const transientTime = createMemo(() => {
    return TRANSIENT_TAU_MULTIPLIER * currentTau().tauDecay;
  });

  onMount(() => {
    if (!containerRef) return;
    setChartWidth(containerRef.clientWidth || 600);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setChartWidth(w);
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());
  });

  const bucketWidth = () =>
    Math.max(MIN_BUCKET_WIDTH, Math.min(MAX_BUCKET_WIDTH, Math.round(chartWidth())));

  const globalYRange = createMemo<[number, number]>(() => {
    const raw = props.rawTrace;
    const { zMin, zMax } = props.rawStats;
    if (!raw || raw.length === 0) return [-4, 6];
    const rawRange = zMax - zMin;
    const deconvHeight = rawRange * DECONV_SCALE;
    const deconvBottom = zMin - DECONV_GAP - deconvHeight;
    const residHeight = rawRange * RESID_SCALE;
    const residBottom = deconvBottom - RESID_GAP - residHeight;
    return [residBottom, zMax + rawRange * 0.02];
  });

  // Ground-truth spike min/max is recomputed here rather than in the store
  // because GT is loaded once per session and swapping the reference via
  // toggle/visibility is infrequent — memoization amortizes it.
  const gtSpikesMinMax = createMemo(() => typedArrayMinMax(props.groundTruthSpikes));

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
    if (windowStart >= 0 && windowEnd <= trace.length) {
      const slice = trace.subarray(windowStart, windowEnd);
      const [, dsValues] = downsampleMinMax(x, slice, bucketWidth());
      return transform(dsValues);
    }
    if (trace.length === rawLength) {
      const slice = trace.subarray(startSample, endSample);
      const [, dsValues] = downsampleMinMax(x, slice, bucketWidth());
      return transform(dsValues);
    }
    return new Array(dsXLength).fill(null) as number[];
  };

  const scaleToDeconvBand = (
    dsDeconvRaw: number[],
    deconvMinMaxPair: [number, number],
    zMin: number,
    zMax: number,
  ): number[] => {
    const [dMin, dMax] = deconvMinMaxPair;
    const dRange = dMax - dMin || 1;
    const deconvHeight = (zMax - zMin) * DECONV_SCALE;
    const deconvTop = zMin - DECONV_GAP;
    const deconvBottom = deconvTop - deconvHeight;
    return dsDeconvRaw.map((v) => {
      const norm = (v - dMin) / dRange;
      return deconvBottom + norm * deconvHeight;
    });
  };

  const computeResiduals = (
    dsRaw: number[],
    dsReconv: (number | null)[],
    zMin: number,
    zMax: number,
    dsXLength: number,
  ): number[] => {
    if (!dsReconv.some((v) => v !== null)) {
      return new Array(dsXLength).fill(null) as number[];
    }
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
      if (dsReconv[i] == null) {
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
      const norm = (r - rMin) / rRange;
      return residBottom + norm * residHeight;
    });
  };

  const zoomData = createMemo<[number[], ...number[][]]>(() => {
    const raw = props.rawTrace;
    const fs = props.samplingRate;
    if (!raw || raw.length === 0) return emptySeriesData();

    const startSample = Math.max(0, Math.floor(props.startTime * fs));
    const endSample = Math.min(raw.length, Math.ceil(props.endTime * fs));
    if (startSample >= endSample) return emptySeriesData();

    const len = endSample - startSample;
    const { mean, std, zMin, zMax } = props.rawStats;

    const x = new Float64Array(len);
    const dt = 1 / fs;
    for (let i = 0; i < len; i++) {
      x[i] = (startSample + i) * dt;
    }

    const rawSlice = raw.subarray(startSample, endSample);
    const [dsX, dsRawRaw] = downsampleMinMax(x, rawSlice, bucketWidth());
    const dsRaw = dsRawRaw.map((v) => (v - mean) / std);

    const offset = props.deconvWindowOffset ?? 0;
    const pinnedOffset = props.pinnedWindowOffset ?? 0;

    const toZScore = (values: number[]) => values.map((v) => (v - mean) / std);
    const toZScoreFiltered = (values: number[]) => values.map((v) => v / std);

    const dsFiltered = sliceAndDownsample(
      props.filteredTrace,
      x,
      startSample,
      endSample,
      offset,
      raw.length,
      dsX.length,
      props.filteredTrace ? toZScoreFiltered : toZScore,
    );

    const dsReconv: (number | null)[] = sliceAndDownsample(
      props.reconvolutionTrace,
      x,
      startSample,
      endSample,
      offset,
      raw.length,
      dsX.length,
      props.filteredTrace ? toZScoreFiltered : toZScore,
    );

    // Untrack: transientZonePlugin draws the gray overlay at uPlot draw time
    // using the live transientTime accessor. Tracking it here too would
    // re-downsample every visible card on every tau slider tick — the big
    // reason Peak/FWHM drags felt laggier than Sparsity.
    const transient = untrack(() => transientTime());
    if (startSample < transient * fs) {
      for (let i = 0; i < dsReconv.length; i++) {
        if (dsX[i] < transient) {
          dsReconv[i] = null;
        } else {
          break;
        }
      }
    }

    // The mapper closures below read signals; they're invoked synchronously
    // by sliceAndDownsample from within this memo's tracked scope.
    /* eslint-disable solid/reactivity */
    const dsDeconv = sliceAndDownsample(
      props.deconvolvedTrace,
      x,
      startSample,
      endSample,
      offset,
      raw.length,
      dsX.length,
      (vals) => scaleToDeconvBand(vals, props.deconvMinMax, zMin, zMax),
    );

    const dsResid = computeResiduals(dsRaw, dsReconv, zMin, zMax, dsX.length);

    const dsPinnedReconv = sliceAndDownsample(
      props.pinnedReconvolution,
      x,
      startSample,
      endSample,
      pinnedOffset,
      raw.length,
      dsX.length,
      toZScore,
    );

    const dsPinnedDeconv = sliceAndDownsample(
      props.pinnedDeconvolved,
      x,
      startSample,
      endSample,
      pinnedOffset,
      raw.length,
      dsX.length,
      (vals) => scaleToDeconvBand(vals, props.pinnedDeconvMinMax ?? [0, 0], zMin, zMax),
    );
    /* eslint-enable solid/reactivity */

    let dsGTCalcium: number[];
    if (props.groundTruthCalcium && props.groundTruthCalcium.length > 0) {
      const gtcSlice = props.groundTruthCalcium.subarray(startSample, endSample);
      const [, dsGTCRaw] = downsampleMinMax(x, gtcSlice, bucketWidth());
      dsGTCalcium = dsGTCRaw.map((v) => (v - mean) / std);
    } else {
      dsGTCalcium = new Array(dsX.length).fill(null) as number[];
    }

    let dsGTSpikes: number[];
    if (props.groundTruthSpikes && props.groundTruthSpikes.length > 0) {
      const gtsSlice = props.groundTruthSpikes.subarray(startSample, endSample);
      const [, dsGTSRaw] = downsampleMinMax(x, gtsSlice, bucketWidth());
      dsGTSpikes = scaleToDeconvBand(dsGTSRaw, gtSpikesMinMax(), zMin, zMax);
    } else {
      dsGTSpikes = new Array(dsX.length).fill(null) as number[];
    }

    return [
      dsX,
      dsRaw,
      dsFiltered,
      dsDeconv,
      dsReconv as number[],
      dsResid,
      dsPinnedDeconv,
      dsPinnedReconv,
      dsGTCalcium,
      dsGTSpikes,
    ];
  });

  const seriesConfig = createMemo<uPlot.Series[]>(() => {
    const base: uPlot.Series[] = [{}, { ...createRawSeries(), show: showRaw() }];
    base.push(
      props.filteredTrace
        ? { ...createFilteredSeries(), show: showFiltered() }
        : ({ show: false } as uPlot.Series),
    );
    base.push(
      { ...createDeconvolvedSeries(), show: showDeconv() },
      { ...createFitSeries(), show: showFit() },
      { ...createResidualSeries(), show: showResid() },
    );
    base.push({ ...createPinnedOverlaySeries('Pinned Deconv', '#2ca02c', 1), show: showDeconv() });
    base.push({ ...createPinnedOverlaySeries('Pinned Fit', '#ff7f0e', 1.5), show: showFit() });
    base.push(
      props.groundTruthCalcium
        ? { ...createGroundTruthCalciumSeries(), show: showGTCalcium() }
        : ({ show: false } as uPlot.Series),
    );
    base.push(
      props.groundTruthSpikes
        ? { ...createGroundTruthSpikesSeries(), show: showGTSpikes() }
        : ({ show: false } as uPlot.Series),
    );
    return base;
  });

  const totalDuration = () => props.rawTrace.length / props.samplingRate;

  return (
    <div ref={containerRef} style={{ height: '100%' }}>
      <ZoomWindow
        data={() => zoomData()}
        series={seriesConfig}
        totalDuration={totalDuration()}
        startTime={props.startTime}
        endTime={props.endTime}
        height={props.height}
        syncKey={props.syncKey}
        onZoomChange={props.onZoomChange}
        yRange={globalYRange()}
        plugins={[transientZonePlugin(transientTime)]}
        data-tutorial={props['data-tutorial']}
      />
    </div>
  );
}
