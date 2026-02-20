// Fetch canonical field options from the shared field_options lookup table.

import { getSupabase } from './supabase.ts';
import type { FieldOption, FieldOptions } from './types.ts';

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

  // Group rows by field_name, then map to the FieldOptions shape
  const grouped: Record<FieldOption['field_name'], string[]> = {
    indicator: [],
    species: [],
    brain_region: [],
    microscope_type: [],
    cell_type: [],
  };
  for (const row of rows) {
    grouped[row.field_name].push(row.value);
  }

  return {
    indicators: grouped.indicator,
    species: grouped.species,
    brainRegions: grouped.brain_region,
    microscopeTypes: grouped.microscope_type,
    cellTypes: grouped.cell_type,
  };
}
