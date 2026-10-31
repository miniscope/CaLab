/**
 * Tile scheduler + consumers: dispatch, cancellation, fallback, and the GPU
 * batch consumer's orchestration against a mocked BatchFistaEngine (no WebGPU
 * in Vitest).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SolverParams } from '@calab/core';
import { createTileScheduler } from '../tile-scheduler.ts';
import { createGpuBatchConsumer, type BatchFistaEngine } from '../gpu-batch-consumer.ts';
import { createWasmPoolConsumer } from '../wasm-pool-consumer.ts';
import { createQuantumSizer } from '../quantum-sizer.ts';
import { decodeSolverState, encodeSolverState } from '../solver-state-codec.ts';
import { getRequestedBackend } from '../backend-selection.ts';
import {
  createCalibrationStore,
  gpuParticipationVerdict,
  softwareAdapterReason,
} from '../calibration.ts';
import { GpuOutOfMemoryError } from '../gpu-batch-consumer.ts';
import type { SolveTile, TileCellResult, TileConsumer, TileWarmStart } from '../solve-tiles.ts';
import type { BaseJob, WorkerPool } from '../worker-pool.ts';

const PARAMS: SolverParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  lambda: 0.5,
  fs: 30,
  filterEnabled: false,
  convMode: 'banded',
};

/** Let n macrotask turns pass (the mock engine yields one per readback). */
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

let nextId = 0;
interface TileLog {
  tile: SolveTile;
  intermediates: number;
  results: TileCellResult[] | null;
  cancelled: boolean;
  error: string | null;
}

function makeTile(
  cells: number[],
  opts: {
    T?: number;
    params?: Partial<SolverParams>;
    warm?: TileWarmStart | null;
    maxIterations?: number;
    priority?: number;
    wantsIntermediate?: boolean;
  } = {},
): TileLog {
  const T = opts.T ?? 8;
  const log: TileLog = {
    tile: null as unknown as SolveTile,
    intermediates: 0,
    results: null,
    cancelled: false,
    error: null,
  };
  log.tile = {
    id: ++nextId,
    cells,
    windowStart: 0,
    traces: cells.map((c) => new Float32Array(T).fill(c + 1)),
    params: { ...PARAMS, ...opts.params },
    warmStart: opts.warm ?? null,
    maxIterations: opts.maxIterations,
    getPriority: opts.priority === undefined ? undefined : () => opts.priority!,
    wantsIntermediate:
      opts.wantsIntermediate === undefined ? undefined : () => opts.wantsIntermediate!,
    onIntermediate: () => {
      log.intermediates++;
    },
    onComplete: (r) => {
      log.results = r;
    },
    onCancelled: () => {
      log.cancelled = true;
    },
    onError: (m) => {
      log.error = m;
    },
  };
  return log;
}

/** Records take() calls; the test settles tiles by hand. */
function manualConsumer(name: string, accepts: (t: SolveTile) => string | null = () => null) {
  const held: SolveTile[] = [];
  const takes: number[][] = [];
  const cancels: number[] = [];
  let busy = false;
  let ctxRef: Parameters<TileConsumer['take']>[1] | null = null;
  const consumer: TileConsumer = {
    name,
    accepts,
    take(offered, ctx) {
      ctxRef = ctx;
      if (busy) return [];
      takes.push(offered.map((t) => t.id));
      held.push(...offered);
      return [...offered];
    },
    cancel(id) {
      cancels.push(id);
      held.find((t) => t.id === id)?.onCancelled();
    },
    calibration: () => null,
    dispose: vi.fn(),
  };
  return {
    consumer,
    held,
    takes,
    cancels,
    setBusy: (b: boolean) => (busy = b),
    ctx: () => ctxRef!,
  };
}

/**
 * Mock engine: cell c converges after convergeAt[c] iterations; the solution
 * is the trace scaled by min(1, iteration / convergeAt).
 */
function mockEngine(convergeAt: (cell: number) => number) {
  const calls = {
    loads: [] as { nCells: number; T: number; warm?: Float32Array; traces: Float32Array }[],
    steps: [] as number[],
    statusReads: 0,
    solutionReads: [] as number[][],
    destroyed: 0,
  };
  let traces: Float32Array = new Float32Array(0);
  let nCells = 0;
  let T = 0;
  let done = 0;
  let failOnStep: Error | null = null;
  let failOnLoad: Error | null = null;
  let stepGate: Promise<void> | null = null;
  const engine: BatchFistaEngine = {
    load(tr, n, len, _p, warm) {
      if (failOnLoad) {
        const e = failOnLoad;
        failOnLoad = null;
        throw e;
      }
      traces = tr;
      nCells = n;
      T = len;
      done = 0;
      calls.loads.push({ nCells: n, T: len, warm, traces: tr });
    },
    async step(n) {
      calls.steps.push(n);
      if (stepGate) await stepGate;
      if (failOnStep) throw failOnStep;
      done += n;
      let all = true;
      for (let c = 0; c < nCells; c++) if (done < convergeAt(c)) all = false;
      return { allConverged: all, iterationsRun: n };
    },
    async readStatus() {
      await new Promise((r) => setTimeout(r, 0));
      calls.statusReads++;
      const iterations = new Uint32Array(nCells);
      const converged = new Uint8Array(nCells);
      for (let c = 0; c < nCells; c++) {
        const k = convergeAt(c);
        iterations[c] = Math.min(done, k);
        converged[c] = done >= k ? 1 : 0;
      }
      return { iterations, converged };
    },
    async readSolutionsFor(cells) {
      calls.solutionReads.push([...cells]);
      const solutions = new Float32Array(cells.length * T);
      const iterations = new Uint32Array(cells.length);
      const converged = new Uint8Array(cells.length);
      cells.forEach((c, i) => {
        const k = convergeAt(c);
        iterations[i] = Math.min(done, k);
        converged[i] = done >= k ? 1 : 0;
        for (let t = 0; t < T; t++) {
          solutions[i * T + t] = traces[c * T + t] * Math.min(1, done / k);
        }
      });
      return { solutions, iterations, converged };
    },
    groupCount: 1,
    destroy() {
      calls.destroyed++;
    },
  };
  return {
    engine,
    calls,
    failNextStep: (e: Error) => (failOnStep = e),
    failNextLoad: (e: Error) => (failOnLoad = e),
    gate: (p: Promise<void> | null) => (stepGate = p),
  };
}

function gpuConsumer(
  engine: BatchFistaEngine | Promise<BatchFistaEngine>,
  extra: Partial<Parameters<typeof createGpuBatchConsumer>[0]> = {},
) {
  return createGpuBatchConsumer({
    createEngine: async () => engine,
    prepare: async (tile) => tile.traces.map((t) => new Float32Array(t)),
    reconvolve: (s) => new Float32Array(s),
    quantum: { initialIterations: 10, maxIterations: 10 },
    ...extra,
  });
}

describe('tile scheduler', () => {
  it('offers tiles submitted in one synchronous loop together, in priority order', async () => {
    const a = manualConsumer('a');
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t1 = makeTile([0], { priority: 2 });
    const t2 = makeTile([1], { priority: 0 });
    const t3 = makeTile([2], { priority: 1 });
    s.submit(t1.tile);
    s.submit(t2.tile);
    s.submit(t3.tile);
    expect(a.takes).toEqual([]);
    await flush();
    expect(a.takes).toEqual([[t2.tile.id, t3.tile.id, t1.tile.id]]);
  });

  it('cancels a waiting tile without involving a consumer', async () => {
    const a = manualConsumer('a');
    a.setBusy(true);
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    s.cancel(t.tile.id);
    expect(t.cancelled).toBe(true);
    expect(a.cancels).toEqual([]);
  });

  it('forwards cancel of a taken tile to its consumer', async () => {
    const a = manualConsumer('a');
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    s.cancel(t.tile.id);
    expect(a.cancels).toEqual([t.tile.id]);
    expect(t.cancelled).toBe(true);
  });

  it('settles a tile once and drops callbacks after it settled', async () => {
    const a = manualConsumer('a');
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    a.held[0].onComplete([]);
    a.held[0].onCancelled();
    a.held[0].onIntermediate([]);
    expect(t.results).toEqual([]);
    expect(t.cancelled).toBe(false);
    expect(t.intermediates).toBe(0);
  });

  it('routes a tile past a consumer that declines it and reports why', async () => {
    const gpu = manualConsumer('gpu', (t) => (t.params.convMode === 'fft' ? 'banded only' : null));
    const wasm = manualConsumer('wasm');
    const skipped: string[] = [];
    const s = createTileScheduler({
      consumers: [gpu.consumer, wasm.consumer],
      onSkipped: (_t, c, reason) => skipped.push(`${c.name}: ${reason}`),
    });
    const banded = makeTile([0]);
    const fft = makeTile([1], { params: { convMode: 'fft' } });
    s.submit(banded.tile);
    s.submit(fft.tile);
    await flush();
    expect(gpu.takes).toEqual([[banded.tile.id]]);
    expect(wasm.takes).toEqual([[fft.tile.id]]);
    expect(skipped).toEqual(['gpu: banded only']);
  });

  it('keeps a preferred tile waiting for its busy consumer instead of handing it on', async () => {
    const gpu = manualConsumer('gpu');
    const wasm = manualConsumer('wasm');
    gpu.setBusy(true);
    const s = createTileScheduler({ consumers: [gpu.consumer, wasm.consumer] });
    s.submit(makeTile([0]).tile);
    await flush();
    expect(wasm.takes).toEqual([]);
    expect(s.waiting).toBe(1);
    expect(gpu.ctx().hasWaiting()).toBe(true);
  });

  it('re-queues a failed consumer’s tiles to the next consumer and drops its late callbacks', async () => {
    const gpu = manualConsumer('gpu');
    const wasm = manualConsumer('wasm');
    const failures: string[] = [];
    const s = createTileScheduler({
      consumers: [gpu.consumer, wasm.consumer],
      onConsumerFailed: (c, r) => failures.push(`${c.name}: ${r}`),
    });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    const stale = gpu.held[0];
    gpu.ctx().failed('device lost');
    await flush();
    expect(failures).toEqual(['gpu: device lost']);
    expect(gpu.consumer.dispose).toHaveBeenCalled();
    expect(wasm.takes).toEqual([[t.tile.id]]);
    stale.onComplete([]); // from the dead consumer: ignored
    expect(t.results).toBeNull();
    wasm.held[0].onComplete([]);
    expect(t.results).toEqual([]);
  });

  it('fails a tile no consumer accepts', async () => {
    const gpu = manualConsumer('gpu', () => 'nope');
    const s = createTileScheduler({ consumers: [gpu.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    expect(t.error).toMatch(/gpu: nope/);
  });

  it('cancels everything on dispose', async () => {
    const a = manualConsumer('a');
    a.setBusy(true);
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    s.dispose();
    expect(t.cancelled).toBe(true);
  });
});

describe('GPU batch consumer', () => {
  it('solves every offered tile in one batch and completes each when its cells converge', async () => {
    const m = mockEngine((c) => (c === 0 ? 10 : 30));
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const t0 = makeTile([0]);
    const t1 = makeTile([1]);
    s.submit(t0.tile);
    s.submit(t1.tile);
    await flush(50);
    expect(m.calls.loads).toHaveLength(1);
    expect(m.calls.loads[0].nCells).toBe(2);
    expect(t0.results?.[0].converged).toBe(true);
    expect(t0.results?.[0].iteration).toBe(10);
    expect(t1.intermediates).toBe(2); // after 10 and 20 iterations
    expect(t1.results?.[0].converged).toBe(true);
    expect(t1.results?.[0].iteration).toBe(30);
    expect(Array.from(t1.results![0].solution)).toEqual(new Array(8).fill(2));
    expect(t1.results![0].workingTrace).toBeDefined();
    expect(gpu.stats.cellsLoaded).toBe(2);
    expect(gpu.calibration()?.sampleItersPerSec).toBeGreaterThan(0);
  });

  it('flattens multi-cell tiles and completes the tile when all its cells converge', async () => {
    const m = mockEngine((c) => 10 * (c + 1));
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const t = makeTile([5, 6, 7]);
    s.submit(t.tile);
    await flush(50);
    expect(m.calls.loads[0].nCells).toBe(3);
    expect(t.results?.map((r) => r.cellIndex)).toEqual([5, 6, 7]);
    expect(t.results?.every((r) => r.converged)).toBe(true);
    expect(t.intermediates).toBe(2);
  });

  it('only batches tiles that share window length and parameters', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const a = makeTile([0], { T: 8 });
    const b = makeTile([1], { T: 16 });
    s.submit(a.tile);
    s.submit(b.tile);
    await flush(50);
    expect(m.calls.loads.map((l) => l.T)).toEqual([8, 16]);
    expect(a.results).not.toBeNull();
    expect(b.results).not.toBeNull();
  });

  it('warm starts from the tile’s solver state and continues its iteration count', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const prev = new Float32Array(8).fill(0.5);
    const warm = makeTile([0], {
      warm: { strategy: 'warm', states: [encodeSolverState({ solution: prev, iteration: 200 })] },
    });
    s.submit(warm.tile);
    await flush(50);
    expect(Array.from(m.calls.loads[0].warm!)).toEqual(Array.from(prev));
    expect(warm.results?.[0].iteration).toBe(210);
    const state = decodeSolverState(warm.results![0].state)!;
    expect(state.iteration).toBe(210);
    expect(Array.from(state.solution)).toEqual(new Array(8).fill(1));
  });

  it('ignores the warm state on a cold strategy', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const t = makeTile([0], {
      warm: {
        strategy: 'cold',
        states: [encodeSolverState({ solution: new Float32Array(8), iteration: 5 })],
      },
    });
    s.submit(t.tile);
    await flush(50);
    expect(m.calls.loads[0].warm).toBeUndefined();
    expect(t.results?.[0].iteration).toBe(10);
  });

  it('stops the batch once every tile is cancelled, then takes new work', async () => {
    const m = mockEngine(() => 1000);
    let release!: () => void;
    m.gate(new Promise<void>((r) => (release = r)));
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const old = makeTile([0]);
    s.submit(old.tile);
    await flush(20);
    s.cancel(old.tile.id);
    expect(old.cancelled).toBe(true);
    const fresh = makeTile([0], { params: { lambda: 1 } });
    s.submit(fresh.tile);
    m.gate(null);
    release();
    await flush(20);
    // One quantum ran for the cancelled batch, then the fresh tile was loaded.
    expect(m.calls.loads).toHaveLength(2);
    expect(old.intermediates).toBe(0);
    expect(old.results).toBeNull();
  });

  it('yields unconverged tiles at their iteration budget while other tiles wait', async () => {
    const m = mockEngine(() => 1000);
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const running = makeTile([0], { maxIterations: 20 });
    s.submit(running.tile);
    await flush(4);
    const waiting = makeTile([1], { T: 16 });
    s.submit(waiting.tile);
    await flush(60);
    expect(running.results?.[0].converged).toBe(false);
    expect(running.results?.[0].iteration).toBeGreaterThanOrEqual(20);
    expect(m.calls.loads.map((l) => l.T)).toContain(16);
  });

  it('runs past the budget when nothing else is waiting', async () => {
    const m = mockEngine(() => 50);
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const t = makeTile([0], { maxIterations: 20 });
    s.submit(t.tile);
    await flush(60);
    expect(t.results?.[0].converged).toBe(true);
    expect(t.results?.[0].iteration).toBe(50);
    expect(m.calls.loads).toHaveLength(1);
  });

  it('declines FFT tiles', () => {
    const gpu = gpuConsumer(mockEngine(() => 1).engine);
    expect(gpu.accepts(makeTile([0], { params: { convMode: 'fft' } }).tile)).toMatch(/FFT/);
    expect(gpu.accepts(makeTile([0]).tile)).toBeNull();
  });

  it('passes the group byte budget to the engine', async () => {
    const createEngine = vi.fn(async () => mockEngine(() => 1).engine);
    createGpuBatchConsumer({
      createEngine,
      groupBudgetBytes: 1 << 20,
      prepare: async () => [],
      reconvolve: (x) => x,
    });
    expect(createEngine).toHaveBeenCalledWith({ maxGroupBytes: 1 << 20 });
  });
});

describe('GPU fallback to the WASM pool', () => {
  function fakePool() {
    const jobs: (BaseJob & { cell: number; complete(): void })[] = [];
    const pool: WorkerPool<BaseJob & { cell: number; complete(): void }> = {
      size: 2,
      dispatch: (j) => jobs.push(j),
      cancel: (id) => jobs.find((j) => j.jobId === id)?.onCancelled(),
      cancelAll() {},
      dispose: vi.fn(),
    };
    const consumer = createWasmPoolConsumer({
      pool,
      buildJob: (tile, k, jobId, cb) => ({
        jobId,
        cell: tile.cells[k],
        onCancelled: cb.onCancelled,
        onError: cb.onError,
        complete: () =>
          cb.onComplete({
            solution: new Float32Array(1),
            reconvolution: new Float32Array(1),
            iteration: 7,
            converged: true,
            state: new Uint8Array(0),
          }),
      }),
    });
    return { jobs, consumer };
  }

  it('moves tiles to the pool when the GPU engine fails mid-solve', async () => {
    const m = mockEngine(() => 1000);
    const gpu = gpuConsumer(m.engine);
    const wasm = fakePool();
    const failures: string[] = [];
    const s = createTileScheduler({
      consumers: [gpu, wasm.consumer],
      onConsumerFailed: (c, r) => failures.push(`${c.name}: ${r}`),
    });
    const t = makeTile([3]);
    s.submit(t.tile);
    await flush(20);
    expect(t.intermediates).toBeGreaterThan(0);
    m.failNextStep(new Error('device lost'));
    await flush(20);
    expect(failures[0]).toMatch(/webgpu: GPU solve failed: Error: device lost/);
    expect(m.calls.destroyed).toBe(1);
    expect(wasm.jobs.map((j) => j.cell)).toEqual([3]);
    wasm.jobs[0].complete();
    expect(t.results?.[0].cellIndex).toBe(3);
    expect(t.results?.[0].iteration).toBe(7);
  });

  it('moves tiles to the pool when the engine cannot be created', async () => {
    const gpu = createGpuBatchConsumer({
      createEngine: () => Promise.reject(new Error('no adapter')),
      prepare: async (tile) => [...tile.traces],
      reconvolve: (x) => x,
    });
    const wasm = fakePool();
    const failures: string[] = [];
    const s = createTileScheduler({
      consumers: [gpu, wasm.consumer],
      onConsumerFailed: (_c, r) => failures.push(r),
    });
    const t = makeTile([1]);
    s.submit(t.tile);
    await flush(20);
    expect(failures[0]).toMatch(/init failed.*no adapter/);
    expect(wasm.jobs).toHaveLength(1);
  });

  it('moves tiles to the pool on fail() (device lost) during a batch', async () => {
    const m = mockEngine(() => 1000);
    const gpu = gpuConsumer(m.engine);
    const wasm = fakePool();
    const s = createTileScheduler({ consumers: [gpu, wasm.consumer] });
    const t = makeTile([2]);
    s.submit(t.tile);
    await flush(6);
    gpu.fail('device lost: destroyed');
    await flush(20);
    expect(gpu.stats.state).toBe('dead');
    expect(wasm.jobs.map((j) => j.cell)).toEqual([2]);
  });

  it('pool consumer completes a multi-cell tile when every cell job completes', async () => {
    const wasm = fakePool();
    const s = createTileScheduler({ consumers: [wasm.consumer] });
    const t = makeTile([4, 5]);
    s.submit(t.tile);
    await flush();
    expect(wasm.jobs.map((j) => j.cell)).toEqual([4, 5]);
    wasm.jobs[0].complete();
    expect(t.results).toBeNull();
    wasm.jobs[1].complete();
    expect(t.results?.map((r) => r.cellIndex)).toEqual([4, 5]);
  });

  it('pool consumer cancels every cell job of a cancelled tile once', async () => {
    const wasm = fakePool();
    const s = createTileScheduler({ consumers: [wasm.consumer] });
    const t = makeTile([4, 5]);
    s.submit(t.tile);
    await flush();
    s.cancel(t.tile.id);
    expect(t.cancelled).toBe(true);
  });
});

describe('helpers', () => {
  it('quantum sizer converges on the wall-clock target', () => {
    const q = createQuantumSizer({ targetMs: 100, initialIterations: 10, smoothing: 1 });
    expect(q.next()).toBe(10);
    q.record(10, 50); // 5 ms / iteration
    expect(q.next()).toBe(20);
    q.record(20, 400); // 20 ms / iteration
    expect(q.next()).toBe(5);
  });

  it('solver state codec round-trips the Rust export_state layout', () => {
    const solution = new Float32Array([1, 2, 3]);
    const bytes = encodeSolverState({ solution, iteration: 42, tFista: 3.5 });
    expect(bytes.byteLength).toBe(24 + 8 * 3);
    const d = decodeSolverState(bytes)!;
    expect(d.iteration).toBe(42);
    expect(d.tFista).toBe(3.5);
    expect(Array.from(d.solution)).toEqual([1, 2, 3]);
    expect(Array.from(d.solutionPrev)).toEqual([1, 2, 3]);
    expect(decodeSolverState(new Uint8Array(10))).toBeNull();
  });

  it('backend selection: URL beats storage, default is wasm', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(getRequestedBackend('', store(null))).toBe('wasm');
    expect(getRequestedBackend('?backend=gpu', store(null))).toBe('gpu');
    expect(getRequestedBackend('', store('gpu'))).toBe('gpu');
    expect(getRequestedBackend('?backend=wasm', store('gpu'))).toBe('wasm');
    expect(getRequestedBackend('?backend=junk', null)).toBe('wasm');
  });
});

describe('GPU batch consumer: readback, memory, serialization', () => {
  it('reads only status each quantum, and solutions only for displayed or finishing tiles', async () => {
    const m = mockEngine((c) => (c === 0 ? 30 : 30));
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu] });
    const shown = makeTile([0]);
    const hidden = makeTile([1], { wantsIntermediate: false });
    s.submit(shown.tile);
    s.submit(hidden.tile);
    await flush(40);
    // Quanta at 10 and 20 iterations read only cell 0 (row 0); at 30 both finish.
    expect(m.calls.solutionReads).toEqual([[0], [0], [0, 1]]);
    expect(m.calls.statusReads).toBe(3);
    expect(hidden.intermediates).toBe(0);
    expect(hidden.results?.[0].converged).toBe(true);
  });

  it('clips a batch to the memory budget and grows the budget after it loads', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine, {
      memoryBudgetBytes: 2 * 24 * 8, // two cells of T = 8
      estimateBytes: (n, T) => 24 * n * T,
    });
    const s = createTileScheduler({ consumers: [gpu] });
    const tiles = [0, 1, 2, 3].map((c) => makeTile([c]));
    for (const t of tiles) s.submit(t.tile);
    await flush(40);
    expect(m.calls.loads.map((l) => l.nCells)).toEqual([2, 2]);
    expect(gpu.stats.memoryBudgetBytes).toBe(4 * 24 * 8);
    expect(tiles.every((t) => t.results !== null)).toBe(true);
  });

  it('gives a batch back and halves the budget on out-of-memory', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine, { estimateBytes: (n, T) => 24 * n * T });
    const s = createTileScheduler({ consumers: [gpu] });
    m.failNextLoad(new GpuOutOfMemoryError());
    const tiles = [0, 1, 2, 3].map((c) => makeTile([c]));
    for (const t of tiles) s.submit(t.tile);
    await flush(60);
    // Halved to 2 cells, then grown after the clipped batch, but kept below the failed size.
    expect(gpu.stats.memoryBudgetBytes).toBe(0.75 * 4 * 24 * 8);
    expect(m.calls.loads.map((l) => l.nCells)).toEqual([2, 2]);
    expect(tiles.every((t) => t.results?.[0].converged)).toBe(true);
    expect(gpu.stats.state).toBe('idle');
  });

  it('fails over when a single tile does not fit', async () => {
    const m = mockEngine(() => 10);
    const gpu = gpuConsumer(m.engine);
    const other = manualConsumer('wasm');
    const s = createTileScheduler({ consumers: [gpu, other.consumer] });
    m.failNextLoad(new GpuOutOfMemoryError());
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush(20);
    expect(gpu.stats.state).toBe('dead');
    expect(other.takes).toEqual([[t.tile.id]]);
  });

  it('never destroys the engine while a step is in flight', async () => {
    const m = mockEngine(() => 1000);
    let release!: () => void;
    const gpu = gpuConsumer(m.engine);
    const s = createTileScheduler({ consumers: [gpu, manualConsumer('wasm').consumer] });
    s.submit(makeTile([0]).tile);
    await flush(4);
    m.gate(new Promise<void>((r) => (release = r)));
    await flush(4); // the next step is now parked on the gate
    gpu.fail('device lost');
    await flush(4);
    expect(m.calls.destroyed).toBe(0);
    release();
    await flush(4);
    expect(m.calls.destroyed).toBe(1);
  });
});

describe('scheduler consumer registration', () => {
  it('adds a preferred consumer later and re-queues on removal', async () => {
    const wasm = manualConsumer('wasm');
    const s = createTileScheduler({ consumers: [wasm.consumer] });
    const gpu = manualConsumer('gpu');
    s.addConsumer(gpu.consumer, 0);
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    expect(gpu.takes).toEqual([[t.tile.id]]);
    s.removeConsumer(gpu.consumer);
    await flush();
    expect(wasm.takes).toEqual([[t.tile.id]]);
    expect(s.consumers.map((c) => c.name)).toEqual(['wasm']);
  });

  it('gives back taken tiles to the queue', async () => {
    const a = manualConsumer('a');
    const s = createTileScheduler({ consumers: [a.consumer] });
    const t = makeTile([0]);
    s.submit(t.tile);
    await flush();
    a.ctx().giveBack([t.tile.id]);
    await flush();
    expect(a.takes).toEqual([[t.tile.id], [t.tile.id]]);
  });
});

describe('calibration', () => {
  const cal = (backend: string, rate: number, at = Date.now()) => ({
    backend,
    sampleItersPerSec: rate,
    measuredAt: at,
  });

  it('expires old measurements', () => {
    const store = createCalibrationStore(1000);
    store.record(cal('webgpu', 5, 0));
    expect(store.get('webgpu', 500)?.sampleItersPerSec).toBe(5);
    expect(store.get('webgpu', 2000)).toBeNull();
  });

  it('gates the GPU on beating the WASM pool', () => {
    expect(gpuParticipationVerdict(null, cal('wasm', 1))).toBeNull();
    expect(gpuParticipationVerdict(cal('gpu', 3), cal('wasm', 1))).toBeNull();
    expect(gpuParticipationVerdict(cal('gpu', 1), cal('wasm', 1))).toMatch(/1.00x/);
  });

  it('rejects software adapters under old and new property names', () => {
    expect(softwareAdapterReason({ vendor: 'apple', architecture: 'metal-3' })).toBeNull();
    expect(softwareAdapterReason({ isFallbackAdapter: true })).toMatch(/fallback/);
    expect(softwareAdapterReason({ info: { isFallbackAdapter: true } })).toMatch(/fallback/);
    expect(softwareAdapterReason({ vendor: 'google', architecture: 'swiftshader' })).toMatch(
      /SwiftShader/,
    );
    expect(softwareAdapterReason({ description: 'SwiftShader Device (Subzero)' })).toMatch(
      /SwiftShader/,
    );
  });
});
