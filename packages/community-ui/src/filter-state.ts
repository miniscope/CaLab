// Filter descriptors and clearing for the community browser.

import { INDICATOR_OPTIONS } from '@calab/compute';
import type { ExtraFilter } from './FilterBar.tsx';

/**
 * The demo-data filter: pick which simulated indicator a demo submission was
 * generated from. Its option ids come from the simulator's own indicator list,
 * so they match the id recorded on demo submissions — see `matchesDemoPreset`,
 * which compares them, and `demoPresetMetadata`, which writes them.
 */
export const DEMO_PRESET_FILTER: ExtraFilter = {
  id: 'demoPreset',
  label: 'All presets',
  options: INDICATOR_OPTIONS.map(({ id, label }) => ({ id, label })),
};

/**
 * Every filter key reset to null, or `current` unchanged when nothing is set
 * (so clearing an already-clear state doesn't invalidate downstream memos).
 *
 * Keys come from the current state, which keeps this correct for each app's
 * filter shape without naming their fields.
 */
export function clearedFilterState<F extends object>(current: F): F {
  const entries = Object.entries(current);
  if (entries.every(([, value]) => value === null)) return current;
  return Object.fromEntries(entries.map(([key]) => [key, null])) as F;
}
