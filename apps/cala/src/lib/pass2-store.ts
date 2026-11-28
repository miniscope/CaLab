/**
 * The Extract stage (docs/stages.md), on the main thread: with the final cell library, extract the traces of every
 * frame from the recording on disk, footprints frozen.
 *
 * The recording is walked again through the same three workers as Discover,
 * but nothing is estimated: the frame worker replays the flicker Discover
 * recorded (`Preprocessor.frontFramesReplay`), the motion worker warps by the
 * recorded shifts (the GPU warp when Discover used it), and the trace worker solves every
 * frame with the final library from frame 0. Background and noise restart from
 * the calibrated state (calibration is a pure function of the first frames,
 * so it is recomputed identically) and are rebuilt by the same frames in the
 * same order, which gives the same state Discover had at each frame: that is why
 * no checkpoints are needed when the whole recording is replayed.
 *
 * The one deliberate difference is the sensor flat field: Discover switches
 * from uncorrected to corrected frames when its first map arrives (and refines
 * it after); Extract applies Discover's newest map from frame 0, so the whole
 * recording is corrected the same way.
 *
 * Traces go straight to a `TraceFile` (trace-file.ts), and the signed
 * (unclipped) traces of the same solve to a second one: frame-major (frames x
 * cells) because batches arrive in frame order, in a file in the origin
 * private file system, so memory stays at a few batches whatever the
 * recording length (only disk quota limits it). The export streams from that
 * file. Without OPFS the matrix is held in memory, up to 1.5 GB.
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import { MAX_IN_FLIGHT, ThroughputMeter, type PipelineStore } from './pipeline-store.ts';
import { createTraceFile, type TraceFile } from './trace-file.ts';
import type { LibraryView } from '../workers/slow-types.ts';
import type { FovProjections } from './fov-projection.ts';
import { startReplayPipeline } from './replay-pipeline.ts';
import type { FactorInfo } from './compress-store.ts';
import type { FactorExtractPort, FactorJob } from './factor-extract.ts';
import { errMsg } from './errors.ts';

export type Pass2Status = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * Why Discover's record cannot be replayed by Extract (null: it can):
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

/** What Extract produced. */
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
  /**
   * Extract solved frames rebuilt from the factors (`?factors`, `?factors=file`),
   * with which factors; or, on a `?factors=file` recording, replayed the file
   * (`sourceReason` says why).
   */
  source?: 'factors' | 'file';
  sourceReason?: string;
  factors?: FactorInfo;
  /** Extract on factors through the extractor: windows solved from the factors and on rebuilt frames, and its helpers. */
  extractor?: { projected: number; rebuilt: number; workers: number };
}

export function createPass2Store(
  client: PipelineClient,
  pipeline: PipelineStore,
  cells: CellStore,
  clock: () => number = () => performance.now(),
  /** A `?factors` stream's factors: Extract solves on them in the compress worker (absent: never). */
  factors?: FactorExtractPort,
) {
  const [status, setStatus] = createSignal<Pass2Status>('idle');
  const [processed, setProcessed] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<Pass2Result | null>(null);
  const [motionBackend, setMotionBackend] = createSignal<string | null>(null);
  /** Why a factor run waits (the compressor is not done), or null. */
  const [waiting, setWaiting] = createSignal<string | null>(null);
  /** A `?factors=file` run replays the file: why (the factors were not ready), or null. */
  const [fileReason, setFileReason] = createSignal<string | null>(null);

  let generation = 0;
  /** The trace files of the current run or result (deleted when replaced or cleared). */
  let file: TraceFile | null = null;
  let signedFile: TraceFile | null = null;
  /** The job in the compress worker, and whether the current run is a factor run (cancel needs the pipeline for a replay only). */
  let factorJob: FactorJob | null = null;
  let factorMode = false;

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
    // A factor run reads no file, so no record to replay; it waits for the factors itself.
    const replay =
      factors?.active() || (factors?.mode?.() === 'file' && factors.state() === 'ready')
        ? null
        : replayBlocked(pipeline);
    if (replay) return replay;
    if (!cells.library() || !cells.libraryBytes()) return 'No cells were found.';
    if ((cells.library()?.ids.length ?? 0) === 0) return 'No cells were found.';
    if (!cells.status()?.final) return 'Waiting for the final library.';
    return null;
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
        const c = step.cells;
        if (!c || c.ids.length !== ctx.cellCount || c.ids.some((id, i) => id !== ctx.ids[i]))
          throw new Error('Extract got no traces for the final library.');
        ctx.traces.append(step.start, c.traces);
        if (ctx.signed) {
          if (c.signed && c.signed.length === c.traces.length) {
            ctx.signed.append(step.start, c.signed);
          } else {
            // A solver without signed traces: the export keeps the clipped ones only.
            console.warn('Extract: the solver returned no signed traces; exporting clipped only.');
            const s = ctx.signed;
            ctx.signed = null;
            signedFile = null;
            void s.dispose().catch(() => {});
          }
        }
        ctx.done = step.start + step.count;
        setProcessed(ctx.done);
        setFps(ctx.meter.record(clock(), step.count));
        if (step.stageBusyMs) {
          ctx.busy = step.stageBusyMs.map((v, i) => (ctx.busy[i] ?? 0) + v);
          setStageBusy(ctx.busy.map((v) => v / ctx.done));
        }
        setMotionBackend(step.motionBackend ?? null);
        // Backpressure: the pump asks for the next step only after this returns.
        await ctx.traces.drained();
        await ctx.signed?.drained();
        return;
      }
      case 'done':
        if (exhausted) return;
        exhausted = true;
        if (ctx.done !== ctx.frames)
          throw new Error(`Extract ended after ${ctx.done} of ${ctx.frames} frames.`);
        await ctx.traces.finish();
        await ctx.signed?.finish();
        if (gen !== generation) return;
        setResult({
          ids: ctx.ids,
          traces: ctx.traces,
          signed: ctx.signed,
          frames: ctx.frames,
          cells: ctx.cellCount,
          version: ctx.library.version,
          library: ctx.library,
          seconds: (clock() - ctx.t0) / 1000,
          ...(fileReason() !== null
            ? { source: 'file' as const, sourceReason: fileReason()! }
            : {}),
          ...(step.projection ? { projection: step.projection } : {}),
        });
        setStatus('done');
        return;
    }
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
          generation++;
          setError(errMsg(err));
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
   * Re-extract every recorded frame with the final library (or `use`, a
   * library published earlier: lets a run be compared with Discover, which
   * solved its last frames with an earlier version than the final one).
   */
  async function run(use?: { library: LibraryView; bytes: Uint8Array }): Promise<void> {
    const mode = factors?.mode?.() ?? (factors?.active() ? 'stream' : null);
    // A recording never waits for its factors (the factors when ready, else the file).
    factorMode = mode === 'stream' || (mode === 'file' && factors!.state() === 'ready');
    setFileReason(
      mode === 'file' && !factorMode ? (factors!.blocked() ?? 'The factors cannot be read.') : null,
    );
    if (factors && factorMode) return runFactors(factors);
    const reason = blockedReason();
    if (reason) {
      setError(reason);
      setStatus('error');
      return;
    }
    const gen = ++generation;
    inFlight = 0;
    exhausted = false;
    setStatus('running');
    setError(null);
    await discard();
    setProcessed(0);
    setFps(0);
    setStageBusy([]);
    setMotionBackend(null);
    const plan1 = pipeline.plan() as PipelinePlan;
    const rec = pipeline.record();
    const library = use?.library ?? cells.library()!;
    const bytes = use?.bytes ?? cells.libraryBytes()!;
    const frames = rec.frames;
    const flatMap = pipeline.flatFieldMap();
    const cellCount = library.ids.length;
    setTotal(frames);
    let traces: TraceFile | undefined;
    let signed: TraceFile;
    try {
      // `?pass2=memory` keeps the matrix in memory (the no-OPFS path), for measurements.
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
      setError(errMsg(err));
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
    };
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
        },
        { frames, record: rec, flatField: flatMap },
      );
      if (gen !== generation) return;
      ctx.t0 = clock();
      pump(gen, ctx);
    } catch (err) {
      if (gen !== generation) return;
      generation++;
      setError(errMsg(err));
      setStatus('error');
    }
  }

  /** Extract on a live stream's factors: wait for `ready`, then one job in the compress worker. */
  async function runFactors(port: FactorExtractPort): Promise<void> {
    const reason = blockedReason();
    if (reason) {
      setError(reason);
      setStatus('error');
      return;
    }
    const gen = ++generation;
    setStatus('running');
    setError(null);
    await discard();
    if (gen !== generation) return;
    setProcessed(0);
    setFps(0);
    while (port.state() === 'compressing') {
      setWaiting(port.blocked());
      await port.changed();
      if (gen !== generation) return;
    }
    setWaiting(null);
    const info = port.info();
    if (port.state() !== 'ready' || !info) {
      generation++;
      setError(port.blocked() ?? 'The factors cannot be read.');
      setStatus('error');
      return;
    }
    const library = cells.library()!;
    const bytes = cells.libraryBytes()!;
    const n = library.ids.length;
    setTotal(info.frames);
    let traces: TraceFile;
    let signed: TraceFile | null;
    try {
      traces = await createTraceFile(info.frames, n, { extraBytes: info.frames * n * 4 });
      signed = await createTraceFile(info.frames, n, {});
    } catch (err) {
      if (gen !== generation) return;
      generation++;
      setError(errMsg(err));
      setStatus('error');
      return;
    }
    file = traces;
    signedFile = signed;
    let failure: Error | null = null;
    const t0 = clock();
    const job = port.run(library.version, bytes, (start, count, ids, tr, sg) => {
      if (gen !== generation || failure) return;
      if (ids.length !== n || ids.some((id, i) => id !== library.ids[i])) {
        // Thrown here it would land in the compress store's message handler: end the job instead.
        failure = new Error('Extract got no traces for the final library.');
        factorJob?.cancel();
        return;
      }
      traces.append(start, tr);
      if (signed && sg && sg.length === tr.length) signed.append(start, sg);
      else if (signed) {
        // A solver without signed traces: the export keeps the clipped ones only.
        console.warn('Extract: the solver returned no signed traces; exporting clipped only.');
        const s = signed;
        signed = null;
        signedFile = null;
        void s.dispose().catch(() => {});
      }
      setProcessed(start + count);
    });
    factorJob = job;
    try {
      const ended = await job.done.catch((err: unknown) => {
        throw failure ?? err;
      });
      await traces.finish();
      if (signed) await signed.finish();
      if (gen !== generation) return;
      setResult({
        ids: library.ids.slice(),
        traces,
        signed,
        frames: info.frames,
        cells: n,
        version: library.version,
        library,
        seconds: (clock() - t0) / 1000,
        source: 'factors',
        factors: info,
        ...(ended.projected !== undefined && ended.rebuilt !== undefined
          ? {
              extractor: {
                projected: ended.projected,
                rebuilt: ended.rebuilt,
                workers: ended.workers ?? 1,
              },
            }
          : {}),
      });
      setStatus('done');
    } catch (err) {
      if (gen !== generation) return;
      generation++;
      setError(errMsg(err));
      setStatus('error');
      void discard();
    } finally {
      factorJob = null;
    }
  }

  /** Stop a running Extract (its partial traces are dropped). */
  function cancel(): void {
    if (status() !== 'running') return;
    generation++;
    inFlight = 0;
    setStatus('cancelled');
    setWaiting(null);
    void discard();
    // A factor run (waiting or solving) has no replay pipeline to stop.
    if (factorMode) factorJob?.cancel();
    else void client.stopPipeline().catch(() => {});
  }

  /** Forget the result (Discover restarted, or another recording opened). */
  function clear(): void {
    if (status() === 'running') generation++;
    factorJob?.cancel();
    setWaiting(null);
    setFileReason(null);
    setStatus('idle');
    void discard();
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
    /** A factor run waits for the compressor: why (null: not waiting). */
    waiting,
    fileReason,
    blockedReason,
    /** The trace file of the current run (for measurements). */
    traceFile: () => file,
    run,
    cancel,
    clear,
  };
}

export type Pass2Store = ReturnType<typeof createPass2Store>;
