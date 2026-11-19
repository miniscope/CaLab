/**
 * Files of the compression: a window of quantized frames while it waits to
 * be compressed, and the factors of every compressed window. In the browser
 * they live in the origin private file system (OPFS), whose synchronous
 * access handles exist only in workers; tests use the in-memory store.
 */

export interface StoreFile {
  write(data: ArrayBufferView, at: number): void;
  /** Fills `into` from byte `at`; returns the bytes read. */
  read(into: ArrayBufferView, at: number): number;
  size(): number;
  close(): void;
}

export interface WindowStore {
  /** Open `name` for reading and writing, creating it when missing. */
  open(name: string): Promise<StoreFile>;
  remove(name: string): Promise<void>;
  /** Remove every file of this run. */
  clear(): Promise<void>;
}

/** The parts of OPFS used here (not in every TypeScript DOM library). */
interface SyncHandle {
  write(data: ArrayBufferView, options: { at: number }): number;
  read(into: ArrayBufferView, options: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
}
interface DirHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

/** The OPFS folder of every run's compression files. */
export const COMPRESS_ROOT = 'cala-compress';

/**
 * Handles with a call in flight. Chrome (seen with 158) never settles the
 * promise of a pending `createSyncAccessHandle()` once its file handle is
 * garbage collected: with collections forced during the call, 19 of 20 opens
 * of `(await dir.getFileHandle(name)).createSyncAccessHandle()` were lost and
 * none with the handle kept. A lost open stops the compress worker without
 * an error, so no call here runs on a handle that nothing else references.
 */
const inFlight = new Set<{ handle: object }>();

/** `call(handle)`, with `handle` kept reachable until the promise settles. */
export async function pinned<H extends object, T>(
  handle: H,
  call: (handle: H) => Promise<T>,
): Promise<T> {
  const pin = { handle };
  inFlight.add(pin);
  try {
    return await call(handle);
  } finally {
    inFlight.delete(pin);
  }
}

/** Whether a call on `handle` is in flight (for tests). */
export function isPinned(handle: object): boolean {
  for (const pin of inFlight) if (pin.handle === handle) return true;
  return false;
}

/** The part of the Web Locks API used here (tests pass a fake). */
export interface Locks {
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/** The Web Lock that marks a run folder as owned by a live context. */
const lockName = (run: string): string => `${COMPRESS_ROOT}/${run}`;

/**
 * Take the lock `name` and keep it until this context ends (the browser
 * releases it when the worker or the tab goes). Resolves once it is held,
 * or at once when the request fails (the folder is then unprotected).
 */
function holdForever(locks: Locks, name: string): Promise<void> {
  return new Promise((held) => {
    locks
      .request(name, () => {
        held();
        return new Promise(() => {});
      })
      .catch(() => held());
  });
}

/**
 * Remove another run's folder unless a live context owns it. Between stages
 * no file of a run is open, so only its lock protects it from another tab.
 */
async function sweepFolder(root: DirHandle, name: string, locks: Locks | null): Promise<void> {
  const remove = (): Promise<void> =>
    pinned(root, (r) => r.removeEntry(name, { recursive: true })).catch(() => {});
  // Without Web Locks the sweep removes every other folder, as before.
  if (!locks) return remove();
  await locks
    .request(lockName(name), { ifAvailable: true }, async (lock) => {
      // Null: the lock is held, a live tab owns the folder.
      if (lock) await remove();
    })
    .catch(() => {});
}

const webLocks = (): Locks | null =>
  typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;

/**
 * A store in its own OPFS directory (`cala-compress/<run>`). The context that
 * creates it holds the Web Lock `cala-compress/<run>` for its lifetime. The
 * first use removes the folders of other runs whose lock is free (what earlier
 * page loads left behind) and leaves those a live tab owns. `top` is the root
 * of the origin private file system and `locks` the Web Locks (tests pass
 * fakes; null: none).
 */
export function opfsStore(
  run = `run-${Date.now().toString(36)}-${crypto.randomUUID()}`,
  top: () => Promise<unknown> = () => navigator.storage.getDirectory(),
  locks: Locks | null = webLocks(),
): WindowStore {
  let dir: Promise<DirHandle> | null = null;
  const directory = (): Promise<DirHandle> =>
    (dir ??= (async () => {
      // Owned before it exists: no other tab's sweep can find it unowned.
      if (locks) await holdForever(locks, lockName(run));
      const origin = (await top()) as DirHandle;
      const root = await pinned(origin, (o) =>
        o.getDirectoryHandle(COMPRESS_ROOT, { create: true }),
      );
      const stale: string[] = [];
      for await (const name of root.keys()) if (name !== run) stale.push(name);
      for (const name of stale) await sweepFolder(root, name, locks);
      return pinned(root, (r) => r.getDirectoryHandle(run, { create: true }));
    })());
  return {
    async open(name) {
      const d = await directory();
      const file = await d.getFileHandle(name, { create: true });
      const h = await pinned(file, (f) => f.createSyncAccessHandle());
      return {
        write: (data, at) => void h.write(data, { at }),
        read: (into, at) => h.read(into, { at }),
        size: () => h.getSize(),
        close: () => {
          h.flush();
          h.close();
        },
      };
    },
    async remove(name) {
      await (await directory()).removeEntry(name).catch(() => {});
    },
    async clear() {
      const d = await directory();
      const names: string[] = [];
      for await (const name of d.keys()) names.push(name);
      for (const name of names) await d.removeEntry(name).catch(() => {});
    },
  };
}

/** A store in memory, for tests. */
export function memoryStore(): WindowStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const bytesOf = (v: ArrayBufferView): Uint8Array =>
    new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return {
    files,
    async open(name) {
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      return {
        write(data, at) {
          const src = bytesOf(data);
          let buf = files.get(name) ?? new Uint8Array(0);
          if (buf.length < at + src.length) {
            const grown = new Uint8Array(at + src.length);
            grown.set(buf);
            buf = grown;
          }
          buf.set(src, at);
          files.set(name, buf);
        },
        read(into, at) {
          const buf = files.get(name) ?? new Uint8Array(0);
          const dst = bytesOf(into);
          const part = buf.subarray(at, at + dst.length);
          dst.set(part);
          return part.length;
        },
        size: () => files.get(name)?.length ?? 0,
        close() {},
      };
    },
    async remove(name) {
      files.delete(name);
    },
    async clear() {
      files.clear();
    },
  };
}
