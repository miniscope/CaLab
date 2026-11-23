# Target processing rate slider: calibration and paced Chrome runs (21 Nov 2026)

"PR 2" of the work-slider design (`~/Projects/cala-data/demix-bench/work_slider_design.md`). The plan, the arms and
every line (C1, L1-L9, and the step-0b decision rule) were committed before any run:
[2026-11-21-work-slider-plan.md](2026-11-21-work-slider-plan.md) (commits `b677e135`, `4c994552`, `27a70321`; the
last is the PI's names only). Names: Live, Discovery, Look-back (need-driven re-reads for new cells), Background
settle (settle during Discover; qc_eval `--csettle`, app `?csettle`), Final settle (after Discover; qc_eval
`--settle-frames`), Spare.

**Order of work.** Steps 2 (calibration) and 3 (paced Chrome) were interleaved: the model flags were written and
byte-checked first, then the five Chrome runs were made with no qc_eval of mine running (Chrome needs a quiet machine
and a frozen tree), then the long qc_eval runs. Another agent's Chrome run (port 5199) finished before mine started.

## Summary

1. **One look-back worker delivers more than the design estimated on Samara, and about the estimate on the workshop
   recording.** Background-settle dose per live frame (design: about 55 / target, so 0.92 at 60 fps and 0.46 at 120):
   Samara `10_43_21` 1.29 at 60 fps and 0.63 at 120; workshop 0.84 and 0.49. The worker re-reads 147-154 frames a
   second on Samara when Discover is paced (107-114 beside a full-speed Discover) and 91-97 on the workshop recording
   whatever the pace.
2. **On the workshop recording the slow worker is already a limit at 60 fps.** It misses 3.35 % of the live frames
   with the background settle on and 1.66 % with it off (0 on Samara at 60). At 120 fps it misses 22 % (Samara
   2.15 %). With the background settle off the look-back worker is full with need-driven look-back alone at 60 fps on
   the workshop recording (1.69 of the 2 frames per observed frame it may ask for, 99 re-reads a second).
3. **The clean finding: at 60 and 120 fps the re-read supply is below the cap of 2 on both recordings** (1.29 and 0.63
   on Samara, 0.84 and 0.49 on the workshop recording), and need-driven look-back gets as many frames as the
   background settle, so it is halved too.
4. **Second look-back worker.** By the rule committed before the runs the reading is mixed: Samara meets the
   "warranted" conditions at 60 fps (dose 1.29 < 1.5, 154 re-reads a second, no missed frames); on the workshop
   recording the slow loop misses 3.35 % (1.66 % of it with the settle off, and the bursty pacer may cause part) and the
   look-back worker is full too. What the runs support: **on supply grounds, yes for Samara-like recordings at 60-120
   fps** (dose under the cap, slow worker with room); **on dense recordings, extra supply lands on a slow worker that
   already misses frames, and pays only once the statistics update moves off it** (spare-compute item 1 below).
   **Whether more dose improves the final result is unmeasured**: line L8 needs qc_eval quality arms, which C1 now bars
   (item 6), or Chrome arms once the pool exists. Observed but not evidence (dose and rate are confounded, one run
   each): on Samara the final settle moved 31 % of cells above twice their noise at dose 0.63 (120 fps), 32 % at 1.29
   (60 fps) and 30-33 % at 1.99 (30 fps).
5. **On the workshop recording the pace alone makes the final settle move more,** and the background settle at 0.84
   takes some of it back: 83 % of cells above twice their noise at 60 fps with the settle off, 67 % with it on, 76-77
   % at full speed (with 15 % more cells at 60 fps: 853-867 against 749-756).

6. **Calibration line C1 fails at 30 fps, on visit jobs only** (model +26 to +45 %; at full speed -56 to -59 %).
   The background-settle dose is within 15 % at every Samara point (also 60 and 120 fps, never fitted); total re-read
   supply is within 15 % up to 60 fps (+18 % at 120); the turn-taking split is not (the app splits the worker 50:50 in
   every run, the model gives need-driven about 57 %, so need-driven is +15 % at 60 fps and +30 % at 120). The 30 fps
   passes on need-driven and dose are cap-bound (rounds 2-3 delivered 2.00 without the gate); the evidence for the gate
   is the full-speed and 60/120 fps rows. Discovery's visit rate is not calibrated. By the plan, no slider arm was run
   in qc_eval. Next: the design's PR 3 instrumentation (busy and idle time per worker in the app), then refit the visit
   side.
7. **Where the background settle is limited** (PI question): 30 fps, the cap on Samara and the re-read supply on the
   workshop recording; 60 fps, supply on both, plus the slow worker on the workshop recording; 120 fps, the slow worker
   on the workshop recording and supply on Samara. A ranked list of other uses of spare compute is at the end; first is
   moving the statistics update (1.4-3.9 ms per re-read frame, 2.1-5.9 ms per fitted frame) off the slow worker.

## Step 0b: paced Chrome runs (`main` + this branch's eval-only changes)

`apps/cala/scripts/memory-measure.mjs --single --lookback [--csettle] --headed --every 5 --pacefps N`, dev server on
port 5198, headed Chrome (Metal GPU, 18 cores, 4 visit workers). One run each; the fifth (workshop, 60 fps, settle
off) was added as the plan's spare run, for the calibration. Runner and logs: `~/Projects/cala-data/runs/work-slider/
chrome` (`run.sh`, `load.txt`: load average 3.3-5.7 at the starts). Table: `work_slider_summary.py chrome`.

The app build of this branch differs from `main` only by a read-only accessor (`LbSched::credit`, not exported to
JS), so the WASM was rebuilt but the app's behaviour is `main`'s.

| run                   | target fps | achieved | Discover s | final settle s | slow loop missed | need-driven asked (per observed frame) | background settle per live frame | re-reads per s (both kinds) | slow worker per 16-frame answer, mean (longest) | visit jobs | cells | final settle: moved > 2x / > 1x noise, median change | peak tab GB |
| --------------------- | ---------- | -------- | ---------- | -------------- | ---------------- | -------------------------------------- | -------------------------------- | --------------------------- | ----------------------------------------------- | ---------- | ----- | ---------------------------------------------------- | ----------- |
| Samara `10_43_21`, on | 60         | 60.1     | 298        | 100            | 0.00 %           | 22,904 (1.28)                          | **1.29**                         | 154                         | 25 ms (54)                                      | 36,585     | 373   | 32 % / 70 %, 14.6 %                                  | 2.6         |
| Samara `10_43_21`, on | 120        | 120.1    | 149        | 95             | 2.15 %           | 10,960 (0.63)                          | **0.63**                         | 147                         | 22 ms (55)                                      | 21,082     | 356   | 31 % / 73 %, 15.3 %                                  | 2.9         |
| workshop, on          | 60         | 60.1     | 395        | 222            | 3.35 %           | 19,192 (0.84)                          | **0.84**                         | 97                          | 62 ms (144)                                     | 21,190     | 853   | 67 % / 95 %, 25.0 %                                  | 3.4         |
| workshop, on          | 120        | 120.1    | 198        | 214            | 22.0 %           | 8,992 (0.49)                           | **0.49**                         | 91                          | 56 ms (128)                                     | 8,994      | 807   | 73 % / 96 %, 28.0 %                                  | 3.4         |
| workshop, off         | 60         | 60.1     | 395        | 228            | 1.66 %           | 39,241 (1.69)                          | -                                | 99                          | -                                               | 25,306     | 867   | 83 % / 97 %, 36.1 %                                  | 4.0         |

Earlier runs for comparison (`2026-11-21-csettle-app.md`): Samara `10_43_21` on at 30 fps dose 1.99, 119 re-reads a
second, 0 missed, 30-33 % above 2x; at full speed (338 fps) dose 0.21-0.22, 19-22 % missed, 42-45 % above 2x.
Workshop on at full speed (216 fps): dose 0.33-0.34, 86-90 re-reads a second, 37-39 % missed, 72-73 % above 2x.

- **The fast loop held every target**: achieved 60.1 and 120.1 fps. The longest stretch without a new frame is the
  start of the run (1.6-1.8 s); 122-633 stretches over 250 ms per run come from today's bursty pacer (32 frames out at
  once, then a wait), so some of the slow loop's misses at 60-120 fps may be the pacer's bursts filling the four
  forward buffers. The smooth pacer (PR 1, another agent) will tell.
- **Need-driven look-back gets half the worker.** With turn-taking the need-driven frames equal the background-settle
  frames in every run (both kinds are asked in 16-frame requests, one out at a time). On the workshop recording at 60
  fps the background settle therefore halves need-driven look-back (1.69 to 0.84 per observed frame).
- **The slow worker's cost per re-read frame:** 1.4-1.6 ms on Samara and 3.5-3.9 ms on the workshop recording per
  frame re-read (mean answer time / 16); a third of the frames are held out and not fed, so per fitted frame it is
  about 1.5x that: 2.1-2.4 ms and 5.3-5.9 ms. The background settle took 12 % of the slow worker's wall time on Samara at 60 fps (36 s of 298)
  and 19 % on the workshop recording (74 s of 395).
- **Why the workshop recording is slower on both workers** (not measured, likely): 2-2.3x the cells (750-870 against
  350-390), and both the look-back worker's solve and the slow worker's statistics update grow with the cells per
  frame.

### Against the design's table

| target | design: 1 worker taking turns | measured Samara | measured workshop | design: slow-worker ceiling, workshop / Samara |
| ------ | ----------------------------- | --------------- | ----------------- | ---------------------------------------------- |
| 30     | 2 (cap)                       | 1.99            | not run           | 7.8 / high                                     |
| 60     | 0.9                           | 1.29            | 0.84              | 2.9 / 9                                        |
| 120    | 0.46                          | 0.63            | 0.49              | 0.4 / 3.5                                      |

The design's re-read rate (110 a second) is right for the workshop recording and 35-40 % low for Samara when Discover
is paced. Its slow-worker ceiling on the workshop recording is optimistic at 60 fps: the slow loop already misses
frames there at dose 0.84.

## Step 0: the model against the app

`qc_eval --offered-fps F --visit-workers 4 --pool 4` (`Timed` in `crates/cala/examples/qc_eval.rs`) against
`apps/cala/src/lib/slow-runner.ts` and the workers on `main`. New in this PR (all default off; with every one off the
output is byte-identical to `main`, see T0 below):

| app (`slow-runner.ts`, workers)                                                                                                                                                                                                     | model before this PR                                                                                                                                         | model with the calibration flags                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Need-driven look-back: after each observed batch `lookbackNote(seen, observed)` adds 2 frames of budget per observed frame; with no request out, `lookbackTake(16)` sends at most 16 frames to the look-back worker (`needRequest`) | the budget was earned per recording frame and spent at once at the live frame; the look-back worker's time was booked (`lb_note`) but never limited anything | `--lb-gate`: budget per forwarded frame; a request of at most `--lb-take` (16) frames goes out only when no request is out and the worker is free; its answer is a message the slow worker handles at the worker's finish time, and no request goes out until it has been handled (`NeedAnswer`). The frames still enter the statistics at the live frame (up to one request early) |
| Background settle (`?csettle`): `SettleDose` earns 2 per observed frame, at most 64 owed; one 16-frame request; need-driven and settle take turns when both want the worker (`lookbackRequest`, `cs.turn`)                          | the settle's requests queued behind need-driven time on the worker; no turn-taking                                                                           | `--lb-gate`: the same turn-taking (`cs_turn`; a settle request waits while need-driven wants frames and it is not the settle's turn)                                                                                                                                                                                                                                                |
| The look-back worker re-reads, preprocesses and solves each frame; it reports no timing                                                                                                                                             | `--lb-ms` per frame (5 in rounds 2-3, flag default 10)                                                                                                       | `--lb-ms A --lb-ms-per-cell B`: A + B x cells of the newest library per frame (the re-read rate falls as cells accumulate)                                                                                                                                                                                                                                                          |
| Visit workers: a visit costs its compute; the slow worker pays encode, copy and decode per job                                                                                                                                      | work at `--units-per-ms` on both the slow worker and the visit workers, `--job-ms` on each side                                                              | `--visit-units-per-ms` sets the visit workers' rate apart from the slow worker's (not needed in the end; see below)                                                                                                                                                                                                                                                                 |
| Slow worker: live batches (`observe`, `housekeep`, `dispatch`), visit results, look-back and settle answers, one message at a time                                                                                                  | the same                                                                                                                                                     | unchanged                                                                                                                                                                                                                                                                                                                                                                           |

Not modelled: the fast loop (the offered rate is fixed at what Chrome achieved, so the fall of Discover's rate as
cells accumulate is not in the model), the pacer's bursts, contention for cores, garbage collection, message latency.

### T0. Flags off = main: pass

`work_slider.sh t0`, static_s5, first 4800 frames, against `qc_eval-main-d37da856`: lock-step with a final settle (19
files), `V30`, `CS2`, `CS2F` with four visit workers, and round 1's single-worker settle (`--offered-fps 30 --csettle
0.75 --csettle-mode stats`, unchecked since round 3) are identical apart from wall-time fields.

### What the Chrome samples say about the cost parameters

- **Visit workers are not the limit at 30 fps in Chrome.** The 5 s samples carry the time of the last visit
  (`visitMs`): mean 20-29 ms on Samara `10_43_21` at 30 fps (round 3's model: 23 ms) at 86-92 jobs a second, so the
  four workers were about half busy (the model: 70 %). The model's surplus of jobs (73,000 against 51,000-55,000) is
  therefore not a visit cost that is too low; changing `--visit-units-per-ms` would not remove it.
- **The look-back worker's time per frame grows with the cells**: workshop at 60 fps, 116 re-reads a second at 640
  cells down to 92 at 863 (8.6 to 10.9 ms); Samara 145-163 a second at 260-375 cells. A straight line through the two
  workshop points gives 2.0 ms + 0.0103 ms per cell; it predicts 5.6 ms on Samara at 350 cells against about 6.5 ms
  measured (that check uses Samara data and is reported, not fitted). The first fitting round uses these two numbers.

### Fitting on the workshop recording

Round 1 (`--lb-gate --lb-ms 2.0 --lb-ms-per-cell 0.0103`, `--units-per-ms 2e6`, `--job-ms 1`; slow seed 1, full
length, binary `qc_eval-cal-c`):

| workshop              | Chrome: missed, visit jobs, need-driven, background settle per live frame | model round 1              |
| --------------------- | ------------------------------------------------------------------------- | -------------------------- |
| full speed (218), off | 33.4 %, 4,628, 10,320, -                                                  | 16.9 %, 3,092, 8,594, -    |
| full speed (216), on  | 38.2 %, ~3,800, 4,900, 0.335                                              | 18.1 %, 3,025, 4,176, 0.19 |
| 60 fps, off           | 1.66 %, 25,306, 39,241, -                                                 | 0 %, 30,356, 33,598, -     |
| 60 fps, on            | 3.35 %, 21,190, 19,192, 0.84                                              | 0 %, 26,401, 17,293, 0.58  |
| 120 fps, on           | 22.0 %, 8,994, 8,992, 0.49                                                | 0.1 %, 8,394, 8,560, 0.32  |

Reading: the modelled slow worker is too fast (at full speed it observes about 181 frames a second, Chrome 145), and
the look-back supply is about 20 % low. The paced runs' misses are not used for the fit: today's pacer releases up to
four batches at once, which can fill the four forward buffers whatever the slow worker's mean load. Its time per
16-frame settle answer: model 33-38 ms, Chrome 56-62 ms.

**Round 2, the last (fixed here, before any Samara model run, whatever round 2 shows on the workshop):**
`--units-per-ms 1.6e6` (the slow worker's time x 1.25 = 181 / 145) and `--lb-ms 1.6 --lb-ms-per-cell 0.0082` (the
look-back worker's time x 0.8), `--lb-gate`, `--job-ms 1`, visit workers at `--visit-units-per-ms 2e6` (unchanged: the
Chrome samples show the visit workers are not the limit). The Samara runs for C1 use exactly these flags.

## Where the background settle is limited, by rate (for the PI)

From the Chrome runs (one run each). "Supply" = the one look-back worker's re-reads, shared with need-driven
look-back; "slow worker" = its time per re-read frame (the statistics update) and the live frames it misses.

| target  | Samara `10_43_21` (300-400 cells)                                                                                                                                                  | workshop (750-870 cells)                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 fps  | **the cap** (1.99 of 2). The worker re-read 119 a second and had room (it managed 147-154 at 60-120 fps); the slow worker spent 10 % of its time on the answers and missed nothing | not run in Chrome. The worker re-reads about 95 a second at this cell count against 120 asked (60 need-driven + 60 settle), so **supply**, about 1.6 per live frame for each kind (estimate; model below) |
| 60 fps  | **supply**: 154 re-reads a second, dose 1.29. Slow worker fine (0 missed, 12 % of its time on settle answers)                                                                      | **supply and the slow worker**: 97 a second, dose 0.84; the slow loop misses 1.66 % with the settle off and 3.35 % with it on; 19 % of the slow worker's time goes to settle answers                      |
| 120 fps | **supply** (147 a second, dose 0.63), and the slow worker starts to miss (2.15 %)                                                                                                  | **the slow worker** (22 % missed), then supply (91 a second, dose 0.49)                                                                                                                                   |

The statistics update costs the slow worker 1.4-1.6 ms per re-read frame on Samara and 3.5-3.9 ms on the workshop
recording (2.1-2.4 and 5.3-5.9 ms per fitted frame; a third are held out and not fed). A live frame costs it about 3.5
and 6.9 ms of its time in all at full speed. So each re-read frame for the settle displaces roughly half a live frame
on the workshop recording once the slow worker is full. All numbers in this file are n = 1: one Chrome run per cell
and one model seed.

## Other uses of spare compute (ranked; not for this PR)

At 30 fps the fast loop uses about a tenth of the machine; in Chrome the visit workers were about half busy at 30 fps
on Samara (mean visit 20-29 ms at 86-92 jobs a second over four workers), and the look-back worker had room. Ranked by
expected gain in the final result per unit of work, with rough size and risk:

1. **Statistics updates off the slow worker** (re-read frames first, live frames later). The update is
   `SlowLoop::update_fpstats` (per cell, moments over a disk of the support plus a margin; then the cluster statistics):
   additive, at the current forgetting weight. The look-back worker already renders the model for each frame it
   re-reads; it could sum one 16-frame delta per cell and send it with the answer, and the slow worker would only add
   it. Gain: frees 12-19 % of the slow worker at 60 fps (more on dense recordings), which is the limit on the
   workshop recording from 60 fps up and lets the slow loop miss fewer live frames. Size: about 300-500 lines (engine
   delta type, worker, apply path, a test that the summed delta equals 16 calls of `observe_settle`). Risk: medium-high
   (weight and order of forgetting, library version between request and answer (stale answers are already dropped),
   cluster statistics, message size: cells x disk pixels x moments, several MB per chunk on the workshop recording).
2. **The slow loop sees every live frame at higher rates.** At full speed it misses 15-34 % of the frames, at 30 fps
   none, and a 30 fps run ends with about 20 % more cells (Q1 of the design). The slow worker is the limit; item 1
   applied to live frames is the way to give it room, or more forward buffers where the misses are bursts. Gain:
   unknown on quality (the cells that appear with the pace are not yet shown to be real); size: as item 1 plus the
   live path; risk: medium. Measure first: the `P-f` arms against `REF` in qc_eval (lines L2-L2c).
3. **More re-read workers** (a look-back pool: one for need-driven look-back, one or more for the background settle).
   Gain: doubles supply where supply is the limit (Samara at 60-120 fps, the workshop recording at 30-60 fps), stops
   the settle halving need-driven look-back (1.69 to 0.84 per observed frame on the workshop recording at 60 fps), and
   shortens Samara's final settle (re-read-limited at about 200 a second). On dense recordings it moves the load onto
   the slow worker, so it pays fully only with item 1. Size: about 300 lines (the design's PR 5). Risk: low-medium;
   memory about 0.15-0.3 GB a worker (design estimate). Line L8 decides whether the dose it buys is worth it.
4. **Doses above 2 at 30 fps and below** (cap 4 and 8; line L9). Costs only re-read supply, which has room on Samara
   at 30 fps. Gain unknown (round 3 ties the larger footprints to lost marginal cells). Size: a constant. Risk: low to
   try, quality risk measured by L9.
5. **Idle visit workers.** Settle visits on them did nothing measurable in round 2 (2-82 refinements in 5,800-22,500
   jobs), because the ordinary visits already refine. A lower due threshold (`visit_after_slots`) would make visits
   more frequent; it changes Discover itself and needs its own benchmark. Gain: likely small. Risk: medium (cell
   counts moved with visit frequency in round 3).
6. **The final settle sooner or shorter**: with items 1 and 3 the final settle (88-228 s) runs faster; the adaptive
   final settle (design section 3) saves time, not quality.

## C1: the calibrated model against Chrome on Samara (holdout): **fails at 30 fps, on visit jobs only**

Round-2 flags (frozen above), slow seed 1, full length, binary `qc_eval-cal-c` (T0 passes for this binary too).
Model / Chrome, and the C1 reading (within 15 %; misses within 3 points):

| recording, rate, arm        | slow loop missed                    | visit jobs                       | need-driven asked          | background settle per live frame |
| --------------------------- | ----------------------------------- | -------------------------------- | -------------------------- | -------------------------------- |
| `10_43_21`, 30, off         | 0 / 0 % pass                        | 71,466 / 54,849 (+30 %) **fail** | 35,399 / 35,415 pass       | -                                |
| `10_43_21`, 30, on          | 0 / 0 % pass                        | 64,716 / 51,257 (+26 %) **fail** | 35,405 / 35,415 pass       | 2.00 / 1.99 pass                 |
| `14_57_02`, 30, off         | 0 / 0 % pass                        | 74,289 / 51,340 (+45 %) **fail** | 35,389 / 35,407 pass       | -                                |
| `14_57_02`, 30, on          | 0 / 0 % pass                        | 67,538 / 49,810 (+36 %) **fail** | 35,389 / 35,407 pass       | 2.00 / 1.99 pass                 |
| `10_43_21`, full (338), off | 22.7 / 19.5 % **fail** (3.2 points) | 1,558 / 3,669 (-58 %) **fail**   | 5,665 / 6,656 (-15 %) pass | -                                |
| `10_43_21`, full (337), on  | 23.9 / 22.2 % pass                  | 1,530 / 3,459 (-56 %) **fail**   | 2,800 / 2,920 pass         | 0.19 / 0.215 (-12 %) pass        |
| `14_57_02`, full (345), off | 22.5 / 14.9 % **fail**              | 1,596 / 3,903 (-59 %) **fail**   | 5,761 / 6,464 (-11 %) pass | -                                |
| `14_57_02`, full (343), on  | 22.7 / 15.9 % **fail**              | 1,587 / 3,699 (-57 %) **fail**   | 2,880 / 2,832 pass         | 0.19 / 0.19 pass                 |

Comparison points (step-0b runs, not part of C1): `10_43_21` at 60 fps on: missed 0 / 0 %, jobs 35,897 / 36,585, need
1.48 / 1.28 per observed frame, background settle 1.11 / 1.29; at 120 fps on: missed 0 / 2.15 %, jobs 11,957 / 21,082,
need 0.82 / 0.63, background settle 0.63 / 0.63. Workshop after round 2 (fit set): full off missed 27.0 / 33.4 %,
jobs 2,437 / 4,628, need 8,435 / 10,320; full on background settle 0.23 / 0.335; 60 fps on 0.67 / 0.84, need 0.82 /
0.84, jobs 19,647 / 21,190; 60 fps off need 42,526 / 39,241, jobs 25,620 / 25,306; 120 fps on 0.30 / 0.49.

**Verdict, by the plan's rule: C1 fails at 30 fps, so no slider arm is run in qc_eval** (step 4 not run).

(Changed after a run, 22 Nov 2026: the 30 fps references here predate the smooth pacer (#455); against smooth-pacer
references C1 passes at 30 fps and still fails at full speed. See [2026-11-22-visit-refit.md](2026-11-22-visit-refit.md).)

What the failure says:

- **The look-back dose is calibrated; the split is not.** The background-settle dose is within 15 % at every Samara
  point, including the 60 and 120 fps runs the fit never saw; need-driven frames miss at 60 fps (+15 %) and 120 fps
  (+30 %) because the model gives need-driven about 57 % of the worker where the app splits 50:50. The
  gate (one request out, turn-taking, the answer holding the worker until the slow worker handles it) and the
  per-cell look-back cost carry it. qc_eval can be used for the look-back pool's sizing (line L8's supply side).
- **Discovery's visits are not.** The model makes 26-45 % too many visit jobs at 30 fps and 56-59 % too few at full
  speed, in opposite directions, so no single cost scale fixes both: a slower slow worker lowers both. In Chrome the
  slow worker still hands out about 69 visits a second at full speed while it misses 15-22 % of the frames, which a
  saturated modelled slow worker (100 % busy) cannot do; and at 30 fps Chrome makes fewer visits than the model with
  its visit workers about half busy. Two candidates, not tested: (a) at full speed the frames are lost in the forward
  buffers' round trip (transfer and latency), not because the slow worker is full, so the app's slow worker keeps
  time for visits; (b) the app's hand-out differs from the model's (for example `dispatch` hands nothing out while
  reviewed cells wait for the visits out, and only after batches and results). The design's PR 3 (busy and idle
  accounting in the slow, visit and look-back workers, batch waits) gives the numbers to fit this; until then the
  slow loop's misses and visit counts above 30 fps are Chrome-only, and quality arms in qc_eval carry a visit-rate
  error of about a third.
- Workshop at 30 fps, from the model (no Chrome run): the settle is supply-limited there, 1.04 per live frame with
  need-driven look-back at 1.46 per observed frame (the model's workshop supply ran about 20 % below Chrome's at 60
  fps, so the app likely delivers about 1.2-1.3).
