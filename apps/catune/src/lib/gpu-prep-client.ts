// Main-thread client for gpu-prep-worker.ts: working traces for the GPU
// backend (cached per cell, window, filter setting and kernel, since the
// bandpass cutoffs and the baseline window both depend on tau), and WASM
// reference solves for the dev readout's GPU-vs-WASM check.

import type { SolverParams } from '@calab/core';
import type { GpuPrepInbound, GpuPrepOutbound } from '../workers/gpu-prep-types.ts';

const CACHE_LIMIT = 256;

export interface ReferenceSolve {
  working: Float32Array;
  solution: Float32Array;
  iterations: number;
  converged: boolean;
  ms: number;
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
    maxIters?: number,
  ): Promise<ReferenceSolve>;
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
  const cache = new Map<string, Promise<Float32Array>>();

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
      const key = workingTraceKey(cellIndex, windowStart, trace.length, params);
      const hit = cache.get(key);
      if (hit) return hit;
      const copy = new Float32Array(trace);
      const p = request({ type: 'prep', id: ++counter, trace: copy, params }, [copy.buffer]).then(
        (m) => (m as Extract<GpuPrepOutbound, { type: 'prepped' }>).working,
      );
      p.catch(() => cache.delete(key));
      cache.set(key, p);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return p;
    },
    async reference(trace, params, warmState = null, maxIters = 20000) {
      const copy = new Float32Array(trace);
      const warm = warmState ? new Uint8Array(warmState) : null;
      const transfer: Transferable[] = [copy.buffer];
      if (warm) transfer.push(warm.buffer);
      const m = await request(
        { type: 'reference', id: ++counter, trace: copy, params, maxIters, warmState: warm },
        transfer,
      );
      const r = m as Extract<GpuPrepOutbound, { type: 'referenced' }>;
      return {
        working: r.working,
        solution: r.solution,
        iterations: r.iterations,
        converged: r.converged,
        ms: r.ms,
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
