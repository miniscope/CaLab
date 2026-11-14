/**
 * Several recordings (sessions) under one selected folder.
 *
 * Miniscope V4 writes one folder per device inside a time-stamped experiment
 * folder: `data/2026_11_10/14_02_33/My_V4_Miniscope/0.avi, 1.avi, ...` with the
 * device `metaData.json` and `timeStamps.csv` beside the videos, a behaviour
 * camera in `BehavCam_0/` next to it, and an experiment-level `metaData.json`
 * (with `recordingStartTime`) one folder up. Older DAQ software writes
 * `mouse1/day1/msCam1.avi ... behavCam1.avi` in one folder.
 *
 * Each numbered video series becomes a session candidate. Series that are "the
 * same kind of recording" across days (the same prefix, or the same device
 * folder name) form a kind; the Miniscope kind is chosen the way
 * `chooseSeries` chooses a series, and the user is asked only when it is
 * ambiguous. A kind's role (Miniscope or behaviour camera) comes from the
 * Miniscope metaData.json files when they say (`device-roles.ts`, read by
 * `discoverKinds`), else from the names. Apart from `discoverKinds`, pure
 * functions on names and strings; nothing reads a file.
 */
import type { FolderEntry } from './frame-source.ts';
import { readDeviceRoles, roleFromName, type RoleInfo, type RoleSource } from './device-roles.ts';
import { naturalCompare } from './natural-sort.ts';
import { detectSeries, dirOf, seriesLabel, type VideoSeries } from './video-series.ts';

/** Same patterns as the sidecar lookup in `frame-source.ts`. */
const METADATA_NAME = /(?:^|[_-])metadata\.json$/i;
const TIMESTAMPS_NAME = /(?:^|[_-])time_?stamps?\.csv$/i;
const MINISCOPE_DIR = /miniscope/i;

function basename(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash < 0 ? dir : dir.slice(slash + 1);
}

/** Series that are "the same kind of recording" across sessions. */
export interface SeriesKind {
  key: string;
  /** e.g. `msCam*.avi` or `My_V4_Miniscope/<number>.avi` */
  label: string;
  /** Natural order of dir. */
  series: VideoSeries<FolderEntry>[];
  /** Total video files. */
  files: number;
  /**
   * Miniscope or behaviour camera, when its series agree (from metadata, else
   * names); null when unknown or mixed.
   */
  role: RoleInfo | null;
}

const SOURCE_RANK: Record<RoleSource, number> = { experiment: 0, device: 1, name: 2 };

/** One role for a kind: its series' roles when they do not conflict, the strongest source. */
function kindRole(roles: (RoleInfo | null)[]): RoleInfo | null {
  const known = roles.filter((r): r is RoleInfo => r !== null);
  if (known.length === 0) return null;
  if (known.some((r) => r.role !== known[0].role)) return null;
  const source = known.reduce(
    (best, r) => (SOURCE_RANK[r.source] < SOURCE_RANK[best] ? r.source : best),
    known[0].source,
  );
  return { role: known[0].role, source };
}

/** True when a role came from metaData.json rather than a name. */
const fromMetadata = (r: RoleInfo | null): r is RoleInfo => r !== null && r.source !== 'name';

/** Kind key: the prefix when there is one, else the device folder name; plus the extension. */
export function seriesKindKey(s: VideoSeries): string {
  const ext = s.ext.toLowerCase();
  return s.prefix !== ''
    ? `p:${s.prefix.toLowerCase()}:${ext}`
    : `d:${basename(s.dir).toLowerCase()}:${ext}`;
}

/**
 * Group series into kinds. `roles` (by `series.key`, from `readDeviceRoles`)
 * says what the metadata found; series without one fall back to their names.
 */
export function groupKinds(
  series: VideoSeries<FolderEntry>[],
  roles: ReadonlyMap<string, RoleInfo> = new Map(),
): SeriesKind[] {
  const byKey = new Map<string, SeriesKind>();
  for (const s of series) {
    const key = seriesKindKey(s);
    let k = byKey.get(key);
    if (!k) {
      const label =
        s.prefix !== '' || basename(s.dir) === ''
          ? seriesLabel(s)
          : `${basename(s.dir)}/${seriesLabel(s)}`;
      k = { key, label, series: [], files: 0, role: null };
      byKey.set(key, k);
    }
    k.series.push(s);
    k.files += s.files.length;
  }
  const out = [...byKey.values()];
  for (const k of out) {
    k.series.sort((a, b) => naturalCompare(a.dir, b.dir));
    k.role = kindRole(
      k.series.map((s) => {
        const r = roles.get(s.key);
        if (r) return r;
        const named = roleFromName(s);
        return named ? { role: named, source: 'name' as const } : null;
      }),
    );
  }
  return out;
}

/**
 * Several Miniscope kinds as one: a dual-scope rig (two Miniscope folders per
 * session) or a device folder renamed between days. Each series stays its own
 * session, so every Miniscope is listed rather than one picked.
 */
export function mergeKinds(kinds: SeriesKind[]): SeriesKind {
  const series = kinds
    .flatMap((k) => k.series)
    .sort((a, b) => naturalCompare(a.dir, b.dir) || naturalCompare(a.key, b.key));
  return {
    key: kinds.map((k) => k.key).join('+'),
    label: kinds.map((k) => k.label).join(' + '),
    series,
    files: kinds.reduce((n, k) => n + k.files, 0),
    role: kindRole(kinds.map((k) => k.role)),
  };
}

/**
 * Same narrowing idea as `chooseSeries`, at kind level:
 *  1. One kind: chosen.
 *  2. Kinds that metaData.json says are Miniscopes: chosen, all of them (merged
 *     by `mergeKinds` when there are several); every other kind is left out.
 *  3. Drop camera kinds (metadata, a behaviour prefix, or a device folder named
 *     behav...) unless nothing else is left.
 *  4. Prefer the Miniscope prefixes (none, `msCam`).
 *  5. Prefer a kind with a directory whose path mentions "miniscope".
 * Candidates are sorted by file count (most first), then key; chosen is the
 * single one left, else null.
 */
export function chooseKind(kinds: SeriesKind[]): {
  chosen: SeriesKind | null;
  candidates: SeriesKind[];
} {
  if (kinds.length === 0) return { chosen: null, candidates: [] };
  let cands = kinds;
  const narrow = (keep: (k: SeriesKind) => boolean) => {
    const kept = cands.filter(keep);
    if (kept.length > 0) cands = kept;
  };
  const prefixOf = (k: SeriesKind) => k.series[0].prefix;
  if (cands.length > 1) {
    const scopes = cands.filter((k) => fromMetadata(k.role) && k.role.role === 'miniscope');
    if (scopes.length > 0) {
      const chosen = scopes.length === 1 ? scopes[0] : mergeKinds(scopes);
      return { chosen, candidates: [chosen] };
    }
  }
  const isCamera = (k: SeriesKind) =>
    k.role?.role === 'camera' ||
    (k.role === null && k.series.some((s) => roleFromName(s) === 'camera'));
  if (cands.length > 1) narrow((k) => !isCamera(k));
  if (cands.length > 1) {
    narrow((k) => ['', 'mscam'].includes(prefixOf(k).toLowerCase()));
  }
  if (cands.length > 1) narrow((k) => k.series.some((s) => MINISCOPE_DIR.test(s.dir)));
  const ordered = [...cands].sort((a, b) => b.files - a.files || naturalCompare(a.key, b.key));
  return { chosen: ordered.length === 1 ? ordered[0] : null, candidates: ordered };
}

export interface SessionCandidate {
  /** = series.key */
  id: string;
  /** Series dir relative to the selection root (`''` for loose files). */
  dir: string;
  /** Dir without its first component (the picked folder); `'(selected files)'` for loose files. */
  name: string;
  series: VideoSeries<FolderEntry>;
  /** What to open: the series' videos plus the sidecars in exactly `dir`. */
  entries: FolderEntry[];
  /** metaData.json entries in `dir` and each ancestor up to the root, nearest first. */
  metaEntries: FolderEntry[];
}

function sessionName(dir: string): string {
  if (dir === '') return '(selected files)';
  const slash = dir.indexOf('/');
  return slash < 0 ? dir : dir.slice(slash + 1);
}

/** `dir` and its ancestors up to the first component (the picked folder), nearest first. */
function dirChain(dir: string): string[] {
  if (dir === '') return [''];
  const parts = dir.split('/');
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) out.push(parts.slice(0, n).join('/'));
  return out;
}

export function sessionsForKind(entries: FolderEntry[], kind: SeriesKind): SessionCandidate[] {
  return kind.series.map((series) => {
    const dir = series.dir;
    const sidecars = entries.filter(
      (e) =>
        dirOf(e.relPath) === dir &&
        (METADATA_NAME.test(e.file.name) || TIMESTAMPS_NAME.test(e.file.name)),
    );
    const chain = dirChain(dir);
    const metaEntries: FolderEntry[] = [];
    for (const d of chain) {
      for (const e of entries) {
        if (dirOf(e.relPath) === d && METADATA_NAME.test(e.file.name)) metaEntries.push(e);
      }
    }
    return {
      id: series.key,
      dir,
      name: sessionName(dir),
      series,
      entries: [...series.files.map((f) => f.entry), ...sidecars],
      metaEntries,
    };
  });
}

/** Detect the series, read their metadata roles, and group them into kinds. */
export async function discoverKinds(entries: FolderEntry[]): Promise<SeriesKind[]> {
  const series = detectSeries(entries);
  return groupKinds(series, await readDeviceRoles(entries, series));
}

/**
 * All of it: detect, group, choose. `sessions` is null when ambiguous (the UI
 * shows the kinds). Pass `roles` (from `readDeviceRoles`) to use the metadata.
 */
export function discoverSessions(
  entries: FolderEntry[],
  roles?: ReadonlyMap<string, RoleInfo>,
): {
  sessions: SessionCandidate[] | null;
  kinds: SeriesKind[];
  candidates: SeriesKind[];
} {
  const kinds = groupKinds(detectSeries(entries), roles);
  const { chosen, candidates } = chooseKind(kinds);
  return { sessions: chosen ? sessionsForKind(entries, chosen) : null, kinds, candidates };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `recordingStartTime` of a metaData.json text, as ms since the epoch; null when absent or bad. */
export function parseRecordingStart(text: string): number | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const t = (json as Record<string, unknown>).recordingStartTime;
  if (typeof t !== 'object' || t === null) return null;
  const r = t as Record<string, unknown>;
  if (finite(r.msecSinceEpoch)) return r.msecSinceEpoch;
  if (!finite(r.year) || !finite(r.month) || !finite(r.day)) return null;
  const n = (v: unknown) => (finite(v) ? v : 0);
  return new Date(
    r.year,
    r.month - 1,
    r.day,
    n(r.hour),
    n(r.minute),
    n(r.second),
    n(r.msec),
  ).getTime();
}

/** By start time when every item has one (ties by natural dir), else natural dir order. */
export function defaultOrder<T extends { dir: string; startMs: number | null }>(
  items: readonly T[],
): T[] {
  const out = [...items];
  if (out.every((i) => i.startMs !== null && Number.isFinite(i.startMs))) {
    return out.sort(
      (a, b) => (a.startMs as number) - (b.startMs as number) || naturalCompare(a.dir, b.dir),
    );
  }
  return out.sort((a, b) => naturalCompare(a.dir, b.dir));
}

/** Move the item at `from` to index `to` (clamped); a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** Remove the item at `index`; a new array. */
export function removeItem<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

export interface SessionGeometry {
  name: string;
  width: number;
  height: number;
  bitDepth: number;
  fps: number | null;
}
export interface SessionCheck {
  errors: string[];
  warnings: string[];
}

/** Check every session against the first: size and bit depth must match, frame rate should. */
export function validateSessions(
  list: readonly SessionGeometry[],
  fpsTolerance = 0.01,
): SessionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (list.length === 0) return { errors, warnings };
  const first = list[0];
  const desc = (s: SessionGeometry) => `${s.width}x${s.height} ${s.bitDepth}-bit`;
  for (const s of list.slice(1)) {
    if (s.width !== first.width || s.height !== first.height || s.bitDepth !== first.bitDepth) {
      errors.push(
        `${s.name} is ${desc(s)} but ${first.name} is ${desc(first)}; all sessions must match.`,
      );
    }
    if (s.fps !== null && first.fps !== null) {
      if (Math.abs(s.fps - first.fps) > fpsTolerance * first.fps) {
        warnings.push(`${s.name} is ${s.fps} fps but ${first.name} is ${first.fps} fps.`);
      }
    }
  }
  for (const s of list) {
    if (s.fps === null) warnings.push(`The frame rate is unknown for ${s.name}.`);
  }
  return { errors, warnings };
}

export const RESULTS_DIR = 'cala-results';

function sanitizeSegment(seg: string): string {
  const s = seg.replace(/[^A-Za-z0-9._ -]/g, '_');
  return s === '.' || s === '..' ? '_' : s;
}

/** A session's result folder under the results dir: its dir minus the root name, sanitized. */
export function sessionResultsPath(dir: string, index: number): string {
  if (dir === '') return `session-${index + 1}`;
  const parts = dir.split('/').filter((p) => p !== '');
  const rel = parts.length > 1 ? parts.slice(1) : parts;
  return rel.map(sanitizeSegment).join('/') || `session-${index + 1}`;
}

/** Every session's results path made unique: later duplicates get `_2`, `_3`. */
export function uniqueResultsPaths(dirs: readonly string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir, i) => {
    const base = sessionResultsPath(dir, i);
    let p = base;
    for (let n = 2; used.has(p); n++) p = `${base}_${n}`;
    used.add(p);
    return p;
  });
}

/** The run folder: `cala-results`, or a timestamped sibling when that name is taken. */
export function runFolderName(existing: ReadonlySet<string>, now: Date): string {
  if (!existing.has(RESULTS_DIR)) return RESULTS_DIR;
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  const base = `${RESULTS_DIR}_${stamp}`;
  let name = base;
  for (let n = 2; existing.has(name); n++) name = `${base}_${n}`;
  return name;
}
