import type { CompressClient } from './compress-client.ts';
import {
  factorsBlocked,
  type CompressStore,
  type FactorInfo,
  type FactorState,
} from './compress-store.ts';

/** One Extract job in the compress worker. */
export interface FactorJob {
  done: Promise<{ frames: number; msPerFrame: number }>;
  cancel(): void;
}

/** What `pass2-store` needs of a live stream's factors. */
export interface FactorExtractPort {
  /** This run is a `?factors` stream. */
  active(): boolean;
  state(): FactorState;
  /** Why the factors cannot be read yet or at all (null: they can). */
  blocked(): string | null;
  /** Resolves at the compressor's next status, error or reset. */
  changed(): Promise<void>;
  info(): FactorInfo | null;
  run(
    version: number,
    library: Uint8Array,
    onWindow: (
      start: number,
      count: number,
      ids: Uint32Array,
      traces: Float32Array,
      signed?: Float32Array,
    ) => void,
  ): FactorJob;
}

/**
 * Extract on a live stream's factors (`?factors`; spec decision 4): one job
 * at a time in the compress worker. A job's `done` always settles: at
 * `extract-done`, its error, `cancel()`, the store's reset (a new run) or a
 * crash of the compress worker.
 */
export function createFactorExtract(
  store: CompressStore,
  client: Pick<CompressClient, 'extract' | 'extractCancel'>,
  session: () => number,
  active: () => boolean,
  ended: () => boolean,
  frames: () => number,
): FactorExtractPort {
  let next = 1;
  let cur: {
    id: number;
    session: number;
    onWindow: Parameters<FactorExtractPort['run']>[2];
    resolve: (v: { frames: number; msPerFrame: number }) => void;
    reject: (e: Error) => void;
  } | null = null;
  const end = (err: Error | null, v?: { frames: number; msPerFrame: number }): void => {
    const c = cur;
    cur = null;
    if (!c) return;
    if (err) c.reject(err);
    else c.resolve(v!);
  };
  store.onExtract = (msg) => {
    if (msg.type === 'reset') return end(new Error('A new run started.'));
    if (!cur) return;
    if (msg.type === 'error') {
      if (msg.session === -1 || msg.job === undefined || msg.job === cur.id)
        end(new Error(msg.message));
      return;
    }
    if (msg.type !== 'extracted' && msg.type !== 'extract-done') return;
    if (msg.session !== cur.session || msg.job !== cur.id) return;
    if (msg.type === 'extracted')
      cur.onWindow(msg.start, msg.count, msg.ids, msg.traces, msg.signed);
    else end(null, { frames: msg.frames, msPerFrame: msg.msPerFrame });
  };
  return {
    active,
    state: () => store.factors(ended(), frames()),
    blocked: () => factorsBlocked(store.factors(ended(), frames()), store.status(), store.error()),
    changed: () => store.changed(),
    info: () => store.factorInfo(),
    run(version, library, onWindow) {
      end(new Error('Another Extract started.'));
      const id = next++;
      const s = session();
      const done = new Promise<{ frames: number; msPerFrame: number }>((resolve, reject) => {
        cur = { id, session: s, onWindow, resolve, reject };
      });
      client.extract(s, id, version, library.slice());
      return {
        done,
        cancel() {
          if (cur?.id !== id) return;
          client.extractCancel(s, id);
          end(new Error('cancelled'));
        },
      };
    },
  };
}
