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
 * has arrived, the factor engine (`FactorExtractor`) solves every window from
 * its factor file with that library, without rebuilding a frame, and the
 * traces of each window go to the main thread. A cell found late in the
 * recording so gets its trace from the first frame on, without the raw video
 * being read again.
 *
 * Extract on factors (`extract`): the same solve over every window with the
 * library the main thread sends, with the signed traces, posted per window
 * under a job number; refused unless every window is compressed. A failed job
 * posts an `error` that names the job; the factors stay usable.
 *
 * History review (`review`): each compressed window's factor file also goes
 * to the review worker, and after every `every` windows the newest library
 * with the request to review (see `review-runner.ts`). The review itself
 * never runs here: it would hold up the writes of the incoming batches.
 *
 * Window file `w<index>.i16`: the chunks as they arrived, each in tile order.
 * Factor file `f<index>.bin`: the header of `factorHeader` (`CALAFAC2`, with the
 * tiling), then per tile u32 byte length and `TileFactors.toBytes()`.
 */
import type {
  CompressInit,
  CompressStatus,
  CompressToMain,
  FastToCompress,
} from '../workers/compress-types.ts';
import type { CompressToReview } from '../workers/review-types.ts';
import type { PortLike } from '../workers/slow-types.ts';
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

/** The factor engine for one library: solves a compressed window from its file, without rebuilding frames. */
export interface FactorExtractLike {
  ids(): Uint32Array;
  /** Read a factor file and prepare its solve; returns the window's frames. */
  open(file: Uint8Array): number;
  /** Stream index of the open window's first frame. */
  readonly start: number;
  /** `count x cells` traces of frames `t0..t0 + count` of the open window. */
  solve(t0: number, count: number): Float32Array;
  /** Also compute the signed traces (absent in older fakes: no signed traces). */
  setSigned?(on: boolean): void;
  /** The signed traces of the last `solve`, laid out as its traces (empty when off). */
  lastSigned?(): Float32Array;
  free(): void;
}

/** Frames solved between two yields of the back-fill. */
const BACKFILL_BATCH = 64;

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
  extract?(library: Uint8Array): FactorExtractLike;
  toMain: PortLike<CompressToMain>;
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
  /** Extract jobs waiting for the loop. */
  private jobs: { session: number; job: number; library: Uint8Array }[] = [];
  private windows = 0;
  private frames = 0;
  private factorBytes = 0;
  /** Mean tile rank of each compressed window, times its frames (for the session's mean). */
  private rankFrames = 0;
  /** Compute time (quantizing and compressing) of all compressed windows, ms. */
  private computeMs = 0;

  constructor(private readonly deps: CompressRunnerDeps) {
    this.yieldNow = deps.yieldNow ?? macrotask;
    this.now = deps.now ?? (() => performance.now());
  }

  /** One message from the fast worker. Calls must not overlap. */
  async handle(msg: FastToCompress): Promise<void> {
    if (msg.type === 'init') {
      await this.clear();
      // No session until the new one is laid out: a refused layout must not
      // leave the previous session's `init` taking chunks.
      this.session = -1;
      this.init = null;
      // The layout first: a refused one must not leave a half-initialised session.
      const tiles = tilesOf(this.deps.layout(msg.width, msg.height, msg.tile, msg.tiling));
      this.tiles = tiles;
      this.layoutPx = tiles.reduce((s, t) => s + t.w * t.h, 0);
      this.session = msg.session;
      this.init = msg;
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
      // Nothing is behind the last status any more: say so.
      this.post();
      this.reviewOf(this.init)?.port.postMessage({ type: 'reset', session: msg.session });
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

  /**
   * Extract on factors, job `job`: solve every compressed window with
   * `library` (signed traces too) and post each window (`extracted`), then
   * `extract-done`. Refused with an `error` naming the job unless this is
   * the session's run and every window is compressed.
   */
  extract(session: number, job: number, library: Uint8Array): void {
    if (session !== this.session || !this.init) {
      this.refuse(session, job, 'no factors of this run');
      return;
    }
    this.jobs.push({ session, job, library });
    this.maybeExtract();
  }

  private refuse(session: number, job: number, why: string): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session,
      job,
      message: `Extract on factors: ${why}.`,
    });
  }

  private maybeExtract(): void {
    if (this.loop) return;
    const next = this.jobs.shift();
    if (!next) return;
    const { extract } = this.deps;
    if (!extract) this.refuse(next.session, next.job, 'this worker has no factor engine');
    else if (this.open || this.pending.length > 0 || !this.final)
      this.refuse(next.session, next.job, 'the factors are not complete');
    else {
      this.launch(this.runExtract(next, extract), next.job);
      return;
    }
    this.maybeExtract();
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
    const { extract } = this.deps;
    if (this.loop || this.wanted === null || !lib || lib.version < this.wanted) return;
    if (this.open || this.pending.length > 0 || !extract) return;
    this.wanted = null;
    this.launch(this.runBackfill(lib, extract));
  }

  /** Run `task` as the worker's one background loop; `job`: the Extract job it runs, if any. */
  private launch(task: Promise<void>, job?: number): void {
    const session = this.session;
    let failed = false;
    this.loop = task
      .catch((err: unknown) => {
        failed = true;
        this.deps.toMain.postMessage({
          type: 'error',
          session,
          ...(job === undefined ? {} : { job }),
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.loop = null;
        // A window closed, or a back-fill or an Extract was asked for, while the loop was busy.
        if (failed) {
          this.dropJobs('the compress loop failed');
          return;
        }
        if (this.pending.length > 0) this.kick();
        else {
          this.maybeBackfill();
          this.maybeExtract();
        }
      });
  }

  /** Answer every waiting Extract job with an error, so the main thread never waits for one. */
  private dropJobs(why: string): void {
    const jobs = this.jobs;
    this.jobs = [];
    for (const j of jobs) this.refuse(j.session, j.job, why);
  }

  /**
   * Solve every compressed window from its factor file, in stream order, and
   * hand each to `onWindow` (`signed`: only with `wantSigned` and when the
   * engine gave it). Returns the frames solved, or null when the runner was
   * reset meanwhile.
   */
  private async solveWindows(
    extractor: FactorExtractLike,
    ids: Uint32Array,
    epoch: number,
    wantSigned: boolean,
    onWindow: (w: {
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
      signed: Float32Array | null;
    }) => void,
  ): Promise<number | null> {
    const cells = ids.length;
    let frames = 0;
    for (const index of [...this.done]) {
      const file = await this.deps.store.open(factorName(index));
      const bytes = new Uint8Array(file.size());
      try {
        file.read(bytes, 0);
      } finally {
        file.close();
      }
      if (epoch !== this.epoch) return null;
      const count = extractor.open(bytes);
      const start = extractor.start;
      const traces = new Float32Array(count * cells);
      let signed: Float32Array | null = null;
      let signedOk = wantSigned;
      for (let t = 0; t < count; t += BACKFILL_BATCH) {
        const n = Math.min(BACKFILL_BATCH, count - t);
        traces.set(extractor.solve(t, n), t * cells);
        const s = signedOk ? extractor.lastSigned?.() : undefined;
        if (s && s.length === n * cells) {
          signed ??= new Float32Array(count * cells);
          signed.set(s, t * cells);
        } else {
          signedOk = false;
          signed = null;
        }
        await this.yieldNow();
        if (epoch !== this.epoch) return null;
      }
      onWindow({ start, count, ids: ids.slice(), traces, signed });
      frames += count;
    }
    return frames;
  }

  private async runBackfill(
    lib: { version: number; bytes: Uint8Array },
    makeExtractor: (library: Uint8Array) => FactorExtractLike,
  ): Promise<void> {
    if (!this.init) return;
    const epoch = this.epoch;
    const session = this.session;
    const t0 = this.now();
    const extractor = makeExtractor(lib.bytes);
    try {
      const ids = extractor.ids();
      if (ids.length === 0) return;
      let first = true;
      const frames = await this.solveWindows(extractor, ids, epoch, false, (w) => {
        this.deps.toMain.postMessage(
          {
            type: 'traces',
            session,
            version: lib.version,
            first,
            start: w.start,
            count: w.count,
            ids: w.ids,
            traces: w.traces,
          },
          [w.ids.buffer as ArrayBuffer, w.traces.buffer as ArrayBuffer],
        );
        first = false;
      });
      if (frames === null) return;
      this.deps.toMain.postMessage({
        type: 'backfilled',
        session,
        version: lib.version,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } finally {
      extractor.free();
    }
  }

  private async runExtract(
    req: { session: number; job: number; library: Uint8Array },
    makeExtractor: (library: Uint8Array) => FactorExtractLike,
  ): Promise<void> {
    const epoch = this.epoch;
    const { session, job } = req;
    const t0 = this.now();
    let extractor: FactorExtractLike | null = null;
    try {
      extractor = makeExtractor(req.library);
      extractor.setSigned?.(true);
      const frames = await this.solveWindows(extractor, extractor.ids(), epoch, true, (w) => {
        const signed = w.signed ?? new Float32Array(0);
        this.deps.toMain.postMessage(
          {
            type: 'extracted',
            session,
            job,
            start: w.start,
            count: w.count,
            ids: w.ids,
            traces: w.traces,
            signed,
          },
          [
            w.ids.buffer as ArrayBuffer,
            w.traces.buffer as ArrayBuffer,
            signed.buffer as ArrayBuffer,
          ],
        );
      });
      if (frames === null) {
        this.refuse(session, job, 'cancelled by a reset');
        return;
      }
      this.deps.toMain.postMessage({
        type: 'extract-done',
        session,
        job,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } catch (err) {
      // The job's error, not the compression's: the factors stay as they are.
      this.deps.toMain.postMessage({
        type: 'error',
        session,
        job,
        message:
          epoch !== this.epoch
            ? 'Extract on factors: cancelled by a reset.'
            : err instanceof Error
              ? err.message
              : String(err),
      });
    } finally {
      extractor?.free();
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
          chunkAt += n * this.layoutPx * 2;
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
      this.rankFrames += (job.frames * rank) / Math.max(1, this.tiles.length);
      this.computeMs += ms + job.quantMs;
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
      meanRank: this.rankFrames / Math.max(1, this.frames),
      msPerFrame: this.computeMs / Math.max(1, this.frames),
      factorBytes: this.factorBytes,
      final: this.final && this.pending.length === 0,
      tiling: this.init?.tiling ?? 'plain',
      source: this.init?.source ?? 'discover',
    };
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status });
  }

  /** Stop the loop, drop every file and counter. */
  private async clear(): Promise<void> {
    this.epoch++;
    this.open?.file.close();
    this.open = null;
    this.pending = [];
    this.dropJobs('cancelled by a reset');
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
    this.rankFrames = 0;
    this.computeMs = 0;
    await this.deps.store.clear();
  }
}
