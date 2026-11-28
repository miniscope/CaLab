# Mean-field cluster stores (D1 part B): same estimator, rounding-level change

28 Nov 2026. Branch `perf/cala-mean-field-clusters` (on main `5eb74ae3`, after part A, #562). Design: stage-1
slow-worker note §4.5 (B2b, clusters). The PI accepted D1 as a rounding-level (not bitwise) change. Raw data,
scripts and logs: `~/Projects/cala-data/runs/d1b-clusters/` (`b0/`, `rate/`, `runs/`, `chrome/`, `scripts/`,
`GATE1-THRESHOLD.md`).

## Verdict

**All four gates pass.** The cluster push is 2.1–2.8x faster in the micro-benchmark at the measured column-change
rate. Natively, the cluster stage takes 0.48–0.60 of main's time and `observe` 8–12 % less. Detection, footprints,
traces and demixing on the v3 sims are unchanged within noise: every gated paired CI covers 0. In headed Chrome on the
workshop recording the slow worker's `observe` falls by 6–8 % in Discover and the Final settle; the stage walls do
not move beyond run-to-run spread (n = 2).

## What changed

- `ClusterStore::push_mean` (`crates/cala/src/discover/cluster.rs`) replaces the per-frame push of the slow loop.
  With `d = y − model` (the loop's shared residual from part A), the ring level `lv`, the members' columns `a` and
  whitening `is`, the store's residual is `r̃ = is·(d − lv_owner + Σ_l a_l c_l)`. Per frame the store now:
  - adds `w d` per pixel and `w c_k d` for each member with a non-zero trace (`Pending`);
  - adds the level and own-signal parts as `K` and `K x K` scalars;
  - projects `d` on `uis_j = u_j·is` (eight-lane dot) and adds the level and own-signal terms of the history
    coordinates from scalars (`Proj`, rebuilt when the basis changes).
- It no longer builds `r̃`: no per-pixel column adds, whitening pass or separate `Σ w r̃` pass.
- When one member's column changes, only that member's own-signal scalars are folded into `cy` and `sr` (K+1
  passes over the pixels), and only its projection term is recomputed. The `d` and level sums need no fold.
- Readers (`cy_basis` for the basis refresh and `move_to`, the job encoding) read the folded sums. The wire format,
  `ClusterOut` and `VisitRunner` are unchanged; a runner's copy is folded when it is encoded.
- A store that moves folds everything first. A frame with a missing sample on the store, a non-finite trace or a
  non-finite level of a member that owns a pixel is skipped, as before.
- The plain push (`push_frame`) stays under `test` and `timing` as the reference and the benchmark's old arm.
- Work counters are unchanged. Deterministic: one fixed summation order, no timing-dependent path.

## Gate 1: micro-benchmark (native, release)

`examples/fpstats_bench.rs --clusters` (`discover::bench::cluster_bench`, `--features timing`). Clusters are
formed from each run's final library as the slow loop does (normalised footprint overlaps, `ρ ≥ 0.05`, at most
6 members, here on unfiltered footprints at unit whitening), each on the union of its members' statistics disks,
with ring levels. Traces are zero on each cell's `zero_frac` share. 600 fitting frames, median of 3 repeats. The
residual pass is not charged to the new arm, because main already computes it for the ledger and fpstats.

The threshold was set before measuring (`GATE1-THRESHOLD.md`): **GO at ≥ 1.5x on the workshop shapes.** The
first draft folded every pending sum at each column change. It gave 0.43x with a column change every 8 frames
(the proxy first written into the gate), 1.67x at every 100: the push alone was about 2.2x, but one column change
cost about 34 pushes. Before revising, the gate was amended to use the measured rate instead of the proxy.

Measured rates (temporary counters, shipped-app flags, 9,600 frames):

| sim          | cluster pushes | column-change events | basis changes (upper bound) | mean K | mean pixels | mean rank |
| ------------ | -------------: | -------------------: | --------------------------: | -----: | ----------: | --------: |
| v3_static_s5 |          3.0 M |  1,430 (1 per 2,100) |           4,053 (1 per 740) |   2.43 |       1,259 |      2.43 |
| v3_motion_s5 |          3.2 M |  1,594 (1 per 2,000) |           4,175 (1 per 770) |   2.57 |       1,290 |      2.57 |

Look-back frames flip columns rarely (54 and 39 events). The revised kernel (per-member fold) was benchmarked
once with every member of every cluster taking new columns every 500 frames, counting basis changes as column
changes (conservative). Output: `b0/b0.txt`.

| shapes                                       | clusters | members | pixels | rank | column change every | old → new ms/frame | speed-up |
| -------------------------------------------- | -------: | ------: | -----: | ---: | ------------------: | ------------------ | -------: |
| workshop final library (Stage 0 `ws_timing`) |      170 |     875 |  4,139 | 5.15 |                 500 | 1.553 → 0.740      | **2.10** |
| workshop final library                       |      170 |     875 |  4,139 | 5.15 |                 100 | 1.504 → 0.758      |     1.98 |
| workshop final library                       |      170 |     875 |  4,139 | 5.15 |                   8 | 1.593 → 1.283      |     1.24 |
| v3_static_s5                                 |      154 |     431 |  1,826 | 2.80 |                 500 | 0.492 → 0.213      |     2.31 |
| v3_motion_s5                                 |      162 |     500 |  1,908 | 3.09 |                 500 | 0.709 → 0.256      |     2.76 |

- **2.10x ≥ 1.5x: GO.**
- The arms' `cy`, `sr` and stored coordinates agree to 1.5e-6 of each array's largest value.
- The benchmark's clusters are larger than the loop's (K 5.2 against 2.4–2.6 measured), because they are formed on
  unfiltered footprints.

## Gate 2: unit tests and checks

- `cluster::push_frame_tests::push_mean_matches_the_plain_push`: a plain and a mean-field store side by side over
  900 frames, with and without ring levels. It covers new columns (and unchanged ones), a rescale, a moved store,
  zero and NaN traces, a NaN level on an owning member (skipped) and on a non-owning one (not skipped), and a
  missing sample. `cy`, `sr` and the stored coordinates stay within 1e-5 of the largest value. A replay agrees to
  1e-4, and the store with pending sums round-trips through the job encoding exactly.
- `tests::mean_field_cluster_stores_match_the_plain_push`: two `SlowLoop`s (one forced plain) with two clusters,
  live frames interleaved with look-back frames on another library, look-back pushes to a subset, missing samples
  on a cluster, rescales and a new live library. Every store's sums stay within 1e-5.
- The existing round-trip, replay-on-a-copy and push-frame tests pass unchanged.
- `cargo fmt --check`; clippy `-D warnings` for jsbindings, pybindings, diagnostics and timing;
  `cargo test --release` (jsbindings) and the diagnostics test; `npm run typecheck`; apps/cala vitest (1,312 tests): all pass.

## Gate 3: paired qc_eval, v3 static + motion, seeds 5–9

Binaries were built with `--features timing` from `5eb74ae3` (main) and the branch, and each sim's pair ran side
by side. All runs used 9,600 frames, `--dump`, and part A's shipped-app arm: `--visit-rate fixed --batch 8
--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --csettle 0.667 --csettle-mode
frames --lookback-drain 0 --settle-frames 9600 --settle-batch 16 --settle-steps 0.0625 --no-signed --no-heldout
--slow-seed 1 --budget 249600000` (`--motion` on motion). Results: `summarize.py` (`summary.md`) and
`demix_report.py` (`demix.md`). Values are paired d = new − base, mean ± 95 % t-CI, n = 5.

The pass rule was part A's, fixed before looking: every gated CI covers 0 and recall moves by no more than 0.006.

| metric                      | static base → new | static d       | motion base → new | motion d       |
| --------------------------- | ----------------- | -------------- | ----------------- | -------------- |
| recall R8                   | 0.932 → 0.931     | −0.001 ± 0.001 | 0.918 → 0.920     | +0.003 ± 0.005 |
| precision P8                | 0.990 → 0.990     | +0.000 ± 0.002 | 0.951 → 0.954     | +0.003 ± 0.006 |
| cells                       | 728.6 → 727.8     | −0.8 ± 2.4     | 763.6 → 763.2     | −0.4 ± 6.8     |
| false: noise                | 1.8 → 1.6         | −0.2 ± 0.6     | 0.0 → 0.2         | +0.2 ± 0.6     |
| false: adjacent             | 1.4 → 1.2         | −0.2 ± 0.6     | 13.0 → 12.2       | −0.8 ± 3.9     |
| false: partial              | 1.4 → 1.6         | +0.2 ± 0.6     | 6.0 → 5.0         | −1.0 ± 1.5     |
| false: duplicate            | 1.4 → 1.4         | 0.0 ± 0.0      | 17.8 → 17.0       | −0.8 ± 1.8     |
| footprint r (matched, mean) | 0.992 → 0.992     | 0.000 ± 0.000  | 0.991 → 0.991     | 0.000 ± 0.000  |
| trace r (matched, mean)     | 0.979 → 0.979     | 0.000 ± 0.000  | 0.974 → 0.974     | −0.000 ± 0.001 |

Demixing over the 10 sims (`demix.md`), 61 of 67 metrics within noise:

- matched +0.4 [−0.7, 1.5], false −1.0 [−3.0, 1.0], net +1.4 [−0.4, 3.2];
- final cells matching 2+ GT units +1.3 [−0.3, 2.9];
- median footprint r with GT 0.9944 → 0.9944;
- trace-correlation excess < 1 D (headline) +0.001 [−0.005, +0.006];
- `leak_sd` median < 1 D −0.0003 [−0.0020, 0.0014]; share > 0.1 +0.003 [−0.013, 0.021];
- every bite-share row covers 0.

The report flags only cost rows: "better" for QC ms/frame, slow-loop ms/frame (7.97 → 7.86) and `observe` ms/frame
(1.58 → 1.44); "worse" for slow-loop `step` ms/frame (6.392 → 6.415, +0.4 %) and cluster-store peak memory
(28.4 → 33.4 MB: the pending per-pixel sums and the whitened basis).

### Native slow-loop timing (`stage0/observe_pairs.py`, ms per observe call, ratio new/base ± 95 % CI)

| stage                          | static base → new | ratio         | motion base → new | ratio         |
| ------------------------------ | ----------------- | ------------- | ----------------- | ------------- |
| `slow observe`, pass 1         | 1.485 → 1.364     | 0.918 ± 0.005 | 1.679 → 1.521     | 0.907 ± 0.012 |
| Discover, last chunk: clusters | 0.308 → 0.149     | 0.483 ± 0.021 | 0.428 → 0.207     | 0.487 ± 0.030 |
| Discover, last chunk: total    | 1.641 → 1.476     | 0.900 ± 0.014 | 1.996 → 1.763     | 0.885 ± 0.023 |
| Final settle: clusters         | 0.329 → 0.198     | 0.601 ± 0.011 | 0.469 → 0.278     | 0.595 ± 0.024 |
| Final settle: observe total    | 1.743 → 1.606     | 0.921 ± 0.006 | 2.097 → 1.910     | 0.912 ± 0.008 |
| Final settle: wall per frame   | 10.85 → 10.71     | 0.987 ± 0.003 | 15.59 → 15.48     | 0.993 ± 0.011 |

Ledger and fpstats do not move (ratios 0.98–1.01). The settle wall is bound by the look-back re-read and solve, so
`observe`'s gain is about 1 % of it.

## Gate 4: headed Chrome, workshop recording at Max

Setup:

- Chrome on the real GPU, `?debug`, `memory-measure.mjs --single --headed --lookback`, port 5305;
- order M1 (main), D1 (branch), then D2, M2 about 30 min later (the first try of D2 and M2 was refused while
  another job ran on the machine);
- WASM md5: main `f501085b`, branch `6d0b9ef4`;
- `chrome_run.sh` and `gate4.sh` in the evidence directory; duty tables `chrome/*-duty.md`
  (`stage0/duty_tables.py`), summary `chrome-summary.md`.

| run | build  | Discover s | Discover fps | live `observe` ms/frame | slow busy (Discover) | settle s | settle fps | settle `observe` ms/frame | slow busy (settle) | peak RSS GiB | cells |
| --- | ------ | ---------: | -----------: | ----------------------: | -------------------: | -------: | ---------: | ------------------------: | -----------------: | -----------: | ----: |
| M1  | main   |        115 |          206 |                   3.465 |               76.2 % |      127 |      141.1 |                     4.029 |             94.9 % |         4.24 |   774 |
| M2  | main   |        117 |          202 |                   3.448 |               75.1 % |      129 |      139.8 |                     4.077 |             96.2 % |         4.27 |   781 |
| D1  | branch |        118 |          201 |                   3.233 |               71.9 % |      135 |      132.8 |                     3.860 |             91.1 % |         4.32 |   797 |
| D2  | branch |        116 |          205 |                   3.175 |               71.6 % |      130 |      138.1 |                     3.732 |             92.8 % |         4.36 |   765 |

- **`observe` per frame:** live 3.45–3.47 → 3.18–3.23 ms (−7 %), settle 4.03–4.08 → 3.73–3.86 ms (−5 to −8 %).
  The slow worker is busy less: 75–76 % → 72 % in Discover, 95–96 % → 91–93 % in the settle.
- **Walls:** Discover 115–117 s → 116–118 s; Final settle 127–129 s → 130–135 s. These are within the run-to-run
  spread at Max (part A measured 154–186 s between two main runs) and do not show a gain. The settle is not purely
  `observe`-bound: at 91–93 % busy, the look-back re-read and solve set its pace.
- **Cells:** 774/781 on main against 797/765 on the branch, within the run-to-run spread at Max (Stage 0:
  764–791). The controlled count is the paired qc_eval one above.
- **Peak RSS:** 4.24–4.27 → 4.32–4.36 GiB. Each store adds f32 pending sums (`Σ w d` and one `Σ w c_k d`
  per member) and the whitened basis per pixel: cluster-store peak +5 MB natively on the sims.

## Not done

- Native `qc_eval real` on the workshop recording was not run.
