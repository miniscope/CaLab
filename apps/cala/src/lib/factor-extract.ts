/**
 * The factors of a run, as the Extract and Refine stores see them
 * (compression on): whether the next replay compresses, and Extract on
 * factors through the compress worker. Absent when compression is off
 * (`?compress=off`): the stores then replay the file as before.
 */
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
}

/** What a replay needs: its compress settings, and where its outcome goes. */
export interface ReplayCompressLike {
  /** The compress settings of a replay about to start over `frames` frames: on the offset grids when no factors exist, else none. */
  replayCompress(
    frames: number,
  ): Pick<CellsSettings, 'compress' | 'compressTiling' | 'compressSession'>;
  /** The replay ended; `ok` false: cut short (its windows are dropped). */
  replayEnded(ok: boolean): void;
  /** The replay's projections, for a later factor Extract's FOV images. */
  keepProjection(p: FovProjections): void;
}

export interface Pass2Factors extends ReplayCompressLike {
  state(frames: number): FactorState;
  /**
   * Solve every window with `library`; `onWindow` gets them in stream order.
   * Rejects when the job fails or can no longer be answered; a caller keeps
   * the windows only once it resolves.
   */
  extract(
    library: Uint8Array,
    onWindow: (w: FactorWindowTraces) => void,
  ): Promise<{ frames: number; msPerFrame: number }>;
  projection(): FovProjections | null;
  /** Tiling and mean rank of the replay's factors (null: no replay factors). */
  info(): { tiling: CompressTiling; meanRank: number } | null;
}

export function createPass2Factors(
  store: CompressStore,
  client: Pick<CompressClient, 'extract'>,
  session: () => number,
): Pass2Factors {
  let nextJob = 1;
  return {
    state: (frames) => store.factors(frames),
    replayCompress(frames) {
      if (store.factors(frames) !== 'none') return {};
      store.markReplay();
      return { compress: true, compressTiling: 'offset', compressSession: session() };
    },
    replayEnded: (ok) => store.replayEnded(ok),
    keepProjection: (p) => store.keepProjection(p),
    projection: () => store.projection(),
    info() {
      const s = store.status();
      return s && s.source === 'replay' ? { tiling: s.tiling, meanRank: s.meanRank } : null;
    },
    extract(library, onWindow) {
      const job = nextJob++;
      return new Promise((resolve, reject) => {
        const stop = store.onExtract((m) => {
          if (m.type === 'abort') {
            stop();
            reject(new Error(m.message));
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
        client.extract(session(), job, library.slice());
      });
    },
  };
}
