# The compress pool in Chrome: pace, lag and each stage's source (24 Nov 2026)

Slice 5's measurement (plan `docs/superpowers/plans/2026-11-23-cala-parallel-compress-slice5.md`, Task 8): Discover,
the compressor's lag and the source each stage read, with a compress pool of 1 to 4 workers.

## Short answer

1. **The pool works, and a stream gains from it.** After a 3-min 600 px stream, the wait for the last window falls from
   16.0 s (one worker) to 6.0 s (3 workers after the stream), and the stream's end to Extract done from 76 s to
   65 s. The live stream itself is unchanged (one worker, no window waiting, no frame dropped).
2. **On this 10-core Mac the pool does not make a recording's factors keep up with Discover.** The Final settle read the
   file in every run: the compressor was at least 26 windows behind at Discover's end, against the 3-4 windows the
   rule waits for.
   - `motion_s5` (600 px): whatever the pool, only 600-1,800 of 9,600 frames were compressed during Discover.
     Discover uses the cores. After Discover the pool compresses at 27 frames/s (1 worker), 48 (3) and 52 (4).
   - `wl24_20251201` (200 px): the pool compresses 251 frames/s during Discover with 1 worker and 645 with 4. After
     Discover it does 281 and 916.
3. **More workers during Discover slow it.** On `wl24_20251201`, Discover took 34 s without compression and 35, 36, 38
   and 40 s with pools of 1, 2, 3 and 4 during Discover. That is +18 % at 4, against the proposed 10 % line, so at most
   2 workers during Discover on 10 cores. Without compression the slow loop dropped no frame; with it, 400-900.
   `motion_s5`'s Discover stayed within its spread (50-54 s).
4. **Extract read the factors only on `wl24_20251201` with 3 or 4 workers, and was then slower than the file.**
   - Extract on the factors took 49-52 s, against 31 s for the file's replay.
   - Discover's end to Extract done: 74-78 s, against 53 s without compression.
5. **Compressing after Discover slows the file's settle and Extract.** On `wl24_20251201` with 1 worker during
   Discover and 3 after (this slice's default on 10 cores): settle 30 s against 22 s, Extract on the file 43 s against
   31 s. A `?factors=file` recording whose settle and Extract read the file still compresses its backlog in the
   background, and nothing reads those factors.
6. **The cap on waiting windows is 5 GB in practice.**
   - Chrome reported a quota of 10 GiB for the origin (`navigator.storage.estimate()`), with 322 GB free on the
     disk that held the profile. So `quota - usage` does not track the free disk, and the cap was 5 GiB.
   - The 1 h V4 run of `perf/cala-factors-v4-speed` wrote 33 GB to OPFS with the same kind of profile, so Chrome
     does not refuse writes at that quota.
   - A raw window on the offset grids takes 1.34 MB per frame at 600 px and about 0.16 MB at 200 px. That is twice
     the plan's figure (0.72 MB, taken from plain tiles).
   - With the 5 GB cap, every `motion_s5` run gave its factors up during Discover (inferred: about 4,000 frames behind, 5 GB at 1.34 MB per frame). The
     settle and Extract read the file with that reason, at the same times as without the switch (137-139 s from
     Discover's end to Extract done, against 139 s).

## What was run

- App at `feat/cala-parallel-compress` (slice 5, uncommitted at run time), production build (`npm run build:e2e`)
  served locally.
- Google Chrome (`--channel chrome`), headless, one tab, a fresh profile on the external SSD per run. Apple M1 Max,
  10 logical cores; 4 visit workers, no settle pool. Load average at the starts 5.4-14.8 (other projects' jobs).
- `apps/cala/scripts/live-measure.mjs --mode file`, one run per arm, and `--mode live --fps 20 --frames 3600` for the
  streams.
- Recordings (read-only): the minisim `motion_s5` (600x600, 9,600 frames) and `wl24_20251201` (200x200, the
  destriped grey input, 40,234 frames).
- Arms: no switch (the baseline), `?factors=file&debug&cpool=D,E` with D,E 1,1 / 1,3 / 2,3 / 3,3 / 4,4, and 2,3
  with `?visits=3`. `motion_s5` again with the cap lifted (`?debug&cbacklog=40`) at 1,1 / 1,3 / 3,3 / 4,4, since
  the 5 GB cap stopped every first run.
- Outputs (`<run>_metrics.json` with a one-second timeline) on the evaluation SSD under
  `runs/parallel-compress-20261124/`.

## Results

`behind`: frames Discover read and the compressor had not compressed at Discover's end. `pace`: frames compressed
per second of wall time, during Discover and after it. Settle and Extract times from the driver's one-second timeline.

### `wl24_20251201` (200 px), cap 5 GB

| pool (D,E)        | Discover (s) | cells | behind | raw peak (GB) | pace during / after | settle | settle (s) | Extract | Extract (s) | end to Extract done (s) |
| ----------------- | -----------: | ----: | -----: | ------------: | ------------------- | ------ | ---------: | ------- | ----------: | ----------------------: |
| no switch         |           34 |    77 |      - |             - | -                   | (file) |       22.1 | (file)  |        31.1 |                    53.2 |
| 1,1               |           35 |    69 | 32,434 |          4.83 | 251 / 281           | file   |       23.1 | file    |        31.1 |                    54.2 |
| 1,3               |           36 |    90 | 32,434 |          4.83 | 160 / 613           | file   |       30.1 | file    |        43.1 |                    73.2 |
| 2,3               |           36 |    92 | 26,434 |          4.02 | 365 / 824           | file   |       30.1 | file    |        40.1 |                    70.2 |
| 3,3               |           38 |    84 | 20,434 |          3.04 | 584 / 829           | file   |       26.1 | factors |        52.1 |                    78.2 |
| 4,4               |           40 |    75 | 15,634 |          2.41 | 645 / 916           | file   |       25.1 | factors |        49.1 |                    74.2 |
| 2,3, 3 visit wkrs |           36 |    71 | 27,034 |          4.11 | 293 / 709           | file   |       24.1 | file    |        32.1 |                    56.2 |

Cells vary 69-92 between runs of the same Discover settings; one run per arm, so the spread is not known.

### `motion_s5` (600 px), cap lifted to 40 GB

| pool (D,E) | Discover (s) | cells | behind | raw peak (GB) | pace after | settle | settle (s) | Extract | Extract (s) | end to Extract done (s) |
| ---------- | -----------: | ----: | -----: | ------------: | ---------: | ------ | ---------: | ------- | ----------: | ----------------------: |
| no switch  |           50 |   502 |      - |             - |          - | (file) |       89.3 | (file)  |        50.1 |                   139.4 |
| 1,1        |           54 |   522 |  9,000 |         12.07 |         27 | file   |       94.3 | file    |        52.2 |                   146.5 |
| 1,3        |           51 |   500 |  9,000 |         12.07 |         48 | file   |       94.3 | file    |        50.2 |                   144.5 |
| 3,3        |           53 |   504 |  8,400 |         11.27 |         50 | file   |       91.3 | file    |        50.2 |                   141.5 |
| 4,4        |           54 |   503 |  7,800 |         11.21 |         52 | file   |       92.3 | file    |        49.2 |                   141.5 |

With the 5 GB cap (the default), every arm, including 3 visit workers, gave its factors up during Discover. Discover
took 49-53 s, settle 85-90 s and Extract 49 s, all on the file.

### A 600 px stream at 20 fps, 3 min (`motion_s5`, default factor run)

| pool after the stream | windows waiting while streaming | slow-loop drops | wait for the last window (s) | settle (s) | Extract (s) | end to Extract done (s) |
| --------------------: | ------------------------------: | --------------: | ---------------------------: | ---------: | ----------: | ----------------------: |
|                     1 |                               0 |               0 |                         16.0 |       37.1 |        23.1 |                    76.3 |
|                     3 |                               0 |               0 |                          6.0 |       37.1 |        22.1 |                    65.2 |

## What follows

- **Streams:** keep the pool's `after` width. Spreading Extract on factors over the pool is the next gain. On the 1 h
  V4 stream (`2026-11-24-factors-v4-1h-speed.md` on `perf/cala-factors-v4-speed`), Extract on factors took 37 min in one worker (32 frames/s), against
  76 frames/s for a file's replay.
- **Recordings with `?factors=file`:**
  - On 10 cores the pool alone does not get the settle onto the factors. Extract on factors is not faster than the
    file's replay.
  - Once the settle and Extract have both chosen the file, the backlog is compressed for nothing and slows them.
    Stopping compression at that point is a small follow-up.
  - Files by default would need the settle to follow the compressor (plan, "What would make recordings default to
    factors"), and a cheaper compression at 600 px.
- **The cap:** `quota - usage` gives 5 GB on this Chrome whatever the disk. Either keep it as a fixed 5 GB or base it on
  something else; Chrome does not expose the free disk.
- **During Discover:** `discover` 1 on 10 cores stays. At 200 px, 2 workers kept Discover within 6 % (36 against
  34 s). At 600 px no width kept up.

## Not measured

- Run-to-run spread (one run per arm).
- The factor files' bytes across widths in Chrome. The unit test pins them byte-identical with fake helpers, and the
  e2e shows a pool of three settles and extracts on its factors.
- A machine with more than 10 cores.
