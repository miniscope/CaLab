/**
 * Smooth playback of batch previews. Pure: the caller supplies the clock.
 *
 * The fast loop returns frames in batches, so a viewer fed only each batch's
 * last frame advances in batch-sized jumps. With a preview of every frame, the
 * scheduler queues each batch's frames and releases them at an even display
 * rate, one batch behind the processing at most. A queue longer than about two
 * batches skips ahead (the oldest frames are dropped) so the display never
 * lags far behind. Display only: nothing in processing depends on it.
 */

export interface PlaybackOptions {
  /** Skip ahead once more than this many batches are queued (default 2). */
  maxBatches?: number;
}

export class PlaybackScheduler<T> {
  private queue: T[] = [];
  private head = 0;
  private rate = 30;
  private credit = 0;
  private last: number | null = null;
  private batchLen = 1;
  private readonly maxBatches: number;
  /** Frames dropped by skipping ahead since the last `clear()`. */
  dropped = 0;
  /** Frames shown since the last `clear()`. */
  shown = 0;

  constructor(options: PlaybackOptions = {}) {
    this.maxBatches = options.maxBatches ?? 2;
  }

  /** Frames waiting to be shown. */
  get queued(): number {
    return this.queue.length - this.head;
  }

  /** Display rate, frames per second. */
  setRate(fps: number): void {
    if (fps > 0 && Number.isFinite(fps)) this.rate = fps;
  }

  /** Queue one batch's frames, oldest first. Skips ahead when too many are waiting. */
  push(frames: readonly T[]): void {
    if (frames.length === 0) return;
    // The loop may have stopped while the queue was empty: no credit for the gap.
    if (this.queued === 0) {
      this.credit = 0;
      this.last = null;
    }
    this.batchLen = Math.max(this.batchLen, frames.length);
    for (const f of frames) this.queue.push(f);
    const limit = Math.ceil(this.maxBatches * this.batchLen);
    if (this.queued > limit) {
      // Keep one batch: the display stays about a batch behind, never more than two.
      const drop = this.queued - this.batchLen;
      this.head += drop;
      this.dropped += drop;
    }
  }

  /**
   * The frame to show at `nowMs`, or `null` when the picture stays as it is
   * (nothing due, or nothing queued). At display rates above the call rate
   * several frames fall due: the newest of them is returned.
   */
  tick(nowMs: number): T | null {
    if (this.queued === 0) {
      // No credit builds up while the queue is empty: playback resumes evenly, not in a burst.
      this.credit = 0;
      this.last = nowMs;
      this.queue = [];
      this.head = 0;
      return null;
    }
    if (this.last === null) this.credit = 1;
    else this.credit += (Math.max(0, nowMs - this.last) * this.rate) / 1000;
    this.last = nowMs;
    const n = Math.min(Math.floor(this.credit), this.queued);
    if (n === 0) return null;
    this.credit -= n;
    this.head += n;
    this.shown += n;
    const frame = this.queue[this.head - 1];
    if (this.queued === 0) {
      this.credit = 0;
      this.queue = [];
      this.head = 0;
    }
    this.compact();
    return frame;
  }

  /** Drop everything queued and return the newest frame (pause, seek, scrub: show it at once). */
  flush(): T | null {
    const frame = this.queued > 0 ? this.queue[this.queue.length - 1] : null;
    if (frame !== null) this.shown++;
    this.reset();
    return frame;
  }

  /** Forget everything (stop, restart, session switch). */
  clear(): void {
    this.reset();
    this.dropped = 0;
    this.shown = 0;
    this.batchLen = 1;
  }

  private reset(): void {
    this.queue = [];
    this.head = 0;
    this.credit = 0;
    this.last = null;
  }

  private compact(): void {
    if (this.head > 64 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }
}

/** Playback is worth its extra preview bytes only at modest processing rates (frames per second, with hysteresis). */
export const PLAYBACK_ON_BELOW = 100;
export const PLAYBACK_OFF_ABOVE = 140;

/** Whether per-frame previews are wanted at this processing rate (0: not known yet, so yes). */
export function playbackWanted(rate: number, wasOn: boolean): boolean {
  return rate < (wasOn ? PLAYBACK_OFF_ABOVE : PLAYBACK_ON_BELOW);
}
