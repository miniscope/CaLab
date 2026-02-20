// Reactive auth and community data signals.
// Uses shared auth helpers from @calab/community and pipes into SolidJS signals.

import { createSignal } from 'solid-js';
import {
  subscribeAuth,
  supabaseEnabled,
  fetchFieldOptions,
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  BRAIN_REGION_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
} from '@calab/community';
import type { User, FieldOptions } from '@calab/community';

// --- Auth signals ---

const [user, setUser] = createSignal<User | null>(null);
const [authLoading, setAuthLoading] = createSignal<boolean>(true);

// Subscribe to auth state changes using the shared helper
subscribeAuth((state) => {
  setUser(state.user);
  setAuthLoading(state.loading);
});

// --- Field options signals ---

const [fieldOptions, setFieldOptions] = createSignal<FieldOptions>({
  indicators: INDICATOR_OPTIONS,
  species: SPECIES_OPTIONS,
  brainRegions: BRAIN_REGION_OPTIONS,
  microscopeTypes: MICROSCOPE_TYPE_OPTIONS,
  cellTypes: CELL_TYPE_OPTIONS,
});
const [fieldOptionsLoading, setFieldOptionsLoading] = createSignal(false);
let fieldOptionsLoaded = false;

/**
 * Load canonical field options from Supabase.
 * Idempotent — only fetches once. Falls back to hardcoded arrays on failure.
 */
async function loadFieldOptions(): Promise<void> {
  if (fieldOptionsLoaded || fieldOptionsLoading()) return;
  if (!supabaseEnabled) return; // Keep fallback arrays

  setFieldOptionsLoading(true);
  try {
    const opts = await fetchFieldOptions();
    setFieldOptions(opts);
    fieldOptionsLoaded = true;
  } catch (err) {
    console.warn('Failed to load field options from DB, using fallback:', err);
  } finally {
    setFieldOptionsLoading(false);
  }
}

// --- Exports ---

export {
  // Auth signals (getters)
  user,
  authLoading,
  // Field options
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
};
