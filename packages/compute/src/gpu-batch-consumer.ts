// TileConsumer that solves every tile it holds in one batched GPU solve
// (@calab/compute-gpu's createGpuFista, injected as a BatchFistaEngine so this
// package does not depend on WebGPU and tests can mock it).
//
// - Takes, in one batch, the offered tiles with the same window length,
//   parameters, baseline mode and constraint as the most urgent one, up to the
//   memory budget. Per-tile priority otherwise does not apply: all cells of a
//   batch progress together.
// - Preprocessing (filter + baseline subtraction) is not done on the GPU; the
//   injected `prepare` returns each cell's working trace (CaTune does it with
//   a WASM Solver in a worker and caches it).
// - Runs quanta sized to a wall-clock target (quantum-sizer.ts, normalised per
//   active sample-iteration). Each step() returns every cell's status, so
//   there is one status readback per quantum. Solutions are read only for
//   tiles that finish this quantum (with their warm-start state) and for tiles
//   whose producer wants intermediate results (on screen).
// - Warm starts carry FISTA momentum: a 'warm' state loads x_k, y_k
//   (`solution_prev`) and t_fista, so a re-submitted tile continues exactly
//   where it stopped; finished tiles export the same layout.
// - While other tiles wait, the batch does not drain to its slowest tile: a
//   tile past its `maxIterations` budget, or every unsettled tile once
//   `refillFraction` of the batch's rows has settled, is completed unconverged
//   with its state, so the producer re-submits it and the next batch takes it
//   together with the waiting tiles.
// - Memory: batches are limited to `memoryBudgetBytes` (estimated working
//   set). The budget doubles after a clipped batch loads fine (staying below
//   any size that already failed) and halves on an out-of-memory load, which
//   gives the batch back to the queue. A tile that alone does not fit (longer
//   than the engine's maxTraceLength, or at least as large as a size that ran
//   out of memory) is declined in accepts(), so the scheduler routes it to
//   another consumer; out-of-memory never kills the consumer.
// - All engine calls go through one promise chain, so load()/destroy() never
//   run while a step() or readback is in flight.
// - Device loss and any other engine error, or `fail()`, mark the consumer
//   dead and report it to the scheduler, which re-queues the unsettled tiles
//   for the remaining consumers.

import type { SolverParams } from '@calab/core';
import { isGpuDeviceLostError, isGpuOutOfMemoryError } from './gpu-errors.ts';
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

export { GpuOutOfMemoryError, GpuDeviceLostError } from './gpu-errors.ts';

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

/** Warm start of a batch; structurally @calab/compute-gpu's GpuWarmStart. */
export interface BatchWarmStart {
  solution: Float32Array;
  prev?: Float32Array;
  momentum?: Uint8Array;
  tFista?: Float32Array | Float64Array;
  iterations?: Uint32Array;
}

export interface BatchStatus {
  iterations: Uint32Array;
  converged: Uint8Array;
}

export interface BatchStepResult extends BatchStatus {
  allConverged: boolean;
  iterationsRun: number;
}

export interface BatchSolutions {
  solutions: Float32Array;
  iterations: Uint32Array;
  converged: Uint8Array;
  /** y_k (`solution_prev`), t_fista and baseline per cell, when read with `withState`. */
  state?: { prev: Float32Array; tFista: Float32Array; baseline: Float32Array };
}

/** The subset of @calab/compute-gpu's GpuFista this consumer uses. */
export interface BatchFistaEngine {
  /** May be async; rejects with a GpuOutOfMemoryError (by name) when the batch does not fit. */
  load(
    traces: Float32Array,
    nCells: number,
    T: number,
    params: BatchFistaParams,
    warmStart?: BatchWarmStart,
    options?: { requireResident?: boolean },
  ): void | Promise<void>;
  /** Run up to n iterations; returns every cell's status (no separate status readback). */
  step(n: number): Promise<BatchStepResult>;
  /** Solutions for the given load-order cells, cells.length x T. */
  readSolutionsFor(
    cells: readonly number[],
    options?: { withState?: boolean },
  ): Promise<BatchSolutions>;
  readonly groupCount?: number;
  /** Adapter label for calibration records, e.g. "apple / metal-3". */
  readonly adapter?: string;
  /** Longest window the device can take; longer tiles are declined. */
  readonly maxTraceLength?: number;
  /** GPU bytes of a fully resident batch (used for the memory budget). */
  estimateBytes?(nCells: number, T: number): number;
  destroy(): void;
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
  /** FISTA iterations per second over the last quantum. */
  iterationsPerSec: number;
  /** Active (unconverged) cells x samples x iterations per second over the last quantum. */
  sampleItersPerSec: number;
  /** Current working-set budget for one batch. */
  memoryBudgetBytes: number;
  /** Cells whose solutions were read back after the last quantum. */
  lastReadbackCells: number;
  /** Tiles handed back early (budget or rolling refill) so waiting tiles could start. */
  yieldedTiles: number;
  failure?: string;
}

/** Default batch memory budget: 384 MiB of estimated GPU working set. */
export const DEFAULT_GPU_MEMORY_BUDGET = 384 * 1024 * 1024;

/** Default fraction of a batch's rows that must settle before the rest yields to waiting work. */
export const DEFAULT_REFILL_FRACTION = 0.5;

export interface DisplayReconvolution {
  /** K*s plus the display baseline. */
  reconvolution: Float32Array;
  /** The display baseline used, to fold into the next readback's EMA. */
  displayBaseline: number;
}

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
  /** GPU bytes for a batch; default the engine's estimateBytes, else 24 B per sample. */
  estimateBytes?(nCells: number, T: number): number;
  /**
   * Whether a tile's working traces have their scalar baseline pinned to 0
   * (Rust `Solver.filtered`: high-pass filtered or baseline-subtracted). When
   * false the GPU re-estimates the baseline every iteration. Depends on the
   * producer's preprocessing (CaTune's always ends with subtract_baseline).
   */
  filtered: boolean | ((tile: SolveTile) => boolean);
  /** Solution constraint. Default 'nonneg' (CaTune); CaDecon uses 'box01'. */
  constraint?:
    BatchFistaParams['constraint'] | ((tile: SolveTile) => BatchFistaParams['constraint']);
  /** Working trace per cell of the tile (filter + baseline subtraction done). */
  prepare(tile: SolveTile): Promise<Float32Array[]>;
  /**
   * Display reconvolution for one cell. `prevDisplayBaseline` is the display
   * baseline of this cell's previous readback in the same hand-out (null on
   * the first), so the app can smooth it like the WASM solver's EMA.
   */
  reconvolve(
    solution: Float32Array,
    workingTrace: Float32Array,
    params: SolverParams,
    prevDisplayBaseline: number | null,
  ): DisplayReconvolution;
  /**
   * Participation gate (calibration hook): null = take the tile, otherwise
   * the reason the GPU should sit it out.
   */
  participate?(tile: SolveTile): string | null;
  /**
   * Once this fraction of a batch's rows has settled (converged, or the tile
   * cancelled) and other tiles wait, the remaining tiles yield (complete
   * unconverged with their state) so a few slow cells do not hold the GPU.
   * Default DEFAULT_REFILL_FRACTION; 1 disables it.
   */
  refillFraction?: number;
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
  /** Display baseline of the previous readback per cell (EMA state). */
  displayBaseline: (number | null)[];
}

export function createGpuBatchConsumer(options: GpuBatchConsumerOptions): GpuBatchConsumer {
  const name = options.name ?? 'webgpu';
  const sizer = createQuantumSizer(options.quantum);
  const tol = options.tol ?? 1e-4;
  const maxIters = options.maxIters ?? 20000;
  const maxBudget = options.maxMemoryBudgetBytes ?? 2 * 1024 * 1024 * 1024;
  const refillFraction = options.refillFraction ?? DEFAULT_REFILL_FRACTION;
  const filteredOf = (t: SolveTile) =>
    typeof options.filtered === 'function' ? options.filtered(t) : options.filtered;
  const constraintOf = (t: SolveTile): BatchFistaParams['constraint'] =>
    typeof options.constraint === 'function'
      ? options.constraint(t)
      : (options.constraint ?? 'nonneg');
  let engine: BatchFistaEngine | null = null;
  const estimate = (n: number, T: number) =>
    options.estimateBytes?.(n, T) ?? engine?.estimateBytes?.(n, T) ?? 24 * n * T;
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
    yieldedTiles: 0,
  };
  const emitStats = () => options.onStats?.({ ...stats });
  // A function, not an inline comparison: `fail()` can run during an await,
  // which TypeScript's narrowing of `stats.state` does not see.
  const isDead = () => stats.state === 'dead';

  function batchKey(tile: SolveTile): string {
    const p = tile.params;
    const len = tile.traces[0]?.length ?? 0;
    return [
      len,
      p.tauRise,
      p.tauDecay,
      p.lambda,
      p.fs,
      p.filterEnabled,
      filteredOf(tile),
      constraintOf(tile),
    ].join('|');
  }

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

  /** Out of memory: lower the budget (or remember the size), give the batch back. */
  function onOutOfMemory(live: LiveTile[], N: number, T: number, err: unknown): void {
    const est = estimate(N, T);
    oomCeiling = Math.min(oomCeiling, est);
    if (live.length > 1) {
      stats.memoryBudgetBytes = Math.max(1, Math.floor(Math.min(stats.memoryBudgetBytes, est) / 2));
    }
    console.warn(
      `[gpu-batch-consumer] out of memory with ${N} cells x ${T} (${String(err)}); budget now ` +
        `${(stats.memoryBudgetBytes / 2 ** 20).toFixed(0)} MiB` +
        (live.length > 1 ? ', re-queuing the batch' : '; tiles this large go to other consumers'),
    );
    const unsettled = live.filter((lt) => !lt.settled).map((lt) => lt.tile.id);
    for (const lt of live) lt.settled = true;
    emitStats();
    ctx?.giveBack(unsettled);
  }

  function warmStartFor(live: LiveTile[], N: number, T: number): BatchWarmStart | undefined {
    let warm: BatchWarmStart | undefined;
    const ensure = (): BatchWarmStart =>
      (warm ??= {
        solution: new Float32Array(N * T),
        prev: new Float32Array(N * T),
        momentum: new Uint8Array(N),
        tFista: new Float64Array(N),
        iterations: new Uint32Array(N),
      });
    for (const lt of live) {
      const ws = lt.tile.warmStart;
      for (let k = 0; k < lt.tile.cells.length; k++) {
        lt.baseIterations[k] = 0;
        const bytes = ws && ws.strategy !== 'cold' ? ws.states[k] : null;
        const d = bytes ? decodeSolverState(bytes) : null;
        if (!d || d.solution.length !== T) continue;
        const row = lt.offset + k;
        const w = ensure();
        w.solution.set(d.solution, row * T);
        w.iterations![row] = d.iteration;
        lt.baseIterations[k] = d.iteration;
        if (ws!.strategy === 'warm') {
          // Continue momentum like WASM load_state; 'warm-no-momentum' resets it.
          w.prev!.set(d.solutionPrev, row * T);
          w.momentum![row] = 1;
          w.tFista![row] = d.tFista;
        }
      }
    }
    return warm;
  }

  async function runBatch(tiles: SolveTile[], clipped: boolean): Promise<void> {
    stats.state = 'running';
    const live: LiveTile[] = tiles.map((tile) => ({
      tile,
      settled: false,
      offset: 0,
      working: [],
      baseIterations: [],
      displayBaseline: tile.cells.map(() => null),
    }));
    batch = live;
    let N = 0;
    let T = 0;
    try {
      const prepared = await Promise.all(tiles.map((t) => options.prepare(t)));
      if (isDead() || disposed) return;
      T = tiles[0].traces[0].length;
      live.forEach((lt, i) => {
        lt.offset = N;
        lt.working = prepared[i];
        N += lt.tile.cells.length;
      });
      const traces = new Float32Array(N * T);
      for (const lt of live) {
        for (let k = 0; k < lt.tile.cells.length; k++) {
          traces.set(lt.working[k], (lt.offset + k) * T);
        }
      }
      const warm = warmStartFor(live, N, T);
      const t0Tile = tiles[0];
      const p = t0Tile.params;
      const params: BatchFistaParams = {
        tauRise: p.tauRise,
        tauDecay: p.tauDecay,
        fs: p.fs,
        lambda: p.lambda,
        constraint: constraintOf(t0Tile),
        tol,
        maxIters,
        filtered: filteredOf(t0Tile),
      };
      await withEngine((e) => e.load(traces, N, T, params, warm, { requireResident: true }));
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

      const rowOf = (sol: BatchSolutions, row: number) =>
        new Float32Array(sol.solutions.subarray(row * T, (row + 1) * T));
      /** Rows not yet converged on the GPU (they are the ones doing work). */
      let activeRows = N;
      let itersThisLoad = 0;
      for (;;) {
        if (live.every((lt) => lt.settled) || isDead() || disposed) break;
        const work = activeRows * T;
        const n = sizer.next(work);
        const t0 = performance.now();
        const status = await withEngine((e) => e.step(n));
        if (isDead() || disposed) return;
        const { iterationsRun } = status;

        // Decide per tile, then read solutions only for the tiles that need them.
        const capped = iterationsRun === 0; // engine hit maxIters
        const others = ctx?.hasWaiting() ?? false;
        itersThisLoad += iterationsRun;
        const finishing = new Set<LiveTile>();
        let settledRows = 0;
        for (const lt of live) {
          const rows = lt.tile.cells.length;
          if (lt.settled) {
            settledRows += rows;
            continue;
          }
          let allConv = true;
          for (let k = 0; k < rows; k++) if (!status.converged[lt.offset + k]) allConv = false;
          if (allConv || capped) {
            finishing.add(lt);
            settledRows += rows;
          }
        }
        // Rolling refill: enough of the batch has settled and work is waiting.
        const refill = others && iterationsRun > 0 && settledRows >= refillFraction * N;
        const readTiles: LiveTile[] = [];
        for (const lt of live) {
          if (lt.settled) continue;
          const t = lt.tile;
          const overBudget = others && itersThisLoad >= (t.maxIterations ?? Infinity);
          if (!finishing.has(lt) && (overBudget || refill)) {
            finishing.add(lt);
            stats.yieldedTiles++;
          }
          if (finishing.has(lt) || (t.wantsIntermediate?.() ?? true)) readTiles.push(lt);
        }
        const finalRows: number[] = [];
        const shownRows: number[] = [];
        for (const lt of readTiles) {
          const target = finishing.has(lt) ? finalRows : shownRows;
          for (let k = 0; k < lt.tile.cells.length; k++) target.push(lt.offset + k);
        }
        const finalSol =
          finalRows.length > 0
            ? await withEngine((e) => e.readSolutionsFor(finalRows, { withState: true }))
            : null;
        const shownSol =
          shownRows.length > 0 ? await withEngine((e) => e.readSolutionsFor(shownRows)) : null;
        const ms = performance.now() - t0;
        if (isDead() || disposed) return;

        sizer.record(iterationsRun, ms, work);
        stats.lastQuantumIterations = iterationsRun;
        stats.lastQuantumMs = ms;
        stats.lastReadbackCells = finalRows.length + shownRows.length;
        stats.iterationsPerSec = ms > 0 ? (iterationsRun / ms) * 1000 : 0;
        stats.sampleItersPerSec = stats.iterationsPerSec * work;
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
        activeRows = 0;
        for (let r = 0; r < N; r++) if (!status.converged[r]) activeRows++;

        let fi = 0;
        let si = 0;
        for (const lt of readTiles) {
          const t = lt.tile;
          const final = finishing.has(lt);
          const r0 = final ? fi : si;
          if (final) fi += t.cells.length;
          else si += t.cells.length;
          if (lt.settled) continue; // cancelled while the readback was awaited
          const sol = (final ? finalSol : shownSol)!;
          const iterationOf = (k: number) =>
            lt.baseIterations[k] + status.iterations[lt.offset + k];
          const display = (k: number, solution: Float32Array) => {
            const d = options.reconvolve(solution, lt.working[k], t.params, lt.displayBaseline[k]);
            lt.displayBaseline[k] = d.displayBaseline;
            return d.reconvolution;
          };
          if (final) {
            lt.settled = true;
            const st = sol.state;
            const results: TileCellResult[] = t.cells.map((cellIndex, k) => {
              const solution = rowOf(sol, r0 + k);
              const iteration = iterationOf(k);
              return {
                cellIndex,
                solution,
                reconvolution: display(k, solution),
                iteration,
                converged: status.converged[lt.offset + k] !== 0,
                state: encodeSolverState({
                  solution,
                  solutionPrev: st ? st.prev.subarray((r0 + k) * T, (r0 + k + 1) * T) : undefined,
                  tFista: st?.tFista[r0 + k],
                  iteration,
                  baseline: st?.baseline[r0 + k],
                }),
                workingTrace: new Float32Array(lt.working[k]),
                backend: name,
              };
            });
            t.onComplete(results);
          } else {
            const updates: TileCellUpdate[] = t.cells.map((cellIndex, k) => {
              const solution = rowOf(sol, r0 + k);
              return {
                cellIndex,
                solution,
                reconvolution: display(k, solution),
                iteration: iterationOf(k),
              };
            });
            t.onIntermediate(updates);
          }
        }
        if (capped) break;
      }
    } catch (err) {
      if (isDead() || disposed) return;
      if (isGpuOutOfMemoryError(err)) onOutOfMemory(live, N, T, err);
      else if (isGpuDeviceLostError(err)) fail((err as Error).message);
      else fail(`GPU solve failed: ${String(err)}`);
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

  function declineReason(tile: SolveTile): string | null {
    const T = tile.traces[0]?.length ?? 0;
    const maxT = engine?.maxTraceLength;
    if (maxT !== undefined && T > maxT) {
      return `a ${T}-sample window exceeds this GPU's limit (${maxT} samples)`;
    }
    const est = estimate(tile.cells.length, T);
    if (est >= oomCeiling) {
      return `tile needs ~${(est / 2 ** 20).toFixed(0)} MiB; the GPU ran out of memory at that size`;
    }
    if (est > maxBudget) {
      return `tile needs ~${(est / 2 ** 20).toFixed(0)} MiB, over the GPU memory budget`;
    }
    return null;
  }

  function attach(context: ConsumerContext): void {
    ctx = context;
    if (pendingFailure !== null) {
      const reason = pendingFailure;
      pendingFailure = null;
      // Not synchronously: the scheduler is still registering this consumer.
      queueMicrotask(() => context.failed(reason));
    }
  }

  const consumer: GpuBatchConsumer = {
    name,
    attach,
    accepts(tile) {
      if (isDead()) return `GPU unavailable (${stats.failure ?? 'failed'})`;
      if (tile.params.convMode !== 'banded') {
        return 'GPU solver is banded AR(2) only; FFT conv mode is selected';
      }
      return declineReason(tile) ?? options.participate?.(tile) ?? null;
    },
    take(offered, context) {
      if (ctx !== context) attach(context);
      if (stats.state !== 'idle' || offered.length === 0) return [];
      const key = batchKey(offered[0]);
      const T = offered[0].traces[0]?.length ?? 0;
      const taken: SolveTile[] = [];
      let cells = 0;
      let clipped = false;
      for (const t of offered) {
        if (batchKey(t) !== key) continue;
        const next = cells + t.cells.length;
        if (taken.length > 0 && estimate(next, T) > stats.memoryBudgetBytes) {
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
