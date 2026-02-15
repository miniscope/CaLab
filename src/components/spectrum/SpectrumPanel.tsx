/**
 * Spectrum visualization panel: shows power spectral density with filter band overlay.
 * Uses uPlot following ScatterPlot.tsx patterns (ResizeObserver, dark theme, canvas plugins).
 */

import { createEffect, on, onCleanup, Show } from 'solid-js';
import { spectrumData } from '../../lib/spectrum/spectrum-store';
import { filterEnabled } from '../../lib/viz-store';
import { samplingRate } from '../../lib/data-store';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import './spectrum.css';

/** Read CSS custom property values from :root. */
function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim() || undefined;
  return {
    textPrimary:   v('--text-primary')   ?? '#1a1a1a',
    textSecondary: v('--text-secondary') ?? '#616161',
    textTertiary:  v('--text-tertiary')  ?? '#9e9e9e',
    borderSubtle:  v('--border-subtle')  ?? '#e8e8e8',
    borderDefault: v('--border-default') ?? '#d4d4d4',
    accent:        v('--accent')         ?? '#2171b5',
    accentMuted:   v('--accent-muted')   ?? 'rgba(33, 113, 181, 0.08)',
  };
}

/** uPlot plugin that draws the filter band overlay on the chart. */
function filterBandPlugin(
  getFilterEnabled: () => boolean,
  getHighPass: () => number,
  getLowPass: () => number,
  theme: ReturnType<typeof getThemeColors>,
): uPlot.Plugin {
  return {
    hooks: {
      drawClear: [
        (u: uPlot) => {
          if (!getFilterEnabled()) return;
          const ctx = u.ctx;
          const xScale = u.scales.x;
          if (!xScale || xScale.min == null || xScale.max == null) return;

          const hp = Math.log10(Math.max(getHighPass(), 1e-6));
          const lp = Math.log10(Math.max(getLowPass(), 1e-6));

          // Convert log10(freq) to pixel positions
          const left = u.valToPos(hp, 'x', true);
          const right = u.valToPos(lp, 'x', true);
          const top = u.bbox.top / devicePixelRatio;
          const height = u.bbox.height / devicePixelRatio;

          ctx.save();

          // Shaded passband rectangle
          ctx.fillStyle = 'rgba(33, 113, 181, 0.06)';
          ctx.fillRect(left, top, right - left, height);

          // Dashed cutoff lines
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = theme.accent;
          ctx.globalAlpha = 0.6;

          // High-pass cutoff line
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(left, top + height);
          ctx.stroke();

          // Low-pass cutoff line
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right, top + height);
          ctx.stroke();

          // Labels
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.8;
          ctx.font = '10px sans-serif';
          ctx.fillStyle = theme.accent;
          ctx.textAlign = 'center';
          ctx.fillText('HP', left, top + 12);
          ctx.fillText('LP', right, top + 12);

          ctx.restore();
        },
      ],
    },
  };
}

export function SpectrumPanel() {
  let containerRef: HTMLDivElement | undefined;
  let uplotInstance: uPlot | undefined;

  createEffect(
    on([spectrumData, filterEnabled], () => {
      if (uplotInstance) {
        uplotInstance.destroy();
        uplotInstance = undefined;
      }

      const data = spectrumData();
      if (!data || !containerRef) return;

      const theme = getThemeColors();

      // Convert frequency axis to log10 for display
      const logFreqs: number[] = [];
      const psdVals: number[] = [];
      for (let i = 1; i < data.freqs.length; i++) {
        const f = data.freqs[i];
        if (f <= 0) continue;
        logFreqs.push(Math.log10(f));
        psdVals.push(data.psd[i]);
      }

      if (logFreqs.length === 0) return;

      const chartData: uPlot.AlignedData = [
        new Float64Array(logFreqs),
        new Float64Array(psdVals),
      ];

      const opts: uPlot.Options = {
        width: containerRef.clientWidth || 400,
        height: 280,
        plugins: [
          filterBandPlugin(
            filterEnabled,
            () => data.highPassHz,
            () => data.lowPassHz,
            theme,
          ),
        ],
        scales: {
          x: { time: false },
          y: {},
        },
        series: [
          {},
          {
            label: 'PSD',
            stroke: theme.accent,
            width: 1.5,
            fill: 'rgba(33, 113, 181, 0.04)',
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
            values: (_u: uPlot, vals: number[]) =>
              vals.map((v) => v.toFixed(0)),
          },
        ],
        legend: { show: false },
        cursor: { show: true },
      };

      uplotInstance = new uPlot(opts, chartData, containerRef);
    }),
  );

  // ResizeObserver for sidebar open/close reflow
  let resizeRaf: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (uplotInstance && containerRef) {
        const w = containerRef.clientWidth;
        if (w > 0) uplotInstance.setSize({ width: w, height: 280 });
      }
    });
  });

  createEffect(() => {
    if (containerRef) resizeObserver.observe(containerRef);
  });

  onCleanup(() => {
    resizeObserver.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (uplotInstance) {
      uplotInstance.destroy();
      uplotInstance = undefined;
    }
  });

  const fs = () => samplingRate() ?? 0;

  return (
    <div class="spectrum-panel">
      <h3 class="spectrum-panel__title">Spectrum</h3>
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
            <div ref={containerRef} class="spectrum-panel__chart" />
            <div class="spectrum-panel__info">
              <div class="spectrum-panel__stat">
                <span class="spectrum-panel__stat-label">Cell</span>
                <span class="spectrum-panel__stat-value">{data().cellIndex + 1}</span>
              </div>
              <div class="spectrum-panel__stat">
                <span class="spectrum-panel__stat-label">Fs</span>
                <span class="spectrum-panel__stat-value">{fs()} Hz</span>
              </div>
              <div class="spectrum-panel__stat">
                <span class="spectrum-panel__stat-label">HP</span>
                <span class="spectrum-panel__stat-value">{data().highPassHz.toFixed(3)} Hz</span>
              </div>
              <div class="spectrum-panel__stat">
                <span class="spectrum-panel__stat-label">LP</span>
                <span class="spectrum-panel__stat-value">{data().lowPassHz.toFixed(1)} Hz</span>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
