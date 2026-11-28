/**
 * Folder IO for project files through the File System Access API (or a mock with the same
 * shape): a walk that reads the JSON files a project needs, and whole-file writes of the
 * envelope files. Apps write envelope files only through `writeProjectDoc`, which checks them.
 */
import type { IndexFile, ProjectFile, RunFile } from './generated/files';
import { fileText } from './files.ts';
import { FILE_NAMES, type FileKind } from './formats.ts';
import type { ProjectTextFile } from './run-index.ts';

/** The slice of a directory handle a read walk uses. */
export interface ReadDirLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<ReadDirLike | { kind: 'file'; name: string; getFile(): Promise<File> }>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<ReadDirLike>;
}

/** The slice of a writable directory handle the writers use. */
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

/** Deeper than any project tree: stream refs are a few levels, plus `runs/<id>`. */
const MAX_DEPTH = 16;

/** The files under `dir` whose name `wanted` accepts, with paths relative to `dir`, sorted. */
export async function readTree(
  dir: ReadDirLike,
  wanted: (name: string) => boolean,
): Promise<ProjectTextFile[]> {
  const out: ProjectTextFile[] = [];
  const walk = async (d: ReadDirLike, prefix: string, depth: number): Promise<void> => {
    for await (const child of d.values()) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.kind === 'directory') {
        if (depth < MAX_DEPTH) await walk(child, path, depth + 1);
      } else if (wanted(child.name)) {
        out.push({ path, text: await (await child.getFile()).text() });
      }
    }
  };
  await walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Write `text` to `name` in `dir`. A writable stream writes to a swap file that replaces the file
 * only on `close()`, so a reader sees the old file or the new one, never half of one.
 */
export async function writeTextFile(
  dir: WritableDirLike,
  name: string,
  text: string,
): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await w.write(text);
    await w.close();
  } catch (err) {
    await w.abort?.().catch(() => {});
    throw err;
  }
}

/** Write an envelope file of `kind` into `dir` under its standard name (checked first). */
export async function writeProjectDoc(
  dir: WritableDirLike,
  kind: FileKind,
  doc: ProjectFile | RunFile | IndexFile,
): Promise<void> {
  await writeTextFile(dir, FILE_NAMES[kind], fileText(kind, doc));
}
