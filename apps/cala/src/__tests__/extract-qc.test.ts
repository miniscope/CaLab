import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm, QcMonitor } from '../lib/cala-wasm.ts';
import { extractQc, spanStatsOf, statsSpan, withSpanStats } from '../lib/extract-qc.ts';
import { spanStatsWasm } from '../lib/extract-qc-wasm.ts';
import {
  FLAG_CORRELATED_PAIR,
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  type CellQcRow,
  type QcSnapshot,
} from '../lib/qc.ts';
import { memoryTraceFile } from '../lib/trace-file.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

/** Deterministic noise in [-0.5, 0.5). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Clipped calcium trace: a transient every `every` frames in `[from, to)`, noise elsewhere. */
function trace(n: number, every: number, from: number, to: number, seed: number): Float32Array {
  const r = lcg(seed);
  const x = new Float32Array(n);
  let v = 0;
  for (let t = 0; t < n; t++) {
    v *= Math.exp(-1 / 12);
    if (t >= from && t < to && t % every === 7) v += 12;
    x[t] = Math.max(0, v + 1.2 * r());
  }
  return x;
}

/** Frame-major matrix of `cols`. */
function matrix(cols: Float32Array[]): Float32Array {
  const n = cols[0].length;
  const m = new Float32Array(n * cols.length);
  for (let t = 0; t < n; t++)
    for (let c = 0; c < cols.length; c++) m[t * cols.length + c] = cols[c][t];
  return m;
}

function row(id: number, extra: Partial<CellQcRow> = {}): CellQcRow {
  return {
    id,
    slot: 0,
    ageFrames: 1000,
    frames: 1200,
    peakSnr: 1,
    eventRate: 0,
    projR: 0.9,
    vif: 1,
    maxOverlap: 0,
    maxNeighbourR: NaN,
    maxNeighbourId: -1,
    fpError: 0,
    motionR2: NaN,
    nNeighbours: 0,
    fpLastR: NaN,
    slowFrac: 0,
    zeroFrac: 0,
    diffSkew: 0,
    fpRadiusPx: 4,
    flags: FLAG_LOW_SNR,
    pass: false,
    ...extra,
  };
}

function snapshot(rows: CellQcRow[]): QcSnapshot {
  return {
    frame: 9,
    version: 3,
    rows,
    byId: new Map(rows.map((r) => [r.id, r])),
    neighbours: new Map(rows.map((r) => [r.id, []])),
    global: {
      frames: 0,
      cells: rows.length,
      cellsMeasured: rows.length,
      explained: 0.8,
      residualExcess: 0,
      addsPerMin: 0,
      removesPerMin: 0,
      footprintChangesPerMin: 0,
      snrMedian: 1,
      passFrac: 0,
      pairFrac: 0,
      stableCells: 0,
      fpStability: 0,
      traceSigmaChange: 0,
      stableFrac: 0,
    },
    residual: { blocksWide: 0, blocksHigh: 0, blockPx: 1, values: new Float32Array(0) },
    buildMs: 0,
  };
}

describe('extract QC', () => {
  it('windows are durations at the recording rate', () => {
    expect(QcMonitor.windowFrames(20)).toBe(1200);
    expect(QcMonitor.windowFrames(30)).toBe(1800);
    expect(statsSpan({ start: 100, end: 5000 }, 'window', 1800)).toEqual({
      start: 3200,
      end: 5000,
    });
    expect(statsSpan({ start: 100, end: 1000 }, 'window', 1800)).toEqual({ start: 100, end: 1000 });
    expect(statsSpan({ start: 100, end: 5000 }, 'session', 1800)).toEqual({
      start: 100,
      end: 5000,
    });
  });

  it('reads each cell column of the span', async () => {
    const a = trace(3000, 90, 0, 3000, 1);
    const b = trace(3000, 90, 0, 1000, 2);
    const file = await memoryTraceFile(matrix([a, b]), 3000, 2);
    const span = { start: 500, end: 2600 };
    const got = await spanStatsOf(file, span, 20, spanStatsWasm);
    expect(got[0].peakSnr).toBe(spanStatsWasm.stats(a.slice(500, 2600), 20).peakSnr);
    expect(got[1].peakSnr).toBe(spanStatsWasm.stats(b.slice(500, 2600), 20).peakSnr);
  });

  it('a cell quiet in the last minute fails on the window and passes on its session', async () => {
    // Fires for the first 2000 of 4000 frames (20 Hz): the last 60 s are noise.
    const x = trace(4000, 90, 0, 2000, 3);
    const file = await memoryTraceFile(matrix([x]), 4000, 1);
    const ids = new Uint32Array([5]);
    const range = { start: 0, end: 4000 };
    const base = snapshot([row(5)]);
    const win = await extractQc(file, ids, range, 20, 'window', base, spanStatsWasm);
    const all = await extractQc(file, ids, range, 20, 'session', base, spanStatsWasm);
    expect(win.byId.get(5)!.pass).toBe(false);
    expect(win.byId.get(5)!.frames).toBe(1200);
    expect(all.byId.get(5)!.pass).toBe(true);
    expect(all.byId.get(5)!.frames).toBe(4000);
    expect(all.byId.get(5)!.peakSnr).toBeGreaterThan(10);
  });

  it('each session span gets its own QC', async () => {
    // Joint run: session 0 = frames 0..3000 (cell active), session 1 = 3000..6000 (quiet).
    const x = trace(6000, 90, 0, 3000, 4);
    const file = await memoryTraceFile(matrix([x]), 6000, 1);
    const ids = new Uint32Array([1]);
    const s0 = await extractQc(
      file,
      ids,
      { start: 0, end: 3000 },
      20,
      'window',
      null,
      spanStatsWasm,
    );
    const s1 = await extractQc(
      file,
      ids,
      { start: 3000, end: 6000 },
      20,
      'window',
      null,
      spanStatsWasm,
    );
    expect(s0.byId.get(1)!.pass).toBe(true);
    expect(s1.byId.get(1)!.pass).toBe(false);
  });

  it('keeps the duplicate flag and the other metrics, drops cells Extract did not solve', () => {
    const base = snapshot([
      row(1, { flags: FLAG_CORRELATED_PAIR | FLAG_LIKELY_DUPLICATE, vif: 2 }),
      row(2, { vif: 3 }),
      row(9),
    ]);
    const hi = { peakSnr: 20, events: 4, eventRate: 2, zeroFrac: 0.5, lowSnr: false };
    const q = withSpanStats(base, new Uint32Array([1, 2]), [hi, hi], 1200, 100);
    expect(q.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(q.byId.get(1)!.pass).toBe(false);
    expect(q.byId.get(1)!.flags).toBe(FLAG_CORRELATED_PAIR | FLAG_LIKELY_DUPLICATE);
    expect(q.byId.get(1)!.vif).toBe(2);
    expect(q.byId.get(2)!.pass).toBe(true);
    expect(q.byId.get(2)!.peakSnr).toBe(20);
    expect(q.global.passFrac).toBe(0.5);
    expect(q.byId.has(9)).toBe(false);
  });
});
