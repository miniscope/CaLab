# cala factors, slice 3: a recording's Final settle and Extract on its factors (`?factors=file`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** with `?factors=file`, a recording's Discover also compresses its frames on the offset grids. At Discover's
end the Final settle reads frames rebuilt from those factors when they are complete, and Extract solves on them when
they are ready. Otherwise both re-read the file as today, and the Run panel and the export say why. Without
`?factors=file` nothing changes.

**Architecture:**

- Discover is unchanged. The compress worker compresses Discover's frames on the offset grids, as for a `?factors`
  stream (slice 2).
- A recording's settle already runs with look-back on: look-back worker 0 re-reads the file during Discover and serves
  the settle. With `?factors=file`, at Discover's last frame the slow loop asks the main thread whether the factors
  are complete (a short state, `factorWait` with `file`). The main thread answers from the compressor's status:
  - complete: the slow worker tells look-back worker 0, over the port that carries its requests, to switch its frame
    server to a `FactorReader`; then the settle runs as today (`startDrain`) on rebuilt frames;
  - not complete: the settle runs on the file at once, with the reason.
- Extract: when it starts, `ready` factors → slice 2's Extract job in the compress worker (`runFactors`); otherwise
  the replay of the file as today, with the reason. It never waits.
- The export records each stage's source and, for the file, the reason.

**Tech Stack:** TypeScript with SolidJS and vitest (`apps/cala`), Web Workers, OPFS; Playwright (e2e and the
measurement). No Rust change.

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`: decision 1 (Discover's own windows,
offset grids; the pace at 600 px), decision 2 (main's settle on rebuilt frames), decision 4 (a file never waits;
Extract replays and says why), decision 6 (speed), section 7 (PR 3, `?factors=file`). Slice 1's list of six items
(`docs/superpowers/plans/2026-11-23-cala-factors-settle-slice1.md`, "Later slices", Slice 3).

**Base:** `feat/cala-factors-live` (PR #494, open), which is based on `feat/cala-factors-settle` (PR #493). The PR goes
to whatever #494 has merged into by then, else to `feat/cala-factors-live`.

## Decided for the owner's review

Each says what would change it.

1. **What the switch means.**
   - `?factors=file` on a recording: compression on the offset grids, the settle and Extract on factors when they
     are complete (below).
   - `?factors=file` on a live stream: the same as `?factors` (slice 2); a stream has no file.
   - `?factors` alone on a recording: unchanged from slice 2 (a `?compress` run on plain tiles).
   - A Joint run of several sessions with `?factors=file`: as `?factors` on a recording (plain tiles), with a console
     line. Joint runs on factors are out of the spec's scope.
   - A recording run without look-back has no Final settle on `main`; only Extract can then read the factors.
   - The back-fill does not run on a `?factors=file` run (Extract solves on the factors; the back-fill would solve the
     same frames again in the same worker).
   - What would change it: the owner wants `?factors` alone to mean files too.
2. **"Every window compressed at Discover's end", made deterministic.**
   - At Discover's last frame the compressor is always still busy with the window that end closes (the last, shorter
     one): at 600 px that is up to 15-18 s of compression (slice 2's report: 17-18 s waiting for the last window), at
     200 px about 2 s. Read strictly, the settle would almost never read the factors, and whether it does would be a
     race, also in the e2e.
   - Proposed: at Discover's last frame the main thread looks once at how far the compressor is behind (frames Discover
     read minus frames compressed). More than one window (600 frames) behind: the settle re-reads the file at once,
     with the reason. At most one window behind: the settle waits for that last window only, then reads the factors.
     The wait is bounded by one window's compression; the watchdog (120 s without compressor progress) and a slow-side
     deadline (150 s) end it on the file.
   - What would change it: the owner wants the strict reading (no wait at all). Then Task 2's rule becomes "ready at
     the first look, else the file", and the e2e cannot assert the factor path (it would depend on machine speed); it
     would assert only that one of the two sources is reported.
3. **Extract never waits.** When it starts, `ready` factors are read; otherwise the file is replayed with the reason.
   After a settle on factors they are always `ready`. After a settle on the file Extract reads the factors only if the
   compressor caught up during the settle.
4. **A recording's factors must cover every frame.** A one-frame tail (a window of one frame cannot be compressed)
   sends both stages to the file, with the reason. So Extract on factors always returns every frame of the recording
   and the export's length never changes (slice 2's tail rule stays for streams only).
5. **The look-back worker switches its source; it is not begun anew.** The slow worker sends the switch over the port
   that carries the settle's requests, so every settle request after it reads the factors and a Discover request
   still out finishes on the file. The worker keeps the newest library and hands it to the new server, so the order
   of the switch and a library message does not matter. The file reader stays open until the run's reset.
6. **The export of a `?factors=file` run.**
   - Discover's stage record: `settle_source` `'factors'` or `'file'`, and `settle_source_reason` with `'file'`.
   - Extract's record: `source` `'factors'` (with slice 2's `factor_tiling`, `factor_windows`, `factor_mean_rank`) or
     `'file'`, and `source_reason` with `'file'`.
   - `meta_json.notes`: one line on what each stage read. When Extract read the factors, a second line that its
     traces are solved on low-rank frames and carry less per-frame noise.
   - No `traces_live` (a recording has Extract's traces only). The CaDecon file gets Extract's signed traces as always.
   - `format_version` 7 for these exports (slice 2's rule: 7 only with the new fields); every export without the
     switch stays 6, byte for byte.
   - What would change it: the owner wants `'file'` left out when the switch was on but the file was read. Then a run
     that fell back exports as without the switch.
7. **What a user sees on a 600 px recording.** At 600 px a file is read faster than one compress worker compresses
   (about 40 frames/s; spec decision 1), so the compressor is usually far behind at Discover's end.
   - Run panel during the settle: "Final settle (re-reads the file: the compressor was 4,210 frames, about 105 s,
     behind when Discover ended): 1,200 / 9,000 frames".
   - Extract: on the factors if the compressor caught up during the settle, else "Extract done (re-read the file:
     1,800 frames are still being compressed)".
   - Compression goes on in the background; the status bar shows its queue as today.
   - The measurement (Task 9) says how often each path is taken at 600 and 200 px.
8. **Measurement: once per recording, with and without the switch.** Headed Chrome, `live-measure.mjs --mode file`:
   minisim `motion_s5` (600x600) and the wireless `wl24_20251201` (200x200), one run with `?factors=file` and one
   without each. It records which source each stage took and why, the compressor's lag at Discover's end, and the
   settle and Extract wall times. A report, no line to pass.

## Global Constraints

- **Testing scope (owner: less testing, as in slices 1 and 2).** Unit tests only for logic that can hang or lose data:
  the main thread's choice (Task 2), the worker's source switch keeping the library (Task 3), the slow loop's short
  wait and its releases (Task 4), Extract's choice never waiting (Task 6), the export version (Task 7). One e2e
  (Task 8) and the measurement (Task 9). Wiring and UI text are covered by the e2e.
- **Without `?factors=file` nothing changes.** The same messages, the same slow-loop path at Discover's end
  (`startDrain` at once), the same exports (`format_version` 6). Slice 2's tests and both e2e specs pass unchanged,
  apart from Task 1's added `factorFile: false` in `factorRunPlan`'s expectations.
- **Every state says what releases it** (table below), and every pending request settles (Review Focus 2).
- No test depends on machine speed: fake clocks and timers in unit tests; the e2e's recording is shorter than one
  window, so its only window is the last one (Decision 2), and the e2e asserts no time.
- Each new test fails without its feature (a missing symbol, or an assertion on new behaviour).
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare
  vitest), `npx prettier --check` on every touched file.
- e2e, from the repository root: `npm run build:e2e`, then `npx playwright test e2e/cala-factors.spec.ts`, and the
  existing `e2e/cala.spec.ts` and `e2e/cala-live.spec.ts`.
- Commits: one sentence, conventional prefix, no body, no co-author trailer, no tool or assistant attribution. Never
  amend. Do not push.
- No machine paths, user names or emails in committed files (the measurement report names datasets, not paths).
- The shell refuses long compound commands: anything longer goes in a script under the git-ignored `.scratch/`.
- Branch: `feat/cala-factors-file`.

### States and what releases them

| state (where)                                                                    | Stop                                                                   | failure                                                                                                     | a new Discover                                            | a worker crash                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| the slow loop asks about the factors (`SlowRunner.factorWait` with `file: true`) | Stop settling: final library = Discover's (as a stream's wait)         | `factors` with `ready: false` → the settle on the file; no answer within `FACTOR_ASK_MS` (150 s) → the file | `init`/`reset` → `drop()` (clears the wait and its timer) | compress worker: its error makes the factors `unusable` → `ready: false` → the file; look-back worker: nothing is out (requests cancelled at the ask) |
| the main thread's choice (`FileSettleChoice`, one answer per session)            | the slow loop stops waiting; a late answer is ignored by `factors()`   | `unusable` → `file`; the watchdog (120 s without progress) marks the factors `unusable` → `file`            | a new session (the choice is keyed by session)            | via `unusable`                                                                                                                                        |
| the settle on factors after the switch (`SlowRunner.drain` with `factorLive`)    | Stop settling (as today)                                               | an `error` answer → `lookbackFailed` → last round (as today)                                                | `drop()`                                                  | look-back worker: its request times out after `LOOKBACK.timeoutMs` (60 s) → `lookbackFailed` → last round                                             |
| the look-back worker's switched server (`Run.slot` in `lookback-worker.ts`)      | -                                                                      | an error answer per request                                                                                 | `begin`/`reset` → `stop()` disposes both servers          | the worker is gone; the slow side times out (row above)                                                                                               |
| Extract's choice (`pass2-store` `run`)                                           | - (no wait: it reads the factors or replays at once)                   | -                                                                                                           | -                                                         | -                                                                                                                                                     |
| Extract job on the factors, the replay                                           | as slice 2 and today (`extract-cancel`, `cancel()`; the replay's stop) | as slice 2 and today                                                                                        | as slice 2 and today                                      | as slice 2 and today                                                                                                                                  |

## Review Focus

1. **Nothing changes without `?factors=file`.** `factorFile` is set only by `factorRunPlan` for a recording (not
   Joint) with the switch and Discover; `SlowRunner.end` goes to the new ask only with `factorFile && lbOn && !lbError`;
   `pass2-store` asks the port for a mode only when one is given. Pinned: Task 1's test, Task 4's "a look-back run
   without factorFile settles at once", Task 7's "an export without stage sources stays 6", the unchanged e2e specs.
2. **A pending request always settles.**
   - The ask: answer (ready or not), Stop settling, the 150 s deadline, `drop()`. Pinned: Task 4's tests (one per
     release).
   - The main thread's choice answers once per session, at once when the compressor is more than a window behind, else
     at `ready`, `unusable` or the watchdog. Pinned: Task 2.
   - A settle request after the switch: answer, error, 60 s timeout, `cancelRequests` (as today).
   - Extract never waits on a file run: `changed()` is never awaited when the mode is `'file'`. Pinned: Task 6.
3. **The settle reads one source.** Discover's requests still out are cancelled at the ask, the switch goes over the
   request port, and every settle request is sent after it. A settle never mixes file and factor frames.
4. **The library reaches the factor server.** The worker keeps the newest library and gives it to the new server at
   the switch (Task 3), and the slow loop sends it again after the switch (Task 4). A factor server without a library
   would solve no traces.
5. **The look-back worker never creates, lists or removes a file** (slice 2's `factorFiles`, unchanged), and reads
   only windows the compress status listed.
6. **The export never changes its length.** Factors that do not cover every frame send Extract to the file
   (Decision 4).

## File Structure

| File                                                                                                           | Change | Responsibility                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `apps/cala/src/lib/factor-run.ts`                                                                              | modify | `factorRunPlan` gains `factorFile`; the texts of a file run                                        |
| `apps/cala/src/App.tsx`, `lib/pipeline-store.ts`, `workers/frame-types.ts`, `workers/slow-types.ts`            | modify | parse `?factors=file`; `factorFileRun()`; `CellsSettings.factorFile`, `SlowInit.factorFile`        |
| `apps/cala/src/workers/trace-worker.ts`, `workers/frame-worker.ts`                                             | modify | pass `factorFile` to the slow loop's init                                                          |
| `apps/cala/src/lib/compress-store.ts`                                                                          | modify | `factorState`'s `tail` option, `fileFactorsBlocked`, `fileFactors()`, `behind()`                   |
| `apps/cala/src/lib/factor-settle.ts`                                                                           | modify | `FileSettleChoice` (the main thread's answer for a recording)                                      |
| `apps/cala/src/lib/server-slot.ts`                                                                             | create | `ServerSlot`: the look-back worker's current frame server and the newest library                   |
| `apps/cala/src/workers/lookback-worker.ts`, `workers/lookback-types.ts`                                        | modify | `SlowToLookback` `factors`: switch to a `FactorReader`                                             |
| `apps/cala/src/lib/slow-runner.ts`, `workers/slow-worker.ts`, `lib/slow-client.ts`                             | modify | the ask at Discover's end, the switch, `fileReason`, `FACTOR_ASK_MS`                               |
| `apps/cala/src/lib/factor-extract.ts`, `lib/pass2-store.ts`                                                    | modify | `mode()`; Extract's choice; `source: 'file'` with `sourceReason`                                   |
| `apps/cala/src/lib/run-stages.ts`, `lib/export.ts`, `components/RunPanel.tsx`, `lib/lookback-text.ts`          | modify | stage sources and reasons, notes, texts                                                            |
| `apps/cala/src/__tests__/*.test.ts`                                                                            | modify | tests per task (named in each task)                                                                |
| `e2e/cala-factors.spec.ts`                                                                                     | create | a recording with `?factors=file` settles and extracts on its factors; without the switch unchanged |
| `apps/cala/scripts/live-measure.mjs`                                                                           | modify | `--query` in file mode; the source and lag metrics                                                 |
| `tools/cala-eval/results/2026-11-2x-factors-file-speed.md`                                                     | create | the measurement (date of the run)                                                                  |
| `apps/cala/docs/stages.md`, `apps/cala/README.md`, `apps/cala/USER_GUIDE.md` (if present), `docs/CHANGELOG.md` | modify | docs                                                                                               |

---

### Task 1: `?factors=file` makes a recording a factor run on the offset grids

**Files:** modify `lib/factor-run.ts`, `__tests__/factor-run.test.ts`, `App.tsx` (the `?factors` block near
`App.tsx:145-151`, `pipeline.setFactors` near `App.tsx:262`, the back-fill effect near `App.tsx:420`),
`lib/pipeline-store.ts` (`start`, near `pipeline-store.ts:1061-1104`; `reset`; the returned object),
`workers/frame-types.ts` (`CellsSettings`), `workers/slow-types.ts` (`SlowInit`), `workers/trace-worker.ts:75` and
`workers/frame-worker.ts:268` (the slow init).

**Interfaces:**

- `FactorRunPlan.factorFile: boolean`
- `factorRunPlan(o: { live; factors; factorsFile?: boolean; compress; discover; joint?: boolean }): FactorRunPlan`
- `CellsSettings.factorFile?: boolean`, `SlowInit.factorFile?: boolean`
- `pipeline.setFactorsFile(on: boolean, joint: () => boolean)`, `pipeline.factorFileRun(): boolean`
- `const FACTORS_FILE_JOINT: string`

- [ ] **Step 1: Failing test.** In `factor-run.test.ts`, add `factorFile: false` to every existing `toEqual` and add:

```ts
describe('factorRunPlan with ?factors=file', () => {
  const base = { live: false, factors: false, compress: false, discover: true };
  it('a recording compresses on the offset grids and is a factor file run', () => {
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: false,
      factorFile: true,
    });
  });
  it('a stream with ?factors=file is a ?factors stream', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true, factorsFile: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: true,
      factorFile: false,
    });
  });
  it('a Joint run or a run without Discover is a plain ?compress run', () => {
    const plain = { compress: 'plain', factorSettle: false, factorFile: false };
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true, joint: true })).toEqual(
      plain,
    );
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true, discover: false })).toEqual(
      plain,
    );
  });
});
```

- [ ] **Step 2: Run it; expect failures** (no `factorFile`).
- [ ] **Step 3: Implement.** `factor-run.ts` (doc comment: slice 3 adds recordings behind `?factors=file`):

```ts
export interface FactorRunPlan {
  compress: CompressTiling | null;
  factorSettle: boolean;
  /** A recording with `?factors=file`: the settle and Extract read the factors when complete (`SlowInit.factorFile`). */
  factorFile: boolean;
}

export function factorRunPlan(o: {
  live: boolean;
  factors: boolean;
  factorsFile?: boolean;
  compress: boolean;
  discover: boolean;
  joint?: boolean;
}): FactorRunPlan {
  const none = { factorSettle: false, factorFile: false };
  if (o.factors && o.live && o.discover)
    return { compress: FACTOR_TILING, factorSettle: true, factorFile: false };
  if (o.factorsFile && !o.live && o.discover && !o.joint)
    return { compress: FACTOR_TILING, factorSettle: false, factorFile: true };
  if (o.factors || o.compress) return { compress: 'plain', ...none };
  return { compress: null, ...none };
}

export const FACTORS_FILE_JOINT =
  'cala: ?factors=file does not apply to a Joint run of several sessions; it runs as ?compress (plain tiles).';
```

`CellsSettings` and `SlowInit`, after `factorSettle`:

```ts
  /** A recording with `?factors=file`: at Discover's end the settle may read the factors (`SlowRunner`). */
  factorFile?: boolean;
```

`trace-worker.ts` and `frame-worker.ts`, in the slow init beside `factorSettle`:

```ts
          ...(cells?.factorFile && !cells.library && cells.lookback ? { factorFile: true } : {}),
```

(`factorFile` reaches the slow loop only with look-back: a run without look-back has no settle.)

`pipeline-store.ts`: signals `factorsFile` (false), `factorFileRun` (false) and a `joint` accessor
(`let jointOf: () => boolean = () => false`); `reset()` sets `setFactorFileRun(false)`. In `start()`:

```ts
const runPlan = factorRunPlan({
  live: flat.identity?.()?.live === true,
  factors: factors(),
  factorsFile: factorsFile(),
  compress: compress !== undefined,
  discover: discover(),
  joint: jointOf(),
});
setFactorRun(runPlan.factorSettle);
setFactorFileRun(runPlan.factorFile);
if (factorsFile() && jointOf()) console.warn(FACTORS_FILE_JOINT);
```

and beside `...(runPlan.factorSettle ? { factorSettle: true } : {})`:

```ts
          ...(runPlan.factorFile ? { factorFile: true } : {}),
```

Return:

```ts
    setFactorsFile(on: boolean, joint: () => boolean): void {
      setFactorsFile(on);
      jointOf = joint;
    },
    factorFileRun,
```

`App.tsx`:

```ts
// `?factors` (experimental): a live stream settles and extracts on the factors Discover writes.
// `?factors=file` also lets a recording's settle and Extract read them when complete.
const factors = params.has('factors');
const factorsFile = params.get('factors') === 'file';
```

after the pipeline store is built:

```ts
if (factors) pipeline.setFactors(true);
if (factorsFile)
  pipeline.setFactorsFile(true, () => {
    const s = store.source();
    return s !== null && 'sessions' in s;
  });
```

and the back-fill effect returns early on either factor run:

```ts
if (pipeline.factorRun() || pipeline.factorFileRun()) return;
```

- [ ] **Step 4: Run the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): ?factors=file makes a recording a factor run, compressed on the offset grids"
```

---

### Task 2: The main thread's answer for a recording: factors, the last window, or the file

**Files:** modify `lib/compress-store.ts`, `lib/factor-settle.ts`, `lib/factor-run.ts` (texts),
`__tests__/factor-settle.test.ts`, `__tests__/compress-store.test.ts` (if it exists; else the state test goes in
`factor-settle.test.ts`).

**Interfaces:**

- `factorState(s, error, ended, frames, tail = true)`: with `tail: false` the windows must cover exactly `frames`
- `fileFactorsBlocked(state: FactorState, s: CompressStatus | null, error: string | null, frames: number): string | null`
- store: `fileFactors(ended: boolean, frames: number): FactorState`, `behind(frames: number): number`
- `interface FileSettleInput`, `type FileSettleAction`, `class FileSettleChoice`
- `fileBehindText(behind: number, msPerFrame: number): string`, `const FACTOR_TAIL_FILE: string`

- [ ] **Step 1: Failing tests** (`factor-settle.test.ts`):

```ts
import { factorState } from '../lib/compress-store.ts';
import { FileSettleChoice, type FileSettleInput } from '../lib/factor-settle.ts';

describe('factorState for a recording (no tail)', () => {
  const status = (frames: number[]) => ({
    windows: frames.length,
    frames: frames.reduce((a, b) => a + b, 0),
    pending: 0,
    pendingFrames: 0,
    meanRank: 3,
    msPerFrame: 1,
    factorBytes: 0,
    final: true,
    tiling: 'offset' as const,
    source: 'discover' as const,
    folder: 'run-a',
    compressed: frames.map((f, i) => ({ index: i, start: i * 600, frames: f })),
  });
  it('is ready only when the windows cover every frame', () => {
    expect(factorState(status([600, 400]), null, true, 1000, false)).toBe('ready');
    expect(factorState(status([600, 399]), null, true, 1000, false)).toBe('unusable');
    expect(factorState(status([600, 399]), null, true, 1000)).toBe('ready'); // a stream keeps its tail rule
  });
});

describe('FileSettleChoice', () => {
  const info = {
    folder: 'run-a',
    tiling: 'offset' as const,
    windows: [],
    frames: 1000,
    meanRank: 3,
  };
  const at = (o: Partial<FileSettleInput>): FileSettleInput => ({
    session: 1,
    factorFile: true,
    waiting: true,
    state: 'compressing',
    reason: '2 windows (1,000 frames) are still being compressed.',
    info,
    behind: 400,
    window: 600,
    msPerFrame: 25,
    width: 8,
    height: 8,
    ...o,
  });

  it('more than a window behind at the first look: the file at once, with the lag', () => {
    const c = new FileSettleChoice();
    const a = c.act(at({ behind: 4210 }));
    expect(a).toMatchObject({ kind: 'file', session: 1 });
    expect(a.kind === 'file' && a.reason).toContain('4,210 frames');
    expect(c.act(at({ state: 'ready' }))).toEqual({ kind: 'none' }); // answered once
  });

  it('at most a window behind: waits for it, then the factors', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ behind: 400 }))).toEqual({ kind: 'none' });
    // Later looks never send it to the file for the lag (only the first look decides that).
    expect(c.act(at({ behind: 900 }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'ready', behind: 0 }))).toEqual({
      kind: 'factors',
      session: 1,
      frames: 1000,
      factors: { folder: 'run-a', windows: [], width: 8, height: 8 },
    });
  });

  it('unusable factors (an error, the watchdog, a one-frame tail): the file with the reason', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ behind: 400 }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'unusable', reason: 'stalled' }))).toEqual({
      kind: 'file',
      session: 1,
      reason: 'stalled',
    });
  });

  it('nothing without the switch or while the slow loop does not ask; a new session asks again', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ factorFile: false, state: 'ready' }))).toEqual({ kind: 'none' });
    expect(c.act(at({ waiting: false, state: 'ready' }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'ready' }))).toMatchObject({ kind: 'factors', session: 1 });
    expect(c.act(at({ session: 2, state: 'ready' }))).toMatchObject({
      kind: 'factors',
      session: 2,
    });
  });
});
```

- [ ] **Step 2: Run; expect failures** (no `tail`, no `FileSettleChoice`).
- [ ] **Step 3: Implement.** `compress-store.ts`, `factorState` gains `tail = true` and its last line becomes:

```ts
const c = factorCoverage(s.compressed);
const covers = tail ? c.frames <= frames && c.frames >= frames - 1 : c.frames === frames;
return c.gap === null && c.frames >= 2 && covers ? 'ready' : 'unusable';
```

and below `factorsBlocked`:

```ts
/** Why a recording's settle or Extract re-reads the file (null: the factors can be read). */
export function fileFactorsBlocked(
  state: FactorState,
  s: CompressStatus | null,
  error: string | null,
  frames: number,
): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'compressing': {
      const left = Math.max(0, frames - (s?.frames ?? 0));
      return `${left.toLocaleString('en-US')} frames are still being compressed.`;
    }
    case 'unusable':
      if (error) return `The factors cannot be read: ${error}`;
      return s && factorCoverage(s.compressed).frames === frames - 1
        ? FACTOR_TAIL_FILE
        : 'The factors do not cover the recording.';
    default:
      return 'This run has no factors.';
  }
}
```

In the store:

```ts
    /** The state of a recording's factors (every frame covered; `frames`: what Discover read). */
    fileFactors(ended: boolean, frames: number): FactorState {
      return factorState(status(), error(), ended, frames, false);
    },
    /** Frames Discover read that are not compressed yet. */
    behind(frames: number): number {
      return Math.max(0, frames - (status()?.frames ?? 0));
    },
```

`factor-run.ts`:

```ts
export const FACTOR_TAIL_FILE =
  'The last frame is not in the factors (a window of one frame cannot be compressed).';

/** Why a recording's settle re-reads the file: how far the compressor was behind at Discover's end. */
export function fileBehindText(behind: number, msPerFrame: number): string {
  const s = msPerFrame > 0 ? `, about ${Math.round((behind * msPerFrame) / 1000)} s,` : '';
  return `the compressor was ${behind.toLocaleString('en-US')} frames${s} behind when Discover ended`;
}
```

`factor-settle.ts`:

```ts
export interface FileSettleInput {
  session: number;
  /** This run is a recording with `?factors=file` (`pipeline.factorFileRun()`). */
  factorFile: boolean;
  /** The slow loop asks (`SettleStatus.waiting`). */
  waiting: boolean;
  state: FactorState;
  /** Why the factors cannot be read (`fileFactorsBlocked`). */
  reason: string | null;
  info: FactorInfo | null;
  /** Frames Discover read minus frames compressed (`CompressStore.behind`). */
  behind: number;
  /** Frames per window (`COMPRESS_DEFAULTS.window`). */
  window: number;
  /** The compressor's last ms per frame (for the reason's seconds). */
  msPerFrame: number;
  width: number;
  height: number;
}

export type FileSettleAction =
  | { kind: 'none' }
  | { kind: 'factors'; session: number; frames: number; factors: FactorSource['factors'] }
  | { kind: 'file'; session: number; reason: string };

/**
 * The main thread's answer when a recording's slow loop asks at Discover's
 * end (spec decision 4, slice 3): the factors when they cover every frame;
 * at the first look, the file at once when the compressor is more than one
 * window behind; otherwise wait for that last window. One answer per session.
 */
export class FileSettleChoice {
  private answered = -1;
  private looked = -1;

  act(i: FileSettleInput): FileSettleAction {
    if (!i.factorFile || !i.waiting || this.answered === i.session) return { kind: 'none' };
    if (i.state === 'ready' && i.info) {
      this.answered = i.session;
      return {
        kind: 'factors',
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
    if (i.state === 'unusable' || i.state === 'none') {
      this.answered = i.session;
      return {
        kind: 'file',
        session: i.session,
        reason: i.reason ?? 'The factors cannot be read.',
      };
    }
    if (this.looked !== i.session) {
      this.looked = i.session;
      if (i.behind > i.window) {
        this.answered = i.session;
        return { kind: 'file', session: i.session, reason: fileBehindText(i.behind, i.msPerFrame) };
      }
    }
    return { kind: 'none' };
  }
}
```

(The test's `toContain('4,210 frames')` matches `fileBehindText`.)

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): the main thread answers a recording's settle with its factors, its last window or the file"
```

---

### Task 3: Look-back worker 0 switches its frame server to the factors

**Files:** create `lib/server-slot.ts`, `__tests__/server-slot.test.ts`; modify `workers/lookback-types.ts`
(`SlowToLookback`), `workers/lookback-worker.ts`.

**Interfaces:**

- `class ServerSlot { constructor(server: FrameServer); get server(): FrameServer; setLibrary(version, bytes): void; swap(next: FrameServer): FrameServer }`
- `SlowToLookback`: `| { type: 'factors'; session: number; factors: FactorSource['factors'] }`

- [ ] **Step 1: Failing test** (`server-slot.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { ServerSlot } from '../lib/server-slot.ts';
import type { FrameServer } from '../lib/factor-reader.ts';

const fake = () => {
  const libs: number[] = [];
  const s: FrameServer = {
    setLibrary: (v) => void libs.push(v),
    serve: () => Promise.reject(new Error('unused')),
    dispose: () => {},
  };
  return { s, libs };
};

describe('ServerSlot', () => {
  it('hands the newest library to the server it switches to, and later ones to it only', () => {
    const a = fake();
    const b = fake();
    const slot = new ServerSlot(a.s);
    slot.setLibrary(3, new Uint8Array(1));
    slot.setLibrary(4, new Uint8Array(1));
    expect(slot.swap(b.s)).toBe(a.s);
    expect(slot.server).toBe(b.s);
    expect(b.libs).toEqual([4]);
    slot.setLibrary(5, new Uint8Array(1));
    expect(a.libs).toEqual([3, 4]);
    expect(b.libs).toEqual([4, 5]);
  });
  it('a switch before any library gives none', () => {
    const b = fake();
    new ServerSlot(fake().s).swap(b.s);
    expect(b.libs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; expect a failure** (no `server-slot.ts`).
- [ ] **Step 3: Implement** `server-slot.ts`:

```ts
/**
 * The look-back worker's frame server and the newest library it was sent.
 * A recording's settle with `?factors=file` switches worker 0 from the file
 * to the factors (slice 3); the new server gets the newest library at once,
 * so it never solves without one, whatever order the switch and a library
 * message come in.
 */
import type { FrameServer } from './factor-reader.ts';

export class ServerSlot {
  private lib: { version: number; bytes: Uint8Array } | null = null;
  constructor(private current: FrameServer) {}

  get server(): FrameServer {
    return this.current;
  }

  setLibrary(version: number, bytes: Uint8Array): void {
    if (!this.lib || version > this.lib.version) this.lib = { version, bytes };
    this.current.setLibrary(version, bytes);
  }

  /** Serve with `next` from now on; returns the server it replaced (the caller disposes it at the run's end). */
  swap(next: FrameServer): FrameServer {
    const old = this.current;
    this.current = next;
    if (this.lib) next.setLibrary(this.lib.version, this.lib.bytes);
    return old;
  }
}
```

`lookback-worker.ts`:

- `Run` gains `slot: ServerSlot | null` and `retired: FrameServer[]`; `open` sets `r.slot = new ServerSlot(server)` for
  both sources and returns `{ server, pool }` as now.
- The factor reader's construction moves to `function factorServer(f: FactorSource['factors']): FactorReader` (the
  code of `open`'s factor branch), used by `open` and the switch.
- `withServer` passes the current server: `if (run === r && r.slot) fn(r.slot.server, pool);`
- `library`: `withServer(msg.session, () => r.slot!.setLibrary(msg.version, msg.bytes))` (through the slot, so it
  is kept). Write it as:

```ts
    case 'library': {
      const r = run;
      if (!r || r.session !== msg.session) return;
      r.ready.then(
        () => {
          if (run === r) r.slot?.setLibrary(msg.version, msg.bytes);
        },
        () => {},
      );
      return;
    }
```

- the switch, on the request chain (a request still out finishes on the file first):

```ts
    case 'factors': {
      const r = run;
      if (!r || r.session !== msg.session) return;
      requests = requests.then(async () => {
        await r.ready.catch(() => {});
        if (run !== r || !r.slot) return;
        r.retired.push(r.slot.swap(factorServer(msg.factors)));
      });
      return;
    }
```

- `serve` uses `r.slot!.server` instead of the `server` from `r.ready`.
- `stop()` disposes `r.slot?.server` and each of `r.retired`, then `r.source`. (`withReader` keeps using `r.reader`:
  rows arriving after the switch go to the retired file reader, which is harmless until `stop`.)
- `SlowToLookback` in `lookback-types.ts`:

```ts
  /** A recording's settle with `?factors=file`: serve every later request from these factors (slice 3). */
  | { type: 'factors'; session: number; factors: FactorSource['factors'] }
```

- [ ] **Step 4: Run the tests (`lookback-*.test.ts`, `factor-reader.test.ts` too) and the app checks.** Expected: pass.
      (The worker's wiring is exercised by Task 8's e2e.)
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): look-back worker 0 can switch from the recording to the factors for the settle"
```

---

### Task 4: `SlowRunner`: at a recording's end, ask about the factors, then settle on them or on the file

**Files:** modify `lib/slow-runner.ts`, `workers/slow-types.ts` (`SlowFactors`), `workers/lookback-types.ts`
(`SettleStatus`), `lib/slow-client.ts`; tests in `__tests__/lookback-runner.test.ts` (a new `describe`, with the
file's `setup`, `INIT`, `frames`, `statuses`, `finals`, `settleReqs`).

**Interfaces:**

- `SlowFactors` ready variant: `{ ready: true; frames: number; source?: FactorSource['factors'] }`
- `SlowClient.factorsReady(session: number, frames: number, source?: FactorSource['factors'])`
- `SettleStatus.source?: 'factors' | 'file'`, `SettleStatus.fileReason?: string`
- `const FACTOR_ASK_MS = 150_000`, `const FACTOR_NO_ANSWER: string`
- private: `factorFile`, `fileReason`, `askTimer`; `factorWait: { since: number; file?: boolean } | null`

- [ ] **Step 1: Failing tests:**

```ts
describe("SlowRunner settle on a recording's factors (?factors=file, fake loop)", () => {
  const FINIT = { ...INIT, lookback: true, factorFile: true } as const;
  const SRC = { folder: 'run-a', windows: [{ index: 0, start: 0, frames: 40 }], width: 2, height: 1 };
  // A fake timer the tests fire by hand.
  const timers: (() => void)[] = [];
  const withTimer = () => setup(0, { timer: (fn: () => void) => (timers.push(fn), () => {}) });

  it('asks at the last frame, then switches worker 0 to the factors before any settle request', () => {
    const t = withTimer();
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle(frames(20, 20));
    const settleReqsBefore = t.toLb.filter((m) => m.type === 'request').length;
    t.r.handle({ type: 'end', session: 1 });
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({ waiting: true });
    // Nothing is asked of worker 0 while the slow loop waits for the answer.
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(settleReqsBefore);
    t.r.factors({ type: 'factors', session: 1, ready: true, frames: 40, source: SRC });
    const kinds = t.toLb.map((m) => m.type);
    const sw = kinds.indexOf('factors');
    expect(sw).toBeGreaterThanOrEqual(0);
    expect(kinds.lastIndexOf('library')).toBeGreaterThan(sw);
    // Discover's requests were cancelled at the ask: every request from here on is the settle's.
    expect(kinds.indexOf('request', sw)).toBeGreaterThan(sw);
    expect(kinds.slice(0, sw).filter((k) => k === 'request')).toHaveLength(settleReqsBefore);
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({ source: 'factors', done: true, fed: 40 });
  });

  it('not ready: settles on the file at once and keeps the reason; no switch', () => {
    const t = withTimer();
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.factors({ type: 'factors', session: 1, ready: false, reason: 'behind' });
    expect(t.toLb.some((m) => m.type === 'factors')).toBe(false);
    expect(settleReqs(t).length).toBeGreaterThan(0);
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      source: 'file',
      fileReason: 'behind',
      done: true,
      fed: 20,
    });
  });

  it('no answer within FACTOR_ASK_MS: the file, with that reason', () => {
    const t = withTimer();
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    timers.at(-1)!();
    expect(settleReqs(t).length).toBeGreaterThan(0);
    expect(statuses(t).at(-1)!.lookback!.settle!.fileReason).toBe(FACTOR_NO_ANSWER);
  });

  it('Stop settling while it asks: Discover's library is final; a late answer changes nothing', () => {
    const t = withTimer();
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.stopSettling(1);
    expect(finals(t)).toHaveLength(1);
    t.r.factors({ type: 'factors', session: 1, ready: true, frames: 20, source: SRC });
    expect(t.toLb.some((m) => m.type === 'factors')).toBe(false);
    expect(finals(t)).toHaveLength(1);
  });

  it('a new run while it asks clears the ask; a late answer for the old session is ignored', () => {
    const t = withTimer();
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.handle({ ...FINIT, session: 2 });
    t.r.factors({ type: 'factors', session: 1, ready: true, frames: 20, source: SRC });
    expect(t.toLb.some((m) => m.type === 'factors')).toBe(false);
  });

  it('a look-back run without factorFile settles at once, as today', () => {
    const t = withTimer();
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    expect(settleReqs(t).length).toBeGreaterThan(0);
    expect(statuses(t).at(-1)!.lookback!.settle!.source).toBeUndefined();
  });
});
```

(`setup` gains an optional `timer` in its `opts`, passed to the runner in place of `() => () => {}`. If the file's
fixture needs `need` frames before a look-back run settles, keep its existing look-back tests' pattern.)

- [ ] **Step 2: Run; expect failures** (no `factorFile` path).
- [ ] **Step 3: Implement.** Constants (beside `LOOKBACK`):

```ts
/** A recording's ask about its factors ends on the file after this long without an answer (`?factors=file`). */
export const FACTOR_ASK_MS = 150_000;
export const FACTOR_NO_ANSWER = `No answer about the factors within ${FACTOR_ASK_MS / 1000} s.`;
```

Fields, beside slice 2's:

```ts
  /** A recording with `?factors=file` (`SlowInit.factorFile`, look-back on). */
  private factorFile = false;
  /** Why the settle of a `?factors=file` run reads the file (unset: it reads the factors, or no switch). */
  private fileReason: string | undefined;
  /** Cancels the ask's deadline. */
  private askTimer: (() => void) | null = null;
```

`factorWait` becomes `{ since: number; file?: boolean } | null`. In `handle` `init`:
`this.factorFile = this.init.factorFile === true && this.lbOn;`.

`end()`, in the look-back branch:

```ts
if (this.lbOn && this.run === 1) {
  if (this.factorFile && this.lbError === undefined) {
    // Discover's requests still out would mix sources: drop them; nothing is asked while waiting.
    this.cancelRequests();
    this.csettleStop();
    this.reviewed = [];
    this.factorWait = { since: this.now(), file: true };
    const session = this.session;
    this.askTimer = this.timer(() => {
      this.askTimer = null;
      this.factors({ type: 'factors', session, ready: false, reason: FACTOR_NO_ANSWER });
    }, FACTOR_ASK_MS);
    this.status(0, 0);
    return;
  }
  this.clock.span('end', () => this.startDrain());
  return;
}
```

`lookbackRequest()` returns `false` first thing while `this.factorWait` is set.

`factors(msg)`, after the session and wait checks:

```ts
    const wait = this.factorWait;
    this.factorWait = null;
    this.askTimer?.();
    this.askTimer = null;
    try {
      if (wait.file) {
        if (msg.ready && msg.source) {
          // Over the request port, so every settle request below reads the factors.
          this.lbPorts[0]?.postMessage({ type: 'factors', session: this.session, factors: msg.source });
          this.factorLive = true;
          this.sendLibrary(0);
          this.clock.span('end', () => this.startDrain(Math.min(this.consumed, msg.frames)));
        } else {
          this.fileReason = msg.ready ? 'No factor source was given.' : msg.reason;
          this.clock.span('end', () => this.startDrain());
        }
        return;
      }
      // ... slice 2's stream branch, unchanged ...
```

`stopSettling`: in the `factorWait` branch, also `this.askTimer?.(); this.askTimer = null;` (the rest as slice 2:
Discover's library is final). `settleView`:

```ts
      ...(this.factorLive
        ? { source: 'factors' as const }
        : this.fileReason !== undefined
          ? { source: 'file' as const, fileReason: this.fileReason }
          : {}),
```

`statusInner` already includes `lookback` for look-back runs. `drop()`: `this.factorFile = false;
this.fileReason = undefined; this.askTimer?.(); this.askTimer = null;` (with slice 2's resets).

`SettleStatus` (lookback-types.ts):

```ts
  /** The settle read the factors (`?factors`, `?factors=file`) or, with `?factors=file`, the file. */
  source?: 'factors' | 'file';
  /** With `?factors=file`: why the settle reads the file. */
  fileReason?: string;
```

`SlowFactors` ready variant gains `source?: FactorSource['factors']` (import from lookback-types); `slow-client.ts`:

```ts
    factorsReady(session, frames, source) {
      const msg: SlowFactors = { type: 'factors', session, ready: true, frames, ...(source ? { source } : {}) };
      worker.postMessage(msg);
    },
```

- [ ] **Step 4: Run the tests (the old look-back and slice 2 ones too) and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): at a ?factors=file recording's end the slow loop settles on its factors or says why it reads the file"
```

---

### Task 5: The main thread answers the ask; the Run panel says what the settle reads

**Files:** modify `App.tsx` (beside slice 2's `?factors` effect near `App.tsx:428-470`; the Discover stage record near
`App.tsx:357`), `lib/run-stages.ts` (`StageRun`), `lib/lookback-text.ts`, `__tests__/lookback-text.test.ts` (one
case, since the text is the Run panel's only signal of the reason).

**Interfaces:**

- `StageRun.settleSource?: 'factors' | 'file'`, `StageRun.settleSourceReason?: string`
- `lookbackText` handles `source: 'file'` with `fileReason`

- [ ] **Step 1: Failing test** (`lookback-text.test.ts`):

```ts
it('a ?factors=file settle on the file says why', () => {
  const lb = {
    ...LB, // the file's base LookbackStatus fixture
    settling: true,
    settle: {
      fed: 1200,
      total: 9000,
      recording: 9000,
      moving: null,
      stopped: false,
      done: false,
      source: 'file' as const,
      fileReason: 'the compressor was 4,210 frames behind when Discover ended',
    },
  };
  expect(lookbackText(lb, false)).toContain(
    'Final settle (re-reads the file: the compressor was 4,210 frames behind when Discover ended)',
  );
  const waiting = {
    ...lb,
    settle: { ...lb.settle, source: undefined, fileReason: undefined, waiting: true },
  };
  expect(lookbackText(waiting, false)).toContain('waiting for the last factor window');
});
```

(If the file has no base fixture, build the `LookbackStatus` inline with zeros.)

- [ ] **Step 2: Run; expect a failure.**
- [ ] **Step 3: Implement.** `lookback-text.ts`:

```ts
const on =
  st?.source === 'factors'
    ? ' on the factors'
    : st?.source === 'file' && st.fileReason
      ? ` (re-reads the file: ${st.fileReason})`
      : '';
if (lb.settling && st?.waiting)
  return `Final settle: waiting for the last factor window${csettleText(lb.csettle, false)}${err}`;
```

(The stream text changes from "on the stream's factors" to "on the factors" and "the stream's last factor windows"
to "the last factor window": a stream and a recording share them. Update slice 2's e2e string if it asserts the old
text; grep `stream's last factor` and `on the stream's factors` in `e2e/` and `__tests__/`.)

`run-stages.ts`:

```ts
  /** Discover: the Final settle read the factors or, with `?factors=file`, the file, and why. */
  settleSource?: 'factors' | 'file';
  settleSourceReason?: string;
```

`App.tsx`, the Discover stage record:

```ts
      ...(slow?.lookback?.settle?.source === 'factors' ? { settleSource: 'factors' as const } : {}),
      ...(slow?.lookback?.settle?.source === 'file'
        ? { settleSource: 'file' as const, settleSourceReason: slow.lookback.settle.fileReason }
        : {}),
```

and the effect (inside `if (factors && compress)`, beside slice 2's `factorSettle`; the watchdog and timer are
shared):

```ts
const fileChoice = new FileSettleChoice();
// ... in the effect, after slice 2's action:
const fileState = compress.fileFactors(ended, frames);
const f = fileChoice.act({
  session,
  factorFile: pipeline.factorFileRun(),
  waiting,
  state: fileState,
  reason: fileFactorsBlocked(fileState, compress.status(), compress.error(), frames),
  info: compress.factorInfo(),
  behind: compress.behind(frames),
  window: COMPRESS_DEFAULTS.window,
  msPerFrame: compress.status()?.msPerFrame ?? 0,
  width: i?.width ?? 0,
  height: i?.height ?? 0,
});
if (f.kind === 'factors') slow.factorsReady(f.session, f.frames, f.factors);
else if (f.kind === 'file') {
  slow.factorsFailed(f.session, f.reason);
  runHistory.log({
    frame: frames,
    kind: 'warning',
    detail: `Final settle re-reads the file: ${f.reason}`,
  });
}
```

The watchdog's stall check uses `compress.fileFactors` on a file run (`pipeline.factorFileRun() ?
compress.fileFactors(ended, frames) : compress.factors(ended, frames)`). The `?factors` block runs for
`factorsFile` too (`factorsFile` implies `factors`).

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): the main thread answers a recording's settle and the Run panel says which source it reads"
```

---

### Task 6: Extract on a recording: the factors when ready, else the file with the reason

**Files:** modify `lib/factor-extract.ts`, `lib/pass2-store.ts`, `App.tsx` (`createFactorExtract` call near
`App.tsx:304-313`; the Extract stage record near `App.tsx:390`), `lib/run-stages.ts`, `components/RunPanel.tsx`
(`pass2Text`, near `RunPanel.tsx:290`); tests in `__tests__/pass2-store.test.ts`.

**Interfaces:**

- `FactorExtractPort.mode?(): 'stream' | 'file' | null`
- `createFactorExtract(store, client, session, active, ended, frames, fileRun: () => boolean = () => false)`
- `Pass2Result.source?: 'factors' | 'file'`, `Pass2Result.sourceReason?: string`
- `StageRun.source?: 'factors' | 'file'`, `StageRun.sourceReason?: string`

- [ ] **Step 1: Failing tests** (`pass2-store.test.ts`; `factorSetup` gains a `mode` argument, default `'stream'`,
      returned by the port's `mode`):

```ts
describe("Extract on a recording's factors (?factors=file)", () => {
  it('ready: solves on the factors', async () => {
    const t = factorSetup('ready', 'file');
    const done = t.store.run();
    await settle();
    expect(t.calls.runs).toBe(1);
    t.window(0, 4);
    t.window(4, 4);
    t.finish();
    await done;
    expect(t.store.result()!.source).toBe('factors');
  });

  it('still compressing: replays the file at once with the reason, and never waits', async () => {
    const t = factorSetup('compressing', 'file');
    void t.store.run();
    await settle();
    expect(t.calls.runs).toBe(0);
    expect(t.calls.changed).toBe(0);
    expect(t.started).toHaveLength(1); // the replay pipeline
    expect(t.store.waiting()).toBeNull();
    expect(t.store.fileReason()).toMatch(/still being compressed/);
  });
});
```

(`factorSetup` counts `changed()` calls in `calls.changed`; its `blocked` returns `'8 frames are still being
compressed.'` for `'file'` mode. The replay's result carrying `source: 'file'` is covered by the e2e's export only if
the e2e falls back, so add `expect(t.store.result()?.source)` after finishing the fake replay if the file's fixture can
finish one; otherwise leave it to Task 7's export test.)

- [ ] **Step 2: Run; expect failures** (no `mode`, no `fileReason`).
- [ ] **Step 3: Implement.** `factor-extract.ts`: the port gains

```ts
  /** 'stream': a `?factors` stream (waits for `ready`); 'file': a `?factors=file` recording (never waits); null: neither. */
  mode?(): 'stream' | 'file' | null;
```

and `createFactorExtract` takes `fileRun: () => boolean = () => false` with:

```ts
const fileState = (): FactorState => store.fileFactors(ended(), frames());
return {
  active,
  mode: () => (active() ? 'stream' : fileRun() ? 'file' : null),
  state: () => (fileRun() && !active() ? fileState() : store.factors(ended(), frames())),
  blocked: () =>
    fileRun() && !active()
      ? fileFactorsBlocked(fileState(), store.status(), store.error(), frames())
      : factorsBlocked(store.factors(ended(), frames()), store.status(), store.error()),
  // ... changed, info, run unchanged
};
```

`pass2-store.ts`: a signal `const [fileReason, setFileReason] = createSignal<string | null>(null)`, returned. In
`run()`:

```ts
const mode = factors?.mode?.() ?? (factors?.active() ? 'stream' : null);
// A recording never waits for its factors (spec decision 4): the factors when ready, else the file.
factorMode = mode === 'stream' || (mode === 'file' && factors!.state() === 'ready');
setFileReason(
  mode === 'file' && !factorMode ? (factors!.blocked() ?? 'The factors cannot be read.') : null,
);
if (factors && factorMode) return runFactors(factors);
```

`blockedReason()`: `const replay = factors?.active() || (factors?.mode?.() === 'file' && factors.state() === 'ready')
? null : replayBlocked(pipeline);`. Where the replay's result is set (`setResult({...})` in the replay path), add:

```ts
        ...(fileReason() !== null ? { source: 'file' as const, sourceReason: fileReason()! } : {}),
```

`Pass2Result.source?: 'factors' | 'file'` and `sourceReason?: string`. `StageRun.source` widens likewise with
`sourceReason`. `App.tsx`: pass `() => pipeline.factorFileRun()` as `createFactorExtract`'s last argument (the
`compress && compressClient` guard is unchanged), and the Extract stage record:

```ts
            ...(r?.source === 'factors' ? { source: 'factors' as const, factors: r.factors } : {}),
            ...(r?.source === 'file' ? { source: 'file' as const, sourceReason: r.sourceReason } : {}),
```

`RunPanel.tsx` `pass2Text`, `done`:

```ts
const from =
  res?.source === 'factors'
    ? props.live
      ? " (on the stream's factors)"
      : ' (on the factors)'
    : res?.source === 'file'
      ? ` (re-read the file: ${res.sourceReason})`
      : '';
```

and `running`: `p().waiting() ?? (p().fileReason() ? `Extract: re-reading the file (${p().fileReason()})` : 'Extract:
solving the traces of every frame with the final footprints')`.

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): Extract on a ?factors=file recording reads its factors when ready, else replays the file and says why"
```

---

### Task 7: The export records each stage's source and why

**Files:** modify `lib/export.ts` (`stageRecord` near `export.ts:269`; a note helper), `components/RunPanel.tsx`
(the export input near `RunPanel.tsx:335-350`), `lib/factor-run.ts` (note texts); tests in `__tests__/export.test.ts`.

**Interfaces:**

- `fileFactorNotes(stages: readonly StageRun[]): string[]`
- stage record keys `settle_source_reason`, `source_reason`

- [ ] **Step 1: Failing tests** (`export.test.ts`, with the file's export fixture):

```ts
describe('export of a ?factors=file recording', () => {
  it('records each stage source and reason, notes what each read, and is format 7', async () => {
    const stages = [
      {
        ...DISCOVER_RUN,
        settleSource: 'file' as const,
        settleSourceReason: 'the compressor was 4,210 frames behind when Discover ended',
      },
      { ...EXTRACT_RUN, source: 'factors' as const, factors: FACTOR_INFO },
    ];
    const meta = await exportMeta({ ...BASE_INPUT, stages, notes: fileFactorNotes(stages) });
    expect(meta.format_version).toBe(7);
    expect(meta.stages[0]).toMatchObject({
      settle_source: 'file',
      settle_source_reason: expect.stringContaining('4,210'),
    });
    expect(meta.stages[1]).toMatchObject({ source: 'factors', factor_tiling: 'offset' });
    expect(meta.notes[0]).toContain('the Final settle re-read the file');
    expect(meta.notes[0]).toContain('Extract read the factors');
    expect(meta.notes[1]).toContain('less per-frame noise');
  });
  it('an export without stage sources stays 6 and has no notes', async () => {
    const meta = await exportMeta({ ...BASE_INPUT, stages: [DISCOVER_RUN, EXTRACT_RUN] });
    expect(meta.format_version).toBe(6);
    expect(meta.notes).toBeUndefined();
  });
});
```

(`DISCOVER_RUN`, `EXTRACT_RUN`, `FACTOR_INFO`, `BASE_INPUT` and `exportMeta` are the names of the file's existing
fixtures and meta reader; use what the file has.)

- [ ] **Step 2: Run; expect failures** (no `fileFactorNotes`, no reason keys).
- [ ] **Step 3: Implement.** `stageRecord`:

```ts
if (r.settleSource) out.settle_source = r.settleSource;
if (r.settleSourceReason) out.settle_source_reason = r.settleSourceReason;
if (r.source) out.source = r.source;
if (r.sourceReason) out.source_reason = r.sourceReason;
```

`factor-run.ts`:

```ts
/** `meta_json.notes` of a `?factors=file` recording: what the settle and Extract read. */
export function fileFactorNotes(
  stages: readonly Pick<StageRun, 'stage' | 'settleSource' | 'source'>[],
): string[] {
  const d = [...stages].reverse().find((r) => r.stage === 'discover');
  const e = [...stages].reverse().find((r) => r.stage === 'extract');
  if (!d?.settleSource && !e?.source) return [];
  const settle =
    d?.settleSource === 'factors'
      ? 'the Final settle read the factors'
      : d?.settleSource === 'file'
        ? 'the Final settle re-read the file'
        : 'there was no Final settle';
  const extract =
    e?.source === 'factors'
      ? 'Extract read the factors'
      : e?.source === 'file'
        ? 'Extract replayed the file'
        : 'Extract did not run';
  const notes = [
    `With ?factors=file, ${settle}; ${extract} (stage records: settle_source, source and their reasons).`,
  ];
  if (e?.source === 'factors')
    notes.push(
      "Extract's traces (traces, traces_signed) are solved on low-rank frames rebuilt from the factors and carry less per-frame noise than traces solved on the file.",
    );
  return notes;
}
```

`RunPanel.tsx`: for a recording (`!props.live`) the export input adds `notes: fileFactorNotes(props.stages.runs())`
when it returns lines (slice 2's stream branch is unchanged). `exportFormatVersion` already gives 7 for any stage
source.

- [ ] **Step 4: Run the tests and the app checks.** Expected: pass.
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(cala): the export of a ?factors=file recording says what its settle and Extract read and why"
```

---

### Task 8: e2e: a recording with `?factors=file` settles and extracts on its factors

**Files:** create `e2e/cala-factors.spec.ts` (helpers from `e2e/cala-helpers.ts`, `cellMovie` and `buildAvi` from
`apps/cala/src/__tests__/synth-avi.ts`, as `e2e/cala-live.spec.ts` imports them).

- [ ] **Step 1: Write the spec:**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { exportNpz, metaText } from './cala-helpers';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi';

// Shorter than one window (600 frames): its only window is the last one, so the settle reads
// the factors whatever the machine's speed (plan decision 2).
const FRAMES = 590;

function writeMovie(): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'cala-factors-e2e-')), 'My_V4_Miniscope');
  mkdirSync(folder);
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
  return folder;
}

async function openAndExtract(page: import('@playwright/test').Page, query: string) {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/${query}`);
  await page.getByTestId('folder-input').setInputFiles(writeMovie());
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done', {
    timeout: 180_000,
  });
}

test('Cala: with ?factors=file a recording settles and extracts on its factors', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=file&debug');
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (on the factors)');
  const settle = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __cala: {
          cells: {
            status(): {
              lookback?: { settle?: { source?: string; fed: number; done: boolean } };
            } | null;
          };
        };
      }
    ).__cala;
    return c.cells.status()?.lookback?.settle;
  });
  expect(settle).toMatchObject({ source: 'factors', done: true });
  expect(settle!.fed).toBeGreaterThan(0);
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"source":"factors"');
  expect(meta).toContain('Extract read the factors');
  expect(meta).not.toContain('traces_live');
});

test('Cala: without ?factors=file a recording is unchanged', async ({ page }) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?debug');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":6');
  expect(meta).not.toContain('settle_source');
  expect(meta).not.toContain('"source":');
});
```

- [ ] **Step 2: Run it:** `npm run build:e2e`, then `npx playwright test e2e/cala-factors.spec.ts`. Expected: 2 passed.
      (Without Tasks 1-7 the first test fails: no "(on the factors)", no `settle_source`.) If Discover finds no cells in
      590 frames (Extract then does not run), make the cells brighter through `cellMovie`'s parameters, never more frames
      (more than one window would make the path depend on speed), and say so in the report.
- [ ] **Step 3: Run `npx playwright test e2e/cala.spec.ts e2e/cala-live.spec.ts`.** Expected: pass.
- [ ] **Step 4: Commit:**

```bash
git commit -m "test(cala): e2e for a ?factors=file recording that settles and extracts on its factors"
```

---

### Task 9: Measurement: how often a recording takes the factor path, and its times

**Files:** modify `apps/cala/scripts/live-measure.mjs`; create `tools/cala-eval/results/2026-11-2x-factors-file-speed.md`.

- [ ] **Step 1: Extend `live-measure.mjs`:** `--query` applies to file mode too (`Cala/?<query>&debug`). The file run's
      metrics gain, from `window.__cala` at Discover's end and at the end: `compressBehindAtEnd` (frames Discover read
      minus frames compressed, at the first status with `settle.waiting` or the settle's start), the settle's `source`
      and `fileReason`, Extract's `source` and `sourceReason`, the compressor's ms/frame and queue, and the settle and
      Extract wall times (from the export's stage records, not the polls).
- [ ] **Step 2: Run, headed Chrome, the production build, a free port** (memory note: check the build is current):
  - minisim `motion_s5` (600x600): one run `--query factors=file`, one without;
  - wireless `wl24_20251201` (200x200, the destriped grey input): one run each.
- [ ] **Step 3: Write the report** in the form of `tools/cala-eval/results/2026-11-23-factors-live-speed.md`: short
      answer first (which path each stage took and why, at 600 and 200 px; the times with and without), what was run,
      the table, what was not measured. Dataset names only, no paths.
- [ ] **Step 4: Commit:**

```bash
git commit -m "docs(cala-eval): which source a ?factors=file recording's settle and Extract take at 600 and 200 px"
```

---

### Task 10: Docs

**Files:** modify `apps/cala/docs/stages.md` (the settle and Extract sections: the `?factors=file` paragraph),
`apps/cala/README.md` (the `?factors` section), `apps/cala/USER_GUIDE.md` (if it mentions `?factors`),
`docs/CHANGELOG.md` (Unreleased: `?factors=file`, format 7 for its exports).

- [ ] **Step 1: Write:** what `?factors=file` does, when each stage reads the factors or the file and how the panel and
      the export say so, the 600 px expectation with the measured numbers, and that nothing changes without it.
- [ ] **Step 2: `npx prettier --write` on the touched docs; the app checks.**
- [ ] **Step 3: Commit:**

```bash
git commit -m "docs(cala): what ?factors=file does for a recording"
```

## Not in this slice

- Parallel compression (tiles shared across compress workers), which a file default would need (spec decision 1).
- Look-back during Discover on factors; any change to Discover.
- Joint runs on factors; the history review on offset grids; `FactorExtractor`; a storage quota.
- Changing any default (slice 4).

## Self-review notes

- **Slice 1's list:** item 1 → Task 1; item 2 → Tasks 2-5; item 3 → Task 6; item 4 → Task 7; item 5 → Task 8;
  item 6 → Task 10. The measurement the session brief asks for → Task 9.
- **Names across tasks:** `factorFile` (plan, `CellsSettings`, `SlowInit`, `SlowRunner`), `factorFileRun()`
  (pipeline), `FileSettleChoice`/`FileSettleInput`/`FileSettleAction`, `fileFactors()`, `behind()`,
  `fileFactorsBlocked`, `fileBehindText`, `FACTOR_TAIL_FILE`, `FACTOR_ASK_MS`, `FACTOR_NO_ANSWER`, `ServerSlot`,
  `SlowToLookback` `factors`, `SettleStatus.source`/`fileReason`, `StageRun.settleSource`/`settleSourceReason`/
  `source`/`sourceReason`, `Pass2Result.source`/`sourceReason`, `pass2.fileReason()`, `fileFactorNotes`.
- **Every state's releases:** the table; each pending request: Review Focus 2.
- **Exports:** without the switch, format 6 byte for byte; with it, format 7 (Decision 6, said in the changelog).
