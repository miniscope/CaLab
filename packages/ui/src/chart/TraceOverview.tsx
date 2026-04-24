/**
 * Multi-row full-trace overview with interactive minimap.
 * Draws the entire recording as a thin canvas, split into rows of ~20min.
 * Highlighted region shows the current zoom window position.
 * Click/drag to reposition the zoom window.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { downsampleMinMax, makeTimeAxis } from '@calab/compute';

/** A highlighted time region drawn as a background band on the minimap. */
export interface HighlightZone {
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Fill color (e.g. 'rgba(255, 152, 0, 0.12)') */
  color: string;
  /** Optional border color */
  borderColor?: string;
}

export interface TraceOverviewProps {
  trace: Float64Array;
  samplingRate: number;
  /** Zoom window start time (seconds) */
  zoomStart: number;
  /** Zoom window end time (seconds) */
  zoomEnd: number;
  /** Called when the user clicks/drags to reposition the zoom window */
  onZoomChange: (startTime: number, endTime: number) => void;
  /** Optional background highlight zones (e.g. subset regions) */
  highlightZones?: HighlightZone[];
}

export const ROW_HEIGHT = 24;
export const ROW_DURATION_S = 20 * 60; // 20 minutes per row
const PIXELS_PER_ROW = 600; // target downsample width per row
const EDGE_HANDLE_PX = 6; // hit area radius around zoom-rect edges

export function TraceOverview(props: TraceOverviewProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  const [cursor, setCursor] = createSignal('grab');

  const totalDuration = createMemo(() => props.trace.length / props.samplingRate);
  const numRows = createMemo(() => Math.max(1, Math.ceil(totalDuration() / ROW_DURATION_S)));

  const canvasHeight = createMemo(() => numRows() * ROW_HEIGHT);

  // Compute row data once when trace changes
  const rowData = createMemo(() => {
    const trace = props.trace;
    const fs = props.samplingRate;
    const rows = numRows();
    const samplesPerRow = Math.floor(ROW_DURATION_S * fs);
    const result: { dsX: number[]; dsY: number[]; timeOffset: number }[] = [];

    for (let r = 0; r < rows; r++) {
      const start = r * samplesPerRow;
      const end = Math.min(start + samplesPerRow, trace.length);
      if (start >= trace.length) break;

      const segment = trace.subarray(start, end);
      const x = makeTimeAxis(segment.length, fs);
      const [dsX, dsY] = downsampleMinMax(x, segment, PIXELS_PER_ROW);
      result.push({ dsX, dsY, timeOffset: start / fs });
    }
    return result;
  });

  // TODO: Optimize by caching trace lines to an offscreen canvas and only
  // redrawing the zoom highlight rectangle on zoomStart/zoomEnd changes.
  // This would avoid re-stroking all trace paths on every zoom pan. Requires
  // a dual-canvas or OffscreenCanvas approach — skipped for now.
  function draw() {
    const canvas = canvasRef;
    if (!canvas) return;
    const container = containerRef;
    if (!container) return;

    const dpr = devicePixelRatio;
    const width = container.clientWidth;
    if (width <= 0) return;

    canvas.width = width * dpr;
    canvas.height = canvasHeight() * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${canvasHeight()}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, canvasHeight());

    const rows = rowData();
    const duration = totalDuration();

    // Find global min/max for consistent y-scaling
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const row of rows) {
      for (const v of row.dsY) {
        if (v < globalMin) globalMin = v;
        if (v > globalMax) globalMax = v;
      }
    }
    const yRange = globalMax - globalMin || 1;

    // Single-row traces use the actual duration so the trace fills the width;
    // multi-row traces use a fixed row duration for uniform x-axis scaling.
    const rowDuration = rows.length === 1 ? duration : ROW_DURATION_S;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowY = r * ROW_HEIGHT;
      const rowStartTime = row.timeOffset;
      const rowEndTime = rowStartTime + rowDuration;

      // Draw highlight zones (e.g. subset regions) as background bands
      const zones = props.highlightZones;
      if (zones) {
        for (const zone of zones) {
          if (zone.endTime > rowStartTime && zone.startTime < rowEndTime) {
            const zStart = Math.max(0, (zone.startTime - rowStartTime) / rowDuration) * width;
            const zEnd = Math.min(1, (zone.endTime - rowStartTime) / rowDuration) * width;
            ctx.fillStyle = zone.color;
            ctx.fillRect(zStart, rowY, zEnd - zStart, ROW_HEIGHT);
            if (zone.borderColor) {
              ctx.strokeStyle = zone.borderColor;
              ctx.lineWidth = 1;
              ctx.beginPath();
              // Draw only the left and right edges (not top/bottom) for a cleaner look
              ctx.moveTo(zStart, rowY);
              ctx.lineTo(zStart, rowY + ROW_HEIGHT);
              ctx.moveTo(zEnd, rowY);
              ctx.lineTo(zEnd, rowY + ROW_HEIGHT);
              ctx.stroke();
            }
          }
        }
      }

      // Draw zoom window highlight for this row
      const zoomStart = props.zoomStart;
      const zoomEnd = props.zoomEnd;

      if (zoomEnd > rowStartTime && zoomStart < rowEndTime) {
        const hlStart = Math.max(0, (zoomStart - rowStartTime) / rowDuration) * width;
        const hlEnd = Math.min(1, (zoomEnd - rowStartTime) / rowDuration) * width;
        ctx.fillStyle = 'rgba(33, 113, 181, 0.1)';
        ctx.fillRect(hlStart, rowY, hlEnd - hlStart, ROW_HEIGHT);

        // Border lines for highlight
        ctx.strokeStyle = 'rgba(33, 113, 181, 0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(hlStart, rowY, hlEnd - hlStart, ROW_HEIGHT);

        // Draggable edge grips — only drawn where the zoom boundary actually
        // falls within this row (not where the rect was clipped at the row edge).
        const leftEdgeVisible = zoomStart >= rowStartTime;
        const rightEdgeVisible = zoomEnd <= rowEndTime;
        const gripW = 3;
        const cy = rowY + ROW_HEIGHT / 2;
        ctx.fillStyle = 'rgba(33, 113, 181, 0.7)';
        if (leftEdgeVisible) {
          ctx.fillRect(hlStart - gripW / 2, rowY, gripW, ROW_HEIGHT);
        }
        if (rightEdgeVisible) {
          ctx.fillRect(hlEnd - gripW / 2, rowY, gripW, ROW_HEIGHT);
        }
        // White notch in each grip to hint at the drag affordance
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        if (leftEdgeVisible) {
          ctx.fillRect(hlStart - 0.5, cy - 4, 1, 8);
        }
        if (rightEdgeVisible) {
          ctx.fillRect(hlEnd - 0.5, cy - 4, 1, 8);
        }
      }

      // Draw trace line
      ctx.strokeStyle = '#1f77b4';
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let i = 0; i < row.dsX.length; i++) {
        const xPos = (row.dsX[i] / rowDuration) * width;
        const yPos = rowY + ROW_HEIGHT - ((row.dsY[i] - globalMin) / yRange) * (ROW_HEIGHT - 4) - 2;

        if (i === 0) ctx.moveTo(xPos, yPos);
        else ctx.lineTo(xPos, yPos);
      }
      ctx.stroke();
    }
  }

  createEffect(
    on(
      () => [props.trace, props.zoomStart, props.zoomEnd, props.highlightZones],
      () => draw(),
    ),
  );

  // ResizeObserver for container width changes
  let resizeRaf: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(draw);
  });

  onMount(() => {
    if (containerRef) resizeObserver.observe(containerRef);
  });

  onCleanup(() => {
    resizeObserver.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
  });

  // Convert pixel coordinates to time position
  const pixelToTime = (x: number, y: number): number | null => {
    if (!containerRef) return null;
    const width = containerRef.clientWidth;
    if (width <= 0) return null;

    const rowIndex = Math.floor(y / ROW_HEIGHT);
    const rows = rowData();
    if (rowIndex < 0 || rowIndex >= rows.length) return null;

    const row = rows[rowIndex];
    const duration = totalDuration();
    const rowDuration = rows.length === 1 ? duration : ROW_DURATION_S;

    const tFraction = Math.max(0, Math.min(1, x / width));
    return row.timeOffset + tFraction * rowDuration;
  };

  // Clamp and emit a zoom window centered on a time position
  const emitCentered = (centerTime: number, windowDuration: number) => {
    const duration = totalDuration();
    let newStart = centerTime - windowDuration / 2;
    let newEnd = newStart + windowDuration;

    if (newStart < 0) {
      newStart = 0;
      newEnd = windowDuration;
    }
    if (newEnd > duration) {
      newEnd = duration;
      newStart = Math.max(0, duration - windowDuration);
    }

    props.onZoomChange(newStart, newEnd);
  };

  // Hit-test a pointer position against the zoom rectangle. Returns which
  // part of the rect (if any) the pointer is over. An edge only counts when
  // its time boundary actually falls within the row under the cursor — this
  // avoids treating a rect that was clipped at a row boundary as a handle.
  type Region = 'left-edge' | 'right-edge' | 'body' | 'outside';
  const hitTest = (mx: number, my: number): Region => {
    if (!containerRef) return 'outside';
    const width = containerRef.clientWidth;
    if (width <= 0) return 'outside';

    const rowIndex = Math.floor(my / ROW_HEIGHT);
    const rows = rowData();
    if (rowIndex < 0 || rowIndex >= rows.length) return 'outside';

    const row = rows[rowIndex];
    const duration = totalDuration();
    const rowDuration = rows.length === 1 ? duration : ROW_DURATION_S;
    const rowStartTime = row.timeOffset;
    const rowEndTime = rowStartTime + rowDuration;

    const zoomStart = props.zoomStart;
    const zoomEnd = props.zoomEnd;
    if (zoomEnd <= rowStartTime || zoomStart >= rowEndTime) return 'outside';

    const hlStart = Math.max(0, (zoomStart - rowStartTime) / rowDuration) * width;
    const hlEnd = Math.min(1, (zoomEnd - rowStartTime) / rowDuration) * width;

    const leftEdgeVisible = zoomStart >= rowStartTime;
    const rightEdgeVisible = zoomEnd <= rowEndTime;

    if (leftEdgeVisible && Math.abs(mx - hlStart) <= EDGE_HANDLE_PX) return 'left-edge';
    if (rightEdgeVisible && Math.abs(mx - hlEnd) <= EDGE_HANDLE_PX) return 'right-edge';
    if (mx >= hlStart && mx <= hlEnd) return 'body';
    return 'outside';
  };

  // Update cursor on hover so edge handles are discoverable.
  const handleHoverMove = (e: MouseEvent) => {
    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const region = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (region === 'left-edge' || region === 'right-edge') setCursor('ew-resize');
    else if (region === 'body') setCursor('grab');
    else setCursor('crosshair');
  };

  // Drag one edge of the zoom rectangle; the opposite edge stays fixed.
  const startEdgeDrag = (side: 'left' | 'right', rect: DOMRect) => {
    const duration = totalDuration();
    const minGap = 1 / props.samplingRate; // keep at least one sample wide
    const fixedStart = props.zoomStart;
    const fixedEnd = props.zoomEnd;
    setCursor('ew-resize');

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const time = pixelToTime(mx, my);
      if (time == null) return;
      if (side === 'left') {
        const newStart = Math.max(0, Math.min(time, fixedEnd - minGap));
        props.onZoomChange(newStart, fixedEnd);
      } else {
        const newEnd = Math.min(duration, Math.max(time, fixedStart + minGap));
        props.onZoomChange(fixedStart, newEnd);
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setCursor('grab');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Click + drag handler for repositioning zoom window
  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const mx0 = e.clientX - rect.left;
    const my0 = e.clientY - rect.top;
    const region = hitTest(mx0, my0);

    if (region === 'left-edge' || region === 'right-edge') {
      startEdgeDrag(region === 'left-edge' ? 'left' : 'right', rect);
      return;
    }

    const windowDuration = props.zoomEnd - props.zoomStart;
    let dragged = false;

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      dragged = true;
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const time = pixelToTime(mx, my);
      if (time != null) emitCentered(time, windowDuration);
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (!dragged) {
        // No drag — treat as click: center on position
        const cx = ev.clientX - rect.left;
        const cy = ev.clientY - rect.top;
        const time = pixelToTime(cx, cy);
        if (time != null) emitCentered(time, windowDuration);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={containerRef}
      class="trace-overview"
      onMouseDown={handleMouseDown}
      onMouseMove={handleHoverMove}
      onMouseLeave={() => setCursor('grab')}
      style={{ cursor: cursor() }}
    >
      <canvas ref={canvasRef} class="trace-overview__canvas" />
    </div>
  );
}
