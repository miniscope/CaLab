/**
 * Individual cell card with overview (minimap) + zoom window.
 * Self-contained visualization for one cell in the card grid.
 */

import { createSignal, createMemo, createEffect, Show } from 'solid-js';
import { TraceOverview, ROW_HEIGHT, ROW_DURATION_S } from './TraceOverview.tsx';
import { ZoomWindow } from './ZoomWindow.tsx';
import { QualityBadge } from '../metrics/QualityBadge.tsx';
import type { CellSolverStatus } from '@calab/core';
import { computePeakSNR, snrToQuality } from '@calab/core';
import { Card } from '@calab/ui';
import { setHoveredCell } from '../../lib/multi-cell-store.ts';
import { cardHeight, setCardHeight, tauDecay } from '../../lib/viz-store.ts';
import { DEFAULT_ZOOM_WINDOW_S } from '../../lib/cell-solve-manager.ts';

export interface CellCardProps {
  cellIndex: number;
  rawTrace: Float64Array;
  deconvolvedTrace?: Float32Array;
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
  pinnedReconvolution?: Float32Array;
  pinnedWindowStartSample?: number;
  groundTruthSpikes?: Float64Array;
  groundTruthCalcium?: Float64Array;
}

const ZOOM_SYNC_KEY = 'catune-card-zoom';

export function CellCard(props: CellCardProps) {
  const totalDuration = createMemo(() => props.rawTrace.length / props.samplingRate);

  // Auto-adjust card height so multi-row minimaps don't push the zoom window off-screen
  const numRows = createMemo(() => Math.max(1, Math.ceil(totalDuration() / ROW_DURATION_S)));
  const effectiveHeight = createMemo(() => {
    const minHeight = cardHeight() + (numRows() - 1) * ROW_HEIGHT;
    return Math.max(cardHeight(), minHeight);
  });

  // Quality badge
  const snr = createMemo(() => computePeakSNR(props.rawTrace));
  const quality = createMemo(() => snrToQuality(snr()));

  // Per-card independent zoom window — skip past the convolution transient at t=0
  const transientEnd = () => Math.min(2 * tauDecay(), totalDuration());
  const [zoomStart, setZoomStart] = createSignal(transientEnd());
  const [zoomEnd, setZoomEnd] = createSignal(
    Math.min(transientEnd() + DEFAULT_ZOOM_WINDOW_S, totalDuration()),
  );

  // Sync zoom end when trace changes
  createEffect(() => {
    const dur = totalDuration();
    if (zoomEnd() > dur) setZoomEnd(dur);
    if (zoomEnd() <= zoomStart()) setZoomEnd(Math.min(zoomStart() + DEFAULT_ZOOM_WINDOW_S, dur));
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
          <ZoomWindow
            rawTrace={props.rawTrace}
            deconvolvedTrace={props.deconvolvedTrace}
            reconvolutionTrace={props.reconvolutionTrace}
            filteredTrace={props.filteredTrace}
            samplingRate={props.samplingRate}
            startTime={zoomStart()}
            endTime={zoomEnd()}
            syncKey={`${ZOOM_SYNC_KEY}-${props.cellIndex}`}
            onZoomChange={handleZoomChange}
            deconvWindowOffset={props.windowStartSample}
            pinnedDeconvolved={props.pinnedDeconvolved}
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
