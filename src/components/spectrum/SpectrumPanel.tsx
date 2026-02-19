/**
 * Spectrum visualization panel: shows power spectral density with filter band overlay.
 * Uses uPlot following ScatterPlot.tsx patterns (ResizeObserver, dark theme, canvas plugins).
 */

import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { spectrumData } from '../../lib/spectrum/spectrum-store.ts';
import { filterEnabled } from '../../lib/viz-store.ts';
import { samplingRate } from '../../lib/data-store.ts';
import { getThemeColors } from '../../lib/chart/theme-colors.ts';
import { withOpacity } from '../../lib/chart/series-config.ts';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import './spectrum.css';

/**
 * uPlot plugin that draws the filter band overlay on the chart.
 * Shading + cutoff lines draw in drawClear (behind grid/series).
 * Labels draw in draw (on top of everything).
 */
function filterBandPlugin(
  getFilterEnabled: () => boolean,
  getHighPass: () => number,
  getLowPass: () => number,
  theme: ReturnType<typeof getThemeColors>,
): uPlot.Plugin {
  /** Compute shared pixel positions for both hooks. */
  function getPositions(u: uPlot) {
    const xScale = u.scales.x;
    if (!xScale || xScale.min == null || xScale.max == null) return null;
    const hp = Math.log10(Math.max(getHighPass(), 1e-6));
    const lp = Math.log10(Math.max(getLowPass(), 1e-6));
    return {
      left: u.valToPos(hp, 'x', true),
      right: u.valToPos(lp, 'x', true),
      top: u.bbox.top,
      height: u.bbox.height,
      dpr: devicePixelRatio,
    };
  }

  return {
    hooks: {
      // Shading + lines: behind grid and series
      drawClear: [
        (u: uPlot) => {
          if (!getFilterEnabled()) return;
          const pos = getPositions(u);
          if (!pos) return;
          const { left, right, top, height, dpr } = pos;
          const ctx = u.ctx;

          ctx.save();

          // Shaded passband rectangle — full plot height
          ctx.fillStyle = withOpacity(theme.accent, 0.1);
          ctx.fillRect(left, top, right - left, height);

          // Cutoff lines — dashed, full height
          ctx.lineWidth = 1.5 * dpr;
          ctx.strokeStyle = withOpacity(theme.accent, 0.6);
          ctx.setLineDash([6 * dpr, 3 * dpr]);
          for (const x of [left, right]) {
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
          }

          ctx.restore();
        },
      ],
      // Labels: on top of grid, axes, and series
      draw: [
        (u: uPlot) => {
          if (!getFilterEnabled()) return;
          const pos = getPositions(u);
          if (!pos) return;
          const { left, right, top, dpr } = pos;
          const ctx = u.ctx;

          ctx.save();

          const fontSize = Math.round(12 * dpr);
          ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          for (const [x, label] of [
            [left, 'HP'],
            [right, 'LP'],
          ] as const) {
            const textW = ctx.measureText(label).width;
            const pad = 5 * dpr;
            const pillW = textW + pad * 2;
            const pillH = fontSize + pad;
            const pillX = x - pillW / 2;
            const pillY = top + 5 * dpr;
            // Opaque pill background
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.roundRect(pillX, pillY, pillW, pillH, 3 * dpr);
            ctx.fill();
            // Pill border
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1 * dpr;
            ctx.globalAlpha = 0.5;
            ctx.setLineDash([]);
            ctx.stroke();
            // Label text
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = theme.accent;
            ctx.fillText(label, x, pillY + pillH / 2);
          }

          ctx.restore();
        },
      ],
    },
  };
}

export function SpectrumPanel() {
  const [container, setContainer] = createSignal<HTMLDivElement>();
  let uplotInstance: uPlot | undefined;

  // Rebuild chart when spectrum data or container changes.
  // container is a signal so the effect re-fires when Show renders the div.
  createEffect(
    on([spectrumData, container], () => {
      if (uplotInstance) {
        uplotInstance.destroy();
        uplotInstance = undefined;
      }

      const data = spectrumData();
      const el = container();
      if (!data || !el) return;

      const theme = getThemeColors();

      // Convert frequency axis to log10 for display
      const logFreqs: number[] = [];
      const psdVals: number[] = [];
      const allPsdVals: number[] = [];
      for (let i = 1; i < data.freqs.length; i++) {
        const f = data.freqs[i];
        if (f <= 0) continue;
        logFreqs.push(Math.log10(f));
        psdVals.push(data.psd[i]);
        allPsdVals.push(data.allPsd[i]);
      }

      if (logFreqs.length === 0) return;

      const chartData: uPlot.AlignedData = [
        new Float64Array(logFreqs),
        new Float64Array(psdVals),
        new Float64Array(allPsdVals),
      ];

      const opts: uPlot.Options = {
        width: el.clientWidth || 400,
        height: 280,
        plugins: [
          filterBandPlugin(
            filterEnabled,
            () => data.highPassHz,
            () => data.lowPassHz,
            theme,
          ),
        ],
        scales: { x: { time: false } },
        series: [
          {},
          {
            label: 'Selected Cell',
            stroke: theme.accent,
            width: 1.5,
          },
          {
            label: 'All Cells',
            stroke: withOpacity(theme.textTertiary, 0.55),
            width: 1.5,
          },
        ],
        axes: [
          {
            label: 'Frequency (Hz)',
            stroke: theme.textSecondary,
            grid: { stroke: theme.borderSubtle },
            ticks: { stroke: theme.borderDefault },
            size: 40,
            space: 80,
            values: (_u: uPlot, vals: number[]) =>
              vals.map((v) => {
                const f = Math.pow(10, v);
                if (f >= 1) return f.toFixed(0);
                if (f >= 0.1) return f.toFixed(1);
                return f.toFixed(2);
              }),
          },
          {
            label: 'Power (dB)',
            stroke: theme.textSecondary,
            grid: { stroke: theme.borderSubtle },
            ticks: { stroke: theme.borderDefault },
            size: 50,
            space: 40,
            values: (_u: uPlot, vals: number[]) => vals.map((v) => v.toFixed(0)),
          },
        ],
        legend: { show: false },
      };

      uplotInstance = new uPlot(opts, chartData, el);
    }),
  );

  // Redraw (not rebuild) when filter toggle changes — plugin reads filterEnabled() live
  createEffect(
    on(filterEnabled, () => {
      if (uplotInstance) uplotInstance.redraw();
    }),
  );

  // ResizeObserver for sidebar open/close reflow
  let resizeRaf: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      const el = container();
      if (uplotInstance && el) {
        const w = el.clientWidth;
        if (w > 0) uplotInstance.setSize({ width: w, height: 280 });
      }
    });
  });

  createEffect(() => {
    const el = container();
    if (el) resizeObserver.observe(el);
  });

  onCleanup(() => {
    resizeObserver.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (uplotInstance) {
      uplotInstance.destroy();
      uplotInstance = undefined;
    }
  });

  const allCellsColor = () => {
    const theme = getThemeColors();
    return withOpacity(theme.textTertiary, 0.5);
  };

  return (
    <div class="spectrum-panel" data-tutorial="spectrum-panel">
      <div class="spectrum-panel__header">
        <h3 class="spectrum-panel__title">Spectrum</h3>
        <Show when={spectrumData()}>
          <div class="spectrum-panel__legend">
            <span class="spectrum-panel__legend-item">
              <span class="spectrum-panel__legend-swatch" style={{ background: allCellsColor() }} />
              All Cells
            </span>
            <span class="spectrum-panel__legend-item">
              <span class="spectrum-panel__legend-swatch spectrum-panel__legend-swatch--accent" />
              Selected
            </span>
          </div>
        </Show>
      </div>
      <Show
        when={spectrumData()}
        fallback={
          <div class="spectrum-panel__empty">
            No data loaded. Load a dataset to see the frequency spectrum.
          </div>
        }
      >
        {(data) => (
          <>
            <div ref={setContainer} class="spectrum-panel__chart" />
            <div class="spectrum-panel__info">
              <p class="spectrum-panel__desc">
                Power spectral density averaged across all loaded cells (gray) and for the selected
                cell (blue).
                {filterEnabled()
                  ? ' Dashed lines mark the kernel-derived bandpass cutoffs.'
                  : ' Enable Noise Filter to see bandpass cutoffs.'}
              </p>
              <div class="spectrum-panel__stats">
                {[
                  ['Fs', `${samplingRate() ?? 0} Hz`, 'Sampling rate'],
                  ['HP', `${data().highPassHz.toFixed(3)} Hz`, 'High-pass cutoff'],
                  ['LP', `${data().lowPassHz.toFixed(1)} Hz`, 'Low-pass cutoff'],
                ].map(([label, value, title]) => (
                  <div class="spectrum-panel__stat" title={title}>
                    <span class="spectrum-panel__stat-label">{label}</span>
                    <span class="spectrum-panel__stat-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
