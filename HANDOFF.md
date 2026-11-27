# HANDOFF: flat-field motion gain (27 Nov 2026)

Worktree `/Users/daharoni/Projects/CaLab-wt-ffmotion`, branch `fix/cala-ff-motion-template` (from origin/main 0e5c3619), pushed as WIP.
Raw outputs: `~/Projects/cala-data/runs/ff-motion-gain/` (scores_ff_fix.md, scores_mech.md, scripts/, bin/).

## Order of operations (code)
- Per frame (motion_eval `MOTION_FRONT=ff`, qc_eval, app): raw -> `Preprocessor::front` (flat field divides the raw first, if a map is set) -> `MotionCorrector::process` -> rigid shift -> `OnlineFlatField::push(raw, shift)` (bins the RAW frame by round(shift)) -> every 1200 frames (first at 3000) `refine()` -> new map applied to the preprocessor.
- Template (`corrector.rs`): warm-up template on the first 200 front-half frames (no map yet); running template tau=400 updated from corrected frames; `refresh_spectra` pins it to the warm-up template t0 (drift), every 20 accepted frames.

## Cause (settled on sims)
NOT the template. The flat-field solve (`DitherFlatField::solve_from`) modelled every shift bin at its integer shift; the frames in an outer bin sit on average 0.06–0.2 px closer to the centre (sub-pixel spread of a ~1 px dither). The misfit `δ·∇t` with `s·δ < 0` in every bin is absorbed by the gain as a copy of the tissue's fine structure (learned map on v3_motion_s5: corr +0.36 with hp tissue, +0.41 with its DoG; sims have NO sensor pattern). Divided out, that fixed tissue copy repels registration from the template position -> gain > 1.
Evidence:
- `fixed` arm (main's final map applied from frame 0, template built WITH the map): gain 1.075 from frame 0 (s5,s6) -> template rebuild would not help.
- `plainfed` (estimator fed the plain arm's unbiased shifts): late gain 1.047 vs 1.062 self-fed -> feedback adds a bit, leak is the driver.
- `cold` (cold 30-iteration solves) = warm: no difference.
- numpy prototype (`scripts/als_proto.py`): gain-free frames, continuous shifts: integer model leak sd .0038 corr .94 (sd .0081 at 0.5 px dither); bin-mean + bilinear barely helps (bilinear blur); bin-mean + Fourier exact -> 0; first-order Taylor with 5-point gradient -> ~0 (.001 floor).

## Fix (implemented, in commit)
`crates/cala/src/preprocess/flatfield.rs`: per-bin accumulator `resid` of the sub-pixel residuals (same weights as counts, included in the 1e100 rescale); solve models `L_s(x) = g(x) + t(x+s) + δ_s·∇t(x+s)` (δ_s = bin mean residual, ∇t 5-point where defined, `gradient()` helper), in the t-update, g-update and misfit. Signatures unchanged (app/qc_eval inherit it). No serialized estimator state exists (checked js.rs).
Tests: new module `subpixel_tests` — `subpixel_dither_leaves_no_tissue_in_the_gain` (main: r .98 sd .0146 -> fails; fix: r .25 sd .0010) and `subpixel_dither_recovers_sensor_gain` (main: gain r .76, tissue r .64 -> fails; fix .996/.02). `cargo test --release --lib flatfield` passes (8). Full crate test suite NOT yet run.

## Numbers (v3_motion_s5..s9, rigid, mean ± 95 % t CI over seeds; motion_ff_score.py)
| arm | RMS px | p95 | gain | gain early (0–3k) | gain late (6k–9.6k) |
|---|---|---|---|---|---|
| front (no ff) | .0451 ± .0057 | .0899 | 1.0014 ± .0038 | 1.0026 | 1.0015 ± .0045 |
| ff main | .0708 ± .0053 | .1418 | 1.0414 ± .0067 | 1.0026 | 1.0649 ± .0093 |
| ff fix | .0475 ± .0065 | .0937 | 1.0029 ± .0060 | 1.0026 | 1.0025 ± .0062 |
Paired fix − front: RMS +.0024 ± .0010, gain +.0015 ± .0024 (late +.0011 ± .0031). Learned map on s5: tissue corr .36 -> .11.

## Unfinished / next steps
1. Restoring-force test (advisor): `scripts/arms.sh fixfed105 5 6 7 8 9` and `mainfed105` (estimator fed plain shifts ×1.05; inputs in `scaled105/`) — does the fix relax gain to 1.00? Also `fixfixed` (fix's final map from frame 0). `fixed`/`plainfed` only have s5–s6 (s5–s7 for plainfed); rerun `arms.sh fixed 7 8 9`, `arms.sh plainfed 7 8 9` (script skips finished seeds). Two jobs at a time, ~1 min, 0.8 GB each.
   Binaries: `bin/motion_eval_diag` = main + diag knobs, `bin/motion_eval_fix` = fix. Rebuild: `cd crates/cala && CARGO_TARGET_DIR=~/Projects/cala-data/target-ffmotion cargo build --release --example motion_eval`.
2. fpn arm: `~/Projects/cala-data/sims-fpn/fpn_s5` generated (v2 fpn spec, committed); s6–s9 still to generate: `source ~/Projects/cala-data/sims.env; $MINISIM_PY tools/cala-eval/gen_sims.py --sims ~/Projects/cala-data/sims-fpn --arms fpn --seeds 5-9 --parallel 1` (≈55 s, 2.3 GB each). Export GT: `$MINISIM_PY -I tools/cala-eval/export_gt_nonrigid.py <sim> <out>/gt/<sim> --prnu` (also dumps the sensor pattern if the zarr has it). Then motion_eval front/ff(main)/fix arms on fpn (score vs truth only), score learned map vs true PRNU, watch by-block gain across frame 3000 (`motion_bias.py --blocks 1200`).
3. End-to-end qc_eval: build qc_eval on main and branch into `tools/cala-eval/bin/` (name must contain qc_eval), `run_arms.py --bin main=... --bin fix=... --sims $CALA_SIMS_V3 --arms v3_motion --seeds 5-9 -- --batch 8 --budget 30000000 --slow-seed 1` (check current standard flags), plus fpn arm; `summarize.py`. Workshop: `motion_eval real /Users/daharoni/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw <zero_ref>` with MOTION_FRONT=1 vs ff on fix (READ-ONLY input; see runs/motion-xcorr-bias/workshop/run.sh) — compare ff-vs-front slope (main: ~1.11).
4. Open: cached seed maps (`apps/cala/src/lib/flat-field-cache.ts`, no version key) made by shipped versions carry the leak and are applied from frame 0 with a 2 h decay — consider a version bump. Long-recording behaviour (no long motion sim).
5. Write `tools/cala-eval/results/2026-11-27-ff-motion-gain.md`, run full `cargo test --release` + clippy + fmt, open ready-for-review PR (do not merge).

New tooling in commit: motion_eval knobs `MOTION_RIGID_ONLY`, `MOTION_FF_OUT`, `MOTION_FF_FIXED`, `MOTION_FF_SHIFTS`, `MOTION_FF_COLD`; `tools/cala-eval/motion_ff_score.py`, `tools/cala-eval/export_gt_nonrigid.py`.

## Progress 27 Nov (second agent)
- Rebased onto origin/main 6fe2ede6 (clean). Binaries rebuilt; fix rerun s5 identical (max diff 0).
- Step 1 done (5 seeds, `runs/ff-motion-gain/scores_restoring.md`, `scores_refed.md`): fixplainfed − front late +.0003 ± .0022 (offset gone); sensitivity k = late gain excess per fed scale error: fix .54 ± .02, main .46 ± .02; fixrefed (fed fixfed105's output) +.0090 ± .0028 vs fixfed105 +.0272 → loop contracts. Map DoG corr: fix .12, fixfed105 .24, main .41.
- Cache version: committed f8e08b13 (`FLAT_FIELD_SOLVER_VERSION = 2`, recordFits requires it; test added). Only the IndexedDB cache loads stored maps (checked export/lookback/provenance).
- Workshop (READ-ONLY input, `runs/ff-motion-gain/workshop/{main,fix}`): slope vs front after frame 3000: main dy 1.047 dx 1.125, fix dy .981 dx 1.078. NOTE front is NOT truth on real data: on fpn sims front gain is .951 (sensor pattern pulls registration to 0).
- fpn (`runs/ff-motion-gain/fpn/`, `scores_fpn.md`, `scores_fpn_map.md`): gain late front .944, ff 1.000, fix .987 (paired fix − ff −.013 ± .0014); RMS fix − ff −.0020 ± .0009. Maps nearly identical ff vs fix (PRNU r .79, slope 1.33, residual tissue r .53 both). Running fftruth/fixtruth (estimator fed true shifts) to see whether the fpn tissue residual comes from the sensor-pulled shifts.
- qc_eval binaries built: tools/cala-eval/bin/qc_eval-main-6fe2ede6, qc_eval-fffix-f8e08b13 (not run yet).
- fmt + clippy (js/py/diagnostics) clean; apps/cala npm test 1269 pass.
