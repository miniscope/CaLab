// CaTune's solver backend selection (dev-only WebGPU switch).
//
// Default (no flag): createSolverPool returns the plain WASM worker pool,
// exactly as before. With `?backend=gpu` (or localStorage 'calab:backend' =
// 'gpu') it returns a WorkerPool-shaped facade over a TileScheduler from
// @calab/compute with two consumers in preference order:
//
//   1. the WebGPU batch consumer (all cells' windows solved together),
//   2. a reduced WASM worker pool (GPU and workers share the memory bus on
//      integrated / Apple Silicon GPUs), which takes tiles the GPU declines
//      (FFT conv mode).
//
// If the GPU fails (no WebGPU, software adapter, device creation failed,
// solver error) its tiles are re-queued and the reduced pool is replaced by a
// full-size one. A lost device gets one re-acquire attempt first.
//
// cell-solve-manager keeps dispatching one job per cell; each job becomes a
// single-cell tile. Status, throughput and the GPU-vs-WASM check feed the dev
// readout (components/dev/BackendDevReadout.tsx).
//
// The calibration gate is advisory by default (the readout shows it); with
// `?gpuGate=auto` it routes: the GPU takes tiles only while its measured rate
// beats the WASM pool's estimate by the gate margin.

import { createSignal } from 'solid-js';
import type { SolverParams, WarmStartStrategy } from '@calab/core';
import {
  createCalibrationStore,
  createGpuBatchConsumer,
  createTileScheduler,
  createWasmPoolConsumer,
  getDefaultWorkerCount,
  getRequestedBackend,
  getRequestedGpuGate,
  gpuParticipationVerdict,
  softwareAdapterReason,
  webGpuUnavailableReason,
  type AdapterLike,
  type BatchFistaEngine,
  type DisplayReconvolution,
  type GpuBatchConsumer,
  type GpuGateMode,
  type GpuBatchStats,
  type SolveTile,
  type TileConsumer,
  type WorkerPool,
} from '@calab/compute';
import type { CaTunePoolJob } from './catune-pool.ts';
import { createGpuPrepClient, type GpuPrepClient, type PrepStats } from './gpu-prep-client.ts';

export interface BackendStatus {
  requested: 'wasm' | 'gpu';
  /** Backend currently solving banded tiles. */
  active: 'wasm-pool' | 'webgpu' | 'webgpu (starting)';
  adapter?: string;
  /** WASM workers currently running. */
  wasmWorkers?: number;
  /** Why the GPU is not (or not always) used. */
  reason?: string;
}

export interface GpuCellRecord {
  cellIndex: number;
  rawWindow: Float32Array;
  params: SolverParams;
  solution: Float32Array;
  iterations: number;
  /** Warm-start state the GPU solve began from (null = cold). */
  warmState: Uint8Array | null;
  /** How the GPU used it ('warm' continues momentum, like WASM load_state). */
  warmStrategy: WarmStartStrategy;
  warmStarted: boolean;
  converged: boolean;
}

export interface BackendComparison {
  cellIndex: number;
  relL2: number;
  maxAbs: number;
  gpuIterations: number;
  gpuWarmStarted: boolean;
  /** The warm-start strategy both solves used. */
  warmStrategy: WarmStartStrategy;
  wasmIterations: number;
  wasmConverged: boolean;
  wasmMs: number;
}

const [backendStatus, setBackendStatus] = createSignal<BackendStatus>({
  requested: 'wasm',
  active: 'wasm-pool',
});
const [gpuStats, setGpuStats] = createSignal<GpuBatchStats | null>(null);
const [gpuResultVersion, setGpuResultVersion] = createSignal(0);
/** Calibration gate verdict (null = GPU worth using, or not enough data). Advisory under the dev flag. */
const [calibrationVerdict, setCalibrationVerdict] = createSignal<string | null>(null);
export { backendStatus, gpuStats, gpuResultVersion, calibrationVerdict };

/** Fresh throughput measurements per backend (expire after 10 min). */
export const calibrations = createCalibrationStore();
function updateVerdict(): void {
  setCalibrationVerdict(
    gpuParticipationVerdict(calibrations.get('webgpu'), calibrations.get('wasm-pool')),
  );
}

/** Latest converged GPU result per cell, for the comparison. */
const gpuResults = new Map<number, GpuCellRecord>();
let lastGpuCell: number | null = null;
/** The cell's latest converged GPU result, else the most recently converged cell's. */
export function latestGpuResult(cellIndex: number): GpuCellRecord | undefined {
  return (
    gpuResults.get(cellIndex) ?? (lastGpuCell === null ? undefined : gpuResults.get(lastGpuCell))
  );
}

let referenceClient: GpuPrepClient | null = null;
let prepClient: GpuPrepClient | null = null;

/** Working-trace preprocessing done for the GPU so far (dev readout), or null without the GPU path. */
export function gpuPrepStats(): PrepStats | null {
  return prepClient?.prepStats() ?? null;
}
let fullPoolSize = 1;

/**
 * Solve the GPU's latest window for `cellIndex` with a WASM Solver (in a
 * worker, from the same warm start and strategy, so momentum continues or
 * resets exactly as on the GPU; no mid-solve getters) and compare; iteration
 * counts are then cumulative on both sides. Also records a WASM-pool
 * calibration estimate: one worker's rate (iterations it actually ran, solve
 * time only) x the full pool size.
 */
export async function compareWithWasm(cellIndex: number): Promise<BackendComparison | null> {
  const rec = latestGpuResult(cellIndex);
  if (!rec || !referenceClient) return null;
  const ref = await referenceClient.reference(
    rec.rawWindow,
    rec.params,
    rec.warmState,
    rec.warmStrategy,
  );
  if (ref.solveMs > 0 && ref.iterationsRun > 0) {
    calibrations.record({
      backend: 'wasm-pool',
      adapter: `wasm x${fullPoolSize} workers (ideal-scaling estimate)`,
      sampleItersPerSec:
        ((rec.rawWindow.length * ref.iterationsRun) / ref.solveMs) * 1000 * fullPoolSize,
      measuredAt: Date.now(),
    });
    updateVerdict();
  }
  return {
    cellIndex: rec.cellIndex,
    relL2: relL2(rec.solution, ref.solution),
    maxAbs: maxAbs(rec.solution, ref.solution),
    gpuIterations: rec.iterations,
    gpuWarmStarted: rec.warmStarted,
    warmStrategy: rec.warmStrategy,
    wasmIterations: ref.iterations,
    wasmConverged: ref.converged,
    wasmMs: ref.ms,
  };
}

export function relL2(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    num += d * d;
    den += b[i] * b[i];
  }
  return den > 0 ? Math.sqrt(num / den) : Math.sqrt(num);
}

function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

type BandedParamsFn = (
  tauRise: number,
  tauDecay: number,
  fs: number,
  lambda: number,
) => { g1F32: number; g2F32: number; invPeakF32: number };

/** Weight of the newest raw baseline in the display EMA (BASELINE_EMA_WEIGHT in crates/solver). */
export const DISPLAY_BASELINE_EMA_WEIGHT = 0.3;

/**
 * Display reconvolution for GPU results: the banded AR(2) forward recursion
 * (port of BandedAR2::convolve_forward, f32) plus the display baseline, as
 * the WASM getter `get_reconvolution_with_baseline` computes it: the raw
 * baseline mean(working - K*s) (f64) is folded into an EMA
 * (`update_display_baseline`: the first value as is, then 0.3 new + 0.7 old)
 * that starts fresh with each solve hand-out (set_trace resets it), and the
 * EMA is added in f32. `prev` is this cell's EMA from the previous readback
 * of the same hand-out, or null.
 */
export function makeReconvolve(computeBandedParams: BandedParamsFn) {
  let key = '';
  let bp: ReturnType<BandedParamsFn> | null = null;
  const f = Math.fround;
  return (
    s: Float32Array,
    working: Float32Array,
    p: SolverParams,
    prev: number | null = null,
  ): DisplayReconvolution => {
    const k = `${p.tauRise}|${p.tauDecay}|${p.fs}`;
    if (k !== key || !bp) {
      bp = computeBandedParams(p.tauRise, p.tauDecay, p.fs, p.lambda);
      key = k;
    }
    const n = s.length;
    const out = new Float32Array(n);
    const { g1F32: g1, g2F32: g2, invPeakF32: inv } = bp;
    if (n > 1) out[1] = f(f(g1 * out[0]) + f(s[0] * inv));
    for (let t = 2; t < n; t++) {
      out[t] = f(f(f(g1 * out[t - 1]) + f(g2 * out[t - 2])) + f(s[t - 1] * inv));
    }
    let sum = 0;
    for (let t = 0; t < n; t++) sum += f(working[t] - out[t]);
    const raw = n > 0 ? sum / n : 0;
    const ema =
      prev === null
        ? raw
        : DISPLAY_BASELINE_EMA_WEIGHT * raw + (1 - DISPLAY_BASELINE_EMA_WEIGHT) * prev;
    const b = f(ema);
    for (let t = 0; t < n; t++) out[t] = f(out[t] + b);
    return { reconvolution: out, displayBaseline: ema };
  };
}

function jobToTile(job: CaTunePoolJob): SolveTile {
  return {
    id: job.jobId,
    cells: [job.cellIndex ?? -1],
    windowStart: job.windowStart ?? 0,
    traces: [job.trace],
    params: job.params,
    warmStart: job.warmState ? { strategy: job.warmStrategy, states: [job.warmState] } : null,
    maxIterations: job.maxIterations,
    getPriority: job.getPriority,
    // Priority 0/1 = selected, hovered or visible: those cards show progress.
    wantsIntermediate: () => (job.getPriority?.() ?? 1) <= 1,
    onIntermediate(updates) {
      const u = updates[0];
      job.onIntermediate(u.solution, u.reconvolution, u.iteration);
    },
    onComplete(results) {
      const r = results[0];
      if (r.backend === 'webgpu' && r.cellIndex >= 0 && r.converged) {
        gpuResults.set(r.cellIndex, {
          cellIndex: r.cellIndex,
          rawWindow: job.trace,
          params: job.params,
          solution: r.solution,
          iterations: r.iteration,
          warmState: job.warmStrategy !== 'cold' ? job.warmState : null,
          warmStrategy: job.warmStrategy,
          warmStarted: job.warmState !== null && job.warmStrategy !== 'cold',
          converged: r.converged,
        });
        lastGpuCell = r.cellIndex;
        setGpuResultVersion((v) => v + 1);
      }
      job.onComplete(
        r.solution,
        r.reconvolution,
        r.state,
        r.iteration,
        r.converged,
        r.workingTrace,
      );
    },
    onCancelled: () => job.onCancelled(),
    onError: (m) => job.onError(m),
  };
}

function poolConsumer(pool: WorkerPool<CaTunePoolJob>, maxInFlight?: number): TileConsumer {
  return createWasmPoolConsumer<CaTunePoolJob>({
    pool,
    maxInFlight,
    buildJob: (tile, k, jobId, cb) => ({
      jobId,
      cellIndex: tile.cells[k],
      windowStart: tile.windowStart,
      trace: tile.traces[k],
      params: tile.params,
      warmState: tile.warmStart?.states[k] ?? null,
      warmStrategy: tile.warmStart?.strategy ?? 'cold',
      maxIterations: tile.maxIterations,
      getPriority: tile.getPriority,
      onIntermediate: (solution, reconvolution, iteration) =>
        cb.onIntermediate({ solution, reconvolution, iteration }),
      onComplete: (solution, reconvolution, state, iteration, converged, workingTrace) =>
        cb.onComplete({ solution, reconvolution, state, iteration, converged, workingTrace }),
      onCancelled: cb.onCancelled,
      onError: cb.onError,
    }),
  });
}

/** The parts of @calab/compute-gpu used here (injectable for tests). */
export interface GpuModule {
  requestGpuDevice(): Promise<GPUDevice | null>;
  createGpuFista(
    device: GPUDevice,
    options?: { maxGroupBytes?: number },
  ): Promise<Omit<BatchFistaEngine, 'adapter'>>;
  computeBandedParams: BandedParamsFn;
}

export interface SolverPoolDeps {
  /** Overridable for tests. */
  requested?: 'wasm' | 'gpu';
  webGpuUnavailable?: () => string | null;
  loadGpuModule?: () => Promise<GpuModule>;
  /** Adapter probe for the software-adapter gate (old `GPUAdapter.isFallbackAdapter` lives here). */
  probeAdapter?: () => Promise<AdapterLike | null>;
  createPrepWorker?: () => Worker;
  /** GPU group budget hook (bytes); unset = device limits decide. */
  groupBudgetBytes?: number;
  /** GPU batch working-set budget (bytes); unset = DEFAULT_GPU_MEMORY_BUDGET. */
  memoryBudgetBytes?: number;
  /** WASM workers kept while the GPU is active (shared memory bus). Default 2. */
  wasmWorkersWithGpu?: number;
  /** Full pool size after a GPU failure. Default: the normal worker count. */
  wasmWorkersFull?: number;
  /** Calibration gate mode; default from `?gpuGate=` (advisory unless 'auto'). */
  gpuGate?: GpuGateMode;
}

const defaultPrepWorker = () =>
  new Worker(new URL('../workers/gpu-prep-worker.ts', import.meta.url), { type: 'module' });

async function defaultProbeAdapter(): Promise<AdapterLike | null> {
  const gpu = (navigator as { gpu?: GPU }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const legacy = adapter as unknown as { isFallbackAdapter?: boolean };
  return { isFallbackAdapter: legacy.isFallbackAdapter, info: adapter.info as AdapterLike };
}

/**
 * The pool cell-solve-manager dispatches to. Without the dev flag this is
 * `makeWasmPool()` itself; with it, the scheduler facade described above.
 */
export function createSolverPool(
  makeWasmPool: (size?: number) => WorkerPool<CaTunePoolJob>,
  deps: SolverPoolDeps = {},
): WorkerPool<CaTunePoolJob> {
  const requested = deps.requested ?? getRequestedBackend();
  setGpuStats(null);
  gpuResults.clear();
  lastGpuCell = null;
  if (requested !== 'gpu') {
    setBackendStatus({ requested, active: 'wasm-pool' });
    return makeWasmPool();
  }

  fullPoolSize = deps.wasmWorkersFull ?? getDefaultWorkerCount();
  const gate = deps.gpuGate ?? getRequestedGpuGate();
  const unavailable = (deps.webGpuUnavailable ?? webGpuUnavailableReason)();
  const reducedSize = Math.max(1, Math.min(deps.wasmWorkersWithGpu ?? 2, fullPoolSize));
  // Without WebGPU the pool runs at full size from the start.
  let wasmUpgraded = unavailable !== null;
  let wasm = wasmUpgraded
    ? poolConsumer(makeWasmPool(fullPoolSize))
    : poolConsumer(makeWasmPool(reducedSize), reducedSize);
  let gpu: GpuBatchConsumer | null = null;
  let reacquireLeft = 1;
  let disposed = false;
  const prep = createGpuPrepClient(deps.createPrepWorker ?? defaultPrepWorker);
  prepClient = prep;
  referenceClient = createGpuPrepClient(deps.createPrepWorker ?? defaultPrepWorker);

  function makeGpuConsumer(): GpuBatchConsumer {
    let reconvolveImpl: ReturnType<typeof makeReconvolve> | null = null;
    const consumer = createGpuBatchConsumer({
      groupBudgetBytes: deps.groupBudgetBytes,
      memoryBudgetBytes: deps.memoryBudgetBytes,
      async createEngine({ maxGroupBytes }) {
        const probed = await (deps.probeAdapter ?? defaultProbeAdapter)();
        const soft = softwareAdapterReason(probed);
        if (soft) throw new Error(`${soft}; the GPU path is for hardware adapters only`);
        const mod = await (deps.loadGpuModule ?? (() => import('@calab/compute-gpu')))();
        reconvolveImpl = makeReconvolve(mod.computeBandedParams);
        const device = await mod.requestGpuDevice();
        if (!device) throw new Error('no WebGPU adapter or device');
        const info = device.adapterInfo as AdapterLike | undefined;
        const soft2 = softwareAdapterReason(info);
        if (soft2) {
          device.destroy();
          throw new Error(`${soft2}; the GPU path is for hardware adapters only`);
        }
        const adapter =
          [info?.vendor, info?.architecture].filter(Boolean).join(' / ') || 'unknown adapter';
        void device.lost.then((l) => {
          if (!disposed)
            consumer.fail(`GPU device lost (${l.reason}): ${l.message || 'no message'}`);
        });
        device.onuncapturederror = (e) => consumer.fail(`GPU error: ${e.error.message}`);
        const fista = await mod.createGpuFista(device, { maxGroupBytes });
        setBackendStatus((s) => ({ ...s, active: 'webgpu', adapter }));
        return {
          // load() is async and wraps every allocation, upload and bind group
          // in its own out-of-memory + validation error scopes, awaiting both
          // pops before it resolves; it rejects with GpuOutOfMemoryError (also
          // for validation errors that follow an OOM). The consumer serializes
          // engine calls, so no other device work interleaves with the scopes.
          load: (...a) => fista.load(...a),
          step: (n) => fista.step(n),
          readSolutionsFor: (cells, o) => fista.readSolutionsFor(cells, o),
          get groupCount() {
            return fista.groupCount;
          },
          maxTraceLength: fista.maxTraceLength,
          estimateBytes: fista.estimateBytes ? (n, T) => fista.estimateBytes!(n, T) : undefined,
          adapter,
          destroy() {
            fista.destroy();
            device.destroy();
          },
        };
      },
      // CaTune's preprocessing always ends with subtract_baseline, which pins
      // the solver's baseline to 0 (`filtered` in Rust); constraint nonneg.
      filtered: true,
      constraint: 'nonneg',
      prepare: (tile) =>
        Promise.all(
          tile.traces.map((t, k) =>
            prep.workingTrace(tile.cells[k], tile.windowStart, t, tile.params),
          ),
        ),
      reconvolve: (s, w, p, prev) => reconvolveImpl!(s, w, p, prev),
      participate(tile) {
        // The prep cache is keyed by cell; a tile without a cell index goes to WASM.
        if (tile.cells.some((c) => c < 0)) return 'tile has no cell index (prep cache key)';
        if (gate !== 'auto') return null;
        return gpuParticipationVerdict(calibrations.get('webgpu'), calibrations.get('wasm-pool'));
      },
      quantum: { targetMs: 100, initialIterations: 20 },
      onStats: setGpuStats,
      onCalibration(cal) {
        calibrations.record(cal);
        updateVerdict();
      },
    });
    return consumer;
  }

  /** The GPU is out for good: give the WASM pool all its workers. */
  function upgradeWasmPool(): void {
    if (wasmUpgraded || disposed) return;
    wasmUpgraded = true;
    const full = poolConsumer(makeWasmPool(fullPoolSize));
    scheduler.addConsumer(full);
    scheduler.removeConsumer(wasm); // its in-flight tiles are re-queued to `full`
    wasm = full;
    setBackendStatus((s) => ({ ...s, wasmWorkers: fullPoolSize }));
  }

  const scheduler = createTileScheduler({
    consumers: [wasm],
    onConsumerFailed(c, reason) {
      if (c !== gpu || disposed) return;
      gpu = null;
      const lost = reason.startsWith('GPU device lost');
      if (lost && reacquireLeft > 0) {
        reacquireLeft--;
        console.warn(`[solver-backend] ${reason}; re-acquiring the GPU once`);
        setBackendStatus((s) => ({ ...s, active: 'webgpu (starting)', reason }));
        gpu = makeGpuConsumer();
        scheduler.addConsumer(gpu, 0);
        return;
      }
      console.warn(`[solver-backend] ${reason}; falling back to the WASM worker pool`);
      setBackendStatus((s) => ({ ...s, active: 'wasm-pool', reason }));
      upgradeWasmPool();
    },
    onSkipped(_tile, c, reason) {
      if (c !== gpu) return;
      setBackendStatus((s) => (s.reason === reason ? s : { ...s, reason }));
    },
  });

  if (unavailable) {
    setBackendStatus({
      requested,
      active: 'wasm-pool',
      reason: `WebGPU unavailable: ${unavailable}`,
      wasmWorkers: fullPoolSize,
    });
  } else {
    setBackendStatus({ requested, active: 'webgpu (starting)', wasmWorkers: reducedSize });
    gpu = makeGpuConsumer();
    scheduler.addConsumer(gpu, 0);
  }

  return {
    size: fullPoolSize,
    dispatch: (job) => scheduler.submit(jobToTile(job)),
    cancel: (id) => scheduler.cancel(id),
    cancelAll: () => scheduler.cancelAll(),
    dispose() {
      disposed = true;
      scheduler.dispose();
      prep.dispose();
      if (prepClient === prep) prepClient = null;
      referenceClient?.dispose();
      referenceClient = null;
    },
  };
}
