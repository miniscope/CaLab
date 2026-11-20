import { describe, expect, it } from 'vitest';
import {
  adapterTable,
  boundaryStats,
  buildCala,
  calaFunnel,
  extractRuns,
  failureTable,
  flagRegressions,
  pairRuns,
  sizeDistributions,
  stageModeTable,
  testerTable,
  unfinishedTable,
  versionComparison,
  extractFailures,
  fpsByAdapterClass,
} from '../lib/cala.ts';
import { indexEvents } from '../lib/metrics.ts';
import { T0, event, session } from './helpers.ts';

const at = (s: number) => T0 + s * 1000;
const started = (sid: string, s: number, stage = 'discover', extra = {}) =>
  event(
    sid,
    'run_started',
    {
      stage,
      mode: 'single',
      sessions: 1,
      frames: 1000,
      width: 100,
      height: 100,
      fps: 30,
      ...extra,
    },
    at(s),
  );
const finished = (sid: string, s: number, stage = 'discover', extra = {}) =>
  event(
    sid,
    'run_finished',
    {
      stage,
      mode: 'single',
      sessions: 1,
      frames: 1000,
      width: 100,
      height: 100,
      duration_s: 10,
      median_fps: 100,
      cells: 12,
      ...extra,
    },
    at(s),
  );

describe('pairRuns (started vs finished)', () => {
  it('pairs a normal start/finish and reports nothing unfinished', () => {
    const s = session();
    const l = pairRuns([s], indexEvents([s], [started(s.id, 1), finished(s.id, 5)]));
    expect(l.starts).toHaveLength(1);
    expect(l.unfinished).toHaveLength(0);
  });

  it('reload mid-run: the dead session keeps the open start and reports how long it survived', () => {
    const dead = session({ ended_at: new Date(at(95)).toISOString() });
    const reborn = session();
    const evs = [
      started(dead.id, 5, 'refine', { frames: 2000, width: 200, height: 100 }),
      started(reborn.id, 200),
      finished(reborn.id, 210),
    ];
    const l = pairRuns([dead, reborn], indexEvents([dead, reborn], evs));
    expect(l.unfinished).toHaveLength(1);
    expect(l.unfinished[0]).toMatchObject({
      sessionId: dead.id,
      stage: 'refine',
      survivedS: 90,
      frames: 2000,
      workMpx: 2000 * 0.02,
    });
  });

  it('repeated stages pair sequentially, and a run_failed closes its start too', () => {
    const s = session();
    const evs = [
      started(s.id, 1),
      finished(s.id, 5),
      started(s.id, 10),
      event(s.id, 'run_failed', { stage: 'discover', error_category: 'worker' }, at(12)),
      started(s.id, 20), // never ends
    ];
    const l = pairRuns([s], indexEvents([s], evs));
    expect(l.starts).toHaveLength(3);
    expect(l.unfinished).toHaveLength(1);
    expect(l.unfinished[0].startedAt).toBe(at(20));
  });

  it('a cancelled run followed by a completed retry leaves the cancelled start unfinished', () => {
    const s = session();
    const evs = [started(s.id, 1), started(s.id, 30), finished(s.id, 60)];
    const l = pairRuns([s], indexEvents([s], evs));
    expect(l.unfinished.map((u) => u.startedAt)).toEqual([at(1)]);
  });

  it('stages are matched independently', () => {
    const s = session();
    const evs = [
      started(s.id, 1, 'discover'),
      started(s.id, 2, 'refine'),
      finished(s.id, 9, 'refine'),
    ];
    const l = pairRuns([s], indexEvents([s], evs));
    expect(l.unfinished.map((u) => u.stage)).toEqual(['discover']);
  });

  it('multi-session (joint) runs count once, keep mode and recordings', () => {
    const s = session();
    const evs = [started(s.id, 1, 'discover', { mode: 'joint', sessions: 4 })];
    const u = pairRuns([s], indexEvents([s], evs)).unfinished[0];
    expect(u).toMatchObject({ mode: 'joint', recordings: 4 });
  });

  it('survival is null without a heartbeat or when the heartbeat predates the start', () => {
    const a = session();
    const b = session({ ended_at: new Date(at(0)).toISOString() });
    const l = pairRuns([a, b], indexEvents([a, b], [started(a.id, 5), started(b.id, 5)]));
    expect(l.unfinished.every((u) => u.survivedS === null)).toBe(true);
  });

  it('tolerates events arriving out of order and missing payload fields', () => {
    const s = session();
    const evs = [finished(s.id, 9), event(s.id, 'run_started', { stage: 'discover' }, at(1))];
    expect(pairRuns([s], indexEvents([s], evs)).unfinished).toHaveLength(0);
    const bare = pairRuns([s], indexEvents([s], [event(s.id, 'run_started', {}, at(1))]));
    expect(bare.unfinished[0]).toMatchObject({ stage: 'unknown', frames: null, workMpx: null });
  });

  it('tabulates the rate per stage and version', () => {
    const a = session({ app_version: '2.18.0' });
    const b = session({ app_version: '2.18.0' });
    const evs = [started(a.id, 1), started(b.id, 1), finished(b.id, 5)];
    const rows = unfinishedTable(pairRuns([a, b], indexEvents([a, b], evs)));
    expect(rows).toEqual([
      expect.objectContaining({
        stage: 'discover',
        version: '2.18.0',
        starts: 2,
        unfinished: 1,
        rate: 0.5,
      }),
    ]);
  });
});

describe('funnel, runs, failures', () => {
  it('funnel is monotone and tolerates empty input', () => {
    const a = session();
    const b = session();
    const evs = [
      event(a.id, 'file_imported'),
      event(a.id, 'run_started'),
      event(b.id, 'run_started'),
      event(a.id, 'run_finished'),
    ];
    const f = calaFunnel([a, b], indexEvents([a, b], evs));
    expect(f.map((x) => x.count)).toEqual([2, 1, 1, 1, 0]);
    expect(calaFunnel([], new Map()).map((x) => x.count)).toEqual([0, 0, 0, 0, 0]);
    expect(f[0].ofFirst).toBe(1);
  });

  it('extractRuns turns NaN, null and wrong-typed fields into null, not NaN', () => {
    const s = session();
    const e = event(s.id, 'run_finished', {
      stage: 'discover',
      frames: 'lots',
      median_fps: NaN,
      cells: null,
      width: 10,
      height: 10,
    });
    const [r] = extractRuns([s], indexEvents([s], [e]));
    expect(r.frames).toBeNull();
    expect(r.medianFps).toBeNull();
    expect(r.cells).toBeNull();
    expect(r.megapixels).toBeCloseTo(0.0001);
    expect(r.workMpx).toBeNull();
  });

  it('groups failures by stage, category and type with versions', () => {
    const a = session({ app_version: '2.18.0' });
    const b = session({ app_version: '2.18.1' });
    const f = (sid: string) =>
      event(sid, 'run_failed', {
        stage: 'refine',
        error_category: 'out_of_memory',
        error_type: 'RangeError',
      });
    const rows = failureTable(extractFailures([a, b], indexEvents([a, b], [f(a.id), f(b.id)])));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, versions: '2.18.0, 2.18.1' });
  });

  it('distributions skip missing values', () => {
    const s = session();
    const runs = extractRuns(
      [s],
      indexEvents([s], [finished(s.id, 1), event(s.id, 'run_finished', { stage: 'discover' })]),
    );
    expect(sizeDistributions(runs).frames.reduce((a, b) => a + b.count, 0)).toBe(1);
    expect(sizeDistributions([]).cells).toEqual([]);
  });
});

describe('boundaries and adapters', () => {
  it('shares flagged boundaries among multi-recording runs only', () => {
    const s = session();
    const evs = [
      event(s.id, 'boundary_summary', { boundaries: 3, ok: 3, warning: 0, failed: 0 }),
      event(s.id, 'boundary_summary', { boundaries: 3, ok: 2, warning: 1, failed: 0 }),
      event(s.id, 'boundary_summary', { boundaries: 0 }),
    ];
    const b = boundaryStats([s], indexEvents([s], evs));
    expect(b).toMatchObject({ runs: 2, flagged: 1, flaggedShare: 0.5 });
    expect(boundaryStats([], new Map()).flaggedShare).toBeNull();
  });

  it('separates hardware from software fallback fps', () => {
    const hw = session();
    const sw = session();
    const evs = [
      event(hw.id, 'webgpu_info', { adapter: 'hardware', vendor: 'nvidia' }),
      event(sw.id, 'webgpu_info', { adapter: 'fallback', vendor: 'swiftshader' }),
      finished(hw.id, 5, 'discover', { median_fps: 300 }),
      finished(sw.id, 5, 'discover', { median_fps: 9 }),
    ];
    const ix = indexEvents([hw, sw], evs);
    const runs = extractRuns([hw, sw], ix);
    expect(fpsByAdapterClass(runs).map((r) => [r.cls, r.medianFps])).toEqual([
      ['hardware', 300],
      ['fallback', 9],
    ]);
    expect(adapterTable([hw, sw], ix, runs)).toHaveLength(2);
  });
});

describe('version comparison and regression flags', () => {
  function build(spec: { v: string; ok: number; fail: number; unf: number; fps: number }[]) {
    const sessions = [];
    const evs = [];
    let t = 0;
    for (const { v, ok, fail, unf, fps } of spec) {
      for (let i = 0; i < ok + fail + unf; i++) {
        const s = session({ app_version: v });
        sessions.push(s);
        evs.push(event(s.id, 'webgpu_info', { adapter: 'hardware', vendor: 'x' }));
        evs.push(started(s.id, ++t));
        if (i < ok) evs.push(finished(s.id, ++t, 'discover', { median_fps: fps }));
        else if (i < ok + fail)
          evs.push(
            event(s.id, 'run_failed', { stage: 'discover', error_category: 'unknown' }, at(++t)),
          );
      }
    }
    const ix = indexEvents(sessions, evs);
    return versionComparison(
      sessions,
      extractRuns(sessions, ix),
      extractFailures(sessions, ix),
      pairRuns(sessions, ix),
    );
  }

  it('orders versions numerically and computes rates', () => {
    const rows = build([
      { v: '2.10.0', ok: 5, fail: 0, unf: 0, fps: 100 },
      { v: '2.9.0', ok: 4, fail: 1, unf: 0, fps: 100 },
    ]);
    expect(rows.map((r) => r.version)).toEqual(['2.9.0', '2.10.0']);
    expect(rows[0].failureRate).toBeCloseTo(0.2);
  });

  it('flags an fps drop, a failure jump and an unfinished-rate jump', () => {
    const rows = build([
      { v: '2.17.0', ok: 10, fail: 0, unf: 0, fps: 200 },
      { v: '2.18.0', ok: 5, fail: 3, unf: 6, fps: 80 },
    ]);
    const flags = flagRegressions(rows);
    expect(flags).toHaveLength(1);
    expect(flags[0].version).toBe('2.18.0');
    expect(flags[0].reasons.join(' ')).toMatch(/median fps down/);
    expect(flags[0].reasons.join(' ')).toMatch(/failure rate/);
    expect(flags[0].reasons.join(' ')).toMatch(/unfinished runs/);
  });

  it('does not flag small samples, dev builds or a single version', () => {
    expect(flagRegressions(build([{ v: '2.17.0', ok: 10, fail: 0, unf: 0, fps: 200 }]))).toEqual(
      [],
    );
    const rows = build([
      { v: '2.17.0', ok: 10, fail: 0, unf: 0, fps: 200 },
      { v: '2.18.0', ok: 1, fail: 1, unf: 0, fps: 10 },
    ]);
    expect(flagRegressions(rows)).toEqual([]);
  });
});

describe('testers', () => {
  it('joins tags to the session runs and keeps tag text raw for escaping at render', () => {
    const a = session({ app_version: '2.18.0' });
    const b = session({ app_version: '2.18.1' });
    const evs = [
      event(a.id, 'tester_tag', { tag: '<b>x</b>' }),
      event(b.id, 'tester_tag', { tag: '<b>x</b>' }),
      finished(a.id, 3, 'discover', { median_fps: 120 }),
      event(b.id, 'run_failed', { stage: 'discover', error_category: 'webgpu' }),
    ];
    const rows = testerTable([a, b], indexEvents([a, b], evs));
    expect(rows).toEqual([
      expect.objectContaining({
        tag: '<b>x</b>',
        sessions: 2,
        runs: 1,
        failures: 1,
        medianFps: 120,
        versions: '2.18.0, 2.18.1',
      }),
    ]);
  });

  it('buildCala ignores non-Cala sessions', () => {
    const t = session({ app_name: 'catune' });
    expect(buildCala([t], [event(t.id, 'run_finished', { stage: 'discover' })]).runs).toEqual([]);
  });
});

describe('sessions processed per run', () => {
  const run = (sid: string, s: number, stage: string, extra = {}) => finished(sid, s, stage, extra);

  it('counts a Joint run once over all its sessions, a Separate plan once per session, old events too', () => {
    const s = session();
    const evs = [
      // New events: sessions = this run's, plan_sessions = the plan's.
      run(s.id, 1, 'discover', { mode: 'joint', sessions: 4, plan_sessions: 4, refine_runs: 1 }),
      run(s.id, 2, 'discover', { mode: 'separate', sessions: 1, plan_sessions: 4, refine_runs: 0 }),
      run(s.id, 3, 'discover', { mode: 'separate', sessions: 1, plan_sessions: 4, refine_runs: 0 }),
      // Old events: sessions was the plan's size in every mode.
      run(s.id, 4, 'extract', { mode: 'separate', sessions: 4 }),
      run(s.id, 5, 'extract', { mode: 'separate', sessions: 4 }),
      run(s.id, 6, 'extract', { mode: 'joint', sessions: 16 }),
      run(s.id, 7, 'extract', { mode: 'single', sessions: 1 }),
    ];
    const runs = extractRuns([s], indexEvents([s], evs));
    expect(runs.map((r) => r.sessions)).toEqual([4, 1, 1, 1, 1, 16, 1]);
    expect(runs[0]).toMatchObject({ planSessions: 4, refineRuns: 1 });
    expect(runs[3]).toMatchObject({ planSessions: null, refineRuns: null });
    const rows = stageModeTable(runs);
    const row = (stage: string, mode: string) =>
      rows.find((r) => r.stage === stage && r.mode === mode)!;
    expect(row('discover', 'joint')).toMatchObject({ runs: 1, sessions: 4 });
    expect(row('discover', 'separate')).toMatchObject({ runs: 2, sessions: 2 });
    expect(row('extract', 'separate')).toMatchObject({ runs: 2, sessions: 2 });
    expect(row('extract', 'joint')).toMatchObject({ runs: 1, sessions: 16 });
    expect(row('extract', 'single')).toMatchObject({ runs: 1, sessions: 1 });
    // Order: stage, then Joint, Separate, single.
    expect(rows.map((r) => `${r.stage}/${r.mode}`)).toEqual([
      'discover/joint',
      'discover/separate',
      'extract/joint',
      'extract/separate',
      'extract/single',
    ]);
  });
});
