/**
 * Batched banded-AR(2) FISTA on WebGPU: every cell of a recording is solved
 * at once, one dispatch per stage per iteration (see shaders/fista-wgsl.ts).
 *
 * Cells are split into groups whose per-cell buffers fit the device's
 * maxStorageBufferBindingSize / maxBufferSize; each group has its own buffers
 * and bind group, and groups are encoded one after another. Converged flags
 * are read back only once per `step()` call (the solve loop calls step with
 * `checkEvery` iterations), so the GPU is not stalled every iteration.
 */
import { computeBandedParams } from './banded-params.ts';
import { BLOCK, K, WG } from './scan-reference.ts';
import { fistaShaderSource } from './shaders/fista-wgsl.ts';
import type { GpuFistaParams } from './types.ts';

const CELL_STRUCT_BYTES = 32;
const PARAMS_BYTES = 80;
const PER_CELL_WG = 64;
/** Iterations per command buffer, so one submit never runs too long. */
const ITERS_PER_SUBMIT = 50;

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
  return nCells * (5 * T * 4 + 6 * nBlocks * 4 + CELL_STRUCT_BYTES);
}

/** Largest number of cells one group can hold for traces of length T. */
export function maxCellsPerGroup(device: GPUDevice, T: number): number {
  const maxBinding = Math.min(
    device.limits.maxStorageBufferBindingSize,
    device.limits.maxBufferSize,
  );
  return Math.min(Math.floor(maxBinding / (T * 4)), device.limits.maxComputeWorkgroupsPerDimension);
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
  /** Number of cell groups of the current load. */
  readonly groupCount: number;
  destroy(): void;
}

interface Group {
  cellOffset: number;
  nCells: number;
  buffers: GPUBuffer[];
  xs: GPUBuffer;
  cells: GPUBuffer;
  bindGroup: GPUBindGroup;
  allConverged: boolean;
}

const ENTRY_POINTS = [
  'fwd1',
  'fwd2',
  'fwd3',
  'bfin',
  'carryD',
  'carryR',
  'adj1',
  'adj2',
  'prox',
  'fin',
] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

export async function createGpuFista(device: GPUDevice): Promise<GpuFista> {
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
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: storage(true) },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: storage(false) },
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
    const pows = new Float32Array(2 * (BLOCK + 1));
    for (let j = 0; j <= BLOCK; j++) {
      pows[j] = Math.pow(d, j);
      pows[BLOCK + 1 + j] = Math.pow(r, j);
    }

    const perGroup = maxCellsPerGroup(device, T);
    if (perGroup < 1) throw new Error(`trace length ${T} exceeds the device's buffer limits`);

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
      new Float32Array(u, 32, 12).set([
        d,
        r,
        bp.invPeakF32,
        bp.stepF32,
        bp.threshF32,
        p.tol * p.tol,
        1 / T,
        Math.pow(d, BLOCK),
        Math.pow(r, BLOCK),
      ]);
      const cellInit = new ArrayBuffer(n * CELL_STRUCT_BYTES);
      const cf = new Float32Array(cellInit);
      for (let c = 0; c < n; c++) cf[c * 8] = 1; // t_fista = 1, all else 0

      const uniform = makeBuffer(PARAMS_BYTES, GPUBufferUsage.UNIFORM | DST, new Uint8Array(u));
      const trace = makeBuffer(bytes, S | DST, slice);
      const xs = makeBuffer(bytes, S | DST | SRC, warm);
      const ys = makeBuffer(bytes, S | DST, warm);
      const s1 = makeBuffer(bytes, S);
      const s2 = makeBuffer(bytes, S);
      const aux = makeBuffer(6 * n * nBlocks * 4, S);
      const powBuf = makeBuffer(pows.byteLength, S | DST, pows);
      const cells = makeBuffer(n * CELL_STRUCT_BYTES, S | DST | SRC, new Uint8Array(cellInit));
      const all = [uniform, trace, xs, ys, s1, s2, aux, powBuf, cells];
      const bindGroup = device.createBindGroup({
        layout,
        entries: all.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      groups.push({
        cellOffset: off,
        nCells: n,
        buffers: all,
        xs,
        cells,
        bindGroup,
        allConverged: false,
      });
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
      block('fwd1');
      perCell('carryD');
      block('fwd2');
      perCell('carryR');
      if (!params!.filtered) {
        block('fwd3');
        perCell('bfin');
      }
      block('adj1');
      perCell('carryD');
      block('adj2');
      perCell('carryR');
      block('prox');
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
        for (let done = 0; done < run; done += ITERS_PER_SUBMIT) {
          const enc = device.createCommandEncoder();
          const pass = enc.beginComputePass();
          encodeIterations(pass, g, Math.min(ITERS_PER_SUBMIT, run - done));
          pass.end();
          device.queue.submit([enc.finish()]);
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
      const [x, st] = await Promise.all([
        readBuffer(g.xs, g.nCells * T * 4),
        readBuffer(g.cells, g.nCells * CELL_STRUCT_BYTES),
      ]);
      solutions.set(new Float32Array(x), g.cellOffset * T);
      const u = new Uint32Array(st);
      for (let c = 0; c < g.nCells; c++) {
        iterations[g.cellOffset + c] = u[c * 8 + 1];
        converged[g.cellOffset + c] = u[c * 8 + 2];
      }
    }
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
    get groupCount() {
      return groups.length;
    },
    destroy: releaseGroups,
  };
}
