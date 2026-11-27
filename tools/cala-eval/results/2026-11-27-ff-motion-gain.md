# Flat-field motion gain: the solve's integer-shift model leaked tissue into the gain

27 Nov 2026. Branch `fix/cala-ff-motion-template` (rebased on main `6fe2ede6`). Raw data, scripts, logs:
`~/Projects/cala-data/runs/ff-motion-gain/`. Follows `2026-11-26-motion-xcorr-bias.md` §2, which found that
with the online sensor flat field on (the app's and qc_eval's default with motion since #330) the rigid
registration gain is ~1.04 overall and 1.05–1.10 late in the recording.

All numbers: mean ± 95 % t interval over seeds 5–9 (n = 5), paired per seed where marked. Gain = slope of the
registering shift on the true content motion (1 = unbiased); "late" = frames 6000–9600, "early" = 0–3000 (before
the first map). Registration runs are `motion_eval minisim` rigid-only on the app's input path
(`MOTION_FRONT=ff`), scored with `motion_ff_score.py` and `motion_bias.py --blocks 1200`.

## Verdict

**The flat field's dither solve modelled every shift bin at its integer shift. The frames in an outer bin
actually sit on average 0.06–0.2 px closer to the centre (the sub-pixel spread of a ~1 px dither). The misfit
`δ·∇t` has the same sign in every bin, and the gain map absorbed it as a copy of the tissue's fine structure,
fixed to the sensor. Divided out, that copy pushes registration away from the template position: gain > 1.
Modelling each bin's mean sub-pixel offset to first order (`L_s = g + t(x+s) + δ_s·∇t(x+s)`) removes it:
late gain 1.065 → 1.003 on the motion sims, RMS error 0.071 → 0.048 px (no flat field: 0.045).**

- The fix is in `DitherFlatField` (`crates/cala/src/preprocess/flatfield.rs`); signatures are unchanged, so the
  app and qc_eval both get it.
- The fix removes the source term, not the solve's sensitivity to biased input shifts (§2): on the v3 motion
  sims a registration-gain error fed in from outside comes back at about half size. The loop contracts to 1.00.
- On sims with a sensor pattern (PRNU 2.4 %, column FPN, hot pixels; §3), registration error improves a little
  and the learned PRNU is unchanged. The fix's late gain is 0.987, main's 1.000. The no-sensor twin of those
  sims shows why: there main's leak is +.012 (smaller on the v2 tissue than on v3) and the fix matches no flat
  field. On fpn the same +.013 leak in main offsets a residual sensor pull (no flat field 0.944, fix 0.987)
  that both builds share.
- Stored maps from shipped versions (v2.13.0 – v2.23.x) carry the leak. The app's per-device cache now has a
  solve version, so those maps are not reused (§5).

## 1. Cause and fix (motion sims, no sensor pattern)

| arm (v3_motion, rigid) |         RMS px |         p95 px |           gain |      gain late |
| ---------------------- | -------------: | -------------: | -------------: | -------------: |
| no flat field          |  .0451 ± .0057 |  .0899 ± .0123 | 1.0014 ± .0038 | 1.0015 ± .0045 |
| flat field, main       |  .0708 ± .0053 |  .1418 ± .0096 | 1.0414 ± .0067 | 1.0649 ± .0093 |
| flat field, fix        |  .0475 ± .0065 |  .0937 ± .0134 | 1.0029 ± .0060 | 1.0025 ± .0062 |
| _paired fix − main_    | −.0233 ± .0046 | −.0481 ± .0107 | −.0385 ± .0027 | −.0624 ± .0046 |
| _paired fix − no ff_   | +.0024 ± .0010 | +.0038 ± .0020 | +.0015 ± .0024 | +.0011 ± .0031 |

By block of 1200 frames, main's gain rises from 1.00 to 1.06–1.10 after the first map (frame 3000) and is still
climbing at frame 9600; the fix stays at 0.99–1.03 in every block of every seed.

How the cause was isolated (main build plus the diagnostic knobs in `motion_eval`):

- **Not the template.** `fixed` (main's final map applied from frame 0, so the warm-up template is built with
  it): gain 1.0721 ± .0113 already in frames 0–3000. A template rebuild would not help.
- **Leak, not feedback.** `plainfed` (estimator fed the no-flat-field run's unbiased shifts): late gain
  1.0506 ± .0086 vs 1.0649 self-fed. Feedback adds a little; the map itself is the driver.
- **Not the warm start.** Cold 30-iteration solves give the same maps.
- **The map holds tissue.** Learned log-gain on `v3_motion_s5` (the sims have no sensor pattern, so the true map
  is flat): correlation with the tissue's DoG +0.41 (main) → +0.12 (fix).
- **Prototype** (`scripts/als_proto.py`): with gain-free frames and continuous shifts the integer model leaks
  sd .0038 (corr .94 with tissue), .0081 at 0.5 px dither; bin means + bilinear shift barely help; first-order
  Taylor with a 5-point gradient leaves ~.001.
- `fixfixed` (the fix's final map from frame 0): gain 1.0052 ± .0073, late 1.0045 ± .0065; paired vs
  `fixed` −.0653 ± .0040.

## 2. Restoring force: the estimator fed biased shifts

The flat field bins frames by the registration's own shifts, so a gain error in those shifts feeds back into
the map. Arms feed the estimator fixed shift series instead (`MOTION_FF_SHIFTS`); registration still runs on the
divided frames.

| fed shifts                       | main: late gain − no ff (paired) | fix: late gain − no ff (paired) |
| -------------------------------- | -------------------------------: | ------------------------------: |
| plain (no-ff run, gain ~1.00)    |                   +.0491 ± .0042 |                  +.0003 ± .0022 |
| plain × 1.05                     |                   +.0721 ± .0038 |                  +.0272 ± .0018 |
| fix's ×1.05 output (gain ~1.027) |                                  |                  +.0090 ± .0028 |

- **Offset**: with unbiased shifts the fix leaves no excess (+.0003); main leaves +.049.
- **Sensitivity** k = late-gain excess per unit of fed scale error: fix .54 ± .02 (paired fixfed105 −
  fixplainfed .0269 ± .0009 per .05), main .46 ± .02. The fix does not change it: any solve that trusts the
  shifts copies tissue when they are mis-scaled (fixfed105's map: DoG corr .24, between the fix's .12 and
  main's .41).
- **The loop contracts.** 5 % in → 2.7 % out → 0.9 % out on the next step (`fixrefed`); fixfed105's by-block
  gain plateaus from the 4th block. With k ≈ 0.5, an outside gain bias b is amplified to about b / (1 − k) ≈ 2b
  in closed loop. That is a limitation, not something this PR changes.
- Projection only: main's implied fixed point is ~1 + .049 / (1 − .46) ≈ 1.09, and its by-block gain is still
  rising at 9.6k frames. Long recordings on shipped versions are probably worse than the 1.065 measured here.

## 3. Sims with a sensor pattern (`fpn` arm)

`ca1_workshop_v2_fpn.spec.json` (PRNU sd 2.4 %, column FPN sd 1 grey level, 0.058 % hot pixels, same motion
model as v3_motion), seeds 5–9, generated for this work. Truth from `export_gt_nonrigid.py --prnu`.

| arm (fpn, rigid)      |         RMS px |           gain |    gain early |      gain late |
| --------------------- | -------------: | -------------: | ------------: | -------------: |
| no flat field         |  .1318 ± .0140 |  .9509 ± .0143 | .9539 ± .0138 |  .9444 ± .0195 |
| flat field, main      |  .1304 ± .0131 |  .9897 ± .0119 | .9539 ± .0138 | 1.0003 ± .0163 |
| flat field, fix       |  .1284 ± .0133 |  .9807 ± .0111 | .9539 ± .0138 |  .9871 ± .0152 |
| _paired fix − main_   | −.0020 ± .0009 | −.0090 ± .0011 |             0 | −.0131 ± .0014 |
| main, fed true shifts |  .1305 ± .0134 |  .9910 ± .0109 |               | 1.0012 ± .0151 |
| fix, fed true shifts  |  .1286 ± .0135 |  .9829 ± .0101 |               |  .9894 ± .0141 |

**No-sensor twin.** The v2 `motion_s5..9` sims have exactly the fpn spec minus `sensor_defects` (same seed,
tissue, motion; checked). Rigid, same builds:

| arm (v2 motion, no sensor pattern) |         RMS px |      gain late |
| ---------------------------------- | -------------: | -------------: |
| no flat field                      |  .1271 ± .0123 |  .9920 ± .0148 |
| flat field, main                   |  .1302 ± .0123 | 1.0055 ± .0170 |
| flat field, fix                    |  .1279 ± .0125 |  .9931 ± .0158 |
| _paired fix − main_                | −.0023 ± .0010 | −.0124 ± .0014 |

- Main's leak is +.012 on the v2 tissue (vs +.06 on v3, whose spec differs in cell size and density, neuropil and photon count), and the fix removes it
  (fix − no flat field +.001). Main's map differs from the fix's by sd .0014 here and .0015 on fpn: the same
  small effect. So on fpn the fix removes the same leak, and main's 1.000 is that +.013 leak sitting on top of a
  residual sensor pull both builds share.
- Without a flat field the sensor pattern pulls registration towards zero shift: gain 0.944 late. The flat
  field removes about three quarters of that pull (fix 0.987). What is left is not identified (hot pixels,
  column FPN or the map error below are candidates). Feeding the estimator the true shifts changes neither
  build (≤ .002), so it is not the shift loop. The sensitivity k of §2 was measured on v3 and does not apply
  here: on fpn the shift source hardly matters.
- Learned map vs truth (`ff_map_score.py`, high-passed σ 8 px, hot/stuck pixels excluded, per-column medians
  removed from map and tissue reference with `--destripe`): PRNU correlation .907 ± .036 (main) and .909 ± .036
  (fix), paired +.0014 ± .0003. Both maps overshoot PRNU (regression slope 1.33), and their residual
  correlates with the tissue (r .44 main, .39 fix; paired −.046 ± .007). Both are unexplained and shared by
  the two builds; not addressed here. Without `--destripe` the PRNU correlation is .79 and the tissue r .53.

## 4. End-to-end qc_eval and real data

`qc_eval sim` built from main `6fe2ede6` and from this branch, `run_arms.py ... -- --batch 8 --budget 30000000
--slow-seed 1` (flat field `online`, the default with motion), seeds 5–9, paired by `summarize.py` (primary P8,
pre-declared). Raw: `runs/ff-motion-gain/qc/`, `qc_v3.md`, `qc_fpn.md`.

| arm       | P8 main → fix |         d P8 |         d R8 |    d cells | registration RMS px main → fix | late gain main → fix |
| --------- | ------------- | -----------: | -----------: | ---------: | ------------------------------ | -------------------- |
| v3_motion | .918 → .918   | −.001 ± .008 | −.003 ± .004 | −2.4 ± 7.2 | .0708 → .0475                  | 1.065 → 1.003        |
| fpn       | .921 → .924   | +.003 ± .010 | +.004 ± .007 | +0.8 ± 7.2 | .1304 → .1284                  | 1.000 → .987         |

- qc_eval's own registration (`motion.tsv`) matches the `motion_eval` arms above to the fourth decimal, so the
  registration gain is the same on qc_eval's path.
- P8 (primary), R8, cells and the AUCs move within their CIs on both arms. On v3_motion R8 is lower on 5/5
  seeds by .003 (CI covers 0).
- Observed and unexplained: on v3_motion the held-out score's rank correlation with true positives drops
  (`rho_Sf_TP` −.054 ± .030, 5/5 seeds; `rho_S_TP` −.040 ± .059); on fpn it does not (−.004 ± .016). `S8`
  falls by ~290 on both arms (5/5 seeds).
- Cost: qc_eval wall time is the same (main/fix 259/260 s on v3_motion_s5, 240/239 s on fpn_s5, similar on the
  rest).
- Registration error on these sims is small next to the cell size (~10 px), so a 0.02 px RMS change was not
  expected to move detection much; the gain matters more for long recordings (§2 projection).

**Workshop recording** (`prerecorded/raw`, 23,711 frames, input read-only). There is no truth, so the
comparison is the slope of the flat-field arm's rigid shifts on the no-flat-field arm's, frames 3000–end:

|      |    dy |    dx |
| ---- | ----: | ----: |
| main | 1.047 | 1.125 |
| fix  | 0.981 | 1.078 |

The no-flat-field reference is not unbiased when the sensor has a pattern. Calibration on the fpn sims, where
truth is known: the same slope (flat-field arm on no-flat-field arm, frames 3000–end) is 1.063 / 1.055 (dy /
dx) for main and 1.048 / 1.041 for the fix, while their true late gains are 1.000 and 0.987. The workshop
sensor's learned gain sd (6.3 %) is larger than the sims' PRNU (2.4 %), so its pull is probably larger too.

Unresolved: the fix's workshop dy slope is 0.981, below 1, where the sims would predict above 1, and dx is
1.078. Without truth for this recording these numbers cannot say which axis is right. The fix moves both axes
down by 0.05–0.07, the size of the leak it removes on v3.

## 5. Stored maps (app cache)

The app keeps the last map per device in IndexedDB (`apps/cala/src/lib/flat-field-cache.ts`) and seeds the next
run of that device with it from frame 0. Maps from shipped versions carry the leak (the `fixed` arm, main's final
map from frame 0, gives gain 1.07 from the first frame). Records now carry `solver: FLAT_FIELD_SOLVER_VERSION`
(2); `recordFits` rejects any other or missing version, so a stale map is ignored, the run estimates fresh, and
the first write replaces it. No other path loads a stored map (exports write maps but nothing reads them back;
look-back and provenance only pass the current run's map). Test: `flat-field-store.test.ts`, "does not apply a
stored map of an older solve version".

## Tests

- `flatfield::subpixel_tests::subpixel_dither_leaves_no_tissue_in_the_gain`: gain-free frames, continuous
  shifts; the map must not correlate with the tissue (main: r .98, sd .0146 → fails; fix: r .25, sd .0010).
- `flatfield::subpixel_tests::subpixel_dither_recovers_sensor_gain`: a known sensor gain under the same dither
  (main: gain r .76, tissue r .64 → fails; fix: .996 / .02).
- `cargo test --release` (crate), clippy (jsbindings, pybindings, diagnostics, `-D warnings`), `cargo fmt
--check`, `apps/cala` vitest.

## Tooling added

- `motion_eval` knobs: `MOTION_RIGID_ONLY`, `MOTION_FF_OUT` (save every map), `MOTION_FF_FIXED` (apply a stored
  map from frame 0), `MOTION_FF_SHIFTS` (feed the estimator a shift series), `MOTION_FF_COLD`.
- `motion_ff_score.py` (gain/error tables with paired CIs), `ff_map_score.py` (learned map vs true PRNU and
  tissue), `export_gt_nonrigid.py` (motion truth, `--prnu` for sensor patterns), `ff_motion_arms.sh` (the arms).
