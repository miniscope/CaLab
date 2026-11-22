/**
 * Smooth frame pacing for a recording read at a chosen rate (a stream's rate,
 * or a slider position): one batch every `batch / fps` seconds, on absolute
 * deadlines, never a burst to catch up.
 *
 * `FramePacer` is pure (the clock is passed in). `PaceGate` wraps it with the
 * waiting, pause and stop that the frame worker needs; it runs there, not on
 * the main thread, because main-thread timers are throttled in a hidden tab.
 * See tools/cala-eval notes `work_slider_design.md`, section 4.
 */

/** Frames per released batch: the app's batch (`PipelinePlan.batchSize`). */
export const PACE_BATCH = 8;

/**
 * A release later than its deadline by at most this share of a period is
 * repaid by the next one (so timer jitter never accumulates); later than that
 * the debt is dropped and the pacer re-anchors.
 */
export const PACE_SLACK = 0.1;

export class FramePacer {
  private fps = 0;
  private anchor = 0;
  private count = 0;
  private held = false;
  private lateTotal = 0;
  private reanchorCount = 0;

  constructor(readonly batch: number = PACE_BATCH) {}

  /** 0 or `Infinity` = unpaced. Re-anchors. */
  setTarget(fps: number, now: number): void {
    this.fps = Number.isFinite(fps) && fps > 0 ? fps : 0;
    this.anchor = now;
    this.count = 0;
  }

  get target(): number {
    return this.fps;
  }

  get paced(): boolean {
    return this.fps > 0;
  }

  get paused(): boolean {
    return this.held;
  }

  /** Frames released since the last anchor. */
  get released(): number {
    return this.count;
  }

  /** Total lateness (ms) dropped at re-anchors: how far behind the target the run fell. */
  get lateMs(): number {
    return this.lateTotal;
  }

  get reanchors(): number {
    return this.reanchorCount;
  }

  /** One batch's period in ms (0 when unpaced). */
  get periodMs(): number {
    return this.fps > 0 ? (this.batch / this.fps) * 1000 : 0;
  }

  /** When the next batch may be released: -Infinity unpaced, +Infinity paused. */
  dueAt(): number {
    if (this.fps <= 0) return Number.NEGATIVE_INFINITY;
    if (this.held) return Number.POSITIVE_INFINITY;
    return this.anchor + (this.count / this.fps) * 1000;
  }

  /** Count a released batch. Later than a slack past the deadline: drop the debt and re-anchor. */
  release(frames: number, now: number): void {
    if (this.fps <= 0) return;
    const due = this.dueAt();
    const late = now - due;
    if (late > this.periodMs * PACE_SLACK) {
      this.lateTotal += late;
      this.reanchorCount++;
      this.anchor = now;
      this.count = 0;
    }
    this.count += frames;
  }

  pause(): void {
    this.held = true;
  }

  /** Resume re-anchors: the time paused is not owed. */
  resume(now: number): void {
    if (!this.held) return;
    this.held = false;
    this.anchor = now;
    this.count = 0;
  }

  /** A new run: unpaced, not paused, readouts cleared. */
  reset(): void {
    this.fps = 0;
    this.held = false;
    this.count = 0;
    this.anchor = 0;
    this.lateTotal = 0;
    this.reanchorCount = 0;
  }
}

/** Timer functions the gate uses (the tests pass fakes; the default is the worker's own). */
export interface PaceTimers {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: PaceTimers = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The gate at the entry of the first pipeline stage. `enter()` resolves when
 * a batch may be read: at once when unpaced, else at the pacer's deadline;
 * never while paused; `false` once stopped. Its wait is not work: it is
 * counted here (`waitMs`), outside every stage's busy time.
 */
export class PaceGate {
  readonly pacer: FramePacer;
  private stopped = false;
  /** Truncated run (finish early): the rest of the recording is read unpaced. */
  private open = false;
  private waiting: { wake: () => void } | null = null;
  private waited = 0;

  constructor(
    private readonly timers: PaceTimers = REAL_TIMERS,
    batch: number = PACE_BATCH,
  ) {
    this.pacer = new FramePacer(batch);
  }

  /** Time spent waiting at the gate (ms), reported apart from the stages' busy time. */
  get waitMs(): number {
    return this.waited;
  }

  /** Whether `enter` may wait. */
  get active(): boolean {
    return this.pacer.paced && !this.open && !this.stopped;
  }

  /** A new run: unpaced until `setTarget`, not stopped, not paused. */
  begin(): void {
    this.pacer.reset();
    this.stopped = false;
    this.open = false;
    this.waited = 0;
    this.wake();
  }

  setTarget(fps: number): void {
    this.pacer.setTarget(fps, this.timers.now());
    this.wake();
  }

  pause(): void {
    this.pacer.pause();
  }

  resume(): void {
    this.pacer.resume(this.timers.now());
    this.wake();
  }

  /** Stop or reset: a waiting `enter` answers `false`, and so does every later one until `begin`. */
  stop(): void {
    this.stopped = true;
    this.wake();
  }

  /** Finish early: release everything that follows at once. */
  openUp(): void {
    this.open = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.wake();
  }

  /** Wait for the next batch's time; `true`: read it, `false`: the run was stopped. */
  async enter(frames: number = this.pacer.batch): Promise<boolean> {
    if (!this.active) return !this.stopped;
    const t0 = this.timers.now();
    try {
      for (;;) {
        if (this.stopped) return false;
        if (this.open || !this.pacer.paced) return true;
        const now = this.timers.now();
        const due = this.pacer.dueAt();
        if (now >= due) {
          this.pacer.release(frames, now);
          return true;
        }
        await new Promise<void>((resolve) => {
          const handle = Number.isFinite(due)
            ? this.timers.setTimeout(() => {
                this.waiting = null;
                resolve();
              }, due - now)
            : null;
          this.waiting = {
            wake: () => {
              if (handle !== null) this.timers.clearTimeout(handle);
              resolve();
            },
          };
        });
      }
    } finally {
      this.waited += this.timers.now() - t0;
    }
  }
}
