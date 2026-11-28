/**
 * A project's files kept in this browser while they are not in a folder:
 *
 * - **The draft project file** in IndexedDB. Until write permission is granted (or always,
 *   without the File System Access API) the project file lives in memory; its mirror here keeps
 *   the plan, the defaults and the overrides across a reload. It is removed once the file is
 *   written to the folder.
 * - **Copies of the run files** in the origin private file system (OPFS), for runs that go into
 *   a zip. A zip is built in memory and downloads only when its run ends; the copy stays until
 *   then, so after a crash or a closed tab the next open of the same project offers it.
 *
 * Both are keyed by the project's folder name and its stream refs (`projectKey`), not by the
 * project id: without a project file on disk each open makes a new id.
 */
import { idbRequest, lazyIdb } from './idb.ts';
import type { ProjectFile } from '@calab/project';

/** The key of a project's stored files: its folder name and its streams. */
export function projectKey(rootName: string, refs: readonly string[]): string {
  return `${rootName}|${[...refs].sort().join(',')}`;
}

/** Where the draft project files are kept, by project key. */
export interface DraftStore {
  get(key: string): Promise<ProjectFile | null>;
  put(key: string, project: ProjectFile): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A draft store in memory (tests; a browser without IndexedDB). */
export function createMemoryDraftStore(): DraftStore {
  const map = new Map<string, ProjectFile>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, project) {
      map.set(key, structuredClone(project));
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

/** The draft store in IndexedDB (`calab-drafts`); inert where IndexedDB cannot be opened. */
export function createIdbDraftStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): DraftStore {
  const db = lazyIdb(factory, 'calab-drafts', 'projects', 'key');
  const tx = async <T>(
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> => {
    const d = await db();
    if (!d) return null;
    return idbRequest(op(d.transaction('projects', mode).objectStore('projects')));
  };
  return {
    async get(key) {
      const r = (await tx('readonly', (s) => s.get(key))) as
        { key: string; project: ProjectFile } | undefined | null;
      return r?.project ?? null;
    },
    async put(key, project) {
      await tx('readwrite', (s) => s.put({ key, project }));
    },
    async remove(key) {
      await tx('readwrite', (s) => s.delete(key));
    },
  };
}

/** A run file kept in browser storage. */
export interface SavedRun {
  /** The run's id. */
  id: string;
  /** Its `calab-run.json` text as last written. */
  text: string;
}

/** Where the run files of zip runs are kept until their run ends, by project key and run id. */
export interface RunCopyStore {
  /** Keep (or replace) the run file of run `id` of project `key`. */
  save(key: string, id: string, text: string): Promise<void>;
  /** Every run file kept for project `key`. */
  list(key: string): Promise<SavedRun[]>;
  remove(key: string, id: string): Promise<void>;
}

/** A run copy store in memory (tests). */
export function createMemoryRunCopyStore(): RunCopyStore {
  const map = new Map<string, Map<string, string>>();
  return {
    async save(key, id, text) {
      if (!map.has(key)) map.set(key, new Map());
      map.get(key)!.set(id, text);
    },
    async list(key) {
      return [...(map.get(key) ?? new Map<string, string>())].map(([id, text]) => ({ id, text }));
    },
    async remove(key, id) {
      map.get(key)?.delete(id);
    },
  };
}

/** The OPFS folder of the copies (not `cala-`: the scratch-file sweep must not remove them). */
export const RUN_COPY_DIR = 'calab-saved-runs';

type Dir = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
};
type Writable = { write(data: string): Promise<void>; close(): Promise<void> };
type WritableFile = FileSystemFileHandle & { createWritable?: () => Promise<Writable> };

/** A short stable name for a project key (a folder name may hold any character). */
export function keyName(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(16).padStart(8, '0')}`;
}

/**
 * The run copies in OPFS: `calab-saved-runs/<key name>/<run id>.json`. A browser without OPFS,
 * or without writable OPFS files on the main thread, keeps no copies (every call resolves).
 */
export function createOpfsRunCopyStore(
  storage: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined = globalThis
    .navigator?.storage,
): RunCopyStore {
  const folder = async (key: string, create: boolean): Promise<Dir | null> => {
    if (typeof storage?.getDirectory !== 'function') return null;
    try {
      const root = await storage.getDirectory();
      const top = await root.getDirectoryHandle(RUN_COPY_DIR, { create });
      return (await top.getDirectoryHandle(keyName(key), { create })) as Dir;
    } catch {
      return null;
    }
  };
  return {
    async save(key, id, text) {
      const dir = await folder(key, true);
      if (!dir) return;
      try {
        const f = (await dir.getFileHandle(`${id}.json`, { create: true })) as WritableFile;
        if (typeof f.createWritable !== 'function') return;
        const w = await f.createWritable();
        await w.write(text);
        await w.close();
      } catch {
        // Best effort: the run goes on without its copy.
      }
    },
    async list(key) {
      const dir = await folder(key, false);
      if (!dir) return [];
      const out: SavedRun[] = [];
      try {
        for await (const h of dir.values()) {
          if (h.kind !== 'file' || !h.name.endsWith('.json')) continue;
          const text = await (await (h as FileSystemFileHandle).getFile()).text();
          out.push({ id: h.name.slice(0, -'.json'.length), text });
        }
      } catch {
        // An unreadable folder offers nothing.
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async remove(key, id) {
      const dir = await folder(key, false);
      try {
        await dir?.removeEntry(`${id}.json`);
      } catch {
        // Already gone.
      }
    },
  };
}
