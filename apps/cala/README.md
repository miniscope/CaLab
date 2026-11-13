# Cala

A streaming, in-browser pipeline from raw 1-photon Miniscope video to per-cell
footprints and traces (Rust compiled to WebAssembly, with WebGPU motion correction where available). So far it
reads Miniscope AVI folders, plays them back, and runs preprocessing and
motion correction, cell discovery, demixed trace extraction, and online quality control live on the opened recording. The app is a beta (`calab.status`),
listed on the landing page and built at `/CaLab/Cala/`. For using it, see the [user guide](USER_GUIDE.md).

```sh
npm run dev cala          # Vite dev server (builds crates/*/pkg first if needed)
npm test -w apps/cala     # Vitest
```

What is here:

- `src/lib/frame-source.ts`: the frame source. Given the files of a Miniscope
  folder it finds the numbered `.avi` series (`0.avi` or `msCam0.avi`, optionally
  zero-padded; `src/lib/video-series.ts` groups, ranks and sorts them), parses each header from a 64 KB prefix and
  the `idx1` region with the wasm `AviHeader` (`crates/cala/src/avi.rs`), and
  exposes `readFrame(globalIndex)` using `File.slice`; a whole video is never
  loaded. The frame rate comes from `timeStamps.csv`, else `metaData.json`,
  never from the AVI header (real 20 fps files declare 60).
- `src/lib/cala-wasm.ts`: the only importer of `crates/cala/pkg/`.
- `src/workers/frame-worker.ts` + `src/lib/frame-client.ts`: the worker that
  holds the frame source and the promise-based client; frames are transferred.
- `src/lib/viewer-store.ts`, `src/components/`: open-folder screen (directory
  picker, drag and drop; `lib/directory-picker.ts` uses `showDirectoryPicker` in read
  mode where it exists, else the `webkitdirectory` input), frame canvas, scrubber, play/pause, info panel.
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
  It runs with the library's `SlowLoopConfig` defaults; a footprint's support
  is the significant single-peaked basin around its peak plus a measured skirt
  (`SupportRule::BasinSkirt`, see `tools/cala-eval/README.md`), and the
  statistics path refines a footprint only when the change exceeds the
  estimate's own split-half noise (`RefineGate::SplitHalf`). Two cells whose
  footprints overlap less than half merge only when the held-out test accepts
  the merge and their measured shapes agree within their own split-half noise
  (`MergeRule::SplitHalf`).
- `src/components/FovPanel.tsx`: the field of view, one image (raw,
  preprocessed, motion-corrected, background-removed or the model residual)
  with zoom, pan, a minimap and the cell overlay (contours or full-extent
  footprints, `lib/cell-overlay.ts`; zoom math in `lib/fov-layout.ts` and
  `lib/fov-view.ts`). The right-hand column (`SidePanel.tsx`): `RunPanel.tsx`
  (pass progress and convergence metrics on one time axis, run controls,
  export), `CellsPanel.tsx` (the selected cell) and `DetailsTabs.tsx` (the
  detail tabs, including the live motion and flicker traces, `MotionTrace.tsx`
  and `FlickerTrace.tsx`).
- `src/__tests__/`: frame source tests on synthetic AVIs (`synth-avi.ts`), and
  the app test with a fake frame client. The browser path is in
  `e2e/cala.spec.ts`.
- `scripts/real-data-check.mjs`: local-only check against a real recording
  (not run in CI); also runs the pipeline headless on the first frames
  (`--motion N`, `--motion-only`) and prints shift and flicker statistics and
  throughput (`--flicker-mode 0` turns the flicker stage off, for timing it).

## Sensor flat field (on by default)

Sensor pixel gain (about 5% SD, fixed to the sensor) rides over the tissue as
registration moves it, and motion-correlated traces pick it up as footprint
texture. The pipelined path divides it out of the raw frames, with a gain map
estimated from the recording's own motion dither (`FlatFieldEstimator`, crates/cala):

- **Off the frame path.** Stage A (frame worker) keeps one copy of each process
  batch's raw frames until stage B returns that batch's shifts (a `shifts`
  message up the A<-B link), then transfers raw + shifts to
  `src/workers/flat-field-worker.ts`. At most four batches wait there; beyond
  that stage A drops frames for the estimator, it never waits. The worker pushes
  frames and, when due (first map after 150 s of frames, then every 60 s), runs
  the expensive `refine()` and posts the map to stage A and to the main thread.
- **Applied at batch boundaries.** Stage A calls `Preprocessor.setFlatField`
  before the next batch's front half, never mid-batch. The first map is a
  one-time switch from uncorrected to corrected frames; its frame is in the run
  record (`RunRecord.flatFieldApplied`), the status panel, and the export's
  `meta_json` (`flat_field`). Later refinements are small and applied as they come.
  The motion template and the calibration come from the first frames, so they
  are built before any estimated map exists (a stored map is applied before the
  motion warm-up, so then the template is built on corrected frames).
- **Per-device cache** (`src/lib/flat-field-cache.ts`, IndexedDB `cala-flatfield`):
  written at most once a minute and at the run end, read at run start; a map of
  another frame size is never reused. The key is a device serial from
  `metaData.json` / the live hello when there is one (`serial`, `serialNumber`,
  ...), else the live source name, else the recording folder name. Miniscope
  `metaData.json` has no serial (`deviceID` is a camera index), so folders are
  keyed by name. See `flatFieldKey` in `src/lib/flat-field.ts`.
- **Refine and Extract** apply Discover's newest map from frame 0 and estimate nothing.
- **Single-worker `PipelineEngine`** (`?pipeline=0`) has no flat field: estimating
  there would put the solve on the frame path.
- The Flat field tab shows the gain map at a fixed 0.9 to 1.1 range (no
  auto-contrast), the status, the last update's change, and the on/off setting
  (`PipelineOptions.flatField`, applied at the next start of Discover).

## Run stages and export

A run has named stages (design note: [docs/stages.md](docs/stages.md)):
**Discover** builds the footprint library while the recording streams by;
**Refine** (recordings only, repeatable; `src/lib/refine-store.ts`) replays
the recording into the same slow loop with the refine-only edit scope; and
**Extract** (recordings only; `src/lib/pass2-store.ts`, the older name) solves
the final traces. Discover's traces were solved with whatever library was
current at the time. Extract walks the recording again through the same three
workers and solves **every** frame with the **final** library, so cells found
late have traces from frame 0.

- **Recorded during Discover** (`src/lib/run-record.ts`, 17 bytes per frame, kept in
  full): the rigid shift `(dy, dx)`, the motion flags, and the global flicker
  `(offset, gain)`. Nothing is estimated in a replay: the frame worker replays the
  recorded flicker (`Preprocessor.frontFramesReplay`), the motion worker warps
  by the recorded shifts (the same WebGPU warp as Discover when available), and
  the trace worker solves with the final library
  (`FastLoop` option `initialLibrary`).
- **Background and noise** restart from the calibrated state. Calibration
  depends only on the first frames, so it is recomputed identically, and the
  back half is a deterministic function of the corrected frames in order, so
  replaying from frame 0 rebuilds the state Discover had at every frame. No
  checkpoints are needed while the whole recording is replayed.
- **End Discover** ends the stream at the frames read so far (the slow
  loop publishes its final library and Refine and Extract cover those frames).
  Extract runs automatically after Discover (checkbox; not after a Refine run)
  or with **Extract**, shows progress and frames/s, and the UI stays live (the
  work is in workers).
- Extract streams its traces (frames x cells float32, frame-major) into a file in
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
Extract's file, no transpose): `np.load` still returns the (cells, frames) array.
`meta_json.stages` lists the stages that ran, with counts and timestamps.

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

## Animal projects

An animal folder of sessions as one project (design and index schema:
[docs/projects.md](docs/projects.md)). **Open animal project** scans the sessions
(`discoverSessions`), probes them, and reads `cala-results/cala-project.json`
(`lib/project-index.ts`: validated, schema version 1) or rebuilds it from the run
folders (every `cala-run.json` and `cala-session.json`, including #377 trees). The
session table (`components/ProjectView.tsx`) shows each session's stage status, shared
cell ids (`id_space`) and current result. Selected rows go into a run plan
(`lib/run-plan.ts`) of Joint chains and Separate sets that `lib/project-store.ts` runs
group by group through `lib/multi-run.ts`, writing each to `cala-results/runs/<id>/`
and updating the index from `MultiRunPlan.onProgress` as sessions finish. Recent
projects keep directory handles in IndexedDB (`lib/recent-projects.ts`). An experiment
folder of several animals is offered as one project per animal (`suggestSplit`).

## Multi-session runs

Several sessions of one animal in one run (design: [docs/stages.md](docs/stages.md),
"Sessions"). Picking a parent folder finds every numbered series at any depth
and groups them into kinds (`src/lib/sessions.ts`: prefix, or device folder
name for V4); the Miniscope kind's series are the sessions, behaviour cameras
are dropped, and an unclear kind asks the user. The session list
(`components/SessionSetup.tsx`, `lib/session-list.ts`) probes each session in
the frame worker (`probe`), orders them by `recordingStartTime` (else path) and
validates size and bit depth (error) and frame rate (warning).

- **Joint:** `FrameSource.openSessions` concatenates the sessions;
  `info.sessions` holds each session's span. One Discover, Refine and Extract;
  the export is cut per session (`ExportInput.frameRange`).
- **Separate:** each session is opened alone and run in turn.
- `lib/multi-run.ts` drives the run (`nextAutoAction` in `lib/session-run.ts`)
  and writes the results (`lib/session-export.ts`): `cala-results/<session
path>/cala-export.npz` and `cala-session.json`, plus `cala-results/cala-run.json`,
  through the File System Access API (`readwrite` on the picked folder), or as
  one zip elsewhere. An existing `cala-results` is never overwritten.
- Boundaries: `onSessionBoundary` in `lib/session-boundary.ts` is called by both
  engines and does nothing yet; `session` events go to the run's event log.

## Live source (experimental)

Cala's target is a recording in progress: frames arriving from the
acquisition board while the mouse is on the wheel, analysed as they come. A
live run has no frame count, no random access and no file to re-read, so the
pipeline runs on an unbounded stream.

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
acquisition side is simulated: `scripts/live-sim.mjs` (`npm run sim-stream`)
streams a recording over that protocol, as the board would push it.

```sh
npm run sim-stream -- ~/data/session/raw              # a Miniscope AVI folder
npm run sim-stream -- $SIM_MOTION_S5 --fps 30 --loop  # a minisim recording
# prints ws://localhost:8765; paste it into the start page's live-source
# field, or open the app on  ?live=ws://localhost:8765
```

The path is a Miniscope AVI folder (AVIs with `metaData.json` and
`timeStamps.csv`) or a minisim recording: the sim directory, its `daq/` or its
`daq/Miniscope/`. Options: `--fps` (default: the recording's metadata, else
20), `--start N` (first recording frame), `--frames N` (stop after N), `--loop`
(wrap from the last frame to the first until stopped; the frame index the app
sees keeps counting), `--port` (default 8765), `--drop i,j` (skip those frames,
as a camera drop would) and `--buffer N` (drop frames when the client is not
reading). Frames are paced on a fixed schedule, and every connection gets the
recording from its start. The framing lives in `src/lib/live-sim-protocol.ts`
(unit-tested), the receiving side in `src/lib/live-source.ts`.

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
  behind the stream in frames and ms) and the next frame follows, so traces
  and the motion record stay contiguous.
- No progress bar, no total, no raw-file tab. "Stop the live run" ends the
  stream at the frames received (the slow loop publishes its final library);
  "Restart" connects again, and the source streams from wherever it is then.
- A live stream runs Discover only: Refine and Extract cannot run (nothing to
  re-read; save the stream and load it as a recording later), so a live run has no record of the
  past beyond the traces the fast loop solved as the frames came in. The
  export (`src/lib/live-export.ts`) takes those: the cells of the final
  library over every frame, NaN before a cell was found and for frames the
  bounded trace history no longer holds. A live run does not re-extract old
  traces; the raw video saved by the acquisition is re-read downstream.

### Measured: the synthetic 5-min session streamed at 20 fps

`scripts/live-measure.mjs` drives a live run and a file run headless
(Playwright Chromium, `--enable-unsafe-webgpu`). Session: `synth_grin_5min`,
6,000 frames of 600 x 600 at 20 fps. Apple silicon laptop, headless Chromium
with WebGPU motion correction (slower than the desktop app's: the file run
processed 24 frames/s here against 175-215 in the app itself). The
live run is paced by the stream, so its throughput is 20 frames/s by
construction.

|                                                                 | live                                                                                                                                                               | file (Discover + Extract)     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| frames received / processed / dropped (queue) / missed (source) | 6,000 / 6,000 / 0 / 0                                                                                                                                              | 6,000 read                    |
| frames forwarded to the slow loop / dropped there               | 5,952 / 0 (the first 48 precede its start)                                                                                                                         | 5,952 / 0                     |
| wall time                                                       | 301 s (300 s of stream)                                                                                                                                            | 249 s Discover + 79 s Extract |
| fast loop behind the stream                                     | steady state 0 frames (p99 0, max 6), a batch solved 38 ms (p99 53 ms) after its last frame; the processing walk starts 218 frames behind and catches up in 10.3 s | -                             |
| slow loop behind the fast loop (frames)                         | mean 8.2, p99 8, max 56                                                                                                                                            | mean 8.2, p99 8, max 56       |
| cells (final library)                                           | 290                                                                                                                                                                | 286                           |

The lag numbers hide one structural step: the pipeline's three walks mean
the processing walk starts when the warm-ups are done, about 200 frames
(10 s) behind the stream, and catches up at the pipeline's spare rate
(218 frames in 10.3 s here, about 41 frames/s against the 20 fps stream). Everything after that is the steady state, where a batch is
solved 38 ms (p99 53 ms) after its last frame arrived (the 8-frame batch itself is
400 ms of stream). The queue drops the newest frames when the pipeline falls
35 s behind; it never did here (queue max 335 frames, during the
catch-up), but a pipeline slower than the stream (a CPU-only motion stage on
a slow machine) would lose frames rather than memory. The simulator does not
model the DAQ's own frame drops beyond `--drop`; with a real board, the
arrival-indexed stream means a dropped frame shifts the trace timeline by one
sample at that point (it is counted and shown, not interpolated).

## Compression (experimental, `?compress`)

With `?compress` in the URL the run also compresses the preprocessed,
motion-corrected frames (the fast loop's input) into low-rank factors per
64 px tile and 600-frame window (`crates/cala/src/compress`, ported from
MiniMe), so past frames can be revisited without the raw video (Extract above
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

### History review (`?compress&review`)

With `&review` as well (`review=N`: every N windows, default 8), the run looks
through its compressed history for cells the slow loop missed
(`crates/cala/src/compress/review.rs`; not the History tab, which plots a
run's metrics). It needs `?compress` and is off without it.

- `src/lib/compress-runner.ts`: after compressing a window, sends its factor
  file to the review worker and, every N windows, the newest library with the
  request to review.
- `src/workers/review-worker.ts` + `src/lib/review-runner.ts`: keep the factors
  of every window in memory (`HistoryReview`) and scan them a few grid rows at
  a time. One review at a time: one that comes due meanwhile is skipped. A
  review takes seconds to minutes, which is why it has a worker to itself;
  one core is left free for it when the visit workers are counted.
- `src/lib/review-store.ts`: passes the candidates to the slow worker
  (`SlowClient.addReviewed`) and makes the Run panel's readout (reviews,
  candidates, cells added, seconds of the last review).
- `src/lib/slow-runner.ts`: adds the candidates (`SlowLoop.addReviewed`, on
  probation like any add) once no tile visit is out.

Beyond 3 GB of factors the review worker drops its oldest windows.

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
