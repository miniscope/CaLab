# Motion correction: the cross-correlation gain bias

26 Nov 2026. Branch `test/motion-xcorr-bias` (from main `c380b6b3`). Raw data, probes and logs:
`~/Projects/cala-data/runs/motion-xcorr-bias/`.

## Verdict

**The bias is real in the bare estimator but does not reach cala. No behaviour change.**

- `Correlator::register` divides the correlation by the Tukey window's overlap envelope. That division is exact
  for texture that fills the window. It over-corrects content sitting in the window's flat middle, so the shift
  reads too large on such content.
- cala's registration never sees this. The corrector correlates band-passed frames that fill the region and
  re-cuts the crop at the integer estimate, so the final residual is under a pixel.
- End to end on the five v3 motion sims, the rigid shift's gain is 0.994–1.001 and its RMS error 0.04–0.05 px.
  Switching the envelope division off moves the rigid shifts by about 0.001 px RMS and leaves the error unchanged.
- The flaky proptest `xcorr_recovers_shift` was testing the estimator on exactly the content it over-corrects,
  with a fixed 1 px tolerance. This PR gives it a tolerance that grows with the shift, documents why, and adds the
  failing seed to the regressions file. A new tight property, `xcorr_exact_on_texture`, checks the case the
  envelope exists for and fails if the division is removed.

## 1. Cause

The probe (`probes/zz_probe_xcorr.rs` in the run directory; probes are not in the repo) registers a 64 × 64 image onto a shifted copy of itself, both drawn
analytically (no interpolation), Tukey α = 0.3, upsample 10. "No envelope" is a probe-only build with the division
switched off: `Correlator::new` replaces both window power spectra by a DC-only one when `XCORR_NO_ENV` is set, so
the envelope is 1 everywhere. The same build (`motion_eval_toggle`) runs the "no envelope" arms below;
`motion_bias_ab.sh` expects it.

| content                                                   | shift         |    envelope (shipped) |           no envelope |
| --------------------------------------------------------- | ------------- | --------------------: | --------------------: |
| one sigma-3 blob, centred                                 | 0.5 / 2 / 4   | 1.095 / 1.088 / 1.073 | 0.998 / 0.998 / 0.999 |
| 9 blobs clustered in the middle (failing seed's layout)   | x 0.5 / 2 / 4 |    1.92 / 1.44 / 1.30 |    0.93 / 0.96 / 0.97 |
| 64 blobs on a grid over the whole window (into the taper) | 0.5 / 2 / 4   | 0.996 / 0.990 / 0.984 | 0.975 / 0.969 / 0.965 |
| smooth plane-wave texture filling the window              | 0.5 / 2 / 4   | 0.994 / 0.998 / 1.003 | 0.955 / 0.961 / 0.969 |

Numbers are the estimated / true shift (gain).

Mechanism:

- With both images windowed, the expected correlation of a _stationary_ texture at lag `u` is its
  autocorrelation times the window's autocorrelation `A(u)`, which falls with `|u|` and drags the peak towards
  zero. Dividing by `A(u)` removes that, and the texture rows show it does (0.96 → 1.00).
- Content that sits only where the window is flat is not attenuated by the window at all, so there is nothing to
  remove. Dividing by `A(u)` then tilts the correlation surface upwards away from zero, and the peak moves outwards.
- The shift of the peak is roughly the correlation peak's curvature width squared times the slope of `1 / A`, so it
  is about the same _fraction_ of the shift at every lag for a lone blob (gain about 1.09), and much larger for a
  tight cluster, whose correlation peak is broad (1.3x at 4 px, and 0.5 px read as 0.96).
- It is not "large-lag amplification where the overlap is small": the gain is already 1.09 at 0.5 px.

The failing proptest seed (9 blobs at y ≈ 20–30, x ≈ 20–44, true shift (2.667, −3.207), read dx 4.24) is the
clustered case.

## 2. What cala uses

- **Rigid, the app and qc_eval.** `Engine::register` (`corrector.rs`) cuts the crop at the previous frame's
  integer shift, registers, and if the residual exceeds 0.75 px cuts again at the rounded estimate and registers
  once more (search ±2.5 px). The reported shift is `offset + residual`, so the envelope's gain acts only on a
  sub-pixel residual. The running template is pinned to the warm-up template through a template-on-template
  registration (`refresh_spectra`), which is near zero lag too.
- **Non-rigid patches (qc_eval, `NonRigidConfig::default()`, 4 × 4 grid of ~154 px patches).** Each patch is
  registered once, without a re-cut, starting from the rounded rigid shift (search ±3.5 px), then screened,
  smoothed over time and shrunk towards zero. The app runs rigid only (`MotionOptions` default `nonrigid: false`).
- **Session alignment** (`session.rs`) registers band-passed session means single-shot up to ±40 px, rounds a
  translation-only result to integers, and uses the sub-pixel fit only with a rotation.
- In all three, the correlated images are band-passed (DoG 1.5 / 15 px) frames or means that fill the region: the
  window-filling case, where the envelope is right.

## 3. End to end on the motion sims

`motion_eval minisim` on `sims-v3/v3_motion_s5..s9` (600 × 600 px, 9600 frames each, minisim rigid shifts with
sd ≈ 1 px and a 4 × 4 non-rigid field of RMS ≈ 0.5 px), default `MotionConfig`, warm-up on the first 200 frames.
Truth for the rigid shift is the mean true displacement over the 16 patch centres (the region sees the rigid shift
plus the mean of the field there, not minisim's rigid `shifts` alone; against the rigid `shifts` the RMS is
0.20 px, nearly all of it the field). The error is `−estimate − truth`, after removing its mean per axis (the
template's position is arbitrary). Gain is the slope of `−estimate` on truth. Scoring:
`tools/cala-eval/motion_bias.py`, arms run by `tools/cala-eval/motion_bias_ab.sh`.

Mean over seeds and both axes [range over seeds × axes]. "Raw" = patch smoothing and shrinkage off
(`MOTION_ALPHA=1 MOTION_NOSHRINK=1`). Per-seed rows: `<arm>_scores.tsv` in the run directory.

| quantity                      | envelope (shipped)  | no envelope         |
| ----------------------------- | ------------------- | ------------------- |
| rigid RMS error, px           | 0.044 [0.036–0.053] | 0.044 [0.036–0.053] |
| rigid p95 \|error\|, px       | 0.088 [0.071–0.111] | 0.088 [0.071–0.111] |
| rigid gain (slope)            | 0.998 [0.994–1.001] | 0.998 [0.994–1.001] |
| patch RMS error, px (default) | 0.108 [0.095–0.129] | 0.106 [0.094–0.127] |
| patch residual gain (default) | 0.83 [0.79–0.85]    | 0.81 [0.77–0.83]    |
| patch RMS error, px (raw)     | 0.107 [0.094–0.129] | 0.105 [0.093–0.127] |
| patch residual gain (raw)     | 0.94 [0.91–0.97]    | 0.92 [0.88–0.95]    |

Paired, frame by frame, the rigid shifts of the two arms differ by 0.0012–0.0015 px RMS (max 0.010 px, mean
difference ≤ 0.0005 px) on every seed.

- **Rigid (what the app uses):** RMS error 0.036–0.053 px, p95 0.071–0.111 px, gain 0.994–1.001 (mean 0.998).
  No gain bias: if anything the gain is a fraction of a percent _under_ 1, the opposite sign of the probe's
  over-estimate. Turning the envelope off changes the rigid shifts by about 0.001 px RMS and the error statistics
  not at all, because after the re-cut the residual is too small for either the pull or the over-correction to
  matter.
- **Patches:** the error is dominated by the field's own estimation noise (estimated residual correlates about
  0.78 with the true one). The residual gain is under 1 (0.83 with the default shrinkage, which is by
  design; 0.94 with smoothing and shrinkage off). The envelope moves the raw residual gain _towards_ 1
  (0.92 → 0.94) and costs 0.0015–0.002 px of patch RMS. Neither is meaningful next to the 0.10 px patch error.
- **Session alignment** (`probes/zz_probe_session.rs`, band-passed means of `v3_static_s5` and the workshop
  recording, shifted by known sub-pixel amounts with `SessionWarp`, rotation off): error ≤ 0.015 px on the sim and
  ≤ 0.048 px at a 30 px shift on the workshop mean (gain ≤ 1.002). Without the envelope: ≤ 0.084 px (gain 0.997).

### Real data: the workshop recording

`motion_eval real` on the workshop recording (read-only; 600 × 600 px, 23,711 frames, auto region 360 × 360 px),
default config, rigid and non-rigid, envelope on and off. No ground truth, so the arms are compared with each
other (`workshop/{env,noenv}/`; the reference passed to `real` is a dummy and its lines are meaningless).

| run       | crispness of the mean corrected frame, envelope / none | rigid shift difference (dy, dx), envelope − none              |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| rigid     | 0.9007 / 0.9008                                        | mean (−0.003, +0.004) px, RMS (0.005, 0.005) px, max 0.025 px |
| non-rigid | 0.9211 / 0.9211                                        | mean (−0.003, +0.004) px, RMS (0.005, 0.005) px, max 0.033 px |

The shift traces (sd 0.9 / 1.1 px, range 7 / 9 px) correlate 0.99999 between arms. The mean-image sharpness is the
same to the fourth digit. The two estimators are interchangeable on real data too.

## 4. Decision

The end-to-end bias is far below the 0.1 px / systematic-gain bar, so the estimator stays as it is. Since nothing
cala computes changes, no qc_eval quality runs were made (static and motion sims are byte-for-byte unaffected).
The PR:

- `xcorr_recovers_shift`: tolerance `0.8 + 0.35 |s|` per axis instead of 1 px, with a comment documenting the gain
  and the end-to-end numbers. Sized from 20 000 random cases of the test's own strategy: the worst error was
  1.28 px, and 0.64 px beyond `0.35 |s|`.
- `motion_proptest.proptest-regressions`: the failing seed `cc 943070ef…`. Checked first that the unmodified test
  fails on it deterministically (dx 4.23 vs 3.21); it passes with the new tolerance.
- `xcorr_exact_on_texture` (new): smooth window-filling plane-wave texture (40–80 waves up to 0.1 cycles/px), shifts
  ±4 px, tolerance `0.1 + 0.02 |s|`. Worst of 20 000 random cases with the envelope: 0.069 px beyond `0.02 |s|`.
  Without the envelope it fails 6 % of cases (the shipped 64-case run catches it nearly always; checked: it fails).
- `xcorr.rs` module docs: the limitation and why cala does not see it.
- `motion_eval minisim` writes the rigid shifts and the patch-centre displacements with `MOTION_SAVE`.

Proptest runs: `PROPTEST_CASES=3000` three times, all 7 properties pass; `PROPTEST_CASES=30000` once for the
correlator properties, pass.

## Open questions

- A principled estimator that is right for both kinds of content exists: normalise by the windowed _content_
  overlap rather than the window's own (`Σ w(p) w(p−u) a(p)²` and the same for the moving image, two more FFTs per
  frame). It would make the bare `Correlator` honest on sparse content, but buys nothing measurable in cala today
  and costs about 2x the correlation FFTs. Worth it only if the correlator is ever used single-shot on sparse
  content (e.g. small patches with few cells, or a finer non-rigid grid).
- Patch residuals come out at about 0.94 of the true field before shrinkage. That is estimation noise and the
  spline/median regularisation, not this bias, but it is the larger error in the non-rigid stage if that ever
  matters.
