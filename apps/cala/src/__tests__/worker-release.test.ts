// @vitest-environment node
/**
 * Workers ended once their stage is over (only ending a worker returns its WASM memory) and
 * started again, wired anew, when the next run needs them: the slow worker with its visit
 * workers, the look-back workers, the flat-field worker, the compress helpers.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSlowClient, type SlowWorkerLike } from '../lib/slow-client.ts';
import { createLookbackClient, type LookbackWorkerLike } from '../lib/lookback-client.ts';
import { createCompressClient, type CompressWorkerLike } from '../lib/compress-client.ts';
import { createFrameClient } from '../lib/frame-client.ts';
import { inertWorker } from './fake-workers.ts';

/** Workers made by a factory, in order, each recording what it is sent. */
function factory<W>() {
  const made: { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }[] = [];
  const make = () => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
    made.push(w);
    return w as unknown as W;
  };
  const types = (i: number) =>
    made[i].postMessage.mock.calls.map(([m]) => (m as { type?: string }).type);
  return { made, make, types };
}

describe('slow client release', () => {
  function setup() {
    const slow = factory<SlowWorkerLike>();
    const visit = factory<SlowWorkerLike>();
    const connectSlow = vi.fn(() => Promise.resolve());
    const client = createSlowClient({ connectSlow }, () => {}, slow.make, 2, visit.make);
    return { client, slow, visit, connectSlow };
  }

  it('ends the slow worker and its visit workers; run messages meanwhile are dropped', () => {
    const t = setup();
    t.client.release();
    expect(t.slow.made[0].terminate).toHaveBeenCalledOnce();
    for (const v of t.visit.made) expect(v.terminate).toHaveBeenCalledOnce();
    const before = t.slow.made[0].postMessage.mock.calls.length;
    t.client.settlePool(3, 0);
    t.client.stopSettling(3);
    t.client.factorsFailed(3, 'x');
    t.client.addReviewed(3, new Float32Array(1));
    expect(t.slow.made[0].postMessage.mock.calls.length).toBe(before);
    // Nothing was started again for them.
    expect(t.slow.made).toHaveLength(1);
    expect(t.visit.made).toHaveLength(2);
  });

  it('ready() starts and wires new workers, with the pace and cap sent meanwhile', async () => {
    const t = setup();
    t.client.release();
    t.client.settlePace(30, false);
    t.client.settleCap(2);
    await t.client.ready();
    expect(t.slow.made).toHaveLength(2);
    expect(t.visit.made).toHaveLength(4);
    expect(t.slow.types(1)).toEqual(['connect', 'settle-pace', 'settle-cap']);
    expect(t.connectSlow).toHaveBeenCalledTimes(2);
    // Running already: nothing more is started.
    await t.client.ready();
    expect(t.slow.made).toHaveLength(2);
  });

  it('a look-back port after a release starts the slow worker for it', () => {
    const t = setup();
    t.client.release();
    t.client.connectLookback({} as MessagePort, 0);
    expect(t.slow.made).toHaveLength(2);
    expect(t.slow.types(1)).toEqual(['connect', 'lookback-port']);
  });
});

describe('look-back client release', () => {
  it('ends every look-back worker; the next run starts worker 0 and connects it again', () => {
    const lb = factory<LookbackWorkerLike>();
    const connected: number[] = [];
    const client = createLookbackClient({
      slow: { connectLookback: (_p, i) => connected.push(i ?? 0) },
      pool: 1,
      source: () => ({ entries: [] }),
      blocked: () => null,
      makeWorker: lb.make,
      makeChannel: () => ({ port1: {} as MessagePort, port2: {} as MessagePort }),
    });
    expect(client.begin(1)).toBe(true);
    client.release!();
    expect(lb.made[0].terminate).toHaveBeenCalledOnce();
    // The run is gone with them: nothing goes out for it.
    client.final!(1);
    expect(lb.made).toHaveLength(1);
    expect(client.begin(2)).toBe(true);
    expect(lb.made).toHaveLength(2);
    expect(connected).toEqual([0, 0]);
    expect(lb.types(1)).toEqual(['connect', 'begin']);
  });
});

describe('flat-field worker release', () => {
  function setup() {
    const flat = factory<ReturnType<typeof inertWorker>>();
    const frame = inertWorker();
    // Answer every request at once (`link-flat` gets `ok`, `pipeline-start` its plan).
    vi.mocked(frame.postMessage).mockImplementation((m: unknown) => {
      const { id, type } = m as { id: number; type: string };
      queueMicrotask(() =>
        frame.onmessage!.call(
          {} as Worker,
          {
            data:
              type === 'pipeline-start'
                ? { type: 'pipeline-ready', id, plan: {} }
                : { type: 'ok', id },
          } as MessageEvent,
        ),
      );
    });
    const client = createFrameClient(() => frame, {
      makeMotionWorker: inertWorker,
      makeTraceWorker: inertWorker,
      makeFlatFieldWorker: flat.make,
    });
    const sent = () =>
      vi.mocked(frame.postMessage).mock.calls.map(([m]) => (m as { type: string }).type);
    return { client, flat, sent };
  }

  it('a Discover start after a release starts and links a new one first; Extract does not', async () => {
    const t = setup();
    t.client.releaseFlatField!();
    expect(t.flat.made[0].terminate).toHaveBeenCalledOnce();
    await t.client.startPipeline({}, undefined, { frameCount: 1 } as never);
    expect(t.flat.made).toHaveLength(1);
    await t.client.startPipeline({ flatField: false });
    expect(t.flat.made).toHaveLength(1);
    await t.client.startPipeline({});
    expect(t.flat.made).toHaveLength(2);
    expect(t.flat.types(1)).toEqual(['flat-link']);
    const s = t.sent();
    expect(s.lastIndexOf('link-flat')).toBeLessThan(s.lastIndexOf('pipeline-start'));
    t.client.dispose();
    expect(t.flat.made[1].terminate).toHaveBeenCalledOnce();
  });
});

describe('compress helpers release', () => {
  it('ends the helpers and tells the compress worker; back-fill or Extract revive them first', () => {
    const main = factory<CompressWorkerLike>();
    const helpers = factory<CompressWorkerLike>();
    const client = createCompressClient(
      { connectCompress: () => Promise.resolve() },
      () => {},
      main.make,
      undefined,
      { count: 2, make: helpers.make },
    );
    client.releaseHelpers();
    expect(helpers.made.map((h) => h.terminate.mock.calls.length)).toEqual([1, 1]);
    const lost = main.made[0].postMessage.mock.calls.filter(([m]) => m.type === 'helper-lost');
    expect(lost.map(([m]) => m.helper)).toEqual([0, 1]);
    client.extract(1, 1, 1, new Uint8Array(1));
    expect(helpers.made).toHaveLength(4);
    const types = main.types(0);
    expect(types.slice(-3)).toEqual(['helper-revive', 'helper-revive', 'extract']);
    // Live already: a back-fill starts none.
    client.backfill(1, 1);
    client.helpersReady();
    expect(helpers.made).toHaveLength(4);
  });
});
