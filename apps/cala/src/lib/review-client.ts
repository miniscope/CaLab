/**
 * Main-thread side of the review worker (history review): starts it and
 * passes its messages to a listener. `port` goes to the compress worker
 * (`createCompressClient`), which feeds the review worker directly.
 */
import type { ReviewConnect, ReviewToMain } from '../workers/review-types.ts';

export interface ReviewClient {
  /** The compress worker's end of the channel to the review worker. */
  readonly port: MessagePort;
  dispose(): void;
}

export type ReviewWorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

export function createReviewClient(
  onMessage: (msg: ReviewToMain) => void,
  makeWorker: () => ReviewWorkerLike = () =>
    new Worker(new URL('../workers/review-worker.ts', import.meta.url), { type: 'module' }),
): ReviewClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  worker.onmessage = (e: MessageEvent<ReviewToMain>) => onMessage(e.data);
  worker.onerror = (e) =>
    onMessage({ type: 'error', session: -1, message: e.message || 'The review worker crashed.' });
  const connect: ReviewConnect = { type: 'connect', port: channel.port2 };
  worker.postMessage(connect, [channel.port2]);
  return {
    port: channel.port1,
    dispose() {
      worker.terminate();
      channel.port1.close();
    },
  };
}
