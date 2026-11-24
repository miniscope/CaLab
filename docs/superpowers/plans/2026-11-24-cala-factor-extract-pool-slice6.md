# cala factors, slice 6: Extract on factors spread over the compress pool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract on factors solves its windows on several workers at once instead of one. Today it runs in the
compress worker alone. On the 1 h V4 stream it took 37 min at 32 frames/s, the longest stage, against 76 frames/s for a
file's replay (`tools/cala-eval/results/2026-11-24-factors-v4-1h-speed.md` on `perf/cala-factors-v4-speed`). With the
windows spread over the compress worker and its helpers, a stream's Extract should take a fraction of that. The traces
must be the same for any number of workers.

**Architecture:**

- The compress worker (the coordinator) keeps owning OPFS. For each compressed window it reads the factor file
  (`readAll`, about 33 MB per 600-frame window at 600 px) and hands it to a free slot: itself or a helper.
- A slot rebuilds the window's frames 16 at a time (`rebuildFrames`) and solves them with the job's library, as
  `runExtract` does today. It returns the window's traces and signed traces.
- The coordinator posts `extracted` to the main thread **in window order** (a reorder buffer), so `pass2-store`,
  `factor-extract.ts` and the export do not change. The buffer holds at most `width - 1` windows of traces (about
  6 MB each at 1,282 cells).
- Each window is solved by a fresh engine (a cold start), whichever slot solves it, so the traces do not depend on the
  width or on which slot solved a window (decision 1).
- The pool's helpers are slice 5's helpers. They load `TraceEngine`, `TraceLibrary` and `FactorWindow` from the same
  WASM module; they still touch no file.

**Tech Stack:** TypeScript with SolidJS and vitest (`apps/cala`), Web Workers; Playwright (e2e and the measurement).
No Rust change.

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`, decision 4 (Extract on rebuilt
frames). Slice 5's plan (`2026-11-23-cala-parallel-compress-slice5.md`, decision 8: Extract stayed in one worker) and
measurement (`tools/cala-eval/results/2026-11-24-parallel-compress.md`).

**Base:** `feat/cala-parallel-compress` (slice 5), which is not yet merged into `feat/cala-factors-settle`. Rebase onto
`feat/cala-factors-settle` once slice 5 is merged there. The PR goes to that branch.

## Decided for the owner's review

Each says what would change it.

1. **Each window starts the solver cold, in every width.**
   - Today one engine solves the windows in order, and its warm start carries from each window's last frame into the
     next window's first (`TraceEngine` keeps per-cell state between frames). Spread over workers, a window's
     predecessor is solved elsewhere, so the carry cannot be kept.
   - So every window gets a fresh engine, also with one worker. The traces are then the same for any width and any
     order of answers. That is the main test.
   - Against today's chained solve, only the first frames of each window can differ, by about the solver's
     convergence tolerance (0.05 of each trace's noise sigma, `SolverConfig::tol`; inferred, not measured). A test
     bounds the difference on a sim movie.
   - Building an engine costs one library decode per window (milliseconds; measured in Task 7).
   - What would change it: the owner wants today's traces bit for bit with one worker. Then width 1 keeps the chained
     engine and only widths above 1 start cold. The traces then depend on the width (within the tolerance).
2. **How many workers for Extract: more than for compression.**
   - Extract on factors runs after the Final settle, when nothing else works: the slow worker, the visit workers and
     the stage workers are idle, and compression is done (Extract on factors starts only when the factors are
     `ready`).
   - Proposed: `extract = max(1, min(6, cores - 2))`: all cores but the main thread and one spare, at most 6. On 10
     cores that is 6 (the coordinator and 5 helpers). On 8 cores 6, on 4 cores 2.
   - Helpers created: `max(discover, after, extract) - 1`, so 5 instead of 2 on 10 cores. Idle helpers cost their WASM
     memory, about 20-40 MB each, inferred.
   - `?debug&cpool=D,E,X` sets the third width (measurement).
   - What would change it: the owner wants to keep 2 helpers. Then `extract` equals `after` (3 on 10 cores), at about
     half the gain.
3. **Where it applies:** every Extract on factors: a stream's (the default) and a `?factors=file` recording's. The
   back-fill of a plain `?compress` run stays in one worker (it is a measurement path).
4. **The export and the Run panel.**
   - Extract's stage record of a factor run gains `extract_workers` (format 7 only; format 6 exports stay byte for
     byte).
   - The Run panel's Extract line names the workers: "Extract on the factors (6 workers): 12,000 / 72,000 frames".
5. **Measurement.**
   - A 3-min 600 px stream (`motion_s5` at 20 fps), Extract with 1, 3 and 6 workers.
   - `wl24_20251201` with `?factors=file&cpool=4,4,X` (X 1 and 6), where slice 5's Extract read the factors.
   - The 1 h V4 stream again is optional: about 75 min of machine time. The owner decides after the short runs.

## Expected gain (inferred, Task 7 measures it)

- One worker does 32 frames/s on the 1 h stream (1,282 cells). Six workers at 3.5-4.5x would make 110-145 frames/s.
  Extract on the 1 h stream would then take 8-11 min instead of 37, faster than the file's replay (16 min at 76
  frames/s).
- That is a guess. Slice 5's compression scaled only about 2x with 4 workers at 600 px, but it ran beside Discover or
  the settle. Extract runs alone and reads 33 MB per window instead of 800 MB, so it should scale better.

## Global Constraints

- **Testing scope (owner: less testing).** Unit tests only for logic that can hang, lose data or change an export: the
  window pool's order and releases, traces the same for any width, the difference from the chained solve within the
  tolerance, the export field. The e2e and the measurement. Wiring and UI text are covered by the e2e.
- **The traces do not depend on the width** (decision 1). The export's length and cell order never change.
- **Every state says what releases it** (table below).
- **Only the coordinator touches OPFS**, as in slice 5.
- No test depends on machine speed.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest), `npx prettier --check` on every touched file.
- e2e: `npm run build:e2e`, then `npx playwright test e2e/cala-factors.spec.ts e2e/cala-live.spec.ts e2e/cala.spec.ts`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer, no tool or assistant attribution. Never
  amend. Do not push without the owner's yes.
- No machine paths, user names or emails in committed files.
- Long shell commands go in a script under the git-ignored `.scratch/`. Never bare `git stash`.
- Branch: `feat/cala-factor-extract-pool`.

### States and what releases them

| state (where)                                       | Cancel / a new run                                                      | failure                                                                   | a helper crash                                                              | a hang                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| a window at a helper (`WindowPool.inFlight`)        | `extract-cancel` or `reset`: the job's id changes, late answers dropped | `window-error` → the job posts `error` (as a throw in `runExtract` today) | `helper-lost` → the window's factor file is read again and solved elsewhere | `WINDOW_TIMEOUT_MS` (5 min) → as a crash |
| the job's engine at a helper (`extract-begin`)      | `extract-end` frees it; a new `extract-begin` replaces it               | -                                                                         | gone with the helper                                                        | -                                        |
| answers waiting for an earlier window (reorder map) | dropped with the job                                                    | dropped with the job                                                      | the missing window is redone, then the map drains                           | the timeout above                        |
| the main side's job (`FactorJob.done`)              | unchanged from slice 2                                                  | unchanged                                                                 | unchanged                                                                   | unchanged                                |

## Review Focus

1. **Same traces for any width.** A fresh engine per window, the same rebuild, the same batch of 16. Pinned: Task 3's
   test (width 1 against width 3 with answers out of order, bit for bit).
2. **`extracted` reaches the main thread in window order, once per window.** Pinned: Task 2.
3. **Every window handed out settles**: answer, error, crash, timeout, cancel, reset. Pinned: one Task 2 test per
   release.
4. **Helpers never touch OPFS.** The coordinator reads the factor file and transfers its bytes.

## File Structure

| File                                                                                                | Change | Responsibility                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `apps/cala/src/lib/compress-pool.ts`                                                                | modify | `WindowPool` (ordered window jobs over the same helpers); `extract` width                           |
| `apps/cala/src/workers/compress-types.ts`                                                           | modify | `extract-begin`, `extract-window`, `extract-end`; their answers                                     |
| `apps/cala/src/lib/factor-solve.ts`                                                                 | create | `solveWindow`: rebuild and solve one window with a fresh engine (shared by coordinator and helpers) |
| `apps/cala/src/workers/compress-helper-worker.ts`                                                   | modify | answers Extract windows                                                                             |
| `apps/cala/src/lib/compress-runner.ts`, `workers/compress-worker.ts`                                | modify | `runExtract` over the window pool                                                                   |
| `apps/cala/src/lib/compress-client.ts`, `App.tsx`, `lib/pipeline-store.ts`                          | modify | the third width, helpers to create                                                                  |
| `apps/cala/src/lib/export.ts`, `lib/run-stages.ts`, `lib/pass2-store.ts`, `components/RunPanel.tsx` | modify | `extract_workers`; the Extract line                                                                 |
| `apps/cala/src/__tests__/compress-pool.test.ts`, `compress.test.ts`, `export.test.ts`               | modify | tests per task                                                                                      |
| `e2e/cala-live.spec.ts`                                                                             | modify | the factor stream's Extract with a pool                                                             |
| `apps/cala/scripts/live-measure.mjs`                                                                | modify | Extract's workers and frames per second                                                             |
| `tools/cala-eval/results/2026-11-2x-factor-extract-pool.md`                                         | create | the measurement                                                                                     |
| `apps/cala/README.md`, `apps/cala/docs/stages.md`, `docs/CHANGELOG.md`                              | modify | docs                                                                                                |

---

### Task 1: `solveWindow`, one window on a fresh engine

**Files:** create `apps/cala/src/lib/factor-solve.ts`; modify `lib/compress-runner.ts`, `__tests__/compress.test.ts`.

**Interfaces:**

- `function solveWindow(window: FactorWindowLike, engine: BackfillEngineLike, px: number, batch?: number): { traces: Float32Array; signed?: Float32Array }`
- `runExtract` builds a new engine per window (`makeEngine(job.library, true)`) and calls `solveWindow`.

- [ ] **Step 1: Failing test** (`compress.test.ts`, the sim cell movie of the back-fill tests): Extract's traces with
      a fresh engine per window differ from the chained solve (one engine for all windows) by at most the solver's
      tolerance times each trace's noise, and only in each window's first frames.
- [ ] **Step 2: Run; expect failure** (no `solveWindow`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): Extract on factors solves each window on a fresh engine`

### Task 2: `WindowPool`, ordered windows over the helpers

**Files:** `lib/compress-pool.ts`, `workers/compress-types.ts`, `__tests__/compress-pool.test.ts`.

**Interfaces:**

- Messages to a helper: `{ type: 'extract-begin'; job: number; library: Uint8Array; signed: boolean }`,
  `{ type: 'extract-window'; job: number; index: number; bytes: Uint8Array }` (transferred),
  `{ type: 'extract-end'; job: number }`.
- Answers: `{ type: 'window-done'; job; index; traces; signed? }`, `{ type: 'window-error'; job; index; message }`.
- `class WindowPool` beside `TilePool`, sharing the helpers' liveness (a helper lost to one is lost to both):
  `setWidth(n)`, `run(job, windows, io: { read(index): Promise<Uint8Array>; local(bytes): Promise<result>; emit(index, result): void; yieldNow() }): Promise<boolean>` (false when cancelled or reset), `cancel(job)`, `onHelper`, `lost`.
- `const WINDOW_TIMEOUT_MS = 300_000`

- [ ] **Step 1: Failing tests** (fake helpers, as in slice 5's tile pool tests):
  - width 1: every window solved locally, emitted in order;
  - width 3, answers in reverse: emitted in window order, once each;
  - a helper crash, a failed start, a timeout: the window is read again and solved elsewhere; the job completes;
  - a window error: `run` rejects; later answers are dropped;
  - cancel and reset: `run` returns false; late answers emit nothing.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): a window pool that solves Extract's windows on the compress helpers and emits them in order`

### Task 3: The helpers solve windows; the runner extracts through the pool

**Files:** `workers/compress-helper-worker.ts`, `lib/compress-runner.ts`, `workers/compress-worker.ts`,
`__tests__/compress.test.ts`.

- [ ] **Step 1: Failing test:** Extract with width 1 and with width 3 (fake helpers that run `solveWindow` in
      process and answer in reverse order) give bit-identical `extracted` traces and signed traces, in window order.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.** The helper keeps one engine library per job (`extract-begin`), builds a fresh engine
      per window, frees all at `extract-end`. `runExtract` reads each factor file once per hand-out.
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): Extract on factors runs over the compress pool`

### Task 4: The extract width

**Files:** `lib/compress-pool.ts` (`compressPoolSize` gains `extract`; `parsePoolOverride` reads `D,E` or `D,E,X`),
`App.tsx`, `lib/pipeline-store.ts`, `workers/compress-types.ts` (`CompressInit.pool.extract`), `lib/compress-client.ts`,
`__tests__/compress-pool.test.ts`.

- [ ] **Step 1: Failing test:** `compressPoolSize(10, 4, 0)` is `{ discover: 1, after: 3, extract: 6 }`;
      `parsePoolOverride('1,3,6')`; `'1,3'` keeps `extract` at `after`.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement**; helpers created `max(...) - 1`.
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): Extract on factors uses all but two cores, at most six`

### Task 5: The export and the Run panel

**Files:** `lib/run-stages.ts`, `lib/export.ts`, `lib/pass2-store.ts`, `components/RunPanel.tsx`,
`__tests__/export.test.ts`.

- [ ] **Step 1: Failing test:** a factor Extract record with `workers` writes `extract_workers`; a format 6 export is
      unchanged (the existing test).
- [ ] **Step 2-4:** run, implement, checks.
- [ ] **Step 5: Commit** `feat(cala): the export and the Run panel name Extract's workers`

### Task 6: e2e

**Files:** `e2e/cala-live.spec.ts`.

- [ ] The factor stream test runs once more with `?debug&cpool=1,3,3`: it settles, extracts on the factors with 3
      workers and exports both trace sets, as without the pool.
- [ ] `npm run build:e2e`, then the three spec files.
- [ ] **Commit** `test(cala): e2e for a stream whose Extract on factors runs on three workers`

### Task 7: Measurement

**Files:** `apps/cala/scripts/live-measure.mjs`, create `tools/cala-eval/results/2026-11-2x-factor-extract-pool.md`.

- [ ] `motion_s5` streamed 3 min at 20 fps, `cpool` `1,3,1`, `1,3,3`, `1,3,6`: Extract's time and frames per second,
      the engine build time per window, and the traces' largest difference from the one-worker run.
- [ ] `wl24_20251201` with `?factors=file&cpool=4,4,1` and `4,4,6`: Extract on factors against slice 5's 49 s and the
      file's 31 s.
- [ ] The 1 h V4 stream only if the owner asks for it after the short runs.
- [ ] Report; **commit** `docs(cala-eval): Extract on factors with one to six workers`

### Task 8: Docs

- [ ] README (compress pool: Extract), `stages.md` (Extract on factors), CHANGELOG.
- [ ] **Commit** `docs(cala): Extract on factors over the compress pool`
