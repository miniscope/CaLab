export { DashboardShell } from './DashboardShell.tsx';
export { DashboardPanel } from './DashboardPanel.tsx';
export { VizLayout } from './VizLayout.tsx';
export { CompactHeader } from './CompactHeader.tsx';
export type { CompactHeaderProps } from './CompactHeader.tsx';
export { CardGrid } from './CardGrid.tsx';
export type { CardGridProps } from './CardGrid.tsx';
export { TutorialPanel } from './TutorialPanel.tsx';
export type { TutorialPanelProps } from './TutorialPanel.tsx';
export { TutorialLauncher } from './TutorialLauncher.tsx';
export type { TutorialLauncherProps } from './TutorialLauncher.tsx';
export { Card } from './Card.tsx';
export type { CardProps } from './Card.tsx';
export { WorkerIndicator } from './WorkerIndicator.tsx';
export { SimulationConfigurator } from './SimulationConfigurator.tsx';
export type { SimulationConfiguratorProps } from './SimulationConfigurator.tsx';
export type { WorkerIndicatorProps } from './WorkerIndicator.tsx';

export { TraceLegend } from './TraceLegend.tsx';
export type { TraceLegendProps, LegendItemConfig } from './TraceLegend.tsx';

// Chart utilities (also available via @calab/ui/chart sub-path)
export {
  wheelZoomPlugin,
  transientZonePlugin,
  AXIS_TEXT,
  AXIS_GRID,
  AXIS_TICK,
  getThemeColors,
  VIRIDIS_LUT,
  viridisRGB,
  viridisCss,
  niceTicks,
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
} from './chart/index.ts';
