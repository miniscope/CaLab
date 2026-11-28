# Mean-field footprint statistics (D1): same estimator, rounding-level change, faster slow worker

27 Nov 2026. Branch `perf/cala-mean-field-fpstats` (on main `320a43f0`). Design: stage-1 slow-worker note §4.5
(B2, fpstats + ledger; clusters not touched). The PI accepted a rounding-level (not bitwise) change for this. Raw
data, scripts and logs: `~/Projects/cala-data/runs/d1-mean-field/` (`b0/`, `runs/`, `runs-dump/`, `chrome/`,
`scripts/`).

## Verdict

**All four gates pass.** The per-frame footprint statistics are 3.4–4.6x faster in the micro-benchmark, and the
ledger is 2.6x faster. Natively, `observe` takes 28–31 % less time per frame. Detection, footprints and demixing on
the v3 sims are unchanged within noise: every gated paired CI covers 0. In headed Chrome on the workshop
recording, the Final settle and Discover are faster in both runs of each build. The cell counts differ by run-to-run
spread (n = 2, below).

## What changed

- `FpStats` keeps a cell's per-pixel sums in mean-field form (`MeanField`, `crates/cala/src/discover/fpstats.rs`):
  - The loop keeps one f64 field `P = Σ w (y − model)` over the fitting frames pushed to every cell.
  - Each cell has `rb` (f64), so that `r = P + rb − Σ w level + col·Σ w c`.
  - Each cell has `rcx` (f32), which takes `w c (y − model)` only on frames where its trace is non-zero.
  - The level and own-signal terms are f64 scalars. The own-signal scalars are folded into `rb`/`rcx` when the
    column changes.
  - The split halves use the same form, opening and closing block A against `P`.
  - Look-back pushes to a subset of cells add `w d` to `rb` directly and never reach `P`.
  - A cell that misses a field push has that frame cancelled from `rb` (`exclude`). That happens when the cell is not
    in the frame's library or its trace is NaN.
  - A disk that meets a missing sample, or a non-finite ring level, turns the cell plain for good. That is the
    existing per-frame path with per-pixel moments.
  - Readers go through `SlowLoop::stats_of`, which returns the plain layout (`materialised`). The wire format,
    the job encoding and `VisitRunner` are unchanged.
- Ledger: the support's dot product with `y − model` is summed per row run in eight lanes (`runs_dot`). A support
  with a missing sample falls back to the serial masked sum.
- Work counters are unchanged, so the work-credit schedule sees the same numbers.
- Deterministic and machine-independent: one fixed summation order, no timing-dependent path, no FMA. The scalar
  and SIMD builds still agree, because the lane sums are written out explicitly.

## Gate 1: B0 micro-benchmark (native, release)

`examples/fpstats_bench.rs` (`--features timing`) calls the engine's own kernels (`discover::bench`). Disk shapes
are each run's final library (support disk + 4 px margin). Trace zero shares are each cell's `zero_frac` from that
run's `cells.tsv`. The benchmark ran 600 fitting frames, took a new column every 100 frames, and reports the
median of 3 repeats. The new arm counts the residual pass and the field pass in full, although the ledger shares
the residual pass in the engine. Output: `b0/b0.txt`.

| shapes                                         | cells | disk px | zero share | fpstats old → new ms/frame | speed-up | ledger old → new | speed-up |
| ---------------------------------------------- | ----: | ------: | ---------: | -------------------------- | -------: | ---------------- | -------: |
| workshop final library (Stage 0 `ws_timing`)   |   904 |    1997 |      0.330 | 1.724 → 0.374              | **4.61** | 0.511 → 0.194    |     2.64 |
| workshop shapes, first 300 cells               |   300 |    1870 |      0.305 | 0.478 → 0.182              |     2.63 | 0.158 → 0.058    |     2.74 |
| workshop shapes, 8 px NaN border on all frames |   904 |    1997 |      0.330 | 1.788 → 0.683              |     2.62 | 0.511 → 0.202    |     2.53 |
| v3_static_s5 (4,800-frame gate run)            |   664 |    1102 |      0.451 | 0.699 → 0.205              |     3.41 | 0.201 → 0.077    |     2.61 |
| v3_motion_s5 (4,800-frame gate run)            |   692 |    1128 |      0.397 | 0.767 → 0.220              |     3.49 | 0.220 → 0.082    |     2.68 |

- The gate was the workshop shapes (the design's B0): **4.61x ≥ 2.5x, GO**.
- The new arm has a fixed part per frame: the residual pass is about 0.05 ms and the field pass 0.05 ms. That fixed
  part is why the speed-up falls with fewer cells.
- With a NaN border, the missing-sample count costs a prefix pass, and the 7 cells on the border run plain.
- The materialised estimates match the plain arm's to 1.8e-5 of each disk's largest value.

## Gate 2: unit tests

- `discover::tests::mean_field_statistics_match_the_plain_sums` runs two `SlowLoop`s, one forced plain
  (`#[cfg(test)]`). It covers:
  - live frames on one library interleaved with look-back frames on another (alternating versions, so folds every
    frame);
  - a live-library cell that misses look-back field pushes (`exclude`);
  - a shifted footprint whose disk moves back and forth;
  - look-back pushes to a subset;
  - a missing patch on one disk (the cell turns plain) and a missing pixel elsewhere;
  - 1,100 frames with half-life 40, so forgetting rescales several times and split-half blocks change.
- Tolerances:
  - raw sums `rc`, `r` and both halves: within 1e-5 of the disk's largest value, every 100 frames;
  - estimates and standard errors: within 1e-5;
  - split-half estimates: within 1e-4. Half B is total − A of f32 sums, so the reference's own rounding is
    amplified there.
- `fpstats::push_frame_tests::exclude_cancels_a_field_push_and_a_subset_push_is_plain` and
  `runs_dot_matches_the_serial_sum` check the kernels directly.
- `cargo test --release` (jsbindings) and the diagnostics test pass. `cargo fmt` and clippy `-D warnings` pass for
  jsbindings, pybindings, diagnostics and timing. `npm run typecheck` and the apps/cala vitest suite (1,279
  tests) pass.

## Gate 3: paired qc_eval, v3 static + motion, seeds 5–9

The binaries were built with `--features timing` from `320a43f0` (main) and the branch, and each sim's pair ran side
by side. All runs used 9,600 frames and the shipped app arm (R1 gate flags): `--visit-rate fixed --batch 8
--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --csettle 0.667 --csettle-mode
frames --lookback-drain 0 --settle-frames 9600 --settle-batch 16 --settle-steps 0.0625 --no-signed --no-heldout
--slow-seed 1 --budget 249600000` (`--motion` on motion). Results: `summarize.py` (`summary.md`) and
`demix_report.py` (`demix.md`). Values are paired d = new − base, mean ± 95 % t-CI, n = 5.

The pass rule was fixed before looking: every gated CI covers 0, and recall moves by no more than 0.006.

| metric                      | static base → new | static d       | motion base → new | motion d       |
| --------------------------- | ----------------- | -------------- | ----------------- | -------------- |
| recall R8                   | 0.932 → 0.932     | +0.001 ± 0.002 | 0.917 → 0.918     | +0.001 ± 0.005 |
| precision P8                | 0.989 → 0.990     | +0.000 ± 0.001 | 0.951 → 0.951     | −0.000 ± 0.005 |
| cells                       | 728.4 → 728.6     | +0.2 ± 2.2     | 762.4 → 763.6     | +1.2 ± 2.5     |
| false: noise                | 1.8 → 1.8         | 0.0 ± 0.9      | 0.0 → 0.0         | 0.0 ± 0.0      |
| false: adjacent             | 2.0 → 1.4         | −0.6 ± 1.1     | 13.6 → 13.0       | −0.6 ± 4.4     |
| false: partial              | 1.6 → 1.4         | −0.2 ± 1.0     | 6.4 → 6.0         | −0.4 ± 3.6     |
| false: duplicate            | 0.8 → 1.4         | +0.6 ± 1.1     | 16.2 → 17.8       | +1.6 ± 3.2     |
| footprint r (matched, mean) | 0.992 → 0.992     | −0.000 ± 0.000 | 0.991 → 0.991     | −0.000 ± 0.000 |
| trace r (matched, mean)     | 0.979 → 0.979     | −0.000 ± 0.001 | 0.974 → 0.974     | +0.000 ± 0.001 |

Demixing over the 10 sims (`demix.md`):

- matched +0.3 [−1.1, 1.7], false +0.8 [−0.5, 2.1], net −0.5 [−2.5, 1.5];
- final cells matching 2+ GT units −0.5 [−2.7, 1.7];
- median footprint r with GT 0.9944 → 0.9944;
- bite shares at 0–0.5, 0.5–0.75 and 0.75–1 D: −0.004, +0.008, +0.002, every CI covering 0.

Every footprint, detection, bite and fill metric of the report is "within noise". It flags four rows by its rule (CI
excludes 0 and at least 2/3 of sims agree), all of them cost rows:

- "better": slow loop ms/frame, 7.81 → 7.27;
- "better": slow loop `observe` ms/frame, 1.92 → 1.37;
- "worse": slow loop `step` ms/frame, 5.889 → 5.899, +0.2 %;
- "worse": peak RSS, 1.26 → 1.29 GB, +0.04 [0.01, 0.07].

Leak and trace crosstalk: LEAK_SECTION.

One non-gated difference: on motion, the share of cells whose footprint still changes late (`conv_share4`,
`conv_big4`) is up 0.016 ± 0.013 and 0.013 ± 0.011. On static it is +0.002 ± 0.012 and −0.005 ± 0.009. These are
convergence diagnostics, not detection or demixing metrics. Recall, false cells and footprint r do not move.

### Native slow-loop timing (`stage0/observe_pairs.py`, ms per observe call, ratio new/base ± 95 % CI)

| stage                         | static base → new | ratio         | motion base → new | ratio         |
| ----------------------------- | ----------------- | ------------- | ----------------- | ------------- |
| `slow observe`, pass 1        | 1.905 → 1.338     | 0.702 ± 0.006 | 1.934 → 1.399     | 0.724 ± 0.009 |
| Discover, last chunk: ledger  | 0.548 → 0.183     | 0.336 ± 0.019 | 0.543 → 0.192     | 0.356 ± 0.038 |
| Discover, last chunk: fpstats | 0.588 → 0.180     | 0.307 ± 0.004 | 0.637 → 0.195     | 0.308 ± 0.024 |
| Discover, last chunk: total   | 2.301 → 1.575     | 0.685 ± 0.008 | 2.409 → 1.650     | 0.688 ± 0.050 |
| Final settle: ledger          | 0.460 → 0.194     | 0.422 ± 0.021 | 0.507 → 0.222     | 0.441 ± 0.032 |
| Final settle: fpstats         | 0.619 → 0.230     | 0.372 ± 0.010 | 0.707 → 0.264     | 0.373 ± 0.010 |
| Final settle: clusters        | 0.290 → 0.310     | 1.068 ± 0.032 | 0.361 → 0.391     | 1.079 ± 0.035 |
| Final settle: observe total   | 2.294 → 1.659     | 0.724 ± 0.014 | 2.544 → 1.846     | 0.727 ± 0.017 |
| Final settle: wall per frame  | 11.02 → 10.45     | 0.949 ± 0.010 | 15.14 → 14.45     | 0.955 ± 0.011 |

The cluster stores, which are untouched, read 7–17 % slower. Their stage runs right after the field pass and the new
`(y − model)` field, which is a likely cache effect. They are the B2b step. Natively, the settle wall is bound by the
look-back re-read and solve, so `observe`'s gain is 5 % of it.

## Gate 4: headed Chrome, workshop recording at Max

Setup:

- Chrome 156 on the real GPU, `?debug`, `memory-measure.mjs --single --headed --lookback`, port 5305;
- order M1 (main), D1, D2 (branch), M2;
- WASM md5: main `704071ca`, branch `145f363e`;
- `chrome_run.sh` in the evidence directory.

The machine was shared with other agents' jobs: load averages were 5–10 during the runs (`chrome/drive.log`), so
read the walls as indicative.

| run | build  | Discover s | Discover fps | frames observed | slow busy (Discover) | live observe ms/frame | settle s | settle fps | settle `observe` ms/frame | slow busy (settle) | peak RSS GiB, final / all | cells |
| --- | ------ | ---------: | -----------: | --------------: | -------------------: | --------------------: | -------: | ---------: | ------------------------: | -----------------: | ------------------------: | ----: |
| M1  | main   |        139 |          171 |          76.6 % |                 86 % |                  5.27 |      186 |       96.8 |                      6.65 |               99 % |               4.34 / 5.77 |   796 |
| M2  | main   |        129 |          184 |          78.0 % |                 86 % |                  4.77 |      154 |      116.6 |                      5.46 |               98 % |               4.23 / 5.53 |   804 |
| D1  | branch |        124 |          192 |          78.7 % |                 78 % |                  3.79 |      147 |      122.2 |                      4.75 |               98 % |               4.29 / 5.60 |   772 |
| D2  | branch |        115 |          207 |          78.8 % |                 76 % |                  3.43 |      128 |      140.9 |                      4.05 |               96 % |               4.81 / 5.44 |   767 |

- **`observe` per frame:** the slow worker's live `observe` falls by 0.24–0.28 of main's (5.27/4.77 → 3.79/3.43),
  and the settle's by 0.26–0.29 (6.65/5.46 → 4.75/4.05).
- **Final settle:** 154–186 s → 128–147 s (−5 to −31 % by pairing). The settle stays slow-worker-bound (96–99 %
  busy) and is about 20 % faster at the midpoints.
- **Discover:** 129–139 s → 115–124 s. The slow worker is idle more often (busy 86 % → 76–78 %), but the share of
  frames it observes moves only from 77–78 % to 79 %. Which batches it drops is decided by the fast loop's
  forwarding, not by the slow worker's speed alone.
- **Cells:** 796/804 on main against 772/767 on the branch. Runs at Max are not repeatable: the frames dropped for
  the slow loop and the settle pool's answer order depend on timing. Stage 0 measured 764–791 between main runs,
  and the settle-pool note measured 769–796. With n = 2 per build, this sits within that run-to-run spread. The
  controlled evidence is the paired qc_eval cell count above: +0.2 ± 2.2 on static, +1.2 ± 2.5 on motion. The
  native workshop pair (deterministic) was skipped for time and can settle this if needed.
- **Peak RSS:** within run-to-run noise (4.23–4.81 GiB to the final library). The mean-field state adds about 8
  bytes per disk pixel per cell (f64 `rb` and `hb`, which replace the f32 `r` and half `r`) and 2.9 MB for the
  field. Natively, peak RSS is +0.04 GB [0.01, 0.07] on the sims.

## Not done

- Clusters (B2b) are untouched. They are now the largest of the three statistics stages.
- Native `qc_eval real` on the workshop recording (design gate 3, reported, not gated) was skipped for time.
