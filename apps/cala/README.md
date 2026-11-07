# Cala

A streaming, in-browser pipeline from raw 1-photon Miniscope video to per-cell
footprints and traces (Rust compiled to WebAssembly, WebGPU later). So far it
reads Miniscope AVI folders, plays them back, and runs preprocessing and
motion correction live on the opened recording (no cell extraction yet). The app is hidden from the landing page
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
  (100 preprocessed frames), then every frame through the front half of the
  preprocessing (hot pixels, glow flattening, line removal), the rigid motion
  corrector (warm-up template, pinned running template) and the back half
  (background floor, noise map). Each batch yields per-frame shifts and
  downsampled previews of its last frame. Runs in the frame worker, one step
  per request; `src/lib/pipeline-store.ts` keeps at most two requests
  outstanding (backpressure) and only the latest previews.
- `src/components/PipelinePanel.tsx`: raw or preprocessed vs motion-corrected
  (or background-removed) video, progress, throughput, and the live motion
  trace.
- `src/__tests__/`: frame source tests on synthetic AVIs (`synth-avi.ts`), and
  the app test with a fake frame client. The browser path is in
  `e2e/cala.spec.ts`.
- `scripts/real-data-check.mjs`: local-only check against a real recording
  (not run in CI); also runs the pipeline headless on the first frames
  (`--motion N`, `--motion-only`) and prints shift statistics and throughput.
