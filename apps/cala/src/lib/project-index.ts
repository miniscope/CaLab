/**
 * The project index of an animal (`docs/projects.md`): `cala-results/cala-project.json`.
 *
 * A project is an animal folder of recording sessions. The index records the
 * sessions (what `metaData.json` and the videos say), the runs made on them
 * (append-only) and their results, with one current result per session. It
 * is a cache of what the run folders hold: `rebuildIndex` makes it again from
 * every `cala-run.json` and `cala-session.json` under the results folder,
 * including trees written by multi-session runs before projects existed.
 *
 * Pure functions on plain data; nothing here reads or writes a file
 * (`project-io.ts` does).
 */
import type { LibraryMode } from './session-run.ts';

export const PROJECT_INDEX_FILE = 'cala-project.json';
export const PROJECT_FORMAT = 'cala-project';
export const PROJECT_SCHEMA_VERSION = 1;
/** Runs made from the project view go to `<results>/runs/<run id>/`. */
export const RUNS_DIR = 'runs';
export const RUN_FILE = 'cala-run.json';
export const SESSION_FILE = 'cala-session.json';
export const EXPORT_FILE = 'cala-export.npz';

/** One stage run as `stageMeta` writes it (`export.ts`). */
export interface StageRecord {
  stage: string;
  outcome: string;
  started_at?: string | null;
  ended_at?: string | null;
  [key: string]: unknown;
}

export interface ProjectSession {
  /** The session folder relative to the animal folder ('.' for videos in the root). */
  id: string;
  /** `recordingStartTime`, ISO. */
  start: string | null;
  frames: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  /** The folder is gone (and no renamed folder matched it). */
  missing: boolean;
  /** Ids it had before a rename was matched. */
  previous_ids: string[];
}

export type RunSessionStatus = 'pending' | 'written' | 'skipped' | 'failed';

export interface ProjectRunSession {
  id: string;
  status: RunSessionStatus;
  note?: string;
  /** The stages run for this session (Joint: the same for all). */
  stages: StageRecord[];
}

export interface ProjectRun {
  /** The run folder's name (a timestamp), or `legacy-<time>` for a tree at the results root. */
  id: string;
  /** Its folder relative to the results folder ('' for a #377 tree written there). */
  folder: string;
  mode: LibraryMode;
  sessions: ProjectRunSession[];
  settings: Record<string, unknown>;
  app_version: string;
  created: string;
  updated: string;
  finished: boolean;
  /** Set when the run stopped (a stage failed or was cancelled). */
  stopped?: string;
  /** A run plan's group: plan id, 1-based group, and the plan's group count. */
  plan?: { id: string; group: number; groups: number };
  /** PR 2: the library a run started from, and the one it saved. */
  library_in: null;
  library_out: null;
}

export interface ProjectResult {
  session: string;
  run: string;
  /** The export, relative to the results folder. */
  export_path: string;
  cells: number | null;
  cell_ids: number[] | null;
  /**
   * Where the cell ids come from. Results with the same id space share cell
   * ids: cell 7 is the same neuron in each of them. A Joint run is one id
   * space across its sessions (`run:<run>`); a Separate run gives each session
   * its own (`run:<run>/<session>`); a saved library (PR 2) will be
   * `library:<id>`, shared by every session it is applied to.
   */
  id_space: string;
  /** The library version the ids belong to (the final library of the run). */
  library_version: number | null;
  created: string;
  current: boolean;
}

export interface ResultsLocation {
  /** `default`: `<animal>/cala-results`; `custom`: a folder the user picked. */
  kind: 'default' | 'custom';
  /** For people: where it is. */
  label: string;
}

export interface ProjectIndex {
  format: typeof PROJECT_FORMAT;
  schema_version: number;
  project: {
    root_name: string;
    results_location: ResultsLocation;
    created: string;
    updated: string;
  };
  sessions: ProjectSession[];
  runs: ProjectRun[];
  results: ProjectResult[];
  /**
   * Reserved: cross-session matches between id spaces (cell a of space X is
   * cell b of space Y), for results of Separate runs. Not made yet; always
   * empty in schema version 1.
   */
  cell_matches: unknown[];
}

/** The id space of a run's result for a session (see `ProjectResult.id_space`). */
export function idSpaceFor(mode: LibraryMode, run: string, session: string): string {
  return mode === 'joint' ? `run:${run}` : `run:${run}/${session}`;
}

export function emptyIndex(rootName: string, location: ResultsLocation, now: Date): ProjectIndex {
  const t = now.toISOString();
  return {
    format: PROJECT_FORMAT,
    schema_version: PROJECT_SCHEMA_VERSION,
    project: { root_name: rootName, results_location: location, created: t, updated: t },
    sessions: [],
    runs: [],
    results: [],
    cell_matches: [],
  };
}

// ---- Validation ----

export type IndexRead =
  { ok: true; index: ProjectIndex } | { ok: false; error: string; newer?: boolean };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';
const MODES: readonly string[] = ['separate', 'joint', 'apply'];
const RUN_STATUSES: readonly string[] = ['pending', 'written', 'skipped', 'failed'];

function checkSession(s: unknown, i: number): string | null {
  if (!isObj(s)) return `sessions[${i}] is not an object`;
  if (!isStr(s.id) || s.id === '') return `sessions[${i}].id`;
  for (const k of ['frames', 'fps', 'width', 'height', 'bit_depth'])
    if (!isNumOrNull(s[k])) return `sessions[${i}].${k}`;
  if (!isStrOrNull(s.start)) return `sessions[${i}].start`;
  if (typeof s.missing !== 'boolean') return `sessions[${i}].missing`;
  if (!Array.isArray(s.previous_ids) || !s.previous_ids.every(isStr))
    return `sessions[${i}].previous_ids`;
  return null;
}

function checkRun(r: unknown, i: number): string | null {
  if (!isObj(r)) return `runs[${i}] is not an object`;
  if (!isStr(r.id) || r.id === '') return `runs[${i}].id`;
  if (!isStr(r.folder)) return `runs[${i}].folder`;
  if (!isStr(r.mode) || !MODES.includes(r.mode)) return `runs[${i}].mode`;
  if (!Array.isArray(r.sessions)) return `runs[${i}].sessions`;
  for (const [j, s] of r.sessions.entries()) {
    if (!isObj(s) || !isStr(s.id) || !isStr(s.status) || !RUN_STATUSES.includes(s.status))
      return `runs[${i}].sessions[${j}]`;
    if (!Array.isArray(s.stages) || !s.stages.every((x) => isObj(x) && isStr(x.stage)))
      return `runs[${i}].sessions[${j}].stages`;
  }
  if (!isObj(r.settings)) return `runs[${i}].settings`;
  for (const k of ['app_version', 'created', 'updated']) if (!isStr(r[k])) return `runs[${i}].${k}`;
  if (typeof r.finished !== 'boolean') return `runs[${i}].finished`;
  return null;
}

function checkResult(r: unknown, i: number): string | null {
  if (!isObj(r)) return `results[${i}] is not an object`;
  for (const k of ['session', 'run', 'export_path', 'created'])
    if (!isStr(r[k])) return `results[${i}].${k}`;
  if (!isNumOrNull(r.cells)) return `results[${i}].cells`;
  if (r.cell_ids !== null && !(Array.isArray(r.cell_ids) && r.cell_ids.every(Number.isFinite)))
    return `results[${i}].cell_ids`;
  if (typeof r.current !== 'boolean') return `results[${i}].current`;
  if (!isStr(r.id_space) || r.id_space === '') return `results[${i}].id_space`;
  if (!isNumOrNull(r.library_version)) return `results[${i}].library_version`;
  return null;
}

/** Check a parsed `cala-project.json`. A newer schema is reported (`newer`), not guessed at. */
export function validateIndex(json: unknown): IndexRead {
  if (!isObj(json)) return { ok: false, error: 'not a JSON object' };
  if (json.format !== PROJECT_FORMAT) return { ok: false, error: 'not a cala project index' };
  const v = json.schema_version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    return { ok: false, error: 'no schema version' };
  if (v > PROJECT_SCHEMA_VERSION)
    return { ok: false, newer: true, error: `schema version ${v} is newer than this app's` };
  const p = json.project;
  if (!isObj(p) || !isStr(p.root_name) || !isStr(p.created) || !isStr(p.updated))
    return { ok: false, error: 'bad project block' };
  const loc = p.results_location;
  if (!isObj(loc) || (loc.kind !== 'default' && loc.kind !== 'custom') || !isStr(loc.label))
    return { ok: false, error: 'bad results location' };
  for (const [key, check] of [
    ['sessions', checkSession],
    ['runs', checkRun],
    ['results', checkResult],
  ] as const) {
    const list = json[key];
    if (!Array.isArray(list)) return { ok: false, error: `no ${key} list` };
    for (const [i, item] of list.entries()) {
      const bad = check(item, i);
      if (bad) return { ok: false, error: `bad ${bad}` };
    }
  }
  if (!Array.isArray(json.cell_matches)) return { ok: false, error: 'no cell_matches list' };
  return { ok: true, index: json as unknown as ProjectIndex };
}

export function parseIndex(text: string): IndexRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : err})` };
  }
  return validateIndex(json);
}

export function serializeIndex(index: ProjectIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

// ---- Sessions: scan, rename matching, missing ----

/** A session as the project scan found it. */
export interface ScannedSession {
  id: string;
  startMs: number | null;
  frames: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
}

/** A session's id: its dir (which starts with the picked folder's name) relative to that folder. */
export function projectSessionId(dir: string): string {
  const slash = dir.indexOf('/');
  return slash < 0 ? '.' : dir.slice(slash + 1);
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const isoMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** Same recording: the same start time and frame count, both known. */
function sameRecording(
  a: { start: string | null; frames: number | null },
  b: { startMs: number | null; frames: number | null },
): boolean {
  return (
    a.start !== null &&
    b.startMs !== null &&
    a.frames !== null &&
    b.frames !== null &&
    isoMs(a.start) === b.startMs &&
    a.frames === b.frames
  );
}

function fromScan(s: ScannedSession, prev: ProjectSession | null): ProjectSession {
  return {
    id: s.id,
    start: iso(s.startMs) ?? prev?.start ?? null,
    frames: s.frames ?? prev?.frames ?? null,
    fps: s.fps ?? prev?.fps ?? null,
    width: s.width ?? prev?.width ?? null,
    height: s.height ?? prev?.height ?? null,
    bit_depth: s.bitDepth ?? prev?.bit_depth ?? null,
    missing: false,
    previous_ids: prev ? [...prev.previous_ids] : [],
  };
}

export interface Reconciled {
  index: ProjectIndex;
  /** [old id, new id] of folders matched after a rename. */
  renamed: [string, string][];
  /** Ids in the index whose folder is gone. */
  missing: string[];
  /** Ids new to the index. */
  added: string[];
}

/**
 * Bring the index's sessions in line with a scan. A known id keeps its
 * entry (metadata refreshed). An indexed session whose folder is gone is
 * matched to an unknown scanned one with the same start time and frame
 * count (exactly one candidate): a rename, so its results follow it. Else
 * it stays, flagged `missing`. Scanned sessions left over are added.
 */
export function reconcileSessions(index: ProjectIndex, scanned: ScannedSession[]): Reconciled {
  const known = new Map(index.sessions.map((s) => [s.id, s]));
  const scanIds = new Set(scanned.map((s) => s.id));
  const unknownScans = scanned.filter((s) => !known.has(s.id));
  const renamed: [string, string][] = [];
  const missing: string[] = [];
  const renameTo = new Map<string, ScannedSession>();
  const claimed = new Set<string>();
  for (const s of index.sessions) {
    if (scanIds.has(s.id)) continue;
    const cands = unknownScans.filter((u) => !claimed.has(u.id) && sameRecording(s, u));
    const othersWant = (u: ScannedSession) =>
      index.sessions.some((o) => o !== s && !scanIds.has(o.id) && sameRecording(o, u));
    if (cands.length === 1 && !othersWant(cands[0])) {
      renameTo.set(s.id, cands[0]);
      claimed.add(cands[0].id);
      renamed.push([s.id, cands[0].id]);
    } else {
      missing.push(s.id);
    }
  }
  const scanById = new Map(scanned.map((s) => [s.id, s]));
  const sessions: ProjectSession[] = [];
  for (const s of index.sessions) {
    const scan = scanById.get(s.id);
    if (scan) sessions.push(fromScan(scan, s));
    else if (renameTo.has(s.id)) {
      const n = fromScan(renameTo.get(s.id)!, s);
      n.previous_ids = [...s.previous_ids, s.id];
      sessions.push(n);
    } else sessions.push({ ...s, missing: true });
  }
  const added = unknownScans.filter((u) => !claimed.has(u.id));
  for (const u of added) sessions.push(fromScan(u, null));
  const idMap = new Map(renamed);
  const results = index.results.map((r) =>
    idMap.has(r.session) ? { ...r, session: idMap.get(r.session)! } : r,
  );
  return {
    index: { ...index, sessions: sortSessions(sessions), results },
    renamed,
    missing,
    added: added.map((u) => u.id),
  };
}

/** By start time where known, then id. */
export function sortSessions(list: ProjectSession[]): ProjectSession[] {
  return [...list].sort((a, b) => {
    const ta = isoMs(a.start);
    const tb = isoMs(b.start);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---- Results and the current-result rule ----

/**
 * Add a result. It becomes current when its session has no current result,
 * or when it is at least as new as the current one (the rule: the newest
 * result of a run that covers the session is current). A result already in
 * the index (same session and run) is replaced.
 */
export function addResult(index: ProjectIndex, r: Omit<ProjectResult, 'current'>): ProjectIndex {
  const others = index.results.filter((x) => !(x.session === r.session && x.run === r.run));
  const cur = others.find((x) => x.session === r.session && x.current);
  const newer = !cur || (isoMs(r.created) ?? 0) >= (isoMs(cur.created) ?? 0);
  const results = others.map((x) =>
    x.session === r.session && newer ? { ...x, current: false } : x,
  );
  results.push({ ...r, current: newer });
  return { ...index, results };
}

/** Make `run`'s result of `session` current (the others of that session not). */
export function setCurrent(index: ProjectIndex, session: string, run: string): ProjectIndex {
  if (!index.results.some((r) => r.session === session && r.run === run))
    throw new Error(`No result of run ${run} for ${session}.`);
  return {
    ...index,
    results: index.results.map((r) =>
      r.session === session ? { ...r, current: r.run === run } : r,
    ),
  };
}

export function currentResult(index: ProjectIndex, session: string): ProjectResult | null {
  return index.results.find((r) => r.session === session && r.current) ?? null;
}

/** Add a run, or replace the one with its id (a run in progress is written again). */
export function upsertRun(index: ProjectIndex, run: ProjectRun): ProjectIndex {
  const i = index.runs.findIndex((r) => r.id === run.id);
  const runs = [...index.runs];
  if (i < 0) runs.push(run);
  else runs[i] = run;
  return { ...index, runs };
}

/** A run id from the time (local), unique among `taken`: `2026-11-13_14-02-33`. */
export function runIdFor(now: Date, taken: ReadonlySet<string>): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const base =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

// ---- Rebuild from run folders ----

/** A JSON file under the results folder; `path` relative to it. */
export interface ResultsFile {
  path: string;
  text: string;
}

const dirname = (p: string) => (p.lastIndexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/')));
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const join = (...parts: string[]) => parts.filter((p) => p !== '').join('/');

interface FoundRun {
  folder: string;
  manifest: Record<string, unknown>;
  /** cala-session.json files of this run: their folder (relative to the run folder) and content. */
  sessions: { dir: string; meta: Record<string, unknown> }[];
}

/** Group the JSON files into runs: each `cala-session.json` belongs to the nearest `cala-run.json` above it. */
export function findRuns(files: ResultsFile[]): { runs: FoundRun[]; unreadable: string[] } {
  const unreadable: string[] = [];
  const parse = (f: ResultsFile): Record<string, unknown> | null => {
    try {
      const j: unknown = JSON.parse(f.text);
      if (isObj(j)) return j;
    } catch {
      // reported below
    }
    unreadable.push(f.path);
    return null;
  };
  const runs = new Map<string, FoundRun>();
  for (const f of files) {
    if (basename(f.path) !== RUN_FILE) continue;
    const m = parse(f);
    if (m && m.format === 'cala-run') {
      runs.set(dirname(f.path), { folder: dirname(f.path), manifest: m, sessions: [] });
    }
  }
  for (const f of files) {
    if (basename(f.path) !== SESSION_FILE) continue;
    let dir = dirname(f.path);
    let owner: FoundRun | undefined;
    for (let d = dir; ; d = dirname(d)) {
      owner = runs.get(d);
      if (owner || d === '') break;
    }
    if (!owner) continue;
    const meta = parse(f);
    if (!meta || meta.format !== 'cala-session') continue;
    dir = owner.folder === '' ? dir : dir.slice(owner.folder.length + 1);
    owner.sessions.push({ dir, meta });
  }
  return { runs: [...runs.values()], unreadable };
}

/**
 * The project session a run's session path (which starts with the folder the
 * run was picked at) belongs to: the same id; else an id the path ends with
 * (the run was picked one level up); else the same start time and frame count;
 * else the path minus its first component.
 */
export function matchSession(
  path: string,
  start: string | null,
  frames: number | null,
  sessions: readonly ProjectSession[],
): string {
  const id = projectSessionId(path);
  const ids = (s: ProjectSession) => [s.id, ...s.previous_ids];
  const exact = sessions.find((s) => ids(s).includes(id));
  if (exact) return exact.id;
  const suffix = sessions.filter((s) => ids(s).some((x) => path.endsWith(`/${x}`)));
  if (suffix.length === 1) return suffix[0].id;
  const same = sessions.filter((s) =>
    sameRecording(s, { startMs: isoMs(start), frames: frames ?? null }),
  );
  if (same.length === 1) return same[0].id;
  return id;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A run's id: its folder name below `runs/`, else `legacy-` and its folder or start time. */
export function runIdFromFolder(folder: string, created: string): string {
  if (dirname(folder) === RUNS_DIR) return basename(folder);
  if (folder !== '') return `legacy-${folder.replace(/\//g, '_')}`;
  const t = isoMs(created);
  return `legacy-${t === null ? 'run' : runIdFor(new Date(t), new Set())}`;
}

/** One run folder as index entries: the run, its sessions' results, and sessions it names that the index lacks. */
export function runFromFolder(
  found: FoundRun,
  sessions: readonly ProjectSession[],
): { run: ProjectRun; results: Omit<ProjectResult, 'current'>[]; unknown: ProjectSession[] } {
  const m = found.manifest;
  const created = str(m.created);
  const id = runIdFromFolder(found.folder, created);
  const mode = (MODES.includes(str(m.mode)) ? str(m.mode) : 'separate') as LibraryMode;
  const manifestSessions = Array.isArray(m.sessions) ? m.sessions.filter(isObj) : [];
  const unknown: ProjectSession[] = [];
  const known = [...sessions];
  const resolve = (path: string, start: string | null, frames: number | null) => {
    const sid = matchSession(path, start, frames, known);
    if (!known.some((s) => s.id === sid)) {
      const s: ProjectSession = {
        id: sid,
        start,
        frames,
        fps: null,
        width: null,
        height: null,
        bit_depth: null,
        missing: true,
        previous_ids: [],
      };
      known.push(s);
      unknown.push(s);
    }
    return sid;
  };
  const metaByResults = new Map(found.sessions.map((s) => [s.dir, s.meta]));
  const runSessions: ProjectRunSession[] = [];
  const results: Omit<ProjectResult, 'current'>[] = [];
  for (const s of manifestSessions) {
    const resultsPath = str(s.results_path);
    const meta = metaByResults.get(resultsPath);
    const start = typeof s.recording_start === 'string' ? s.recording_start : null;
    const sid = resolve(str(s.path), start, num(s.frames));
    const status = (
      RUN_STATUSES.includes(str(s.status)) ? str(s.status) : 'pending'
    ) as RunSessionStatus;
    const stages = Array.isArray(meta?.stages_run)
      ? (meta.stages_run.filter((x) => isObj(x) && isStr(x.stage)) as StageRecord[])
      : [];
    runSessions.push({
      id: sid,
      status: meta ? 'written' : status,
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
      stages,
    });
    if (meta) {
      const ids = Array.isArray(meta.cell_ids)
        ? meta.cell_ids
        : Array.isArray(meta.shared_cell_ids)
          ? meta.shared_cell_ids
          : null;
      results.push({
        session: sid,
        run: id,
        export_path: join(found.folder, resultsPath, str(meta.export_file, EXPORT_FILE)),
        cells: num(meta.cells),
        cell_ids: ids && ids.every((x) => typeof x === 'number') ? (ids as number[]) : null,
        id_space: idSpaceFor(mode, id, sid),
        library_version: num(meta.library_version),
        created: str(meta.created, created),
      });
    }
  }
  const settings = isObj(m.settings) ? m.settings : {};
  const run: ProjectRun = {
    id,
    folder: found.folder,
    mode,
    sessions: runSessions,
    settings,
    app_version: str(m.app_version),
    created,
    updated: str(m.updated, created),
    finished: m.finished === true,
    ...(typeof m.stopped === 'string' ? { stopped: m.stopped } : {}),
    ...(isObj(m.plan) && isStr(m.plan.id)
      ? {
          plan: {
            id: m.plan.id,
            group: num(m.plan.group) ?? 1,
            groups: num(m.plan.groups) ?? 1,
          },
        }
      : {}),
    library_in: null,
    library_out: null,
  };
  return { run, results, unknown };
}

/**
 * Add the runs found on disk that the index does not hold (by folder), oldest
 * first, with their results under the current-result rule. Results stay
 * current as the index says for runs it already holds.
 */
export function mergeRuns(
  index: ProjectIndex,
  found: FoundRun[],
): { index: ProjectIndex; added: string[] } {
  const folders = new Set(index.runs.map((r) => r.folder));
  const fresh = found
    .filter((f) => !folders.has(f.folder))
    .sort((a, b) => (isoMs(str(a.manifest.created)) ?? 0) - (isoMs(str(b.manifest.created)) ?? 0));
  let out = index;
  const added: string[] = [];
  for (const f of fresh) {
    const { run, results, unknown } = runFromFolder(f, out.sessions);
    const taken = new Set(out.runs.map((r) => r.id));
    if (taken.has(run.id)) run.id = runIdFor(new Date(isoMs(run.created) ?? 0), taken);
    out = { ...out, sessions: sortSessions([...out.sessions, ...unknown]) };
    out = upsertRun(out, run);
    for (const r of results)
      out = addResult(out, {
        ...r,
        run: run.id,
        id_space: idSpaceFor(run.mode, run.id, r.session),
      });
    added.push(run.id);
  }
  return { index: out, added };
}

/** The index made again from the run folders alone (current results: the newest of each session). */
export function rebuildIndex(
  rootName: string,
  location: ResultsLocation,
  scanned: ScannedSession[],
  files: ResultsFile[],
  now: Date,
): { index: ProjectIndex; unreadable: string[] } {
  const base = reconcileSessions(emptyIndex(rootName, location, now), scanned).index;
  const { runs, unreadable } = findRuns(files);
  return { index: mergeRuns(base, runs).index, unreadable };
}

// ---- Session table status ----

export type StageState = 'done' | 'error' | 'cancelled' | 'running' | 'none';

export interface SessionStatus {
  discover: StageState;
  refine: StageState;
  /** Refine runs that finished. */
  refines: number;
  extract: StageState;
  /** The run the status comes from: the current result's, else the latest run with the session. */
  run: string | null;
  current: ProjectResult | null;
  /** All results of the session, newest first. */
  results: ProjectResult[];
  /** The latest run's word on it when it produced no result: skipped, failed. */
  note: string | null;
}

function lastOf(stages: StageRecord[], name: string): StageState {
  const runs = stages.filter((s) => s.stage === name);
  if (runs.length === 0) return 'none';
  const o = runs[runs.length - 1].outcome;
  return o === 'done' || o === 'error' || o === 'cancelled' || o === 'running' ? o : 'none';
}

export function sessionStatus(index: ProjectIndex, sessionId: string): SessionStatus {
  const s = index.sessions.find((x) => x.id === sessionId);
  const ids = new Set([sessionId, ...(s?.previous_ids ?? [])]);
  const results = index.results
    .filter((r) => r.session === sessionId)
    .sort((a, b) => (isoMs(b.created) ?? 0) - (isoMs(a.created) ?? 0));
  const current = results.find((r) => r.current) ?? null;
  const runsWith = index.runs.filter((r) => r.sessions.some((x) => ids.has(x.id)));
  const latest = runsWith.reduce<ProjectRun | null>(
    (best, r) => (!best || (isoMs(r.created) ?? 0) >= (isoMs(best.created) ?? 0) ? r : best),
    null,
  );
  const from = current ? (index.runs.find((r) => r.id === current.run) ?? null) : latest;
  const entry = from?.sessions.find((x) => ids.has(x.id)) ?? null;
  const stages = entry?.stages ?? [];
  let note: string | null = null;
  if (!current && entry && entry.status !== 'written') {
    note =
      entry.status === 'pending'
        ? from?.stopped
          ? `stopped: ${from.stopped}`
          : 'not finished'
        : `${entry.status}${entry.note ? `: ${entry.note}` : ''}`;
  }
  return {
    discover: lastOf(stages, 'discover'),
    refine: lastOf(stages, 'refine'),
    refines: stages.filter((x) => x.stage === 'refine' && x.outcome === 'done').length,
    extract: lastOf(stages, 'extract'),
    run: from?.id ?? null,
    current,
    results,
    note,
  };
}

// ---- Several animals in one folder ----

/** Folder names that look like a date, a time or a numbered session, not an animal. */
const NOT_ANIMAL = [
  /^\d{4}[-_.]?\d{1,2}[-_.]?\d{1,2}/, // 2026_11_10, 20261110
  /^\d{1,2}[-_.]\d{2}([-_.]\d{2})?$/, // 14_02_33
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

// ---- Shared cell ids in the table ----

export interface IdGroup {
  /** The id space. */
  space: string;
  /** For the table: `A`, `B`, ... for spaces shared by several sessions; '' for a session's own. */
  label: string;
  /** Sessions whose current result is in this space. */
  sessions: string[];
  /** 0-based colour slot for shared spaces; -1 for own. */
  colour: number;
}

/**
 * Which sessions share cell ids: their current results are in the same id
 * space. Shared spaces are lettered in the order of their first session.
 */
export function sharedIdGroups(index: ProjectIndex): Map<string, IdGroup> {
  const bySpace = new Map<string, string[]>();
  for (const s of index.sessions) {
    const cur = currentResult(index, s.id);
    if (!cur) continue;
    bySpace.set(cur.id_space, [...(bySpace.get(cur.id_space) ?? []), s.id]);
  }
  const out = new Map<string, IdGroup>();
  let n = 0;
  for (const [space, sessions] of bySpace) {
    const shared = sessions.length > 1;
    const g: IdGroup = {
      space,
      label: shared
        ? String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : '')
        : '',
      sessions,
      colour: shared ? n : -1,
    };
    if (shared) n++;
    for (const id of sessions) out.set(id, g);
  }
  return out;
}
