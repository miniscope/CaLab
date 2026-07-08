import { onMount, onCleanup, createEffect, createMemo, on, type JSX } from 'solid-js';
import { parsedData, effectiveShape, swapped, durationSeconds } from '../../lib/data-store.ts';
import {
  subsetRectangles,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
} from '../../lib/subset-store.ts';
import { VIRIDIS_LUT, niceTicks, AXIS_TEXT } from '@calab/ui/chart';
import '../../styles/raster.css';

// Plot margins (CSS px) reserved for the cell axis (left) and time axis
// (bottom); the heatmap fills the inner plot rect. No intensity colorbar —
// viridis runs low→high activity and the absolute values aren't meaningful.
// Right margin is just enough to keep the last time-axis label from clipping.
const MARGIN_LEFT = 42;
const MARGIN_RIGHT = 14;
const MARGIN_TOP = 10;
const MARGIN_BOTTOM = 30;

// High-contrast colors chosen to stand out against viridis (purple-teal-yellow):
// warm reds, oranges, and pinks that don't appear in the viridis palette. This
// is deliberately NOT the categorical Okabe-Ito series palette — the goal here
// is contrast against the colormap, not distinctness among many series.
const SUBSET_STROKE = [
  '#ff3333', // red
  '#ff8800', // orange
  '#ff33aa', // magenta
  '#ffffff', // white
  '#ff5555', // coral
  '#ffaa00', // amber
  '#ff55cc', // pink
  '#cccccc', // silver
];

const SUBSET_FILL = [
  'rgba(255, 51, 51, 0.12)',
  'rgba(255, 136, 0, 0.12)',
  'rgba(255, 51, 170, 0.12)',
  'rgba(255, 255, 255, 0.12)',
  'rgba(255, 85, 85, 0.12)',
  'rgba(255, 170, 0, 0.12)',
  'rgba(255, 85, 204, 0.12)',
  'rgba(204, 204, 204, 0.12)',
];

/** Format an axis value: integers plain, otherwise one decimal. */
function formatTick(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function RasterOverview(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  // Cached inner plot rect (CSS px) for click hit-testing against subset boxes.
  let plotX = MARGIN_LEFT;
  let plotY = MARGIN_TOP;
  let plotW = 0;
  let plotH = 0;

  /** Memoized 1st/99th percentile bounds -- recomputed only when the underlying data changes. */
  const percentileBounds = createMemo(() => {
    const data = parsedData();
    if (!data) return { p1: 0, p99: 1, range: 1 };

    const typedData = data.data;
    const sampleSize = Math.min(typedData.length, 100000);
    const step = Math.max(1, Math.floor(typedData.length / sampleSize));
    const samples: number[] = [];
    for (let i = 0; i < typedData.length; i += step) {
      const v = typedData[i];
      if (Number.isFinite(v)) samples.push(v);
    }
    samples.sort((a, b) => a - b);
    const p1 = samples[Math.floor(samples.length * 0.01)] ?? 0;
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? 1;
    const range = p99 - p1 || 1;
    return { p1, p99, range };
  });

  const drawRaster = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return;

    const [N, T] = shape;
    const typedData = data.data;
    const isSwapped = swapped();
    const rawCols = data.shape[1];

    const rect = containerRef?.getBoundingClientRect();
    const displayWidth = rect?.width ?? 800;
    const displayHeight = rect?.height ?? Math.min(Math.max(200, N * 3), 500);
    const dpr = window.devicePixelRatio || 1;

    // Size canvas at physical resolution (also resets ctx transform to identity)
    const physW = Math.round(displayWidth * dpr);
    const physH = Math.round(displayHeight * dpr);
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    // Inner plot rect (CSS px) — cached for click hit-testing.
    plotX = MARGIN_LEFT;
    plotY = MARGIN_TOP;
    plotW = Math.max(1, displayWidth - MARGIN_LEFT - MARGIN_RIGHT);
    plotH = Math.max(1, displayHeight - MARGIN_TOP - MARGIN_BOTTOM);

    const { p1, range } = percentileBounds();

    // Draw heatmap into the plot rect at physical resolution (putImageData
    // ignores canvas transforms, so position/size in physical pixels).
    const ppX = Math.round(plotX * dpr);
    const ppY = Math.round(plotY * dpr);
    const ppW = Math.max(1, Math.round(plotW * dpr));
    const ppH = Math.max(1, Math.round(plotH * dpr));
    const imageData = ctx.createImageData(ppW, ppH);
    const pixels = imageData.data;

    for (let py = 0; py < ppH; py++) {
      const cell = Math.floor((py / ppH) * N);
      const rowBase = isSwapped ? cell : cell * rawCols;
      const rowPixelBase = py * ppW;
      for (let px = 0; px < ppW; px++) {
        const t = Math.floor((px / ppW) * T);
        const v = typedData[isSwapped ? t * rawCols + rowBase : rowBase + t];
        const normalized = Number.isFinite(v)
          ? Math.max(0, Math.min(255, Math.round(((v - p1) / range) * 255)))
          : 0;

        const offset = (rowPixelBase + px) * 4;
        pixels[offset] = VIRIDIS_LUT[normalized * 3];
        pixels[offset + 1] = VIRIDIS_LUT[normalized * 3 + 1];
        pixels[offset + 2] = VIRIDIS_LUT[normalized * 3 + 2];
        pixels[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, ppX, ppY);

    // All subsequent vector drawing is in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawAxes(ctx, N, T);
    drawSubsets(ctx, N, T);
  };

  /** Time axis (bottom) + cell axis (left). */
  const drawAxes = (ctx: CanvasRenderingContext2D, N: number, T: number) => {
    ctx.fillStyle = AXIS_TEXT;
    ctx.strokeStyle = AXIS_TEXT;
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';

    // Time axis: seconds when the sampling rate is known, else frame index.
    const dur = durationSeconds();
    const axisMax = dur && dur > 0 ? dur : T;
    const axisUnit = dur && dur > 0 ? 's' : 'frame';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tv of niceTicks(0, axisMax, 6)) {
      if (tv > axisMax) continue;
      const xPx = plotX + (tv / axisMax) * plotW;
      ctx.beginPath();
      ctx.moveTo(xPx, plotY + plotH);
      ctx.lineTo(xPx, plotY + plotH + 4);
      ctx.stroke();
      ctx.fillText(formatTick(tv), xPx, plotY + plotH + 6);
    }
    ctx.fillText(`Time (${axisUnit})`, plotX + plotW / 2, plotY + plotH + 17);

    // Cell axis: index increasing downward.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const cv of niceTicks(0, N, 6)) {
      if (cv > N) continue;
      const yPx = plotY + (cv / N) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotX - 4, yPx);
      ctx.lineTo(plotX, yPx);
      ctx.stroke();
      ctx.fillText(String(cv), plotX - 6, yPx);
    }
    ctx.save();
    ctx.translate(11, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Cell', 0, 0);
    ctx.restore();
  };

  /** Clickable subset overlay boxes (K1..Kn), positioned within the plot rect. */
  const drawSubsets = (ctx: CanvasRenderingContext2D, N: number, T: number) => {
    const rects = subsetRectangles();
    const selected = selectedSubsetIdx();

    // Reset text alignment — drawAxes leaves it right/middle, which would
    // misplace the label inside its shaded background box.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    for (const r of rects) {
      const x = plotX + (r.tStart / T) * plotW;
      const w = ((r.tEnd - r.tStart) / T) * plotW;
      const y = plotY + (r.cellStart / N) * plotH;
      const h = ((r.cellEnd - r.cellStart) / N) * plotH;
      const colorIdx = r.idx % SUBSET_STROKE.length;
      const isSelected = r.idx === selected;

      ctx.fillStyle = SUBSET_FILL[colorIdx];
      ctx.fillRect(x, y, w, h);

      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 3;
      ctx.strokeStyle = SUBSET_STROKE[colorIdx];
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;

      const label = `K${r.idx + 1}`;
      ctx.font = 'bold 11px system-ui, sans-serif';
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(x + 2, y + 2, textW + 6, 14);
      ctx.fillStyle = SUBSET_STROKE[colorIdx];
      ctx.fillText(label, x + 5, y + 13);
    }
  };

  const handleClick = (e: MouseEvent) => {
    const canvas = canvasRef;
    if (!canvas) return;

    const shape = effectiveShape();
    if (!shape) return;

    const [N, T] = shape;
    const bRect = canvas.getBoundingClientRect();
    const mx = e.clientX - bRect.left;
    const my = e.clientY - bRect.top;

    const rects = subsetRectangles();

    // Check if click is inside any rectangle (reverse order for z-order).
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const x = plotX + (r.tStart / T) * plotW;
      const w = ((r.tEnd - r.tStart) / T) * plotW;
      const y = plotY + (r.cellStart / N) * plotH;
      const h = ((r.cellEnd - r.cellStart) / N) * plotH;

      if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
        setSelectedSubsetIdx(selectedSubsetIdx() === r.idx ? null : r.idx);
        return;
      }
    }

    // Click outside all rectangles: deselect.
    setSelectedSubsetIdx(null);
  };

  onMount(() => {
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => drawRaster());
      resizeObserver.observe(containerRef);
    }
    drawRaster();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  // Redraw when data, shape, timebase, subsets, or selection changes.
  createEffect(
    on(
      [parsedData, effectiveShape, swapped, durationSeconds, subsetRectangles, selectedSubsetIdx],
      drawRaster,
    ),
  );

  return (
    <div class="raster-container" ref={containerRef}>
      <canvas ref={canvasRef} class="raster-canvas" onClick={handleClick} />
    </div>
  );
}
