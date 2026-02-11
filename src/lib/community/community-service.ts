// Supabase CRUD operations for community submissions.
// All functions guard with a null-check on the Supabase client
// and throw if community features are not configured.

import { supabase } from '../supabase.ts';
import type {
  CommunitySubmission,
  SubmissionPayload,
  FilterState,
} from './types.ts';

const TABLE = 'community_submissions';

/**
 * Insert a new community submission and return the created row.
 * The user_id is set automatically by Supabase RLS.
 */
export async function submitParameters(
  payload: SubmissionPayload,
): Promise<CommunitySubmission> {
  if (!supabase) throw new Error('Community features not configured');

  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(`Submit failed: ${error.message}`);
  return data as CommunitySubmission;
}

/**
 * Fetch community submissions, optionally filtered by indicator, species,
 * and/or brain region. Returns an empty array if no matches.
 */
export async function fetchSubmissions(
  filters?: FilterState,
): Promise<CommunitySubmission[]> {
  if (!supabase) throw new Error('Community features not configured');

  let query = supabase.from(TABLE).select('*');

  if (filters?.indicator) {
    query = query.eq('indicator', filters.indicator);
  }
  if (filters?.species) {
    query = query.eq('species', filters.species);
  }
  if (filters?.brainRegion) {
    query = query.eq('brain_region', filters.brainRegion);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Fetch failed: ${error.message}`);
  return (data as CommunitySubmission[]) ?? [];
}

/**
 * Fetch distinct filter values for the community browser dropdowns.
 * Returns deduplicated, sorted arrays for each filterable field.
 */
export async function fetchFilterOptions(): Promise<{
  indicators: string[];
  species: string[];
  brainRegions: string[];
}> {
  if (!supabase) throw new Error('Community features not configured');

  const [indicatorRes, speciesRes, brainRegionRes] = await Promise.all([
    supabase.from(TABLE).select('indicator'),
    supabase.from(TABLE).select('species'),
    supabase.from(TABLE).select('brain_region'),
  ]);

  if (indicatorRes.error) throw new Error(`Fetch indicators failed: ${indicatorRes.error.message}`);
  if (speciesRes.error) throw new Error(`Fetch species failed: ${speciesRes.error.message}`);
  if (brainRegionRes.error) throw new Error(`Fetch brain regions failed: ${brainRegionRes.error.message}`);

  const indicators = [...new Set(
    (indicatorRes.data as Array<{ indicator: string }>).map((r) => r.indicator),
  )].sort();

  const species = [...new Set(
    (speciesRes.data as Array<{ species: string }>).map((r) => r.species),
  )].sort();

  const brainRegions = [...new Set(
    (brainRegionRes.data as Array<{ brain_region: string }>).map((r) => r.brain_region),
  )].sort();

  return { indicators, species, brainRegions };
}

/**
 * Delete a submission by ID. RLS ensures only the owner can delete.
 */
export async function deleteSubmission(id: string): Promise<void> {
  if (!supabase) throw new Error('Community features not configured');

  const { error } = await supabase.from(TABLE).delete().eq('id', id);

  if (error) throw new Error(`Delete failed: ${error.message}`);
}

/**
 * Fetch submissions belonging to the current authenticated user.
 */
export async function fetchUserSubmissions(): Promise<CommunitySubmission[]> {
  if (!supabase) throw new Error('Community features not configured');

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', user.id);

  if (error) throw new Error(`Fetch user submissions failed: ${error.message}`);
  return (data as CommunitySubmission[]) ?? [];
}
