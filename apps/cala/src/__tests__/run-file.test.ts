import { describe, expect, it } from 'vitest';
import { checkFile, fileText, readRunFile } from '@calab/project';
import { calaRunFile, type CalaRunInput, type RunFileSession } from '../lib/run-file.ts';
import { CALA_PARAMS_VERSION } from '../params/schema.ts';

/**
 * cala's run file: the run record folded into `calab-run.json` (params -> config, stages ->
 * stages, input -> inputs, software -> the run header, the rest -> record), checked against the
 * `@calab/project` schema.
 */
const session = (
  index: number,
  over: Partial<RunFileSession['record']> = {},
  written = true,
): RunFileSession => ({
  stream: `day${index}/scope`,
  info: { width: 64, height: 48, bitDepth: 8, fpsSource: 'timestamps', files: [{}, {}] },
  record: {
    index,
    name: `s${index}`,
    dir: `mouse1/day${index}/scope`,
    resultsPath: `day${index}/scope`,
    startFrame: index * 100,
    frames: 100,
    fps: 30,
    recordingStartMs: Date.UTC(2026, 10, 10 + index, 9),
    status: written ? 'written' : 'pending',
    ...over,
  },
  ...(written
    ? { written: { cells: 7, libraryVersion: 4, created: '2026-11-28T10:00:00.000Z' } }
    : {}),
});

const input = (over: Partial<CalaRunInput> = {}): CalaRunInput => ({
  id: '2026-11-28_09-00-00_cala',
  project: 'p-1',
  plan: { id: 'plan-1', step: 'a', kind: 'joint' },
  status: 'running',
  stopped: null,
  created: '2026-11-28T09:00:00.000Z',
  updated: '2026-11-28T10:00:00.000Z',
  version: 'v0-fallback',
  joint: true,
  sessions: [session(0), session(1)],
  record: {
    record_version: 2,
    created: '2026-11-28T09:00:01.000Z',
    software: { app_version: 'v2.26.0', git_commit: 'abc1234', engine_version: '0.9.0' },
    params: {
      fingerprint: 'sha256:f00',
      values: { scales: { cell_diameter_px: 12 } },
      requested: { scales: { expected_cell_diameter_um: 12 } },
      sources: { '/scales/expected_cell_diameter_um': 'file:cala-d12.json' },
      ignored: ['/discover/acept_z', 3],
      context: { fps: 30 },
    },
    stages: [{ stage: 'discover', outcome: 'done' }, 'not a stage'],
    input: { live: false },
    machine: { cores: 8 },
  },
  ...over,
});

describe('calaRunFile', () => {
  it('folds the run record in, and the file passes its schema', () => {
    const doc = calaRunFile(input());
    expect(checkFile('run', doc)).toEqual([]);
    expect(doc.run).toEqual({
      id: '2026-11-28_09-00-00_cala',
      app: 'cala',
      app_version: 'v2.26.0',
      engine_version: '0.9.0',
      git_commit: 'abc1234',
      project: 'p-1',
      plan: { id: 'plan-1', step: 'a', kind: 'joint' },
      status: 'running',
      stopped: null,
      created: '2026-11-28T09:00:00.000Z',
      updated: '2026-11-28T10:00:00.000Z',
    });
    expect(doc.config).toEqual({
      schema: 'cala-params',
      params_version: CALA_PARAMS_VERSION,
      requested: { scales: { expected_cell_diameter_um: 12 } },
      sources: { '/scales/expected_cell_diameter_um': 'file:cala-d12.json' },
      ignored: ['/discover/acept_z'],
      resolved: { scales: { cell_diameter_px: 12 } },
      fingerprint: 'sha256:f00',
    });
    expect(doc.stages).toEqual([{ stage: 'discover', outcome: 'done' }]);
    // The rest of the record, without what moved out of it.
    expect(doc.record).toEqual({
      record_version: 2,
      machine: { cores: 8 },
      params: { context: { fps: 30 } },
    });
    expect(doc.derived).toEqual({
      '/time/fps': { value: 30, source: 'data', method: 'timestamps', stream: 0 },
    });
    // It round-trips through its text.
    const back = readRunFile(fileText('run', doc));
    expect(back.ok && back.value).toEqual(doc);
  });

  it('a Joint run keeps each stream on the one frame axis; its results share an id space', () => {
    const doc = calaRunFile(input());
    expect(doc.inputs.map((i) => [i.stream, i.start_frame, i.files, i.role])).toEqual([
      ['day0/scope', 0, 2, 'video'],
      ['day1/scope', 100, 2, 'video'],
    ]);
    expect(doc.inputs[0]).toMatchObject({
      recording_start: '2026-11-10T09:00:00.000Z',
      frames: 100,
      width: 64,
      height: 48,
      bit_depth: 8,
      fps: { value: 30, source: 'timestamps' },
    });
    expect(doc.results.map((r) => [r.path, r.frame_range, r.id_space, r.cells])).toEqual([
      ['day0/scope/cala-export.npz', [0, 100], 'cala:2026-11-28_09-00-00_cala', 7],
      ['day1/scope/cala-export.npz', [100, 200], 'cala:2026-11-28_09-00-00_cala', 7],
    ]);
  });

  it('a Separate run starts at frame 0; unwritten streams have no path, and notes stay', () => {
    const doc = calaRunFile(
      input({
        joint: false,
        sessions: [
          session(2, { resultsPath: '.' }),
          session(3, { status: 'skipped', note: 'no cells were found' }, false),
        ],
      }),
    );
    expect(doc.inputs.map((i) => i.start_frame)).toEqual([0, 0]);
    expect(doc.results[0]).toMatchObject({ path: 'cala-export.npz', frame_range: [0, 100] });
    expect(doc.results[1]).toMatchObject({
      status: 'skipped',
      note: 'no cells were found',
      path: null,
      cells: null,
      library_version: null,
      created: null,
    });
    expect(checkFile('run', doc)).toEqual([]);
  });

  it('before any record (a planned run): the app version, an empty config', () => {
    const doc = calaRunFile(
      input({
        status: 'planned',
        record: null,
        sessions: [
          {
            ...session(0, { fps: null, recordingStartMs: null, status: 'pending' }, false),
            info: null,
          },
        ],
      }),
    );
    expect(checkFile('run', doc)).toEqual([]);
    expect(doc.run).toMatchObject({
      app_version: 'v0-fallback',
      engine_version: null,
      git_commit: null,
    });
    expect(doc.config).toMatchObject({
      requested: {},
      sources: {},
      ignored: [],
      resolved: {},
      fingerprint: null,
    });
    expect(doc.stages).toEqual([]);
    expect(doc.derived).toEqual({});
    expect(doc.inputs[0]).toMatchObject({
      recording_start: null,
      files: null,
      width: null,
      fps: { value: null, source: 'none' },
    });
  });

  it('a live stream says so', () => {
    const doc = calaRunFile(
      input({ joint: false, sessions: [session(0)], record: { input: { live: true } } }),
    );
    expect(doc.inputs[0]).toMatchObject({ role: 'live', fps: { value: 30, source: 'live' } });
    expect(doc.derived['/time/fps']).toMatchObject({ method: 'live' });
    expect(checkFile('run', doc)).toEqual([]);
  });
});
