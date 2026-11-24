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
 * last frame the run settles instead of ending at once, as part of Discover,
 * with the cell set frozen (`refine` scope): the settle pass (`settle.ts`,
 * qc_eval's `--settle-frames N --settle-batch 16`) has the look-back worker
 * re-read the recording once (at most `SETTLE.maxFrames` frames) and feeds
 * every frame to the ordinary `observe`, as a Refine pass does, with the
 * visits those frames earn; then a last round of visits on every tile, and
 * only then the final library.
 *
 * Settle during Discover ("Background settle", `SlowInit.csettle`, frames
 * only; `CSETTLE` in `settle.ts`): while a look-back Discover runs below Max,
 * the look-back worker also re-reads saved frames spread over the history
 * seen so far (`settleTake`), at the settle governor's rate (`SettleGovernor`:
 * re-read frames per second, at most the cap per live frame; `setCap`, `setPace`).
 * It is armed the first time the target goes below Max with a cap above 0,
 * so a run at Max never starts it. Their answers go into the footprint statistics
 * (`observeSettle`); held-out frames are not even solved. There are no
 * settle visits: Discover's own visits refine with the better statistics.
 * Need-driven look-back and these requests share the one look-back worker
 * and take turns when both have frames to ask for (or need-driven first,
 * `SlowInit.csettleNeedFirst`). The end settle runs after the last frame as
 * without it.
 *
 * Look-back pool (`setSettlePool`; S from the core count, `settlePoolSize`):
 * with S more look-back workers in the run (ports 1..S), worker 0 does
 * need-driven look-back and the end settle only, and workers 1..S take the
 * settle's chunks, one request out per worker. A pool worker joins a run
 * when the main thread says so (it may be mid-run; the main thread waits
 * until the worker has the run's back state) and serves from the library sent
 * to it at once (the current one) or later. A pool worker that fails is left out for the rest of
 * the run; with none left the settle takes turns on worker 0 again.
 */
import type {
  CsettleStatus,
  LookbackStatus,
  LookbackToSlow,
  SettleStatus,
  SlowToLookback,
} from '../workers/lookback-types.ts';
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
import type { OwnerToStrip, StripToOwner } from '../workers/strip-types.ts';
import { StripHelpers, type StripLoopLike } from './strip-helpers.ts';
import {
  CSETTLE,
  movedAgainstNoise,
  stillMovingRatios,
  truncatePlan,
  noiseMap,
  SETTLE,
  SettleFeed,
  SettleGovernor,
  settlePlan,
  unitFootprints,
} from './settle.ts';
import {
  addLookbackAnswer,
  DutyClock,
  emptyLookbackWork,
  LOOKBACK_KINDS,
  SLOW_DUTIES,
  WindowMax,
  type LookbackKind,
  type LookbackTiming,
  type LookbackWork,
  type SlowDuty,
  type WorkStatus,
} from './work-meter.ts';

/** The settle delta part of a look-back request. */
type SlowToLookbackDelta = NonNullable<Extract<SlowToLookback, { type: 'request' }>['delta']>;

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
export interface SlowLoopLike extends StripLoopLike {
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
  /** The last published library without publishing (none before the first; absent in older fakes). */
  publishedLibrary?(): PublishedLibrary | undefined;
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
  /** Never re-read a frame before `frame` again (a Joint run's current session; absent in older builds). */
  setLookbackFloor?(frame: number): void;
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
  /** `[id, noise, ...]`: split-half footprint noise of the newest library's cells (absent in older builds). */
  footprintNoise?(): Float64Array;
  /** Split-half noise of one cell on the given pixels (`footprintNoiseOn`; absent in older builds). */
  footprintNoiseOn?(id: number, support: Uint32Array): number;
  // Settle during Discover, frames only (see `SlowLoop.enableSettle`; absent in older fakes and builds).
  enableSettle?(chunk: number): void;
  /** `[frame, block, held, ...]`: saved frames to re-read among stream frames `0..seen`. */
  settleTake?(seen: number, max: number): Float64Array;
  /** `false`: held out (never fitted) or the version is gone. */
  observeSettle?(
    frame: Float32Array,
    version: number,
    traces: Float32Array,
    background: Float32Array | undefined,
    stream: number,
  ): boolean;
  /** Held-out frames of `settleTake` passed over without a solve. */
  settleSkipped?(frames: number): void;
  /** `[taken, fit, heldOut, dropped]`. */
  settleStats?(): Float64Array;
  // The settle delta (see `SlowLoop.settleContext`; absent in older fakes and builds).
  settleContext?(): Uint8Array;
  /** `false`: refused (a held-out frame in it). */
  applySettleDelta?(bytes: Uint8Array): boolean;
  settleDeltaStats?(): Float64Array;
  // The Final settle's delta (`SlowLoop.settleContextNext`; absent in older fakes and builds).
  /** Frames observed so far (the next frame's slow-loop index). */
  readonly frames?: number;
  settleContextNext?(): Uint8Array;
  /** `false`: not the next fitting frames (or the library is gone): observe them as usual. */
  applySettleDeltaNext?(bytes: Uint8Array, version: number, count: number): boolean;
  /** 1 per held-out slow-loop index of `first..first + count`. */
  heldOutFlags?(first: number, count: number): Uint8Array;
  /** `[ms, calls]`: `observe`'s time inside the slow loop (absent in older fakes and builds). */
  observeTiming?(): Float64Array;
  free(): void;
}

/**
 * Where the slow worker's `live` duty goes (cumulative ms; `SlowStatus.liveSplit`): the `observe`
 * calls (`observeCall`), of which `observeInner` inside the slow loop (the rest is copying the
 * frame, traces and background into WASM and the held-out record), the look-back bookkeeping after
 * each batch (`lookback`), the strip helpers' begin and apply, and the batch-end visit hand-out and
 * trimming (`housekeep`, `dispatch`; their own duties, listed here for the sum). Outside `live`:
 * the status message (`status`) and the frame buffer's ack (`ack`).
 */
export interface LiveSplit {
  observeCall: number;
  observeInner: number;
  frames: number;
  lookback: number;
  stripBegin: number;
  stripApply: number;
  status: number;
  ack: number;
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
  const lb = loop as T & {
    enableLookback?(rate: number, maxFrames: number): void;
  };
  lb.enableLookback?.(LOOKBACK.rate, LOOKBACK.maxFrames);
  // (The settle during Discover is enabled by `SlowRunner` when it is armed, below Max.)
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
  /** Ports to the strip helpers (`?debug&obsstrips=N`; none: off). */
  strips?: PortLike<OwnerToStrip>[];
  now?: () => number;
  /** Epoch clock for the batch wait (`FastToSlow` `sentAt`); default `performance.timeOrigin + performance.now()`. */
  epochNow?: () => number;
  /** Run `fn` as a later task (settling gives way between steps; default `setTimeout(fn, 0)`). */
  defer?: (fn: () => void) => void;
  /** Call `fn` after `ms` unless cancelled (default `setTimeout`). */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** One frame of an outstanding look-back request (no ids: a settle frame, for every cell). */
interface LookbackItem {
  frame: number;
  ids: Float64Array;
}

/**
 * The request out to the look-back worker: need-driven look-back (`need`),
 * the settle during Discover (`csettle`), or the end settle (`end`).
 */
interface LookbackReq {
  id: number;
  /** The look-back worker it went to (0: need-driven look-back and the end settle; 1..S: the settle pool). */
  port: number;
  kind: 'need' | 'csettle' | 'end';
  items: LookbackItem[];
  /** `csettle`: per frame, 1 = held out (not solved; never handed to the slow loop). */
  skip?: Uint8Array;
  /** `end` with the settle delta: the slow-loop index its first frame was predicted to get. */
  first?: number;
}

/** The Final settle's delta (`SlowInit.csettleDelta`; `SlowLoop.applySettleDeltaNext`). */
interface FinalDelta {
  /** The FOV went to look-back worker 0 with a request of this settle. */
  fovSent: boolean;
  /** The slow-loop index the next request's first frame will get. */
  nextIdx: number;
  applied: number;
  mismatched: number;
  contextBytes: number;
  deltaBytes: number;
  contextMs: number;
  buildMs: number;
}

/** An answer of the settle during Discover being fed to the slow loop. */
interface CsettleWork {
  msg: Extract<LookbackToSlow, { type: 'frames' }>;
  req: LookbackReq;
  /** Frames handled so far. */
  next: number;
}

/** Settle during Discover (`SlowInit.csettle`), for the current run, once armed. */
interface Csettle {
  /** The rate per second, the re-read frames owed, and the cap. */
  gov: SettleGovernor;
  /** The settle delta (`SlowInit.csettleDelta`; null: off, the frames come here). */
  delta: CsettleDelta | null;
  /** Frames per piece of an answer (0: whole answers). */
  yieldFrames: number;
  /** Worker 0 without a pool: need-driven look-back first, the settle only when it asks nothing (`SlowInit.csettleNeedFirst`). */
  needFirst: boolean;
  /** The next request is the settle's when both it and need-driven look-back have frames to ask for. */
  turn: boolean;
  /** The settle's own request on worker 0 failed or timed out: no more settle requests there this run (need-driven look-back goes on). */
  off: boolean;
  /** The answers in hand, when they are handled in pieces (at most one per look-back worker). */
  works: CsettleWork[];
  requested: number;
  /** Frames dropped here (an answer with no library yet, or one cut short by the end of Discover). */
  dropped: number;
  /** Live frames observed while Discover ran. */
  live: number;
  answers: number;
  answerMs: number;
  maxBlockMs: number;
}

/** The settle delta of the current run (`SlowInit.csettleDelta`). */
interface CsettleDelta {
  /** Per look-back worker: the FOV went with a request this run (the worker makes its builder from it). */
  fovSent: boolean[];
  applied: number;
  rejected: number;
  contextBytes: number;
  deltaBytes: number;
  contextMs: number;
  buildMs: number;
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

/** Settling, between Discover's last frame and the final library (`SlowRunner.settlePump`). */
interface Settle {
  /** `sweep`: the settle pass; `final`: the last visits on every tile. */
  phase: 'sweep' | 'final';
  feed: SettleFeed;
  /** Frames observed (fed through `observe`). */
  fed: number;
  recording: number;
  /** Next checkpoint at this many frames fed, and the footprints of the last one. */
  nextCheck: number;
  prev: ReturnType<typeof unitFootprints> | null;
  moving: { cells: number; above: number } | null;
  /** Steps of the final round so far (without visit workers: one). */
  finalSteps: number;
  /** With visit workers: work and visits at the start of the final round (its cap). */
  finalWork0: number;
  finalJobs0: number;
  /** Stop now (the user's Stop): publish the final library. */
  stop: boolean;
  statusAt: number;
  /** The settle delta (null: off, every frame's statistics are updated here). */
  delta: FinalDelta | null;
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
  // Work accounting (`lib/work-meter.ts`; reported in `SlowStatus.accounting`, never read back here).
  private readonly epochNow: () => number;
  private readonly clock: DutyClock<SlowDuty>;
  private workT0: number;
  private visitBusy: number[];
  private lbWork = emptyWorkByKind();
  /** Answers that arrived for a request no longer waited for (cancelled, timed out, stale). */
  private lbDiscarded = emptyLookbackWork();
  private waitN = 0;
  private waitSum = 0;
  private waitLast = 0;
  private readonly waitMax = new WindowMax(1000);
  /** History-review candidates waiting for the visits out to come back. */
  private reviewed: Float32Array[] = [];
  // ---- look-back ----
  /** Ports to the look-back workers: 0 for need-driven look-back and the end settle, 1..S the settle pool. */
  private lbPorts: (PortLike<SlowToLookback> | null)[];
  /** This run uses look-back (`SlowInit.lookback` and a loop that has it). */
  private lbOn = false;
  /** Per look-back worker: the request out to it (at most one each), and its timeout's cancel. */
  private lbReqs: (LookbackReq | null)[] = [];
  private lbNextId = 1;
  private lbTimers: ((() => void) | null)[] = [];
  /** Pool workers (1..S) left out for the rest of this run after a failure. */
  private lbPortOff: boolean[] = [];
  /** Per look-back worker: the busy ms of its answers this run (`WorkStatus.lookbackWorkerBusyMs`). */
  private lbPortBusy: number[] = [];
  /** The pacer's target and pause (`setPace`; kept across runs: the main thread sends it when it changes). */
  private pace = { fps: 0, paused: false };
  /** Stream index after the last live batch of this run (-1: none yet): a gap is a forward-pool drop. */
  private liveEnd = -1;
  /**
   * A Joint run: the first frame of the current session (`SlowInit.sessionStarts`).
   * Look-back and the settle during Discover never re-read a frame before it.
   */
  private lbFloor = 0;
  /** Look-back stopped by an error or a timeout (Discover and settling go on without it). */
  private lbError: string | undefined;
  private drain: Settle | null = null;
  /** Settle during Discover (null: not armed in this run). */
  private cs: Csettle | null = null;
  /** This run may arm the settle during Discover (`SlowInit.csettle` and a loop that has it), and how. */
  private csArm: {
    yieldFrames: number;
    needFirst: boolean;
    forwardPool: number;
    /** The settle delta (`SlowInit.csettleDelta`, whole answers and a loop that has it). */
    delta: boolean;
  } | null = null;
  /** The settle's cap, re-read frames per live frame (0 = Off; `setCap`; kept across runs like `pace`). */
  private cap: number = CSETTLE.rate;
  /** The settle pool the main thread started for a session (`setSettlePool`; applied when that run is here). */
  private pool: { session: number; workers: number } | null = null;
  /** Per look-back worker 1..S: in this run's settle pool, and sent a library this run (it serves from then on). */
  private lbRun: boolean[] = [];
  private lbLib: boolean[] = [];
  /** The settle's last status (kept for the final status after it ends). */
  private settleStatus: SettleStatus | undefined;
  /** Frames the last settle answer observed (`settleTail`). */
  private settleSteps = 0;
  /** The "still moving" hint of the newest checkpoint, sent with the next status (information only). */
  private stillMoving: Float64Array | null = null;
  private readonly defer: (fn: () => void) => void;
  private readonly timer: (fn: () => void, ms: number) => () => void;
  /** The strip helpers (none: off). */
  private readonly strips: StripHelpers;
  private split: LiveSplit = emptySplit();

  constructor(deps: SlowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.epochNow = deps.epochNow ?? (() => performance.timeOrigin + performance.now());
    this.clock = new DutyClock(SLOW_DUTIES, this.now);
    this.workT0 = this.now();
    this.visits = deps.visits ?? [];
    this.busy = this.visits.map(() => false);
    this.visitBusy = this.visits.map(() => 0);
    this.lbPorts = [deps.lookback ?? null];
    this.strips = new StripHelpers(deps.strips ?? [], this.now);
    this.defer = deps.defer ?? ((fn) => void setTimeout(fn, 0));
    this.timer =
      deps.timer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /**
   * The port to look-back worker `index` (0: need-driven look-back and the
   * end settle; 1..S: the settle pool). Runs with look-back started from now
   * on use it; a pool port serves once `setSettlePool` joins it to a run.
   */
  connectLookback(port: PortLike<SlowToLookback>, index = 0): void {
    this.lbPorts[index] = port;
    // A new worker on this port has no settle-delta builder yet: its first request brings the FOV.
    if (this.cs?.delta) this.cs.delta.fovSent[index] = false;
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
    if (this.cs) this.cs.gov.setTarget(this.pace.fps, this.pace.paused);
    else this.armSettle();
  }

  /**
   * The settle's cap, re-read frames per live frame (0 = Off), from the main
   * thread, during a run too (kept across runs; only the settle reads it).
   */
  setCap(cap: number): void {
    this.cap = Number.isFinite(cap) && cap > 0 ? cap : 0;
    if (this.cs) {
      this.cs.gov.setCap(this.cap);
      this.status(0, 0);
    } else this.armSettle();
  }

  /**
   * The main thread started look-back workers 1..`workers` for `session`'s
   * run (the settle pool; it may be mid-run) and have its back state: they
   * take the settle's chunks from the library sent to them (the current one at once).
   */
  setSettlePool(session: number, workers: number): void {
    this.pool = { session, workers: Math.max(0, Math.floor(workers)) };
    if (session === this.session && this.loop) this.joinPool(this.pool.workers);
  }

  /**
   * Pool workers 1..`workers` join this run. They get the current library at
   * once (a stable library publishes nothing new, so waiting for the next
   * publish could leave a late pool idle for the rest of the run).
   */
  private joinPool(workers: number): void {
    const before = this.settlePorts().length;
    for (let i = 1; i <= workers; i++) this.lbRun[i] = true;
    const loop = this.loop;
    if (!loop || !this.lbOn || this.lbError || this.version <= 0) return;
    const lib = loop.publishedLibrary?.();
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
    if (after !== before && this.cs) {
      this.cs.gov.setWorkers(after);
      this.status(0, 0);
    }
  }

  /**
   * Arm the settle during Discover the first time this run's target is below
   * Max with a cap above 0 (a run at Max never arms it: nothing changes there).
   */
  private armSettle(): void {
    const arm = this.csArm;
    const loop = this.loop;
    if (this.cs || !arm || !loop || !this.lookbackLive || !(this.pace.fps > 0) || !(this.cap > 0))
      return;
    loop.enableSettle?.(CSETTLE.chunk);
    const gov = new SettleGovernor(
      this.cap,
      Math.max(1, this.settlePorts().length),
      arm.forwardPool,
    );
    gov.setTarget(this.pace.fps, this.pace.paused);
    this.cs = {
      gov,
      delta: arm.delta
        ? {
            fovSent: [],
            applied: 0,
            rejected: 0,
            contextBytes: 0,
            deltaBytes: 0,
            contextMs: 0,
            buildMs: 0,
          }
        : null,
      yieldFrames: arm.yieldFrames,
      needFirst: arm.needFirst,
      turn: false,
      off: false,
      works: [],
      requested: 0,
      dropped: 0,
      live: 0,
      answers: 0,
      answerMs: 0,
      maxBlockMs: 0,
    };
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
      const steps = this.frameSteps(msg, true);
      // A strip batch yields the wait for its deltas; otherwise a give-way.
      for (let r = steps.next(); !r.done; r = steps.next()) await (r.value ?? pause());
    } catch (err) {
      this.fail(err);
    }
    // What came in while a strip batch waited, in arrival order.
    try {
      this.strips.release();
    } catch (err) {
      this.fail(err);
    }
  }

  /** A message from strip helper `i`. */
  handleStrip(i: number, msg: StripToOwner): void {
    try {
      this.strips.handle(i, msg);
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
        // Settle during Discover: only with look-back, and only when asked for.
        const csettle = lookback === true && msg.csettle === true;
        this.init = {
          width,
          height,
          fov,
          noise,
          cellDiameterPx,
          flattenSigmaPx,
          budget,
          ...(lookback ? { lookback: true } : {}),
          ...(csettle ? { csettle } : {}),
          ...(lookback && (msg.settleFraction ?? 1) < 1
            ? { settleFraction: msg.settleFraction }
            : {}),
          ...(lookback && msg.sessionStarts?.length
            ? { sessionStarts: [...msg.sessionStarts] }
            : {}),
          // The settle delta: the Final settle's, and with `csettle` the Background settle's.
          // (Not with the strip helpers: both would take the statistics off this worker.)
          ...(lookback && msg.csettleDelta && this.strips.count === 0
            ? { csettleDelta: true }
            : {}),
        };
        this.loop = this.clock.span('setup', () => this.deps.create(this.init!));
        this.run = 1;
        this.lbOn = lookback === true && typeof this.loop.lookbackTake === 'function';
        if (this.lbOn && !this.lbPort) this.lbError = 'The look-back worker is not connected.';
        if (
          this.lbOn &&
          csettle &&
          typeof this.loop.settleTake === 'function' &&
          typeof this.loop.observeSettle === 'function'
        ) {
          // The delta sums whole answers on the look-back worker: not with answers in pieces.
          const yieldFrames = Math.max(0, Math.floor(msg.csettleYield ?? 0));
          this.csArm = {
            yieldFrames,
            needFirst: msg.csettleNeedFirst === true,
            forwardPool: Math.max(2, Math.floor(msg.csettlePool ?? 2)),
            delta:
              this.init.csettleDelta === true &&
              yieldFrames === 0 &&
              typeof this.loop.settleContext === 'function' &&
              typeof this.loop.applySettleDelta === 'function',
          };
          this.armSettle();
        }
        if (this.pool?.session === msg.session) this.joinPool(this.pool.workers);
        for (const v of this.visits)
          v.postMessage({ type: 'init', session: msg.session, ...this.init });
        this.strips.init(msg.session, width, height, fov);
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
    if (msg.session !== this.session || !this.loop || this.ending || this.final || this.drain)
      return;
    if (this.strips.hold(() => this.handleReviewed(msg))) return;
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
    // Visit results write the statistics: after the strip batch waiting is applied.
    if (this.strips.hold(() => this.handleVisit(i, msg))) return;
    try {
      if (msg.type === 'error') throw new Error(`visit worker ${i}: ${msg.message}`);
      this.busy[i] = false;
      const t0 = this.now();
      this.clock.span('visit', () => this.loop!.applyJob!(msg.bytes));
      this.jobOwnerMs += this.now() - t0;
      this.jobs++;
      this.visitMsSum += msg.ms;
      this.visitMsN++;
      this.visitBusy[i] = (this.visitBusy[i] ?? 0) + msg.ms;
      this.housekeep();
      if (this.drain) {
        // The settle keeps its visit workers busy; the last round and a Stop wait for them.
        if (this.drain.phase === 'sweep' && !this.drain.stop) this.dispatch();
        else if (!this.busy.some((b) => b)) this.settlePump();
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
    for (const _ of this.frameSteps(msg, false));
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
  private *frameSteps(
    msg: Extract<FastToSlow, { type: 'frames' }>,
    async: boolean,
  ): Generator<Promise<void> | void, void> {
    const loop = this.loop;
    const init = this.init;
    let observed = 0;
    let maxStep = 0;
    const t0 = this.now();
    let batchWait = 0;
    // The wait in the inbox: sent by the fast worker (epoch clock) until processing starts here.
    if (msg.sentAt !== undefined) {
      // Not clamped: a negative reading would mean the two workers' clocks disagree.
      const wait = this.epochNow() - msg.sentAt;
      batchWait = wait;
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
        if (msg.noise) {
          loop.setNoise(msg.noise);
          for (const v of this.visits)
            v.postMessage({ type: 'noise', session: this.session, noise: msg.noise });
        }
        const px = init.width * init.height;
        const bg = msg.background;
        const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
        // Strip helpers (Discover with visit workers only: visits come after the batch there).
        const t1 = this.now();
        const striped =
          async &&
          this.parallel &&
          this.scope === 'all' &&
          this.strips.begin(
            loop,
            msg.version,
            {
              width: init.width,
              height: init.height,
              frames: msg.frames,
              traces: msg.traces,
              cells: msg.cells,
              background: bg,
              count: msg.count,
            },
            'live',
          );
        this.split.stripBegin += this.now() - t1;
        const inner0 = loop.observeTiming?.()[0] ?? 0;
        const t2 = this.now();
        for (let i = 0; i < msg.count; i++) {
          const frame = msg.frames.subarray(i * px, (i + 1) * px);
          const traces = msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells);
          const background = bg?.subarray(i * nb, (i + 1) * nb);
          // The stream index records the frame's held-out decision for look-back
          // (required with it on); without look-back the call is as before.
          const stream = this.lbOn ? msg.start + i : undefined;
          const tc = this.now();
          const ok = loop.observe(frame, msg.version, traces, background, stream);
          this.split.observeCall += this.now() - tc;
          this.split.frames++;
          if (!ok) {
            this.skipped++;
            continue;
          }
          observed++;
          this.observed++;
          this.frame = msg.start + i + 1;
          if (this.parallel) {
            // Refine only: Discover keeps its timing (it drops batches instead).
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
        this.split.observeInner += (loop.observeTiming?.()[0] ?? 0) - inner0;
        void t2;
        if (striped) {
          // The batch's deltas: the slow worker waits (idle) for the slowest helper.
          endLive();
          yield new Promise<void>((resolve) => this.strips.whenDone(resolve));
          // The run was dropped meanwhile.
          if (this.loop !== loop) return;
          beginLive();
          const ta = this.now();
          this.strips.apply(loop);
          this.split.stripApply += this.now() - ta;
        }
        if (this.parallel) {
          const s = this.now();
          this.housekeep();
          maxStep = this.now() - s;
          this.dispatch();
        }
        const tl = this.now();
        if (this.lookbackLive) {
          this.sessionFloor(loop, msg.start);
          loop.lookbackNote!(msg.start + msg.count, observed);
          if (this.cs) {
            this.cs.live += observed;
            // A batch that does not follow the last one: the forward pool dropped the ones between.
            const gap = this.liveEnd >= 0 && msg.start > this.liveEnd;
            this.cs.gov.liveBatch(
              msg.sentAt ?? this.epochNow(),
              msg.start + msg.count,
              msg.count,
              batchWait,
              gap,
            );
          }
          this.liveEnd = Math.max(this.liveEnd, msg.start + msg.count);
          this.lookbackRequest();
        }
        this.split.lookback += this.now() - tl;
      }
    } finally {
      endLive();
      const tk = this.now();
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
      this.split.ack += this.now() - tk;
    }
    const ts = this.now();
    this.status(this.now() - t0, maxStep);
    this.split.status += this.now() - ts;
  }

  /** Trimming decisions and, when due, a new library (parallel mode). */
  private housekeep(): void {
    this.clock.span('housekeep', () => {
      const lib = this.loop?.housekeep!();
      if (lib) this.publish(lib);
    });
  }

  /** A tile visit to every idle visit worker, while any is due; returns how many were handed out. */
  private dispatch(): number {
    const loop = this.loop;
    // Reviewed cells wait for the visits out: hand out no new one meanwhile.
    if (!loop || this.ending || this.reviewed.length > 0) return 0;
    return this.clock.span('visit', () => {
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
      this.drain === null
    );
  }

  /**
   * With no request out, the next one to the look-back worker (returns
   * whether one went out): the frames the look-back scheduler wants now
   * (budget permitting), or a chunk of the settle during Discover when one
   * is owed. The two take turns when both have frames to ask for, so neither
   * starves the other when the look-back worker is the slower side (a
   * recording read at full speed); when it keeps up, both get all they ask.
   */
  private lookbackRequest(): boolean {
    const loop = this.loop;
    if (!loop || !this.lbOn || this.lbError !== undefined) return false;
    const cs = this.cs;
    // The governor checks (once a second) and earns up to now before any request.
    cs?.gov.update(this.epochNow(), this.version > 0);
    const pool = this.settlePorts();
    let sent = false;
    if (this.lbPort && !this.lbReqs[0]) {
      // With a settle pool, worker 0 is need-driven only.
      if (pool.length > 0 || !cs) sent = this.needRequest(loop);
      else sent = this.turnRequest(loop, cs);
    }
    if (cs)
      for (const i of pool) {
        if (this.lbReqs[i]) continue;
        if (!this.csettleRequest(loop, cs, i)) break;
        sent = true;
      }
    return sent;
  }

  /**
   * Worker 0 without a settle pool: need-driven look-back and the settle take
   * turns, or with `needFirst` the settle asks only when look-back asks nothing.
   */
  private turnRequest(loop: SlowLoopLike, cs: Csettle): boolean {
    if (cs.needFirst) return this.needRequest(loop) || this.csettleRequest(loop, cs, 0);
    if (cs.turn && this.csettleRequest(loop, cs, 0)) return true;
    if (this.needRequest(loop)) {
      cs.turn = true;
      return true;
    }
    return !cs.turn && this.csettleRequest(loop, cs, 0);
  }

  /** Send a request to look-back worker `port` and start its timeout. */
  private sendRequest(
    port: number,
    kind: LookbackReq['kind'],
    flat: Float64Array,
    items: LookbackItem[],
    skip?: Uint8Array,
    delta?: SlowToLookbackDelta,
    first?: number,
  ): void {
    const id = this.lbNextId++;
    this.lbReqs[port] = {
      id,
      port,
      kind,
      items,
      ...(skip ? { skip } : {}),
      ...(first !== undefined ? { first } : {}),
    };
    // `flat` is a fresh array (from WASM or built here): transferred as is; `skip` is copied.
    this.clock.span(kind, () =>
      this.lbPorts[port]!.postMessage(
        {
          type: 'request',
          session: this.session,
          id,
          items: flat,
          ...(skip ? { skip: skip.slice() } : {}),
          ...(delta ? { delta } : {}),
        },
        delta
          ? [flat.buffer as ArrayBuffer, delta.context.buffer as ArrayBuffer]
          : [flat.buffer as ArrayBuffer],
      ),
    );
    this.lbTimers[port] = this.timer(() => {
      const failed = this.lbReqs[port];
      if (failed?.id !== id) return;
      this.lbTimers[port] = null;
      this.lbReqs[port] = null;
      const why = `no answer within ${LOOKBACK.timeoutMs / 1000} s`;
      // The settle's own request only turns the settle off; look-back and the end settle go on.
      if (failed.kind === 'csettle') this.csettleFailed(failed, why);
      else this.lookbackFailed(why);
      if (this.drain) this.settlePump();
      else if (this.lookbackLive) this.lookbackRequest();
    }, LOOKBACK.timeoutMs);
  }

  /**
   * A Joint run: the batch from stream frame `start` is in the session that
   * starts at the last session start at or before it (not only at it: the
   * forward pool may have dropped the session's first batches). Look-back
   * moves its floor there (`setLookbackFloor`): from now on it re-reads the
   * current session only.
   */
  private sessionFloor(loop: SlowLoopLike, start: number): void {
    let floor = this.lbFloor;
    for (const b of this.init?.sessionStarts ?? []) if (b <= start && b > floor) floor = b;
    if (floor === this.lbFloor) return;
    this.lbFloor = floor;
    loop.setLookbackFloor?.(floor);
  }

  /** Need-driven look-back: the frames the scheduler wants now. */
  private needRequest(loop: SlowLoopLike): boolean {
    const took = this.clock.span('need', () => loop.lookbackTake!(LOOKBACK.takeMax));
    // (A build without `setLookbackFloor` may still hand out an earlier session's frames.)
    const flat = this.lbFloor > 0 ? framesFrom(took, this.lbFloor) : took;
    if (flat.length === 0) return false;
    this.sendRequest(0, 'need', flat, lookbackItems(flat));
    return true;
  }

  /**
   * Settle during Discover: one chunk of saved frames to look-back worker
   * `port`, when a whole chunk is owed (`SettleGovernor`)
   * and no answer of that worker is still being fed in pieces.
   */
  private csettleRequest(loop: SlowLoopLike, cs: Csettle, port: number): boolean {
    // No settle reads before the first library: the look-back worker would solve nothing.
    if (
      (port === 0 && cs.off) ||
      cs.works.some((w) => w.req.port === port) ||
      !cs.gov.ready ||
      !this.lookbackLive ||
      this.version <= 0
    )
      return false;
    // The frames forwarded so far are the saved history (stream index = file frame).
    const take = this.clock.span('csettle', () => loop.settleTake!(this.consumed, CSETTLE.chunk));
    // The current session only (as `needRequest`: a build without the floor may go earlier).
    const keep: number[] = [];
    for (let i = 0; 3 * i + 2 < take.length; i++) if (take[3 * i] >= this.lbFloor) keep.push(i);
    const n = keep.length;
    if (n === 0) return false;
    const flat = new Float64Array(3 * n);
    const skip = new Uint8Array(n);
    const items: LookbackItem[] = [];
    keep.forEach((k, i) => {
      flat[3 * i] = take[3 * k];
      flat[3 * i + 1] = take[3 * k + 1];
      skip[i] = take[3 * k + 2] > 0 ? 1 : 0;
      items.push({ frame: take[3 * k], ids: new Float64Array(0) });
    });
    cs.gov.spend(n);
    cs.requested += n;
    if (port === 0) cs.turn = false;
    const d = cs.delta;
    let delta: { context: Uint8Array; fov?: Uint8Array } | undefined;
    if (d) {
      // The context is made now: the cells and stores as they are when the chunk is asked for.
      const t0 = this.now();
      const context = this.clock.span('csettle', () => loop.settleContext!());
      d.contextMs += this.now() - t0;
      d.contextBytes += context.byteLength;
      delta = { context };
      if (!d.fovSent[port]) {
        delta.fov = this.init!.fov.slice();
        d.fovSent[port] = true;
      }
    }
    this.sendRequest(port, 'csettle', flat, items, skip, delta);
    return true;
  }

  /**
   * A settle request failed (its frames count as dropped): on worker 0 the
   * settle there is off for the rest of this run; a pool worker is left out
   * for the rest of the run (the others go on; with none left, the settle
   * takes turns on worker 0 again).
   */
  private csettleFailed(req: LookbackReq, message: string): void {
    const cs = this.cs;
    if (!cs) return;
    cs.dropped += req.items.length;
    if (req.port > 0) {
      this.lbPortOff[req.port] = true;
      cs.gov.setWorkers(this.settlePorts().length);
      console.warn(`cala settle look-back worker ${req.port} stopped: ${message}`);
    } else {
      cs.off = true;
      console.warn(`cala settle during Discover stopped: ${message}`);
    }
    this.status(0, 0);
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
    if (msg.session === this.session && this.strips.hold(() => this.handleLookback(msg, port)))
      return;
    const loop = this.loop;
    const req = this.lbReqs[port] ?? null;
    const answer = msg.type === 'frames' || msg.type === 'delta';
    if (answer && msg.session === this.session && msg.timing)
      this.lbPortBusy[port] = (this.lbPortBusy[port] ?? 0) + timingBusyMs(msg.timing);
    if (msg.session !== this.session || !loop || !req || msg.id !== req.id) {
      // Its time was spent all the same: counted apart (only this session's).
      if (answer && msg.session === this.session)
        addLookbackAnswer(this.lbDiscarded, msg.count, msg.timing);
      // An ignored answer still returns its buffer to its worker's pool (which drops a stale session's).
      if (msg.type === 'frames') this.releaseFrames(msg, port);
      return;
    }
    this.lbReqs[port] = null;
    this.lbTimers[port]?.();
    this.lbTimers[port] = null;
    if (answer) {
      addLookbackAnswer(this.lbWork[req.kind], msg.count, msg.timing);
      const busy = msg.timing ? timingBusyMs(msg.timing) : 0;
      if (req.kind === 'csettle') this.cs?.gov.delivered(msg.count, busy);
      // Taking turns (no settle pool): worker 0 is the settle's worker, so its need-driven
      // time counts towards its busy share too (else a full worker reads as "slow worker").
      else if (port === 0 && this.settlePorts().length === 0) this.cs?.gov.delivered(0, busy);
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
    const settle = req.kind === 'end' ? this.drain : null;
    try {
      if (msg.type === 'error') {
        if (req.kind === 'csettle') this.csettleFailed(req, msg.message);
        else this.lookbackFailed(msg.message);
      } else if (msg.type === 'delta') {
        // Only the settle during Discover asks for deltas; one that came when Discover could no
        // longer use it is counted as dropped.
        if (req.kind === 'csettle' && this.cs?.delta && this.lookbackLive) {
          this.csettleDeltaAnswer(loop, this.cs, this.cs.delta, msg, req);
          return;
        }
        if (this.cs) this.cs.dropped += req.items.length;
      } else if (req.kind === 'csettle' && this.cs && this.lookbackLive) {
        // (It gives the buffer back itself, at once or after its last piece.)
        this.csettleAnswer(loop, this.cs, msg, req);
        return;
      } else {
        if (settle) {
          // The next request goes out first: the look-back worker reads and
          // solves it while these frames are observed here.
          if (!settle.stop && !settle.feed.done) this.settleRequest();
          // Strip helpers: the rest (the visits, the buffer back, the next step) once the
          // chunk's statistics are added.
          if (this.observeSettle(loop, msg, req.items, req)) {
            this.strips.whenDone(() =>
              this.clock.span('end', () => {
                try {
                  if (this.loop !== loop) return;
                  this.strips.apply(loop);
                  this.settleTail(loop);
                  this.releaseFrames(msg, req.port);
                  if (this.drain) this.settlePump();
                } catch (err) {
                  this.fail(err);
                  return;
                }
                this.strips.release();
              }),
            );
            return;
          }
        } else if (req.kind === 'need') this.observeLookback(loop, msg, req.items);
        // A settle answer that came when Discover could no longer use it: counted as dropped.
        if (req.kind === 'csettle' && this.cs) this.cs.dropped += req.items.length;
        // The buffer goes back to the look-back worker's pool (never detached here).
        this.releaseFrames(msg, req.port);
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.drain) this.settlePump();
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

  /** An answer's frame buffer, back to the pool of the look-back worker it came from. */
  private releaseFrames(msg: Extract<LookbackToSlow, { type: 'frames' }>, port: number): void {
    this.lbPorts[port]?.postMessage({ type: 'release', session: msg.session, frames: msg.frames }, [
      msg.frames.buffer as ArrayBuffer,
    ]);
  }

  /**
   * An answer of the settle during Discover. Whole (the default, as qc_eval
   * measured it): the next request goes out first, so the look-back worker
   * reads on while every frame of this answer is fed here in one go. In
   * pieces (`SlowInit.csettleYield`): `yieldFrames` frames, then this worker
   * gives way to the batches and visit results waiting, and so on; the next
   * settle request waits for the last piece.
   */
  private csettleAnswer(
    loop: SlowLoopLike,
    cs: Csettle,
    msg: Extract<LookbackToSlow, { type: 'frames' }>,
    req: LookbackReq,
  ): void {
    if (msg.count !== req.items.length)
      throw new Error(`settle: ${msg.count} frames for a request of ${req.items.length}`);
    const work: CsettleWork = { msg, req, next: 0 };
    cs.answers++;
    if (cs.yieldFrames > 0) {
      cs.works.push(work);
      // Need-driven look-back may use the worker meanwhile.
      this.lookbackRequest();
      this.csettlePiece(work);
      return;
    }
    this.lookbackRequest();
    this.csettleFeed(loop, cs, work, msg.count);
    this.releaseFrames(msg, req.port);
  }

  /**
   * A settle delta (`SlowInit.csettleDelta`): the next request goes out
   * first, then the chunk's statistics are added here in one go
   * (`applySettleDelta`), in place of feeding its frames.
   */
  private csettleDeltaAnswer(
    loop: SlowLoopLike,
    cs: Csettle,
    d: CsettleDelta,
    msg: Extract<LookbackToSlow, { type: 'delta' }>,
    req: LookbackReq,
  ): void {
    if (msg.count !== req.items.length)
      throw new Error(`settle: ${msg.count} frames for a request of ${req.items.length}`);
    cs.answers++;
    this.lookbackRequest();
    const t0 = this.now();
    d.deltaBytes += msg.bytes.byteLength;
    d.buildMs += msg.deltaMs ?? 0;
    if (msg.version === 0) {
      // The worker had no library yet: nothing was solved or summed.
      cs.dropped += msg.count;
    } else {
      let skipped = 0;
      for (let i = 0; i < msg.count; i++) if (req.skip?.[i]) skipped++;
      if (loop.applySettleDelta!(msg.bytes)) d.applied++;
      else d.rejected++;
      if (skipped > 0) loop.settleSkipped?.(skipped);
    }
    if (this.parallel) {
      this.housekeep();
      this.dispatch();
    }
    const ms = this.now() - t0;
    cs.answerMs += ms;
    cs.maxBlockMs = Math.max(cs.maxBlockMs, ms);
  }

  /** The next piece of an answer handled in pieces; then give way, or finish. */
  private csettlePiece(work: CsettleWork): void {
    const cs = this.cs;
    const loop = this.loop;
    // Dropped meanwhile (a reset, an error, the end of Discover): nothing left to do.
    if (!cs || !loop || !cs.works.includes(work)) return;
    this.clock.span('csettle', () => this.csettleFeed(loop, cs, work, cs.yieldFrames));
    if (work.next < work.msg.count) {
      this.defer(() => {
        try {
          this.csettlePiece(work);
        } catch (err) {
          this.fail(err);
        }
      });
      return;
    }
    cs.works.splice(cs.works.indexOf(work), 1);
    this.releaseFrames(work.msg, work.req.port);
    if (this.lookbackLive) this.lookbackRequest();
  }

  /**
   * Feed the next `n` frames of an answer to the footprint statistics
   * (`observeSettle`): held-out frames are passed over (they were not
   * solved); then the visits waiting are handed out, as after any message.
   */
  private csettleFeed(loop: SlowLoopLike, cs: Csettle, work: CsettleWork, n: number): void {
    const init = this.init!;
    const { msg, req } = work;
    const t0 = this.now();
    const end = Math.min(msg.count, work.next + Math.max(1, n));
    // Version 0: the worker had no library yet, nothing was solved.
    if (msg.version === 0) {
      cs.dropped += end - work.next;
      work.next = end;
      return;
    }
    const px = init.width * init.height;
    const bg = msg.background;
    const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
    let skipped = 0;
    for (let i = work.next; i < end; i++) {
      if (req.skip?.[i]) {
        skipped++;
        continue;
      }
      loop.observeSettle!(
        msg.frames.subarray(i * px, (i + 1) * px),
        msg.version,
        msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
        bg?.subarray(i * nb, (i + 1) * nb),
        req.items[i].frame,
      );
    }
    if (skipped > 0) loop.settleSkipped?.(skipped);
    work.next = end;
    if (this.parallel) {
      this.housekeep();
      this.dispatch();
    }
    const ms = this.now() - t0;
    cs.answerMs += ms;
    cs.maxBlockMs = Math.max(cs.maxBlockMs, ms);
  }

  /** Discover is over: answers still being fed in pieces are dropped (their buffers go back). */
  private csettleStop(): void {
    const cs = this.cs;
    if (!cs) return;
    for (const work of cs.works.splice(0)) {
      cs.dropped += work.msg.count - work.next;
      this.releaseFrames(work.msg, work.req.port);
    }
  }

  /**
   * Every request out is no longer waited for (their late answers are
   * ignored and their buffers go back); a settle request's frames count as
   * dropped, so re-read = fitted + held out + dropped.
   */
  private cancelRequests(): void {
    for (let i = 0; i < this.lbReqs.length; i++) {
      const req = this.lbReqs[i];
      if (!req) continue;
      if (req.kind === 'csettle' && this.cs) this.cs.dropped += req.items.length;
      this.lbReqs[i] = null;
      this.lbTimers[i]?.();
      this.lbTimers[i] = null;
    }
  }

  /** The user's "Stop settling": publish the final library now, with what was refined. */
  stopSettling(session: number): void {
    if (session === this.session && this.strips.hold(() => this.stopSettling(session))) return;
    const d = this.drain;
    if (session !== this.session || !d) return;
    d.stop = true;
    // A request out is not waited for (its late answer is ignored).
    this.cancelRequests();
    this.settlePump();
  }

  /** Discover's last frame with look-back on: settle (see `settlePump`). */
  private startDrain(): void {
    const loop = this.loop!;
    loop.setEditScope?.('refine');
    this.scope = 'refine';
    // Review candidates would wait for every visit out; Discover is over.
    this.reviewed = [];
    this.csettleStop();
    // Requests of Discover's look-back still out are dropped (their late answers are ignored).
    this.cancelRequests();
    // The frames Discover forwarded: the recording (stream index = file frame).
    const recording = this.consumed;
    const feed = new SettleFeed(
      truncatePlan(settlePlan(recording), this.init?.settleFraction ?? 1),
    );
    this.drain = {
      phase: 'sweep',
      feed,
      fed: 0,
      recording,
      nextCheck: SETTLE.checkEvery,
      prev: null,
      moving: null,
      finalSteps: 0,
      finalWork0: 0,
      finalJobs0: 0,
      stop: false,
      statusAt: this.now(),
      delta:
        this.init?.csettleDelta &&
        typeof loop.settleContextNext === 'function' &&
        typeof loop.applySettleDeltaNext === 'function' &&
        typeof loop.heldOutFlags === 'function' &&
        typeof loop.frames === 'number'
          ? {
              fovSent: false,
              nextIdx: loop.frames,
              applied: 0,
              mismatched: 0,
              contextBytes: 0,
              deltaBytes: 0,
              contextMs: 0,
              buildMs: 0,
            }
          : null,
    };
    // The look-back worker solves with the library Discover ended with
    // (qc_eval publishes it before the settle); the first checkpoint's reference.
    this.drain.prev = this.checkpointLibrary(loop);
    this.status(0, 0);
    this.settlePump();
  }

  /**
   * Publish the slow loop's current library (`finalize`) and return its
   * unit-peak footprints (a settle checkpoint).
   */
  private checkpointLibrary(loop: SlowLoopLike): ReturnType<typeof unitFootprints> {
    const lib = this.clock.span('end', () => loop.finalize());
    const fps = unitFootprints({
      ids: lib.ids(),
      starts: lib.supportStarts(),
      pixels: lib.supportPixels(),
      values: lib.footprintValues(),
    });
    this.publish(lib);
    return fps;
  }

  /** A checkpoint: publish, and count the cells that moved more than `SETTLE.movingK` x their noise since the last. */
  private settleCheckpoint(loop: SlowLoopLike, d: Settle): void {
    const now = this.checkpointLibrary(loop);
    const noise = loop.footprintNoise ? noiseMap(loop.footprintNoise()) : null;
    if (d.prev && noise) {
      const m = movedAgainstNoise(d.prev, now, noise, SETTLE.movingK);
      d.moving = { cells: m.cells, above: m.aboveK };
    }
    this.noteStillMoving(loop, d.prev, now);
    d.prev = now;
  }

  /**
   * The per-cell "still moving" hint of the step between two checkpoints
   * (see `stillMovingRatios`); every checkpoint spans the same number of
   * frames, so values mean the same at every Final-settle level.
   */
  private noteStillMoving(
    loop: SlowLoopLike,
    before: ReturnType<typeof unitFootprints> | null,
    after: ReturnType<typeof unitFootprints>,
  ): void {
    const on = loop.footprintNoiseOn;
    if (!before || !on) return;
    this.stillMoving = stillMovingRatios(before, after, (id, px) => on.call(loop, id, px));
  }

  /**
   * Settling, event-driven (qc_eval's `LookBack::settle` with `--settle-batch
   * 16`): the next `SETTLE.batch` frames of the plan go to the look-back
   * worker; an answer is observed through the ordinary `observe` (the next
   * request is already out), and then earns its visits (`step` at the summed
   * budget here; with visit workers, the due tiles are handed out). A
   * checkpoint every `SETTLE.checkEvery` frames publishes the library. When
   * the plan is fed (or look-back fails), a last round of visits on every
   * tile, then the final library. A Stop publishes the final library once
   * the visits out are back.
   */
  private settlePump(): void {
    this.clock.span('end', () => this.settlePumpInner());
  }

  private settlePumpInner(): void {
    const d = this.drain;
    const loop = this.loop;
    const init = this.init;
    if (!d || !loop || !init) return;
    if (d.stop) {
      if (!this.busy.some((b) => b)) this.finishDrain();
      return;
    }
    if (d.phase === 'sweep') {
      const failed = this.lbError !== undefined || !this.lbPort;
      if (!this.lbReqs[0] && !d.feed.done && !failed) this.settleRequest();
      if (!this.lbReqs[0] && (d.feed.done || failed)) {
        d.phase = 'final';
        d.finalWork0 = loop.work ?? 0;
        d.finalJobs0 = this.jobs;
        loop.markAllDue?.();
        this.status(0, 0);
      } else return;
    }
    // The last round of visits.
    if (this.busy.some((b) => b)) return;
    if (this.parallel) {
      this.housekeep();
      // The same cap as without workers (`SETTLE.finalSteps` budgets of work):
      // visits keep making tiles due again, so "until none is due" may not end.
      const capped =
        (loop.work ?? 0) - d.finalWork0 >= init.budget * SETTLE.finalSteps ||
        this.jobs - d.finalJobs0 >= SETTLE.finalVisitsMax;
      if (!capped && this.dispatch() > 0) return;
    } else if (d.finalSteps === 0) {
      d.finalSteps++;
      const lib = loop.step(init.budget * SETTLE.finalSteps);
      if (lib) this.publish(lib);
    }
    this.finishDrain();
  }

  /** The next settle frames to the look-back worker. */
  private settleRequest(): void {
    const d = this.drain!;
    const frames = d.feed.take(SETTLE.batch);
    if (frames.length === 0) return;
    const flat = new Float64Array(3 * frames.length);
    frames.forEach((f, i) => {
      flat[3 * i] = f.frame;
      flat[3 * i + 1] = f.block;
    });
    const items = frames.map((f) => ({ frame: f.frame, ids: new Float64Array(0) }));
    const fd = d.delta;
    const loop = this.loop;
    if (!fd || !loop) {
      this.sendRequest(0, 'end', flat, items);
      return;
    }
    // The settle delta: the frames get the next slow-loop indices (this request goes out before
    // the answer before it is observed, so after that answer's frames); the context is made now.
    const first = fd.nextIdx;
    fd.nextIdx += frames.length;
    const t0 = this.now();
    const context = loop.settleContextNext!();
    const held = loop.heldOutFlags!(first, frames.length);
    fd.contextMs += this.now() - t0;
    fd.contextBytes += context.byteLength;
    const delta: SlowToLookbackDelta = { context, next: { first, held } };
    if (!fd.fovSent) {
      delta.fov = this.init!.fov.slice();
      fd.fovSent = true;
    }
    this.sendRequest(0, 'end', flat, items, undefined, delta, first);
  }

  /**
   * A settle answer: every frame through `observe`, then the visits they earn (`settleTail`).
   * Returns `true` when the strip helpers sum the chunk's statistics: the caller runs the tail
   * once they are added.
   */
  private observeSettle(
    loop: SlowLoopLike,
    msg: Extract<LookbackToSlow, { type: 'frames' }>,
    items: LookbackItem[],
    req?: LookbackReq,
  ): boolean {
    const d = this.drain!;
    const init = this.init!;
    if (msg.count !== items.length)
      throw new Error(`settle: ${msg.count} frames for a request of ${items.length}`);
    const px = init.width * init.height;
    const bg = msg.background;
    const nb = bg && msg.count > 0 ? bg.length / msg.count : 0;
    let n = 0;
    const fd = d.delta;
    if (fd && msg.delta) {
      fd.deltaBytes += msg.delta.bytes.byteLength;
      fd.buildMs += msg.delta.ms;
      // Added before the frames go through `observe`, which then leaves the statistics alone.
      if (msg.version !== 0 && loop.applySettleDeltaNext!(msg.delta.bytes, msg.version, msg.count))
        fd.applied++;
      else fd.mismatched++;
    }
    const before = loop.frames;
    const striped =
      msg.version !== 0 &&
      this.parallel &&
      !fd &&
      this.strips.begin(
        loop,
        msg.version,
        {
          width: init.width,
          height: init.height,
          frames: msg.frames,
          traces: msg.traces,
          cells: msg.cells,
          background: bg,
          count: msg.count,
        },
        'end',
      );
    // Version 0: the worker had no library yet, nothing was solved.
    if (msg.version !== 0)
      for (let i = 0; i < msg.count; i++) {
        // The stream index is required with look-back on; nothing reads it after Discover.
        const ok = loop.observe(
          msg.frames.subarray(i * px, (i + 1) * px),
          msg.version,
          msg.traces.subarray(i * msg.cells, (i + 1) * msg.cells),
          bg?.subarray(i * nb, (i + 1) * nb),
          items[i].frame,
        );
        if (ok) n++;
        else this.skipped++;
      }
    // A prediction that missed (frames not observed): the requests from the one after the next
    // are predicted from where the slow loop is now.
    if (fd && req && req.first !== undefined && before !== undefined && loop.frames !== undefined) {
      if (before !== req.first || loop.frames !== req.first + msg.count) {
        const out = this.lbReqs[0];
        fd.nextIdx = loop.frames + (out?.kind === 'end' ? out.items.length : 0);
      }
    }
    d.fed += msg.count;
    this.settleSteps = n;
    if (striped) return true;
    this.settleTail(loop);
    return false;
  }

  /** The visits a settle answer's frames earn, the checkpoint and the status. */
  private settleTail(loop: SlowLoopLike): void {
    const d = this.drain;
    const init = this.init;
    if (!d || !init) return;
    const n = this.settleSteps;
    if (this.parallel) {
      this.housekeep();
      this.dispatch();
    } else if (n > 0) {
      const lib = loop.step(init.budget * n);
      if (lib) this.publish(lib);
    }
    if (d.fed >= d.nextCheck) {
      d.nextCheck += SETTLE.checkEvery;
      this.settleCheckpoint(loop, d);
    }
    if (this.now() - d.statusAt >= 250) {
      d.statusAt = this.now();
      this.status(0, 0);
    }
  }

  private finishDrain(): void {
    const d = this.drain;
    if (d) this.settleStatus = this.settleView(d, true);
    this.drain = null;
    this.finish();
  }

  private end(): void {
    const loop = this.loop;
    if (!loop || this.final || this.ending || this.drain) return;
    // A look-back Discover settles first (`settlePump`).
    if (this.lbOn && this.run === 1) {
      this.clock.span('end', () => this.startDrain());
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
    this.clock.span('publish', () => this.publish(loop.finalize()));
    this.status(0, 0);
  }

  private publish(lib: PublishedLibrary): void {
    this.clock.begin('publish');
    try {
      const version = lib.version;
      if (version !== this.version) {
        this.version = version;
        const bytes = lib.toBytes();
        // The main thread keeps the newest library's bytes for pass 2.
        const mainBytes = bytes.slice();
        // Each look-back worker solves with the newest library (same port as its requests,
        // so it always has the version a request was taken with); a copy each.
        // (Pool workers only once in this run's pool: a worker this run never started has no use for it.)
        if (this.lbOn && !this.lbError) {
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
          if (after !== before) this.cs?.gov.setWorkers(after);
        }
        // The strip helpers sum batches of this version from now on (a copy each).
        this.strips.library(version, bytes);
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
      this.clock.end();
    }
  }

  private settleView(d: Settle, done: boolean): SettleStatus {
    const fd = d.delta;
    return {
      fed: d.fed,
      total: d.feed.total,
      recording: d.recording,
      moving: d.moving,
      stopped: d.stop,
      done,
      ...(fd
        ? {
            delta: {
              applied: fd.applied,
              rejected: fd.mismatched,
              contextBytes: fd.contextBytes,
              deltaBytes: fd.deltaBytes,
              contextMs: fd.contextMs,
              buildMs: fd.buildMs,
              engine: Array.from(this.loop?.settleDeltaStats?.() ?? []),
            },
          }
        : {}),
    };
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
      drainSteps: 0,
      capped: false,
      ...(this.drain
        ? { settle: this.settleView(this.drain, false) }
        : this.settleStatus
          ? { settle: this.settleStatus }
          : {}),
      ...(this.cs ? { csettle: this.csettleStatus(loop, this.cs) } : {}),
      ...(this.lbError !== undefined ? { error: this.lbError } : {}),
    };
  }

  private csettleStatus(loop: SlowLoopLike, cs: Csettle): CsettleStatus {
    const s = loop.settleStats?.() ?? new Float64Array(0);
    return {
      rate: cs.gov.cap,
      requested: cs.requested,
      fit: s[1] ?? 0,
      heldOut: s[2] ?? 0,
      dropped: (s[3] ?? 0) + cs.dropped,
      live: cs.live,
      answers: cs.answers,
      answerMs: cs.answerMs,
      maxBlockMs: cs.maxBlockMs,
      yieldFrames: cs.yieldFrames,
      settleWorkers: this.settlePorts().length,
      governor: cs.gov.status(),
      ...(cs.delta
        ? {
            delta: {
              applied: cs.delta.applied,
              rejected: cs.delta.rejected,
              contextBytes: cs.delta.contextBytes,
              deltaBytes: cs.delta.deltaBytes,
              contextMs: cs.delta.contextMs,
              buildMs: cs.delta.buildMs,
              engine: Array.from(loop.settleDeltaStats?.() ?? []),
            },
          }
        : {}),
    };
  }

  /** The work accounting so far (`SlowStatus.accounting`): the clock's buckets, the visit workers' sums, the look-back answers. */
  private workStatus(): WorkStatus {
    const t = this.now();
    return {
      wallMs: t - this.workT0,
      busyMs: this.clock.snapshot(),
      batchWait: {
        batches: this.waitN,
        sumMs: this.waitSum,
        lastMs: this.waitLast,
        max1sMs: this.waitMax.max(t),
      },
      visitBusyMs: this.visitBusy.slice(),
      lookback: Object.fromEntries(LOOKBACK_KINDS.map((k) => [k, { ...this.lbWork[k] }])) as Record<
        LookbackKind,
        LookbackWork
      >,
      discarded: { ...this.lbDiscarded },
      lookbackWorkerBusyMs: this.lbPorts.map((p, i) => (p ? (this.lbPortBusy[i] ?? 0) : 0)),
      settleWorkers: this.settlePorts().length,
      observedFrames: this.observed,
      ...(this.strips.count > 0 ? { stripBusyMs: this.strips.busyMs.map((b) => b.slice()) } : {}),
    };
  }

  private status(batchMs: number, maxStepMs: number): void {
    this.clock.begin('publish');
    try {
      this.statusInner(batchMs, maxStepMs);
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
      ...(this.strips.count > 0 ? { strips: this.strips.counters(loop) } : {}),
      liveSplit: { ...this.split },
    };
    // Last, so the snapshot includes the time spent building this status.
    status.accounting = this.workStatus();
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
    // With a run's final library: the cells' split-half noise (the Refine readout).
    if (this.final && loop.footprintNoise) {
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
    this.strips.drop(this.session);
    this.split = emptySplit();
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
    this.workT0 = this.now();
    this.visitBusy = this.visits.map(() => 0);
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
    this.lbReqs = [];
    this.lbPortOff = [];
    this.lbPortBusy = [];
    this.lbRun = [];
    this.lbLib = [];
    this.csArm = null;
    this.liveEnd = -1;
    this.lbFloor = 0;
    this.lbError = undefined;
    this.drain = null;
    // (An answer in pieces: its buffer belongs to a session the look-back worker drops too.)
    this.cs = null;
    this.settleStatus = undefined;
    this.stillMoving = null;
  }
}

function emptySplit(): LiveSplit {
  return {
    observeCall: 0,
    observeInner: 0,
    frames: 0,
    lookback: 0,
    stripBegin: 0,
    stripApply: 0,
    status: 0,
    ack: 0,
  };
}
