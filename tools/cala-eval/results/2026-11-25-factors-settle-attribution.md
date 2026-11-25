# Where the Final settle's time goes on factors (the default since #517)

25 Nov 2026. Branch `perf/factors-settle-attribution`, on `main` at `09712d21` (#514, #515, #516 and the factors work
#493, #501, #505, #517). The note follows Stage 0 (`2026-11-24-stage0-attribution.md`) and the Stage 1 Chrome
measurement (`~/Projects/cala-data/runs/stage1-chrome/RESULTS.md`), this time on the settle that reads the GPU factors.

Raw runs, logs, profiles and scripts are in `~/Projects/cala-data/runs/factors-settle/`. Tables come from
`tools/cala-eval/stage0/settle_ports.py`, and profiles from `cpuprofile_summary.py` and `cpuprofile_bindings.py`.

## Instrumentation added

- **Factor wait.** `?debug` detail `end.factorWait`: the time from Discover's end to the factors' answer.
- **Pool at Max.** `?debug&lbpoolmax` is a measurement arm, not instrumentation, because it changes behaviour. It
  starts the settle pool at Max too. Without it the pool never starts at Max. The flag is in `KNOWN_FLAGS`, so a run
  record shows it.
- **`memory-measure.mjs`.**
  - `--profile-lookback` profiles the look-back workers in the `--profile-slow` windows.
  - Each work sample now also records the settle status (source, workers, fed/total) and the compressor status
    (backend, Discover's GPU waits, lag at the end).
- **`settle_ports.py`.** Settle tables over every look-back worker (`duty_tables.py` reads worker 0 only).
- **`cpuprofile_bindings.py`.** Charges each sample to the binding that called it, because the release WASM has no
  function names. That separates `reconstruct` from `processFrames` on the look-back side.

`FactorReader` already reports its timing split:

- **read**: the window file read and decode, once per 600-frame window;
- **preprocess**: here, the rebuild from factors (`reconstruct` plus the never-valid NaN pass);
- **solve**: the trace solve;
- **other**: mostly the solver build when a new library arrives (`fromBytes`, about 1% in the profile).

Nothing else was missing.

## Runs

- Headed Chrome 156 on the real GPU (Metal), M-series machine with 18 logical cores (6P + 12E).
- Workshop recording, read-only, 600×600 px, 23,711 frames.
- Max, `--single --lookback`, `?debug`, plain WASM (md5 `b575a1d9`), tree `eb13ce29`.
- One Chrome job at a time, in the order F1, R1, F2, P1, X1.
- Background load: the Jamf agent used about one core throughout; others' idle vite servers.
- One rule slip: `cpuprofile_bindings.py` (under `tools/`, outside the vite root) was written while X1 ran.

| run                          | Discover s | Discover fps | factor wait s | settle s | settle fps | source    | workers | peak RSS GiB, to final / all | cells | GPU waits s (n) | settle jobs per frame | jobs/s |
| ---------------------------- | ---------: | -----------: | ------------: | -------: | ---------: | --------- | ------: | ---------------------------: | ----: | --------------: | --------------------: | -----: |
| F1, default                  |        114 |          208 |           0.3 |      204 |       88.1 | factors   |       1 |                  4.30 / 5.85 |   791 |         0.4 (2) |                 0.665 |   58.6 |
| F2, default                  |        117 |          203 |           0.4 |      202 |       89.1 | factors   |       1 |                  4.18 / 5.81 |   789 |         0.5 (2) |                 0.641 |   57.1 |
| R1, `?factors=0`             |        109 |          217 |             - |      181 |       99.3 | recording |       1 |                  4.06 / 4.06 |   791 |               - |                 0.676 |   67.1 |
| P1, default + CPU profiles   |        115 |          207 |           0.4 |      189 |      95.2¹ | factors   |       1 |                  4.39 / 5.78 |   764 |         0.4 (2) |                 0.625 |   59.5 |
| X1, `&lbpoolmax` (extra arm) |        116 |          204 |           0.4 |      130 |      138.3 | factors   |       2 |                  4.53 / 6.00 |   798 |         0.4 (2) |                 0.212 |   29.4 |

¹ Not a timed run (profiling costs time). Its Discover ended with 764 cells instead of about 790, and its solve was
cheaper (4.6 against 5.3 ms per frame) and its `observe` 5.3 ms: fewer cells, a faster settle. So the factors settle
spans 88–95 fps over three runs, and depends on the cell count.

How to read the table:

- Every run fed the whole settle plan (17,984 of 17,984 frames) and passed `LOOKBACK_CHECK`.
- **Peak RSS.** "To final" covers Discover and the settle. "All" adds what follows the final library: the run plan
  (`multi-run.ts`, `nextAutoAction`) starts Extract at once, and on factors it runs on six compress helpers at about
  250 MB each. That is where the 5.8–6.0 GiB peaks come from, not the settle.
  - In decimal GB these peaks are 5.9–6.0 GB for F1/F2/P1 and 6.14 GB for X1. That is at or over the 6 GB per-job
    budget, briefly, after the measured part of the run.
  - It is a memory note for Extract on factors.
- **Factor wait.** The settle waits 0.3–0.4 s for the factors. The compressor is 311 frames behind at Discover's end
  and runs at 717 fps.
- **Discover.** Factors 203–208 fps against 217 for R1 (−5%), in line with #517's +4.8%.
  - Discover waited for the GPU ring only 0.4 s in 2 waits, so the cost is contention, not waiting.
  - The give-up rule (more than 10% waited) is far away on this machine.
  - One recording run only; Stage 1's recording runs spanned 214–223 fps.

## 1. The factors settle is slower than the recording settle

The factors settle runs at 88–89 fps in the timed runs (95 in the profiled run, with 764 cells). The recording
settle with #515 runs at 99 fps in R1, and at 103–109 in Stage 1's runs with 765–784 cells.

| per settle frame, ms (share of wall) |      F1 / F2, factors |           R1, recording | X1, factors, 2 workers |
| ------------------------------------ | --------------------: | ----------------------: | ---------------------: |
| slow: end `observe`                  |           5.53 / 5.60 |                    4.88 |                   5.08 |
| slow: housekeep (library builds)     |           2.14 / 2.05 |                    1.92 |                   1.23 |
| slow: visit hand-out (`takeJob`)     |           0.83 / 0.81 |                    0.78 |                   0.27 |
| slow: visit apply                    |           0.11 / 0.11 |                    0.12 |                   0.05 |
| slow: checkpoints                    |           0.20 / 0.19 |                    0.17 |                   0.14 |
| **slow busy**                        | **9.14 / 9.10 (81%)** |          **8.16 (81%)** |         **7.04 (98%)** |
| slow idle                            |           2.21 / 2.13 |                    1.91 |                   0.15 |
| look-back: read                      |           0.05 / 0.05 |                    0.19 |                   0.11 |
| look-back: rebuild / preprocess      |           3.50 / 3.53 |                    3.51 |                   3.59 |
| look-back: solve                     |           5.35 / 5.26 |                    4.96 |                   5.28 |
| look-back: other                     |           0.12 / 0.12 |                    0.00 |                   0.21 |
| look-back busy share, per worker     |             80% / 80% |                     86% |              64% / 64% |
| per answer: round trip / queued, ms  |    180 / 36, 178 / 35 | 160 / 29 (from the cue) |        229 / 82 (each) |

- **The settle is the Stage 0 alternation again.** Its frames come from factors, served by look-back worker 0 alone
  with one plain request out.
  - The next request goes out only when the slow worker handles an answer.
  - Each answer waits 35–36 ms in the slow worker's queue. The look-back worker idles meanwhile (20%).
  - The slow worker idles while the look-back worker works (19%).
  - Neither is saturated. Both cost about 9.1 ms per frame, so the wall time is about 11.3 ms per frame.
  - #515's prepare-ahead relay applies to the recording only (`relayed()` = `!factorLive`), so the default run gets
    none of it.
- **Factors don't make the look-back worker cheaper on this recording.** Rebuilding a frame from factors costs
  3.5 ms. Reading and preprocessing it from the file also cost 3.5 ms (R1).
  - The profile agrees: in the settle, `reconstruct` and the NaN pass take 41–49% of look-back worker 0's busy time
    and `processFrames` takes 49–57%.
  - The solve is about 0.3 ms per frame slower on factors (5.3 against 5.0).
- **Settle `observe` reads higher on factors, but this is tentative.**
  - F1/F2 read 5.5–5.6 ms per frame against 4.9 for R1, with the same cell count.
  - X1 (factors, fewer visits) reads 5.1, and P1 (factors, 764 cells) reads 5.3.
  - So `observe` moves with visit activity and cell count at least as much as with the source.
  - A `timing` build on both sources at equal visits would settle it. Not established here.
- **The profiles match the timers.**
  - Slow worker, settle at 20 s / 120 s: `observe` 58% / 65% of busy, `housekeep` 23% / 19%, `takeJob` 11% / 9%, idle
    24% / 15%.
  - GC is 0.2% and `(program)` 0.0%.
  - Look-back worker 0 is 18–21% idle. The JS part of the rebuild (`rebuildFrames`, which scans every pixel for
    never-valid marks on every frame) is about 2% of the sampled time, about 0.25 ms per frame.

## 2. The pool at Max (X1)

**Does the pool join at Max? No, by code.**

- `startSettlePool` requires `paceRun()`: the run's target has to have been below Max at some point.
- It also requires at least 12 logical cores for its one worker (`SETTLE_POOL`).
- F1, F2 and P1 report `workers: 1`.

With `&lbpoolmax` the one pool worker (18 cores, so S = 1) joins, and the factors settle runs on two workers.

- **Settle 130 s instead of 203 s, 138 fps (+56%).** The slow worker is now 98% busy and the limit. The two look-back
  workers are 64% busy each, and every answer waits 82 ms in the slow worker's queue.
- **But the settle hands out a third of the visits per frame.**
  - Settle visit jobs fall from 0.64–0.67 per frame to 0.21, and from 57–59 per second to 29.
  - That is why the slow worker's visit hand-out (0.83 → 0.27 ms per frame) and its library builds (2.1 → 1.2 ms per
    frame, fewer edits) fall.
  - Part of the 56% is therefore less refinement, not the same work done faster.
  - **At equal work the estimate is about 108–118 fps (+22–30%).**
    - Adding back F's per-frame visit and housekeep cost (+1.5 ms) gives about 8.5 ms per frame, about 118 fps.
    - X1's lower `observe` may also come from fewer visits. At F's full 9.1 ms per frame, the slow-bound figure is
      about 110 fps.
- **Discover is unchanged**: 204 fps, within F1/F2. The pool worker sits idle at Max during Discover, because
  Background settle is armed only below Max. Its memory costs +0.2–0.35 GiB before final.
- Cells 798 (one run). Quality was not checked here. The pooled settle is order-dependent by design.

## 3. Machine-speed dependence on this path

- **Settle visits depend on the settle's timing, not on its frames alone.**
  - Stage 1 saw it on the recording path (65–73 visits per settle second).
  - Here, the one-worker runs hand out 0.64–0.68 visits per frame, at 57–67 per second.
  - X1, 1.55x faster with its slow worker 98% busy, hands out 0.21 per frame, at 29 per second. So the visit rate
    falls per second too, not only per frame.
  - **Mechanism: the visit round trip goes through the slow worker's queue.** A visit worker gets its next job only
    when the slow worker handles its result (`handleVisit` → `dispatch`, or after an answer). With the slow worker
    saturated, results wait as long as the look-back answers do (82 ms in X1 against 35 in F).
    - The evidence is in the settle window. `takeJob` calls fall from 80–82 per second (F, R1, P1; about 28% come back
      empty) to 30 per second in X1, almost none empty.
    - The four visit workers drop from 15–42% busy each to 19–21%.
    - So due tiles were there. The hand-out was starved, which points at the slow worker's occupancy, not the visit
      logic.
  - As in Stage 1, the visit-rate sweep found that settle visits don't move cell count or recall. So the fewer visits
    in X1 are probably cheap in quality, but that is not checked here.
  - Whatever the cause, a faster settle (a faster machine, more workers) does fewer settle visits. That breaks
    `cala-compute-budget-user-visible`. It is the main confound for any settle speed-up, and it should be fixed (visits
    earned per settle frame) before a speed-up is judged.
- **Who serves the settle depends on the speed setting and the machine.**
  - The pool, and with it a second worker and an order-dependent settle, joins only if the target went below Max
    during the run, and only on machines with at least 12 cores.
  - With Auto, the policy lowers the target from measured speeds, so whether the settle is pooled depends on the
    machine.
  - At Max (the default) it never joins.
- **The settle source can depend on the GPU.** Three rules flip it:
  - #517's give-up rule: a GPU that keeps Discover waiting more than 10% after 3 windows gives up, and the settle
    reads the file;
  - the factors' answer timeout (`FACTOR_ASK_MS`, 150 s);
  - the compress backlog cap.
  - Here the waits were 0.4 s, under 0.5% of Discover.
  - A slower GPU would flip the source, and with it the settle path and its results.
- **No dependence in the settle plan.** `fed/total` is 17,984 in every arm, and the factor wait is 0.3–0.4 s.

## 4. Answers

**What limits the factors settle now?** The alternation between the slow worker and look-back worker 0.

- The settle runs at 88–89 fps (95 with fewer cells), 4–11% below the recording settle (99 fps in R1), mainly
  because the factors path has no prepare-ahead relay.
- `observe` also read 0.7 ms per frame higher in F1/F2, but X1 and P1 don't support a factors premium (see 1).
- The two workers cost about the same, each 9.1 ms per frame and 80% busy.
- Look-back worker 0's time splits about 40/60 between rebuild and solve.

**Would extending prepare-ahead to factors help?** Yes, to about the recording path's speed: about 95–99 fps, +7–11%
(estimate).

- With the relay, R1 keeps its look-back worker 86% busy.
- On factors, look-back worker 0's 9.0 ms per frame at 86% gives about 10.5 ms per frame, about 95 fps.
- The slow worker would still have 1–2 ms per frame of slack.
- It keeps one worker, so the settle stays independent of answer order.
- It is a `FactorReader` prepare/solve split, as `LookbackReader` already has. #515 notes this follow-up.

**Would a second look-back worker at Max help?** Yes, more than prepare-ahead.

- Measured: 138 fps (+56%), but with a third of the settle visits per frame.
- At equal visit work, the estimate is about 108–118 fps (+22–30%), bound by the slow worker.
- Its costs:
  - about +0.3 GiB before final;
  - an order-dependent settle;
  - a gain that grows with cores.
- With both, the slow worker is the limit, so prepare-ahead adds little on top of a pool.

## 5. Next steps, ranked

1. **Settle visits per frame, not per slow-worker occupancy (a prerequisite, not a speed step).** Without it, every
   speed-up below also cuts refinement (X1: 0.65 → 0.21 visits per frame), and its gain is overstated.
   - One way: the settle's feed holds back a batch while the visits it earned are still owed.
   - Another: visit results are handled before the next answer.
2. **Start the pool for the end settle at Max, on factors.**
   - Join the pool worker at Discover's end, not at the start.
   - Estimated +22–30% at equal work: about 89 → 108–118 fps, settle 203 → about 155–165 s. Measured +56% with fewer visits.
   - A small change: `startSettlePool` plus the existing `joinPool`/`drainPorts` path.
   - The choice to make: accept an order-dependent default settle and a core-count-dependent worker count, or keep
     one worker and do step 3.
3. **The slow worker in the settle, which is the limit once look-back overlaps.** All costs are per settle frame:
   - library builds 2.1 ms (a longer commit interval in the settle, or incremental builds);
   - `observe` 5.5 ms, of which 0.7 ms is the factors premium (a `timing` build should find where);
   - `takeJob` 0.8 ms.
   - Halving the builds is worth about +10–12% on a slow-bound settle (estimate).
4. **Prepare-ahead for factors, if the settle should stay on one worker.** +7–11% (estimate). It reaches the recording
   path's 99 fps and keeps the settle deterministic.

**Not ranked: a faster rebuild kernel.**

- WASM `reconstruct` costs about 3.5 ms per frame.
- A native loop of the same shape costs 1.13 ms per frame: offset tiling, 600 × 600 px, 64 px tiles, rank 4
  (`scripts/recon_bench.rs` in the raw dir).
- Batching 16 frames gains only 1.24x natively, because the loop is compute-bound, not memory-bound.
- The rebuild matters only while the look-back worker is on the critical path. After step 2 or 4 it is not.
