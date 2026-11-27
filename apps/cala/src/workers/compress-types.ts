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
  /** Compress workers while Discover reads and after its last frame (absent: one and one). */
  pool?: { discover: number; after: number; extract?: number };
  /** The cap on window files waiting for compression, bytes (absent: from the storage estimate; `?debug&cbacklog`). */
  backlogCap?: number;
  /** Extract on factors on rebuilt frames with one engine, as before slice 6 (`?debug&fextract=0`). */
  frameExtract?: boolean;
  /**
   * Compress on the GPU (a recording's default): windows of the GPU
   * compressor's length, cut from the stream frame indices (the chunks'
   * `window` and `last` are ignored).
   */
  gpu?: boolean;
  /**
   * With `gpu`: compress the first `gpuCheck` windows (at most `GPU_CHECK_MAX`)
   * on the CPU too, once the recording's windows are done, and report how far
   * the GPU's factors are from the CPU's (`CompressStatus.check`; `?debug&gpucheck=N`).
   */
  gpuCheck?: number;
}

/**
 * The GPU's factors against the CPU's on the same windows (`?debug&gpucheck`),
 * summed over the checked tiles: `loss` = `Σ ‖Ŷ_gpu − Ŷ_cpu‖²`, `floor` =
 * `Σ ‖Ŷ_cpu2 − Ŷ_cpu‖²` (the CPU with another seed: the sketch's own noise),
 * `ref` = `Σ ‖Ŷ_cpu‖²`, `signal` = `Σ ‖Ŷ_cpu − mean‖²`, `rankDiff` = `Σ |rank_gpu − rank_cpu|`
 * and `floorRankDiff` = `Σ |rank_cpu2 − rank_cpu|`, `keptDiff` and `floorKeptDiff` the
 * same of the energy the kept components hold (what a rank difference is worth),
 * `rankDiffTiles` the tiles whose ranks differ; `ms`: the check's wall time.
 */
export interface GpuCheck {
  windows: number;
  tiles: number;
  loss: number;
  floor: number;
  ref: number;
  signal: number;
  rankDiff: number;
  floorRankDiff: number;
  keptDiff: number;
  floorKeptDiff: number;
  rankDiffTiles: number;
  ms: number;
  /** Why the check stopped early. */
  error?: string;
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
  | { type: 'reset'; session: number }
  /**
   * A GPU run: Discover waited `ms` for room in the GPU compressor's ring
   * (`CompressToFast`); `stalled`: the GPU made no progress for `GPU_STALL_S`
   * while it waited, so the run gives its factors up (`GPU_TEXT.stalled`).
   */
  | { type: 'waited'; session: number; ms: number; stalled?: boolean }
  /**
   * A GPU run: Discover begins to wait for room in the ring (a `waited` ends it).
   * The runner counts a wait still running in the share of Discover's time spent
   * waiting (`GPU_WAIT_SHARE_MAX`).
   */
  | { type: 'waiting'; session: number };

/**
 * Compress worker -> fast worker, on the same port (a GPU run only): the GPU
 * compressor's ring holds `ring` frames (`window` of them per window) and the
 * oldest frame it still needs is `keepFrom`, so the feed may send frames up to
 * `keepFrom + ring` (exclusive). Sent when the GPU opens, whenever `keepFrom`
 * moves (a window compressed) and after every batch of tiles (the GPU is at
 * work: a waiting feed's stall clock restarts). `ring` 0: the GPU route ended
 * (gave up, reset, or the recording's windows are done); the feed never waits again.
 */
export interface CompressToFast {
  type: 'room';
  session: number;
  ring: number;
  window: number;
  keepFrom: number;
}

/** A compressed window: its factor file `f<index>.bin` holds stream frames `start..start + frames`. */
export interface CompressedWindow {
  index: number;
  start: number;
  frames: number;
}

export interface CompressStatus {
  /** Windows compressed so far, and the frames they hold. */
  windows: number;
  frames: number;
  /** Windows written but not compressed yet, and their frames. */
  pending: number;
  pendingFrames: number;
  /** Mean kept rank per tile of the last window. */
  meanRank: number;
  /** Compute time of the last window per frame (quantizing and compressing), ms. */
  msPerFrame: number;
  /** Bytes of all factor files. */
  factorBytes: number;
  /** The recording ended and every window is compressed. */
  final: boolean;
  /** How the tiles of the factor files are cut. */
  tiling: CompressTiling;
  /** Which frames the factor files hold. */
  source: CompressSource;
  /** The OPFS run folder of the factor files (`WindowStore.folder`). */
  folder: string;
  /** The compressed windows, in stream order. */
  compressed: CompressedWindow[];
  // Optional for the statuses tests write by hand; the runner always sets them.
  /** Compress workers in use (the compress worker and its helpers). */
  workers?: number;
  /** Frames of the last window over its wall time. */
  fps?: number;
  /** Bytes of the window files waiting for compression (the open one included), now and at their peak. */
  backlogBytes?: number;
  backlogPeakBytes?: number;
  /** Frames sent and not compressed when the recording ended (null: not ended). */
  behindAtEnd?: number | null;
  /** Frames compressed after the recording ended over their wall time (null: none yet). */
  fpsAfter?: number | null;
  /** Frames per window (the GPU compressor's on the GPU, else the feed's). */
  window?: number;
  /** Frames the GPU compressor's ring holds (window + slack; absent: not on the GPU). */
  ring?: number;
  /** Where the windows are compressed. */
  backend?: 'cpu' | 'gpu';
  /** A GPU run: seconds Discover waited for room in the GPU's ring, and how many times. */
  waitS?: number;
  waits?: number;
  /** `?debug&gpucheck=N`: the GPU's factors against the CPU's (absent: no check, or none done yet). */
  check?: GpuCheck;
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
  /** Extract on factors: the traces of one window (`count * ids.length` values, frame after frame), solved with the job's library. */
  | {
      type: 'extracted';
      session: number;
      job: number;
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
      signed?: Float32Array;
    }
  /**
   * The Extract job solved every window: frames and wall time per frame, ms;
   * windows solved from the factors and on rebuilt frames, and the helpers used.
   */
  | {
      type: 'extract-done';
      session: number;
      job: number;
      frames: number;
      msPerFrame: number;
      projected?: number;
      rebuilt?: number;
      workers?: number;
    }
  /** `job`: the error ends that Extract job. */
  | { type: 'error'; session: number; job?: number; message: string };

/** Main thread -> compress worker. */
export type MainToCompress =
  /**
   * The port to the fast worker and, with the history review on, the port to
   * the review worker and the closed windows between two reviews.
   */
  | {
      type: 'connect';
      port: MessagePort;
      review?: { port: MessagePort; every: number };
      /** One port per compress helper (`compress-helper-worker.ts`). */
      helpers?: MessagePort[];
    }
  /** Helper `helper` crashed or was ended: its tile is redone elsewhere. */
  | { type: 'helper-lost'; helper: number }
  /** A new helper `helper` runs on `port` (after `helper-lost`): it takes work again. */
  | { type: 'helper-revive'; helper: number; port: MessagePort }
  /**
   * Solve the traces of every compressed window with the library `version`
   * (or a newer one), once that library has arrived and no window is waiting.
   */
  | { type: 'backfill'; session: number; version: number }
  /** Extract on factors: solve every compressed window with `library` (a `TraceLibrary.toBytes()`). */
  | { type: 'extract'; session: number; job: number; version: number; library: Uint8Array }
  | { type: 'extract-cancel'; session: number; job: number }
  /**
   * A recording's settle re-reads the file: compress no more, drop the run's
   * window and factor files (no stage will read them).
   */
  | { type: 'stop'; session: number };

/**
 * Compress worker -> a compress helper. `tile`: compress the first
 * `frames * w * h` values of `raw` (transferred) with `seed`; `epoch` comes
 * back with the answer.
 */
export type CoordinatorToHelper =
  | { type: 'init'; quant: number }
  /** An Extract job: the library its windows are solved with (`TraceLibrary.toBytes()`). */
  | { type: 'extract-begin'; job: number; library: Uint8Array; signed: boolean; px: number }
  /** Solve window `index` of the job from its factor file (transferred), cold. */
  | { type: 'extract-window'; job: number; index: number; bytes: Uint8Array }
  | { type: 'extract-end'; job: number }
  | {
      type: 'tile';
      epoch: number;
      window: number;
      tile: number;
      frames: number;
      x0: number;
      y0: number;
      w: number;
      h: number;
      seed: number;
      /** The rank this tile kept in the previous window (absent: none). */
      prevRank?: number;
      raw: Int16Array;
    };

/** A compress helper -> the compress worker. `raw` comes back for reuse. */
export type HelperToCoordinator =
  | {
      type: 'tile-done';
      epoch: number;
      window: number;
      tile: number;
      rank: number;
      ms: number;
      bytes: Uint8Array;
      raw: Int16Array;
    }
  | { type: 'tile-error'; epoch: number; window: number; tile: number; message: string }
  /** Window `index` of Extract job `job`: its traces (and signed traces), `count x cells`. Transferred. */
  | {
      type: 'window-done';
      job: number;
      index: number;
      start: number;
      count: number;
      projected: boolean;
      traces: Float32Array;
      signed?: Float32Array;
    }
  | { type: 'window-error'; job: number; index: number; message: string }
  /** The helper cannot compress (its WASM module failed to start). */
  | { type: 'helper-error'; message: string };
