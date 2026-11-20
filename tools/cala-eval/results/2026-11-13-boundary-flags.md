# Session-boundary flags: calibration

13 Nov 2026. Branch `feat/cala-boundary-flags`. The flags of `apps/cala/src/lib/boundary-flags.ts`
(docs/stages.md, "Boundary flags") run on qc_eval output with
`tools/cala-eval/boundary_flags_eval.ts`, which feeds the app's `BoundaryMonitor` what qc_eval logged.
Scratch (not in the repo): `/private/tmp/claude-503/-Users-daharoni-Projects-CaLab/afa6e515-3c3e-4cc7-af38-91dc1bbfaf4b/scratchpad/flags/`
(`runs/`, `queue.sh`, `evalall.sh`, `smoke/`).

Runs: `qc_eval sim <sim> --batch 8 --slow-seed 1 --motion --budget 3e7 --churn-log --boundary-log --no-heldout --sessions 4800 --session-fix all`
(diagnostics build of this branch); real: Samara 14_30_33 → 14_44_22 concatenated (read only, via symlinks),
`--fps 30 --sessions 17874`. Window 30 s (600 frames at 20 fps, 900 at 30 fps).

## Verdict

| case                                                | match NCC (null median ± robust SD; chance) | z (log decorr.) | new cells (null /30 s) | silent share (null) | floor / noise drift (z) | flag        |
| --------------------------------------------------- | ------------------------------------------- | --------------- | ---------------------- | ------------------- | ----------------------- | ----------- |
| control sim (`motion_s5_ctl`)                       | .903 (.954 ± .014; .16)                     | 2.35            | 12 (29.2)              | 6 % (12 %)          | 0.8 / 1.6               | **ok**      |
| ×1.25 sim after the fix (`motion_s5_gain1.25`)      | .903 (.954 ± .014)                          | 2.35            | 11 (29.2)              | 3 % (12 %)          | 1.6 / 1.6               | **ok**      |
| 1° rotation after the fix (`motion_s5_rot1`)        | .898 (.954 ± .014)                          | 2.50            | 12 (29.2)              | 7 % (12 %)          | **5.3** / 0.0           | **warning** |
| Samara real Joint boundary                          | .974 (.991 ± .005; .26)                     | 1.65            | 5 (13.5)               | 12 % (8 %)          | 5.2 / 0.7               | **ok**      |
| different field of view (`motion_s5_otherfov`, new) | **.153** (.954; chance .147)                | 9.2             | **116** (29.2), z 4.1  | **44 %** (12 %)     | **103** / 2.7           | **failed**  |

- **Control and real data are ok.** The real boundary's floor drift is outside the within-session null (z 5.2) but
  smaller than the step the floor rescale applied (+0.11 vs −0.15 σ), so it is the floor settling, not a missed
  change.
- **rot1 after the fix: warning** (allowed: at most a warning). The background floor moves 0.06 σ over the 30 s
  after the boundary against a 0.01 σ step: the floor map is not rotated with the session, so it relearns. Alignment
  and outcome are ok.
- **A different field of view fails** on alignment: the match equals the chance level (the moving image mirrored),
  and the fit sits at the rotation grid's edge (−3°). The outcome checks agree (116 adds against 29 per window;
  44 % of the active cells silent against 12 %), and the floor fit read a nonsense gain (×0.009).
- `motion_s5_rot6` (6° rotation, beyond the ±3° grid) was made but its run was not finished within the budget.

## What was tuned on this data

Two rules changed after the first look at the control; both are in the docs:

1. **The match is compared on the log decorrelation `−ln(1 − ncc)`**, not on NCC. The within-session NCCs have a
   long low tail (motion blur inside the 8-frame batch: 5th percentile .91, minimum .90 against a median .954), so a
   robust z on NCC put the unperturbed control at 3.6 (a warning). On the log scale the tail is about symmetric: the
   control is at 2.35, a different field of view at 9.2.
2. **A drift warns only when it is also larger than the rescale's own step.** After any boundary the floor relaxes
   a little (τ = 120 s), while within a session it sits still, so the within-session null alone flagged the real
   boundary (floor z 5.2) and the control's noise came close.

Fixed choices (`BOUNDARY_FLAG_RULES`): window 30 s; "outside" = 3.5 robust SD (Iglewicz & Hoaglin modified z;
Anscombe scale for counts, quasi-binomial for the silent share); "failed" = the majority rule (under half the match's
margin over chance, a floor fit following under half the pixels, an excess over half the library or the active
cells); at least 3 null samples.

## Caveats

- One seed per arm (s5); s6 and the other arms of the queue were dropped to save time.
- The harness differs from the app in small ways (floor mean instead of median, imaging every 10 frames instead of 32,
  adds at the frame the slow loop made them).
- The outcome nulls need about five windows (150 s at 30 s) of the session before a boundary; shorter sessions get
  "not judged" for those checks.
