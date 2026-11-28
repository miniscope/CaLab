/**
 * The run of a plan step (docs/stages.md, "Sessions"): one or more sessions of
 * a project through cala, with one of three library flows. A single recording
 * is a one-session project; its run is a Separate step of one session.
 *
 * - **Separate:** each session gets its own Discover and Extract, one
 *   session after another. Cell ids are per session.
 * - **Joint:** one library. Discover runs through all sessions in order and
 *   Extract solves every session with the final library, so a cell has the
 *   same id in every session. Look-back runs too: during Discover it re-reads
 *   frames of the session being read only, and the Final settle covers every
 *   session (each frame preprocessed as its own session's).
 * - **Apply:** a fixed library goes straight to Extract on each session. It
 *   needs a library from a file (`LibrarySource` in `run-stages.ts`) and is not
 *   offered.
 *
 * Every run is automatic: after Discover (and its Final settle) it runs
 * Extract, then writes the results into its run folder (`session-export.ts`),
 * and in Separate mode opens the next session. A live stream with no Extract
 * writes the traces solved as its frames came in. This module is the pure
 * part: what to do next given the stages' states.
 */
import type { StageActivity, StageName } from './run-stages.ts';

/** How a plan step's run shares the cell library. */
export type LibraryMode = 'separate' | 'joint' | 'apply';

/** Short name of each library mode. */
export const LIBRARY_MODE_LABEL: Record<LibraryMode, string> = {
  separate: 'Separate',
  joint: 'Joint',
  apply: 'Apply',
};

/**
 * A live stream's traces at the end of its Discover (`live-export.ts`): `ready` to write,
 * `empty` (no cells were found), `waiting` (not gathered yet).
 */
export type LiveResultState = 'ready' | 'empty' | 'waiting';

/** What the automatic run looks at. */
export interface AutoInput {
  /** The plan step's kind (one session: `separate`). */
  mode: LibraryMode;
  /** A live stream (null: a recording): its traces stand in for Extract's when it cannot run. */
  live?: LiveResultState | null;
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

/** What the automatic run does next. */
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

/** The next step of an automatic run. */
export function nextAutoAction(i: AutoInput): AutoAction {
  if (i.mode === 'apply') return { kind: 'stopped', reason: 'Apply is not available yet.' };
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
  const last = i.mode === 'joint' || i.session >= i.sessions - 1;
  const why = i.availability.extract;
  // A live stream whose Extract cannot run writes the traces solved as the frames came in.
  const liveTraces = i.live != null && why !== null && i.extract !== 'done';
  if (i.extract === 'done' || (liveTraces && i.live === 'ready')) {
    if (!i.exported) return { kind: 'export' };
    return last ? { kind: 'finished' } : { kind: 'next-session' };
  }
  if (liveTraces) {
    if (i.live === 'empty') return { kind: 'finished', skipped: 'no cells were found' };
    return { kind: 'wait' };
  }
  if (why === null) return { kind: 'extract' };
  if (why === NO_CELLS) {
    // Nothing to Extract. Separate mode goes on with the next session.
    const skipped = 'no cells were found';
    return last ? { kind: 'finished', skipped } : { kind: 'next-session', skipped };
  }
  return { kind: 'wait' };
}

/** Where an automatic run is, for the panel. */
export function autoStatusText(
  a: AutoAction,
  i: Pick<AutoInput, 'session' | 'sessions'> & { joint?: boolean },
): string {
  // A Joint run is one Discover over every session: no "session 1 of N" while it reads session N.
  const of = i.joint
    ? `all ${i.sessions} sessions (Joint)`
    : i.sessions === 1
      ? 'the recording'
      : `session ${i.session + 1} of ${i.sessions}`;
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
      return i.sessions === 1 ? 'Done' : 'All sessions done';
    case 'stopped':
      return `Stopped: ${a.reason}`;
  }
}
