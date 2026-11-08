/**
 * The fast loop, inside the frame worker: solves every preprocessed,
 * motion-corrected frame for the traces of the current footprint library,
 * forwards frames to the slow worker (cell discovery) without ever waiting
 * for it, and swaps in the libraries it publishes between batches.
 *
 * The slow worker answers on its own schedule. `handleSlow` only records what
 * arrived (a returned buffer, the newest library's bytes); the library is
 * rebuilt and swapped at the start of the next `process` call, so a swap
 * always happens between frames, and warm starts follow cell ids.
 */
import type { FastToSlow, PortLike, SlowToFast } from '../workers/slow-types.ts';
import { ForwardPool } from './forward-pool.ts';

/** What the fast loop needs of a `TraceLibrary`. */
export interface TraceLibraryLike {
  readonly version: number;
  ids(): Uint32Array;
  free(): void;
}

/** What the fast loop needs of a `TraceEngine`. */
export interface TraceEngineLike {
  setLibrary(lib: TraceLibraryLike): void;
  processFrames(frames: Float32Array, count: number): Float32Array;
  free(): void;
}

/** Constructors of the WASM objects (the real ones, or fakes in tests). */
export interface TraceBackend {
  libraryFromBytes(bytes: Uint8Array): TraceLibraryLike;
  newEngine(lib: TraceLibraryLike): TraceEngineLike;
}

/** What the fast loop reads from the preprocessor when the slow loop starts. */
export interface CalibrationSource {
  fovMask(): Uint8Array;
  noiseSigma(): Float32Array;
}

export interface FastLoopOptions {
  width: number;
  height: number;
  /** Frames per batch: the size of the forwarded buffers. */
  batchSize: number;
  session: number;
  cellDiameterPx: number;
  flattenSigmaPx: number;
  /** Run cell discovery (forward frames to the slow worker). */
  discover?: boolean;
  /** Slow-loop work units per observed frame. */
  budget?: number;
  /** First frame the slow loop sees (the noise map needs a few frames). */
  startFrame?: number;
  /** Send a fresh noise map every this many frames. */
  noiseEvery?: number;
  /** Forward buffers (batches in flight to the slow worker). */
  poolSize?: number;
}

export const FAST_LOOP_DEFAULTS = {
  // The slow loop's validated default (PR #281): ~11 ms per frame in WASM.
  budget: 3e7,
  startFrame: 50,
  noiseEvery: 200,
  // One batch being observed, one queued.
  poolSize: 2,
} as const;

/** The fast loop's output for one batch. */
export interface CellsBatch {
  /** Library version that produced the traces (0 = none yet). */
  version: number;
  /** Cell ids in trace order. */
  ids: Uint32Array;
  /** `count * ids.length` traces, frame after frame. */
  traces: Float32Array;
  /** Wall time of the library swap (0 without one), the solve and the forward copy, ms. */
  swapMs: number;
  solveMs: number;
  forwardMs: number;
  /** Discovery is running (frames are being forwarded or dropped). */
  discovering: boolean;
  /** Totals since the start: frames forwarded and dropped for the slow loop. */
  forwardedFrames: number;
  droppedFrames: number;
  /** Stream frame up to which the slow loop has consumed batches. */
  slowFrame: number;
}

const now = (): number => performance.now();

export class FastLoop {
  private readonly o: Required<FastLoopOptions>;
  private readonly px: number;
  private readonly port: PortLike<FastToSlow> | null;
  private readonly backend: TraceBackend;
  private readonly pool: ForwardPool;
  private engine: TraceEngineLike | null = null;
  private version = 0;
  private ids: Uint32Array = new Uint32Array(0);
  private pendingLibrary: Uint8Array | null = null;
  private initSent = false;
  private lastNoise = 0;
  private slowFrame = 0;
  /** Discovery was turned back on: frames skipped while it was off are not lag. */
  private resumed = false;
  private disposed = false;

  constructor(options: FastLoopOptions, port: PortLike<FastToSlow> | null, backend: TraceBackend) {
    this.o = { ...FAST_LOOP_DEFAULTS, discover: true, ...options };
    this.px = options.width * options.height;
    this.port = port;
    this.backend = backend;
    this.pool = new ForwardPool(this.o.poolSize, this.o.batchSize * this.px);
  }

  get session(): number {
    return this.o.session;
  }

  get libraryVersion(): number {
    return this.version;
  }

  get discovering(): boolean {
    return this.o.discover && this.port !== null;
  }

  /** Turn discovery on or off (off: nothing is forwarded; the library stays). */
  setDiscovery(on: boolean): void {
    if (on && !this.o.discover) this.resumed = true;
    this.o.discover = on;
  }

  /** A message from the slow worker. Records it; never calls into WASM. */
  handleSlow(msg: SlowToFast): void {
    if (msg.session !== this.o.session || this.disposed) return;
    if (msg.type === 'ack') {
      this.pool.release(msg.frames);
      this.slowFrame = Math.max(this.slowFrame, msg.start + msg.count);
    } else if (msg.type === 'library') {
      // Only the newest matters: an older pending version is replaced.
      if (msg.version > this.version) this.pendingLibrary = msg.bytes;
    }
  }

  /**
   * Solve `count` frames (`frames` holds at least `count * width * height`
   * values) that start at stream frame `start`, then forward them.
   */
  process(
    frames: Float32Array,
    start: number,
    count: number,
    calibration: CalibrationSource,
  ): CellsBatch {
    const t0 = now();
    this.applyPendingLibrary();
    const t1 = now();
    const n = count * this.px;
    const batch = frames.subarray(0, n);
    const traces =
      this.engine && this.ids.length > 0
        ? this.engine.processFrames(batch, count)
        : new Float32Array(0);
    const t2 = now();
    this.forward(batch, start, count, traces, calibration);
    const t3 = now();
    return {
      version: this.version,
      ids: this.ids.slice(),
      traces,
      swapMs: t1 - t0,
      solveMs: t2 - t1,
      forwardMs: t3 - t2,
      discovering: this.discovering,
      forwardedFrames: this.pool.forwardedFrames,
      droppedFrames: this.pool.droppedFrames,
      slowFrame: this.slowFrame,
    };
  }

  /** The recording ended: let the slow loop publish what it has. */
  end(): void {
    if (this.initSent) this.port?.postMessage({ type: 'end', session: this.o.session });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port?.postMessage({ type: 'reset', session: this.o.session });
    this.engine?.free();
    this.engine = null;
    this.pendingLibrary = null;
  }

  private applyPendingLibrary(): void {
    const bytes = this.pendingLibrary;
    if (!bytes) return;
    this.pendingLibrary = null;
    const lib = this.backend.libraryFromBytes(bytes);
    try {
      if (this.engine) this.engine.setLibrary(lib);
      else this.engine = this.backend.newEngine(lib);
      this.version = lib.version;
      this.ids = lib.ids();
    } finally {
      // The engine holds its own reference to the library.
      lib.free();
    }
  }

  private forward(
    batch: Float32Array,
    start: number,
    count: number,
    traces: Float32Array,
    calibration: CalibrationSource,
  ): void {
    const port = this.port;
    if (!port || !this.o.discover) return;
    const session = this.o.session;
    if (!this.initSent) {
      if (start + count < this.o.startFrame) return;
      port.postMessage(
        {
          type: 'init',
          session,
          width: this.o.width,
          height: this.o.height,
          fov: calibration.fovMask(),
          noise: calibration.noiseSigma(),
          cellDiameterPx: this.o.cellDiameterPx,
          flattenSigmaPx: this.o.flattenSigmaPx,
          budget: this.o.budget,
        },
        [],
      );
      this.initSent = true;
      this.lastNoise = start;
    }
    const buf = this.pool.acquire(count);
    if (!buf) return;
    if (this.resumed) {
      this.resumed = false;
      this.slowFrame = Math.max(this.slowFrame, start);
    }
    buf.set(batch);
    const tr = traces.slice();
    const transfer: Transferable[] = [buf.buffer as ArrayBuffer, tr.buffer as ArrayBuffer];
    let noise: Float32Array | undefined;
    if (start - this.lastNoise >= this.o.noiseEvery) {
      noise = calibration.noiseSigma();
      transfer.push(noise.buffer as ArrayBuffer);
      this.lastNoise = start;
    }
    port.postMessage(
      {
        type: 'frames',
        session,
        start,
        count,
        version: this.version,
        cells: this.ids.length,
        frames: buf,
        traces: tr,
        ...(noise ? { noise } : {}),
      },
      transfer,
    );
  }
}
