import { describe, expect, it, vi } from 'vitest';
import { boundaryFlagJson, summarize } from '../lib/boundary-flags.ts';
import { render } from 'solid-js/web';
import { StreamHistory } from '@calab/compute';
import { parseNpy, writeNpy, ZipArchive, ZipStreamWriter, type ByteSink } from '@calab/io';
import { buildCalaExport, EXPORT_FORMAT_VERSION, type ExportInput } from '../lib/export.ts';
import { FovProjector, projectionFor } from '../lib/fov-projection.ts';
import { fovDisplayRanges } from '../lib/fov-display.ts';
import { memoryTraceFile } from '../lib/trace-file.ts';
import { RunRecord } from '../lib/run-record.ts';
import { RunEvents } from '../lib/run-events.ts';
import { openResult, qcFromColumns, stagesFromMeta } from '../lib/result-file.ts';
import { FLAG_LOW_SNR, FLAG_UNMEASURED, type CellQcRow, type QcSnapshot } from '../lib/qc.ts';
import type { StageRun } from '../lib/run-stages.ts';
import type { LibraryView } from '../workers/slow-types.ts';

// uPlot needs a real browser (matchMedia); the History plots render nothing here.
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

const W = 4;
const H = 3;
const T = 10;
const ids = Uint32Array.of(4, 9);

function library(): LibraryView {
  return {
    version: 7,
    frame: T,
    width: W,
    height: H,
    ids,
    centers: Float32Array.of(0.5, 0.5, 1.5, 2.5),
    radii: Float32Array.of(1, 1.5),
    starts: Uint32Array.of(0, 2, 4),
    pixels: Uint32Array.of(0, 1, 6, 7),
    values: Float32Array.of(1, 0.5, 1, 0.25),
  };
}

/** Two sessions of 5 frames; frame f is filled with f (registered) and 10 f (output). */
function projections() {
  const p = new FovProjector(W, H, [5]);
  const px = W * H;
  const reg = new Float32Array(T * px);
  const out = new Float32Array(T * px);
  for (let f = 0; f < T; f++) {
    reg.fill(f, f * px, (f + 1) * px);
    out.fill(10 * f, f * px, (f + 1) * px);
  }
  reg[0] = NaN; // pixel 0 of frame 0 has no data
  p.addRegistered(reg.subarray(0, 4 * px), 0, 4);
  p.addOutput(out.subarray(0, 4 * px), 0, 4);
  p.addRegistered(reg.subarray(4 * px), 4, 6);
  p.addOutput(out.subarray(4 * px), 4, 6);
  return p.result();
}

const STAGES: StageRun[] = [
  {
    stage: 'discover',
    index: 1,
    startedAt: '2026-11-13T10:00:00.000Z',
    endedAt: '2026-11-13T10:01:00.000Z',
    outcome: 'done',
    frames: T,
    cells: 2,
    libraryVersion: 7,
    adds: 3,
  },
  {
    stage: 'extract',
    index: 1,
    startedAt: '2026-11-13T10:01:00.000Z',
    endedAt: '2026-11-13T10:02:00.000Z',
    outcome: 'done',
    frames: T,
    cells: 2,
    libraryVersion: 7,
  },
];

async function input(range?: { start: number; end: number }): Promise<ExportInput> {
  const traces = new Float32Array(T * 2);
  for (let f = 0; f < T; f++) for (let c = 0; c < 2; c++) traces[f * 2 + c] = 100 * c + f;
  const rec = new RunRecord(2);
  for (let t = 0; t < T; t++) rec.push(t, [0], [0], [0], [0], [0]);
  const row = (id: number, pass: boolean, flags: number): CellQcRow =>
    ({ id, slot: 0, peakSnr: 7, pass, flags, maxNeighbourId: -1 }) as CellQcRow;
  const rows = [row(4, true, 0), row(9, false, FLAG_LOW_SNR)];
  const h = new StreamHistory();
  h.define({
    key: 'cells',
    label: 'Cells',
    unit: 'cells',
    group: 'convergence',
    kind: 'value',
    range: [0, 200],
    rangeRule: 'ladder125',
    color: '#000',
    digits: 0,
  });
  for (let t = 0; t < 5; t++) h.push('cells', t, t);
  h.advance(T / 20);
  const ev = new RunEvents();
  ev.push({ frame: 0, t: 0, kind: 'stage', to: 'discover', detail: 'Discover started', wall: 1 });
  return {
    label: 'mouse1/s1',
    width: W,
    height: H,
    fps: 20,
    bitDepth: 8,
    result: {
      ids,
      traces: await memoryTraceFile(traces, T, 2),
      signed: await memoryTraceFile(
        traces.map((v) => v - 1000),
        T,
        2,
      ),
      frames: T,
      cells: 2,
      version: 7,
      library: library(),
      seconds: 1,
      projection: projections(),
    },
    run: rec.snapshot(),
    flatField: [{ frame: 0, seq: 0, source: 'replay', first: true }],
    flatFieldMap: {
      gain: new Float32Array(W * H).fill(1.05),
      offset: new Float32Array(0),
      dark: 0,
      binsUsed: 1,
      framesUsed: 1,
      gainSd: 0.03,
    },
    stages: STAGES,
    qc: { rows, byId: new Map(rows.map((r) => [r.id, r])) } as unknown as QcSnapshot,
    firstSeen: (id) => (id === 4 ? 2 : undefined),
    history: { bins: h.toExport(), eventsJson: ev.toJSON() },
    version: 'test',
    createdAt: '2026-11-13T10:03:00.000Z',
    ...(range ? { frameRange: range } : {}),
  };
}

function sink(): ByteSink & { blob(): Blob } {
  const parts: Uint8Array[] = [];
  return { write: (c) => void parts.push(c.slice()), blob: () => new Blob(parts as BlobPart[]) };
}

/**
 * An older export from a v4 one: drop the entries and meta keys that came
 * later, and optionally store the traces in C order (a NumPy re-save).
 */
async function downgrade(v4: Blob, version: 1 | 2 | 3 | 4, cOrderTraces = false): Promise<Blob> {
  const z = await ZipArchive.open(v4);
  const s = sink();
  const out = new ZipStreamWriter(s);
  for (const e of z.entries) {
    const name = e.name;
    if (['fov_mean.npy', 'fov_max.npy', 'flat_field_gain.npy'].includes(name)) continue;
    if (version < 4 && name === 'traces_signed.npy') continue;
    if (version < 2 && (name.startsWith('history_') || name === 'run_events_json.npy')) continue;
    let bytes = await z.read(name);
    if (name === 'meta_json.npy') {
      const a = parseNpy(bytes.slice().buffer);
      const meta = JSON.parse(new TextDecoder().decode(a.data as Uint8Array));
      meta.format_version = version;
      delete meta.fov_images;
      delete meta.bit_depth;
      if (version < 4) delete meta.traces_signed;
      if (version < 3) delete meta.stages;
      if (version < 2) delete meta.history;
      const m = new TextEncoder().encode(JSON.stringify(meta));
      bytes = new Uint8Array(writeNpy(m, [m.length]));
    }
    if (name === 'traces.npy' && cOrderTraces) {
      const a = parseNpy(bytes.slice().buffer); // Fortran: data is frame-major
      const [n, t] = a.shape;
      const c = new Float32Array(n * t);
      for (let f = 0; f < t; f++) for (let j = 0; j < n; j++) c[j * t + f] = a.data[f * n + j];
      bytes = new Uint8Array(writeNpy(c, [n, t]));
    }
    await out.addFile(name, bytes);
  }
  await out.finish();
  return s.blob();
}

describe('FovProjector', () => {
  it('keeps a mean and max per session, skipping pixels without data', () => {
    const p = projections();
    expect(p.spans.map((s) => [s.start, s.frames])).toEqual([
      [0, 5],
      [5, 5],
    ]);
    // Session 1: frames 0..4, pixel 0 lacks frame 0.
    expect(p.spans[0].mean[0]).toBeCloseTo((1 + 2 + 3 + 4) / 4);
    expect(p.spans[0].mean[1]).toBeCloseTo(2);
    expect(p.spans[0].max[1]).toBe(40);
    expect(p.spans[1].mean[1]).toBeCloseTo(7);
    expect(p.spans[1].max[1]).toBe(90);
  });

  it('combines the spans inside a range, and none outside', () => {
    const p = projections();
    const all = projectionFor(p, { start: 0, end: T })!;
    expect(all.frames).toBe(T);
    expect(all.mean[1]).toBeCloseTo(4.5);
    expect(all.max[1]).toBe(90);
    expect(projectionFor(p, { start: 5, end: 10 })!.mean[1]).toBeCloseTo(7);
    expect(projectionFor(p, { start: 2, end: 6 })).toBeNull();
    expect(projectionFor(null, { start: 0, end: T })).toBeNull();
  });

  it('marks a pixel with no data in any frame as NaN', () => {
    const p = new FovProjector(1, 1);
    p.addRegistered(Float32Array.of(NaN), 0, 1);
    p.addOutput(Float32Array.of(NaN), 0, 1);
    const r = p.result();
    expect(r.spans[0].mean[0]).toBeNaN();
    expect(r.spans[0].max[0]).toBeNaN();
  });
});

describe('export format 5 and the result reader', () => {
  it('round-trips a session of a Joint run: images, flat field, traces, QC, stages, history', async () => {
    const blob = new Blob([await buildCalaExport(await input({ start: 5, end: 10 }))]);
    const r = await openResult(blob);
    expect(r.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(r.formatVersion).toBe(6);
    expect([r.width, r.height, r.frames, r.fps]).toEqual([W, H, 5, 20]);
    expect(r.label).toBe('mouse1/s1');
    expect(r.missing.size).toBe(0);
    // The second session's own images, on the fixed ranges of an 8-bit recording.
    const [mean, max] = r.images;
    expect(mean.key).toBe('fov_mean');
    expect(mean.data[1]).toBeCloseTo(7);
    expect(max.data[1]).toBe(90);
    const ranges = fovDisplayRanges(8);
    expect(mean.range).toEqual({ lo: ranges.mean[0], hi: ranges.mean[1] });
    expect(ranges.mean).toEqual([-255 / 32, 255 / 8]);
    expect(max.range).toEqual({ lo: ranges.max[0], hi: ranges.max[1] });
    expect(r.flatField?.data[0]).toBeCloseTo(1.05);
    expect(r.flatField?.gainSd).toBeCloseTo(0.03);
    expect(r.flatField?.range).toEqual({ lo: 0.9, hi: 1.1 });
    // Traces: frames 5..9 of the run, frame-major.
    expect([...(await r.readFrames(1, 3))]).toEqual([6, 106, 7, 107]);
    expect([...(await r.readSignedFrames!(1, 2))]).toEqual([6 - 1000, 106 - 1000]);
    await expect(r.readFrames(0, 6)).rejects.toThrow(RangeError);
    // Footprints, first seen, QC.
    expect([...r.library.pixels]).toEqual([0, 1, 6, 7]);
    expect(r.firstSeen.get(4)).toBe(2);
    expect(r.firstSeen.has(9)).toBe(false);
    expect(r.qc?.byId.get(4)?.pass).toBe(true);
    expect(r.qc?.byId.get(9)?.flags).toBe(FLAG_LOW_SNR);
    expect(r.stages.map((s) => s.stage)).toEqual(['discover', 'extract']);
    expect(r.stages[0].adds).toBe(3);
    expect(r.history?.bins.levels[0].n).toBeGreaterThan(0);
    expect(r.history?.events[0]).toMatchObject({ kind: 'stage', to: 'discover' });
  });

  it('reads the session-boundary flag (format 6) and shows it', async () => {
    const flag = summarize(1, 5, [
      {
        key: 'match',
        group: 'alignment',
        severity: 'failed',
        judged: true,
        value: 0.3,
        nullCentre: 0.95,
        nullSpread: 0.01,
        z: 40,
        reason: 'Alignment failed: test.',
      },
    ]);
    const base = await input({ start: 5, end: 10 });
    const blob = new Blob([
      await buildCalaExport({
        ...base,
        session: { mode: 'joint', index: 1, boundary: boundaryFlagJson(flag) },
      }),
    ]);
    const r = await openResult(blob);
    expect(r.boundary?.severity).toBe('failed');
    expect(r.boundary?.reason).toBe('Alignment failed: test.');
    const { ResultView } = await import('../components/ResultView.tsx');
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <ResultView result={r} origin={{ session: 's2' }} />, root);
    const badge = root.querySelector('[data-testid=result-boundary] [data-testid=boundary-badge]');
    expect(badge?.getAttribute('data-severity')).toBe('failed');
    expect(badge?.getAttribute('title')).toMatch(/Separate/);
    dispose();
    root.remove();
    // Older exports have none.
    const old = await openResult(new Blob([await buildCalaExport(await input())]));
    expect(old.boundary).toBeNull();
  });

  it('opens a ZIP64 export', async () => {
    const blob = new Blob([await buildCalaExport(await input(), { forceZip64: true })]);
    const r = await openResult(blob);
    expect(r.frames).toBe(T);
    expect([...(await r.readFrames(9, 10))]).toEqual([9, 109]);
    expect(r.images[0].data[1]).toBeCloseTo(4.5);
  });

  it('opens format 4 (signed traces, no images)', async () => {
    const v4 = await downgrade(new Blob([await buildCalaExport(await input())]), 4);
    const r = await openResult(v4);
    expect(r.formatVersion).toBe(4);
    expect([...r.missing].sort()).toEqual(['flatfield', 'fov']);
    expect([...(await r.readSignedFrames!(0, 1))]).toEqual([-1000, 100 - 1000]);
  });

  it('opens format 3 (no images, no flat-field map) and says what is missing', async () => {
    const v3 = await downgrade(new Blob([await buildCalaExport(await input())]), 3);
    const r = await openResult(v3);
    expect(r.formatVersion).toBe(3);
    expect(r.images).toEqual([]);
    expect(r.flatField).toBeNull();
    expect([...r.missing].sort()).toEqual(['flatfield', 'fov']);
    expect(r.stages).toHaveLength(2);
    expect(r.readSignedFrames).toBeNull();
    expect([...(await r.readFrames(0, 1))]).toEqual([0, 100]);
  });

  it('opens the format 1-2 exports from before #370 (no stages; v1: no history)', async () => {
    const v4 = new Blob([await buildCalaExport(await input())]);
    const v2 = await openResult(await downgrade(v4, 2));
    expect(v2.stages).toEqual([]);
    expect(v2.missing.has('stages')).toBe(true);
    expect(v2.history).not.toBeNull();
    const v1 = await openResult(await downgrade(v4, 1, true));
    expect(v1.history).toBeNull();
    expect([...v1.missing].sort()).toEqual(['flatfield', 'fov', 'history', 'stages']);
    // C-order traces (a NumPy re-save) read the same.
    expect([...(await v1.readFrames(3, 5))]).toEqual([3, 103, 4, 104]);
  });

  it('rejects a file that is not a cala export', async () => {
    const s = sink();
    const z = new ZipStreamWriter(s);
    await z.addFile('traces.npy', new Uint8Array(writeNpy(new Float32Array(4), [2, 2])));
    await z.finish();
    await expect(openResult(s.blob())).rejects.toThrow(/not a cala export/);
  });
});

describe('QC and stages from the export', () => {
  it('marks cells QC never measured', () => {
    const q = qcFromColumns(Uint32Array.of(1, 2), [5, NaN], [1, -1], [0, 0], 10, 3);
    expect(q.byId.get(2)!.flags & FLAG_UNMEASURED).toBeTruthy();
    expect(q.global.passFrac).toBe(1);
  });

  it('reads snake_case stage runs', () => {
    const s = stagesFromMeta([
      { stage: 'refine', index: 2, started_at: 'a', ended_at: null, footprints_refined: 4 },
    ]);
    expect(s[0]).toMatchObject({ stage: 'refine', index: 2, endedAt: null, footprintsRefined: 4 });
    expect(stagesFromMeta(undefined)).toEqual([]);
  });
});

describe('ResultView', () => {
  it('is read-only and says what an older export lacks', async () => {
    const { ResultView } = await import('../components/ResultView.tsx');
    const v3 = await openResult(
      await downgrade(new Blob([await buildCalaExport(await input())]), 3),
    );
    const root = document.createElement('div');
    document.body.appendChild(root);
    const dispose = render(() => <ResultView result={v3} origin={{ session: 's1' }} />, root);
    try {
      expect(root.querySelector('[data-testid="result-readonly"]')?.textContent).toMatch(
        /Read-only/,
      );
      // No stage controls: nothing to run.
      const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent ?? '');
      for (const word of ['Discover', 'Refine', 'Extract', 'Restart', 'Pause'])
        expect(buttons.some((b) => b.includes(word))).toBe(false);
      expect(root.querySelector('[data-testid="result-stages"]')?.textContent).toMatch(
        /Discover: done/,
      );
      expect(root.querySelector('[data-testid="result-missing"]')?.textContent).toMatch(
        /Not in this export: field-of-view images/,
      );
      expect(root.querySelector('.cala-fov__empty')?.textContent).toMatch(/Not in this export/);
      expect(root.querySelector('[data-testid="view-select"]')?.textContent).toMatch(/No image/);
      expect(root.querySelector('[data-testid="trace-mode"]')).toBeNull();
    } finally {
      dispose();
      root.remove();
    }
  });

  it('offers the mean and max images of a format 5 export', async () => {
    const { ResultView } = await import('../components/ResultView.tsx');
    const r = await openResult(new Blob([await buildCalaExport(await input())]));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const dispose = render(() => <ResultView result={r} origin={{}} />, root);
    try {
      const views = root.querySelector('[data-testid="view-select"]')?.textContent ?? '';
      expect(views).toMatch(/Mean/);
      expect(views).toMatch(/Max/);
      expect(root.querySelector('[data-testid="result-missing"]')).toBeNull();
      expect(root.querySelector('[data-testid="trace-mode"]')?.textContent).toMatch(/Signed/);
      // The fixed range of the image shown (max, 8-bit): no fitting.
      const hi = root.querySelector<HTMLInputElement>('[data-testid="range-hi"]');
      expect(Number(hi?.value)).toBeCloseTo(fovDisplayRanges(8).max[1], 0);
    } finally {
      dispose();
      root.remove();
    }
  });
});
