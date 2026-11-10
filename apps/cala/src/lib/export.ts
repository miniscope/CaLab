/**
 * Export of a finished cala run (pass 2): the footprints, the full-length
 * traces and the per-frame motion and flicker, as one self-describing `.npz`
 * (`buildCalaExport`), and the traces alone in the layout CaDecon already
 * imports (`buildCaDeconExport`).
 *
 * Both are plain NumPy archives written with `@calab/io` (`writeNpy`,
 * `zipFiles`, stored uncompressed like `np.savez`), so `np.load` reads them
 * and CaDecon's existing `.npz` import path takes the second one as is: its
 * trace-matrix finder auto-selects a lone cells x timepoints array, so the
 * CaDecon file holds exactly one matrix (`traces`) next to 1-D arrays. CaDecon
 * asks for the sampling rate on import; it is in the file as
 * `sampling_rate_hz` and in the button's tooltip.
 *
 * Format of `calaExport.npz` (N cells, T frames, H x W field of view):
 *
 *   traces              float32 [N, T]   pass-2 traces, one row per cell (preprocessed grey levels)
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
 * QC comes from the last online snapshot of pass 1 (cells added after it are
 * "not measured"); first-seen is the frame count when the library that first
 * held the cell arrived.
 */
import { writeNpy, zipFiles, type NpyWritable } from '@calab/io';
import { verdict, type QcSnapshot } from './qc.ts';
import type { Pass2Result } from './pass2-store.ts';
import { transposeTraces } from './pass2-store.ts';
import type { RunSpan } from './run-record.ts';

export const EXPORT_FORMAT_VERSION = 1;

/** Everything an export is built from. */
export interface ExportInput {
  /** Recording label (the folder name). */
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 or undefined: unknown). */
  fps: number;
  result: Pass2Result;
  /** Pass 1's per-frame motion and flicker (at least `result.frames` long). */
  run: RunSpan;
  /** The last QC snapshot, if any. */
  qc: QcSnapshot | null;
  /** Frame at which a cell was first seen. */
  firstSeen: (id: number) => number | undefined;
  /** App version string. */
  version: string;
  /** ISO timestamp. */
  createdAt?: string;
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

/** The self-describing archive (see the file header for the layout). */
export function buildCalaExport(input: ExportInput): ArrayBuffer {
  const { result, run, width, height } = input;
  const { ids, library } = result;
  const n = ids.length;
  const T = result.frames;
  if (run.dy.length < T) throw new RangeError('The motion record is shorter than the traces.');
  const motion = new Float32Array(2 * T);
  for (let t = 0; t < T; t++) {
    motion[2 * t] = run.dy[t];
    motion[2 * t + 1] = run.dx[t];
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
    traces_layout: 'cells x frames, float32',
    footprints: 'sparse CSR over flat pixel index row * width + column, unfiltered weights',
    pass2_seconds: result.seconds,
    cell_table: cellTable(input),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const files: Record<string, Uint8Array> = {
    'traces.npy': npy(transposeTraces(result.traces, T, n), [n, T]),
    'cell_ids.npy': npy(ids, [n]),
    'centroids_yx.npy': npy(library.centers.slice(0, 2 * n), [n, 2]),
    'radii_px.npy': npy(library.radii.slice(0, n), [n]),
    'footprint_starts.npy': npy(library.starts, [library.starts.length]),
    'footprint_pixels.npy': npy(library.pixels, [library.pixels.length]),
    'footprint_values.npy': npy(library.values, [library.values.length]),
    'fov_shape.npy': npy(Int32Array.of(height, width), [2]),
    'motion_shift_yx.npy': npy(motion, [T, 2]),
    'motion_flags.npy': npy(run.flags.slice(0, T), [T]),
    'flicker_offset.npy': npy(run.flickerOffset.slice(0, T), [T]),
    'flicker_gain.npy': npy(run.flickerGain.slice(0, T), [T]),
    'first_seen_frame.npy': npy(seen, [n]),
    'qc_peak_snr.npy': npy(snr, [n]),
    'qc_pass.npy': npy(pass, [n]),
    'qc_flags.npy': npy(flags, [n]),
    'sampling_rate_hz.npy': npy(Float32Array.of(input.fps > 0 ? input.fps : 0), [1]),
    'meta_json.npy': npy(metaBytes, [metaBytes.length]),
  };
  return zipFiles(files, { level: 0 });
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

/**
 * The traces in the layout CaDecon imports (`.npz`, one cells x timepoints
 * matrix named `traces`, plus the 1-D `cell_ids` and `sampling_rate_hz`).
 */
export function buildCaDeconExport(input: ExportInput, passOnly = true): ArrayBuffer {
  const { result } = input;
  const T = result.frames;
  const keep = cadeconCells(input, passOnly);
  const full = transposeTraces(result.traces, T, result.ids.length);
  const traces = new Float32Array(keep.length * T);
  const ids = new Uint32Array(keep.length);
  keep.forEach((c, k) => {
    traces.set(full.subarray(c * T, (c + 1) * T), k * T);
    ids[k] = result.ids[c];
  });
  return zipFiles(
    {
      'traces.npy': npy(traces, [keep.length, T]),
      'cell_ids.npy': npy(ids, [keep.length]),
      'sampling_rate_hz.npy': npy(Float32Array.of(input.fps > 0 ? input.fps : 0), [1]),
    },
    { level: 0 },
  );
}

/** A file name stem from the recording label. */
export function fileStem(label: string): string {
  const s = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'recording';
}

/** Offer `bytes` as a download. */
export function downloadBytes(name: string, bytes: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The browser has started reading by the next task; revoking earlier can cancel the save.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
