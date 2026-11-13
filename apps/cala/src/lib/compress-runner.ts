/**
 * The compress worker's logic: quantizes the incoming batches of a window in
 * tile order and writes them to a file, and compresses closed windows tile by
 * tile from their file into a factor file. Two things run interleaved on the worker's one thread:
 *
 * - `handle` (one message at a time): a chunk is one quantize and one write,
 *   so the port's queue never holds more than a few batches;
 * - the compress loop, which yields to the event loop after every tile so
 *   that chunks arriving during a window's compression are written at once.
 *
 * Memory is one tile of one window plus the batches in flight; windows that
 * wait and all factors are on disk.
 *
 * Back-fill (`backfill`): once no window is waiting and the requested library
 * has arrived, every factor file is read back, its frames are rebuilt a few
 * at a time and solved with that library, and the traces of each window go
 * to the main thread. A cell found late in the recording so gets its trace
 * from the first frame on, without the raw video being read again.
 *
 * Window file `w<index>.i16`: the chunks as they arrived, each in tile order.
 * Factor file `f<index>.bin`: `CALAFAC1`, u32 width, height, tile, frames,
 * tiles, f64 stream index of the first frame, then per tile u32 byte length
 * and `TileFactors.toBytes()`.
 */
import type {
  CompressInit,
  CompressStatus,
  CompressToMain,
  FastToCompress,
} from '../workers/compress-types.ts';
import type { PortLike } from '../workers/slow-types.ts';
import type { StoreFile, WindowStore } from './window-store.ts';

/** `quantizeTiles` of the WASM module: `count` frames into `out`, in tile order. */
export type QuantizeTiles = (
  frames: Float32Array,
  count: number,
  width: number,
  height: number,
  tile: number,
  quant: number,
  out: Int16Array,
) => void;

/** What the runner needs of the WASM `TileFactors` and `TileCompressor`. */
export interface TileFactorsLike {
  readonly rank: number;
  toBytes(): Uint8Array;
  free(): void;
}
export interface TileCompressorLike {
  compress(
    raw: Int16Array,
    frames: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    seed: number,
  ): TileFactorsLike;
  free(): void;
}

/** A trace solver for one library, and a compressed window read back from its file. */
export interface BackfillEngineLike {
  ids(): Uint32Array;
  processFrames(frames: Float32Array, count: number): Float32Array;
  free(): void;
}
export interface FactorWindowLike {
  readonly frames: number;
  /** Stream index of the first frame. */
  readonly start: number;
  reconstruct(t0: number, count: number, out: Float32Array): void;
  free(): void;
}

/** Frames rebuilt and solved per step of the back-fill. */
const BACKFILL_BATCH = 16;

export interface CompressRunnerDeps {
  store: WindowStore;
  quantize: QuantizeTiles;
  create(quant: number): TileCompressorLike;
  /** For the back-fill (absent: `backfill` does nothing). */
  engine?(library: Uint8Array): BackfillEngineLike;
  factors?(file: Uint8Array): FactorWindowLike;
  toMain: PortLike<CompressToMain>;
  /** Lets queued messages run (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

interface Tile {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Pixels of the tiles before this one. */
  offset: number;
}

interface WindowJob {
  index: number;
  /** Stream index of the first frame. */
  start: number;
  frames: number;
  /** Frames of each chunk, in file order. */
  chunks: number[];
  /** Time spent quantizing its chunks, ms. */
  quantMs: number;
}

/** Tiles of a frame, row by row (as `tile_grid` in crates/cala). */
export function tileGrid(width: number, height: number, tile: number): Tile[] {
  const out: Tile[] = [];
  let offset = 0;
  for (let y0 = 0; y0 < height; y0 += tile) {
    for (let x0 = 0; x0 < width; x0 += tile) {
      const w = Math.min(tile, width - x0);
      const h = Math.min(tile, height - y0);
      out.push({ x0, y0, w, h, offset });
      offset += w * h;
    }
  }
  return out;
}

const windowName = (i: number): string => `w${i}.i16`;
export const factorName = (i: number): string => `f${i}.bin`;
const HEADER_BYTES = 36;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class CompressRunner {
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;
  private session = -1;
  private init: CompressInit | null = null;
  private tiles: Tile[] = [];
  private compressor: TileCompressorLike | null = null;
  private open: (WindowJob & { file: StoreFile; bytes: number }) | null = null;
  /** The quantized chunk being written (reused; a write is synchronous). */
  private scratch = new Int16Array(0);
  private pending: WindowJob[] = [];
  private loop: Promise<void> | null = null;
  /** Bumps on reset, so a running loop stops at its next yield. */
  private epoch = 0;
  private final = false;
  /** Compressed windows, in stream order. */
  private done: number[] = [];
  private library: { version: number; bytes: Uint8Array } | null = null;
  /** Library version a requested back-fill waits for. */
  private wanted: number | null = null;
  private windows = 0;
  private frames = 0;
  private factorBytes = 0;
  private meanRank = 0;
  private msPerFrame = 0;

  constructor(private readonly deps: CompressRunnerDeps) {
    this.yieldNow = deps.yieldNow ?? macrotask;
    this.now = deps.now ?? (() => performance.now());
  }

  /** One message from the fast worker. Calls must not overlap. */
  async handle(msg: FastToCompress): Promise<void> {
    if (msg.type === 'init') {
      await this.clear();
      this.session = msg.session;
      this.init = msg;
      this.tiles = tileGrid(msg.width, msg.height, msg.tile);
      return;
    }
    if (msg.session !== this.session || !this.init) return;
    if (msg.type === 'reset') {
      await this.clear();
      this.session = -1;
      this.init = null;
    } else if (msg.type === 'library') {
      if (msg.version >= (this.library?.version ?? 0)) {
        this.library = { version: msg.version, bytes: msg.bytes };
      }
      this.maybeBackfill();
    } else if (msg.type === 'chunk') {
      this.open ??= {
        index: msg.window,
        start: msg.start,
        frames: 0,
        chunks: [],
        quantMs: 0,
        file: await this.deps.store.open(windowName(msg.window)),
        bytes: 0,
      };
      const w = this.open;
      const { width, height, tile, quant } = this.init;
      if (this.scratch.length < msg.data.length) this.scratch = new Int16Array(msg.data.length);
      const data = this.scratch.subarray(0, msg.data.length);
      const t0 = this.now();
      this.deps.quantize(msg.data, msg.count, width, height, tile, quant, data);
      w.quantMs += this.now() - t0;
      w.file.write(data, w.bytes);
      w.bytes += data.byteLength;
      w.frames += msg.count;
      w.chunks.push(msg.count);
      if (msg.last) this.closeOpen();
    } else {
      this.closeOpen();
      if (msg.final) {
        this.final = true;
        if (!this.loop) this.post();
      }
    }
  }

  /**
   * Solve the traces of every compressed window with library `version` or a
   * newer one. Starts when that library is here and no window is waiting.
   */
  backfill(session: number, version: number): void {
    if (session !== this.session || !this.init) return;
    this.wanted = version;
    this.maybeBackfill();
  }

  /** Resolves when no window is being compressed or back-filled (for tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private closeOpen(): void {
    const w = this.open;
    if (!w) return;
    this.open = null;
    w.file.close();
    this.pending.push({
      index: w.index,
      start: w.start,
      frames: w.frames,
      chunks: w.chunks,
      quantMs: w.quantMs,
    });
    this.kick();
  }

  private kick(): void {
    if (!this.loop) this.launch(this.run());
  }

  private maybeBackfill(): void {
    const lib = this.library;
    const { engine, factors } = this.deps;
    if (this.loop || this.wanted === null || !lib || lib.version < this.wanted) return;
    if (this.open || this.pending.length > 0 || !engine || !factors) return;
    this.wanted = null;
    this.launch(this.runBackfill(lib, engine, factors));
  }

  /** Run `task` as the worker's one background loop. */
  private launch(task: Promise<void>): void {
    const session = this.session;
    let failed = false;
    this.loop = task
      .catch((err: unknown) => {
        failed = true;
        this.deps.toMain.postMessage({
          type: 'error',
          session,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.loop = null;
        // A window closed, or a back-fill was asked for, while the loop was busy.
        if (failed) return;
        if (this.pending.length > 0) this.kick();
        else this.maybeBackfill();
      });
  }

  private async runBackfill(
    lib: { version: number; bytes: Uint8Array },
    makeEngine: (library: Uint8Array) => BackfillEngineLike,
    openFactors: (file: Uint8Array) => FactorWindowLike,
  ): Promise<void> {
    const init = this.init;
    if (!init) return;
    const epoch = this.epoch;
    const session = this.session;
    const t0 = this.now();
    const px = init.width * init.height;
    const engine = makeEngine(lib.bytes);
    try {
      const ids = engine.ids();
      if (ids.length === 0) return;
      const buf = new Float32Array(BACKFILL_BATCH * px);
      let frames = 0;
      let first = true;
      for (const index of [...this.done]) {
        const file = await this.deps.store.open(factorName(index));
        const bytes = new Uint8Array(file.size());
        file.read(bytes, 0);
        file.close();
        const window = openFactors(bytes);
        try {
          const traces = new Float32Array(window.frames * ids.length);
          for (let t = 0; t < window.frames; t += BACKFILL_BATCH) {
            const n = Math.min(BACKFILL_BATCH, window.frames - t);
            const view = buf.subarray(0, n * px);
            window.reconstruct(t, n, view);
            traces.set(engine.processFrames(view, n), t * ids.length);
            await this.yieldNow();
            if (epoch !== this.epoch) return;
          }
          const cellIds = ids.slice();
          this.deps.toMain.postMessage(
            {
              type: 'traces',
              session,
              version: lib.version,
              first,
              start: window.start,
              count: window.frames,
              ids: cellIds,
              traces,
            },
            [cellIds.buffer as ArrayBuffer, traces.buffer as ArrayBuffer],
          );
          first = false;
          frames += window.frames;
        } finally {
          window.free();
        }
      }
      this.deps.toMain.postMessage({
        type: 'backfilled',
        session,
        version: lib.version,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } finally {
      engine.free();
    }
  }

  private async run(): Promise<void> {
    const epoch = this.epoch;
    while (this.pending.length > 0) {
      await this.compress(this.pending[0], epoch);
      if (epoch !== this.epoch) return;
      this.pending.shift();
      this.post();
    }
  }

  private async compress(job: WindowJob, epoch: number): Promise<void> {
    const init = this.init;
    const { store } = this.deps;
    if (!init) return;
    if (job.frames < 2) {
      await store.remove(windowName(job.index));
      return;
    }
    this.compressor ??= this.deps.create(init.quant);
    const px = init.width * init.height;
    const src = await store.open(windowName(job.index));
    const dst = await store.open(factorName(job.index));
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      src.close();
      dst.close();
    };
    try {
      const head = new DataView(new ArrayBuffer(HEADER_BYTES));
      'CALAFAC1'.split('').forEach((c, i) => head.setUint8(i, c.charCodeAt(0)));
      [init.width, init.height, init.tile, job.frames, this.tiles.length].forEach((v, i) =>
        head.setUint32(8 + 4 * i, v, true),
      );
      head.setFloat64(28, job.start, true);
      dst.write(head, 0);
      let at = HEADER_BYTES;
      const largest = this.tiles.reduce((m, t) => Math.max(m, t.w * t.h), 0);
      const buf = new Int16Array(job.frames * largest);
      const len = new Uint32Array(1);
      let ms = 0;
      let rank = 0;
      for (let i = 0; i < this.tiles.length; i++) {
        const t = this.tiles[i];
        const p = t.w * t.h;
        const raw = buf.subarray(0, job.frames * p);
        let chunkAt = 0;
        let o = 0;
        for (const n of job.chunks) {
          src.read(raw.subarray(o, o + n * p), chunkAt + t.offset * n * 2);
          chunkAt += n * px * 2;
          o += n * p;
        }
        const t0 = this.now();
        const seed = ((job.index << 20) ^ i) >>> 0;
        const f = this.compressor.compress(raw, job.frames, t.x0, t.y0, t.w, t.h, seed);
        try {
          ms += this.now() - t0;
          rank += f.rank;
          const bytes = f.toBytes();
          len[0] = bytes.length;
          dst.write(len, at);
          dst.write(bytes, at + 4);
          at += 4 + bytes.length;
        } finally {
          f.free();
        }
        await this.yieldNow();
        if (epoch !== this.epoch) return;
      }
      close();
      await store.remove(windowName(job.index));
      this.done.push(job.index);
      this.windows++;
      this.frames += job.frames;
      this.factorBytes += at;
      this.meanRank = rank / Math.max(1, this.tiles.length);
      this.msPerFrame = (ms + job.quantMs) / job.frames;
    } finally {
      close();
    }
  }

  private post(): void {
    const status: CompressStatus = {
      windows: this.windows,
      frames: this.frames,
      pending: this.pending.length,
      pendingFrames: this.pending.reduce((s, w) => s + w.frames, 0),
      meanRank: this.meanRank,
      msPerFrame: this.msPerFrame,
      factorBytes: this.factorBytes,
      final: this.final && this.pending.length === 0,
    };
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status });
  }

  /** Stop the loop, drop every file and counter. */
  private async clear(): Promise<void> {
    this.epoch++;
    this.open?.file.close();
    this.open = null;
    this.pending = [];
    this.wanted = null;
    await this.idle();
    this.compressor?.free();
    this.compressor = null;
    this.done = [];
    this.library = null;
    this.wanted = null;
    this.final = false;
    this.windows = 0;
    this.frames = 0;
    this.factorBytes = 0;
    this.meanRank = 0;
    this.msPerFrame = 0;
    await this.deps.store.clear();
  }
}
