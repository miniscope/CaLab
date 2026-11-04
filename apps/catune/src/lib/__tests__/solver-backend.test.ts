/**
 * Dev backend switch: the default path returns the plain WASM pool; the GPU
 * path solves through a mocked GPU module and falls back to the pool when
 * WebGPU is missing, the adapter is a software one, no device can be created,
 * or the device is lost (after one re-acquire).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerPool } from '@calab/compute';
import type { SolverParams } from '@calab/core';
import type { CaTunePoolJob } from '../catune-pool.ts';
import {
  createSolverPool,
  backendStatus,
  calibrations,
  makeReconvolve,
  type GpuModule,
  type SolverPoolDeps,
} from '../solver-backend.ts';
import type { GpuPrepInbound } from '../../workers/gpu-prep-types.ts';

const PARAMS: SolverParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  lambda: 0.5,
  fs: 30,
  filterEnabled: false,
  convMode: 'banded',
};

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Every pool the backend creates, with its size and dispatched jobs. */
function fakeWasmPools() {
  const pools: { size: number; jobs: CaTunePoolJob[]; dispose: () => void }[] = [];
  const make = (size?: number): WorkerPool<CaTunePoolJob> => {
    const rec = { size: size ?? 8, jobs: [] as CaTunePoolJob[], dispose: vi.fn() };
    pools.push(rec);
    return {
      size: rec.size,
      dispatch: (j) => rec.jobs.push(j),
      cancel: (id) => rec.jobs.find((j) => j.jobId === id)?.onCancelled(),
      cancelAll() {},
      dispose: rec.dispose,
    };
  };
  return { pools, make, allJobs: () => pools.flatMap((p) => p.jobs) };
}

/** Prep worker that returns the raw trace as the working trace. */
function fakePrepWorker(): Worker {
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null,
    postMessage(msg: GpuPrepInbound) {
      setTimeout(() => {
        if (msg.type === 'prep') {
          w.onmessage?.({
            data: { type: 'prepped', id: msg.id, working: msg.trace },
          } as MessageEvent);
        }
      }, 0);
    },
    terminate() {},
  };
  setTimeout(() => w.onmessage?.({ data: { type: 'ready' } } as MessageEvent), 0);
  return w as unknown as Worker;
}

function fakeGpuModule(opts: { device?: boolean; convergeAt?: number; vendor?: string } = {}) {
  const devices: { lose(reason: string): void; destroy: () => void }[] = [];
  /** nCells of every engine load. */
  const loads: number[] = [];
  const convergeAt = opts.convergeAt ?? 40;
  const mod: GpuModule = {
    async requestGpuDevice() {
      if (opts.device === false) return null;
      let lose!: (info: { reason: string; message: string }) => void;
      const lost = new Promise<{ reason: string; message: string }>((r) => (lose = r));
      const device = {
        adapterInfo: { vendor: opts.vendor ?? 'test', architecture: 'fake' },
        lost,
        onuncapturederror: null,
        pushErrorScope() {},
        popErrorScope: async () => null,
        destroy: vi.fn(),
      };
      devices.push({
        lose: (reason) => lose({ reason, message: 'gone' }),
        destroy: device.destroy,
      });
      return device as unknown as GPUDevice;
    },
    async createGpuFista() {
      let traces: Float32Array = new Float32Array(0);
      let n = 0;
      let T = 0;
      let done = 0;
      const tick = () => new Promise((r) => setTimeout(r, 0));
      return {
        async load(tr, nCells, len) {
          traces = tr;
          n = nCells;
          T = len;
          done = 0;
          loads.push(nCells);
        },
        async step(k) {
          await tick();
          done += k;
          return {
            allConverged: done >= convergeAt,
            iterationsRun: k,
            iterations: new Uint32Array(n).fill(Math.min(done, convergeAt)),
            converged: new Uint8Array(n).fill(done >= convergeAt ? 1 : 0),
          };
        },
        async readSolutionsFor(cells) {
          const solutions = new Float32Array(cells.length * T);
          cells.forEach((c, i) => solutions.set(traces.subarray(c * T, (c + 1) * T), i * T));
          return {
            solutions,
            iterations: new Uint32Array(cells.length).fill(Math.min(done, convergeAt)),
            converged: new Uint8Array(cells.length).fill(done >= convergeAt ? 1 : 0),
          };
        },
        groupCount: 1,
        destroy() {},
      };
    },
    computeBandedParams: () => ({ g1F32: 0.5, g2F32: 0, invPeakF32: 1 }),
  };
  return { mod, devices, loads };
}

function gpuDeps(mod: GpuModule, extra: Partial<SolverPoolDeps> = {}): SolverPoolDeps {
  return {
    requested: 'gpu',
    webGpuUnavailable: () => null,
    probeAdapter: async () => ({ vendor: 'test', architecture: 'fake' }),
    loadGpuModule: async () => mod,
    createPrepWorker: fakePrepWorker,
    wasmWorkersWithGpu: 2,
    wasmWorkersFull: 8,
    ...extra,
  };
}

interface Log {
  complete: number[];
  intermediate: number;
  iterations: number[];
}

function job(jobId: number, cellIndex: number, log: Log): CaTunePoolJob {
  return {
    jobId,
    cellIndex,
    windowStart: 0,
    trace: new Float32Array(16).fill(cellIndex + 1),
    params: PARAMS,
    warmState: null,
    warmStrategy: 'cold',
    maxIterations: 200,
    getPriority: () => 0,
    onIntermediate: () => log.intermediate++,
    onComplete: (_s, _r, _st, iterations) => {
      log.complete.push(jobId);
      log.iterations.push(iterations);
    },
    onCancelled: () => {},
    onError: (m) => {
      throw new Error(m);
    },
  };
}

describe('solver backend selection', () => {
  let log: Log;
  beforeEach(() => {
    log = { complete: [], intermediate: 0, iterations: [] };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns the WASM pool itself when the GPU is not requested', () => {
    const wasm = fakeWasmPools();
    const made: WorkerPool<CaTunePoolJob>[] = [];
    const pool = createSolverPool(
      (size) => {
        const p = wasm.make(size);
        made.push(p);
        return p;
      },
      { requested: 'wasm' },
    );
    expect(made).toHaveLength(1);
    expect(pool).toBe(made[0]);
    expect(wasm.pools[0].size).toBe(8); // default sizing (no explicit size passed)
    expect(backendStatus()).toEqual({ requested: 'wasm', active: 'wasm-pool' });
  });

  it('solves on the GPU when requested and keeps the WASM pool small', async () => {
    const wasm = fakeWasmPools();
    const gpu = fakeGpuModule();
    const pool = createSolverPool(wasm.make, gpuDeps(gpu.mod));
    pool.dispatch(job(1, 0, log));
    pool.dispatch(job(2, 1, log));
    await flush();
    expect(backendStatus().active).toBe('webgpu');
    expect(backendStatus().adapter).toBe('test / fake');
    expect(wasm.pools.map((p) => p.size)).toEqual([2]);
    expect(log.complete.sort()).toEqual([1, 2]);
    expect(log.iterations).toEqual([40, 40]);
    expect(wasm.allJobs()).toHaveLength(0);
    pool.dispose();
  });

  it('uses a full-size WASM pool when WebGPU is unavailable', async () => {
    const wasm = fakeWasmPools();
    const pool = createSolverPool(
      wasm.make,
      gpuDeps(fakeGpuModule().mod, { webGpuUnavailable: () => 'no navigator.gpu' }),
    );
    pool.dispatch(job(1, 0, log));
    await flush(2);
    expect(backendStatus().active).toBe('wasm-pool');
    expect(backendStatus().reason).toMatch(/no navigator.gpu/);
    expect(wasm.pools.map((p) => p.size)).toEqual([8]);
    expect(wasm.allJobs().map((j) => j.cellIndex)).toEqual([0]);
    pool.dispose();
  });

  it('refuses a software (SwiftShader) adapter and falls back', async () => {
    const wasm = fakeWasmPools();
    const pool = createSolverPool(
      wasm.make,
      gpuDeps(fakeGpuModule().mod, {
        probeAdapter: async () => ({ vendor: 'google', architecture: 'swiftshader' }),
      }),
    );
    pool.dispatch(job(1, 4, log));
    await flush();
    expect(backendStatus().active).toBe('wasm-pool');
    expect(backendStatus().reason).toMatch(/SwiftShader/);
    expect(wasm.pools.map((p) => p.size)).toEqual([2, 8]);
    expect(wasm.pools[1].jobs.map((j) => j.cellIndex)).toEqual([4]);
    pool.dispose();
  });

  it('falls back when no GPU device can be created', async () => {
    const wasm = fakeWasmPools();
    const pool = createSolverPool(wasm.make, gpuDeps(fakeGpuModule({ device: false }).mod));
    pool.dispatch(job(1, 2, log));
    await flush();
    expect(backendStatus().active).toBe('wasm-pool');
    expect(backendStatus().reason).toMatch(/no WebGPU adapter/);
    expect(wasm.allJobs().map((j) => j.cellIndex)).toEqual([2]);
    pool.dispose();
  });

  it('re-acquires the device once after a loss, then falls back to the WASM pool', async () => {
    const wasm = fakeWasmPools();
    const gpu = fakeGpuModule({ convergeAt: 1e9 });
    const pool = createSolverPool(wasm.make, gpuDeps(gpu.mod));
    pool.dispatch(job(7, 3, log));
    await flush(10);
    expect(log.intermediate).toBeGreaterThan(0);

    gpu.devices[0].lose('unknown');
    await flush(20);
    expect(gpu.devices).toHaveLength(2); // re-acquired
    expect(backendStatus().active).toBe('webgpu');
    expect(wasm.allJobs()).toHaveLength(0);
    const before = log.intermediate;
    await flush(5);
    expect(log.intermediate).toBeGreaterThan(before); // solving again on the new device

    gpu.devices[1].lose('unknown');
    await flush(20);
    expect(backendStatus().active).toBe('wasm-pool');
    expect(backendStatus().reason).toMatch(/device lost/);
    expect(wasm.pools.map((p) => p.size)).toEqual([2, 8]);
    expect(wasm.pools[1].jobs.map((j) => j.cellIndex)).toEqual([3]);
    // The pool job reports back into the original manager job.
    wasm.pools[1].jobs[0].onComplete(
      new Float32Array(16),
      new Float32Array(16),
      new Uint8Array(0),
      5,
      true,
    );
    expect(log.complete).toEqual([7]);
    pool.dispose();
  });

  it('routes FFT-mode jobs to the WASM pool and says why', async () => {
    const wasm = fakeWasmPools();
    const pool = createSolverPool(wasm.make, gpuDeps(fakeGpuModule().mod));
    const j = job(1, 0, log);
    j.params = { ...PARAMS, convMode: 'fft' };
    pool.dispatch(j);
    await flush();
    expect(wasm.allJobs().map((x) => x.jobId)).toEqual([1]);
    expect(backendStatus().reason).toMatch(/FFT/);
    pool.dispose();
  });

  it('reconvolution adds the mean residual as display baseline', () => {
    const rc = makeReconvolve(() => ({ g1F32: 0, g2F32: 0, invPeakF32: 1 }));
    // g = 0: K*s is s delayed by one sample.
    const out = rc(new Float32Array([1, 0, 0, 0]), new Float32Array([2, 2, 2, 2]), PARAMS, null);
    // K*s = [0, 1, 0, 0]; baseline = mean([2, 1, 2, 2]) = 1.75
    expect(Array.from(out.reconvolution)).toEqual([1.75, 2.75, 1.75, 1.75]);
    expect(out.displayBaseline).toBe(1.75);
  });

  it('display baseline is an EMA over readbacks, like the WASM getter', () => {
    const rc = makeReconvolve(() => ({ g1F32: 0, g2F32: 0, invPeakF32: 1 }));
    const s = new Float32Array(4);
    // raw baseline = mean(working) = 4; previous EMA 1.75: 0.3 * 4 + 0.7 * 1.75 = 2.425
    const out = rc(s, new Float32Array([4, 4, 4, 4]), PARAMS, 1.75);
    expect(out.displayBaseline).toBeCloseTo(2.425, 12);
    expect(out.reconvolution[0]).toBe(Math.fround(2.425));
  });

  it('sends tiles without a cell index to the WASM pool', async () => {
    const wasm = fakeWasmPools();
    const gpu = fakeGpuModule();
    const pool = createSolverPool(wasm.make, gpuDeps(gpu.mod));
    pool.dispatch(job(1, -1, log));
    pool.dispatch(job(2, 3, log));
    await flush();
    expect(wasm.allJobs().map((j) => j.jobId)).toEqual([1]);
    expect(log.complete).toEqual([2]);
    expect(backendStatus().reason).toMatch(/no cell index/);
    pool.dispose();
  });

  it('batches jobs dispatched in one task into one GPU load', async () => {
    const wasm = fakeWasmPools();
    const gpu = fakeGpuModule();
    const pool = createSolverPool(wasm.make, gpuDeps(gpu.mod));
    await flush(); // engine ready
    for (let c = 0; c < 5; c++) pool.dispatch(job(10 + c, c, log));
    await flush();
    expect(gpu.loads).toEqual([5]);
    pool.dispose();
  });

  it('auto gate routes on calibration; the default gate is advisory', async () => {
    const now = Date.now();
    const slowGpu = () => {
      calibrations.clear();
      calibrations.record({ backend: 'webgpu', sampleItersPerSec: 1, measuredAt: now });
      calibrations.record({ backend: 'wasm-pool', sampleItersPerSec: 10, measuredAt: now });
    };
    slowGpu();
    const wasm = fakeWasmPools();
    const pool = createSolverPool(wasm.make, gpuDeps(fakeGpuModule().mod, { gpuGate: 'auto' }));
    pool.dispatch(job(1, 0, log));
    await flush();
    expect(wasm.allJobs().map((j) => j.jobId)).toEqual([1]);
    expect(backendStatus().reason).toMatch(/GPU measured 0.10x the WASM pool/);
    pool.dispose();

    slowGpu();
    const wasm2 = fakeWasmPools();
    const pool2 = createSolverPool(wasm2.make, gpuDeps(fakeGpuModule().mod));
    pool2.dispatch(job(2, 0, log));
    await flush();
    expect(wasm2.allJobs()).toHaveLength(0);
    expect(log.complete).toContain(2);
    pool2.dispose();
    calibrations.clear();
  });
});
