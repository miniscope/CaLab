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
  /** Extract on factors: solve every compressed window with `library` as job `job` (the bytes are transferred). */
  extract(session: number, job: number, library: Uint8Array): void;
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
  /** History review: the port to the review worker and the windows between two reviews. */
  review?: { port: MessagePort; every: number },
): CompressClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  const fail = (message: string): void => onMessage({ type: 'error', session: -1, message });
  worker.onmessage = (e: MessageEvent<CompressToMain>) => onMessage(e.data);
  worker.onerror = (e) => fail(e.message || 'The compress worker crashed.');
  const connect: MainToCompress = {
    type: 'connect',
    port: channel.port2,
    ...(review ? { review } : {}),
  };
  worker.postMessage(connect, [channel.port2, ...(review ? [review.port] : [])]);
  void frames
    .connectCompress?.(channel.port1)
    .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  return {
    backfill(session, version) {
      worker.postMessage({ type: 'backfill', session, version } satisfies MainToCompress);
    },
    extract(session, job, library) {
      worker.postMessage({ type: 'extract', session, job, library } satisfies MainToCompress, [
        library.buffer as ArrayBuffer,
      ]);
    },
    dispose() {
      worker.terminate();
      channel.port1.close();
    },
  };
}
