/**
 * CaTune-specific zoom window: z-score normalization, multi-band Y layout
 * (raw + filtered + fit in upper band, deconv below, residuals below that),
 * ground truth overlays, and pinned snapshot comparison.
 * Wraps the shared ZoomWindow from @calab/ui/chart.
 */

import { createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type uPlot from 'uplot';
import { ZoomWindow, transientZonePlugin } from '@calab/ui/chart';
import {
  computeBandLayout,
  downsampleMinMax,
  residualBandSeries,
  scaleToBand,
  type BandSpacing,
} from '@calab/compute';
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
  filterEnabled,
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
const BAND_SPACING: BandSpacing = {
  deconvGap: DECONV_GAP,
  deconvScale: DECONV_SCALE,
  residGap: RESID_GAP,
  residScale: RESID_SCALE,
};
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
    const { residBottom } = computeBandLayout(zMin, zMax, BAND_SPACING);
    return [residBottom, zMax + (zMax - zMin) * 0.02];
  });

  // Ground-truth spike min/max is recomputed here rather than in the store
  // because GT is loaded once per session and swapping the reference via
  // toggle/visibility is infrequent — memoization amortizes it.
  const gtSpikesMinMax = createMemo(() => typedArrayMinMax(props.groundTruthSpikes));

  /**
   * Full-resolution slice of `trace` aligned to raw samples [startSample, endSample),
   * or null when the trace is missing or doesn't cover that range. `offset` is the
   * raw-sample index of trace[0] for windowed solver output.
   */
  const sliceWindow = (
    trace: Float32Array | undefined,
    startSample: number,
    endSample: number,
    offset: number,
    rawLength: number,
  ): Float32Array | null => {
    if (!trace || trace.length === 0) return null;
    const windowStart = startSample - offset;
    const windowEnd = endSample - offset;
    if (windowStart >= 0 && windowEnd <= trace.length) {
      return trace.subarray(windowStart, windowEnd);
    }
    if (trace.length === rawLength) return trace.subarray(startSample, endSample);
    return null;
  };

  const sliceAndDownsample = (
    trace: Float32Array | undefined,
    x: Float64Array,
    startSample: number,
    endSample: number,
    offset: number,
    rawLength: number,
    dsXLength: number,
    transform: (dsValues: (number | null)[]) => (number | null)[],
  ): (number | null)[] => {
    const slice = sliceWindow(trace, startSample, endSample, offset, rawLength);
    if (!slice) return new Array<null>(dsXLength).fill(null);
    const [, dsValues] = downsampleMinMax(x, slice, bucketWidth());
    return transform(dsValues);
  };

  const scaleToDeconvBand = (
    dsDeconvRaw: (number | null)[],
    deconvMinMaxPair: [number, number],
    zMin: number,
    zMax: number,
  ): (number | null)[] => {
    const [dMin, dMax] = deconvMinMaxPair;
    const { deconvBottom, deconvHeight } = computeBandLayout(zMin, zMax, BAND_SPACING);
    return scaleToBand(dsDeconvRaw, dMin, dMax, deconvBottom, deconvHeight);
  };

  const zoomData = createMemo<uPlot.AlignedData>(() => {
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
    const dsRaw = dsRawRaw.map((v) => (v === null ? null : (v - mean) / std));

    const offset = props.deconvWindowOffset ?? 0;
    const pinnedOffset = props.pinnedWindowOffset ?? 0;

    const toZScore = (values: (number | null)[]) =>
      values.map((v) => (v === null ? null : (v - mean) / std));
    const toZScoreFiltered = (values: (number | null)[]) =>
      values.map((v) => (v === null ? null : v / std));

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

    const dsReconv = sliceAndDownsample(
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
    let fitStartIndex = 0;
    while (fitStartIndex < len && x[fitStartIndex] < transient) fitStartIndex++;
    if (fitStartIndex > 0) {
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

    // Residual is computed at full resolution, then downsampled: subtracting
    // two independently min/max-downsampled series pairs unrelated samples.
    // Its band normalization is affine-invariant, so z-scoring is skipped.
    const { residBottom, residHeight } = computeBandLayout(zMin, zMax, BAND_SPACING);
    const dsResid = residualBandSeries(
      x,
      rawSlice,
      sliceWindow(props.reconvolutionTrace, startSample, endSample, offset, raw.length),
      bucketWidth(),
      residBottom,
      residHeight,
      fitStartIndex,
    );

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

    let dsGTCalcium: (number | null)[];
    if (props.groundTruthCalcium && props.groundTruthCalcium.length > 0) {
      const gtcSlice = props.groundTruthCalcium.subarray(startSample, endSample);
      const [, dsGTCRaw] = downsampleMinMax(x, gtcSlice, bucketWidth());
      dsGTCalcium = toZScore(dsGTCRaw);
    } else {
      dsGTCalcium = new Array<null>(dsX.length).fill(null);
    }

    let dsGTSpikes: (number | null)[];
    if (props.groundTruthSpikes && props.groundTruthSpikes.length > 0) {
      const gtsSlice = props.groundTruthSpikes.subarray(startSample, endSample);
      const [, dsGTSRaw] = downsampleMinMax(x, gtsSlice, bucketWidth());
      dsGTSpikes = scaleToDeconvBand(dsGTSRaw, gtSpikesMinMax(), zMin, zMax);
    } else {
      dsGTSpikes = new Array<null>(dsX.length).fill(null);
    }

    return [
      dsX,
      dsRaw,
      dsFiltered,
      dsDeconv,
      dsReconv,
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
        ? { ...createFilteredSeries(filterEnabled()), show: showFiltered() }
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
