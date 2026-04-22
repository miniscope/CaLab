/**
 * Individual cell card with overview (minimap) + zoom window.
 * Self-contained visualization for one cell in the card grid.
 */

import { createSignal, createMemo, createEffect, untrack, Show } from 'solid-js';
import { TraceOverview, ROW_HEIGHT, ROW_DURATION_S } from '@calab/ui/chart';
import { CaTuneZoomWindow } from './CaTuneZoomWindow.tsx';
import { QualityBadge } from '../metrics/QualityBadge.tsx';
import type { CellSolverStatus } from '@calab/core';
import { computePeakSNR, snrToQuality } from '@calab/core';
import { Card } from '@calab/ui';
import { setHoveredCell, type RawTraceStats } from '../../lib/multi-cell-store.ts';
import { cardHeight, setCardHeight, currentTau } from '../../lib/viz-store.ts';
import { CELL_CARD_ZOOM_WINDOW_S } from '../../lib/cell-solve-manager.ts';

export interface CellCardProps {
  cellIndex: number;
  rawTrace: Float64Array;
  rawStats: RawTraceStats;
  deconvolvedTrace?: Float32Array;
  deconvMinMax: [number, number];
  reconvolutionTrace?: Float32Array;
  filteredTrace?: Float32Array;
  samplingRate: number;
  isActive?: boolean;
  solverStatus?: CellSolverStatus;
  iterationCount?: number;
  cardRef?: (el: HTMLElement) => void;
  onClick?: () => void;
  onZoomChange?: (cellIndex: number, startS: number, endS: number) => void;
  windowStartSample?: number;
  pinnedDeconvolved?: Float32Array;
  pinnedDeconvMinMax?: [number, number];
  pinnedReconvolution?: Float32Array;
  pinnedWindowStartSample?: number;
  groundTruthSpikes?: Float64Array;
  groundTruthCalcium?: Float64Array;
}

const ZOOM_SYNC_KEY = 'catune-card-zoom';

export function CellCard(props: CellCardProps) {
  const totalDuration = createMemo(() => props.rawTrace.length / props.samplingRate);

  // Grow the card to accommodate extra minimap rows beyond the first
  const numRows = createMemo(() => Math.max(1, Math.ceil(totalDuration() / ROW_DURATION_S)));
  const effectiveHeight = createMemo(() => cardHeight() + (numRows() - 1) * ROW_HEIGHT);

  // Quality badge
  const snr = createMemo(() => computePeakSNR(props.rawTrace));
  const quality = createMemo(() => snrToQuality(snr()));

  // Per-card independent zoom window — skip past the convolution transient at t=0
  const transientEnd = createMemo(() => {
    return Math.min(2 * currentTau().tauDecay, totalDuration());
  });
  // Initial zoom snapshot via `untrack` — the signals below aren't derived
  // from `transientEnd`, they're *seeded* from it. Subsequent tau or trace
  // changes are handled by the effects that follow.
  const [zoomStart, setZoomStart] = createSignal(untrack(transientEnd));
  const [zoomEnd, setZoomEnd] = createSignal(
    untrack(() => Math.min(transientEnd() + CELL_CARD_ZOOM_WINDOW_S, totalDuration())),
  );

  // Clamp zoom to duration when trace length changes.
  createEffect(() => {
    const dur = totalDuration();
    if (zoomEnd() > dur) setZoomEnd(dur);
    if (zoomEnd() <= zoomStart()) setZoomEnd(Math.min(zoomStart() + CELL_CARD_ZOOM_WINDOW_S, dur));
  });

  // When tau_decay grows, the convolution transient grows with it — push
  // zoomStart past the new transient so the user isn't staring at a region
  // dominated by edge effects. Without this the initial snapshot goes stale
  // on tuning changes.
  createEffect(() => {
    const te = transientEnd();
    if (zoomStart() < te) {
      setZoomStart(te);
      if (zoomEnd() <= te) setZoomEnd(Math.min(te + CELL_CARD_ZOOM_WINDOW_S, totalDuration()));
    }
  });

  const handleZoomChange = (start: number, end: number) => {
    setZoomStart(start);
    setZoomEnd(end);
    props.onZoomChange?.(props.cellIndex, start, end);
  };

  const statusClass = () => {
    if (props.isActive) return 'cell-card--active';
    const s = props.solverStatus ?? 'stale';
    return `cell-card--${s}`;
  };

  return (
    <Card
      class={statusClass()}
      data-cell-index={props.cellIndex}
      data-tutorial={props.isActive ? 'cell-card-active' : undefined}
      ref={props.cardRef}
      onClick={() => props.onClick?.()}
      onMouseEnter={() => setHoveredCell(props.cellIndex)}
      onMouseLeave={() => setHoveredCell(null)}
      height={effectiveHeight()}
      resizable
      onResize={setCardHeight}
    >
      <div class="cell-card__header">
        <span class="cell-card__title">
          <span data-tutorial={props.isActive ? 'convergence-indicator' : undefined}>
            <QualityBadge
              quality={quality()}
              snr={snr()}
              solverStatus={props.solverStatus}
              iterationCount={props.iterationCount}
            />
          </span>{' '}
          Cell {props.cellIndex + 1}
        </span>
      </div>

      <Show when={props.rawTrace.length > 0}>
        <div class="cell-card__overview" data-tutorial={props.isActive ? 'minimap' : undefined}>
          <TraceOverview
            trace={props.rawTrace}
            samplingRate={props.samplingRate}
            zoomStart={zoomStart()}
            zoomEnd={zoomEnd()}
            onZoomChange={handleZoomChange}
          />
        </div>

        <div class="cell-card__zoom">
          <CaTuneZoomWindow
            rawTrace={props.rawTrace}
            rawStats={props.rawStats}
            deconvolvedTrace={props.deconvolvedTrace}
            deconvMinMax={props.deconvMinMax}
            reconvolutionTrace={props.reconvolutionTrace}
            filteredTrace={props.filteredTrace}
            samplingRate={props.samplingRate}
            startTime={zoomStart()}
            endTime={zoomEnd()}
            syncKey={`${ZOOM_SYNC_KEY}-${props.cellIndex}`}
            onZoomChange={handleZoomChange}
            deconvWindowOffset={props.windowStartSample}
            pinnedDeconvolved={props.pinnedDeconvolved}
            pinnedDeconvMinMax={props.pinnedDeconvMinMax}
            pinnedReconvolution={props.pinnedReconvolution}
            pinnedWindowOffset={props.pinnedWindowStartSample}
            data-tutorial={props.isActive ? 'zoom-window' : undefined}
            groundTruthSpikes={props.groundTruthSpikes}
            groundTruthCalcium={props.groundTruthCalcium}
          />
        </div>
      </Show>
    </Card>
  );
}
