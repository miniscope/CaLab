/**
 * The Extract stage (docs/stages.md; "pass 2" in the code's older names), on
 * the main thread: with the final cell library, extract the traces of every
 * frame from the recording on disk, footprints frozen.
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
 * The one deliberate difference is the sensor flat field: pass 1 switched from
 * uncorrected to corrected frames when its first map arrived (and refined it
 * after); pass 2 applies pass 1's newest map from frame 0, so the whole
 * recording is corrected the same way. Nothing is estimated in pass 2.
 *
 * Traces go straight to a `TraceFile` (trace-file.ts), and the signed
 * (unclipped) traces of the same solve to a second one: frame-major (frames x
 * cells) because batches arrive in frame order, in a file in the origin
 * private file system, so memory stays at a few batches whatever the
 * recording length (only disk quota limits it). The export streams from that
 * file. Without OPFS the matrix is held in memory, up to 1.5 GB.
 *
 * With compression on (`factors`), Extract reads the run's factors once they
 * are ready (`FactorState`): the compress worker solves every window with the
 * final library (`FactorExtractor`, signed traces too) and the traces go to
 * the same files; the FOV images come from the replay that made the factors.
 * Otherwise it replays the file, and that replay compresses the frames on the
 * offset grids when no factors exist yet. After a factor Extract fails, every
 * later Extract replays the file until `clear` (`factorsFailed`).
 *
 * Unlike the replay, a factor Extract has no backpressure: the worker sends
 * one message per window and each is queued for writing as it arrives, so
 * nothing bounds the write queue when the worker solves faster than the disk
 * writes. A per-window acknowledgement in the extract protocol is planned.
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import { MAX_IN_FLIGHT, ThroughputMeter, type PipelineStore } from './pipeline-store.ts';
import { createTraceFile, type TraceFile } from './trace-file.ts';
import type { LibraryView } from '../workers/slow-types.ts';
import type { FovProjections } from './fov-projection.ts';
import type { CompressTiling } from '../workers/compress-types.ts';
import {
  endOnce,
  ExtractAborted,
  NO_COMPRESS,
  type FactorWindowTraces,
  type Pass2Factors,
  type ReplayCompress,
} from './factor-extract.ts';
import { startReplayPipeline } from './replay-pipeline.ts';

export type Pass2Status = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * Why Discover's record cannot be replayed by Refine or Extract (null: it can):
 * no frames, a gap in the motion record, or too short for the calibration.
 */
export function replayBlocked(pipeline: Pick<PipelineStore, 'record' | 'plan'>): string | null {
  const rec = pipeline.record();
  const plan = pipeline.plan();
  if (!plan || rec.frames < 1) return 'Discover recorded no frames.';
  if (!rec.complete) return 'Discover has a gap in its motion record.';
  if (rec.frames < Math.max(plan.calibrationFrames, plan.motionWarmupFrames))
    return 'Discover stopped before the calibration frames; let it run longer.';
  return null;
}

/** What pass 2 produced. */
export interface Pass2Result {
  /** Cell ids in column order of `traces`. */
  ids: Uint32Array;
  /** `frames x cells`, frame after frame (as the solver emits them), on disk or in memory. */
  traces: TraceFile;
  /**
   * The signed (unclipped) traces of the same solve, laid out as `traces`:
   * each trace plus the residual's projection on the cell (CNMF's `C + YrA`),
   * so a quiet cell sits at 0 with symmetric noise where `traces` is clipped
   * at 0. What CaDecon gets. Null when the solver returned none.
   */
  signed: TraceFile | null;
  frames: number;
  cells: number;
  /** Library version solved with, and the library itself (footprints for the export). */
  version: number;
  library: LibraryView;
  /** Wall time of the whole pass, s. */
  seconds: number;
  /** Mean and max projections of every frame (absent: the workers kept none). */
  projection?: FovProjections;
  /** Where Extract read the frames: the recording or the factors (absent: the recording; older code). */
  source?: 'raw' | 'factors';
  /** From the factors: their tiling and mean rank per tile. */
  tiling?: CompressTiling;
  meanRank?: number;
  /**
   * From the factors: each cell's smallest valid share over the windows, in
   * the column order of `traces` (1: every pixel of its support had data in
   * every frame). Absent for a replay of the file.
   */
  minValid?: Float32Array;
  /** From the factors: whose they are (`replay`: a file's compression replay; `discover`: a live run's own). */
  factors?: 'replay' | 'discover';
}

export function createPass2Store(
  client: PipelineClient,
  pipeline: PipelineStore,
  cells: CellStore,
  clock: () => number = () => performance.now(),
  /** Another stage's reason to wait (a Refine run going on), checked after Discover's. */
  blocked?: () => string | null,
  /**
   * Compression on: the run's factors. Extract reads them once they are
   * ready; else it replays the file, which compresses when there are none
   * yet. Absent (`?compress=off`): Extract replays the file, as before.
   */
  factors?: Pass2Factors,
) {
  const [status, setStatus] = createSignal<Pass2Status>('idle');
  const [processed, setProcessed] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<Pass2Result | null>(null);
  const [motionBackend, setMotionBackend] = createSignal<string | null>(null);
  const [source, setSource] = createSignal<'raw' | 'factors'>('raw');
  /**
   * The last Extract on the factors failed (a job error, a gap or overlap, a
   * compression error; not a cancel, not an abort by a reset): every later
   * Extract replays the file instead of failing the same way again. Only
   * `clear` resets it: the Run panel calls it whenever a Discover starts (a
   * new Discover, another recording, a session of a multi-session run), and
   * the app calls it for a Refine run while an Extract result exists.
   */
  const [factorsFailed, setFactorsFailed] = createSignal(false);

  let generation = 0;
  /** The trace files of the current run or result (deleted when replaced or cleared). */
  let file: TraceFile | null = null;
  let signedFile: TraceFile | null = null;
  /** The running run (null between runs and before its trace files exist). */
  let current: Ctx | null = null;

  /** Drop the result and delete its trace files. */
  async function discard(): Promise<void> {
    setResult(null);
    const f = [file, signedFile];
    file = null;
    signedFile = null;
    for (const x of f) if (x) await x.dispose().catch(() => {});
  }

  let inFlight = 0;
  let exhausted = false;

  /** Why Extract cannot run now (null: it can). */
  function blockedReason(): string | null {
    if (status() === 'running') return 'Extract is running.';
    const st = pipeline.status();
    if (st === 'running' || st === 'paused' || st === 'starting')
      return 'Extract runs after Discover finishes.';
    if (st !== 'done') return 'Extract runs after Discover finishes.';
    const other = blocked?.();
    if (other) return other;
    const replay = replayBlocked(pipeline);
    if (replay) return replay;
    if (!cells.library() || !cells.libraryBytes()) return 'No cells were found.';
    if ((cells.library()?.ids.length ?? 0) === 0) return 'No cells were found.';
    if (!cells.status()?.final) return 'Waiting for the final library.';
    return null;
  }

  /**
   * Store the traces of frames [start, start + count), a replay's batch or a
   * factor window: the ids must be the final library's. Without signed traces
   * the export keeps the clipped ones only.
   */
  function storeTraces(
    ctx: Ctx,
    start: number,
    count: number,
    c: { ids: Uint32Array; traces: Float32Array; signed?: Float32Array } | undefined,
  ): void {
    if (!c || c.ids.length !== ctx.cellCount || c.ids.some((id, i) => id !== ctx.ids[i]))
      throw new Error('Extract got no traces for the final library.');
    ctx.traces.append(start, c.traces);
    if (ctx.signed) {
      if (c.signed && c.signed.length === c.traces.length) {
        ctx.signed.append(start, c.signed);
      } else {
        // A solver without signed traces: the export keeps the clipped ones only.
        console.warn('Extract: the solver returned no signed traces; exporting clipped only.');
        const s = ctx.signed;
        ctx.signed = null;
        signedFile = null;
        void s.dispose().catch(() => {});
      }
    }
    ctx.done = start + count;
  }

  /** Backpressure: wait until the disk has caught up. */
  async function drained(ctx: Ctx): Promise<void> {
    await ctx.traces.drained();
    await ctx.signed?.drained();
  }

  async function handle(
    step: Awaited<ReturnType<PipelineClient['stepPipeline']>>,
    ctx: Ctx,
    gen: number,
  ): Promise<void> {
    switch (step.kind) {
      case 'setup':
        return;
      case 'batch': {
        storeTraces(ctx, step.start, step.count, step.cells);
        setProcessed(ctx.done);
        setFps(ctx.meter.record(clock(), step.count));
        if (step.stageBusyMs) {
          ctx.busy = step.stageBusyMs.map((v, i) => (ctx.busy[i] ?? 0) + v);
          setStageBusy(ctx.busy.map((v) => v / ctx.done));
        }
        setMotionBackend(step.motionBackend ?? null);
        // The pump asks for the next step only after this returns.
        await drained(ctx);
        return;
      }
      case 'done':
        if (exhausted) return;
        exhausted = true;
        if (ctx.done !== ctx.frames)
          throw new Error(`Extract ended after ${ctx.done} of ${ctx.frames} frames.`);
        // Every frame went to the compress worker: these are the factors' FOV images.
        if (ctx.compressed && step.projection) factors?.keepProjection(step.projection);
        ctx.ended(true);
        await ctx.traces.finish();
        await ctx.signed?.finish();
        if (gen !== generation) return;
        setResult(
          resultOf(ctx, {
            ...(step.projection ? { projection: step.projection } : {}),
            source: 'raw',
          }),
        );
        setStatus('done');
        return;
    }
  }

  /** The result of a finished run; `extra`: what depends on where it read the frames. */
  function resultOf(
    ctx: Ctx,
    extra: Pick<Pass2Result, 'projection' | 'source' | 'tiling' | 'meanRank' | 'minValid'>,
  ): Pass2Result {
    return {
      ids: ctx.ids,
      traces: ctx.traces,
      signed: ctx.signed,
      frames: ctx.frames,
      cells: ctx.cellCount,
      version: ctx.library.version,
      library: ctx.library,
      seconds: (clock() - ctx.t0) / 1000,
      ...extra,
    };
  }

  interface Ctx {
    frames: number;
    cellCount: number;
    ids: Uint32Array;
    traces: TraceFile;
    signed: TraceFile | null;
    library: LibraryView;
    meter: ThroughputMeter;
    busy: number[];
    done: number;
    t0: number;
    /** The replay feeds the compress worker (its projections are the factors' FOV images). */
    compressed: boolean;
    /** The replay ended; false: cut short. Reports only the first call. */
    ended: (ok: boolean) => void;
    /** The pump has the replay: its end is reported there, by cancel or by clear; before, by `run`. */
    pumping: boolean;
    /** Stop waiting for the factor job. */
    stopWait: () => void;
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
        .then(async (step) => {
          if (gen === generation) await handle(step, ctx, gen);
        })
        .catch((err: unknown) => {
          if (gen !== generation) return;
          ctx.ended(false);
          generation++;
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
          void discard();
        })
        .finally(() => {
          if (gen !== generation) return;
          inFlight--;
          pump(gen, ctx);
        });
    }
  }

  /**
   * Extract every recorded frame with the final library (or `use`, a library
   * published earlier: lets a run be compared with pass 1, which solved its
   * last frames with an earlier version than the final one). From the
   * factors when they are ready, else by replaying the file. Resolves once
   * the replay has started (the pump runs on), or once Extract on the
   * factors has ended, failed or been cancelled.
   */
  async function run(
    use?: { library: LibraryView; bytes: Uint8Array },
    /** `raw`: replay the file even when the factors are ready (measurements). */
    from: 'auto' | 'raw' = 'auto',
  ): Promise<void> {
    const reason = blockedReason();
    if (reason) {
      setError(reason);
      setStatus('error');
      return;
    }
    const gen = ++generation;
    inFlight = 0;
    exhausted = false;
    current = null;
    const rec = pipeline.record();
    const frames = rec.frames;
    const state = factors?.state(frames) ?? 'none';
    // After a failed factor Extract the file is replayed, so a repeating failure is no dead end.
    const onFactors =
      factors !== undefined && from === 'auto' && state === 'ready' && !factorsFailed();
    // Before the first await: a cancel from here on knows whether a pipeline runs.
    setSource(onFactors ? 'factors' : 'raw');
    setStatus('running');
    setError(null);
    await discard();
    setProcessed(0);
    setFps(0);
    setStageBusy([]);
    setMotionBackend(null);
    const plan1 = pipeline.plan() as PipelinePlan;
    const library = use?.library ?? cells.library()!;
    const bytes = use?.bytes ?? cells.libraryBytes()!;
    const flatMap = pipeline.flatFieldMap();
    const cellCount = library.ids.length;
    setTotal(frames);
    let traces: TraceFile | undefined;
    let signed: TraceFile;
    try {
      // `?pass2=memory` keeps the matrix in memory (the pre-OPFS behaviour), for measurements.
      const forceMemory =
        typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('pass2') === 'memory';
      // Room for both matrices is checked up front (the signed one is the same size).
      traces = await createTraceFile(frames, cellCount, {
        forceMemory,
        extraBytes: frames * cellCount * 4,
      });
      signed = await createTraceFile(frames, cellCount, { forceMemory });
    } catch (err) {
      void traces?.dispose();
      if (gen !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      return;
    }
    if (gen !== generation) {
      void traces.dispose();
      void signed.dispose();
      return;
    }
    file = traces;
    signedFile = signed;
    const ctx: Ctx = {
      frames,
      cellCount,
      ids: library.ids.slice(),
      traces,
      signed,
      library,
      meter: new ThroughputMeter(),
      busy: [],
      done: 0,
      t0: clock(),
      compressed: false,
      ended: NO_COMPRESS.ended,
      pumping: false,
      stopWait: () => {},
    };
    current = ctx;
    if (onFactors && factors) {
      await runOnFactors(gen, ctx, factors, bytes);
      return;
    }
    // The first replay after Discover compresses, when no factors exist yet.
    const comp: ReplayCompress =
      factors && state === 'none' ? factors.replayCompress(frames) : NO_COMPRESS;
    ctx.compressed = comp.settings.compress === true;
    ctx.ended = endOnce(comp.ended);
    try {
      await startReplayPipeline(
        client,
        plan1,
        {
          session: 0,
          discover: false,
          library: bytes,
          signed: true,
          projection: true,
          ...comp.settings,
        },
        { frames, record: rec, flatField: flatMap },
      );
      if (gen !== generation) return;
      ctx.t0 = clock();
      ctx.pumping = true;
      pump(gen, ctx);
    } catch (err) {
      if (gen !== generation) return;
      generation++;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      // Until the pump has the replay, its end is here: a throw or a stop while starting cuts it short.
      if (!ctx.pumping) ctx.ended(false);
    }
  }

  /**
   * Extract on factors: the compress worker solves every window with the
   * final library. Each window is queued for this run's trace files as it
   * arrives; nothing bounds that queue (no backpressure in the extract
   * protocol yet). The files become the result only when the job answers,
   * and a job that fails deletes them.
   */
  async function runOnFactors(
    gen: number,
    ctx: Ctx,
    f: Pass2Factors,
    bytes: Uint8Array,
  ): Promise<void> {
    let broken = false;
    // Kept here, not in the context: a failed job leaves none of it.
    let minValid: Float32Array | null = null;
    let breakJob: (err: unknown) => void = () => {};
    // A bad window ends the run at once; the job's later windows are dropped.
    const badWindow = new Promise<never>((_, reject) => (breakJob = reject));
    const take = (w: FactorWindowTraces): void => {
      if (gen !== generation || broken) return;
      try {
        if (w.start > ctx.done)
          throw new Error(
            `Extract on factors has no traces for frames ${ctx.done} to ${w.start - 1}.`,
          );
        if (w.start < ctx.done) throw new Error(`Extract on factors got frame ${w.start} twice.`);
        if (w.minValid.length !== ctx.cellCount)
          throw new Error('Extract on factors got no valid shares for the final library.');
        storeTraces(ctx, w.start, w.count, w);
        if (!minValid) minValid = w.minValid.slice();
        else
          for (let i = 0; i < minValid.length; i++)
            minValid[i] = Math.min(minValid[i], w.minValid[i]);
      } catch (err) {
        broken = true;
        breakJob(err);
        return;
      }
      setProcessed(ctx.done);
      setFps(ctx.meter.record(clock(), w.count));
    };
    // Cancel and clear stop the wait: the job runs on in the worker, and the
    // compress store drops its late messages.
    const stopped = new Promise<null>((resolve) => (ctx.stopWait = () => resolve(null)));
    try {
      const job = await Promise.race([f.extract(bytes, take), stopped, badWindow]);
      if (job === null || gen !== generation) return;
      await drained(ctx);
      if (gen !== generation) return;
      if (ctx.done !== ctx.frames)
        throw new Error(`Extract on factors ended after ${ctx.done} of ${ctx.frames} frames.`);
      await ctx.traces.finish();
      await ctx.signed?.finish();
      if (gen !== generation) return;
      const info = f.info();
      const projection = f.projection();
      setResult(
        resultOf(ctx, {
          ...(projection ? { projection } : {}),
          source: 'factors',
          ...(info ? { tiling: info.tiling, meanRank: info.meanRank } : {}),
          ...(minValid ? { minValid } : {}),
        }),
      );
      setStatus('done');
    } catch (err) {
      if (gen !== generation) return;
      // Later windows of this job see a stale generation and write nothing.
      generation++;
      // A reset by a new run is no failure of the factors; anything else is.
      if (!(err instanceof ExtractAborted)) setFactorsFailed(true);
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      // The job's windows are in this run's files only: deleting them leaves nothing.
      void discard();
    }
  }

  /** The running run stops early: its replay is cut short, or the wait for its job ends. */
  function endRun(): void {
    if (current?.pumping) current.ended(false);
    current?.stopWait();
    current = null;
  }

  /**
   * Stop a running Extract (its partial traces are dropped). A replay is
   * stopped in the workers. On the factors no pipeline runs: only the wait
   * for the job stops.
   */
  function cancel(): void {
    if (status() !== 'running') return;
    const replay = source() === 'raw';
    generation++;
    inFlight = 0;
    setStatus('cancelled');
    endRun();
    void discard();
    if (replay) void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  /** Forget the result (pass 1 restarted, or another recording opened). */
  function clear(): void {
    if (status() === 'running') {
      generation++;
      endRun();
    }
    setStatus('idle');
    void discard();
    setFactorsFailed(false);
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
    source,
    factorsFailed,
    blockedReason,
    /** The trace file of the current run (for measurements). */
    traceFile: () => file,
    run,
    cancel,
    clear,
  };
}

export type Pass2Store = ReturnType<typeof createPass2Store>;
