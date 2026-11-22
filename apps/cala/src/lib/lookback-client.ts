/**
 * Main-thread side of look-back (experimental; see `lookback-reader.ts` and
 * `SlowRunner`): starts the look-back worker on the first Discover run with
 * look-back on, wires a `MessageChannel` between it and the slow worker,
 * and feeds it what Discover records as it goes (motion and flicker rows,
 * the back half's state from stage C, the newest flat-field map). The
 * pipeline store calls it (`createPipelineStore`'s `lookback`).
 *
 * Look-back pool (work-slider PR 5, `?debug&lbpool=S`): `workers` = S + 1
 * look-back workers, each with its own channel to the slow worker (index 0
 * need-driven look-back and the end settle, 1..S the settle's chunks), and
 * each fed its own copy of everything above. They live as long as the page,
 * like the single worker; a run's `reset` closes each one's recording.
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
  /** The pacer's target live fps (0: Max) and pause, for the settle governor (`SlowRunner.setPace`). */
  pace?(fps: number, paused: boolean): void;
}

export type LookbackWorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

export interface LookbackClientOptions {
  slow: Pick<SlowClient, 'connectLookback'> & Partial<Pick<SlowClient, 'settlePace'>>;
  /** Look-back workers (1 + the settle pool's S; default 1). */
  workers?: number;
  /** The open recording's files (null: none, or a live source). */
  source: () => LookbackSource | null;
  /** Why look-back cannot run besides the source (a live stream, a Joint run, no pipelined workers). */
  blocked: () => string | null;
  /** A look-back worker error (worker 0: it stops look-back for the run; a pool worker: that worker only; Discover goes on). */
  onError?: (session: number, message: string, worker: number) => void;
  makeWorker?: () => LookbackWorkerLike;
  makeChannel?: () => { port1: MessagePort; port2: MessagePort };
}

export function createLookbackClient(o: LookbackClientOptions): LookbackFeed & {
  dispose(): void;
} {
  const count = Math.max(1, Math.floor(o.workers ?? 1));
  let workers: LookbackWorkerLike[] = [];
  /** The same message to every worker; `copy(i)` gives worker `i` its own payload and transfer list. */
  function postAll(copy: (i: number) => [MainToLookback, Transferable[]]): void {
    workers.forEach((w, i) => {
      const [msg, transfer] = copy(i);
      w.postMessage(msg, transfer);
    });
  }

  function ensureWorkers(): void {
    if (workers.length > 0) return;
    for (let i = 0; i < count; i++) {
      const w =
        o.makeWorker?.() ??
        new Worker(new URL('../workers/lookback-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<LookbackToMain>) =>
        o.onError?.(e.data.session, e.data.message, i);
      w.onerror = (e) => o.onError?.(-1, e.message || `Look-back worker ${i} crashed.`, i);
      const ch = o.makeChannel?.() ?? new MessageChannel();
      w.postMessage({ type: 'connect', port: ch.port2 } satisfies MainToLookback, [ch.port2]);
      o.slow.connectLookback(ch.port1, i);
      workers.push(w);
    }
  }

  return {
    blocked() {
      return o.blocked() ?? (o.source() ? null : 'Open a recording on disk first.');
    },
    begin(session) {
      const source = o.source();
      if (!source || o.blocked() !== null) return false;
      ensureWorkers();
      postAll(() => [{ type: 'begin', session, source }, []]);
      return true;
    },
    rows(session, start, dy, dx, flags, flickerOffset, flickerGain) {
      // Copies per worker (each is transferred).
      postAll(() => {
        const arrays = {
          dy: Float32Array.from(dy),
          dx: Float32Array.from(dx),
          flags: Uint8Array.from(flags),
          flickerOffset: Float32Array.from(flickerOffset),
          flickerGain: Float32Array.from(flickerGain),
        };
        return [
          { type: 'rows', session, start, ...arrays },
          Object.values(arrays).map((a) => a.buffer),
        ];
      });
    },
    backState(session, snap) {
      // The snapshot's own buffer goes to the last worker; the others get copies.
      postAll((i) => {
        const state = i === workers.length - 1 ? snap.state : snap.state.slice();
        return [
          { type: 'back-state', session, frame: snap.frame, state },
          [state.buffer as ArrayBuffer],
        ];
      });
    },
    flatField(session, map) {
      // Copied (the pipeline store keeps its map).
      postAll(() => [{ type: 'flat', session, map }, []]);
    },
    reset(session) {
      postAll(() => [{ type: 'reset', session }, []]);
    },
    pace(fps, paused) {
      o.slow.settlePace?.(fps, paused);
    },
    dispose() {
      for (const w of workers) w.terminate();
      workers = [];
    },
  };
}
