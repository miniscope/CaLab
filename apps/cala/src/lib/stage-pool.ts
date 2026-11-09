/**
 * A small fixed pool of frame buffers shared by two pipeline stages. A buffer
 * is busy from `acquire` until the downstream stage hands it back (`release`),
 * so at most `size` batches are ever in flight on a link, whatever the stages
 * are doing. `acquire` waits when none is free: that wait is the backpressure
 * that keeps the queues bounded. Pure, so it is unit-tested without workers.
 */
export class StagePool {
  readonly size: number;
  readonly length: number;
  private free: Float32Array[] = [];
  private created = 0;
  private waiters: ((buf: Float32Array) => void)[] = [];

  /** `size` buffers of `length` floats each, allocated on first use. */
  constructor(size: number, length: number) {
    if (!(size >= 1) || !(length >= 1)) throw new RangeError('StagePool needs size, length >= 1.');
    this.size = Math.floor(size);
    this.length = Math.floor(length);
  }

  /** Buffers handed out and not yet returned. */
  get inFlight(): number {
    return this.created - this.free.length;
  }

  /** A free buffer, waiting for one to come back when all are in flight. */
  acquire(): Promise<Float32Array> {
    const buf = this.free.pop();
    if (buf) return Promise.resolve(buf);
    if (this.created < this.size) {
      this.created++;
      return Promise.resolve(new Float32Array(this.length));
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** A buffer came back. One of the wrong size (not ours) is ignored. */
  release(buf: Float32Array): void {
    if (buf.length !== this.length) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(buf);
    else this.free.push(buf);
  }
}
