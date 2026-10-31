// Solver work-queue types shared by every solver backend.
//
// A *tile* is a block of the cells x time raster: one or more cells over the
// same sample window, solved with one parameter set and an optional warm
// start. Producers (CaTune's cell-solve-manager, later CaDecon's run loop)
// submit tiles to a TileScheduler; *consumers* (the WASM worker pool, the
// WebGPU batch solver, ...) pull tiles from it, each at its own rate, and
// report results through the tile's callbacks. Several consumers can be
// registered at once; an assignment policy decides which consumers may take a
// given tile.

import type { SolverParams, WarmStartStrategy } from '@calab/core';

/** Per-tile warm start: one opaque solver state per cell (null = cold for that cell). */
export interface TileWarmStart {
  strategy: WarmStartStrategy;
  /**
   * Solver state per cell in the Rust `Solver::export_state` byte layout
   * (see solver-state-codec.ts), so a state produced by any backend can warm
   * start any other backend.
   */
  states: ReadonlyArray<Uint8Array | null>;
}

/** Progress for one cell of a tile (intermediate readback). */
export interface TileCellUpdate {
  cellIndex: number;
  solution: Float32Array;
  /** Reconvolution K*s plus the display baseline, aligned with the working trace. */
  reconvolution: Float32Array;
  /** Cumulative FISTA iteration count (including iterations carried in by the warm start). */
  iteration: number;
}

/** Final result for one cell of a tile. */
export interface TileCellResult extends TileCellUpdate {
  converged: boolean;
  /** Solver state for warm-starting the next solve of this cell (export_state layout). */
  state: Uint8Array;
  /** Preprocessed trace the solver actually fit (after filter + baseline subtraction). */
  workingTrace?: Float32Array;
  /** Name of the consumer that produced the result (dev readouts, comparisons). */
  backend?: string;
}

export interface TileCallbacks {
  onIntermediate(updates: TileCellUpdate[]): void;
  /** Exactly one of onComplete / onCancelled / onError settles a tile. */
  onComplete(results: TileCellResult[]): void;
  onCancelled(): void;
  onError(message: string): void;
}

export interface SolveTile extends TileCallbacks {
  /** Unique per submission. Cancelling uses this id. */
  readonly id: number;
  /** Cell indices, in the order of `traces`. */
  readonly cells: readonly number[];
  /** First sample of the window within each cell's full trace. */
  readonly windowStart: number;
  /** Raw (unpreprocessed) trace per cell over the window; all the same length. */
  readonly traces: readonly Float32Array[];
  readonly params: SolverParams;
  readonly warmStart: TileWarmStart | null;
  /**
   * Iteration budget for one hand-out of this tile. A consumer stops after
   * this many iterations and completes the tile with `converged: false`; the
   * producer re-submits with the returned state. Consumers that run all their
   * tiles together (GPU) may run past it while nothing else is waiting.
   */
  readonly maxIterations?: number;
  /** Lower = more urgent. Re-evaluated whenever the scheduler sorts its queue. */
  getPriority?(): number;
  /**
   * Whether the producer wants intermediate results for this tile right now
   * (e.g. it is on screen). Default true. Batch consumers skip the solution
   * readback for tiles that return false and only read them when they finish.
   */
  wantsIntermediate?(): boolean;
}

/**
 * Measured throughput of one backend on this machine. A scheduler can split
 * tiles across consumers in proportion to `sampleItersPerSec`. Nothing
 * persists or consumes these yet; this is the hook.
 */
export interface BackendCalibration {
  backend: string;
  /** e.g. WebGPU adapter "vendor / architecture", or "wasm x8 workers". */
  adapter?: string;
  appVersion?: string;
  /** Samples x iterations per second (cells x T x iterations / s). */
  sampleItersPerSec: number;
  /** ms since epoch. */
  measuredAt: number;
}

/** What a consumer can ask of the scheduler that feeds it. */
export interface ConsumerContext {
  /** The consumer can take more work now (batch ended, worker freed, device ready). */
  ready(): void;
  /**
   * The consumer can no longer run anything (device lost, init failed). The
   * scheduler removes it and re-queues every tile it held that has not settled.
   */
  failed(reason: string): void;
  /** Whether tiles this consumer may take are waiting in the queue. */
  hasWaiting(): boolean;
  /**
   * Return taken, unsettled tiles to the queue without settling them (e.g. a
   * GPU batch that did not fit in memory). They are offered again, to any
   * eligible consumer, on the next pump.
   */
  giveBack(tileIds: readonly number[]): void;
}

export interface TileConsumer {
  readonly name: string;
  /**
   * Called once when the consumer is registered with a scheduler, before any
   * take(). A consumer that fails before its first take (e.g. its device
   * could not be created) reports it through this context, so the scheduler
   * reacts (removes it, re-routes its tiles, notifies onConsumerFailed).
   */
  attach?(ctx: ConsumerContext): void;
  /** null when this consumer can solve the tile, else a human-readable reason. */
  accepts(tile: SolveTile): string | null;
  /**
   * Offered tiles (already filtered by the assignment policy, sorted by
   * priority). Start some of them and return the ones taken; return [] when
   * busy. Called by the scheduler only, never re-entrantly.
   */
  take(offered: readonly SolveTile[], ctx: ConsumerContext): SolveTile[];
  /** Cancel a taken tile. The consumer must still settle it (normally via onCancelled). */
  cancel(tileId: number): void;
  /** Latest throughput measurement, or null before the first one. */
  calibration(): BackendCalibration | null;
  dispose(): void;
}

/**
 * Decides which consumers may take a tile. Return the eligible consumers;
 * a tile with no eligible consumer fails with the collected reasons.
 */
export type TileAssignPolicy = (
  tile: SolveTile,
  consumers: readonly TileConsumer[],
) => { eligible: TileConsumer[]; skipped: { consumer: TileConsumer; reason: string }[] };
