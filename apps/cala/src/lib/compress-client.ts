/**
 * Main-thread side of the compress worker: starts it, wires a
 * `MessageChannel` between it and the fast worker (so frames go worker to
 * worker), and passes its status to a listener. With `helpers`, it also
 * starts that many compress helpers, each with a channel to the compress
 * worker, and tells the compress worker when one crashes.
 */
import type { FrameClient } from './frame-client.ts';
import type { CompressToMain, MainToCompress } from '../workers/compress-types.ts';

export interface CompressClient {
  /** Ask for the traces of every compressed window, solved with library `version`. */
  backfill(session: number, version: number): void;
  /** Extract on a stream's factors: solve every window with `library` (transferred). */
  extract(session: number, job: number, version: number, library: Uint8Array): void;
  extractCancel(session: number, job: number): void;
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
  /** Compress helpers to start (`compress-helper-worker.ts`; default none). */
  helpers?: { count: number; make?: () => CompressWorkerLike },
): CompressClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  const fail = (message: string): void => onMessage({ type: 'error', session: -1, message });
  worker.onmessage = (e: MessageEvent<CompressToMain>) => onMessage(e.data);
  worker.onerror = (e) => fail(e.message || 'The compress worker crashed.');
  const makeHelper =
    helpers?.make ??
    (() =>
      new Worker(new URL('../workers/compress-helper-worker.ts', import.meta.url), {
        type: 'module',
      }));
  const helperWorkers: CompressWorkerLike[] = [];
  const helperPorts: MessagePort[] = [];
  for (let k = 0; k < Math.max(0, helpers?.count ?? 0); k++) {
    const h = makeHelper();
    const ch = new MessageChannel();
    h.onerror = (e) => {
      e.preventDefault?.();
      console.warn(`cala compress helper ${k}: ${e.message || 'crashed'}`);
      worker.postMessage({ type: 'helper-lost', helper: k } satisfies MainToCompress);
    };
    h.postMessage({ port: ch.port1 }, [ch.port1]);
    helperWorkers.push(h);
    helperPorts.push(ch.port2);
  }
  const connect: MainToCompress = {
    type: 'connect',
    port: channel.port2,
    ...(review ? { review } : {}),
    ...(helperPorts.length > 0 ? { helpers: helperPorts } : {}),
  };
  worker.postMessage(connect, [channel.port2, ...(review ? [review.port] : []), ...helperPorts]);
  void frames
    .connectCompress?.(channel.port1)
    .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  return {
    backfill(session, version) {
      worker.postMessage({ type: 'backfill', session, version } satisfies MainToCompress);
    },
    extract(session, job, version, library) {
      worker.postMessage(
        { type: 'extract', session, job, version, library } satisfies MainToCompress,
        [library.buffer as ArrayBuffer],
      );
    },
    extractCancel(session, job) {
      worker.postMessage({ type: 'extract-cancel', session, job } satisfies MainToCompress);
    },
    dispose() {
      worker.terminate();
      for (const h of helperWorkers) h.terminate();
      channel.port1.close();
    },
  };
}
