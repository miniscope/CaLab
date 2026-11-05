/**
 * Dataset overview: model-free, display-only per-cell quality metrics and the
 * dataset-level aggregates the overview cards draw.
 *
 * Nothing here reads solver state and nothing here feeds the solver. The
 * per-cell numbers come from the WASM `overview_cell` binding (Rust source
 * `crates/solver/src/overview.rs`, built on the shipped SNR metric in
 * `snr.rs`); this module turns them into dataset-relative views: SNR
 * quantile ranks, robust outlier flags, the pooled event-height
 * distribution and the population baseline over time.
 *
 * Solver-derived quantities (PVE, the processed-space PVE ceiling) live on
 * the solver results instead; the ceiling-curve helpers at the bottom take
 * those as plain numbers and never read an overview.
 */

/** Per-cell overview metrics, as returned by WASM `overview_cell` (snake_case JSON). */
export interface CellOverviewJson {
  snr: number;
  sigma: number;
  /** Absent (undefined) unless the trace was declared ΔF/F. */
  nu?: number | null;
  n_events: number;
  is_silent: boolean;
  event_rate_hz: number;
  median_event_height: number;
  height_quantiles: number[];
  /** NaN (a JS number) for a bin without finite samples. */
  baseline_bins: (number | null)[];
  baseline_start: number | null;
  baseline_end: number | null;
  n_at_max: number;
  clip_fraction: number;
  nan_count: number;
  longest_gap_frames: number;
}

/** Per-cell overview metrics (camelCase; see `crates/solver/src/overview.rs`). */
export interface CellOverview {
  /** Shipped top-slice measured SNR. Pure noise measures about 2.7. */
  snr: number;
  /** MAD-of-differences noise σ, raw units. */
  sigma: number;
  /** CASCADE ν; null unless the data were declared ΔF/F. */
  nu: number | null;
  nEvents: number;
  /** No event clears the noise-derived floor (the explicit "nothing there" answer). */
  isSilent: boolean;
  eventRateHz: number;
  medianEventHeight: number;
  /** Event heights / the cell's own median height at p = .05….95; empty with < 3 events. */
  heightQuantiles: number[];
  /** Per-time-bin low quantile of the trace (raw units; NaN for an empty bin). */
  baselineBins: number[];
  baselineStart: number;
  baselineEnd: number;
  /** Finite samples at the trace maximum (saturation evidence). */
  nAtMax: number;
  clipFraction: number;
  nanCount: number;
  longestGapFrames: number;
}

/** Fixed, documented settings of the overview pass (shown in card tooltips). */
export const OVERVIEW_PARAMS = {
  /** Minimum time between two events before any kernel exists (s). Roughly a
   *  GCaMP decay time; one default for every dataset so the pass stays model-free. */
  eventSeparationS: 0.5,
  /** Number of time bins in each cell's coarse baseline series. */
  baselineBins: 200,
  /** Measured SNR of pure Gaussian noise (top-1 % slice), see snr.rs. */
  noiseFloorSnr: 2.7,
  /** Upper edge of the "≈ noise floor" band: pure noise reads 2.5–2.9. */
  noiseFloorBandHi: 3.0,
  /** Modified z-score cut-off for metric outliers (Iglewicz & Hoaglin 1993). */
  outlierZ: 3.5,
  /** Samples at the trace maximum needed to call a cell clipped. */
  clipMinSamples: 3,
  /** Event heights need at least this many events for the shape comparison. */
  minEventsForShape: 3,
} as const;

/** Probabilities of `heightQuantiles`. */
export const HEIGHT_PROBS: readonly number[] = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);

export type QualityFlag =
  'silent' | 'clipped' | 'gap' | 'outlier-noise' | 'outlier-height' | 'outlier-drift';

export const FLAG_LABELS: Record<QualityFlag, string> = {
  silent: 'Silent',
  clipped: 'Clipped',
  gap: 'Gaps (NaN/Inf)',
  'outlier-noise': 'Noise σ outlier',
  'outlier-height': 'Event-height shape outlier',
  'outlier-drift': 'Baseline drift outlier',
};

export const FLAG_DESCRIPTIONS: Record<QualityFlag, string> = {
  silent: 'No event clears the noise-derived floor: indistinguishable from a pure-noise trace.',
  clipped: `At least ${OVERVIEW_PARAMS.clipMinSamples} samples sit exactly at the trace maximum (saturation).`,
  gap: 'The trace has non-finite samples (NaN or Inf).',
  'outlier-noise': `Noise σ far from the other cells (|modified z| > ${OVERVIEW_PARAMS.outlierZ} on log σ).`,
  'outlier-height': `Event-height distribution shaped unlike the pooled one: max log-quantile distance × √events has modified z > ${OVERVIEW_PARAMS.outlierZ}.`,
  'outlier-drift': `Start-to-end baseline change far from the other cells (|modified z| > ${OVERVIEW_PARAMS.outlierZ}) and at least one noise σ.`,
};

export const FLAG_ORDER: readonly QualityFlag[] = [
  'silent',
  'clipped',
  'gap',
  'outlier-noise',
  'outlier-height',
  'outlier-drift',
];

/**
 * How the baseline card normalises cells: `ratio` divides each cell's
 * baseline by its own median baseline (raw fluorescence, F0 well above the
 * noise); `sigma` subtracts the median and divides by the noise σ (ΔF/F or
 * detrended data, where a ratio would divide by ~0).
 */
export type BaselineMode = 'ratio' | 'sigma';

export interface PopulationBaseline {
  mode: BaselineMode;
  /** Bin centres (s). */
  time: number[];
  median: number[];
  q25: number[];
  q75: number[];
  /** Per cell: end/start ratio (ratio mode) or (end − start)/σ (sigma mode); NaN if unknown. */
  drift: number[];
}

/**
 * The dataset overview. `kind` brands it as display-only data so it cannot be
 * mistaken for (or passed where the code expects) a solver result.
 */
export interface DatasetOverview {
  readonly kind: 'dataset-overview';
  nCells: number;
  fs: number;
  durationS: number;
  cells: CellOverview[];
  flags: QualityFlag[][];
  /** Mid-rank of each cell's SNR within the dataset, in [0, 1]. */
  snrRank: number[];
  medianSnr: number;
  /** Per-probability median / 10th / 90th percentile across cells of heightQuantiles. */
  pooledHeights: { p10: number[]; p50: number[]; p90: number[] } | null;
  /** Per cell: max |log q_cell(p) − log q_pooled(p)| (NaN without enough events). */
  heightDistance: number[];
  baseline: PopulationBaseline | null;
}

// ── small numeric helpers ────────────────────────────────────────

function finiteSorted(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
}

/** Linear-interpolated quantile of an ascending array (NaN when empty). */
export function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = Math.min(Math.max(p, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median of the finite values (NaN when none). */
export function medianOf(values: readonly number[]): number {
  return quantileSorted(finiteSorted(values), 0.5);
}

/**
 * Mid-rank of every value within the array, scaled to [0, 1] (ties share the
 * mean rank; non-finite values get NaN). A single finite value ranks 0.5.
 */
export function quantileRanks(values: readonly number[]): number[] {
  const idx: number[] = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) idx.push(i);
  });
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(values.length).fill(NaN);
  const n = idx.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const rank = n === 1 ? 0.5 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k]] = rank;
    i = j + 1;
  }
  return out;
}

/**
 * Modified z-scores 0.6745·(x − median)/MAD (Iglewicz & Hoaglin). Non-finite
 * inputs and a zero MAD give 0 (no outlier can be called).
 */
export function robustZ(values: readonly number[]): number[] {
  const sorted = finiteSorted(values);
  const med = quantileSorted(sorted, 0.5);
  const mad = medianOf(sorted.map((v) => Math.abs(v - med)));
  return values.map((v) => (Number.isFinite(v) && mad > 0 ? (0.674_489_75 * (v - med)) / mad : 0));
}

// ── construction ────────────────────────────────────────────────

const toNum = (v: number | null | undefined): number => (v == null ? NaN : v);

/** Convert the WASM JSON to the camelCase type (null → NaN for numeric bins). */
export function cellOverviewFromJson(j: CellOverviewJson): CellOverview {
  return {
    snr: j.snr,
    sigma: j.sigma,
    nu: j.nu ?? null,
    nEvents: j.n_events,
    isSilent: j.is_silent,
    eventRateHz: j.event_rate_hz,
    medianEventHeight: j.median_event_height,
    heightQuantiles: j.height_quantiles,
    baselineBins: j.baseline_bins.map(toNum),
    baselineStart: toNum(j.baseline_start),
    baselineEnd: toNum(j.baseline_end),
    nAtMax: j.n_at_max,
    clipFraction: j.clip_fraction,
    nanCount: j.nan_count,
    longestGapFrames: j.longest_gap_frames,
  };
}

/** Max |log q(p) − log ref(p)| over the probabilities where both are positive. */
export function heightShapeDistance(q: readonly number[], ref: readonly number[]): number {
  if (q.length === 0 || q.length !== ref.length) return NaN;
  let d = NaN;
  for (let k = 0; k < q.length; k++) {
    if (q[k] > 0 && ref[k] > 0) {
      const v = Math.abs(Math.log(q[k]) - Math.log(ref[k]));
      d = Number.isNaN(d) ? v : Math.max(d, v);
    }
  }
  return d;
}

function pooledHeightBands(cells: readonly CellOverview[]): DatasetOverview['pooledHeights'] {
  const withShape = cells.filter((c) => c.heightQuantiles.length === HEIGHT_PROBS.length);
  if (withShape.length === 0) return null;
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (let k = 0; k < HEIGHT_PROBS.length; k++) {
    const col = finiteSorted(withShape.map((c) => c.heightQuantiles[k]));
    p10.push(quantileSorted(col, 0.1));
    p50.push(quantileSorted(col, 0.5));
    p90.push(quantileSorted(col, 0.9));
  }
  return { p10, p50, p90 };
}

/**
 * Population baseline over time. Chooses `ratio` mode when at least 80 % of
 * cells have a start baseline more than 3σ above zero, else `sigma` mode.
 */
export function populationBaseline(
  cells: readonly CellOverview[],
  durationS: number,
): PopulationBaseline | null {
  const nBins = cells.reduce((m, c) => Math.max(m, c.baselineBins.length), 0);
  if (cells.length === 0 || nBins === 0) return null;
  const positive = cells.filter(
    (c) => c.baselineStart > 3 * c.sigma && c.baselineEnd > 0 && c.sigma > 0,
  ).length;
  const mode: BaselineMode = positive >= 0.8 * cells.length ? 'ratio' : 'sigma';

  const norm: number[][] = cells.map((c) => {
    const ref = medianOf(c.baselineBins);
    if (mode === 'ratio') return c.baselineBins.map((b) => (ref > 0 ? b / ref : NaN));
    return c.baselineBins.map((b) => (c.sigma > 0 ? (b - ref) / c.sigma : NaN));
  });
  const time: number[] = [];
  const median: number[] = [];
  const q25: number[] = [];
  const q75: number[] = [];
  for (let k = 0; k < nBins; k++) {
    time.push(((k + 0.5) / nBins) * durationS);
    const col = finiteSorted(norm.map((row) => (k < row.length ? row[k] : NaN)));
    median.push(quantileSorted(col, 0.5));
    q25.push(quantileSorted(col, 0.25));
    q75.push(quantileSorted(col, 0.75));
  }
  const drift = cells.map((c) => {
    if (mode === 'ratio') return c.baselineStart > 0 ? c.baselineEnd / c.baselineStart : NaN;
    return c.sigma > 0 ? (c.baselineEnd - c.baselineStart) / c.sigma : NaN;
  });
  return { mode, time, median, q25, q75, drift };
}

/** Assemble the dataset overview from per-cell metrics. Pure; O(N·bins). */
export function buildDatasetOverview(
  cells: CellOverview[],
  fs: number,
  nTimepoints: number,
): DatasetOverview {
  const durationS = fs > 0 ? nTimepoints / fs : 0;
  const z = OVERVIEW_PARAMS.outlierZ;

  const pooledHeights = pooledHeightBands(cells);
  const heightDistance = cells.map((c) =>
    pooledHeights && c.heightQuantiles.length === HEIGHT_PROBS.length
      ? heightShapeDistance(c.heightQuantiles, pooledHeights.p50)
      : NaN,
  );
  // Quantiles of a few events are noisy, so the outlier test scales the
  // distance by √(events), as the KS statistic does: a cell is a shape
  // outlier for a difference its event count can actually resolve.
  const heightStat = heightDistance.map((d, i) => d * Math.sqrt(cells[i].nEvents));
  const baseline = populationBaseline(cells, durationS);

  const zNoise = robustZ(cells.map((c) => (c.sigma > 0 ? Math.log(c.sigma) : NaN)));
  const zHeight = robustZ(heightStat);
  const zDrift = robustZ(
    baseline
      ? baseline.drift.map((d) => (baseline.mode === 'ratio' ? (d > 0 ? Math.log(d) : NaN) : d))
      : [],
  );

  const flags = cells.map((c, i) => {
    const f: QualityFlag[] = [];
    if (c.isSilent) f.push('silent');
    if (c.nAtMax >= OVERVIEW_PARAMS.clipMinSamples) f.push('clipped');
    if (c.nanCount > 0) f.push('gap');
    if (Math.abs(zNoise[i]) > z) f.push('outlier-noise');
    if (zHeight[i] > z) f.push('outlier-height');
    // A drift outlier must also be a visible change: at least one noise σ.
    const deltaSigma = c.sigma > 0 ? Math.abs(c.baselineEnd - c.baselineStart) / c.sigma : 0;
    if (Math.abs(zDrift[i] ?? 0) > z && deltaSigma >= 1) f.push('outlier-drift');
    return f;
  });

  return {
    kind: 'dataset-overview',
    nCells: cells.length,
    fs,
    durationS,
    cells,
    flags,
    snrRank: quantileRanks(cells.map((c) => c.snr)),
    medianSnr: medianOf(cells.map((c) => c.snr)),
    pooledHeights,
    heightDistance,
    baseline,
  };
}

// ── queries used by the UI ──────────────────────────────────────

/** True when the SNR sits in the band where pure noise lands. */
export function isNearNoiseFloor(snr: number): boolean {
  return Number.isFinite(snr) && snr <= OVERVIEW_PARAMS.noiseFloorBandHi;
}

/** Cells carrying `flag`, ascending. */
export function cellsWithFlag(overview: DatasetOverview, flag: QualityFlag): number[] {
  const out: number[] = [];
  overview.flags.forEach((f, i) => {
    if (f.includes(flag)) out.push(i);
  });
  return out;
}

/** Count of cells per flag, in FLAG_ORDER, plus the number of cells with any flag. */
export function flagCounts(overview: DatasetOverview): {
  byFlag: { flag: QualityFlag; count: number }[];
  anyFlag: number;
} {
  const byFlag = FLAG_ORDER.map((flag) => ({ flag, count: cellsWithFlag(overview, flag).length }));
  const anyFlag = overview.flags.filter((f) => f.length > 0).length;
  return { byFlag, anyFlag };
}

export type CellSortKey = 'index' | 'snr' | 'eventRate' | 'flags';

/**
 * Display order of cells (cell index per row). `snr` and `eventRate` sort
 * high to low; `flags` puts flagged cells first (most flags first), then by
 * SNR low to high so the weakest cells lead. Ties keep index order.
 */
export function sortCells(overview: DatasetOverview, key: CellSortKey): number[] {
  const idx = overview.cells.map((_, i) => i);
  const val = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  const c = overview.cells;
  switch (key) {
    case 'snr':
      return idx.sort((a, b) => val(c[b].snr) - val(c[a].snr) || a - b);
    case 'eventRate':
      return idx.sort((a, b) => val(c[b].eventRateHz) - val(c[a].eventRateHz) || a - b);
    case 'flags':
      return idx.sort(
        (a, b) =>
          overview.flags[b].length - overview.flags[a].length ||
          val(c[a].snr) - val(c[b].snr) ||
          a - b,
      );
    default:
      return idx;
  }
}

/** Inverse permutation: display row of each cell. */
export function rowOfCell(order: readonly number[]): Int32Array {
  const rows = new Int32Array(order.length);
  order.forEach((cell, row) => {
    rows[cell] = row;
  });
  return rows;
}

// ── PVE ceiling (solver results, not the overview) ──────────────

/**
 * Processed-space PVE ceiling of one solve: 1 − σ²_proc / Var(working trace).
 * `noiseVarProcessed` is the solver's per-sample noise variance of the
 * processed trace (InDeCa `noise_var_processed`); `working` is the trace the
 * solver fitted (`filteredTrace`). Null when either is unavailable.
 */
export function processedCeiling(
  working: ArrayLike<number> | undefined | null,
  noiseVarProcessed: number | undefined | null,
): number | null {
  if (!working || working.length < 2 || !(noiseVarProcessed! > 0)) return null;
  let mean = 0;
  for (let i = 0; i < working.length; i++) mean += working[i];
  mean /= working.length;
  let ss = 0;
  for (let i = 0; i < working.length; i++) ss += (working[i] - mean) ** 2;
  const v = ss / working.length;
  if (!(v > 0)) return null;
  return 1 - noiseVarProcessed! / v;
}

/** PVE_ceiling(SNR) = c·SNR² / (c·SNR² + 1). */
export function ceilingAt(c: number, snr: number): number {
  const k = c * snr * snr;
  return k / (k + 1);
}

export interface CeilingFit {
  c: number;
  /** Standard error of log c. */
  logCSe: number;
  n: number;
}

/** Fewest cells with a usable ceiling before the curve is drawn. */
export const MIN_CEILING_CELLS = 10;

/**
 * Fit the dataset-level ceiling constant c across cells by least squares on
 * logit(ceiling_i) = log c + log SNR_i² (slope fixed at 1, so log c is the
 * mean residual). The inputs are each cell's PROCESSED-space ceiling, never
 * its observed PVE, so the curve cannot be pulled toward the solver output.
 */
export function fitCeilingC(
  points: readonly { snr: number; ceiling: number }[],
  minCells = MIN_CEILING_CELLS,
): CeilingFit | null {
  const r: number[] = [];
  for (const { snr, ceiling } of points) {
    if (!(snr > 0) || !(ceiling > 0 && ceiling < 1)) continue;
    r.push(Math.log(ceiling / (1 - ceiling)) - 2 * Math.log(snr));
  }
  if (r.length < Math.max(2, minCells)) return null;
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1));
  return { c: Math.exp(mean), logCSe: sd / Math.sqrt(r.length), n: r.length };
}
