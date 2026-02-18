// TracePreview - Canvas-based trace preview of first few traces
// Minimal preview: no zoom/pan. Full plotting comes in Phase 3.

import { onMount, onCleanup, createEffect } from 'solid-js';
import {
  parsedData,
  effectiveShape,
  swapped,
} from '../../lib/data-store.ts';
import type { NumericTypedArray } from '../../lib/types.ts';

const NUM_TRACES = 5;
const TRACE_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
];

export function TracePreview() {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const drawTraces = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return;

    const [numCells, numTimepoints] = shape;
    const typedData = data.data;
    const isSwapped = swapped();
    const originalShape = data.shape;

    // Determine how to index the data based on swap state
    // Data is always stored in C order (row-major).
    // effectiveShape gives us the logical (cells, timepoints) shape.
    // If swapped, the raw data is [timepoints, cells] in memory but we want to read as [cells, timepoints].
    const rawRows = originalShape[0];
    const rawCols = originalShape[1];

    const tracesToShow = Math.min(NUM_TRACES, numCells);

    // Get container dimensions for HiDPI
    const rect = canvas.parentElement?.getBoundingClientRect();
    const displayWidth = rect?.width ?? 700;
    const displayHeight = 200;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, displayWidth, displayHeight);

    const traceHeight = displayHeight / tracesToShow;
    const padding = 2;

    for (let t = 0; t < tracesToShow; t++) {
      // Find min/max for this trace
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < numTimepoints; i++) {
        let idx: number;
        if (isSwapped) {
          // Raw data is [rawRows x rawCols], logical is [rawCols x rawRows] (swapped)
          // Cell t, timepoint i: raw index = i * rawCols + t
          idx = i * rawCols + t;
        } else {
          // Cell t, timepoint i: raw index = t * rawCols + i
          idx = t * rawCols + i;
        }
        const v = typedData[idx];
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }

      const yBase = t * traceHeight + padding;
      const usableHeight = traceHeight - padding * 2;
      const range = max - min;
      const yScale = range > 0 ? usableHeight / range : 1;

      ctx.beginPath();
      ctx.strokeStyle = TRACE_COLORS[t % TRACE_COLORS.length];
      ctx.lineWidth = 1;

      // Downsample if more points than pixels
      const step = Math.max(1, Math.ceil(numTimepoints / displayWidth));

      for (let i = 0; i < numTimepoints; i += step) {
        let idx: number;
        if (isSwapped) {
          idx = i * rawCols + t;
        } else {
          idx = t * rawCols + i;
        }
        const v = typedData[idx];
        const x = (i / numTimepoints) * displayWidth;
        const y = Number.isFinite(v)
          ? yBase + usableHeight - (v - min) * yScale
          : yBase + usableHeight / 2;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Trace label
      ctx.fillStyle = TRACE_COLORS[t % TRACE_COLORS.length];
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`Cell ${t}`, 4, yBase + 12);
    }
  };

  onMount(() => {
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => {
        drawTraces();
      });
      resizeObserver.observe(containerRef);
    }
    drawTraces();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  // Redraw when data or shape changes
  createEffect(() => {
    // Access reactive dependencies
    parsedData();
    effectiveShape();
    swapped();
    drawTraces();
  });

  return (
    <div class="card">
      <h3 class="card__title">Trace Preview</h3>
      <p class="text-secondary" style="margin-bottom: 12px;">
        First {NUM_TRACES} traces. Full interactive plotting available after parameter tuning.
      </p>
      <div class="trace-preview" ref={containerRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
