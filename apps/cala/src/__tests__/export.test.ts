import { StreamHistory } from '@calab/compute';
import { RunEvents } from '../lib/run-events.ts';
import type { StageRun } from '../lib/run-stages.ts';
import { describe, expect, it } from 'vitest';
import { parseNpz, processNpyResult, traceCandidates } from '@calab/io';
import type { CellQcRow, QcSnapshot } from '../lib/qc.ts';
import {
  buildCaDeconExport,
  buildCalaExport,
  cadeconCells,
  EXPORT_FORMAT_VERSION,
  exportFormatVersion,
  FACTORS_EXPORT_NOTE,
  factorTailNote,
  fileStem,
  type ExportInput,
} from '../lib/export.ts';
import type { Pass2Result } from '../lib/pass2-store.ts';
import { memoryTraceFile } from '../lib/trace-file.ts';
import { fileFactorNotes } from '../lib/factor-run.ts';
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

/** Signed traces: value = 100 * cell + frame - 1000 (negative, unlike the clipped ones). */
const SIGNED_OFFSET = -1000;

async function result(): Promise<Pass2Result> {
  // Frame-major (as the solver emits): value = 100 * cell + frame.
  const traces = new Float32Array(T * 3);
  for (let f = 0; f < T; f++) for (let c = 0; c < 3; c++) traces[f * 3 + c] = 100 * c + f;
  return {
    ids,
    traces: await memoryTraceFile(traces, T, 3),
    signed: await memoryTraceFile(
      traces.map((v) => v + SIGNED_OFFSET),
      T,
      3,
    ),
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
  it('embeds the run record in meta_json', async () => {
    const runRecord = {
      format: 'cala-run-record',
      record_version: 1,
      settings: { lookback: true },
    };
    const z = parseNpz(await buildCalaExport({ ...(await input()), runRecord }));
    const meta = JSON.parse(new TextDecoder().decode(z.arrays.meta_json.data as Uint8Array));
    expect(meta.run_record).toEqual(runRecord);
    // The CaDecon file carries it as a vector and keeps the traces matrix its one candidate.
    const cd = parseNpz(await buildCaDeconExport({ ...(await input()), runRecord }, true));
    expect(
      JSON.parse(new TextDecoder().decode(cd.arrays.run_record_json.data as Uint8Array)),
    ).toEqual(runRecord);
    expect(traceCandidates(cd)).toEqual(['traces']);
    const bare = parseNpz(await buildCalaExport(await input()));
    const bareMeta = JSON.parse(new TextDecoder().decode(bare.arrays.meta_json.data as Uint8Array));
    expect(bareMeta.run_record).toBeUndefined();
  });

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
    // The signed traces: same layout, their own values.
    expect(a.traces_signed.fortranOrder).toBe(true);
    expect(a.traces_signed.shape).toEqual([3, T]);
    expect(a.traces_signed.dtype).toBe('<f4');
    expect([...processNpyResult(a.traces_signed).data.slice(T, 2 * T)]).toEqual(
      [100, 101, 102, 103, 104, 105, 106].map((v) => v + SIGNED_OFFSET),
    );
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
    expect(meta.format_version).toBe(EXPORT_FORMAT_VERSION);
    expect(meta.traces_signed).toBeTypeOf('string');
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
    expect(a.traces_signed.shape).toEqual([3, 3]);
    expect([...processNpyResult(a.traces_signed).data.slice(3, 6)]).toEqual(
      [103, 104, 105].map((v) => v + SIGNED_OFFSET),
    );
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
    expect(meta.format_version).toBe(EXPORT_FORMAT_VERSION);
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
    expect('adds' in meta.stages[1]).toBe(false);
    expect(meta.extract_seconds).toBeTypeOf('number');
    expect('pass2_seconds' in meta).toBe(false);
  });

  it("a ?factors stream keeps the live traces beside Extract's and names its sources (format 7)", async () => {
    const inp = await input();
    const live = new Float32Array(T * 3);
    for (let f = 0; f < T; f++) for (let c = 0; c < 3; c++) live[f * 3 + c] = 7 + 100 * c + f;
    const stage = (stage: 'discover' | 'extract'): StageRun => ({
      stage,
      index: 1,
      startedAt: '2026-11-23T10:00:00.000Z',
      endedAt: '2026-11-23T10:01:00.000Z',
      outcome: 'done',
      frames: T,
      cells: 3,
      libraryVersion: 12,
    });
    const stages: StageRun[] = [
      { ...stage('discover'), settleSource: 'factors' },
      {
        ...stage('extract'),
        source: 'factors',
        factors: {
          folder: 'run-a',
          tiling: 'offset',
          windows: [
            { index: 0, start: 0, frames: 4 },
            { index: 1, start: 4, frames: 3 },
          ],
          frames: T,
          meanRank: 4.5,
        },
      },
    ];
    const withFactors = {
      ...inp,
      liveTraces: await memoryTraceFile(live, T, 3),
      notes: [FACTORS_EXPORT_NOTE, factorTailNote(T - 1, T)],
      stages,
    };
    expect(exportFormatVersion(withFactors)).toBe(7);
    const a = parseNpz(await buildCalaExport(withFactors)).arrays;
    expect(a.traces_live.shape).toEqual([3, T]);
    expect([...processNpyResult(a.traces_live).data.slice(T, 2 * T)]).toEqual([
      107, 108, 109, 110, 111, 112, 113,
    ]);
    // Extract's traces are still the file's `traces`.
    expect([...processNpyResult(a.traces).data.slice(T, 2 * T)]).toEqual([
      100, 101, 102, 103, 104, 105, 106,
    ]);
    const meta = JSON.parse(new TextDecoder().decode(a.meta_json.data as Uint8Array));
    expect(meta.format_version).toBe(7);
    expect(meta.notes).toEqual([FACTORS_EXPORT_NOTE, factorTailNote(T - 1, T)]);
    expect(meta.traces_live).toBeTypeOf('string');
    expect(meta.stages[0].settle_source).toBe('factors');
    expect(meta.stages[1]).toMatchObject({
      source: 'factors',
      factor_tiling: 'offset',
      factor_windows: 2,
      factor_mean_rank: 4.5,
    });
  });

  it('an export without the factor fields stays format 6 with the same entries', async () => {
    const inp = await input();
    expect(exportFormatVersion({})).toBe(6);
    expect(exportFormatVersion({ notes: [] })).toBe(6);
    const z = parseNpz(await buildCalaExport(inp));
    const meta = JSON.parse(new TextDecoder().decode(z.arrays.meta_json.data as Uint8Array));
    expect(meta.format_version).toBe(6);
    expect('notes' in meta).toBe(false);
    expect('traces_live' in z.arrays).toBe(false);
    expect(Object.keys(z.arrays).sort()).toEqual(
      [
        'cell_ids',
        'centroids_yx',
        'first_seen_frame',
        'flicker_gain',
        'flicker_offset',
        'footprint_pixels',
        'footprint_starts',
        'footprint_values',
        'fov_shape',
        'meta_json',
        'motion_flags',
        'motion_shift_yx',
        'qc_flags',
        'qc_pass',
        'qc_peak_snr',
        'radii_px',
        'sampling_rate_hz',
        'traces',
        'traces_signed',
      ].sort(),
    );
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
    // CaDecon gets the signed traces.
    expect([...processNpyResult(sub.traces).data]).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((v) => v + SIGNED_OFFSET),
    );
  });

  it('without signed traces (a live run): no traces_signed, CaDecon gets the clipped traces', async () => {
    const inp = await input();
    const live = { ...inp, result: { ...inp.result, signed: null } };
    const a = parseNpz(await buildCalaExport(live)).arrays;
    expect('traces_signed' in a).toBe(false);
    expect(a.traces.shape).toEqual([3, T]);
    const meta = JSON.parse(new TextDecoder().decode(a.meta_json.data as Uint8Array));
    expect('traces_signed' in meta).toBe(false);
    const c = parseNpz(await buildCaDeconExport(live, true)).arrays;
    expect([...c.traces.data]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('reports progress over both trace matrices, ending at the total', async () => {
    const seen: [number, number][] = [];
    await buildCalaExport(await input(), { onProgress: (d, t) => seen.push([d, t]) });
    const total = 2 * 3 * T * 4;
    expect(seen.every(([, t]) => t === total)).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
    expect(seen[seen.length - 1][0]).toBe(total);
  });

  it('writes the CaDecon file with one trace matrix, QC-passing cells by default', async () => {
    const inp = await input();
    expect(cadeconCells(inp, true)).toEqual([0]);
    expect(cadeconCells(inp, false)).toEqual([0, 1, 2]);
    const z = parseNpz(await buildCaDeconExport(inp, true));
    expect(z.arrays.traces.shape).toEqual([1, T]);
    // A lone cells x timepoints array: CaDecon's importer (soleTraceCandidate) takes it without asking.
    expect(traceCandidates(z)).toEqual(['traces']);
    expect([...z.arrays.traces.data]).toEqual([0, 1, 2, 3, 4, 5, 6].map((v) => v + SIGNED_OFFSET));
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

describe('export of a ?factors=file recording', () => {
  const stage = (stage: 'discover' | 'extract'): StageRun => ({
    stage,
    index: 1,
    startedAt: '2026-11-23T10:00:00.000Z',
    endedAt: '2026-11-23T10:01:00.000Z',
    outcome: 'done',
    frames: T,
    cells: 3,
    libraryVersion: 12,
  });
  const metaOf = async (inp: ExportInput) =>
    JSON.parse(
      new TextDecoder().decode(
        parseNpz(await buildCalaExport(inp)).arrays.meta_json.data as Uint8Array,
      ),
    );

  it('records each stage source and reason, notes what each read, and is format 7', async () => {
    const stages: StageRun[] = [
      {
        ...stage('discover'),
        settleSource: 'file',
        settleSourceReason: 'the compressor was 4,210 frames behind when Discover ended',
      },
      {
        ...stage('extract'),
        source: 'factors',
        factors: {
          folder: 'run-a',
          tiling: 'offset',
          windows: [{ index: 0, start: 0, frames: T }],
          frames: T,
          meanRank: 4,
        },
      },
    ];
    const meta = await metaOf({ ...(await input()), stages, notes: fileFactorNotes(stages) });
    expect(meta.format_version).toBe(7);
    expect(meta.stages[0]).toMatchObject({
      settle_source: 'file',
      settle_source_reason: expect.stringContaining('4,210'),
    });
    expect(meta.stages[1]).toMatchObject({ source: 'factors', factor_tiling: 'offset' });
    expect(meta.notes[0]).toContain('the Final settle re-read the file');
    expect(meta.notes[0]).toContain('Extract read the factors');
    expect(meta.notes[1]).toContain('less per-frame noise');
  });

  it("writes a factor run's compress pool on Discover's record", async () => {
    const stages: StageRun[] = [
      {
        ...stage('discover'),
        settleSource: 'file',
        settleSourceReason: 'the compressor was 7,440 frames behind when Discover ended',
        compress: {
          workers: 1,
          workersAfter: 3,
          behindFrames: 7440,
          backlogPeakBytes: 5_356_800_000,
          fpsAfter: 118.5,
        },
      },
      stage('extract'),
    ];
    const meta = await metaOf({ ...(await input()), stages, notes: fileFactorNotes(stages) });
    expect(meta.format_version).toBe(7);
    expect(meta.stages[0]).toMatchObject({
      compress_workers: 1,
      compress_workers_after: 3,
      compress_behind_frames: 7440,
      compress_backlog_peak_bytes: 5_356_800_000,
      compress_fps_after: 118.5,
    });
    expect(meta.stages[1]).not.toHaveProperty('compress_workers');
    expect(meta.stages[0]).not.toHaveProperty('compress_window');
    expect(meta.stages[0]).not.toHaveProperty('compress_ring');
  });

  it("writes a GPU factor run's window and backend on Discover's record", async () => {
    const stages: StageRun[] = [
      {
        ...stage('discover'),
        settleSource: 'factors',
        compress: {
          workers: 1,
          workersAfter: 1,
          behindFrames: 412,
          backlogPeakBytes: 0,
          fpsAfter: 240,
          window: 600,
          ring: 1200,
          backend: 'gpu',
        },
      },
      stage('extract'),
    ];
    const meta = await metaOf({ ...(await input()), stages, notes: fileFactorNotes(stages) });
    expect(meta.stages[0]).toMatchObject({
      compress_window: 600,
      compress_ring: 1200,
      compress_backend: 'gpu',
    });
  });

  it("writes the factor extractor's windows and workers on Extract's record", async () => {
    const stages: StageRun[] = [
      { ...stage('discover'), settleSource: 'factors' },
      {
        ...stage('extract'),
        source: 'factors',
        factors: {
          folder: 'run-a',
          tiling: 'offset',
          windows: [{ index: 0, start: 0, frames: T }],
          frames: T,
          meanRank: 4,
        },
        extractor: { projected: 118, rebuilt: 2, workers: 6 },
      },
    ];
    const meta = await metaOf({ ...(await input()), stages, notes: fileFactorNotes(stages) });
    expect(meta.format_version).toBe(7);
    expect(meta.stages[1]).toMatchObject({
      extract_engine: 'factors',
      factor_windows_projected: 118,
      factor_windows_rebuilt: 2,
      extract_workers: 6,
    });
    expect(meta.stages[0]).not.toHaveProperty('extract_engine');
  });

  it('Extract on the file keeps its reason', async () => {
    const stages: StageRun[] = [
      stage('discover'),
      {
        ...stage('extract'),
        source: 'file',
        sourceReason: '1,800 frames are still being compressed.',
      },
    ];
    const meta = await metaOf({ ...(await input()), stages, notes: fileFactorNotes(stages) });
    expect(meta.stages[1].source_reason).toContain('1,800');
    expect(meta.notes[0]).toContain('Extract replayed the file');
    expect(meta.notes).toHaveLength(1);
  });

  it('an export without stage sources stays 6 and has no notes', async () => {
    const stages = [stage('discover'), stage('extract')];
    expect(fileFactorNotes(stages)).toEqual([]);
    const meta = await metaOf({ ...(await input()), stages });
    expect(meta.format_version).toBe(6);
    expect(meta.notes).toBeUndefined();
  });
});
