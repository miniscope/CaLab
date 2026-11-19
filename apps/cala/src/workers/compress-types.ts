/**
 * Messages between the fast worker (the one that runs the fast loop), the
 * compress worker and the main thread.
 *
 * The fast worker transfers a copy of every batch of preprocessed frames;
 * the compress worker quantizes it in tile order, writes the batches of a
 * window to a file (OPFS), compresses the window tile by tile from that file
 * and keeps the factors in a second file. Unlike the feed to the slow worker, nothing
 * is dropped: a window with a missing frame could not be replayed.
 */

/** How a frame is cut into tiles (`Tiling` in crates/cala): side by side, or on two grids offset by half a tile. */
export type CompressTiling = 'plain' | 'offset';
/**
 * Which frames a run of windows holds: Discover's, preprocessed with the
 * calibration of the moment, or a replay's, with the final calibration.
 */
export type CompressSource = 'discover' | 'replay';

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
  /** How the frame is cut into tiles. */
  tiling: CompressTiling;
  /** Which frames the windows hold. */
  source: CompressSource;
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
      /** `count * width * height` values, frame after frame. Transferred. */
      data: Float32Array;
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
  /**
   * Compute time per frame (quantizing and compressing), ms: the total over all
   * windows compressed in this session divided by their frames (0 before the first).
   */
  msPerFrame: number;
  /** Bytes of all factor files. */
  factorBytes: number;
  /** The recording ended and every window is compressed. */
  final: boolean;
  /** How the tiles of the factor files are cut. */
  tiling: CompressTiling;
  /** Which frames the factor files hold. */
  source: CompressSource;
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
  /**
   * Extract on factors, job `job`: one window's traces and signed traces
   * (`count * ids.length` each, frame after frame; `signed` empty when the
   * engine gave none), in stream order. `minValid`: the window's smallest
   * valid share per cell, in the order of the trace columns.
   */
  | {
      type: 'extracted';
      session: number;
      job: number;
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
      signed: Float32Array;
      minValid: Float32Array;
    }
  /** Extract on factors, job `job`, is complete. */
  | { type: 'extract-done'; session: number; job: number; frames: number; msPerFrame: number }
  /** `job`: the error of that Extract job (the factors stay usable); absent: the compression's. */
  | { type: 'error'; session: number; message: string; job?: number };

/** Main thread -> compress worker. */
export type MainToCompress =
  /**
   * The port to the fast worker and, with the history review on, the port to
   * the review worker and the closed windows between two reviews.
   */
  | {
      type: 'connect';
      port: MessagePort;
      /**
       * The OPFS run folder this worker owns (`cala-compress/<run>`), named by
       * the main thread so that the slow worker can read its factor files
       * (absent: a name of the worker's own).
       */
      run?: string;
      review?: { port: MessagePort; every: number };
    }
  /**
   * Solve the traces of every compressed window with the library `version`
   * (or a newer one), once that library has arrived and no window is waiting.
   */
  | { type: 'backfill'; session: number; version: number }
  /**
   * Extract on factors: solve every compressed window with `library`
   * (`TraceLibrary.toBytes()`, transferred) and post them as job `job`.
   */
  | { type: 'extract'; session: number; job: number; library: Uint8Array };
