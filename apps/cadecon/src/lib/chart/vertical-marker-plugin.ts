/** Shared uPlot plugin factory that draws a labeled vertical line at an x value. */

import type uPlot from 'uplot';

interface VerticalMarkerStyle {
  stroke: string;
  labelColor: string;
  label?: string;
  dash?: number[];
}

/**
 * Draw one labeled dashed vertical marker at data-x `value` (self-contained:
 * saves/restores ctx; no-op if `value` is outside the x-scale). Shared by
 * verticalMarkerPlugin and any plugin that draws several markers in one hook.
 */
export function drawVerticalMarker(u: uPlot, value: number, style: VerticalMarkerStyle): void {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null || value < xMin || value > xMax) return;

  const ctx = u.ctx;
  const dpr = devicePixelRatio;
  const { top, height } = u.bbox;
  const xPx = u.valToPos(value, 'x', true);

  ctx.save();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash((style.dash ?? []).map((d) => d * dpr));
  ctx.beginPath();
  ctx.moveTo(xPx, top);
  ctx.lineTo(xPx, top + height);
  ctx.stroke();

  if (style.label) {
    ctx.setLineDash([]);
    ctx.font = `${9 * dpr}px sans-serif`;
    ctx.fillStyle = style.labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(style.label, xPx, top - 2 * dpr);
  }
  ctx.restore();
}

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
        drawVerticalMarker(u, value, {
          stroke: opts.strokeColor,
          labelColor: opts.labelColor,
          label: opts.label(value),
          dash: opts.dash,
        });
      },
    },
  };
}
