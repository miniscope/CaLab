# Cala

A streaming, in-browser pipeline from raw 1-photon Miniscope video to per-cell
footprints and traces (Rust compiled to WebAssembly, WebGPU later). So far it
reads Miniscope AVI folders, plays them back, and runs preprocessing and
motion correction, cell discovery, demixed trace extraction, and online quality control live on the opened recording. The app is hidden from the landing page
(`calab.hidden`) but built at `/CaLab/Cala/`.

```sh
npm run dev cala          # Vite dev server (builds crates/*/pkg first if needed)
npm test -w apps/cala     # Vitest
```

What is here:

- `src/lib/frame-source.ts`: the frame source. Given the files of a Miniscope
  folder it sorts `N.avi` naturally, parses each header from a 64 KB prefix and
  the `idx1` region with the wasm `AviHeader` (`crates/cala/src/avi.rs`), and
  exposes `readFrame(globalIndex)` using `File.slice`; a whole video is never
  loaded. The frame rate comes from `timeStamps.csv`, else `metaData.json`,
  never from the AVI header (real 20 fps files declare 60).
- `src/lib/cala-wasm.ts`: the only importer of `crates/cala/pkg/`.
- `src/workers/frame-worker.ts` + `src/lib/frame-client.ts`: the worker that
  holds the frame source and the promise-based client; frames are transferred.
- `src/lib/viewer-store.ts`, `src/components/`: open-folder screen (directory
  picker, drag and drop), frame canvas, scrubber, play/pause, info panel.
- `src/lib/pipeline-plan.ts`, `src/lib/pipeline-engine.ts`: the streaming
  preprocess + motion pipeline. Three walks over the recording in small
  batches: preprocessing calibration (200 raw frames), motion warm-up template
  (200 preprocessed frames, pushed batch by batch into the corrector), then every frame through the front half of the
  preprocessing (hot pixels, global flicker, glow flattening, line removal), the rigid motion
  corrector (warm-up template, pinned running template) and the back half
  (background floor, noise map). Each batch yields per-frame shifts and
  downsampled previews of its last frame, plus the flicker offset and gain
  removed per frame. Runs in the frame worker, one step
  per request; `src/lib/pipeline-store.ts` keeps at most two requests
  outstanding (backpressure) and only the latest previews.
- `src/workers/slow-worker.ts` + `src/lib/slow-runner.ts`: the slow loop
  (cell discovery). With spare cores (`navigator.hardwareConcurrency` minus 5,
  at most 4; `?visits=N` sets 0 to 4) it only observes frames and hands its tile
  visits to `src/workers/visit-worker.ts` workers, one visit each at a time;
  visits out together never touch the same cells
  (`crates/cala/src/discover/shard.rs`). With none it visits tiles itself.
- `src/components/PipelinePanel.tsx`: raw or preprocessed vs motion-corrected
  (or background-removed) video, progress, throughput, and the live motion
  and flicker traces (`MotionTrace.tsx`, `FlickerTrace.tsx`).
- `src/__tests__/`: frame source tests on synthetic AVIs (`synth-avi.ts`), and
  the app test with a fake frame client. The browser path is in
  `e2e/cala.spec.ts`.
- `scripts/real-data-check.mjs`: local-only check against a real recording
  (not run in CI); also runs the pipeline headless on the first frames
  (`--motion N`, `--motion-only`) and prints shift and flicker statistics and
  throughput (`--flicker-mode 0` turns the flicker stage off, for timing it).

## Pass 2 and export

Pass 1 discovers the footprint library while the recording streams by, and the
traces it emits along the way were solved with whatever library was current at
the time. Pass 2 (`src/lib/pass2-store.ts`) walks the recording again through
the same three workers and solves **every** frame with the **final** library,
so cells found late have traces from frame 0.

- **Recorded in pass 1** (`src/lib/run-record.ts`, 17 bytes per frame, kept in
  full): the rigid shift `(dy, dx)`, the motion flags, and the global flicker
  `(offset, gain)`. Nothing is estimated in pass 2: the frame worker replays the
  recorded flicker (`Preprocessor.frontFramesReplay`), the motion worker warps
  by the recorded shifts (the same WebGPU warp as pass 1 when available), and
  the trace worker solves with the final library
  (`FastLoop` option `initialLibrary`).
- **Background and noise** restart from the calibrated state. Calibration
  depends only on the first frames, so it is recomputed identically, and the
  back half is a deterministic function of the corrected frames in order, so
  replaying from frame 0 rebuilds the state pass 1 had at every frame. No
  checkpoints are needed while the whole recording is replayed.
- **Finish pass 1 now** ends the stream at the frames read so far (the slow
  loop publishes its final library and pass 2 covers those frames). Pass 2 runs
  automatically after pass 1 (checkbox) or with **Run pass 2**, shows progress
  and frames/s, and the UI stays live (the work is in workers).
- Pass 2 holds its traces (frames x cells float32) in memory, capped at 1.5 GB;
  the export is built in the page.

**Export** (`src/lib/export.ts`; both are NumPy `.npz`, stored uncompressed):

- `<folder>_cala.npz`, self-describing: `traces` (cells x frames, float32),
  `cell_ids`, `centroids_yx`, `radii_px`, sparse footprints
  (`footprint_starts` / `footprint_pixels` / `footprint_values`, CSR over the
  flat pixel index `row * W + column`) with `fov_shape`, per-frame
  `motion_shift_yx`, `motion_flags`, `flicker_offset`, `flicker_gain`, per-cell
  `first_seen_frame`, `qc_peak_snr`, `qc_pass` (1 / 0 / -1 not measured),
  `qc_flags`, `sampling_rate_hz`, and `meta_json` (UTF-8 JSON: provenance and the
  cell table). The full layout is the header of `src/lib/export.ts`.
- `<folder>_cala_cadecon.npz`: only `traces` (QC-passing cells by default),
  `cell_ids` and `sampling_rate_hz`. CaDecon's existing `.npz` import takes the
  one cells x timepoints array without asking; it then asks for the sampling
  rate (shown on the button's tooltip).

```python
import json, numpy as np
z = np.load("raw_cala.npz")
traces = z["traces"]                      # (cells, frames)
meta = json.loads(z["meta_json"].tobytes().decode())
```

## Compression (experimental, `?compress`)

With `?compress` in the URL the run also compresses the preprocessed,
motion-corrected frames (the fast loop's input) into low-rank factors per
64 px tile and 600-frame window (`crates/cala/src/compress`, ported from
MiniMe), so past frames can be revisited without the raw video (pass 2 above
re-reads the file; the factors are for a source that has none). When the
recording has been read, the final library is out and every window is
compressed, the traces of the whole recording are solved again from the
factors with that library (back-fill): a cell found late gets its trace from
the first frame on, and the trace viewer shows the back-filled traces.

- `src/lib/compress-feed.ts`: in the fast worker, cuts the stream into windows,
  quantizes each batch in tile order (int16, 1/64 grey level) and transfers it.
  Nothing is dropped, unlike the feed to the slow worker.
- `src/workers/compress-worker.ts` + `src/lib/compress-runner.ts`: writes the
  batches of a window to a file, compresses closed windows tile by tile from
  that file (yielding after every tile so incoming batches are written at
  once), and keeps the factors in `f<window>.bin`.
- `src/lib/window-store.ts`: the files, in the origin private file system
  (`cala-compress/<run>`, removed at the next page load); in memory for tests.
- Back-fill (`CompressRunner.backfill`): reads each factor file back
  (`FactorWindow`), rebuilds 16 frames at a time and solves them with a
  `TraceEngine` on the library the fast worker forwarded; one `traces` message
  per window goes to the main thread, where the first one replaces the live
  trace history (`CellStore.onBackfill`).
- `src/lib/compress-store.ts`: the status bar readout (windows, mean rank,
  ms per frame, MB of factors, windows waiting, the back-fill) and the
  once-per-run back-fill request.
- `scripts/compress-bench.mjs`: local timing of the WASM compressor on a
  window dumped by `discover_eval --compress-dump`.

A window waits on disk (432 MB at 600 x 600) until it is compressed, so a
replay faster than the compressor (about 8 ms per frame) queues windows there.
A short last window keeps fewer components (the rank cut's white-noise test is
stricter on few frames) and costs more per frame, but on the synthetic test
session 200-frame windows gave traces as close to the truth as 600-frame
windows. Back-filled traces match the live ones closely for
cells that pass QC; for low-SNR cells they differ, because the factors drop
most of the noise such a live trace consists of.

## Long-recording display limits

The motion and flicker charts keep the latest 32,768 frames at full resolution
(about 27 minutes at 20 fps), so brief artifacts remain visible without chart
memory and redraw work growing with recording duration. Older chart samples are
discarded; pipeline progress and stage timing averages still cover the entire run.
Per-cell trace history has its own frame and byte budgets in `trace-history.ts`.

The selected-cell trace viewer keeps a fixed-height whole-session min/max
overview, using 512 adaptive buckets per tracked cell (12 KiB per cell, at most
about 36 MiB for 3,000 cells, in addition to the full-resolution trace budget).
Coarsening preserves extrema and their original frame positions; timing within
a bucket is only a coarse summary, and gaps smaller than a bucket may disappear.
The zoom plot reads only full-resolution samples still retained. Older regions
remain navigable through the overview, with no reconstructed detail. Removed
cells release both histories unless the cell is selected; a restarted run clears
them. These summaries are for display, not analysis or export.
