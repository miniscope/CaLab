export { kernelAnnotationsPlugin } from './kernel-annotations-plugin.ts';
export type { KernelAnnotations } from './kernel-annotations-plugin.ts';
export { wheelZoomPlugin } from './wheel-zoom-plugin.ts';
export { transientZonePlugin } from './transient-zone-plugin.ts';
export { AXIS_TEXT, AXIS_GRID, AXIS_TICK, getThemeColors } from './theme-colors.ts';
export { VIRIDIS_LUT, viridisRGB, viridisCss } from './colormap.ts';
export { niceTicks } from './chart-math.ts';
export {
  OKABE_ITO,
  OKABE_ITO_CYCLE,
  NEUTRAL,
  TRACE_COLORS,
  GROUND_TRUTH_COLORS,
  KERNEL_FIT_COLORS,
  METRIC_COLORS,
  DISTRIBUTION_COLORS,
  D3_CATEGORY10,
  subsetColor,
  withOpacity,
} from './series-utils.ts';
export { TracePanel } from './TracePanel.tsx';
export type { TracePanelProps } from './TracePanel.tsx';
export { TraceOverview, ROW_HEIGHT, ROW_DURATION_S } from './TraceOverview.tsx';
export type { TraceOverviewProps, HighlightZone } from './TraceOverview.tsx';
export { ZoomWindow } from './ZoomWindow.tsx';
export type { ZoomWindowProps } from './ZoomWindow.tsx';
