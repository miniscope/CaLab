/**
 * Where a run's files go: its run folder in the project folder
 * (`calab-project/runs/<run id>/`, `docs/projects.md`), with each session's
 * export at the session's path below it. With the File System Access API
 * (Chrome, Edge) the files are written in place (`sinkInDirectory`); elsewhere
 * the same tree downloads as one zip (`zipResultsSink`), which also carries the
 * project file and the index.
 */
import { boundaryFlagJson, type BoundaryFlag } from './boundary-flags.ts';
import { ZipStreamWriter, type ByteSink } from '@calab/io';
import { PROJECT_DIR, type WritableDirLike, type WritableFileLike } from '@calab/project';
import { downloadBlob, memorySink } from './export.ts';
import type { LibraryMode } from './session-run.ts';

export type { WritableDirLike, WritableFileLike };

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

// ---- Where the files go ----

/** Where a run's results are written. Paths are relative to the run folder. */
export interface ResultsSink {
  /** The run folder, for people (`<project folder>/runs/<run id>`). */
  readonly root: string;
  readonly method: 'directory' | 'zip';
  /** Stream a file. */
  writeFile(path: string, write: (sink: ByteSink) => Promise<void>): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /**
   * A zip only: a file relative to the project folder (the project file and the index), so the
   * download holds the whole tree. A directory sink has none: those files are written in place.
   */
  writeProjectText?(path: string, text: string): Promise<void>;
  /** Done: a zip is offered as a download; a directory has nothing left to do. */
  finish(): Promise<void>;
}

function segments(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..'))
    throw new Error(`Not a results path: ${path}`);
  return parts;
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
 * Results as one zip download holding the same tree (no File System Access API: Firefox,
 * Safari): `calab-project/runs/<run id>/...` plus the project files given through
 * `writeProjectText`. Each file is built in memory and added whole, and a file written twice
 * keeps its last version.
 */
export function zipResultsSink(
  /** The run folder below the project folder (`runs/<run id>`). */
  runFolder: string,
  deliver: (name: string, blob: Blob) => void = downloadBlob,
): ResultsSink {
  const files = new Map<string, Uint8Array>();
  const writeFile = async (path: string, write: (sink: ByteSink) => Promise<void>) => {
    const sink = memorySink();
    await write(sink);
    files.set(`${runFolder}/${segments(path).join('/')}`, new Uint8Array(sink.toArrayBuffer()));
  };
  return {
    root: `${PROJECT_DIR}/${runFolder}`,
    method: 'zip',
    writeFile,
    writeText: async (path, text) => {
      files.set(`${runFolder}/${segments(path).join('/')}`, new TextEncoder().encode(text));
    },
    writeProjectText: async (path, text) => {
      files.set(segments(path).join('/'), new TextEncoder().encode(text));
    },
    async finish() {
      const out = memorySink();
      const zip = new ZipStreamWriter(out);
      for (const [path, bytes] of files) await zip.addFile(`${PROJECT_DIR}/${path}`, bytes);
      await zip.finish();
      // The run keeps its sink until the next run starts: do not keep every
      // session's export alive with it.
      files.clear();
      deliver(
        `${PROJECT_DIR}_${runFolder.split('/').pop()}.zip`,
        new Blob([out.toArrayBuffer()], { type: 'application/zip' }),
      );
    },
  };
}
