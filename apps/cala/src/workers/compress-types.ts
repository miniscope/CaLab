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
  | { type: 'error'; session: number; message: string };

/** Main thread -> compress worker: the port to the fast worker. */
export interface CompressConnect {
  type: 'connect';
  port: MessagePort;
}
