/**
 * The Refine stage (docs/stages.md), on the main thread: replay the recording
 * from frame 0 into the slow loop Discover built, which keeps all its state
 * and may only refine footprints (no adds, absorbs, splits, merges, keep
 * tests or deletions). Repeatable: each run starts from the library the
 * previous one published.
 *
 * The replay is Extract's (`pass2-store`): the recorded motion and flicker,
 * the newest flat-field map from frame 0, the fast loop solving with the
 * final library from frame 0. The difference is that the frames go to the
 * slow loop (`CellsSettings.refine`). The slow loop keeps the newest noise
 * map of Discover. Unlike Discover, no frame is dropped for the slow loop: the
 * next batch is asked for only while the slow loop has at most
 * `REFINE_SLOW_LEAD - 1` batches left to take (a file can wait; a live stream
 * could not), and the fast loop's forward pool never drops (`ForwardPool`
 * lossless).
 *
 * The engine path is the same as qc_eval's `--later-passes refine`
 * (`SlowLoop.setEditScope('refine')`, then the recording again).
 *
 * QC: the replay runs no QC monitor. With `options.qc` the replay's traces
 * (every frame, every cell; Refine keeps the ids) go to a trace file, and
 * before the run reports `done` the QC is recomputed from them over the
 * whole recording, as after Extract (`extract-qc.ts`), and replaces the
 * shown snapshot. Without it the app kept showing the last minute of
 * Discover (the monitor's window) after every Refine.
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import { MAX_IN_FLIGHT, ThroughputMeter, type PipelineStore } from './pipeline-store.ts';
import { footprintChange, perMinute, type StageLog, type StageRun } from './run-stages.ts';
import { RefineTracker, type RefineSample } from './refine-metrics.ts';
import type { LibraryView } from '../workers/slow-types.ts';
import type { QcSnapshot } from './qc.ts';
import { createTraceFile, type TraceFile } from './trace-file.ts';

/** Refine's QC: the QC of the replay's traces (`traces`: frames x cells, ids `ids`). */
export interface RefineQcOptions {
  qc?: (traces: TraceFile, ids: Uint32Array) => Promise<QcSnapshot | null>;
  /** Where the replay's traces go (default `createTraceFile`: OPFS, or memory). */
  traceFile?: (frames: number, cells: number) => Promise<TraceFile>;
}

export type RefineStatus = 'idle' | 'running' | 'finishing' | 'done' | 'error' | 'cancelled';

/** How often to look again while waiting for the slow loop, ms. */
const WAIT_MS = 10;
/**
 * Least wall time between updates of the run's series for the plots, ms.
 * The tracker takes every batch; only handing the plot a copy of the
 * growing series (which rebuilds its history) waits, so the main thread's
 * cost per batch does not grow with the replay.
 */
export const SERIES_EVERY_MS = 250;

/**
 * Batches sent that the slow loop may not have taken yet: the fast pipeline's
 * `MAX_IN_FLIGHT` plus two waiting at the slow worker (one being observed,
 * one queued), so neither side idles while the other works. With one (the
 * first version) the three pipeline stages ran one batch at a time: Refine
 * ran at the sum of their costs instead of the slowest one's, about half
 * Extract's frame rate.
 */
export const REFINE_SLOW_LEAD = MAX_IN_FLIGHT + 2;
/** Forward buffers for Refine: the lead plus one for an ack the trace worker has not read yet. */
export const REFINE_FORWARD_BUFFERS = REFINE_SLOW_LEAD + 1;

export function createRefineStore(
  client: PipelineClient,
  pipeline: PipelineStore,
  cells: CellStore,
  log: StageLog,
  /** Why Refine cannot start now (the stage rules, `stageAvailability`). */
  blocked: () => string | null,
  clock: () => number = () => performance.now(),
  options: RefineQcOptions = {},
) {
  const [status, setStatus] = createSignal<RefineStatus>('idle');
  const [processed, setProcessed] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  /** The current (or last) run's series over its replay; bumped as samples arrive. */
  const [series, setSeries] = createSignal<{
    samples: readonly RefineSample[];
    end: number;
  } | null>(null);

  let generation = 0;
  let inFlight = 0;
  let exhausted = false;

  interface Ctx {
    frames: number;
    batch: number;
    /** The slow loop's run number this replay is (`SlowStatus.run`). */
    run: number;
    before: LibraryView;
    refines0: number;
    meter: ThroughputMeter;
    done: number;
    tracker: RefineTracker;
    /** Clock time of the last series update (`SERIES_EVERY_MS`). */
    seriesAt: number;
    /** The replay's traces for the QC (null: no QC this run). */
    traces: TraceFile | null;
    ids: Uint32Array;
  }

  /** Stop collecting traces for the QC (and free them). */
  function dropTraces(ctx: Ctx, why?: string): void {
    if (why) console.warn(`Refine QC skipped: ${why}`);
    const f = ctx.traces;
    ctx.traces = null;
    if (f) void f.dispose().catch(() => {});
  }

  /** Store one batch of the replay's traces (backpressure: waits for the disk). */
  // The append is synchronous (batches are answered in order and the `done`
  // step must see every batch counted); only the wait for the disk is not.
  function collect(
    ctx: Ctx,
    step: { start: number; cells?: { ids: Uint32Array; traces: Float32Array } },
  ): Promise<void> | undefined {
    const f = ctx.traces;
    if (!f) return undefined;
    const c = step.cells;
    if (!c || c.ids.length !== ctx.ids.length || c.ids.some((id, i) => id !== ctx.ids[i])) {
      dropTraces(ctx, 'the replay solved other cells than the library it started with.');
      return undefined;
    }
    const failed = (err: unknown) =>
      dropTraces(ctx, err instanceof Error ? err.message : String(err));
    try {
      f.append(step.start, c.traces);
    } catch (err) {
      failed(err);
      return undefined;
    }
    return f.drained().catch(failed);
  }

  /** The QC of the whole replay into the cell store (before the run says `done`). */
  async function replayQc(gen: number, ctx: Ctx): Promise<void> {
    const f = ctx.traces;
    if (!f || !options.qc) return;
    try {
      await f.finish();
      const snap = await options.qc(f, ctx.ids);
      if (snap && gen === generation) cells.replaceQc(snap);
    } catch (err) {
      console.warn('Refine QC failed:', err);
    } finally {
      dropTraces(ctx);
    }
  }

  /** Frames of this replay the slow loop has taken (0 until its status says it is on this run). */
  function slowTaken(ctx: Ctx): number {
    const st = cells.status();
    return st && st.run === ctx.run ? (st.consumed ?? st.frame) : 0;
  }

  /**
   * Feed the run's series from the slow loop's newest status and library;
   * the plots get it at most every `SERIES_EVERY_MS` (always with `flush`).
   */
  function sample(ctx: Ctx, flush = false): void {
    const st = cells.status();
    if (!st || st.run !== ctx.run) return;
    const frame = st.frame;
    const lib = cells.library();
    if (lib) ctx.tracker.library(lib, frame);
    ctx.tracker.status(frame, Math.max(0, st.counters.refines - ctx.refines0));
    const now = clock();
    if (!flush && now - ctx.seriesAt < SERIES_EVERY_MS) return;
    ctx.seriesAt = now;
    setSeries({ samples: ctx.tracker.samples().slice(), end: ctx.tracker.time(ctx.frames) });
  }

  /** Close the run in the log with what the slow loop published. */
  function record(ctx: Ctx, outcome: 'done' | 'cancelled' | 'error'): void {
    sample(ctx, true);
    const after = cells.library();
    const st = cells.status();
    const refines = Math.max(0, (st?.counters.refines ?? ctx.refines0) - ctx.refines0);
    const change = after ? footprintChange(ctx.before, after) : { refined: 0, median: null };
    const data: Partial<StageRun> = {
      frames: ctx.done,
      cells: after?.ids.length ?? 0,
      libraryVersion: after?.version ?? 0,
      refines,
      refinesPerMin: perMinute(refines, ctx.done, cells.fps()),
      footprintsRefined: change.refined,
      medianFootprintChange: change.median,
      changeP90: ctx.tracker.summary().changeP90,
      refinedShare: ctx.tracker.summary().refinedShare,
      series: ctx.tracker.samples().slice(),
    };
    log.end('refine', outcome, data);
  }

  /** After the last batch: wait for the slow loop's final library of this run. */
  function awaitFinal(gen: number, ctx: Ctx): void {
    if (gen !== generation) return;
    const st = cells.status();
    if (cells.error()) {
      fail(gen, ctx, `Cell discovery stopped: ${cells.error()}`);
      return;
    }
    if (st && st.run === ctx.run && st.final) {
      record(ctx, 'done');
      void replayQc(gen, ctx).then(() => {
        if (gen === generation) setStatus('done');
      });
      return;
    }
    setTimeout(() => awaitFinal(gen, ctx), WAIT_MS);
  }

  function fail(gen: number, ctx: Ctx | null, message: string): void {
    if (gen !== generation) return;
    generation++;
    setError(message);
    setStatus('error');
    if (ctx) {
      record(ctx, 'error');
      dropTraces(ctx);
    }
    void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  function pump(gen: number, ctx: Ctx): void {
    while (gen === generation && status() === 'running' && !exhausted && inFlight < MAX_IN_FLIGHT) {
      // At most REFINE_SLOW_LEAD batches ahead of the slow loop (nothing is dropped).
      if (ctx.done + (inFlight + 1) * ctx.batch - slowTaken(ctx) > REFINE_SLOW_LEAD * ctx.batch) {
        if (inFlight === 0) setTimeout(() => pump(gen, ctx), WAIT_MS);
        return;
      }
      inFlight++;
      client
        .stepPipeline()
        .then(async (step) => {
          if (gen !== generation) return;
          if (step.kind === 'batch') {
            const stored = collect(ctx, step);
            ctx.done = step.start + step.count;
            sample(ctx);
            setProcessed(ctx.done);
            setFps(ctx.meter.record(clock(), step.count));
            // Backpressure: the next batch is asked for once the disk has caught up.
            await stored;
          } else if (step.kind === 'done' && !exhausted) {
            exhausted = true;
            if (ctx.done !== ctx.frames)
              throw new Error(`Refine ended after ${ctx.done} of ${ctx.frames} frames.`);
            setStatus('finishing');
            awaitFinal(gen, ctx);
          }
        })
        .catch((err: unknown) => fail(gen, ctx, err instanceof Error ? err.message : String(err)))
        .finally(() => {
          if (gen !== generation) return;
          inFlight--;
          pump(gen, ctx);
        });
    }
  }

  let current: Ctx | null = null;

  /** Run Refine once over the whole recording. */
  async function run(): Promise<void> {
    const reason = blocked();
    if (reason) {
      setError(reason);
      setStatus('error');
      return;
    }
    const before = cells.library();
    const bytes = cells.libraryBytes();
    const st = cells.status();
    const plan1 = pipeline.plan() as PipelinePlan;
    if (!before || !bytes || !st || !plan1) {
      setError('No final library to refine.');
      setStatus('error');
      return;
    }
    const gen = ++generation;
    inFlight = 0;
    exhausted = false;
    setStatus('running');
    setError(null);
    setProcessed(0);
    setFps(0);
    const rec = pipeline.record();
    const flatMap = pipeline.flatFieldMap();
    const ctx: Ctx = {
      frames: rec.frames,
      batch: plan1.batchSize,
      run: (st.run ?? 1) + 1,
      before,
      refines0: st.counters.refines,
      meter: new ThroughputMeter(),
      done: 0,
      tracker: new RefineTracker(before, cells.fps()),
      seriesAt: -Infinity,
      traces: null,
      ids: before.ids.slice(),
    };
    current = ctx;
    setTotal(ctx.frames);
    setSeries({ samples: [], end: ctx.tracker.time(ctx.frames) });
    log.begin('refine');
    // Room for the replay's traces (the QC); without it Refine runs, without a QC.
    if (options.qc) {
      try {
        ctx.traces = await (options.traceFile ?? createTraceFile)(ctx.frames, ctx.ids.length);
      } catch (err) {
        console.warn('Refine QC skipped:', err instanceof Error ? err.message : String(err));
      }
      if (gen !== generation) {
        dropTraces(ctx);
        return;
      }
    }
    try {
      await client.startPipeline(
        {
          batchSize: plan1.batchSize,
          calibrationFrames: plan1.calibrationFrames,
          motionWarmupFrames: plan1.motionWarmupFrames,
          previewMaxSide: plan1.previewMaxSide,
        },
        {
          session: cells.session(),
          discover: true,
          qc: false,
          library: bytes,
          refine: true,
          forwardBuffers: REFINE_FORWARD_BUFFERS,
        },
        { frameCount: ctx.frames, ...rec.snapshot(), ...(flatMap ? { flatField: flatMap } : {}) },
      );
      if (gen !== generation) return;
      pump(gen, ctx);
    } catch (err) {
      fail(gen, ctx, err instanceof Error ? err.message : String(err));
    }
  }

  /** Stop a running Refine: the slow loop publishes what it has refined so far. */
  function cancel(): void {
    const st = status();
    if (st !== 'running' && st !== 'finishing') return;
    generation++;
    inFlight = 0;
    setStatus('cancelled');
    if (current) {
      record(current, 'cancelled');
      dropTraces(current);
    }
    void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  /** Forget the state (a new Discover run, another recording). */
  function clear(): void {
    if (status() === 'running' || status() === 'finishing') generation++;
    if (current) dropTraces(current);
    current = null;
    setStatus('idle');
    setError(null);
    setProcessed(0);
    setTotal(0);
    setFps(0);
    setSeries(null);
  }

  return { status, processed, total, fps, error, series, run, cancel, clear };
}

export type RefineStore = ReturnType<typeof createRefineStore>;
