import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { createMultiRun, type PlannedSession } from '../lib/multi-run.ts';
import type { StageActivity, StageName, StageRun } from '../lib/run-stages.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { ResultsSink } from '../lib/session-export.ts';
import type { ExportInput } from '../lib/export.ts';

/**
 * The automatic multi-session run, driven by fake stage stores that finish
 * every stage a tick after it starts: which stages it asks for, for each mode
 * (Refine has been removed: every plan is Discover, then Extract.)
 */
const INFO = { frameCount: 100, fps: 20, sessions: undefined } as unknown as FrameSourceInfo;

function session(i: number): PlannedSession {
  return {
    candidate: { name: `s${i}`, dir: `s${i}`, entries: [] } as never,
    info: INFO,
    error: null,
    startMs: i,
    resultsPath: `s${i}`,
    stream: `day${i}/scope`,
  };
}

/** A results sink that discards everything, but for what `over` replaces. */
const sinkWith = (over: Partial<ResultsSink> = {}): ResultsSink =>
  ({
    root: 'r',
    writeFile: async () => {},
    writeText: async () => {},
    finish: async () => {},
    ...over,
  }) as unknown as ResultsSink;

const sink = sinkWith();

function harness(
  mode: 'joint' | 'separate',
  n = 3,
  opts: {
    sink?: (run: number) => ResultsSink;
    runRecord?: (kind: string, sessionIndex?: number) => Record<string, unknown>;
    /**
     * As the app does: a new Discover leaves the Extract store as it was (its last outcome
     * stays until Extract runs again), and a session takes a while to open.
     */
    appLike?: boolean;
    /** Extract is refused before it starts: `error`, with no stage log entry (as the app's). */
    extractRefused?: boolean;
  } = {},
) {
  const [discover, setDiscover] = createSignal<StageActivity>('idle');
  const [extract, setExtract] = createSignal<StageActivity>('idle');
  const [runs, setRuns] = createSignal<readonly StageRun[]>([]);
  const order: StageName[] = [];
  const begin = (stage: StageName, set: (a: StageActivity) => void) => {
    order.push(stage);
    set('running');
    setRuns([
      ...runs(),
      {
        stage,
        index: runs().filter((r) => r.stage === stage).length + 1,
        startedAt: 'a',
        endedAt: null,
        outcome: 'running',
        frames: 100,
        cells: 3,
        libraryVersion: 1,
      },
    ]);
    setTimeout(() => {
      set('done');
      setRuns(runs().map((r) => (r.outcome === 'running' ? { ...r, outcome: 'done' } : r)));
    }, 0);
  };
  const startDiscover = () => {
    // A new Discover starts the stage log over, as the app does.
    setRuns([]);
    if (!opts.appLike) setExtract('idle');
    begin('discover', setDiscover);
  };
  const availability = (): Record<StageName, string | null> => {
    const busy = [discover(), extract()].includes('running');
    const why = busy ? 'busy' : discover() !== 'done' ? 'after Discover' : null;
    return { discover: null, extract: why };
  };
  let multi!: ReturnType<typeof createMultiRun>;
  const dispose = createRoot((d) => {
    multi = createMultiRun({
      // As the pipeline does: the run file before the first frame, then Discover.
      openJoint: async () => {
        await multi.beforeFrames();
        startDiscover();
      },
      openOne: async () => {
        if (opts.appLike) await new Promise((r) => setTimeout(r, 5));
        await multi.beforeFrames();
        startDiscover();
      },
      stages: () => ({
        discover: discover(),
        extract: extract(),
        availability: availability(),
        runs: runs(),
      }),
      runExtract: () =>
        opts.extractRefused
          ? setTimeout(() => setExtract('error'), 0)
          : begin('extract', setExtract),
      exportInput: () =>
        ({
          result: { frames: 100, ids: new Uint32Array(3), version: 1 },
          fps: 20,
          qc: null,
        }) as unknown as ExportInput,
      info: () => INFO,
      ...(opts.runRecord ? { runRecord: opts.runRecord } : {}),
      version: 'test',
    });
    return d;
  });
  const done = async () => {
    await vi.waitFor(() => expect(multi.finished() || multi.stopped() !== null).toBe(true), {
      timeout: 2000,
    });
    return order;
  };
  const start = () =>
    multi.start({
      sessions: Array.from({ length: n }, (_, i) => session(i)),
      kind: mode,
      openRun: async (i: number) => ({
        id: `r${i}_cala`,
        sink: opts.sink?.(i) ?? sink,
        folder: `runs/r${i}_cala`,
        project: 'p-1',
      }),
      planRef: (i: number) => ({ id: 'plan', step: String.fromCharCode(97 + i), kind: mode }),
      locationLabel: '',
    });
  return { multi, start, done, dispose };
}

describe('multi-session run stages', () => {
  it.each([
    ['joint', ['discover', 'extract']],
    ['separate', ['discover', 'extract', 'discover', 'extract', 'discover', 'extract']],
  ] as const)('%s runs Discover then Extract, never a Refine', async (mode, expected) => {
    const h = harness(mode);
    await h.start();
    expect(await h.done()).toEqual(expected);
    expect(h.multi.stopped()).toBeNull();
    h.dispose();
  });
});

describe('run files', () => {
  /** Every text each run's sink got, in order, by run. */
  const recording = () => {
    const texts = new Map<number, { path: string; text: string }[]>();
    const sinkFor = (i: number) =>
      sinkWith({
        writeText: async (path: string, text: string) => {
          texts.set(i, [...(texts.get(i) ?? []), { path, text }]);
        },
      });
    const runFiles = (i: number) =>
      (texts.get(i) ?? [])
        .filter((t) => t.path === 'calab-run.json')
        .map((t) => JSON.parse(t.text));
    return { texts, sinkFor, runFiles };
  };
  const record = (kind: string, index?: number) => ({
    record_version: 2,
    software: { app_version: 'v9', git_commit: 'abc', engine_version: '1.0' },
    params: {
      fingerprint: 'sha256:x',
      values: { a: 1 },
      requested: { a: 1 },
      sources: { '/a': 'ui' },
      ignored: ['/b'],
      context: { fps: 20 },
    },
    stages: [{ stage: 'discover', outcome: 'done' }],
    input: { live: false },
    settings: { mode: kind, index: index ?? null },
  });

  it('a Joint run is one run: planned before its first frame, then running, then finished', async () => {
    const r = recording();
    const h = harness('joint', 2, { sink: r.sinkFor, runRecord: record });
    await h.start();
    await h.done();
    const files = r.runFiles(0);
    expect(files.map((f) => f.run.status)).toEqual(['planned', 'running', 'finished']);
    expect(r.texts.has(1)).toBe(false);
    const last = files[2];
    expect(last.run).toMatchObject({
      id: 'r0_cala',
      app: 'cala',
      app_version: 'v9',
      project: 'p-1',
      plan: { id: 'plan', step: 'a', kind: 'joint' },
    });
    expect(
      last.inputs.map((i: { stream: string; start_frame: number }) => [i.stream, i.start_frame]),
    ).toEqual([
      ['day0/scope', 0],
      ['day1/scope', 100],
    ]);
    // The record is folded in: params -> config, the rest -> record (no format string of its own).
    expect(last.config).toMatchObject({
      requested: { a: 1 },
      sources: { '/a': 'ui' },
      ignored: ['/b'],
      resolved: { a: 1 },
      fingerprint: 'sha256:x',
    });
    expect(last.record).toMatchObject({
      record_version: 2,
      settings: { mode: 'joint' },
      params: { context: { fps: 20 } },
    });
    expect(last.record.input).toBeUndefined();
    expect(
      last.results.map((x: { status: string; path: string; id_space: string }) => [
        x.status,
        x.path,
        x.id_space,
      ]),
    ).toEqual([
      ['written', 's0/cala-export.npz', 'cala:r0_cala'],
      ['written', 's1/cala-export.npz', 'cala:r0_cala'],
    ]);
    h.dispose();
  });

  it('a finished one-session run started again is a new run, written in full', async () => {
    const r = recording();
    const h = harness('separate', 1, { sink: r.sinkFor, runRecord: record, appLike: true });
    await h.start();
    await h.done();
    // Restart after the run ended: the same plan again, without leaving it first.
    await h.start();
    expect(h.multi.finished()).toBe(false);
    await h.done();
    expect(r.runFiles(0).map((f) => f.run.status)).toEqual([
      'planned',
      'running',
      'finished',
      'planned',
      'running',
      'finished',
    ]);
    h.dispose();
  });

  it('Separate sessions are one run each, with a run file of their own', async () => {
    const r = recording();
    const h = harness('separate', 2, { sink: r.sinkFor, runRecord: record });
    await h.start();
    await h.done();
    for (const i of [0, 1]) {
      const files = r.runFiles(i);
      expect(files.map((f) => f.run.status)).toEqual(['planned', 'running', 'finished']);
      expect(files[2].run.plan.step).toBe(String.fromCharCode(97 + i));
      expect(files[2].results).toHaveLength(1);
      expect(files[2].results[0]).toMatchObject({
        stream: `day${i}/scope`,
        id_space: `cala:r${i}_cala`,
        cells: 3,
      });
      expect(files[2].record.settings.index).toBe(i);
    }
    h.dispose();
  });

  it('hands each export the run file as it is when written', async () => {
    const got: unknown[] = [];
    const s = sinkWith({
      writeFile: async (
        _p: string,
        write: (b: { write: (c: Uint8Array) => Promise<void> }) => Promise<void>,
      ) => {
        await write({ write: async () => {} });
      },
    });
    const writeSpy = vi
      .spyOn(await import('../lib/export.ts'), 'writeCalaExport')
      .mockImplementation(async (input) => {
        got.push(input.runFile);
      });
    const h = harness('joint', 2, { sink: () => s, runRecord: record });
    await h.start();
    await h.done();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ format: 'calab-run', run: { status: 'running' } });
    writeSpy.mockRestore();
    h.dispose();
  });

  it('switching Separate sessions neither reuses the last Extract nor writes a run file twice', async () => {
    const r = recording();
    const h = harness('separate', 3, { sink: r.sinkFor, runRecord: record, appLike: true });
    await h.start();
    // Each session runs its own Extract, though the Extract store still says `done`.
    expect(await h.done()).toEqual([
      'discover',
      'extract',
      'discover',
      'extract',
      'discover',
      'extract',
    ]);
    for (const i of [0, 1, 2])
      expect(r.runFiles(i).map((f) => f.run.status)).toEqual(['planned', 'running', 'finished']);
    h.dispose();
  });

  it('an Extract refused before it starts stops the run, and its file says so', async () => {
    const r = recording();
    const h = harness('separate', 2, {
      sink: r.sinkFor,
      runRecord: record,
      appLike: true,
      extractRefused: true,
    });
    await h.start();
    await h.done();
    expect(h.multi.stopped()).toBe('Extract stopped with an error.');
    expect(r.runFiles(0).map((f) => f.run.status)).toEqual(['planned', 'stopped']);
    expect(r.texts.has(1)).toBe(false);
    h.dispose();
  });
});
