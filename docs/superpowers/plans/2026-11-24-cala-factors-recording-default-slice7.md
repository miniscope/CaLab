# cala factors, slice 7: recordings settle and extract on factors by default, and finish sooner than today

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a recording, like a stream, settles and extracts on its own factors without a switch, and the whole run
finishes sooner than today's file path with results no worse (owner, 24 Nov: "recordings should default to factors.
Of course we want this to be an improvement"). The default switches only when the measurements below show both.

**Base:** `feat/cala-factor-extractor` (slice 6, PR #505 into `feat/cala-factors-settle`). Rebase once #505 is merged.

## Where a recording's time goes today (1 h V4, 600 px, 72,000 frames, 10 cores)

From `2026-11-24-factors-v4-1h-speed.md` (on `perf/cala-factors-v4-speed`) and slices 5 and 6:

| path                               | Discover | Final settle           | Extract                 | Discover end to Extract done |
| ---------------------------------- | -------: | ---------------------- | ----------------------- | ---------------------------: |
| file (today's default)             | 13.2 min | 7.1 min (42 frames/s)  | 15.8 min (76 frames/s)  |                     22.9 min |
| `?factors=file`, before slices 5-6 | 13.7 min | 7.6 min (file: behind) | 16.7 min (file: behind) |                     24.3 min |

- Extract on factors is no longer the cost: slice 6 solves about 850 frames/s on one worker and 2,300-2,900 on six
  (3-min stream, about 600 cells). On 72,000 frames that is a few minutes (inferred; 1,282 cells cost more per frame).
- **The cost is compression.** 72,000 frames at 25 ms (one worker, offset grids, Chrome) is 30 core-minutes.
  - During Discover the compressor gets almost no CPU at 600 px: 600-1,800 of 9,600 frames whatever the pool
    (slice 5).
  - After Discover the pool reached 48-52 frames/s with 3-4 workers beside the settle: 72,000 frames take about
    24 min, longer than today's settle and Extract together.
- So factors win on a recording only if compression gets much cheaper, scales better, or both. And the settle must
  be able to use windows as they are compressed, instead of choosing the file when it is far behind.

## Why compression may get much cheaper

- The compressor sketches `k0 = 40` components per tile (plus oversampling), with 2 power iterations, and keeps a
  mean rank of about 5.6 (`compress/mod.rs`: `CompressConfig::default`, `compress_tile`, `rsvd`). The randomized
  SVD's cost grows with the sketch size, so most of each tile's work goes into components that are thrown away
  (inferred from the sizes; Task 1 measures it).
- A tile doubles its sketch when one of the last `ADAPT_MARGIN = 10` components is kept. So a smaller fixed `k0`
  alone may double often. Starting each tile from the rank it kept in the previous window (plus the margin) keeps the
  sketch near what is needed (proposed; Task 1 measures how often it would double).
- Offset grids cut every frame twice (about twice the cost of plain tiles, slice 1). They stay: plain tiles bring back
  the tile-line jump.
- The pool scaled about 2x with 4 workers at 600 px. Whether that is the coordinator (it reads each tile in pieces
  from the window file and posts it) or CPU taken by the settle is not known. Task 1 measures the pool alone.

## Decided for the owner's review

Each says what would change it.

1. **Measure first (Task 1), then build only what the numbers support.** The tasks after Task 1 are the candidates;
   Task 1's report says which pay. The owner sees that report before Task 2 starts.
2. **The gates for the default switch** (Task 8), on the 1 h V4 recording and on `wl24_20251201`, against today's
   file path on the same machine:
   - **Speed:** Discover's end to Extract done is shorter, and Discover itself is no more than 5 % longer.
   - **Quality:** slice 1's settle evaluation (`SET-F` against `SET-R`) passes its lines on the real recording, or
     the owner accepts the gap. Today it fails repeatability (cosine 0.895 against 0.918).
   - **Traces:** Extract's traces on factors against the file's replay, per cell, reported (median and largest, in
     sd).
   - If a gate fails, recordings keep the file default and the report says why.
3. **The settle follows the compressor** (Task 5) instead of choosing the file when it is more than a few windows
   behind. It reads the windows in stream order as they are compressed, and waits per window. A wait longer than
   `FOLLOW_GIVE_UP_S` (proposed 60 s) without a new window falls back to the file for the rest of the settle.
4. **A recording that settled on the file stops compressing** (Task 6), unless Extract can still use the factors
   before it starts. The backlog then serves nothing, and in slice 5 it slowed the file's settle and Extract by
   30-40 %.
5. **Disk:** this plan does not decide the cap (the owner has not). A recording by default makes the cap matter more:
   with cheaper compression the raw backlog should stay well below 5 GB. Task 1 reports the backlog each option would
   leave on the 1 h recording.

## Global Constraints

- Owner's rules as in slices 5 and 6: less testing (unit tests only for logic that can hang, lose data or change an
  export; the e2e; the measurements); commits one sentence with a conventional prefix, no body, no attribution;
  branch names `<type>/<topic>`; no machine paths or user names in committed files; pushing or opening a PR needs the
  owner's yes; never bare `git stash`; long shell commands in a script under `.scratch/`.
- No compression change may change the factors of a stream without a measurement of its trace loss (phase 0's
  measure: `qc_eval --factors-tiling offset`, trace loss against the frames compressed).
- Measurements use the Chrome profile on the evaluation SSD and are not run while another session measures on the
  same Mac.
- Branch: `feat/cala-factors-recording-default`.

## Tasks

### Task 1: Where compression time goes (measurement only)

**Files:** `crates/cala/examples/` (a small timing example, or `qc_eval` flags), `apps/cala/scripts/compress-bench.mjs`,
create `tools/cala-eval/results/2026-11-2x-compress-cost.md`.

- [ ] Native and in Chrome, on windows dumped from `motion_s5` and from the 1 h V4 recording (600 px) and from
      `wl24_20251201` (200 px):
  - time per window split into quantize, reading tiles, the sketch, the power iterations and the rest;
  - the kept rank per tile, and how often a tile doubles its sketch with `k0` 40, 24, 16 and with `k0` from the
    previous window's rank plus the margin;
  - the trace loss of each `k0` option against today's (phase 0's measure), so a cheaper sketch is not a worse one;
  - `n_iter` 2 against 1 for time and loss.
- [ ] The pool's scaling with nothing else running (1-6 workers on a dumped window set), against slice 5's scaling
      beside the settle.
- [ ] Report, with a recommendation per lever, and the expected Discover-end-to-Extract-done time on the 1 h
      recording for each combination.
- [ ] **Commit** `docs(cala-eval): where the compressor's time goes, and what a cheaper sketch would cost in trace loss`
- [ ] **Stop for the owner's yes** on which levers to build.

### Task 2: A cheaper sketch (if Task 1 supports it)

The chosen `k0` rule in `CompressConfig` and `compress_tile`; Rust tests that the kept components match today's
within the loss Task 1 accepted. **Commit** `perf(cala): the compressor starts each tile's sketch near the rank it keeps`.

### Task 3: Pool scaling (if Task 1 finds the coordinator is the limit)

For example, tile-major window files (one read per tile) or several tiles per message. Unit tests as slice 5's (bytes
identical for any width). **Commit** `perf(cala): the compress pool keeps its helpers busy at 600 px`.

### Task 4: More workers while a recording's Discover runs (if Task 1 shows room)

Only if Discover stays within 5 % (decision 2). **Commit** `perf(cala): a recording's Discover shares more cores with the compressor`.

### Task 5: The settle follows the compressor

`SlowRunner`'s factor settle on a recording reads windows as they are compressed, in order, and waits per window
(decision 3); the factor reader asks the compress store for each window. Unit tests for the wait and its releases
(a new window, the give-up, Stop, a new run, a compressor error). **Commit**
`feat(cala): a recording's settle reads its windows as they are compressed`.

### Task 6: Stop compressing what no stage will read

Decision 4. A unit test that a recording settled and extracted on the file stops compressing and frees its window
files. **Commit** `feat(cala): a recording that settled on the file stops compressing`.

### Task 7: e2e

A recording without a switch, with the default on behind `?factors=file` until Task 8: settles and extracts on
factors; the export names the sources.

### Task 8: The gates, then the default

- [ ] Decision 2's measurements: the 1 h V4 recording (file path, factor path), `motion_s5`, `wl24_20251201`, and
      slice 1's settle evaluation on the real recording.
- [ ] Report. If every gate passes: recordings default to factors (`factorsFromPage`), `?factors=0` turns it off,
      docs and changelog. If not: no default change, and the report says what is missing.
- [ ] **Commits** `docs(cala-eval): a recording on factors against the file, 1 h V4 and wl24` and, if the gates pass,
      `feat(cala): recordings settle and extract on their factors by default; ?factors=0 turns it off`.

## Rough size

- Task 1: one session, about 2-3 h, plus about 1 h of machine time (native timing, Chrome runs, the loss checks).
- Tasks 2-7: depend on Task 1; probably one to two sessions.
- Task 8: about 3-4 h of machine time (two 1 h recordings and the settle evaluation).
