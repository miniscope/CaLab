/**
 * Main-thread state of live cell discovery: the newest published library (as
 * drawable geometry), when each cell was first seen, per-cell trace history
 * and footprint snapshots,
 * the selected cell, and the metrics plotted against frames read (library
 * size, slow-loop lag, fast-loop timing).
 *
 * Fed by two sources: the fast loop's traces arrive with each pipeline batch
 * (`onBatch`), the slow worker's libraries and status arrive directly from it
 * (`onSlowMessage`). Both carry the pipeline session; stale ones are dropped.
 */
import { createSignal } from 'solid-js';
import type { LibraryView, SlowStatus, SlowToMain } from '../workers/slow-types.ts';
import { buildGeometry, type CellGeometry } from './cell-overlay.ts';
import type { CellsBatch } from './fast-loop.ts';
import type { StageTimings } from './pipeline-engine.ts';
import { FootprintHistory } from './footprint-history.ts';
import { TraceHistory } from './trace-history.ts';
import type { RunHistory } from './run-history.ts';
import {
  ConvergenceHistory,
  convergenceStatus,
  EditRates,
  parseQc,
  type ConvergenceStatus,
  type QcSnapshot,
} from './qc.ts';

/** A library version as it arrived: size and the change from the one before. */
export interface LibraryEvent {
  version: number;
  /** Fast-loop frames read when it arrived. */
  frame: number;
  cells: number;
  added: number;
  removed: number;
}

/** Mean, 99th percentile and max of a sample, and its size. */
export interface Summary {
  n: number;
  mean: number;
  p99: number;
  max: number;
}

export function summarize(v: readonly number[]): Summary {
  if (v.length === 0) return { n: 0, mean: 0, p99: 0, max: 0 };
  const s = [...v].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const p99 = s[Math.min(s.length - 1, Math.ceil(0.99 * s.length) - 1)];
  return { n: s.length, mean, p99, max: s[s.length - 1] };
}

/**
 * Timing samples kept per series. These are read on every batch tick
 * (`summarize` copies and sorts them), so an unbounded series makes the
 * main thread, which also drives the pipeline, slower the longer a run
 * goes: at 8 h of 30 fps video (108k batches) the nine timing summaries took
 * ~170 ms per tick. A series holds the newest `MAX_TIMING_SAMPLES` to
 * `2 * MAX_TIMING_SAMPLES` samples.
 */
export const MAX_TIMING_SAMPLES = 4096;

/** Append `v` to a timing series, dropping the oldest samples past the bound (amortized O(1)). */
export function pushRecent(series: number[], v: number, cap = MAX_TIMING_SAMPLES): void {
  series.push(v);
  if (series.length >= 2 * cap) series.splice(0, series.length - cap);
}

/** Fast-loop timing per frame (batch wall time / frames), split by discovery on/off; recent batches. */
export interface FastTiming {
  on: number[];
  off: number[];
  /** Trace solve alone (incl. library swap), per frame. */
  solveOn: number[];
  solveOff: number[];
  /** Trace solve per frame with online QC observing, and without. */
  solveQc: number[];
  solveNoQc: number[];
  /** Worker time to build each QC snapshot, ms. */
  qcBuildMs: number[];
}

const emptyTiming = (): FastTiming => ({
  on: [],
  off: [],
  solveOn: [],
  solveOff: [],
  solveQc: [],
  solveNoQc: [],
  qcBuildMs: [],
});

/** Points kept per metric series before the series is thinned. */
export const MAX_METRIC_POINTS = 4096;

/** Keep the odd indices and the last element of `a`, in place. */
function thin<T>(a: T[]): void {
  const last = a.length - 1;
  let j = 0;
  for (let i = 0; i <= last; i++) if (i % 2 === 1 || i === last) a[j++] = a[i];
  a.length = j;
}

/**
 * Metric series against fast-loop frames read (one point per batch). Bounded
 * like `ConvergenceHistory`: past `maxPoints`, every other point is dropped
 * (older points get sparser, the newest is always kept), so the plots that
 * redraw from these on every batch cost the same at hour 8 as at minute 1.
 */
export class CellMetrics {
  readonly maxPoints: number;

  constructor(maxPoints = MAX_METRIC_POINTS) {
    this.maxPoints = Math.max(4, Math.floor(maxPoints));
  }

  readonly frame: number[] = [];
  /** Cells in the library the fast loop is solving. */
  readonly cells: number[] = [];
  /** Cells in the slow loop's working set (published or not; null before it starts). */
  readonly working: (number | null)[] = [];
  /** Frames the slow loop is behind the fast loop (null while discovery is off). */
  readonly lag: (number | null)[] = [];
  readonly version: number[] = [];
  /** Fast-loop wall time per frame of the batch, and the trace solve alone, ms. */
  readonly fastMs: number[] = [];
  readonly solveMs: number[] = [];

  push(
    frame: number,
    cells: number,
    working: number | null,
    lag: number | null,
    version: number,
    fastMs = 0,
    solveMs = 0,
  ): void {
    this.fastMs.push(fastMs);
    this.solveMs.push(solveMs);
    this.frame.push(frame);
    this.cells.push(cells);
    this.working.push(working);
    this.lag.push(lag);
    this.version.push(version);
    if (this.frame.length > this.maxPoints) {
      for (const s of [
        this.fastMs,
        this.solveMs,
        this.frame,
        this.cells,
        this.working,
        this.lag,
        this.version,
      ] as unknown[][])
        thin(s);
    }
  }

  get length(): number {
    return this.frame.length;
  }
}

/** Frames a new cell stays highlighted. */
export const NEW_CELL_FRAMES = 300;

export function createCellStore(
  history = new TraceHistory(),
  footprints = new FootprintHistory(),
  /** The run's history over stream time: QC snapshots feed its convergence group. */
  runHistory?: RunHistory,
) {
  const [library, setLibrary] = createSignal<LibraryView | null>(null);
  const [geometry, setGeometry] = createSignal<CellGeometry | null>(null);
  const [status, setStatus] = createSignal<SlowStatus | null>(null);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [frame, setFrame] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [batch, setBatch] = createSignal<CellsBatch | null>(null);
  const [tick, setTick] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [qc, setQc] = createSignal<QcSnapshot | null>(null);
  /** Established (true) or on probation (false), by cell id. */
  const [established, setEstablished] = createSignal<Map<number, boolean>>(new Map());
  const [convergence, setConvergence] = createSignal<ConvergenceStatus>(convergenceStatus([]));
  const [fps, setFps] = createSignal(20);

  let session = -1;
  /** Newest published library as `TraceLibrary.toBytes()` (pass 2 solves with it). */
  let latestBytes: Uint8Array | null = null;
  let convHistory = new ConvergenceHistory();
  let editRates = new EditRates();
  let firstSeen = new Map<number, number>();
  let events: LibraryEvent[] = [];
  let metrics = new CellMetrics();
  let timing: FastTiming = emptyTiming();
  /** Slow loop per received batch: wall time, and its longest single step, ms. */
  let slowBatchMs: number[] = [];
  let slowStepMs: number[] = [];

  function reset(next: number): void {
    session = next;
    latestBytes = null;
    history.clear();
    footprints.clear();
    firstSeen = new Map();
    events = [];
    metrics = new CellMetrics();
    timing = emptyTiming();
    convHistory = new ConvergenceHistory();
    editRates = new EditRates();
    setQc(null);
    setEstablished(new Map());
    setConvergence(convergenceStatus([]));
    slowBatchMs = [];
    slowStepMs = [];
    setLibrary(null);
    setGeometry(null);
    setStatus(null);
    setSelected(null);
    setFrame(0);
    setVersion(0);
    setBatch(null);
    setError(null);
    setTick((v) => v + 1);
  }

  function onLibrary(view: LibraryView, bytes?: Uint8Array): void {
    if (bytes) latestBytes = bytes;
    const prev = library();
    const prevIds = new Set(prev ? prev.ids : []);
    let added = 0;
    for (const id of view.ids) {
      if (!prevIds.has(id)) added++;
      if (!firstSeen.has(id)) firstSeen.set(id, frame());
      prevIds.delete(id);
    }
    events.push({
      version: view.version,
      frame: frame(),
      cells: view.ids.length,
      added,
      removed: prevIds.size,
    });
    // Footprint snapshots: only cells whose footprint changed get a new one.
    footprints.retain(view.ids, selected());
    footprints.record(view);
    setLibrary(view);
    setGeometry(buildGeometry(view));
  }

  /** A message from the slow worker. */
  function onSlowMessage(msg: SlowToMain): void {
    // Errors outside a session (the worker crashed) always count.
    if (msg.session !== session && !(msg.type === 'error' && msg.session === -1)) return;
    if (msg.type === 'library') onLibrary(msg.library, msg.bytes);
    else if (msg.type === 'status') {
      if (!msg.status.final) {
        pushRecent(slowBatchMs, msg.status.batchMs);
        pushRecent(slowStepMs, msg.status.maxStepMs);
      }
      const st = msg.status;
      const c = st.counters;
      editRates.push(st.frame / fps() / 60, {
        adds: c.adds,
        merges: c.merges,
        splits: c.splits ?? 0,
        deletes: c.deletes ?? 0,
        newAdds: c.newAdds ?? 0,
        reAdds: c.reAdds ?? 0,
        churned: c.churned ?? 0,
        establishedRemovals: c.establishedRemovals ?? 0,
      });
      if (st.cellStatus) {
        const m = new Map<number, boolean>();
        const { ids, established: est } = st.cellStatus;
        for (let i = 0; i < ids.length; i++) m.set(ids[i], est[i] === 1);
        setEstablished(m);
      }
      setStatus(st);
    } else setError(msg.message);
  }

  /** A QC snapshot from the fast worker. */
  function onQc(snap: QcSnapshot): void {
    const g = snap.global;
    convHistory.push({
      minutes: snap.frame / fps() / 60,
      cells: g.cells,
      explained: g.explained,
      residualExcess: g.residualExcess,
      snrMedian: g.snrMedian,
      passFrac: g.passFrac,
      stableCells: g.stableCells,
      fpStability: g.fpStability,
      traceSigmaChange: g.traceSigmaChange,
      stableFrac: g.stableFrac,
      addsPerMin: g.addsPerMin,
      removesPerMin: g.removesPerMin,
      edits: editRates.rates(),
    });
    setConvergence(convergenceStatus(convHistory.points));
    runHistory?.convergence(
      snap.frame,
      {
        cells: g.cells,
        explained: g.explained,
        residualExcess: g.residualExcess,
        stableFrac: g.stableFrac,
        fpStability: g.fpStability,
        snrMedian: g.snrMedian,
        passFrac: g.passFrac,
        edits: convHistory.points[convHistory.points.length - 1].edits,
      },
      status()?.cells ?? null,
    );
    setQc(snap);
  }

  /** The fast loop's result for one pipeline batch. */
  function onBatch(start: number, count: number, cells: CellsBatch, t: StageTimings): void {
    // Cells the fast loop no longer solves (merged, deleted) lose their history.
    if (cells.version !== version()) history.retain(cells.ids, selected());
    history.push(start, count, cells.ids, cells.traces);
    const end = start + count;
    const perFrame = (t.readMs + t.preprocessMs + t.motionMs + t.otherMs + t.traceMs) / count;
    const solve = (cells.swapMs + cells.solveMs) / count;
    if (cells.ids.length > 0) pushRecent(cells.qcOn ? timing.solveQc : timing.solveNoQc, solve);
    if (cells.qc) {
      pushRecent(timing.qcBuildMs, cells.qc.buildMs);
      onQc(parseQc(cells.qc));
    }
    if (cells.discovering) {
      pushRecent(timing.on, perFrame);
      pushRecent(timing.solveOn, solve);
    } else {
      pushRecent(timing.off, perFrame);
      pushRecent(timing.solveOff, solve);
    }
    metrics.push(
      end,
      cells.ids.length,
      status()?.cells ?? null,
      cells.discovering ? Math.max(0, end - cells.slowFrame) : null,
      cells.version,
      perFrame,
      solve,
    );
    setFrame(end);
    setVersion(cells.version);
    setBatch(cells);
    setTick((v) => v + 1);
  }

  /** Frames since `id` was first seen (Infinity when unknown). */
  function age(id: number): number {
    const f = firstSeen.get(id);
    return f === undefined ? Infinity : frame() - f;
  }

  return {
    reset,
    session: () => session,
    onSlowMessage,
    onBatch,
    library,
    /** Bytes of `library()` for the trace solver (null before the first publish). */
    libraryBytes: () => latestBytes,
    geometry,
    status,
    error,
    /** Fast-loop frames read, and the library version being solved. */
    frame,
    version,
    /** The newest fast-loop batch (drop and forward counters). */
    batch,
    /** Changes whenever metrics or history gained data. */
    tick,
    selected,
    select: (id: number | null) => setSelected(id),
    age,
    firstSeen: (id: number) => firstSeen.get(id),
    history: () => history,
    /** Per-cell footprint snapshots (changes with `library()`). */
    footprints: () => footprints,
    /** Library versions as they arrived (tracks `library()`). */
    events: () => {
      library();
      return events;
    },
    metrics: () => metrics,
    timing: () => timing,
    /** Newest QC snapshot (null until the fast loop has cells and a snapshot). */
    qc,
    /** Probation/established by cell id (from the slow loop). */
    established,
    /** Convergence history, one point per QC snapshot (tracks `qc()`). */
    convergenceHistory: () => {
      qc();
      return convHistory.points;
    },
    convergence,
    fps,
    setFps: (v: number) => setFps(v > 0 ? v : 20),
    slowTiming: () => ({ batchMs: slowBatchMs, stepMs: slowStepMs }),
  };
}

export type CellStore = ReturnType<typeof createCellStore>;
