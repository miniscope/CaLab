# cala factors, slice 2: a live stream's Final settle and Extract on its own factors (`?factors`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** with `?factors`, a live stream no longer ends at Discover. When the stream ends, the slow loop waits for the
last factor window, runs the Final settle on frames rebuilt from the stream's own factors, and Extract then solves
every frame on the factors. The export keeps the live traces and adds Extract's. Without `?factors` nothing changes.

**Architecture:**

- Discover is unchanged except one slow-loop option: a `?factors` stream builds its slow loop with
  `jointUpdate 'refine'` (the cluster replay in the settle only; owner, 23 Nov). The compress worker compresses
  Discover's frames on the offset grids, as `?compress` does with plain tiles today.
- After the last frame, `SlowRunner` waits for the factors (a new state), then runs `main`'s settle unchanged
  (`startDrain`, `settlePump`, `observeSettle`). Only the source of a frame changes: look-back worker 0 is begun with a
  factor source and answers the same `request` messages with frames rebuilt from the windows (`FactorReader`).
- Extract on factors is `main`'s back-fill promoted to a stage: the compress worker rebuilds 16 frames at a time and
  solves them with the final library; `pass2-store` writes the traces to its usual trace files.
- One rebuild for both (`rebuildFrames`): `FactorWindow.reconstruct`, then NaN where no frame of the window had a
  valid sample (as the live frame had them).
- The look-back worker reads factor files read-only through `getFile()`; the compress worker's run folder holds a Web
  Lock so another tab's sweep leaves it alone (ported from #440).

**Tech Stack:** TypeScript with SolidJS and vitest (`apps/cala`), Web Workers, OPFS; Rust (`crates/cala`, one binding
and tests); Playwright (e2e and the speed check).

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`: decision 2 (main's settle on rebuilt
frames), decision 4 (Extract on rebuilt frames, factor states), decision 5 (the live stream), decision 6 (the Chrome
speed lines), "Decided by the owner" 3-5. Slice 1's evaluation (`tools/cala-eval/results/2026-11-24-settle-factors.md`):
`STR-F` passed every line against `STR-0`, so streams go ahead.

**Base:** `feat/cala-factors-settle` (PR #493, open): it brings factor format v2 and the offset grids to the app's
compressor. The PR goes to `main` if #493 has merged by then, else to `feat/cala-factors-settle`.

## Decided for the owner's review

Each says what would change it.

1. **`?factors` acts on live streams only in this slice.**
   - A stream with `?factors` compresses on the offset grids, settles and extracts on its factors.
   - A recording with `?factors` runs as with `?compress` today (plain tiles, the back-fill). Slice 3 adds files.
   - `?factors` turns compression on by itself (`?compress` is not needed with it).
   - `?review` is off with `?factors` (a console warning says why: the review reads plain tiles only).
   - What would change it: the owner wants `?factors` to refuse files outright until slice 3.
2. **The live Discover of a `?factors` stream uses `SlowLoop.withConfig(.., 'refine', 'all', Infinity)`.**
   - The cluster replay runs only in refine-scope visits, so in the settle (owner, 23 Nov). The merge guard stays off
     and the sign rule is the default, so Discover's visits are as today. This is slice 1's `STR-F` arm
     (`settle_factors.sh`: `--joint-update refine --joint-sign all`, no merge guard).
   - No `enableLookback`: the engine refuses rate 0 (`enableLookback`, `discover/js.rs:304`), and the end settle's
     `observe` takes its held-out side from the slow loop's own frame counter, not from the held-out record
     (`observe` in `discover/js.rs:261-286`). So the spec's "held-out record" item is not needed.
   - Pinned: a Rust test that Discover publishes byte-identical libraries with `refine` and `off` (Task 6).
   - What would change it: that test fails. Then stop and report; do not change the engine.
3. **The settle waits for the factors after the stream ends, with a watchdog.**
   - States: Discover's last frame → waiting for factors → the settle (sweep, final) → final library.
   - The wait ends when the factors are `ready`, `unusable`, on Stop settling, a new run, or after 120 s with no
     compressor progress (the watchdog marks the factors `unusable`).
   - With `unusable` or Stop while waiting, Discover's library is the final library, as on a stream today.
4. **Extract on factors runs in the compress worker** (the back-fill code, promoted). It also returns the signed
   traces. On a `?factors` stream the old back-fill does not run: it would replace the live traces in the trace
   history, and the owner wants both sets (23 Nov).
5. **A one-frame tail is left out.** The compressor cannot compress a window of one frame (`job.frames < 2`).
   - The factors then cover every frame but the last, and Extract solves those.
   - The export of such a run covers frames `0..F` (the last frame of the live traces too) and its note says so.
   - Alternative: keep the stream's length and put NaN in Extract's last frame. NaN would reach the CaDecon file,
     so it was not chosen.
6. **The export of a `?factors` stream:**
   - `traces` and `traces_signed` are Extract's, as for a recording.
   - The live traces are added as `traces_live` (same cell order).
   - The stage records carry `settle_source: 'factors'` (Discover) and `source: 'factors'` with the tiling, windows
     and mean rank (Extract).
   - `meta_json.notes` says the settle and Extract read the stream's own factors.
   - The CaDecon file gets Extract's signed traces, as for a recording.
   - `format_version` is 7 only for exports with these fields. Every other export stays at 6, byte for byte.
   - What would change it: the owner prefers one version (7) for every export; then Task 10's version helper goes.
7. **The Final-settle level of the Run panel applies to a stream's settle** (`settleFraction` is passed for factor
   runs as for look-back runs).
8. **The speed check streams the minisim `motion_s5` (600x600) at 20 fps, 3,600 frames (3 min) per run.**
   - Headed Chrome, 3 runs with `?factors` and 3 without, interleaved.
   - It extends `apps/cala/scripts/live-measure.mjs`. The report goes to `tools/cala-eval/results/`.
   - Settle and Extract times are reported per minute of stream. The owner sets that line after the first run (spec
     decision 6).

## Global Constraints

- **Testing scope (owner, 23 Nov: "a little less testing", as in slice 1).** The big measurements were done on the
  earlier factor branches and in slice 1's evaluation. Here: unit tests only for the new logic that can hang or lose
  data (factor state, the wait and its releases, the reader, the Extract job's settling, the export version), one
  e2e for the stream, and the speed check. Wiring and UI text are covered by the e2e, not by their own tests.
- **Without `?factors` nothing changes.** Same slow-loop constructor, the same messages, the same exports
  (`format_version` 6). The existing tests and `e2e/cala-live.spec.ts`'s current tests pass unchanged. A recording
  with `?factors` behaves as with `?compress`.
- **Every state says what releases it** (table below), and every pending request settles (Review Focus 2).
- No test depends on machine speed: fake clocks and timers in unit tests; the e2e waits with generous timeouts but
  asserts no time; the speed check is a report.
- Each new test fails without its feature (a missing symbol, or an assertion on new behaviour). Exception, said
  where it occurs: Task 6's Rust test pins engine behaviour the slice relies on and passes on the base.
- No Rust panic reachable from JS: the new binding returns plain data.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on every touched file outside `crates`.
- Rust checks (Task 4 and Task 6 change the crate), from `crates/cala`:
  - `cargo fmt --all --check`;
  - `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`;
  - the same with `--features pybindings` and with `--features diagnostics`;
  - `cargo test --no-default-features --features jsbindings`.
- e2e, from the repository root: `npm run build:e2e` then `npx playwright test e2e/cala-live.spec.ts`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer, no tool or assistant attribution. Never
  amend. Do not push.
- No machine paths, user names or emails in committed files.
- The shell refuses long compound commands: put anything longer in a script under a git-ignored scratch folder.
- Branch: `feat/cala-factors-live`.

### States and what releases them

| state (where)                                                      | Stop                                      | failure                                                                                | a new Discover                               | a worker crash                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| waiting for factors (`SlowRunner.factorWait`)                      | Stop settling: final library = Discover's | `factors` message with `ready: false` (unusable, watchdog): final library = Discover's | `init`/`reset` → `drop()`                    | compress worker: its error makes the factors `unusable` → `ready: false`; slow worker: the run errors as today                  |
| settle on factors (`SlowRunner.drain` with `factorLive`)           | Stop settling (as today)                  | an `error` answer → `lookbackFailed` → last round (as today)                           | `drop()`                                     | look-back worker: its request times out after `LOOKBACK.timeoutMs` (60 s) → `lookbackFailed` → last round (as for a file today) |
| look-back worker's factor run (`run` in `lookback-worker.ts`)      | -                                         | an error answer per request                                                            | the controller's `reset` at the next session | the worker is gone; the slow side times out (row above)                                                                         |
| the controller's `begun` / `answered` session (`factor-settle.ts`) | -                                         | -                                                                                      | a new session                                | -                                                                                                                               |
| Extract job in the compress worker (`CompressRunner.job`)          | `extract-cancel`                          | an error posts `error` with the job                                                    | `init`/`reset` → `clear()` bumps the epoch   | the worker is gone (main side: row below)                                                                                       |
| Extract job on the main side (`FactorJob.done`)                    | `cancel()` rejects with `cancelled`       | `error` with the job rejects                                                           | the compress store's `reset` rejects         | the client's `onerror` posts an error with session -1, which rejects every job                                                  |
| Extract waiting for `ready` (`pass2-store`, `waiting`)             | Cancel Extract                            | `unusable` → Extract `error` with the reason                                           | `clear()`                                    | via `unusable` (compress error)                                                                                                 |
| the watchdog (`FactorWatchdog`)                                    | -                                         | fires once, marks the factors `unusable`                                               | `reset()` with the session                   | -                                                                                                                               |

## Review Focus

1. **Nothing changes without `?factors`.** `buildSlowLoop` uses the plain constructor unless `lookback` or
   `factorSettle`; `factorSettle` is set only by `factorRunPlan` for a live stream with `?factors`. Pinned: Task 1's
   and Task 6's tests, the unchanged e2e tests, and Task 10's "a stream without ?factors exports format 6 as before".
2. **A pending request always settles.**
   - A settle request: an answer, an error answer, the 60 s timeout, or `cancelRequests` (as today).
   - The factor wait: the five releases in the table. Pinned: Task 7's tests (ready, unusable, Stop), Task 3's watchdog and Task 8's controller; a new run goes
     through `drop()`, which Task 7's code resets.
   - An Extract job: done, error, cancel, reset, crash. Pinned: Task 9's port tests (one per release).
   - `CompressStore.changed()`: resolves at the next status, error or reset. Pinned: Task 3.
3. **The live traces are never replaced.** The back-fill does not run on a factor run (Task 9), and the export adds
   Extract's traces beside the live ones (Task 10).
4. **The settle and Extract rebuild a frame the same way** (`rebuildFrames`, Task 4): the frame as compressed, NaN
   where the window never had a valid sample. Nothing is preprocessed again.
5. **The look-back worker never creates, lists or removes a file.** `factorFiles` takes no `create` option, calls no
   `keys()` and no `removeEntry` (Task 2's test), and reads only windows the compress status lists as compressed.

## File Structure

| File                                                                                                           | Change | Responsibility                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/cala/src/lib/factor-run.ts`                                                                              | create | `factorRunPlan`, `FACTOR_TILING`, the user-facing texts                                                      |
| `apps/cala/src/lib/window-store.ts`                                                                            | modify | Web Lock and `pinned` (port of #440), `folder`, `readAll`, read-only `factorFiles`                           |
| `apps/cala/src/lib/compress-runner.ts`, `workers/compress-types.ts`, `workers/compress-worker.ts`              | modify | status `folder` and `compressed`; the Extract job                                                            |
| `apps/cala/src/lib/compress-store.ts`, `compress-client.ts`                                                    | modify | `factorState`, `factorCoverage`, `factorsBlocked`, `FactorWatchdog`, `changed()`, `fail()`; Extract messages |
| `apps/cala/src/lib/factor-frames.ts`                                                                           | create | `FactorWindowLike`, `rebuildFrames`                                                                          |
| `crates/cala/src/compress/mod.rs`, `compress/js.rs`, `crates/cala/examples/qc_eval.rs`                         | modify | `WindowFactors::never_valid` (moved from qc_eval), `FactorWindow.neverValid`                                 |
| `apps/cala/src/lib/factor-reader.ts`                                                                           | create | `FactorReader`: rebuild and solve the settle's frames                                                        |
| `apps/cala/src/workers/lookback-worker.ts`, `lookback-types.ts`, `lib/lookback-client.ts`                      | modify | a factor source; `beginFactors`                                                                              |
| `apps/cala/src/lib/slow-runner.ts`, `workers/slow-types.ts`, `slow-worker.ts`, `lib/slow-client.ts`            | modify | `FACTOR_SETTLE`, `buildSlowLoop`, `SlowInit.factorSettle`, the factor wait and settle, `factors` message     |
| `apps/cala/src/lib/fast-loop.ts`, `workers/frame-types.ts`, `trace-worker.ts`, `frame-worker.ts`               | modify | pass `factorSettle` and the compress tiling through                                                          |
| `crates/cala/src/discover/tests.rs`                                                                            | modify | pin: `refine` leaves Discover unchanged                                                                      |
| `apps/cala/src/lib/factor-settle.ts`                                                                           | create | the main-thread controller (`factorSettleAction`)                                                            |
| `apps/cala/src/lib/factor-extract.ts`                                                                          | create | `createFactorExtract`: the Extract port over the compress store and client                                   |
| `apps/cala/src/lib/pass2-store.ts`, `run-stages.ts`, `pipeline-store.ts`, `App.tsx`                            | modify | Extract on factors, availability, wiring                                                                     |
| `apps/cala/src/lib/export.ts`, `live-export.ts`                                                                | modify | `traces_live`, stage sources, notes, version 6/7, the tail                                                   |
| `apps/cala/src/components/RunPanel.tsx`, `lib/step-view.ts`, `lib/lookback-text.ts`                            | modify | texts and buttons for a `?factors` stream                                                                    |
| `apps/cala/src/__tests__/*.test.ts`                                                                            | modify | tests per task (named in each task)                                                                          |
| `apps/cala/src/__tests__/synth-avi.ts`                                                                         | modify | `cellMovie` (port of #442)                                                                                   |
| `e2e/cala-live.spec.ts`                                                                                        | modify | a `?factors` stream settles, extracts and exports both trace sets                                            |
| `apps/cala/scripts/live-measure.mjs`                                                                           | modify | `--query`, `--frames`, the factor metrics                                                                    |
| `tools/cala-eval/results/2026-11-2x-factors-live-speed.md`                                                     | create | the speed report (date of the run)                                                                           |
| `apps/cala/docs/stages.md`, `apps/cala/README.md`, `apps/cala/USER_GUIDE.md` (if present), `docs/CHANGELOG.md` | modify | docs                                                                                                         |

---

### Task 1: `?factors` turns on a factor run for a live stream

**Files:** create `apps/cala/src/lib/factor-run.ts`, `apps/cala/src/__tests__/factor-run.test.ts`; modify `App.tsx`
(params block near `App.tsx:139-170`), `lib/pipeline-store.ts` (`start`, near `pipeline-store.ts:1057-1090`; the
returned object), `workers/frame-types.ts` (`CellsSettings`), `workers/trace-worker.ts:86` and
`workers/frame-worker.ts:273` (the `CompressFeed` options).

**Interfaces:**

- `const FACTOR_TILING: CompressTiling = 'offset'`
- `interface FactorRunPlan { compress: CompressTiling | null; factorSettle: boolean }`
- `function factorRunPlan(o: { live: boolean; factors: boolean; compress: boolean; discover: boolean }): FactorRunPlan`
- `CellsSettings.compressTiling?: CompressTiling`, `CellsSettings.factorSettle?: boolean`
- `pipeline.setFactors(on: boolean)`, `pipeline.factorRun(): boolean`
- `const FACTORS_REVIEW_OFF: string`

- [ ] **Step 1: Failing test** (`factor-run.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { FACTOR_TILING, factorRunPlan } from '../lib/factor-run.ts';

describe('factorRunPlan', () => {
  const base = { live: false, factors: false, compress: false, discover: true };
  it('a live stream with ?factors compresses on the offset grids and settles on its factors', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: true,
    });
    expect(FACTOR_TILING).toBe('offset');
  });
  it('a recording with ?factors is a ?compress run (plain tiles, no factor settle)', () => {
    expect(factorRunPlan({ ...base, factors: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
    expect(factorRunPlan({ ...base, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
  it('a stream without ?factors is as today, with or without ?compress', () => {
    expect(factorRunPlan({ ...base, live: true })).toEqual({ compress: null, factorSettle: false });
    expect(factorRunPlan({ ...base, live: true, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
  it('a stream run without Discover has nothing to settle', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true, discover: false })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
});
```

- [ ] **Step 2: Run it; expect a failure** (no `factor-run.ts`).
- [ ] **Step 3: Implement** `factor-run.ts`:

```ts
/**
 * `?factors` (experimental; slice 2 of
 * docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md): a
 * live stream's Final settle and Extract read the factors Discover wrote
 * during the stream. A recording with `?factors` is a `?compress` run until
 * slice 3.
 */
import type { CompressTiling } from '../workers/compress-types.ts';

/** The tiling a factor run compresses on (two offset grids: no tile-line jump). */
export const FACTOR_TILING: CompressTiling = 'offset';

/** What the page's switches mean for one run. */
export interface FactorRunPlan {
  /** Compress the run's frames, on this tiling (null: no compression). */
  compress: CompressTiling | null;
  /** The slow loop settles on the factors after the stream ends (`SlowInit.factorSettle`). */
  factorSettle: boolean;
}

export function factorRunPlan(o: {
  live: boolean;
  factors: boolean;
  compress: boolean;
  discover: boolean;
}): FactorRunPlan {
  if (o.factors && o.live && o.discover) return { compress: FACTOR_TILING, factorSettle: true };
  if (o.factors || o.compress) return { compress: 'plain', factorSettle: false };
  return { compress: null, factorSettle: false };
}

export const FACTORS_REVIEW_OFF =
  'cala: ?review is off with ?factors (the history review reads plain tiles only; a stream with ?factors compresses on offset grids).';
```

`CellsSettings` (frame-types.ts), after `compress?: boolean`:

```ts
  /** With `compress`: how the frames are cut into tiles (default plain). */
  compressTiling?: CompressTiling;
  /** A live stream with `?factors`: the slow loop settles on the factors after the stream ends (`SlowInit.factorSettle`). */
  factorSettle?: boolean;
```

In both `CompressFeed` constructions (trace-worker.ts and frame-worker.ts), add the tiling:

```ts
              {
                width: setup.width,
                height: setup.height,
                session: cells.session,
                ...(cells.compressTiling ? { tiling: cells.compressTiling } : {}),
              },
```

In `pipeline-store.ts`: a signal `const [factors, setFactors] = createSignal(false)` and
`const [factorRun, setFactorRun] = createSignal(false)`; `reset()` sets `setFactorRun(false)`. In `start()`, before
`client.startPipeline`:

```ts
const runPlan = factorRunPlan({
  live: flat.identity?.()?.live === true,
  factors: factors(),
  compress: compress !== undefined,
  discover: discover(),
});
setFactorRun(runPlan.factorSettle);
```

and in the cells settings replace `...(compress ? { compress: true } : {})` by:

```ts
          ...(runPlan.compress
            ? {
                compress: true,
                ...(runPlan.compress !== 'plain' ? { compressTiling: runPlan.compress } : {}),
              }
            : {}),
          ...(runPlan.factorSettle ? { factorSettle: true } : {}),
          ...(runPlan.factorSettle && FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction < 1
            ? { settleFraction: FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction }
            : {}),
```

(The plain case sends exactly `{ compress: true }` as before.) `runLevel` is set from the level for a factor run too:
`runLevel = lb || runPlan.factorSettle ? finalSettleLevelSig() : FINAL_SETTLE_LEVEL_DEFAULT;` (move the line below
`runPlan`). Return `setFactors` and `factorRun` from the store.

In `App.tsx`:

```ts
// `?factors` (experimental): a live stream settles and extracts on the factors Discover
// writes; it turns compression on by itself. A recording runs as with `?compress`.
const factors = params.has('factors');
const compressOn = params.has('compress') || factors;
if (factors && params.has('review')) console.warn(FACTORS_REVIEW_OFF);
const reviewWindows = params.has('compress') && !factors ? reviewEvery(params.get('review')) : null;
```

and `const compress = compressOn ? createCompressStore(cells) : undefined;`, then after the pipeline store is built:
`if (factors) pipeline.setFactors(true);`.

- [ ] **Step 4: Run the app checks.** Expected: pass. (The wiring is exercised by Task 12's e2e; no store test.)
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): ?factors makes a live stream a factor run, compressed on the offset grids"
```

---

### Task 2: OPFS run folders: Web Lock, `pinned`, the folder name and a read-only reader

**Files:** modify `apps/cala/src/lib/window-store.ts`; create `apps/cala/src/__tests__/window-store.test.ts` (port);
modify `lib/compress-runner.ts` (`post`), `workers/compress-types.ts` (`CompressStatus`).

**Interfaces:**

- From #440 (`origin/feat/cala-factor-app:apps/cala/src/lib/window-store.ts`), unchanged: `COMPRESS_ROOT`, `pinned`,
  `isPinned`, `Locks`, `opfsStore(run, top, locks)`.
- New: `WindowStore.folder: string`; `WindowStore.readAll(name: string): Promise<Uint8Array>`.
- New: `interface FactorFiles { read(name: string): Promise<Uint8Array> }`;
  `function factorFiles(folder: string, top?: () => Promise<unknown>): FactorFiles`.
- `interface CompressedWindow { index: number; start: number; frames: number }`;
  `CompressStatus.folder: string`; `CompressStatus.compressed: CompressedWindow[]`.

- [ ] **Step 1: Port.** `git show origin/feat/cala-factor-app:apps/cala/src/lib/window-store.ts` and
      `git show origin/feat/cala-factor-app:apps/cala/src/__tests__/window-store.test.ts` into place (redirect each into
      its file from a scratch script). Diff the store against `main`'s first: only the lock, `pinned` and the injected
      `top`/`locks` may differ. Run the ported test: it passes (its features come with it).
- [ ] **Step 2: Failing tests** (append to `window-store.test.ts`; reuse the file's fake directory if it has one,
      else this one):

```ts
/** A fake OPFS directory tree that records every call. */
function fakeTree(files: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const file = (name: string) => ({
    getFile: async () => {
      calls.push(`getFile ${name}`);
      const b = files[name];
      if (!b) throw new DOMException('missing', 'NotFoundError');
      return new Blob([b]);
    },
    createSyncAccessHandle: async () => {
      calls.push(`sah ${name}`);
      throw new Error('a reader never opens an access handle');
    },
  });
  const dir = (path: string): unknown => ({
    getDirectoryHandle: async (n: string, o?: { create?: boolean }) => {
      calls.push(`dir ${path}/${n}${o?.create ? ' create' : ''}`);
      return dir(`${path}/${n}`);
    },
    getFileHandle: async (n: string, o?: { create?: boolean }) => {
      calls.push(`file ${n}${o?.create ? ' create' : ''}`);
      return file(n);
    },
    removeEntry: async (n: string) => void calls.push(`remove ${n}`),
    keys: () => {
      calls.push(`keys ${path}`);
      return (async function* () {})();
    },
  });
  return { top: async () => dir(''), calls };
}

describe('factorFiles', () => {
  it('reads a whole file through getFile and never creates, lists or removes', async () => {
    const t = fakeTree({ 'f0.bin': Uint8Array.of(1, 2, 3) });
    const r = factorFiles('run-a', t.top);
    expect([...(await r.read('f0.bin'))]).toEqual([1, 2, 3]);
    expect(t.calls).toEqual([
      `dir /${COMPRESS_ROOT}`,
      `dir /${COMPRESS_ROOT}/run-a`,
      'file f0.bin',
      'getFile f0.bin',
    ]);
    expect(t.calls.some((c) => /create|keys|remove|sah/.test(c))).toBe(false);
  });
  it('a missing file rejects with its name; the next read tries again', async () => {
    const t = fakeTree({});
    const r = factorFiles('run-a', t.top);
    await expect(r.read('f9.bin')).rejects.toThrow('f9.bin');
  });
});

describe('the store names its folder and reads whole files', () => {
  it('memory store', async () => {
    const s = memoryStore();
    const f = await s.open('f0.bin');
    f.write(Uint8Array.of(4, 5), 0);
    f.close();
    expect(s.folder).toBe('memory');
    expect([...(await s.readAll('f0.bin'))]).toEqual([4, 5]);
  });
});
```

- [ ] **Step 3: Run; expect failures** (`factorFiles`, `folder`, `readAll` do not exist).
- [ ] **Step 4: Implement** in `window-store.ts`:

```ts
export interface WindowStore {
  /** The run folder's name under `COMPRESS_ROOT` (another worker reads it with `factorFiles`). */
  readonly folder: string;
  /** Open `name` for reading and writing, creating it when missing. */
  open(name: string): Promise<StoreFile>;
  /** The whole file `name`, without an access handle (no lock against another reader). */
  readAll(name: string): Promise<Uint8Array>;
  remove(name: string): Promise<void>;
  /** Remove every file of this run. */
  clear(): Promise<void>;
}

/** The parts of a read-only OPFS walk (no `create`, no listing, no removal). */
interface ReadFileHandle {
  getFile(): Promise<Blob>;
}
interface ReadDirHandle {
  getDirectoryHandle(name: string): Promise<ReadDirHandle>;
  getFileHandle(name: string): Promise<ReadFileHandle>;
}

/** Read-only access to a run folder another context writes (the look-back worker reading the factors). */
export interface FactorFiles {
  read(name: string): Promise<Uint8Array>;
}

/**
 * Files of the run folder `folder`, read whole through `getFile()`: no
 * access handle, so no lock against the compress worker, and no `create`,
 * listing or removal. Read only files the compress worker reported done.
 */
export function factorFiles(
  folder: string,
  top: () => Promise<unknown> = () => navigator.storage.getDirectory(),
): FactorFiles {
  let dir: Promise<ReadDirHandle> | null = null;
  const directory = (): Promise<ReadDirHandle> =>
    (dir ??= (async () => {
      const origin = (await top()) as ReadDirHandle;
      const root = await pinned(origin, (o) => o.getDirectoryHandle(COMPRESS_ROOT));
      return pinned(root, (r) => r.getDirectoryHandle(folder));
    })().catch((err: unknown) => {
      dir = null;
      throw err;
    }));
  return {
    async read(name) {
      try {
        const d = await directory();
        const fh = await pinned(d, (x) => x.getFileHandle(name));
        const file = await pinned(fh, (f) => f.getFile());
        return new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        throw new Error(
          `${folder}/${name} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
```

In `opfsStore`: return `folder: run` and

```ts
    async readAll(name) {
      const d = await directory();
      const fh = (await d.getFileHandle(name)) as unknown as ReadFileHandle;
      const file = await pinned(fh, (f) => f.getFile());
      return new Uint8Array(await file.arrayBuffer());
    },
```

(`FileHandle` gains `getFile(): Promise<Blob>` in the local interface.) In `memoryStore`: `folder: 'memory'` and
`readAll: async (name) => (files.get(name) ?? new Uint8Array(0)).slice()`.

In `compress-types.ts`:

```ts
/** A compressed window: its factor file `f<index>.bin` holds stream frames `start..start + frames`. */
export interface CompressedWindow {
  index: number;
  start: number;
  frames: number;
}
```

and in `CompressStatus`:

```ts
  /** The OPFS run folder of the factor files (`WindowStore.folder`). */
  folder: string;
  /** The compressed windows, in stream order. */
  compressed: CompressedWindow[];
```

In `CompressRunner`: `done` becomes `CompressedWindow[]` (push `{ index: job.index, start: job.start, frames:
job.frames }`; `runBackfill` iterates `this.done.map((w) => w.index)`; `feedReview` reads `this.done.length`), and
`post()` adds `folder: this.deps.store.folder, compressed: this.done.map((w) => ({ ...w }))`.

- [ ] **Step 5: Run the app checks.** Expected: pass.
- [ ] **Step 6: Commit:**

```bash
git commit -m "feat(cala): compression run folders hold a Web Lock, name their folder and can be read without a lock"
```

---

### Task 3: The factor state of a live run, and a watchdog

**Files:** modify `apps/cala/src/lib/compress-store.ts`; test `apps/cala/src/__tests__/compress-store.test.ts`
(create if absent).

**Interfaces:**

- `type FactorState = 'none' | 'compressing' | 'ready' | 'unusable'`
- `function factorCoverage(windows: readonly CompressedWindow[]): { frames: number; gap: number | null }`
- `function factorState(s: CompressStatus | null, error: string | null, ended: boolean, frames: number): FactorState`
- `function factorsBlocked(state: FactorState, s: CompressStatus | null, error: string | null): string | null`
- `interface FactorInfo { folder: string; tiling: CompressTiling; windows: CompressedWindow[]; frames: number; meanRank: number }`
- `const FACTOR_STALL_MS = 120_000`; `class FactorWatchdog { note(s, now); stalled(now): boolean; reset() }`
- store: `factors(ended: boolean, frames: number): FactorState`, `factorInfo(): FactorInfo | null`,
  `fail(message: string): void`, `changed(): Promise<void>`, `onExtract?: (msg) => void` (Task 9 uses it).

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from 'vitest';
import {
  createCompressStore,
  FACTOR_STALL_MS,
  factorCoverage,
  factorState,
  factorsBlocked,
  FactorWatchdog,
} from '../lib/compress-store.ts';
import type { CompressStatus } from '../workers/compress-types.ts';

const W = (index: number, start: number, frames: number) => ({ index, start, frames });
function st(o: Partial<CompressStatus> = {}): CompressStatus {
  return {
    windows: 2,
    frames: 1200,
    pending: 0,
    pendingFrames: 0,
    meanRank: 5,
    msPerFrame: 1,
    factorBytes: 10,
    final: true,
    tiling: 'offset',
    source: 'discover',
    folder: 'run-a',
    compressed: [W(0, 0, 600), W(1, 600, 600)],
    ...o,
  };
}

describe('factorCoverage', () => {
  it('counts the frames covered from 0 and finds the first gap', () => {
    expect(factorCoverage([W(1, 600, 600), W(0, 0, 600)])).toEqual({ frames: 1200, gap: null });
    expect(factorCoverage([W(0, 0, 600), W(1, 700, 600)])).toEqual({ frames: 600, gap: 600 });
    expect(factorCoverage([])).toEqual({ frames: 0, gap: null });
  });
});

describe('factorState (a live run with ?factors)', () => {
  it('ready once the stream ended and every window of the offset grids is compressed', () => {
    expect(factorState(st(), null, true, 1200)).toBe('ready');
  });
  it('ready with a last window of one frame left out (it cannot be compressed)', () => {
    expect(factorState(st(), null, true, 1201)).toBe('ready');
  });
  it('compressing before the end, while windows wait, or before the first status', () => {
    expect(factorState(st(), null, false, 1200)).toBe('compressing');
    expect(factorState(st({ pending: 1, final: false }), null, true, 1800)).toBe('compressing');
    expect(factorState(null, null, true, 1200)).toBe('compressing');
  });
  it('unusable after an error, with a gap, with more than one frame missing, or on plain tiles', () => {
    expect(factorState(st(), 'quota', true, 1200)).toBe('unusable');
    expect(factorState(st({ compressed: [W(0, 0, 600), W(2, 700, 600)] }), null, true, 1300)).toBe(
      'unusable',
    );
    expect(factorState(st(), null, true, 1202)).toBe('unusable');
    expect(factorState(st({ tiling: 'plain' }), null, true, 1200)).toBe('unusable');
    expect(factorState(st({ compressed: [], windows: 0, frames: 0 }), null, true, 1)).toBe(
      'unusable',
    );
  });
  it('says why', () => {
    expect(factorsBlocked('ready', st(), null)).toBeNull();
    expect(factorsBlocked('compressing', st({ pending: 2 }), null)).toBe(
      'Waiting for the last windows to be compressed (2 waiting).',
    );
    expect(factorsBlocked('unusable', st(), 'quota exceeded')).toBe(
      'The factors cannot be read: quota exceeded',
    );
    expect(factorsBlocked('unusable', st(), null)).toBe('The factors do not cover the stream.');
  });
});

describe('FactorWatchdog', () => {
  it('fires after FACTOR_STALL_MS without a change in the compressor, and not before', () => {
    const w = new FactorWatchdog();
    w.note(st({ pending: 2, final: false }), 0);
    expect(w.stalled(FACTOR_STALL_MS - 1)).toBe(false);
    w.note(st({ pending: 1, final: false }), 60_000);
    expect(w.stalled(60_000 + FACTOR_STALL_MS - 1)).toBe(false);
    expect(w.stalled(60_000 + FACTOR_STALL_MS)).toBe(true);
    w.reset();
    expect(w.stalled(10 * FACTOR_STALL_MS)).toBe(false);
  });
});

describe('the store', () => {
  it('changed() resolves at the next status, error or reset', async () => {
    const s = createCompressStore();
    s.reset(3);
    const a = s.changed();
    s.onMessage({ type: 'status', session: 3, status: st() });
    await a;
    const b = s.changed();
    s.onMessage({ type: 'error', session: -1, message: 'crashed' });
    await b;
    const c = s.changed();
    s.reset(4);
    await c;
  });
  it('fail() makes the factors unusable with the reason', () => {
    const s = createCompressStore();
    s.reset(3);
    s.onMessage({ type: 'status', session: 3, status: st() });
    s.fail('The compressor made no progress for 120 s.');
    expect(s.factors(true, 1200)).toBe('unusable');
    expect(s.factorInfo()).toEqual({
      folder: 'run-a',
      tiling: 'offset',
      windows: st().compressed,
      frames: 1200,
      meanRank: 5,
    });
  });
});
```

- [ ] **Step 2: Run; expect failures** (missing exports).
- [ ] **Step 3: Implement** in `compress-store.ts`:

```ts
/** A live run's factors (`?factors`; spec decision 4). */
export type FactorState = 'none' | 'compressing' | 'ready' | 'unusable';

/** What Extract and the settle read: the run folder and its windows. */
export interface FactorInfo {
  folder: string;
  tiling: CompressTiling;
  windows: CompressedWindow[];
  /** Frames the windows cover from frame 0. */
  frames: number;
  meanRank: number;
}

/** The frames the windows cover from frame 0, and the first frame missing between two (null: none). */
export function factorCoverage(windows: readonly CompressedWindow[]): {
  frames: number;
  gap: number | null;
} {
  let end = 0;
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    if (w.start !== end) return { frames: end, gap: end };
    end += w.frames;
  }
  return { frames: end, gap: null };
}

/**
 * The factors of a live run with `?factors`, whose `frames` frames Discover
 * read: `ready` once the stream ended, no window waits, they are on the
 * offset grids and cover frames 0.. without a gap, all but at most the last
 * (a window of one frame cannot be compressed); `unusable` after a
 * compression error or when they do not; `compressing` before.
 */
export function factorState(
  s: CompressStatus | null,
  error: string | null,
  ended: boolean,
  frames: number,
): FactorState {
  if (error) return 'unusable';
  if (!ended || !s || !s.final || s.pending > 0) return 'compressing';
  if (s.tiling !== FACTOR_TILING) return 'unusable';
  const c = factorCoverage(s.compressed);
  return c.gap === null && c.frames >= 2 && c.frames <= frames && c.frames >= frames - 1
    ? 'ready'
    : 'unusable';
}

export function factorsBlocked(
  state: FactorState,
  s: CompressStatus | null,
  error: string | null,
): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'compressing':
      return `Waiting for the last windows to be compressed${s && s.pending > 0 ? ` (${s.pending} waiting)` : ''}.`;
    case 'unusable':
      return error
        ? `The factors cannot be read: ${error}`
        : 'The factors do not cover the stream.';
    default:
      return 'This run has no factors.';
  }
}

/** The factors' wait gives up after this long without a change in the compressor. */
export const FACTOR_STALL_MS = 120_000;

/** Notices a compressor that stopped (a lost OPFS open never settles; see `pinned`). */
export class FactorWatchdog {
  private key = '';
  private since = 0;
  constructor(private readonly stallMs = FACTOR_STALL_MS) {}
  note(s: CompressStatus | null, now: number): void {
    const key = s ? `${s.windows}/${s.pending}/${s.final}` : '-';
    if (key !== this.key || this.since === 0) {
      this.key = key;
      this.since = now;
    }
  }
  stalled(now: number): boolean {
    return this.since !== 0 && now - this.since >= this.stallMs;
  }
  reset(): void {
    this.key = '';
    this.since = 0;
  }
}
```

(`FACTOR_TILING` from `factor-run.ts`; `CompressTiling`, `CompressedWindow` from compress-types.) In the store: a
`waiters: (() => void)[]` list; `const wake = () => { for (const w of waiters.splice(0)) w(); }`, called at the end of
`reset`, on every `error` and every own-session `status`; `changed: () => new Promise<void>((r) => waiters.push(r))`;
`fail(message) { setError(message); wake(); }`; `factors(ended, frames) { return factorState(status(), error(),
ended, frames); }`; `factorInfo()` returns null without a status, else `{ folder, tiling, windows: compressed, frames:
factorCoverage(compressed).frames, meanRank }`. `onExtract` is a settable field: messages of type `extracted` and
`extract-done`, and `error` messages that carry a `job`, go to it (Task 9 adds the types).

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): a live run's factor state, its coverage and a watchdog on the compressor"
```

---

### Task 4: One rebuild for the settle and Extract: NaN where a window never had a valid sample

**Files:** modify `crates/cala/src/compress/mod.rs` (`impl WindowFactors`, its tests), `crates/cala/src/compress/js.rs`
(`JsFactorWindow`), `crates/cala/examples/qc_eval.rs` (`never_valid` and its callers); create
`apps/cala/src/lib/factor-frames.ts`, `apps/cala/src/__tests__/factor-frames.test.ts`; modify `lib/compress-runner.ts`
(import `FactorWindowLike` from the new module).

**Interfaces:**

- Rust: `WindowFactors::never_valid(&self) -> Vec<bool>`; WASM `FactorWindow.neverValid(): Uint8Array` (1 = never valid).
- TS: `interface FactorWindowLike { frames; start; reconstruct(t0, count, out); neverValid?(): Uint8Array; free() }`
  (moved from compress-runner.ts and re-exported there);
  `function rebuildFrames(w: FactorWindowLike, never: Uint8Array | null, t0: number, count: number, out: Float32Array): void`.

- [ ] **Step 1: Failing Rust test** (in the `compress` module's tests, with the imports the other tests there use):

```rust
    #[test]
    fn never_valid_marks_pixels_without_a_valid_sample_in_the_window() {
        let dims = Dims::new(96, 80).unwrap();
        let cfg = CompressConfig {
            window: 50,
            tiling: Tiling::Offset,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims, cfg);
        let mut done = None;
        for t in 0..50 {
            let mut fr: Vec<f32> = (0..dims.pixels()).map(|p| 20.0 + ((p + t) % 7) as f32).collect();
            fr[5] = f32::NAN; // never valid
            if t < 25 {
                fr[9] = f32::NAN; // valid in the second half
            }
            if let Some(w) = wc.push(&fr) {
                done = Some(w);
            }
        }
        let wf = done.or_else(|| wc.flush()).unwrap();
        let never = wf.never_valid();
        assert!(never[5]);
        assert!(!never[9]);
        assert_eq!(never.iter().filter(|&&n| n).count(), 1);
    }
```

- [ ] **Step 2: Run it; expect a compile failure** (no `never_valid`).
- [ ] **Step 3: Implement.** Move qc_eval's `fn never_valid(wf: &WindowFactors) -> Vec<bool>` body (slice 1, Task 3)
      into `impl WindowFactors` as `pub fn never_valid(&self) -> Vec<bool>` with `wf` → `self` and its doc comment;
      qc_eval's callers use `wf.never_valid()` and the free function goes. In `js.rs`:

```rust
    /// 1 for each pixel with no valid sample in any frame of the window (a
    /// rebuilt frame reads its window mean there; the live frame had NaN).
    #[wasm_bindgen(js_name = neverValid)]
    pub fn never_valid(&self) -> Vec<u8> {
        self.inner.never_valid().into_iter().map(u8::from).collect()
    }
```

- [ ] **Step 4: Run the Rust checks** (Global Constraints) and `npm run test -w apps/cala` (rebuilds the WASM).
      Expected: pass.
- [ ] **Step 5: Failing TS test** (`factor-frames.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { rebuildFrames, type FactorWindowLike } from '../lib/factor-frames.ts';

function fakeWindow(px: number, frames: number): FactorWindowLike & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    frames,
    start: 600,
    calls,
    reconstruct(t0, count, out) {
      calls.push([t0, count]);
      for (let k = 0; k < count; k++)
        for (let p = 0; p < px; p++) out[k * px + p] = 100 * (t0 + k) + p;
    },
    neverValid: () => Uint8Array.of(0, 1, 0, 0),
    free() {},
  };
}

describe('rebuildFrames', () => {
  it('rebuilds the frames and puts NaN where the window never had a valid sample', () => {
    const w = fakeWindow(4, 10);
    const out = new Float32Array(8);
    rebuildFrames(w, w.neverValid!(), 3, 2, out);
    expect(w.calls).toEqual([[3, 2]]);
    expect([...out]).toEqual([300, NaN, 302, 303, 400, NaN, 402, 403]);
  });
  it('without a mask the rebuilt frames stay as they are', () => {
    const w = fakeWindow(4, 10);
    const out = new Float32Array(4);
    rebuildFrames(w, null, 0, 1, out);
    expect([...out]).toEqual([0, 1, 2, 3]);
  });
});
```

- [ ] **Step 6: Run; expect a failure** (no module).
- [ ] **Step 7: Implement** `factor-frames.ts`:

```ts
/**
 * Frames rebuilt from a factor window (`FactorWindow`), the same way for the
 * Final settle on factors (look-back worker) and Extract on factors (compress
 * worker): the frame as compressed, NaN where no frame of the window had a
 * valid sample (the live frame had NaN there). Nothing is preprocessed again.
 */

/** A compressed window read back from its factor file (the WASM `FactorWindow`, or a fake). */
export interface FactorWindowLike {
  readonly frames: number;
  /** Stream index of the first frame. */
  readonly start: number;
  reconstruct(t0: number, count: number, out: Float32Array): void;
  /** 1 per pixel never valid in the window (absent in older builds: nothing is marked). */
  neverValid?(): Uint8Array;
  free(): void;
}

/** Frames `t0..t0 + count` of `w` into `out`, NaN on the pixels `never` marks. */
export function rebuildFrames(
  w: FactorWindowLike,
  never: Uint8Array | null,
  t0: number,
  count: number,
  out: Float32Array,
): void {
  w.reconstruct(t0, count, out);
  if (!never) return;
  const px = never.length;
  const marked: number[] = [];
  for (let p = 0; p < px; p++) if (never[p]) marked.push(p);
  for (let k = 0; k < count; k++) for (const p of marked) out[k * px + p] = NaN;
}
```

In `compress-runner.ts`, remove the local `FactorWindowLike` and `export type { FactorWindowLike } from
'./factor-frames.ts'`; `runBackfill` keeps calling `window.reconstruct` (the back-fill is unchanged).

- [ ] **Step 8: Run the app checks.** Expected: pass.
- [ ] **Step 9: Commit:**

```bash
git commit -m "feat(cala): a rebuilt factor frame is NaN where its window never had a valid sample"
```

---

### Task 5: Look-back worker 0 can serve the settle from the factors

**Files:** create `apps/cala/src/lib/factor-reader.ts`, `apps/cala/src/__tests__/factor-reader.test.ts`; modify
`workers/lookback-types.ts`, `workers/lookback-worker.ts`, `lib/lookback-client.ts`,
`__tests__/lookback-client.test.ts`.

**Interfaces:**

- `type FactorSource = { factors: { folder: string; windows: CompressedWindow[]; width: number; height: number } }`;
  `MainToLookback` `begin.source: LookbackSource | FactorSource`.
- `interface FrameServer { setLibrary(version, bytes): void; serve(frames, out, skip?): Promise<LookbackSolved>; dispose(): void }`
  (`LookbackReader` already fits).
- `interface FactorSolver { readonly cells: number; processFrames(y: Float32Array, n: number): Float32Array; lastBackground(): Float32Array; free(): void }`
- `class FactorReader implements FrameServer`:
  `constructor(files: FactorFiles, windows: CompressedWindow[], px: number, deps: { open(bytes: Uint8Array): FactorWindowLike; solver(library: Uint8Array): FactorSolver })`;
  `reads: number`.
- `const FACTOR_CACHE = 2`.
- `LookbackFeed.beginFactors?(session: number, factors: FactorSource['factors']): void`.

- [ ] **Step 1: Failing tests** (`factor-reader.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { FACTOR_CACHE, FactorReader, type FactorSolver } from '../lib/factor-reader.ts';
import type { FactorWindowLike } from '../lib/factor-frames.ts';

const PX = 3;
/** Window files whose byte 0 is the window index; window i holds frames 100*i.. (10 frames). */
function setup() {
  const reads: string[] = [];
  const files = {
    read: vi.fn(async (name: string) => {
      reads.push(name);
      return Uint8Array.of(Number(name.slice(1, -4)));
    }),
  };
  const windows = [0, 1, 2].map((i) => ({ index: i, start: 10 * i, frames: 10 }));
  const freed: number[] = [];
  const open = (bytes: Uint8Array): FactorWindowLike => {
    const i = bytes[0];
    return {
      start: 10 * i,
      frames: 10,
      reconstruct(t0, n, out) {
        for (let k = 0; k < n; k++) for (let p = 0; p < PX; p++) out[k * PX + p] = 10 * i + t0 + k;
      },
      neverValid: () => Uint8Array.of(0, 0, 1),
      free: () => void freed.push(i),
    };
  };
  const solver = (lib: Uint8Array): FactorSolver => ({
    cells: 1,
    processFrames: (y) => Float32Array.of(y[0] + 1000 * lib[0]),
    lastBackground: () => Float32Array.of(0.5),
    free: vi.fn(),
  });
  const r = new FactorReader(files, windows, PX, { open, solver });
  return { r, reads, freed };
}
const F = (frame: number) => ({ frame, block: -1 });

describe('FactorReader', () => {
  it('rebuilds the asked frames (NaN where never valid) and solves them with the newest library', async () => {
    const t = setup();
    t.r.setLibrary(4, Uint8Array.of(4));
    const out = new Float32Array(2 * PX);
    const s = await t.r.serve([F(3), F(12)], out);
    expect([...out]).toEqual([3, 3, NaN, 12, 12, NaN]);
    expect(s.version).toBe(4);
    expect([...s.traces]).toEqual([4003, 4012]);
    expect([...s.background!]).toEqual([0.5, 0.5]);
  });
  it('before a library it rebuilds but solves nothing (version 0)', async () => {
    const t = setup();
    const s = await t.r.serve([F(0)], new Float32Array(PX));
    expect(s.version).toBe(0);
    expect(s.traces).toHaveLength(0);
  });
  it('reads each window once while cached, and frees what leaves the cache', async () => {
    const t = setup();
    const out = new Float32Array(PX);
    for (const f of [0, 1, 11, 2, 21, 3]) await t.r.serve([F(f)], out);
    expect(t.reads).toEqual(['f0.bin', 'f1.bin', 'f2.bin', 'f0.bin']);
    expect(FACTOR_CACHE).toBe(2);
    expect(t.freed).toEqual([0, 1]);
  });
  it('a held-out frame (skip) is rebuilt but not solved', async () => {
    const t = setup();
    t.r.setLibrary(1, Uint8Array.of(1));
    const s = await t.r.serve([F(0), F(1)], new Float32Array(2 * PX), Uint8Array.of(0, 1));
    expect([...s.traces]).toEqual([1000, 0]);
  });
  it('refuses a frame no compressed window holds, and a file that is not the window listed', async () => {
    const t = setup();
    await expect(t.r.serve([F(30)], new Float32Array(PX))).rejects.toThrow('frame 30');
    const bad = new FactorReader(
      { read: async () => Uint8Array.of(2) },
      [{ index: 0, start: 0, frames: 10 }],
      PX,
      {
        open: (b) => ({ start: 10 * b[0], frames: 10, reconstruct() {}, free() {} }),
        solver: () => {
          throw new Error();
        },
      },
    );
    await expect(bad.serve([F(0)], new Float32Array(PX))).rejects.toThrow('f0.bin');
  });
  it('after dispose a serve fails with "look-back stopped"', async () => {
    const t = setup();
    t.r.dispose();
    await expect(t.r.serve([F(0)], new Float32Array(PX))).rejects.toThrow('look-back stopped');
  });
});
```

and in `lookback-client.test.ts` (with its fake workers and channel):

```ts
it('beginFactors starts worker 0 on the factors, connects it once and never starts a pool', () => {
  // (build the client as the file's other tests do, with pool: 2)
  const factors = {
    folder: 'run-a',
    windows: [{ index: 0, start: 0, frames: 600 }],
    width: 4,
    height: 3,
  };
  c.beginFactors!(7, factors);
  expect(workers).toHaveLength(1);
  expect(workers[0].posted.at(-1)).toEqual({ type: 'begin', session: 7, source: { factors } });
  expect(slow.connectLookback).toHaveBeenCalledTimes(1);
  expect(c.startPool!(7)).toBe(0);
  c.reset(7);
  expect(workers[0].posted.at(-1)).toEqual({ type: 'reset', session: 7 });
});
```

(Adapt the names `workers`, `posted`, `slow` to the file's fakes; keep the assertions.)

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement** `factor-reader.ts`:

```ts
/**
 * The Final settle's frame supply on a live stream with `?factors` (look-back
 * worker 0; spec decision 2): the frames the slow loop asks for, rebuilt
 * from the factor windows Discover wrote (`rebuildFrames`) and solved with
 * the newest published library, as `LookbackReader` does for a recording.
 * It reads only windows the compress worker reported done, whole, through
 * `FactorFiles` (no lock, no create, list or removal).
 */
import { factorName } from './compress-runner.ts';
import { rebuildFrames, type FactorWindowLike } from './factor-frames.ts';
import type { LookbackFrame, LookbackSolved } from './lookback-reader.ts';
import type { FactorFiles } from './window-store.ts';
import type { CompressedWindow } from '../workers/compress-types.ts';
import type { LookbackTiming } from './work-meter.ts';

/** What the look-back worker serves requests with (`LookbackReader` or `FactorReader`). */
export interface FrameServer {
  setLibrary(version: number, bytes: Uint8Array): void;
  serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved>;
  dispose(): void;
}

/** A trace solver on one library (the WASM `TraceEngine`, or a fake). */
export interface FactorSolver {
  readonly cells: number;
  processFrames(y: Float32Array, n: number): Float32Array;
  lastBackground(): Float32Array;
  free(): void;
}

/** Windows kept decoded: the settle reads in plan order, so the current and the next are enough. */
export const FACTOR_CACHE = 2;

interface Cached {
  start: number;
  frames: number;
  win: FactorWindowLike;
  never: Uint8Array | null;
}

export class FactorReader implements FrameServer {
  private cache: Cached[] = [];
  private solver: FactorSolver | null = null;
  private version = 0;
  private pending: { version: number; bytes: Uint8Array } | null = null;
  private disposed = false;
  /** Window files read (each cache miss). */
  reads = 0;

  constructor(
    private readonly files: FactorFiles,
    private readonly windows: readonly CompressedWindow[],
    private readonly px: number,
    private readonly deps: {
      open(bytes: Uint8Array): FactorWindowLike;
      solver(library: Uint8Array): FactorSolver;
    },
  ) {}

  setLibrary(version: number, bytes: Uint8Array): void {
    if (version > this.version && version > (this.pending?.version ?? 0))
      this.pending = { version, bytes };
  }

  async serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved> {
    if (out.length < frames.length * this.px)
      throw new RangeError(`factors: a buffer of ${out.length} for ${frames.length} frames`);
    const t0 = performance.now();
    const timing: LookbackTiming = {
      readMs: 0,
      preprocessMs: 0,
      solveMs: 0,
      otherMs: 0,
      waitMs: 0,
    };
    this.applyLibrary();
    const cells = this.solver?.cells ?? 0;
    const traces = new Float32Array(frames.length * cells);
    let background: Float32Array | undefined;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i].frame;
      const y = out.subarray(i * this.px, (i + 1) * this.px);
      const r0 = performance.now();
      const w = await this.window(f);
      timing.readMs += performance.now() - r0;
      if (this.disposed) throw new Error('look-back stopped');
      const p0 = performance.now();
      rebuildFrames(w.win, w.never, f - w.start, 1, y);
      timing.preprocessMs += performance.now() - p0;
      if (!this.solver || cells === 0 || skip?.[i]) continue;
      const s0 = performance.now();
      traces.set(this.solver.processFrames(y, 1), i * cells);
      const bg = this.solver.lastBackground();
      background ??= new Float32Array(frames.length * bg.length);
      background.set(bg, i * bg.length);
      timing.solveMs += performance.now() - s0;
    }
    timing.otherMs = Math.max(
      0,
      performance.now() - t0 - timing.readMs - timing.preprocessMs - timing.solveMs,
    );
    return {
      version: this.solver ? this.version : 0,
      cells,
      traces,
      ...(background ? { background } : {}),
      timing,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.cache.splice(0)) c.win.free();
    this.solver?.free();
    this.solver = null;
  }

  private applyLibrary(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const next = this.deps.solver(p.bytes);
    this.solver?.free();
    this.solver = next;
    this.version = p.version;
  }

  private async window(frame: number): Promise<Cached> {
    if (this.disposed) throw new Error('look-back stopped');
    const hit = this.cache.find((c) => frame >= c.start && frame < c.start + c.frames);
    if (hit) return hit;
    const w = this.windows.find((x) => frame >= x.start && frame < x.start + x.frames);
    if (!w) throw new Error(`factors: frame ${frame} is in no compressed window`);
    const name = factorName(w.index);
    const win = this.deps.open(await this.files.read(name));
    if (win.start !== w.start || win.frames !== w.frames) {
      win.free();
      throw new Error(
        `factors: ${name} holds frames ${win.start}+${win.frames}, the compressor listed ${w.start}+${w.frames}`,
      );
    }
    this.reads++;
    const c: Cached = { start: w.start, frames: w.frames, win, never: win.neverValid?.() ?? null };
    this.cache.push(c);
    if (this.cache.length > FACTOR_CACHE) this.cache.shift()!.win.free();
    return c;
  }
}
```

(`factorName` is exported from compress-runner.ts already.) In `lookback-types.ts`:

```ts
/** A live stream's factors (`?factors`): the compress worker's run folder and its compressed windows. */
export type FactorSource = {
  factors: { folder: string; windows: CompressedWindow[]; width: number; height: number };
};
```

and `begin`'s `source: LookbackSource | FactorSource`. In `lookback-worker.ts`: `Run` gets
`server: FrameServer | null` beside `reader: LookbackReader | null`, and `ready` resolves to `{ server, pool }`.
`open()` branches first:

```ts
if ('factors' in msg.source) {
  const f = msg.source.factors;
  const server = new FactorReader(factorFiles(f.folder), f.windows, f.width * f.height, {
    open: (bytes) => FactorWindow.fromBytes(bytes),
    solver: (bytes) => {
      const lib = TraceLibrary.fromBytes(bytes);
      try {
        // 0, 0: the solver's default tolerance and sweep cap (as the fast loop's engine).
        const engine = new TraceEngine(lib, 0, 0);
        return {
          cells: lib.ids().length,
          processFrames: (y, n) => engine.processFrames(y, n),
          lastBackground: () => engine.lastBackground(),
          free: () => engine.free(),
        };
      } finally {
        lib.free();
      }
    },
  });
  if (run !== r) {
    server.dispose();
    throw new Error('look-back stopped');
  }
  r.server = server;
  return { server, pool: new StagePool(2, LOOKBACK.takeMax * f.width * f.height) };
}
```

The file branch sets `r.server = r.reader`. `stop()` calls `r.server?.dispose()` (and `r.source?.dispose()`).
`withReader` (main-thread messages: rows, back-state, session, flat) runs only when `r.reader` exists; the slow-side
`library`, `release` and `request` use `server`. The begin error text says "Look-back could not open the factors" for a
factor source. In `lookback-client.ts`: `run.source` is `LookbackSource | FactorSource`; `startPool` returns 0 when
`'factors' in r.source`; and

```ts
    beginFactors(session, factors) {
      ensureWorkers(1);
      run = { session, active: 1, source: { factors }, rows: [], flat: undefined, sessions: [], newest: null, joining: 0 };
      workers[0].postMessage({ type: 'begin', session, source: { factors } } satisfies MainToLookback);
    },
```

`LookbackFeed` gets `beginFactors?(session: number, factors: FactorSource['factors']): void`.

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): look-back worker 0 can serve the settle with frames rebuilt from a stream's factors"
```

---

### Task 6: The slow loop of a `?factors` stream: the cluster replay in the settle only

**Files:** modify `lib/slow-runner.ts` (`FACTOR_SETTLE`, `buildSlowLoop`, the `init` copy in `handle`),
`workers/slow-types.ts` (`SlowInit`), `lib/fast-loop.ts` (options, the `init` message near `fast-loop.ts:528`),
`workers/trace-worker.ts` and `workers/frame-worker.ts` (the `FastLoop` options), `crates/cala/src/discover/tests.rs`;
tests in `__tests__/lookback-runner.test.ts` (`describe('buildSlowLoop')`) and the fast-loop test that checks
`lookback: true` in the init message (find it with `grep -rn "lookback: true" apps/cala/src/__tests__`).

**Interfaces:**

- `const FACTOR_SETTLE = { jointUpdate: 'refine', jointSign: 'all', mergeGuardMinSep: Infinity } as const`
- `SlowInit.factorSettle?: boolean`; `FastLoopOptions.factorSettle?: boolean`

- [ ] **Step 1: Failing tests** (`describe('buildSlowLoop')`):

```ts
it('a ?factors stream builds with the replay in refine visits only and no look-back', () => {
  const l = buildSlowLoop(Fake, { ...init, factorSettle: true });
  expect(l.args).toEqual([
    'withConfig',
    4,
    3,
    init.fov,
    init.noise,
    9,
    0,
    'refine',
    'all',
    Infinity,
  ]);
  expect(l.lookback).toBeNull();
});
it('look-back wins over factorSettle (they never come together)', () => {
  const l = buildSlowLoop(Fake, { ...init, lookback: true, factorSettle: true });
  expect(l.args.slice(-3)).toEqual(['all', 'all', 0.6]);
});
```

and a runner test: `handle({ ...INIT, factorSettle: true, settleFraction: 0.6 })` → `t.created[0]` has
`factorSettle: true` and `settleFraction: 0.6`; `handle(INIT)` → neither key. In the fast-loop test: with
`factorSettle: true` (and `settleFraction: 0.87`) the slow `init` carries both; without it, neither.

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.**

```ts
/**
 * The slow-loop options of a live stream with `?factors` (owner, 23 Nov):
 * the cluster history replay in refine-scope visits only, so in the Final
 * settle on factors; Discover's visits are as without it (no merge guard,
 * the default sign rule). qc_eval's arm `STR-F`.
 */
export const FACTOR_SETTLE = {
  jointUpdate: 'refine',
  jointSign: 'all',
  mergeGuardMinSep: Infinity,
} as const;
```

In `buildSlowLoop`, after the `if (!init.lookback)` line becomes:

```ts
if (!init.lookback) {
  if (!init.factorSettle)
    return new ctor(width, height, fov, noise, cellDiameterPx, flattenSigmaPx);
  return ctor.withConfig(
    width,
    height,
    fov,
    noise,
    cellDiameterPx,
    flattenSigmaPx,
    FACTOR_SETTLE.jointUpdate,
    FACTOR_SETTLE.jointSign,
    FACTOR_SETTLE.mergeGuardMinSep,
  );
}
```

`SlowInit`:

```ts
  /**
   * A live stream with `?factors` (absent = off; never with `lookback`): the
   * slow loop is built with `FACTOR_SETTLE` (visit workers alike) and, after
   * the last frame, waits for the stream's factors and settles on them
   * (see `SlowRunner`).
   */
  factorSettle?: boolean;
```

In `SlowRunner.handle`'s `init` copy: `...(msg.factorSettle && !lookback ? { factorSettle: true } : {})`, and the
`settleFraction` line takes `(lookback || msg.factorSettle) && (msg.settleFraction ?? 1) < 1`. `FastLoop`: option
`factorSettle?: boolean` (default false) and in the `init` message
`...(this.o.factorSettle && !this.o.lookback ? { factorSettle: true } : {})`, with `settleFraction` sent when
`(this.o.lookback || this.o.factorSettle) && this.o.settleFraction < 1`. Both workers pass
`...(cells?.factorSettle && !cells.library ? { factorSettle: true } : {})` and `settleFraction` under the same
condition as for `lookback`.

- [ ] **Step 4: Rust pin** (`discover/tests.rs`, beside `the_cluster_replay_runs_in_visit_jobs_and_matches_step`; it
      passes on the base: it pins the engine behaviour decision 2 relies on):

```rust
/// A live stream with `?factors` runs Discover with `JointUpdate::Refine`:
/// in Discover's own scope that must publish exactly what `Off` publishes
/// (the store accumulates only in refine-scope visits).
#[test]
fn joint_update_refine_leaves_discover_unchanged() {
    let t = 3000;
    let mut rng = Lcg(97);
    let cells = vec![
        (blob_w(0, 30.0, 30.0, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        (blob_w(1, 30.0, 33.5, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        (blob_w(2, 60.0, 50.0, 2.5), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 211);
    let with = |ju: JointUpdate| SlowLoopConfig { joint_update: ju, ..v2_config() };
    let (mut sa, mut ea) = start(with(JointUpdate::Off), &[]);
    let (mut sb, mut eb) = start(with(JointUpdate::Refine), &[]);
    let n_px = N * N;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        sa.observe(f, &la, &ta).unwrap();
        sb.observe(f, &lb, &tb).unwrap();
        let (pa, pb) = (sa.step(5_000_000).unwrap(), sb.step(5_000_000).unwrap());
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    assert!(sa.finalize().unwrap().to_bytes()[16..] == sb.finalize().unwrap().to_bytes()[16..]);
    assert_eq!(sb.replay_stats.replays, 0, "{:?}", sb.replay_stats);
}
```

If `start(cfg, &[])` does not accept an empty seed, seed both with the same one-cell library the nearest test uses;
keep the assertions. If the test fails, stop and report: do not change the engine (decision 2).

- [ ] **Step 5: Run the Rust checks and the app checks.** Expected: pass.
- [ ] **Step 6: Commit:**

```bash
git commit -m "feat(cala): a ?factors stream's slow loop runs the cluster replay in the settle only"
```

---

### Task 7: `SlowRunner`: wait for the factors after the stream, then settle on them

**Files:** modify `lib/slow-runner.ts`, `workers/slow-types.ts` (`MainToSlow`), `workers/lookback-types.ts`
(`SettleStatus`), `workers/slow-worker.ts`, `lib/slow-client.ts`; tests in `__tests__/lookback-runner.test.ts` (a new
`describe`, with the file's `setup`, `INIT`, `frames`, `statuses`, `finals`, `settleReqs`).

**Interfaces:**

- `SlowFactors = { type: 'factors'; session: number } & ({ ready: true; frames: number } | { ready: false; reason: string })`
- `SlowRunner.factors(msg: SlowFactors): void`
- `SlowClient.factorsReady(session: number, frames: number)`, `SlowClient.factorsFailed(session: number, reason: string)`
- `SettleStatus.source?: 'factors'`, `SettleStatus.waiting?: boolean`, `SettleStatus.error?: string`
- private: `factorOn`, `factorWait: { since: number } | null`, `factorLive`, `startDrain(recording?: number)`

- [ ] **Step 1: Failing tests:**

```ts
describe('SlowRunner settle on a stream's factors (fake loop)', () => {
  const FINIT = { ...INIT, factorSettle: true } as const;
  const ready = (frames: number) => ({ type: 'factors', session: 1, ready: true, frames }) as const;

  it('waits after the last frame, then settles on the factors through port 0 with the current library first', () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle(frames(20, 20));
    const observes = t.streams.length;
    // Discover asks look-back nothing and observes without a stream index (as a stream today).
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(0);
    expect(t.streams.every((s) => s === undefined)).toBe(true);
    t.r.handle({ type: 'end', session: 1 });
    expect(finals(t)).toHaveLength(0);
    expect(statuses(t).at(-1)!.lookback).toMatchObject({
      settling: true,
      settle: { waiting: true, source: 'factors', fed: 0 },
    });
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(0);
    t.r.factors(ready(39)); // one-frame tail left out
    // The worker gets the library before the first request.
    const kinds = t.toLb.map((m) => m.type);
    expect(kinds.indexOf('library')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('library')).toBeLessThan(kinds.indexOf('request'));
    expect(t.loop.setEditScope).toHaveBeenCalledWith('refine');
    t.run();
    expect(t.streams.slice(observes)).toEqual([...Array(39).keys()]);
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      fed: 39,
      total: 39,
      recording: 39,
      done: true,
      source: 'factors',
    });
  });

  it('factors that cannot be read end the wait with Discover's library as the final one', () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.factors({ type: 'factors', session: 1, ready: false, reason: 'The factors do not cover the stream.' });
    expect(finals(t)).toHaveLength(1);
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(0);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      fed: 0,
      done: true,
      error: 'The factors do not cover the stream.',
    });
  });

  it('Stop settling while waiting publishes the final library; a late "ready" changes nothing', () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.stopSettling(1);
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({ stopped: true, done: true, fed: 0 });
    t.r.factors(ready(20));
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(0);
    expect(finals(t)).toHaveLength(1);
  });

  it('a stream without factorSettle ends at once, as today', () => {
    const t = setup(0);
    t.r.handle(INIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback).toBeUndefined();
  });
});
```

(`settleReqs(t)` is the file's helper; if its shape differs, count the `request` messages instead.)

- [ ] **Step 2: Run; expect failures** (no `factors`, no wait).
- [ ] **Step 3: Implement.** Fields:

```ts
  // ---- the Final settle on a stream's factors (`SlowInit.factorSettle`) ----
  /** This run settles on its factors after the last frame (`SlowInit.factorSettle`, Discover). */
  private factorOn = false;
  /** Discover's last frame is in and the factors are not yet ready (released by `factors`, Stop, `drop`). */
  private factorWait: { since: number } | null = null;
  /** The settle reads the factors through look-back worker 0 (from `factors` ready to the run's end). */
  private factorLive = false;
```

In `handle` `init`: `this.factorOn = this.init.factorSettle === true;`. A getter for "look-back worker 0 serves this
run" and its use in `publish` (`if (this.lbServes && !this.lbError)`):

```ts
  /** Look-back worker 0 serves this run: look-back, or the settle on factors. */
  private get lbServes(): boolean {
    return this.lbOn || this.factorLive;
  }
```

`end()`:

```ts
  private end(): void {
    const loop = this.loop;
    if (!loop || this.final || this.ending || this.drain || this.factorWait) return;
    // A look-back Discover settles first (`settlePump`).
    if (this.lbOn && this.run === 1) {
      this.clock.span('end', () => this.startDrain());
      return;
    }
    // A ?factors stream waits for its factors, then settles on them (`factors`).
    if (this.factorOn && this.run === 1) {
      this.factorWait = { since: this.now() };
      this.reviewed = [];
      this.status(0, 0);
      return;
    }
    // Visits out still come back and are applied before the final library.
    this.ending = true;
    if (!this.busy.some((b) => b)) this.finish();
  }

  /** The main thread on the stream's factors: settle on them, or end with Discover's library. */
  factors(msg: SlowFactors): void {
    if (msg.session !== this.session || !this.factorWait || !this.loop) return;
    this.factorWait = null;
    try {
      if (!msg.ready) {
        this.settleStatus = { ...this.waitView(), done: true, error: msg.reason };
        this.ending = true;
        if (!this.busy.some((b) => b)) this.finish();
        return;
      }
      this.factorLive = true;
      // The worker began this run just now: it has no library yet.
      this.sendLibrary(0);
      this.clock.span('end', () => this.startDrain(Math.min(this.consumed, msg.frames)));
    } catch (err) {
      this.fail(err);
    }
  }

  /** The newest published library to look-back worker `port` (a copy). */
  private sendLibrary(port: number): void {
    const lib = this.loop?.publishedLibrary?.();
    if (!lib) return;
    try {
      const bytes = lib.toBytes();
      this.lbPorts[port]?.postMessage(
        { type: 'library', session: this.session, version: lib.version, bytes },
        [bytes.buffer as ArrayBuffer],
      );
    } finally {
      lib.free();
    }
  }

  private waitView(): SettleStatus {
    return {
      fed: 0,
      total: 0,
      recording: this.consumed,
      moving: null,
      stopped: false,
      done: false,
      source: 'factors',
      waiting: true,
    };
  }
```

`startDrain(recording = this.consumed)`: use the parameter for `recording`. `settleView(d, done)` adds
`...(this.factorLive ? { source: 'factors' as const } : {})`. `stopSettling`:

```ts
  stopSettling(session: number): void {
    if (session !== this.session) return;
    if (this.factorWait) {
      this.factorWait = null;
      this.settleStatus = { ...this.waitView(), waiting: false, stopped: true, done: true };
      this.ending = true;
      if (!this.busy.some((b) => b)) this.finish();
      return;
    }
    const d = this.drain;
    if (!d) return;
    d.stop = true;
    this.cancelRequests();
    this.settlePump();
  }
```

`lookbackStatus`: `settling: this.drain !== null || this.factorWait !== null`, and the `settle` entry is
`this.drain ? settleView : this.factorWait ? this.waitView() : this.settleStatus`. `statusInner` includes `lookback`
when `this.lbOn || this.factorOn`. `drop()` resets `factorOn = false`, `factorWait = null`, `factorLive = false`. In the
fake fixture the loop needs `publishedLibrary: () => fakeLib(10)`; add it to `fakeLoop`.

`SlowFactors` in slow-types.ts (and in `MainToSlow`); slow-worker.ts, not queued like `stop-settling`:

```ts
if (data.type === 'factors') {
  runner?.factors(data);
  return;
}
```

slow-client.ts:

```ts
    factorsReady(session, frames) {
      const msg: SlowFactors = { type: 'factors', session, ready: true, frames };
      worker.postMessage(msg);
    },
    factorsFailed(session, reason) {
      const msg: SlowFactors = { type: 'factors', session, ready: false, reason };
      worker.postMessage(msg);
    },
```

- [ ] **Step 4: Run the tests (the old look-back ones too) and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): after a ?factors stream the slow loop waits for its factors and settles on them"
```

---

### Task 8: The main thread starts the settle on factors, or ends the wait

**Files:** create `apps/cala/src/lib/factor-settle.ts`, `apps/cala/src/__tests__/factor-settle.test.ts`; modify
`App.tsx` (an effect beside the back-fill effect near `App.tsx:392`; the stage record near `App.tsx:322-335`).

**Interfaces:**

- `interface FactorSettleInput { session: number; factorRun: boolean; waiting: boolean; final: boolean; state: FactorState; reason: string | null; info: FactorInfo | null; width: number; height: number }`
- `type FactorSettleAction = { kind: 'none' } | { kind: 'begin'; session: number; frames: number; factors: FactorSource['factors'] } | { kind: 'fail'; session: number; reason: string } | { kind: 'release'; session: number }`
- `class FactorSettle { act(i: FactorSettleInput): FactorSettleAction }` (remembers per session what it did)
- `const FACTOR_SETTLE_NOTE`, `FACTOR_STALL_TEXT`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from 'vitest';
import { FactorSettle, type FactorSettleInput } from '../lib/factor-settle.ts';

const info = { folder: 'run-a', tiling: 'offset' as const, windows: [{ index: 0, start: 0, frames: 600 }], frames: 600, meanRank: 4 };
const I = (o: Partial<FactorSettleInput> = {}): FactorSettleInput => ({
  session: 5,
  factorRun: true,
  waiting: true,
  final: false,
  state: 'ready',
  reason: null,
  info,
  width: 4,
  height: 3,
  ...o,
});

describe('FactorSettle', () => {
  it('begins once when the slow loop waits and the factors are ready', () => {
    const c = new FactorSettle();
    expect(c.act(I())).toEqual({
      kind: 'begin',
      session: 5,
      frames: 600,
      factors: { folder: 'run-a', windows: info.windows, width: 4, height: 3 },
    });
    expect(c.act(I())).toEqual({ kind: 'none' });
  });
  it('does nothing before the slow loop waits, while compressing, or on a run without ?factors', () => {
    const c = new FactorSettle();
    expect(c.act(I({ waiting: false }))).toEqual({ kind: 'none' });
    expect(c.act(I({ state: 'compressing' }))).toEqual({ kind: 'none' });
    expect(c.act(I({ factorRun: false }))).toEqual({ kind: 'none' });
  });
  it('fails the wait once with the reason when the factors are unusable', () => {
    const c = new FactorSettle();
    expect(c.act(I({ state: 'unusable', reason: 'The factors do not cover the stream.' }))).toEqual({
      kind: 'fail',
      session: 5,
      reason: 'The factors do not cover the stream.',
    });
    expect(c.act(I({ state: 'unusable', reason: 'x' }))).toEqual({ kind: 'none' });
  });
  it('releases the look-back worker once at the final library, and starts over with a new session', () => {
    const c = new FactorSettle();
    c.act(I());
    expect(c.act(I({ waiting: false, final: true }))).toEqual({ kind: 'release', session: 5 });
    expect(c.act(I({ waiting: false, final: true }))).toEqual({ kind: 'none' });
    expect(c.act(I({ session: 6 })).kind).toBe('begin');
  });
  it('a new session releases the old one's worker first if it was begun and never released', () => {
    const c = new FactorSettle();
    c.act(I());
    expect(c.act(I({ session: 6, waiting: false }))).toEqual({ kind: 'release', session: 5 });
  });
});
```

- [ ] **Step 2: Run; expect a failure.**
- [ ] **Step 3: Implement** `factor-settle.ts`:

```ts
/**
 * The main thread's part of the Final settle on a stream's factors: once the
 * slow loop waits (`SettleStatus.waiting`) and the factors are `ready`, it
 * begins look-back worker 0 on them and tells the slow loop; when they are
 * `unusable` it ends the wait. It releases the worker at the final library
 * or at the next run. Pure: `App.tsx` carries out the actions.
 */
import type { FactorInfo, FactorState } from './compress-store.ts';
import type { FactorSource } from '../workers/lookback-types.ts';

export interface FactorSettleInput {
  session: number;
  /** This run is a `?factors` stream (`pipeline.factorRun()`). */
  factorRun: boolean;
  /** The slow loop waits for the factors. */
  waiting: boolean;
  /** The run's final library is out. */
  final: boolean;
  state: FactorState;
  /** Why the factors cannot be read (`factorsBlocked`). */
  reason: string | null;
  info: FactorInfo | null;
  width: number;
  height: number;
}

export type FactorSettleAction =
  | { kind: 'none' }
  | { kind: 'begin'; session: number; frames: number; factors: FactorSource['factors'] }
  | { kind: 'fail'; session: number; reason: string }
  | { kind: 'release'; session: number };

export class FactorSettle {
  /** The session answered (begun or failed), and the one whose worker is begun and not released. */
  private answered = -1;
  private begun = -1;

  act(i: FactorSettleInput): FactorSettleAction {
    if (this.begun >= 0 && this.begun !== i.session) {
      const session = this.begun;
      this.begun = -1;
      return { kind: 'release', session };
    }
    if (!i.factorRun) return { kind: 'none' };
    if (i.final && this.begun === i.session) {
      this.begun = -1;
      return { kind: 'release', session: i.session };
    }
    if (!i.waiting || this.answered === i.session) return { kind: 'none' };
    if (i.state === 'ready' && i.info) {
      this.answered = i.session;
      this.begun = i.session;
      return {
        kind: 'begin',
        session: i.session,
        frames: i.info.frames,
        factors: {
          folder: i.info.folder,
          windows: i.info.windows,
          width: i.width,
          height: i.height,
        },
      };
    }
    if (i.state === 'unusable') {
      this.answered = i.session;
      return {
        kind: 'fail',
        session: i.session,
        reason: i.reason ?? 'The factors cannot be read.',
      };
    }
    return { kind: 'none' };
  }
}

/** The run history's line when the watchdog gives up. */
export const FACTOR_STALL_TEXT =
  'The compressor made no progress for 120 s: the factors are not read.';
```

In `App.tsx` (only when `factors`): a `FactorSettle`, a `FactorWatchdog`, and a 5 s tick signal
(`setInterval(() => setTick((n) => n + 1), 5000)`, cleared with `onCleanup`). One effect:

```ts
createEffect(() => {
  tick();
  if (!factors || !compress) return;
  const st = cells.status();
  const session = cells.session();
  const ended = pipeline.status() === 'done';
  const frames = pipeline.processed();
  const settle = st?.lookback?.settle;
  const waiting = settle?.waiting === true;
  const now = performance.now();
  if (waiting) {
    watchdog.note(compress.status(), now);
    if (watchdog.stalled(now) && compress.factors(ended, frames) === 'compressing') {
      compress.fail(FACTOR_STALL_TEXT);
      runHistory.log({ frame: frames, kind: 'warning', detail: FACTOR_STALL_TEXT });
    }
  } else watchdog.reset();
  const state = compress.factors(ended, frames);
  const i = store.info();
  const a = factorSettle.act({
    session,
    factorRun: pipeline.factorRun(),
    waiting,
    final: st?.final === true,
    state,
    reason: factorsBlocked(state, compress.status(), compress.error()),
    info: compress.factorInfo(),
    width: i?.width ?? 0,
    height: i?.height ?? 0,
  });
  if (a.kind === 'begin') {
    lookbackClient.beginFactors?.(a.session, a.factors);
    slow.factorsReady(a.session, a.frames);
  } else if (a.kind === 'fail') slow.factorsFailed(a.session, a.reason);
  else if (a.kind === 'release') lookbackClient.reset(a.session);
});
```

(`beginFactors` connects the slow worker's port 0 before `factorsReady` reaches it: both go through the slow worker's
message queue in order.) Also in `App.tsx`: the back-fill effect runs only when `!pipeline.factorRun()`; the
Discover stage record (`App.tsx:333`) uses `...(pipeline.lookbackRun() ? { lookback: true } : {})` (the status now
has `lookback` on factor runs too) and adds `...(slow?.lookback?.settle?.source === 'factors' ? { settleSource:
'factors' as const } : {})` (`StageRun.settleSource`, Task 10).

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): the main thread begins the settle on a stream's factors or ends the wait"
```

---

### Task 9: Extract on a stream's factors

**Files:** modify `lib/compress-runner.ts` (the Extract job), `workers/compress-types.ts`, `workers/compress-worker.ts`,
`lib/compress-client.ts`, `lib/compress-store.ts` (routing to `onExtract`); create `apps/cala/src/lib/factor-extract.ts`;
modify `lib/pass2-store.ts`, `lib/run-stages.ts`, `App.tsx`; tests in `__tests__/compress.test.ts`,
`__tests__/pass2-store.test.ts`, `__tests__/run-stages.test.ts`, create `__tests__/factor-extract.test.ts`.

**Interfaces:**

- `MainToCompress` adds `{ type: 'extract'; session: number; job: number; version: number; library: Uint8Array }` and
  `{ type: 'extract-cancel'; session: number; job: number }`.
- `CompressToMain` adds `{ type: 'extracted'; session; job; start; count; ids: Uint32Array; traces: Float32Array; signed?: Float32Array }`,
  `{ type: 'extract-done'; session; job; frames; msPerFrame }`; `error` gains `job?: number`.
- `CompressRunner.extract(session, job, version, library)`, `CompressRunner.extractCancel(session, job)`.
- `BackfillEngineLike.lastSigned?(): Float32Array`; `CompressRunnerDeps.engine(library, signed?: boolean)`.
- `CompressClient.extract(session, job, version, library)`, `CompressClient.extractCancel(session, job)`.
- `interface FactorJob { done: Promise<{ frames: number; msPerFrame: number }>; cancel(): void }`
- `interface FactorExtractPort { active(): boolean; state(): FactorState; blocked(): string | null; changed(): Promise<void>; info(): FactorInfo | null; run(version: number, library: Uint8Array, onWindow: (start: number, count: number, ids: Uint32Array, traces: Float32Array, signed?: Float32Array) => void): FactorJob }`
- `createFactorExtract(store, client, session: () => number, active: () => boolean, ended: () => boolean, frames: () => number): FactorExtractPort`
- `Pass2Result.source?: 'factors'`, `Pass2Result.factors?: FactorInfo`; `pass2.waiting(): string | null`.
- `StageInput.liveFactors?: boolean`.

- [ ] **Step 1: Failing tests, runner** (`compress.test.ts`, with its runner helpers and a fake engine whose
      `processFrames` returns the frame's first value and `lastSigned` its negative), two tests:
  - `extract` after the final window posts one `extracted` per window in stream order (`start`, `count`, `ids`,
    traces from rebuilt frames, `signed`), then `extract-done` with `frames` = the windows' sum.
  - `extractCancel` mid-job: no more `extracted`, no `extract-done`.
  - The back-fill path is unchanged (its existing tests pass).
- [ ] **Step 2: Failing tests, port** (`factor-extract.test.ts`, with a fake client recording `extract` and
      `extractCancel`, and a real `createCompressStore`):

```ts
describe('createFactorExtract', () => {
  it('a job resolves at extract-done and hands each window to onWindow', async () => {
    const t = setup(); // store reset to session 3, fake client, port
    const seen: number[] = [];
    const job = t.port.run(9, Uint8Array.of(1), (start) => seen.push(start));
    const id = t.client.extracts.at(-1)!.job;
    t.store.onMessage({
      type: 'extracted',
      session: 3,
      job: id,
      start: 0,
      count: 2,
      ids: Uint32Array.of(1),
      traces: new Float32Array(2),
    });
    t.store.onMessage({ type: 'extract-done', session: 3, job: id, frames: 2, msPerFrame: 0.5 });
    await expect(job.done).resolves.toEqual({ frames: 2, msPerFrame: 0.5 });
    expect(seen).toEqual([0]);
  });
  it('rejects on its error, on cancel (and tells the worker), on a reset and on a crash', async () => {
    const t = setup();
    const a = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.onMessage({
      type: 'error',
      session: 3,
      job: t.client.extracts.at(-1)!.job,
      message: 'f2.bin cannot be read',
    });
    await expect(a.done).rejects.toThrow('f2.bin');
    const b = t.port.run(9, Uint8Array.of(1), () => {});
    b.cancel();
    await expect(b.done).rejects.toThrow('cancelled');
    expect(t.client.cancels).toHaveLength(1);
    const c = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.reset(4);
    await expect(c.done).rejects.toThrow('A new run started');
    t.store.reset(3);
    const d = t.port.run(9, Uint8Array.of(1), () => {});
    t.store.onMessage({ type: 'error', session: -1, message: 'The compress worker crashed.' });
    await expect(d.done).rejects.toThrow('crashed');
  });
});
```

- [ ] **Step 3: Failing tests, stage** (`pass2-store.test.ts` with a fake `FactorExtractPort`; `run-stages.test.ts`):
  - With `active()` true and `ready`: `run()` calls `port.run` with the final library, appends each window to the trace
    file, ends `done` with `source: 'factors'` and `frames` = `info.frames`, and never starts the replay pipeline.
  - With `compressing`: it waits, and `cancel()` while waiting ends `cancelled` without calling `port.run`.
  - `stageAvailability({ ...input, live: true, liveFactors: true })` lets Extract run; `live: true` alone still returns
    `LIVE_NOTE`.
- [ ] **Step 4: Run; expect failures.**
- [ ] **Step 5: Implement the runner job** (compress-runner.ts):

```ts
  private job: { id: number; session: number; version: number; library: Uint8Array } | null = null;

  /** Extract on factors: solve every compressed window with `library`, once no window waits. */
  extract(session: number, id: number, version: number, library: Uint8Array): void {
    if (session !== this.session || !this.init) return;
    this.job = { id, session, version, library };
    this.maybeExtract();
  }

  extractCancel(session: number, id: number): void {
    if (this.job?.id === id && this.job.session === session) this.job = null;
  }

  private maybeExtract(): void {
    const job = this.job;
    const { engine, factors } = this.deps;
    if (!job || this.loop || this.open || this.pending.length > 0 || !engine || !factors) return;
    this.launch(this.runExtract(job, engine, factors));
  }

  private async runExtract(
    job: { id: number; session: number; library: Uint8Array },
    makeEngine: NonNullable<CompressRunnerDeps['engine']>,
    openFactors: NonNullable<CompressRunnerDeps['factors']>,
  ): Promise<void> {
    const init = this.init;
    if (!init) return;
    const epoch = this.epoch;
    const live = () => epoch === this.epoch && this.job === job;
    const t0 = this.now();
    const px = init.width * init.height;
    const engine = makeEngine(job.library, true);
    try {
      const ids = engine.ids();
      const buf = new Float32Array(BACKFILL_BATCH * px);
      let frames = 0;
      for (const w of [...this.done]) {
        const window = openFactors(await this.deps.store.readAll(factorName(w.index)));
        try {
          const never = window.neverValid?.() ?? null;
          const traces = new Float32Array(window.frames * ids.length);
          const signed = engine.lastSigned ? new Float32Array(window.frames * ids.length) : undefined;
          for (let t = 0; t < window.frames; t += BACKFILL_BATCH) {
            const n = Math.min(BACKFILL_BATCH, window.frames - t);
            const view = buf.subarray(0, n * px);
            rebuildFrames(window, never, t, n, view);
            traces.set(engine.processFrames(view, n), t * ids.length);
            signed?.set(engine.lastSigned!(), t * ids.length);
            await this.yieldNow();
            if (!live()) return;
          }
          const cellIds = ids.slice();
          const transfer: ArrayBuffer[] = [cellIds.buffer as ArrayBuffer, traces.buffer as ArrayBuffer];
          if (signed) transfer.push(signed.buffer as ArrayBuffer);
          this.deps.toMain.postMessage(
            { type: 'extracted', session: job.session, job: job.id, start: window.start, count: window.frames, ids: cellIds, traces, ...(signed ? { signed } : {}) },
            transfer,
          );
          frames += window.frames;
        } finally {
          window.free();
        }
      }
      this.job = null;
      this.deps.toMain.postMessage({ type: 'extract-done', session: job.session, job: job.id, frames, msPerFrame: (this.now() - t0) / Math.max(1, frames) });
    } catch (err) {
      if (live()) {
        this.job = null;
        this.deps.toMain.postMessage({ type: 'error', session: job.session, job: job.id, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      engine.free();
    }
  }
```

`launch`'s `finally` also calls `this.maybeExtract()` after `maybeBackfill()`; `clear()` sets `this.job = null`. In
compress-worker.ts the engine takes `signed`: `engine.setSigned(true)` when asked and `lastSigned: () =>
engine.lastSigned()`; the worker routes `extract` and `extract-cancel` like `backfill` (queued after `initCalaWasm`).

- [ ] **Step 6: Implement the client, store routing and port.** compress-client.ts posts the two messages. In the
      store, `onMessage` sends `extracted`, `extract-done` and an `error` with a `job` to `onExtract` (an own-session
      `error` without a job and every session -1 error also go to `onExtract` as a crash, besides `setError`).
      `factor-extract.ts`:

```ts
/**
 * Extract on a live stream's factors (`?factors`; spec decision 4): one job
 * at a time in the compress worker. A job's `done` always settles: at
 * `extract-done`, its error, `cancel()`, the store's reset (a new run) or a
 * crash of the compress worker.
 */
export function createFactorExtract(
  store: CompressStore,
  client: Pick<CompressClient, 'extract' | 'extractCancel'>,
  session: () => number,
  active: () => boolean,
  ended: () => boolean,
  frames: () => number,
): FactorExtractPort {
  let next = 1;
  let cur: {
    id: number;
    session: number;
    onWindow: Parameters<FactorExtractPort['run']>[2];
    resolve: (v: { frames: number; msPerFrame: number }) => void;
    reject: (e: Error) => void;
  } | null = null;
  const end = (err: Error | null, v?: { frames: number; msPerFrame: number }): void => {
    const c = cur;
    cur = null;
    if (!c) return;
    if (err) c.reject(err);
    else c.resolve(v!);
  };
  store.onExtract = (msg) => {
    if (msg.type === 'reset') return end(new Error('A new run started.'));
    if (!cur) return;
    if (msg.type === 'error') {
      if (msg.session === -1 || msg.job === undefined || msg.job === cur.id)
        end(new Error(msg.message));
      return;
    }
    if (msg.session !== cur.session || msg.job !== cur.id) return;
    if (msg.type === 'extracted')
      cur.onWindow(msg.start, msg.count, msg.ids, msg.traces, msg.signed);
    else end(null, { frames: msg.frames, msPerFrame: msg.msPerFrame });
  };
  return {
    active,
    state: () => store.factors(ended(), frames()),
    blocked: () => factorsBlocked(store.factors(ended(), frames()), store.status(), store.error()),
    changed: () => store.changed(),
    info: () => store.factorInfo(),
    run(version, library, onWindow) {
      end(new Error('Another Extract started.'));
      const id = next++;
      const s = session();
      const done = new Promise<{ frames: number; msPerFrame: number }>((resolve, reject) => {
        cur = { id, session: s, onWindow, resolve, reject };
      });
      client.extract(s, id, version, library.slice());
      return {
        done,
        cancel() {
          if (cur?.id !== id) return;
          client.extractCancel(s, id);
          end(new Error('cancelled'));
        },
      };
    },
  };
}
```

(The store's `reset` calls `onExtract?.({ type: 'reset' })`; its message type is
`CompressToMain | { type: 'reset' }`.)

- [ ] **Step 7: Implement the stage.** `createPass2Store(client, pipeline, cells, clock, blocked, factors?:
FactorExtractPort)`. `blockedReason()` for `factors?.active()`: the busy and Discover checks as now, then the
      library checks; it skips `replayBlocked` (there is no file) and does not check the factor state (Extract waits
      for it). `run()` begins with:

```ts
if (factors?.active()) return runFactors(factors);
```

and

```ts
/** Extract on a live stream's factors: wait for `ready`, then one job in the compress worker. */
async function runFactors(port: FactorExtractPort): Promise<void> {
  const reason = blockedReason();
  if (reason) {
    setError(reason);
    setStatus('error');
    return;
  }
  const gen = ++generation;
  setStatus('running');
  setError(null);
  await discard();
  setProcessed(0);
  setFps(0);
  while (port.state() === 'compressing') {
    setWaiting(port.blocked());
    await port.changed();
    if (gen !== generation) return;
  }
  setWaiting(null);
  const info = port.info();
  if (port.state() !== 'ready' || !info) {
    generation++;
    setError(port.blocked() ?? 'The factors cannot be read.');
    setStatus('error');
    return;
  }
  const library = cells.library()!;
  const bytes = cells.libraryBytes()!;
  const n = library.ids.length;
  setTotal(info.frames);
  let traces: TraceFile;
  let signed: TraceFile | null;
  try {
    traces = await createTraceFile(info.frames, n, { extraBytes: info.frames * n * 4 });
    signed = await createTraceFile(info.frames, n, {});
  } catch (err) {
    if (gen !== generation) return;
    generation++;
    setError(err instanceof Error ? err.message : String(err));
    setStatus('error');
    return;
  }
  file = traces;
  signedFile = signed;
  const t0 = clock();
  const job = port.run(library.version, bytes, (start, count, ids, tr, sg) => {
    if (gen !== generation) return;
    if (ids.length !== n || ids.some((id, i) => id !== library.ids[i]))
      throw new Error('Extract got no traces for the final library.');
    traces.append(start, tr);
    if (signed && sg) signed.append(start, sg);
    setProcessed(start + count);
  });
  factorJob = job;
  try {
    await job.done;
    await traces.finish();
    if (signed) await signed.finish();
    if (gen !== generation) return;
    setResult({
      ids: library.ids.slice(),
      traces,
      signed,
      frames: info.frames,
      cells: n,
      version: library.version,
      library,
      seconds: (clock() - t0) / 1000,
      source: 'factors',
      factors: info,
    });
    setStatus('done');
  } catch (err) {
    if (gen !== generation) return;
    generation++;
    setError(err instanceof Error ? err.message : String(err));
    setStatus('error');
    void discard();
  } finally {
    factorJob = null;
  }
}
```

A window without signed traces drops the signed file as `handle` does today. `cancel()` and `clear()` call
`factorJob?.cancel()` (and `cancel` skips `client.stopPipeline` when a factor job or wait was running). A `waiting`
signal (`string | null`) is returned. In `run-stages.ts`: `StageInput.liveFactors?: boolean`; in `after()`:
`if (i.live && !i.liveFactors) return LIVE_NOTE;` and the caller passes `replayBlocked: null` for a factor run. In
`App.tsx`: `const factorExtract = compress && compressClient ? createFactorExtract(compress, compressClient, () =>
cells.session(), () => pipeline.factorRun(), () => pipeline.status() === 'done', () => pipeline.processed()) :
undefined;` passed to `createPass2Store`; `stageInput()` gets `liveFactors: pipeline.factorRun()` and
`replayBlocked: pipeline.factorRun() ? null : replayBlocked(pipeline)`; the Extract stage record adds
`...(res.source === 'factors' ? { source: 'factors' as const, factors: res.factors } : {})`.

- [ ] **Step 8: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 9: Commit:**

```bash
git commit -m "feat(cala): Extract on a ?factors stream solves every frame on its factors in the compress worker"
```

---

### Task 10: The export keeps both trace sets and says where they come from

**Files:** modify `lib/export.ts` (`ExportInput`, `stageMeta`, the meta, the matrices), `lib/run-stages.ts`
(`StageRun`), `components/RunPanel.tsx` (`exportInput`, `exportResult`); test `__tests__/export.test.ts`.

**Interfaces:**

- `StageRun.settleSource?: 'factors'`, `StageRun.source?: 'factors'`, `StageRun.factors?: FactorInfo`
- `ExportInput.liveTraces?: TraceFile`, `ExportInput.notes?: string[]`
- `function exportFormatVersion(input: Pick<ExportInput, 'liveTraces' | 'notes' | 'stages'>): 6 | 7`
- `const FACTORS_EXPORT_NOTE: string`, `function factorTailNote(frames: number, of: number): string`

- [ ] **Step 1: Failing tests** (`export.test.ts`, with its existing input builder and npz reader):
  - An input with `liveTraces`, `notes`, a Discover record with `settleSource: 'factors'` and an Extract record with
    `source: 'factors'` and `factors` writes `traces_live.npy` (cells x frames, the live values), `meta_json.notes`,
    the stage keys `settle_source`, `source`, `factor_tiling`, `factor_windows`, `factor_mean_rank`, and
    `format_version: 7`.
  - The file's existing inputs (a recording, a live run without factors) write `format_version: 6` and the same entry
    names as before (`toEqual` on the list).
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** `stageMeta` adds, when present: `settle_source`, `source`, and from `factors`:
      `factor_tiling`, `factor_windows` (the windows' count), `factor_mean_rank`. Then:

```ts
/** Version 7 adds optional fields (`traces_live`, `notes`, the stages' sources); an export without them stays 6. */
export function exportFormatVersion(
  input: Pick<ExportInput, 'liveTraces' | 'notes' | 'stages'>,
): 6 | 7 {
  const sourced = (input.stages ?? []).some((r) => r.settleSource || r.source);
  return input.liveTraces || (input.notes?.length ?? 0) > 0 || sourced ? 7 : 6;
}

export const FACTORS_EXPORT_NOTE =
  "Settle and Extract read the factors Discover wrote during the stream; there was no file to re-read. Extract's traces (traces, traces_signed) are solved on low-rank frames and carry less per-frame noise than the live traces (traces_live).";

export function factorTailNote(frames: number, of: number): string {
  return `The stream's last ${of - frames} frame(s) formed a window too short to compress; this export covers frames 0-${frames - 1}.`;
}
```

`meta.format_version: exportFormatVersion(input)`, `...(input.notes?.length ? { notes: input.notes } : {})`, and
`...(input.liveTraces ? { traces_live: 'the traces Discover solved as the frames came in (same cells and units)' } :
{})`; `matrices.push(['traces_live.npy', input.liveTraces])` when given. `EXPORT_FORMAT_VERSION` stays 6 and the
header comment documents version 7. In `RunPanel.tsx`: for a live run whose `p().result()?.source === 'factors'`,
`exportInput` adds `liveTraces: liveResult()!.traces` when the live result's `ids` equal Extract's (else it leaves
them out and logs a warning), `notes: [FACTORS_EXPORT_NOTE, ...(tail ? [factorTailNote(F, T)] : [])]`, and
`frameRange: { start: 0, end: F }` when `F < T` (F = Extract's frames, T = the live result's). `exportResult` stays
`p().result() ?? liveResult()`. The CaDecon export is unchanged (it takes `result.signed`).

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): a ?factors stream's export keeps the live traces beside Extract's and names its sources"
```

---

### Task 11: Run panel and Steps for a `?factors` stream

**Files:** modify `components/RunPanel.tsx`, `lib/step-view.ts`, `lib/lookback-text.ts`, `App.tsx` (props). No new
unit tests: text and buttons are checked by Task 12's e2e; the existing step-view and lookback-text tests must pass
unchanged (a stream without `?factors` is as today).

**Interfaces:** `StepInput.factorRun?: boolean`; `stageLabel({ ..., factorRun? })` (a factor run's label follows
Extract as a recording's does); `const FACTORS_LIVE_NOTE: string` (factor-run.ts); `lookbackText` reads
`Final settle: waiting for the stream's last factor windows` while `settle.waiting`, `Final settle skipped: <error>`
with `settle.error`, and adds `on the stream's factors` with `source: 'factors'`.

- [ ] **Step 1: Implement.** `stepView`: with `factorRun` the settle step is on and Extract is not `off`. `FACTORS_LIVE_NOTE = 'With ?factors, a live stream settles and extracts on the factors
Discover wrote during the stream (there is no file to re-read). The export keeps the live traces beside
Extract\'s.'` In `RunPanel.tsx`: a `factorRun` prop; the results note shows `FACTORS_LIVE_NOTE` instead of
      `LIVE_NOTE` when it is on; the Extract button and Cancel show for `!props.live || props.factorRun`; the
      auto-Extract effect's `!props.live` becomes `(!props.live || props.factorRun)`; `pass2Text` shows `p().waiting()`
      while it is set and, for `done` with `source: 'factors'`, `Extract done (on the stream's factors): ...`. The
      Stop-settling control already shows while `settling` (the wait is `settling`).
- [ ] **Step 2: Run the app checks.** Expected: pass.
- [ ] **Step 3: Commit:**

```bash
git commit -m "feat(cala): the Run panel and Steps show a ?factors stream's settle and Extract"
```

---

### Task 12: e2e: a `?factors` stream settles, extracts and exports both trace sets

**Files:** modify `apps/cala/src/__tests__/synth-avi.ts` (port `cellMovie` and its types from
`origin/feat/cala-factor-live-refine`, unchanged), `e2e/cala-live.spec.ts`.

- [ ] **Step 1: Port `cellMovie`** (`git show origin/feat/cala-factor-live-refine:apps/cala/src/__tests__/synth-avi.ts`;
      copy only `cellMovie`, `CellMovie` and the helpers they use). Run the app checks.
- [ ] **Step 2: Write the test** (after the existing ones; `startSim`, `PORT` are the file's):

```ts
test('Cala: with ?factors a live stream settles and extracts on its factors after it ends', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-factors-e2e-'));
  // 1,850 frames: three whole windows and a last one of 50.
  const movie = cellMovie(96, 96, 1850);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: 1850, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  await startSim(folder);
  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&factors&debug`);
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('live-stage-note')).toContainText('factors');
  // The settle on the factors, then Extract on them, by themselves.
  await expect(page.getByTestId('pass2-status')).toContainText(
    "Extract done (on the stream's factors)",
    {
      timeout: 180_000,
    },
  );
  const st = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __cala: {
          cells: {
            status(): {
              final: boolean;
              lookback?: { settle?: { source?: string; fed: number; done: boolean } };
            };
          };
        };
      }
    ).__cala;
    return c.cells.status();
  });
  expect(st.final).toBe(true);
  expect(st.lookback?.settle).toMatchObject({ source: 'factors', done: true });
  expect(st.lookback!.settle!.fed).toBeGreaterThan(0);
  // The export: Extract's traces, the live traces, the sources and the note.
  const npz = await exportNpz(page);
  const names = npzNames(npz);
  expect(names).toEqual(
    expect.arrayContaining(['traces.npy', 'traces_signed.npy', 'traces_live.npy']),
  );
  const meta = metaText(npz);
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"source":"factors"');
  expect(meta).toContain('there was no file to re-read');
});
```

`exportNpz`, `metaText` and `npzNames` come from #442's `e2e/cala-helpers.ts` (port the three functions into
`e2e/cala-helpers.ts`; `npzNames` lists the archive's entry names; write it if #442 has none, reading local file
headers as `metaText` does). Check the data-testids against `RunPanel.tsx`; if one differs, use the panel's.

- [ ] **Step 3: Run the live e2e** (Global Constraints). Expected: the new test and the existing ones pass. If the
      cell movie gives no cells at 200 fps, lower the sim's `--fps` to 50 for this test (the e2e asserts no time).
- [ ] **Step 4: Commit:**

```bash
git commit -m "test(cala): e2e for a ?factors stream that settles, extracts and exports both trace sets"
```

---

### Task 13: Speed check in headed Chrome

**Files:** modify `apps/cala/scripts/live-measure.mjs`; create
`tools/cala-eval/results/<run date>-factors-live-speed.md`. No app code.

- [ ] **Step 1: Extend `live-measure.mjs`** (read it first; keep its outputs):
  - `--query <params>` appended to the app URL (`factors`); `--frames N` passed to `live-sim.mjs`; `--tag` names the
    output files.
  - Every second while the stream runs and after, sample through `__cala`: the compress status (`msPerFrame`,
    `pending`, `pendingFrames`, `windows`), the slow status (`skipped`, `lookback.settle`), the pipeline's live
    counters (the forward-pool drops the script already records), `pass2` status and `processed`.
  - Derive and write in `<tag>_metrics.json`:
    - compressor: mean `msPerFrame` over windows; the largest `pending` while streaming; `pending` and
      `pendingFrames` at the stream's end; seconds from the stream's end to the last window compressed;
    - frames dropped for the slow loop (the script's existing measure);
    - settle: wait seconds (end → `waiting` false), settle seconds (`waiting` false → `final`), frames fed;
    - Extract: seconds (`running` → `done`) and frames;
    - per minute of stream: settle and Extract seconds divided by stream minutes.
  - Without `--query factors` the settle and Extract fields are absent (a stream ends at Discover).
- [ ] **Step 2: Run the check** (the owner's machine, headed Chrome, the dev server running):
  - Recording: the minisim `motion_s5` (600x600), found as `live-sim.mjs` documents (`$SIM_MOTION_S5`); read-only.
  - `--fps 20 --frames 3600 --headed`, 6 runs interleaved: without, with, without, with, without, with.
  - Nothing else heavy running; note the load average at each start.
- [ ] **Step 3: Write the report** (`tools/cala-eval/results/<date>-factors-live-speed.md`, prettier applied): what
      was run (commit, machine, Chrome version), one table per measure (run, with/without, value), the spec's speed
      lines checked:
  - no window waited longer than one window (30 s) to be compressed, and nothing beyond the last window was queued
    at the end;
  - the frames dropped for the slow loop with `?factors` against without (the spread of the 3 runs each);
  - settle and Extract seconds per minute of stream (the owner sets the line after this report).
  - Limits: one recording, 3 runs each, one machine.
- [ ] **Step 4: Commit** the script change and the report:

```bash
git commit -m "docs(cala-eval): speed of a 600 px stream at 20 fps with and without ?factors in Chrome"
```

---

### Task 14: Docs

**Files:** `apps/cala/docs/stages.md`, `apps/cala/README.md` ("Compression"), `apps/cala/USER_GUIDE.md` if it
describes live streams, `docs/CHANGELOG.md` (Unreleased).

- [ ] **Step 1: Write.**
  - `stages.md`: a live stream with `?factors` (experimental): after the stream, the Final settle waits for the last
    factor window and settles on frames rebuilt from the factors; Extract follows on the factors. Without it, as
    before.
  - README: `?factors` (offset grids, the run folder lock, `?review` off with it, OPFS use of about 55 MB per 1,000
    frames at 600 px).
  - Changelog: "cala: `?factors` (experimental): a live stream settles and extracts on its own factors after it ends;
    its export keeps the live traces (`traces_live`) beside Extract's and is format version 7. Exports without these
    fields stay at version 6."
- [ ] **Step 2: Prettier on the touched files; commit:**

```bash
git commit -m "docs(cala): what ?factors does for a live stream"
```

---

## Not in this slice

- Files: `?factors` on a recording settles and extracts on re-read frames as today (slice 3).
- Look-back on factors during a stream; any change to a file's look-back.
- `FactorExtractor` (speed), `min_valid` in the export, parallel compression, a storage quota.
- Changing any default (slice 4, after the owner's decision).

## Self-review notes

- **Spec coverage.**
  - Decision 2 (main's settle on rebuilt frames): Tasks 4, 5, 7.
  - Decision 4 (Extract on rebuilt frames; `ready`, `compressing`, `unusable`; a stream waits, can cancel, is blocked
    when unusable): Tasks 3, 9.
  - Decision 5 (the stream: last window, settle at the chosen level, Extract after; `refine`; the export with both
    trace sets, the sources and the note): Tasks 1, 6, 7, 8, 9, 10.
  - Decision 6 (Chrome speed lines): Task 13.
  - Slice 1's "Later slices" items 1-12 map to Tasks 1, 2, 3, 5, 6, 7, 9, 10, 11, 12, 13, 14; Tasks 4 and 8 are new
    (the shared rebuild with NaN, the main-thread controller).
- **Names across tasks.**
  - Task 1: `FACTOR_TILING`, `factorRunPlan`, `FactorRunPlan`, `FACTORS_REVIEW_OFF`, `CellsSettings.compressTiling`,
    `CellsSettings.factorSettle`, `pipeline.setFactors`, `pipeline.factorRun`.
  - Task 2: `COMPRESS_ROOT`, `pinned`, `isPinned`, `Locks`, `WindowStore.folder`, `WindowStore.readAll`, `FactorFiles`,
    `factorFiles`, `CompressedWindow`, `CompressStatus.folder`, `CompressStatus.compressed`.
  - Task 3: `FactorState`, `FactorInfo`, `factorCoverage`, `factorState`, `factorsBlocked`, `FACTOR_STALL_MS`,
    `FactorWatchdog`, store `factors`, `factorInfo`, `fail`, `changed`, `onExtract`.
  - Task 4: `WindowFactors::never_valid`, `FactorWindow.neverValid`, `FactorWindowLike`, `rebuildFrames`.
  - Task 5: `FactorSource`, `FrameServer`, `FactorSolver`, `FactorReader`, `FACTOR_CACHE`, `beginFactors`.
  - Task 6: `FACTOR_SETTLE`, `SlowInit.factorSettle`, `FastLoopOptions.factorSettle`.
  - Task 7: `SlowFactors`, `SlowRunner.factors`, `factorOn`, `factorWait`, `factorLive`, `lbServes`, `sendLibrary`,
    `waitView`, `SettleStatus.{source, waiting, error}`, `SlowClient.{factorsReady, factorsFailed}`.
  - Task 8: `FactorSettle`, `FactorSettleInput`, `FactorSettleAction`, `FACTOR_STALL_TEXT`.
  - Task 9: `extract`, `extract-cancel`, `extracted`, `extract-done`, `CompressRunner.{extract, extractCancel}`,
    `FactorJob`, `FactorExtractPort`, `createFactorExtract`, `Pass2Result.{source, factors}`, `pass2.waiting`,
    `StageInput.liveFactors`.
  - Task 10: `StageRun.{settleSource, source, factors}`, `ExportInput.{liveTraces, notes}`, `exportFormatVersion`,
    `FACTORS_EXPORT_NOTE`, `factorTailNote`.
  - Task 11: `StepInput.factorRun`, `FACTORS_LIVE_NOTE`.
- **Faults of earlier plans checked.**
  - Every new state has its releases in the table. Tests cover the releases that can hang (Tasks 3, 7, 8, 9); the
    rest are one-line resets in `drop()`/`clear()` (reduced testing, Global Constraints).
  - Every pending request settles: the settle requests as today; the wait by five releases; an Extract job by five;
    `changed()` by three.
  - Each test fails without its feature, except Task 6's Rust pin (said there).
  - No test depends on machine speed: the watchdog and the controller take times as arguments; the e2e asserts no
    time; the speed check is a report.
  - Defaults that change an export: none without `?factors`. With it, format 7 and the new fields (decision 6, the
    changelog).
- **What could not be verified by reading.**
  - That `getFile()` on a factor file the compress worker closed works from another worker while the compress worker
    holds access handles on other files of the folder (inferred from the File System spec: `getFile` takes no lock).
    The e2e exercises it.
  - That `TraceEngine` built from a library in the look-back worker matches what `LookbackReader` uses (it does the
    same calls).
  - That `start(cfg, &[])` exists in the Rust test helpers with an empty seed (Task 6 says what to do otherwise).
  - That the cell movie gives cells at the e2e's stream speed (Task 12 says what to do otherwise).
  - The exact data-testids and fixtures of the e2e and `pipeline.test.ts`; each task says to read them first.
  - Chrome's behaviour of a 600 px stream with one more worker (the speed check measures it).
