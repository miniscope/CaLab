/**
 * Reading and writing a project's results folder (`docs/projects.md`):
 * the JSON files a rebuild needs, the index (written whole, then swapped in),
 * and the folder of a new run. Through a directory handle (File System Access
 * API) or, read-only, from the files of a picked folder.
 */
import type { FolderEntry } from './frame-source.ts';
import {
  PROJECT_INDEX_FILE,
  RUN_FILE,
  RUNS_DIR,
  SESSION_FILE,
  serializeIndex,
  type ProjectIndex,
  type ResultsFile,
} from './project-index.ts';
import {
  sinkInDirectory,
  zipResultsSink,
  type ResultsSink,
  type WritableDirLike,
} from './session-export.ts';
import { RESULTS_DIR } from './sessions.ts';

const WANTED = new Set([PROJECT_INDEX_FILE, RUN_FILE, SESSION_FILE]);
/** Deeper than any results tree: session paths are a few levels, plus `runs/<id>`. */
const MAX_DEPTH = 16;

/** The slice of a directory handle a results walk uses (a mock in tests). */
export interface ReadDirLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<ReadDirLike | { kind: 'file'; name: string; getFile(): Promise<File> }>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<ReadDirLike>;
}

/** The index and run files under a results folder, read through its handle. */
export async function readResultsFiles(dir: ReadDirLike): Promise<ResultsFile[]> {
  const out: ResultsFile[] = [];
  const walk = async (d: ReadDirLike, prefix: string, depth: number): Promise<void> => {
    for await (const child of d.values()) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.kind === 'directory') {
        if (depth < MAX_DEPTH) await walk(child, path, depth + 1);
      } else if (WANTED.has(child.name)) {
        out.push({ path, text: await (await child.getFile()).text() });
      }
    }
  };
  await walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The same, from the files of a picked folder (`<root>/cala-results/...`). */
export async function resultsFilesFromEntries(
  entries: readonly FolderEntry[],
  rootName: string,
): Promise<ResultsFile[]> {
  const prefix = `${rootName}/${RESULTS_DIR}/`;
  const picked = entries.filter((e) => e.relPath.startsWith(prefix) && WANTED.has(e.file.name));
  const out = await Promise.all(
    picked.map(async (e) => ({ path: e.relPath.slice(prefix.length), text: await e.file.text() })),
  );
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** A results folder's handle when it exists (no write needed); null when not. */
export async function existingDir(parent: ReadDirLike, name: string): Promise<ReadDirLike | null> {
  if (!parent.getDirectoryHandle) return null;
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function writeText(dir: WritableDirLike, name: string, text: string): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await w.write(text);
    await w.close();
  } catch (err) {
    await w.abort?.().catch(() => {});
    throw err;
  }
}

/**
 * Write the index. The File System Access API has no rename, but a writable
 * stream writes to a swap file that replaces the file only on `close()`, so a
 * reader sees the old index or the new one, never half of one. An unreadable
 * index found on open is kept beside it (`cala-project.corrupt-<time>.json`)
 * before the first write replaces it.
 */
export async function writeIndex(
  resultsDir: WritableDirLike,
  index: ProjectIndex,
  corrupt?: { text: string; stamp: string } | null,
): Promise<void> {
  if (corrupt)
    await writeText(resultsDir, `cala-project.corrupt-${corrupt.stamp}.json`, corrupt.text);
  await writeText(resultsDir, PROJECT_INDEX_FILE, serializeIndex(index));
}

/**
 * The folder of a new run, `<results>/runs/<id>/`. An existing folder is never
 * reused: a suffix is added. Returns the sink and the folder relative to the
 * results folder.
 */
export async function projectRunSink(
  resultsDir: WritableDirLike,
  runId: string,
  resultsLabel: string,
): Promise<{ sink: ResultsSink; folder: string }> {
  const runs = await resultsDir.getDirectoryHandle(RUNS_DIR, { create: true });
  const existing = new Set<string>();
  for await (const name of runs.keys()) existing.add(name);
  let name = runId;
  for (let n = 2; existing.has(name); n++) name = `${runId}_${n}`;
  const dir = await runs.getDirectoryHandle(name, { create: true });
  const folder = `${RUNS_DIR}/${name}`;
  return { sink: sinkInDirectory(dir, `${resultsLabel}/${folder}`), folder };
}

/** No File System Access API: the run's tree as a zip, `cala-results/runs/<id>/...`. */
export function projectZipSink(runId: string): { sink: ResultsSink; folder: string } {
  const folder = `${RUNS_DIR}/${runId}`;
  return { sink: zipResultsSink(undefined, folder), folder };
}
