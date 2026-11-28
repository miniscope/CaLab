/**
 * Which params fields the pre-run sheet renders (`components/RunSettings.tsx`). The rest stay
 * settable in a config file; `SHEET_OMITS` says, per field, what sets it in the app instead.
 */
import type { ParamField } from '@calab/core';

/**
 * Fields the sheet does not render, and why: another control of the app sets them, or the app
 * does not apply them yet. A pointer ending in `/` covers its whole block.
 */
export const SHEET_OMITS: Record<string, string> = {
  '/settle/background/cap': 'set by the Speed block (Compute)',
  '/compute/': 'the Speed block; Repeatable has its own slot',
  '/export/pass_qc_only': 'chosen in the Export menu',
  '/input/crop': 'its slot (crop region)',
  '/seed/': 'its slot (footprints of a past run)',
  '/flat_field/enabled': 'decided per device by the flat-field store',
  '/discover/visit/':
    "the Speed block's visit-rate setting; the app's visit floor and cap follow the default target",
  '/qc/enabled': "the page's QC switch",
  '/factors/mode': 'the factor run plan (`?factors`)',
  '/discover/merge/guard_min_sep_d': 'follows Look-back',
  '/time/fps_override': "the app's clocks read the recording's frame rate",
  '/motion/nonrigid/': "the app's motion correction is rigid",
  '/scales/adapt': 'no diameter estimator runs yet',
};

/** The sheet renders this field (in one recording's settings, look-back on or off). */
export function sheetShows(f: ParamField, lookbackOn: boolean): boolean {
  const omitted = Object.keys(SHEET_OMITS).some(
    (p) => f.pointer === p || (p.endsWith('/') && f.pointer.startsWith(p)),
  );
  if (omitted || f.widget || f.kind === 'other') return false;
  if (f.when === 'joint') return false;
  if (f.when === 'lookback') return lookbackOn;
  return true;
}

/**
 * Fields the app's own settings set at every Discover start (`runParamsLayer`), whatever a
 * config file asks; with look-back off, `LOOKBACK_OFF_SETS` too. A loaded file's value for one
 * of these is named in the sheet as not used, and the run record lists it under `overridden`.
 */
export const SET_AT_START: Record<string, string> = {
  '/flat_field/enabled': 'the flat-field store decides it per device',
  '/discover/visit/mode': "the Speed block's visit-rate setting",
  '/qc/enabled': "the page's QC switch",
  '/compute/repeatable': 'the Repeatable setting',
  '/settle/background/cap': 'the Speed block',
  '/stages/extract': 'every run (it always Extracts after Discover)',
};

/** Fields a Discover start with look-back off sets: the options look-back is validated with. */
export const LOOKBACK_OFF_SETS = [
  '/discover/cluster/update',
  '/discover/merge/guard_min_sep_d',
  '/settle/final/level',
];
