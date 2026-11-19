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

| part                                                  | Refine pass (`observe`)                                                          | settle-all (`observe_lookback`, review arm)            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| footprint statistics and cluster stores               | every fitting frame, forgetting clock advances                                   | the same (untargeted frames advance the clock)         |
| reservoir (fit and held-out frames)                   | every frame is offered; slots turn over                                          | frozen at the end of Discover                          |
| what makes a tile due for a visit                     | new reservoir slots (6)                                                          | `mark_all_due` every 64 steps (128 frames)             |
| the held-out frames the refine gate uses              | turn over with the reservoir, chosen by the _current_ fit's residual             | the same few dozen frames at every visit               |
| frame counter (`frames`)                              | advances: publishes every 100 frames, cells age past the reservoir-refine window | stands still: published by the driver every 128 frames |
| slow-loop steps                                       | one per frame                                                                    | one per 2 frames                                       |
| evidence ledger, probes, noise correlation, noise map | updated                                                                          | not updated (not used by Refine-scope visits)          |

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

| arm            | tail flags                                                                         | adds to the previous rung                  |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| `COMBO-SA9600` | review arm (look-back path, 1 step per 2 frames, due and publish every 128 frames) | -                                          |
| `ST-stats`     | `--settle-observe stats --settle-steps 1 --settle-due 64 --settle-publish 100`     | twice the steps and visit rounds           |
| `ST-frozen`    | `--settle-observe frozen --settle-due 64`                                          | frame counter, ledger (reservoir frozen)   |
| `ST-full-due`  | `--settle-observe full --settle-due 64`                                            | reservoir turns over                       |
| `ST-full`      | `--settle-observe full` (visits by new slots only, as in a Refine pass)            | the Refine pass through the look-back path |
| `ST-half`      | `ST-full` with `--settle-frames 4800 --settle-round 4800`                          | every second 64-frame block                |
| `ST-quarter`   | `ST-full` with `--settle-frames 2400 --settle-round 2400`                          | every fourth block                         |
| `ST-b16`       | `ST-full` with `--settle-batch 16`                                                 | 16 frames per request                      |
| `COMBO+R`      | `--passes 2 --later-passes refine`                                                 | the reference                              |

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
runs, not re-run. Byte check: the library each settle starts from (`footprints_settle0.bin` of `ST-full`) is
byte-identical to the review's `COMBO` library on static_s5, static_s6 and pairs_s5.

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

| arm            | what the tail feeds                                  | fp r all vs `COMBO+R`                             | fp r born 2nd half vs `COMBO+R` | bite share 0.75-1 D vs `COMBO+R` | cluster proposals / accepted in the tail | refinements accepted per sim | visits per frame |
| -------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------- | -------------------------------- | ---------------------------------------- | ---------------------------- | ---------------- |
| `COMBO`        | no tail                                              | -0.0024 [-0.0032, -0.0017]                        | -0.0269 [-0.0354, -0.0187]      | +0.107 [0.054, 0.156]            | -                                        | -                            | -                |
| `COMBO-SA9600` | statistics; 1 step per 2 frames                      | -0.0011 [-0.0018, -0.0005]                        | -0.0169 [-0.0246, -0.0058]      | +0.075 [0.027, 0.122]            | 12,250 / 1,859 (15 %)                    | -                            | about 0.6        |
| `ST-stats`     | statistics; 1 step per frame, twice the visit rounds | -0.0012 (step from SA: -0.0000 [-0.0007, 0.0006]) | step: +0.0017 [-0.0121, 0.0136] | step: +0.016 [-0.035, 0.068]     | 23,987 / 2,900 (12 %)                    | 3,053                        | 1.31             |
| `ST-frozen`    | ordinary `observe`, reservoir frozen                 | step: -0.0001 [-0.0006, 0.0006]                   | step: -0.0001 [-0.0127, 0.0118] | step: -0.010 [-0.063, 0.043]     | 24,254 / 3,072 (13 %)                    | 3,070                        | 1.32             |
| `ST-full-due`  | ordinary `observe`, reservoir turns over             | step: +0.0012 [0.0007, 0.0018]                    | step: +0.0146 [0.0054, 0.0242]  | step: -0.077 [-0.124, -0.030]    | 27,004 / 9,655 (36 %)                    | 8,060                        | 1.81             |
| `ST-full`      | the same, visits by new slots only                   | -0.0000 [-0.0006, 0.0006]                         | -0.0006 [-0.0056, 0.0050]       | -0.007 [-0.054, 0.035]           | 26,976 / 9,656 (36 %)                    | 8,067                        | 1.81             |
| `COMBO+R`      | a Refine pass                                        | reference                                         | reference                       | reference                        | 26,820 / 9,760 (36 %)                    | -                            | -                |

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
  light the old frames barely contain, gain least. (The ablation separates the reservoir as a whole. That it is the
  held-out half, and the choice of frames by residual, is read from the code and the accept rates, not ablated.)

### M3. How few frames (quick tier; vs `ST-full`, 9600 frames)

| arm                                  | frames | fp r all                  | fp r isolated | fp r close-pair | fp r born 2nd half        | bite share later-born 0.5-0.75 D | settle wall, s |
| ------------------------------------ | ------ | ------------------------- | ------------- | --------------- | ------------------------- | -------------------------------- | -------------- |
| `ST-half` (every 2nd 64-frame block) | 4800   | -0.0003 [-0.0009, 0.0002] | -0.0006       | -0.0003         | -0.0061 [-0.0109, 0.0024] | +0.078 [0.009, 0.148]            | 77             |
| `ST-full`                            | 9600   | reference                 | -             | -               | -                         | -                                | 179            |
| `ST-2x` (two passes)                 | 19,200 | +0.0003 [-0.0002, 0.0008] | +0.0005       | +0.0003         | +0.0028 [-0.0018, 0.0091] | -0.006 [-0.065, 0.053]           | 313            |

By the written rule half the frames are not quite enough: the overall rows are within 0.001, but cells born in the
second half are 0.006 lower (over the 0.005 line; the CI includes 0) and later-born bites are worse. Two passes add
+0.0003. `ST-quarter` was not run. The strided arm restarts the preprocessor at every 64-frame block, so its shortfall
cannot be pinned on the frame count alone.

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
  fires within one further pass on a settled library, as M5 asked. Per run it fires at 2400 (pairs_s5), 4800
  (static_s5, static_s7, pairs_s6) and 8400 frames (static_s6), and at 9000 on both workshop seeds.
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

|                                                                                            | seed 1        | seed 2         |
| ------------------------------------------------------------------------------------------ | ------------- | -------------- |
| Discover / `COMBO` cells                                                                   | 831 / 751     | 838 / 760      |
| matched                                                                                    | 629           | 649            |
| Discover only                                                                              | 202           | 189            |
| `COMBO` only                                                                               | 122           | 111            |
| Discover only: a `COMBO` cell covers the place with a different footprint (best r 0.4-0.7) | 135           | 140            |
| Discover only: nothing was ever added there in the `COMBO` run                             | 50            | 38             |
| Discover only: added in the `COMBO` run, then merged or deleted                            | 6             | 7              |
| adds / merges / deletes, Discover                                                          | 929 / 125 / 9 | 934 / 130 / 12 |
| adds / merges / deletes, `COMBO`                                                           | 820 / 104 / 4 | 842 / 115 / 8  |

- The net loss of 80 is 190-200 cells that only Discover has minus 110-120 that only `COMBO` has. The two libraries
  differ in about 320 cells, mostly the same places with differently shaped footprints.
- **In `COMBO` the loss shows up as fewer adds, not more merges.** Six or seven of the 200 were added and then merged
  or deleted, and `COMBO` merges fewer cells than Discover. From frame 3600 on `COMBO` adds 25-50 % fewer cells per
  1800 frames, steadily. Which setting is responsible is in the addendum below (the replay setting, which by itself
  does merge more).
- The cells only Discover has are weaker and less reproducible than the matched ones: median peak z 12 against 19-20,
  half the transients, 51-57 % found again by the other seed against 90 %, 30-41 % matching a Minian unit against
  70 %. About a quarter sit within 0.6 D of, or overlap, another Discover cell (duplicate or fragment candidates). The
  cells only `COMBO` has look the same (37-40 % match Minian).
- Where nothing was added in `COMBO`, the place is partly covered by an existing `COMBO` footprint (median 0.46 of the
  covering cell's peak at the missing cell's centre, against 0.94 at matched centres).
- Reading (inference, not measured): with the replay and look-back the existing footprints fill in sooner and leave
  less light in the residual, so fewer weak, overlapping components are proposed. Most of the loss is such
  components, not solid cells; the 20 or so fewer Minian matches are real and sit among them. The files cannot say
  why a given place was not added (there is no per-place rejection log). D was taken as the 10 px default.

### M7. Workshop recording, three slow seeds (`runs/lbsettle/real/m7_agreement.md`)

`SETTLE` = `COMBO` + one settle pass (18,000 frames, 16 frames per request, no early stop), followed by a Refine pass
to measure what a Refine would still do. References: the review's D + R and `COMBO+R` runs for seeds 1 and 2, and
seed 3 run here with the same flags. Seed pairs are 1-2, 1-3, 2-3. Peak memory 1.2-1.3 GB per run.

| library             | cells           | same cells found by two seeds (share of cells; median footprint r), three pairs | Minian units matched; median r             | split-half noise, median |
| ------------------- | --------------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| Discover            | 831 / 838 / 811 | 81 %; 0.951 / 0.950 / 0.952                                                     | 525 / 514 / 519; 0.937 / 0.942 / 0.935     | 17.4-17.6 %              |
| `COMBO` (look-back) | 751 / 760 / 738 | 82 %; 0.953 / 0.958 / 0.954                                                     | 494 / 500 / 497; 0.939 / 0.935 / 0.943     | 14.2-14.5 %              |
| D + R               | 831 / 838 / 811 | 85-87 %; 0.976 / 0.971 / 0.974                                                  | 535 / 531 / 530; 0.953 / 0.958 / 0.957     | 9.9-10.7 %               |
| `COMBO+R`           | 751 / 760 / 738 | 85-87 %; 0.976 / 0.975 / 0.976                                                  | 508 / 518 / 512; 0.950 / 0.949 / 0.949     | 13.1 % (seed 1)          |
| **`SETTLE`**        | 751 / 760 / 738 | **85-86 %; 0.978 / 0.975 / 0.977**                                              | **514 / 515 / 512; 0.949 / 0.950 / 0.949** | **13.1-13.2 %**          |
| `SETTLE` + R        | 751 / 760 / 738 | 87 %; 0.980 / 0.977 / 0.982                                                     | 517 / 518 / 509; 0.948 / 0.949 / 0.948     | -                        |
| D + 2R              | 831 / 838 / 811 | 87 %; 0.981 / 0.979 / 0.980                                                     | 540 / 533 / 532; 0.956 / 0.958 / 0.960     | -                        |

| step, by id (median, three seeds)       | change, app metric   | shape-only change        | change / noise     |
| --------------------------------------- | -------------------- | ------------------------ | ------------------ |
| Refine after `SETTLE`                   | 11.8 / 11.2 / 11.3 % | 0.0065 / 0.0060 / 0.0060 | 0.97 / 0.95 / 0.94 |
| second Refine after Discover (the null) | 10.0 / 9.8 / 10.9 %  | 0.0048 / 0.0043 / 0.0057 | 1.12 / 1.08 / 1.10 |
| Refine after `COMBO`                    | 30.4 / 28.3 / 30.9 % | 0.039 / 0.035 / 0.041    | 2.2 / 2.1 / 2.2    |
| first Refine after Discover             | 25.7 / 23.9 / 24.8 % | 0.029 / 0.026 / 0.028    | 1.5 / 1.4 / 1.4    |

- `SETTLE` and `COMBO+R` of the same seed are the same library: 98 % of cells match with median r 0.997.
- Against the M7 lines: seed-to-seed median r 0.975-0.978 (line 0.970: met) with 85-86 % matched (line 84 %: met);
  Minian median r 0.949-0.950 (line 0.945: met); a Refine after `SETTLE` moves footprints 1.1 x the null on the app's
  metric and 1.25 x on shape (line 1.5 x: met; after `COMBO` it was 3 x and 8 x).
- **The split-half noise line (at most 11 %) is not met: 13.1-13.2 %.** That line was taken from D + R (9.9-10 %).
  `COMBO+R` itself is at 12.8-13.1 %, so the reference fails it too: libraries built with the cluster replay settings have
  a higher split-half noise reading than plain ones at the same seed-to-seed agreement. I did not find out why (the
  two configurations estimate footprints of overlapping cells from different statistics). By the rule as written M7
  is therefore "between its lines", with this row named; whether the row should count is the PI's call.
- `SETTLE` matches about 20 fewer Minian units than D + R (514 against 532), as `COMBO+R` does; see M8.

### Addendum: frames or coverage (workshop recording, arm added after M5; two seeds)

`HALF` = `COMBO` + 9000 settle frames in every second 64-frame block over the whole recording, 16 per request.

| settle                                           | frames | seed 1 vs seed 2: matched share, median r | Minian median r |
| ------------------------------------------------ | ------ | ----------------------------------------- | --------------- |
| first 9000 frames in a row (`CAL`, checkpoint 5) | 9000   | 85.0 %, 0.9693                            | 0.946 / 0.945   |
| every second block (`HALF`)                      | 9000   | 85.5 %, 0.9740                            | 0.949 / 0.951   |
| one pass (`CAL`, checkpoint 10)                  | 18,000 | 86.0 %, 0.9776                            | 0.949 / 0.948   |

Half the frames spread over the recording do better than the same number from its first half, and come close to the
full pass. Coverage matters more than the frame count. The strided arm restarts the preprocessor at every block, so
this is a lower bound for it. It supports a frame cap with even spreading for long recordings; it is one recording of
13 minutes, so for much sparser sampling that remains a hypothesis.

### Addendum to M8: which setting loses the cells (workshop recording, seed 1, Discover only)

| run                                                              | cells | adds | merges | deletes | splits |
| ---------------------------------------------------------------- | ----- | ---- | ------ | ------- | ------ |
| plain Discover                                                   | 831   | 929  | 125    | 9       | 36     |
| `--merge-guard-sep 0.6` only                                     | 829   | 911  | 114    | 7       | 40     |
| `--lookback 2 --lookback-drain 4800` only                        | 800   | 857  | 93     | 8       | 44     |
| `--joint-update all --joint-sign all --merge-guard-sep 0.6` only | 764   | 879  | 159    | 6       | 50     |
| all (`COMBO`)                                                    | 751   | 820  | 104    | 4       | 39     |

- The merge guard costs none (829 against 831).
- The cluster replay setting costs most: by itself 67 cells, with 34 more merges and 50 fewer adds than plain
  Discover. So the replay's merges do remove cells when it runs without look-back.
- Look-back by itself: 31 cells, with fewer adds and fewer merges. One seed; plain Discover alone ranges 811-838 over
  three seeds, so this share is not resolved.
- The effects overlap (67 + 31 > 80). With everything on, merges are below Discover's and the loss is all in adds.
- Not done: a cell-by-cell match of the replay-only library against Discover's.

### M4 and M6. The deciding arm (full tier, 14 sims; `lbsettle-full/ladder.md`)

`SETTLE` = `COMBO` + `--settle-frames 9600 --settle-batch 16`: one pass through the ordinary `observe`, 16 frames per
request, no early stop (the rule was logged only). Fixed after M1-M3 and the calibration, before this run. The
separate 16-frame screen had not been run when it started; the five quick-tier sims inside it serve as M4.

| metric                                 | DR-main | COMBO  | COMBO+R | SETTLE | SETTLE - COMBO+R          | SETTLE - DR-main          |
| -------------------------------------- | ------- | ------ | ------- | ------ | ------------------------- | ------------------------- |
| footprint r, all                       | 0.9879  | 0.9899 | 0.9928  | 0.9928 | +0.0000 [-0.0003, 0.0003] | +0.0048 [0.0043, 0.0054]  |
| footprint r, isolated                  | 0.9922  | 0.9899 | 0.9924  | 0.9922 | -0.0002 [-0.0010, 0.0008] | +0.0000 [-0.0008, 0.0013] |
| footprint r, close-pair                | 0.9843  | 0.9895 | 0.9928  | 0.9927 | -0.0000 [-0.0005, 0.0004] | +0.0085 [0.0075, 0.0093]  |
| footprint r, born second half          | 0.9560  | 0.9575 | 0.9781  | 0.9773 | -0.0008 [-0.0060, 0.0045] | +0.0212 [0.0151, 0.0281]  |
| footprint r, born last 20 %            | 0.9306  | 0.9235 | 0.9646  | 0.9670 | +0.0024 [-0.0101, 0.0117] | +0.0364 [0.0203, 0.0465]  |
| share r < 0.9, all                     | 0.056   | 0.052  | 0.036   | 0.037  | +0.000 [-0.007, 0.008]    | -0.019 [-0.027, -0.012]   |
| crosstalk headline (corr excess < 1 D) | +0.150  | +0.086 | +0.074  | +0.074 | -0.000 [-0.008, 0.009]    | -0.076 [-0.084, -0.066]   |
| bite share < 0.5, 0.75-1 D             | 0.486   | 0.283  | 0.165   | 0.168  | +0.003 [-0.022, 0.028]    | -0.318 [-0.347, -0.288]   |
| bite share, later-born, 0.5-0.75 D     | 0.638   | 0.292  | 0.133   | 0.129  | -0.004 [-0.041, 0.032]    | -0.510 [-0.554, -0.465]   |
| matched cells                          | 400.1   | 400.9  | 401.9   | 401.9  | +0.1 [-0.4, 0.5]          | +1.8 [-0.3, 3.9]          |
| false cells                            | 21.9    | 18.1   | 17.1    | 17.1   | -0.1 [-0.5, 0.4]          | -4.8 [-7.7, -1.9]         |

- **M6: go.** Every row is within the go lines against `COMBO+R` (no footprint group lower by more than 0.0008), and
  no group is worse than `DR-main`.
- **M4: go.** Sixteen frames per request against one (`SETTLE` against `ST-full`, the five common sims): footprint r
  all / isolated / close-pair +0.0000 / +0.0000 / -0.0000, born second half -0.0003 [-0.0049, 0.0053], bite rows
  within noise, and the same visit counts (static_s5 10,789 against 10,772; pairs_s5 27,976 against 27,947). Batching
  the frames costs nothing once the visits are driven by the frames fed and not by lock-step rounds.
- Cost in qc_eval, per sim: settle 170 s (static), 211 s (motion), 116 s (pairs) for 9600 frames; the Refine pass of
  `COMBO+R` took 205 / 248 / 135 s (review's runs, a different session, so approximate). The settle costs what a
  Refine pass costs.
- The rule as a floor: at the last two checkpoints the share of cells above 2 x noise was at most 4 % in 12 of the 14
  sims and all three workshop runs; two motion sims ended at 4.2 % and 5.2 %. With the 4 % line those two would have
  asked for more frames. The line was calibrated on static sims and is tight for motion.

### Decision

By the rule above: **go on sims (M6), and on the workshop recording every line is met except the split-half noise
row (M7), which the reference `COMBO+R` fails as well.** Read strictly that is "go on sims only, real-data gap named:
the noise reading of replay-built libraries". The settle through `observe` gives the same library as look-back +
Refine (workshop: 98 % of cells at median r 0.997), so whatever is decided about `COMBO+R` holds for it.

Not done: `ST-quarter` (the every-fourth-frame arm) and the `SETTLE-stop` arm (dropped for run slots; the checkpoint
libraries of `ST-2x` and `CAL` show what an early stop costs); the rule acting in the deciding arm (logged only); an
"extend when not settled" step (the flags can only stop early); a second real recording (none under `~/Projects`);
the app build.
