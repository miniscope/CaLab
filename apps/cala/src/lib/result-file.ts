/**
 * Reading a saved cala export (`cala-export.npz`, see the header of
 * `export.ts`) back for the read-only result viewer (docs/projects.md,
 * "View results").
 *
 * The archive is opened lazily (`ZipArchive` in `@calab/io`: its directory
 * only, ZIP64-aware), so a file of any size opens without being read whole.
 * The small arrays are read and parsed; `traces.npy` is not: `readFrames`
 * reads a block of frames from it when asked. The matrix is stored Fortran
 * order (cells x frames), which is frame-major on disk, so a block of frames
 * is one contiguous byte range (C-order files, e.g. re-saved by NumPy, are
 * read whole once and transposed per block).
 *
 * Every format version opens: 1 to 4 lack the FOV images and the flat-field
 * map (5), 1 to 3 the signed traces (4), 1 the history and events (2), and 1
 * and 2 the stage list (3). What is
 * missing is listed in `missing` so the viewer can say "not in this export".
 */
import { parseBoundaryFlag, type BoundaryFlag } from './boundary-flags.ts';
import { parseNpy, parseNpyHeader, ZipArchive, type ZipSource } from '@calab/io';
import type { HistoryExport } from '@calab/compute';
import type { NumericTypedArray } from '@calab/core';
import type { LibraryView } from '../workers/slow-types.ts';
import { FLAT_FIELD_DISPLAY_RANGE } from './flat-field.ts';
import { fovDisplayRanges, storedRange } from './fov-display.ts';
import type { DisplayRange } from './frame-display.ts';
import { FLAG_UNMEASURED, type CellQcRow, type QcSnapshot } from './qc.ts';
import type { RunEvent } from './run-events.ts';
import type { StageName, StageRun } from './run-stages.ts';

/** One field-of-view image of the export with the fixed range it is drawn with. */
export interface ResultImage {
  key: string;
  width: number;
  height: number;
  data: Float32Array;
  range: DisplayRange;
  /** What the image is (from `meta_json`). */
  domain: string;
}

/** The parts of the viewer a result can lack (shown as "not in this export"). */
export type ResultPart = 'fov' | 'flatfield' | 'history' | 'stages' | 'qc';

export interface LoadedResult {
  formatVersion: number;
  meta: Record<string, unknown>;
  label: string;
  width: number;
  height: number;
  frames: number;
  /** Frames per second (0: unknown). */
  fps: number;
  ids: Uint32Array;
  library: LibraryView;
  firstSeen: Map<number, number>;
  qc: QcSnapshot | null;
  stages: StageRun[];
  /** Mean, then max, when the export holds them. */
  images: ResultImage[];
  flatField: (ResultImage & { gainSd: number | null }) | null;
  history: { bins: HistoryExport; events: RunEvent[] } | null;
  missing: Set<ResultPart>;
  /** Frames `[from, to)` of every cell, frame after frame (`(to - from) * cells` values). */
  readFrames(from: number, to: number): Promise<Float32Array>;
  /** The same from `traces_signed` (format 4; null when absent, e.g. a live run). */
  readSignedFrames: ((from: number, to: number) => Promise<Float32Array>) | null;
  /** Joint, sessions 2..: the health flag of the boundary the session starts with (format 6). */
  boundary: BoundaryFlag | null;
}

const asF32 = (a: NumericTypedArray): Float32Array =>
  a instanceof Float32Array ? a : Float32Array.from(a);
const asU32 = (a: NumericTypedArray): Uint32Array =>
  a instanceof Uint32Array ? a : Uint32Array.from(a);

async function readNpy(zip: ZipArchive, name: string) {
  return parseNpy((await zip.read(`${name}.npy`)).slice().buffer);
}

async function readJson(zip: ZipArchive, name: string): Promise<unknown> {
  const a = await readNpy(zip, name);
  const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  return JSON.parse(new TextDecoder().decode(bytes));
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** `meta_json.stages` (snake_case) as stage runs. */
export function stagesFromMeta(v: unknown): StageRun[] {
  if (!Array.isArray(v)) return [];
  return v.map((x: Record<string, unknown>) => {
    const r: StageRun = {
      stage: String(x.stage) as StageName,
      index: num(x.index, 1),
      startedAt: String(x.started_at ?? ''),
      endedAt: typeof x.ended_at === 'string' ? x.ended_at : null,
      outcome: (x.outcome as StageRun['outcome']) ?? 'done',
      frames: num(x.frames, 0),
      cells: num(x.cells, 0),
      libraryVersion: num(x.library_version, 0),
    };
    const opt: [keyof StageRun, string][] = [
      ['refines', 'refines'],
      ['refinesPerMin', 'refines_per_min'],
      ['adds', 'adds'],
      ['merges', 'merges'],
      ['deletes', 'deletes'],
      ['splits', 'splits'],
      ['footprintsRefined', 'footprints_refined'],
      ['medianFootprintChange', 'median_footprint_change'],
    ];
    for (const [k, key] of opt)
      if (key in x) (r as unknown as Record<string, unknown>)[k] = x[key] as number | null;
    return r;
  });
}

/**
 * The QC snapshot the viewer's panels read, from the exported columns: peak
 * SNR, the verdict and the flag bits. The export holds no other QC metric,
 * so those are NaN (shown as "n/a"), and no residual map or neighbours.
 */
export function qcFromColumns(
  ids: Uint32Array,
  snr: ArrayLike<number>,
  pass: ArrayLike<number>,
  flags: ArrayLike<number>,
  frame: number,
  version: number,
): QcSnapshot {
  const rows: CellQcRow[] = [];
  const byId = new Map<number, CellQcRow>();
  for (let i = 0; i < ids.length; i++) {
    const measured = pass[i] >= 0;
    const row: CellQcRow = {
      id: ids[i],
      slot: i,
      ageFrames: NaN,
      frames: NaN,
      peakSnr: snr[i],
      eventRate: NaN,
      projR: NaN,
      vif: NaN,
      maxOverlap: NaN,
      maxNeighbourR: NaN,
      maxNeighbourId: -1,
      fpError: NaN,
      motionR2: NaN,
      nNeighbours: NaN,
      fpLastR: NaN,
      slowFrac: NaN,
      zeroFrac: NaN,
      diffSkew: NaN,
      fpRadiusPx: NaN,
      flags: measured ? flags[i] : flags[i] | FLAG_UNMEASURED,
      pass: pass[i] === 1,
    };
    rows.push(row);
    byId.set(row.id, row);
  }
  const measured = rows.filter((r) => !(r.flags & FLAG_UNMEASURED));
  const snrs = measured
    .map((r) => r.peakSnr)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    frame,
    version,
    rows,
    byId,
    neighbours: new Map(),
    global: {
      frames: frame,
      cells: ids.length,
      cellsMeasured: measured.length,
      explained: NaN,
      residualExcess: NaN,
      addsPerMin: NaN,
      removesPerMin: NaN,
      footprintChangesPerMin: NaN,
      snrMedian: snrs.length ? snrs[Math.floor(snrs.length / 2)] : NaN,
      passFrac: measured.length ? measured.filter((r) => r.pass).length / measured.length : NaN,
      pairFrac: NaN,
      stableCells: NaN,
      fpStability: NaN,
      traceSigmaChange: NaN,
      stableFrac: NaN,
    },
    residual: { blocksWide: 0, blocksHigh: 0, blockPx: 0, values: new Float32Array(0) },
    buildMs: 0,
  };
}

/** The history arrays (format 2+), or null when the export has none. */
async function readHistory(
  zip: ZipArchive,
  meta: Record<string, unknown>,
): Promise<LoadedResult['history']> {
  const hm = meta.history as Record<string, unknown> | undefined;
  if (!hm || !Array.isArray(hm.levels)) return null;
  const levels: HistoryExport['levels'] = [];
  const bands: { k: number; data: Float32Array }[] = [];
  for (const l of hm.levels as { k: number; bin_s: number; t0_s: number; n: number }[]) {
    if (!zip.has(`history_L${l.k}.npy`)) return null;
    const data = asF32((await readNpy(zip, `history_L${l.k}`)).data);
    levels.push({ k: l.k, binS: l.bin_s, t0: l.t0_s, n: l.n, data });
    if (zip.has(`history_band_L${l.k}.npy`))
      bands.push({ k: l.k, data: asF32((await readNpy(zip, `history_band_L${l.k}`)).data) });
  }
  const events = zip.has('run_events_json.npy')
    ? ((await readJson(zip, 'run_events_json')) as RunEvent[])
    : [];
  return { bins: { levels, bands: bands.length ? bands : null, meta: hm }, events };
}

/** A float32 [H, W] image of the export, or null when absent or the wrong size. */
async function readImage(zip: ZipArchive, key: string, width: number, height: number) {
  if (!zip.has(`${key}.npy`)) return null;
  const a = await readNpy(zip, key);
  if (a.data.length !== width * height) return null;
  return asF32(a.data);
}

/** The trace reader over `traces.npy` (Fortran order: ranges; C order: read once). */
async function traceReader(
  zip: ZipArchive,
  cells: number,
  frames: number,
  name = 'traces.npy',
): Promise<LoadedResult['readFrames']> {
  if (!zip.has(name) || cells === 0)
    return async (from, to) => new Float32Array((to - from) * cells);
  const head = parseNpyHeader(await zip.readRange(name, 0, Math.min(zip.entry(name).size, 65536)));
  if (head.dtype !== '<f4') throw new Error(`${name} is ${head.dtype}; float32 is expected.`);
  if (head.shape.length !== 2 || head.shape[0] !== cells || head.shape[1] !== frames)
    throw new Error(`${name} has shape (${head.shape.join(', ')}), not (${cells}, ${frames}).`);
  const check = (from: number, to: number) => {
    if (from < 0 || to > frames || to < from)
      throw new RangeError(`Frames ${from}..${to} are not in the traces.`);
  };
  if (head.fortranOrder) {
    return async (from, to) => {
      check(from, to);
      const bytes = await zip.readRange(
        name,
        head.dataOffset + from * cells * 4,
        head.dataOffset + to * cells * 4,
      );
      return new Float32Array(bytes.slice().buffer);
    };
  }
  // C order (cells x frames, row after row): read once, transpose per block.
  let whole: Float32Array | null = null;
  return async (from, to) => {
    check(from, to);
    if (!whole) {
      const bytes = await zip.readRange(
        name,
        head.dataOffset,
        head.dataOffset + cells * frames * 4,
      );
      whole = new Float32Array(bytes.slice().buffer);
    }
    const out = new Float32Array((to - from) * cells);
    for (let f = from; f < to; f++)
      for (let j = 0; j < cells; j++) out[(f - from) * cells + j] = whole[j * frames + f];
    return out;
  };
}

/** Open a saved export (any format version). Throws with a readable message when it is not one. */
export async function openResult(src: ZipSource, label = ''): Promise<LoadedResult> {
  const zip = await ZipArchive.open(src);
  for (const k of ['meta_json', 'cell_ids', 'fov_shape', 'footprint_starts'])
    if (!zip.has(`${k}.npy`)) throw new Error(`This is not a cala export (no ${k}).`);
  const meta = (await readJson(zip, 'meta_json')) as Record<string, unknown>;
  const formatVersion = num(meta.format_version, 1);
  const shape = (await readNpy(zip, 'fov_shape')).data;
  const height = Number(shape[0]);
  const width = Number(shape[1]);
  const ids = asU32((await readNpy(zip, 'cell_ids')).data);
  const n = ids.length;
  const frames = num(meta.frames, 0);
  const rate = zip.has('sampling_rate_hz.npy')
    ? Number((await readNpy(zip, 'sampling_rate_hz')).data[0])
    : num(meta.sampling_rate_hz, 0);
  const libraryVersion = num(meta.library_version, 0);
  const library: LibraryView = {
    version: libraryVersion,
    frame: frames,
    width,
    height,
    ids,
    centers: asF32((await readNpy(zip, 'centroids_yx')).data),
    radii: asF32((await readNpy(zip, 'radii_px')).data),
    starts: asU32((await readNpy(zip, 'footprint_starts')).data),
    pixels: asU32((await readNpy(zip, 'footprint_pixels')).data),
    values: asF32((await readNpy(zip, 'footprint_values')).data),
  };
  const missing = new Set<ResultPart>();

  const firstSeen = new Map<number, number>();
  if (zip.has('first_seen_frame.npy')) {
    const seen = (await readNpy(zip, 'first_seen_frame')).data;
    for (let i = 0; i < n; i++) if (seen[i] >= 0) firstSeen.set(ids[i], Number(seen[i]));
  }

  let qc: QcSnapshot | null = null;
  if (zip.has('qc_pass.npy') && zip.has('qc_peak_snr.npy') && zip.has('qc_flags.npy')) {
    qc = qcFromColumns(
      ids,
      (await readNpy(zip, 'qc_peak_snr')).data,
      (await readNpy(zip, 'qc_pass')).data,
      (await readNpy(zip, 'qc_flags')).data,
      frames,
      libraryVersion,
    );
  } else missing.add('qc');

  const stages = stagesFromMeta(meta.stages);
  if (!Array.isArray(meta.stages)) missing.add('stages');

  // FOV images (format 5): drawn with the range stored with them, else the fixed rule.
  const fov = meta.fov_images as
    { images?: { key: string; domain?: string; display_range?: unknown }[] } | undefined;
  const rule = fovDisplayRanges(num(meta.bit_depth, 8));
  const images: ResultImage[] = [];
  for (const key of ['fov_mean', 'fov_max']) {
    const data = await readImage(zip, key, width, height);
    if (!data) continue;
    const m = fov?.images?.find((x) => x.key === key);
    const fallback = key === 'fov_mean' ? rule.mean : rule.max;
    images.push({
      key,
      width,
      height,
      data,
      range: storedRange(m?.display_range) ?? { lo: fallback[0], hi: fallback[1] },
      domain: m?.domain ?? '',
    });
  }
  if (images.length === 0) missing.add('fov');

  const ffMeta = meta.flat_field as Record<string, unknown> | undefined;
  const gain = await readImage(zip, 'flat_field_gain', width, height);
  const flatField = gain
    ? {
        key: 'flat_field_gain',
        width,
        height,
        data: gain,
        range: storedRange(ffMeta?.display_range) ?? {
          lo: FLAT_FIELD_DISPLAY_RANGE[0],
          hi: FLAT_FIELD_DISPLAY_RANGE[1],
        },
        domain: 'sensor gain (1 = nominal)',
        gainSd: typeof ffMeta?.gain_sd === 'number' ? ffMeta.gain_sd : null,
      }
    : null;
  if (!flatField) missing.add('flatfield');

  const history = await readHistory(zip, meta);
  if (!history) missing.add('history');

  return {
    formatVersion,
    meta,
    label: typeof meta.recording === 'string' && meta.recording ? meta.recording : label,
    width,
    height,
    frames,
    fps: rate > 0 ? rate : 0,
    ids,
    library,
    firstSeen,
    qc,
    stages,
    images,
    flatField,
    history,
    missing,
    readFrames: await traceReader(zip, n, frames),
    readSignedFrames: zip.has('traces_signed.npy')
      ? await traceReader(zip, n, frames, 'traces_signed.npy')
      : null,
    boundary: parseBoundaryFlag((meta.session as Record<string, unknown> | undefined)?.boundary),
  };
}
