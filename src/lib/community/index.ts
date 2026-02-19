// Barrel file — public API for the community module.
// Import from 'lib/community' rather than reaching into internals.

export {
  submitParameters,
  fetchSubmissions,
  fetchFieldOptions,
  deleteSubmission,
} from './community-service.ts';
export {
  user,
  authLoading,
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
  signInWithEmail,
  signOut,
} from './community-store.ts';
export { computeDatasetHash } from './dataset-hash.ts';
export {
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
  BRAIN_REGION_OPTIONS,
} from './field-options.ts';
export {
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from './github-issue-url.ts';
export { validateSubmission } from './quality-checks.ts';
export { submitToSupabase } from './submitAction.ts';
export type { FormFields, SubmissionContext } from './submitAction.ts';
export type {
  DataSource,
  CommunitySubmission,
  SubmissionPayload,
  SubmissionMetadata,
  FilterState,
  ValidationResult,
  FieldOption,
  FieldOptions,
} from './types.ts';
