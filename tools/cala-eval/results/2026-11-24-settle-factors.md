# Final settle on Discover's factors (23 Nov 2026)

Plan and lines, committed before any scored run: [2026-11-24-settle-factors-plan.md](2026-11-24-settle-factors-plan.md)
(commits `0500ccd0`, amended `68777779` before the scored runs and `046d8f54` during them, before any score was
read). Anything decided after the first scores is marked **(post hoc)**.

- Binary: `qc_eval` built at `0500ccd0`, branch `feat/cala-factors-settle`.
- Driver: `settle_factors.sh`. Scores: `settle_factors_score.py`.
- Machine: Apple M1 Max, two runs at a time. Load average at each start was 4.3-6.0, with other projects' jobs
  running; the times below are under that load.

## Short answer

1. **A stream gets much better footprints from a Final settle on its own factors** (question 2). `STR-F` passes every
   line against `STR-0`, a stream on main today:
   - Sim: light left out falls from 0.184 to 0.110 (median, two seeds), core shape error from 0.032 to 0.009. False
     cells fall from 47 to 42.5, and matched true cells rise from 514.5 to 519.
   - Real (`wl24`): the held-out score on frames no run saw rises from about 0 (share -0.0006 and 0.0003) to 0.0030
     and 0.0061. The close-pair trace correlation excess falls from +0.071 to +0.007.
   - On the sim it lands close to a recording's path (`SET-R`): light left out 0.110 against 0.102, core error 0.009
     against 0.007.
2. **For a recording, the settle on factors equals the settle on re-read frames on the sim, and is mixed on the real
   recording** (question 1).
   - Sim: every measure is within `SET-R`'s seed spread, except light left out on seed 1 (+0.0025 against a spread of
     0.0021; +0.0015 on the two-seed mean). Matched true cells 517 against 516.5. **(post hoc)** Against the raw
     settle of the same Discover the cosine is 0.9994-0.9995.
   - Real, against the lines:
     - Held-out score and close-pair excess pass on the two-seed mean. They split by seed: seed 2's held-out share is
       0.0040 against 0.0064.
     - Repeatability fails: the two seeds agree at cosine 0.895 (62 matched cells) against 0.918 (84) for the raw
       settle.
   - So by the pre-set lines, `SET-F` does not pass on the real recording.
3. **Speed: the settle on factors is never slower.**
   - Sim (600 px): 250 s against 310 s for 9,600 frames, 20 % faster.
   - Real (200 px): 196-207 s against 202-209 s, the same.
   - The compressor needs 17.8-18.2 ms per frame at 600 px on the offset grids (one thread) and 2.0-2.1 ms at 200 px,
     against a 50 ms frame interval at 20 fps.

What follows for the design (spec decision 6, "What would change the plan"): streams go ahead with the settle and
Extract on factors (slice 2). A recording keeps the settle on re-read frames by default; slice 3 stays behind its
switch.

## What was run

- `motion_s5`: minisim, 600x600 px, 9,600 frames, motion, ground truth.
- `wl24_20251201`: Miniscope Zero, 200x200 px, first 12,000 frames. The fixed-library runs solved frames 0-18,000;
  frames after 12,000 were seen by no run.
- Arms as in the plan, seeds 1 and 2. 12 runs and 8 fixed-library runs, all finished. `motion_s6` was dropped at the
  owner's request (plan amendment).
- Checks before the scored runs (3,000 frames of `motion_s5`) passed:
  - the factor settle read 0 raw frames;
  - Discover's library at the settle's start is byte-identical between `SET-R` and `SET-F`;
  - the same holds between a stream run with a settle and one without.

## Sims (`motion_s5`, medians over matched cells)

| arm     | seed | cells | matched | unmatched | missed | excess | excess_nb | err_core |
| ------- | ---: | ----: | ------: | --------: | -----: | -----: | --------: | -------: |
| `SET-R` |    1 |   548 |     517 |        31 | 0.1030 | 0.0281 |    0.0042 |  0.00758 |
| `SET-R` |    2 |   554 |     516 |        38 | 0.1009 | 0.0265 |    0.0040 |  0.00687 |
| `SET-F` |    1 |   548 |     517 |        31 | 0.1055 | 0.0272 |    0.0040 |  0.00777 |
| `SET-F` |    2 |   554 |     517 |        37 | 0.1014 | 0.0263 |    0.0038 |  0.00742 |
| `STR-0` |    1 |   559 |     510 |        49 | 0.1853 | 0.0245 |    0.0014 |  0.03389 |
| `STR-0` |    2 |   564 |     519 |        45 | 0.1831 | 0.0240 |    0.0016 |  0.03070 |
| `STR-F` |    1 |   559 |     517 |        42 | 0.1067 | 0.0258 |    0.0041 |  0.00874 |
| `STR-F` |    2 |   564 |     521 |        43 | 0.1134 | 0.0238 |    0.0038 |  0.00941 |

- `missed`: light of the true footprint left out.
- `excess`: light in excess; `excess_nb`: the part of it on a neighbour's core.
- `err_core`: squared error in the true core over its energy.
- `unmatched`: final cells with no true unit (false cells).

`STR-F` has slightly more `excess_nb` than `STR-0` (0.004 against 0.0015). That is the fill under neighbours that the
cluster replay adds, as in settle-size.

## Real (`wl24_20251201`), held-out frames after 12,000

| arm     | seed | cells | held-out score | share of signal | close-pair excess | repeatability (cos, matched) |
| ------- | ---: | ----: | -------------: | --------------: | ----------------: | ---------------------------: |
| `SET-R` |    1 |   109 |            379 |          0.0052 |            +0.009 |                  0.9181 (84) |
| `SET-R` |    2 |   122 |            466 |          0.0064 |            +0.012 |                              |
| `SET-F` |    1 |   109 |            424 |          0.0058 |            +0.016 |                  0.8945 (62) |
| `SET-F` |    2 |   122 |            293 |          0.0040 |            -0.007 |                              |
| `STR-0` |    1 |   127 |            -40 |         -0.0006 |            +0.072 |                  0.9052 (89) |
| `STR-0` |    2 |   134 |             22 |          0.0003 |            +0.070 |                              |
| `STR-F` |    1 |   127 |            214 |          0.0030 |            +0.015 |                  0.8987 (64) |
| `STR-F` |    2 |   134 |            442 |          0.0061 |            -0.001 |                              |

- Held-out score: `settle_size.proxies`, light explained on held-out frames minus the placebo penalty.
- Close-pair excess: trace correlation of pairs closer than 1 D minus pairs at 1.5-3 D, with D = 10 px.
- Repeatability: median cosine of the cells the two seeds' libraries share (one to one, cosine at least 0.7). The two
  seeds have different Discovers (109 against 122 cells), so fewer than half the cells may match at all.

### Where the real-data difference comes from (post hoc)

Same Discover (seed), median pixels of the footprint:

| seed | Discover (`SET-R` at the settle start) | `SET-R` after the settle | `SET-F` after the settle |
| ---: | -------------------------------------- | ------------------------ | ------------------------ |
|    1 | 243 with light, 202 at >= 10 % of peak | 592, 325                 | 463, 325                 |
|    2 | 255, 201                               | 622, 352                 | 414, 334                 |

- On this recording both settles change the footprints a lot. The raw settle moves them to cosine 0.934 and 0.917 of
  Discover's library.
- The factor settle ends at cosine 0.925 and 0.916 of the raw settle. That is as far from it as the raw settle is
  from Discover.
- The cores grow the same. The factor settle adds less faint skirt (pixels with light below 10 % of peak), as the rank
  cut drops the noise in which that skirt sits (inferred).
- On the sim the same comparison gives cosine 0.9994-0.9995 between the two settles.
- Whether the smaller skirt is better or worse cannot be told on the real recording (no truth). The held-out score
  does not decide it at two seeds.

## Speed (from `run.log`)

| recording   | arm     | settle frames/s | settle s     | compressor ms per frame |
| ----------- | ------- | --------------: | ------------ | ----------------------: |
| `motion_s5` | `SET-R` |              31 | 309.8, 310.1 |                       - |
| `motion_s5` | `SET-F` |           38-39 | 248.7, 252.6 |            18.17, 18.21 |
| `motion_s5` | `STR-F` |              40 | 242.9, 241.3 |            17.85, 17.76 |
| `wl24`      | `SET-R` |           57-59 | 202.3, 209.2 |                       - |
| `wl24`      | `SET-F` |           58-61 | 196.4, 206.7 |              2.04, 2.02 |
| `wl24`      | `STR-F` |           54-55 | 220.1, 222.2 |              2.07, 2.07 |

These are `qc_eval` times on one core per stage: they show the ratio, not the app's speed. In the app, worker 0 does
the re-read and preprocessing and the slow worker does `observe`; the app's speed check is slice 2's task 11.

## Limits

- One sim and one real recording, two seeds: the spreads are coarse.
- The real recording is 200 px. At 600 px the factor settle ran 20 % faster here; the app's split across workers may
  change that.
- The sim's look-back + settle path is `qc_eval`'s model of the app (no drain), not the app.

## Files

- Run tree on the evaluation SSD: `runs/settle-factors-20261123/` (`runs.tsv`, one folder per run, `checks2/`); the
  binary and its commit in `bin/`.
- Scores: `settle_factors_score.py RUN_ROOT SIM_ROOT`.
