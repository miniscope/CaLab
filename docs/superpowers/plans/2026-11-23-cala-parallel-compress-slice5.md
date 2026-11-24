# cala factors, slice 5: parallel compression, so a recording's factors keep up with Discover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the compress worker gets helpers. The tiles of each window are spread over a pool of compress workers, so a
window is compressed in about 1/N of the time. Fewer workers run while Discover reads (Discover keeps its cores) and
more after Discover's last frame, when the pipeline's stage workers are idle. With `?factors=file`, Extract then reads
the factors on the test recordings, and the settle does when the compressor is close enough at Discover's end. A
stream's last-window wait shrinks. The raw windows waiting on disk get a cap. Nothing else changes.

**Architecture:**

- The compress worker stays the only one that touches OPFS (the coordinator). It still takes the chunks, quantizes
  them and writes the window files. When it compresses a window, it reads one tile at a time from the window file and
  hands it to a free slot of the pool: itself or a helper. A helper compresses the tile (`TileCompressor.compress`, the
  same WASM call) and sends back the tile's factor bytes. The coordinator writes them in tile order into the factor
  file.
- One window at a time, as today. So windows finish in stream order, and the status, `compressed`, `ready`, coverage,
  the back-fill and Extract keep their meaning without a change.
- The tile seed is `(window << 20) ^ tile`, as today, and `TileCompressor` is stateless (`&self`, config only). So the
  factor files are byte-identical for any number of workers. That is the main test.
- The pool's width has two values per run: `discover` (until the feed's final `close`) and `after` (from then on).
  The main thread sizes both from the core count, the visit workers and the settle pool (decision 2).
- Helpers are plain workers created by the main thread, each with a `MessageChannel` to the coordinator. They hold no
  store, no lock and no folder.

**Tech Stack:** TypeScript with SolidJS and vitest (`apps/cala`), Web Workers, OPFS; Playwright (e2e and the
measurement). No Rust change.

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`: decision 1 ("Pace": sharing tiles
across compress workers is a precondition for files by default), Risks (storage), "Not in scope" (parallel
compression; a storage cap). Evidence: `tools/cala-eval/results/2026-11-23-factors-file-speed.md` (one worker is
4-5x slower than Discover reads a file; the raw-window backlog), `2026-11-23-factors-live-speed.md`,
`2026-11-24-settle-factors.md` (`SET-F` against `SET-R`).

**Base:** `feat/cala-factors-settle` (PR #493, open; slices 1-4 are merged into it). The PR goes to `main` if #493 has
merged by then, else to `feat/cala-factors-settle`.

## The numbers this plan works from

Measured in Chrome on the owner's Apple M1 Max (10 logical cores), one compress worker, offset grids:

| recording             | size   | frames | Discover        | one compress worker    | workers to keep pace | raw backlog per frame |
| --------------------- | ------ | -----: | --------------- | ---------------------- | -------------------: | --------------------: |
| `motion_s5` (minisim) | 600 px |  9,600 | 54 s, 178 fps   | 25 ms/frame, 40 fps    |                  4.5 |               0.72 MB |
| `wl24_20251201`       | 200 px | 40,234 | 35 s, 1,150 fps | 3.27 ms/frame, 306 fps |                  3.8 |               0.08 MB |
| 1 h V4 (expected)     | 600 px | 72,000 | about 405 s     | 40 fps                 |                  4.5 |               0.72 MB |

Threads a recording keeps busy on 10 cores today: the main thread, three stage workers and the slow worker
(`RESERVED_THREADS` 5), 4 visit workers (`visitWorkerCount(10)`), look-back worker 0, and the compress worker: 11.
No settle pool below 12 cores (`settlePoolSize`). After Discover's last frame the three stage workers are idle.

So on 10 cores the pool cannot keep full pace during Discover without taking cores Discover uses. The owner's warning
holds. This plan keeps Discover's cores by default and uses the cores freed at Discover's end (decision 2). The
measurement (Task 8) shows what more workers during Discover would cost.

## Decided for the owner's review

Each says what would change it.

1. **Tiles of one window are shared, not one window per worker.**
   - Each tile goes to a free slot; one window is compressed at a time; its tiles go back into the factor file in tile
     order.
   - Why not one window per worker:
     - Windows would finish out of order. The status, `compressed`, `behind`, coverage and slice 3's choice would
       need a reorder step, and a gap would be possible while a later window is done.
     - Every worker would open its own window and factor files in OPFS. Sync access handles across workers needed
       care on #442; a lost `createSyncAccessHandle()` stops a worker silently (`pinned` in `window-store.ts`).
     - The last window still takes one worker's full time (15 s at 600 px). With shared tiles it takes about 1/N.
       That is the wait slice 3's settle and every stream's settle have at Discover's end.
   - Costs of sharing tiles: the coordinator reads every tile (as today) and posts it (about 4.9 MB per 64 px tile of
     a 600-frame window). Between two windows each slot waits for the window's last tile (about one tile's time, under
     3 % of a window at 600 px).
   - What would change it: the measurement shows the coordinator saturated (chunk writes falling behind while it
     reads and posts tiles). Then a window per worker is the next step, with the reorder.
2. **How many workers: few during Discover, more after it.**
   - `discover` = `max(1, cores - 6 - visitWorkers - settlePool)`, at most 4. That is 1 plus the cores no thread of
     Discover uses (the 5 reserved threads, the visit workers, look-back worker 0, the coordinator).
   - `after` = `max(1, cores - 3 - visitWorkers - settlePool)`, at most 4. After Discover's last frame the settle uses
     the main thread, the slow worker, the visit workers and look-back worker 0 (and the settle pool); the stage
     workers are idle.
   - Helpers created: `after - 1`, at the first run that compresses, kept for the page.
   - On the owner's 10 cores: `discover` 1 (as today), `after` 3. On 8 cores (3 visit workers): 1 and 2. On 16 cores:
     4 and 4.
   - A stream runs with `discover` 1 whatever the cores: at 20 fps one worker keeps up and the live Discover must not
     lose cores. Its `after` applies once the stream ends (its last window).
   - `?debug&cpool=D,E` sets both for a measurement (each 1-4).
   - What would change it: the measurement (Task 8). If Discover with `discover` 2 or 3 is within the owner's line
     (proposed: Discover's wall time at most 10 % above the run without the switch), the formula moves that many cores
     to compression on a 10-core machine. A run with 3 visit workers and `discover` 2 is measured too, to see whether a
     visit worker is worth less than a compressor.
3. **Slice 3's choice at Discover's end scales with the pool.**
   - Today: the settle waits for the factors when the compressor is at most one window behind, else it reads the file.
   - New: at most `after` windows behind. `after` workers compress `after` windows in about one window's time of one
     worker, so the wait keeps slice 3's bound. With `after` 1 the rule is slice 3's.
   - The reason's seconds use the pool: "the compressor was 7,440 frames, about 62 s with 3 workers, behind when
     Discover ended".
   - Extract still never waits: it reads the factors when they are `ready` at its start, else the file with the reason.
   - What would change it: the owner wants a time budget instead (for example "wait at most 20 s"). Then the rule is
     `behind × msPerFrame / after <= budget`.
4. **What a user should expect on 10 cores (inferred from the numbers above, linear scaling assumed; Task 8 measures
   it).**

   | recording       | lag at Discover's end (`discover` 1) | settle                                                           | Extract                                                   | raw backlog at its peak |
   | --------------- | -----------------------------------: | ---------------------------------------------------------------- | --------------------------------------------------------- | ----------------------: |
   | `motion_s5`     |             7,440 frames, 12 windows | file (more than 3 behind)                                        | factors (caught up after about 62 s of the 92 s settle)   |                  5.4 GB |
   | `wl24_20251201` |            29,500 frames, 49 windows | file                                                             | borderline: about 6,600 frames left after the 25 s settle |                  2.4 GB |
   | 1 h V4          |            55,800 frames, 93 windows | file                                                             | file (the backlog cap, decision 5)                        |  40 GB (capped at 8 GB) |
   | a stream        |                 the last window only | factors, last-window wait about 6 s instead of 17-18 s at 600 px | factors                                                   |                  0.4 GB |

   With `discover` 4 and Discover not slowed, `motion_s5` would be 960 frames behind and settle on factors, and
   `wl24_20251201` would keep pace. Whether Discover stays fast with 4 compressors on 10 cores is the open question.

5. **A cap on the raw windows waiting on disk.**
   - The coordinator tracks the bytes of window files not yet compressed (the open one and the pending ones).
   - At a run's first chunk it reads `navigator.storage.estimate()` (available in workers). The cap is
     `min(8 GB, half of quota - usage)`.
   - Past the cap the run's factors are given up: the coordinator removes every window and factor file of the run,
     writes no more chunks, and posts an error with the reason ("The windows waiting for compression would need more
     than 8.0 GB of disk."). The factors are `unusable`, so a recording's settle and Extract read the file with that
     reason, and a stream ends at Discover's library (slice 2's `unusable` path). Discover is not touched.
   - Why: on the slice 3 measurement the system disk had 13 GB free and Chrome refused the writes. A 1 h 600 px file
     run with `discover` 1 would want about 40 GB of raw windows; filling the system disk harms more than this run.
   - Inferred, to be checked in Task 8: whether Chrome's `quota - usage` reflects the free disk.
   - What would change it: the owner prefers back-pressure (Discover pauses while the backlog is over the cap) so the
     factors always complete. Not proposed: it slows Discover to the compressor's pace, the trade the owner warned
     about.
6. **The Run panel.** The compression readout gains the pool and the backlog:
   `Compression: 12 windows · 3 workers · 118 fps · rank 5.6 · 24.1 ms/frame · 660 MB · 9 waiting (3.9 GB on disk)`.
   `ms/frame` stays the compute per frame summed over the workers; `fps` is the wall pace of the last window. The
   settle and Extract lines keep slice 3's texts with the reason of decision 3 or 5.
7. **The export.** Only factor runs (format 7) gain fields; format 6 exports stay byte for byte.
   - Discover's stage record: `compress_workers` (`discover`), `compress_workers_after`, `compress_behind_frames` (the
     lag at Discover's end), `compress_backlog_peak_bytes`, `compress_fps_after` (the pace after Discover's end).
   - Format 7 is not released yet (PR #493 is open), so no version bump.
   - What would change it: the owner wants these in `run_record.work` for every run. That changes format 6 exports and
     needs its own version decision.
8. **Not in this slice:**
   - Extract on factors spread over the pool (it stays in the coordinator: about 6.6 ms per frame at 600 px against
     5.2 for the file's Extract).
   - The settle following the compressor (below, "What would make recordings default to factors").
   - Any default change for recordings. `?factors=file` stays experimental.

## What would make recordings default to factors

Answered here so the owner can decide what comes after this slice. All four have to hold.

1. **Pace without slowing Discover.** Shown by Task 8. The pool alone gets there on 10 cores only if Discover tolerates
   3-4 compressors. If not, the next slice is **the settle following the compressor**: the settle reads frames in
   stream order (`settlePlan`), so it could start on the windows already compressed and wait per window instead of
   choosing the file at once. On `motion_s5` the settle reads about 104 frames/s and the pool after Discover about
   120: the settle would start at once and never wait. On `wl24_20251201` the sampled plan moves through the stream at
   about 1,700 frames/s, faster than the pool, so it would wait some. It changes slice 3's "never mixes, decides once"
   rule and needs its own plan.
2. **Disk.** The cap (decision 5) must not trip on the owner's usual recordings. For a 1 h 600 px file that needs the
   compressor within about 11,000 frames of Discover (8 GB), so about 3.8 workers' pace during Discover, or the settle
   following the compressor (which does not shrink the backlog during Discover).
3. **Quality.** Slice 1's evaluation did not pass `SET-F` on the real recording (repeatability: cosine 0.895 against
   0.918 for the raw settle). That must pass first, or be accepted by the owner.
4. **Speed after Discover.** The settle on factors was 20 % faster on the 600 px sim and equal at 200 px. Extract on
   factors in one worker is slower than the file's Extract at 600 px (decision 8). Spreading Extract's windows over the
   pool is a small follow-up once the pool exists.

## Global Constraints

- **Testing scope (owner: less testing).** Unit tests only for logic that can hang, lose data or change an export: the
  pool (byte-identical factors for any width, every tile settles, a crash, a reset), the backlog cap, the choice's new
  threshold, the export fields. Sizing gets one table test because it decides what Discover loses. One e2e change and
  the measurement. Wiring and UI text are covered by the e2e.
- **With a width of 1 nothing changes.** The coordinator compresses every tile itself, in order, as today. The
  existing `compress.test.ts` tests pass unchanged. A stream's live Discover keeps one compress worker.
- **Every state says what releases it** (table below), and every tile in flight settles (Review Focus 3).
- **Only the coordinator touches OPFS.** Helpers get tile data and return bytes.
- No test depends on machine speed: fake ports and timers in unit tests; the e2e asserts no time; the measurement is a
  report.
- Each new test fails without its feature (a missing symbol, or an assertion on new behaviour).
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on every touched file.
- e2e, from the repository root: `npm run build:e2e`, then `npx playwright test e2e/cala-factors.spec.ts
e2e/cala-live.spec.ts e2e/cala.spec.ts`.
- Nothing is built, tested or measured on the owner's Mac while another session's speed runs are going (check their
  `runs.log` for "all done"). The measurement keeps the Chrome profile on the evaluation SSD (`live-measure.mjs
--user-data-dir`, commit `b5722a71` on `perf/cala-factors-v4-speed`; cherry-pick it if it has not merged).
- Commits: one sentence, conventional prefix, no body, no co-author trailer, no tool or assistant attribution. Never
  amend. Do not push without the owner's yes.
- No machine paths, user names or emails in committed files.
- The shell refuses long compound commands: anything longer goes in a script under the git-ignored `.scratch/`.
- Never bare `git stash`.
- Branch: `feat/cala-parallel-compress`.

### States and what releases them

| state (where)                                                          | Stop / a new run                                                    | failure                                                                                          | a worker crash                                                                                                                                  | a hang                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| a tile at a helper (`TilePool.inFlight`)                               | `reset` bumps the epoch; a late answer is dropped, its buffer freed | `tile-error` → the window's compression throws → `error` → factors `unusable` (as a throw today) | the main thread's `onerror` → `helper-lost` → the tile is read again and given to another slot or the coordinator; the helper is not used again | `TILE_TIMEOUT_MS` (60 s) → as a crash                                    |
| a helper that cannot start (WASM init fails)                           | -                                                                   | its first answer is `helper-error` → as a crash                                                  | as above                                                                                                                                        | -                                                                        |
| the window being compressed (`CompressRunner.compress` awaiting tiles) | `reset` (epoch): returns at once, files cleared as today            | as above                                                                                         | the tile is redone; the window completes                                                                                                        | the tile timeout; behind it the factor watchdog (120 s without progress) |
| the backlog cap tripped (`CompressRunner.gaveUp`)                      | the next `init` clears it                                           | terminal for the run: no more writes, files removed, one `error`                                 | -                                                                                                                                               | -                                                                        |
| the storage estimate (`estimate()` at the first chunk)                 | `reset` (epoch): its answer is ignored                              | rejected → the cap is 8 GB                                                                       | -                                                                                                                                               | not awaited by chunk writes: until it answers, the cap is 8 GB           |

## Review Focus

1. **A width of 1 is today's code path.** `TilePool` with no helpers runs each tile on the coordinator in order,
   synchronously with the same reads. Pinned: Task 2's "width 1 equals the old loop" and the unchanged runner tests.
2. **The factor bytes do not depend on the width or on the order answers arrive.** Seed per window and tile; the
   reorder writes tile `i` only after `0..i-1`. Pinned: Task 2's byte-identical test with answers in reverse order.
3. **Every tile in flight settles**: answer, error, helper crash, helper start failure, timeout, reset. Pinned: one
   Task 2 test per release.
4. **Helpers never touch OPFS.** The helper worker imports no `window-store` (Task 3's code; a grep in review).
5. **Discover keeps its cores by default.** `compressPoolSize(10, 4, 0)` is `{ discover: 1, after: 3 }`; a stream's
   `discover` is 1. Pinned: Task 1.
6. **The cap removes only this run's files** (`store.clear()` of the run folder, as `reset` does) and never touches
   another tab's folder.

## File Structure

| File                                                                                                                 | Change | Responsibility                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `apps/cala/src/lib/compress-pool.ts`                                                                                 | create | `compressPoolSize`, `COMPRESS_POOL`, `parsePoolOverride`; `TilePool` (dispatch, reorder, releases)  |
| `apps/cala/src/workers/compress-helper-worker.ts`                                                                    | create | a helper: WASM init, one `TileCompressor` per quant, answers tiles                                  |
| `apps/cala/src/workers/compress-types.ts`                                                                            | modify | `CoordinatorToHelper`, `HelperToCoordinator`; `connect.helpers`; `CompressInit.pool`; status fields |
| `apps/cala/src/lib/compress-runner.ts`                                                                               | modify | `compress()` through the pool; width switch at the final close; backlog and cap                     |
| `apps/cala/src/workers/compress-worker.ts`                                                                           | modify | builds the pool from `connect.helpers`; `helper-lost`                                               |
| `apps/cala/src/lib/compress-client.ts`                                                                               | modify | creates helpers and their channels; `onerror` → `helper-lost`                                       |
| `apps/cala/src/lib/compress-feed.ts`, `workers/frame-types.ts`, `workers/trace-worker.ts`, `workers/frame-worker.ts` | modify | pass the run's pool widths in `init`                                                                |
| `apps/cala/src/lib/factor-run.ts`, `lib/pipeline-store.ts`, `App.tsx`                                                | modify | the widths per run (stream: `discover` 1); `?debug&cpool`                                           |
| `apps/cala/src/lib/factor-settle.ts`, `lib/factor-run.ts`                                                            | modify | the choice's threshold and reason with `after`                                                      |
| `apps/cala/src/lib/compress-store.ts`, `components/RunPanel.tsx`                                                     | modify | `compressReadout` with workers, fps, backlog; the lag at Discover's end                             |
| `apps/cala/src/lib/export.ts`, `lib/run-stages.ts`                                                                   | modify | the Discover stage record's compress fields (format 7 only)                                         |
| `apps/cala/src/__tests__/compress-pool.test.ts`                                                                      | create | sizing; the pool                                                                                    |
| `apps/cala/src/__tests__/compress.test.ts`, `factor-settle.test.ts`, `export.test.ts`                                | modify | the cap; the threshold; the export fields                                                           |
| `e2e/cala-factors.spec.ts`                                                                                           | modify | a `?factors=file` run with a pool of 3                                                              |
| `apps/cala/scripts/live-measure.mjs`                                                                                 | modify | records the new status and export fields                                                            |
| `tools/cala-eval/results/2026-11-2x-parallel-compress.md`                                                            | create | the measurement (date of the run)                                                                   |
| `apps/cala/README.md`, `apps/cala/docs/stages.md`, `docs/CHANGELOG.md`                                               | modify | docs                                                                                                |

---

### Task 1: Pool sizing

**Files:** create `apps/cala/src/lib/compress-pool.ts`, `apps/cala/src/__tests__/compress-pool.test.ts`.

**Interfaces:**

- `const COMPRESS_POOL = { max: 4, discoverReserve: 6, afterReserve: 3 } as const`
- `interface PoolWidth { discover: number; after: number }`
- `function compressPoolSize(cores: number | undefined, visitWorkers: number, settlePool: number): PoolWidth`
- `function parsePoolOverride(v: string | null): PoolWidth | null` (`"D,E"`, each 1-4; anything else null)

- [ ] **Step 1: Failing test** (`compress-pool.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { compressPoolSize, parsePoolOverride } from '../lib/compress-pool.ts';

describe('compressPoolSize', () => {
  it('leaves Discover its cores and uses the freed ones after it', () => {
    expect(compressPoolSize(10, 4, 0)).toEqual({ discover: 1, after: 3 });
    expect(compressPoolSize(8, 3, 0)).toEqual({ discover: 1, after: 2 });
    expect(compressPoolSize(16, 4, 1)).toEqual({ discover: 4, after: 4 });
    expect(compressPoolSize(undefined, 0, 0)).toEqual({ discover: 1, after: 1 });
  });
  it('reads ?debug&cpool=D,E', () => {
    expect(parsePoolOverride('2,4')).toEqual({ discover: 2, after: 4 });
    expect(parsePoolOverride('0,9')).toBeNull();
    expect(parsePoolOverride('x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run; expect failure** (no module).
- [ ] **Step 3: Implement** the two functions.
- [ ] **Step 4: Checks** (`typecheck`, `lint`, `test -w apps/cala`).
- [ ] **Step 5: Commit** `feat(cala): size the compress pool from the cores Discover and the settle leave free`

### Task 2: `TilePool`, the coordinator's dispatch

**Files:** `apps/cala/src/lib/compress-pool.ts`, `apps/cala/src/workers/compress-types.ts`,
`apps/cala/src/__tests__/compress-pool.test.ts`.

**Interfaces:**

- Messages:
  - `CoordinatorToHelper = { type: 'init'; quant: number } | { type: 'tile'; epoch: number; window: number; tile: number; frames: number; x0: number; y0: number; w: number; h: number; seed: number; raw: Int16Array }` (`raw` transferred)
  - `HelperToCoordinator = { type: 'tile-done'; epoch: number; window: number; tile: number; rank: number; ms: number; bytes: Uint8Array; raw: Int16Array } | { type: 'tile-error'; epoch: number; window: number; tile: number; message: string } | { type: 'helper-error'; message: string }`
- `interface TileJob { window: number; tile: number; frames: number; x0: number; y0: number; w: number; h: number; seed: number }`
- `interface TileResult { rank: number; ms: number; bytes: Uint8Array }`
- `class TilePool`:
  - `constructor(deps: { local: TileCompressorLike | (() => TileCompressorLike); helpers: PortLike<CoordinatorToHelper>[]; now?: () => number; timeoutMs?: number; setTimer?; clearTimer? })`
  - `setWidth(n: number): void` (slots used: `min(n, 1 + live helpers)`)
  - `compressWindow(epoch: number, jobs: TileJob[], read: (job: TileJob, into: Int16Array) => void, write: (job: TileJob, r: TileResult) => void, yieldNow: () => Promise<void>): Promise<void>`: resolves once every tile is written, in tile order; rejects on a tile error.
  - `onHelper(k: number, msg: HelperToCoordinator): void`, `lost(k: number): void`, `reset(): void` (bumps the epoch, drops what is in flight).
- `const TILE_TIMEOUT_MS = 60_000`

- [ ] **Step 1: Failing tests** (`compress-pool.test.ts`), with fake helper ports that record tiles and let the test
      answer them in any order, and a fake local compressor whose bytes are a function of the seed and the raw data:
  - **width 1 equals the old loop**: no helper is posted to; `write` is called for tiles `0..n-1` in order; the bytes
    equal the local compressor's.
  - **byte-identical for any width**: the same window with width 3, helpers answering in reverse order: the
    concatenated `write` bytes equal width 1's.
  - **a helper crash**: `lost(k)` with a tile at helper `k`: the tile is read again and compressed elsewhere; the
    window resolves with every tile once; helper `k` gets nothing more.
  - **a helper that cannot start**: `helper-error` from helper `k`: as a crash.
  - **a timeout**: no answer within `TILE_TIMEOUT_MS` (fake timer): as a crash.
  - **a tile error**: `tile-error` rejects `compressWindow` with the message; later answers of that window are
    dropped.
  - **a reset**: `reset()` while tiles are in flight: `compressWindow` resolves without further writes; a late
    `tile-done` of the old epoch writes nothing.
- [ ] **Step 2: Run; expect failures** (no `TilePool`).
- [ ] **Step 3: Implement.** Free slots are the coordinator and the live helpers up to the width. A slot takes the
      next tile: `read` fills a buffer (a helper's comes back with its answer and is reused), the coordinator
      compresses its own tile inline then yields (`yieldNow`), a helper's tile is posted with `raw` transferred.
      Answers wait in a reorder map until every earlier tile is written. At most `width` tiles are in flight, so the
      map holds at most `width - 1` answers.
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): a tile pool that spreads a window's tiles over compress workers and writes them in order`

### Task 3: The helper worker and its wiring

**Files:** create `apps/cala/src/workers/compress-helper-worker.ts`; modify `workers/compress-types.ts`
(`MainToCompress` `connect` gains `helpers?: MessagePort[]`; a new `{ type: 'helper-lost'; helper: number }`),
`workers/compress-worker.ts`, `lib/compress-client.ts`.

**Interfaces:**

- `createCompressClient(frames, onMessage, makeWorker?, review?, helpers?: { count: number; make?: () => CompressWorkerLike })`
- The helper: on `init`, `new TileCompressor(quant)` (freed on the next `init`); on `tile`, `compress(...)` then
  `toBytes()`, answer `tile-done` with `bytes` and `raw` transferred; any throw answers `tile-error`; a failed WASM
  init answers `helper-error` to every message.

- [ ] **Step 1: Implement** (no unit test: wiring; the e2e in Task 7 runs it). The client makes `count` helpers, one
      `MessageChannel` each, passes the coordinator ends in `connect` and the helper ends to the helpers. A helper's
      `onerror` posts `helper-lost` with its index to the coordinator. `dispose` terminates the helpers too. The
      compress worker builds the `TilePool` with the ports and forwards `helper-lost` to `pool.lost`.
- [ ] **Step 2: Checks**, plus a grep that the helper imports nothing from `window-store.ts`.
- [ ] **Step 3: Commit** `feat(cala): compress helper workers that take tiles from the compress worker`

### Task 4: The runner compresses through the pool; widths, backlog and the cap

**Files:** `lib/compress-runner.ts`, `workers/compress-types.ts`, `lib/compress-feed.ts`, `workers/frame-types.ts`,
`workers/trace-worker.ts`, `workers/frame-worker.ts`, `__tests__/compress.test.ts`.

**Interfaces:**

- `CompressInit.pool?: PoolWidth` (absent: `{ discover: 1, after: 1 }`); `CompressFeedOptions.pool`.
- `CompressRunnerDeps.pool?: TilePool` (absent: a pool of width 1 over `create(quant)`); `CompressRunnerDeps.estimate?: () => Promise<{ quota?: number; usage?: number }>`.
- `CompressStatus` gains `workers: number`, `fps: number` (frames of the last window over its wall time),
  `backlogBytes: number`, `backlogPeakBytes: number`, `behindAtEnd: number | null` (frames Discover had sent and not
  compressed when the final close arrived), `fpsAfter: number | null` (frames compressed after the final close over
  their wall time).
- `const BACKLOG_MAX_BYTES = 8 * 2 ** 30`, `function backlogCap(e: { quota?: number; usage?: number } | null): number`
- `function backlogText(cap: number): string` ("The windows waiting for compression would need more than 8.0 GB of
  disk.")

- [ ] **Step 1: Failing tests** (`compress.test.ts`, memory store):
  - **the cap**: with `estimate` giving `quota - usage` of 2 windows' bytes (cap = 1 window), feeding 3 windows
    without letting the loop run: one `error` with `backlogText`; the store is empty afterwards; later chunks write
    nothing; a new `init` compresses again.
  - **the width switch**: a fake pool records `setWidth`: `discover` at `init`, `after` at the final close.
  - **the status**: `behindAtEnd` is the frames pending at the final close; `backlogBytes` falls to 0 when every
    window is compressed.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** `compress()` builds the window's `TileJob`s (same seed) and calls
      `pool.compressWindow` with a `read` that does today's per-chunk reads and a `write` that appends `u32` length and
      bytes, as today. The backlog is `bytes` of the open window plus the pending windows' bytes; the cap is checked
      after each chunk write. `estimate()` is asked once per run and not awaited by the writes.
- [ ] **Step 4: Checks**; every existing `CompressRunner` test passes unchanged.
- [ ] **Step 5: Commit** `feat(cala): the compress worker shares each window's tiles with its pool and caps the windows waiting on disk`

### Task 5: The widths per run, and slice 3's choice with the pool

**Files:** `lib/factor-run.ts`, `lib/pipeline-store.ts`, `App.tsx`, `lib/factor-settle.ts`,
`__tests__/factor-settle.test.ts`.

**Interfaces:**

- `FactorRunPlan.pool: PoolWidth | null` (a stream: `{ discover: 1, after }`; a recording that compresses:
  `{ discover, after }`; no compression: null).
- `FileSettleInput.workers: number` (the run's `after`).
- `fileBehindText(behind: number, msPerFrame: number, workers = 1): string`

- [ ] **Step 1: Failing tests** (`factor-settle.test.ts`):
  - with `workers` 3 and `window` 600, `behind` 1,800 waits (no answer yet) and 1,801 answers `file` at once;
  - with `workers` 1 the old cases hold (unchanged tests);
  - the reason with `workers` 3 says "with 3 workers" and divides the seconds by 3.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** `App.tsx` computes `compressPoolSize(navigator.hardwareConcurrency, slow.visitWorkers,
    lbPool)` once, or `parsePoolOverride(params.get('cpool'))` with `?debug`, creates `after - 1` helpers with the
      compress client, and gives the widths to the pipeline store. `factorRunPlan` sets a stream's `discover` to 1.
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): a recording's settle waits for the factors when the pool can compress the lag in about one window's time`

### Task 6: The Run panel and the export

**Files:** `lib/compress-store.ts`, `components/RunPanel.tsx`, `lib/export.ts`, `lib/run-stages.ts`,
`__tests__/export.test.ts`.

**Interfaces:**

- `compressReadout(s, b)`: `· N workers · F fps` when `workers > 1`, and `(X GB on disk)` after `N waiting`.
- `StageRun` of Discover gains `compress?: { workers: number; workersAfter: number; behindFrames: number | null; backlogPeakBytes: number; fpsAfter: number | null }`, written as `compress_workers`, `compress_workers_after`, `compress_behind_frames`, `compress_backlog_peak_bytes`, `compress_fps_after`.

- [ ] **Step 1: Failing test** (`export.test.ts`): a factor-file export with `compress` on Discover's stage writes the
      five fields; the existing "an export without stage sources stays 6" test is unchanged.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.** The pipeline store copies the last status's fields into Discover's stage record when the
      run compresses on the offset grids (format 7 runs only).
- [ ] **Step 4: Checks.**
- [ ] **Step 5: Commit** `feat(cala): the Run panel and the export of a factor run show the compress pool, its lag and its backlog`

### Task 7: e2e

**Files:** `e2e/cala-factors.spec.ts`.

- [ ] Add one test: the 590-frame cell movie with `?factors=file&debug&cpool=3,3`. Expect the settle and Extract on
      factors (as the existing test), the compression readout to name 3 workers, and the export's Discover stage to
      carry `compress_workers` 3. The existing tests run unchanged (width from the cores).
- [ ] Run `npm run build:e2e`, then the three spec files.
- [ ] **Commit** `test(cala): e2e for a ?factors=file recording compressed by a pool of three`

### Task 8: Measurement

Only after the other session's V4 speed runs are done. Chrome profile on the evaluation SSD.

**Files:** `apps/cala/scripts/live-measure.mjs` (record `workers`, `fps`, `backlogPeakBytes`, `behindAtEnd`,
`fpsAfter` from the status and the export), create `tools/cala-eval/results/2026-11-2x-parallel-compress.md`.

- [ ] Recordings: `motion_s5` (600 px) and `wl24_20251201` (200 px), `--mode file`, headed Chrome, one run per arm.
- [ ] Arms per recording (7):
  - no switch (the baseline: no compression);
  - `?factors=file` with `cpool` `1,1` (slice 3), `1,3` (this slice's default on 10 cores), `2,3`, `3,3`, `4,4`;
  - `?factors=file&visits=3` with `cpool` `2,3` (one visit worker traded for a compressor).
- [ ] Per run: Discover's wall time and fps, cells, the lag at Discover's end, the backlog's peak, the compressor's
      pace before and after Discover's end, the coordinator's quantize time, the settle source and time, the Extract
      source and time, `navigator.storage.estimate()` at the start.
- [ ] One stream run (`motion_s5`, 3 min at 20 fps, default) with `after` 3: the last-window wait against slice 2's
      17-18 s.
- [ ] Report: a table per recording; the largest `discover` within the owner's line (proposed 10 % on Discover's wall
      time against the baseline); whether `quota - usage` tracked the free disk. A report, no pass line.
- [ ] **Commit** `docs(cala-eval): Discover, the compressor's lag and each stage's source with a compress pool of 1 to 4`

### Task 9: Docs

**Files:** `apps/cala/README.md` (compression section: the pool, the cap), `apps/cala/docs/stages.md` (the factor
choice's threshold), `docs/CHANGELOG.md`.

- [ ] Write the docs from Tasks 1-8 (what the pool does, the widths on common core counts, `?debug&cpool`, the cap and
      its reason text, the measurement's result in one line).
- [ ] `npx prettier --check` on the touched files.
- [ ] **Commit** `docs(cala): the compress pool, its widths and the cap on windows waiting on disk`
