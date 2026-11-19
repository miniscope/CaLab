# Factor pipeline, phase 0: loss, tiling and baseline timing

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`.
Commit: 99763d14 (the merge of v2.20.0 into `feat/cala-factor-eval`; `qc_eval` and the site were built there).
Machine: Apple M1 Max, 10 cores, 32 GB. Runs of 18 Nov 2026.

"Factors" are the low-rank SVD (singular value decomposition) factors that the compressor keeps per tile and window
of 600 frames. QC pass means the cell passed cala's quality control. A loss is 1 minus the median of a measure over the
QC-pass cells. The measures are the lag-1 correlation of the traces (trace r1, explained below) and the cosine of
the footprints (footprint cos). "Null" is the spread between raw runs that differ only in the slow-loop budget.

## Decision

The gate rules of the plan were applied exactly as written. The results:

- **Gate G0 as specified: failed.** No recording has an arm that is `within` the null for both the trace and the
  footprint loss of the QC-pass cells. `plain` is `outside` on both measures on all six recordings. `plain_recal` is
  `within` on the footprint loss on `plain`, `v4` and `motion`, and `outside` on the trace loss on all six.
- **Tiling as specified: no tiling qualifies.** "QC pass, under 8 px from a tile line" is `outside` on both measures for
  every tiling on every recording. `overlap8` was run on the 200 px recordings only, so it could not qualify on every
  recording in any case.
- **File recordings as specified: depends on how the rule is read.** Per measure, `plain_recal` is `within` where `plain`
  is `outside` for the footprint loss on `plain`, `v4` and `motion`, which points to a compression replay. For the trace
  loss this happens on no recording. Read as the G0 pair (both measures together), the condition holds on no recording,
  which points to the factors of Discover. The rule does not say which reading is meant.

G0 per recording (verdict of the QC-pass cells against the null):

| recording | arm           | trace (lag 1) | footprint |
| --------- | ------------- | ------------- | --------- |
| wl200     | `plain`       | outside       | outside   |
| wl200     | `plain_recal` | outside       | outside   |
| wl24_01   | `plain`       | outside       | outside   |
| wl24_01   | `plain_recal` | outside       | outside   |
| wl24_04   | `plain`       | outside       | outside   |
| wl24_04   | `plain_recal` | outside       | outside   |
| plain     | `plain`       | outside       | outside   |
| plain     | `plain_recal` | outside       | within    |
| v4        | `plain`       | outside       | outside   |
| v4        | `plain_recal` | outside       | within    |
| motion    | `plain`       | outside       | outside   |
| motion    | `plain_recal` | outside       | within    |

The file-recording rule compares the same cells of this table: `plain_recal` is `within` where `plain` is `outside` in
exactly the three footprint cells that read `within`. For the tiling rule, the QC-pass cells under 8 px from a tile line
are `outside` on both the trace and the footprint loss for all 21 runs of a tiling arm (every tiling on every recording
where it was run; the values are in "Tile lines").

### What the specified gate cannot tell

The largest null loss is close to 0 on several recordings. On `wl200` and `plain` the trace null is 0.00001 to 0.00002:
`within` there means "median identical to raw", and any lossy compression reads `outside`. The table gives the largest
null loss of the QC-pass cells per recording.

| recording | trace lag 1 | footprint | trace plain |
| --------- | ----------- | --------- | ----------- |
| wl200     | 0.00002     | 0.00025   | 0.00022     |
| wl24_01   | 0.00090     | 0.00167   | 0.00216     |
| wl24_04   | 0.00059     | 0.00159   | 0.00210     |
| plain     | 0.00001     | 0.00022   | 0.00002     |
| v4        | 0.00043     | 0.00549   | 0.00050     |
| motion    | 0.00095     | 0.00632   | 0.00126     |

The truth comparison says something the gate does not. For the `plain` arm, the paired difference of the truth
correlation (factor arm minus raw, same cells) has a median of 0.0016 on `wl200` (25 cells) and 0.0036 on `plain`
(180 cells). Its 5th percentile is -0.0876 and -0.0267. So on these two recordings the median cell is as close to the
truth with factors as without, while one cell in twenty loses about 0.03 to 0.09 of truth correlation or more. The
truth match of `motion` is unreliable (estimated frame offset 15.5 px, only 145 of 262 cells matched), so it is left
out here. The full table is in "Truth".

The footprint jump at tile lines (median jump of footprint values across a tile line over the same elsewhere) rises with
`plain` tiling on five of six recordings, most on `wl200` (0.979 for raw, 1.818 for `plain`) and `plain` (0.933,
1.326). The overlapping and offset tilings bring it to or below the raw value on `wl200`, `wl24_01` and `v4`, to within
0.04 above it on `plain` and `motion`, and to 0.07 to 0.09 above it on `wl24_04`. The full table is in "Tile lines".

The spec's remedies were then tried on the three 200 px recordings ("Remedies: the rank cut"): the trace loss there
comes from the rank cut (0.002 to 0.003 with no cut). At under a quarter of the size of the frames no setting removes
more than about two fifths of it, the loss falls steadily with the rank and has no knee, and a second power iteration of the SVD removes
26 to 30 percent of it for about 10 percent more bytes.

**Decision (the user, 18 Nov 2026): the gate is replaced.** The spec's Amendment 1 sets fixed limits instead of the
near-zero null (truth correlation, footprint loss, trace loss where there is no truth, footprint jump at tile lines),
two power iterations of the SVD, the two offset grids as the tiling, and a compression replay with the final
calibration for file recordings. Under those limits, recalibrated factors with two SVD iterations pass where they were
run. The chosen combination (offset grids, recalibrated, two iterations) has not been run together; that check is the
gate of phase 1.

## How it was measured

`tools/cala-eval/factor_arms.py` ran `qc_eval` once per arm and recording. All arms share pass 1 (Discover).
`raw` then ran the refine replays and an Extract pass on the raw frames. `null_lo` and `null_hi` are `raw` with half
and twice the slow-loop budget in the replays; their distance to `raw` is the null spread. `plain`, `overlap8`,
`overlap16` and `offset` ran the replays and the Extract pass on frames rebuilt from the pass-1 factors, under that
tiling (`offset` is two grids offset by half a tile). `plain_recal` is `plain` with the factors of the first replay,
which carry the final flat field from frame 0. `x_raw` and `x_<tiling>` ran Discover and Extract only, so both
Extracts solve with one and the same cell library. Cells were matched by id between runs. As read in the code, the slow
loop is not reset when a replay pass starts, so the refine replays of a factor arm start from the state that Discover
built on raw frames, and the noise map also comes from raw frames; the factor arms therefore measure "Discover on raw
frames, later passes on factors".
`factor_closeness.py` computed the per-cell measures and the verdicts.

The plan asked for 5 refine replays on every recording at full length. This was bounded, by the controller's ruling,
because the full set extrapolated to about 35 h:

- 200 px recordings (`wl200`, `wl24_01`, `wl24_04`): first 12000 frames, 5 refine replays, all 13 arms, 3 runs at once.
- 600 px recordings (`plain`, `v4`, `motion`): first 6000 frames, 2 refine replays, 9 arms (no `null_hi`, `overlap8`,
  `x_overlap8`, `x_offset`), 2 runs at once. Their null is `null_lo` alone.
- `lowsnr` and `dense` were not run.

The slow-loop budget was 3,000,000 work units per frame on every arm, a tenth of `qc_eval`'s default, by the user's
decision, to shorten the runs. The null runs used half and twice that budget in the replays. These numbers are not
comparable with tables measured at the default budget.

The trace gate uses the lag-1 correlation (trace r1), not plain Pearson r. Trace r1 is computed from lag-1
cross-covariances, to which noise that is white in time does not contribute. The factors remove white noise that the
raw trace keeps, so plain r between a raw and a factor trace is low whatever the signal loss. Plain r stays in the
tables as "not gated". A cell whose trace is noise only has no trace r1 and would be counted as "without a value"; no
QC-pass cell lacked a value in these runs.

Truth matching (synthetic sets) first estimates one frame offset between the run and the truth, because the registered
frame is shifted against the simulation's frame. It then matches within 6 px. The truth correlation of a cell is the
maximum over the truth units near it. The number of matched cells is given beside every truth number.

A first pass of the run script skipped the three real recordings (a script error); it was fixed and rerun, with no
effect on the numbers. All 66 arms ended with return code 0.

## Loss against the null, per recording

| recording | arm           | QC-pass cells | trace loss (lag 1) | largest null | verdict | footprint loss | largest null | verdict | trace loss (plain r, not gated) |
| --------- | ------------- | ------------- | ------------------ | ------------ | ------- | -------------- | ------------ | ------- | ------------------------------- |
| wl200     | `plain`       | 63            | 0.16617            | 0.00002      | outside | 0.01033        | 0.00025      | outside | 0.28553                         |
| wl200     | `overlap8`    | 63            | 0.21140            | 0.00002      | outside | 0.01016        | 0.00025      | outside | 0.31695                         |
| wl200     | `overlap16`   | 63            | 0.22641            | 0.00002      | outside | 0.01078        | 0.00025      | outside | 0.33150                         |
| wl200     | `offset`      | 63            | 0.16045            | 0.00002      | outside | 0.00718        | 0.00025      | outside | 0.25522                         |
| wl200     | `plain_recal` | 63            | 0.16572            | 0.00002      | outside | 0.00882        | 0.00025      | outside | 0.28127                         |
| wl24_01   | `plain`       | 58            | 0.20011            | 0.00090      | outside | 0.04539        | 0.00167      | outside | 0.27589                         |
| wl24_01   | `overlap8`    | 58            | 0.18640            | 0.00090      | outside | 0.04004        | 0.00167      | outside | 0.27464                         |
| wl24_01   | `overlap16`   | 58            | 0.20237            | 0.00090      | outside | 0.04799        | 0.00167      | outside | 0.29400                         |
| wl24_01   | `offset`      | 58            | 0.20248            | 0.00090      | outside | 0.04609        | 0.00167      | outside | 0.27204                         |
| wl24_01   | `plain_recal` | 58            | 0.06219            | 0.00090      | outside | 0.01449        | 0.00167      | outside | 0.15951                         |
| wl24_04   | `plain`       | 40            | 0.23123            | 0.00059      | outside | 0.04051        | 0.00159      | outside | 0.28133                         |
| wl24_04   | `overlap8`    | 40            | 0.25707            | 0.00059      | outside | 0.03732        | 0.00159      | outside | 0.31485                         |
| wl24_04   | `overlap16`   | 40            | 0.26332            | 0.00059      | outside | 0.04891        | 0.00159      | outside | 0.32114                         |
| wl24_04   | `offset`      | 40            | 0.21609            | 0.00059      | outside | 0.04311        | 0.00159      | outside | 0.28246                         |
| wl24_04   | `plain_recal` | 40            | 0.07536            | 0.00059      | outside | 0.01060        | 0.00159      | outside | 0.15219                         |
| plain     | `plain`       | 142           | 0.00515            | 0.00001      | outside | 0.00085        | 0.00022      | outside | 0.01265                         |
| plain     | `overlap16`   | 142           | 0.00925            | 0.00001      | outside | 0.00045        | 0.00022      | outside | 0.01966                         |
| plain     | `offset`      | 142           | 0.00490            | 0.00001      | outside | 0.00039        | 0.00022      | outside | 0.01110                         |
| plain     | `plain_recal` | 142           | 0.00287            | 0.00001      | outside | 0.00005        | 0.00022      | within  | 0.01009                         |
| v4        | `plain`       | 202           | 0.00944            | 0.00043      | outside | 0.00806        | 0.00549      | outside | 0.01365                         |
| v4        | `overlap16`   | 202           | 0.01041            | 0.00043      | outside | 0.00835        | 0.00549      | outside | 0.01488                         |
| v4        | `offset`      | 202           | 0.00904            | 0.00043      | outside | 0.00817        | 0.00549      | outside | 0.01279                         |
| v4        | `plain_recal` | 202           | 0.00206            | 0.00043      | outside | 0.00000        | 0.00549      | within  | 0.00412                         |
| motion    | `plain`       | 178           | 0.03055            | 0.00095      | outside | 0.02274        | 0.00632      | outside | 0.04186                         |
| motion    | `overlap16`   | 178           | 0.03713            | 0.00095      | outside | 0.01985        | 0.00632      | outside | 0.04594                         |
| motion    | `offset`      | 178           | 0.03479            | 0.00095      | outside | 0.01990        | 0.00632      | outside | 0.04435                         |
| motion    | `plain_recal` | 178           | 0.00165            | 0.00095      | outside | 0.00121        | 0.00632      | within  | 0.00640                         |

Every factor arm is `outside` the null on the trace loss on every recording. On the footprint loss only `plain_recal`
on `plain`, `v4` and `motion` is `within`. The losses are small on `plain` and `v4` (trace loss under 0.011), 0.03 to
0.04 on `motion`, and large on the 200 px recordings (trace loss 0.16 to 0.26 for the arms with pass-1 factors).

### Where the loss sits (`plain` arm)

The plan asks the report to say which cells carry the loss when G0 fails. The table gives the median trace r1 and the
median footprint cos of the `plain` arm against `raw` per group, with the number of cells. These groups include cells
that do not pass QC. "Under 16 px from the border" is the motion band; it is reported here, not gated.

| cells                       | wl200                | wl24_01               | wl24_04              | plain                 | v4                    | motion                |
| --------------------------- | -------------------- | --------------------- | -------------------- | --------------------- | --------------------- | --------------------- |
| all cells                   | 0.8231 / 0.9907 (72) | 0.7632 / 0.9192 (102) | 0.7643 / 0.9369 (64) | 0.9926 / 0.9991 (188) | 0.9903 / 0.9919 (219) | 0.9355 / 0.9773 (262) |
| QC pass                     | 0.8338 / 0.9897 (63) | 0.7999 / 0.9546 (58)  | 0.7688 / 0.9595 (40) | 0.9949 / 0.9991 (142) | 0.9906 / 0.9919 (202) | 0.9694 / 0.9773 (178) |
| not QC pass                 | 0.7264 / 0.9954 (9)  | 0.6669 / 0.8262 (44)  | 0.7082 / 0.8642 (24) | 0.9895 / 0.9986 (46)  | 0.9898 / 0.9917 (17)  | 0.9046 / 0.9771 (84)  |
| tile line 0 to 4 px         | 0.7731 / 0.9841 (14) | 0.6973 / 0.8757 (31)  | 0.6956 / 0.9320 (16) | 0.9906 / 0.9985 (48)  | 0.9888 / 0.9920 (56)  | 0.9212 / 0.9770 (69)  |
| tile line 4 to 8 px         | 0.8104 / 0.9921 (10) | 0.6958 / 0.9258 (26)  | 0.7797 / 0.9354 (14) | 0.9956 / 0.9985 (39)  | 0.9934 / 0.9962 (35)  | 0.9237 / 0.9710 (51)  |
| tile line 8 to 16 px        | 0.8067 / 0.9869 (21) | 0.8152 / 0.9332 (23)  | 0.7643 / 0.9417 (16) | 0.9922 / 0.9993 (62)  | 0.9911 / 0.9905 (84)  | 0.9303 / 0.9795 (74)  |
| tile line over 16 px        | 0.8354 / 0.9932 (27) | 0.8014 / 0.9412 (22)  | 0.7444 / 0.9419 (18) | 0.9953 / 0.9997 (39)  | 0.9904 / 0.9894 (44)  | 0.9672 / 0.9818 (68)  |
| under 16 px from the border | 0.8286 / 0.9936 (6)  | 0.7411 / 0.8891 (27)  | 0.6918 / 0.8316 (12) | n/a / n/a (0)         | n/a / n/a (0)         | 0.9059 / 0.9895 (4)   |

QC pass against not QC pass stands in here for the spec's SNR class (SNR meaning signal-to-noise ratio); no split by
SNR itself was made. Cells that do not pass QC have a lower trace r1 than QC-pass
cells on every recording; their footprint cos is lower on five recordings and higher on `wl200`. On `wl24_01` and
`wl24_04` the cells under 4 px from a tile line and the cells in the border band have the lowest trace r1 (0.69 to
0.74), and on `wl24_01` also the cells 4 to 8 px away. On `wl200` and `motion` the cells under 4 px from a tile line
have a lower trace r1 than those over 16 px away (0.7731 against 0.8354, 0.9212 against 0.9672). On `plain` and `v4`
the groups differ by less than 0.01.

## Tile lines

| recording | arm         | n under 8 px | trace loss under 8 px | footprint loss under 8 px | n 8 px or more | trace loss 8 px or more | footprint loss 8 px or more | jump, raw | jump, factor arm |
| --------- | ----------- | ------------ | --------------------- | ------------------------- | -------------- | ----------------------- | --------------------------- | --------- | ---------------- |
| wl200     | `plain`     | 18           | 0.18959 (outside)     | 0.01314 (outside)         | 45             | 0.16617 (outside)       | 0.00955 (outside)           | 0.979     | 1.818            |
| wl200     | `overlap8`  | 18           | 0.20287 (outside)     | 0.01143 (outside)         | 45             | 0.21509 (outside)       | 0.01002 (outside)           | 0.979     | 0.949            |
| wl200     | `overlap16` | 18           | 0.22424 (outside)     | 0.00831 (outside)         | 45             | 0.22690 (outside)       | 0.01109 (outside)           | 0.979     | 0.951            |
| wl200     | `offset`    | 18           | 0.14112 (outside)     | 0.00556 (outside)         | 45             | 0.16362 (outside)       | 0.00733 (outside)           | 0.979     | 0.909            |
| wl24_01   | `plain`     | 37           | 0.23135 (outside)     | 0.06090 (outside)         | 21             | 0.13294 (outside)       | 0.01913 (outside)           | 1.150     | 1.095            |
| wl24_01   | `overlap8`  | 37           | 0.20485 (outside)     | 0.05984 (outside)         | 21             | 0.15020 (outside)       | 0.01681 (outside)           | 1.150     | 1.080            |
| wl24_01   | `overlap16` | 37           | 0.21652 (outside)     | 0.06233 (outside)         | 21             | 0.15782 (outside)       | 0.02397 (outside)           | 1.150     | 1.044            |
| wl24_01   | `offset`    | 37           | 0.21205 (outside)     | 0.06949 (outside)         | 21             | 0.14731 (outside)       | 0.02225 (outside)           | 1.150     | 1.079            |
| wl24_04   | `plain`     | 21           | 0.22963 (outside)     | 0.05673 (outside)         | 19             | 0.23283 (outside)       | 0.02168 (outside)           | 1.071     | 1.379            |
| wl24_04   | `overlap8`  | 21           | 0.24477 (outside)     | 0.03749 (outside)         | 19             | 0.26075 (outside)       | 0.02376 (outside)           | 1.071     | 1.145            |
| wl24_04   | `overlap16` | 21           | 0.23732 (outside)     | 0.04930 (outside)         | 19             | 0.27458 (outside)       | 0.02951 (outside)           | 1.071     | 1.165            |
| wl24_04   | `offset`    | 21           | 0.22344 (outside)     | 0.04561 (outside)         | 19             | 0.20875 (outside)       | 0.02908 (outside)           | 1.071     | 1.138            |
| plain     | `plain`     | 65           | 0.00537 (outside)     | 0.00161 (outside)         | 77             | 0.00472 (outside)       | 0.00052 (outside)           | 0.933     | 1.326            |
| plain     | `overlap16` | 65           | 0.00759 (outside)     | 0.00045 (outside)         | 77             | 0.01093 (outside)       | 0.00062 (outside)           | 0.933     | 0.934            |
| plain     | `offset`    | 65           | 0.00485 (outside)     | 0.00039 (outside)         | 77             | 0.00495 (outside)       | 0.00039 (outside)           | 0.933     | 0.968            |
| v4        | `plain`     | 87           | 0.01048 (outside)     | 0.00735 (outside)         | 115            | 0.00875 (outside)       | 0.00987 (outside)           | 0.895     | 0.957            |
| v4        | `overlap16` | 87           | 0.01073 (outside)     | 0.00628 (outside)         | 115            | 0.00992 (outside)       | 0.00956 (outside)           | 0.895     | 0.884            |
| v4        | `offset`    | 87           | 0.00981 (outside)     | 0.00642 (outside)         | 115            | 0.00860 (outside)       | 0.00961 (outside)           | 0.895     | 0.872            |
| motion    | `plain`     | 80           | 0.02809 (outside)     | 0.02305 (outside)         | 98             | 0.03683 (outside)       | 0.02051 (outside)           | 0.929     | 1.020            |
| motion    | `overlap16` | 80           | 0.03482 (outside)     | 0.02204 (outside)         | 98             | 0.03867 (outside)       | 0.01804 (outside)           | 0.929     | 0.962            |
| motion    | `offset`    | 80           | 0.03226 (outside)     | 0.02044 (outside)         | 98             | 0.03701 (outside)       | 0.01906 (outside)           | 0.929     | 0.942            |

Each row splits the QC-pass cells into those under 8 px from a tile line and those 8 px or more away, with the trace
and footprint loss and the verdict of each. The last two columns are the footprint jump at tile lines for `raw` and
for the factor arm (1 means the tile lines do not show). No tiling brings the near-line cells within the null on any
recording. The jump measure is not 1 for `raw` either (0.895 to 1.150), so a factor arm is compared with the raw value
of the same recording. A property of the `offset` layout, computed from its blending weights and not measured on cells:
where a line of one grid crosses a line of the other, a tile keeps a weight of up to about 0.5 on its own edge (the
overlap tilings at most about 0.004), so the two grids do not hide every tile line.

## Discover-time preprocessing

| recording | trace loss, plain | trace loss, plain_recal | footprint loss, plain | footprint loss, plain_recal | mean rank, plain | mean rank, plain_recal |
| --------- | ----------------- | ----------------------- | --------------------- | --------------------------- | ---------------- | ---------------------- |
| wl200     | 0.16617           | 0.16572                 | 0.01033               | 0.00882                     | 5.5              | 5.4                    |
| wl24_01   | 0.20011           | 0.06219                 | 0.04539               | 0.01449                     | 9.6              | 10.2                   |
| wl24_04   | 0.23123           | 0.07536                 | 0.04051               | 0.01060                     | 8.2              | 8.5                    |
| plain     | 0.00515           | 0.00287                 | 0.00085               | 0.00005                     | 4.2              | 4.1                    |
| v4        | 0.00944           | 0.00206                 | 0.00806               | 0.00000                     | 12.3             | 7.1                    |
| motion    | 0.03055           | 0.00165                 | 0.02274               | 0.00121                     | 5.6              | 5.5                    |

`plain` uses the factors of pass 1, which hold Discover's preprocessing as it was at each frame. `plain_recal` uses the
factors of the first replay, with the final flat field from frame 0 and with the running background floor and noise
map continued from the end of pass 1. On the three real recordings the first flat field map arrived at frame 2999 of
pass 1; the three synthetic sets got no map at all (0 updates in the run logs), so on them the difference between the
two arms is the settled running state alone. How much each part contributes on the real recordings was not measured. The recalibrated factors cut the trace loss by a
factor of 3 to 19 on `wl24_01`, `wl24_04`, `v4` and `motion`. They cut the footprint loss by a factor of 3 to 19 on
`wl24_01`, `wl24_04` and `motion`, and to 0.00000 on `v4`. On `plain` both losses fall too, from an already small value.
On `wl200` they change little. On `v4` the recalibrated factors also have a much lower mean rank (7.1 against 12.3).

## Extract alone

| recording | arm           | cells       | n   | trace r median | trace r 5th pct | lag-1 r median | lag-1 r 5th pct | footprint cos median |
| --------- | ------------- | ----------- | --- | -------------- | --------------- | -------------- | --------------- | -------------------- |
| wl200     | `x_plain`     | QC pass     | 62  | 0.7064         | 0.5032          | 0.8272         | 0.6721          | 1.0000               |
| wl200     | `x_plain`     | not QC pass | 10  | 0.5876         | 0.3072          | 0.7469         | 0.6209          | 1.0000               |
| wl200     | `x_overlap8`  | QC pass     | 62  | 0.7001         | 0.4770          | 0.8077         | 0.6366          | 1.0000               |
| wl200     | `x_overlap8`  | not QC pass | 10  | 0.5590         | 0.3030          | 0.7487         | 0.6360          | 1.0000               |
| wl200     | `x_overlap16` | QC pass     | 62  | 0.6730         | 0.4755          | 0.7917         | 0.6243          | 1.0000               |
| wl200     | `x_overlap16` | not QC pass | 10  | 0.5512         | 0.2954          | 0.7259         | 0.6483          | 1.0000               |
| wl200     | `x_offset`    | QC pass     | 62  | 0.7438         | 0.5368          | 0.8445         | 0.7002          | 1.0000               |
| wl200     | `x_offset`    | not QC pass | 10  | 0.6910         | 0.3171          | 0.8258         | 0.6695          | 1.0000               |
| wl24_01   | `x_plain`     | QC pass     | 52  | 0.8190         | 0.5230          | 0.9169         | 0.7140          | 1.0000               |
| wl24_01   | `x_plain`     | not QC pass | 50  | 0.7271         | 0.4267          | 0.8637         | 0.5677          | 1.0000               |
| wl24_01   | `x_overlap8`  | QC pass     | 52  | 0.8287         | 0.5363          | 0.9179         | 0.6945          | 1.0000               |
| wl24_01   | `x_overlap8`  | not QC pass | 50  | 0.7020         | 0.4305          | 0.8561         | 0.5795          | 1.0000               |
| wl24_01   | `x_overlap16` | QC pass     | 52  | 0.8187         | 0.5388          | 0.9151         | 0.6851          | 1.0000               |
| wl24_01   | `x_overlap16` | not QC pass | 50  | 0.7171         | 0.4380          | 0.8561         | 0.5841          | 1.0000               |
| wl24_01   | `x_offset`    | QC pass     | 52  | 0.8346         | 0.5464          | 0.9238         | 0.7293          | 1.0000               |
| wl24_01   | `x_offset`    | not QC pass | 50  | 0.7239         | 0.4338          | 0.8707         | 0.5761          | 1.0000               |
| wl24_04   | `x_plain`     | QC pass     | 36  | 0.8401         | 0.6778          | 0.9140         | 0.7819          | 1.0000               |
| wl24_04   | `x_plain`     | not QC pass | 28  | 0.7586         | 0.5555          | 0.8890         | 0.6559          | 1.0000               |
| wl24_04   | `x_overlap8`  | QC pass     | 36  | 0.8393         | 0.6645          | 0.9190         | 0.7802          | 1.0000               |
| wl24_04   | `x_overlap8`  | not QC pass | 28  | 0.7453         | 0.5631          | 0.8798         | 0.6213          | 1.0000               |
| wl24_04   | `x_overlap16` | QC pass     | 36  | 0.8364         | 0.6614          | 0.9115         | 0.7768          | 1.0000               |
| wl24_04   | `x_overlap16` | not QC pass | 28  | 0.7220         | 0.5435          | 0.8615         | 0.5997          | 1.0000               |
| wl24_04   | `x_offset`    | QC pass     | 36  | 0.8613         | 0.6844          | 0.9276         | 0.7839          | 1.0000               |
| wl24_04   | `x_offset`    | not QC pass | 28  | 0.7648         | 0.5136          | 0.8909         | 0.5709          | 1.0000               |
| plain     | `x_plain`     | QC pass     | 136 | 0.9871         | 0.8580          | 0.9949         | 0.9480          | 1.0000               |
| plain     | `x_plain`     | not QC pass | 52  | 0.9645         | 0.7591          | 0.9910         | 0.8724          | 1.0000               |
| plain     | `x_overlap16` | QC pass     | 136 | 0.9810         | 0.8266          | 0.9906         | 0.9096          | 1.0000               |
| plain     | `x_overlap16` | not QC pass | 52  | 0.9632         | 0.6853          | 0.9881         | 0.8031          | 1.0000               |
| v4        | `x_plain`     | QC pass     | 203 | 0.9887         | 0.8668          | 0.9931         | 0.8820          | 1.0000               |
| v4        | `x_plain`     | not QC pass | 16  | 0.9856         | 0.8054          | 0.9889         | 0.9050          | 1.0000               |
| v4        | `x_overlap16` | QC pass     | 203 | 0.9867         | 0.8652          | 0.9915         | 0.8795          | 1.0000               |
| v4        | `x_overlap16` | not QC pass | 16  | 0.9840         | 0.7716          | 0.9878         | 0.8668          | 1.0000               |
| motion    | `x_plain`     | QC pass     | 157 | 0.9603         | 0.5133          | 0.9807         | 0.4846          | 1.0000               |
| motion    | `x_plain`     | not QC pass | 105 | 0.9403         | 0.5924          | 0.9630         | 0.5673          | 1.0000               |
| motion    | `x_overlap16` | QC pass     | 157 | 0.9575         | 0.5136          | 0.9765         | 0.4811          | 1.0000               |
| motion    | `x_overlap16` | not QC pass | 105 | 0.9335         | 0.5816          | 0.9512         | 0.5568          | 1.0000               |

`x_<tiling>` against `x_raw`: Discover once, then Extract on the raw frames and on frames rebuilt from the factors, with
the same library. The footprints are identical by construction (footprint cos 1.0000 everywhere confirms it). "Cells"
is QC pass or not QC pass, used as a stand-in for the SNR class; no split by SNR itself was made. These arms have no
null, so they carry no verdict. On `wl24_01` and `wl24_04` the Extract-alone trace r1 of QC-pass cells is much higher
than in the full `plain` arm (0.9169 against 0.7999, 0.9140 against 0.7688). This suggests, but does not show, that
most of the loss there comes from the refine replays on factors. On `wl200` the two are about equal (0.8272 against
0.8338), which suggests that the loss there is already in Extract. Both are inferences: the two comparisons have
different references (`x_raw` and `raw`) and different QC-pass cells (52 against 58, 36 against 40, 62 against 63).

## Truth (synthetic sets)

| recording | comparison               | cells matched | median, reference | median, factor arm | paired n | paired difference median | paired difference 5th pct |
| --------- | ------------------------ | ------------- | ----------------- | ------------------ | -------- | ------------------------ | ------------------------- |
| wl200     | `plain` vs `raw`         | 25            | 0.8433            | 0.8512             | 25       | 0.0016                   | -0.0876                   |
| wl200     | `overlap8` vs `raw`      | 25            | 0.8433            | 0.8519             | 25       | 0.0003                   | -0.0843                   |
| wl200     | `overlap16` vs `raw`     | 25            | 0.8433            | 0.8103             | 25       | -0.0121                  | -0.1204                   |
| wl200     | `offset` vs `raw`        | 25            | 0.8433            | 0.8879             | 25       | 0.0027                   | -0.0342                   |
| wl200     | `plain_recal` vs `raw`   | 25            | 0.8433            | 0.8308             | 25       | -0.0032                  | -0.0932                   |
| wl200     | `x_plain` vs `x_raw`     | 24            | 0.8357            | 0.8692             | 24       | -0.0028                  | -0.0850                   |
| wl200     | `x_overlap8` vs `x_raw`  | 24            | 0.8357            | 0.8574             | 24       | -0.0057                  | -0.0812                   |
| wl200     | `x_overlap16` vs `x_raw` | 24            | 0.8357            | 0.8267             | 24       | -0.0170                  | -0.1197                   |
| wl200     | `x_offset` vs `x_raw`    | 24            | 0.8357            | 0.8805             | 24       | 0.0012                   | -0.0348                   |
| plain     | `plain` vs `raw`         | 180           | 0.9701            | 0.9775             | 180      | 0.0036                   | -0.0267                   |
| plain     | `overlap16` vs `raw`     | 180           | 0.9701            | 0.9716             | 180      | 0.0013                   | -0.0535                   |
| plain     | `offset` vs `raw`        | 180           | 0.9701            | 0.9784             | 180      | 0.0050                   | -0.0147                   |
| plain     | `plain_recal` vs `raw`   | 180           | 0.9701            | 0.9727             | 180      | 0.0012                   | -0.0313                   |
| plain     | `x_plain` vs `x_raw`     | 181           | 0.9707            | 0.9776             | 181      | 0.0042                   | -0.0199                   |
| plain     | `x_overlap16` vs `x_raw` | 181           | 0.9707            | 0.9731             | 181      | 0.0013                   | -0.0472                   |
| motion    | `plain` vs `raw`         | 145           | 0.4602            | 0.5974             | 145      | 0.0962                   | -0.1159                   |
| motion    | `overlap16` vs `raw`     | 145           | 0.4602            | 0.5988             | 145      | 0.0935                   | -0.1291                   |
| motion    | `offset` vs `raw`        | 145           | 0.4602            | 0.6004             | 145      | 0.0982                   | -0.1178                   |
| motion    | `plain_recal` vs `raw`   | 145           | 0.4602            | 0.4473             | 145      | -0.0051                  | -0.0795                   |
| motion    | `x_plain` vs `x_raw`     | 150           | 0.4799            | 0.6002             | 150      | 0.0849                   | -0.0465                   |
| motion    | `x_overlap16` vs `x_raw` | 150           | 0.4799            | 0.5917             | 150      | 0.0794                   | -0.0746                   |

Median trace correlation with the truth, for the reference run and the factor arm, over the cells with a truth unit
within 6 px after the offset. The paired difference is factor arm minus reference over the same cells. On `wl200` and
`plain` the medians of the factor arms are at most 0.033 below the reference, and mostly above it. The `motion` rows
should be read with care: the truth match there is unreliable (estimated frame offset 15.5 px, only 145 of 262 cells
matched). On `motion` the arms with pass-1 factors are above raw by 0.08 to 0.10 in the paired median, while
`plain_recal` is close to raw; see "Notes on the data".

## Cost of the tilings

| recording | arm           | mean rank | MB per 1000 frames | ratio to plain | compression ms per frame | ratio to plain |
| --------- | ------------- | --------- | ------------------ | -------------- | ------------------------ | -------------- |
| wl200     | `plain`       | 5.5       | 1.9                | 1.00           | 0.74                     | 1.00           |
| wl200     | `overlap8`    | 4.1       | 2.7                | 1.42           | 0.95                     | 1.28           |
| wl200     | `overlap16`   | 4.5       | 3.8                | 2.00           | 1.25                     | 1.69           |
| wl200     | `offset`      | 4.7       | 3.5                | 1.84           | 1.34                     | 1.81           |
| wl200     | `plain_recal` | 5.4       | 1.9                | 1.00           | 0.72                     | 0.97           |
| wl24_01   | `plain`       | 9.6       | 3.7                | 1.00           | 0.64                     | 1.00           |
| wl24_01   | `overlap8`    | 10.5      | 5.8                | 1.57           | 0.99                     | 1.55           |
| wl24_01   | `overlap16`   | 11.5      | 8.1                | 2.19           | 1.28                     | 2.00           |
| wl24_01   | `offset`      | 9.5       | 7.2                | 1.95           | 1.29                     | 2.02           |
| wl24_01   | `plain_recal` | 10.2      | 3.9                | 1.05           | 0.64                     | 1.00           |
| wl24_04   | `plain`       | 8.2       | 3.2                | 1.00           | 0.63                     | 1.00           |
| wl24_04   | `overlap8`    | 9.1       | 5.0                | 1.56           | 0.95                     | 1.51           |
| wl24_04   | `overlap16`   | 9.9       | 7.0                | 2.19           | 1.27                     | 2.02           |
| wl24_04   | `offset`      | 8.2       | 6.2                | 1.94           | 1.24                     | 1.97           |
| wl24_04   | `plain_recal` | 8.5       | 3.2                | 1.00           | 0.61                     | 0.97           |
| plain     | `plain`       | 4.2       | 14.9               | 1.00           | 5.47                     | 1.00           |
| plain     | `overlap16`   | 5.7       | 40.0               | 2.68           | 11.99                    | 2.19           |
| plain     | `offset`      | 4.3       | 30.2               | 2.03           | 10.51                    | 1.92           |
| plain     | `plain_recal` | 4.1       | 14.5               | 0.97           | 5.37                     | 0.98           |
| v4        | `plain`       | 12.3      | 37.4               | 1.00           | 5.47                     | 1.00           |
| v4        | `overlap16`   | 14.4      | 89.3               | 2.39           | 13.30                    | 2.43           |
| v4        | `offset`      | 12.2      | 75.3               | 2.01           | 12.08                    | 2.21           |
| v4        | `plain_recal` | 7.1       | 22.6               | 0.60           | 5.39                     | 0.99           |
| motion    | `plain`       | 5.6       | 18.9               | 1.00           | 5.57                     | 1.00           |
| motion    | `overlap16`   | 7.4       | 48.9               | 2.59           | 12.30                    | 2.21           |
| motion    | `offset`      | 5.6       | 37.5               | 1.98           | 11.16                    | 2.00           |
| motion    | `plain_recal` | 5.5       | 18.4               | 0.97           | 5.52                     | 0.99           |

Mean rank of the factors, factor megabytes (MB) per 1000 frames and compression milliseconds (ms) per frame, with the
ratio to `plain`. In the order the tiling rule uses (`plain`, `overlap8`, `offset`, `overlap16`), the size grows to
about 1.4 to 1.6 times, 1.8 to 2.0 times and 2.0 to 2.7 times `plain`. By compression time, `offset` is as slow as or
slower than `overlap16` on `wl200` and `wl24_01`. The `x_` arms compress the same frames with the same tiling and give
the same mean rank and size.

## Baseline timing and memory

### Native

Seconds per stage of the `raw` arm, from `qc_eval`'s own clock (`stage_times.tsv`). `pass1` is Discover, `pass2` is
the first refine replay, `extract` is the Extract pass. The table with every refine replay is in the appendix. The
stage columns do not add up to the wall time: the QC monitor, the held-out score and the checkpoint output are in no
column.

| recording | stage   | read | preprocess | solve | slow loop | wall   |
| --------- | ------- | ---- | ---------- | ----- | --------- | ------ |
| wl200     | pass1   | 0.28 | 32.73      | 1.56  | 25.04     | 64.21  |
| wl200     | pass2   | 0.07 | 13.85      | 1.95  | 22.25     | 42.91  |
| wl200     | extract | 0.07 | 13.36      | 1.83  | 0.00      | 15.27  |
| wl24_01   | pass1   | 0.19 | 30.73      | 3.09  | 26.88     | 68.18  |
| wl24_01   | pass2   | 0.07 | 13.55      | 4.56  | 25.78     | 54.09  |
| wl24_01   | extract | 0.07 | 13.58      | 5.17  | 0.00      | 18.85  |
| wl24_04   | pass1   | 0.07 | 32.42      | 2.53  | 25.05     | 66.02  |
| wl24_04   | pass2   | 0.07 | 13.73      | 3.45  | 24.30     | 47.93  |
| wl24_04   | extract | 0.07 | 13.57      | 4.01  | 0.00      | 17.68  |
| plain     | pass1   | 2.06 | 103.32     | 2.56  | 18.54     | 137.70 |
| plain     | pass2   | 0.36 | 55.39      | 3.35  | 22.92     | 91.37  |
| plain     | extract | 0.37 | 55.39      | 3.31  | 0.00      | 59.10  |
| v4        | pass1   | 2.05 | 103.49     | 3.85  | 19.19     | 144.38 |
| v4        | pass2   | 0.39 | 55.04      | 5.63  | 23.40     | 98.73  |
| v4        | extract | 0.39 | 55.65      | 5.70  | 0.00      | 61.78  |
| motion    | pass1   | 1.94 | 106.27     | 2.72  | 19.75     | 142.56 |
| motion    | pass2   | 0.38 | 55.10      | 4.41  | 24.40     | 97.20  |
| motion    | extract | 0.39 | 55.33      | 4.45  | 0.00      | 60.21  |

The `plain` arm against `raw`, wall seconds per stage. "Of which compress" is the compression time inside Discover.
The factor arms rebuild full frames from the factors and run the existing engine, so they measure the loss, not the
speed-up. Arm C (the factor engine) does not exist yet.

| recording | Discover raw | Discover plain | of which compress | refine mean raw | refine mean plain | Extract raw | Extract plain |
| --------- | ------------ | -------------- | ----------------- | --------------- | ----------------- | ----------- | ------------- |
| wl200     | 64.21        | 72.30          | 9.10              | 42.6            | 44.1              | 15.27       | 16.94         |
| wl24_01   | 68.18        | 75.39          | 7.93              | 58.5            | 60.7              | 18.85       | 21.09         |
| wl24_04   | 66.02        | 73.79          | 7.79              | 49.8            | 52.7              | 17.68       | 19.91         |
| plain     | 137.70       | 176.94         | 33.83             | 97.4            | 115.6             | 59.10       | 65.64         |
| v4        | 144.38       | 178.27         | 33.84             | 99.8            | 110.5             | 61.78       | 71.78         |
| motion    | 142.56       | 172.99         | 34.37             | 98.2            | 105.5             | 60.21       | 67.59         |

The factor arms are slower than raw at every stage. The table gives the extra time of `plain` over `raw` in percent,
per stage (for the refine replays, the range over the replays). On the 600 px recordings Discover takes 21 to 28
percent longer (including about 34 s of compression), the refine replays 7 to 27 percent and Extract 11 to 16 percent.
On the 200 px recordings the figures are 11 to 13, 1 to 8 and 11 to 13 percent. The runs shared the machine, so these
are rough.

| recording | Discover | refine passes | Extract |
| --------- | -------- | ------------- | ------- |
| wl200     | 13       | 2 to 6        | 11      |
| wl24_01   | 11       | 1 to 7        | 12      |
| wl24_04   | 12       | 4 to 8        | 13      |
| plain     | 28       | 11 to 27      | 11      |
| v4        | 23       | 10 to 12      | 16      |
| motion    | 21       | 7 to 8        | 12      |

Wall seconds and peak memory (MB) per arm. The wall times are from runs that shared the machine (2 or 3 at once), so
they are rough.

**Peak memory overstates the factor arms.** A probe (200 px, 1800 frames) showed the factor dump at 806 MB against
214 MB with the macOS allocator's large-block cache switched off (`MallocLargeCache=0`), with byte-identical factors;
raw was 238 MB. The extra is freed chunk buffers that the allocator keeps. Reusing one buffer is phase 1 work.

| arm           | wl200      | wl24_01    | wl24_04    | plain      | v4         | motion     |
| ------------- | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `raw`         | 294 / 263  | 380 / 259  | 333 / 246  | 395 / 1227 | 409 / 1153 | 403 / 1195 |
| `null_lo`     | 257 / 245  | 326 / 269  | 283 / 242  | 383 / 1221 | 396 / 1152 | 391 / 1196 |
| `null_hi`     | 371 / 258  | 479 / 267  | 417 / 240  | not run    | not run    | not run    |
| `plain`       | 310 / 809  | 400 / 795  | 358 / 794  | 477 / 2085 | 474 / 1965 | 455 / 2035 |
| `overlap8`    | 314 / 1067 | 414 / 1054 | 369 / 1050 | not run    | not run    | not run    |
| `overlap16`   | 319 / 1344 | 422 / 1348 | 373 / 1330 | 536 / 2786 | 560 / 2826 | 522 / 2726 |
| `offset`      | 317 / 854  | 417 / 858  | 360 / 855  | 483 / 2517 | 550 / 2402 | 504 / 2449 |
| `plain_recal` | 299 / 808  | 388 / 765  | 335 / 795  | 430 / 1782 | 472 / 1703 | 446 / 1644 |
| `x_raw`       | 79 / 246   | 85 / 231   | 83 / 246   | 199 / 1159 | 208 / 1056 | 198 / 1113 |
| `x_plain`     | 91 / 801   | 96 / 796   | 94 / 793   | 239 / 2080 | 251 / 1968 | 239 / 2012 |
| `x_overlap8`  | 95 / 1051  | 102 / 1049 | 99 / 1068  | not run    | not run    | not run    |
| `x_overlap16` | 98 / 1340  | 108 / 1330 | 103 / 1326 | 280 / 2838 | 313 / 2811 | 282 / 3017 |
| `x_offset`    | 97 / 860   | 107 / 871  | 101 / 861  | not run    | not run    | not run    |

### Browser

**Correction (18 Nov 2026, evening).** These browser runs (18 Nov, 11:42 to 12:13) used the driver's default port 4181. A static server of another checkout had held that port since 16 Nov, 22:23, serving a v2.19.1 build. So these
stage times were very probably measured on v2.19.1, not on the phase 0 branch. This is inferred from the port and the
server's start time; it was not re-measured on that build. The `?compress` runs of that time were also exposed to a
Chrome fault that can stop compression partway without an error. The `outcome` column below reads `done / done` in
every row, but it records the stage, not the compression, so it could not show such a stop; the driver did not yet
record the compress status. Re-measured numbers on the right build, and the fault and its fix, are in
`results/2026-11-18-factor-phase1.md`. The native results of this report, which carried its gate decision, are not
affected.

Whole recordings in Chrome, one refine run each, one run at a time, after the native arms had ended. `?compress` adds
window compression in a worker of its own. It also starts a back-fill once the recording is read, the final library is
out and every window is compressed: the compress worker rebuilds the windows from the factors and solves the traces of
the whole recording again with that library. This runs on its own worker and can overlap Refine. Refine and Extract
themselves read the raw frames in both runs. Seconds are from the app's own stage records in each export; fps in the
table means frames per second.

| recording | stage    | outcome     | frames | seconds, default | seconds, ?compress | ratio | cells, default | cells, ?compress | fps default | fps ?compress |
| --------- | -------- | ----------- | ------ | ---------------- | ------------------ | ----- | -------------- | ---------------- | ----------- | ------------- |
| wl24_01   | discover | done / done | 40234  | 33.0             | 34.3               | 1.04  | 84             | 90               | 1219        | 1173          |
| wl24_01   | refine   | done / done | 40234  | 30.4             | 29.1               | 0.96  | 84             | 90               | 1323        | 1385          |
| wl24_01   | extract  | done / done | 40234  | 29.9             | 29.6               | 0.99  | 84             | 90               | 1348        | 1357          |
| v4        | discover | done / done | 23711  | 155.4            | 195.7              | 1.26  | 825            | 839              | 153         | 121           |
| v4        | refine   | done / done | 23711  | 220.2            | 225.9              | 1.03  | 825            | 839              | 108         | 105           |
| v4        | extract  | done / done | 23711  | 205.5            | 210.0              | 1.02  | 825            | 839              | 115         | 113           |

Two unrelated single-thread jobs started on the machine at about 12:07. The last third of Refine and all of Extract of
`v4` with `?compress` (12:01 to 12:13) shared the machine with them; the other three runs did not. The cell counts
differ between default and `?compress` (84 against 90, 825 against 839), so the frames per second are not a
like-for-like comparison. With that caveat, compression added about 4 percent to Discover on `wl24_01` and about 26
percent on `v4` (void, see the correction note above).

## Remedies: the rank cut (200 px recordings)

Run after the tables above, to find where the trace loss of the 200 px recordings comes from. Each arm is
`plain_recal` (plain tiling, factors of the first replay) with another setting of the compressor, set by the `qc_eval`
flags `--factors-rho-min`, `--factors-z`, `--factors-k0`, `--factors-max-rank` and `--factors-n-iter`, which were added
for this. The compressor keeps a component when the lag-1 autocorrelation of its time course exceeds the cut; the
default cut is 0.2, the default starting rank is 40 and the randomized SVD runs one power iteration. The `recal_r`
arms keep a fixed number of components per tile, the largest by variance, with no cut. `recal_full` has no cut and
keeps every component up to the largest rank of 300. Same scale and budget as above; the reference is the same `raw`
run.

| recording | arm           | cut                     | mean rank | MB per 1000 frames | compression ms per frame | trace loss (lag 1) | footprint loss | footprint jump |
| --------- | ------------- | ----------------------- | --------- | ------------------ | ------------------------ | ------------------ | -------------- | -------------- |
| wl200     | `plain_recal` | 0.2 (default)           | 5.4       | 1.9                | 0.72                     | 0.1657             | 0.0088         | 1.850          |
| wl200     | `recal_iter2` | 0.2, two SVD iterations | 5.8       | 2.1                | 1.00                     | 0.1165             | 0.0063         | 1.738          |
| wl200     | `recal_rho0`  | 0.16                    | 6.8       | 2.1                | 0.83                     | 0.1615             | 0.0099         | 1.822          |
| wl200     | `recal_k80`   | 0.2, starting rank 80   | 6.0       | 2.1                | 1.57                     | 0.1240             | 0.0074         | 1.815          |
| wl200     | `recal_z2`    | 0.08                    | 16.0      | 4.1                | 1.77                     | 0.1334             | 0.0071         | 1.730          |
| wl200     | `recal_r10`   | none, rank 10           | 10.0      | 3.6                | 0.27                     | 0.2260             | 0.0126         | 1.757          |
| wl200     | `recal_r20`   | none, rank 20           | 20.0      | 6.9                | 0.38                     | 0.1543             | 0.0095         | 1.825          |
| wl200     | `recal_r40`   | none, rank 40           | 40.0      | 13.5               | 0.65                     | 0.1021             | 0.0063         | 1.706          |
| wl200     | `recal_r80`   | none, rank 80           | 78.9      | 26.6               | 1.42                     | 0.0497             | 0.0044         | 1.513          |
| wl200     | `recal_full`  | none, rank up to 300    | 285.2     | 98.4               | 26.11                    | 0.0028             | 0.0010         | 1.140          |
| wl24_01   | `plain_recal` | 0.2 (default)           | 10.2      | 3.9                | 0.64                     | 0.0622             | 0.0145         | 1.323          |
| wl24_01   | `recal_iter2` | 0.2, two SVD iterations | 11.4      | 4.3                | 0.94                     | 0.0444             | 0.0097         | 1.325          |
| wl24_01   | `recal_rho0`  | 0.16                    | 12.3      | 4.5                | 0.70                     | 0.0561             | 0.0126         | 1.248          |
| wl24_01   | `recal_k80`   | 0.2, starting rank 80   | 11.2      | 4.2                | 1.49                     | 0.0493             | 0.0117         | 1.281          |
| wl24_01   | `recal_z2`    | 0.08                    | 26.4      | 8.7                | 3.66                     | 0.0368             | 0.0080         | 1.214          |
| wl24_01   | `recal_r10`   | none, rank 10           | 10.0      | 3.6                | 0.26                     | 0.0977             | 0.0150         | 1.225          |
| wl24_01   | `recal_r20`   | none, rank 20           | 20.0      | 6.9                | 0.36                     | 0.0597             | 0.0117         | 1.177          |
| wl24_01   | `recal_r40`   | none, rank 40           | 40.0      | 13.5               | 0.64                     | 0.0363             | 0.0074         | 1.175          |
| wl24_01   | `recal_r80`   | none, rank 80           | 78.9      | 26.6               | 1.43                     | 0.0189             | 0.0047         | 1.240          |
| wl24_01   | `recal_full`  | none, rank up to 300    | 285.2     | 98.4               | 28.83                    | 0.0025             | 0.0016         | 1.176          |
| wl24_04   | `plain_recal` | 0.2 (default)           | 8.5       | 3.2                | 0.61                     | 0.0754             | 0.0106         | 1.468          |
| wl24_04   | `recal_iter2` | 0.2, two SVD iterations | 9.3       | 3.5                | 0.90                     | 0.0556             | 0.0084         | 1.507          |
| wl24_04   | `recal_rho0`  | 0.16                    | 10.3      | 3.7                | 0.71                     | 0.0701             | 0.0096         | 1.423          |
| wl24_04   | `recal_k80`   | 0.2, starting rank 80   | 9.5       | 3.6                | 1.54                     | 0.0603             | 0.0104         | 1.478          |
| wl24_04   | `recal_z2`    | 0.08                    | 22.7      | 7.4                | 3.89                     | 0.0456             | 0.0072         | 1.308          |
| wl24_04   | `recal_r10`   | none, rank 10           | 10.0      | 3.6                | 0.29                     | 0.1156             | 0.0171         | 1.477          |
| wl24_04   | `recal_r20`   | none, rank 20           | 20.0      | 6.9                | 0.40                     | 0.0752             | 0.0106         | 1.399          |
| wl24_04   | `recal_r40`   | none, rank 40           | 40.0      | 13.5               | 0.70                     | 0.0478             | 0.0082         | 1.375          |
| wl24_04   | `recal_r80`   | none, rank 80           | 78.9      | 26.6               | 1.43                     | 0.0255             | 0.0051         | 1.311          |
| wl24_04   | `recal_full`  | none, rank up to 300    | 285.2     | 98.4               | 28.99                    | 0.0022             | 0.0021         | 1.171          |

The table gives the cost and the loss of the QC-pass cells per arm. The footprint jump of `raw` is 0.979 on `wl200`,
1.150 on `wl24_01` and 1.071 on `wl24_04`. All 27 runs ended with return code 0. The first four remedy arms ran four
at once, the others three at once beside an unrelated job, so the compression times are not comparable to the last
digit. For scale, the 8-bit frames of these recordings are 40 MB per 1000 frames; the factors are stored as 32-bit
floats.

- The rank cut is where the loss arises. Without a cut the trace loss is 0.002 to 0.003 on all three recordings.
  `recal_full` is a ceiling, not an option: at 98 MB per 1000 frames it is larger than the frames.
- The loss has no knee. With a fixed rank it falls steadily: each doubling of the rank from 10 to 80 removes a third to
  a half of the trace loss, and rank 80, at two thirds of the size of the frames, still loses 0.02 to 0.05.
- The autocorrelation cut picks components better than their variance does. The default cut comes within 0.012 of the
  trace loss of a fixed rank of 20 at 28 to 57 percent of its size. On the wireless recordings the cut at 0.08 reaches that of a
  fixed rank of 40 at 55 to 64 percent of its size.
- A looser cut closes little. The cut at 0.08 keeps about 2.5 to 3 times the components and twice the bytes, and
  removes a fifth of the trace loss on `wl200` and about two fifths on the wireless recordings.
- A second power iteration of the SVD is the cheapest gain measured. It removes 26 to 30 percent of the trace loss
  for about 10 percent more bytes and 40 to 50 percent more compression time. A starting rank of 80 removes 20 to 25
  percent and more than doubles the compression time. Both point to the accuracy of the randomized SVD as a limit of
  the default setting; the SVD's accuracy was not measured directly.

Truth on `wl200`, same cells (the truth correlation of `raw` has a median of 0.8433):

| arm (wl200)   | matched cells | truth correlation, arm minus raw, median | 5th percentile |
| ------------- | ------------- | ---------------------------------------- | -------------- |
| `plain_recal` | 25            | -0.0032                                  | -0.0932        |
| `recal_iter2` | 25            | 0.0079                                   | -0.0421        |
| `recal_rho0`  | 25            | -0.0032                                  | -0.0886        |
| `recal_k80`   | 25            | 0.0014                                   | -0.0545        |
| `recal_z2`    | 25            | -0.0030                                  | -0.0737        |
| `recal_r10`   | 25            | -0.0167                                  | -0.1702        |
| `recal_r20`   | 25            | -0.0105                                  | -0.1225        |
| `recal_r40`   | 25            | -0.0048                                  | -0.0698        |
| `recal_r80`   | 25            | 0.0012                                   | -0.0393        |
| `recal_full`  | 25            | 0.0040                                   | -0.0076        |

With the autocorrelation cut the median cell is as close to the truth as with raw frames, in every arm. The fixed
ranks of 10 and 20 are worse in the median too. What a higher rank or a more accurate SVD improves is the worst
cells. With 25 matched cells the 5th percentile rests on one or two cells. The wireless recordings have no truth, so
whether their trace loss of 0.04 to 0.08 is lost signal or removed noise is not known.

Not measured: combinations (two power iterations with a looser cut), three or more power iterations, the 600 px
recordings, and any tiling other than plain.

## Before v2.20.0

The first full set of runs used the version before v2.20.0, whose refine gate needed a held-out gain with z above 3
(`refine_z` 3). v2.20.0 accepts any held-out gain (`refine_z` 0). Same scale and budget. `plain` against `raw`, QC-pass
cells:

| recording | trace loss, old gate | trace loss, new gate | footprint loss, old gate | footprint loss, new gate | jump raw / plain, old gate | jump raw / plain, new gate | QC-pass n old | QC-pass n new |
| --------- | -------------------- | -------------------- | ------------------------ | ------------------------ | -------------------------- | -------------------------- | ------------- | ------------- |
| wl200     | 0.17912              | 0.16617              | 0.01164                  | 0.01033                  | 1.250 / 1.648              | 0.979 / 1.818              | 63            | 63            |
| wl24_01   | 0.16581              | 0.20011              | 0.05340                  | 0.04539                  | 1.099 / 1.162              | 1.150 / 1.095              | 63            | 58            |
| wl24_04   | 0.17782              | 0.23123              | 0.04412                  | 0.04051                  | 1.128 / 1.358              | 1.071 / 1.379              | 44            | 40            |
| plain     | 0.00531              | 0.00515              | 0.00000                  | 0.00085                  | 1.003 / 1.146              | 0.933 / 1.326              | 137           | 142           |
| v4        | 0.01170              | 0.00944              | 0.00961                  | 0.00806                  | 0.822 / 0.908              | 0.895 / 0.957              | 216           | 202           |
| motion    | 0.04719              | 0.03055              | 0.02437                  | 0.02274                  | 0.859 / 0.992              | 0.929 / 1.020              | 167           | 178           |

The jump columns give raw's own jump beside the jump of `plain`, because raw's value changed between the versions too
(on `wl200` from 1.250 to 0.979). The new gate lowers the trace loss on `wl200`, `v4` and `motion`, leaves it about the
same on `plain` and raises it on `wl24_01` and `wl24_04`. The verdicts do not change: `outside` on both measures, except the footprint loss on `plain`, which was `within` (loss 0.00000) at
the old gate and is `outside` now. One default-budget comparison exists, on the old gate only (`wl200`, `plain` against
`raw`, 12000 frames, 5 replays): trace loss 0.18230 and footprint loss 0.01089 against a null of 0.00000, truth
correlation median 0.7608 for raw and 0.8486 for `plain` over 28 cells (paired difference median -0.0012, 5th percentile
-0.1006), footprint jump 0.930 for raw and 1.886 for `plain`.

## Notes on the data

- `motion`: the truth offset is large, (dy, dx) = (+15.5, +0.7) px, and only 145 of 262 cells match a truth unit. The
  raw truth correlation median is low (0.4602). The arms with pass-1 factors reach about 0.60, `plain_recal` 0.4473.
  This was not investigated; the truth numbers on `motion` should be read with care.
- Browser: the driver's own status file gives other stage times than the app's stage records (for example Discover of
  `wl24_01` default 15.0 s against 33.0 s). The driver polls in steps of about 15 s, so its times are coarse. The table
  uses the app's records (void, see the correction note in "Browser").
- The browser table uses the four cala exports: the CaDecon exports hold no stage records
  (`tools/cala-eval/stage_times.py` prints "no stage records" for them) (void, see the correction note in "Browser").
- QC pass is read from the reference run of each comparison, so `x_raw` and `raw` count slightly different QC-pass cells
  (for example 62 against 63 on `wl200`).

## What was not measured

- Arm C (the factor engine) does not exist yet. The speed-up of Refine and Extract on factors is not measured; the factor
  arms only measure the loss.
- The motion band is only reported, not gated. `plain` and `v4` have no cell in it, `motion` has 4.
- `lowsnr` and `dense` were not run. The 600 px recordings have no `null_hi`, `overlap8`, `x_overlap8` or `x_offset`,
  and their null is a single run.
- Only the first 12000 (200 px) or 6000 (600 px) frames were used, with 5 or 2 refine replays. Effects that need long
  recordings (late rank growth, slow drift) are not covered.
- The slow-loop budget was a tenth of the default. Nothing was measured at the default budget on v2.20.0.
- Refine "until settled" with its iteration count was not measured; the replays ran a fixed number of times.
- Recall and precision against the truth were not computed, only the trace correlation of matched cells.
- Peak memory was measured per run, not per stage. Frames of history per gigabyte were not computed.
- The `x_` arms have no null run, so their loss has no verdict.
- Each browser configuration ran once; there is no spread for the browser times (void, see the correction note in
  "Browser").
- The spec's remedies for dim cells (lower `rho_min`, higher starting rank) were not tried.

## Appendix: native stage times of the `raw` arm

Seconds per stage for every pass, from `qc_eval`'s own clock (`stage_times.tsv`). `pass1` is Discover, `pass2` and later
are the refine replays, `extract` is the Extract pass.

| recording | stage   | read | preprocess | solve | slow loop | wall   |
| --------- | ------- | ---- | ---------- | ----- | --------- | ------ |
| wl200     | pass1   | 0.28 | 32.73      | 1.56  | 25.04     | 64.21  |
| wl200     | pass2   | 0.07 | 13.85      | 1.95  | 22.25     | 42.91  |
| wl200     | pass3   | 0.07 | 13.58      | 1.94  | 21.91     | 42.35  |
| wl200     | pass4   | 0.07 | 13.57      | 1.97  | 21.86     | 42.54  |
| wl200     | pass5   | 0.07 | 13.55      | 1.98  | 21.82     | 42.50  |
| wl200     | pass6   | 0.07 | 13.56      | 2.00  | 22.07     | 42.84  |
| wl200     | extract | 0.07 | 13.36      | 1.83  | 0.00      | 15.27  |
| wl24_01   | pass1   | 0.19 | 30.73      | 3.09  | 26.88     | 68.18  |
| wl24_01   | pass2   | 0.07 | 13.55      | 4.56  | 25.78     | 54.09  |
| wl24_01   | pass3   | 0.07 | 13.55      | 4.89  | 26.96     | 56.88  |
| wl24_01   | pass4   | 0.07 | 13.58      | 5.23  | 27.96     | 59.25  |
| wl24_01   | pass5   | 0.07 | 13.67      | 5.50  | 28.32     | 60.48  |
| wl24_01   | pass6   | 0.07 | 13.68      | 5.70  | 28.93     | 61.73  |
| wl24_01   | extract | 0.07 | 13.58      | 5.17  | 0.00      | 18.85  |
| wl24_04   | pass1   | 0.07 | 32.42      | 2.53  | 25.05     | 66.02  |
| wl24_04   | pass2   | 0.07 | 13.73      | 3.45  | 24.30     | 47.93  |
| wl24_04   | pass3   | 0.07 | 13.73      | 3.70  | 24.34     | 48.96  |
| wl24_04   | pass4   | 0.07 | 13.83      | 3.87  | 24.57     | 50.08  |
| wl24_04   | pass5   | 0.07 | 13.74      | 4.08  | 24.72     | 50.67  |
| wl24_04   | pass6   | 0.07 | 13.73      | 4.16  | 25.02     | 51.34  |
| wl24_04   | extract | 0.07 | 13.57      | 4.01  | 0.00      | 17.68  |
| plain     | pass1   | 2.06 | 103.32     | 2.56  | 18.54     | 137.70 |
| plain     | pass2   | 0.36 | 55.39      | 3.35  | 22.92     | 91.37  |
| plain     | pass3   | 0.41 | 61.98      | 3.85  | 26.38     | 103.42 |
| plain     | extract | 0.37 | 55.39      | 3.31  | 0.00      | 59.10  |
| v4        | pass1   | 2.05 | 103.49     | 3.85  | 19.19     | 144.38 |
| v4        | pass2   | 0.39 | 55.04      | 5.63  | 23.40     | 98.73  |
| v4        | pass3   | 0.38 | 55.36      | 5.93  | 23.91     | 100.88 |
| v4        | extract | 0.39 | 55.65      | 5.70  | 0.00      | 61.78  |
| motion    | pass1   | 1.94 | 106.27     | 2.72  | 19.75     | 142.56 |
| motion    | pass2   | 0.38 | 55.10      | 4.41  | 24.40     | 97.20  |
| motion    | pass3   | 0.38 | 55.37      | 4.61  | 25.19     | 99.28  |
| motion    | extract | 0.39 | 55.33      | 4.45  | 0.00      | 60.21  |
