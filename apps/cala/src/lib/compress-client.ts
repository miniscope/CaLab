/**
 * Main-thread side of the compress worker: starts it, wires a
 * `MessageChannel` between it and the fast worker (so frames go worker to
 * worker), and passes its status to a listener. With `helpers`, it also
 * starts that many compress helpers, each with a channel to the compress
 * worker, and tells the compress worker when one crashes. `releaseHelpers`
 * ends the helpers (only ending a worker returns its WASM memory); a run, a
 * back-fill or an Extract started after it gets new ones (`helpersReady`).
 */
import type { FrameClient } from './frame-client.ts';
import type { CompressToMain, MainToCompress } from '../workers/compress-types.ts';
import { errMsg } from './errors.ts';

export interface CompressClient {
  /** Ask for the traces of every compressed window, solved with library `version`. */
  backfill(session: number, version: number): void;
  /** Extract on a stream's factors: solve every window with `library` (transferred). */
  extract(session: number, job: number, version: number, library: Uint8Array): void;
  extractCancel(session: number, job: number): void;
  /** Compress no more for this run and drop its files. */
  stop(session: number): void;
  /**
   * End the helpers while nothing is compressed or extracted (the compress worker keeps its
   * files and does any work itself until they are back).
   */
  releaseHelpers(): void;
  /** Start the helpers again if `releaseHelpers` ended them (before a run compresses). */
  helpersReady(): void;
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
  const helperCount = Math.max(0, helpers?.count ?? 0);
  /** Helper `k` on a new channel; returns the compress worker's end of it. */
  function startHelper(k: number): { worker: CompressWorkerLike; port: MessagePort } {
    const h = makeHelper();
    const ch = new MessageChannel();
    h.onerror = (e) => {
      e.preventDefault?.();
      console.warn(`cala compress helper ${k}: ${e.message || 'crashed'}`);
      worker.postMessage({ type: 'helper-lost', helper: k } satisfies MainToCompress);
    };
    h.postMessage({ port: ch.port1 }, [ch.port1]);
    return { worker: h, port: ch.port2 };
  }
  let helperWorkers: CompressWorkerLike[] = [];
  const helperPorts: MessagePort[] = [];
  for (let k = 0; k < helperCount; k++) {
    const h = startHelper(k);
    helperWorkers.push(h.worker);
    helperPorts.push(h.port);
  }
  let helpersLive = true;
  function helpersReady(): void {
    if (helpersLive) return;
    helpersLive = true;
    helperWorkers = [];
    for (let k = 0; k < helperCount; k++) {
      const h = startHelper(k);
      helperWorkers.push(h.worker);
      worker.postMessage(
        { type: 'helper-revive', helper: k, port: h.port } satisfies MainToCompress,
        [h.port],
      );
    }
  }
  const connect: MainToCompress = {
    type: 'connect',
    port: channel.port2,
    ...(review ? { review } : {}),
    ...(helperPorts.length > 0 ? { helpers: helperPorts } : {}),
  };
  worker.postMessage(connect, [channel.port2, ...(review ? [review.port] : []), ...helperPorts]);
  void frames.connectCompress?.(channel.port1).catch((err: unknown) => fail(errMsg(err)));
  return {
    backfill(session, version) {
      helpersReady();
      worker.postMessage({ type: 'backfill', session, version } satisfies MainToCompress);
    },
    extract(session, job, version, library) {
      helpersReady();
      worker.postMessage(
        { type: 'extract', session, job, version, library } satisfies MainToCompress,
        [library.buffer as ArrayBuffer],
      );
    },
    extractCancel(session, job) {
      worker.postMessage({ type: 'extract-cancel', session, job } satisfies MainToCompress);
    },
    stop(session) {
      worker.postMessage({ type: 'stop', session } satisfies MainToCompress);
    },
    releaseHelpers() {
      if (!helpersLive || helperCount === 0) return;
      helpersLive = false;
      for (let k = 0; k < helperWorkers.length; k++) {
        helperWorkers[k].terminate();
        worker.postMessage({ type: 'helper-lost', helper: k } satisfies MainToCompress);
      }
      helperWorkers = [];
    },
    helpersReady,
    dispose() {
      worker.terminate();
      for (const h of helperWorkers) h.terminate();
      channel.port1.close();
    },
  };
}
