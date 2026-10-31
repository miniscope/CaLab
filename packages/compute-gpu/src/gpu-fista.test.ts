/**
 * Engine control flow against a fake GPUDevice (no WebGPU in Node): error
 * scopes around allocation (OOM, validation after OOM), device loss,
 * readback staging release, streaming residency, per-trace limits. The
 * arithmetic is covered by the browser specs in gpu-tests/.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createGpuFista,
  estimateBytes,
  estimateGpuBytes,
  maxCellsPerGroup,
  maxTraceLength,
  type GpuFistaParams,
} from './index.ts';

const PARAMS: GpuFistaParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  fs: 30,
  lambda: 0.5,
  constraint: 'nonneg',
  tol: 1e-4,
  maxIters: 8,
  filtered: true,
};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  };
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUMapMode ??= { READ: 1, WRITE: 2 };
});

interface FakeBuffer {
  size: number;
  usage: number;
  invalid: boolean;
  destroyed: boolean;
  mapState: 'unmapped' | 'pending' | 'mapped';
  data: ArrayBuffer;
}

interface FakeOptions {
  /** createBuffer above this size reports out-of-memory. */
  oomAbove?: number;
  /** createBindGroup always reports a validation error. */
  validationOnBind?: boolean;
  /** Converged flag the fake shader writes into every Cell record (staging copies). */
  converged?: boolean;
}

function fakeDevice(opts: FakeOptions = {}) {
  const scopes: { filter: string; error: { message: string } | null }[] = [];
  const buffers: FakeBuffer[] = [];
  let lose!: (info: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((r) => (lose = r));
  let hangWork = false;
  let failNextMap = false;
  const report = (filter: string, message: string) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].filter === filter) {
        scopes[i].error ??= { message };
        return;
      }
    }
  };
  const device = {
    lost,
    limits: {
      maxStorageBufferBindingSize: 1 << 30,
      maxBufferSize: 1 << 30,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipelineAsync: async () => ({}),
    pushErrorScope: (filter: string) => scopes.push({ filter, error: null }),
    popErrorScope: async () => scopes.pop()!.error,
    createBuffer(d: { size: number; usage: number }) {
      const b: FakeBuffer = {
        size: d.size,
        usage: d.usage,
        invalid: false,
        destroyed: false,
        mapState: 'unmapped',
        data: new ArrayBuffer(d.size),
      };
      if (opts.oomAbove !== undefined && d.size > opts.oomAbove) {
        b.invalid = true;
        report('out-of-memory', `cannot allocate ${d.size} bytes`);
      }
      buffers.push(b);
      return {
        get size() {
          return b.size;
        },
        get mapState() {
          return b.mapState;
        },
        destroy: () => (b.destroyed = true),
        mapAsync: async () => {
          if (failNextMap) {
            failNextMap = false;
            throw new Error('map aborted');
          }
          b.mapState = 'mapped';
        },
        getMappedRange: (off: number, size: number) => {
          const view = b.data.slice(off, off + size);
          if (opts.converged) {
            const u = new Uint32Array(view);
            for (let i = 2; i < u.length; i += 8) u[i] = 1;
          }
          return view;
        },
        unmap: () => (b.mapState = 'unmapped'),
        __fake: b,
      };
    },
    createBindGroup(d: { entries: { resource: { buffer: { __fake: FakeBuffer } } }[] }) {
      if (opts.validationOnBind || d.entries.some((e) => e.resource.buffer.__fake.invalid)) {
        report('validation', 'invalid buffer in bind group');
      }
      return {};
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setBindGroup() {},
        setPipeline() {},
        dispatchWorkgroups() {},
        end() {},
      }),
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone: () =>
        hangWork ? new Promise<void>(() => undefined) : Promise.resolve(),
    },
  };
  return {
    device: device as unknown as GPUDevice,
    buffers,
    lose: (reason: string) => lose({ reason, message: 'gone' }),
    hang: () => (hangWork = true),
    failNextMap: () => (failNextMap = true),
  };
}

const traces = (n: number, T: number) => new Float32Array(n * T).fill(1);

describe('GPU FISTA engine (fake device)', () => {
  it('rejects a load whose allocation runs out of memory, also when validation errors follow', async () => {
    const T = 1024;
    // Every per-cell buffer of 4 cells (16 KiB) is above the limit; the bind group
    // that uses them then reports a validation error too.
    const f = fakeDevice({ oomAbove: 8 * 1024 });
    const gpu = await createGpuFista(f.device, { stagingBytes: 4096 });
    const err = await gpu.load(traces(4, T), 4, T, PARAMS).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('GpuOutOfMemoryError');
    // Everything created for the failed load is released.
    expect(f.buffers.filter((b) => !b.destroyed && b.size > 8 * 1024)).toHaveLength(0);
  });

  it('reports a validation error without an OOM as a plain error', async () => {
    const f = fakeDevice({ validationOnBind: true });
    const gpu = await createGpuFista(f.device);
    const err = await gpu.load(traces(2, 512), 2, 512, PARAMS).catch((e: Error) => e);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toMatch(/validation/);
  });

  it('rejects in-flight work on device loss and fails fast afterwards', async () => {
    const f = fakeDevice();
    const gpu = await createGpuFista(f.device);
    await gpu.load(traces(2, 512), 2, 512, { ...PARAMS, maxIters: 100 });
    f.hang();
    const pending = gpu.step(10);
    f.lose('unknown');
    const err = await pending.catch((e: Error) => e);
    expect((err as Error).name).toBe('GpuDeviceLostError');
    expect(gpu.lostError?.message).toMatch(/GPU device lost \(unknown\)/);
    const again = await gpu.step(1).catch((e: Error) => e);
    expect((again as Error).name).toBe('GpuDeviceLostError');
    await expect(gpu.readStatus()).rejects.toThrow(/device lost/);
  });

  it('releases the staging buffer when a map fails, and makes a new one next time', async () => {
    const f = fakeDevice();
    const gpu = await createGpuFista(f.device);
    await gpu.load(traces(2, 512), 2, 512, PARAMS);
    const staging = () => f.buffers.filter((b) => b.usage & GPUBufferUsage.MAP_READ);
    expect(staging()).toHaveLength(1);
    f.failNextMap();
    await expect(gpu.step(2)).rejects.toThrow(/map aborted/);
    expect(staging()[0].destroyed).toBe(true);
    const r = await gpu.step(2);
    expect(r.iterations).toHaveLength(2);
    expect(staging()).toHaveLength(2);
    expect(staging()[1].destroyed).toBe(false);
  });

  it('returns every cell’s status from step()', async () => {
    const f = fakeDevice({ converged: true });
    const gpu = await createGpuFista(f.device);
    await gpu.load(traces(3, 512), 3, 512, PARAMS);
    const r = await gpu.step(5);
    expect(Array.from(r.converged)).toEqual([1, 1, 1]);
    expect(r.allConverged).toBe(true);
    expect(r.allDone).toBe(true);
    expect(r.iterationsRun).toBe(5);
    const st = await gpu.readStatus();
    expect(Array.from(st.converged)).toEqual([1, 1, 1]);
  });

  it('streams groups under a total budget: at most two resident, each freed when done', async () => {
    const T = 512;
    const f = fakeDevice();
    const stagingBytes = 2 * T * 4;
    const gpu = await createGpuFista(f.device, {
      maxTotalBytes: estimateBytes(4, T, stagingBytes),
      stagingBytes,
    });
    const out = new Float32Array(10 * T);
    await gpu.load(traces(10, T), 10, T, PARAMS, undefined, { output: out });
    expect(gpu.groupCount).toBe(5); // groups of 2 so two fit in the 4-cell budget
    expect(gpu.residentGroups).toBe(2);
    let peak = gpu.residentGroups;
    let calls = 0;
    for (;;) {
      const r = await gpu.step(4);
      peak = Math.max(peak, gpu.residentGroups);
      calls++;
      if (r.allDone) break;
      expect(calls).toBeLessThan(50);
    }
    expect(peak).toBeLessThanOrEqual(2);
    const sol = await gpu.readSolutions();
    expect(sol.solutions).toBe(out);
    expect(Array.from(sol.iterations)).toEqual(new Array(10).fill(0)); // fake shader
    // Per-cell buffers ever created: 5 groups x 6; all but the last resident ones freed.
    const live = f.buffers.filter((b) => !b.destroyed && b.size === 2 * T * 4 && b.usage & 128);
    expect(live.length).toBeLessThanOrEqual(2 * 3);
  });

  it('refuses streaming when the caller requires a resident batch', async () => {
    const T = 512;
    const f = fakeDevice();
    const gpu = await createGpuFista(f.device, { maxTotalBytes: estimateBytes(2, T) });
    const err = await gpu
      .load(traces(8, T), 8, T, PARAMS, undefined, { requireResident: true })
      .catch((e: Error) => e);
    expect((err as Error).name).toBe('GpuOutOfMemoryError');
  });

  it('exposes per-trace limits and byte estimates', async () => {
    const f = fakeDevice();
    const gpu = await createGpuFista(f.device);
    // Blocks of 512 samples per workgroup: the dispatch dimension binds before 1 GiB.
    expect(maxTraceLength(f.device)).toBe(65535 * 512);
    expect(gpu.maxTraceLength).toBe(65535 * 512);
    expect(gpu.estimateBytes(4, 1000)).toBeGreaterThan(estimateGpuBytes(4, 1000));
    expect(maxCellsPerGroup(f.device, 65535 * 512 + 1)).toBe(0);
    expect(maxCellsPerGroup(f.device, 65535 * 512)).toBeGreaterThan(0);
  });
});
