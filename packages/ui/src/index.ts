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
export { AuthMenu } from './AuthMenu.tsx';
export type { AuthMenuProps } from './AuthMenu.tsx';
export { AuthCallback } from './AuthCallback.tsx';
export type { AuthCallbackProps } from './AuthCallback.tsx';
export { AuthMenuWrapper } from './AuthMenuWrapper.tsx';
export type { AuthMenuWrapperProps } from './AuthMenuWrapper.tsx';
export { isAuthCallback } from './auth-utils.ts';
export { WorkerIndicator } from './WorkerIndicator.tsx';
export type { WorkerIndicatorProps } from './WorkerIndicator.tsx';

export { TraceLegend } from './TraceLegend.tsx';
export type { TraceLegendProps, LegendItemConfig } from './TraceLegend.tsx';

// Community components (shared across CaLab apps)
export { SearchableSelect } from './SearchableSelect.tsx';
export type { SearchableSelectProps } from './SearchableSelect.tsx';
export { AuthGate } from './AuthGate.tsx';
export type { AuthGateProps } from './AuthGate.tsx';
export { PrivacyNotice } from './PrivacyNotice.tsx';
export type { PrivacyNoticeProps } from './PrivacyNotice.tsx';
export { FilterBar } from './FilterBar.tsx';
export type { FilterBarProps, ExtraFilter } from './FilterBar.tsx';
export { SubmissionSummary } from './SubmissionSummary.tsx';
export type { SubmissionSummaryProps } from './SubmissionSummary.tsx';
export { SidebarTabs } from './SidebarTabs.tsx';
export type { SidebarTabsProps, SidebarTabConfig } from './SidebarTabs.tsx';
export { SubmitFormModal } from './SubmitFormModal.tsx';
export type { SubmitFormModalProps } from './SubmitFormModal.tsx';

// Chart utilities (also available via @calab/ui/chart sub-path)
export {
  wheelZoomPlugin,
  transientZonePlugin,
  AXIS_TEXT,
  AXIS_GRID,
  AXIS_TICK,
  getThemeColors,
  D3_CATEGORY10,
  subsetColor,
  withOpacity,
} from './chart/index.ts';
