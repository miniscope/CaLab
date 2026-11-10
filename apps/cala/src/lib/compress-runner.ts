/**
 * The compress worker's logic: writes the incoming batches of a window to a
 * file, and compresses closed windows tile by tile from their file into a
 * factor file. Two things run interleaved on the worker's one thread:
 *
 * - `handle` (one message at a time): a chunk is one write, so the port's
 *   queue never holds more than a few batches;
 * - the compress loop, which yields to the event loop after every tile so
 *   that chunks arriving during a window's compression are written at once.
 *
 * Memory is one tile of one window plus the batches in flight; windows that
 * wait and all factors are on disk.
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

export interface CompressRunnerDeps {
  store: WindowStore;
  create(quant: number): TileCompressorLike;
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
  private pending: WindowJob[] = [];
  private loop: Promise<void> | null = null;
  /** Bumps on reset, so a running loop stops at its next yield. */
  private epoch = 0;
  private final = false;
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
    } else if (msg.type === 'chunk') {
      this.open ??= {
        index: msg.window,
        start: msg.start,
        frames: 0,
        chunks: [],
        file: await this.deps.store.open(windowName(msg.window)),
        bytes: 0,
      };
      const w = this.open;
      w.file.write(msg.data, w.bytes);
      w.bytes += msg.data.byteLength;
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

  /** Resolves when no window is being compressed (for tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private closeOpen(): void {
    const w = this.open;
    if (!w) return;
    this.open = null;
    w.file.close();
    this.pending.push({ index: w.index, start: w.start, frames: w.frames, chunks: w.chunks });
    this.kick();
  }

  private kick(): void {
    if (this.loop) return;
    const session = this.session;
    this.loop = this.run()
      .catch((err: unknown) => {
        this.deps.toMain.postMessage({
          type: 'error',
          session,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.loop = null;
      });
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
      this.windows++;
      this.frames += job.frames;
      this.factorBytes += at;
      this.meanRank = rank / Math.max(1, this.tiles.length);
      this.msPerFrame = ms / job.frames;
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
    await this.idle();
    this.compressor?.free();
    this.compressor = null;
    this.final = false;
    this.windows = 0;
    this.frames = 0;
    this.factorBytes = 0;
    this.meanRank = 0;
    this.msPerFrame = 0;
    await this.deps.store.clear();
  }
}
