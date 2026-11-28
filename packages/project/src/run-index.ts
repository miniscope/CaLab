/**
 * `calab-index.json`: a cache of the run files plus the stream scan, and the queries the project
 * table makes on it (a stream's results, its current result, which streams share cell ids).
 * Everything here is rebuilt from the run files; the hand-set current results live in the
 * project file (`current`), not here.
 */
import type {
  IndexFile,
  IndexResult,
  IndexRun,
  IndexStream,
  ProjectFile,
  RunFile,
} from './generated/files';
import { FORMATS, OLD_FILES, RUN_FILE, RUNS_DIR, oldFormatMessage } from './formats.ts';
import { readRunFile } from './files.ts';

/** A text file below the project folder; `path` is relative to it. */
export interface ProjectTextFile {
  path: string;
  text: string;
}

/** A run file as found on disk, with its folder relative to the project folder. */
export interface FoundRun {
  folder: string;
  run: RunFile;
}

const join = (...parts: string[]) => parts.filter((p) => p !== '' && p !== '.').join('/');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const isoMs = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** An index with no streams or runs. */
export function emptyIndex(now: Date): IndexFile {
  return {
    format: FORMATS.index,
    version: 1,
    built: now.toISOString(),
    streams: [],
    runs: [],
    results: [],
  };
}

/** The run's plan kind, else read off its content: several inputs are a Joint run. */
function kindOf(run: RunFile): IndexRun['kind'] {
  if (run.run.plan) return run.run.plan.kind;
  if (run.links.some((l) => l.role === 'library')) return 'apply';
  return run.inputs.length > 1 ? 'joint' : 'separate';
}

/** A run file as an index entry. */
export function indexRun(run: RunFile, folder: string): IndexRun {
  const byStream = new Map(run.results.map((r) => [r.stream, r]));
  const refs = [...run.inputs.map((i) => i.stream), ...run.results.map((r) => r.stream)];
  return {
    id: run.run.id,
    app: run.run.app,
    kind: kindOf(run),
    status: run.run.status,
    folder,
    plan: run.run.plan ? { id: run.run.plan.id, step: run.run.plan.step } : null,
    fingerprint: run.config.fingerprint,
    created: run.run.created,
    updated: run.run.updated,
    stopped: run.run.stopped,
    links: run.links.map((l) => ({ role: l.role, run: l.run, stream: l.stream })),
    streams: [...new Set(refs)].map((stream) => {
      const r = byStream.get(stream);
      return {
        stream,
        status: r?.status ?? 'pending',
        ...(r?.note ? { note: r.note } : {}),
        boundary: r?.boundary ?? null,
      };
    }),
    stages: run.stages.map((s) => ({ ...s })),
  };
}

/** The written results of a run file, with paths relative to the project folder. */
export function indexResults(run: RunFile, folder: string): IndexResult[] {
  return run.results
    .filter((r) => r.status === 'written' && r.path !== null)
    .map((r) => ({
      run: run.run.id,
      app: run.run.app,
      stream: r.stream,
      path: join(folder, r.path!),
      id_space: r.id_space,
      cells: r.cells,
      library_version: r.library_version,
      created: r.created ?? run.run.updated,
    }));
}

/** The index with `run` added, or put in place of the entry with its id. */
export function withRun(index: IndexFile, run: RunFile, folder: string, now: Date): IndexFile {
  const entry = indexRun(run, folder);
  const runs = index.runs.filter((r) => r.id !== entry.id);
  runs.push(entry);
  runs.sort((a, b) => isoMs(a.created) - isoMs(b.created) || (a.id < b.id ? -1 : 1));
  return {
    ...index,
    built: now.toISOString(),
    runs,
    results: [...index.results.filter((r) => r.run !== entry.id), ...indexResults(run, folder)],
  };
}

/** What a walk of a project folder found among its run files. */
export interface FoundRuns {
  runs: FoundRun[];
  /** Files that were not read, each with the reason (old formats included). */
  refused: { path: string; error: string }[];
}

/**
 * The run files among the files of a project folder. A run file is read where it is
 * (`runs/<id>/calab-run.json`); a file of an older cala's format is reported, never read.
 */
export function findRunFiles(files: readonly ProjectTextFile[]): FoundRuns {
  const runs: FoundRun[] = [];
  const refused: FoundRuns['refused'] = [];
  for (const f of files) {
    const name = baseOf(f.path);
    if (OLD_FILES.includes(name)) {
      refused.push({ path: f.path, error: oldFormatMessage(f.path) });
      continue;
    }
    if (name !== RUN_FILE) continue;
    const r = readRunFile(f.text);
    if (!r.ok) refused.push({ path: f.path, error: r.error });
    else runs.push({ folder: dirOf(f.path), run: r.value });
  }
  return { runs, refused };
}

/** The index made again from the run files and the scanned streams. */
export function rebuildIndex(
  runs: readonly FoundRun[],
  streams: readonly IndexStream[],
  now: Date,
): IndexFile {
  let index: IndexFile = { ...emptyIndex(now), streams: [...streams] };
  for (const f of runs) index = withRun(index, f.run, f.folder, now);
  return index;
}

/** The folder of run `id` below the project folder. */
export function runFolder(id: string): string {
  return `${RUNS_DIR}/${id}`;
}

/** The refs a stream is known by: its own and those it had before a rename. */
function refsOf(index: IndexFile, ref: string): Set<string> {
  const s = index.streams.find((x) => x.ref === ref);
  return new Set([ref, ...(s?.previous_refs ?? [])]);
}

/** Every result of `app` for a stream (under its ref or a previous one), newest first. */
export function resultsOf(index: IndexFile, app: string, ref: string): IndexResult[] {
  const refs = refsOf(index, ref);
  return index.results
    .filter((r) => r.app === app && refs.has(r.stream))
    .sort((a, b) => isoMs(b.created) - isoMs(a.created) || (a.run < b.run ? 1 : -1));
}

/**
 * The current result of `app` for a stream: the one the project's `current` picks by hand when
 * that run still has a result for it, else the app's newest. Each app has its own.
 */
export function currentResult(
  index: IndexFile,
  current: ProjectFile['current'],
  app: string,
  ref: string,
): IndexResult | null {
  const all = resultsOf(index, app, ref);
  const refs = refsOf(index, ref);
  const picked = [...refs].map((r) => current[app]?.[r]).find((id) => id !== undefined);
  return all.find((r) => r.run === picked) ?? all[0] ?? null;
}

/** A group of streams whose current results share an id space. */
export interface IdGroup {
  space: string;
  /** For the table: `A`, `B`, ... for spaces shared by several streams; '' for a stream's own. */
  label: string;
  streams: string[];
  /** 0-based colour slot for shared spaces; -1 for own. */
  colour: number;
}

/** Which streams share cell ids: their current results of `app` are in the same id space. */
export function idSpaceGroups(
  index: IndexFile,
  current: ProjectFile['current'],
  app: string,
): Map<string, IdGroup> {
  const bySpace = new Map<string, string[]>();
  for (const s of index.streams) {
    const cur = currentResult(index, current, app, s.ref);
    if (cur) bySpace.set(cur.id_space, [...(bySpace.get(cur.id_space) ?? []), s.ref]);
  }
  const out = new Map<string, IdGroup>();
  let n = 0;
  for (const [space, streams] of bySpace) {
    const shared = streams.length > 1;
    const g: IdGroup = {
      space,
      label: shared
        ? String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : '')
        : '',
      streams,
      colour: shared ? n : -1,
    };
    if (shared) n++;
    for (const id of streams) out.set(id, g);
  }
  return out;
}
