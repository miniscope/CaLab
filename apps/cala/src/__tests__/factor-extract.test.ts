import { createComputed, createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createCompressStore, extractSourceText, factorState } from '../lib/compress-store.ts';
import { createPass2Factors } from '../lib/factor-extract.ts';
import type { FovProjections } from '../lib/fov-projection.ts';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';

const st = (p: Partial<CompressStatus> = {}): CompressStatus => ({
  windows: 2,
  frames: 100,
  pending: 0,
  pendingFrames: 0,
  meanRank: 3,
  msPerFrame: 1,
  factorBytes: 10,
  final: true,
  tiling: 'offset',
  source: 'replay',
  ...p,
});

describe('the factors of a run', () => {
  it('are ready once a replay on the offset grids covers every frame', () => {
    expect(factorState(null, null, false, 100)).toBe('none');
    expect(factorState(st({ source: 'discover', tiling: 'plain' }), null, false, 100)).toBe('none');
    expect(factorState(st({ source: 'discover', tiling: 'plain' }), null, true, 100)).toBe(
      'compressing',
    );
    expect(factorState(st({ final: false, pending: 1 }), null, false, 100)).toBe('compressing');
    expect(factorState(st(), null, false, 100)).toBe('ready');
    // The offset grids skip a last window of one frame: the factors miss it.
    expect(factorState(st({ frames: 99 }), null, false, 100)).toBe('unusable');
    expect(factorState(st({ tiling: 'plain' }), null, false, 100)).toBe('unusable');
    expect(factorState(st(), 'QuotaExceededError', false, 100)).toBe('unusable');
  });

  it('are none after a cancelled replay, whose reset status holds no window', () => {
    const cancelled = st({ windows: 0, frames: 0, final: false });
    expect(factorState(cancelled, null, false, 100)).toBe('none');
    expect(factorState(cancelled, null, true, 100)).toBe('compressing');
    expect(factorState(st({ windows: 0, final: false, pending: 1 }), null, false, 100)).toBe(
      'compressing',
    );
  });

  it('say what Extract will read', () => {
    expect(extractSourceText('ready', st())).toBe('Extract reads the factors (seconds).');
    expect(extractSourceText('compressing', st({ final: false, pending: 3 }))).toBe(
      'Extract replays the file: the factors are being compressed (3 windows waiting).',
    );
    expect(extractSourceText('none', null)).toBe(
      'Extract replays the file; the first replay compresses the frames for later Extracts.',
    );
    expect(extractSourceText('unusable', st())).toBe(
      'Extract replays the file: the factors do not cover the recording.',
    );
  });

  const OFFSET = { compress: true, compressTiling: 'offset', compressSession: 7 };

  it('let the first replay compress on the offset grids, and no later one', () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {} });
    const r1 = f.replayCompress(100);
    expect(r1.settings).toEqual(OFFSET);
    expect(f.state(100)).toBe('compressing');
    expect(f.replayCompress(100).settings).toEqual({});
    // A replay cut short releases the mark: the next replay compresses again.
    r1.ended(false);
    expect(f.state(100)).toBe('none');
    const r2 = f.replayCompress(100);
    expect(r2.settings).toEqual(OFFSET);
    // A replay that ended leaves the mark until the factors are ready.
    r2.ended(true);
    expect(f.state(100)).toBe('compressing');
    const proj = { spans: [] } as unknown as FovProjections;
    f.keepProjection(proj);
    expect(f.projection()).toBe(proj);
    store.onMessage({ type: 'status', session: 7, status: st() });
    expect(f.state(100)).toBe('ready');
    expect(f.info()).toEqual({ tiling: 'offset', meanRank: 3 });
    // A new run forgets everything.
    store.reset(8);
    expect(f.state(100)).toBe('none');
    expect(f.projection()).toBeNull();
  });

  it('let the next replay compress after a cancelled one posted its reset status', () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {} });
    const r1 = f.replayCompress(100);
    expect(r1.settings.compress).toBe(true);
    store.onMessage({
      type: 'status',
      session: 7,
      status: st({ windows: 0, frames: 0, final: false }),
    });
    r1.ended(false);
    expect(f.state(100)).toBe('none');
    expect(f.replayCompress(100).settings).toEqual(OFFSET);
  });

  it("keeps a replay's mark when a replay that did not compress is cancelled", () => {
    const store = createCompressStore();
    store.reset(7);
    store.onMessage({
      type: 'status',
      session: 7,
      status: st({ source: 'discover', tiling: 'plain' }),
    });
    const f = createPass2Factors(store, { extract() {} });
    f.replayCompress(100).ended(true); // replay 1 compresses; no replay status yet
    const r2 = f.replayCompress(100);
    expect(r2.settings).toEqual({});
    r2.ended(false); // cancelled: it held nothing
    r2.ended(false);
    expect(f.state(100)).toBe('compressing');
    expect(f.replayCompress(100).settings).toEqual({});
  });

  it('follows the mark in a reactive read', () => {
    createRoot((dispose) => {
      const store = createCompressStore();
      store.reset(7);
      const f = createPass2Factors(store, { extract() {} });
      const seen: string[] = [];
      createComputed(() => seen.push(f.state(100)));
      const r = f.replayCompress(100);
      r.ended(false);
      expect(seen).toEqual(['none', 'compressing', 'none']);
      dispose();
    });
  });
});

describe('Extract on factors from the main thread', () => {
  const win = (job: number, start: number): CompressToMain => ({
    type: 'extracted',
    session: 7,
    job,
    start,
    count: 2,
    ids: Uint32Array.of(1),
    traces: new Float32Array(2),
    signed: new Float32Array(2),
  });
  const setup = () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {} });
    return { store, f };
  };

  it("passes its job's windows in order and resolves at the job's end", async () => {
    const store = createCompressStore();
    store.reset(7);
    const posted: unknown[] = [];
    const f = createPass2Factors(store, {
      extract: (session, job, library) => posted.push({ session, job, n: library.length }),
    });
    const got: number[] = [];
    const done = f.extract(Uint8Array.of(1, 2), (w) => got.push(w.start));
    expect(posted).toEqual([{ session: 7, job: 1, n: 2 }]);
    store.onMessage(win(1, 0));
    store.onMessage(win(9, 2)); // another job: not this one's
    store.onMessage({ ...win(1, 2), session: 3 } as CompressToMain); // another run
    store.onMessage(win(1, 2));
    store.onMessage({ type: 'extract-done', session: 7, job: 1, frames: 4, msPerFrame: 0.5 });
    await expect(done).resolves.toEqual({ frames: 4, msPerFrame: 0.5 });
    expect(got).toEqual([0, 2]);
    expect(store.error()).toBeNull();
  });

  it("ignores an error of an earlier run's session", async () => {
    const { store, f } = setup();
    const done = f.extract(Uint8Array.of(1), () => {});
    store.onMessage({ type: 'error', session: 3, message: 'old quota error' });
    expect(store.error()).toBeNull();
    store.onMessage({ type: 'extract-done', session: 7, job: 1, frames: 4, msPerFrame: 0.5 });
    await expect(done).resolves.toEqual({ frames: 4, msPerFrame: 0.5 });
  });

  it("sends jobs under the store's session", () => {
    const store = createCompressStore();
    store.reset(9);
    const sent: number[] = [];
    const f = createPass2Factors(store, { extract: (session) => sent.push(session) });
    void f.extract(Uint8Array.of(1), () => {}).catch(() => {});
    expect(sent).toEqual([9]);
  });

  it("rejects with the job's error and leaves the compression without one", async () => {
    const { store, f } = setup();
    const done = f.extract(Uint8Array.of(1), () => {});
    store.onMessage({ type: 'error', session: 7, job: 1, message: 'out of memory' });
    await expect(done).rejects.toThrow('out of memory');
    expect(store.error()).toBeNull();
    // An error without a job is the compression's.
    store.onMessage({ type: 'error', session: 7, message: 'QuotaExceededError' });
    expect(store.error()).toBe('QuotaExceededError');
    expect(f.state(100)).toBe('unusable');
  });

  it("fails a pending job on a compression error, and drops the job's later messages", async () => {
    const { store, f } = setup();
    const got: number[] = [];
    const done = f.extract(Uint8Array.of(1), (w) => got.push(w.start));
    store.onMessage(win(1, 0));
    store.onMessage({ type: 'error', session: -1, message: 'the worker crashed' });
    await expect(done).rejects.toThrow('the worker crashed');
    store.onMessage(win(1, 2));
    store.onMessage({ type: 'extract-done', session: 7, job: 1, frames: 4, msPerFrame: 0.5 });
    expect(got).toEqual([0]);
  });

  it('fails a pending job when the store is reset (a new Discover), and drops its late messages', async () => {
    const { store, f } = setup();
    const got: number[] = [];
    const done = f.extract(Uint8Array.of(1), (w) => got.push(w.start));
    store.reset(8);
    await expect(done).rejects.toThrow();
    // The worker answers a job it ran against the old factors: forgotten.
    store.onMessage({ ...win(1, 0), session: 8 } as CompressToMain);
    store.onMessage({ type: 'extract-done', session: 8, job: 1, frames: 4, msPerFrame: 0.5 });
    store.onMessage(win(1, 0));
    expect(got).toEqual([]);
    // A later job is not mixed up with it.
    const next = f.extract(Uint8Array.of(1), (w) => got.push(w.start));
    store.onMessage({ type: 'extract-done', session: 8, job: 1, frames: 4, msPerFrame: 0.5 });
    store.onMessage({ type: 'extract-done', session: 8, job: 2, frames: 6, msPerFrame: 0.5 });
    await expect(next).resolves.toEqual({ frames: 6, msPerFrame: 0.5 });
  });

  it('fails a pending job when the store is cleared for a new run of the same session', async () => {
    const { store, f } = setup();
    const done = f.extract(Uint8Array.of(1), () => {});
    store.reset(7);
    await expect(done).rejects.toThrow();
  });

  it('never hands over the windows of a job that fails', async () => {
    const { store, f } = setup();
    const got: number[] = [];
    const done = f.extract(Uint8Array.of(1), (w) => got.push(w.start));
    store.onMessage(win(1, 0));
    store.onMessage({ type: 'error', session: 7, job: 1, message: 'out of memory' });
    await expect(done).rejects.toThrow('out of memory');
    store.onMessage(win(1, 2));
    expect(got).toEqual([0]);
  });
});
