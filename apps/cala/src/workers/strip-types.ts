/**
 * Messages between the slow worker and its strip helpers (`?debug&obsstrips=N`; experimental, off
 * by default). A strip helper sums the cell model's footprint statistics of a batch of frames for
 * the cells and cluster stores of one band of image rows (`SlowLoop.stripsBegin`); the slow worker
 * adds what comes back (`SlowLoop.stripsApply`). Helpers hold no state but the frame size, the FOV
 * and the recent libraries.
 */

/** Libraries a strip helper keeps (the newest; the slow loop holds version 0 and its 6 newest). */
export const STRIP_KEEP_VERSIONS = 8;

/** Slow worker -> strip helper. */
export type OwnerToStrip =
  | { type: 'init'; session: number; width: number; height: number; fov: Uint8Array }
  /** A newly published library (a helper keeps the `STRIP_KEEP_VERSIONS` newest). */
  | { type: 'library'; session: number; version: number; bytes: Uint8Array }
  | {
      type: 'job';
      session: number;
      /** The batch (answers carry it back). */
      id: number;
      /** Library version that solved the frames. */
      version: number;
      /** The strip's context (`SlowLoop.stripContext`). */
      context: Uint8Array;
      /** Rows `row0..row1` of each frame are in `frames`. */
      row0: number;
      row1: number;
      /** The fitting frames' slow-loop indices (the builder's keys), one per frame sent. */
      keys: Float64Array;
      /** `keys.length` frames, rows `row0..row1` of each. Transferred. */
      frames: Float32Array;
      /** `keys.length * cells` traces. Transferred. */
      traces: Float32Array;
      cells: number;
      /** The same solve's background coefficients, frame after frame (absent: none). Transferred. */
      background?: Float32Array;
    }
  | { type: 'reset'; session: number };

/** Strip helper -> slow worker. */
export type StripToOwner =
  /** The strip's delta (`SettleDeltaBuilder.finish`) and the helper's ms on the job. */
  | { type: 'delta'; session: number; id: number; bytes: Uint8Array; ms: number }
  | { type: 'error'; session: number; id: number; message: string };

/** Main thread -> strip helper: the port to the slow worker. */
export interface StripConnect {
  type: 'connect';
  port: MessagePort;
}
