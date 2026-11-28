/**
 * The slow loop (streaming cell discovery), inside its own worker: observes
 * every frame the fast worker forwards, returns the frame buffer, and
 * publishes each library version to the fast worker (bytes) and to the
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
 * Its stalls (a tile visit or a library rebuild) only
 * delay this worker; the fast worker drops batches for it instead of waiting
 * (see `ForwardPool`).
 *
 * Look-back (`SlowInit.lookback`; the scheduler is the
 * engine's, `discover/lookback.rs`): after each observed batch of Discover
 * the runner notes what the slow loop has seen (`lookbackNote`) and, with no
 * request outstanding, hands the frames the scheduler wants re-read
 * (`lookbackTake`) to the look-back worker, which re-reads, preprocesses and
 * solves them; its answer goes into the footprint statistics only
 * (`observeLookback`). The fast loop never waits for any of it. After the
 * last frame the run settles instead of ending at once, as part of Discover,
 * with the cell set frozen (`refine` scope): the settle pass (`settle.ts`,
 * qc_eval's `--settle-frames N --settle-batch 16`) has the look-back worker
 * re-read the recording once (at most `SETTLE.maxFrames` frames) and feeds
 * every frame to the ordinary `observe`, as a Refine pass does, with the
 * visits those frames earn; then a last round of visits on every tile, and
 * only then the final library.
 *
 * The Final settle's pacing, relay and pooled reads: `FinalSettleDriver`
 * (`final-settle-driver.ts`). Background settle, during Discover:
 * `BgSettleDriver` (`bg-settle-driver.ts`).
 *
 * Look-back pool (`setSettlePool`; S from the core count, `settlePoolSize`):
 * with S more look-back workers in the run (ports 1..S), worker 0 does
 * need-driven look-back and the Final settle only, and workers 1..S take the
 * settle's chunks, one request out per worker. A pool worker joins a run
 * when the main thread says so (it may be mid-run; the main thread waits
 * until the worker has the run's back state) and serves from the library sent
 * to it at once (the current one) or later. A pool worker that fails is left out for the rest of
 * the run; with none left the settle takes turns on worker 0 again. The end
 * settle runs on worker 0 alone, except on a recording's factors
 * (`?factors=file`/`gpu`): there every worker in the run's pool switches to
 * the factors too (before its first settle request, or as it joins) and the
 * end settle's requests go to workers 0..S, one out per worker; a failed pool
 * worker's request goes back to the settle's feed for the others (with no
 * worker left, the settle ends with the frames fed so far: `fed < total`).
 * The pooled Final settle is order-dependent: answers are observed in the
 * order they complete, so footprints can differ slightly from run to run;
 * each pool worker keeps its own factor cache.
 *
 * A repeatable run (`SlowInit.repeatable`, while paced, in Discover): visits and Discover's
 * look-back requests go out at batch ends only, and what comes back is held and applied at a
 * fixed later batch end in the order it went out (`ApplyBarrier`); this worker waits there for
 * anything late. Libraries are published at batch ends only and stamped with that batch's last
 * frame, so the fast loop adopts each at a fixed frame (`FastLoop.adoptFrame`). At Discover's
 * end the visits out are applied in order and look-back answers not yet applied are dropped.
 */
import type {
  CsettleStatus,
  FactorSource,
  LookbackStatus,
  LookbackToSlow,
  SettleStatus,
  SlowToLookback,
} from '../workers/lookback-types.ts';
import type {
  EditScopeName,
  FastToSlow,
  LibraryView,
  OwnerToVisit,
  PortLike,
  SlowFactors,
  SlowInit,
  SlowReviewed,
  SlowStatus,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';
import { libraryViewTransferables, visitRateCounters } from '../workers/slow-types.ts';
import { ApplyBarrier } from './apply-barrier.ts';
import { DetLog, fnvBytes } from './detlog.ts';
import { errMsg } from './errors.ts';
import { BgSettleDriver, type BgSettleHost, type BgSettle } from './bg-settle-driver.ts';
import { FinalSettleDriver, type FinalSettleHost, type Settle } from './final-settle-driver.ts';
import { normalizeRunCells } from './run-cells.ts';
import {
  cellStatusView,
  counters,
  bgSettleStatus,
  lookbackStatus,
  settleView,
  waitView,
  workStatus,
} from './slow-status.ts';
import { CSETTLE } from './settle.ts';
import {
  addLookbackAnswer,
  DetailTimer,
  DutyClock,
  emptyLookbackWork,
  SLOW_DUTIES,
  WindowMax,
  type LookbackKind,
  type LookbackTiming,
  type LookbackWork,
  type SlowDuty,
  type WorkStatus,
} from './work-meter.ts';

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

/**
 * What the runner needs of the WASM `SlowLoop` (`crates/cala/src/discover/js.rs`): every
 * member is required, as the WASM class has them all; test fakes start from `stubSlowLoop`.
 */
export interface SlowLoopLike {
  /** Measurement only: the WASM stage timers (`SlowLoop.stageTiming`; the last entry is 1 when built with feature `timing`). */
  stageTiming(): Float64Array | number[];
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
  /** Restrict the structural edits. */
  setEditScope(scope: string): void;
  /** The Discover visit rate's schedule: Auto (`true`) or fixed. */
  setVisitSchedule(auto: boolean): void;
  /** The schedule's parameters (`visitRateCounters`' `schedule`; empty: none). */
  visitSchedule(): Float64Array | number[];
  /** `[rate, credit, frames, visits, cappedFrames, dueTiles, earned, target, holdFloor, auto, rung, yieldSlow, yieldFast, fedVisits, fedNew, rungChanges]` (`visitRateCounters`). */
  visitRateStats(): Float64Array | number[];
  /** Parallel visits (used only with visit workers). */
  takeJob(): Uint8Array | undefined;
  applyJob(bytes: Uint8Array): void;
  housekeep(): PublishedLibrary | undefined;
  /** The last published library without publishing (none before the first). */
  publishedLibrary(): PublishedLibrary | undefined;
  /** Adds the candidates of a history review; returns how many. */
  addReviewed(candidates: Float32Array): number;
  readonly cellCount: number;
  readonly reservoirBytes: number;
  /** Frames stored per tile, and why that is below target. */
  readonly framesPerTile: number;
  readonly reservoirWarning: string | undefined;
  /** Work spent so far, about multiply-adds. */
  readonly work: number;
  stats(): Float64Array;
  /** `(id, established, transients)` triples. */
  cellStatus(): Float64Array;
  // Look-back (see `SlowLoop.enableLookback`).
  enableLookback(rate: number, maxFrames: number): void;
  lookbackNote(seen: number, frames: number): void;
  /** Never re-read a frame before `frame` again (a Joint run's current session). */
  setLookbackFloor(frame: number): void;
  /** `[frame, block, n, id_1..id_n, ...]`; empty when the budget is spent or nothing is needed. */
  lookbackTake(max: number): Float64Array;
  observeLookback(
    frame: Float32Array,
    version: number,
    traces: Float32Array,
    background: Float32Array | undefined,
    stream: number,
    ids: Float64Array,
  ): boolean;
  markAllDue(): void;
  /** `[requested, pushed, heldOut, dropped, births, inNeed, recordBytes]`. */
  lookbackStats(): Float64Array;
  /** `[id, noise, ...]`: split-half footprint noise of the newest library's cells. */
  footprintNoise(): Float64Array;
  /** Split-half noise of one cell on the given pixels. */
  footprintNoiseOn(id: number, support: Uint32Array): number;
  // Background settle, frames only (see `SlowLoop.enableSettle`).
  enableSettle(chunk: number): void;
  /** `[frame, block, held, ...]`: saved frames to re-read among stream frames `0..seen`. */
  settleTake(seen: number, max: number): Float64Array;
  /** `false`: held out (never fitted) or the version is gone. */
  observeSettle(
    frame: Float32Array,
    version: number,
    traces: Float32Array,
    background: Float32Array | undefined,
    stream: number,
  ): boolean;
  /** Held-out frames of `settleTake` passed over without a solve. */
  settleSkipped(frames: number): void;
  /** `[taken, fit, heldOut, dropped]`. */
  settleStats(): Float64Array;
  free(): void;
}

/** A recording's ask about its factors ends on the file after this long without an answer (`?factors=file`). */
export const FACTOR_ASK_MS = 150_000;
/** The message shown when the factors ask times out. */
export const FACTOR_NO_ANSWER = `No answer about the factors within ${FACTOR_ASK_MS / 1000} s.`;

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
  /** Frames per request to the look-back worker (Discover's look-back and the settle). */
  takeMax: 16,
  /** A request unanswered this long stops look-back for the run (settling must end). */
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
 * The slow-loop options of a live stream with `?factors`:
 * the cluster history replay in refine-scope visits only, so in the Final
 * settle on factors; Discover's visits are as without it (no merge guard,
 * the default sign rule). qc_eval's arm `STR-F`.
 */
export const FACTOR_SETTLE = {
  jointUpdate: 'refine',
  jointSign: 'all',
  mergeGuardMinSep: Infinity,
} as const;

/**
 * Build a `SlowLoop` or `VisitWorker` from the slow loop's settings: the
 * plain constructor, unless `init.lookback`, then with the look-back options (`LOOKBACK`; a slow loop
 * and its visit workers must agree on them).
 */
export function buildSlowLoop<T>(ctor: SlowLoopCtor<T>, init: SlowInit): T {
  const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx } = init;
  if (!init.lookback) {
    if (!init.factorSettle)
      return new ctor(width, height, fov, noise, cellDiameterPx, flattenSigmaPx);
    return ctor.withConfig(
      width,
      height,
      fov,
      noise,
      cellDiameterPx,
      flattenSigmaPx,
      FACTOR_SETTLE.jointUpdate,
      FACTOR_SETTLE.jointSign,
      FACTOR_SETTLE.mergeGuardMinSep,
    );
  }
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
  const lb = loop as T & {
    enableLookback?(rate: number, maxFrames: number): void;
  };
  lb.enableLookback?.(LOOKBACK.rate, LOOKBACK.maxFrames);
  // (Background settle is enabled by `SlowRunner` when it is armed, below Max.)
  return loop;
}

/** What a `SlowRunner` needs from its environment (workers, clocks, timers). */
export interface SlowRunnerDeps {
  create(init: SlowInit): SlowLoopLike;
  toFast: PortLike<SlowToFast>;
  toMain: PortLike<SlowToMain>;
  /** Ports to the visit workers (none: visit tiles here). */
  visits?: PortLike<OwnerToVisit>[];
  /** Port to the look-back worker (also `connectLookback`). */
  lookback?: PortLike<SlowToLookback>;
  now?: () => number;
  /** Epoch clock for the batch wait (`FastToSlow` `sentAt`); default `performance.timeOrigin + performance.now()`. */
  epochNow?: () => number;
  /** Run `fn` as a later task (settling gives way between steps; default `setTimeout(fn, 0)`). */
  defer?: (fn: () => void) => void;
  /** Call `fn` after `ms` unless cancelled (default `setTimeout`). */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** One frame of an outstanding look-back request (no ids: a settle frame, for every cell). */
export interface LookbackItem {
  frame: number;
  ids: Float64Array;
}

/**
 * The request out to the look-back worker: need-driven look-back (`need`),
 * Background settle (`csettle`), or the Final settle (`end`).
 */
export interface LookbackReq {
  id: number;
  /** The look-back worker it went to (0: need-driven look-back and the Final settle; 1..S: the settle pool). */
  port: number;
  kind: 'need' | 'csettle' | 'end';
  items: LookbackItem[];
  /** `csettle`: per frame, 1 = held out (not solved; never handed to the slow loop). */
  skip?: Uint8Array;
}

/** A look-back answer's busy ms (its `serve` time less the waits for Discover's rows). */
function timingBusyMs(t: LookbackTiming): number {
  return t.readMs + t.preprocessMs + t.solveMs + t.otherMs;
}

function emptyWorkByKind(): Record<LookbackKind, LookbackWork> {
  return { need: emptyLookbackWork(), csettle: emptyLookbackWork(), end: emptyLookbackWork() };
}

/** `lookbackTake` output (`[frame, block, n, id_1..id_n, ...]`) without the frames before `floor`. */
export function framesFrom(flat: Float64Array, floor: number): Float64Array {
  const out: number[] = [];
  for (let k = 0; k + 2 < flat.length; k += 3 + flat[k + 2])
    if (flat[k] >= floor) for (let j = k; j < k + 3 + flat[k + 2]; j++) out.push(flat[j]);
  return out.length === flat.length ? flat : Float64Array.from(out);
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

/** What a visit worker or a look-back worker sent back, held by the apply barrier. */
type BarrierResult = VisitToOwner | LookbackToSlow;

/** Wall time between cell-status updates to the main thread, ms. */
export const CELL_STATUS_EVERY_MS = 1000;

/** The slow loop's driver inside the slow worker. */
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
  /** The Final settle's visit rate, visits per settle frame fed (`SlowInit.settleVisitRate`; 0: none). */
  private settleRate = 0;
  private jobs = 0;
  private visitMsSum = 0;
  private visitMsN = 0;
  private visitMs = 0;
  /** Wall time this worker spent handing out and applying visits, ms. */
  private jobOwnerMs = 0;
  // Work accounting (`lib/work-meter.ts`; reported in `SlowStatus.accounting`, never read back here).
  private readonly epochNow: () => number;
  private readonly clock: DutyClock<SlowDuty>;
  private workT0: number;
  private visitBusy: number[];
  /** Per visit worker: whether the job out was handed out in the Final settle. */
  private jobSettle: boolean[];
  /** Per visit worker: the busy ms of its Final-settle visits (`WorkStatus.settleVisitBusyMs`). */
  private settleVisitBusy: number[];
  private lbWork = emptyWorkByKind();
  /** Answers that arrived for a request nobody waits for (cancelled, timed out, stale). */
  private lbDiscarded = emptyLookbackWork();
  private waitN = 0;
  private waitSum = 0;
  private waitLast = 0;
  private readonly waitMax = new WindowMax(1000);
  /** History-review candidates waiting for the visits out to come back. */
  private reviewed: Float32Array[] = [];
  // ---- look-back ----
  /** Ports to the look-back workers: 0 for need-driven look-back and the Final settle, 1..S the settle pool. */
  private lbPorts: (PortLike<SlowToLookback> | null)[];
  /** This run uses look-back (`SlowInit.lookback`). */
  private lbOn = false;
  // ---- the Final settle on a stream's factors (`SlowInit.factorSettle`) ----
  /** This run settles on its factors after the last frame (`SlowInit.factorSettle`, Discover). */
  private factorOn = false;
  /** Discover's last frame is in and the factors are not yet ready (released by `factors`, Stop, `drop`). */
  private factorWait: { since: number; file?: boolean } | null = null;
  /** A recording with `?factors=file` (`SlowInit.factorFile`, look-back on). */
  private factorFile = false;
  /** Why the settle of a `?factors=file` run reads the file (unset: it reads the factors, or no switch). */
  private fileReason: string | undefined;
  /** Cancels the ask's deadline. */
  private askTimer: (() => void) | null = null;
  /** The settle reads the factors through look-back worker 0 (from `factors` ready to the run's end). */
  private factorLive = false;
  /**
   * A recording's factors the settle reads (`?factors=file`/`gpu`, from `factors` ready to the
   * run's end): every worker in the run's pool is switched to them and serves the Final settle.
   */
  private factorSource: FactorSource['factors'] | null = null;
  /** Per look-back worker: sent `factorSource` this run (it serves the settle from the factors). */
  private lbFactors: boolean[] = [];
  /** Per look-back worker: the request out to it (at most one each), and its timeout's cancel. */
  private lbReqs: (LookbackReq | null)[] = [];
  private lbNextId = 1;
  private lbTimers: ((() => void) | null)[] = [];
  /** The Final settle's next request, prepared ahead on worker 0 and waiting for its cue (`solveHeld`). */
  private lbHeld: LookbackReq | null = null;
  /** Pool workers (1..S) left out for the rest of this run after a failure. */
  private lbPortOff: boolean[] = [];
  /** Per look-back worker: the busy ms of its answers this run (`WorkStatus.lookbackWorkerBusyMs`). */
  private lbPortBusy: number[] = [];
  /** Per look-back worker: the part of `lbPortBusy` on Final-settle answers (`WorkStatus.lookbackWorkerEndBusyMs`). */
  private lbPortEndBusy: number[] = [];
  /** The pacer's target and pause (`setPace`; kept across runs: the main thread sends it when it changes). */
  private pace = { fps: 0, paused: false };
  /**
   * A Joint run: the first frame of the current session (`SlowInit.sessionStarts`).
   * Look-back and Background settle never re-read a frame before it.
   */
  private lbFloor = 0;
  /** Look-back stopped by an error or a timeout (Discover and settling go on without it). */
  private lbError: string | undefined;
  /** The settle's cap, re-read frames per live frame (0 = Off; `setCap`; kept across runs like `pace`). */
  private cap: number = CSETTLE.rate;
  /** The settle pool the main thread started for a session (`setSettlePool`; applied when that run is here). */
  private pool: { session: number; workers: number } | null = null;
  /** Per look-back worker 1..S: in this run's settle pool, and sent a library this run (it serves from then on). */
  private lbRun: boolean[] = [];
  private lbLib: boolean[] = [];
  /** The settle's last status (kept for the final status after it ends). */
  private settleStatus: SettleStatus | undefined;
  /** The "still moving" hint of the newest checkpoint, sent with the next status (information only). */
  private stillMoving: Float64Array | null = null;
  /** Measurement only (`?debug`, `setDebugTiming`): finer sums for the stage-0 attribution. */
  private dt: DetailTimer | null = null;
  /** Measurement only (`?debug&detlog`, `setDetlog`): the determinism log. */
  private det: DetLog | null = null;
  /** Visit jobs handed out this run (the determinism log's take sequence). */
  private takeSeq = 0;
  /** Per visit worker: the take sequence of the job out (determinism log). */
  private slotSeq: number[] = [];
  /** Per look-back worker: epoch ms the request out was sent (relay timing). */
  private lbSentAt: number[] = [];
  /** A repeatable run's visits and look-back requests out, and the answers held until due. */
  private bar = new ApplyBarrier<BarrierResult>();
  /** The last stream frame of the batch being observed (the barrier's clock). */
  private batchEnd = 0;
  /** A repeatable run: batch ends that waited for something late, and the wait, ms. */
  private barrierWaits = 0;
  private barrierWaitMs = 0;
  /** The fast loop's count of libraries adopted after their stamped frame (`FastToSlow` `lateLibraries`). */
  private lateLibraries = 0;
  private readonly defer: (fn: () => void) => void;
  private readonly timer: (fn: () => void, ms: number) => () => void;

  /** The Final settle (`final-settle-driver.ts`). */
  private readonly finalSettle: FinalSettleDriver;
  /** Background settle (`bg-settle-driver.ts`). */
  private readonly bgSettle: BgSettleDriver;

  constructor(deps: SlowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.epochNow = deps.epochNow ?? (() => performance.timeOrigin + performance.now());
    // Time charged while the Final settle runs is summed apart (`WorkStatus.settleBusyMs`).
    this.clock = new DutyClock(SLOW_DUTIES, this.now, () => this.finalSettle?.state != null);
    this.workT0 = this.now();
    this.visits = deps.visits ?? [];
    this.busy = this.visits.map(() => false);
    this.visitBusy = this.visits.map(() => 0);
    this.jobSettle = this.visits.map(() => false);
    this.settleVisitBusy = this.visits.map(() => 0);
    this.lbPorts = [deps.lookback ?? null];
    this.defer = deps.defer ?? ((fn) => void setTimeout(fn, 0));
    this.timer =
      deps.timer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    const host = this.driverHost();
    this.finalSettle = new FinalSettleDriver(host);
    this.bgSettle = new BgSettleDriver(host);
  }

  /** The runner's state and plumbing as the settle drivers see it (read live through getters). */
  private driverHost(): FinalSettleHost & BgSettleHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const r = this;
    return {
      get loop() {
        return r.loop;
      },
      get init() {
        return r.init;
      },
      get consumed() {
        return r.consumed;
      },
      get settleRate() {
        return r.settleRate;
      },
      get parallel() {
        return r.parallel;
      },
      get busy() {
        return r.busy;
      },
      get jobs() {
        return r.jobs;
      },
      get lbPort() {
        return r.lbPort;
      },
      get lbReqs() {
        return r.lbReqs;
      },
      get lbHeld() {
        return r.lbHeld;
      },
      get lbPortOff() {
        return r.lbPortOff;
      },
      get lbFactors() {
        return r.lbFactors;
      },
      get lbError() {
        return r.lbError;
      },
      get factorLive() {
        return r.factorLive;
      },
      get factorSource() {
        return r.factorSource;
      },
      get clock() {
        return r.clock;
      },
      get dt() {
        return r.dt;
      },
      get version() {
        return r.version;
      },
      get lbFloor() {
        return r.lbFloor;
      },
      get lookbackLive() {
        return r.lookbackLive;
      },
      get barrierOn() {
        return r.barrierOn;
      },
      get pace() {
        return r.pace;
      },
      get cap() {
        return r.cap;
      },
      get skipped() {
        return r.skipped;
      },
      set skipped(v) {
        r.skipped = v;
      },
      get scope() {
        return r.scope;
      },
      set scope(v) {
        r.scope = v;
      },
      get reviewed() {
        return r.reviewed;
      },
      set reviewed(v) {
        r.reviewed = v;
      },
      get settleStatus() {
        return r.settleStatus;
      },
      set settleStatus(v) {
        r.settleStatus = v;
      },
      get stillMoving() {
        return r.stillMoving;
      },
      set stillMoving(v) {
        r.stillMoving = v;
      },
      now: () => r.now(),
      tm: <T>(key: string, fn: () => T) => r.tm(key, fn),
      defer: (fn: () => void) => r.defer(fn),
      fail: (err: unknown) => r.fail(err),
      status: (batchMs: number, maxStepMs: number) => r.status(batchMs, maxStepMs),
      publish: (lib: PublishedLibrary) => r.publish(lib),
      finish: () => r.finish(),
      housekeep: () => r.housekeep(),
      dispatch: (limit?: number) => r.dispatch(limit),
      settlePorts: () => r.settlePorts(),
      sendRequest: (
        port: number,
        kind: LookbackReq['kind'],
        flat: Float64Array,
        items: LookbackItem[],
        skip?: Uint8Array,
        hold?: boolean,
      ) => r.sendRequest(port, kind, flat, items, skip, hold),
      solveHeld: () => r.solveHeld(),
      dropHeld: () => r.dropHeld(),
      cancelRequests: () => r.cancelRequests(),
      releaseFrames: (msg: Extract<LookbackToSlow, { type: 'frames' }>, port: number) =>
        r.releaseFrames(msg, port),
      settleView: (d: Settle, done: boolean) => r.settleView(d, done),
      needRequest: (loop: SlowLoopLike) => r.needRequest(loop),
      lookbackRequest: () => r.lookbackRequest(),
      bgSettleStop: () => r.bgSettle.bgSettleStop(),
    };
  }

  /** Measurement only: finer timers into `WorkStatus.detail` (`?debug`). Changes no decision. */
  setDebugTiming(on: boolean): void {
    this.dt = on ? new DetailTimer(this.now) : null;
  }

  /** Measurement only: keep the determinism log (`lib/detlog.ts`), sent with each status. Changes no decision. */
  setDetlog(on: boolean): void {
    this.det = on ? new DetLog() : null;
  }

  /** The determinism log's rows since the last flush, to the main thread (none: nothing sent). */
  private flushDetlog(): void {
    const rows = this.det?.take();
    if (rows?.length) this.deps.toMain.postMessage({ type: 'detlog', session: this.session, rows });
  }

  /** `fn` timed under `key` when debug timing is on (else just run). */
  private tm<T>(key: string, fn: () => T): T {
    return this.dt ? this.dt.time(key, fn) : fn();
  }

  /** A message handler's whole synchronous run, by source (debug timing; `slow-worker.ts`). */
  handlerSpan<T>(source: string, fn: () => T): T {
    return this.dt ? this.dt.time(`handler.${source}`, fn) : fn();
  }

  /**
   * The port to look-back worker `index` (0: need-driven look-back and the
   * end settle; 1..S: the settle pool). Runs with look-back started after this
   * call use it; a pool port serves once `setSettlePool` joins it to a run.
   */
  connectLookback(port: PortLike<SlowToLookback>, index = 0): void {
    this.lbPorts[index] = port;
  }

  /** Look-back worker 0 serves this run: look-back, or the settle on factors. */
  private get lbServes(): boolean {
    return this.lbOn || this.factorLive;
  }

  /** The port to the need-driven look-back worker (null: not connected). */
  private get lbPort(): PortLike<SlowToLookback> | null {
    return this.lbPorts[0] ?? null;
  }

  /** The pool workers (1..S) serving the settle now: connected, in this run, sent a library, not failed. */
  private settlePorts(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.lbPorts.length; i++)
      if (this.lbPorts[i] && this.lbRun[i] && this.lbLib[i] && !this.lbPortOff[i]) out.push(i);
    return out;
  }

  /**
   * The pacer's target live fps (0: unpaced, Max) and whether the run is
   * paused, from the main thread (kept across runs). Only the settle
   * governor reads it.
   */
  setPace(fps: number, paused: boolean): void {
    this.pace = { fps: Number.isFinite(fps) && fps > 0 ? fps : 0, paused };
    if (this.bgSettle.bgs) this.bgSettle.bgs.gov.setTarget(this.pace.fps, this.pace.paused);
    else this.bgSettle.armSettle();
  }

  /**
   * The settle's cap, re-read frames per live frame (0 = Off), from the main
   * thread, during a run too (kept across runs; only the settle reads it).
   */
  setCap(cap: number): void {
    this.cap = Number.isFinite(cap) && cap > 0 ? cap : 0;
    if (this.bgSettle.bgs) {
      this.bgSettle.bgs.gov.setCap(this.cap);
      this.status(0, 0);
    } else this.bgSettle.armSettle();
  }

  /**
   * The main thread started look-back workers 1..`workers` for `session`'s
   * run (the settle pool; it may be mid-run) and have its back state: they
   * take the settle's chunks from the library sent to them (the current one at once).
   */
  setSettlePool(session: number, workers: number): void {
    this.pool = { session, workers: Math.max(0, Math.floor(workers)) };
    if (session !== this.session || !this.loop) return;
    if (this.pool.workers > 0) this.joinPool(this.pool.workers);
    else this.leavePool();
  }

  /**
   * The main thread ended this run's pool workers (`workers` 0: after the Final settle's
   * library, `LookbackFeed.endPool`): nothing more goes to them (no library copies for a
   * Refine run); worker 0 is not one of them.
   */
  private leavePool(): void {
    for (let i = 1; i < this.lbPorts.length; i++) {
      this.lbRun[i] = false;
      this.lbLib[i] = false;
      this.lbFactors[i] = false;
    }
  }

  /**
   * Pool workers 1..`workers` join this run. They get the current library at
   * once (a stable library publishes nothing new, so waiting for the next
   * publish could leave a late pool idle for the rest of the run).
   */
  private joinPool(workers: number): void {
    const before = this.settlePorts().length;
    for (let i = 1; i <= workers; i++) {
      this.lbRun[i] = true;
      // On a recording's factors: switched before its library, so its first settle request reads them.
      this.sendFactors(i);
    }
    const loop = this.loop;
    if (!loop || !this.lbOn || this.lbError || this.version <= 0) return;
    const lib = loop.publishedLibrary();
    if (!lib) return;
    try {
      // Only the version the other workers have (an older one would solve against a stale library).
      if (lib.version !== this.version) return;
      const bytes = lib.toBytes();
      for (let i = 1; i <= workers; i++) {
        const port = this.lbPorts[i];
        if (!port || this.lbPortOff[i] || this.lbLib[i]) continue;
        const copy = bytes.slice();
        port.postMessage(
          { type: 'library', session: this.session, version: this.version, bytes: copy },
          [copy.buffer as ArrayBuffer],
        );
        this.lbLib[i] = true;
      }
    } finally {
      lib.free();
    }
    const after = this.settlePorts().length;
    if (after !== before && this.bgSettle.bgs) {
      this.bgSettle.bgs.gov.setWorkers(after);
      this.status(0, 0);
    }
    // The Final settle on a recording's factors: the new workers take requests at once.
    if (after !== before && this.finalSettle.state) this.finalSettle.settlePump();
  }

  /** Switch look-back worker `port` to the run's factors (once; `factorSource` set, connected, not failed). */
  private sendFactors(port: number): void {
    const factors = this.factorSource;
    const p = this.lbPorts[port];
    if (!factors || !p || this.lbPortOff[port] || this.lbFactors[port]) return;
    p.postMessage({ type: 'factors', session: this.session, factors });
    this.lbFactors[port] = true;
  }

  /** Tile visits run on visit workers. */
  private get parallel(): boolean {
    return this.visits.length > 0;
  }

  /**
   * Discover of a repeatable run at a target speed: hand-outs at batch ends, answers applied at
   * the apply barrier (`ApplyBarrier`). At Max nothing waits: results apply as they arrive.
   */
  private get barrierOn(): boolean {
    return (
      this.init?.repeatable === true &&
      this.pace.fps > 0 &&
      this.run === 1 &&
      this.scope === 'all' &&
      !this.ending &&
      !this.final &&
      this.finalSettle.state === null &&
      this.factorWait === null
    );
  }

  /**
   * A reset or a new run is on its way (not queued: a batch may be waiting at the barrier for an
   * answer that will never come). Nothing more is waited for in this run.
   */
  abortBarrier(session: number): void {
    if (session >= this.session) this.bar.abort();
  }

  /**
   * `handle`, but a batch of frames gives way between frames (`pause`) while
   * visits are out, so their results are applied and the next visits handed
   * out without waiting for the whole batch (the slow worker's way of
   * keeping its visit workers busy while it observes; see `frames`).
   */
  async handleAsync(msg: FastToSlow, pause: () => Promise<void>): Promise<void> {
    if (msg.type !== 'frames' || msg.session !== this.session) {
      if (msg.type === 'end' && msg.session === this.session && this.bar.size > 0)
        await this.barrierEnd();
      this.handle(msg);
      return;
    }
    try {
      const steps = this.frameSteps(msg);
      for (;;) {
        const step = this.handlerSpan('fast', () => steps.next());
        if (step.done) break;
        await (step.value ?? pause());
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Discover's last frame is in: the visits out are waited for and applied in hand-out order;
   * look-back answers not yet applied are dropped (their requests count as cut short, as without
   * the barrier).
   */
  private async barrierEnd(): Promise<void> {
    try {
      for (const it of this.bar.removeKind('lookback')) {
        const m = it.result;
        if (m && m.type === 'frames') this.releaseFrames(m, it.key);
      }
      const t0 = this.now();
      if (!this.bar.ready(Infinity)) {
        this.barrierWaits++;
        await this.bar.wait(Infinity);
        this.barrierWaitMs += this.now() - t0;
      }
      const loop = this.loop;
      if (this.bar.aborted || !loop) return;
      this.applyDue(loop, Infinity);
      if (this.parallel) this.housekeep();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Apply what the barrier holds due by stream frame `frame`, in hand-out order. */
  private applyDue(loop: SlowLoopLike, frame: number): void {
    for (const it of this.bar.takeDue(frame)) {
      const m = it.result!;
      if (it.kind === 'visit') {
        if (m.type !== 'result') continue;
        this.busy[it.key] = false;
        this.applyVisit(it.key, m);
        continue;
      }
      const lm = m as LookbackToSlow;
      const req = this.lbReqs[it.key];
      if (req && req.id === it.id) this.lookbackAnswer(lm, it.key, req, loop);
      else if (lm.type === 'frames') this.releaseFrames(lm, it.key);
    }
  }

  handle(msg: FastToSlow): void {
    if (msg.type === 'reset' || msg.type === 'init') {
      if (msg.session < this.session) return;
      this.drop();
      this.flushDetlog();
      this.session = msg.session;
      this.takeSeq = 0;
      // (An init replaces a visit worker's state too.)
      if (msg.type === 'reset')
        for (const v of this.visits) v.postMessage({ type: 'reset', session: msg.session });
      if (msg.type === 'init') {
        const { width, height, fov, noise, cellDiameterPx, flattenSigmaPx, budget } = msg;
        // Tests feed raw inits here: the run's rules apply as in every other layer.
        const run = normalizeRunCells(msg);
        const lookback = run.lookback === true;
        // The loop and the visit workers are built from these (`buildSlowLoop`).
        this.init = {
          width,
          height,
          fov,
          noise,
          cellDiameterPx,
          flattenSigmaPx,
          budget,
          ...(lookback ? { lookback } : {}),
          ...(run.factorSettle ? { factorSettle: true } : {}),
          ...(run.csettle ? { csettle: true } : {}),
          ...(run.settleFraction !== undefined ? { settleFraction: run.settleFraction } : {}),
          ...(run.sessionStarts ? { sessionStarts: run.sessionStarts } : {}),
          ...(run.repeatable ? { repeatable: true } : {}),
        };
        this.loop = this.clock.span('setup', () => this.deps.create(this.init!));
        // The Discover visit rate's schedule (`fixed` or `auto`; `discover/visitrate.rs`) sets
        // the cap on ordinary visits in Discover's edit scope (the Final settle and Refine runs
        // are not held); without one, no cap.
        if (run.visitSchedule) this.loop.setVisitSchedule(run.visitSchedule === 'auto');
        this.settleRate = run.settleVisitRate ?? 0;
        this.run = 1;
        this.lbOn = lookback;
        this.factorOn = this.init.factorSettle === true;
        this.factorFile = run.factorFile === true && this.lbOn;
        if (this.lbOn && !this.lbPort) this.lbError = 'The look-back worker is not connected.';
        if (this.lbOn && run.csettle === true) {
          this.bgSettle.bgArm = {
            yieldFrames: Math.max(0, Math.floor(run.csettleYield ?? 0)),
            needFirst: run.csettleNeedFirst === true,
          };
          this.bgSettle.armSettle();
        }
        if (this.pool?.session === msg.session) this.joinPool(this.pool.workers);
        for (const v of this.visits)
          v.postMessage({ type: 'init', session: msg.session, ...this.init });
      }
      return;
    }
    if (msg.session !== this.session) return;
    try {
      if (msg.type === 'frames') this.frames(msg);
      else if (msg.type === 'end') this.end();
    } catch (err) {
      this.fail(err);
    }
  }

  /** What a history review found, from the main thread. */
  handleReviewed(msg: SlowReviewed): void {
    if (
      msg.session !== this.session ||
      !this.loop ||
      this.ending ||
      this.final ||
      this.finalSettle.state
    )
      return;
    try {
      this.reviewed.push(msg.candidates);
      this.addReviewed();
      // A repeatable run hands out visits at batch ends only.
      if (!this.barrierOn) this.dispatch();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Add the waiting history-review candidates, once no visit is out. */
  private addReviewed(): void {
    const loop = this.loop;
    if (!loop || this.reviewed.length === 0 || this.busy.some((b) => b)) return;
    for (const candidates of this.reviewed.splice(0)) loop.addReviewed(candidates);
  }

  /** A message from visit worker `i`. */
  handleVisit(i: number, msg: VisitToOwner): void {
    if (msg.session !== this.session || !this.loop) return;
    try {
      if (msg.type === 'error') throw new Error(`visit worker ${i}: ${msg.message}`);
      // A repeatable run: held until its batch end (`applyDue`).
      if (this.bar.arrive('visit', i, msg)) return;
      this.busy[i] = false;
      this.applyVisit(i, msg);
      // (A visit handed out before a repeatable run's barrier began: nothing more on arrival.)
      if (this.barrierOn) return;
      this.housekeep();
      if (this.finalSettle.state) {
        // The settle keeps its visit workers busy, within the visits its frames earned; a request
        // held back for the visits owed may go out now. The last round and a Stop wait for them.
        if (this.finalSettle.state.phase === 'sweep' && !this.finalSettle.state.stop) {
          const d = this.finalSettle.state;
          this.finalSettle.settleDispatch(d);
          // An answer waiting between pieces for the visits owed goes on.
          if (d.holdSince !== null)
            this.clock.span('end', () => this.finalSettle.settleObserve(this.loop!, d));
          if (this.finalSettle.state === d) this.finalSettle.settlePump();
        } else if (!this.busy.some((b) => b)) this.finalSettle.settlePump();
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

  /** A visit's result into the slow loop (no housekeeping, no hand-out). */
  private applyVisit(i: number, msg: Extract<VisitToOwner, { type: 'result' }>): void {
    const loop = this.loop!;
    this.det?.row('apply', this.observed, this.slotSeq[i], i, fnvBytes(msg.bytes), loop.work);
    const t0 = this.now();
    this.clock.span('visit', () => this.tm('visit.apply', () => loop.applyJob(msg.bytes)));
    this.jobOwnerMs += this.now() - t0;
    this.jobs++;
    this.visitMsSum += msg.ms;
    this.visitMsN++;
    this.visitBusy[i] = (this.visitBusy[i] ?? 0) + msg.ms;
    if (this.jobSettle[i]) this.settleVisitBusy[i] = (this.settleVisitBusy[i] ?? 0) + msg.ms;
  }

  private fail(err: unknown): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session: this.session,
      message: errMsg(err),
    });
    this.drop();
  }

  private frames(msg: Extract<FastToSlow, { type: 'frames' }>): void {
    for (const wait of this.frameSteps(msg))
      if (wait) throw new Error('a repeatable run waits at its batch ends (`handleAsync`)');
  }

  /**
   * Observe a batch. With visit workers, outside the `all` edit scope (the Final settle, which
   * runs with `refine`), it yields after each frame while a visit is out: the caller may then let
   * visit results in (`handleAsync`).
   * Otherwise a result would wait for the whole batch, and once the frames come as fast as the
   * slow worker can observe them (a settle never drops a batch) its visit workers would sit idle
   * and make fewer visits per frame.
   */
  private *frameSteps(
    msg: Extract<FastToSlow, { type: 'frames' }>,
  ): Generator<Promise<void> | void, void> {
    const loop = this.loop;
    const init = this.init;
    let observed = 0;
    this.batchEnd = msg.start + msg.count;
    if (msg.lateLibraries !== undefined)
      this.lateLibraries = Math.max(this.lateLibraries, msg.lateLibraries);
    let maxStep = 0;
    const t0 = this.now();
    // The wait in the inbox: sent by the fast worker (epoch clock) until processing starts here.
    if (msg.sentAt !== undefined) {
      // Not clamped: a negative reading would mean the two workers' clocks disagree.
      const wait = this.epochNow() - msg.sentAt;
      this.waitN++;
      this.waitSum += wait;
      this.waitLast = wait;
      this.waitMax.push(t0, wait);
    }
    // A live span, closed at each give-way (`yield`) and in `finally`.
    let live = false;
    const beginLive = (): void => {
      if (!live) this.clock.begin('live');
      live = true;
    };
    const endLive = (): void => {
      if (live) this.clock.end();
      live = false;
    };
    beginLive();
    try {
      if (loop && init) {
        this.det?.row('batch', this.observed, msg.start, msg.count, msg.version, loop.work);
        if (msg.noise) {
          this.tm('live.setNoise', () => loop.setNoise(msg.noise!));
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
          // (required with it on); without look-back there is none.
          const stream = this.lbOn ? msg.start + i : undefined;
          const t0 = this.dt ? this.now() : 0;
          const ok = loop.observe(frame, msg.version, traces, background, stream);
          if (this.dt) {
            this.dt.add('live.observe', this.now() - t0);
            this.dt.add('live.observe#', 1);
          }
          if (!ok) {
            this.skipped++;
            continue;
          }
          observed++;
          this.observed++;
          this.frame = msg.start + i + 1;
          if (this.parallel) {
            // The Final settle only (scope `refine`): Discover keeps its timing (it drops batches instead).
            if (this.scope !== 'all' && i + 1 < msg.count && this.busy.some((b) => b)) {
              endLive();
              yield;
              // A visit result failed meanwhile and dropped the loop (its clock was reset).
              if (this.loop !== loop) break;
              beginLive();
            }
            continue;
          }
          const s = this.now();
          const lib = loop.step(init.budget);
          maxStep = Math.max(maxStep, this.now() - s);
          if (lib) this.publish(lib);
        }
        // A repeatable run: what is due by this batch end, waited for and applied in hand-out
        // order (also the rest, once the barrier is off: the target went to Max).
        if (this.bar.size > 0 && !this.bar.aborted) {
          const until = this.barrierOn ? this.batchEnd : Infinity;
          if (!this.bar.ready(until)) {
            endLive();
            const tw = this.now();
            this.barrierWaits++;
            yield this.bar.wait(until);
            this.barrierWaitMs += this.now() - tw;
            // Dropped meanwhile (a failure, a reset or a new run).
            if (this.loop !== loop || this.bar.aborted) return;
            beginLive();
          }
          this.applyDue(loop, until);
        }
        if (this.parallel) {
          const s = this.now();
          this.housekeep();
          maxStep = this.now() - s;
          this.dispatch();
        }
        if (this.lookbackLive) {
          const tn = this.dt ? this.now() : 0;
          this.sessionFloor(loop, msg.start);
          loop.lookbackNote(msg.start + msg.count, observed);
          this.dt?.add('live.lookbackNote', this.now() - tn);
          const bgs = this.bgSettle.bgs;
          if (bgs) {
            bgs.gov.liveBatch(msg.sentAt ?? this.epochNow(), msg.start + msg.count);
            this.bgSettle.liveFrames(loop, bgs, observed);
          }
          this.tm('live.lookbackRequest', () => this.lookbackRequest());
        }
      }
    } finally {
      endLive();
      this.consumed = Math.max(this.consumed, msg.start + msg.count);
      // The buffer always goes back, or the fast worker's pool would shrink.
      const ta = this.dt ? this.now() : 0;
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
      this.dt?.add('live.ack', this.now() - ta);
      this.dt?.add('live.batches', 1);
    }
    this.status(this.now() - t0, maxStep);
  }

  /** Trimming decisions and, when due, a library (parallel mode). */
  private housekeep(): void {
    this.clock.span('housekeep', () => {
      const lib = this.tm('housekeep.wasm', () => this.loop?.housekeep());
      if (lib) this.publish(lib);
    });
  }

  /**
   * A tile visit to every idle visit worker, while any is due (at most `limit`); returns how many
   * were handed out.
   */
  private dispatch(limit = Infinity): number {
    const loop = this.loop;
    // Reviewed cells wait for the visits out: hand out no new one meanwhile.
    if (!loop || this.ending || this.reviewed.length > 0 || !(limit > 0)) return 0;
    const settling = this.finalSettle.state !== null;
    return this.clock.span('visit', () => {
      let handed = 0;
      for (let i = 0; i < this.visits.length && handed < limit; i++) {
        if (this.busy[i]) continue;
        const t0 = this.now();
        const bytes = this.tm('visit.take', () => loop.takeJob());
        if (!bytes) break;
        if (this.det) {
          this.slotSeq[i] = ++this.takeSeq;
          this.det.row('take', this.observed, this.takeSeq, i, fnvBytes(bytes));
        }
        this.busy[i] = true;
        this.jobSettle[i] = settling;
        if (this.barrierOn) this.bar.issue('visit', i, this.batchEnd);
        handed++;
        const tp = this.now();
        this.visits[i].postMessage({ type: 'job', session: this.session, bytes }, [
          bytes.buffer as ArrayBuffer,
        ]);
        this.dt?.add('visit.post', this.now() - tp);
        this.jobOwnerMs += this.now() - t0;
      }
      return handed;
    });
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
      this.finalSettle.state === null
    );
  }

  /**
   * With no request out, the next one to the look-back worker (returns
   * whether one went out): the frames the look-back scheduler wants now
   * (budget permitting), or a chunk of Background settle when one
   * is owed. The two take turns when both have frames to ask for, so neither
   * starves the other when the look-back worker is the slower side (a
   * recording read at full speed); when it keeps up, both get all they ask.
   */
  private lookbackRequest(): boolean {
    const loop = this.loop;
    if (!loop || !this.lbOn || this.lbError !== undefined || this.factorWait) return false;
    const bgs = this.bgSettle.bgs;
    // The governor's readout (once a second); requests depend on the chunks queued only.
    bgs?.gov.update(this.epochNow(), this.version > 0);
    const pool = this.settlePorts();
    let sent = false;
    if (this.lbPort && !this.lbReqs[0]) {
      // With a settle pool, worker 0 is need-driven only.
      if (pool.length > 0 || !bgs) sent = this.needRequest(loop);
      else sent = this.bgSettle.turnRequest(loop, bgs);
    }
    if (bgs)
      for (const i of pool) {
        if (this.lbReqs[i]) continue;
        if (!this.bgSettle.bgSettleRequest(loop, bgs, i)) break;
        sent = true;
      }
    return sent;
  }

  /**
   * Send a request to look-back worker `port` and start its timeout. `hold`
   * (the Final settle, worker 0): it is prepared ahead and waits for its cue
   * (`solveHeld`); it is not the request out until then.
   */
  private sendRequest(
    port: number,
    kind: LookbackReq['kind'],
    flat: Float64Array,
    items: LookbackItem[],
    skip?: Uint8Array,
    hold = false,
  ): void {
    const id = this.lbNextId++;
    const req: LookbackReq = { id, port, kind, items, ...(skip ? { skip } : {}) };
    this.det?.row('req', this.observed, id, port, kind, items.length, fnvBytes(flat));
    // `flat` is a fresh array (from WASM or built here): transferred as is; `skip` is copied.
    this.clock.span(kind, () =>
      this.lbPorts[port]!.postMessage(
        {
          type: 'request',
          session: this.session,
          id,
          items: flat,
          ...(skip ? { skip: skip.slice() } : {}),
          // The Final settle reads nothing before the main thread's `final` (inputs final).
          // (Not on factors: they hold Discover's own preprocessed frames, see `relayed`.)
          ...(kind === 'end' && !this.factorLive ? { final: true } : {}),
          ...(hold ? { hold: true } : {}),
        },
        [flat.buffer as ArrayBuffer],
      ),
    );
    if (hold) this.lbHeld = req;
    else this.awaitAnswer(req);
    if (!hold && kind !== 'end' && this.barrierOn)
      this.bar.issue('lookback', port, this.batchEnd, id);
  }

  /**
   * The held request (`sendRequest` with `hold`) becomes the request out:
   * its cue goes out at the point where an unheld request would go out, so
   * it is solved with the same library.
   */
  private solveHeld(): void {
    const req = this.lbHeld!;
    this.lbHeld = null;
    this.clock.span(req.kind, () =>
      this.lbPorts[req.port]!.postMessage({ type: 'solve', session: this.session, id: req.id }),
    );
    this.awaitAnswer(req);
  }

  /** Give up the held request (it is never answered). */
  private dropHeld(): void {
    const req = this.lbHeld;
    if (!req) return;
    this.lbHeld = null;
    this.lbPorts[req.port]?.postMessage({ type: 'drop', session: this.session, id: req.id });
  }

  /** `req` is the request out on its port: wait for its answer, at most `LOOKBACK.timeoutMs`. */
  private awaitAnswer(req: LookbackReq): void {
    const { port, id } = req;
    this.lbReqs[port] = req;
    this.lbSentAt[port] = this.epochNow();
    this.lbTimers[port] = this.timer(() => {
      const failed = this.lbReqs[port];
      if (failed?.id !== id) return;
      this.lbTimers[port] = null;
      this.lbReqs[port] = null;
      // Not waited for at the barrier either (its late answer is ignored).
      this.bar.cancel('lookback', port, id);
      const why = `no answer within ${LOOKBACK.timeoutMs / 1000} s`;
      // The settle's own request only turns the settle off; look-back and the Final settle go on.
      if (failed.kind === 'csettle') this.bgSettle.bgSettleFailed(failed, why);
      else if (failed.kind === 'end' && port > 0)
        this.finalSettle.finalSettlePortFailed(failed, why);
      else this.lookbackFailed(why);
      if (this.finalSettle.state) this.finalSettle.settlePump();
      else if (this.lookbackLive && !this.barrierOn) this.lookbackRequest();
    }, LOOKBACK.timeoutMs);
  }

  /**
   * A Joint run: the batch from stream frame `start` is in the session that
   * starts at the last session start at or before it (not only at it: the
   * forward pool may have dropped the session's first batches). Look-back
   * moves its floor there (`setLookbackFloor`): it re-reads the
   * current session only.
   */
  private sessionFloor(loop: SlowLoopLike, start: number): void {
    let floor = this.lbFloor;
    for (const b of this.init?.sessionStarts ?? []) if (b <= start && b > floor) floor = b;
    if (floor === this.lbFloor) return;
    this.lbFloor = floor;
    loop.setLookbackFloor(floor);
  }

  /** Need-driven look-back: the frames the scheduler wants now. */
  private needRequest(loop: SlowLoopLike): boolean {
    const took = this.clock.span('need', () => loop.lookbackTake(LOOKBACK.takeMax));
    // Frames before the session's floor never go out, whatever the scheduler hands out.
    const flat = this.lbFloor > 0 ? framesFrom(took, this.lbFloor) : took;
    if (flat.length === 0) return false;
    this.sendRequest(0, 'need', flat, lookbackItems(flat));
    return true;
  }

  /** Look-back is off for the rest of this run; Discover and settling go on. */
  private lookbackFailed(message: string): void {
    if (this.lbError !== undefined) return;
    this.lbError = message;
    console.warn(`cala look-back stopped: ${message}`);
    this.status(0, 0);
  }

  /** An answer from look-back worker `port`: its frames go into the footprint statistics. */
  handleLookback(msg: LookbackToSlow, port = 0): void {
    const loop = this.loop;
    const req = this.lbReqs[port] ?? null;
    if (msg.type === 'frames' && msg.session === this.session && msg.timing) {
      const busy = timingBusyMs(msg.timing);
      this.lbPortBusy[port] = (this.lbPortBusy[port] ?? 0) + busy;
      if (req?.kind === 'end') this.lbPortEndBusy[port] = (this.lbPortEndBusy[port] ?? 0) + busy;
    }
    if (msg.session !== this.session || !loop || !req || msg.id !== req.id) {
      // Its time was spent all the same: counted apart (only this session's).
      if (msg.type === 'frames' && msg.session === this.session)
        addLookbackAnswer(this.lbDiscarded, msg.count, msg.timing);
      // An ignored answer still returns its buffer to its worker's pool (which drops a stale session's).
      if (msg.type === 'frames') this.releaseFrames(msg, port);
      return;
    }
    this.lbTimers[port]?.();
    this.lbTimers[port] = null;
    // A repeatable run: held until its batch end (`applyDue`); the request stays the one out.
    if (this.bar.arrive('lookback', port, msg, msg.id)) return;
    this.lookbackAnswer(msg, port, req, loop);
  }

  /** An answer to the request out on `port` (`req`): fed to the slow loop, then the next request. */
  private lookbackAnswer(
    msg: LookbackToSlow,
    port: number,
    req: LookbackReq,
    loop: SlowLoopLike,
  ): void {
    this.lbReqs[port] = null;
    this.det?.row(
      'ans',
      this.observed,
      req.id,
      port,
      req.kind,
      msg.type === 'frames' ? msg.version : -1,
      msg.type === 'frames' ? fnvBytes(msg.traces) : 0,
    );
    if (this.dt && msg.type === 'frames') {
      // Relay timing: request sent -> this handler (round trip), and answer posted -> here (queued).
      const at = this.epochNow();
      const k = `relay.${req.kind}.p${port}`;
      this.dt.add(`${k}.rtt`, at - (this.lbSentAt[port] ?? at));
      if (msg.postedAt !== undefined) this.dt.add(`${k}.queued`, at - msg.postedAt);
      this.dt.add(`${k}#`, 1);
      // The Final settle's wait for final inputs (in practice only its first request waits).
      if (msg.timing?.finalWaitMs !== undefined)
        this.dt.add(`${k}.finalWait`, msg.timing.finalWaitMs);
    }
    if (msg.type === 'frames') {
      addLookbackAnswer(this.lbWork[req.kind], msg.count, msg.timing);
      const busy = msg.timing ? timingBusyMs(msg.timing) : 0;
      if (req.kind === 'csettle') this.bgSettle.bgs?.gov.delivered(msg.count, busy);
      // Taking turns (no settle pool): worker 0 is the settle's worker, so its need-driven
      // time counts towards its busy share too (else a full worker reads as "slow worker").
      else if (port === 0 && this.settlePorts().length === 0)
        this.bgSettle.bgs?.gov.delivered(0, busy);
    }
    // The slow worker's time on this answer goes to the kind's duty.
    this.clock.begin(req.kind === 'end' ? 'end' : req.kind);
    try {
      this.answered(msg, loop, req);
    } finally {
      this.clock.end();
    }
  }

  /** The rest of `handleLookback`: what the answer feeds, then the next request. */
  private answered(msg: LookbackToSlow, loop: SlowLoopLike, req: LookbackReq): void {
    const settle = req.kind === 'end' ? this.finalSettle.state : null;
    try {
      if (msg.type === 'error') {
        if (req.kind === 'csettle') this.bgSettle.bgSettleFailed(req, msg.message);
        else if (req.kind === 'end' && req.port > 0)
          this.finalSettle.finalSettlePortFailed(req, msg.message);
        else this.lookbackFailed(msg.message);
      } else if (req.kind === 'csettle' && this.bgSettle.bgs && this.lookbackLive) {
        // (It gives the buffer back itself, at once or after its last piece.)
        this.bgSettle.bgSettleAnswer(loop, this.bgSettle.bgs, msg, req);
        return;
      } else {
        if (settle) {
          if (msg.count !== req.items.length)
            throw new Error(`settle: ${msg.count} frames for a request of ${req.items.length}`);
          settle.served.add(req.port);
          // Observed in arrival order, one answer at a time (its buffer goes back after its last piece).
          settle.answers.push({ msg, req, next: 0, begun: false });
          if (settle.answers.length === 1) this.finalSettle.settleObserve(loop, settle);
          return;
        } else if (req.kind === 'need') this.observeLookback(loop, msg, req.items);
        // A settle answer that came when Discover could not use it: counted as dropped.
        if (req.kind === 'csettle' && this.bgSettle.bgs)
          this.bgSettle.bgs.dropped += req.items.length;
        // The buffer goes back to the look-back worker's pool (never detached here).
        this.releaseFrames(msg, req.port);
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.finalSettle.state) this.finalSettle.settlePump();
    // (A repeatable run asks at its batch ends only.)
    else if (this.lookbackLive && !this.barrierOn) this.lookbackRequest();
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
    const tl = this.dt ? this.now() : 0;
    for (let i = 0; i < msg.count; i++) {
      loop.observeLookback(
        msg.frames.subarray(i * px, (i + 1) * px),
        msg.version,
        msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
        bg?.subarray(i * nb, (i + 1) * nb),
        items[i].frame,
        items[i].ids,
      );
    }
    this.dt?.add('need.observe', this.now() - tl);
    this.dt?.add('need.observe#', msg.count);
  }

  /** An answer's frame buffer, back to the pool of the look-back worker it came from. */
  private releaseFrames(msg: Extract<LookbackToSlow, { type: 'frames' }>, port: number): void {
    this.lbPorts[port]?.postMessage({ type: 'release', session: msg.session, frames: msg.frames }, [
      msg.frames.buffer as ArrayBuffer,
    ]);
  }

  /**
   * Every request out stops being waited for (their late answers are
   * ignored and their buffers go back); a settle request's frames count as
   * dropped, so re-read = fitted + held out + dropped. A held request is dropped.
   */
  private cancelRequests(): void {
    this.dropHeld();
    for (const it of this.bar.removeKind('lookback')) {
      const m = it.result;
      if (m && m.type === 'frames')
        this.releaseFrames(m as Extract<LookbackToSlow, { type: 'frames' }>, it.key);
    }
    for (let i = 0; i < this.lbReqs.length; i++) {
      const req = this.lbReqs[i];
      if (!req) continue;
      if (req.kind === 'csettle' && this.bgSettle.bgs)
        this.bgSettle.bgs.dropped += req.items.length;
      this.lbReqs[i] = null;
      this.lbTimers[i]?.();
      this.lbTimers[i] = null;
    }
  }

  /** The user's "Stop settling": publish the final library at once, with what was refined. */
  stopSettling(session: number): void {
    if (session !== this.session) return;
    if (this.factorWait) {
      const view = this.waitView();
      this.factorWait = null;
      this.askTimer?.();
      this.askTimer = null;
      this.settleStatus = { ...view, waiting: false, stopped: true, done: true };
      this.ending = true;
      if (!this.busy.some((b) => b)) this.finish();
      return;
    }
    const d = this.finalSettle.state;
    if (!d) return;
    d.stop = true;
    // A request out is not waited for (its late answer is ignored).
    this.cancelRequests();
    this.finalSettle.settlePump();
  }

  private end(): void {
    const loop = this.loop;
    if (!loop || this.final || this.ending || this.finalSettle.state || this.factorWait) return;
    this.det?.row('end', this.observed);
    // A look-back Discover settles first (`settlePump`).
    if (this.lbOn && this.run === 1) {
      if (this.factorFile && this.lbError === undefined) {
        // Discover's requests still out would mix sources: drop them; nothing is asked while waiting.
        this.cancelRequests();
        this.bgSettle.bgSettleStop();
        this.reviewed = [];
        this.factorWait = { since: this.now(), file: true };
        const session = this.session;
        this.askTimer = this.timer(() => {
          this.askTimer = null;
          this.factors({ type: 'factors', session, ready: false, reason: FACTOR_NO_ANSWER });
        }, FACTOR_ASK_MS);
        this.status(0, 0);
        return;
      }
      this.clock.span('end', () => this.finalSettle.startFinalSettle());
      return;
    }
    // A ?factors stream waits for its factors, then settles on them (`factors`).
    if (this.factorOn && this.run === 1) {
      this.factorWait = { since: this.now() };
      this.reviewed = [];
      this.status(0, 0);
      return;
    }
    // Visits out still come back and are applied before the final library.
    this.ending = true;
    if (!this.busy.some((b) => b)) this.finish();
  }

  /** The main thread on the stream's factors: settle on them, or end with Discover's library. */
  factors(msg: SlowFactors): void {
    if (msg.session !== this.session || !this.factorWait || !this.loop) return;
    const wait = this.factorWait;
    this.factorWait = null;
    // `?debug`: Discover's end to the factors' answer (the compressor's last windows), ms.
    if (this.dt) {
      this.dt.add('end.factorWait', this.now() - wait.since);
      this.dt.add('end.factorWait#', 1);
    }
    this.askTimer?.();
    this.askTimer = null;
    try {
      if (wait.file) {
        if (msg.ready && msg.source) {
          // Over each worker's request port, so every settle request below reads the factors:
          // worker 0 and every pool worker in this run (one that joins later is switched as it joins).
          this.factorSource = msg.source;
          this.factorLive = true;
          for (let i = 0; i < this.lbPorts.length; i++) {
            if (i > 0 && !this.lbRun[i]) continue;
            this.sendFactors(i);
            if (this.lbFactors[i]) this.sendLibrary(i);
          }
          this.clock.span('end', () =>
            this.finalSettle.startFinalSettle(Math.min(this.consumed, msg.frames)),
          );
        } else {
          this.fileReason = msg.ready ? 'No factor source was given.' : msg.reason;
          this.clock.span('end', () => this.finalSettle.startFinalSettle());
        }
        return;
      }
      if (!msg.ready) {
        this.settleStatus = {
          ...this.waitView(),
          waiting: false,
          done: true,
          error: msg.reason,
        };
        this.ending = true;
        if (!this.busy.some((b) => b)) this.finish();
        return;
      }
      this.factorLive = true;
      // The worker began this run just now: it has no library yet.
      this.sendLibrary(0);
      this.clock.span('end', () =>
        this.finalSettle.startFinalSettle(Math.min(this.consumed, msg.frames)),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  /** The newest published library to look-back worker `port` (a copy). */
  private sendLibrary(port: number): void {
    const lib = this.loop?.publishedLibrary();
    if (!lib) return;
    try {
      const bytes = lib.toBytes();
      this.lbPorts[port]?.postMessage(
        { type: 'library', session: this.session, version: lib.version, bytes },
        [bytes.buffer as ArrayBuffer],
      );
    } finally {
      lib.free();
    }
  }

  private waitView(): SettleStatus {
    return waitView(this.consumed, this.factorWait?.file === true);
  }

  private finish(): void {
    const loop = this.loop;
    if (!loop || this.final) return;
    this.final = true;
    this.clock.span('publish', () => this.publish(loop.finalize()));
    this.det?.row('final', this.observed);
    this.status(0, 0);
  }

  private publish(lib: PublishedLibrary): void {
    this.clock.begin('publish');
    try {
      const version = lib.version;
      if (version !== this.version) {
        this.version = version;
        const tb = this.dt ? this.now() : 0;
        const bytes = lib.toBytes();
        this.dt?.add('publish.toBytes', this.now() - tb);
        this.det?.row('pub', this.observed, version, fnvBytes(bytes));
        this.dt?.add('publish.libraries', 1);
        // The main thread keeps the newest library's bytes for Extract.
        const mainBytes = bytes.slice();
        // Each look-back worker solves with the newest library (same port as its requests,
        // so it always has the version a request was taken with); a copy each.
        // (Pool workers only once in this run's pool: a worker this run never started has no use for it.)
        if (this.lbServes && !this.lbError) {
          const before = this.settlePorts().length;
          this.lbPorts.forEach((port, i) => {
            if (!port || this.lbPortOff[i] || (i > 0 && !this.lbRun[i])) return;
            const lbBytes = bytes.slice();
            port.postMessage({ type: 'library', session: this.session, version, bytes: lbBytes }, [
              lbBytes.buffer as ArrayBuffer,
            ]);
            if (i > 0) this.lbLib[i] = true;
          });
          const after = this.settlePorts().length;
          if (after !== before) this.bgSettle.bgs?.gov.setWorkers(after);
        }
        // A repeatable run: stamped with the batch it was published at (the fast loop adopts it a
        // fixed number of frames later).
        this.deps.toFast.postMessage(
          {
            type: 'library',
            session: this.session,
            version,
            bytes,
            ...(this.barrierOn ? { frame: this.batchEnd } : {}),
          },
          [bytes.buffer as ArrayBuffer],
        );
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
      this.clock.end();
    }
  }

  private settleView(d: Settle, done: boolean): SettleStatus {
    return settleView(d, done, {
      parallel: this.parallel,
      factorLive: this.factorLive,
      fileReason: this.fileReason,
    });
  }

  private lookbackStatus(loop: SlowLoopLike): LookbackStatus {
    const s = loop.lookbackStats();
    return lookbackStatus(s, {
      settling: this.finalSettle.state !== null || this.factorWait !== null,
      settle: this.finalSettle.state
        ? this.settleView(this.finalSettle.state, false)
        : this.factorWait
          ? this.waitView()
          : this.settleStatus,
      csettle: this.bgSettle.bgs ? this.bgSettleStatus(loop, this.bgSettle.bgs) : undefined,
      error: this.lbError,
    });
  }

  private bgSettleStatus(loop: SlowLoopLike, bgs: BgSettle): CsettleStatus {
    return bgSettleStatus(loop.settleStats(), bgs, this.settlePorts().length);
  }

  /** The work accounting so far (`SlowStatus.accounting`): the clock's buckets, the visit workers' sums, the look-back answers. */
  private workStatus(): WorkStatus {
    return workStatus({
      t: this.now(),
      workT0: this.workT0,
      clock: this.clock,
      waitN: this.waitN,
      waitSum: this.waitSum,
      waitLast: this.waitLast,
      waitMax: this.waitMax,
      visitBusy: this.visitBusy,
      settleVisitBusy: this.settleVisitBusy,
      lbWork: this.lbWork,
      lbDiscarded: this.lbDiscarded,
      lbPorts: this.lbPorts,
      lbPortBusy: this.lbPortBusy,
      lbPortEndBusy: this.lbPortEndBusy,
      settleWorkers: this.settlePorts().length,
      observed: this.observed,
      dt: this.dt,
      loop: this.loop,
    });
  }

  private status(batchMs: number, maxStepMs: number): void {
    this.clock.begin('publish');
    try {
      this.tm('status', () => this.statusInner(batchMs, maxStepMs));
      this.flushDetlog();
    } finally {
      this.clock.end();
    }
  }

  private statusInner(batchMs: number, maxStepMs: number): void {
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
      framesPerTile: loop.framesPerTile,
      reservoirWarning: loop.reservoirWarning,
      batchMs,
      maxStepMs,
      visitWorkers: this.visits.length,
      jobs: this.jobs,
      jobsInFlight: this.busy.filter((b) => b).length,
      visitMs: this.visitMsN > 0 ? this.visitMsSum / this.visitMsN : this.visitMs,
      jobOwnerMs: this.jobOwnerMs,
      work: loop.work,
      final: this.final,
      run: this.run,
      editScope: this.scope,
      ...(this.lbOn || this.factorOn ? { lookback: this.lookbackStatus(loop) } : {}),
      visitRate: visitRateCounters(loop.visitRateStats(), loop.visitSchedule()),
      ...(this.init?.repeatable
        ? {
            repeatable: {
              barrierWaits: this.barrierWaits,
              barrierWaitMs: this.barrierWaitMs,
              lateLibraries: this.lateLibraries,
            },
          }
        : {}),
    };
    // Last, so the snapshot includes the time spent building this status.
    status.accounting = this.workStatus();
    this.visitMs = status.visitMs;
    this.visitMsSum = 0;
    this.visitMsN = 0;
    const t = this.now();
    const transfer: Transferable[] = [];
    if (this.final || t - this.statusAt >= CELL_STATUS_EVERY_MS) {
      this.statusAt = t;
      const view = cellStatusView(loop.cellStatus());
      status.cellStatus = view;
      transfer.push(view.ids.buffer as ArrayBuffer, view.established.buffer as ArrayBuffer);
    }
    // With a run's final library: the cells' split-half noise (the Refine readout).
    if (this.final) {
      const noise = loop.footprintNoise();
      status.footprintNoise = noise;
      transfer.push(noise.buffer as ArrayBuffer);
    }
    // A checkpoint's "still moving" hint goes out once, with the next status.
    if (this.stillMoving) {
      status.stillMoving = this.stillMoving;
      transfer.push(this.stillMoving.buffer as ArrayBuffer);
      this.stillMoving = null;
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
    this.clock.reset();
    this.dt?.reset();
    this.workT0 = this.now();
    this.visitBusy = this.visits.map(() => 0);
    this.jobSettle = this.visits.map(() => false);
    this.settleVisitBusy = this.visits.map(() => 0);
    this.lbWork = emptyWorkByKind();
    this.lbDiscarded = emptyLookbackWork();
    this.waitN = 0;
    this.waitSum = 0;
    this.waitLast = 0;
    this.waitMax.clear();
    this.reviewed = [];
    for (const cancel of this.lbTimers) cancel?.();
    this.lbTimers = [];
    this.lbOn = false;
    this.factorOn = false;
    this.factorWait = null;
    this.factorLive = false;
    this.factorSource = null;
    this.lbFactors = [];
    this.factorFile = false;
    this.fileReason = undefined;
    this.askTimer?.();
    this.askTimer = null;
    this.lbReqs = [];
    // (The look-back worker's run is reset too, which lets a held request go.)
    this.lbHeld = null;
    this.lbPortOff = [];
    this.lbPortBusy = [];
    this.lbPortEndBusy = [];
    this.lbRun = [];
    this.lbLib = [];
    this.bgSettle.bgArm = null;
    this.lbFloor = 0;
    this.lbError = undefined;
    this.finalSettle.state = null;
    // (An answer in pieces: its buffer belongs to a session the look-back worker drops too.)
    this.bgSettle.bgs = null;
    this.settleStatus = undefined;
    this.stillMoving = null;
    // A batch waiting at the barrier goes on (and sees the loop gone).
    this.bar.abort();
    this.bar = new ApplyBarrier();
    this.batchEnd = 0;
    this.barrierWaits = 0;
    this.barrierWaitMs = 0;
    this.lateLibraries = 0;
  }
}
