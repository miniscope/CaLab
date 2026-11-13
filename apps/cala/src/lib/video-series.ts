/**
 * Finding the recording's video files among the selected ones.
 *
 * Miniscope software writes numbered series: `0.avi, 1.avi, ...` (V4), or
 * `msCam0.avi, msCam1.avi, ...` (older DAQ software), sometimes zero-padded
 * (`msCam001.avi`). A selected folder tree can hold several series (the
 * Miniscope and a behaviour camera, or several sessions), so this module groups
 * the files into series, ranks them, and says whether one is the clear choice
 * or the user has to pick. Pure functions on names; nothing reads a file.
 */
import { naturalCompare } from './natural-sort.ts';

/** `<prefix><number>.avi`: any non-digit prefix, the trailing digit run is the number. */
const NUMBERED_AVI = /^(\D*)(\d+)\.(avi)$/i;
/** Series prefixes that name a behaviour camera; never the calcium recording. */
const BEHAVIOUR_PREFIX = /^behav/i;
/** Prefixes the Miniscope software writes: V4 (none) and older DAQ software (msCam). */
const MINISCOPE_PREFIXES = new Set(['', 'mscam']);
const MINISCOPE_DIR = /miniscope/i;

/** A selected file with its path, structurally the same as `FolderEntry`. */
export interface NamedEntry {
  file: File;
  relPath: string;
}

export interface SeriesFile<E extends NamedEntry = NamedEntry> {
  entry: E;
  /** The number in the name, `msCam001.avi` -> 1. */
  index: number;
  /** The digits as written, `'001'`. */
  digits: string;
}

export interface VideoSeries<E extends NamedEntry = NamedEntry> {
  /** Stable identity: directory, prefix and extension. */
  key: string;
  /** Directory relative to the selection root, `''` for loose files. */
  dir: string;
  prefix: string;
  /** Extension as written in the first file (`avi` or `AVI`). */
  ext: string;
  /** Sorted by number, then by name. */
  files: SeriesFile<E>[];
}

export interface SeriesChoice<E extends NamedEntry = NamedEntry> {
  /** The series to use, when one is the clear choice. */
  chosen: VideoSeries<E> | null;
  /** The plausible series, best first; more than one when `chosen` is null. */
  candidates: VideoSeries<E>[];
}

export function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

/** Group the numbered `.avi` entries into series keyed by (directory, prefix, extension). */
export function detectSeries<E extends NamedEntry>(entries: E[]): VideoSeries<E>[] {
  const byKey = new Map<string, VideoSeries<E>>();
  for (const entry of entries) {
    const m = NUMBERED_AVI.exec(entry.file.name);
    if (!m) continue;
    const dir = dirOf(entry.relPath);
    const key = `${dir}\u0000${m[1]}\u0000${m[3].toLowerCase()}`;
    let s = byKey.get(key);
    if (!s) {
      s = { key, dir, prefix: m[1], ext: m[3], files: [] };
      byKey.set(key, s);
    }
    s.files.push({ entry, index: Number(m[2]), digits: m[2] });
  }
  const out = [...byKey.values()];
  for (const s of out) {
    s.files.sort(
      (a, b) => a.index - b.index || naturalCompare(a.entry.file.name, b.entry.file.name),
    );
  }
  return out;
}

/** True when the series prefix names a behaviour camera (`behavCam`, `behavior_`, `Behaviour-`, ...). */
export function isBehaviourPrefix(prefix: string): boolean {
  return BEHAVIOUR_PREFIX.test(prefix.trim());
}

/**
 * The clear choice among series, or the candidates to ask the user about.
 *
 *  1. One series: use it.
 *  2. Drop series whose prefix names a behaviour camera (unless nothing else is left).
 *  3. Prefer the Miniscope prefixes (`msCam`, case-insensitive, and none).
 *  4. Prefer a directory whose path mentions "miniscope".
 *  If exactly one is left it is chosen; otherwise all that are left are returned.
 */
export function chooseSeries<E extends NamedEntry>(series: VideoSeries<E>[]): SeriesChoice<E> {
  if (series.length === 0) return { chosen: null, candidates: [] };
  let cands = series;
  const narrow = (keep: (s: VideoSeries<E>) => boolean) => {
    const kept = cands.filter(keep);
    if (kept.length > 0) cands = kept;
  };
  if (cands.length > 1) narrow((s) => !isBehaviourPrefix(s.prefix));
  if (cands.length > 1) narrow((s) => MINISCOPE_PREFIXES.has(s.prefix.toLowerCase()));
  if (cands.length > 1) narrow((s) => MINISCOPE_DIR.test(s.dir));
  const ordered = [...cands].sort(
    (a, b) => b.files.length - a.files.length || naturalCompare(a.key, b.key),
  );
  return { chosen: ordered.length === 1 ? ordered[0] : null, candidates: ordered };
}

/** The name of file number `index` in a series, padded like the files that exist. */
function nameFor(s: VideoSeries, index: number, width: number): string {
  return `${s.prefix}${String(index).padStart(width, '0')}.${s.ext}`;
}

/** Warnings for numbering that is not 0, 1, 2, ... without repeats, in the files' own names. */
export function numberingWarnings(s: VideoSeries): string[] {
  const out: string[] = [];
  const seen = new Map<number, string>();
  for (const { entry, index } of s.files) {
    const name = entry.file.name;
    const prior = seen.get(index);
    if (prior !== undefined) out.push(`${prior} and ${name} have the same number; both are used.`);
    seen.set(index, name);
  }
  // Zero-padded series are padded to a common width; reuse it when naming gaps.
  const padded = s.files.some((f) => f.digits.length > 1 && f.digits.startsWith('0'));
  const width = padded ? Math.max(...s.files.map((f) => f.digits.length)) : 0;
  const unique = [...seen.keys()].sort((a, b) => a - b);
  if (unique.length > 0 && unique[0] !== 0) {
    out.push(
      `The numbering starts at ${nameFor(s, unique[0], width)}, not ${nameFor(s, 0, width)}.`,
    );
  }
  const missing: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    for (let k = unique[i - 1] + 1; k < unique[i] && missing.length < 20; k++) missing.push(k);
  }
  if (missing.length > 0) {
    out.push(`Missing ${missing.map((k) => nameFor(s, k, width)).join(', ')} in the numbering.`);
  }
  return out;
}

/** How a series reads in a list: `msCam*.avi`, or `<number>.avi` when it has no prefix. */
export function seriesLabel(s: VideoSeries): string {
  return `${s.prefix === '' ? '<number>' : `${s.prefix}*`}.${s.ext}`;
}

/**
 * The entries to open when `series` was picked: everything except the video
 * files of the other series, so the sidecars next to the chosen one stay.
 */
export function entriesForSeries<E extends NamedEntry>(
  entries: E[],
  all: VideoSeries<E>[],
  series: VideoSeries<E>,
): E[] {
  const drop = new Set<E>();
  for (const s of all) {
    if (s.key !== series.key) for (const f of s.files) drop.add(f.entry);
  }
  return entries.filter((e) => !drop.has(e));
}

/**
 * Loose `.avi` files (picked one by one, no folder) that are not numbered, in
 * natural order: the escape hatch for names no series pattern fits.
 */
export function looseAvis<E extends NamedEntry>(entries: E[]): E[] {
  return entries
    .filter((e) => !e.relPath.includes('/') && /\.avi$/i.test(e.file.name))
    .sort((a, b) => naturalCompare(a.file.name, b.file.name));
}
