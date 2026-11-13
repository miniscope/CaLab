import { describe, expect, it } from 'vitest';
import {
  addResult,
  currentResult,
  emptyIndex,
  findRuns,
  matchSession,
  mergeRuns,
  parseIndex,
  projectSessionId,
  rebuildIndex,
  reconcileSessions,
  runIdFor,
  serializeIndex,
  sharedIdGroups,
  sessionStatus,
  setCurrent,
  suggestSplit,
  upsertRun,
  validateIndex,
  type ProjectIndex,
  type ProjectRun,
  type ResultsFile,
  type ScannedSession,
} from '../lib/project-index.ts';
import { runManifest, sessionMetadata, type SessionRecord } from '../lib/session-export.ts';
import type { StageRun } from '../lib/run-stages.ts';

const LOC = { kind: 'default' as const, label: 'mouse1/cala-results' };
const NOW = new Date('2026-11-13T12:00:00Z');
const T1 = Date.parse('2026-11-10T09:00:00Z');
const T2 = Date.parse('2026-11-11T09:00:00Z');
const T3 = Date.parse('2026-11-12T09:00:00Z');

const scan = (id: string, startMs: number | null, frames = 800): ScannedSession => ({
  id,
  startMs,
  frames,
  fps: 20,
  width: 600,
  height: 600,
  bitDepth: 8,
});
const S1 = '2026_11_10/09_00_00/My_V4_Miniscope';
const S2 = '2026_11_11/09_00_00/My_V4_Miniscope';
const S3 = '2026_11_12/09_00_00/My_V4_Miniscope';
const SCANNED = [scan(S1, T1), scan(S2, T2), scan(S3, T3)];

const stage = (
  stage: StageRun['stage'],
  index = 1,
  outcome: StageRun['outcome'] = 'done',
): StageRun => ({
  stage,
  index,
  startedAt: '2026-11-12T10:00:00.000Z',
  endedAt: '2026-11-12T10:05:00.000Z',
  outcome,
  frames: 800,
  cells: 12,
  libraryVersion: 3,
});
const STAGES = [stage('discover'), stage('refine'), stage('refine', 2), stage('extract')];

/** A results tree as #377 wrote it (`multi-run.ts`), picked at the animal folder. */
function tree377(
  folder: string,
  mode: 'joint' | 'separate',
  sessions: { id: string; start: number; status?: SessionRecord['status'] }[],
  created: string,
): ResultsFile[] {
  const records: SessionRecord[] = sessions.map((s, index) => ({
    index,
    name: s.id,
    dir: `mouse1/${s.id}`,
    resultsPath: s.id,
    startFrame: mode === 'joint' ? index * 800 : 0,
    frames: 800,
    fps: 20,
    recordingStartMs: s.start,
    status: s.status ?? 'written',
  }));
  const settings = { mode, refineRuns: 2 };
  const prefix = folder ? `${folder}/` : '';
  const files: ResultsFile[] = [
    {
      path: `${prefix}cala-run.json`,
      text: JSON.stringify(
        runManifest({
          version: 'v2.14.0',
          settings,
          sessions: records,
          boundaries: [],
          root: 'cala-results',
          createdAt: created,
          updatedAt: created,
          finished: true,
        }),
      ),
    },
  ];
  for (const r of records.filter((x) => x.status === 'written')) {
    files.push({
      path: `${prefix}${r.resultsPath}/cala-session.json`,
      text: JSON.stringify(
        sessionMetadata({
          version: 'v2.14.0',
          settings,
          session: r,
          sessions: records.length,
          boundaries: [],
          stages: STAGES,
          libraryVersion: 3,
          cells: 3,
          sharedCellIds: mode === 'joint' ? [1, 2, 5] : null,
          createdAt: created,
        }),
      ),
    });
  }
  return files;
}

describe('index read, write and validate', () => {
  it('round-trips an index', () => {
    const idx = reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index;
    const read = parseIndex(serializeIndex(idx));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.index).toEqual(idx);
  });

  it('reports corrupt JSON and bad fields', () => {
    expect(parseIndex('{"format": "cala-proj').ok).toBe(false);
    const idx = reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index;
    const bad = JSON.parse(serializeIndex(idx));
    bad.sessions[1].frames = 'many';
    const r = validateIndex(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sessions[1].frames');
    expect(validateIndex({ ...JSON.parse(serializeIndex(idx)), format: 'x' }).ok).toBe(false);
    expect(validateIndex([]).ok).toBe(false);
  });

  it('flags a newer schema instead of guessing', () => {
    const idx = { ...emptyIndex('mouse1', LOC, NOW), schema_version: 99 };
    const r = validateIndex(idx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.newer).toBe(true);
  });

  it('gives a session id relative to the animal folder', () => {
    expect(projectSessionId('mouse1/2026_11_10/09_00_00/My_V4_Miniscope')).toBe(
      '2026_11_10/09_00_00/My_V4_Miniscope',
    );
    expect(projectSessionId('mouse1')).toBe('.');
  });
});

describe('rebuild from run folders', () => {
  it('rebuilds a #377 tree at the results root', () => {
    const files = tree377(
      '',
      'joint',
      [
        { id: S1, start: T1 },
        { id: S2, start: T2 },
      ],
      '2026-11-12T10:00:00.000Z',
    );
    const { index, unreadable } = rebuildIndex('mouse1', LOC, SCANNED, files, NOW);
    expect(unreadable).toEqual([]);
    expect(index.sessions.map((s) => s.id)).toEqual([S1, S2, S3]);
    expect(index.runs).toHaveLength(1);
    const run = index.runs[0];
    expect(run.folder).toBe('');
    expect(run.id).toMatch(/^legacy-/);
    expect(run.mode).toBe('joint');
    expect(run.sessions.map((s) => [s.id, s.status])).toEqual([
      [S1, 'written'],
      [S2, 'written'],
    ]);
    expect(index.results.map((r) => [r.session, r.export_path, r.current])).toEqual([
      [S1, `${S1}/cala-export.npz`, true],
      [S2, `${S2}/cala-export.npz`, true],
    ]);
    expect(index.results[0].cell_ids).toEqual([1, 2, 5]);
    // A Joint run: one id space, shared by its sessions.
    expect(index.results.map((r) => r.id_space)).toEqual([`run:${run.id}`, `run:${run.id}`]);
    expect(index.results[0].library_version).toBe(3);
    expect(sessionStatus(index, S1)).toMatchObject({
      discover: 'done',
      refine: 'done',
      refines: 2,
      extract: 'done',
      run: run.id,
    });
    expect(validateIndex(JSON.parse(serializeIndex(index))).ok).toBe(true);
  });

  it('rebuilds project runs under runs/ next to a legacy run; the newest is current', () => {
    const files = [
      ...tree377('', 'joint', [{ id: S1, start: T1 }], '2026-11-12T10:00:00.000Z'),
      ...tree377(
        'runs/2026-11-13_08-00-00',
        'separate',
        [
          { id: S1, start: T1 },
          { id: S3, start: T3, status: 'skipped' },
        ],
        '2026-11-13T08:00:00.000Z',
      ),
    ];
    const { index } = rebuildIndex('mouse1', LOC, SCANNED, files, NOW);
    expect(index.runs.map((r) => r.id)).toEqual([index.runs[0].id, '2026-11-13_08-00-00']);
    expect(currentResult(index, S1)?.run).toBe('2026-11-13_08-00-00');
    expect(index.results.filter((r) => r.session === S1)).toHaveLength(2);
    // A session the run skipped has no result, and says why.
    expect(sessionStatus(index, S3).note).toBe('skipped');
    expect(sessionStatus(index, S3).current).toBeNull();
  });

  it('assigns session files to the nearest run manifest', () => {
    const files = [
      ...tree377('', 'joint', [{ id: S1, start: T1 }], '2026-11-12T10:00:00.000Z'),
      ...tree377('runs/a', 'separate', [{ id: S2, start: T2 }], '2026-11-13T08:00:00.000Z'),
    ];
    const { runs } = findRuns(files);
    expect(runs.map((r) => [r.folder, r.sessions.map((s) => s.dir)])).toEqual([
      ['', [S1]],
      ['runs/a', [S2]],
    ]);
  });

  it('reports unreadable files and skips them', () => {
    const files = [
      ...tree377('', 'joint', [{ id: S1, start: T1 }], '2026-11-12T10:00:00.000Z'),
      { path: 'runs/x/cala-run.json', text: '{oops' },
    ];
    const { index, unreadable } = rebuildIndex('mouse1', LOC, SCANNED, files, NOW);
    expect(unreadable).toEqual(['runs/x/cala-run.json']);
    expect(index.runs).toHaveLength(1);
  });

  it('matches a run picked one folder up, and by start time and frames', () => {
    const sessions = reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index.sessions;
    expect(matchSession(`exp/mouse1/${S2}`, null, null, sessions)).toBe(S2);
    expect(matchSession('other/renamed', new Date(T3).toISOString(), 800, sessions)).toBe(S3);
    expect(matchSession('other/unknown', null, null, sessions)).toBe('unknown');
  });

  it('merges only runs the index does not hold', () => {
    const files = tree377(
      'runs/r1',
      'separate',
      [{ id: S1, start: T1 }],
      '2026-11-13T08:00:00.000Z',
    );
    const { index } = rebuildIndex('mouse1', LOC, SCANNED, files, NOW);
    const again = mergeRuns(index, findRuns(files).runs);
    expect(again.added).toEqual([]);
    expect(again.index).toEqual(index);
  });
});

describe('renamed folders', () => {
  const base = () => reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index;

  it('follows a rename by start time and frame count, results included', () => {
    let idx = base();
    idx = addResult(idx, {
      session: S2,
      run: 'r1',
      export_path: 'runs/r1/x.npz',
      cells: 3,
      cell_ids: null,
      id_space: 'run:r1',
      library_version: 3,
      created: '2026-11-13T00:00:00Z',
    });
    const renamed = 'day2/09_00_00/My_V4_Miniscope';
    const rec = reconcileSessions(idx, [scan(S1, T1), scan(renamed, T2), scan(S3, T3)]);
    expect(rec.renamed).toEqual([[S2, renamed]]);
    expect(rec.missing).toEqual([]);
    expect(rec.added).toEqual([]);
    const s = rec.index.sessions.find((x) => x.id === renamed)!;
    expect(s.previous_ids).toEqual([S2]);
    expect(currentResult(rec.index, renamed)?.run).toBe('r1');
  });

  it('flags a folder that is gone, and does not match on a different frame count', () => {
    const rec = reconcileSessions(base(), [scan(S1, T1), scan('other', T2, 900), scan(S3, T3)]);
    expect(rec.renamed).toEqual([]);
    expect(rec.missing).toEqual([S2]);
    expect(rec.added).toEqual(['other']);
    expect(rec.index.sessions.find((x) => x.id === S2)?.missing).toBe(true);
  });

  it('does not guess between two candidates', () => {
    const rec = reconcileSessions(base(), [
      scan(S1, T1),
      scan('a', T2),
      scan('b', T2),
      scan(S3, T3),
    ]);
    expect(rec.renamed).toEqual([]);
    expect(rec.missing).toEqual([S2]);
  });

  it('clears missing when the folder comes back', () => {
    const gone = reconcileSessions(base(), [scan(S1, T1), scan(S3, T3)]).index;
    const back = reconcileSessions(gone, SCANNED).index;
    expect(back.sessions.every((s) => !s.missing)).toBe(true);
  });
});

describe('current result', () => {
  const res = (run: string, created: string) => ({
    session: S1,
    run,
    export_path: `runs/${run}/x.npz`,
    cells: 1,
    cell_ids: [1],
    id_space: `run:${run}`,
    library_version: 1,
    created,
  });

  it('the newest result is current; an older one found later is not', () => {
    let idx = emptyIndex('mouse1', LOC, NOW);
    idx = addResult(idx, res('a', '2026-11-12T00:00:00Z'));
    idx = addResult(idx, res('b', '2026-11-13T00:00:00Z'));
    expect(currentResult(idx, S1)?.run).toBe('b');
    idx = addResult(idx, res('old', '2026-11-01T00:00:00Z'));
    expect(currentResult(idx, S1)?.run).toBe('b');
    expect(idx.results.filter((r) => r.current)).toHaveLength(1);
  });

  it('set current picks an older one; unknown runs are refused', () => {
    let idx = emptyIndex('mouse1', LOC, NOW);
    idx = addResult(idx, res('a', '2026-11-12T00:00:00Z'));
    idx = addResult(idx, res('b', '2026-11-13T00:00:00Z'));
    idx = setCurrent(idx, S1, 'a');
    expect(currentResult(idx, S1)?.run).toBe('a');
    expect(idx.results.filter((r) => r.current)).toHaveLength(1);
    expect(() => setCurrent(idx, S1, 'zzz')).toThrow();
  });

  it('a result written again for the same run replaces the old entry', () => {
    let idx = emptyIndex('mouse1', LOC, NOW);
    idx = addResult(idx, res('a', '2026-11-12T00:00:00Z'));
    idx = addResult(idx, { ...res('a', '2026-11-12T00:00:01Z'), cells: 9 });
    expect(idx.results).toHaveLength(1);
    expect(idx.results[0].cells).toBe(9);
  });
});

describe('session table status', () => {
  const run = (id: string, created: string, extra: Partial<ProjectRun> = {}): ProjectRun => ({
    id,
    folder: `runs/${id}`,
    mode: 'separate',
    sessions: [],
    settings: {},
    app_version: 'dev',
    created,
    updated: created,
    finished: true,
    library_in: null,
    library_out: null,
    ...extra,
  });
  const meta = (s: StageRun) => ({
    stage: s.stage,
    outcome: s.outcome,
    started_at: s.startedAt,
    ended_at: s.endedAt,
  });

  it('is blank for a session never run', () => {
    const idx = reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index;
    expect(sessionStatus(idx, S1)).toMatchObject({
      discover: 'none',
      refine: 'none',
      refines: 0,
      extract: 'none',
      run: null,
      current: null,
      note: null,
    });
  });

  it("follows the current result's run, not a newer failed one", () => {
    let idx: ProjectIndex = reconcileSessions(emptyIndex('mouse1', LOC, NOW), SCANNED).index;
    idx = upsertRun(
      idx,
      run('good', '2026-11-12T00:00:00Z', {
        sessions: [{ id: S1, status: 'written', stages: STAGES.map(meta) }],
      }),
    );
    idx = addResult(idx, {
      session: S1,
      run: 'good',
      export_path: 'runs/good/x.npz',
      cells: 3,
      cell_ids: null,
      id_space: 'run:good/x',
      library_version: 3,
      created: '2026-11-12T00:00:00Z',
    });
    idx = upsertRun(
      idx,
      run('bad', '2026-11-13T00:00:00Z', {
        finished: false,
        stopped: 'Extract was cancelled.',
        sessions: [
          {
            id: S1,
            status: 'failed',
            note: 'Extract was cancelled.',
            stages: [stage('discover'), stage('extract', 1, 'cancelled')].map(meta),
          },
        ],
      }),
    );
    const st = sessionStatus(idx, S1);
    expect(st.run).toBe('good');
    expect(st.extract).toBe('done');
    expect(st.refines).toBe(2);
    // With no result, the failed run is what shows.
    idx = upsertRun(
      idx,
      run('bad2', '2026-11-13T00:00:00Z', {
        sessions: [
          {
            id: S2,
            status: 'failed',
            note: 'Extract was cancelled.',
            stages: [stage('discover'), stage('extract', 1, 'cancelled')].map(meta),
          },
        ],
      }),
    );
    const st2 = sessionStatus(idx, S2);
    expect(st2).toMatchObject({ discover: 'done', extract: 'cancelled', run: 'bad2' });
    expect(st2.note).toBe('failed: Extract was cancelled.');
  });
});

describe('several animals in one folder', () => {
  it('suggests a split for top-level animal folders with several sessions each', () => {
    const ids = [
      `m1/${S1}`,
      `m1/${S2}`,
      `m2/${S1}`,
      `m2/${S2}`,
      `m2/${S3}`,
      'm3/2026_11_10/09_00_00/My_V4_Miniscope',
    ];
    expect(suggestSplit(ids)).toEqual([
      { folder: 'm1', sessions: [`m1/${S1}`, `m1/${S2}`] },
      { folder: 'm2', sessions: [`m2/${S1}`, `m2/${S2}`, `m2/${S3}`] },
    ]);
  });

  it('does not split an animal folder of dates, times or numbered days', () => {
    expect(suggestSplit([S1, S2, '2026_11_10/15_00_00/My_V4_Miniscope', S3])).toBeNull();
    expect(suggestSplit(['day1/a/x', 'day1/b/x', 'day2/a/x', 'day2/b/x'])).toBeNull();
    expect(suggestSplit(['14_02_33/a', '14_02_33/b', '15_00_00/a', '15_00_00/b'])).toBeNull();
  });

  it('needs two animals', () => {
    expect(suggestSplit([`m1/${S1}`, `m1/${S2}`, `m2/${S1}`])).toBeNull();
    expect(suggestSplit(['.'])).toBeNull();
  });
});

describe('run ids', () => {
  it('are timestamps, unique', () => {
    const t = new Date(2026, 10, 13, 14, 2, 3);
    expect(runIdFor(t, new Set())).toBe('2026-11-13_14-02-03');
    expect(runIdFor(t, new Set(['2026-11-13_14-02-03']))).toBe('2026-11-13_14-02-03_2');
  });
});

describe('shared cell ids', () => {
  it('groups sessions whose current results share an id space', () => {
    const files = [
      ...tree377(
        'runs/j',
        'joint',
        [
          { id: S1, start: T1 },
          { id: S2, start: T2 },
        ],
        '2026-11-12T10:00:00.000Z',
      ),
      ...tree377('runs/s', 'separate', [{ id: S3, start: T3 }], '2026-11-13T08:00:00.000Z'),
    ];
    const { index } = rebuildIndex('mouse1', LOC, SCANNED, files, NOW);
    expect(index.results.map((r) => r.id_space)).toEqual(['run:j', 'run:j', `run:s/${S3}`]);
    const g = sharedIdGroups(index);
    expect(g.get(S1)).toMatchObject({ label: 'A', colour: 0, sessions: [S1, S2] });
    expect(g.get(S2)?.space).toBe('run:j');
    expect(g.get(S3)).toMatchObject({ label: '', colour: -1 });
    // Cross-session matching of Separate results is reserved, not made.
    expect(index.cell_matches).toEqual([]);
  });
});
