import { onMount, onCleanup, createEffect } from 'solid-js';
import { parsedData, effectiveShape, swapped } from '../../lib/data-store.ts';

const NUM_TRACES = 5;
const TRACE_COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];

/** Compute flat index into the typed array, accounting for potential dimension swap. */
function dataIndex(cell: number, timepoint: number, rawCols: number, isSwapped: boolean): number {
  return isSwapped ? timepoint * rawCols + cell : cell * rawCols + timepoint;
}

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
    const rawCols = data.shape[1];
    const tracesToShow = Math.min(NUM_TRACES, numCells);

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
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < numTimepoints; i++) {
        const v = typedData[dataIndex(t, i, rawCols, isSwapped)];
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

      const step = Math.max(1, Math.ceil(numTimepoints / displayWidth));

      for (let i = 0; i < numTimepoints; i += step) {
        const v = typedData[dataIndex(t, i, rawCols, isSwapped)];
        const x = (i / numTimepoints) * displayWidth;
        const y = Number.isFinite(v)
          ? yBase + usableHeight - (v - min) * yScale
          : yBase + usableHeight / 2;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = TRACE_COLORS[t % TRACE_COLORS.length];
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`Cell ${t}`, 4, yBase + 12);
    }
  };

  onMount(() => {
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => drawTraces());
      resizeObserver.observe(containerRef);
    }
    drawTraces();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  createEffect(() => {
    parsedData();
    effectiveShape();
    swapped();
    drawTraces();
  });

  return (
    <div class="card">
      <h3 class="card__title">Trace Preview</h3>
      <p class="text-secondary" style="margin-bottom: 12px;">
        First {NUM_TRACES} traces.
      </p>
      <div class="trace-preview" ref={containerRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
