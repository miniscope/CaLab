/**
 * The factors of a run, as the Extract and Refine stores see them
 * (compression on): whether the next replay compresses, and Extract on
 * factors through the compress worker. Absent when compression is off
 * (`?compress=off`): the stores then replay the file as before.
 */
import { untrack } from 'solid-js';
import type { CompressClient } from './compress-client.ts';
import type { CompressStore, FactorState } from './compress-store.ts';
import type { FovProjections } from './fov-projection.ts';
import type { CompressTiling } from '../workers/compress-types.ts';
import type { CellsSettings } from '../workers/frame-types.ts';

/** One window of a factor Extract: `count * ids.length` traces and signed traces (empty: none). */
export interface FactorWindowTraces {
  start: number;
  count: number;
  ids: Uint32Array;
  traces: Float32Array;
  signed: Float32Array;
  /** The window's smallest valid share per cell, in trace order. */
  minValid: Float32Array;
}

/** How many cells have a value below 1 (absent values: undefined, a replay of the file). */
export function lowValidCells(minValid: Float32Array | undefined): number | undefined {
  if (!minValid) return undefined;
  let n = 0;
  for (const v of minValid) if (v < 1) n++;
  return n;
}

/** The Run panel's sentence on the cells of a factor Extract that are below 1 (empty: none). */
export function lowValidText(n: number): string {
  if (n <= 0) return '';
  return n === 1
    ? "1 cell has pixels without data in its footprint; its trace can differ from a file replay's."
    : `${n} cells have pixels without data in their footprint; their traces can differ from a file replay's.`;
}

/** What a replay about to start gets: its compress settings and how it reports its end. */
export interface ReplayCompress {
  /** On the offset grids when no factors exist, else empty. */
  settings: Pick<CellsSettings, 'compress' | 'compressTiling' | 'compressSession'>;
  /**
   * The replay ended; `ok` false: cut short (its windows are dropped). Frees
   * the compress mark only when this replay took it; otherwise does nothing.
   */
  ended(ok: boolean): void;
}

/** What a replay needs: its compress settings, and where its outcome goes. */
export interface ReplayCompressLike {
  /** The compress settings of a replay about to start over `frames` frames. */
  replayCompress(frames: number): ReplayCompress;
  /** The replay's projections, for a later factor Extract's FOV images. */
  keepProjection(p: FovProjections): void;
}

/** A replay that does not compress: no settings, and its end tells no one. */
export const NO_COMPRESS: ReplayCompress = { settings: {}, ended() {} };

/**
 * `ended` that reports only its first call: a replay ends once, however many
 * paths see it end (a finished replay stays finished when a later stop or
 * error of its stage reports it again).
 */
export function endOnce(ended: (ok: boolean) => void): (ok: boolean) => void {
  let open = true;
  return (ok) => {
    if (!open) return;
    open = false;
    ended(ok);
  };
}

/**
 * A factor Extract job ended because a new run reset the compress store (a
 * new Discover, another recording, the next session). Not a failure of the
 * factors: the next Extract may read them.
 */
export class ExtractAborted extends Error {
  override name = 'ExtractAborted';
}

export interface Pass2Factors extends ReplayCompressLike {
  state(frames: number): FactorState;
  /**
   * Solve every window with `library`; `onWindow` gets them in stream order.
   * Rejects when the job fails or can no longer be answered (`ExtractAborted`
   * after a reset); a caller keeps the windows only once it resolves.
   */
  extract(
    library: Uint8Array,
    onWindow: (w: FactorWindowTraces) => void,
  ): Promise<{ frames: number; msPerFrame: number }>;
  projection(): FovProjections | null;
  /** Tiling and mean rank of the replay's factors (null: no replay factors). */
  info(): { tiling: CompressTiling; meanRank: number } | null;
}

/** What Refine on the factors needs of the run's factors (`?refine=factors`). */
export interface FactorFilesLike extends ReplayCompressLike {
  state(frames: number): FactorState;
  /**
   * The factor files the slow worker may open now: once the factors are
   * ready (the compress worker has closed every file) and no Extract job
   * reads them. Null: not now, or no run folder is known.
   */
  files(frames: number): { folder: string; windows: number } | null;
  info(): { tiling: CompressTiling; meanRank: number } | null;
  /** Whose factors these are: a file's compression replay, or a live run's Discover. */
  origin(): 'replay' | 'discover';
  /** Windows waiting to be compressed. */
  pending(): number;
  /** The compression's error (null: none). */
  compressionError(): string | null;
}

export function createPass2Factors(
  store: CompressStore,
  client: Pick<CompressClient, 'extract'> & Partial<Pick<CompressClient, 'folder'>>,
): Pass2Factors & FactorFilesLike {
  let nextJob = 1;
  return {
    state: (frames) => store.factors(frames),
    replayCompress(frames) {
      // Read untracked: a caller inside an effect must not re-run when the mark changes.
      if (untrack(() => store.factors(frames)) !== 'none') return NO_COMPRESS;
      const ended = store.markReplay();
      return {
        settings: { compress: true, compressTiling: 'offset', compressSession: store.session() },
        ended,
      };
    },
    keepProjection: (p) => store.keepProjection(p),
    projection: () => store.projection(),
    info() {
      const s = store.status();
      // A live run's factors are Discover's own windows.
      return s && (s.source === 'replay' || store.live())
        ? { tiling: s.tiling, meanRank: s.meanRank }
        : null;
    },
    files(frames) {
      const s = store.status();
      if (!client.folder || !s || store.factors(frames) !== 'ready' || store.jobsOut() > 0)
        return null;
      return { folder: client.folder, windows: s.windows };
    },
    origin: () => (store.live() ? 'discover' : 'replay'),
    pending: () => store.status()?.pending ?? 0,
    compressionError: () => store.error(),
    extract(library, onWindow) {
      const job = nextJob++;
      return new Promise((resolve, reject) => {
        const stop = store.onExtract((m) => {
          if (m.type === 'abort') {
            stop();
            reject(m.reset ? new ExtractAborted(m.message) : new Error(m.message));
          } else if (m.job !== job) return;
          else if (m.type === 'extracted') onWindow(m);
          else if (m.type === 'extract-done') {
            stop();
            resolve({ frames: m.frames, msPerFrame: m.msPerFrame });
          } else {
            stop();
            reject(new Error(m.message));
          }
        });
        store.jobSent(job);
        client.extract(store.session(), job, library.slice());
      });
    },
  };
}
