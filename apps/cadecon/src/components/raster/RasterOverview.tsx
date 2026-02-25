// RasterOverview - Canvas-based TxN heatmap with subset rectangle overlays
// Cells on y-axis, time on x-axis, viridis colormap

import { onMount, onCleanup, createEffect } from 'solid-js';
import { parsedData, effectiveShape, swapped } from '../../lib/data-store.ts';
import {
  subsetRectangles,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
} from '../../lib/subset-store.ts';
import '../../styles/raster.css';

// Viridis colormap (sampled at 256 points)
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

// Subset rectangle colors (distinct, muted)
const SUBSET_COLORS = [
  'rgba(255, 99, 71, 0.7)',
  'rgba(30, 144, 255, 0.7)',
  'rgba(50, 205, 50, 0.7)',
  'rgba(255, 215, 0, 0.7)',
  'rgba(186, 85, 211, 0.7)',
  'rgba(255, 140, 0, 0.7)',
  'rgba(0, 206, 209, 0.7)',
  'rgba(255, 105, 180, 0.7)',
  'rgba(124, 252, 0, 0.7)',
  'rgba(100, 149, 237, 0.7)',
  'rgba(244, 164, 96, 0.7)',
  'rgba(147, 112, 219, 0.7)',
  'rgba(60, 179, 113, 0.7)',
  'rgba(255, 69, 0, 0.7)',
  'rgba(72, 209, 204, 0.7)',
  'rgba(218, 112, 214, 0.7)',
  'rgba(154, 205, 50, 0.7)',
  'rgba(176, 196, 222, 0.7)',
  'rgba(255, 182, 193, 0.7)',
  'rgba(32, 178, 170, 0.7)',
];

export function RasterOverview() {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  // Cache pixel dimensions for click detection
  let lastWidth = 0;
  let lastHeight = 0;

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
    const displayHeight = Math.min(Math.max(200, N * 3), 500);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    ctx.scale(dpr, dpr);

    lastWidth = displayWidth;
    lastHeight = displayHeight;

    // Compute 1st and 99th percentile for scaling
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

    // Draw heatmap: each pixel maps to a block of data
    const imageData = ctx.createImageData(displayWidth, displayHeight);
    const pixels = imageData.data;

    for (let py = 0; py < displayHeight; py++) {
      const cell = Math.floor((py / displayHeight) * N);
      for (let px = 0; px < displayWidth; px++) {
        const t = Math.floor((px / displayWidth) * T);

        let idx: number;
        if (isSwapped) {
          idx = t * rawCols + cell;
        } else {
          idx = cell * rawCols + t;
        }

        const v = typedData[idx];
        const normalized = Number.isFinite(v)
          ? Math.max(0, Math.min(255, Math.round(((v - p1) / range) * 255)))
          : 0;

        const offset = (py * displayWidth + px) * 4;
        pixels[offset] = VIRIDIS_LUT[normalized * 3];
        pixels[offset + 1] = VIRIDIS_LUT[normalized * 3 + 1];
        pixels[offset + 2] = VIRIDIS_LUT[normalized * 3 + 2];
        pixels[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Draw subset rectangles
    const rects = subsetRectangles();
    const selected = selectedSubsetIdx();

    for (const r of rects) {
      const x = (r.tStart / T) * displayWidth;
      const w = ((r.tEnd - r.tStart) / T) * displayWidth;
      const y = (r.cellStart / N) * displayHeight;
      const h = ((r.cellEnd - r.cellStart) / N) * displayHeight;

      ctx.strokeStyle = SUBSET_COLORS[r.idx % SUBSET_COLORS.length];
      ctx.lineWidth = r.idx === selected ? 3 : 1.5;
      ctx.strokeRect(x, y, w, h);

      // Label
      ctx.fillStyle = SUBSET_COLORS[r.idx % SUBSET_COLORS.length];
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText(`K${r.idx + 1}`, x + 3, y + 13);
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
  createEffect(() => {
    parsedData();
    effectiveShape();
    swapped();
    subsetRectangles();
    selectedSubsetIdx();
    drawRaster();
  });

  return (
    <div class="raster-container" ref={containerRef}>
      <canvas ref={canvasRef} class="raster-canvas" onClick={handleClick} />
    </div>
  );
}
