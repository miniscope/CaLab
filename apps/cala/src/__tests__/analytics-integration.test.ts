import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import {
  ALLOWED_FIELDS,
  errorCategory,
  fileExtension,
  median,
  errorType,
  setupAnalyticsEffects,
  webgpuPayload,
  type AnalyticsDeps,
} from '../lib/analytics-integration.ts';
import type { FrameSourceInfo } from '../lib/frame-source.ts';
import type { StageRun } from '../lib/run-stages.ts';

vi.mock('@calab/community', () => ({ trackEvent: vi.fn() }));

const INFO = {
  frameCount: 6000,
  width: 608,
  height: 608,
  fps: 30.04,
  files: [{ name: 'Mouse_Cortex_7/0.AVI', frames: 6000 }],
} as unknown as FrameSourceInfo;

function run(p: Partial<StageRun>): StageRun {
  return {
    stage: 'discover',
    index: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    outcome: 'running',
    frames: 0,
    cells: 0,
    libraryVersion: 0,
    ...p,
  };
}

type Call = [string, Record<string, unknown>];

function harness(over: Partial<AnalyticsDeps> = {}) {
  const calls: Call[] = [];
  const [runs, setRuns] = createSignal<StageRun[]>([]);
  const [info, setInfo] = createSignal<FrameSourceInfo | null>(null);
  const [plan, setPlan] = createSignal<ReturnType<AnalyticsDeps['plan']>>(null);
  const [ended, setEnded] = createSignal(false);
  const [fps, setFps] = createSignal(0);
  const dispose = createRoot((d) => {
    setupAnalyticsEffects({
      track: (n, d2) => void calls.push([n, d2 as Record<string, unknown>]),
      stageRuns: runs,
      info,
      plan,
      throughput: fps,
      stageError: () => 'Cell discovery stopped: out of memory in /Users/ana/Mouse7/0.avi',
      heapBytes: () => 0,
      boundaryFlags: () =>
        [
          { severity: 'ok' },
          { severity: 'warning' },
          { severity: 'failed' },
          { severity: 'ok' },
        ] as never,
      runEnded: ended,
      sessionsWritten: () => 3,
      getAdapter: async () => ({ isFallbackAdapter: false, info: { vendor: 'NVIDIA!' } }),
      sampleMs: 1000,
      ...over,
    });
    return d;
  });
  return { calls, setRuns, setInfo, setPlan, setEnded, setFps, dispose };
}

const names = (c: Call[]) => c.map((x) => x[0]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('event sequence', () => {
  it('reports webgpu_info once, then import, start and finish of a single run', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual([['webgpu_info', { adapter: 'hardware', vendor: 'nvidia' }]]);

    h.setInfo(INFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[1]).toEqual(['file_imported', { extension: 'avi' }]);

    h.setRuns([run({})]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[2]).toEqual([
      'run_started',
      {
        stage: 'discover',
        mode: 'single',
        sessions: 1,
        frames: 6000,
        fps: 30,
        width: 608,
        height: 608,
      },
    ]);

    h.setFps(100);
    await vi.advanceTimersByTimeAsync(1000);
    h.setFps(300);
    await vi.advanceTimersByTimeAsync(1000);
    h.setFps(200);
    await vi.advanceTimersByTimeAsync(1000);
    h.setRuns([run({ outcome: 'done', endedAt: '2026-01-01T00:01:00.000Z', cells: 42 })]);
    await vi.advanceTimersByTimeAsync(0);
    const fin = h.calls[3];
    expect(fin[0]).toBe('run_finished');
    expect(fin[1]).toMatchObject({
      stage: 'discover',
      duration_s: 60,
      median_fps: 200,
      cells: 42,
      mode: 'single',
    });
    expect(fin[1]).not.toHaveProperty('peak_wasm_mb');
    expect(h.calls).toHaveLength(4);
    h.dispose();
  });

  it('reports a failed run with a category and error class but never the message text, never twice', async () => {
    const h = harness();
    h.setRuns([run({ stage: 'refine', index: 2 })]);
    h.setRuns([
      run({ stage: 'refine', index: 2, outcome: 'error', endedAt: '2026-01-01T00:00:05.000Z' }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.calls.filter((c) => c[0] === 'run_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toEqual({
      stage: 'refine',
      error_category: 'out_of_memory',
    });
    expect(JSON.stringify(h.calls)).not.toContain('ana');
    h.dispose();
  });

  it('does not report cancelled runs', async () => {
    const h = harness();
    h.setRuns([run({})]);
    h.setRuns([run({ outcome: 'cancelled', endedAt: '2026-01-01T00:00:05.000Z' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(names(h.calls)).toEqual(['run_started', 'webgpu_info']);
    h.dispose();
  });

  it('multi-session joint run: one import, boundary summary and export at the end', async () => {
    const h = harness();
    const plan = { settings: { mode: 'joint' as const }, sessions: [1, 2, 3] };
    h.setPlan(plan);
    h.setInfo(INFO);
    h.setInfo({ ...INFO });
    h.setRuns([run({})]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c[0] === 'file_imported')).toHaveLength(1);
    expect(h.calls.find((c) => c[0] === 'run_started')![1]).toMatchObject({
      mode: 'joint',
      sessions: 3,
    });
    h.setEnded(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.find((c) => c[0] === 'boundary_summary')![1]).toEqual({
      boundaries: 4,
      ok: 2,
      warning: 1,
      failed: 1,
    });
    expect(h.calls.find((c) => c[0] === 'results_exported')![1]).toEqual({
      sessions: 3,
      format_version: expect.any(Number),
    });
    h.dispose();
  });

  it('webgpu_info reports none without an adapter', async () => {
    const h = harness({ getAdapter: async () => null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[0]).toEqual(['webgpu_info', { adapter: 'none' }]);
    h.dispose();
  });
});

describe('payload allowlist', () => {
  it('every payload key of a full run is in its event allowlist', async () => {
    const h = harness({ heapBytes: () => 300 * 1048576 });
    h.setPlan({ settings: { mode: 'joint' as const }, sessions: [1, 2] });
    h.setInfo(INFO);
    h.setRuns([run({})]);
    h.setFps(50);
    await vi.advanceTimersByTimeAsync(2000);
    h.setRuns([run({ outcome: 'done', endedAt: '2026-01-01T00:00:10.000Z', cells: 5 })]);
    h.setRuns([
      run({}),
      run({ stage: 'extract', outcome: 'error', endedAt: '2026-01-01T00:00:10.000Z' }),
    ]);
    h.setEnded(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.length).toBeGreaterThan(5);
    for (const [name, data] of h.calls) {
      const allowed = (ALLOWED_FIELDS as Record<string, readonly string[]>)[name];
      expect(allowed, `unknown event ${name}`).toBeDefined();
      for (const k of Object.keys(data)) expect(allowed).toContain(k);
    }
    const fin = h.calls.find((c) => c[0] === 'run_finished')!;
    expect(fin[1].peak_wasm_mb).toBe(300);
    h.dispose();
  });

  it('drops unlisted fields even if a payload carried them', async () => {
    const h = harness({ getAdapter: async () => ({ info: { vendor: 'amd' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(h.calls[0][1]).sort()).toEqual(['adapter', 'vendor']);
    h.dispose();
  });
});

describe('errorType', () => {
  it.each([
    ['RangeError: Invalid array length', 'RangeError'],
    ['TypeError: cannot read /Users/ana/x', 'TypeError'],
    ['MouseM7Error: bad', null],
    ['no colon here', null],
    ['  Error: oops', 'Error'],
  ])('%s', (input, expected) => {
    expect(errorType(input)).toBe(expected);
  });
});

describe('helpers', () => {
  it('errorCategory', () => {
    expect(errorCategory('RangeError: Invalid array length')).toBe('out_of_memory');
    expect(errorCategory('WebGPU device lost')).toBe('webgpu');
    expect(errorCategory('could not read frame 5')).toBe('decode');
    expect(errorCategory('worker terminated')).toBe('worker');
    expect(errorCategory('boom')).toBe('unknown');
  });
  it('fileExtension', () => {
    expect(fileExtension('a/b/0.AVI')).toBe('avi');
    expect(fileExtension('noext')).toBe('other');
    expect(fileExtension('x.weird_long_ext')).toBe('other');
    expect(fileExtension(undefined)).toBe('other');
  });
  it('median and webgpuPayload', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    expect(webgpuPayload({ isFallbackAdapter: true })).toEqual({ adapter: 'fallback' });
  });
});
