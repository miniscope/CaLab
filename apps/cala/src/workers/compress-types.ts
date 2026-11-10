/**
 * Messages between the fast worker (the one that runs the fast loop), the
 * compress worker and the main thread.
 *
 * The fast worker quantizes every batch of preprocessed frames in tile order
 * and transfers it; the compress worker writes the batches of a window to a
 * file (OPFS), compresses the window tile by tile from that file and keeps
 * the factors in a second file. Unlike the feed to the slow worker, nothing
 * is dropped: a window with a missing frame could not be replayed.
 */

/** Geometry and quantization of a run. */
export interface CompressInit {
  width: number;
  height: number;
  /** Tile edge, px. */
  tile: number;
  /** Frames per window. */
  window: number;
  /** Quantized values are `round(value * quant)`. */
  quant: number;
}

/** Fast worker -> compress worker. */
export type FastToCompress =
  | ({ type: 'init'; session: number } & CompressInit)
  | {
      type: 'chunk';
      session: number;
      /** Index of the window the frames belong to. */
      window: number;
      /** Stream index of the first frame. */
      start: number;
      count: number;
      /** The window is complete with this chunk. */
      last: boolean;
      /** `count * width * height` values in tile order (`quantizeTiles`). Transferred. */
      data: Int16Array;
    }
  /** The newest footprint library (`TraceLibrary.toBytes()`), for the back-fill. Transferred. */
  | { type: 'library'; session: number; version: number; bytes: Uint8Array }
  /** Close the open (shorter) window; `final`: the recording ended. */
  | { type: 'close'; session: number; final: boolean }
  /** Pipeline stopped or restarted: drop everything. */
  | { type: 'reset'; session: number };

export interface CompressStatus {
  /** Windows compressed so far, and the frames they hold. */
  windows: number;
  frames: number;
  /** Windows written but not compressed yet, and their frames. */
  pending: number;
  pendingFrames: number;
  /** Mean kept rank per tile of the last window. */
  meanRank: number;
  /** Compute time of the last window per frame, ms. */
  msPerFrame: number;
  /** Bytes of all factor files. */
  factorBytes: number;
  /** The recording ended and every window is compressed. */
  final: boolean;
}

/** Compress worker -> main thread. */
export type CompressToMain =
  | { type: 'status'; session: number; status: CompressStatus }
  /**
   * Back-filled traces of one window: `count * ids.length` values, frame
   * after frame, solved from the factors with library `version`. `first`
   * marks the first window of a back-fill (earlier traces are replaced).
   */
  | {
      type: 'traces';
      session: number;
      version: number;
      first: boolean;
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
    }
  /** The back-fill is complete: frames solved and wall time per frame, ms. */
  | { type: 'backfilled'; session: number; version: number; frames: number; msPerFrame: number }
  | { type: 'error'; session: number; message: string };

/** Main thread -> compress worker. */
export type MainToCompress =
  /** The port to the fast worker. */
  | { type: 'connect'; port: MessagePort }
  /**
   * Solve the traces of every compressed window with the library `version`
   * (or a newer one), once that library has arrived and no window is waiting.
   */
  | { type: 'backfill'; session: number; version: number };

export type CompressConnect = Extract<MainToCompress, { type: 'connect' }>;
