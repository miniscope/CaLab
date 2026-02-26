// Shared infrastructure and reactive signals from @calab/community
export {
  supabaseEnabled,
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
  signInWithEmail,
  signOut,
  user,
  authLoading,
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
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

// CaDecon-specific modules
export { submitParameters, fetchSubmissions, deleteSubmission } from './cadecon-service.ts';
export { validateSubmission } from './quality-checks.ts';
export { submitToSupabase } from './submit-action.ts';
export type { FormFields, CadeconSubmissionContext } from './submit-action.ts';
export type { CadeconSubmission, CadeconSubmissionPayload, CadeconFilterState } from './types.ts';
