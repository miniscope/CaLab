/// <reference types="@webgpu/types" />
import { beforeAll, describe, expect, it } from 'vitest';
import { cholInvUpperBatch, GpuTileJob, WindowStats } from '../lib/cala-wasm.ts';
import {
  GPU_MAX_STRIDE,
  GPU_RING_BLOCK,
  GPU_WINDOW_LADDER,
  GPU_WORK_BYTES,
  GpuSketchTooLarge,
  RingClock,
  openGpuCompressor,
  ringFrameBytes,
  ringBlockFrames,
  ringSegments,
  takeBatch,
  workColumns,
  workLadder,
  type GpuTileJobLike,
  type WindowStatsLike,
} from '../lib/gpu-compress.ts';
import { TILE_ROWS } from '../lib/gpu-compress-kernels.ts';
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
    // Every work budget with two windows of ring, then the smaller ring at the full budget.
    const tries = workLadder(workColumns({})).length;
    expect(tries).toBe(6);
    expect(tried).toEqual([...Array<number>(tries).fill(1200 * fb), 750 * fb]);
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
    const tries = workLadder(workColumns({})).length;
    expect(tried).toEqual([
      ...Array<number>(tries).fill(1200 * fb),
      ...Array<number>(tries).fill(750 * fb),
    ]);
  });

  it('halves the work buffers before it shrinks the ring', async () => {
    const work: number[] = [];
    const full = 3 * GPU_WORK_BYTES; // Y, its copy, its readback
    const r = await openGpuCompressor({
      ...base,
      gpu: fakeGpu((_, w) => {
        work.push(w);
        return w < full;
      }).gpu,
    });
    if ('reason' in r) throw new Error(r.reason);
    expect(r.slack).toBe(600);
    expect(work).toEqual([full, full / 2]);
    r.destroy();
  });

  it('cuts a large frame into smaller ring blocks under the default 128 MB binding', async () => {
    const [w, h] = [1296, 972];
    const hw = w * h;
    const fb = ringFrameBytes(hw);
    const block = ringBlockFrames({}, hw);
    expect(block).toBe(Math.floor((128 * 2 ** 20) / fb)); // 53 frames, not 150
    const fake = fakeGpu(() => true);
    const r = await openGpuCompressor({ ...base, width: w, height: h, gpu: fake.gpu });
    if ('reason' in r) throw new Error(r.reason);
    expect(r.slack).toBe(600);
    expect(fake.rings).toHaveLength(Math.ceil(1200 / block));
    const sizes = fake.rings.map((b) => (b as { size: number }).size);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(128 * 2 ** 20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200 * fb);
    // Stream frames 1199 and 1200: the last block's last slot, then block 0 slot 0.
    fake.writes.length = 0;
    r.upload(new Int16Array(2 * hw), 1199, 2);
    const last = Math.floor(1199 / block);
    expect(fake.writes.map((x) => [fake.rings.indexOf(x.buffer), x.offset, x.bytes])).toEqual([
      [last, (1199 - last * block) * fb, fb],
      [0, 0, fb],
    ]);
    r.destroy();
  });

  it('names the limit when not even one frame fits a buffer', async () => {
    const r = await openGpuCompressor({
      ...base,
      width: 1000,
      height: 1000,
      gpu: fakeGpu(() => true, { maxStorageBufferBindingSize: 2 ** 20 }).gpu,
    });
    expect(r).toEqual({
      reason:
        "A frame of 1000 x 1000 pixels (2 MB) is over the GPU's maxStorageBufferBindingSize (1 MB).",
    });
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
function fakeGpu(
  ok: (ringBytes: number, workBytes: number) => boolean,
  limits: Partial<GPUSupportedLimits> = {},
): {
  gpu: GPU;
  rings: object[];
  writes: FakeWrite[];
  dispatches: number[][];
  submits: { n: number };
} {
  const submits = { n: 0 };
  let ringBytes = 0;
  let workBytes = 0;
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
    limits,
    lost: new Promise(() => {}),
    queue: {
      writeBuffer(b: object, offset: number, data: ArrayBufferView, start = 0, count?: number) {
        if (!rings.includes(b)) return;
        const all = data as Int16Array;
        const view = all.subarray(start, count === undefined ? undefined : start + count);
        writes.push({ buffer: b, offset, bytes: view.byteLength, data: view.slice() });
      },
      submit() {
        submits.n++;
      },
      onSubmittedWorkDone: async () => {},
    },
    pushErrorScope() {},
    popErrorScope: async () => {
      const bytes = ringBytes;
      const work = workBytes;
      ringBytes = 0;
      workBytes = 0;
      return bytes > 0 && !ok(bytes, work) ? ({ message: 'out of memory' } as GPUError) : null;
    },
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = buffer(d.size);
      if (d.label === 'work') workBytes += d.size;
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
    submits,
  };
}

describe('ring blocks and work budgets', () => {
  it('hold 150 frames where they fit, fewer for a large frame, none past the limit', () => {
    expect(ringBlockFrames({}, 600 * 600)).toBe(150);
    expect(ringBlockFrames({}, 1296 * 972)).toBe(53);
    // The lower of the two limits counts.
    expect(
      ringBlockFrames(
        { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 24 },
        1000 * 1000,
      ),
    ).toBe(8);
    expect(ringBlockFrames({ maxStorageBufferBindingSize: 2 ** 20 }, 1000 * 1000)).toBe(0);
  });

  it('halve the work budget in whole sketches down to one widest sketch', () => {
    expect(workLadder(8192)).toEqual([8192, 4096, 2048, 1024, 512, 320]);
    expect(workLadder(640)).toEqual([640, 320]);
    expect(workLadder(320)).toEqual([320]);
    expect(workLadder(256)).toEqual([]);
  });
});

describe('batches', () => {
  it('fill the work buffers of the default 128 MB binding, or of a device with less', () => {
    expect(workColumns({})).toBe(GPU_WORK_BYTES / (TILE_ROWS * 4));
    expect(workColumns({ maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 31 })).toBe(
      8192,
    );
    // A device below the default: whole sketches of 64 columns that fit it.
    expect(workColumns({ maxStorageBufferBindingSize: TILE_ROWS * 4 * 700 })).toBe(640);
  });

  it('take the smallest sketches first, as many as fit, every tile once', () => {
    const l = [300, 20, 20, 70, 20, 130, 20];
    const queue = l.map((_, i) => i);
    const got: number[][] = [];
    while (queue.length > 0) got.push(takeBatch(queue, (i) => l[i], 640, 1000));
    // Stride 64: 10 fit 640 columns; with a 70 (stride 128) 5 fit; 130 (192) 3; 300 (320) 2.
    expect(got).toEqual([
      [1, 2, 4, 6, 3],
      [5, 0],
    ]);
    expect(got.flat().sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // At most `maxSlots`, and never empty even when one tile alone overfills.
    const q2 = [0, 1, 2];
    expect(takeBatch(q2, () => 20, 640, 2)).toEqual([0, 1]);
    expect(takeBatch([0], () => 400, 64, 10)).toEqual([0]);
  });

  it('compress every tile once, in batches the device limits size, growth included', async () => {
    const n = 25;
    const layout = () => Uint32Array.from({ length: 4 * n }, (_, k) => (k % 4 < 2 ? 0 : 64));
    const finished: number[] = [];
    const jobs = (tile: number): GpuTileJobLike => {
      let l = 20;
      let grown = tile !== 3; // tile 3 grows once, to a sketch of 100 columns
      return {
        l: () => l,
        nIter: () => 2,
        omega: () => new Float32Array(10 * l),
        finish: () => {
          if (!grown) {
            grown = true;
            l = 100;
            return undefined;
          }
          finished.push(tile);
          return new Uint8Array([tile]);
        },
        rank: () => tile,
        free: () => {},
      };
    };
    let next = 0;
    const fake = fakeGpu(() => true, { maxStorageBufferBindingSize: TILE_ROWS * 4 * 640 });
    const r = await openGpuCompressor({
      width: 64,
      height: 64,
      tile: 64,
      tiling: 'plain',
      quant: 64,
      layout,
      gpu: fake.gpu,
      jobs: () => jobs(next++),
    });
    if ('reason' in r) throw new Error(r.reason);
    fake.submits.n = 0;
    const out = await r.compress({
      index: 0,
      start: 0,
      frames: 10,
      stats: {
        push: () => {},
        frames: () => 10,
        reset: () => {},
        mean: () => new Float32Array(64 * 64),
        free: () => {},
      },
      seeds: () => 0,
      prevRanks: () => undefined,
    });
    // 640 columns: 10 tiles per batch at stride 64 (3 batches), then tile 3 at stride 128.
    expect(fake.submits.n).toBe(4);
    expect(finished.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(out.tiles.map((t) => t[0])).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(out.ranks).toEqual(Array.from({ length: n }, (_, i) => i));
    r.destroy();
  });
});

describe('CholeskyQR of a batch', () => {
  beforeAll(initTestWasm);

  // The rule the GPU's `CHOL` kernel follows (`chol_inv_upper`, the WASM reference).
  it("gives a zero R⁻¹ for a tile without variance (V4's dark corners) and refuses a NaN", () => {
    const stride = 4;
    // Slot 0: the identity on its first 2 columns; slot 1: all zero (l 3).
    const g = new Float32Array(2 * stride * stride);
    g[0] = 1;
    g[stride + 1] = 1;
    const r = cholInvUpperBatch(g, stride, Uint32Array.from([2, 3]));
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[stride + 1]).toBeCloseTo(1, 6);
    expect(r.subarray(stride * stride).every((v) => v === 0)).toBe(true);
    // Not finite: refused.
    const bad = g.slice();
    bad[stride * stride] = NaN;
    expect(() => cholInvUpperBatch(bad, stride, Uint32Array.from([2, 3]))).toThrow(
      /block 1 is not positive definite/,
    );
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
