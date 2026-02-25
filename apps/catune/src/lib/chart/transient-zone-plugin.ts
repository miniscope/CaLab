/**
 * uPlot plugin that draws a shaded overlay over the convolution transient zone
 * at the start of the trace, so users understand the fit is intentionally masked.
 */

import type uPlot from 'uplot';

const FILL_COLOR = 'rgba(0, 0, 0, 0.06)';
const STRIPE_COLOR = 'rgba(0, 0, 0, 0.04)';
const LABEL_COLOR = '#444444';
const STRIPE_SPACING = 8; // px between diagonal stripes

/**
 * Create a uPlot plugin that shades the convolution transient region.
 *
 * @param getTransientEnd - Accessor returning the transient cutoff time in seconds
 */
export function transientZonePlugin(getTransientEnd: () => number): uPlot.Plugin {
  return {
    hooks: {
      draw(u: uPlot) {
        const transientEnd = getTransientEnd();
        if (transientEnd <= 0) return;

        const xMin = u.scales.x.min!;
        const xMax = u.scales.x.max!;

        // Skip if the transient zone is entirely off-screen
        if (transientEnd <= xMin) return;

        const ctx = u.ctx;
        const dpr = devicePixelRatio;
        const { left, top, height } = u.bbox;

        // Convert transient boundary to canvas pixel position
        const rightPx = u.valToPos(Math.min(transientEnd, xMax), 'x', true);
        const zoneWidth = rightPx - left;

        if (zoneWidth <= 0) return;

        ctx.save();

        // Tinted background
        ctx.fillStyle = FILL_COLOR;
        ctx.fillRect(left, top, zoneWidth, height);

        // Diagonal stripe pattern
        ctx.beginPath();
        ctx.rect(left, top, zoneWidth, height);
        ctx.clip();

        ctx.strokeStyle = STRIPE_COLOR;
        ctx.lineWidth = 1 * dpr;
        const spacing = STRIPE_SPACING * dpr;
        const sweep = zoneWidth + height;
        for (let d = -height; d < sweep; d += spacing) {
          ctx.beginPath();
          ctx.moveTo(left + d, top);
          ctx.lineTo(left + d + height, top + height);
          ctx.stroke();
        }

        // Label (only when zone is wide enough to fit text)
        const labelFontSize = 9 * dpr;
        ctx.font = `${labelFontSize}px sans-serif`;
        const label = 'No fit near t = 0';
        const textWidth = ctx.measureText(label).width;
        const minWidth = textWidth + 12 * dpr;

        if (zoneWidth >= minWidth) {
          const cx = left + zoneWidth / 2;
          const cy = top + labelFontSize + 6 * dpr;
          ctx.fillStyle = LABEL_COLOR;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, cx, cy);
        }

        ctx.restore();
      },
    },
  };
}
