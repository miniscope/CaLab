/**
 * Export of a finished cala run (after Extract): the footprints, the full-length
 * traces and the per-frame motion and flicker, as one self-describing `.npz`
 * (`writeCalaExport`), and the traces alone in the layout CaDecon already
 * imports (`writeCaDeconExport`).
 *
 * Both are plain NumPy archives (stored uncompressed like `np.savez`), so
 * `np.load` reads them and CaDecon's existing `.npz` import path takes the
 * second one as is: its trace-matrix finder auto-selects a lone cells x
 * timepoints array, so the CaDecon file holds exactly one matrix (`traces`)
 * next to 1-D arrays. CaDecon asks for the sampling rate on import; it is in
 * the file as `sampling_rate_hz` and in the button's tooltip.
 *
 * Streaming. The archive is written incrementally (`ZipStreamWriter` in
 * `@calab/io`, ZIP64-capable) to a `ByteSink`, so nothing the size of the
 * trace matrix is ever in memory: the matrix is read from Extract's
 * `TraceFile` in blocks of about 16 MB and written as it goes. That file
 * is frame-major, which is byte for byte the layout of a Fortran-order `.npy`
 * of shape (N, T), so `traces.npy` is written with `fortran_order: True` and
 * needs no transpose. `np.load` returns the same (N, T) array a C-order file
 * would (only its memory layout differs; `np.ascontiguousarray` converts), and
 * `@calab/io`'s npy parser flips Fortran order on import. `saveExport` picks
 * where the bytes go: a user-chosen file through the File System Access API
 * (`showSaveFilePicker`, Chrome and Edge), else a file built in OPFS and then
 * downloaded (Firefox, Safari: disk-backed, no RAM), else memory for small
 * archives.
 *
 * Format of `calaExport.npz` (N cells, T frames, H x W field of view). Keys,
 * dtypes and shapes are unchanged from format version 1; only the memory order
 * of `traces` differs (Fortran, see above):
 *
 *   traces              float32 [N, T]   Extract's traces, one row per cell (preprocessed grey levels);
 *                                        stored Fortran-order (column per frame)
 *   cell_ids            uint32  [N]      library ids, row order of `traces`
 *   centroids_yx        float32 [N, 2]   footprint centre, (row, column) in pixels
 *   radii_px            float32 [N]      footprint radius
 *   footprint_starts    uint32  [N+1]    sparse footprints, CSR: cell i owns entries
 *   footprint_pixels    uint32  [nnz]      starts[i]..starts[i+1] of these (flat index
 *   footprint_values    float32 [nnz]      row * W + column) and their weights (unfiltered)
 *   fov_shape           int32   [2]      (H, W)
 *   motion_shift_yx     float32 [T, 2]   rigid shift registering each frame, pixels
 *   motion_flags        uint8   [T]      motion flags (1 template updated, 2 anomalous, 4 held,
 *                                        8 bootstrap, 16 brightness outlier, 32 low quality)
 *   flicker_offset      float32 [T]      global additive flicker removed, grey levels
 *   flicker_gain        float32 [T]      global relative flicker gain removed (frame / (1 + gain))
 *   first_seen_frame    int32   [N]      frame at which the cell first appeared (-1 unknown)
 *   qc_peak_snr         float32 [N]      peak SNR (NaN: not measured)
 *   qc_pass             int8    [N]      1 pass, 0 fail, -1 not measured
 *   qc_flags            uint32  [N]      QC flag bits (1 low SNR, 2 correlated pair, 4 likely duplicate, 8 unmeasured)
 *   sampling_rate_hz    float32 [1]      frame rate (0: unknown)
 *   meta_json           uint8   [bytes]  UTF-8 JSON: provenance and the cell table
 *
 * Run history (format version 2; optional to readers, absent when the run kept none):
 *
 *   history_L{k}        float32 [S, n_k, 4]   level-k bins of every series over stream time:
 *                                           min, max, mean, last (NaN: empty bin)
 *   history_band_L{k}   float32 [Sb, n_k, 2]  lo, hi of the band series (when any)
 *   run_events_json     uint8   [bytes]       UTF-8 JSON array of the run's events
 *
 * `meta_json.history` gives the layout: the time base (stream seconds =
 * frame / sampling rate), each level's bin width, first bin time and count,
 * and each series' key, label, unit, kind, group, initial and final display
 * range (see `StreamHistory.toExport`).
 *
 * Run stages (format version 3): `meta_json.stages` lists the runs of the
 * stages (docs/stages.md) since Discover started, in order: `stage`
 * (discover, refine, extract), `index` (1-based per stage), `started_at`,
 * `ended_at` (ISO), `outcome`, `frames`, `cells`, `library_version`, and the
 * stage's counts (Discover: refines, adds, merges, deletes, splits; Refine:
 * refines, refines_per_min, footprints_refined, median_footprint_change).
 * Version 3 also renamed `pass2_seconds` to `extract_seconds` and the flat
 * field's `pass2` / `pass1_maps` to `extract` / `discover_maps`.
 *
 * QC comes from the last online snapshot of Discover (cells added after it are
 * "not measured"); first-seen is the frame count when the library that first
 * held the cell arrived.
 *
 * ZIP64. Entries of 4 GiB or more (the trace matrix of a long recording:
 * 4000 cells x 270k frames) get ZIP64 records, which Python's `zipfile`,
 * `np.load`, `unzip` and 7-zip read.
 *
 * CaDecon hand-off. For ordinary sizes (the selected traces up to
 * `CADECON_MEMORY_BYTES`) the file is the classic one: C-order `traces`,
 * non-ZIP64. Above that it is written streaming, Fortran-order, ZIP64 when
 * needed. CaDecon's own importer (fflate, 1 GiB decompressed cap, no ZIP64)
 * cannot open a file that large: use the cala `.npz` with `np.load` for very
 * long recordings, or export fewer cells (QC-passing only). A chunked CaDecon
 * importer is not built.
 */
import {
  writeNpy,
  writeNpyHeader,
  ZipStreamWriter,
  type ByteSink,
  type NpyWritable,
} from '@calab/io';
import { verdict, type QcSnapshot } from './qc.ts';
import type { Pass2Result } from './pass2-store.ts';
import type { TraceFile } from './trace-file.ts';
import { opfsUsable, OpfsWriterClient } from './opfs-writer.ts';
import type { FlatFieldApplied } from './flat-field.ts';
import type { RunSpan } from './run-record.ts';
import type { StageRun } from './run-stages.ts';
import type { HistoryExport } from '@calab/compute';

export const EXPORT_FORMAT_VERSION = 3;

/** Largest CaDecon trace matrix written the classic in-memory way (C order, no ZIP64), bytes. */
export const CADECON_MEMORY_BYTES = 512 * 1048576;
/** Trace block read per step while streaming, bytes. */
const CHUNK_BYTES = 16 * 1048576;

/** Everything an export is built from. */
export interface ExportInput {
  /** Recording label (the folder name). */
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 or undefined: unknown). */
  fps: number;
  result: Pass2Result;
  /** Discover's per-frame motion and flicker (at least `result.frames` long). */
  run: RunSpan;
  /**
   * The sensor flat field of Discover (omit: none): the maps that took effect
   * and the frame each did. Extract (the traces here) corrected every frame
   * with the last map, from frame 0.
   */
  flatField?: readonly FlatFieldApplied[];
  /** The runs of the stages since Discover started (omit: none recorded). */
  stages?: readonly StageRun[];
  /** The last QC snapshot, if any. */
  qc: QcSnapshot | null;
  /** Frame at which a cell was first seen. */
  firstSeen: (id: number) => number | undefined;
  /** The run's history and event log (omit: none written). */
  history?: { bins: HistoryExport; eventsJson: string };
  /** App version string. */
  version: string;
  /** ISO timestamp. */
  createdAt?: string;
  /**
   * Write only frames `[start, end)` of the result (one session of a Joint
   * run): traces, motion and flicker are sliced; frame numbers elsewhere
   * (`first_seen_frame`, stages, history) stay on the run's axis.
   */
  frameRange?: { start: number; end: number };
  /** Extra `meta_json.session` block (a multi-session run; see `session-export.ts`). */
  session?: Record<string, unknown>;
}

/** Options of the writers. */
export interface ExportWriteOptions {
  /** Write ZIP64 records even for small entries (testing). */
  forceZip64?: boolean;
  /** Largest CaDecon matrix written the classic in-memory way (default `CADECON_MEMORY_BYTES`). */
  cadeconMemoryBytes?: number;
  /** Called as trace bytes are written. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

/** One stage run in `meta_json.stages` (snake_case; absent counts omitted). */
export function stageMeta(r: StageRun): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {
    stage: r.stage,
    index: r.index,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    outcome: r.outcome,
    frames: r.frames,
    cells: r.cells,
    library_version: r.libraryVersion,
  };
  const counts: [string, number | null | undefined][] = [
    ['refines', r.refines],
    ['refines_per_min', r.refinesPerMin],
    ['adds', r.adds],
    ['merges', r.merges],
    ['deletes', r.deletes],
    ['splits', r.splits],
    ['footprints_refined', r.footprintsRefined],
    ['median_footprint_change', r.medianFootprintChange],
  ];
  for (const [k, v] of counts) if (v !== undefined) out[k] = v;
  return out;
}

/** One cell's row in `meta_json`. */
export interface CellMeta {
  id: number;
  centroid_y: number;
  centroid_x: number;
  radius_px: number;
  first_seen_frame: number | null;
  peak_snr: number | null;
  qc_pass: boolean | null;
  qc_flags: number | null;
}

function npy(data: NpyWritable, shape: number[]): Uint8Array {
  return new Uint8Array(writeNpy(data, shape));
}

const finite = (v: number | undefined): number | null =>
  v !== undefined && Number.isFinite(v) ? v : null;

/** Per-cell QC columns for the cells of `ids`. */
export function qcColumns(ids: Uint32Array, qc: QcSnapshot | null) {
  const n = ids.length;
  const snr = new Float32Array(n).fill(NaN);
  const pass = new Int8Array(n).fill(-1);
  const flags = new Uint32Array(n);
  if (qc) {
    for (let i = 0; i < n; i++) {
      const row = qc.byId.get(ids[i]);
      if (!row) continue;
      snr[i] = row.peakSnr;
      flags[i] = row.flags;
      const v = verdict(row).kind;
      pass[i] = v === 'pass' ? 1 : v === 'fail' ? 0 : -1;
    }
  }
  return { snr, pass, flags };
}

/** The cell table of the export (also `meta_json.cells`). */
export function cellTable(input: ExportInput): CellMeta[] {
  const { result, qc } = input;
  const { library, ids } = result;
  const { snr, pass, flags } = qcColumns(ids, qc);
  const out: CellMeta[] = [];
  for (let i = 0; i < ids.length; i++) {
    const seen = input.firstSeen(ids[i]);
    const measured = pass[i] >= 0;
    out.push({
      id: ids[i],
      centroid_y: library.centers[2 * i],
      centroid_x: library.centers[2 * i + 1],
      radius_px: library.radii[i],
      first_seen_frame: seen ?? null,
      peak_snr: finite(snr[i]),
      qc_pass: measured ? pass[i] === 1 : null,
      qc_flags: qc?.byId.has(ids[i]) ? flags[i] : null,
    });
  }
  return out;
}

/**
 * `traces` as byte chunks in Fortran order for the cells `cols` (all cells
 * when null): one frame after another, so a chunk is a run of whole frames.
 * Reads one block ahead of the consumer.
 */
export async function* traceChunks(
  file: TraceFile,
  cols: readonly number[] | null,
  onBytes?: (n: number) => void,
  range: { start: number; end: number } = { start: 0, end: file.frames },
): AsyncGenerator<Uint8Array> {
  const T = range.end;
  const width = cols ? cols.length : file.cells;
  const step = Math.max(1, Math.floor(CHUNK_BYTES / (4 * Math.max(file.cells, 1))));
  const read = (f: number): Promise<Float32Array> | null => {
    if (f >= T) return null;
    const p = file.readFrames(f, Math.min(T, f + step));
    p.catch(() => {}); // surfaced when awaited; no unhandled rejection if the consumer stops early
    return p;
  };
  let next = read(range.start);
  for (let f = range.start; next; f += step) {
    const block = await next;
    next = read(f + step);
    const frames = Math.min(T, f + step) - f;
    let out: Float32Array;
    if (cols) {
      out = new Float32Array(frames * width);
      for (let k = 0; k < frames; k++)
        for (let j = 0; j < width; j++) out[k * width + j] = block[k * file.cells + cols[j]];
    } else {
      out = block;
    }
    const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    onBytes?.(bytes.length);
    yield bytes;
  }
}

/** Approximate size of a cala export, bytes (the trace matrix plus a few MB of metadata). */
/** The `history_*` and `run_events_json` entries of an export. */
function historyEntries(h: ExportInput['history']): Record<string, Uint8Array> {
  if (!h) return {};
  const out: Record<string, Uint8Array> = {};
  const series = (h.bins.meta.series as unknown[] | undefined)?.length ?? 0;
  const bands = (h.bins.meta.series as { band_index?: number | null }[] | undefined)?.filter(
    (x) => x.band_index !== null && x.band_index !== undefined,
  ).length;
  for (const l of h.bins.levels) out[`history_L${l.k}.npy`] = npy(l.data, [series, l.n, 4]);
  for (const b of h.bins.bands ?? []) {
    const n = h.bins.levels.find((l) => l.k === b.k)?.n ?? 0;
    out[`history_band_L${b.k}.npy`] = npy(b.data, [bands ?? 0, n, 2]);
  }
  const ev = new TextEncoder().encode(h.eventsJson);
  out['run_events_json.npy'] = npy(ev, [ev.length]);
  return out;
}

export function calaExportBytes(input: ExportInput): number {
  const { result } = input;
  const nnz = result.library.pixels.length;
  return (
    result.frames * result.ids.length * 4 +
    8 * nnz +
    17 * result.frames +
    1000 * result.ids.length +
    (input.history
      ? input.history.bins.levels.reduce((a, l) => a + l.data.byteLength, 0) +
        input.history.eventsJson.length
      : 0) +
    4096
  );
}

/**
 * The self-describing archive (see the file header for the layout), streamed
 * to `sink`.
 */
export async function writeCalaExport(
  input: ExportInput,
  sink: ByteSink,
  options: ExportWriteOptions = {},
): Promise<void> {
  const { result, run, width, height } = input;
  const { ids, library } = result;
  const n = ids.length;
  const range = input.frameRange ?? { start: 0, end: result.frames };
  if (range.start < 0 || range.end > result.frames || range.end <= range.start)
    throw new RangeError(`Frames ${range.start}..${range.end} are not in the result.`);
  const F0 = range.start;
  const T = range.end - range.start;
  if (run.dy.length < range.end)
    throw new RangeError('The motion record is shorter than the traces.');
  const motion = new Float32Array(2 * T);
  for (let t = 0; t < T; t++) {
    motion[2 * t] = run.dy[F0 + t];
    motion[2 * t + 1] = run.dx[F0 + t];
  }
  const seen = new Int32Array(n);
  for (let i = 0; i < n; i++) seen[i] = input.firstSeen(ids[i]) ?? -1;
  const { snr, pass, flags } = qcColumns(ids, input.qc);
  const meta = {
    format: 'cala-export',
    format_version: EXPORT_FORMAT_VERSION,
    app: 'cala',
    app_version: input.version,
    created: input.createdAt ?? new Date().toISOString(),
    recording: input.label,
    frames: T,
    cells: n,
    fov_height: height,
    fov_width: width,
    sampling_rate_hz: input.fps > 0 ? input.fps : null,
    library_version: result.version,
    trace_units:
      'preprocessed grey levels (flicker removed, flattened, background floor subtracted)',
    traces_layout: 'cells x frames, float32 (stored in Fortran order)',
    footprints: 'sparse CSR over flat pixel index row * width + column, unfiltered weights',
    extract_seconds: result.seconds,
    stages: (input.stages ?? []).map(stageMeta),
    ...(input.flatField && input.flatField.length > 0
      ? {
          flat_field: {
            extract: 'every frame divided by the last map of Discover, from frame 0',
            discover_maps: input.flatField.map((a) => ({
              frame: a.frame,
              source: a.source,
              first: a.first,
            })),
          },
        }
      : {}),
    ...(input.history ? { history: input.history.bins.meta } : {}),
    ...(input.session ? { session: input.session } : {}),
    cell_table: cellTable(input),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const small: Record<string, Uint8Array> = {
    'cell_ids.npy': npy(ids, [n]),
    'centroids_yx.npy': npy(library.centers.slice(0, 2 * n), [n, 2]),
    'radii_px.npy': npy(library.radii.slice(0, n), [n]),
    'footprint_starts.npy': npy(library.starts, [library.starts.length]),
    'footprint_pixels.npy': npy(library.pixels, [library.pixels.length]),
    'footprint_values.npy': npy(library.values, [library.values.length]),
    'fov_shape.npy': npy(Int32Array.of(height, width), [2]),
    'motion_shift_yx.npy': npy(motion, [T, 2]),
    'motion_flags.npy': npy(run.flags.slice(F0, F0 + T), [T]),
    'flicker_offset.npy': npy(run.flickerOffset.slice(F0, F0 + T), [T]),
    'flicker_gain.npy': npy(run.flickerGain.slice(F0, F0 + T), [T]),
    'first_seen_frame.npy': npy(seen, [n]),
    'qc_peak_snr.npy': npy(snr, [n]),
    'qc_pass.npy': npy(pass, [n]),
    'qc_flags.npy': npy(flags, [n]),
    'sampling_rate_hz.npy': npy(Float32Array.of(input.fps > 0 ? input.fps : 0), [1]),
    'meta_json.npy': npy(metaBytes, [metaBytes.length]),
    ...historyEntries(input.history),
  };
  const zip = new ZipStreamWriter(sink, { forceZip64: options.forceZip64 });
  await addTraces(zip, 'traces.npy', result.traces, null, options, range);
  for (const [name, bytes] of Object.entries(small)) await zip.addFile(name, bytes);
  await zip.finish();
}

/** `traces.npy` as a Fortran-order (cells, frames) float32 entry streamed from `file`. */
async function addTraces(
  zip: ZipStreamWriter,
  name: string,
  file: TraceFile,
  cols: readonly number[] | null,
  options: ExportWriteOptions,
  range: { start: number; end: number } = { start: 0, end: file.frames },
): Promise<void> {
  const width = cols ? cols.length : file.cells;
  const frames = range.end - range.start;
  const header = writeNpyHeader('<f4', [width, frames], true);
  const total = width * frames * 4;
  let done = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield header;
    for await (const c of traceChunks(
      file,
      cols,
      (b) => {
        done += b;
        options.onProgress?.(done, total);
      },
      range,
    ))
      yield c;
  }
  await zip.addStream(name, header.length + total, chunks());
}

/** The cells a CaDecon export keeps: those that pass QC, or all when QC has not judged any. */
export function cadeconCells(input: ExportInput, passOnly: boolean): number[] {
  const n = input.result.ids.length;
  const all = Array.from({ length: n }, (_, i) => i);
  if (!passOnly) return all;
  const { pass } = qcColumns(input.result.ids, input.qc);
  const kept = all.filter((i) => pass[i] === 1);
  return pass.some((p) => p >= 0) ? kept : all;
}

/** Whether a CaDecon export of `cells` cells is the classic in-memory file (else it streams). */
export function cadeconIsClassic(
  frames: number,
  cells: number,
  limit = CADECON_MEMORY_BYTES,
): boolean {
  return cells * frames * 4 <= limit;
}

/**
 * The traces in the layout CaDecon imports (`.npz`, one cells x timepoints
 * matrix named `traces`, plus the 1-D `cell_ids` and `sampling_rate_hz`).
 * Classic C-order file for ordinary sizes; streamed Fortran-order (and ZIP64
 * when needed) above `CADECON_MEMORY_BYTES`, which CaDecon's importer cannot
 * open (see the file header).
 */
export async function writeCaDeconExport(
  input: ExportInput,
  sink: ByteSink,
  passOnly = true,
  options: ExportWriteOptions = {},
): Promise<void> {
  const { result } = input;
  const T = result.frames;
  const keep = cadeconCells(input, passOnly);
  const ids = new Uint32Array(keep.length);
  keep.forEach((c, k) => (ids[k] = result.ids[c]));
  const zip = new ZipStreamWriter(sink, { forceZip64: options.forceZip64 });
  if (cadeconIsClassic(T, keep.length, options.cadeconMemoryBytes)) {
    // C order, gathered block by block from the frame-major file.
    const traces = new Float32Array(keep.length * T);
    const step = Math.max(1, Math.floor(CHUNK_BYTES / (4 * Math.max(result.cells, 1))));
    for (let f = 0; f < T; f += step) {
      const to = Math.min(T, f + step);
      const block = await result.traces.readFrames(f, to);
      for (let k = 0; k < to - f; k++)
        for (let j = 0; j < keep.length; j++)
          traces[j * T + f + k] = block[k * result.cells + keep[j]];
      options.onProgress?.(to * keep.length * 4, T * keep.length * 4);
    }
    await zip.addFile('traces.npy', npy(traces, [keep.length, T]));
  } else {
    await addTraces(zip, 'traces.npy', result.traces, keep, options);
  }
  await zip.addFile('cell_ids.npy', npy(ids, [keep.length]));
  await zip.addFile(
    'sampling_rate_hz.npy',
    npy(Float32Array.of(input.fps > 0 ? input.fps : 0), [1]),
  );
  await zip.finish();
}

/** A sink that collects everything in memory. */
export function memorySink(): ByteSink & { toArrayBuffer(): ArrayBuffer; readonly size: number } {
  const parts: Uint8Array[] = [];
  let size = 0;
  return {
    write(chunk) {
      parts.push(chunk);
      size += chunk.length;
    },
    get size() {
      return size;
    },
    toArrayBuffer() {
      const out = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out.buffer;
    },
  };
}

/** The archive as one buffer (small runs, tests). */
export async function buildCalaExport(
  input: ExportInput,
  options?: ExportWriteOptions,
): Promise<ArrayBuffer> {
  const sink = memorySink();
  await writeCalaExport(input, sink, options);
  return sink.toArrayBuffer();
}

/** The CaDecon file as one buffer (small runs, tests). */
export async function buildCaDeconExport(
  input: ExportInput,
  passOnly = true,
  options?: ExportWriteOptions,
): Promise<ArrayBuffer> {
  const sink = memorySink();
  await writeCaDeconExport(input, sink, passOnly, options);
  return sink.toArrayBuffer();
}

/** A file name stem from the recording label. */
export function fileStem(label: string): string {
  const s = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'recording';
}

/** Offer `bytes` as a download. */
export function downloadBytes(name: string, bytes: ArrayBuffer): void {
  downloadBlob(name, new Blob([bytes], { type: 'application/octet-stream' }));
}

/** Offer a `Blob` (or a disk-backed `File`) as a download. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The browser has started reading by the next task; revoking earlier can cancel the save.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The File System Access API's save dialog (Chromium), if present. */
interface SaveFilePicker {
  (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<{ createWritable(): Promise<WritableStream & { abort(): Promise<void> }> }>;
}

/** How `saveExport` delivered the file. */
export type SaveMethod = 'picker' | 'opfs-download' | 'memory-download' | 'cancelled';

/** The OPFS file behind the last download, deleted when the next export starts. */
let lastExportFile: string | null = null;

/** Memory-fallback ceiling when the browser has neither a save dialog nor OPFS, bytes. */
const MEMORY_DOWNLOAD_BYTES = 1_000_000_000;

/**
 * Write an export to the user's disk without holding it in memory:
 *
 *   1. File System Access API (`showSaveFilePicker`, Chrome/Edge): the user
 *      picks the file first (this must run inside the click that asked for
 *      it), bytes stream straight into it.
 *   2. Otherwise a file built in OPFS by a worker, then handed to the browser
 *      as a disk-backed `File` download (Firefox, Safari).
 *   3. Otherwise memory, for archives under about 1 GB; larger ones throw an
 *      error telling the user which browsers can do it.
 *
 * `write` receives the sink and produces the archive; `sizeHint` (bytes)
 * guards option 3.
 */
export async function saveExport(
  name: string,
  sizeHint: number,
  write: (sink: ByteSink) => Promise<void>,
): Promise<SaveMethod> {
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: Awaited<ReturnType<SaveFilePicker>>;
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: 'NumPy archive', accept: { 'application/zip': ['.npz'] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
    const writable = await handle.createWritable();
    const w = writable.getWriter();
    try {
      await write({ write: (chunk) => w.write(chunk) });
      await w.close();
    } catch (err) {
      await w.abort().catch(() => {});
      throw err;
    }
    return 'picker';
  }
  if (await opfsUsable()) {
    const client = OpfsWriterClient.shared();
    const file = `cala-export-${Date.now().toString(36)}.npz`;
    // The previous export's file has been handed to the browser by now.
    if (lastExportFile) await client.remove(lastExportFile).catch(() => {});
    lastExportFile = null;
    await client.sweep().catch(() => {});
    await client.open(file);
    let pos = 0;
    try {
      await write({
        async write(chunk) {
          await client.write(file, pos, chunk);
          pos += chunk.length;
        },
      });
      await client.close(file);
    } catch (err) {
      await client.remove(file).catch(() => {});
      if (err instanceof Error && err.name === 'QuotaExceededError') {
        throw new Error(
          'The browser ran out of storage while building the export. Free some disk space and try again.',
          { cause: err },
        );
      }
      throw err;
    }
    lastExportFile = file;
    downloadBlob(name, await client.getFile(file));
    return 'opfs-download';
  }
  if (sizeHint > MEMORY_DOWNLOAD_BYTES) {
    throw new Error(
      'This browser cannot save an export this large. Use Chrome or Edge, or a current Firefox or Safari.',
    );
  }
  const sink = memorySink();
  await write(sink);
  downloadBytes(name, sink.toArrayBuffer());
  return 'memory-download';
}
