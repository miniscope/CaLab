/**
 * Main-thread side of the compress worker: starts it, wires a
 * `MessageChannel` between it and the fast worker (so frames go worker to
 * worker), and passes its status to a listener.
 */
import type { FrameClient } from './frame-client.ts';
import type { CompressToMain, MainToCompress } from '../workers/compress-types.ts';

export interface CompressClient {
  /** Ask for the traces of every compressed window, solved with library `version`. */
  backfill(session: number, version: number): void;
  dispose(): void;
}

export type CompressWorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

export function createCompressClient(
  frames: Pick<FrameClient, 'connectCompress'>,
  onMessage: (msg: CompressToMain) => void,
  makeWorker: () => CompressWorkerLike = () =>
    new Worker(new URL('../workers/compress-worker.ts', import.meta.url), { type: 'module' }),
): CompressClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  const fail = (message: string): void => onMessage({ type: 'error', session: -1, message });
  worker.onmessage = (e: MessageEvent<CompressToMain>) => onMessage(e.data);
  worker.onerror = (e) => fail(e.message || 'The compress worker crashed.');
  const connect: MainToCompress = { type: 'connect', port: channel.port2 };
  worker.postMessage(connect, [channel.port2]);
  void frames
    .connectCompress?.(channel.port1)
    .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  return {
    backfill(session, version) {
      worker.postMessage({ type: 'backfill', session, version } satisfies MainToCompress);
    },
    dispose() {
      worker.terminate();
      channel.port1.close();
    },
  };
}
