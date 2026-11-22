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

## 4. Results (after the pre-registration commit `19adc4d3`)

### Fit set, workshop, the refit at 30 fps

| workshop, 30 fps (29.7) | Chrome: jobs / need-driven / settle per forwarded frame | refit                                             |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| off                     | 54,251 / 47,079 / -                                     | 52,735 (-3 %) / 47,063 / -                        |
| on                      | 44,894 / 38,297 / 1.62                                  | 46,287 (+3 %) / 33,821 (-12 %) / **0.99 (-39 %)** |

Visit jobs fit at 30 fps; cells at the end agree too (model 985 / 975, Chrome 970 / 916). The background-settle dose on
the workshop recording at 30 fps is 39 % low in the model: the look-back supply, not a visit quantity, and not part of
C1 (on Samara the dose sits at the cap of 2).

### C1 on Samara (held out)

Chrome references: `main` `e8201322` app code (the full-speed and `14_57_02` runs were made from this branch, whose app
code is identical), smooth pacer, one run each; achieved 29.6 fps paced and 339-348 fps unpaced. "r2" = #456's round-2
flags (pool 4, `--visit-units-per-ms 2e6`); at 30 fps these are #456's own runs (offered 30.0 fps), at full speed
re-run at the new runs' rates (`r2new_*`). "refit" = section 3. Cells: model / Chrome within 15 % in every row
(not a C1 measure).

| row                   | measure          | old Chrome ref | r2 vs old      | new Chrome ref   | r2 vs new      | refit vs new   |
| --------------------- | ---------------- | -------------- | -------------- | ---------------- | -------------- | -------------- |
| `10_43_21`, 30, off   | missed           | 0 %            | 0 pass         | 0 %              | 0 pass         | 0 pass         |
|                       | visit jobs       | 54,849         | +30 % **fail** | 79,984           | -11 % pass     | -4 % pass      |
|                       | need-driven      | 35,415         | pass           | 35,415           | pass           | pass           |
| `10_43_21`, 30, on    | missed           | 0 %            | 0 pass         | 0 %              | 0 pass         | 0 pass         |
|                       | visit jobs       | 51,257         | +26 % **fail** | 71,697           | -10 % pass     | -5 % pass      |
|                       | need-driven      | 35,415         | pass           | 35,415           | pass           | pass           |
|                       | settle per frame | 1.99           | pass           | 1.99             | 2.00 pass      | 2.00 pass      |
| `14_57_02`, 30, off   | missed           | 0 %            | 0 pass         | 0 %              | 0 pass         | 0 pass         |
|                       | visit jobs       | 51,340         | +45 % **fail** | 79,773           | -7 % pass      | -0.0 % pass    |
|                       | need-driven      | 35,407         | pass           | 35,407           | pass           | pass           |
| `14_57_02`, 30, on    | missed           | 0 %            | 0 pass         | 0 %              | 0 pass         | 0 pass         |
|                       | visit jobs       | 49,810         | +36 % **fail** | 73,016           | -8 % pass      | -1 % pass      |
|                       | need-driven      | 35,407         | pass           | 35,407           | pass           | pass           |
|                       | settle per frame | 1.99           | pass           | 1.99             | 2.00 pass      | 2.00 pass      |
| `10_43_21`, full, off | missed           | 19.5 %         | +3.2 **fail**  | 21.0 % (343 fps) | +2.2 pass      | +9.6 **fail**  |
|                       | visit jobs       | 3,669          | -58 % **fail** | 3,788            | -60 % **fail** | -27 % **fail** |
|                       | need-driven      | 6,656          | -15 % pass     | 6,800            | -18 % **fail** | +26 % **fail** |
| `10_43_21`, full, on  | missed           | 22.2 %         | +1.7 pass      | 22.2 % (339)     | +0.6 pass      | +10.0 **fail** |
|                       | visit jobs       | 3,459          | -56 % **fail** | 3,521            | -56 % **fail** | -26 % **fail** |
|                       | need-driven      | 2,920          | pass           | 3,008            | -6 % pass      | +42 % **fail** |
|                       | settle per frame | 0.215          | -12 % pass     | 0.216            | -13 % pass     | +49 % **fail** |
| `14_57_02`, full, off | missed           | 14.9 %         | +7.6 **fail**  | 16.7 % (348)     | +6.9 **fail**  | +13.6 **fail** |
|                       | visit jobs       | 3,903          | -59 % **fail** | 4,119            | -62 % **fail** | -31 % **fail** |
|                       | need-driven      | 6,464          | -11 % pass     | 6,656            | -15 % pass     | +32 % **fail** |
| `14_57_02`, full, on  | missed           | 15.9 %         | +6.8 **fail**  | 16.1 % (346)     | +7.8 **fail**  | +16.1 **fail** |
|                       | visit jobs       | 3,699          | -57 % **fail** | 3,624            | -57 % **fail** | -23 % **fail** |
|                       | need-driven      | 2,832          | pass           | 2,928            | -3 % pass      | +49 % **fail** |
|                       | settle per frame | 0.19           | pass           | 0.196            | -3 % pass      | +64 % **fail** |

**Verdict: C1 passes at 30 fps (all four rows, every measure, both r2 and the refit) and fails at full speed (both).**
By the plan's rule ("passes at 30 fps only"), qc_eval may be used for slider arms up to 60 fps; faster targets are
Chrome-only. The refit's two changes do not carry from the workshop recording to Samara at full speed: `--pool 2`
roughly halves the visit-job error (-56 to -62 % becomes -23 to -31 %) but makes the slow loop miss 10-16 points more
frames than Chrome and inflates the look-back rows by 26-64 %. At 30 fps no frame is dropped and the pool does not
matter; there the refit's gain over r2 (-11..-7 % to -5..0 %) is `--visit-units-per-ms 2.3e6`.

**Recommendation for slider arms in qc_eval (30-60 fps):** the refit flags, or r2's; both pass. For anything faster:
Chrome.

## 5. What the model is missing at full speed

Measured on Samara at full speed (Chrome, settle off, `10_43_21` / `14_57_02`):

| quantity                                       | Chrome        | refit (pool 2)           | r2 (pool 4)   |
| ---------------------------------------------- | ------------- | ------------------------ | ------------- |
| owner ms per observed frame (live + housekeep) | 3.25 / 3.02   | 3.68 / 3.60              | same scale    |
| owner ms per visit job (hand-out + apply)      | 1.12 / 1.05   | 1.0                      | 1.0           |
| visit worker ms per job                        | 37.6 / 31.5   | 32.4 / 29.6              | -             |
| batch inbox wait, mean                         | 28 / 29 ms    | 26 / 26 ms               | not measured  |
| a visit's turnaround beyond its own time       | 28 / 27 ms    | 42 / 42 ms (result wait) | -             |
| frames missed                                  | 21.0 / 16.7 % | 30.6 / 30.3 %            | 23.2 / 23.6 % |

(Turnaround beyond the visit = 4 x Discover wall / jobs - visit ms per job; it includes the owner's apply and message
transit.)

1. **The app's slow-worker inbox is shallow, and it still loses few frames.** Chrome's batches wait about one batch
   (28-38 ms on Samara, 36-68 ms on the workshop recording) although the app has four forward buffers. A four-buffer
   first-in-first-out model keeps three batches queued (batch wait 125 ms on the workshop recording); a two-buffer
   model matches the wait but drops 10-14 points more frames than Chrome. So the app's buffers are not "busy until the
   owner is done with them" as the model has it, nor simply fewer. One code-level reason was modelled
   (`--ack-lag-ms`: the trace worker sees a returned buffer only after the batch it is processing); one batch of lag
   explains a small part (workshop, off: batch wait 125 to 99 ms, jobs +10 %).
2. **Visit results reach the owner sooner than first-in-first-out allows.** In Chrome a visit's turnaround beyond its
   own time is 27-28 ms on Samara and 42 / 60 ms on the workshop recording; with the same batch wait the model's
   results wait 41-44 ms and 60-65 ms. A model that takes waiting results before waiting batches (`--result-first`)
   gives 26-28 ms on the workshop recording and overshoots the jobs (+13 % / +35 % on the workshop recording) and the batch wait (2-4x). The
   browser's order between the visit workers' ports and the frames port is neither.
3. **The owner's live cost on Samara is 13 % high in the model** (3.68 against 3.25 ms per frame). The round-2 scale
   came from the workshop recording, where it fits (5.5 against 5.6).

What would settle 1 and 2 in the app (small, measurement only): stamp each visit result with its send time, as the
frames message already is (`sentAt`), and report the result inbox wait next to the batch wait; and report the forward
pool's buffers in flight (`ForwardPool.inFlight`) and the age of returned buffers when the fast loop next forwards.
With those two numbers the model's queue can be fitted instead of stood in for by an effective depth.

## 6. Checks

- **T0 (flags off = `main`): pass.** `work_slider.sh t0` with `qc_eval-refit-c` against `qc_eval-main-e8201322`
  (static_s5, first 4800 frames; lock-step with a final settle, `V30`, `CS2`, `CS2F`, round 1's single-worker settle):
  every output file identical after masking wall-time fields (`.../work-slider-refit/t0/report.txt`).
- The C1 Chrome runs ran one at a time with no qc_eval run of mine going (load average 2.1-3.8 at the starts,
  `chrome/load.txt`); another agent's short Chrome runs on port 5197 were waited for.
- Recordings read only: `--single` runs make no export and the app's directory picker is removed.

Files: Chrome runs `~/Projects/cala-data/runs/work-slider-refit/chrome` (`visit_refit_chrome.sh`,
`visit_refit_chrome_summary.py`); model runs `.../work-slider-refit/real` (`work_slider.sh arm` with `ROOT`, `POOL`,
`BIN`, `CAL`; `visit_refit_model_summary.py`); binaries `.../work-slider-refit/bin` (`qc_eval-refit-c` = this branch,
`qc_eval-main-e8201322`).
