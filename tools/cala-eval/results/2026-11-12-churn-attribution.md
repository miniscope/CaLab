# Churn attribution: what moves footprints late in a real run (12 Nov 2026)

Question (from E7, #328): on the real workshop recording about 11 % of cells
still change their footprint by more than 10 % of its norm per minute at
minutes 12 to 15, and no age group settles. What causes those changes?

## Setup

- Binary: `feat/cala-churn-log` (this PR, on main 6b1debf) merged locally with
  `origin/feat/cala-flat-field-default` 3c1a269 (#330, not yet on main, so the
  online flat field is on), built with `--features diagnostics`.
- Runs: real recording, 18000 frames (15 min at 20 Hz), `--motion --no-pass2
--checkpoints 15 --batch 8 --budget 30000000 --via-jobs --churn-log`,
  default `Residual` footprint statistics, slow seeds 1 and 2. Peak RSS
  1.2 GB, 9.5 min each.
- The logging changes no decision: the seed-1 `edits.tsv` is byte-identical
  across two builds, one of which dropped the test log.
- New outputs (`--churn-log`):
  - `edits.tsv`: every structural edit;
  - `tests.tsv`: every held-out refine, merge, split and absorb test, accepted
    or not;
  - `fp_history.bin`: every cell's filtered and unfiltered footprint and
    split-half noise at every checkpoint (every 300 frames).
- Analysis: `tools/cala-eval/churn_attribution.py RUN [LABEL_BUNDLE]`.

**Definitions.**

- **Large change:** a change between consecutive checkpoints, measured as E7
  does, `‖a_v − a_{v−1}‖ / ‖a_v‖` on the filtered footprint, that is more than
  10 % and also above the cell's split-half noise when it has one. A merge or
  split resets the cell's statistics, so those cells have no noise level.
  Requiring a noise level would hide every merge and split, so the tables
  below don't require one.
- **Attribution of an edit:** an edit is assigned to the first checkpoint at
  which the cell's unfiltered footprint actually changed. Publication lags an
  edit by up to about 120 frames (commit interval plus batching). Without
  this, 224 of the edits made just before a checkpoint looked like changes
  with no event.

## 1. Class shares

Large lag-1 changes, minutes 10 to 15 (frame > 12000):

| class                                                  | seed 1    | seed 2    |
| ------------------------------------------------------ | --------- | --------- |
| large changes (of lag-1 pairs)                         | 273/12757 | 254/13396 |
| **own edit**                                           | **1.00**  | **1.00**  |
| neighbour event (support or moat overlap), no own edit | 0.00 (1)  | 0.00      |
| drift (published change with no event)                 | 0         | 0         |
| rescale only (shape change < 10 %), any class          | 0         | 0         |

Own-edit kinds among those large changes:

| own edit kind                    | seed 1 | seed 2 |
| -------------------------------- | ------ | ------ |
| refine (from running statistics) | 0.59   | 0.61   |
| merge (cell kept in a merge)     | 0.29   | 0.26   |
| absorb (alternative taken)       | 0.10   | 0.10   |
| split (cell kept in a split)     | 0.01   | 0.04   |

Over the whole run the result is the same: 99 % own edits, with refine 54 to
56 %, merge 26 to 28 %, absorb 13 to 14 % and split 4 to 5 %.

- **Neighbour events don't move a footprint at all.** A cell's unfiltered
  footprint changes only through its own `Replace`. Its filtered footprint is
  a per-cell filter of it. In the 31 000 cell-intervals with no own edit, 11
  (seed 1) and 17 (seed 2) footprints moved, and those are edits published
  more than one checkpoint late.
- **There is no rescale-only change and no drift class.** Footprints are
  constant between edits and jump at an edit.
- Neighbours may still matter indirectly. 36 to 47 % of the large refines
  and absorbs happen in an interval in which a neighbour whose support
  overlaps was added, deleted, merged or split. No base rate was measured,
  so this is not evidence that neighbour events trigger the edits.
- **Every published edit is large.** Of 665 to 685 published refines, 97 %
  change the footprint by more than 10 % (median 0.42). For absorbs the
  median is 0.50, for merges 0.71 to 0.75 and for splits 0.95 to 0.97. The
  slow loop has no small edits: when it edits, it replaces.
- **Lag 4 (one minute).** 9.5 % (seed 1) and 6.4 % (seed 2) of cells change
  by more than 10 % and above noise at frame 18000, matching E7 (8 %). Every
  one of them (61/61 and 43/43) has an own edit in the window.

## 2. Oscillation: none. Refines move like a random walk

- **No returns.** Of 825 (seed 1) and 780 (seed 2) large own-edit changes
  with later states, only 3 % and 1 % later return to within half the jump
  of the pre-jump shape (A→B→A). Refines essentially never return (2 of 449,
  0 of 440).
- **Repeated edits.** 204 and 202 cells have two or more large own-edit
  changes, and they hold two thirds of all large changes.
- **Geometry of consecutive refines** (states A → B → C):
  `d(A,C) / (d(A,B) + d(B,C))` has quartiles 0.63, 0.71 and 0.77 in both
  seeds. The reference values are:
  - 1 for a directed move;
  - **0.71 for a random walk** (independent increments);
  - 0.5 for independent re-samples of a fixed truth;
  - 0 for a return.

  Successive refines publish independent increments. This is neither a
  flip-flop nor convergence toward a target.

- **The increments are about the size of the estimate's noise.** The refine
  jump (unit-norm shape distance) is about 1.3 times the cell's split-half
  noise in every third of the run (median ratio 1.26/1.29/1.30 for seed 1,
  1.20/1.25/1.35 for seed 2). The jump shrinks only as the noise shrinks:
  0.52 → 0.42 → 0.34, while the noise goes 0.43 → 0.31 → 0.25. Across cells,
  late jumps grow with noise. By noise tercile the medians are:

  | noise tercile | seed 1 noise / jump | seed 2 noise / jump |
  | ------------- | ------------------- | ------------------- |
  | low           | 0.15 / 0.21         | 0.12 / 0.26         |
  | middle        | 0.25 / 0.34         | 0.26 / 0.35         |
  | high          | 0.43 / 0.49         | 0.44 / 0.45         |

  The log-log slope is 0.5, with r = 0.5. The noise level is itself noisy,
  which flattens that slope.

- **What a refine changes.** Most of the change is a reshape inside the
  existing support: the unit-norm change on common pixels has a median of
  0.36 to 0.39. Only 2 % of the new footprint's energy lies on newly added
  pixels.
- **Supports keep growing.** A refine re-estimates on a disk 2 px wider, and
  support grew in 674 of 727 refines and shrank in 45 (seed 1). Over the run:

  | frame | median support (px) | share of cells > 1000 px |
  | ----- | ------------------- | ------------------------ |
  | 3000  | 462–468             | 6 %                      |
  | 18000 | 617–619             | 28–29 %                  |

  A few cells reach 4000 to 8500 px. This is a separate slow drift, small in
  energy, that the PI's no-size-cap rule allows. It is not what makes the
  jumps large.

**Reading.** Refine replaces a footprint with the current running-statistics
estimate. That estimate's noise stays at about 25 % of the norm at minute 15:
`stats_half_life_frames` = 6000 caps the effective sample at about 8700
frames, and E7's noise curve flattens. `refine_min_change` is 0.03, far below
that noise, so a proposal is made on almost every visit. Each accepted refine
therefore publishes a fresh noise-sized step. The library cannot settle
below the noise floor of the estimate it republishes.

## 3. Acceptance rates

| minutes | refine tests (accept) seed 1 | seed 2     | merge tests (accept) seed 1 | seed 2     |
| ------- | ---------------------------- | ---------- | --------------------------- | ---------- |
| 0–2     | 814 (0.12)                   | 780 (0.11) | 142 (0.11)                  | 131 (0.08) |
| 4–6     | 913 (0.13)                   | 887 (0.12) | 227 (0.18)                  | 225 (0.16) |
| 8–10    | 722 (0.18)                   | 719 (0.17) | 203 (0.22)                  | 233 (0.15) |
| 12–14   | 672 (0.15)                   | 597 (0.15) | 176 (0.23)                  | 185 (0.16) |
| 14–15   | 315 (0.21)                   | 305 (0.19) | 96 (0.15)                   | 97 (0.14)  |

**Acceptance does not fall with time.** The refine rate rises from 12 % to
about 20 %. The merge rate stays at 15 to 23 %. Absorb falls from 12 % to
2 to 8 %, and split from 14 to 21 % to 0 to 12 %.

**Per cell, late (frame > 12000):**

- A tested cell gets a median of 2 refine tests (max 4) in 5 minutes.
- 68 to 70 % of tested cells are never accepted, 25 to 27 % once, and 5 %
  twice or more.
- So this is not fishing over many looks: the number of looks per cell is
  small.
- The late refine z has quartiles −0.2 to 0.0, 1.4 to 1.5 and 2.5, against a
  threshold of 3. The proposals beat the stale footprint on held-out frames
  by a small, real margin. The stale footprint is an older and noisier draw
  of the same estimate. About one in six proposals crosses z = 3, and when
  one does, the whole noise-sized difference is published.

**Merges of established cells continue at a steady rate.** At minutes 10 to
15 there are 84 and 72 merges:

- the kept cell's median age is 13 000 to 14 000 frames;
- the removed cell's median age is 5600 to 6800 frames;
- only 18 to 26 % of the removed cells are less than 2 minutes old.

Of the adds made at minutes 5 to 10, a third (62/174 and 59/188) end merged
by minute 15. Adds keep coming at about 20 per minute (17 to 30 in late
minutes, 15 to 25 % of them re-adds), against 13 to 17 merges per minute.
The merged-into cell jumps by 0.71 to 0.75 of its norm. This is the
"about 24 adds per minute" of #332: the slow loop adds and later merges, so
the library grows by about 5 cells per minute while churning.

## 4. PI labels against repeatedly edited cells

**Matching.** Labelled candidates (`labels/bundle`, 299 labels) were matched
to a final-library cell when its centroid was within 4 px. That matched 118
(seed 1) and 116 (seed 2) labels. The rest come from other runs or from
Minian and have no cell here.

**Classes.**

- "Repeatedly edited": two or more large own-edit changes, or a return.
- "One large edit".
- "Not edited": no large own-edit change.

| label  | seed 1: repeated / one / none | share repeated | seed 2: repeated / one / none | share repeated |
| ------ | ----------------------------- | -------------- | ----------------------------- | -------------- |
| cell   | 16 / 32 / 25                  | 0.22           | 28 / 29 / 25                  | 0.34           |
| unsure | 17 / 9 / 15                   | 0.41           | 10 / 13 / 8                   | 0.32           |
| not    | 2 / 1 / 1                     | (4 cells)      | 0 / 2 / 1                     | (3 cells)      |

There is no consistent association between being edited repeatedly and the
"unsure" or "not" labels. Seed 1 hints at it (0.41 against 0.22), but seed 2
does not (0.32 against 0.34). Almost all "not" candidates are absent from
these libraries. The labels are not ground truth: this is agreement only.

## Conclusion and recommendation

- **The cause.** Late footprint churn on real data comes entirely from the
  slow loop's own edits: refine about 60 %, merge about 27 %, absorb 10 %,
  split 1 to 4 %. Neighbour events, drift and rescaling contribute nothing
  measurable. The traces never move a footprint.
- **What the edits are like.** They don't oscillate. Refines are
  random-walk steps about 1.3 times the estimate's own split-half noise.
  Each one is accepted because it beats the stale footprint on held-out
  frames (median z about 1.5, one in six above 3). Each one publishes a
  noise-sized replacement.
- **Why exact estimates didn't help.** This is why S1.7 PR-2 (exact
  neighbour estimates) did not help: the noise of the running estimate, not
  its bias, sets the step size.
- **The evidence points to the decision rule (S2.1), not the trace side
  (S2.3).** The edit test asks "is the new footprint better on held-out
  data?" when it should ask "is the change larger than the estimate's
  noise?" A rule that publishes a footprint only when the difference is
  significant against its own SE would fit the S2.1 rework of add, keep and
  edit tests:
  - an equivalence margin,
  - or a shrinkage or blended update instead of a replacement,
  - with a matching rule for merges of established cells, which continue at
    a steady 15 to 20 % acceptance.

  The number of looks per cell is small, so a correction for repeated looks
  alone would not fix this.

- **The forgetting half-life.** `stats_half_life_frames` = 6000 sets the
  noise floor the published footprint wanders within. Separating the
  published footprint from the forgetting estimate is part of the same
  question.
- **The trace side (S2.3).** Re-solving traces in a repeated pass is not
  indicated by this data. Trace noise enters the footprint only through the
  running statistics, and making those statistics exact (PR-2) did not help.

Limits:

- Two seeds of one recording.
- The split-half noise is a half-data estimate.
- The neighbour reach uses centroid distances against radii from support
  size, with a moat margin of 2σ = 40 px.
- The label match covers only about 40 % of the labels.
