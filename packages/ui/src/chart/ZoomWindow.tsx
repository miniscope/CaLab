/**
 * Shared pan/zoom interaction shell for trace chart windows.
 * Handles: drag-to-pan, Ctrl+wheel zoom, "Hold Ctrl to zoom" hint,
 * container-width tracking for adaptive downsampling.
 */

import { createSignal, Show } from 'solid-js';
import type uPlot from 'uplot';
import { TracePanel } from './TracePanel.tsx';
import './chart-theme.css';

export interface ZoomWindowProps {
  data: () => uPlot.AlignedData;
  series: () => uPlot.Series[];
  totalDuration: number;
  startTime: number;
  endTime: number;
  height?: number;
  syncKey: string;
  onZoomChange?: (startTime: number, endTime: number) => void;
  plugins?: uPlot.Plugin[];
  yRange?: [number | undefined, number | undefined];
  xLabel?: string;
  hideYValues?: boolean;
  'data-tutorial'?: string;
}

const ZOOM_FACTOR = 0.75;
const MIN_WINDOW_S = 1;

/** Get the uPlot overlay element's bounding rect, falling back to the container. */
function getPlotRect(container: HTMLElement): DOMRect {
  const overEl = container.querySelector<HTMLElement>('.u-over');
  return (overEl ?? container).getBoundingClientRect();
}

/** Clamp a time window to [0, totalDuration], preserving its width. */
function clampWindow(
  start: number,
  end: number,
  totalDuration: number,
): [start: number, end: number] {
  const duration = end - start;
  if (start < 0) return [0, duration];
  if (end > totalDuration) return [Math.max(0, totalDuration - duration), totalDuration];
  return [start, end];
}

export function ZoomWindow(props: ZoomWindowProps) {
  const height = () => props.height ?? 150;

  const [dragging, setDragging] = createSignal(false);
  const [showHint, setShowHint] = createSignal(false);
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let containerRef: HTMLDivElement | undefined;

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !props.onZoomChange) return;

    e.preventDefault();
    setDragging(true);

    const startX = e.clientX;
    const startStart = props.startTime;
    const startEnd = props.endTime;
    const windowDuration = startEnd - startStart;
    const rect = getPlotRect(e.currentTarget as HTMLElement);
    const pxToTime = windowDuration / rect.width;
    const totalDuration = props.totalDuration;

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      const dt = -(ev.clientX - startX) * pxToTime;
      const [newStart, newEnd] = clampWindow(startStart + dt, startEnd + dt, totalDuration);
      props.onZoomChange!(newStart, newEnd);
    };

    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleWheel = (e: WheelEvent) => {
    if (!props.onZoomChange) return;

    if (!e.ctrlKey && !e.metaKey) {
      setShowHint(true);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setShowHint(false), 1500);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const totalDuration = props.totalDuration;
    const currentRange = props.endTime - props.startTime;

    const newRange =
      e.deltaY < 0
        ? Math.max(MIN_WINDOW_S, currentRange * ZOOM_FACTOR)
        : Math.min(totalDuration, currentRange / ZOOM_FACTOR);

    const rect = getPlotRect(e.currentTarget as HTMLElement);
    const cursorFraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const cursorTime = props.startTime + cursorFraction * currentRange;

    const [newStart, newEnd] = clampWindow(
      cursorTime - cursorFraction * newRange,
      cursorTime - cursorFraction * newRange + newRange,
      totalDuration,
    );
    props.onZoomChange(newStart, newEnd);
  };

  return (
    <div
      ref={containerRef}
      class="zoom-window"
      classList={{ 'zoom-window--dragging': dragging() }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      style={{ position: 'relative', cursor: dragging() ? 'grabbing' : 'grab' }}
      data-tutorial={props['data-tutorial']}
    >
      <TracePanel
        data={() => props.data() as [number[], ...number[][]]}
        series={props.series()}
        height={height()}
        syncKey={props.syncKey}
        disableWheelZoom={!!props.onZoomChange}
        yRange={props.yRange}
        hideYValues={props.hideYValues ?? true}
        xLabel={props.xLabel ?? 'Time (s)'}
        plugins={props.plugins}
      />
      <Show when={showHint()}>
        <div class="zoom-hint">Hold Ctrl to zoom</div>
      </Show>
    </div>
  );
}
