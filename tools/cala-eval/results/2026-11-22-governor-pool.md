# Settle governor and look-back pool: first Chrome runs (work-slider PR 5)

Four runs, one each (n = 1): Samara `10_43_21` (17,879 frames), paced at 60 and 120 fps, with the governor on
(`?debug&governor`, cap 2) and with no settle pool (S = 0, so need-driven look-back and the settle take turns on one
worker) or one pool worker (S = 1).

- Setup: `apps/cala/scripts/memory-measure.mjs --single --lookback --csettle --headed --every 5 --governor
--pacefps {60,120} --lbpool {0,1}`, dev server on port 5197, headed Chrome with the Metal GPU, 4 visit workers.
- Runs went one at a time, with no other Chrome run going. The data was opened read-only.
- Raw output: `~/Projects/cala-data/runs/governor/`.

The rows read as follows:

- **Dose** is the settle's re-read frames per live frame; requested and delivered were the same in every run.
- **Batch wait** is the median, over the run, of each 1 s reading's mean, and of its longest wait, followed by the
  run's maximum.
- **Limit** is the share of 1 s readings that showed each limiting factor.
- **Memory** is the renderer's peak footprint (macOS `footprint`).

|                                                | 60 fps, S = 0                 | 60 fps, S = 1              | 120 fps, S = 0                     | 120 fps, S = 1                     |
| ---------------------------------------------- | ----------------------------- | -------------------------- | ---------------------------------- | ---------------------------------- |
| achieved fps (median, min)                     | 60.0, 59.5                    | 60.1, 59.3                 | 119.9, 118.6                       | 119.7, 118.0                       |
| forward-pool drops                             | 0                             | 0                          | 0                                  | 0                                  |
| settle dose                                    | 1.21                          | **1.86**                   | 0.31                               | 0.33                               |
| governor rate, median (frames/s)               | 77                            | 120 (the cap)              | 27                                 | 22                                 |
| need-driven frames asked / pushed              | 22,553 / 15,116               | 35,415 / 23,717            | 17,400 / 11,660                    | 23,624 / 15,805                    |
| batch wait: mean / longest in 1 s / max (ms)   | 2.4 / 12.0 / 73               | 5.7 / 23.6 / 85            | 2.4 / 21.5 / 62                    | 3.2 / 25.6 / 75                    |
| halvings (all from a batch wait)               | 1                             | 6                          | 41                                 | 51                                 |
| limit                                          | slow worker 95 % (see note 1) | cap 80 %, slow worker 13 % | slow worker 64 %, backing off 29 % | slow worker 50 %, backing off 36 % |
| look-back busy per worker (median)             | 0.89                          | 0.64 / 0.72                | 0.85                               | 0.82 / 0.11                        |
| slow worker idle (median)                      | 0.45                          | 0.35                       | 0.34                               | 0.32                               |
| renderer peak footprint (MB)                   | 2,761                         | 3,140                      | 2,661                              | 2,930                              |
| look-back workers, wasm + buffers at peak (MB) | 390                           | 338 + 406                  | 337                                | 284 + 376                          |
| final settle: cells moving > 2x noise          | 3 / 373                       | 3 / 383                    | 2 / 353                            | 2 / 361                            |

Readings (one run each, so differences of a few percent are noise):

1. **60 fps: one pool worker takes the dose from 1.21 to 1.86, near the cap of 2.** The governor sits at the cap
   80 % of the time, with no drops and no fps shortfall. Need-driven look-back also gets about 57 % more frames
   (35,415 against 22,553), because it no longer takes turns.
   - For comparison, #456's one worker with the per-live-frame dose gave 1.29.
   - Note 1: the S = 0 run's "slow worker" label is wrong. With turn-taking, the governor counted only the settle
     answers' busy time, so a full worker (0.89 busy) read as idle. This PR fixes that (with a test): worker 0's
     need-driven time now counts when there is no pool. The run was not repeated after the fix.
2. **120 fps: the guard trips about once every 3 s on batch waits, and the dose collapses to 0.31-0.33.** That is
   about half of #456's 0.63 with one worker and no guard.
   - Half a batch period at 120 fps is 33 ms (8-frame batches). The longest wait in a 1 s window is 21-26 ms at the
     median, with peaks of 62-75 ms.
   - Yet no batch was dropped, and achieved fps held at 118-120.
   - The waits rise with settle activity, but stay under 1.3 batch periods in these four runs (at 120 fps the 62-75 ms
     peaks are 0.9-1.1 periods of 67 ms; at 60 fps the 73-85 ms peaks are 0.5-0.6 periods of 133 ms). With the guard
     fixed (see the last section) the settle runs near its cap, and the Samara peak wait reaches 1.96 periods.
   - So at 120 fps the guard reacts to waits that cost nothing yet. The extra pool worker sat 89 % idle.
   - Per the brief, this is reported, not tuned. The candidates are a threshold tied to the forward-pool depth (four
     buffers), acting only on a drop, or `csettle=yield` (the design's remedy for waiting batches).
3. **Memory: an extra look-back worker costs about 270-380 MB of renderer footprint.** That is above the design's
   estimate of 0.15-0.3 GB. Each look-back worker holds 280-410 MB of wasm and buffers. Peaks stayed at 2.7-3.1 GB,
   inside the 6 GB budget.
4. The final settle ended with 2-3 cells moving in every run. These runs were not designed to compare quality.

## After the guard fix (PR #463): 120 fps, S = 1, one run each

The guard now halves on a wait over `waitShare x (poolSize - 1)` = 1.5 batch periods (100 ms at 120 fps, four
buffers). Same setup as above (`--governor --pacefps 120 --lbpool 1`, headed Chrome, port 5197, one at a time).
Raw output: `~/Projects/cala-data/runs/governor/{sa,ws}-p120-pool1-gov-fix*`.

|                                            | Samara `10_43_21`, before (#462)   | Samara `10_43_21`, after                       | workshop, after                    |
| ------------------------------------------ | ---------------------------------- | ---------------------------------------------- | ---------------------------------- |
| settle dose (per live frame)               | 0.33                               | **1.00**                                       | 0.11                               |
| achieved fps (median, min)                 | 119.7, 118.0                       | 120.1, 119.1                                   | 119.7, 118.2                       |
| forward-pool drops                         | 0                                  | 0                                              | 240 / 23,663                       |
| batch wait: mean / longest in 1 s (median) | 1.9 / 11.8 ms                      | 5.7 / 24.8 ms                                  | 7.4 / 38.9 ms                      |
| longest wait (max)                         | 74.5 ms (1.1 periods)              | 130.8 ms (2.0 periods)                         | 258.5 ms (3.9)                     |
| halvings                                   | 51                                 | 5                                              | 67                                 |
| limit                                      | backing off 59 %, slow worker 31 % | ramping 48 %, look-back 28 %, slow worker 22 % | slow worker 76 %, backing off 18 % |
| look-back busy per worker (median)         | 0.84 / 0.09                        | 0.82 / 0.58                                    | 0.71 / 0                           |
| slow worker idle (median)                  | 0.29                               | 0.12                                           | 0.04                               |
| renderer peak footprint (MB)               | 2,930                              | 2,981 (log) / 2,442 end                        | 3,786 (log) / 3,147 end            |
| final settle: cells moving > 2x noise      | 2 / 361                            | 2 / 353                                        | 10 / 752                           |

- **Samara:** the dose rises from 0.33 to 1.00 with no drop and no fps shortfall, and halvings fall from 51 to 5.
- **Workshop (752 cells):** the slow worker is nearly full from the live frames alone (idle 0.04, live share 0.34), so
  the governor sits at 0 for 69 % of the run and the dose is 0.11. 240 batches (1 %) were dropped. This is the
  guard doing its job on a load the slow worker cannot carry at 120 fps; it is not a regression to compare against
  the old guard (there is no earlier workshop run at 120 fps with the governor).
