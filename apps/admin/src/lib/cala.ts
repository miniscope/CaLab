// Cala-specific aggregations: funnel, runs, failures, adapters, versions, testers.
// Inputs are Cala sessions (already filtered) and their events.

import type { EventRow, SessionRow } from './types.ts';
import { evNum, evStr, indexEvents, sessionMs, type EventIndex } from './metrics.ts';
import {
  type Bucket,
  bucketKey,
  bucketRange,
  compareVersions,
  countBy,
  histogram,
  median,
  shortHash,
} from './stats.ts';

export type AdapterClass = 'hardware' | 'fallback' | 'none' | 'unknown';

/**
 * Sessions a run event processed. Events since the run/plan split carry
 * `sessions` for the run itself; older events carried the plan's size there,
 * which counts a Separate plan's session once per run, so Separate and single
 * runs are always one session (a Joint run is one run over all of them).
 */
export function runSessions(e: EventRow): number | null {
  const mode = evStr(e, 'mode');
  if (mode === 'separate' || mode === 'single') return 1;
  return evNum(e, 'sessions');
}

export interface CalaRun {
  sessionId: string;
  at: number;
  version: string;
  browser: string;
  stage: string;
  mode: string;
  /** Sessions this run processed (Joint: all of the plan's; Separate and single: 1). */
  sessions: number | null;
  /** Size of the plan the run belonged to; null for a single folder and for older events. */
  planSessions: number | null;
  /** Refine runs the plan asked for before Extract; null when not reported (older events). */
  refineRuns: number | null;
  frames: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  megapixels: number | null;
  durationS: number | null;
  medianFps: number | null;
  cells: number | null;
  peakWasmMb: number | null;
  peakJsMb: number | null;
  workMpx: number | null;
  adapter: AdapterClass;
  vendor: string | null;
  tag: string | null;
  userAgent: string;
}

export function adapterOf(events: EventRow[] | undefined): {
  cls: AdapterClass;
  vendor: string | null;
} {
  const e = events?.find((x) => x.event_name === 'webgpu_info');
  if (!e) return { cls: 'unknown', vendor: null };
  const a = evStr(e, 'adapter');
  const cls: AdapterClass = a === 'hardware' || a === 'fallback' || a === 'none' ? a : 'unknown';
  return { cls, vendor: evStr(e, 'vendor') };
}

/** Last tester tag reported in the session, or null. Raw text: escape on render. */
export function testerTagOf(events: EventRow[] | undefined): string | null {
  let tag: string | null = null;
  for (const e of events ?? []) if (e.event_name === 'tester_tag') tag = evStr(e, 'tag') ?? tag;
  return tag;
}

/** One record per run_finished event, joined to its session. */
export function extractRuns(sessions: SessionRow[], idx: EventIndex): CalaRun[] {
  const runs: CalaRun[] = [];
  for (const s of sessions) {
    const evs = idx.get(s.id);
    if (!evs) continue;
    const { cls, vendor } = adapterOf(evs);
    const tag = testerTagOf(evs);
    for (const e of evs) {
      if (e.event_name !== 'run_finished') continue;
      const w = evNum(e, 'width');
      const h = evNum(e, 'height');
      runs.push({
        sessionId: s.id,
        at: Date.parse(e.created_at),
        version: s.app_version ?? 'unknown',
        browser: s.user_id ? shortHash(s.user_id) : '-',
        stage: evStr(e, 'stage') ?? 'unknown',
        mode: evStr(e, 'mode') ?? 'unknown',
        sessions: runSessions(e),
        planSessions: evNum(e, 'plan_sessions'),
        refineRuns: evNum(e, 'refine_runs'),
        frames: evNum(e, 'frames'),
        fps: evNum(e, 'fps'),
        width: w,
        height: h,
        megapixels: w !== null && h !== null ? (w * h) / 1e6 : null,
        durationS: evNum(e, 'duration_s'),
        medianFps: evNum(e, 'median_fps'),
        cells: evNum(e, 'cells'),
        peakWasmMb: evNum(e, 'peak_wasm_mb'),
        peakJsMb: evNum(e, 'peak_js_mb'),
        workMpx:
          w !== null && h !== null && evNum(e, 'frames') !== null
            ? (evNum(e, 'frames')! * w * h) / 1e6
            : null,
        adapter: cls,
        vendor,
        tag,
        userAgent: s.user_agent_family ?? 'Unknown',
      });
    }
  }
  return runs.filter((r) => Number.isFinite(r.at));
}

export interface FailureEvent {
  sessionId: string;
  at: number;
  version: string;
  stage: string;
  category: string;
  type: string;
}

export function extractFailures(sessions: SessionRow[], idx: EventIndex): FailureEvent[] {
  const out: FailureEvent[] = [];
  for (const s of sessions) {
    for (const e of idx.get(s.id) ?? []) {
      if (e.event_name !== 'run_failed') continue;
      out.push({
        sessionId: s.id,
        at: Date.parse(e.created_at),
        version: s.app_version ?? 'unknown',
        stage: evStr(e, 'stage') ?? 'unknown',
        category: evStr(e, 'error_category') ?? 'unknown',
        type: evStr(e, 'error_type') ?? '-',
      });
    }
  }
  return out.filter((f) => Number.isFinite(f.at));
}

// ---- run ledger: pairing run_started with run_finished / run_failed ----

export interface UnfinishedRun {
  sessionId: string;
  version: string;
  stage: string;
  mode: string;
  recordings: number | null;
  frames: number | null;
  megapixels: number | null;
  /** frames x megapixels: the size of the work. */
  workMpx: number | null;
  startedAt: number;
  /** Seconds between the start and the session's last heartbeat; null if unknown. */
  survivedS: number | null;
  adapter: AdapterClass;
  userAgent: string;
}

export interface RunLedger {
  /** Every run_started seen. */
  starts: { sessionId: string; version: string; stage: string }[];
  unfinished: UnfinishedRun[];
}

/**
 * Pair starts with finishes inside each session. Events are walked in order
 * (created_at, then id). A run_finished or run_failed closes the most recent
 * open start of the same stage; any earlier open start of that stage stays
 * open, because a cancelled run emits nothing and the next attempt follows it.
 * A start left open at the end of the session is "unfinished": the tab crashed
 * or was closed or reloaded, or the user stopped the run. A reload begins a
 * new session, so the old session keeps the open start.
 */
export function pairRuns(sessions: SessionRow[], idx: EventIndex): RunLedger {
  const starts: RunLedger['starts'] = [];
  const unfinished: UnfinishedRun[] = [];
  for (const s of sessions) {
    const evs = [...(idx.get(s.id) ?? [])].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id),
    );
    const open = new Map<string, EventRow[]>();
    const version = s.app_version ?? 'unknown';
    for (const e of evs) {
      const stage = evStr(e, 'stage') ?? 'unknown';
      if (e.event_name === 'run_started') {
        starts.push({ sessionId: s.id, version, stage });
        const l = open.get(stage);
        if (l) l.push(e);
        else open.set(stage, [e]);
      } else if (e.event_name === 'run_finished' || e.event_name === 'run_failed') {
        open.get(stage)?.pop();
      }
    }
    const { cls } = adapterOf(evs);
    const ended = s.ended_at ? Date.parse(s.ended_at) : NaN;
    for (const [stage, list] of open) {
      for (const e of list) {
        const at = Date.parse(e.created_at);
        const w = evNum(e, 'width');
        const h = evNum(e, 'height');
        const frames = evNum(e, 'frames');
        const mp = w !== null && h !== null ? (w * h) / 1e6 : null;
        const survived = Number.isFinite(ended) && ended >= at ? (ended - at) / 1000 : null;
        unfinished.push({
          sessionId: s.id,
          version,
          stage,
          mode: evStr(e, 'mode') ?? 'unknown',
          recordings: runSessions(e),
          frames,
          megapixels: mp,
          workMpx: frames !== null && mp !== null ? frames * mp : null,
          startedAt: at,
          survivedS: survived,
          adapter: cls,
          userAgent: s.user_agent_family ?? 'Unknown',
        });
      }
    }
  }
  return { starts, unfinished: unfinished.sort((a, b) => b.startedAt - a.startedAt) };
}

export interface UnfinishedRow {
  stage: string;
  version: string;
  starts: number;
  unfinished: number;
  rate: number | null;
  medianSurvivedS: number | null;
  medianWorkMpx: number | null;
}

/** Unfinished rate per stage and version (oldest version first). */
export function unfinishedTable(ledger: RunLedger): UnfinishedRow[] {
  const keys = new Set(ledger.starts.map((x) => `${x.stage}|${x.version}`));
  return Array.from(keys)
    .map((k) => {
      const [stage, version] = k.split('|');
      const n = ledger.starts.filter((x) => x.stage === stage && x.version === version).length;
      const u = ledger.unfinished.filter((x) => x.stage === stage && x.version === version);
      return {
        stage,
        version,
        starts: n,
        unfinished: u.length,
        rate: n > 0 ? u.length / n : null,
        medianSurvivedS: median(u.map((x) => x.survivedS)),
        medianWorkMpx: median(u.map((x) => x.workMpx)),
      };
    })
    .sort(
      (a, b) => stageRank(a.stage) - stageRank(b.stage) || compareVersions(a.version, b.version),
    );
}

// ---- funnel ----

export interface CalaFunnelStep {
  label: string;
  count: number;
  /** Share of the first step; null when the first step is 0. */
  ofFirst: number | null;
  /** Share of the previous step. */
  ofPrev: number | null;
}

const CALA_FUNNEL: { label: string; event: string | null }[] = [
  { label: 'Visited', event: null },
  { label: 'Imported a recording', event: 'file_imported' },
  { label: 'Started a run', event: 'run_started' },
  { label: 'Finished a run', event: 'run_finished' },
  { label: 'Exported results', event: 'results_exported' },
];

/** Session funnel. Counts are monotone: each step is capped by the one before it. */
export function calaFunnel(sessions: SessionRow[], idx: EventIndex): CalaFunnelStep[] {
  let pool = sessions;
  const steps: CalaFunnelStep[] = [];
  for (const d of CALA_FUNNEL) {
    const ev = d.event;
    if (ev) pool = pool.filter((s) => (idx.get(s.id) ?? []).some((e) => e.event_name === ev));
    const count = pool.length;
    const first = steps[0]?.count ?? count;
    const prev = steps[steps.length - 1]?.count ?? count;
    steps.push({
      label: d.label,
      count,
      ofFirst: first > 0 ? count / first : null,
      ofPrev: prev > 0 ? count / prev : null,
    });
  }
  return steps;
}

// ---- run summaries ----

export interface StageRow {
  stage: string;
  mode: string;
  runs: number;
  /** Sessions those runs processed (sum of each run's own sessions). */
  sessions: number;
  medianFps: number | null;
  medianDuration: number | null;
}

const STAGE_ORDER = ['discover', 'refine', 'extract'];
const MODE_ORDER = ['joint', 'separate', 'single'];
const modeRank = (m: string) => {
  const i = MODE_ORDER.indexOf(m);
  return i < 0 ? MODE_ORDER.length : i;
};
const stageRank = (s: string) => {
  const i = STAGE_ORDER.indexOf(s);
  return i < 0 ? STAGE_ORDER.length : i;
};

export function stageModeTable(runs: CalaRun[]): StageRow[] {
  const m = new Map<string, CalaRun[]>();
  for (const r of runs) {
    const k = `${r.stage}|${r.mode}`;
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return Array.from(m, ([k, list]) => {
    const [stage, mode] = k.split('|');
    return {
      stage,
      mode,
      runs: list.length,
      sessions: list.reduce((a, r) => a + (r.sessions ?? 1), 0),
      medianFps: median(list.map((r) => r.medianFps)),
      medianDuration: median(list.map((r) => r.durationS)),
    };
  }).sort(
    (a, b) =>
      stageRank(a.stage) - stageRank(b.stage) ||
      modeRank(a.mode) - modeRank(b.mode) ||
      a.mode.localeCompare(b.mode),
  );
}

export function runsOverTime(runs: CalaRun[], bucket: Bucket, startMs: number, endMs: number) {
  let lo = startMs;
  const ts = runs.map((r) => r.at);
  if (ts.length > 0 && Math.min(...ts) > lo) lo = Math.min(...ts);
  const buckets = bucketRange(lo, endMs, bucket);
  const pos = new Map(buckets.map((b, i) => [b, i]));
  const stages = Array.from(new Set(runs.map((r) => r.stage))).sort(
    (a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b),
  );
  const data = new Map(stages.map((s) => [s, new Array<number>(buckets.length).fill(0)]));
  for (const r of runs) {
    const i = pos.get(bucketKey(r.at, bucket));
    if (i !== undefined) data.get(r.stage)![i]++;
  }
  return { buckets, series: stages.map((key) => ({ key, values: data.get(key)! })) };
}

export function sizeDistributions(runs: CalaRun[]) {
  return {
    frames: histogram(
      runs.map((r) => r.frames),
      8,
    ),
    megapixels: histogram(
      runs.map((r) => r.megapixels),
      8,
    ),
    sessionsPerRun: histogram(
      runs.map((r) => r.sessions),
      6,
    ),
    cells: histogram(
      runs.map((r) => r.cells),
      8,
    ),
    peakWasmMb: histogram(
      runs.map((r) => r.peakWasmMb),
      8,
    ),
  };
}

// ---- failures ----

export interface FailureRow {
  stage: string;
  category: string;
  type: string;
  count: number;
  versions: string;
  lastSeen: number;
}

export function failureTable(failures: FailureEvent[]): FailureRow[] {
  const m = new Map<
    string,
    { f: FailureEvent; count: number; versions: Set<string>; last: number }
  >();
  for (const f of failures) {
    const k = `${f.stage}|${f.category}|${f.type}`;
    const cur = m.get(k);
    if (cur) {
      cur.count++;
      cur.versions.add(f.version);
      cur.last = Math.max(cur.last, f.at);
    } else m.set(k, { f, count: 1, versions: new Set([f.version]), last: f.at });
  }
  return Array.from(m.values())
    .map((v) => ({
      stage: v.f.stage,
      category: v.f.category,
      type: v.f.type,
      count: v.count,
      versions: [...v.versions].sort(compareVersions).join(', '),
      lastSeen: v.last,
    }))
    .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));
}

// ---- boundaries ----

export interface BoundaryStats {
  /** boundary_summary events with at least one boundary (multi-session Joint runs). */
  runs: number;
  withWarning: number;
  withFailed: number;
  flagged: number;
  flaggedShare: number | null;
}

export function boundaryStats(sessions: SessionRow[], idx: EventIndex): BoundaryStats {
  let runs = 0;
  let withWarning = 0;
  let withFailed = 0;
  let flagged = 0;
  for (const s of sessions) {
    for (const e of idx.get(s.id) ?? []) {
      if (e.event_name !== 'boundary_summary') continue;
      if ((evNum(e, 'boundaries') ?? 0) <= 0) continue;
      runs++;
      const w = (evNum(e, 'warning') ?? 0) > 0;
      const f = (evNum(e, 'failed') ?? 0) > 0;
      if (w) withWarning++;
      if (f) withFailed++;
      if (w || f) flagged++;
    }
  }
  return { runs, withWarning, withFailed, flagged, flaggedShare: runs > 0 ? flagged / runs : null };
}

// ---- adapters ----

export interface AdapterRow {
  cls: AdapterClass;
  vendor: string;
  sessions: number;
  runs: number;
  medianFps: number | null;
}

/** Sessions that reported webgpu_info, by class and vendor, with run fps. */
export function adapterTable(
  sessions: SessionRow[],
  idx: EventIndex,
  runs: CalaRun[],
): AdapterRow[] {
  const m = new Map<string, { cls: AdapterClass; vendor: string; sessions: number }>();
  for (const s of sessions) {
    const evs = idx.get(s.id);
    if (!evs?.some((e) => e.event_name === 'webgpu_info')) continue;
    const { cls, vendor } = adapterOf(evs);
    const v = vendor ?? '-';
    const k = `${cls}|${v}`;
    const cur = m.get(k);
    if (cur) cur.sessions++;
    else m.set(k, { cls, vendor: v, sessions: 1 });
  }
  return Array.from(m.values())
    .map((a) => {
      const mine = runs.filter((r) => r.adapter === a.cls && (r.vendor ?? '-') === a.vendor);
      return { ...a, runs: mine.length, medianFps: median(mine.map((r) => r.medianFps)) };
    })
    .sort((a, b) => b.sessions - a.sessions);
}

export interface AdapterClassFps {
  cls: AdapterClass;
  runs: number;
  medianFps: number | null;
}

export function fpsByAdapterClass(runs: CalaRun[]): AdapterClassFps[] {
  const m = new Map<AdapterClass, CalaRun[]>();
  for (const r of runs) {
    const l = m.get(r.adapter);
    if (l) l.push(r);
    else m.set(r.adapter, [r]);
  }
  const order: AdapterClass[] = ['hardware', 'fallback', 'none', 'unknown'];
  return order
    .filter((c) => m.has(c))
    .map((cls) => ({
      cls,
      runs: m.get(cls)!.length,
      medianFps: median(m.get(cls)!.map((r) => r.medianFps)),
    }));
}

// ---- versions ----

export interface VersionRow {
  version: string;
  sessions: number;
  runs: number;
  starts: number;
  unfinished: number;
  /** unfinished / run_started; includes crashes, closed tabs and user stops. */
  unfinishedRate: number | null;
  failures: number;
  /** failed / (finished + failed); null with no attempts. */
  failureRate: number | null;
  medianFps: number | null;
  /** Median fps over hardware-adapter runs only (hides software-rendering noise). */
  medianFpsHardware: number | null;
  medianDuration: number | null;
}

/** Version-over-version health, oldest to newest. */
export function versionComparison(
  sessions: SessionRow[],
  runs: CalaRun[],
  failures: FailureEvent[],
  ledger: RunLedger = { starts: [], unfinished: [] },
): VersionRow[] {
  const sess = countBy(sessions, (s) => s.app_version ?? 'unknown');
  return Array.from(sess.keys())
    .sort(compareVersions)
    .map((version) => {
      const r = runs.filter((x) => x.version === version);
      const f = failures.filter((x) => x.version === version).length;
      const attempts = r.length + f;
      const st = ledger.starts.filter((x) => x.version === version).length;
      const un = ledger.unfinished.filter((x) => x.version === version).length;
      return {
        version,
        sessions: sess.get(version) ?? 0,
        runs: r.length,
        starts: st,
        unfinished: un,
        unfinishedRate: st > 0 ? un / st : null,
        failures: f,
        failureRate: attempts > 0 ? f / attempts : null,
        medianFps: median(r.map((x) => x.medianFps)),
        medianFpsHardware: median(
          r.filter((x) => x.adapter === 'hardware').map((x) => x.medianFps),
        ),
        medianDuration: median(r.map((x) => x.durationS)),
      };
    });
}

// ---- testers ----

export interface TesterRow {
  tag: string;
  sessions: number;
  runs: number;
  failures: number;
  medianFps: number | null;
  lastSeen: number;
  versions: string;
}

/** Per tester tag: its sessions' runs and failures. Tags are untrusted text. */
export function testerTable(sessions: SessionRow[], idx: EventIndex): TesterRow[] {
  const m = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const tag = testerTagOf(idx.get(s.id));
    if (!tag) continue;
    const cur = m.get(tag);
    if (cur) cur.push(s);
    else m.set(tag, [s]);
  }
  return Array.from(m, ([tag, sess]) => {
    const runs = extractRuns(sess, idx);
    return {
      tag,
      sessions: sess.length,
      runs: runs.length,
      failures: extractFailures(sess, idx).length,
      medianFps: median(runs.map((r) => r.medianFps)),
      lastSeen: Math.max(...sess.map(sessionMs)),
      versions: [...new Set(sess.map((s) => s.app_version ?? 'unknown'))]
        .sort(compareVersions)
        .join(', '),
    };
  }).sort((a, b) => b.lastSeen - a.lastSeen);
}

// ---- bundle ----

export interface CalaData {
  sessions: SessionRow[];
  idx: EventIndex;
  funnel: CalaFunnelStep[];
  runs: CalaRun[];
  failures: FailureEvent[];
  ledger: RunLedger;
}

export function buildCala(allSessions: SessionRow[], events: EventRow[]): CalaData {
  const sessions = allSessions.filter((s) => s.app_name === 'cala');
  const idx = indexEvents(sessions, events);
  return {
    sessions,
    idx,
    funnel: calaFunnel(sessions, idx),
    runs: extractRuns(sessions, idx),
    failures: extractFailures(sessions, idx),
    ledger: pairRuns(sessions, idx),
  };
}

export interface RegressionFlag {
  version: string;
  against: string;
  reasons: string[];
}

/**
 * Flag a version whose hardware-adapter median fps fell by more than 20% or
 * whose failure rate rose by more than 10 points against the previous version
 * that had enough data (>= minRuns attempts). `rows` must be oldest to newest.
 */
export function flagRegressions(rows: VersionRow[], minRuns = 5): RegressionFlag[] {
  const flags: RegressionFlag[] = [];
  let base: VersionRow | null = null;
  for (const r of rows) {
    if (r.version === 'dev' || r.runs + r.failures + r.unfinished < minRuns) continue;
    if (base) {
      const reasons: string[] = [];
      if (
        base.medianFpsHardware !== null &&
        r.medianFpsHardware !== null &&
        r.medianFpsHardware < base.medianFpsHardware * 0.8
      ) {
        const drop = 1 - r.medianFpsHardware / base.medianFpsHardware;
        reasons.push(`median fps down ${(drop * 100).toFixed(0)}%`);
      }
      if (
        base.failureRate !== null &&
        r.failureRate !== null &&
        r.failureRate > base.failureRate + 0.1
      ) {
        reasons.push(
          `failure rate ${(base.failureRate * 100).toFixed(0)}% to ${(r.failureRate * 100).toFixed(0)}%`,
        );
      }
      if (
        base.unfinishedRate !== null &&
        r.unfinishedRate !== null &&
        r.starts >= minRuns &&
        r.unfinishedRate > base.unfinishedRate + 0.15
      ) {
        reasons.push(
          `unfinished runs ${(base.unfinishedRate * 100).toFixed(0)}% to ${(r.unfinishedRate * 100).toFixed(0)}% (crash, closed tab or stop)`,
        );
      }
      if (reasons.length) flags.push({ version: r.version, against: base.version, reasons });
    }
    base = r;
  }
  return flags;
}
