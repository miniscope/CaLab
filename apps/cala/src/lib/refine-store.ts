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
import {
  footprintChange,
  perMinute,
  type FactorPhase,
  type StageLog,
  type StageRun,
} from './run-stages.ts';
import { RefineTracker, type RefineSample } from './refine-metrics.ts';
import type { RunRecord } from './run-record.ts';
import type { SlowClient } from './slow-client.ts';
import type {
  FactorIteration,
  FactorRefineSettings,
  FactorStop,
  LibraryView,
  SlowStatus,
  SlowToMain,
} from '../workers/slow-types.ts';
import type { QcSnapshot } from './qc.ts';
import { createTraceFile, type TraceFile } from './trace-file.ts';
import { startReplayPipeline } from './replay-pipeline.ts';
import {
  endOnce,
  NO_COMPRESS,
  type FactorFilesLike,
  type ReplayCompress,
  type ReplayCompressLike,
} from './factor-extract.ts';

/** Refine's QC: the QC of the replay's traces (`traces`: frames x cells, ids `ids`). */
export interface RefineQcOptions {
  qc?: (traces: TraceFile, ids: Uint32Array) => Promise<QcSnapshot | null>;
  /** Where the replay's traces go (default `createTraceFile`: OPFS, or memory). */
  traceFile?: (frames: number, cells: number) => Promise<TraceFile>;
  /** Compression on: whether this replay compresses, and where its outcome goes (absent: off). */
  compress?: ReplayCompressLike;
  /** `?refine=factors`: Refine reads the factors (absent: Refine replays the file). */
  factorRefine?: RefineFactorsOptions;
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

/** Refine on the factors: the spec's settle stop and cap (§5), qc_eval's defaults. */
export const FACTOR_REFINE: FactorRefineSettings = {
  settleCorr: 0.99,
  settleShare: 0.02,
  maxIterations: 20,
  testFrames: 0,
};

/** `?refine=factors`: Refine reads the factors (off by default: Refine replays the file). */
export function refineOnFactorsOn(params: URLSearchParams): boolean {
  return params.get('refine') === 'factors';
}

/** What Refine on the factors needs (compression on and `?refine=factors`). */
export interface RefineFactorsOptions {
  factors: FactorFilesLike;
  slow: Pick<SlowClient, 'refineOnFactors' | 'stopFactors'>;
  /** A live run: the factors are Discover's own and there is no file to replay. */
  live(): boolean;
  /** Discover ran with look-back: its slow loop runs the cluster replay, which Refine on the factors refuses until phase 3b. */
  lookback(): boolean;
  /** The settle stop and cap (default `FACTOR_REFINE`). */
  settings?: FactorRefineSettings;
}

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
  /** What a running Refine on the factors does (null: none runs). */
  const [phase, setPhase] = createSignal<FactorPhase | null>(null);
  /** The last Refine on the factors failed: a file's next Refine replays the file, until `clear`. */
  const [factorFailed, setFactorFailed] = createSignal(false);
  /** The slow worker holds the factor files of this session until its `factor-end`. */
  let out: { session: number; done: Promise<void>; release: () => void } | null = null;

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
    /** The replay feeds the compress worker (its projections are the factors' FOV images). */
    compressed: boolean;
    /** The replay ended; false: cut short. Reports only the first call. */
    ended: (ok: boolean) => void;
    /** The pump has the replay: its end is reported there, by fail, cancel or clear; before, by `run`. */
    pumping: boolean;
    /** `raw`: a replay into the slow loop; `factors`: Refine on the factors. */
    route: 'raw' | 'factors';
    /** What the run does now: a replay into the slow loop, a replay that only compresses, waiting for the factor files, the iterations. */
    mode: 'refine' | 'compress' | 'wait' | 'iterate';
    /** The iterations' reports (Refine on the factors). */
    reports: FactorIteration[];
    /** The session the iterations run under. */
    slowSession: number;
  }

  /** Stop collecting traces for the QC (and free them). */
  function dropTraces(ctx: Ctx, why?: string): void {
    if (why) console.warn(`Refine QC skipped: ${why}`);
    const f = ctx.traces;
    ctx.traces = null;
    if (f) void f.dispose().catch(() => {});
  }

  /** The context of a run (both routes). */
  function makeCtx(
    rec: RunRecord,
    plan1: PipelinePlan,
    st: SlowStatus,
    before: LibraryView,
    route: Ctx['route'],
  ): Ctx {
    return {
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
      compressed: false,
      ended: NO_COMPRESS.ended,
      pumping: false,
      route,
      mode: route === 'raw' ? 'refine' : 'compress',
      reports: [],
      slowSession: -1,
    };
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
    if (ctx.route === 'factors') {
      recordFactors(
        ctx,
        outcome,
        outcome === 'cancelled' ? 'stopped' : 'error',
        ctx.reports.length,
      );
      return;
    }
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
      source: 'raw',
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
    setPhase(null);
    if (ctx) {
      if (ctx.pumping) ctx.ended(false);
      record(ctx, 'error');
      dropTraces(ctx);
      if (ctx.route === 'factors' && ctx.mode === 'iterate') setFactorFailed(true);
    }
    // Waiting or iterating, no pipeline of this run is running.
    if (!ctx || ctx.mode === 'refine' || ctx.mode === 'compress')
      void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  function pump(gen: number, ctx: Ctx): void {
    while (gen === generation && status() === 'running' && !exhausted && inFlight < MAX_IN_FLIGHT) {
      // At most REFINE_SLOW_LEAD batches ahead of the slow loop (nothing is dropped).
      // A replay that only compresses feeds no slow loop, so it has no lead to keep.
      if (
        ctx.mode === 'refine' &&
        ctx.done + (inFlight + 1) * ctx.batch - slowTaken(ctx) > REFINE_SLOW_LEAD * ctx.batch
      ) {
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
            if (ctx.mode === 'refine') sample(ctx);
            else setPhase({ kind: 'compress', done: ctx.done, total: ctx.frames });
            setProcessed(ctx.done);
            setFps(ctx.meter.record(clock(), step.count));
            // Backpressure: the next batch is asked for once the disk has caught up.
            await stored;
          } else if (step.kind === 'done' && !exhausted) {
            exhausted = true;
            if (ctx.done !== ctx.frames)
              throw new Error(`Refine ended after ${ctx.done} of ${ctx.frames} frames.`);
            // Every frame went to the compress worker: these are the factors' FOV images.
            const keep = ctx.mode === 'compress' ? options.factorRefine?.factors : options.compress;
            if (ctx.compressed && step.projection) keep?.keepProjection(step.projection);
            ctx.ended(true);
            if (ctx.mode === 'refine') {
              setStatus('finishing');
              awaitFinal(gen, ctx);
            } else if (options.factorRefine) waitForFiles(gen, ctx, options.factorRefine);
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
    const rec = pipeline.record();
    const route = routeOf(rec.frames).route;
    if (route === 'factors' && out) {
      // A second reader would open the files the slow worker still has open.
      console.warn(
        'Refine on the factors: the slow worker still holds the factor files of the last run; run Refine again once it has ended.',
      );
      return;
    }
    const gen = ++generation;
    inFlight = 0;
    exhausted = false;
    setStatus('running');
    setError(null);
    setProcessed(0);
    setFps(0);
    const flatMap = pipeline.flatFieldMap();
    if (route === 'factors' && options.factorRefine) {
      await runFactors(
        gen,
        makeCtx(rec, plan1, st, before, 'factors'),
        plan1,
        bytes,
        options.factorRefine,
      );
      return;
    }
    // The first replay after Discover compresses, when no factors exist yet.
    const comp: ReplayCompress = options.compress?.replayCompress(rec.frames) ?? NO_COMPRESS;
    const ctx = makeCtx(rec, plan1, st, before, 'raw');
    ctx.compressed = comp.settings.compress === true;
    ctx.ended = endOnce(comp.ended);
    current = ctx;
    setTotal(ctx.frames);
    setSeries({ samples: [], end: ctx.tracker.time(ctx.frames) });
    log.begin('refine');
    try {
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
      await startReplayPipeline(
        client,
        plan1,
        {
          session: cells.session(),
          discover: true,
          library: bytes,
          refine: true,
          forwardBuffers: REFINE_FORWARD_BUFFERS,
          ...comp.settings,
          // The FOV images of a factor Extract come from the replay that made the factors.
          ...(ctx.compressed ? { projection: true } : {}),
        },
        { frames: ctx.frames, record: rec, flatField: flatMap },
      );
      if (gen !== generation) return;
      ctx.pumping = true;
      pump(gen, ctx);
    } catch (err) {
      fail(gen, ctx, err instanceof Error ? err.message : String(err));
    } finally {
      // Until the pump has the replay, its end is here: a throw or a stop before it runs cuts it short.
      if (!ctx.pumping) ctx.ended(false);
    }
  }

  /** Where the next Refine reads, and why a file run with the switch on replays the file. */
  function routeOf(frames: number): { route: 'raw' | 'factors'; note: string | null } {
    const o = options.factorRefine;
    if (!o) return { route: 'raw', note: null };
    if (o.live()) return { route: 'factors', note: null };
    if (o.lookback())
      return {
        route: 'raw',
        note: 'Refine replays the file: Refine on the factors does not run after a look-back Discover (its slow loop runs the cluster replay).',
      };
    if (factorFailed())
      return {
        route: 'raw',
        note: 'Refine replays the file: the last Refine on the factors failed.',
      };
    if (o.factors.state(frames) === 'unusable')
      return {
        route: 'raw',
        note: o.factors.compressionError()
          ? 'Refine replays the file: the compression failed.'
          : 'Refine replays the file: the factors do not cover the recording.',
      };
    return { route: 'factors', note: null };
  }

  /**
   * Refine on the factors: a replay that only compresses when a file has no
   * factors yet (a live stream is never replayed: it waits for Discover's),
   * then the iterations in the slow worker once it may open the files
   * (`waitForFiles`).
   */
  async function runFactors(
    gen: number,
    ctx: Ctx,
    plan1: PipelinePlan,
    bytes: Uint8Array,
    o: RefineFactorsOptions,
  ): Promise<void> {
    current = ctx;
    setTotal(ctx.frames);
    setSeries(null);
    log.begin('refine');
    if (o.live() || o.factors.state(ctx.frames) !== 'none') {
      waitForFiles(gen, ctx, o);
      return;
    }
    const comp = o.factors.replayCompress(ctx.frames);
    ctx.compressed = comp.settings.compress === true;
    ctx.ended = endOnce(comp.ended);
    if (!ctx.compressed) {
      waitForFiles(gen, ctx, o);
      return;
    }
    setPhase({ kind: 'compress', done: 0, total: ctx.frames });
    try {
      await startReplayPipeline(
        client,
        plan1,
        { session: 0, discover: false, library: bytes, projection: true, ...comp.settings },
        { frames: ctx.frames, record: pipeline.record(), flatField: pipeline.flatFieldMap() },
      );
      if (gen !== generation) return;
      ctx.pumping = true;
      pump(gen, ctx);
    } catch (err) {
      fail(gen, ctx, err instanceof Error ? err.message : String(err));
    } finally {
      if (!ctx.pumping) ctx.ended(false);
    }
  }

  /** Wait until the slow worker may open the factor files (decision 1), then start the iterations. */
  function waitForFiles(gen: number, ctx: Ctx, o: RefineFactorsOptions): void {
    if (gen !== generation) return;
    ctx.mode = 'wait';
    const state = o.factors.state(ctx.frames);
    if (state === 'unusable') {
      const err = o.factors.compressionError();
      fail(
        gen,
        ctx,
        o.live()
          ? 'Refine on the factors: the factors of this stream cannot be read.'
          : err
            ? `Refine on the factors: the compression failed (${err}). The next Refine replays the file.`
            : 'Refine on the factors: the factors do not cover the recording. The next Refine replays the file.',
      );
      return;
    }
    const files = o.factors.files(ctx.frames);
    if (files) {
      iterate(ctx, o, files);
      return;
    }
    setPhase(
      state === 'ready'
        ? { kind: 'wait', for: 'extract', pending: 0 }
        : { kind: 'wait', for: 'compression', pending: o.factors.pending() },
    );
    setTimeout(() => waitForFiles(gen, ctx, o), WAIT_MS);
  }

  /** Hand the files to the slow worker; the run ends at its `factor-end` (`onSlowMessage`). */
  function iterate(
    ctx: Ctx,
    o: RefineFactorsOptions,
    files: { folder: string; windows: number },
  ): void {
    const settings = o.settings ?? FACTOR_REFINE;
    const session = cells.session();
    ctx.mode = 'iterate';
    ctx.slowSession = session;
    setTotal(settings.maxIterations);
    setProcessed(0);
    setPhase({ kind: 'iterate', last: null, stopping: false });
    let release = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    out = { session, done, release };
    o.slow.refineOnFactors({ session, folder: files.folder, windows: files.windows, ...settings });
  }

  /** The messages of the slow worker about Refine on the factors (the app passes every slow message). */
  function onSlowMessage(msg: SlowToMain): void {
    if (msg.type === 'error') {
      // Only a crash of the slow worker itself frees its files (a visit
      // worker's crash or a failed connection leave it holding them): it
      // answers nothing more, so the run is over (also one still making or
      // waiting for the factors: it would hand them to a dead worker).
      if (msg.session !== -1 || msg.worker !== 'slow') return;
      if (out) {
        out.release();
        out = null;
      }
      const ctx = current;
      const st = status();
      if (ctx?.route === 'factors' && (st === 'running' || st === 'finishing')) {
        fail(generation, ctx, `Cell discovery stopped: ${msg.message}`);
        // A late `factor-end` of this run logs nothing more.
        current = null;
      }
      return;
    }
    if (msg.type !== 'factor-iteration' && msg.type !== 'factor-end') return;
    const ctx = current;
    const mine = ctx !== null && ctx.mode === 'iterate' && ctx.slowSession === msg.session;
    if (msg.type === 'factor-iteration') {
      if (!mine) return;
      ctx.reports.push(msg.report);
      setProcessed(msg.report.iteration);
      setPhase((p) => ({
        kind: 'iterate',
        last: msg.report,
        stopping: p?.kind === 'iterate' && p.stopping,
      }));
      return;
    }
    if (out && out.session === msg.session) {
      out.release();
      out = null;
    }
    if (mine) finishFactors(ctx, msg.stop, msg.iterations, msg.message, msg.refused === true);
  }

  /** The slow worker ended the iterations (a refusal is no failure of the factors). */
  function finishFactors(
    ctx: Ctx,
    stop: FactorStop,
    iterations: number,
    message: string | undefined,
    refused: boolean,
  ): void {
    const outcome = stop === 'stopped' ? 'cancelled' : stop === 'error' ? 'error' : 'done';
    recordFactors(ctx, outcome, stop, iterations);
    current = null;
    setPhase(null);
    if (outcome === 'error') {
      if (!refused) setFactorFailed(true);
      setError(message ?? 'Refine on the factors failed.');
    }
    setStatus(outcome);
  }

  /** Close the run in the log: what it changed, whose factors it read, how it stopped. */
  function recordFactors(
    ctx: Ctx,
    outcome: 'done' | 'cancelled' | 'error',
    stop: FactorStop,
    iterations: number,
  ): void {
    const o = options.factorRefine;
    const after = cells.library();
    const change = after ? footprintChange(ctx.before, after) : { refined: 0, median: null };
    const last = ctx.reports.at(-1);
    const info = o?.factors.info() ?? null;
    log.end('refine', outcome, {
      frames: ctx.frames,
      cells: after?.ids.length ?? 0,
      libraryVersion: after?.version ?? 0,
      refines: ctx.reports.reduce((s, r) => s + r.accepted, 0),
      // Iterations over the whole recording are not a rate over its minutes.
      refinesPerMin: null,
      footprintsRefined: change.refined,
      medianFootprintChange: change.median,
      source: 'factors',
      ...(info ? { tiling: info.tiling, meanRank: info.meanRank } : {}),
      ...(o ? { factors: o.factors.origin() } : {}),
      iterations,
      stop,
      ...(last ? { changedShare: last.changedShare } : {}),
    });
  }

  /** Resolves once the slow worker holds no factor file of this store (a running Refine on the factors is stopped first). */
  function release(): Promise<void> {
    if (!out) return Promise.resolve();
    options.factorRefine?.slow.stopFactors(out.session);
    return out.done;
  }

  /** Stop a running Refine: the slow loop publishes what it has refined so far. */
  function cancel(): void {
    const st = status();
    if (st !== 'running' && st !== 'finishing') return;
    const ctx = current;
    // The iterations: the slow worker stops after the current one and holds the files until then.
    if (ctx?.mode === 'iterate') {
      if (out) options.factorRefine?.slow.stopFactors(out.session);
      setStatus('finishing');
      setPhase((p) => (p?.kind === 'iterate' ? { ...p, stopping: true } : p));
      return;
    }
    generation++;
    inFlight = 0;
    setStatus('cancelled');
    setPhase(null);
    if (ctx) {
      if (ctx.pumping) ctx.ended(false);
      record(ctx, 'cancelled');
      dropTraces(ctx);
    }
    if (!ctx || ctx.mode !== 'wait') void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  /** Forget the state (a new Discover run, another recording); iterations in the slow worker are stopped (`release` waits for them). */
  function clear(): void {
    if (status() === 'running' || status() === 'finishing') generation++;
    if (current) {
      if (current.pumping) current.ended(false);
      dropTraces(current);
    }
    if (out) options.factorRefine?.slow.stopFactors(out.session);
    current = null;
    setStatus('idle');
    setError(null);
    setProcessed(0);
    setTotal(0);
    setFps(0);
    setSeries(null);
    setPhase(null);
    setFactorFailed(false);
  }

  return {
    status,
    processed,
    total,
    fps,
    error,
    series,
    /** What a running Refine on the factors does (null: none runs). */
    phase,
    /** Where the next Refine reads (`?refine=factors`: the factors, unless `routeNote` says why not). */
    route: (): 'raw' | 'factors' => routeOf(pipeline.record().frames).route,
    routeNote: (): string | null => routeOf(pipeline.record().frames).note,
    /** The settle stop and cap Refine on the factors iterates with (the Run panel's readout). */
    factorSettings: (): FactorRefineSettings => options.factorRefine?.settings ?? FACTOR_REFINE,
    run,
    cancel,
    clear,
    release,
    onSlowMessage,
  };
}

export type RefineStore = ReturnType<typeof createRefineStore>;
