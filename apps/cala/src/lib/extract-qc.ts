/**
 * Trace QC of the extracted traces, per session.
 *
 * The live QC (`QcMonitor`, Discover) reads each cell's last
 * `window_frames` (60 s) of Discover's traces. Refine and Extract run no
 * monitor, so before this module the app kept showing, and exported, the
 * QC of the last minute of Discover: for a cell that happened to be quiet
 * then a low SNR, and in a Joint run the same numbers (the end of the last
 * session) for every session.
 *
 * After Extract this recomputes the trace statistics (peak SNR, events, the
 * low-SNR flag) from the extracted traces, per session span, with the
 * monitor's own function (`QcMonitor.spanStats`, Rust `QcConfig::trace_stats`)
 * at the recording's frame rate:
 *   - scope `'session'` (default, PI decision 13 Nov 2026): the whole span,
 *     the span CaLab's shipped SNR convention reads (crates/solver/src/snr.rs).
 *     On minisim it ranks GT-matched cells and GT trace quality better
 *     (results note tools/cala-eval/results/2026-11-13-qc-snr.md);
 *   - scope `'window'`: the last 60 s of the span, the monitor's definition.
 * The other metrics (demixing, neighbours, motion) stay those of Discover;
 * the duplicate flag is kept, the pass rule is recomputed from the new
 * low-SNR flag.
 */
import type { TraceFile } from './trace-file.ts';
import {
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  FLAG_UNMEASURED,
  type CellQcRow,
  type GlobalQcRow,
  type QcSnapshot,
} from './qc.ts';

export type QcScope = 'window' | 'session';

/**
 * Scope of the after-Extract QC: the whole session (PI decision 13 Nov
 * 2026). `'window'` would keep the monitor's last-60-s definition.
 */
export const QC_SCOPE_DEFAULT: QcScope = 'session';

/** Trace statistics of one span (`QcMonitor.spanStats`). */
export interface SpanStats {
  peakSnr: number;
  events: number;
  eventRate: number;
  zeroFrac: number;
  lowSnr: boolean;
}

/** The statistics function and the monitor's window at a frame rate. */
export interface SpanStatsBackend {
  stats(trace: Float32Array, fps: number): SpanStats;
  windowFrames(fps: number): number;
}

/** Fewest frames a span needs to be measured (the monitor's `min_frames`, 5 s). */
const MIN_SPAN_S = 5;

/** Largest block of traces held while computing, floats (64 MB). */
const GROUP_FLOATS = 16 * 1048576;

/**
 * Frames `[start, end)` the statistics read for a session span: the whole
 * span, or its last `windowFrames`.
 */
export function statsSpan(
  range: { start: number; end: number },
  scope: QcScope,
  windowFrames: number,
): { start: number; end: number } {
  if (scope === 'session') return range;
  return { start: Math.max(range.start, range.end - windowFrames), end: range.end };
}

/**
 * Per cell (column of `traces`) the statistics of frames `span`; cells are
 * read in groups so at most `GROUP_FLOATS` trace samples are held at once.
 */
export async function spanStatsOf(
  traces: TraceFile,
  span: { start: number; end: number },
  fps: number,
  backend: SpanStatsBackend,
): Promise<SpanStats[]> {
  const n = traces.cells;
  const len = span.end - span.start;
  const out: SpanStats[] = [];
  if (len <= 0 || n === 0) return out;
  const group = Math.max(1, Math.floor(GROUP_FLOATS / len));
  const step = Math.max(1, Math.floor(GROUP_FLOATS / Math.max(n, 1)));
  for (let c0 = 0; c0 < n; c0 += group) {
    const c1 = Math.min(n, c0 + group);
    const cols = Array.from({ length: c1 - c0 }, () => new Float32Array(len));
    for (let f = span.start; f < span.end; f += step) {
      const to = Math.min(span.end, f + step);
      const block = await traces.readFrames(f, to);
      for (let k = 0; k < to - f; k++) {
        const row = k * n;
        for (let c = c0; c < c1; c++) cols[c - c0][f - span.start + k] = block[row + c];
      }
    }
    for (const col of cols) out.push(backend.stats(col, fps));
  }
  return out;
}

/**
 * `base` (Discover's last QC snapshot, or null) with the trace statistics of
 * the extracted cells `ids` replaced by `stats` (same order). Rows of cells
 * Extract did not solve (removed by Refine) are dropped; cells without a
 * Discover row get one with only the trace statistics.
 */
export function withSpanStats(
  base: QcSnapshot | null,
  ids: Uint32Array,
  stats: readonly SpanStats[],
  frames: number,
  minFrames: number,
): QcSnapshot {
  const rows: CellQcRow[] = [];
  const byId = new Map<number, CellQcRow>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const old = base?.byId.get(id);
    const s = stats[i];
    const measured = frames >= minFrames && s !== undefined;
    let flags = (old?.flags ?? 0) & ~(FLAG_LOW_SNR | FLAG_UNMEASURED);
    if (!measured) flags |= FLAG_UNMEASURED;
    else if (s.lowSnr) flags |= FLAG_LOW_SNR;
    const row: CellQcRow = {
      ...(old ?? emptyRow(id)),
      slot: i,
      frames,
      peakSnr: measured ? s.peakSnr : NaN,
      eventRate: measured ? s.eventRate : NaN,
      zeroFrac: measured ? s.zeroFrac : NaN,
      flags,
      pass: measured && (flags & (FLAG_LOW_SNR | FLAG_LIKELY_DUPLICATE)) === 0,
    };
    rows.push(row);
    byId.set(id, row);
  }
  const passing = rows.filter((r) => r.pass).length;
  const measuredCount = rows.filter((r) => (r.flags & FLAG_UNMEASURED) === 0).length;
  const snrs = rows.map((r) => r.peakSnr).filter(Number.isFinite);
  const neighbours = new Map(rows.map((r) => [r.id, base?.neighbours.get(r.id) ?? []] as const));
  return {
    frame: base?.frame ?? 0,
    version: base?.version ?? 0,
    rows,
    byId,
    neighbours,
    global: base
      ? {
          ...base.global,
          cells: rows.length,
          cellsMeasured: measuredCount,
          passFrac: rows.length ? passing / rows.length : NaN,
          snrMedian: median(snrs),
        }
      : emptyGlobal(rows.length, measuredCount, passing, median(snrs)),
    residual: base?.residual ?? {
      blocksWide: 0,
      blocksHigh: 0,
      blockPx: 1,
      values: new Float32Array(0),
    },
    buildMs: 0,
  };
}

/**
 * The QC of the extracted traces over frames `range` (one session of a Joint
 * run, or the whole recording), at frame rate `fps`.
 */
export async function extractQc(
  traces: TraceFile,
  ids: Uint32Array,
  range: { start: number; end: number },
  fps: number,
  scope: QcScope,
  base: QcSnapshot | null,
  backend: SpanStatsBackend,
): Promise<QcSnapshot> {
  const span = statsSpan(range, scope, backend.windowFrames(fps));
  const stats = await spanStatsOf(traces, span, fps, backend);
  const len = span.end - span.start;
  return withSpanStats(base, ids, stats, len, Math.round(MIN_SPAN_S * fps));
}

function median(v: number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function emptyRow(id: number): CellQcRow {
  return {
    id,
    slot: 0,
    ageFrames: NaN,
    frames: 0,
    peakSnr: NaN,
    eventRate: NaN,
    projR: NaN,
    vif: NaN,
    maxOverlap: NaN,
    maxNeighbourR: NaN,
    maxNeighbourId: -1,
    fpError: NaN,
    motionR2: NaN,
    nNeighbours: 0,
    fpLastR: NaN,
    slowFrac: NaN,
    zeroFrac: NaN,
    diffSkew: NaN,
    fpRadiusPx: NaN,
    flags: 0,
    pass: false,
  };
}

function emptyGlobal(
  cells: number,
  cellsMeasured: number,
  passing: number,
  snrMedian: number,
): GlobalQcRow {
  return {
    frames: NaN,
    cells,
    cellsMeasured,
    explained: NaN,
    residualExcess: NaN,
    addsPerMin: NaN,
    removesPerMin: NaN,
    footprintChangesPerMin: NaN,
    snrMedian,
    passFrac: cells ? passing / cells : NaN,
    pairFrac: NaN,
    stableCells: NaN,
    fpStability: NaN,
    traceSigmaChange: NaN,
    stableFrac: NaN,
  };
}
