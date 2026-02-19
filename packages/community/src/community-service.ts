// Supabase CRUD operations for community submissions.
// All functions guard with a null-check on the Supabase client
// and throw if community features are not configured.

import { getSupabase } from './supabase.ts';
import type {
  CommunitySubmission,
  SubmissionPayload,
  FilterState,
  FieldOption,
  FieldOptions,
} from './types.ts';

const TABLE = 'community_submissions';

/**
 * Insert a new community submission and return the created row.
 * Adds user_id from the current auth session (required by RLS policy).
 */
export async function submitParameters(payload: SubmissionPayload): Promise<CommunitySubmission> {
  const client = await getSupabase();
  if (!client) throw new Error('Community features not configured');

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await client
    .from(TABLE)
    .insert({ ...payload, user_id: user.id })
    .select()
    .single();

  if (error) throw new Error(`Submit failed: ${error.message}`);
  return data as CommunitySubmission;
}

/**
 * Fetch community submissions, optionally filtered by indicator, species,
 * and/or brain region. Returns an empty array if no matches.
 */
export async function fetchSubmissions(filters?: FilterState): Promise<CommunitySubmission[]> {
  const client = await getSupabase();
  if (!client) throw new Error('Community features not configured');

  let query = client.from(TABLE).select('*');

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
 * Fetch canonical field options from the field_options lookup table.
 * Returns grouped arrays ordered by display_order.
 * No login required — the table has public read access for anon.
 */
export async function fetchFieldOptions(): Promise<FieldOptions> {
  const client = await getSupabase();
  if (!client) throw new Error('Community features not configured');

  const { data, error } = await client
    .from('field_options')
    .select('field_name, value, display_order')
    .order('display_order');

  if (error) throw new Error(`Fetch field options failed: ${error.message}`);

  const rows = data as FieldOption[];
  const indicators: string[] = [];
  const species: string[] = [];
  const brainRegions: string[] = [];
  const microscopeTypes: string[] = [];
  const cellTypes: string[] = [];

  for (const row of rows) {
    switch (row.field_name) {
      case 'indicator':
        indicators.push(row.value);
        break;
      case 'species':
        species.push(row.value);
        break;
      case 'brain_region':
        brainRegions.push(row.value);
        break;
      case 'microscope_type':
        microscopeTypes.push(row.value);
        break;
      case 'cell_type':
        cellTypes.push(row.value);
        break;
    }
  }

  return { indicators, species, brainRegions, microscopeTypes, cellTypes };
}

/**
 * Delete a submission by ID. RLS ensures only the owner can delete.
 */
export async function deleteSubmission(id: string): Promise<void> {
  const client = await getSupabase();
  if (!client) throw new Error('Community features not configured');

  const { error } = await client.from(TABLE).delete().eq('id', id);

  if (error) throw new Error(`Delete failed: ${error.message}`);
}
