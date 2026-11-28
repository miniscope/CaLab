/**
 * The three pipeline stages of `pipeline-stages.ts` chained in one thread, with
 * the bounded buffer pools the workers use: for Node scripts and tests. The app
 * runs each stage in a worker of its own (`workers/frame-worker.ts`,
 * `motion-worker.ts`, `trace-worker.ts`); this adds no pipeline logic, only the
 * hand-offs those workers' messages make. B's shifts are not fed back to A and
 * there is no estimator, so there is no online flat field.
 */
import type { FastLoop } from './fast-loop.ts';
import type { PipelineOptions, PipelinePlan } from './pipeline-plan.ts';
import type { FastLoopSetup, FrameReader, PipelineStepResult } from './pipeline-types.ts';
import { BackStage, FrontStage, MotionStage } from './pipeline-stages.ts';
import type { FrameView } from './preview.ts';
import { StagePool } from './stage-pool.ts';

/** Buffers per link, as `frame-worker.ts` (`FRONT_BUFFERS`) and `motion-worker.ts` (`OUT_BUFFERS`) size their pools. */
const POOL_SIZE = 3;

/** What `StageChain` adds to the pipeline options. */
export interface StageChainOptions {
  /** Builds the fast loop stage C runs on every batch (absent: no traces). */
  fastLoop?: (setup: FastLoopSetup) => FastLoop;
}

/** Runs a recording through stages A -> B -> C, one step per `step()` call. */
export class StageChain {
  readonly plan: PipelinePlan;
  private readonly frontPool: StagePool;
  private readonly outPool: StagePool;
  private readonly a: FrontStage;
  private readonly b: MotionStage;
  private readonly c: BackStage;
  private disposed = false;

  constructor(reader: FrameReader, options: PipelineOptions = {}, chain: StageChainOptions = {}) {
    // A asks for buffers only from its first `next()`, after the pool exists.
    this.a = new FrontStage(reader, options, () => this.frontPool.acquire());
    this.plan = this.a.plan;
    const len = this.plan.batchSize * reader.info.width * reader.info.height;
    this.frontPool = new StagePool(POOL_SIZE, len);
    this.outPool = new StagePool(POOL_SIZE, len);
    this.b = new MotionStage(this.a.setup, () => this.outPool.acquire());
    this.c = new BackStage(this.a.setup, chain.fastLoop?.(this.a.fastSetup) ?? null);
  }

  /** Buffers handed out and not yet returned, on the A -> B and B -> C links. */
  get inFlight(): [number, number] {
    return [this.frontPool.inFlight, this.outPool.inFlight];
  }

  /** Preview this view of every frame of the next batches (null: the last frame only). */
  set framePreview(view: FrameView | null) {
    this.a.framePreview = view;
  }

  /** Run the next step. After the last batch, returns `{ kind: 'done' }`. */
  async step(): Promise<PipelineStepResult> {
    if (this.disposed) throw new Error('The stage chain was disposed.');
    const job = await this.a.next();
    if (!job) {
      this.c.end();
      return { kind: 'done' };
    }
    const done = await this.b.handle(job);
    // As the motion worker's postMessage does: the calibration's FOV mask moves on to C,
    // detached from B (which keeps its own copy).
    if (done.calib) {
      const m = done.calib.fovMask;
      done.calib = { ...done.calib, fovMask: structuredClone(m, { transfer: [m.buffer] }) };
    }
    if (done.front) this.frontPool.release(done.front);
    const result = this.c.handle(done);
    if (done.corrected) this.outPool.release(done.corrected);
    return result;
  }

  /** Free the stages' WASM state; `step()` throws afterwards. */
  dispose(): void {
    this.disposed = true;
    this.a.dispose();
    this.b.dispose();
    this.c.dispose();
  }
}
