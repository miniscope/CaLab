# Look-back settle in the app: is the drain still needed?

19 Nov 2026. Branch `feat/cala-lookback-settle-app`. Context: `2026-11-19-lookback-settle.md` and
`2026-11-19-lookback-settle2.md`. The app gets the end-of-Discover settle (one pass through the ordinary `observe`,
16 frames per request). This file answers one question before the app keeps or drops the drain that runs before it.

## Question

Once the settle follows, does the drain (need-driven look-back after the last frame, up to 4800 steps, then 256
steps of visits on every tile) still add anything?

## Arms (written before the runs)

Quick tier (static s5-s7, pairs s5-s6), one Discover per sim (`--branch-after discover`), binary `qc_eval-lbsa-a`
(this branch: `--settle-frames` no longer requires `--lookback-drain`). Common: the suite's flags with
`--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6`.

| arm      | tail                                                           |
| -------- | -------------------------------------------------------------- |
| `SETTLE` | `--lookback-drain 4800 --settle-frames 9600 --settle-batch 16` |
| `ND+S`   | `--lookback-drain 0 --settle-frames 9600 --settle-batch 16`    |

## Targets (written before the runs)

`ND+S` minus `SETTLE`, paired over the 5 sims, 95 % CI. The drain is dropped from the app if all hold:

- footprint r, all cells: difference >= -0.0005
- footprint r, close pairs: >= -0.0010
- footprint r, born in second half: >= -0.005
- bitten footprints 0.75-1 D (share): <= +0.03
- false cells per sim: <= +2; matched cells per sim: >= -2

If any misses with a CI that excludes 0, the drain stays (and is made faster in the app). If one misses with a CI that
includes 0, it is reported as "between the lines" and the app keeps the drain unless the cost is large.

## Results

Run tree: `~/Projects/cala-data/demix-suite/lbsa-drain-q` (`report.md`; 21 min at 3 branched groups at a time).
`ND+S` minus `SETTLE`, 5 sims:

| measure                                        | `SETTLE`     | `ND+S`       | difference [95 % CI]      | line          | verdict |
| ---------------------------------------------- | ------------ | ------------ | ------------------------- | ------------- | ------- |
| footprint r, all cells                         | 0.9934       | 0.9934       | -0.0001 [-0.0006, 0.0004] | >= -0.0005    | pass    |
| footprint r, close pairs                       | 0.9937       | 0.9936       | -0.0001 [-0.0009, 0.0007] | >= -0.0010    | pass    |
| footprint r, born in second half               | 0.9816       | 0.9802       | -0.0013 [-0.0076, 0.0052] | >= -0.005     | pass    |
| footprint r, born in last 20 % (supplementary) | 0.9742       | 0.9729       | -0.0013 [-0.0197, 0.0159] | -             | -       |
| bitten footprints 0.75-1 D (share)             | 0.148        | 0.142        | -0.006 [-0.050, 0.039]    | <= +0.03      | pass    |
| matched / false cells per sim                  | 349.4 / 10.4 | 349.4 / 10.4 | 0.0 / 0.0                 | >= -2 / <= +2 | pass    |

All 67 suite metrics are within noise except slow-loop work per frame (lower without the drain). The drain cost 17-43
s per sim in qc_eval (3,500-5,100 look-back frames) and 128 s on the workshop recording (settle study).

**Verdict: the drain adds nothing once the settle follows. The app drops it**: after Discover's last frame it goes
straight to the settle.

## App measurement (headed Chrome, Metal; 5 s samples)

`apps/cala/scripts/memory-measure.mjs --single [--lookback --extract] --headed --every 5`; logs in
`~/Projects/cala-data/runs/lbsa/browser`. Off = Discover then Refine; on = look-back Discover with its settle.

| recording (frames)       | run | Discover frames | Refine / settle       | total | cells | peak tab memory |
| ------------------------ | --- | --------------- | --------------------- | ----- | ----- | --------------- |
| workshop (23,711)        | off | 110 s (173 fps) | Refine 159 s          | 269 s | 831   | 3.0 GB          |
|                          | on  | 119 s (167 fps) | settle 191 s (94 fps) | 309 s | 756   | 3.3 GB          |
| Samara 10_43_21 (17,879) | off | 56 s (332 fps)  | Refine 82 s           | 137 s | 332   | 2.8 GB          |
|                          | on  | 56 s (334 fps)  | settle 87 s (205 fps) | 143 s | 327   | 3.2 GB          |
| Samara 14_57_02 (17,875) | off | 56 s (328 fps)  | Refine 76 s           | 132 s | 298   | 2.2 GB          |
|                          | on  | 56 s (336 fps)  | settle 92 s (194 fps) | 149 s | 276   | 2.7 GB          |

The workshop settle fed 17,984 frames spread over the recording (the 18,000 cap); Extract after it took 146 s. Load
average 3-7, other qc_eval runs 0-1 (the workshop look-back run overlapped the end of the quick-tier suite).
