/**
 * Pure layout and text helpers of the worker squares (`components/WorkDisplay.tsx`) and the
 * time strip (`components/TimeStrip.tsx`). Everything here is a function of numbers, so the
 * fixed ranges and the words are tested without a DOM.
 *
 * Every range is fixed (no auto-scaling): the work plot runs 0 to the number of workers, the
 * speed plot over the Speed track's 10 to 500 fps log scale, the squares 0 to 100 %.
 */
import { SPEED_SCALE } from './speed-track.ts';
import {
  BG_SETTLE_GROUND,
  FAST_STAGE_NAMES,
  IDLE_COLOR,
  KIND_COLOR,
  WORK_KIND_LABELS,
  WORK_KINDS,
  type WorkByKind,
  type WorkerKindShares,
  type WorkKind,
} from './work-meter.ts';

/** Colours of the kinds (defined next to their labels in `work-meter.ts`, shared with the History series). */
export { BG_SETTLE_GROUND, IDLE_COLOR, KIND_COLOR };

/** Background settle's HTML fill: stripes of the settle hue over its tint, so it differs from Final settle by more than colour. */
export const BG_SETTLE_HATCH = `repeating-linear-gradient(135deg, ${BG_SETTLE_GROUND} 0 3px, ${KIND_COLOR.bgSettle} 3px 5px)`;

/** Where the Final settle segment sits: a fixed quarter of the strip's width (PI decision Q8). */
export const FINAL_SEGMENT_SHARE = 0.25;

/** Position 0..1 of `fps` on the log scale (clamped; 0 or less sits at the bottom). */
export function speedPos(fps: number, scale: { lo: number; hi: number } = SPEED_SCALE): number {
  if (!(fps > scale.lo)) return 0;
  if (fps >= scale.hi) return 1;
  return Math.log(fps / scale.lo) / Math.log(scale.hi / scale.lo);
}

/**
 * A speed curve's plan as one step line over a strip segment: `plan` is `planLine`'s `{ x, fps }`
 * (x a share 0..1 of the segment, fps 0 for Max, which sits at the top), `yTop` and `yBot` the
 * speed plot's rows. Steps draw flat with a vertical jump between them.
 */
export function planPath(
  plan: readonly { x: number; fps: number }[],
  seg: { x0: number; x1: number },
  yTop: number,
  yBot: number,
): string {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of plan) {
    xs.push(seg.x0 + (seg.x1 - seg.x0) * p.x);
    ys.push(yBot - (yBot - yTop) * speedPos(p.fps > 0 ? p.fps : Infinity));
  }
  return linePath(xs, ys);
}

/** Workers busy: the kinds' sum, never above the count. */
export function busyWorkers(totals: Record<WorkKind, number>, count: number): number {
  let sum = 0;
  for (const k of WORK_KINDS) sum += Math.max(0, totals[k] || 0);
  return Math.min(sum, count);
}

/** A worker's busy share, 0..1 (the kinds' sum). */
export function rowBusy(w: WorkerKindShares): number {
  let sum = 0;
  for (const k of WORK_KINDS) sum += w.shares[k];
  return Math.min(1, sum);
}

/** A row's label: short, so the name column stays narrow. */
export function rowLabel(w: WorkerKindShares): string {
  const n = w.name;
  if (w.group === 'fast') {
    const stage = n.replace(/^Fast loop: /, '');
    return stage === FAST_STAGE_NAMES[0] ? 'read + prepare' : stage;
  }
  if (w.group === 'slow') return 'cell model';
  if (w.group === 'visit') return n.replace(/^Visit worker /, 'footprint helper ');
  if (n.startsWith('Settle worker ')) return n.replace('Settle worker ', 'settle helper ');
  return n.replace('Look-back worker', 'look-back').trim();
}

/** What a row's worker does, for its tooltip. */
export function rowTitle(w: WorkerKindShares): string {
  if (w.group === 'fast')
    return 'The fast loop: reads and prepares each frame, corrects motion, and extracts traces, in step with the video.';
  if (w.group === 'slow')
    return 'The cell model: finds new cells and keeps the footprints and background up to date.';
  if (w.group === 'visit')
    return 'A helper that updates the footprints of cells, in parallel with the cell model.';
  if (w.name.startsWith('Settle worker '))
    return 'A helper that runs the Background settle, and the Final settle at the end.';
  return 'Look-back: re-reads earlier frames for each new cell so its footprint and trace are complete.';
}

/** The rows, with a flag where a new group starts (a hair of space between groups). */
export function groupedRows(
  by: WorkByKind | null,
): { row: WorkerKindShares; label: string; groupStart: boolean }[] {
  if (!by) return [];
  return by.workers.map((row, i) => ({
    row,
    label: rowLabel(row),
    groupStart: i > 0 && by.workers[i - 1].group !== row.group,
  }));
}

/** What the display is in. */
export type DisplayState = 'idle' | 'running' | 'paused' | 'final-settle' | 'done' | 'streaming';

export function displayState(o: {
  status: 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';
  live: boolean;
  settling: boolean;
}): DisplayState {
  if (o.status === 'done') return o.settling ? 'final-settle' : 'done';
  if (o.status === 'paused') return 'paused';
  if (o.status === 'running') return o.live ? 'streaming' : 'running';
  if (o.status === 'starting') return o.live ? 'streaming' : 'running';
  return 'idle';
}

/** `105 s` -> `1 min 45 s`; under a minute `45 s`; null or negative -> `-`. */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The Final settle's planned frames: the recording, at most the settle's cap (the run's `settle.final.max_s`, frames). */
export function plannedSettleFrames(recordingFrames: number, cap: number): number {
  return Number.isFinite(recordingFrames) ? Math.min(recordingFrames, cap) : 0;
}

/** One footprint's settledness, as the engine or the slow worker will report it (measure defined elsewhere). */
export interface FootprintSettledness {
  id: number;
  state: 'settled' | 'settling' | 'new';
  /** 0..1, higher = more settled; null until the measure exists. */
  confidence: number | null;
}

/** The settledness slot's numbers, or null while the measure does not exist (the slot then says so). */
export function settledSummary(
  list: readonly FootprintSettledness[] | null | undefined,
): { settled: number; settling: number; fresh: number; total: number } | null {
  if (!list) return null;
  let settled = 0;
  let settling = 0;
  let fresh = 0;
  for (const f of list) {
    if (f.state === 'settled') settled++;
    else if (f.state === 'settling') settling++;
    else fresh++;
  }
  return { settled, settling, fresh, total: list.length };
}

/** The strip's two segments, in px: Discover keeps 3/4 of the width, Final settle the fixed quarter. */
export interface StripLayout {
  discover: { x0: number; x1: number };
  final: { x0: number; x1: number } | null;
}

/**
 * `left` and `right` are the plot's margins. With a Final settle the strip always reserves the
 * quarter (a gap of `gap` px between), so Discover's scale does not change when the settle starts.
 */
export function stripLayout(
  width: number,
  left: number,
  right: number,
  withFinal: boolean,
  gap = 8,
): StripLayout {
  const inner = Math.max(1, width - left - right);
  if (!withFinal) return { discover: { x0: left, x1: left + inner }, final: null };
  const fw = inner * FINAL_SEGMENT_SHARE;
  const dEnd = left + inner - fw - gap;
  return {
    discover: { x0: left, x1: Math.max(left + 1, dEnd) },
    final: { x0: left + inner - fw, x1: left + inner },
  };
}

/** A sample of the stacked work plot. */
export interface StackPoint {
  x: number;
  values: Record<WorkKind, number>;
}

/**
 * Work readings as steps. Each reading is the mean over the interval since the one before it,
 * so it is drawn flat back to the previous reading's x (the first reading only marks its own x:
 * the caller stamps a run's first reading also where its interval opened). Input sorted by x.
 */
export function stepPoints(points: readonly StackPoint[]): StackPoint[] {
  const out: StackPoint[] = [];
  points.forEach((p, i) => {
    if (i > 0) out.push({ x: points[i - 1].x, values: p.values });
    out.push(p);
  });
  return out;
}

/**
 * The stacked work plot's bands: per kind (fixed order), the y of its top and bottom edge at each
 * point, in the fixed range 0 to `count` mapped to `yBottom` .. `yTop`. The stack is clamped at `count`.
 */
export function stackBands(
  points: readonly StackPoint[],
  count: number,
  yTop: number,
  yBottom: number,
): { kind: WorkKind; x: number[]; top: number[]; bottom: number[] }[] {
  const n = Math.max(1, count);
  const y = (w: number) => yBottom - (yBottom - yTop) * (Math.min(n, Math.max(0, w)) / n);
  const base = points.map(() => 0);
  const out: { kind: WorkKind; x: number[]; top: number[]; bottom: number[] }[] = [];
  for (const kind of WORK_KINDS) {
    const top = points.map((p, i) => base[i] + Math.max(0, p.values[kind] || 0));
    out.push({
      kind,
      x: points.map((p) => p.x),
      top: top.map(y),
      bottom: base.map(y),
    });
    top.forEach((t, i) => (base[i] = t));
  }
  return out;
}

/** An SVG polygon path of one band (empty when it has no thickness anywhere). */
export function bandPath(b: { x: number[]; top: number[]; bottom: number[] }): string {
  if (b.x.length === 0) return '';
  if (!b.top.some((t, i) => b.bottom[i] - t > 0.05)) return '';
  const f = (v: number) => v.toFixed(1);
  const up = b.x.map((x, i) => `${f(x)},${f(b.top[i])}`).join(' L');
  const dn = b.x
    .map((x, i) => `${f(x)},${f(b.bottom[i])}`)
    .reverse()
    .join(' L');
  return `M${up} L${dn} Z`;
}

/** A polyline path through (x, y) pairs, lifting the pen at a NaN y. */
export function linePath(x: readonly number[], y: readonly number[]): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(y[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x[i].toFixed(1)},${y[i].toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Thin out `n` sample indices to at most `max` (keeps the first and last). */
export function thinIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (n - 1)) / (max - 1)));
  return out;
}

/** A row's busy split as words, for the bar's accessible name (the tooltips are not enough). */
export function rowAriaLabel(label: string, w: WorkerKindShares): string {
  const parts = WORK_KINDS.filter((k) => w.shares[k] > 0).map(
    (k) => `${WORK_KIND_LABELS[k]} ${Math.round(100 * w.shares[k])}%`,
  );
  const busy = Math.round(100 * rowBusy(w));
  return `${label}: ${busy}% busy${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`;
}

/**
 * Which rows to mark "stopped". The whole look-back stopping (an error) marks every look-back
 * row. A pool worker that failed alone is known only by count (`capacity` is the need-driven
 * worker plus the pool workers still serving), not by identity, so the missing workers are
 * marked on the last pool rows.
 */
export function stoppedLookbackRows(
  workers: readonly WorkerKindShares[],
  capacity: number | undefined,
  whole: boolean,
): boolean[] {
  const flags = workers.map(() => false);
  const lb: number[] = [];
  workers.forEach((w, i) => {
    if (w.group === 'lookback') lb.push(i);
  });
  if (whole) {
    for (const i of lb) flags[i] = true;
    return flags;
  }
  if (capacity === undefined || lb.length <= 1) return flags;
  const poolRows = lb.slice(1);
  const lost = Math.min(poolRows.length, Math.max(0, lb.length - capacity));
  for (const i of poolRows.slice(poolRows.length - lost)) flags[i] = true;
  return flags;
}

/**
 * Per-footprint settledness from the "still moving" hints (`cells.stillMoving()`: cell id to the
 * larger of its last core and edge step over its split-half noise). A cell with a hint above `k`
 * is still settling, one at or below it is settled, one with no hint yet (born after the last
 * checkpoint) is too new to tell. Null before any checkpoint produced hints. The confidence is
 * left null: the hint is a ratio, not a probability.
 */
export function settlednessFromHints(
  ids: readonly number[],
  hints: ReadonlyMap<number, number>,
  k: number,
): FootprintSettledness[] | null {
  if (hints.size === 0 || ids.length === 0) return null;
  return ids.map((id): FootprintSettledness => {
    const r = hints.get(id);
    return {
      id,
      state: r === undefined ? 'new' : r > k ? 'settling' : 'settled',
      confidence: null,
    };
  });
}

/** The worker grid's groups, in display order: a short heading over the squares of each. */
export const GRID_GROUP_LABEL: Record<WorkerKindShares['group'], string> = {
  fast: 'Frame loop',
  slow: 'Cell model',
  visit: 'Footprint helpers',
  lookback: 'Look-back and settle',
};

/**
 * A square's fill, bottom up: one segment per job in the fixed kind order, each as tall as that
 * job's share of the worker's last second (percent of the square). The segments add up to the
 * busy share; a hair over 100 % is scaled down so the fill never overflows.
 */
export function squareStack(w: WorkerKindShares): { kind: WorkKind; pct: number }[] {
  let sum = 0;
  for (const k of WORK_KINDS) sum += Math.max(0, w.shares[k] || 0);
  const scale = sum > 1 ? 1 / sum : 1;
  return WORK_KINDS.map((kind) => ({ kind, pct: 100 * Math.max(0, w.shares[kind] || 0) * scale }));
}

/** A square's hover text: which worker, what it does, and its last second split by job. */
export function squareTitle(label: string, w: WorkerKindShares): string {
  const busy = Math.round(100 * rowBusy(w));
  const parts = WORK_KINDS.filter((k) => w.shares[k] > 0.005).map(
    (k) => `${WORK_KIND_LABELS[k]} ${Math.round(100 * w.shares[k])} %`,
  );
  return `${label}: ${rowTitle(w)}\nBusy ${busy} % of the last second${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.`;
}

export interface GridSquare {
  row: WorkerKindShares;
  label: string;
  /** Position in the reading (stable across readings: the workers come in a fixed order). */
  index: number;
}

/** The squares grouped by worker group, in the reading's order. */
export function gridGroups(
  by: WorkByKind | null,
): { group: WorkerKindShares['group']; label: string; squares: GridSquare[] }[] {
  const out: { group: WorkerKindShares['group']; label: string; squares: GridSquare[] }[] = [];
  groupedRows(by).forEach((r, index) => {
    const last = out.at(-1);
    const sq = { row: r.row, label: r.label, index };
    if (last && last.group === r.row.group) last.squares.push(sq);
    else out.push({ group: r.row.group, label: GRID_GROUP_LABEL[r.row.group], squares: [sq] });
  });
  return out;
}
