/**
 * Motion worker (pipeline stage B): the motion corrector. Receives
 * preprocessed batches from the frame worker, registers them into pooled
 * buffers, and passes them to the trace worker. The front buffer goes back
 * upstream as soon as the batch is registered; the output buffer comes back
 * from the trace worker. See `lib/pipeline-stages.ts`.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { jobTransferables, MotionStage } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { FrameResponse } from './frame-types.ts';
import type { StageFree, StageLink, StageMsg, StageShifts } from './stage-types.ts';

/** Registered-frame buffers between this stage and the trace stage. */
const OUT_BUFFERS = 3;

const workerScope = globalThis as unknown as {
  postMessage(msg: FrameResponse): void;
  onmessage: ((e: MessageEvent<StageLink>) => void) | null;
};

let up: MessagePort | null = null;
let down: MessagePort | null = null;
let stage: MotionStage | null = null;
let pool: StagePool | null = null;
let epoch = 0;
let useGpu = true;
// Pass 1 only: stage A needs the shifts for the flat-field estimator (pass 2 replays them).
let sendShifts = false;
// Finished jobs leave in arrival order; the GPU warp readback of one overlaps the next job's estimate.
let outChain: Promise<void> = Promise.resolve();
// Messages are handled one at a time, in arrival order.
let queue: Promise<void> = Promise.resolve();

function stopStage(): void {
  stage?.dispose();
  stage = null;
  pool = null;
}

async function handle(msg: StageMsg): Promise<void> {
  switch (msg.type) {
    case 'start': {
      await outChain;
      await initCalaWasm();
      stopStage();
      epoch = msg.epoch;
      const p = new StagePool(
        OUT_BUFFERS,
        msg.setup.plan.batchSize * msg.setup.width * msg.setup.height,
      );
      pool = p;
      stage = new MotionStage(msg.setup, () => p.acquire(), useGpu);
      sendShifts = !msg.setup.replay;
      down?.postMessage(msg);
      break;
    }
    case 'job': {
      if (!stage) throw new Error('The motion stage is not running.');
      const staged = await stage.handleStaged(msg.job);
      const job = msg.job;
      const front = job.front;
      delete job.front;
      if (front) {
        up?.postMessage({ type: 'free', epoch: msg.epoch, buffer: front } satisfies StageFree, [
          front.buffer as ArrayBuffer,
        ]);
      }
      outChain = outChain
        .then(() => staged.finish)
        .then(
          (done) => {
            if (sendShifts && done.step.phase === 'process' && done.dy && done.dx) {
              // Copies: the job's own arrays go on to the trace stage.
              const shifts: StageShifts = {
                type: 'shifts',
                epoch: msg.epoch,
                start: done.step.start,
                dy: done.dy.slice(),
                dx: done.dx.slice(),
                ...(done.sessionTransform ? { session: done.sessionTransform } : {}),
              };
              up?.postMessage(shifts, [
                shifts.dy.buffer as ArrayBuffer,
                shifts.dx.buffer as ArrayBuffer,
              ]);
            }
            down?.postMessage({ ...msg, job: done } satisfies StageMsg, jobTransferables(done));
          },
          (err: unknown) => {
            workerScope.postMessage({
              type: 'error',
              id: msg.id,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
      break;
    }
    case 'end':
      await outChain;
      down?.postMessage(msg);
      break;
    case 'stop':
      await outChain;
      stopStage();
      down?.postMessage(msg);
      break;
  }
}

workerScope.onmessage = (e) => {
  if (e.data.type !== 'stage-link') return;
  up?.close();
  down?.close();
  up = e.data.up;
  useGpu = e.data.gpu !== false;
  down = e.data.down ?? null;
  up.onmessage = (ev: MessageEvent<StageMsg>) => {
    const msg = ev.data;
    queue = queue.then(() =>
      handle(msg).catch((err: unknown) => {
        if (msg.type === 'start' || msg.type === 'job' || msg.type === 'end') {
          workerScope.postMessage({
            type: 'error',
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  };
  if (down) {
    down.onmessage = (ev: MessageEvent<StageFree>) => {
      if (ev.data.epoch === epoch) pool?.release(ev.data.buffer);
    };
  }
};
