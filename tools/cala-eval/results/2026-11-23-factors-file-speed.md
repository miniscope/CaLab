# A recording with and without `?factors=file` in Chrome (23 Nov 2026)

Slice 3's measurement (plan `docs/superpowers/plans/2026-11-23-cala-factors-file-slice3.md`, Task 9): which source a
recording's Final settle and Extract take, and their times.

## Short answer

1. **Neither recording took the factor path.** With `?factors=file` both stages re-read the file on `motion_s5`
   (600 px) and on `wl24_20251201` (200 px), and the Run panel and the export said why.
2. **The reason on this machine was storage, not only pace.** The disk had 13 GB free (99 % used). Chrome then
   refuses writes to the origin private file system (OPFS), and the compressor failed with "No space available for
   this operation". That marks the factors unusable, so both stages took the file at once. The fallback worked as
   designed: no wait, no error in the run, the same cells and times as without the switch.
3. **With enough disk the file path would still be taken on both recordings** (inferred from the compressor's
   speed; not run):
   - `wl24_20251201`: the compressor did 3.27 ms per frame here, so 40,234 frames need about 132 s against
     Discover's 35 s. It was 39,634 frames (about 130 s) behind at Discover's end, far more than the one window the
     settle waits for. During the 23 s settle it would catch up by only 23 s, so Extract also replays the file.
   - `motion_s5`: slice 2 measured 25 ms per frame at 600 px, so 9,600 frames need about 240 s against Discover's
     54 s; still about 95 s behind when Extract starts after the 92 s settle.
   - The factor path is taken only when Discover is not much faster than the compressor, or the recording is shorter
     than about one window more than what the compressor keeps up with (the e2e's 590-frame movie). Files by default
     need parallel compression (spec decision 1).
4. **New cost found: the backlog of raw windows in OPFS.** A window waits as raw quantized frames (int16) until it is
   compressed: 432 MB per 600-frame window at 600 px, 48 MB at 200 px. When the compressor falls behind, the backlog
   grows with the recording: about 5 GB for `motion_s5` and 3 GB for `wl24_20251201` at Discover's end. On a nearly
   full disk this is what fails. A stream at 20 fps keeps no backlog (slice 2: queue 0).
5. **`?factors=file` costs nothing when it falls back.** Discover, settle and Extract times are close to the runs without
   it (one run each, so no spread is known).

## What was run

- App at `fd5f82b3` plus the e2e commit (branch `feat/cala-factors-file`), the production build (`npm run build:e2e`)
  served locally.
- Google Chrome, headed, one tab, a fresh profile per run. Apple M1 Max. Load average at each start 6.2-10.1 (other
  projects' jobs running). 13 GB free on the system disk.
- `apps/cala/scripts/live-measure.mjs --mode file --headed --channel chrome`, with `--query factors=file` for the
  `on` runs. One run each, off then on.
- Recordings (read-only): the minisim `motion_s5` (600x600, 9,600 frames) and `wl24_20251201` (200x200, the
  destriped grey input, 40,234 frames).
- Outputs (`<run>_metrics.json` with a one-second timeline, the exports) on the evaluation SSD under
  `runs/factors-file-speed-20261123/`. A first pair of `on` runs went out without the switch (a quoting slip in the
  run script) and was run again; only the second pair is reported.

## Results

| recording       | `?factors=file` | Discover (s) | cells | settle source (reason) | settle (s) | settle frames | Extract source | Extract (s) | Discover end to Extract done (s) |
| --------------- | --------------- | -----------: | ----: | ---------------------- | ---------: | ------------: | -------------- | ----------: | -------------------------------: |
| `motion_s5`     | off             |           53 |   497 | file (no switch)       |       92.2 |         9,600 | file           |        50.1 |                            142.3 |
| `motion_s5`     | on              |           54 |   504 | file (OPFS: no space)  |       92.2 |         9,600 | file           |        50.1 |                            142.3 |
| `wl24_20251201` | off             |           35 |    79 | file (no switch)       |       26.1 |        17,984 | file           |        37.1 |                             63.1 |
| `wl24_20251201` | on              |           35 |    73 | file (OPFS: no space)  |       23.0 |        17,984 | file           |        33.1 |                             56.1 |

Compressor on `wl24_20251201` with the switch: one window compressed by 8 s, then 12 windows queued (7,200 frames) for
the rest of Discover; 3.27 ms per frame; behind by 39,634 frames at Discover's end. On `motion_s5` the compressor
reported no window before the write failed.

Settle frames on `wl24_20251201` are the settle's sampled plan (above 18,000 frames it samples 64-frame blocks).

## Not measured

- The factor path's settle and Extract times on a real recording: with one compress worker it is not taken (point
  3), and forcing it would mean waiting, which slice 3 never does. The e2e shows the path works end to end on a
  590-frame cell movie; slice 2's report has the times for a 600 px stream (settle 12.4-12.7 s and Extract 7.7-8.4 s
  per minute of stream).
- A run with enough free disk, which would show the "behind" reason instead of the storage error. Expected from point
  3, not run.
- Run-to-run spread: one run per arm.
