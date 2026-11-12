# S1.7 PR-2: footprint estimates from the joint store

**Question.** Should the slow loop's footprint estimates come from the joint sufficient-statistics store (#329, #331) under the neighbours' current columns, instead of `fpstats`? Does that make footprints settle faster?

**Verdict.** It is neutral to slightly positive on precision. It does **not** improve convergence: on the 4× motion sims, footprints change measurably more. `Joint` stays opt-in (`--footprint-stats joint`). `Residual` stays the default.

## What was compared

- **Sims.** Both arms run on the same binary (`s17pr2-e01387a`, this branch), paired over seeds 5–9: `--footprint-stats residual` (base) against `--footprint-stats joint` (new).
  - Arms: static, motion, halo and oof at 1×, plus motion at 4×.
  - Flags: `--batch 8 --budget 30000000 --slow-seed 1`.
- **Real data.** The workshop recording, 600², 18 000 frames, `--motion --no-pass2 --checkpoints 15 --batch 8 --budget 30000000 --via-jobs`, slow seeds 1 and 2.
  - The binary is this branch merged locally with `feat/cala-flat-field-default` (#330, head 3c1a269), so the flat field is on, in its online default.
  - #330 had not merged when these runs were made.
- **Texture, S8 and Minian agreement** come from the flat-field evaluation script. Texture is flagged by `core_frac < .2` and `n_max ≥ 3`.
- **Seed-to-seed Jaccard** comes from `seed_jaccard.py`. Convergence comes from `summarize.py --convergence`.

## Sims (paired d = joint − residual, mean ± 95 % t-CI, n = 5)

| arm       | P8                     | R8           | R2           | fp_noise   | fp_partial | S8         | conv_share1      | conv_share4      | conv_big1        | conv_big4    |
| --------- | ---------------------- | ------------ | ------------ | ---------- | ---------- | ---------- | ---------------- | ---------------- | ---------------- | ------------ |
| static 1× | +.007 ± .013           | +.002 ± .020 | +.002 ± .015 | +0.6 ± 4.4 | −2.6 ± 2.6 | +1 ± 318   | +.001 ± .009     | +.005 ± .008     | +.004 ± .009     | −.001 ± .010 |
| motion 1× | **+.008 ± .003** (5/0) | +.011 ± .027 | +.001 ± .012 | −1.4 ± 4.1 | −3.0 ± 3.0 | +99 ± 508  | **+.007 ± .005** | +.015 ± .032     | **+.008 ± .005** | +.007 ± .029 |
| halo 1×   | −.003 ± .009           | +.002 ± .021 | +.000 ± .010 | −0.4 ± 1.4 | −0.8 ± 3.9 | −95 ± 353  | +.003 ± .015     | +.011 ± .022     | +.002 ± .011     | +.008 ± .021 |
| oof 1×    | +.003 ± .018           | +.003 ± .015 | −.003 ± .005 | +0.2 ± 0.6 | −2.2 ± 8.5 | −25 ± 281  | +.008 ± .012     | +.011 ± .038     | +.005 ± .013     | +.007 ± .037 |
| motion 4× | +.003 ± .026           | +.004 ± .009 | +.011 ± .014 | −0.4 ± 6.9 | +1.8 ± 5.6 | +390 ± 755 | **+.017 ± .009** | **+.035 ± .016** | +.007 ± .018     | +.008 ± .010 |

Base levels (residual):

- motion 1×: P8 .926, conv_share1 .024, conv_share4 .107.
- motion 4×: P8 .880, conv_share1 .031, conv_share4 .139.

Readings:

- **P8.** The pre-declared primary (P8 on motion) is up by .008 ± .003 at 1×, with all 5 seeds positive. At 4× the CI covers 0.
- **Partial FPs.** These fall on 4 of 5 arms. The note predicted this, since a neighbour's light is attributed at once rather than over the half-life.
- **Convergence.** The share of cells changing beyond their own noise rises, and significantly so at 4×: +.035 at lag 4 (5/0). Convergence is worse, not better.

## Real data (workshop, flat field online)

|                                                                             | residual s1 | joint s1              | residual s2 | joint s2              |
| --------------------------------------------------------------------------- | ----------- | --------------------- | ----------- | --------------------- |
| cells                                                                       | 664         | 675                   | 696         | 686                   |
| texture-flagged                                                             | 2           | 0                     | 5           | 7                     |
| held-out score S8                                                           | 21 883      | 19 919                | 22 485      | 22 352                |
| AUC_S                                                                       | 16 100      | 15 403                | 16 302      | 16 385                |
| `ho_marginal_z` median                                                      | 6.91        | 5.85                  | 6.58        | 6.45                  |
| Minian agreement r ≥ .5 / ≥ .7                                              | 503 / 412   | 495 / 394             | 525 / 411   | 529 / 397             |
| share of cells > 10 % change, lag 1 (1 min), mean over checkpoints ≥ 12 000 | .022        | .028                  | .022        | .023                  |
| same, lag 4 (4 min)                                                         | .117        | .125                  | .105        | .103                  |
| share changing beyond own noise, lag 4, ≥ 12 000                            | .078        | .102                  | .072        | .083                  |
| peak RSS                                                                    | 1.24 GB     | 1.54 GB               | 1.39 GB     | 1.22 GB               |
| wall                                                                        | 615 s       | 651 s                 | 637 s       | 653 s                 |
| visit job                                                                   |             | 4.78 MB (stores 0.78) |             | 4.81 MB (stores 0.80) |

- **Seed-to-seed Jaccard.** Residual .677 (s1 vs s2), joint .654. Note that .677 matches the flat-field number.
- **Convergence curves** (share > 10 % per checkpoint, lag 4, from frame 2400):
  - res1: .16 .14 .15 .15 .15 .11 .12 .15 .13 .12 .10 .08 .13 .14
  - joint1: .16 .15 .16 .21 .13 .14 .15 .14 .17 .11 .11 .12 .11 .13
  - res2: .17 .17 .17 .17 .12 .14 .12 .15 .11 .12 .10 .10 .09 .11
  - joint2: .18 .13 .16 .16 .15 .14 .11 .14 .09 .11 .09 .11 .10 .12

  Neither arm settles. Joint is not lower at any stage.

- **Jobs.** They grow from about 4.3 MB (PR-1b) to 4.8 MB. The growth is the halo cells: the stores' neighbours outside the zone, with columns only and `raw` stripped.
- **RSS.** The run-to-run spread (1.22–1.54 GB) is larger than any arm difference.

**Far-neighbour approximation, with decisions now reading the store** (shadow run, seed 1, 676 cells, end of run):

- RMS(approx − exact) / RMS(SE): median .028, p95 .133, max .375.
- max |diff| / max |est|: median 1.3 %, p95 7.5 %, max 17 %.

The error stays below 0.4 SE in the worst cell, so the approximation is not what drives the decisions.

## Browser FPS

Setup:

- Headless Chrome (`--use-angle=metal`, port 5198) on the 4000-frame workshop folder.
- Wasm is built from this branch with each default; this build has no flat field.
- Arms alternate: residual, joint, residual, joint.

| arm      | steady FPS (two runs) | mean  | slow-loop frames dropped |
| -------- | --------------------- | ----- | ------------------------ |
| Residual | 329.3, 313.9          | 321.6 | 12.5 %, 13.6 %           |
| Joint    | 332.6, 326.1          | 329.4 | 13.6 %, 13.6 %           |

The two arms are within run-to-run noise.

## Why convergence does not improve

The E7 changes on real data are large jumps (median change of a moved cell .4–.8 of its norm), not slow drift. They are refines, merges and splits that replace a footprint. A fresher estimate does not stop these edits.

Exact statistics make the estimate disagree with the current footprint as soon as a neighbour moves. So with `Joint`, each published change can trigger refines of the cells around it within a visit or two, instead of being smoothed over the 6000-frame half-life. That is the intended propagation, but on a recording where about 24 cells are still added per minute at minute 15 it shows up as more change, not less.

The ceiling measured in PR-1 (store r .965 vs fpstats .893 vs oracle .993) still holds per estimate. The rest needs re-solved traces (S2.3), and the churn needs the decision side (S2.1), not the proposal.

## Decision

`Residual` stays the default.

- `Joint` is neutral to positive on precision: P8 motion 1× +.008 claimed, fewer partial FPs.
- It worsens the convergence metric this PR was meant to improve: conv_share4 +.035 ± .016 on 4× motion, and no gain on real data.
- It is slightly worse on seed-to-seed Jaccard (.654 vs .677) and on seed-1 S8 (−9 %; seed 2 is equal).
