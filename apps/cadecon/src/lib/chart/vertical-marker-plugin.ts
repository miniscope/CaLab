/** Shared uPlot plugin factory that draws a labeled vertical line at an x value. */

import type uPlot from 'uplot';

interface VerticalMarkerOptions {
  getValue: () => number | null;
  label: (value: number) => string;
  strokeColor: string;
  labelColor: string;
  dash?: number[];
}

export function verticalMarkerPlugin(opts: VerticalMarkerOptions): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const value = opts.getValue();
        if (value == null) return;

        const xMin = u.scales.x.min!;
        const xMax = u.scales.x.max!;
        if (value < xMin || value > xMax) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { top, height } = u.bbox;
        const xPx = u.valToPos(value, 'x', true);

        ctx.save();

        // Vertical line
        ctx.strokeStyle = opts.strokeColor;
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash((opts.dash ?? []).map((d) => d * dpr));
        ctx.beginPath();
        ctx.moveTo(xPx, top);
        ctx.lineTo(xPx, top + height);
        ctx.stroke();

        // Label
        const fontSize = 9 * dpr;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.setLineDash([]);
        ctx.fillStyle = opts.labelColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(opts.label(value), xPx, top - 2 * dpr);

        ctx.restore();
      },
    },
  };
}
