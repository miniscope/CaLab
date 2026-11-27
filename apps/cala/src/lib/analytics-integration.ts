// Reactive usage-analytics integration for Cala (docs/analytics.md).
// Watches the stores through narrow accessors and reports a handful of
// aggregate events, so the stores stay free of analytics concerns.
//
// Privacy rules, enforced in code by `send` (every payload is filtered through
// ALLOWED_FIELDS) and by tests:
//   - numbers and small fixed categories only; never file, folder, animal or
//     session names, paths, traces, footprints, stacks or recording times;
//   - error message text is never sent (category and a closed-list error class only);
//   - low volume: one event per stage run, per export, per session; nothing
//     per batch or frame (the database caps events per session, migration 013).
// The one user-typed field is the opt-in `tester_tag` (packages/community
// tester-tag.ts), sent by the shared analytics layer, not from here.

import { createEffect, on, onCleanup } from 'solid-js';
import { trackEvent, type AnalyticsEventName } from '@calab/community';
import type { BoundaryFlag } from './boundary-flags.ts';
import type { FrameSourceInfo } from './frame-source.ts';
import type { RecordedStageName, StageRun } from './run-stages.ts';
import { EXPORT_FORMAT_VERSION } from './export.ts';
import { startMemoryCollector, totalWasmHeapBytes } from './memory-telemetry.ts';
import { median } from './stats.ts';

export type RunMode = 'joint' | 'separate' | 'apply' | 'single';
export type ErrorCategory = 'out_of_memory' | 'webgpu' | 'decode' | 'worker' | 'unknown';

/** Fields each event may carry. Anything else is dropped before sending. */
export const ALLOWED_FIELDS = {
  file_imported: ['extension'],
  run_started: ['stage', 'mode', 'sessions', 'plan_sessions', 'frames', 'fps', 'width', 'height'],
  run_finished: [
    'stage',
    'mode',
    'sessions',
    'plan_sessions',
    'frames',
    'fps',
    'width',
    'height',
    'duration_s',
    'median_fps',
    'cells',
    'peak_wasm_mb',
  ],
  run_failed: ['stage', 'error_category', 'error_type', 'peak_wasm_mb'],
  boundary_summary: ['boundaries', 'ok', 'warning', 'failed'],
  results_exported: ['sessions', 'format_version'],
  webgpu_info: [
    'adapter',
    'vendor',
    'architecture',
    'device',
    'description',
    'max_buffer_mb',
    'max_storage_mb',
  ],
  device_info: ['os', 'cores', 'memory_gb', 'browser_major', 'dpr'],
} as const satisfies Partial<Record<AnalyticsEventName, readonly string[]>>;

export type CalaEventName = keyof typeof ALLOWED_FIELDS;

/**
 * Error classes that may be reported by name. A closed list: the message text
 * itself is never sent (a regex cannot reliably strip paths, folder or animal
 * names from free text), only which kind of error it was.
 */
export const ERROR_TYPES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'DOMException',
  'OperationError',
  'AbortError',
  'NotAllowedError',
  'QuotaExceededError',
  'RuntimeError',
] as const;

/** The error class named at the start of a message, when it is in the closed list. */
export function errorType(raw: string): (typeof ERROR_TYPES)[number] | null {
  const m = /^\s*([A-Za-z]+):/.exec(String(raw ?? ''));
  return ERROR_TYPES.find((t) => t === m?.[1]) ?? null;
}

/** A small fixed set of failure kinds, from the raw message. */
export function errorCategory(message: string): ErrorCategory {
  const m = message.toLowerCase();
  if (
    /out of memory|allocation failed|memory access out of bounds|quota|invalid array length/.test(m)
  )
    return 'out_of_memory';
  if (/webgpu|\bgpu\b|adapter|device (was )?lost/.test(m)) return 'webgpu';
  if (/decod|codec|fourcc|\bavi\b|unsupported video|frame .*read|could not read/.test(m))
    return 'decode';
  if (/worker|postmessage|terminated|channel closed/.test(m)) return 'worker';
  return 'unknown';
}

function round(x: number, digits = 1): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

/** Lowercase extension of a file name, or 'other' when it is not a short alphanumeric one. */
export function fileExtension(name: string | undefined): string {
  const ext = name?.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'other';
}

export interface AdapterLike {
  isFallbackAdapter?: boolean;
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
}

/** Lowercase, `[a-z0-9 ._-]` only, trimmed, at most `max` characters ('' when nothing is left). */
export function sanitizeLabel(raw: unknown, max: number): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ._-]/g, '')
    .trim()
    .slice(0, max);
}

const toMb = (bytes: unknown): number | undefined =>
  typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
    ? Math.round(bytes / 1048576)
    : undefined;

/**
 * The webgpu_info payload: adapter class, short lowercase GPU labels (Chrome
 * often leaves device/description empty: omitted then) and two buffer limits.
 */
export function webgpuPayload(adapter: AdapterLike | null): Record<string, unknown> {
  if (!adapter) return { adapter: 'none' };
  const vendor = sanitizeLabel(adapter.info?.vendor, 24);
  const architecture = sanitizeLabel(adapter.info?.architecture, 48);
  const device = sanitizeLabel(adapter.info?.device, 48);
  const description = sanitizeLabel(adapter.info?.description, 48);
  return {
    adapter: adapter.isFallbackAdapter ? 'fallback' : 'hardware',
    ...(vendor ? { vendor } : {}),
    ...(architecture ? { architecture } : {}),
    ...(device ? { device } : {}),
    ...(description ? { description } : {}),
    max_buffer_mb: toMb(adapter.limits?.maxBufferSize),
    max_storage_mb: toMb(adapter.limits?.maxStorageBufferBindingSize),
  };
}

export type OsFamily = 'macos' | 'windows' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other';

export interface DeviceEnv {
  userAgent?: string;
  platform?: string;
  uaPlatform?: string;
  cores?: number;
  deviceMemory?: number;
  dpr?: number;
}

/** Operating system family only (never a version). */
export function osFamily(
  uaPlatform: string | undefined,
  platform: string | undefined,
  ua = '',
): OsFamily {
  const p = `${uaPlatform || ''} ${platform || ''}`.toLowerCase();
  if (/android/.test(p) || /android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod|ios/.test(p) || /iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/chrome os|chromeos|cros/.test(p) || /\bcros\b/i.test(ua)) return 'chromeos';
  if (/mac/.test(p)) return 'macos';
  if (/win/.test(p)) return 'windows';
  if (/linux|x11/.test(p)) return 'linux';
  return 'other';
}

/** Major browser version from the user agent (Edge, Chrome, Firefox, Safari), or undefined. */
export function browserMajor(ua: string | undefined): number | undefined {
  const s = ua ?? '';
  const m =
    /\b(?:Edg|Edge|OPR)\/(\d+)/.exec(s) ??
    /\bFirefox\/(\d+)/.exec(s) ??
    /\bChrome\/(\d+)/.exec(s) ??
    /\bVersion\/(\d+)[\d.]*.*Safari\//.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Coarse hardware snapshot: family, core count, memory class, browser major, display scale. */
export function devicePayload(env: DeviceEnv): Record<string, unknown> {
  const dpr = typeof env.dpr === 'number' && env.dpr > 0 ? Math.round(env.dpr * 4) / 4 : undefined;
  return {
    os: osFamily(env.uaPlatform, env.platform, env.userAgent),
    cores:
      typeof env.cores === 'number' && env.cores > 0
        ? Math.min(Math.round(env.cores), 256)
        : undefined,
    memory_gb:
      typeof env.deviceMemory === 'number' && env.deviceMemory > 0 ? env.deviceMemory : undefined,
    browser_major: browserMajor(env.userAgent),
    dpr,
  };
}

function defaultDeviceEnv(): DeviceEnv {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string }; deviceMemory?: number }) | undefined;
  return {
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    uaPlatform: nav?.userAgentData?.platform,
    cores: nav?.hardwareConcurrency,
    deviceMemory: nav?.deviceMemory,
    dpr: globalThis.devicePixelRatio,
  };
}

export interface AnalyticsDeps {
  /** Defaults to the shared `trackEvent` (which no-ops when analytics are off). */
  track?: (name: AnalyticsEventName, data?: Record<string, unknown>) => void | Promise<void>;
  stageRuns(): readonly StageRun[];
  info(): FrameSourceInfo | null;
  /** The multi-session plan (null: a single folder, run by hand). */
  plan(): {
    settings: { mode: 'joint' | 'separate' | 'apply' };
    sessions: readonly unknown[];
  } | null;
  /** Current throughput of a stage, frames per second (0: idle). */
  throughput(stage: RecordedStageName): number;
  /** Why a stage stopped (raw; only its category and error class are ever sent). */
  stageError(stage: RecordedStageName): string | null;
  /** Bytes of WASM heap summed over all threads (main thread and workers); 0 when unknown. */
  heapBytes?(): number;
  /** The coarse hardware snapshot inputs (defaults to the browser's). */
  deviceEnv?(): DeviceEnv;
  boundaryFlags(): readonly BoundaryFlag[];
  /** Multi-session run end: finished or stopped, and the sessions written. */
  runEnded(): boolean;
  sessionsWritten(): number;
  getAdapter?(): Promise<AdapterLike | null>;
  sampleMs?: number;
}

let reportExport: ((sessions: number, formatVersion: number) => void) | null = null;

/** A results export finished outside a multi-session run (the Export button). */
export function reportResultsExported(
  sessions: number,
  formatVersion: number = EXPORT_FORMAT_VERSION,
): void {
  reportExport?.(sessions, formatVersion);
}

function defaultAdapter(): Promise<AdapterLike | null> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<AdapterLike | null> } })
    ?.gpu;
  return gpu ? gpu.requestAdapter() : Promise.resolve(null);
}

export function setupAnalyticsEffects(deps: AnalyticsDeps): void {
  const track = deps.track ?? trackEvent;
  const send = (name: CalaEventName, data: Record<string, unknown>): void => {
    const allowed: readonly string[] = ALLOWED_FIELDS[name];
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(data))
      if (allowed.includes(k) && data[k] !== undefined && data[k] !== null) clean[k] = data[k];
    try {
      void Promise.resolve(track(name, clean)).catch(() => {});
    } catch {
      // Analytics never throws.
    }
  };

  // Workers report their WASM heap to the main thread (lib/memory-telemetry.ts).
  if (!deps.heapBytes) {
    const stop = startMemoryCollector(
      () => (globalThis as { __calaWasmHeapBytes?: () => number }).__calaWasmHeapBytes?.() ?? 0,
    );
    onCleanup(stop);
  }
  const heap = deps.heapBytes ?? (() => totalWasmHeapBytes());

  // ---- webgpu_info and device_info: once per session ----
  // Both go out once the adapter request settles, not synchronously at setup:
  // the app renders before `initSession` starts, and events sent that early
  // are dropped (see the queue in packages/community analytics.ts).
  const sendDevice = () => {
    try {
      send('device_info', devicePayload((deps.deviceEnv ?? defaultDeviceEnv)()));
    } catch {
      // Analytics never throws.
    }
  };
  void (deps.getAdapter ?? defaultAdapter)()
    .then((a) => send('webgpu_info', webgpuPayload(a)))
    .catch(() => send('webgpu_info', { adapter: 'none' }))
    .finally(sendDevice);

  // ---- file_imported ----
  let lastInfo: FrameSourceInfo | null = null;
  let lastPlan: object | null = null;
  createEffect(
    on(deps.info, (info) => {
      if (!info || info === lastInfo || info.live) return;
      lastInfo = info;
      const plan = deps.plan();
      // A multi-session run opens one source per session: report the import once per plan.
      if (plan) {
        if (lastPlan === plan) return;
        lastPlan = plan;
      }
      send('file_imported', { extension: fileExtension(info.files[0]?.name) });
    }),
  );

  // ---- run_started / run_finished / run_failed, one set per stage run ----
  interface Live {
    samples: number[];
    peak: number;
    timer: ReturnType<typeof setInterval>;
  }
  const live = new Map<string, Live>();
  const reported = new Set<string>();
  const runKey = (r: StageRun) => `${r.stage}:${r.index}:${r.startedAt}`;

  function context(): Record<string, unknown> {
    const info = deps.info();
    const plan = deps.plan();
    const mode = (plan?.settings.mode ?? 'single') satisfies RunMode;
    return {
      mode,
      // Sessions this stage run processed: a Joint run is one run over every
      // session; a Separate plan runs each session on its own (and a single
      // folder is one). `plan_sessions` is the size of the plan they came from.
      sessions: mode === 'joint' ? (plan?.sessions.length ?? 1) : 1,
      ...(plan ? { plan_sessions: plan.sessions.length } : {}),
      ...(info && !info.live ? { frames: info.frameCount } : {}),
      ...(info?.fps ? { fps: round(info.fps) } : {}),
      ...(info ? { width: info.width, height: info.height } : {}),
    };
  }

  /** Peak WASM heap summed over all threads, only when known (0: omitted). */
  function peakFields(l: Live | undefined): Record<string, number> {
    return l && l.peak > 0 ? { peak_wasm_mb: Math.round(l.peak / 1048576) } : {};
  }

  function sample(stage: RecordedStageName, l: Live): void {
    const f = deps.throughput(stage);
    if (f > 0) l.samples.push(f);
    l.peak = Math.max(l.peak, heap());
  }

  createEffect(() => {
    const runs = deps.stageRuns();
    const present = new Set(runs.map(runKey));
    for (const [k, l] of live)
      if (!present.has(k)) {
        clearInterval(l.timer);
        live.delete(k);
      }
    for (const r of runs) {
      const k = runKey(r);
      if (r.outcome === 'running' && !live.has(k) && !reported.has(`s:${k}`)) {
        reported.add(`s:${k}`);
        const l: Live = {
          samples: [],
          peak: 0,
          timer: setInterval(() => sample(r.stage, l), deps.sampleMs ?? 2000),
        };
        live.set(k, l);
        send('run_started', { stage: r.stage, ...context() });
      } else if (r.outcome !== 'running' && !reported.has(`e:${k}`)) {
        reported.add(`e:${k}`);
        const l = live.get(k);
        if (l) {
          sample(r.stage, l);
          clearInterval(l.timer);
          live.delete(k);
        }
        if (r.outcome === 'done') {
          const dur =
            r.endedAt !== null ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000 : NaN;
          const med = median(l?.samples ?? []);
          send('run_finished', {
            stage: r.stage,
            ...context(),
            ...(Number.isFinite(dur) ? { duration_s: round(dur) } : {}),
            ...(med !== null ? { median_fps: round(med) } : {}),
            cells: r.cells,
            ...peakFields(l),
          });
        } else if (r.outcome === 'error') {
          const raw = deps.stageError(r.stage) ?? '';
          const type = errorType(raw);
          send('run_failed', {
            stage: r.stage,
            error_category: errorCategory(raw),
            ...(type ? { error_type: type } : {}),
            ...peakFields(l),
          });
        }
        // 'cancelled': the user's choice, not reported.
      }
    }
    if (reported.size > 5000) reported.clear();
  });
  onCleanup(() => {
    for (const l of live.values()) clearInterval(l.timer);
  });

  // ---- results_exported / boundary_summary ----
  let endedPlan: object | null = null;
  createEffect(() => {
    if (!deps.runEnded()) return;
    const plan = deps.plan();
    if (!plan || endedPlan === plan) return;
    endedPlan = plan;
    const written = deps.sessionsWritten();
    if (plan.settings.mode === 'joint') {
      const flags = deps.boundaryFlags();
      if (flags.length > 0)
        send('boundary_summary', {
          boundaries: flags.length,
          ok: flags.filter((f) => f.severity === 'ok').length,
          warning: flags.filter((f) => f.severity === 'warning').length,
          failed: flags.filter((f) => f.severity === 'failed').length,
        });
    }
    if (written > 0)
      send('results_exported', { sessions: written, format_version: EXPORT_FORMAT_VERSION });
  });
  reportExport = (sessions, formatVersion) =>
    send('results_exported', { sessions, format_version: formatVersion });
  onCleanup(() => {
    reportExport = null;
  });
}
