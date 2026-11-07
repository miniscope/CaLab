/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and transfers each decoded
 * batch back as a Transferable. Also runs the preprocess + motion pipeline
 * (`PipelineEngine`), one step per request, so the pipeline reads frames
 * without a round trip through the main thread.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { PipelineEngine, transferablesOf } from '../lib/pipeline-engine.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';

let source: FrameSource | null = null;
let pipeline: PipelineEngine | null = null;

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
        pipeline = new PipelineEngine(source, req.options);
        post({ type: 'pipeline-ready', id: req.id, plan: pipeline.plan });
        break;
      }
      case 'pipeline-step': {
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
