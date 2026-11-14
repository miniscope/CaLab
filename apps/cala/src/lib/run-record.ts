/**
 * What pass 1 records about every frame so pass 2 can replay the recording
 * without estimating anything again: the rigid motion shift, the motion flags
 * and the global flicker (additive offset, relative gain).
 *
 * 17 bytes per frame (4 x float32 + 1 x uint8), grown by doubling: a
 * 24,000-frame recording takes 0.4 MB and a multi-hour one of a million frames
 * 17 MB, so unlike traces it needs no bound.
 *
 * It also lists the sensor flat-field maps that took effect (frame index of
 * the batch each one first corrected, see `FlatFieldApplied`): the first is the
 * one-time switch from uncorrected frames, so pass 2 and exports know which
 * frames pass 1 saw uncorrected.
 *
 * Batches must arrive in order starting at frame 0. A gap (a restarted or
 * truncated stream, a dropped batch) marks the record incomplete rather than
 * silently shifting later frames onto earlier indices.
 */

import type { FlatFieldApplied } from './flat-field.ts';
import type { SessionTransform } from './session-boundary.ts';

export const RUN_RECORD_BYTES_PER_FRAME = 17;

/** The recorded values of a span of frames (views into the record: copy before transferring). */
export interface RunSpan {
  dy: Float32Array;
  dx: Float32Array;
  flags: Uint8Array;
  flickerOffset: Float32Array;
  flickerGain: Float32Array;
  /**
   * Session re-registration transforms of a Joint run, by session index
   * (1-based; absent: identity). Stage B applies them in a replay.
   */
  sessionTransforms?: (SessionTransform | undefined)[];
}

export class RunRecord {
  private cap: number;
  private dyBuf: Float32Array;
  private dxBuf: Float32Array;
  private flagBuf: Uint8Array;
  private offBuf: Float32Array;
  private gainBuf: Float32Array;
  private n = 0;
  private gap = false;
  private readonly flatApplied: FlatFieldApplied[] = [];
  private readonly sessions: (SessionTransform | undefined)[] = [];

  constructor(capacity = 4096) {
    this.cap = Math.max(1, Math.floor(capacity));
    this.dyBuf = new Float32Array(this.cap);
    this.dxBuf = new Float32Array(this.cap);
    this.flagBuf = new Uint8Array(this.cap);
    this.offBuf = new Float32Array(this.cap);
    this.gainBuf = new Float32Array(this.cap);
  }

  /** Flat-field maps in the order they took effect. */
  get flatFieldApplied(): readonly FlatFieldApplied[] {
    return this.flatApplied;
  }

  /** Note that a flat-field map took effect (at `applied.frame`). */
  noteFlatField(applied: FlatFieldApplied): void {
    this.flatApplied.push(applied);
  }

  /** Session `index` was re-registered by `transform` (applied to all of its frames). */
  noteSession(index: number, transform: SessionTransform): void {
    this.sessions[index] = [transform[0], transform[1], transform[2]];
  }

  /** Frames recorded from frame 0 without a gap. */
  get frames(): number {
    return this.n;
  }

  /** False once a batch arrived out of order. */
  get complete(): boolean {
    return !this.gap;
  }

  get bytes(): number {
    return this.n * RUN_RECORD_BYTES_PER_FRAME;
  }

  private grow(need: number): void {
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap *= 2;
    const f = (a: Float32Array) => {
      const b = new Float32Array(cap);
      b.set(a.subarray(0, this.n));
      return b;
    };
    this.dyBuf = f(this.dyBuf);
    this.dxBuf = f(this.dxBuf);
    this.offBuf = f(this.offBuf);
    this.gainBuf = f(this.gainBuf);
    const fl = new Uint8Array(cap);
    fl.set(this.flagBuf.subarray(0, this.n));
    this.flagBuf = fl;
    this.cap = cap;
  }

  /** Append the batch that starts at stream frame `start`. */
  push(
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    flags: ArrayLike<number>,
    offset: ArrayLike<number>,
    gain: ArrayLike<number>,
  ): void {
    if (this.gap) return;
    const count = dy.length;
    if (start !== this.n) {
      this.gap = true;
      return;
    }
    this.grow(this.n + count);
    for (let i = 0; i < count; i++) {
      const k = this.n + i;
      this.dyBuf[k] = dy[i];
      this.dxBuf[k] = dx[i];
      this.flagBuf[k] = flags[i];
      this.offBuf[k] = offset[i];
      this.gainBuf[k] = gain[i];
    }
    this.n += count;
  }

  /** Frames `[start, start + count)` as views. */
  span(start: number, count: number): RunSpan {
    const end = Math.min(this.n, start + count);
    return {
      dy: this.dyBuf.subarray(start, end),
      dx: this.dxBuf.subarray(start, end),
      flags: this.flagBuf.subarray(start, end),
      flickerOffset: this.offBuf.subarray(start, end),
      flickerGain: this.gainBuf.subarray(start, end),
    };
  }

  /** Everything recorded, as independent copies (for a message to a worker or an export). */
  snapshot(): RunSpan {
    const s = this.span(0, this.n);
    return {
      dy: s.dy.slice(),
      dx: s.dx.slice(),
      flags: s.flags.slice(),
      flickerOffset: s.flickerOffset.slice(),
      flickerGain: s.flickerGain.slice(),
      ...(this.sessions.length > 0
        ? { sessionTransforms: this.sessions.map((t) => (t ? [...t] : undefined)) }
        : {}),
    };
  }
}
