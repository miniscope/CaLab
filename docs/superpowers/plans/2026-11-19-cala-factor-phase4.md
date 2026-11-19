# cala factor pipeline, phase 4: the app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The browser app runs its stages on the factors where the evidence allows: compression is on by default, Extract reads the factors once a replay has made them, the stage log and the export say which source each stage read, and `?compress=off` gives today's raw path. Phase 4.1 (this plan in full) does this for file recordings. Phase 4.2 (task list) adds Refine on factors behind a switch and Extract on factors for live streams, which completes the phase's gate. Phase 4.3 (task list) adds storage checks, factors in the results folder, the history review on the offset grids and the live flat field seed.

**Architecture:** No new pass over the file in 4.1. The first replay after Discover (the first Refine run, or Extract when no Refine runs) also feeds the compress worker on the two offset grids, as Extract's replay does today; its factors hold every frame with the final calibration, and they do not depend on the library, so they serve every later Extract. Extract then sends the final library to the compress worker, which solves every window with phase 2's `FactorExtractor` (now with signed traces) and posts each window's traces to the main thread; the Extract store writes them into the same trace files a raw Extract writes, so the export, the QC and the multi-session runs do not change. When the factors are not ready (still compressing, cut short, or failed), Extract replays the file as today. The main thread keeps one small state per run (`FactorState`: none, compressing, ready, unusable) in the compress store and asks it before every replay.

**Tech Stack:** Rust (crate `calab-cala`, wasm-bindgen), TypeScript with Solid and vitest (`apps/cala`), Playwright (`e2e/`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`: §3 "Factor store", §6 "Stages and UI", Amendment 1 (A1 the gate, A4 file recordings and live streams, A7), Amendment 2 (A8, A9, A11 the phase row, A12). Builds on the plans of phases 2 (`2026-11-18-cala-factor-phase2.md`, Task 5 is the app's back-fill), 4a and 3.

**Precondition:** phases 2 and 4a are complete on `feat/cala-factor-extract`; phase 3a's gate runs have ended and their report states the gate per recording. 4.1 uses no phase 3 code. The owner has read the section "Decided for the owner's review" below; executing 4.1 before the owner's answer is allowed by the owner's overnight instruction, and every decision listed there can be reverted by one task.

## Decided for the owner's review

Made while planning, on the owner's instruction to plan what is not planned. Each says what result would change it.

1. **Compression on by default for every run** (file and live), `?compress=off` for today's path (spec §3). The old `?compress` keeps working (it is now a no-op). Changes if phase 5 shows the default file path slower than `?compress=off` by more than the owner accepts, or the storage peak beyond the quota of a typical machine.
2. **No separate compression replay for file recordings in 4.1.** A4 says "one more pass over the file". This plan lets the first replay after Discover compress (the first Refine run, else Extract), as phase 1 did with Extract's replay, because a raw Refine replay has the same final calibration and the factors do not depend on the library. That costs no extra pass while Refine stays raw. A standalone compression replay arrives in 4.2, for Refine on factors, which needs the factors before its first iteration. Changes if Refine on factors becomes the default (then every file run needs the factors before Refine, and the standalone replay is the first stage after Discover).
3. **Extract on factors is the default once the factors are ready; otherwise Extract replays the file, without waiting.** Evidence: Extract on factors meets gate A1 on all six recordings in bounded native runs, 22 to 137 times faster than Extract on rebuilt frames (phase 2). Known difference: on the three real recordings the factor engine reads a pixel that is never valid in a window (66 to 105 fixed pixels on the wireless recordings) as 0 where the frame engine treats it as missing; the trace difference between the two engines is about 0.015 of a trace's standard deviation (median) on the wireless recordings, and one cell of `wl24_04` with such a pixel in its support differs by 0.45. Changes if phase 5's whole-recording comparison in the browser fails A1.
4. **Refine stays a raw replay by default; Refine on factors only behind `?refine=factors`** (4.2), for files and live streams alike. Evidence (phase 3a, bounded native runs): it passes on `wl200` and settles in 6 iterations; on `wl24_01` it fails the footprint rule (0.0345 against 0.02) and stops at the cap of 20 iterations without settling; on `wl24_04` it fails the footprint rule (0.0389) and settles after 19 iterations. Changes when phase 3's gate passes on the real recordings (or the owner accepts the footprint loss).
5. **Live streams (4.2):** Discover compresses on the offset grids (plain tiles only with `?review`, whose review reads plain tiles until 4.3); after the stream ends Extract on factors is offered (it is the only Extract a stream can have); the stage log and the export say that a live run's factors are Discover's own and are not claimed to meet gate A1. Evidence (phase 4a): Discover's factors fail A1 on both real WL24 wireless recordings (trace loss 0.155 and 0.203 against 0.08) and on `motion` (footprint loss 0.0223), pass on `wl200`, `plain` and `v4`. Changes if a later measurement shows live factors within A1 on the owner's setups.
6. **The flat field seed for live streams is not in 4.1 or 4.2; it is a 4.3 task behind a switch, off by default.** Evidence (phase 4a): a seed helped once in the app's direction (`wl24_04` seeded from a session three days earlier: pass, closing 92 % of the trace gap), failed in the other direction and with a same-recording seed on `wl24_01`, and a seed changes Discover's cells (46 of 202 QC-pass cells on `v4` without a partner). The app today never applies a stored map to a stream silently (`pipeline-store.ts`, about line 486), on purpose. Changes if the owner confirms the same scope unit across sessions and a second cross-session pass.
7. **Refine on factors runs in the slow worker (4.2),** which owns the `SlowLoop` and its state; it opens the finished factor files itself (synchronous access handles, after the compress worker has closed them), one WASM call per iteration, cancel between iterations. The compress worker keeps the compression and Extract on factors. Changes if one iteration at 600 px takes so long in the browser that a cancel within an iteration is needed (phase 5 measures it).
8. **Extract on factors runs in the compress worker,** which owns the factor files; one message per window to the main thread, no backpressure (a window's traces and signed traces are `2 × 600 × cells × 4` bytes, 4.8 MB at 1000 cells).
9. **The export's field-of-view projections of a factor Extract come from the replay that made the factors** (it already has the frames with the final calibration; a factor Extract has no frames).
10. **A recording whose factors do not cover every frame is extracted from the file.** The offset grids skip a last window of one frame (`compress.test.ts`, "skips a last window of one frame under the offset grids"), so a recording of `600 k + 1` frames always replays the file for Extract. A cancelled or failed compression gives the same fallback.
11. **Export format 7:** every stage record gets `source` (`raw` or `factors`), and a factor stage its `tiling` and `mean_rank`. Under `?compress=off` the export differs from today's only by `format_version` 7 and `source: "raw"` on each record.
12. **Main's flagged features:** the cluster replay and the look-back stay out of the app in this phase (see "Not in this phase").

## Design notes

### What phase 4 must deliver, and how it is cut

The spec's row (A11): stages, Run panel, compression on by default, factors kept for live runs, a flat field seed for live streams, the history review on the offset grids, main's flags where main's app side exists; gate: an e2e run of Discover, Refine and Extract on a file and on a simulated stream. That is about fifteen tasks, so it is cut in three:

- **4.1 (this plan, 8 tasks): file recordings.** Compression on by default, the first replay compresses, Extract on factors, the stage records and the export, the Run panel's line on what Extract will read, an e2e run of Discover, Refine (raw) and Extract (factors) on a file with cells. It gives a user-visible, testable result without Refine on factors.
- **4.2 (task list): Refine on factors and live streams.** The WASM binding of one factor iteration, the slow worker's factor source, the Refine store's factor route with a standalone compression replay, "Refine until settled" in the Run panel behind `?refine=factors`; live Discover on the offset grids, Extract on factors after a stream ends; the e2e run on a simulated stream. Completes the gate.
- **4.3 (task list): storage and the rest of A11.** Quota check and backpressure on waiting windows, factors written to the results folder, the history review on the offset grids, the live flat field seed behind a switch.

### Defaults, by the evidence

See "Decided for the owner's review", items 1 to 6. In short: what is shown to meet A1 (Extract on recalibrated factors) becomes the default; what is not (Refine on factors on real recordings, live factors without recalibration) stays behind a switch or carries a note.

### File recordings

- **Which replay compresses.** Every replay asks the compress store first (`Pass2Factors.replayCompress`). With no factors yet (`none`) the replay feeds the compress worker on the offset grids under the run's compress session and marks the factors `compressing`; with factors `compressing`, `ready` or `unusable` it feeds nothing, so a later replay never clears factors that are being made or are done (the compress worker clears its store at every `init`). A replay that is cancelled or fails before the end releases the mark; the compress worker drops a cut-short window run itself (`CompressFeed.reset`).
- **What the user sees.** The Refine and Extract rows are as today. Under Extract, one line (`extract-source`) says what Extract will read now: "Extract reads the factors (seconds).", "Extract replays the file: the factors are being compressed (N windows waiting).", "Extract replays the file; the first replay compresses the frames for later Extracts." or "Extract replays the file: the factors do not cover the recording.". The Extract status line ends "(from the factors)" for a factor Extract; the raw text is unchanged. The compress readout in the status bar is unchanged.
- **The stage log.** Every run of Discover, Refine and Extract records `source`; a factor Extract also `tiling` and `meanRank`. The export writes them (format 7).
- **What the raw file is needed for after the first replay:** raw Refine runs (the default), an Extract while the factors are still compressing or after they became unusable, and `pass2.run(undefined, 'raw')` (measurements). With `?refine=factors` (4.2) nothing after the compression replay reads the file.

### Live streams (4.2)

- **Tiling.** Discover of a live stream compresses on the offset grids, the tiling phase 4a measured; with `?review` it keeps plain tiles (the review reads plain tiles only) until 4.3 makes the review read the offset grids.
- **No replay.** A stream has no file: its factors are Discover's own, with the calibration of their time. `factorState` accepts Discover's windows as the factors of a live run.
- **Extract** on the factors is offered once the stream has ended and the last window is compressed; it replaces the live export's NaN-padded fast-loop traces with full traces (`traces_signed` too).
- **Refine** on a live stream exists only as Refine on factors, so only with `?refine=factors`.
- **The note.** The stage log's Extract run of a live stream carries `factors: "discover"` (a file's carries `"replay"`), and the Run panel says: "Live run: these factors are Discover's own; they are not claimed to meet the closeness gate (phase 4a)."
- **The flat field seed:** out of 4.2 (item 6 above).

### Refine on factors in the app (4.2)

- **Binding.** `refine_until_settled` loops inside Rust, which would block the worker for up to 20 iterations with no cancel. The binding exposes one iteration, `SlowLoop.refineOnFactors(reader, settleCorr, settleShare, testFrames)`, on the existing `JsSlowLoop`; JavaScript loops, as `qc_eval` does since phase 3 (`--refine-engine factors` calls one iteration at a time; the phase 3 review proved it equal to `refine_until_settled`). The reader is a duck-typed JS object (`windows`, `read(w)`), imported through `extern "C"` (the crate has no `js_sys`).
- **Which worker.** The slow worker holds the `SlowLoop` (reservoir, statistics, tile bases, published versions); moving it is a restructuring larger than this phase, and nothing serializes a `SlowLoop`. A factor iteration also needs nothing else: no frames, no visit workers (its gate visits run in the loop). So it runs in the slow worker, which during Refine on factors receives no frames. The compress worker owns the files while it writes them; OPFS locks a file with an open synchronous access handle to one worker, so the slow worker opens the factor files only after the compress worker has finished compressing and no back-fill or Extract job runs (the main thread sequences this through `FactorState` and the compress store's job state).
- **Cost.** Phase 3 estimated 25 G multiply-adds per iteration at 600 px with 1000 cells; native, `wl200` took 0.76 to 1.23 s per iteration. In WASM at a few G multiply-adds per second an iteration at 600 px is tens of seconds: the slow worker is busy for that long, status arrives per iteration, and a cancel takes effect at the end of the iteration. Phase 5 measures it.
- **Memory.** One iteration holds one window's factors (18 to 28 MB at 600 px on the offset grids, phase 1) and the held-out patches (about 108 MB as `i16` at 600 px, phase 3) beside the reservoir (about 321 MB at 600 px).
- **The smallest slice that gives the gate** is 4.2's tasks 1 to 6; the Run panel's plots with iterations on the x axis and the multi-session setting "number of Refine runs" becoming on or off (§6) wait until Refine on factors is the default.

### The stores

- **OPFS sizes.** Offset-grid factors: 9.2 MB per 1000 frames at 200 px, 54.9 at 600 px; Discover's plain tiles 4.6 and 31.1 (phase 1, Chrome). Windows waiting to be compressed: 600 frames × pixels × 2 bytes, 48 MB at 200 px and 432 MB at 600 px each. The peak is the waiting windows: phase 1's `v4` Extract replay read 23 711 frames in 196 s while the compressor sustained about 26 frames per second, so at the replay's end about 18 600 frames (31 windows, about 13 GB) waited on disk (inferred from the phase 1 timings, not measured). A Refine replay is slower than an Extract replay (the slow loop paces it), so its backlog is smaller.
- **When the quota runs out.** Today a write failure in the compress worker becomes a compress `error` message; the status bar's compress readout shows its text and nothing else reacts. In 4.1 an error makes the factors `unusable` and Extract replays the file. 4.3 checks the quota before a compressing replay (`navigator.storage.estimate`) and bounds the waiting windows.
- **What is kept, and for how long.** The factors of the newest compressing replay stay in `cala-compress/<run>` until the next Discover of this tab (the compress worker clears its store at `init`) or the next page load (the store removes other runs' folders at first use; a folder another tab holds open is left alone). One session at a time per tab: a new Discover, a new folder, or the next session of a multi-session run starts over. 4.3 writes them to the run's results folder when it has write access (spec §3).

### The e2e gate

- **A simulated stream exists:** `apps/cala/scripts/live-sim.mjs` streams a Miniscope folder over a WebSocket, and `e2e/cala-live.spec.ts` drives it at 200 fps on a synthetic AVI (`buildAvi`, a ramp without cells).
- **No e2e recording has cells.** `buildAvi` writes a ramp; `e2e/cala.spec.ts` asserts "0 cells". Task 7 adds a deterministic cell movie (`cellMovie` in `apps/cala/src/__tests__/synth-avi.ts`): 96 × 96 px, 3000 frames (five windows of 600, 150 s at 20 fps), 16 Gaussian cells on a 4 × 4 grid with sparse transients. Run time: a 96 × 96 file is read at well over 1000 frames per second; Discover, one Refine and Extract should take under two minutes on a CI runner (to be measured in Task 7; the CI job has 20 minutes for the whole suite).
- **What is asserted:** Discover done with at least one cell (more would depend on the runner's speed, since Discover drops batches for the slow loop when it falls behind); Refine done; the factors `ready`; Extract done "(from the factors)" with the library's cells and all 3000 frames; the compress store has no error; the export's bytes contain `"source":"factors"` (`meta_json` is `JSON.stringify` output, stored uncompressed). The fixture fails the test on any `console.error` (worker errors included), any failed same-origin request, any request to another host.
- **CI.** The e2e job (`.github/workflows/ci.yml`, job `e2e`) builds with `npm run build:e2e` and runs `npm run test:e2e` with one retry. The new tests set their own timeout (5 minutes); the Playwright default is 60 s.

### Main's flagged features (A11)

- **Cluster replay.** The app never exposes `joint_update` (the slow loop runs `SlowLoopConfig` defaults, joint off), `refine_on_factors` refuses a joint update until phase 3b, and with the replay on the factors failed the footprint rule on `wl24_01` (0.0305 against 0.02; the raw pipeline's own null loss there is 0.0143). Not exposed.
- **Look-back.** Main's look-back exists in the harness only (`LookBack` in `qc_eval.rs`); the app has no worker that re-reads frames during Discover. Out (A9's factor store random access waits for it).

## Global Constraints

- `?compress=off` keeps today's raw path identical in behaviour: the same pipeline settings for every replay, the same traces, the same export fields (plus `format_version` 7 and `source: "raw"` on each stage record, item 11). Pinned by these existing tests, which must pass unchanged: `pass2-store.test.ts` "replays the recorded frames with the final library and gathers the traces", "keeps the clipped traces only when the solver returns no signed ones", "replays with the flat-field map of pass 1 (applied from frame 0), or none"; `refine-store.test.ts` "starts its replays without any compress setting", "replays the recording into the Discover slow loop and logs the run with its readout"; `pass2.test.ts` "reproduces pass 1 bit for bit with the same library", "returns signed traces with Extract, leaving the traces bit for bit the same"; `run-stages.test.ts` "streams Discover only, with the note about loading a saved stream"; `compress.test.ts` "without compress: no options and no feed"; and by the new e2e test with `?compress=off` (Task 7). The one existing test that changes is `pass2-store.test.ts` "feeds the compressor on the offset grids when compression is on" (its compress setting now comes through `Pass2Factors`; same expected cells).
- No Rust panic reachable from JS: a panic traps the WASM instance and kills its worker. Wrong lengths, a missing window, a library of another size are `JsError`s.
- OPFS file handles are pinned while their access handle opens (`pinned` in `apps/cala/src/lib/window-store.ts`; Chrome loses the open of a handle that nothing references). New code opens files only through `WindowStore.open` (which pins) or through `pinned`.
- `TraceEngine::process_into` and every existing Refine path stay bit-identical; no line of `crates/cala/src/trace/solver.rs` or `crates/cala/src/discover/` changes in 4.1.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on every file touched outside `crates`.
- Rust checks, from `crates/cala`: `cargo fmt --all --check`, `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`, `cargo test --no-default-features --features jsbindings`.
- Browser runs: through `apps/cala/scripts/batch-session.mjs` on a free port (it refuses a taken port) with a fresh `npm run build:e2e` (it refuses a build older than the sources); e2e runs with `npm run build:e2e` then `npm run test:e2e`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push.
- No machine paths or user names in committed files.
- The shell refuses long compound commands (`cd ... &&` chains, loops, heredocs): put anything longer in a script file and run it with one plain command.
- Branch: `feat/cala-factor-extract`, continued.

## Review Focus

1. **A replay that would clear factors.** The compress worker clears its store at every `init`. A second replay must not compress while the factors are `compressing`, `ready` or `unusable`. Pinned in Task 3 ("lets the first replay compress on the offset grids, and no later one") and Task 4 ("replays the file when the factors are not ready, compressing only when there are none").
2. **Factors that do not cover the recording.** A short last window skipped on the offset grids, a cancelled replay, a quota error: Extract must replay the file, never write a trace file with frames missing. Pinned in Task 3 (`factorState` cases) and Task 4 ("ends with an error when the factor windows do not cover every frame").
3. **An Extract job's failure is not a compression failure.** A failed solve must not mark the factors unusable for good, and a compression error must not be read as a job's. Pinned in Task 2 and Task 3.
4. **Stale job messages.** A cancelled Extract or a reset leaves a job running in the compress worker; its messages carry its job number and must not reach a later Extract. Pinned in Task 3.
5. **The raw path under `?compress=off`.** See Global Constraints; the e2e test of Task 7 runs it in the browser.
6. **No panic in the binding.** `lastSigned` before any solve, `setSigned` toggled between solves. Pinned in Task 1.

## File Structure

| File                                                                                                                                  | Change | Responsibility                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `crates/cala/src/compress/js.rs`                                                                                                      | modify | `FactorExtractor.setSigned`, `lastSigned`                                   |
| `crates/cala/src/compress/project.rs`                                                                                                 | modify | test: signed traces from the factors                                        |
| `apps/cala/src/workers/compress-types.ts`                                                                                             | modify | `extract`, `extracted`, `extract-done`, `error.job`                         |
| `apps/cala/src/lib/compress-runner.ts`                                                                                                | modify | `CompressRunner.extract`, `runExtract`                                      |
| `apps/cala/src/workers/compress-worker.ts`, `apps/cala/src/lib/compress-client.ts`                                                    | modify | route `extract`                                                             |
| `apps/cala/src/lib/compress-store.ts`                                                                                                 | modify | `FactorState`, `factorState`, job routing, replay mark, projection, readout |
| `apps/cala/src/lib/factor-extract.ts`                                                                                                 | create | `Pass2Factors`, `createPass2Factors`                                        |
| `apps/cala/src/lib/pass2-store.ts`, `apps/cala/src/lib/refine-store.ts`                                                               | modify | Extract on factors; replays compress through `Pass2Factors`                 |
| `apps/cala/src/lib/run-stages.ts`, `apps/cala/src/lib/export.ts`, `apps/cala/src/lib/result-file.ts`                                  | modify | `source`, `tiling`, `meanRank`; format 7                                    |
| `apps/cala/src/App.tsx`, `apps/cala/src/components/RunPanel.tsx`                                                                      | modify | wiring, the default, `extract-source`                                       |
| `apps/cala/scripts/batch-session.mjs`                                                                                                 | modify | Extract's source in the status file; usage text                             |
| `apps/cala/src/__tests__/compress.test.ts`, `pass2-store.test.ts`, `refine-store.test.ts`, `export.test.ts`, `factor-extract.test.ts` | modify | tests (`factor-extract.test.ts` created)                                    |
| `apps/cala/src/__tests__/synth-avi.ts`, `e2e/cala-factors.spec.ts`                                                                    | modify | the cell movie; the e2e gate on a file (spec created)                       |
| `apps/cala/README.md`, `apps/cala/docs/stages.md`, `docs/CHANGELOG.md`                                                                | modify | docs                                                                        |

---

### Task 1: Signed traces from the factor engine

**Files:**

- Modify: `crates/cala/src/compress/js.rs` (`JsFactorExtractor`, about lines 321 to 410)
- Test: `crates/cala/src/compress/project.rs` (the `tests` module, after `the_arms_agree_with_the_ring_gradient_not_consolidated`, about line 889); `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `FactorExtractor::{new, engine_mut, solve}`, `TraceEngine::{set_signed, signed}`, `FrameTraces::signed` (phase 2; the signed traces are computed in the shared half of the solve, `solve_projected`, about line 769 of `trace/solver.rs`).
- Produces (WASM): `FactorExtractor.setSigned(on: boolean): void`; `FactorExtractor.lastSigned(): Float32Array`: the signed traces of the last `solve`, laid out as its traces (`count x cells`), empty while off or before a solve. The same names as `TraceEngine.setSigned` and `TraceEngine.lastSigned` (`trace/js.rs`, about lines 332 to 345).

- [ ] **Step 1: Write the Rust test**

In `crates/cala/src/compress/project.rs`, in `mod tests`, after `the_arms_agree_with_the_ring_gradient_not_consolidated`:

```rust
    #[test]
    fn signed_traces_from_the_factors_equal_signed_traces_from_the_rebuilt_frames() {
        // The signed trace is the trace plus the gradient over the curvature at
        // the solution; the gradient reads the projections only, so the factor
        // engine gives the frame engine's signed traces to the same rounding.
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let wf = window(tiling, 60, None);
            for model in models() {
                let lib = Arc::new(library(model, CENTRES.len()));
                let mut by_frame = TraceEngine::new(lib.clone(), tight()).unwrap();
                by_frame.set_signed(true);
                let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
                ex.engine_mut().set_signed(true);
                let proj = WindowProjector::new(&lib, &wf).unwrap();
                let mut signed: Vec<Vec<f32>> = Vec::new();
                ex.solve(&wf, &proj, 0, wf.frames, |tr| signed.push(tr.signed.clone()))
                    .unwrap();
                assert_eq!(signed.len(), wf.frames);
                let mut frame = vec![0.0f32; W * H];
                let mut out = FrameTraces::default();
                for (t, s) in signed.iter().enumerate() {
                    wf.reconstruct(t, &mut frame);
                    by_frame.process_into(&frame, &mut out).unwrap();
                    assert_eq!(s.len(), lib.len(), "{tiling:?} frame {t}");
                    for (i, (a, b)) in out.signed.iter().zip(s).enumerate() {
                        assert!(
                            (a - b).abs() <= 10.0 * ARM_TOL * (1.0 + a.abs()),
                            "{tiling:?} frame {t} cell {i}: {a} from the frame, {b} from the factors"
                        );
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Run it**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings signed_traces_from_the_factors`
Expected: PASS (it pins a property of the existing solver; nothing in Rust's library changes for it). If it fails, stop and report the largest gap: it would mean the signed traces need data the projections do not carry, and the design of Task 2 changes.

- [ ] **Step 3: Write the failing JS test**

In `apps/cala/src/__tests__/compress.test.ts`, in `describe('back-fill from the factors', ...)`, add:

```ts
it('gives the signed traces of the frame engine when asked', async () => {
  const lib = cellLibrary();
  const { feed, sent } = collectingFeed(50);
  for (let s = 0; s < 50; s += 10) feed.push(cellFrames(s, 10), s, 10);
  feed.end();
  const { r, store } = runner();
  for (const m of sent) await r.handle(m);
  await r.idle();
  const file = store.files.get(factorName(0))!;
  const ex = new FactorExtractor(lib.bytes, 0, 0);
  const library = TraceLibrary.fromBytes(lib.bytes);
  const engine = new TraceEngine(library, 0, 0);
  try {
    expect(ex.lastSigned().length).toBe(0);
    const n = ex.open(file);
    ex.solve(0, 10);
    expect(ex.lastSigned().length).toBe(0); // off by default
    ex.setSigned(true);
    const traces = ex.solve(10, n - 10);
    const signed = ex.lastSigned();
    expect(signed.length).toBe(traces.length);
    const frames = new Float32Array(n * PX);
    const win = FactorWindow.fromBytes(file);
    try {
      win.reconstruct(0, n, frames);
    } finally {
      win.free();
    }
    engine.setSigned(true);
    engine.processFrames(frames, n);
    const want = engine.lastSigned().subarray(10 * CELLS.length);
    let worst = 0;
    for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(signed[i] - want[i]));
    // Both solves stop at the default tolerance; the tight comparison is the Rust test.
    expect(worst).toBeLessThan(0.1);
    ex.setSigned(false);
    ex.solve(0, 5);
    expect(ex.lastSigned().length).toBe(0);
  } finally {
    ex.free();
    engine.free();
    library.free();
  }
});
```

- [ ] **Step 4: Run to see it fail**

Run from the repository root: `npm run test -w apps/cala -- compress.test.ts`
Expected: FAIL, `ex.lastSigned is not a function`.

- [ ] **Step 5: Implement the binding**

In `crates/cala/src/compress/js.rs`, `JsFactorExtractor` gets a field and two methods, and `solve` keeps the signed traces:

```rust
pub struct JsFactorExtractor {
    inner: FactorExtractor,
    ids: Vec<u32>,
    /// The open window and the library's rows on it; they are replaced together.
    window: Option<(WindowFactors, WindowProjector)>,
    /// Signed traces of the last `solve` (empty while `setSigned` is off).
    signed: Vec<f32>,
}
```

In `new`, initialise `signed: Vec::new()`. After `ids`:

```rust
    /// Also compute the signed (unclipped) traces (`TraceEngine.setSigned`);
    /// off by default. The traces themselves are the same either way.
    #[wasm_bindgen(js_name = setSigned)]
    pub fn set_signed(&mut self, on: bool) {
        self.inner.engine_mut().set_signed(on);
    }

    /// The signed traces of the last `solve`, laid out as its traces
    /// (`count x cells`, frame after frame): each trace plus the residual's
    /// projection on the cell. Empty unless `setSigned(true)`.
    #[wasm_bindgen(js_name = lastSigned)]
    pub fn last_signed(&self) -> Vec<f32> {
        self.signed.clone()
    }
```

`solve` becomes:

```rust
    pub fn solve(&mut self, t0: u32, count: u32) -> Result<Vec<f32>, JsError> {
        self.signed.clear();
        let signed_on = self.inner.engine_mut().signed();
        let Some((wf, proj)) = self.window.as_ref() else {
            return Err(js_err("FactorExtractor.solve", "no window is open"));
        };
        // Checked here too so that a wild `count` never sizes the buffer.
        let end = (t0 as usize).saturating_add(count as usize);
        if end > wf.frames {
            return Err(js_err(
                "FactorExtractor.solve",
                format!("frames {t0}..{end} of {}", wf.frames),
            ));
        }
        let Some(len) = (count as usize).checked_mul(self.ids.len()) else {
            return Err(js_err(
                "FactorExtractor.solve",
                format!("{count} frames of {} cells", self.ids.len()),
            ));
        };
        let mut out = Vec::with_capacity(len);
        let mut signed = Vec::with_capacity(if signed_on { len } else { 0 });
        self.inner
            .solve(wf, proj, t0 as usize, count as usize, |tr| {
                out.extend_from_slice(&tr.traces);
                if signed_on {
                    signed.extend_from_slice(&tr.signed);
                }
            })
            .map_err(|e| js_err("FactorExtractor.solve", e))?;
        self.signed = signed;
        Ok(out)
    }
```

- [ ] **Step 6: Run the tests**

Run from the repository root: `npm run test -w apps/cala -- compress.test.ts`
Expected: PASS, including the unchanged back-fill tests.

- [ ] **Step 7: Check and commit**

From `crates/cala`: the three Rust checks of Global Constraints. From the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala/src/__tests__/compress.test.ts`.

```bash
git add crates/cala/src/compress apps/cala/src/__tests__/compress.test.ts
git commit -m "feat(cala): FactorExtractor returns signed traces on request"
```

---

### Task 2: Extract on factors in the compress worker

**Files:**

- Modify: `apps/cala/src/workers/compress-types.ts`, `apps/cala/src/lib/compress-runner.ts` (`FactorExtractLike` about line 72, `launch` about line 295, after `runBackfill` about line 372, `clear` about line 506), `apps/cala/src/workers/compress-worker.ts`, `apps/cala/src/lib/compress-client.ts`
- Test: `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `FactorExtractor.{setSigned, lastSigned}` (Task 1); `CompressRunner`'s `done`, `final`, `open`, `pending`, `epoch`, `launch`, `BACKFILL_BATCH`, `factorName`.
- Produces:
  - `MainToCompress` gains `{ type: 'extract'; session: number; job: number; library: Uint8Array }` (library transferred).
  - `CompressToMain` gains `{ type: 'extracted'; session: number; job: number; start: number; count: number; ids: Uint32Array; traces: Float32Array; signed: Float32Array }` (`signed` empty when the engine gave none) and `{ type: 'extract-done'; session: number; job: number; frames: number; msPerFrame: number }`; the `error` message gains `job?: number` (set for an Extract job's error, absent for the compression's).
  - `FactorExtractLike` gains optional `setSigned?(on: boolean): void` and `lastSigned?(): Float32Array`.
  - `CompressRunner.extract(session: number, job: number, library: Uint8Array): void`.
  - `CompressClient.extract(session: number, job: number, library: Uint8Array): void`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/compress.test.ts`, after `describe('back-fill from the factors', ...)`:

```ts
describe('Extract on factors (the compress worker)', () => {
  it('solves every window with the given library, with signed traces, and says when it is done', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    r.extract(7, 3, lib.bytes.slice());
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'extracted');
    expect(windows.map((m) => [m.job, m.start, m.count])).toEqual([
      [3, 0, 50],
      [3, 50, 50],
    ]);
    for (const m of windows) {
      expect([...m.ids]).toEqual(CELLS.map((c) => c.id));
      expect(m.signed.length).toBe(m.traces.length);
      for (let i = 0; i < m.count; i++) {
        CELLS.forEach((c, j) => {
          const k = i * CELLS.length + j;
          expect(m.traces[k]).toBeCloseTo(c.trace(m.start + i), 1);
          // These traces stay above 0, so the solve does not clip them.
          expect(m.signed[k]).toBeCloseTo(m.traces[k], 0);
        });
      }
    }
    expect(toMain[toMain.length - 1]).toMatchObject({
      type: 'extract-done',
      session: 7,
      job: 3,
      frames: 100,
    });
    expect(toMain.some((m) => m.type === 'traces' || m.type === 'backfilled')).toBe(false);
  });

  it('refuses, naming the job, while a window is open or for another session', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 60; s += 10) feed.push(cellFrames(s, 10), s, 10);
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m); // window 1 is open: the recording has not ended
    await r.idle();
    r.extract(7, 4, lib.bytes.slice());
    r.extract(99, 5, lib.bytes.slice());
    await r.idle();
    const errors = toMain.filter((m) => m.type === 'error');
    expect(errors.map((m) => [m.session, m.job])).toEqual([
      [7, 4],
      [99, 5],
    ]);
    expect(toMain.some((m) => m.type === 'extracted')).toBe(false);
  });

  it("reports a failed solve as the job's error and keeps compressing later windows", async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    const { r, toMain } = runner(memoryStore(), {
      extract: () => {
        throw new Error('out of memory');
      },
    });
    for (const m of sent) await r.handle(m);
    await r.idle();
    r.extract(7, 6, lib.bytes.slice());
    await r.idle();
    expect(toMain.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', session: 7, job: 6, message: 'out of memory' },
    ]);
    const status = toMain.filter((m) => m.type === 'status').at(-1);
    expect(status).toMatchObject({ status: { final: true, windows: 2 } });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm run test -w apps/cala -- compress.test.ts`
Expected: FAIL, `r.extract is not a function`.

- [ ] **Step 3: Message types**

In `apps/cala/src/workers/compress-types.ts`, `CompressToMain` becomes:

```ts
export type CompressToMain =
  | { type: 'status'; session: number; status: CompressStatus }
  /**
   * Back-filled traces of one window: `count * ids.length` values, frame
   * after frame, solved from the factors with library `version`. `first`
   * marks the first window of a back-fill (earlier traces are replaced).
   */
  | {
      type: 'traces';
      session: number;
      version: number;
      first: boolean;
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
    }
  /** The back-fill is complete: frames solved and wall time per frame, ms. */
  | { type: 'backfilled'; session: number; version: number; frames: number; msPerFrame: number }
  /**
   * Extract on factors, job `job`: one window's traces and signed traces
   * (`count * ids.length` each, frame after frame; `signed` empty when the
   * engine gave none), in stream order.
   */
  | {
      type: 'extracted';
      session: number;
      job: number;
      start: number;
      count: number;
      ids: Uint32Array;
      traces: Float32Array;
      signed: Float32Array;
    }
  /** Extract on factors, job `job`, is complete. */
  | { type: 'extract-done'; session: number; job: number; frames: number; msPerFrame: number }
  /** `job`: the error of that Extract job (the factors stay usable); absent: the compression's. */
  | { type: 'error'; session: number; message: string; job?: number };
```

`MainToCompress` gains, after `backfill`:

```ts
  /**
   * Extract on factors: solve every compressed window with `library`
   * (`TraceLibrary.toBytes()`, transferred) and post them as job `job`.
   */
  | { type: 'extract'; session: number; job: number; library: Uint8Array };
```

- [ ] **Step 4: The runner**

In `apps/cala/src/lib/compress-runner.ts`:

`FactorExtractLike` gains:

```ts
  /** Also compute the signed traces (absent in older fakes: no signed traces). */
  setSigned?(on: boolean): void;
  /** The signed traces of the last `solve`, laid out as its traces (empty when off). */
  lastSigned?(): Float32Array;
```

Fields of `CompressRunner`, after `wanted`:

```ts
  /** Extract jobs waiting for the loop. */
  private jobs: { session: number; job: number; library: Uint8Array }[] = [];
```

After `backfill`:

```ts
  /**
   * Extract on factors, job `job`: solve every compressed window with
   * `library` (signed traces too) and post each window (`extracted`), then
   * `extract-done`. Refused with an `error` naming the job unless this is
   * the session's run and every window is compressed.
   */
  extract(session: number, job: number, library: Uint8Array): void {
    if (session !== this.session || !this.init) {
      this.refuse(session, job, 'no factors of this run');
      return;
    }
    this.jobs.push({ session, job, library });
    this.maybeExtract();
  }

  private refuse(session: number, job: number, why: string): void {
    this.deps.toMain.postMessage({
      type: 'error',
      session,
      job,
      message: `Extract on factors: ${why}.`,
    });
  }

  private maybeExtract(): void {
    if (this.loop) return;
    const next = this.jobs.shift();
    if (!next) return;
    const { extract } = this.deps;
    if (!extract) this.refuse(next.session, next.job, 'this worker has no factor engine');
    else if (this.open || this.pending.length > 0 || !this.final)
      this.refuse(next.session, next.job, 'the factors are not complete');
    else {
      this.launch(this.runExtract(next, extract));
      return;
    }
    this.maybeExtract();
  }
```

In `launch`, the `finally` becomes:

```ts
      .finally(() => {
        this.loop = null;
        // A window closed, or a back-fill or an Extract was asked for, while the loop was busy.
        if (failed) return;
        if (this.pending.length > 0) this.kick();
        else {
          this.maybeBackfill();
          this.maybeExtract();
        }
      });
```

After `runBackfill`:

```ts
  private async runExtract(
    req: { session: number; job: number; library: Uint8Array },
    makeExtractor: (library: Uint8Array) => FactorExtractLike,
  ): Promise<void> {
    const epoch = this.epoch;
    const { session, job } = req;
    const t0 = this.now();
    let extractor: FactorExtractLike | null = null;
    try {
      extractor = makeExtractor(req.library);
      extractor.setSigned?.(true);
      const ids = extractor.ids();
      let frames = 0;
      for (const index of [...this.done]) {
        const file = await this.deps.store.open(factorName(index));
        const bytes = new Uint8Array(file.size());
        file.read(bytes, 0);
        file.close();
        if (epoch !== this.epoch) return;
        const count = extractor.open(bytes);
        const start = extractor.start;
        const traces = new Float32Array(count * ids.length);
        let signed: Float32Array | null = new Float32Array(count * ids.length);
        for (let t = 0; t < count; t += BACKFILL_BATCH) {
          const n = Math.min(BACKFILL_BATCH, count - t);
          traces.set(extractor.solve(t, n), t * ids.length);
          const s = extractor.lastSigned?.();
          if (signed && s && s.length === n * ids.length) signed.set(s, t * ids.length);
          else signed = null;
          await this.yieldNow();
          if (epoch !== this.epoch) return;
        }
        const cellIds = ids.slice();
        const sig = signed ?? new Float32Array(0);
        this.deps.toMain.postMessage(
          { type: 'extracted', session, job, start, count, ids: cellIds, traces, signed: sig },
          [cellIds.buffer as ArrayBuffer, traces.buffer as ArrayBuffer, sig.buffer as ArrayBuffer],
        );
        frames += count;
      }
      this.deps.toMain.postMessage({
        type: 'extract-done',
        session,
        job,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } catch (err) {
      // The job's error, not the compression's: the factors stay as they are.
      if (epoch === this.epoch)
        this.deps.toMain.postMessage({
          type: 'error',
          session,
          job,
          message: err instanceof Error ? err.message : String(err),
        });
    } finally {
      extractor?.free();
    }
  }
```

In `clear`, after `this.pending = [];` add `this.jobs = [];`.

In the file's header comment, after the back-fill paragraph, add: "Extract on factors (`extract`): the same solve over every window with the library the main thread sends, with the signed traces, posted per window under a job number; refused unless every window is compressed. A failed job posts an `error` that names the job; the factors stay usable."

- [ ] **Step 5: Worker and client**

`apps/cala/src/workers/compress-worker.ts`: the first branch of `onmessage` becomes:

```ts
if (data.type === 'backfill' || data.type === 'extract') {
  const r = runner;
  queue = queue
    .then(() => initCalaWasm())
    .then(() => {
      if (data.type === 'backfill') r?.backfill(data.session, data.version);
      else if (r) r.extract(data.session, data.job, data.library);
      else
        workerScope.postMessage({
          type: 'error',
          session: data.session,
          job: data.job,
          message: 'Extract on factors: the compress worker is not connected.',
        });
    })
    .catch((err: unknown) => {
      workerScope.postMessage({
        type: 'error',
        session: data.session,
        ...(data.type === 'extract' ? { job: data.job } : {}),
        message: err instanceof Error ? err.message : String(err),
      });
    });
  return;
}
```

`apps/cala/src/lib/compress-client.ts`: `CompressClient` gains

```ts
  /** Extract on factors: solve every compressed window with `library` as job `job` (the bytes are transferred). */
  extract(session: number, job: number, library: Uint8Array): void;
```

and the returned object:

```ts
    extract(session, job, library) {
      worker.postMessage(
        { type: 'extract', session, job, library } satisfies MainToCompress,
        [library.buffer as ArrayBuffer],
      );
    },
```

- [ ] **Step 6: Run the tests**

Run: `npm run test -w apps/cala -- compress.test.ts`
Expected: PASS, all of the file.

- [ ] **Step 7: Check and commit**

`npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala/src`.

```bash
git add apps/cala/src
git commit -m "feat(cala): the compress worker extracts traces from the factors as a job"
```

---

### Task 3: The run's factors on the main thread

**Files:**

- Modify: `apps/cala/src/lib/compress-store.ts`
- Create: `apps/cala/src/lib/factor-extract.ts`
- Test: create `apps/cala/src/__tests__/factor-extract.test.ts`

**Interfaces:**

- Consumes: `CompressToMain` and `CompressClient.extract` (Task 2); `CompressStatus`; `CellsSettings` (`workers/frame-types.ts`); `FovProjections` (`lib/fov-projection.ts`).
- Produces, in `compress-store.ts`:
  - `type FactorState = 'none' | 'compressing' | 'ready' | 'unusable'`;
  - `factorState(s: CompressStatus | null, error: string | null, replayCompressing: boolean, frames: number): FactorState`;
  - `type ExtractMessage` (the `extracted`, `extract-done` and job `error` messages);
  - store methods `factors(frames: number): FactorState`, `markReplay(): void`, `replayEnded(ok: boolean): void`, `keepProjection(p: FovProjections): void`, `projection(): FovProjections | null`, `onExtract(listener: (m: ExtractMessage) => void): () => void`;
  - `extractSourceText(state: FactorState, s: CompressStatus | null): string`.
- Produces, in `factor-extract.ts`: `interface FactorWindowTraces`, `interface ReplayCompressLike`, `interface Pass2Factors`, `createPass2Factors(store: CompressStore, client: Pick<CompressClient, 'extract'>, session: () => number): Pass2Factors`.

- [ ] **Step 1: Write the failing tests**

Create `apps/cala/src/__tests__/factor-extract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createCompressStore, extractSourceText, factorState } from '../lib/compress-store.ts';
import { createPass2Factors } from '../lib/factor-extract.ts';
import type { FovProjections } from '../lib/fov-projection.ts';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';

const st = (p: Partial<CompressStatus> = {}): CompressStatus => ({
  windows: 2,
  frames: 100,
  pending: 0,
  pendingFrames: 0,
  meanRank: 3,
  msPerFrame: 1,
  factorBytes: 10,
  final: true,
  tiling: 'offset',
  source: 'replay',
  ...p,
});

describe('the factors of a run', () => {
  it('are ready once a replay on the offset grids covers every frame', () => {
    expect(factorState(null, null, false, 100)).toBe('none');
    expect(factorState(st({ source: 'discover', tiling: 'plain' }), null, false, 100)).toBe('none');
    expect(factorState(st({ source: 'discover', tiling: 'plain' }), null, true, 100)).toBe(
      'compressing',
    );
    expect(factorState(st({ final: false, pending: 1 }), null, false, 100)).toBe('compressing');
    expect(factorState(st(), null, false, 100)).toBe('ready');
    // The offset grids skip a last window of one frame: the factors miss it.
    expect(factorState(st({ frames: 99 }), null, false, 100)).toBe('unusable');
    expect(factorState(st({ tiling: 'plain' }), null, false, 100)).toBe('unusable');
    expect(factorState(st(), 'QuotaExceededError', false, 100)).toBe('unusable');
  });

  it('say what Extract will read', () => {
    expect(extractSourceText('ready', st())).toBe('Extract reads the factors (seconds).');
    expect(extractSourceText('compressing', st({ final: false, pending: 3 }))).toBe(
      'Extract replays the file: the factors are being compressed (3 windows waiting).',
    );
    expect(extractSourceText('none', null)).toBe(
      'Extract replays the file; the first replay compresses the frames for later Extracts.',
    );
    expect(extractSourceText('unusable', st())).toBe(
      'Extract replays the file: the factors do not cover the recording.',
    );
  });

  it('let the first replay compress on the offset grids, and no later one', () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {} }, () => 7);
    expect(f.replayCompress(100)).toEqual({
      compress: true,
      compressTiling: 'offset',
      compressSession: 7,
    });
    expect(f.state(100)).toBe('compressing');
    expect(f.replayCompress(100)).toEqual({});
    // A replay cut short releases the mark: the next replay compresses again.
    f.replayEnded(false);
    expect(f.state(100)).toBe('none');
    expect(f.replayCompress(100)).toEqual({
      compress: true,
      compressTiling: 'offset',
      compressSession: 7,
    });
    // A replay that ended leaves the mark until the factors are ready.
    f.replayEnded(true);
    expect(f.state(100)).toBe('compressing');
    const proj = { spans: [] } as unknown as FovProjections;
    f.keepProjection(proj);
    expect(f.projection()).toBe(proj);
    store.onMessage({ type: 'status', session: 7, status: st() });
    expect(f.state(100)).toBe('ready');
    expect(f.info()).toEqual({ tiling: 'offset', meanRank: 3 });
    // A new run forgets everything.
    store.reset(8);
    expect(f.state(100)).toBe('none');
    expect(f.projection()).toBeNull();
  });
});

describe('Extract on factors from the main thread', () => {
  const win = (job: number, start: number): CompressToMain => ({
    type: 'extracted',
    session: 7,
    job,
    start,
    count: 2,
    ids: Uint32Array.of(1),
    traces: new Float32Array(2),
    signed: new Float32Array(2),
  });

  it("passes its job's windows in order and resolves at the job's end", async () => {
    const store = createCompressStore();
    store.reset(7);
    const posted: unknown[] = [];
    const f = createPass2Factors(
      store,
      { extract: (session, job, library) => posted.push({ session, job, n: library.length }) },
      () => 7,
    );
    const got: number[] = [];
    const done = f.extract(Uint8Array.of(1, 2), (w) => got.push(w.start));
    expect(posted).toEqual([{ session: 7, job: 1, n: 2 }]);
    store.onMessage(win(1, 0));
    store.onMessage(win(9, 2)); // another job: not this one's
    store.onMessage({ ...win(1, 2), session: 3 } as CompressToMain); // another run
    store.onMessage(win(1, 2));
    store.onMessage({ type: 'extract-done', session: 7, job: 1, frames: 4, msPerFrame: 0.5 });
    await expect(done).resolves.toEqual({ frames: 4, msPerFrame: 0.5 });
    expect(got).toEqual([0, 2]);
    expect(store.error()).toBeNull();
  });

  it("rejects with the job's error and leaves the compression without one", async () => {
    const store = createCompressStore();
    store.reset(7);
    const f = createPass2Factors(store, { extract() {} }, () => 7);
    const done = f.extract(Uint8Array.of(1), () => {});
    store.onMessage({ type: 'error', session: 7, job: 1, message: 'out of memory' });
    await expect(done).rejects.toThrow('out of memory');
    expect(store.error()).toBeNull();
    // An error without a job is the compression's.
    store.onMessage({ type: 'error', session: 7, message: 'QuotaExceededError' });
    expect(store.error()).toBe('QuotaExceededError');
    expect(f.state(100)).toBe('unusable');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm run test -w apps/cala -- factor-extract.test.ts`
Expected: FAIL, the module `../lib/factor-extract.ts` does not exist.

- [ ] **Step 3: The compress store**

In `apps/cala/src/lib/compress-store.ts`, imports become:

```ts
import { createSignal } from 'solid-js';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';
import type { FovProjections } from './fov-projection.ts';
```

Before `createCompressStore`:

```ts
/**
 * Where the recalibrated factors of a run stand: `ready` once a replay's
 * windows on the offset grids hold every frame and none waits; `unusable`
 * after a compression error or when a finished replay's windows do not hold
 * every frame (a skipped last window of one frame); `compressing` while a
 * replay that compresses runs or its windows wait; `none` otherwise (the next
 * replay may compress).
 */
export type FactorState = 'none' | 'compressing' | 'ready' | 'unusable';

export function factorState(
  s: CompressStatus | null,
  error: string | null,
  replayCompressing: boolean,
  frames: number,
): FactorState {
  if (error) return 'unusable';
  const replayDone = s !== null && s.source === 'replay' && s.final && s.pending === 0;
  if (replayDone)
    return s.tiling === 'offset' && frames > 0 && s.frames === frames ? 'ready' : 'unusable';
  if (replayCompressing || s?.source === 'replay') return 'compressing';
  return 'none';
}

/** The messages of an Extract job. */
export type ExtractMessage =
  | Extract<CompressToMain, { type: 'extracted' | 'extract-done' }>
  | (Extract<CompressToMain, { type: 'error' }> & { job: number });

/** What Extract will read now (the Run panel, compression on). */
export function extractSourceText(state: FactorState, s: CompressStatus | null): string {
  switch (state) {
    case 'ready':
      return 'Extract reads the factors (seconds).';
    case 'compressing':
      return `Extract replays the file: the factors are being compressed${
        s && s.pending > 0 ? ` (${s.pending} windows waiting)` : ''
      }.`;
    case 'unusable':
      return 'Extract replays the file: the factors do not cover the recording.';
    default:
      return 'Extract replays the file; the first replay compresses the frames for later Extracts.';
  }
}
```

In `createCompressStore`, after `let requested = -1;`:

```ts
/** A replay that compresses has started and was not cut short. */
let replayCompressing = false;
/** Projections of the replay that made the factors (a factor Extract's FOV images). */
let projection: FovProjections | null = null;
const listeners = new Set<(m: ExtractMessage) => void>();
```

`reset` also sets `replayCompressing = false;` and `projection = null;`. `onMessage` becomes:

```ts
    onMessage(msg: CompressToMain): void {
      if (msg.type === 'error') {
        // An Extract job's error is the job's: the factors stay usable.
        if (msg.job !== undefined) {
          if (msg.session === session)
            for (const l of listeners) l(msg as ExtractMessage);
          return;
        }
        setError(msg.message);
        return;
      }
      if (msg.session !== session) return;
      if (msg.type === 'status') setStatus(msg.status);
      else if (msg.type === 'traces') {
        sink?.onBackfill(msg.first, msg.start, msg.count, msg.ids, msg.traces);
      } else if (msg.type === 'backfilled') {
        setBackfill({ version: msg.version, frames: msg.frames, msPerFrame: msg.msPerFrame });
      } else for (const l of listeners) l(msg);
    },
```

and the store returns, besides what it returns today:

```ts
    /** Where the factors of this run stand, for a recording of `frames` frames. */
    factors: (frames: number): FactorState =>
      factorState(status(), error(), replayCompressing, frames),
    /** A replay that compresses starts. */
    markReplay(): void {
      replayCompressing = true;
    },
    /** That replay ended; `ok` false: cut short, its windows are dropped. */
    replayEnded(ok: boolean): void {
      if (!ok) replayCompressing = false;
    },
    keepProjection(p: FovProjections): void {
      projection = p;
    },
    projection: (): FovProjections | null => projection,
    /** Listen to Extract jobs' messages; returns the unsubscribe. */
    onExtract(listener: (m: ExtractMessage) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
```

- [ ] **Step 4: The Extract side**

Create `apps/cala/src/lib/factor-extract.ts`:

```ts
/**
 * The factors of a run, as the Extract and Refine stores see them
 * (compression on): whether the next replay compresses, and Extract on
 * factors through the compress worker. Absent when compression is off
 * (`?compress=off`): the stores then replay the file as before.
 */
import type { CompressClient } from './compress-client.ts';
import type { CompressStore, FactorState } from './compress-store.ts';
import type { FovProjections } from './fov-projection.ts';
import type { CompressTiling } from '../workers/compress-types.ts';
import type { CellsSettings } from '../workers/frame-types.ts';

/** One window of a factor Extract: `count * ids.length` traces and signed traces (empty: none). */
export interface FactorWindowTraces {
  start: number;
  count: number;
  ids: Uint32Array;
  traces: Float32Array;
  signed: Float32Array;
}

/** What a replay needs: its compress settings, and where its outcome goes. */
export interface ReplayCompressLike {
  /** The compress settings of a replay about to start over `frames` frames: on the offset grids when no factors exist, else none. */
  replayCompress(
    frames: number,
  ): Pick<CellsSettings, 'compress' | 'compressTiling' | 'compressSession'>;
  /** The replay ended; `ok` false: cut short (its windows are dropped). */
  replayEnded(ok: boolean): void;
  /** The replay's projections, for a later factor Extract's FOV images. */
  keepProjection(p: FovProjections): void;
}

export interface Pass2Factors extends ReplayCompressLike {
  state(frames: number): FactorState;
  /** Solve every window with `library`; `onWindow` gets them in stream order. */
  extract(
    library: Uint8Array,
    onWindow: (w: FactorWindowTraces) => void,
  ): Promise<{ frames: number; msPerFrame: number }>;
  projection(): FovProjections | null;
  /** Tiling and mean rank of the replay's factors (null: no replay factors). */
  info(): { tiling: CompressTiling; meanRank: number } | null;
}

export function createPass2Factors(
  store: CompressStore,
  client: Pick<CompressClient, 'extract'>,
  session: () => number,
): Pass2Factors {
  let nextJob = 1;
  return {
    state: (frames) => store.factors(frames),
    replayCompress(frames) {
      if (store.factors(frames) !== 'none') return {};
      store.markReplay();
      return { compress: true, compressTiling: 'offset', compressSession: session() };
    },
    replayEnded: (ok) => store.replayEnded(ok),
    keepProjection: (p) => store.keepProjection(p),
    projection: () => store.projection(),
    info() {
      const s = store.status();
      return s && s.source === 'replay' ? { tiling: s.tiling, meanRank: s.meanRank } : null;
    },
    extract(library, onWindow) {
      const job = nextJob++;
      return new Promise((resolve, reject) => {
        const stop = store.onExtract((m) => {
          if (m.job !== job) return;
          if (m.type === 'extracted') onWindow(m);
          else if (m.type === 'extract-done') {
            stop();
            resolve({ frames: m.frames, msPerFrame: m.msPerFrame });
          } else {
            stop();
            reject(new Error(m.message));
          }
        });
        client.extract(session(), job, library.slice());
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -w apps/cala -- factor-extract.test.ts compress.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

`npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala/src`.

```bash
git add apps/cala/src
git commit -m "feat(cala): the main thread tracks the run's factors and sends Extract jobs"
```

---

### Task 4: Extract reads the factors; the first replay compresses

**Files:**

- Modify: `apps/cala/src/lib/pass2-store.ts` (`Pass2Result` about line 56, `compressCells` about line 80, `createPass2Store` about line 88, `handle` about line 145, `pump` about line 220, `run` about line 253, `cancel` about line 343, `clear` about line 353), `apps/cala/src/lib/refine-store.ts` (`RefineQcOptions` about line 41, `Ctx` about line 96, `fail` about line 224, `pump` about line 236, `run` about line 276, `cancel` about line 351), `apps/cala/src/App.tsx` (about lines 121 to 208)
- Test: `apps/cala/src/__tests__/pass2-store.test.ts`, `apps/cala/src/__tests__/refine-store.test.ts`

**Interfaces:**

- Consumes: `Pass2Factors`, `ReplayCompressLike`, `FactorWindowTraces`, `createPass2Factors` (Task 3); `CompressClient.extract` (Task 2).
- Produces:
  - `Pass2Result` gains `source?: 'raw' | 'factors'` (absent: raw), `tiling?: CompressTiling`, `meanRank?: number`.
  - `createPass2Store(client, pipeline, cells, clock?, blocked?, factors?: Pass2Factors)`: the sixth parameter replaces `compressSession?: () => number | null`.
  - `Pass2Store.run(use?: { library: LibraryView; bytes: Uint8Array }, from: 'auto' | 'raw' = 'auto')`; `Pass2Store.source(): 'raw' | 'factors'` (the current or last run's).
  - `RefineQcOptions.compress?: ReplayCompressLike`.

- [ ] **Step 1: Find what a replay's `done` step carries**

Read `apps/cala/src/workers/trace-worker.ts` about lines 72 to 97. Expected: `BackStage` gets a `FovProjector` whenever `cells.projection` is set, whatever `refine` and `discover` are, and the `done` step carries `projection` then. If a Refine replay cannot carry `projection`, stop and report: decision 9 then needs another source of the FOV images.

- [ ] **Step 2: Write the failing tests**

`apps/cala/src/__tests__/pass2-store.test.ts`: imports gain

```ts
import type { FactorState } from '../lib/compress-store.ts';
import type { FactorWindowTraces, Pass2Factors } from '../lib/factor-extract.ts';
import type { FovProjections } from '../lib/fov-projection.ts';
```

`setup`'s option `compressSession?: number` becomes `factors?: Pass2Factors`, and its store is built with `opts.factors` as the sixth argument (in place of the `compressSession` getter). `setup` also gets the option `hang?: boolean`: its client's `stepPipeline` then returns `new Promise<PipelineStepResult>(() => {})` (the replay never answers, so it is still running when the test cancels it). Add helpers after `batch`:

```ts
/** One window of a factor Extract, with the traces `batch` would give. */
function win(start: number, count: number, ids = IDS): FactorWindowTraces {
  const traces = new Float32Array(count * ids.length);
  for (let f = 0; f < count; f++)
    for (let c = 0; c < ids.length; c++) traces[f * ids.length + c] = 10 * (start + f) + c;
  return { start, count, ids, traces, signed: traces.map((v) => v - 1000) };
}

/** Factors in `state`; Extract on them gives `windows`. */
function fakeFactors(state: FactorState, windows: FactorWindowTraces[] = []) {
  const calls: string[] = [];
  const proj = { spans: [] } as unknown as FovProjections;
  const kept: FovProjections[] = [];
  const f: Pass2Factors = {
    state: () => state,
    replayCompress: () => {
      calls.push('compress');
      return state === 'none'
        ? { compress: true, compressTiling: 'offset', compressSession: 4 }
        : {};
    },
    replayEnded: (ok) => void calls.push(`ended ${ok}`),
    keepProjection: (p) => void kept.push(p),
    projection: () => proj,
    info: () => ({ tiling: 'offset', meanRank: 4.5 }),
    async extract(library, onWindow) {
      calls.push(`extract ${library.length}`);
      for (const w of windows) onWindow(w);
      return { frames: windows.reduce((s, w) => s + w.count, 0), msPerFrame: 0.1 };
    },
  };
  return { f, calls, proj, kept };
}
```

Replace the test "feeds the compressor on the offset grids when compression is on" by:

```ts
it('feeds the compressor on the offset grids when compression is on and no factors exist', async () => {
  const { f, calls } = fakeFactors('none');
  const { store, started } = setup({ factors: f });
  await store.run();
  await settle();
  expect(store.status()).toBe('done');
  expect(calls).toEqual(['compress']);
  expect(started[0].cells).toEqual({
    session: 0,
    discover: false,
    qc: false,
    signed: true,
    projection: true,
    library: Uint8Array.of(1, 2, 3),
    compress: true,
    compressTiling: 'offset',
    compressSession: 4,
  });
  expect(store.result()?.source).toBe('raw');
});

it('replays the file when the factors are not ready, compressing only when there are none', async () => {
  for (const state of ['compressing', 'unusable'] as const) {
    const { f, calls } = fakeFactors(state);
    const { store, started } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(calls).toEqual([]);
    const keys = Object.keys(started[0].cells as object);
    expect(keys.filter((k) => k.startsWith('compress'))).toEqual([]);
  }
});

it('solves on the factors when they are ready, without replaying the file', async () => {
  const { f, calls, proj } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
  const { store, started } = setup({ factors: f });
  await store.run();
  await settle();
  expect(store.status()).toBe('done');
  expect(started).toHaveLength(0);
  expect(calls).toEqual(['extract 3']);
  expect(store.source()).toBe('factors');
  const r = store.result()!;
  expect(r).toMatchObject({ source: 'factors', tiling: 'offset', meanRank: 4.5 });
  expect(r.frames).toBe(8);
  expect(r.cells).toBe(2);
  expect(r.projection).toBe(proj);
  expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
  expect([...(await r.signed!.readFrames(5, 6))]).toEqual([-950, -949]);
  expect(store.processed()).toBe(8);
});

it('replays the file when asked, even with the factors ready', async () => {
  const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
  const { store, started } = setup({ factors: f });
  await store.run(undefined, 'raw');
  await settle();
  expect(store.status()).toBe('done');
  expect(started).toHaveLength(1);
  expect(calls).toEqual([]);
  expect(store.result()?.source).toBe('raw');
});

it('ends with an error when the factor windows do not cover every frame', async () => {
  const { f } = fakeFactors('ready', [win(0, 4)]);
  const { store } = setup({ factors: f });
  await store.run();
  await settle();
  expect(store.status()).toBe('error');
  expect(store.error()).toMatch(/4 of 8 frames/);
  expect(store.result()).toBeNull();
});

it('ends with an error when the factor windows are for another library', async () => {
  const { f } = fakeFactors('ready', [win(0, 4, Uint32Array.of(3, 9)), win(4, 4)]);
  const { store } = setup({ factors: f });
  await store.run();
  await settle();
  expect(store.status()).toBe('error');
  expect(store.error()).toMatch(/final library/);
});

it('keeps the projections of a replay that compressed', async () => {
  const { f, calls, kept } = fakeFactors('none');
  const { store, steps } = setup({ factors: f });
  const proj = { spans: [] } as unknown as FovProjections;
  steps[2] = { kind: 'done', projection: proj } as PipelineStepResult;
  await store.run();
  await settle();
  expect(store.status()).toBe('done');
  expect(kept).toEqual([proj]);
  expect(calls).toEqual(['compress']);
});

it('releases the compress mark when its replay is cancelled', async () => {
  const { f, calls } = fakeFactors('none');
  const { store } = setup({ factors: f, hang: true });
  await store.run();
  store.cancel();
  expect(calls).toEqual(['compress', 'ended false']);
});
```

`apps/cala/src/__tests__/refine-store.test.ts`: `setup` gains the option `projection?: FovProjections` (its last step becomes `{ kind: 'done', ...(opts.projection ? { projection: opts.projection } : {}) }`) and passes `opts.refineQc` as today. Add (import `FovProjections` from `../lib/fov-projection.ts` and `ReplayCompressLike` from `../lib/factor-extract.ts`):

```ts
it('compresses its replay when the factors say so, and keeps its projections', async () => {
  const proj = { spans: [] } as unknown as FovProjections;
  const calls: string[] = [];
  const compress: ReplayCompressLike = {
    replayCompress: () => {
      calls.push('compress');
      return { compress: true, compressTiling: 'offset', compressSession: 7 };
    },
    replayEnded: (ok) => void calls.push(`ended ${ok}`),
    keepProjection: (p) => void calls.push(p === proj ? 'projection' : 'other'),
  };
  const t = setup({ refineQc: { compress }, projection: proj });
  await t.store.run();
  expect(t.started[0].cells).toMatchObject({
    compress: true,
    compressTiling: 'offset',
    compressSession: 7,
    projection: true,
  });
  await until(() => t.store.status() === 'done');
  expect(calls).toEqual(['compress', 'projection']);
  expect(t.log.last('refine')?.source).toBe('raw');
});

it('releases the compress mark when its replay is cancelled', async () => {
  const calls: string[] = [];
  const t = setup({
    lagging: true,
    refineQc: {
      compress: {
        replayCompress: () => ({ compress: true, compressTiling: 'offset', compressSession: 7 }),
        replayEnded: (ok) => void calls.push(`ended ${ok}`),
        keepProjection: () => {},
      },
    },
  });
  await t.store.run();
  t.store.cancel();
  expect(calls).toEqual(['ended false']);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm run test -w apps/cala -- pass2-store.test.ts refine-store.test.ts`
Expected: FAIL (type errors on `factors` and `compress`, `store.source` undefined).

- [ ] **Step 4: The Extract store**

In `apps/cala/src/lib/pass2-store.ts`:

- Imports gain `import type { CompressTiling } from '../workers/compress-types.ts';` and `import type { FactorWindowTraces, Pass2Factors } from './factor-extract.ts';`.
- `Pass2Result` gains, after `projection`:

```ts
  /** Where Extract read the frames: the recording or the factors (absent: the recording; older code). */
  source?: 'raw' | 'factors';
  /** From the factors: their tiling and mean rank per tile. */
  tiling?: CompressTiling;
  meanRank?: number;
```

- Remove `compressCells`.
- The last parameter of `createPass2Store` becomes:

```ts
  /**
   * Compression on: the run's factors. Extract reads them once they are
   * ready; else it replays the file, which compresses when there are none
   * yet. Absent (`?compress=off`): Extract replays the file, as before.
   */
  factors?: Pass2Factors,
```

- After `const [motionBackend, ...]`: `const [source, setSource] = createSignal<'raw' | 'factors'>('raw');` and after `let signedFile ...`: `/** The current replay feeds the compress worker. */ let compressing = false;`.
- A helper before `handle`:

```ts
/** The current replay that compressed ended early: its windows are dropped. */
function releaseCompress(): void {
  if (compressing) factors?.replayEnded(false);
  compressing = false;
}
```

- In `handle`, case `'done'`, before `setResult`: `if (step.projection) factors?.keepProjection(step.projection);` and `compressing = false;` (its windows finish in the compress worker); `setResult` gains `source: 'raw',`.
- In `pump`'s `.catch`, before `generation++`: `releaseCompress();`. In `cancel`, before `generation++`: `releaseCompress();`. In `clear`, before `if (status() === 'running') generation++;`: `if (status() === 'running') releaseCompress();`.
- `run` becomes (the parts not shown are unchanged):

```ts
async function run(
  use?: { library: LibraryView; bytes: Uint8Array },
  /** `raw`: replay the file even when the factors are ready (measurements). */
  from: 'auto' | 'raw' = 'auto',
): Promise<void> {
  const reason = blockedReason();
  if (reason) {
    setError(reason);
    setStatus('error');
    return;
  }
  const gen = ++generation;
  inFlight = 0;
  exhausted = false;
  compressing = false;
  setStatus('running');
  setError(null);
  await discard();
  setProcessed(0);
  setFps(0);
  setStageBusy([]);
  setMotionBackend(null);
  const plan1 = pipeline.plan() as PipelinePlan;
  const rec = pipeline.record();
  const library = use?.library ?? cells.library()!;
  const bytes = use?.bytes ?? cells.libraryBytes()!;
  const frames = rec.frames;
  const flatMap = pipeline.flatFieldMap();
  const cellCount = library.ids.length;
  const state = factors?.state(frames) ?? 'none';
  const onFactors = factors !== undefined && from === 'auto' && state === 'ready';
  setSource(onFactors ? 'factors' : 'raw');
  setTotal(frames);
  // ... trace files as today, unchanged ...
  file = traces;
  signedFile = signed;
  const ctx: Ctx = {
    frames,
    cellCount,
    ids: library.ids.slice(),
    traces,
    signed,
    library,
    meter: new ThroughputMeter(),
    busy: [],
    done: 0,
    t0: clock(),
  };
  if (onFactors && factors) {
    void runOnFactors(gen, ctx, factors, bytes);
    return;
  }
  const comp = factors && state === 'none' ? factors.replayCompress(frames) : {};
  compressing = comp.compress === true;
  try {
    await startReplayPipeline(
      client,
      plan1,
      {
        session: 0,
        discover: false,
        library: bytes,
        signed: true,
        projection: true,
        ...comp,
      },
      { frames, record: rec, flatField: flatMap },
    );
    if (gen !== generation) return;
    ctx.t0 = clock();
    pump(gen, ctx);
  } catch (err) {
    if (gen !== generation) return;
    releaseCompress();
    generation++;
    setError(err instanceof Error ? err.message : String(err));
    setStatus('error');
  }
}

/** Extract on factors: the compress worker solves every window; the traces go to the same files. */
async function runOnFactors(
  gen: number,
  ctx: Ctx,
  f: Pass2Factors,
  bytes: Uint8Array,
): Promise<void> {
  let bad: string | null = null;
  const take = (w: FactorWindowTraces): void => {
    if (gen !== generation || bad) return;
    if (w.ids.length !== ctx.cellCount || w.ids.some((id, i) => id !== ctx.ids[i])) {
      bad = 'Extract got no traces for the final library.';
      return;
    }
    ctx.traces.append(w.start, w.traces);
    if (ctx.signed) {
      if (w.signed.length === w.traces.length) ctx.signed.append(w.start, w.signed);
      else {
        console.warn(
          'Extract: the factor engine returned no signed traces; exporting clipped only.',
        );
        const s = ctx.signed;
        ctx.signed = null;
        signedFile = null;
        void s.dispose().catch(() => {});
      }
    }
    ctx.done = w.start + w.count;
    setProcessed(ctx.done);
    setFps(ctx.meter.record(clock(), w.count));
  };
  try {
    await f.extract(bytes, take);
    if (gen !== generation) return;
    if (bad) throw new Error(bad);
    if (ctx.done !== ctx.frames)
      throw new Error(`Extract on factors ended after ${ctx.done} of ${ctx.frames} frames.`);
    await ctx.traces.finish();
    await ctx.signed?.finish();
    if (gen !== generation) return;
    const info = f.info();
    const projection = f.projection();
    setResult({
      ids: ctx.ids,
      traces: ctx.traces,
      signed: ctx.signed,
      frames: ctx.frames,
      cells: ctx.cellCount,
      version: ctx.library.version,
      library: ctx.library,
      seconds: (clock() - ctx.t0) / 1000,
      source: 'factors',
      ...(info ? { tiling: info.tiling, meanRank: info.meanRank } : {}),
      ...(projection ? { projection } : {}),
    });
    setStatus('done');
  } catch (err) {
    if (gen !== generation) return;
    generation++;
    setError(err instanceof Error ? err.message : String(err));
    setStatus('error');
    void discard();
  }
}
```

- The returned object gains `source,` after `motionBackend,`.
- The file's header comment gains a paragraph: "With compression on (`factors`), Extract reads the run's factors once they are ready (`FactorState`): the compress worker solves every window with the final library (`FactorExtractor`, signed traces too) and the traces go to the same files; the FOV images come from the replay that made the factors. Otherwise it replays the file, and that replay compresses the frames on the offset grids when no factors exist yet."

- [ ] **Step 5: The Refine store**

In `apps/cala/src/lib/refine-store.ts`: import `import type { ReplayCompressLike } from './factor-extract.ts';`. `RefineQcOptions` gains:

```ts
  /** Compression on: whether this replay compresses, and where its outcome goes (absent: off). */
  compress?: ReplayCompressLike;
```

`Ctx` gains `/** This replay feeds the compress worker. */ compressing: boolean;`. In `run`, before `const ctx: Ctx = {`: `const comp = options.compress?.replayCompress(rec.frames) ?? {};`; the context gets `compressing: comp.compress === true,`; the replay's cells become:

```ts
        {
          session: cells.session(),
          discover: true,
          library: bytes,
          refine: true,
          forwardBuffers: REFINE_FORWARD_BUFFERS,
          ...comp,
          ...(comp.compress ? { projection: true } : {}),
        },
```

In `pump`, the `done` branch begins with:

```ts
          } else if (step.kind === 'done' && !exhausted) {
            if (step.projection) options.compress?.keepProjection(step.projection);
            ctx.compressing = false;
```

A helper next to `dropTraces`:

```ts
/** A replay that compressed ended early: its windows are dropped. */
function releaseCompress(ctx: Ctx): void {
  if (ctx.compressing) options.compress?.replayEnded(false);
  ctx.compressing = false;
}
```

`fail` calls `releaseCompress(ctx)` inside `if (ctx) {`; `cancel` calls `releaseCompress(current)` inside `if (current) {`. `record`'s `data` gains `source: 'raw',`.

- [ ] **Step 6: Wire it in the app (still under `?compress`)**

In `apps/cala/src/App.tsx`, import `createPass2Factors` from `./lib/factor-extract.ts`; after `compressClient` (about line 128):

```ts
// The run's factors for Extract and the replays (compression on).
const factors =
  compress && compressClient
    ? createPass2Factors(compress, compressClient, () => cells.session())
    : undefined;
```

`createPass2Store`'s last argument `compress ? () => cells.session() : undefined` becomes `factors`; `createRefineStore`'s options object gains `...(factors ? { compress: factors } : {}),`.

- [ ] **Step 7: Run the tests**

Run: `npm run test -w apps/cala -- pass2-store.test.ts refine-store.test.ts pass2.test.ts`
Expected: PASS, the new tests and every test named in Global Constraints unchanged.

- [ ] **Step 8: Check and commit**

`npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala/src`.

```bash
git add apps/cala/src
git commit -m "feat(cala): Extract reads the factors once a replay has made them"
```

---

### Task 5: Stage records, export format 7 and the Run panel

**Files:**

- Modify: `apps/cala/src/lib/run-stages.ts` (`StageRun`, about line 113), `apps/cala/src/lib/export.ts` (`EXPORT_FORMAT_VERSION` about line 160, the stage paragraph of the header about line 65, `stageMeta` about line 220), `apps/cala/src/lib/result-file.ts` (`stagesFromMeta`, about line 91; the header's version list), `apps/cala/src/App.tsx` (Discover's and Extract's stage ends, about lines 249 and 287), `apps/cala/src/components/RunPanel.tsx` (`pass2Text` about line 281; the Extract footer about line 827)
- Test: `apps/cala/src/__tests__/export.test.ts`

**Interfaces:**

- Consumes: `Pass2Result.{source, tiling, meanRank}`, `Pass2Store.source` (Task 4); `extractSourceText`, `CompressStore.factors` (Task 3).
- Produces: `StageRun` gains `source?: 'raw' | 'factors'`, `tiling?: CompressTiling`, `meanRank?: number`; `meta_json.stages[]` gains `source`, `tiling`, `mean_rank`; `EXPORT_FORMAT_VERSION` 7; `stagesFromMeta` reads them; the Run panel's `extract-source` line.

- [ ] **Step 1: Write the failing test**

In `apps/cala/src/__tests__/export.test.ts`, import `stageMeta` from `../lib/export.ts` and `stagesFromMeta` from `../lib/result-file.ts`; add:

```ts
describe('stage records (format 7)', () => {
  const base = {
    index: 1,
    startedAt: '2026-11-19T10:00:00.000Z',
    endedAt: '2026-11-19T10:00:05.000Z',
    outcome: 'done',
    frames: 8,
    cells: 2,
    libraryVersion: 3,
  } as const;

  it('say where each stage read its frames, and read back', () => {
    expect(EXPORT_FORMAT_VERSION).toBe(7);
    const factors = stageMeta({
      ...base,
      stage: 'extract',
      source: 'factors',
      tiling: 'offset',
      meanRank: 4.5,
    });
    expect(factors).toMatchObject({ source: 'factors', tiling: 'offset', mean_rank: 4.5 });
    const raw = stageMeta({ ...base, stage: 'refine', source: 'raw' });
    expect(raw.source).toBe('raw');
    expect('tiling' in raw).toBe(false);
    expect('mean_rank' in raw).toBe(false);
    const old = stageMeta({ ...base, stage: 'discover' });
    expect('source' in old).toBe(false);
    expect(stagesFromMeta([factors, raw])).toMatchObject([
      { stage: 'extract', source: 'factors', tiling: 'offset', meanRank: 4.5 },
      { stage: 'refine', source: 'raw' },
    ]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run test -w apps/cala -- export.test.ts`
Expected: FAIL (`EXPORT_FORMAT_VERSION` is 6; `source` is not written).

- [ ] **Step 3: Implement**

`run-stages.ts`: import `import type { CompressTiling } from '../workers/compress-types.ts';`; `StageRun` gains, after `series`:

```ts
  /** Where the stage read its frames: the recording or the factors (format 7). */
  source?: 'raw' | 'factors';
  /** From the factors: their tiling and mean rank per tile. */
  tiling?: CompressTiling;
  meanRank?: number;
```

`export.ts`: `EXPORT_FORMAT_VERSION = 7`; in the header, after the paragraph "Run stages (format version 3)", add: " * Stage sources (format version 7): each stage record has `source`: `raw` (the stage read the recording) or `factors` (it read the compressed factors); a factor stage also has `tiling` (`plain`, `offset`) and `mean_rank` (mean kept rank per tile)."; in `stageMeta`, before `if (r.series)`:

```ts
if (r.source) out.source = r.source;
if (r.tiling) out.tiling = r.tiling;
if (r.meanRank !== undefined) out.mean_rank = r.meanRank;
```

`result-file.ts`, in `stagesFromMeta` before `return r;`:

```ts
if (x.source === 'raw' || x.source === 'factors') r.source = x.source;
if (x.tiling === 'plain' || x.tiling === 'offset') r.tiling = x.tiling;
if (typeof x.mean_rank === 'number') r.meanRank = x.mean_rank;
```

and its header's sentence "Every format version opens" gains "; 7 adds the stage sources".

`App.tsx`: Discover's `data` (about line 249) gains `source: 'raw',`; Extract's `stageLog.end('extract', 'done', {...})` (about line 287) gains:

```ts
            ...(r?.source ? { source: r.source } : {}),
            ...(r?.tiling ? { tiling: r.tiling } : {}),
            ...(r?.meanRank !== undefined ? { meanRank: r.meanRank } : {}),
```

`RunPanel.tsx`: import `extractSourceText` with `compressReadout`. `pass2Text` becomes:

```ts
  const pass2Text = () => {
    const fromFactors = p().source() === 'factors';
    switch (p().status()) {
      case 'running':
        return fromFactors
          ? 'Extract: solving the traces of every frame from the factors'
          : 'Extract: solving the traces of every frame with the final footprints';
      case 'done': {
        const res = p().result();
        const from = fromFactors ? ' (from the factors)' : '';
        return res
          ? `Extract done${from}: ${res.cells} cells x ${res.frames.toLocaleString()} frames in ${res.seconds.toFixed(1)} s (${(res.frames / res.seconds).toFixed(0)} frames/s)`
          : `Extract done${from}`;
      }
```

(the other cases unchanged). After the Extract status footer (`data-testid="pass2-status"`, about line 845), add:

```tsx
<Show when={props.compress && !props.live && s().status() === 'done' && p().status() !== 'running'}>
  <p class="cala-muted cala-run__line" data-testid="extract-source">
    {extractSourceText(props.compress!.factors(s().record().frames), props.compress!.status())}
  </p>
</Show>
```

- [ ] **Step 4: Run the tests**

Run: `npm run test -w apps/cala`
Expected: PASS. If `result-file.test.tsx` asserts the format version of a written file, update that number to 7 (and only that).

- [ ] **Step 5: Check and commit**

`npm run typecheck`, `npm run lint`, `npx prettier --check apps/cala/src`.

```bash
git add apps/cala/src
git commit -m "feat(cala): stage records and the export say whether a stage read the file or the factors"
```

---

### Task 6: Compression on by default

**Files:**

- Modify: `apps/cala/src/lib/compress-store.ts` (`compressionOn`), `apps/cala/src/App.tsx` (about lines 97 to 128), `apps/cala/scripts/batch-session.mjs` (usage text at the top; the snapshot `snap`; the Extract branch of the poll loop)
- Test: `apps/cala/src/__tests__/factor-extract.test.ts`

**Interfaces:**

- Consumes: everything of Tasks 1 to 5.
- Produces: `compressionOn(params: URLSearchParams): boolean`; the batch driver's `status.stages.extract.source`.

- [ ] **Step 1: Write the failing test**

In `apps/cala/src/__tests__/factor-extract.test.ts`, import `compressionOn` from `../lib/compress-store.ts`; add:

```ts
describe('the compression switch', () => {
  it('is on unless the URL says compress=off', () => {
    expect(compressionOn(new URLSearchParams(''))).toBe(true);
    expect(compressionOn(new URLSearchParams('compress'))).toBe(true);
    expect(compressionOn(new URLSearchParams('debug&compress&review'))).toBe(true);
    expect(compressionOn(new URLSearchParams('compress=off'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run test -w apps/cala -- factor-extract.test.ts`
Expected: FAIL, `compressionOn` is not exported.

- [ ] **Step 3: Implement**

`compress-store.ts`, before `createCompressStore`:

```ts
/**
 * Compression is on unless the URL has `compress=off` (then Refine and
 * Extract replay the file as before phase 4). `?compress` alone, the old
 * opt-in, still means on.
 */
export function compressionOn(params: URLSearchParams): boolean {
  return params.get('compress') !== 'off';
}
```

`App.tsx`: import `compressionOn` with `createCompressStore`. Before `reviewWindows`:

```ts
// Compression is on by default; `?compress=off` replays the file for Refine and Extract.
const compressOn = compressionOn(params);
```

`reviewWindows` becomes `compressOn ? reviewEvery(params.get('review')) : null;` and its comment "`?review`: the history review (compression on), every 8 compressed windows (`?review=N`: every N), in a worker of its own. One core is left for it."; `compress` becomes `compressOn ? createCompressStore(cells) : undefined;` with the comment "The compress worker: windows and factors are files in OPFS (on by default; `?compress=off`)."

`batch-session.mjs`:

- In the usage comment, replace the `--query compress` lines by: "`[--query compress=off]` appended to the app URL (Cala/?debug&compress=off): the raw path; compression is on by default, and `status.json` holds the compress status at the end of Discover and of Extract, the back-fill of Discover's recording (waited for, up to --compress-wait s; null: skipped, `{ arrived: false }`: none arrived in time) and Extract's source (`raw` or `factors`)".
- In `snap`, add `extractSource: c.pass2.result?.()?.source ?? null,` after `extractFrame`.
- In the Extract branch (`phase === 'extract' && s.extract === 'done' && s.exportEnabled`), after `status.stages.extract.cells = s.cells;`: `status.stages.extract.source = s.extractSource;`.

- [ ] **Step 4: Run the tests and a browser check**

Run: `npm run test -w apps/cala`. Expected: PASS.

Then `npm run build:e2e` and one batch run on a short real recording the controller names (any of the phase 1 browser recordings), with `--refine-runs 1 --port 4191`, and once more with `--query compress=off --port 4192`. Expected: the first `status.json` has `stages.extract.source` `"factors"` (or `"raw"` with the compress status of Refine's replay not yet settled: then the log shows "Extract replays the file: the factors are being compressed"); the second `"raw"` and no compress status. Both exit 0.

- [ ] **Step 5: Check and commit**

`npm run typecheck`, `npm run lint`, `npx prettier --check apps/cala`.

```bash
git add apps/cala
git commit -m "feat(cala): compression is on by default, ?compress=off replays the file"
```

---

### Task 7: The e2e gate on a file

**Files:**

- Modify: `apps/cala/src/__tests__/synth-avi.ts` (`SynthOptions`, `buildAvi` about line 105)
- Create: `e2e/cala-factors.spec.ts`

**Interfaces:**

- Consumes: the app as of Task 6; `buildAvi`, `rowStride`; `window.__cala` under `?debug` (`pipeline`, `cells`, `refine`, `pass2`, `compress`).
- Produces: `SynthOptions.payload?: (f: number) => Uint8Array`; `cellMovie(width?: number, height?: number, frames?: number, seed?: number): CellMovie`; two e2e tests.

- [ ] **Step 1: The cell movie**

In `apps/cala/src/__tests__/synth-avi.ts`, `SynthOptions` gains:

```ts
  /** The frame payloads, padded rows (default: the `pixelAt` ramp). */
  payload?: (f: number) => Uint8Array;
```

In `buildAvi`'s frame loop, `framePayload(o, f + (o.frameOffset ?? 0))` becomes `o.payload ? o.payload(f) : framePayload(o, f + (o.frameOffset ?? 0))`. At the end of the file:

```ts
/** A deterministic 8-bit calcium movie for the browser tests. */
export interface CellMovie {
  width: number;
  height: number;
  frames: number;
  /** Cell centres `(y, x)`. */
  cells: [number, number][];
  /** Frame `f`'s payload (8-bit, rows padded), for `buildAvi`'s `payload`. Call in frame order. */
  payload(f: number): Uint8Array;
}

/**
 * 16 Gaussian cells (sigma 2.5 px) on a 4 x 4 grid 24 px apart, each with
 * transients about every 5 s at 20 fps (50 to 90 grey levels, decay 8
 * frames), on a background of 30 with Gaussian noise of sd 3. No motion.
 */
export function cellMovie(width = 96, height = 96, frames = 3000, seed = 7): CellMovie {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gauss = (): number =>
    Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const cells: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cells.push([12 + 24 * i, 12 + 24 * j]);
  const traces = cells.map(() => {
    const t = new Float32Array(frames);
    let v = 0;
    for (let f = 0; f < frames; f++) {
      v *= Math.exp(-1 / 8);
      if (rand() < 0.01) v += 50 + 40 * rand();
      t[f] = v;
    }
    return t;
  });
  const r = 8;
  const shape = new Float32Array((2 * r + 1) * (2 * r + 1));
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      shape[(dy + r) * (2 * r + 1) + dx + r] = Math.exp(-(dy * dy + dx * dx) / (2 * 2.5 * 2.5));
  const stride = rowStride(width, 8);
  const image = new Float32Array(width * height);
  return {
    width,
    height,
    frames,
    cells,
    payload(f) {
      for (let p = 0; p < image.length; p++) image[p] = 30 + 3 * gauss();
      cells.forEach(([cy, cx], k) => {
        const a = traces[k][f];
        if (a < 0.5) return;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++)
            image[(cy + dy) * width + cx + dx] += a * shape[(dy + r) * (2 * r + 1) + dx + r];
      });
      const out = new Uint8Array(stride * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          out[y * stride + x] = Math.max(0, Math.min(255, Math.round(image[y * width + x])));
      return out;
    },
  };
}
```

- [ ] **Step 2: The e2e tests**

Create `e2e/cala-factors.spec.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';

/**
 * Phase 4.1's gate on a file: a synthetic recording with cells runs
 * Discover, Refine (a raw replay, which also compresses the frames) and
 * Extract on the factors, and the export says so. With `?compress=off` the
 * same recording takes today's raw path.
 */
interface CalaDebug {
  __cala: {
    pipeline: { status(): string; record(): { frames: number } };
    cells: { library(): { ids: Uint32Array } | null };
    refine: { status(): string };
    pass2: { result(): { source?: string; frames: number; cells: number } | null };
    compress?: { error(): string | null; factors(frames: number): string };
  };
}

const FRAMES = 3000;

function cellFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  return folder;
}

// page.evaluate callbacks are serialized: each reads `window.__cala` itself
// (the types are erased; no `new Function`, which the page's CSP may forbid).

/** The Extract result's plain fields (its trace files do not cross to Node). */
function extractResult(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as CalaDebug).__cala.pass2.result();
    return p && { source: p.source, frames: p.frames, cells: p.cells };
  });
}

async function discover(page: Page, query: string): Promise<number> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/?debug${query}`);
  await page.getByTestId('folder-input').setInputFiles(cellFolder('cala-factors-e2e-'));
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('pass2-run')).toBeEnabled({ timeout: 60_000 });
  const cells = await page.evaluate(
    () => (window as unknown as CalaDebug).__cala.cells.library()?.ids.length ?? 0,
  );
  expect(cells).toBeGreaterThan(0);
  return cells;
}

test('Cala: a file runs Discover, Refine and Extract on the factors by default', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const cells = await discover(page, '');
  await page.getByTestId('refine-run').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 120_000,
    })
    .toBe('done');
  // The Refine replay compressed the frames; Extract reads them once they are ready.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as CalaDebug).__cala;
          return c.compress?.factors(c.pipeline.record().frames) ?? null;
        }),
      { timeout: 120_000 },
    )
    .toBe('ready');
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors (seconds).',
  );
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'factors', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress?.error() ?? null),
  ).toBeNull();

  await page.locator('[data-testid=export-menu] summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-npz').click(),
  ]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.includes('"source":"factors"')).toBe(true);
  expect(bytes.includes('"source":"raw"')).toBe(true); // Discover and Refine read the file
});

test('Cala: with compress=off a file replays the file for Extract, as before', async ({ page }) => {
  test.setTimeout(300_000);
  const cells = await discover(page, '&compress=off');
  await expect(page.getByTestId('extract-source')).toHaveCount(0);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done:', {
    timeout: 120_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'raw', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress === undefined),
  ).toBe(true);
});
```

- [ ] **Step 3: Run the e2e suite**

Run from the repository root: `npm run build:e2e`, then `npm run typecheck:e2e`, then `npm run test:e2e -- cala-factors.spec.ts`. Use a free port with `E2E_PORT` if 4173 is taken.
Expected: both tests pass. Record the wall time of each (Playwright's list reporter prints it) for the CI note; if a test needs more than 3 minutes locally, halve `FRAMES` to 1800 (three windows) and rerun, and say so in the commit. If Discover finds no cell, stop and report the `cells-readout` text: the movie is wrong for the slow loop, not the test.

Then run the whole suite once: `npm run test:e2e`. Expected: every existing Cala test passes with compression on by default.

- [ ] **Step 4: Check and commit**

`npm run lint`, `npx prettier --check e2e apps/cala/src/__tests__/synth-avi.ts`, `npm run test -w apps/cala` (the unit tests use `synth-avi.ts` too).

```bash
git add e2e/cala-factors.spec.ts apps/cala/src/__tests__/synth-avi.ts
git commit -m "test(cala): e2e run of Discover, Refine and Extract on the factors of a file"
```

---

### Task 8: Docs

**Files:**

- Modify: `apps/cala/README.md` (the section "Compression (experimental, `?compress`)", about line 332; "Run stages and export", about line 107), `apps/cala/docs/stages.md` (the Extract row and the rules), `docs/CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**

- Consumes: Tasks 1 to 7.
- Produces: docs only.

- [ ] **Step 1: README**

Rename the section to "Compression (on by default; `?compress=off`)". Its first paragraph says: every run compresses the preprocessed, motion-corrected frames; the first replay after Discover (the first Refine run, else Extract) compresses again on the two offset grids with the final calibration and keeps those factors; Extract then reads the factors (`FactorExtractor` in the compress worker, signed traces too) once they are ready, in seconds, and replays the file otherwise; the Run panel's line under Extract says which; the export's stage records say `source` (format 7). `?compress=off` replays the file for Refine and Extract as before. Add a paragraph "Known differences": a pixel that is never valid in a window is read as 0 by the factor engine and as missing by a replay (the three real test recordings have 30 to 105 such fixed pixels); the factors drop most of the white noise, so traces of low-SNR cells differ more (phase 2 report). Add to "Run stages and export": the stage records' `source`, `tiling`, `mean_rank` (format 7). Keep the section's style: plain sentences, numbers with their source.

- [ ] **Step 2: stages.md and CHANGELOG**

`apps/cala/docs/stages.md`: the Extract row gains "reads the factors when the first replay has made them (compression on), else replays the file"; the rules gain "With compression on, the first replay after Discover (Refine or Extract) also compresses the frames for later Extracts."

`docs/CHANGELOG.md`, under `## [Unreleased]`: one entry: cala compresses by default (`?compress=off` for the old path); Extract reads the factors after the first replay; export format 7 records each stage's source; `FactorExtractor.setSigned` / `lastSigned`.

- [ ] **Step 3: Check and commit**

`npx prettier --write apps/cala/README.md apps/cala/docs/stages.md docs/CHANGELOG.md`, then `npx prettier --check` on them.

```bash
git add apps/cala/README.md apps/cala/docs/stages.md docs/CHANGELOG.md
git commit -m "docs(cala): compression by default and Extract on the factors"
```

---

## Phase 4.2: Refine on factors and live streams (task list)

Written in full after 4.1 is merged and the owner has answered the decisions above. Each task keeps the Global Constraints of 4.1.

1. **WASM binding of one factor iteration.** `crates/cala/src/discover/js.rs`: a duck-typed import and a method on `JsSlowLoop`:

   ```rust
   #[wasm_bindgen]
   extern "C" {
       /// The factor windows of a recording, in frame order (`opfsReader` in the slow worker).
       pub type WindowReader;
       #[wasm_bindgen(method, getter)]
       fn windows(this: &WindowReader) -> u32;
       #[wasm_bindgen(method, catch)]
       fn read(this: &WindowReader, w: u32) -> Result<Vec<u8>, JsValue>;
   }

   #[wasm_bindgen(js_class = SlowLoop)]
   impl JsSlowLoop {
       /// One Refine iteration on the factors (`SlowLoop::refine_on_factors`).
       /// Returns `[library_version, cells, frames, fitting_frames, accepted,
       /// changed_share, median_change, low_valid, tiles_skipped]`.
       #[wasm_bindgen(js_name = refineOnFactors)]
       pub fn refine_on_factors(&mut self, reader: &WindowReader, settle_corr: f32,
           settle_share: f32, test_frames: u32) -> Result<Vec<f64>, JsError>;
   }
   ```

   A private `ReaderSource<'a>` implements `FactorSource` (`window(w)` parses `WindowFactors::from_bytes`, an unreadable or corrupt window is a `TraceError`, never a panic). First step: confirm that this crate's `wasm-bindgen` returns `Vec<u8>` from an imported method (search the crate for `extern "C"`; if none exists, build a one-method probe and run it in vitest). The JS side calls `setEditScope('refine')` and `finalize()` before the first iteration and `finalize()` after each, as `qc_eval`'s per-iteration loop does (equal to `refine_until_settled`, phase 3 review). Tests: vitest with real WASM, a `SlowLoop` with an empty published library settles at once (cells 0); a window of another frame size throws an `Error` naming `refineOnFactors`.

2. **The slow worker reads the factor files.** `apps/cala/src/lib/window-store.ts`: `opfsReader(run: string): Promise<{ windows: number; read(w: number): Uint8Array; close(): void }>` opens `cala-compress/<run>`'s `f0.bin ... f(n-1).bin` with `pinned` synchronous access handles, never sweeps or creates. The run's folder name is chosen on the main thread and sent in the compress worker's `connect` (`MainToCompress.connect.run`; `opfsStore(run)` there). Test with a fake OPFS root (as `window-store.test.ts` does).

3. **The slow runner's factor Refine.** `apps/cala/src/workers/slow-types.ts`: `MainToSlow` gains `{ type: 'refine-factors'; session; run: string; windows: number; settleCorr: number; settleShare: number; maxIterations: number; testFrames: number }` and `{ type: 'refine-factors-stop'; session }`; `SlowToMain` gains `{ type: 'iteration'; session; iteration: number; report: IterationView }` and `{ type: 'refined'; session; iterations: number; stop: 'settled' | 'nothing-accepted' | 'cap' | 'stopped' }`. `SlowRunner.refineOnFactors(msg, reader)`: one iteration per macrotask, a status and the library published after each, the stop message honoured between iterations. Tests with a fake `SlowLoopLike` that settles at iteration 3, and one that never settles (cap).

4. **The Refine store's factor route and the Run panel.** `?refine=factors` (`refineOnFactorsOn(params)`): the Refine button reads "Refine until settled"; when the factors are `none`, a compression-only replay runs first (Extract's replay settings with the compress settings, traces discarded), shown as "preparing the factors: frame N / M"; then the iterations, each in the readout (iteration, refinements accepted, share of cells still changing, median change) and in the stage log (`source: 'factors'`, `iterations`, `stop`). The slow worker gets the files only when the factors are `ready` and no back-fill or Extract job runs (`CompressStore.idle()`). Cancel stops after the current iteration; the stage log says so.

5. **Live streams.** `pipeline-store.ts` `start`: a live stream without `?review` compresses on the offset grids (`compressTiling: 'offset'` in its `CellsSettings`). `factorState` gains `live: boolean` and accepts Discover's windows of a live run. `stageAvailability` (`run-stages.ts`): with compression on, a live run's Extract is available once the stream has ended and the factors are `ready`; Refine only with `?refine=factors`; `LIVE_NOTE` becomes two texts (compression off: as today; on: "A live stream has no file: Extract and Refine read the factors Discover wrote; they are not claimed to meet the closeness gate."). The Extract record of a live run gets `factors: 'discover'` (export `factors`), a file's `'replay'`. `live-export.ts`: when an Extract result exists, the live export takes it (`traces_signed` too). The back-fill is not requested for a live run with compression on (Extract replaces it).

6. **The e2e gate on a simulated stream.** `e2e/cala-live.spec.ts`: the two existing stream tests run with `&compress=off` (they pin today's live behaviour); a new test streams `cellMovie` through `live-sim.mjs` at 200 fps with `?live=...&debug&refine=factors`, then Refine until settled and Extract, both `source: 'factors'`, the export containing `"factors":"discover"`. `e2e/cala-factors.spec.ts` gains the file run with `&refine=factors`. Together with 4.1's test this is the phase's gate.

7. **Docs.** README (live section: what a live run now has; Refine on factors behind the switch), `docs/stages.md`, CHANGELOG.

## Phase 4.3: storage and the rest of A11 (task list)

1. **Storage.** Before a replay that compresses: `navigator.storage.estimate()` against the estimate `frames × pixels × 2 × 1.1` (waiting windows) plus the factors (`2 × 9.2 MB` per 1000 frames per 40 000 pixels, scaled); refuse compression with a stage log line when it does not fit (the replay then runs without it). Backpressure: the replay asks for its next batch only while at most `MAX_WAITING_WINDOWS` (4) windows wait in the compress worker (a `pending` count in the compress status), which bounds the disk at about 1.7 GB at 600 px and makes a compressing replay as slow as the compressor (phase 5 measures what that costs). A write error names the quota in the Run panel, not only in the status bar.
2. **Factors in the results folder.** A multi-session run with write access copies `f<window>.bin` to `<run>/factors/` after Extract (spec §3), so a live session keeps its factors; `cala-run.json` lists them.
3. **The history review on the offset grids.** `crates/cala/src/compress/review.rs`: blend the components of the tiles that cover a pixel with the tiling's weights instead of stacking them; `ensure_plain` goes; Discover of a file then compresses on the offset grids too, and `?review` no longer keeps a live run on plain tiles. Gate: the review's candidates on `plain` and `offset` factors of the same recording, compared.
4. **Live flat field seed behind `?ffseed`.** A live stream reads and writes the per-device cache under its live key (`live-device:` / `live:`, `flat-field.ts`) only with the switch; the stage log and the export say "seeded from a stored map of <key>".
5. **Multi-session runs.** When Refine on factors becomes the default: the setting "number of Refine runs" becomes on or off (§6).
6. **The cluster replay flag**, after phase 3b's gate: `?joint=all` sets `joint_update` and `joint_sign` on the app's `SlowLoopConfig`, if phase 3b passes on factors.

## Not in this phase

- **Refine on factors as the default.** Phase 3a fails gate A1's footprint rule on both real wireless recordings (0.0345 and 0.0389 against 0.02) and does not settle on `wl24_01` within 20 iterations.
- **Claiming gate A1 for a live run's factors.** Phase 4a: Discover's own factors fail A1 on both real WL24 recordings and on `motion`.
- **The cluster history replay in the app.** Phase 3b (the replay on factors) is not built; `refine_on_factors` refuses a joint update; the app never exposes the joint flags; and with the replay on, the factors failed the footprint rule on `wl24_01` (0.0305).
- **The look-back.** Main's look-back exists in the harness only; the app has no worker that re-reads past frames during Discover. A9's random access to the factor store arrives with it.
- **Compression shared across workers for live streams.** Phase 1 measured 24.25 ms per frame at 600 px on the offset grids in Chrome, half the 50 ms interval at 20 fps, on file recordings; phase 5 measures a live source first.
- **Opening a saved factor folder as a recording** (spec: not in scope).
- **A cancel inside one factor iteration** (decision 7).

## Self-review notes

- Spec coverage: §3 compression on by default and `?compress=off` (Task 6); A4 file recordings, one compression replay (decision 2: the first replay; the standalone replay in 4.2 task 4); §4 "Extract on factors replaces the back-fill's frame rebuild" (phase 2) and the stage on factors (Tasks 2 to 4); §6 Extract on factors "after Refine without asking (it takes seconds)": Extract stays a click, as the multi-session runs drive it (`nextAutoAction`), because its default is off today (`EXTRACT_AFTER_DISCOVER_DEFAULT`); not changed here, said for the owner; §6 export `source`, tiling, mean rank (Task 5); §6 "Refine until settled" and "Streaming: Refine and Extract are offered once the stream has ended" (4.2 tasks 4 and 5); A7 the review on the offset grids (4.3 task 3); A7 flat field seed for live (4.3 task 4); A11 gate (Task 7 and 4.2 task 6).
- Names used across tasks: `FactorExtractor.{setSigned, lastSigned}`; `CompressRunner.extract`, `runExtract`, `maybeExtract`; `MainToCompress` `extract`; `CompressToMain` `extracted`, `extract-done`, `error.job`; `CompressClient.extract`; `FactorState`, `factorState`, `ExtractMessage`, `extractSourceText`, `compressionOn`; `CompressStore.{factors, markReplay, replayEnded, keepProjection, projection, onExtract}`; `FactorWindowTraces`, `ReplayCompressLike`, `Pass2Factors`, `createPass2Factors`; `Pass2Result.{source, tiling, meanRank}`; `Pass2Store.{run(use, from), source}`; `RefineQcOptions.compress`; `StageRun.{source, tiling, meanRank}`; `stageMeta`, `stagesFromMeta`, `EXPORT_FORMAT_VERSION` 7; `cellMovie`, `SynthOptions.payload`; testids `extract-source`.

## Execution notes, phase 4.1 (19 Nov 2026)

- 4.1 was executed on the branch `feat/cala-factor-app`, cut from `feat/cala-factor-extract` after the merge of main. The plan's "Branch" line is superseded.
- The plan predates main's look-back in the app, so its statements that the look-back exists in the harness only are stale. The app's look-back was left as main has it; a scan found no conflict with compression by default.
- `factorState` is `compressing` only while the replay mark is held or windows are waiting or compressed, because a cancelled replay would otherwise have blocked every later compression. Only the replay that took the mark can release it.
- A pending factor Extract always settles: a compression error, a reset or a new Discover aborts it. The `StageRun` fields were added in Task 4, not Task 5.
- A factor Extract writes its windows to the run's trace files as they arrive and deletes them when the job fails.
- After a failed factor Extract the next Extract replays the file. The brief left the state `ready` with no fallback, which made a deterministic failure a dead end.
- Task 5b was added for the spec's Amendment 3, A14 (`min_valid`).
- Departure from the spec, left for the owner: §6 says Extract on factors runs after Refine without asking; in 4.1 Extract stays a click.
- Added to phase 4.3's list: an acknowledgement per window in the extract protocol; stopping the feed after a compression error; a cap on what a live stream compresses.
- The e2e tests of Task 7 were run locally with a cached browser build through a temporary configuration, because the repository's Playwright browser build was not installed on the machine. CI runs the repository's own.
