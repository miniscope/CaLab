// TileConsumer that solves every tile it holds in one batched GPU solve
// (@calab/compute-gpu's createGpuFista, injected as a BatchFistaEngine so this
// package does not depend on WebGPU and tests can mock it).
//
// - Takes, in one batch, the offered tiles with the same window length and
//   parameters as the most urgent one, up to the memory budget. Per-tile
//   priority otherwise does not apply: all cells of a batch progress together.
// - Preprocessing (filter + baseline subtraction) is not done on the GPU; the
//   injected `prepare` returns each cell's working trace (CaTune does it with
//   a WASM Solver in a worker and caches it).
// - Runs quanta sized to a wall-clock target (quantum-sizer.ts). After each
//   quantum it reads back only the per-cell status (iteration, converged).
//   Solutions are read only for tiles that finished this quantum and for
//   tiles whose producer wants intermediate results (on screen).
// - While other tiles wait, a tile that has used its `maxIterations` budget is
//   completed unconverged (with a warm-start state) so the producer re-submits
//   it and the next batch includes the waiting tiles.
// - Memory: batches are limited to `memoryBudgetBytes` (estimated working
//   set). The budget doubles after a clipped batch loads fine (staying below
//   any size that already failed) and halves on an out-of-memory load, which
//   gives the batch back to the queue.
// - All engine calls go through one promise chain, so load()/destroy() never
//   run while a step() or readback is in flight.
// - Any other engine error, or `fail()` (e.g. GPU device lost), marks the
//   consumer dead and reports it to the scheduler, which re-queues the
//   unsettled tiles for the remaining consumers.

import type { SolverParams } from '@calab/core';
import { createQuantumSizer, type QuantumSizerOptions } from './quantum-sizer.ts';
import { decodeSolverState, encodeSolverState } from './solver-state-codec.ts';
import type {
  BackendCalibration,
  ConsumerContext,
  SolveTile,
  TileCellResult,
  TileCellUpdate,
  TileConsumer,
} from './solve-tiles.ts';

/** Parameters of one batched solve; structurally @calab/compute-gpu's GpuFistaParams. */
export interface BatchFistaParams {
  tauRise: number;
  tauDecay: number;
  fs: number;
  lambda: number;
  constraint: 'nonneg' | 'box01';
  tol: number;
  maxIters: number;
  filtered: boolean;
}

export interface BatchSolutions {
  solutions: Float32Array;
  iterations: Uint32Array;
  converged: Uint8Array;
}

/** The subset of @calab/compute-gpu's GpuFista this consumer uses. */
export interface BatchFistaEngine {
  /** May be async (e.g. to check a WebGPU out-of-memory error scope). */
  load(
    traces: Float32Array,
    nCells: number,
    T: number,
    params: BatchFistaParams,
    warmStart?: Float32Array,
  ): void | Promise<void>;
  step(n: number): Promise<{ allConverged: boolean; iterationsRun: number }>;
  /** Per-cell status only (cheap). */
  readStatus(): Promise<{ iterations: Uint32Array; converged: Uint8Array }>;
  /** Solutions for the given load-order cells, cells.length x T. */
  readSolutionsFor(cells: readonly number[]): Promise<BatchSolutions>;
  readonly groupCount?: number;
  /** Adapter label for calibration records, e.g. "apple / metal-3". */
  readonly adapter?: string;
  destroy(): void;
}

/** Throw this (or an Error whose name is 'GpuOutOfMemoryError') from load() on OOM. */
export class GpuOutOfMemoryError extends Error {
  constructor(message = 'GPU out of memory') {
    super(message);
    this.name = 'GpuOutOfMemoryError';
  }
}

export interface GpuBatchStats {
  state: 'init' | 'idle' | 'running' | 'dead';
  /** Cells in the current (or last) batch. */
  cellsLoaded: number;
  /** Window length of the current batch. */
  samplesPerCell: number;
  groups: number;
  lastQuantumIterations: number;
  lastQuantumMs: number;
  /** FISTA iterations per second over the last quantum (every cell advances each iteration). */
  iterationsPerSec: number;
  /** cells x samples x iterations per second over the last quantum. */
  sampleItersPerSec: number;
  /** Current working-set budget for one batch. */
  memoryBudgetBytes: number;
  /** Cells whose solutions were read back after the last quantum. */
  lastReadbackCells: number;
  failure?: string;
}

/** Default batch memory budget: 384 MiB of estimated GPU working set. */
export const DEFAULT_GPU_MEMORY_BUDGET = 384 * 1024 * 1024;

export interface GpuBatchConsumerOptions {
  /** Create the engine; `maxGroupBytes` is the group budget hook (see `groupBudgetBytes`). */
  createEngine(opts: { maxGroupBytes?: number }): Promise<BatchFistaEngine>;
  /**
   * Byte budget for one cell group, passed to the engine so group size comes
   * from a budget rather than the device's binding limit. Default: unset
   * (device limits decide).
   */
  groupBudgetBytes?: number;
  /**
   * Working-set budget for one batch (all groups). There is no reliable
   * free-GPU-memory query, so this starts conservative, doubles (up to
   * `maxMemoryBudgetBytes`) after a batch that was clipped by it loads fine,
   * and halves on out-of-memory. Default DEFAULT_GPU_MEMORY_BUDGET.
   */
  memoryBudgetBytes?: number;
  /** Default 2 GiB. */
  maxMemoryBudgetBytes?: number;
  /** GPU bytes for a batch; default ~24 B per sample (compute-gpu's estimateGpuBytes is ~20). */
  estimateBytes?(nCells: number, T: number): number;
  /** Working trace per cell of the tile (filter + baseline subtraction done). */
  prepare(tile: SolveTile): Promise<Float32Array[]>;
  /** Display reconvolution (K*s plus display baseline) for one cell. */
  reconvolve(
    solution: Float32Array,
    workingTrace: Float32Array,
    params: SolverParams,
  ): Float32Array;
  /**
   * Participation gate (calibration hook): null = take tiles, otherwise the
   * reason the GPU should sit out (e.g. slower than the WASM pool).
   */
  participate?(): string | null;
  quantum?: QuantumSizerOptions;
  /** Convergence tolerance (the WASM solver's default is 1e-4). */
  tol?: number;
  /** Hard cap on iterations per batch load. */
  maxIters?: number;
  /** For the calibration record. */
  adapter?: string;
  appVersion?: string;
  onStats?(stats: GpuBatchStats): void;
  onCalibration?(cal: BackendCalibration): void;
  name?: string;
}

export interface GpuBatchConsumer extends TileConsumer {
  /** Mark the consumer dead (e.g. on GPUDevice.lost); its tiles are re-queued elsewhere. */
  fail(reason: string): void;
  readonly stats: GpuBatchStats;
}

interface LiveTile {
  tile: SolveTile;
  settled: boolean;
  /** Index of the tile's first cell in the flattened batch. */
  offset: number;
  working: Float32Array[];
  baseIterations: number[];
}

function batchKey(tile: SolveTile): string {
  const p = tile.params;
  const len = tile.traces[0]?.length ?? 0;
  return `${len}|${p.tauRise}|${p.tauDecay}|${p.lambda}|${p.fs}|${p.filterEnabled}`;
}

function isOom(err: unknown): boolean {
  return err instanceof Error && err.name === 'GpuOutOfMemoryError';
}

export function createGpuBatchConsumer(options: GpuBatchConsumerOptions): GpuBatchConsumer {
  const name = options.name ?? 'webgpu';
  const sizer = createQuantumSizer(options.quantum);
  const tol = options.tol ?? 1e-4;
  const maxIters = options.maxIters ?? 20000;
  const maxBudget = options.maxMemoryBudgetBytes ?? 2 * 1024 * 1024 * 1024;
  const estimateBytes = options.estimateBytes ?? ((n: number, T: number) => 24 * n * T);
  let engine: BatchFistaEngine | null = null;
  /** Serializes every engine call: load()/destroy() never overlap a step or readback. */
  let engineChain: Promise<unknown> = Promise.resolve();
  let ctx: ConsumerContext | null = null;
  let pendingFailure: string | null = null;
  let disposed = false;
  let batch: LiveTile[] = [];
  let lastCalibration: BackendCalibration | null = null;
  /** Smallest working set that has failed with out-of-memory; growth stays below it. */
  let oomCeiling = Infinity;
  const stats: GpuBatchStats = {
    state: 'init',
    cellsLoaded: 0,
    samplesPerCell: 0,
    groups: 0,
    lastQuantumIterations: 0,
    lastQuantumMs: 0,
    iterationsPerSec: 0,
    sampleItersPerSec: 0,
    memoryBudgetBytes: options.memoryBudgetBytes ?? DEFAULT_GPU_MEMORY_BUDGET,
    lastReadbackCells: 0,
  };
  const emitStats = () => options.onStats?.({ ...stats });
  // A function, not an inline comparison: `fail()` can run during an await,
  // which TypeScript's narrowing of `stats.state` does not see.
  const isDead = () => stats.state === 'dead';

  function withEngine<R>(fn: (e: BatchFistaEngine) => R | Promise<R>): Promise<R> {
    const run = engineChain.then(() => {
      if (!engine) throw new Error('GPU engine released');
      return fn(engine);
    });
    engineChain = run.catch(() => undefined);
    return run;
  }

  function releaseEngine(): void {
    // Queued behind any in-flight engine call.
    engineChain = engineChain.then(() => {
      const e = engine;
      engine = null;
      try {
        e?.destroy();
      } catch (err) {
        console.warn('[gpu-batch-consumer] engine destroy failed:', err);
      }
    });
  }

  options
    .createEngine({ maxGroupBytes: options.groupBudgetBytes })
    .then((e) => {
      if (disposed || isDead()) {
        e.destroy();
        return;
      }
      engine = e;
      stats.state = 'idle';
      emitStats();
      ctx?.ready();
    })
    .catch((err) => fail(`GPU solver init failed: ${String(err)}`));

  function fail(reason: string): void {
    if (isDead()) return;
    stats.state = 'dead';
    stats.failure = reason;
    emitStats();
    for (const lt of batch) lt.settled = true; // the scheduler re-queues them
    batch = [];
    releaseEngine();
    if (ctx) ctx.failed(reason);
    else pendingFailure = reason;
  }

  async function runBatch(tiles: SolveTile[], clipped: boolean): Promise<void> {
    stats.state = 'running';
    const live: LiveTile[] = tiles.map((tile) => ({
      tile,
      settled: false,
      offset: 0,
      working: [],
      baseIterations: [],
    }));
    batch = live;
    try {
      const prepared = await Promise.all(tiles.map((t) => options.prepare(t)));
      if (isDead() || disposed) return;
      const T = tiles[0].traces[0].length;
      let offset = 0;
      live.forEach((lt, i) => {
        lt.offset = offset;
        lt.working = prepared[i];
        offset += lt.tile.cells.length;
      });
      const N = offset;
      const traces = new Float32Array(N * T);
      let warm: Float32Array | undefined;
      for (const lt of live) {
        const ws = lt.tile.warmStart;
        for (let k = 0; k < lt.tile.cells.length; k++) {
          traces.set(lt.working[k], (lt.offset + k) * T);
          const bytes = ws && ws.strategy !== 'cold' ? ws.states[k] : null;
          const decoded = bytes ? decodeSolverState(bytes) : null;
          if (decoded && decoded.solution.length === T) {
            warm ??= new Float32Array(N * T);
            warm.set(decoded.solution, (lt.offset + k) * T);
            lt.baseIterations[k] = decoded.iteration;
          } else {
            lt.baseIterations[k] = 0;
          }
        }
      }
      const p = tiles[0].params;
      try {
        await withEngine((e) =>
          e.load(
            traces,
            N,
            T,
            {
              tauRise: p.tauRise,
              tauDecay: p.tauDecay,
              fs: p.fs,
              lambda: p.lambda,
              constraint: 'nonneg',
              tol,
              maxIters,
              // CaTune's preprocessing always ends with subtract_baseline, which
              // pins the solver's baseline to 0 (`filtered` in Rust).
              filtered: true,
            },
            warm,
          ),
        );
      } catch (err) {
        if (!isOom(err) || isDead() || disposed || tiles.length <= 1) throw err;
        const est = estimateBytes(N, T);
        oomCeiling = Math.min(oomCeiling, est);
        stats.memoryBudgetBytes = Math.max(
          1,
          Math.floor(Math.min(stats.memoryBudgetBytes, est) / 2),
        );
        console.warn(
          `[gpu-batch-consumer] out of memory loading ${N} cells x ${T}; budget now ` +
            `${(stats.memoryBudgetBytes / 2 ** 20).toFixed(0)} MiB, re-queuing the batch`,
        );
        const unsettled = live.filter((lt) => !lt.settled).map((lt) => lt.tile.id);
        for (const lt of live) lt.settled = true;
        emitStats();
        ctx?.giveBack(unsettled);
        return;
      }
      if (clipped) {
        const grown = Math.min(
          maxBudget,
          stats.memoryBudgetBytes * 2,
          Math.floor(oomCeiling * 0.75),
        );
        stats.memoryBudgetBytes = Math.max(stats.memoryBudgetBytes, grown);
      }
      stats.cellsLoaded = N;
      stats.samplesPerCell = T;
      stats.groups = engine?.groupCount ?? 1;
      emitStats();

      const cellSolution = (sol: BatchSolutions, row: number) =>
        new Float32Array(sol.solutions.subarray(row * T, (row + 1) * T));

      let itersThisLoad = 0;
      for (;;) {
        if (live.every((lt) => lt.settled) || isDead() || disposed) break;
        const n = sizer.next();
        const t0 = performance.now();
        const { iterationsRun } = await withEngine((e) => e.step(n));
        const status = await withEngine((e) => e.readStatus());
        if (isDead() || disposed) return;

        // Decide per tile, then read solutions only for the tiles that need them.
        const capped = iterationsRun === 0; // engine hit maxIters
        const others = ctx?.hasWaiting() ?? false;
        itersThisLoad += iterationsRun;
        const finishing = new Set<LiveTile>();
        const readTiles: LiveTile[] = [];
        for (const lt of live) {
          if (lt.settled) continue;
          const t = lt.tile;
          let allConv = true;
          for (let k = 0; k < t.cells.length; k++) {
            if (!status.converged[lt.offset + k]) allConv = false;
          }
          const yieldNow = others && itersThisLoad >= (t.maxIterations ?? Infinity);
          if (allConv || capped || yieldNow) {
            finishing.add(lt);
            readTiles.push(lt);
          } else if (t.wantsIntermediate?.() ?? true) {
            readTiles.push(lt);
          }
        }
        const rows: number[] = [];
        const rowOf = new Map<LiveTile, number>();
        for (const lt of readTiles) {
          rowOf.set(lt, rows.length);
          for (let k = 0; k < lt.tile.cells.length; k++) rows.push(lt.offset + k);
        }
        const sol = rows.length > 0 ? await withEngine((e) => e.readSolutionsFor(rows)) : null;
        const ms = performance.now() - t0;
        if (isDead() || disposed) return;

        sizer.record(iterationsRun, ms);
        stats.lastQuantumIterations = iterationsRun;
        stats.lastQuantumMs = ms;
        stats.lastReadbackCells = rows.length;
        stats.iterationsPerSec = ms > 0 ? (iterationsRun / ms) * 1000 : 0;
        stats.sampleItersPerSec = stats.iterationsPerSec * N * T;
        if (iterationsRun > 0 && stats.sampleItersPerSec > 0) {
          lastCalibration = {
            backend: name,
            adapter: options.adapter ?? engine?.adapter,
            appVersion: options.appVersion,
            sampleItersPerSec: stats.sampleItersPerSec,
            measuredAt: Date.now(),
          };
          options.onCalibration?.(lastCalibration);
        }
        emitStats();

        if (sol) {
          for (const lt of readTiles) {
            if (lt.settled) continue; // cancelled while the readback was awaited
            const t = lt.tile;
            const r0 = rowOf.get(lt)!;
            const iterationOf = (k: number) =>
              lt.baseIterations[k] + status.iterations[lt.offset + k];
            if (finishing.has(lt)) {
              lt.settled = true;
              const results: TileCellResult[] = t.cells.map((cellIndex, k) => {
                const solution = cellSolution(sol, r0 + k);
                const iteration = iterationOf(k);
                return {
                  cellIndex,
                  solution,
                  reconvolution: options.reconvolve(solution, lt.working[k], t.params),
                  iteration,
                  converged: status.converged[lt.offset + k] !== 0,
                  state: encodeSolverState({ solution, iteration }),
                  workingTrace: new Float32Array(lt.working[k]),
                  backend: name,
                };
              });
              t.onComplete(results);
            } else {
              const updates: TileCellUpdate[] = t.cells.map((cellIndex, k) => {
                const solution = cellSolution(sol, r0 + k);
                return {
                  cellIndex,
                  solution,
                  reconvolution: options.reconvolve(solution, lt.working[k], t.params),
                  iteration: iterationOf(k),
                };
              });
              t.onIntermediate(updates);
            }
          }
        }
        if (capped) break;
      }
    } catch (err) {
      fail(`GPU solve failed: ${String(err)}`);
      return;
    } finally {
      if (batch === live) batch = [];
      if (stats.state === 'running') {
        stats.state = 'idle';
        emitStats();
        ctx?.ready();
      }
    }
  }

  const consumer: GpuBatchConsumer = {
    name,
    accepts(tile) {
      if (isDead()) return `GPU unavailable (${stats.failure ?? 'failed'})`;
      if (tile.params.convMode !== 'banded') {
        return 'GPU solver is banded AR(2) only; FFT conv mode is selected';
      }
      return options.participate?.() ?? null;
    },
    take(offered, context) {
      ctx = context;
      if (pendingFailure !== null) {
        const reason = pendingFailure;
        pendingFailure = null;
        context.failed(reason);
        return [];
      }
      if (stats.state !== 'idle' || offered.length === 0) return [];
      const key = batchKey(offered[0]);
      const T = offered[0].traces[0]?.length ?? 0;
      const taken: SolveTile[] = [];
      let cells = 0;
      let clipped = false;
      for (const t of offered) {
        if (batchKey(t) !== key) continue;
        const next = cells + t.cells.length;
        if (taken.length > 0 && estimateBytes(next, T) > stats.memoryBudgetBytes) {
          clipped = true;
          break;
        }
        taken.push(t);
        cells = next;
      }
      void runBatch(taken, clipped);
      return taken;
    },
    cancel(tileId) {
      const lt = batch.find((b) => b.tile.id === tileId);
      if (!lt || lt.settled) return;
      lt.settled = true;
      lt.tile.onCancelled();
    },
    calibration: () => lastCalibration,
    fail,
    get stats() {
      return { ...stats };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      batch = [];
      releaseEngine();
    },
  };
  return consumer;
}
