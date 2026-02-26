/** uPlot plugin that draws a solid orange vertical line at the viewed iteration. */

import type uPlot from 'uplot';

const MARKER_COLOR = '#ff9800';
const LABEL_COLOR = '#e68900';

export function viewedIterationPlugin(getViewedIteration: () => number | null): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const iter = getViewedIteration();
        if (iter == null) return;

        const xMin = u.scales.x.min!;
        const xMax = u.scales.x.max!;
        if (iter < xMin || iter > xMax) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { top, height } = u.bbox;
        const xPx = u.valToPos(iter, 'x', true);

        ctx.save();

        // Solid vertical line
        ctx.strokeStyle = MARKER_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xPx, top);
        ctx.lineTo(xPx, top + height);
        ctx.stroke();

        // Label
        const fontSize = 9 * dpr;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = LABEL_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Iter ${iter}`, xPx, top - 2 * dpr);

        ctx.restore();
      },
    },
  };
}
