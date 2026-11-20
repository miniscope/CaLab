# Session boundaries: the fix (re-registration, flicker re-seat, floor and noise rescale)

13 Nov 2026. Branch `feat/cala-session-boundary`. Follows the measurement study
[`2026-11-13-session-boundary.md`](2026-11-13-session-boundary.md) (#386) and implements its fixes 1–4.
Scratch (runs, logs, screenshots; not in the repo):
`/private/tmp/claude-503/-Users-daharoni-Projects-CaLab/afa6e515-3c3e-4cc7-af38-91dc1bbfaf4b/scratchpad/boundary-fix/`
(`runs/`, `real/`, `smoke/`, `compare.py`, `diff_alone.py`).

## Verdict

All four gates pass; all four fixes are kept (the ablations need each of them).

| gate                                           | result                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-session runs byte-identical to main        | **pass.** qc_eval, `motion_s5`, 2000 frames: identical with no flags and with `--sessions 4800 --session-fix all` (boundary beyond the end), except wall time (`cost.txt`, `passes.tsv` `wall_s`) and the extra, empty `session_boundaries.tsv`     |
| Boundary bump reduced: sims                    | **pass.** ×1.25: peak +5.1 % → control level (−0.5 %); ×0.8 dip −0.8 % → 0; with a 15 px shift +5.8 % → control; inside a dark aperture +5.1 % → control                                                                                            |
| Boundary bump reduced: real data               | **pass.** Joint minus session-2-alone, median cell: +0.4–0.5 σ for ~100 frames → 0; mean excess −30–65 %, gone by frame ~200 instead of ~1000. Online joint run: p20 lift 0.82 σ → 0, mean over frames 10–100 5.0 → 3.7 σ (2.5 before the boundary) |
| No P8 / R8 / `r_fp` regression worse than −.02 | **pass.** Worst: P8 −.010 (gain1.25 and gain0.8)                                                                                                                                                                                                    |
| Rotation arms improve                          | **pass.** 1°: P8 .786 → .917 (motion), .796 → .931 (static); R8 +.06; `r_fp` +.03–.04; adds after the boundary 66 → 20 (control 20–24)                                                                                                              |

A session run alone shows **no** bump at its start (it starts low and rises to its steady level over ~30 frames), so the
real-data bump was carried-over state, which is what the fix removes.

The browser smoke found a crash at the first boundary of a Joint run (fixed, with a test); see below.

## What the fix does (only at a session boundary of a Joint run)

All four act on the first batch of the new session; within a session nothing changes.

1. **Re-registration** (`crates/cala/src/motion/session.rs`, `SessionAligner` in the app's stage B).
   - Reference: the mean of the previous session's last 100 registered frames. Moving image: the mean of the new
     session's first batch (8 frames), after the front half.
   - Both are band-passed (difference of Gaussians, σ 1.5 / 15 px) on the largest square of the FOV (≤ 384 px).
   - Search: rotations −3°…+3° in 0.5° steps with a parabolic refine, each with a cross-correlation translation search of
     ±40 px.
   - Apply rule: a rotation if |θ| ≥ 0.1° **and** it removes ≥ 10 % of the unrotated fit's `1 − ncc`; else a
     translation beyond 10 px as whole pixels; else nothing (the per-frame corrector's ±15 px search catches the rest).
   - The transform warps every frame of the session before the per-frame corrector. The FOV mask moves with it (missing
     data outside), the flat-field estimator gets the session translation added to each shift and no frames of a rotated
     session. Refine and Extract replay the recorded transform.
2. **Flicker re-seat** (stage A): the flicker reference restarts on the new session, as at the start of a recording.
3. **Background floor rescale** (stage C): a gain and offset fitted across pixels between the new session's first batch
   and the floor's boxcar of the previous session's last frames (trimmed least squares, so active pixels drop out;
   corrected for errors in variables with the noise map: without the correction ×1.25 reads as 1.15, with it 1.248).
   The old floor is mapped by it and keeps what it had learned.
4. **Noise map rescale** (stage C): one robust ratio, the new session's frame-to-frame differences in units of the old
   map, scales the whole map.

`qc_eval --sessions F1,.. --session-fix all|none|reg,flicker,floor,noise` runs the same code; `session_boundaries.tsv`
records each boundary's fits.

## Method

- Sims: the stitched two-session sims of the study (`~/Projects/cala-data/sims-sessions/`, boundary at frame 4800), seeds
  5 and 6, `motion` base. New arms with a **dark aperture** (`stitch_sessions.py --aperture-dark 0.28`: both sessions
  through a lit disk leaving 28 % of the frame dark, as real Miniscope frames): `apctl`, `apgain1.25`, `aprealstep`
  (×1.02 − 6.2, the measured real step).
- qc_eval as in the study: `sim --batch 8 --slow-seed 1 --motion --budget 3e7 --churn-log --boundary-log --sessions 4800`,
  `base` = no fix, `all` = the four fixes. Scoring `boundary_analysis.py` (`offB` = trace transient relative to session B's
  own steady state, % of the cell's peak; P8/R8/`r_fp` from `summarize.run_metrics`).
- Real data (Samara 14_30_33 → 14_44_22, 30 fps, read only): the concatenated recording (`--sessions 17874`), online
  (`concat`) and with a fixed library from the study's run (`concat_lib`, `--library … --start 2`, so every cell has a
  trace from the start); and each session alone with the same fixed library (`s1_lib`, `s2_lib`).
  `real_boundary.py traces` (population mean in each cell's noise σ, baseline p20 over B−600..B).

## Results: sims (mean of seeds 5 and 6; `python3 compare.py runs`)

`offB` in % of the cell's peak (the control's own windows show the noise floor, about ±0.5). Adds = slow-loop adds in
the 1000 frames before → after the boundary.

| base   | arm             | fix  | seeds | 0–10  | 10–100    | 100–1000 | peak % @frame | τ   | scale B/A | P8       | R8       | r_fp     | adds  |
| ------ | --------------- | ---- | ----- | ----- | --------- | -------- | ------------- | --- | --------- | -------- | -------- | -------- | ----- |
| motion | ctl             | base | 2     | −0.46 | −0.43     | +0.05    | (noise)       | –   | 1.027     | .923     | .785     | .967     | 33→20 |
| motion | ctl             | all  | 2     | −0.46 | −0.48     | +0.01    | (noise)       | –   | 1.022     | .927     | .787     | .965     | 33→24 |
| motion | gain1.25        | base | 2     | −0.15 | **+3.78** | +0.92    | **+5.13 @52** | 160 | 1.284     | .929     | .782     | .964     | 33→20 |
| motion | gain1.25        | all  | 2     | −0.59 | −0.60     | −0.02    | (noise)       | –   | 1.277     | .919     | .782     | .966     | 33→22 |
| motion | gain0.8         | base | 2     | −0.49 | −1.08     | −0.79    | −0.92 @144    | 730 | 0.816     | .928     | .779     | .965     | 33→16 |
| motion | gain0.8         | all  | 2     | −0.35 | −0.36     | +0.01    | (noise)       | –   | 0.813     | .918     | .781     | .968     | 33→20 |
| motion | shift15         | base | 2     | +0.03 | −0.11     | +0.09    | (noise)       | –   | 1.045     | .900     | .780     | .966     | 33→24 |
| motion | shift15         | all  | 2     | −0.23 | −0.23     | +0.03    | (noise)       | –   | 1.049     | .914     | .777     | .966     | 33→22 |
| motion | shift15gain1.25 | base | 2     | +0.66 | **+4.41** | +1.13    | **+5.79 @55** | 185 | 1.311     | .906     | .780     | .964     | 33→28 |
| motion | shift15gain1.25 | all  | 2     | −0.30 | −0.27     | +0.04    | (noise)       | –   | 1.311     | .905     | .781     | .967     | 33→22 |
| motion | shift25         | base | 1     | +0.16 | +0.04     | +0.03    | (noise)       | –   | 1.046     | .888     | .773     | .966     | 39→20 |
| motion | shift25         | all  | 1     | −0.11 | −0.05     | +0.00    | (noise)       | –   | 1.047     | .883     | .776     | .960     | 39→15 |
| motion | rot1            | base | 2     | −0.65 | −0.48     | −0.00    | (noise)       | –   | 0.886     | **.786** | **.718** | **.928** | 33→66 |
| motion | rot1            | all  | 2     | −0.36 | −0.38     | −0.08    | (noise)       | –   | 1.016     | **.917** | **.774** | **.965** | 33→20 |
| static | gain1.25        | base | 2     | −0.22 | **+3.68** | +0.78    | **+5.00 @54** | 136 | 1.285     | .937     | .752     | .962     | 24→18 |
| static | gain1.25        | all  | 2     | −0.88 | −0.57     | −0.13    | (noise)       | –   | 1.284     | .942     | .768     | .962     | 24→18 |
| static | rot1            | base | 2     | −0.69 | −0.50     | −0.12    | (noise)       | –   | 0.909     | **.796** | **.693** | **.933** | 24→46 |
| static | rot1            | all  | 2     | −0.57 | −0.52     | −0.18    | (noise)       | –   | 1.020     | **.931** | **.751** | **.962** | 24→20 |

"(noise)": the fitted peak is within the control's ±0.5.

- **Brightness steps.** The ×1.25 bump (+5.1 % peak, τ ≈ 150 frames) and the ×0.8 dip (−0.8 % over frames 100–1000)
  are gone: every window is at the control's level. Also with a 15 px shift on top.
- **Rotation.** The 1° session is re-registered (fitted −0.95° on s5 and −1.06° on s6, truth 1°, correction sign; ncc
  .898 vs .862 unrotated on s5). P8 .786 → .917 (motion) and .796 → .931 (static), R8 +.06, `r_fp` +.03–.04, and the adds
  after the boundary fall from 66 to 20, the control's level. `scale B/A` returns to ~1.02.
- **Translations** were already caught by the corrector (≤ 25 px). The fix applies them as a whole-pixel session shift
  (fitted (−8, −12) and (−8, −11) for the (9, 12) px arm, (−14, −20) for (15, 20) px; the control fits (+0.9, −0.5), the
  sim's own offset, which is below the 10 px rule and not applied). P8 .900 → .914 at 15 px; 25 px is within one seed's
  spread (.888 → .883).
- **No regression worse than −.02** in P8, R8 or `r_fp` on any arm: the largest is P8 −.010 (gain1.25, gain0.8).
- The fits on the controls: nothing applied (fitted 0.05° / −0.07°, sub-pixel), floor gain 1.00 / 1.01, noise 0.98 /
  1.03. A ×1.25 step fits 1.248 / 1.262 (floor) and 1.235 / 1.261 (noise); ×0.8 fits 0.800 and 0.795. A rotated session's
  noise ratio is 0.86–0.93: the bicubic warp averages the noise, and the map follows that.

Dark aperture (both sessions through a lit disk, 28 % of the frame dark):

| arm        | fix  | 0–10  | 10–100    | 100–1000 | peak % @frame | P8   | R8   | r_fp |
| ---------- | ---- | ----- | --------- | -------- | ------------- | ---- | ---- | ---- |
| apctl      | base | −0.52 | −0.45     | −0.00    | (noise)       | .849 | .792 | .961 |
| apctl      | all  | −0.43 | −0.47     | −0.01    | (noise)       | .849 | .798 | .959 |
| apgain1.25 | base | −0.18 | **+3.80** | +0.83    | **+5.05 @59** | .849 | .794 | .957 |
| apgain1.25 | all  | −0.59 | −0.54     | −0.01    | (noise)       | .859 | .807 | .961 |
| aprealstep | base | −0.38 | −0.08     | +0.07    | (noise)       | .860 | .797 | .958 |
| aprealstep | all  | −0.31 | −0.26     | +0.01    | (noise)       | .858 | .801 | .958 |

- The fix works the same inside a lit disk.
- The dark aperture does **not** make the real step (×1.02 − 6.2) produce a bump either: the study's open question (what
  makes the real bump that a uniform sim step does not) is still open. The aperture costs P8 (.92 → .85) in both arms
  alike; that is the sim, not the boundary.

### Ablations (seed 5)

| arm      | fixes           | 0–10      | 10–100    | 100–1000 | peak %        | P8   | R8   | noise map B/A, frames 10–100 (mid-B 1.25) |
| -------- | --------------- | --------- | --------- | -------- | ------------- | ---- | ---- | ----------------------------------------- |
| gain1.25 | none            | +0.02     | **+3.96** | +0.88    | **+5.56**     | .914 | .781 | 1.013                                     |
| gain1.25 | flicker         | **+5.87** | **+4.49** | +0.74    | **+6.49 @5**  | .908 | .786 |                                           |
| gain1.25 | floor           | −0.54     | **+3.19** | +0.79    | **+4.75 @67** | .899 | .783 |                                           |
| gain1.25 | flicker + floor | −0.51     | −0.46     | +0.01    | −0.50         | .904 | .783 | 1.018                                     |
| gain1.25 | all             | −0.50     | −0.45     | +0.01    | −0.49         | .902 | .776 | **1.238**                                 |
| rot1     | none            | −0.65     | −0.65     | +0.11    | (noise)       | .757 | .711 |                                           |
| rot1     | reg             | −0.41     | −0.52     | −0.20    | (noise)       | .917 | .770 |                                           |
| rot1     | all             | −0.30     | −0.35     | −0.13    | (noise)       | .912 | .773 |                                           |

- **Flicker and floor are needed together.** Re-seating the flicker alone passes the step at once to the lagging floor
  (+5.9 % from frame 0). Rescaling the floor alone fixes the first 10 frames, but the flicker reference still holds the
  step for ~1 s and then releases it onto the floor (+3.2 % over 10–100). Together they remove it.
- **Registration** alone gives the whole rotation recovery (P8 .757 → .917).
- **Noise**: no trace effect (all ≈ flicker + floor), but without it the noise map reads 1.01 of the old session for
  100 frames and 1.13 over frames 100–1000 instead of the true 1.25; with it, 1.24 from the first frame. That is the SNR,
  QC and slow-loop thresholds seeing the new session's noise at once. P8/R8 differences between these three single-seed
  runs (≤ .006) are within run-to-run spread.
- **All four fixes are kept.**

## Results: real data (Samara, one boundary at frame 17874)

The boundary fit: no warp (fitted 0.03°, (−0.6, −0.4) px; ncc .974), floor gain 1.126 / offset 0.007, noise 0.966.

**Population curve** (`real_boundary.py traces`, mean over cells of the trace in each cell's noise σ, baseline p20 over
B−600..B; frames relative to the boundary; `scratchpad/boundary-fix/profile.py`):

| run                                     | cells | −600..−30 | −30..0 | 0..5     | 5..10    | 10..30   | 30..100  | 100..200 | 200..400 | 400..1000 | 1000..2000 |
| --------------------------------------- | ----- | --------- | ------ | -------- | -------- | -------- | -------- | -------- | -------- | --------- | ---------- |
| joint, online, base                     | 124   | 2.46      | 2.92   | **5.70** | **4.99** | **4.72** | **5.12** | **4.87** | 4.04     | 2.65      | 2.97       |
| joint, online, fix                      | 124   | 2.48      | 2.95   | 4.92     | 4.02     | 3.47     | 3.75     | 3.60     | 3.14     | 2.29      | 2.97       |
| joint, fixed library, base              | 376   | 2.12      | 2.11   | 3.34     | 3.21     | 3.54     | 4.06     | 3.33     | 2.79     | 1.92      | 2.46       |
| joint, fixed library, fix               | 376   | 2.15      | 2.13   | 2.87     | 2.61     | 2.74     | 3.09     | 2.45     | 2.15     | 1.65      | 2.42       |
| control: mid session 1 (frame 8937)     | 376   | 2.41      | 2.20   | 2.33     | 2.31     | 2.24     | 1.93     | 2.16     | 2.08     | 2.80      | 2.67       |
| session 1 alone, from its first frame\* | 376   | –         | –      | 0.90     | 1.36     | 1.95     | 1.91     | 2.02     | 2.74     | 2.51      | 2.63       |
| session 2 alone, from its first frame\* | 376   | –         | –      | 1.25     | 1.49     | 2.31     | 3.00     | 2.52     | 2.82     | 2.20      | 3.08       |

\* Baseline from the session's own frames 1500–2100 (there is nothing before frame 0), so the level is not on the same
scale as the joint rows; the shape is what counts.

- In the online joint run the cells' p20 lift at the boundary (0.82 σ over frames 0–10 in the study's windows) goes to
  0, and the population mean over frames 10–100 falls from 5.03 to 3.69 σ (before the boundary: 2.5).

**Joint minus alone**, the cleanest comparison: the same fixed library, the same cells, session 2's frames run after
session 1 (joint) and on their own; the difference per cell in the alone trace's noise σ (`diff_alone.py`), mean
(median) over 376 cells:

| joint run | 0..5              | 5..10             | 10..30            | 30..100           | 100..200      | 200..400      | 400..1000     | 5000..15000   |
| --------- | ----------------- | ----------------- | ----------------- | ----------------- | ------------- | ------------- | ------------- | ------------- |
| base      | +3.25 (**+0.53**) | +2.97 (**+0.36**) | +2.22 (**+0.42**) | +1.96 (**+0.36**) | +1.61 (+0.19) | +1.02 (+0.01) | +0.27 (+0.00) | +0.04 (+0.00) |
| fix       | +2.35 (+0.03)     | +1.93 (+0.00)     | +1.13 (+0.00)     | +0.81 (+0.00)     | +0.56 (+0.00) | +0.17 (+0.00) | −0.12 (−0.00) | +0.04 (+0.00) |

- **The typical cell's lift is gone** (median +0.4–0.5 σ for ~100 frames → 0). The mean excess, carried by fewer cells,
  falls by 30–65 % and is gone by frame ~200 instead of ~1000.
- Part of what remains in the first frames is the alone run's own warm-up: an alone session starts from a fresh state
  and its traces start **low** (0.9–1.3 σ over the first 5 frames, rising to the steady level by frame ~30).

**Does a lone session show a bump at its start?** No. Both sessions run alone start below their steady level and rise
to it over ~30 frames; there is no excess like the joint boundary's. So the joint bump was an artifact of carrying the
previous session's state, not something about the start of a recording session (handling, LED warm-up). After the fix
the median cell matches the lone run; a smaller mean excess in a minority of cells remains for ~200 frames.

## Browser smoke (app, Joint run)

- Two sessions cut from `motion_s5_gain1.25` (session 1 = frames 2000–3999, all before the step; session 2 = frames
  5000–6999, ×1.25), 2000 frames each, Joint, one Refine, Extract. Dev server on port 5198 (5197 was taken by the
  cala-label server). Screenshots in `smoke/fix7/`.
- **Found and fixed a crash:** the first boundary failed with "Cannot perform %TypedArray%.prototype.set on a detached
  ArrayBuffer". Stage B kept a reference to the calibration's FOV mask, which the job then transfers to the trace worker.
  B now keeps a copy; the in-process stages test detaches the mask between B and C as `postMessage` does (fails without
  the fix).
- After the fix: the run completes and writes both sessions. History logs `session boundary` at frame 2000: "Session 2
  start: no re-registration; background floor ×1.235, noise ×1.260". The boundary marker shows at 100 s in the cell trace
  and the History plots (the noise steps at the marker). The trace of a bright cell across the boundary has no bump. The
  exports have no NaN.
- The same smoke on main (055a0ad) ends with Stable 0.01 and many QC fails after the step (`smoke/main1/`).
- **Pre-existing, not from this branch:** in some of these smoke runs Refine or Extract stops with "processFrames:
  invalid trace config: frame N has non-finite pixels under cell M". Main 055a0ad does it too on the same input
  (`smoke/main1/`); it is intermittent (WebGPU motion in headless Chromium). Not investigated here.

## Not done / caveats

- Fix 5 of the study (a per-session per-cell brightness scale at export) is not done: the lasting `scale B/A` stays the
  applied gain, by design.
- The real data has one boundary; the sims have two seeds per arm (one for `shift25` and the ablations).
- The real-data floor gain is 1.126 although the raw light dropped by ~5 grey; the floor is in flattened units, so the
  gain is not the raw ratio. Not analysed further.
