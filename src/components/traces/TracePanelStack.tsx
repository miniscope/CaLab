/**
 * Three synchronized trace panels stacked vertically:
 * 1. Raw + Reconvolution Fit (with optional pinned overlay)
 * 2. Deconvolved Activity (with optional pinned overlay)
 * 3. Residuals (raw - reconvolution)
 *
 * All panels share cursor sync and zoom sync via the sync manager.
 * Data is downsampled per-pixel-bucket before rendering for 100K+ performance.
 *
 * When a snapshot is pinned, dimmed dashed overlay lines appear behind the
 * current fit for before/after comparison.
 */

import { createMemo } from 'solid-js';
import type uPlot from 'uplot';
import { TracePanel } from './TracePanel';
import { downsampleMinMax } from '../../lib/chart/downsample';
import { createZoomSyncPlugin } from '../../lib/chart/sync-manager';
import {
  rawTrace,
  deconvolvedTrace,
  reconvolutionTrace,
  residualTrace,
  pinnedDeconvolved,
  pinnedReconvolution,
} from '../../lib/viz-store';
import { samplingRate } from '../../lib/data-store';

const SYNC_KEY = 'catune-traces';
const DEFAULT_BUCKET_WIDTH = 1200;

export function TracePanelStack() {
  // Chart refs for zoom sync propagation
  let chartRefs: (uPlot | undefined)[] = [undefined, undefined, undefined];

  // Zoom sync plugin: propagates x-scale changes across all three panels
  const zoomSyncPlugin = createZoomSyncPlugin(
    chartRefs.map((_, i) => () => chartRefs[i]),
  );

  // Generate time axis from sampling rate and trace length
  function makeTimeAxis(length: number): Float64Array {
    const fs = samplingRate() ?? 30;
    const dt = 1 / fs;
    const x = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      x[i] = i * dt;
    }
    return x;
  }

  // Panel 1: Raw + Reconvolution Fit (with optional pinned fit overlay)
  const rawFitData = createMemo<[number[], ...number[][]]>(() => {
    const raw = rawTrace();
    const reconv = reconvolutionTrace();
    if (!raw || raw.length === 0) return [[], [], []];

    const x = makeTimeAxis(raw.length);

    // Downsample both raw and reconvolution to the SAME x buckets
    const [dsX, dsRawY] = downsampleMinMax(x, raw, DEFAULT_BUCKET_WIDTH);

    const reconvSeries = reconv && reconv.length === raw.length
      ? downsampleMinMax(x, reconv, DEFAULT_BUCKET_WIDTH)[1]
      : new Array(dsX.length).fill(null) as number[];

    // Check for pinned reconvolution overlay
    const pinned = pinnedReconvolution();
    if (pinned && pinned.length === raw.length) {
      const [, dsPinnedY] = downsampleMinMax(x, pinned, DEFAULT_BUCKET_WIDTH);
      return [dsX, dsRawY, reconvSeries, dsPinnedY];
    }

    return [dsX, dsRawY, reconvSeries];
  });

  // Panel 2: Deconvolved Activity (with optional pinned overlay)
  const deconvolvedData = createMemo<[number[], ...number[][]]>(() => {
    const deconv = deconvolvedTrace();
    if (!deconv || deconv.length === 0) return [[], []];

    const x = makeTimeAxis(deconv.length);
    const [dsX, dsY] = downsampleMinMax(x, deconv, DEFAULT_BUCKET_WIDTH);

    // Check for pinned deconvolved overlay
    const pinned = pinnedDeconvolved();
    if (pinned && pinned.length === deconv.length) {
      const [, dsPinnedY] = downsampleMinMax(x, pinned, DEFAULT_BUCKET_WIDTH);
      return [dsX, dsY, dsPinnedY];
    }

    return [dsX, dsY];
  });

  // Panel 3: Residuals
  const residualData = createMemo<[number[], ...number[][]]>(() => {
    const resid = residualTrace();
    if (!resid || resid.length === 0) return [[], []];

    const x = makeTimeAxis(resid.length);
    const [dsX, dsY] = downsampleMinMax(x, resid, DEFAULT_BUCKET_WIDTH);
    return [dsX, dsY];
  });

  // Reactive series configs -- must match data array length
  // uPlot requires series.length === data.length

  const rawFitSeriesConfig = createMemo<uPlot.Series[]>(() => {
    const baseSeries: uPlot.Series[] = [
      {}, // x-axis placeholder
      {
        label: 'Raw',
        stroke: 'hsl(200, 60%, 50%)',
        width: 1,
      },
      {
        label: 'Fit',
        stroke: 'hsl(30, 90%, 60%)',
        width: 1.5,
      },
    ];

    // Add pinned fit series when pinned data is present
    const pinned = pinnedReconvolution();
    const raw = rawTrace();
    if (pinned && raw && pinned.length === raw.length) {
      baseSeries.push({
        label: 'Pinned Fit',
        stroke: 'hsla(30, 90%, 60%, 0.35)',
        width: 1.5,
        dash: [4, 4],
      });
    }

    return baseSeries;
  });

  const deconvolvedSeriesConfig = createMemo<uPlot.Series[]>(() => {
    const baseSeries: uPlot.Series[] = [
      {},
      {
        label: 'Deconvolved',
        stroke: 'hsl(120, 70%, 50%)',
        width: 1,
      },
    ];

    // Add pinned deconvolved series when pinned data is present
    const pinned = pinnedDeconvolved();
    const deconv = deconvolvedTrace();
    if (pinned && deconv && pinned.length === deconv.length) {
      baseSeries.push({
        label: 'Pinned Deconvolved',
        stroke: 'hsla(120, 70%, 50%, 0.35)',
        width: 1,
        dash: [4, 4],
      });
    }

    return baseSeries;
  });

  const residualSeries: uPlot.Series[] = [
    {},
    {
      label: 'Residuals',
      stroke: 'hsl(0, 70%, 60%)',
      width: 1,
    },
  ];

  return (
    <div class="trace-stack">
      {/* Panel 1: Raw + Reconvolution Fit */}
      <div class="trace-stack__panel">
        <h4 class="panel-label">Raw + Fit</h4>
        <TracePanel
          data={() => rawFitData()}
          series={rawFitSeriesConfig()}
          height={180}
          syncKey={SYNC_KEY}
          plugins={[zoomSyncPlugin]}
        />
      </div>

      {/* Panel 2: Deconvolved Activity */}
      <div class="trace-stack__panel">
        <h4 class="panel-label">Deconvolved Activity</h4>
        <TracePanel
          data={() => deconvolvedData()}
          series={deconvolvedSeriesConfig()}
          height={140}
          syncKey={SYNC_KEY}
          plugins={[zoomSyncPlugin]}
        />
      </div>

      {/* Panel 3: Residuals */}
      <div class="trace-stack__panel">
        <h4 class="panel-label">Residuals</h4>
        <TracePanel
          data={() => residualData()}
          series={residualSeries}
          height={140}
          syncKey={SYNC_KEY}
          plugins={[zoomSyncPlugin]}
        />
      </div>
    </div>
  );
}
