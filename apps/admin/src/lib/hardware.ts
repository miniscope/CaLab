// Hardware analysis: device_info + webgpu_info joined to runs by session id.
// Every field is optional (older Cala versions send none of them), so every
// grouping has an "Unknown" bucket and nothing throws on absent fields.

import type { EventRow, SessionRow } from './types.ts';
import { evNum, evStr, type EventIndex } from './metrics.ts';
import { type CalaRun, type FailureEvent, type RunLedger, adapterOf } from './cala.ts';
import { countBy, median, quantile, rank } from './stats.ts';

export interface HwProfile {
  sessionId: string;
  os: string;
  cores: number | null;
  memoryGb: number | null;
  browser: string;
  dpr: number | null;
  adapter: 'hardware' | 'fallback' | 'none' | 'unknown';
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  maxBufferMb: number | null;
}

const UNKNOWN = 'Unknown';

export function coresBucket(n: number | null): string {
  if (n === null) return UNKNOWN;
  if (n <= 4) return '4 or fewer';
  if (n <= 8) return '5-8';
  if (n <= 12) return '9-12';
  if (n <= 16) return '13-16';
  return 'more than 16';
}

export function memoryClass(gb: number | null): string {
  if (gb === null) return UNKNOWN;
  if (gb <= 4) return '4 GB or less';
  if (gb <= 8) return '8 GB';
  if (gb <= 16) return '16 GB';
  return 'more than 16 GB';
}

export function maxBufferBucket(mb: number | null): string {
  if (mb === null) return UNKNOWN;
  if (mb < 512) return 'under 512 MB';
  if (mb < 2048) return '512 MB to 2 GB';
  if (mb < 4096) return '2 to 4 GB';
  return '4 GB or more';
}

/** GPU class label: vendor and architecture for hardware, a fixed label otherwise. */
export function gpuClass(p: HwProfile): string {
  if (p.adapter === 'fallback') return 'Software fallback';
  if (p.adapter === 'none') return 'No WebGPU';
  if (p.adapter !== 'hardware') return UNKNOWN;
  const v = p.vendor ?? 'unknown vendor';
  return p.architecture ? `${v} ${p.architecture}` : v;
}

export function browserLabel(p: HwProfile, family: string): string {
  return p.browser === UNKNOWN ? family : `${family} ${p.browser}`;
}

export function buildProfiles(sessions: SessionRow[], idx: EventIndex): Map<string, HwProfile> {
  const out = new Map<string, HwProfile>();
  for (const s of sessions) {
    const evs: EventRow[] = idx.get(s.id) ?? [];
    const dev = evs.find((e) => e.event_name === 'device_info');
    const gpu = evs.find((e) => e.event_name === 'webgpu_info');
    const { cls, vendor } = adapterOf(evs);
    const major = dev ? evNum(dev, 'browser_major') : null;
    out.set(s.id, {
      sessionId: s.id,
      os: (dev && evStr(dev, 'os')) || UNKNOWN,
      cores: dev ? evNum(dev, 'cores') : null,
      memoryGb: dev ? evNum(dev, 'memory_gb') : null,
      browser: major !== null ? String(Math.trunc(major)) : UNKNOWN,
      dpr: dev ? evNum(dev, 'dpr') : null,
      adapter: cls,
      vendor,
      architecture: gpu ? evStr(gpu, 'architecture') : null,
      device: gpu ? evStr(gpu, 'device') : null,
      maxBufferMb: gpu ? evNum(gpu, 'max_buffer_mb') : null,
    });
  }
  return out;
}

export interface Mixes {
  os: { key: string; count: number }[];
  cores: { key: string; count: number }[];
  memory: { key: string; count: number }[];
  gpu: { key: string; count: number; fallback: boolean }[];
  browser: { key: string; count: number }[];
  /** Sessions that sent device_info (so the mixes are of known hardware only). */
  withDeviceInfo: number;
}

/** Session counts per hardware dimension; unknown buckets last. */
export function hardwareMixes(sessions: SessionRow[], profiles: Map<string, HwProfile>): Mixes {
  const ps = sessions.map((s) => ({ s, p: profiles.get(s.id)! })).filter((x) => x.p);
  const known = (r: { key: string; count: number }[]) =>
    [...r].sort(
      (a, b) => Number(a.key === UNKNOWN) - Number(b.key === UNKNOWN) || b.count - a.count,
    );
  const gpu = rank(countBy(ps, (x) => gpuClass(x.p))).map((r) => ({
    ...r,
    fallback: r.key === 'Software fallback' || r.key === 'No WebGPU',
  }));
  return {
    os: known(rank(countBy(ps, (x) => x.p.os))),
    cores: known(rank(countBy(ps, (x) => coresBucket(x.p.cores)))),
    memory: known(rank(countBy(ps, (x) => memoryClass(x.p.memoryGb)))),
    gpu,
    browser: known(rank(countBy(ps, (x) => browserLabel(x.p, x.s.user_agent_family ?? 'Other')))),
    withDeviceInfo: ps.filter((x) => x.p.os !== UNKNOWN || x.p.cores !== null).length,
  };
}

export interface HwGroup {
  group: string;
  /** run_started count: the sample size for rates. */
  n: number;
  runs: number;
  discoverFps: number | null;
  refineFps: number | null;
  failureRate: number | null;
  unfinishedRate: number | null;
  small: boolean;
}

export const SMALL_GROUP = 3;

/**
 * Group runs, failures and unfinished runs by a per-session key. n is the
 * number of run starts; groups under SMALL_GROUP are flagged `small` so the UI
 * can hide them by default.
 */
export function hardwareGroups(
  keyOf: (p: HwProfile) => string,
  profiles: Map<string, HwProfile>,
  runs: CalaRun[],
  failures: FailureEvent[],
  ledger: RunLedger,
): HwGroup[] {
  const key = (sid: string) => {
    const p = profiles.get(sid);
    return p ? keyOf(p) : UNKNOWN;
  };
  const groups = new Set<string>();
  for (const r of runs) groups.add(key(r.sessionId));
  for (const f of failures) groups.add(key(f.sessionId));
  for (const st of ledger.starts) groups.add(key(st.sessionId));
  return Array.from(groups)
    .map((group) => {
      const r = runs.filter((x) => key(x.sessionId) === group);
      const f = failures.filter((x) => key(x.sessionId) === group).length;
      const st = ledger.starts.filter((x) => key(x.sessionId) === group).length;
      const un = ledger.unfinished.filter((x) => key(x.sessionId) === group).length;
      const attempts = r.length + f;
      const n = Math.max(st, attempts);
      return {
        group,
        n,
        runs: r.length,
        discoverFps: median(r.filter((x) => x.stage === 'discover').map((x) => x.medianFps)),
        refineFps: median(r.filter((x) => x.stage === 'refine').map((x) => x.medianFps)),
        failureRate: attempts > 0 ? f / attempts : null,
        unfinishedRate: st > 0 ? un / st : null,
        small: n < SMALL_GROUP,
      };
    })
    .sort((a, b) => Number(a.group === UNKNOWN) - Number(b.group === UNKNOWN) || b.n - a.n);
}

export interface PeakMemoryBin {
  label: string;
  n: number;
  wasmMb: number | null;
  jsMb: number | null;
}

/** Median peak memory by recording size (frames x megapixels, in quartile bins). */
export function peakMemoryBySize(runs: CalaRun[]): PeakMemoryBin[] {
  const have = runs.filter(
    (r) => r.workMpx !== null && (r.peakWasmMb !== null || r.peakJsMb !== null),
  );
  if (have.length === 0) return [];
  const cuts =
    have.length >= 8
      ? [0.25, 0.5, 0.75].map((q) =>
          quantile(
            have.map((r) => r.workMpx),
            q,
          )!,
        )
      : [];
  const edges = [-Infinity, ...cuts, Infinity];
  const fmt = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0));
  const bins: PeakMemoryBin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inBin = have.filter((r) => r.workMpx! >= edges[i] && r.workMpx! < edges[i + 1]);
    if (inBin.length === 0 && edges.length > 2) continue;
    const label =
      edges.length === 2
        ? 'all sizes'
        : i === 0
          ? `under ${fmt(edges[1])} frames x MP`
          : i === edges.length - 2
            ? `${fmt(edges[i])}+ frames x MP`
            : `${fmt(edges[i])}-${fmt(edges[i + 1])} frames x MP`;
    bins.push({
      label,
      n: inBin.length,
      wasmMb: median(inBin.map((r) => r.peakWasmMb)),
      jsMb: median(inBin.map((r) => r.peakJsMb)),
    });
  }
  return bins;
}
