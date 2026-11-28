import { describe, expect, it } from 'vitest';
import { rebuildIndex, type IndexStream, type RunFile } from '@calab/project';
import {
  projectSessionId,
  sessionStatus,
  sharedIdGroups,
  suggestSplit,
} from '../lib/project-index.ts';
import { calaRunFile } from '../lib/run-file.ts';
import type { SessionRecord } from '../lib/session-export.ts';
import type { BoundaryFlag } from '../lib/boundary-flags.ts';

/**
 * cala's view of a project index (`@calab/project` builds and reads the index; its own tests
 * cover rebuilds, renames and current results): what the session table shows per stream, which
 * streams share cell ids, and the several-animals split of the open dialog.
 */
const S1 = '2026_11_10/09_00_00/My_V4_Miniscope';
const S2 = '2026_11_11/09_00_00/My_V4_Miniscope';
const S3 = '2026_11_12/09_00_00/My_V4_Miniscope';
const NOW = new Date('2026-11-28T12:00:00Z');

const stream = (ref: string, previous: string[] = []): IndexStream => ({
  ref,
  role: 'miniscope',
  start: null,
  frames: 100,
  fps: 20,
  width: 64,
  height: 64,
  bit_depth: 8,
  missing: false,
  previous_refs: previous,
});
const STREAMS = [stream(S1), stream(S2), stream(S3)];

interface Sess {
  stream: string;
  status?: SessionRecord['status'];
  note?: string;
  boundary?: BoundaryFlag;
}

/** A cala run file of `sessions`, through the app's own builder. */
function run(
  id: string,
  created: string,
  sessions: Sess[],
  opts: {
    joint?: boolean;
    status?: RunFile['run']['status'];
    stopped?: string | null;
    stages?: { stage: string; outcome: string }[];
  } = {},
): { folder: string; run: RunFile } {
  const joint = opts.joint ?? sessions.length > 1;
  const doc = calaRunFile({
    id,
    project: 'p-1',
    plan: null,
    status: opts.status ?? 'finished',
    stopped: opts.stopped ?? null,
    created,
    updated: created,
    version: 'test',
    joint,
    record: {
      stages: opts.stages ?? [
        { stage: 'discover', outcome: 'done' },
        { stage: 'extract', outcome: 'done' },
      ],
    },
    sessions: sessions.map((s, index) => {
      const status = s.status ?? 'written';
      return {
        stream: s.stream,
        info: null,
        record: {
          index,
          name: s.stream,
          dir: s.stream,
          resultsPath: s.stream,
          startFrame: index * 100,
          frames: 100,
          fps: 20,
          recordingStartMs: null,
          status,
          ...(s.note ? { note: s.note } : {}),
          ...(s.boundary ? { boundary: s.boundary } : {}),
        },
        ...(status === 'written' ? { written: { cells: 3, libraryVersion: 2, created } } : {}),
      };
    }),
  });
  return { folder: `runs/${id}`, run: doc };
}

const index = (...runs: { folder: string; run: RunFile }[]) => rebuildIndex(runs, STREAMS, NOW);

describe('stream refs of the open dialog', () => {
  it('drops the picked folder name; a loose recording is "."', () => {
    expect(projectSessionId(`mouse1/${S1}`)).toBe(S1);
    expect(projectSessionId('mouse1')).toBe('.');
  });
});

describe('session table status', () => {
  it('is blank for a stream never run', () => {
    expect(sessionStatus(index(), {}, S1)).toEqual({
      discover: 'none',
      extract: 'none',
      run: null,
      current: null,
      results: [],
      note: null,
      boundary: null,
      runMode: null,
      runSessions: [],
    });
  });

  it("follows the current result's run, not a newer failed one", () => {
    const good = run('good', '2026-11-12T00:00:00Z', [{ stream: S1 }]);
    const bad = run(
      'bad',
      '2026-11-13T00:00:00Z',
      [{ stream: S1, status: 'failed', note: 'Extract was cancelled.' }],
      {
        status: 'stopped',
        stopped: 'Extract was cancelled.',
        stages: [
          { stage: 'discover', outcome: 'done' },
          { stage: 'extract', outcome: 'cancelled' },
        ],
      },
    );
    const st = sessionStatus(index(good, bad), {}, S1);
    expect(st).toMatchObject({ run: 'good', discover: 'done', extract: 'done', note: null });
    expect(st.runMode).toBe('separate');
    expect(st.runSessions).toEqual([S1]);
    expect(st.current).toMatchObject({
      session: S1,
      run: 'good',
      export_path: `runs/good/${S1}/cala-export.npz`,
      cells: 3,
      id_space: 'cala:good',
      library_version: 2,
      current: true,
    });
    // With no result, the failed run is what shows, with its note.
    const st2 = sessionStatus(index(bad), {}, S1);
    expect(st2).toMatchObject({ discover: 'done', extract: 'cancelled', run: 'bad' });
    expect(st2.note).toBe('failed: Extract was cancelled.');
  });

  it('says why a stream of a stopped or unfinished run has no result', () => {
    const stopped = run('stop', '2026-11-12T00:00:00Z', [{ stream: S1, status: 'pending' }], {
      status: 'stopped',
      stopped: 'Discover stopped with an error.',
      stages: [{ stage: 'discover', outcome: 'error' }],
    });
    expect(sessionStatus(index(stopped), {}, S1)).toMatchObject({
      discover: 'error',
      extract: 'none',
      note: 'stopped: Discover stopped with an error.',
    });
    const open = run('open', '2026-11-12T00:00:00Z', [{ stream: S1, status: 'pending' }], {
      status: 'running',
      stages: [
        { stage: 'discover', outcome: 'running' },
        { stage: 'extract', outcome: 'odd' },
      ],
    });
    expect(sessionStatus(index(open), {}, S1)).toMatchObject({
      discover: 'running',
      extract: 'none',
      note: 'not finished',
    });
    const skipped = run('skip', '2026-11-12T00:00:00Z', [{ stream: S1, status: 'skipped' }]);
    expect(sessionStatus(index(skipped), {}, S1).note).toBe('skipped');
  });

  it("a hand-set current result picks an older run, with its run's streams and boundary", () => {
    const flag = {
      index: 1,
      frame: 100,
      severity: 'warning',
      pending: false,
      reason: 'The field of view moved.',
      checks: [],
    } as unknown as BoundaryFlag;
    const joint = run('j', '2026-11-12T00:00:00Z', [
      { stream: S1 },
      { stream: S2, boundary: flag },
    ]);
    const later = run('s', '2026-11-14T00:00:00Z', [{ stream: S2 }]);
    const idx = index(joint, later);
    // The newest is current by default.
    expect(sessionStatus(idx, {}, S2)).toMatchObject({ run: 's', boundary: null });
    const st = sessionStatus(idx, { cala: { [S2]: 'j' } }, S2);
    expect(st.run).toBe('j');
    expect(st.runMode).toBe('joint');
    expect(st.runSessions).toEqual([S1, S2]);
    expect(st.boundary).toMatchObject({ index: 1, severity: 'warning', frame: 100 });
    expect(st.results.map((r) => [r.run, r.current])).toEqual([
      ['s', false],
      ['j', true],
    ]);
  });

  it('finds the runs of a renamed stream under its previous ref', () => {
    const old = run('old', '2026-11-12T00:00:00Z', [{ stream: 'renamed/x' }]);
    const idx = rebuildIndex([old], [stream(S1, ['renamed/x'])], NOW);
    expect(sessionStatus(idx, {}, S1)).toMatchObject({ run: 'old', extract: 'done' });
  });
});

describe('shared cell ids', () => {
  it('groups streams whose current results share an id space', () => {
    const joint = run('j', '2026-11-12T00:00:00Z', [{ stream: S1 }, { stream: S2 }]);
    const own = run('s', '2026-11-13T00:00:00Z', [{ stream: S3 }]);
    const g = sharedIdGroups(index(joint, own), {});
    expect(g.get(S1)).toEqual({ space: 'cala:j', label: 'A', sessions: [S1, S2], colour: 0 });
    expect(g.get(S2)).toEqual(g.get(S1));
    expect(g.get(S3)).toEqual({ space: 'cala:s', label: '', sessions: [S3], colour: -1 });
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
