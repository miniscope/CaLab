/**
 * uPlot plugin for scroll-wheel zoom and left-click drag pan.
 * X-axis only zoom centered on cursor position with data bounds clamping.
 * Y-axis auto-ranges (no manual y-zoom).
 */

import type uPlot from 'uplot';

export function wheelZoomPlugin(opts?: { factor?: number }): uPlot.Plugin {
  const factor = opts?.factor ?? 0.75;

  let xMin: number;
  let xMax: number;
  let xRange: number;

  return {
    opts: (_self, opts) => {
      opts.cursor = opts.cursor || {};
      opts.cursor.drag = opts.cursor.drag || {};
      opts.cursor.drag.x = false;
      opts.cursor.drag.y = false;
      return opts;
    },
    hooks: {
      ready(u: uPlot) {
        xMin = u.scales.x.min!;
        xMax = u.scales.x.max!;
        xRange = xMax - xMin;

        const over = u.over;

        over.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();

          const { left } = u.cursor;
          if (left == null) return;

          const leftPct = left / over.offsetWidth;
          const oxRange = u.scales.x.max! - u.scales.x.min!;
          const nxRange = e.deltaY < 0 ? oxRange * factor : oxRange / factor;

          let nxMin = u.posToVal(left, 'x') - leftPct * nxRange;
          let nxMax = nxMin + nxRange;

          if (nxRange > xRange) {
            nxMin = xMin;
            nxMax = xMax;
          } else if (nxMin < xMin) {
            nxMin = xMin;
            nxMax = xMin + nxRange;
          } else if (nxMax > xMax) {
            nxMax = xMax;
            nxMin = xMax - nxRange;
          }

          u.setScale('x', { min: nxMin, max: nxMax });
        });

        over.addEventListener('mousedown', (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();

          const startX = e.clientX;
          const startMin = u.scales.x.min!;
          const startMax = u.scales.x.max!;
          const pxToVal = u.posToVal(1, 'x') - u.posToVal(0, 'x');

          const onMove = (ev: MouseEvent) => {
            ev.preventDefault();
            const dx = pxToVal * (ev.clientX - startX);
            let newMin = startMin - dx;
            let newMax = startMax - dx;

            if (newMin < xMin) {
              newMin = xMin;
              newMax = xMin + (startMax - startMin);
            }
            if (newMax > xMax) {
              newMax = xMax;
              newMin = xMax - (startMax - startMin);
            }

            u.setScale('x', { min: newMin, max: newMax });
          };

          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };

          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      },
    },
  };
}
