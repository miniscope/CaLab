import { vi } from 'vitest';
import { createFrameClient, type FrameClient, type WorkerLike } from '../lib/frame-client.ts';

/** A worker that records what it is sent and never answers. */
export function inertWorker(): WorkerLike {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
}

/**
 * A frame client over `frame` as its frame worker. The motion and trace workers are
 * `stages` (default: inert), and there is no flat-field worker. The client posts `link`
 * to `frame` on creation (request id 1).
 */
export function frameClientOn(
  frame: WorkerLike,
  stages: { motion?: WorkerLike; trace?: WorkerLike } = {},
): FrameClient {
  const motion = stages.motion ?? inertWorker();
  const trace = stages.trace ?? inertWorker();
  return createFrameClient(() => frame, {
    makeMotionWorker: () => motion,
    makeTraceWorker: () => trace,
    makeFlatFieldWorker: false,
  });
}
