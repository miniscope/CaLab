/**
 * Trace worker (pipeline stage C): the preprocessing back half (background,
 * noise map), the fast loop (library swaps, trace solve, QC) and the feed to
 * the slow worker. It answers the main thread with the `pipeline-step`
 * response of each request, so it owns the slow-worker port and discovery
 * switch in a pipelined run. It never waits for the slow worker (see
 * `FastLoop`). See `lib/pipeline-stages.ts`.
 */
import { initCalaWasm, quantizeTiles } from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import { transferablesOf } from '../lib/pipeline-engine.ts';
import { BackStage } from '../lib/pipeline-stages.ts';
import { traceBackend } from '../lib/trace-backend.ts';
import type { FastToCompress } from './compress-types.ts';
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

function stopStage(): void {
  stage?.dispose();
  stage = null;
}

function handle(msg: StageMsg): void {
  switch (msg.type) {
    case 'start': {
      stopStage();
      const cells = msg.cells;
      // Pass 2 (a library is given) is not connected to the slow loop.
      const port = cells?.library ? null : slowPort;
      const fast = new FastLoop(
        {
          ...msg.fast,
          session: cells?.session ?? 0,
          discover: (cells?.discover ?? true) && port !== null,
          qc: cells?.qc ?? true,
          residual: cells?.residual ?? false,
          ...(cells?.library ? { initialLibrary: cells.library } : {}),
          ...(cells?.forwardBuffers ? { poolSize: cells.forwardBuffers } : {}),
        },
        port as { postMessage(m: FastToSlow, t?: Transferable[]): void } | null,
        traceBackend,
        cells?.compress && compressPort
          ? new CompressFeed(
              { width: msg.fast.width, height: msg.fast.height, session: cells.session },
              compressPort as { postMessage(m: FastToCompress, t?: Transferable[]): void },
              quantizeTiles,
            )
          : null,
      );
      stage = new BackStage(msg.setup, fast);
      break;
    }
    case 'job': {
      if (!stage) throw new Error('The trace stage is not running.');
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
    case 'end':
      stage?.end();
      workerScope.postMessage({ type: 'pipeline-step', id: msg.id, step: { kind: 'done' } });
      break;
    case 'stop':
      stopStage();
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
              message: err instanceof Error ? err.message : String(err),
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
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'set-discovery') {
    stage?.fast?.setDiscovery(data.on && slowPort !== null);
    workerScope.postMessage({ type: 'ok', id: data.id });
  } else if (data.type === 'set-residual') {
    stage?.fast?.setResidual(data.on);
    workerScope.postMessage({ type: 'ok', id: data.id });
  }
};
