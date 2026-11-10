/**
 * Pass 2, on the main thread: with the final cell library, re-extract the
 * traces of every frame from the recording on disk.
 *
 * The recording is walked again through the same three workers as pass 1, but
 * nothing is estimated: the frame worker replays the flicker pass 1 recorded
 * (`Preprocessor.frontFramesReplay`), the motion worker warps by the recorded
 * shifts (the GPU warp when pass 1 used it), and the trace worker solves every
 * frame with the final library from frame 0. Background and noise restart from
 * the calibrated state (calibration is a pure function of the first frames,
 * so it is recomputed identically) and are rebuilt by the same frames in the
 * same order, which gives the same state pass 1 had at each frame: that is why
 * no checkpoints are needed when the whole recording is replayed.
 *
 * Traces are held frame-major in one `Float32Array` (frames x cells) because
 * batches arrive in frame order; `transposeTraces` makes the cells x frames
 * layout the export writes.
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import { MAX_IN_FLIGHT, ThroughputMeter, type PipelineStore } from './pipeline-store.ts';
import type { LibraryView } from '../workers/slow-types.ts';

export type Pass2Status = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/** The largest trace matrix pass 2 holds in memory, bytes. */
export const MAX_PASS2_BYTES = 1_500_000_000;

/** What pass 2 produced. */
export interface Pass2Result {
  /** Cell ids in column order of `traces`. */
  ids: Uint32Array;
  /** `frames x cells`, frame after frame (as the solver emits them). */
  traces: Float32Array;
  frames: number;
  cells: number;
  /** Library version solved with, and the library itself (footprints for the export). */
  version: number;
  library: LibraryView;
  /** Wall time of the whole pass, s. */
  seconds: number;
}

/** `frames x cells` (solver order) to `cells x frames` (row per cell). */
export function transposeTraces(traces: Float32Array, frames: number, cells: number): Float32Array {
  const out = new Float32Array(traces.length);
  for (let f = 0; f < frames; f++) {
    const row = f * cells;
    for (let c = 0; c < cells; c++) out[c * frames + f] = traces[row + c];
  }
  return out;
}

export function createPass2Store(
  client: PipelineClient,
  pipeline: PipelineStore,
  cells: CellStore,
  clock: () => number = () => performance.now(),
) {
  const [status, setStatus] = createSignal<Pass2Status>('idle');
  const [processed, setProcessed] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<Pass2Result | null>(null);
  const [motionBackend, setMotionBackend] = createSignal<string | null>(null);

  let generation = 0;
  let inFlight = 0;
  let exhausted = false;

  /** Why pass 2 cannot run now (null: it can). */
  function blockedReason(): string | null {
    if (status() === 'running') return 'Pass 2 is running.';
    const st = pipeline.status();
    if (st === 'running' || st === 'paused' || st === 'starting') return 'Pass 1 is still running.';
    if (st !== 'done') return 'Run pass 1 first.';
    const rec = pipeline.record();
    const plan = pipeline.plan();
    if (!plan || rec.frames < 1) return 'Pass 1 recorded no frames.';
    if (!rec.complete) return 'Pass 1 has a gap in its motion record.';
    if (rec.frames < Math.max(plan.calibrationFrames, plan.motionWarmupFrames))
      return 'Pass 1 stopped before the calibration frames; let it run longer.';
    if (!cells.library() || !cells.libraryBytes()) return 'No cells were found.';
    if ((cells.library()?.ids.length ?? 0) === 0) return 'No cells were found.';
    if (!cells.status()?.final) return 'Waiting for the final library.';
    return null;
  }

  function handle(step: Awaited<ReturnType<PipelineClient['stepPipeline']>>, ctx: Ctx): void {
    switch (step.kind) {
      case 'setup':
        return;
      case 'batch': {
        const c = step.cells;
        if (!c || c.ids.length !== ctx.cellCount || c.ids.some((id, i) => id !== ctx.ids[i]))
          throw new Error('Pass 2 got no traces for the final library.');
        ctx.traces.set(c.traces, step.start * ctx.cellCount);
        ctx.done = step.start + step.count;
        setProcessed(ctx.done);
        setFps(ctx.meter.record(clock(), step.count));
        if (step.stageBusyMs) {
          ctx.busy = step.stageBusyMs.map((v, i) => (ctx.busy[i] ?? 0) + v);
          setStageBusy(ctx.busy.map((v) => v / ctx.done));
        }
        setMotionBackend(step.motionBackend ?? null);
        return;
      }
      case 'done':
        if (exhausted) return;
        exhausted = true;
        if (ctx.done !== ctx.frames)
          throw new Error(`Pass 2 ended after ${ctx.done} of ${ctx.frames} frames.`);
        setResult({
          ids: ctx.ids,
          traces: ctx.traces,
          frames: ctx.frames,
          cells: ctx.cellCount,
          version: ctx.library.version,
          library: ctx.library,
          seconds: (clock() - ctx.t0) / 1000,
        });
        setStatus('done');
        return;
    }
  }

  interface Ctx {
    frames: number;
    cellCount: number;
    ids: Uint32Array;
    traces: Float32Array;
    library: LibraryView;
    meter: ThroughputMeter;
    busy: number[];
    done: number;
    t0: number;
  }

  function pump(gen: number, ctx: Ctx): void {
    while (
      gen === generation &&
      status() === 'running' &&
      !exhausted &&
      inFlight < (client.maxInFlight ?? MAX_IN_FLIGHT)
    ) {
      inFlight++;
      client
        .stepPipeline()
        .then((step) => {
          if (gen === generation) handle(step, ctx);
        })
        .catch((err: unknown) => {
          if (gen !== generation) return;
          generation++;
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        })
        .finally(() => {
          if (gen !== generation) return;
          inFlight--;
          pump(gen, ctx);
        });
    }
  }

  /**
   * Re-extract every recorded frame with the final library (or `use`, a
   * library published earlier: lets a run be compared with pass 1, which
   * solved its last frames with an earlier version than the final one).
   */
  async function run(use?: { library: LibraryView; bytes: Uint8Array }): Promise<void> {
    const reason = blockedReason();
    if (reason) {
      setError(reason);
      setStatus('error');
      return;
    }
    const gen = ++generation;
    inFlight = 0;
    exhausted = false;
    setError(null);
    setResult(null);
    setProcessed(0);
    setFps(0);
    setStageBusy([]);
    setMotionBackend(null);
    const plan1 = pipeline.plan() as PipelinePlan;
    const rec = pipeline.record();
    const library = use?.library ?? cells.library()!;
    const bytes = use?.bytes ?? cells.libraryBytes()!;
    const frames = rec.frames;
    const cellCount = library.ids.length;
    setTotal(frames);
    if (frames * cellCount * 4 > MAX_PASS2_BYTES) {
      setError(
        `${cellCount} cells x ${frames.toLocaleString()} frames is more traces than fit in memory.`,
      );
      setStatus('error');
      return;
    }
    setStatus('running');
    const ctx: Ctx = {
      frames,
      cellCount,
      ids: library.ids.slice(),
      traces: new Float32Array(frames * cellCount),
      library,
      meter: new ThroughputMeter(),
      busy: [],
      done: 0,
      t0: clock(),
    };
    try {
      // The same plan as pass 1, so calibration and the motion template are the same.
      await client.startPipeline(
        {
          batchSize: plan1.batchSize,
          calibrationFrames: plan1.calibrationFrames,
          motionWarmupFrames: plan1.motionWarmupFrames,
          previewMaxSide: plan1.previewMaxSide,
        },
        { session: 0, discover: false, qc: false, library: bytes },
        { frameCount: frames, ...rec.snapshot() },
      );
      if (gen !== generation) return;
      ctx.t0 = clock();
      pump(gen, ctx);
    } catch (err) {
      if (gen !== generation) return;
      generation++;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  /** Stop a running pass 2 (its partial traces are dropped). */
  function cancel(): void {
    if (status() !== 'running') return;
    generation++;
    inFlight = 0;
    setStatus('cancelled');
    void client.stopPipeline().catch(() => {});
  }

  /** Forget the result (pass 1 restarted, or another recording opened). */
  function clear(): void {
    if (status() === 'running') generation++;
    setStatus('idle');
    setResult(null);
    setError(null);
    setProcessed(0);
    setTotal(0);
    setFps(0);
    setStageBusy([]);
    setMotionBackend(null);
  }

  return {
    status,
    processed,
    total,
    fps,
    stageBusy,
    error,
    result,
    motionBackend,
    blockedReason,
    run,
    cancel,
    clear,
  };
}

export type Pass2Store = ReturnType<typeof createPass2Store>;
