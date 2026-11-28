/**
 * What the Cell and QC tabs show of the QC snapshot: each cell's status, the
 * counts and filter of the QC summary, the cells listed when none is selected,
 * and the display spec of every metric (label, fixed range, threshold). Pure,
 * unit-tested. The thresholds are the pass/flag rules of `qc.ts`; the bar
 * ranges are the FOV's colour scales (`METRIC_SCALE`) so a bar and the overlay
 * colour read the same.
 */
import {
  FLAG_CORRELATED_PAIR,
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  FLAG_UNMEASURED,
  followsMotion,
  MIN_SNR,
  MOTION_R2_FLAG,
  PAIR_R,
  type CellQcRow,
} from './qc.ts';
import { METRIC_SCALE } from './qc-colors.ts';

/** A cell's QC status: three disjoint buckets that together hold every cell. */
export type QcStatus = 'pass' | 'fail' | 'unmeasured';

/** Status of one cell; a cell without a QC row is not measured. */
export function qcStatus(row: CellQcRow | undefined): QcStatus {
  if (!row || row.flags & FLAG_UNMEASURED) return 'unmeasured';
  return row.pass ? 'pass' : 'fail';
}

/** Label of each status, as the summary and the status marks spell it. */
export const QC_STATUS_LABEL: Record<QcStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  unmeasured: 'not measured',
};

/** Cells per status; `all` is their sum. */
export type QcCounts = Record<QcStatus, number> & { all: number };

/** Count `rows` by status. */
export function qcCounts(rows: readonly CellQcRow[]): QcCounts {
  const c: QcCounts = { all: 0, pass: 0, fail: 0, unmeasured: 0 };
  for (const r of rows) {
    c.all++;
    c[qcStatus(r)]++;
  }
  return c;
}

/** The QC table's filter: every cell, or one status. */
export type QcFilter = 'all' | QcStatus;

/** `rows` kept by `filter` (in their order). */
export function filterRows(rows: readonly CellQcRow[], filter: QcFilter): readonly CellQcRow[] {
  return filter === 'all' ? rows : rows.filter((r) => qcStatus(r) === filter);
}

/**
 * Why a measured cell is flagged, as short words joined by ", " (empty when
 * nothing is flagged): the failing rules first (low SNR, likely duplicate),
 * then the cautions that do not change pass/fail (the stronger member of a
 * correlated pair, a trace that follows motion).
 */
export function qcReason(row: CellQcRow): string {
  if (row.flags & FLAG_UNMEASURED) return '';
  const out: string[] = [];
  if (row.flags & FLAG_LOW_SNR) out.push('low SNR');
  if (row.flags & FLAG_LIKELY_DUPLICATE) out.push('duplicate?');
  else if (row.flags & FLAG_CORRELATED_PAIR) out.push('pair');
  if (followsMotion(row)) out.push('motion');
  return out.join(', ');
}

/**
 * Up to `n` measured cells with the highest peak SNR, largest first (ties by
 * id); cells without a finite SNR are left out.
 */
export function topBySnr(rows: readonly CellQcRow[], n: number): CellQcRow[] {
  return rows
    .filter((r) => qcStatus(r) !== 'unmeasured' && Number.isFinite(r.peakSnr))
    .sort((a, b) => b.peakSnr - a.peakSnr || a.id - b.id)
    .slice(0, Math.max(0, n));
}

/** Metrics with a display spec. */
export type QcMetricKey =
  | 'peakSnr'
  | 'maxNeighbourR'
  | 'motionR2'
  | 'projR'
  | 'vif'
  | 'maxOverlap'
  | 'fpError'
  | 'eventRate';

/** How one metric is drawn: a bullet bar on a fixed range with an optional threshold tick, or a figure. */
export interface QcMetricSpec {
  key: QcMetricKey;
  /** Visible label. */
  label: string;
  /** Explanation (tooltip and "?" text). */
  help: string;
  /** Fixed bar range; absent for a metric with no absolute scale (drawn as a figure only). */
  range?: { min: number; max: number };
  /** The rule's threshold, drawn as a tick; absent when no threshold separates good from bad. */
  threshold?: number;
  /** Decimals of the figure. */
  digits: number;
  /** Unit after the figure. */
  unit?: string;
}

/** Every metric's display spec, in the order the Cell tab lists them. */
export const QC_METRICS: readonly QcMetricSpec[] = [
  {
    key: 'peakSnr',
    label: 'Peak SNR',
    help: `Peak SNR in noise units. Pass needs at least ${MIN_SNR} (the tick).`,
    range: { min: METRIC_SCALE.peakSnr.lo, max: METRIC_SCALE.peakSnr.hi },
    threshold: MIN_SNR,
    digits: 1,
  },
  {
    key: 'maxNeighbourR',
    label: 'Neighbour r',
    help: `Largest trace correlation with an overlapping neighbour. Above ${PAIR_R} (the tick) the two are a pair; the weaker one is flagged a likely duplicate.`,
    range: { min: 0, max: 1 },
    threshold: PAIR_R,
    digits: 2,
  },
  {
    key: 'motionR2',
    label: 'Motion R²',
    help: `Cross-validated R² of the trace on the frame's rigid shift. Above ${MOTION_R2_FLAG} (the tick) the trace follows motion: a flag only, pass/fail is unchanged. Negative values sit at the left end.`,
    range: { min: 0, max: 1 },
    threshold: MOTION_R2_FLAG,
    digits: 2,
  },
  {
    key: 'projR',
    label: 'Trace fidelity',
    help: 'Trace vs its own footprint projection (proj r); low = neighbours take its light. A validated score with no threshold.',
    range: { min: METRIC_SCALE.projR.lo, max: METRIC_SCALE.projR.hi },
    digits: 2,
  },
  {
    key: 'vif',
    label: 'Crosstalk (vif)',
    help: 'Variance inflation from overlapping footprints: 1 = none. Expected crosstalk, no threshold.',
    range: { min: METRIC_SCALE.vif.lo, max: METRIC_SCALE.vif.hi },
    digits: 2,
  },
  {
    key: 'maxOverlap',
    label: 'Max overlap',
    help: 'Largest normalised footprint overlap with a neighbour. No threshold.',
    range: { min: 0, max: 1 },
    digits: 2,
  },
  {
    key: 'fpError',
    label: 'Footprint error',
    help: 'Footprint mismatch, relative only: it has no absolute scale and no threshold, so it is a figure, not a bar.',
    digits: 2,
  },
  {
    key: 'eventRate',
    label: 'Events',
    help: 'Events per minute. Descriptive only.',
    digits: 1,
    unit: '/min',
  },
];

/** The spec of one metric. */
export function qcMetric(key: QcMetricKey): QcMetricSpec {
  const m = QC_METRICS.find((x) => x.key === key);
  if (!m) throw new Error(`no QC metric ${key}`);
  return m;
}

/** A metric's figure with its spec's decimals, or null when not measured (drawn as a grey dash). */
export function metricText(spec: QcMetricSpec, v: number | undefined): string | null {
  return v === undefined || !Number.isFinite(v) ? null : v.toFixed(spec.digits);
}
