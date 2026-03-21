/**
 * Kernel display: shows per-subset h_free curves, slow/fast fit components,
 * and the full two-component model overlaid.
 *
 * Normalization strategy:
 * - Free kernels: each peak-normalized independently (different subsets have different scales)
 * - Fit curves (slow, fast, full): all normalized by a single factor — the peak of the
 *   full model — so their relative amplitudes are preserved and they add up visually.
 * - Ground truth: peak-normalized independently (reference shape)
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
  createKernelFitSlowSeries,
  createKernelFitFastSeries,
  createKernelFitFullSeries,
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
  kernelAnnotationsPlugin,
  type KernelAnnotations,
} from '@calab/ui/chart';
import { tauToShape, computeKernelAnnotations } from '@calab/compute';

/** Format a tau value in seconds to a display string in ms with 1 decimal. */
function formatTauMs(tau: number | null, fallback: string = '--'): string {
  return tau != null ? (tau * 1000).toFixed(1) : fallback;
}

/** Format seconds to whole ms string (e.g. "120"). */
function formatMs(seconds: number): string {
  return (seconds * 1000).toFixed(0);
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

  const hasFastComponent = createMemo(() => {
    const snap = snapshot();
    return snap != null && snap.tauRiseFast > 0 && snap.tauDecayFast > 0 && snap.betaFast > 0;
  });

  // --- Derived shape metrics ---

  const slowShape = createMemo(() => {
    const tauR = currentTauRise();
    const tauD = currentTauDecay();
    if (tauR == null || tauD == null) return null;
    return tauToShape(tauR, tauD);
  });

  const fastRatio = createMemo(() => {
    const snap = snapshot();
    if (!snap || !hasFastComponent()) return null;
    const energySlow = snap.beta * (snap.tauDecay - snap.tauRise);
    const energyFast = snap.betaFast * (snap.tauDecayFast - snap.tauRiseFast);
    const total = energySlow + energyFast;
    if (total <= 0) return null;
    return (energyFast / total) * 100;
  });

  const gtShape = createMemo(() => {
    const tauR = groundTruthTauRise();
    const tauD = groundTruthTauDecay();
    if (tauR == null || tauD == null) return null;
    return tauToShape(tauR, tauD);
  });

  const annotations = createMemo((): KernelAnnotations | null => {
    const tauR = currentTauRise();
    const tauD = currentTauDecay();
    const fs = samplingRate();
    if (tauR == null || tauD == null || fs == null) return null;
    const ann = computeKernelAnnotations(tauR, tauD, fs);
    if (!ann) return null;
    return {
      peakTime: ann.peakTime * 1000,
      halfRiseTime: ann.halfRiseTime * 1000,
      halfDecayTime: ann.halfDecayTime * 1000,
      fwhm: ann.fwhm * 1000,
    };
  });

  // --- Chart data ---

  const chartData = createMemo((): uPlot.AlignedData => {
    const snap = snapshot();
    if (!snap || snap.subsets.length === 0) return [[]];

    const fs = samplingRate() ?? snap.fs;
    const tauR = snap.tauRise;
    const tauD = snap.tauDecay;
    const beta = snap.beta;
    const tauRF = snap.tauRiseFast;
    const tauDF = snap.tauDecayFast;
    const betaF = snap.betaFast;

    // Find the max kernel length across subsets
    const maxLen = Math.max(...snap.subsets.map((s) => s.hFree.length));
    if (maxLen === 0) return [[]];

    // X-axis in ms
    const xAxis = new Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      xAxis[i] = (i / fs) * 1000;
    }

    // Per-subset h_free arrays (peak-normalized independently, padded with null)
    const subsetArrays: (number | null)[][] = snap.subsets.map((s) => {
      const raw = s.hFree.slice();
      peakNormalize(raw);
      const arr: (number | null)[] = new Array(maxLen).fill(null);
      for (let i = 0; i < raw.length; i++) {
        arr[i] = raw[i];
      }
      return arr;
    });

    // Build raw (un-normalized) fit curves.
    // Slow = calcium kernel. Fast = compressed biexponential that absorbs the
    // noise artifact produced by the spike↔kernel feedback loop (same shape as
    // the slow kernel, time-scaled by compression ratio rF).
    const rawSlow: (number | null)[] = new Array(maxLen);
    const rawFast: (number | null)[] = new Array(maxLen);
    const rawFull: (number | null)[] = new Array(maxLen);
    const hasFast = tauRF > 0 && tauDF > tauRF && betaF > 0;

    for (let i = 0; i < maxLen; i++) {
      const t = i / fs; // time in seconds
      rawSlow[i] = beta * (Math.exp(-t / tauD) - Math.exp(-t / tauR));
      rawFast[i] = hasFast ? betaF * (Math.exp(-t / tauDF) - Math.exp(-t / tauRF)) : 0;
      rawFull[i] = (rawSlow[i] as number) + (rawFast[i] as number);
    }

    // Normalize all fit curves by the same factor: peak of the full model.
    // This preserves relative amplitudes so slow + fast = full visually.
    let fullPeak = 0;
    for (let i = 0; i < maxLen; i++) {
      if ((rawFull[i] as number) > fullPeak) fullPeak = rawFull[i] as number;
    }
    if (fullPeak > 1e-10) {
      for (let i = 0; i < maxLen; i++) {
        rawSlow[i] = (rawSlow[i] as number) / fullPeak;
        rawFast[i] = (rawFast[i] as number) / fullPeak;
        rawFull[i] = (rawFull[i] as number) / fullPeak;
      }
    }

    // Columns: [subsets..., slow, fast, full] — fast+full only when present
    const columns: (number | null)[][] = [...subsetArrays, rawSlow];
    if (hasFast) {
      columns.push(rawFast, rawFull);
    }

    // Ground truth kernel overlay (peak-normalized independently)
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
    s.push(createKernelFitSlowSeries());
    if (hasFastComponent()) {
      s.push(createKernelFitFastSeries());
      s.push(createKernelFitFullSeries());
    }
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
  const plugins = createMemo(() => [
    wheelZoomPlugin(),
    kernelAnnotationsPlugin(() => annotations()),
  ]);
  const cursor: uPlot.Cursor = { sync: { key: 'cadecon-kernel', setSeries: true } };

  const tauRMs = () => formatTauMs(currentTauRise());
  const tauDMs = () => formatTauMs(currentTauDecay());
  const gtTauRMs = () => formatTauMs(groundTruthTauRise());
  const gtTauDMs = () => formatTauMs(groundTruthTauDecay());

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
        {/* Primary stats — biologically meaningful shape metrics */}
        <div class="kernel-display__stats--primary">
          <Show when={slowShape()} keyed>
            {(shape) => (
              <>
                <span>
                  tPeak: <strong>{formatMs(shape.tPeak)}</strong> ms
                </span>
                <span>
                  FWHM: <strong>{formatMs(shape.fwhm)}</strong> ms
                </span>
              </>
            )}
          </Show>
          <Show when={fastRatio()}>
            <span>
              Fast: <strong>{fastRatio()!.toFixed(0)}%</strong>
            </span>
          </Show>
          <Show when={showGroundTruth() && gtShape()} keyed>
            {(shape) => (
              <>
                <span class="kernel-display__gt-stat">
                  true tPeak: <strong>{formatMs(shape.tPeak)}</strong> ms
                </span>
                <span class="kernel-display__gt-stat">
                  true FWHM: <strong>{formatMs(shape.fwhm)}</strong> ms
                </span>
              </>
            )}
          </Show>
        </div>

        {/* Secondary stats — raw tau parameters */}
        <div class="kernel-display__stats--secondary">
          <span>
            τ_r: <strong>{tauRMs()}</strong>
          </span>
          <span>
            τ_d: <strong>{tauDMs()}</strong>
          </span>
          <Show when={hasFastComponent()}>
            <span>
              τ_r_f: <strong>{formatTauMs(snapshot()?.tauRiseFast ?? null)}</strong>
            </span>
            <span>
              τ_d_f: <strong>{formatTauMs(snapshot()?.tauDecayFast ?? null)}</strong>
            </span>
          </Show>
          <Show when={showGroundTruth()}>
            <span class="kernel-display__gt-stat">
              true τ_r: <strong>{gtTauRMs()}</strong>
            </span>
            <span class="kernel-display__gt-stat">
              true τ_d: <strong>{gtTauDMs()}</strong>
            </span>
          </Show>
        </div>

        <SolidUplot
          data={chartData()}
          series={series()}
          scales={scales}
          axes={axes}
          plugins={plugins()}
          cursor={cursor}
          height={200}
          autoResize={true}
        />

        {/* Inline legend */}
        <div class="kernel-display__legend">
          <span class="kernel-display__legend-item">
            <span
              class="kernel-display__legend-swatch kernel-display__legend-swatch--dashed"
              style={{ 'border-color': '#9467bd' }}
            />
            Slow
          </span>
          <Show when={hasFastComponent()}>
            <span class="kernel-display__legend-item">
              <span
                class="kernel-display__legend-swatch kernel-display__legend-swatch--dashed"
                style={{ 'border-color': '#d62728' }}
              />
              Fast
            </span>
            <span class="kernel-display__legend-item">
              <span class="kernel-display__legend-swatch" style={{ background: '#e377c2' }} />
              Full
            </span>
          </Show>
          <Show when={showGroundTruth()}>
            <span class="kernel-display__legend-item">
              <span
                class="kernel-display__legend-swatch kernel-display__legend-swatch--dashed"
                style={{ 'border-color': 'rgba(233, 30, 99, 0.8)' }}
              />
              True
            </span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
