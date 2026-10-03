// @calab/community-ui: SolidJS components coupled to the community backend
// (@calab/community: Supabase auth, submissions, field options). Apps that do
// not use community features import only @calab/ui and never load this package.

// Auth
export { AuthCallback } from './AuthCallback.tsx';
export type { AuthCallbackProps } from './AuthCallback.tsx';
export { AuthMenuWrapper, CommunityAuthMenu } from './AuthMenuWrapper.tsx';
export type { AuthMenuWrapperProps } from './AuthMenuWrapper.tsx';
export { AuthGate } from './AuthGate.tsx';
export type { AuthGateProps } from './AuthGate.tsx';
export { isAuthCallback } from './auth-utils.ts';

// Community browser and submission widgets
export { CommunityBrowserShell } from './CommunityBrowserShell.tsx';
export type { CommunityBrowserShellProps } from './CommunityBrowserShell.tsx';
export { SearchableSelect } from './SearchableSelect.tsx';
export type { SearchableSelectProps } from './SearchableSelect.tsx';
export { PrivacyNotice } from './PrivacyNotice.tsx';
export type { PrivacyNoticeProps } from './PrivacyNotice.tsx';
export { FilterBar } from './FilterBar.tsx';
export type { FilterBarProps, ExtraFilter } from './FilterBar.tsx';
export { DEMO_PRESET_FILTER } from './filter-state.ts';
export { SubmissionSummary } from './SubmissionSummary.tsx';
export type { SubmissionSummaryProps } from './SubmissionSummary.tsx';
export { SidebarTabs } from './SidebarTabs.tsx';
export type { SidebarTabsProps, SidebarTabConfig } from './SidebarTabs.tsx';
export { SubmitFormModal } from './SubmitFormModal.tsx';
export type { SubmitFormModalProps } from './SubmitFormModal.tsx';
export { SearchableField } from './SearchableField.tsx';
export type { SearchableFieldProps, FieldSignal } from './SearchableField.tsx';

// Submission form, payload helpers, and demo ground-truth controls
export { SubmitForm } from './SubmitForm.tsx';
export type { SubmitFormProps } from './SubmitForm.tsx';
export { createSubmitFormFields } from './submit-form-fields.ts';
export type { SubmitFormFields } from './submit-form-fields.ts';
export {
  toCommunityDataSource,
  parseOptionalNumber,
  hashSubmissionDataset,
  buildBaseSubmissionPayload,
} from './submission-payload.ts';
export type {
  FormFields,
  BaseSubmissionContext,
  BaseSubmissionPayload,
} from './submission-payload.ts';
export { GroundTruthControls, GroundTruthNotices } from './GroundTruthControls.tsx';
export type { GroundTruthState, GroundTruthProps } from './GroundTruthControls.tsx';
export { CommunityScatterPlot, scatterRampColor } from './CommunityScatterPlot.tsx';
export type { CommunityScatterPlotProps, ScatterSubmission } from './CommunityScatterPlot.tsx';

// Feedback links (GitHub issues)
export { FeedbackMenu, ImportFeedbackLinks } from './FeedbackMenu.tsx';
export type { FeedbackMenuProps, ImportFeedbackLinksProps } from './FeedbackMenu.tsx';
