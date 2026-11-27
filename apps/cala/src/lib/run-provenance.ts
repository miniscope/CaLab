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
import { visitRateSetting, type VisitRateSummary } from './visit-rate.ts';
import type { SettleVisits } from '../workers/lookback-types.ts';
import { FINAL_SETTLE_LEVELS, type FinalSettleLevel, type GovernorStatus } from './settle.ts';
import type { StageRun } from './run-stages.ts';
import { stageMeta } from './export.ts';
import { factorsFromPage } from './factor-run.ts';
import { FLOOR_LADDER, type FloorInputs } from './speed-floor.ts';
import { SPEED_SCALE } from './speed-track.ts';
import type { SpeedCurve } from './speed-schedule.ts';
import type { AutoDecision } from './speed-auto.ts';

export const RUN_RECORD_FILE = 'cala-run-record.json';
export const RUN_RECORD_FORMAT = 'cala-run-record';
/** Bump when an existing field changes meaning (adding fields does not). */
export const RUN_RECORD_VERSION = 2;

/**
 * Places the later PRs fill. All `null` today; the record always has them so a
 * reader can tell "not run" from "not recorded".
 */
export const WORK_SLIDER_SLOTS = [
  /** The Speed track the run was made with (scale and the floor's ladder); the position over the run is `target_speed.changes`. */
  'slider_schedule',
  /** A speed curve (target speed over stream time) and how it was chosen. */
  'curve_schedule',
  /** The smart floor over the run: its first value, each published change, and the last inputs. */
  'floor_estimate',
  /** Decisions an automatic mode made (what, when, why). */
  'auto_decisions',
  /** Auto's time budget: the extra time over a Max run, as a share (1 is +100 %). */
  'auto_extra_time_share',
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
  'lbpoolmax',
  'settlevisits',
  'cpool',
  'cbacklog',
  'fextract',
  'fwait',
  'gpucheck',
  'needfirst',
  'smooth',
  'pipeline',
  'gpu',
  'flatfield',
  'noqc',
  'visits',
  'compress',
  'factors',
  'review',
  'pass2',
  'live',
  'visitrate',
] as const;

/** Flags whose value is never written (it can hold a host or address). */
const REDACTED_FLAGS: ReadonlySet<string> = new Set(['live']);

/** What `?debug` gates: these flags only take effect with it. */
const DEBUG_ONLY: ReadonlySet<string> = new Set([
  'lbpool',
  'lbpoolmax',
  'settlevisits',
  'cpool',
  'cbacklog',
  'fextract',
  'fwait',
  'gpucheck',
  'needfirst',
  'pacefps',
  'smooth',
  'visitrate',
]);

/**
 * Whether a flag changes anything given the others (`App.tsx` reads them the
 * same way): look-back is on by default, so only `lookback=0` changes anything (off); `csettle` changes something only as
 * `csettle=0` (Background settle off) or `csettle=yieldN`, and needs look-back;
 * `review` needs `compress` and no `factors` other than `factors=0`; `visitrate` only as `off` or `auto`;
 * debug-only flags need `?debug`.
 */
function inEffect(name: string, value: string, p: URLSearchParams): boolean {
  if (DEBUG_ONLY.has(name) && !p.has('debug')) return false;
  const lookbackOn = p.get('lookback') !== '0';
  switch (name) {
    case 'lookback':
      return value === '0';
    case 'csettle':
      return lookbackOn && (value === '0' || /^yield\d*$/.test(value));
    case 'csrate':
      return lookbackOn;
    case 'needfirst':
      return value !== '0';
    case 'visitrate':
      // `off` and `auto` change the run (App.tsx: `visitRateSetting`); anything else is the fixed default.
      return visitRateSetting(value) !== 'fixed';
    case 'review':
      return factorsFromPage(p).review;
    default:
      return true;
  }
}

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
        in_effect: inEffect(k, v, p),
      };
    } else if (!other.includes(k)) other.push(k);
  }
  return { debug, flags, other_flags: other };
}

// ---- Machine ----

/** The GPU adapter class only (no device or driver strings). */
export interface GpuInfo {
  vendor: string;
  architecture: string;
}

export interface BrowserInfo {
  /** Brand and major version, e.g. `Chromium 142`. */
  brands: { brand: string; version: string }[];
  platform: string | null;
}

export interface MachineContext {
  hardware_concurrency: number | null;
  device_memory_gb: number | null;
  browser: BrowserInfo;
  /** The adapter WebGPU offers (high-performance). Which backend actually ran is `runtime.motion_backend`. */
  gpu_adapter: GpuInfo | null;
  webgpu: boolean;
}

let gpuCache: GpuInfo | null = null;

/**
 * Ask once, early, for the GPU adapter's class (the record is built
 * synchronously). Best effort: no WebGPU leaves it null. Call at app start.
 */
export async function primeRunRecordContext(): Promise<void> {
  try {
    const gpu = (
      navigator as unknown as {
        gpu?: {
          requestAdapter(o?: {
            powerPreference?: string;
          }): Promise<{ info?: Partial<GpuInfo> } | null>;
        };
      }
    ).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    const i = adapter?.info;
    if (i) gpuCache = { vendor: i.vendor ?? '', architecture: i.architecture ?? '' };
  } catch {
    // No adapter information: recorded as null.
  }
}

/** Test hook. */
export function resetRunRecordContext(): void {
  gpuCache = null;
}

/** Browser brands from `userAgentData`, else a coarse name and major version from the user agent. */
export function browserInfo(nav: {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] };
}): BrowserInfo {
  const uad = nav.userAgentData;
  if (uad?.brands && uad.brands.length > 0)
    return {
      brands: uad.brands.map((b) => ({ brand: b.brand, version: b.version })),
      platform: uad.platform ?? null,
    };
  const ua = nav.userAgent ?? '';
  // Order matters: Edge and Chrome both say Chrome, Chrome and Safari both say Safari.
  const m =
    /(Edg)\/(\d+)/.exec(ua) ??
    /(Firefox)\/(\d+)/.exec(ua) ??
    /(Chrome)\/(\d+)/.exec(ua) ??
    /Version\/(\d+).*(Safari)/.exec(ua);
  const brands = !m
    ? []
    : m[1] === 'Edg'
      ? [{ brand: 'Edge', version: m[2] }]
      : m[2] === 'Safari'
        ? [{ brand: 'Safari', version: m[1] }]
        : [{ brand: m[1], version: m[2] }];
  return { brands, platform: nav.platform ?? null };
}

export function machineContext(): MachineContext {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ext = nav as unknown as { deviceMemory?: number; gpu?: unknown } | undefined;
  return {
    hardware_concurrency: nav?.hardwareConcurrency ?? null,
    device_memory_gb: ext?.deviceMemory ?? null,
    browser: browserInfo(nav ?? {}),
    gpu_adapter: gpuCache,
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

export interface CapChange {
  /** ISO time of the change. */
  at: string;
  /** Frame the run had processed when it changed. */
  frame: number;
  /** The settle cap, re-read frames per live frame (0: Off). */
  cap: number;
  /** What set it (`run start`, `setting`, `url`, ...). */
  source: string;
}

/** One published change of the smart floor (`FloorTracker.published`), with what the raw estimate rested on. */
export interface FloorChange {
  /** ISO time of the change. */
  at: string;
  /** Frame the run had processed when it changed. */
  frame: number;
  /** The published (ladder) floor, fps. */
  fps: number;
  /** The rate below which the slow loop sees every live frame, fps. */
  seeAllFps: number;
  /** Which user of spare compute sets the floor. */
  limiting: string;
  confidence: string;
  /** Each term's saturation rate, fps (null: not known or dropped). */
  terms: Record<string, number | null>;
}

/** The curve a run followed (the record's `curve_schedule` slot). */
export interface CurveRecord {
  /** The preset it started from (`custom` or `replay` otherwise). */
  preset: string;
  /** As set. */
  points: SpeedCurve['points'];
  /** As run: steps too short for the governor's ramp merged (equal to `points` for a replay). */
  effective_points: SpeedCurve['points'];
  /** The frame the curve took over at (0: from the start). */
  armed_at_frame: number;
}

/** What `RunTrace.noteSample` takes, once a second or so from the pipeline store while the slow loop reports. */
export interface WorkSample {
  /** Frame the run had processed. */
  frame: number;
  /** The settle governor's limit now (null: no governor, e.g. a run at Max). */
  limit: string | null;
  /**
   * The run's top speed as the Speed block shows it (Max), fps (null: not known yet): the fast
   * loop's, lowered to what the visits allow while the visit rate holds the run.
   */
  maxFps: number | null;
  /** The fast loop's own live estimate of its top speed, fps (null: not known; absent: as `maxFps`). */
  fastMaxFps?: number | null;
  /** The floor as the Speed control shows it. */
  floor: {
    fps: number;
    published: number | null;
    seeAllFps: number;
    limiting: string;
    confidence: string;
    terms: Record<string, number | null>;
  };
  /** The inputs the floor's raw estimate was last made from (null: none yet). */
  floorInputs: FloorInputs | null;
  /** The published floor changed with this reading. */
  floorChanged: boolean;
  /** Discover is still going (false once it ended, in the Final settle): the limit and Max counts stop. */
  running: boolean;
  /**
   * Cumulative counts of this Discover run, so the record keeps them after Extract
   * (the slow worker's accounting and the pacer's readouts belong to the run that is current).
   */
  counters: RunCounters;
}

/** What `work.realised` is made from: the run's cumulative counts as of the latest reading. */
export interface RunCounters {
  /** Frames Discover has processed. */
  processed: number;
  /** Live frames the slow loop has observed (null: not reported). */
  observed: number | null;
  /** Re-read frames Background settle has delivered. */
  settledFrames: number | null;
  /** Frames the fast loop did not forward to the slow loop. */
  forwardDrops: number | null;
  /** Pacer: lateness dropped at re-anchors (ms) and the re-anchors (null: it never paced). */
  paceLateMs: number | null;
  paceReanchors: number | null;
  halvings: number | null;
  slowHalvings: number | null;
}

/** Floor rows and Max samples kept; past this the oldest half is thinned (every second one kept). */
export const RECORD_LIST_CAP = 2000;

/** Thin the oldest half of `rows` (keep every second one) once it is over `cap`; the newest stay whole. */
function median(xs: readonly number[]): number | null {
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function thinOldest<T>(rows: T[], cap = RECORD_LIST_CAP): T[] {
  if (rows.length <= cap) return rows;
  const half = rows.length >> 1;
  return [...rows.slice(0, half).filter((_, i) => i % 2 === 1), ...rows.slice(half)];
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
  private pool: { workers: number; frame: number; forFinal: boolean } | null = null;
  private caps: CapChange[] = [];
  private floorStart: { fps: number; confidence: string } | null = null;
  private floorRows: FloorChange[] = [];
  private floorLast: FloorInputs | null = null;
  private limitCounts: Record<string, number> = {};
  private maxSamples: number[] = [];
  private fastMaxSamples: number[] = [];
  private counts: RunCounters | null = null;
  private curveRec: CurveRecord | null = null;
  private autoRec: { extraTimeShare: number; decisions: AutoDecision[] } | null = null;
  private visitRec: VisitRateSummary | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  reset(): void {
    this.speed = [];
    this.settle = { started_at: null, ended_at: null };
    this.pool = null;
    this.caps = [];
    this.floorStart = null;
    this.floorRows = [];
    this.floorLast = null;
    this.limitCounts = {};
    this.maxSamples = [];
    this.fastMaxSamples = [];
    this.counts = null;
    this.curveRec = null;
    this.autoRec = null;
    this.visitRec = null;
  }

  /** The Discover visit rate's summary as of now (the latest one is the record's). */
  noteVisitRate(s: VisitRateSummary | null): void {
    this.visitRec = s ? { ...s, hold_changes: s.hold_changes.map((c) => ({ ...c })) } : null;
  }

  visitRate(): VisitRateSummary | null {
    return this.visitRec
      ? { ...this.visitRec, hold_changes: this.visitRec.hold_changes.map((c) => ({ ...c })) }
      : null;
  }

  /** Auto armed or decided (the run's own copy: a later change of Speed must not lose it). */
  noteAuto(a: { extraTimeShare: number; decisions: readonly AutoDecision[] } | null): void {
    this.autoRec = a
      ? { extraTimeShare: a.extraTimeShare, decisions: a.decisions.map((d) => ({ ...d })) }
      : null;
  }

  auto(): { extraTimeShare: number; decisions: AutoDecision[] } | null {
    return this.autoRec
      ? {
          extraTimeShare: this.autoRec.extraTimeShare,
          decisions: this.autoRec.decisions.map((d) => ({ ...d })),
        }
      : null;
  }

  /** A speed curve took over the target (at the start or mid-run); the latest one is the record's. */
  noteCurve(c: CurveRecord | null): void {
    this.curveRec = c ? { ...c } : null;
  }

  curve(): CurveRecord | null {
    return this.curveRec ? { ...this.curveRec } : null;
  }

  /** The run's counts as of the last reading of Discover's run (null: none read). */
  counters(): RunCounters | null {
    return this.counts ? { ...this.counts } : null;
  }

  /**
   * One reading of the work and the floor. The first sets the floor's start value (usually the
   * prior); a published change adds a row; the governor's limit and the Max estimate are counted
   * for the run's realised summary.
   */
  noteSample(s: WorkSample): void {
    this.floorStart ??= { fps: s.floor.fps, confidence: s.floor.confidence };
    if (s.floorInputs) this.floorLast = { ...s.floorInputs };
    if (s.floorChanged && s.floor.published !== null) {
      this.floorRows.push({
        at: this.now().toISOString(),
        frame: s.frame,
        fps: s.floor.published,
        seeAllFps: s.floor.seeAllFps,
        limiting: s.floor.limiting,
        confidence: s.floor.confidence,
        terms: { ...s.floor.terms },
      });
      this.floorRows = thinOldest(this.floorRows);
    }
    this.counts = { ...s.counters };
    if (!s.running) return;
    if (s.limit !== null) this.limitCounts[s.limit] = (this.limitCounts[s.limit] ?? 0) + 1;
    if (s.maxFps !== null && s.maxFps > 0) {
      this.maxSamples.push(s.maxFps);
      this.maxSamples = thinOldest(this.maxSamples);
    }
    const fast = s.fastMaxFps === undefined ? s.maxFps : s.fastMaxFps;
    if (fast !== null && fast > 0) {
      this.fastMaxSamples.push(fast);
      this.fastMaxSamples = thinOldest(this.fastMaxSamples);
    }
  }

  /** The floor over the run, or null when nothing was read. */
  floorEstimate(): {
    start: { fps: number; confidence: string };
    changes: FloorChange[];
    last_inputs: FloorInputs | null;
  } | null {
    if (!this.floorStart) return null;
    return {
      start: { ...this.floorStart },
      changes: this.floorRows.map((c) => ({ ...c, terms: { ...c.terms } })),
      last_inputs: this.floorLast ? { ...this.floorLast } : null,
    };
  }

  /** Share of the readings each governor limit held (sums to 1; empty without a governor). */
  limitShares(): Record<string, number> {
    const total = Object.values(this.limitCounts).reduce((a, b) => a + b, 0);
    const out: Record<string, number> = {};
    if (total > 0) for (const [k, n] of Object.entries(this.limitCounts)) out[k] = n / total;
    return out;
  }

  /** The median of the Max estimates read (the run's top speed, as shown), fps (null: none). */
  maxFpsMedian(): number | null {
    return median(this.maxSamples);
  }

  /** The median of the fast loop's own top-speed estimates, fps (null: none). */
  fastMaxFpsMedian(): number | null {
    return median(this.fastMaxSamples);
  }

  /** The settle cap is `cap` now (0: Off). Repeats of the same value are not recorded again. */
  noteCap(cap: number, frame: number, source: string): void {
    const last = this.caps[this.caps.length - 1];
    if (last && last.cap === cap) return;
    this.caps.push({ at: this.now().toISOString(), frame, cap, source });
  }

  capChanges(): readonly CapChange[] {
    return this.caps;
  }

  /**
   * The run's settle pool started with `workers` workers at `frame` (the first start counts);
   * `forFinal`: at Discover's end, for the Final settle on the factors (else below Max, for the
   * Background settle).
   */
  notePoolStart(workers: number, frame: number, forFinal = false): void {
    this.pool ??= { workers, frame, forFinal };
  }

  /** The settle pool this run started (null: none). */
  poolStart(): { workers: number; frame: number; forFinal: boolean } | null {
    return this.pool ? { ...this.pool } : null;
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
  /** What it read (`factors`, or `file` after a switch; null: the recording, no factors in the run). */
  source?: 'factors' | 'file' | null;
  /** Look-back workers that served it (absent: not reported). */
  workers?: number;
  /** Its tile visits on the visit workers (`SettleVisits`; absent without visit workers). */
  visits?: SettleVisits;
}

/** The Final settle's visits for the record (snake_case; per frame over the frames fed). */
function settleVisitsRecord(v: SettleVisits, fed: number): Record<string, number | null> {
  return {
    handed_out: v.handed,
    per_frame: fed > 0 ? v.handed / fed : null,
    paid_at_end: v.paidAtEnd,
    unpaid: v.unpaid,
    owed_max: v.owedMax,
    holds: v.holds,
    held_s: v.heldMs / 1000,
    starved: v.starved,
    final_round: v.finalRound,
  };
}

/** What a run realised, as against what was set (section 5 of the speed control design). Null where not known. */
export interface RealisedWork {
  /** Discover's frames over its wall time, fps. */
  achieved_fps_mean: number | null;
  /** Re-read frames the Background settle delivered per live frame of Discover. */
  dose_per_live_frame: number | null;
  /** Live frames the slow loop never observed (the fast loop ran ahead of it). */
  frames_missed_by_slow_loop: number | null;
  /** Frames the fast loop did not forward to the slow loop. */
  forward_drops: number | null;
  halvings: number | null;
  slow_halvings: number | null;
  /** Share of the readings each governor limit held. */
  limit_shares: Record<string, number>;
  /** Lateness the pacer dropped at re-anchors, ms, and how often it re-anchored. */
  pace_late_ms: number | null;
  pace_reanchors: number | null;
  /**
   * Median of the live Max estimate, fps: the run's top speed as the Speed block showed it (with
   * the visit rate on, lowered to what the visits allow while they hold the run).
   */
  max_fps_median: number | null;
  /** Median of the fast loop's own top-speed estimate, fps (equal to `max_fps_median` with the visit rate off). */
  fast_max_fps_median?: number | null;
}

/** The Speed block's mode for a run: `stream` for a live source, else what was set. */
export function speedModeOf(o: {
  live: boolean;
  targetSpeed: readonly TargetSpeedChange[];
  /** A speed curve was set (`slots.curve_schedule`). */
  curve: boolean;
  /** An automatic mode took part (a change with source `auto`). */
  auto?: boolean;
}): 'max' | 'fixed' | 'curve' | 'auto' | 'stream' {
  if (o.live) return 'stream';
  if (o.auto || o.targetSpeed.some((c) => c.source === 'auto')) return 'auto';
  if (o.curve) return 'curve';
  return (o.targetSpeed[0]?.fps ?? 0) > 0 ? 'fixed' : 'max';
}

/** The Speed track as the run had it (the record's `slider_schedule` slot). */
export function sliderSchedule(): { scale: [number, number]; ladder: number[] } {
  return { scale: [SPEED_SCALE.lo, SPEED_SCALE.hi], ladder: [...FLOOR_LADDER] };
}

/** Everything `buildRunRecord` needs, as plain data. */
/** A source file: position in its folder (video order), name and size in bytes. */
export interface RecordFile {
  position: number;
  name: string;
  frames?: number;
  size?: number;
}

export interface RunRecordInput {
  createdAt: string;
  appVersion: string;
  /** Git commit of the build (null: not in the build) and whether the tree had uncommitted changes. */
  commit: string | null;
  gitDirty: boolean | null;
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
    /** A plain folder's files (a multi-session recording lists them per session). */
    files: RecordFile[];
    sessions: {
      index: number;
      name: string;
      start_frame: number;
      frames: number;
      fps: number | null;
      files: RecordFile[];
    }[];
    mode: string | null;
    /** Separate: the 0-based session this record belongs to. */
    session_index: number | null;
    fps_source: string | null;
  };
  /** What actually ran. */
  runtime: {
    motion_backend: string | null;
    flat_field: { enabled: boolean; reused_from_cache: boolean; key_source: string | null };
  };
  stages: readonly StageRun[];
  settle: SettleSummary | null;
  settleTimes: SettleTimes;
  targetSpeed: readonly TargetSpeedChange[];
  capChanges: readonly CapChange[];
  /** Work shape: the settle cap (0: Off), look-back workers in the run (1 + the pool started), visit workers. */
  work: {
    cap: number | null;
    pool: number | null;
    visit_workers: number | null;
  };
  governor: GovernorStatus | null;
  /** What the run realised (null: not known); `work.realised`. */
  realised?: RealisedWork | null;
  /** The Discover visit rate: its floor, target and cap and what the run achieved (`work.visit_rate`; null: not a Discover run). */
  visitRate?: VisitRateSummary | null;
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
      git_dirty: i.gitDirty,
      engine: 'calab_cala (WASM)',
      engine_version: i.engineVersion,
    },
    settings: i.settings,
    ...(i.tunables ? { tunables: i.tunables } : {}),
    url_flags: flags,
    input: i.input,
    runtime: i.runtime,
    stages: i.stages.map(stageMeta),
    final_settle: {
      ...(i.settle
        ? {
            frames_fed: i.settle.fed,
            frames_planned: i.settle.planned,
            recording_frames: i.settle.recording,
            stopped_early_by_user: i.settle.stopped_by_user,
            done: i.settle.done,
            source: i.settle.source ?? null,
            lookback_workers: i.settle.workers ?? null,
            // Visits per settle frame: the rate (0: none, visits whenever a worker is free) and what the pass made.
            visit_rate: i.settle.visits?.rate ?? null,
            visits: i.settle.visits ? settleVisitsRecord(i.settle.visits, i.settle.fed) : null,
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
      realised: i.realised ?? null,
      visit_rate: i.visitRate ?? null,
      /** Time-stamped; cap 0 is Off. The first entry is the cap at the run's start. */
      cap_changes: i.capChanges.map((c) => ({ ...c })),
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
  gitDirty: boolean | null;
  /** The WASM engine's version, defined at build time (null: unknown). */
  engineVersion: string | null;
  search: string;
  now?: () => Date;
  trace: RunTrace;
  pipeline: {
    flatEnabled(): boolean;
    discover(): boolean;
    residual(): boolean;
    lookback(): boolean;
    /** Look-back actually ran in the current run (the setting can be on while it is blocked). */
    lookbackRun?(): boolean;
    csettle(): boolean;
    csettleCeiling(): number;
    csettleYield(): number;
    csettleNeedFirst(): boolean;
    finalSettleLevel(): string;
    paceFps(): number;
    smoothPlayback(): boolean;
    motionBackend(): string | null;
    flatField(): { reused: boolean; keySource: string | null };
  };
  slowStatus(): {
    lookback?: {
      settle?: {
        fed: number;
        total: number;
        recording: number;
        stopped: boolean;
        done: boolean;
        source?: 'factors' | 'file';
        workers?: number;
        visits?: SettleVisits;
      };
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
    fpsSource?: string;
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
  /**
   * Sizes (bytes) of the source files: for a plain folder by name (unique in
   * a folder), for a multi-session recording per session by position (every
   * session names its files `0.avi`, `1.avi`, ...).
   */
  fileSizes(): ReadonlyMap<string, number>;
  sessionFiles(): { name: string; size: number }[][];
  /** The settle pool's size S on this machine (`settlePoolSize`; started or not), and visit workers. */
  lookbackPoolSize(): number;
  visitWorkers(): number;
  tunables?: Record<string, unknown>;
}

/** Settings that live in a panel rather than a store (`RunPanel`, the session setup). */
export interface RunRecordExtras {
  /** Joint or Separate (a recording of several sessions). */
  mode?: string;
  /** Separate: the 0-based session this record is for. */
  sessionIndex?: number;
  /** "Extract after Discover". */
  extractAfterDiscover?: boolean;
  /** Export only cells that pass QC (the Run tab's single export only; automatic runs export every session's QC-flagged cells). */
  passQcOnly?: boolean;
  slots?: Partial<Record<WorkSliderSlot, unknown>>;
}

/**
 * Discover's frames over its wall time (the last finished Discover run), frames
 * per second; null when none finished. Includes pauses and the final settle,
 * as the run took.
 */
export function achievedFps(runs: readonly StageRun[]): number | null {
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k];
    if (r.stage !== 'discover' || !r.endedAt) continue;
    const s = (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000;
    return s > 0 && r.frames > 0 ? r.frames / s : null;
  }
  return null;
}

export function gatherRunRecord(src: RunRecordSources, extras: RunRecordExtras = {}) {
  const p = src.pipeline;
  const info = src.info();
  const st = src.slowStatus();
  const settle = st?.lookback?.settle;
  const sizes = src.fileSizes();
  const perSession = src.sessionFiles();
  const pool = src.trace.poolStart();
  const gov = st?.lookback?.csettle?.governor ?? null;
  const achieved = achievedFps(src.stageRuns());
  const n = src.trace.counters();
  const floor = src.trace.floorEstimate();
  // The settings hold what the run STARTED with; what changed after is `target_speed.changes`
  // and `work.cap_changes` (the first entry of each is the start value).
  const startFps = src.trace.targetSpeedChanges()[0]?.fps ?? p.paceFps();
  const startCap = src.trace.capChanges()[0]?.cap;
  const auto = src.trace.auto();
  const speedMode = speedModeOf({
    live: info?.live !== undefined,
    targetSpeed: src.trace.targetSpeedChanges(),
    curve: src.trace.curve() !== null,
    auto: auto !== null,
  });
  const record = buildRunRecord({
    createdAt: (src.now ?? (() => new Date()))().toISOString(),
    appVersion: src.appVersion,
    commit: src.commit,
    engineVersion: src.engineVersion,
    gitDirty: src.gitDirty,
    search: src.search,
    settings: {
      flat_field: p.flatEnabled(),
      discovery: p.discover(),
      residual_preview: p.residual(),
      lookback: p.lookback(),
      // The setting above is on by default; this says whether the run really had look-back
      // (not for a live stream or ?pipeline=0; a Joint run has it).
      lookback_ran: p.lookbackRun ? p.lookbackRun() : p.lookback(),
      // Background settle (v2): runs whenever the target is below Max, at most `settle_cap`
      // re-read frames per live frame; 'off' (the checkbox unticked, `csettle=0`) never.
      background_settle: p.csettle() ? 'auto-below-max' : 'off',
      settle_cap:
        startCap !== undefined
          ? startCap > 0
            ? startCap
            : 'off'
          : p.csettle()
            ? p.csettleCeiling()
            : 'off',
      settle_yield_frames: p.csettleYield(),
      need_first: p.csettleNeedFirst(),
      // The pool actually started (a run that stayed at Max: started_S 0, started_at_frame null).
      lookback_pool: {
        planned_S: src.lookbackPoolSize(),
        started_S: pool?.workers ?? 0,
        started_at_frame: pool?.frame ?? null,
        // Why it started: below Max for the Background settle, or at Discover's end for the
        // Final settle on the factors (null: never started).
        started_for: pool ? (pool.forFinal ? 'final-settle' : 'background-settle') : null,
      },
      final_settle_level: p.finalSettleLevel(),
      speed_mode: speedMode,
      target_speed_fps: startFps,
      smooth_playback: p.smoothPlayback(),
      ...(extras.mode !== undefined ? { library_mode: extras.mode } : {}),
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
      files: (info?.sessions ? [] : (info?.files ?? [])).map((f, position) => {
        const size = sizes.get(f.name);
        return {
          position,
          name: f.name,
          frames: f.frames,
          ...(size !== undefined ? { size } : {}),
        };
      }),
      sessions: (info?.sessions ?? []).map((s) => ({
        index: s.index,
        name: s.name,
        start_frame: s.startFrame,
        frames: s.frameCount,
        fps: s.fps,
        files: (perSession[s.index] ?? []).map((f, position) => ({ position, ...f })),
      })),
      mode: extras.mode ?? null,
      session_index: extras.sessionIndex ?? null,
      fps_source: info?.fpsSource ?? null,
    },
    runtime: {
      motion_backend: p.motionBackend(),
      flat_field: {
        enabled: p.flatEnabled(),
        reused_from_cache: p.flatField().reused,
        key_source: p.flatField().keySource,
      },
    },
    stages: src.stageRuns(),
    settle: settle
      ? {
          fed: settle.fed,
          planned: settle.total,
          recording: settle.recording,
          stopped_by_user: settle.stopped,
          done: settle.done,
          source: settle.source ?? null,
          ...(settle.workers !== undefined ? { workers: settle.workers } : {}),
          ...(settle.visits ? { visits: settle.visits } : {}),
        }
      : null,
    settleTimes: src.trace.settleTimes(),
    targetSpeed: src.trace.targetSpeedChanges(),
    capChanges: src.trace.capChanges(),
    work: {
      cap: p.csettle() ? p.csettleCeiling() : 0,
      pool: 1 + (pool?.workers ?? 0),
      visit_workers: src.visitWorkers(),
    },
    governor: gov,
    visitRate: src.trace.visitRate(),
    realised: {
      achieved_fps_mean: achieved,
      dose_per_live_frame:
        n && n.settledFrames !== null && n.processed > 0 ? n.settledFrames / n.processed : null,
      frames_missed_by_slow_loop:
        n && n.observed !== null ? Math.max(0, n.processed - n.observed) : null,
      forward_drops: n?.forwardDrops ?? null,
      halvings: n?.halvings ?? null,
      slow_halvings: n?.slowHalvings ?? null,
      limit_shares: src.trace.limitShares(),
      pace_late_ms: n?.paceLateMs ?? null,
      pace_reanchors: n?.paceReanchors ?? null,
      max_fps_median: src.trace.maxFpsMedian(),
      fast_max_fps_median: src.trace.fastMaxFpsMedian(),
    },
    achievedFps: achieved,
    machine: machineContext(),
    slots: {
      slider_schedule: sliderSchedule(),
      ...(floor ? { floor_estimate: floor } : {}),
      ...(src.trace.curve() ? { curve_schedule: src.trace.curve() } : {}),
      ...(auto
        ? { auto_decisions: auto.decisions, auto_extra_time_share: auto.extraTimeShare }
        : {}),
      ...extras.slots,
    },
  });
  return record;
}

// ---- Reproducing from a record ----

/**
 * The URL-flag and setting changes that re-apply a record's settings (what
 * `__cala.applyRunRecord` does, under `?debug`). Pure: returns what to set; the app applies it.
 * Unknown or malformed records give `null`.
 */
export interface AppliedSettings {
  flatField?: boolean;
  discover?: boolean;
  lookback?: boolean;
  /** Background settle on (false: cap Off). */
  csettle?: boolean;
  csettleCeiling?: number;
  csettleYield?: number;
  csettleNeedFirst?: boolean;
  finalSettleLevel?: FinalSettleLevel;
  paceFps?: number;
  smoothPlayback?: boolean;
  /**
   * The settle pool size S the run had planned (v2). It cannot be applied (it
   * is fixed at page load from the core count, or `?debug&lbpool=S`); the app
   * reports a mismatch.
   */
  lookbackPoolPlanned?: number;
  /** The Speed block's mode the run had (information: the app picks its own mode from `paceFps` and `curve`). */
  speedMode?: 'max' | 'fixed' | 'curve' | 'auto' | 'stream';
  /**
   * A curve and an Auto run replays as a curve: the target changes the run realised, with
   * positions as a share of the recording (`at`, 0 to 1; the first at 0) so a rerun follows
   * the same schedule whatever the machine decides. Absent for Max, Fixed and stream runs.
   */
  curve?: ReplayCurve;
  /**
   * The record says Refine ran (`settings.refine_runs` above 0, or a `refine` stage run). That stage
   * was removed: look-back and the Final settle replace it, so the replay has no Refine run and
   * `lookback` is forced on.
   */
  refineUsed?: boolean;
  /** The run changed its settle cap part-way (`work.cap_changes` has more than one distinct value); not replayed. */
  capChangedDuringRun?: boolean;
}

/** A schedule of target speeds over the recording (`speed-schedule.ts`). */
export type ReplayCurve = SpeedCurve;

const SPEED_MODES = ['max', 'fixed', 'curve', 'auto', 'stream'] as const;

/**
 * The curve a record's target changes make: one point per change, `at` the frame's share of
 * `frames` (the recording's), consecutive repeats of the same target merged. Null when there is
 * nothing to replay (no frames, or no changes).
 */
export function curveFromChanges(
  changes: readonly { frame: number; fps: number }[],
  frames: number,
): ReplayCurve | null {
  if (!(frames > 0) || changes.length === 0) return null;
  const points: ReplayCurve['points'] = [];
  for (const c of changes) {
    if (!Number.isFinite(c.frame) || !Number.isFinite(c.fps) || c.fps < 0) continue;
    const fps = c.fps > 0 ? c.fps : 'max';
    const at = points.length === 0 ? 0 : Math.min(1, Math.max(0, c.frame / frames));
    const last = points[points.length - 1];
    if (last && last.fps === fps) continue;
    // Two changes at the same place: the later one wins.
    if (last && last.at >= at) last.fps = fps;
    else points.push({ at, fps });
  }
  return points.length > 0 ? { points } : null;
}

export function settingsFromRecord(rec: unknown): AppliedSettings | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.format !== RUN_RECORD_FORMAT) return null;
  const v = r.record_version;
  if (typeof v !== 'number' || v < 1 || v > RUN_RECORD_VERSION) return null;
  const s = r.settings;
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const out: AppliedSettings = {};
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const bool = (k: string, to: keyof AppliedSettings) => {
    if (typeof o[k] === 'boolean') (out as Record<string, unknown>)[to] = o[k];
  };
  const num = (k: string, to: keyof AppliedSettings) => {
    if (finite(o[k])) (out as Record<string, unknown>)[to] = o[k];
  };
  bool('flat_field', 'flatField');
  bool('discovery', 'discover');
  bool('lookback', 'lookback');
  if (v === 1) {
    // v1: `settle_during_discover` false was the cap Off; true is Background settle as now
    // (the default), at the recorded ceiling. `settle_governor` has no meaning any more.
    bool('settle_during_discover', 'csettle');
    num('settle_ceiling_per_live_frame', 'csettleCeiling');
  } else {
    if (o.background_settle === 'off' || o.settle_cap === 'off') out.csettle = false;
    else if (o.background_settle === 'auto-below-max') out.csettle = true;
    if (finite(o.settle_cap) && o.settle_cap > 0) {
      out.csettle ??= true;
      out.csettleCeiling = o.settle_cap;
    }
    bool('need_first', 'csettleNeedFirst');
    const pool = o.lookback_pool as Record<string, unknown> | null | undefined;
    if (pool && typeof pool === 'object' && finite(pool.planned_S))
      out.lookbackPoolPlanned = pool.planned_S;
  }
  num('settle_yield_frames', 'csettleYield');
  // Only a known level is restored (a record from a newer build with another name is left alone).
  if (
    typeof o.final_settle_level === 'string' &&
    Object.prototype.hasOwnProperty.call(FINAL_SETTLE_LEVELS, o.final_settle_level)
  )
    out.finalSettleLevel = o.final_settle_level as FinalSettleLevel;
  num('target_speed_fps', 'paceFps');
  bool('smooth_playback', 'smoothPlayback');
  if ((SPEED_MODES as readonly unknown[]).includes(o.speed_mode))
    out.speedMode = o.speed_mode as AppliedSettings['speedMode'];
  {
    const ts = r.target_speed as { changes?: unknown } | undefined;
    const inp = r.input as { frames?: unknown } | undefined;
    const changes = Array.isArray(ts?.changes)
      ? (ts.changes as unknown[]).filter(
          (c): c is { frame: number; fps: number } =>
            !!c &&
            typeof c === 'object' &&
            finite((c as Record<string, unknown>).frame) &&
            finite((c as Record<string, unknown>).fps),
        )
      : [];
    const curve = curveFromChanges(changes, finite(inp?.frames) ? inp.frames : 0);
    // Any run with more than one distinct target replays as a curve, whatever its mode.
    if (curve && curve.points.length > 1) out.curve = curve;
    else if (out.speedMode === 'curve' || out.speedMode === 'auto') {
      if (curve) out.curve = curve;
    }
  }
  const stages = Array.isArray(r.stages) ? (r.stages as unknown[]) : [];
  if (
    (finite(o.refine_runs) && o.refine_runs > 0) ||
    stages.some((x) => (x as Record<string, unknown> | null)?.stage === 'refine')
  )
    out.refineUsed = true;
  // Look-back with its Final settle is the modern equivalent of a Refine run: keep it on for such a record.
  if (out.refineUsed) out.lookback = true;
  const work = r.work as { cap_changes?: unknown } | undefined;
  if (Array.isArray(work?.cap_changes)) {
    const caps = new Set(
      (work.cap_changes as unknown[])
        .map((c) => (c as Record<string, unknown> | null)?.cap)
        .filter(finite),
    );
    if (caps.size > 1) out.capChangedDuringRun = true;
  }
  return out;
}
