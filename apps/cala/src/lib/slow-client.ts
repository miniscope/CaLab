/**
 * Main-thread side of the slow worker (cell discovery): starts it, wires a
 * `MessageChannel` between it and the frame worker (so frames go worker to
 * worker), and passes its status and libraries to a listener.
 */
import type { FrameClient } from './frame-client.ts';
import type { SlowConnect, SlowToMain } from '../workers/slow-types.ts';

export interface SlowClient {
  dispose(): void;
}

export type SlowWorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

export function createSlowClient(
  frames: Pick<FrameClient, 'connectSlow'>,
  onMessage: (msg: SlowToMain) => void,
  makeWorker: () => SlowWorkerLike = () =>
    new Worker(new URL('../workers/slow-worker.ts', import.meta.url), { type: 'module' }),
): SlowClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  worker.onmessage = (e: MessageEvent<SlowToMain>) => onMessage(e.data);
  worker.onerror = (e) =>
    onMessage({ type: 'error', session: -1, message: e.message || 'The slow worker crashed.' });
  const connect: SlowConnect = { type: 'connect', port: channel.port2 };
  worker.postMessage(connect, [channel.port2]);
  void frames.connectSlow?.(channel.port1).catch((err: unknown) =>
    onMessage({
      type: 'error',
      session: -1,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  return {
    dispose() {
      worker.terminate();
      channel.port1.close();
    },
  };
}
