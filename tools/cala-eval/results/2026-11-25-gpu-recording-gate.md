# cala GPU compressor: a recording on GPU factors against the file, 1 h V4 and wl24 (interim, 24 Nov 2026)

Question: should a saved recording compress on the GPU and settle and extract on its factors by default
(`?factors=gpu` today)? The default switches only if every gate below passes.

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
