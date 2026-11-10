/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and transfers each decoded
 * batch back as a Transferable. Also runs the preprocess + motion pipeline
 * (`PipelineEngine`), one step per request, so the pipeline reads frames
 * without a round trip through the main thread.
 *
 * This is the fast loop: after motion correction each batch is solved for
 * the traces of the current footprint library, and the frames are forwarded
 * to the slow worker (cell discovery) over a `MessagePort`. The fast loop
 * never waits for the slow worker: see `FastLoop` and `ForwardPool`.
 */
import { initCalaWasm, quantizeTiles } from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { PipelineEngine, transferablesOf } from '../lib/pipeline-engine.ts';
import { FrontStage, jobTransferables } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { traceBackend as backend } from '../lib/trace-backend.ts';
import type { FastToCompress } from './compress-types.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';
import type { StageFree, StageMsg } from './stage-types.ts';
import type { FastToSlow, SlowToFast } from './slow-types.ts';

let source: FrameSource | null = null;
let pipeline: PipelineEngine | null = null;
let slowPort: MessagePort | null = null;
let compressPort: MessagePort | null = null;

// Pipelined run (`link` received): this worker is stage A only (read +
// preprocess front half); the motion and trace workers do the rest.
let down: MessagePort | null = null;
let front: FrontStage | null = null;
let frontPool: StagePool | null = null;
let epoch = 0;
/** Preprocessed-frame buffers between this stage and the motion stage. */
const FRONT_BUFFERS = 3;

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FrameRequest>) => void) | null;
};

function post(msg: FrameResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(msg, transfer);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopPipeline(): void {
  pipeline?.dispose();
  pipeline = null;
  if (front) {
    front.dispose();
    front = null;
    frontPool = null;
    down?.postMessage({ type: 'stop', epoch } satisfies StageMsg);
  }
}

async function handle(req: FrameRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'open': {
        await initCalaWasm();
        stopPipeline();
        source?.dispose();
        source = null;
        source = await FrameSource.open(req.entries);
        post({ type: 'opened', id: req.id, info: source.info });
        break;
      }
      case 'read': {
        if (!source) throw new Error('No recording is open.');
        const pixels = await source.readFrames(req.start, req.count);
        post({ type: 'frames', id: req.id, start: req.start, count: req.count, pixels }, [
          pixels.buffer,
        ]);
        break;
      }
      case 'pipeline-start': {
        if (!source) throw new Error('No recording is open.');
        stopPipeline();
        if (down) {
          epoch++;
          // The stage asks for buffers only from its first `next()`, after the pool exists.
          const stage = new FrontStage(source, req.options, () => frontPool!.acquire());
          frontPool = new StagePool(
            FRONT_BUFFERS,
            stage.plan.batchSize * source.info.width * source.info.height,
          );
          front = stage;
          down.postMessage({
            type: 'start',
            epoch,
            id: req.id,
            setup: stage.setup,
            fast: stage.fastSetup,
            cells: req.cells,
          } satisfies StageMsg);
          post({ type: 'pipeline-ready', id: req.id, plan: stage.plan });
          break;
        }
        const cells = req.cells;
        const port = slowPort;
        pipeline = new PipelineEngine(source, req.options, undefined, (setup) => {
          return new FastLoop(
            {
              ...setup,
              session: cells?.session ?? 0,
              discover: (cells?.discover ?? true) && port !== null,
              qc: cells?.qc ?? true,
            },
            port as { postMessage(m: FastToSlow, t?: Transferable[]): void } | null,
            backend,
            cells?.compress && compressPort
              ? new CompressFeed(
                  { width: setup.width, height: setup.height, session: cells.session },
                  compressPort as { postMessage(m: FastToCompress, t?: Transferable[]): void },
                  quantizeTiles,
                )
              : null,
          );
        });
        post({ type: 'pipeline-ready', id: req.id, plan: pipeline.plan });
        break;
      }
      case 'pipeline-step': {
        if (down) {
          // The answer comes from the trace worker, with this request's id.
          if (!front) throw new Error('The pipeline is not running.');
          const job = await front.next();
          if (!job) {
            down.postMessage({ type: 'end', epoch, id: req.id } satisfies StageMsg);
          } else {
            down.postMessage(
              { type: 'job', epoch, id: req.id, job } satisfies StageMsg,
              jobTransferables(job),
            );
          }
          break;
        }
        if (!pipeline) throw new Error('The pipeline is not running.');
        const step = await pipeline.step();
        post({ type: 'pipeline-step', id: req.id, step }, transferablesOf(step));
        break;
      }
      case 'pipeline-stop': {
        stopPipeline();
        post({ type: 'pipeline-stopped', id: req.id });
        break;
      }
      case 'link': {
        down?.close();
        down = req.down;
        down.onmessage = (e: MessageEvent<StageFree>) => {
          if (e.data.epoch === epoch) frontPool?.release(e.data.buffer);
        };
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'connect-slow': {
        slowPort?.close();
        slowPort = req.port;
        // Slow-worker answers only record state; they are applied between batches.
        slowPort.onmessage = (e: MessageEvent<SlowToFast>) =>
          pipeline?.fastLoop?.handleSlow(e.data);
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'connect-compress': {
        compressPort?.close();
        compressPort = req.port;
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'set-discovery': {
        pipeline?.fastLoop?.setDiscovery(req.on && slowPort !== null);
        post({ type: 'ok', id: req.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: messageOf(err) });
  }
}

// One message at a time, in arrival order: an `open` must never dispose the
// headers while a `read` is awaiting its slice, nor a `pipeline-stop` free the
// pipeline while a step is running.
let queue: Promise<void> = Promise.resolve();
workerScope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};
