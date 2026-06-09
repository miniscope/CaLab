import { describe, it, expect, beforeEach } from 'vitest';
import { createWorkerPool, type BaseJob, type MessageRouter } from '@calab/compute';

// ── Test doubles ────────────────────────────────────────────────────────────

type TestMsg = { type: 'ready' } | { type: 'result'; jobId: number };

/** Minimal stand-in for the DOM Worker the pool drives. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: TestMsg }) => void) | null = null;
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

function makePool(poolSize: number) {
  FakeWorker.instances = [];
  const pool = createWorkerPool<TestJob, TestMsg>(
    () => new FakeWorker() as unknown as Worker,
    router,
    poolSize,
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
