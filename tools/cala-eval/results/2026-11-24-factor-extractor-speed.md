# Extract on the factor extractor against rebuilt frames (24 Nov 2026)

Slice 6's speed check (plan `docs/superpowers/plans/2026-11-24-cala-factor-extractor-slice6.md`, Task 10): Extract on
factors solved from the factors without rebuilding frames (`FactorExtractor`, ported from #437), on 1 and 6 workers,
against Extract on rebuilt frames as before (`?debug&fextract=0`).

## Short answer

1. **On a 3-min 600 px stream Extract is about 5.6 times faster on one worker and 16-19 times faster on six.**
   - Rebuilt frames: 23.4-24.4 s (150 frames/s).
   - Extractor, 1 worker: 4.2-4.3 s (about 850 frames/s).
   - Extractor, 6 workers: 1.3-1.6 s (about 2,600 frames/s).
   - Every window was solved from the factors (6 of 6 projected, none rebuilt).
2. **From the stream's end to Extract done: 64-67 s down to 43-48 s.** The Final settle (35-40 s) is now most of it,
   and it did not change. One worker against six makes no difference to that total here: a 3-min stream has 6 windows,
   so Extract is short either way.
3. **On a long stream the gain is the larger part of the wait (inferred, not run).** The 1 h V4 stream spent 37 min
   in Extract at 32 frames/s on 1,282 cells (`2026-11-24-factors-v4-1h-speed.md` on `perf/cala-factors-v4-speed`). At
   this run's ratios that would be about 6-7 min on one worker and a few minutes on six; it has 120 windows, enough
   for the six. The cost per frame grows with the cells, so the 1 h run is the one to confirm.
4. **The recording comparison was not obtained.** On `wl24_20251201` with `?factors=file&cpool=4,4,…`, the
   compressor was still 7,800-10,200 frames behind when Extract started, so all three runs replayed the file (Extract
   never waits on a recording). The extractor was not exercised there.
5. **The traces** were not compared across these runs: each run's Discover found a slightly different set of cells.
   The unit tests compare the two routes on the same factors: 3e-6 on a first window; later windows 1.3e-3 in their
   first frames (each window starts the solver cold), about 1e-6 from frame 10 on; and bit-identical traces with 3
   helpers answering out of order against 1 worker.

## What was run

- App at `feat/cala-factor-extractor` (slice 6, before its docs commit), production build, served locally.
- Google Chrome (`--channel chrome`), headless, a fresh profile on the external SSD per run. Apple M1 Max, 10 logical
  cores. Load average at the starts 6.3-12.8 (other projects' jobs).
- `apps/cala/scripts/live-measure.mjs`:
  - `--mode live --fps 20 --frames 3600` on the minisim `motion_s5` (600x600): `fextract=0` (rebuilt frames),
    default (extractor, 6 workers on 10 cores), `cpool=1,3,1` (extractor, 1 worker); interleaved, twice each.
  - `--mode file` on `wl24_20251201` (200x200, 40,234 frames): `factors=file` with `cpool=4,4,6&fextract=0`,
    `cpool=4,4,1` and `cpool=4,4,6`, once each.
- Extract times from the exports' stage records; the other stages from the driver's one-second timeline.
- Outputs on the evaluation SSD under `runs/factor-extractor-20261124/`.

## Results

### 3-min 600 px stream (`motion_s5`, 3,600 frames)

| Extract                       | run | cells | Extract (s) | frames/s | windows projected / rebuilt | wait for last window (s) | settle (s) | stream end to Extract done (s) |
| ----------------------------- | --: | ----: | ----------: | -------: | --------------------------- | -----------------------: | ---------: | -----------------------------: |
| rebuilt frames (`fextract=0`) |   1 |   604 |        24.4 |      148 | -                           |                      7.0 |       36.1 |                           67.2 |
| rebuilt frames (`fextract=0`) |   2 |   607 |        23.4 |      154 | -                           |                      6.0 |       35.1 |                           64.1 |
| extractor, 1 worker           |   1 |   609 |         4.2 |      867 | 6 / 0                       |                      6.0 |       36.1 |                           46.1 |
| extractor, 1 worker           |   2 |   593 |         4.3 |      833 | 6 / 0                       |                      6.0 |       34.1 |                           44.1 |
| extractor, 6 workers          |   1 |   593 |         1.6 |    2,308 | 6 / 0                       |                      6.0 |       40.2 |                           48.2 |
| extractor, 6 workers          |   2 |   620 |         1.3 |    2,880 | 6 / 0                       |                      6.0 |       35.1 |                           43.1 |

### `wl24_20251201` (200 px), `?factors=file`

| pool (D,E,X) and route | Discover (s) | cells | settle        | settle (s) | Extract | Extract (s) | frames still compressing at Extract |
| ---------------------- | -----------: | ----: | ------------- | ---------: | ------- | ----------: | ----------------------------------: |
| 4,4,6, rebuilt frames  |           40 |    86 | file (behind) |       31.1 | file    |        39.8 |                               7,834 |
| 4,4,1, extractor       |           40 |    85 | file (behind) |       29.1 | file    |        37.1 |                               8,434 |
| 4,4,6, extractor       |           38 |    73 | file (behind) |       27.1 | file    |        35.5 |                              10,234 |

## Not measured

- The 1 h V4 stream with the extractor (about 75 min of machine time).
- Extract on factors on a recording (point 4).
- Windows solved on rebuilt frames in practice: none of these runs had a pixel without data under a cell. On the
  1 h V4 stream, with real motion, some might.
