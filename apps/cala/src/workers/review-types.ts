/**
 * Messages of the history review: a periodic pass over the compressed
 * history (the factors of every window) that proposes cells the slow loop
 * missed. The compress worker hands each window's factors and, every few
 * windows, the newest library to the review worker; the review worker sends
 * what it finds to the main thread, which passes it to the slow worker.
 *
 * (Not the "History view" tab, which plots a run's metrics over time.)
 */

/** Compress worker -> review worker. */
export type CompressToReview =
  | { type: 'init'; session: number; width: number; height: number }
  /** The factor file of the next compressed window, in stream order. Transferred. */
  | { type: 'window'; session: number; bytes: Uint8Array }
  /**
   * A review is due. `library`: the newest library (`TraceLibrary.toBytes()`,
   * transferred), `null` before the first one.
   */
  | { type: 'review'; session: number; version: number; library: Uint8Array | null }
  /** Pipeline stopped or restarted: drop everything. */
  | { type: 'reset'; session: number };

export interface ReviewStatus {
  /** Reviews finished, and reviews that were due while one was running. */
  reviews: number;
  skipped: number;
  /** Candidates found by all reviews. */
  candidates: number;
  /** A review is running. */
  running: boolean;
  /** Windows the last review covered, and its wall time, s. */
  windows: number;
  seconds: number;
  /** Bytes of the factors the review worker holds, and of its WASM heap. */
  factorBytes: number;
  heapBytes: number;
}

/** Review worker -> main thread. */
export type ReviewToMain =
  | { type: 'status'; session: number; status: ReviewStatus }
  /**
   * What a review found, for `SlowLoop.addReviewed` (see
   * `HistoryReview.finish` for the layout). `version`: the library the review
   * ran against. Transferred.
   */
  | { type: 'candidates'; session: number; version: number; candidates: Float32Array }
  | { type: 'error'; session: number; message: string };

/** Main thread -> review worker: the port to the compress worker. */
export interface ReviewConnect {
  type: 'connect';
  port: MessagePort;
}
