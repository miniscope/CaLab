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
 * and Refine setting. (A lab report had plans going Discover to Extract with no
 * Refine; with the setting at 1 or more the plan must always Refine first.)
 */
const INFO = { frameCount: 100, fps: 20, sessions: undefined } as unknown as FrameSourceInfo;

function session(i: number): PlannedSession {
  return {
    candidate: { name: `s${i}`, dir: `s${i}`, entries: [] } as never,
    info: INFO,
    error: null,
    startMs: i,
    resultsPath: `s${i}`,
  };
}

const sink: ResultsSink = {
  root: 'r',
  writeFile: async () => {},
  writeText: async () => {},
  finish: async () => {},
} as unknown as ResultsSink;

function harness(
  mode: 'joint' | 'separate',
  refineRuns: number,
  n = 3,
  opts: {
    sink?: ResultsSink;
    runRecord?: (
      s: { mode: string; refineRuns: number },
      sessionIndex?: number,
    ) => Record<string, unknown>;
  } = {},
) {
  const [discover, setDiscover] = createSignal<StageActivity>('idle');
  const [refine, setRefine] = createSignal<StageActivity>('idle');
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
    setRefine('idle');
    setExtract('idle');
    begin('discover', setDiscover);
  };
  const availability = (): Record<StageName, string | null> => {
    const busy = [discover(), refine(), extract()].includes('running');
    const why = busy ? 'busy' : discover() !== 'done' ? 'after Discover' : null;
    return { discover: null, refine: why, extract: why };
  };
  let multi!: ReturnType<typeof createMultiRun>;
  const dispose = createRoot((d) => {
    multi = createMultiRun({
      openJoint: async () => startDiscover(),
      openOne: async () => startDiscover(),
      stages: () => ({
        discover: discover(),
        refine: refine(),
        extract: extract(),
        availability: availability(),
        runs: runs(),
      }),
      runRefine: () => begin('refine', setRefine),
      runExtract: () => begin('extract', setExtract),
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
      settings: { mode, refineRuns },
      openSink: async () => opts.sink ?? sink,
      locationLabel: '',
    });
  return { multi, start, done, dispose };
}

describe('multi-session run stages', () => {
  it.each([
    ['joint', 1, ['discover', 'refine', 'extract']],
    ['joint', 2, ['discover', 'refine', 'refine', 'extract']],
    ['joint', 0, ['discover', 'extract']],
    [
      'separate',
      1,
      [
        'discover',
        'refine',
        'extract',
        'discover',
        'refine',
        'extract',
        'discover',
        'refine',
        'extract',
      ],
    ],
    [
      'separate',
      2,
      [
        ...['discover', 'refine', 'refine', 'extract'],
        ...['discover', 'refine', 'refine', 'extract'],
        ...['discover', 'refine', 'refine', 'extract'],
      ],
    ],
    ['separate', 0, ['discover', 'extract', 'discover', 'extract', 'discover', 'extract']],
  ] as const)('%s with Refine runs = %i', async (mode, refineRuns, expected) => {
    const h = harness(mode, refineRuns);
    await h.start();
    expect(await h.done()).toEqual(expected);
    expect(h.multi.stopped()).toBeNull();
    h.dispose();
  });
});

describe('run record in the results', () => {
  it('writes cala-run-record.json beside the manifest and hands the record to every export', async () => {
    const texts = new Map<string, string>();
    const exported: unknown[] = [];
    const rec = {
      format: 'cala-run-record',
      record_version: 1,
    };
    const writing: ResultsSink = {
      root: 'r',
      writeFile: async (path: string) => {
        exported.push(path);
      },
      writeText: async (path: string, text: string) => {
        texts.set(path, text);
      },
      finish: async () => {},
    } as unknown as ResultsSink;
    const calls: unknown[] = [];
    const h = harness('joint', 0, 2, {
      sink: writing,
      runRecord: (st) => {
        calls.push(st);
        return { ...rec, settings: { library_mode: st.mode } };
      },
    });
    await h.start();
    await h.done();
    expect(texts.has('cala-run.json')).toBe(true);
    const parsed = JSON.parse(texts.get('cala-run-record.json')!);
    expect(parsed).toMatchObject({
      format: 'cala-run-record',
      settings: { library_mode: 'joint' },
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(exported.length).toBe(2);
    h.dispose();
  });
});

describe('run record in a Separate run', () => {
  it('writes one record beside the results of each session and none at the root', async () => {
    const texts = new Map<string, string>();
    const writing: ResultsSink = {
      root: 'r',
      writeFile: async () => {},
      writeText: async (path: string, text: string) => {
        texts.set(path, text);
      },
      finish: async () => {},
    } as unknown as ResultsSink;
    const h = harness('separate', 0, 2, {
      sink: writing,
      runRecord: (st, index) => ({ format: 'cala-run-record', session_index: index ?? null }),
    });
    await h.start();
    await h.done();
    expect(texts.has('cala-run-record.json')).toBe(false);
    expect(JSON.parse(texts.get('s0/cala-run-record.json')!).session_index).toBe(0);
    expect(JSON.parse(texts.get('s1/cala-run-record.json')!).session_index).toBe(1);
    h.dispose();
  });
});
