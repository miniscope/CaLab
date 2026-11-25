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
 * On the GPU (`CompressInit.gpu`, `?factors=gpu`): no window files. Each
 * chunk is quantized in frame order and uploaded to the GPU compressor's ring
 * of `window + slack` frames; the runner cuts windows of the GPU's length from
 * the stream frame indices (the feed's `window` and `last` are ignored) and
 * compresses them one at a time. The feed waits for room in the ring
 * (`CompressFeed.room`): the runner tells it on the same port how much the
 * ring holds and the oldest frame still needed (`CompressToFast`), when the
 * GPU opens and after every window, and `ring` 0 when the GPU route ends. A
 * chunk that would overwrite a frame of a window not yet compressed anyway
 * (the GPU fell a window behind), a feed that waited `GPU_STALL_S` without
 * progress, a lost device or a failed window gives the run's factors up, as
 * the backlog cap does; the chunk calls never wait for the GPU.
 *
 * The GPU check (`CompressInit.gpuCheck`, `?debug&gpucheck=N`): the quantized
 * frames of the first N windows (at most `GPU_CHECK_MAX`) stay in memory;
 * once the recording's windows are all on disk, each kept window is compressed
 * on the CPU (`TileCompressor`, the GPU's seeds and previous ranks) and once
 * more with the seeds moved by `GPU_CHECK_SEED` (the sketch's own noise), and
 * `CompressStatus.check` sums how far apart they are. Extract waits for it.
 *
 * Window file `w<index>.i16`: the chunks as they arrived, each in tile order.
 * Factor file `f<index>.bin`: the header of `factorHeader` (`CALAFAC2`, with the
 * tiling), then per tile u32 byte length and `TileFactors.toBytes()`.
 */
import type {
  CompressedWindow,
  CompressInit,
  CompressStatus,
  CompressToFast,
  CompressToMain,
  FastToCompress,
  GpuCheck,
} from '../workers/compress-types.ts';
import type { CompressToReview } from '../workers/review-types.ts';
import type { PortLike } from '../workers/slow-types.ts';
import { quantizeFrames as wasmQuantizeFrames, WindowStats } from './cala-wasm.ts';
import { GPU_STALL_S } from './compress-feed.ts';
import { TilePool, WindowPool, type TileJob, type TilePoolLike } from './compress-pool.ts';
import { cutTile, readTile, tileDiff } from './factor-check.ts';
import { solveWindow, type FactorExtractorLike, type WindowResult } from './factor-solve.ts';
import { rebuildFrames, type FactorWindowLike } from './factor-frames.ts';
import {
  GpuSketchTooLarge,
  RingClock,
  type GpuCompressorLike,
  type GpuWindowResult,
  type WindowStatsLike,
} from './gpu-compress.ts';
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
    prevRank?: number,
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

/** Why a recording that settled on the file has no factors. */
export const STOPPED_TEXT =
  'The Final settle re-read the file, so the compressor stopped: Extract reads the file too.';

/** Why a run's factors were given up at the cap. */
export function backlogText(cap: number): string {
  return `The windows waiting for compression would need more than ${(cap / 2 ** 30).toFixed(1)} GB of disk.`;
}

/** Why a `?factors=gpu` run has no factors. */
export const GPU_TEXT = {
  none: (why: string) => `No factors: the GPU compressor could not start (${why}).`,
  behind: 'No factors: the GPU compressor fell a window behind Discover.',
  stalled: `No factors: the GPU compressor made no progress for ${GPU_STALL_S} s while Discover waited for it.`,
  lost: (why: string) => `No factors: the GPU was lost (${why}).`,
  sketch: 'No factors: a tile needed a larger sketch than the GPU compressor holds.',
  error: (why: string) => `No factors: the GPU compressor failed (${why}).`,
} as const;

/** The most windows the GPU check keeps (one of 600 frames at 600 px is 432 MB). */
export const GPU_CHECK_MAX = 2;
/** The GPU check's second CPU pass moves every seed by this (the noise floor). */
export const GPU_CHECK_SEED = 7_000_000;

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
  /** The fast worker, on the port its chunks come from: room in the GPU's ring (absent: never told). */
  toFast?: PortLike<CompressToFast>;
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
  /** Open the GPU compressor of a `gpu` run (absent: such a run has no factors). */
  openGpu?: (init: CompressInit) => Promise<GpuCompressorLike | { reason: string }>;
  /** A GPU window's pixel statistics (default: the WASM `WindowStats`). */
  stats?: (width: number, height: number) => WindowStatsLike;
  /** `quantizeFrames` of the WASM module: frames in frame order (default: the WASM function). */
  quantizeFrames?: (frames: Float32Array, quant: number) => Int16Array;
  /** Lets queued messages run (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

/** A window of a GPU run: its frames are in the GPU compressor's ring, its statistics here. */
interface GpuWindow {
  index: number;
  /** Stream index of the first frame. */
  start: number;
  frames: number;
  stats: WindowStatsLike | null;
}

/** A window the GPU compressed, kept for the check: its frames, and what the GPU was given and gave. */
interface GpuCheckJob {
  index: number;
  frames: number;
  /** Quantized frames, frame layout (`frames x width*height` used). */
  data: Int16Array;
  /** Each tile's rank of the window before (as the GPU job had it). */
  prev: (number | undefined)[];
  tiles: Uint8Array[];
  ranks: number[];
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const noGpuWindow = (): GpuWindow => ({ index: 0, start: 0, frames: 0, stats: null });

/** A factor file: `head`, then per tile its u32 byte length and bytes. Returns its size. */
function writeFactorFile(dst: StoreFile, head: Uint8Array, tiles: Uint8Array[]): number {
  dst.write(head, 0);
  let at = head.length;
  const len = new Uint32Array(1);
  for (const bytes of tiles) {
    len[0] = bytes.length;
    dst.write(len, at);
    dst.write(bytes, at + 4);
    at += 4 + bytes.length;
  }
  return at;
}

export class CompressRunner {
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;
  private session = -1;
  private init: CompressInit | null = null;
  private tiles: Tile[] = [];
  /** Per tile, the rank its last compressed window kept (where its next sketch starts). */
  private tileRanks: number[] = [];
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
  /** Why this run compresses no more (the backlog cap, or `stop`). */
  private stopText: string | null = null;
  private backlogPeak = 0;
  /** When the recording ended, the frames then compressed, and those not compressed. */
  private endAt: number | null = null;
  private framesAtEnd = 0;
  private behindAtEnd: number | null = null;
  // ---- A GPU run (`CompressInit.gpu`) ----
  /** The GPU compressor (null: a CPU run, or the GPU run gave up). */
  private gpu: GpuCompressorLike | null = null;
  private ring: RingClock | null = null;
  /** The GPU's frames per window (0: not a GPU run); kept once the GPU is released. */
  private gwindow = 0;
  /** Frames the GPU's ring holds (window + slack); kept once the GPU is released. */
  private gring = 0;
  /** The window being filled. */
  private gwin: GpuWindow = noGpuWindow();
  /** Closed windows, in stream order; the first is the one being compressed. */
  private gpending: GpuWindow[] = [];
  /** Statistics of compressed windows, reset, for the next windows. */
  private gspare: WindowStatsLike[] = [];
  /** Ends the wait for the window on the GPU (a reset or a give-up: the GPU may never answer). */
  private gabort: (() => void) | null = null;
  private gaborted: Promise<null> = new Promise<null>(() => {});
  /** The GPU check: frames of the windows it keeps, by index; windows waiting for it; its sums. */
  private gkeep = new Map<number, Int16Array>();
  private gchecks: GpuCheckJob[] = [];
  private gcheck: GpuCheck | null = null;
  /** Discover's waits for room in the ring (`waited`): their sum, ms, and count; kept across a give-up. */
  private waitMs = 0;
  private waits = 0;

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
      this.tileRanks = [];
      this.layoutPx = tiles.reduce((s, t) => s + t.w * t.h, 0);
      this.session = msg.session;
      this.init = msg;
      this.waitMs = 0;
      this.waits = 0;
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
      if (msg.gpu) await this.openGpuRun(msg);
      return;
    }
    if (msg.session !== this.session || !this.init) return;
    if (msg.type === 'reset') {
      await this.clear();
      this.reviewOf(this.init)?.port.postMessage({ type: 'reset', session: msg.session });
      this.session = -1;
      this.init = null;
      this.waitMs = 0;
      this.waits = 0;
    } else if (msg.type === 'waited') {
      if (!this.init.gpu) return;
      this.waitMs += msg.ms;
      this.waits++;
      if (msg.stalled) await this.gpuFail(GPU_TEXT.stalled);
      this.post();
    } else if (msg.type === 'library') {
      if (msg.version >= (this.library?.version ?? 0)) {
        this.library = { version: msg.version, bytes: msg.bytes };
      }
      this.maybeBackfill();
    } else if (msg.type === 'chunk') {
      if (this.gaveUp) return;
      if (this.init.gpu) {
        if (this.gpu) await this.gpuChunk(msg, this.gpu);
        return;
      }
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
      if (this.init.gpu) {
        // Not after a give-up that is still clearing (a lost device).
        if (!this.gpu) return;
        this.closeGpuWindow();
      } else this.closeOpen();
      if (msg.final) {
        this.final = true;
        this.endAt = this.now();
        this.framesAtEnd = this.frames;
        this.behindAtEnd = this.waiting().reduce((s, w) => s + w.frames, 0);
        this.pool.setWidth(this.widths.after);
        this.releaseDoneGpu();
        if (!this.loop) {
          this.post();
          this.kick();
        }
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
        message: this.stopText ?? backlogText(this.cap),
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
    this.stopText = backlogText(cap);
    this.deps.toMain.postMessage({ type: 'error', session, message: this.stopText });
  }

  /**
   * A recording's settle re-reads the file (slice 7, decision 4): its
   * compression would only take CPU from the settle and Extract, which read
   * the file too. Drop the run's files and compress nothing more of it.
   */
  async stop(session: number): Promise<void> {
    if (session !== this.session || !this.init || this.gaveUp) return;
    await this.clear();
    this.gaveUp = true;
    this.stopText = STOPPED_TEXT;
  }

  private kick(): void {
    if (this.loop) return;
    if (this.gpu && this.gpending.length > 0) this.launch(this.runGpu(this.gpu));
    else if (this.checkDue()) this.launch(this.runGpuChecks());
    else if (this.pending.length > 0) this.launch(this.run());
  }

  private maybeBackfill(): void {
    const lib = this.library;
    const { engine, factors } = this.deps;
    if (this.gaveUp || this.loop || this.wanted === null || !lib || lib.version < this.wanted)
      return;
    if (this.open || this.pending.length > 0 || this.gpuWaits() || !engine || !factors) return;
    this.wanted = null;
    this.launch(this.runBackfill(lib, engine, factors));
  }

  private maybeExtract(): void {
    const job = this.job;
    const { engine, factors } = this.deps;
    if (!job || this.loop || this.open || this.pending.length > 0 || this.gpuWaits() || !factors)
      return;
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
        if (this.pending.length > 0 || this.gpending.length > 0 || this.checkDue()) this.kick();
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
        prevRank: this.tileRanks[i],
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
        write: (tj, r) => {
          this.tileRanks[tj.tile] = r.rank;
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

  // ---- A GPU run ----

  /** The closed windows not compressed yet (on the GPU or on the CPU: one of the two is empty). */
  private waiting(): { frames: number }[] {
    return [...this.pending, ...this.gpending];
  }

  /**
   * The recording ended and its last window is written: free the GPU (its
   * ring is hundreds of MB) for the stages that follow. A device lost after
   * that changes nothing.
   */
  private releaseDoneGpu(): void {
    if (this.gpu && this.final && this.gpending.length === 0) this.dropGpu();
  }

  /** A GPU window is being filled, waits for the GPU or for the check. */
  private gpuWaits(): boolean {
    return this.gpending.length > 0 || this.gwin.frames > 0 || this.gchecks.length > 0;
  }

  /** Open the run's GPU compressor; without one the run has no factors and says why, once. */
  private async openGpuRun(init: CompressInit & { session: number }): Promise<void> {
    const epoch = this.epoch;
    const open = this.deps.openGpu;
    const g = open
      ? await open(init).catch((err: unknown) => ({ reason: errorText(err) }))
      : { reason: 'this worker has no GPU compressor' };
    if (epoch !== this.epoch) {
      if (!('reason' in g)) g.destroy();
      return;
    }
    if ('reason' in g) {
      this.roomOff();
      this.gaveUp = true;
      this.stopText = GPU_TEXT.none(g.reason);
      this.deps.toMain.postMessage({
        type: 'error',
        session: init.session,
        message: this.stopText,
      });
      return;
    }
    this.gpu = g;
    this.gwindow = g.window;
    this.gring = g.window + g.slack;
    this.ring = new RingClock(g.window, g.slack);
    this.gwin = noGpuWindow();
    this.gaborted = new Promise<null>((resolve) => (this.gabort = () => resolve(null)));
    void g.lost.then((why) => this.gpuFail(GPU_TEXT.lost(why), epoch));
    this.postRoom();
  }

  /** Tell the feed how far it may send: the ring's size and the oldest frame the GPU still needs. */
  private postRoom(): void {
    if (!this.gpu) return;
    this.deps.toFast?.postMessage({
      type: 'room',
      session: this.session,
      ring: this.gring,
      window: this.gwindow,
      keepFrom: this.gpending[0]?.start ?? this.gwin.start,
    });
  }

  /** The GPU route ended: the feed never waits again. */
  private roomOff(): void {
    this.deps.toFast?.postMessage({
      type: 'room',
      session: this.session,
      ring: 0,
      window: 0,
      keepFrom: 0,
    });
  }

  /**
   * Quantize a chunk and upload it to the ring, window by window of the GPU's
   * length. A frame that would overwrite one of a window not compressed yet
   * gives the factors up: the chunk never waits for the GPU.
   */
  private async gpuChunk(
    msg: Extract<FastToCompress, { type: 'chunk' }>,
    g: GpuCompressorLike,
  ): Promise<void> {
    const init = this.init!;
    const ring = this.ring!;
    const hw = init.width * init.height;
    // The next stream frame (also after a window boundary): a chunk going back
    // would overwrite ring slots of a window not compressed yet.
    const next = this.gwin.start + this.gwin.frames;
    if (msg.start < next) {
      await this.gpuFail(GPU_TEXT.error(`frame ${msg.start} after frame ${next - 1}`));
      return;
    }
    // A gap: a window's frames are consecutive.
    if (this.gwin.frames > 0 && msg.start !== next) this.closeGpuWindow();
    if (this.gwin.frames === 0) this.gwin.start = msg.start;
    const quantize = this.deps.quantizeFrames ?? wasmQuantizeFrames;
    const q = quantize(msg.data.subarray(0, msg.count * hw), init.quant);
    for (let done = 0; done < msg.count;) {
      const n = Math.min(msg.count - done, g.window - this.gwin.frames);
      const start = msg.start + done;
      // The oldest frame still needed: the first of the window on the GPU, or of the one filling.
      const keepFrom = this.gpending[0]?.start ?? this.gwin.start;
      if (!ring.fits(start, n, keepFrom)) {
        await this.gpuFail(GPU_TEXT.behind);
        return;
      }
      const frames = q.subarray(done * hw, (done + n) * hw);
      g.upload(frames, start, n);
      this.keepForCheck(frames);
      (this.gwin.stats ??= this.takeStats()).push(frames);
      this.gwin.frames += n;
      done += n;
      if (this.gwin.frames === g.window) this.closeGpuWindow();
    }
  }

  /** Close the window being filled; one of a single frame is dropped (as on the CPU). */
  private closeGpuWindow(): void {
    const w = this.gwin;
    if (w.frames === 0) return;
    const keep = w.frames >= 2;
    this.gwin = {
      index: w.index + (keep ? 1 : 0),
      start: w.start + w.frames,
      frames: 0,
      stats: null,
    };
    if (!keep) {
      this.spareStats(w.stats);
      this.postRoom();
      return;
    }
    this.gpending.push(w);
    this.kick();
  }

  private takeStats(): WindowStatsLike {
    const { width, height } = this.init!;
    const make = this.deps.stats ?? ((w: number, h: number) => new WindowStats(w, h));
    return this.gspare.pop() ?? make(width, height);
  }

  private spareStats(s: WindowStatsLike | null): void {
    if (!s) return;
    s.reset();
    this.gspare.push(s);
  }

  /** Compress the closed windows on the GPU strictly one at a time (it refuses a second). */
  private async runGpu(g: GpuCompressorLike): Promise<void> {
    const epoch = this.epoch;
    while (this.gpending.length > 0) {
      const w = this.gpending[0];
      const ok = await this.compressGpu(g, w, epoch);
      if (!ok || epoch !== this.epoch) return;
      this.gpending.shift();
      this.spareStats(w.stats);
      this.postRoom();
      this.releaseDoneGpu();
      this.post();
    }
  }

  /** One window on the GPU into `f<index>.bin`; false when the run ended or gave up meanwhile. */
  private async compressGpu(g: GpuCompressorLike, w: GpuWindow, epoch: number): Promise<boolean> {
    const wall0 = this.now();
    // Each tile's rank of the window before, as it was when this window began.
    const prev = this.tileRanks.slice();
    let work: Promise<GpuWindowResult>;
    try {
      work = g.compress({
        index: w.index,
        start: w.start,
        frames: w.frames,
        stats: w.stats!,
        seeds: (i) => ((w.index << 20) ^ i) >>> 0,
        prevRanks: (i) => prev[i],
        // Each batch of tiles tells a waiting feed the GPU is at work (a slow window is no stall).
        progress: () => {
          if (epoch === this.epoch) this.postRoom();
        },
      });
    } catch (err) {
      work = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    // A reset or a give-up ends the wait (`gaborted`); the GPU's answer is then dropped.
    const out = await Promise.race([
      work.then(
        (r) => ({ r }),
        (err: unknown) => ({ err }),
      ),
      this.gaborted,
    ]);
    if (out === null || epoch !== this.epoch) return false;
    if ('err' in out) {
      // Not awaited: the give-up waits for this loop to end.
      void this.gpuFail(
        out.err instanceof GpuSketchTooLarge ? GPU_TEXT.sketch : GPU_TEXT.error(errorText(out.err)),
        epoch,
      );
      return false;
    }
    const init = this.init!;
    const { tiles, ranks, ms } = out.r;
    let size: number;
    try {
      const dst = await this.deps.store.open(factorName(w.index));
      try {
        if (epoch !== this.epoch) return false;
        const head = this.deps.header(
          init.width,
          init.height,
          init.tile,
          init.tiling,
          w.frames,
          tiles.length,
          w.start,
        );
        size = writeFactorFile(dst, head, tiles);
      } finally {
        dst.close();
      }
    } catch (err) {
      // A window that cannot be written: the factors would have a hole.
      void this.gpuFail(GPU_TEXT.error(errorText(err)), epoch);
      return false;
    }
    ranks.forEach((r, i) => (this.tileRanks[i] = r));
    const kept = this.gkeep.get(w.index);
    if (kept) {
      this.gkeep.delete(w.index);
      this.gchecks.push({ index: w.index, frames: w.frames, data: kept, prev, tiles, ranks });
    }
    this.done.push({ index: w.index, start: w.start, frames: w.frames });
    this.windows++;
    this.frames += w.frames;
    this.factorBytes += size;
    this.meanRank = ranks.reduce((s, r) => s + r, 0) / Math.max(1, ranks.length);
    this.msPerFrame = ms / w.frames;
    this.fps = (w.frames * 1000) / Math.max(1e-6, this.now() - wall0);
    return true;
  }

  // ---- The GPU check ----

  /** Keep frames of the window being filled for the check (one of its first `gpuCheck` windows). */
  private keepForCheck(frames: Int16Array): void {
    const { width, height, gpuCheck } = this.init!;
    const w = this.gwin;
    if (w.index >= Math.min(gpuCheck ?? 0, GPU_CHECK_MAX)) return;
    const hw = width * height;
    let buf = this.gkeep.get(w.index);
    if (!buf) {
      buf = new Int16Array(this.gwindow * hw);
      this.gkeep.set(w.index, buf);
    }
    buf.set(frames, w.frames * hw);
  }

  /** The recording's windows are all on disk and a kept window waits for the check. */
  private checkDue(): boolean {
    return this.gchecks.length > 0 && this.final && this.gpending.length === 0 && !this.gaveUp;
  }

  /** Each kept window on the CPU twice, against the GPU's tiles; its frames go once it is done. */
  private async runGpuChecks(): Promise<void> {
    const epoch = this.epoch;
    const init = this.init!;
    const local = (this.compressor ??= this.deps.create(init.quant));
    const sums = (this.gcheck ??= {
      windows: 0,
      tiles: 0,
      loss: 0,
      floor: 0,
      ref: 0,
      signal: 0,
      rankDiff: 0,
      floorRankDiff: 0,
      keptDiff: 0,
      floorKeptDiff: 0,
      rankDiffTiles: 0,
      ms: 0,
    });
    try {
      while (this.gchecks.length > 0) {
        const c = this.gchecks[0];
        const t0 = this.now();
        const cpu = await this.cpuTiles(c, 0, local, epoch);
        const cpu2 = cpu && (await this.cpuTiles(c, GPU_CHECK_SEED, local, epoch));
        if (!cpu || !cpu2 || epoch !== this.epoch) return;
        for (let i = 0; i < cpu.length; i++) {
          const ref = readTile(cpu[i].bytes);
          const gpu = readTile(c.tiles[i]);
          const cpu2Tile = readTile(cpu2[i].bytes);
          const d = tileDiff(gpu, ref);
          const f = tileDiff(cpu2Tile, ref);
          sums.loss += d.diff;
          sums.ref += d.ref;
          sums.signal += d.signal;
          sums.floor += f.diff;
          sums.rankDiff += Math.abs(c.ranks[i] - cpu[i].rank);
          sums.floorRankDiff += Math.abs(cpu2[i].rank - cpu[i].rank);
          sums.keptDiff += Math.abs(gpu.keptEnergy - ref.keptEnergy);
          sums.floorKeptDiff += Math.abs(cpu2Tile.keptEnergy - ref.keptEnergy);
          if (c.ranks[i] !== cpu[i].rank) sums.rankDiffTiles++;
          await this.yieldNow();
          if (epoch !== this.epoch) return;
        }
        sums.windows++;
        sums.tiles += cpu.length;
        sums.ms += this.now() - t0;
        this.gchecks.shift();
        this.post();
      }
    } catch (err) {
      // A check that fails is the check's news only: the run's factors stay usable.
      if (epoch !== this.epoch) return;
      sums.error = errorText(err);
      this.gchecks = [];
      this.post();
    }
  }

  /** Window `c` on the CPU with its seeds moved by `shift`: each tile's rank and bytes (null: reset). */
  private async cpuTiles(
    c: GpuCheckJob,
    shift: number,
    local: TileCompressorLike,
    epoch: number,
  ): Promise<{ rank: number; bytes: Uint8Array }[] | null> {
    const { width, height } = this.init!;
    const out: { rank: number; bytes: Uint8Array }[] = [];
    const jobs: TileJob[] = this.tiles.map((t, i) => ({
      window: c.index,
      tile: i,
      frames: c.frames,
      x0: t.x0,
      y0: t.y0,
      w: t.w,
      h: t.h,
      seed: (((c.index << 20) ^ i) + shift) >>> 0,
      prevRank: c.prev[i],
    }));
    const done = await this.pool.compressWindow(jobs, {
      local,
      read: (tj, raw) => cutTile(c.data, width, height, c.frames, tj.x0, tj.y0, tj.w, tj.h, raw),
      write: (_tj, r) => out.push({ rank: r.rank, bytes: r.bytes }),
      yieldNow: this.yieldNow,
    });
    return done && epoch === this.epoch ? out : null;
  }

  /** The GPU run cannot go on: drop its files, write nothing more, say why once. */
  private async gpuFail(text: string, epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch || this.gaveUp || !this.gpu) return;
    const session = this.session;
    await this.clear();
    this.gaveUp = true;
    this.stopText = text;
    this.deps.toMain.postMessage({ type: 'error', session, message: text });
  }

  /**
   * End a GPU run: stop the wait for its window, free the device and the
   * statistics. A window being compressed read its statistics when it began
   * (each `GpuTileJob` borrows them only while it is built), so they may go at once.
   */
  private dropGpu(): void {
    if (this.gpu) this.roomOff();
    this.gabort?.();
    this.gabort = null;
    this.gpu?.destroy();
    this.gpu = null;
    this.ring = null;
    for (const s of [this.gwin.stats, ...this.gpending.map((w) => w.stats), ...this.gspare])
      s?.free();
    this.gwin = noGpuWindow();
    this.gpending = [];
    this.gspare = [];
  }

  private post(): void {
    const waiting = this.waiting();
    const window = this.gwindow || this.init?.window;
    const status: CompressStatus = {
      windows: this.windows,
      frames: this.frames,
      pending: waiting.length,
      pendingFrames: waiting.reduce((s, w) => s + w.frames, 0),
      meanRank: this.meanRank,
      msPerFrame: this.msPerFrame,
      factorBytes: this.factorBytes,
      final: this.final && waiting.length === 0,
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
      ...(window !== undefined ? { window } : {}),
      ...(this.gring > 0 ? { ring: this.gring } : {}),
      backend: this.gwindow > 0 ? 'gpu' : 'cpu',
      ...(this.init?.gpu ? { waitS: this.waitMs / 1000, waits: this.waits } : {}),
      ...(this.gcheck ? { check: { ...this.gcheck } } : {}),
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
    this.dropGpu();
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
    this.stopText = null;
    this.backlogPeak = 0;
    this.endAt = null;
    this.framesAtEnd = 0;
    this.behindAtEnd = null;
    this.gwindow = 0;
    this.gring = 0;
    this.gkeep.clear();
    this.gchecks = [];
    this.gcheck = null;
    await this.deps.store.clear();
  }
}
