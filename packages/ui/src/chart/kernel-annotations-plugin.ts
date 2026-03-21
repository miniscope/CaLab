/**
 * uPlot plugin that draws peak time and FWHM annotations
 * on the kernel chart as dashed vertical lines with labels.
 *
 * All position values must be in the chart's native x-axis unit.
 * The `toMs` multiplier converts those positions to ms for labels
 * (e.g., 1000 when the axis is in seconds, 1 when already in ms).
 */

import type uPlot from 'uplot';

export interface KernelAnnotations {
  peakTime: number;
  halfRiseTime: number;
  halfDecayTime: number;
  fwhm: number;
}

const PEAK_COLOR = '#ff9800';
const FWHM_COLOR = '#ab47bc';
const LABEL_PAD = 4;

/**
 * Create a uPlot plugin that draws kernel annotation markers.
 *
 * @param getAnnotations - Accessor returning current annotation values (reactive)
 * @param toMs - Multiplier to convert annotation values to ms for labels (default 1)
 */
export function kernelAnnotationsPlugin(
  getAnnotations: () => KernelAnnotations | null,
  toMs: number = 1,
): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const ann = getAnnotations();
        if (!ann) return;

        const ctx = u.ctx;
        const { top, height } = u.bbox;
        const dpr = devicePixelRatio;

        const peakPx = u.valToPos(ann.peakTime, 'x', true);
        const halfRisePx = u.valToPos(ann.halfRiseTime, 'x', true);
        const halfDecayPx = u.valToPos(ann.halfDecayTime, 'x', true);
        const halfYPx = u.valToPos(0.5, 'y', true);
        const topPx = top;
        const bottomPx = top + height;
        const capHeight = 6 * dpr;

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

        // Peak label
        const peakMs = (ann.peakTime * toMs).toFixed(0);
        ctx.setLineDash([]);
        ctx.fillStyle = PEAK_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Peak: ${peakMs}ms`, peakPx, topPx - LABEL_PAD * dpr);

        // --- FWHM horizontal line at y=0.5 (purple) ---
        ctx.strokeStyle = FWHM_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([]);

        // Horizontal bar
        ctx.beginPath();
        ctx.moveTo(halfRisePx, halfYPx);
        ctx.lineTo(halfDecayPx, halfYPx);
        ctx.stroke();

        // Left end-cap
        ctx.beginPath();
        ctx.moveTo(halfRisePx, halfYPx - capHeight);
        ctx.lineTo(halfRisePx, halfYPx + capHeight);
        ctx.stroke();

        // Right end-cap
        ctx.beginPath();
        ctx.moveTo(halfDecayPx, halfYPx - capHeight);
        ctx.lineTo(halfDecayPx, halfYPx + capHeight);
        ctx.stroke();

        // FWHM label
        const fwhmMs = (ann.fwhm * toMs).toFixed(0);
        const fwhmCenterPx = (halfRisePx + halfDecayPx) / 2;
        ctx.fillStyle = FWHM_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`FWHM: ${fwhmMs}ms`, fwhmCenterPx, halfYPx - LABEL_PAD * dpr);

        ctx.restore();
      },
    },
  };
}
