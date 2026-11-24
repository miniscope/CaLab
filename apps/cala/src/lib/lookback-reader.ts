/**
 * Look-back's frame supply (experimental; the look-back worker's core):
 * re-read the past frames the slow loop's scheduler asks for
 * (`SlowLoop.lookbackTake`), preprocess them as the live pipeline did, and
 * solve them with the newest published library. The slow loop then feeds
 * them to the footprint statistics only (`observeLookback`); see
 * `SlowRunner` and the engine's `discover/lookback.rs`. The model is
 * qc_eval's `LookBack::frame`.
 *
 * Per frame, the replay path of Extract (`lib/pipeline-stages.ts`):
 *
 *   front   `frontReplay`: the recorded flicker, the newest flat-field map
 *   motion  `MotionCorrector.applyF32` by the recorded rigid shift (`rigidRecords`)
 *   back    `Preprocessor.backFramesRegistered` on a copy of the live back
 *           half: one copy per look-back block (`block` in the request),
 *           restored from the newest state stage C reported, then run
 *           forward over the block's frames, as qc_eval clones the live
 *           preprocessor per block
 *   traces  `TraceEngine.processFrames` on the newest library
 *
 * Known differences from the live preprocessing of the same frame (the
 * approximations qc_eval makes, plus the app's own):
 *
 *  - The back half starts from the live state at the time the block is
 *    served (up to `LOOKBACK_SNAPSHOT_EVERY` frames old), not the state the
 *    live pipeline had at that frame: background and noise are those of a
 *    later time (qc_eval: the current state, exactly).
 *  - The flat field is the newest map for every frame; Discover corrected
 *    frames before its first map not at all, and later ones with the map of
 *    their time (the same choice as Extract).
 *  - The warp runs in WASM; Discover may have warped on the GPU (WebGPU),
 *    which can differ in the last bits.
 *
 * A Joint run (several sessions read as one stream, `info.sessions`): every
 * frame is preprocessed as its own session's, never with another session's
 * state (`session-boundary.ts`):
 *
 *  - front: the recorded flicker (stage A's reference re-seat is in it), as
 *    in a replay;
 *  - motion: the session's recorded re-registration (`setSession`, from
 *    `RunRecord.noteSession`) warps the frame before the rigid shift, as B
 *    does in a replay;
 *  - back: a block starts from the newest back state of the frame's own
 *    session (stage C snapshots the first and last batch of every session),
 *    so the background floor and noise map are that session's, and its
 *    validity follows the FOV mask as the session warp moved it (the source
 *    mask, which a state does not carry, is set again from the transform).
 *
 * While Discover runs, look-back stays in the current session (the slow
 * loop's floor, `SlowLoop.setLookbackFloor`); the Final settle after the last
 * frame covers every session this way.
 *
 * Frames come from a `HistorySource` (a recording's own `FrameSource`, never
 * the one Discover reads sequentially), so a raw-frame store for live
 * streams can plug in later. The recorded motion and flicker arrive as
 * Discover records them (`pushRows`); a request for a frame not recorded yet
 * waits for its row.
 */
import {
  MotionCorrector,
  MotionOptions,
  Preprocessor,
  SessionAligner,
  SettleDeltaBuilder,
  TraceEngine,
  TraceLibrary,
} from './cala-wasm.ts';
import type { FlatFieldMap } from './flat-field.ts';
import { sessionOfFrame, type FrameSourceInfo, type FramePixels } from './frame-source.ts';
import { frontReplay, rigidRecords } from './pipeline-stages.ts';
import { RunRecord } from './run-record.ts';
import type { SessionTransform } from './session-boundary.ts';
import type { LookbackTiming } from './work-meter.ts';

/**
 * Where look-back reads raw frames from: a recording's `FrameSource`, or
 * later a history store. Frames are global stream indices; a Joint run's
 * source maps one to its session's file and the frame in it
 * (`FrameSource.openSessions`), and `info.sessions` says where each
 * session starts (`sessionOfFrame`).
 */
export interface HistorySource {
  readonly info: { width: number; height: number; bitDepth: number; frameCount: number } & Pick<
    FrameSourceInfo,
    'sessions'
  >;
  /** `count` raw frames from global frame `start` (into `out` when given). */
  readFrames(start: number, count: number, out?: FramePixels): Promise<FramePixels>;
}

/** A transform that moves nothing (absent, or all zeros). */
function isIdentity(t: SessionTransform | undefined): boolean {
  return !t || (t[0] === 0 && t[1] === 0 && t[2] === 0);
}

function emptyTiming(): LookbackTiming {
  return { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 };
}

/** Block seqs at or below this belong to the settle during Discover (`-(1e6 + k)`); the end settle's are above. */
const SETTLE_BLOCK_MAX = -1_000_000;

/** Raw frames read at once around a requested one (the scheduler serves 64-frame blocks forward). */
export const LOOKBACK_READ_SPAN = 64;

/** One frame to supply: stream index, block sequence number, the cells it goes to. */
export interface LookbackFrame {
  frame: number;
  block: number;
}

/** `lookbackTake` output (`[frame, block, n, id_1..id_n, ...]`) as frames. */
export function lookbackFrames(flat: ArrayLike<number>): LookbackFrame[] {
  const out: LookbackFrame[] = [];
  for (let k = 0; k + 2 < flat.length; k += 3 + flat[k + 2])
    out.push({ frame: flat[k], block: flat[k + 1] });
  return out;
}

/** What `LookbackReader.serve` produced (the frames are in the caller's buffer). */
export interface LookbackSolved {
  /** Library version solved with (0: none yet, nothing solved). */
  version: number;
  cells: number;
  /** `count * cells` traces, and the background coefficients of the same solve (absent: no cells). */
  traces: Float32Array;
  background?: Float32Array;
  /** Where this answer's time went (instrumentation only). */
  timing: LookbackTiming;
}

export class LookbackReader {
  /** Time spent since the last `serve` began (read in `serve`'s result). */
  private timing: LookbackTiming = emptyTiming();
  private readonly px: number;
  private readonly record = new RunRecord();
  /** Waiting for rows: resolved when the record covers `frame`. */
  private rowWaiters: { frame: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  /** The newest back state of each session (one session: index 0), and requests waiting for one. */
  private backStates = new Map<number, Uint8Array>();
  private backWaiters: { session: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  /** Session re-registrations Discover applied (by session index; absent: identity). */
  private readonly transforms: (SessionTransform | undefined)[] = [];
  /** The session warp (made on the first session with a transform), and the session it is set for. */
  private aligner: SessionAligner | null = null;
  private alignerSession = -1;
  private flat: FlatFieldMap | null = null;
  private flatDirty = false;
  /** Front half (calibration and flat field only; replayed, so stateless). */
  private front: Preprocessor | null = null;
  private motion: MotionCorrector | null = null;
  /** The block in progress and its copy of the live back half (of the session of its frames). */
  private block: { seq: number; session: number; pre: Preprocessor } | null = null;
  /**
   * The settle during Discover's chunk in progress (block seq <= `SETTLE_BLOCK_MAX`), a slot of its
   * own: its chunks never free the need-driven block's preprocessor, which goes on across requests.
   */
  private settleBlock: { seq: number; session: number; pre: Preprocessor } | null = null;
  private engine: TraceEngine | null = null;
  /** The library `engine` solves with (kept for the settle delta). */
  private lib: TraceLibrary | null = null;
  /** The settle delta's builder (made when a request brings the FOV). */
  private delta: SettleDeltaBuilder | null = null;
  private version = 0;
  private cells = 0;
  private pendingLibrary: { version: number; bytes: Uint8Array } | null = null;
  private raw: FramePixels;
  private rawStart = 0;
  private rawCount = 0;
  private readonly buf: Float32Array;
  private disposed = false;

  /**
   * `keepSessions`: keep the back states of only this many newest sessions
   * (a settle-pool worker, which serves the current session: 2, as the slow
   * loop's floor may still be on the session before for a moment). Absent:
   * every session's (worker 0, for the Final settle: one state per session).
   */
  constructor(
    private readonly source: HistorySource,
    private readonly opts: { keepSessions?: number } = {},
  ) {
    const { width, height, bitDepth } = source.info;
    this.px = width * height;
    this.raw = bitDepth === 16 ? new Uint16Array(0) : new Uint8Array(0);
    this.buf = new Float32Array(this.px);
  }

  /** Discover recorded frames `start..` (in order from 0; a gap stops look-back). */
  pushRows(
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    flags: ArrayLike<number>,
    offset: ArrayLike<number>,
    gain: ArrayLike<number>,
  ): void {
    this.record.push(start, dy, dx, flags, offset, gain);
    const have = this.record.frames;
    const gap = !this.record.complete;
    this.rowWaiters = this.rowWaiters.filter((w) => {
      if (gap) w.reject(new Error('Discover has a gap in its motion record.'));
      else if (w.frame < have) w.resolve();
      else return true;
      return false;
    });
  }

  /**
   * The live back half's state after stream frame `frame` (a batch end):
   * the newest of the session that batch belongs to (blocks of that
   * session started from now on use it). Without `frame`: the first session's.
   */
  setBackState(state: Uint8Array, frame?: number): void {
    const session = frame === undefined ? 0 : this.sessionOf(Math.max(0, frame - 1));
    this.backStates.set(session, state);
    const keep = this.opts.keepSessions;
    if (keep !== undefined) {
      const newest = Math.max(...this.backStates.keys());
      for (const k of [...this.backStates.keys()])
        if (k <= newest - keep) this.backStates.delete(k);
    }
    this.backWaiters = this.backWaiters.filter((w) => {
      if (w.session !== session) return true;
      w.resolve();
      return false;
    });
  }

  /**
   * Discover re-registered session `index` (1-based within the run) by
   * `transform` (`RunRecord.noteSession`): its frames are warped by it.
   * Arrives before the rows of the session's first frame.
   */
  setSession(index: number, transform: SessionTransform): void {
    this.record.noteSession(index, transform);
    this.transforms[index] = [transform[0], transform[1], transform[2]];
    if (this.alignerSession === index) this.alignerSession = -1;
  }

  /** The session of global frame `frame` (0 for a one-session recording). */
  sessionOf(frame: number): number {
    return sessionOfFrame(this.source.info, frame);
  }

  /** The newest flat-field map (null: none known; the calibration's own stays). */
  setFlatField(map: FlatFieldMap | null): void {
    this.flat = map;
    this.flatDirty = true;
  }

  /** A library the slow loop published (applied before the next solve). */
  setLibrary(version: number, bytes: Uint8Array): void {
    if (version > this.version && version > (this.pendingLibrary?.version ?? 0))
      this.pendingLibrary = { version, bytes };
  }

  /**
   * Re-read, preprocess and solve the requested frames, in order, into
   * `out` (at least `frames.length * width * height` values). A frame with
   * `skip[i]` set is preprocessed (its block's preprocessor runs on) but not
   * solved: its traces stay 0 and must not be used.
   */
  async serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved> {
    if (out.length < frames.length * this.px)
      throw new RangeError(`look-back: a buffer of ${out.length} for ${frames.length} frames`);
    const serveT0 = performance.now();
    this.timing = emptyTiming();
    this.applyLibrary();
    const traces = new Float32Array(frames.length * this.cells);
    let background: Float32Array | undefined;
    for (let i = 0; i < frames.length; i++) {
      const { frame, block } = frames[i];
      const y = out.subarray(i * this.px, (i + 1) * this.px);
      await this.preprocess(frame, block, y);
      if (this.disposed) throw new Error('look-back stopped');
      if (!this.engine || this.cells === 0 || skip?.[i]) continue;
      const t0 = performance.now();
      traces.set(this.engine.processFrames(y, 1), i * this.cells);
      const bg = this.engine.lastBackground();
      background ??= new Float32Array(frames.length * bg.length);
      background.set(bg, i * bg.length);
      this.timing.solveMs += performance.now() - t0;
    }
    const t = this.timing;
    t.otherMs = Math.max(
      0,
      performance.now() - serveT0 - t.waitMs - t.readMs - t.preprocessMs - t.solveMs,
    );
    return {
      version: this.engine ? this.version : 0,
      cells: this.cells,
      traces,
      ...(background ? { background } : {}),
      timing: t,
    };
  }

  /** Frame `frame` of block `block`, preprocessed as Discover did (see the module docs), into `y`. */
  async preprocess(frame: number, block: number, y: Float32Array): Promise<void> {
    // Waiting for Discover's rows or state is not work; reading and preprocessing are.
    const t0 = performance.now();
    await this.rows(frame);
    const session = this.sessionOf(frame);
    const state = await this.state(session);
    const t1 = performance.now();
    const pre = this.blockPre(block, session, state);
    const front = this.frontPre(state);
    const t2 = performance.now();
    const raw = await this.rawFrame(frame);
    const t3 = performance.now();
    frontReplay(front, raw, 1, this.buf, this.record.span(frame, 1), 0);
    // Stage B of a replay: the session's re-registration first, then the rigid shift.
    this.sessionAligner(session)?.warpF32(this.buf);
    const rec = this.record.span(frame, 1);
    const motion = (this.motion ??= this.newMotion());
    motion.applyF32(this.buf, rigidRecords(motion, rec.dy, rec.dx, rec.flags, 1), y);
    pre.backFramesRegistered(y, 1, rec.dy, rec.dx);
    this.timing.waitMs += t1 - t0;
    this.timing.readMs += t3 - t2;
    this.timing.preprocessMs += t2 - t1 + (performance.now() - t3);
  }

  private rows(frame: number): Promise<void> {
    if (!this.record.complete)
      return Promise.reject(new Error('Discover has a gap in its motion record.'));
    if (frame < this.record.frames) return Promise.resolve();
    return new Promise((resolve, reject) => this.rowWaiters.push({ frame, resolve, reject }));
  }

  /** The newest back state of `session` (waits for its first). */
  private state(session: number): Promise<Uint8Array> {
    const s = this.backStates.get(session);
    if (s) return Promise.resolve(s);
    return new Promise((resolve, reject) =>
      this.backWaiters.push({
        session,
        resolve: () => resolve(this.backStates.get(session)!),
        reject,
      }),
    );
  }

  /**
   * The preprocessor of block `seq` for a frame of `session`: the one in
   * progress, or a fresh copy of the session's state (a block that crosses
   * into another session, only in the Final settle, starts again there).
   */
  private blockPre(seq: number, session: number, state: Uint8Array): Preprocessor {
    const slot = seq <= SETTLE_BLOCK_MAX ? 'settleBlock' : 'block';
    const cur = this[slot];
    if (cur?.seq === seq && cur.session === session) return cur.pre;
    cur?.pre.free();
    const pre = Preprocessor.fromState(state);
    // A state does not carry the source mask: the FOV as this session's warp moved it (stage C).
    const t = this.transforms[session];
    if (!isIdentity(t)) {
      const a = new SessionAligner(this.source.info.width, this.source.info.height);
      try {
        a.setTransform(t![0], t![1], t![2]);
        pre.setSourceMask(a.sourceMask(pre.fovMask()));
      } finally {
        a.free();
      }
    }
    this[slot] = { seq, session, pre };
    return pre;
  }

  /** The session warp of `session` (null: identity, nothing to warp). */
  private sessionAligner(session: number): SessionAligner | null {
    const t = this.transforms[session];
    if (isIdentity(t)) return null;
    const { width, height } = this.source.info;
    const a = (this.aligner ??= new SessionAligner(width, height));
    if (this.alignerSession !== session) {
      a.setTransform(t![0], t![1], t![2]);
      this.alignerSession = session;
    }
    return a;
  }

  private frontPre(state: Uint8Array): Preprocessor {
    if (!this.front) {
      this.front = Preprocessor.fromState(state);
      this.flatDirty = true;
    }
    if (this.flatDirty) {
      this.flatDirty = false;
      const m = this.flat;
      if (m) this.front.setFlatField(m.gain, m.offset.length > 0 ? m.offset : undefined, m.dark);
    }
    return this.front;
  }

  private newMotion(): MotionCorrector {
    const opts = new MotionOptions();
    try {
      return new MotionCorrector(this.source.info.width, this.source.info.height, opts);
    } finally {
      opts.free();
    }
  }

  /** One raw frame, from a span of `LOOKBACK_READ_SPAN` read at once. */
  private async rawFrame(frame: number): Promise<FramePixels> {
    if (frame < this.rawStart || frame >= this.rawStart + this.rawCount) {
      const total = this.source.info.frameCount;
      if (!(frame >= 0 && frame < total))
        throw new RangeError(`look-back: frame ${frame} of ${total}`);
      const lo = frame - (frame % LOOKBACK_READ_SPAN);
      const n = Math.min(LOOKBACK_READ_SPAN, total - lo);
      if (this.raw.length < n * this.px)
        this.raw =
          this.raw instanceof Uint16Array
            ? new Uint16Array(LOOKBACK_READ_SPAN * this.px)
            : new Uint8Array(LOOKBACK_READ_SPAN * this.px);
      this.rawCount = 0;
      const got = await this.source.readFrames(lo, n, this.raw.subarray(0, n * this.px));
      if (got.buffer !== this.raw.buffer) this.raw = got;
      this.rawStart = lo;
      this.rawCount = n;
    }
    const o = (frame - this.rawStart) * this.px;
    return this.raw.subarray(o, o + this.px);
  }

  private applyLibrary(): void {
    const p = this.pendingLibrary;
    if (!p) return;
    this.pendingLibrary = null;
    const lib = TraceLibrary.fromBytes(p.bytes);
    try {
      if (this.engine) this.engine.setLibrary(lib);
      // 0, 0: the solver's default tolerance and sweep cap (as the fast loop's engine).
      else this.engine = new TraceEngine(lib, 0, 0);
    } catch (err) {
      lib.free();
      throw err;
    }
    this.lib?.free();
    this.lib = lib;
    this.version = lib.version;
    this.cells = lib.ids().length;
  }

  /**
   * The settle delta of a chunk `serve` just answered (`frames`, `out`,
   * `solved`, `skip` as there): its solved fitting frames' footprint
   * statistics summed on `context` (`SlowLoop.settleContext()`), as bytes
   * for `SlowLoop.applySettleDelta`. `fov` (the slow loop's FOV mask)
   * comes with the first request of a run; the builder is made from it.
   * `key(i)`: the key frame `i` is summed under (default: its stream index;
   * the Final settle: the slow-loop index it will have).
   */
  settleDelta(
    frames: LookbackFrame[],
    out: Float32Array,
    solved: LookbackSolved,
    skip: ArrayLike<number> | undefined,
    context: Uint8Array,
    fov?: Uint8Array,
    key: (i: number) => number = (i) => frames[i].frame,
  ): { bytes: Uint8Array; summed: number; ms: number } {
    const t0 = performance.now();
    if (fov) {
      this.delta?.free();
      this.delta = new SettleDeltaBuilder(this.source.info.width, this.source.info.height, fov);
    }
    const b = this.delta;
    if (!b) throw new Error('settle delta: no FOV from the slow worker yet');
    b.begin(context);
    let summed = 0;
    const lib = this.lib;
    if (solved.version > 0 && solved.cells > 0 && lib && lib.version === solved.version) {
      const n = frames.length;
      const bg = solved.background;
      const nb = bg && n > 0 ? bg.length / n : 0;
      for (let i = 0; i < n; i++) {
        if (skip?.[i]) continue;
        b.push(
          out.subarray(i * this.px, (i + 1) * this.px),
          lib,
          solved.traces.subarray(i * solved.cells, (i + 1) * solved.cells),
          bg ? bg.subarray(i * nb, (i + 1) * nb) : undefined,
          key(i),
        );
        summed++;
      }
    }
    const bytes = b.finish();
    return { bytes, summed, ms: performance.now() - t0 };
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.rowWaiters) w.reject(new Error('look-back stopped'));
    this.rowWaiters = [];
    for (const w of this.backWaiters.splice(0)) w.reject(new Error('look-back stopped'));
    this.block?.pre.free();
    this.block = null;
    this.settleBlock?.pre.free();
    this.settleBlock = null;
    this.front?.free();
    this.front = null;
    this.aligner?.free();
    this.aligner = null;
    this.motion?.free();
    this.motion = null;
    this.engine?.free();
    this.engine = null;
    this.lib?.free();
    this.lib = null;
    this.delta?.free();
    this.delta = null;
    this.pendingLibrary = null;
  }
}
