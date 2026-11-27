/**
 * Trace worker (pipeline stage C): the preprocessing back half (background,
 * noise map), the fast loop (library swaps, trace solve, QC) and the feed to
 * the slow worker. It answers the main thread with the `pipeline-step`
 * response of each request, so it owns the slow-worker port and discovery
 * switch in a pipelined run. It never waits for the slow worker (see
 * `FastLoop`). A recording on the GPU route (the default) waits before a batch while the GPU
 * compressor's ring is full (`CompressFeed.room`); holding the job holds its
 * pooled buffer, so the stages before this one wait too. See
 * `lib/pipeline-stages.ts`.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { errMsg } from '../lib/errors.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import { FovProjector } from '../lib/fov-projection.ts';
import { compressFeedOptions, fastLoopOptions } from '../lib/run-cells.ts';
import { transferablesOf, type PipelineStepResult } from '../lib/pipeline-types.ts';
import { BackStage } from '../lib/pipeline-stages.ts';
import { traceBackend } from '../lib/trace-backend.ts';
import type { CompressToFast, FastToCompress } from './compress-types.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';
import type { FastToSlow, SlowToFast } from './slow-types.ts';
import type { StageFree, StageLink, StageMsg } from './stage-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: FrameResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FrameRequest | StageLink>) => void) | null;
};

let up: MessagePort | null = null;
let slowPort: MessagePort | null = null;
let compressPort: MessagePort | null = null;
let stage: BackStage | null = null;
let queue: Promise<void> = Promise.resolve();
/** Look-back runs: frames between snapshots of the back half's state (look-back blocks start from the newest). */
const LOOKBACK_SNAPSHOT_EVERY = 256;
/** Session of the slow loop the last Discover run started (-1: none). */
let slowSession = -1;

/**
 * Stop the running stage. `keepSlow`: a replay stage (Extract) follows or is
 * stopped, so the slow loop is not reset; otherwise it is dropped, also when the stage was an
 * Extract run, which never talks to it (the slow worker may be ended by then: see `FastLoop.dispose`).
 */
function stopStage(keepSlow = false): void {
  stage?.dispose(keepSlow);
  stage = null;
  if (!keepSlow && slowSession >= 0) {
    slowPort?.postMessage({ type: 'reset', session: slowSession } satisfies FastToSlow);
    slowSession = -1;
  }
}

async function handle(msg: StageMsg): Promise<void> {
  switch (msg.type) {
    case 'start': {
      const cells = msg.cells;
      // A replay stage (Extract) keeps the slow loop and is not connected to it.
      stopStage(cells?.library !== undefined);
      const port = cells?.library ? null : slowPort;
      if (port && !cells?.library && (cells?.discover ?? true)) slowSession = cells?.session ?? 0;
      const options = fastLoopOptions(msg.fast, cells, msg.setup.boundaries, port !== null);
      const fast = new FastLoop(
        options,
        port as { postMessage(m: FastToSlow, t?: Transferable[]): void } | null,
        traceBackend,
        cells?.compress && compressPort
          ? new CompressFeed(
              compressFeedOptions(cells, msg.fast.width, msg.fast.height),
              compressPort as { postMessage(m: FastToCompress, t?: Transferable[]): void },
            )
          : null,
      );
      stage = new BackStage(
        msg.setup,
        fast,
        cells?.projection
          ? new FovProjector(msg.setup.width, msg.setup.height, msg.setup.boundaries ?? [])
          : null,
        options.lookback ? LOOKBACK_SNAPSHOT_EVERY : 0,
      );
      break;
    }
    case 'job': {
      if (!stage) throw new Error('The trace stage is not running.');
      const s = msg.job.step;
      if (s.phase === 'process') {
        const room = stage.fast?.compressRoom(s.start, s.count);
        if (room) await room;
      }
      const step = stage.handle(msg.job);
      const corrected = msg.job.corrected;
      workerScope.postMessage({ type: 'pipeline-step', id: msg.id, step }, transferablesOf(step));
      if (corrected) {
        up?.postMessage({ type: 'free', epoch: msg.epoch, buffer: corrected } satisfies StageFree, [
          corrected.buffer as ArrayBuffer,
        ]);
      }
      break;
    }
    case 'end': {
      stage?.end();
      const projection = stage?.projector?.result();
      const backState = stage?.finalBackState();
      const step: PipelineStepResult = {
        kind: 'done',
        ...(projection ? { projection } : {}),
        ...(backState ? { backState } : {}),
      };
      workerScope.postMessage({ type: 'pipeline-step', id: msg.id, step }, transferablesOf(step));
      break;
    }
    case 'stop':
      stopStage(msg.keepSlow === true);
      break;
  }
}

workerScope.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'stage-link') {
    up?.close();
    up = data.up;
    up.onmessage = (ev: MessageEvent<StageMsg>) => {
      const msg = ev.data;
      queue = queue
        .then(() => (msg.type === 'start' ? initCalaWasm() : undefined))
        .then(() => handle(msg))
        .catch((err: unknown) => {
          if (msg.type === 'start' || msg.type === 'job' || msg.type === 'end') {
            workerScope.postMessage({
              type: 'error',
              id: msg.id,
              message: errMsg(err),
            });
          }
        });
    };
  } else if (data.type === 'connect-slow') {
    slowPort?.close();
    slowPort = data.port;
    // Slow-worker answers only record state; they are applied between batches.
    slowPort.onmessage = (ev: MessageEvent<SlowToFast>) => stage?.fast?.handleSlow(ev.data);
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'connect-compress') {
    compressPort?.close();
    compressPort = data.port;
    // Room in the GPU compressor's ring: recorded at once (a batch may be waiting for it).
    compressPort.onmessage = (ev: MessageEvent<CompressToFast>) =>
      stage?.fast?.compressAnswer(ev.data);
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'release-compress') {
    // Stop or a new run: answered at once, not in the queue (a batch may be waiting for the GPU there).
    stage?.fast?.releaseCompress();
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'set-discovery') {
    stage?.fast?.setDiscovery(data.on && slowPort !== null);
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'set-residual') {
    stage?.fast?.setResidual(data.on);
    workerScope.postMessage({ type: 'ok', id: data.id });
  }
};
