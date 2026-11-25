import { VISIT_RATE, VisitRateGovernor } from '../lib/visit-rate.ts';
import type { AutoDecision } from '../lib/speed-auto.ts';
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
  curveFromChanges,
  RunTrace,
  settingsFromRecord,
  sliderSchedule,
  speedModeOf,
  thinOldest,
  type WorkSample,
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
    capChanges: [{ at: 't0', frame: 0, cap: 2, source: 'run start' }],
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
    const f = urlFlags('?pacefps=30&lookback=0');
    expect(f.debug).toBe(false);
    expect(f.flags.pacefps.in_effect).toBe(false);
    // Look-back is on by default: only `lookback=0` (off) changes anything.
    expect(f.flags.lookback.in_effect).toBe(true);
    expect(urlFlags('?lookback').flags.lookback.in_effect).toBe(false);
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
    expect(r.work.cap_changes).toEqual([{ at: 't0', frame: 0, cap: 2, source: 'run start' }]);
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

  it('time-stamps settle cap changes, skipping repeats, and clears them on reset', () => {
    let n = 0;
    const t = new RunTrace(() => new Date(Date.UTC(2026, 10, 22, 10, 0, n++)));
    t.noteCap(2, 0, 'run start');
    t.noteCap(2, 5, 'setting');
    t.noteCap(0, 900, 'setting');
    expect(t.capChanges().map((c) => [c.cap, c.frame, c.source])).toEqual([
      [2, 0, 'run start'],
      [0, 900, 'setting'],
    ]);
    expect(t.capChanges()[1].at).toBe('2026-11-22T10:00:01.000Z');
    t.reset();
    expect(t.capChanges()).toEqual([]);
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

const gatherSources = (): RunRecordSources => ({
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

describe('gatherRunRecord', () => {
  beforeEach(() => resetRunRecordContext());
  const sources = gatherSources;

  it('records whether look-back actually ran, not only the setting', () => {
    const blocked = {
      ...gatherSources(),
      pipeline: { ...gatherSources().pipeline, lookback: () => true, lookbackRun: () => false },
    };
    const r = gatherRunRecord(blocked as never) as Rec;
    expect(r.settings).toMatchObject({ lookback: true, lookback_ran: false });
    const ran = gatherRunRecord({
      ...gatherSources(),
      pipeline: { ...gatherSources().pipeline, lookbackRun: () => true },
    } as never) as Rec;
    expect(ran.settings).toMatchObject({ lookback: true, lookback_ran: true });
  });

  it('records every setting (defaults too), the input and the work shape', () => {
    const r = gatherRunRecord(sources(), {
      mode: 'joint',
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
    // Look-back is on by default, so the settle flags apply without `?lookback`.
    expect(urlFlags('?csettle&csrate=1').flags.csettle.in_effect).toBe(false);
    expect(urlFlags('?csettle&csrate=1').flags.csrate.in_effect).toBe(true);
    // ... and are inert once it is turned off.
    expect(urlFlags('?lookback=0&csettle=0&csrate=1').flags.csettle.in_effect).toBe(false);
    expect(urlFlags('?lookback=0&csrate=1').flags.csrate.in_effect).toBe(false);
    // Background settle is on by default under look-back: a bare `csettle` changes nothing,
    // `csettle=0` (off) and `csettle=yieldN` do.
    expect(urlFlags('?lookback&csettle&csrate=1').flags.csettle.in_effect).toBe(false);
    expect(urlFlags('?lookback&csettle=0').flags.csettle.in_effect).toBe(true);
    expect(urlFlags('?lookback&csettle=yield2').flags.csettle.in_effect).toBe(true);
    expect(urlFlags('?needfirst').flags.needfirst.in_effect).toBe(false);
    expect(urlFlags('?debug&needfirst').flags.needfirst.in_effect).toBe(true);
    expect(urlFlags('?lookback=0&csettle').flags.lookback.in_effect).toBe(true);
    expect(urlFlags('?review=4').flags.review.in_effect).toBe(false);
    expect(urlFlags('?compress&review=4').flags.review.in_effect).toBe(true);
    expect(urlFlags('?compress&review&factors').flags.review.in_effect).toBe(false);
    expect(urlFlags('?compress&review&factors=0').flags.review.in_effect).toBe(true);
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

  it('flags a record that ran Refine (a removed stage) without failing', () => {
    const base = buildRunRecord(input({ settings: { lookback: false, refine_runs: 2 } }));
    const rec = JSON.parse(JSON.stringify(base));
    const a = settingsFromRecord(rec)!;
    expect(a.refineUsed).toBe(true);
    // Look-back was off in that run, but is kept on: it replaces Refine.
    expect(a.lookback).toBe(true);
    // Also when only the stage list says so (a record with `refine_runs: 0` and a Refine run).
    const viaStages = settingsFromRecord({
      ...rec,
      settings: { ...rec.settings, refine_runs: 0 },
      stages: [{ stage: 'discover' }, { stage: 'refine' }],
    })!;
    expect(viaStages.refineUsed).toBe(true);
    // A record of a run without Refine says nothing.
    const clean = settingsFromRecord({
      ...rec,
      settings: { ...rec.settings, refine_runs: 0 },
      stages: [{ stage: 'discover' }, { stage: 'extract' }],
    })!;
    expect(clean.refineUsed).toBeUndefined();
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

const sample = (over: Partial<WorkSample> = {}): WorkSample => ({
  frame: 100,
  limit: 'cap',
  maxFps: 200,
  floor: {
    fps: 30,
    published: null,
    seeAllFps: 62,
    limiting: 'look-back',
    confidence: 'prior',
    terms: { lookbackNeed: 40, lookbackSettle: null, slowWorker: 70, visits: null },
  },
  floorInputs: null,
  floorChanged: false,
  running: true,
  counters: {
    processed: 1000,
    observed: 950,
    settledFrames: 1500,
    forwardDrops: 7,
    paceLateMs: 120,
    paceReanchors: 4,
    halvings: 3,
    slowHalvings: 1,
  },
  ...over,
});

describe('speed record fields', () => {
  it('keeps the floor over a run: the start value, each published change, the last inputs', () => {
    const t = new RunTrace(() => new Date('2026-11-22T10:00:00.000Z'));
    expect(t.floorEstimate()).toBeNull();
    t.noteSample(sample());
    const inputs = { cap: 2 } as unknown as WorkSample['floorInputs'];
    t.noteSample(
      sample({
        frame: 900,
        floorChanged: true,
        floorInputs: inputs,
        floor: { ...sample().floor, fps: 40, published: 40, confidence: 'paced' },
      }),
    );
    // Not a change: no row, but the inputs move on.
    t.noteSample(
      sample({ frame: 1200, floorInputs: { cap: 1 } as unknown as WorkSample['floorInputs'] }),
    );
    const f = t.floorEstimate()!;
    expect(f.start).toEqual({ fps: 30, confidence: 'prior' });
    expect(f.changes).toHaveLength(1);
    expect(f.changes[0]).toMatchObject({
      frame: 900,
      fps: 40,
      seeAllFps: 62,
      limiting: 'look-back',
      confidence: 'paced',
      at: '2026-11-22T10:00:00.000Z',
    });
    expect(f.last_inputs).toEqual({ cap: 1 });
    t.reset();
    expect(t.floorEstimate()).toBeNull();
  });

  it('counts the governor limits as shares and takes the median Max estimate', () => {
    const t = new RunTrace();
    for (const [limit, max] of [
      ['cap', 100],
      ['cap', 300],
      ['look-back', 200],
      [null, null],
    ] as const)
      t.noteSample(sample({ limit, maxFps: max }));
    expect(t.limitShares()).toEqual({ cap: 2 / 3, 'look-back': 1 / 3 });
    expect(t.maxFpsMedian()).toBe(200);
    t.noteSample(sample({ maxFps: 400 }));
    expect(t.maxFpsMedian()).toBe(250);
    expect(new RunTrace().limitShares()).toEqual({});
    expect(new RunTrace().maxFpsMedian()).toBeNull();
    // Without a separate fast-loop reading the fast median is the same as Max's.
    expect(t.fastMaxFpsMedian()).toBe(250);
    expect(new RunTrace().fastMaxFpsMedian()).toBeNull();
  });

  it('keeps the held Max and the fast loop top speed apart while the visits hold the run', () => {
    const t = new RunTrace();
    for (const [held, fast] of [
      [120, 290],
      [125, 300],
      [130, 310],
    ] as const)
      t.noteSample(sample({ maxFps: held, fastMaxFps: fast }));
    expect(t.maxFpsMedian()).toBe(125);
    expect(t.fastMaxFpsMedian()).toBe(300);
  });

  it('keeps the counts of Discover for later: the last reading wins, and the limit counts stop at its end', () => {
    const t = new RunTrace();
    expect(t.counters()).toBeNull();
    t.noteSample(sample());
    t.noteSample(sample({ counters: { ...sample().counters, processed: 2000 } }));
    // Discover over, the Final settle going: counts still move, limit and Max shares do not.
    t.noteSample(
      sample({
        running: false,
        limit: 'idle',
        maxFps: 999,
        counters: { ...sample().counters, processed: 2400 },
      }),
    );
    expect(t.counters()?.processed).toBe(2400);
    expect(t.limitShares()).toEqual({ cap: 1 });
    expect(t.maxFpsMedian()).toBe(200);
    t.reset();
    expect(t.counters()).toBeNull();
  });

  it('bounds its lists: past the cap the oldest half is thinned, the newest kept whole', () => {
    const rows = Array.from({ length: 11 }, (_, i) => i);
    // 11 rows over a cap of 10: the oldest 5 are halved (1 and 3 kept), the newest 6 stay.
    expect(thinOldest(rows, 10)).toEqual([1, 3, 5, 6, 7, 8, 9, 10]);
    expect(thinOldest([1, 2, 3], 10)).toEqual([1, 2, 3]);
    const t = new RunTrace();
    for (let i = 0; i < 2500; i++)
      t.noteSample(
        sample({ frame: i, floorChanged: true, floor: { ...sample().floor, published: 30 + i } }),
      );
    const f = t.floorEstimate()!;
    expect(f.changes.length).toBeLessThanOrEqual(2000);
    expect(f.changes[f.changes.length - 1].frame).toBe(2499);
  });

  it('names the mode: stream, auto, curve, fixed or max', () => {
    const at = (fps: number, source = 'run start') => [{ at: 't', frame: 0, fps, source }];
    expect(speedModeOf({ live: true, targetSpeed: at(30), curve: false })).toBe('stream');
    expect(speedModeOf({ live: false, targetSpeed: at(0), curve: false })).toBe('max');
    expect(speedModeOf({ live: false, targetSpeed: at(60), curve: false })).toBe('fixed');
    expect(speedModeOf({ live: false, targetSpeed: at(0), curve: true })).toBe('curve');
    expect(speedModeOf({ live: false, targetSpeed: at(60, 'auto'), curve: true })).toBe('auto');
    expect(speedModeOf({ live: false, targetSpeed: [], curve: false })).toBe('max');
  });

  it('fills speed_mode, work.realised and the slots when it gathers', () => {
    const trace = new RunTrace();
    trace.noteTargetSpeed(60, 0, 'run start');
    trace.noteSample(sample({ floorChanged: true, floor: { ...sample().floor, published: 40 } }));
    const gov = {
      rate: 100,
      limit: 'cap',
      target: 60,
      paused: false,
      achieved: 58,
      capFps: 116,
      cap: 2,
      deliveredFps: 100,
      busy: 0.5,
      credit: 0,
      halvings: 3,
      slowHalvings: 1,
    };
    const src: RunRecordSources = {
      ...gatherSources(),
      trace,
      pipeline: {
        ...gatherSources().pipeline,
        paceFps: () => 60,
      },
      slowStatus: () => ({
        lookback: { csettle: { governor: gov as never } },
      }),
    };
    const r = gatherRunRecord(src) as Rec;
    expect(r.settings.speed_mode).toBe('fixed');
    expect(r.work.realised).toMatchObject({
      achieved_fps_mean: 20,
      dose_per_live_frame: 1.5,
      frames_missed_by_slow_loop: 50,
      forward_drops: 7,
      halvings: 3,
      slow_halvings: 1,
      limit_shares: { cap: 1 },
      pace_late_ms: 120,
      pace_reanchors: 4,
      max_fps_median: 200,
      fast_max_fps_median: 200,
    });
    expect(r.slots.slider_schedule).toEqual(sliderSchedule());
    expect(r.slots.slider_schedule.scale).toEqual([10, 500]);
    expect(r.slots.floor_estimate.changes[0].fps).toBe(40);
    expect(r.slots.curve_schedule).toBeNull();
    expect(r.slots.auto_decisions).toBeNull();
    // A source with none of the new readouts still gathers; the fields are null.
    const old = gatherRunRecord(gatherSources()) as Rec;
    expect(old.work.realised.forward_drops).toBeNull();
    expect(old.work.realised.halvings).toBeNull();
    expect(old.work.realised.dose_per_live_frame).toBeNull();
    expect(old.slots.floor_estimate).toBeNull();
  });
});

describe('the curve in the record', () => {
  it('goes in curve_schedule and makes the mode curve, as set and as run', () => {
    const trace = new RunTrace();
    trace.noteTargetSpeed(0, 0, 'run start');
    trace.noteTargetSpeed(60, 6000, 'curve');
    trace.noteCurve({
      preset: 'find-fast',
      points: [
        { at: 0, fps: 'max' },
        { at: 0.5, fps: 'floor' },
      ],
      effective_points: [{ at: 0, fps: 'max' }],
      armed_at_frame: 0,
    });
    const r = gatherRunRecord(
      { ...gatherSources(), trace },
      { slots: { auto_decisions: null } },
    ) as Rec;
    expect(r.settings.speed_mode).toBe('curve');
    expect(r.slots.curve_schedule).toEqual({
      preset: 'find-fast',
      points: [
        { at: 0, fps: 'max' },
        { at: 0.5, fps: 'floor' },
      ],
      effective_points: [{ at: 0, fps: 'max' }],
      armed_at_frame: 0,
    });
    expect(r.target_speed.changes[1].source).toBe('curve');
    trace.reset();
    expect(trace.curve()).toBeNull();
    expect((gatherRunRecord({ ...gatherSources(), trace }) as Rec).slots.curve_schedule).toBeNull();
  });
});

describe('Auto in the record', () => {
  it('fills auto_decisions and auto_extra_time_share, and the mode is auto', () => {
    const trace = new RunTrace();
    trace.noteTargetSpeed(0, 0, 'run start');
    trace.noteTargetSpeed(100, 0, 'auto');
    const decisions: AutoDecision[] = [
      { frame: 0, fps: 100, reason: 'budget', max_fps: 200, left_s: 120 },
    ];
    const src = gatherSources();
    trace.noteAuto({ extraTimeShare: 1, decisions });
    const r = gatherRunRecord({ ...src, trace }) as Rec;
    expect(r.settings.speed_mode).toBe('auto');
    expect(r.slots.auto_decisions).toEqual(decisions);
    expect(r.slots.auto_extra_time_share).toBe(1);
    // Auto that held Max all run still names the mode (no change with source auto).
    const quiet = new RunTrace();
    quiet.noteTargetSpeed(0, 0, 'run start');
    quiet.noteAuto({ extraTimeShare: 2, decisions: [] });
    const q = gatherRunRecord({ ...src, trace: quiet }) as Rec;
    expect(q.settings.speed_mode).toBe('auto');
    expect(q.slots.auto_extra_time_share).toBe(2);
    quiet.reset();
    expect(quiet.auto()).toBeNull();
    const none = gatherRunRecord({ ...src, trace: new RunTrace() }) as Rec;
    expect(none.slots.auto_decisions).toBeNull();
    expect(none.slots.auto_extra_time_share).toBeNull();
  });

  it('replays the targets Auto realised as a curve', () => {
    const rec = JSON.parse(
      JSON.stringify(
        buildRunRecord(
          input({
            settings: { speed_mode: 'auto', target_speed_fps: 0 },
            targetSpeed: [
              { at: 't0', frame: 0, fps: 0, source: 'run start' },
              { at: 't1', frame: 0, fps: 100, source: 'auto' },
              { at: 't2', frame: 3000, fps: 120, source: 'auto' },
              { at: 't3', frame: 9000, fps: 0, source: 'auto' },
            ],
          }),
        ),
      ),
    );
    rec.input.frames = 12000;
    const a = settingsFromRecord(rec);
    expect(a?.speedMode).toBe('auto');
    expect(a?.curve).toEqual({
      points: [
        { at: 0, fps: 100 },
        { at: 0.25, fps: 120 },
        { at: 0.75, fps: 'max' },
      ],
    });
  });
});

describe('replaying a curve', () => {
  it('turns realised changes into a curve over the recording, merging repeats', () => {
    expect(
      curveFromChanges(
        [
          { frame: 0, fps: 0 },
          { frame: 500, fps: 0 },
          { frame: 1000, fps: 40 },
          { frame: 1000, fps: 60 },
          { frame: 1500, fps: 60 },
          { frame: 1800, fps: 0 },
        ],
        2000,
      ),
    ).toEqual({
      points: [
        { at: 0, fps: 'max' },
        { at: 0.5, fps: 60 },
        { at: 0.9, fps: 'max' },
      ],
    });
    expect(curveFromChanges([], 100)).toBeNull();
    expect(curveFromChanges([{ frame: 0, fps: 30 }], 0)).toBeNull();
  });

  it('settingsFromRecord replays a Curve or Auto run as a curve, and only those', () => {
    const rec = (mode: string) =>
      JSON.parse(
        JSON.stringify(
          buildRunRecord(
            input({
              settings: { speed_mode: mode, target_speed_fps: 0 },
              targetSpeed: [
                { at: 't0', frame: 0, fps: 0, source: 'run start' },
                { at: 't1', frame: 3000, fps: 45, source: 'auto' },
              ],
            }),
          ),
        ),
      );
    expect(settingsFromRecord(rec('auto'))).toMatchObject({
      speedMode: 'auto',
      curve: {
        points: [
          { at: 0, fps: 'max' },
          { at: 0.5, fps: 45 },
        ],
      },
    });
    expect(settingsFromRecord(rec('curve'))!.curve!.points).toHaveLength(2);
    expect(settingsFromRecord(rec('fixed'))!.speedMode).toBe('fixed');
    expect(settingsFromRecord(rec('bogus'))!.speedMode).toBeUndefined();
  });

  it('replays any run with more than one distinct target as a curve, whatever its mode', () => {
    const rec = (mode: string, fps: number[]) =>
      JSON.parse(
        JSON.stringify(
          buildRunRecord(
            input({
              settings: { speed_mode: mode, target_speed_fps: fps[0] },
              targetSpeed: fps.map((f, k) => ({
                at: `t${k}`,
                frame: k * 3000,
                fps: f,
                source: k ? 'setting' : 'run start',
              })),
            }),
          ),
        ),
      );
    expect(settingsFromRecord(rec('fixed', [0, 60]))!.curve!.points).toEqual([
      { at: 0, fps: 'max' },
      { at: 0.5, fps: 60 },
    ]);
    expect(settingsFromRecord(rec('fixed', [60, 120]))!.curve!.points).toEqual([
      { at: 0, fps: 60 },
      { at: 0.5, fps: 120 },
    ]);
    // One target all through: no curve.
    expect(settingsFromRecord(rec('fixed', [60]))!.curve).toBeUndefined();
  });

  it('records the settings the run started with, not the end-of-run values', () => {
    const trace = new RunTrace();
    trace.noteTargetSpeed(0, 0, 'run start');
    trace.noteTargetSpeed(60, 500, 'setting');
    trace.noteCap(1, 0, 'run start');
    trace.noteCap(0, 500, 'setting');
    const r = gatherRunRecord({
      ...gatherSources(),
      trace,
      pipeline: { ...gatherSources().pipeline, paceFps: () => 60, csettle: () => false },
    }) as Rec;
    expect(r.settings.target_speed_fps).toBe(0);
    expect(r.settings.settle_cap).toBe(1);
    expect(settingsFromRecord(JSON.parse(JSON.stringify(r)))).toMatchObject({
      paceFps: 0,
      csettleCeiling: 1,
      capChangedDuringRun: true,
    });
  });
});

describe('run record: the Discover visit rate', () => {
  it('writes work.visit_rate as given and null without one', () => {
    expect((buildRunRecord(input()) as Rec).work.visit_rate).toBeNull();
    const summary = new VisitRateGovernor('on').summary();
    const r = buildRunRecord(input({ visitRate: summary })) as Rec;
    expect(r.work.visit_rate).toMatchObject({
      mode: 'on',
      floor: VISIT_RATE.floor,
      target: VISIT_RATE.target,
      cap: VISIT_RATE.cap,
      held_s: 0,
      min_hold_fps: null,
    });
  });

  it('keeps the summary in the trace until the next run', () => {
    const t = new RunTrace();
    expect(t.visitRate()).toBeNull();
    t.noteVisitRate(new VisitRateGovernor('cap-only').summary());
    expect(t.visitRate()?.mode).toBe('cap-only');
    t.reset();
    expect(t.visitRate()).toBeNull();
  });

  it('records visitrate=off as a debug flag', () => {
    expect(urlFlags('?debug&visitrate=off').flags.visitrate.in_effect).toBe(true);
    expect(urlFlags('?visitrate=off').flags.visitrate.in_effect).toBe(false);
    expect(urlFlags('?debug&visitrate=on').flags.visitrate.in_effect).toBe(false);
  });
});
