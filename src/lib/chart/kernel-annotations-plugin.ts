/**
 * uPlot plugin that draws peak time and half-decay time annotations
 * on the kernel chart as dashed vertical lines with labels.
 */

import type uPlot from 'uplot';

export interface KernelAnnotations {
  peakTime: number;
  halfDecayTime: number;
}

const PEAK_COLOR = '#ff9800';
const HALF_DECAY_COLOR = '#ab47bc';
const LABEL_PAD = 4;

/**
 * Create a uPlot plugin that draws kernel annotation markers.
 *
 * @param getAnnotations - Accessor returning current annotation values (reactive)
 */
export function kernelAnnotationsPlugin(
  getAnnotations: () => KernelAnnotations | null,
): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const ann = getAnnotations();
        if (!ann) return;

        const ctx = u.ctx;
        const { top, height } = u.bbox;
        const dpr = devicePixelRatio;

        // Convert time values to canvas pixel positions
        const peakPx = u.valToPos(ann.peakTime, 'x', true);
        const halfPx = u.valToPos(ann.halfDecayTime, 'x', true);
        const halfYPx = u.valToPos(0.5, 'y', true);
        const topPx = top;
        const bottomPx = top + height;

        ctx.save();

        const fontSize = 10 * dpr;
        ctx.font = `${fontSize}px sans-serif`;

        // --- Dashed vertical line at peak time (orange) ---
        ctx.strokeStyle = PEAK_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(peakPx, topPx);
        ctx.lineTo(peakPx, bottomPx);
        ctx.stroke();

        // Peak label — centered above the vertical line
        const peakMs = (ann.peakTime * 1000).toFixed(0);
        ctx.setLineDash([]);
        ctx.fillStyle = PEAK_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Peak: ${peakMs}ms`, peakPx, topPx - LABEL_PAD * dpr);

        // --- Dashed vertical line at half-decay time (purple) ---
        ctx.strokeStyle = HALF_DECAY_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(halfPx, topPx);
        ctx.lineTo(halfPx, bottomPx);
        ctx.stroke();

        // Half-decay label — right of the vertical line, vertically centered
        const halfMs = (ann.halfDecayTime * 1000).toFixed(0);
        const midY = topPx + height / 2;
        ctx.setLineDash([]);
        ctx.fillStyle = HALF_DECAY_COLOR;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`t½: ${halfMs}ms`, halfPx + LABEL_PAD * dpr, midY);

        // --- Horizontal dashed line at y=0.5 connecting peak to half-decay ---
        ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(peakPx, halfYPx);
        ctx.lineTo(halfPx, halfYPx);
        ctx.stroke();

        ctx.restore();
      },
    },
  };
}
