/// <reference types="@webgpu/types" />
/**
 * WebGPU window compressor: today's per-tile randomized SVD (`compress_tile`)
 * on a window of quantized frames held on the GPU, with WASM finishing each
 * tile (`GpuTileJob`).
 *
 * The frames live in a ring of `window + slack` slots (`gpuSlacks`: two
 * windows, or a window and a quarter where that does not allocate), stored as
 * blocks of up to `GPU_RING_BLOCK` frames, one buffer each, as many frames as
 * fit the device's binding and buffer limits (`ringBlockFrames`: fewer for
 * frames over ~668 x 668 px at WebGPU's default 128 MB). A window may start
 * at any slot and wrap around the ring, so each product with the window's
 * data is dispatched once per *segment*: a run of window frames that sit
 * contiguously in one block (`ringSegments`).
 *
 * Tiles are sketched in batches as large as the work buffers hold
 * (`workColumns`: WebGPU's default 128 MB per binding, or the device's lower
 * limit; halved down to one widest sketch where that does not allocate),
 * tiles of similar sketch size together (`takeBatch`). Per batch,
 * all on the GPU in one submission: `Y = A Ω`, CholeskyQR2 (Gram, `R⁻¹` by
 * the `CHOL` kernel, `Q = Y R⁻¹`), `n_iter` power iterations, `Bᵀ = Aᵀ Q`.
 * Then one readback of `Q`, `Bᵀ` and the per-tile Cholesky flags, and
 * `GpuTileJob.finish` does the rest in WASM (eigen step, lag-1 cut, growth,
 * bytes). A tile whose sketch grew goes back on the queue.
 */
import { GpuTileJob, type WindowStats } from './cala-wasm.ts';
import { APPLY, CHOL, GEMM, GRAM, TILE_ROWS } from './gpu-compress-kernels.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window lengths to try, longest first (shorter windows keep too little signal). */
export const GPU_WINDOW_LADDER: readonly number[] = [600];
/**
 * Bytes a work buffer (`Y`, its copy for CholeskyQR, its readback) may take:
 * WebGPU's default `maxStorageBufferBindingSize`, so every device holds it.
 */
export const GPU_WORK_BYTES = 128 * 2 ** 20;
/**
 * Sketch columns the work buffers hold: the largest sketch a tile can need
 * (`max_rank` 300 + 10 oversamples), rounded up to 64. At 128, real V4 tiles
 * grew past it and every window gave the run's factors up (24 Nov check).
 */
export const GPU_MAX_STRIDE = 320;
/** The most frames per ring buffer (150 x 600 x 600 x 2 bytes = 108 MB at 600 px). */
export const GPU_RING_BLOCK = 150;

/** WebGPU's default `maxStorageBufferBindingSize` and `maxBufferSize` (a device reports at least these). */
const DEFAULT_BINDING = 128 * 2 ** 20;
const DEFAULT_BUFFER = 256 * 2 ** 20;

/** The binding size a buffer may have on a device: the lower of its two limits, and which one that is. */
function bufferLimit(limits: { maxStorageBufferBindingSize?: number; maxBufferSize?: number }): {
  bytes: number;
  name: string;
} {
  const binding = limits.maxStorageBufferBindingSize ?? DEFAULT_BINDING;
  const buffer = limits.maxBufferSize ?? DEFAULT_BUFFER;
  return binding <= buffer
    ? { bytes: binding, name: 'maxStorageBufferBindingSize' }
    : { bytes: buffer, name: 'maxBufferSize' };
}

/**
 * Frames per ring block on a device: `GPU_RING_BLOCK`, or as many frames of
 * `hw` pixels as one buffer may hold; 0 when not even one frame fits.
 */
export function ringBlockFrames(
  limits: { maxStorageBufferBindingSize?: number; maxBufferSize?: number },
  hw: number,
): number {
  return Math.min(GPU_RING_BLOCK, Math.floor(bufferLimit(limits).bytes / ringFrameBytes(hw)));
}

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
// Batches
// ---------------------------------------------------------------------------

/** Sketch columns of a batch whose largest sketch has `l` columns. */
export const strideOf = (l: number): number => Math.ceil(l / 64) * 64;

/**
 * Slot columns the work buffers hold (`TILE_ROWS` rows each): the device's
 * storage-binding and buffer limits, at most `GPU_WORK_BYTES`, in whole
 * sketches of 64 columns.
 */
export function workColumns(limits: {
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
}): number {
  const bytes = Math.min(
    GPU_WORK_BYTES,
    limits.maxStorageBufferBindingSize ?? GPU_WORK_BYTES,
    limits.maxBufferSize ?? GPU_WORK_BYTES,
  );
  return Math.floor(bytes / (TILE_ROWS * 4 * 64)) * 64;
}

/**
 * Work budgets to try, largest first: `cols`, then halved (in whole sketches
 * of 64 columns) down to `GPU_MAX_STRIDE`, one tile's widest sketch.
 */
export function workLadder(cols: number): number[] {
  if (cols < GPU_MAX_STRIDE) return [];
  const out = [cols];
  for (let c = cols; c > GPU_MAX_STRIDE;) {
    c = Math.max(GPU_MAX_STRIDE, Math.floor(c / 2 / 64) * 64);
    out.push(c);
  }
  return out;
}

/**
 * Take the next batch from `queue` (tile indices; sorted in place by sketch
 * columns `l`, then index): the smallest sketches first, as many as fit
 * `cols` slot columns at the batch's stride, at most `maxSlots`. Never empty
 * for a non-empty queue: the first tile always goes (the caller checks its
 * stride against `GPU_MAX_STRIDE`).
 */
export function takeBatch(
  queue: number[],
  l: (tile: number) => number,
  cols: number,
  maxSlots: number,
): number[] {
  queue.sort((a, b) => l(a) - l(b) || a - b);
  let n = 1;
  while (n < queue.length && n < maxSlots && (n + 1) * strideOf(l(queue[n])) <= cols) n++;
  return queue.splice(0, n);
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
    // WebGPU's default limits: every buffer is sized to fit them (or the device's own, if lower).
    device = await adapter.requestDevice();
  } catch (e) {
    return { reason: `No WebGPU device: ${e instanceof Error ? e.message : String(e)}` };
  }
  device.pushErrorScope('validation');
  const pipe = (code: string): GPUComputePipeline =>
    device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
  const pipes = { gemm: pipe(GEMM), gram: pipe(GRAM), chol: pipe(CHOL), apply: pipe(APPLY) };
  const bad = await device.popErrorScope();
  if (bad) {
    device.destroy();
    return { reason: `The GPU compressor's kernels do not build: ${bad.message}` };
  }
  const hw = o.width * o.height;
  const block = ringBlockFrames(device.limits, hw);
  if (block < 1) {
    const lim = bufferLimit(device.limits);
    device.destroy();
    const mb = (b: number) => `${(b / 2 ** 20).toFixed(0)} MB`;
    return {
      reason: `A frame of ${o.width} x ${o.height} pixels (${mb(ringFrameBytes(hw))}) is over the GPU's ${lim.name} (${mb(lim.bytes)}).`,
    };
  }
  // The ring's slack first (it decides whether the GPU keeps up), then the
  // batch size: every work budget with two windows of ring, then with 1.25.
  for (const window of GPU_WINDOW_LADDER) {
    for (const slack of gpuSlacks(window)) {
      let bufs: Buffers | null = null;
      for (const cols of workLadder(workColumns(device.limits))) {
        bufs = await allocate(device, { window, slack, hw, block, cols });
        if (bufs) break;
      }
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
  /** Ring blocks of `block` frames (the last may be shorter). */
  ring: GPUBuffer[];
  /** Frames per ring block (`ringBlockFrames`). */
  block: number;
  mean: GPUBuffer;
  tiles: GPUBuffer;
  /** Per slot: sketch columns `l` (u32). */
  ls: GPUBuffer;
  /** Per slot: 1 when its Cholesky failed at every shift (u32). */
  flags: GPUBuffer;
  omega: GPUBuffer;
  y: GPUBuffer;
  ytmp: GPUBuffer;
  z: GPUBuffer;
  ztmp: GPUBuffer;
  g: GPUBuffer;
  /** The Cholesky factor (the `CHOL` kernel's scratch). */
  r: GPUBuffer;
  rinv: GPUBuffer;
  readQ: GPUBuffer;
  readB: GPUBuffer;
  readF: GPUBuffer;
  /** Slot columns of the work buffers (`workColumns`), and the most slots of a batch. */
  cols: number;
  maxSlots: number;
  all: GPUBuffer[];
}

/**
 * The ring (`window + slack` frames in blocks of `block`) and work buffers of
 * `cols` slot columns, or `null` when they do not fit the device.
 */
async function allocate(
  device: GPUDevice,
  o: { window: number; slack: number; hw: number; block: number; cols: number },
): Promise<Buffers | null> {
  const { window, hw, block, cols } = o;
  const size = window + o.slack;
  const blockBytes = (i: number) => Math.min(block, size - i * block) * ringFrameBytes(hw);
  const nBlocks = Math.ceil(size / block);
  const lim = device.limits;
  const maxSlots = Math.min(cols / 64, lim.maxComputeWorkgroupsPerDimension ?? 65535);
  // A batch of slots at stride `s` holds `slots * s <= cols` columns: `Y` is
  // TILE_ROWS rows of them, `Ω` / `Z` `window` rows, a Gram block `s` rows.
  const work = cols * TILE_ROWS * 4;
  const frameWork = cols * window * 4;
  const gram = cols * GPU_MAX_STRIDE * 4;
  const largest = Math.max(blockBytes(0), work, frameWork, gram, hw * 4);
  if (largest > bufferLimit(lim).bytes) return null;

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
      block,
      mean: mk(hw * 4, storage),
      tiles: mk(maxSlots * 16, storage),
      ls: mk(maxSlots * 4, storage),
      flags: mk(maxSlots * 4, storage),
      omega: mk(frameWork, storage),
      y: mk(work, storage, 'work'),
      ytmp: mk(work, storage, 'work'),
      z: mk(frameWork, storage),
      ztmp: mk(frameWork, storage),
      g: mk(gram, storage),
      r: mk(gram, storage),
      rinv: mk(gram, storage),
      readQ: mk(work, read, 'work'),
      readB: mk(frameWork, read),
      readF: mk(maxSlots * 4, read),
      cols,
      maxSlots,
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
  chol: GPUComputePipeline;
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
    for (const seg of ringSegments(this.clock, this.bufs.block, start, count)) {
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
      const segments = ringSegments(this.clock, this.bufs.block, job.start, t);
      const tiles: Uint8Array[] = new Array<Uint8Array>(n);
      const ranks = new Array<number>(n).fill(0);
      const queue = Array.from({ length: n }, (_, i) => i);
      const ls = jobs.map((j) => j!.l());
      while (queue.length > 0) {
        const batch = takeBatch(queue, (i) => ls[i], this.bufs.cols, this.bufs.maxSlots);
        const out = await this.sketch(
          batch.map((i) => jobs[i]!),
          batch,
          t,
          segments,
        );
        batch.forEach((i, slot) => {
          const bytes = out[slot];
          if (bytes === undefined) {
            ls[i] = jobs[i]!.l();
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
    const stride = strideOf(lMax);
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
    device.queue.writeBuffer(bufs.ls, 0, ls);
    device.queue.writeBuffer(bufs.flags, 0, new Uint32Array(n));
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
    const run = { n, t, stride, segments, temp };
    const qBytes = n * TILE_ROWS * stride * 4;
    const bBytes = n * t * stride * 4;
    const fBytes = n * 4;
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let mapped = false;
    try {
      // The whole sketch in one submission: no round trip until the readback.
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      this.gemm(pass, run, 0, bufs.omega, bufs.y);
      this.cholqr2(pass, run, bufs.y, bufs.ytmp, TILE_ROWS);
      for (let it = 0; it < nIter; it++) {
        this.gemm(pass, run, 1, bufs.y, bufs.z);
        this.cholqr2(pass, run, bufs.z, bufs.ztmp, t);
        this.gemm(pass, run, 0, bufs.z, bufs.y);
        this.cholqr2(pass, run, bufs.y, bufs.ytmp, TILE_ROWS);
      }
      this.gemm(pass, run, 1, bufs.y, bufs.z);
      pass.end();
      enc.copyBufferToBuffer(bufs.y, 0, bufs.readQ, 0, qBytes);
      enc.copyBufferToBuffer(bufs.z, 0, bufs.readB, 0, bBytes);
      enc.copyBufferToBuffer(bufs.flags, 0, bufs.readF, 0, fBytes);
      device.queue.submit([enc.finish()]);
      await Promise.all([
        bufs.readQ.mapAsync(MAP_MODE_READ, 0, qBytes),
        bufs.readB.mapAsync(MAP_MODE_READ, 0, bBytes),
        bufs.readF.mapAsync(MAP_MODE_READ, 0, fBytes),
      ]);
      mapped = true;
      const flags = new Uint32Array(bufs.readF.getMappedRange(0, fBytes));
      const failed = idx.filter((_, s) => flags[s] !== 0);
      if (failed.length > 0) {
        throw new Error(
          `the Cholesky of CholeskyQR failed at every shift for tile ${failed.join(', ')}`,
        );
      }
      // Finish straight from the mapped readback (WASM copies what it reads).
      const q = new Float32Array(bufs.readQ.getMappedRange(0, qBytes));
      const bt = new Float32Array(bufs.readB.getMappedRange(0, bBytes));
      return slots.map((j, s) => {
        const [, , w, h] = this.s.rects.subarray(4 * idx[s], 4 * idx[s] + 4);
        const q0 = s * TILE_ROWS * stride;
        return j.finish(
          q.subarray(q0, q0 + w * h * stride),
          bt.subarray(s * t * stride, (s + 1) * t * stride),
          stride,
        );
      });
    } finally {
      if (mapped) for (const b of [bufs.readQ, bufs.readB, bufs.readF]) b.unmap();
      const oom = await device.popErrorScope();
      const invalid = await device.popErrorScope();
      for (const b of temp) b.destroy();
      const err = oom ?? invalid;
      // Throwing here replaces an error already on its way out: the device's is the cause.
      // eslint-disable-next-line no-unsafe-finally
      if (err) throw new Error(`GPU compressor: ${err.message}`);
    }
  }

  /**
   * `C = A B` (`trans` 0) or `C = Aᵀ B` (`trans` 1) for every slot, one
   * dispatch per ring segment of the window.
   */
  private gemm(
    pass: GPUComputePassEncoder,
    run: Run,
    trans: 0 | 1,
    b: GPUBuffer,
    c: GPUBuffer,
  ): void {
    const { bufs, pipes } = this;
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
  }

  /**
   * CholeskyQR2 of `src` (`m x stride` per slot) in place, `tmp` in between:
   * twice the Gram, its `R⁻¹` (`CHOL`) and `Q = Y R⁻¹`, all on the GPU.
   */
  private cholqr2(
    pass: GPUComputePassEncoder,
    run: Run,
    src: GPUBuffer,
    tmp: GPUBuffer,
    m: number,
  ): void {
    const { bufs, pipes } = this;
    const { n, stride } = run;
    const u = this.uniform(run, new Uint32Array([m, stride, 0, 0]));
    const uc = this.uniform(run, new Uint32Array([stride, 0, 0, 0]));
    for (const [a, b] of [
      [src, tmp],
      [tmp, src],
    ]) {
      pass.setPipeline(pipes.gram);
      pass.setBindGroup(0, this.bind(pipes.gram, [a, bufs.g, u]));
      pass.dispatchWorkgroups(stride / 64, stride / 64, n);
      pass.setPipeline(pipes.chol);
      pass.setBindGroup(
        0,
        this.bind(pipes.chol, [bufs.g, bufs.ls, bufs.r, bufs.rinv, bufs.flags, uc]),
      );
      pass.dispatchWorkgroups(n);
      pass.setPipeline(pipes.apply);
      pass.setBindGroup(0, this.bind(pipes.apply, [a, bufs.rinv, b, u]));
      pass.dispatchWorkgroups(stride / 64, Math.ceil(m / 4), n);
    }
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
  segments: RingSegment[];
  /** Uniform buffers to destroy once the batch is read back. */
  temp: GPUBuffer[];
}
