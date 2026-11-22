import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRunRecord,
  gatherRunRecord,
  machineContext,
  primeRunRecordContext,
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
    engineVersion: '0.1.0',
    search:
      '?debug&lookback&csettle=yield4&csrate=1&pacefps=30&lbpool=2&governor&smooth=0&live=ws://10.0.0.5:9000&x=1',
    settings: { lookback: true, flat_field: true },
    input: {
      label: 'rec',
      live: false,
      frames: 6000,
      fps: 30,
      width: 10,
      height: 8,
      bitDepth: 8,
      files: [{ name: '0.avi', frames: 6000, size: 1234 }],
      sessions: [],
      mode: null,
    },
    stages: [stage],
    settle: { fed: 900, planned: 1800, recording: 6000, stopped_by_user: true, done: true },
    settleTimes: { started_at: 'a', ended_at: 'b' },
    targetSpeed: [{ at: 't0', frame: 0, fps: 30, source: 'run start' }],
    work: { cap: 1, pool: 3, visit_workers: 4, governor_on: true },
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
    expect(f.flags.governor.value).toBe('');
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
    expect(r.record_version).toBe(1);
    expect(r.software).toMatchObject({
      app: 'cala',
      app_version: '2.20.0',
      git_commit: 'abc123',
      engine_version: '0.1.0',
    });
    expect(r.settings).toEqual({ lookback: true, flat_field: true });
    expect(r.input.files).toEqual([{ name: '0.avi', frames: 6000, size: 1234 }]);
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
      csettleGovernor: () => false,
      paceFps: () => 0,
      smoothPlayback: () => true,
      fps: () => 0,
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
    lookbackWorkers: () => 1,
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
      settle_ceiling_per_live_frame: 2,
      target_speed_fps: 0,
      library_mode: 'joint',
      refine_runs: 2,
      export_pass_qc_only: true,
    });
    expect(r.input.files).toEqual([{ name: 'a.avi', frames: 100, size: 99 }]);
    expect(r.input.sessions[0]).toMatchObject({ name: 's0', frames: 100 });
    expect(r.final_settle).toMatchObject({ frames_fed: 10, stopped_early_by_user: false });
    expect(r.work).toMatchObject({ pool: 1, visit_workers: 3, achieved_fps: null });
    expect(r.software.git_commit).toBeNull();
  });

  it('keeps the engine version once primed, and survives a failing loader', async () => {
    await primeRunRecordContext(async () => '9.9.9');
    expect((gatherRunRecord(sources()) as Rec).software.engine_version).toBe('9.9.9');
    resetRunRecordContext();
    await primeRunRecordContext(async () => {
      throw new Error('no wasm');
    });
    expect((gatherRunRecord(sources()) as Rec).software.engine_version).toBeNull();
  });
});

describe('settingsFromRecord', () => {
  it('maps a record back to settings and rejects anything else', () => {
    const rec = buildRunRecord(
      input({
        settings: {
          flat_field: false,
          lookback: true,
          settle_during_discover: true,
          settle_ceiling_per_live_frame: 0.5,
          target_speed_fps: 30,
          smooth_playback: false,
        },
      }),
    );
    expect(settingsFromRecord(JSON.parse(JSON.stringify(rec)))).toEqual({
      flatField: false,
      lookback: true,
      csettle: true,
      csettleCeiling: 0.5,
      paceFps: 30,
      smoothPlayback: false,
    });
    expect(settingsFromRecord(null)).toBeNull();
    expect(settingsFromRecord({ format: 'other' })).toBeNull();
    expect(settingsFromRecord({ ...rec, record_version: 99 })).toBeNull();
  });
});
