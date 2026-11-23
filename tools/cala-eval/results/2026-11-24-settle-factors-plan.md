# Final settle on Discover's factors: evaluation plan (written before any run)

Spec: `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md`, decisions 2, 5 and 6. Branch
`feat/cala-factors-settle` (slice 1). Driver: `tools/cala-eval/settle_factors.sh`. The report will be
`2026-11-24-settle-factors.md`. Anything decided after the first scores is marked **(post hoc)**.

## Questions

1. Recording path: does the Final settle on Discover's own factors (offset grids) give footprints as good as the
   settle on re-read frames (main today), and is it at least as fast?
2. Stream path: after a Discover without look-back (a stream on main), does a Final settle on the stream's own
   factors, with the cluster replay in the settle only, improve the footprints over no settle at all?

## Arms

`qc_eval` with the flags in `settle_factors.sh`:

| arm     | Discover                                                   | settle                                       | stands for                    |
| ------- | ---------------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| `SET-R` | look-back + replay (`--joint-update all`), merge guard 0.6 | 18,000 frames, re-read and preprocessed      | a recording on main           |
| `SET-F` | as `SET-R`                                                 | as `SET-R`, frames rebuilt from the factors  | a recording on factors        |
| `STR-0` | no look-back, `--joint-update refine`, no merge guard      | none (`STR-F`'s library at the settle start) | a stream on main              |
| `STR-F` | as `STR-0`                                                 | as `SET-F`, the replay in the settle only    | a stream on factors (slice 2) |

- The settle flags are the app's: 18,000 frames, 16-frame requests, a checkpoint every 1,200 frames (`SETTLE` in
  `apps/cala/src/lib/settle.ts`).
- Amended before any scored run, after the first attempt at the checks: the app reads each frame once, so a shorter
  recording gets a settle as long as the recording. `qc_eval --settle-frames N` sweeps the recording again until N
  frames are fed (the first check run fed 18,000 frames of a 3,000-frame recording). The script now passes
  `--settle-frames` = the frames of the run, at most 18,000: 9,600 on the sims, 12,000 on the real recording. The
  same attempt showed that a run folder path with a space split `--factors-out`; the script now quotes it.
- The recording path is `COMBO` without the drain, as `concsettle2_real.sh` and `2026-11-19-lookback-settle-app.md`
  model the app.
- The factors: Discover's own windows, 600 frames, 64 px tiles on the two offset grids, two SVD power iterations.
- The settle-size study's own run trees and sims are not on this machine. The flags above come from committed scripts
  and reports, not from those trees.

## Recordings

All read-only, from the evaluation SSD:

- **Sims with truth:** `minisim_cala_eval/motion_s5` and `motion_s6`. 600x600 px, 9,600 frames at 20 fps, with
  motion.
- **Real:** `real_wireless/wl24_20251201`, the cala input `processed/cala_residual_history/input_grey`. Miniscope
  Zero, 200x200 px, 20 fps, the owner's wireless setup.
  - Runs use the first 12,000 frames.
  - The held-out runs (`settle_factors.sh hold`) solve frames 0-18,000 with each final library fixed. Frames after
    12,000 were seen by no run.
- **Seeds:** two per arm (`--slow-seed 1` and `2`). That makes 18 runs, plus 8 fixed-library runs on the real
  recording.

## Checks before the scored runs

Run on `motion_s5`, 3,000 frames.

1. With `--settle-source factors` the settle reads no raw frame: stdout shows `0 raw frames read`.
2. Discover does not move:
   - `SET-F`'s `footprints_settle0.bin` is byte-identical to `SET-R`'s;
   - a stream run with `--settle-frames` has a `footprints_settle0.bin` byte-identical to the final library of the
     same run without `--settle-frames`.

If a check fails, the runs do not start and the report says why.

## Measures

**Sims** (`settle_size.py score SIM RUN OUT.tsv --lib footprints[_settle0].bin`, matched cells):

- `missed`: light left out;
- `excess`: light in excess; `excess_nb`: the part on a neighbour's core;
- `err_core`: core shape error;
- matched cells: true cells found;
- false cells: final cells without a match, from `final.tsv`.

Each is the median over cells, per run.

**Real:**

- On the held-out frames (`settle_size.py proxies --cut 12000`): `score` and `frac` of the new frames, and
  close-pair trace correlation excess (`corr_close` minus `corr_far`).
- `settle_size.py real`: footprint size and faint share.
- Repeatability: median single-pair cosine of the two seeds of an arm (`settle_size.py pair`).

**Speed** (stdout):

- the settle's frames per second and wall seconds;
- the compressor's ms per frame (`factors:` line);
- the whole run's wall seconds.

## Pre-set lines

The spread of a measure is the absolute difference between the two seeds of the reference arm on the same
recording. With two seeds it is a coarse yardstick.

**`SET-F` against `SET-R`** (question 1). It passes when all hold on each recording:

- every sim measure is no worse than `SET-R` by more than `SET-R`'s spread (worse = higher `missed`, `excess`,
  `excess_nb`, `err_core` and false cells, fewer matched cells);
- real: the held-out score of the new frames is no lower than `SET-R` minus the spread, and the close-pair excess is
  no higher than `SET-R` plus the spread;
- repeatability is no lower than `SET-R`'s minus 0.002;
- speed: the settle's wall seconds are no more than `SET-R`'s plus `SET-R`'s spread.

**`STR-F` against `STR-0`** (question 2). It passes when all hold:

- on both sims, `missed` and `err_core` are lower for both seeds;
- false cells are no more than `STR-0` plus its spread;
- real: the held-out score of the new frames is no lower than `STR-0` minus its spread.

**`STR-F` against `SET-R`**: reported, not a line (the stream's ceiling).

**Not lines:** footprint size; the per-checkpoint "cells still moving" (reported).

## Budget and load

- At most 2 `qc_eval` processes at once. Other projects' jobs may load the machine: the load average at each run's
  start goes into the report.
- Times from loaded runs are reported as such.
- `qc_eval` is built once in release (`cargo build --release --example qc_eval --no-default-features --features
jsbindings`) at the branch's commit, named in the report.
- Outputs go to a run folder on the evaluation SSD, outside the repository. Factor files are deleted after each run.
