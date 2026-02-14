/**
 * Individual cell card with overview (minimap) + zoom window.
 * Self-contained visualization for one cell in the card grid.
 */

import { createSignal, createMemo, createEffect, Show } from 'solid-js';
import { TraceOverview } from './TraceOverview';
import { ZoomWindow } from './ZoomWindow';
import { QualityBadge } from '../metrics/QualityBadge';
import type { CellSolverStatus } from '../../lib/solver-types';
import { computePeakSNR, snrToQuality } from '../../lib/metrics/snr';
import { setHoveredCell } from '../../lib/multi-cell-store';

export interface CellCardProps {
  cellIndex: number;
  rawTrace: Float64Array;
  deconvolvedTrace?: Float32Array;
  reconvolutionTrace?: Float32Array;
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

const DEFAULT_ZOOM_WINDOW_S = 20; // 20 seconds default zoom window
const ZOOM_SYNC_KEY = 'catune-card-zoom';

export function CellCard(props: CellCardProps) {
  const totalDuration = createMemo(() => props.rawTrace.length / props.samplingRate);

  // Quality badge
  const snr = createMemo(() => computePeakSNR(props.rawTrace));
  const quality = createMemo(() => snrToQuality(snr()));

  // Per-card independent zoom window
  const initialEnd = () => Math.min(DEFAULT_ZOOM_WINDOW_S, totalDuration());
  const [zoomStart, setZoomStart] = createSignal(0);
  const [zoomEnd, setZoomEnd] = createSignal(initialEnd());

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
    <div
      class={`cell-card ${statusClass()}`}
      data-cell-index={props.cellIndex}
      data-tutorial={props.isActive ? 'cell-card-active' : undefined}
      ref={props.cardRef}
      onClick={() => props.onClick?.()}
      onMouseEnter={() => setHoveredCell(props.cellIndex)}
      onMouseLeave={() => setHoveredCell(null)}
    >
      <div class="cell-card__header">
        <span class="cell-card__title">
          <QualityBadge
            quality={quality()}
            snr={snr()}
            solverStatus={props.solverStatus}
            iterationCount={props.iterationCount}
          />
          {' '}Cell {props.cellIndex + 1}
        </span>
      </div>

      <Show when={props.rawTrace.length > 0}>
        <div class="cell-card__overview">
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
    </div>
  );
}
