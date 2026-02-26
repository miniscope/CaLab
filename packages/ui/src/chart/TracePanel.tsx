/**
 * Reusable single-panel trace chart component wrapping uPlot via SolidUplot.
 * Renders one or more y-series on a shared x-axis with wheel zoom, cursor sync,
 * and dark theme styling. Designed to be stacked in a multi-panel layout.
 */

import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './chart-theme.css';
import { wheelZoomPlugin, AXIS_TEXT, AXIS_GRID, AXIS_TICK } from './index.ts';

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
  /** Disable built-in wheel zoom plugin (when parent handles zoom) */
  disableWheelZoom?: boolean;
  /** Lock y-axis range; undefined min/max falls back to uPlot auto-ranging */
  yRange?: [number | undefined, number | undefined];
  /** Hide y-axis tick labels (keep gridlines for visual reference) */
  hideYValues?: boolean;
  /** X-axis label (e.g., "Time (s)") */
  xLabel?: string;
  /** Callback when uPlot instance is created */
  onCreate?: (chart: uPlot) => void;
}

/** Format x-axis tick values, adapting decimal places to the visible range */
function formatTimeValues(_u: uPlot, splits: number[]): string[] {
  if (splits.length < 2) return splits.map((v) => String(v));
  const range = splits[splits.length - 1] - splits[0];
  const decimals = range < 1 ? 2 : range < 10 ? 1 : 0;
  return splits.map((v) => v.toFixed(decimals));
}

export function TracePanel(props: TracePanelProps) {
  const height = () => props.height ?? 150;

  const plugins = (): uPlot.Plugin[] => {
    const base = props.disableWheelZoom ? [] : [wheelZoomPlugin()];
    if (props.plugins) {
      return [...base, ...props.plugins];
    }
    return base;
  };

  const scales = (): uPlot.Scales => {
    const s: uPlot.Scales = { x: { time: false } };
    if (props.yRange) {
      const [yMin, yMax] = props.yRange;
      s.y = {
        range: (_u, dataMin, dataMax) => [yMin ?? dataMin, yMax ?? dataMax],
      };
    }
    return s;
  };

  // Build axes config once — stable references prevent SolidUplot from
  // recreating the chart on every data update
  const xAxis: uPlot.Axis = {
    stroke: AXIS_TEXT,
    grid: { stroke: AXIS_GRID },
    ticks: { stroke: AXIS_TICK },
    values: formatTimeValues,
    ...(props.xLabel
      ? { label: props.xLabel, labelSize: 10, labelGap: 0, labelFont: '10px sans-serif', size: 30 }
      : {}),
  };

  const yAxisBase: uPlot.Axis = {
    stroke: AXIS_TEXT,
    grid: { stroke: AXIS_GRID },
    ticks: { stroke: AXIS_TICK },
  };

  const yAxisHidden: uPlot.Axis = {
    ...yAxisBase,
    values: (_u: uPlot, vals: number[]) => vals.map(() => ''),
    size: 20,
  };

  const yAxis = () => (props.hideYValues ? yAxisHidden : yAxisBase);

  const cursorConfig = (): uPlot.Cursor => {
    const cfg: uPlot.Cursor = {
      sync: { key: props.syncKey, setSeries: true },
    };
    if (props.disableWheelZoom) {
      cfg.drag = { x: false, y: false };
    }
    return cfg;
  };

  return (
    <div class="trace-panel" style={{ height: `${height()}px` }}>
      <SolidUplot
        data={props.data()}
        series={props.series}
        scales={scales()}
        cursor={cursorConfig()}
        axes={[xAxis, yAxis()]}
        plugins={plugins()}
        height={height()}
        autoResize={true}
        onCreate={(chart) => props.onCreate?.(chart)}
      />
    </div>
  );
}
