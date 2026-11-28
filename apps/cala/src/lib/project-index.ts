/**
 * cala's view of a project (`docs/projects.md`): what the session table shows for each stream,
 * read from the index of `@calab/project` (its runs and results) and the project file's hand-set
 * current results. Also the animal-folder helpers of the open dialog. Pure functions on plain
 * data; nothing here reads or writes a file (`project-io.ts` does).
 */
import {
  currentResult,
  idSpaceGroups,
  resultsOf,
  type IndexFile,
  type IndexResult,
  type IndexRun,
  type ProjectFile,
} from '@calab/project';
import { parseBoundaryFlag, type BoundaryFlag } from './boundary-flags.ts';
import type { LibraryMode } from './session-run.ts';
import { CALA_APP } from './run-file.ts';

/** A cala result of a stream, as the session table lists it. */
export interface ProjectResult {
  /** The stream ref. */
  session: string;
  run: string;
  /** The export, relative to the project folder. */
  export_path: string;
  cells: number | null;
  /** Results with the same id space share cell ids: cell 7 is the same neuron in each. */
  id_space: string;
  library_version: number | null;
  created: string;
  current: boolean;
}

/** A stream's ref: its dir (which starts with the picked folder's name) relative to that folder. */
export function projectSessionId(dir: string): string {
  const slash = dir.indexOf('/');
  return slash < 0 ? '.' : dir.slice(slash + 1);
}

export type StageState = 'done' | 'error' | 'cancelled' | 'running' | 'none';

export interface SessionStatus {
  discover: StageState;
  extract: StageState;
  /** The run the status comes from: the current result's, else the latest run with the stream. */
  run: string | null;
  current: ProjectResult | null;
  /** All cala results of the stream, newest first. */
  results: ProjectResult[];
  /** The latest run's word on it when it produced no result: skipped, failed. */
  note: string | null;
  /** That run's health flag of the boundary the stream starts with (Joint, streams 2..). */
  boundary: BoundaryFlag | null;
  /** That run's kind and its streams (for "re-plan as Separate"). */
  runMode: LibraryMode | null;
  runSessions: string[];
}

function lastOf(stages: readonly Record<string, unknown>[], name: string): StageState {
  const runs = stages.filter((s) => s.stage === name);
  if (runs.length === 0) return 'none';
  const o = runs[runs.length - 1].outcome;
  return o === 'done' || o === 'error' || o === 'cancelled' || o === 'running' ? o : 'none';
}

const isoMs = (s: string): number => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
};

function asResult(r: IndexResult, current: IndexResult | null): ProjectResult {
  return {
    session: r.stream,
    run: r.run,
    export_path: r.path,
    cells: r.cells,
    id_space: r.id_space,
    library_version: r.library_version,
    created: r.created,
    current: current !== null && current.run === r.run && current.stream === r.stream,
  };
}

/** What the table shows for stream `ref`. */
export function sessionStatus(
  index: IndexFile,
  current: ProjectFile['current'],
  ref: string,
): SessionStatus {
  const s = index.streams.find((x) => x.ref === ref);
  const refs = new Set([ref, ...(s?.previous_refs ?? [])]);
  const cur = currentResult(index, current, CALA_APP, ref);
  const results = resultsOf(index, CALA_APP, ref).map((r) => asResult(r, cur));
  const runsWith = index.runs.filter(
    (r) => r.app === CALA_APP && r.streams.some((x) => refs.has(x.stream)),
  );
  const latest = runsWith.reduce<IndexRun | null>(
    (best, r) => (!best || isoMs(r.created) >= isoMs(best.created) ? r : best),
    null,
  );
  const from = cur ? (index.runs.find((r) => r.id === cur.run) ?? null) : latest;
  const entry = from?.streams.find((x) => refs.has(x.stream)) ?? null;
  const stages = from?.stages ?? [];
  let note: string | null = null;
  if (!cur && entry && entry.status !== 'written') {
    note =
      entry.status === 'pending'
        ? from?.stopped
          ? `stopped: ${from.stopped}`
          : 'not finished'
        : `${entry.status}${entry.note ? `: ${entry.note}` : ''}`;
  }
  return {
    discover: lastOf(stages, 'discover'),
    extract: lastOf(stages, 'extract'),
    run: from?.id ?? null,
    current: results.find((r) => r.current) ?? null,
    results,
    note,
    boundary: entry?.boundary ? parseBoundaryFlag(entry.boundary) : null,
    runMode: from?.kind ?? null,
    runSessions: from?.streams.map((x) => x.stream) ?? [],
  };
}

/** A group of streams sharing cell ids, as the table letters it. */
export interface IdGroup {
  space: string;
  /** `A`, `B`, ... for spaces shared by several streams; '' for a stream's own. */
  label: string;
  /** The streams whose current results are in this space. */
  sessions: string[];
  /** 0-based colour slot for shared spaces; -1 for own. */
  colour: number;
}

/** Which streams share cell ids: their current cala results are in the same id space. */
export function sharedIdGroups(
  index: IndexFile,
  current: ProjectFile['current'],
): Map<string, IdGroup> {
  const out = new Map<string, IdGroup>();
  for (const [ref, g] of idSpaceGroups(index, current, CALA_APP))
    out.set(ref, { space: g.space, label: g.label, sessions: g.streams, colour: g.colour });
  return out;
}

// ---- Several animals in one folder ----

/** Folder names that look like a date, a time or a numbered session, not an animal. */
const NOT_ANIMAL = [
  /^\d{4}[-_.]?\d{1,2}[-_.]?\d{1,2}/, // YYYY_MM_DD, YYYYMMDD
  /^\d{1,2}[-_.]\d{2}([-_.]\d{2})?$/, // HH_MM_SS
  /^(day|session|ses|sess|d|s|rec|recording|trial|run)[-_ ]?\d+$/i,
  /^\d+$/,
];

export interface SplitGroup {
  /** The top-level subfolder. */
  folder: string;
  sessions: string[];
}

/**
 * Whether a picked folder holds several animals: at least two top-level
 * subfolders that each hold at least `minSessions` sessions and are not
 * named like a date, a time or a numbered session. Null: one animal.
 */
export function suggestSplit(sessionIds: readonly string[], minSessions = 2): SplitGroup[] | null {
  const groups = new Map<string, string[]>();
  for (const id of sessionIds) {
    if (id === '.' || !id.includes('/')) continue;
    const top = id.slice(0, id.indexOf('/'));
    groups.set(top, [...(groups.get(top) ?? []), id]);
  }
  const animals = [...groups.entries()]
    .filter(
      ([folder, ids]) => ids.length >= minSessions && !NOT_ANIMAL.some((re) => re.test(folder)),
    )
    .map(([folder, sessions]) => ({ folder, sessions }))
    .sort((a, b) => (a.folder < b.folder ? -1 : 1));
  return animals.length >= 2 ? animals : null;
}
