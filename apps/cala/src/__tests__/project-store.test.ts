import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import {
  fileText,
  readIndexFile,
  readProjectFile,
  type IndexFile,
  type ProjectFile,
} from '@calab/project';
import { createProjectStore } from '../lib/project-store.ts';
import type { MultiRun, MultiRunPlan, OpenedRun } from '../lib/multi-run.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import { entriesFromFiles } from '../lib/frame-source.ts';
import { discoverSessions } from '../lib/sessions.ts';
import { calaRunFile } from '../lib/run-file.ts';
import type { ReadDirLike } from '../lib/project-io.ts';
import { makeFile } from './synth-avi.ts';
import { MemDir } from './mem-dir.ts';

/**
 * The project store: the project file and the index of `<animal>/calab-project/`, the plan and
 * its steps (one run each), and what is refused. The multi-session runner is a fake that only
 * records its plans; the test plays each run's progress through the plan's callbacks.
 */
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

function animal(extra: File[] = []) {
  const files = DAYS.flatMap((d, i) => [
    makeFile('0.avi', new Uint8Array(4), `mouse1/${d}/09_00_00/My_V4_Miniscope`),
    makeFile(
      'metaData.json',
      JSON.stringify({ recordingStartTime: { msecSinceEpoch: Date.UTC(2026, 10, 10 + i, 9) } }),
      `mouse1/${d}/09_00_00`,
    ),
  ]);
  const entries = entriesFromFiles([...files, ...extra]);
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

/** A folder handle that has (or has not) been granted `readwrite`. */
function animalDir(granted: boolean): MemDir {
  const root = new MemDir('mouse1');
  const state = () => (granted ? 'granted' : 'prompt');
  Object.assign(root, {
    queryPermission: async () => state(),
    requestPermission: async () => state(),
  });
  return root;
}

async function setup(o: { granted?: boolean; prepare?: (root: MemDir) => Promise<void> } = {}) {
  const fake = fakeRunner();
  const root = animalDir(o.granted ?? true);
  await o.prepare?.(root);
  const { entries, sessions } = animal();
  let t = Date.UTC(2026, 10, 28, 12);
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

const projectDir = (root: MemDir) => root.dirs.get('calab-project');
const savedProject = (root: MemDir): ProjectFile => {
  const r = readProjectFile(projectDir(root)!.files.get('calab-project.json')!);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const savedIndex = (root: MemDir): IndexFile => {
  const r = readIndexFile(projectDir(root)!.files.get('calab-index.json')!);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** The run file of plan `p`'s run, as the multi-session runner writes it. */
function runDoc(p: MultiRunPlan, run: OpenedRun, status: 'planned' | 'running' | 'finished') {
  return calaRunFile({
    id: run.id,
    project: run.project,
    plan: p.planRef?.(0) ?? null,
    status,
    stopped: null,
    created: '2026-11-28T12:00:00.000Z',
    updated: '2026-11-28T12:00:00.000Z',
    version: 'test',
    joint: p.kind === 'joint',
    record: { stages: [{ stage: 'discover', outcome: 'done' }] },
    sessions: p.sessions.map((s, index) => ({
      stream: s.stream,
      info: s.info,
      record: {
        index,
        name: s.candidate.name,
        dir: s.candidate.dir,
        resultsPath: s.resultsPath,
        startFrame: index * 800,
        frames: 800,
        fps: 20,
        recordingStartMs: s.startMs,
        status: status === 'planned' ? 'pending' : 'written',
      },
      ...(status === 'planned'
        ? {}
        : { written: { cells: 3, libraryVersion: 2, created: '2026-11-28T12:05:00.000Z' } }),
    })),
  });
}

describe('project store', () => {
  it('opens an animal: every session in the table, nothing run yet, files written at once', async () => {
    const { store, root } = await setup();
    expect(store.tableRows().map((r) => r.session.id)).toEqual(ids);
    expect(store.tableRows()[0].session).toMatchObject({ frames: 800, fps: 20, missing: false });
    expect(store.tableRows().every((r) => r.status.current === null)).toBe(true);
    expect(store.location()).toEqual({ kind: 'default', label: 'mouse1/calab-project' });
    // A reopened folder (readwrite granted) is saved at once.
    expect(store.dirty()).toBe(false);
    const p = savedProject(root);
    expect(p.project.name).toBe('mouse1');
    expect(p.sessions.map((s) => s.id)).toEqual(ids.map((x) => x.split('/').slice(0, 2).join('/')));
    expect(savedIndex(root).streams.map((s) => s.ref)).toEqual(ids);
  });

  it('without readwrite nothing is written until a change asks for it', async () => {
    const { store, root } = await setup({ granted: false });
    expect(store.dirty()).toBe(true);
    expect(projectDir(root)).toBeUndefined();
    store.toggle(ids[0], true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(store.plan()).toHaveLength(1));
    expect(projectDir(root)).toBeUndefined();
    expect(store.dirty()).toBe(true);
  });

  it('persists the plan on every edit: add, move, remove, clear', async () => {
    const { store, root } = await setup();
    store.toggle(ids[0], true);
    store.toggle(ids[1], true);
    store.addToPlan('joint');
    expect(store.selected().size).toBe(0);
    await vi.waitFor(() => expect(savedProject(root).plan.steps).toHaveLength(1));
    store.toggle(ids[2], true);
    store.addToPlan('separate');
    await vi.waitFor(() =>
      expect(savedProject(root).plan.steps.map((s) => [s.id, s.kind, s.streams])).toEqual([
        ['a', 'joint', [ids[0], ids[1]]],
        ['b', 'separate', [ids[2]]],
      ]),
    );
    store.moveGroup(1, 0);
    await vi.waitFor(() =>
      expect(savedProject(root).plan.steps.map((s) => s.id)).toEqual(['b', 'a']),
    );
    store.removeGroup(0);
    await vi.waitFor(() => expect(savedProject(root).plan.steps.map((s) => s.id)).toEqual(['a']));
    store.clearPlan();
    await vi.waitFor(() => expect(savedProject(root).plan.steps).toEqual([]));
    // Nothing selected, or a stream not in the table: no step.
    store.addToPlan('joint');
    store.replanSeparate(['gone/x']);
    // A failed Joint boundary re-plans its sessions as Separate steps, one each.
    store.replanSeparate([ids[0], ids[1]]);
    await vi.waitFor(() =>
      expect(savedProject(root).plan.steps.map((s) => [s.kind, s.streams])).toEqual([
        ['separate', [ids[0]]],
        ['separate', [ids[1]]],
      ]),
    );
  });

  it('runs a Joint step then Separate steps, one run each; the plan is on disk before the first', async () => {
    const { store, fake, root } = await setup();
    store.toggle(ids[0], true);
    store.toggle(ids[1], true);
    store.addToPlan('joint');
    store.toggle(ids[2], true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(savedProject(root).plan.steps).toHaveLength(2));
    expect(store.planErrors()).toEqual([]);
    expect(await store.startPlan()).toBe(true);
    // Written before the first step ran, with a plan id.
    const before = savedProject(root);
    expect(before.plan.id).toMatch(/^\d{4}-\d{2}-\d{2}_/);
    expect(before.plan.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(fake.plans).toHaveLength(1);
    const g1 = fake.plans[0];
    expect(g1.kind).toBe('joint');
    expect(g1.sessions.map((s) => s.stream)).toEqual([ids[0], ids[1]]);
    expect(g1.planRef!(0)).toEqual({ id: before.plan.id, step: 'a', kind: 'joint' });
    const run1 = await g1.openRun(0);
    expect(run1.id).toMatch(/_cala$/);
    expect(run1.folder).toBe(`runs/${run1.id}`);
    expect(run1.project).toBe(before.project.id);
    expect(run1.sink.root).toBe(`mouse1/calab-project/runs/${run1.id}`);
    // Planned: the step is running with its run; the index holds the run.
    await g1.onProgress!({
      run: runDoc(g1, run1, 'planned'),
      folder: run1.folder,
      sink: run1.sink,
    });
    expect(savedProject(root).plan.steps[0]).toMatchObject({ status: 'running', runs: [run1.id] });
    expect(savedIndex(root).runs.map((r) => [r.id, r.status])).toEqual([[run1.id, 'planned']]);
    await g1.onProgress!({
      run: runDoc(g1, run1, 'running'),
      folder: run1.folder,
      sink: run1.sink,
    });
    expect(savedProject(root).plan.steps[0].runs).toEqual([run1.id]);
    // Written: both sessions current, one id space.
    const idx = savedIndex(root);
    expect(idx.results.map((r) => [r.stream, r.id_space])).toEqual([
      [ids[0], `cala:${run1.id}`],
      [ids[1], `cala:${run1.id}`],
    ]);
    expect(store.tableRows()[0].status).toMatchObject({ discover: 'done', run: run1.id });
    expect(store.idGroups().get(ids[0])?.label).toBe('A');
    // Finished: the step leaves the plan; the next step starts.
    await g1.onProgress!({
      run: runDoc(g1, run1, 'finished'),
      folder: run1.folder,
      sink: run1.sink,
    });
    expect(savedProject(root).plan.steps.map((s) => s.id)).toEqual(['b']);
    fake.setFinished(true);
    await vi.waitFor(() => expect(fake.plans).toHaveLength(2));
    expect(store.planState()).toEqual({ kind: 'running', step: 1 });
    const g2 = fake.plans[1];
    expect(g2.kind).toBe('separate');
    expect(g2.planRef!(0)).toMatchObject({ step: 'b', kind: 'separate' });
    const run2 = await g2.openRun(0);
    expect(run2.id).not.toBe(run1.id);
    await g2.onProgress!({
      run: runDoc(g2, run2, 'planned'),
      folder: run2.folder,
      sink: run2.sink,
    });
    // It stops: what was written stays, the step stays in the plan, marked stopped.
    fake.setStopped('Extract was cancelled.');
    await vi.waitFor(() => expect(store.planState()).toMatchObject({ kind: 'stopped', step: 1 }));
    await g2.onProgress!({
      run: {
        ...runDoc(g2, run2, 'planned'),
        run: { ...runDoc(g2, run2, 'planned').run, status: 'stopped' },
      },
      folder: run2.folder,
      sink: run2.sink,
    });
    expect(savedProject(root).plan.steps).toMatchObject([{ id: 'b', status: 'stopped' }]);
    expect(savedIndex(root).results).toHaveLength(2);
    expect(store.running()?.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('a Separate plan of several sessions is a step and a run per session', async () => {
    const { store, fake } = await setup();
    store.selectAll(true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(store.plan()).toHaveLength(3));
    expect(store.plan().map((s) => s.streams)).toEqual(ids.map((x) => [x]));
    expect(await store.startPlan()).toBe(true);
    for (let k = 0; k < 3; k++) {
      await vi.waitFor(() => expect(fake.plans).toHaveLength(k + 1));
      expect(fake.plans[k].sessions.map((s) => s.stream)).toEqual([ids[k]]);
      fake.setFinished(true);
    }
    await vi.waitFor(() => expect(store.planState()).toEqual({ kind: 'done' }));
    store.selectAll(false);
    expect(store.selected().size).toBe(0);
  });

  it('sets a current result by hand and saves it', async () => {
    const { store, fake, root } = await setup();
    store.toggle(ids[0], true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(store.plan()).toHaveLength(1));
    const runIds: string[] = [];
    for (let k = 0; k < 2; k++) {
      if (k > 0) {
        store.toggle(ids[0], true);
        store.addToPlan('separate');
        await vi.waitFor(() => expect(store.plan()).toHaveLength(1));
      }
      await store.startPlan();
      const g = fake.plans[k];
      const run = await g.openRun(0);
      runIds.push(run.id);
      const doc = runDoc(g, run, 'finished');
      doc.run.created = doc.results[0].created = `2026-11-2${k}T00:00:00.000Z`;
      // As the runner does: the run file goes to its folder, then the project is told.
      await run.sink.writeText('calab-run.json', fileText('run', doc));
      await g.onProgress!({ run: doc, folder: run.folder, sink: run.sink });
      fake.setFinished(true);
      await vi.waitFor(() => expect(store.planState()).toEqual({ kind: 'done' }));
    }
    expect(store.tableRows()[0].status.current?.run).toBe(runIds[1]);
    await store.setCurrent(ids[0], runIds[0]);
    expect(store.tableRows()[0].status.current?.run).toBe(runIds[0]);
    expect(savedProject(root).current).toEqual({ cala: { [ids[0]]: runIds[0] } });
    // Read back from disk, the pick holds.
    await store.refresh();
    expect(store.tableRows()[0].status.current?.run).toBe(runIds[0]);
  });

  it('refuses an unreadable project file: shown read-only, never written over, nothing runs', async () => {
    const bad = '{"format":"calab-project", trunc';
    const { store, root } = await setup({
      prepare: (r) => r.put('calab-project/calab-project.json', bad),
    });
    expect(store.readOnly()).toBe(true);
    expect(store.warnings().join(' ')).toContain('could not be read');
    store.toggle(ids[0], true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(store.plan()).toHaveLength(1));
    expect(store.planErrors()[0]).toContain('could not be read');
    expect(await store.startPlan()).toBe(false);
    await store.setCurrent(ids[0], 'x');
    expect(projectDir(root)!.files.get('calab-project.json')).toBe(bad);
    // The index is still kept in line.
    expect(projectDir(root)!.files.has('calab-index.json')).toBe(true);
  });

  it('refuses a newer project file the same way', async () => {
    const text = JSON.stringify({ format: 'calab-project', version: 99 });
    const { store, root } = await setup({
      prepare: (r) => r.put('calab-project/calab-project.json', text),
    });
    expect(store.readOnly()).toBe(true);
    expect(store.warnings().join(' ')).toMatch(/newer/);
    expect(projectDir(root)!.files.get('calab-project.json')).toBe(text);
  });

  it('warns about an old cala-results/ tree and old files, and reads neither', async () => {
    const { store } = await setup({
      prepare: async (r) => {
        await r.put('cala-results/cala-project.json', '{}');
        await r.put('calab-project/runs/old/cala-run.json', '{"format":"cala-run"}');
        await r.put('calab-project/runs/bad/calab-run.json', '{"format":"calab-run"}');
      },
    });
    const w = store.warnings().join('\n');
    expect(w).toContain('mouse1/cala-results/ was made by an older cala');
    expect(w).toContain('runs/old/cala-run.json');
    expect(w).toContain('runs/bad/calab-run.json');
    expect(store.index()!.runs).toEqual([]);
  });

  it('reads a picked folder without the File System Access API, and runs go to zips', async () => {
    const fake = fakeRunner();
    const { entries, sessions } = animal([
      makeFile('calab-project.json', 'not json', 'mouse1/calab-project'),
    ]);
    const store = createRoot(() =>
      createProjectStore({
        probe: async (s) => s.map(() => ({ info: INFO })),
        multiRun: fake.runner,
        version: 'test',
      }),
    );
    await store.open({ rootName: 'mouse1', entries, handle: null, sessions });
    expect(store.canWrite()).toBe(false);
    expect(store.readOnly()).toBe(true);
    await expect(store.resultFile({ export_path: 'runs/x/a.npz' })).rejects.toThrow(
      'pick the animal folder again',
    );
    expect(await store.grant()).toBe(true);
  });

  it('a probe failure shows on every row and keeps the step from starting', async () => {
    const fake = fakeRunner();
    const { entries, sessions } = animal();
    const store = createRoot(() =>
      createProjectStore({
        probe: async () => {
          throw new Error('no decoder');
        },
        multiRun: fake.runner,
        version: 'test',
      }),
    );
    await store.open({ rootName: 'mouse1', entries, handle: null, sessions });
    store.toggle(ids[0], true);
    store.addToPlan('separate');
    await vi.waitFor(() => expect(store.plan()).toHaveLength(1));
    expect(store.planErrors()).toEqual([`Step 1: ${ids[0]}: no decoder`]);
    store.close();
    expect(store.opened()).toBeNull();
    expect(store.tableRows()).toEqual([]);
  });
});

describe('one-session projects', () => {
  /** One recording folder: the videos and metaData.json directly in it. */
  function recording() {
    const files = [
      makeFile('0.avi', new Uint8Array(4), 'My_V4_Miniscope'),
      makeFile(
        'metaData.json',
        JSON.stringify({ recordingStartTime: { msecSinceEpoch: Date.UTC(2026, 10, 10, 9) } }),
        'My_V4_Miniscope',
      ),
    ];
    const entries = entriesFromFiles(files);
    return { entries, sessions: discoverSessions(entries).sessions! };
  }

  async function single(o: { root?: MemDir; live?: string } = {}) {
    const fake = fakeRunner();
    const root = o.root ?? animalDir(true);
    const { entries, sessions } = recording();
    const store = createRoot(() =>
      createProjectStore({
        probe: async (s) => s.map(() => ({ info: INFO })),
        multiRun: fake.runner,
        version: 'test',
        now: () => new Date('2026-11-28T12:00:00Z'),
      }),
    );
    await store.open(
      o.live
        ? { rootName: 'live stream', entries: [], handle: null, sessions: [], live: o.live }
        : {
            rootName: 'My_V4_Miniscope',
            entries,
            handle: root as unknown as ReadDirLike,
            sessions,
          },
    );
    return { store, fake, root };
  }

  it('a recording folder is a project of one session, its plan one Separate step', async () => {
    const { store, root } = await single();
    expect(store.single()?.planned).toMatchObject({ stream: '.', resultsPath: '.' });
    expect(store.plan().map((s) => [s.kind, s.streams])).toEqual([['separate', ['.']]]);
    const p = savedProject(root);
    expect(p.sessions).toMatchObject([{ id: '.', streams: [{ id: '.', role: 'miniscope' }] }]);
    expect(p.plan.steps).toHaveLength(1);
    expect(store.summary()).toEqual({ sessions: 1, live: false, existing: false });
  });

  it('Run starts that step: the plan is on disk first, results at the run folder root', async () => {
    const { store, fake, root } = await single();
    expect(await store.runStreams(['.'])).toBe(true);
    expect(fake.plans).toHaveLength(1);
    const plan = fake.plans[0];
    expect(plan.kind).toBe('separate');
    expect(plan.sessions.map((s) => [s.stream, s.resultsPath])).toEqual([['.', '.']]);
    expect(savedProject(root).plan.id).not.toBeNull();
    const run = await plan.openRun(0);
    expect(run.folder).toMatch(/^runs\/2026-11-28_\d\d-00-00_cala$/);
    await plan.onProgress!({
      run: runDoc(plan, run, 'planned'),
      folder: run.folder,
      sink: run.sink,
    });
    expect(savedIndex(root).runs.map((r) => r.id)).toEqual([run.id]);
  });

  it('reopening keeps the pending step; a run after the last makes a new step', async () => {
    const first = await single();
    const again = await single({ root: first.root });
    expect(again.store.summary()?.existing).toBe(true);
    expect(again.store.plan()).toHaveLength(1);
    expect(again.store.plan()[0].id).toBe(first.store.plan()[0].id);
    // The step ran and finished: it left the plan; Restart runs the stream again as a new step.
    await again.store.runStreams(['.']);
    const plan = again.fake.plans[0];
    const run = await plan.openRun(0);
    await plan.onProgress!({
      run: runDoc(plan, run, 'finished'),
      folder: run.folder,
      sink: run.sink,
    });
    expect(again.store.plan()).toEqual([]);
    expect(await again.store.runStreams(['.'])).toBe(true);
    expect(again.fake.plans).toHaveLength(2);
    expect(again.store.plan()).toHaveLength(1);
  });

  it('a declined permission still runs: into a zip, the folder left as it was', async () => {
    const root = animalDir(false);
    const { store, fake } = await single({ root });
    expect(store.canWrite()).toBe(true);
    expect(await store.runStreams(['.'])).toBe(true);
    expect(store.declined()).toBe(true);
    expect(store.canWrite()).toBe(false);
    const run = await fake.plans[0].openRun(0);
    expect(run.sink.method).toBe('zip');
    expect(projectDir(root)).toBeUndefined();
  });

  it('an unreadable project file: Run refuses, and the file is never written over', async () => {
    const root = animalDir(true);
    await root.put('calab-project/calab-project.json', '{bad');
    const { store, fake } = await single({ root });
    expect(store.readOnly()).toBe(true);
    expect(store.warnings()[0]).toContain('could not be read');
    expect(await store.runStreams(['.'])).toBe(false);
    expect(fake.plans).toHaveLength(0);
    expect(projectDir(root)!.files.get('calab-project.json')).toBe('{bad');
  });

  it('a live stream is a one-session project with a live stream and no folder: its run is a zip', async () => {
    const { store, fake } = await single({ live: 'ws://127.0.0.1:8765' });
    expect(store.single()?.planned).toMatchObject({ stream: '.', live: 'ws://127.0.0.1:8765' });
    expect(store.project()!.sessions[0].streams[0].role).toBe('live');
    expect(store.canWrite()).toBe(false);
    expect(store.summary()).toEqual({ sessions: 1, live: true, existing: false });
    expect(await store.runStreams(['.'])).toBe(true);
    const run = await fake.plans[0].openRun(0);
    expect(run.sink.method).toBe('zip');
    expect(run.project).toBe(store.project()!.project.id);
  });
});
