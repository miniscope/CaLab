// Main-thread client for gpu-prep-worker.ts: working traces for the GPU
// backend (cached per cell, window, filter setting and kernel, since the
// bandpass cutoffs and the baseline window both depend on tau; LRU), and
// WASM reference solves for the dev readout's GPU-vs-WASM check.
//
// TODO(gpu-backend): preprocessing runs on ONE worker, serially, so a
// parameter change that misses the cache (tau or filter changed) costs
// cells x per-cell prep before the GPU batch can load. Measured in Chromium
// on an Apple M5 Max, demo data (20 cells, 30 Hz, 1381-sample padded
// windows), round trip per trace from `prepStats`: 11.4 ms (8 to 10 ms with
// 5 cells), so ~0.23 s before a 20-cell batch can start, growing linearly
// with cells and window length. Spread it over the WASM pool or a few prep
// workers once that shows up next to the GPU solve time.

import type { SolverParams, WarmStartStrategy } from '@calab/core';
import type { GpuPrepInbound, GpuPrepOutbound } from '../workers/gpu-prep-types.ts';

const CACHE_LIMIT = 256;

export interface ReferenceSolve {
  working: Float32Array;
  solution: Float32Array;
  /** Cumulative (including iterations carried in by the warm start). */
  iterations: number;
  /** Iterations the reference solve ran itself. */
  iterationsRun: number;
  converged: boolean;
  ms: number;
  /** Solve loop only (no preprocessing). */
  solveMs: number;
}

/** Cache misses served by the prep worker: count and summed round-trip time. */
export interface PrepStats {
  computed: number;
  totalMs: number;
  cacheHits: number;
}

type Pending = {
  resolve(v: GpuPrepOutbound): void;
  reject(e: Error): void;
};

export interface GpuPrepClient {
  workingTrace(
    cellIndex: number,
    windowStart: number,
    trace: Float32Array,
    params: SolverParams,
  ): Promise<Float32Array>;
  reference(
    trace: Float32Array,
    params: SolverParams,
    warmState?: Uint8Array | null,
    warmStrategy?: WarmStartStrategy,
    maxIters?: number,
  ): Promise<ReferenceSolve>;
  prepStats(): PrepStats;
  dispose(): void;
}

export function workingTraceKey(
  cellIndex: number,
  windowStart: number,
  length: number,
  p: SolverParams,
): string {
  return [cellIndex, windowStart, length, p.filterEnabled, p.tauRise, p.tauDecay, p.fs].join('|');
}

export function createGpuPrepClient(createWorker: () => Worker): GpuPrepClient {
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let counter = 0;
  const pending = new Map<number, Pending>();
  /** Insertion order = recency (a hit re-inserts), so the first key is least recently used. */
  const cache = new Map<string, Promise<Float32Array>>();
  const stats: PrepStats = { computed: 0, totalMs: 0, cacheHits: 0 };

  function start(): Promise<void> {
    if (ready) return ready;
    const w = createWorker();
    worker = w;
    ready = new Promise<void>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<GpuPrepOutbound>) => {
        const msg = e.data;
        if (msg.type === 'ready') return resolve();
        if (msg.type === 'init-error') return reject(new Error(msg.message));
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.type === 'error') p.reject(new Error(msg.message));
        else p.resolve(msg);
      };
      w.onerror = (e) => {
        const err = new Error(`prep worker error: ${e.message || 'unknown'}`);
        reject(err);
        for (const p of pending.values()) p.reject(err);
        pending.clear();
      };
    });
    return ready;
  }

  async function request(msg: GpuPrepInbound, transfer: Transferable[]): Promise<GpuPrepOutbound> {
    await start();
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      worker!.postMessage(msg, transfer);
    });
  }

  return {
    workingTrace(cellIndex, windowStart, trace, params) {
      // The key identifies the trace by cell index; without one, never share an entry.
      const key =
        cellIndex >= 0 ? workingTraceKey(cellIndex, windowStart, trace.length, params) : null;
      const hit = key === null ? undefined : cache.get(key);
      if (hit && key !== null) {
        cache.delete(key);
        cache.set(key, hit); // most recently used
        stats.cacheHits++;
        return hit;
      }
      const copy = new Float32Array(trace);
      const t0 = performance.now();
      const p = request({ type: 'prep', id: ++counter, trace: copy, params }, [copy.buffer]).then(
        (m) => {
          stats.computed++;
          stats.totalMs += performance.now() - t0;
          return (m as Extract<GpuPrepOutbound, { type: 'prepped' }>).working;
        },
      );
      if (key === null) return p;
      p.catch(() => cache.delete(key));
      cache.set(key, p);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return p;
    },
    prepStats: () => ({ ...stats }),
    async reference(trace, params, warmState = null, warmStrategy = 'warm', maxIters = 20000) {
      const copy = new Float32Array(trace);
      const warm = warmState ? new Uint8Array(warmState) : null;
      const transfer: Transferable[] = [copy.buffer];
      if (warm) transfer.push(warm.buffer);
      const m = await request(
        {
          type: 'reference',
          id: ++counter,
          trace: copy,
          params,
          maxIters,
          warmState: warm,
          warmStrategy,
        },
        transfer,
      );
      const r = m as Extract<GpuPrepOutbound, { type: 'referenced' }>;
      return {
        working: r.working,
        solution: r.solution,
        iterations: r.iterations,
        iterationsRun: r.iterationsRun,
        converged: r.converged,
        ms: r.ms,
        solveMs: r.solveMs,
      };
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new Error('disposed'));
      pending.clear();
      cache.clear();
    },
  };
}
