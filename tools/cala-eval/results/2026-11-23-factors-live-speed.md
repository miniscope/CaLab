# A live stream with and without `?factors` in Chrome (23 Nov 2026)

Slice 2's speed check (plan `docs/superpowers/plans/2026-11-23-cala-factors-live-slice2.md`, Task 13; spec decision 6,
the Chrome speed lines).

## Short answer

1. **The compressor keeps up at 600 px and 20 fps.** 25.0 ms of compute per frame against a 50 ms frame interval. No
   window waited for another: the queue was 0 at every status while streaming and at the stream's end.
2. **`?factors` drops no frames for the slow loop.** 0 in all six runs, with and without it. The slow loop's lag and
   the cells found are the same (about 9 frames; 600-613 cells).
3. **After a 3-minute stream, Extract on the factors is done 78-81 s after the stream ends.**
   - 17-18 s waiting for the last window to be compressed;
   - 37-38 s Final settle (3,600 frames fed);
   - 23-25 s Extract (3,600 frames).
   - Per minute of stream: settle 12.4-12.7 s, Extract 7.7-8.4 s, stream end to Extract done 26-27 s. The owner sets
     the line (spec decision 6).

## What was run

- App at `5ac2eefd` (branch `feat/cala-factors-live`), the production build (`npm run build:e2e`) served locally.
- Google Chrome 158, headed, one tab. Apple M1 Max. Load average at each start 4.6-8.1 (other projects' jobs running).
- Stream: the minisim `motion_s5` (600x600, 8-bit, motion) replayed by `live-sim.mjs` at 20 fps, the first 3,600
  frames (3 min). Recording read-only.
- `apps/cala/scripts/live-measure.mjs --mode live --fps 20 --frames 3600 --headed --channel chrome`, with
  `--query factors` for the `on` runs. Six runs, interleaved: off, on, off, on, off, on.
- Outputs (`<run>_metrics.json` with a one-second timeline, the exports) in the evaluation SSD's
  `runs/factors-live-speed-20261123/`.

## Results

| run | `?factors` | received | dropped for the slow loop | slow lag (mean frames) | cells | compressor ms/frame (mean, max) | windows waiting (max while streaming, at the end) |
| --- | ---------- | -------: | ------------------------: | ---------------------: | ----: | ------------------------------: | ------------------------------------------------- |
| 1   | off        |    3,600 |                         0 |                    9.0 |   610 |                               - | -                                                 |
| 1   | on         |    3,600 |                         0 |                    8.9 |   603 |                      25.0, 25.4 | 0, 0                                              |
| 2   | off        |    3,600 |                         0 |                    9.0 |   609 |                               - | -                                                 |
| 2   | on         |    3,600 |                         0 |                    8.9 |   613 |                      25.0, 25.4 | 0, 0                                              |
| 3   | off        |    3,600 |                         0 |                    8.9 |   600 |                               - | -                                                 |
| 3   | on         |    3,600 |                         0 |                    9.0 |   600 |                      25.0, 25.3 | 0, 0                                              |

After the stream ended (`on` runs only; seconds of wall time):

| run | last window compressed | Final settle | frames fed | Extract | frames | stream end to Extract done | settle s per min | Extract s per min |
| --- | ---------------------: | -----------: | ---------: | ------: | -----: | -------------------------: | ---------------: | ----------------: |
| 1   |                   18.0 |         37.1 |      3,600 |    24.1 |  3,600 |                       79.3 |             12.4 |               8.0 |
| 2   |                   18.1 |         38.1 |      3,600 |    25.1 |  3,600 |                       81.2 |             12.7 |               8.4 |
| 3   |                   17.0 |         38.1 |      3,600 |    23.0 |  3,600 |                       78.2 |             12.7 |               7.7 |

- "Last window compressed" is the wait of the Final settle: the last 600-frame window closes when the stream ends and
  takes about 15 s at 25 ms per frame.
- Times come from one-second samples: each is good to about 1 s.

## The spec's speed lines

- **The compressor keeps up:** passed. No window waited for a window before it, and nothing but the last window was
  left at the end.
- **Frames dropped for the slow loop do not rise with `?factors`:** passed (0 and 0).
- **Settle and Extract after the stream, per minute of stream:** about 12.5 s and 8 s (26-27 s from the stream's end to
  Extract done, including the 17-18 s wait, which does not grow with the stream). For the owner to judge.

## Limits

- One recording, 3 runs each, one machine, a 3-minute stream. The settle's plan reads every frame up to 18,000
  (15 min at 20 fps) and samples beyond that, so its time per minute should fall for streams longer than 15 min
  (inferred, not measured).
- The machine had other jobs running (load 4.6-8.1); the spread between runs is small.
- The compressor's queue is read from its status, which comes after each compressed window: a wait shorter than one
  window does not show.
