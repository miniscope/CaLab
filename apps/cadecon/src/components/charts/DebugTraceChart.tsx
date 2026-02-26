import { createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { debugTraceSnapshots } from '../../lib/iteration-store.ts';
import type { DebugTraceSnapshot } from '../../lib/iteration-store.ts';

const COLORS = {
  trace: '#90caf9', // light blue
  recon: '#66bb6a', // green
  spikes: '#ef5350', // red
  axis: 'var(--text-tertiary)',
  grid: 'var(--border-subtle)',
  iterLabel: '#ffd54f', // yellow
};

export function DebugTraceChart(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [selectedIter, setSelectedIter] = createSignal<number | null>(null);

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

    const snapshots = debugTraceSnapshots();
    if (snapshots.length === 0) {
      ctx.fillStyle = 'var(--text-tertiary)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Run deconvolution to see per-iteration trace debug.', w / 2, h / 2);
      return;
    }

    // Pick which iteration to show
    const sel = selectedIter();
    const snap: DebugTraceSnapshot =
      sel !== null
        ? (snapshots.find((s) => s.iteration === sel) ?? snapshots[snapshots.length - 1])
        : snapshots[snapshots.length - 1];

    const trace = snap.rawTrace;
    const recon = snap.reconvolved;
    const sCounts = snap.sCounts;
    const n = trace.length;
    if (n === 0) return;

    // Layout: top half = raw trace + reconvolved, bottom half = deconvolved activity
    const pad = { top: 22, right: 16, bottom: 20, left: 50 };
    const plotW = w - pad.left - pad.right;
    const gap = 20;
    const halfH = (h - pad.top - pad.bottom - gap) / 2;

    if (plotW <= 0 || halfH <= 10) return;

    // X mapping (shared)
    function mapX(i: number): number {
      return pad.left + (i / (n - 1)) * plotW;
    }

    // --- Top panel: raw trace + reconvolved overlay ---
    const traceTop = pad.top;
    let traceMin = Infinity;
    let traceMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (trace[i] < traceMin) traceMin = trace[i];
      if (trace[i] > traceMax) traceMax = trace[i];
      if (recon[i] < traceMin) traceMin = recon[i];
      if (recon[i] > traceMax) traceMax = recon[i];
    }
    if (traceMax === traceMin) traceMax = traceMin + 1;

    function mapYTrace(v: number): number {
      return traceTop + halfH - ((v - traceMin) / (traceMax - traceMin)) * halfH;
    }

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 3; i++) {
      const y = traceTop + (halfH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    // Subsample for performance if very long
    const step = Math.max(1, Math.floor(n / plotW / 2));

    // Draw raw trace
    ctx.strokeStyle = COLORS.trace;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mapX(0), mapYTrace(trace[0]));
    for (let i = step; i < n; i += step) {
      ctx.lineTo(mapX(i), mapYTrace(trace[i]));
    }
    ctx.stroke();

    // Draw reconvolved trace on top
    ctx.strokeStyle = COLORS.recon;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mapX(0), mapYTrace(recon[0]));
    for (let i = step; i < n; i += step) {
      ctx.lineTo(mapX(i), mapYTrace(recon[i]));
    }
    ctx.stroke();

    // Y-axis labels for trace
    ctx.fillStyle = COLORS.axis;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(traceMax.toFixed(1), pad.left - 4, traceTop);
    ctx.fillText(traceMin.toFixed(1), pad.left - 4, traceTop + halfH);

    // Legend for top panel
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const legendX = pad.left + 4;
    const legendY = traceTop + 2;
    ctx.fillStyle = COLORS.trace;
    ctx.fillRect(legendX, legendY + 3, 12, 2);
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('raw', legendX + 16, legendY);
    ctx.fillStyle = COLORS.recon;
    ctx.fillRect(legendX + 46, legendY + 3, 12, 2);
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('recon', legendX + 62, legendY);

    // --- Bottom panel: spike counts ---
    const spikeTop = traceTop + halfH + gap;
    let sMax = 0;
    for (let i = 0; i < sCounts.length; i++) {
      if (sCounts[i] > sMax) sMax = sCounts[i];
    }
    if (sMax === 0) sMax = 1;

    function mapYSpike(v: number): number {
      return spikeTop + halfH - (v / sMax) * halfH;
    }

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 3; i++) {
      const y = spikeTop + (halfH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    // Draw spikes as vertical bars
    ctx.fillStyle = COLORS.spikes;
    const barW = Math.max(1, plotW / sCounts.length);
    for (let i = 0; i < sCounts.length; i++) {
      if (sCounts[i] > 0) {
        const x = pad.left + (i / sCounts.length) * plotW;
        const barH = (sCounts[i] / sMax) * halfH;
        ctx.fillRect(x, spikeTop + halfH - barH, barW, barH);
      }
    }

    // Y-axis labels for spikes
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(sMax.toFixed(0), pad.left - 4, spikeTop);
    ctx.fillText('0', pad.left - 4, spikeTop + halfH);

    // Panel label
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Spike counts', pad.left + 4, spikeTop + 2);

    // --- Header with iteration info ---
    const totalSpikes = Array.from(sCounts).reduce((s, v) => s + v, 0);
    ctx.fillStyle = COLORS.iterLabel;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `Iter ${snap.iteration}  |  cell ${snap.cellIndex}  |  ` +
        `α=${snap.alpha.toFixed(2)}  b=${snap.baseline.toFixed(2)}  ` +
        `thresh=${snap.threshold.toFixed(4)}  PVE=${snap.pve.toFixed(3)}  ` +
        `spikes=${totalSpikes.toFixed(0)}`,
      w - pad.right,
      4,
    );

    // --- Iteration selector buttons at bottom ---
    if (snapshots.length > 1) {
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const btnY = h - 14;
      for (let si = 0; si < snapshots.length; si++) {
        const btnX = pad.left + ((si + 0.5) / snapshots.length) * plotW;
        const isSelected = snapshots[si].iteration === snap.iteration;
        ctx.fillStyle = isSelected ? COLORS.iterLabel : COLORS.axis;
        ctx.fillText(String(snapshots[si].iteration), btnX, btnY);
      }
    }
  }

  createEffect(
    on(
      () => [debugTraceSnapshots(), selectedIter()],
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
      const snapshots = debugTraceSnapshots();
      if (snapshots.length <= 1) return;
      const rect = el.getBoundingClientRect();
      const pad = { left: 50, right: 16 };
      const plotW = rect.width - pad.left - pad.right;
      const x = e.clientX - rect.left - pad.left;
      if (x < 0 || x > plotW) return;
      const idx = Math.floor((x / plotW) * snapshots.length);
      const clamped = Math.max(0, Math.min(idx, snapshots.length - 1));
      setSelectedIter(snapshots[clamped].iteration);
    });
  }

  onCleanup(() => resizeObserver?.disconnect());

  return (
    <div class="debug-trace-wrapper">
      <canvas ref={setupCanvas} />
    </div>
  );
}
