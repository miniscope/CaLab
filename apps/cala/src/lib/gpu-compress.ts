/// <reference types="@webgpu/types" />
/**
 * WebGPU window compressor: today's per-tile randomized SVD (`compress_tile`)
 * on a window of quantized frames held on the GPU, with WASM finishing each
 * tile (`GpuTileJob`).
 *
 * The frames live in a ring of `window + slack` slots (`gpuSlacks`: two
 * windows, or a window and a quarter where that does not allocate), stored as blocks of
 * `GPU_RING_BLOCK` frames (one buffer each, so every binding stays under
 * WebGPU's default 128 MB storage-binding limit). A window may start at any
 * slot and wrap around the ring, so each product with the window's data is
 * dispatched once per *segment*: a run of window frames that sit
 * contiguously in one block (`ringSegments`).
 *
 * Per batch of up to `GPU_TILE_BATCH` tiles: `Y = A Ω`, CholeskyQR2 (Gram on
 * the GPU, `R⁻¹` in WASM), `n_iter` power iterations, `Bᵀ = Aᵀ Q`; `Q` and
 * `Bᵀ` are read back and `GpuTileJob.finish` does the rest (eigen step,
 * lag-1 cut, growth, bytes). A tile whose sketch grew goes back on the queue.
 */
import { cholInvUpperBatch, GpuTileJob, type WindowStats } from './cala-wasm.ts';
import { APPLY, GEMM, GRAM, TILE_ROWS } from './gpu-compress-kernels.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window lengths to try, longest first (shorter windows keep too little signal). */
export const GPU_WINDOW_LADDER: readonly number[] = [600];
/** Tiles sketched together (slots of the work buffers). */
export const GPU_TILE_BATCH = 12;
/**
 * Sketch columns the work buffers hold: the largest sketch a tile can need
 * (`max_rank` 300 + 10 oversamples), rounded up to 64. At 128, real V4 tiles
 * grew past it and every window gave the run's factors up (24 Nov check).
 */
export const GPU_MAX_STRIDE = 320;
/** Frames per ring buffer (150 x 600 x 600 x 2 bytes = 108 MB at 600 px). */
export const GPU_RING_BLOCK = 150;

/**
 * Ring slots beyond the window, most first: room to upload the next frames
 * while a window compresses. A full window of slack lets the GPU take a
 * whole window's reading time per window; a quarter window is the fallback
 * where a ring of two windows does not allocate (864 MB at 600 px).
 */
export const gpuSlacks = (window: number): number[] => [window, Math.ceil(window / 4)];

// `GPUBufferUsage` / `GPUMapMode` values (not defined outside a WebGPU browser).
const USAGE_MAP_READ = 0x1;
const USAGE_COPY_SRC = 0x4;
const USAGE_COPY_DST = 0x8;
const USAGE_UNIFORM = 0x40;
const USAGE_STORAGE = 0x80;
const MAP_MODE_READ = 0x1;

/** A typed array as `writeBuffer` takes it (its typings refuse `ArrayBufferLike`). */
const gpuData = <T extends ArrayBufferView>(a: T): T & ArrayBufferView<ArrayBuffer> =>
  a as T & ArrayBufferView<ArrayBuffer>;

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/** Which stream frames the ring holds and which it may overwrite. Pure. */
export class RingClock {
  readonly size: number;
  constructor(
    readonly window: number,
    readonly slack: number,
  ) {
    this.size = window + slack;
  }
  /** Ring slot of stream frame `f`. */
  slot(f: number): number {
    return f % this.size;
  }
  /** Frames `[start, start + count)` fit without overwriting a frame >= `keepFrom`. */
  fits(start: number, count: number, keepFrom: number): boolean {
    return start + count - keepFrom <= this.size;
  }
}

/** Bytes of a ring slot: a frame of `hw` i16 pixels padded to whole u32 words. */
export function ringFrameBytes(hw: number): number {
  return (hw + (hw & 1)) * 2;
}

/** A run of window frames held contiguously in one ring block. */
export interface RingSegment {
  /** Ring block. */
  block: number;
  /** Slot within the block of the run's first frame. */
  first: number;
  /** Frame of the window (or upload) the run starts at. */
  offset: number;
  /** Frames in the run. */
  count: number;
}

/**
 * Stream frames `[start, start + frames)` as runs within ring blocks of
 * `block` slots, in order; a run ends at a block's end or the ring's end.
 */
export function ringSegments(
  clock: RingClock,
  block: number,
  start: number,
  frames: number,
): RingSegment[] {
  if (frames > clock.size) throw new RangeError(`${frames} frames exceed a ring of ${clock.size}`);
  const out: RingSegment[] = [];
  for (let offset = 0; offset < frames;) {
    const s = clock.slot(start + offset);
    const b = Math.floor(s / block);
    const end = Math.min((b + 1) * block, clock.size);
    const count = Math.min(end - s, frames - offset);
    out.push({ block: b, first: s - b * block, offset, count });
    offset += count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** What the compressor needs of the WASM `WindowStats` (tests pass fakes). */
export interface WindowStatsLike {
  push(frames: Int16Array): void;
  frames(): number;
  reset(): void;
  mean(quant: number): Float32Array;
  free(): void;
}

/** What the compressor needs of the WASM `GpuTileJob` (tests pass fakes). */
export interface GpuTileJobLike {
  l(): number;
  nIter(): number;
  omega(): Float32Array;
  finish(q: Float32Array, bt: Float32Array, stride: number): Uint8Array | undefined;
  rank(): number;
  free(): void;
}

export interface GpuWindowJob {
  /** Factor file index. */
  index: number;
  /** Stream frame of the window's first frame. */
  start: number;
  frames: number;
  stats: WindowStatsLike;
  seeds: (tile: number) => number;
  prevRanks: (tile: number) => number | undefined;
}

export interface GpuWindowResult {
  tiles: Uint8Array[];
  ranks: number[];
  ms: number;
}

export interface GpuCompressorLike {
  readonly window: number;
  readonly slack: number;
  /** Upload quantized frames (frame layout) at stream frame `start`; the caller checks `RingClock.fits` first. */
  upload(frames: Int16Array, start: number, count: number): void;
  /** Compress one window whose frames are uploaded; rejects with `GpuSketchTooLarge` or a device error. */
  compress(job: GpuWindowJob): Promise<GpuWindowResult>;
  /** Resolves with a reason when the device is lost (not after `destroy`). */
  readonly lost: Promise<string>;
  destroy(): void;
}

/** A tile's sketch needs more columns than the work buffers hold. */
export class GpuSketchTooLarge extends Error {
  override name = 'GpuSketchTooLarge';
}

type JobFactory = (
  stats: WindowStatsLike,
  quant: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  seed: number,
  prevRank: number | undefined,
) => GpuTileJobLike;

const wasmJob: JobFactory = (stats, quant, x0, y0, w, h, seed, prevRank) =>
  new GpuTileJob(stats as unknown as WindowStats, quant, x0, y0, w, h, seed, prevRank);

// ---------------------------------------------------------------------------
// Opening: device, kernels, a window length whose buffers fit
// ---------------------------------------------------------------------------

/** Try the ladder; `{ reason }` when no window length fits or there is no WebGPU. */
export async function openGpuCompressor(o: {
  width: number;
  height: number;
  tile: number;
  tiling: string;
  quant: number;
  gpu?: GPU | undefined;
  layout: (w: number, h: number, tile: number, tiling: string) => Uint32Array;
  jobs?: JobFactory;
}): Promise<GpuCompressorLike | { reason: string }> {
  if (!o.gpu) return { reason: 'This browser has no WebGPU.' };
  const rects = o.layout(o.width, o.height, o.tile, o.tiling);
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const p = rects[i + 2] * rects[i + 3];
    if (p === 0 || p > TILE_ROWS) {
      return {
        reason: `A tile of ${rects[i + 2]} x ${rects[i + 3]} pixels does not fit the GPU compressor.`,
      };
    }
  }
  let device: GPUDevice;
  try {
    const adapter = await o.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { reason: 'No WebGPU adapter.' };
    device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
  } catch (e) {
    return { reason: `No WebGPU device: ${e instanceof Error ? e.message : String(e)}` };
  }
  device.pushErrorScope('validation');
  const pipe = (code: string): GPUComputePipeline =>
    device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
  const pipes = { gemm: pipe(GEMM), gram: pipe(GRAM), apply: pipe(APPLY) };
  const bad = await device.popErrorScope();
  if (bad) {
    device.destroy();
    return { reason: `The GPU compressor's kernels do not build: ${bad.message}` };
  }
  const hw = o.width * o.height;
  for (const window of GPU_WINDOW_LADDER) {
    for (const slack of gpuSlacks(window)) {
      const bufs = await allocate(device, window, slack, hw);
      if (!bufs) continue;
      return new GpuCompressor(device, pipes, bufs, {
        window,
        slack,
        width: o.width,
        hw,
        quant: o.quant,
        rects,
        jobs: o.jobs ?? wasmJob,
      });
    }
  }
  device.destroy();
  const last = GPU_WINDOW_LADDER[GPU_WINDOW_LADDER.length - 1];
  return { reason: `Not enough GPU memory for a window of ${last} frames.` };
}

interface Buffers {
  /** Ring blocks of `GPU_RING_BLOCK` frames (the last may be shorter). */
  ring: GPUBuffer[];
  mean: GPUBuffer;
  tiles: GPUBuffer;
  omega: GPUBuffer;
  y: GPUBuffer;
  ytmp: GPUBuffer;
  z: GPUBuffer;
  ztmp: GPUBuffer;
  g: GPUBuffer;
  rinv: GPUBuffer;
  readQ: GPUBuffer;
  readB: GPUBuffer;
  readG: GPUBuffer;
  all: GPUBuffer[];
}

/** The ring and work buffers for `window`, or `null` when they do not fit the device. */
async function allocate(
  device: GPUDevice,
  window: number,
  slack: number,
  hw: number,
): Promise<Buffers | null> {
  const size = window + slack;
  const blockBytes = (i: number) =>
    Math.min(GPU_RING_BLOCK, size - i * GPU_RING_BLOCK) * ringFrameBytes(hw);
  const nBlocks = Math.ceil(size / GPU_RING_BLOCK);
  const lim = device.limits;
  const batch = GPU_TILE_BATCH;
  const work = batch * TILE_ROWS * GPU_MAX_STRIDE * 4;
  const frameWork = batch * window * GPU_MAX_STRIDE * 4;
  const gram = batch * GPU_MAX_STRIDE * GPU_MAX_STRIDE * 4;
  const largest = Math.max(blockBytes(0), work, frameWork, gram, hw * 4);
  if (largest > (lim.maxStorageBufferBindingSize ?? Infinity)) return null;
  if (largest > (lim.maxBufferSize ?? Infinity)) return null;

  const all: GPUBuffer[] = [];
  const mk = (bytes: number, usage: number, label?: string): GPUBuffer => {
    const b = device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage, label });
    all.push(b);
    return b;
  };
  const storage = USAGE_STORAGE | USAGE_COPY_SRC | USAGE_COPY_DST;
  const read = USAGE_MAP_READ | USAGE_COPY_DST;
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  let bufs: Buffers | null;
  try {
    bufs = {
      ring: Array.from({ length: nBlocks }, (_, i) => mk(blockBytes(i), storage, 'ring')),
      mean: mk(hw * 4, storage),
      tiles: mk(batch * 16, storage),
      omega: mk(frameWork, storage),
      y: mk(work, storage),
      ytmp: mk(work, storage),
      z: mk(frameWork, storage),
      ztmp: mk(frameWork, storage),
      g: mk(gram, storage),
      rinv: mk(gram, storage),
      readQ: mk(work, read),
      readB: mk(frameWork, read),
      readG: mk(gram, read),
      all,
    };
  } catch {
    bufs = null; // e.g. a RangeError for a size the browser refuses outright
  }
  const oom = await device.popErrorScope();
  const invalid = await device.popErrorScope();
  if (!bufs || oom || invalid) {
    for (const b of all) b.destroy();
    return null;
  }
  return bufs;
}

// ---------------------------------------------------------------------------
// The compressor
// ---------------------------------------------------------------------------

interface Pipes {
  gemm: GPUComputePipeline;
  gram: GPUComputePipeline;
  apply: GPUComputePipeline;
}

interface Setup {
  window: number;
  slack: number;
  width: number;
  hw: number;
  quant: number;
  rects: Uint32Array;
  jobs: JobFactory;
}

class GpuCompressor implements GpuCompressorLike {
  readonly window: number;
  readonly slack: number;
  readonly lost: Promise<string>;
  private readonly clock: RingClock;
  private readonly hwp: number;
  private scratch: Int16Array | null = null;
  private busy = false;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipes: Pipes,
    private readonly bufs: Buffers,
    private readonly s: Setup,
  ) {
    this.window = s.window;
    this.slack = s.slack;
    this.clock = new RingClock(this.window, this.slack);
    this.hwp = s.hw + (s.hw & 1);
    this.lost = device.lost.then((info) =>
      this.destroyed ? new Promise<string>(() => {}) : info.message || 'The GPU device was lost.',
    );
  }

  upload(frames: Int16Array, start: number, count: number): void {
    const { hw } = this.s;
    if (frames.length < count * hw) {
      throw new RangeError(`${frames.length} values for ${count} frames of ${hw} pixels`);
    }
    const fb = ringFrameBytes(hw);
    const q = this.device.queue;
    for (const seg of ringSegments(this.clock, GPU_RING_BLOCK, start, count)) {
      const ring = this.bufs.ring[seg.block];
      if (hw === this.hwp) {
        q.writeBuffer(ring, seg.first * fb, gpuData(frames), seg.offset * hw, seg.count * hw);
        continue;
      }
      // Odd frames: pad each to whole words so every slot starts on a word.
      const pad = (this.scratch ??= new Int16Array(this.hwp));
      for (let f = 0; f < seg.count; f++) {
        const at = (seg.offset + f) * hw;
        pad.set(frames.subarray(at, at + hw));
        q.writeBuffer(ring, (seg.first + f) * fb, gpuData(pad), 0, this.hwp);
      }
    }
  }

  async compress(job: GpuWindowJob): Promise<GpuWindowResult> {
    if (this.busy) throw new Error('The GPU compressor is already compressing a window.');
    this.busy = true;
    const t0 = performance.now();
    const { rects, quant, hw } = this.s;
    const n = rects.length >> 2;
    const jobs: (GpuTileJobLike | null)[] = [];
    try {
      const t = job.frames;
      if (!(t >= 2 && t <= this.window)) {
        throw new RangeError(`a window of ${t} frames; 2 to ${this.window} fit the ring`);
      }
      const mean = job.stats.mean(quant);
      if (mean.length !== hw) throw new RangeError(`${mean.length} mean values for ${hw} pixels`);
      this.device.queue.writeBuffer(this.bufs.mean, 0, gpuData(mean));
      for (let i = 0; i < n; i++) {
        const [x0, y0, w, h] = rects.subarray(4 * i, 4 * i + 4);
        jobs.push(this.s.jobs(job.stats, quant, x0, y0, w, h, job.seeds(i), job.prevRanks(i)));
      }
      const segments = ringSegments(this.clock, GPU_RING_BLOCK, job.start, t);
      const tiles: Uint8Array[] = new Array<Uint8Array>(n);
      const ranks = new Array<number>(n).fill(0);
      const queue = Array.from({ length: n }, (_, i) => i);
      while (queue.length > 0) {
        const batch = queue.splice(0, GPU_TILE_BATCH);
        const out = await this.sketch(
          batch.map((i) => jobs[i]!),
          batch,
          t,
          segments,
        );
        batch.forEach((i, slot) => {
          const bytes = out[slot];
          if (bytes === undefined) {
            queue.push(i); // the sketch grew: sketch again with the new `l`
            return;
          }
          tiles[i] = bytes;
          ranks[i] = jobs[i]!.rank();
          jobs[i]!.free();
          jobs[i] = null;
        });
      }
      return { tiles, ranks, ms: performance.now() - t0 };
    } finally {
      for (const j of jobs) j?.free();
      this.busy = false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const b of this.bufs.all) b.destroy();
    this.device.destroy();
  }

  // ---- One batch: the sketch on the GPU, the finish in WASM ----

  /** Sketch the tiles `idx` (jobs `slots`) and finish each; `undefined` where a sketch grew. */
  private async sketch(
    slots: GpuTileJobLike[],
    idx: number[],
    t: number,
    segments: RingSegment[],
  ): Promise<(Uint8Array | undefined)[]> {
    const n = slots.length;
    const ls = Uint32Array.from(slots, (j) => j.l());
    const lMax = Math.max(...ls);
    const stride = Math.ceil(lMax / 64) * 64;
    if (stride > GPU_MAX_STRIDE) {
      throw new GpuSketchTooLarge(
        `A tile's sketch needs ${lMax} columns; the GPU buffers hold ${GPU_MAX_STRIDE}.`,
      );
    }
    const nIter = slots[0].nIter();
    if (slots.some((j) => j.nIter() !== nIter)) throw new Error('tiles disagree on nIter');
    const { bufs, device } = this;
    const rec = new Uint32Array(n * 4);
    idx.forEach((i, s) => rec.set(this.s.rects.subarray(4 * i, 4 * i + 4), 4 * s));
    device.queue.writeBuffer(bufs.tiles, 0, rec);
    const om = new Float32Array(n * t * stride);
    slots.forEach((j, s) => {
      const l = ls[s];
      const o = j.omega();
      if (o.length !== t * l)
        throw new RangeError(`omega of ${o.length} values, ${t} x ${l} expected`);
      for (let r = 0; r < t; r++) om.set(o.subarray(r * l, (r + 1) * l), (s * t + r) * stride);
    });
    device.queue.writeBuffer(bufs.omega, 0, om);

    const temp: GPUBuffer[] = [];
    const run = { n, t, stride, ls, idx, segments, temp };
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let q: Float32Array;
    let bt: Float32Array;
    try {
      this.gemm(run, 0, bufs.omega, bufs.y);
      await this.cholqr2(run, bufs.y, bufs.ytmp, TILE_ROWS);
      for (let it = 0; it < nIter; it++) {
        this.gemm(run, 1, bufs.y, bufs.z);
        await this.cholqr2(run, bufs.z, bufs.ztmp, t);
        this.gemm(run, 0, bufs.z, bufs.y);
        await this.cholqr2(run, bufs.y, bufs.ytmp, TILE_ROWS);
      }
      this.gemm(run, 1, bufs.y, bufs.z);
      [q, bt] = await Promise.all([
        this.read(bufs.y, bufs.readQ, n * TILE_ROWS * stride),
        this.read(bufs.z, bufs.readB, n * t * stride),
      ]);
    } finally {
      const oom = await device.popErrorScope();
      const invalid = await device.popErrorScope();
      for (const b of temp) b.destroy();
      const err = oom ?? invalid;
      // Throwing here replaces an error already on its way out: the device's is the cause.
      // eslint-disable-next-line no-unsafe-finally
      if (err) throw new Error(`GPU compressor: ${err.message}`);
    }
    return slots.map((j, s) => {
      const [, , w, h] = this.s.rects.subarray(4 * idx[s], 4 * idx[s] + 4);
      const q0 = s * TILE_ROWS * stride;
      return j.finish(
        q.subarray(q0, q0 + w * h * stride),
        bt.subarray(s * t * stride, (s + 1) * t * stride),
        stride,
      );
    });
  }

  /**
   * `C = A B` (`trans` 0) or `C = Aᵀ B` (`trans` 1) for every slot, one
   * dispatch per ring segment of the window.
   */
  private gemm(run: Run, trans: 0 | 1, b: GPUBuffer, c: GPUBuffer): void {
    const { device, bufs, pipes } = this;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipes.gemm);
    run.segments.forEach((seg, i) => {
      const m = trans === 0 ? TILE_ROWS : seg.count;
      const k = trans === 0 ? seg.count : TILE_ROWS;
      const add = trans === 0 && i > 0 ? 1 : 0;
      const words = new Uint32Array(12);
      words.set([
        m,
        k,
        trans,
        run.t,
        this.s.width,
        this.hwp,
        0,
        seg.first,
        seg.offset,
        add,
        run.stride,
      ]);
      new Float32Array(words.buffer)[6] = 1 / this.s.quant;
      const u = this.uniform(run, words);
      const ring = bufs.ring[seg.block];
      pass.setBindGroup(0, this.bind(pipes.gemm, [ring, bufs.tiles, bufs.mean, b, c, u]));
      pass.dispatchWorkgroups(Math.ceil(m / 64), run.stride / 64, run.n);
    });
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  /** CholeskyQR2 of `src` (`m x stride` per slot) in place, `tmp` in between. */
  private async cholqr2(run: Run, src: GPUBuffer, tmp: GPUBuffer, m: number): Promise<void> {
    const { device, bufs, pipes } = this;
    const { n, stride } = run;
    const u = this.uniform(run, new Uint32Array([m, stride, 0, 0]));
    const gBytes = n * stride * stride * 4;
    for (const [a, b] of [
      [src, tmp],
      [tmp, src],
    ]) {
      let enc = device.createCommandEncoder();
      let pass = enc.beginComputePass();
      pass.setPipeline(pipes.gram);
      pass.setBindGroup(0, this.bind(pipes.gram, [a, bufs.g, u]));
      pass.dispatchWorkgroups(stride / 64, stride / 64, n);
      pass.end();
      enc.copyBufferToBuffer(bufs.g, 0, bufs.readG, 0, gBytes);
      device.queue.submit([enc.finish()]);
      await bufs.readG.mapAsync(MAP_MODE_READ, 0, gBytes);
      const g = new Float32Array(bufs.readG.getMappedRange(0, gBytes).slice(0));
      bufs.readG.unmap();
      let rinv: Float32Array;
      try {
        rinv = cholInvUpperBatch(g, stride, run.ls);
      } catch (err) {
        throw new Error(`${errorMessage(err)}; ${gramReport(g, stride, run.ls, run.idx, m)}`, {
          cause: err,
        });
      }
      device.queue.writeBuffer(bufs.rinv, 0, gpuData(rinv));
      enc = device.createCommandEncoder();
      pass = enc.beginComputePass();
      pass.setPipeline(pipes.apply);
      pass.setBindGroup(0, this.bind(pipes.apply, [a, bufs.rinv, b, u]));
      pass.dispatchWorkgroups(stride / 64, Math.ceil(m / 4), n);
      pass.end();
      device.queue.submit([enc.finish()]);
    }
  }

  /** The first `floats` values of `src`, through the map-read buffer `via`. */
  private async read(src: GPUBuffer, via: GPUBuffer, floats: number): Promise<Float32Array> {
    const bytes = floats * 4;
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, via, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await via.mapAsync(MAP_MODE_READ, 0, bytes);
    const out = new Float32Array(via.getMappedRange(0, bytes).slice(0));
    via.unmap();
    return out;
  }

  private uniform(run: Run, words: Uint32Array): GPUBuffer {
    const b = this.device.createBuffer({
      size: words.byteLength,
      usage: USAGE_UNIFORM | USAGE_COPY_DST,
    });
    this.device.queue.writeBuffer(b, 0, gpuData(words));
    run.temp.push(b);
    return b;
  }

  private bind(p: GPUComputePipeline, buffers: GPUBuffer[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }
}

/** One batch's dispatch parameters. */
interface Run {
  n: number;
  t: number;
  stride: number;
  ls: Uint32Array;
  /** The layout's tile of each slot. */
  idx: number[];
  segments: RingSegment[];
  /** Uniform buffers to destroy once the batch is read back. */
  temp: GPUBuffer[];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Why CholeskyQR may have refused a batch: per slot whose Gram matrix is all
 * zero or not finite, its tile, sketch columns and trace (the matrix's rows `m`).
 */
export function gramReport(
  g: Float32Array,
  stride: number,
  ls: ArrayLike<number>,
  idx: number[],
  m: number,
): string {
  const bad: string[] = [];
  for (let s = 0; s < ls.length; s++) {
    const l = ls[s];
    let trace = 0;
    let nonFinite = 0;
    for (let i = 0; i < l; i++)
      for (let j = 0; j < l; j++) {
        const v = g[s * stride * stride + i * stride + j];
        if (!Number.isFinite(v)) nonFinite++;
        else if (i === j) trace += v;
      }
    if (nonFinite > 0 || !(trace > 0))
      bad.push(`tile ${idx[s]} (l ${l}, ${m} rows): trace ${trace}, ${nonFinite} not finite`);
  }
  return bad.length > 0 ? bad.join('; ') : 'every Gram matrix finite with a positive trace';
}
