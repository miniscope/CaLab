/**
 * Batched banded-AR(2) FISTA on WebGPU: every cell of a recording is solved
 * at once, two dispatches per iteration (see shaders/fista-wgsl.ts).
 *
 * Cells are split into groups whose per-cell buffers fit the device's
 * maxStorageBufferBindingSize / maxBufferSize; each group has its own buffers
 * and bind group, and groups are encoded one after another. Converged flags
 * are read back only once per `step()` call (the solve loop calls step with
 * `checkEvery` iterations), so the GPU is not stalled every iteration.
 */
import { computeBandedParams } from './banded-params.ts';
import { BLOCK, K, WG, buildScanTables } from './scan-reference.ts';
import { fistaShaderSource } from './shaders/fista-wgsl.ts';
import type { GpuFistaParams } from './types.ts';

const CELL_STRUCT_BYTES = 32;
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

/** Bytes of GPU memory one solve needs (all groups, all buffers). */
export function estimateGpuBytes(nCells: number, T: number): number {
  const nBlocks = Math.ceil(T / BLOCK);
  return nCells * (3 * T * 4 + AUX_REC * nBlocks * 4 + CELL_STRUCT_BYTES);
}

/** Largest number of cells one group can hold for traces of length T. */
export function maxCellsPerGroup(
  device: GPUDevice,
  T: number,
  maxGroupBytes: number = Infinity,
): number {
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
   * Cap on one group's total working set in bytes (`estimateGpuBytes` of the
   * group), applied on top of the device limits. Default: no extra cap, so the
   * device limits alone decide. Mainly for tests that need several groups.
   */
  maxGroupBytes?: number;
  /**
   * Wall-clock target for one command buffer, in ms (default 75). step()
   * times each submit (queue.onSubmittedWorkDone) and sizes the next one to
   * about this long, so a single submission stays well under OS GPU watchdog
   * limits (e.g. Windows TDR at ~2 s) and does not starve a shared
   * compositor. Submit sizing never changes the arithmetic.
   */
  targetSubmitMs?: number;
}

export interface GpuSolutions {
  solutions: Float32Array;
  iterations: Uint32Array;
  converged: Uint8Array;
}

export interface GpuFista {
  load(
    traces: Float32Array,
    nCells: number,
    T: number,
    params: GpuFistaParams,
    warmStart?: Float32Array,
  ): void;
  /** Run up to n more iterations (capped at params.maxIters) on unconverged groups. */
  step(n: number): Promise<{ allConverged: boolean; iterationsRun: number }>;
  /** step(checkEvery) until all cells converged or maxIters reached. */
  solve(checkEvery?: number): Promise<GpuSolutions>;
  readSolutions(): Promise<GpuSolutions>;
  /**
   * Per-cell iteration counts and converged flags only (32 B per cell), for
   * per-quantum progress checks without reading the solutions back.
   */
  readStatus(): Promise<{ iterations: Uint32Array; converged: Uint8Array }>;
  /**
   * Solutions for the given cells only (load-order indices), in the order
   * given: `solutions` is cells.length x T. Status fields are for those cells.
   */
  readSolutionsFor(cells: readonly number[]): Promise<GpuSolutions>;
  /** Number of cell groups of the current load. */
  readonly groupCount: number;
  destroy(): void;
}

interface Group {
  cellOffset: number;
  nCells: number;
  buffers: GPUBuffer[];
  /** Ping-pong solution buffers: x_k is in xa for even k, xb for odd k. */
  xa: GPUBuffer;
  xb: GPUBuffer;
  cells: GPUBuffer;
  bindGroup: GPUBindGroup;
  allConverged: boolean;
  /** Measured GPU ms per iteration from the last submit; 0 until measured. */
  msPerIter: number;
}

const ENTRY_POINTS = ['prep', 'carry', 'sweep', 'fin'] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

export async function createGpuFista(
  device: GPUDevice,
  options: GpuFistaOptions = {},
): Promise<GpuFista> {
  const maxGroupBytes = options.maxGroupBytes ?? Infinity;
  const targetSubmitMs = options.targetSubmitMs ?? DEFAULT_TARGET_SUBMIT_MS;
  const module = device.createShaderModule({ code: fistaShaderSource(WG, K) });
  const info = await module.getCompilationInfo();
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
  await Promise.all(
    ENTRY_POINTS.map(async (entryPoint) => {
      pipelines[entryPoint] = await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module, entryPoint },
      });
    }),
  );

  let groups: Group[] = [];
  let T = 0;
  let nBlocks = 0;
  let totalCells = 0;
  let params: GpuFistaParams | null = null;
  let itersDone = 0;

  function releaseGroups(): void {
    for (const g of groups) for (const b of g.buffers) b.destroy();
    groups = [];
  }

  function makeBuffer(size: number, usage: number, data?: ArrayBufferView): GPUBuffer {
    const buf = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    if (data) device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
  }

  function load(
    traces: Float32Array,
    nCells: number,
    traceLen: number,
    p: GpuFistaParams,
    warmStart?: Float32Array,
  ): void {
    if (traces.length !== nCells * traceLen) throw new Error('traces.length !== nCells * T');
    if (warmStart && warmStart.length !== traces.length) throw new Error('warmStart length');
    releaseGroups();
    T = traceLen;
    nBlocks = Math.ceil(T / BLOCK);
    totalCells = nCells;
    params = p;
    itersDone = 0;

    const bp = computeBandedParams(p.tauRise, p.tauDecay, p.fs, p.lambda);
    const d = bp.decayRootF32;
    const r = bp.riseRootF32;
    const tables = buildScanTables(d, r, T, WG, K).data;

    const perGroup = maxCellsPerGroup(device, T, maxGroupBytes);
    if (perGroup < 1) {
      throw new Error(`trace length ${T} exceeds the device buffer limits or maxGroupBytes`);
    }

    const S = GPUBufferUsage.STORAGE;
    const DST = GPUBufferUsage.COPY_DST;
    const SRC = GPUBufferUsage.COPY_SRC;
    for (let off = 0; off < nCells; off += perGroup) {
      const n = Math.min(perGroup, nCells - off);
      const bytes = n * T * 4;
      const slice = traces.subarray(off * T, (off + n) * T);
      const warm = warmStart ? warmStart.subarray(off * T, (off + n) * T) : undefined;

      const u = new ArrayBuffer(PARAMS_BYTES);
      new Uint32Array(u, 0, 8).set([
        T,
        nBlocks,
        n,
        p.filtered ? 1 : 0,
        p.constraint === 'box01' ? 1 : 0,
      ]);
      new Float32Array(u, 32, 8).set([
        d,
        r,
        bp.invPeakF32,
        bp.stepF32,
        bp.threshF32,
        p.tol * p.tol,
        1 / T,
      ]);
      const cellInit = new ArrayBuffer(n * CELL_STRUCT_BYTES);
      const cf = new Float32Array(cellInit);
      const cu = new Uint32Array(cellInit);
      for (let c = 0; c < n; c++) {
        cf[c * 8] = 1; // t_fista = 1
        cu[c * 8 + 3] = 1; // useX: y_0 = x_0
      }

      const uniform = makeBuffer(PARAMS_BYTES, GPUBufferUsage.UNIFORM | DST, new Uint8Array(u));
      const trace = makeBuffer(bytes, S | DST, slice);
      const xa = makeBuffer(bytes, S | DST | SRC, warm);
      const xb = makeBuffer(bytes, S | SRC);
      const aux = makeBuffer(AUX_REC * n * nBlocks * 4, S);
      const tab = makeBuffer(tables.byteLength, S | DST, tables);
      const cells = makeBuffer(n * CELL_STRUCT_BYTES, S | DST | SRC, new Uint8Array(cellInit));
      const all = [uniform, trace, xa, xb, aux, tab, cells];
      const bindGroup = device.createBindGroup({
        layout,
        entries: all.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const group: Group = {
        cellOffset: off,
        nCells: n,
        buffers: all,
        xa,
        xb,
        cells,
        bindGroup,
        allConverged: false,
        msPerIter: 0,
      };
      groups.push(group);

      // Trace terms and the x_0 candidate, then the first carries.
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(pipelines.prep);
      pass.dispatchWorkgroups(nBlocks, n);
      pass.setPipeline(pipelines.carry);
      pass.dispatchWorkgroups(Math.ceil(n / PER_CELL_WG));
      pass.end();
      device.queue.submit([enc.finish()]);
    }
  }

  function encodeIterations(pass: GPUComputePassEncoder, g: Group, n: number): void {
    const cw = Math.ceil(g.nCells / PER_CELL_WG);
    const block = (e: EntryPoint) => {
      pass.setPipeline(pipelines[e]);
      pass.dispatchWorkgroups(nBlocks, g.nCells);
    };
    const perCell = (e: EntryPoint) => {
      pass.setPipeline(pipelines[e]);
      pass.dispatchWorkgroups(cw);
    };
    pass.setBindGroup(0, g.bindGroup);
    for (let i = 0; i < n; i++) {
      block('sweep');
      perCell('fin');
    }
  }

  async function readBuffer(src: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const staging = device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, size);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return out;
  }

  function cellsConverged(buf: ArrayBuffer, n: number): boolean {
    const u = new Uint32Array(buf);
    for (let c = 0; c < n; c++) if (u[c * 8 + 2] === 0) return false;
    return true;
  }

  async function step(n: number): Promise<{ allConverged: boolean; iterationsRun: number }> {
    if (!params) throw new Error('load() first');
    const run = Math.max(0, Math.min(n, params.maxIters - itersDone));
    const active = groups.filter((g) => !g.allConverged);
    if (run > 0) {
      for (const g of active) {
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
          await device.queue.onSubmittedWorkDone();
          g.msPerIter = (performance.now() - t0) / chunk;
          done += chunk;
        }
      }
      itersDone += run;
    }
    const states = await Promise.all(
      active.map((g) => readBuffer(g.cells, g.nCells * CELL_STRUCT_BYTES)),
    );
    active.forEach((g, i) => {
      g.allConverged = cellsConverged(states[i], g.nCells);
    });
    return { allConverged: groups.every((g) => g.allConverged), iterationsRun: run };
  }

  async function readSolutions(): Promise<GpuSolutions> {
    const solutions = new Float32Array(totalCells * T);
    const iterations = new Uint32Array(totalCells);
    const converged = new Uint8Array(totalCells);
    for (const g of groups) {
      const u = new Uint32Array(await readBuffer(g.cells, g.nCells * CELL_STRUCT_BYTES));
      for (let c = 0; c < g.nCells; c++) {
        iterations[g.cellOffset + c] = u[c * 8 + 1];
        converged[g.cellOffset + c] = u[c * 8 + 2];
      }
      // x_k is in xa or xb by the parity of each cell's iteration count:
      // gather with one copy per cell (no state is modified).
      const rowBytes = T * 4;
      const size = g.nCells * rowBytes;
      const staging = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const enc = device.createCommandEncoder();
      for (let c = 0; c < g.nCells; c++) {
        const src = u[c * 8 + 1] % 2 === 0 ? g.xa : g.xb;
        enc.copyBufferToBuffer(src, c * rowBytes, staging, c * rowBytes, rowBytes);
      }
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      solutions.set(new Float32Array(staging.getMappedRange()), g.cellOffset * T);
      staging.unmap();
      staging.destroy();
    }
    return { solutions, iterations, converged };
  }

  async function readStatus(): Promise<{ iterations: Uint32Array; converged: Uint8Array }> {
    const iterations = new Uint32Array(totalCells);
    const converged = new Uint8Array(totalCells);
    const states = await Promise.all(
      groups.map((g) => readBuffer(g.cells, g.nCells * CELL_STRUCT_BYTES)),
    );
    groups.forEach((g, i) => {
      const u = new Uint32Array(states[i]);
      for (let c = 0; c < g.nCells; c++) {
        iterations[g.cellOffset + c] = u[c * 8 + 1];
        converged[g.cellOffset + c] = u[c * 8 + 2];
      }
    });
    return { iterations, converged };
  }

  async function readSolutionsFor(cells: readonly number[]): Promise<GpuSolutions> {
    const status = await readStatus();
    const n = cells.length;
    const rowBytes = T * 4;
    const solutions = new Float32Array(n * T);
    const iterations = new Uint32Array(n);
    const converged = new Uint8Array(n);
    if (n === 0) return { solutions, iterations, converged };
    const staging = device.createBuffer({
      size: n * rowBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    cells.forEach((cell, i) => {
      const g = groups.find((gr) => cell >= gr.cellOffset && cell < gr.cellOffset + gr.nCells);
      if (!g) throw new Error(`cell ${cell} is not loaded`);
      const c = cell - g.cellOffset;
      iterations[i] = status.iterations[cell];
      converged[i] = status.converged[cell];
      const src = iterations[i] % 2 === 0 ? g.xa : g.xb;
      enc.copyBufferToBuffer(src, c * rowBytes, staging, i * rowBytes, rowBytes);
    });
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    solutions.set(new Float32Array(staging.getMappedRange()));
    staging.unmap();
    staging.destroy();
    return { solutions, iterations, converged };
  }

  async function solve(checkEvery = 50): Promise<GpuSolutions> {
    if (!params) throw new Error('load() first');
    for (;;) {
      const { allConverged, iterationsRun } = await step(checkEvery);
      if (allConverged || iterationsRun === 0 || itersDone >= params.maxIters) break;
    }
    return readSolutions();
  }

  return {
    load,
    step,
    solve,
    readSolutions,
    readStatus,
    readSolutionsFor,
    get groupCount() {
      return groups.length;
    },
    destroy: releaseGroups,
  };
}
