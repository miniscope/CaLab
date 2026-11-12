# S1.4 rotating folds (`holdout_folds = 2`, 6.4 s blocks) vs main 81f041c

Base = E6 runs, seeds 5-9, `--batch 8 --budget 30000000 --slow-seed 1`. `folds2` = this branch with
`--holdout-folds 2`; `fixed 6.4` = `holdout_folds = 1` (fixed held-out third of 6.4 s blocks).

## Primary: P8 at 4x minus P8 at 1x on motion

|           | P8 1x | P8 4x | gap    | gap minus base (paired 95% CI) |
| --------- | ----- | ----- | ------ | ------------------------------ |
| base      | .926  | .880  | -0.045 |                                |
| fixed 6.4 | .944  | .931  | -0.013 | +0.032 +- 0.026 (5/0)          |
| folds2    | .914  | .870  | -0.044 | +0.001 +- 0.025 (1/4)          |

## Recall and precision (motion, mean over seeds)

|           | R2 1x | R8 1x | AUC_R 1x | P8 1x | R2 4x | R8 4x | AUC_R 4x | P8 4x |
| --------- | ----- | ----- | -------- | ----- | ----- | ----- | -------- | ----- |
| base      | .539  | .747  | .646     | .926  | .637  | .806  | .731     | .880  |
| fixed 6.4 | .231  | .631  | .430     | .944  | .303  | .713  | .511     | .931  |
| folds2    | .444  | .736  | .599     | .914  | .565  | .782  | .683     | .870  |

## folds2 minus base at 1x, all arms (paired d, 95% CI)

| arm    | R2            | R8            | P8            | AUC_R         | fp_noise    |
| ------ | ------------- | ------------- | ------------- | ------------- | ----------- |
| motion | -.095 +- .027 | -.011 +- .009 | -.011 +- .015 | -.048 +- .010 | +3.4 +- 4.4 |
| static | -.094 +- .018 | -.010 +- .016 | -.021 +- .016 | -.043 +- .017 | +6.2 +- 6.5 |
| halo   | -.091 +- .026 | -.024 +- .036 | -.013 +- .020 | -.055 +- .007 | 0 +- 2.9    |
| oof    | -.095 +- .019 | -.014 +- .019 | -.006 +- .012 | -.054 +- .012 | +0.6 +- 1.7 |

folds2 minus base at 4x on motion: R2 -.072 +- .016, R8 -.025 +- .013, AUC_R -.048 +- .010, P2 -.015 +- .026.

## Reading

Two rotating folds recover most of the recall of the fixed split (R8 -0.10 to -0.12 down to -0.01 to -0.025; R2 -0.31
down to -0.09; AUC_R -0.21 down to -0.05), but the precision gain is gone: the 4x-minus-1x gap is back to the base value
(-0.044) and P8 is 0.006 to 0.021 below base, with more `noise` false positives on motion and static. R2 still misses
the -0.02 margin. The fixed split buys precision by testing every edit on frames the footprint never saw; with folds,
the published footprint has seen the fold being tested at an earlier visit, so keep and refine tests are partly
in-sample. Rebuilding the tested footprint from the other fold's statistics for keep and refine tests is the missing
step.
