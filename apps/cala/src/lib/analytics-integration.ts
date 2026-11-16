// Reactive usage-analytics integration for Cala (docs/analytics.md).
// Watches the stores through narrow accessors and reports a handful of
// aggregate events, so the stores stay free of analytics concerns.
//
// Privacy rules, enforced in code by `send` (every payload is filtered through
// ALLOWED_FIELDS) and by tests:
//   - numbers and small fixed categories only; never file, folder, animal or
//     session names, paths, traces, footprints, stacks or recording times;
//   - error messages pass through `scrubMessage` and are capped at 200 chars;
//   - low volume: one event per stage run, per export, per session; nothing
//     per batch or frame (the database caps events per session, migration 013).
// The one user-typed field is the opt-in `tester_tag` (packages/community
// tester-tag.ts), sent by the shared analytics layer, not from here.

import { createEffect, on, onCleanup } from 'solid-js';
import { trackEvent, type AnalyticsEventName } from '@calab/community';
import type { BoundaryFlag } from './boundary-flags.ts';
import type { FrameSourceInfo } from './frame-source.ts';
import type { StageName, StageRun } from './run-stages.ts';
import { EXPORT_FORMAT_VERSION } from './export.ts';

export type RunMode = 'joint' | 'separate' | 'apply' | 'single';
export type ErrorCategory = 'out_of_memory' | 'webgpu' | 'decode' | 'worker' | 'unknown';

/** Fields each event may carry. Anything else is dropped before sending. */
export const ALLOWED_FIELDS = {
  file_imported: ['extension'],
  run_started: ['stage', 'mode', 'sessions', 'frames', 'fps', 'width', 'height'],
  run_finished: [
    'stage',
    'mode',
    'sessions',
    'frames',
    'fps',
    'width',
    'height',
    'duration_s',
    'median_fps',
    'cells',
    'peak_wasm_mb',
  ],
  run_failed: ['stage', 'error_category', 'message'],
  boundary_summary: ['boundaries', 'ok', 'warning', 'failed'],
  results_exported: ['sessions', 'format_version'],
  webgpu_info: ['adapter', 'vendor'],
} as const satisfies Partial<Record<AnalyticsEventName, readonly string[]>>;

export type CalaEventName = keyof typeof ALLOWED_FIELDS;

export const MESSAGE_MAX = 200;

const FILE_EXT =
  'avi|mp4|mkv|mov|csv|json|npz|npy|zip|tif|tiff|h5|hdf5|txt|wasm|js|mjs|ts|tsx|png|jpg|jpeg|bin|mat|nwb|log';

/**
 * Remove what could identify a person, a lab or a recording from an error
 * message: URLs, e-mails, Windows and Unix paths, file names, quoted strings
 * (folder and animal names tend to be quoted) and @handles. Collapses
 * whitespace and caps the length at 200 characters.
 */
export function scrubMessage(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, '<url>');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
  s = s.replace(/\b[A-Za-z]:[\\/][^\s'",;)]*/g, '<path>');
  s = s.replace(/\\\\[^\s'",;)]+/g, '<path>');
  s = s.replace(/(?:~|\.{1,2})?(?:\/[^\s/'",;:)]+){1,}\/?/g, '<path>');
  s = s.replace(new RegExp(`[\\w()-]+(?:\\.[\\w()-]+)*\\.(?:${FILE_EXT})\\b`, 'gi'), '<file>');
  s = s.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '<str>');
  s = s.replace(/(^|\s)@[\w.-]+/g, '$1<user>');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX - 3) + '...' : s;
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

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Lowercase extension of a file name, or 'other' when it is not a short alphanumeric one. */
export function fileExtension(name: string | undefined): string {
  const ext = name?.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'other';
}

export interface AdapterLike {
  isFallbackAdapter?: boolean;
  info?: { vendor?: string };
}

/** The webgpu_info payload (adapter class and a short lowercase vendor). */
export function webgpuPayload(adapter: AdapterLike | null): Record<string, unknown> {
  if (!adapter) return { adapter: 'none' };
  const vendor = (adapter.info?.vendor ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .slice(0, 24);
  return {
    adapter: adapter.isFallbackAdapter ? 'fallback' : 'hardware',
    ...(vendor ? { vendor } : {}),
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
  throughput(stage: StageName): number;
  /** Why a stage stopped (raw; scrubbed here). */
  stageError(stage: StageName): string | null;
  /** Bytes of the WASM heap, 0 when not reachable from this thread. */
  heapBytes?(): number;
  boundaryFlags(): readonly BoundaryFlag[];
  /** Multi-session run end: finished or stopped, and the sessions written. */
  runEnded(): boolean;
  sessionsWritten(): number;
  getAdapter?(): Promise<AdapterLike | null>;
  sampleMs?: number;
}

let reportExport: ((sessions: number) => void) | null = null;

/** A results export finished outside a multi-session run (the Export button). */
export function reportResultsExported(sessions: number): void {
  reportExport?.(sessions);
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

  const heap =
    deps.heapBytes ??
    (() => (globalThis as { __calaWasmHeapBytes?: () => number }).__calaWasmHeapBytes?.() ?? 0);

  // ---- webgpu_info: once per session ----
  void (deps.getAdapter ?? defaultAdapter)()
    .then((a) => send('webgpu_info', webgpuPayload(a)))
    .catch(() => send('webgpu_info', { adapter: 'none' }));

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
    return {
      mode: (plan?.settings.mode ?? 'single') satisfies RunMode,
      sessions: plan?.sessions.length ?? 1,
      ...(info && !info.live ? { frames: info.frameCount } : {}),
      ...(info?.fps ? { fps: round(info.fps) } : {}),
      ...(info ? { width: info.width, height: info.height } : {}),
    };
  }

  function sample(stage: StageName, l: Live): void {
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
            // Only when this thread's WASM heap is reachable (0: omitted).
            ...(l && l.peak > 0 ? { peak_wasm_mb: Math.round(l.peak / 1048576) } : {}),
          });
        } else if (r.outcome === 'error') {
          const message = scrubMessage(deps.stageError(r.stage) ?? '');
          send('run_failed', {
            stage: r.stage,
            error_category: errorCategory(deps.stageError(r.stage) ?? ''),
            ...(message ? { message } : {}),
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
  reportExport = (sessions) =>
    send('results_exported', { sessions, format_version: EXPORT_FORMAT_VERSION });
  onCleanup(() => {
    reportExport = null;
  });
}
