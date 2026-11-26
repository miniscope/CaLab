# Motion correction: the cross-correlation gain bias (and a flat-field gain)

26 Nov 2026. Branch `test/motion-xcorr-bias` (from main `c380b6b3`). Raw data, probes, logs and the probe patch:
`~/Projects/cala-data/runs/motion-xcorr-bias/`.

## Verdict

**1. The window-envelope bias is real in the bare estimator but does not change cala's shifts. No behaviour
change.**

- `Correlator::register` divides the correlation by the Tukey window's overlap envelope. That is exact for
  texture that fills the window. It over-corrects content sitting in the window's flat middle, so the shift
  reads too large on such content.
- cala correlates band-passed frames that fill the region, and its rigid stage re-cuts the crop at the integer
  estimate, so the division only ever acts on a sub-pixel residual.
- On the five v3 motion sims, switching the division off moves the rigid shifts by about 0.001 px RMS. Every
  error statistic stays the same to the third decimal, on every input path tried (raw frames, the preprocessor's
  front half, front half plus online flat field). On the workshop recording the two shift traces differ by
  0.005 px RMS.
- The flaky proptest `xcorr_recovers_shift` was testing the estimator on exactly the content it over-corrects,
  with a fixed 1 px tolerance. This PR:
  - gives it a tolerance that grows with the shift, with a comment saying why;
  - adds the failing seed to the regressions file;
  - adds `xcorr_exact_on_texture`, a tight property that fails if the division is removed.

**2. Found on the way, not fixed here: with the online sensor flat field on, the rigid shift has a gain of about
1.04, rising to 1.05–1.10 late in the recording.**

- The online flat field is the app's and qc_eval's default with motion (#330).
- With it on, registration error on the sims rises from 0.045 to 0.071 px RMS and p95 from 0.090 to 0.142 px.
- The gain appears when the first flat-field map is applied (frame 3000, 150 s at 20 fps) and keeps growing.
- It is not the envelope: switching the division off with the flat field on changes nothing (§4).
- It reproduces every existing qc_eval `--motion` run on `v3_motion_s5` exactly, so every motion-arm qc_eval
  result since #330 carries it.
- The sims appear to have no sensor gain pattern (the spec has no PRNU / fixed-pattern key), so on them the flat
  field has nothing real to remove. Whether it helps or hurts registration on real data is not established (§5).

## 1. Cause of the envelope bias

The probe (`probes/zz_probe_xcorr.rs` in the run directory; probes are not in the repo) registers a 64 × 64 image
onto a shifted copy of itself. Both are drawn analytically (no interpolation), with Tukey α = 0.3 and upsample 10.

"No envelope" is a probe-only build with the division switched off (`xcorr_no_env_toggle.patch`). With
`XCORR_NO_ENV` set, `Correlator::new` replaces both window power spectra by a DC-only one, so the envelope is 1
everywhere. The same build (`motion_eval_toggle`) runs every "no envelope" arm below.

| content                                                   | shift       |    envelope (shipped) |           no envelope |
| --------------------------------------------------------- | ----------- | --------------------: | --------------------: |
| one sigma-3 blob, centred                                 | 0.5 / 2 / 4 | 1.095 / 1.088 / 1.073 | 0.998 / 0.998 / 0.999 |
| 9 blobs clustered in the middle (like the failing seed)   | 0.5 / 2 / 4 |    1.92 / 1.44 / 1.30 |    0.93 / 0.96 / 0.97 |
| 64 blobs on a grid over the whole window (into the taper) | 0.5 / 2 / 4 | 0.996 / 0.990 / 0.984 | 0.975 / 0.969 / 0.965 |
| smooth plane-wave texture filling the window              | 0.5 / 2 / 4 | 0.994 / 0.998 / 1.003 | 0.955 / 0.961 / 0.969 |

The numbers are estimated / true shift (gain). The cluster row is a hand-made layout like the failing seed's (9
blobs at y 20–30, x 20–44), with the shift on x and a 2.667 px shift on y.

What the rows show:

- **Window-filling content.** With both images windowed, the expected correlation of a stationary texture at lag
  `u` is its autocorrelation times the window's autocorrelation `A(u)`. `A(u)` falls with `|u|` and drags the
  peak towards zero. Dividing by `A(u)` removes that pull (texture row: 0.96 → 1.00; spread-blob row: 0.97 →
  0.99).
- **Content only in the window's flat middle.** The taper never attenuated this content, so there is no pull to
  remove, and the division over-corrects.
  - The over-estimate is about the same fraction of the shift at every lag: 1.09 already at 0.5 px. It is not
    confined to large lags where the overlap is small.
  - It is larger for broad content: a tight cluster, whose correlation peak is broad, reads 0.5 px as 0.96.
- The failing proptest seed (9 blobs at y ≈ 20–30, x ≈ 20–44, true shift (2.667, −3.207), read dx 4.24) is the
  clustered case.

## 2. What cala uses

**Input path.** The app and qc_eval feed the corrector the preprocessor's front half: hot pixels, flicker, glow
flattening and line removal, with the sensor FOV mask set. With motion, both also apply the online sensor flat
field (#330), which is learned from the corrector's own rigid shifts and applied to the preprocessor as it
updates.

**Rigid stage (app and qc_eval).**

- `Engine::register` (`corrector.rs`) cuts the crop at the previous frame's integer shift and registers it.
- If the residual exceeds 0.75 px, it cuts again at the rounded estimate and registers once more (search ±2.5 px).
- The reported shift is `offset + residual`, so the envelope acts only on a sub-pixel residual.
- The running template is pinned to the warm-up template through a template-on-template registration near zero
  lag (`refresh_spectra`).

**Non-rigid patches (qc_eval only; the app runs rigid, `MotionOptions` default `nonrigid: false`).**

- `NonRigidConfig::default()`: a 4 × 4 grid of patches about 154 px wide.
- Each patch is registered once, without a re-cut, from the rounded rigid shift (search ±3.5 px).
- The result is then screened, smoothed over time and shrunk towards zero.

**Session alignment** (`session.rs`).

- Registers band-passed session means single-shot, up to ±40 px.
- A translation-only result is rounded to integers. The sub-pixel fit is used only together with a rotation.

Patches and session alignment are single-shot. They are safe only because their band-passed images fill the
window. That was measured on dense sims and the workshop recording, not proven.

## 3. End to end on the motion sims

**Method.**

- `motion_eval minisim` on `sims-v3/v3_motion_s5..s9`: 600 × 600 px, 9600 frames each, rigid shifts with sd ≈ 1 px
  and a 4 × 4 non-rigid field of RMS ≈ 0.5 px.
- Default `MotionConfig`, warm-up on the first 200 frames.
- **Truth for the rigid shift** is the mean true displacement over the 16 patch centres. The region sees the
  rigid shift plus the mean of the field there, not minisim's rigid `shifts` alone. Against `shifts` alone the RMS
  is 0.20 px, nearly all of it the field.
- **Error** is `−estimate − truth`, with its mean removed per axis (the template's position is arbitrary).
- **Gain** is the slope of `−estimate` on truth.
- **Scoring:** `tools/cala-eval/motion_bias.py`.
- **Arms:** `tools/cala-eval/motion_bias_ab.sh` runs the raw-frame arms and `tools/cala-eval/motion_ff_gain.sh`
  runs the `front` and `ff` arms. Both write per-seed rows to `<arm>_scores.tsv` in the run directory.

**Input paths** (`motion_eval`'s new `MOTION_FRONT`):

- **raw:** 8-bit frames straight in (motion_eval's old default).
- **front:** the preprocessor's front half with the FOV mask (`MOTION_FRONT=1`).
- **ff:** front plus the online flat field with qc_eval's settings (`MOTION_FRONT=ff`).
  - For the non-rigid run, `ff` reproduces qc_eval's `motion.tsv` on `v3_motion_s5` to 0.0000 px RMS.

Table values are the mean over seeds and both axes, with the range over seeds × axes in brackets.

| input path, envelope      | rigid RMS, px       | rigid mean \|e\|, px | rigid p95 \|e\|, px | rigid gain          | patch RMS, px       |
| ------------------------- | ------------------- | -------------------- | ------------------- | ------------------- | ------------------- |
| raw, shipped              | 0.044 [0.036–0.053] | 0.035 [0.028–0.041]  | 0.088 [0.071–0.111] | 0.998 [0.994–1.001] | 0.108 [0.095–0.129] |
| raw, no envelope          | 0.044 [0.036–0.053] | 0.035 [0.028–0.041]  | 0.088 [0.071–0.111] | 0.998 [0.994–1.001] | 0.106 [0.094–0.127] |
| front, shipped            | 0.045 [0.038–0.055] | 0.036 [0.030–0.042]  | 0.090 [0.075–0.115] | 1.001 [0.997–1.010] | 0.107 [0.096–0.123] |
| **ff, shipped (app/qc)**  | 0.071 [0.066–0.079] | 0.056 [0.051–0.062]  | 0.142 [0.130–0.158] | 1.041 [1.031–1.058] | 0.124 [0.115–0.139] |
| ff, no envelope (s5 only) | 0.070               | 0.055                | 0.144               | 1.046               | 0.117               |

**Envelope on vs off.**

- The rigid shifts differ frame by frame by 0.0012–0.0015 px RMS (max 0.010 px, mean difference ≤ 0.0005 px) on
  every seed.
- On s5 with the flat field on, the two arms agree to 0.0005 in gain and 0.0002 px in RMS.

**Patches.**

- The error is dominated by the field's own estimation noise: the estimated residual correlates about 0.78 with
  the true one.
- The residual gain (each patch minus the frame's patch mean) is under 1:
  - 0.83 with the default shrinkage, which is by design;
  - 0.94 with smoothing and shrinkage off (`MOTION_ALPHA=1 MOTION_NOSHRINK=1`).
- The envelope moves the raw residual gain towards 1 (0.92 → 0.94) and costs 0.0015–0.002 px of patch RMS. Neither
  is meaningful next to the 0.10 px patch error.

**Session alignment** (`probes/zz_probe_session.rs`).

- Band-passed means of `v3_static_s5` and the workshop recording, shifted by known sub-pixel amounts with
  `SessionWarp`, rotation off.
- With the envelope: error ≤ 0.015 px on the sim, and ≤ 0.048 px at a 30 px shift on the workshop mean
  (gain ≤ 1.002).
- Without the envelope: ≤ 0.084 px (gain 0.997).

## 4. The online flat-field gain

Rigid gain (dy, dx) per 1200-frame block (`blocks_1200.tsv`; `motion_bias.py --blocks 1200`). The first map is
applied at frame 3000.

| seed | arm   | 0–1.2k      | 1.2–2.4k    | 2.4–3.6k    | 3.6–4.8k    | 4.8–6k      | 6–7.2k      | 7.2–8.4k    | 8.4–9.6k    |
| ---- | ----- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| s5   | front | 1.001 1.009 | 1.007 0.998 | 1.000 1.007 | 1.010 0.999 | 1.003 1.011 | 0.998 1.004 | 1.008 0.997 | 1.005 1.005 |
| s5   | ff    | 1.001 1.009 | 1.007 0.998 | 1.031 1.031 | 1.057 1.045 | 1.064 1.069 | 1.061 1.067 | 1.073 1.059 | 1.073 1.072 |
| s6   | ff    | 1.014 1.014 | 0.999 1.001 | 1.023 1.022 | 1.046 1.046 | 1.044 1.063 | 1.064 1.045 | 1.058 1.062 | 1.054 1.071 |
| s7   | ff    | 1.003 1.002 | 0.986 0.991 | 1.038 1.018 | 1.042 1.039 | 1.055 1.046 | 1.061 1.056 | 1.061 1.069 | 1.079 1.064 |
| s8   | ff    | 0.991 0.997 | 1.001 0.996 | 1.027 1.020 | 1.043 1.038 | 1.061 1.040 | 1.079 1.049 | 1.057 1.060 | 1.063 1.053 |
| s9   | ff    | 1.016 1.009 | 1.009 1.003 | 1.040 1.020 | 1.045 1.036 | 1.088 1.046 | 1.097 1.054 | 1.091 1.059 | 1.096 1.067 |

**Findings.**

- `front` stays at 0.99–1.02 in every block of every seed.
- `ff` matches `front` until the first map and then rises steadily. By the last block it is 1.05–1.10: a
  4–5 px excursion from the template position is read 0.2–0.5 px too long.
- The learned map on s5 (qc_eval's `flat_field_updates.tsv`) has a gain sd of 0.013–0.014 and a tissue sd of
  0.059–0.062.

**Mechanism: not established.** Two leads, neither tested:

- The `2026-11-11-flat-field-default.md` note lists "rebuild the motion template after the first map" as open
  work. The warm-up template is built before any map and stays pinned while the frames are flat-fielded.
- The flat field is learned from the corrector's own shifts, so a shift bias could feed back into the map.

Registration error with the flat field on was not measured when it became the default: that note reports
P8/R8 and S8 only.

## 5. Real data: the workshop recording

`motion_eval real` on the workshop recording (read-only; 600 × 600 px, 23,711 frames, auto region 360 × 360 px). No
ground truth, so the arms are compared with each other (`workshop/<arm>/`). The reference passed to `real` is a dummy
and the lines it produces are meaningless.

**Envelope on vs off, raw frames.**

| run       | crispness of the mean corrected frame, envelope / none | rigid shift difference (dy, dx), envelope − none              |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| rigid     | 0.9007 / 0.9008                                        | mean (−0.003, +0.004) px, RMS (0.005, 0.005) px, max 0.025 px |
| non-rigid | 0.9211 / 0.9211                                        | mean (−0.003, +0.004) px, RMS (0.005, 0.005) px, max 0.033 px |

The shift traces (sd 0.9 / 1.1 px, range 7 / 9 px) correlate 0.99999 between arms. The two estimators are
interchangeable on real data too.

**Online flat field on vs off** (the preprocessor's front half with the FOV mask, `MOTION_FRONT=ff` vs `=1`,
settings at 20 fps as in qc_eval's default; `workshop/{front,ff}/`). Slope is the `ff` rigid shift regressed on
the `front` one per block of 4500 frames. The first map is applied at frame 3000.

| frames      | slope (dy, dx) | RMS difference (dy, dx), px |
| ----------- | -------------- | --------------------------- |
| 0–4500      | 1.016, 1.050   | 0.225, 0.199                |
| 4500–9000   | 1.121, 1.109   | 0.133, 0.157                |
| 9000–13500  | 1.103, 1.117   | 0.110, 0.145                |
| 13500–18000 | 1.102, 1.113   | 0.094, 0.142                |
| 18000–23711 | 1.106, 1.121   | 0.097, 0.149                |

On real data the flat-field arm reads shifts about 11 % larger than the arm without it, and the traces differ by
0.1–0.15 px RMS. This is larger than on the sims. With no ground truth, it is ambiguous which arm is right:

- the flat field may be removing a real static sensor pattern that pulls the plain arm towards zero;
- or it may be overshooting as it does on the sims.

Crispness is not comparable across these two arms, because the flat field rescales the image (0.78 vs 0.57).

## 6. Decision and what the PR changes

The envelope's end-to-end effect is nil, so the estimator stays as it is. Nothing cala computes changes, so no
qc_eval quality runs were made; static and motion sims are unaffected byte for byte. The flat-field gain is a
separate subsystem and is left for its own task.

The PR:

- **`xcorr_recovers_shift`.**
  - The tolerance becomes `0.8 + 0.35 |s|` per axis instead of 1 px, with a comment on the gain.
  - It was sized from 20 000 random cases of the test's own strategy: worst error 1.28 px, and 0.64 px beyond
    `0.35 |s|`.
- **`motion_proptest.proptest-regressions`.**
  - Holds the failing seed `cc 943070ef…`.
  - The unmodified test fails on it deterministically (dx 4.23 vs 3.21); the new test passes.
- **`xcorr_exact_on_texture` (new).**
  - Smooth window-filling plane-wave texture (40–80 waves up to 0.1 cycles/px), shifts ±4 px, tolerance
    `0.1 + 0.02 |s|`.
  - Worst of 20 000 random cases with the envelope: 0.069 px beyond `0.02 |s|`.
  - Without the envelope, 3 % of axes fail over 2000 cases, so a 64-case run almost always fails. Checked: it
    fails.
- **`xcorr.rs` module docs** describe the limitation and what keeps it out of the corrector.
- **`motion_eval`.** `MOTION_FRONT` (`1`, `fov`, `ff`) feeds the corrector like qc_eval and the app. In `minisim`
  mode, `MOTION_SAVE` writes the rigid shifts and the patch-centre displacements with the truth.
- **New tooling:** `tools/cala-eval/motion_bias.py`, `motion_bias_ab.sh` and `motion_ff_gain.sh`.

**Proptest runs.**

- `PROPTEST_CASES=3000`, run three times (twice more after the comment edits): all 7 properties pass.
- `PROPTEST_CASES=30000` once for the correlator properties: pass.
- `cargo test --release` for the whole crate: pass.

## Open questions

- **Flat-field gain (the main one).** With the online flat field on, cala's rigid shifts on the motion sims have a
  growing gain, 1.03–1.06 over the run and up to 1.10 late in it, and about 1.6x the registration error. Should
  this be investigated as its own task?
  - First checks: rebuild the template after each map, and measure whether the gain also appears on a sim with a
    real sensor pattern (the `fpn` arm).
  - It also affects how every motion-arm qc_eval result since #330 should be read: their GT offset estimate absorbs
    a constant offset, not a gain.
  - On the workshop recording the flat-field arm reads shifts about 11 % larger than the plain arm (0.1–0.15 px RMS
    apart). Without ground truth it is open which arm is right there.
- **A principled envelope.** An estimator that is right for both kinds of content exists: normalise by the windowed
  _content_ overlap (`Σ w(p) w(p−u) a(p)²` and the same for the moving image), at two more FFTs per frame.
  - It buys nothing measurable in cala today.
  - It would matter only if the correlator is ever used single-shot on sparse content, such as small patches with
    few cells or a finer non-rigid grid.
- **Patch residuals before shrinkage** come out at about 0.94 of the true field. That is estimation noise and
  regularisation, not this bias.
