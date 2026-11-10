/**
 * Messages between the fast worker (frame worker: read, preprocess, motion,
 * trace solve), the slow worker (cell discovery) and the main thread.
 *
 * The fast and slow workers talk over a `MessageChannel` whose ports the main
 * thread hands out, so the frame path never goes through the UI thread. Every
 * message carries the pipeline `session`; a restart bumps it and late messages
 * of the old session are dropped.
 */

/** Settings and calibration the slow loop starts from. */
export interface SlowInit {
  width: number;
  height: number;
  /** FOV mask of the preprocessor (1 = inside). */
  fov: Uint8Array;
  /** Per-pixel noise sigma of the preprocessed frames. */
  noise: Float32Array;
  cellDiameterPx: number;
  /** Flattening sigma, px (0 = derived from the cell diameter). */
  flattenSigmaPx: number;
  /** Slow-loop work units per observed frame (about multiply-adds). */
  budget: number;
}

/** Fast worker -> slow worker. */
export type FastToSlow =
  | ({ type: 'init'; session: number } & SlowInit)
  | {
      type: 'frames';
      session: number;
      /** Stream index of the first frame. */
      start: number;
      count: number;
      /** Library version that produced the traces (0 = the empty start library). */
      version: number;
      /** Cells per frame in `traces`. */
      cells: number;
      /**
       * Pooled buffer, at least `count * width * height` preprocessed frames.
       * Transferred; the slow worker sends it back in its `ack`.
       */
      frames: Float32Array;
      /** `count * cells` traces, library slot order. */
      traces: Float32Array;
      /** A newer noise map, sent every few hundred frames. */
      noise?: Float32Array;
    }
  /** The recording ended: publish what is pending. */
  | { type: 'end'; session: number }
  /** Pipeline stopped or restarted: drop the slow loop. */
  | { type: 'reset'; session: number };

/** Slow worker -> fast worker. */
export type SlowToFast =
  /** A `frames` batch was consumed; its buffer comes back for reuse. */
  | {
      type: 'ack';
      session: number;
      frames: Float32Array;
      start: number;
      count: number;
      /** Frames of the batch the slow loop observed (others came from a version it no longer holds). */
      observed: number;
    }
  /** A published library, `TraceLibrary.toBytes()`. */
  | { type: 'library'; session: number; version: number; bytes: Uint8Array };

/** Slow-loop counters (`SlowLoop.stats()`). */
export interface SlowCounters {
  visits: number;
  proposals: number;
  adds: number;
  rejects: number;
  merges: number;
  mergeTests: number;
  refines: number;
  commits: number;
  /** Cells deleted (silent or unsupported), split in two, and candidates absorbed by a neighbour. */
  deletes: number;
  splits: number;
  absorbs: number;
  /**
   * Add classification (cumulative; 0 from an older WASM build): adds at a
   * fresh spot, adds where a cell was just removed, adds removed again soon
   * after (counted at the removal), and merges/deletes of established cells.
   */
  newAdds: number;
  reAdds: number;
  churned: number;
  establishedRemovals: number;
}

/** Evidence status of the working-set cells (`SlowLoop.cellStatus()`). */
export interface CellStatusView {
  ids: Uint32Array;
  /** 1 = established (enough transients since birth), 0 = on probation. */
  established: Uint8Array;
}

export interface SlowStatus {
  /** Stream index after the last observed frame. */
  frame: number;
  /** Frames observed so far, and frames received but not observed. */
  observed: number;
  skipped: number;
  /** Cells in the working set (published or not). */
  cells: number;
  /** Last published version (0 = none yet). */
  version: number;
  counters: SlowCounters;
  reservoirBytes: number;
  /** Wall time of the last batch (observe + step), and its longest single step, ms. */
  batchMs: number;
  maxStepMs: number;
  /** The recording ended and the final library is out. */
  final: boolean;
  /** Probation/established per cell, about once a second. */
  cellStatus?: CellStatusView;
}

/** A published library, flattened for drawing (unfiltered footprints). */
export interface LibraryView {
  version: number;
  /** Stream frame after which it was published. */
  frame: number;
  width: number;
  height: number;
  ids: Uint32Array;
  /** `(y, x)` per cell, interleaved. */
  centers: Float32Array;
  radii: Float32Array;
  /** Cell `i` owns `pixels[starts[i]..starts[i + 1]]` and the same `values`. */
  starts: Uint32Array;
  pixels: Uint32Array;
  values: Float32Array;
}

/** Slow worker -> main thread. */
export type SlowToMain =
  | { type: 'status'; session: number; status: SlowStatus }
  | { type: 'library'; session: number; library: LibraryView }
  | { type: 'error'; session: number; message: string };

/** Main thread -> slow worker: the port to the fast worker. */
export interface SlowConnect {
  type: 'connect';
  port: MessagePort;
}

/** The part of a `MessagePort` (or worker scope) the loops use, so tests can fake it. */
export interface PortLike<T> {
  postMessage(msg: T, transfer?: Transferable[]): void;
}

export function libraryViewTransferables(v: LibraryView): ArrayBuffer[] {
  return [v.ids, v.centers, v.radii, v.starts, v.pixels, v.values].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
