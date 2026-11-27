/**
 * Recently opened projects (Chrome, Edge): the animal folder's handle, and a
 * custom results folder's, kept in IndexedDB so reopening is one click (the
 * browser asks for permission again). Other browsers keep no handles; the
 * folder is picked again.
 */
import { idbRequest, lazyIdb } from './idb.ts';

export const MAX_RECENT = 12;
const DB_NAME = 'cala-projects';
const STORE = 'recent';

export interface RecentProject {
  id: string;
  name: string;
  /** The animal folder (a FileSystemDirectoryHandle). */
  handle: unknown;
  /** A results folder the user picked instead of `<animal>/cala-results`. */
  resultsHandle: unknown | null;
  openedAt: string;
}

export interface RecentStore {
  /** Most recent first. */
  list(): Promise<RecentProject[]>;
  put(r: RecentProject): Promise<void>;
  remove(id: string): Promise<void>;
}

type SameEntry = { isSameEntry?: (other: unknown) => Promise<boolean>; name?: string };

/** Whether two handles are the same folder (`isSameEntry`; by name where it is missing). */
export async function sameFolder(a: unknown, b: unknown): Promise<boolean> {
  const x = a as SameEntry;
  if (typeof x?.isSameEntry === 'function') {
    try {
      return await x.isSameEntry(b);
    } catch {
      return false;
    }
  }
  return x?.name !== undefined && x.name === (b as SameEntry)?.name;
}

/** Add or refresh a project at the top of the list; the oldest beyond `MAX_RECENT` go. */
export async function rememberProject(
  store: RecentStore,
  handle: { name: string },
  resultsHandle: unknown | null,
  now: Date,
): Promise<RecentProject> {
  const all = await store.list();
  let same: RecentProject | undefined;
  for (const r of all) if (await sameFolder(r.handle, handle)) same = r;
  const rec: RecentProject = {
    id: same?.id ?? `${handle.name}:${now.getTime()}`,
    name: handle.name,
    handle,
    resultsHandle: resultsHandle ?? same?.resultsHandle ?? null,
    openedAt: now.toISOString(),
  };
  await store.put(rec);
  const rest = all.filter((r) => r.id !== rec.id);
  for (const old of rest.slice(MAX_RECENT - 1)) await store.remove(old.id);
  return rec;
}

const byRecent = (a: RecentProject, b: RecentProject) =>
  a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0;

export function createMemoryRecentStore(): RecentStore {
  const map = new Map<string, RecentProject>();
  return {
    async list() {
      return [...map.values()].sort(byRecent);
    },
    async put(r) {
      map.set(r.id, r);
    },
    async remove(id) {
      map.delete(id);
    },
  };
}

/** The IndexedDB list (an empty, inert one where IndexedDB does not exist). */
export function createIndexedDbRecentStore(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): RecentStore {
  const open = lazyIdb(factory, DB_NAME, STORE, 'id');
  return {
    async list() {
      try {
        const db = await open();
        if (!db) return [];
        const all = await idbRequest<RecentProject[]>(
          db.transaction(STORE, 'readonly').objectStore(STORE).getAll(),
        );
        return all.sort(byRecent);
      } catch {
        return [];
      }
    },
    async put(r) {
      try {
        const db = await open();
        if (db) await idbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(r));
      } catch {
        // A handle that cannot be stored (or quota): the list is a convenience.
      }
    },
    async remove(id) {
      try {
        const db = await open();
        if (db) await idbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
      } catch {
        // ignore
      }
    },
  };
}
