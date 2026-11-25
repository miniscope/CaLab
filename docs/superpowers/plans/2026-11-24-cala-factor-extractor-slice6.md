# cala factors, slice 6: Extract solves on the factors directly (`FactorExtractor`, ported from #437)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract on factors stops rebuilding frames. For each window it builds the solver's functionals straight
from the factors (`WindowProjector`) and solves every frame from them (`FactorExtractor`), as #437 built and measured.
Today Extract rebuilds each frame (`rebuildFrames`) and solves its pixels. On the 1 h V4 stream that took 37 min at 32
frames/s, the longest stage, against 76 frames/s for a file's replay
(`tools/cala-eval/results/2026-11-24-factors-v4-1h-speed.md` on `perf/cala-factors-v4-speed`). Phase 2 measured the
extractor 22-137x faster than the rebuilt-frame Extract in the native harness.

**Architecture:**

- Crate: port `crates/cala/src/compress/project.rs` (`WindowProjector`, `FactorExtractor`, `min_valid`) and the
  solver's `TraceEngine::process_projected` from `origin/feat/cala-factor-extract`, with their tests.
- Binding: the `FactorExtractor` class of 062e94e9 (`new(library, tol, maxSweeps)`, `ids`, `open(bytes)`, `start`,
  `solve(t0, count)`), plus what the app's Extract needs today: signed traces, and the never-valid check of
  decision 1.
- App: the compress worker's Extract job (`CompressRunner.runExtract`) opens each window in one extractor per job and
  solves it in batches of 16, as now. The messages to the main thread, `pass2-store`, `factor-extract.ts` and the
  trace files do not change.
- The Final settle keeps reading rebuilt frames: it feeds pixels to the slow loop's `observe`, which has no projected
  form.

**Tech Stack:** Rust (`crates/cala`, WASM bindings), TypeScript (`apps/cala`, vitest), Playwright (e2e and the speed
check).

**Sources (read through git):**

- `origin/feat/cala-factor-extract`: 907b948c, 29aa49ea, 7e88143e, d1e5e0e3, 37e88392, abc474df, 3730a975
  (`project.rs` and its tests), the `trace/solver.rs` and `trace/tests.rs` changes (`process_projected`), 062e94e9
  (the binding and the back-fill on factors).
- `origin/feat/cala-factor-app`: dc4e9863 (`extract_min_valid` and `low_valid` in the export and the Run panel).
- Phase 2 report: `tools/cala-eval/results/2026-11-19-factor-phase2.md` on `origin/feat/cala-factor-extract`.

**Base:** `feat/cala-parallel-compress` (slice 5, PR #501 into `feat/cala-factors-settle`). Rebase onto
`feat/cala-factors-settle` once #501 is merged.

## What the two engines read differently (from the sources)

- The compressor stores a missing sample as the pixel's mean over the window. It stores 0 as the mean of a pixel
  that was never valid in the window. `TileFactors::valid` says how often a pixel had data.
- Today's Extract on rebuilt frames (`rebuildFrames`, slice 2) puts NaN only where a pixel was never valid in the
  window. The frame engine fills a NaN pixel by expectation-maximisation, so the pixel pulls no trace.
- A pixel missing in only part of a window is read the same way by both routes: both see the factor value.
- The factor engine has no fill. It reads the stored 0 at a never-valid pixel (`project.rs`, module comment and
  `min_valid`).
- So in the app, the two routes differ only in windows where a never-valid pixel lies under a functional: a cell's
  support or moat, or a ring or basis map. Elsewhere they agree to about 1e-4 absolute (phase 2's unit test: 8.2e-5,
  f32 rounding of the two input routes).
- Phase 2's 1.5 % of a trace's sd on WL24 was measured against a replay that put NaN back in every frame where a pixel
  had been missing. The app's rebuilt frames do not do that, so that gap is not today's gap (inferred; Task 10 measures
  the app's own).

## Decided for the owner's review

Each says what would change it.

1. **Never-valid pixels: such a window is solved on rebuilt frames, as today; every other window on the factors.**
   - At `open` the binding says whether the window has a never-valid pixel under any functional (`neverValidUnder()`).
     That window takes today's route: rebuild, then the frame engine's fill. Every other window goes to the
     projector.
   - Both routes use **the same `TraceEngine`** inside the extractor (`engine_mut().process_into` for a rebuilt
     frame). Every window starts that engine cold (`coldStart()`), whichever route and whichever worker solves it
     (decision 2), so the traces do not depend on the pool's width.
   - So the traces equal today's within about 1e-4, apart from the first frames of each window, where today's solve
     starts from the previous window's last frame. There the difference is about the solver's tolerance (0.05 of a
     trace's noise sd; inferred, Task 4 bounds it on a sim). No trace takes the stored 0.
   - The cost: windows with never-valid pixels gain nothing. With motion correction these are windows where the
     shift keeps an edge band out of the FOV for the whole window (inferred). Task 10 counts them on the V4 stream and
     on `wl24_20251201`.
   - The export names the split (decision 3), so no per-cell flag is needed.
   - Alternatives:
     - **(b) Factor engine everywhere, as #437:** the stored 0 is read, and cells are flagged with
       `extract_min_valid` as #440 did. It is faster on windows with edges. But a cell under a never-valid pixel gets
       a different trace from today's; phase 2's largest single difference was 0.45 sd, in such a cell.
     - **(c) Give never-valid pixels zero weight inside the projector:** drop them from each functional and from the
       solver's Gram terms, per window. That would match the frame engine's fill at its fixed point. It is new crate
       work, not a port.
   - What would change it: Task 10 finds most windows of the V4 stream fall back. Then (c) is the next step, or (b) if
     the owner accepts flagged cells.
2. **The pool is in this slice (owner, 24 Nov: "Add the pool too").**
   - The windows of an Extract job go to free slots of slice 5's pool: the compress worker and its helpers. The
     compress worker reads each factor file (about 33 MB per window at 600 px) and transfers its bytes; a helper
     touches no file.
   - Each slot keeps one `FactorExtractor` per job (one library decode per job and helper) and starts it cold for
     every window.
   - `extracted` reaches the main thread in window order (a reorder buffer of at most `width - 1` windows of traces).
     `pass2-store` appends in order, so nothing there changes.
   - The extract width: `max(1, min(6, cores - 2))`. Extract runs alone after the settle, and compression is done by
     then (Extract on factors starts at `ready`). On 10 cores that is 6: the compress worker and 5 helpers, so 5 helpers
     are created instead of 2. `?debug&cpool=D,E,X` sets it.
   - Releases per window: an answer, an error (the job fails as today), a helper crash, a failed start or a 5-min
     timeout (the window is read again and solved elsewhere), cancel and reset (late answers dropped).
   - What would change it: Task 10 shows the extractor reaching the file's 76 frames/s on one worker. Then the default
     width could stay at `after` (fewer helpers).
3. **The export and the Run panel.**
   - Extract's stage record of a factor run gains `extract_engine: 'factors'`, `factor_windows_projected` and
     `factor_windows_rebuilt`. Format 7 only; format 6 exports stay byte for byte.
   - The Run panel's Extract line: "Extract done (on the factors: 118 windows projected, 2 rebuilt)".
   - Not ported: #440's `extract_min_valid` and `low_valid`. Under decision 1 no trace reads a stored 0. They come back
     with alternative (b).
4. **The back-fill of a plain `?compress` run stays on rebuilt frames** (062e94e9 moved it to the factors). It is a
   measurement path, and its traces replace the live history; the owner has not asked for it.
5. **Speed check, as slice 2's** (`tools/cala-eval/results/2026-11-23-factors-live-speed.md`):
   - `motion_s5` streamed at 20 fps for 3 min, 3 runs with today's Extract and 3 with the extractor, interleaved.
     Extract's frames per second, against today's 32 frames/s (1 h V4) and the file's 76.
   - `wl24_20251201` with `?factors=file&debug&cpool=4,4` (Extract read the factors there in slice 5: 49 s against
     31 s for the file).
   - Per run: windows projected and rebuilt, and the traces' largest and median difference from the rebuilt-frame
     Extract of the same run (in sd).
   - The 1 h V4 stream again (about 75 min of machine time) only if the owner asks after the short runs.

## Global Constraints

- **Testing scope (owner: less testing).** The ported crate tests come with the port. App unit tests only for what
  can change an export or hang: the per-window route choice, the traces against the rebuilt-frame route, the export
  fields. The existing e2e, and the speed check.
- **Without a factor Extract nothing changes:** the settle, the file's Extract and the back-fill are as before.
- Every state releases as today. The extractor replaces only the per-window solve inside `runExtract`; the job's
  cancel, error, reset and crash paths are unchanged (slice 2's table).
- No Rust panic reachable from JS: the binding returns errors.
- Rust checks, from `crates/cala`: `cargo fmt --all --check`; `cargo clippy --all-targets --no-default-features
--features jsbindings -- -D warnings`, the same with `--features pybindings` and `--features diagnostics`; `cargo
test --no-default-features --features jsbindings`.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest), `npx prettier --check` on every touched file outside `crates`.
- e2e: `npm run build:e2e`, then `npx playwright test e2e/cala-factors.spec.ts e2e/cala-live.spec.ts e2e/cala.spec.ts`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer, no tool or assistant attribution. A
  cherry-picked commit gets a new message in this form. Never amend. Do not push without the owner's yes.
- No machine paths, user names or emails in committed files.
- Long shell commands go in a script under the git-ignored `.scratch/`. Never bare `git stash`.
- Branch: `feat/cala-factor-extractor`.

## Review Focus

1. **The traces equal today's.** A window without never-valid pixels under a functional: within phase 2's 2e-4 ×
   (1 + |trace|). A window with them: the same route as today, so the same traces. Pinned: Task 4.
2. **The traces do not depend on the width.** Each window starts cold; answers are emitted in window order. Pinned:
   Task 6's width 1 against width 3 test, bit for bit.
3. **Every window handed to a helper settles** (answer, error, crash, failed start, timeout, cancel, reset). Pinned:
   Task 5.
4. **The ported crate code matches the source.** Only conflict resolutions differ (main's `never_valid` beside the
   projector in `compress/mod.rs`; the solver changes against main's `trace/solver.rs`). The ported tests pass
   unchanged.
5. **Format 6 exports are unchanged.**

## File Structure

| File                                                                                                | Change | Responsibility                                                                         |
| --------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `crates/cala/src/compress/project.rs`                                                               | create | `WindowProjector`, `FactorExtractor`, `min_valid` (port), `never_valid_under`          |
| `crates/cala/src/compress/mod.rs`                                                                   | modify | `pub mod project`; keeps main's `never_valid`                                          |
| `crates/cala/src/trace/solver.rs`, `trace/tests.rs`                                                 | modify | `process_projected` (port)                                                             |
| `crates/cala/src/compress/js.rs`                                                                    | modify | `FactorExtractor` binding: `setSigned`, `lastSigned`, `neverValidUnder`, `solveFrames` |
| `apps/cala/src/lib/cala-wasm.ts`                                                                    | modify | export `FactorExtractor`                                                               |
| `apps/cala/src/lib/compress-pool.ts`, `lib/factor-solve.ts`, `workers/compress-helper-worker.ts`    | modify | `WindowPool`, the extract width; one window on an extractor; helpers solve windows     |
| `apps/cala/src/lib/compress-runner.ts`, `workers/compress-worker.ts`                                | modify | Extract through the extractor, the per-window route                                    |
| `apps/cala/src/lib/run-stages.ts`, `lib/export.ts`, `lib/pass2-store.ts`, `components/RunPanel.tsx` | modify | the engine and window counts                                                           |
| `apps/cala/src/__tests__/compress.test.ts`, `export.test.ts`                                        | modify | tests per task                                                                         |
| `apps/cala/scripts/live-measure.mjs`                                                                | modify | Extract's engine, windows and frames per second                                        |
| `tools/cala-eval/results/2026-11-2x-factor-extractor-speed.md`                                      | create | the speed check                                                                        |
| `apps/cala/README.md`, `apps/cala/docs/stages.md`, `docs/CHANGELOG.md`                              | modify | docs                                                                                   |

---

### Task 1: Port `process_projected` to the solver

**Files:** `crates/cala/src/trace/solver.rs`, `crates/cala/src/trace/tests.rs`.

- [ ] **Step 1:** Take the solver and test hunks of the source branch (its diff to the merge base, under
      `crates/cala/src/trace`) onto this branch. Resolve against main's solver without changing main's behaviour.
- [ ] **Step 2:** Rust checks; the ported tests pass, and every existing test passes unchanged.
- [ ] **Step 3: Commit** `feat(cala): the trace engine solves a frame from its projections (ported from #437)`

### Task 2: Port `WindowProjector` and `FactorExtractor`

**Files:** create `crates/cala/src/compress/project.rs`; modify `crates/cala/src/compress/mod.rs`.

- [ ] **Step 1:** Take `project.rs` at the source tip (the seven commits listed) and `pub mod project`. Keep main's
      `WindowFactors::never_valid`.
- [ ] **Step 2:** Rust checks; the ported tests, `traces_from_the_factors_equal_traces_from_the_rebuilt_frames`
      among them, pass unchanged.
- [ ] **Step 3: Commit** `feat(cala): WindowProjector and FactorExtractor solve a window's traces from its factors (ported from #437)`

### Task 3: The never-valid check and the binding

**Files:** `crates/cala/src/compress/project.rs`, `crates/cala/src/compress/js.rs`, `apps/cala/src/lib/cala-wasm.ts`.

**Interfaces:**

- `WindowProjector::never_valid_under(&self) -> bool`: some pixel with no valid sample in the window lies in a
  functional's terms (a cell's support or moat block, a ring, a basis map).
- JS `FactorExtractor`: `new(library, tol, maxSweeps)`, `ids()`, `open(bytes) -> frames`, `start`,
  `neverValidUnder()`, `coldStart()`, `solve(t0, count)`, `solveFrames(frames, count)` (the extractor's own engine
  on frames, with its fill), `setSigned(on)`, `lastSigned()`.

- [ ] **Step 1: Failing Rust tests:** `never_valid_under` is false on a window without missing pixels, true with a
      never-valid pixel in a cell's support and in a moat block, false with one outside every functional; `coldStart` makes the next frame's solve equal a new extractor's, and the engine's frame counter
      and traces continue between `solve` and `solveFrames`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3: Implement** (the binding from 062e94e9 plus the four additions).
- [ ] **Step 4:** Rust checks.
- [ ] **Step 5: Commit** `feat(cala): the factor extractor's binding says when a window has pixels without data under a cell`

### Task 4: Extract on the extractor, per window

**Files:** `apps/cala/src/lib/compress-runner.ts`, `apps/cala/src/workers/compress-worker.ts`,
`apps/cala/src/__tests__/compress.test.ts`.

**Interfaces:**

- `CompressRunnerDeps.extractor?(library: Uint8Array, signed: boolean): FactorExtractorLike` (absent: today's
  engine route).
- `FactorExtractorLike { ids(); open(bytes): number; neverValidUnder(): boolean; solve(t0, n): Float32Array; solveFrames(frames, n): Float32Array; lastSigned?(): Float32Array; free() }`.
- The `extract-done` message gains `projected` and `rebuilt` (window counts).

- [ ] **Step 1: Failing tests** (WASM, the cell movie of the back-fill tests):
  - a recording without missing pixels: every window projected; traces within 2e-4 × (1 + |a|) of the rebuilt-frame
    Extract;
  - the middle of three windows with a never-valid pixel under a cell: that window rebuilt, the other two
    projected; away from each window's first frames, the traces within that bound of today's route; in the first
    frames (cold start), within the solver's tolerance times each trace's noise.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** App checks.
- [ ] **Step 5: Commit** `feat(cala): Extract on factors solves each window from its factors, and rebuilds only windows with pixels without data under a cell`

### Task 5: `WindowPool`, ordered windows over the helpers

**Files:** `apps/cala/src/lib/compress-pool.ts`, `apps/cala/src/workers/compress-types.ts`,
`apps/cala/src/__tests__/compress-pool.test.ts`.

**Interfaces:**

- To a helper: `{ type: 'extract-begin'; job; library: Uint8Array; signed: boolean }`,
  `{ type: 'extract-window'; job; index; bytes: Uint8Array }` (transferred), `{ type: 'extract-end'; job }`.
- From a helper: `{ type: 'window-done'; job; index; projected: boolean; traces; signed? }`,
  `{ type: 'window-error'; job; index; message }`.
- `class WindowPool`, sharing the helpers and their liveness with `TilePool` (a helper lost to one is lost to both):
  `setWidth(n)`, `run(job, indices, io): Promise<boolean>` (false on cancel or reset), `cancel(job)`, `reset()`,
  `onHelper(k, msg)`, `lost(k)`. `io`: `read(index): Promise<Uint8Array>`, `local(index, bytes): WindowResult`,
  `emit(index, result)`, `yieldNow()`.
- `const WINDOW_TIMEOUT_MS = 300_000`

- [ ] **Step 1: Failing tests** (fake helpers): width 1 solves every window locally, emitted in order; width 3 with
      answers in reverse emits in window order, once each; a crash, a failed start and a timeout redo the window
      elsewhere; a window error rejects and drops later answers; cancel and reset return false and emit nothing more.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** App checks.
- [ ] **Step 5: Commit** `feat(cala): a window pool that hands Extract's windows to the compress helpers and emits them in order`

### Task 6: The helpers solve windows; Extract runs over the pool

**Files:** `apps/cala/src/workers/compress-helper-worker.ts`, `apps/cala/src/lib/compress-runner.ts`,
`apps/cala/src/workers/compress-worker.ts`, `apps/cala/src/lib/factor-solve.ts` (create: one window on an
extractor, shared by the compress worker and the helpers), `apps/cala/src/__tests__/compress.test.ts`.

- [ ] **Step 1: Failing test:** Extract with width 1 and with width 3 (fake helpers running `solveWindow` in process,
      answering in reverse) gives bit-identical `extracted` traces and signed traces, in window order.
- [ ] **Step 2:** Run; expect failure.
- [ ] **Step 3: Implement.** The helper builds one extractor at `extract-begin`, starts it cold per window, frees it
      at `extract-end`.
- [ ] **Step 4:** App checks.
- [ ] **Step 5: Commit** `feat(cala): Extract on factors runs its windows over the compress pool`

### Task 7: The extract width

**Files:** `apps/cala/src/lib/compress-pool.ts` (`compressPoolSize` gains `extract`; `parsePoolOverride` reads `D,E` or
`D,E,X`), `apps/cala/src/App.tsx`, `apps/cala/src/lib/pipeline-store.ts`, `apps/cala/src/workers/compress-types.ts`,
`apps/cala/src/__tests__/compress-pool.test.ts`.

- [ ] **Step 1: Failing test:** `compressPoolSize(10, 4, 0)` is `{ discover: 1, after: 3, extract: 6 }`;
      `parsePoolOverride('1,3,6')`; `'1,3'` keeps `extract` at `after`.
- [ ] **Steps 2-4:** run, implement (helpers created: the largest width minus one), checks.
- [ ] **Step 5: Commit** `feat(cala): Extract on factors uses all but two cores, at most six`

### Task 8: The export and the Run panel

**Files:** `lib/run-stages.ts`, `lib/export.ts`, `lib/pass2-store.ts`, `components/RunPanel.tsx`,
`__tests__/export.test.ts`.

- [ ] **Step 1: Failing test:** a factor Extract record with the counts writes `extract_engine`,
      `factor_windows_projected`, `factor_windows_rebuilt`; the format 6 test is unchanged.
- [ ] **Steps 2-4:** run, implement, checks.
- [ ] **Step 5: Commit** `feat(cala): the export and the Run panel say how many windows Extract projected and rebuilt`

### Task 9: e2e

- [ ] The existing factor e2e tests (stream and `?factors=file`) pass unchanged. Add one assertion to the stream
      test: the export's Extract record has `extract_engine` `factors` and more than 0 windows projected.
- [ ] `npm run build:e2e`, the three spec files.
- [ ] **Commit** `test(cala): e2e checks that a stream's Extract projects its windows`

### Task 10: Speed check

**Files:** `apps/cala/scripts/live-measure.mjs`, create
`tools/cala-eval/results/2026-11-2x-factor-extractor-speed.md`.

- [ ] Decision 5's runs. A `?debug&fextract=0` switch selects today's route for the comparison runs (debug only, in
      the known-flag list).
- [ ] Report Extract's frames per second, the windows projected and rebuilt, and the trace differences. One line on
      whether the pool (decision 2) is worth a next slice.
- [ ] **Commit** `docs(cala-eval): Extract on the factor extractor against rebuilt frames, 600 and 200 px`

### Task 11: Docs

- [ ] README (Extract on factors), `stages.md`, CHANGELOG.
- [ ] **Commit** `docs(cala): Extract on factors solves from the factors without rebuilding frames`
