# cala GPU compressor: a recording on GPU factors against the file, 1 h V4, wl24 and two sims (24 Nov 2026)

Question: should a saved recording compress on the GPU and settle and extract on its factors by default
(`?factors=gpu` today)? The default switches only if every gate below passes.

**Result (re-run, Task 7b, below):** on the build where Discover waits for the GPU (`2eb62b5a`), every gpu run kept
its factors and Discover end to Extract done fell by 55-57 % on V4 and both sims; the default still does **not**
switch: Discover is 5-9 % longer at 200 px (gate b: wl24 +6-9 %, wl200 +5.1 %) and wl200's precision on factors is
below the file runs' (gate d). The first part of this file is the interim report of the first build.

**Interim.** Both V4 `?factors=gpu` runs gave their factors up in Discover's first seconds, so the default cannot switch
on this build. The owner decided Discover will wait when the GPU ring is full; the gpu arms will be re-run on that
build into the same run folder. The file arms below are the baselines for that re-run. The settle evaluation was not
run.

## Data and method

- **V4:** 1 h of `cafast_v4_2h` (files 0-71, 72,000 frames, 600 x 600, 20 fps), on the evaluation SSD.
- **wl24:** `wl24_20251201` as 41 plain AVIs (40,234 frames, 200 x 200).
- **Sims with truth** (added by the owner): `synth_v4_chal_plain` (V4-like, 600 x 600, 24,000 frames, 461 truth
  cells, 389 detectable) and `synth_v4_chal_wl200` (Miniscope-Zero-like, 200 x 200, 36,000 frames, 91 truth cells, 85
  detectable).
- Build `308105a1` (`npm run build:e2e`), local Google Chrome (Apple M1 Max, WebGPU),
  `apps/cala/scripts/live-measure.mjs --mode file`, a fresh browser profile on the SSD per run, arms alternating, load
  average 3.4-7.2 at the starts.
- **Arms:** file (no switch) and `?factors=gpu`, two runs each. Run: V4 gpu, V4 file, wl24 gpu, wl24 file, then again;
  stopped by the owner after `v4_file2`, then the missing file arms only.
- **Times:** Discover = page open to pass 1 done; after Discover = Discover's end to Extract done.
- **Traces between runs:** cells matched one to one by footprint cosine >= 0.7; per cell `sd(x - y) / sd(y)` of
  Extract's traces.
- **Truth:** export cells matched one to one to truth cells by footprint cosine >= 0.5, after one global offset of the
  truth (the best overlap of the summed footprints: plain (2, -2) px, wl200 (3, -6) px). Recall = matched detectable /
  detectable; precision = matched / cells; trace r = Pearson of Extract's trace with the true trace on the frames the
  sim did not drop or duplicate, median over matched cells.

## Runs

| rec   | arm  | run | Discover (s) | settle (source, s) | Extract (source, s) | after Discover (s) | cells | GPU ms/frame mean / p50 / max (windows) |
| ----- | ---- | --: | -----------: | ------------------ | ------------------- | -----------------: | ----: | --------------------------------------- |
| V4    | file |   1 |          759 | file, 420          | file, 969           |              1,389 |   925 | -                                       |
| V4    | file |   2 |          773 | file, 422          | file, 929           |              1,351 |   932 | -                                       |
| V4    | gpu  |   1 |          807 | file, 420          | file, 922           |              1,342 |   931 | 5.16 / 5.87 / 6.49 (3), then gave up    |
| V4    | gpu  |   2 |          791 | file, 425          | file, 959           |              1,384 |   948 | none finished, gave up                  |
| wl24  | file |   1 |         34.1 | file, 29.1         | file, 39.1          |               68.2 |    85 | -                                       |
| wl24  | file |   2 |         34.2 | file, 21.1         | file, 31.1          |               52.2 |    69 | -                                       |
| wl24  | gpu  |   1 |         37.2 | factors, 27.1      | factors, 7.0        |               34.1 |    99 | 0.56 / 0.52 / 1.59 (36)                 |
| plain | file |   1 |        120.7 | file, 153.5        | file, 103.3         |              256.8 |   306 | -                                       |
| plain | file |   2 |        121.6 | file, 150.4        | file, 103.2         |              253.6 |   302 | -                                       |
| wl200 | file |   1 |         30.1 | file, 16.1         | file, 20.1          |               36.1 |    62 | -                                       |
| wl200 | file |   2 |         30.1 | file, 15.0         | file, 19.0          |               34.1 |    55 | -                                       |

- Every gpu run: `compress_window` 600, `compress_ring` 1,200 frames (two windows; V4 gpu2 gave up before the status
  reported them).
- wl24 gpu1 kept all its windows: 634 frames behind at the end, none behind at Discover's end.
- Not run (owner): wl24 gpu2 and the sims' gpu arms (next build).

### Why V4 gave up

- `gpu1`: windows 1, 2 and 3 done at 10, 12 and 17 s (5.9, 3.1, 6.5 ms/frame); at 21 s (frame ~3,090) "No factors: the
  GPU compressor fell a window behind Discover."
- `gpu2`: no window finished; the same error at 9 s (frame ~1,230).
- Discover opens at ~170-200 frames/s (1 h mean: 94); a window at 5-6.5 ms/frame is ~155-190 frames/s. The ring holds
  two windows, so one slow window ends the route.
- Both then fell back as designed: settle and Extract on the file, compressor behind 70,200 and 72,000 of 72,000
  frames at Discover's end, results as on the file (cells 931 / 948 against 925 / 932).

## Gates

| gate                                                  | V4                                                                                       | wl24                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| (a) after Discover shorter on gpu (mean)              | not measurable: no gpu run kept its factors (1,363 vs 1,370 s, -0.5 %, both on the file) | **pass**: 34.1 vs 60.2 s (-43 %), one run  |
| (b) Discover at most 5 % longer on gpu (mean)         | pass: 799 vs 766 s (+4.3 %)                                                              | **fail**: 37.2 vs 34.2 s (+8.9 %), one run |
| (c) every gpu run kept its factors                    | **fail**: 0 of 2                                                                         | pass: 1 of 1                               |
| (d) settle evaluation, or sims within the file spread | not run                                                                                  | not run                                    |

**Default switched: no.** Gate (c) fails on V4 and gate (b) on wl24 (+3.9 points over the 5 % line, one run).

## Quality lines

### Extract traces between runs

| rec   | runs          | matched cells | median diff (sd) |  p90 | largest | median r |
| ----- | ------------- | ------------: | ---------------: | ---: | ------: | -------: |
| V4    | gpu1 / file1  |           816 |            0.252 | 0.65 |     3.3 |    0.972 |
| V4    | gpu2 / file2  |           819 |            0.248 | 0.67 |     5.3 |    0.972 |
| V4    | file1 / file2 |           800 |            0.262 | 0.66 |     8.2 |    0.969 |
| wl24  | gpu1 / file1  |            61 |            0.715 | 0.85 |     1.7 |    0.759 |
| wl24  | file1 / file2 |            52 |            0.414 | 0.76 |     1.1 |    0.927 |
| plain | file1 / file2 |           281 |            0.036 | 0.20 |     1.0 |    1.000 |
| wl200 | file1 / file2 |            51 |            0.111 | 0.30 |     0.9 |    0.996 |

- V4's gpu runs read the file, so their traces differ from the file arm's as two file runs differ.
- wl24 on factors: Extract's traces differ from the file's more than two file runs do (0.72 against 0.41 sd, r 0.76
  against 0.93). Extract on factors solves on low-rank frames (less per-frame noise, as the export notes say). One run;
  the sims' gpu arms (truth) are needed to tell whether this costs anything.

### Simulated recordings (truth), file arm

| rec   | run   | cells | matched | recall | precision | median trace r | unmatched on out-of-focus cells |
| ----- | ----- | ----: | ------: | -----: | --------: | -------------: | ------------------------------: |
| plain | file1 |   306 |     284 |  0.692 |     0.928 |          0.960 |                              14 |
| plain | file2 |   302 |     283 |  0.684 |     0.937 |          0.958 |                              12 |
| wl200 | file1 |    62 |      33 |  0.365 |     0.532 |          0.942 |                              26 |
| wl200 | file2 |    55 |      28 |  0.306 |     0.509 |          0.939 |                              26 |

- The spread the gpu arm must stay within (gate (d), alternative): plain recall 0.684-0.692, precision 0.928-0.937,
  trace r 0.958-0.960; wl200 recall 0.306-0.365, precision 0.509-0.532, trace r 0.939-0.942.
- wl200's low precision is mostly out-of-focus cells, which the truth leaves out (26 of 27-29 unmatched cells).
- Gates (a)-(c) on the sims: no gpu run yet.

## Conclusion

- On this build a 600 px recording cannot keep GPU factors at file speed: both V4 runs gave up in the first 21 s,
  because the GPU's window pace (5-6.5 ms/frame) is at or below Discover's opening read rate and the ring holds two
  windows.
- At 200 px the route works when it keeps its factors: after Discover 34 s instead of 52-68 s, but Discover itself
  ~9 % longer (one run; 25 Nov: 37.3 against 34.3-34.8 s, the same).
- **No default switch.** Next: Discover waits when the GPU ring is full (owner); re-run the gpu arms (V4, wl24, both
  sims) into the same run folder, then the gates (a)-(d) again. On that build gate (b) becomes the question: the wait
  adds to Discover.

## Re-run on the waiting build (Task 7b, 24 Nov evening)

Build `2eb62b5a` ("Discover waits for the GPU compressor when its ring is full"): while the GPU's 1,200-frame ring has
no room for the next batch, the trace stage holds its job and the stages before it wait (their buffer credits); the
wait ends when a window is done, when the GPU route ends, at Stop or a new run, or after 30 s without word from the
GPU (then the factors are given up as "stalled"). Same folder, same method, gpu arms only (`ARMS=gpu GPU=gpuB
SETTLE=0 run_gate.sh`, tags `*_gpuB1/2`), against the file arms above. Load average 4.5-8.6 at the starts. `wait` =
seconds Discover waited for the GPU in all (`compress_wait_s`), and how many times.

| rec   | arm  | run | Discover (s) | wait s (n) | settle (source, s) | Extract (source, s) | after Discover (s) | open to Extract done (s) | cells | GPU ms/frame mean / p50 / max (windows) |
| ----- | ---- | --: | -----------: | ---------- | ------------------ | ------------------- | -----------------: | -----------------------: | ----: | --------------------------------------- |
| V4    | file |   1 |        759.2 | -          | file, 420          | file, 969           |              1,389 |                    2,148 |   925 | -                                       |
| V4    | file |   2 |        773.4 | -          | file, 422          | file, 929           |              1,351 |                    2,124 |   932 | -                                       |
| V4    | gpuB |   1 |        798.9 | 1.1 (3)    | factors, 411       | factors, 188        |                601 |                    1,400 |   921 | 2.65 / 2.38 / 5.99 (120)                |
| V4    | gpuB |   2 |        807.6 | 1.2 (3)    | factors, 428       | factors, 194        |                624 |                    1,432 |   927 | 2.57 / 2.35 / 5.93 (120)                |
| wl24  | file |   1 |         34.1 | -          | file, 29.1         | file, 39.1          |               68.2 |                    102.4 |    85 | -                                       |
| wl24  | file |   2 |         34.2 | -          | file, 21.1         | file, 31.1          |               52.2 |                     86.3 |    69 | -                                       |
| wl24  | gpuB |   1 |    **188.6** | 0 (0)      | factors, 149.4     | factors, 58.2       |              207.6 |                    396.3 |   121 | 0.51 / 0.46 / 2.00 (62)                 |
| wl24  | gpuB |   2 |         37.1 | 0 (0)      | factors, 25.1      | factors, 7.0        |               32.1 |                     69.2 |    89 | 0.55 / 0.51 / 1.58 (36)                 |
| plain | file |   1 |        120.7 | -          | file, 153.5        | file, 103.3         |              256.8 |                    377.5 |   306 | -                                       |
| plain | file |   2 |        121.6 | -          | file, 150.4        | file, 103.2         |              253.6 |                    375.3 |   302 | -                                       |
| plain | gpuB |   1 |        125.7 | 0 (0)      | factors, 113.4     | factors, 2.0        |              116.4 |                    242.1 |   298 | 1.77 / 1.59 / 4.13 (40)                 |
| plain | gpuB |   2 |        126.8 | 0 (0)      | factors, 114.4     | factors, 1.0        |              115.4 |                    242.1 |   295 | 1.80 / 1.61 / 4.23 (40)                 |
| wl200 | file |   1 |         30.1 | -          | file, 16.1         | file, 20.1          |               36.1 |                     66.2 |    62 | -                                       |
| wl200 | file |   2 |         30.1 | -          | file, 15.0         | file, 19.0          |               34.1 |                     64.2 |    55 | -                                       |
| wl200 | gpuB |   1 |         31.1 | 0 (0)      | factors, 14.0      | factors, < 1        |               15.0 |                     46.2 |    79 | 0.35 / 0.33 / 0.60 (31)                 |
| wl200 | gpuB |   2 |         32.2 | 0 (0)      | factors, 15.0      | factors, < 1        |               15.0 |                     47.2 |    84 | 0.35 / 0.33 / 0.62 (31)                 |

- Every gpuB run kept its factors (no `GPU_TEXT` error, settle and Extract on factors). Only V4 waited: about 1.1 s
  over 3 waits per hour-long run, all in the opening burst. The GPU's pace on V4 (2.6 ms/frame, ~380 frames/s) is far
  above Discover's, so after the first windows the ring never filled again.
- **wl24 gpuB1 is an outlier, not a wait:** no wait at all, the GPU kept up (pending 0 throughout), but from 8 s on the
  whole pipeline ran at ~220-290 frames/s instead of ~1,100 (the slow loop then dropped 5,432 frames and found 121
  cells). No other workload, no thermal warning (`pmset -g therm`). Not reproduced: gpuB2 37.1 s, and one more pair
  run afterwards, adjacent (`repeat_wl24_gpuB.sh`): `wl24_gpuB3` Discover 35.2 s (2 waits, 0.02 s), after Discover
  33.1 s, 91 cells; `wl24_file3` Discover 33.2 s, after Discover 55.2 s, 78 cells. Cause unknown; reported as
  measured and in the means below.

### Discover with and without the GPU route

| rec   | file runs (s)           | gpu runs, first build (s) | gpuB runs, waiting build (s) | gpuB mean vs file mean |
| ----- | ----------------------- | ------------------------- | ---------------------------- | ---------------------- |
| V4    | 759.2, 773.4            | 807.5, 791.3 (gave up)    | 798.9, 807.6                 | +4.8 %                 |
| wl24  | 34.1, 34.2 (33.2 extra) | 37.2                      | 188.6, 37.1 (35.2 extra)     | +230 %; B2/B3 +5.7 %   |
| plain | 120.7, 121.6            | -                         | 125.7, 126.8                 | +4.2 %                 |
| wl200 | 30.1, 30.1              | -                         | 31.1, 32.2                   | +5.1 %                 |

The cost of the GPU route is in Discover itself, not in the wait: the waits are ~1 s per hour on V4 and 0-0.02 s
elsewhere; the GPU compressor's quantize, upload and windows compete with Discover for the same CPU and GPU (the
first build's wl24 run, which never waited, was +8.9 % too). At 200 px that competition is 5-9 % of Discover.

### Gates on the waiting build (mean of the two gpuB runs against the two file runs)

| gate                                                                              | V4                                             | wl24                                                                              | plain                                | wl200                                                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Discover end to Extract done shorter on gpu                                   | **pass**: 612 vs 1,370 s, -55 %                | **fail** with gpuB1 (120 vs 60 s); without it: 32-33 vs 52-68 s, -45 %            | pass: 116 vs 255 s, -55 %            | pass: 15.0 vs 35.1 s, -57 %                                                                                                            |
| (b) Discover at most 5 % longer (waits included)                                  | **pass**: +4.8 % (0.2 points, 1.3 s, to spare) | **fail**: +230 %; without gpuB1 +5.7 % (B2/B3 vs file1-3: 36.2 vs 33.8 s, +6.9 %) | pass: +4.2 %                         | fail: +5.1 % (0.1 points over)                                                                                                         |
| (c) every gpu run kept its factors                                                | **pass** 2 of 2                                | **pass** 2 of 2 (and gpuB3)                                                       | pass 2 of 2                          | pass 2 of 2                                                                                                                            |
| (d) sims: recall, precision, median trace r within or above the file runs' spread | -                                              | -                                                                                 | **pass** (all three above or within) | **fail**: precision 0.506 / 0.464 vs file 0.509-0.532 (recall 0.459 / 0.447 vs 0.306-0.365, trace r 0.948 / 0.942 vs 0.939-0.942 pass) |

The brief's gates (a) and (b) name the two real recordings; the sims' rows are for information. **Gates (a) and (b)
fail on wl24 and (d) fails on wl200: the default is not switched.** Without the gpuB1 outlier, (a) passes on wl24
too and (b) still fails at 200 px (wl24 +5.7-6.9 %, wl200 +5.1 %); V4 passes (b) by 1.3 s.

### Quality on the waiting build

Extract traces between runs (cells matched one to one by footprint cosine >= 0.7; `sd(x - y) / sd(y)`):

| rec   | runs          | matched | median diff (sd) |  p90 | median r |
| ----- | ------------- | ------: | ---------------: | ---: | -------: |
| V4    | gpuB1 / file1 |     797 |            0.377 | 0.73 |    0.932 |
| V4    | gpuB2 / file2 |     802 |            0.369 | 0.73 |    0.938 |
| V4    | file1 / file2 |     800 |            0.262 | 0.66 |    0.969 |
| V4    | gpuB1 / gpuB2 |     794 |            0.233 | 0.67 |    0.975 |
| wl24  | gpuB1 / file1 |      64 |            0.718 | 0.94 |    0.741 |
| wl24  | gpuB2 / file2 |      50 |            0.645 | 0.89 |    0.795 |
| wl24  | file1 / file2 |      52 |            0.414 | 0.76 |    0.927 |
| wl24  | gpuB1 / gpuB2 |      68 |            0.356 | 0.83 |    0.950 |
| plain | gpuB1 / file1 |     283 |            0.198 | 0.52 |    0.981 |
| plain | file1 / file2 |     281 |            0.036 | 0.20 |    1.000 |
| plain | gpuB1 / gpuB2 |     274 |            0.027 | 0.19 |    1.000 |
| wl200 | gpuB1 / file1 |      57 |            0.572 | 0.82 |    0.841 |
| wl200 | file1 / file2 |      51 |            0.111 | 0.30 |    0.996 |
| wl200 | gpuB1 / gpuB2 |      75 |            0.092 | 0.34 |    0.998 |

- As in the interim (wl24 0.72 vs 0.41 sd), Extract on factors gives traces further from the file's than two file
  runs are from each other, on every recording (V4 0.37 vs 0.26, wl24 0.65-0.72 vs 0.41, plain 0.20 vs 0.04, wl200
  0.57 vs 0.11), while two factor runs agree with each other as closely as two file runs do.
- The sims say which is closer to the truth: **the factor traces are**. Median trace r with the true trace, on the
  truth cells both arms found (run i against run i):

| rec   | runs          | truth cells in both | median r file | median r gpu | median (gpu - file) | share of cells better on gpu |
| ----- | ------------- | ------------------: | ------------: | -----------: | ------------------: | ---------------------------: |
| plain | file1 / gpuB1 |                 267 |        0.9629 |       0.9748 |             +0.0058 |                         0.78 |
| plain | file2 / gpuB2 |                 259 |        0.9629 |       0.9745 |             +0.0043 |                         0.76 |
| plain | file1 / file2 |                 263 |        0.9651 |       0.9629 |             +0.0000 |                         0.52 |
| wl200 | file1 / gpuB1 |                  32 |        0.9422 |       0.9528 |             +0.0069 |                         0.72 |
| wl200 | file2 / gpuB2 |                  24 |        0.9395 |       0.9551 |             +0.0045 |                         0.71 |
| wl200 | file1 / file2 |                  24 |        0.9437 |       0.9424 |             -0.0002 |                         0.42 |

(Extract on factors solves low-rank rebuilt frames: less per-frame noise, which the truth rewards.)

- Truth scores (gate d):

| rec   | run   | cells | matched | recall | precision | median trace r | unmatched on out-of-focus cells |
| ----- | ----- | ----: | ------: | -----: | --------: | -------------: | ------------------------------: |
| plain | file1 |   306 |     284 |  0.692 |     0.928 |          0.960 |                              14 |
| plain | file2 |   302 |     283 |  0.684 |     0.937 |          0.958 |                              12 |
| plain | gpuB1 |   298 |     281 |  0.692 |     0.943 |          0.973 |                              11 |
| plain | gpuB2 |   295 |     277 |  0.689 |     0.939 |          0.971 |                               9 |
| wl200 | file1 |    62 |      33 |  0.365 |     0.532 |          0.942 |                              26 |
| wl200 | file2 |    55 |      28 |  0.306 |     0.509 |          0.939 |                              26 |
| wl200 | gpuB1 |    79 |      40 |  0.459 |     0.506 |          0.948 |                              37 |
| wl200 | gpuB2 |    84 |      39 |  0.447 |     0.464 |          0.942 |                              44 |

- wl200 on factors keeps 79-84 cells instead of 55-62: recall rises from 0.31-0.37 to 0.45-0.46 (8-13 more truth
  cells found), and the extra cells are mostly on out-of-focus cells (37-44 vs 26), which the truth leaves out; so
  precision falls just below the file runs' (0.506 / 0.464 vs 0.509-0.532). The Final settle on factors keeps more
  cells at 200 px; whether out-of-focus cells count against it is the owner's call.

### Conclusion (waiting build)

- Waiting works: 9 of 9 gpu runs kept their factors (V4 0 of 2 on the first build), the waits cost about 1 s per hour
  of V4, and no run stalled.
- On every recording the run finishes much sooner: open to Extract done -34 % on V4 (1,416 vs 2,136 s), -36 % plain,
  -28 % wl200, -22 to -27 % on wl24 without the outlier; after Discover -55 to -57 %.
- **No default switch.** Gate (b) fails at 200 px (Discover +5-9 %, from the GPU route's share of CPU and GPU, not
  from waiting), gate (d) fails on wl200's precision (more out-of-focus cells kept), and wl24 gpuB1 ran 5x slower once
  for an unknown reason (a and b fail with it in the mean). V4 passes (a)-(c), by 0.2 points on (b).
- For the owner: the 5 % line at 200 px, and whether wl200's extra out-of-focus cells (with recall +0.09-0.15 and
  better trace r) count as a quality loss.
