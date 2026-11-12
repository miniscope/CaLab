/**
 * Drives a `FlatFieldEstimator`: pushes raw batches with their rigid shifts
 * (cheap) and, when the estimator is due, runs the expensive `refine()`.
 * Transport-free: the flat-field worker feeds it from a `MessagePort`, tests
 * call it directly. Runs only off the frame path (see `workers/flat-field-worker.ts`).
 */
import { FlatFieldEstimator } from './cala-wasm.ts';
import {
  FLAT_FIELD_FIRST_S,
  FLAT_FIELD_REFINE_S,
  type FlatFieldChange,
  type FlatFieldEvent,
  type FlatFieldMap,
} from './flat-field.ts';
import type { FramePixels } from './frame-source.ts';

/** Stage A -> estimator: a run begins (after calibration). */
export interface FlatFieldStart {
  /** Tags every message of this run; answers of an older run are dropped. */
  session: number;
  width: number;
  height: number;
  fovMask: Uint8Array;
  fps: number;
  sixteen: boolean;
  /** A stored map of this sensor: in force from the first frame, blended into every solve. */
  seed?: FlatFieldMap;
  /** Seconds of frames before the first map and between refinements (tests; default the library's). */
  firstS?: number;
  refineS?: number;
}

/** Stage A -> estimator: a batch of raw frames with the shifts stage B registered them by. */
export interface FlatFieldBatch {
  session: number;
  start: number;
  count: number;
  raw: FramePixels;
  dy: Float32Array;
  dx: Float32Array;
}

/**
 * Where stage A sends batches. `ready()` says whether a batch would be taken
 * now (a bounded queue: when the estimator falls behind, A drops frames for
 * it instead of waiting, so the fast loop is never blocked).
 */
export interface FlatFieldSink {
  start(msg: FlatFieldStart): void;
  ready(): boolean;
  push(msg: FlatFieldBatch): void;
  stop(): void;
}

export class FlatFieldRunner {
  private est: FlatFieldEstimator | null = null;
  private session = 0;
  private sixteen = false;
  private fps = 20;
  private reportedSecond = -1;

  /**
   * `emit`: events for the main thread. `deliver`: a new map for stage A
   * (a copy: both sides take ownership of their arrays).
   */
  constructor(
    private readonly emit: (e: FlatFieldEvent) => void,
    private readonly deliver: (session: number, seq: number, map: FlatFieldMap) => void,
  ) {}

  start(msg: FlatFieldStart): void {
    this.stop();
    this.session = msg.session;
    this.sixteen = msg.sixteen;
    this.fps = msg.fps > 0 ? msg.fps : 20;
    this.reportedSecond = -1;
    const seed = msg.seed;
    this.est = new FlatFieldEstimator(
      msg.width,
      msg.height,
      msg.fovMask,
      this.fps,
      NaN,
      NaN,
      msg.firstS ?? FLAT_FIELD_FIRST_S,
      msg.refineS ?? FLAT_FIELD_REFINE_S,
      seed?.gain,
      seed && seed.offset.length > 0 ? seed.offset : undefined,
      seed?.dark ?? 0,
      seed?.framesUsed ?? 0,
    );
  }

  /** Push a batch and refine when due. A failure is reported, not thrown. */
  push(b: FlatFieldBatch): void {
    const est = this.est;
    if (!est || b.session !== this.session) return;
    try {
      if (this.sixteen) est.pushFrames16(b.raw as Uint16Array, b.count, b.dy, b.dx);
      else est.pushFrames(b.raw as Uint8Array, b.count, b.dy, b.dx);
      const second = Math.floor(est.frames / this.fps);
      if (second !== this.reportedSecond) {
        this.reportedSecond = second;
        this.emit({ type: 'progress', session: this.session, frames: est.frames, fps: this.fps });
      }
      if (est.due) this.refine(est);
    } catch (err) {
      this.emit({
        type: 'error',
        session: this.session,
        message: err instanceof Error ? err.message : String(err),
      });
      this.stop();
    }
  }

  private refine(est: FlatFieldEstimator): void {
    if (!est.refine()) {
      this.emit({ type: 'skipped', session: this.session, message: est.message });
      return;
    }
    const map: FlatFieldMap = {
      gain: est.gain(),
      offset: est.offset(),
      dark: est.dark,
      binsUsed: est.binsUsed,
      framesUsed: est.framesUsed,
      gainSd: est.gainSd,
    };
    const change: FlatFieldChange = {
      median: est.changeMedian,
      p99: est.changeP99,
      max: est.changeMax,
    };
    const seq = est.updates;
    this.deliver(this.session, seq, { ...map, gain: map.gain.slice(), offset: map.offset.slice() });
    this.emit({ type: 'map', session: this.session, seq, map, change });
  }

  stop(): void {
    this.est?.free();
    this.est = null;
  }
}
