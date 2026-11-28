import type { ProjectFile, RunFile, RunResult } from '../generated/files';
import { emptyProject } from '../model.ts';

export const T0 = new Date('2026-11-28T09:10:02.000Z');

export const DAY1 = '2026_11_10/09_00_00/My_V4_Miniscope';
export const DAY2 = '2026_11_11/09_05_12/My_V4_Miniscope';
export const DAY3 = '2026_11_14/10_30_00/My_V4_Miniscope';

/** A three-session project with defaults, an override and a two-step plan. */
export function threeSessionProject(): ProjectFile {
  const p = emptyProject('mouse1', T0, 'p-7f3a9c21');
  return {
    ...p,
    sessions: [
      {
        id: '2026_11_10/09_00_00',
        start: '2026-11-10T09:00:00.000Z',
        label: 'baseline',
        streams: [{ id: 'My_V4_Miniscope', role: 'miniscope', frames: 18000, previous_ids: [] }],
      },
      {
        id: '2026_11_11/09_05_12',
        start: '2026-11-11T09:05:12.000Z',
        label: null,
        streams: [{ id: 'My_V4_Miniscope', role: 'miniscope', frames: 18000, previous_ids: [] }],
      },
      {
        id: '2026_11_14/10_30_00',
        start: '2026-11-14T10:30:00.000Z',
        label: null,
        streams: [
          {
            id: 'My_V4_Miniscope',
            role: 'miniscope',
            frames: 12000,
            previous_ids: [],
            overrides: { cala: { time: { fps_override: 30 } } },
          },
        ],
      },
    ],
    defaults: { cala: { params_version: 1, params: { scales: { cell_diameter_px: 16 } } } },
    plan: {
      id: '2026-11-28_09-13-40',
      steps: [
        {
          id: 'a',
          app: 'cala',
          kind: 'joint',
          streams: [DAY1, DAY2],
          params: { input: { crop: { x: 40, y: 32, width: 512, height: 512 } } },
          status: 'pending',
          runs: [],
        },
        { id: 'b', app: 'cala', kind: 'separate', streams: [DAY3], status: 'pending', runs: [] },
      ],
    },
  };
}

function result(id: string, stream: string, over: Partial<RunResult> = {}): RunResult {
  return {
    stream,
    status: 'written',
    path: `${stream}/cala-export.npz`,
    id_space: `cala:${id}`,
    cells: 231,
    library_version: 164,
    frame_range: [0, 18000],
    boundary: null,
    created: '2026-11-28T10:02:40.000Z',
    ...over,
  };
}

/** A finished cala run of `streams` (Joint when several). */
export function calaRun(id: string, streams: string[], created: string): RunFile {
  return {
    format: 'calab-run',
    version: 1,
    run: {
      id,
      app: 'cala',
      app_version: 'v2.26.0',
      engine_version: '0.9.0',
      git_commit: 'ab12cd3',
      project: 'p-7f3a9c21',
      plan: { id: 'plan-1', step: 'a', kind: streams.length > 1 ? 'joint' : 'separate' },
      status: 'finished',
      stopped: null,
      created,
      updated: created,
    },
    inputs: streams.map((stream, i) => ({
      role: 'video',
      stream,
      recording_start: null,
      frames: 18000,
      files: 18,
      width: 608,
      height: 608,
      bit_depth: 8,
      fps: { value: 30.02, source: 'timestamps' },
      start_frame: i * 18000,
    })),
    links: [],
    config: {
      schema: 'cala-params',
      params_version: 1,
      requested: { scales: { cell_diameter_px: 16 } },
      sources: { '/scales/cell_diameter_px': 'project' },
      ignored: [],
      resolved: { scales: { cell_diameter_px: 16 } },
      fingerprint: 'sha256:5d0c',
    },
    derived: {},
    frame: null,
    stages: [{ stage: 'discover', outcome: 'done', index: 1, cells: 231 }],
    results: streams.map((s, i) =>
      result(id, s, { created, frame_range: [i * 18000, (i + 1) * 18000] }),
    ),
    record: { machine: { hardware_concurrency: 12 } },
  };
}

/** A CaDecon run linked to a cala run's traces: no inputs of its own, the cala id space kept. */
export function cadeconRun(id: string, calaId: string, stream: string): RunFile {
  return {
    format: 'calab-run',
    version: 1,
    run: {
      id,
      app: 'cadecon',
      app_version: 'v2.26.0',
      engine_version: null,
      git_commit: null,
      project: 'p-7f3a9c21',
      plan: null,
      status: 'finished',
      stopped: null,
      created: '2026-11-30T10:02:11.000Z',
      updated: '2026-11-30T10:20:00.000Z',
    },
    inputs: [],
    links: [
      {
        role: 'traces',
        run: calaId,
        stream,
        artifact: 'cala-export.npz',
        array: 'traces',
        id_space: `cala:${calaId}`,
        select: 'qc_pass',
        cells: 198,
        source_fingerprint: 'sha256:5d0c',
      },
    ],
    config: {
      schema: 'cadecon-params',
      params_version: 1,
      requested: {},
      sources: {},
      ignored: [],
      resolved: {},
      fingerprint: null,
    },
    derived: {},
    stages: [],
    results: [
      {
        stream,
        status: 'written',
        path: `${stream}/cadecon-results.zip`,
        id_space: `cala:${calaId}`,
        cells: 198,
        library_version: null,
        frame_range: null,
        boundary: null,
        created: '2026-11-30T10:20:00.000Z',
      },
    ],
    record: {},
  };
}
