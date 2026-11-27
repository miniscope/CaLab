// Supabase client
export { getSupabase, supabaseEnabled } from './supabase.ts';

// Auth
export { subscribeAuth, signInWithEmail, signOut, isAuthReturnFragment } from './auth.ts';
export type { User, AuthState } from './auth.ts';

// CRUD factory
export { createSubmissionService } from './submission-service.ts';
export type { SubmissionService } from './submission-service.ts';

// Field options
export {
  BEHAVIOR_OPTIONS,
  EXPRESSION_OPTIONS,
  GENOTYPE_OPTIONS,
  INDICATOR_OPTIONS,
  PREPARATION_OPTIONS,
  SCOPE_MODEL_OPTIONS,
} from './field-options.ts';

// Analytics
export { initSession, trackEvent, updateTesterTag } from './analytics.ts';
export type { AnalyticsEventName } from './analytics.ts';
export { analyticsEnabled, setAnalyticsEnabled, ANALYTICS_OFF_KEY } from './analytics-consent.ts';

// Utilities
export { computeDatasetHash } from './dataset-hash.ts';
export { demoPresetMetadata, readDemoPreset } from './demo-preset.ts';

// GitHub URLs
export {
  buildFieldOptionRequestUrl,
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from './github-issue-url.ts';
export type { AppLabel } from './github-issue-url.ts';

// Reactive community store (SolidJS signals — requires solid-js peer dep)
// Importing is side-effect free; the auth subscription starts on
// initCommunityStore() or the first user()/authLoading() read.
export {
  initCommunityStore,
  user,
  authLoading,
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
} from './community-store.ts';

// Types
export type {
  BaseSubmission,
  BaseFilterState,
  DataSource,
  SubmissionValidationResult,
  FieldOption,
  FieldOptions,
} from './types.ts';

export {
  getTesterTag,
  setTesterTag,
  sanitizeTesterTag,
  TESTER_TAG_KEY,
  TESTER_TAG_MAX,
} from './tester-tag.ts';

// Data donation (apps/cala/docs/data-donation.md)
export {
  donationAuthError,
  donationAuthLoading,
  donationEnabled,
  donationReturnUrl,
  donationUser,
  getDonationSupabase,
  initDonationAuth,
  isDonationAuthReturn,
  linkError,
  separateDonationProject,
  signInForDonation,
  signOutDonation,
  tokensFromHash,
  urlWithoutDonationReturn,
} from './donation-auth.ts';
export {
  DONATION_CHUNK_NAME,
  DONATION_MAX_BYTES,
  DONATION_MAX_CHUNK_BYTES,
  DONATION_MAX_META_BYTES,
  DONATION_MAX_TIMESTAMPS_BYTES,
  DonationApiError,
  createDonation,
  donationPreviewUrl,
  donationUploadUrl,
  finishDonation,
  listDonations,
  listPublicDonations,
  putPresigned,
  reviewDonation,
  setDonationBenchmark,
  withdrawDonation,
} from './donation-service.ts';
export type {
  DonationFile,
  DonationLicense,
  DonationMeta,
  DonationRow,
  DonationSharing,
  DonationStatus,
  PresignedRequest,
  PublicDonation,
  SubjectSex,
} from './donation-service.ts';
export {
  acknowledgementText,
  dandiConfig,
  dandiDownloadUrl,
  dandiFolderUrl,
  dandiViewUrl,
  donationDandi,
  loadDandiCollection,
} from './dandi.ts';
export type { DandiAsset, DandiCollection, DandiConfig } from './dandi.ts';
