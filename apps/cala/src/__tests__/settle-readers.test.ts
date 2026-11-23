// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SettleReaderJob } from '../lib/lookback-reader.ts';
import {
  SettleReaders,
  settleReaderCount,
  type FromSettleReader,
  type SettleReaderLike,
  type ToSettleReader,
} from '../lib/settle-readers.ts';
import { StagePool } from '../lib/stage-pool.ts';

const PX = 4;
const CHUNK = 2;

/** A fake reader: it answers only when told to (`answer`), writing frame index + 0.5 into each pixel. */
class FakeReader implements SettleReaderLike {
  onmessage: ((e: MessageEvent<FromSettleReader>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  jobs: Extract<ToSettleReader, { type: 'job' }>[] = [];
  inits = 0;
  flats: number[] = [];
  terminated = false;
  postMessage(msg: ToSettleReader): void {
    if (msg.type === 'init') this.inits++;
    else if (msg.type === 'flat') this.flats.push(msg.seq);
    else this.jobs.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  send(msg: FromSettleReader): void {
    this.onmessage?.({ data: msg } as MessageEvent<FromSettleReader>);
  }
  ready(): void {
    this.send({ type: 'ready' });
  }
  /** Answer the oldest job. */
  answer(flatSeq = 0): void {
    const j = this.jobs.shift()!;
    j.job.frames.forEach((f, i) => j.buf.fill(f + 0.5, i * PX, (i + 1) * PX));
    this.send({ type: 'done', id: j.id, buf: j.buf, flatSeq, busyMs: 3 });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(planFrames: number[], count = 2, depth = 3) {
  const pool = new StagePool(2 + depth, CHUNK * PX);
  const readers: FakeReader[] = [];
  const forget = vi.fn(() => pool.forget());
  const release = vi.fn((b: Float32Array) => pool.release(b));
  const job = vi.fn(async (frames: readonly number[]): Promise<SettleReaderJob> => ({
    frames: Float64Array.from(frames),
    dy: new Float32Array(frames.length),
    dx: new Float32Array(frames.length),
    flags: new Uint8Array(frames.length),
    flickerOffset: new Float32Array(frames.length),
    flickerGain: new Float32Array(frames.length),
    warp: new Float32Array(3 * frames.length),
  }));
  const plan = planFrames.map((frame, i) => ({ frame, block: -1 - (i < 4 ? 0 : 1) }));
  const sr = new SettleReaders(
    {
      makeReader: () => {
        const r = new FakeReader();
        readers.push(r);
        return r;
      },
      acquire: () => pool.acquire(),
      release,
      forget,
      job,
    },
    plan,
    {
      count,
      depth,
      chunk: CHUNK,
      source: { entries: [] },
      front: Uint8Array.of(1, 2, 3),
      flat: { map: null, seq: 0 },
    },
  );
  const request = (k: number) => plan.slice(k * CHUNK, (k + 1) * CHUNK);
  return { sr, pool, readers, forget, release, job, plan, request };
}

describe('SettleReaders', () => {
  it('prepares the plan ahead in request-sized chunks, in order, at most `depth` ahead', async () => {
    const t = setup([10, 11, 12, 13, 40, 41, 42, 43, 44, 45], 2, 3);
    expect(t.readers.map((r) => r.inits)).toEqual([1, 1]);
    t.readers.forEach((r) => r.ready());
    await tick();
    // One chunk per reader (two readers), each the slow worker's next requests.
    expect(t.readers.map((r) => r.jobs.map((j) => Array.from(j.job.frames)))).toEqual([
      [[10, 11]],
      [[12, 13]],
    ]);
    t.readers[0].answer();
    await tick();
    // Reader 0 is free: chunk 2 goes out (3 ahead: 0 ready, 1 and 2 out); chunk 3 waits for a request.
    expect(t.readers[0].jobs.map((j) => Array.from(j.job.frames))).toEqual([[40, 41]]);
    const got = await t.sr.take(t.request(0));
    expect(Array.from(got!.buf)).toEqual([10.5, 10.5, 10.5, 10.5, 11.5, 11.5, 11.5, 11.5]);
    expect(got!.flatSeq).toBe(0);
    // The request was served: chunk 3 may go out now, to the first free reader.
    t.readers[1].answer();
    await tick();
    expect(t.readers[1].jobs.map((j) => Array.from(j.job.frames))).toEqual([[42, 43]]);
    const second = await t.sr.take(t.request(1));
    expect(second!.buf[0]).toBe(12.5);
    expect(t.sr.drainBusy()).toEqual([3, 3]);
    expect(t.sr.drainBusy()).toEqual([0, 0]);
  });

  it('a request whose chunk was not handed out yet is served on worker 0, and the readers go on after it', async () => {
    const t = setup([0, 1, 2, 3, 4, 5]);
    // Readers not up yet: the first request is worker 0's.
    expect(await t.sr.take(t.request(0))).toBeNull();
    t.readers.forEach((r) => r.ready());
    await tick();
    expect(t.readers[0].jobs.map((j) => Array.from(j.job.frames))).toEqual([[2, 3]]);
    t.readers[0].answer();
    expect((await t.sr.take(t.request(1)))!.buf[0]).toBe(2.5);
  });

  it('requests served before the readers were set up are passed over', async () => {
    const late = setup([0, 1, 2, 3, 4, 5], 1, 1);
    // Request 0 was served before the readers existed: request 1 comes first.
    expect(await late.sr.take(late.request(1))).toBeNull();
    late.readers[0].ready();
    await tick();
    expect(late.readers[0].jobs.map((j) => Array.from(j.job.frames))).toEqual([[4, 5]]);
    late.readers[0].answer();
    expect((await late.sr.take(late.request(2)))!.buf[0]).toBe(4.5);
  });

  it('a request off the plan ends the readers; every later request is worker 0 alone', async () => {
    const t = setup([0, 1, 2, 3]);
    t.readers.forEach((r) => r.ready());
    await tick();
    expect(
      await t.sr.take([
        { frame: 7, block: -1 },
        { frame: 8, block: -1 },
      ]),
    ).toBeNull();
    // Readers with a chunk out end once it comes back (with its buffer), the others at once.
    t.readers[0].answer();
    t.readers[1].answer();
    expect(t.readers.every((r) => r.terminated)).toBe(true);
    expect(await t.sr.take(t.request(0))).toBeNull();
    // Every buffer came back to the pool.
    expect(t.pool.inFlight).toBe(0);
  });

  it('stop gives back ready chunks; a chunk out comes back before its reader ends', async () => {
    const t = setup([0, 1, 2, 3, 4, 5], 2, 3);
    t.readers.forEach((r) => r.ready());
    await tick();
    t.readers[0].answer();
    await tick();
    // Chunk 0 ready, chunk 1 out with reader 1, chunk 2 out with reader 0.
    t.sr.stop();
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(t.readers.some((r) => r.terminated)).toBe(false);
    t.readers[1].answer();
    t.readers[0].answer();
    expect(t.readers.every((r) => r.terminated)).toBe(true);
    expect(t.pool.inFlight).toBe(0);
    expect(t.forget).not.toHaveBeenCalled();
    expect(await t.sr.take(t.request(0))).toBeNull();
  });

  it('a reader that fails loses its chunk (served on worker 0) and its buffer; the others go on', async () => {
    const t = setup([0, 1, 2, 3, 4, 5], 2, 3);
    t.readers.forEach((r) => r.ready());
    await tick();
    t.readers[0].send({ type: 'error', id: t.readers[0].jobs[0].id, message: 'boom' });
    expect(t.readers[0].terminated).toBe(true);
    expect(t.forget).toHaveBeenCalledTimes(1);
    expect(await t.sr.take(t.request(0))).toBeNull();
    t.readers[1].answer();
    expect((await t.sr.take(t.request(1)))!.buf[0]).toBe(2.5);
    await tick();
    // Chunk 2 goes to the reader left.
    expect(t.readers[1].jobs.map((j) => Array.from(j.job.frames))).toEqual([[4, 5]]);
    expect(t.sr.live).toBe(1);
  });

  it('forwards a newer flat field; a chunk says which map it used', async () => {
    const t = setup([0, 1, 2, 3]);
    t.readers.forEach((r) => r.ready());
    await tick();
    t.sr.setFlat(null, 4);
    expect(t.readers.map((r) => r.flats)).toEqual([[4], [4]]);
    t.readers[0].answer(3);
    expect((await t.sr.take(t.request(0)))!.flatSeq).toBe(3);
  });

  it('dispose writes off buffers still out', async () => {
    const t = setup([0, 1, 2, 3]);
    t.readers.forEach((r) => r.ready());
    await tick();
    t.sr.dispose();
    expect(t.forget).toHaveBeenCalledTimes(2);
    expect(t.readers.every((r) => r.terminated)).toBe(true);
  });
});

describe('settleReaderCount', () => {
  it('takes two readers from 6 cores, one from 4, none below; an override wins (0 included)', () => {
    expect(settleReaderCount(18)).toBe(2);
    expect(settleReaderCount(6)).toBe(2);
    expect(settleReaderCount(4)).toBe(1);
    expect(settleReaderCount(2)).toBe(0);
    expect(settleReaderCount(undefined)).toBe(0);
    expect(settleReaderCount(18, 0)).toBe(0);
    expect(settleReaderCount(4, 3)).toBe(3);
    expect(settleReaderCount(4, 9)).toBe(4);
  });
});
