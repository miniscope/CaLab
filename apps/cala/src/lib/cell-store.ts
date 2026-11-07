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

/** Fast-loop timing per frame (batch wall time / frames), split by discovery on/off. */
export interface FastTiming {
  on: number[];
  off: number[];
  /** Trace solve alone (incl. library swap), per frame. */
  solveOn: number[];
  solveOff: number[];
}

/** Metric series against fast-loop frames read (one point per batch). */
export class CellMetrics {
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
  }

  get length(): number {
    return this.frame.length;
  }
}

/** Frames a new cell stays highlighted. */
export const NEW_CELL_FRAMES = 300;

export function createCellStore(history = new TraceHistory(), footprints = new FootprintHistory()) {
  const [library, setLibrary] = createSignal<LibraryView | null>(null);
  const [geometry, setGeometry] = createSignal<CellGeometry | null>(null);
  const [status, setStatus] = createSignal<SlowStatus | null>(null);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [frame, setFrame] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [batch, setBatch] = createSignal<CellsBatch | null>(null);
  const [tick, setTick] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  let session = -1;
  let firstSeen = new Map<number, number>();
  let events: LibraryEvent[] = [];
  let metrics = new CellMetrics();
  let timing: FastTiming = { on: [], off: [], solveOn: [], solveOff: [] };
  /** Slow loop per received batch: wall time, and its longest single step, ms. */
  let slowBatchMs: number[] = [];
  let slowStepMs: number[] = [];

  function reset(next: number): void {
    session = next;
    history.clear();
    footprints.clear();
    firstSeen = new Map();
    events = [];
    metrics = new CellMetrics();
    timing = { on: [], off: [], solveOn: [], solveOff: [] };
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

  function onLibrary(view: LibraryView): void {
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
    if (msg.type === 'library') onLibrary(msg.library);
    else if (msg.type === 'status') {
      if (!msg.status.final) {
        slowBatchMs.push(msg.status.batchMs);
        slowStepMs.push(msg.status.maxStepMs);
      }
      setStatus(msg.status);
    } else setError(msg.message);
  }

  /** The fast loop's result for one pipeline batch. */
  function onBatch(start: number, count: number, cells: CellsBatch, t: StageTimings): void {
    // Cells the fast loop no longer solves (merged, deleted) lose their history.
    if (cells.version !== version()) history.retain(cells.ids, selected());
    history.push(start, count, cells.ids, cells.traces);
    const end = start + count;
    const perFrame = (t.readMs + t.preprocessMs + t.motionMs + t.otherMs + t.traceMs) / count;
    const solve = (cells.swapMs + cells.solveMs) / count;
    if (cells.discovering) {
      timing.on.push(perFrame);
      timing.solveOn.push(solve);
    } else {
      timing.off.push(perFrame);
      timing.solveOff.push(solve);
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
    slowTiming: () => ({ batchMs: slowBatchMs, stepMs: slowStepMs }),
  };
}

export type CellStore = ReturnType<typeof createCellStore>;
