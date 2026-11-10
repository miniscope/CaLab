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
- Pass 2 streams its traces (frames x cells float32, frame-major) into a file in
  the browser's origin private file system (OPFS) as it runs, so memory stays at
  a few batches whatever the recording length; the limit is browser storage
  quota (checked up front, with a clear error). Old files are swept when a new
  run starts. Without OPFS the matrix is held in memory, capped at 1.5 GB.
  Multi-day recordings are fine: the main-thread histories are bounded, the
  per-cell trace history splits its 256 MB evenly across all cells, the frame
  source reads one batch ahead (helps network drives), and opening a folder of
  thousands of AVIs reads headers 16 at a time.

**Export** (`src/lib/export.ts`; both are NumPy `.npz`, stored uncompressed,
written as a stream so nothing the size of the traces is held in memory; ZIP64
records are written for entries of 4 GiB or more). Chrome and Edge ask where to
save the file (File System Access API) and write straight into it; Firefox and
Safari build the file in OPFS and hand it to the download (disk-backed, no RAM).
`traces` is stored in Fortran order (column per frame, the same bytes as the
pass-2 file, no transpose): `np.load` still returns the (cells, frames) array.

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
  rate (shown on the button's tooltip). Up to 512 MB of traces it is the classic
  C-order, non-ZIP64 file. Beyond that it is streamed like the main export, and
  CaDecon's importer (1 GiB limit, no ZIP64) cannot open it: for very long
  recordings use `np.load` on the cala `.npz`, or export fewer cells.

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

## Live source (experimental)

Cala's target is a recording in progress: frames arriving from the
acquisition board while the mouse is on the wheel, analysed as they come. A
live run has no frame count, no random access and no file to re-read, so the
pipeline runs on an unbounded stream and the compression above becomes the
only record of the past.

**Transport.** The app takes frames pushed over a WebSocket by whatever is
acquiring (`src/lib/live-source.ts`): a text `hello` with the geometry and
frame rate, then one binary message per frame (16-byte header with the
acquisition-side frame index and a timestamp, then the raw pixels), then
`end`. Server push over a socket is the shape of the real target (a board
streaming into the browser; a Miniscope DAQ writing AVIs could be tailed, but
that is a file source with a delay, and it would couple the app to the DAQ's
file format, which is left as is). The socket lives in the frame worker, so
frames go straight into the pipeline; steps wait for frames instead of
reading them, which is the only backpressure a live source has. For now the
acquisition side is simulated: `scripts/live-sim.mjs` streams a Miniscope AVI
folder at its frame rate over that protocol (`--fps`, `--drop i,j` to skip
frames, `--buffer` to drop when the client is not reading).

```sh
node apps/cala/scripts/live-sim.mjs ~/data/session/raw      # ws://localhost:8765
# then open the app on it: the "stream from a live source" field, or
#   http://localhost:5173/?live=ws://localhost:8765&compress
```

What changes in a live run:

- The plan is unbounded (`UNBOUNDED` in `pipeline-plan.ts`): the warm-ups
  are the same 200 + 200 frames, then batches until the stream ends, which
  bounds the plan at the frames received (also when it ends during a
  warm-up). The source keeps the first frames for the warm-ups' re-reads and
  releases them once the processing walk is past them; after that it is a
  queue (256 MB, 35 s at 600 x 600 and 20 fps) that drops the newest frames
  when the pipeline falls that far behind. Frames are indexed by arrival: a
  frame the source never sent, or one dropped here, is counted (the status
  bar shows received, dropped, missed at the source, and the fast loop's lag
  behind the stream in frames and ms) and the next frame follows, so windows,
  traces and the motion record stay contiguous.
- No progress bar, no total, no raw-file tab. "Stop the live run" ends the
  stream at the frames received (the slow loop publishes its final library,
  the compression closes its last window, the back-fill runs); "Restart"
  connects again, and the source streams from wherever it is then. Pass 2
  cannot run (nothing to re-read); the export takes the back-filled traces.
- With `?compress` (recommended for a live run) the back-fill also runs
  during the run: whenever a newer library is out, at least one window is
  compressed and none is waiting, at most once per 30 s
  (`?backfill=<seconds>`, 0 turns it off) and never within twice the last
  back-fill's duration, so it takes at most a third of the compress worker.
  A back-fill solves 16 frames at a time and yields between steps; a window
  that closes meanwhile is compressed before the next step, so incoming
  frames are never held up. Its traces replace those frames in the trace
  history (`TraceHistory.replace`: a late cell is extended backwards; frames
  after the last compressed window keep their live traces), so a cell found
  late shows its earlier trace within a window or two.

### Measured: the synthetic 5-min session streamed at 20 fps

`scripts/live-measure.mjs` drives both runs headless (Playwright Chromium,
`--enable-unsafe-webgpu`) and scores the exports against the session's truth
with `scripts/score_cala_export.py` (`minime.score.score_run`). Session:
`synth_grin_5min`, 6,000 frames of 600 x 600 at 20 fps, 461 true cells of
which 290 are detectable. Apple silicon laptop, headless Chromium with WebGPU.

Both runs on the same laptop, motion correction on WebGPU in both (headless
Chromium's WebGPU is slower than the desktop app's: the file run processed
45 frames/s here against 175-215 in the app itself). The live run is paced
by the stream, so its throughput is 20 frames/s by construction.

|                                                                 | live (`?live=...&compress`)                                                                                                                                       | file (pass 1 + pass 2)                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| frames received / processed / dropped (queue) / missed (source) | 6,000 / 6,000 / 0 / 0                                                                                                                                             | 6,000 read                                   |
| frames forwarded to the slow loop / dropped there               | 5,952 / 0 (the first 48 precede its start)                                                                                                                        | 5,952 / 0                                    |
| frames compressed (windows)                                     | 6,000 (10 x 600)                                                                                                                                                  | -                                            |
| wall time                                                       | 324 s (300 s of stream, 23 s final back-fill)                                                                                                                     | 143 s pass 1 + 55 s pass 2                   |
| fast loop behind the stream                                     | steady state 0 frames (p99 0, max 6), a batch solved 36 ms (p99 45 ms) after its last frame; the processing walk starts 218 frames behind and catches up in 9.7 s | -                                            |
| slow loop behind the fast loop (frames)                         | mean 8.2, p99 8, max 56                                                                                                                                           | mean 8.2, p99 8, max 56                      |
| slow loop behind the stream (frames)                            | 8 frames in the steady state (one batch), 226-281 during the catch-up                                                                                             | -                                            |
| windows waiting on disk                                         | never (compression 8-14 ms/frame, a window every 30 s)                                                                                                            | -                                            |
| back-fills during the run                                       | 8, one every 31 s: 600 frames in 1.3 s up to 4,800 in 10 s (2.0-2.4 ms/frame; 20 s when a window closed during one and was compressed in between)                 | -                                            |
| final back-fill                                                 | 6,000 x 284 in 23 s wall (14 s solving, 2.3 ms/frame)                                                                                                             | pass 2: 6,000 x 280 in 54.5 s (110 frames/s) |
| cells (final library)                                           | 284 (a second run: 291)                                                                                                                                           | 280                                          |
| recall / precision / F1 against the truth                       | 0.488 / 0.792 / 0.604 (second run 0.501 / 0.794 / 0.614)                                                                                                          | 0.505 / 0.832 / 0.629                        |
| recall of detectable cells                                      | 0.655 (0.666)                                                                                                                                                     | 0.666                                        |
| trace correlation with the truth, median (q25)                  | 0.978 (0.931)                                                                                                                                                     | 0.970 (0.900)                                |

For reference, MiniMe itself (offline, CNMF) scores this session at recall
0.477, precision 0.936, trace correlation 0.922 with 235 units. The
back-filled traces of the live run and pass 2's traces of the file run score
the same within the run-to-run spread of the slow loop (its visits are
timed, so two runs never find exactly the same library).

The lag numbers hide one structural step: the pipeline's three walks mean
the processing walk starts when the warm-ups are done, about 200 frames
(10 s) behind the stream, and catches up at the pipeline's spare rate
(218 frames in 9.7 s here, about 42 frames/s against the 20 fps stream).
Everything after that is the steady state, where a batch is solved 36 ms
(p99 45 ms) after its last frame arrived (the 8-frame batch itself is 400 ms
of stream).

Limitations found:

- The periodic back-fill solves every compressed frame again each time, so
  its cost grows with the recording (1.3 s for one window, 10 s for eight,
  23 s for the whole 5 min); the "twice the last duration" rule keeps it
  under a third of the compress worker but on a one-hour recording a
  back-fill takes about three minutes and runs every six. An incremental back-fill (only the windows a library change touches)
  is the next step.
- The frames of the open window (up to 30 s) and those that arrive during a
  back-fill keep their live traces until the next back-fill or the final
  one; the final one covers everything.
- OPFS holds one uncompressed window (432 MB at 600 x 600) plus the factors
  (about 5 MB per window here: 10 MB/min, 600 MB/h). A long run is bounded
  by the browser's storage quota for the factors, and by the trace history
  budgets (`trace-history.ts`) and the back-fill result cap (1.5 GB) in
  memory.
- The simulator does not model the DAQ's own frame drops beyond `--drop`;
  with a real board, the arrival-indexed stream means a dropped frame shifts
  the trace timeline by one sample at that point (it is counted and shown,
  not interpolated).
- The queue drops the newest frames when the pipeline falls 35 s behind; it
  never did here (queue max 345 frames during the warm-up catch-up), but a
  pipeline slower than the stream (a CPU-only motion stage on a slow
  machine) would lose frames rather than memory.

## Long-recording display limits

The motion and flicker charts keep the latest 32,768 frames at full resolution
(about 27 minutes at 20 fps), so brief artifacts remain visible without chart
memory and redraw work growing with recording duration. Older chart samples are
discarded; pipeline progress and stage timing averages still cover the entire run.
Per-cell trace history (`trace-history.ts`) splits one byte budget evenly across
all tracked cells (a ring per cell, re-split as the library grows), so cells
found late in a long run get as long a trace as early ones.

The selected-cell trace viewer keeps a fixed-height whole-session min/max
overview, using 512 adaptive buckets per tracked cell (12 KiB per cell, at most
about 48 MiB for 4,000 cells, in addition to the full-resolution trace budget).
Coarsening preserves extrema and their original frame positions; timing within
a bucket is only a coarse summary, and gaps smaller than a bucket may disappear.
The zoom plot reads only full-resolution samples still retained. Older regions
remain navigable through the overview, with no reconstructed detail. Removed
cells release both histories unless the cell is selected; a restarted run clears
them. These summaries are for display, not analysis or export.
