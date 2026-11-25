# Stage 0 of the cala speed plan: where the slow worker's time goes

24 Nov 2026. Branch `perf/cala-stage0-attribution`, rebased on `main` at `aae4840a` (#500, fixed Discover visit rate). The
instrumentation is off in every shipped build:

- Rust feature `timing` (`discover/timing.rs`). It splits `observe` into stages and each visit into phases, with edits.
- Rust feature `threads` (rayon over the per-cell and per-cluster statistics, for the kill test).
- JS `?debug` detail timers (`DetailTimer`).

Raw runs, logs and scripts are in `~/Projects/cala-data/runs/stage0/` (`chrome/`, `runs/`, `scripts/`). The analysis
scripts are in `tools/cala-eval/stage0/`.

## Runs

Headed Chrome, real GPU, workshop recording (read-only), Max, `--single --lookback`, one run at a time. The user's own
Chrome was open and nearly idle.

| run                 | WASM                    | Discover | fps (early/mid/late) | observed | visits per frame read | Final settle | cells | peak RSS |
| ------------------- | ----------------------- | -------: | -------------------- | -------: | --------------------: | -----------: | ----: | -------: |
| B1 (#500 reference) | plain                   |    111 s | 213 (307/199/176)    |      77% |                 0.153 |        204 s |   775 |   4.1 GB |
| B2 (#500 reference) | plain                   |    112 s | 211 (301/201/172)    |      77% |                 0.152 |        204 s |   785 |   4.1 GB |
| P1                  | plain + JS timers       |    111 s | 214 (308/206/174)    |      76% |                 0.151 |        215 s |   777 |   4.1 GB |
| T1                  | `timing` + JS timers    |    112 s | 212 (305/201/175)    |      77% |                 0.152 |        205 s |   778 |   4.5 GB |
| T2                  | `timing` + JS timers    |    109 s | 217 (302/205/180)    |      77% |                 0.153 |        196 s |   754 |   4.1 GB |
| PR1                 | `timing` + CPU profiles |    109 s | 218 (310/211/177)    |      78% |                 0.154 |        192 s |   750 |   4.3 GB |

**Overhead.** Both timer layers are within run-to-run noise. The JS timers (P1 against B1/B2) and the Rust timers (T1/T2
against P1) change Discover by 2 s at most and the settle by about 5%, in both directions. No baseline was run on the
older `main`; the branch was rebased onto #500 before any Chrome run.

Native runs used `qc_eval` built from the same commit:

- the workshop recording with `--features timing` (`--visit-rate 0.2`, the app's cap per observed frame since #500);
- a replay of 236 captured visit jobs;
- v3 sims for the skipped-frames and threads questions.

## 1. Discover: the slow worker's time, by duty

The window runs from 15 s after the start to the last live frame, about 92 s and 13.2k observed frames. Values are
T1 / T2.

| duty                                          | ms per observed frame | share of wall |
| --------------------------------------------- | --------------------: | ------------: |
| live (batches: `observe` + glue)              |           4.16 / 4.07 |           59% |
| of which WASM `observe`                       |           4.15 / 4.06 |           59% |
| housekeep (`prune` after every applied visit) |           0.78 / 0.75 |           11% |
| need (look-back answers: `observeLookback`)   |           0.70 / 0.67 |           10% |
| visit (hand-out `takeJob` 0.26, apply 0.02)   |           0.29 / 0.28 |            4% |
| publish, status                               |                  0.08 |            1% |
| **busy**                                      |       **6.00 / 5.84** |    **85–86%** |
| idle (no duty)                                |           1.03 / 0.97 |        14–15% |

- **Everything is accounted for.** The `onmessage` handler spans sum to the duty total within 0.004 ms per frame, so
  there is no JS glue outside the duties. The profile of the slow worker over 10 s of mid-Discover (PR1) reads 83% WASM,
  3% JS, 13.5% idle, 0.0% GC and 0.0% `(program)` (deserialisation). That idle matches the duty clock's 14%.
- **The worker reads 85% busy, not 95–100%.** The other 15% is real idle, waiting for the next batch or answer.

WASM `observe` split, in ms per call (T1, Discover window):

| render | whiten | scale | ncorr | ledger | fpstats | clusters | reservoir | probes |  sum | JS call |
| -----: | -----: | ----: | ----: | -----: | ------: | -------: | --------: | -----: | ---: | ------: |
|   0.36 |   0.25 |  0.29 |  0.05 |   0.83 |    1.11 |     0.73 |      0.48 |   0.02 | 4.11 |    4.15 |

- The binding (frame copy into WASM, call) costs 0.03–0.04 ms per frame.
- By third, WASM observe goes 3.6 → 4.3 → 4.6 ms as the library grows from about 300 to 775 cells.

**The native comparison, and what explains the gap.** Native `observe` at a matching cell count (500–780 cells) is
1.5–2.8 ms per frame (table in section 3). In the app it is 3.6–4.6, which is 1.6–2.2x. The cell-independent stages show
how much of that is the browser rather than the work:

| stage  | WASM / native, Discover | WASM / native, Final settle |
| ------ | ----------------------: | --------------------------: |
| whiten |                    1.5x |                       1.25x |
| scale  |                    1.3x |                        1.0x |

The Final settle is quieter: the fast loop is idle. There the cell-dependent stages are about 1.1–1.4x native per cell
(scaled linearly from 900 to 780 cells). In Discover they are about 1.6–2.2x.
So during Discover the slow worker's code runs about 1.3–1.5x slower than native. This is most likely contention from
the fast loop, the visit workers and the look-back worker on shared cores, not the WASM itself.

A native-ms model counts only `observe` at native speed: about 2.4 of the 7.0 ms per observed frame, about 35%. The
remaining ~65% is:

| part                                                | ms per observed frame |
| --------------------------------------------------- | --------------------: |
| the browser/contention factor on `observe`          |                  ~1.7 |
| `housekeep`                                         |                  0.77 |
| `need` (look-back frames, about 0.7 per live frame) |                  0.69 |
| visit hand-out                                      |                  0.28 |
| idle                                                |                   1.0 |

This is the "measured work explains ~40%" gap. Nothing is hidden: no GC, no deserialisation, no JS glue.

## 2. Final settle: the slow worker, look-back worker 0, and the relay

18k settle frames over the whole recording, about 780 cells. Values are T1 / T2.

| slow worker duty                                                                     | ms per settle frame | share of wall |
| ------------------------------------------------------------------------------------ | ------------------: | ------------: |
| end: WASM `observe`                                                                  |         5.05 / 4.89 |        44–45% |
| end: checkpoints (finalize, unit footprints, noise, moved, still-moving; 14 of them) |         0.40 / 0.37 |          3–4% |
| housekeep (`prune`, 14–15k calls, ~0.17–0.19 ms each)                                |         2.70 / 2.43 |        22–24% |
| visit: `takeJob` (job encoding with the tile's reservoir; 16–17k calls)              |         1.12 / 1.12 |           10% |
| visit: apply                                                                         |                0.12 |            1% |
| publish                                                                              |                0.08 |            1% |
| **busy**                                                                             |     **9.48 / 9.04** |       **83%** |
| idle                                                                                 |         1.88 / 1.83 |           17% |
| wall per settle frame                                                                |       11.36 / 10.87 |   88 / 92 fps |

Settle `observe` split, in ms per call (T1):

|                    | render | whiten | scale | ncorr | ledger | fpstats | clusters | reservoir |  sum |
| ------------------ | -----: | -----: | ----: | ----: | -----: | ------: | -------: | --------: | ---: |
| WASM, ~780 cells   |   0.48 |   0.22 |  0.25 |  0.04 |   1.13 |    1.33 |     1.17 |      0.40 | 5.02 |
| native, ~900 cells |   0.49 |   0.18 |  0.24 |  0.04 |   0.95 |    1.37 |     1.22 |      0.22 | 4.71 |

**The ~9 ms is explained.** The "2–2.8 ms native observe" reference underestimates the settle: native settle `observe`
on the workshop library is 4.7 ms at 900 cells. That is about 1.4x Discover's native cost at the same cell count,
because every settle frame is a fitting frame and the supports have grown. WASM in the settle runs at about native speed
per cell. The other ~4 ms are three things, none of them `observe`:

- `housekeep` 2.4–2.7 ms. `prune()` scans every cell's ledger once per applied visit, and there are about 0.8 applied
  visits per settle frame.
- `takeJob` 1.1 ms.
- Checkpoints 0.4 ms.

**Look-back worker 0** (the end settle's only reader), in ms per settle frame:

| part           | ms per settle frame |
| -------------- | ------------------: |
| read           |                0.19 |
| preprocess     |                3.60 |
| solve          |         4.69 / 4.44 |
| other          |                0.10 |
| waits for rows |               0.002 |
| **busy**       |       **8.6 / 8.3** |

It is 76–77% busy. The trace solve is the larger half, then preprocess.

**Relay** (16-frame answers, 1,124 per run). The round trip from request to handler is 182 / 173 ms per answer:

- the look-back worker is busy for 137 / 134 ms;
- the answer then waits 44 / 40 ms in the slow worker's queue, from posted until handled.

The next request goes out before an answer is observed, but only one answer is ever in flight. The two workers (9.0–9.5
and 8.3–8.6 ms per frame) therefore alternate instead of overlapping. Neither one is saturated (83% and 77%), and the
settle runs at 88–92 fps, where full overlap would allow about 105–110 fps.

## 3. Visits by phase (native)

Workshop recording, native `step` (visits inline), `--visit-rate 0.2`. 4,730 Discover visits, 58.5 ms per visit.

| phase  | ms/visit, all | first half | second half | share | edits (all)                                       |
| ------ | ------------: | ---------: | ----------: | ----: | ------------------------------------------------- |
| keep   |          6.73 |       3.71 |        9.24 | 11.5% | (deletes happen in `prune`, not here)             |
| load   |          4.54 |       4.37 |        4.68 |  7.8% |                                                   |
| solve  |          3.71 |       2.64 |        4.59 |  6.3% |                                                   |
| split  |          3.43 |       1.99 |        4.63 |  5.9% | 54 splits                                         |
| refine |          4.85 |       2.56 |        6.75 |  8.3% | 6,772 refines                                     |
| merge  |         15.00 |       7.34 |       21.37 | 25.7% | 206 merges                                        |
| add    |         20.22 |      16.24 |       23.53 | 34.6% | 1,062 adds, 223 refines/absorbs, 12,525 proposals |

- **Merge and add are 60% of visit time.** Merge grows the most (7.3 → 21.4 ms) and edits the least: 206 merges in
  4,730 visits.
- **Add is mostly proposals.** It makes 12.5k proposals for 1,062 adds.
- **The replay agrees.** A replay of 236 captured Discover jobs through `VisitRunner` (the app's path), one repetition,
  gives 56.9 ms per visit: keep 6.3, load 3.9, solve 3.7, split 4.4, refine 4.5, merge 14.3, add 19.8.
- **Final settle visits** (3,621, refine scope) are 22 ms each: refine 61%, load 21%, solve 18%.

Native `observe` by Discover chunk (ms per call):

| frames      | cells | render | whiten | scale | ledger | fpstats | clusters | reservoir | total | fpstats+clusters |
| ----------- | ----: | -----: | -----: | ----: | -----: | ------: | -------: | --------: | ----: | ---------------: |
| 0–1.1k      |   178 |   0.07 |   0.17 |  0.21 |   0.03 |    0.05 |     0.00 |      0.16 |  0.72 |               7% |
| 4.7k–5.9k   |   536 |   0.19 |   0.17 |  0.22 |   0.27 |    0.44 |     0.27 |      0.16 |  1.75 |              41% |
| 9.5k–10.7k  |   707 |   0.25 |   0.17 |  0.22 |   0.42 |    0.70 |     0.56 |      0.18 |  2.53 |              50% |
| 14.3k–15.5k |   812 |   0.31 |   0.17 |  0.23 |   0.55 |    0.90 |     0.71 |      0.20 |  3.11 |              52% |
| 22.7k–23.7k |   904 |   0.34 |   0.17 |  0.23 |   0.61 |    1.04 |     0.87 |      0.20 |  3.49 |              54% |

## 4. Quality with skipped frames

v3 sims, 9,600 frames, seeds 1–2, native `qc_eval` (timing build), `demix_metrics.py`. Quality is measured after the
Final settle over all frames, as in the app. Arms:

| arm                                                                  | frames observed | `--visit-rate` | visits |
| -------------------------------------------------------------------- | --------------: | -------------: | -----: |
| `all`                                                                |     every frame |            0.2 |  1,910 |
| `keep067` (`--slow-keep 0.67`, app-like: same visits per frame read) |           6,400 |            0.3 |  1,919 |
| `keep067vr02` (control: same cap per observed frame)                 |           6,400 |            0.2 |  1,280 |

| sim          | arm         | cells | matched | false | recall (seed 1 / 2) | mean recall |
| ------------ | ----------- | ----: | ------: | ----: | ------------------- | ----------: |
| v3_static_s6 | all         | 747.5 |   739.5 |   8.0 | 0.921 / 0.925       |       0.923 |
| v3_static_s6 | keep067     | 747.0 |   744.0 |   3.0 | 0.928 / 0.930       |       0.929 |
| v3_static_s6 | keep067vr02 | 748.0 |   743.5 |   4.5 | 0.929 / 0.928       |       0.928 |
| v3_motion_s5 | all         | 770.0 |   717.5 |  52.5 | 0.877 / 0.883       |       0.880 |
| v3_motion_s5 | keep067     | 767.5 |   711.0 |  56.5 | 0.870 / 0.875       |       0.872 |
| v3_motion_s5 | keep067vr02 | 752.5 |   710.0 |  42.5 | 0.868 / 0.875       |       0.871 |

**Static: no loss.** Seeing two thirds of the frames is, if anything, slightly better on static_s6: recall +0.006 and 3–5
false cells instead of 8.

**Motion: a small, consistent loss.** On motion_s5, recall drops by 0.008 on both seeds. That is about the size of the
seed spread (0.006), but it has the same sign twice. False cells are about the same.

**Visits don't matter here.** Holding visits per frame read (`keep067`) or not (`keep067vr02`) makes no difference, so
the cost on motion comes from the frames the slow loop does not see, not from fewer visits.

**Conclusion.** Skipping a third of the frames costs at most about 1 point of recall on the motion sim and nothing on
the static one. Frame skipping at Max is not where quality is lost, which supports the parked decision
(`cala-slow-worker-offload-parked`).

## 5. Native threads kill test

`--features timing,threads`: rayon over the per-cell statistics and the cluster pushes of a fitting frame.
`RAYON_NUM_THREADS` is set to 1, 2, 4 and 8. The sim is v3_static_s6, seed 1, run alone on the machine. The baseline is
the same timing build without `threads`, run twice. Values are ms per `observe` call from the stage timers.

| run               | Discover observe | fpstats+clusters | their share |  speed-up | settle observe |  speed-up | wall s | footprints.bin / final.tsv |
| ----------------- | ---------------: | ---------------: | ----------: | --------: | -------------: | --------: | -----: | -------------------------- |
| no threads (ctl1) |            1.716 |            0.623 |         36% |     1.00x |          2.053 |     1.00x |    285 | (reference)                |
| no threads (ctl2) |            1.735 |            0.631 |         36% |     0.99x |          2.032 |     1.01x |    285 | same / same                |
| threads, 1        |            1.701 |            0.624 |         37% |     1.01x |          2.041 |     1.01x |    283 | same / same                |
| threads, 2        |            1.443 |            0.370 |         26% |     1.19x |          1.705 |     1.20x |    276 | same / same                |
| threads, 4        |            1.321 |            0.240 |         18% | **1.30x** |          1.545 | **1.33x** |    273 | same / same                |
| threads, 8        |            1.332 |            0.234 |         18% |     1.29x |          1.552 |     1.32x |    275 | same / same                |

- **Bit-identity holds.** `footprints.bin` and `final.tsv` match byte for byte at every thread count, and between the two
  no-threads controls. So `qc_eval` is deterministic and the threaded path changes nothing. The unit test
  `threaded_statistics_are_bit_identical_for_any_thread_count` checks the same at 1 and 4 threads.
- **The parallel part itself scales 2.6x at 4 threads** (0.62 → 0.24 ms) and gains nothing beyond 4.
- **Kill.** Both criteria fail:
  - Observe speeds up 1.30–1.33x at 4 threads, below 1.5x.
  - fpstats+clusters is 36–37% of observe on this sim, below about 44%.
- **The workshop library doesn't rescue it.** There fpstats+clusters is 50–54% of late-Discover observe and 55% of
  settle observe. At the measured 2.6x, Amdahl gives 1.47x and 1.51x. That is an upper bound: in the app, the fast loop,
  four visit workers and the look-back worker already compete for the 6 P-cores. Whole-run wall time moves 4% because
  visits run inline in native `step`.

## Implications for stage 1

**The gate ("the two unexplained costs are explained") is met.** The slow worker's time is all WASM work plus real idle;
there is no hidden GC, deserialisation or glue. The unexplained part came from two things:

- native-ms models that leave out `housekeep`, `need` and visit hand-out;
- a native `observe` reference that is too low for the settle, and about 1.3–1.5x too optimistic for Discover under
  browser contention.

**Threads are killed** (section 5). Stage 1 should go after these instead, in order of what they buy:

1. **`housekeep` per applied visit.** It costs 2.4–2.7 ms per settle frame (23% of the settle's wall) and 0.75 ms per
   observed frame in Discover (11%). `prune()` scans every cell's ledger after every applied job. Running it once per
   batch or answer, or only over the cells the job touched, should remove most of that without changing a decision.
   This needs a check that the prune order doesn't matter, or a bit-identity test. It is the cheapest large win.
2. **Final settle overlap.** The settle alternates between the slow worker (9.0–9.5 ms per frame) and look-back worker 0
   (8.3–8.6 ms per frame) with one answer in flight, so it runs at 88–92 fps. Two answers in flight would let them
   overlap: about 105–110 fps, then about 115 fps once item 1 has trimmed the slow worker. A second end-settle reader is
   the step after that. The look-back worker's time is 42% preprocess and 55% trace solve.
3. **`takeJob` in the settle**: 1.1 ms per settle frame (10%). It is the job encoding with the tile's reservoir; about
   20% of the calls return no job.
4. **`observe` itself, single-threaded.** Ledger, fpstats and clusters are 2.7 of 4.1 ms per frame in Discover, and they
   grow linearly with cells. The #503/#504 kind of work (cheaper per-cell statistics) remains the main lever for
   Discover. Discover is 85% busy, so each ms per frame saved there turns into observed frames.
5. **Visits** (on the visit workers, off the slow worker's path): merge and add are 60% of a visit, and merge grows the
   most while editing the least. They matter for visit-worker capacity and the settle's visit rate, not for the slow
   worker.

Skipping frames at Max costs at most about 1 point of recall on the motion sim (section 4), so reducing skips is not a
quality priority.
