/**
 * Batched banded-AR(2) FISTA on WebGPU: every cell of a recording is solved
 * at once, two dispatches per iteration (see shaders/fista-wgsl.ts).
 *
 * Cells are split into groups whose buffers fit the device's
 * maxStorageBufferBindingSize / maxBufferSize and `maxGroupBytes`. Groups are
 * the streaming unit: under a total byte budget (`maxTotalBytes`) only as many
 * groups are resident as fit; a group that is done (every cell converged, or
 * maxIters) is read back into the output array and freed, and the next one is
 * uploaded while the remaining resident groups keep solving. Without a budget
 * every group is resident, as before.
 *
 * Per-cell status comes back from every `step()` (one small readback per
 * call); solutions are read in chunks through one reused staging buffer
 * straight into the caller's array.
 */
import { GpuDeviceLostError, GpuOutOfMemoryError } from '@calab/compute';
import { computeBandedParams } from './banded-params.ts';
import { BLOCK, K, WG, buildScanTables } from './scan-reference.ts';
import { fistaShaderSource } from './shaders/fista-wgsl.ts';
import type { GpuFistaParams } from './types.ts';

const CELL_STRUCT_BYTES = 32;
/** u32 / f32 slots of one Cell record (struct Cell in the WGSL). */
const CELL_WORDS = CELL_STRUCT_BYTES / 4;
const C_T = 0;
const C_ITER = 1;
const C_CONV = 2;
const C_USEX = 3;
const C_BASELINE = 4;
const C_M = 5;
const C_ITER0 = 6;
/** useX values: 0 = momentum from x_{k-1}, 1 = y = x_k, 2 = y stored in the x_{k-1} slot. */
const USE_MOMENTUM = 0;
const USE_X = 1;
const USE_STORED_Y = 2;
const PARAMS_BYTES = 64;
/** f32 slots per (cell, block) record in the aux buffer (REC in the WGSL). */
const AUX_REC = 20;
const PER_CELL_WG = 64;
/** Default wall-clock target for one command buffer (see GpuFistaOptions). */
const DEFAULT_TARGET_SUBMIT_MS = 75;
/** Iterations in a group's first command buffer, before any timing exists. */
const FIRST_SUBMIT_ITERS = 4;
/** Upper bound on iterations per command buffer (tiny problems). */
const MAX_SUBMIT_ITERS = 1000;
/** Default size of the reused readback staging buffer. */
const DEFAULT_STAGING_BYTES = 64 * 1024 * 1024;
/** Largest single queue.writeBuffer call. */
const UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;

/** Feature-detect WebGPU and request a device with the adapter's buffer limits. */
export async function requestGpuDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    return await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
  } catch {
    return null;
  }
}

/** Bytes of GPU memory for the per-cell buffers of `nCells` cells (one group's working set). */
export function estimateGpuBytes(nCells: number, T: number): number {
  const nBlocks = Math.ceil(T / BLOCK);
  return nCells * (3 * T * 4 + AUX_REC * nBlocks * 4 + CELL_STRUCT_BYTES);
}

function tableBytes(): number {
  // (hop matrices + 6 block slots + 3 per-position slots) vec4<f32>; see buildScanTables.
  return (Math.round(Math.log2(WG)) + 6 + 3 * BLOCK) * 16;
}

function stagingBytesFor(nCells: number, T: number, cap: number): number {
  const row = T * 4;
  const want = Math.min(cap, nCells * row);
  return Math.ceil(Math.max(row, nCells * CELL_STRUCT_BYTES, want, 16) / 8) * 8;
}

/**
 * Total GPU bytes of one fully resident load of `nCells` x `T`: the per-cell
 * buffers, the shared tables and the readback staging buffer. Consumers use it
 * to size batches against a memory budget.
 */
export function estimateBytes(
  nCells: number,
  T: number,
  stagingCap: number = DEFAULT_STAGING_BYTES,
): number {
  return estimateGpuBytes(nCells, T) + tableBytes() + stagingBytesFor(nCells, T, stagingCap);
}

/**
 * Longest trace one cell can have on this device: a cell's row must fit one
 * storage binding / buffer, and its blocks one dispatch dimension. A consumer
 * declines longer tiles instead of failing on them.
 */
export function maxTraceLength(device: GPUDevice): number {
  const maxBinding = Math.min(
    device.limits.maxStorageBufferBindingSize,
    device.limits.maxBufferSize,
  );
  return Math.min(
    Math.floor(maxBinding / 4),
    device.limits.maxComputeWorkgroupsPerDimension * BLOCK,
  );
}

/** Largest number of cells one group can hold for traces of length T. */
export function maxCellsPerGroup(
  device: GPUDevice,
  T: number,
  maxGroupBytes: number = Infinity,
): number {
  if (T > maxTraceLength(device)) return 0;
  const maxBinding = Math.min(
    device.limits.maxStorageBufferBindingSize,
    device.limits.maxBufferSize,
  );
  const byBytes = Math.floor(maxGroupBytes / estimateGpuBytes(1, T));
  return Math.min(
    Math.floor(maxBinding / (T * 4)),
    device.limits.maxComputeWorkgroupsPerDimension,
    byBytes,
  );
}

export interface GpuFistaOptions {
  /**
   * Cap on one group's working set in bytes (`estimateGpuBytes` of the group),
   * applied on top of the device limits. Default: no extra cap.
   */
  maxGroupBytes?: number;
  /**
   * Total GPU byte budget of one load: resident groups, the shared tables and
   * the staging buffer. When the whole problem does not fit, groups stream:
   * groups are sized so two fit (one solving while the next uploads), and a
   * finished group is read back and freed before the next is allocated.
   * Default: no budget (every group resident).
   */
  maxTotalBytes?: number;
  /**
   * Wall-clock target for one command buffer, in ms (default 75). step()
   * times each submit (queue.onSubmittedWorkDone) and sizes the next one to
   * about this long, so a single submission stays well under OS GPU watchdog
   * limits (e.g. Windows TDR at ~2 s) and does not starve a shared
   * compositor. Submit sizing never changes the arithmetic.
   */
  targetSubmitMs?: number;
  /** Size cap of the reused readback staging buffer (default 64 MiB; at least one row). */
  stagingBytes?: number;
}

/**
 * Warm start for a load, in the Rust `Solver::export_state` terms
 * (solver-state-codec.ts in @calab/compute): x_k, the extrapolated point y_k
 * (`solution_prev`), t_fista and the iteration count carried in.
 */
export interface GpuWarmStart {
  /** x_k, nCells x T. */
  solution: Float32Array;
  /** y_k (`solution_prev`), nCells x T; read for cells with momentum[c] = 1. */
  prev?: Float32Array;
  /**
   * Per cell: 1 = continue FISTA momentum (y_0 = prev, t = tFista), like a
   * WASM `load_state`; 0 = momentum reset (y_0 = x_0, t = 1), like
   * `load_state` + `reset_momentum`. Default all 0.
   */
  momentum?: Uint8Array;
  /** Per cell t_fista (used where momentum[c] = 1). */
  tFista?: Float32Array | Float64Array;
  /**
   * Per cell cumulative iteration count carried in. Gates restart
   * (`iteration > 1`) and convergence (`iteration > 5`) like Rust's
   * cumulative counter; the counts step() reports stay per load.
   */
  iterations?: Uint32Array;
}

export interface GpuLoadOptions {
  /**
   * Destination for solutions (nCells x T): retired groups are read back into
   * it, and readSolutions()/solve() fill it. Default: allocated when needed.
   */
  output?: Float32Array;
  /** Keep y_k of retired groups so readSolutionsFor(..., { withState }) works after streaming. */
  retainState?: boolean;
  /** Throw GpuOutOfMemoryError unless every group is resident (no streaming). */
  requireResident?: boolean;
}

export interface GpuStatus {
  /** Iterations run per cell since load (not including GpuWarmStart.iterations). */
  iterations: Uint32Array;
  converged: Uint8Array;
}

export interface GpuStepResult extends GpuStatus {
  allConverged: boolean;
  /** Every group is done: converged, or at maxIters. */
  allDone: boolean;
  /** Most iterations any group ran in this call (0 = nothing left to run). */
  iterationsRun: number;
}

/** Warm-start state per cell, in export_state terms (y_k is `solution_prev`). */
export interface GpuCellState {
  /** y_k per cell, cells.length x T. */
  prev: Float32Array;
  tFista: Float32Array;
  baseline: Float32Array;
}

export interface GpuSolutions {
  solutions: Float32Array;
  iterations: Uint32Array;
  converged: Uint8Array;
  /** Present when read with `withState`. */
  state?: GpuCellState;
}

export interface GpuReadOptions {
  /** Write the solutions here (at least cells.length x T) instead of a new array. */
  out?: Float32Array;
  /** Also return y_k, t_fista and the baseline per cell (warm-start state). */
  withState?: boolean;
}

export interface GpuFista {
  /** Upload (or, when streaming, prepare) a batch. Rejects with GpuOutOfMemoryError on allocation failure. */
  load(
    traces: Float32Array,
    nCells: number,
    T: number,
    params: GpuFistaParams,
    warmStart?: Float32Array | GpuWarmStart,
    options?: GpuLoadOptions,
  ): Promise<void>;
  /** Run up to n more iterations on every resident unfinished group; returns every cell's status. */
  step(n: number): Promise<GpuStepResult>;
  /** step(checkEvery) until every group is done, then read all solutions (into `out` if given). */
  solve(checkEvery?: number, out?: Float32Array): Promise<GpuSolutions>;
  readSolutions(out?: Float32Array): Promise<GpuSolutions>;
  /** Per-cell status as of the last step() (host copy; no GPU work). */
  readStatus(): Promise<GpuStatus>;
  /**
   * Solutions for the given cells only (load-order indices), in the order
   * given: `solutions` is cells.length x T. Status fields are for those cells.
   */
  readSolutionsFor(cells: readonly number[], options?: GpuReadOptions): Promise<GpuSolutions>;
  /** Number of cell groups of the current load. */
  readonly groupCount: number;
  /** Groups currently holding GPU buffers. */
  readonly residentGroups: number;
  /** Longest trace this device can take (see maxTraceLength). */
  readonly maxTraceLength: number;
  /** Total bytes one fully resident load would need (see estimateBytes). */
  estimateBytes(nCells: number, T: number): number;
  /** Set once the device is lost; every call then rejects with it. */
  readonly lostError: GpuDeviceLostError | null;
  destroy(): void;
}

interface Group {
  cellOffset: number;
  nCells: number;
  /** estimateGpuBytes of the group. */
  bytes: number;
  phase: 'pending' | 'resident' | 'retired';
  buffers: GPUBuffer[];
  /** Ping-pong solution buffers: x_k is in xa for even k, xb for odd k. */
  xa: GPUBuffer | null;
  xb: GPUBuffer | null;
  cells: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  itersDone: number;
  done: boolean;
  /** Some cell starts from a stored y (momentum warm start): the first iteration uses sweepFirst. */
  storedY: boolean;
  /** Measured GPU ms per iteration from the last submit; 0 until measured. */
  msPerIter: number;
}

interface RowCopy {
  /** Row index in the destination array. */
  dstRow: number;
  buf: GPUBuffer;
  /** Row index in the group buffer. */
  srcRow: number;
}

const ENTRY_POINTS = ['prep', 'carry', 'sweep', 'sweepFirst', 'fin'] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

export async function createGpuFista(
  device: GPUDevice,
  options: GpuFistaOptions = {},
): Promise<GpuFista> {
  const maxGroupBytes = options.maxGroupBytes ?? Infinity;
  const maxTotalBytes = options.maxTotalBytes ?? Infinity;
  const targetSubmitMs = options.targetSubmitMs ?? DEFAULT_TARGET_SUBMIT_MS;
  const stagingCap = options.stagingBytes ?? DEFAULT_STAGING_BYTES;

  // ---- device loss: reject in-flight work, fail every later call fast ----
  let lostError: GpuDeviceLostError | null = null;
  let rejectLost!: (e: GpuDeviceLostError) => void;
  const lostPromise = new Promise<never>((_, reject) => (rejectLost = reject));
  lostPromise.catch(() => undefined);
  void device.lost.then((info) => {
    lostError = new GpuDeviceLostError(String(info.reason), info.message);
    rejectLost(lostError);
  });
  /** Race a GPU promise against device loss (a lost device may never settle it). */
  const guard = <R>(p: Promise<R>): Promise<R> => Promise.race([p, lostPromise]);

  const module = device.createShaderModule({ code: fistaShaderSource(WG, K) });
  const info = await guard(module.getCompilationInfo());
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    throw new Error(
      `WGSL compile failed: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`,
    );
  }

  const storage = (readOnly: boolean): GPUBindGroupLayoutEntry['buffer'] => ({
    type: readOnly ? 'read-only-storage' : 'storage',
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipelines = {} as Record<EntryPoint, GPUComputePipeline>;
  await guard(
    Promise.all(
      ENTRY_POINTS.map(async (entryPoint) => {
        pipelines[entryPoint] = await device.createComputePipelineAsync({
          layout: pipelineLayout,
          compute: { module, entryPoint },
        });
      }),
    ),
  );

  // ---- per-load state ----
  let groups: Group[] = [];
  let perGroup = 1;
  let T = 0;
  let nBlocks = 0;
  let totalCells = 0;
  let params: GpuFistaParams | null = null;
  let uniformBytes: Uint8Array | null = null;
  let traces: Float32Array | null = null;
  let warm: GpuWarmStart | null = null;
  let output: Float32Array | null = null;
  let retainedPrev: Float32Array | null = null;
  let retainState = false;
  /** Host copy of every cell's Cell record (current as of the last step). */
  let rec = new ArrayBuffer(0);
  let recU32 = new Uint32Array(rec);
  let recF32 = new Float32Array(rec);
  let tab: GPUBuffer | null = null;
  let staging: GPUBuffer | null = null;
  let stagingSize = 0;
  /** Bytes the resident groups may use (total budget minus tables and staging). */
  let groupBudget = Infinity;
  let residentBytes = 0;
  /** An out-of-memory error happened in this load: later validation errors are OOM too. */
  let oomSeen = false;

  // ---- serialization: one GPU operation at a time (scopes, staging) ----
  let chain: Promise<unknown> = Promise.resolve();
  function serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = chain.then(() => {
      if (lostError) throw lostError;
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  }

  function releaseGroup(g: Group): void {
    for (const b of g.buffers) b.destroy();
    if (g.phase === 'resident') residentBytes -= g.bytes;
    g.buffers = [];
    g.xa = g.xb = g.cells = null;
    g.bindGroup = null;
  }

  function releaseAll(): void {
    for (const g of groups) releaseGroup(g);
    groups = [];
    residentBytes = 0;
    tab?.destroy();
    tab = null;
    staging?.destroy();
    staging = null;
    traces = null;
    warm = null;
    retainedPrev = null;
  }

  /**
   * Run `fn` (GPU object creation and uploads) inside out-of-memory and
   * validation error scopes and await both. OOM, or a validation error after
   * an OOM in this load (an invalid buffer poisons its bind group), becomes a
   * GpuOutOfMemoryError; `created` buffers are destroyed on any failure.
   */
  async function scoped<R>(what: string, fn: (created: GPUBuffer[]) => R): Promise<R> {
    const created: GPUBuffer[] = [];
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let thrown: unknown = null;
    let value: R | undefined;
    try {
      value = fn(created);
    } catch (err) {
      thrown = err;
    }
    const validation = await guard(device.popErrorScope());
    const oom = await guard(device.popErrorScope());
    if (thrown === null && !validation && !oom) return value as R;
    for (const b of created) b.destroy();
    if (oom || thrown instanceof RangeError || (validation && oomSeen)) {
      oomSeen = true;
      const msg = oom?.message ?? validation?.message ?? String(thrown);
      throw new GpuOutOfMemoryError(`GPU out of memory (${what}): ${msg}`);
    }
    if (validation) throw new Error(`GPU validation error (${what}): ${validation.message}`);
    throw thrown;
  }

  function createBuf(created: GPUBuffer[], size: number, usage: number): GPUBuffer {
    const buf = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    created.push(buf);
    return buf;
  }

  /** queue.writeBuffer in chunks of at most UPLOAD_CHUNK_BYTES. */
  function upload(buf: GPUBuffer, data: ArrayBufferView, dstOffset = 0): void {
    for (let o = 0; o < data.byteLength; o += UPLOAD_CHUNK_BYTES) {
      const size = Math.min(UPLOAD_CHUNK_BYTES, data.byteLength - o);
      device.queue.writeBuffer(buf, dstOffset + o, data.buffer, data.byteOffset + o, size);
    }
  }

  async function ensureStaging(): Promise<GPUBuffer> {
    if (staging) return staging;
    const s = await scoped('staging buffer', (created) =>
      createBuf(created, stagingSize, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
    );
    staging = s;
    return s;
  }

  /**
   * Map the first `bytes` of the staging buffer, hand them to `consume`, and
   * unmap. A failed map (device lost, aborted) releases the staging buffer; a
   * new one is created on the next readback.
   */
  async function mapStaging(bytes: number, consume: (data: ArrayBuffer) => void): Promise<void> {
    const s = staging!;
    try {
      await guard(s.mapAsync(GPUMapMode.READ, 0, bytes));
      consume(s.getMappedRange(0, bytes));
    } catch (err) {
      if (s.mapState !== 'mapped') {
        if (s.mapState === 'pending') s.unmap();
        s.destroy();
        if (staging === s) staging = null;
      }
      throw err;
    } finally {
      if (s.mapState === 'mapped') s.unmap();
    }
  }

  /** Copy GPU rows into `dst` (row-major, T per row) through the staging buffer, in chunks. */
  async function gatherRows(copies: RowCopy[], dst: Float32Array): Promise<void> {
    if (copies.length === 0) return;
    const s = await ensureStaging();
    const rowBytes = T * 4;
    const rowsPerChunk = Math.max(1, Math.floor(stagingSize / rowBytes));
    for (let c0 = 0; c0 < copies.length; c0 += rowsPerChunk) {
      const chunk = copies.slice(c0, c0 + rowsPerChunk);
      const enc = device.createCommandEncoder();
      for (let k = 0; k < chunk.length;) {
        let j = k + 1;
        while (
          j < chunk.length &&
          chunk[j].buf === chunk[k].buf &&
          chunk[j].srcRow === chunk[k].srcRow + (j - k)
        ) {
          j++;
        }
        enc.copyBufferToBuffer(
          chunk[k].buf,
          chunk[k].srcRow * rowBytes,
          s,
          k * rowBytes,
          (j - k) * rowBytes,
        );
        k = j;
      }
      device.queue.submit([enc.finish()]);
      await mapStaging(chunk.length * rowBytes, (data) => {
        const f = new Float32Array(data);
        for (let k = 0; k < chunk.length;) {
          let j = k + 1;
          while (j < chunk.length && chunk[j].dstRow === chunk[k].dstRow + (j - k)) j++;
          dst.set(f.subarray(k * T, j * T), chunk[k].dstRow * T);
          k = j;
        }
      });
    }
  }

  function groupOf(cell: number): Group {
    const g = groups[Math.floor(cell / perGroup)];
    if (!g || cell < 0 || cell >= totalCells) throw new Error(`cell ${cell} is not loaded`);
    return g;
  }

  /** Buffer holding x_k (`cur`) or the other ping-pong slot (x_{k-1} or a stored y) for a cell. */
  function rowBuffer(g: Group, cell: number, cur: boolean): GPUBuffer {
    const even = recU32[cell * CELL_WORDS + C_ITER] % 2 === 0;
    return even === cur ? g.xa! : g.xb!;
  }

  function constrain(v: number): number {
    if (params!.constraint === 'box01') return Math.min(1, Math.max(0, v));
    return Math.max(0, v);
  }

  /** Turn rows of `prev` that hold x_{k-1} into y_k (f32, as the WGSL forms it). */
  function formY(cell: number, x: Float32Array, prev: Float32Array, row: number): void {
    const useX = recU32[cell * CELL_WORDS + C_USEX];
    const o = row * T;
    if (useX === USE_X) {
      prev.set(x.subarray(o, o + T), o);
    } else if (useX === USE_MOMENTUM) {
      const m = recF32[cell * CELL_WORDS + C_M];
      const f = Math.fround;
      for (let t = o; t < o + T; t++) {
        const xv = x[t];
        prev[t] = constrain(f(xv + f(m * f(xv - prev[t]))));
      }
    } // USE_STORED_Y: the other slot already holds y.
  }

  /** Read a done group into the output arrays and free its buffers. */
  async function retire(g: Group): Promise<void> {
    output ??= new Float32Array(totalCells * T);
    const xCopies: RowCopy[] = [];
    const yCopies: RowCopy[] = [];
    for (let c = 0; c < g.nCells; c++) {
      const cell = g.cellOffset + c;
      xCopies.push({ dstRow: cell, buf: rowBuffer(g, cell, true), srcRow: c });
      if (retainState && recU32[cell * CELL_WORDS + C_USEX] !== USE_X) {
        yCopies.push({ dstRow: cell, buf: rowBuffer(g, cell, false), srcRow: c });
      }
    }
    await gatherRows(xCopies, output);
    if (retainState) {
      retainedPrev ??= new Float32Array(totalCells * T);
      await gatherRows(yCopies, retainedPrev);
      for (let c = 0; c < g.nCells; c++)
        formY(g.cellOffset + c, output, retainedPrev, g.cellOffset + c);
    }
    releaseGroup(g);
    g.phase = 'retired';
  }

  async function allocGroup(g: Group): Promise<void> {
    const n = g.nCells;
    const off = g.cellOffset;
    const bytes = n * T * 4;
    const S = GPUBufferUsage.STORAGE;
    const DST = GPUBufferUsage.COPY_DST;
    const SRC = GPUBufferUsage.COPY_SRC;
    const uni = new Uint8Array(uniformBytes!);
    new Uint32Array(uni.buffer, 8, 1)[0] = n; // Params.nCells
    await scoped(`group of ${n} cells x ${T}`, (created) => {
      const uniform = createBuf(created, PARAMS_BYTES, GPUBufferUsage.UNIFORM | DST);
      const trace = createBuf(created, bytes, S | DST);
      const xa = createBuf(created, bytes, S | DST | SRC);
      const xb = createBuf(created, bytes, S | DST | SRC);
      const aux = createBuf(created, AUX_REC * n * nBlocks * 4, S);
      const cells = createBuf(created, n * CELL_STRUCT_BYTES, S | DST | SRC);
      upload(uniform, uni);
      upload(trace, traces!.subarray(off * T, (off + n) * T));
      if (warm) {
        upload(xa, warm.solution.subarray(off * T, (off + n) * T));
        if (warm.prev) upload(xb, warm.prev.subarray(off * T, (off + n) * T));
      }
      upload(cells, new Uint8Array(rec, off * CELL_STRUCT_BYTES, n * CELL_STRUCT_BYTES));
      const all = [uniform, trace, xa, xb, aux, tab!, cells];
      const bindGroup = device.createBindGroup({
        layout,
        entries: all.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      // Trace terms and the y_0 candidate, then the first carries.
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(pipelines.prep);
      pass.dispatchWorkgroups(nBlocks, n);
      pass.setPipeline(pipelines.carry);
      pass.dispatchWorkgroups(Math.ceil(n / PER_CELL_WG));
      pass.end();
      device.queue.submit([enc.finish()]);
      g.buffers = [uniform, trace, xa, xb, aux, cells];
      g.xa = xa;
      g.xb = xb;
      g.cells = cells;
      g.bindGroup = bindGroup;
    });
    g.phase = 'resident';
    residentBytes += g.bytes;
    g.storedY = false;
    for (let c = off; c < off + n; c++) {
      if (recU32[c * CELL_WORDS + C_USEX] === USE_STORED_Y) g.storedY = true;
    }
  }

  /**
   * Make pending groups resident, in order, while they fit the budget (always
   * at least one group when none is resident). An OOM with groups already
   * resident shrinks the budget to what is resident; the rest keeps streaming.
   */
  async function fill(): Promise<void> {
    for (const g of groups) {
      if (g.phase !== 'pending') continue;
      const anyResident = groups.some((x) => x.phase === 'resident');
      if (anyResident && residentBytes + g.bytes > groupBudget) return;
      try {
        await allocGroup(g);
      } catch (err) {
        if (err instanceof GpuOutOfMemoryError && anyResident) {
          groupBudget = residentBytes;
          return;
        }
        throw err;
      }
    }
  }

  const hasPending = () => groups.some((g) => g.phase === 'pending');

  async function loadImpl(
    tr: Float32Array,
    nCells: number,
    traceLen: number,
    p: GpuFistaParams,
    warmIn: Float32Array | GpuWarmStart | undefined,
    opts: GpuLoadOptions,
  ): Promise<void> {
    if (tr.length !== nCells * traceLen) throw new Error('traces.length !== nCells * T');
    const w: GpuWarmStart | null = warmIn
      ? warmIn instanceof Float32Array
        ? { solution: warmIn }
        : warmIn
      : null;
    if (w && w.solution.length !== tr.length) throw new Error('warmStart length');
    if (w?.prev && w.prev.length !== tr.length) throw new Error('warmStart.prev length');
    if (opts.output && opts.output.length < tr.length) throw new Error('output length');
    releaseAll();
    oomSeen = false;
    T = traceLen;
    nBlocks = Math.ceil(T / BLOCK);
    totalCells = nCells;
    params = p;
    traces = tr;
    warm = w;
    output = opts.output ?? null;
    retainState = opts.retainState ?? false;

    // Host Cell records: t, iteration, converged, useX, baseline, m, iter0.
    rec = new ArrayBuffer(nCells * CELL_STRUCT_BYTES);
    recU32 = new Uint32Array(rec);
    recF32 = new Float32Array(rec);
    for (let c = 0; c < nCells; c++) {
      const o = c * CELL_WORDS;
      const mom = w?.prev !== undefined && (w.momentum?.[c] ?? 0) !== 0;
      recF32[o + C_T] = mom ? (w!.tFista?.[c] ?? 1) : 1;
      recU32[o + C_USEX] = mom ? USE_STORED_Y : USE_X;
      recU32[o + C_ITER0] = w?.iterations?.[c] ?? 0;
    }

    const bp = computeBandedParams(p.tauRise, p.tauDecay, p.fs, p.lambda);
    const tables = buildScanTables(bp.decayRootF32, bp.riseRootF32, T, WG, K).data;
    const u = new ArrayBuffer(PARAMS_BYTES);
    new Uint32Array(u, 0, 8).set([
      T,
      nBlocks,
      0, // nCells, per group
      p.filtered ? 1 : 0,
      p.constraint === 'box01' ? 1 : 0,
    ]);
    new Float32Array(u, 32, 8).set([
      bp.decayRootF32,
      bp.riseRootF32,
      bp.invPeakF32,
      bp.stepF32,
      bp.threshF32,
      p.tol * p.tol,
      1 / T,
    ]);
    uniformBytes = new Uint8Array(u);

    try {
      await partitionAndUpload(nCells, tables, opts);
    } catch (err) {
      releaseAll();
      params = null;
      throw err;
    }
  }

  async function partitionAndUpload(
    nCells: number,
    tables: Float32Array,
    opts: GpuLoadOptions,
  ): Promise<void> {
    // Partition: device limits and maxGroupBytes, then the total budget.
    stagingSize = stagingBytesFor(nCells, T, stagingCap);
    const fixed = tables.byteLength + stagingSize;
    groupBudget = maxTotalBytes - fixed;
    const perCell = estimateGpuBytes(1, T);
    let per = maxCellsPerGroup(device, T, maxGroupBytes);
    if (per < 1 || groupBudget < perCell) {
      throw new GpuOutOfMemoryError(
        `a ${T}-sample trace does not fit the device buffer limits or the byte budget`,
      );
    }
    per = Math.min(per, Math.floor(groupBudget / perCell));
    if (nCells * perCell > groupBudget) {
      // Streaming: size groups so two fit, one solving while the next uploads.
      const half = Math.floor(groupBudget / 2 / perCell);
      if (half >= 1) per = Math.min(per, half);
    }
    perGroup = per;
    for (let off = 0; off < nCells; off += per) {
      const n = Math.min(per, nCells - off);
      groups.push({
        cellOffset: off,
        nCells: n,
        bytes: estimateGpuBytes(n, T),
        phase: 'pending',
        buffers: [],
        xa: null,
        xb: null,
        cells: null,
        bindGroup: null,
        itersDone: 0,
        done: false,
        storedY: false,
        msPerIter: 0,
      });
    }
    if (opts.requireResident && nCells * perCell > groupBudget) {
      throw new GpuOutOfMemoryError(`${nCells} cells x ${T} exceed the GPU byte budget`);
    }

    tab = await scoped('tables', (created) => {
      const b = createBuf(
        created,
        tables.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      upload(b, tables);
      return b;
    });
    await ensureStaging();
    await fill();
    if (opts.requireResident && hasPending()) {
      throw new GpuOutOfMemoryError(`${nCells} cells x ${T} do not fit on the GPU at once`);
    }
  }

  function encodeIterations(pass: GPUComputePassEncoder, g: Group, n: number): void {
    const cw = Math.ceil(g.nCells / PER_CELL_WG);
    pass.setBindGroup(0, g.bindGroup!);
    for (let i = 0; i < n; i++) {
      pass.setPipeline(g.storedY && i === 0 ? pipelines.sweepFirst : pipelines.sweep);
      pass.dispatchWorkgroups(nBlocks, g.nCells);
      pass.setPipeline(pipelines.fin);
      pass.dispatchWorkgroups(cw);
    }
    if (n > 0) g.storedY = false;
  }

  /** One readback of the Cell records of `list` into the host copy. */
  async function readRecords(list: Group[]): Promise<void> {
    if (list.length === 0) return;
    const s = await ensureStaging();
    const enc = device.createCommandEncoder();
    let off = 0;
    for (const g of list) {
      enc.copyBufferToBuffer(g.cells!, 0, s, off, g.nCells * CELL_STRUCT_BYTES);
      off += g.nCells * CELL_STRUCT_BYTES;
    }
    device.queue.submit([enc.finish()]);
    await mapStaging(off, (data) => {
      let o = 0;
      for (const g of list) {
        const n = g.nCells * CELL_STRUCT_BYTES;
        new Uint8Array(rec, g.cellOffset * CELL_STRUCT_BYTES, n).set(new Uint8Array(data, o, n));
        o += n;
      }
    });
  }

  function groupConverged(g: Group): boolean {
    for (let c = g.cellOffset; c < g.cellOffset + g.nCells; c++) {
      if (recU32[c * CELL_WORDS + C_CONV] === 0) return false;
    }
    return true;
  }

  function statusCopy(): GpuStatus {
    const iterations = new Uint32Array(totalCells);
    const converged = new Uint8Array(totalCells);
    for (let c = 0; c < totalCells; c++) {
      iterations[c] = recU32[c * CELL_WORDS + C_ITER];
      converged[c] = recU32[c * CELL_WORDS + C_CONV];
    }
    return { iterations, converged };
  }

  async function stepImpl(n: number): Promise<GpuStepResult> {
    if (!params) throw new Error('load() first');
    const maxIters = params.maxIters;
    const activeGroups = () => groups.filter((g) => g.phase === 'resident' && !g.done);
    let active = activeGroups();
    if (active.length === 0 && hasPending()) {
      await fill();
      active = activeGroups();
    }
    let ran = 0;
    let filled = false;
    for (const g of active) {
      const run = Math.max(0, Math.min(n, maxIters - g.itersDone));
      for (let done = 0; done < run;) {
        const want =
          g.msPerIter > 0
            ? Math.max(1, Math.min(MAX_SUBMIT_ITERS, Math.floor(targetSubmitMs / g.msPerIter)))
            : FIRST_SUBMIT_ITERS;
        const chunk = Math.min(want, run - done);
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        encodeIterations(pass, g, chunk);
        pass.end();
        const t0 = performance.now();
        device.queue.submit([enc.finish()]);
        if (!filled && hasPending()) {
          // Upload the next group(s) behind this submit while the GPU solves.
          filled = true;
          await fill();
        }
        await guard(device.queue.onSubmittedWorkDone());
        g.msPerIter = (performance.now() - t0) / chunk;
        done += chunk;
      }
      g.itersDone += run;
      ran = Math.max(ran, run);
    }
    await readRecords(active);
    for (const g of active) {
      g.done = g.itersDone >= maxIters || groupConverged(g);
    }
    if (hasPending()) {
      for (const g of groups) if (g.phase === 'resident' && g.done) await retire(g);
    }
    const status = statusCopy();
    let allConverged = true;
    for (let c = 0; c < totalCells; c++) if (!status.converged[c]) allConverged = false;
    return {
      ...status,
      allConverged,
      allDone: groups.every((g) => g.done),
      iterationsRun: ran,
    };
  }

  async function readFor(cells: readonly number[], opts: GpuReadOptions): Promise<GpuSolutions> {
    if (!params) throw new Error('load() first');
    const n = cells.length;
    const solutions = opts.out ?? new Float32Array(n * T);
    if (solutions.length < n * T) throw new Error('out is shorter than cells.length x T');
    const iterations = new Uint32Array(n);
    const converged = new Uint8Array(n);
    const xCopies: RowCopy[] = [];
    cells.forEach((cell, i) => {
      const g = groupOf(cell);
      iterations[i] = recU32[cell * CELL_WORDS + C_ITER];
      converged[i] = recU32[cell * CELL_WORDS + C_CONV];
      const dst = i * T;
      if (g.phase === 'resident') {
        xCopies.push({ dstRow: i, buf: rowBuffer(g, cell, true), srcRow: cell - g.cellOffset });
      } else if (g.phase === 'retired') {
        if (solutions !== output || dst !== cell * T) {
          solutions.set(output!.subarray(cell * T, (cell + 1) * T), dst);
        }
      } else if (warm) {
        solutions.set(warm.solution.subarray(cell * T, (cell + 1) * T), dst);
      } else {
        solutions.fill(0, dst, dst + T);
      }
    });
    await gatherRows(xCopies, solutions);
    const result: GpuSolutions = { solutions, iterations, converged };
    if (!opts.withState) return result;

    const prev = new Float32Array(n * T);
    const tFista = new Float32Array(n);
    const baseline = new Float32Array(n);
    const yCopies: RowCopy[] = [];
    cells.forEach((cell, i) => {
      const g = groupOf(cell);
      const o = cell * CELL_WORDS;
      tFista[i] = recF32[o + C_T];
      baseline[i] = params!.filtered ? 0 : recF32[o + C_BASELINE];
      const useX = recU32[o + C_USEX];
      if (g.phase === 'resident') {
        if (useX !== USE_X) {
          yCopies.push({ dstRow: i, buf: rowBuffer(g, cell, false), srcRow: cell - g.cellOffset });
        }
      } else if (g.phase === 'retired') {
        if (!retainedPrev) throw new Error('state of retired groups needs load({ retainState })');
        prev.set(retainedPrev.subarray(cell * T, (cell + 1) * T), i * T);
      } else if (useX === USE_STORED_Y) {
        prev.set(warm!.prev!.subarray(cell * T, (cell + 1) * T), i * T);
      }
    });
    await gatherRows(yCopies, prev);
    cells.forEach((cell, i) => {
      const g = groupOf(cell);
      if (g.phase === 'resident') formY(cell, solutions, prev, i);
      else if (g.phase === 'pending' && recU32[cell * CELL_WORDS + C_USEX] === USE_X) {
        prev.set(solutions.subarray(i * T, (i + 1) * T), i * T);
      }
    });
    result.state = { prev, tFista, baseline };
    return result;
  }

  function allCells(): number[] {
    return Array.from({ length: totalCells }, (_, i) => i);
  }

  return {
    load: (tr, nCells, traceLen, p, warmIn, opts = {}) =>
      serial(() => loadImpl(tr, nCells, traceLen, p, warmIn, opts)),
    step: (n) => serial(() => stepImpl(n)),
    async solve(checkEvery = 50, out) {
      if (!params) throw new Error('load() first');
      if (out) {
        if (out.length < totalCells * T) throw new Error('out length');
        if (output && output !== out) out.set(output.subarray(0, totalCells * T));
        output = out;
      }
      for (;;) {
        const r = await serial(() => stepImpl(checkEvery));
        if (r.allDone || checkEvery <= 0) break;
      }
      return serial(() =>
        readFor(allCells(), { out: (output ??= new Float32Array(totalCells * T)) }),
      );
    },
    readSolutions: (out) =>
      serial(() =>
        readFor(allCells(), { out: out ?? (output ??= new Float32Array(totalCells * T)) }),
      ),
    readStatus: async () => {
      if (lostError) throw lostError;
      return statusCopy();
    },
    readSolutionsFor: (cells, opts = {}) => serial(() => readFor(cells, opts)),
    get groupCount() {
      return groups.length;
    },
    get residentGroups() {
      return groups.filter((g) => g.phase === 'resident').length;
    },
    maxTraceLength: maxTraceLength(device),
    estimateBytes: (nCells, len) => estimateBytes(nCells, len, stagingCap),
    get lostError() {
      return lostError;
    },
    /** Free every buffer of the current load; the instance can load again. */
    destroy() {
      releaseAll();
      params = null;
    },
  };
}
