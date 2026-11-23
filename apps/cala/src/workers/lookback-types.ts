/**
 * Messages of look-back (concurrent Refine inside Discover, experimental;
 * see `lib/lookback-reader.ts`): between the slow worker, which owns the
 * scheduler (`SlowLoop.lookbackTake`), the look-back worker, which re-reads
 * the frames it asks for from the recording and preprocesses and solves
 * them, and the main thread, which feeds the look-back worker what the live
 * pipeline recorded (motion and flicker per frame, the back half's state, the
 * flat field).
 *
 * The slow worker and the look-back worker talk over a `MessageChannel` the
 * main thread wires, so frames never go through the UI thread. Every message
 * carries the pipeline `session`; stale ones are dropped.
 */
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { GovernorStatus } from '../lib/settle.ts';
import type { LookbackTiming } from '../lib/work-meter.ts';
import type { FolderEntry, SessionInput } from '../lib/frame-source.ts';
import type { SessionTransform } from '../lib/session-boundary.ts';

/** Slow worker -> look-back worker. */
export type SlowToLookback =
  /**
   * Frames to supply: `SlowLoop.lookbackTake` output, `[frame, block, n,
   * id_1..id_n, ...]` (transferred). Answered by one `frames` (or `error`)
   * with the same `id`. At most one is outstanding.
   */
  | {
      type: 'request';
      session: number;
      id: number;
      items: Float64Array;
      /**
       * Per frame, 1: preprocess it (the block's preprocessor runs on) but do
       * not solve it (a held-out frame of the settle during Discover, which
       * never reaches fitting). Absent: solve every frame.
       */
      skip?: Uint8Array;
    }
  /** A library the slow loop published (`TraceLibrary.toBytes()`, a copy; transferred). */
  | { type: 'library'; session: number; version: number; bytes: Uint8Array }
  /** The `frames` buffer of a reply, back for reuse (transferred). */
  | { type: 'release'; session: number; frames: Float32Array };

/** Look-back worker -> slow worker. */
export type LookbackToSlow =
  | {
      type: 'frames';
      session: number;
      /** The request answered. */
      id: number;
      /** Library version the traces were solved with (0: none yet, nothing solved). */
      version: number;
      /** Frames, in request order. */
      count: number;
      /** Cells per frame in `traces`. */
      cells: number;
      /** Pooled buffer, at least `count * width * height` preprocessed frames (send it back with `release`). */
      frames: Float32Array;
      /** `count * cells` traces, library slot order. */
      traces: Float32Array;
      /** The background coefficients of the same solve, frame after frame (absent: no cells). */
      background?: Float32Array;
      /** What the worker spent on this answer (instrumentation only; absent from older builds). */
      timing?: LookbackTiming;
    }
  | { type: 'error'; session: number; id: number; message: string };

/** The recording the look-back worker opens (its own `FrameSource`, from the same `File`s). */
export type LookbackSource = { entries: FolderEntry[] } | { sessions: SessionInput[] };

/** Main thread -> look-back worker. */
export type MainToLookback =
  /** The port to the slow worker (transferred). */
  | { type: 'connect'; port: MessagePort }
  /**
   * A Discover run with look-back starts: open the recording. `prune`: a
   * settle-pool worker, which serves the current session only, keeps the
   * back states of the newest two sessions only (worker 0 keeps every
   * session's, for the Final settle).
   */
  | { type: 'begin'; session: number; source: LookbackSource; prune?: boolean }
  /** What the live pipeline recorded for frames `start..start + dy.length` (copies; transferred). */
  | {
      type: 'rows';
      session: number;
      start: number;
      dy: Float32Array;
      dx: Float32Array;
      flags: Uint8Array;
      flickerOffset: Float32Array;
      flickerGain: Float32Array;
    }
  /**
   * The live back half's state (`Preprocessor.state()` of stage C) after
   * stream frame `frame`: a look-back block starts from the newest one.
   */
  | { type: 'back-state'; session: number; frame: number; state: Uint8Array }
  /** The newest flat-field map (null: none). */
  | { type: 'flat'; session: number; map: FlatFieldMap | null }
  /**
   * A Joint run: Discover re-registered session `index` (1-based) by
   * `transform` (`RunRecord.noteSession`); sent before the rows of the
   * session's first frame.
   */
  | { type: 'session'; session: number; index: number; transform: SessionTransform }
  /** The run stopped: close the recording, drop everything. */
  | { type: 'reset'; session: number };

/** Look-back worker -> main thread. */
export type LookbackToMain = { type: 'error'; session: number; message: string };

/** Slow status: look-back counters (absent: look-back off). */
export interface LookbackStatus {
  /** Look-back frames handed out, observed, held out, dropped (library version gone). */
  requested: number;
  pushed: number;
  heldOut: number;
  dropped: number;
  /** Cell births noted, and cells that still need look-back frames. */
  births: number;
  inNeed: number;
  /** Size of the held-out record, bytes. */
  recordBytes: number;
  /**
   * Settling (after the last frame, part of Discover): running; then the
   * drain's steps (need-driven look-back, when it runs) and the settle pass
   * (`settle`).
   */
  settling: boolean;
  drainSteps: number;
  /** The drain stopped at its step cap with cells still in need. */
  capped: boolean;
  /** The settle pass (absent until it starts). */
  settle?: SettleStatus;
  /** Settle during Discover (absent: off for this run). */
  csettle?: CsettleStatus;
  /** Look-back stopped by an error (Discover goes on without it). */
  error?: string;
}

/**
 * Settle during Discover (experimental, frames only; `SlowRunner`): saved
 * frames re-read while Discover runs, spread over the history seen so far.
 */
export interface CsettleStatus {
  /** The ceiling: re-read frames per live frame the slow loop observes. */
  rate: number;
  /** Frames asked of the look-back worker. */
  requested: number;
  /** Frames that came back and went into the footprint statistics. */
  fit: number;
  /** Held-out frames (re-read, never solved or fitted). */
  heldOut: number;
  /** Frames dropped (their library version was gone, or none was published yet). */
  dropped: number;
  /** Live frames the slow loop observed in Discover (what the ceiling is counted against). */
  live: number;
  /** Answers handled, and the slow worker's time on them, ms (in all, and the longest stretch without giving way). */
  answers: number;
  answerMs: number;
  maxBlockMs: number;
  /** Frames per piece when the slow worker gives way inside an answer (0: whole answers). */
  yieldFrames: number;
  /** Pool look-back workers serving the settle now (0: it takes turns on worker 0). Absent from older builds. */
  settleWorkers?: number;
  /** The settle governor's state (absent: governor off, the per-live-frame dose). */
  governor?: GovernorStatus;
}

/** The settle pass of a look-back run (`lib/settle.ts`). */
export interface SettleStatus {
  /** Frames fed through `observe`, of the frames planned (one pass, at most `SETTLE.maxFrames`). */
  fed: number;
  total: number;
  /** Frames in the recording (the plan samples it when longer than `SETTLE.maxFrames`). */
  recording: number;
  /**
   * At the last checkpoint: cells with a noise estimate, and of those the
   * ones that moved by more than `SETTLE.movingK` times their split-half
   * noise since the checkpoint before (null before the first).
   */
  moving: { cells: number; above: number } | null;
  /** The user stopped it early. */
  stopped: boolean;
  done: boolean;
}
