/**
 * The slow loop (streaming cell discovery), inside its own worker: observes
 * every frame the fast worker forwards, returns the frame buffer, and
 * publishes each new library version to the fast worker (bytes) and to the
 * main thread (footprints for drawing).
 *
 * Tile visits (the expensive part) run either here, `budget` work units
 * after each observed frame, or, with visit workers, in parallel on those
 * workers: after every batch and every visit result the runner hands a
 * visit (`SlowLoop.takeJob`) to each idle worker and applies what comes back
 * (`applyJob`); the slow loop guarantees that visits out at the same time
 * never touch the same cells (see `discover/shard.rs`). This worker then
 * only observes, so it keeps up with the fast loop.
 *
 * Cells a history review found (`handleReviewed`) are added while no visit
 * is out, as a visit in flight does not know them: no new visit is handed
 * out until the ones out are back and the cells are in.
 *
 * Its stalls (a tile visit or a library rebuild can take 50-160 ms) only
 * delay this worker; the fast worker drops batches for it instead of waiting
 * (see `ForwardPool`).
 *
 * Look-back (experimental, `SlowInit.lookback`; the scheduler is the
 * engine's, `discover/lookback.rs`): after each observed batch of Discover
 * the runner notes what the slow loop has seen (`lookbackNote`) and, with no
 * request outstanding, hands the frames the scheduler wants re-read
 * (`lookbackTake`) to the look-back worker, which re-reads, preprocesses and
 * solves them; its answer goes into the footprint statistics only
 * (`observeLookback`). The fast loop never waits for any of it. After the
 * last frame the run settles instead of ending at once (`drainPump`, as
 * qc_eval's `LookBack::drain`): with the cell set frozen (`refine` scope),
 * look-back frames and tile visits alternate until no cell needs frames or
 * a step cap, then a last round of visits on every tile, and only then the
 * final library.
 */
import type { LookbackStatus, LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type {
  CellStatusView,
  EditScopeName,
  FastToSlow,
  LibraryView,
  OwnerToVisit,
  PortLike,
  SlowCounters,
  SlowInit,
  SlowReviewed,
  SlowStatus,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';
import { libraryViewTransferables } from '../workers/slow-types.ts';

/** What the runner needs of a published `TraceLibrary`. */
export interface PublishedLibrary {
  readonly version: number;
  ids(): Uint32Array;
  centers(): Float32Array;
  radii(): Float32Array;
  supportStarts(): Uint32Array;
  supportPixels(): Uint32Array;
  footprintValues(): Float32Array;
  toBytes(): Uint8Array;
  free(): void;
}

/** What the runner needs of the WASM `SlowLoop`. */
export interface SlowLoopLike {
  /**
   * `background`: that frame's background coefficients from the same solve;
   * `stream`: its stream index (look-back keeps its held-out decision).
   */
  observe(
    frame: Float32Array,
    version: number,
    traces: Float32Array,
    background?: Float32Array,
    stream?: number,
  ): boolean;
  step(budget: number): PublishedLibrary | undefined;
  finalize(): PublishedLibrary;
  setNoise(noise: Float32Array): void;
  /** Restrict the structural edits (absent in older fakes: a replay is refused). */
  setEditScope?(scope: string): void;
  /** Parallel visits (needed only with visit workers). */
  takeJob?(): Uint8Array | undefined;
  applyJob?(bytes: Uint8Array): void;
  housekeep?(): PublishedLibrary | undefined;
  /** Adds the candidates of a history review; returns how many (absent in older fakes). */
  addReviewed?(candidates: Float32Array): number;
  readonly cellCount: number;
  readonly reservoirBytes: number;
  /** Frames stored per tile, and why that is below target (absent in older fakes). */
  readonly framesPerTile?: number;
  readonly reservoirWarning?: string;
  /** Work spent so far, about multiply-adds (absent in older fakes). */
  readonly work?: number;
  stats(): Float64Array;
  /** `(id, established, transients)` triples (absent in older fakes). */
  cellStatus?(): Float64Array;
  // Look-back (see `SlowLoop.enableLookback`; absent in older fakes and builds).
  enableLookback?(rate: number, maxFrames: number): void;
  lookbackNote?(seen: number, frames: number): void;
  lookbackAddCredit?(frames: number): void;
  /** `[frame, block, n, id_1..id_n, ...]`; empty when the budget is spent or nothing is needed. */
  lookbackTake?(max: number): Float64Array;
  /** The last `lookbackTake` stopped because no cell needs anything. */
  readonly lookbackIdle?: boolean;
  observeLookback?(
    frame: Float32Array,
    version: number,
    traces: Float32Array,
    background: Float32Array | undefined,
    stream: number,
    ids: Float64Array,
  ): boolean;
  markAllDue?(): void;
  /** `[requested, pushed, heldOut, dropped, births, inNeed, recordBytes]`. */
  lookbackStats?(): Float64Array;
  free(): void;
}

/**
 * The validated look-back configuration (qc_eval `COMBO`): the slow-loop
 * options it runs with (the cluster history replay, joint sign rule `all`,
 * merge guard at 0.6 cell diameters), two look-back frames per Discover
 * frame, at most 3000 frames before a cell's birth.
 */
export const LOOKBACK = {
  jointUpdate: 'all',
  jointSign: 'all',
  mergeGuardMinSep: 0.6,
  rate: 2,
  maxFrames: 3000,
  /** Frames per request to the look-back worker. */
  takeMax: 16,
  /** Settling: at most this many steps (qc_eval's drain cap), ... */
  drainSteps: 4800,
  /** ... `markAllDue` and a published library every this many, ... */
  drainEvery: 64,
  /** ... then this many steps of visits on every tile. */
  settleSteps: 256,
  /** A request unanswered this long stops look-back for the run (the drain must end). */
  timeoutMs: 60_000,
} as const;

/** The constructors of `SlowLoop` or `VisitWorker` (the WASM classes, or fakes). */
export interface SlowLoopCtor<T> {
  new (
    width: number,
    height: number,
    fov: Uint8Array,
    noise: Float32Array,
    cellDiameterPx: number,
    flattenSigmaPx: number,
  ): T;
  withConfig(
    width: number,
    height: number,
    fov: Uint8Array,
    noise: Float32Array,
    cellDiameterPx: number,
    flattenSigmaPx: number,
    jointUpdate: string,
    jointSign: string,
    mergeGuardMinSep: number,
  ): T;
}

/**
 * Build a `SlowLoop` or `VisitWorker` from the slow loop's settings: the
 * plain constructor, exactly as before look-back existed, unless
 * `init.lookback`, then with the look-back options (`LOOKBACK`; a slow loop
 * and its visit workers must agree on them).
 */
export function buildSlowLoop<T>(ctor: SlowLoopCtor<T>, init: SlowInit): T {
  const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx } = init;
  if (!init.lookback) return new ctor(width, height, fov, noise, cellDiameterPx, flattenSigmaPx);
  const loop = ctor.withConfig(
    width,
    height,
    fov,
    noise,
    cellDiameterPx,
    flattenSigmaPx,
    LOOKBACK.jointUpdate,
    LOOKBACK.jointSign,
    LOOKBACK.mergeGuardMinSep,
  );
  const lb = loop as T & { enableLookback?(rate: number, maxFrames: number): void };
  lb.enableLookback?.(LOOKBACK.rate, LOOKBACK.maxFrames);
  return loop;
}

export interface SlowRunnerDeps {
  create(init: SlowInit): SlowLoopLike;
  toFast: PortLike<SlowToFast>;
  toMain: PortLike<SlowToMain>;
  /** Ports to the visit workers (none: visit tiles here). */
  visits?: PortLike<OwnerToVisit>[];
  /** Port to the look-back worker (also `connectLookback`). */
  lookback?: PortLike<SlowToLookback>;
  now?: () => number;
  /** Run `fn` as a later task (settling gives way between steps; default `setTimeout(fn, 0)`). */
  defer?: (fn: () => void) => void;
  /** Call `fn` after `ms` unless cancelled (default `setTimeout`). */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** One frame of an outstanding look-back request. */
interface LookbackItem {
  frame: number;
  ids: Float64Array;
}

/** `lookbackTake` output, split per frame. */
function lookbackItems(flat: ArrayLike<number>): LookbackItem[] {
  const out: LookbackItem[] = [];
  for (let k = 0; k + 2 < flat.length;) {
    const n = flat[k + 2];
    out.push({ frame: flat[k], ids: Float64Array.from({ length: n }, (_, j) => flat[k + 3 + j]) });
    k += 3 + n;
  }
  return out;
}

/** Settling, between Discover's last frame and the final library (`SlowRunner.drainPump`). */
interface Drain {
  /** `feed`: look-back frames and visits; `settle`: the last visits on every tile. */
  phase: 'feed' | 'settle';
  /** Steps done in the phase. */
  steps: number;
  /** A step was started and closes once its look-back frames and visits are back. */
  inStep: boolean;
  /** The step's `lookbackTake` found no cell in need: settle after it. */
  idle: boolean;
  /** Stop now (the user's Stop, or a failure): publish the final library. */
  stop: boolean;
  statusAt: number;
}

function counters(s: ArrayLike<number>): SlowCounters {
  return {
    visits: s[0] ?? 0,
    proposals: s[1] ?? 0,
    adds: s[2] ?? 0,
    rejects: s[3] ?? 0,
    merges: s[4] ?? 0,
    mergeTests: s[5] ?? 0,
    refines: s[6] ?? 0,
    commits: s[7] ?? 0,
    deletes: s[8] ?? 0,
    splits: s[9] ?? 0,
    absorbs: s[10] ?? 0,
    newAdds: s[11] ?? 0,
    reAdds: s[12] ?? 0,
    churned: s[13] ?? 0,
    establishedRemovals: s[15] ?? 0,
    reviewAdds: s[16] ?? 0,
  };
}

/** Wall time between cell-status updates to the main thread, ms. */
export const CELL_STATUS_EVERY_MS = 1000;

function cellStatusView(flat: ArrayLike<number>): CellStatusView {
  const n = Math.floor(flat.length / 3);
  const ids = new Uint32Array(n);
  const established = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = flat[3 * i];
    established[i] = flat[3 * i + 1] > 0 ? 1 : 0;
  }
  return { ids, established };
}

export class SlowRunner {
  private readonly deps: SlowRunnerDeps;
  private readonly now: () => number;
  private readonly visits: PortLike<OwnerToVisit>[];
  private session = -1;
  private loop: SlowLoopLike | null = null;
  private init: SlowInit | null = null;
  private frame = 0;
  private consumed = 0;
  private observed = 0;
  private skipped = 0;
  private version = 0;
  private final = false;
  private ending = false;
  /** Runs into this loop (1 = Discover) and the current run's scope. */
  private run = 0;
  private scope: EditScopeName = 'all';
  private statusAt = -Infinity;
  /** Per visit worker: a visit is out. */
  private busy: boolean[];
  private jobs = 0;
  private visitMsSum = 0;
  private visitMsN = 0;
  private visitMs = 0;
  /** Wall time this worker spent handing out and applying visits, ms. */
  private jobOwnerMs = 0;
  /** History-review candidates waiting for the visits out to come back. */
  private reviewed: Float32Array[] = [];
  // ---- look-back ----
  private lbPort: PortLike<SlowToLookback> | null;
  /** This run uses look-back (`SlowInit.lookback` and a loop that has it). */
  private lbOn = false;
  /** The request out to the look-back worker (at most one). */
  private lbReq: { id: number; items: LookbackItem[] } | null = null;
  private lbNextId = 1;
  private lbCancelTimer: (() => void) | null = null;
  /** Look-back stopped by an error or a timeout (Discover and settling go on without it). */
  private lbError: string | undefined;
  private drain: Drain | null = null;
  private drainSteps = 0;
  private drainCapped = false;
  private readonly defer: (fn: () => void) => void;
  private readonly timer: (fn: () => void, ms: number) => () => void;

  constructor(deps: SlowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.visits = deps.visits ?? [];
    this.busy = this.visits.map(() => false);
    this.lbPort = deps.lookback ?? null;
    this.defer = deps.defer ?? ((fn) => void setTimeout(fn, 0));
    this.timer =
      deps.timer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /** The port to the look-back worker (runs with look-back started from now on use it). */
  connectLookback(port: PortLike<SlowToLookback>): void {
    this.lbPort = port;
  }

  /** Tile visits run on visit workers. */
  private get parallel(): boolean {
    return this.visits.length > 0;
  }

  /**
   * `handle`, but a batch of frames gives way between frames (`pause`) while
   * visits are out, so their results are applied and the next visits handed
   * out without waiting for the whole batch (the slow worker's way of
   * keeping its visit workers busy while it observes; see `frames`).
   */
  async handleAsync(msg: FastToSlow, pause: () => Promise<void>): Promise<void> {
    if (msg.type !== 'frames' || msg.session !== this.session) {
      this.handle(msg);
      return;
    }
    try {
      const steps = this.frameSteps(msg);
      while (!steps.next().done) await pause();
    } catch (err) {
      this.fail(err);
    }
  }

  handle(msg: FastToSlow): void {
    if (msg.type === 'reset' || msg.type === 'init') {
      if (msg.session < this.session) return;
      this.drop();
      this.session = msg.session;
      // (An init replaces a visit worker's state too.)
      if (msg.type === 'reset')
        for (const v of this.visits) v.postMessage({ type: 'reset', session: msg.session });
      if (msg.type === 'init') {
        const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget, lookback } = msg;
        this.init = {
          width,
          height,
          fov,
          noise,
          cellDiameterPx,
          flattenSigmaPx,
          budget,
          ...(lookback ? { lookback: true } : {}),
        };
        this.loop = this.deps.create(this.init);
        this.run = 1;
        this.lbOn = lookback === true && typeof this.loop.lookbackTake === 'function';
        if (this.lbOn && !this.lbPort) this.lbError = 'The look-back worker is not connected.';
        for (const v of this.visits)
          v.postMessage({ type: 'init', session: msg.session, ...this.init });
      }
      return;
    }
    if (msg.session !== this.session) return;
    try {
      if (msg.type === 'frames') this.frames(msg);
      else if (msg.type === 'end') this.end();
      else if (msg.type === 'replay') this.replay(msg.scope);
    } catch (err) {
      this.fail(err);
    }
  }

  /** What a history review found, from the main thread. */
  handleReviewed(msg: SlowReviewed): void {
    if (msg.session !== this.session || !this.loop || this.ending || this.final || this.drain)
      return;
    try {
      this.reviewed.push(msg.candidates);
      this.addReviewed();
      this.dispatch();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Add the waiting history-review candidates, once no visit is out. */
  private addReviewed(): void {
    const loop = this.loop;
    if (!loop || this.reviewed.length === 0 || this.busy.some((b) => b)) return;
    for (const candidates of this.reviewed.splice(0)) loop.addReviewed?.(candidates);
  }

  /** A message from visit worker `i`. */
  handleVisit(i: number, msg: VisitToOwner): void {
    if (msg.session !== this.session || !this.loop) return;
    try {
      if (msg.type === 'error') throw new Error(`visit worker ${i}: ${msg.message}`);
      this.busy[i] = false;
      const t0 = this.now();
      this.loop.applyJob!(msg.bytes);
      this.jobOwnerMs += this.now() - t0;
      this.jobs++;
      this.visitMsSum += msg.ms;
      this.visitMsN++;
      this.housekeep();
      if (this.drain) {
        if (!this.busy.some((b) => b)) this.drainPump();
      } else if (this.ending) {
        if (!this.busy.some((b) => b)) this.finish();
      } else {
        this.addReviewed();
        this.dispatch();
      }
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session: this.session,
      message: err instanceof Error ? err.message : String(err),
    });
    this.drop();
  }

  private frames(msg: Extract<FastToSlow, { type: 'frames' }>): void {
    for (const _ of this.frameSteps(msg));
  }

  /**
   * Observe a batch. With visit workers, in a Refine run, it yields after
   * each frame while a visit is out: the caller may then let visit results
   * in (`handleAsync`).
   * Without that, a result waited for the whole batch, and once the frames
   * came as fast as the slow worker could observe them (Refine, which never
   * drops a batch) its visit workers sat idle and a Refine run made a few
   * times fewer visits per frame.
   */
  private *frameSteps(msg: Extract<FastToSlow, { type: 'frames' }>): Generator<void, void> {
    const loop = this.loop;
    const init = this.init;
    let observed = 0;
    let maxStep = 0;
    const t0 = this.now();
    try {
      if (loop && init) {
        if (msg.noise) {
          loop.setNoise(msg.noise);
          for (const v of this.visits)
            v.postMessage({ type: 'noise', session: this.session, noise: msg.noise });
        }
        const px = init.width * init.height;
        const bg = msg.background;
        const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
        for (let i = 0; i < msg.count; i++) {
          const frame = msg.frames.subarray(i * px, (i + 1) * px);
          const traces = msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells);
          const background = bg?.subarray(i * nb, (i + 1) * nb);
          // The stream index records the frame's held-out decision for look-back
          // (required with it on); without look-back the call is as before.
          const stream = this.lbOn ? msg.start + i : undefined;
          if (!loop.observe(frame, msg.version, traces, background, stream)) {
            this.skipped++;
            continue;
          }
          observed++;
          this.observed++;
          this.frame = msg.start + i + 1;
          if (this.parallel) {
            // Refine only: Discover keeps its timing (it drops batches instead).
            if (this.scope !== 'all' && i + 1 < msg.count && this.busy.some((b) => b)) {
              yield;
              // A visit result failed meanwhile and dropped the loop.
              if (this.loop !== loop) break;
            }
            continue;
          }
          const s = this.now();
          const lib = loop.step(init.budget);
          maxStep = Math.max(maxStep, this.now() - s);
          if (lib) this.publish(lib);
        }
        if (this.parallel) {
          const s = this.now();
          this.housekeep();
          maxStep = this.now() - s;
          this.dispatch();
        }
        if (this.lookbackLive) {
          loop.lookbackNote!(msg.start + msg.count, observed);
          this.lookbackRequest();
        }
      }
    } finally {
      this.consumed = Math.max(this.consumed, msg.start + msg.count);
      // The buffer always goes back, or the fast worker's pool would shrink.
      this.deps.toFast.postMessage(
        {
          type: 'ack',
          session: msg.session,
          frames: msg.frames,
          start: msg.start,
          count: msg.count,
          observed,
        },
        [msg.frames.buffer as ArrayBuffer],
      );
    }
    this.status(this.now() - t0, maxStep);
  }

  /** Trimming decisions and, when due, a new library (parallel mode). */
  private housekeep(): void {
    const lib = this.loop?.housekeep!();
    if (lib) this.publish(lib);
  }

  /** A tile visit to every idle visit worker, while any is due; returns how many were handed out. */
  private dispatch(): number {
    const loop = this.loop;
    // Reviewed cells wait for the visits out: hand out no new one meanwhile.
    if (!loop || this.ending || this.reviewed.length > 0) return 0;
    let handed = 0;
    for (let i = 0; i < this.visits.length; i++) {
      if (this.busy[i]) continue;
      const t0 = this.now();
      const bytes = loop.takeJob!();
      if (!bytes) break;
      this.busy[i] = true;
      handed++;
      this.visits[i].postMessage({ type: 'job', session: this.session, bytes }, [
        bytes.buffer as ArrayBuffer,
      ]);
      this.jobOwnerMs += this.now() - t0;
    }
    return handed;
  }

  // ---- look-back ----

  /** Discover is running (not settling, not a Refine run) and look-back works. */
  private get lookbackLive(): boolean {
    return (
      this.lbOn &&
      this.lbError === undefined &&
      this.run === 1 &&
      !this.final &&
      !this.ending &&
      this.drain === null
    );
  }

  /**
   * With no request out, hand the frames the scheduler wants now (budget
   * permitting) to the look-back worker. Returns whether a request went out.
   */
  private lookbackRequest(): boolean {
    const loop = this.loop;
    const port = this.lbPort;
    if (!loop || !port || !this.lbOn || this.lbError !== undefined || this.lbReq) return false;
    const flat = loop.lookbackTake!(LOOKBACK.takeMax);
    if (flat.length === 0) return false;
    const items = lookbackItems(flat);
    const id = this.lbNextId++;
    this.lbReq = { id, items };
    // A fresh array from WASM: transferred as is.
    port.postMessage({ type: 'request', session: this.session, id, items: flat }, [
      flat.buffer as ArrayBuffer,
    ]);
    this.lbCancelTimer = this.timer(() => {
      if (this.lbReq?.id !== id) return;
      this.lbCancelTimer = null;
      this.lbReq = null;
      this.lookbackFailed(`no answer within ${LOOKBACK.timeoutMs / 1000} s`);
      if (this.drain) this.drainPump();
    }, LOOKBACK.timeoutMs);
    return true;
  }

  /** Look-back is off for the rest of this run; Discover and settling go on. */
  private lookbackFailed(message: string): void {
    if (this.lbError !== undefined) return;
    this.lbError = message;
    console.warn(`cala look-back stopped: ${message}`);
    this.status(0, 0);
  }

  /** An answer from the look-back worker: its frames go into the footprint statistics. */
  handleLookback(msg: LookbackToSlow): void {
    const loop = this.loop;
    const req = this.lbReq;
    if (msg.session !== this.session || !loop || !req || msg.id !== req.id) {
      // An ignored answer still returns its buffer to the worker's pool (which drops a stale session's).
      if (msg.type === 'frames')
        this.lbPort?.postMessage({ type: 'release', session: msg.session, frames: msg.frames }, [
          msg.frames.buffer as ArrayBuffer,
        ]);
      return;
    }
    this.lbReq = null;
    this.lbCancelTimer?.();
    this.lbCancelTimer = null;
    try {
      if (msg.type === 'error') this.lookbackFailed(msg.message);
      else {
        this.observeLookback(loop, msg, req.items);
        // The buffer goes back to the look-back worker's pool (never detached here).
        this.lbPort?.postMessage({ type: 'release', session: this.session, frames: msg.frames }, [
          msg.frames.buffer as ArrayBuffer,
        ]);
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.drain) this.drainPump();
    else if (this.lookbackLive) this.lookbackRequest();
  }

  private observeLookback(
    loop: SlowLoopLike,
    msg: Extract<LookbackToSlow, { type: 'frames' }>,
    items: LookbackItem[],
  ): void {
    const init = this.init;
    // Version 0: the worker had no library yet, nothing was solved.
    if (!init || msg.version === 0) return;
    if (msg.count !== items.length)
      throw new Error(`look-back: ${msg.count} frames for a request of ${items.length}`);
    const px = init.width * init.height;
    const bg = msg.background;
    const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
    for (let i = 0; i < msg.count; i++) {
      loop.observeLookback!(
        msg.frames.subarray(i * px, (i + 1) * px),
        msg.version,
        msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
        bg?.subarray(i * nb, (i + 1) * nb),
        items[i].frame,
        items[i].ids,
      );
    }
  }

  /** The user's "Stop settling": publish the final library now, with what was refined. */
  stopSettling(session: number): void {
    const d = this.drain;
    if (session !== this.session || !d) return;
    d.stop = true;
    // A request out is not waited for (its late answer is ignored).
    if (this.lbReq) {
      this.lbReq = null;
      this.lbCancelTimer?.();
      this.lbCancelTimer = null;
    }
    this.drainPump();
  }

  /** Discover's last frame with look-back on: settle (see `drainPump`). */
  private startDrain(): void {
    const loop = this.loop!;
    loop.setEditScope?.('refine');
    this.scope = 'refine';
    // Review candidates would wait for every visit out; Discover is over.
    this.reviewed = [];
    this.drain = {
      phase: 'feed',
      steps: 0,
      inStep: false,
      idle: false,
      stop: false,
      statusAt: this.now(),
    };
    this.status(0, 0);
    this.drainPump();
  }

  /**
   * Settling, one step at a time (qc_eval's `LookBack::drain`): with the
   * cell set frozen (`refine` scope), each step adds `LOOKBACK.rate` frames
   * of look-back budget and hands what it buys to the look-back worker,
   * marks every tile due every `drainEvery` steps, and runs one round of
   * slow work (a `step`, or a visit to each idle visit worker); every
   * `drainEvery` steps the library is published. It stops when no cell
   * needs frames or at `drainSteps`, then visits every tile once more
   * (`settleSteps`) and publishes the final library. A step closes when its
   * look-back answer and its visits are back (they call this again), and
   * the next one starts as a later task, so a Stop or a reset gets in.
   */
  private drainPump(): void {
    const d = this.drain;
    const loop = this.loop;
    const init = this.init;
    if (!d || !loop || !init) return;
    if (this.lbReq || this.busy.some((b) => b)) return;
    if (d.inStep) {
      d.inStep = false;
      if (this.parallel) this.housekeep();
      d.steps++;
      if (d.phase === 'feed') {
        this.drainSteps = d.steps;
        if (d.steps % LOOKBACK.drainEvery === 0) this.publish(loop.finalize());
      }
      if (this.now() - d.statusAt >= 250) {
        d.statusAt = this.now();
        this.status(0, 0);
      }
      if (d.phase === 'feed' && d.idle) this.settle(loop);
    }
    if (d.stop) {
      this.finishDrain();
      return;
    }
    if (d.phase === 'feed' && d.steps >= LOOKBACK.drainSteps) {
      this.drainCapped = (loop.lookbackStats?.()[5] ?? 0) > 0;
      this.settle(loop);
    }
    d.inStep = true;
    if (d.phase === 'feed') {
      loop.lookbackAddCredit!(LOOKBACK.rate);
      const sent = this.lookbackRequest();
      d.idle = !sent && (this.lbError !== undefined || !this.lbPort || loop.lookbackIdle === true);
      if (d.steps % LOOKBACK.drainEvery === 0) loop.markAllDue!();
      this.drainWork(loop, init.budget);
    } else {
      if (d.steps >= LOOKBACK.settleSteps) {
        this.finishDrain();
        return;
      }
      // With visit workers: done once no tile is due.
      if (this.drainWork(loop, init.budget) === 0 && this.parallel) {
        this.finishDrain();
        return;
      }
    }
    if (!this.lbReq && !this.busy.some((b) => b))
      this.defer(() => {
        if (this.drain === d) this.drainPump();
      });
  }

  /** One round of slow work: a step here, or a visit to each idle visit worker (returns how many). */
  private drainWork(loop: SlowLoopLike, budget: number): number {
    if (this.parallel) return this.dispatch();
    const lib = loop.step(budget);
    if (lib) this.publish(lib);
    return 1;
  }

  /** The last visits on every tile (qc_eval: `mark_all_due` and 256 steps). */
  private settle(loop: SlowLoopLike): void {
    const d = this.drain!;
    d.phase = 'settle';
    d.steps = 0;
    loop.markAllDue!();
  }

  private finishDrain(): void {
    this.drain = null;
    this.finish();
  }

  /** Another run from frame 0 into this loop (see `FastToSlow` `replay`). */
  private replay(scope: EditScopeName): void {
    const loop = this.loop;
    if (!loop) throw new Error('No slow loop to refine: run Discover first.');
    if (!this.final) throw new Error('The slow loop has not published its final library yet.');
    if (!loop.setEditScope) throw new Error('This build of the slow loop cannot refine.');
    loop.setEditScope(scope);
    this.scope = scope;
    this.run++;
    this.final = false;
    this.ending = false;
    this.frame = 0;
    this.consumed = 0;
    this.status(0, 0);
  }

  private end(): void {
    const loop = this.loop;
    if (!loop || this.final || this.ending || this.drain) return;
    // A look-back Discover settles first (`drainPump`).
    if (this.lbOn && this.run === 1) {
      this.startDrain();
      return;
    }
    // Visits out still come back and are applied before the final library.
    this.ending = true;
    if (!this.busy.some((b) => b)) this.finish();
  }

  private finish(): void {
    const loop = this.loop;
    if (!loop || this.final) return;
    this.final = true;
    this.publish(loop.finalize());
    this.status(0, 0);
  }

  private publish(lib: PublishedLibrary): void {
    try {
      const version = lib.version;
      if (version !== this.version) {
        this.version = version;
        const bytes = lib.toBytes();
        // The main thread keeps the newest library's bytes for pass 2.
        const mainBytes = bytes.slice();
        // The look-back worker solves with the newest library (same port as its requests,
        // so it always has the version a request was taken with).
        if (this.lbOn && this.lbPort && !this.lbError) {
          const lbBytes = bytes.slice();
          this.lbPort.postMessage(
            { type: 'library', session: this.session, version, bytes: lbBytes },
            [lbBytes.buffer as ArrayBuffer],
          );
        }
        this.deps.toFast.postMessage({ type: 'library', session: this.session, version, bytes }, [
          bytes.buffer as ArrayBuffer,
        ]);
        const init = this.init!;
        const library: LibraryView = {
          version,
          frame: this.frame,
          width: init.width,
          height: init.height,
          ids: lib.ids(),
          centers: lib.centers(),
          radii: lib.radii(),
          starts: lib.supportStarts(),
          pixels: lib.supportPixels(),
          values: lib.footprintValues(),
        };
        this.deps.toMain.postMessage(
          { type: 'library', session: this.session, library, bytes: mainBytes },
          libraryViewTransferables(library, mainBytes),
        );
      }
    } finally {
      lib.free();
    }
  }

  private lookbackStatus(loop: SlowLoopLike): LookbackStatus {
    const s = loop.lookbackStats?.() ?? new Float64Array(0);
    return {
      requested: s[0] ?? 0,
      pushed: s[1] ?? 0,
      heldOut: s[2] ?? 0,
      dropped: s[3] ?? 0,
      births: s[4] ?? 0,
      inNeed: s[5] ?? 0,
      recordBytes: s[6] ?? 0,
      settling: this.drain !== null,
      drainSteps: this.drainSteps,
      capped: this.drainCapped,
      ...(this.lbError !== undefined ? { error: this.lbError } : {}),
    };
  }

  private status(batchMs: number, maxStepMs: number): void {
    const loop = this.loop;
    if (!loop) return;
    const status: SlowStatus = {
      frame: this.frame,
      consumed: this.consumed,
      observed: this.observed,
      skipped: this.skipped,
      cells: loop.cellCount,
      version: this.version,
      counters: counters(loop.stats()),
      reservoirBytes: loop.reservoirBytes,
      framesPerTile: loop.framesPerTile ?? 0,
      reservoirWarning: loop.reservoirWarning,
      batchMs,
      maxStepMs,
      visitWorkers: this.visits.length,
      jobs: this.jobs,
      jobsInFlight: this.busy.filter((b) => b).length,
      visitMs: this.visitMsN > 0 ? this.visitMsSum / this.visitMsN : this.visitMs,
      jobOwnerMs: this.jobOwnerMs,
      work: loop.work ?? 0,
      final: this.final,
      run: this.run,
      editScope: this.scope,
      ...(this.lbOn ? { lookback: this.lookbackStatus(loop) } : {}),
    };
    this.visitMs = status.visitMs;
    this.visitMsSum = 0;
    this.visitMsN = 0;
    const t = this.now();
    const transfer: Transferable[] = [];
    if (loop.cellStatus && (this.final || t - this.statusAt >= CELL_STATUS_EVERY_MS)) {
      this.statusAt = t;
      const view = cellStatusView(loop.cellStatus());
      status.cellStatus = view;
      transfer.push(view.ids.buffer as ArrayBuffer, view.established.buffer as ArrayBuffer);
    }
    this.deps.toMain.postMessage({ type: 'status', session: this.session, status }, transfer);
  }

  private drop(): void {
    this.loop?.free();
    this.loop = null;
    this.init = null;
    this.frame = 0;
    this.consumed = 0;
    this.observed = 0;
    this.skipped = 0;
    this.version = 0;
    this.final = false;
    this.ending = false;
    this.run = 0;
    this.scope = 'all';
    this.statusAt = -Infinity;
    this.busy = this.visits.map(() => false);
    this.jobs = 0;
    this.visitMsSum = 0;
    this.visitMsN = 0;
    this.visitMs = 0;
    this.jobOwnerMs = 0;
    this.reviewed = [];
    this.lbCancelTimer?.();
    this.lbCancelTimer = null;
    this.lbOn = false;
    this.lbReq = null;
    this.lbError = undefined;
    this.drain = null;
    this.drainSteps = 0;
    this.drainCapped = false;
  }
}
