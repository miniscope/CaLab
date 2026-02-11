/**
 * Reusable single-panel trace chart component wrapping uPlot via SolidUplot.
 * Renders one or more y-series on a shared x-axis with wheel zoom, cursor sync,
 * and dark theme styling. Designed to be stacked in a multi-panel layout.
 */

import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import { wheelZoomPlugin } from '../../lib/chart/wheel-zoom-plugin';

export interface TracePanelProps {
  /** uPlot AlignedData format: [x, y1, y2, ...] -- signal accessor for reactivity */
  data: () => [number[], ...number[][]];
  /** Series config (label, color, width). Series[0] = {} for x-axis placeholder. */
  series: uPlot.Series[];
  /** Chart height in px (default 150) */
  height?: number;
  /** Shared cursor sync key */
  syncKey: string;
  /** Additional plugins (zoom sync injected externally) */
  plugins?: uPlot.Plugin[];
}

export function TracePanel(props: TracePanelProps) {
  const height = () => props.height ?? 150;

  const plugins = (): uPlot.Plugin[] => {
    const base = [wheelZoomPlugin()];
    if (props.plugins) {
      return [...base, ...props.plugins];
    }
    return base;
  };

  return (
    <div class="trace-panel" style={{ height: `${height()}px` }}>
      <SolidUplot
        data={props.data()}
        series={props.series}
        scales={{ x: { time: false } }}
        cursor={{
          sync: {
            key: props.syncKey,
            setSeries: true,
          },
        }}
        axes={[
          {
            stroke: 'var(--text-secondary)',
            grid: { stroke: 'rgba(160, 160, 160, 0.15)' },
            ticks: { stroke: 'rgba(160, 160, 160, 0.3)' },
          },
          {
            stroke: 'var(--text-secondary)',
            grid: { stroke: 'rgba(160, 160, 160, 0.15)' },
            ticks: { stroke: 'rgba(160, 160, 160, 0.3)' },
          },
        ]}
        plugins={plugins()}
        height={height()}
        autoResize={true}
      />
    </div>
  );
}
