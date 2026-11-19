# Look-back review: is a settled look-back Discover enough to drop Refine? (19 Nov 2026)

Targets written 19 Nov 2026 before any run of this review (commit order shows it). Results go below them.

## Questions

1. Does a Refine pass after a settled look-back Discover (COMBO) still improve the library, or only move it?
2. Is the settling stop rule (no cell with an unserved block of its `K`-frame window) a convergence rule?
3. Is Refine slower after a look-back run because of the COMBO slow-loop settings?
4. Can settling use bigger batches once Discover has ended?
5. Does the workshop recording agree with the sims?

## Binary and arms

One binary for every arm: this branch's `qc_eval` (main bbe6e287 plus three eval-only flags; no library change):

- `--lookback-drain` may now be used with `--passes N` > 1: the drain runs at the end of pass 1, then the later passes
  run as before (a Refine after a settled look-back Discover, as the app does when Refine is pressed after it).
- `--lookback-drain-rate F`: look-back frames per drain step (default: the `--lookback` rate).
- `--noise-dump` with `--wrap-libs` also writes the split-half footprint noise at every wrap (`fp_noise_wrap{k}.tsv`).

Sim arms (full tier: static s5-s9, motion s5-s9, pairs s5-s8; suite defaults for everything not named):

| arm        | flags                                                                                 | what it is                              |
| ---------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `DR-main`  | suite default (`--passes 2 --later-passes refine`)                                    | Discover + 1 Refine, look-back off      |
| `COMBO`    | `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6` | the shipped look-back configuration |
| `COMBO+R`  | COMBO with `--passes 2 --later-passes refine --wrap-libs --noise-dump`                | COMBO, then one Refine                  |
| `DRR`      | `--passes 3 --later-passes refine --wrap-libs --noise-dump`                           | Discover + 2 Refines (the null)         |
| `COMBO-d16`, `COMBO-d64` | COMBO with `--lookback-drain-rate 16` / `64`                            | bigger settling batches                 |

Checks before the arms are trusted: `DR-main` and `COMBO` of this binary are byte-identical to `combo-full` (main
f14efd8c) on static_s5, pairs_s5 and motion_s5 (`footprints.bin`, `dump_trace.f32`); if so the `combo-full` runs are
reused for those two arms. `COMBO+R`'s wrap-1 library is byte-identical to `COMBO`'s final library.

## Targets

**T1. Does Refine after look-back still improve footprints (sims, ground truth)?** `COMBO+R` minus `COMBO`, suite rules
(paired, 95 % CI, 14 sims), also for the motion sims alone.

- Refine adds nothing that matters (go for dropping it) when all of: footprint r median for all, isolated and
  close-pair cells gains at most 0.002 (point estimate); crosstalk headline (corr excess < 1 D) improves by at most
  0.02; share r < 0.9 within noise; matched and false cells within noise.
- Refine still helps (no-go) when any footprint group gains more than 0.002 with a CI that excludes 0, or the headline
  improves by more than 0.02 with a CI that excludes 0. The group is named.
- Reported either way: `COMBO+R` vs `DR-main`, and the birth-time rows (second half, last 20 %).

**T2. Reproduction.** `COMBO` vs `DR-main` reproduces the full-tier table of
[2026-11-19-no-refine-full-tier.md](2026-11-19-no-refine-full-tier.md) (byte-identical runs, or every row within its CI).

**T3. Is the settled library converged (sims)?** Per cell, same id before and after a Refine pass, three numbers:
the app's "change" (relative L2, `|a' - a| / |a|`, amplitude included), a shape-only change (1 - cosine of the two
footprints), and the change in r with ground truth. Libraries: `COMBO` → `COMBO+R` (wrap 1 → final), and for scale
`DRR` wrap 1 → wrap 2 (the first Refine after a plain Discover) and `DRR` wrap 2 → final (a second Refine: the null,
what a Refine does to a library that already had one). Per-sim medians, paired CI over sims.

- Settled: the median change of `COMBO` → `COMBO+R` is at most 1.25 x the null (second Refine), on both the app's
  metric and the shape-only one; and at most the median split-half noise of the cells at wrap 1 (the plan's Gate A
  settled check).
- Not settled: above 1.5 x the null on the shape-only metric (CI excluding 1.25 x).
- Moving without improving: the share of cells whose r with ground truth rises is within 45-55 % and the mean change
  in r is within +-0.0005, while the app's change is above the null.
- Also reported: the same three numbers by group (isolated, close-pair, born in the last 20 %), and the share of cells
  the app would call "refined" (any change at all).

**T4. Refine cost under the COMBO slow-loop settings.** Controlled timing on static s5-s7: the arms of one sim run
together, 3 runs at once and nothing else. Arms: `DR-main`, `DR-st2g` (`--joint-update all --joint-sign all
--merge-guard-sep 0.6`, Refine with the COMBO slow-loop settings, no look-back), `COMBO+R`. Measure: wall of pass 2
(`passes.tsv`), ms per frame, and slow-loop work units per frame of pass 2.

- The settings explain the app's slowdown (about 2 x) when pass-2 wall of `DR-st2g` or `COMBO+R` is at least 1.5 x
  `DR-main`'s on every sim.
- They do not when the ratio is at most 1.2 on every sim; then the app's slowdown is in the app (workers, messages),
  and the code is read for it.
- In between: partly.

**T4b. Refine speed in the app (added 19 Nov before any browser run; qc_eval's slow loop is budget-paced, so its
pass-2 wall cannot show an app-side slowdown).** Headed Chrome, real GPU, `apps/cala/scripts/memory-measure.mjs
--single --headed` on the workshop recording, dev build of main bbe6e287, one run at a time, 2 runs per arm: look-back
off (Discover, Refine) and look-back on (`--lookback --refine`: Discover, settling, Refine). Measure: median Refine
fps over the samples of the Refine run, Refine wall, settling wall.

- The PI's observation is reproduced when Refine fps with look-back on is at most 0.7 x the look-back-off value in
  both pairs.
- If reproduced, one more arm from a build with `LOOKBACK.jointUpdate = 'off'` (look-back on, cluster replay off)
  separates the settings from the look-back plumbing: the settings are the cause when that arm's Refine fps is back
  within 15 % of look-back off.

**T5. Bigger settling batches.** `COMBO-d16` and `COMBO-d64` vs `COMBO`, full tier.

- Go when: footprint r median (all, isolated, close-pair) within 0.001 of `COMBO`; headline within 0.01; matched within
  1 %; false within noise; birth-time rows within noise; and drain steps fall by at least 3 x.
- Reported: drain steps, drain frames, drain wall, look-back wall.

**T6. Real data (workshop recording, 600 x 600, 18,000 frames, `qc_eval real --motion --frames 18000 --batch 8
--budget 30000000 --dump`, held-out score on).** Two runs per slow seed (1 and 2): `DRR` (`--passes 3 --later-passes
refine --wrap-libs`: its wraps are Discover, D + R, D + 2R) and `COMBO+R` (wraps: COMBO, COMBO + R). Two heavy runs at
a time, RAM under 6 GB each. No ground truth; Minian is a reference only.

- Change sizes by id, as T3: `COMBO` → `COMBO+R`, D → D + R, D + R → D + 2R (the null). The app showed 28.2 % median
  for the first; this run says whether qc_eval reproduces it and how it compares with the other two.
- Settled on real data: `COMBO` → `COMBO+R` shape-only change at most 1.25 x the null (D + R → D + 2R). Not settled:
  above 1.5 x.
- Agreement between libraries (Hungarian match on footprint correlation >= 0.7): share of cells matched and median
  footprint r of the matches, for `COMBO` vs D + R, `COMBO+R` vs D + R, `COMBO+R` vs D + 2R, with the seed 1 vs seed 2
  agreement of the same arm as the noise floor. Refine "moves COMBO toward D + R" if agreement rises by more than the
  seed-to-seed spread.
- Quality without ground truth: held-out score of each library (`final*.tsv` `ho_*`, `heldout.tsv`) and cell counts.
  `COMBO` is good enough on real data when its held-out score is not below D + R's by more than the seed-to-seed
  difference, and the Refine after it does not raise the held-out score by more than that difference.
- Minian agreement (share of Minian units matched) reported for each library, no pass/fail.

## Decision rule

- **Go** (default-on, Refine hidden under Advanced): T1 says Refine adds nothing that matters, T3 and T6 say settled
  (or moving without improving), and T6's held-out score does not favour a Refine after COMBO.
- **Go with a longer or different settle**: T1 or T6 show a gain from Refine that is concentrated in a nameable group
  (late-born, isolated); the recommendation is then the stop-rule change that gives that group its frames.
- **No-go** (keep Refine visible): Refine after COMBO gains more than 0.002 footprint r broadly, or the real-data
  held-out score clearly favours COMBO + R.

## Results

(to be filled in)
