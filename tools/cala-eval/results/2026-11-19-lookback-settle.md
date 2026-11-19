# Look-back settle: what a Refine pass adds, and a settle that includes it (19 Nov 2026)

Follow-up to [2026-11-19-lookback-review.md](2026-11-19-lookback-review.md) (its recommendation, item 2). Targets
written before any run of this study (commit order shows it). Results go below them.

## Questions

1. Which part of a Refine pass does the look-back path lack? The review's settle-all arm (every frame to every cell
   through the look-back path, cell set frozen) recovered about half of the Refine's gain.
2. How few frames does that part need?
3. Can the end-of-Discover settle be that pass, run by the look-back path in batches, with a stop rule based on
   footprint change against split-half noise?
4. Does the result hold on the workshop recording?

## What the code says (read before the runs)

A Refine pass feeds each frame to `SlowLoop::observe`; the look-back path feeds it to `observe_lookback`. The
differences, all of them:

| part                                     | Refine pass (`observe`)                                    | settle-all (`observe_lookback`, review arm)                |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| footprint statistics and cluster stores  | every fitting frame, forgetting clock advances             | the same (untargeted frames advance the clock)             |
| reservoir (fit and held-out frames)      | every frame is offered; slots turn over                    | frozen at the end of Discover                              |
| what makes a tile due for a visit        | new reservoir slots (6)                                    | `mark_all_due` every 64 steps (128 frames)                 |
| the held-out frames the refine gate uses | turn over with the reservoir, chosen by the *current* fit's residual | the same few dozen frames at every visit         |
| frame counter (`frames`)                 | advances: publishes every 100 frames, cells age past the reservoir-refine window | stands still: published by the driver every 128 frames |
| slow-loop steps                          | one per frame                                              | one per 2 frames                                           |
| evidence ledger, probes, noise correlation, noise map | updated                                       | not updated (not used by Refine-scope visits)              |

Counts from the review's runs (static_s5): the Refine pass accepted 9456 refinements with 19.7 M work units of refine
work per frame; the settle-all tail accepted 5845 with about 10.8 M per frame fed.

## Binary and arms

One binary, `qc_eval-lbsettle-a` (main 87e21730 plus this branch): a new tail after the drain, `--settle-frames N`
with options (see the header of `qc_eval.rs`), and one default-off library switch,
`SlowLoop::set_reservoir_frozen` (evaluation only). `COMBO` = `--passes 1 --joint-update all --joint-sign all
--lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6`. Every arm below is `COMBO` plus a tail; all tails keep the
cell set frozen (Refine scope). References reused from the review's run trees after a byte check of this binary:
`COMBO`, `COMBO+R` (full tier), `COMBO-SA9600` (quick tier), `DR-main`.

Screen (quick tier: static s5-s7, pairs s5-s6; 9600 frames per tail unless named):

| arm           | tail flags                                                                          | adds to the previous rung               |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| `COMBO-SA9600`| review arm (look-back path, 1 step per 2 frames, due and publish every 128 frames)  | -                                       |
| `ST-stats`    | `--settle-observe stats --settle-steps 1 --settle-due 64 --settle-publish 100`      | twice the steps and visit rounds        |
| `ST-frozen`   | `--settle-observe frozen --settle-due 64`                                           | frame counter, ledger (reservoir frozen) |
| `ST-full-due` | `--settle-observe full --settle-due 64`                                             | reservoir turns over                    |
| `ST-full`     | `--settle-observe full` (visits by new slots only, as in a Refine pass)             | the Refine pass through the look-back path |
| `ST-half`     | `ST-full` with `--settle-frames 4800 --settle-round 4800`                           | every second 64-frame block             |
| `ST-quarter`  | `ST-full` with `--settle-frames 2400 --settle-round 2400`                           | every fourth block                      |
| `ST-b16`      | `ST-full` with `--settle-batch 16`                                                  | 16 frames per request                   |
| `COMBO+R`     | `--passes 2 --later-passes refine`                                                  | the reference                           |

Arms may be added after the screen (a rung split further, a stride from the Refine side); each is listed with its
flags and judged by the same rules. An arm that clearly fails on the first sims is stopped.

## Targets

Suite rules: paired differences per sim, 95 % CI over sims. "Footprint r" is the suite's median footprint r with
ground truth.

**M1. The Refine pass can be run through the look-back path.** `ST-full` vs `COMBO+R`: footprint r (all, isolated,
close-pair) within 0.001 (point estimate); born second half within 0.005; bite share (< 0.5, 0.75-1 D) within 0.03.
If this fails, the remaining difference (preprocessor state, trace engine) is read from the code and tested.

**M2. Which rung carries the gap.** The gap is `COMBO+R - COMBO-SA9600` (quick tier: +0.0011 all cells, +0.017 born
second half, bite share -0.075). A rung carries it when the step onto that rung gains at least one third of the gap on
all-cell r or on born-second-half r, with a CI that excludes 0, or at least 0.03 of bite share. Steps: `SA9600` ->
`ST-stats` (visit work), -> `ST-frozen` (frame counter), -> `ST-full-due` (reservoir), -> `ST-full` (visit cadence).
Reported per arm: visits, accepted refinements, publishes and work units of the tail, so that "more frames" is not
confused with "more visits".

**M3. How few frames.** `ST-half` and `ST-quarter` vs `ST-full`: enough when footprint r (all, isolated, close-pair)
is within 0.001 and born second half within 0.005 with a CI that includes 0. Reported: the same against `COMBO+R`.

**M4. Batching.** `ST-b16` vs `ST-full`: go when footprint r groups within 0.001, the born-late rows and the bite rows
within noise (CI includes 0), and the tail's visits per frame not below 0.8 x `ST-full`'s.

**M5. Stop rule (calibrated on the screen, then fixed before the full tier).** At every checkpoint (1200 frames) the
tail logs each cell's footprint change since the last checkpoint over its split-half noise. The rule is a threshold on
one of the logged summaries (median, upper quantile, or share of cells above k x noise). It is acceptable when, on
every quick-tier sim and on the workshop recording: it does not fire at the first checkpoint after `COMBO`; it fires
within 9600 further frames on a library that has already had 9600 settle frames; and the library at the stop meets
M6. The review's finding that the median alone barely separates `COMBO` (1.09 x noise) from the null (0.97 x) on the
sims is the reason the summary is chosen from data.

**M6. The deciding arm (full tier, 14 sims).** `SETTLE` = `COMBO` + the settle with the batch size, round size, frame
cap and stop rule chosen above. Against `COMBO+R`:

- Go: footprint r (all, isolated, close-pair) not lower by more than 0.001 (point estimate); born second half not
  lower by more than 0.005; born last 20 % with a CI that includes 0 or is better; crosstalk headline within 0.01;
  bite share (0.75-1 D) not higher by more than 0.03; matched cells within 1 %; false cells within noise. And against
  `DR-main`: no footprint group worse with a CI that excludes 0.
- No-go: footprint r for all cells lower than `COMBO+R` by more than 0.002 with a CI that excludes 0, or born second
  half lower by more than 0.01 with a CI that excludes 0.
- In between: reported as partial, with the group named.
- Cost, reported: settle frames, wall, frames per second, against the Refine pass of `COMBO+R` in the same binary.

**M7. Real data (workshop recording, 600 x 600, 18,000 frames, `qc_eval real`, at least 3 slow seeds).** `SETTLE`
against the review's numbers for D + R and `COMBO+R` (seeds 1 and 2; the third seed is run for the references too).
No ground truth; Minian is a reference only.

- Go when all of: seed-to-seed median footprint r of `SETTLE` at least 0.970 (D + R and `COMBO+R`: 0.976; `COMBO`:
  0.953) and matched share at least 84 %; Minian-matched median r at least 0.945 (D + R 0.953-0.958, `COMBO+R`
  0.949-0.950, `COMBO` 0.935-0.939); median split-half noise at most 11 % (D + R 9.9-10 %, `COMBO` 14.5 %); and a
  Refine after `SETTLE` moves footprints by at most 1.5 x the null (the second Refine: 10 %, shape 0.0045).
- No-go when the seed-to-seed median r is below 0.965 or the Refine after `SETTLE` moves footprints more than 2 x the
  null.
- A second real recording is run with the same measures if one is found under `~/Projects`.

**M8. The missing cells.** `COMBO` keeps about 80 fewer cells than Discover on the workshop recording. Match the
`COMBO` and Discover libraries of each seed; for the Discover cells without a `COMBO` partner report: how many sit
within 0.6 D of a kept `COMBO` cell (the merge guard's reach), how many were merged (merge log) and by which rule, how
many were never added, and how many match a Minian unit. No pass/fail; the finding decides whether the loss is
duplicates going away.

## Decision rule

- **Go** (settle replaces the routine Refine; default-on can be planned): M6 go and M7 go.
- **Go on sims only**: M6 go, M7 between its lines; the real-data gap is named.
- **No-go**: M6 no-go, or M7 no-go.

## Results (19 Nov 2026)

Binaries `qc_eval-lbsettle-a` (sims) and `qc_eval-lbsettle-b` (workshop recording; `a` plus a fix so the settle stops
at `--frames` when the file is longer). Run trees: `$CALA_DATA/demix-suite/lbsettle-q` (screen, `ladder.md`),
`$CALA_DATA/demix-suite/lbsettle-full` (deciding arm), `$CALA_DATA/runs/lbsettle/real` (workshop recording),
`$CALA_DATA/runs/lbsettle/missing` (M8). References `COMBO`, `COMBO+R`, `DR-main`, `COMBO-SA9600` are the review's
runs (not re-run; the settle tail starts after an unchanged Discover and drain, and `ST-full` reproduces `COMBO+R` to
the fourth decimal, below).

Deviations from the plan above, all decided before the affected runs: `ST-quarter` ran on the three static sims only
and the separate quick-tier `ST-b16` arm was dropped (the full-tier `SETTLE` arm is that arm on 14 sims), to keep the
shared six run slots for the deciding runs. The workshop runs kept the held-out score on, as the review's did.

### In plain language

- **What a Refine pass has and look-back lacks is fresh test frames.** Every proposed footprint must do better on
  held-out frames stored per tile (the reservoir). A Refine pass keeps replacing those frames, and it picks the frames
  where the current footprints fit worst. The look-back path feeds the statistics but never the reservoir, so during
  settling every proposal is tested on the same few dozen frames left over from Discover. A change that those frames
  cannot show is rejected at every visit. With the same number of proposals, 12-15 % pass against the frozen frames and
  36 % against fresh ones.
- **Nothing else matters.** Twice the visit work with the reservoir frozen gains nothing. Advancing the frame counter
  and the ledger gains nothing. Letting the reservoir turn over closes the whole gap to `COMBO+R`.
- **So the settle should be a Refine pass, fed by the look-back worker.** Re-read frames go through the ordinary
  `observe` once the cell set is frozen. On the sims that tail equals `COMBO+R` in every row.
- **Footprints do not converge at a sharp point.** They keep improving at a falling rate for about one pass. Half the
  frames give nearly the same overall footprints but leave late-born cells behind; a second pass adds little.
- **The change-against-noise stop rule works as a floor, not as a finish line.** It tells an unsettled library (40 %
  of cells moving more than twice their noise on the workshop recording) from a settled one (2-3 %), on sims and real
  data at the same level. But it reaches that floor after about half a pass, while agreement between seeds on the
  workshop recording keeps rising until the full pass. The frame budget has to decide; the rule can only veto.

### M1 and M2. The ladder (quick tier, 5 sims; diffs are to the arm named)

| arm           | what the tail feeds                         | fp r all vs `COMBO+R`      | fp r born 2nd half vs `COMBO+R` | bite share 0.75-1 D vs `COMBO+R` | cluster proposals / accepted in the tail | refinements accepted per sim | visits per frame |
| ------------- | ------------------------------------------- | -------------------------- | ------------------------------- | -------------------------------- | ---------------------------------------- | ---------------------------- | ---------------- |
| `COMBO`       | no tail                                     | -0.0024 [-0.0032, -0.0017] | -0.0269 [-0.0354, -0.0187]      | +0.107 [0.054, 0.156]            | -                                        | -                            | -                |
| `COMBO-SA9600`| statistics; 1 step per 2 frames             | -0.0011 [-0.0018, -0.0005] | -0.0169 [-0.0246, -0.0058]      | +0.075 [0.027, 0.122]            | 12,250 / 1,859 (15 %)                    | -                            | about 0.6        |
| `ST-stats`    | statistics; 1 step per frame, twice the visit rounds | -0.0012 (step from SA: -0.0000 [-0.0007, 0.0006]) | step: +0.0017 [-0.0121, 0.0136] | step: +0.016 [-0.035, 0.068] | 23,987 / 2,900 (12 %)                    | 3,053                        | 1.31             |
| `ST-frozen`   | ordinary `observe`, reservoir frozen        | step: -0.0001 [-0.0006, 0.0006] | step: -0.0001 [-0.0127, 0.0118] | step: -0.010 [-0.063, 0.043]  | 24,254 / 3,072 (13 %)                    | 3,070                        | 1.32             |
| `ST-full-due` | ordinary `observe`, reservoir turns over    | step: +0.0012 [0.0007, 0.0018] | step: +0.0146 [0.0054, 0.0242] | step: -0.077 [-0.124, -0.030]   | 27,004 / 9,655 (36 %)                    | 8,060                        | 1.81             |
| `ST-full`     | the same, visits by new slots only          | -0.0000 [-0.0006, 0.0006]  | -0.0006 [-0.0056, 0.0050]       | -0.007 [-0.054, 0.035]           | 26,976 / 9,656 (36 %)                    | 8,067                        | 1.81             |
| `COMBO+R`     | a Refine pass                               | reference                  | reference                       | reference                        | 26,820 / 9,760 (36 %)                    | -                            | -                |

- **M1 met.** `ST-full` equals `COMBO+R` on every row (footprint r all / isolated / close-pair -0.0000 / -0.0001 /
  +0.0001; born second half -0.0006; born last 20 % -0.0010; headline -0.000; matched and false cells within 1). A
  Refine pass can be run through the look-back path; nothing in the Refine stage itself is needed.
- **M2: the reservoir carries the whole gap.** The step `ST-frozen` -> `ST-full-due` gains +0.0012 on all cells (the
  gap was 0.0011), +0.015 on cells born in the second half (gap 0.017) and removes 0.077 of bite share (gap 0.075),
  all with CIs that exclude 0. The other steps are within noise of zero: more steps and visit rounds (`SA9600` ->
  `ST-stats`), the frame counter and ledger (`ST-stats` -> `ST-frozen`), the visit cadence (`ST-full-due` ->
  `ST-full`).
- **Why.** Both refinement paths (`refine()` for single cells in `discover/mod.rs`, `refine_clusters()` in
  `discover/cluster.rs`) accept a proposal only when it lowers the χ² of the tile's held-out reservoir frames. In a
  Refine pass `observe` offers every frame to the reservoir; event slots go to the frames with the largest residual
  under the current library, so the test set keeps moving to where the footprints are still wrong (a bitten footprint
  leaves light in the residual). `observe_lookback` does not touch the reservoir. During settling the test set is
  whatever Discover left, a refinement that fails on it fails again at the next visit, and late-born cells, whose
  light the old frames barely contain, gain least.

### M3. How few frames (quick tier; vs `ST-full`, 9600 frames)

| arm                                   | frames | fp r all                   | fp r isolated | fp r close-pair | fp r born 2nd half         | bite share later-born 0.5-0.75 D | settle wall, s |
| ------------------------------------- | ------ | -------------------------- | ------------- | --------------- | -------------------------- | -------------------------------- | -------------- |
| `ST-half` (every 2nd 64-frame block)  | 4800   | -0.0003 [-0.0009, 0.0002]  | -0.0006       | -0.0003         | -0.0061 [-0.0109, 0.0024]  | +0.078 [0.009, 0.148]            | 77             |
| `ST-full`                             | 9600   | reference                  | -             | -               | -                          | -                                | 179            |
| `ST-2x` (two passes)                  | 19,200 | +0.0003 [-0.0002, 0.0008]  | +0.0005       | +0.0003         | +0.0028 [-0.0018, 0.0091]  | -0.006 [-0.065, 0.053]           | 313            |

By the written rule half the frames are not quite enough: the overall rows are within 0.001, but cells born in the
second half are 0.006 lower (over the 0.005 line; the CI includes 0) and later-born bites are worse. Two passes add
+0.0003. `ST-quarter`: see the addendum below.

### M5. Stop rule calibration

`settle_checks.py` tables: quick-tier sims, `ST-2x` (checkpoints every 1200 frames); workshop recording, `CAL` runs
(`COMBO` + 36,000 settle frames, two passes, checkpoints every 1800 frames, slow seeds 1 and 2).

| frames fed (sims) | share of cells moving > 2 x noise | fp r all | fp r born 2nd half |     | frames fed (workshop) | share > 2 x noise, s1 / s2 | change median, s1 | seed 1 vs seed 2: matched share, median r | Minian median r, s1 / s2 |
| ----------------- | --------------------------------- | -------- | ------------------ | --- | --------------------- | -------------------------- | ----------------- | ----------------------------------------- | ------------------------ |
| 0                 | -                                 | 0.9889   | 0.9266             |     | 0 (`COMBO`)           | -                          | -                 | 82.3 %, 0.9525                            | 0.939 / 0.935            |
| 1200              | 0.094                             | 0.9895   | 0.9431             |     | 1800                  | 0.398 / 0.379              | 25.7 %            | -                                         | -                        |
| 2400              | 0.051                             | 0.9898   | 0.9488             |     | 3600                  | 0.149 / 0.109              | 12.2 %            | 82.6 %, 0.9593                            | 0.940 / 0.942            |
| 3600              | 0.034                             | 0.9900   | 0.9713             |     | 5400                  | 0.080 / 0.065              | 8.9 %             | 84.2 %, 0.9651                            | 0.944 / 0.943            |
| 4800              | 0.017                             | 0.9902   | 0.9717             |     | 7200                  | 0.032 / 0.029              | 7.7 %             | 84.7 %, 0.9661                            | 0.944 / 0.948            |
| 6000              | 0.026                             | 0.9904   | 0.9784             |     | 9000                  | 0.035 / 0.016              | 7.4 %             | 85.0 %, 0.9693                            | 0.946 / 0.945            |
| 7200              | 0.020                             | 0.9906   | 0.9783             |     | 10,800                | 0.041 / 0.041              | 9.2 %             | 85.1 %, 0.9733                            | 0.946 / 0.946            |
| 9600 (one pass)   | 0.025                             | 0.9906   | 0.9790             |     | 14,400                | 0.015 / 0.015              | 6.1 %             | 85.9 %, 0.9758                            | 0.948 / 0.947            |
| 12,000            | 0.030                             | 0.9907   | 0.9797             |     | 18,000 (one pass)     | 0.032 / 0.021              | 7.3 %             | 86.0 %, 0.9776                            | 0.949 / 0.948            |
| 19,200            | 0.023                             | 0.9906   | 0.9808             |     | 27,000                | 0.017 / 0.015              | 5.5 %             | 86.7 %, 0.9786                            | 0.947 / 0.948            |
|                   |                                   |          |                    |     | 36,000 (two passes)   | 0.017 / 0.028              | 7.0 %             | 87.6 %, 0.9794                            | 0.950 / 0.950            |

(Sims: fp r here is the median best r of matched cells in the checkpoint libraries, a slightly different statistic
from the suite's; workshop references from the review: D + R 86 %, 0.976; `COMBO+R` 86 %, 0.976; D + 2R 88 %, 0.981.)

- The share of cells that moved more than twice their own split-half noise since the last checkpoint separates
  unsettled from settled libraries at the same level on sims and real data: 9-40 % at the first checkpoint after
  `COMBO`, 2-3 % (range 1.5-4 %) once flat. The median ratio does not separate them (0.44 -> 0.52 on sims), as the
  review found.
- A rule "at most 4 % of cells above 2 x noise at two checkpoints in a row" does not fire at the first checkpoint and
  fires within one further pass on a settled library, as M5 asked. It fires at 4800 frames on the sims and at 9000 on
  both workshop seeds.
- **But the library at that stop does not meet M6/M7.** On the workshop recording the seed-to-seed median r is 0.969
  at 9000 frames against 0.978 after the full pass (the M7 line is 0.970), and it is still rising: 0.973, 0.976,
  0.978. On the sims late-born cells are at 0.972 at the stop against 0.979 after the pass. Footprint change per
  checkpoint is by then inside the noise of the estimate, but it is not noise: it keeps going the same way.
- Over longer spans the drift shows (workshop, median change by id): first half pass 30 %, second half 17-18 %, third
  15 %, fourth 13 %; the whole second pass 11.2 % against the review's null of 10 % for a second Refine. One full pass
  through the settle moves footprints exactly as far as the Refine after `COMBO` did (29-30 %).
- **Verdict M5: the rule is acceptable as a floor only.** It meets the first two conditions and fails the third (the
  library at its stop is not yet at Refine level). The settle should run its frame budget and use the rule to report
  "not settled" (or to extend), never to stop early. A likely reason for the slow tail, not tested here: the footprint
  statistics forget with a 6000-frame half-life, so after 9000 settle frames a third of their weight is still from
  Discover, when neighbours' footprints were worse.

### M8. The cells `COMBO` does not have (workshop recording, both seeds; `runs/lbsettle/missing`)

Hungarian match (footprint r >= 0.7) between the plain-Discover library and the `COMBO` library of the same seed.

|                                              | seed 1 | seed 2 |
| -------------------------------------------- | ------ | ------ |
| Discover / `COMBO` cells                     | 831 / 751 | 838 / 760 |
| matched                                      | 629    | 649    |
| Discover only                                | 202    | 189    |
| `COMBO` only                                 | 122    | 111    |
| Discover only: a `COMBO` cell covers the place with a different footprint (best r 0.4-0.7) | 135 | 140 |
| Discover only: nothing was ever added there in the `COMBO` run | 50 | 38 |
| Discover only: added in the `COMBO` run, then merged or deleted | 6 | 7 |
| adds / merges / deletes, Discover            | 929 / 125 / 9 | 934 / 130 / 12 |
| adds / merges / deletes, `COMBO`             | 820 / 104 / 4 | 842 / 115 / 8 |

- The net loss of 80 is 190-200 cells that only Discover has minus 110-120 that only `COMBO` has. The two libraries
  differ in about 320 cells, mostly the same places with differently shaped footprints.
- **The merge guard and the replay's merges do not remove them.** Six or seven of the 200 were added and then merged or
  deleted. `COMBO` merges fewer cells than Discover, not more. The difference is in adds: from frame 3600 on `COMBO`
  adds 25-50 % fewer cells per 1800 frames, steadily.
- The cells only Discover has are weaker and less reproducible than the matched ones: median peak z 12 against 19-20,
  half the transients, 51-57 % found again by the other seed against 90 %, 30-41 % matching a Minian unit against
  70 %. About a quarter sit within 0.6 D of, or overlap, another Discover cell (duplicate or fragment candidates). The
  cells only `COMBO` has look the same (37-40 % match Minian).
- Where nothing was added in `COMBO`, the place is partly covered by an existing `COMBO` footprint (median 0.46 of the
  covering cell's peak at the missing cell's centre, against 0.94 at matched centres).
- Reading (inference, not measured): with look-back the existing footprints fill in sooner and leave less light in
  the residual, so fewer weak, overlapping components are proposed. Most of the loss is such components, not solid
  cells; the 20-30 fewer Minian matches are real and sit among them. The files cannot say why a given place was not
  added (there is no per-place rejection log). D was taken as the 10 px default.
