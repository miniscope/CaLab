/**
 * The pass-2 trace matrix (frames x cells, f32) kept off the JS heap.
 *
 * Pass 2 solves frames in order and every batch carries `count x cells` values
 * frame after frame, so the natural layout is one file of frame-major rows:
 * frame f, cell c at element `f * cells + c`. That is also, byte for byte, a
 * Fortran-order `.npy` of shape (cells, frames), which is how the export
 * writes it (no transpose, no second copy).
 *
 * `TraceFile` is that matrix behind four calls (`append`, `finish`,
 * `readFrames`, `readCell`) on top of a tiny byte-addressed `BlockBackend`:
 *
 *   - `OpfsBackend`: a file in the origin private file system. Writes go
 *     through a worker holding a synchronous access handle (the only way every
 *     browser lets a file be written at an offset); reads come back through
 *     `File.slice` on the main thread once the file is finished. RAM stays at
 *     a few batches whatever the recording length; the limit is disk quota.
 *   - `MemoryBackend`: one `Uint8Array`, for browsers without OPFS and for
 *     tests. Bounded by `MAX_MEMORY_TRACE_BYTES`.
 *
 * Files are named `cala-pass2-<stamp>.bin` and swept (`sweepOpfs`) when a new
 * run starts, so an abandoned tab never leaves a multi-GB file behind for
 * long.
 */
import { OpfsWriterClient, opfsAvailable, sweepOpfs } from './opfs-writer.ts';

/** The largest trace matrix held in memory when OPFS is unavailable, bytes. */
export const MAX_MEMORY_TRACE_BYTES = 1_500_000_000;
/** Fraction of the free browser storage a trace file may claim. */
export const QUOTA_SHARE = 0.9;

/** A storage error with a message fit to show the user. */
export class TraceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceStorageError';
  }
}

/** Byte-addressed storage under a `TraceFile`. */
export interface BlockBackend {
  /** Write `bytes` at `offset`. The backend takes ownership of `bytes` (a private copy). */
  write(offset: number, bytes: Uint8Array): Promise<void>;
  /** All writes are done; make the data readable. */
  finish(): Promise<void>;
  /** `length` bytes from `offset` (after `finish`). */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Delete the storage. */
  remove(): Promise<void>;
}

/** Frames per read when scanning a whole file for one cell (bounds the read at ~16 MB). */
const SCAN_BYTES = 16 * 1048576;

export class TraceFile {
  readonly frames: number;
  readonly cells: number;
  readonly kind: 'memory' | 'opfs';
  private readonly backend: BlockBackend;
  private writes: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  private finished = false;

  constructor(frames: number, cells: number, backend: BlockBackend, kind: 'memory' | 'opfs') {
    this.frames = frames;
    this.cells = cells;
    this.backend = backend;
    this.kind = kind;
  }

  /** Size of the whole matrix, bytes. */
  get bytes(): number {
    return this.frames * this.cells * 4;
  }

  /**
   * Store `traces` (`count x cells`, frame after frame) from frame `start`.
   * Writes are queued in order; the first failure is remembered and rethrown
   * by every later `append` and by `finish`. `traces` is copied, so the
   * caller keeps it.
   */
  append(start: number, traces: Float32Array): void {
    if (this.finished) throw new Error('The trace file is finished.');
    if (this.failed) throw this.failed;
    if (
      traces.length % this.cells !== 0 ||
      start < 0 ||
      start * this.cells + traces.length > this.frames * this.cells
    )
      throw new RangeError('Traces outside the trace file.');
    const copy = new Uint8Array(traces.byteLength);
    copy.set(new Uint8Array(traces.buffer, traces.byteOffset, traces.byteLength));
    const offset = start * this.cells * 4;
    this.writes = this.writes
      .then(() => (this.failed ? undefined : this.backend.write(offset, copy)))
      .catch((err: unknown) => {
        this.failed ??= err;
      });
  }

  /** Wait for every queued write; throws the first write error. */
  async finish(): Promise<void> {
    await this.writes;
    if (this.failed) throw this.failed;
    if (!this.finished) {
      this.finished = true;
      await this.backend.finish();
    }
  }

  /** Frames [from, to) as `(to - from) x cells` f32 (a view or a fresh array: treat as read-only). */
  async readFrames(from: number, to: number): Promise<Float32Array> {
    if (!(from >= 0 && to >= from && to <= this.frames))
      throw new RangeError('Frames out of range.');
    const bytes = await this.backend.read(from * this.cells * 4, (to - from) * this.cells * 4);
    if (bytes.byteOffset % 4 === 0)
      return new Float32Array(bytes.buffer, bytes.byteOffset, (to - from) * this.cells);
    const copy = new Uint8Array(bytes);
    return new Float32Array(copy.buffer);
  }

  /** The whole trace of cell `index` (column of the frame-major matrix). */
  async readCell(index: number): Promise<Float32Array> {
    if (!(index >= 0 && index < this.cells)) throw new RangeError('Cell out of range.');
    const out = new Float32Array(this.frames);
    const step = Math.max(1, Math.floor(SCAN_BYTES / (this.cells * 4)));
    for (let f = 0; f < this.frames; f += step) {
      const to = Math.min(this.frames, f + step);
      const block = await this.readFrames(f, to);
      for (let k = 0; k < to - f; k++) out[f + k] = block[k * this.cells + index];
    }
    return out;
  }

  /** Delete the storage. The file is unusable afterwards. */
  async dispose(): Promise<void> {
    try {
      await this.writes;
    } catch {
      // already recorded in `failed`
    }
    await this.backend.remove();
  }
}

/** One `Uint8Array` as the whole file. */
export class MemoryBackend implements BlockBackend {
  private data: Uint8Array | null;
  constructor(bytes: number) {
    this.data = new Uint8Array(bytes);
  }
  async write(offset: number, bytes: Uint8Array): Promise<void> {
    if (!this.data) throw new Error('The trace file was disposed.');
    this.data.set(bytes, offset);
  }
  async finish(): Promise<void> {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!this.data) throw new Error('The trace file was disposed.');
    return this.data.subarray(offset, offset + length);
  }
  async remove(): Promise<void> {
    this.data = null;
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 1 : 0)} GB`;
}

/** A trace file in the origin private file system. Reads go through `File.slice`. */
export class OpfsBackend implements BlockBackend {
  private readonly name: string;
  private readonly client: OpfsWriterClient;
  private written = 0;
  private opened = false;
  private file: File | null = null;

  constructor(name: string, client: OpfsWriterClient) {
    this.name = name;
    this.client = client;
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    if (!this.opened) {
      await this.client.open(this.name);
      this.opened = true;
    }
    try {
      await this.client.write(this.name, offset, bytes, true);
    } catch (err) {
      if (err instanceof Error && err.name === 'QuotaExceededError') {
        throw new TraceStorageError(
          `The browser ran out of storage for the pass-2 traces after ${gb(this.written)}. Free some disk space and run pass 2 again.`,
        );
      }
      throw err;
    }
    this.written += bytes.length;
  }

  async finish(): Promise<void> {
    if (this.opened) await this.client.close(this.name);
    this.opened = false;
    this.file = await this.client.getFile(this.name);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.file ??= await this.client.getFile(this.name);
    return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
  }

  async remove(): Promise<void> {
    this.file = null;
    await this.client.remove(this.name);
  }
}

/** Whether `bytes` fits in what the browser will store (null: it does, or it cannot tell). */
export async function storageShortfall(bytes: number): Promise<{ free: number } | null> {
  try {
    const est = await navigator.storage.estimate();
    if (est.quota === undefined) return null;
    const free = Math.max(0, est.quota - (est.usage ?? 0)) * QUOTA_SHARE;
    return bytes > free ? { free } : null;
  } catch {
    return null;
  }
}

/**
 * A trace file for `frames x cells`: in OPFS when the browser has it (the
 * quota is checked first, with a clear error when the matrix cannot fit),
 * else in memory up to `MAX_MEMORY_TRACE_BYTES`. Older pass-2 and export files
 * are swept first.
 */
export async function createTraceFile(
  frames: number,
  cells: number,
  options: { forceMemory?: boolean } = {},
): Promise<TraceFile> {
  const bytes = frames * cells * 4;
  if (!options.forceMemory && opfsAvailable()) {
    await sweepOpfs();
    const short = await storageShortfall(bytes);
    if (short) {
      throw new TraceStorageError(
        `Pass 2 needs ${gb(bytes)} of browser storage (${cells} cells x ${frames.toLocaleString()} frames) but only ${gb(short.free)} is available. Free some disk space, or finish pass 1 earlier.`,
      );
    }
    const name = `cala-pass2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.bin`;
    return new TraceFile(frames, cells, new OpfsBackend(name, OpfsWriterClient.shared()), 'opfs');
  }
  if (bytes > MAX_MEMORY_TRACE_BYTES) {
    throw new TraceStorageError(
      `${cells} cells x ${frames.toLocaleString()} frames (${gb(bytes)}) is more traces than fit in memory, and this browser has no file storage for them (OPFS). Use a current Chrome, Edge, Firefox or Safari.`,
    );
  }
  return new TraceFile(frames, cells, new MemoryBackend(bytes), 'memory');
}

/** A memory-backed file holding frame-major `traces` (tests, small data). */
export async function memoryTraceFile(
  traces: Float32Array,
  frames: number,
  cells: number,
): Promise<TraceFile> {
  const f = new TraceFile(frames, cells, new MemoryBackend(traces.byteLength), 'memory');
  f.append(0, traces);
  await f.finish();
  return f;
}
