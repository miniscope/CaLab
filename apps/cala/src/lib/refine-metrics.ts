/**
 * What a Refine run does over its replay (docs/stages.md, "Refine plots"):
 * the refine rate, the size of the footprint changes it publishes, and the
 * share of cells it has refined so far, against the replay's stream time
 * (`t = frame / fps`, the slow loop's frame in this run). Fed by the Refine
 * store from the slow loop's status and its published libraries; read by the
 * Run panel's Refine plots and the export (`meta_json.stages[].series`).
 *
 * Also the comparison across runs (refines per minute and median change per
 * run, the plot the "Looks settled" hint sits on). Every display range is
 * declared (anchored at 0, stepping up a 1/2/5 ladder as the History plots
 * do), never fitted to the data.
 */
import { StreamHistory, type SeriesSpec } from '@calab/compute';
import type { LibraryView } from '../workers/slow-types.ts';
import type { StageRun } from './run-stages.ts';

/** Stream seconds the refine rate is counted over (as the History's per-minute series). */
export const RATE_WINDOW_S = 60;
/** No rate before this much of the replay (a few seconds' count is not a rate). */
export const RATE_MIN_S = 10;

/** One cell's footprint as pixel -> weight. */
function footprintOf(v: LibraryView, slot: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = v.starts[slot]; k < v.starts[slot + 1]; k++) m.set(v.pixels[k], v.values[k]);
  return m;
}

/**
 * Per cell present in both libraries whose footprint changed at all, the
 * relative change `|a' - a| / |a|` (L2 over the union of their pixels), by
 * id; and how many cells were in both.
 */
export function footprintChanges(
  before: LibraryView,
  after: LibraryView,
): { changes: Map<number, number>; cells: number } {
  const slotOf = new Map<number, number>();
  before.ids.forEach((id, s) => slotOf.set(id, s));
  const changes = new Map<number, number>();
  let cells = 0;
  after.ids.forEach((id, s) => {
    const b = slotOf.get(id);
    if (b === undefined) return;
    cells++;
    const a0 = footprintOf(before, b);
    const a1 = footprintOf(after, s);
    let diff = 0;
    let norm = 0;
    for (const [p, v] of a0) {
      norm += v * v;
      const d = (a1.get(p) ?? 0) - v;
      diff += d * d;
    }
    for (const [p, v] of a1) if (!a0.has(p)) diff += v * v;
    if (diff === 0) return;
    changes.set(id, norm > 0 ? Math.sqrt(diff / norm) : 1);
  });
  return { changes, cells };
}

/** Quantile `q` of ascending `sorted` (linear between neighbours; null when empty). */
export function quantile(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const x = q * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/** One point of a Refine run's series. */
export interface RefineSample {
  /** Stream time in the replay, s. */
  t: number;
  /** Refines the run has published so far (the slow loop's counter). */
  refines: number;
  /** Refines per minute over the last `RATE_WINDOW_S` of the replay (null: too early). */
  refinesPerMin: number | null;
  /** At a library publish: footprints it changed, and the median and 90th percentile of their changes. */
  changed?: number;
  changeMedian?: number | null;
  changeP90?: number | null;
  /** Share of the cells refined at least once in this run so far. */
  refinedShare: number;
}

/** A finished run's summary of the series (export and the cross-run plot). */
export interface RefineSeriesSummary {
  /** 90th percentile of every footprint change the run published. */
  changeP90: number | null;
  /** Share of cells refined at least once. */
  refinedShare: number;
  /** Library publishes during the run. */
  publishes: number;
}

/**
 * The series of one Refine run. `start` is the library the run starts from;
 * `fps` the recording's frame rate.
 */
export class RefineTracker {
  private readonly fps: number;
  private prev: LibraryView;
  private readonly ever = new Set<number>();
  private readonly allChanges: number[] = [];
  private readonly counts: { t: number; refines: number }[] = [{ t: 0, refines: 0 }];
  private readonly list: RefineSample[] = [];
  private cells: number;
  private publishes = 0;
  private refines = 0;

  constructor(start: LibraryView, fps: number) {
    this.prev = start;
    this.fps = fps > 0 ? fps : 20;
    this.cells = start.ids.length;
  }

  /** Stream time of slow-loop frame `frame` of this run, s. */
  time(frame: number): number {
    return frame / this.fps;
  }

  /** Refines over the last `RATE_WINDOW_S` before `t`, per minute (null before `RATE_MIN_S`). */
  private rate(t: number): number | null {
    if (t < RATE_MIN_S) return null;
    const from = t - Math.min(RATE_WINDOW_S, t);
    // The count at `from`: the last recorded one at or before it.
    let base = 0;
    for (const c of this.counts) {
      if (c.t > from) break;
      base = c.refines;
    }
    return (this.refines - base) / ((t - from) / 60);
  }

  private share(): number {
    return this.cells > 0 ? this.ever.size / this.cells : 0;
  }

  /** The slow loop's status: `frame` of this run, `refines` published in this run so far. */
  status(frame: number, refines: number): void {
    const t = this.time(frame);
    const last = this.counts[this.counts.length - 1];
    if (t < last.t) return;
    this.refines = Math.max(this.refines, refines);
    this.counts.push({ t, refines: this.refines });
    this.list.push({
      t,
      refines: this.refines,
      refinesPerMin: this.rate(t),
      refinedShare: this.share(),
    });
  }

  /** A library the slow loop published at `frame` of this run. Same version again: ignored. */
  library(view: LibraryView, frame: number): void {
    if (view.version === this.prev.version) return;
    const { changes } = footprintChanges(this.prev, view);
    this.prev = view;
    this.cells = view.ids.length;
    this.publishes++;
    const sizes = [...changes.values()].sort((a, b) => a - b);
    for (const id of changes.keys()) this.ever.add(id);
    for (const v of sizes) this.allChanges.push(v);
    const t = Math.max(this.time(frame), this.list.at(-1)?.t ?? 0);
    this.list.push({
      t,
      refines: this.refines,
      refinesPerMin: this.rate(t),
      changed: sizes.length,
      changeMedian: quantile(sizes, 0.5),
      changeP90: quantile(sizes, 0.9),
      refinedShare: this.share(),
    });
  }

  samples(): readonly RefineSample[] {
    return this.list;
  }

  summary(): RefineSeriesSummary {
    const all = [...this.allChanges].sort((a, b) => a - b);
    return {
      changeP90: quantile(all, 0.9),
      refinedShare: this.share(),
      publishes: this.publishes,
    };
  }
}

/** Okabe-Ito, as in `run-history.ts`. */
const C = {
  orange: '#e69f00',
  bluishGreen: '#009e73',
  blue: '#0072b2',
  vermillion: '#d55e00',
} as const;

/** The series of the Refine run plot (one `StreamHistory` per run). */
export const REFINE_SERIES: SeriesSpec[] = [
  {
    key: 'refines_per_min',
    label: 'Refines per minute',
    short: 'Refines',
    unit: '/min',
    group: 'refine',
    kind: 'value',
    range: [0, 50],
    rangeRule: 'ladder125',
    color: C.blue,
    digits: 1,
    hint: 'Footprint refinements the slow loop published per minute of the replay (last minute). Falls as the footprints settle.',
  },
  {
    key: 'change_median',
    label: 'Footprint change, median',
    short: 'Change',
    unit: '',
    group: 'refine',
    kind: 'stem',
    range: [0, 0.5],
    rangeRule: 'ladder125',
    color: C.orange,
    digits: 3,
    hint: 'At each library publish: the median relative change |a′ − a| / |a| of the footprints it changed.',
  },
  {
    key: 'change_p90',
    label: 'Footprint change, 90th percentile',
    short: 'Change p90',
    unit: '',
    group: 'refine',
    kind: 'stem',
    range: [0, 0.5],
    rangeRule: 'ladder125',
    color: C.vermillion,
    dash: [3, 2],
    digits: 3,
    hint: 'At each library publish: the 90th percentile of the relative changes of the footprints it changed (the spread).',
  },
  {
    key: 'refined_share',
    label: 'Cells refined so far',
    short: 'Refined',
    unit: '',
    group: 'refine',
    kind: 'step',
    range: [0, 1],
    rangeRule: 'fixed',
    color: C.bluishGreen,
    digits: 2,
    hint: 'Share of the cells whose footprint this run has changed at least once.',
  },
];

export const REFINE_SERIES_KEYS = REFINE_SERIES.map((s) => s.key);

/** A `StreamHistory` of the samples (for `HistoryPlot`), 1 s bins. */
export function refineHistory(samples: readonly RefineSample[], end: number): StreamHistory {
  const h = new StreamHistory({ baseBinS: 1 });
  for (const s of REFINE_SERIES) h.define(s);
  for (const p of samples) {
    if (p.refinesPerMin !== null) h.push('refines_per_min', p.t, p.refinesPerMin);
    if (p.changeMedian !== undefined && p.changeMedian !== null)
      h.push('change_median', p.t, p.changeMedian);
    if (p.changeP90 !== undefined && p.changeP90 !== null) h.push('change_p90', p.t, p.changeP90);
    h.push('refined_share', p.t, p.refinedShare);
  }
  h.advance(end);
  return h;
}

/** The samples for `meta_json.stages[].series` (snake_case, columns). */
export function seriesMeta(samples: readonly RefineSample[]): Record<string, (number | null)[]> {
  const col = (f: (s: RefineSample) => number | null | undefined) =>
    samples.map((s) => {
      const v = f(s);
      return v === undefined ? null : v;
    });
  return {
    t: col((s) => s.t),
    refines: col((s) => s.refines),
    refines_per_min: col((s) => s.refinesPerMin),
    changed: col((s) => s.changed),
    change_median: col((s) => s.changeMedian),
    change_p90: col((s) => s.changeP90),
    refined_share: col((s) => s.refinedShare),
  };
}

/** Smallest 1/2/5 x 10^k at or above `need` (as the History's ladder ranges). */
export function ladder125(need: number): number {
  if (!(need > 0)) return 1;
  const e = Math.floor(Math.log10(need));
  for (const m of [1, 2, 5, 10]) if (m * 10 ** e >= need) return m * 10 ** e;
  return 10 ** (e + 1);
}

/** One run's point in the comparison across runs. */
export interface RunPoint {
  /** 'D' for Discover, else the Refine run's index. */
  label: string;
  stage: 'discover' | 'refine';
  refinesPerMin: number | null;
  medianChange: number | null;
  refinedShare: number | null;
  outcome: StageRun['outcome'];
}

/**
 * Discover's run and the Refine runs after it, for the cross-run plot, with
 * each measure's display top: its initial range or the 1/2/5 step that holds
 * every run (anchored at 0, so no change is hidden).
 */
export function runComparison(runs: readonly StageRun[]): {
  points: RunPoint[];
  rateTop: number;
  changeTop: number;
} {
  const points: RunPoint[] = [];
  for (const r of runs) {
    if (r.stage === 'extract' || r.outcome === 'running') continue;
    if (r.stage === 'discover') points.length = 0;
    points.push({
      label: r.stage === 'discover' ? 'D' : String(r.index),
      stage: r.stage,
      refinesPerMin: r.refinesPerMin ?? null,
      medianChange: r.stage === 'refine' ? (r.medianFootprintChange ?? null) : null,
      refinedShare:
        r.stage === 'refine' && r.cells > 0 && r.footprintsRefined !== undefined
          ? r.footprintsRefined / r.cells
          : null,
      outcome: r.outcome,
    });
  }
  const max = (f: (p: RunPoint) => number | null) =>
    Math.max(0, ...points.map((p) => f(p) ?? 0).filter((v) => Number.isFinite(v)));
  const top = (initial: number, need: number) => (need > initial ? ladder125(need) : initial);
  return {
    points,
    rateTop: top(
      REFINE_SERIES[0].range[1],
      max((p) => p.refinesPerMin),
    ),
    changeTop: top(
      REFINE_SERIES[1].range[1],
      max((p) => p.medianChange),
    ),
  };
}
