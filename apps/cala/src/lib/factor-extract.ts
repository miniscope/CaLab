import type { CompressClient } from './compress-client.ts';
import {
  fileFactorsBlocked,
  factorsBlocked,
  type CompressStore,
  type FactorInfo,
  type FactorState,
} from './compress-store.ts';

/** One Extract job in the compress worker. */
/** How an Extract job on factors ended: frames, wall ms per frame, and (with the extractor) its windows and helpers. */
export interface FactorJobDone {
  frames: number;
  msPerFrame: number;
  projected?: number;
  rebuilt?: number;
  workers?: number;
}

export interface FactorJob {
  done: Promise<FactorJobDone>;
  cancel(): void;
}

/** What `pass2-store` needs of a live stream's factors. */
export interface FactorExtractPort {
  /** This run is a `?factors` stream. */
  active(): boolean;
  /** 'stream': a `?factors` stream (waits for `ready`); 'file': a `?factors=file` recording (never waits); null: neither. */
  mode?(): 'stream' | 'file' | null;
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
 * Extract on a live stream's factors (`?factors`): one job
 * at a time in the compress worker. A job's `done` always settles: at
 * `extract-done`, its error, `cancel()`, the store's reset (the next run) or a
 * crash of the compress worker.
 */
export function createFactorExtract(
  store: CompressStore,
  client: Pick<CompressClient, 'extract' | 'extractCancel'>,
  session: () => number,
  active: () => boolean,
  ended: () => boolean,
  frames: () => number,
  fileRun: () => boolean = () => false,
): FactorExtractPort {
  let next = 1;
  let cur: {
    id: number;
    session: number;
    onWindow: Parameters<FactorExtractPort['run']>[2];
    resolve: (v: FactorJobDone) => void;
    reject: (e: Error) => void;
  } | null = null;
  const end = (err: Error | null, v?: FactorJobDone): void => {
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
    else
      end(null, {
        frames: msg.frames,
        msPerFrame: msg.msPerFrame,
        ...(msg.projected !== undefined ? { projected: msg.projected } : {}),
        ...(msg.rebuilt !== undefined ? { rebuilt: msg.rebuilt } : {}),
        ...(msg.workers !== undefined ? { workers: msg.workers } : {}),
      });
  };
  const fileState = (): FactorState => store.fileFactors(ended(), frames());
  return {
    active,
    mode: () => (active() ? 'stream' : fileRun() ? 'file' : null),
    state: () => (fileRun() && !active() ? fileState() : store.factors(ended(), frames())),
    blocked: () =>
      fileRun() && !active()
        ? fileFactorsBlocked(fileState(), store.status(), store.error(), frames())
        : factorsBlocked(store.factors(ended(), frames()), store.status(), store.error()),
    changed: () => store.changed(),
    info: () => store.factorInfo(),
    run(version, library, onWindow) {
      end(new Error('Another Extract started.'));
      const id = next++;
      const s = session();
      const done = new Promise<FactorJobDone>((resolve, reject) => {
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
