/**
 * Canvas-rendered figures for the Deconvolution Theory tutorial (05-theory).
 *
 * Each exported function is an `onPopoverRender` callback: it receives the
 * popover description element, injects a canvas, draws a figure, and returns
 * a cleanup function that removes the canvas.
 *
 * Reuses kernel-math and mock-traces so the figures stay consistent with the
 * rest of CaTune.
 */

import { computeKernel, computeKernelAnnotations, generateSyntheticTrace } from '@catune/compute';
import { initWasm, Solver } from '@catune/core';

/** Run the FISTA solver synchronously on the main thread (fine for small traces). */
function runSolver(
  trace: Float32Array,
  tauRise: number,
  tauDecay: number,
  lambda: number,
  fs: number,
): { solution: Float32Array; fit: Float32Array } {
  const solver = new Solver();
  solver.set_params(tauRise, tauDecay, lambda, fs);
  solver.set_trace(trace);
  solver.set_filter_enabled(false);
  while (!solver.converged()) solver.step_batch(50);
  const solution = new Float32Array(solver.get_solution());
  const fit = new Float32Array(solver.get_reconvolution_with_baseline());
  solver.free();
  return { solution, fit };
}

// --- Colors (match dashboard palette) ---
const RAW_COLOR = '#1f77b4';
const FIT_COLOR = '#ff7f0e';
const GOOD_COLOR = '#2ca02c';
const BAD_COLOR = '#d62728';
const KERNEL_COLOR = 'hsl(280,70%,60%)';
const MID_KERNEL_COLOR = '#ff7f0e';
const LABEL_COLOR = '#ccc';
const AXIS_COLOR = 'rgba(255,255,255,0.15)';

// --- Dimensions ---
const SINGLE_W = 400;
const SINGLE_H = 240;
const DUAL_H = 320;
const MARGIN = { top: 8, right: 12, bottom: 20, left: 8 };

// ============================================================
// Shared helpers
// ============================================================

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

/** Draw a polyline mapping data coordinates to pixel area. */
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

/** Draw a horizontal baseline at y=0 (or a given value). */
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

/** Mount a canvas beside the existing text in a side-by-side layout. */
function mountFigure(container: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const { figCol, cleanup } = createFigureLayout(container);
  figCol.appendChild(canvas);
  return cleanup;
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

/** Compute data range with optional padding. */
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

/** Draw a small inline legend (colored line + label). */
function drawLegendEntry(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  label: string,
): number {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + 5);
  ctx.lineTo(x + 16, y + 5);
  ctx.stroke();
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + 20, y);
  return ctx.measureText(label).width + 28;
}

// ============================================================
// Figure 1: Kernel Shape (Step 2 — "The Calcium Kernel")
// ============================================================

export function renderKernelShape(descriptionEl: HTMLElement): (() => void) | void {
  const canvas = createHiDpiCanvas(SINGLE_W, SINGLE_H);
  const ctx = canvas.getContext('2d')!;
  const area = plotArea(SINGLE_W, SINGLE_H);

  const kernel = computeKernel(0.1, 0.6, 30);
  const range = dataRange(kernel.x, kernel.y);
  range.yMin = -0.05;

  drawBaseline(ctx, area, range);
  drawPolyline(ctx, kernel.x, kernel.y, KERNEL_COLOR, 2, area, range);

  // Annotations
  const annot = computeKernelAnnotations(0.1, 0.6, 30);
  if (annot) {
    const xSpan = range.xMax - range.xMin || 1;
    const ySpan = range.yMax - range.yMin || 1;

    // Peak vertical line
    const peakPx = area.x + ((annot.peakTime - range.xMin) / xSpan) * area.w;
    drawDashedVertical(ctx, peakPx, area.y, area.y + area.h, LABEL_COLOR);
    drawLabel(
      ctx,
      `Peak: ${Math.round(annot.peakTime * 1000)}ms`,
      peakPx + 4,
      area.y + 4,
      LABEL_COLOR,
    );

    // Half-decay vertical line
    const halfPx = area.x + ((annot.halfDecayTime - range.xMin) / xSpan) * area.w;
    const halfY = area.y + area.h - ((0.5 - range.yMin) / ySpan) * area.h;
    drawDashedVertical(ctx, halfPx, halfY, area.y + area.h, LABEL_COLOR);
    drawLabel(
      ctx,
      `t½: ${Math.round(annot.halfDecayTime * 1000)}ms`,
      halfPx + 4,
      halfY - 14,
      LABEL_COLOR,
    );
  }

  // Time axis label
  drawLabel(ctx, 'Time (s)', area.x + area.w, area.y + area.h + 6, LABEL_COLOR, 'right', 'top');

  return mountFigure(descriptionEl, canvas);
}

// ============================================================
// Figure 2: Decay Comparison (Step 5 — "What Decay Time Really Controls")
// ============================================================

export function renderDecayComparison(descriptionEl: HTMLElement): (() => void) | void {
  const canvas = createHiDpiCanvas(SINGLE_W, SINGLE_H);
  const ctx = canvas.getContext('2d')!;
  const area = plotArea(SINGLE_W, SINGLE_H);

  const correct = computeKernel(0.1, 0.6, 30);
  const tooFast = computeKernel(0.02, 0.08, 30);

  // Combine ranges — use correct kernel's x range (longer)
  const range = dataRange(correct.x, correct.y);
  range.yMin = -0.05;

  drawBaseline(ctx, area, range);
  drawPolyline(ctx, correct.x, correct.y, KERNEL_COLOR, 2, area, range);
  drawPolyline(ctx, tooFast.x, tooFast.y, BAD_COLOR, 2, area, range);

  // Legend
  let lx = area.x + 4;
  const ly = area.y + 2;
  lx += drawLegendEntry(ctx, lx, ly, KERNEL_COLOR, 'τ_decay = 0.60s');
  drawLegendEntry(ctx, lx + 8, ly, BAD_COLOR, 'τ_decay = 0.08s');

  drawLabel(ctx, 'Time (s)', area.x + area.w, area.y + area.h + 6, LABEL_COLOR, 'right', 'top');

  return mountFigure(descriptionEl, canvas);
}

// ============================================================
// Figure 3: Delta Trap (Step 6 — "The Delta Function Trap")
// ============================================================

export function renderDeltaTrap(descriptionEl: HTMLElement): (() => void) | void {
  const canvas = createHiDpiCanvas(SINGLE_W, SINGLE_H);
  const ctx = canvas.getContext('2d')!;
  const area = plotArea(SINGLE_W, SINGLE_H);

  // Higher fs to resolve the narrow kernel
  const fs = 100;
  const correct = computeKernel(0.1, 0.6, fs);
  const mid = computeKernel(0.05, 0.12, fs);
  const nearDelta = computeKernel(0.005, 0.015, fs);

  // Use correct kernel range for x axis
  const range = dataRange(correct.x, correct.y);
  range.yMin = -0.05;

  drawBaseline(ctx, area, range);
  drawPolyline(ctx, correct.x, correct.y, KERNEL_COLOR, 2, area, range);
  drawPolyline(ctx, mid.x, mid.y, MID_KERNEL_COLOR, 2, area, range);
  drawPolyline(ctx, nearDelta.x, nearDelta.y, BAD_COLOR, 2, area, range);

  // "→ δ(t)" label near the spike
  const spikePx = area.x + ((nearDelta.x[1] || 0.01) / (range.xMax - range.xMin)) * area.w;
  drawLabel(ctx, '→ δ(t)', spikePx + 8, area.y + 4, BAD_COLOR);

  // Legend
  let lx = area.x + 4;
  const ly = area.y + area.h + 6;
  lx += drawLegendEntry(ctx, lx, ly, KERNEL_COLOR, 'Correct');
  lx += drawLegendEntry(ctx, lx + 4, ly, MID_KERNEL_COLOR, 'Too fast');
  drawLegendEntry(ctx, lx + 8, ly, BAD_COLOR, 'Near-δ');

  return mountFigure(descriptionEl, canvas);
}

// ============================================================
// Figure 4: Good vs Bad Deconvolution (Step 8 — "Reading the Signs")
// ============================================================

/** Scale activity trace to fill a fraction of the y-range, anchored at yMin. */
function scaleActivity(
  activity: Float32Array,
  range: { yMin: number; yMax: number },
  fraction: number = 0.4,
): Float64Array {
  const n = activity.length;
  let actMax = 0;
  for (let i = 0; i < n; i++) {
    if (activity[i] > actMax) actMax = activity[i];
  }
  const scale = actMax > 0 ? ((range.yMax - range.yMin) * fraction) / actMax : 1;
  const scaled = new Float64Array(n);
  for (let i = 0; i < n; i++) scaled[i] = activity[i] * scale + range.yMin;
  return scaled;
}

/** Draw a single deconvolution comparison panel (raw + fit + activity). */
function drawDeconvPanel(
  ctx: CanvasRenderingContext2D,
  timeArr: Float64Array,
  raw: ArrayLike<number>,
  result: { solution: Float32Array; fit: Float32Array },
  area: { x: number; y: number; w: number; h: number },
  label: string,
  labelColor: string,
): void {
  const range = dataRange(timeArr, raw);

  drawBaseline(ctx, area, range);
  drawPolyline(ctx, timeArr, raw, RAW_COLOR, 1, area, range);
  drawPolyline(ctx, timeArr, result.fit, FIT_COLOR, 1.5, area, range);

  const actScaled = scaleActivity(result.solution, range);
  drawPolyline(ctx, timeArr, actScaled, GOOD_COLOR, 1.2, area, range);

  drawLabel(ctx, label, area.x + 4, area.y + 2, labelColor);
}

export function renderGoodVsBad(descriptionEl: HTMLElement): (() => void) | void {
  let cancelled = false;

  // Set up layout synchronously so text is visible while WASM loads
  const { figCol, cleanup } = createFigureLayout(descriptionEl);

  // Async: init WASM, run solver, draw canvas
  (async () => {
    await initWasm();
    if (cancelled) return;

    const N = 300;
    const fs = 30;
    const TAU_RISE = 0.1;
    const TAU_DECAY_GOOD = 0.6;
    const TAU_DECAY_BAD = 0.08;
    const TAU_RISE_BAD = 0.02;
    const LAMBDA = 0.05;

    const { raw } = generateSyntheticTrace(N, TAU_RISE, TAU_DECAY_GOOD, fs, 42, 25, {
      noise: { driftAmplitude: 0, amplitudeSigma: 0.3, driftCyclesMin: 2, driftCyclesMax: 4 },
    });

    const rawF32 = new Float32Array(N);
    for (let i = 0; i < N; i++) rawF32[i] = raw[i];

    const good = runSolver(rawF32, TAU_RISE, TAU_DECAY_GOOD, LAMBDA, fs);
    if (cancelled) return;

    const bad = runSolver(rawF32, TAU_RISE_BAD, TAU_DECAY_BAD, LAMBDA, fs);
    if (cancelled) return;

    // --- Draw ---
    const canvas = createHiDpiCanvas(SINGLE_W, DUAL_H);
    const ctx = canvas.getContext('2d')!;

    const panelGap = 16;
    const panelH = (DUAL_H - MARGIN.top - MARGIN.bottom - panelGap) / 2;
    const panelW = SINGLE_W - MARGIN.left - MARGIN.right;
    const topArea = { x: MARGIN.left, y: MARGIN.top, w: panelW, h: panelH };
    const botArea = { x: MARGIN.left, y: MARGIN.top + panelH + panelGap, w: panelW, h: panelH };

    const timeArr = new Float64Array(N);
    for (let i = 0; i < N; i++) timeArr[i] = i / fs;

    drawDeconvPanel(
      ctx,
      timeArr,
      raw,
      good,
      topArea,
      'Good kernel \u2014 activity at onsets',
      GOOD_COLOR,
    );
    drawDeconvPanel(
      ctx,
      timeArr,
      raw,
      bad,
      botArea,
      'Bad kernel \u2014 activity everywhere',
      BAD_COLOR,
    );

    // Shared legend
    let lx = MARGIN.left + 4;
    const ly = botArea.y + botArea.h + 4;
    lx += drawLegendEntry(ctx, lx, ly, RAW_COLOR, 'Raw');
    lx += drawLegendEntry(ctx, lx + 4, ly, FIT_COLOR, 'Fit');
    drawLegendEntry(ctx, lx + 8, ly, GOOD_COLOR, 'Activity');

    if (cancelled) return;
    figCol.appendChild(canvas);
  })();

  return () => {
    cancelled = true;
    cleanup();
  };
}
