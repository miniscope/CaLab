import { createEffect, on, onCleanup, type JSX } from 'solid-js';
import { convergenceHistory } from '../../lib/iteration-store.ts';

const COLORS = {
  tauRise: '#42a5f5', // blue
  tauDecay: '#ef5350', // red
  tauRiseFaint: 'rgba(66, 165, 245, 0.3)',
  tauDecayFaint: 'rgba(239, 83, 80, 0.3)',
  axis: 'var(--text-tertiary)',
  grid: 'var(--border-subtle)',
  bg: 'var(--bg-secondary)',
};

export function KernelConvergence(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

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
      ctx.fillText('Run deconvolution to see kernel convergence.', w / 2, h / 2);
      return;
    }

    // Layout
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    // Data ranges — include per-subset points in range calculation
    const iters = history.map((s) => s.iteration);
    const tauRises = history.map((s) => s.tauRise * 1000);
    const tauDecays = history.map((s) => s.tauDecay * 1000);

    const allY = [...tauRises, ...tauDecays];
    for (const snap of history) {
      if (snap.subsets) {
        for (const sub of snap.subsets) {
          allY.push(sub.tauRise * 1000, sub.tauDecay * 1000);
        }
      }
    }

    const xMin = Math.min(...iters);
    const xMax = Math.max(...iters);
    const yMin = Math.min(...allY) * 0.8;
    const yMax = Math.max(...allY) * 1.2;

    function mapX(v: number): number {
      if (xMax === xMin) return pad.left + plotW / 2;
      return pad.left + ((v - xMin) / (xMax - xMin)) * plotW;
    }
    function mapY(v: number): number {
      if (yMax === yMin) return pad.top + plotH / 2;
      return pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    }

    // Grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    const nGridY = 4;
    for (let i = 0; i <= nGridY; i++) {
      const yVal = yMin + (yMax - yMin) * (i / nGridY);
      const y = mapY(yVal);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      // Y-axis labels
      ctx.fillStyle = COLORS.axis;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(yVal.toFixed(0), pad.left - 4, y);
    }

    // X-axis labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const iter of iters) {
      const x = mapX(iter);
      ctx.fillText(String(iter), x, pad.top + plotH + 4);
    }

    // Axis labels
    ctx.fillStyle = COLORS.axis;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Iteration', pad.left + plotW / 2, h - 4);

    ctx.save();
    ctx.translate(10, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('ms', 0, 0);
    ctx.restore();

    // Draw per-subset scatter points (behind the median lines)
    for (const snap of history) {
      if (!snap.subsets) continue;
      const x = mapX(snap.iteration);
      for (const sub of snap.subsets) {
        // tau rise subset point
        ctx.fillStyle = COLORS.tauRiseFaint;
        ctx.beginPath();
        ctx.arc(x, mapY(sub.tauRise * 1000), 4, 0, 2 * Math.PI);
        ctx.fill();

        // tau decay subset point
        ctx.fillStyle = COLORS.tauDecayFaint;
        ctx.beginPath();
        ctx.arc(x, mapY(sub.tauDecay * 1000), 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // Draw median lines
    function drawLine(c: CanvasRenderingContext2D, data: number[], color: string) {
      if (data.length < 1) return;
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(mapX(iters[0]), mapY(data[0]));
      for (let i = 1; i < data.length; i++) {
        c.lineTo(mapX(iters[i]), mapY(data[i]));
      }
      c.stroke();

      // Draw dots
      c.fillStyle = color;
      for (let i = 0; i < data.length; i++) {
        c.beginPath();
        c.arc(mapX(iters[i]), mapY(data[i]), 3, 0, 2 * Math.PI);
        c.fill();
      }
    }

    drawLine(ctx, tauRises, COLORS.tauRise);
    drawLine(ctx, tauDecays, COLORS.tauDecay);

    // Legend
    const legendX = pad.left + 8;
    const legendY = pad.top + 4;
    ctx.font = '10px system-ui, sans-serif';

    ctx.fillStyle = COLORS.tauRise;
    ctx.fillRect(legendX, legendY, 12, 3);
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('tau rise', legendX + 16, legendY - 2);

    ctx.fillStyle = COLORS.tauDecay;
    ctx.fillRect(legendX, legendY + 14, 12, 3);
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('tau decay', legendX + 16, legendY + 12);

    // Subset scatter legend
    ctx.fillStyle = COLORS.tauRiseFaint;
    ctx.beginPath();
    ctx.arc(legendX + 5, legendY + 32, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = COLORS.axis;
    ctx.fillText('per-subset', legendX + 16, legendY + 26);
  }

  createEffect(
    on(convergenceHistory, () => {
      requestAnimationFrame(draw);
    }),
  );

  function setupCanvas(el: HTMLCanvasElement) {
    canvasRef = el;
    resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(draw);
    });
    // Observe the wrapper div (stable layout size; canvas is position:absolute)
    const wrapper = el.parentElement;
    if (wrapper) resizeObserver.observe(wrapper);
    requestAnimationFrame(draw);
  }

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  return (
    <div class="kernel-chart-wrapper">
      <canvas ref={setupCanvas} />
    </div>
  );
}
