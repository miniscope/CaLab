/**
 * The run record: everything needed to know exactly how a processing run was
 * made and to reproduce it. A versioned JSON document saved with every
 * result: `meta_json.run_record` inside each `cala-export.npz`, and as
 * `cala-run-record.json` at the root of an automatic run's results folder
 * (`multi-run.ts`). Documented in docs/run-record.md.
 *
 * Three parts:
 *
 * - `buildRunRecord` is pure: it turns plain data into the document, so the
 *   layout is unit-tested without a browser.
 * - `RunTrace` collects the few things only the run itself can tell
 *   afterwards (when the target speed changed, when the final settle ran).
 * - `gatherRunRecord` reads the live stores and calls the builder.
 *
 * Privacy: no IP address, user identity or file path outside the recording's
 * own file names goes in. A `?live=` URL (a host) is never recorded, only
 * that the flag was present. Nothing here is sent anywhere (no analytics).
 *
 * Extending: the `slots` block holds clearly named places for the later
 * work-slider, curve and auto-mode PRs (`WORK_SLIDER_SLOTS`). A slot is
 * `null` until its feature fills it; add fields under the slot, and bump
 * `RUN_RECORD_VERSION` only when an existing field changes meaning.
 */
import type { GovernorStatus } from './settle.ts';
import type { StageRun } from './run-stages.ts';
import { stageMeta } from './export.ts';

export const RUN_RECORD_FILE = 'cala-run-record.json';
export const RUN_RECORD_FORMAT = 'cala-run-record';
/** Bump when an existing field changes meaning (adding fields does not). */
export const RUN_RECORD_VERSION = 1;

/**
 * Places the later PRs fill. All `null` today; the record always has them so a
 * reader can tell "not run" from "not recorded".
 */
export const WORK_SLIDER_SLOTS = [
  /** The work slider's position over the run, time-stamped. */
  'slider_schedule',
  /** A speed curve (target speed over stream time) and how it was chosen. */
  'curve_schedule',
  /** The estimate of the machine's floor (the fastest sustained rate). */
  'floor_estimate',
  /** Decisions an automatic mode made (what, when, why). */
  'auto_decisions',
] as const;
export type WorkSliderSlot = (typeof WORK_SLIDER_SLOTS)[number];

// ---- URL flags ----

/**
 * The URL flags that change how a run is made, with what they mean here. A
 * flag not in this list is recorded by name only (`other_flags`).
 */
export const KNOWN_FLAGS = [
  'debug',
  'lookback',
  'csettle',
  'csrate',
  'pacefps',
  'lbpool',
  'governor',
  'smooth',
  'pipeline',
  'gpu',
  'flatfield',
  'noqc',
  'visits',
  'compress',
  'review',
  'pass2',
  'live',
] as const;

/** Flags whose value is never written (it can hold a host or address). */
const REDACTED_FLAGS: ReadonlySet<string> = new Set(['live']);

/** What `?debug` gates: these flags only take effect with it. */
const DEBUG_ONLY: ReadonlySet<string> = new Set(['lbpool', 'governor', 'pacefps', 'smooth']);

export interface UrlFlags {
  /** `?debug` is present. */
  debug: boolean;
  /** Each known flag present: its raw value (`''` for a bare flag; `'(redacted)'` for `live`) and whether it is in effect. */
  flags: Record<string, { value: string; in_effect: boolean }>;
  /** Names of other query parameters (values not recorded). */
  other_flags: string[];
}

/** Read the flags in a query string (`location.search`). */
export function urlFlags(search: string): UrlFlags {
  const p = new URLSearchParams(search);
  const debug = p.has('debug');
  const known = new Set<string>(KNOWN_FLAGS);
  const flags: UrlFlags['flags'] = {};
  const other: string[] = [];
  for (const [k, v] of p) {
    if (known.has(k)) {
      flags[k] = {
        value: REDACTED_FLAGS.has(k) ? '(redacted)' : v,
        in_effect: DEBUG_ONLY.has(k) ? debug : true,
      };
    } else if (!other.includes(k)) other.push(k);
  }
  return { debug, flags, other_flags: other };
}

// ---- Machine ----

export interface GpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface MachineContext {
  hardware_concurrency: number | null;
  device_memory_gb: number | null;
  /** From the browser's user agent data when it has any (platform and brand only). */
  platform: string | null;
  user_agent: string | null;
  gpu: GpuInfo | null;
  webgpu: boolean;
}

let gpuCache: GpuInfo | null = null;
let engineVersionCache: string | null = null;

/**
 * Ask once, early, for what the record needs but cannot get synchronously: the
 * GPU adapter's description and the WASM engine's version. Best effort: a
 * missing WebGPU or WASM module leaves them null. Call at app start.
 */
export async function primeRunRecordContext(
  loadEngineVersion?: () => Promise<string>,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const gpu = (
          navigator as unknown as {
            gpu?: {
              requestAdapter(): Promise<{
                info?: Partial<GpuInfo>;
              } | null>;
            };
          }
        ).gpu;
        const adapter = gpu ? await gpu.requestAdapter() : null;
        const i = adapter?.info;
        if (i)
          gpuCache = {
            vendor: i.vendor ?? '',
            architecture: i.architecture ?? '',
            device: i.device ?? '',
            description: i.description ?? '',
          };
      } catch {
        // No adapter information: recorded as null.
      }
    })(),
    (async () => {
      try {
        if (loadEngineVersion) engineVersionCache = await loadEngineVersion();
      } catch {
        // The engine's version stays unknown (null).
      }
    })(),
  ]);
}

/** The engine version primed by `primeRunRecordContext` (null: not known). */
export function engineVersion(): string | null {
  return engineVersionCache;
}

/** Test hook. */
export function resetRunRecordContext(): void {
  gpuCache = null;
  engineVersionCache = null;
}

export function machineContext(): MachineContext {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ext = nav as unknown as
    | {
        deviceMemory?: number;
        gpu?: unknown;
        userAgentData?: { platform?: string };
      }
    | undefined;
  return {
    hardware_concurrency: nav?.hardwareConcurrency ?? null,
    device_memory_gb: ext?.deviceMemory ?? null,
    platform: ext?.userAgentData?.platform ?? nav?.platform ?? null,
    user_agent: nav?.userAgent ?? null,
    gpu: gpuCache,
    webgpu: ext?.gpu !== undefined,
  };
}

// ---- Time-stamped events only the run knows ----

export interface TargetSpeedChange {
  /** ISO time of the change. */
  at: string;
  /** Frame the run had processed when it changed. */
  frame: number;
  /** Target frames per second (0: Max, unpaced). */
  fps: number;
  /** What set it (`url`, `run start`, `slider`, ...). */
  source: string;
}

export interface SettleTimes {
  /** ISO time the final settle started and ended (null: not yet / not run). */
  started_at: string | null;
  ended_at: string | null;
}

/**
 * Collects what the stores do not keep: target speed changes and the final
 * settle's wall times. One per app; `reset()` at each Discover start.
 */
export class RunTrace {
  private speed: TargetSpeedChange[] = [];
  private settle: SettleTimes = { started_at: null, ended_at: null };

  constructor(private readonly now: () => Date = () => new Date()) {}

  reset(): void {
    this.speed = [];
    this.settle = { started_at: null, ended_at: null };
  }

  /** The target speed is `fps` now (0: Max). Repeats of the same value are not recorded again. */
  noteTargetSpeed(fps: number, frame: number, source: string): void {
    const last = this.speed[this.speed.length - 1];
    if (last && last.fps === fps) return;
    this.speed.push({ at: this.now().toISOString(), frame, fps, source });
  }

  /** The final settle is `running` (or finished: `done`); times are stamped on the first sight of each. */
  noteSettle(s: { running: boolean; done: boolean }): void {
    if (s.running && this.settle.started_at === null)
      this.settle.started_at = this.now().toISOString();
    if (s.done && this.settle.ended_at === null) {
      this.settle.started_at ??= this.now().toISOString();
      this.settle.ended_at = this.now().toISOString();
    }
  }

  targetSpeedChanges(): readonly TargetSpeedChange[] {
    return this.speed;
  }

  settleTimes(): SettleTimes {
    return { ...this.settle };
  }
}

// ---- The record ----

/** The final settle, as the slow worker reported it. */
export interface SettleSummary {
  /** Frames fed through the settle, of those planned. */
  fed: number;
  planned: number;
  /** Frames in the recording. */
  recording: number;
  /** The user stopped it early. */
  stopped_by_user: boolean;
  done: boolean;
}

/** Everything `buildRunRecord` needs, as plain data. */
export interface RunRecordInput {
  createdAt: string;
  appVersion: string;
  /** Git commit of the build (null: not in the build). */
  commit: string | null;
  engineVersion: string | null;
  /** `location.search`. */
  search: string;
  /** User-facing settings and their values, defaults included. */
  settings: Record<string, unknown>;
  /** Fixed engine tunables worth keeping (`CSETTLE`, `GOVERNOR`, `SETTLE`). */
  tunables?: Record<string, unknown>;
  input: {
    label: string;
    live: boolean;
    frames: number | null;
    fps: number | null;
    width: number;
    height: number;
    bitDepth: number;
    files: { name: string; frames?: number; size?: number }[];
    sessions: {
      index: number;
      name: string;
      start_frame: number;
      frames: number;
      fps: number | null;
    }[];
    mode: string | null;
  };
  stages: readonly StageRun[];
  settle: SettleSummary | null;
  settleTimes: SettleTimes;
  targetSpeed: readonly TargetSpeedChange[];
  /** Work shape: the settle ceiling (cap), look-back workers (pool), visit workers. */
  work: {
    cap: number | null;
    pool: number | null;
    visit_workers: number | null;
    governor_on: boolean;
  };
  governor: GovernorStatus | null;
  /** Discover's mean processing rate over the run, frames per second (null: not known). */
  achievedFps: number | null;
  machine: MachineContext;
  /** What the later PRs fill (`WORK_SLIDER_SLOTS`); absent slots are written as null. */
  slots?: Partial<Record<WorkSliderSlot, unknown>>;
}

/** The run record document (snake_case JSON). */
export function buildRunRecord(i: RunRecordInput): Record<string, unknown> {
  const flags = urlFlags(i.search);
  const slots: Record<string, unknown> = {};
  for (const k of WORK_SLIDER_SLOTS) slots[k] = i.slots?.[k] ?? null;
  const gov = i.governor;
  return {
    format: RUN_RECORD_FORMAT,
    record_version: RUN_RECORD_VERSION,
    created: i.createdAt,
    software: {
      app: 'cala',
      app_version: i.appVersion,
      git_commit: i.commit,
      engine: 'calab_cala (WASM)',
      engine_version: i.engineVersion,
    },
    settings: i.settings,
    ...(i.tunables ? { tunables: i.tunables } : {}),
    url_flags: flags,
    input: i.input,
    stages: i.stages.map(stageMeta),
    final_settle: {
      ...(i.settle
        ? {
            frames_fed: i.settle.fed,
            frames_planned: i.settle.planned,
            recording_frames: i.settle.recording,
            stopped_early_by_user: i.settle.stopped_by_user,
            done: i.settle.done,
          }
        : { frames_fed: null, stopped_early_by_user: null, done: false }),
      started_at: i.settleTimes.started_at,
      ended_at: i.settleTimes.ended_at,
    },
    target_speed: {
      /** Time-stamped; fps 0 is Max (unpaced). */
      changes: i.targetSpeed.map((c) => ({ ...c })),
    },
    work: {
      ...i.work,
      achieved_fps: i.achievedFps,
      governor: gov
        ? {
            rate_fps: gov.rate,
            limit: gov.limit,
            target_fps: gov.target,
            achieved_fps: gov.achieved,
            cap: gov.cap,
            cap_fps: gov.capFps,
            delivered_fps: gov.deliveredFps,
            busy_share: gov.busy,
            halvings: gov.halvings,
            slow_halvings: gov.slowHalvings,
          }
        : null,
    },
    machine: i.machine,
    slots,
  };
}

// ---- Gathering from the live stores ----

/** What `gatherRunRecord` reads; structural so tests need no stores. */
export interface RunRecordSources {
  appVersion: string;
  commit: string | null;
  search: string;
  now?: () => Date;
  trace: RunTrace;
  pipeline: {
    flatEnabled(): boolean;
    discover(): boolean;
    residual(): boolean;
    lookback(): boolean;
    csettle(): boolean;
    csettleCeiling(): number;
    csettleYield(): number;
    csettleGovernor(): boolean;
    paceFps(): number;
    smoothPlayback(): boolean;
    fps(): number;
  };
  slowStatus(): {
    lookback?: {
      settle?: { fed: number; total: number; recording: number; stopped: boolean; done: boolean };
      settling?: boolean;
      csettle?: { governor?: GovernorStatus };
    };
  } | null;
  stageRuns(): readonly StageRun[];
  info(): {
    frameCount: number;
    fps: number | null;
    width: number;
    height: number;
    bitDepth: number;
    live?: unknown;
    files: { name: string; frames: number }[];
    sessions?: {
      index: number;
      name: string;
      startFrame: number;
      frameCount: number;
      fps: number | null;
    }[];
  } | null;
  label(): string;
  /** Sizes (bytes) of the source files by name (empty when not known). */
  fileSizes(): ReadonlyMap<string, number>;
  /** Workers: look-back pool size and visit workers. */
  lookbackWorkers(): number;
  visitWorkers(): number;
  tunables?: Record<string, unknown>;
}

/** Settings that live in a panel rather than a store (`RunPanel`, the session setup). */
export interface RunRecordExtras {
  /** Joint or Separate (a recording of several sessions). */
  mode?: string;
  refineRuns?: number;
  /** "Extract after Discover". */
  extractAfterDiscover?: boolean;
  /** Export only cells that pass QC. */
  passQcOnly?: boolean;
  slots?: Partial<Record<WorkSliderSlot, unknown>>;
}

export function gatherRunRecord(src: RunRecordSources, extras: RunRecordExtras = {}) {
  const p = src.pipeline;
  const info = src.info();
  const st = src.slowStatus();
  const settle = st?.lookback?.settle;
  const sizes = src.fileSizes();
  const record = buildRunRecord({
    createdAt: (src.now ?? (() => new Date()))().toISOString(),
    appVersion: src.appVersion,
    commit: src.commit,
    engineVersion: engineVersion(),
    search: src.search,
    settings: {
      flat_field: p.flatEnabled(),
      discovery: p.discover(),
      residual_preview: p.residual(),
      lookback: p.lookback(),
      settle_during_discover: p.csettle(),
      settle_ceiling_per_live_frame: p.csettleCeiling(),
      settle_yield_frames: p.csettleYield(),
      settle_governor: p.csettleGovernor(),
      target_speed_fps: p.paceFps(),
      smooth_playback: p.smoothPlayback(),
      ...(extras.mode !== undefined ? { library_mode: extras.mode } : {}),
      ...(extras.refineRuns !== undefined ? { refine_runs: extras.refineRuns } : {}),
      ...(extras.extractAfterDiscover !== undefined
        ? { extract_after_discover: extras.extractAfterDiscover }
        : {}),
      ...(extras.passQcOnly !== undefined ? { export_pass_qc_only: extras.passQcOnly } : {}),
    },
    ...(src.tunables ? { tunables: src.tunables } : {}),
    input: {
      label: src.label(),
      live: info?.live !== undefined,
      frames: info && Number.isFinite(info.frameCount) ? info.frameCount : null,
      fps: info?.fps ?? null,
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      bitDepth: info?.bitDepth ?? 0,
      files: (info?.files ?? []).map((f) => {
        const size = sizes.get(f.name);
        return { name: f.name, frames: f.frames, ...(size !== undefined ? { size } : {}) };
      }),
      sessions: (info?.sessions ?? []).map((s) => ({
        index: s.index,
        name: s.name,
        start_frame: s.startFrame,
        frames: s.frameCount,
        fps: s.fps,
      })),
      mode: extras.mode ?? null,
    },
    stages: src.stageRuns(),
    settle: settle
      ? {
          fed: settle.fed,
          planned: settle.total,
          recording: settle.recording,
          stopped_by_user: settle.stopped,
          done: settle.done,
        }
      : null,
    settleTimes: src.trace.settleTimes(),
    targetSpeed: src.trace.targetSpeedChanges(),
    work: {
      cap: p.csettleCeiling(),
      pool: src.lookbackWorkers(),
      visit_workers: src.visitWorkers(),
      governor_on: p.csettleGovernor(),
    },
    governor: st?.lookback?.csettle?.governor ?? null,
    achievedFps: p.fps() > 0 ? p.fps() : null,
    machine: machineContext(),
    ...(extras.slots ? { slots: extras.slots } : {}),
  });
  return record;
}

// ---- Reproducing from a record ----

/**
 * The URL-flag and setting changes that re-apply a record's settings (what
 * `?debug&record=` does). Pure: returns what to set; the app applies it.
 * Unknown or malformed records give `null`.
 */
export interface AppliedSettings {
  flatField?: boolean;
  discover?: boolean;
  lookback?: boolean;
  csettle?: boolean;
  csettleCeiling?: number;
  csettleYield?: number;
  csettleGovernor?: boolean;
  paceFps?: number;
  smoothPlayback?: boolean;
}

export function settingsFromRecord(rec: unknown): AppliedSettings | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.format !== RUN_RECORD_FORMAT) return null;
  if (typeof r.record_version !== 'number' || r.record_version > RUN_RECORD_VERSION) return null;
  const s = r.settings;
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const out: AppliedSettings = {};
  const bool = (k: string, to: keyof AppliedSettings) => {
    if (typeof o[k] === 'boolean') (out as Record<string, unknown>)[to] = o[k];
  };
  const num = (k: string, to: keyof AppliedSettings) => {
    if (typeof o[k] === 'number' && Number.isFinite(o[k]))
      (out as Record<string, unknown>)[to] = o[k];
  };
  bool('flat_field', 'flatField');
  bool('discovery', 'discover');
  bool('lookback', 'lookback');
  bool('settle_during_discover', 'csettle');
  num('settle_ceiling_per_live_frame', 'csettleCeiling');
  num('settle_yield_frames', 'csettleYield');
  bool('settle_governor', 'csettleGovernor');
  num('target_speed_fps', 'paceFps');
  bool('smooth_playback', 'smoothPlayback');
  return out;
}
