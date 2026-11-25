/// <reference types="@webgpu/types" />
import { beforeAll, describe, expect, it } from 'vitest';
import { cholInvUpperBatch, GpuTileJob, WindowStats } from '../lib/cala-wasm.ts';
import {
  gramReport,
  GPU_MAX_STRIDE,
  GPU_RING_BLOCK,
  GPU_WINDOW_LADDER,
  GpuSketchTooLarge,
  RingClock,
  openGpuCompressor,
  ringFrameBytes,
  ringSegments,
  type WindowStatsLike,
} from '../lib/gpu-compress.ts';
import { initTestWasm } from './wasm-test.ts';

describe('RingClock', () => {
  it('holds a second window of slack: a full window fits behind the one compressing', () => {
    const r = new RingClock(600, 600);
    expect(r.size).toBe(1200);
    expect(r.slot(1199)).toBe(1199);
    expect(r.slot(1201)).toBe(1);
    // Window [0, 600) compressing: the whole next window [600, 1200) fits, one frame more does not.
    expect(r.fits(600, 600, 0)).toBe(true);
    expect(r.fits(600, 601, 0)).toBe(false);
    expect(r.fits(1199, 2, 0)).toBe(false);
    // Window [600, 1200) compressing: frames up to 1800 fit.
    expect(r.fits(1200, 600, 600)).toBe(true);
    expect(r.fits(1200, 601, 600)).toBe(false);
  });

  it('maps stream frames to slots and refuses to overwrite a window not yet compressed', () => {
    const r = new RingClock(600, 150);
    expect(r.size).toBe(750);
    expect(r.slot(0)).toBe(0);
    expect(r.slot(751)).toBe(1);
    // Window [0, 600) compressing; frames up to 750 fit, 751 would overwrite frame 1.
    expect(r.fits(600, 150, 0)).toBe(true);
    expect(r.fits(600, 151, 0)).toBe(false);
    // Once window 0 is done (keepFrom 600), frames up to 600 + 750 = 1350 fit.
    expect(r.fits(750, 450, 600)).toBe(true);
    expect(r.fits(750, 600, 600)).toBe(true);
    expect(r.fits(750, 601, 600)).toBe(false);
  });
});

describe('ringSegments', () => {
  const r = new RingClock(600, 150);
  const seg = (block: number, first: number, offset: number, count: number) => ({
    block,
    first,
    offset,
    count,
  });
  it('splits a window at block boundaries', () => {
    expect(ringSegments(r, GPU_RING_BLOCK, 0, 600)).toEqual([
      seg(0, 0, 0, 150),
      seg(1, 0, 150, 150),
      seg(2, 0, 300, 150),
      seg(3, 0, 450, 150),
    ]);
  });
  it('wraps a window that runs past the ring end', () => {
    expect(ringSegments(r, GPU_RING_BLOCK, 700, 600)).toEqual([
      seg(4, 100, 0, 50),
      seg(0, 0, 50, 150),
      seg(1, 0, 200, 150),
      seg(2, 0, 350, 150),
      seg(3, 0, 500, 100),
    ]);
    expect(ringSegments(r, GPU_RING_BLOCK, 760, 600)).toEqual([
      seg(0, 10, 0, 140),
      seg(1, 0, 140, 150),
      seg(2, 0, 290, 150),
      seg(3, 0, 440, 150),
      seg(4, 0, 590, 10),
    ]);
  });
  it('handles a ring whose last block is short', () => {
    const odd = new RingClock(10, 3); // 13 slots in blocks of 4: 4, 4, 4, 1
    expect(ringSegments(odd, 4, 11, 4)).toEqual([
      seg(2, 3, 0, 1),
      seg(3, 0, 1, 1),
      seg(0, 0, 2, 2),
    ]);
  });
});

describe('ringFrameBytes', () => {
  it('pads an odd frame to whole u32 words so every ring slot starts on a word', () => {
    expect(ringFrameBytes(33 * 33)).toBe(1090 * 2);
    expect(ringFrameBytes(600 * 600)).toBe(600 * 600 * 2);
    for (let slot = 0; slot < 5; slot++) expect((slot * ringFrameBytes(33 * 33)) % 4).toBe(0);
  });
});

describe('openGpuCompressor', () => {
  const layout = () => new Uint32Array([0, 0, 64, 64]);
  const base = { width: 64, height: 64, tile: 64, tiling: 'plain', quant: 64, layout };

  it('says why without WebGPU', async () => {
    const r = await openGpuCompressor({ ...base, gpu: undefined });
    expect(r).toEqual({ reason: 'This browser has no WebGPU.' });
  });

  it('opens with a ring of two windows when it fits', async () => {
    const tried: number[] = [];
    const r = await openGpuCompressor({
      ...base,
      gpu: fakeGpu((bytes) => {
        tried.push(bytes);
        return true;
      }).gpu,
    });
    if ('reason' in r) throw new Error(r.reason);
    expect(GPU_WINDOW_LADDER).toEqual([600]);
    expect(r.window).toBe(600);
    expect(r.slack).toBe(600);
    // The whole ring (window + slack frames) is one allocation attempt.
    expect(tried).toEqual([1200 * ringFrameBytes(64 * 64)]);
    r.destroy();
  });

  it('falls back to a ring of a window and a quarter when two windows do not fit', async () => {
    const tried: number[] = [];
    const fb = ringFrameBytes(64 * 64);
    const r = await openGpuCompressor({
      ...base,
      gpu: fakeGpu((bytes) => {
        tried.push(bytes);
        return bytes <= 750 * fb;
      }).gpu,
    });
    if ('reason' in r) throw new Error(r.reason);
    expect(r.window).toBe(600);
    expect(r.slack).toBe(150);
    expect(tried).toEqual([1200 * fb, 750 * fb]);
    r.destroy();
  });

  it('gives no compressor, and says why, when neither ring fits', async () => {
    const tried: number[] = [];
    const r = await openGpuCompressor({
      ...base,
      gpu: fakeGpu((bytes) => {
        tried.push(bytes);
        return false;
      }).gpu,
    });
    expect(r).toEqual({ reason: expect.stringContaining('GPU memory') });
    const fb = ringFrameBytes(64 * 64);
    expect(tried).toEqual([1200 * fb, 750 * fb]);
  });

  it('uploads each frame into its block and slot, padded to whole words', async () => {
    const fake = fakeGpu(() => true);
    const r = await openGpuCompressor({
      ...base,
      width: 33,
      height: 33,
      layout: () => new Uint32Array([0, 0, 33, 33]),
      gpu: fake.gpu,
    });
    if ('reason' in r) throw new Error(r.reason);
    expect(fake.rings).toHaveLength(8);
    const hw = 33 * 33;
    const frames = new Int16Array(3 * hw).map((_, i) => i % 1000);
    fake.writes.length = 0;
    // Stream frames 1199, 1200, 1201: the ring's last slot, then slots 0 and 1.
    r.upload(frames, 1199, 3);
    const fb = ringFrameBytes(hw);
    expect(fake.writes.map((w) => [fake.rings.indexOf(w.buffer), w.offset, w.bytes])).toEqual([
      [7, 149 * fb, fb],
      [0, 0, fb],
      [0, fb, fb],
    ]);
    expect(Array.from(fake.writes[1].data.slice(0, hw))).toEqual(
      Array.from(frames.slice(hw, 2 * hw)),
    );
    r.destroy();
  });

  it('gives up a window whose sketch outgrows the GPU buffers', async () => {
    const big = {
      l: () => GPU_MAX_STRIDE + 1,
      nIter: () => 2,
      omega: () => new Float32Array(0),
      finish: () => undefined,
      rank: () => 0,
      free: () => {},
    };
    const fake = fakeGpu(() => true);
    const r = await openGpuCompressor({ ...base, gpu: fake.gpu, jobs: () => big });
    if ('reason' in r) throw new Error(r.reason);
    const stats: WindowStatsLike = {
      push: () => {},
      frames: () => 0,
      reset: () => {},
      mean: () => new Float32Array(64 * 64),
      free: () => {},
    };
    fake.dispatches.length = 0;
    await expect(
      r.compress({
        index: 0,
        start: 0,
        frames: 10,
        stats,
        seeds: () => 0,
        prevRanks: () => undefined,
      }),
    ).rejects.toBeInstanceOf(GpuSketchTooLarge);
    expect(fake.dispatches).toHaveLength(0);
    r.destroy();
  });
});

interface FakeWrite {
  buffer: object;
  offset: number;
  bytes: number;
  data: Int16Array;
}

/**
 * A fake `GPU` whose device reports out-of-memory for the ring (the buffers
 * labelled 'ring' made inside one error scope, summed) unless `ok(bytes)`;
 * other buffers always allocate; pipelines and queues are no-ops that record
 * ring writes and dispatches.
 */
function fakeGpu(ok: (ringBytes: number) => boolean): {
  gpu: GPU;
  rings: object[];
  writes: FakeWrite[];
  dispatches: number[][];
} {
  let ringBytes = 0;
  const rings: object[] = [];
  const writes: FakeWrite[] = [];
  const dispatches: number[][] = [];
  const buffer = (size: number) => ({
    size,
    destroy: () => {},
    mapAsync: async () => {},
    getMappedRange: () => new ArrayBuffer(size),
    unmap: () => {},
  });
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    dispatchWorkgroups(...xyz: number[]) {
      dispatches.push(xyz);
    },
    end() {},
  };
  const device = {
    limits: {},
    lost: new Promise(() => {}),
    queue: {
      writeBuffer(b: object, offset: number, data: ArrayBufferView, start = 0, count?: number) {
        if (!rings.includes(b)) return;
        const all = data as Int16Array;
        const view = all.subarray(start, count === undefined ? undefined : start + count);
        writes.push({ buffer: b, offset, bytes: view.byteLength, data: view.slice() });
      },
      submit() {},
      onSubmittedWorkDone: async () => {},
    },
    pushErrorScope() {},
    popErrorScope: async () => {
      const bytes = ringBytes;
      ringBytes = 0;
      return bytes > 0 && !ok(bytes) ? ({ message: 'out of memory' } as GPUError) : null;
    },
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = buffer(d.size);
      if (d.label === 'ring') {
        ringBytes += d.size;
        rings.push(b);
      }
      return b;
    },
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    destroy() {},
  };
  const adapter = {
    limits: { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 32 },
    info: {},
    requestDevice: async () => device,
  };
  return {
    gpu: { requestAdapter: async () => adapter } as unknown as GPU,
    rings,
    writes,
    dispatches,
  };
}

describe('CholeskyQR of a batch', () => {
  beforeAll(initTestWasm);

  it("gives a zero R⁻¹ for a tile without variance (V4's dark corners) and names a refused one", () => {
    const stride = 4;
    // Slot 0: the identity on its first 2 columns; slot 1: all zero (l 3).
    const g = new Float32Array(2 * stride * stride);
    g[0] = 1;
    g[stride + 1] = 1;
    const r = cholInvUpperBatch(g, stride, Uint32Array.from([2, 3]));
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[stride + 1]).toBeCloseTo(1, 6);
    expect(r.subarray(stride * stride).every((v) => v === 0)).toBe(true);
    // Not finite: refused, and the report names the tile.
    const bad = g.slice();
    bad[stride * stride] = NaN;
    expect(() => cholInvUpperBatch(bad, stride, Uint32Array.from([2, 3]))).toThrow(
      /block 1 is not positive definite/,
    );
    expect(gramReport(bad, stride, [2, 3], [7, 9], 4096)).toBe(
      'tile 9 (l 3, 4096 rows): trace 0, 1 not finite',
    );
    expect(gramReport(g, stride, [2, 3], [7, 9], 4096)).toContain('tile 9');
  });
});

describe('the GPU work buffers', () => {
  beforeAll(initTestWasm);

  it('hold the largest sketch a tile can grow to (a 64 x 64 tile, a window of 600, rank 300 before)', () => {
    const stats = new WindowStats(64, 64);
    stats.push(new Int16Array(600 * 64 * 64));
    // A previous rank at the cap starts the sketch at the cap: `max_rank` + oversamples.
    const job = new GpuTileJob(stats, 64, 0, 0, 64, 64, 1, 300);
    expect(job.l()).toBe(310);
    expect(Math.ceil(job.l() / 64) * 64).toBeLessThanOrEqual(GPU_MAX_STRIDE);
    job.free();
    stats.free();
  });
});
