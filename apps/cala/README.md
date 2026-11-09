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
