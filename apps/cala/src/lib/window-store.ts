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

const ROOT = 'cala-compress';

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

/**
 * A store in its own OPFS directory (`cala-compress/<run>`). The first use
 * removes what earlier page loads left behind; a directory another tab still
 * holds open refuses removal and is left alone. `top` is the root of the
 * origin private file system (tests pass a fake).
 */
export function opfsStore(
  run = `run-${Date.now().toString(36)}-${crypto.randomUUID()}`,
  top: () => Promise<unknown> = () => navigator.storage.getDirectory(),
): WindowStore {
  let dir: Promise<DirHandle> | null = null;
  const directory = (): Promise<DirHandle> =>
    (dir ??= (async () => {
      const origin = (await top()) as DirHandle;
      const root = await pinned(origin, (o) => o.getDirectoryHandle(ROOT, { create: true }));
      const stale: string[] = [];
      for await (const name of root.keys()) if (name !== run) stale.push(name);
      for (const name of stale) {
        await pinned(root, (r) => r.removeEntry(name, { recursive: true })).catch(() => {});
      }
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
