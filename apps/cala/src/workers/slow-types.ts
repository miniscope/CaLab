/**
 * Messages between the fast worker (frame worker: read, preprocess, motion,
 * trace solve), the slow worker (cell discovery) and the main thread.
 *
 * The fast and slow workers talk over a `MessageChannel` whose ports the main
 * thread hands out, so the frame path never goes through the UI thread. Every
 * message carries the pipeline `session`; a restart bumps it and late messages
 * of the old session are dropped.
 */

import type { WorkStatus } from '../lib/work-meter.ts';
import type { FactorSource, LookbackStatus } from './lookback-types.ts';

/**
 * The structural edits the slow loop may make (`SlowLoop.setEditScope`, the
 * engine's `EditScope` names). Discover runs with `all`, Refine with `refine`;
 * the others exist in the engine (qc_eval's `--later-passes`) but no stage
 * uses them yet (docs/stages.md).
 */
export type EditScopeName = 'all' | 'refine' | 'refine-prune' | 'refine-merge';

/** Settings and calibration the slow loop starts from. */
export interface SlowInit {
  width: number;
  height: number;
  /** FOV mask of the preprocessor (1 = inside). */
  fov: Uint8Array;
  /** Per-pixel noise sigma of the preprocessed frames. */
  noise: Float32Array;
  cellDiameterPx: number;
  /** Flattening sigma, px (0 = derived from the cell diameter). */
  flattenSigmaPx: number;
  /** Slow-loop work units per observed frame (about multiply-adds). */
  budget: number;
  /**
   * Look-back (experimental; absent = off): the slow loop is built with the
   * options look-back runs with (`SlowLoop.withConfig(.., 'all', 'all', 0.6)`,
   * visit workers alike), re-reads past frames through the look-back worker
   * during Discover and settles after the last frame (see `SlowRunner`).
   */
  lookback?: boolean;
  /**
   * A live stream with `?factors` (absent = off; never with `lookback`): the
   * slow loop is built with `FACTOR_SETTLE` (visit workers alike) and, after
   * the last frame, waits for the stream's factors and settles on them
   * (see `SlowRunner`).
   */
  factorSettle?: boolean;
  /** A recording with `?factors=file`: at Discover's end the settle may read the factors (`SlowRunner`). */
  factorFile?: boolean;
  /**
   * Settle during Discover ("Background settle", frames only; needs
   * `lookback`; absent = off for the run): the run may settle while Discover
   * runs. It starts the first time the target is below Max with a cap above
   * 0; the settle governor (`SettleGovernor` in `lib/settle.ts`) sets its
   * rate. The cap comes from `SlowSettleCap`, the target from
   * `SlowSettlePace` (see `SlowRunner`).
   */
  csettle?: boolean;
  /**
   * With `csettle`: the slow worker handles an answer of re-read frames this
   * many frames at a time and gives way in between (absent or 0: the whole
   * answer in one go, as measured in qc_eval's arm `CS2F`).
   */
  csettleYield?: number;
  /**
   * With `csettle`, one look-back worker (no settle pool): need-driven
   * look-back first, the settle only when it asks for nothing (measurement
   * option, `?debug&needfirst`; absent: the two take turns).
   */
  csettleNeedFirst?: boolean;
  /**
   * The share of the final settle pass to read, in plan order (a Final-settle
   * level, `FINAL_SETTLE_LEVELS`); absent or 1 = the whole pass.
   */
  settleFraction?: number;
  /**
   * With `lookback`, a Joint run: the first stream frame of sessions 1..
   * (the plan's boundaries). While Discover runs, look-back and the settle
   * during Discover re-read frames of the current session only
   * (`SlowLoop.setLookbackFloor`); the end settle covers every session.
   */
  sessionStarts?: number[];
  /**
   * With `csettle`: batches the forward pool holds in flight to this worker
   * (the governor's batch-wait guard scales with it; absent: 2).
   */
  csettlePool?: number;
  /**
   * The Discover visit cap (`lib/visit-rate.ts`): ordinary tile visits per
   * observed Discover frame at most (`SlowLoop.setVisitRate`); absent or 0 =
   * no cap (`?debug&visitrate=off`).
   */
  visitRate?: number;
  /**
   * The Final settle's visit rate (`SETTLE.visitRate`): with visit workers, tile visits handed
   * out per settle frame fed, a fixed count however fast the settle runs; absent or 0 = visits
   * whenever a visit worker is free (`?debug&settlevisits=off`, the behaviour before).
   */
  settleVisitRate?: number;
}

/** Fast worker -> slow worker. */
export type FastToSlow =
  | ({ type: 'init'; session: number } & SlowInit)
  | {
      type: 'frames';
      session: number;
      /** Stream index of the first frame. */
      start: number;
      count: number;
      /** Library version that produced the traces (0 = the empty start library). */
      version: number;
      /** Cells per frame in `traces`. */
      cells: number;
      /**
       * Pooled buffer, at least `count * width * height` preprocessed frames.
       * Transferred; the slow worker sends it back in its `ack`.
       */
      frames: Float32Array;
      /** `count * cells` traces, library slot order. */
      traces: Float32Array;
      /**
       * The background coefficients of the same solve (`TraceEngine.lastBackground`),
       * frame after frame (`background.length / count` per frame: one local level
       * per cell under the ring model). The slow loop takes them off the ledger
       * coordinate and the footprint statistics. Transferred. Absent: no cells yet.
       */
      background?: Float32Array;
      /** A newer noise map, sent every few hundred frames. */
      noise?: Float32Array;
      /**
       * When the batch was sent, ms on the epoch clock (`performance.timeOrigin + performance.now()`,
       * comparable across workers): the slow worker's batch wait is the time from here to the start
       * of its processing. Absent from older senders.
       */
      sentAt?: number;
    }
  /** The recording ended: publish what is pending. */
  | { type: 'end'; session: number }
  /** Pipeline stopped or restarted: drop the slow loop. */
  | { type: 'reset'; session: number };

/** Slow worker -> fast worker. */
export type SlowToFast =
  /** A `frames` batch was consumed; its buffer comes back for reuse. */
  | {
      type: 'ack';
      session: number;
      frames: Float32Array;
      start: number;
      count: number;
      /** Frames of the batch the slow loop observed (others came from a version it no longer holds). */
      observed: number;
    }
  /** A published library, `TraceLibrary.toBytes()`. */
  | { type: 'library'; session: number; version: number; bytes: Uint8Array };

/** Slow-loop counters (`SlowLoop.stats()`). */
export interface SlowCounters {
  visits: number;
  proposals: number;
  adds: number;
  rejects: number;
  merges: number;
  mergeTests: number;
  refines: number;
  commits: number;
  /** Cells deleted (silent or unsupported), split in two, and candidates absorbed by a neighbour. */
  deletes: number;
  splits: number;
  absorbs: number;
  /**
   * Add classification (cumulative; 0 from an older WASM build): adds at a
   * fresh spot, adds where a cell was just removed, adds removed again soon
   * after (counted at the removal), and merges/deletes of established cells.
   */
  newAdds: number;
  reAdds: number;
  churned: number;
  establishedRemovals: number;
  /** Of the adds, cells that came from the history review. */
  reviewAdds: number;
}

/** Evidence status of the working-set cells (`SlowLoop.cellStatus()`). */
export interface CellStatusView {
  ids: Uint32Array;
  /** 1 = established (enough transients since birth), 0 = on probation. */
  established: Uint8Array;
}

/** The Discover visit cap's counters (`SlowLoop.visitRateStats`; see `lib/visit-rate.ts`). */
export interface VisitRateCounters {
  /** The cap, visits per observed frame (0: off). */
  rate: number;
  /** Unspent credit, visits. */
  credit: number;
  /** Frames observed under the cap, and the ordinary visits made under it. */
  frames: number;
  visits: number;
  /** Frames on which the cap held a due visit back. */
  cappedFrames: number;
  /** Tiles due for a visit now (not out). */
  dueTiles: number;
}

/** `SlowLoop.visitRateStats()` as named counters. */
export function visitRateCounters(s: ArrayLike<number>): VisitRateCounters {
  return {
    rate: s[0] ?? 0,
    credit: s[1] ?? 0,
    frames: s[2] ?? 0,
    visits: s[3] ?? 0,
    cappedFrames: s[4] ?? 0,
    dueTiles: s[5] ?? 0,
  };
}

export interface SlowStatus {
  /** The Discover visit cap's counters (absent in builds without it). */
  visitRate?: VisitRateCounters;
  /** Stream index after the last observed frame. */
  frame: number;
  /** Stream index after the last batch received, observed or not (a Refine run's backpressure). */
  consumed?: number;
  /** Frames observed so far, and frames received but not observed. */
  observed: number;
  skipped: number;
  /** Cells in the working set (published or not). */
  cells: number;
  /** Last published version (0 = none yet). */
  version: number;
  counters: SlowCounters;
  reservoirBytes: number;
  /** Frames the reservoir stores per tile (0 = unknown). */
  framesPerTile: number;
  /**
   * Set when the reservoir's memory cap holds the frames per tile below
   * target (large sensors): discovery is slower, or starved.
   */
  reservoirWarning?: string;
  /** Wall time of the last batch (observe + step), and its longest single step, ms. */
  batchMs: number;
  maxStepMs: number;
  /**
   * Visit workers (0: the slow worker visits tiles itself), tile visits
   * they ran, visits out now, and the mean wall time of a visit on a worker
   * over the last status interval (ms).
   */
  visitWorkers: number;
  jobs: number;
  jobsInFlight: number;
  visitMs: number;
  /** Total wall time the slow worker spent handing out and applying visits, ms. */
  jobOwnerMs: number;
  /** Slow-loop work so far (about multiply-adds; visits included). */
  work: number;
  /** The recording ended and the final library is out. */
  final: boolean;
  /** Runs over the recording into this slow loop: 1 = Discover (always 1 now: Refine, which made it 2 and up, is gone) */
  run: number;
  /** The current run's edit scope. */
  editScope: EditScopeName;
  /** Probation/established per cell, about once a second. */
  cellStatus?: CellStatusView;
  /** Look-back counters (absent: look-back off). */
  lookback?: LookbackStatus;
  /** Busy and idle accounting by worker (cumulative; `lib/work-meter.ts`). Instrumentation only. */
  accounting?: WorkStatus;
  /**
   * With the final library of a run: each cell's split-half footprint noise,
   * `[id, noise, ...]` (`SlowLoop.footprintNoise`; absent in older builds).
   * The Refine readout compares footprint changes with it.
   */
  footprintNoise?: Float64Array;
  /**
   * After a Final-settle checkpoint (and the final library): per cell, how
   * much its footprint changed at the last step against its split-half noise,
   * `[id, ratio, ...]` (`stillMovingRatios`). Information only.
   */
  stillMoving?: Float64Array;
}

/** A published library, flattened for drawing (unfiltered footprints). */
export interface LibraryView {
  version: number;
  /** Stream frame after which it was published. */
  frame: number;
  width: number;
  height: number;
  ids: Uint32Array;
  /** `(y, x)` per cell, interleaved. */
  centers: Float32Array;
  radii: Float32Array;
  /** Cell `i` owns `pixels[starts[i]..starts[i + 1]]` and the same `values`. */
  starts: Uint32Array;
  pixels: Uint32Array;
  values: Float32Array;
}

/** Slow worker -> main thread. */
export type SlowToMain =
  | { type: 'status'; session: number; status: SlowStatus }
  | {
      type: 'library';
      session: number;
      library: LibraryView;
      /** The same library as `TraceLibrary.toBytes()` (a copy), so pass 2 can solve with the final one. */
      bytes: Uint8Array;
    }
  | { type: 'error'; session: number; message: string };

/**
 * Main thread -> slow worker: the port to the fast worker, and one port to
 * each visit worker (none: the slow worker visits tiles itself).
 */
export interface SlowConnect {
  type: 'connect';
  port: MessagePort;
  visits?: MessagePort[];
  /** Measurement only (`?debug`): finer timers in `WorkStatus.detail` (`SlowRunner.setDebugTiming`). */
  debugTiming?: boolean;
}

/**
 * Main thread -> slow worker: what a history review found
 * (`HistoryReview.finish`), to add as new cells on probation. Transferred.
 */
export interface SlowReviewed {
  type: 'reviewed';
  session: number;
  candidates: Float32Array;
}

/**
 * Main thread -> slow worker: the port to the look-back worker (transferred),
 * for runs with look-back (`SlowInit.lookback`).
 */
export interface SlowLookbackPort {
  type: 'lookback-port';
  port: MessagePort;
  /** Which look-back worker (0: need-driven and the end settle; 1..S: the settle pool). Absent: 0. */
  index?: number;
}

/**
 * Main thread -> slow worker: the pacer's target live fps (0: unpaced, Max)
 * and whether the run is paused. Kept across runs; only the settle governor
 * reads it.
 */
export interface SlowSettlePace {
  type: 'settle-pace';
  fps: number;
  paused: boolean;
}

/**
 * Main thread -> slow worker: the settle's cap, re-read frames per live
 * frame (0 = Off). Kept across runs; takes effect during a run too.
 */
export interface SlowSettleCap {
  type: 'settle-cap';
  cap: number;
}

/**
 * Main thread -> slow worker: look-back workers 1..`workers` were started
 * for `session`'s run (the settle pool; possibly mid-run) and have its back
 * state. The slow worker sends them the current library at once; they take
 * the settle's chunks from then on.
 */
export interface SlowSettlePool {
  type: 'settle-pool';
  session: number;
  workers: number;
}

/**
 * Main thread -> slow worker: stop settling (the drain after a look-back
 * run's last frame) now; the footprints refined so far are published as the
 * final library.
 */
export interface SlowStopSettling {
  type: 'stop-settling';
  session: number;
}

/**
 * Main thread -> slow worker: the factors of a `?factors` stream are ready
 * (the settle can start; `frames` of the stream are covered), or cannot be
 * used (the run ends with Discover's library).
 */
export type SlowFactors = { type: 'factors'; session: number } & (
  | { ready: true; frames: number; source?: FactorSource['factors'] }
  | { ready: false; reason: string }
);

export type MainToSlow =
  | SlowFactors
  | SlowConnect
  | SlowReviewed
  | SlowLookbackPort
  | SlowStopSettling
  | SlowSettlePace
  | SlowSettleCap
  | SlowSettlePool;

/** Main thread -> visit worker: the port to the slow worker. */
export interface VisitConnect {
  type: 'connect';
  port: MessagePort;
}

/**
 * Slow worker -> visit worker. The visit worker builds its `VisitWorker`
 * from the same settings as the slow loop and gets every noise map the slow
 * loop gets, in the same order (port messages are ordered).
 */
export type OwnerToVisit =
  | ({ type: 'init'; session: number } & SlowInit)
  | { type: 'noise'; session: number; noise: Float32Array }
  /** `SlowLoop.takeJob()` bytes (transferred). */
  | { type: 'job'; session: number; bytes: Uint8Array }
  | { type: 'reset'; session: number };

/** Visit worker -> slow worker. */
export type VisitToOwner =
  /** `VisitWorker.run()` bytes (transferred) and the wall time of the run. */
  | { type: 'result'; session: number; bytes: Uint8Array; ms: number }
  | { type: 'error'; session: number; message: string };

/** The part of a `MessagePort` (or worker scope) the loops use, so tests can fake it. */
export interface PortLike<T> {
  postMessage(msg: T, transfer?: Transferable[]): void;
}

export function libraryViewTransferables(v: LibraryView, bytes?: Uint8Array): ArrayBuffer[] {
  return [v.ids, v.centers, v.radii, v.starts, v.pixels, v.values, ...(bytes ? [bytes] : [])].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
