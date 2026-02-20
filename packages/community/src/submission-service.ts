// Generic CRUD service factory for CaLab community submissions.
// Apps create a typed service as a one-liner:
//   const service = createSubmissionService<MySubmission>('my_table');

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabase.ts';
import type { BaseSubmission, BaseFilterState } from './types.ts';

export interface SubmissionService<T extends BaseSubmission> {
  submit(payload: Omit<T, 'id' | 'created_at' | 'user_id'>): Promise<T>;
  fetch(filters?: BaseFilterState): Promise<T[]>;
  delete(id: string): Promise<void>;
}

/** Resolve the Supabase client, throwing if not configured. */
async function requireClient(): Promise<SupabaseClient> {
  const client = await getSupabase();
  if (!client) throw new Error('Community features not configured');
  return client;
}

/**
 * Create a typed CRUD service for a Supabase submission table.
 * Handles auth user injection, base filter application, and RLS-guarded delete.
 */
export function createSubmissionService<T extends BaseSubmission>(
  tableName: string,
): SubmissionService<T> {
  return {
    async submit(payload) {
      const client = await requireClient();

      const {
        data: { user },
      } = await client.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await client
        .from(tableName)
        .insert({ ...payload, user_id: user.id })
        .select()
        .single();

      if (error) throw new Error(`Submit failed: ${error.message}`);
      return data as T;
    },

    async fetch(filters?) {
      const client = await requireClient();

      let query = client.from(tableName).select('*');

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
      return (data as T[]) ?? [];
    },

    async delete(id) {
      const client = await requireClient();

      const { error } = await client.from(tableName).delete().eq('id', id);
      if (error) throw new Error(`Delete failed: ${error.message}`);
    },
  };
}
