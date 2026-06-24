/**
 * Canvas-rendered figures for the CaDecon theory tutorial (03-theory).
 *
 * Each exported function is an `onPopoverRender` callback: it receives the
 * popover description element, injects a canvas beside the text, draws a
 * figure, and returns a cleanup function that removes it.
 *
 * Mirrors the pattern in apps/catune/src/lib/tutorial/theory-figures.ts and
 * reuses @calab/compute kernel math so the figure stays consistent with the
 * rest of CaLab.
 */

import { computeKernel, computeKernelAnnotations } from '@calab/compute';

// --- Illustrative kernel for the figure (a generic GCaMP-like shape; these are
//     display-only constants, not algorithm parameters). ---
const FIG_TAU_RISE = 0.1; // s
const FIG_TAU_DECAY = 0.6; // s
const FIG_FS = 30; // Hz

// --- Colors (match the dashboard palette) ---
const KERNEL_COLOR = 'hsl(280,70%,60%)';
const LABEL_COLOR = '#ccc';
const AXIS_COLOR = 'rgba(255,255,255,0.15)';

// --- Dimensions ---
const SINGLE_W = 400;
const SINGLE_H = 240;
const MARGIN = { top: 8, right: 12, bottom: 20, left: 8 };

/** Create a HiDPI-aware canvas sized in CSS pixels. */
function createHiDpiCanvas(width: number, height: number): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.className = 'theory-figure';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return canvas;
}

/** Draw a polyline mapping data coordinates to a pixel area. */
function drawPolyline(
  ctx: CanvasRenderingContext2D,
  xData: ArrayLike<number>,
  yData: ArrayLike<number>,
  color: string,
  lineWidth: number,
  area: { x: number; y: number; w: number; h: number },
  range: { xMin: number; xMax: number; yMin: number; yMax: number },
): void {
  const n = Math.min(xData.length, yData.length);
  if (n === 0) return;

  const { x: ax, y: ay, w: aw, h: ah } = area;
  const { xMin, xMax, yMin, yMax } = range;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (let i = 0; i < n; i++) {
    const px = ax + ((xData[i] - xMin) / xSpan) * aw;
    const py = ay + ah - ((yData[i] - yMin) / ySpan) * ah;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/** Draw a dashed vertical annotation line. */
function drawDashedVertical(
  ctx: CanvasRenderingContext2D,
  x: number,
  yTop: number,
  yBot: number,
  color: string,
): void {
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yBot);
  ctx.stroke();
  ctx.restore();
}

/** Draw a text label. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'left',
  baseline: CanvasTextBaseline = 'top',
): void {
  ctx.fillStyle = color;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

/** Draw a horizontal baseline at y=0. */
function drawBaseline(
  ctx: CanvasRenderingContext2D,
  area: { x: number; y: number; w: number; h: number },
  range: { yMin: number; yMax: number },
): void {
  const ySpan = range.yMax - range.yMin || 1;
  const py = area.y + area.h - ((0 - range.yMin) / ySpan) * area.h;
  if (py >= area.y && py <= area.y + area.h) {
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, py);
    ctx.lineTo(area.x + area.w, py);
    ctx.stroke();
  }
}

/** Mark the driver.js popover wrapper with a wider class for theory figures. */
function markFigurePopover(el: HTMLElement): void {
  el.closest('.driver-popover')?.classList.add('cadecon-tutorial-figure');
}

/** Set up the side-by-side layout (text + figure column). Returns refs for cleanup. */
function createFigureLayout(container: HTMLElement): {
  figCol: HTMLElement;
  cleanup: () => void;
} {
  const savedNodes = document.createDocumentFragment();
  while (container.firstChild) {
    savedNodes.appendChild(container.firstChild);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'theory-figure-layout';

  const textCol = document.createElement('div');
  textCol.className = 'theory-figure-text';
  textCol.appendChild(savedNodes);

  const figCol = document.createElement('div');
  figCol.className = 'theory-figure-canvas';

  wrapper.appendChild(textCol);
  wrapper.appendChild(figCol);
  container.appendChild(wrapper);

  const cleanup = () => {
    while (textCol.firstChild) {
      container.appendChild(textCol.firstChild);
    }
    wrapper.remove();
  };

  return { figCol, cleanup };
}

/** Compute the plot area from canvas dimensions and margins. */
function plotArea(w: number, h: number) {
  return {
    x: MARGIN.left,
    y: MARGIN.top,
    w: w - MARGIN.left - MARGIN.right,
    h: h - MARGIN.top - MARGIN.bottom,
  };
}

/** Compute data range with optional y padding. */
function dataRange(xData: ArrayLike<number>, yData: ArrayLike<number>, yPadFrac: number = 0.05) {
  let xMin = Infinity,
    xMax = -Infinity;
  let yMin = Infinity,
    yMax = -Infinity;
  for (let i = 0; i < xData.length; i++) {
    const x = xData[i],
      y = yData[i];
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const yPad = (yMax - yMin) * yPadFrac;
  return { xMin, xMax, yMin: yMin - yPad, yMax: yMax + yPad };
}

// ============================================================
// Figure: Calcium kernel shape (Step 3 — "The Calcium Model")
// ============================================================

/**
 * Draw the bi-exponential calcium kernel with peak (rise-to-peak) and FWHM
 * annotations — the same shape vocabulary the Kernel Shape panel uses.
 */
export function renderKernelShape(descriptionEl: HTMLElement): (() => void) | void {
  markFigurePopover(descriptionEl);
  const canvas = createHiDpiCanvas(SINGLE_W, SINGLE_H);
  const ctx = canvas.getContext('2d')!;
  const area = plotArea(SINGLE_W, SINGLE_H);

  const kernel = computeKernel(FIG_TAU_RISE, FIG_TAU_DECAY, FIG_FS);
  const range = dataRange(kernel.x, kernel.y);
  range.yMin = -0.05;

  drawBaseline(ctx, area, range);
  drawPolyline(ctx, kernel.x, kernel.y, KERNEL_COLOR, 2, area, range);

  const annot = computeKernelAnnotations(FIG_TAU_RISE, FIG_TAU_DECAY, FIG_FS);
  if (annot) {
    const xSpan = range.xMax - range.xMin || 1;
    const ySpan = range.yMax - range.yMin || 1;

    // Peak (rise-to-peak) vertical line + label
    const peakPx = area.x + ((annot.peakTime - range.xMin) / xSpan) * area.w;
    drawDashedVertical(ctx, peakPx, area.y, area.y + area.h, LABEL_COLOR);
    drawLabel(ctx, `Peak: ${Math.round(annot.peakTime * 1000)}ms`, peakPx + 4, area.y + 4, LABEL_COLOR);

    // FWHM double-arrow at y = 0.5
    const halfRisePx = area.x + ((annot.halfRiseTime - range.xMin) / xSpan) * area.w;
    const halfDecayPx = area.x + ((annot.halfDecayTime - range.xMin) / xSpan) * area.w;
    const halfY = area.y + area.h - ((0.5 - range.yMin) / ySpan) * area.h;

    drawDashedVertical(ctx, halfRisePx, halfY, area.y + area.h, LABEL_COLOR);
    drawDashedVertical(ctx, halfDecayPx, halfY, area.y + area.h, LABEL_COLOR);

    ctx.save();
    ctx.strokeStyle = LABEL_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(halfRisePx, halfY);
    ctx.lineTo(halfDecayPx, halfY);
    ctx.stroke();

    const arrowSize = 4;
    ctx.fillStyle = LABEL_COLOR;
    ctx.beginPath();
    ctx.moveTo(halfRisePx, halfY);
    ctx.lineTo(halfRisePx + arrowSize, halfY - arrowSize);
    ctx.lineTo(halfRisePx + arrowSize, halfY + arrowSize);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(halfDecayPx, halfY);
    ctx.lineTo(halfDecayPx - arrowSize, halfY - arrowSize);
    ctx.lineTo(halfDecayPx - arrowSize, halfY + arrowSize);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    drawLabel(
      ctx,
      `FWHM: ${Math.round(annot.fwhm * 1000)}ms`,
      (halfRisePx + halfDecayPx) / 2,
      halfY - 14,
      LABEL_COLOR,
      'center',
    );
  }

  drawLabel(ctx, 'Time (s)', area.x + area.w, area.y + area.h + 6, LABEL_COLOR, 'right', 'top');

  const { figCol, cleanup } = createFigureLayout(descriptionEl);
  figCol.appendChild(canvas);
  return cleanup;
}
