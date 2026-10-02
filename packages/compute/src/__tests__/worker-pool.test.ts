import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorkerPool, type BaseJob, type MessageRouter } from '@calab/compute';

// ── Test doubles ────────────────────────────────────────────────────────────

type TestMsg =
  | { type: 'ready' }
  | { type: 'result'; jobId: number }
  | { type: 'init-error'; message: string };

/** Minimal stand-in for the DOM Worker the pool drives. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: TestMsg }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(payload: unknown): void {
    this.posted.push(payload);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker emitting a message back to the pool. */
  emit(msg: TestMsg): void {
    this.onmessage?.({ data: msg });
  }

  /** Simulate an uncaught error inside the worker. */
  crash(message: string): void {
    this.onerror?.({ message });
  }
}

class TestJob implements BaseJob {
  cancelled = false;
  errored: string | null = null;
  done = false;

  constructor(
    public jobId: number,
    private priority?: number,
  ) {}

  onCancelled(): void {
    this.cancelled = true;
  }

  onError(msg: string): void {
    this.errored = msg;
  }

  getPriority(): number {
    return this.priority ?? 1;
  }
}

const router: MessageRouter<TestJob, TestMsg> = {
  isReady: (msg) => msg.type === 'ready',
  getJobId: (msg) => (msg.type === 'result' ? msg.jobId : undefined),
  routeMessage: (job, _msg, finish) => {
    job.done = true;
    finish();
  },
  buildDispatch: (job) => [{ jobId: job.jobId }, []],
};

function makePool(poolSize: number, onFatal?: (message: string) => void) {
  FakeWorker.instances = [];
  const pool = createWorkerPool<TestJob, TestMsg>(
    () => new FakeWorker() as unknown as Worker,
    router,
    poolSize,
    { onFatal },
  );
  return { pool, workers: FakeWorker.instances };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createWorkerPool', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  it('creates the requested number of workers', () => {
    const { pool, workers } = makePool(3);
    expect(pool.size).toBe(3);
    expect(workers).toHaveLength(3);
  });

  it('queues jobs until a worker reports ready, then dispatches', () => {
    const { pool, workers } = makePool(2);
    const job = new TestJob(1);

    pool.dispatch(job);
    // Workers start in `init`; nothing dispatched yet.
    expect(workers.every((w) => w.posted.length === 0)).toBe(true);

    workers[0].emit({ type: 'ready' });
    expect(workers[0].posted).toEqual([{ jobId: 1 }]);
  });

  it('queues a second job while busy and drains it when the first finishes', () => {
    const { pool, workers } = makePool(1);
    const j1 = new TestJob(1);
    const j2 = new TestJob(2);

    workers[0].emit({ type: 'ready' });
    pool.dispatch(j1);
    pool.dispatch(j2);
    expect(workers[0].posted).toEqual([{ jobId: 1 }]);

    workers[0].emit({ type: 'result', jobId: 1 });
    expect(j1.done).toBe(true);
    expect(workers[0].posted).toEqual([{ jobId: 1 }, { jobId: 2 }]);
  });

  it('dispatches queued jobs in priority order (lower first)', () => {
    const { pool, workers } = makePool(1);
    const busy = new TestJob(1);
    const low = new TestJob(2, 10);
    const high = new TestJob(3, 1);

    workers[0].emit({ type: 'ready' });
    pool.dispatch(busy); // occupies the only worker
    pool.dispatch(low); // queued
    pool.dispatch(high); // queued

    workers[0].emit({ type: 'result', jobId: 1 }); // frees worker → drains by priority
    expect(workers[0].posted).toEqual([{ jobId: 1 }, { jobId: 3 }]);

    workers[0].emit({ type: 'result', jobId: 3 });
    expect(workers[0].posted).toEqual([{ jobId: 1 }, { jobId: 3 }, { jobId: 2 }]);
  });

  it('cancel() removes a queued job and notifies it, without dispatching it', () => {
    const { pool, workers } = makePool(1);
    const busy = new TestJob(1);
    const queued = new TestJob(2);

    workers[0].emit({ type: 'ready' });
    pool.dispatch(busy);
    pool.dispatch(queued);

    pool.cancel(queued.jobId);
    expect(queued.cancelled).toBe(true);

    // Finishing the busy job must not dispatch the cancelled one.
    workers[0].emit({ type: 'result', jobId: 1 });
    expect(workers[0].posted).toEqual([{ jobId: 1 }]);
  });

  it('cancel() signals a cancel message to the worker for an in-flight job', () => {
    const { pool, workers } = makePool(1);
    const job = new TestJob(1);

    workers[0].emit({ type: 'ready' });
    pool.dispatch(job);
    pool.cancel(job.jobId);

    expect(workers[0].posted).toContainEqual({ type: 'cancel' });
    expect(job.cancelled).toBe(false); // in-flight cancel is acknowledged by the worker, not here
  });

  it('cancelAll() cancels queued jobs and signals busy workers', () => {
    const { pool, workers } = makePool(1);
    const busy = new TestJob(1);
    const queued = new TestJob(2);

    workers[0].emit({ type: 'ready' });
    pool.dispatch(busy);
    pool.dispatch(queued);

    pool.cancelAll();
    expect(queued.cancelled).toBe(true);
    expect(workers[0].posted).toContainEqual({ type: 'cancel' });
  });

  it('ignores result messages for unknown / already-finished jobs', () => {
    const { pool, workers } = makePool(1);
    workers[0].emit({ type: 'ready' });

    // No job in flight with id 999 — must not throw and must leave worker idle.
    expect(() => workers[0].emit({ type: 'result', jobId: 999 })).not.toThrow();

    const job = new TestJob(1);
    pool.dispatch(job);
    expect(workers[0].posted).toEqual([{ jobId: 1 }]);
  });

  it('dispose() terminates workers and blocks further dispatch', () => {
    const { pool, workers } = makePool(2);
    workers.forEach((w) => w.emit({ type: 'ready' }));

    pool.dispose();
    expect(workers.every((w) => w.terminated)).toBe(true);

    pool.dispatch(new TestJob(1));
    expect(workers.every((w) => w.posted.length === 0)).toBe(true);
  });
});

describe('createWorkerPool: failure handling', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  it('dispose() settles in-flight and queued jobs via onCancelled', () => {
    const { pool, workers } = makePool(1);
    const inFlight = new TestJob(1);
    const queued = new TestJob(2);
    workers[0].emit({ type: 'ready' });
    pool.dispatch(inFlight);
    pool.dispatch(queued);

    pool.dispose();
    expect(inFlight.cancelled).toBe(true);
    expect(queued.cancelled).toBe(true);
    expect(inFlight.errored).toBeNull();
  });

  it('dispatch() after dispose() cancels the job instead of dropping it', () => {
    const { pool } = makePool(1);
    pool.dispose();
    const job = new TestJob(1);
    pool.dispatch(job);
    expect(job.cancelled).toBe(true);
  });

  it('init-error marks the worker dead and fails jobs once all workers are dead', () => {
    const onFatal = vi.fn();
    const { pool, workers } = makePool(2, onFatal);
    const job = new TestJob(1);
    pool.dispatch(job); // queued: no worker ready yet

    workers[0].emit({ type: 'init-error', message: 'wasm boom' });
    expect(workers[0].terminated).toBe(true);
    expect(job.errored).toBeNull(); // the other worker may still come up
    expect(onFatal).not.toHaveBeenCalled();

    workers[1].emit({ type: 'init-error', message: 'wasm boom' });
    expect(job.errored).toContain('wasm boom');
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('wasm boom');
    // Init failures are deterministic, so no replacement worker is spawned.
    expect(FakeWorker.instances).toHaveLength(2);

    // A fatal pool fails new jobs immediately rather than queueing them forever.
    const late = new TestJob(2);
    pool.dispatch(late);
    expect(late.errored).toContain('wasm boom');
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('a surviving worker keeps serving jobs after another fails init', () => {
    const onFatal = vi.fn();
    const { pool, workers } = makePool(2, onFatal);
    workers[0].emit({ type: 'init-error', message: 'boom' });
    workers[1].emit({ type: 'ready' });

    pool.dispatch(new TestJob(1));
    expect(workers[1].posted).toEqual([{ jobId: 1 }]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('runtime onerror fails the in-flight job and replaces the worker once', () => {
    const onFatal = vi.fn();
    const { pool, workers } = makePool(1, onFatal);
    workers[0].emit({ type: 'ready' });
    const j1 = new TestJob(1);
    pool.dispatch(j1);

    workers[0].crash('kaboom');
    expect(j1.errored).toContain('kaboom');
    expect(workers[0].terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(onFatal).not.toHaveBeenCalled();

    // The replacement comes up and serves the next job.
    const replacement = FakeWorker.instances[1];
    replacement.emit({ type: 'ready' });
    const j2 = new TestJob(2);
    pool.dispatch(j2);
    expect(replacement.posted).toEqual([{ jobId: 2 }]);

    // A second failure in the same slot is final: the pool goes fatal.
    const queued = new TestJob(3);
    pool.dispatch(queued);
    replacement.crash('kaboom again');
    expect(j2.errored).toContain('kaboom again');
    expect(queued.errored).toContain('kaboom again');
    expect(FakeWorker.instances).toHaveLength(2);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('onmessageerror is treated as a worker failure', () => {
    const { pool, workers } = makePool(1);
    workers[0].emit({ type: 'ready' });
    const job = new TestJob(1);
    pool.dispatch(job);

    workers[0].onmessageerror?.();
    expect(job.errored).toMatch(/deserialized/);
  });

  it('ignores late messages from a replaced worker', () => {
    const { pool, workers } = makePool(1);
    const original = workers[0];
    original.emit({ type: 'ready' });
    pool.dispatch(new TestJob(1));
    const staleHandler = original.onmessage;
    original.crash('x');

    pool.dispatch(new TestJob(2)); // queued until the replacement is ready
    // A late 'ready' from the terminated worker must not free the slot.
    staleHandler?.({ data: { type: 'ready' } });
    expect(FakeWorker.instances[1].posted).toEqual([]);
    expect(original.posted).toEqual([{ jobId: 1 }]);
  });
});
