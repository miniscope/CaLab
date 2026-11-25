# Recordings on factors: the slice 7 gate, 24 Nov 2026

Question: with the cheaper sketch (`k0_after`) and Task 6, does a recording finish sooner on its factors than on the
file? One run each, slice 7 build, Chrome 158 headless, profile on the evaluation SSD (origin quota 10.7 GB, so the
compressor's backlog cap is 5 GB), Apple M1 Max.

## Short answer

**No: a recording does not reach its factors, so it keeps the file default.** On both recordings the window files
waiting for compression passed the 5 GB cap during Discover, the compressor gave up, and the settle and Extract read
the file. That holds even with the settle told to wait for the factors (`?debug&fwait`).

| run                                     | frames | Discover | settle (file) | Extract (file) | Discover end to Extract done | cells | factors given up         |
| --------------------------------------- | -----: | -------: | ------------: | -------------: | ---------------------------: | ----: | ------------------------ |
| V4 600 px, `?factors=file&fwait`        | 72,000 | 13.9 min |       7.2 min |       16.0 min |                     23.3 min |   923 | at the cap, in Discover  |
| V4 600 px, file (23 Nov, earlier build) | 72,000 | 13.2 min |       7.1 min |       15.8 min |                     22.9 min |   919 | -                        |
| wl24 200 px, `?factors=file&fwait`      | 40,234 |     34 s |          23 s |           34 s |                         57 s |    68 | at the cap (4.8 GB peak) |
| wl24 200 px, file                       | 40,234 |     33 s |          29 s |           39 s |                         68 s |    88 | -                        |

- **Why the cap is reached:** Discover reads a recording far faster than one compress worker compresses it. wl24:
  Discover at about 1,200 frames/s, the compressor at 130 frames/s (3.8 ms per frame on the offset grids, Task 1's
  cheaper sketch included). V4: Discover at 87 frames/s, the compressor with almost no CPU. Offset grids store each
  frame twice as `i16`: 1.4 MB per frame at 600 px, 160 kB at 200 px, so 5 GB is about 3,500 and 31,000 frames.
- **`?factors=file` now costs about nothing beside the file path** (V4: 23.3 against 22.9 min, on 23 Nov it was 5 %
  longer with 33 GB on disk): the cap (slice 5) ends the compressor early, and Task 6 stops it when the settle reads
  the file.
- **wl24 found 68 cells with the compressor running during Discover against 88 without.** One run each, not
  repeated; it may be the compressor taking CPU from the slow loop (frames dropped for the slow loop), or run-to-run
  spread. Worth a repeat before any recording compresses during Discover by default.
- The wl24 AVI is OpenDML, which cala does not read; it was re-written as 41 plain `GREY` AVIs of 1,000 frames
  (same pixels).

## What would let a recording use its factors

The cheaper sketch does not change the picture: compression has to keep pace with Discover or not hold Discover's
frames on disk. Options, none built:

1. **Compress after Discover from the file:** a recording's frames are on disk already; a second preprocessing pass
   that feeds the compressor (the settle's re-read does such a pass today) would need no backlog. It only pays if
   settle and Extract on factors are then faster than on the file, which the file path's 23 min (V4) leaves little
   room for.
2. **More compress workers during Discover** (plan Task 4), only if Discover and its cell count stay as they are.
3. **A larger cap** where the disk allows (owner's decision, open).

For a recording that is short (V4: about 3,500 frames) or slow to read, the factors are used as before.

## Data

Runs, logs, metrics and exports on the evaluation SSD under `runs/recording-factors-20261124/`
(`v4_factors_wait/`, `wl24_*`, `runs.log`).
