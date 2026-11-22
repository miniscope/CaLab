/**
 * A multi-session run (docs/stages.md, "Sessions"): several recording
 * sessions of one animal through cala, with one of three library flows.
 *
 * - **Separate:** each session gets its own Discover and Extract, one
 *   session after another. Cell ids are per session.
 * - **Joint:** one library. Discover runs through all sessions in order and
 *   Extract solves every session with the final library, so a cell has the
 *   same id in every session. Look-back runs too: during Discover it re-reads
 *   frames of the session being read only, and the Final settle covers every
 *   session (each frame preprocessed as its own session's).
 * - **Apply:** a fixed library goes straight to Extract on each session. Not
 *   built yet (it needs a library from a file, `LibrarySource` in
 *   `run-stages.ts`); the setting has the slot so the flow can be added.
 *
 * A run with more than one session is automatic: after Discover (and its Final
 * settle) it runs Extract, then writes the results
 * (`session-export.ts`), and in Separate mode opens the next session. This
 * module is the pure part: what to do next given the stages' states.
 */
import type { StageActivity, StageName } from './run-stages.ts';

export type LibraryMode = 'separate' | 'joint' | 'apply';

export const LIBRARY_MODE_LABEL: Record<LibraryMode, string> = {
  separate: 'Separate',
  joint: 'Joint',
  apply: 'Apply',
};

export const LIBRARY_MODE_HINT: Record<LibraryMode, string> = {
  separate:
    'Each session gets its own Discover (with look-back and Final settle) and Extract. Cell ids are per session.',
  joint:
    'One library: Discover runs through all sessions in order (look-back within each session, then a Final settle over all of them), Extract solves each session with the final library. Cell ids match across sessions.',
  apply: 'A fixed library goes straight to Extract on each session (not available yet).',
};

/** The modes offered in the UI. Apply waits for libraries from a file. */
export const OFFERED_MODES: readonly LibraryMode[] = ['joint', 'separate'];

export const DEFAULT_MODE: LibraryMode = 'joint';

export interface RunSettings {
  mode: LibraryMode;
}

/** What the automatic run looks at. */
export interface AutoInput {
  settings: RunSettings;
  discover: StageActivity;
  extract: StageActivity;
  /** Why each stage cannot start now (`stageAvailability`). */
  availability: Record<StageName, string | null>;
  /** The results of the current Extract are written. */
  exported: boolean;
  /** The results are being written. */
  exporting: boolean;
  /** 0-based session being run (Separate) and the number of sessions. */
  session: number;
  sessions: number;
}

export type AutoAction =
  | { kind: 'wait' }
  | { kind: 'extract' }
  | { kind: 'export' }
  /** Separate: open session `session + 1`. `skipped`: this session produced nothing to write. */
  | { kind: 'next-session'; skipped?: string }
  | { kind: 'finished'; skipped?: string }
  /** Stopped: a stage failed or was cancelled; the user takes over. */
  | { kind: 'stopped'; reason: string };

const NO_CELLS = 'No cells were found.';

/** The next step of an automatic multi-session run. */
export function nextAutoAction(i: AutoInput): AutoAction {
  if (i.settings.mode === 'apply')
    return { kind: 'stopped', reason: 'Apply is not available yet.' };
  const running = [i.discover, i.extract].includes('running');
  if (running || i.exporting) return { kind: 'wait' };
  for (const [name, st] of [
    ['Discover', i.discover],
    ['Extract', i.extract],
  ] as const) {
    if (st === 'error') return { kind: 'stopped', reason: `${name} stopped with an error.` };
    if (st === 'cancelled') return { kind: 'stopped', reason: `${name} was cancelled.` };
  }
  if (i.discover !== 'done') return { kind: 'wait' };
  const last = i.settings.mode === 'joint' || i.session >= i.sessions - 1;
  if (i.extract === 'done') {
    if (!i.exported) return { kind: 'export' };
    return last ? { kind: 'finished' } : { kind: 'next-session' };
  }
  const why = i.availability.extract;
  if (why === null) return { kind: 'extract' };
  if (why === NO_CELLS) {
    // Nothing to Extract. Separate mode goes on with the next session.
    const skipped = 'no cells were found';
    return last ? { kind: 'finished', skipped } : { kind: 'next-session', skipped };
  }
  return { kind: 'wait' };
}

/** Where a multi-session run is, for the panel. */
export function autoStatusText(a: AutoAction, i: Pick<AutoInput, 'session' | 'sessions'>): string {
  const of = `session ${i.session + 1} of ${i.sessions}`;
  switch (a.kind) {
    case 'wait':
      return `Running ${of}`;
    case 'extract':
      return `Starting Extract on ${of}`;
    case 'export':
      return 'Writing results';
    case 'next-session':
      return a.skipped ? `Skipping ${of}: ${a.skipped}` : `Opening the next session`;
    case 'finished':
      return 'All sessions done';
    case 'stopped':
      return `Stopped: ${a.reason}`;
  }
}
