// Shared infrastructure and reactive signals from @calab/community
export { supabaseEnabled, user, authLoading, loadFieldOptions } from '@calab/community';

// CaDecon-specific modules
export { fetchSubmissions, deleteSubmission } from './cadecon-service.ts';
export { validateSubmission } from './quality-checks.ts';
export { submitToSupabase } from './submit-action.ts';
export type { CadeconSubmission, CadeconFilterState } from './types.ts';
