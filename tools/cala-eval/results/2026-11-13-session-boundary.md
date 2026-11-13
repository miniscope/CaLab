# Session boundaries: what makes trace artifacts when sessions are run as one recording

13 Nov 2026. Branch `diag/session-boundary` (from main 1a21b6d). Measurement only: no cala behaviour change.
Scratch (plots, runs, logs; not in the repo): `/private/tmp/claude-503/-Users-daharoni-Projects-CaLab/afa6e515-3c3e-4cc7-af38-91dc1bbfaf4b/scratchpad/boundary/`
(`plots/*.png`, `runs/`, `real/`, `report_sims.md`). Stitched sims: `~/Projects/cala-data/sims-sessions/` (README there).

## Verdict

1. **An upward brightness step is the only perturbation that makes a trace artifact in the sims.** At ×1.25 every cell's
   baseline rises by about 5 % of its peak. The rise starts after ~10 frames, peaks at frame ~55 and decays with τ ≈ 135–185
   frames. A ×0.8 step makes a smaller dip, about −1 %, lasting ~1000 frames.
   - A pure camera-offset step (+10 grey) does nothing. Rigid shifts of 5, 15 and 25 px do nothing to the traces either.
2. **Most of the bump comes from the preprocessor's background floor.** It is a running minimum that relaxes upward with
   τ = 120 s, so it snaps down at once but follows a rise slowly. The flicker corrector adds the ~1 s ramp at the start.
   - Probe: resetting the floor at the boundary cut the ×1.25 peak from +5.1 % to +1.4 % and τ from ~150 to 32–48 frames.
     The ×0.8 dip over frames 100–1000 shrank from −0.78 % to −0.2 %.
   - The reset itself adds a −1 % dip over frames 0–10, because the fresh floor warms up on frames that contain activity.
3. **Registration is not the problem for translations.** The search is centred on the previous frame's shift, so 5 and 15 px
   jumps register on the first frame. 25 px (beyond the ±15 px window) registers by the second frame.
   - The cost of a shift is **coverage**. The registered B frames lose a strip the size of the shift, which brings edge
     false positives: static base P8 .950 → .922 at 15 px; motion base P8 .933 → .884 at 25 px (one seed).
4. **A 1° rotation is the most damaging perturbation by far.** Rigid plus non-rigid registration does not absorb it (up to
   5 px at the edge).
   - Adds in the 1000 frames after the boundary go from 27 to 53–89, and the interior false positives triple.
   - P8 falls from .95 to .80 (static) and from .93 to .79 (motion); R8 falls by .08; `r_fp` by .04.
   - There is no trace transient: the damage is structural (duplicate cells).
5. **Real data (Samara 14_30_33 → 14_44_22): the raw light changes at the boundary, and it is a step, not a warm-up.**
   - Over the lit disk session 2 is ~5 grey levels darker (raw frame mean 61.1 → 56.7; a per-pixel fit gives
     S2 ≈ 1.02 × S1 − 6.2). The dark corners do not change, so it is not a black-level change.
   - There is no ramp at the start of either session (100-frame bins are flat within ±0.5 grey). That excludes an LED
     warm-up on a 3–100 s scale.
   - In the PI's Joint export the bump is a **baseline lift in the quiet cells**: the least active third goes from 0.055 to
     0.207 of its own p99 over frames 10–100, and its share of frames above 0 from 0.68 to 0.87. The active cells barely move
     (0.167 → 0.196).
   - This is not biology (handling would show in active cells as more transients, not as a baseline lift in quiet ones).
     It is a state or preprocessing artifact driven by the raw step.
   - The flicker corrector reads the step as offset −6 / gain +0.04 and releases it over ~100 frames.
   - qc_eval's online path on the concatenated real sessions reproduces the bump: the population mean goes 2.6 → 5.4 noise σ
     over frames 0–10, and the cells' p20 goes 0 → 0.64; the mid-session control is flat.
   - A sim replay of the measured step (×1.02 − 6.2, uniform) does **not** reproduce it. The real mechanism is not pinned
     down yet; the candidate is the lit-disk edge, which the sims lack.
   - The per-session-alone runs (task c) were **not done** (see "Not done").

## Method

**Stitched sims** (`tools/cala-eval/stitch_sessions.py`).
- Sources: `sims-gt110/{static,motion}_s{5,6}`. Session A is frames 0–4799, unchanged. Session B is 4800–9599: the same
  cells and GT, perturbed in the raw 8-bit frames outside cala.
- Geometry moves the **tissue only**. The sensor-fixed vignette (`illumination × vignette`) and leakage glow from the GT
  zarr stay in place: de-quantize, divide out, resample with Keys bicubic, re-compose.
- Noise is topped up to minisim's sensor model (`0.12·E + 2.25 + 1/12` ADU²).
  - Check: B's frame-to-frame σ is 4.06 vs 4.03 in the source for sub-pixel and rotation arms.
  - Interpolation still leaves B's noise slightly spatially correlated.
- Edge pixels the move brings in are filled with session A's time-mean tissue, mirrored, plus model noise. This is static
  texture with no activity.
- `shifts.npy` gets `+(dy, dx)` for B's frames. qc_eval's per-block offsets in `motion_offset.tsv` confirm the sign: the
  B blocks agree with the A blocks within 0.1 px.
- Arms:

  | Arm | B perturbation |
  |---|---|
  | `ctl` | none |
  | `shift5` | (3.3, 3.8) px, sub-pixel |
  | `shift15` | (9, 12) px |
  | `shift25` | (15, 20) px |
  | `rot1` | 1° rotation |
  | `gain0.8`, `gain1.25` | counts × G |
  | `off10` | +10 grey |
  | `shift15gain1.25` | 15 px shift and ×1.25 |
  | `realstep` | ×1.02 − 6.2, the real step |

- The shift sizes are **assumed**. I found no published typical between-session Miniscope displacement; CellReg aligns
  with translations and rotations but does not report magnitudes.

**Runs.**
- qc_eval (diagnostics build), sim mode with the app's settings: `--motion` (online flat field), `--batch 8 --slow-seed 1
  --budget 3e7 --churn-log --boundary-log`.
- Every arm runs with `--motion`, including the static base, so arms compare like for like.
- Seeds 5 and 6 for all arms; one seed for `shift25`, the probes and `realstep`.

**Scoring** (`tools/cala-eval/boundary_analysis.py`).
- Cells: final cells matched to a detectable GT unit, at least 30 px from the edge, with an online trace from frame
  ≤ 1500 to the end.
- Per cell, fit `x = a c + b` (online trace on GT trace) twice: on A (frames 1500–4700) and on mid-B (frames 7800–9600).
- `offB` = window mean of `x − (a_B c + b_B)` in units of the cell's peak `a_A·max c`, median over cells. This is the
  **transient** relative to B's own steady state.
- `off(A model)` is the same against the A fit, so it includes the lasting change.
- `scale B/A` = median `a_B / a_A`.
- Peak and τ: an exponential fitted to the 10-frame-smoothed median `offB` curve, after subtracting its mid-B level.
- P8/R8/`r_fp` are from `summarize.run_metrics`.
- FP edge/int counts the final false positives within 25 px of the edge vs the rest.

**Diagnostics** (qc_eval, built with `--features diagnostics`):
- `--boundary-log` writes `boundary_pre.tsv`: per frame the input mean, glow, flicker fit, floor mean and lowered share,
  noise map every 10 frames, and the motion quality and flags.
- It also writes `boundary_traces.bin`: every cell's online trace and ring level.
- `--probe-bg-reset F` is a what-if probe: a fresh background floor before frame F.
- `--fps` (default 20) is for the 30 fps real data.
- **Identity:** a diagnostics build with `--boundary-log` on `motion_s5`, 2000 frames, gives byte-identical
  `adds/cells/convergence/edits/final/flat_field_updates/footprints/fp_history/global/gt/heldout/ho_cells/motion/motion_offset/removals/traces_gt`
  vs main 1a21b6d. `passes.tsv` differs only in `wall_s`, `cost.txt` only in timing. Re-checked with the final code
  (`--fps` and the probe added; `scratchpad/boundary/ident/`): same result.

## Results: sims (mean of seeds; full tables in `report_sims.md`)

Trace transient (`offB`, % of the cell's peak; the control's own windows show the noise floor, about ±0.5):

| base | arm | 0–10 | 10–100 | 100–1000 | peak @frame | τ (frames) | scale B/A | P8 | R8 | r_fp | FP edge/int |
|---|---|---|---|---|---|---|---|---|---|---|---|
| static | ctl | −0.51 | −0.31 | −0.09 | (noise) | – | 1.026 | .950 | .768 | .963 | 9.5/15.5 |
| static | shift5 | −0.49 | −0.28 | −0.03 | (noise) | – | 1.031 | .945 | .759 | .964 | 14.0/13.5 |
| static | shift15 | −0.28 | −0.22 | −0.06 | (noise) | – | 1.046 | .922 | .743 | .965 | 22.5/16.5 |
| static | shift25 (s5) | −0.01 | +0.00 | −0.14 | (noise) | – | 1.052 | .937 | .760 | .964 | 18/13 |
| static | rot1 | −0.67 | −0.45 | −0.10 | (noise) | – | 0.905 | **.803** | **.675** | **.923** | 31/72 |
| static | gain0.8 | −0.49 | −0.98 | −0.78 | −0.79 @176 | 792 | 0.827 | .943 | .763 | .964 | 8.5/20 |
| static | gain1.25 | −0.15 | **+3.80** | +0.79 | **+5.13 @54** | 135 | 1.291 | .945 | .761 | .963 | 14.5/13 |
| static | off10 | −0.51 | −0.31 | −0.06 | (noise) | – | 1.024 | .953 | .760 | .962 | 11/12 |
| static | shift15gain1.25 | +0.04 | +3.71 | +0.78 | +5.05 @58 | 135 | 1.306 | .922 | .757 | .962 | 26/13.5 |
| static | gain1.25 + bg reset (s5) | −0.82 | +0.84 | −0.00 | +1.40 @63 | 48 | 1.278 | .947 | .768 | .959 | 10/16 |
| static | gain0.8 + bg reset (s5) | −0.94 | −0.91 | −0.25 | −0.74 @30 | – | 0.818 | .954 | .757 | .961 | 12/10 |
| motion | ctl | −0.48 | −0.49 | −0.03 | (noise) | – | 1.019 | .933 | .777 | .969 | 16/19 |
| motion | shift5 | −0.30 | −0.33 | −0.02 | (noise) | – | 1.036 | .923 | .762 | .968 | 22/18 |
| motion | shift15 | +0.08 | −0.14 | +0.08 | (noise) | – | 1.053 | .919 | .767 | .970 | 19.5/23 |
| motion | shift25 (s5) | +0.48 | +0.10 | −0.01 | +0.56 @6 | – | 1.059 | .884 | .752 | .970 | 30/31 |
| motion | rot1 | −0.67 | −0.42 | −0.02 | (noise) | – | 0.885 | **.785** | **.696** | **.933** | 38.5/82 |
| motion | gain0.8 | −0.48 | −0.98 | −0.78 | −0.89 @144 | 747 | 0.820 | .930 | .773 | .967 | 14.5/22 |
| motion | gain1.25 | −0.13 | **+3.74** | +1.01 | **+5.05 @52** | 160 | 1.280 | .929 | .773 | .967 | 15.5/22 |
| motion | off10 | −0.57 | −0.55 | −0.05 | (noise) | – | 1.022 | .935 | .775 | .968 | 13/21 |
| motion | shift15gain1.25 | +0.79 | +4.43 | +1.24 | +5.84 @50 | 185 | 1.313 | .918 | .766 | .969 | 22.5/20.5 |
| motion | gain1.25 + bg reset (s5) | −1.00 | +1.00 | −0.01 | +1.38 @55 | 32 | 1.283 | .910 | .756 | .971 | 19/27 |
| motion | gain0.8 + bg reset (s5) | −1.01 | −0.89 | −0.17 | −0.82 @34 | – | 0.818 | .922 | .773 | .968 | 16/24 |
| motion | shift15gain1.25 + bg reset (s5) | −1.16 | +0.89 | +0.02 | +1.45 @54 | 32 | 1.307 | .925 | .739 | .953 | 25/12 |

State across the boundary (`report_sims.md`, second table per base):

- **Registration.**
  - First-frame error 0.1–0.35 px for 5 and 15 px, as small as the control; never flagged anomalous.
  - 25 px: 1.2–1.8 px on the first frame, then caught. The search window is ±15 px around the previous shift, so it walks
    there in two steps.
  - rot1: the rigid error rises to 0.7–0.9 px median for the whole of B (s5); the non-rigid patches do not absorb it.
- **Flicker gain** reads the full step on the boundary frame (+0.24 / −0.20 for ×1.25 / ×0.8) and releases it with
  τ ≈ 20 frames (1 s, its reference time constant). The brightness reaches the frames over ~40 frames, which is why the bump
  starts after ~10 frames.
- **Background floor mean** after ×1.25 sinks by 0.7–0.9 grey over ~300 frames. The negative half of the flattened texture
  snaps down; the positive half (cells, bright texture) can only rise at 1/2400 per frame.
- **Ring levels** rise to about +4 % of peak (×1.25) within ~200 frames and fall to about −3.5 % (×0.8) over ~1500 frames.
  The level is solved per frame, so this reflects the floor lag in the ring pixels, not fast-loop state.
- **Noise map** follows the gain over ~800 frames (B/A noise 1.12 after 100–1000 frames, 1.25 by mid-B for ×1.25).
  - This changes SNR, QC and slow-loop thresholds but not the trace values.
  - Sub-pixel shifts lower it ~4 %: cala's warp averages the noise.
- **Edits.** Adds in the 1000 frames after the boundary vs before are unchanged for gain, offset and translation. rot1 has
  2–3× the adds and 2–5× the merges and splits. The 15 px static shift adds ~10 edge false positives along the strip B no
  longer covers.
- **Footprints** are not refined harder after gain steps (refines before → after are within the control's spread). The
  slow loop's half-life does not need resetting for a brightness step.

Plots:
- `plots/residual_static.png`, `plots/residual_motion.png`: median `offB` around the boundary.
- `plots/state_static.png`, `plots/state_motion.png`: input mean, flicker gain, floor mean, noise, registration error.
- `plots/ring_static.png`, `plots/ring_motion.png`: ring-level change.

## Results: real data (Samara, Miniscope V4, 30 fps; read-only)

Tool: `tools/cala-eval/real_boundary.py` (`brightness`, `cells`, `concat`, `traces`). Plots:
`plots/real_boundary.png` (raw mean and regions, quiet vs active traces, flicker fit) and `plots/real_mean_images.png`
(S1 last / S2 first mean images and their difference).

**(a) Raw brightness, straight from the AVIs.**

| window | raw frame mean (grey) |
|---|---|
| S1 first 30 / first 600 / 600–1200 | 60.9 / 61.3 / 60.9 |
| S1 last 600 | 61.1 |
| S2 first 30 / 300 / 600 | 57.7 / 57.1 / 56.7 |
| S2 600–1200 / last 600 | 57.0 / 60.2 |

- The difference image (S2 first 600 − S1 last 600) is a near-uniform −5 grey over the lit disk, plus cell-sized ± spots
  (activity and the ~1 px move). The dark corners are 0.
- Lit-pixel ratio: median 0.94, 5–95 % range 0.86–0.97. The 3×3 region ratios are 0.85–0.97, lowest in the dim corners,
  as an additive drop gives.
- A per-pixel regression gives S2 = 1.020 × S1 − 6.19.
- **No warm-up ramp** in either session's first 3000 frames; 100-frame bins vary by ±0.7 grey with no trend.
- Session 2 drifts back up by ~3.5 grey over its length.

**(b) Quiet vs active cells** (PI's Joint run export, 393 cells; trace / cell p99; quiet = the third with the lowest p95
over B−600..B and B+300..B+900, so the bump window is not used to classify):

| window | active (262): mean / share > 0 | quiet (131): mean / share > 0 |
|---|---|---|
| boundary −600..0 | 0.167 / .70 | 0.055 / .68 |
| boundary 0–10 | 0.191 / .68 | 0.158 / .83 |
| boundary 10–100 | 0.196 / .69 | **0.207 / .87** |
| boundary 100–300 | 0.177 / .70 | 0.180 / .84 |
| boundary 300–1000 | 0.162 / .69 | 0.056 / .67 |
| control, mid S1 (10–100) | 0.143 / .67 | 0.076 / .69 |
| control, mid S2 (10–100) | 0.156 / .64 | 0.074 / .69 |
| control, S1 frame 600 (10–100) | 0.151 / .65 | 0.128 / .69 |

- The quiet cells' traces are lifted off zero (share of frames above 0: .68 → .87) for ~300 frames (10 s). This is a
  baseline offset, not transients.
- Active cells move by less than their own fluctuation.
- The flicker fit holds offset −6 / gain +0.04 on the boundary frame and decays over ~100 frames (`real_boundary.png`).
- Motion moves ~1 px (−0.88, −0.88 → +0.21, −0.28).
- The S1 frame-600 control shows a smaller quiet-cell lift (0.068 → 0.128) without a raw step. Activity in the S1 warm-up
  window may contribute; this is unresolved.

**(c) qc_eval on the real sessions.**
- The concatenated recording (`real/concat`: symlinks, S1's files then S2's) runs with
  `qc_eval real --motion --fps 30 --boundary-log`.
- **The bump is reproduced in cala's online path, without Refine or Extract.**
  - Cells: the 102 that exist from frame 1500 to the end. Units: each cell's noise σ, baseline = p20 over B−600..B.
  - At the boundary the population mean goes 2.64 (B−600..B) → **5.41** (0–10) → **5.03** (10–100) → 3.10 (100–1000) →
    3.20 (1000–2000).
  - The cells' p20 goes 0 → **0.64** (0–10) → 0.11 (10–100) → 0: a baseline lift.
  - Control, the same windows at mid-session 1 (frame 8937): 3.06 → 3.17 → 2.38 → 2.90 → 3.55, no lift.
  - So the online pipeline makes a baseline step at this boundary. It is a boundary/state artifact, not something only the
    later passes create.
  - Files: `real/run_concat/`, `real/tr/traces_*.json`.
- **Not done:** the per-session-alone runs (S1 alone, S2 alone, ideally with a fixed library so every cell has a trace
  from frame 0).
- **Sim replay of the real step does not reproduce it.**
  - The `realstep` arm (motion_s5, B = 1.02 × A − 6.2, uniform over the frame) gives no transient: `offB` −0.30 / −0.14 /
    +0.13 % in 0–10 / 10–100 / 100–1000, inside the control's noise. P8 .914, R8 .773.
  - So a uniform additive drop is not enough on a fully lit sim. The real artifact needs something the sims lack. The
    candidates are the lit-disk edge (28 % of the real frame is dark; the flattener's low-pass and the flicker fit's
    offset/gain split both act differently next to a dark border) and the non-uniform part of the real change.
  - **Unresolved.** Next: the real concat run with `--probe-bg-reset 17874`, and a stitched sim with a dark aperture.

## Attribution

| mechanism | evidence | share of the artifact |
|---|---|---|
| Preprocessor background floor (running min, upward τ 120 s) | Probe reset: ×1.25 peak 5.1 → 1.4 %, τ ~150 → ~40 frames; ×0.8 late dip −0.78 → −0.2 %. Ring levels follow the floor lag | **dominant** for brightness steps |
| Flicker corrector (1 s reference) | Holds the step for ~1 s, then releases it: the ~10-frame delay and 40-frame rise of the bump; the residual +1.4 % after the probe | brief, ~1–3 s |
| Noise map (median tracker, ~800 frames) | Follows the gain slowly. No trace effect, but QC/SNR and slow-loop thresholds see the old σ for ~1 min | indirect |
| Motion corrector | Catches translations ≤ 25 px in 1–2 frames. Does not model rotation: 1° doubles adds and costs .15 P8 | translation: none; rotation: **largest structural** |
| Registration coverage | The strip B no longer covers loses data: edge FPs (+10–15 at 15–25 px) | moderate (P8 −.03 to −.05) |
| Online flat field | Sensor-fixed; no visible change at the boundary in these arms | none measured |
| Fast-loop warm starts | The ring level is solved per frame. No transient beyond what the floor explains | none measured |
| Slow-loop footprint statistics (half-life) | Refines, merges and deletes after the boundary equal the control for gain and translation | none measured |
| Per-cell brightness | `scale B/A` = the applied gain (0.82, 1.28–1.31); a lasting scale change that is real in camera units | lasting, by design |

## Recommended fixes (`onSessionBoundary` hook), ranked by measured impact

1. **Rotation-aware re-registration of the new session.**
   - At the boundary, register B's first frames to the global reference with a similarity search (rotation ±3°, a wide
     translation search), then warp B by it before the running corrector.
   - Measured stake: 1° costs P8 −.15, R8 −.08, `r_fp` −.04 and doubles the adds.
   - Translation alone needs nothing; the corrector already catches ≤ 25 px in 1–2 frames. A wider rigid search
     (`max_shift` ≥ 30 px for the first frames of a session) is a cheap safety margin.
2. **Re-estimate the background floor at the boundary, without a cold start.**
   - The measured hard reset removes ~70 % of the bump but adds its own −1 % dip over the first 10 frames, because the
     fresh floor warms up on active frames.
   - Better: rescale the old floor by the robust per-pixel ratio of B's first ~1 s to A's last ~1 s (a gain/offset fit, as
     the flicker fit already does), then continue.
   - A real-data run with this probe is needed before choosing.
3. **Re-seat the flicker reference at the boundary.** Set `R` to B's first frames instead of letting the 1 s reference
   absorb the step. This removes the remaining ~1.4 % / 1–3 s part. Cheap.
4. **Re-initialise the noise map at the boundary** (fresh median-tracker init over B's first 20 frames). No trace effect,
   but SNR/QC and slow-loop thresholds are otherwise off by the gain for ~1 min.
5. **Per-session per-cell brightness scale.**
   - The lasting `scale B/A` equals the light change, so a per-session scale (fitted at export, or a per-session
     normalisation of ΔF) is how cross-session traces become comparable.
   - It is not a transient fix. On the real data the change is mostly additive (−6 grey), which the flattener and floor
     remove, so the per-cell scale there is ~1.02.
6. **Do not reset** the fast loop's warm starts or the slow loop's footprint statistics. No measured benefit; resetting
   the statistics would throw away evidence.
7. **Edge coverage**: when B moves, mark the strip it no longer covers as invalid for the B frames (already done by the
   validity mask). Consider the session-union FOV when scoring keep tests near the edge. Moderate stake (P8 −.03 to −.05).

## Not done / caveats

- Per-session-alone qc_eval runs on the real data (task c, second half). The fixed-library variant needs one more
  discover run (~20 min) and three extraction runs.
- The probe was not run on the real data, and neither was the rescale-the-floor variant (fix 2).
- `shift25`, `realstep` and the probes have one seed; everything else has two (s5, s6).
- Sims are fully lit to the frame edge; the real FOV is a lit disk with 28 % dark. Uniform offsets near the disk edge are
  not modelled.
- The gain arms scale all counts, so noise scales with G (analog gain). An LED change would scale shot noise as √G.
- qc_eval preprocessing used 20 fps time constants for the sims (their rate) and `--fps 30` for the real data.
