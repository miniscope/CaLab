# Visit refit of the qc_eval slow-loop model (22 Nov 2026)

Prerequisite of the work-slider PR 4. PR #456 (`2026-11-21-work-slider.md`) found calibration line C1 failing on visit
jobs only: the model made 26-45 % too many at 30 fps and 56-59 % too few at full speed. PR #459 added busy and idle
accounting per worker to the app. This file refits the model's visit side with those measurements: fit on the
workshop recording, then check C1 on Samara (held out). The fit settings, the new Chrome references and the reading
rule below were **committed before any Samara model run with them and before the Samara full-speed and `14_57_02`
Chrome runs**; commit order is the proof.

Names as in `2026-11-21-work-slider-plan.md`. "Owner" = the slow worker. n = 1 everywhere: one Chrome run per cell,
one model seed (slow seed 1).

## 1. Why the 30 fps rows failed: the C1 references were made with the old pacer

The C1 Chrome references at 30 fps (`2026-11-21-csettle-app.md`) were recorded before PR #455. The pacer then let a
step through whenever the frames done were at or below the target, with four steps in flight, so frames came 32 at a
time about once a second. PR #455's pacer releases one 8-frame batch every 267 ms. The model always offered frames
evenly.

Evidence (Samara `10_43_21`, 30 fps, visit jobs in Discover):

| source                                                                  | settle off | settle on  |
| ----------------------------------------------------------------------- | ---------- | ---------- |
| Chrome, old pacer (C1 reference, `sa-poff-1` / `sa-pon-1` era)          | 54,849     | 51,257     |
| Chrome, `main` `e8201322` (smooth pacer; this PR, `sa-p30-off` / `-on`) | **79,984** | **71,697** |
| model, round-2 flags, frames evenly (#456 `r2_sa_30_*`)                 | 71,466     | 64,716     |
| model, round-2 flags, frames 32 at a time (`--offered-burst 32`, new)   | 48,856     | 47,431     |

- The same Chrome build on the same recording makes 46 % (off) and 40 % (on) more visit jobs with the smooth pacer.
- Giving the model the old pacer's bursts (new flag `--offered-burst 32`) drops its jobs by 32 % and 27 %, to within
  11 % and 7.5 % of the old references. Each burst lets tiles collect more fresh slots before they are handed out, so
  one visit covers more slots. Over the first 1,200 frames the old Chrome run already made 1.4-1.5x fewer jobs than the
  even model; the ratio did not drift with the run.
- The visit workers were never the limit at 30 fps: about half busy in Chrome (4 workers, 2.0-2.3 worker-seconds per
  second) and 55-71 % busy in the model.

So the 30 fps visit failure was in the reference, not in the model. **C1's 30 fps references are replaced by runs of
`main` with the smooth pacer** (section 3). The pacer the slider will use is the smooth one.

## 2. Full speed: where the owner's time goes, and why the model hands out too few visits

Chrome on `main` (`e8201322`), headed, Metal GPU, 4 visit workers, port 5198, `memory-measure.mjs --single --lookback
[--csettle] --headed --every 5 [--pacefps 30]`; per-duty readings from #459 (`visit_refit_chrome_summary.py`).
Workshop recording (fit set):

| workshop, Chrome                                                        | full, off               | full, on                | 30 fps, off             | 30 fps, on               |
| ----------------------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ------------------------ |
| achieved fps / missed by the slow loop                                  | 220.8 / 33.1 %          | 217.1 / 37.7 %          | 29.7 / 0 %              | 29.7 / 0 %               |
| visit jobs in Discover                                                  | 4,598                   | 3,776                   | 54,251                  | 44,894                   |
| need-driven frames asked                                                | 10,256                  | 4,832                   | 47,079                  | 38,297                   |
| background settle per forwarded frame                                   | -                       | 0.33                    | -                       | 1.62                     |
| cells at the end of Discover                                            | 755                     | 752                     | 970                     | 916                      |
| owner: live / visits / housekeep / need / settle / idle (% of wall)     | 68 / 5 / 9 / 14 / 0 / 4 | 62 / 4 / 9 / 8 / 15 / 2 | 16 / 8 / 5 / 7 / 0 / 64 | 19 / 7 / 6 / 7 / 22 / 39 |
| owner ms per observed frame (live + housekeep)                          | 5.6                     | 5.8                     | 7.0                     | 8.4                      |
| owner ms per visit job (hand-out + apply)                               | 1.26                    | 1.35                    | 1.15                    | 1.23                     |
| visit worker ms per job                                                 | 61                      | 70                      | 38                      | 43                       |
| batch inbox wait, mean                                                  | 36 ms                   | 68 ms                   | 0.7 ms                  | 17 ms                    |
| a visit's turnaround beyond its own time (4 x wall / jobs - ms per job) | 42 ms                   | 60 ms                   | -                       | -                        |

What the duties say against the round-2 model (`--units-per-ms 1.6e6 --job-ms 1`, pool 4) on the same runs:

- **The owner's costs are right.** At full speed the model's owner spends 5.5 ms per observed frame on live batches
  (Chrome 5.6-5.8 with housekeep) and 1 ms per job (Chrome 1.15-1.35). Housekeep runs after every batch and every visit
  result: 0.7 ms per observed frame at full speed, 1.5-2.0 at 30 fps, where there are 20 times as many results. At 30
  fps the model's owner is busy 39 % / 53 % (round 2, workshop off / on) against Chrome's 36 % / 61 %. The pre-fix
  readings in #459 that suggested 2.4 ms per job had housekeep inside the visit duty.
- **The visit workers' cost per job is right within 10-20 %**: model 66-68 ms at full speed against Chrome 61-70; at
  30 fps the model is 20 % (workshop) to 44 % (Samara) slower per job.
- **The visit results wait too long for the owner.** The model's visit workers spend most of their idle time with a
  result waiting behind batches (`--visit-diag`: 238 of 430 worker-seconds on the workshop recording, full, off). The
  model's batches wait 125 ms on average in the owner's inbox; Chrome's 36-68 ms. With four forward buffers and an
  owner that is full, the model keeps three batches queued; Chrome keeps about one.

Model variants on the workshop recording at full speed (settle off / on; Chrome 4,598 / 3,776 jobs, batch wait 36 / 68
ms, missed 33.1 / 37.7 %):

| variant (round-2 flags plus)                                            | jobs              | batch wait, ms | result wait, ms | missed        | need-driven    |
| ----------------------------------------------------------------------- | ----------------- | -------------- | --------------- | ------------- | -------------- |
| nothing (pool 4, as #456)                                               | 2,373 / 2,378     | 125 / 129      | 112 / 114       | 27.8 / 28.6 % | 8,195 / 4,176  |
| `--ack-lag-ms 36` (the fast loop sees a returned buffer one batch late) | 2,615 / 2,614     | 99 / 103       | 95 / 98         | 29.7 / 30.0 % | 9,139 / 4,512  |
| `--ack-lag-ms 72`                                                       | 2,907 / 2,830     | 74 / 83        | 78 / 85         | 32.1 / 33.9 % | 9,363 / 4,592  |
| `--pool 3`                                                              | 2,727 / 2,694     | 85 / 91        | 88 / 92         | 30.8 / 32.2 % | 9,459 / 4,672  |
| `--pool 2`                                                              | 3,359 / 3,267     | 44 / 50        | 60 / 65         | 35.2 / 37.7 % | 11,027 / 5,536 |
| `--result-first` (a waiting result goes before waiting batches)         | 5,198 / 5,096     | 145 / 151      | 26 / 28         | 35.2 / 35.9 % | 7,476 / 3,744  |
| `--result-first --ack-lag-ms 36`                                        | 5,303 / 5,050     | 113 / 123      | 26 / 27         | 34.7 / 36.9 % | 8,516 / 4,016  |
| **refit: `--pool 2 --visit-units-per-ms 2.3e6`**                        | **3,527 / 3,407** | 46 / 52        | 62 / 66         | 36.3 / 39.7 % | 10,980 / 5,328 |

- The app has four forward buffers (`PARALLEL_FORWARD_BUFFERS`), but its slow worker's inbox holds about one batch.
  One likely reason is that the fast loop (in the trace worker) decides on forwarding at the end of a batch, before it
  handles the `ack` messages that came in meanwhile, so a returned buffer is seen one batch late (`--ack-lag-ms`). That
  alone explains only part of it: one batch of lag (36 ms) still leaves 99-103 ms of batch wait.
- `--pool 2` reproduces the measured batch wait (44-50 against 36-68 ms), the missed share (within 2.6 points) and the
  look-back numbers, and raises the jobs to 73 % (off) and 87 % (on) of Chrome's.
- `--result-first` gives Chrome's job count on the "off" run (+13 %) but overshoots "on" (+35 %) and makes batches wait
  twice as long as Chrome's. Chrome's turnaround beyond the visit (42 / 60 ms) sits between first-in-first-out at the
  measured batch wait (60 / 65 ms) and result-first (26 / 28 ms).

## 3. The refit (frozen before any Samara model run with it)

**Flags:** round 2 of #456 with two changes: `--lb-gate --lb-ms 1.6 --lb-ms-per-cell 0.0082 --units-per-ms 1.6e6
--job-ms 1 --visit-units-per-ms 2.3e6 --visit-workers 4 --pool 2`, plus `--offered-fps F` at Chrome's achieved rate.
Binary `qc_eval-refit-c` (this branch).

- `--pool 2`: an effective forward depth, fitted to the measured batch wait on the workshop recording. It stands in
  for the app's four buffers plus the buffer-return lag the model lacks; it is not the app's setting.
- `--visit-units-per-ms 2.3e6` (was 2e6): the visit workers' time per job x 0.87, the workshop ratio of Chrome's to the
  model's ms per job (61 / 67 at full speed, 38.3 / 45.9 at 30 fps).
- Unchanged, with the reason: owner per observed frame and per job (match within 5-25 %, section 2); look-back worker
  and gate (C1's look-back rows passed in #456).

**C1 references (replacing those of `2026-11-21-work-slider-plan.md`):** Chrome runs of `main` `e8201322` (smooth
pacer, #459 accounting), one each: Samara `10_43_21` and `14_57_02`, 30 fps and full speed, settle off and on. The
`10_43_21` 30 fps pair was run first (it is section 1's evidence, and was compared with #456's round-2 model before this
refit was chosen: -11 % off, -10 % on); the other six are run after this commit. The full-speed model runs use each new
run's achieved rate.

**C1 rule (unchanged):** model within 15 % of Chrome on visit jobs in Discover, need-driven frames asked and background
settle per live frame (on arms), and within 3 points on the share of live frames the slow loop missed; every row and
measure on its own. Reported before and after: #456's round-2 model against the old references, round 2 against the
new references, the refit against the new references.

**Workshop fit-set status at this commit:** full speed off / on as in the table above (jobs -23 % / -10 %, missed
+3.2 / +2.0 points, need-driven +7 % / +10 %, settle 0.333 / 0.33 per forwarded frame). The off run fails on jobs and
by 0.2 points on misses on the fit set itself, so **C1 at full speed is expected to fail on visit jobs** unless Samara
differs; section 2 names the mechanism. The 30 fps workshop runs of the refit are running at this commit.
