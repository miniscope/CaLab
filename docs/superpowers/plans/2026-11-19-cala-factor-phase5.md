# cala factor pipeline, phase 5: the browser benchmark and the decision on the default

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure in the browser, on whole recordings and with repeats, what the factor pipeline of phase 4 costs and gives against the raw path (`?compress=off`), and write the report from which the owner decides the default. The gate of the phase is the owner's decision, recorded in the report and in the spec.

**Architecture:** Measurement only, plus the instruments it lacks. The app gets per-window compression timing in its compress status. The batch driver (`apps/cala/scripts/batch-session.mjs`) gets an idle check, storage sampling, a second Extract from the file in the same run (so Extract on factors and on the file are compared on the same library, by cell id), Refine on factors, and a live mode that streams a recording through `live-sim.mjs` at camera rate. A series runner interleaves configurations and repeats. Two Python tools turn the app's exports into the run folders `factor_closeness.py` reads and tabulate the series with median and range.

**Tech Stack:** TypeScript with vitest (`apps/cala`), Node scripts with Playwright (`apps/cala/scripts`), Python 3 with numpy (`tools/cala-eval`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`: "Benchmarks" (speed, memory), Amendment 1 (A1 the gate, A5), Amendment 2 (A11 phase 5). Builds on the phase 4 plan (`2026-11-19-cala-factor-phase4.md`) and the measurement plans of phases 1 and 4a.

**Precondition:** phase 4.1 is merged into the branch; phase 4.2 is merged for the live and Refine-on-factors parts (Tasks 3 and 4 need it; without 4.2 the report covers files with raw Refine only, and says so). The owner has answered phase 4's "Decided for the owner's review", or accepted that this benchmark measures them as built.

## Decided for the owner's review

1. **Chrome only.** Every timing run uses the system Chrome through the batch driver (`--channel chrome`, the driver's default, with WebGPU motion correction). Firefox and Safari have synchronous OPFS handles too, but no WebGPU in this setup, so their stage times would not compare; they are not measured (the report says so). Changes if the owner's users run another browser.
2. **Three repeats per configuration and recording, interleaved** (A, B, C, A, B, C, A, B, C), reported as median and range (min to max); no standard deviation at n = 3. Earlier browser runs ran once each. Changes if the range of a number that decides the default overlaps the other configuration's range: then that configuration gets two more repeats (Task 7 step 4).
3. **Raw Refine runs: 2** per file run (`--refine-runs 2`), not the 5 of the native reference: two are what a user runs in practice and keep a series within one night. The settled raw reference stays the native one (phase 3).
4. **Closeness in the browser is judged two ways.** (a) Same run, same library: Extract on factors against a second Extract from the file, by cell id (arm A against arm C of the spec, in the browser, whole recordings). This is the comparison that decides. (b) Across runs: the default against `?compress=off`, cells paired by footprint, as phase 4a did; Discover in the browser differs from run to run (it drops batches for the slow loop when it falls behind), so (b) mixes the factors with run-to-run spread, and the report gives the spread of (b) between two repeats of the same configuration beside it.
5. **The machine is idle by rule, not by hope.** The series refuses to start a run while the one-minute load average is above 2.0 or a `qc_eval`, `cargo` or `vitest` process runs, and records the load during every run.
6. **The live source runs at the recording's own frame rate** (20 fps for the three real recordings), one stream at a time, with the whole recording.

## What is measured

| Quantity                                                                                                                                                      | Configurations                             | Recordings                          | Source                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Stage seconds: Discover, each Refine run (raw), Refine on factors (iterations, seconds per iteration), Extract (factors; file)                                | `default`, `off`, `rf` (`?refine=factors`) | `wl24_01`, `wl24_04`, `v4`, `wl200` | export `meta_json.stages` (`stage_times.py`)                                       |
| Whole file path: Discover start to export end                                                                                                                 | same                                       | same                                | driver `status.json`                                                               |
| Compress worker: ms per frame (mean), slowest window per frame, per-window delay (window closed to factors written: last, largest) against the frame interval | `default`, `rf`, `live`                    | same                                | compress status (Task 1)                                                           |
| Live at camera rate: frames received, dropped, missed; fast loop lag; compress windows waiting over time; delay per window; Extract on factors after the end  | `live`                                     | `wl24_01`, `v4`                     | `pipeline.live()`, compress status, `status.json` samples                          |
| Memory: peak WASM heap summed over threads; per thread for the slow and compress workers                                                                      | all                                        | all                                 | run telemetry (`totalWasmHeapBytes`, `memory-telemetry.ts`), sampled by the driver |
| Storage: OPFS usage (peak and at the end)                                                                                                                     | all                                        | all                                 | `navigator.storage.estimate()` sampled by the driver (Task 2)                      |
| Cells: Discover's, QC-pass                                                                                                                                    | all                                        | all                                 | export                                                                             |
| Gate A1, same run: Extract on factors against Extract from the file (by id)                                                                                   | `default` (with `--extract-both`)          | all                                 | exports, `factor_closeness.py`                                                     |
| Gate A1, across runs: `default` against `off`; `rf` against `off` (pairing by footprint)                                                                      | —                                          | all                                 | exports, `factor_closeness.py --match`                                             |

`wl200` is the synthetic recording with truth (rule 1 applies to it); first step of Task 7: check that the app opens its folder (it is a minisim recording; `live-sim.mjs` reads minisim folders, the folder picker reads Miniscope AVI folders: find the AVI folder of the recording and whether it has `metaData.json`). If the app cannot open it, the report has no truth rule in the browser and says so.

Not in scope: the slow-loop budget (the app's own), other machines, Firefox and Safari, recordings beyond the four.

## Global Constraints

- No change to what the pipeline computes. App changes are instruments: a new compress status field (Task 1). With the instrument in, the app's traces and the export's existing fields are the same as without it.
- Browser runs only through `apps/cala/scripts/batch-session.mjs` (directly or through the series runner of Task 5), each on a free port (the driver refuses a taken one), each with a fresh `npm run build:e2e` of the commit under test (the driver refuses an older build). One browser run at a time on the machine; no native run, no `cargo build --release`, no test suite during a series.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala` (never bare vitest: the pretest hook rebuilds the WASM package), `npx prettier --check` on files touched.
- Python: type hints on function signatures; `uvx ruff format` and `uvx ruff check --fix` on every Python file touched; tests with `uv run --no-project --with numpy python -m unittest discover tools/cala-eval` from the repository root; never install into a global environment.
- Raw data is read only. Run outputs go to a folder outside the repository (`factor_phase5_<date>`, next to the earlier phases' run folders). No machine paths or user names in committed files; the report names recordings by their short names.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push.
- The shell refuses long compound commands: anything longer goes in a script file in the run folder.

## Review Focus

1. **A delay that is not the compressor's.** The per-window delay runs from the window's last chunk to its factor file being written. In a file stage the stage reads faster than the compressor, so windows queue and the delay grows with the queue; in a live run it must stay below the window's own duration (30 s at 20 fps) for compression to keep up. The report gives both, and the slowest window's compute per frame separately. Pinned in Task 1.
2. **The same library for the same-run comparison.** `--extract-both` must run the second Extract with the library of the first, from the file, without a Refine between them. Pinned in Task 3 (the driver checks that both exports have the same `cell_ids` and library version before it compares).
3. **Spread before differences.** No difference between configurations is reported without the range of the three repeats; the decision table puts the ranges side by side.
4. **An idle record for every run.** A run without its load record is void.

## File Structure

| File                                                                                                                          | Change          | Responsibility                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `apps/cala/src/workers/compress-types.ts`, `apps/cala/src/lib/compress-runner.ts`, `apps/cala/src/__tests__/compress.test.ts` | modify          | per-window timing in the status                                                          |
| `apps/cala/scripts/batch-session.mjs`                                                                                         | modify          | `--max-load`, storage and memory samples, `--extract-both`, `--refine-factors`, `--live` |
| `apps/cala/scripts/bench-series.mjs`                                                                                          | create          | interleaved series with repeats                                                          |
| `tools/cala-eval/npz_run.py`, `tools/cala-eval/test_npz_run.py`                                                               | create          | an export as a run folder                                                                |
| `tools/cala-eval/browser_bench.py`, `tools/cala-eval/test_browser_bench.py`                                                   | create          | tables: median and range                                                                 |
| `tools/cala-eval/results/<date>-factor-phase5.md`, `tools/cala-eval/README.md`, `docs/CHANGELOG.md`                           | create / modify | the report and docs                                                                      |
| `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`                                                            | modify          | Amendment 3: the owner's decision                                                        |

---

### Task 1: Per-window timing in the compress status

**Files:**

- Modify: `apps/cala/src/workers/compress-types.ts` (`CompressStatus`, about line 59), `apps/cala/src/lib/compress-runner.ts` (`WindowJob` about line 121, `closeOpen` about line 266, `compress` about line 384, `post` about line 489, `clear` about line 506)
- Test: `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `CompressRunner` as of phase 4.1.
- Produces: `CompressStatus` gains `lastDelayMs: number`, `maxDelayMs: number` (wall time from a window's close to its factor file written; 0 before the first) and `slowestMsPerFrame: number` (the largest compute time per frame of one window).

- [ ] **Step 1: Write the failing test**

In `compress.test.ts`, `describe('CompressRunner', ...)`:

```ts
it('reports per window the delay from its close to its factors, and the slowest window', async () => {
  let clock = 0;
  const { feed, sent } = collectingFeed(5);
  feed.push(batch(0, 10), 0, 10); // two windows
  feed.end();
  const { r, toMain } = runner(memoryStore(), {
    now: () => clock,
    // Each yield (one per tile) takes 3 ms of wall time.
    yieldNow: async () => {
      clock += 3;
    },
  });
  for (const m of sent) await r.handle(m);
  await r.idle();
  const last = toMain.filter((m) => m.type === 'status').at(-1);
  if (last?.type !== 'status') throw new Error('no status');
  const tiles = tilesOf(tileLayout(W, H, TILE, 'plain')).length;
  // A window is written after its own tiles' yields at least, and after both
  // windows' yields at most (the second may close while the first compresses).
  expect(last.status.maxDelayMs).toBeGreaterThanOrEqual(3 * tiles);
  expect(last.status.maxDelayMs).toBeLessThanOrEqual(2 * 3 * tiles);
  expect(last.status.lastDelayMs).toBeGreaterThan(0);
  expect(last.status.lastDelayMs).toBeLessThanOrEqual(last.status.maxDelayMs);
  // No clock time passes inside a compress call here.
  expect(last.status.slowestMsPerFrame).toBe(0);
  await r.handle({ type: 'reset', session: 7 });
  const cleared = toMain.filter((m) => m.type === 'status').at(-1);
  if (cleared?.type !== 'status') throw new Error('no status');
  expect(cleared.status).toMatchObject({ lastDelayMs: 0, maxDelayMs: 0, slowestMsPerFrame: 0 });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run test -w apps/cala -- compress.test.ts`
Expected: FAIL, `maxDelayMs` is undefined.

- [ ] **Step 3: Implement**

`compress-types.ts`, `CompressStatus` gains:

```ts
/** Wall time from a window's close to its factor file written, ms: the last window's and the largest (0 before the first). */
lastDelayMs: number;
maxDelayMs: number;
/** The largest compute time per frame of one window, ms. */
slowestMsPerFrame: number;
```

`compress-runner.ts`: `WindowJob` gains `/** Clock when the window closed. */ closedAt: number;`; `closeOpen` pushes `closedAt: this.now()`. Fields: `private lastDelayMs = 0; private maxDelayMs = 0; private slowestMsPerFrame = 0;`. In `compress`, after `this.computeMs += ms + job.quantMs;`:

```ts
const delay = this.now() - job.closedAt;
this.lastDelayMs = delay;
this.maxDelayMs = Math.max(this.maxDelayMs, delay);
this.slowestMsPerFrame = Math.max(
  this.slowestMsPerFrame,
  (ms + job.quantMs) / Math.max(1, job.frames),
);
```

`post` adds the three fields; `clear` zeroes them.

- [ ] **Step 4: Run, check, commit**

`npm run test -w apps/cala`, `npm run typecheck`, `npm run lint`, `npx prettier --check apps/cala/src`. Expected: PASS.

```bash
git add apps/cala/src
git commit -m "feat(cala): the compress status reports per-window delay and the slowest window"
```

---

### Task 2: The driver records the load, storage and memory

**Files:**

- Modify: `apps/cala/scripts/batch-session.mjs` (options at the top, before "static server"; `snap`; the poll loop's status update)

**Interfaces:**

- Consumes: `window.__cala.compress.status()` (with Task 1's fields); `navigator.storage.estimate()`; the run telemetry's WASM total. First step: find how the main thread exposes the summed WASM heap (search `totalWasmHeapBytes` in `apps/cala/src`; expected: exported by `lib/memory-telemetry.ts` and read by the analytics; if `?debug` does not expose it, add `memory: () => totalWasmHeapBytes()` to the `__cala` object in `App.tsx` in this task).
- Produces: options `--max-load <x>` (default 2.0; `--max-load off` records only); `status.env` (`loadavg`, `cpus`, `busy`: the five processes with the most CPU, `chrome` version); `status.samples[]` every poll: `{ t, load1, storage, wasm, compress }`; `status.peaks`: `{ storage, wasm, load1 }`.

- [ ] **Step 1: Implement**

At the top, with the other imports: `import { cpus, loadavg } from 'node:os';` and `import { execFileSync } from 'node:child_process';` (merge with the existing `spawn` import). After the options:

```js
const maxLoad = opt('--max-load', '2.0');
/** The five processes with the most CPU, as `ps` lists them. */
function busy() {
  const rows = execFileSync('ps', ['-Ao', 'pcpu=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [cpu, ...cmd] = l.split(/\s+/);
      return { cpu: Number(cpu), cmd: cmd.join(' ').split('/').pop() };
    })
    .sort((a, b) => b.cpu - a.cpu);
  return rows.slice(0, 5);
}
const heavy = /qc_eval|cargo|vitest|rustc/;
status.env = { loadavg: loadavg(), cpus: cpus().length, busy: busy() };
if (maxLoad !== 'off') {
  if (loadavg()[0] > Number(maxLoad))
    throw new Error(`load average ${loadavg()[0].toFixed(2)} above --max-load ${maxLoad}`);
  const other = status.env.busy.find((p) => heavy.test(p.cmd));
  if (other) throw new Error(`a heavy process runs: ${other.cmd}`);
}
saveStatus();
```

After the browser is launched (`ctx`): `status.env.chrome = ctx.browser()?.version() ?? null;`.

In `snap`, inside the page function, add `memory: c.memory?.() ?? null,`; after `snap`, a storage reader:

```js
const storage = () =>
  page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null).catch(() => null);
```

In the poll loop after `status.last = s;`:

```js
const sample = {
  t: (Date.now() - t0) / 1000,
  load1: loadavg()[0],
  storage: await storage(),
  wasm: s.memory,
  compress: s.compress,
};
(status.samples ??= []).push(sample);
status.peaks = {
  storage: Math.max(status.peaks?.storage ?? 0, sample.storage ?? 0),
  wasm: Math.max(status.peaks?.wasm ?? 0, sample.wasm ?? 0),
  load1: Math.max(status.peaks?.load1 ?? 0, sample.load1),
};
```

The usage comment gains the three new records and `--max-load`.

- [ ] **Step 2: Try it**

`npm run build:e2e`, then one short run (a recording the controller names, `--refine-runs 0 --port 4193 --every 5`). Expected: exit 0; `status.json` has `env.chrome`, at least two `samples` with `storage` and `wasm` numbers, and `peaks`. With `--max-load 0.01` the run refuses to start with the load message.

- [ ] **Step 3: Commit**

`npm run lint`, `npx prettier --check apps/cala/scripts`.

```bash
git add apps/cala/scripts/batch-session.mjs apps/cala/src/App.tsx
git commit -m "feat(cala-eval): the batch driver records load, storage and memory and refuses a busy machine"
```

(Leave `App.tsx` out of the `git add` if the first step found the heap already exposed.)

---

### Task 3: The driver runs both Extracts in one run, and Refine on factors

**Files:**

- Modify: `apps/cala/scripts/batch-session.mjs` (options; the `discover`, `refine` and `extract` branches of the poll loop; the export branch)

**Interfaces:**

- Consumes: phase 4.1's `pass2.run(use, from)`, `pass2.result().source`, `compress.factors(frames)`; phase 4.2's `?refine=factors`, the Refine store's factor readout (`refine.status()`, the stage log's `iterations` and `stop`).
- Produces: `--extract-both`: after the factor Extract and its export, a second Extract from the file with the same library (`window.__cala.pass2.run(undefined, 'raw')`), exported as `<tag>_raw_cala.npz`; the status holds both Extracts' seconds and sources. `--wait-factors`: before clicking Extract, wait (up to `--compress-wait` s) until `compress.factors(frames)` is `ready`, so the default run's Extract is the factor one. `--refine-factors`: append `refine=factors` to the query and click Refine once ("Refine until settled"), recording `iterations`, `stop` and seconds from the stage log.

- [ ] **Step 1: Implement**

Options: `const extractBoth = args.includes('--extract-both'); const waitFactors = args.includes('--wait-factors'); const refineFactors = args.includes('--refine-factors');`. The URL becomes ``${base}Cala/?debug${query ? `&${query}` : ''}${refineFactors ? '&refine=factors' : ''}``. With `--refine-factors`, `refineRuns` is forced to 1.

A helper:

```js
/** Wait until the factors cover the recording (`ready`), up to --compress-wait s; returns the last state. */
async function factorsReady() {
  const t0w = Date.now();
  let state = null;
  while (Date.now() - t0w < compressWaitMs) {
    state = await page.evaluate(() => {
      const c = window.__cala;
      return c.compress?.factors?.(c.pipeline.record().frames) ?? null;
    });
    if (state === 'ready' || state === 'unusable' || state === null) break;
    await page.waitForTimeout(500);
  }
  return state;
}
```

Before each click on `pass2-run` (two places): `if (waitFactors) status.stages.factors = { state: await factorsReady(), at: Date.now() };`.

After the first export completes (`exported === 1` and before the CaDecon export), when `extractBoth`: store `status.stages.extract.cellIds` (from `window.__cala.pass2.result().ids` as an array) and `libraryVersion`, then:

```js
await page.evaluate(() => window.__cala.pass2.run(undefined, 'raw'));
status.stages.extractRaw = { start: Date.now() };
await page.waitForFunction(() => window.__cala.pass2.status() === 'done', null, {
  timeout: maxMs,
});
const raw = await page.evaluate(() => {
  const r = window.__cala.pass2.result();
  return { source: r.source, ids: [...r.ids], version: r.version };
});
status.stages.extractRaw.end = Date.now();
status.stages.extractRaw.source = raw.source;
if (
  raw.version !== status.stages.extract.libraryVersion ||
  raw.ids.join() !== status.stages.extract.cellIds.join()
)
  throw new Error('the second Extract solved another library');
```

and the download naming uses the tag `${tag}_raw` for the next `.npz` (a variable `nextTag` read by the download handler).

With `--refine-factors`, after `refine` reports `done`, store from the stage log's last Refine run: `iterations`, `stop`, `source`, and the seconds.

- [ ] **Step 2: Try it**

One short run with `--refine-runs 1 --wait-factors --extract-both --port 4194`. Expected: exit 0; two exports, `<tag>_cala.npz` (factors) and `<tag>_raw_cala.npz` (file); `status.stages.extract.source` `factors`, `extractRaw.source` `raw`. With phase 4.2 merged, one run with `--refine-factors --wait-factors`: `status.stages.refine.iterations` a number, `stop` one of `settled`, `nothing-accepted`, `cap`.

- [ ] **Step 3: Commit**

```bash
git add apps/cala/scripts/batch-session.mjs
git commit -m "feat(cala-eval): the batch driver extracts from factors and file in one run and runs Refine on factors"
```

---

### Task 4: The driver streams a recording at camera rate

**Files:**

- Modify: `apps/cala/scripts/batch-session.mjs`

**Interfaces:**

- Consumes: `apps/cala/scripts/live-sim.mjs` (`<folder> --port P --fps F`, prints `listening`; see `e2e/cala-live.spec.ts`); `window.__cala.pipeline.live()`; phase 4.2's Extract on factors for live runs.
- Produces: `--live <fps>`: starts `live-sim.mjs` on `--data` at that rate on `--port + 1`, opens `Cala/?debug&live=ws://127.0.0.1:<port + 1>` instead of the folder input, waits for the stream's end, then (with phase 4.2) Extract on the factors and the export; `status.live` holds the last `live()` counters and, per sample, `received`, `dropped`, `missed`, `lagFrames` and the compress `pending` windows.

- [ ] **Step 1: Implement**

Option `const liveFps = opt('--live', null);`. When set: spawn the simulator before the page opens (code as `startSim` in `e2e/cala-live.spec.ts`, with `process.execPath`, the script path `join(import.meta.dirname, 'live-sim.mjs')`, `[data, '--port', String(port + 1), '--fps', liveFps]`, resolving on `listening`, rejecting on exit); kill it in `finally`. Navigate to the live URL; skip `setInputFiles`. In the poll loop, with `liveFps`: Discover is done when `pipeline.status()` is `done` (the stream ended); the phase then goes to `extract` directly (`refineRuns` 0 unless `--refine-factors`). Each sample adds `live: await page.evaluate(() => window.__cala.pipeline.live())`.

- [ ] **Step 2: Try it**

A 2-minute stretch of a real recording is not available through the simulator (`--frames N` limits it: pass `--sim-frames 2400` through to `live-sim.mjs` as `--frames 2400`). One run: `--live 20 --sim-frames 2400 --port 4195`. Expected: exit 0 after about 2 minutes; `status.live` shows 2400 received, 0 dropped; the compress samples show `pending` at most 1 during the stream.

- [ ] **Step 3: Commit**

```bash
git add apps/cala/scripts/batch-session.mjs
git commit -m "feat(cala-eval): the batch driver streams a recording through the live simulator"
```

---

### Task 5: The series runner

**Files:**

- Create: `apps/cala/scripts/bench-series.mjs`

**Interfaces:**

- Consumes: `batch-session.mjs` with the options of Tasks 2 to 4.
- Produces: `node apps/cala/scripts/bench-series.mjs --plan <plan.json> --out <dir> [--port 4200]`: runs every entry of the plan in its order, each through `batch-session.mjs`, one at a time, on its own port (`port + index`), tag `<recording>-<config>-r<repeat>`; writes `series.json` (entry, tag, exit code, start, end) after each run; continues after a failed run; never runs two at once.

- [ ] **Step 1: Implement**

```js
#!/usr/bin/env node
/**
 * Runs a benchmark series: every entry of a plan through batch-session.mjs,
 * one at a time, in the plan's order (interleave configurations and repeats
 * there), each on its own port, writing series.json after each run.
 *
 *   node apps/cala/scripts/bench-series.mjs --plan plan.json --out <dir> [--port 4200]
 *
 * plan.json: [{ "recording": "wl24_01", "data": "<folder>", "config": "default",
 *               "repeat": 1, "args": ["--refine-runs", "2", "--wait-factors"] }, ...]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i < 0 ? d : args[i + 1];
};
const planPath = opt('--plan');
const out = opt('--out');
if (!planPath || !out) throw new Error('--plan and --out are required');
const port0 = Number(opt('--port', '4200'));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const driver = join(import.meta.dirname, 'batch-session.mjs');
const done = [];
plan.forEach((e, i) => {
  const tag = `${e.recording}-${e.config}-r${e.repeat}`;
  const start = new Date().toISOString();
  const r = spawnSync(
    process.execPath,
    [
      driver,
      '--data',
      e.data,
      '--out',
      join(out, tag),
      '--tag',
      tag,
      '--port',
      String(port0 + 2 * i),
      ...e.args,
    ],
    { stdio: 'inherit' },
  );
  done.push({ ...e, tag, exit: r.status, start, end: new Date().toISOString() });
  writeFileSync(join(out, 'series.json'), JSON.stringify(done, null, 2));
});
```

(`2 * i`: the live mode uses `port + 1` for the simulator.)

- [ ] **Step 2: Try it and commit**

A plan of two short entries (`--refine-runs 0`, the same recording, `default` and `off`). Expected: two run folders and `series.json` with exit 0 for both.

```bash
git add apps/cala/scripts/bench-series.mjs
git commit -m "feat(cala-eval): a series runner for interleaved browser benchmark runs"
```

---

### Task 6: The tools: an export as a run folder, and the series tables

**Files:**

- Create: `tools/cala-eval/npz_run.py`, `tools/cala-eval/test_npz_run.py`, `tools/cala-eval/browser_bench.py`, `tools/cala-eval/test_browser_bench.py`

**Interfaces:**

- Consumes: the cala export (`traces` cells × frames, `cell_ids`, `centroids_yx`, `footprint_starts`, `footprint_pixels`, `footprint_values`, `fov_shape`, `qc_pass`, `meta_json`; header of `apps/cala/src/lib/export.ts`); the run folder layout `factor_closeness.py` reads (`footprints.bin` CALAFP01, `extract_trace.f32` frames × cells, `extract_ids.tsv`, `final.tsv` with `id cy cx`, `cells.tsv` with `frame id pass`); `stage_times.stages`; the driver's `status.json`.
- Produces: `npz_run.write_run(npz: Path, out: Path) -> int` (cells written); `browser_bench.summary(values: list[float]) -> tuple[float, float, float]` (median, min, max); `browser_bench.table(series: Path) -> str` (per recording and configuration: Discover, Refine, Extract seconds, whole path, compress ms per frame, slowest window, largest delay, peak storage, peak WASM heap, cells; each as median and range).

- [ ] **Step 1: Write the failing tests**

`tools/cala-eval/test_npz_run.py`:

```python
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

import factor_closeness as F
import npz_run as N


def fake_export(path: Path) -> None:
    traces = np.arange(2 * 5, dtype=np.float32).reshape(2, 5)
    np.savez(
        path,
        traces=traces,
        cell_ids=np.array([7, 9], dtype=np.uint32),
        centroids_yx=np.array([[1.0, 2.0], [3.0, 1.5]], dtype=np.float32),
        footprint_starts=np.array([0, 2, 3], dtype=np.uint32),
        footprint_pixels=np.array([0, 1, 5], dtype=np.uint32),
        footprint_values=np.array([0.5, 1.0, 2.0], dtype=np.float32),
        fov_shape=np.array([4, 3], dtype=np.uint32),
        qc_pass=np.array([1, 0], dtype=np.int8),
        meta_json=np.frombuffer(json.dumps({"format_version": 7}).encode(), dtype=np.uint8),
    )


class NpzRunTest(unittest.TestCase):
    def test_an_export_reads_back_as_a_run_folder(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            npz, run = Path(d) / "x_cala.npz", Path(d) / "run"
            fake_export(npz)
            self.assertEqual(N.write_run(npz, run), 2)
            (h, w), fp = F.read_footprints(run / "footprints.bin")
            self.assertEqual((h, w), (4, 3))
            self.assertEqual(sorted(fp), [7, 9])
            np.testing.assert_array_equal(fp[7][0], [0, 1])
            np.testing.assert_allclose(fp[9][1], [2.0])
            tr = F.read_traces(run)
            np.testing.assert_allclose(tr[9], [5, 6, 7, 8, 9])
            self.assertEqual(F.read_centroids(run)[9], (3.0, 1.5))
            self.assertEqual(F.read_qc(run), {7: True, 9: False})


if __name__ == "__main__":
    unittest.main()
```

`tools/cala-eval/test_browser_bench.py`:

```python
import unittest

import browser_bench as B


class SummaryTest(unittest.TestCase):
    def test_median_and_range(self) -> None:
        self.assertEqual(B.summary([3.0, 1.0, 2.0]), (2.0, 1.0, 3.0))
        self.assertEqual(B.cell(B.summary([3.0, 1.0, 2.0]), 1), "2.0 (1.0 to 3.0)")

    def test_missing_values_are_left_out_and_said(self) -> None:
        self.assertEqual(B.cell(B.summary([]), 1), "n/a")
        med, lo, hi = B.summary([float("nan"), 4.0])
        self.assertEqual((med, lo, hi), (4.0, 4.0, 4.0))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to see them fail**

Run from the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval -p "test_npz_run.py"` and the same with `test_browser_bench.py`.
Expected: `ModuleNotFoundError` for both.

- [ ] **Step 3: Implement**

`tools/cala-eval/npz_run.py`:

```python
"""A cala browser export (`*_cala.npz`) as a run folder that `factor_closeness.py` reads.

    python npz_run.py EXPORT.npz OUT_DIR

Writes `footprints.bin` (CALAFP01; the export has unfiltered footprints only, so the
filtered values repeat them), `extract_trace.f32` (frames x cells), `extract_ids.tsv`,
`final.tsv` (id, cy, cx) and `cells.tsv` (one checkpoint at the last frame, QC pass
from `qc_pass`; a cell not measured counts as passing, as `read_qc` reads a missing row).
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np


def write_run(npz: Path, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    with np.load(npz) as z:
        traces = np.asarray(z["traces"], dtype=np.float32)  # cells x frames
        ids = np.asarray(z["cell_ids"]).astype(np.int64)
        cen = np.asarray(z["centroids_yx"], dtype=np.float64)
        starts = np.asarray(z["footprint_starts"]).astype(np.int64)
        pix = np.asarray(z["footprint_pixels"]).astype(np.uint32)
        val = np.asarray(z["footprint_values"], dtype=np.float32)
        h, w = (int(v) for v in z["fov_shape"])
        qc = np.asarray(z["qc_pass"]).astype(np.int64)
    with open(out / "footprints.bin", "wb") as f:
        f.write(b"CALAFP01" + struct.pack("<III", h, w, len(ids)))
        for k, cid in enumerate(ids):
            p = pix[starts[k] : starts[k + 1]]
            v = val[starts[k] : starts[k + 1]]
            f.write(struct.pack("<II", int(cid), len(p)))
            f.write(p.astype("<u4").tobytes())
            f.write(v.astype("<f4").tobytes())
            f.write(v.astype("<f4").tobytes())
    np.ascontiguousarray(traces.T).astype("<f4").tofile(out / "extract_trace.f32")
    (out / "extract_ids.tsv").write_text("id\n" + "".join(f"{c}\n" for c in ids))
    (out / "final.tsv").write_text(
        "id\tcy\tcx\n" + "".join(f"{c}\t{y}\t{x}\n" for c, (y, x) in zip(ids, cen))
    )
    last = traces.shape[1]
    (out / "cells.tsv").write_text(
        "frame\tid\tpass\n"
        + "".join(f"{last}\t{c}\t{0 if q == 0 else 1}\n" for c, q in zip(ids, qc))
    )
    return len(ids)


if __name__ == "__main__":
    print(write_run(Path(sys.argv[1]), Path(sys.argv[2])), "cells")
```

`tools/cala-eval/browser_bench.py`:

```python
"""Tables of a browser benchmark series (`bench-series.mjs`): per recording and
configuration, each number as the median and range (min to max) of the repeats.

    python browser_bench.py SERIES_DIR
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from pathlib import Path

import stage_times


def summary(values: list[float]) -> tuple[float, float, float]:
    v = [x for x in values if not math.isnan(x)]
    if not v:
        return (math.nan, math.nan, math.nan)
    return (statistics.median(v), min(v), max(v))


def cell(s: tuple[float, float, float], digits: int) -> str:
    med, lo, hi = s
    if math.isnan(med):
        return "n/a"
    return f"{med:.{digits}f} ({lo:.{digits}f} to {hi:.{digits}f})"


def run_numbers(run: Path, tag: str) -> dict[str, float]:
    """The numbers of one run: stage seconds from its export, the rest from its status."""
    status = json.loads((run / f"{tag}.status.json").read_text())
    out: dict[str, float] = {}
    exports = sorted(run.glob(f"{tag}_cala.npz"))
    if exports:
        for row in stage_times.stages(exports[0]):
            key = f"{row['stage']}_s"
            out[key] = out.get(key, 0.0) + float(row["seconds"])
    out["wall_min"] = float(status.get("wallMin", math.nan))
    comp = (status.get("stages", {}).get("extract", {}) or {}).get("compress") or {}
    out["ms_per_frame"] = float(comp.get("msPerFrame", math.nan))
    out["slowest_ms_per_frame"] = float(comp.get("slowestMsPerFrame", math.nan))
    out["max_delay_s"] = float(comp.get("maxDelayMs", math.nan)) / 1000
    peaks = status.get("peaks") or {}
    out["storage_gb"] = float(peaks.get("storage", math.nan)) / 1e9
    out["wasm_gb"] = float(peaks.get("wasm", math.nan)) / 1e9
    out["cells"] = float((status.get("stages", {}).get("discover") or {}).get("cells", math.nan))
    return out


COLUMNS = [
    ("discover_s", "Discover s", 0),
    ("refine_s", "Refine s", 0),
    ("extract_s", "Extract s", 1),
    ("wall_min", "whole path min", 1),
    ("ms_per_frame", "compress ms/frame", 2),
    ("slowest_ms_per_frame", "slowest window ms/frame", 2),
    ("max_delay_s", "largest window delay s", 0),
    ("storage_gb", "peak OPFS GB", 2),
    ("wasm_gb", "peak WASM GB", 2),
    ("cells", "cells", 0),
]


def table(series: Path) -> str:
    runs = json.loads((series / "series.json").read_text())
    groups: dict[tuple[str, str], list[dict[str, float]]] = {}
    for r in runs:
        if r.get("exit") != 0:
            continue
        groups.setdefault((r["recording"], r["config"]), []).append(
            run_numbers(series / r["tag"], r["tag"])
        )
    head = "| recording | config | runs | " + " | ".join(c[1] for c in COLUMNS) + " |"
    lines = [head, "|" + " --- |" * (len(COLUMNS) + 3)]
    for (rec, cfg), rows in sorted(groups.items()):
        cells = [cell(summary([x.get(k, math.nan) for x in rows]), d) for k, _, d in COLUMNS]
        lines.append(f"| {rec} | {cfg} | {len(rows)} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    print(table(Path(sys.argv[1])))
```

- [ ] **Step 4: Run, check, commit**

The two test commands of Step 2: PASS. `uvx ruff format tools/cala-eval/npz_run.py tools/cala-eval/browser_bench.py tools/cala-eval/test_npz_run.py tools/cala-eval/test_browser_bench.py`, `uvx ruff check --fix` on the same; the whole Python suite.

```bash
git add tools/cala-eval/npz_run.py tools/cala-eval/browser_bench.py tools/cala-eval/test_npz_run.py tools/cala-eval/test_browser_bench.py
git commit -m "feat(cala-eval): browser exports as run folders, and series tables with median and range"
```

---

### Task 7: Run the series and write the report

The controller runs the series (one night); a subagent writes the report from the run folder.

**Files:**

- Create: `tools/cala-eval/results/<date of the runs>-factor-phase5.md`
- Modify: `tools/cala-eval/README.md` (the two tools), `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: Tasks 1 to 6; `factor_closeness.py` (`--ref`, `--test`, `--match`, `--truth`, A1 tables); `stage_times.py`.
- Produces: the report with its decision section open for the owner.

- [ ] **Step 1: Prepare**

Create the run folder `factor_phase5_<date>` next to the earlier phases' run folders. `npm run build:e2e` at the commit under test; record the commit and the build time. Check that the app opens each recording (one `--refine-runs 0` run per recording, `--max-load off`, outputs discarded); for `wl200` find its AVI folder (see "What is measured"). Write `plan.json` (the series below) into the run folder.

- [ ] **Step 2: The series**

Per recording (`wl24_01`, `wl24_04`, `v4`, `wl200`), three configurations, three repeats, interleaved in the plan as `default r1, off r1, rf r1, default r2, off r2, rf r2, default r3, off r3, rf r3`, recordings one after the other:

- `default`: `--refine-runs 2 --wait-factors --extract-both --compress-wait 1800`
- `off`: `--query compress=off --refine-runs 2`
- `rf` (phase 4.2 only): `--refine-factors --wait-factors --compress-wait 1800`

Then the live entries, three repeats each, interleaved by recording: `wl24_01` and `v4` with `--live 20 --compress-wait 1800`.

Run: `node apps/cala/scripts/bench-series.mjs --plan <run folder>/plan.json --out <run folder> --port 4200`. Estimated time, from phase 1's whole-recording browser runs (Discover 34 s and 160 s, Extract 29 s and 196 s at 200 and 600 px) and the compression backlog at 600 px (up to 700 s after a replay): about 10 to 25 minutes per file run at 600 px, 3 to 6 at 200 px, 36 file runs; the live runs take the recordings' length (34 and 20 minutes), 6 runs. About 13 hours: split over two nights by recording, never two series at once.

- [ ] **Step 3: The comparisons**

For every `default` run: `python tools/cala-eval/npz_run.py <tag>_cala.npz <tag>/run_factors` and the same for `<tag>_raw_cala.npz` into `run_raw`; then `factor_closeness.py --ref run_raw --test run_factors` (add `--truth` for `wl200`) — gate A1 same run, by id. For each repeat pair `default rK` against `off rK`, and `rf rK` against `off rK`: `--match` (pairing). For the spread of the pairing comparison: `off r1` against `off r2`, and `default r1` against `default r2`.

- [ ] **Step 4: Repeat where the ranges overlap**

From `python tools/cala-eval/browser_bench.py <run folder>`: if the ranges of `default` and `off` overlap for the whole-path minutes or for the Extract seconds of a recording, run two more repeats of both configurations for that recording (interleaved), and say so in the report.

- [ ] **Step 5: Write the report**

Every number from a script over the run folder (kept in the run folder), none copied by hand. Sections, in this order:

1. **Decision: open, for the owner.** The options and what the evidence says about each (see "The decision" below); one table: per recording, the deciding numbers of each option side by side with their ranges.
2. **Summary.** Five to eight bullets: same-run gate A1 per recording; whole-path time default against off; Extract seconds; compression against the frame interval in live runs (delay per window against 30 s); peak storage; peak memory; cells.
3. **How it was measured.** Commit, build time, Chrome version, machine, the load records (`env`, `peaks.load1` per run: largest and median), the series order, which runs failed and why, the repeats added in step 4.
4. **Stage times.** Per recording and configuration: Discover, Refine (raw: per run; factors: iterations, seconds per iteration, stop reason), Extract (factors; file), the whole path; median and range.
5. **Compression against the frame interval.** Mean ms per frame, slowest window per frame, per-window delay (last, largest) for file stages and live runs; live runs: received, dropped, missed, fast-loop lag, windows waiting over time (a plot or a table of the largest per minute).
6. **Memory and storage.** Peak WASM heap, peak OPFS usage, the OPFS usage at the end of the run; against phase 4's estimate for waiting windows.
7. **Cells and gate A1.** (a) Same run, Extract on factors against Extract from the file, by id: each rule's value and verdict per recording and repeat; cells near the border and cells with a never-valid pixel reported separately where `extract_min_valid` is not available (the browser has no such file: say so and use the distance to the border). (b) Across runs with pairing: default against off, Refine on factors against off; beside them the same measure between two repeats of one configuration (the run-to-run spread). (c) Cell counts per configuration.
8. **What was not measured.** At least: other browsers, other machines, recordings longer than the four, a live source with real acquisition timing, the cluster replay and the look-back.

Writing rules as in the earlier reports.

- [ ] **Step 6: Docs and commit**

`tools/cala-eval/README.md`: lines for `npz_run.py` and `browser_bench.py`; `docs/CHANGELOG.md`: one entry for the driver's new options, the series runner and the per-window compress timing. `npx prettier --write` on the report, README and CHANGELOG.

```bash
git add tools/cala-eval/results tools/cala-eval/README.md docs/CHANGELOG.md
git commit -m "docs(cala-eval): phase 5 browser benchmark of the factor pipeline against the raw path"
```

---

### Task 8: Record the owner's decision

**Files:**

- Modify: `tools/cala-eval/results/<date>-factor-phase5.md` (section 1), `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (a new section "Amendment 3, the default (phase 5)")

- [ ] **Step 1:** Ask the owner for the decision, with the report's decision table. Do not choose for the owner.
- [ ] **Step 2:** Write the decision, its date and the owner's reasons (as the owner gives them) into the report's section 1 and into Amendment 3 of the spec, with what follows for the code (for example: remove `?compress=off`, keep it, or turn compression back to opt-in), as a list of follow-up tasks, not done here.
- [ ] **Step 3:** `npx prettier --write` on both files; commit:

```bash
git add tools/cala-eval/results docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md
git commit -m "docs(cala): record the owner's decision on the factor pipeline's default"
```

## The decision

The options, and the evidence that decides between them. The decision is the owner's; the report states the evidence and leaves section 1 open.

| Option                                   | What the app does by default                                                           | Speaks for it                                                                                                           | Speaks against it                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Factors as built in phase 4           | compression on; Extract on factors when ready; Refine raw                              | same-run gate A1 passes on every recording; whole path not slower than off beyond the ranges; storage peak within quota | A1 fails on a real recording in the browser; the compression backlog makes the whole path slower; storage peak above what a laptop has free |
| B. Compression on, Extract from the file | compression on (live runs, back-fill, history review); Extract always replays the file | live runs keep their factors; file results unchanged against today                                                      | the time Extract on factors saves is given up                                                                                               |
| C. Compression opt-in again              | `?compress` as before phase 4                                                          | nothing changes for file users                                                                                          | live runs have no Refine or Extract by default                                                                                              |
| D. Refine on factors too                 | A plus `?refine=factors` as the default                                                | the raw file is needed once; Refine time no longer depends on the machine                                               | phase 3's gate fails on the real recordings unless that changed; iterations at 600 px may take minutes                                      |

Deciding evidence, in order: (1) same-run gate A1 in the browser on whole recordings (a fail on a real recording rules out A and D for that recording type); (2) the whole path's time, default against off, with ranges (a slower default needs a reason the owner accepts); (3) live runs: the largest per-window delay below the window's duration and no frame dropped (else the live claim of A, B and D is limited); (4) peak storage against the quota of the machines the owner targets; (5) peak memory.

## Not in this phase

- Changing what the pipeline computes: a failed rule is a result for the owner, not fixed here.
- Firefox and Safari; machines other than the one the earlier phases used.
- Native timing (phases 0 to 3 have it).
- The cluster replay and the look-back in the browser (not in the app; phase 4 "Not in this phase").

## Self-review notes

- Spec coverage: "Benchmarks: speed, both frame sizes, today against factors with Refine iteration counts" (Task 7 sections 4 and 5); "Memory: peak memory per stage, factor megabytes per minute" (section 6; per stage from the samples' times); A11 phase 5 "browser benchmark report; decide the default; gate: decision recorded" (Tasks 7 and 8).
- What earlier phases did not measure and this one does: per-window delay and the slowest window (Task 1), repeats with spread (decision 2), a live source at camera rate (Task 4), gate A1 on whole recordings in the browser (Task 7 step 3).
- Names used across tasks: `CompressStatus.{lastDelayMs, maxDelayMs, slowestMsPerFrame}`; driver options `--max-load`, `--extract-both`, `--wait-factors`, `--refine-factors`, `--live`, `--sim-frames`; `status.{env, samples, peaks, live}`, `status.stages.{factors, extractRaw}`; `bench-series.mjs --plan --out --port`, `series.json`; `npz_run.write_run`; `browser_bench.{summary, cell, run_numbers, table}`.
