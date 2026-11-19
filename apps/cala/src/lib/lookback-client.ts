/**
 * Main-thread side of look-back (experimental; see `lookback-reader.ts` and
 * `SlowRunner`): starts the look-back worker on the first Discover run with
 * look-back on, wires a `MessageChannel` between it and the slow worker,
 * and feeds it what Discover records as it goes (motion and flicker rows,
 * the back half's state from stage C, the newest flat-field map). The
 * pipeline store calls it (`createPipelineStore`'s `lookback`).
 */
import type { FlatFieldMap } from './flat-field.ts';
import type { BackStateSnapshot } from './pipeline-engine.ts';
import type { SlowClient } from './slow-client.ts';
import type { LookbackSource, LookbackToMain, MainToLookback } from '../workers/lookback-types.ts';

/** What the pipeline store feeds look-back (all per Discover `session`). */
export interface LookbackFeed {
  /** Why look-back cannot run on the open recording (null: it can). */
  blocked(): string | null;
  /** A Discover run with look-back starts; false: it cannot (nothing was started). */
  begin(session: number): boolean;
  /** Discover recorded frames `start..start + dy.length` (the arrays are copied). */
  rows(
    session: number,
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    flags: ArrayLike<number>,
    flickerOffset: ArrayLike<number>,
    flickerGain: ArrayLike<number>,
  ): void;
  /** Stage C's back-half state (transferred on). */
  backState(session: number, snap: BackStateSnapshot): void;
  flatField(session: number, map: FlatFieldMap | null): void;
  /** The run stopped. */
  reset(session: number): void;
}

export type LookbackWorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

export interface LookbackClientOptions {
  slow: Pick<SlowClient, 'connectLookback'>;
  /** The open recording's files (null: none, or a live source). */
  source: () => LookbackSource | null;
  /** Why look-back cannot run besides the source (a live stream, a Joint run, no pipelined workers). */
  blocked: () => string | null;
  /** A look-back worker error (it stops look-back for the run; Discover goes on). */
  onError?: (session: number, message: string) => void;
  makeWorker?: () => LookbackWorkerLike;
  makeChannel?: () => { port1: MessagePort; port2: MessagePort };
}

export function createLookbackClient(o: LookbackClientOptions): LookbackFeed & {
  dispose(): void;
} {
  let worker: LookbackWorkerLike | null = null;
  const post = (msg: MainToLookback, transfer: Transferable[] = []) =>
    worker?.postMessage(msg, transfer);

  function ensureWorker(): void {
    if (worker) return;
    const w =
      o.makeWorker?.() ??
      new Worker(new URL('../workers/lookback-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<LookbackToMain>) => o.onError?.(e.data.session, e.data.message);
    w.onerror = (e) => o.onError?.(-1, e.message || 'The look-back worker crashed.');
    const ch = o.makeChannel?.() ?? new MessageChannel();
    w.postMessage({ type: 'connect', port: ch.port2 } satisfies MainToLookback, [ch.port2]);
    o.slow.connectLookback(ch.port1);
    worker = w;
  }

  return {
    blocked() {
      return o.blocked() ?? (o.source() ? null : 'Open a recording on disk first.');
    },
    begin(session) {
      const source = o.source();
      if (!source || o.blocked() !== null) return false;
      ensureWorker();
      post({ type: 'begin', session, source });
      return true;
    },
    rows(session, start, dy, dx, flags, flickerOffset, flickerGain) {
      const arrays = {
        dy: Float32Array.from(dy),
        dx: Float32Array.from(dx),
        flags: Uint8Array.from(flags),
        flickerOffset: Float32Array.from(flickerOffset),
        flickerGain: Float32Array.from(flickerGain),
      };
      post(
        { type: 'rows', session, start, ...arrays },
        Object.values(arrays).map((a) => a.buffer),
      );
    },
    backState(session, snap) {
      post({ type: 'back-state', session, frame: snap.frame, state: snap.state }, [
        snap.state.buffer as ArrayBuffer,
      ]);
    },
    flatField(session, map) {
      // Copied (the pipeline store keeps its map).
      post({ type: 'flat', session, map });
    },
    reset(session) {
      post({ type: 'reset', session });
    },
    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}
