# D4: textured footprints are sensor-gain shimmer; dither flat field (`--flat-field auto`)

Real data: workshop CA1 recording, 18 000 frames, `--motion --batch 8 --core-test report`, slow seeds 1 and 2.
Diagnostics: `crates/cala/examples/texture_eval.rs` plus analysis scripts in the session scratchpad (`texture/`).

## Diagnosis

The texture is the sensor's pixel gain pattern (PRNU plus column structure, about 5 % SD at scales below 8 px)
moved over the tissue by registration. It is not interpolation shimmer, not a preprocessing residue and not tissue.

| test                                                                                    | result                                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Traces vs rigid shift (cross-validated R², quadratic in dy, dx, \|d\|)                  | textured median .315 vs non-textured −.011; R² > .2 in 75 % of textured, 6 % of others                                              |
| Traces vs sub-pixel phase, speed, brightness                                            | R² ≈ 0 for every group (not interpolation shimmer)                                                                                  |
| Motion dependence through population activity?                                          | no: textured motion R² beyond the population trace .347                                                                             |
| Gain map from the motion dither (Kuhn–Lin–Loranz on raw frames binned by integer shift) | 88 % of the high-passed log-mean variance is fixed to the sensor (gain SD 5.0 %), 13 % moves with the tissue                        |
| Motion-response images of the registered video (per-pixel regression on dy, dx)         | explained by the sensor-gain prediction (R² .55–.65 of the high-passed image), not by the tissue gradient (R² .001)                 |
| Same, by stage: raw warped / registered front / after background                        | R² .55–.65 / .37–.57 / .37–.55: in the raw pixels, so not a filtering residue                                                       |
| After dividing by the gain map                                                          | motion-response SD falls 6–8x (post: .47 → .075 grey/px); re-estimated gain SD 5 % → 0.5 %; tissue part unchanged (1.90 % → 1.87 %) |
| Footprint power above 0.1 cycles/px                                                     | textured 2.8 % vs clean compact 0.4 % (AUC .81)                                                                                     |
| Footprint HF explained by the motion-response images                                    | textured R² .34, clean .03                                                                                                          |
| Footprint HF explained by smooth(footprint) × gain (PRNU on the cell's own light)       | clean cells: coefficient 1.19 (physics predicts 1), R² .011; textured: coefficient 15.7, R² .17                                     |
| PI blind labels (148 candidates matched to run r9)                                      | trace motion R² separates `not` from `cell` with AUC .988 (25 vs 79)                                                                |

The mechanism: the gain pattern multiplies all the light, mostly the bright neuropil background, not only the
cell. After registration each tissue pixel reads `B(u) · gain(u − d_t)`. A component whose trace correlates with
the shift picks up `B · ∇gain` in its footprint (`h = cov(r, c) / var(c)`). That signal is a deterministic
function of the shift, so it repeats in both halves of the recording and survives cross-fitting (S1.2). Where the
trace is a real cell, flat-fielding leaves a compact cell; where the trace was the motion signal, the component
goes away (`fig_pairs_s1.png`: of 28 textured cells, 13 become compact cells and 15 disappear).

## Real data, base vs flat field

`ff` = gain map estimated from all 18 000 frames (offline, `--flat-field FILE`). `auto` = this PR's
`--flat-field auto:3000`, estimated in a first pass over frames 0–2999 only.

| metric                                                              | base s1 / s2             | ff s1 / s2               | auto s1 / s2             |
| ------------------------------------------------------------------- | ------------------------ | ------------------------ | ------------------------ |
| cells                                                               | 719 / 711                | 675 / 705                | 714 / 693                |
| texture-flagged (core_frac < .2, n_max ≥ 3)                         | **28 / 28**              | **1 / 1**                | **0 / 1**                |
| split-half r of textured cells (median)                             | .896 / .901              | (1 cell)                 | (≤ 1 cell)               |
| traces with motion R² > .2                                          | 49 / –                   | 1 / –                    | 0 / –                    |
| held-out score S8                                                   | 13 524 / 12 866          | 22 493 / 22 493          | 22 451 / 21 100          |
| AUC_S                                                               | 10 527 / 10 561          | 17 223 / 16 909          | 17 824 / 16 835          |
| `ho_marginal_z` median (all)                                        | 4.36 / 4.24              | 7.08 / 5.53              | 5.46 / 5.75              |
| `ho_marginal_z` < 2                                                 | 222 / 224                | 167 / 187                | 184 / 175                |
| Minian agreement r ≥ .5                                             | 511 / 507                | 518 / 521                | 536 / 513                |
| Minian agreement r ≥ .7                                             | 399 / 390                | 424 / 418                | 408 / 400                |
| seed-to-seed Jaccard (cos ≥ .5)                                     | .634                     | .679                     | .677                     |
| PI labels present (≤ 4 px): cell / not / unsure (of 143 / 55 / 101) | 87 / 6 / 30, 83 / 7 / 35 | 84 / 7 / 36, 89 / 9 / 35 | 83 / 4 / 31, 78 / 3 / 31 |

Minian is a reference with missing and wrong cells, so these are agreement numbers, not recall. The labels are
an imperfect reference too; the label rows count candidates near any library cell, so they move with the
library size.

## Sims

Base: main 74016a3. New: `--flat-field auto:3000` (binary built before the dark-level margin fix in this PR,
which moved the real-data dark estimate from 7.2 to 3.7 grey levels; the real `auto` rows above use the final
code). `--batch 8 --budget 30000000 --slow-seed 1 --core-test report --dump`, 600 px, 9600 frames. The fpn arm
has seeds 5–7; the motion arm 6–7 (seed 5's base run was still queued behind other agents' jobs).

| arm    | metric                | base   | new    | d (95 % t-CI)  | signs +/−/0 |
| ------ | --------------------- | ------ | ------ | -------------- | ----------- |
| fpn    | **P8**                | .934   | .933   | −.001 ± .025   | 2/1/0       |
| fpn    | R8                    | .748   | .754   | +.006 ± .026   | 2/1/0       |
| fpn    | S8                    | 27 337 | 35 238 | +7 901 ± 2 510 | 3/0/0       |
| fpn    | r_fp (TP footprint r) | .942   | .947   | +.005 ± .003   | 3/0/0       |
| fpn    | r_tr (TP trace r)     | .958   | .961   | +.002 ± .002   | 3/0/0       |
| fpn    | auc_hoz               | .850   | .899   | +.049 ± .058   | 3/0/0       |
| motion | **P8**                | .918   | .924   | +.006 ± .005   | 2/0/0       |
| motion | R8                    | .737   | .749   | +.013 ± .142   | 2/0/0       |
| motion | S8                    | 33 231 | 33 120 | −111 ± 134     | 0/2/0       |

- The fpn arm does **not** reproduce the textured false cells: 2, 0 and 2 texture-flagged cells per run on base
  (two `noise` FPs, one `partial`, one TP), against 28 on the real recording. So it cannot show the main effect.
- With the flat field, footprints and traces of true cells match ground truth better on fpn (3/3 seeds) and
  the held-out score rises 29 %; P8 and R8 do not move.
- On the motion arm (no sensor pattern in the sim) the estimate has nothing to remove and nothing changes.

## Caveats

- One recording. The gain map is a sensor property; it should be re-estimated per camera (or per session,
  which `auto` does).
- `auto` needs motion: with fewer than two shift bins of 100 frames each it reports the error and the run
  continues without a flat field. 3000 frames gave 7 bins here (dither SD about 1 px).
- The minisim fpn arm has a comparable gain pattern (bands 2.0 / 0.9 / 0.6 % vs real 2.4 / 1.0 / 0.5 %) and
  motion, and its motion-response images are about 70 % of the real ones, but it produces 0–2 textured cells
  per run against 28. What else the real data has (brighter background under the pattern, behaviour-locked
  motion, the remaining residual excess) is open.
