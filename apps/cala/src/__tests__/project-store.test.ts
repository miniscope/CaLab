import { describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createProjectStore } from '../lib/project-store.ts';
import type { MultiRun, MultiRunPlan } from '../lib/multi-run.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import { entriesFromFiles } from '../lib/frame-source.ts';
import { discoverSessions } from '../lib/sessions.ts';
import { parseIndex, type ProjectIndex } from '../lib/project-index.ts';
import type { SessionRecord } from '../lib/session-export.ts';
import type { ReadDirLike } from '../lib/project-io.ts';
import { makeFile } from './synth-avi.ts';
import { MemDir } from './mem-dir.ts';

const INFO: FrameSourceInfo = {
  frameCount: 800,
  width: 4,
  height: 3,
  bitDepth: 8,
  fourcc: 'GREY',
  bottomUp: true,
  fps: 20,
  fpsSource: 'timestamps',
  fpsFromMetadata: 20,
  fpsFromTimestamps: 20,
  aviDeclaredFps: null,
  timestampCount: 800,
  files: [{ name: '0.avi', frames: 800 }],
  ignoredFiles: [],
  warnings: [],
};

const DAYS = ['2026_11_10', '2026_11_11', '2026_11_12'];
const ids = DAYS.map((d) => `${d}/09_00_00/My_V4_Miniscope`);

function animal() {
  const files = DAYS.flatMap((d, i) => [
    makeFile('0.avi', new Uint8Array(4), `mouse1/${d}/09_00_00/My_V4_Miniscope`),
    makeFile(
      'metaData.json',
      JSON.stringify({ recordingStartTime: { msecSinceEpoch: Date.UTC(2026, 10, 10 + i, 9) } }),
      `mouse1/${d}/09_00_00`,
    ),
  ]);
  const entries = entriesFromFiles(files);
  return { entries, sessions: discoverSessions(entries).sessions! };
}

/** A multi-session runner that only records its plans; the test plays the run. */
function fakeRunner() {
  const [finished, setFinished] = createSignal(false);
  const [stopped, setStopped] = createSignal<string | null>(null);
  const plans: MultiRunPlan[] = [];
  const runner = {
    start: async (p: MultiRunPlan) => {
      plans.push(p);
      setFinished(false);
      setStopped(null);
    },
    finished,
    stopped,
  } as unknown as MultiRun;
  return { runner, plans, setFinished, setStopped };
}

const record = (dir: string, index: number, status: SessionRecord['status']): SessionRecord => ({
  index,
  name: dir,
  dir: `mouse1/${dir}`,
  resultsPath: dir,
  startFrame: 0,
  frames: 800,
  fps: 20,
  recordingStartMs: null,
  status,
});

async function setup() {
  const fake = fakeRunner();
  const root = new MemDir('mouse1');
  const { entries, sessions } = animal();
  let t = Date.UTC(2026, 10, 13, 12);
  const store = createRoot(() =>
    createProjectStore({
      probe: async (s) => s.map(() => ({ info: INFO })),
      multiRun: fake.runner,
      version: 'test',
      now: () => new Date((t += 1000)),
    }),
  );
  await store.open({
    rootName: 'mouse1',
    entries,
    handle: root as unknown as ReadDirLike,
    sessions,
  });
  return { store, fake, root };
}

const savedIndex = (root: MemDir): ProjectIndex => {
  const r = parseIndex(root.dirs.get('cala-results')!.files.get('cala-project.json')!);
  if (!r.ok) throw new Error(r.error);
  return r.index;
};

describe('project store', () => {
  it('opens an animal: every session in the table, nothing run yet', async () => {
    const { store } = await setup();
    expect(store.tableRows().map((r) => r.session.id)).toEqual(ids);
    expect(store.tableRows()[0].session).toMatchObject({ frames: 800, fps: 20, width: 4 });
    expect(store.tableRows().every((r) => r.status.current === null)).toBe(true);
    // Nothing written on open without readwrite permission: saved at the first change.
    expect(store.dirty()).toBe(true);
  });

  it('runs a mixed plan group by group and updates the index as sessions finish', async () => {
    const { store, fake, root } = await setup();
    store.toggle(ids[0], true);
    store.toggle(ids[1], true);
    store.addToPlan('joint');
    store.toggle(ids[2], true);
    store.addToPlan('separate');
    expect(store.plan().map((g) => [g.kind, g.sessions.length])).toEqual([
      ['joint', 2],
      ['separate', 1],
    ]);
    expect(await store.startPlan(1)).toBe(true);
    expect(fake.plans).toHaveLength(1);
    const g1 = fake.plans[0];
    expect(g1.settings).toEqual({ mode: 'joint', refineRuns: 1 });
    expect(g1.planInfo).toMatchObject({ group: 1, groups: 2 });
    const sink = await g1.openSink();
    expect(sink.root).toMatch(/^mouse1\/cala-results\/runs\//);
    const stages = [
      {
        stage: 'discover' as const,
        index: 1,
        startedAt: 'a',
        endedAt: 'b',
        outcome: 'done' as const,
        frames: 1600,
        cells: 3,
        libraryVersion: 2,
      },
    ];
    await g1.onProgress!({
      settings: g1.settings,
      records: [record(ids[0], 0, 'written'), record(ids[1], 1, 'written')],
      written: [0, 1],
      stages,
      stagesFor: [0, 1],
      cellIds: [1, 4, 9],
      libraryVersion: 2,
      root: sink.root,
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:10:00.000Z',
      finished: false,
      stopped: null,
    });
    // Written as soon as the results are: both sessions current, one id space.
    let idx = savedIndex(root);
    expect(idx.results.map((r) => [r.session, r.current])).toEqual([
      [ids[0], true],
      [ids[1], true],
    ]);
    expect(new Set(idx.results.map((r) => r.id_space)).size).toBe(1);
    expect(idx.runs[0].plan).toMatchObject({ group: 1, groups: 2 });
    expect(store.tableRows()[0].status.discover).toBe('done');
    // The group finishes: the next one starts.
    fake.setFinished(true);
    await Promise.resolve();
    expect(fake.plans).toHaveLength(2);
    expect(fake.plans[1].settings.mode).toBe('separate');
    expect(store.planState()).toEqual({ kind: 'running', group: 1 });
    // It stops: what was written stays, the group stays in the plan.
    fake.setStopped('Extract was cancelled.');
    await Promise.resolve();
    expect(store.planState()).toMatchObject({ kind: 'stopped', group: 1 });
    expect(store.plan().map((g) => g.sessions)).toEqual([[ids[2]]]);
    idx = savedIndex(root);
    expect(idx.results).toHaveLength(2);
  });

  it('sets a current result and saves it', async () => {
    const { store, root } = await setup();
    // Two earlier runs on disk (as #377 or another browser left them): the newer is current.
    const results = await root.getDirectoryHandle('cala-results', { create: true });
    for (const [run, created] of [
      ['r1', '2026-11-12T00:00:00.000Z'],
      ['r2', '2026-11-13T00:00:00.000Z'],
    ]) {
      await results.put(
        `runs/${run}/cala-run.json`,
        JSON.stringify({
          format: 'cala-run',
          created,
          mode: 'separate',
          sessions: [{ path: `mouse1/${ids[0]}`, results_path: ids[0], status: 'written' }],
        }),
      );
      await results.put(
        `runs/${run}/${ids[0]}/cala-session.json`,
        JSON.stringify({ format: 'cala-session', created, cells: 2, stages_run: [] }),
      );
    }
    await store.refresh();
    expect(store.tableRows()[0].status.current?.run).toBe('r2');
    expect(store.warnings().join(' ')).toContain('2 existing run folders');
    await store.setCurrent(ids[0], 'r1');
    expect(store.tableRows()[0].status.current?.run).toBe('r1');
    expect(savedIndex(root).results.find((r) => r.current)?.run).toBe('r1');
  });

  it('rebuilds a corrupt index, keeps the old file at the first save, and warns', async () => {
    const { store, root } = await setup();
    const results = await root.getDirectoryHandle('cala-results', { create: true });
    await results.put('cala-project.json', '{"format":"cala-project", trunc');
    await results.put(
      'runs/r1/cala-run.json',
      JSON.stringify({
        format: 'cala-run',
        created: '2026-11-12T00:00:00.000Z',
        mode: 'joint',
        sessions: [{ path: `mouse1/${ids[1]}`, results_path: ids[1], status: 'written' }],
      }),
    );
    await results.put(
      `runs/r1/${ids[1]}/cala-session.json`,
      JSON.stringify({ format: 'cala-session', created: '2026-11-12T00:00:00.000Z', cells: 5 }),
    );
    await store.refresh();
    expect(store.warnings().join(' ')).toContain('could not be read');
    expect(store.tableRows()[1].status.current?.run).toBe('r1');
    await store.setCurrent(ids[1], 'r1');
    const names = [...results.files.keys()];
    expect(names.filter((n) => n.startsWith('cala-project.corrupt-'))).toHaveLength(1);
    expect(savedIndex(root).runs.map((r) => r.id)).toEqual(['r1']);
  });

  it('a newer schema is shown but never overwritten', async () => {
    const { store, root } = await setup();
    const results = await root.getDirectoryHandle('cala-results', { create: true });
    const text = JSON.stringify({ format: 'cala-project', schema_version: 99 });
    await results.put('cala-project.json', text);
    await store.refresh();
    expect(store.readOnly()).toBe(true);
    expect(store.warnings().join(' ')).toContain('newer cala');
    expect(results.files.get('cala-project.json')).toBe(text);
  });
});
