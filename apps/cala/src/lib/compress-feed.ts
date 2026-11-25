/**
 * The fast worker's side of the compression: cuts the stream of preprocessed
 * frames into windows and transfers a copy of each batch to the compress
 * worker. The copy is all the fast loop pays; quantizing is the compress
 * worker's work. Pure apart from the injected port, so the window bookkeeping
 * is unit-tested without workers.
 *
 * A GPU run (`gpu`) waits for room: the compress worker says how many frames
 * the GPU compressor's ring holds and the oldest frame it still needs
 * (`CompressToFast`), and `room` gives the trace stage a promise to wait on
 * before a batch that would overwrite a frame of a window not compressed yet.
 * The trace stage's wait holds its pooled buffers, so the stages before it
 * wait too (their credits). The wait ends when room appears, when the GPU
 * route ends (`ring` 0: a give-up, a reset, a lost device), on `reset` and
 * `release` (Stop, a new run), or after `GPU_STALL_S` without word from the
 * GPU (it says so after every batch of tiles; the run then gives its factors
 * up). The compress worker hears when each wait begins (`waiting`) and how
 * long it took (`waited`). Every other run never waits.
 */
import type {
  CompressSource,
  CompressTiling,
  CompressToFast,
  FastToCompress,
} from '../workers/compress-types.ts';
import type { PortLike } from '../workers/slow-types.ts';
import type { PoolWidth } from './compress-pool.ts';

export interface CompressFeedOptions {
  width: number;
  height: number;
  session: number;
  /** Tile edge, px. */
  tile?: number;
  /** How the frame is cut into tiles (default plain: the history review reads side-by-side tiles). */
  tiling?: CompressTiling;
  /** Which frames these are (default Discover's). */
  source?: CompressSource;
  /** Frames per window. */
  window?: number;
  /** Quantized values are `round(value * quant)`: 1/64 grey level, ±512 grey levels. */
  quant?: number;
  /** Compress workers while the recording runs and after its end (absent: one and one). */
  pool?: PoolWidth;
  /** The cap on window files waiting for compression, bytes (absent: the runner's own). */
  backlogCap?: number;
  /** Extract on factors on rebuilt frames, as before slice 6 (`?debug&fextract=0`). */
  frameExtract?: boolean;
  /** Compress on the GPU (a recording's default; `CompressInit.gpu`). */
  gpu?: boolean;
  /** With `gpu`: windows the CPU compresses too, to check the GPU's factors (`?debug&gpucheck=N`). */
  gpuCheck?: number;
  /** With `gpu`: a wait for room gives up after this long without progress, ms (default `GPU_STALL_S`). */
  stallMs?: number;
}

/** Discover stops waiting for a GPU compressor that made no progress for this long, s. */
export const GPU_STALL_S = 30;

export const COMPRESS_DEFAULTS = {
  tile: 64,
  window: 600,
  quant: 64,
  tiling: 'plain',
  source: 'discover',
} as const;

/** What the fast loop needs of a feed. */
export interface CompressFeedLike {
  push(batch: Float32Array, start: number, count: number): void;
  /** A library the slow loop published (the bytes are copied). */
  library(version: number, bytes: Uint8Array): void;
  end(): void;
  reset(): void;
  /**
   * A GPU run: resolves when frames `[start, start + count)` fit the GPU
   * compressor's ring (null: they fit now, or this run never waits).
   */
  room?(start: number, count: number): Promise<void> | null;
  /** The compress worker's answer on the feed's port. */
  answer?(msg: CompressToFast): void;
  /**
   * The run is stopped or replaced: a wait for room ends now, the run's
   * factors with it, and no batch waits again (`reset`; after the end: nothing).
   */
  release?(): void;
}

/** A batch waiting for room in the GPU's ring. */
interface RoomWait {
  start: number;
  count: number;
  t0: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: () => void;
}

export class CompressFeed implements CompressFeedLike {
  private readonly o: Required<
    Omit<
      CompressFeedOptions,
      'pool' | 'backlogCap' | 'frameExtract' | 'gpu' | 'gpuCheck' | 'stallMs'
    >
  > & {
    pool?: PoolWidth;
    backlogCap?: number;
    frameExtract?: boolean;
    gpu?: boolean;
    gpuCheck?: number;
    stallMs?: number;
  };
  private readonly px: number;
  private initSent = false;
  /** Frames in the open window, its index, and the stream frame expected next. */
  private filled = 0;
  private windowIndex = 0;
  private next = -1;
  private ended = false;
  private disposed = false;
  // ---- A GPU run: room in the GPU compressor's ring ----
  /** Frames the ring holds and per window (0: not known yet, or the GPU route ended). */
  private ring = 0;
  private gpuWindow = 0;
  /** The oldest frame the GPU still needs (as last heard), and the first frame sent. */
  private keepFrom = 0;
  private first = -1;
  /** The GPU route ended: no more waits. */
  private gpuOff = false;
  private wait: RoomWait | null = null;

  constructor(
    options: CompressFeedOptions,
    private readonly port: PortLike<FastToCompress>,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.o = { ...COMPRESS_DEFAULTS, ...options };
    if (!(this.o.window >= 2) || !(this.o.tile >= 2) || !(this.o.quant > 0)) {
      throw new RangeError('CompressFeed needs window >= 2, tile >= 2, quant > 0.');
    }
    this.px = options.width * options.height;
  }

  /** `count` frames that start at stream frame `start`. */
  push(batch: Float32Array, start: number, count: number): void {
    if (this.disposed || count <= 0) return;
    const {
      session,
      width,
      height,
      tile,
      window,
      quant,
      tiling,
      source,
      pool,
      backlogCap,
      frameExtract,
      gpu,
      gpuCheck,
    } = this.o;
    if (!this.initSent) {
      this.port.postMessage({
        type: 'init',
        session,
        width,
        height,
        tile,
        window,
        quant,
        tiling,
        source,
        ...(pool ? { pool } : {}),
        ...(backlogCap !== undefined ? { backlogCap } : {}),
        ...(frameExtract ? { frameExtract } : {}),
        ...(gpu ? { gpu } : {}),
        ...(gpu && gpuCheck ? { gpuCheck } : {}),
      });
      this.initSent = true;
    }
    // A gap in the stream ends the window: its frames must be consecutive.
    if (this.next >= 0 && start !== this.next) this.close(false);
    if (this.first < 0) this.first = start;
    let done = 0;
    while (done < count) {
      const n = Math.min(count - done, window - this.filled);
      const data = batch.slice(done * this.px, (done + n) * this.px);
      this.filled += n;
      const last = this.filled >= window;
      this.port.postMessage(
        {
          type: 'chunk',
          session,
          window: this.windowIndex,
          start: start + done,
          count: n,
          last,
          data,
        },
        [data.buffer as ArrayBuffer],
      );
      if (last) {
        this.windowIndex++;
        this.filled = 0;
      }
      done += n;
    }
    this.next = start + count;
  }

  library(version: number, bytes: Uint8Array): void {
    if (this.disposed || !this.initSent) return;
    const copy = bytes.slice();
    this.port.postMessage({ type: 'library', session: this.o.session, version, bytes: copy }, [
      copy.buffer as ArrayBuffer,
    ]);
  }

  private close(final: boolean): void {
    if (this.filled > 0) {
      this.windowIndex++;
      this.filled = 0;
    }
    this.port.postMessage({ type: 'close', session: this.o.session, final });
  }

  room(start: number, count: number): Promise<void> | null {
    // Consecutive frames only: the GPU's ring is addressed by stream frame, so
    // after a gap (never on a recording) the compress worker judges alone.
    const consecutive = this.next < 0 || start === this.next;
    if (!this.o.gpu || this.disposed || this.ended || this.gpuOff || this.ring <= 0) return null;
    // A batch longer than the ring's slack might never fit: never wait for it.
    if (!consecutive || count <= 0 || count > this.ring - this.gpuWindow) return null;
    if (this.fits(start, count)) return null;
    this.endWait(false);
    this.port.postMessage({ type: 'waiting', session: this.o.session });
    return new Promise<void>((resolve) => {
      this.wait = { start, count, t0: this.now(), timer: null, resolve };
      this.armStall();
    });
  }

  answer(msg: CompressToFast): void {
    if (msg.type !== 'room' || msg.session !== this.o.session || this.disposed) return;
    if (msg.ring <= 0) {
      this.gpuOff = true;
      this.ring = 0;
      this.endWait(false);
      return;
    }
    this.ring = msg.ring;
    this.gpuWindow = msg.window;
    this.keepFrom = Math.max(this.keepFrom, msg.keepFrom);
    const w = this.wait;
    if (!w) return;
    // Every answer is the GPU at work (a window or a batch of tiles done): the stall clock restarts.
    if (this.fits(w.start, w.count)) this.endWait(false);
    else this.armStall();
  }

  release(): void {
    if (!this.ended) this.reset();
  }

  /** Frames `[start, start + count)` overwrite no frame the GPU still needs. */
  private fits(start: number, count: number): boolean {
    const keep = Math.max(this.keepFrom, this.first < 0 ? start : this.first);
    return start + count - keep <= this.ring;
  }

  /** (Re)start the stall clock of the wait: no word from the GPU for `stallMs` ends it and the factors. */
  private armStall(): void {
    const w = this.wait;
    if (!w) return;
    if (w.timer !== null) clearTimeout(w.timer);
    w.timer = setTimeout(
      () => {
        this.gpuOff = true;
        this.endWait(true);
      },
      this.o.stallMs ?? GPU_STALL_S * 1000,
    );
  }

  /** End the wait (if any) and tell the compress worker how long it took. */
  private endWait(stalled: boolean): void {
    const w = this.wait;
    if (!w) return;
    this.wait = null;
    if (w.timer !== null) clearTimeout(w.timer);
    if (!this.disposed) {
      const ms = Math.max(0, this.now() - w.t0);
      this.port.postMessage({
        type: 'waited',
        session: this.o.session,
        ms,
        ...(stalled ? { stalled } : {}),
      });
    }
    w.resolve();
  }

  /** The recording ended: compress the last, shorter window too. */
  end(): void {
    if (this.disposed || !this.initSent || this.ended) return;
    this.ended = true;
    this.close(true);
  }

  /**
   * The fast loop is dropped. Before the end of the recording that is a stop
   * or restart, and the compress worker drops its windows too. After it (pass
   * 2 replaces the fast loop in the same worker) the windows stay: they are
   * the record of the run, and the next run's `init` clears them.
   */
  reset(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.initSent && !this.ended) {
      this.port.postMessage({ type: 'reset', session: this.o.session });
    }
    this.endWait(false);
  }
}
