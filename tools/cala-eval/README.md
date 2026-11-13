# cala-eval: paired multi-seed evaluation

Runs two (or more) `qc_eval` binaries over the same minisim recordings, one per
seed, and reports paired per-seed differences with t confidence intervals.
Design: sections 3.2 to 3.5 of the cala overhaul plan (not in the repo).

- `arms.py`: the sim arms. A new arm is a new entry in `ARMS` (spec file and
  flags). `halo`, `oof` and `fpn` use `ca1_workshop_v2_{halo,oof,fpn}.spec.json`
  in `tools/minisim-calibration/`; an arm whose spec file is missing is skipped.
  `v3_{static,motion}`, `size6_*` and `size16_*` use the `ca1_workshop_v3*.spec.json` specs
  (cells of 10, 6 and 16 px at the real recording's edge blur; `make_v3_specs.py`).
- `gt_scales.py`: half-max diameter and edge sigma (gradient and ring statistics) of the ground-truth
  footprints in `oracle.bin`. `arms.py` `GT_SCALES` holds the per-arm values and `SCALE_ARMS` the S2.4
  M0 one-at-a-time scale flags (`qc_eval --cell-diameter`, `--psf-sigma`, `--flatten-sigma`,
  `--tile-px`, `--margin-px`; `--bin K` bins a real recording).
- `fp_scales.py`: the S2.4 estimators D1 (median half-max diameter, order-statistic CI) and P1
  (radial-profile edge sigma per cell, population bound) on a run's `footprints.bin`; with
  `--final` and `--gt`, per matched cell against its ground-truth unit. Needs numpy.
- `probe_scale.py`: offline prototype of the S2.4 scale probe D0 (scale-normalised LoG on the
  first 400 frames of a recording). Needs numpy, scipy, OpenCV (the minisim venv has them).
- `recovery_vs_snr.py SIM RUN OUT.tsv`: per GT unit, minisim's matched-filter detection SNR (minisim >= 1.1) and whether a qc_eval run recovered it; the calibration data behind minisim's `DETECT_SNR_THRESHOLD` (`results/2026-11-12-matched-filter-detectable.md`).
- `export_gt_motion.py SIM...`: writes `<sim>/shifts.npy`, the sim's true rigid motion
  (`make_trace_sim.py` writes it for new recordings). `qc_eval sim|oracle --motion` needs it: cala
  registers to its warm-up template, which sits 1 to 3 px from the sim's tissue frame on the motion
  arms, so qc_eval measures that offset (cala's rigid records against the true shifts, frames
  `0..=--start`) and moves the GT footprints into cala's frame before scoring. The estimate is in
  `motion_offset.tsv`; `--gt-offset none` scores against the tissue frame (motion-arm numbers before
  13 Nov 2026). `qc_eval sim ... --rescore RUN` rescores an earlier `--churn-log` run's checkpoint
  footprints both ways (`rescore.tsv`) without running the loops
  (`results/2026-11-13-motion-offset.md`).
- `gen_sims.py`: generates `<sims>/<arm>_s<seed>` (600 px, 480 s, 9600 frames).
  Existing recordings whose `spec.json` is byte-identical to what the generator
  would write are symlinked (`--reuse <dir>`) instead of regenerated. At most 2
  generations at once (3 GB check on the first, stop above 6 GB). Run it with
  the pinned minisim venv python (`tools/minisim-calibration/README.md`).
- `run_arms.py`: the queue. At most 4 light `qc_eval sim` runs machine-wide, no
  start while free memory is below 5 GB, each run under `/usr/bin/time -l`
  (wall time and max RSS in `run.json`). Finished runs are skipped.
- `summarize.py`: the paired report (Markdown). Standard library only.
- `split_passes.py`: cuts a `qc_eval --passes N` run (repeated pass 1, S2.3;
  frames are virtual, `pass * frames + t`) into one run directory per pass
  (`<run>_pass<k>`), which `summarize.py` reads as ordinary runs. The held-out
  score is held out in pass 1 only. `qc_eval --later-passes MODE` (`refine`,
  `refine-prune`, `refine-merge`; default `all`) restricts the slow loop's
  edits in passes ≥ 2 (S2.3b, `results/2026-11-12-refine-only-passes.md`).
- `baseline_table.py`: per-arm mean and sd over seeds of one or more run trees
  (`main=<runs>/base [LABEL=DIR ...] [--arms ...]`); the reference numbers in
  `results/2026-11-baseline.md`.
- `seed_jaccard.py`: seed-to-seed reproducibility of two `qc_eval real` runs
  (`<runA> <runB> [--min-cos 0.5]`); needs numpy.
- `churn_attribution.py`: attributes late footprint changes in a
  `qc_eval real --churn-log` run (`RUN_DIR [LABEL_BUNDLE_DIR] > note.md`); reads
  `edits.tsv`, `fp_history.bin`, `adds.tsv`, `removals.tsv` and, with a binary
  built with `--features diagnostics`, `tests.tsv`. Needs numpy.
- `support_sizes.py`: footprint support sizes per pass of `--passes N` runs
  (`LABEL=RUN_TREE ... [--count pos|disk]`): median, p99, largest, runs above
  50k px and the pass-k / pass-1 ratios (S2.1). Needs numpy.
- `test_summarize.py`: `python -m unittest discover tools/cala-eval`.

## Run

On the lab Mac the sims (arms static, motion, halo, oof; seeds 5-9) and the
minisim venv live outside `/tmp` in `~/Projects/cala-data` (layout and rebuild
steps in its `README.md`); `source ~/Projects/cala-data/sims.env` sets
`CALA_SIMS` (use as `<sims>`), `MINISIM_PY` and `QC_EVAL_BIN`. Do not keep sims
under `/tmp`: macOS deletes them.

```
cargo build --release -p calab-cala --example qc_eval   # from crates/cala
cp target/release/examples/qc_eval tools/cala-eval/bin/<commit>

MS=<minisim venv>/bin/python   # or $MINISIM_PY from sims.env
$MS tools/cala-eval/gen_sims.py --sims <sims> --arms static,motion --seeds 5-9 --reuse <old sims>

python tools/cala-eval/run_arms.py --bin base=tools/cala-eval/bin/<base> \
    --bin new=tools/cala-eval/bin/<new> --extra "new=--core-test trim" \
    --sims <sims> --arms static,motion --seeds 5-9 --out <runs> \
    -- --batch 8 --budget 30000000 --slow-seed 1

python tools/cala-eval/summarize.py --base <runs>/base --new <runs>/new \
    --primary P8 --claim-arms motion > tools/cala-eval/results/<date>-<task>.md
```

Arguments after `--` go to every run; `--extra LABEL="..."` replaces or adds
flags for one binary. `--budget-mult 4` scales `--budget` (the 4x runs).
Check `ps` before generating sims or running `qc_eval real`: no more than 2
heavy processes machine-wide. `run_arms.py` only counts binaries whose path
contains `qc_eval` or `/cala-eval/bin/` towards the cap, so keep them there.

`qc_eval` ignores flags it does not know, without a warning; check the spelling
of every flag (`--every`, not `--checkpoints`; there is no `--no-pass2`).

## Statistics

For each arm and metric: `d_s = new_s - base_s`, `mean(d) +- t(S-1, .975) *
sd(d) / sqrt(S)`, sign counts. One pre-declared `--primary` metric; an effect
is claimed only if its CI excludes 0 on the `--claim-arms`. Pooled-over-arms
numbers are shown, never used for the claim. The per-run binomial SE of
precision (about .011 at 500 cells) is printed next to precision rows.

## Metrics (from `qc_eval sim` outputs)

| name                                                           | source                     | meaning                                                                                   |
| -------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `P2`, `R2`, `P8`, `R8`                                         | `global.tsv`               | GT precision and recall at frame 2400 and 9600                                            |
| `P8x`                                                          | `cells.tsv`                | precision with non-detectable matches left out of the library                             |
| `AUC_P`, `AUC_R`                                               | `global.tsv`               | mean over checkpoints every 300 frames from 1200                                          |
| `slope_P`                                                      | `global.tsv`               | least-squares slope of P over the last 5 checkpoints, per 1000 frames                     |
| `fp_noise`, `fp_adjacent`, `fp_partial`, `fp_dup`, `fp_nondet` | `cells.tsv` `fp_class`     | FP classes in the final library                                                           |
| `fp_edge10`                                                    | `cells.tsv` `edge_px`      | non-TP cells with centroid within 10 px of the sensor-mask edge (the image border counts) |
| `r_fp`                                                         | `cells.tsv`                | median footprint r of the TPs                                                             |
| `r_tr`                                                         | `global.tsv`               | median true-trace r                                                                       |
| `adds_pm`, `readds_pm`, `deletes_pm`                           | `adds.tsv`, `removals.tsv` | per minute over the last 4 minutes                                                        |

Ground-truth-free held-out score (E2, `calab_cala::qc::heldout`; the same
numbers come out of `qc_eval real`):

| name               | source                       | meaning                                                                                           |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `S8`               | `global.tsv` `ho_score`      | penalised held-out gain per held-out frame (units of s²) in the last checkpoint window            |
| `AUC_S`            | `global.tsv` `ho_score`      | mean of `ho_score` over checkpoints from 1200                                                     |
| `rho_S_TP`         | `global.tsv`                 | Spearman of `ho_score` with the TP count (precision x cells) over those checkpoints               |
| `Sf8`, `rho_Sf_TP` | `global.tsv` `ho_score_frac` | S over the held-out light above noise (`ho_signal`): activity in the window divides out           |
| `auc_hoz`          | `ho_cells.tsv`, `cells.tsv`  | AUC of per-cell `ho_marginal_z` for TP vs not at the last checkpoint (unscored cells rank lowest) |

`S = mean over held-out frames of (G_t − k_t μ_t)`: `G_t` is the whitened χ²
the library removes from a frame the slow loop never fitted on, divided by the
running median `s²` of the residual χ² per pixel; `μ_t` is the gain of one
placebo column (a cell's footprint displaced by 2 to 4 diameters onto empty
tissue, solved jointly with the library), so a cell-shaped non-cell adds
nothing to `S` on average and a real cell adds its light. `ho_marginal_z` is a
cell's mean drop-one gain on frames where it is active (trace > 2 σ), against
the same statistic of the placebos in its 128 px tile. Definition and
deviations from the plan: the `qc::heldout` module docs.

`qc_eval ... --library <footprints.bin>` scores a fixed cell set (an earlier
run's final library, or another pipeline's footprints converted to `CALAFP01`)
with no slow loop; its `final.tsv` carries each cell's `ho_marginal_z`.

Footprint convergence (E7, `calab_cala::qc::convergence`; `qc_eval sim` and
`qc_eval real` write `convergence.tsv`, one row per checkpoint and lag k = 1
and 4 checkpoints):

| name                         | source            | meaning                                                                                         |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `conv_med1`, `conv_med4`     | `convergence.tsv` | median `‖a_v − a_{v−k}‖ / ‖a_v‖` over cells present at both checkpoints, last checkpoint        |
| `conv_share1`, `conv_share4` | `convergence.tsv` | share of those cells whose change exceeds their own split-half footprint noise, last checkpoint |

The noise level is the split-half noise of the cell's running footprint
statistics (`SlowLoop::footprint_noise`: half the difference of the two
halves, over the footprint norm, on the cell's support): it is already kept
for the slow loop, needs no extra pass and is scale free. It is conservative,
because the footprint at `v - k` shares most of its data with the one at `v`.
Rows also carry the share of cells that moved by more than 0.1 %, the median change among them, the share that changed by more than 10 %, the median shape-only change (unit-norm footprints) and, per
age bin (frames since birth: <1200, 1200-3000, 3000-6000, >=6000), the cells
counted, the share changing and the median change. The curve over checkpoints:
`summarize.py --convergence <run dir>...`.

FP classes (`qc_eval` `label_rows`): `noise` r < .5 with every GT unit and no GT
centroid within 10 px; `adjacent` r < .5 but a centroid within 10 px; `partial`
r .5 to .7 with a GT unit no other cell matched; `dup` r >= .5 with a unit
another cell matched; `nondetectable` matched only GT units with `detectable ==
false`. `P` is unchanged (TP / library); the non-detectable matches are now a
class of their own instead of being hidden among the FPs, and `P8x` shows the
precision without them.

`edge_px` is a chamfer distance to the nearest pixel outside the FOV mask,
capped at 40.

## Support rule (S2.1)

`qc_eval --support-rule basin-skirt|basin|rings` picks how the statistics path
measures a footprint's pixel support (`SlowLoopConfig::support_rule`, default
`basin-skirt` since the S2.1 default flip; `rings` is byte-identical to the
rule before S2.1 and stays selectable for comparisons, and is the rule
`--core-test` and `--basin-trim` need). `discover_eval` takes the same flag.
Runs before the flip that did not pass the flag used `rings`. `basin` keeps the
pixels where the PSF-smoothed measured light is significant (family-wise
`--support-alpha`, default 0.05, per footprint; standard error measured from
the split halves) in the single-peaked basin of the cell's peak; `basin-skirt`
also gives the footprint a skirt: unfiltered light per 8 px moat block on the
rest of the statistics disk, solved so that the column (the filter of support
plus skirt, whose low-pass reaches the moat) matches the measured light there.

## Refine gate (S2.1c)

`qc_eval --refine-gate legacy|split-half` picks when the statistics path
proposes a refinement (`SlowLoopConfig::refine_gate`, default `split-half`
since 13 Nov 2026). `legacy` is the χ² disagreement test plus
`refine_min_change`, the rule before S2.1c. `split-half` proposes only when `Î = ‖h/a − cur‖² − ½‖(h_A − h_B)/a‖² > 0`: the change from the
current column exceeds the estimate's own split-half noise. The reservoir path,
absorbs and merges are the same under both.

With a binary built with `--features diagnostics`,
`CALA_SUPPORT_AUDIT=<file>` writes one `C` row per footprint construction on
the statistics path (every rule: tested pixels `N`, `se`, `phi`, `z_fw`, the
support size and radius, the s20 radii `r_h` and `r_u`, `n_X`, second peak,
mass beyond `r_h`, skirt blocks and mass, and the median and `|z| > 3` share
of the block leftover `h − column` outside the support, overall and split into
whole blocks (every FOV pixel outside the support measured and outside `X`) and
partial ones) and one `L` row per published cell at each publish (`n_pos`,
radius, skirt blocks). The header lines start with `#`.

`CALA_DIVERGE_DIR=<dir>` (any build) writes `solver.tsv` (per frame: library
version, cells, solver sweeps, largest |trace|, non-finite traces) and, at the
first frames of up to six library versions where a trace exceeds 1e6 or is
non-finite (or at frame `CALA_DIVERGE_AT`), a `dump_t<frame>_v<version>`
directory with the library bytes (`Library::to_bytes`), the frame and the warm
start, so the solve can be replayed offline.

## Validation (E1)

- Reproduction of `tools/cala-diagnostics/COMPUTE_VS_PRECISION.md`: the main binary of that table
  (f30ce26, default `--slow-seed`, `--batch 8`) on the existing recordings
  gives `motion s5 1x` P2 .946, R2 .538, P8 .934, R8 .754, 501 cells (exact) and
  `static s6 1x` P2 .966, R2 .582, P8 .969 (table .966), R8 .782, 508 cells.
  The table was made with the default slow-loop seed, so pass no `--slow-seed`
  to compare with it.
- Null comparison (same binary, `--slow-seed 1` vs `2`, seeds 5-9, both arms):
  `results/2026-11-11-e1-null.md`. The primary-metric CIs cover 0.
- Demo comparison (`--core-test trim` vs off): `results/2026-11-11-e1-core-test-trim.md`.
- Seed-to-seed spread is larger than the binomial SE: on `motion` the P8 CI
  half-width is about .024 for the null, so one run decides nothing.

## Results notes

`results/` holds one note per comparison or probe. Paths such as
`scratchpad/e6/...` in the notes are the authoring session's scratch directory
under `/private/tmp`; they are not in the repo and macOS may delete them. The
sim recordings they name are kept in `~/Projects/cala-data/sims` (see Run).

| note                                  | what it settles                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `2026-11-baseline.md`                 | E6 reference numbers at 81f041c (sims and real, seed Jaccard)                                            |
| `2026-11-11-e1-null.md`               | E1 null: same binary, slow seed 1 vs 2; primary CIs cover 0                                              |
| `2026-11-11-e1-core-test-trim.md`     | E1 demo: `--core-test trim` vs off                                                                       |
| `2026-11-11-e2-heldout-score.md`      | E2: ground-truth-free held-out score                                                                     |
| `2026-11-11-e7-convergence.md`        | E7: footprint convergence metric                                                                         |
| `2026-11-11-s12-crossfit.md`          | S1.2: cross-fitted statistics give no gain; the texture is in the data                                   |
| `2026-11-11-d4-flat-field.md`         | D4: textured footprints are sensor-gain shimmer; a flat field removes them                               |
| `2026-11-12-support-rule.md`          | S2.1: measured basin support rule (rings / basin / basin-skirt)                                          |
| `2026-11-12-skirt-stability.md`       | S2.1b: stable skirt, PI's gate redefinitions; `basin-skirt` becomes the default                          |
| `2026-11-11-flat-field-default.md`    | online flat field as the default (#330)                                                                  |
| `2026-11-12-churn-attribution.md`     | late footprint changes are the cells' own refines, merges and absorbs                                    |
| `2026-11-12-repeated-pass.md`         | S2.3: repeating pass 1 settles footprints but false cells grow as with equal budget                      |
| `2026-11-12-refine-only-passes.md`    | S2.3b: refine-only later passes let supports run away; default stays `--later-passes all`                |
| `2026-11-12-refine-gate.md`           | S2.1c minimal option: split-half refine gate cuts late real refines 37 %; the default                    |
| `2026-11-13-app-background-levels.md` | the app's slow loop without the ring-background levels: within noise; fixed so the app matches `qc_eval` |
