# E7: footprint convergence (11 Nov 2026)

Binary: this branch on main a8a333d (`--slow-seed 1 --batch 8 --budget 30000000`).
Runs: `static_s5` and `motion_s5` (9600 frames), and the real workshop recording
(18000 frames, `--motion`). One run each, so the numbers show the
size of the effect, not a comparison.

## What is measured

At each checkpoint (every 300 frames, 15 s) and for lag k = 1 and 4
checkpoints, every cell present at both checkpoints gets
`‖a_v − a_{v−k}‖ / ‖a_v‖` on its filtered footprint (`convergence.tsv`).

Noise level: the **split-half noise of the cell's running footprint
statistics**: half the difference between the two halves' estimates over the
footprint norm, on the cell's support (`SlowLoop::footprint_noise`). It was
chosen because the slow loop already keeps the halves, it costs no extra pass,
and it is scale free. It is conservative: the footprint at `v − k` shares most
of its data with the one at `v`, so the noise of their difference is smaller
than this. `fpstats` SE alone is a noise-per-pixel figure that would need the
pixel noise map, and the hold-out folds are not kept per footprint. A cell
"changes" when its change exceeds this level. Because the noise is large
(10 % to 25 % of the footprint norm at the end), "share > noise" is a lower
bound; "share > 10 %" (a change independent of noise) is shown next to it. A
change below 0.1 % is rounding of a rescaled footprint (about a third of the
cells show it every checkpoint) and is not counted as a move.

## Result at the last checkpoint

| run              | cells | lag 1: share > noise | lag 1: share > 10 % | lag 4: share > noise | lag 4: share > 10 % | lag 4: median change among moved cells |
| ---------------- | ----- | -------------------- | ------------------- | -------------------- | ------------------- | -------------------------------------- |
| static s5 (9600) | 483   | 0.025                | 0.031               | 0.107                | 0.135               | 0.17                                   |
| motion s5 (9600) | 503   | 0.020                | 0.024               | 0.096                | 0.106               | 0.28                                   |
| real (18000)     | 713   | 0.007                | 0.018               | 0.077                | 0.109               | 0.47                                   |

The median change over all cells is 0 at every checkpoint and lag (most
footprints do not change in a minute); `conv_med1` and `conv_med4` are 0.

## How settled is the library

- A footprint changes in bursts, and when it does it changes a lot: among cells
  that moved over the last minute the median change is 17 % to 47 % of the
  footprint norm. About one cell in ten (11 % on real data, 11 % to 14 % on
  sims) changed by more than 10 % in the last minute, and 8 % to 11 % changed
  by more than their own noise.
- On sims the library settles: the share of cells changing by more than 10 %
  over a minute falls from 34 % (frame 2400) to 13 % (9600) on static and from
  32 % to 11 % on motion, and the share changing by more than 10 % per 15 s falls from 11 % to 3 % (static) and from 6 % to 2 % (motion).
- On real data it settles much less. Over a minute the share changing by more
  than 10 % is 16 % at frame 2400 and **still 11 % at 18000**; the share
  changing by more than noise goes 10 % to 8 %. The decline is slow and
  noisy (14 % at 4800, 10 % at 9600, 11 % at 12000 and at 18000): a 15 to 20
  minute single pass does not reach a settled library, as the PI saw.
- Age: on real data cells of every age bin keep changing at similar rates
  (lag 4, last checkpoint: 10 % for 1200-3000 frames old, 9 % for 3000-6000,
  7 % for 6000 and older). On sims the oldest cells (6000 and older) are also
  at 8 % to 10 %. There is no age beyond which cells stop changing; the
  young bins hold few cells (tens), so those shares are noisy.
- Sims against real: the shares of big changes are alike (11 % to 14 % against
  11 %), but the real noise level is 2.5 times higher (median 0.25 against 0.10),
  so fewer real changes exceed it (8 % against 10 % to 11 %) and the real
  curve is flat where the sims fall.

Limits: one run per condition; the noise is a half-data estimate; only cells
present at both checkpoints are counted, so cells added or deleted in between
(churn) are not in these shares.

# Curves

Every 1200 frames. "share moved" is the share of cells that changed by more
than 0.1 %, "median if moved" the median change among them, "share > 10 %" the
share that changed by more than 10 % of the norm, "share > noise" the share
above their split-half noise, then that share by age bin (frames since birth;
cells in brackets).

## static_s5, lag 1 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200  | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | ---------- | ------------- | ------------- | ---------- |
| 1200  | 247   | 0.13        | 0.632           | 0.13       | 0.666        | 0.07          | 0.07 (222) | nan (0)       | nan (0)       | nan (0)    |
| 2400  | 360   | 0.11        | 0.563           | 0.11       | 0.316        | 0.07          | 0.03 (68)  | 0.08 (286)    | nan (0)       | nan (0)    |
| 3600  | 407   | 0.07        | 0.472           | 0.06       | 0.201        | 0.05          | 0.07 (30)  | 0.05 (174)    | 0.05 (189)    | nan (0)    |
| 4800  | 435   | 0.06        | 0.256           | 0.05       | 0.168        | 0.03          | 0.00 (23)  | 0.00 (72)     | 0.03 (332)    | nan (0)    |
| 6000  | 449   | 0.07        | 0.276           | 0.06       | 0.145        | 0.04          | 0.06 (17)  | 0.04 (50)     | 0.03 (379)    | nan (0)    |
| 7200  | 454   | 0.05        | 0.285           | 0.04       | 0.129        | 0.03          | 0.14 (7)   | 0.03 (33)     | 0.02 (134)    | 0.03 (277) |
| 8400  | 468   | 0.05        | 0.213           | 0.04       | 0.120        | 0.03          | 0.00 (10)  | 0.09 (22)     | 0.03 (79)     | 0.03 (353) |
| 9600  | 483   | 0.05        | 0.121           | 0.03       | 0.110        | 0.02          | 0.00 (13)  | 0.05 (20)     | 0.02 (56)     | 0.03 (392) |

## static_s5, lag 4 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200 | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | --------- | ------------- | ------------- | ---------- |
| 2400  | 281   | 0.34        | 0.567           | 0.34       | 0.248        | 0.27          | nan (0)   | 0.27 (278)    | nan (0)       | nan (0)    |
| 3600  | 368   | 0.27        | 0.499           | 0.27       | 0.182        | 0.21          | nan (0)   | 0.23 (171)    | 0.19 (189)    | nan (0)    |
| 4800  | 406   | 0.22        | 0.396           | 0.19       | 0.161        | 0.14          | nan (0)   | 0.18 (72)     | 0.13 (332)    | nan (0)    |
| 6000  | 432   | 0.18        | 0.370           | 0.16       | 0.140        | 0.12          | nan (0)   | 0.22 (50)     | 0.11 (379)    | nan (0)    |
| 7200  | 446   | 0.18        | 0.434           | 0.15       | 0.126        | 0.13          | nan (0)   | 0.24 (33)     | 0.13 (134)    | 0.12 (277) |
| 8400  | 456   | 0.19        | 0.254           | 0.16       | 0.118        | 0.12          | nan (0)   | 0.18 (22)     | 0.10 (79)     | 0.12 (353) |
| 9600  | 467   | 0.18        | 0.165           | 0.13       | 0.108        | 0.11          | nan (0)   | 0.21 (19)     | 0.09 (56)     | 0.10 (392) |

## motion_s5, lag 1 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200  | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | ---------- | ------------- | ------------- | ---------- |
| 1200  | 235   | 0.13        | 0.530           | 0.13       | 0.506        | 0.10          | 0.10 (205) | nan (0)       | nan (0)       | nan (0)    |
| 2400  | 369   | 0.07        | 0.501           | 0.06       | 0.265        | 0.05          | 0.04 (74)  | 0.06 (285)    | nan (0)       | nan (0)    |
| 3600  | 417   | 0.09        | 0.441           | 0.07       | 0.175        | 0.06          | 0.03 (30)  | 0.07 (199)    | 0.05 (184)    | nan (0)    |
| 4800  | 451   | 0.06        | 0.260           | 0.04       | 0.147        | 0.02          | 0.03 (32)  | 0.01 (75)     | 0.02 (337)    | nan (0)    |
| 6000  | 471   | 0.07        | 0.425           | 0.06       | 0.128        | 0.04          | 0.06 (16)  | 0.09 (54)     | 0.03 (395)    | nan (0)    |
| 7200  | 488   | 0.06        | 0.193           | 0.06       | 0.112        | 0.04          | 0.18 (11)  | 0.02 (41)     | 0.04 (157)    | 0.04 (271) |
| 8400  | 492   | 0.07        | 0.298           | 0.06       | 0.105        | 0.03          | 0.00 (5)   | 0.03 (33)     | 0.02 (85)     | 0.04 (363) |
| 9600  | 503   | 0.04        | 0.199           | 0.02       | 0.099        | 0.02          | 0.10 (10)  | 0.05 (20)     | 0.01 (72)     | 0.02 (398) |

## motion_s5, lag 4 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200 | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | --------- | ------------- | ------------- | ---------- |
| 2400  | 279   | 0.33        | 0.563           | 0.32       | 0.204        | 0.28          | nan (0)   | 0.28 (279)    | nan (0)       | nan (0)    |
| 3600  | 381   | 0.28        | 0.524           | 0.28       | 0.169        | 0.23          | nan (0)   | 0.28 (196)    | 0.18 (184)    | nan (0)    |
| 4800  | 415   | 0.21        | 0.413           | 0.20       | 0.140        | 0.15          | nan (0)   | 0.23 (74)     | 0.13 (337)    | nan (0)    |
| 6000  | 453   | 0.18        | 0.405           | 0.17       | 0.124        | 0.13          | nan (0)   | 0.13 (54)     | 0.13 (395)    | nan (0)    |
| 7200  | 472   | 0.17        | 0.434           | 0.15       | 0.110        | 0.13          | nan (0)   | 0.21 (39)     | 0.13 (157)    | 0.12 (271) |
| 8400  | 485   | 0.17        | 0.226           | 0.15       | 0.104        | 0.11          | nan (0)   | 0.16 (31)     | 0.08 (85)     | 0.12 (363) |
| 9600  | 491   | 0.14        | 0.282           | 0.11       | 0.098        | 0.10          | nan (0)   | 0.26 (19)     | 0.15 (72)     | 0.08 (398) |

## real, lag 1 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200  | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | ---------- | ------------- | ------------- | ---------- |
| 1200  | 213   | 0.08        | 0.496           | 0.08       | 0.679        | 0.02          | 0.02 (167) | nan (0)       | nan (0)       | nan (0)    |
| 2400  | 374   | 0.03        | 0.720           | 0.03       | 0.516        | 0.01          | 0.02 (93)  | 0.01 (259)    | nan (0)       | nan (0)    |
| 3600  | 447   | 0.03        | 0.524           | 0.03       | 0.446        | 0.01          | 0.05 (42)  | 0.01 (241)    | 0.00 (149)    | nan (0)    |
| 4800  | 494   | 0.04        | 0.425           | 0.04       | 0.387        | 0.02          | 0.00 (32)  | 0.02 (122)    | 0.02 (325)    | nan (0)    |
| 6000  | 526   | 0.03        | 0.426           | 0.03       | 0.361        | 0.02          | 0.03 (29)  | 0.01 (85)     | 0.02 (397)    | nan (0)    |
| 7200  | 563   | 0.05        | 0.432           | 0.05       | 0.330        | 0.03          | 0.00 (27)  | 0.01 (81)     | 0.06 (196)    | 0.01 (246) |
| 8400  | 596   | 0.05        | 0.657           | 0.05       | 0.319        | 0.03          | 0.00 (30)  | 0.04 (67)     | 0.02 (131)    | 0.03 (355) |
| 9600  | 629   | 0.02        | 0.433           | 0.02       | 0.310        | 0.01          | 0.00 (28)  | 0.03 (63)     | 0.01 (118)    | 0.01 (412) |
| 10800 | 635   | 0.04        | 0.591           | 0.04       | 0.293        | 0.02          | 0.00 (14)  | 0.02 (57)     | 0.02 (104)    | 0.02 (449) |
| 12000 | 646   | 0.04        | 0.426           | 0.03       | 0.287        | 0.02          | 0.00 (19)  | 0.03 (34)     | 0.03 (93)     | 0.02 (486) |
| 13200 | 661   | 0.03        | 0.611           | 0.03       | 0.280        | 0.01          | 0.00 (21)  | 0.00 (38)     | 0.00 (82)     | 0.02 (510) |
| 14400 | 693   | 0.02        | 0.616           | 0.02       | 0.274        | 0.02          | 0.00 (26)  | 0.07 (55)     | 0.02 (60)     | 0.01 (543) |
| 15600 | 704   | 0.02        | 0.409           | 0.02       | 0.259        | 0.01          | 0.00 (10)  | 0.04 (54)     | 0.00 (62)     | 0.01 (566) |
| 16800 | 708   | 0.03        | 0.528           | 0.03       | 0.254        | 0.02          | 0.00 (16)  | 0.03 (37)     | 0.00 (76)     | 0.02 (572) |
| 18000 | 713   | 0.02        | 0.373           | 0.02       | 0.249        | 0.01          | 0.00 (17)  | 0.00 (31)     | 0.03 (67)     | 0.01 (593) |

## real, lag 4 checkpoint(s)

| frame | cells | share moved | median if moved | share >10% | median noise | share > noise | age <1200 | age 1200-3000 | age 3000-6000 | age >=6000 |
| ----- | ----- | ----------- | --------------- | ---------- | ------------ | ------------- | --------- | ------------- | ------------- | ---------- |
| 2400  | 263   | 0.17        | 0.602           | 0.16       | 0.437        | 0.10          | nan (0)   | 0.10 (258)    | nan (0)       | nan (0)    |
| 3600  | 391   | 0.14        | 0.554           | 0.14       | 0.417        | 0.09          | nan (0)   | 0.11 (235)    | 0.06 (149)    | nan (0)    |
| 4800  | 452   | 0.14        | 0.638           | 0.14       | 0.378        | 0.09          | nan (0)   | 0.12 (121)    | 0.08 (325)    | nan (0)    |
| 6000  | 490   | 0.18        | 0.571           | 0.18       | 0.344        | 0.12          | nan (0)   | 0.09 (85)     | 0.13 (397)    | nan (0)    |
| 7200  | 524   | 0.14        | 0.458           | 0.14       | 0.319        | 0.09          | nan (0)   | 0.04 (77)     | 0.11 (196)    | 0.09 (246) |
| 8400  | 561   | 0.15        | 0.592           | 0.15       | 0.310        | 0.10          | nan (0)   | 0.12 (67)     | 0.08 (131)    | 0.10 (355) |
| 9600  | 596   | 0.10        | 0.477           | 0.10       | 0.303        | 0.06          | nan (0)   | 0.08 (63)     | 0.08 (118)    | 0.05 (412) |
| 10800 | 617   | 0.17        | 0.498           | 0.16       | 0.289        | 0.11          | nan (0)   | 0.12 (56)     | 0.13 (104)    | 0.10 (449) |
| 12000 | 620   | 0.13        | 0.434           | 0.13       | 0.282        | 0.08          | nan (0)   | 0.09 (33)     | 0.11 (93)     | 0.08 (486) |
| 13200 | 635   | 0.11        | 0.521           | 0.11       | 0.275        | 0.08          | nan (0)   | 0.00 (36)     | 0.10 (82)     | 0.08 (510) |
| 14400 | 661   | 0.12        | 0.494           | 0.11       | 0.267        | 0.08          | nan (0)   | 0.09 (53)     | 0.10 (60)     | 0.07 (543) |
| 15600 | 685   | 0.10        | 0.489           | 0.09       | 0.256        | 0.06          | nan (0)   | 0.10 (50)     | 0.03 (62)     | 0.06 (566) |
| 16800 | 691   | 0.12        | 0.415           | 0.12       | 0.250        | 0.07          | nan (0)   | 0.11 (37)     | 0.07 (76)     | 0.07 (572) |
| 18000 | 695   | 0.11        | 0.466           | 0.11       | 0.246        | 0.08          | nan (0)   | 0.10 (31)     | 0.09 (67)     | 0.07 (593) |
