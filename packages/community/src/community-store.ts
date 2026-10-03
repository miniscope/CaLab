/**
 * Singleton community store using SolidJS reactive primitives (createSignal).
 *
 * Importing this module has no side effects beyond creating signals: the
 * Supabase auth subscription starts only when the app opts in, either by
 * calling `initCommunityStore()` (typically next to `initSession()` in the
 * app's index.tsx) or implicitly on the first read of `user()` /
 * `authLoading()`. Either way the start is memoised, so an app has exactly
 * one auth subscription however many modules read the store.
 */

import { createSignal } from 'solid-js';
import { subscribeAuth } from './auth.ts';
import { fetchFieldOptions } from './field-options-service.ts';
import { supabaseEnabled } from './supabase.ts';
import {
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  BRAIN_REGION_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
} from './field-options.ts';
import type { User } from './auth.ts';
import type { FieldOptions } from './types.ts';

// --- Auth signals ---

const [userSignal, setUser] = createSignal<User | null>(null);
const [authLoadingSignal, setAuthLoading] = createSignal<boolean>(true);

let authStarted = false;

/**
 * Start the store's auth subscription. Idempotent: only the first call
 * subscribes; later calls (and the implicit call inside `user()` /
 * `authLoading()`) are no-ops. Call it at app start-up so auth state begins
 * resolving before the first component reads it.
 */
function initCommunityStore(): void {
  if (authStarted) return;
  authStarted = true;
  subscribeAuth((state) => {
    setUser(state.user);
    setAuthLoading(state.loading);
  });
}

/** Current real (non-anonymous) user, or null. Starts the store on first read. */
function user(): User | null {
  initCommunityStore();
  return userSignal();
}

/** True until the first auth state arrives. Starts the store on first read. */
function authLoading(): boolean {
  initCommunityStore();
  return authLoadingSignal();
}

// --- Field options signals ---

const [fieldOptions, setFieldOptions] = createSignal<FieldOptions>({
  indicators: INDICATOR_OPTIONS,
  species: SPECIES_OPTIONS,
  brainRegions: BRAIN_REGION_OPTIONS,
  microscopeTypes: MICROSCOPE_TYPE_OPTIONS,
  cellTypes: CELL_TYPE_OPTIONS,
});
const [fieldOptionsLoading, setFieldOptionsLoading] = createSignal(false);
// Cached in-flight fetch. Collapsing the "already loading" and "already
// loaded" gates into a single promise avoids a race where two concurrent
// callers both see the boolean flags as false and issue duplicate
// requests. Subsequent calls re-await the cached promise.
let fieldOptionsPromise: Promise<void> | null = null;

/**
 * Load canonical field options from Supabase.
 * Idempotent — concurrent / repeated callers share a single fetch.
 * Falls back to hardcoded arrays on failure.
 */
async function loadFieldOptions(): Promise<void> {
  if (!supabaseEnabled) return; // Keep fallback arrays
  if (fieldOptionsPromise) return fieldOptionsPromise;

  setFieldOptionsLoading(true);
  fieldOptionsPromise = (async () => {
    try {
      const opts = await fetchFieldOptions();
      setFieldOptions(opts);
    } catch (err) {
      console.warn('Failed to load field options from DB, using fallback:', err);
      // On failure, drop the cached promise so a later call can retry.
      fieldOptionsPromise = null;
    } finally {
      setFieldOptionsLoading(false);
    }
  })();
  return fieldOptionsPromise;
}

// --- Exports ---

export {
  // Auth lifecycle
  initCommunityStore,
  // Auth signals (getters)
  user,
  authLoading,
  // Field options
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
};
