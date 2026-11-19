# cala factor pipeline, phase 4.2: Refine on the factors in the app, and live streams

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind `?refine=factors` the app refines the footprints on the run's factor files, one WASM call per iteration until they settle or a cap, and a live stream, once it has ended and its last window is compressed, offers Extract (and, behind the same switch, Refine) on Discover's own factors, said to be Discover's own and not claimed to meet the closeness gate.

**Architecture:** The slow worker, which owns the `SlowLoop`, runs the iterations: `SlowLoop.refineOnFactors(reader, ...)` takes a duck-typed JS reader whose `read(w)` returns one window's whole factor file, and the slow worker opens the files itself (synchronous OPFS access handles through `pinned`, never creating, never sweeping) only when the main thread says so: the factors are `ready`, no Extract job reads them, no other stage runs, and a new Discover waits until the files are closed again. A file without factors gets a replay that only compresses first. A live run's factors are Discover's windows (on the offset grids, plain with `?review`); its Extract is the existing Extract on factors in the compress worker, started by the user, and its result replaces the live traces in the export only then.

**Tech Stack:** Rust (crate `calab-cala`, wasm-bindgen 0.2.130), TypeScript with Solid and vitest (`apps/cala`), Playwright (`e2e/`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`: §3 "Factor store" (a live stream uses the factors of Discover), §5 "Refine on factors" (the iteration, the settle stop, the cap), §6 "Stages and UI" (Refine until settled, the readout per iteration, streaming: Refine and Extract once the stream has ended, the export's `source`), Amendment 1 (A1 the gate, A4 live streams), Amendment 2 (A11 the phase row and its gate: an e2e run on a file and on a simulated stream), Amendment 3 (A14 `min_valid`, A15 Refine on factors and the WL24 recordings). Plans: `docs/superpowers/plans/2026-11-19-cala-factor-phase4.md` (its decisions 4, 5 and 7, its design notes "Refine on factors in the app (4.2)", its task list "Phase 4.2" and its "Execution notes, phase 4.1"). Results: `tools/cala-eval/results/2026-11-19-factor-phase3.md`, `tools/cala-eval/results/2026-11-19-factor-phase4a.md`.

## Decided for the owner's review

Made while planning, from the code as it is on `feat/cala-factor-live-refine` (5d0f94b0). Each says what would change it.

1. **The slow worker runs an iteration and opens the factor files itself; the main thread sequences who holds them.** The `SlowLoop` (reservoir, statistics, tile bases, published versions) lives in the slow worker and nothing serializes it; an iteration needs nothing else (no frames, no visit workers). An OPFS file with an open synchronous access handle is locked to one context, the compress worker clears its whole folder at every `init` (`CompressRunner.clear`, which ignores a failed remove), and its Extract jobs and the back-fill open the same `f<i>.bin` files one at a time. The rule the main thread enforces: the slow worker gets `refine-factors` only when (a) `factors(frames) === 'ready'` (the compress loop has ended: `final` and nothing pending, so the compress worker holds no file), (b) `CompressStore.jobsOut() === 0` (a cancelled factor Extract runs on in the compress worker until it answers), (c) no other stage runs (`stageAvailability`: Refine is `running` until the slow worker's `factor-end`, a cancel turns it `finishing`, not idle), and (d) a new Discover start (Restart, another folder or stream, the next session) awaits `RefineStore.release()` before its workers start (`PipelineStartHooks.beforeStart`), so the next `init` never meets an open file. The back-fill never reads ready factors (a file's back-fill is of Discover's windows and is cleared by the replay's `init`; a live run's is never asked for, 4.1). The reader is opened by `openFactorReader(run, names)`: `getDirectoryHandle`/`getFileHandle` without `create`, each awaited call through `pinned`, no listing, no removal; the run folder's name is chosen on the main thread (`newRunFolder`) and sent to the compress worker in its `connect` (`run`), so both workers know it. Changes if Chrome's read-only sync access handles (`mode: 'read-only'`) can be relied on in every browser the app supports (readers could then share the files), or if phase 5 finds the wait at a restart during an iteration too long.
2. **The binding is an imported duck-typed reader, one iteration per call.** `#[wasm_bindgen] extern "C" { pub type FactorReader; windows getter; read(w) -> Result<Vec<u8>, JsValue> (catch) }` and `SlowLoop.refineOnFactors(reader, settleCorr, settleShare, testFrames)`. The crate has no `extern "C"` import today and no `js_sys`, so a JS callback (`js_sys::Function`) would add a dependency; wasm-bindgen 0.2.130 implements `FromWasmAbi` for `Vec<T>` (checked in its `src/convert/slices.rs`), so an imported method may return `Vec<u8>`. Passing the bytes window by window from a JS-driven loop was rejected: `refine_on_factors` reads every window twice per iteration in its own order (`sum_pass`, then `test_frames`), so a JS-driven loop would need both passes rewritten as per-window steps. The Rust side wraps the reader in a pure-Rust `ByteSource<B: WindowBytes>`: a thrown error, a missing or corrupt file are `TraceError`s (and `WindowFactors::from_bytes` returns `None` for truncated, trailing or hostile bytes), never a panic; an iteration runs `refine_until_settled` with a cap of 1 (`refine_one`), as `qc_eval --refine-engine factors` does, so the library's own refusals, its `finalize` before and after and its stop rule apply. Changes if a cancel inside an iteration is needed (then the per-window loop).
3. **A live run's factors are ready** when its compress status is Discover's (`source: 'discover'`), the stream has ended and every window is compressed (`final`, `pending === 0`), and the windows hold every recorded frame (`frames === pipeline.record().frames`), on either tiling. The stream's last window is closed at the end (`CompressFeed.end`) and compressed when it has at least 2 frames; a last window of 1 frame is removed (`CompressRunner.compress`, `job.frames < 2`), so a stream of `600 k + 1` frames has factors that miss its last frame: they are `unusable`, Extract and Refine on them are not offered, the Run panel says why ("The factors do not cover the stream (a last window of one frame is not compressed). The export keeps the live traces.") and the export keeps the live traces. A live stream's frame indices are contiguous (dropped frames take no index, `LiveSource`), so no window is skipped in the middle. Extract never writes a trace file with frames missing: the frame check is in `factorState`, and `Pass2Store.runOnFactors` already ends with an error when the windows leave a gap. Changes if the owner wants the last frame folded into the previous window (a change to the feed and the window format).
4. **A live stream's Discover compresses on the offset grids; with `?review` it keeps plain tiles; a file's Discover stays on plain tiles.** Phase 4a measured live factors on the offset grids (A12 records that A7 kept the app's live factors on plain tiles until phase 4); the history review reads plain tiles only (`CompressRunner.reviewOf`), so `?review` keeps them. Main's look-back is not touched: it is offered for recordings on disk only (`App.tsx`, "Look-back needs a recording on disk") and its worker re-reads the raw file, never the factor files (`lookback-*.ts` import nothing of the compression). Cost: phase 1 measured 24.25 ms per frame at 600 px on the offset grids in Chrome, half of the 50 ms interval at 20 fps, on file recordings (phase 4 plan, "Not in this phase"); windows the compressor has not reached wait on disk, and Extract waits for them after the stream ends. Changes if phase 5 shows a 600 px stream falling behind for good, or when 4.3 makes the review read the offset grids.
5. **What a factor Refine does to the other stages.** It changes the library only, never the factors: they stay `ready` and serve every later Extract. It does not touch `factorsFailed` (only `Pass2Store.clear` resets it, as in 4.1). The replay that only compresses takes the compress mark through `replayCompress` like any first replay and releases it when cut short (`endOnce`). A raw Refine after a factor Refine reads the file without compressing (the factors are ready, `NO_COMPRESS`); a factor Refine after a raw Refine continues from that library (the factor statistics replace the loop's, `install`; a raw frame after an iteration enters at weight 1, Rust test `a_raw_frame_after_an_iteration_enters_at_the_installed_weight`). A factor Refine that fails (a refused or failed iteration, factors that turn out unusable) makes a file run's next Refine replay the file until a new Discover (`factorFailed`, as 4.1's `factorsFailed` does for Extract), so a deterministic failure is no dead end; a live run has no file and reads the factors again. After a look-back Discover, Refine replays the file: that slow loop runs the cluster replay (`LOOKBACK.jointUpdate: 'all'`), which `refine_on_factors` refuses until phase 3b. No QC is recomputed after a factor Refine (it has no traces; Extract recomputes it). Changes if phase 3b passes (then look-back runs may refine on factors).
6. **The settle rule in the app is the spec's and the harness's: `settleCorr` 0.99, `settleShare` 0.02, `maxIterations` 20, `testFrames` 0** (0: a tile's reservoir share, `frames_per_tile / holdout_every`), as `FACTOR_REFINE`. Per iteration the Run panel shows the iteration, the refinements accepted, the share of cells still changing against the stop share and the median change; at the cap it says "stopped at the cap of 20 iterations without settling" with the share still changing, and the stage record says `stop: "cap"`. Phase 3a reached the cap on real data (`wl24_01`: 20 iterations without settling). Changes when phase 5 or a later gate sets other numbers.
7. **Time, memory and cancel** (the phase 4 plan's design notes, not measured here): phase 3 estimated 25 G multiply-adds per iteration at 600 px with 1000 cells; native, `wl200` took 0.76 to 1.23 s per iteration; in WASM an iteration at 600 px is estimated at tens of seconds. An iteration holds one window's factors (18 to 28 MB at 600 px on the offset grids, phase 1) and the held-out patches (about 108 MB as `i16` at 600 px, phase 3) beside the reservoir (about 321 MB at 600 px). A cancel, a reset or a new Discover takes effect between iterations only: the slow worker gives way (a macrotask) after each one; until it ends the Run panel says "stopping after this iteration" and Refine stays `finishing`. Changes if phase 5 measures an iteration too long to wait for.
8. **The export keeps format 7 and adds keys to the stage records** (format 7 is not on `main` yet: `main` has `EXPORT_FORMAT_VERSION = 6`): `factors` (`replay`: a file's compression replay, also on a file's factor Extract record; `discover`: a live run's), with `factors_note` ("Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.") when `discover`, and on a factor Refine `iterations`, `stop` (`settled`, `nothing-accepted`, `cap`, `stopped`, `error`) and `changed_share`. Under `?compress=off` none appears. A live run's export, key by key: before the user ran Extract (whatever else ran) it is the live export of 4.1: `traces.npy` from the fast loop's history (NaN where a cell had no trace yet), no `traces_signed.npy`, no `extract_min_valid.npy`, no FOV images, `extract_seconds` 0, `meta_json.stages` the runs so far (a factor Refine's record included, and the footprints are the newest library's); after the user ran Extract on the factors: `traces.npy` and `traces_signed.npy` from the factor Extract, `extract_min_valid.npy`, still no FOV images (a stream has no replay that projects frames), `extract_seconds` the Extract's wall time, and the Extract record with `source: "factors"`, `tiling`, `mean_rank`, `low_valid`, `factors: "discover"` and `factors_note`. A Refine after it discards the Extract result (as for files), and the export goes back to the live traces. Changes if format 7 is released before 4.2 merges (then bump to 8).
9. **A live run's Refine exists only as Refine on the factors and only with `?refine=factors`;** without the switch its Run panel keeps no Refine button and availability says "A live stream has no file to replay: Refine runs on the factors only with ?refine=factors.". With `?compress=off` a live run is exactly 4.1's (Discover only, `LIVE_NOTE`). Extract on a live run is never started by the app (the "Extract after Discover" option stays file-only). Changes if the owner wants Extract on factors to run after a stream without asking (spec §6 says so for files; 4.1 left it a click).
10. **The replay that only compresses is an Extract-type replay**: `{ session: 0, discover: false, library, projection: true, compress: true, compressTiling: 'offset', compressSession }`, not connected to the slow loop (the trace worker connects a replay with a library and without `refine` to no slow port and keeps the slow loop), its traces discarded, its projections kept for Extract's FOV images. Changes if phase 5 shows that a Refine replay at the same time would be cheaper than a separate pass.

## Design notes

### What changed against the phase 4 plan's draft list, and why

- **Draft 1 (binding): kept, with changes.** The imported type is `FactorReader` (as the draft) but the method returns a tenth value, the settle code, and runs `refine_until_settled` with a cap of 1 (`refine_one`) instead of the draft's "JS calls `setEditScope` and `finalize` around each iteration", so the refusals before `finalize` and the stop rule stay the library's. A pure-Rust `WindowBytes`/`ByteSource` pair is added because a `JsError` cannot be built in a native test (wasm-bindgen's imports panic off wasm32): the error paths are tested natively on `ByteSource` and in vitest on the real WASM.
- **Draft 2 (`opfsReader`): renamed `openFactorReader(run, names)`.** It takes the file names from the main thread's window count instead of listing the folder (listing is what the sweep does; a reader that is not the owner never does it). The folder name travels as the draft said (`MainToCompress.connect.run`), and the compress worker now builds its store on `connect` instead of at module load.
- **Draft 3 (slow runner): messages renamed** `factor-iteration`, `factor-end`, `stop-factors`, a fifth stop `error`, and the run is not queued behind the worker's port queue (else a reset would wait for all 20 iterations); it gives way between iterations and always ends with `factor-end` after closing the files, which is what the main thread's release waits for.
- **Draft 4 (Refine store and Run panel): split in three tasks** (the factor files in the compress store, Task 4; the Refine store, Task 6; the App and the Run panel, Task 8). `CompressStore.idle()` became `jobsOut()`: once the factors are ready the only file users in the compress worker are Extract jobs, and a cancelled job runs on. Added what the draft did not cover: a new Discover while the slow worker holds the files (`beforeStart`, `release`), the `finishing` state of a cancel, and the fall-back to the file after a failure, unusable factors or a look-back Discover.
- **Draft 5 (live streams): changed.** `factorState` takes `live` as a parameter (the compress store already knows `isLive`); `LIVE_NOTE` stays for compression off and a second note is added; `live-export.ts` needs no change because the Run panel already exports `pass2.result() ?? liveResult()`; the back-fill is already never asked for on a live run (4.1, commit c69a2fc0). New: the pipeline store's `liveTiling`, and the Extract store's `live` option, which refuses to replay a stream.
- **Draft 6 (e2e): changed.** Only the first existing stream test gets `&compress=off`: it asserts the Discover-only Run panel (`pass2-run` absent), which compression on now changes; the second (stop and restart) asserts nothing of Extract and keeps the default. The `discover()` retry helper moves to `e2e/cala-helpers.ts` so the file and the stream tests share one loop.
- **Draft 7 (docs): kept.** Added Task 7 (the Extract store for a live run, and the pipeline store's start hook and live tiling).

### The workers and who holds which file when

- **Compress worker** (owner of `cala-compress/<run>`, holds its Web Lock for its lifetime): writes `w<i>.i16` and `f<i>.bin`, opens a factor file only inside a compression, an Extract job, a back-fill or a review feed, and closes it before the next status. Clears the folder at every `init` (a new Discover, a replay that compresses).
- **Slow worker** (not the owner): opens `f0.bin ... f(n-1).bin` once per Refine on the factors, after `refine-factors`, and closes them in the run's `finally`, before `factor-end`. Never creates, lists or removes.
- **Main thread**: the only one who starts either. It sends `refine-factors` only under decision 1's rule, and treats Refine as busy (`running` or `finishing`) until `factor-end`, so no Extract job starts meanwhile; `pipeline.start` awaits `refine.release()` before its workers start.

### The states and what moves them

`RefineStore` on the factor route (`route() === 'factors'`): `run()` sets `running`. Its `phase()`:

| phase                                        | entered                                 | left on success                                                                    | on cancel                                                             | on failure                                                                                          | on clear (new Discover)                                             |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `compress` (a file without factors)          | `replayCompress` gave compress settings | the replay's `done` step: mark kept (`ended(true)`), projections kept, then `wait` | pipeline stopped (`keepSlow`), mark released, `cancelled`             | mark released, `error`                                                                              | generation bumped, mark released, `idle`                            |
| `wait` (`for: 'compression'` or `'extract'`) | factors not openable yet                | `files(frames)` not null: `iterate`                                                | polling stops, `cancelled`                                            | factors `unusable`: `error`                                                                         | polling stops (generation)                                          |
| `iterate`                                    | `refine-factors` sent, `out` set        | `factor-end` `settled`/`nothing-accepted`/`cap`: `done`                            | `stop-factors` sent, `finishing`; `factor-end` `stopped`: `cancelled` | `factor-end` `error`: `error`, `factorFailed`; a crashed slow worker (`error`, session -1): `error` | `stop-factors` sent, `idle` at once; `out` stays until `factor-end` |

`out` (the slow worker holds the files) is set only when `refine-factors` is sent and cleared only by that session's `factor-end` or by a crashed slow worker; `release()` resolves then. The slow runner posts `factor-end` on every path: a refusal before opening (session, a run already going, no final library, no binding, no reader), a failed open, a reset between iterations, a stop, the settle stop, the cap, and an error inside an iteration.

`FactorState` for a live run (`factorState(..., live = true)`): `none` before the first status; `compressing` while the stream runs or windows wait; `ready` / `unusable` once `final` and nothing pending (decision 3); `unusable` at any compression error. A file run's rules are 4.1's, unchanged.

### The live run's life cycle

1. `?live=ws://...`: `pipeline.start` (after `beforeStart`) passes `compress: true` and, without `?review`, `compressTiling: 'offset'`; Discover compresses its windows as the frames arrive (`source: 'discover'`).
2. The stream ends (`end`, the socket closes, or "Stop the live run"): the pipeline is `done`, the fast loop's `CompressFeed.end` closes the last window, the slow loop publishes its final library. The Run panel's export is the live traces (unchanged); the Extract line says what the factors allow.
3. Once the last window is compressed the factors are `ready`; Extract is offered. With `?refine=factors`, "Refine until settled" is offered too and runs iterations in the slow worker.
4. The user runs Extract: the compress worker solves every window with the newest library (Extract on factors, 4.1); the result replaces the live traces in the export and the record says `factors: "discover"`. A Refine afterwards discards it.

## Global Constraints

- `?compress=off` and the absence of `?refine=factors` keep today's behaviour identical. These existing tests must pass unchanged: `run-stages.test.ts` "streams Discover only, with the note about loading a saved stream"; `refine-store.test.ts` "starts its replays without any compress setting", "replays the recording into the Discover slow loop and logs the run with its readout", "cancels keeping the slow loop (it publishes what it refined) and logs the run", "compresses its replay when the factors say so, and keeps its projections"; `pass2-store.test.ts` "replays the recorded frames with the final library and gathers the traces", "keeps the clipped traces only when the solver returns no signed ones", "replays with the flat-field map of pass 1 (applied from frame 0), or none", "solves on the factors when they are ready, without replaying the file"; `compress.test.ts` "without compress: no options and no feed", "Discover: plain tiles, discover frames, its own session", "does not ask for a back-fill of a live run", "keeps the fast loop traces when a back-fill arrives on a live run"; `factor-extract.test.ts` "are ready once a replay on the offset grids covers every frame"; `pipeline.test.ts` "starts a run with look-back and compression both on, neither switching the other off"; `cells.test.ts` "keeps the loop, sets the refine scope and runs again from frame 0", "finalizes at the end, and ignores other sessions after a reset"; e2e `cala-factors.spec.ts` "Cala: a file runs Discover, Refine and Extract on the factors by default" and "Cala: with compress=off a file replays the file for Extract, as before". The one existing test that changes is e2e `cala-live.spec.ts` "Cala: a live source streams through the pipeline to the end" (it gets `&compress=off`, Task 9).
- No Rust panic reachable from JS: a panic traps the WASM instance and kills the slow worker. Wrong windows, a reader that throws, a loop outside the Refine scope are `JsError`s.
- OPFS files only through `WindowStore.open` or `pinned`; a reader that is not the folder's owner never sweeps, lists, removes or creates.
- Nothing in `crates/cala/src/trace/solver.rs` changes; `refine_on_factors`, `refine_until_settled`, the raw Refine paths and the compress runner's solve stay bit-identical (new functions only).
- Main's look-back (`lookback-*.ts`, `discover/lookback.rs`, `SlowRunner`'s drain) is not changed.
- A live run's trace view and export change only when the user runs a stage (Extract replaces the traces; Refine changes the footprints); nothing runs on a live run by itself.
- App checks, from the repository root: `npm run typecheck`, `npm run typecheck:e2e`, `npm run lint`, `npm run test -w apps/cala` (never bare vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on every touched file outside `crates`.
- Rust checks, from `crates/cala`: `cargo fmt --all --check`; `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`; the same with `--features pybindings` and with `--features diagnostics`; `cargo test --no-default-features --features jsbindings`.
- e2e: `npm run build:e2e`, then `npm run test:e2e`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Never amend. Do not push.
- No machine paths or user names in committed files.
- The shell refuses long compound commands (`cd ... &&` chains, loops, heredocs): put anything longer in a script file and run it with one plain command.
- Branch: `feat/cala-factor-live-refine`.

## Review Focus

1. **Two contexts on one factor file.** The slow worker must never open the files while the compress worker compresses, runs an Extract job (a cancelled one included) or starts a new run; the compress worker must never start one while the slow worker holds them. Expected: Refine waits ("waiting for the last Extract on the factors to end"), Extract is blocked while Refine is `running` or `finishing`, and a Restart waits for the iteration to end. Pinned: Task 4 "only once the factors are ready and no Extract job reads them"; Task 6 "waits for a cancelled Extract job to end before the slow worker opens the files", "stops after the current iteration when cancelled, and holds the files until the slow worker ends"; Task 7 "waits for the hook before it starts the workers, and drops a start replaced meanwhile"; Task 3 "ends when a reset drops the loop between iterations, and closes the files".
2. **A Refine that never ends, or a release that never comes.** Every slow-side path ends with `factor-end` after closing the files; the store's `out` ends there or at a crashed slow worker. Pinned: Task 3 "refuses before Discover published its final library, without opening the files", "reports a failed iteration as the end of the run, keeps the loop and closes the files", "a failed open ends the run with its message"; Task 6 "a new Discover stops the iterations and release waits for the slow worker", "a crashed slow worker frees the files and ends the run".
3. **A live Extract with frames missing, or a stream replayed.** A stream of `600 k + 1` frames must not be extracted on the factors, and a live run must never start a file replay. Pinned: Task 4 "are Discover's own windows, ready once the stream ended and every frame is compressed"; Task 7 "refuses to replay a stream, and says why the factors cannot be read yet".
4. **A live run's export changing without the user.** Until the user runs Extract the export is the live traces. Pinned: e2e Task 9 "Cala: a stream with cells extracts on its own factors after it ended, and says so" (the export before any stage has `stages` `[discover]` and no `traces_signed`); Task 8 "offers Extract on the factors of a live run and says what it reads".
5. **A dead end after a deterministic failure.** A failed factor Refine, unusable factors or a look-back Discover make a file's next Refine replay the file, and the panel says why. Pinned: Task 6 "counts a failed iteration as failed: a file's next Refine replays the file, until clear", "replays the file after a look-back Discover, or when the factors cannot be read, and says why"; Task 8 "says why a file's Refine replays the file with the switch on".
6. **A panic in the binding.** Pinned: Task 1 vitest "turns a window of another frame size into an Error naming refineOnFactors", "passes a reader's error on as an Error, and refuses a reader without windows or a corrupt file", "refuses a loop outside the Refine scope (Discover)", and the native "a_bad_factor_file_is_an_error_and_leaves_the_loop_as_it_was".

## File Structure

| File                                                                                                                                                                           | Change | Responsibility                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/cala/src/discover/factor_refine.rs`                                                                                                                                    | modify | `WindowBytes`, `ByteSource`, `refine_one`; native tests                                                                                           |
| `crates/cala/src/discover/mod.rs`                                                                                                                                              | modify | re-export the three                                                                                                                               |
| `crates/cala/src/discover/js.rs`                                                                                                                                               | modify | imported `FactorReader`; `SlowLoop.refineOnFactors`; `factor_iteration`                                                                           |
| `apps/cala/src/__tests__/factor-refine-wasm.test.ts`                                                                                                                           | create | the binding on real WASM                                                                                                                          |
| `apps/cala/src/lib/window-store.ts`                                                                                                                                            | modify | `newRunFolder`, `FactorReader`, `openFactorReader`                                                                                                |
| `apps/cala/src/workers/compress-types.ts`, `apps/cala/src/lib/compress-client.ts`, `apps/cala/src/workers/compress-worker.ts`                                                  | modify | the run folder named on the main thread (`connect.run`, `CompressClient.folder`)                                                                  |
| `apps/cala/src/workers/slow-types.ts`                                                                                                                                          | modify | `FactorIteration`, `FactorStop`, `FACTOR_STOPS`, `FactorRefineSettings`, `SlowRefineFactors`, `SlowStopFactors`, `factor-iteration`, `factor-end` |
| `apps/cala/src/lib/slow-runner.ts`, `apps/cala/src/workers/slow-worker.ts`, `apps/cala/src/lib/slow-client.ts`, `apps/cala/src/lib/cell-store.ts`                              | modify | the iterations in the slow worker; routing; the client's two messages; the cell store ignores them                                                |
| `apps/cala/src/lib/compress-store.ts`, `apps/cala/src/lib/factor-extract.ts`                                                                                                   | modify | live `factorState`, `jobSent`/`jobsOut`, `live`, `liveFactorsBlocked`, `LIVE_EXTRACT_READY`; `FactorFilesLike`                                    |
| `apps/cala/src/lib/run-stages.ts`, `apps/cala/src/lib/export.ts`, `apps/cala/src/lib/result-file.ts`                                                                           | modify | live availability, texts, `FactorPhase`, record fields and their export                                                                           |
| `apps/cala/src/lib/refine-store.ts`                                                                                                                                            | modify | the factor route, `FACTOR_REFINE`, `refineOnFactorsOn`, `release`, `onSlowMessage`                                                                |
| `apps/cala/src/lib/pass2-store.ts`, `apps/cala/src/lib/pipeline-store.ts`                                                                                                      | modify | live Extract; `PipelineStartHooks`                                                                                                                |
| `apps/cala/src/App.tsx`, `apps/cala/src/components/RunPanel.tsx`                                                                                                               | modify | wiring; the live Extract and Refine rows, the readouts                                                                                            |
| `apps/cala/src/__tests__/` `window-store`, `compress`, `cells`, `factor-extract`, `run-stages`, `export`, `refine-store`, `pass2-store`, `pipeline`, `run-panel-extract` tests | modify | tests                                                                                                                                             |
| `e2e/cala-helpers.ts`                                                                                                                                                          | create | `discover()` and the export readers, shared                                                                                                       |
| `e2e/cala-factors.spec.ts`, `e2e/cala-live.spec.ts`                                                                                                                            | modify | the gate on a file with `refine=factors` and on a simulated stream                                                                                |
| `apps/cala/README.md`, `apps/cala/docs/stages.md`, `docs/CHANGELOG.md`                                                                                                         | modify | docs                                                                                                                                              |

---

### Task 1: One factor iteration through the WASM binding

**Files:**

- Modify: `crates/cala/src/discover/factor_refine.rs` (new items after `refine_until_settled`; new tests at the end of `mod tests`)
- Modify: `crates/cala/src/discover/mod.rs` (the `pub use factor_refine::{...}` list)
- Modify: `crates/cala/src/discover/js.rs` (imports; an `extern "C"` block before `impl JsSlowLoop`; a method in the `#[wasm_bindgen(js_class = SlowLoop)] impl JsSlowLoop`; a helper in the plain `impl JsSlowLoop`)
- Create: `apps/cala/src/__tests__/factor-refine-wasm.test.ts`

**Interfaces:**

- Consumes: `refine_until_settled(sl: &mut SlowLoop, src: &mut dyn FactorSource, cfg: &FactorRefineConfig, on_iteration: impl FnMut(usize, &IterationReport)) -> Result<Settled, TraceError>`; `WindowFactors::from_bytes(&[u8]) -> Option<WindowFactors>`; `SlowLoop::jobs_in_flight()`; test helpers `fixture`, `cfg`, `loop_state`, `accepted_refines` in `factor_refine::tests`; `JsSlowLoop::from_parts` (`#[cfg(test)]`); TS `CompressFeed`, `CompressRunner`, `factorName`, `memoryStore`, `SlowLoop`.
- Produces: Rust `pub trait WindowBytes { fn count(&self) -> usize; fn bytes(&mut self, w: usize) -> Result<Vec<u8>, String>; }`, `pub struct ByteSource<B: WindowBytes>(pub B)` (a `FactorSource`), `pub fn refine_one(sl: &mut SlowLoop, src: &mut dyn FactorSource, cfg: &FactorRefineConfig) -> Result<(IterationReport, Option<SettleStop>), TraceError>`; JS `SlowLoop.refineOnFactors(reader: { windows: number; read(w: number): Uint8Array }, settleCorr: number, settleShare: number, testFrames: number): Float64Array` returning `[libraryVersion, cells, frames, fittingFrames, accepted, changedShare, medianChange, lowValid, tilesSkipped, settle]` with `settle` 0 (not settled), 1 (settled), 2 (settled, nothing accepted); `JsSlowLoop::factor_iteration(&mut self, src: &mut dyn FactorSource, settle_corr: f32, settle_share: f32, test_frames: u32) -> Result<Vec<f64>, TraceError>` (`pub(crate)`).

- [ ] **Step 1: Write the failing tests**

At the end of `mod tests` in `crates/cala/src/discover/factor_refine.rs`:

```rust
    /// The fixture's windows as factor files.
    fn files(windows: &[WindowFactors]) -> Vec<Vec<u8>> {
        windows.iter().map(|w| w.to_bytes()).collect()
    }

    #[test]
    fn one_iteration_from_factor_files_equals_one_from_the_windows() {
        let rc = FactorRefineConfig::default();
        let (mut a, windows) = fixture(cfg(v2_config().background));
        let (mut b, _) = fixture(cfg(v2_config().background));
        let one = FactorRefineConfig {
            max_iterations: 1,
            ..rc
        };
        let mut want = None;
        let done = refine_until_settled(&mut a, &mut windows.clone(), &one, |_, r| {
            want = Some(r.clone())
        })
        .unwrap();
        let (got, stop) = refine_one(&mut b, &mut ByteSource(files(&windows)), &rc).unwrap();
        assert_eq!(Some(got), want);
        assert_eq!(stop, done.settled.then_some(done.stop));
        assert_eq!(accepted_refines(&a), accepted_refines(&b));
    }

    #[test]
    fn a_bad_factor_file_is_an_error_and_leaves_the_loop_as_it_was() {
        let rc = FactorRefineConfig::default();
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let before = loop_state(&sl);
        let mut bytes = files(&windows);
        let n = bytes[1].len();
        bytes[1].truncate(n - 1);
        let err = refine_one(&mut sl, &mut ByteSource(bytes), &rc)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("factor window 1: truncated or corrupt factor file"),
            "{err}"
        );
        assert_eq!(loop_state(&sl), before);
        struct Failing;
        impl WindowBytes for Failing {
            fn count(&self) -> usize {
                2
            }
            fn bytes(&mut self, w: usize) -> Result<Vec<u8>, String> {
                Err(format!("the file of window {w} is gone"))
            }
        }
        let err = refine_one(&mut sl, &mut ByteSource(Failing), &rc)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("factor window 0: the file of window 0 is gone"),
            "{err}"
        );
        assert_eq!(loop_state(&sl), before);
    }

    #[test]
    fn refine_one_says_why_it_settled_or_that_it_did_not() {
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let never = FactorRefineConfig {
            settle_share: 0.0,
            ..FactorRefineConfig::default()
        };
        let (_, stop) = refine_one(&mut sl, &mut ByteSource(files(&windows)), &never).unwrap();
        assert_eq!(stop, None);
        let always = FactorRefineConfig {
            settle_share: 1.0,
            ..FactorRefineConfig::default()
        };
        let (rep, stop) = refine_one(&mut sl, &mut ByteSource(files(&windows)), &always).unwrap();
        assert_eq!(stop.is_some(), rep.changed_share < 1.0);
        if let Some(s) = stop {
            let want = if rep.accepted == 0 {
                SettleStop::NothingAccepted
            } else {
                SettleStop::Settled
            };
            assert_eq!(s, want);
        }
    }

    /// The JS surface's iteration, on the same files, reports what `refine_one` does.
    #[cfg(feature = "jsbindings")]
    #[test]
    fn the_js_surface_runs_the_same_iteration() {
        let rc = FactorRefineConfig::default();
        let (mut a, windows) = fixture(cfg(v2_config().background));
        let (b, _) = fixture(cfg(v2_config().background));
        let lib = b.library().unwrap().clone();
        let mut js = super::super::js::JsSlowLoop::from_parts(b, lib);
        let (want, stop) = refine_one(&mut a, &mut ByteSource(files(&windows)), &rc).unwrap();
        let got = js
            .factor_iteration(&mut ByteSource(files(&windows)), 0.99, 0.02, 0)
            .unwrap();
        let settle = match stop {
            None => 0.0,
            Some(SettleStop::NothingAccepted) => 2.0,
            Some(_) => 1.0,
        };
        assert_eq!(
            got,
            vec![
                want.library_version as f64,
                want.cells as f64,
                want.frames as f64,
                want.fitting_frames as f64,
                want.accepted as f64,
                want.changed_share,
                want.median_change,
                want.low_valid as f64,
                want.tiles_skipped as f64,
                settle,
            ]
        );
    }
```

Create `apps/cala/src/__tests__/factor-refine-wasm.test.ts`:

```ts
// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  factorHeader,
  quantizeTiles,
  SlowLoop,
  tileLayout,
  TileCompressor,
} from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { CompressRunner, factorName } from '../lib/compress-runner.ts';
import { memoryStore } from '../lib/window-store.ts';
import type { FastToCompress } from '../workers/compress-types.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const W = 64;
const H = 48;
const WINDOW = 50;

/** Frame `t` of a `width x height` movie, rank 3 in time with slow time courses. */
function frameOf(width: number, height: number, t: number): Float32Array {
  const out = new Float32Array(width * height);
  const a = t / 9;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const b = (x + 2 * y) / 11;
      out[y * width + x] =
        20 +
        9 * Math.sin(a) * Math.cos(b) +
        5 * Math.cos(0.7 * a) * Math.sin(2 * b) +
        3 * Math.sin(1.9 * a) * Math.cos(3 * b);
    }
  return out;
}

/** The factor files of `frames` frames (windows of 50, offset grids), as the compress worker writes them. */
async function factorFiles(width = W, height = H, frames = 100): Promise<Uint8Array[]> {
  const sent: FastToCompress[] = [];
  const feed = new CompressFeed(
    { width, height, session: 1, tile: 16, window: WINDOW, tiling: 'offset', source: 'replay' },
    { postMessage: (m) => sent.push(m) },
  );
  const px = width * height;
  const batch = new Float32Array(10 * px);
  for (let s = 0; s < frames; s += 10) {
    for (let i = 0; i < 10; i++) batch.set(frameOf(width, height, s + i), i * px);
    feed.push(batch, s, 10);
  }
  feed.end();
  const store = memoryStore();
  const runner = new CompressRunner({
    store,
    quantize: quantizeTiles,
    layout: tileLayout,
    header: factorHeader,
    create: (quant) => new TileCompressor(quant),
    toMain: { postMessage() {} },
    yieldNow: () => Promise.resolve(),
  });
  for (const m of sent) await runner.handle(m);
  await runner.idle();
  return Array.from({ length: frames / WINDOW }, (_, i) => store.files.get(factorName(i))!);
}

/** A slow loop of a W x H recording that published an empty library (Discover found nothing). */
function discoverLoop(): SlowLoop {
  const px = W * H;
  const loop = new SlowLoop(W, H, new Uint8Array(px).fill(1), new Float32Array(px).fill(1), 6, 0);
  loop.finalize().free();
  return loop;
}

const reader = (files: Uint8Array[]) => ({ windows: files.length, read: (w: number) => files[w] });

describe('SlowLoop.refineOnFactors (the WASM binding)', () => {
  it('runs one iteration on factor files: an empty library settles with nothing accepted', async () => {
    const files = await factorFiles();
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const r = loop.refineOnFactors(reader(files), 0.99, 0.02, 0);
      expect(r).toHaveLength(10);
      // cells, frames, accepted, settle
      expect([r[1], r[2], r[4], r[9]]).toEqual([0, 100, 0, 2]);
    } finally {
      loop.free();
    }
  });

  it('turns a window of another frame size into an Error naming refineOnFactors', async () => {
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const other = await factorFiles(32, 24);
      expect(() => loop.refineOnFactors(reader(other), 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*factors of/,
      );
      // The instance still works: no trap.
      expect(loop.refineOnFactors(reader(await factorFiles()), 0.99, 0.02, 0)[9]).toBe(2);
    } finally {
      loop.free();
    }
  });

  it("passes a reader's error on as an Error, and refuses a reader without windows or a corrupt file", async () => {
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const failing = {
        windows: 2,
        read: (): Uint8Array => {
          throw new Error('the file is gone');
        },
      };
      expect(() => loop.refineOnFactors(failing, 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*factor window 0: .*the file is gone/,
      );
      expect(() => loop.refineOnFactors(reader([]), 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*no factor windows/,
      );
      const corrupt = (await factorFiles()).map((f, i) =>
        i === 1 ? f.subarray(0, f.length - 1) : f,
      );
      expect(() => loop.refineOnFactors(reader(corrupt), 0.99, 0.02, 0)).toThrow(
        /factor window 1: truncated or corrupt factor file/,
      );
    } finally {
      loop.free();
    }
  });

  it('refuses a loop outside the Refine scope (Discover)', async () => {
    const loop = discoverLoop();
    try {
      expect(() => loop.refineOnFactors(reader(await factorFiles()), 0.99, 0.02, 0)).toThrow(
        /cell set frozen/,
      );
    } finally {
      loop.free();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

From `crates/cala`: `cargo test --no-default-features --features jsbindings factor_refine` fails to compile: `cannot find function refine_one`, `cannot find type ByteSource`, `cannot find trait WindowBytes`, `no method named factor_iteration`. From the repository root: `npm run test -w apps/cala -- factor-refine-wasm` fails with `TypeError: loop.refineOnFactors is not a function`.

- [ ] **Step 3: Implement**

In `crates/cala/src/discover/factor_refine.rs`, after `refine_until_settled` and before `#[cfg(test)]`:

```rust
/// The bytes of factor files, one window at a time, in frame order (the
/// app's reader of the run's files). An error is the reader's message.
pub trait WindowBytes {
    fn count(&self) -> usize;
    fn bytes(&mut self, w: usize) -> Result<Vec<u8>, String>;
}

impl WindowBytes for Vec<Vec<u8>> {
    fn count(&self) -> usize {
        self.len()
    }

    fn bytes(&mut self, w: usize) -> Result<Vec<u8>, String> {
        self.get(w).cloned().ok_or_else(|| format!("no window {w}"))
    }
}

/// A [`FactorSource`] over factor files (`WindowFactors::to_bytes`): a file
/// that cannot be read or parsed is a [`TraceError`], never a panic.
pub struct ByteSource<B: WindowBytes>(pub B);

impl<B: WindowBytes> FactorSource for ByteSource<B> {
    fn windows(&self) -> usize {
        self.0.count()
    }

    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError> {
        let bytes = self
            .0
            .bytes(w)
            .map_err(|m| TraceError::InvalidConfig(format!("factor window {w}: {m}")))?;
        WindowFactors::from_bytes(&bytes).ok_or_else(|| {
            TraceError::InvalidConfig(format!(
                "factor window {w}: truncated or corrupt factor file"
            ))
        })
    }
}

/// One Refine iteration on the factors as the app runs it, one call per
/// iteration with the caller looping (qc_eval's `--refine-engine factors`
/// does the same): [`refine_until_settled`] with a cap of 1, so the loop's
/// refusals, the `finalize` before and after and the stop rule are the
/// library's own. Returns the iteration's report and, when it settled, why
/// (`None`: not settled; the caller's own cap decides).
pub fn refine_one(
    sl: &mut SlowLoop,
    src: &mut dyn FactorSource,
    cfg: &FactorRefineConfig,
) -> Result<(IterationReport, Option<SettleStop>), TraceError> {
    let one = FactorRefineConfig {
        max_iterations: 1,
        ..*cfg
    };
    let mut rep = None;
    let done = refine_until_settled(sl, src, &one, |_, r| rep = Some(r.clone()))?;
    let rep = rep.ok_or_else(|| {
        TraceError::InvalidConfig("Refine on factors ran no iteration".into())
    })?;
    Ok((rep, done.settled.then_some(done.stop)))
}
```

In `crates/cala/src/discover/mod.rs`, before:

```rust
pub use factor_refine::{
    footprint_change, refine_until_settled, FactorRefineConfig, FactorSource, IterationReport,
    RefineStage, SettleStop, Settled,
};
```

after:

```rust
pub use factor_refine::{
    footprint_change, refine_one, refine_until_settled, ByteSource, FactorRefineConfig,
    FactorSource, IterationReport, RefineStage, SettleStop, Settled, WindowBytes,
};
```

In `crates/cala/src/discover/js.rs`, the imports, before:

```rust
use super::{
    EditScope, HeldOutRecord, JointSign, JointUpdate, LookBack, LookbackConfig, LookbackNext,
    LookbackOutcome, SlowLoop, SlowLoopConfig, VisitJob, VisitResult, VisitRunner,
};
```

after:

```rust
use super::{
    refine_one, ByteSource, EditScope, FactorRefineConfig, FactorSource, HeldOutRecord,
    JointSign, JointUpdate, LookBack, LookbackConfig, LookbackNext, LookbackOutcome, SettleStop,
    SlowLoop, SlowLoopConfig, VisitJob, VisitResult, VisitRunner, WindowBytes,
};
```

and `use crate::trace::{FrameTraces, Library, LibraryBuilder};` becomes `use crate::trace::{FrameTraces, Library, LibraryBuilder, SolverConfig, TraceError};`.

Before `#[wasm_bindgen(js_class = SlowLoop)]` (the first `impl JsSlowLoop` block), add:

```rust
#[wasm_bindgen]
extern "C" {
    /// The factor windows of a run, in frame order, as the slow worker reads
    /// them (`openFactorReader` in apps/cala/src/lib/window-store.ts): any
    /// object with a `windows` count and `read(w)` returning window `w`'s
    /// whole factor file as a `Uint8Array`.
    pub type FactorReader;
    #[wasm_bindgen(method, getter)]
    fn windows(this: &FactorReader) -> u32;
    #[wasm_bindgen(method, catch)]
    fn read(this: &FactorReader, w: u32) -> Result<Vec<u8>, JsValue>;
}

/// A [`FactorReader`] as the windows' bytes; an error it throws becomes its message.
struct JsWindows<'a>(&'a FactorReader);

impl WindowBytes for JsWindows<'_> {
    fn count(&self) -> usize {
        self.0.windows() as usize
    }

    fn bytes(&mut self, w: usize) -> Result<Vec<u8>, String> {
        let w = u32::try_from(w).map_err(|_| format!("window index {w}"))?;
        self.0
            .read(w)
            .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))
    }
}
```

In the `#[wasm_bindgen(js_class = SlowLoop)] impl JsSlowLoop` block, after `finalize`:

```rust
    /// One Refine iteration on the factors of `reader` (spec §5): the
    /// library's `refine_until_settled` with a cap of 1, as qc_eval's
    /// `--refine-engine factors` runs it. Call `setEditScope('refine')`
    /// first; the caller loops, stops on the settle code or its own cap and
    /// takes the library with `finalize`. Returns `[libraryVersion, cells,
    /// frames, fittingFrames, accepted, changedShare, medianChange, lowValid,
    /// tilesSkipped, settle]`, `settle` 0 = not settled, 1 = settled, 2 =
    /// settled with nothing accepted. A refused or failed iteration is an
    /// error and leaves the loop as it was.
    #[wasm_bindgen(js_name = refineOnFactors)]
    pub fn refine_on_factors(
        &mut self,
        reader: &FactorReader,
        settle_corr: f32,
        settle_share: f32,
        test_frames: u32,
    ) -> Result<Vec<f64>, JsError> {
        self.factor_iteration(
            &mut ByteSource(JsWindows(reader)),
            settle_corr,
            settle_share,
            test_frames,
        )
        .map_err(|e| js_err("refineOnFactors", e))
    }
```

In the plain `impl JsSlowLoop` block (the one with `wrap`), after `stream_ok`:

```rust
    /// `refineOnFactors` on any factor source (native tests use files in memory).
    pub(crate) fn factor_iteration(
        &mut self,
        src: &mut dyn FactorSource,
        settle_corr: f32,
        settle_share: f32,
        test_frames: u32,
    ) -> Result<Vec<f64>, TraceError> {
        if self.inner.jobs_in_flight() > 0 {
            return Err(TraceError::InvalidConfig(
                "tile visits are out: Refine on factors waits for them".into(),
            ));
        }
        let cfg = FactorRefineConfig {
            settle_corr,
            settle_share,
            max_iterations: 1,
            test_frames: test_frames as usize,
            solver: SolverConfig::default(),
        };
        let (r, stop) = refine_one(&mut self.inner, src, &cfg)?;
        let settle = match stop {
            None => 0.0,
            Some(SettleStop::NothingAccepted) => 2.0,
            Some(_) => 1.0,
        };
        Ok(vec![
            r.library_version as f64,
            r.cells as f64,
            r.frames as f64,
            r.fitting_frames as f64,
            r.accepted as f64,
            r.changed_share,
            r.median_change,
            r.low_valid as f64,
            r.tiles_skipped as f64,
            settle,
        ])
    }
```

- [ ] **Step 4: Run the tests**

From `crates/cala`: `cargo fmt --all`, then `cargo test --no-default-features --features jsbindings factor_refine` (all pass, the four new ones included), then `cargo fmt --all --check`, the three `cargo clippy --all-targets --no-default-features --features <jsbindings|pybindings|diagnostics> -- -D warnings` and `cargo test --no-default-features --features jsbindings`. From the root: `npm run test -w apps/cala -- factor-refine-wasm` (4 passed), `npx prettier --write apps/cala/src/__tests__/factor-refine-wasm.test.ts`, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add crates/cala/src/discover/factor_refine.rs crates/cala/src/discover/mod.rs crates/cala/src/discover/js.rs apps/cala/src/__tests__/factor-refine-wasm.test.ts
git commit -m "feat(cala): SlowLoop.refineOnFactors runs one Refine iteration on factor files a JS reader supplies"
```

---

### Task 2: The run folder is named on the main thread, and a reader that does not own it

**Files:**

- Modify: `apps/cala/src/lib/window-store.ts` (new `newRunFolder`, `FactorReader`, `openFactorReader`; `opfsStore`'s default `run`)
- Modify: `apps/cala/src/workers/compress-types.ts` (`MainToCompress` `connect`)
- Modify: `apps/cala/src/lib/compress-client.ts` (`CompressClient.folder`, `createCompressClient`)
- Modify: `apps/cala/src/workers/compress-worker.ts` (the store is built on `connect`)
- Test: `apps/cala/src/__tests__/window-store.test.ts`, `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `pinned`, `COMPRESS_ROOT`, the private `DirHandle`, `SyncHandle` interfaces of `window-store.ts`; `factorName` (`compress-runner.ts`).
- Produces: `newRunFolder(): string`; `interface FactorReader { readonly windows: number; read(w: number): Uint8Array; close(): void }`; `openFactorReader(run: string, names: readonly string[], top?: () => Promise<unknown>): Promise<FactorReader>`; `MainToCompress` `{ type: 'connect'; port; run?: string; review? }`; `CompressClient.folder: string`; `createCompressClient(frames, onMessage, makeWorker?, review?, folder = newRunFolder())`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/window-store.test.ts`, change the import to `import { isPinned, openFactorReader, opfsStore, pinned } from '../lib/window-store.ts';` and add at the end:

```ts
describe('openFactorReader (a reader that does not own the folder)', () => {
  /** An OPFS root with `cala-compress/run-a` holding `files`; every call is recorded. */
  function fakeRoot(files: Record<string, Uint8Array>, calls: string[]) {
    const closed: string[] = [];
    const opening = new Set<object>();
    const run = {
      getFileHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`file ${name}${o?.create ? ' create' : ''}`);
        const data = files[name];
        if (!data) throw new Error(`${name} not found`);
        const file = {
          createSyncAccessHandle: async () => {
            opening.add(file);
            await tick();
            return {
              write: () => 0,
              read: (into: Uint8Array, { at }: { at: number }) => {
                const part = data.subarray(at, at + into.length);
                into.set(part);
                return part.length;
              },
              getSize: () => data.length,
              flush: () => {},
              close: () => closed.push(name),
            };
          },
        };
        return file;
      },
      removeEntry: async (name: string) => void calls.push(`remove ${name}`),
      keys: async function* () {
        calls.push('keys');
        yield* Object.keys(files);
      },
    };
    const root = {
      getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`dir ${name}${o?.create ? ' create' : ''}`);
        if (name !== 'run-a') throw new Error(`${name} not found`);
        return run;
      },
      removeEntry: async (name: string) => void calls.push(`remove ${name}`),
      keys: async function* () {
        calls.push('keys');
        yield 'run-a';
      },
    };
    const top = {
      getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`root ${name}${o?.create ? ' create' : ''}`);
        return root;
      },
    };
    return { top: async () => top, closed, opening };
  }

  it('reads whole factor files from the folder, never creating, listing or removing anything', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1, 2, 3), 'f1.bin': Uint8Array.of(4, 5) }, calls);
    const reader = await openFactorReader('run-a', ['f0.bin', 'f1.bin'], f.top);
    expect(reader.windows).toBe(2);
    expect([...reader.read(1)]).toEqual([4, 5]);
    expect([...reader.read(0)]).toEqual([1, 2, 3]);
    expect(() => reader.read(2)).toThrow('No factor window 2.');
    reader.close();
    reader.close();
    expect(f.closed).toEqual(['f0.bin', 'f1.bin']);
    expect(() => reader.read(0)).toThrow('No factor window 0.');
    expect(calls).toEqual(['root cala-compress', 'dir run-a', 'file f0.bin', 'file f1.bin']);
  });

  it('keeps each file handle referenced while its access handle opens', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1) }, calls);
    const opened = openFactorReader('run-a', ['f0.bin'], f.top);
    for (let i = 0; i < 10 && f.opening.size === 0; i++) await tick();
    const [file] = [...f.opening];
    expect(isPinned(file)).toBe(true);
    (await opened).close();
    expect(isPinned(file)).toBe(false);
  });

  it('closes what it opened when a file or the folder is missing, and says so', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1) }, calls);
    await expect(openFactorReader('run-a', ['f0.bin', 'f1.bin'], f.top)).rejects.toThrow(
      /^The factor files of this run cannot be opened: f1.bin not found/,
    );
    expect(f.closed).toEqual(['f0.bin']);
    await expect(openFactorReader('run-gone', ['f0.bin'], f.top)).rejects.toThrow(
      /^The factor files of this run cannot be opened: run-gone not found/,
    );
    expect(calls.some((c) => c.includes('create') || c.startsWith('remove') || c === 'keys')).toBe(
      false,
    );
  });
});
```

In `apps/cala/src/__tests__/compress.test.ts`, add `import { createCompressClient, type CompressWorkerLike } from '../lib/compress-client.ts';` and at the end:

```ts
describe('the compress client', () => {
  it('names the run folder its worker owns and tells the worker', () => {
    const posted: unknown[] = [];
    const worker = {
      postMessage: (m: unknown) => void posted.push(m),
      terminate() {},
      onmessage: null,
      onerror: null,
    } as unknown as CompressWorkerLike;
    const frames = { connectCompress: async () => {} };
    const named = createCompressClient(
      frames,
      () => {},
      () => worker,
      undefined,
      'run-test',
    );
    expect(named.folder).toBe('run-test');
    expect(posted[0]).toMatchObject({ type: 'connect', run: 'run-test' });
    const own = createCompressClient(
      frames,
      () => {},
      () => worker,
    );
    expect(own.folder).toMatch(/^run-/);
    expect(own.folder).not.toBe('run-test');
    expect(posted[1]).toMatchObject({ type: 'connect', run: own.folder });
    named.dispose();
    own.dispose();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- window-store compress` fails: `openFactorReader is not a function` (import is `undefined`), and `expected undefined to be 'run-test'`.

- [ ] **Step 3: Implement**

In `apps/cala/src/lib/window-store.ts`, after `export const COMPRESS_ROOT = 'cala-compress';`:

```ts
/** A new run folder name (`cala-compress/<name>`), unique to this context. */
export function newRunFolder(): string {
  return `run-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
```

`opfsStore`'s first parameter, before: ``run = `run-${Date.now().toString(36)}-${crypto.randomUUID()}`,``; after: `run = newRunFolder(),`.

At the end of the file, before `memoryStore`:

```ts
/** The factor windows of a run, as the slow worker reads them (Refine on the factors). */
export interface FactorReader {
  readonly windows: number;
  /** Window `w`'s whole factor file. */
  read(w: number): Uint8Array;
  /** Close every file (once; later reads throw). */
  close(): void;
}

/**
 * Open the factor files `names` of the run folder `cala-compress/<run>` for
 * reading, from a context that does not own the folder: it never creates,
 * lists or removes anything (the owner's lock protects the folder; only the
 * owner sweeps). Each awaited call runs through `pinned`. A missing folder or
 * file rejects, after closing the files opened so far.
 */
export async function openFactorReader(
  run: string,
  names: readonly string[],
  top: () => Promise<unknown> = () => navigator.storage.getDirectory(),
): Promise<FactorReader> {
  const handles: SyncHandle[] = [];
  try {
    const origin = (await top()) as DirHandle;
    const root = await pinned(origin, (o) => o.getDirectoryHandle(COMPRESS_ROOT));
    const dir = await pinned(root, (r) => r.getDirectoryHandle(run));
    for (const name of names) {
      const file = await pinned(dir, (d) => d.getFileHandle(name));
      handles.push(await pinned(file, (f) => f.createSyncAccessHandle()));
    }
  } catch (err) {
    for (const h of handles) h.close();
    throw new Error(
      `The factor files of this run cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let open = true;
  return {
    windows: names.length,
    read(w) {
      const h = open ? handles[w] : undefined;
      if (!h) throw new Error(`No factor window ${w}.`);
      const out = new Uint8Array(h.getSize());
      const n = h.read(out, { at: 0 });
      if (n !== out.length)
        throw new Error(`Factor window ${w}: read ${n} of ${out.length} bytes.`);
      return out;
    },
    close() {
      if (!open) return;
      open = false;
      for (const h of handles) h.close();
    },
  };
}
```

In `apps/cala/src/workers/compress-types.ts`, the `connect` member of `MainToCompress`, before:

```ts
  | { type: 'connect'; port: MessagePort; review?: { port: MessagePort; every: number } }
```

after:

```ts
  | {
      type: 'connect';
      port: MessagePort;
      /**
       * The OPFS run folder this worker owns (`cala-compress/<run>`), named by
       * the main thread so that the slow worker can read its factor files
       * (absent: a name of the worker's own).
       */
      run?: string;
      review?: { port: MessagePort; every: number };
    }
```

In `apps/cala/src/lib/compress-client.ts`: import `import { newRunFolder } from './window-store.ts';`; add to `CompressClient`:

```ts
  /** The run folder the compress worker owns (`cala-compress/<folder>`): where its factor files are. */
  readonly folder: string;
```

add a fifth parameter after `review?: { port: MessagePort; every: number },`:

```ts
  /** The run folder's name (tests); default a new one. */
  folder: string = newRunFolder(),
```

the `connect` message gains `run: folder,` after `port: channel.port2,`:

```ts
const connect: MainToCompress = {
  type: 'connect',
  port: channel.port2,
  run: folder,
  ...(review ? { review } : {}),
};
```

and the returned object starts with `folder,`.

In `apps/cala/src/workers/compress-worker.ts`: `import { opfsStore, type WindowStore } from '../lib/window-store.ts';`; replace `const store = opfsStore();` with:

```ts
/** The run folder's store, built at the first `connect` under the name the main thread gave. */
let store: WindowStore | null = null;
```

and in the connect path, just before `const r = new CompressRunner({`, add

```ts
// One folder per worker: the first connect names it (the main thread's `folder`).
const runStore = (store ??= opfsStore(data.run));
```

and in the runner's deps replace the shorthand `store,` with `store: runStore,`.

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- window-store compress` (all pass), then `npx prettier --write` on the six files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/window-store.ts apps/cala/src/workers/compress-types.ts apps/cala/src/lib/compress-client.ts apps/cala/src/workers/compress-worker.ts apps/cala/src/__tests__/window-store.test.ts apps/cala/src/__tests__/compress.test.ts
git commit -m "feat(cala): the main thread names the compress worker's run folder, and a reader opens its factor files without owning it"
```

---

### Task 3: The slow worker runs Refine on the factors

**Files:**

- Modify: `apps/cala/src/workers/slow-types.ts` (new types and messages)
- Modify: `apps/cala/src/lib/slow-runner.ts` (`SlowLoopLike.refineOnFactors`, `SlowRunnerDeps.openFactors`, `factorIteration`, `SlowRunner.refineOnFactors`, `stopFactors`, `factorRefusal`, guards in `end` and `handleReviewed`)
- Modify: `apps/cala/src/workers/slow-worker.ts` (route the two messages; `openFactors`)
- Modify: `apps/cala/src/lib/slow-client.ts` (`refineOnFactors`, `stopFactors`)
- Modify: `apps/cala/src/lib/cell-store.ts` (`onSlowMessage`: only `error` sets the error)
- Test: `apps/cala/src/__tests__/cells.test.ts`

**Interfaces:**

- Consumes: `FactorReader`, `openFactorReader` (Task 2); `factorName` (`compress-runner.ts`); `SlowLoop.refineOnFactors` (Task 1).
- Produces (`slow-types.ts`): `interface FactorIteration { iteration; libraryVersion; cells; frames; fittingFrames; accepted; changedShare; medianChange; lowValid; tilesSkipped; ms: number }`; `type FactorStop = 'settled' | 'nothing-accepted' | 'cap' | 'stopped' | 'error'`; `const FACTOR_STOPS: readonly FactorStop[]`; `interface FactorRefineSettings { settleCorr: number; settleShare: number; maxIterations: number; testFrames: number }`; `interface SlowRefineFactors extends FactorRefineSettings { type: 'refine-factors'; session: number; folder: string; windows: number }`; `interface SlowStopFactors { type: 'stop-factors'; session: number }`; `MainToSlow` gains both; `SlowToMain` gains `{ type: 'factor-iteration'; session: number; report: FactorIteration }` and `{ type: 'factor-end'; session: number; iterations: number; stop: FactorStop; message?: string }`. (`slow-runner.ts`): `factorIteration(iteration: number, r: ArrayLike<number>, ms: number): { report: FactorIteration; settle: number }`; `SlowRunner.refineOnFactors(msg: SlowRefineFactors): Promise<void>`; `SlowRunner.stopFactors(session: number): void`. (`slow-client.ts`): `SlowClient.refineOnFactors(msg: Omit<SlowRefineFactors, 'type'>): void`, `SlowClient.stopFactors(session: number): void`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/cells.test.ts`: add `createCellStore` to the import from `'../lib/cell-store.ts'`; add `import { createSlowClient, type SlowWorkerLike } from '../lib/slow-client.ts';`; add `SlowRefineFactors` to the type import from `'../workers/slow-types.ts'`. Change the helper `runner` to take extra deps, before:

```ts
function runner(publishAt: Set<number>) {
```

after:

```ts
function runner(publishAt: Set<number>, extra: Partial<SlowRunnerDeps> = {}) {
```

and its construction, before: `const r = new SlowRunner({ create, toFast, toMain, now: () => 0 });` after: `const r = new SlowRunner({ create, toFast, toMain, now: () => 0, ...extra });`. Then add, after the describe "SlowRunner run stages (Discover, then Refine replays)":

```ts
describe('SlowRunner: Refine on the factors', () => {
  const settings = { settleCorr: 0.99, settleShare: 0.02, maxIterations: 4, testFrames: 0 };
  const msg: SlowRefineFactors = {
    type: 'refine-factors',
    session: 2,
    folder: 'run-x',
    windows: 3,
    ...settings,
  };

  /** A Discover that ended; a fake reader; a loop whose iterations give the settle codes `settles` in turn. */
  function setup(settles: number[], open?: () => Promise<never>) {
    const later: (() => void)[] = [];
    const opened: string[] = [];
    let closed = 0;
    const reader = { windows: 3, read: () => new Uint8Array(0), close: () => void closed++ };
    const t = runner(new Set(), {
      defer: (fn) => void later.push(fn),
      openFactors:
        open ??
        (async (folder, windows) => {
          opened.push(`${folder} ${windows}`);
          return reader;
        }),
    });
    const scopes: string[] = [];
    const calls: unknown[][] = [];
    let it = 0;
    let version = 600;
    t.loop.setEditScope = (s: string) => void scopes.push(s);
    t.loop.refineOnFactors = (r, ...args) => {
      calls.push([r === reader, ...args]);
      const settle = settles[it++] ?? 0;
      version++;
      return Float64Array.of(version, 3, 12, 8, 5, 0.1, 0.01, 0, 0, settle);
    };
    t.loop.finalize = () => {
      const l = fakeLib(version, [1, 2, 3]);
      t.libs.push(l);
      return l;
    };
    t.r.handle(INIT);
    t.r.handle({ type: 'end', session: 2 });
    return { ...t, later, opened, scopes, calls, closed: () => closed };
  }

  /** Let the run take its turns (each deferred step runs once the test lets it). */
  async function drive(p: Promise<void>, later: (() => void)[]): Promise<void> {
    let settled = false;
    void p.then(() => (settled = true));
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 0));
      later.shift()?.();
    }
    await p;
  }

  async function turns(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('iterates until the footprints settle, publishing the library after each, then closes the files', async () => {
    const t = setup([0, 0, 1]);
    await drive(t.r.refineOnFactors(msg), t.later);
    expect(t.opened).toEqual(['run-x 3']);
    expect(t.scopes).toEqual(['refine']);
    expect(t.calls).toEqual([
      [true, 0.99, 0.02, 0],
      [true, 0.99, 0.02, 0],
      [true, 0.99, 0.02, 0],
    ]);
    const its = t.toMain
      .of('factor-iteration')
      .map((m) => [m.report.iteration, m.report.libraryVersion]);
    expect(its).toEqual([
      [1, 601],
      [2, 602],
      [3, 603],
    ]);
    expect(t.toMain.of('factor-iteration')[0].report).toMatchObject({
      cells: 3,
      frames: 12,
      fittingFrames: 8,
      accepted: 5,
      changedShare: 0.1,
      medianChange: 0.01,
    });
    // Discover's final library, then one per iteration, to the fast worker and the UI.
    expect(t.toFast.of('library').map((m) => m.version)).toEqual([600, 601, 602, 603]);
    expect(t.toMain.of('factor-end')).toEqual([
      { type: 'factor-end', session: 2, iterations: 3, stop: 'settled' },
    ]);
    expect(t.closed()).toBe(1);
    expect(t.toMain.of('status').at(-1)!.status).toMatchObject({
      final: true,
      run: 2,
      editScope: 'refine',
    });
  });

  it('stops at the cap without settling, and says when the last iteration accepted nothing', async () => {
    const t = setup([]);
    await drive(t.r.refineOnFactors(msg), t.later);
    expect(t.calls).toHaveLength(4);
    expect(t.toMain.of('factor-end')).toEqual([
      { type: 'factor-end', session: 2, iterations: 4, stop: 'cap' },
    ]);
    const u = setup([2]);
    await drive(u.r.refineOnFactors(msg), u.later);
    expect(u.toMain.of('factor-end')).toEqual([
      { type: 'factor-end', session: 2, iterations: 1, stop: 'nothing-accepted' },
    ]);
  });

  it('stops between iterations when told, never inside one, and ignores an end of the fast loop meanwhile', async () => {
    const t = setup([]);
    const p = t.r.refineOnFactors(msg);
    await turns(() => t.later.length === 1);
    expect(t.calls).toHaveLength(1);
    t.r.handle({ type: 'end', session: 2 });
    expect(t.toMain.of('status').at(-1)!.status.final).toBe(false);
    t.r.stopFactors(3); // another session: not this run
    t.r.stopFactors(2);
    t.later.shift()!();
    await p;
    expect(t.calls).toHaveLength(1);
    expect(t.toMain.of('factor-end')).toEqual([
      { type: 'factor-end', session: 2, iterations: 1, stop: 'stopped' },
    ]);
    expect(t.closed()).toBe(1);
  });

  it('ends when a reset drops the loop between iterations, and closes the files', async () => {
    const t = setup([]);
    const p = t.r.refineOnFactors(msg);
    await turns(() => t.later.length === 1);
    t.r.handle({ type: 'reset', session: 3 });
    expect(t.loop.free).toHaveBeenCalled();
    t.later.shift()!();
    await p;
    expect(t.calls).toHaveLength(1);
    expect(t.toMain.of('factor-end')).toEqual([
      { type: 'factor-end', session: 2, iterations: 1, stop: 'stopped' },
    ]);
    expect(t.closed()).toBe(1);
  });

  it('reports a failed iteration as the end of the run, keeps the loop and closes the files', async () => {
    const t = setup([]);
    t.loop.refineOnFactors = () => {
      throw new Error(
        'refineOnFactors: invalid trace config: factor window 1: truncated or corrupt factor file',
      );
    };
    await drive(t.r.refineOnFactors(msg), t.later);
    expect(t.toMain.of('factor-end')).toEqual([
      {
        type: 'factor-end',
        session: 2,
        iterations: 0,
        stop: 'error',
        message:
          'refineOnFactors: invalid trace config: factor window 1: truncated or corrupt factor file',
      },
    ]);
    expect(t.closed()).toBe(1);
    expect(t.loop.free).not.toHaveBeenCalled();
    expect(t.toMain.of('status').at(-1)!.status.final).toBe(true);
    // A raw Refine can follow.
    t.r.handle({ type: 'replay', session: 2, scope: 'refine' });
    expect(t.toMain.of('status').at(-1)!.status).toMatchObject({ run: 3, final: false });
  });

  it('refuses before Discover published its final library, without opening the files', async () => {
    const t = runner(new Set(), { openFactors: vi.fn() });
    t.loop.setEditScope = () => {};
    t.loop.refineOnFactors = vi.fn();
    t.r.handle(INIT);
    await t.r.refineOnFactors(msg);
    expect(t.toMain.of('factor-end')).toEqual([
      {
        type: 'factor-end',
        session: 2,
        iterations: 0,
        stop: 'error',
        message: 'The slow loop has not published its final library yet.',
      },
    ]);
    expect(t.loop.refineOnFactors).not.toHaveBeenCalled();
    await t.r.refineOnFactors({ ...msg, session: 9 });
    expect(t.toMain.of('factor-end')[1].message).toBe(
      'No slow loop to refine: run Discover first.',
    );
  });

  it('refuses a second run while one holds the files', async () => {
    const t = setup([]);
    const p = t.r.refineOnFactors(msg);
    await turns(() => t.later.length === 1);
    await t.r.refineOnFactors(msg);
    expect(t.toMain.of('factor-end')).toEqual([
      {
        type: 'factor-end',
        session: 2,
        iterations: 0,
        stop: 'error',
        message: 'Refine on the factors is already running.',
      },
    ]);
    expect(t.opened).toEqual(['run-x 3']);
    t.r.stopFactors(2);
    t.later.shift()!();
    await p;
  });

  it('a failed open ends the run with its message', async () => {
    const t = setup([], async () => {
      throw new Error('The factor files of this run cannot be opened: f2.bin not found');
    });
    await drive(t.r.refineOnFactors(msg), t.later);
    expect(t.toMain.of('factor-end')).toEqual([
      {
        type: 'factor-end',
        session: 2,
        iterations: 0,
        stop: 'error',
        message: 'The factor files of this run cannot be opened: f2.bin not found',
      },
    ]);
    expect(t.scopes).toEqual([]);
  });

  it('the slow client sends both messages to the worker', () => {
    const posted: unknown[] = [];
    const worker = {
      postMessage: (m: unknown) => void posted.push(m),
      terminate() {},
      onmessage: null,
      onerror: null,
    } as unknown as SlowWorkerLike;
    const c = createSlowClient(
      { connectSlow: async () => {} },
      () => {},
      () => worker,
    );
    c.refineOnFactors({ session: 4, folder: 'run-x', windows: 2, ...settings });
    c.stopFactors(4);
    expect(posted.slice(1)).toEqual([
      { type: 'refine-factors', session: 4, folder: 'run-x', windows: 2, ...settings },
      { type: 'stop-factors', session: 4 },
    ]);
    c.dispose();
  });

  it('the cell store takes no factor message for an error', () => {
    const cells = createCellStore();
    cells.reset(2);
    cells.onSlowMessage({ type: 'factor-end', session: 2, iterations: 1, stop: 'settled' });
    expect(cells.error()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- cells` fails: `t.r.refineOnFactors is not a function`, `c.refineOnFactors is not a function`, and `expected undefined to be null` (the cell store took the `factor-end` for an error).

- [ ] **Step 3: Implement**

In `apps/cala/src/workers/slow-types.ts`, after `SlowStopSettling`:

```ts
/** What one iteration of Refine on the factors did (`SlowLoop.refineOnFactors`). */
export interface FactorIteration {
  /** Counted from 1. */
  iteration: number;
  libraryVersion: number;
  cells: number;
  /** Frames the iteration read (the whole recording), and the fitting frames among them. */
  frames: number;
  fittingFrames: number;
  /** Refinements accepted. */
  accepted: number;
  /** Share of cells whose footprint correlates below `settleCorr` with the one before, and the median of `1 - r`. */
  changedShare: number;
  medianChange: number;
  /** Cells with a pixel whose valid share in some window is below 1 (up to rounding). */
  lowValid: number;
  /** Tiles with cells that had too few held-out frames to refine. */
  tilesSkipped: number;
  /** Wall time of the iteration, ms. */
  ms: number;
}

/** Why Refine on the factors ended. */
export type FactorStop = 'settled' | 'nothing-accepted' | 'cap' | 'stopped' | 'error';
export const FACTOR_STOPS: readonly FactorStop[] = [
  'settled',
  'nothing-accepted',
  'cap',
  'stopped',
  'error',
];

/** The settle stop and the cap of Refine on the factors (spec §5). */
export interface FactorRefineSettings {
  settleCorr: number;
  settleShare: number;
  maxIterations: number;
  /** Held-out frames per tile for the gate (0: what a tile's reservoir holds). */
  testFrames: number;
}

/**
 * Main thread -> slow worker: Refine on the factors of the run folder
 * `folder` (`f0.bin` .. `f<windows - 1>.bin`), which the slow worker opens
 * now and closes before its `factor-end`.
 */
export interface SlowRefineFactors extends FactorRefineSettings {
  type: 'refine-factors';
  session: number;
  folder: string;
  windows: number;
}

/** Main thread -> slow worker: stop Refine on the factors after its current iteration. */
export interface SlowStopFactors {
  type: 'stop-factors';
  session: number;
}
```

`MainToSlow`, before: `export type MainToSlow = SlowConnect | SlowReviewed | SlowLookbackPort | SlowStopSettling;` after:

```ts
export type MainToSlow =
  | SlowConnect
  | SlowReviewed
  | SlowLookbackPort
  | SlowStopSettling
  | SlowRefineFactors
  | SlowStopFactors;
```

`SlowToMain`, before: `  | { type: 'error'; session: number; message: string };` (the `SlowToMain` one, after the `library` member) after:

```ts
  | { type: 'error'; session: number; message: string }
  /** One iteration of Refine on the factors is done (its library went out just before). */
  | { type: 'factor-iteration'; session: number; report: FactorIteration }
  /** Refine on the factors ended; its files are closed. Sent on every path, refusals included. */
  | { type: 'factor-end'; session: number; iterations: number; stop: FactorStop; message?: string };
```

In `apps/cala/src/lib/cell-store.ts`, `onSlowMessage`, before: `    } else setError(msg.message);` after: `    } else if (msg.type === 'error') setError(msg.message);`.

In `apps/cala/src/lib/slow-runner.ts`: add to the imports from `'../workers/slow-types.ts'` the types `FactorIteration`, `FactorStop`, `SlowRefineFactors`, and `import type { FactorReader } from './window-store.ts';`. In `SlowLoopLike`, after `markAllDue?(): void;`:

```ts
  /** One Refine iteration on the factors (`SlowLoop.refineOnFactors`; absent in older fakes and builds). */
  refineOnFactors?(
    reader: Pick<FactorReader, 'windows' | 'read'>,
    settleCorr: number,
    settleShare: number,
    testFrames: number,
  ): Float64Array;
```

In `SlowRunnerDeps`, after `timer?: ...;`:

```ts
  /** Open the run's factor files for Refine on the factors (absent: refused). */
  openFactors?: (folder: string, windows: number) => Promise<FactorReader>;
```

After `cellStatusView`:

```ts
/** `SlowLoop.refineOnFactors` output as a report, and its settle code (0: not settled, 1: settled, 2: nothing accepted). */
export function factorIteration(
  iteration: number,
  r: ArrayLike<number>,
  ms: number,
): { report: FactorIteration; settle: number } {
  if (r.length < 10) throw new Error(`refineOnFactors returned ${r.length} values, expected 10.`);
  return {
    report: {
      iteration,
      libraryVersion: r[0],
      cells: r[1],
      frames: r[2],
      fittingFrames: r[3],
      accepted: r[4],
      changedShare: r[5],
      medianChange: r[6],
      lowValid: r[7],
      tilesSkipped: r[8],
      ms,
    },
    settle: r[9],
  };
}
```

In `SlowRunner`, after `private drainCapped = false;`:

```ts
  /** Refine on the factors in progress (its files are open); cleared only by its own end. */
  private factorRun: { session: number; stop: boolean } | null = null;
```

`handleReviewed`, before: `    if (msg.session !== this.session || !this.loop || this.ending || this.final || this.drain)` after: `    if (msg.session !== this.session || !this.loop || this.ending || this.final || this.drain || this.factorRun)`.

`end()`, before: `    if (!loop || this.final || this.ending || this.drain) return;` after: `    if (!loop || this.final || this.ending || this.drain || this.factorRun) return;`.

After `stopSettling`:

```ts
  /** Stop a running Refine on the factors after its current iteration. */
  stopFactors(session: number): void {
    if (this.factorRun?.session === session) this.factorRun.stop = true;
  }

  /** Why Refine on the factors cannot start now (null: it can). */
  private factorRefusal(msg: SlowRefineFactors): string | null {
    const loop = this.loop;
    if (msg.session !== this.session || !loop) return 'No slow loop to refine: run Discover first.';
    if (this.factorRun) return 'Refine on the factors is already running.';
    if (!this.final || this.ending || this.drain || this.busy.some((b) => b))
      return 'The slow loop has not published its final library yet.';
    if (!loop.refineOnFactors || !loop.setEditScope)
      return 'This build of the slow loop cannot refine on the factors.';
    if (!this.deps.openFactors) return 'This worker cannot read the factor files.';
    return null;
  }

  /**
   * Refine on the factors (`refine-factors`): one `refineOnFactors` call per
   * iteration on the run's factor files, a report and the published library
   * after each, until the footprints settle, `maxIterations` ran, the main
   * thread stops it (`stopFactors`) or a reset drops the loop; the last two
   * take effect between iterations, where it gives way (`defer`). Not queued
   * behind the port's messages, so a reset gets in. The files are open only
   * while it runs, and it always ends with `factor-end`, after closing them.
   */
  async refineOnFactors(msg: SlowRefineFactors): Promise<void> {
    const loop = this.loop;
    const refused = this.factorRefusal(msg);
    if (refused !== null || !loop) {
      this.deps.toMain.postMessage({
        type: 'factor-end',
        session: msg.session,
        iterations: 0,
        stop: 'error',
        message: refused ?? 'No slow loop to refine: run Discover first.',
      });
      return;
    }
    const run = { session: msg.session, stop: false };
    this.factorRun = run;
    let reader: FactorReader | null = null;
    let iterations = 0;
    let stop: FactorStop = 'error';
    let message: string | undefined;
    try {
      reader = await this.deps.openFactors!(msg.folder, msg.windows);
      if (this.loop !== loop || run.stop) {
        stop = 'stopped';
        return;
      }
      loop.setEditScope!('refine');
      this.scope = 'refine';
      this.run++;
      this.final = false;
      this.frame = 0;
      this.consumed = 0;
      this.status(0, 0);
      for (let it = 1; ; it++) {
        const t0 = this.now();
        const r = loop.refineOnFactors!(reader, msg.settleCorr, msg.settleShare, msg.testFrames);
        const { report, settle } = factorIteration(it, r, this.now() - t0);
        iterations = it;
        this.frame = report.frames;
        this.consumed = report.frames;
        this.publish(loop.finalize());
        this.deps.toMain.postMessage({ type: 'factor-iteration', session: msg.session, report });
        this.status(0, 0);
        if (settle !== 0) {
          stop = settle === 2 ? 'nothing-accepted' : 'settled';
          return;
        }
        if (it >= msg.maxIterations) {
          stop = 'cap';
          return;
        }
        // A stop or a reset gets in here, never inside an iteration.
        await new Promise<void>((resolve) => this.defer(resolve));
        if (this.loop !== loop || run.stop) {
          stop = 'stopped';
          return;
        }
      }
    } catch (err) {
      stop = 'error';
      message = err instanceof Error ? err.message : String(err);
    } finally {
      reader?.close();
      if (this.factorRun === run) this.factorRun = null;
      // The loop keeps the last published library (a refused iteration changed nothing).
      if (this.loop === loop && this.init) {
        this.final = true;
        this.status(0, 0);
      }
      this.deps.toMain.postMessage({
        type: 'factor-end',
        session: msg.session,
        iterations,
        stop,
        ...(message !== undefined ? { message } : {}),
      });
    }
  }
```

In `apps/cala/src/workers/slow-worker.ts`: imports `import { factorName } from '../lib/compress-runner.ts';` and `import { openFactorReader } from '../lib/window-store.ts';`. In `onmessage`, after the `stop-settling` branch:

```ts
// Not queued: it gives way between iterations, so a reset from the fast worker gets in.
if (data.type === 'refine-factors') {
  const r = runner;
  if (r) void r.refineOnFactors(data);
  else
    workerScope.postMessage({
      type: 'factor-end',
      session: data.session,
      iterations: 0,
      stop: 'error',
      message: 'The slow worker is not connected.',
    });
  return;
}
if (data.type === 'stop-factors') {
  runner?.stopFactors(data.session);
  return;
}
```

and in the `new SlowRunner({...})` deps, after `visits,`:

```ts
    // The run's factor files, opened without owning their folder.
    openFactors: (folder, windows) =>
      openFactorReader(
        folder,
        Array.from({ length: windows }, (_, i) => factorName(i)),
      ),
```

In `apps/cala/src/lib/slow-client.ts`: add `SlowRefineFactors` and `SlowStopFactors` to the type import; to `SlowClient` after `stopSettling`:

```ts
  /** Refine on the factors in the slow worker, on the files of `msg.folder`. */
  refineOnFactors(msg: Omit<SlowRefineFactors, 'type'>): void;
  /** Stop it after its current iteration. */
  stopFactors(session: number): void;
```

and to the returned object after `stopSettling(session) {...},`:

```ts
    refineOnFactors(msg) {
      worker.postMessage({ type: 'refine-factors', ...msg } satisfies SlowRefineFactors);
    },
    stopFactors(session) {
      worker.postMessage({ type: 'stop-factors', session } satisfies SlowStopFactors);
    },
```

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- cells` (all pass, the existing SlowRunner tests unchanged), `npx prettier --write` on the six files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/workers/slow-types.ts apps/cala/src/lib/slow-runner.ts apps/cala/src/workers/slow-worker.ts apps/cala/src/lib/slow-client.ts apps/cala/src/lib/cell-store.ts apps/cala/src/__tests__/cells.test.ts
git commit -m "feat(cala): the slow worker refines on the run's factor files one iteration at a time and always says when it closed them"
```

---

### Task 4: The factors of a live run, and the files a reader may open

**Files:**

- Modify: `apps/cala/src/lib/compress-store.ts` (`factorState`; `createCompressStore`: `jobSent`, `jobsOut`, `live`, `factors`; new `liveFactorsBlocked`, `LIVE_EXTRACT_READY`)
- Modify: `apps/cala/src/lib/factor-extract.ts` (new `FactorFilesLike`; `createPass2Factors`)
- Test: `apps/cala/src/__tests__/factor-extract.test.ts`

**Interfaces:**

- Consumes: `CompressClient.folder` (Task 2).
- Produces: `factorState(s, error, replayCompressing, frames, live = false): FactorState`; `CompressStore.live(): boolean`, `CompressStore.jobSent(job: number): void`, `CompressStore.jobsOut(): number`; `liveFactorsBlocked(state: FactorState, s: CompressStatus | null, compressionFailed = false): string | null`; `LIVE_EXTRACT_READY: string`; `interface FactorFilesLike extends ReplayCompressLike { state(frames: number): FactorState; files(frames: number): { folder: string; windows: number } | null; info(): { tiling: CompressTiling; meanRank: number } | null; origin(): 'replay' | 'discover'; pending(): number; compressionError(): string | null }`; `createPass2Factors(store, client: Pick<CompressClient, 'extract'> & Partial<Pick<CompressClient, 'folder'>>): Pass2Factors & FactorFilesLike`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/factor-extract.test.ts`, extend the import from `'../lib/compress-store.ts'` with `LIVE_EXTRACT_READY` and `liveFactorsBlocked`, and add at the end:

```ts
describe('the factors of a live run', () => {
  const d = (p: Partial<CompressStatus> = {}) => st({ source: 'discover', frames: 1200, ...p });

  it("are Discover's own windows, ready once the stream ended and every frame is compressed", () => {
    expect(factorState(null, null, false, 1200, true)).toBe('none');
    expect(factorState(d({ final: false, windows: 1, frames: 600 }), null, false, 1200, true)).toBe(
      'compressing',
    );
    expect(factorState(d({ pending: 1, frames: 600 }), null, false, 1200, true)).toBe(
      'compressing',
    );
    expect(factorState(d(), null, false, 1200, true)).toBe('ready');
    expect(factorState(d({ tiling: 'plain' }), null, false, 1200, true)).toBe('ready');
    // 600 k + 1 frames: the last window of one frame is not compressed.
    expect(factorState(d(), null, false, 1201, true)).toBe('unusable');
    expect(factorState(d(), 'QuotaExceededError', false, 1200, true)).toBe('unusable');
    // A file run never takes Discover's windows for its factors.
    expect(factorState(d(), null, false, 1200)).toBe('none');
  });

  it('say why Extract cannot read them yet, or nothing when it can', () => {
    expect(liveFactorsBlocked('ready', d())).toBeNull();
    expect(liveFactorsBlocked('compressing', d({ final: false, pending: 2 }))).toBe(
      "The stream's last windows are being compressed (2 waiting).",
    );
    expect(liveFactorsBlocked('compressing', null)).toBe(
      "The stream's last windows are being compressed.",
    );
    expect(liveFactorsBlocked('unusable', d(), true)).toBe(
      'The compression failed: this stream has no factors to read. The export keeps the live traces.',
    );
    expect(liveFactorsBlocked('unusable', d())).toBe(
      'The factors do not cover the stream (a last window of one frame is not compressed). The export keeps the live traces.',
    );
    expect(liveFactorsBlocked('none', null)).toBe(
      'This stream has no factors to read. The export keeps the live traces.',
    );
    expect(LIVE_EXTRACT_READY).toBe(
      'Extract reads the factors Discover wrote during the stream (seconds).',
    );
  });

  it("let a live run's store read Discover's windows, with their tiling", () => {
    const store = createCompressStore(undefined, () => true);
    store.reset(7);
    const f = createPass2Factors(store, { extract() {}, folder: 'run-x' });
    store.onMessage({ type: 'status', session: 7, status: d() });
    expect(store.live()).toBe(true);
    expect(f.state(1200)).toBe('ready');
    expect(f.info()).toEqual({ tiling: 'offset', meanRank: 3 });
    expect(f.origin()).toBe('discover');
    expect(f.files(1200)).toEqual({ folder: 'run-x', windows: 2 });
  });
});

describe('the factor files a reader may open', () => {
  it('only once the factors are ready and no Extract job reads them', async () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {}, folder: 'run-x' });
    expect(f.files(100)).toBeNull();
    store.onMessage({
      type: 'status',
      session: 7,
      status: st({ final: false, pending: 3, windows: 1 }),
    });
    expect(f.files(100)).toBeNull();
    expect(f.pending()).toBe(3);
    store.onMessage({ type: 'status', session: 7, status: st() });
    expect(f.files(100)).toEqual({ folder: 'run-x', windows: 2 });
    expect(f.origin()).toBe('replay');
    const job = f.extract(Uint8Array.of(1), () => {});
    expect(store.jobsOut()).toBe(1);
    expect(f.files(100)).toBeNull();
    store.onMessage({ type: 'extract-done', session: 7, job: 1, frames: 100, msPerFrame: 1 });
    await job;
    expect(store.jobsOut()).toBe(0);
    expect(f.files(100)).toEqual({ folder: 'run-x', windows: 2 });
  });

  it('count a job until the worker answers it, and forget jobs at a reset or a crashed worker', () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {}, folder: 'run-x' });
    void f.extract(Uint8Array.of(1), () => {}).catch(() => {});
    store.onMessage({ type: 'error', session: 3, job: 1, message: 'an earlier run' });
    expect(store.jobsOut()).toBe(1);
    store.onMessage({ type: 'error', session: 7, job: 1, message: 'out of memory' });
    expect(store.jobsOut()).toBe(0);
    void f.extract(Uint8Array.of(1), () => {}).catch(() => {});
    store.reset(8);
    expect(store.jobsOut()).toBe(0);
    void f.extract(Uint8Array.of(1), () => {}).catch(() => {});
    store.onMessage({ type: 'error', session: -1, message: 'The compress worker crashed.' });
    expect(store.jobsOut()).toBe(0);
    expect(f.compressionError()).toBe('The compress worker crashed.');
  });

  it('has no folder without a compress client that names one', () => {
    const store = createCompressStore();
    store.reset(7);
    store.onMessage({ type: 'status', session: 7, status: st() });
    expect(createPass2Factors(store, { extract() {} }).files(100)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- factor-extract` fails: `liveFactorsBlocked is not a function`, `store.live is not a function`, `f.files is not a function`, and `expected 'none' to be 'ready'` for the live `factorState` cases.

- [ ] **Step 3: Implement**

In `apps/cala/src/lib/compress-store.ts`, `factorState` becomes:

```ts
/**
 * ... (keep the existing comment) A live run (`live`) has no replay: its
 * factors are Discover's own windows, `ready` once the stream has ended,
 * none waits and they hold every recorded frame (a last window of one frame
 * is not compressed: `unusable`), on either tiling.
 */
export function factorState(
  s: CompressStatus | null,
  error: string | null,
  replayCompressing: boolean,
  frames: number,
  live = false,
): FactorState {
  if (error) return 'unusable';
  if (live) {
    if (!s || s.source !== 'discover') return 'none';
    if (s.final && s.pending === 0) return frames > 0 && s.frames === frames ? 'ready' : 'unusable';
    return 'compressing';
  }
  const replay = s !== null && s.source === 'replay';
  if (replay && s.final && s.pending === 0)
    return s.tiling === 'offset' && frames > 0 && s.frames === frames ? 'ready' : 'unusable';
  // A cancelled replay leaves a status without windows: that is not compressing.
  if (replayCompressing || (replay && (s.windows > 0 || s.pending > 0))) return 'compressing';
  return 'none';
}
```

After `extractSourceText`:

```ts
/** The Run panel's line under Extract on a live run whose factors are ready. */
export const LIVE_EXTRACT_READY =
  'Extract reads the factors Discover wrote during the stream (seconds).';

/**
 * Why a live run's Extract (and Refine on the factors) cannot read the
 * factors now; null when they can (`ready`).
 */
export function liveFactorsBlocked(
  state: FactorState,
  s: CompressStatus | null,
  compressionFailed = false,
): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'compressing':
      return `The stream's last windows are being compressed${s && s.pending > 0 ? ` (${s.pending} waiting)` : ''}.`;
    case 'unusable':
      return compressionFailed
        ? 'The compression failed: this stream has no factors to read. The export keeps the live traces.'
        : 'The factors do not cover the stream (a last window of one frame is not compressed). The export keeps the live traces.';
    default:
      return 'This stream has no factors to read. The export keeps the live traces.';
  }
}
```

In `createCompressStore`, after `const listeners = new Set<(m: ExtractMessage) => void>();`:

```ts
/** Extract jobs sent and not answered yet by the worker (a cancelled job runs on there, reading the files). */
const jobs = new Set<number>();
```

in `reset(next)`, after `abortJobs('The run was reset.', true);`: `jobs.clear();`. In `onMessage`, the job-error branch, before:

```ts
if (msg.job !== undefined) {
  if (msg.session === session) for (const l of [...listeners]) l(msg as ExtractMessage);
  return;
}
```

after:

```ts
if (msg.job !== undefined) {
  if (msg.session === session) {
    jobs.delete(msg.job);
    for (const l of [...listeners]) l(msg as ExtractMessage);
  }
  return;
}
// A crashed worker (-1) answers no job any more.
if (msg.session === -1) jobs.clear();
```

and the end of the `if (msg.type === 'status') ... else ...` chain gets an `extract-done` branch before the last `else`, so the chain ends:

```ts
      } else if (msg.type === 'backfilled') {
        setBackfill({ version: msg.version, frames: msg.frames, msPerFrame: msg.msPerFrame });
      } else if (msg.type === 'extract-done') {
        jobs.delete(msg.job);
        for (const l of [...listeners]) l(msg);
      } else for (const l of [...listeners]) l(msg);
```

`factors`, before: `factors: (frames: number): FactorState => factorState(status(), error(), mark() !== 0, frames),` after:

```ts
    factors: (frames: number): FactorState =>
      factorState(status(), error(), mark() !== 0, frames, isLive()),
    /** A live run (its factors are Discover's own). */
    live: (): boolean => isLive(),
    /** An Extract job went out (`Pass2Factors.extract`). */
    jobSent(job: number): void {
      jobs.add(job);
    },
    /** Extract jobs the worker has not answered: while any runs, no other context may open the factor files. */
    jobsOut: (): number => jobs.size,
```

In `apps/cala/src/lib/factor-extract.ts`, after `Pass2Factors`:

```ts
/** What Refine on the factors needs of the run's factors (`?refine=factors`). */
export interface FactorFilesLike extends ReplayCompressLike {
  state(frames: number): FactorState;
  /**
   * The factor files the slow worker may open now: once the factors are
   * ready (the compress worker has closed every file) and no Extract job
   * reads them. Null: not now, or no run folder is known.
   */
  files(frames: number): { folder: string; windows: number } | null;
  info(): { tiling: CompressTiling; meanRank: number } | null;
  /** Whose factors these are: a file's compression replay, or a live run's Discover. */
  origin(): 'replay' | 'discover';
  /** Windows waiting to be compressed. */
  pending(): number;
  /** The compression's error (null: none). */
  compressionError(): string | null;
}
```

`createPass2Factors`, signature before:

```ts
export function createPass2Factors(
  store: CompressStore,
  client: Pick<CompressClient, 'extract'>,
): Pass2Factors {
```

after:

```ts
export function createPass2Factors(
  store: CompressStore,
  client: Pick<CompressClient, 'extract'> & Partial<Pick<CompressClient, 'folder'>>,
): Pass2Factors & FactorFilesLike {
```

`info()`, before: `return s && s.source === 'replay' ? { tiling: s.tiling, meanRank: s.meanRank } : null;` after:

```ts
// A live run's factors are Discover's own windows.
return s && (s.source === 'replay' || store.live())
  ? { tiling: s.tiling, meanRank: s.meanRank }
  : null;
```

after `info() {...},` add:

```ts
    files(frames) {
      const s = store.status();
      if (!client.folder || !s || store.factors(frames) !== 'ready' || store.jobsOut() > 0)
        return null;
      return { folder: client.folder, windows: s.windows };
    },
    origin: () => (store.live() ? 'discover' : 'replay'),
    pending: () => store.status()?.pending ?? 0,
    compressionError: () => store.error(),
```

and in `extract`, before `client.extract(store.session(), job, library.slice());` add `store.jobSent(job);`.

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- factor-extract compress pass2-store` (all pass; the 4.1 tests unchanged), `npx prettier --write` on the three files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/compress-store.ts apps/cala/src/lib/factor-extract.ts apps/cala/src/__tests__/factor-extract.test.ts
git commit -m "feat(cala): a live run's factors are Discover's windows once every frame is compressed, and a reader opens them only while no Extract job does"
```

---

### Task 5: Live availability, the Refine readouts and the stage records

**Files:**

- Modify: `apps/cala/src/lib/run-stages.ts` (`StageInput`, `stageAvailability`, `StageRun`, new `LIVE_FACTORS_NOTE`, `LIVE_REFINE_OFF`, `FactorPhase`, `factorRefineRunningText`, `factorRefineDoneText`, `extractEndData`)
- Modify: `apps/cala/src/lib/pass2-store.ts` (`Pass2Result.factors` only)
- Modify: `apps/cala/src/lib/export.ts` (`stageMeta`; the header comment, "Stage sources (format version 7)")
- Modify: `apps/cala/src/lib/result-file.ts` (`stagesFromMeta`)
- Test: `apps/cala/src/__tests__/run-stages.test.ts`, `apps/cala/src/__tests__/export.test.ts`

**Interfaces:**

- Consumes: `FactorIteration`, `FactorStop`, `FACTOR_STOPS`, `FactorRefineSettings` (Task 3).
- Produces: `StageInput.liveFactors?: string | null`, `StageInput.refineOnFactors?: boolean`; `StageRun.factors?: 'replay' | 'discover'`, `.iterations?: number`, `.stop?: FactorStop`, `.changedShare?: number`; `Pass2Result.factors?: 'replay' | 'discover'`; `LIVE_FACTORS_NOTE`, `LIVE_REFINE_OFF`; `type FactorPhase = { kind: 'compress'; done: number; total: number } | { kind: 'wait'; for: 'compression' | 'extract'; pending: number } | { kind: 'iterate'; last: FactorIteration | null; stopping: boolean }`; `factorRefineRunningText(index: number, phase: FactorPhase, settings: Pick<FactorRefineSettings, 'maxIterations' | 'settleShare'>): string`; `factorRefineDoneText(run: StageRun): string`; export keys `factors`, `factors_note`, `iterations`, `stop`, `changed_share`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/run-stages.test.ts`, extend the import from `'../lib/run-stages.ts'` with `factorRefineDoneText`, `factorRefineRunningText`, `LIVE_FACTORS_NOTE`, `LIVE_REFINE_OFF`, and add `import type { FactorIteration } from '../workers/slow-types.ts';`. Add:

```ts
describe('stage availability of a live run with compression on', () => {
  const LIVE: StageInput = { ...READY, live: true, liveFactors: null };

  it('offers Extract once the stream ended and its factors are ready, Refine only with ?refine=factors', () => {
    expect(stageAvailability(LIVE)).toEqual({
      discover: null,
      refine: LIVE_REFINE_OFF,
      extract: null,
    });
    expect(stageAvailability({ ...LIVE, refineOnFactors: true }).refine).toBeNull();
    expect(stageAvailability({ ...LIVE, discover: 'running' }).extract).toBe(
      'Discover is running.',
    );
    expect(stageAvailability({ ...LIVE, discover: 'error' }).extract).toBe(
      'Extract runs after Discover finishes.',
    );
    const blocked = { ...LIVE, liveFactors: "The stream's last windows are being compressed." };
    expect(stageAvailability(blocked).extract).toBe(
      "The stream's last windows are being compressed.",
    );
    expect(stageAvailability({ ...blocked, refineOnFactors: true }).refine).toBe(
      "The stream's last windows are being compressed.",
    );
    expect(stageAvailability({ ...LIVE, cells: 0 }).extract).toMatch(/No cells/);
    expect(stageAvailability({ ...LIVE, refine: 'running', refineOnFactors: true }).extract).toBe(
      'Refine is running.',
    );
    expect(LIVE_REFINE_OFF).toBe(
      'A live stream has no file to replay: Refine runs on the factors only with ?refine=factors.',
    );
    expect(LIVE_FACTORS_NOTE).toBe(
      'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.',
    );
  });

  it('keeps the live note when compression is off, with or without the switch', () => {
    expect(stageAvailability({ ...READY, live: true, refineOnFactors: true })).toMatchObject({
      refine: LIVE_NOTE,
      extract: LIVE_NOTE,
    });
  });
});

describe('the readouts of Refine on the factors', () => {
  const S = { maxIterations: 20, settleShare: 0.02 };
  const it2: FactorIteration = {
    iteration: 2,
    libraryVersion: 9,
    cells: 40,
    frames: 1200,
    fittingFrames: 800,
    accepted: 5,
    changedShare: 0.04,
    medianChange: 0.003,
    lowValid: 0,
    tilesSkipped: 0,
    ms: 10,
  };

  it('say what a running one does', () => {
    expect(factorRefineRunningText(1, { kind: 'compress', done: 1200, total: 3000 }, S)).toBe(
      'Refine 1: preparing the factors: frame 1,200 / 3,000',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'compression', pending: 3 }, S)).toBe(
      'Refine 1: waiting for the factors (3 windows still to compress)',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'compression', pending: 0 }, S)).toBe(
      'Refine 1: waiting for the factors',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'extract', pending: 0 }, S)).toBe(
      'Refine 1: waiting for the last Extract on the factors to end',
    );
    expect(factorRefineRunningText(1, { kind: 'iterate', last: null, stopping: false }, S)).toBe(
      'Refine 1 on the factors: iteration 1 of at most 20',
    );
    expect(factorRefineRunningText(2, { kind: 'iterate', last: it2, stopping: true }, S)).toBe(
      'Refine 2 on the factors: iteration 2 of at most 20 done · 5 refinements accepted · 4.0% of cells still changing (settled below 2.0%) · median change 0.3% · stopping after this iteration',
    );
  });

  it('say how a finished one stopped', () => {
    const run = {
      stage: 'refine',
      index: 1,
      startedAt: '',
      endedAt: '',
      outcome: 'done',
      frames: 1200,
      cells: 40,
      libraryVersion: 9,
      footprintsRefined: 30,
      medianFootprintChange: 0.012,
      source: 'factors',
      iterations: 6,
      changedShare: 0.031,
    } as const;
    const tail = '30 of 40 footprints refined · median change of those 1.2%';
    expect(factorRefineDoneText({ ...run, stop: 'settled' })).toBe(
      `Refine 1 on the factors: settled after 6 iterations · ${tail}`,
    );
    expect(factorRefineDoneText({ ...run, iterations: 1, stop: 'nothing-accepted' })).toBe(
      `Refine 1 on the factors: settled after 1 iteration (the last accepted no refinement) · ${tail}`,
    );
    expect(factorRefineDoneText({ ...run, iterations: 20, stop: 'cap' })).toBe(
      `Refine 1 on the factors: stopped at the cap of 20 iterations without settling (3.1% of cells still changing) · ${tail}`,
    );
    expect(
      factorRefineDoneText({ ...run, outcome: 'cancelled', iterations: 4, stop: 'stopped' }),
    ).toBe(`Refine 1 on the factors (cancelled after 4 iterations): ${tail}`);
    expect(factorRefineDoneText({ ...run, outcome: 'error', iterations: 0, stop: 'error' })).toBe(
      `Refine 1 on the factors (stopped by an error after 0 iterations): ${tail}`,
    );
  });
});
```

and inside the describe "what the stage records carry when a stage ends":

```ts
it('a factor Extract says whose factors it read', () => {
  expect(extractEndData('done', store(result({ factors: 'discover' }), 'factors')).factors).toBe(
    'discover',
  );
  expect('factors' in extractEndData('done', store(result(), 'factors'))).toBe(false);
});
```

In `apps/cala/src/__tests__/export.test.ts`, inside the describe "stage records (format 7)":

```ts
it('say whose factors a stage read, and how Refine on the factors stopped, and read back', () => {
  const refine = stageMeta({
    ...base,
    stage: 'refine',
    source: 'factors',
    tiling: 'offset',
    factors: 'discover',
    iterations: 20,
    stop: 'cap',
    changedShare: 0.031,
  });
  expect(refine).toMatchObject({
    source: 'factors',
    factors: 'discover',
    factors_note:
      'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.',
    iterations: 20,
    stop: 'cap',
    changed_share: 0.031,
  });
  const file = stageMeta({ ...base, stage: 'extract', source: 'factors', factors: 'replay' });
  expect(file.factors).toBe('replay');
  expect('factors_note' in file).toBe(false);
  const raw = stageMeta({ ...base, stage: 'refine', source: 'raw' });
  for (const k of ['factors', 'factors_note', 'iterations', 'stop', 'changed_share'])
    expect(k in raw).toBe(false);
  expect(stagesFromMeta([refine, file, { ...raw, stop: 'unknown' }])).toMatchObject([
    { factors: 'discover', iterations: 20, stop: 'cap', changedShare: 0.031 },
    { factors: 'replay' },
    { source: 'raw' },
  ]);
  expect('stop' in stagesFromMeta([{ ...raw, stop: 'unknown' }])[0]).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- run-stages export` fails: `factorRefineRunningText is not a function`, `expected 'A live stream runs Discover only: ...' to be null`, and the export test's `factors` missing (`expected undefined to be 'replay'`).

- [ ] **Step 3: Implement**

In `apps/cala/src/lib/run-stages.ts`: add `import type { FactorIteration, FactorRefineSettings, FactorStop } from '../workers/slow-types.ts';`. In `StageInput`, after `replayBlocked: string | null;`:

```ts
  /**
   * A live run with compression on: why its factors cannot be read now (null:
   * they can). Absent: not a live run, or compression off (Discover only).
   */
  liveFactors?: string | null;
  /** `?refine=factors` (compression on): Refine reads the factors. */
  refineOnFactors?: boolean;
```

after `LIVE_NOTE`:

```ts
/** A live run with compression on: what its Extract and Refine read. */
export const LIVE_FACTORS_NOTE =
  'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.';

/** A live run's Refine without `?refine=factors`. */
export const LIVE_REFINE_OFF =
  'A live stream has no file to replay: Refine runs on the factors only with ?refine=factors.';
```

`stageAvailability`'s `after`, before:

```ts
const after = (stage: string): string | null => {
  if (i.live) return LIVE_NOTE;
  if (busy) return busy;
  if (i.discover !== 'done') return `${stage} runs after Discover finishes.`;
  if (i.replayBlocked) return i.replayBlocked;
  if (!i.finalLibrary) return 'Waiting for the final library.';
  if (i.cells === 0) return 'No cells were found.';
  return null;
};
```

after:

```ts
const after = (stage: string): string | null => {
  if (i.live) {
    // Compression off: a stream has nothing to read again.
    if (i.liveFactors === undefined) return LIVE_NOTE;
    if (stage === 'Refine' && !i.refineOnFactors) return LIVE_REFINE_OFF;
  }
  if (busy) return busy;
  if (i.discover !== 'done') return `${stage} runs after Discover finishes.`;
  if (i.replayBlocked) return i.replayBlocked;
  if (!i.finalLibrary) return 'Waiting for the final library.';
  if (i.cells === 0) return 'No cells were found.';
  if (i.live && i.liveFactors) return i.liveFactors;
  return null;
};
```

In `StageRun`, after `lowValid?: number;`:

```ts
  /** A factor stage: whose factors it read (`replay`: a file's compression replay; `discover`: a live run's Discover). */
  factors?: 'replay' | 'discover';
  /** Refine on the factors: iterations run, why it stopped, and the share of cells still changing after the last. */
  iterations?: number;
  stop?: FactorStop;
  changedShare?: number;
```

At the end of the file:

```ts
/** What a running Refine on the factors does (`RefineStore.phase`). */
export type FactorPhase =
  | { kind: 'compress'; done: number; total: number }
  | { kind: 'wait'; for: 'compression' | 'extract'; pending: number }
  | { kind: 'iterate'; last: FactorIteration | null; stopping: boolean };

/** `0.0123` -> `1.2%` (`n/a` when not a finite number). */
function pct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${(100 * v).toFixed(1)}%`;
}

const iterationsText = (n: number): string => `${n} iteration${n === 1 ? '' : 's'}`;

/** The Run panel's readout of a running Refine on the factors (Refine run `index`). */
export function factorRefineRunningText(
  index: number,
  phase: FactorPhase,
  settings: Pick<FactorRefineSettings, 'maxIterations' | 'settleShare'>,
): string {
  switch (phase.kind) {
    case 'compress':
      return `Refine ${index}: preparing the factors: frame ${phase.done.toLocaleString('en-US')} / ${phase.total.toLocaleString('en-US')}`;
    case 'wait':
      return phase.for === 'extract'
        ? `Refine ${index}: waiting for the last Extract on the factors to end`
        : `Refine ${index}: waiting for the factors${phase.pending > 0 ? ` (${phase.pending} windows still to compress)` : ''}`;
    default: {
      const l = phase.last;
      const head = l
        ? `Refine ${index} on the factors: iteration ${l.iteration} of at most ${settings.maxIterations} done · ${l.accepted} refinements accepted · ${pct(l.changedShare)} of cells still changing (settled below ${pct(settings.settleShare)}) · median change ${pct(l.medianChange)}`
        : `Refine ${index} on the factors: iteration 1 of at most ${settings.maxIterations}`;
      return phase.stopping ? `${head} · stopping after this iteration` : head;
    }
  }
}

/** The readout of a finished Refine on the factors (`run.source === 'factors'`). */
export function factorRefineDoneText(run: StageRun): string {
  const n = run.iterations ?? 0;
  const tail = `${run.footprintsRefined ?? 0} of ${run.cells} footprints refined · median change of those ${pct(run.medianFootprintChange)}`;
  const name = `Refine ${run.index} on the factors`;
  switch (run.stop) {
    case 'settled':
      return `${name}: settled after ${iterationsText(n)} · ${tail}`;
    case 'nothing-accepted':
      return `${name}: settled after ${iterationsText(n)} (the last accepted no refinement) · ${tail}`;
    case 'cap':
      return `${name}: stopped at the cap of ${iterationsText(n)} without settling (${pct(run.changedShare)} of cells still changing) · ${tail}`;
    case 'stopped':
      return `${name} (cancelled after ${iterationsText(n)}): ${tail}`;
    default:
      return `${name} (stopped by an error after ${iterationsText(n)}): ${tail}`;
  }
}
```

`extractEndData`, after `...(r?.meanRank !== undefined ? { meanRank: r.meanRank } : {}),` add `...(r?.factors ? { factors: r.factors } : {}),`.

In `apps/cala/src/lib/pass2-store.ts`, `Pass2Result`, after `minValid?: Float32Array;`:

```ts
  /** From the factors: whose they are (`replay`: a file's compression replay; `discover`: a live run's own). */
  factors?: 'replay' | 'discover';
```

In `apps/cala/src/lib/export.ts`: `import { LIVE_FACTORS_NOTE, type StageRun } from './run-stages.ts';` (replacing `import type { StageRun } from './run-stages.ts';`). In `stageMeta`, after `if (r.lowValid !== undefined) out.low_valid = r.lowValid;`:

```ts
if (r.factors) {
  out.factors = r.factors;
  if (r.factors === 'discover') out.factors_note = LIVE_FACTORS_NOTE;
}
if (r.iterations !== undefined) out.iterations = r.iterations;
if (r.stop) out.stop = r.stop;
if (finite(r.changedShare) !== null) out.changed_share = r.changedShare;
```

In the header comment, append to the "Stage sources (format version 7)" paragraph:

```text
 * A factor stage also says whose factors it read, `factors`: `replay` (a
 * file's compression replay, with the final calibration) or `discover` (a
 * live run's own windows, with the calibration of their time; then also
 * `factors_note`, the sentence the Run panel shows: they are not claimed to
 * meet the closeness gate). Refine on the factors adds `iterations`, `stop`
 * (`settled`, `nothing-accepted`, `cap`, `stopped`, `error`) and
 * `changed_share` (the share of cells still changing after the last
 * iteration). Added within format 7 (not released before them).
```

In `apps/cala/src/lib/result-file.ts`: `import { FACTOR_STOPS, type FactorStop } from '../workers/slow-types.ts';` and in `stagesFromMeta`, after `if (typeof x.low_valid === 'number') r.lowValid = x.low_valid;`:

```ts
if (x.factors === 'replay' || x.factors === 'discover') r.factors = x.factors;
if (typeof x.iterations === 'number') r.iterations = x.iterations;
if (FACTOR_STOPS.includes(x.stop as FactorStop)) r.stop = x.stop as FactorStop;
if (typeof x.changed_share === 'number') r.changedShare = x.changed_share;
```

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- run-stages export result-file` (all pass, "streams Discover only, with the note about loading a saved stream" unchanged), `npx prettier --write` on the six files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/run-stages.ts apps/cala/src/lib/pass2-store.ts apps/cala/src/lib/export.ts apps/cala/src/lib/result-file.ts apps/cala/src/__tests__/run-stages.test.ts apps/cala/src/__tests__/export.test.ts
git commit -m "feat(cala): a live run's stages wait for its factors, and the stage records say whose factors they read and how Refine on them stopped"
```

---

### Task 6: The Refine store's route on the factors

**Files:**

- Modify: `apps/cala/src/lib/refine-store.ts` (new exports; `RefineQcOptions.factorRefine`; `Ctx`; `makeCtx`; `pump`; `record`; `fail`; `run`; new `routeOf`, `runFactors`, `waitForFiles`, `iterate`, `onSlowMessage`, `finishFactors`, `recordFactors`, `release`; `cancel`; `clear`)
- Test: `apps/cala/src/__tests__/refine-store.test.ts`

**Interfaces:**

- Consumes: `FactorFilesLike` (Task 4); `SlowClient.refineOnFactors`, `SlowClient.stopFactors`, `FactorIteration`, `FactorStop`, `FactorRefineSettings`, `SlowToMain` (Task 3); `FactorPhase`, `StageRun` fields (Task 5); `startReplayPipeline`, `endOnce`, `NO_COMPRESS`.
- Produces: `FACTOR_REFINE: FactorRefineSettings` (`{ settleCorr: 0.99, settleShare: 0.02, maxIterations: 20, testFrames: 0 }`); `refineOnFactorsOn(params: URLSearchParams): boolean`; `interface RefineFactorsOptions { factors: FactorFilesLike; slow: Pick<SlowClient, 'refineOnFactors' | 'stopFactors'>; live(): boolean; lookback(): boolean; settings?: FactorRefineSettings }`; `RefineQcOptions.factorRefine?: RefineFactorsOptions`; `RefineStore.phase(): FactorPhase | null`, `.route(): 'raw' | 'factors'`, `.routeNote(): string | null`, `.onSlowMessage(msg: SlowToMain): void`, `.release(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/refine-store.test.ts`: change the refine-store import to also take `FACTOR_REFINE`, `refineOnFactorsOn`, `type RefineFactorsOptions`; add `import type { FactorState } from '../lib/compress-store.ts';`, `import type { FactorFilesLike } from '../lib/factor-extract.ts';`, and `FactorIteration` to the type import from `'../workers/slow-types.ts'`. Add a describe after "Refine store":

```ts
describe('Refine on the factors', () => {
  const report = (iteration: number, accepted = 3): FactorIteration => ({
    iteration,
    libraryVersion: 9 + iteration,
    cells: 4,
    frames: 12,
    fittingFrames: 8,
    accepted,
    changedShare: 0.05,
    medianChange: 0.01,
    lowValid: 0,
    tilesSkipped: 0,
    ms: 5,
  });

  /** Factor files in `state` (openable once ready and no job reads them), and a slow worker that records what it is sent. */
  function factorOpts(
    o: {
      state?: FactorState;
      live?: boolean;
      lookback?: boolean;
      jobs?: number;
      error?: string;
    } = {},
  ) {
    const sent: unknown[] = [];
    const calls: string[] = [];
    let state: FactorState = o.state ?? 'ready';
    let jobs = o.jobs ?? 0;
    const factors: FactorFilesLike = {
      state: () => state,
      replayCompress: () => {
        calls.push('compress');
        return state === 'none'
          ? {
              settings: { compress: true, compressTiling: 'offset', compressSession: 7 },
              ended: (ok) => void calls.push(`ended ${ok}`),
            }
          : { settings: {}, ended() {} };
      },
      keepProjection: () => void calls.push('projection'),
      files: () => (state === 'ready' && jobs === 0 ? { folder: 'run-x', windows: 3 } : null),
      info: () => ({ tiling: 'offset', meanRank: 4 }),
      origin: () => (o.live ? 'discover' : 'replay'),
      pending: () => 2,
      compressionError: () => o.error ?? null,
    };
    const options: RefineFactorsOptions = {
      factors,
      slow: {
        refineOnFactors: (m) => void sent.push(m),
        stopFactors: (s) => void sent.push({ stop: s }),
      },
      live: () => o.live === true,
      lookback: () => o.lookback === true,
    };
    return {
      options,
      sent,
      calls,
      setState: (s: FactorState) => void (state = s),
      setJobs: (n: number) => void (jobs = n),
    };
  }

  it('is switched on by refine=factors only', () => {
    expect(refineOnFactorsOn(new URLSearchParams('refine=factors&debug'))).toBe(true);
    expect(refineOnFactorsOn(new URLSearchParams(''))).toBe(false);
    expect(refineOnFactorsOn(new URLSearchParams('refine'))).toBe(false);
    expect(FACTOR_REFINE).toEqual({
      settleCorr: 0.99,
      settleShare: 0.02,
      maxIterations: 20,
      testFrames: 0,
    });
  });

  it('iterates on ready factors in the slow worker and logs the run with how it stopped', async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    expect(t.store.route()).toBe('factors');
    await t.store.run();
    expect(t.started).toHaveLength(0);
    expect(f.sent).toEqual([{ session: 7, folder: 'run-x', windows: 3, ...FACTOR_REFINE }]);
    expect(t.store.phase()).toEqual({ kind: 'iterate', last: null, stopping: false });
    t.store.onSlowMessage({ type: 'factor-iteration', session: 7, report: report(1) });
    expect(t.store.phase()).toMatchObject({ kind: 'iterate', last: { iteration: 1 } });
    expect([t.store.processed(), t.store.total()]).toEqual([1, FACTOR_REFINE.maxIterations]);
    t.store.onSlowMessage({ type: 'factor-iteration', session: 3, report: report(9) }); // another run
    t.store.onSlowMessage({ type: 'factor-iteration', session: 7, report: report(2, 1) });
    expect(t.store.status()).toBe('running');
    t.store.onSlowMessage({ type: 'factor-end', session: 7, iterations: 2, stop: 'settled' });
    expect(t.store.status()).toBe('done');
    expect(t.store.phase()).toBeNull();
    expect(t.log.last('refine')).toMatchObject({
      outcome: 'done',
      frames: 12,
      source: 'factors',
      tiling: 'offset',
      meanRank: 4,
      factors: 'replay',
      iterations: 2,
      stop: 'settled',
      refines: 4,
      refinesPerMin: null,
      changedShare: 0.05,
    });
  });

  it('ends at the cap as done, and says so in its record', async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    t.store.onSlowMessage({ type: 'factor-end', session: 7, iterations: 20, stop: 'cap' });
    expect(t.store.status()).toBe('done');
    expect(t.log.last('refine')).toMatchObject({ outcome: 'done', stop: 'cap', iterations: 20 });
  });

  it('makes the factors first with a replay that only compresses, then iterates once they are ready', async () => {
    const f = factorOpts({ state: 'none' });
    const proj = { spans: [] } as unknown as FovProjections;
    const t = setup({ refineQc: { factorRefine: f.options }, projection: proj });
    await t.store.run();
    expect(t.started[0].cells).toEqual({
      session: 0,
      discover: false,
      library: Uint8Array.of(5),
      projection: true,
      qc: false,
      compress: true,
      compressTiling: 'offset',
      compressSession: 7,
    });
    await until(() => t.store.phase()?.kind === 'wait');
    expect(f.calls).toEqual(['compress', 'projection', 'ended true']);
    expect(t.store.phase()).toEqual({ kind: 'wait', for: 'compression', pending: 2 });
    expect(f.sent).toEqual([]);
    f.setState('ready');
    await until(() => f.sent.length === 1);
    expect(t.store.status()).toBe('running');
    expect(t.store.phase()).toMatchObject({ kind: 'iterate' });
  });

  it('releases the compress mark when its compressing replay is cancelled', async () => {
    const f = factorOpts({ state: 'none' });
    const t = setup({ refineQc: { factorRefine: f.options }, hang: true });
    await t.store.run();
    t.store.cancel();
    expect(t.store.status()).toBe('cancelled');
    expect(f.calls).toEqual(['compress', 'ended false']);
    expect(t.stops).toEqual([{ keepSlow: true }]);
    expect(t.log.last('refine')).toMatchObject({
      outcome: 'cancelled',
      source: 'factors',
      stop: 'stopped',
      iterations: 0,
    });
  });

  it('waits for a cancelled Extract job to end before the slow worker opens the files', async () => {
    const f = factorOpts({ jobs: 1 });
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    expect(t.store.phase()).toEqual({ kind: 'wait', for: 'extract', pending: 0 });
    expect(f.sent).toEqual([]);
    f.setJobs(0);
    await until(() => f.sent.length === 1);
  });

  it('fails, without iterating, when the factors turn out unusable while it waits', async () => {
    const f = factorOpts({ state: 'compressing' });
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    f.setState('unusable');
    await until(() => t.store.status() === 'error');
    expect(t.store.error()).toBe(
      'Refine on the factors: the factors do not cover the recording. The next Refine replays the file.',
    );
    expect(f.sent).toEqual([]);
    expect(t.store.route()).toBe('raw');
  });

  it('stops after the current iteration when cancelled, and holds the files until the slow worker ends', async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    t.store.onSlowMessage({ type: 'factor-iteration', session: 7, report: report(1) });
    t.store.cancel();
    expect(t.store.status()).toBe('finishing');
    expect(t.store.phase()).toMatchObject({ kind: 'iterate', stopping: true });
    expect(f.sent.at(-1)).toEqual({ stop: 7 });
    expect(t.stops).toEqual([]);
    let released = false;
    void t.store.release().then(() => (released = true));
    await wait(5);
    expect(released).toBe(false);
    t.store.onSlowMessage({ type: 'factor-end', session: 7, iterations: 1, stop: 'stopped' });
    expect(t.store.status()).toBe('cancelled');
    await wait(1);
    expect(released).toBe(true);
    expect(t.log.last('refine')).toMatchObject({
      outcome: 'cancelled',
      stop: 'stopped',
      iterations: 1,
    });
  });

  it("counts a failed iteration as failed: a file's next Refine replays the file, until clear", async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    t.store.onSlowMessage({
      type: 'factor-end',
      session: 7,
      iterations: 0,
      stop: 'error',
      message:
        'refineOnFactors: invalid trace config: factor window 1: truncated or corrupt factor file',
    });
    expect(t.store.status()).toBe('error');
    expect(t.store.error()).toBe(
      'refineOnFactors: invalid trace config: factor window 1: truncated or corrupt factor file',
    );
    expect(t.log.last('refine')).toMatchObject({ outcome: 'error', stop: 'error' });
    expect(t.store.route()).toBe('raw');
    expect(t.store.routeNote()).toBe(
      'Refine replays the file: the last Refine on the factors failed.',
    );
    t.store.clear();
    expect(t.store.route()).toBe('factors');
    expect(t.store.routeNote()).toBeNull();
  });

  it('replays the file after a look-back Discover, or when the factors cannot be read, and says why', async () => {
    const lb = factorOpts({ lookback: true });
    const t = setup({ refineQc: { factorRefine: lb.options } });
    expect(t.store.route()).toBe('raw');
    expect(t.store.routeNote()).toBe(
      'Refine replays the file: Refine on the factors does not run after a look-back Discover (its slow loop runs the cluster replay).',
    );
    await t.store.run();
    expect(t.started[0].cells).toMatchObject({ refine: true, discover: true });
    expect(lb.sent).toEqual([]);
    await until(() => t.store.status() === 'done');
    expect(t.log.last('refine')?.source).toBe('raw');
    const short = setup({ refineQc: { factorRefine: factorOpts({ state: 'unusable' }).options } });
    expect(short.store.routeNote()).toBe(
      'Refine replays the file: the factors do not cover the recording.',
    );
    const failed = setup({
      refineQc: {
        factorRefine: factorOpts({ state: 'unusable', error: 'QuotaExceededError' }).options,
      },
    });
    expect(failed.store.routeNote()).toBe('Refine replays the file: the compression failed.');
  });

  it("reads the factors on a live run, also after a failure, and records them as Discover's", async () => {
    const f = factorOpts({ live: true });
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    t.store.onSlowMessage({
      type: 'factor-end',
      session: 7,
      iterations: 0,
      stop: 'error',
      message: 'x',
    });
    expect(t.store.route()).toBe('factors');
    await t.store.run();
    expect(f.sent).toHaveLength(2);
    t.store.onSlowMessage({ type: 'factor-end', session: 7, iterations: 3, stop: 'settled' });
    expect(t.log.last('refine')).toMatchObject({ factors: 'discover', stop: 'settled' });
  });

  it('a new Discover stops the iterations and release waits for the slow worker', async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    t.store.clear();
    expect(t.store.status()).toBe('idle');
    expect(f.sent.at(-1)).toEqual({ stop: 7 });
    let released = false;
    const r = t.store.release().then(() => (released = true));
    await wait(5);
    expect(released).toBe(false);
    // A late iteration of the stopped run changes nothing.
    t.store.onSlowMessage({ type: 'factor-iteration', session: 7, report: report(1) });
    expect(t.store.phase()).toBeNull();
    t.store.onSlowMessage({ type: 'factor-end', session: 7, iterations: 1, stop: 'stopped' });
    await r;
    expect(t.store.status()).toBe('idle');
    await expect(t.store.release()).resolves.toBeUndefined();
  });

  it('a crashed slow worker frees the files and ends the run', async () => {
    const f = factorOpts();
    const t = setup({ refineQc: { factorRefine: f.options } });
    await t.store.run();
    const r = t.store.release();
    t.store.onSlowMessage({ type: 'error', session: -1, message: 'The slow worker crashed.' });
    await r;
    expect(t.store.status()).toBe('error');
    expect(t.store.error()).toBe('Cell discovery stopped: The slow worker crashed.');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- refine-store` fails: `FACTOR_REFINE` undefined, `t.store.route is not a function`, `t.store.onSlowMessage is not a function`.

- [ ] **Step 3: Implement**

In `apps/cala/src/lib/refine-store.ts`, imports: add

```ts
import type { FactorFilesLike } from './factor-extract.ts';
import type { FactorPhase } from './run-stages.ts';
import type { RunRecord } from './run-record.ts';
import type { SlowClient } from './slow-client.ts';
import type {
  FactorIteration,
  FactorRefineSettings,
  FactorStop,
  LibraryView,
  SlowStatus,
  SlowToMain,
} from '../workers/slow-types.ts';
```

(replacing `import type { LibraryView } from '../workers/slow-types.ts';`). After `REFINE_FORWARD_BUFFERS`:

```ts
/** Refine on the factors: the spec's settle stop and cap (§5), qc_eval's defaults. */
export const FACTOR_REFINE: FactorRefineSettings = {
  settleCorr: 0.99,
  settleShare: 0.02,
  maxIterations: 20,
  testFrames: 0,
};

/** `?refine=factors`: Refine reads the factors (off by default: Refine replays the file). */
export function refineOnFactorsOn(params: URLSearchParams): boolean {
  return params.get('refine') === 'factors';
}

/** What Refine on the factors needs (compression on and `?refine=factors`). */
export interface RefineFactorsOptions {
  factors: FactorFilesLike;
  slow: Pick<SlowClient, 'refineOnFactors' | 'stopFactors'>;
  /** A live run: the factors are Discover's own and there is no file to replay. */
  live(): boolean;
  /** Discover ran with look-back: its slow loop runs the cluster replay, which Refine on the factors refuses until phase 3b. */
  lookback(): boolean;
  /** The settle stop and cap (default `FACTOR_REFINE`). */
  settings?: FactorRefineSettings;
}
```

In `RefineQcOptions`, after `compress?: ReplayCompressLike;`:

```ts
  /** `?refine=factors`: Refine reads the factors (absent: Refine replays the file). */
  factorRefine?: RefineFactorsOptions;
```

In `createRefineStore`, after the `series` signal:

```ts
/** What a running Refine on the factors does (null: none runs). */
const [phase, setPhase] = createSignal<FactorPhase | null>(null);
/** The last Refine on the factors failed: a file's next Refine replays the file, until `clear`. */
const [factorFailed, setFactorFailed] = createSignal(false);
/** The slow worker holds the factor files of this session until its `factor-end`. */
let out: { session: number; done: Promise<void>; release: () => void } | null = null;
```

`Ctx` gains, after `pumping: boolean;`:

```ts
    /** `raw`: a replay into the slow loop; `factors`: Refine on the factors. */
    route: 'raw' | 'factors';
    /** What the run does now: a replay into the slow loop, a replay that only compresses, waiting for the factor files, the iterations. */
    mode: 'refine' | 'compress' | 'wait' | 'iterate';
    /** The iterations' reports (Refine on the factors). */
    reports: FactorIteration[];
    /** The session the iterations run under. */
    slowSession: number;
```

After `dropTraces`, a constructor of the context (both routes use it):

```ts
function makeCtx(
  rec: RunRecord,
  plan1: PipelinePlan,
  st: SlowStatus,
  before: LibraryView,
  route: Ctx['route'],
): Ctx {
  return {
    frames: rec.frames,
    batch: plan1.batchSize,
    run: (st.run ?? 1) + 1,
    before,
    refines0: st.counters.refines,
    meter: new ThroughputMeter(),
    done: 0,
    tracker: new RefineTracker(before, cells.fps()),
    seriesAt: -Infinity,
    traces: null,
    ids: before.ids.slice(),
    compressed: false,
    ended: NO_COMPRESS.ended,
    pumping: false,
    route,
    mode: route === 'raw' ? 'refine' : 'compress',
    reports: [],
    slowSession: -1,
  };
}
```

`record(ctx, outcome)`: insert as its first lines (before `sample(ctx, true);`):

```ts
if (ctx.route === 'factors') {
  recordFactors(ctx, outcome, outcome === 'cancelled' ? 'stopped' : 'error', ctx.reports.length);
  return;
}
```

`fail`, before:

```ts
if (ctx) {
  if (ctx.pumping) ctx.ended(false);
  record(ctx, 'error');
  dropTraces(ctx);
}
void client.stopPipeline({ keepSlow: true }).catch(() => {});
```

after:

```ts
setPhase(null);
if (ctx) {
  if (ctx.pumping) ctx.ended(false);
  record(ctx, 'error');
  dropTraces(ctx);
  if (ctx.route === 'factors' && ctx.mode === 'iterate') setFactorFailed(true);
}
// Waiting or iterating, no pipeline of this run is running.
if (!ctx || ctx.mode === 'refine' || ctx.mode === 'compress')
  void client.stopPipeline({ keepSlow: true }).catch(() => {});
```

`pump`: the lead check, before:

```ts
      if (ctx.done + (inFlight + 1) * ctx.batch - slowTaken(ctx) > REFINE_SLOW_LEAD * ctx.batch) {
```

after (a replay that only compresses feeds no slow loop, so it has no lead to keep):

```ts
      if (
        ctx.mode === 'refine' &&
        ctx.done + (inFlight + 1) * ctx.batch - slowTaken(ctx) > REFINE_SLOW_LEAD * ctx.batch
      ) {
```

In the batch branch, before: `            sample(ctx);` after:

```ts
if (ctx.mode === 'refine') sample(ctx);
else setPhase({ kind: 'compress', done: ctx.done, total: ctx.frames });
```

In the `done` branch, before:

```ts
if (ctx.compressed && step.projection) options.compress?.keepProjection(step.projection);
ctx.ended(true);
setStatus('finishing');
awaitFinal(gen, ctx);
```

after:

```ts
const keep = ctx.mode === 'compress' ? options.factorRefine?.factors : options.compress;
if (ctx.compressed && step.projection) keep?.keepProjection(step.projection);
ctx.ended(true);
if (ctx.mode === 'refine') {
  setStatus('finishing');
  awaitFinal(gen, ctx);
} else if (options.factorRefine) waitForFiles(gen, ctx, options.factorRefine);
```

`run()`: after `const rec = pipeline.record();` and `const flatMap = pipeline.flatFieldMap();` insert:

```ts
if (routeOf(rec.frames).route === 'factors' && options.factorRefine) {
  await runFactors(
    gen,
    makeCtx(rec, plan1, st, before, 'factors'),
    plan1,
    bytes,
    options.factorRefine,
  );
  return;
}
```

and replace the raw route's `const ctx: Ctx = { ... };` object literal with:

```ts
const ctx = makeCtx(rec, plan1, st, before, 'raw');
ctx.compressed = comp.settings.compress === true;
ctx.ended = endOnce(comp.ended);
```

New functions, after `run()`:

```ts
/** Where the next Refine reads, and why a file run with the switch on replays the file. */
function routeOf(frames: number): { route: 'raw' | 'factors'; note: string | null } {
  const o = options.factorRefine;
  if (!o) return { route: 'raw', note: null };
  if (o.live()) return { route: 'factors', note: null };
  if (o.lookback())
    return {
      route: 'raw',
      note: 'Refine replays the file: Refine on the factors does not run after a look-back Discover (its slow loop runs the cluster replay).',
    };
  if (factorFailed())
    return {
      route: 'raw',
      note: 'Refine replays the file: the last Refine on the factors failed.',
    };
  if (o.factors.state(frames) === 'unusable')
    return {
      route: 'raw',
      note: o.factors.compressionError()
        ? 'Refine replays the file: the compression failed.'
        : 'Refine replays the file: the factors do not cover the recording.',
    };
  return { route: 'factors', note: null };
}

/**
 * Refine on the factors: a replay that only compresses when there are no
 * factors yet, then the iterations in the slow worker once it may open
 * the files (`waitForFiles`).
 */
async function runFactors(
  gen: number,
  ctx: Ctx,
  plan1: PipelinePlan,
  bytes: Uint8Array,
  o: RefineFactorsOptions,
): Promise<void> {
  current = ctx;
  setTotal(ctx.frames);
  setSeries(null);
  log.begin('refine');
  if (o.factors.state(ctx.frames) !== 'none') {
    waitForFiles(gen, ctx, o);
    return;
  }
  const comp = o.factors.replayCompress(ctx.frames);
  ctx.compressed = comp.settings.compress === true;
  ctx.ended = endOnce(comp.ended);
  if (!ctx.compressed) {
    waitForFiles(gen, ctx, o);
    return;
  }
  setPhase({ kind: 'compress', done: 0, total: ctx.frames });
  try {
    await startReplayPipeline(
      client,
      plan1,
      { session: 0, discover: false, library: bytes, projection: true, ...comp.settings },
      { frames: ctx.frames, record: pipeline.record(), flatField: pipeline.flatFieldMap() },
    );
    if (gen !== generation) return;
    ctx.pumping = true;
    pump(gen, ctx);
  } catch (err) {
    fail(gen, ctx, err instanceof Error ? err.message : String(err));
  } finally {
    if (!ctx.pumping) ctx.ended(false);
  }
}

/** Wait until the slow worker may open the factor files (decision 1), then start the iterations. */
function waitForFiles(gen: number, ctx: Ctx, o: RefineFactorsOptions): void {
  if (gen !== generation) return;
  ctx.mode = 'wait';
  const state = o.factors.state(ctx.frames);
  if (state === 'unusable') {
    const err = o.factors.compressionError();
    fail(
      gen,
      ctx,
      o.live()
        ? 'Refine on the factors: the factors of this stream cannot be read.'
        : err
          ? `Refine on the factors: the compression failed (${err}). The next Refine replays the file.`
          : 'Refine on the factors: the factors do not cover the recording. The next Refine replays the file.',
    );
    return;
  }
  const files = o.factors.files(ctx.frames);
  if (files) {
    iterate(ctx, o, files);
    return;
  }
  setPhase(
    state === 'ready'
      ? { kind: 'wait', for: 'extract', pending: 0 }
      : { kind: 'wait', for: 'compression', pending: o.factors.pending() },
  );
  setTimeout(() => waitForFiles(gen, ctx, o), WAIT_MS);
}

/** Hand the files to the slow worker; the run ends at its `factor-end` (`onSlowMessage`). */
function iterate(
  ctx: Ctx,
  o: RefineFactorsOptions,
  files: { folder: string; windows: number },
): void {
  const settings = o.settings ?? FACTOR_REFINE;
  const session = cells.session();
  ctx.mode = 'iterate';
  ctx.slowSession = session;
  setTotal(settings.maxIterations);
  setProcessed(0);
  setPhase({ kind: 'iterate', last: null, stopping: false });
  let release = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  out = { session, done, release };
  o.slow.refineOnFactors({ session, folder: files.folder, windows: files.windows, ...settings });
}

/** The messages of the slow worker about Refine on the factors (the app passes every slow message). */
function onSlowMessage(msg: SlowToMain): void {
  if (msg.type === 'error') {
    // A crashed slow worker answers nothing more: its files are free, the run is over.
    if (msg.session !== -1) return;
    if (out) {
      out.release();
      out = null;
    }
    const ctx = current;
    if (ctx?.mode === 'iterate') fail(generation, ctx, `Cell discovery stopped: ${msg.message}`);
    return;
  }
  if (msg.type !== 'factor-iteration' && msg.type !== 'factor-end') return;
  const ctx = current;
  const mine = ctx !== null && ctx.mode === 'iterate' && ctx.slowSession === msg.session;
  if (msg.type === 'factor-iteration') {
    if (!mine) return;
    ctx.reports.push(msg.report);
    setProcessed(msg.report.iteration);
    setPhase((p) => ({
      kind: 'iterate',
      last: msg.report,
      stopping: p?.kind === 'iterate' && p.stopping,
    }));
    return;
  }
  if (out && out.session === msg.session) {
    out.release();
    out = null;
  }
  if (mine) finishFactors(ctx, msg.stop, msg.iterations, msg.message);
}

function finishFactors(ctx: Ctx, stop: FactorStop, iterations: number, message?: string): void {
  const outcome = stop === 'stopped' ? 'cancelled' : stop === 'error' ? 'error' : 'done';
  recordFactors(ctx, outcome, stop, iterations);
  current = null;
  setPhase(null);
  if (outcome === 'error') {
    setFactorFailed(true);
    setError(message ?? 'Refine on the factors failed.');
  }
  setStatus(outcome);
}

/** Close the run in the log: what it changed, whose factors it read, how it stopped. */
function recordFactors(
  ctx: Ctx,
  outcome: 'done' | 'cancelled' | 'error',
  stop: FactorStop,
  iterations: number,
): void {
  const o = options.factorRefine;
  const after = cells.library();
  const change = after ? footprintChange(ctx.before, after) : { refined: 0, median: null };
  const last = ctx.reports.at(-1);
  const info = o?.factors.info() ?? null;
  log.end('refine', outcome, {
    frames: ctx.frames,
    cells: after?.ids.length ?? 0,
    libraryVersion: after?.version ?? 0,
    refines: ctx.reports.reduce((s, r) => s + r.accepted, 0),
    // Iterations over the whole recording are not a rate over its minutes.
    refinesPerMin: null,
    footprintsRefined: change.refined,
    medianFootprintChange: change.median,
    source: 'factors',
    ...(info ? { tiling: info.tiling, meanRank: info.meanRank } : {}),
    ...(o ? { factors: o.factors.origin() } : {}),
    iterations,
    stop,
    ...(last ? { changedShare: last.changedShare } : {}),
  });
}

/** Resolves once the slow worker holds no factor file of this store (a running Refine on the factors is stopped first). */
function release(): Promise<void> {
  if (!out) return Promise.resolve();
  options.factorRefine?.slow.stopFactors(out.session);
  return out.done;
}
```

`cancel()`, replace the body with:

```ts
function cancel(): void {
  const st = status();
  if (st !== 'running' && st !== 'finishing') return;
  const ctx = current;
  // The iterations: the slow worker stops after the current one and holds the files until then.
  if (ctx?.mode === 'iterate') {
    if (out) options.factorRefine?.slow.stopFactors(out.session);
    setStatus('finishing');
    setPhase((p) => (p?.kind === 'iterate' ? { ...p, stopping: true } : p));
    return;
  }
  generation++;
  inFlight = 0;
  setStatus('cancelled');
  setPhase(null);
  if (ctx) {
    if (ctx.pumping) ctx.ended(false);
    record(ctx, 'cancelled');
    dropTraces(ctx);
  }
  if (!ctx || ctx.mode !== 'wait') void client.stopPipeline({ keepSlow: true }).catch(() => {});
}
```

`clear()` becomes:

```ts
/** Forget the state (a new Discover run, another recording); iterations in the slow worker are stopped (`release` waits for them). */
function clear(): void {
  if (status() === 'running' || status() === 'finishing') generation++;
  if (current) {
    if (current.pumping) current.ended(false);
    dropTraces(current);
  }
  if (out) options.factorRefine?.slow.stopFactors(out.session);
  current = null;
  setStatus('idle');
  setError(null);
  setProcessed(0);
  setTotal(0);
  setFps(0);
  setSeries(null);
  setPhase(null);
  setFactorFailed(false);
}
```

The returned object becomes:

```ts
return {
  status,
  processed,
  total,
  fps,
  error,
  series,
  /** What a running Refine on the factors does (null: none runs). */
  phase,
  /** Where the next Refine reads (`?refine=factors`: the factors, unless `routeNote` says why not). */
  route: (): 'raw' | 'factors' => routeOf(pipeline.record().frames).route,
  routeNote: (): string | null => routeOf(pipeline.record().frames).note,
  run,
  cancel,
  clear,
  release,
  onSlowMessage,
};
```

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- refine-store` (all pass, the raw-route tests unchanged), `npx prettier --write` on the two files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/refine-store.ts apps/cala/src/__tests__/refine-store.test.ts
git commit -m "feat(cala): with ?refine=factors Refine makes the factors if needed and refines on them until settled, cancelled between iterations"
```

---

### Task 7: Extract on a live run, and a Discover start that waits for the factor files

**Files:**

- Modify: `apps/cala/src/lib/pass2-store.ts` (`createPass2Store`'s seventh parameter, `blockedReason`, `run`, `runOnFactors`, `resultOf`)
- Modify: `apps/cala/src/lib/pipeline-store.ts` (new `PipelineStartHooks`; `createPipelineStore`'s eleventh parameter; `start`)
- Test: `apps/cala/src/__tests__/pass2-store.test.ts`, `apps/cala/src/__tests__/pipeline.test.ts`

**Interfaces:**

- Consumes: `Pass2Result.factors` (Task 5); `CompressTiling`.
- Produces: `createPass2Store(client, pipeline, cells, clock?, blocked?, factors?, live?: { on(): boolean; blocked(): string | null })`; `interface PipelineStartHooks { beforeStart?: () => Promise<void>; liveTiling?: CompressTiling }`; `createPipelineStore(..., lookbackFeed?, hooks: PipelineStartHooks = {})`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/pass2-store.test.ts`, extend `setup`'s options with `live?: { on(): boolean; blocked(): string | null };` and its store line, before: `store: createPass2Store(client, pipeline, cells, undefined, undefined, opts.factors),` after: `store: createPass2Store(client, pipeline, cells, undefined, undefined, opts.factors, opts.live),`. Add inside "Extract (pass 2) store":

```ts
const LIVE = { on: () => true, blocked: () => null };

it("reads the factors of a live run, as Discover's", async () => {
  const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
  const { store, started } = setup({ factors: f, live: LIVE });
  expect(store.blockedReason()).toBeNull();
  await store.run();
  await settle();
  expect(store.status()).toBe('done');
  expect(started).toHaveLength(0);
  expect(calls).toEqual(['extract 3']);
  expect(store.result()).toMatchObject({ source: 'factors', factors: 'discover' });
});

it("marks a file's factor Extract as reading the replay's factors", async () => {
  const { f } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
  const { store } = setup({ factors: f });
  await store.run();
  await settle();
  expect(store.result()?.factors).toBe('replay');
});

it('refuses to replay a stream, and says why the factors cannot be read yet', async () => {
  const why = "The stream's last windows are being compressed (2 waiting).";
  const { f, calls } = fakeFactors('compressing');
  const { store, started } = setup({ factors: f, live: { on: () => true, blocked: () => why } });
  expect(store.blockedReason()).toBe(why);
  await store.run();
  expect(store.status()).toBe('error');
  expect(store.error()).toBe(why);
  expect(started).toHaveLength(0);
  expect(calls).toEqual([]);
  const ready = fakeFactors('ready', [win(0, 4), win(4, 4)]);
  const raw = setup({ factors: ready.f, live: LIVE });
  await raw.store.run(undefined, 'raw');
  expect(raw.store.status()).toBe('error');
  expect(raw.store.error()).toBe(
    'A live stream has no file to replay: Extract reads the factors once they are ready.',
  );
  expect(raw.started).toHaveLength(0);
});

it('reads the factors of a live run again after a factor Extract failed', async () => {
  const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)], { fail: 'out of memory' });
  const { store, started } = setup({ factors: f, live: LIVE });
  await store.run();
  await settle();
  expect(store.status()).toBe('error');
  expect(store.factorsFailed()).toBe(true);
  await store.run();
  await settle();
  expect(calls).toEqual(['extract 3', 'extract 3']);
  expect(started).toHaveLength(0);
});
```

In `apps/cala/src/__tests__/pipeline.test.ts`, inside "pipeline store backpressure":

```ts
it('waits for the hook before it starts the workers, and drops a start replaced meanwhile', async () => {
  const { client } = manualClient();
  await createRoot(async (dispose) => {
    let release = () => {};
    const hooks = {
      beforeStart: vi.fn(() => new Promise<void>((r) => (release = r))),
    };
    const args = [
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
    ] as const;
    const store = createPipelineStore(client, {}, ...args, hooks);
    const first = store.start();
    await flush();
    expect(store.status()).toBe('starting');
    expect(client.startPipeline).not.toHaveBeenCalled();
    release();
    await first;
    expect(client.startPipeline).toHaveBeenCalledTimes(1);
    // Stopped while it waits: that start never reaches the workers.
    const second = store.start();
    await flush();
    store.stop();
    release();
    await second;
    expect(client.startPipeline).toHaveBeenCalledTimes(1);
    expect(hooks.beforeStart).toHaveBeenCalledTimes(2);
    dispose();
  });
});

it("compresses a live stream's Discover on the tiles it is given, a file's on plain tiles", async () => {
  const { client } = manualClient();
  await createRoot(async (dispose) => {
    let live = true;
    const flat = {
      identity: () => ({ width: 4, height: 4, folder: 'x', ...(live ? { live: true } : {}) }),
    };
    const args = [
      undefined,
      undefined,
      undefined,
      undefined,
      flat,
      undefined,
      { reset() {} },
      undefined,
    ] as const;
    const store = createPipelineStore(client, {}, ...args, { liveTiling: 'offset' });
    await store.start();
    expect((client.startPipeline.mock.calls[0] as unknown[])[1]).toMatchObject({
      compress: true,
      compressTiling: 'offset',
    });
    live = false;
    await store.start();
    const file = (client.startPipeline.mock.calls[1] as unknown[])[1] as object;
    expect(file).toMatchObject({ compress: true });
    expect('compressTiling' in file).toBe(false);
    dispose();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- pass2-store pipeline` fails: the live Extract result has no `factors` (`expected undefined to be 'discover'`), the blocked text is null, `startPipeline` was called before the hook resolved, and `compressTiling` is missing.

- [ ] **Step 3: Implement**

In `apps/cala/src/lib/pass2-store.ts`, `createPass2Store`, after the `factors?: Pass2Factors,` parameter:

```ts
  /**
   * A live run with compression on: Extract reads Discover's factors or
   * nothing (a stream has no file to replay); `blocked` says why it cannot
   * read them now (null: it can).
   */
  live?: { on(): boolean; blocked(): string | null },
```

`blockedReason`, before the final `return null;`: `    if (live?.on()) return live.blocked();`.

`run()`, before:

```ts
// After a failed factor Extract the file is replayed, so a repeating failure is no dead end.
const onFactors = factors !== undefined && from === 'auto' && state === 'ready' && !factorsFailed();
```

after:

```ts
// After a failed factor Extract the file is replayed, so a repeating failure is no dead
// end; a stream has no file and reads the factors again.
const isLive = live?.on() === true;
const onFactors =
  factors !== undefined && from === 'auto' && state === 'ready' && (isLive || !factorsFailed());
if (isLive && !onFactors) {
  setError('A live stream has no file to replay: Extract reads the factors once they are ready.');
  setStatus('error');
  return;
}
```

the call, before: `      await runOnFactors(gen, ctx, factors, bytes);` after: `      await runOnFactors(gen, ctx, factors, bytes, isLive ? 'discover' : 'replay');`. `runOnFactors`'s signature gains `origin: 'replay' | 'discover',` after `bytes: Uint8Array,`, and in its `setResult(resultOf(ctx, { ... }))` add `factors: origin,` after `source: 'factors',`. `resultOf`'s `extra` type, before: `extra: Pick<Pass2Result, 'projection' | 'source' | 'tiling' | 'meanRank' | 'minValid'>,` after: `extra: Pick<Pass2Result, 'projection' | 'source' | 'tiling' | 'meanRank' | 'minValid' | 'factors'>,`.

In `apps/cala/src/lib/pipeline-store.ts`: `import type { CompressTiling } from '../workers/compress-types.ts';`; after `FlatFieldStoreOptions`:

```ts
/** What other stages ask of a Discover start. */
export interface PipelineStartHooks {
  /**
   * Awaited after a start has reset the run and before its workers start:
   * Refine on the factors closes the factor files first (`RefineStore.release`),
   * so the new run's compression never meets a file the slow worker holds.
   */
  beforeStart?: () => Promise<void>;
  /** The tiles a live stream's Discover compresses on (compression on; default plain, as a file's). */
  liveTiling?: CompressTiling;
}
```

`createPipelineStore`'s parameters, after `lookbackFeed?: LookbackFeed,`:

```ts
  /** What other stages ask of a start (absent: nothing). */
  hooks: PipelineStartHooks = {},
```

In `start()`, after `compress?.reset(session);`, inside the `try` before `// Flat field: ...`:

```ts
if (hooks.beforeStart) {
  await hooks.beforeStart();
  if (gen !== generation) return;
}
```

and before `const p = await client.startPipeline(`:

```ts
const live = flat.identity?.()?.live === true;
```

with the cells settings line, before: `          ...(compress ? { compress: true } : {}),` after:

```ts
          ...(compress
            ? {
                compress: true,
                ...(live && hooks.liveTiling ? { compressTiling: hooks.liveTiling } : {}),
              }
            : {}),
```

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala -- pass2-store pipeline flat-field-store` (all pass; the 4.1 pass2 tests unchanged), `npx prettier --write` on the four files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/lib/pass2-store.ts apps/cala/src/lib/pipeline-store.ts apps/cala/src/__tests__/pass2-store.test.ts apps/cala/src/__tests__/pipeline.test.ts
git commit -m "feat(cala): Extract reads a live run's own factors and never replays a stream, and a Discover start can wait for a hook"
```

---

### Task 8: The App's wiring and the Run panel

**Files:**

- Modify: `apps/cala/src/App.tsx` (imports; the slow client's listener; `factorRefineOn`; the pipeline store's hooks; `liveFactors`, `stageInput`; the Extract store's `live`; the Refine store's `factorRefine`; the Run panel's `refineFactors`)
- Modify: `apps/cala/src/components/RunPanel.tsx` (imports; `RunPanelProps.refineFactors`; `liveExtract`, `liveRefine`, `refineBusyText`; `refineText`; the live note; the Refine block; the route note; the live Extract line; the Extract button; the export title; `RunStatusStrip`'s Refine detail)
- Test: `apps/cala/src/__tests__/run-panel-extract.test.tsx`

**Interfaces:**

- Consumes: everything above: `refineOnFactorsOn`, `FACTOR_REFINE`, `RefineStore.{phase, route, routeNote, release, onSlowMessage}` (Task 6); `liveFactorsBlocked`, `LIVE_EXTRACT_READY` (Task 4); `LIVE_FACTORS_NOTE`, `factorRefineRunningText`, `factorRefineDoneText` (Task 5); `PipelineStartHooks`, the Extract store's `live` (Task 7); `SlowToMain` (Task 3).
- Produces: `RunPanelProps.refineFactors?: boolean`; testids `extract-source` (live), `refine-route`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/run-panel-extract.test.tsx`: add imports `import { LIVE_EXTRACT_READY } from '../lib/compress-store.ts';` and `import { LIVE_FACTORS_NOTE, LIVE_NOTE, type StageLog } from '../lib/run-stages.ts';` (merge with the existing `createStageLog` import). Extend `Setup` with:

```ts
  live?: boolean;
  refineFactors?: boolean;
  /** The Extract store's status (default done). */
  pass2Status?: string;
  /** The Refine store's members (default: idle). */
  refine?: Record<string, unknown>;
  stages?: StageLog;
  /** No compress store (`?compress=off`). */
  noCompress?: boolean;
```

and in `mount`: the pass2 stub's `status: () => 'done',` becomes `status: () => o.pass2Status ?? 'done',`; `refine={stub<RunPanelProps['refine']>({ status: () => 'idle' })}` becomes `refine={stub<RunPanelProps['refine']>(o.refine ?? { status: () => 'idle' })}`; `stages={createStageLog()}` becomes `stages={o.stages ?? createStageLog()}`; `compress={compress}` becomes `compress={o.noCompress ? undefined : compress}`; and add the props `live={o.live}` and `refineFactors={o.refineFactors}`. Add:

```ts
describe('the Run panel of a live run with compression on', () => {
  const LIVE = {
    factors: 'ready',
    factorsFailed: false,
    source: 'raw',
    live: true,
    pass2Status: 'idle',
  } as const;

  it('offers Extract on the factors of a live run and says what it reads', () => {
    const root = mount(LIVE);
    expect(root.querySelector('[data-testid="pass2-run"]')).not.toBeNull();
    expect(text(root, 'extract-source')).toBe(LIVE_EXTRACT_READY);
    expect(text(root, 'live-stage-note')).toBe(LIVE_FACTORS_NOTE);
    expect(root.querySelector('[data-testid="refine-run"]')).toBeNull();
  });

  it('says why the factors of a stream cannot be read yet', () => {
    const root = mount({ ...LIVE, factors: 'unusable' });
    expect(text(root, 'extract-source')).toBe(
      'The factors do not cover the stream (a last window of one frame is not compressed). The export keeps the live traces.',
    );
  });

  it("names the export after Extract's traces once Extract ran", () => {
    const done = mount({ ...LIVE, pass2Status: 'done', source: 'factors' });
    expect(done.querySelector('[data-testid="export-npz"]')?.getAttribute('title')).toContain(
      "Extract's traces",
    );
  });

  it('keeps a live run Discover-only without compression', () => {
    const root = mount({ ...LIVE, noCompress: true });
    expect(root.querySelector('[data-testid="pass2-run"]')).toBeNull();
    expect(root.querySelector('[data-testid="extract-source"]')).toBeNull();
    expect(text(root, 'live-stage-note')).toBe(LIVE_NOTE);
  });

  it('shows Refine for a live run with ?refine=factors, named after what it does', () => {
    const root = mount({
      ...LIVE,
      refineFactors: true,
      refine: { status: () => 'idle', route: () => 'factors', routeNote: () => null },
    });
    expect(text(root, 'refine-run')).toBe('Refine until settled');
  });
});

describe('the Run panel of Refine on the factors', () => {
  const FILE = {
    factors: 'ready',
    factorsFailed: false,
    source: 'raw',
    pass2Status: 'idle',
  } as const;

  it('reads out the iterations of a running Refine on the factors', () => {
    const stages = createStageLog();
    stages.begin('refine');
    const root = mount({
      ...FILE,
      refineFactors: true,
      stages,
      refine: {
        status: () => 'running',
        route: () => 'factors',
        routeNote: () => null,
        processed: () => 2,
        total: () => 20,
        fps: () => 0,
        phase: () => ({
          kind: 'iterate',
          stopping: false,
          last: {
            iteration: 2,
            libraryVersion: 9,
            cells: 40,
            frames: 1200,
            fittingFrames: 800,
            accepted: 5,
            changedShare: 0.04,
            medianChange: 0.003,
            lowValid: 0,
            tilesSkipped: 0,
            ms: 10,
          },
        }),
      },
    });
    expect(text(root, 'refine-readout')).toBe(
      'Refine 1 on the factors: iteration 2 of at most 20 done · 5 refinements accepted · 4.0% of cells still changing (settled below 2.0%) · median change 0.3%',
    );
  });

  it('reads out how a finished Refine on the factors stopped', () => {
    const stages = createStageLog();
    stages.begin('refine');
    stages.end('refine', 'done', {
      cells: 40,
      footprintsRefined: 30,
      medianFootprintChange: 0.012,
      source: 'factors',
      iterations: 20,
      stop: 'cap',
      changedShare: 0.031,
    });
    const root = mount({
      ...FILE,
      refineFactors: true,
      stages,
      refine: { status: () => 'done', route: () => 'factors', routeNote: () => null },
    });
    expect(text(root, 'refine-readout')).toBe(
      'Refine 1 on the factors: stopped at the cap of 20 iterations without settling (3.1% of cells still changing) · 30 of 40 footprints refined · median change of those 1.2%',
    );
  });

  it("says why a file's Refine replays the file with the switch on", () => {
    const note = 'Refine replays the file: the last Refine on the factors failed.';
    const root = mount({
      ...FILE,
      refineFactors: true,
      refine: { status: () => 'idle', route: () => 'raw', routeNote: () => note },
    });
    expect(text(root, 'refine-route')).toBe(note);
    expect(text(root, 'refine-run')).toBe('Refine');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

`npm run test -w apps/cala -- run-panel-extract` fails: `pass2-run` is null for the live run, `live-stage-note` is the old `LIVE_NOTE`, `refine-run` is null, the readout is the replay's ("Refine 1: frame 2 / 20"), and `refine-route` is null.

- [ ] **Step 3: Implement**

`apps/cala/src/components/RunPanel.tsx`:

- Imports, before: `import { compressReadout, extractSourceText, type CompressStore } from '../lib/compress-store.ts';` after:

```ts
import {
  compressReadout,
  extractSourceText,
  LIVE_EXTRACT_READY,
  liveFactorsBlocked,
  type CompressStore,
} from '../lib/compress-store.ts';
```

In the import from `'../lib/run-stages.ts'` add `factorRefineDoneText`, `factorRefineRunningText`, `LIVE_FACTORS_NOTE`. Replace `import type { RefineStore } from '../lib/refine-store.ts';` with `import { FACTOR_REFINE, type RefineStore } from '../lib/refine-store.ts';`.

- `RunPanelProps`, after `live?: boolean;`:

```ts
  /** `?refine=factors` with compression on: Refine reads the factors (a live run's Refine exists only then). */
  refineFactors?: boolean;
```

- After `const comparison = () => refineComparison(props.stages.runs());`:

```ts
/** A live run with compression on: Extract reads Discover's factors once the stream has ended. */
const liveExtract = () => props.live === true && props.compress !== undefined;
/** ... and with `?refine=factors`, Refine on them. */
const liveRefine = () => liveExtract() && props.refineFactors === true;
/** The running Refine's readout: the replay's frames, or what Refine on the factors does. */
const refineBusyText = () => {
  const ph = r().phase();
  if (ph) return factorRefineRunningText(refineRuns().length, ph, FACTOR_REFINE);
  return `Refine ${refineRuns().length}: frame ${r().processed().toLocaleString()} / ${r().total().toLocaleString()}${r().fps() > 0 ? ` · ${r().fps().toFixed(1)} frames/s` : ''}${r().status() === 'finishing' ? ' · publishing' : ''}`;
};
```

- `refineText`, after `if (last.outcome === 'running') return null;`: `if (last.source === 'factors') return factorRefineDoneText(last);`.
- The live note, before: `          {LIVE_NOTE}` after: `          {props.compress ? LIVE_FACTORS_NOTE : LIVE_NOTE}`.
- The Refine block, before:

```tsx
      <Show when={!props.live}>
        <div class="cala-run__footer">
          <Show
            when={!refineBusy()}
```

after:

```tsx
      <Show when={!props.live || liveRefine()}>
        <div class="cala-run__footer">
          <Show
            when={!refineBusy()}
```

- The Refine button, before:

```tsx
              title={
                props.availability.refine ??
                'Replay the recording from frame 0: footprints keep converging; no cells are added, merged, split or deleted. Repeatable.'
              }
              onClick={() => props.onRefine()}
            >
              {refineRuns().length > 0 ? 'Refine again' : 'Refine'}
```

after:

```tsx
              title={
                props.availability.refine ??
                (r().route() === 'factors'
                  ? `Refine on the factors: iterations over the compressed recording until the footprints settle (at most ${FACTOR_REFINE.maxIterations}); no cells are added, merged, split or deleted.`
                  : 'Replay the recording from frame 0: footprints keep converging; no cells are added, merged, split or deleted. Repeatable.')
              }
              onClick={() => props.onRefine()}
            >
              {r().route() === 'factors'
                ? 'Refine until settled'
                : refineRuns().length > 0
                  ? 'Refine again'
                  : 'Refine'}
```

- The `refine-readout` span: replace the first branch of its conditional (the template literal that starts `` `Refine ${refineRuns().length}: frame `` and ends `` ' · publishing' : ''}` ``, right after `{refineBusy()` and `?`) with `refineBusyText()`, so the span reads:

```tsx
{
  refineBusy()
    ? refineBusyText()
    : r().status() === 'error'
      ? `Refine stopped: ${r().error() ?? 'error'}`
      : (refineText() ?? '');
}
```

- After the Refine footer `</div>` that closes the row with `refine-readout`, before `<Show when={shown() && r().series()}>`:

```tsx
<Show when={props.refineFactors && !refineBusy() ? r().routeNote() : null}>
  {(note) => (
    <p class="cala-muted cala-run__line" data-testid="refine-route">
      {note()}
    </p>
  )}
</Show>
```

- After the existing `extract-source` `<Show>` (the one with `!props.live`):

```tsx
<Show when={liveExtract() && s().status() === 'done' && p().status() !== 'running'}>
  <p class="cala-muted cala-run__line" data-testid="extract-source">
    {liveFactorsBlocked(
      props.compress!.factors(s().record().frames),
      props.compress!.status(),
      Boolean(props.compress!.error()),
    ) ?? LIVE_EXTRACT_READY}
  </p>
</Show>
```

- The Extract button's `<Show>`, before:

```tsx
        <Show
          when={p().status() !== 'running' && !props.live}
          fallback={
            <Show when={!props.live}>
```

after:

```tsx
        <Show
          when={p().status() !== 'running' && (!props.live || liveExtract())}
          fallback={
            <Show when={!props.live || liveExtract()}>
```

- The `export-npz` button's `title`: its condition `props.live` becomes `props.live && !p().result()` (a live run that ran Extract exports Extract's traces):

```tsx
              title={
                props.live && !p().result()
                  ? 'Footprints, the live traces, motion, flicker and cell metadata (NumPy .npz).'
                  : "Footprints, Extract's traces, motion, flicker, the stages run and cell metadata (NumPy .npz)."
              }
```

- `RunStatusStrip`, the Refine view's `detail`, before:

```ts
        detail: `${rs === 'finishing' ? 'publishing' : `frame ${r().processed().toLocaleString()}`}${fpsText(r().fps())}`,
```

after:

```ts
        detail:
          r().phase()?.kind === 'iterate'
            ? `iteration ${r().processed()}${rs === 'finishing' ? ' · stopping' : ''}`
            : `${rs === 'finishing' ? 'publishing' : `frame ${r().processed().toLocaleString()}`}${fpsText(r().fps())}`,
```

`apps/cala/src/App.tsx`:

- Imports: `import { compressionOn, createCompressStore, liveFactorsBlocked } from './lib/compress-store.ts';`, `import { createRefineStore, refineOnFactorsOn } from './lib/refine-store.ts';`, `import type { SlowToMain } from './workers/slow-types.ts';`.
- Before `const slow = createSlowClient(` add:

```ts
/** The slow worker's messages of Refine on the factors go to the Refine store (set once it exists). */
let toRefine: (msg: SlowToMain) => void = () => {};
```

and its listener, before: `    (msg) => cells.onSlowMessage(msg),` after:

```ts
    (msg) => {
      cells.onSlowMessage(msg);
      toRefine(msg);
    },
```

- After `const factors = ...;`:

```ts
// `?refine=factors` (compression on): Refine reads the factors until they settle.
const factorRefineOn = factors !== undefined && refineOnFactorsOn(params);
```

- The `createPipelineStore(` call: after its last argument `lookbackClient,` add the hooks, so it ends:

```ts
      : compress,
    lookbackClient,
    {
      // A new Discover waits until Refine on the factors has closed the factor files.
      beforeStart: () => refine.release(),
      // A live stream's Discover compresses on the offset grids (`?review` reads plain tiles only).
      ...(reviewWindows === null ? { liveTiling: 'offset' as const } : {}),
    },
  );
```

- Before `const stageInput = () => ({`:

```ts
/** A live run with compression on: why its factors cannot be read now (null: they can); undefined otherwise. */
const liveFactors = (): string | null | undefined =>
  store.info()?.live !== undefined && compress
    ? liveFactorsBlocked(
        compress.factors(pipeline.record().frames),
        compress.status(),
        compress.error() !== null,
      )
    : undefined;
```

and in `stageInput`, after `live: store.info()?.live !== undefined,` add:

```ts
    liveFactors: liveFactors(),
    refineOnFactors: factorRefineOn,
```

- The `createPass2Store(` call: after its last argument `factors,` (before its closing `);`) add the seventh argument, so the call ends:

```ts
    factors,
    {
      on: () => store.info()?.live !== undefined && compress !== undefined,
      blocked: () => liveFactors() ?? null,
    },
  );
```

- The `createRefineStore(` call's options object: after `      ...(factors ? { compress: factors } : {}),` add the `factorRefine` member, and after the call add the routing line, so it ends:

```ts
      ...(factors ? { compress: factors } : {}),
      ...(factors && factorRefineOn
        ? {
            factorRefine: {
              factors,
              slow,
              live: () => store.info()?.live !== undefined,
              lookback: () => pipeline.lookbackRun(),
            },
          }
        : {}),
    },
  );
  toRefine = (msg) => refine.onSlowMessage(msg);
```

- In the `<RunPanel ... />` of the `run` tab, after `live={lp.info.live !== undefined}` followed by `label={store.label()}`, add `refineFactors={factorRefineOn}` between them.

- [ ] **Step 4: Run the tests**

`npm run test -w apps/cala` (the whole suite: `App.test.tsx`, `run-panel-extract.test.tsx` and the rest pass), `npx prettier --write` on the three files, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/cala/src/App.tsx apps/cala/src/components/RunPanel.tsx apps/cala/src/__tests__/run-panel-extract.test.tsx
git commit -m "feat(cala): the Run panel offers Extract on a live run's factors and Refine until settled, and reads out each iteration"
```

---

### Task 9: The e2e gate on a file with refine=factors and on a simulated stream

**Files:**

- Create: `e2e/cala-helpers.ts` (moved from `e2e/cala-factors.spec.ts`: `CalaDebug`, `extractResult`, `libraryCells`, `discoverEnded`, `discover`, `exportNpz`, `metaText`, `stageSources`, `count`; new `lastRefine`)
- Modify: `e2e/cala-factors.spec.ts` (import the helpers; `openFile`; a new test)
- Modify: `e2e/cala-live.spec.ts` (the first test gets `&compress=off`; a new test)

**Interfaces:**

- Consumes: the app as Tasks 1 to 8 build it; `buildAvi`, `cellMovie` (`apps/cala/src/__tests__/synth-avi.ts`); `live-sim.mjs` options `--fps`, `--buffer`; testids `refine-run`, `pass2-run`, `pass2-status`, `extract-source`, `live-stage-note`, `export-menu`, `export-npz`, `pipeline-status`.
- Produces: `e2e/cala-helpers.ts` exports `CalaDebug`, `extractResult(page)`, `libraryCells(page)`, `discoverEnded(page)`, `discover(page, open: () => Promise<void>)`, `exportNpz(page)`, `metaText(npz)`, `stageSources(meta)`, `count(text, part)`, `lastRefine(page)`.

- [ ] **Step 1: Write the failing tests**

Create `e2e/cala-helpers.ts` with the helpers moved verbatim from `e2e/cala-factors.spec.ts` (`extractResult`, `libraryCells`, `discoverEnded`, `exportNpz`, `metaText`, `stageSources`, `count`, each now `export`ed) and these two changed parts:

```ts
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/** What the e2e tests read of `window.__cala` (`?debug`). */
export interface CalaDebug {
  __cala: {
    pipeline: { status(): string; record(): { frames: number } };
    cells: {
      library(): { ids: Uint32Array } | null;
      session(): number;
      status(): { final?: boolean } | null;
    };
    refine: { status(): string };
    pass2: { result(): { source?: string; frames: number; cells: number } | null };
    compress?: { error(): string | null; factors(frames: number): string };
    stageLog: {
      last(
        stage: string,
      ): { source?: string; factors?: string; stop?: string; iterations?: number } | undefined;
    };
  };
}

/**
 * Discover runs at most three times, until it finds cells; `open` loads the
 * page with its recording or stream.
 *
 * Why: the slow and visit workers load their WASM on Discover's first frames,
 * while the file is read as fast as it can be (or the stream arrives). On a
 * busy machine the read can end before the visits come back, and Discover then
 * ends with no cells. A Restart in the same page has the workers ready (a
 * stream connects again and starts over). These tests are about what follows
 * Discover, so they start it again as a user would.
 */
export async function discover(page: Page, open: () => Promise<void>): Promise<void> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await open();
  let session = 0;
  for (let run = 1; run <= 3; run++) {
    if (run > 1) await page.getByRole('button', { name: 'Restart' }).click();
    const before = session;
    await expect
      .poll(async () => (await discoverEnded(page)) ?? 0, { timeout: 120_000 })
      .toBeGreaterThan(before);
    session = (await discoverEnded(page)) ?? 0;
    const cells = await libraryCells(page);
    // In the report: how often Discover had to start again.
    test.info().annotations.push({ type: 'discover', description: `run ${run}: ${cells} cells` });
    if (cells > 0) break;
  }
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done');
  await expect(page.getByTestId('pass2-run')).toBeEnabled({ timeout: 60_000 });
  expect(await libraryCells(page)).toBeGreaterThan(0);
}

/** The newest Refine record's plain fields. */
export function lastRefine(page: Page) {
  return page.evaluate(() => {
    const r = (window as unknown as CalaDebug).__cala.stageLog.last('refine');
    return r && { source: r.source, factors: r.factors, stop: r.stop, iterations: r.iterations };
  });
}
```

In `e2e/cala-factors.spec.ts`: delete the moved helpers and the `CalaDebug` interface; import them: `import { count, discover, exportNpz, extractResult, lastRefine, libraryCells, metaText, stageSources, type CalaDebug } from './cala-helpers.ts';` (keep `readFileSync` only if still used; `Page` stays imported for `openFile` and `refineToFactors`). Add after `cellFolder`:

```ts
/** Open the app on a fresh cell-movie folder (`query`: extra URL parameters). */
function openFile(page: Page, query: string): () => Promise<void> {
  return async () => {
    await page.goto(`Cala/?debug${query}`);
    await page.getByTestId('folder-input').setInputFiles(cellFolder('cala-factors-e2e-'));
  };
}
```

and replace each `await discover(page, '');` with `await discover(page, openFile(page, ''));`, `await discover(page, '&compress=off');` with `await discover(page, openFile(page, '&compress=off'));`, `await discover(second, '');` with `await discover(second, openFile(second, ''));`. Add:

```ts
test('Cala: with refine=factors a file refines on the factors until settled, then extracts on them', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await discover(page, openFile(page, '&refine=factors'));
  await expect(page.getByTestId('refine-run')).toHaveText('Refine until settled');
  await page.getByTestId('refine-run').click();
  // No factors yet: a replay that only compresses makes them, then the iterations run.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 180_000,
    })
    .toBe('done');
  const refine = await lastRefine(page);
  expect(refine).toMatchObject({ source: 'factors', factors: 'replay' });
  expect(['settled', 'nothing-accepted', 'cap']).toContain(refine?.stop);
  expect(refine?.iterations).toBeGreaterThan(0);
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors (seconds).',
  );
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  expect(await extractResult(page)).toEqual({ source: 'factors', frames: FRAMES, cells });
  const meta = metaText(await exportNpz(page));
  expect(stageSources(meta)).toEqual([
    ['discover', 'raw'],
    ['refine', 'factors'],
    ['extract', 'factors'],
  ]);
  expect(count(meta, '"factors":"replay"')).toBe(2);
  expect(meta).not.toContain('"factors":"discover"');
});
```

In `e2e/cala-live.spec.ts`: imports become `import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';` and `import { count, discover, exportNpz, extractResult, libraryCells, metaText, stageSources, type CalaDebug } from './cala-helpers.ts';`. In "Cala: a live source streams through the pipeline to the end", before:

```ts
// Runs with compression on, the app default.
await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug`);
```

after:

```ts
// Compression off: the Discover-only live run of before phase 4.2 (no Extract offered).
await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug&compress=off`);
```

Add at the end:

```ts
const LIVE_FRAMES = 3000;

test('Cala: a stream with cells extracts on its own factors after it ended, and says so', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-cells-e2e-'));
  const movie = cellMovie(96, 96, LIVE_FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: LIVE_FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // A send buffer as long as the stream: no frame is dropped, so five whole windows arrive.
  await startSim(folder, ['--buffer', String(LIVE_FRAMES)]);
  await discover(page, async () => {
    await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug&refine=factors`);
  });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.pipeline.record().frames),
  ).toBe(LIVE_FRAMES);
  const note =
    'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.';
  await expect(page.getByTestId('live-stage-note')).toHaveText(note);
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors Discover wrote during the stream (seconds).',
  );
  // Before any stage the export is the live traces.
  const before = await exportNpz(page);
  expect(stageSources(metaText(before))).toEqual([['discover', 'raw']]);
  expect(before.includes('traces_signed')).toBe(false);

  await page.getByTestId('refine-run').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 180_000,
    })
    .toBe('done');
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  expect(await extractResult(page)).toEqual({ source: 'factors', frames: LIVE_FRAMES, cells });
  const after = await exportNpz(page);
  const meta = metaText(after);
  expect(stageSources(meta)).toEqual([
    ['discover', 'raw'],
    ['refine', 'factors'],
    ['extract', 'factors'],
  ]);
  expect(count(meta, '"factors":"discover"')).toBe(2);
  expect(meta).toContain(note);
  expect(after.includes('traces_signed')).toBe(true);
  expect(after.includes('extract_min_valid')).toBe(true);
});
```

- [ ] **Step 2: Run them, and see one fail without the switch**

`npm run build:e2e`, then `npx playwright test e2e/cala-live.spec.ts e2e/cala-factors.spec.ts`. Tasks 1 to 8 are in, so the new tests pass. To see that the stream test depends on the switch, remove `&refine=factors` from its URL once and run `npx playwright test e2e/cala-live.spec.ts -g "stream with cells"`: it fails at the `refine-run` click (no Refine button on a live run without the switch, availability `LIVE_REFINE_OFF`). Put the parameter back.

- [ ] **Step 3: Implement**

Nothing beyond Step 1: the shared helpers and the tests are this task's change. Check that `e2e/cala-factors.spec.ts` still has every import it uses after the move (`mkdtempSync`, `rmSync`, `writeFileSync`, `join`, `tmpdir`, `Page`, `buildAvi`, `cellMovie`) and none it no longer uses (`readFileSync` moved with `exportNpz`).

- [ ] **Step 4: Run the tests**

`npx prettier --write e2e/cala-helpers.ts e2e/cala-factors.spec.ts e2e/cala-live.spec.ts`, `npm run typecheck:e2e`, `npm run lint`, `npm run build:e2e`, `npm run test:e2e` (all pass, the existing cala specs included).

- [ ] **Step 5: Commit**

```bash
git add e2e/cala-helpers.ts e2e/cala-factors.spec.ts e2e/cala-live.spec.ts
git commit -m "test(cala): the e2e gate runs Refine until settled and Extract on the factors of a file and of a simulated stream"
```

---

### Task 10: Docs

**Files:**

- Modify: `apps/cala/README.md` (section "Live source (experimental)"; section "Compression (on by default; `?compress=off`)"; section "Run stages and export")
- Modify: `apps/cala/docs/stages.md` (the bullet "**Streaming runs Discover only.**" under "## Order"; the Refine row of the table)
- Modify: `docs/CHANGELOG.md` (`## [Unreleased]`, `### Added`)

**Interfaces:**

- Consumes: Tasks 1 to 9.
- Produces: docs only.

- [ ] **Step 1: README**

In "Live source (experimental)", add a paragraph "**After the stream.**": with compression on (the default) Discover compresses the stream's windows (on the offset grids; plain tiles with `?review`); once the stream has ended and its last window is compressed the Run panel offers Extract on those factors, which replaces the live traces in the export only when run; with `?refine=factors` "Refine until settled" runs on them too; the stage records and the export say `factors: "discover"` and the note that these factors are not claimed to meet the closeness gate (phase 4a: they fail it on the two WL24 wireless recordings, trace loss 0.155 and 0.203 against 0.08); a stream whose last window has one frame has no factor Extract; with `?compress=off` a live run is Discover only, as before. In "Compression (on by default; `?compress=off`)", add a paragraph "**Refine on the factors (`?refine=factors`)**": Refine runs iterations on the factor files in the slow worker until fewer than 2 % of the cells' footprints correlate below 0.99 with the previous iteration's, at most 20 iterations; a file without factors first gets a replay that only compresses; the readout per iteration; cancel between iterations; after a look-back Discover, a failed Refine on the factors or unusable factors Refine replays the file and the panel says why; evidence (phase 3a: passes on `wl200`, fails the footprint rule on both WL24 recordings, 0.0345 and 0.0389 against 0.02, and reaches the cap on `wl24_01`; Amendment 3, A15). In "Run stages and export", add the stage record keys `factors`, `factors_note`, `iterations`, `stop`, `changed_share` (format 7).

- [ ] **Step 2: stages.md and CHANGELOG**

`apps/cala/docs/stages.md`: the bullet becomes "**Streaming runs Discover, then Extract on its factors.** A live source has no file to replay. With compression on, Extract reads the factors Discover wrote once the stream has ended and its last window is compressed (and, with `?refine=factors`, Refine on them); they are Discover's own and not claimed to meet the closeness gate. With `?compress=off`, save the stream and load it later as a recording to Refine and Extract it."; the Refine row gains "with `?refine=factors`: iterations on the factors until the footprints settle (at most 20)".

`docs/CHANGELOG.md`, under `## [Unreleased]` / `### Added`: one entry: cala: Refine on the factors behind `?refine=factors` ("Refine until settled", one iteration per WASM call in the slow worker, `SlowLoop.refineOnFactors`); a live stream offers Extract (and with the switch Refine) on Discover's own factors after it ends, said in the Run panel and the export not to be claimed to meet the closeness gate; stage records gain `factors`, `factors_note`, `iterations`, `stop`, `changed_share`.

- [ ] **Step 3: Check and commit**

`npx prettier --write apps/cala/README.md apps/cala/docs/stages.md docs/CHANGELOG.md`, then `npx prettier --check` on them.

```bash
git add apps/cala/README.md apps/cala/docs/stages.md docs/CHANGELOG.md
git commit -m "docs(cala): Refine on the factors behind a switch, and Extract on a live stream's own factors"
```

---

## Not in this phase

- **Refine on the factors as the default** (decision 4 of the phase 4 plan; A15: the footprint rule fails on both WL24 recordings) and the multi-session setting "number of Refine runs" becoming on or off.
- **A storage quota check, or a cap on what a live stream compresses** (phase 4.3, task 1): a 600 px stream whose compressor falls behind keeps windows on disk until it catches up.
- **An acknowledgement per window in the extract protocol** and **stopping the feed after a compression error** (phase 4.3, from the 4.1 execution notes).
- **Factors saved to the results folder** (phase 4.3, task 2): a live run's factors live in OPFS until the next Discover of the tab or the next page load.
- **The history review on the offset grids** (phase 4.3, task 3): `?review` keeps a live run on plain tiles (decision 4); nothing minimal of it is needed here.
- **The live flat field seed** (phase 4.3, task 4).
- **The cluster history replay on factors** (phase 3b): Refine on the factors refuses a joint update, so a look-back Discover's Refine replays the file.
- **Any change to main's look-back.**
- **A cancel inside one iteration** (decision 2 and 7).
- **Readers sharing the factor files** (read-only sync access handles; decision 1).
- **FOV images for a live run's Extract** (a stream has no replay that projects frames).

## Self-review notes

**Spec coverage.** §3 "a live stream uses the factors of Discover": Tasks 4, 7, 8 (the flat field seed: not in this phase). §5 the iteration (Task 1, the library's `refine_on_factors` unchanged), the settle stop and cap and "the stage log says so" (Tasks 3, 5, 6; decision 6). §6 "Refine until settled", the readout per iteration (Tasks 5, 8; the plots with iterations on the x axis are not built: the Refine plots stay the replay's, phase 4 plan's design note "The smallest slice"); "Streaming: Refine and Extract are offered once the stream has ended" (Tasks 5, 8; Refine only with the switch, decision 9); the export's `source` with tiling and mean rank (4.1) plus `factors` (Task 5). A11's gate "an e2e run of Discover, Refine, Extract on a file and on a simulated stream": 4.1's file test (raw Refine) and Task 9 (Refine and Extract on the factors, file and stream). A4 live streams (decision 3), A14 `min_valid` on the live Extract (unchanged 4.1 code path, `extract_min_valid` asserted in Task 9), A15 (decision 5, README in Task 10).

**Names used across tasks and the task that defines each.** Task 1: `WindowBytes`, `ByteSource`, `refine_one`, `FactorReader` (Rust import), `SlowLoop.refineOnFactors`, `JsSlowLoop::factor_iteration`. Task 2: `newRunFolder`, `FactorReader` (TS), `openFactorReader`, `MainToCompress.connect.run`, `CompressClient.folder`. Task 3: `FactorIteration`, `FactorStop`, `FACTOR_STOPS`, `FactorRefineSettings`, `SlowRefineFactors`, `SlowStopFactors`, `factor-iteration`, `factor-end`, `factorIteration`, `SlowRunner.refineOnFactors`, `SlowRunner.stopFactors`, `SlowRunnerDeps.openFactors`, `SlowLoopLike.refineOnFactors`, `SlowClient.refineOnFactors`, `SlowClient.stopFactors`. Task 4: `factorState(..., live)`, `CompressStore.{live, jobSent, jobsOut}`, `liveFactorsBlocked`, `LIVE_EXTRACT_READY`, `FactorFilesLike`, `createPass2Factors` (its new return type). Task 5: `StageInput.{liveFactors, refineOnFactors}`, `StageRun.{factors, iterations, stop, changedShare}`, `Pass2Result.factors`, `LIVE_FACTORS_NOTE`, `LIVE_REFINE_OFF`, `FactorPhase`, `factorRefineRunningText`, `factorRefineDoneText`. Task 6: `FACTOR_REFINE`, `refineOnFactorsOn`, `RefineFactorsOptions`, `RefineQcOptions.factorRefine`, `RefineStore.{phase, route, routeNote, onSlowMessage, release}`. Task 7: `createPass2Store`'s `live`, `PipelineStartHooks`, `createPipelineStore`'s `hooks`. Task 8: `RunPanelProps.refineFactors`, testid `refine-route`. Task 9: `e2e/cala-helpers.ts` exports. Each `Consumes` line names only earlier tasks or existing code; Task 5 adds `Pass2Result.factors` (a type) before Task 7 sets it.

**Review Focus and the tests that pin each.** Listed under each item above; all named tests are written in Tasks 1, 3, 4, 6, 7, 8 and 9.

**What could not be verified by reading.**

- That wasm-bindgen's glue for an imported `catch` method returning `Vec<u8>` accepts a `Uint8Array` subarray and turns a thrown `Error` into `Err` as described (read in wasm-bindgen 0.2.130's `FromWasmAbi for Vec<T>`; the vitest of Task 1 pins it), and the TypeScript type it emits for the `reader` parameter (`skipLibCheck` is on in `tsconfig.base.json`).
- That the empty-library iteration on the vitest's synthetic files reports `frames` 100 and settle code 2 (from the Rust test `an_empty_library_settles_at_once`, not run here).
- That Chrome allows a worker to hold one synchronous access handle per window for the whole run (tens to a few hundred files for a long recording); no limit is documented that I found.
- That Solid runs the App's effect on `pipeline.status() === 'starting'` (which clears the Refine store and sends `stop-factors`) before `start()` reaches `beforeStart`; `release()` sends `stop-factors` itself, so the order does not matter for correctness.
- How long one iteration takes in the browser at 600 px (decision 7 cites estimates only; phase 5 measures).
- Whether the cell movie's live Discover and Refine finish within the e2e timeouts on CI (the file test of 4.1 does; the stream adds 15 s of streaming at 200 fps).
