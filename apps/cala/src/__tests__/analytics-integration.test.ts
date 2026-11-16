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
  devicePayload,
  osFamily,
  browserMajor,
  sanitizeLabel,
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
  const deviceCalls: Call[] = [];
  const [runs, setRuns] = createSignal<StageRun[]>([]);
  const [info, setInfo] = createSignal<FrameSourceInfo | null>(null);
  const [plan, setPlan] = createSignal<ReturnType<AnalyticsDeps['plan']>>(null);
  const [ended, setEnded] = createSignal(false);
  const [fps, setFps] = createSignal(0);
  const dispose = createRoot((d) => {
    setupAnalyticsEffects({
      track: (n, d2) =>
        void (n === 'device_info' ? deviceCalls : calls).push([n, d2 as Record<string, unknown>]),
      deviceEnv: () => ({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.7444.60 Safari/537.36',
        platform: 'MacIntel',
        uaPlatform: 'macOS',
        cores: 10,
        deviceMemory: 8,
        dpr: 2,
      }),
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
  return { calls, deviceCalls, setRuns, setInfo, setPlan, setEnded, setFps, dispose };
}

const names = (c: Call[]) => c.map((x) => x[0]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('event sequence', () => {
  it('reports webgpu_info once, then import, start and finish of a single run', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual([['webgpu_info', { adapter: 'hardware', vendor: 'nvidia' }]]);
    expect(h.deviceCalls).toEqual([
      ['device_info', { os: 'macos', cores: 10, memory_gb: 8, browser_major: 142, dpr: 2 }],
    ]);

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

  it('device_info is still sent when the adapter request fails', async () => {
    const h = harness({ getAdapter: () => Promise.reject(new Error('no gpu')) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[0]).toEqual(['webgpu_info', { adapter: 'none' }]);
    expect(h.deviceCalls).toHaveLength(1);
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
    expect(h.deviceCalls).toHaveLength(1);
    for (const [name, data] of [...h.calls, ...h.deviceCalls]) {
      const allowed = (ALLOWED_FIELDS as Record<string, readonly string[]>)[name];
      expect(allowed, `unknown event ${name}`).toBeDefined();
      for (const k of Object.keys(data)) expect(allowed).toContain(k);
    }
    const fin = h.calls.find((c) => c[0] === 'run_finished')!;
    expect(fin[1].peak_wasm_mb).toBe(300);
    h.dispose();
  });

  it('a failed run reports the peaks reached before it failed', async () => {
    const h = harness({ heapBytes: () => 300 * 1048576 });
    h.setRuns([run({})]);
    await vi.advanceTimersByTimeAsync(2000);
    h.setRuns([run({ outcome: 'error', endedAt: '2026-01-01T00:00:10.000Z' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.find((c) => c[0] === 'run_failed')![1]).toMatchObject({
      peak_wasm_mb: 300,
    });
    h.dispose();
  });

  it('peaks are running maxima: a later lower sample does not lower them', async () => {
    let wasm = 100 * 1048576;
    const h = harness({ heapBytes: () => wasm });
    h.setRuns([run({})]);
    await vi.advanceTimersByTimeAsync(1000);
    wasm = 700 * 1048576;
    await vi.advanceTimersByTimeAsync(1000);
    wasm = 200 * 1048576;
    await vi.advanceTimersByTimeAsync(2000);
    h.setRuns([run({ outcome: 'done', endedAt: '2026-01-01T00:00:10.000Z' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.find((c) => c[0] === 'run_finished')![1]).toMatchObject({
      peak_wasm_mb: 700,
    });
    h.dispose();
  });

  it('omits the peaks when no memory figure is available', async () => {
    const h = harness({ heapBytes: () => 0 });
    h.setRuns([run({})]);
    h.setRuns([run({ outcome: 'error', endedAt: '2026-01-01T00:00:10.000Z' })]);
    await vi.advanceTimersByTimeAsync(0);
    const f = h.calls.find((c) => c[0] === 'run_failed')![1];
    expect(f).not.toHaveProperty('peak_wasm_mb');
    h.dispose();
  });

  it('drops unlisted fields even if a payload carried them', async () => {
    const h = harness({ getAdapter: async () => ({ info: { vendor: 'amd' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(h.calls[0][1]).sort()).toEqual(['adapter', 'vendor']);
    h.dispose();
  });

  it('device_info carries no UA string, version or fingerprint', async () => {
    const h = harness({
      deviceEnv: () => ({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
        platform: 'Win32',
        cores: 16,
        dpr: 1.3,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deviceCalls).toEqual([
      ['device_info', { os: 'windows', cores: 16, browser_major: 130, dpr: 1.25 }],
    ]);
    expect(JSON.stringify(h.deviceCalls)).not.toMatch(/Mozilla|NT 10|Gecko/);
    h.dispose();
  });

  it('webgpu_info sanitises adapter strings and reports limits in MB', () => {
    const p = webgpuPayload({
      isFallbackAdapter: false,
      info: {
        vendor: 'Apple!',
        architecture: 'Metal-3 <script>',
        device: '',
        description: 'Apple M2 Pro (Mac14,9) ' + 'x'.repeat(100),
      },
      limits: { maxBufferSize: 4294967296, maxStorageBufferBindingSize: 134217728 },
    });
    expect(p).toMatchObject({
      adapter: 'hardware',
      vendor: 'apple',
      architecture: 'metal-3 script',
      max_buffer_mb: 4096,
      max_storage_mb: 128,
    });
    expect(p).not.toHaveProperty('device');
    expect((p.description as string).length).toBeLessThanOrEqual(48);
    expect(p.description).toMatch(/^[a-z0-9 ._-]+$/);
  });
});

describe('device helpers', () => {
  it('osFamily is a family only', () => {
    expect(osFamily('macOS', 'MacIntel')).toBe('macos');
    expect(osFamily('Windows', 'Win32')).toBe('windows');
    expect(osFamily(undefined, 'Linux x86_64')).toBe('linux');
    expect(osFamily(undefined, 'Linux armv81', 'Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(osFamily(undefined, 'iPhone')).toBe('ios');
    expect(osFamily('Chrome OS', '')).toBe('chromeos');
    expect(osFamily(undefined, 'Plan9')).toBe('other');
  });
  it('browserMajor reads Chrome, Edge, Firefox and Safari', () => {
    expect(browserMajor('X Chrome/142.0.0.0 Safari/537.36')).toBe(142);
    expect(browserMajor('X Chrome/142.0.0.0 Safari/537.36 Edg/141.0.1')).toBe(141);
    expect(browserMajor('X Gecko/20100101 Firefox/131.0')).toBe(131);
    expect(browserMajor('X Version/17.4 Safari/605.1.15')).toBe(17);
    expect(browserMajor('curl/8')).toBeUndefined();
  });
  it('devicePayload rounds dpr to 0.25 and omits absent fields', () => {
    expect(devicePayload({ platform: 'MacIntel', dpr: 2.6 })).toMatchObject({
      os: 'macos',
      dpr: 2.5,
    });
    expect(sanitizeLabel('  Ünï$x 1_2.3-4  ', 48)).toBe('nx 1_2.3-4');
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
