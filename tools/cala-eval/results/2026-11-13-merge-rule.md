# Split-half merge rule (S2.1c merge redesign)

13 Nov 2026. Branch `feat/cala-merge-splithalf`. `SlowLoopConfig::merge_rule: MergeRule::{Legacy, SplitHalf}`,
`qc_eval --merge-rule legacy|split-half`. **Legacy stays the default** in this PR.

## Verdict

The split-half rule passes every pre-declared gate on static 1× sims and on real data.

- Distinct-unit merges fall 64 %.
- 90 % of true-duplicate merges are kept.
- Quality metrics are flat within noise.
- On real data, merges fall about 70 % and late merges about 80 %.
- Real cells rise by about 90. Seed-to-seed Jaccard rises from .711 to .757, and texture holds.

Recommendation: make it the default in a follow-up PR, once the motion arm has been checked after the GT-offset fix (see "Not done").

## The problem

Under the current rule, 66–82 % of accepted merges in the sims join two *different* ground-truth cells. Here that is 182 of 221 labelled merges over 5 static seeds. Each such merge loses a real cell. #350 (trace-correlation veto) removed only about a sixth of them.

## Rule

`MergeRule::SplitHalf` keeps the held-out merge test unchanged and adds one condition. A pair whose current footprints overlap less than ½ must also have **the same measured shape**, within the estimates' own split-half noise.

On the union of the two supports (pixels inside both statistics disks), the condition must hold in both directions X → Y and Y → X:

`Î = ‖h_X − a h_Y‖² − ½‖h_X,A − h_X,B‖² − a²·½‖h_Y,A − h_Y,B‖² ≤ 0`

- Quantities are whitened.
- `h` is the running-statistics estimate and `h_A`, `h_B` are its split halves.
- `a` is the least-squares scale.

This is the refine gate's `Î` (#365, #367) applied to a pair: the shapes differ by no more than two re-draws of the estimates would.

Other cases:
- Pairs that overlap ≥ ½ go to the held-out test alone. The bound is the existing ½ of the `one` shortcut, the equal-error point.
- A cell without split halves (a young cell) also falls back to the held-out test.

No new constant is introduced, and there is no size cap.

## Phase 1: what separates same- from distinct-unit candidates

Data: every merge test logged (`qc_eval --merge-log`, diagnostics feature) on static_s5–s9 1× with the current rule.
- 1620 tests had both cells GT-matched at r ≥ .5: 73 same-unit pairs and 1547 distinct-unit pairs.
- The current rule accepted 39 of the same-unit pairs and 182 of the distinct-unit pairs.

Labels are the best spatial GT match of each cell's filtered footprint, as in the #360 shadow.

| statistic (larger = more merge-like) | AUC, all tests (n same/dist) | AUC, legacy-accepted |
|---|---|---|
| legacy held-out z | .763 (73/1547) | .536 (39/182) |
| footprint overlap | .935 | .906 |
| −centre distance | .953 | .944 |
| −Î shape (split-half, refine form) | .674 (45/1360) | .802 (21/155) |
| −D² / split-half noise | .745 | .771 |
| cosine of the two estimates | .840 | .844 |
| cross-half debiased correlation | .854 | .850 |
| −one-soma basin dip (support-rule machinery on the pair's combined light) | .651 | .561 |
| −plan 4.2 energy-weighted θ | .855 | .404 |
| held-out trace correlation | .537 | .476 |

Applied to the legacy-accepted merges (offline, static estimate):

| rule | same kept | distinct kept (cut) |
|---|---|---|
| Î ≤ 0 alone (no halves → no merge) | 8/39 (21 %) | 9/182 (−95 %) |
| no halves → legacy, else Î ≤ 0 | 26/39 (67 %) | 36/182 (−80 %) |
| one-soma basin | 39/39 | 169/182 (−7 %) |
| θ < ½ (plan 4.2) | 39/39 | 181/182 (−1 %) |
| overlap ≥ ½ or no halves | 36/39 (92 %) | 55/182 (−70 %) |
| **chosen: overlap ≥ ½ or no halves or Î ≤ 0** | **38/39 (97 %)** | **62/182 (−66 %)** |

What the logs show:

1. **The simplest Î form alone fails true duplicates.** The running-statistics estimates are *conditional on the partner*: `r_A` has B's model removed. So a duplicate that the fast loop splits into two fragments gives two complementary, significant, different shapes, with cosine .2–.9. Shape equality is the right null only for pairs whose footprints do not already coincide. That is why the chosen rule exempts overlap ≥ ½, which covers 33 of the 39 accepted same-unit merges.
2. **The distinct-unit merges are not "absence of evidence".** The weaker cell claims a median of 98 null-SDs of light on the test frames. The fresh merged column simply beats the stale pair on held-out frames (θ < 0 in 90 % of them). So the plan's energy-weighted θ cannot see them.
3. **The pair's combined light usually has no significant dip between the two cells.** Typically a dim neighbour sits on a bright cell's flank. A morphology ("one soma") test therefore misses 93 % of these merges.
4. Centre distance (.95) and overlap (.94) separate best. Distance would need a constant tied to cell size, so it was not used.

## Phase 2: live A/B

Settings and controls:
- Same flags as the refine-gate eval (`--batch 8 --budget 30000000 --slow-seed 1 --churn-log`; real: `--motion --frames 18000 --via-jobs`, slow seeds 1 and 2).
- Controls are the Phase 1 logged runs.
- d = paired arm − control, mean ± 95 % t-CI over seeds.

**Identity.** The PR binary with the default (Legacy) and no diagnostics, against origin/main a09d984 on static_s5, is byte-identical in `final.tsv`, `cells.tsv`, `edits.tsv`, `removals.tsv`, `adds.tsv`, `footprints.bin` and `global.tsv`. The diagnostics-logged controls are identical to it as well. The identity was repeated after merging main 1d1629a (#370): see the end of this note.

### Static 1× (5 seeds)

| metric | control | split-half | d ± CI | signs +/− |
|---|---|---|---|---|
| merges / run | 51.0 | 23.0 | −28.0 ± 9.0 | 0/5 |
| distinct-unit merges / run | 36.4 | 13.0 | −23.4 ± 4.2 | 0/5 |
| same-unit merges / run | 7.8 | 7.0 | −0.8 ± 4.5 | 3/2 |
| P8 | .948 | .943 | −.005 ± .011 | 1/4 |
| R8 | .790 | .800 | +.010 ± .014 | 3/1 |
| R2 | .589 | .589 | +.001 ± .007 | |
| r_fp | .969 | .967 | −.002 ± .003 | 2/3 |
| fp_dup | 1.8 | 3.2 | +1.4 ± 2.9 | 4/1 |
| fp_adjacent / fp_partial | 4.4 / 11.6 | 5.8 / 12.6 | +1.4 ± 3.4 / +1.0 ± 3.6 | |
| cells | 512 | 521 | +9.4 ± 9.0 | 4/1 |
| conv_big4 | .122 | .114 | −.008 ± .018 | |
| late merges / min (last 4 min) | 6.9 | 2.75 | −4.2 ± 1.3 | 0/5 |

Summed over seeds: distinct-unit merges 182 → 65 (−64 %); same-unit merges 39 → 35 (90 % kept). The rule vetoed 35 merges per run: 30 distinct-unit, 1.2 same-unit and 4 low-match.

### Real (workshop recording, slow seeds 1 and 2)

| | control s1 / s2 | split-half s1 / s2 |
|---|---|---|
| cells | 733 / 740 | 815 / 840 |
| texture | 1 / 1 | 1 / 2 |
| seed-to-seed Jaccard | .711 | .757 |
| merges | 260 / 283 | 75 / 89 |
| late merges / min | 17.8 / 22.3 | 3.0 / 4.3 |
| Minian agreement r ≥ .5 (reference, not GT) | 521 / 522 | 585 / 599 |
| cells with held-out z < 2 | 189 / 186 | 200 / 203 |

**PI hand labels (soft check only; older cala, many borderline).** A merge "joins two PI cells" when each cell centre lies within 5 px of a different label marked *cell*. Such merges went from 4 / 8 under the control to 3 / 5 under the split-half rule.

Two pairs are merged under both rules and are worth showing the PI:
- Labels (464, 462) and (470, 463), 6 px apart. Merged in both seeds.
- Labels (558, 339) and (568, 340). Merged in seed 2.

### Static 4× (seeds 5–7)

X4_TABLE

## Gates (pre-declared in the run log before Phase 2)

| gate | result | |
|---|---|---|
| distinct-unit merges down ≥ 50 % (static 1×) | −64 % | pass |
| same-unit merges kept ≥ 80 % | 90 % | pass |
| fp_dup not up beyond CI noise | +1.4 ± 2.9 (CI covers 0; signs 4/1) | pass, watch |
| P8 / R8 ≥ −.02 | −.005 / +.010 | pass |
| r_fp ≥ −.010 | −.002 | pass |
| real texture ≤ control + 2 | 1 → 1, 1 → 2 | pass |
| real Jaccard ≥ control − .01 | .711 → .757 | pass |

## Not done / caveats

- **Motion 1× is not evaluated.** The GT-offset fix for motion-arm scoring had not landed when this ran, so merge labels on motion arms are not yet trustworthy. Run `qc_eval sim motion_s{5..9} --merge-rule split-half --merge-log` against controls once the fix is merged, before switching the default.
- fp_dup rises in 4 of 5 seeds (+1.4 per run). The PI's "tolerate early mistakes" principle applies: a duplicate kept apart is re-tested after its cooldown, and once its halves agree, or its footprints come to coincide, it merges. A per-pair evidence accumulator (plan 4.2 `PairEvidence`) would make that explicit.
- The 65 distinct-unit merges that remain break down as follows:
  - 32 have overlap ≥ ½ and are exempt. In the sims, cells can overlap in projection.
  - 28 involve a cell without split halves (a young cell), so the held-out test decided alone.
  - 5 passed the shape test.

  Requiring halves before any non-overlapping merge would close the second group. Its effect on early duplicate cleanup (14 of the 35 kept same-unit merges are no-halves) needs its own A/B.

## Reproduce

- Build: `cargo build --release --example qc_eval --features diagnostics` (the merge log needs diagnostics; the rule does not).
- Sims: `qc_eval sim $CALA_SIMS/static_sN out --batch 8 --slow-seed 1 --churn-log --budget 30000000 [--merge-rule split-half] [--merge-log]`
- Real: `qc_eval real <prerecorded raw> out --motion --frames 18000 --batch 8 --budget 30000000 --via-jobs --churn-log --slow-seed S [--merge-rule split-half]`
- `merges.jsonl` has one line per merge test: legacy z, overlap, arm, the split-half statistic, per-frame arm χ², and both cells' supports, statistics and halves.
