import { createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import {
  convergenceHistory,
  debugTraceSnapshots,
  type KernelSnapshot,
} from '../../lib/iteration-store.ts';

const COLORS = {
  hFree: '#ffa726', // orange
  hFit: '#ab47bc', // purple
  axis: 'var(--text-tertiary)',
  grid: 'var(--border-subtle)',
  iterLabel: '#ffd54f', // yellow
};

export function DebugKernelChart(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [selectedIter, setSelectedIter] = createSignal<number | null>(null);

  /** Build fitted bi-exponential kernel from snapshot params. */
  function buildFitKernel(snap: KernelSnapshot, len: number): Float32Array {
    const dt = 1 / snap.fs;
    const fit = new Float32Array(len);
    // Median beta/tauRise/tauDecay — rebuild template: beta * (exp(-t/tauD) - exp(-t/tauR))
    for (let i = 0; i < len; i++) {
      const t = i * dt;
      fit[i] = snap.beta * (Math.exp(-t / snap.tauDecay) - Math.exp(-t / snap.tauRise));
    }
    return fit;
  }

  function draw() {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const history = convergenceHistory();
    if (history.length === 0) {
      ctx.fillStyle = 'var(--text-tertiary)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Run deconvolution to see kernel fit debug.', w / 2, h / 2);
      return;
    }

    // Sync iteration with the debug trace chart's selected iteration
    const sel = selectedIter();
    const snap: KernelSnapshot =
      sel !== null
        ? (history.find((s) => s.iteration === sel) ?? history[history.length - 1])
        : history[history.length - 1];

    // Use median of per-subset free kernels (first subset as representative)
    if (snap.subsets.length === 0) return;

    // Pick the first subset's hFree as representative
    const hFree = snap.subsets[0].hFree;
    if (!hFree || hFree.length === 0) return;

    const len = hFree.length;
    const hFit = buildFitKernel(snap, len);

    // Layout
    const pad = { top: 22, right: 16, bottom: 20, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    if (plotW <= 0 || plotH <= 10) return;

    // Y range across both curves
    let yMin = 0;
    let yMax = -Infinity;
    for (let i = 0; i < len; i++) {
      if (hFree[i] > yMax) yMax = hFree[i];
      if (hFit[i] > yMax) yMax = hFit[i];
      if (hFree[i] < yMin) yMin = hFree[i];
      if (hFit[i] < yMin) yMin = hFit[i];
    }
    if (yMax === yMin) yMax = yMin + 1;
    // Add a bit of breathing room
    const yRange = yMax - yMin;
    yMin -= yRange * 0.05;
    yMax += yRange * 0.05;

    // X-axis in seconds
    const dt = 1 / snap.fs;
    const tMax = (len - 1) * dt;

    function mapX(i: number): number {
      return pad.left + ((i * dt) / tMax) * plotW;
    }
    function mapY(v: number): number {
      return pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    }

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    // Draw free kernel
    ctx.strokeStyle = COLORS.hFree;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mapX(0), mapY(hFree[0]));
    for (let i = 1; i < len; i++) {
      ctx.lineTo(mapX(i), mapY(hFree[i]));
    }
    ctx.stroke();

    // Draw fit kernel
    ctx.strokeStyle = COLORS.hFit;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(mapX(0), mapY(hFit[0]));
    for (let i = 1; i < len; i++) {
      ctx.lineTo(mapX(i), mapY(hFit[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Y-axis labels
    ctx.fillStyle = COLORS.axis;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(yMax.toFixed(3), pad.left - 4, pad.top);
    ctx.fillText(yMin.toFixed(3), pad.left - 4, pad.top + plotH);

    // X-axis labels (time in ms)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const nXTicks = Math.min(5, len);
    for (let i = 0; i <= nXTicks; i++) {
      const sampleIdx = Math.round((i / nXTicks) * (len - 1));
      const tMs = sampleIdx * dt * 1000;
      ctx.fillText(tMs.toFixed(0), mapX(sampleIdx), pad.top + plotH + 2);
    }
    ctx.fillText('ms', pad.left + plotW + 2, pad.top + plotH + 2);

    // Legend
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const legendX = pad.left + 4;
    const legendY = pad.top + 2;

    ctx.strokeStyle = COLORS.hFree;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(legendX, legendY + 5);
    ctx.lineTo(legendX + 12, legendY + 5);
    ctx.stroke();
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('free', legendX + 16, legendY);

    ctx.strokeStyle = COLORS.hFit;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(legendX + 46, legendY + 5);
    ctx.lineTo(legendX + 58, legendY + 5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('fit', legendX + 62, legendY);

    // Header: iteration + fit params
    ctx.fillStyle = COLORS.iterLabel;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `Iter ${snap.iteration}  |  ` +
        `\u03C4r=${(snap.tauRise * 1000).toFixed(1)}ms  ` +
        `\u03C4d=${(snap.tauDecay * 1000).toFixed(1)}ms  ` +
        `\u03B2=${snap.beta.toFixed(3)}  ` +
        `res=${snap.residual.toFixed(4)}`,
      w - pad.right,
      4,
    );

    // Iteration selector buttons at bottom
    if (history.length > 1) {
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const btnY = h - 14;
      for (let si = 0; si < history.length; si++) {
        const btnX = pad.left + ((si + 0.5) / history.length) * plotW;
        const isSelected = history[si].iteration === snap.iteration;
        ctx.fillStyle = isSelected ? COLORS.iterLabel : COLORS.axis;
        ctx.fillText(String(history[si].iteration), btnX, btnY);
      }
    }
  }

  createEffect(
    on(
      () => [convergenceHistory(), debugTraceSnapshots(), selectedIter()],
      () => requestAnimationFrame(draw),
    ),
  );

  function setupCanvas(el: HTMLCanvasElement) {
    canvasRef = el;
    resizeObserver = new ResizeObserver(() => requestAnimationFrame(draw));
    const wrapper = el.parentElement;
    if (wrapper) resizeObserver.observe(wrapper);
    requestAnimationFrame(draw);

    // Click handler for iteration selection
    el.addEventListener('click', (e) => {
      const history = convergenceHistory();
      if (history.length <= 1) return;
      const rect = el.getBoundingClientRect();
      const pad = { left: 50, right: 16 };
      const plotW = rect.width - pad.left - pad.right;
      const x = e.clientX - rect.left - pad.left;
      if (x < 0 || x > plotW) return;
      const idx = Math.floor((x / plotW) * history.length);
      const clamped = Math.max(0, Math.min(idx, history.length - 1));
      setSelectedIter(history[clamped].iteration);
    });
  }

  onCleanup(() => resizeObserver?.disconnect());

  return (
    <div class="debug-kernel-wrapper">
      <canvas ref={setupCanvas} />
    </div>
  );
}
