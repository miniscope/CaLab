// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { runStripJob, stripJob, type StripBuilderLike } from '../lib/strip-plan.ts';
import { workByKind, workRates, emptyWork } from '../lib/work-meter.ts';
import { gridGroups } from '../lib/work-display.ts';
import type { FastToSlow, OwnerToVisit, SlowToFast, SlowToMain } from '../workers/slow-types.ts';
import type { OwnerToStrip } from '../workers/strip-types.ts';

function fakeLib(version: number): PublishedLibrary {
  return {
    version,
    ids: () => Uint32Array.of(1),
    centers: () => Float32Array.of(0, 0),
    radii: () => Float32Array.of(1),
    supportStarts: () => Uint32Array.of(0, 1),
    supportPixels: () => Uint32Array.of(0),
    footprintValues: () => Float32Array.of(1),
    toBytes: () => Uint8Array.of(version),
    free: vi.fn(),
  };
}

const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 1,
  width: 2,
  height: 3,
  fov: Uint8Array.of(1, 1, 1, 1, 1, 1),
  noise: new Float32Array(6).fill(1),
  cellDiameterPx: 10,
  flattenSigmaPx: 0,
  budget: 123,
};

function batch(start: number, version: number): Extract<FastToSlow, { type: 'frames' }> {
  // Two 2x3 frames: frame f's pixel p holds 10 f + p; one cell.
  const frames = Float32Array.from({ length: 12 }, (_, i) => 10 * Math.floor(i / 6) + (i % 6));
  return {
    type: 'frames',
    session: 1,
    start,
    count: 2,
    version,
    cells: 1,
    frames,
    traces: Float32Array.of(0.5, 1.5),
  };
}

function setup() {
  const calls: string[] = [];
  let frames = 0;
  let jobsLeft = 1;
  let published = false;
  const local: { frames: number[]; keys: number[] }[] = [];
  const loop: SlowLoopLike = {
    observe: () => {
      calls.push('observe');
      frames++;
      return true;
    },
    step: vi.fn(() => undefined),
    finalize: vi.fn(() => fakeLib(9)),
    setNoise: vi.fn(),
    cellCount: 1,
    reservoirBytes: 0,
    stats: () => new Float64Array(17),
    free: vi.fn(),
    takeJob: () => (jobsLeft-- > 0 ? Uint8Array.of(1) : undefined),
    applyJob: () => void calls.push('applyJob'),
    housekeep: () => {
      calls.push('housekeep');
      if (published) return undefined;
      published = true;
      return fakeLib(5);
    },
    get frames() {
      return frames;
    },
    // Two strips: rows 0..2 and 1..3; the second frame of a batch is held out.
    stripsBegin: (version: number) => {
      calls.push(`begin:${version}`);
      return Uint32Array.of(0, 2, 1, 3);
    },
    stripContext: (i: number) => Uint8Array.of(100 + i),
    stripsKeys: () => Float64Array.of(frames),
    stripsAdd: (b: Uint8Array) => void calls.push(`add:${[...b].join(',')}`),
    stripsApply: () => void calls.push('apply'),
    stripLocal: (_v, ctx, f, _t, _c, _b, keys) => {
      local.push({ frames: [...f], keys: [...keys] });
      return Uint8Array.of(50 + ctx[0]);
    },
  };
  const toMain = { postMessage: vi.fn<(m: SlowToMain) => void>() };
  const toFast = { postMessage: vi.fn<(m: SlowToFast) => void>() };
  const visit = { postMessage: vi.fn<(m: OwnerToVisit) => void>() };
  const strips = [0, 1].map(() => ({ postMessage: vi.fn<(m: OwnerToStrip) => void>() }));
  const runner = new SlowRunner({
    create: () => loop,
    toFast,
    toMain,
    visits: [visit],
    strips,
  });
  return { runner, calls, strips, toMain, local };
}

const jobsOf = (p: { postMessage: { mock: { calls: unknown[][] } } }) =>
  p.postMessage.mock.calls
    .map((c) => c[0] as OwnerToStrip)
    .filter((m): m is Extract<OwnerToStrip, { type: 'job' }> => m.type === 'job');

describe('strip helpers (SlowRunner)', () => {
  it('sums a Discover batch on the helpers and holds visit results until the deltas are added', async () => {
    const { runner, calls, strips, local } = setup();
    runner.handle(INIT);
    const pause = () => Promise.resolve();
    // Version 0 (no helper holds it): the ordinary way; housekeep publishes version 5.
    await runner.handleAsync(batch(0, 0), pause);
    expect(calls).not.toContain('begin:0');
    for (const s of strips)
      expect(s.postMessage.mock.calls.map((c) => (c[0] as OwnerToStrip).type)).toEqual([
        'reset',
        'init',
        'library',
      ]);
    calls.length = 0;
    const done = runner.handleAsync(batch(2, 5), pause);
    await Promise.resolve();
    // Both frames observed; the deltas are out.
    expect(calls).toEqual(['begin:5', 'observe', 'observe']);
    const jobs = strips.map((s) => jobsOf(s)[0]);
    expect(jobs.map((j) => [j.row0, j.row1, j.context[0]])).toEqual([
      [0, 2, 100],
      [1, 3, 101],
    ]);
    // Only the fitting frame (key 2 = the batch's first), only the strip's rows.
    expect([...jobs[1].keys]).toEqual([2]);
    expect([...jobs[1].frames]).toEqual([2, 3, 4, 5]);
    expect([...jobs[1].traces]).toEqual([0.5]);
    // A visit result now waits.
    runner.handleVisit(0, { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 });
    expect(calls).not.toContain('applyJob');
    runner.handleStrip(0, {
      type: 'delta',
      session: 1,
      id: jobs[0].id,
      bytes: Uint8Array.of(7),
      ms: 3,
    });
    expect(calls).not.toContain('apply');
    // Helper 1 failed: its job is summed here.
    runner.handleStrip(1, { type: 'error', session: 1, id: jobs[1].id, message: 'x' });
    await done;
    expect(local).toEqual([{ frames: [2, 3, 4, 5], keys: [2] }]);
    expect(calls.slice(3)).toEqual([
      'add:7',
      'add:151',
      'apply',
      'housekeep',
      'applyJob',
      'housekeep',
    ]);
  });

  it('counts the helpers as their own group in the worker grid', () => {
    const a = emptyWork(1);
    const b = {
      ...emptyWork(1),
      wallMs: 1000,
      stripBusyMs: [
        [250, 0],
        [0, 500],
      ],
    };
    a.stripBusyMs = [
      [0, 0],
      [0, 0],
    ];
    const r = workRates(a, b)!;
    const by = workByKind(r);
    const groups = gridGroups(by).map((g) => [g.label, g.squares.map((s) => s.label)]);
    expect(groups).toContainEqual([
      'Statistics helpers',
      ['statistics helper 1', 'statistics helper 2'],
    ]);
    const rows = by.workers.filter((w) => w.group === 'strip');
    expect(rows.map((w) => [w.shares.discovery, w.shares.finalSettle])).toEqual([
      [0.25, 0],
      [0, 0.5],
    ]);
  });
});

describe('strip jobs', () => {
  it('cuts the rows of the fitting frames and sums them in order', () => {
    const src = {
      width: 2,
      height: 3,
      frames: Float32Array.from({ length: 12 }, (_, i) => i),
      traces: Float32Array.of(1, 2),
      cells: 1,
      background: Float32Array.of(3, 4),
      count: 2,
    };
    const job = stripJob(
      src,
      [1],
      Float64Array.of(9),
      { row0: 1, row1: 2 },
      {
        session: 1,
        id: 1,
        version: 5,
        context: Uint8Array.of(1),
      },
    );
    expect([...job.frames]).toEqual([8, 9]);
    expect([...job.traces]).toEqual([2]);
    expect([...job.background!]).toEqual([4]);
    const pushed: unknown[] = [];
    const b: StripBuilderLike = {
      begin: (c) => void pushed.push(['begin', c[0]]),
      push: (f, _l, t, bg, k) => void pushed.push([[...f], [...t], [...bg!], k]),
      finish: () => Uint8Array.of(42),
    };
    expect([...runStripJob(b, null, job)]).toEqual([42]);
    expect(pushed).toEqual([
      ['begin', 1],
      [[8, 9], [2], [4], 9],
    ]);
  });
});
