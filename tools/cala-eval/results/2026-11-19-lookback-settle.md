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
