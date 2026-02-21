// Supabase client
export { getSupabase, supabaseEnabled } from './supabase.ts';

// Auth
export { subscribeAuth, signInWithEmail, signOut } from './auth.ts';
export type { User, AuthState } from './auth.ts';

// CRUD factory
export { createSubmissionService } from './submission-service.ts';
export type { SubmissionService } from './submission-service.ts';

// Field options
export { fetchFieldOptions } from './field-options-service.ts';
export {
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
  BRAIN_REGION_OPTIONS,
} from './field-options.ts';

// Analytics
export { initSession, trackEvent, endSession, registerSessionEndListeners } from './analytics.ts';
export type { AnalyticsEventName } from './analytics.ts';

// Utilities
export { computeDatasetHash } from './dataset-hash.ts';

// GitHub URLs
export {
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from './github-issue-url.ts';

// Types
export type {
  BaseSubmission,
  BaseSubmissionPayload,
  BaseFilterState,
  DataSource,
  SubmissionValidationResult,
  FieldOption,
  FieldOptions,
} from './types.ts';
