import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRunRecord,
  achievedFps,
  browserInfo,
  gatherRunRecord,
  KNOWN_FLAGS,
  machineContext,
  resetRunRecordContext,
  RunTrace,
  settingsFromRecord,
  urlFlags,
  WORK_SLIDER_SLOTS,
  type RunRecordInput,
  type RunRecordSources,
} from '../lib/run-provenance.ts';
import type { StageRun } from '../lib/run-stages.ts';

/** A loosely typed JSON document, for reading the record in assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

const stage: StageRun = {
  stage: 'discover',
  index: 1,
  startedAt: '2026-11-22T10:00:00.000Z',
  endedAt: '2026-11-22T10:05:00.000Z',
  outcome: 'done',
  frames: 6000,
  cells: 40,
  libraryVersion: 9,
  lookback: true,
};

function input(over: Partial<RunRecordInput> = {}): RunRecordInput {
  return {
    createdAt: '2026-11-22T10:10:00.000Z',
    appVersion: '2.20.0',
    commit: 'abc123',
    gitDirty: false,
    engineVersion: '0.1.0',
    search:
      '?debug&lookback&csettle=yield4&csrate=1&pacefps=30&lbpool=2&needfirst&smooth=0&live=ws://10.0.0.5:9000&x=1',
    settings: { lookback: true, flat_field: true },
    input: {
      label: 'rec',
      live: false,
      frames: 6000,
      fps: 30,
      width: 10,
      height: 8,
      bitDepth: 8,
      files: [{ position: 0, name: '0.avi', frames: 6000, size: 1234 }],
      sessions: [],
      mode: null,
      session_index: null,
      fps_source: 'metadata',
    },
    runtime: {
      motion_backend: 'webgpu',
      flat_field: { enabled: true, reused_from_cache: false, key_source: 'folder' },
    },
    stages: [stage],
    settle: { fed: 900, planned: 1800, recording: 6000, stopped_by_user: true, done: true },
    settleTimes: { started_at: 'a', ended_at: 'b' },
    targetSpeed: [{ at: 't0', frame: 0, fps: 30, source: 'run start' }],
    work: { cap: 1, pool: 3, visit_workers: 4 },
    governor: null,
    achievedFps: 29.5,
    machine: machineContext(),
    ...over,
  };
}

describe('urlFlags', () => {
  it('records known flags, their effect, and only the names of others', () => {
    const f = urlFlags(input().search);
    expect(f.debug).toBe(true);
    expect(f.flags.csettle).toEqual({ value: 'yield4', in_effect: true });
    expect(f.flags.pacefps).toEqual({ value: '30', in_effect: true });
    expect(f.flags.lbpool.value).toBe('2');
    expect(f.flags.needfirst).toEqual({ value: '', in_effect: true });
    expect(f.flags.live).toEqual({ value: '(redacted)', in_effect: true });
    expect(f.other_flags).toEqual(['x']);
    expect(JSON.stringify(f)).not.toContain('10.0.0.5');
  });

  it('marks debug-only flags as not in effect without ?debug', () => {
    const f = urlFlags('?pacefps=30&lookback');
    expect(f.debug).toBe(false);
    expect(f.flags.pacefps.in_effect).toBe(false);
    expect(f.flags.lookback.in_effect).toBe(true);
  });
});

describe('buildRunRecord', () => {
  it('has the versioned layout with every block', () => {
    const r = buildRunRecord(input()) as Rec;
    expect(r.format).toBe('cala-run-record');
    expect(r.record_version).toBe(2);
    expect(r.software).toMatchObject({
      app: 'cala',
      app_version: '2.20.0',
      git_commit: 'abc123',
      engine_version: '0.1.0',
    });
    expect(r.settings).toEqual({ lookback: true, flat_field: true });
    expect(r.input.files).toEqual([{ position: 0, name: '0.avi', frames: 6000, size: 1234 }]);
    expect(r.software.git_dirty).toBe(false);
    expect(r.runtime.motion_backend).toBe('webgpu');
    expect(r.stages[0]).toMatchObject({
      stage: 'discover',
      started_at: stage.startedAt,
      ended_at: stage.endedAt,
    });
    expect(r.final_settle).toEqual({
      frames_fed: 900,
      frames_planned: 1800,
      recording_frames: 6000,
      stopped_early_by_user: true,
      done: true,
      started_at: 'a',
      ended_at: 'b',
    });
    expect(r.target_speed.changes).toEqual([{ at: 't0', frame: 0, fps: 30, source: 'run start' }]);
    expect(r.work).toMatchObject({ cap: 1, pool: 3, achieved_fps: 29.5, governor: null });
    expect(r.machine).toHaveProperty('hardware_concurrency');
  });

  it('always has the named slots for later PRs, null until filled', () => {
    const r = buildRunRecord(input()) as Rec;
    expect(Object.keys(r.slots)).toEqual([...WORK_SLIDER_SLOTS]);
    for (const k of WORK_SLIDER_SLOTS) expect(r.slots[k]).toBeNull();
    const filled = buildRunRecord(input({ slots: { floor_estimate: { fps: 41 } } })) as Rec;
    expect(filled.slots.floor_estimate).toEqual({ fps: 41 });
    expect(filled.slots.curve_schedule).toBeNull();
  });

  it('says plainly when no settle ran, and carries the governor summary', () => {
    const r = buildRunRecord(
      input({
        settle: null,
        settleTimes: { started_at: null, ended_at: null },
        governor: {
          rate: 32,
          limit: 'cap',
          target: 30,
          paused: false,
          achieved: 30,
          capFps: 30,
          cap: 1,
          deliveredFps: 31,
          busy: 0.5,
          credit: 0,
          halvings: 2,
          slowHalvings: 1,
        } as never,
      }),
    ) as Rec;
    expect(r.final_settle.frames_fed).toBeNull();
    expect(r.final_settle.done).toBe(false);
    expect(r.work.governor).toMatchObject({ rate_fps: 32, halvings: 2, cap: 1 });
  });

  it('survives a JSON round trip and holds no address', () => {
    const r = buildRunRecord(input());
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(JSON.stringify(r)).not.toMatch(/\d+\.\d+\.\d+\.\d+:\d+/);
  });
});

describe('RunTrace', () => {
  it('time-stamps target speed changes, skipping repeats', () => {
    let n = 0;
    const t = new RunTrace(() => new Date(Date.UTC(2026, 10, 22, 10, 0, n++)));
    t.noteTargetSpeed(30, 0, 'run start');
    t.noteTargetSpeed(30, 5, 'setting');
    t.noteTargetSpeed(0, 100, 'setting');
    expect(t.targetSpeedChanges().map((c) => [c.fps, c.frame, c.source])).toEqual([
      [30, 0, 'run start'],
      [0, 100, 'setting'],
    ]);
    expect(t.targetSpeedChanges()[0].at).toBe('2026-11-22T10:00:00.000Z');
    t.reset();
    expect(t.targetSpeedChanges()).toEqual([]);
  });

  it('stamps the settle start once and its end once', () => {
    let n = 0;
    const t = new RunTrace(() => new Date(Date.UTC(2026, 10, 22, 10, 0, n++)));
    t.noteSettle({ running: true, done: false });
    t.noteSettle({ running: true, done: false });
    t.noteSettle({ running: false, done: true });
    t.noteSettle({ running: false, done: true });
    expect(t.settleTimes()).toEqual({
      started_at: '2026-11-22T10:00:00.000Z',
      ended_at: '2026-11-22T10:00:01.000Z',
    });
  });
});

describe('gatherRunRecord', () => {
  beforeEach(() => resetRunRecordContext());

  const sources = (): RunRecordSources => ({
    appVersion: 'dev',
    commit: null,
    gitDirty: true,
    engineVersion: '0.1.0',
    search: '?lookback',
    trace: new RunTrace(),
    pipeline: {
      flatEnabled: () => true,
      discover: () => true,
      residual: () => false,
      lookback: () => true,
      csettle: () => false,
      csettleCeiling: () => 2,
      csettleYield: () => 0,
      csettleNeedFirst: () => false,
      finalSettleLevel: () => 'standard',
      paceFps: () => 0,
      smoothPlayback: () => true,
      motionBackend: () => 'wasm-off',
      flatField: () => ({ reused: true, keySource: 'device' }),
    },
    slowStatus: () => ({
      lookback: {
        settle: { fed: 10, total: 20, recording: 100, stopped: false, done: false },
        settling: true,
      },
    }),
    stageRuns: () => [stage],
    info: () => ({
      frameCount: 100,
      fps: 20,
      width: 4,
      height: 4,
      bitDepth: 8,
      files: [{ name: 'a.avi', frames: 100 }],
      sessions: [{ index: 0, name: 's0', startFrame: 0, frameCount: 100, fps: 20 }],
    }),
    label: () => 'rec',
    fileSizes: () => new Map([['a.avi', 99]]),
    sessionFiles: () => [],
    lookbackPoolSize: () => 1,
    visitWorkers: () => 3,
  });

  it('records every setting (defaults too), the input and the work shape', () => {
    const r = gatherRunRecord(sources(), {
      mode: 'joint',
      refineRuns: 2,
      passQcOnly: true,
    }) as Rec;
    expect(r.settings).toMatchObject({
      flat_field: true,
      residual_preview: false,
      background_settle: 'off',
      settle_cap: 'off',
      need_first: false,
      lookback_pool: { planned_S: 1, started_S: 0, started_at_frame: null },
      final_settle_level: 'standard',
      target_speed_fps: 0,
      library_mode: 'joint',
      refine_runs: 2,
      export_pass_qc_only: true,
    });
    expect(r.input.files).toEqual([]);
    expect(r.input.sessions[0]).toMatchObject({ name: 's0', frames: 100, files: [] });
    expect(r.final_settle).toMatchObject({ frames_fed: 10, stopped_early_by_user: false });
    expect(r.work).toMatchObject({ cap: 0, pool: 1, visit_workers: 3, achieved_fps: 6000 / 300 });
    expect(r.work).not.toHaveProperty('governor_on');
    expect(r.settings).not.toHaveProperty('settle_during_discover');
    expect(r.software.git_commit).toBeNull();
  });

  it('records Background settle, its cap and the pool actually started', () => {
    const src = sources();
    src.pipeline.csettle = () => true;
    src.pipeline.csettleCeiling = () => 0.5;
    src.pipeline.csettleNeedFirst = () => true;
    // At Max all run: the pool never started.
    let r = gatherRunRecord(src) as Rec;
    expect(r.settings).toMatchObject({
      background_settle: 'auto-below-max',
      settle_cap: 0.5,
      need_first: true,
      lookback_pool: { planned_S: 1, started_S: 0, started_at_frame: null },
    });
    expect(r.work).toMatchObject({ cap: 0.5, pool: 1 });
    // Paced from frame 640: the first start counts.
    src.trace.notePoolStart(1, 640);
    src.trace.notePoolStart(1, 900);
    r = gatherRunRecord(src) as Rec;
    expect(r.settings.lookback_pool).toEqual({ planned_S: 1, started_S: 1, started_at_frame: 640 });
    expect(r.work).toMatchObject({ pool: 2 });
    // A new run starts with no pool.
    src.trace.reset();
    expect((gatherRunRecord(src) as Rec).settings.lookback_pool.started_S).toBe(0);
  });

  it('records the backend that ran, the flat-field source, fps source and git state', () => {
    const r = gatherRunRecord(sources()) as Rec;
    expect(r.runtime).toEqual({
      motion_backend: 'wasm-off',
      flat_field: { enabled: true, reused_from_cache: true, key_source: 'device' },
    });
    expect(r.software).toMatchObject({ git_dirty: true, engine_version: '0.1.0' });
  });

  it('keeps the files of each session apart when every session names them 0.avi', () => {
    const src = sources();
    src.info = () => ({
      frameCount: 200,
      fps: 20,
      width: 4,
      height: 4,
      bitDepth: 8,
      files: [
        { name: '0.avi', frames: 100 },
        { name: '0.avi', frames: 100 },
      ],
      sessions: [
        { index: 0, name: 's0', startFrame: 0, frameCount: 100, fps: 20 },
        { index: 1, name: 's1', startFrame: 100, frameCount: 100, fps: 20 },
      ],
    });
    src.sessionFiles = () => [
      [{ name: '0.avi', size: 111 }],
      [
        { name: '0.avi', size: 222 },
        { name: '1.avi', size: 333 },
      ],
    ];
    const r = gatherRunRecord(src, { mode: 'joint' }) as Rec;
    expect(r.input.sessions[0].files).toEqual([{ position: 0, name: '0.avi', size: 111 }]);
    expect(r.input.sessions[1].files).toEqual([
      { position: 0, name: '0.avi', size: 222 },
      { position: 1, name: '1.avi', size: 333 },
    ]);
  });

  it('never carries a live stream address, even unnamed', () => {
    const src = sources();
    src.search = '?live=ws://10.0.0.5:5555';
    src.label = () => '(live stream)';
    src.info = () => ({
      frameCount: Infinity,
      fps: 30,
      width: 4,
      height: 4,
      bitDepth: 8,
      live: { url: 'ws://10.0.0.5:5555' },
      files: [],
    });
    const text = JSON.stringify(gatherRunRecord(src));
    expect(text).not.toContain('10.0.0.5');
    expect(JSON.parse(text).input).toMatchObject({ live: true, label: '(live stream)' });
  });

  it('computes achieved fps from the Discover run wall time', () => {
    expect(achievedFps([stage])).toBeCloseTo(6000 / 300);
    expect(achievedFps([{ ...stage, endedAt: null }])).toBeNull();
    expect(achievedFps([])).toBeNull();
  });
});

describe('browserInfo', () => {
  it('uses brands and platform, else a coarse name and major version only', () => {
    expect(
      browserInfo({
        userAgent: 'x',
        userAgentData: { platform: 'macOS', brands: [{ brand: 'Chromium', version: '142' }] },
      }),
    ).toEqual({ brands: [{ brand: 'Chromium', version: '142' }], platform: 'macOS' });
    const fallback = browserInfo({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36',
      platform: 'MacIntel',
    });
    expect(fallback).toEqual({
      brands: [{ brand: 'Chrome', version: '142' }],
      platform: 'MacIntel',
    });
    expect(JSON.stringify(fallback)).not.toContain('7444');
  });
});

describe('url flags against the app', () => {
  it('every flag App.tsx reads is a known flag', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../App.tsx'), 'utf8');
    const names = new Set([...src.matchAll(/params\.(?:get|has)\('(\w+)'\)/g)].map((m) => m[1]));
    expect(names.size).toBeGreaterThan(10);
    const known = new Set<string>(KNOWN_FLAGS);
    expect([...names].filter((n) => !known.has(n))).toEqual([]);
  });

  it('marks inert combinations', () => {
    expect(urlFlags('?csettle&csrate=1').flags.csettle.in_effect).toBe(false);
    expect(urlFlags('?csettle&csrate=1').flags.csrate.in_effect).toBe(false);
    // Background settle is on by default under look-back: a bare `csettle` changes nothing,
    // `csettle=0` (off) and `csettle=yieldN` do.
    expect(urlFlags('?lookback&csettle&csrate=1').flags.csettle.in_effect).toBe(false);
    expect(urlFlags('?lookback&csettle=0').flags.csettle.in_effect).toBe(true);
    expect(urlFlags('?lookback&csettle=yield2').flags.csettle.in_effect).toBe(true);
    expect(urlFlags('?needfirst').flags.needfirst.in_effect).toBe(false);
    expect(urlFlags('?debug&needfirst').flags.needfirst.in_effect).toBe(true);
    expect(urlFlags('?lookback=0&csettle').flags.lookback.in_effect).toBe(false);
    expect(urlFlags('?review=4').flags.review.in_effect).toBe(false);
    expect(urlFlags('?compress&review=4').flags.review.in_effect).toBe(true);
  });
});

describe('settingsFromRecord', () => {
  it('maps a record back to settings and rejects anything else', () => {
    const rec = buildRunRecord(
      input({
        settings: {
          flat_field: false,
          lookback: true,
          background_settle: 'auto-below-max',
          settle_cap: 0.5,
          need_first: true,
          lookback_pool: { planned_S: 1, started_S: 1, started_at_frame: 300 },
          final_settle_level: 'quick',
          target_speed_fps: 30,
          smooth_playback: false,
        },
      }),
    );
    expect(settingsFromRecord(JSON.parse(JSON.stringify(rec)))).toEqual({
      finalSettleLevel: 'quick',
      flatField: false,
      lookback: true,
      csettle: true,
      csettleCeiling: 0.5,
      csettleNeedFirst: true,
      lookbackPoolPlanned: 1,
      paceFps: 30,
      smoothPlayback: false,
    });
    // A record from a build with another level name restores nothing for it.
    const odd = buildRunRecord(input({ settings: { final_settle_level: 'turbo' } }));
    expect(settingsFromRecord(JSON.parse(JSON.stringify(odd)))).toEqual({});
    expect(settingsFromRecord(null)).toBeNull();
    expect(settingsFromRecord({ format: 'other' })).toBeNull();
    expect(settingsFromRecord({ ...rec, record_version: 99 })).toBeNull();
  });

  it('maps the cap Off of a v2 record', () => {
    const rec = buildRunRecord(
      input({ settings: { lookback: true, background_settle: 'off', settle_cap: 'off' } }),
    );
    expect(settingsFromRecord(rec)).toEqual({ lookback: true, csettle: false });
  });

  it('still reads v1 records: settle during Discover false is the cap Off, true the default', () => {
    const v1 = (settings: Record<string, unknown>) => ({
      format: 'cala-run-record',
      record_version: 1,
      settings: { lookback: true, settle_yield_frames: 0, target_speed_fps: 60, ...settings },
    });
    expect(
      settingsFromRecord(
        v1({
          settle_during_discover: false,
          settle_ceiling_per_live_frame: 2,
          settle_governor: true,
        }),
      ),
    ).toEqual({ lookback: true, csettle: false, csettleCeiling: 2, csettleYield: 0, paceFps: 60 });
    expect(
      settingsFromRecord(
        v1({
          settle_during_discover: true,
          settle_ceiling_per_live_frame: 1,
          settle_governor: false,
        }),
      ),
    ).toEqual({ lookback: true, csettle: true, csettleCeiling: 1, csettleYield: 0, paceFps: 60 });
    expect(settingsFromRecord({ ...v1({}), record_version: 0 })).toBeNull();
  });
});
