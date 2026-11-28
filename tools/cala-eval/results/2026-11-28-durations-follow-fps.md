# Durations follow the recording's frame rate

28 Nov 2026. Branch `feat/cala-durations-fps` (on main `e7484b5f`). Design: params-audit `DESIGN.md` §4.3 and §8
row 10. Raw data, scripts and logs: `~/Projects/cala-data/runs/params-audit/pr10/`.

## Question

`time.legacy_frame_fps` (20) converted every duration of the slow loop, look-back, settle, motion and warm-up to
frames at 20 fps whatever the recording's rate, and the engine's per-frame tracker rates were tuned at 20 fps. On a
30 fps recording main therefore ran every one of those durations 1/3 short in seconds. The branch converts every
duration at the recording's frame rate and turns the per-frame rates into time constants. Is the branch no worse
than main at 30 fps, and identical at 20 fps?

## Decision rule (written before scoring)

- **Identity (20 fps).** `qc_eval` with the app's shipped settings on `v3_static_s5` and `v3_motion_s5` (4800
  frames, the gate arm of PR 2) gives byte-identical output files on main and the branch, apart from the wall-time
  fields. Any other difference fails the PR.
- **Paired (30 fps).** Sims `v3fps30_static` and `v3fps30_motion`, seeds 5–9 (10 recordings, 480 s = 14400
  frames each), `qc_eval` with the app arm on main and on the branch, both with `--fps 30`. Per recording: final
  GT recall, GT precision and cell count, plus wall time. Paired differences branch − main, mean and 95 % t CI
  over the 10 recordings (t = 2.262), and per arm (n = 5, t = 2.776).
  - **Pass:** the lower CI bound of the mean recall difference and of the mean precision difference are both
    ≥ −0.01 (no worse than one point), and neither arm's mean recall or precision difference is below −0.01.
  - **Better:** a lower CI bound above 0 for recall or precision.
  - Cell count and wall time are reported, not gated; a wall time more than 25 % longer is flagged.
  - If the branch fails, the PR is not opened as ready and the note says which part of the change did it.

## Results

### Identity at 20 fps: pass

`qc_eval` (app arm, 4800 frames, `--slow-seed 1`) on `v3_static_s5` and `v3_motion_s5`, main `e7484b5f` against the
branch: 14 and 19 output files compared, **none differ** (wall-time fields removed, `pr10/scripts/compare.sh`). The
fps-20 golden engine view differs from main only by the removed `legacy_frame_fps` and the added per-frame rates,
each bit-equal to the constant it replaced (`rates_at_20_fps_are_the_engines_constants`).

### Paired at 30 fps: fails the precision clause

New sims `v3fps30_static` / `v3fps30_motion`, seeds 5–9 (the v3 spec with `fps` 30, 480 s, 14400 frames; minisim's
burst gate steps per frame, so its bouts are 2/3 as long in seconds as at 20 fps). App arm, `--fps 30`, both
binaries, the whole recording. Branch − main:

|                | recall                         | precision                      | cells               | wall s         |
| -------------- | ------------------------------ | ------------------------------ | ------------------- | -------------- |
| all (n = 10)   | **+0.0120** [+0.0091, +0.0148] | −0.0052 [−0.0136, +0.0032]     | +14.4 [+7.0, +21.8] | −9 [−36, +18]  |
| static (n = 5) | **+0.0130** [+0.0082, +0.0179] | +0.0039 [−0.0016, +0.0094]     | +7.2 [+2.8, +11.6]  | +2 [−2, +5]    |
| motion (n = 5) | **+0.0109** [+0.0057, +0.0162] | **−0.0144** [−0.0257, −0.0031] | +21.6 [+9.5, +33.7] | −20 [−86, +46] |

Per recording (main → branch): recall rises on all 10 (+0.006 to +0.018); precision rises on 4 of 5 static
recordings and falls on 4 of 5 motion recordings (−0.012 to −0.019). Raw table: `pr10/score.txt`.

Against the rule: recall is **better** (lower bound > 0, both arms). Precision fails the clause as written: the overall
lower bound −0.0136 and the motion arm's mean −0.0144 are below −0.01. Static alone would pass and be better.

**Where the motion precision goes.** The extra false positives are established cells (≥ 3 transients after birth),
not cells still on probation: unmatched established cells per motion recording rise by 1, 22, 14, 10 and 18; unmatched
probation cells do not rise. So the longer probation in frames (240 s = 7200 frames, main 4800) is not the cause.
ABLATION

## What the PR does about it

Per the rule the PR is opened as a draft. The 20 fps identity holds, so nothing changes for 20 fps recordings; at
30 fps the change gives every duration its tuned length in seconds, gains recall on both arms and costs precision on
motion recordings. Whether that trade is accepted, or the motion part is held back, is the PI's call.
