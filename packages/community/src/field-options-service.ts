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
