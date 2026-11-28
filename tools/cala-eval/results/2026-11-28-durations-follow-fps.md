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

Pending.
