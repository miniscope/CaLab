/**
 * Look-back's frame supply (the look-back worker's core):
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
 *    later time (qc_eval: the current state, exactly). The end settle reads
 *    only after Discover's last state and flat-field map are in (`final`,
 *    `LookbackService`), so its blocks all start from the final state.
 *  - The flat field is the newest map for every frame; Discover corrected
 *    frames before its first map not at all, and later ones with the map of
 *    their time (the same choice as Extract).
 *  - A repeatable run's request names "newest" as of the batch end it was
 *    issued at (`LookbackPins`: the snapshot and the map in force there), so
 *    it does not depend on what reached this worker before its turn.
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
 * the one Discover reads sequentially), so any raw-frame store implementing
 * the interface can serve it. The recorded motion and flicker arrive as
 * Discover records them (`pushRows`); a request for a frame not recorded yet
 * waits for its row.
 */
import {
  MotionCorrector,
  Preprocessor,
  SessionAligner,
  TraceEngine,
  TraceLibrary,
} from './cala-wasm.ts';
import type { FlatFieldMap } from './flat-field.ts';
import { paramsHandle } from './params-handle.ts';
import { sessionOfFrame, type FrameSourceInfo, type FramePixels } from './frame-source.ts';
import { frontReplay, rigidRecords } from './pipeline-stages.ts';
import { RunRecord } from './run-record.ts';
import type { SessionTransform } from './session-boundary.ts';
import type { LookbackTiming } from './work-meter.ts';
import type { LookbackPins } from '../workers/lookback-types.ts';

/**
 * Where look-back reads raw frames from: a recording's `FrameSource`, or
 * any history store. Frames are global stream indices; a Joint run's
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

/**
 * Libraries kept in hand before they are applied. A repeatable run's request names the version
 * it is solved with and waits behind at most `APPLY_LAG_BATCHES - 1` others, a batch apart, so a
 * few are enough.
 */
const PENDING_LIBRARIES_MAX = 8;

/**
 * Back-state snapshots and flat-field maps kept for pinned requests: a request names the newest at
 * the batch end it was issued at, and waits behind at most a couple of batches of others.
 */
const SNAPSHOTS_KEPT = 4;
const MAPS_KEPT = 4;

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

/** Frames `LookbackReader.prepare` read and preprocessed, waiting for `solve`. */
export interface LookbackPrepared {
  count: number;
  /** The caller's buffer, holding the preprocessed frames. */
  out: Float32Array;
  /** The read and preprocessing time so far. */
  timing: LookbackTiming;
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
  /** Per session, its newest few snapshots by stream frame (a pinned request names one). */
  private snapshots = new Map<number, Map<number, Uint8Array>>();
  /** Maps by seq (a pinned request names one), and the seq of the newest. */
  private flats = new Map<number, FlatFieldMap | null>();
  private flatNewest = 0;
  /** The seq of the map the front half has, and the pins of the request being prepared. */
  private frontSeq = -1;
  private pins: LookbackPins | null = null;
  /** Waiting for a snapshot or a map a pinned request names. */
  private pinWaiters: { ready: () => boolean; resolve: () => void; reject: (e: Error) => void }[] =
    [];
  private backWaiters: { session: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  /** Session re-registrations Discover applied (by session index; absent: identity). */
  private readonly transforms: (SessionTransform | undefined)[] = [];
  /** The session warp (made on the first session with a transform), and the session it is set for. */
  private aligner: SessionAligner | null = null;
  private alignerSession = -1;
  private flat: FlatFieldMap | null = null;
  private flatDirty = false;
  private params: string | null = null;
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
  private version = 0;
  private cells = 0;
  /** Libraries not applied yet, oldest first (`applyLibrary` may stop at a version before the newest). */
  private pendingLibraries: { version: number; bytes: Uint8Array }[] = [];
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
    if (frame !== undefined) {
      const kept = this.snapshots.get(session) ?? new Map<number, Uint8Array>();
      kept.set(frame, state);
      for (const k of [...kept.keys()].sort((a, b) => a - b).slice(0, -SNAPSHOTS_KEPT))
        kept.delete(k);
      this.snapshots.set(session, kept);
    }
    const keep = this.opts.keepSessions;
    if (keep !== undefined) {
      const newest = Math.max(...this.backStates.keys());
      for (const k of [...this.backStates.keys()])
        if (k <= newest - keep) {
          this.backStates.delete(k);
          this.snapshots.delete(k);
        }
    }
    this.wakePins();
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

  /**
   * A flat-field map (null: none known; the calibration's own stays) and its seq (0: the map in
   * force from the first frame). An unpinned request uses the newest; a pinned one the seq it names.
   */
  setFlatField(map: FlatFieldMap | null, seq = this.flatNewest + 1): void {
    this.flats.set(seq, map);
    for (const k of [...this.flats.keys()].sort((a, b) => a - b).slice(0, -MAPS_KEPT))
      this.flats.delete(k);
    if (seq >= this.flatNewest) {
      this.flatNewest = seq;
      this.flat = map;
      this.flatDirty = true;
    }
    this.wakePins();
  }

  private wakePins(): void {
    this.pinWaiters = this.pinWaiters.filter((w) => {
      if (!w.ready()) return true;
      w.resolve();
      return false;
    });
  }

  /** Resolves once `ready()` holds (re-checked as snapshots and maps arrive). */
  private untilPinned(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => this.pinWaiters.push({ ready, resolve, reject }));
  }

  /** A library the slow loop published (applied before the next solve). */
  setLibrary(version: number, bytes: Uint8Array): void {
    if (version <= (this.pendingLibraries.at(-1)?.version ?? this.version)) return;
    this.pendingLibraries.push({ version, bytes });
    // A worker asked nothing for a while: only the newest few can still be named by a request.
    if (this.pendingLibraries.length > PENDING_LIBRARIES_MAX) this.pendingLibraries.shift();
  }

  /**
   * Re-read, preprocess and solve the requested frames, in order, into
   * `out` (at least `frames.length * width * height` values). A frame with
   * `skip[i]` set is preprocessed (its block's preprocessor runs on) but not
   * solved: its traces stay 0 and must not be used. The libraries in hand
   * when it starts are the ones it solves with.
   */
  async serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved> {
    this.applyLibrary();
    return this.solve(await this.prepare(frames, out), skip);
  }

  /**
   * The first half of `serve`: re-read and preprocess the frames into `out`.
   * Nothing here reads the library, so a request can be prepared ahead and
   * solved later (`solve`) with the library it is due.
   */
  async prepare(
    frames: LookbackFrame[],
    out: Float32Array,
    pins?: LookbackPins,
  ): Promise<LookbackPrepared> {
    if (out.length < frames.length * this.px)
      throw new RangeError(`look-back: a buffer of ${out.length} for ${frames.length} frames`);
    const t0 = performance.now();
    this.timing = emptyTiming();
    this.pins = pins ?? null;
    for (let i = 0; i < frames.length; i++) {
      const { frame, block } = frames[i];
      await this.preprocess(frame, block, out.subarray(i * this.px, (i + 1) * this.px));
      if (this.disposed) throw new Error('look-back stopped');
    }
    const t = this.timing;
    t.otherMs = Math.max(0, performance.now() - t0 - t.waitMs - t.readMs - t.preprocessMs);
    return { count: frames.length, out, timing: t };
  }

  /**
   * The second half of `serve`: solve prepared frames with the engine's
   * library (`applyLibrary` decides which). Synchronous, so no message comes
   * in between its frames.
   */
  solve(p: LookbackPrepared, skip?: ArrayLike<number>): LookbackSolved {
    const t0 = performance.now();
    const t = { ...p.timing };
    const traces = new Float32Array(p.count * this.cells);
    let background: Float32Array | undefined;
    for (let i = 0; i < p.count; i++) {
      if (!this.engine || this.cells === 0 || skip?.[i]) continue;
      const y = p.out.subarray(i * this.px, (i + 1) * this.px);
      const ts = performance.now();
      traces.set(this.engine.processFrames(y, 1), i * this.cells);
      const bg = this.engine.lastBackground();
      background ??= new Float32Array(p.count * bg.length);
      background.set(bg, i * bg.length);
      t.solveMs += performance.now() - ts;
    }
    t.otherMs += Math.max(0, performance.now() - t0 - t.solveMs + p.timing.solveMs);
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
    const pinned = await this.pinnedState(session);
    await this.pinnedFlat();
    const t1 = performance.now();
    const pre = this.blockPre(block, session, pinned ?? state);
    const front = this.frontPre(pinned ?? state);
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
   * A pinned request (`LookbackPins.state`) on a frame of the pinned snapshot's session: that
   * snapshot (waited for). Null: not pinned, or a frame of another session (its newest state).
   */
  private async pinnedState(session: number): Promise<Uint8Array | null> {
    const p = this.pins;
    if (!p || p.state <= 0 || this.sessionOf(p.state - 1) !== session) return null;
    const kept = () => this.snapshots.get(session);
    // (Already dropped as too old: the oldest kept, with a warning; it cannot happen within the
    // few batches a request waits.)
    const passed = () => Math.min(...(kept()?.keys() ?? [])) > p.state;
    await this.untilPinned(() => kept()?.has(p.state) === true || passed());
    const exact = kept()!.get(p.state);
    if (exact) return exact;
    console.warn(`cala look-back: back state of frame ${p.state} no longer kept`);
    return kept()!.get(Math.min(...kept()!.keys()))!;
  }

  /** A pinned request (`LookbackPins.flat`): waits for the map it names. */
  private async pinnedFlat(): Promise<void> {
    const p = this.pins;
    if (p) await this.untilPinned(() => this.flats.has(p.flat) || p.flat === 0);
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

  /**
   * The front half with the map the request uses: the one it pins, else the newest. A map
   * cannot be taken off a preprocessor, so going to an older one (or to none) starts afresh.
   */
  private frontPre(state: Uint8Array): Preprocessor {
    const p = this.pins;
    const seq = p ? p.flat : this.flatNewest;
    const map = p ? (this.flats.get(p.flat) ?? null) : this.flat;
    if (this.front && (seq < this.frontSeq || (p && !map && this.frontSeq > 0))) {
      this.front.free();
      this.front = null;
    }
    if (!this.front) {
      this.front = Preprocessor.fromState(state);
      this.flatDirty = true;
      this.frontSeq = -1;
    }
    if (this.flatDirty || seq !== this.frontSeq) {
      this.flatDirty = false;
      this.frontSeq = seq;
      if (map)
        this.front.setFlatField(map.gain, map.offset.length > 0 ? map.offset : undefined, map.dark);
    }
    return this.front;
  }

  /** The run's resolved params (`setParams`); no frame is served before they arrive. */
  setParams(params: string): void {
    this.params = params;
  }

  private runParams(): string {
    if (this.params === null) throw new Error("look-back: the run's params have not arrived.");
    return this.params;
  }

  private newMotion(): MotionCorrector {
    const { width, height } = this.source.info;
    return new MotionCorrector(width, height, paramsHandle(this.runParams()));
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

  /**
   * Make the newest library in hand (`setLibrary`) the one the next `solve` uses, or with `upTo`
   * the newest up to that version (a newer one stays in hand for a later request).
   */
  applyLibrary(upTo = Infinity): void {
    let p: { version: number; bytes: Uint8Array } | undefined;
    while (this.pendingLibraries.length > 0 && this.pendingLibraries[0].version <= upTo)
      p = this.pendingLibraries.shift();
    if (!p) return;
    const lib = TraceLibrary.fromBytes(p.bytes);
    try {
      if (this.engine) this.engine.setLibrary(lib);
      else this.engine = new TraceEngine(lib, paramsHandle(this.runParams()));
      this.version = lib.version;
      this.cells = lib.ids().length;
    } finally {
      lib.free();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.rowWaiters) w.reject(new Error('look-back stopped'));
    this.rowWaiters = [];
    for (const w of this.backWaiters.splice(0)) w.reject(new Error('look-back stopped'));
    for (const w of this.pinWaiters.splice(0)) w.reject(new Error('look-back stopped'));
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
    this.pendingLibraries = [];
  }
}
