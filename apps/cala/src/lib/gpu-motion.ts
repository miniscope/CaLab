/// <reference types="@webgpu/types" />
/**
 * WebGPU half of the motion corrector (rigid registration only).
 *
 * The CPU (WASM) corrector spends most of its time in two places that are
 * pure image filtering: the registration prefilter (3x3 median, then a
 * difference of Gaussians) and the full-frame bicubic warp. Both run here.
 * What stays in WASM is everything stateful and small: the FFT correlation
 * against the template, the sub-pixel peak, the anomaly screen and the
 * template / drift bookkeeping (`MotionCorrector.estimateF32Prefiltered`).
 *
 * Per batch: upload the frames, prefilter on the GPU, read the band-passed
 * extended regions back (the only large readback before the shifts exist),
 * let WASM estimate the shifts, then warp the still-resident frames with the
 * shifts and read the corrected frames back for the trace stage. The warp
 * readback overlaps the next batch's prefilter (two slots).
 *
 * The shaders reproduce the Rust filters step for step (median of 9 with
 * replicated borders, exact Gaussian taps, three running-sum box blurs, the
 * separable Catmull-Rom warp), so differences are float round-off only.
 */

const WG = 8;
/** Largest small-sigma kernel (taps) the shader supports. */
const MAX_TAPS = 33;
const SLOTS = 2;

/** Parsed `MotionCorrector.prefilterParams()`. */
export interface PrefilterGeometry {
  extY0: number;
  extX0: number;
  extH: number;
  extW: number;
  median: boolean;
  sigmaLarge: number;
  kernel: Float32Array;
  boxes: [number, number, number];
}

export function parsePrefilterParams(p: Float32Array): PrefilterGeometry | null {
  if (p.length < 12) return null;
  const k = p[11];
  if (p.length !== 12 + k + 3) return null;
  return {
    extY0: p[0],
    extX0: p[1],
    extH: p[2],
    extW: p[3],
    median: p[8] !== 0,
    sigmaLarge: p[10],
    kernel: p.slice(12, 12 + k),
    boxes: [p[12 + k], p[13 + k], p[14 + k]],
  };
}

/** Catmull-Rom weights, as in `warp.rs` (f32 arithmetic). */
export function cubicWeights(t: number): [number, number, number, number] {
  const f = Math.fround;
  const t2 = f(t * t);
  const t3 = f(t2 * t);
  return [
    f(f(f(-0.5 * t3) + t2) - f(0.5 * t)),
    f(f(f(1.5 * t3) - f(2.5 * t2)) + 1),
    f(f(f(-1.5 * t3) + f(2 * t2)) + f(0.5 * t)),
    f(f(0.5 * t3) - f(0.5 * t2)),
  ];
}

const COMMON = /* wgsl */ `
struct P {
  w: u32, h: u32, ey0: u32, ex0: u32,
  fw: u32, r: u32, flag: u32, pad: u32,
};
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> aux: array<f32>;
@group(0) @binding(3) var<storage, read> kern: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
`;

const SHADER = /* wgsl */ `${COMMON}
fn clampi(v: i32, lo: i32, hi: i32) -> i32 { return max(lo, min(hi, v)); }

fn med3(a: f32, b: f32, c: f32) -> f32 { return max(min(a, b), min(max(a, b), c)); }

// Extended region (w x h) of a full frame (fw wide, h_full rows), median 3x3
// with replicated borders of the region (or a plain copy).
@compute @workgroup_size(${WG}, ${WG}, 1)
fn median(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let base = g.z * p.pad;
  let W = i32(p.w); let H = i32(p.h);
  var v: array<f32, 9>;
  if (p.flag == 0u) {
    let sy = p.ey0 + g.y; let sx = p.ex0 + g.x;
    dst[g.z * p.w * p.h + g.y * p.w + g.x] = src[base + sy * p.fw + sx];
    return;
  }
  var k = 0;
  for (var dy = -1; dy <= 1; dy++) {
    let yy = clampi(i32(g.y) + dy, 0, H - 1);
    for (var dx = -1; dx <= 1; dx++) {
      let xx = clampi(i32(g.x) + dx, 0, W - 1);
      v[k] = src[base + (p.ey0 + u32(yy)) * p.fw + p.ex0 + u32(xx)];
      k++;
    }
  }
  // median of 9 via sorted columns / rows / diagonals (exact)
  let a = vec3<f32>(v[0], v[1], v[2]);
  let b = vec3<f32>(v[3], v[4], v[5]);
  let c = vec3<f32>(v[6], v[7], v[8]);
  let lo = max(max(min(a.x, min(b.x, c.x)), min(a.y, min(b.y, c.y))), min(a.z, min(b.z, c.z)));
  let hi = min(min(max(a.x, max(b.x, c.x)), max(a.y, max(b.y, c.y))), max(a.z, max(b.z, c.z)));
  let m0 = med3(a.x, b.x, c.x);
  let m1 = med3(a.y, b.y, c.y);
  let m2 = med3(a.z, b.z, c.z);
  let mid = med3(m0, m1, m2);
  dst[g.z * p.w * p.h + g.y * p.w + g.x] = med3(lo, mid, hi);
}

@compute @workgroup_size(${WG}, ${WG}, 1)
fn conv_rows(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let o = g.z * p.w * p.h + g.y * p.w;
  let W = i32(p.w);
  let r = i32(p.r);
  var acc = 0.0;
  for (var t = 0; t <= 2 * r; t++) {
    acc += src[o + u32(clampi(i32(g.x) + t - r, 0, W - 1))] * kern[t];
  }
  dst[o + g.x] = acc;
}

@compute @workgroup_size(${WG}, ${WG}, 1)
fn conv_cols(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let o = g.z * p.w * p.h;
  let H = i32(p.h);
  let r = i32(p.r);
  var acc = 0.0;
  for (var t = 0; t <= 2 * r; t++) {
    acc += src[o + u32(clampi(i32(g.y) + t - r, 0, H - 1)) * p.w + g.x] * kern[t];
  }
  dst[o + g.y * p.w + g.x] = acc;
}

// Running-sum box blur, one thread per row (as box_rows in filter.rs).
@compute @workgroup_size(64, 1, 1)
fn box_rows(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.h) { return; }
  let o = g.z * p.w * p.h + g.x * p.w;
  let W = i32(p.w);
  let r = i32(p.r);
  let inv = 1.0 / f32(2 * r + 1);
  var acc = 0.0;
  for (var i = -r; i <= r; i++) { acc += src[o + u32(clampi(i, 0, W - 1))]; }
  for (var x = 0; x < W; x++) {
    dst[o + u32(x)] = acc * inv;
    acc += src[o + u32(clampi(x + r + 1, 0, W - 1))] - src[o + u32(clampi(x - r, 0, W - 1))];
  }
}

// Running-sum box blur, one thread per column. flag = 1: write aux - blur
// (the final large-sigma pass of the difference of Gaussians).
@compute @workgroup_size(64, 1, 1)
fn box_cols(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w) { return; }
  let o = g.z * p.w * p.h;
  let H = i32(p.h);
  let r = i32(p.r);
  let inv = 1.0 / f32(2 * r + 1);
  var acc = 0.0;
  for (var i = -r; i <= r; i++) { acc += src[o + u32(clampi(i, 0, H - 1)) * p.w + g.x]; }
  for (var y = 0; y < H; y++) {
    let v = acc * inv;
    let idx = o + u32(y) * p.w + g.x;
    if (p.flag == 1u) { dst[idx] = aux[idx] - v; } else { dst[idx] = v; }
    acc += src[o + u32(clampi(y + r + 1, 0, H - 1)) * p.w + g.x] - src[o + u32(clampi(y - r, 0, H - 1)) * p.w + g.x];
  }
}
`;

const WARP = /* wgsl */ `
struct WP { w: u32, h: u32, n: u32, pad: u32 };
// Per frame: by, bx (as f32 integers), pad, pad, wy[4], wx[4].
struct FP { by: f32, bx: f32, a: f32, b: f32, wy: vec4<f32>, wx: vec4<f32> };
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> fp: array<FP>;
@group(0) @binding(3) var<uniform> p: WP;

fn clampi(v: i32, lo: i32, hi: i32) -> i32 { return max(lo, min(hi, v)); }

@compute @workgroup_size(${WG}, ${WG}, 1)
fn vertical(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let f = fp[g.z];
  let o = g.z * p.w * p.h;
  let by = i32(f.by);
  var acc = 0.0;
  for (var a = 0; a < 4; a++) {
    let sy = clampi(i32(g.y) + by + a - 1, 0, i32(p.h) - 1);
    acc += f.wy[a] * src[o + u32(sy) * p.w + g.x];
  }
  dst[o + g.y * p.w + g.x] = acc;
}

@compute @workgroup_size(${WG}, ${WG}, 1)
fn horizontal(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let f = fp[g.z];
  let o = g.z * p.w * p.h + g.y * p.w;
  let bx = i32(f.bx);
  var acc = 0.0;
  for (var a = 0; a < 4; a++) {
    let sx = clampi(i32(g.x) + bx + a - 1, 0, i32(p.w) - 1);
    acc += f.wx[a] * src[o + u32(sx)];
  }
  dst[o + g.x] = acc;
}
`;

/** Ask for a GPU device; `null` when WebGPU or an adapter is missing. */
export async function requestMotionDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    return await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize,
          512 * 1024 * 1024,
        ),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
      },
    });
  } catch {
    return null;
  }
}

export interface Slot {
  frames: GPUBuffer;
  tmp: GPUBuffer;
  out: GPUBuffer;
  filt: GPUBuffer;
  fp: GPUBuffer;
  stageFilt: GPUBuffer;
  stageOut: GPUBuffer;
  /** Prefilter first / last pass and warp bind groups. */
  bgFirst: GPUBindGroup;
  bgLast: GPUBindGroup;
  bgV: GPUBindGroup;
  bgH: GPUBindGroup;
  /** Resolves when the slot's staging buffers are free again. */
  busy: Promise<void>;
}

interface Pass {
  pipeline: GPUComputePipeline;
  bg: GPUBindGroup | 'first' | 'last';
  /** Workgroup grid for one frame (z = count). */
  gx: number;
  gy: number;
  uniformOffset: number;
}

const f32Bytes = 4;

export class GpuMotion {
  private slots: Slot[] = [];
  private next = 0;
  private passes: Pass[] = [];
  private geo: PrefilterGeometry | null = null;
  private scratch: GPUBuffer[] = [];
  private kernBuf: GPUBuffer | null = null;
  private uni: GPUBuffer | null = null;
  private warpUni: GPUBuffer | null = null;
  private pipes: Record<string, GPUComputePipeline> = {};
  private warpPipes: Record<string, GPUComputePipeline> = {};
  private readonly px: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly width: number,
    private readonly height: number,
    private readonly batch: number,
  ) {
    this.px = width * height;
  }

  /** `null` when WebGPU is unavailable or the device cannot be created. */
  static async create(width: number, height: number, batch: number): Promise<GpuMotion | null> {
    const device = await requestMotionDevice();
    if (!device) return null;
    return new GpuMotion(device, width, height, batch);
  }

  get ready(): boolean {
    return this.geo !== null;
  }

  destroy(): void {
    for (const s of this.slots)
      for (const b of [s.frames, s.tmp, s.out, s.filt, s.fp, s.stageFilt, s.stageOut]) b.destroy();
    for (const b of this.scratch) b.destroy();
    this.kernBuf?.destroy();
    this.uni?.destroy();
    this.warpUni?.destroy();
    this.slots = [];
    this.scratch = [];
    this.geo = null;
  }

  /**
   * Build the pipelines and buffers for the prefilter of the corrector the
   * params came from. Returns false when the settings are outside what the
   * shaders support (the caller then stays on the CPU path).
   */
  setup(params: Float32Array): boolean {
    const geo = parsePrefilterParams(params);
    if (!geo || geo.sigmaLarge <= 4 || geo.kernel.length > MAX_TAPS) return false;
    this.destroy();
    this.geo = geo;
    const d = this.device;
    const { extH, extW } = geo;
    const epx = extH * extW;
    const mod = d.createShaderModule({ code: SHADER });
    const wmod = d.createShaderModule({ code: WARP });
    const bgl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });
    for (const n of ['median', 'conv_rows', 'conv_cols', 'box_rows', 'box_cols'])
      this.pipes[n] = d.createComputePipeline({
        layout,
        compute: { module: mod, entryPoint: n },
      });
    for (const n of ['vertical', 'horizontal'])
      this.warpPipes[n] = d.createComputePipeline({
        layout: 'auto',
        compute: { module: wmod, entryPoint: n },
      });

    const buf = (size: number, usage: number) => d.createBuffer({ size, usage });
    const S = GPUBufferUsage.STORAGE;
    const fbytes = this.batch * epx * f32Bytes;
    // Scratch shared by all slots (the queue runs passes in order).
    this.scratch = [0, 1, 2, 3].map(() => buf(fbytes, S));
    const [A, B, C, D] = this.scratch;
    this.kernBuf = buf(256, S | GPUBufferUsage.COPY_DST);
    const kdata = new Float32Array(64);
    kdata.set(geo.kernel);
    d.queue.writeBuffer(this.kernBuf, 0, kdata);

    // One uniform block per pass, 256-byte aligned (dynamic offsets are not needed:
    // every pass gets its own bind group over its slice).
    const passDefs: { name: string; r: number; flag: number; w: number; h: number }[] = [];
    const r1 = (geo.kernel.length - 1) / 2;
    const boxes = geo.boxes.map((b) => Math.floor(b / 2));
    const first = geo.median ? 1 : 0;
    passDefs.push({ name: 'median', r: 0, flag: first, w: extW, h: extH });
    passDefs.push({ name: 'conv_rows', r: r1, flag: 0, w: extW, h: extH });
    passDefs.push({ name: 'conv_cols', r: r1, flag: 0, w: extW, h: extH });
    for (let i = 0; i < 3; i++) {
      passDefs.push({ name: 'box_rows', r: boxes[i], flag: 0, w: extW, h: extH });
      passDefs.push({ name: 'box_cols', r: boxes[i], flag: i === 2 ? 1 : 0, w: extW, h: extH });
    }
    const UB = 256;
    this.uni = buf(UB * passDefs.length, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // Slot-specific frame stride goes into the median pass's `pad`.
    passDefs.forEach((pd, i) => {
      const u = new Uint32Array(8);
      u.set([pd.w, pd.h, geo.extY0, geo.extX0, this.width, pd.r, pd.flag, i === 0 ? this.px : 0]);
      d.queue.writeBuffer(this.uni!, i * UB, u);
    });

    const bind = (
      pipe: GPUComputePipeline,
      s: GPUBuffer,
      t: GPUBuffer,
      aux: GPUBuffer,
      i: number,
    ): GPUBindGroup =>
      d.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: s } },
          { binding: 1, resource: { buffer: t } },
          { binding: 2, resource: { buffer: aux } },
          { binding: 3, resource: { buffer: this.kernBuf! } },
          { binding: 4, resource: { buffer: this.uni!, offset: i * UB, size: 32 } },
        ],
      });

    // buffer routing:
    // median: frames -> A; conv_rows A -> B; conv_cols B -> C;
    // box1 rows A -> B, cols B -> D; box2 rows D -> B, cols B -> D;
    // box3 rows D -> B, cols B -> filt (aux = C): filt = C - blur.
    const route: [GPUBuffer | 'frames', GPUBuffer | 'filt'][] = [
      ['frames', A],
      [A, B],
      [B, C],
      [A, B],
      [B, D],
      [D, B],
      [B, D],
      [D, B],
      [B, 'filt' as unknown as GPUBuffer],
    ];

    this.warpUni = buf(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    d.queue.writeBuffer(this.warpUni, 0, new Uint32Array([this.width, this.height, 0, 0]));

    this.slots = [];
    for (let k = 0; k < SLOTS; k++) {
      const frames = buf(this.batch * this.px * f32Bytes, S | GPUBufferUsage.COPY_DST);
      const tmp = buf(this.batch * this.px * f32Bytes, S);
      const out = buf(this.batch * this.px * f32Bytes, S | GPUBufferUsage.COPY_SRC);
      const filt = buf(fbytes, S | GPUBufferUsage.COPY_SRC);
      const fp = buf(this.batch * 16 * f32Bytes, S | GPUBufferUsage.COPY_DST);
      const stageFilt = buf(fbytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const stageOut = buf(
        this.batch * this.px * f32Bytes,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );
      const bgFirst = bind(this.pipes.median, frames, A, this.kernBuf!, 0);
      const bgLast = bind(this.pipes.box_cols, B, filt, C, passDefs.length - 1);
      const wb = (pipe: GPUComputePipeline, s: GPUBuffer, t: GPUBuffer) =>
        d.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: s } },
            { binding: 1, resource: { buffer: t } },
            { binding: 2, resource: { buffer: fp } },
            { binding: 3, resource: { buffer: this.warpUni! } },
          ],
        });
      this.slots.push({
        frames,
        tmp,
        out,
        filt,
        fp,
        stageFilt,
        stageOut,
        bgFirst,
        bgLast,
        bgV: wb(this.warpPipes.vertical, frames, tmp),
        bgH: wb(this.warpPipes.horizontal, tmp, out),
        busy: Promise.resolve(),
      });
    }
    // Middle passes (shared by every slot).
    this.passes = passDefs.map((pd, i) => {
      const pipe = this.pipes[pd.name];
      const [s, t] = route[i];
      const gridX =
        pd.name === 'box_rows'
          ? Math.ceil(pd.h / 64)
          : pd.name === 'box_cols'
            ? Math.ceil(pd.w / 64)
            : Math.ceil(pd.w / WG);
      const gridY = pd.name.startsWith('box') ? 1 : Math.ceil(pd.h / WG);
      const bg: Pass['bg'] =
        i === 0
          ? 'first'
          : i === passDefs.length - 1
            ? 'last'
            : bind(pipe, s as GPUBuffer, t as GPUBuffer, this.kernBuf!, i);
      return { pipeline: pipe, bg, gx: gridX, gy: gridY, uniformOffset: i * UB };
    });
    this.next = 0;
    return true;
  }

  private async takeSlot(): Promise<Slot> {
    const slot = this.slots[this.next];
    this.next = (this.next + 1) % this.slots.length;
    await slot.busy;
    return slot;
  }

  /**
   * Upload `count` frames and run the prefilter. Resolves with the slot (for
   * `warp`) and the filtered extended regions, back to back, in `out`.
   */
  async prefilter(frames: Float32Array, count: number, out: Float32Array): Promise<{ slot: Slot }> {
    const geo = this.geo!;
    const slot = await this.takeSlot();
    const d = this.device;
    d.queue.writeBuffer(
      slot.frames,
      0,
      frames.buffer as ArrayBuffer,
      frames.byteOffset,
      count * this.px * f32Bytes,
    );
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (const p of this.passes) {
      pass.setPipeline(p.pipeline);
      pass.setBindGroup(0, p.bg === 'first' ? slot.bgFirst : p.bg === 'last' ? slot.bgLast : p.bg);
      pass.dispatchWorkgroups(p.gx, p.gy, count);
    }
    pass.end();
    const bytes = count * geo.extH * geo.extW * f32Bytes;
    enc.copyBufferToBuffer(slot.filt, 0, slot.stageFilt, 0, bytes);
    d.queue.submit([enc.finish()]);
    await slot.stageFilt.mapAsync(GPUMapMode.READ, 0, bytes);
    out.set(new Float32Array(slot.stageFilt.getMappedRange(0, bytes)));
    slot.stageFilt.unmap();
    return { slot };
  }

  /**
   * Warp the frames still resident in `slot` by the rigid shifts and read the
   * corrected frames into `out`. The slot is busy until the readback is done.
   */
  warp(
    slot: Slot,
    dy: Float32Array,
    dx: Float32Array,
    count: number,
    out: Float32Array,
  ): Promise<void> {
    const d = this.device;
    const fpData = new Float32Array(count * 12);
    for (let i = 0; i < count; i++) {
      const by = Math.floor(Math.fround(-dy[i]));
      const bx = Math.floor(Math.fround(-dx[i]));
      const wy = cubicWeights(Math.fround(Math.fround(-dy[i]) - by));
      const wx = cubicWeights(Math.fround(Math.fround(-dx[i]) - bx));
      fpData.set([by, bx, 0, 0, ...wy, ...wx], i * 12);
    }
    d.queue.writeBuffer(slot.fp, 0, fpData);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.warpPipes.vertical);
    pass.setBindGroup(0, slot.bgV);
    pass.dispatchWorkgroups(Math.ceil(this.width / WG), Math.ceil(this.height / WG), count);
    pass.setPipeline(this.warpPipes.horizontal);
    pass.setBindGroup(0, slot.bgH);
    pass.dispatchWorkgroups(Math.ceil(this.width / WG), Math.ceil(this.height / WG), count);
    pass.end();
    const bytes = count * this.px * f32Bytes;
    enc.copyBufferToBuffer(slot.out, 0, slot.stageOut, 0, bytes);
    d.queue.submit([enc.finish()]);
    const done = (async () => {
      await slot.stageOut.mapAsync(GPUMapMode.READ, 0, bytes);
      out.set(new Float32Array(slot.stageOut.getMappedRange(0, bytes)));
      slot.stageOut.unmap();
    })();
    slot.busy = done.catch(() => {});
    return done;
  }
}

export type GpuSlot = Awaited<ReturnType<GpuMotion['prefilter']>>['slot'];
