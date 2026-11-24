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
 * Extract on factors (`extract`): with an `extractor` (slice 6), each window is
 * solved from its factors (`solveWindow`: the `FactorExtractor`, or rebuilt
 * frames where a pixel without data lies under a cell), cold, by the helpers of
 * the window pool or here; without one, the rebuild above with one engine. One
 * `extracted` message per window in stream order (traces and signed traces)
 * and `extract-done`; one job at a time, cancelled by `extractCancel`.
 *
 * History review (`review`): each compressed window's factor file also goes
 * to the review worker, and after every `every` windows the newest library
 * with the request to review (see `review-runner.ts`). The review itself
 * never runs here: it would hold up the writes of the incoming batches.
 *
 * Compress pool (`compress-pool.ts`): a window's tiles are shared with the
 * helpers of `pool`, `discover` of them while the recording runs and `after`
 * from its end on; the factor bytes are the same for any width. The window
 * files waiting for compression are capped (`backlogCap`): past the cap the
 * run's factors are given up, its files removed, and one error says why.
 *
 * Window file `w<index>.i16`: the chunks as they arrived, each in tile order.
 * Factor file `f<index>.bin`: the header of `factorHeader` (`CALAFAC2`, with the
 * tiling), then per tile u32 byte length and `TileFactors.toBytes()`.
 */
import type {
  CompressedWindow,
  CompressInit,
  CompressStatus,
  CompressToMain,
  FastToCompress,
} from '../workers/compress-types.ts';
import type { CompressToReview } from '../workers/review-types.ts';
import type { PortLike } from '../workers/slow-types.ts';
import { TilePool, WindowPool, type TileJob, type TilePoolLike } from './compress-pool.ts';
import { solveWindow, type FactorExtractorLike, type WindowResult } from './factor-solve.ts';
import { rebuildFrames, type FactorWindowLike } from './factor-frames.ts';
import type { StoreFile, WindowStore } from './window-store.ts';

/** `quantizeTiles` of the WASM module: `count` frames into `out`, in tile order. */
export type QuantizeTiles = (
  frames: Float32Array,
  count: number,
  width: number,
  height: number,
  tile: number,
  tiling: string,
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
  /** The signed (unclipped) traces of the last `processFrames` (when built with `signed`). */
  lastSigned?(): Float32Array;
  free(): void;
}
export type { FactorWindowLike } from './factor-frames.ts';

/** Frames rebuilt and solved per step of the back-fill. */
const BACKFILL_BATCH = 16;

/** The most bytes of window files that may wait for compression. */
export const BACKLOG_MAX_BYTES = 8 * 2 ** 30;

/** The cap on waiting window files: `BACKLOG_MAX_BYTES`, or half of what the origin may still store. */
export function backlogCap(e: { quota?: number; usage?: number } | null): number {
  const free = (e?.quota ?? NaN) - (e?.usage ?? NaN);
  return Number.isFinite(free)
    ? Math.min(BACKLOG_MAX_BYTES, Math.max(0, free / 2))
    : BACKLOG_MAX_BYTES;
}

/** Why a run's factors were given up at the cap. */
export function backlogText(cap: number): string {
  return `The windows waiting for compression would need more than ${(cap / 2 ** 30).toFixed(1)} GB of disk.`;
}

export interface CompressRunnerDeps {
  store: WindowStore;
  quantize: QuantizeTiles;
  /** `tileLayout` of the WASM module: `(x0, y0, w, h)` of every tile. */
  layout(width: number, height: number, tile: number, tiling: string): Uint32Array;
  /** `factorHeader` of the WASM module: the first bytes of a factor file. */
  header(
    width: number,
    height: number,
    tile: number,
    tiling: string,
    frames: number,
    tiles: number,
    start: number,
  ): Uint8Array;
  create(quant: number): TileCompressorLike;
  /** For the back-fill (absent: `backfill` does nothing). */
  engine?(library: Uint8Array, signed?: boolean): BackfillEngineLike;
  factors?(file: Uint8Array): FactorWindowLike;
  toMain: PortLike<CompressToMain>;
  /** The tile pool (absent: the worker compresses every tile itself). */
  pool?: TilePoolLike;
  /** Extract on factors through the `FactorExtractor` (absent: rebuilt frames, one engine). */
  extractor?(library: Uint8Array, signed: boolean): FactorExtractorLike;
  /** The helpers that solve Extract's windows (absent: none, the worker solves them). */
  windows?: WindowPool;
  /** What the origin may store (`navigator.storage.estimate`; absent: the cap is `BACKLOG_MAX_BYTES`). */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  /** The review worker, and the compressed windows between two reviews (absent: no review). */
  review?: { port: PortLike<CompressToReview>; every: number };
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
  /** Bytes of its window file. */
  bytes: number;
}

/** The tiles of a layout (`tileLayout`: x0, y0, w, h each), with their place in a quantized chunk. */
export function tilesOf(rects: Uint32Array): Tile[] {
  const out: Tile[] = [];
  let offset = 0;
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const [x0, y0, w, h] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
    out.push({ x0, y0, w, h, offset });
    offset += w * h;
  }
  return out;
}

const windowName = (i: number): string => `w${i}.i16`;
export const factorName = (i: number): string => `f${i}.bin`;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class CompressRunner {
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;
  private session = -1;
  private init: CompressInit | null = null;
  private tiles: Tile[] = [];
  /** Pixels of all tiles (more than a frame when tiles overlap). */
  private layoutPx = 0;
  private compressor: TileCompressorLike | null = null;
  private readonly pool: TilePoolLike;
  private readonly windowPool: WindowPool;
  private open: (WindowJob & { file: StoreFile }) | null = null;
  /** The quantized chunk being written (reused; a write is synchronous). */
  private scratch = new Int16Array(0);
  private pending: WindowJob[] = [];
  private loop: Promise<void> | null = null;
  /** Bumps on reset, so a running loop stops at its next yield. */
  private epoch = 0;
  private final = false;
  /** Compressed windows, in stream order. */
  private done: CompressedWindow[] = [];
  private library: { version: number; bytes: Uint8Array } | null = null;
  /** Library version a requested back-fill waits for. */
  private wanted: number | null = null;
  /** The Extract job being waited for or run. */
  private job: { id: number; session: number; version: number; library: Uint8Array } | null = null;
  private windows = 0;
  private frames = 0;
  private factorBytes = 0;
  private meanRank = 0;
  private msPerFrame = 0;
  private fps = 0;
  private widths: { discover: number; after: number; extract?: number } = { discover: 1, after: 1 };
  /** The cap on waiting window files, asked for once per run; past it the run's factors are given up. */
  private cap = BACKLOG_MAX_BYTES;
  private asked = false;
  private gaveUp = false;
  private backlogPeak = 0;
  /** When the recording ended, the frames then compressed, and those not compressed. */
  private endAt: number | null = null;
  private framesAtEnd = 0;
  private behindAtEnd: number | null = null;

  constructor(private readonly deps: CompressRunnerDeps) {
    this.yieldNow = deps.yieldNow ?? macrotask;
    this.now = deps.now ?? (() => performance.now());
    this.pool = deps.pool ?? new TilePool({ helpers: [], now: this.now });
    this.windowPool = deps.windows ?? new WindowPool({ helpers: [] });
  }

  /** One message from the fast worker. Calls must not overlap. */
  async handle(msg: FastToCompress): Promise<void> {
    if (msg.type === 'init') {
      await this.clear();
      // The layout first: a refused one must not leave a half-initialised session.
      const tiles = tilesOf(this.deps.layout(msg.width, msg.height, msg.tile, msg.tiling));
      this.tiles = tiles;
      this.layoutPx = tiles.reduce((s, t) => s + t.w * t.h, 0);
      this.session = msg.session;
      this.init = msg;
      this.widths = msg.pool ?? { discover: 1, after: 1 };
      if (msg.backlogCap !== undefined) {
        this.cap = msg.backlogCap;
        this.asked = true;
      }
      this.pool.begin(msg.quant);
      this.pool.setWidth(this.widths.discover);
      this.reviewOf(msg)?.port.postMessage({
        type: 'init',
        session: msg.session,
        width: msg.width,
        height: msg.height,
      });
      return;
    }
    if (msg.session !== this.session || !this.init) return;
    if (msg.type === 'reset') {
      await this.clear();
      this.reviewOf(this.init)?.port.postMessage({ type: 'reset', session: msg.session });
      this.session = -1;
      this.init = null;
    } else if (msg.type === 'library') {
      if (msg.version >= (this.library?.version ?? 0)) {
        this.library = { version: msg.version, bytes: msg.bytes };
      }
      this.maybeBackfill();
    } else if (msg.type === 'chunk') {
      if (this.gaveUp) return;
      this.askEstimate();
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
      const { width, height, tile, tiling, quant } = this.init;
      const values = msg.count * this.layoutPx;
      if (this.scratch.length < values) this.scratch = new Int16Array(values);
      const data = this.scratch.subarray(0, values);
      const t0 = this.now();
      this.deps.quantize(msg.data, msg.count, width, height, tile, tiling, quant, data);
      w.quantMs += this.now() - t0;
      w.file.write(data, w.bytes);
      w.bytes += data.byteLength;
      w.frames += msg.count;
      w.chunks.push(msg.count);
      const backlog = this.backlog();
      this.backlogPeak = Math.max(this.backlogPeak, backlog);
      if (backlog > this.cap) {
        await this.giveUp();
        return;
      }
      if (msg.last) this.closeOpen();
    } else {
      if (this.gaveUp) return;
      this.closeOpen();
      if (msg.final) {
        this.final = true;
        this.endAt = this.now();
        this.framesAtEnd = this.frames;
        this.behindAtEnd = this.pending.reduce((s, w) => s + w.frames, 0);
        this.pool.setWidth(this.widths.after);
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

  /** Extract on factors: solve every compressed window with `library`, once no window waits. */
  extract(session: number, id: number, version: number, library: Uint8Array): void {
    if (session !== this.session || !this.init) return;
    if (this.gaveUp) {
      this.deps.toMain.postMessage({
        type: 'error',
        session,
        job: id,
        message: backlogText(this.cap),
      });
      return;
    }
    this.job = { id, session, version, library };
    this.maybeExtract();
  }

  extractCancel(session: number, id: number): void {
    if (this.job?.id === id && this.job.session === session) {
      this.job = null;
      this.windowPool.reset();
    }
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
      bytes: w.bytes,
    });
    this.kick();
  }

  /** Bytes of the window files not compressed yet (the open one included). */
  private backlog(): number {
    return this.pending.reduce((s, w) => s + w.bytes, this.open?.bytes ?? 0);
  }

  /** Ask once per run what the origin may still store; until the answer the cap is `BACKLOG_MAX_BYTES`. */
  private askEstimate(): void {
    if (this.asked || !this.deps.estimate) return;
    this.asked = true;
    const epoch = this.epoch;
    this.deps.estimate().then(
      (e) => {
        if (epoch === this.epoch) this.cap = backlogCap(e);
      },
      () => {},
    );
  }

  /** The waiting window files passed the cap: drop the run's files, write nothing more, say why once. */
  private async giveUp(): Promise<void> {
    const session = this.session;
    const cap = this.cap;
    await this.clear();
    this.gaveUp = true;
    this.deps.toMain.postMessage({ type: 'error', session, message: backlogText(cap) });
  }

  private kick(): void {
    if (!this.loop) this.launch(this.run());
  }

  private maybeBackfill(): void {
    const lib = this.library;
    const { engine, factors } = this.deps;
    if (this.gaveUp || this.loop || this.wanted === null || !lib || lib.version < this.wanted)
      return;
    if (this.open || this.pending.length > 0 || !engine || !factors) return;
    this.wanted = null;
    this.launch(this.runBackfill(lib, engine, factors));
  }

  private maybeExtract(): void {
    const job = this.job;
    const { engine, factors } = this.deps;
    if (!job || this.loop || this.open || this.pending.length > 0 || !factors) return;
    if (this.deps.extractor && !this.init?.frameExtract)
      this.launch(this.runFactorExtract(job, this.deps.extractor, factors));
    else if (engine) this.launch(this.runExtract(job, engine, factors));
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
        else {
          this.maybeBackfill();
          this.maybeExtract();
        }
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
      for (const { index } of [...this.done]) {
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

  private async runExtract(
    job: { id: number; session: number; library: Uint8Array },
    makeEngine: NonNullable<CompressRunnerDeps['engine']>,
    openFactors: NonNullable<CompressRunnerDeps['factors']>,
  ): Promise<void> {
    const init = this.init;
    if (!init) return;
    const epoch = this.epoch;
    const live = (): boolean => epoch === this.epoch && this.job === job;
    const t0 = this.now();
    const px = init.width * init.height;
    const engine = makeEngine(job.library, true);
    try {
      const ids = engine.ids();
      const buf = new Float32Array(BACKFILL_BATCH * px);
      let frames = 0;
      for (const w of [...this.done]) {
        const window = openFactors(await this.deps.store.readAll(factorName(w.index)));
        try {
          const never = window.neverValid?.() ?? null;
          const traces = new Float32Array(window.frames * ids.length);
          const signed = engine.lastSigned
            ? new Float32Array(window.frames * ids.length)
            : undefined;
          for (let t = 0; t < window.frames; t += BACKFILL_BATCH) {
            const n = Math.min(BACKFILL_BATCH, window.frames - t);
            const view = buf.subarray(0, n * px);
            rebuildFrames(window, never, t, n, view);
            traces.set(engine.processFrames(view, n), t * ids.length);
            signed?.set(engine.lastSigned!(), t * ids.length);
            await this.yieldNow();
            if (!live()) return;
          }
          const cellIds = ids.slice();
          const transfer: ArrayBuffer[] = [
            cellIds.buffer as ArrayBuffer,
            traces.buffer as ArrayBuffer,
          ];
          if (signed) transfer.push(signed.buffer as ArrayBuffer);
          this.deps.toMain.postMessage(
            {
              type: 'extracted',
              session: job.session,
              job: job.id,
              start: window.start,
              count: window.frames,
              ids: cellIds,
              traces,
              ...(signed ? { signed } : {}),
            },
            transfer,
          );
          frames += window.frames;
        } finally {
          window.free();
        }
      }
      this.job = null;
      this.deps.toMain.postMessage({
        type: 'extract-done',
        session: job.session,
        job: job.id,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } catch (err) {
      if (live()) {
        this.job = null;
        this.deps.toMain.postMessage({
          type: 'error',
          session: job.session,
          job: job.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      engine.free();
    }
  }

  /** Extract through the `FactorExtractor`, its windows spread over the window pool. */
  private async runFactorExtract(
    job: { id: number; session: number; library: Uint8Array },
    makeExtractor: NonNullable<CompressRunnerDeps['extractor']>,
    openFactors: NonNullable<CompressRunnerDeps['factors']>,
  ): Promise<void> {
    const init = this.init;
    if (!init) return;
    const epoch = this.epoch;
    const live = (): boolean => epoch === this.epoch && this.job === job;
    const t0 = this.now();
    const px = init.width * init.height;
    const list = [...this.done];
    let local: FactorExtractorLike | null = null;
    const here = (): FactorExtractorLike => (local ??= makeExtractor(job.library, true));
    this.windowPool.setWidth(this.widths.extract ?? this.widths.after);
    const workers = Math.max(1, this.windowPool.width());
    this.windowPool.begin(job.id, job.library, true, px);
    let frames = 0;
    let projected = 0;
    let rebuilt = 0;
    try {
      const ids = here().ids();
      const done = await this.windowPool.runJob(job.id, list.length, {
        read: (i) => this.deps.store.readAll(factorName(list[i].index)),
        local: (_i, bytes) => solveWindow(here(), bytes, openFactors, px, true),
        emit: (_i, r: WindowResult) => {
          if (!live()) return;
          const cellIds = ids.slice();
          const transfer: ArrayBuffer[] = [
            cellIds.buffer as ArrayBuffer,
            r.traces.buffer as ArrayBuffer,
          ];
          if (r.signed) transfer.push(r.signed.buffer as ArrayBuffer);
          this.deps.toMain.postMessage(
            {
              type: 'extracted',
              session: job.session,
              job: job.id,
              start: r.start,
              count: r.count,
              ids: cellIds,
              traces: r.traces,
              ...(r.signed ? { signed: r.signed } : {}),
            },
            transfer,
          );
          frames += r.count;
          if (r.projected) projected++;
          else rebuilt++;
        },
        yieldNow: this.yieldNow,
      });
      if (!done || !live()) return;
      this.job = null;
      this.deps.toMain.postMessage({
        type: 'extract-done',
        session: job.session,
        job: job.id,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
        projected,
        rebuilt,
        workers,
      });
    } catch (err) {
      if (live()) {
        this.job = null;
        this.deps.toMain.postMessage({
          type: 'error',
          session: job.session,
          job: job.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.windowPool.end(job.id);
      (local as FactorExtractorLike | null)?.free();
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
    const compressor = (this.compressor ??= this.deps.create(init.quant));
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
      const head = this.deps.header(
        init.width,
        init.height,
        init.tile,
        init.tiling,
        job.frames,
        this.tiles.length,
        job.start,
      );
      dst.write(head, 0);
      let at = head.length;
      const len = new Uint32Array(1);
      let ms = 0;
      let rank = 0;
      const wall0 = this.now();
      const jobs: TileJob[] = this.tiles.map((t, i) => ({
        window: job.index,
        tile: i,
        frames: job.frames,
        x0: t.x0,
        y0: t.y0,
        w: t.w,
        h: t.h,
        seed: ((job.index << 20) ^ i) >>> 0,
      }));
      // A reset while the files opened: the pool already started a new run.
      if (epoch !== this.epoch) return;
      const done = await this.pool.compressWindow(jobs, {
        local: compressor,
        read: (tj, raw) => {
          const t = this.tiles[tj.tile];
          const p = t.w * t.h;
          let chunkAt = 0;
          let o = 0;
          for (const n of job.chunks) {
            src.read(raw.subarray(o, o + n * p), chunkAt + t.offset * n * 2);
            chunkAt += n * this.layoutPx * 2;
            o += n * p;
          }
        },
        write: (_tj, r) => {
          ms += r.ms;
          rank += r.rank;
          len[0] = r.bytes.length;
          dst.write(len, at);
          dst.write(r.bytes, at + 4);
          at += 4 + r.bytes.length;
        },
        yieldNow: this.yieldNow,
      });
      if (!done || epoch !== this.epoch) return;
      close();
      await store.remove(windowName(job.index));
      this.done.push({ index: job.index, start: job.start, frames: job.frames });
      this.windows++;
      this.frames += job.frames;
      this.factorBytes += at;
      this.meanRank = rank / Math.max(1, this.tiles.length);
      this.msPerFrame = (ms + job.quantMs) / job.frames;
      this.fps = (job.frames * 1000) / Math.max(1e-6, this.now() - wall0);
    } finally {
      close();
    }
    await this.feedReview(job.index, epoch);
  }

  /** The review worker's port, if there is one and the run's tiles are plain (the review reads no others). */
  private reviewOf(init: CompressInit | null): CompressRunnerDeps['review'] {
    return init?.tiling === 'plain' ? this.deps.review : undefined;
  }

  /**
   * Hand window `index`'s factors to the review worker and, every `every`
   * windows, ask for a review against the newest library. Not after the end
   * of the recording: the slow loop takes no more cells then.
   */
  private async feedReview(index: number, epoch: number): Promise<void> {
    const review = this.reviewOf(this.init);
    if (!review || this.final) return;
    const file = await this.deps.store.open(factorName(index));
    const bytes = new Uint8Array(file.size());
    file.read(bytes, 0);
    file.close();
    if (epoch !== this.epoch) return;
    const session = this.session;
    review.port.postMessage({ type: 'window', session, bytes }, [bytes.buffer as ArrayBuffer]);
    if (this.done.length % Math.max(1, review.every) !== 0) return;
    const library = this.library?.bytes.slice() ?? null;
    review.port.postMessage(
      { type: 'review', session, version: this.library?.version ?? 0, library },
      library ? [library.buffer as ArrayBuffer] : [],
    );
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
      tiling: this.init?.tiling ?? 'plain',
      source: this.init?.source ?? 'discover',
      folder: this.deps.store.folder,
      compressed: this.done.map((w) => ({ ...w })),
      workers: this.pool.width(),
      fps: this.fps,
      backlogBytes: this.backlog(),
      backlogPeakBytes: this.backlogPeak,
      behindAtEnd: this.behindAtEnd,
      fpsAfter: this.fpsAfter(),
    };
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status });
  }

  /** Frames compressed since the recording ended over the wall time since (null: none yet). */
  private fpsAfter(): number | null {
    if (this.endAt === null || this.frames <= this.framesAtEnd) return null;
    return ((this.frames - this.framesAtEnd) * 1000) / Math.max(1e-6, this.now() - this.endAt);
  }

  /** Stop the loop, drop every file and counter. */
  private async clear(): Promise<void> {
    this.epoch++;
    this.pool.reset();
    this.windowPool.reset();
    this.open?.file.close();
    this.open = null;
    this.pending = [];
    this.wanted = null;
    this.job = null;
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
    this.fps = 0;
    this.cap = BACKLOG_MAX_BYTES;
    this.asked = false;
    this.gaveUp = false;
    this.backlogPeak = 0;
    this.endAt = null;
    this.framesAtEnd = 0;
    this.behindAtEnd = null;
    await this.deps.store.clear();
  }
}
