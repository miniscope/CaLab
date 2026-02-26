/** uPlot plugin that draws a vertical dashed line at the convergence iteration. */

import type uPlot from 'uplot';

const MARKER_COLOR = '#4caf50';
const LABEL_COLOR = '#388e3c';

export function convergenceMarkerPlugin(getConvergedAt: () => number | null): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const convergedAt = getConvergedAt();
        if (convergedAt == null) return;

        const xMin = u.scales.x.min!;
        const xMax = u.scales.x.max!;
        if (convergedAt < xMin || convergedAt > xMax) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { top, height } = u.bbox;
        const xPx = u.valToPos(convergedAt, 'x', true);

        ctx.save();

        // Dashed vertical line
        ctx.strokeStyle = MARKER_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(xPx, top);
        ctx.lineTo(xPx, top + height);
        ctx.stroke();

        // Label
        const fontSize = 9 * dpr;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.setLineDash([]);
        ctx.fillStyle = LABEL_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Converged', xPx, top - 2 * dpr);

        ctx.restore();
      },
    },
  };
}
