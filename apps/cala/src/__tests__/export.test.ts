import { describe, expect, it } from 'vitest';
import { parseNpz, traceCandidates } from '@calab/io';
import type { CellQcRow, QcSnapshot } from '../lib/qc.ts';
import { buildCaDeconExport, buildCalaExport, cadeconCells, fileStem } from '../lib/export.ts';
import { transposeTraces, type Pass2Result } from '../lib/pass2-store.ts';
import { RunRecord } from '../lib/run-record.ts';
import type { LibraryView } from '../workers/slow-types.ts';

const W = 10;
const H = 8;
const T = 7;
const ids = Uint32Array.of(4, 9, 11);

/** Cell i is a 2 x 2 block with value i + 1 at (2i, 3). */
function library(): LibraryView {
  const starts = Uint32Array.of(0, 4, 8, 12);
  const pixels: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < 3; i++)
    for (const [dy, dx] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      pixels.push((2 * i + dy) * W + 3 + dx);
      values.push(i + 1);
    }
  return {
    version: 12,
    frame: 100,
    width: W,
    height: H,
    ids,
    centers: Float32Array.of(0.5, 3.5, 2.5, 3.5, 4.5, 3.5),
    radii: Float32Array.of(1, 1.5, 2),
    starts,
    pixels: Uint32Array.from(pixels),
    values: Float32Array.from(values),
  };
}

function result(): Pass2Result {
  // Frame-major (as the solver emits): value = 100 * cell + frame.
  const traces = new Float32Array(T * 3);
  for (let f = 0; f < T; f++) for (let c = 0; c < 3; c++) traces[f * 3 + c] = 100 * c + f;
  return { ids, traces, frames: T, cells: 3, version: 12, library: library(), seconds: 1.5 };
}

function qc(): QcSnapshot {
  const row = (id: number, pass: boolean, snr: number, flags = 0): CellQcRow =>
    ({ id, slot: 0, peakSnr: snr, pass, flags, maxNeighbourId: -1 }) as CellQcRow;
  const rows = [row(4, true, 9), row(9, false, 3, 1)];
  return { rows, byId: new Map(rows.map((r) => [r.id, r])) } as unknown as QcSnapshot;
}

function input() {
  const rec = new RunRecord(2);
  for (let t = 0; t < T; t++) rec.push(t, [0.5 * t], [-t], [t % 2], [t], [0.01 * t]);
  return {
    label: 'my folder/2026',
    width: W,
    height: H,
    fps: 20,
    result: result(),
    run: rec.snapshot(),
    qc: qc(),
    firstSeen: (id: number) => (id === 11 ? undefined : id * 10),
    version: 'test',
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}

describe('run record', () => {
  it('stores frames in order, grows, and flags a gap', () => {
    const r = new RunRecord(2);
    r.push(0, [1, 2, 3], [4, 5, 6], [0, 1, 2], [7, 8, 9], [0.1, 0.2, 0.3]);
    r.push(3, [10], [11], [3], [12], [0.4]);
    expect(r.frames).toBe(4);
    expect(r.complete).toBe(true);
    expect(r.bytes).toBe(4 * 17);
    const s = r.span(2, 2);
    expect([...s.dy]).toEqual([3, 10]);
    expect([...s.flags]).toEqual([2, 3]);
    expect(r.snapshot().dx).toEqual(Float32Array.of(4, 5, 6, 11));
    r.push(9, [1], [1], [0], [0], [0]);
    expect(r.complete).toBe(false);
    expect(r.frames).toBe(4);
  });
});

describe('export', () => {
  it('transposes frame-major traces to one row per cell', () => {
    const t = transposeTraces(result().traces, T, 3);
    expect([...t.subarray(0, T)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...t.subarray(2 * T, 3 * T)]).toEqual([200, 201, 202, 203, 204, 205, 206]);
  });

  it('writes a self-describing archive numpy can read', () => {
    const z = parseNpz(buildCalaExport(input()));
    const a = z.arrays;
    expect(a.traces.shape).toEqual([3, T]);
    expect(a.traces.dtype).toBe('<f4');
    expect(a.traces.data[T + 3]).toBe(103);
    expect(a.cell_ids.shape).toEqual([3]);
    expect([...a.cell_ids.data]).toEqual([4, 9, 11]);
    expect(a.centroids_yx.shape).toEqual([3, 2]);
    expect(a.footprint_starts.shape).toEqual([4]);
    expect(a.footprint_pixels.shape).toEqual([12]);
    expect(a.footprint_values.shape).toEqual([12]);
    expect([...a.fov_shape.data]).toEqual([H, W]);
    expect(a.motion_shift_yx.shape).toEqual([T, 2]);
    expect(a.motion_shift_yx.data[2 * 4]).toBe(2);
    expect(a.motion_shift_yx.data[2 * 4 + 1]).toBe(-4);
    expect(a.motion_flags.shape).toEqual([T]);
    expect(a.flicker_offset.shape).toEqual([T]);
    expect(a.flicker_gain.shape).toEqual([T]);
    expect([...a.first_seen_frame.data]).toEqual([40, 90, -1]);
    expect([...a.qc_pass.data]).toEqual([1, 0, -1]);
    expect(a.qc_peak_snr.data[0]).toBe(9);
    expect(Number.isNaN(a.qc_peak_snr.data[2])).toBe(true);
    expect(a.sampling_rate_hz.data[0]).toBe(20);
    const meta = JSON.parse(new TextDecoder().decode(a.meta_json.data as Uint8Array));
    expect(meta.format).toBe('cala-export');
    expect(meta.cell_table).toHaveLength(3);
    expect(meta.cell_table[1]).toMatchObject({
      id: 9,
      centroid_y: 2.5,
      first_seen_frame: 90,
      qc_pass: false,
      peak_snr: 3,
    });
    expect(meta.cell_table[2]).toMatchObject({ first_seen_frame: null, qc_pass: null });
    // The sparse footprint of cell 1 densifies to its block.
    const px = a.footprint_pixels.data;
    const st = a.footprint_starts.data;
    expect([...px.slice(st[1], st[2])]).toEqual([2 * W + 3, 2 * W + 4, 3 * W + 3, 3 * W + 4]);
  });

  it('writes the CaDecon file with one trace matrix, QC-passing cells by default', () => {
    const inp = input();
    expect(cadeconCells(inp, true)).toEqual([0]);
    expect(cadeconCells(inp, false)).toEqual([0, 1, 2]);
    const z = parseNpz(buildCaDeconExport(inp, true));
    expect(z.arrays.traces.shape).toEqual([1, T]);
    // A lone cells x timepoints array: CaDecon's importer (soleTraceCandidate) takes it without asking.
    expect(traceCandidates(z)).toEqual(['traces']);
    const all = parseNpz(buildCaDeconExport(inp, false));
    expect(all.arrays.traces.shape).toEqual([3, T]);
    expect(traceCandidates(all)).toEqual(['traces']);
    // No QC judged any cell: keep them all rather than export nothing.
    expect(cadeconCells({ ...inp, qc: null }, true)).toEqual([0, 1, 2]);
  });

  it('makes a safe file stem', () => {
    expect(fileStem('my folder/2026')).toBe('my_folder_2026');
    expect(fileStem('///')).toBe('recording');
  });
});
