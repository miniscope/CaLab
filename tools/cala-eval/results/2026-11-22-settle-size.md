# Why look-back + Final settle footprints are larger, and which size is right (22 Nov 2026)

Plan and metrics were committed before any score was read:
[2026-11-22-settle-size-plan.md](2026-11-22-settle-size-plan.md) (commits `d94b5ad4`, and the addendum for the PI's
reframing). The size tables seen while finding the run trees are listed there as seen in advance. Anything decided
after the first scores is marked **(post hoc)**.

## For the PI

**The larger footprints are the better ones. Nothing in the settle needs fixing for size.**

How firm this is, by the rule written in the plan (larger is right when the light it recovers exceeds the light it
misplaces): a clear pass on the 14 larger-cell sims (3.8 points recovered, 0.6 misplaced); a narrow pass on 2 sims at
the real cell size (2.1 against 1.8; about even, 3.8 against 3.5, for cells with a close neighbour). The real
recordings grow about twice as much as those sims, so on real data the direction is supported and the amount is not
confirmed.

1. **On the sims the look-back + settle footprints are closer to the truth on nearly every measure.**
   - They are 17 % larger than Discover + Refine's (711 against 608 pixels), and the true footprints are larger still.
     Both paths cut footprints short; the new path cuts less.
   - Light of the true footprint that the estimate leaves out: 14.8 % (Discover + Refine) against 11.0 % (new).
   - The exceptions: light put where it does not belong rises by 0.6 % of the footprint's light, of which 0.2 % sits
     on a neighbour's soma, and error beyond the true footprint's edge rises slightly. The gain is about seven times
     the cost.
   - On two sims with the real recordings' cell size the result is the same with a narrower margin: light left out
     9.3 % → 7.2 %, light in excess +1.8 points (0.8 on a neighbour's soma), core error −25 %, crosstalk and bites
     down as before.
   - Core shape error falls by 40 %. Bitten footprints fall from 49 % to 17 %, trace crosstalk halves, traces follow
     the truth better, and false cells fall from 21.9 to 17.1 per sim. True cells found are the same.
   - Cells with no neighbour are unchanged. All of the growth is on cells that overlap another cell.
2. **The cause is the overlap handling (the cluster replay), not the settle.**
   - An ordinary Refine run from the same look-back library ends at the same size as the settle, to within 1 pixel.
     So the read order, the 64-frame blocks and the background state of re-read frames play no part.
   - With the replay off, look-back + settle footprints are within 2–6 % of Discover + Refine's size, on the sims and
     on all three real recordings.
   - The replay re-solves the traces of overlapping cells together and refits their footprints together. That fills
     the part of a footprint that lies under or beside a neighbour, which the one-cell-at-a-time update leaves empty.
3. **The real recordings show the same kind of change, two to three times as strong.**
   - The gate's "975–1,190 against 665–785 pixels" counted stored pixels, zeros included. Counting pixels with light:
     workshop 379 → 624 (+65 %), Samara 403 → 536 and 363 → 545.
   - The growth is faint light around the cell: pixels at half the peak or more +3 %, at a tenth of the peak or more
     +23 %. The footprints stay one piece.
   - Most of the added light lies where another cell's footprint is. With the same cells and only the replay in the
     settle switched, cells with no neighbour within 2 diameters do not change, as on the sims. Between the two full
     paths the few such cells (about 20) do grow somewhat; the cause of that part is not identified.
   - On 5,700 workshop frames that no run had seen, with the same 813 cells and only the replay in the settle switched
     on or off: the larger footprints leave 9 % less unexplained structure in the residual, and the traces of close
     pairs are half as correlated in excess of far pairs (0.10 → 0.04). The held-out score is the same (within 1 %).
   - Repeatability is the same for both paths (the gate's own result).
4. **Fewer cells on dense data comes from the replay during Discover, not from dropped frames.**
   - qc_eval drops no frames and loses the same cells (workshop −9 % against the app's −11 %). Dropping a third of the
     frames on purpose costs 1 % of the workshop cells and no true cells on a sim. With the replay off during Discover
     the cells are all there.
   - The cells the new path lacks are weak ones. On the workshop recording they add 3 % to the held-out score; 59 % of
     them carry light on held-out frames, and most sit where the new path has a differently shaped cell.
   - On the sims the new path finds as many true cells and fewer false ones.
5. **Recommendation.**
   - Treat the footprint differences in the beta gate (lines A1 and A2) as an improvement, not a failure. For the
     rerun, replace "agrees with v2.20.0" by the measures used here: residual structure, close-pair crosstalk and the
     held-out score on unseen frames.
   - No code change is needed for footprint size before the beta.
   - The open point for the beta is the cell count on dense recordings. It is small in held-out terms (3 %). If the PI
     wants those cells back, the tested way is the replay in the settle only: every cell is back and the footprints
     get the same fill. Its cost is on the live library before the settle (more bitten footprints), which matters for
     streaming. That is the PI's earlier decision (19 Nov) and this study gives no reason to change it.

## What was compared

Arms (qc_eval, binary `qc_eval-lbs2-b`, the #443 study's; runs of #439 and #443 reused, no rerun):

| arm       | Discover              | then                                   | stands for                                      |
| --------- | --------------------- | -------------------------------------- | ----------------------------------------------- |
| `DR-main` | plain                 | one Refine                             | v2.20.0, and `main` with look-back off          |
| `COMBO`   | look-back + replay    | nothing                                | look-back Discover's live library               |
| `COMBO+R` | look-back + replay    | one Refine (replay on)                 | the app's `--lookback --refine`                 |
| `SETTLE`  | look-back + replay    | settle (replay on)                     | the app's `?lookback` path                      |
| `OFF+S`   | look-back, replay off | settle, replay off                     | look-back + settle without the overlap handling |
| `REF+S`   | look-back, replay off | settle, replay on                      | replay in the settle only                       |
| `ST-*`    | as `SETTLE`           | settle with the reservoir frozen / fed | what fresh held-out frames let through          |

- Sims: the 14 of the demix suite (static s5–s9, motion s5–s9, pairs s5–s8; true cell diameter 14.5 px), quick tier
  (5 sims) for `REF+S` and `ST-*`. New runs: two v3 sims (true diameter 10 px, the real recordings' size).
- Real: workshop (3 slow seeds) and Samara `10_43_21`, `14_57_02` in qc_eval; the app's beta-gate libraries.
- Script: `tools/cala-eval/settle_size.py` (sub-commands `tree`, `report`, `real`, `pair`, `proxies`).

Against the plan:

- No qc_eval change was needed. The plan's "same library settled with the replay on and off" is `OFF+S` against
  `REF+S` from #443: one replay-off Discover, settled both ways.
- The v3 runs were cut to two sims and two arms (`DR-main`, `SETTLE`) to fit the two-process limit.
- **Post hoc:** the matched-pair table of added light (`pair`), the check of second pieces at the 10 % cut, the
  table of cells only one path has, and scoring the real-data proxies on frames 18,000 on (chosen because no run had
  seen them, before any proxy score was read).

## 1. Sims: which path is closer to the truth

Per matched cell the true footprint is scaled to peak 1 and the estimate is scaled onto it over the true core.
14 sims, 5,437 cells matched to the same true unit in both arms. Differences are per-sim means with a 95 % CI over
sims. The truth has 639 px at 10 % of peak or more and 1,380 px at 1 % or more.

| measure (all cells)                                        | `DR-main` | `SETTLE` | difference [95 % CI]        |
| ---------------------------------------------------------- | --------: | -------: | --------------------------- |
| pixels with light                                          |       608 |      711 | +103 [+96, +109]            |
| pixels at 10 % of peak or more (truth 639)                 |       555 |      606 | +51 [+48, +54]              |
| energy below 10 % of own peak (truth 1.32 %)               |    0.37 % |   0.64 % | +0.27 [+0.24, +0.30] points |
| true light left out (estimate is 0 there)                  |    14.8 % |   11.0 % | −3.8 [−4.0, −3.5] points    |
| true light lacking (estimate below truth)                  |    19.3 % |   14.8 % | −4.6 [−4.8, −4.3] points    |
| light in excess of truth                                   |     3.0 % |    3.5 % | +0.6 [+0.3, +0.8] points    |
| of which on another unit's core                            |    0.85 % |   1.06 % | +0.21 [+0.13, +0.29] points |
| squared error in the core (truth ≥ 10 %), over true energy |    0.0329 |   0.0197 | −0.0131 [−0.0148, −0.0115]  |
| squared error in the skirt (truth 1–10 %)                  |    0.0115 |   0.0096 | −0.0019 [−0.0023, −0.0016]  |
| squared error beyond the truth's 1 % line                  |    0.0013 |   0.0015 | +0.0002 [+0.0000, +0.0004]  |
| footprint r with truth (mean)                              |    0.9770 |   0.9847 | +0.0078 [+0.0068, +0.0087]  |

By neighbourhood:

| cells                                | pixels, `DR-main` → `SETTLE`  | true light left out | core error      |
| ------------------------------------ | ----------------------------- | ------------------- | --------------- |
| isolated (no unit within 1.5 D), 402 | 612 → 616 (+5 [−1, +11])      | 12.9 % → 12.7 %     | 0.0142 → 0.0145 |
| close (a unit within 1 D), 3,694     | 599 → 739 (+140 [+134, +146]) | 15.7 % → 10.5 %     | 0.0421 → 0.0227 |

Mean value by distance from the true centre (D = cell diameter), all cells:

| ring (D)  |  0.00 |  0.25 |  0.50 |  0.75 |  1.00 |  1.25 |  1.50 |
| --------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| `DR-main` | 0.914 | 0.637 | 0.322 | 0.115 | 0.019 | 0.001 | 0.000 |
| `SETTLE`  | 0.913 | 0.642 | 0.334 | 0.132 | 0.032 | 0.003 | 0.000 |
| truth     | 0.913 | 0.647 | 0.347 | 0.154 | 0.061 | 0.022 | 0.007 |

The suite's rows for the same two arms (`runs/settle-size/suite-DR-main-vs-SETTLE.md`, 14 sims):

| measure                                     | `DR-main` | `SETTLE` | difference [95 % CI]       |
| ------------------------------------------- | --------: | -------: | -------------------------- |
| trace r with truth, median                  |    0.9676 |   0.9722 | +0.0046 [+0.0031, +0.0060] |
| trace crosstalk (close minus far pairs)     |    +0.150 |   +0.074 | −0.076 [−0.084, −0.066]    |
| leak into a neighbour's trace, median < 1 D |    0.0579 |   0.0291 | −0.0288 [−0.0323, −0.0255] |
| bitten footprints, 0.75–1 D                 |     0.486 |    0.168 | −0.318 [−0.347, −0.288]    |
| true cells found per sim                    |     400.1 |    401.9 | +1.8 [−0.3, +3.9]          |
| false cells per sim                         |      21.9 |     17.1 | −4.8 [−7.7, −1.9]          |

**Reading.** Larger is closer to the truth here, and neither path over-reaches: both estimates end near 1.25 D where
the truth still has 2 % of its peak. The one cost is +0.2 points of light on a neighbour's core.

### v3 sims (true diameter 10 px, the real recordings' cell size; new runs)

Two sims (`v3_static_s5`, `s6`; 806 detectable units each, as dense as the workshop recording), `DR-main` and
`SETTLE` flags, one run each. 1,439 cells matched in both arms. The truth has 201 px at 10 % of peak or more and
494 px at 1 % or more.

| measure                                      |  `DR-main` |   `SETTLE` | difference [range over the 2 sims] |
| -------------------------------------------- | ---------: | ---------: | ---------------------------------- |
| pixels with light, all cells                 |        286 |        344 | +58 [+52, +63]                     |
| pixels with light, close cells               |        282 |        390 | +108 [+103, +113]                  |
| pixels with light, isolated cells            |        288 |        290 | +1 [−2, +4]                        |
| energy below 10 % of own peak (truth 1.26 %) |     0.79 % |     1.08 % | +0.29 points                       |
| true light left out                          |      9.3 % |      7.2 % | −2.1 [−2.3, −1.9] points           |
| true light lacking                           |     12.8 % |     10.1 % | −2.7 [−3.0, −2.4] points           |
| light in excess of truth                     |      5.1 % |      6.8 % | +1.8 [+1.7, +1.8] points           |
| of which on another unit's core              |      0.9 % |      1.7 % | +0.8 [+0.7, +0.8] points           |
| squared error in the core                    |     0.0146 |     0.0110 | −0.0037 [−0.0048, −0.0025]         |
| squared error in the skirt                   |     0.0084 |     0.0074 | −0.0010 [−0.0012, −0.0008]         |
| trace crosstalk (close minus far pairs)      |     +0.053 |     −0.003 | −0.056 [−0.073, −0.036]            |
| leak into a neighbour's trace, median        |     0.0337 |     0.0158 | −0.0178 [−0.0230, −0.0137]         |
| bitten footprints, 0.75–1 D                  |      0.388 |      0.122 | −0.266 [−0.397, −0.137]            |
| true cells found / false cells per sim       | 735 / 14.5 | 732 / 11.5 | −3 / −3                            |

(The suite rows carry its own bootstrap CIs; the size rows show the two sims' values, since two sims give no CI.)

Mean value by distance from the true centre, close cells:

| ring (D)  |  0.00 |  0.25 |  0.50 |  0.75 |  1.00 |  1.25 |  1.50 |  1.75 |
| --------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| `DR-main` | 0.982 | 0.673 | 0.241 | 0.046 | 0.014 | 0.006 | 0.002 | 0.000 |
| `SETTLE`  | 0.983 | 0.681 | 0.258 | 0.065 | 0.026 | 0.015 | 0.006 | 0.002 |
| truth     | 0.966 | 0.687 | 0.237 | 0.052 | 0.029 | 0.021 | 0.013 | 0.006 |

(Ring table: `v3_static_s5`.)

**Reading.** At the real cell size the new path is again closer to the truth: less light left out, lower core and
skirt error, no bites, half the leak. The margin is narrower than on the larger sims. The fill overshoots a little
between 0.5 and 0.75 D on close cells (0.258 and 0.065 against the truth's 0.237 and 0.052), so light in excess of
truth rises by 1.8 points while light lacking falls by 2.7. Beyond 1 D both paths are still below the truth. The
overshoot does not show in the traces: crosstalk and leak fall.

## 2. Which ingredient makes the difference

Pixels with light, all matched cells; each row is a paired comparison on the sims both arms have.

| comparison              | what differs                              | sims | pixels                     | true light left out         | core error                 |
| ----------------------- | ----------------------------------------- | ---: | -------------------------- | --------------------------- | -------------------------- |
| `COMBO+R` → `SETTLE`    | settle in place of a Refine, same library |   14 | 710 → 710 (−1 [−2, +0])    | +0.00 [−0.02, +0.03] points | −0.0001 [−0.0004, +0.0001] |
| `DR-main` → `OFF+S`     | look-back + settle, no replay             |   14 | 607 → 619 (+12 [+9, +14])  | −0.5 [−0.7, −0.4] points    | −0.0018 [−0.0028, −0.0008] |
| `OFF+S` → `SETTLE`      | replay in Discover and the settle         |   14 | 620 → 711 (+91 [+85, +97]) | −3.3 [−3.4, −3.1] points    | −0.0116 [−0.0133, −0.0099] |
| `OFF+S` → `REF+S`       | replay in the settle only                 |    5 | 631 → 695 (+65 [+59, +69]) | −2.4 [−2.6, −2.1] points    | −0.0101 [−0.0119, −0.0078] |
| `REF+S` → `SETTLE`      | replay in Discover as well                |    5 | 697 → 715 (+18 [+14, +23]) | −0.7 [−0.9, −0.5] points    | −0.0033 [−0.0047, −0.0021] |
| `DR-main` → `COMBO`     | look-back Discover's live library         |   14 | 608 → 658 (+50 [+43, +57]) | −1.5 [−1.8, −1.2] points    | −0.0045 [−0.0065, −0.0027] |
| `ST-frozen` → `ST-full` | fresh held-out frames in the settle       |    5 | 681 → 715 (+34 [+28, +40]) | −1.5 [−1.7, −1.2] points    | −0.0067 [−0.0077, −0.0056] |

The gate's candidate causes:

1. **Background and noise state of re-read frames: no.** `COMBO+R` (frames in order, each with its own running
   state) equals `SETTLE`.
2. **Read order, 64-frame blocks: no.** Same comparison.
3. **Cluster replay in the settle: yes, most of it.** About two thirds of the growth on the sims (+65 px of
   +103), and nearly all of it on real data (section 3).
4. **Held-out gate: it lets the growth through, it does not cause it.** With the settle's held-out frames frozen,
   34 of the 53 pixels the settle adds (658 → 711) are missing, and the footprints are further from the truth. What
   the gate passes is correct growth.
5. **Dropped frames: not for size.** qc_eval drops none and shows the same sizes as the app (section 3).
6. **Replay in Discover (post hoc candidate): the rest.** It is why look-back Discover's live library is already
   larger (+50 px), and it adds 18 px to the settled result.
7. **Look-back itself (post hoc candidate): little.** +12 px without the replay.

A replayed footprint goes through the same finish as any other proposal (significance of each pixel, basin, the
held-out gate; `discover/cluster.rs`, `refine_clusters`). No size rule is involved. The estimate it starts from is
different: traces re-solved jointly for the cluster, so light under a neighbour is no longer credited to the
neighbour.

## 3. Real data

### Sizes, and the app against qc_eval

The beta gate's pixel counts were stored pixels, zeros included. Median per footprint:

| library (first run of each arm)                |           cells | stored px |   px with light | px ≥ 10 % of peak |    px ≥ 50 % |         faint energy | radius holding 90 % of the light (px) |
| ---------------------------------------------- | --------------: | --------: | --------------: | ----------------: | -----------: | -------------------: | ------------------------------------: |
| app, workshop, v2.20.0 Discover                |             839 |       522 |             289 |               271 |           88 |               0.00 % |                                   8.9 |
| app, workshop, v2.20.0 after Refine            |             839 |       665 |             379 |               340 |           94 |               0.11 % |                                  10.0 |
| app, workshop, look-back Discover              |             753 |       703 |             404 |               326 |           90 |               0.16 % |                                  10.2 |
| app, workshop, after the Final settle          |             753 |     1,169 |             624 |               419 |           97 |               1.23 % |                                  12.3 |
| app, `10_43_21`, v2.20.0 after Refine          |             331 |       737 |             403 |               336 |           91 |               0.39 % |                                  10.3 |
| app, `10_43_21`, after the Final settle        |             319 |     1,023 |             536 |               394 |           92 |               1.00 % |                                  11.7 |
| app, `14_57_02`, v2.20.0 after Refine          |             295 |       687 |             363 |               315 |           84 |               0.33 % |                                   9.9 |
| app, `14_57_02`, after the Final settle        |             277 |     1,043 |             545 |               366 |           94 |               1.01 % |                                  11.8 |
| qc_eval, workshop, `DR`                        |             811 |       651 |             370 |               331 |           92 |               0.06 % |                                   9.9 |
| qc_eval, workshop, `SETTLE`                    |             738 |     1,329 |             661 |               446 |          100 |               1.28 % |                                  12.9 |
| qc_eval, workshop, `COMBO+R`                   |             738 |     1,354 |             657 |               442 |          100 |               1.28 % |                                  12.7 |
| qc_eval, workshop, `OFF+S`                     |             813 |       699 |             392 |               347 |           93 |               0.18 % |                                  10.2 |
| qc_eval, workshop, `REF+S`                     |             813 |     1,185 |             612 |               404 |           97 |               1.22 % |                                  12.2 |
| qc_eval, `10_43_21`, `DR` / `OFF+S` / `SETTLE` | 370 / 376 / 358 |           | 415 / 438 / 556 |   356 / 362 / 408 | 89 / 90 / 95 | 0.45 / 0.50 / 1.02 % |                    10.6 / 10.8 / 12.0 |
| qc_eval, `14_57_02`, `DR` / `OFF+S` / `SETTLE` | 329 / 321 / 308 |           | 387 / 399 / 586 |   324 / 327 / 403 | 79 / 82 / 88 | 0.51 / 0.69 / 1.23 % |                    10.1 / 10.4 / 12.5 |

- qc_eval reproduces the app's sizes in both arms, with no dropped frames.
- The attribution is the same as on the sims: replay off gives Discover + Refine's size; a Refine and a settle from
  the same library agree; the replay in the settle alone gives nearly all of it.
- The faint share of the new path (1.0–1.3 %) is what the sims' true footprints have (1.3 %). The old path's
  (0.1–0.5 %) is what a truncated estimate has on the sims (0.4 %).
- One piece: at most 0.1 % of settled footprints have more than one connected piece (the old path: 0.0–0.7 %). At a 10 % cut, 6–10 % of the new footprints show
  a second piece; it is a speck (median 3–4 px, 0.2 % of the light, at 0.11 of peak), the faint skirt crossing the
  cut, not a second lobe.

### Where the added light lies (no truth needed)

Cells matched between two libraries; the second is scaled onto the first over the first's core. "Added" is the
light the second has above the first, over the first's light.

| pair of libraries                            | nearest neighbour | cells | px with light | light added | of it on another cell's footprint (core / rest) |
| -------------------------------------------- | ----------------- | ----: | ------------- | ----------: | ----------------------------------------------- |
| workshop qc_eval, `OFF+S` → `REF+S` (seed 3) | < 1 D             |   552 | 368 → 600     |      25.3 % | 60 % / 37 %                                     |
|                                              | 1–1.5 D           |   182 | 450 → 673     |      18.6 % | 42 % / 42 %                                     |
|                                              | 1.5–2 D           |    36 | 617 → 611     |       2.2 % |                                                 |
|                                              | ≥ 2 D             |    16 | 534 → 558     |       0.6 % |                                                 |
| workshop qc_eval, `DR` → `SETTLE` (seed 3)   | < 1 D             |   440 | 357 → 640     |      32.5 % | 65 % / 32 %                                     |
|                                              | 1.5–2 D           |    24 | 494 → 698     |      21.8 % |                                                 |
|                                              | ≥ 2 D             |    19 | 505 → 611     |      10.2 % |                                                 |
| workshop app, old → new                      | < 1 D             |   444 | 358 → 610     |      27.9 % | 64 % / 32 %                                     |
|                                              | ≥ 2 D             |    18 | 629 → 642     |      10.2 % |                                                 |
| workshop app, old → old (run to run)         | < 1 D             |   484 | 360 → 371     |       9.8 % |                                                 |
|                                              | ≥ 2 D             |    19 | 625 → 614     |       5.9 % |                                                 |
| sim static_s5, `DR-main` → `SETTLE`          | < 1 D             |   311 | 585 → 720     |      10.8 % | 40 % / 32 %                                     |
|                                              | 1–1.5 D           |   134 | 616 → 644     |       2.3 % |                                                 |
|                                              | ≥ 2 D             |    10 | 532 → 554     |       0.9 % |                                                 |

All pairs are in `runs/settle-size/pairs.md` (three workshop seeds, three recordings, three sims).

- Real and sims agree in kind: the light is added on cells that have a neighbour, where the neighbour's footprint
  is.
- Isolated cells: with the same cells and only the replay in the settle switched (`OFF+S` → `REF+S`), cells with no
  neighbour within 1.5 D do not change (0.6–3.6 % light added over three seeds), as on the sims. Between the two full paths they
  do: `DR` → `SETTLE` adds 10 % of light at ≥ 2 D and 22 % at 1.5–2 D, and the app's old → new adds 10 % at ≥ 2 D
  against 6 % run to run. These are about 20 cells per row, and the cause is not identified (the replay or look-back
  during Discover, or a neighbour only one library has).
- They differ in amount: about 25 % of a footprint's light on the workshop recording, 11–12 % on the sims (both cell
  sizes); and on real data cells with a neighbour at 1–1.5 D grow too, which on the sims they barely do. See
  "Limits".

### Measures that assume neither path is right

`qc_eval real --library L --dump` with the library fixed and no slow loop, on the whole workshop recording
(23,711 frames). The libraries were built on frames 0–17,999. Scores below are on frames 18,000–23,711, which no run
had seen.

| library          | cells | held-out score | explained | residual structure | close-pair trace r (< 1 D) | far pairs (1.5–3 D) | excess |
| ---------------- | ----: | -------------: | --------: | -----------------: | -------------------------: | ------------------: | -----: |
| `OFF+S`, seed 1  |   812 |         21,330 |    0.8751 |              1.474 |                     +0.159 |              +0.058 | +0.101 |
| `REF+S`, seed 1  |   812 |         21,227 |    0.8869 |              1.360 |                     +0.096 |              +0.056 | +0.041 |
| `OFF+S`, seed 2  |   829 |         21,773 |    0.8739 |              1.485 |                     +0.144 |              +0.060 | +0.085 |
| `REF+S`, seed 2  |   829 |         21,576 |    0.8895 |              1.331 |                     +0.078 |              +0.056 | +0.022 |
| `OFF+S`, seed 3  |   813 |         21,208 |    0.8767 |              1.458 |                     +0.173 |              +0.059 | +0.114 |
| `REF+S`, seed 3  |   813 |         21,238 |    0.8897 |              1.329 |                     +0.106 |              +0.056 | +0.050 |
| `DR`, seed 3     |   811 |         21,665 |    0.8778 |              1.450 |                     +0.161 |              +0.057 | +0.105 |
| `SETTLE`, seed 3 |   738 |         21,030 |    0.8799 |              1.427 |                     +0.105 |              +0.054 | +0.051 |

- Held-out score: light explained on held-out frames minus the penalty measured on displaced copies of cells, per
  frame. Explained: share of the signal variance above noise that the model explains. Residual structure: mean over
  image blocks of the residual variance above noise (`residual_excess`). Trace r: after a 300-frame high-pass.
- **`OFF+S` against `REF+S` is the clean test of footprint size:** the same Discover, so the same cells with the same
  ids, and only the replay in the settle differs.
  - Residual structure −8 to −10 % in all three seeds; explained +1.2 to +1.6 points.
  - Close-pair trace r falls by 0.05–0.06 for the same pair (70–73 % of pairs fall); pairs at 1–1.5 D fall by 0.045
    (73–76 % fall); far pairs do not move. Close pairs stay above far pairs, so this is not over-subtraction.
  - Held-out score −0.5 %, −0.9 %, +0.1 %: no difference.
- **`DR` against `SETTLE`** (the two full paths, different cell sets): crosstalk halves, residual structure and
  explained are slightly better, and the held-out score is 2.9 % lower. The last is the cell count (section 4), since
  footprint size alone does not move it.
- Repeatability: equal for the two paths in the gate (new-new 0.9917 / 0.9913 / 0.9813 against old-old 0.9920 /
  0.9906 / 0.9790) and in #439 and #443.

## 4. Cells

The gate's question: is the cell loss in look-back Discover the frames dropped for the slow loop?

**qc_eval drops no frames and shows the same loss.**

| recording  | app: v2.20.0 → look-back (frames dropped) | qc_eval, no drops: `DR` → `SETTLE` | qc_eval, look-back with the replay off |
| ---------- | ----------------------------------------- | ---------------------------------- | -------------------------------------- |
| workshop   | 835 → 745, −11 % (19 % → 34 %)            | 811–838 → 738–760, −9 %            | 812–829                                |
| `10_43_21` | 330 → 322, −2 % (6 % → 19 %)              | 370 → 358, −3 %                    | 376                                    |
| `14_57_02` | 295 → 280, −5 % (2 % → 14 %)              | 329 → 308, −6 %                    | 321                                    |

(App: means of the gate's runs. qc_eval: seeds 1–3 on the workshop recording, seed 1 on Samara.)

**Dropping frames on purpose changes little** (`--slow-keep`: every batch outside an evenly spaced share is not
forwarded to the slow loop; new runs, Discover only, look-back + replay as in the app):

| run                                         | share of batches kept | cells | true cells found |
| ------------------------------------------- | --------------------: | ----: | ---------------: |
| workshop, look-back + replay (seed 1, #439) |                  1.00 |   751 |                  |
| workshop, look-back + replay                |                  0.66 |   743 |                  |
| sim `v3_static_s5`, plain Discover          |                  1.00 |   738 |              714 |
| sim `v3_static_s5`, plain Discover          |                  0.81 |   741 |              721 |
| sim `v3_static_s5`, look-back + replay      |                  1.00 |   729 |        709 / 710 |
| sim `v3_static_s5`, look-back + replay      |                  0.81 |   731 |              716 |
| sim `v3_static_s5`, look-back + replay      |                  0.66 |   730 |              717 |

- Workshop: a third of the batches dropped costs 8 cells of 751 (1 %). The replay costs about 65 (8 %).
- Sims: dropped frames cost no true cells (806 detectable units in the sim). The replay's 4–5 of 714 here is inside
  the noise (dropping frames alone moved the count from 714 to 721), and it costs nothing on the 14 larger-cell sims
  (400.1 → 401.9), with fewer false cells in both sets.
- Limit: `--slow-keep` drops evenly. The app drops when the slow worker is busy, which may bunch the drops. One run
  per row.

**So the loss is the replay during Discover**, as #443 found (workshop 818 cells with it off against 750 with it on),
and #439's M8 found that it shows as fewer cells added, not more merged.

**What the missing cells are** (workshop seed 3, fixed libraries scored on the whole recording; matched at cosine
≥ 0.7):

| cells                         |   n | held-out value, median z | share with z > 3 | trace sd | highest trace r with a cell within 1.5 D |
| ----------------------------- | --: | -----------------------: | ---------------: | -------: | ---------------------------------------: |
| in both libraries (`DR` side) | 646 |                     10.0 |             84 % |     1.33 |                                     0.26 |
| only in `DR`                  | 165 |                      3.7 |             59 % |     0.88 |                                     0.28 |
| only in `SETTLE`              |  92 |                      2.3 |             37 % |     0.67 |                                     0.19 |

- The two paths differ in about 260 cells, not 73: each has cells the other lacks. 69 % of the `DR`-only cells sit
  where `SETTLE` has a cell of a different shape (best cosine 0.3–0.7).
- The `DR`-only cells are weak, and more than half of them explain light on held-out frames. Their traces are not
  copies of a neighbour's (trace r with neighbours as for other cells), so they do not look like fragments.
- Together they are worth 3 % of the held-out score (`DR` 21,665 against `SETTLE` 21,030 on unseen frames).
- On the sims, where the truth is known, the new path finds as many true cells and fewer false ones. The sims do not
  show the real-data loss, so they cannot say whether the lost real cells are true.

**What would recover them.** Not fewer dropped frames. The tested way is the replay in the settle only (`REF+S`,
#443): the workshop cells are all back (812 / 829 / 813), the settled footprints get the same fill and the same
real-data scores (section 3), and on the sims it gives up a little against `SETTLE` (true light left out +0.7
points, 5 sims). Its live library before the settle is the bitten one.

## 5. What to do

1. **Footprint size: nothing to fix.** The growth is the overlap handling doing what it was built for, it passes the
   same pixel significance test and held-out gate as every other refinement, and it is closer to the truth where truth
   exists. The PI's rule (no size caps; truncated footprints leave light behind) points the same way: the old path is
   the truncated one.
2. **Beta gate.** Lines A1 and A2 ask the new path to match v2.20.0's footprints. With the PI's reframing they should
   be replaced, for the rerun, by measures that rank the paths: residual structure, close-pair crosstalk and the
   held-out score on frames held back from both, plus repeatability. The fixed-library run used here does that in
   qc_eval in about 15 minutes per library; an app version would save the library and score it the same way.
3. **Cells on dense recordings** are the one real trade-off, and it is small. Options, none needed before a beta:
   - accept it (the PI: more cells is neither better nor worse);
   - replay in the settle only (`REF+S`): all cells back, same fill after the settle, but the live library before the
     settle is the bitten one, so it does not serve streaming;
   - find why the replay in Discover adds fewer cells (#439 M8: fewer adds, not more merges). Not a beta item.
4. **Time and dropped frames** stay as the gate left them: 12–17 % slower, to be re-measured on a quiet machine.

## Limits

- **The sims show the same kind of change as the real data but about half the amount.** On real data the replay adds
  about 25 % to a close cell's light and also fills cells with a neighbour at 1–1.5 D; on the sims it adds 11–12 % and
  leaves those cells nearly alone. Real footprints are broader at their base than the v3 sims' truth (pixels at 10 %
  of peak over pixels at 50 %: 3.6–4.3 real, 2.5 v3 truth, 3.9 for the larger sims), so real neighbours overlap more;
  that may be the reason, and it is not tested. The sims therefore confirm the direction (overlap fill is true light,
  with a small overshoot at the real cell size) and cannot confirm the amount. The real-data evidence for the amount
  is indirect: less residual structure and less crosstalk on unseen frames, an unchanged held-out score, and a faint
  share equal to the sims' truth.
- The held-out score does not reward the larger footprints, although the explained share rises. It also does not
  penalise them. Why the two differ is open.
- Lower close-pair correlation is read as less crosstalk. Truly correlated neighbours would also lose a little
  correlation if a footprint took a neighbour's light with the wrong sign; the sims, where this is checked against
  truth, show the opposite (leak into the neighbour's trace halves).
- The real-data proxies are from one recording (workshop, 3 seeds). The size attribution is on all three.
- qc_eval binary `qc_eval-lbs2-b` (19 Nov) for every run, so that new runs match the reused trees. `main` has changed
  since (#458, #460 and others); the gate's control found no measurable effect of those on footprints.
- New qc_eval runs were single runs per sim (seed 1).

## Files

- Script: `tools/cala-eval/settle_size.py`.
- Scores and reports: `~/Projects/cala-data/runs/settle-size/` (`scores/` per-cell rows and paired reports,
  `pairs.md`, `proxies.md`, `suite-DR-main-vs-SETTLE.md`, `fixed/` fixed-library runs, `v3/` new sim runs, `keep/`
  the dropped-frame run).
- Reused trees: `demix-suite/lbsettle-full`, `lbs2-full`, `lbs2-q`, `lbsettle-q`; `runs/lbsettle/real`,
  `runs/lbs2/real`, `runs/lbs2/samara`; `runs/beta-gate`.
