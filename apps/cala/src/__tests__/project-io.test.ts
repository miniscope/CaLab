import { describe, expect, it } from 'vitest';
import { addGroup, afterGroup, moveGroup, removeGroup, planSummary } from '../lib/run-plan.ts';
import {
  projectRunSink,
  readResultsFiles,
  resultsFilesFromEntries,
  writeIndex,
} from '../lib/project-io.ts';
import { emptyIndex, parseIndex } from '../lib/project-index.ts';
import { createMemoryRecentStore, MAX_RECENT, rememberProject } from '../lib/recent-projects.ts';
import { MemDir } from './mem-dir.ts';

describe('run plan', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('builds a mixed plan: a chain, separate runs, another chain', () => {
    let plan = addGroup([], 'joint', ['c', 'a', 'b'], order);
    plan = addGroup(plan, 'separate', ['d', 'e'], order);
    plan = addGroup(plan, 'joint', ['f'], order);
    expect(plan).toEqual([
      { kind: 'joint', sessions: ['a', 'b', 'c'] },
      { kind: 'separate', sessions: ['d', 'e'] },
      // A one-session chain is a Separate run.
      { kind: 'separate', sessions: ['f'] },
    ]);
    expect(planSummary(plan)).toBe('3 groups, 6 sessions');
  });

  it('moves a session to its new group; empty groups go', () => {
    let plan = addGroup([], 'joint', ['a', 'b'], order);
    plan = addGroup(plan, 'separate', ['c'], order);
    plan = addGroup(plan, 'joint', ['b', 'c'], order);
    expect(plan).toEqual([
      { kind: 'separate', sessions: ['a'] },
      { kind: 'joint', sessions: ['b', 'c'] },
    ]);
  });

  it('removes and moves groups', () => {
    const plan = addGroup(addGroup([], 'joint', ['a', 'b'], order), 'separate', ['c'], order);
    expect(removeGroup(plan, 0)).toEqual([{ kind: 'separate', sessions: ['c'] }]);
    expect(moveGroup(plan, 1, 0).map((g) => g.kind)).toEqual(['separate', 'joint']);
  });

  it('runs groups in turn and stops on a stopped group', () => {
    expect(afterGroup(3, 0, { finished: true })).toEqual({ kind: 'running', group: 1 });
    expect(afterGroup(3, 2, { finished: true })).toEqual({ kind: 'done' });
    expect(afterGroup(3, 1, { stopped: 'Extract was cancelled.' })).toEqual({
      kind: 'stopped',
      group: 1,
      reason: 'Extract was cancelled.',
    });
  });
});

describe('project files', () => {
  it('reads the index and run files under a results folder, not the exports', async () => {
    const dir = new MemDir('cala-results');
    await dir.put('cala-project.json', '{}');
    await dir.put('cala-run.json', '{"a":1}');
    await dir.put('d/s/cala-session.json', '{"b":2}');
    await dir.put('d/s/cala-export.npz', 'binary');
    await dir.put('runs/r1/cala-run.json', '{}');
    const files = await readResultsFiles(dir);
    expect(files.map((f) => f.path)).toEqual([
      'cala-project.json',
      'cala-run.json',
      'd/s/cala-session.json',
      'runs/r1/cala-run.json',
    ]);
    expect(files[2].text).toBe('{"b":2}');
  });

  it('reads them from the files of a picked folder', async () => {
    const f = (path: string, text: string) => ({
      file: new File([text], path.split('/').pop()!),
      relPath: path,
    });
    const files = await resultsFilesFromEntries(
      [
        f('mouse1/cala-results/cala-run.json', '{}'),
        f('mouse1/cala-results/a/cala-session.json', '{}'),
        f('mouse1/a/0.avi', ''),
        f('mouse1/a/metaData.json', '{}'),
      ],
      'mouse1',
    );
    expect(files.map((x) => x.path)).toEqual(['a/cala-session.json', 'cala-run.json']);
  });

  it('writes the index whole, keeping a corrupt one beside it first', async () => {
    const dir = new MemDir('cala-results');
    const idx = emptyIndex('mouse1', { kind: 'default', label: 'mouse1/cala-results' }, new Date());
    await writeIndex(dir, idx, { text: '{broken', stamp: 'T' });
    expect(dir.writes).toEqual(['cala-project.corrupt-T.json', 'cala-project.json']);
    expect(dir.files.get('cala-project.corrupt-T.json')).toBe('{broken');
    const back = parseIndex(dir.files.get('cala-project.json')!);
    expect(back.ok && back.index).toEqual(idx);
  });

  it('makes a new run folder, never reusing one', async () => {
    const dir = new MemDir('cala-results');
    await dir.put('runs/r1/cala-run.json', 'old');
    const { sink, folder } = await projectRunSink(dir, 'r1', 'mouse1/cala-results');
    expect(folder).toBe('runs/r1_2');
    expect(sink.root).toBe('mouse1/cala-results/runs/r1_2');
    await sink.writeText('a/cala-session.json', '{}');
    expect(dir.dirs.get('runs')!.dirs.get('r1')!.files.get('cala-run.json')).toBe('old');
    expect(
      dir.dirs.get('runs')!.dirs.get('r1_2')!.dirs.get('a')!.files.get('cala-session.json'),
    ).toBe('{}');
  });
});

describe('recent projects', () => {
  const handle = (name: string, id = name) => ({
    name,
    isSameEntry: async (o: unknown) => (o as { id?: string }).id === id,
    id,
  });

  it('keeps the most recent first and refreshes a project opened again', async () => {
    const store = createMemoryRecentStore();
    const a = handle('mouse1', 'A');
    await rememberProject(store, a, null, new Date('2026-11-13T10:00:00Z'));
    await rememberProject(store, handle('mouse2', 'B'), null, new Date('2026-11-13T11:00:00Z'));
    await rememberProject(store, handle('mouse1', 'A'), null, new Date('2026-11-13T12:00:00Z'));
    const list = await store.list();
    expect(list.map((r) => r.name)).toEqual(['mouse1', 'mouse2']);
  });

  it('two folders with the same name stay two projects', async () => {
    const store = createMemoryRecentStore();
    await rememberProject(store, handle('mouse1', 'A'), null, new Date(1));
    await rememberProject(store, handle('mouse1', 'B'), null, new Date(2));
    expect(await store.list()).toHaveLength(2);
  });

  it('keeps at most MAX_RECENT', async () => {
    const store = createMemoryRecentStore();
    for (let i = 0; i < MAX_RECENT + 3; i++)
      await rememberProject(store, handle(`m${i}`), null, new Date(1000 * i));
    const list = await store.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].name).toBe(`m${MAX_RECENT + 2}`);
  });
});
