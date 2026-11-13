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
 * next batch is asked for only once the slow loop has taken all but one of
 * the batches sent (a file can wait; a live stream could not).
 *
 * The engine path is the same as qc_eval's `--later-passes refine`
 * (`SlowLoop.setEditScope('refine')`, then the recording again).
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import { MAX_IN_FLIGHT, ThroughputMeter, type PipelineStore } from './pipeline-store.ts';
import { footprintChange, perMinute, type StageLog, type StageRun } from './run-stages.ts';
import type { LibraryView } from '../workers/slow-types.ts';

export type RefineStatus = 'idle' | 'running' | 'finishing' | 'done' | 'error' | 'cancelled';

/** How often to look again while waiting for the slow loop, ms. */
const WAIT_MS = 10;

export function createRefineStore(
  client: PipelineClient,
  pipeline: PipelineStore,
  cells: CellStore,
  log: StageLog,
  /** Why Refine cannot start now (the stage rules, `stageAvailability`). */
  blocked: () => string | null,
  clock: () => number = () => performance.now(),
) {
  const [status, setStatus] = createSignal<RefineStatus>('idle');
  const [processed, setProcessed] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

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
  }

  /** Frames of this replay the slow loop has taken (0 until its status says it is on this run). */
  function slowTaken(ctx: Ctx): number {
    const st = cells.status();
    return st && st.run === ctx.run ? (st.consumed ?? st.frame) : 0;
  }

  /** Close the run in the log with what the slow loop published. */
  function record(ctx: Ctx, outcome: 'done' | 'cancelled' | 'error'): void {
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
      setStatus('done');
      return;
    }
    setTimeout(() => awaitFinal(gen, ctx), WAIT_MS);
  }

  function fail(gen: number, ctx: Ctx | null, message: string): void {
    if (gen !== generation) return;
    generation++;
    setError(message);
    setStatus('error');
    if (ctx) record(ctx, 'error');
    void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  function pump(gen: number, ctx: Ctx): void {
    while (gen === generation && status() === 'running' && !exhausted && inFlight < MAX_IN_FLIGHT) {
      // Never more than one batch ahead of the slow loop (nothing is dropped).
      if (ctx.done + inFlight * ctx.batch - slowTaken(ctx) > ctx.batch) {
        if (inFlight === 0) setTimeout(() => pump(gen, ctx), WAIT_MS);
        return;
      }
      inFlight++;
      client
        .stepPipeline()
        .then((step) => {
          if (gen !== generation) return;
          if (step.kind === 'batch') {
            ctx.done = step.start + step.count;
            setProcessed(ctx.done);
            setFps(ctx.meter.record(clock(), step.count));
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
    };
    current = ctx;
    setTotal(ctx.frames);
    log.begin('refine');
    try {
      await client.startPipeline(
        {
          batchSize: plan1.batchSize,
          calibrationFrames: plan1.calibrationFrames,
          motionWarmupFrames: plan1.motionWarmupFrames,
          previewMaxSide: plan1.previewMaxSide,
        },
        { session: cells.session(), discover: true, qc: false, library: bytes, refine: true },
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
    if (current) record(current, 'cancelled');
    void client.stopPipeline({ keepSlow: true }).catch(() => {});
  }

  /** Forget the state (a new Discover run, another recording). */
  function clear(): void {
    if (status() === 'running' || status() === 'finishing') generation++;
    current = null;
    setStatus('idle');
    setError(null);
    setProcessed(0);
    setTotal(0);
    setFps(0);
  }

  return { status, processed, total, fps, error, run, cancel, clear };
}

export type RefineStore = ReturnType<typeof createRefineStore>;
