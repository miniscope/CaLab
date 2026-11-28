/**
 * Where the run settings are shown (`RunSettings.tsx`), which decides when a change takes effect:
 * - `setup`: the setup page, before Run (`ProjectView`);
 * - `single`: the Run tab of one recording (the next Discover start);
 * - `separate`: a Separate session run (each session starts Discover again: the next session);
 * - `joint`: a Joint session run (one Discover over every session: the next run).
 */
export type SettingsContext = 'setup' | 'single' | 'separate' | 'joint';

/** When a change to a start-time setting applies, in words. */
export function appliesText(ctx: SettingsContext): string {
  switch (ctx) {
    case 'setup':
      return 'Read when Discover starts: every run started from this page uses it.';
    case 'separate':
      return 'Read when Discover starts: in this Separate run a change applies from the next session.';
    case 'joint':
      return 'Read when Discover starts: a Joint run is one Discover over every session, so a change applies to the next run.';
    default:
      return 'Read when Discover starts: a change applies from the next start (restart with ↻).';
  }
}
