/**
 * Writing files in the origin private file system (OPFS) from the main thread.
 *
 * The only way every browser lets a file be written at an arbitrary offset
 * (and written fast) is a synchronous access handle, which exists in workers
 * only. `OpfsWriterClient` owns one worker (`opfs-writer-worker.ts`) and
 * forwards open/write/close/remove calls to it; buffers are transferred, not
 * copied. Reading goes back through the main thread's `getFile()` (a `File`
 * backed by the disk, sliceable without loading it).
 *
 * Also here: `sweepOpfs` deletes leftover `cala-*` files from earlier runs or
 * crashed tabs (files another tab still has open are skipped), and
 * `opfsAvailable` says whether any of this can work.
 */
import type { OpfsRequest, OpfsResponse } from '../workers/opfs-writer-worker.ts';

/** Prefix of every file this app creates in OPFS. */
export const OPFS_PREFIX = 'cala-';

export function opfsAvailable(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

let usable: Promise<boolean> | null = null;

/**
 * Whether files can really be written: `opfsAvailable()` plus a test write
 * through a synchronous access handle (once per page). Browsers in private or
 * ephemeral storage modes expose the API but fail on first use; callers then
 * take their in-memory path instead of stopping with an opaque error.
 */
export function opfsUsable(): Promise<boolean> {
  if (!opfsAvailable()) return Promise.resolve(false);
  return (usable ??= OpfsWriterClient.shared()
    .probe()
    .then(
      () => true,
      () => false,
    ));
}

/** An error raised in the worker, rebuilt with its original `name` (e.g. QuotaExceededError). */
function rebuild(res: Extract<OpfsResponse, { ok: false }>): Error {
  const err = new Error(res.message);
  err.name = res.name;
  return err;
}

/**
 * A file is "in use" while some tab holds a Web Lock named after it. The lock
 * is taken when the file is created and released when it is removed; a closed
 * or crashed tab releases it by dying, which is what lets `sweep` delete only
 * files nobody owns (so one tab's cleanup never deletes another tab's result).
 */
const LOCK_PREFIX = 'cala-opfs:';
const heldLocks = new Map<string, () => void>();

function holdName(name: string): void {
  if (heldLocks.has(name) || typeof navigator === 'undefined' || !navigator.locks) return;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  void navigator.locks.request(LOCK_PREFIX + name, () => gate);
  heldLocks.set(name, release);
}

function releaseName(name: string): void {
  heldLocks.get(name)?.();
  heldLocks.delete(name);
}

/** Names of OPFS files some tab currently owns. */
async function ownedNames(): Promise<string[]> {
  try {
    const q = await navigator.locks.query();
    return (q.held ?? [])
      .map((l) => l.name ?? '')
      .filter((n) => n.startsWith(LOCK_PREFIX))
      .map((n) => n.slice(LOCK_PREFIX.length));
  } catch {
    return [];
  }
}

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

export class OpfsWriterClient {
  private static instance: OpfsWriterClient | null = null;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: OpfsResponse) => void; reject: (e: unknown) => void }
  >();

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(new URL('../workers/opfs-writer-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<OpfsResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'OPFS worker failed'));
      this.pending.clear();
    };
  }

  /** The app-wide client (one worker). */
  static shared(): OpfsWriterClient {
    return (OpfsWriterClient.instance ??= new OpfsWriterClient());
  }

  private call(
    req: Distribute<OpfsRequest>,
    transfer: Transferable[] = [],
  ): Promise<Extract<OpfsResponse, { ok: true }>> {
    const id = this.nextId++;
    return new Promise<OpfsResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    }).then((res) => {
      if (!res.ok) throw rebuild(res);
      return res;
    });
  }

  /** Open, write, close and delete a scratch file; rejects when OPFS cannot be used. */
  async probe(): Promise<void> {
    await this.call({ op: 'probe' });
  }

  /** Create (or truncate) `name` and keep a write handle on it. */
  async open(name: string): Promise<void> {
    holdName(name);
    await this.call({ op: 'open', name });
  }

  /**
   * Write `bytes` at `at`. The bytes are copied, unless `transfer` is set and
   * the array is a whole buffer: then it is handed over (the caller loses it).
   */
  async write(name: string, at: number, bytes: Uint8Array, transfer = false): Promise<void> {
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const own = transfer && whole ? bytes : bytes.slice();
    await this.call({ op: 'write', name, at, bytes: own }, [own.buffer as ArrayBuffer]);
  }

  /** Flush and release the write handle. */
  async close(name: string): Promise<void> {
    await this.call({ op: 'close', name });
  }

  /** Delete `name` (closing its handle first). A missing file is fine. */
  async remove(name: string): Promise<void> {
    try {
      await this.call({ op: 'remove', name });
    } finally {
      releaseName(name);
    }
  }

  /** The file as a disk-backed `File` (after `close`). */
  async getFile(name: string): Promise<File> {
    const root = await navigator.storage.getDirectory();
    return (await root.getFileHandle(name)).getFile();
  }

  /** Delete every `cala-*` file that no tab owns, except those named in `keep`; returns how many were removed. */
  async sweep(keep: string[] = []): Promise<number> {
    const owned = await ownedNames();
    const res = await this.call({ op: 'sweep', prefix: OPFS_PREFIX, keep: [...keep, ...owned] });
    return res.count ?? 0;
  }
}

/** Remove leftover `cala-*` files, ignoring any failure (cleanup must never block a run). */
export async function sweepOpfs(keep: string[] = []): Promise<void> {
  try {
    await OpfsWriterClient.shared().sweep(keep);
  } catch {
    // best effort
  }
}
