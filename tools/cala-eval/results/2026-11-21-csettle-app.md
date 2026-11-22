# Settle during Discover in the app (frames only, default off): headed Chrome

> **All toggle-on numbers below the title are from before the preprocessor fix and are affected by the bug** (settle
> chunks freed the need-driven block's preprocessor, so need-driven re-reads restarted from the live state). Toggle-off
> numbers are unaffected. The re-measurement is in the last section, "After the preprocessor fix".

21 Nov 2026. Branch `feat/cala-csettle-app`. The app prototype of qc_eval's arm `CS2F`
(`2026-11-20-concurrent-settle2.md`, `2026-11-21-concurrent-settle3.md`), measured in headed Chrome (Metal GPU, 18
cores) on the workshop recording and Samara `10_43_21` and `14_57_02`. Look-back is on in every run; "off" and "on" are
the new toggle.

## Summary

1. **A recording read at full speed gets about a tenth of the dose.** The ceiling is 2 re-read frames per live frame;
   the app delivered 0.19-0.34. Discover reads 210-340 frames a second and the one look-back worker re-reads about
   90-125 a second while Discover runs, so it is the limit. It was already full with need-driven look-back.
   **The two now take turns, so at full speed need-driven look-back gets half as many frames. That is a change from
   the approved design ("need-driven first"), which would have left the settle nothing here. On against off at full
   speed is therefore the toggle plus half the need-driven look-back, not the toggle alone.**
2. **At that dose the toggle changes little.** Time is the same and Discover fps within about 4 %. Peak tab memory
   reads 0.3-0.5 GB lower with the toggle on in most pairs; the cause was not looked into. The end settle moves the library
   slightly less on the workshop recording (median footprint change 27 % against 31 %) and the same on both Samara
   recordings. Cell counts are within the spread of two runs.
3. **At a stream's rate the full dose arrives and the end settle moves about half as many cells.** One Samara
   recording read at 30 fps (a measurement-only pace knob), one run per arm: 2.00 re-read frames per live frame, 8 of
   17,831 frames dropped for the slow loop (off: 0), cells moved more than twice their noise by the end settle 25 %
   against 49 %, median change 12.6 % against 20.2 %. This is the condition qc_eval modelled. It is one recording and one run per arm.
4. **The fast loop was never held up.** Discover fps with the toggle on is within about 4 % of off in every pair
   (workshop 210 and 217 against 218 and 220; Samara equal). The cost
   falls on the slow loop: 1-5 points more frames dropped for it at full speed, and 5-18 % fewer visit jobs.
5. **Whole answers stay the default.** At full speed, feeding an answer one frame at a time (`csettle=yield`) did
   not lower the dropped frames on the workshop recording and re-read fewer frames (0.13 per live frame). It was not
   tried at 30 fps, where the model says it matters; there whole answers cost 8 frames in 17,831.

## What was built

- `SlowLoop.enableSettle / settleTake / observeSettle / settleSkipped / settleStats` (WASM): the engine's
  `SettleSched` picks 16 frames in a row, the chunks spread over the frames seen so far; a fitting frame goes to
  `observe_settle` without the reservoir; a held-out frame is refused there.
- `slow-runner.ts`: every live frame the slow loop observes earns `rate` re-read frames (`SettleDose`, at most 64
  owed). One request to the look-back worker is out at a time. Held-out frames are preprocessed but not solved.
  There are no settle visits and no quiet rule. The end settle is unchanged.
- **One difference from the model:** need-driven look-back and the settle take turns when both have frames to ask
  for. In the model need-driven requests went first and the look-back worker had time for both. At full speed in the
  app "first" would leave the settle nothing.
- UI: "Settle during Discover (experimental)" under the look-back toggle, with a ceiling of 2, 1 or 0.5; URL
  `?lookback&csettle`, `csrate=1`, `csettle=yield` (pieces of one frame; `yield4` for four).

## Method

`apps/cala/scripts/memory-measure.mjs --single --lookback [--csettle] --headed --every 5` against a dev server, runs
interleaved (off, on per recording, then the reverse order), two runs per arm. An in-page probe every 100 ms gives
the times, the counters at the last frame and every settle checkpoint. The script saves the library at the last
frame of Discover and the settled one. Tables: `tools/cala-eval/csettle_app_summary.py`. Logs and libraries:
`~/Projects/cala-data/runs/csettle-app/browser`. Load average 2.5-7 with one qc_eval process of another agent
running throughout.

## Recordings at full speed (two runs per arm)

| recording (frames) | toggle | Discover s (fps)     | end settle s | total s   | cells at the end | peak tab GB | frames dropped for the slow loop | visit jobs in Discover |
| ------------------ | ------ | -------------------- | ------------ | --------- | ---------------- | ----------- | -------------------------------- | ---------------------- |
| workshop (23,711)  | off    | 109 / 108 (218, 220) | 188 / 188    | 297 / 296 | 754 / 754        | 3.7 / 3.7   | 33.6 % / 33.1 %                  | 4,604 / 4,652          |
|                    | on     | 113 / 109 (210, 217) | 194 / 190    | 307 / 300 | 776 / 749        | 3.3 / 3.2   | 37.9 % / 38.4 %                  | 3,858 / 3,767          |
| 10_43_21 (17,879)  | off    | 53 / 53 (338, 338)   | 90 / 90      | 143 / 143 | 310 / 320        | 3.1 / 3.0   | 19.1 % / 19.9 %                  | 3,574 / 3,763          |
|                    | on     | 53 / 53 (335, 338)   | 92 / 90      | 146 / 143 | 327 / 324        | 2.8 / 3.1   | 22.4 % / 22.0 %                  | 3,320 / 3,598          |
| 14_57_02 (17,875)  | off    | 52 / 51 (342, 348)   | 88 / 88      | 140 / 139 | 274 / 277        | 3.1 / 3.0   | 14.9 % / 14.9 %                  | 3,872 / 3,933          |
|                    | on     | 53 / 52 (340, 346)   | 88 / 88      | 141 / 139 | 266 / 266        | 2.7 / 2.7   | 15.7 % / 16.1 %                  | 3,606 / 3,792          |

- Peak tab memory is the larger of the renderer's footprint and RSS over 5 s samples; the GPU process stayed at
  0.86-0.92 GB. The peaks with the toggle on are 0.3-0.5 GB lower on the workshop recording, on 14_57_02 and in the paced pair,
  and mixed on 10_43_21. The cause was not investigated (the look-back worker and the samples' timing are candidates).
- The longest stretch without a new frame is 1.6-1.8 s in every run, on and off: the start of the run, before the
  first batch. After it no run has a stretch over 250 ms.
- Two runs of one arm differ by up to 27 cells (workshop, on), so these pairs cannot resolve a difference in cells.

### The look-back worker during Discover

| recording | toggle | need-driven frames asked | settle frames re-read (fitted + held out + dropped) | per live frame | slow worker per 16-frame answer, mean (longest) |
| --------- | ------ | ------------------------ | --------------------------------------------------- | -------------- | ----------------------------------------------- |
| workshop  | off    | 10,272 / 10,368          | -                                                   | -              | -                                               |
|           | on     | 4,912 / 4,704            | 4,944 (3,244 + 1,652 + 48) / 4,736                  | 0.34 / 0.32    | 54 ms (126) / 52 ms (131)                       |
| 10_43_21  | off    | 6,544 / 6,768            | -                                                   | -              | -                                               |
|           | on     | 2,848 / 2,992            | 2,864 (1,877 + 955 + 32) / 3,008                    | 0.21 / 0.22    | 19 ms (38) / 19 ms (40)                         |
| 14_57_02  | off    | 6,432 / 6,496            | -                                                   | -              | -                                               |
|           | on     | 2,800 / 2,864            | 2,832 (1,848 + 936 + 48) / 2,896                    | 0.19 / 0.19    | 16 ms (31) / 16 ms (33)                         |

The 54 ms per answer on the workshop recording is close to the model's 61 ms. "Dropped" frames are answers solved
before the first library was published or with a library version the slow loop no longer held; the count does not
separate the two.

### What the end settle still moves

The library at Discover's last frame against the settled one, per cell against its split-half noise in the settled
library (`settleChange`, the measure of the settle's own checkpoints applied to the whole settle).

| recording | toggle | cells moved more than 2x their noise | more than 1x | median footprint change | median change / noise |
| --------- | ------ | ------------------------------------ | ------------ | ----------------------- | --------------------- |
| workshop  | off    | 77 % / 76 %                          | 97 % / 96 %  | 31.6 % / 31.4 %         | 2.94 / 2.87           |
|           | on     | 72 % / 73 %                          | 96 % / 97 %  | 27.5 % / 27.3 %         | 2.61 / 2.72           |
| 10_43_21  | off    | 44 % / 42 %                          | 81 % / 83 %  | 19.5 % / 19.0 %         | 1.82 / 1.80           |
|           | on     | 45 % / 42 %                          | 80 % / 80 %  | 20.2 % / 20.0 %         | 1.89 / 1.75           |
| 14_57_02  | off    | 48 % / 45 %                          | 84 % / 83 %  | 23.1 % / 21.4 %         | 1.94 / 1.79           |
|           | on     | 44 % / 42 %                          | 84 % / 80 %  | 19.6 % / 20.2 %         | 1.76 / 1.74           |

The "cells still moving" count at the settle's checkpoints falls the same way in both arms (workshop: 280-340 of
about 750 at 1,200 frames, 35-55 at 4,800, 3-11 at 16,800; Samara: 42-65 at 1,200, mostly under 10 from 6,000 on).

### Run-to-run agreement of the libraries

The app has no slow-loop seed, so this is two runs of the same arm (they differ by timing). Median cosine of matched
footprints (matched greedily, centroids within 12 px, cosine at least 0.7).

| recording | pair       | at Discover's last frame | settled |
| --------- | ---------- | ------------------------ | ------- |
| workshop  | off vs off | 0.952                    | 0.981   |
|           | on vs on   | 0.960                    | 0.981   |
| 10_43_21  | off vs off | 0.984                    | 0.991   |
|           | on vs on   | 0.980                    | 0.992   |
| 14_57_02  | off vs off | 0.973                    | 0.992   |
|           | on vs on   | 0.979                    | 0.991   |

One pair per cell of the table: the differences (+0.008, -0.004, +0.006) are not resolved. The settled libraries
agree equally with the toggle on and off.

## Whole against piecewise answers (workshop, one run)

| arm                     | Discover fps | dropped for the slow loop | settle frames per live frame | need-driven frames asked | visit jobs   | moved more than 2x noise by the end settle |
| ----------------------- | ------------ | ------------------------- | ---------------------------- | ------------------------ | ------------ | ------------------------------------------ |
| off                     | 218, 220     | 33.6 %, 33.1 %            | -                            | 10,272, 10,368           | 4,604, 4,652 | 77 %, 76 %                                 |
| on, whole answers       | 210, 217     | 37.9 %, 38.4 %            | 0.34, 0.32                   | 4,912, 4,704             | 3,858, 3,767 | 72 %, 73 %                                 |
| on, one frame at a time | 229          | 39.2 %                    | 0.13                         | 7,072                    | 3,723        | 73 %                                       |

Piecewise shortens the longest block (43 ms against about 130) but the dropped frames do not fall, and each answer
takes longer from first to last frame, so fewer are asked for. At full speed the slow worker is busy with live
batches whatever the answers do. This was measured at full speed only. Whole answers
stay the default; `csettle=yield` remains for experiments, and a paced run with it is the open test.

## At a stream's rate: Samara 10_43_21 at 30 fps (one run per arm)

`--pacefps 30` (`?debug&pacefps=30`) holds the reader to 30 frames a second. Nothing else differs from a recording
run.

| measure                                             | off             | on                             |
| --------------------------------------------------- | --------------- | ------------------------------ |
| Discover (17,879 frames)                            | 596 s (30 fps)  | 595 s (30 fps)                 |
| end settle                                          | 104 s           | 103 s                          |
| cells at the end                                    | 389             | 379                            |
| peak tab memory                                     | 3.2 GB          | 2.9 GB                         |
| frames dropped for the slow loop                    | 0 of 17,831     | 8 of 17,831                    |
| need-driven frames asked                            | 35,415          | 35,353                         |
| settle frames re-read (fitted + held out + dropped) | -               | 35,600 (23,561 + 11,847 + 192) |
| re-read frames per live frame                       | -               | 2.00                           |
| slow worker per 16-frame answer, mean (longest)     | -               | 25 ms (63 ms)                  |
| visit jobs / refinements in Discover                | 54,849 / 11,819 | 51,377 / 15,332                |
| end settle: cells moved more than 2x their noise    | 49 %            | 25 %                           |
| end settle: more than 1x                            | 84 %            | 65 %                           |
| end settle: median footprint change                 | 20.2 %          | 12.6 %                         |
| end settle: median change / noise                   | 1.99            | 1.30                           |

- The look-back worker kept up with both kinds of request (about 120 frames a second in all).
- 6 % fewer visit jobs and 30 % more refinements, the direction round 3 found in the model.
- The end settle takes as long as without the toggle: it has a fixed budget and no early stop.
- Agreement of the two libraries with each other: 0.974 at the last frame, 0.989 settled. There is no second paced
  run per arm, so no run-to-run agreement at this rate.

## Limits

- Two runs per arm at full speed, one per arm at 30 fps and for piecewise answers. No seeds in the app; run-to-run
  spread stands in.
- The paced run reads a file at 30 fps; a live stream cannot use the toggle yet (no disk buffer of raw frames).
- One machine (18 cores, 4 visit workers). Fewer cores leave the look-back worker less time.
- The Samara and workshop recordings have no ground truth; "moves less" is not "more correct".
- Taking turns halves need-driven look-back at full speed (see the summary). Its own effect, for example on
  late-born cells, was not separated from the settle's. At 30 fps both got all they asked for.
- `?debug&pacefps=N` is measurement-only code in the product (the reader waits); the brief did not ask for it.
- Peak memory comes from 5 s samples.
- Exports and analytics do not record that the toggle was on.

## What I would do next

1. For recordings: decide whether the toggle is worth keeping there. To deliver the dose at full speed the look-back
   side needs about ten times the throughput (several look-back workers), or Discover has to slow down.
2. For streams: the 30 fps result is the case for building the raw-frame disk buffer. Repeat the paced run (second
   Samara session, workshop, two runs per arm) before relying on the halving.
3. Let the end settle stop early when a checkpoint moves less than the null; today a settled-during-Discover library
   still pays the full pass.

## After the preprocessor fix (commit 64868789)

The fix: settle chunks (block seq <= -1,000,000) get their own preprocessor slot in the look-back reader, so need-driven
blocks continue across settle chunks as in qc_eval (`cs_pre`). Also: a settle request that times out or errors turns
off only the settle (not need-driven look-back or the end settle); no settle reads go out before the first library;
settle frames whose answer is discarded (end of Discover, timeout, error, answer when look-back is not live) all count
as dropped, so re-read = fitted + held out + dropped exactly. Toggle off is unchanged. Same method, headed Chrome, new
logs in `~/Projects/cala-data/runs/csettle-app/browser-fix` (old ones untouched). Toggle-off rows are the old runs.

### Workshop at full speed, toggle on (two runs)

| measure | off (old) | on, before fix | on, after fix |
| --- | --- | --- | --- |
| Discover s (fps) | 109 / 108 (218, 220) | 113 / 109 (210, 217) | 109 / 110 (217, 216) |
| end settle s | 188 / 188 | 194 / 190 | 186 / 192 |
| cells at the end | 754 / 754 | 776 / 749 | 752 / 756 |
| peak tab GB | 3.7 / 3.7 | 3.3 / 3.2 | 3.45 / 3.37 |
| frames dropped for the slow loop | 33.6 / 33.1 % | 37.9 / 38.4 % | 38.8 / 37.5 % |
| settle re-read per live frame | - | 0.34 / 0.32 | 0.34 / 0.33 |
| need-driven frames asked | 10,272 / 10,368 | 4,912 / 4,704 | 4,880 / 4,944 |
| end settle: moved > 2x noise | 77 / 76 % | 72 / 73 % | 72 / 72 % |
| end settle: median change | 31.6 / 31.4 % | 27.5 / 27.3 % | 26.5 / 27.6 % |

Full speed is unchanged by the fix: the look-back worker is the limit, so the picture is the same.

### Samara at 30 fps pace

| measure | 10_43_21 off (old, 1 run) | 10_43_21 on, before fix (1 run) | 10_43_21 on, after fix (2 runs) | 14_57_02 off (1 run) | 14_57_02 on (1 run) |
| --- | --- | --- | --- | --- | --- |
| Discover s (fps) | 596 (30) | 595 (30) | 596 / 596 (30) | 596 (30) | 596 (30) |
| end settle s | 104 | 103 | 104 / 106 | 100 | 101 |
| cells at the end | 389 | 379 | 392 / 397 | 319 | 327 |
| peak tab GB | 3.2 | 2.9 | 2.86 / 3.01 | 2.63 | 2.97 |
| frames dropped for the slow loop | 0 of 17,831 | 8 of 17,831 | 0 / 0 of 17,831 | 0 of 17,827 | 0 of 17,827 |
| settle re-read per live frame | - | 2.00 | 1.99 / 1.99 | - | 1.99 |
| need-driven frames asked | 35,415 | 35,353 | 35,415 / 35,415 | 35,407 | 35,407 |
| end settle: moved > 2x noise | 49 % | 25 % | 33 % / 30 % | 53 % | 30 % |
| end settle: moved > 1x noise | 84 % | 65 % | 69 % / 68 % | 87 % | 70 % |
| end settle: median change | 20.2 % | 12.6 % | 14.1 / 14.0 % | 23.9 % | 14.8 % |
| median change / noise | 1.99 | 1.30 | 1.53 / 1.42 | 2.10 | 1.45 |
| visit jobs / refines | 54,849 / 11,819 | 51,377 / 15,332 | 51,321 / 14,961; 51,193 / 14,765 | 51,340 / 10,218 | 49,810 / 12,652 |
| slow worker per answer, mean (longest) ms | - | 25 (63) | 27 (59) / 27 (60) | - | 21 (47) |

Libraries of the two 10_43_21 runs agree at 0.989 (last frame) and 0.991 (settled); 14_57_02 on vs off 0.969 and 0.987.

What changed against the first round: the end settle still moves fewer cells, but not as few. Cells moved by more than
twice their noise: 30-33 % on against 49-53 % off (about 0.6x, not 0.5x); median change 14 % against 20-24 % (about 0.65x).
The dropped frames fall from 8 to 0, because the 8 were reads before the first library (now gated). The fast loop is
unaffected (30 fps held in every run). Both Samara recordings agree; the spread of two 10_43_21 runs is 3 points.
Peak memory is within 0.4 GB either way, in both directions (2.86-3.01 on, 2.63-3.2 off); no claim.
