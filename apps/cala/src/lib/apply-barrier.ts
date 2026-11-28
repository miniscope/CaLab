/**
 * Repeatable Discover (`SlowInit.repeatable`, paced runs): the slow worker hands out visits and
 * look-back requests only at batch ends and applies what comes back at a fixed later batch end,
 * in the order it went out, whatever order the answers arrive in. This ledger keeps what is out,
 * holds what came back early, and says when a batch end has to wait for something late.
 *
 * Pure (no workers, no clocks), so the order rules are unit-tested on their own; `SlowRunner`
 * owns the waiting and the applying.
 */
import { PACE_BATCH } from './frame-pacer.ts';

/**
 * Batches between hand-out and apply. One visit slot then makes at most one visit per this many
 * batches, so `slots / (APPLY_LAG_BATCHES * PACE_BATCH)` visits per frame. A look-back worker gets
 * a request at every batch end, so this many are out on it at once (and it needs that many frame
 * buffers); it reads up to `LOOKBACK.takeMax` frames per batch.
 */
export const APPLY_LAG_BATCHES = 2;

/** The lag in stream frames (counted in frames, so a dropped batch does not move it). */
export const APPLY_LAG_FRAMES = APPLY_LAG_BATCHES * PACE_BATCH;

/** What went out: a visit to slot `key`, or a look-back request `id` to worker `key`. */
export type BarrierKind = 'visit' | 'lookback';

/** One thing out, in hand-out order. */
export interface BarrierItem<T> {
  /** Hand-out order across both kinds (the apply order). */
  seq: number;
  /** Applied at the first batch end whose last stream frame is at or after this. */
  due: number;
  kind: BarrierKind;
  /** The visit slot, or the look-back worker. */
  key: number;
  /** A look-back request's id (0 for a visit). */
  id: number;
  /** The answer, once it came. */
  result?: T;
  arrived: boolean;
}

/** The ledger of what is out and what came back, applied in hand-out order. */
export class ApplyBarrier<T> {
  private items: BarrierItem<T>[] = [];
  private seq = 0;
  private waiter: { until: number; resolve: () => void } | null = null;
  /** Set by `abort`: nothing more is waited for (the run is being dropped). */
  aborted = false;

  constructor(readonly lag = APPLY_LAG_FRAMES) {}

  /** Things out or held. */
  get size(): number {
    return this.items.length;
  }

  /** Hand-out at the batch end whose last stream frame is `frame`; returns the item's `seq`. */
  issue(kind: BarrierKind, key: number, frame: number, id = 0): number {
    const seq = ++this.seq;
    this.items.push({ seq, due: frame + this.lag, kind, key, id, arrived: false });
    return seq;
  }

  /** The item out on `kind`/`key` (and `id`), not yet arrived. */
  private find(kind: BarrierKind, key: number, id?: number): BarrierItem<T> | undefined {
    return this.items.find(
      (it) =>
        !it.arrived && it.kind === kind && it.key === key && (id === undefined || it.id === id),
    );
  }

  /** Something is out on `kind`/`key` (and `id`) and not yet back. */
  holds(kind: BarrierKind, key: number, id?: number): boolean {
    return this.find(kind, key, id) !== undefined;
  }

  /**
   * An answer came for `kind`/`key` (and `id`): held until its batch end. Returns false when
   * nothing of that is out here (the caller handles it as before).
   */
  arrive(kind: BarrierKind, key: number, result: T, id?: number): boolean {
    const it = this.find(kind, key, id);
    if (!it) return false;
    it.result = result;
    it.arrived = true;
    this.wake();
    return true;
  }

  /** Everything due by stream frame `frame` is back. */
  ready(frame: number): boolean {
    return this.aborted || this.items.every((it) => it.arrived || it.due > frame);
  }

  /** Resolves once everything due by `frame` is back (or `abort`). One waiter at a time. */
  wait(frame: number): Promise<void> {
    if (this.ready(frame)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiter = { until: frame, resolve };
    });
  }

  /** What is due by `frame`, in hand-out order, removed from the ledger (all of it must be back). */
  takeDue(frame: number): BarrierItem<T>[] {
    const out = this.items.filter((it) => it.due <= frame);
    if (out.some((it) => !it.arrived)) throw new Error('apply barrier: taking an answer not back');
    this.items = this.items.filter((it) => it.due > frame);
    return out;
  }

  /** Remove the items of `kind` (all, arrived or not): the caller drops them; returns them. */
  removeKind(kind: BarrierKind): BarrierItem<T>[] {
    const out = this.items.filter((it) => it.kind === kind);
    this.items = this.items.filter((it) => it.kind !== kind);
    this.wake();
    return out;
  }

  /** Forget the item out on `kind`/`key`/`id` (a timeout); returns it. */
  cancel(kind: BarrierKind, key: number, id?: number): BarrierItem<T> | undefined {
    const it = this.items.find(
      (x) => x.kind === kind && x.key === key && (id === undefined || x.id === id),
    );
    if (!it) return undefined;
    this.items.splice(this.items.indexOf(it), 1);
    this.wake();
    return it;
  }

  /** Stop waiting (a reset, a new run or a failure): the waiter resolves, `ready` is true from now on. */
  abort(): void {
    this.aborted = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    if (w && this.ready(w.until)) {
      this.waiter = null;
      w.resolve();
    }
  }
}
