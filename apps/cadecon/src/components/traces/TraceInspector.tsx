/**
 * TraceInspector: CaTune-style trace viewer for CaDecon.
 * Uses shared minimap (TraceOverview), zoom window (ZoomWindow), and legend (TraceLegend).
 * Shows raw + filtered + fit + deconvolved + residual with multi-band Y layout.
 * Supports iteration history scrubbing.
 */

import { createMemo, createSignal, createEffect, on, Show, type JSX } from 'solid-js';
import type uPlot from 'uplot';
import {
  computeBandLayout as computeSharedBandLayout,
  downsampleMinMax,
  residualBandSeries,
  scaleToBand,
  type BandLayout,
} from '@calab/compute';
import {
  TraceOverview,
  ZoomWindow,
  type HighlightZone,
  TRACE_COLORS,
  GROUND_TRUTH_COLORS,
  withOpacity,
} from '@calab/ui/chart';
import { TraceLegend, type LegendItemConfig } from '@calab/ui';
import { transientZonePlugin, solverInputLabel } from '@calab/ui/chart';
import {
  runState,
  cellResultLookup,
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
  groundTruthVisible,
  isDemo,
  getGroundTruthForCell,
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
  showGTCalcium,
  setShowGTCalcium,
  showGTSpikes,
  setShowGTSpikes,
  showSparsityCompare,
  setShowSparsityCompare,
  viewedIteration,
} from '../../lib/viz-store.ts';
import {
  upsampleFactor,
  noiseConstrained,
  hpFilterEnabled,
  lpFilterEnabled,
} from '../../lib/algorithm-store.ts';
import { subsetRectangles, selectedSubsetIdx } from '../../lib/subset-store.ts';
import {
  createGroundTruthCalciumSeries,
  createGroundTruthSpikesSeries,
} from '../../lib/chart/series-config.ts';
import { dataIndex } from '@calab/io';
import { reconvolveAR2 } from '../../lib/reconvolve.ts';
import { CellSelector } from './CellSelector.tsx';
import '../../styles/trace-inspector.css';

const DECONV_GAP_FRAC = 0.05;
const DECONV_SCALE = 0.35;
const RESID_GAP_FRAC = 0.05;
const RESID_SCALE = 0.25;
const TRANSIENT_TAU_MULTIPLIER = 2;
const TRACE_INSPECTOR_ZOOM_WINDOW_S = 60;
// Distinct dashed color for the sparsity-comparison overlay (the OPPOSITE setting).
const COMPARE_COLOR = '#e040fb';

/** Compute the Y-axis positions for the deconv and residual bands below the raw trace. */
function computeBandLayout(rawMin: number, rawMax: number): BandLayout {
  const rawRange = rawMax - rawMin;
  return computeSharedBandLayout(rawMin, rawMax, {
    deconvGap: rawRange * DECONV_GAP_FRAC,
    deconvScale: DECONV_SCALE,
    residGap: rawRange * RESID_GAP_FRAC,
    residScale: RESID_SCALE,
  });
}

export function TraceInspector(): JSX.Element {
  const isFinalized = () => runState() === 'complete';
  const gtVisible = createMemo(() => groundTruthVisible() && isDemo());

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

  // Cells belonging to the selected subset (null = no subset selected)
  const selectedSubsetCells = createMemo((): Set<number> | null => {
    const idx = selectedSubsetIdx();
    if (idx == null) return null;
    const rects = subsetRectangles();
    const rect = rects[idx];
    if (!rect) return null;
    const set = new Set<number>();
    for (let c = rect.cellStart; c < rect.cellEnd; c++) set.add(c);
    return set;
  });

  const effectiveCellIndex = createMemo(() => {
    const idx = inspectedCellIndex();
    const indices = cellIndices();
    if (idx != null && indices.includes(idx)) return idx;
    return indices.length > 0 ? indices[0] : null;
  });

  /** Resolve the history entry for the viewed iteration (null = use latest signals). */
  const viewedHistoryEntry = createMemo(() => {
    const iter = viewedIteration();
    if (iter == null) return null;
    return iterationHistory().find((h) => h.iteration === iter) ?? null;
  });

  // Effective result: from iteration history or latest
  const effectiveResult = createMemo((): TraceResultEntry | null => {
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;

    const histEntry = viewedHistoryEntry();
    if (histEntry) {
      // Prefer the stitched full-length result (subsetIdx=-1); fall back to first match
      let fallback: TraceResultEntry | null = null;
      for (const entry of Object.values(histEntry.results)) {
        if (entry.cellIndex === cellIdx) {
          if (entry.subsetIdx === -1) return entry;
          if (!fallback) fallback = entry;
        }
      }
      return fallback;
    }

    return cellResultLookup().get(cellIdx) ?? null;
  });

  const effectiveTauRise = createMemo(() => viewedHistoryEntry()?.tauRise ?? currentTauRise());
  const effectiveTauDecay = createMemo(() => viewedHistoryEntry()?.tauDecay ?? currentTauDecay());

  // Whether we have any result for the selected cell (used as a gate, but
  // kept separate so the expensive trace extraction below doesn't re-run
  // every time cellResultLookup updates with new iteration data).
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

  // Reconvolved trace — the solver always operates on the baseline-subtracted
  // working trace, so result.baseline is ~0. Use it directly.
  const reconvolvedTrace = createMemo((): Float32Array | null => {
    const result = effectiveResult();
    if (!result) return null;
    const tauR = effectiveTauRise();
    const tauD = effectiveTauDecay();
    const fs = samplingRate();
    if (tauR == null || tauD == null || !fs) return null;
    return reconvolveAR2(result.sCounts, tauR, tauD, fs, result.alpha, result.baseline);
  });

  // The solver's working trace: baseline-subtracted always, HP/LP-filtered when
  // those are on. Present on every result; null only before the first solve.
  const filteredTrace = createMemo(
    (): Float32Array | null => effectiveResult()?.filteredTrace ?? null,
  );
  // "Filtered" only when a filter actually ran; "Baseline-corrected" otherwise.
  const filteredLabel = () => solverInputLabel(hpFilterEnabled() || lpFilterEnabled());

  // Sparsity-comparison overlay: the opposite-setting spike counts, precomputed
  // per iteration during the run (when the comparison option is enabled) and
  // stored on the result. Read-only here — no solving on the browse path.
  const comparisonDeconv = createMemo(
    (): Float32Array | null => effectiveResult()?.comparisonSCounts ?? null,
  );
  const hasComparison = createMemo(() => comparisonDeconv() != null);

  // Labels for the two deconv traces, by their actual setting.
  const settingShort = (nc: boolean) => (nc ? 'noise-constr.' : 'standard');
  const deconvLabel = () => `Deconv (${settingShort(noiseConstrained())})`;
  const compareLabel = () => `Deconv (${settingShort(!noiseConstrained())})`;

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
  const [zoomEnd, setZoomEnd] = createSignal(TRACE_INSPECTOR_ZOOM_WINDOW_S);

  // Reset zoom only when the selected cell changes — NOT on iteration updates.
  // Uses `on()` with explicit deps to avoid tracking totalDuration/transientEnd
  // (which change every iteration due to tauDecay updates).
  createEffect(
    on(effectiveCellIndex, () => {
      const dur = totalDuration();
      if (dur <= 0) return;
      const te = transientEnd();
      setZoomStart(te);
      setZoomEnd(Math.min(te + TRACE_INSPECTOR_ZOOM_WINDOW_S, dur));
    }),
  );

  const handleZoomChange = (start: number, end: number) => {
    setZoomStart(start);
    setZoomEnd(end);
  };

  // --- Raw trace min/max for Y-range layout ---
  const rawStats = createMemo(() => {
    const raw = fullRawTrace();
    if (!raw || raw.length === 0) return { rawMin: 0, rawMax: 0 };
    let rawMin = Infinity;
    let rawMax = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v < rawMin) rawMin = v;
      if (v > rawMax) rawMax = v;
    }
    return { rawMin, rawMax };
  });

  const gtTraces = createMemo(() => {
    if (!gtVisible()) return null;
    const cellIdx = effectiveCellIndex();
    if (cellIdx == null) return null;
    return getGroundTruthForCell(cellIdx);
  });

  const globalYRange = createMemo<[number, number]>(() => {
    const { rawMin, rawMax } = rawStats();
    if (rawMin === 0 && rawMax === 0) return [-4, 6];
    const { residBottom } = computeBandLayout(rawMin, rawMax);
    return [residBottom, rawMax + (rawMax - rawMin) * 0.02];
  });

  const scaleToDeconvBand = (
    values: (number | null)[],
    yMin: number,
    yMax: number,
  ): (number | null)[] => {
    const { deconvBottom, deconvHeight } = computeBandLayout(yMin, yMax);
    return scaleToBand(values, 0, upsampleFactor(), deconvBottom, deconvHeight, {
      clampTop: true,
    });
  };

  const EMPTY_DATA: [number[], ...number[][]] = [[], [], [], [], [], [], [], [], []];
  const DOWNSAMPLE_BUCKETS = 600;

  const zoomData = createMemo<uPlot.AlignedData>(() => {
    const raw = fullRawTrace();
    const fs = samplingRate();
    if (!raw || !fs || raw.length === 0) return EMPTY_DATA;

    const startSample = Math.max(0, Math.floor(zoomStart() * fs));
    const endSample = Math.min(raw.length, Math.ceil(zoomEnd() * fs));
    if (startSample >= endSample) return EMPTY_DATA;

    const len = endSample - startSample;
    const { rawMin, rawMax } = rawStats();

    const x = new Float64Array(len);
    const dt = 1 / fs;
    for (let i = 0; i < len; i++) x[i] = (startSample + i) * dt;

    // Raw trace — plot raw fluorescence values, no normalization
    const rawSlice = raw.subarray(startSample, endSample);
    const [dsX, dsRaw] = downsampleMinMax(x, rawSlice, DOWNSAMPLE_BUCKETS);

    // Filtered trace — raw values from solver (HP/LP already applied)
    const filt = filteredTrace();
    const isFiltered = filt != null && filt.length >= endSample;
    let dsFiltered: (number | null)[];
    if (isFiltered) {
      const filtSlice = filt.subarray(startSample, endSample);
      const [, dsFilt] = downsampleMinMax(x, filtSlice, DOWNSAMPLE_BUCKETS);
      dsFiltered = dsFilt;
    } else {
      dsFiltered = new Array<null>(dsX.length).fill(null);
    }

    // Reconvolved (fit) — raw values from reconvolveAR2
    const recon = reconvolvedTrace();
    const reconSlice =
      recon && recon.length >= endSample ? recon.subarray(startSample, endSample) : null;
    let dsFit: (number | null)[];
    if (reconSlice) {
      [, dsFit] = downsampleMinMax(x, reconSlice, DOWNSAMPLE_BUCKETS);
    } else {
      dsFit = new Array<null>(dsX.length).fill(null);
    }

    // Mask transient
    const tauD = effectiveTauDecay();
    const transientTime = tauD != null ? TRANSIENT_TAU_MULTIPLIER * tauD : 0;
    let fitStartIndex = 0;
    while (fitStartIndex < len && x[fitStartIndex] < transientTime) fitStartIndex++;
    if (fitStartIndex > 0) {
      for (let i = 0; i < dsFit.length; i++) {
        if (dsX[i] < transientTime) dsFit[i] = null;
        else break;
      }
    }

    // Deconv — scaled to band below raw trace
    const result = effectiveResult();
    let dsDeconv: (number | null)[];
    if (result && result.sCounts.length >= endSample) {
      const deconvSlice = result.sCounts.subarray(startSample, endSample);
      const [, dsDeconvRaw] = downsampleMinMax(x, deconvSlice, DOWNSAMPLE_BUCKETS);
      dsDeconv = scaleToDeconvBand(dsDeconvRaw, rawMin, rawMax);
    } else {
      dsDeconv = new Array<null>(dsX.length).fill(null);
    }

    // Sparsity comparison — opposite-setting deconv, same deconv band
    const comp = comparisonDeconv();
    let dsCompare: (number | null)[];
    if (comp && comp.length >= endSample) {
      const compSlice = comp.subarray(startSample, endSample);
      const [, dsCompRaw] = downsampleMinMax(x, compSlice, DOWNSAMPLE_BUCKETS);
      dsCompare = scaleToDeconvBand(dsCompRaw, rawMin, rawMax);
    } else {
      dsCompare = new Array<null>(dsX.length).fill(null);
    }

    // Residual — compute against the working trace (what the solver actually fit)
    // computed at full resolution, then downsampled: subtracting two independently
    // min/max-downsampled series would pair unrelated samples.
    const residSource = isFiltered ? filt.subarray(startSample, endSample) : rawSlice;
    const { residBottom, residHeight } = computeBandLayout(rawMin, rawMax);
    const dsResid = residualBandSeries(
      x,
      residSource,
      reconSlice,
      DOWNSAMPLE_BUCKETS,
      residBottom,
      residHeight,
      fitStartIndex,
    );

    // Ground truth traces
    const gt = gtTraces();
    let dsGTCalcium: (number | null)[];
    let dsGTSpikes: (number | null)[];
    if (gt && gt.calcium.length >= endSample) {
      // GT calcium — raw values (same fluorescence units as raw trace)
      const gtCaSlice = gt.calcium.subarray(startSample, endSample);
      const [, dsGTCa] = downsampleMinMax(x, gtCaSlice, DOWNSAMPLE_BUCKETS);
      dsGTCalcium = dsGTCa;

      const gtSpkSlice = gt.spikes.subarray(startSample, endSample);
      const [, dsGTSpkRaw] = downsampleMinMax(x, gtSpkSlice, DOWNSAMPLE_BUCKETS);
      dsGTSpikes = scaleToDeconvBand(dsGTSpkRaw, rawMin, rawMax);
    } else {
      dsGTCalcium = new Array<null>(dsX.length).fill(null);
      dsGTSpikes = new Array<null>(dsX.length).fill(null);
    }

    return [dsX, dsRaw, dsFiltered, dsFit, dsDeconv, dsResid, dsGTCalcium, dsGTSpikes, dsCompare];
  });

  const seriesConfig = createMemo<uPlot.Series[]>(() => {
    const gtCaSeries = gtVisible()
      ? { ...createGroundTruthCalciumSeries(), show: showGTCalcium() }
      : { show: false };
    const gtSpkSeries = gtVisible()
      ? { ...createGroundTruthSpikesSeries(), show: showGTSpikes() }
      : { show: false };
    return [
      {},
      { label: 'Raw', stroke: TRACE_COLORS.raw, width: 1, show: showRaw() },
      { label: filteredLabel(), stroke: TRACE_COLORS.filtered, width: 1.5, show: showFiltered() },
      { label: 'Fit', stroke: TRACE_COLORS.fit, width: 1.5, show: showFit() },
      { label: deconvLabel(), stroke: TRACE_COLORS.deconv, width: 1, show: showDeconv() },
      { label: 'Residual', stroke: TRACE_COLORS.resid, width: 1, show: showResidual() },
      gtCaSeries,
      gtSpkSeries,
      {
        label: compareLabel(),
        stroke: COMPARE_COLOR,
        width: 1,
        dash: [4, 3],
        show: showSparsityCompare() && hasComparison(),
      },
    ];
  });

  // Legend items
  const legendItems = createMemo((): LegendItemConfig[] => {
    const items: LegendItemConfig[] = [
      {
        key: 'raw',
        color: TRACE_COLORS.raw,
        label: 'Raw',
        visible: showRaw,
        setVisible: setShowRaw,
      },
      {
        key: 'filtered',
        color: TRACE_COLORS.filtered,
        label: filteredLabel(),
        visible: showFiltered,
        setVisible: setShowFiltered,
      },
      {
        key: 'fit',
        color: TRACE_COLORS.fit,
        label: 'Fit',
        visible: showFit,
        setVisible: setShowFit,
      },
      {
        key: 'deconv',
        color: TRACE_COLORS.deconv,
        label: deconvLabel(),
        visible: showDeconv,
        setVisible: setShowDeconv,
      },
      {
        key: 'resid',
        color: TRACE_COLORS.resid,
        label: 'Resid',
        visible: showResidual,
        setVisible: setShowResidual,
      },
    ];
    if (hasComparison()) {
      items.push({
        key: 'compare',
        color: COMPARE_COLOR,
        label: compareLabel(),
        visible: showSparsityCompare,
        setVisible: setShowSparsityCompare,
        dashed: true,
      });
    }
    if (gtVisible()) {
      items.push(
        {
          key: 'gt-ca',
          color: withOpacity(GROUND_TRUTH_COLORS.calcium, 0.75),
          label: 'True Ca',
          visible: showGTCalcium,
          setVisible: setShowGTCalcium,
          dashed: true,
        },
        {
          key: 'gt-spk',
          color: withOpacity(GROUND_TRUTH_COLORS.spikes, 0.7),
          label: 'True Spk',
          visible: showGTSpikes,
          setVisible: setShowGTSpikes,
        },
      );
    }
    return items;
  });

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
  const comparisonSpikeCount = () => {
    const c = comparisonDeconv();
    return c ? c.reduce((s, v) => s + v, 0).toFixed(0) : null;
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
    <div class="trace-inspector">
      <div class="trace-inspector__header">
        <CellSelector
          cellIndices={cellIndices}
          selectedIndex={effectiveCellIndex}
          onSelect={setInspectedCellIndex}
          highlightedIndices={selectedSubsetCells}
        />
        <TraceLegend items={legendItems()} />
        <div class="trace-inspector__stats">
          <span>alpha: {alpha()}</span>
          <span>PVE: {pve()}</span>
          <Show
            when={hasComparison() && comparisonSpikeCount() != null}
            fallback={<span>spikes: {spikeCount()}</span>}
          >
            <span>
              spikes: {spikeCount()} ({settingShort(noiseConstrained())}) · {comparisonSpikeCount()}{' '}
              ({settingShort(!noiseConstrained())})
            </span>
          </Show>
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
      </Show>
    </div>
  );
}
