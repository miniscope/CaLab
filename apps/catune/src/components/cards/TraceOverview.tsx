/**
 * Multi-row full-trace overview with interactive minimap.
 * Draws the entire recording as a thin canvas, split into rows of ~20min.
 * Highlighted region shows the current zoom window position.
 * Click/drag to reposition the zoom window.
 */

import { createEffect, createMemo, onCleanup, onMount } from 'solid-js';
import { downsampleMinMax, makeTimeAxis } from '@calab/compute';

export interface TraceOverviewProps {
  trace: Float64Array;
  samplingRate: number;
  /** Zoom window start time (seconds) */
  zoomStart: number;
  /** Zoom window end time (seconds) */
  zoomEnd: number;
  /** Called when the user clicks/drags to reposition the zoom window */
  onZoomChange: (startTime: number, endTime: number) => void;
}

const ROW_HEIGHT = 24;
const ROW_DURATION_S = 20 * 60; // 20 minutes per row
const PIXELS_PER_ROW = 600; // target downsample width per row

export function TraceOverview(props: TraceOverviewProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;

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

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowY = r * ROW_HEIGHT;
      const rowDuration = r < rows.length - 1 ? ROW_DURATION_S : duration - r * ROW_DURATION_S;

      // Draw zoom window highlight for this row
      const zoomStart = props.zoomStart;
      const zoomEnd = props.zoomEnd;
      const rowStartTime = row.timeOffset;
      const rowEndTime = rowStartTime + rowDuration;

      if (zoomEnd > rowStartTime && zoomStart < rowEndTime) {
        const hlStart = Math.max(0, (zoomStart - rowStartTime) / rowDuration) * width;
        const hlEnd = Math.min(1, (zoomEnd - rowStartTime) / rowDuration) * width;
        ctx.fillStyle = 'rgba(33, 113, 181, 0.1)';
        ctx.fillRect(hlStart, rowY, hlEnd - hlStart, ROW_HEIGHT);

        // Border lines for highlight
        ctx.strokeStyle = 'rgba(33, 113, 181, 0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(hlStart, rowY, hlEnd - hlStart, ROW_HEIGHT);
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

  createEffect(() => {
    // Track reactive dependencies (SolidJS signal access pattern)
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    props.trace;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    props.zoomStart;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    props.zoomEnd;
    draw();
  });

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
    const rowDuration =
      rowIndex < rows.length - 1 ? ROW_DURATION_S : duration - rowIndex * ROW_DURATION_S;

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

  // Click + drag handler for repositioning zoom window
  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
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
      style={{ cursor: 'grab' }}
    >
      <canvas ref={canvasRef} class="trace-overview__canvas" />
    </div>
  );
}
