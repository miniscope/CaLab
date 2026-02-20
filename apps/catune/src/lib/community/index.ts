// Shared infrastructure from @calab/community
export {
  supabaseEnabled,
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
  signInWithEmail,
  signOut,
} from '@calab/community';
export type {
  DataSource,
  BaseSubmission,
  BaseFilterState,
  SubmissionValidationResult,
  FieldOption,
  FieldOptions,
  User,
} from '@calab/community';

// CaTune-specific modules
export { submitParameters, fetchSubmissions, deleteSubmission } from './catune-service.ts';
export { validateSubmission } from './quality-checks.ts';
export { submitToSupabase } from './submit-action.ts';
export type { FormFields, SubmissionContext } from './submit-action.ts';
export type { CatuneSubmission, CatuneSubmissionPayload, CatuneFilterState } from './types.ts';

// Reactive signals
export {
  user,
  authLoading,
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
} from './community-store.ts';
