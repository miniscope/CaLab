/**
 * The bounded pool of frame buffers the fast worker forwards to the slow
 * worker. Pure, so the dropping policy is unit-tested without workers.
 *
 * Policy: a batch is forwarded only when a buffer is free. A buffer is busy
 * from `acquire` until the slow worker's `ack` hands it back (`release`), so
 * at most `size` batches are ever in flight or queued at the slow worker,
 * whatever it is doing. When none is free the fast worker drops the batch for
 * the slow loop (it is still solved and shown) and never waits. Memory is
 * bounded by `size` buffers on each side. Dropping is safe for discovery: the
 * slow loop keeps a reservoir of past frames per tile, and a cell that is
 * active once is active again.
 *
 * A **lossless** pool (Refine, which must not drop a frame) never drops: with
 * every buffer in flight it allocates one more. Its memory is then bounded by
 * whoever paces the batches (the Refine stage asks for the next batch only
 * while the slow loop is at most a few batches behind).
 */
export class ForwardPool {
  readonly size: number;
  readonly length: number;
  private free: Float32Array[] = [];
  private busy = 0;
  /** Frames forwarded, and frames dropped because no buffer was free. */
  forwardedFrames = 0;
  droppedFrames = 0;

  /** Never drop a batch (see the class comment). */
  readonly lossless: boolean;
  /** Buffers a lossless pool allocated beyond `size`. */
  extraBuffers = 0;

  /** `size` buffers of `length` floats each. */
  constructor(size: number, length: number, lossless = false) {
    if (!(size >= 1) || !(length >= 1))
      throw new RangeError('ForwardPool needs size, length >= 1.');
    this.size = Math.floor(size);
    this.length = Math.floor(length);
    this.lossless = lossless;
  }

  /** Buffers handed out and not yet returned. */
  get inFlight(): number {
    return this.busy;
  }

  /**
   * A free buffer for a batch of `frames` frames, or `null` (the batch is
   * dropped and counted) when every buffer is in flight.
   */
  acquire(frames: number): Float32Array | null {
    if (this.busy >= this.size && !this.lossless) {
      this.droppedFrames += frames;
      return null;
    }
    if (this.busy >= this.size) this.extraBuffers++;
    this.busy++;
    this.forwardedFrames += frames;
    return this.free.pop() ?? new Float32Array(this.length);
  }

  /** A buffer came back. One of the wrong size (not ours) only frees the slot. */
  release(buf: Float32Array | null): void {
    if (this.busy > 0) this.busy--;
    if (buf && buf.length === this.length && this.free.length < this.size) this.free.push(buf);
  }
}
