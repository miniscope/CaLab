import { describe, expect, it } from 'vitest';
import { buildCala, extractRuns } from '../lib/cala.ts';
import {
  buildProfiles,
  coresBucket,
  gpuClass,
  hardwareGroups,
  hardwareMixes,
  maxBufferBucket,
  memoryClass,
  peakMemoryBySize,
} from '../lib/hardware.ts';
import { indexEvents } from '../lib/metrics.ts';
import { T0, event, session } from './helpers.ts';

function rig() {
  const mk = (cores: number, vendor: string, fpsV: number, extra = {}) => {
    const s = session();
    const evs = [
      event(s.id, 'device_info', {
        os: 'windows',
        cores,
        memory_gb: 8,
        browser_major: 130,
        dpr: 1,
      }),
      event(s.id, 'webgpu_info', {
        adapter: 'hardware',
        vendor,
        architecture: 'ampere',
        max_buffer_mb: 4096,
      }),
      event(s.id, 'run_started', { stage: 'discover' }, T0),
      event(
        s.id,
        'run_finished',
        { stage: 'discover', median_fps: fpsV, frames: 1000, width: 100, height: 100, ...extra },
        T0 + 1000,
      ),
    ];
    return { s, evs };
  };
  return mk;
}

describe('buckets', () => {
  it('bucket edges and unknowns', () => {
    expect(coresBucket(4)).toBe('4 or fewer');
    expect(coresBucket(5)).toBe('5-8');
    expect(coresBucket(32)).toBe('more than 16');
    expect(coresBucket(null)).toBe('Unknown');
    expect(memoryClass(8)).toBe('8 GB');
    expect(memoryClass(null)).toBe('Unknown');
    expect(maxBufferBucket(256)).toBe('under 512 MB');
    expect(maxBufferBucket(4096)).toBe('4 GB or more');
  });
});

describe('profiles and groups', () => {
  it('builds profiles from device_info and webgpu_info and tolerates old sessions', () => {
    const mk = rig();
    const a = mk(8, 'nvidia', 300);
    const old = session();
    const sessions = [a.s, old];
    const evs = [...a.evs, event(old.id, 'webgpu_info', { adapter: 'hardware', vendor: 'amd' })];
    const p = buildProfiles(sessions, indexEvents(sessions, evs));
    expect(p.get(a.s.id)).toMatchObject({
      os: 'windows',
      cores: 8,
      browser: '130',
      architecture: 'ampere',
      maxBufferMb: 4096,
    });
    expect(p.get(old.id)).toMatchObject({ os: 'Unknown', cores: null, architecture: null });
    expect(gpuClass(p.get(a.s.id)!)).toBe('nvidia ampere');
    expect(gpuClass(p.get(old.id)!)).toBe('amd');
    const m = hardwareMixes(sessions, p);
    expect(m.os.map((r) => r.key)).toEqual(['windows', 'Unknown']);
    expect(m.withDeviceInfo).toBe(1);
  });

  it('computes per-group fps and flags groups under n=3 as small', () => {
    const mk = rig();
    const rows = [
      mk(8, 'nvidia', 300),
      mk(8, 'nvidia', 200),
      mk(8, 'nvidia', 100),
      mk(2, 'intel', 20),
    ];
    const sessions = rows.map((r) => r.s);
    const evs = rows.flatMap((r) => r.evs);
    const ix = indexEvents(sessions, evs);
    const cala = buildCala(sessions, evs);
    const groups = hardwareGroups(
      (p) => coresBucket(p.cores),
      buildProfiles(sessions, ix),
      cala.runs,
      cala.failures,
      cala.ledger,
    );
    const big = groups.find((g) => g.group === '5-8')!;
    const small = groups.find((g) => g.group === '4 or fewer')!;
    expect(big).toMatchObject({
      n: 3,
      discoverFps: 200,
      small: false,
      failureRate: 0,
      unfinishedRate: 0,
    });
    expect(small).toMatchObject({ n: 1, small: true });
  });

  it('counts failures and unfinished runs per hardware class and survives no data', () => {
    const s = session();
    const evs = [
      event(s.id, 'webgpu_info', { adapter: 'fallback', vendor: 'swiftshader' }),
      event(s.id, 'run_started', { stage: 'discover' }),
    ];
    const ix = indexEvents([s], evs);
    const cala = buildCala([s], evs);
    const g = hardwareGroups(
      gpuClass,
      buildProfiles([s], ix),
      cala.runs,
      cala.failures,
      cala.ledger,
    );
    expect(g).toEqual([
      expect.objectContaining({ group: 'Software fallback', unfinishedRate: 1, failureRate: null }),
    ]);
    expect(hardwareGroups(gpuClass, new Map(), [], [], { starts: [], unfinished: [] })).toEqual([]);
  });
});

describe('peak memory by size', () => {
  it('returns a single bin for few runs, quartile bins otherwise, and [] without memory fields', () => {
    const s = session();
    const mkRuns = (n: number) =>
      extractRuns(
        [s],
        indexEvents(
          [s],
          Array.from({ length: n }, (_, i) =>
            event(
              s.id,
              'run_finished',
              {
                stage: 'discover',
                frames: 1000 * (i + 1),
                width: 10,
                height: 10,
                peak_wasm_mb: 100 * (i + 1),
                peak_js_mb: 10,
              },
              T0 + i,
            ),
          ),
        ),
      );
    expect(peakMemoryBySize(mkRuns(3))).toHaveLength(1);
    const bins = peakMemoryBySize(mkRuns(16));
    expect(bins.length).toBeGreaterThan(1);
    expect(bins[0].wasmMb!).toBeLessThan(bins[bins.length - 1].wasmMb!);
    expect(
      peakMemoryBySize(
        extractRuns(
          [s],
          indexEvents([s], [event(s.id, 'run_finished', { stage: 'discover', frames: 5 })]),
        ),
      ),
    ).toEqual([]);
  });
});
