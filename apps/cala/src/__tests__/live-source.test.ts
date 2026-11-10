// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIVE_HEADER_BYTES, LIVE_MAGIC, LiveSource, type SocketLike } from '../lib/live-source.ts';
import { nextStep } from '../lib/pipeline-engine.ts';
import { makePlan, PipelineCursor, UNBOUNDED } from '../lib/pipeline-plan.ts';

const W = 4;
const H = 3;
const PX = W * H;

/** A socket whose messages the test sends. */
class FakeSocket implements SocketLike {
  binaryType = 'blob';
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = 0;
  close(): void {
    this.closed++;
  }
  text(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Frame `index` whose pixels are all `index`. */
  frame(index: number, stampMs = index * 50): void {
    const buf = new ArrayBuffer(LIVE_HEADER_BYTES + PX);
    const v = new DataView(buf);
    v.setUint32(0, LIVE_MAGIC, true);
    v.setUint32(4, index, true);
    v.setFloat64(8, stampMs, true);
    new Uint8Array(buf, LIVE_HEADER_BYTES).fill(index & 0xff);
    this.onmessage?.({ data: buf });
  }
  end(frames?: number): void {
    this.text({ type: 'end', ...(frames === undefined ? {} : { frames }) });
  }
}

const HELLO = { type: 'hello', width: W, height: H, bitDepth: 8, fps: 20, name: 'rig' };

async function open(options = {}) {
  const socket = new FakeSocket();
  const opening = LiveSource.open(socket, 'ws://test', options);
  socket.text(HELLO);
  const source = await opening;
  return { socket, source };
}

/** Whether a promise has settled by the next microtask. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('LiveSource', () => {
  it('opens on the hello and describes an unbounded stream', async () => {
    const { source } = await open();
    expect(source.info).toMatchObject({
      frameCount: UNBOUNDED,
      width: W,
      height: H,
      bitDepth: 8,
      fps: 20,
      fpsSource: 'live',
      files: [],
      live: { url: 'ws://test', name: 'rig' },
    });
    expect(source.stats()).toMatchObject({ received: 0, queued: 0, ended: false });
  });

  it('rejects when the socket closes or sends frames before the hello', async () => {
    const a = new FakeSocket();
    const openingA = LiveSource.open(a, 'ws://a');
    a.onclose?.({});
    await expect(openingA).rejects.toThrow('closed before its hello');
    expect(a.closed).toBe(1);
    const b = new FakeSocket();
    const openingB = LiveSource.open(b, 'ws://b');
    b.frame(0);
    await expect(openingB).rejects.toThrow('before its hello');
    const c = new FakeSocket();
    const openingC = LiveSource.open(c, 'ws://c');
    c.text({ ...HELLO, bitDepth: 12 });
    await expect(openingC).rejects.toThrow('12-bit');
  });

  it('delivers frames in arrival order, waiting for them, and keeps the first ones for re-reads', async () => {
    const { socket, source } = await open({ retainFrames: 2 });
    const read = source.readFrames(0, 2);
    expect(await settled(read)).toBe(false);
    socket.frame(0);
    socket.frame(1);
    const first = await read;
    expect([...first]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    // The warm-ups read the first frames again.
    expect([...(await source.readFrames(0, 1))]).toEqual(new Array(PX).fill(0));
    socket.frame(2);
    socket.frame(3);
    socket.frame(4);
    // The processing walk reads on; a read past the retained frames releases what is before it.
    expect([...(await source.readFrames(2, 2))]).toEqual([
      ...new Array(PX).fill(2),
      ...new Array(PX).fill(3),
    ]);
    expect(source.stats()).toMatchObject({ received: 5, queued: 1, dropped: 0, missed: 0 });
    await expect(source.readFrames(1, 1)).rejects.toThrow('released');
    expect(await source.waitFor(5)).toBe(UNBOUNDED);
    expect(source.liveInfo()).toMatchObject({ received: 5, dropped: 0, missed: 0, queued: 1 });
  });

  it('counts frames the source skipped and keeps the stream contiguous', async () => {
    const { socket, source } = await open();
    socket.frame(0);
    socket.frame(1);
    socket.frame(3); // 2 never came
    socket.frame(2); // and arrives late: dropped
    socket.frame(4);
    const got = await source.readFrames(0, 4);
    expect([got[0], got[PX], got[2 * PX], got[3 * PX]]).toEqual([0, 1, 3, 4]);
    expect(source.stats()).toMatchObject({ received: 5, missed: 1, outOfOrder: 1, dropped: 0 });
    expect(source.liveInfo()).toMatchObject({ missed: 1, dropped: 1 });
  });

  it('drops new frames while the queue is full', async () => {
    const { socket, source } = await open({ maxQueuedBytes: 2 * PX, retainFrames: 0 });
    // A tiny cap still leaves room for the retained frames and a few reads.
    for (let i = 0; i < 130; i++) socket.frame(i);
    expect(source.stats()).toMatchObject({ received: 130, dropped: 2, queued: 128 });
    await source.readFrames(0, 128); // read and released
    socket.frame(130); // room again
    const got = await source.readFrames(128, 1);
    expect(got[0]).toBe(130);
    expect(source.stats()).toMatchObject({ received: 131, dropped: 2, queued: 0 });
    expect(source.liveInfo()).toMatchObject({ received: 131, dropped: 2 });
  });

  it('ends the stream on `end`, on a closed socket and on stop', async () => {
    const { socket, source } = await open();
    socket.frame(0);
    socket.frame(1);
    const waiting = source.waitFor(4);
    socket.end(2);
    expect(await waiting).toBe(2);
    expect(await source.waitFor(1)).toBe(2);
    expect(source.stats()).toMatchObject({ ended: true, aborted: false });
    await expect(source.readFrames(1, 2)).rejects.toThrow('past the end');
    socket.frame(2); // after the end: ignored
    expect(source.frames).toBe(2);

    const b = await open();
    b.socket.frame(0);
    b.socket.onclose?.({});
    expect(await b.source.waitFor(10)).toBe(1);
    expect(b.source.stats()).toMatchObject({ ended: true, aborted: true });

    const c = await open();
    c.socket.frame(0);
    c.source.stop();
    expect(c.socket.closed).toBe(1);
    expect(await c.source.waitFor(10)).toBe(1);
  });

  it('fails the pending read on a malformed frame', async () => {
    const { socket, source } = await open();
    const errors: string[] = [];
    source.onError = (err) => errors.push(err.message);
    const read = source.readFrames(0, 1);
    socket.onmessage?.({ data: new ArrayBuffer(5) });
    await expect(read).rejects.toThrow('expected');
    expect(errors).toHaveLength(1);
    expect(socket.closed).toBe(1);
  });
});

describe('unbounded pipeline plan', () => {
  it('keeps the warm-ups and hands out batches until the stream is bounded', async () => {
    const plan = makePlan(UNBOUNDED, { calibrationFrames: 3, motionWarmupFrames: 2, batchSize: 2 });
    expect(plan).toMatchObject({
      frameCount: UNBOUNDED,
      calibrationFrames: 3,
      motionWarmupFrames: 2,
    });
    const { socket, source } = await open({ retainFrames: 3 });
    const cursor = new PipelineCursor(plan);
    const steps: string[] = [];
    const run = (async () => {
      for (let s = await nextStep(cursor, source); s; s = await nextStep(cursor, source)) {
        await source.readFrames(s.start, s.count);
        steps.push(`${s.phase[0]}${s.start}+${s.count}${s.last ? '!' : ''}`);
      }
    })();
    for (let i = 0; i < 7; i++) socket.frame(i);
    await new Promise((r) => setTimeout(r, 0));
    expect(steps).toEqual(['c0+3!', 'm0+2!', 'p0+2', 'p2+2', 'p4+2']);
    socket.end(7);
    await run;
    expect(steps.at(-1)).toBe('p6+1!');
    expect(plan.frameCount).toBe(7);
  });

  it('bounds a stream that ends during the calibration', async () => {
    const plan = makePlan(UNBOUNDED, { calibrationFrames: 200, motionWarmupFrames: 200 });
    const { socket, source } = await open();
    const cursor = new PipelineCursor(plan);
    const first = nextStep(cursor, source);
    socket.frame(0);
    socket.frame(1);
    socket.end();
    expect(await first).toMatchObject({ phase: 'calibrate', start: 0, count: 2, last: true });
    expect(plan).toMatchObject({ frameCount: 2, calibrationFrames: 2, motionWarmupFrames: 2 });
  });
});
