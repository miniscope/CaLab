import { StreamHistory } from '@calab/compute';
import { RunEvents } from '../lib/run-events.ts';
import type { StageRun } from '../lib/run-stages.ts';
import { describe, expect, it } from 'vitest';
import { parseNpz, processNpyResult, traceCandidates } from '@calab/io';
import type { CellQcRow, QcSnapshot } from '../lib/qc.ts';
import { buildCaDeconExport, buildCalaExport, cadeconCells, fileStem } from '../lib/export.ts';
import type { Pass2Result } from '../lib/pass2-store.ts';
import { memoryTraceFile } from '../lib/trace-file.ts';
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

async function result(): Promise<Pass2Result> {
  // Frame-major (as the solver emits): value = 100 * cell + frame.
  const traces = new Float32Array(T * 3);
  for (let f = 0; f < T; f++) for (let c = 0; c < 3; c++) traces[f * 3 + c] = 100 * c + f;
  return {
    ids,
    traces: await memoryTraceFile(traces, T, 3),
    frames: T,
    cells: 3,
    version: 12,
    library: library(),
    seconds: 1.5,
  };
}

function qc(): QcSnapshot {
  const row = (id: number, pass: boolean, snr: number, flags = 0): CellQcRow =>
    ({ id, slot: 0, peakSnr: snr, pass, flags, maxNeighbourId: -1 }) as CellQcRow;
  const rows = [row(4, true, 9), row(9, false, 3, 1)];
  return { rows, byId: new Map(rows.map((r) => [r.id, r])) } as unknown as QcSnapshot;
}

async function input() {
  const rec = new RunRecord(2);
  for (let t = 0; t < T; t++) rec.push(t, [0.5 * t], [-t], [t % 2], [t], [0.01 * t]);
  return {
    label: 'my folder/2026',
    width: W,
    height: H,
    fps: 20,
    result: await result(),
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
  it('reads cells and frames back from the trace file', async () => {
    const { traces } = await result();
    expect([...(await traces.readCell(0))]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...(await traces.readCell(2))]).toEqual([200, 201, 202, 203, 204, 205, 206]);
    expect([...(await traces.readFrames(2, 4))]).toEqual([2, 102, 202, 3, 103, 203]);
  });

  it('writes a self-describing archive numpy can read', async () => {
    const z = parseNpz(await buildCalaExport(await input()));
    const a = z.arrays;
    // Fortran order on disk (frame-major, no transpose); numpy returns the (N, T) array.
    expect(a.traces.fortranOrder).toBe(true);
    expect(a.traces.shape).toEqual([3, T]);
    expect(a.traces.dtype).toBe('<f4');
    const traces = processNpyResult(a.traces);
    expect([...traces.data.slice(T, 2 * T)]).toEqual([100, 101, 102, 103, 104, 105, 106]);
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

  it('writes one session of a Joint run: frames sliced, session block in meta', async () => {
    const z = parseNpz(
      await buildCalaExport({
        ...(await input()),
        frameRange: { start: 3, end: 6 },
        session: { index: 1, start_frame: 3 },
      }),
    );
    const a = z.arrays;
    expect(a.traces.shape).toEqual([3, 3]);
    const traces = processNpyResult(a.traces);
    // Cell 1 (value 100 + frame) over frames 3, 4, 5.
    expect([...traces.data.slice(3, 6)]).toEqual([103, 104, 105]);
    expect(a.motion_shift_yx.shape).toEqual([3, 2]);
    expect(a.motion_shift_yx.data[0]).toBe(1.5);
    expect([...a.flicker_offset.data]).toEqual([3, 4, 5]);
    expect([...a.cell_ids.data]).toEqual([4, 9, 11]);
    const meta = JSON.parse(new TextDecoder().decode(a.meta_json.data as Uint8Array));
    expect(meta.frames).toBe(3);
    expect(meta.session).toEqual({ index: 1, start_frame: 3 });
  });

  it('refuses a frame range outside the result', async () => {
    await expect(
      buildCalaExport({ ...(await input()), frameRange: { start: 5, end: T + 1 } }),
    ).rejects.toThrow(RangeError);
  });

  it('writes the run history and event log when given', async () => {
    const h = new StreamHistory();
    h.define({
      key: 'shift_dy',
      label: 'Shift dy',
      unit: 'px',
      group: 'motion',
      kind: 'value',
      range: [-10, 10],
      rangeRule: 'ladder125',
      color: '#000',
      digits: 2,
    });
    for (let t = 0; t < 5; t += 0.5) h.push('shift_dy', t, t === 2 ? 15 : 1);
    const ev = new RunEvents();
    ev.push({ frame: 40, t: 2, kind: 'range', key: 'shift_dy', from: '±10', to: '±20' });
    const z = parseNpz(
      await buildCalaExport({
        ...(await input()),
        history: { bins: h.toExport(), eventsJson: ev.toJSON() },
      }),
    );
    const a = z.arrays;
    expect(a.history_L0.shape[0]).toBe(1);
    expect(a.history_L0.shape[2]).toBe(4);
    // Bin 2 (t = 2..3 s): max 15 kept.
    expect(a.history_L0.data[2 * 4 + 1]).toBe(15);
    const events = JSON.parse(new TextDecoder().decode(a.run_events_json.data as Uint8Array));
    expect(events[0]).toMatchObject({ kind: 'range', key: 'shift_dy' });
    const meta = JSON.parse(new TextDecoder().decode(a.meta_json.data as Uint8Array));
    expect(meta.format_version).toBe(3);
    expect(meta.history.series[0]).toMatchObject({ key: 'shift_dy', range_final: [-20, 20] });
  });

  it('lists the stages that ran, with counts and timestamps', async () => {
    const stages: StageRun[] = [
      {
        stage: 'discover',
        index: 1,
        startedAt: '2026-11-13T10:00:00.000Z',
        endedAt: '2026-11-13T10:01:00.000Z',
        outcome: 'done',
        frames: 600,
        cells: 12,
        libraryVersion: 30,
        refines: 40,
        refinesPerMin: 80,
        adds: 14,
        merges: 1,
        deletes: 1,
        splits: 0,
      },
      {
        stage: 'refine',
        index: 1,
        startedAt: '2026-11-13T10:01:10.000Z',
        endedAt: '2026-11-13T10:02:00.000Z',
        outcome: 'done',
        frames: 600,
        cells: 12,
        libraryVersion: 34,
        refines: 9,
        refinesPerMin: 18,
        footprintsRefined: 7,
        medianFootprintChange: 0.04,
      },
    ];
    const z = parseNpz(await buildCalaExport({ ...(await input()), stages }));
    const meta = JSON.parse(new TextDecoder().decode(z.arrays.meta_json.data as Uint8Array));
    expect(meta.stages.map((r: { stage: string }) => r.stage)).toEqual(['discover', 'refine']);
    expect(meta.stages[0]).toMatchObject({
      index: 1,
      started_at: '2026-11-13T10:00:00.000Z',
      outcome: 'done',
      adds: 14,
      refines: 40,
    });
    expect(meta.stages[1]).toMatchObject({ footprints_refined: 7, median_footprint_change: 0.04 });
    expect('adds' in meta.stages[1]).toBe(false);
    expect(meta.extract_seconds).toBeTypeOf('number');
    expect('pass2_seconds' in meta).toBe(false);
  });

  it('writes the same archive with ZIP64 records forced', async () => {
    const inp = await input();
    const plain = parseNpz(await buildCalaExport(inp)).arrays;
    const z64 = parseNpz(await buildCalaExport(inp, { forceZip64: true })).arrays;
    expect(Object.keys(z64).sort()).toEqual(Object.keys(plain).sort());
    for (const k of Object.keys(plain)) expect(z64[k].data).toEqual(plain[k].data);
  });

  it('streams a big CaDecon file in Fortran order with the same values as the classic one', async () => {
    const inp = await input();
    const classic = parseNpz(await buildCaDeconExport(inp, false)).arrays;
    const streamed = parseNpz(
      await buildCaDeconExport(inp, false, { cadeconMemoryBytes: 0, forceZip64: true }),
    ).arrays;
    expect(classic.traces.fortranOrder).toBe(false);
    expect(streamed.traces.fortranOrder).toBe(true);
    expect(processNpyResult(streamed.traces).data).toEqual(classic.traces.data);
    // A column subset streams too.
    const sub = parseNpz(await buildCaDeconExport(inp, true, { cadeconMemoryBytes: 0 })).arrays;
    expect(sub.traces.shape).toEqual([1, T]);
    expect([...processNpyResult(sub.traces).data]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('writes the CaDecon file with one trace matrix, QC-passing cells by default', async () => {
    const inp = await input();
    expect(cadeconCells(inp, true)).toEqual([0]);
    expect(cadeconCells(inp, false)).toEqual([0, 1, 2]);
    const z = parseNpz(await buildCaDeconExport(inp, true));
    expect(z.arrays.traces.shape).toEqual([1, T]);
    // A lone cells x timepoints array: CaDecon's importer (soleTraceCandidate) takes it without asking.
    expect(traceCandidates(z)).toEqual(['traces']);
    const all = parseNpz(await buildCaDeconExport(inp, false));
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
