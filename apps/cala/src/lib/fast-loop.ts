/**
 * The fast loop, inside the frame worker: solves every preprocessed,
 * motion-corrected frame for the traces of the current footprint library,
 * forwards frames to the slow worker (cell discovery) without ever waiting
 * for it, and swaps in the libraries it publishes between batches.
 *
 * The slow worker answers on its own schedule. `handleSlow` only records what
 * arrived (a returned buffer, the newest library's bytes); the library is
 * read back and swapped at the start of the next `process` call, so a swap
 * always happens between frames, and warm starts follow cell ids. The bytes
 * carry the solver's precomputed terms, so the swap is a copy (a few ms at
 * hundreds of cells), not a rebuild.
 */
import type { FastToSlow, PortLike, SlowToFast } from '../workers/slow-types.ts';
import { ForwardPool } from './forward-pool.ts';
import type { QcWire } from './qc.ts';

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

/** What the fast loop needs of a `QcMonitor` (online quality control). */
export interface QcMonitorLike {
  /** Solves the batch with `engine` (same result as `engine.processFrames`) and observes it. */
  processFrames(engine: TraceEngineLike, frames: Float32Array, count: number): Float32Array;
  /** As `processFrames`, with each frame's rigid shift (feeds `motion_r2`); absent: shifts are not used. */
  processFramesShifted?(
    engine: TraceEngineLike,
    frames: Float32Array,
    count: number,
    dy: Float32Array,
    dx: Float32Array,
  ): Float32Array;
  setNoise(noise: Float32Array): void;
  cellMetrics(): Float64Array;
  globalMetrics(): Float64Array;
  neighbours(slot: number): Float64Array;
  residualMap(): Float32Array;
  residualMapDims(): Uint32Array;
  free(): void;
}

/** What a `QcMonitor` is built from. */
export interface QcSetup {
  width: number;
  height: number;
  fov: Uint8Array;
  noise: Float32Array;
  fps: number;
}

/** Constructors of the WASM objects (the real ones, or fakes in tests). */
export interface TraceBackend {
  libraryFromBytes(bytes: Uint8Array): TraceLibraryLike;
  newEngine(lib: TraceLibraryLike): TraceEngineLike;
  /** Online QC (absent: no QC). */
  newQc?(setup: QcSetup): QcMonitorLike;
  /** `QcMonitor.cellFields()` / `globalFields()`, comma-separated. */
  qcFields?(): { cell: string; global: string };
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
  /** Run online quality control on the traces (when the backend has it). */
  qc?: boolean;
  /** Frame rate of the recording (QC rates are per minute). */
  fps?: number;
  /** Wall time between QC snapshots sent to the main thread, ms. */
  qcEveryMs?: number;
  /** Solve with this library (`TraceLibrary.toBytes()`) from the first frame (pass 2: the final library). */
  initialLibrary?: Uint8Array;
}

export const FAST_LOOP_DEFAULTS = {
  // The slow loop's validated default (PR #281): ~11 ms per frame in WASM.
  budget: 3e7,
  startFrame: 50,
  noiseEvery: 200,
  // One batch being observed, one queued.
  poolSize: 2,
  qc: true,
  fps: 20,
  qcEveryMs: 1000,
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
  /** QC is observing the traces (its cost is part of `solveMs`). */
  qcOn: boolean;
  /** A QC snapshot, about once per `qcEveryMs` of wall time. */
  qc?: QcWire;
}

const now = (): number => performance.now();

export class FastLoop {
  private readonly o: Required<Omit<FastLoopOptions, 'initialLibrary'>>;
  private readonly px: number;
  private readonly port: PortLike<FastToSlow> | null;
  private readonly backend: TraceBackend;
  private readonly pool: ForwardPool;
  private engine: TraceEngineLike | null = null;
  private version = 0;
  private ids: Uint32Array = new Uint32Array(0);
  private qc: QcMonitorLike | null = null;
  private qcFields: { cell: string[]; global: string[] } | null = null;
  private qcNoise = 0;
  private qcLast = -Infinity;
  private qcFrame = 0;
  private pendingLibrary: Uint8Array | null = null;
  private initSent = false;
  private lastNoise = 0;
  private slowFrame = 0;
  /** Discovery was turned back on: frames skipped while it was off are not lag. */
  private resumed = false;
  private disposed = false;

  constructor(options: FastLoopOptions, port: PortLike<FastToSlow> | null, backend: TraceBackend) {
    const { initialLibrary, ...rest } = options;
    this.o = { ...FAST_LOOP_DEFAULTS, discover: true, ...rest };
    this.pendingLibrary = initialLibrary ?? null;
    if (!(this.o.fps > 0)) this.o.fps = FAST_LOOP_DEFAULTS.fps;
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
    shifts?: { dy: Float32Array; dx: Float32Array },
  ): CellsBatch {
    const t0 = now();
    this.applyPendingLibrary();
    const t1 = now();
    const n = count * this.px;
    const batch = frames.subarray(0, n);
    let traces: Float32Array = new Float32Array(0);
    let qcOn = false;
    if (this.engine && this.ids.length > 0) {
      const qc = this.qcMonitor(start, calibration);
      qcOn = qc !== null;
      traces = qc
        ? shifts && qc.processFramesShifted
          ? qc.processFramesShifted(this.engine, batch, count, shifts.dy, shifts.dx)
          : qc.processFrames(this.engine, batch, count)
        : this.engine.processFrames(batch, count);
      if (qc) this.qcFrame = start + count;
    }
    const t2 = now();
    this.forward(batch, start, count, traces, calibration);
    const t3 = now();
    const qc = qcOn ? this.qcSnapshot(t3) : undefined;
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
      qcOn,
      ...(qc ? { qc } : {}),
    };
  }

  /** The QC monitor, created on first use; refreshes its noise map now and then. */
  private qcMonitor(start: number, calibration: CalibrationSource): QcMonitorLike | null {
    const b = this.backend;
    if (!this.o.qc || !b.newQc || !b.qcFields) return null;
    if (!this.qc) {
      const f = b.qcFields();
      this.qcFields = { cell: f.cell.split(','), global: f.global.split(',') };
      this.qc = b.newQc({
        width: this.o.width,
        height: this.o.height,
        fov: calibration.fovMask(),
        noise: calibration.noiseSigma(),
        fps: this.o.fps,
      });
      this.qcNoise = start;
    } else if (start - this.qcNoise >= this.o.noiseEvery) {
      this.qc.setNoise(calibration.noiseSigma());
      this.qcNoise = start;
    }
    return this.qc;
  }

  /** Copy the QC metrics out, at most once per `qcEveryMs`. */
  private qcSnapshot(t: number): QcWire | undefined {
    const qc = this.qc;
    const fields = this.qcFields;
    if (!qc || !fields || t - this.qcLast < this.o.qcEveryMs) return undefined;
    this.qcLast = t;
    const cells = qc.cellMetrics();
    const n = fields.cell.length > 0 ? Math.floor(cells.length / fields.cell.length) : 0;
    const nbStarts = new Uint32Array(n + 1);
    const lists: Float64Array[] = [];
    let total = 0;
    for (let s = 0; s < n; s++) {
      const l = qc.neighbours(s);
      lists.push(l);
      total += l.length / 3;
      nbStarts[s + 1] = total;
    }
    const nb = new Float32Array(total * 3);
    let o = 0;
    for (const l of lists) {
      nb.set(l, o);
      o += l.length;
    }
    return {
      frame: this.qcFrame,
      version: this.version,
      cellFields: fields.cell,
      globalFields: fields.global,
      cells,
      global: qc.globalMetrics(),
      nbStarts,
      nb,
      residualDims: qc.residualMapDims(),
      residual: qc.residualMap(),
      buildMs: now() - t,
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
    this.qc?.free();
    this.qc = null;
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
