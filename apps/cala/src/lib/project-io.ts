/**
 * Reading and writing a project folder (`calab-project/`, `docs/projects.md`): the JSON files a
 * project needs, the folder of a new run, and the files of a result. Through a directory handle
 * (File System Access API) or, read-only, from the files of a picked folder. The envelope files
 * are read and written through `@calab/project`.
 */
import {
  PROJECT_DIR,
  RUNS_DIR,
  readTree,
  writeProjectDoc,
  type IndexFile,
  type ProjectFile,
  type ProjectTextFile,
  type ReadDirLike,
} from '@calab/project';
import type { FolderEntry } from './frame-source.ts';
import {
  sinkInDirectory,
  zipResultsSink,
  type ResultsSink,
  type WritableDirLike,
} from './session-export.ts';

export type { ReadDirLike };

const isJson = (name: string) => name.endsWith('.json');

/** The JSON files under a project folder, read through its handle (paths relative to it). */
export function readProjectFiles(dir: ReadDirLike): Promise<ProjectTextFile[]> {
  return readTree(dir, isJson);
}

/** The same, from the files of a picked folder (`<root>/calab-project/...`). */
export async function projectFilesFromEntries(
  entries: readonly FolderEntry[],
  rootName: string,
): Promise<ProjectTextFile[]> {
  const prefix = `${rootName}/${PROJECT_DIR}/`;
  const picked = entries.filter((e) => e.relPath.startsWith(prefix) && isJson(e.file.name));
  const out = await Promise.all(
    picked.map(async (e) => ({ path: e.relPath.slice(prefix.length), text: await e.file.text() })),
  );
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * A file under a project folder, by its path relative to it (a result's `export_path`), read
 * through the folder's handle. Throws when it is gone.
 */
export async function fileAt(dir: ReadDirLike, path: string): Promise<File> {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  const name = parts.pop();
  if (!name) throw new Error('No file was named.');
  let d = dir;
  for (const p of parts) {
    let next: ReadDirLike | null = null;
    for await (const child of d.values())
      if (child.kind === 'directory' && child.name === p) {
        next = child;
        break;
      }
    if (!next) throw new Error(`${path} is not in the project folder (no ${p}/).`);
    d = next;
  }
  for await (const child of d.values())
    if (child.kind === 'file' && child.name === name) return child.getFile();
  throw new Error(`${path} is not in the project folder.`);
}

/** The same from the files of a folder picked through a file input. */
export function fileInEntries(
  entries: readonly FolderEntry[],
  rootName: string,
  path: string,
): File {
  const want = `${rootName}/${PROJECT_DIR}/${path}`;
  const e = entries.find((x) => x.relPath === want);
  if (!e) throw new Error(`${path} is not among the files picked; pick the animal folder again.`);
  return e.file;
}

/** A folder's handle when it exists (no write needed); null when not. */
export async function existingDir(parent: ReadDirLike, name: string): Promise<ReadDirLike | null> {
  if (!parent.getDirectoryHandle) return null;
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

/** Write the project file and the index (each whole, then swapped in). */
export async function writeProject(
  dir: WritableDirLike,
  project: ProjectFile | null,
  index: IndexFile,
): Promise<void> {
  if (project) await writeProjectDoc(dir, 'project', project);
  await writeProjectDoc(dir, 'index', index);
}

/**
 * The folder of a new run, `<project>/runs/<id>/`. An existing folder is never reused: a suffix
 * is added, and the folder's name is the run's id.
 */
export async function projectRunSink(
  projectDir: WritableDirLike,
  runId: string,
  label: string,
): Promise<{ id: string; sink: ResultsSink; folder: string }> {
  const runs = await projectDir.getDirectoryHandle(RUNS_DIR, { create: true });
  const existing = new Set<string>();
  for await (const name of runs.keys()) existing.add(name);
  let id = runId;
  for (let n = 2; existing.has(id); n++) id = `${runId}_${n}`;
  const dir = await runs.getDirectoryHandle(id, { create: true });
  const folder = `${RUNS_DIR}/${id}`;
  return { id, sink: sinkInDirectory(dir, `${label}/${folder}`), folder };
}

/** No File System Access API: the run's tree (and the project files) as a zip. */
export function projectZipSink(runId: string): { id: string; sink: ResultsSink; folder: string } {
  const folder = `${RUNS_DIR}/${runId}`;
  return { id: runId, sink: zipResultsSink(folder), folder };
}
