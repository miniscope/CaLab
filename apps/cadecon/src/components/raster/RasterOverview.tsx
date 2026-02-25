import { onMount, onCleanup, createEffect, createMemo, on, type JSX } from 'solid-js';
import { parsedData, effectiveShape, swapped } from '../../lib/data-store.ts';
import { dataIndex } from '../../lib/data-utils.ts';
import {
  subsetRectangles,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
} from '../../lib/subset-store.ts';
import '../../styles/raster.css';

const VIRIDIS_LUT = buildViridisLUT();

function buildViridisLUT(): Uint8Array {
  // Key stops from viridis: dark purple → teal → yellow
  const stops = [
    [68, 1, 84],
    [72, 35, 116],
    [64, 67, 135],
    [52, 94, 141],
    [41, 120, 142],
    [32, 144, 140],
    [34, 167, 132],
    [68, 190, 112],
    [121, 209, 81],
    [189, 222, 38],
    [253, 231, 37],
  ];

  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const idx = Math.floor(t);
    const frac = t - idx;
    const a = stops[Math.min(idx, stops.length - 1)];
    const b = stops[Math.min(idx + 1, stops.length - 1)];
    lut[i * 3] = Math.round(a[0] + (b[0] - a[0]) * frac);
    lut[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
    lut[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
  }
  return lut;
}

// High-contrast colors chosen to stand out against viridis (purple-teal-yellow):
// warm reds, oranges, and pinks that don't appear in the viridis palette
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

export function RasterOverview(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  // Cache pixel dimensions for click detection
  let lastWidth = 0;
  let lastHeight = 0;

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

    // Size canvas at physical resolution
    const physW = Math.round(displayWidth * dpr);
    const physH = Math.round(displayHeight * dpr);
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    lastWidth = displayWidth;
    lastHeight = displayHeight;

    const { p1, range } = percentileBounds();

    // Draw heatmap at physical pixel resolution (putImageData ignores canvas transforms)
    const imageData = ctx.createImageData(physW, physH);
    const pixels = imageData.data;

    for (let py = 0; py < physH; py++) {
      const cell = Math.floor((py / physH) * N);
      for (let px = 0; px < physW; px++) {
        const t = Math.floor((px / physW) * T);
        const v = typedData[dataIndex(cell, t, rawCols, isSwapped)];
        const normalized = Number.isFinite(v)
          ? Math.max(0, Math.min(255, Math.round(((v - p1) / range) * 255)))
          : 0;

        const offset = (py * physW + px) * 4;
        pixels[offset] = VIRIDIS_LUT[normalized * 3];
        pixels[offset + 1] = VIRIDIS_LUT[normalized * 3 + 1];
        pixels[offset + 2] = VIRIDIS_LUT[normalized * 3 + 2];
        pixels[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Draw subset rectangles (scale to CSS pixels since we skipped ctx.scale for ImageData)
    const rects = subsetRectangles();
    const selected = selectedSubsetIdx();
    ctx.scale(dpr, dpr);

    for (const r of rects) {
      const x = (r.tStart / T) * displayWidth;
      const w = ((r.tEnd - r.tStart) / T) * displayWidth;
      const y = (r.cellStart / N) * displayHeight;
      const h = ((r.cellEnd - r.cellStart) / N) * displayHeight;
      const colorIdx = r.idx % SUBSET_STROKE.length;
      const isSelected = r.idx === selected;

      // Semi-transparent fill
      ctx.fillStyle = SUBSET_FILL[colorIdx];
      ctx.fillRect(x, y, w, h);

      // Dark shadow outline for contrast against any background
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 3;
      ctx.strokeStyle = SUBSET_STROKE[colorIdx];
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;

      // Label with dark background for readability
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

    // Check if click is inside any rectangle (reverse order for z-order)
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const x = (r.tStart / T) * lastWidth;
      const w = ((r.tEnd - r.tStart) / T) * lastWidth;
      const y = (r.cellStart / N) * lastHeight;
      const h = ((r.cellEnd - r.cellStart) / N) * lastHeight;

      if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
        setSelectedSubsetIdx(selectedSubsetIdx() === r.idx ? null : r.idx);
        return;
      }
    }

    // Click outside all rectangles: deselect
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

  // Redraw when data, shape, subsets, or selection changes
  createEffect(
    on([parsedData, effectiveShape, swapped, subsetRectangles, selectedSubsetIdx], drawRaster),
  );

  return (
    <div class="raster-container" ref={containerRef}>
      <canvas ref={canvasRef} class="raster-canvas" onClick={handleClick} />
    </div>
  );
}
