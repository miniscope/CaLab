# The Final settle on factors over the settle pool (25 Nov 2026)

GPU compressor plan, Task 6: a recording's Final settle on its factors (`?factors=gpu`/`file`) now sends its requests
to look-back workers 0..S (worker 0 and every settle pool worker in the run, each switched to the factors before its
first settle request). The settle on the file is unchanged: worker 0 alone.

## Setup

- V4, 2,000 frames (clones of files 0-1, the input of the 24 Nov GPU compressor check), paced at 20 frames/s
  (`pacefps=20`; unpaced `factors=gpu` still gives its factors up on V4).
- `live-measure.mjs`, file mode, local Chrome, a fresh profile per run, Apple M1 Max (10 logical cores). Two runs per
  arm, interleaved. Load average 5-9 (other projects' jobs).
- Settle seconds are from the 1 s samples (Discover's end to the final library); frames/s = frames fed / seconds.
  `workers` = look-back workers that answered a settle request (new `SettleStatus.workers`).
- The default settle pool on this machine is **S = 0** (one pool worker only from 12 logical cores). `lbpool=2`
  (`?debug&lbpool=2`) starts two pool workers.

## Results

| arm                    | pool S | settle source | settle s   | fed   | frames/s | workers | Extract s | cells    |
| ---------------------- | -----: | ------------- | ---------- | ----- | -------- | ------: | --------- | -------- |
| file, `pacefps=20`     |      0 | file          | 24.1, 24.1 | 2,000 | 83, 83   |       1 | 17, 18    | 559, 546 |
| gpu, `factors=gpu&...` |      0 | factors       | 26.1, 27.1 | 2,000 | 77, 74   |       1 | 6.0, 7.0  | 536, 557 |
| file, `lbpool=2`       |      2 | file          | 24.0, 24.1 | 2,000 | 83, 83   |       1 | 16, 16    | 546, 553 |
| gpu, `lbpool=2`        |      2 | factors       | 16.0, 16.0 | 2,000 | 125, 125 |       3 | 7.0, 7.0  | 553, 549 |

- With a pool, the settle on factors runs on all 3 workers and takes **16 s against 24 s on the file** (1.5x the
  file's frames/s). Discover (112 s) and Extract are unchanged.
- Without a pool (this machine's default), nothing changes: the settle on factors is on worker 0 alone, 26-27 s,
  about 10 % slower than the file's 24 s (as on 24 Nov: 27-29 s against 25 s).
- The file's settle is on worker 0 alone with or without a pool, as before.

## Open for the owner

- On machines under 12 logical cores (this one) the default pool is empty, and pool workers start only once a run goes
  below Max. So by default the settle on factors gains nothing here, and stays about 10 % slower than the file's.
  Options: start the pool for the settle on factors at Discover's end (also at Max), or give it its own size.
- The spec says the file settle runs on the settle pool. It does not: the Final settle on the file has always been on
  worker 0 alone. Fanning it out would split the file's preprocessor blocks across workers, so it was left alone.
