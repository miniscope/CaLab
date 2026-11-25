# Final settle: visits per settle frame (PR A) and the settle pool at Max on factors (PR B)

25 Nov 2026. Branches `perf/settle-visit-rate` (A, on #518's `perf/factors-settle-attribution`) and
`perf/settle-pool-at-max` (B, on A). Raw runs, logs and scripts: `~/Projects/cala-data/runs/settle-pool/`
(`chrome/`, `scripts/summ.py` on top of `tools/cala-eval/stage0/settle_ports.py`).

## Setup

- Headed Chrome 156 on the real GPU (Metal), 18 logical cores (6P + 12E), 4 visit workers, settle pool S = 1.
- Plain WASM, md5 `b575a1d9` in every arm: no Rust changes, so the JS tree is the only difference.
- Trees:
  - main = #518's head `a6aa1f5b` without flags (#518 adds instrumentation only).
  - A = `37d950d5`.
  - A+B = `e8c64c3f`.
- One Chrome job at a time, nothing built, edited or linted during a run, port 5305 / CDP 9355.
- Background load: the Jamf agent at 0.5–0.7 of a core. B3 waited for an XProtect scan to end first.
- Workshop recording (read-only, 600 × 600 px, 23,711 frames): Max, `--single --lookback`, `?debug`, full run.
- B1 ran A+B before the fix below and is kept as "A+B, first version". Every other arm with A ran on the final commits.

## Workshop recording at Max

| run | tree               | settle s | settle fps | look-back workers | settle visits / frame | slow worker busy | look-back busy | peak RSS GiB, to final / all | cells |
| --- | ------------------ | -------: | ---------: | ----------------: | --------------------: | ---------------: | -------------: | ---------------------------: | ----: |
| M1  | main               |      198 |       90.8 |                 1 |        0.666 (timing) |              80% |            80% |                  4.15 / 5.65 |   786 |
| A1  | A                  |      192 |       93.5 |                 1 |                 0.400 |              80% |            79% |                  3.90 / 5.78 |   771 |
| B1  | A+B, first version |      203 |       88.8 |                 2 |                 0.400 |              75% |      41% / 41% |                  4.28 / 6.05 |   796 |
| B2  | A+B                |      151 |      119.2 |                 2 |                 0.400 |              99% |      53% / 53% |                  4.40 / 5.98 |   789 |
| B3  | A+B                |      145 |      123.8 |                 2 |                 0.400 |              98% |      56% / 56% |                  4.46 / 5.99 |   769 |

How to read the table:

- Discover ran at 204–208 fps in every arm. Every run fed 17,984 of 17,984 settle frames, from the factors.
- Settle visits per frame:
  - with A, the settle's own count (`visits.handed / fed`), exactly `floor(0.4 × 17,984)` = 7,193 in every run;
  - on main, Stage 1's job-count difference.
- "All" in peak RSS adds Extract, which starts right after the final library. More below.
- Cells are decided in Discover. The settle freezes the cell set, so 769–796 is Discover's run-to-run spread (#518 saw 764–791).

Slow worker per settle frame (ms):

|                            |          M1 |          A1 |          B2 |          B3 |
| -------------------------- | ----------: | ----------: | ----------: | ----------: |
| visit hand-out + apply     |        0.95 |        0.62 |        0.59 |        0.57 |
| housekeep (library builds) |        2.00 |        2.17 |        1.86 |        1.83 |
| end (`observe` 5.2–5.5)    |        5.79 |        5.64 |        5.71 |        5.38 |
| busy / idle                | 8.85 / 2.17 | 8.53 / 2.13 | 8.29 / 0.07 | 7.88 / 0.12 |

- **A alone.** The visits fall from 0.67 to 0.40 per frame, and the slow worker spends 0.3 ms less per frame on them. The settle stays one-look-back-worker bound at 93.5 fps (+3%).
- **A+B.** 119–124 fps against 91 on main (+31–36%), at a fixed 0.40 visits per frame. The slow worker is 98–99% busy and is now the limit. That is the 108–118 fps #518 estimated for equal work, slightly better because 0.40 visits per frame cost less than 0.65.

## The first A+B version was bound by visit latency (B1)

- B1 held its look-back requests for 83 s of 203 while visits were owed. It ran at 88.8 fps, no faster than main.
- The four visit workers were only 9–38% busy.
- A visit result waited behind a whole 16-frame settle answer in the slow worker's queue, about 90 ms to observe. So each visit went out about 120 ms after the last.
- So the slow worker could hand out only about 4 visits per answer, about 0.25 per frame, at 2 look-back workers' pace. X1 in #518 got 0.21 for the same reason.
- The fix, in A:
  - Settle answers are observed in pieces of 4 frames. With a visit out, the slow worker gives way between pieces through the unclamped `MessageChannel` defer, so visit results are applied within an answer.
  - An answer that arrives meanwhile waits in arrival order, and its worker's next request goes out when it begins.
  - The wait for owed visits moved from the requests to the pieces.
- B2/B3: no waits, 0 visits unpaid, 0–2 paid at the end.

## Quality: sims paced at 30 fps, main vs A+B

`v3_static_s6`, `v3_motion_s5` (9,600 frames), `--pacefps 30`, scored with `stage1-chrome/scripts/score_app.py`
(strict rule, r ≥ 0.7).

| sim       | tree | cells | matched | false | recall | precision | settle s | settle visits / frame | slow busy |
| --------- | ---- | ----: | ------: | ----: | -----: | --------: | -------: | --------------------: | --------: |
| static_s6 | main |   751 |     744 |     7 | 0.9288 |    0.9907 |       51 |        0.189 (timing) |       90% |
| static_s6 | A+B  |   752 |     741 |    11 | 0.9251 |    0.9854 |       68 |                 0.400 |       74% |
| motion_s5 | main |   779 |     710 |    69 | 0.8712 |    0.9114 |       47 |        0.181 (timing) |       99% |
| motion_s5 | A+B  |   790 |     713 |    77 | 0.8748 |    0.9025 |       56 |                 0.403 |       99% |

- **Recall** is within ±0.004 (−0.0037 static, +0.0037 motion), inside the ±0.01 expected.
- **False cells** come from Discover, as cells do, so they are not a settle effect.
- **This tests A's visit rate, not B's new path.** Paced runs on this machine already start the pool for Background settle, so main's paced settle was pooled too (2 workers in both arms).
- **A paced, pooled settle on main visited only 0.18–0.19 per frame**, the timing dependence A removes.
- **With A it makes 0.40 visits per frame, so it takes longer**: +17 s on static, +9 s on motion.
- **On static the visit workers are the limit.** Visits cost 55 ms there against 22–24 ms on motion and the workshop recording. The four workers were 78% busy, and observation waited 18.6 s of 68 s for them.
  - This is the designed behaviour: the count is fixed and the time varies.
  - The rate (0.4) is where to trade.

## What is recorded

- **Run record, `final_settle`**:
  - `source` and `lookback_workers`;
  - `visit_rate`;
  - `visits`: `handed_out`, `per_frame`, `paid_at_end`, `unpaid`, `owed_max`, `holds`, `held_s`, `starved`, `final_round`.
- **Run record, `settings.lookback_pool`**: `started_for`, either `background-settle` or `final-settle`. `machine.hardware_concurrency` was already recorded, and the pool size S depends on it alone.
- **`?debug&settlevisits=R|off`** sets the rate for measurement. `off` restores visits whenever a worker is free, as before.
- **The Final-settle line** shows "0.40 visits/frame".

## Memory (report only)

- With B, the pool worker stays alive until the run resets, so it is still there during Extract.
- Peak RSS including Extract:
  - B: 5.98–6.05 GiB (6.4–6.5 GB);
  - M1 and A1: 5.65–5.78 GiB.
- Up to the final library, B adds 0.3–0.5 GiB.
- Terminating the pool workers at the final library would take that back before Extract. Not done here.
