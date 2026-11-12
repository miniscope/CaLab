/**
 * Online quality control on the main thread: the wire format of the QC
 * snapshots the fast worker sends, their parsed form, the plain-language
 * verdict of a cell, the cell table's ordering, and the run's convergence
 * status. Pure, unit-tested.
 *
 * The metrics come from `QcMonitor` (crates/cala/src/qc), validated against
 * ground truth in PR #284. Only some of them are judgements:
 *   - pass/fail (`pass`, `flags`): enough history, peak SNR >= 5, and not the
 *     weaker member of a pair of overlapping cells whose traces correlate
 *     above 0.8 (a likely split or duplicate);
 *   - proj_r (trace fidelity) and vif / max overlap (expected crosstalk) are
 *     validated scores without a threshold;
 *   - fp_error has no threshold that separates good from bad footprints and is
 *     only a colour scale;
 *   - motion_r2 (trace follows motion) is flagged above 0.2 but never fails a
 *     cell: display only;
 *   - shape metrics (rise/decay, skew, slow share, zero share, event rate,
 *     footprint size and stability) are descriptive only, never a failure.
 */

/** `FLAG_*` bits of `CellQc.flags` (crates/cala/src/qc/mod.rs). */
export const FLAG_LOW_SNR = 1;
export const FLAG_CORRELATED_PAIR = 2;
export const FLAG_LIKELY_DUPLICATE = 4;
export const FLAG_UNMEASURED = 8;
/** Trace follows the frame's rigid shift (motion_r2 above MOTION_R2_FLAG). Display only, not in `pass`. */
export const FLAG_FOLLOWS_MOTION = 16;

/** `motion_r2` above which a cell is flagged "follows motion" (sensor-gain shimmer or motion artifact). */
export const MOTION_R2_FLAG = 0.2;

/** True when the cell's trace follows motion (from the value, so old wire formats without the flag bit work too). */
export function followsMotion(r: Pick<CellQcRow, 'motionR2' | 'flags'>): boolean {
  return (r.flags & FLAG_FOLLOWS_MOTION) !== 0 || r.motionR2 > MOTION_R2_FLAG;
}

/** Peak SNR below which a cell fails (the Rust `PassRule.min_snr`). */
export const MIN_SNR = 5;
/** Trace r above which two overlapping cells are a correlated pair. */
export const PAIR_R = 0.8;

/** A QC snapshot as the fast worker sends it (buffers are transferred). */
export interface QcWire {
  /** Stream frame after the last frame the monitor observed. */
  frame: number;
  /** Library version the metrics refer to (slot order). */
  version: number;
  /** `QcMonitor.cellFields()` / `globalFields()`, split. */
  cellFields: string[];
  globalFields: string[];
  /** `cells x cellFields`, row-major, library slot order. */
  cells: Float64Array;
  global: Float64Array;
  /** Cell `i`'s neighbours are triples `nb[3*k..3*k+3]` = (id, overlap, trace r), k in starts[i]..starts[i+1]. */
  nbStarts: Uint32Array;
  nb: Float32Array;
  /** Residual map, `[blocks wide, blocks high, block px]` and its values (NaN outside the FOV). */
  residualDims: Uint32Array;
  residual: Float32Array;
  /** Worker time spent building this snapshot, ms. */
  buildMs: number;
}

export function qcTransferables(w: QcWire): ArrayBuffer[] {
  return [w.cells, w.global, w.nbStarts, w.nb, w.residualDims, w.residual].map(
    (a) => a.buffer as ArrayBuffer,
  );
}

/** One cell's metrics (NaN where not yet defined). */
export interface CellQcRow {
  id: number;
  slot: number;
  ageFrames: number;
  /** Frames of trace history the statistics use. */
  frames: number;
  peakSnr: number;
  eventRate: number;
  projR: number;
  vif: number;
  maxOverlap: number;
  maxNeighbourR: number;
  /** -1 when none. */
  maxNeighbourId: number;
  fpError: number;
  /**
   * Cross-validated R² of the trace on a quadratic of the rigid shift (NaN
   * without motion data or before enough frames; negative values kept).
   */
  motionR2: number;
  nNeighbours: number;
  /** Descriptive only. */
  fpLastR: number;
  slowFrac: number;
  zeroFrac: number;
  diffSkew: number;
  fpRadiusPx: number;
  flags: number;
  pass: boolean;
}

export interface Neighbour {
  id: number;
  /** Normalised footprint overlap. */
  overlap: number;
  /** Trace correlation over the shared window (NaN before it is measured). */
  r: number;
}

export interface GlobalQcRow {
  frames: number;
  cells: number;
  cellsMeasured: number;
  explained: number;
  residualExcess: number;
  addsPerMin: number;
  removesPerMin: number;
  footprintChangesPerMin: number;
  snrMedian: number;
  passFrac: number;
  pairFrac: number;
  /**
   * Existing-cell stability against each cell's state 1-2 min ago: cells
   * compared, median footprint cosine, median relative change of the trace
   * noise, share stable (NaN before the first comparison).
   */
  stableCells: number;
  fpStability: number;
  traceSigmaChange: number;
  stableFrac: number;
}

export interface ResidualMap {
  blocksWide: number;
  blocksHigh: number;
  blockPx: number;
  values: Float32Array;
}

export interface QcSnapshot {
  frame: number;
  version: number;
  rows: CellQcRow[];
  byId: Map<number, CellQcRow>;
  neighbours: Map<number, Neighbour[]>;
  global: GlobalQcRow;
  residual: ResidualMap;
  buildMs: number;
}

function reader(fields: string[], data: ArrayLike<number>, stride: number) {
  const index = new Map(fields.map((f, i) => [f, i]));
  return (row: number, name: string): number => {
    const i = index.get(name);
    return i === undefined ? NaN : Number(data[row * stride + i]);
  };
}

/** Parse a wire snapshot (field order is read from the names, not assumed). */
export function parseQc(w: QcWire): QcSnapshot {
  const stride = w.cellFields.length;
  const n = stride > 0 ? Math.floor(w.cells.length / stride) : 0;
  const get = reader(w.cellFields, w.cells, stride);
  const rows: CellQcRow[] = [];
  const byId = new Map<number, CellQcRow>();
  const neighbours = new Map<number, Neighbour[]>();
  for (let s = 0; s < n; s++) {
    const row: CellQcRow = {
      id: get(s, 'id'),
      slot: s,
      ageFrames: get(s, 'age_frames'),
      frames: get(s, 'frames'),
      peakSnr: get(s, 'peak_snr'),
      eventRate: get(s, 'event_rate'),
      projR: get(s, 'proj_r'),
      vif: get(s, 'vif'),
      maxOverlap: get(s, 'max_overlap'),
      maxNeighbourR: get(s, 'max_neighbour_r'),
      maxNeighbourId: get(s, 'max_neighbour_id'),
      fpError: get(s, 'fp_error'),
      motionR2: get(s, 'motion_r2'),
      nNeighbours: get(s, 'n_neighbours'),
      fpLastR: get(s, 'fp_last_r'),
      slowFrac: get(s, 'slow_frac'),
      zeroFrac: get(s, 'zero_frac'),
      diffSkew: get(s, 'diff_skew'),
      fpRadiusPx: get(s, 'fp_radius_px'),
      flags: get(s, 'flags') | 0,
      pass: get(s, 'pass') === 1,
    };
    rows.push(row);
    byId.set(row.id, row);
    const list: Neighbour[] = [];
    const a = w.nbStarts[s] ?? 0;
    const b = w.nbStarts[s + 1] ?? a;
    for (let k = a; k < b; k++) {
      list.push({ id: w.nb[3 * k], overlap: w.nb[3 * k + 1], r: w.nb[3 * k + 2] });
    }
    neighbours.set(row.id, list);
  }
  const g = reader(w.globalFields, w.global, 0);
  const gv = (name: string) => g(0, name);
  return {
    frame: w.frame,
    version: w.version,
    rows,
    byId,
    neighbours,
    global: {
      frames: gv('frames'),
      cells: gv('cells'),
      cellsMeasured: gv('cells_measured'),
      explained: gv('explained'),
      residualExcess: gv('residual_excess'),
      addsPerMin: gv('adds_per_min'),
      removesPerMin: gv('removes_per_min'),
      footprintChangesPerMin: gv('footprint_changes_per_min'),
      snrMedian: gv('snr_median'),
      passFrac: gv('pass_frac'),
      pairFrac: gv('pair_frac'),
      stableCells: gv('stable_cells'),
      fpStability: gv('fp_stability'),
      traceSigmaChange: gv('trace_sigma_change'),
      stableFrac: gv('stable_frac'),
    },
    residual: {
      blocksWide: w.residualDims[0] ?? 0,
      blocksHigh: w.residualDims[1] ?? 0,
      blockPx: w.residualDims[2] ?? 1,
      values: w.residual,
    },
    buildMs: w.buildMs,
  };
}

export type VerdictKind = 'pass' | 'fail' | 'pending';

export interface Verdict {
  kind: VerdictKind;
  /** Short label, e.g. "passes", "low SNR", "possible duplicate of #12". */
  label: string;
  /** Plain-language reasons (validated judgements first, then cautions). */
  notes: string[];
}

/**
 * Plain-language verdict of one cell. Only the validated rule (`pass`, from
 * Rust) decides pass/fail; a correlated pair where this cell is the stronger
 * member, or low proj_r, are cautions, not failures.
 */
export function verdict(row: CellQcRow | undefined): Verdict {
  if (!row || row.flags & FLAG_UNMEASURED) {
    return {
      kind: 'pending',
      label: 'not measured yet',
      notes: ['QC needs about a minute of trace history for this cell.'],
    };
  }
  const notes: string[] = [];
  const parts: string[] = [];
  const other = row.maxNeighbourId >= 0 ? `#${row.maxNeighbourId}` : 'a neighbour';
  if (row.flags & FLAG_LOW_SNR) {
    parts.push('low SNR');
    notes.push(
      `Peak SNR ${row.peakSnr.toFixed(1)} is below ${MIN_SNR}: its events barely rise above the noise.`,
    );
  }
  if (row.flags & FLAG_LIKELY_DUPLICATE) {
    parts.push(`possible duplicate of ${other}`);
    notes.push(
      `Its trace follows ${other} (r ${row.maxNeighbourR.toFixed(2)} > ${PAIR_R}) and it is the weaker of the two: likely a split or duplicate of that cell.`,
    );
  } else if (row.flags & FLAG_CORRELATED_PAIR) {
    notes.push(
      `Its trace follows ${other} (r ${row.maxNeighbourR.toFixed(2)}); this is the stronger of the pair, so the other one is flagged.`,
    );
  }
  if (row.projR < 0.5) {
    notes.push(
      `Its trace agrees only weakly with its own footprint's light (proj r ${row.projR.toFixed(2)}): neighbours or the background may be taking its signal.`,
    );
  }
  if (row.vif > 2) {
    notes.push(
      `Overlapping neighbours inflate its trace noise (vif ${row.vif.toFixed(1)}); expect some crosstalk.`,
    );
  }
  if (row.pass) {
    return { kind: 'pass', label: 'passes', notes };
  }
  return { kind: 'fail', label: parts.join(', ') || 'fails', notes };
}

/** Rank for "flagged first": failing, then caution (correlated pair), then passing, then unmeasured. */
function flagRank(r: CellQcRow): number {
  if (r.flags & FLAG_UNMEASURED) return 3;
  if (!r.pass) return 0;
  if (r.flags & FLAG_CORRELATED_PAIR) return 1;
  return 2;
}

export type SortKey =
  | 'flagged'
  | 'id'
  | 'peakSnr'
  | 'projR'
  | 'vif'
  | 'maxNeighbourR'
  | 'fpError'
  | 'motionR2'
  | 'eventRate'
  | 'ageFrames';

/** NaN sorts last whichever the direction. */
function cmpNum(a: number, b: number, dir: 1 | -1): number {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  return dir * (a - b);
}

/**
 * Order rows for the cell table. `flagged` (default): failing cells first,
 * then the stronger member of correlated pairs, then passing, then
 * unmeasured; within a group by SNR ascending so the doubtful come first.
 */
export function sortRows(rows: readonly CellQcRow[], key: SortKey, dir: 1 | -1 = 1): CellQcRow[] {
  const out = [...rows];
  if (key === 'flagged') {
    out.sort(
      (a, b) => dir * (flagRank(a) - flagRank(b)) || cmpNum(a.peakSnr, b.peakSnr, 1) || a.id - b.id,
    );
  } else {
    out.sort((a, b) => cmpNum(a[key], b[key], dir) || a.id - b.id);
  }
  return out;
}

/** Pearson correlation over the samples finite in both (NaN with fewer than 3). */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      sa += a[i];
      sb += b[i];
      k++;
    }
  }
  if (k < 3) return NaN;
  const ma = sa / k;
  const mb = sb / k;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** Scale a trace to [0, 1] over its finite values (min to max); NaN stays NaN. */
export function normalize(v: ArrayLike<number>): Float64Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(v[i])) {
      lo = Math.min(lo, v[i]);
      hi = Math.max(hi, v[i]);
    }
  }
  const out = new Float64Array(v.length);
  const span = hi > lo ? hi - lo : 1;
  for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? (v[i] - lo) / span : NaN;
  return out;
}

/**
 * One line on how well a cell is demixed from its overlapping neighbours.
 * Uses the validated pair flag (trace r > 0.8) and vif; fp_error has no
 * threshold and is not used.
 */
export function demixVerdict(row: CellQcRow | undefined, neighbours: readonly Neighbour[]): string {
  if (!row || row.flags & FLAG_UNMEASURED) return 'not measured yet';
  if (neighbours.length === 0) return 'independent: no overlapping neighbours';
  const other = row.maxNeighbourId >= 0 ? `#${row.maxNeighbourId}` : 'a neighbour';
  if (row.flags & FLAG_LIKELY_DUPLICATE) return `possible split or duplicate of ${other}`;
  if (row.flags & FLAG_CORRELATED_PAIR) {
    return `traces track ${other} (r ${row.maxNeighbourR.toFixed(2)}); ${other} is the likely duplicate`;
  }
  const r = Number.isFinite(row.maxNeighbourR) ? ` (max r ${row.maxNeighbourR.toFixed(2)})` : '';
  const vif = row.vif > 2 ? `, but overlap inflates its noise (vif ${row.vif.toFixed(1)})` : '';
  return `independent: neighbours' traces are distinct${r}${vif}`;
}

// ---------------------------------------------------------------------------
// Convergence

/** Slow-loop edit counters (cumulative), as in `SlowCounters`. */
export interface EditTotals {
  adds: number;
  merges: number;
  splits: number;
  deletes: number;
  /** Add classification: see `SlowCounters`. */
  newAdds: number;
  reAdds: number;
  churned: number;
  establishedRemovals: number;
}

export const EDIT_KEYS = [
  'adds',
  'merges',
  'splits',
  'deletes',
  'newAdds',
  'reAdds',
  'churned',
  'establishedRemovals',
] as const satisfies readonly (keyof EditTotals)[];

/** Churn of the library: re-adds, adds removed again soon, removals of established cells. */
export function churnPerMin(e: EditTotals): number {
  return e.reAdds + e.churned + e.establishedRemovals;
}

/** One point of the convergence history (one per QC snapshot). */
export interface ConvergencePoint {
  /** Minutes of recording read. */
  minutes: number;
  cells: number;
  explained: number;
  residualExcess: number;
  snrMedian: number;
  passFrac: number;
  /** Existing-cell stability (`GlobalQcRow`). */
  stableCells: number;
  fpStability: number;
  traceSigmaChange: number;
  stableFrac: number;
  /** Library adds and removes per minute (QC, from library versions). */
  addsPerMin: number;
  removesPerMin: number;
  /** Slow-loop edits per minute by type (NaN before the slow loop reports). */
  edits: EditTotals;
}

/**
 * The recent convergence points the status rule reads: those within
 * `keepMin` minutes of stream of the newest, plus one older point (the rule
 * needs to know the history reaches back past its window). Older points are
 * dropped whole, never thinned; the History view keeps the whole run in
 * `RunHistory` instead.
 */
export class ConvergenceHistory {
  readonly keepMin: number;
  points: ConvergencePoint[] = [];

  constructor(keepMin = 2 * CONVERGENCE_RULE.windowMin) {
    this.keepMin = Math.max(CONVERGENCE_RULE.windowMin, keepMin);
  }

  push(p: ConvergencePoint): void {
    this.points.push(p);
    const from = p.minutes - this.keepMin;
    let drop = 0;
    while (drop + 1 < this.points.length && this.points[drop + 1].minutes <= from) drop++;
    if (drop > 64 || (drop > 0 && drop * 2 > this.points.length)) this.points.splice(0, drop);
  }

  clear(): void {
    this.points = [];
  }
}

/**
 * Per-minute rates of the slow loop's cumulative edit counters over the last
 * `windowMin` minutes of recording (stream time, not wall time).
 */
export class EditRates {
  private samples: { minutes: number; totals: EditTotals }[] = [];
  private readonly windowMin: number;

  constructor(windowMin = 1) {
    this.windowMin = windowMin;
  }

  push(minutes: number, totals: EditTotals): void {
    const last = this.samples.at(-1);
    if (last && minutes <= last.minutes) {
      last.totals = totals;
      return;
    }
    this.samples.push({ minutes, totals });
    // Keep one sample older than the window as the rate's base.
    while (this.samples.length > 2 && minutes - this.samples[1].minutes >= this.windowMin) {
      this.samples.shift();
    }
  }

  rates(): EditTotals {
    const a = this.samples[0];
    const b = this.samples.at(-1);
    const dt = a && b ? b.minutes - a.minutes : 0;
    const out = {} as EditTotals;
    for (const k of EDIT_KEYS) {
      out[k] = a && b && dt > 0 ? Math.max(0, (b.totals[k] ?? 0) - (a.totals[k] ?? 0)) / dt : NaN;
    }
    return out;
  }

  clear(): void {
    this.samples = [];
  }
}

export type ConvergenceState = 'waiting' | 'discovering' | 'settling' | 'converged';

export interface ConvergenceStatus {
  state: ConvergenceState;
  /** Plain-language reason. */
  reason: string;
}

/**
 * Thresholds of the convergence rule. Cell discovery never stops on long
 * recordings (batch tools find nearly twice the cells in 30-120 min as in
 * 10-30 min), so converged means that the cells already found stopped
 * changing and spurious churn died out, not that adds stopped: new-cell adds
 * are shown as their own slowly declining curve and never block it.
 * Validated against minisim ground truth (PR body: the rule says converged
 * once GT precision has plateaued).
 */
export const CONVERGENCE_RULE = {
  /** Minutes of history the rule looks back over. */
  windowMin: 2,
  /** Discovering until this share of the cells is old enough to compare with 1-2 min ago. */
  minCompared: 0.5,
  /** Converged: at least this share of the compared cells is stable... */
  stableFrac: 0.85,
  /** ...and churn (re-adds + adds removed again + removals of established cells) per minute stays under this share of the library. */
  churn: 0.035,
} as const;

const pct = (v: number) => `${(100 * v).toFixed(1)}%`;

/**
 * Where the run stands. "discovering" while most cells are too young to be
 * judged, "settling" while existing cells still change (footprint or trace
 * noise vs 1-2 min ago) or churn is high, "converged" when both are low over
 * the last two minutes of recording. The new-cell rate is reported, never
 * judged. Says nothing about ground truth: a converged run can still miss
 * cells the slow loop cannot see.
 */
export function convergenceStatus(
  points: readonly ConvergencePoint[],
  rule = CONVERGENCE_RULE,
): ConvergenceStatus {
  const last = points.at(-1);
  if (!last || !(last.cells > 0) || !Number.isFinite(last.explained)) {
    return { state: 'waiting', reason: 'waiting for the first cells and residuals' };
  }
  const from = last.minutes - rule.windowMin;
  const win = points.filter((p) => p.minutes >= from);
  const newRate = Number.isFinite(last.edits.newAdds)
    ? `; finding ${last.edits.newAdds.toFixed(1)} new cells/min`
    : '';
  if (points[0].minutes > from || win.length === 0) {
    return { state: 'discovering', reason: `needs ${rule.windowMin} min of history` };
  }
  const compared = last.stableCells / last.cells;
  if (!Number.isFinite(last.stableFrac) || !(compared >= rule.minCompared)) {
    return {
      state: 'discovering',
      reason: `most cells are under a minute old${newRate}`,
    };
  }
  const churns = win
    .map((p) => churnPerMin(p.edits) / Math.max(1, p.cells))
    .filter(Number.isFinite);
  if (churns.length === 0) {
    return { state: 'discovering', reason: 'waiting for slow-loop counts' };
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const churn = mean(churns);
  // Averaged over the window: each cell is compared with a snapshot 1-2 min
  // old, so single readings saw-tooth with the snapshot's age.
  const fracs = win.map((p) => p.stableFrac).filter(Number.isFinite);
  const stableFrac = mean(fracs);
  const stable = stableFrac >= rule.stableFrac;
  const calm = churn < rule.churn;
  if (stable && calm) {
    return {
      state: 'converged',
      reason: `${pct(stableFrac)} of cells stable, churn ${pct(churn)}/min${newRate}`,
    };
  }
  const moving = [
    !stable && `${pct(1 - stableFrac)} of cells still changing`,
    !calm && `churn ${pct(churn)} of cells/min`,
  ].filter(Boolean);
  return { state: 'settling', reason: `${moving.join(', ')}${newRate}` };
}
