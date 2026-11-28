import { describe, expect, it } from 'vitest';
import type { IndexStream } from '../generated/files';
import {
  currentResult,
  findRunFiles,
  idSpaceGroups,
  indexRun,
  rebuildIndex,
  resultsOf,
  runFolder,
  withRun,
} from '../run-index.ts';
import {
  emptyProject,
  idSpaceOf,
  newProjectId,
  projectStreamRefs,
  reconcileStreams,
  runIdFor,
  splitStreamRef,
  streamRef,
} from '../model.ts';
import {
  addSteps,
  afterStep,
  moveStep,
  nextStepId,
  planSummary,
  removeStep,
  runnableSteps,
  stepFinished,
  stepStarted,
  stepStopped,
} from '../plan.ts';
import { brokenLinks, linkedFrom, resolveStepLink, staleLinks } from '../links.ts';
import { appParams, projectDefaults, registerApp } from '../apps.ts';
import { readTree, writeProjectDoc } from '../dir.ts';
import { fileText, readProjectFile } from '../files.ts';
import { calaRun, cadeconRun, DAY1, DAY2, DAY3, T0, threeSessionProject } from './fixtures.ts';
import { MemDir } from './mem-dir.ts';

const stream = (ref: string, over: Partial<IndexStream> = {}): IndexStream => ({
  ref,
  role: 'miniscope',
  start: null,
  frames: 18000,
  fps: 30,
  width: 608,
  height: 608,
  bit_depth: 8,
  missing: false,
  previous_refs: [],
  ...over,
});

describe('stream refs and ids', () => {
  it('join and split', () => {
    expect(streamRef('2026_11_10/09_00_00', 'My_V4_Miniscope')).toBe(
      '2026_11_10/09_00_00/My_V4_Miniscope',
    );
    expect(streamRef('.', 'cam')).toBe('cam');
    expect(streamRef('s1', '.')).toBe('s1');
    expect(splitStreamRef(DAY1)).toEqual({
      session: '2026_11_10/09_00_00',
      stream: 'My_V4_Miniscope',
    });
    expect(splitStreamRef('cam')).toEqual({ session: '.', stream: 'cam' });
    expect(splitStreamRef('.')).toEqual({ session: '.', stream: '.' });
    expect(projectStreamRefs(threeSessionProject())).toEqual([DAY1, DAY2, DAY3]);
  });

  it('make project ids, run ids and id spaces', () => {
    expect(newProjectId(() => 0.5)).toBe('p-88888888');
    expect(newProjectId()).toMatch(/^p-[0-9a-f]{8}$/);
    const t = new Date(2026, 10, 28, 9, 14, 3);
    expect(runIdFor(t, 'cala', new Set())).toBe('2026-11-28_09-14-03_cala');
    expect(runIdFor(t, 'cala', new Set(['2026-11-28_09-14-03_cala']))).toBe(
      '2026-11-28_09-14-03_cala_2',
    );
    expect(idSpaceOf('cala', 'r1')).toBe('cala:r1');
  });
});

describe('reconcileStreams', () => {
  const scan = (ref: string, startMs: number | null, frames: number | null) => ({
    ref,
    role: 'miniscope',
    startMs,
    frames,
  });

  it('adds new streams grouped by session, in start-time order', () => {
    const r = reconcileStreams(emptyProject('m', T0, 'p-1'), [
      scan(DAY2, Date.parse('2026-11-11T09:05:12Z'), 10),
      scan(DAY1, Date.parse('2026-11-10T09:00:00Z'), 10),
      scan('2026_11_10/09_00_00/BehavCam_0', null, 10),
      scan('loose', null, 5),
    ]);
    expect(r.added).toHaveLength(4);
    expect(r.project.sessions.map((s) => [s.id, s.streams.map((x) => x.id)])).toEqual([
      ['2026_11_10/09_00_00', ['My_V4_Miniscope', 'BehavCam_0']],
      ['2026_11_11/09_05_12', ['My_V4_Miniscope']],
      ['.', ['loose']],
    ]);
  });

  it('follows a renamed folder by start time and frames, and flags a missing one', () => {
    const p = threeSessionProject();
    const r = reconcileStreams(p, [
      scan('2026_11_10/09_00_00/scope', Date.parse('2026-11-10T09:00:00.000Z'), 18000),
      scan(DAY2, Date.parse('2026-11-11T09:05:12.000Z'), 18000),
    ]);
    expect(r.renamed).toEqual([[DAY1, '2026_11_10/09_00_00/scope']]);
    expect(r.missing).toEqual([DAY3]);
    const day1 = r.project.sessions[0].streams[0];
    expect(day1).toMatchObject({ id: 'scope', previous_ids: [DAY1] });
    // The missing stream stays, with its overrides.
    expect(r.project.sessions[2].streams[0].overrides).toEqual({
      cala: { time: { fps_override: 30 } },
    });
  });

  it('does not guess a rename when two folders could be it', () => {
    const p = threeSessionProject();
    const start = Date.parse('2026-11-10T09:00:00.000Z');
    const r = reconcileStreams(p, [scan('x/a', start, 18000), scan('x/b', start, 18000)]);
    expect(r.renamed).toEqual([]);
    expect(r.missing).toContain(DAY1);
  });
});

describe('the index', () => {
  const r1 = calaRun('2026-11-28_09-14-03_cala', [DAY1, DAY2], '2026-11-28T09:14:03.000Z');
  const r2 = calaRun('2026-11-29_10-00-00_cala', [DAY1], '2026-11-29T10:00:00.000Z');
  const files = [
    { path: `${runFolder(r1.run.id)}/calab-run.json`, text: fileText('run', r1) },
    { path: `${runFolder(r2.run.id)}/calab-run.json`, text: fileText('run', r2) },
    { path: 'runs/old/cala-run.json', text: '{"format":"cala-run"}' },
    { path: 'runs/bad/calab-run.json', text: '{"format":"calab-run","version":1}' },
    { path: 'runs/r/cala-export.npz.json', text: '{}' },
  ];

  it('is rebuilt from the run files; old and broken files are reported, not read', () => {
    const found = findRunFiles(files);
    expect(found.runs.map((r) => r.folder)).toEqual([runFolder(r1.run.id), runFolder(r2.run.id)]);
    expect(found.refused.map((r) => r.path)).toEqual([
      'runs/old/cala-run.json',
      'runs/bad/calab-run.json',
    ]);
    expect(found.refused[0].error).toContain('older cala');
    const idx = rebuildIndex(found.runs, [stream(DAY1), stream(DAY2)], T0);
    expect(idx.runs.map((r) => [r.id, r.kind, r.status])).toEqual([
      [r1.run.id, 'joint', 'finished'],
      [r2.run.id, 'separate', 'finished'],
    ]);
    expect(idx.results.map((r) => r.path)).toEqual([
      `runs/${r1.run.id}/${DAY1}/cala-export.npz`,
      `runs/${r1.run.id}/${DAY2}/cala-export.npz`,
      `runs/${r2.run.id}/${DAY1}/cala-export.npz`,
    ]);
    // A run written again replaces its entry and its results.
    const again = withRun(idx, { ...r2, results: [] }, runFolder(r2.run.id), T0);
    expect(again.runs).toHaveLength(2);
    expect(again.results).toHaveLength(2);
  });

  it('picks the newest result, unless the project picked one by hand', () => {
    const idx = rebuildIndex(findRunFiles(files).runs, [stream(DAY1), stream(DAY2)], T0);
    expect(resultsOf(idx, 'cala', DAY1).map((r) => r.run)).toEqual([r2.run.id, r1.run.id]);
    expect(currentResult(idx, {}, 'cala', DAY1)?.run).toBe(r2.run.id);
    expect(currentResult(idx, { cala: { [DAY1]: r1.run.id } }, 'cala', DAY1)?.run).toBe(r1.run.id);
    // A hand-picked run with no result for the stream falls back to the newest.
    expect(currentResult(idx, { cala: { [DAY1]: 'gone' } }, 'cala', DAY1)?.run).toBe(r2.run.id);
    expect(currentResult(idx, {}, 'cala', DAY3)).toBeNull();
    // Shared ids: only when both current results are in one id space.
    expect(idSpaceGroups(idx, {}, 'cala').get(DAY1)?.label).toBe('');
    const g = idSpaceGroups(idx, { cala: { [DAY1]: r1.run.id } }, 'cala');
    expect(g.get(DAY1)).toMatchObject({ label: 'A', colour: 0, streams: [DAY1, DAY2] });
  });

  it('finds a renamed stream results under its previous ref', () => {
    const idx = rebuildIndex(
      findRunFiles(files).runs,
      [stream('new', { previous_refs: [DAY1] })],
      T0,
    );
    expect(resultsOf(idx, 'cala', 'new')).toHaveLength(2);
    expect(currentResult(idx, { cala: { [DAY1]: r1.run.id } }, 'cala', 'new')?.run).toBe(r1.run.id);
  });

  it('indexes another app run the same way, through its link', () => {
    const cd = cadeconRun('2026-11-30_10-02-11_cadecon', r1.run.id, DAY1);
    const idx = rebuildIndex(
      [
        { folder: runFolder(r1.run.id), run: r1 },
        { folder: runFolder(cd.run.id), run: cd },
      ],
      [stream(DAY1)],
      T0,
    );
    const e = idx.runs.find((r) => r.app === 'cadecon')!;
    expect(e).toMatchObject({
      kind: 'separate',
      links: [{ role: 'traces', run: r1.run.id, stream: DAY1 }],
    });
    // The CaDecon result keeps the cala run's id space: cell 7 is the same neuron in both.
    expect(idx.results.find((r) => r.run === cd.run.id)?.id_space).toBe(`cala:${r1.run.id}`);
    expect(linkedFrom(idx, r1.run.id)).toEqual([cd.run.id]);
    expect(brokenLinks(idx)).toEqual([]);
    expect(brokenLinks({ ...idx, runs: idx.runs.filter((r) => r.app === 'cadecon') })).toHaveLength(
      1,
    );
    // Each app has its own current result: CaDecon's does not replace cala's.
    expect(currentResult(idx, {}, 'cala', DAY1)?.run).toBe(r1.run.id);
    expect(currentResult(idx, {}, 'cadecon', DAY1)?.run).toBe(cd.run.id);
    expect(staleLinks(idx, {}, cd.run.id)).toEqual([]);
    const r3 = calaRun('2026-12-01_09-00-00_cala', [DAY1], '2026-12-01T09:00:00.000Z');
    const later = withRun(idx, r3, runFolder(r3.run.id), T0);
    expect(staleLinks(later, {}, cd.run.id)).toHaveLength(1);
    expect(staleLinks(later, { cala: { [DAY1]: r1.run.id } }, cd.run.id)).toEqual([]);
    expect(staleLinks(later, {}, 'none')).toEqual([]);
  });

  it('reads the kind off a run without a plan: an apply run links a library', () => {
    const base = calaRun('x', [DAY1], '2026-11-28T09:14:03.000Z');
    const apply = {
      ...base,
      run: { ...base.run, plan: null },
      links: [{ role: 'library' as const, run: 'r', stream: DAY1 }],
    };
    expect(indexRun(apply, 'runs/x').kind).toBe('apply');
    expect(indexRun({ ...base, run: { ...base.run, plan: null } }, 'runs/x').kind).toBe('separate');
    // A stream with no result yet is pending.
    expect(indexRun({ ...base, results: [] }, 'runs/x').streams).toEqual([
      { stream: DAY1, status: 'pending', boundary: null },
    ]);
  });
});

describe('the plan', () => {
  const order = [DAY1, DAY2, DAY3];
  const empty = { id: null, steps: [] };

  it('makes one step per stream for Separate, one for Joint', () => {
    let plan = addSteps(empty, 'cala', 'joint', [DAY2, DAY1], order);
    plan = addSteps(plan, 'cala', 'separate', [DAY3, 'x'], order);
    expect(plan.steps.map((s) => [s.id, s.kind, s.streams])).toEqual([
      ['a', 'joint', [DAY1, DAY2]],
      ['b', 'separate', [DAY3]],
      ['c', 'separate', ['x']],
    ]);
    expect(planSummary(plan.steps)).toBe('3 steps, 4 sessions');
    expect(planSummary(plan.steps.slice(0, 1))).toBe('1 step, 2 sessions');
    // A one-stream Joint step is Separate; a stream moves to its new step.
    plan = addSteps(plan, 'cala', 'joint', [DAY2], order);
    expect(plan.steps.map((s) => [s.id, s.kind, s.streams])).toEqual([
      ['a', 'separate', [DAY1]],
      ['b', 'separate', [DAY3]],
      ['c', 'separate', ['x']],
      ['d', 'separate', [DAY2]],
    ]);
    expect(addSteps(plan, 'cala', 'joint', [], order)).toBe(plan);
  });

  it('runs steps in turn: started, finished (leaves), stopped (stays)', () => {
    let plan = addSteps(empty, 'cala', 'separate', order, order);
    plan = stepStarted(plan, 'a', 'r1');
    expect(runnableSteps(plan).map((s) => s.id)).toEqual(['b', 'c']);
    // A running step is not changed by an edit.
    expect(addSteps(plan, 'cala', 'joint', [DAY1, DAY2], order).steps[0]).toMatchObject({
      id: 'a',
      status: 'running',
    });
    plan = stepFinished(plan, 'a');
    plan = stepStopped(stepStarted(plan, 'b', 'r2'), 'b');
    expect(plan.steps.map((s) => [s.id, s.status, s.runs])).toEqual([
      ['b', 'stopped', ['r2']],
      ['c', 'pending', []],
    ]);
    expect(moveStep(plan, 'c', 0).steps.map((s) => s.id)).toEqual(['c', 'b']);
    expect(moveStep(plan, 'z', 0)).toBe(plan);
    expect(removeStep(plan, 'b').steps.map((s) => s.id)).toEqual(['c']);
    expect(afterStep(3, 0, { finished: true })).toEqual({ kind: 'running', step: 1 });
    expect(afterStep(3, 2, { finished: true })).toEqual({ kind: 'done' });
    expect(afterStep(3, 1, { stopped: 'cancelled' })).toEqual({
      kind: 'stopped',
      step: 1,
      reason: 'cancelled',
    });
  });

  it('names steps a..z, then aa', () => {
    const ids = Array.from({ length: 26 }, (_, i) => ({ id: String.fromCharCode(97 + i) }));
    expect(nextStepId(ids)).toBe('aa');
    expect(nextStepId([...ids, { id: 'aa' }])).toBe('ab');
  });
});

describe('links', () => {
  it('turn a pointer to an earlier step into that step run', () => {
    const runs = new Map([['a', 'r1']]);
    expect(resolveStepLink({ role: 'library', step: 'a', stream: DAY1 }, runs)).toEqual({
      role: 'library',
      run: 'r1',
      stream: DAY1,
    });
    expect(resolveStepLink({ role: 'seed', run: 'r0' }, runs)).toEqual({
      role: 'seed',
      run: 'r0',
      stream: null,
    });
    expect(() => resolveStepLink({ role: 'seed', step: 'b' }, runs)).toThrow(/has not run yet/);
    expect(() => resolveStepLink({ role: 'seed' }, runs)).toThrow(/names no run/);
  });
});

describe('app params', () => {
  it('migrates a project default block through the app hook', () => {
    registerApp({
      app: 'demo',
      paramsVersion: 2,
      schemaName: 'demo-params',
      schema: { type: 'object', properties: {} } as never,
      migrate: (p, from) => ({ ...(p as object), migratedFrom: from }),
    });
    expect(appParams('demo').schemaName).toBe('demo-params');
    const p = threeSessionProject();
    expect(projectDefaults(p, 'demo')).toEqual({});
    expect(
      projectDefaults(
        { ...p, defaults: { demo: { params_version: 1, params: { a: 1 } } } },
        'demo',
      ),
    ).toEqual({ a: 1, migratedFrom: 1 });
    expect(
      projectDefaults(
        { ...p, defaults: { demo: { params_version: 2, params: { a: 1 } } } },
        'demo',
      ),
    ).toEqual({ a: 1 });
    expect(() =>
      projectDefaults({ ...p, defaults: { demo: { params_version: 3, params: {} } } }, 'demo'),
    ).toThrow(/newer/);
    expect(() => appParams('nope')).toThrow(/No params are registered/);
  });
});

describe('folder IO', () => {
  it('writes checked files whole and reads the tree back', async () => {
    const root = new MemDir('calab-project');
    await writeProjectDoc(root, 'project', threeSessionProject());
    const run = calaRun('r1_cala', [DAY1], '2026-11-28T09:14:03.000Z');
    const runDir = await (
      await root.getDirectoryHandle('runs', { create: true })
    ).getDirectoryHandle('r1_cala', { create: true });
    await writeProjectDoc(runDir, 'run', run);
    await root.put(`runs/r1_cala/${DAY1}/cala-export.npz`, 'npz');
    const files = await readTree(root, (n) => n.endsWith('.json'));
    expect(files.map((f) => f.path)).toEqual(['calab-project.json', 'runs/r1_cala/calab-run.json']);
    expect(readProjectFile(files[0].text).ok).toBe(true);
    expect(findRunFiles(files).runs[0].run).toEqual(run);
  });

  it('aborts a write that fails, leaving the old file', async () => {
    const root = new MemDir('p');
    await root.put('calab-project.json', 'old');
    await expect(writeProjectDoc(root, 'project', { bad: 1 } as never)).rejects.toThrow(/Refusing/);
    expect(root.files.get('calab-project.json')).toBe('old');
    const failing = {
      name: 'f',
      keys: root.keys.bind(root),
      getDirectoryHandle: root.getDirectoryHandle.bind(root),
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => {
            throw new Error('disk full');
          },
          close: async () => {},
          abort: async () => {
            root.aborts.push('calab-project.json');
          },
        }),
      }),
    };
    await expect(writeProjectDoc(failing, 'project', threeSessionProject())).rejects.toThrow(
      'disk full',
    );
    expect(root.aborts).toEqual(['calab-project.json']);
  });
});
