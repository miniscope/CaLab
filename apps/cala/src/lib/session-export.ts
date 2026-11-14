/**
 * Per-session results of a multi-session run, written automatically when they
 * are final: after each session's Extract in Separate mode, and for every
 * session after the final Extract in Joint mode (`session-run.ts`).
 *
 * Results go to a tree parallel to the data, never into the data folders:
 *
 *   <results location>/cala-results/            run folder (cala-results_<time> if taken)
 *     cala-run.json                             run manifest: mode, settings, sessions
 *     2026_11_10/14_02_33/My_V4_Miniscope/      each session's path below the picked folder
 *       cala-export.npz                         the export (format v3, `export.ts`)
 *       cala-session.json                       session metadata
 *
 * The results location defaults to the picked data folder. With the File
 * System Access API (Chrome, Edge) the files are written in place
 * (`directoryResultsSink`, `readwrite` asked for when the run starts).
 * Elsewhere the same tree downloads as one zip (`zipResultsSink`).
 */
import { boundaryFlagJson, type BoundaryFlag } from './boundary-flags.ts';
import { ZipStreamWriter, type ByteSink } from '@calab/io';
import { downloadBlob, memorySink, stageMeta } from './export.ts';
import type { StageRun } from './run-stages.ts';
import type { LibraryMode, RunSettings } from './session-run.ts';
import { RESULTS_DIR, runFolderName } from './sessions.ts';

export const SESSION_EXPORT_FILE = 'cala-export.npz';
export const SESSION_META_FILE = 'cala-session.json';
export const RUN_MANIFEST_FILE = 'cala-run.json';
export const SESSION_FORMAT_VERSION = 1;

/** One session as the results describe it. */
export interface SessionRecord {
  index: number;
  name: string;
  /** Its folder relative to the picked data folder (including that folder's name). */
  dir: string;
  /** Its results folder relative to the run folder. */
  resultsPath: string;
  /** First frame on the run's axis (Joint) or 0 (Separate), and its frame count. */
  startFrame: number;
  frames: number;
  fps: number | null;
  /** `recordingStartTime` from metaData.json, ms since the epoch. */
  recordingStartMs: number | null;
  status: 'pending' | 'written' | 'skipped' | 'failed';
  /** Why it was skipped or failed. */
  note?: string;
  /** Joint: the health flag of the boundary this session starts with (sessions 2..; `boundary-flags.ts`). */
  boundary?: BoundaryFlag;
}

export interface SessionMetaInput {
  version: string;
  settings: RunSettings;
  session: SessionRecord;
  sessions: number;
  /** First frames of sessions 2.. on the run's axis (Joint; empty for Separate). */
  boundaries: readonly number[];
  stages: readonly StageRun[];
  libraryVersion: number;
  cells: number;
  /** Joint: the library's cell ids, the same in every session. */
  sharedCellIds: readonly number[] | null;
  /** The cell ids in this session's export (Joint: the shared ones). */
  cellIds?: readonly number[];
  createdAt: string;
}

/** `cala-session.json`. */
export function sessionMetadata(i: SessionMetaInput): Record<string, unknown> {
  const s = i.session;
  return {
    format: 'cala-session',
    format_version: SESSION_FORMAT_VERSION,
    app: 'cala',
    app_version: i.version,
    created: i.createdAt,
    mode: i.settings.mode,
    refine_runs: i.settings.refineRuns,
    stages_run: i.stages.map(stageMeta),
    session_index: s.index,
    session_count: i.sessions,
    session_name: s.name,
    session_path: s.dir,
    recording_start:
      s.recordingStartMs === null ? null : new Date(s.recordingStartMs).toISOString(),
    frames: s.frames,
    sampling_rate_hz: s.fps,
    frame_range_in_run: [s.startFrame, s.startFrame + s.frames],
    boundary_frames: [...i.boundaries],
    library_version: i.libraryVersion,
    cells: i.cells,
    shared_cell_ids: i.sharedCellIds ? [...i.sharedCellIds] : null,
    ...(i.cellIds ? { cell_ids: [...i.cellIds] } : {}),
    ...(s.boundary ? { boundary: boundaryFlagJson(s.boundary) } : {}),
    export_file: SESSION_EXPORT_FILE,
  };
}

/** The `meta_json.session` block of a session's export. */
export function exportSessionBlock(
  s: SessionRecord,
  mode: LibraryMode,
  sessions: number,
): Record<string, unknown> {
  return {
    mode,
    index: s.index,
    count: sessions,
    name: s.name,
    path: s.dir,
    start_frame: s.startFrame,
    frames: s.frames,
    ...(s.boundary ? { boundary: boundaryFlagJson(s.boundary) } : {}),
  };
}

export interface RunManifestInput {
  version: string;
  settings: RunSettings;
  sessions: readonly SessionRecord[];
  boundaries: readonly number[];
  /** The run folder's name (`cala-results` or a timestamped one). */
  root: string;
  createdAt: string;
  updatedAt: string;
  finished: boolean;
  /** Settings of the pipeline worth keeping (flat field on, ...). */
  pipeline?: Record<string, unknown>;
  /** Why the run stopped (a stage failed or was cancelled). */
  stopped?: string;
  /** A run plan's group (project view): plan id, 1-based group, group count. */
  plan?: { id: string; group: number; groups: number };
}

/** `cala-run.json` at the run folder's root. */
export function runManifest(i: RunManifestInput): Record<string, unknown> {
  return {
    format: 'cala-run',
    format_version: SESSION_FORMAT_VERSION,
    app: 'cala',
    app_version: i.version,
    created: i.createdAt,
    updated: i.updatedAt,
    finished: i.finished,
    ...(i.stopped ? { stopped: i.stopped } : {}),
    ...(i.plan ? { plan: i.plan } : {}),
    results_folder: i.root,
    mode: i.settings.mode,
    settings: { refine_runs: i.settings.refineRuns, ...(i.pipeline ?? {}) },
    boundary_frames: [...i.boundaries],
    sessions: i.sessions.map((s) => ({
      index: s.index,
      name: s.name,
      path: s.dir,
      results_path: s.resultsPath,
      start_frame: s.startFrame,
      frames: s.frames,
      sampling_rate_hz: s.fps,
      recording_start:
        s.recordingStartMs === null ? null : new Date(s.recordingStartMs).toISOString(),
      status: s.status,
      ...(s.note ? { note: s.note } : {}),
      ...(s.boundary ? { boundary: boundaryFlagJson(s.boundary) } : {}),
    })),
  };
}

// ---- Where the files go ----

/** Where a run's results are written. Paths are relative to the run folder. */
export interface ResultsSink {
  /** The run folder's name. */
  readonly root: string;
  readonly method: 'directory' | 'zip';
  /** Stream a file. */
  writeFile(path: string, write: (sink: ByteSink) => Promise<void>): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /** Done: a zip is offered as a download; a directory has nothing left to do. */
  finish(): Promise<void>;
}

/** The slice of a writable `FileSystemDirectoryHandle` the sink uses (a mock in tests). */
export interface WritableDirLike {
  readonly name: string;
  keys(): AsyncIterable<string>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileLike>;
}

export interface WritableFileLike {
  createWritable(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

function segments(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..'))
    throw new Error(`Not a results path: ${path}`);
  return parts;
}

/**
 * Results written into `location` (already granted `readwrite`), in a new run
 * folder: `cala-results`, or `cala-results_<time>` when that exists, so
 * nothing is overwritten.
 */
export async function directoryResultsSink(
  location: WritableDirLike,
  now: Date = new Date(),
): Promise<ResultsSink> {
  const existing = new Set<string>();
  for await (const name of location.keys()) existing.add(name);
  const root = runFolderName(existing, now);
  const runDir = await location.getDirectoryHandle(root, { create: true });
  return sinkInDirectory(runDir, root);
}

/** A sink writing below `runDir`; `root` is how the run folder is named for people. */
export function sinkInDirectory(runDir: WritableDirLike, root: string): ResultsSink {
  const fileIn = async (path: string): Promise<WritableFileLike> => {
    const parts = segments(path);
    let dir = runDir;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    return dir.getFileHandle(parts[parts.length - 1], { create: true });
  };
  const writeFile = async (path: string, write: (sink: ByteSink) => Promise<void>) => {
    const w = await (await fileIn(path)).createWritable();
    try {
      await write({ write: (chunk) => w.write(chunk) });
      await w.close();
    } catch (err) {
      await w.abort?.().catch(() => {});
      throw err;
    }
  };
  return {
    root,
    method: 'directory',
    writeFile,
    writeText: (path, text) =>
      writeFile(path, async (sink) => {
        await sink.write(new TextEncoder().encode(text));
      }),
    async finish() {},
  };
}

/**
 * Results as one zip download holding the same tree (no File System Access
 * API: Firefox, Safari). Each file is built in memory and added whole, and
 * a file written twice (the manifest) keeps its last version.
 */
export function zipResultsSink(
  deliver: (name: string, blob: Blob) => void = downloadBlob,
  /** Below `cala-results/` in the zip (a project run: `runs/<run id>`). */
  prefix = '',
): ResultsSink {
  const root = prefix ? `${RESULTS_DIR}/${prefix}` : RESULTS_DIR;
  const files = new Map<string, Uint8Array>();
  const writeFile = async (path: string, write: (sink: ByteSink) => Promise<void>) => {
    const sink = memorySink();
    await write(sink);
    files.set(segments(path).join('/'), new Uint8Array(sink.toArrayBuffer()));
  };
  return {
    root,
    method: 'zip',
    writeFile,
    writeText: async (path, text) => {
      files.set(segments(path).join('/'), new TextEncoder().encode(text));
    },
    async finish() {
      const out = memorySink();
      const zip = new ZipStreamWriter(out);
      for (const [path, bytes] of files) await zip.addFile(`${root}/${path}`, bytes);
      await zip.finish();
      // The run keeps its sink until the next run starts: do not keep every
      // session's export alive with it (one 10-minute session is ~65 MB).
      files.clear();
      deliver(
        `${prefix ? `${RESULTS_DIR}_${prefix.replace(/\//g, '_')}` : root}.zip`,
        new Blob([out.toArrayBuffer()], { type: 'application/zip' }),
      );
    },
  };
}

/** Readwrite permission on a directory handle (asked inside a click). */
export async function ensureReadwrite(handle: unknown): Promise<boolean> {
  const h = handle as {
    queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  if (typeof h.requestPermission !== 'function') return true;
  if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}
