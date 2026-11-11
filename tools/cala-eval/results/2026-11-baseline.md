# cala baseline, 11 Nov 2026 (E6)

Reference numbers for the Step 1 PRs. Compare a candidate against `main1x` below (paired, via `summarize.py --base <runs>/x1/base`).

## Provenance

- Binary: `qc_eval` built from `origin/main` **81f041c** (includes full extent #314/#316, freeze #318, hang fix #321, validity mask S1.1 #322, eval harness #319, halo/oof arms #320, label tool #317); `cargo build --release -p calab-cala --example qc_eval`.
- Harness: `tools/cala-eval` at 81f041c (`run_arms.py`, `summarize.py`, `arms.py`). This PR adds `baseline_table.py` (the per-arm table below) and `seed_jaccard.py` (the real-data reproducibility number).
- Run flags: `-- --batch 8 --budget 30000000 --slow-seed 1` (`--motion` is added by `arms.py` for motion, halo, oof). Arms static, motion, halo, oof; seeds 5-9; 1x budget. Plus motion at `--budget-mult 4`.
- Sims: every recording's `spec.json` is byte-identical to what `gen_sims.py` would write (checked by `gen_sims.py --reuse`, nothing regenerated). static/motion seeds 5-7 from `scratchpad/churn/sims`, 8-9 from `scratchpad/e1/sims`; halo/oof from `scratchpad/e3/sims`. Symlinked into `scratchpad/e6/sims`.
- Second reference column `e1base`: the E1 base runs (`scratchpad/e1/runs/base`, harness main 18bffa1, same flags). Its binary predates #322. Static and motion only.
- Runs directories (usable as `--base`), all under `/private/tmp/claude-503/-Users-daharoni-Projects-CaLab/afa6e515-3c3e-4cc7-af38-91dc1bbfaf4b/scratchpad/e6/`: `runs/x1/base` (1x, 20 runs), `runs/x4/base` (motion 4x, 5 runs), `real/seed1`, `real/seed2`; binary `bin/81f041c`.
- Cost: 1x runs 187 s (static), 285 s (motion), 306 s (halo), 328 s (oof) wall, 4 in parallel; 4x motion 735 s; max RSS 1.25 GB per sim run.

Cells are mean +- sample sd over the 5 seeds (n in brackets). The seed spread is large against most effects: the E1 null comparison gave a P8 paired CI half-width of .024 on motion and .013 on static.

## 1x baseline per arm (`main1x` = 81f041c, `e1base` = 18bffa1-era binary)

| arm | metric | main1x | e1base |
| --- | --- | --- | --- |
| halo | P2 | 0.944 +- 0.015 (5) | n/a |
| halo | R2 | 0.501 +- 0.019 (5) | n/a |
| halo | P8 | 0.966 +- 0.010 (5) | n/a |
| halo | R8 | 0.675 +- 0.009 (5) | n/a |
| halo | P8x | 0.966 +- 0.010 (5) | n/a |
| halo | AUC_P | 0.956 +- 0.013 (5) | n/a |
| halo | AUC_R | 0.591 +- 0.011 (5) | n/a |
| halo | slope_P | 0.0020 +- 0.0064 (5) | n/a |
| halo | cells | 441.8 +- 6.1 (5) | n/a |
| halo | fp_noise | 1.2 +- 0.8 (5) | n/a |
| halo | fp_adjacent | 1.4 +- 0.5 (5) | n/a |
| halo | fp_partial | 9.6 +- 4.5 (5) | n/a |
| halo | fp_dup | 2.6 +- 1.1 (5) | n/a |
| halo | fp_nondet | 0.0 +- 0.0 (5) | n/a |
| halo | fp_edge10 | 1.8 +- 1.3 (5) | n/a |
| halo | r_fp | 0.946 +- 0.018 (5) | n/a |
| halo | r_tr | 0.949 +- 0.003 (5) | n/a |
| halo | adds_pm | 14.8 +- 2.2 (5) | n/a |
| halo | deletes_pm | 1.1 +- 0.5 (5) | n/a |
| halo | readds_pm | 2.6 +- 0.8 (5) | n/a |
| motion | P2 | 0.908 +- 0.014 (5) | 0.887 +- 0.013 (5) |
| motion | R2 | 0.539 +- 0.023 (5) | 0.541 +- 0.012 (5) |
| motion | P8 | 0.926 +- 0.013 (5) | 0.900 +- 0.014 (5) |
| motion | R8 | 0.747 +- 0.016 (5) | 0.751 +- 0.014 (5) |
| motion | P8x | 0.926 +- 0.013 (5) | 0.900 +- 0.014 (5) |
| motion | AUC_P | 0.918 +- 0.015 (5) | 0.892 +- 0.012 (5) |
| motion | AUC_R | 0.646 +- 0.013 (5) | 0.646 +- 0.009 (5) |
| motion | slope_P | -0.0023 +- 0.0048 (5) | 0.0010 +- 0.0056 (5) |
| motion | cells | 518.0 +- 14.8 (5) | 535.6 +- 16.1 (5) |
| motion | fp_noise | 5.4 +- 2.8 (5) | 20.6 +- 7.9 (5) |
| motion | fp_adjacent | 7.6 +- 3.6 (5) | 10.8 +- 2.6 (5) |
| motion | fp_partial | 20.0 +- 7.3 (5) | 17.6 +- 3.8 (5) |
| motion | fp_dup | 5.4 +- 1.7 (5) | 4.4 +- 2.7 (5) |
| motion | fp_nondet | 0.0 +- 0.0 (5) | 0.0 +- 0.0 (5) |
| motion | fp_edge10 | 7.0 +- 1.2 (5) | 29.8 +- 13.2 (5) |
| motion | r_fp | 0.943 +- 0.016 (5) | 0.944 +- 0.017 (5) |
| motion | r_tr | 0.961 +- 0.003 (5) | 0.959 +- 0.003 (5) |
| motion | adds_pm | 21.6 +- 2.8 (5) | 25.7 +- 3.7 (5) |
| motion | deletes_pm | 1.1 +- 0.5 (5) | 1.6 +- 0.6 (5) |
| motion | readds_pm | 2.8 +- 1.1 (5) | 3.9 +- 1.3 (5) |
| oof | P2 | 0.911 +- 0.024 (5) | n/a |
| oof | R2 | 0.508 +- 0.010 (5) | n/a |
| oof | P8 | 0.946 +- 0.018 (5) | n/a |
| oof | R8 | 0.690 +- 0.020 (5) | n/a |
| oof | P8x | 0.948 +- 0.018 (5) | n/a |
| oof | AUC_P | 0.931 +- 0.020 (5) | n/a |
| oof | AUC_R | 0.604 +- 0.009 (5) | n/a |
| oof | slope_P | 0.0030 +- 0.0068 (5) | n/a |
| oof | cells | 463.6 +- 18.2 (5) | n/a |
| oof | fp_noise | 1.0 +- 1.0 (5) | n/a |
| oof | fp_adjacent | 1.6 +- 1.1 (5) | n/a |
| oof | fp_partial | 18.6 +- 9.0 (5) | n/a |
| oof | fp_dup | 3.0 +- 1.9 (5) | n/a |
| oof | fp_nondet | 0.8 +- 0.8 (5) | n/a |
| oof | fp_edge10 | 3.0 +- 1.9 (5) | n/a |
| oof | r_fp | 0.934 +- 0.021 (5) | n/a |
| oof | r_tr | 0.950 +- 0.003 (5) | n/a |
| oof | adds_pm | 17.6 +- 2.1 (5) | n/a |
| oof | deletes_pm | 1.6 +- 0.5 (5) | n/a |
| oof | readds_pm | 2.6 +- 1.0 (5) | n/a |
| static | P2 | 0.934 +- 0.011 (5) | 0.934 +- 0.011 (5) |
| static | R2 | 0.582 +- 0.007 (5) | 0.582 +- 0.007 (5) |
| static | P8 | 0.953 +- 0.015 (5) | 0.953 +- 0.015 (5) |
| static | R8 | 0.781 +- 0.011 (5) | 0.781 +- 0.011 (5) |
| static | P8x | 0.953 +- 0.015 (5) | 0.953 +- 0.015 (5) |
| static | AUC_P | 0.944 +- 0.009 (5) | 0.944 +- 0.009 (5) |
| static | AUC_R | 0.684 +- 0.010 (5) | 0.684 +- 0.010 (5) |
| static | slope_P | 0.0006 +- 0.0021 (5) | 0.0006 +- 0.0021 (5) |
| static | cells | 501.2 +- 10.2 (5) | 501.2 +- 10.2 (5) |
| static | fp_noise | 7.2 +- 3.3 (5) | 7.2 +- 3.3 (5) |
| static | fp_adjacent | 4.0 +- 2.5 (5) | 4.0 +- 2.5 (5) |
| static | fp_partial | 11.4 +- 3.0 (5) | 11.4 +- 3.0 (5) |
| static | fp_dup | 1.0 +- 1.0 (5) | 1.0 +- 1.0 (5) |
| static | fp_nondet | 0.0 +- 0.0 (5) | 0.0 +- 0.0 (5) |
| static | fp_edge10 | 6.6 +- 3.6 (5) | 6.6 +- 3.6 (5) |
| static | r_fp | 0.973 +- 0.003 (5) | 0.973 +- 0.003 (5) |
| static | r_tr | 0.968 +- 0.002 (5) | 0.968 +- 0.002 (5) |
| static | adds_pm | 20.9 +- 2.7 (5) | 20.9 +- 2.7 (5) |
| static | deletes_pm | 1.4 +- 0.1 (5) | 1.4 +- 0.1 (5) |
| static | readds_pm | 4.2 +- 0.4 (5) | 4.2 +- 0.4 (5) |

FP classes are final-library counts (`fp_noise`, `fp_adjacent`, `fp_partial`, `fp_dup`, `fp_nondet`; definitions in the README). `fp_edge10` counts non-TP cells within 10 px of the sensor-mask edge (it overlaps the classes).

### What moved between e1base and main (5 paired seeds, P8 primary)

Static is bit-identical (every metric): the validity mask (#322) does not change a recording without motion. Motion changed:

| arm | metric | base | new | d (mean +- CI) | n | signs +/-/0 | binSE | claim |
| motion | P2 | 0.887 | 0.908 | 0.021 +- 0.027 | 5 | 5/0/0 | 0.014 |  |
| motion | R2 | 0.541 | 0.539 | -0.002 +- 0.023 | 5 | 3/2/0 |  |  |
| motion | **P8** | 0.900 | 0.926 | 0.025 +- 0.021 | 5 | 5/0/0 | 0.013 | EXCLUDES 0 |
| motion | R8 | 0.751 | 0.747 | -0.004 +- 0.020 | 5 | 2/2/1 |  |  |
| motion | P8x | 0.900 | 0.926 | 0.025 +- 0.021 | 5 | 5/0/0 | 0.013 |  |
| motion | AUC_P | 0.892 | 0.918 | 0.026 +- 0.023 | 5 | 5/0/0 | 0.013 |  |
| motion | AUC_R | 0.646 | 0.646 | 0.000 +- 0.014 | 5 | 2/3/0 |  |  |
| motion | slope_P | 0.0010 | -0.0023 | -0.0033 +- 0.0068 | 5 | 2/3/0 |  |  |
| motion | cells | 535.6 | 518.0 | -17.6 +- 4.8 | 5 | 0/5/0 |  |  |
| motion | fp_noise | 20.6 | 5.4 | -15.2 +- 6.8 | 5 | 0/5/0 |  |  |
| motion | fp_adjacent | 10.8 | 7.6 | -3.2 +- 3.9 | 5 | 1/4/0 |  |  |
| motion | fp_partial | 17.6 | 20.0 | 2.4 +- 7.2 | 5 | 3/1/1 |  |  |
| motion | fp_dup | 4.4 | 5.4 | 1.0 +- 4.6 | 5 | 2/2/1 |  |  |
| motion | fp_nondet | 0.0 | 0.0 | 0.0 +- 0.0 | 5 | 0/0/5 |  |  |
| motion | fp_edge10 | 29.8 | 7.0 | -22.8 +- 16.6 | 5 | 0/5/0 |  |  |
| motion | r_fp | 0.944 | 0.943 | -0.001 +- 0.003 | 5 | 2/3/0 |  |  |
| motion | r_tr | 0.959 | 0.961 | 0.002 +- 0.002 | 5 | 5/0/0 |  |  |
| motion | adds_pm | 25.7 | 21.6 | -4.0 +- 4.6 | 5 | 1/4/0 |  |  |
| motion | deletes_pm | 1.6 | 1.1 | -0.5 +- 1.1 | 5 | 1/3/1 |  |  |
| motion | readds_pm | 3.9 | 2.8 | -1.1 +- 2.7 | 5 | 1/4/0 |  |  |

P8 on motion +0.025 +- 0.021 (5/0/0 seeds, CI excludes 0), `fp_noise` 20.6 -> 5.4 and `fp_edge10` 29.8 -> 7.0, for about 17 fewer cells (R8 -0.004, inside noise). This is S1.1's effect and is already in the baseline: the edge10 count on motion is now 7.0, so S1.1's "FP_edge10 <= 10 % of base" criterion has to be read against a different base.

## Motion at 4x budget (compute-vs-precision curve)

| arm | metric | main1x | main4x |
| --- | --- | --- | --- |
| motion | P2 | 0.908 +- 0.014 (5) | 0.876 +- 0.024 (5) |
| motion | R2 | 0.539 +- 0.023 (5) | 0.637 +- 0.017 (5) |
| motion | P8 | 0.926 +- 0.013 (5) | 0.880 +- 0.020 (5) |
| motion | R8 | 0.747 +- 0.016 (5) | 0.806 +- 0.010 (5) |
| motion | P8x | 0.926 +- 0.013 (5) | 0.880 +- 0.020 (5) |
| motion | AUC_P | 0.918 +- 0.015 (5) | 0.876 +- 0.015 (5) |
| motion | AUC_R | 0.646 +- 0.013 (5) | 0.731 +- 0.013 (5) |
| motion | slope_P | -0.0023 +- 0.0048 (5) | 0.0022 +- 0.0056 (5) |
| motion | cells | 518.0 +- 14.8 (5) | 588.0 +- 13.9 (5) |
| motion | fp_noise | 5.4 +- 2.8 (5) | 17.0 +- 6.8 (5) |
| motion | fp_adjacent | 7.6 +- 3.6 (5) | 21.8 +- 3.7 (5) |
| motion | fp_partial | 20.0 +- 7.3 (5) | 14.0 +- 3.9 (5) |
| motion | fp_dup | 5.4 +- 1.7 (5) | 17.6 +- 5.0 (5) |
| motion | fp_nondet | 0.0 +- 0.0 (5) | 0.0 +- 0.0 (5) |
| motion | fp_edge10 | 7.0 +- 1.2 (5) | 12.0 +- 3.7 (5) |
| motion | r_fp | 0.943 +- 0.016 (5) | 0.950 +- 0.016 (5) |
| motion | r_tr | 0.961 +- 0.003 (5) | 0.953 +- 0.004 (5) |
| motion | adds_pm | 21.6 +- 2.8 (5) | 25.9 +- 2.8 (5) |
| motion | deletes_pm | 1.1 +- 0.5 (5) | 1.6 +- 0.6 (5) |
| motion | readds_pm | 2.8 +- 1.1 (5) | 6.3 +- 1.2 (5) |

More compute still buys recall (R8 .747 -> .806, AUC_R +.085) and costs precision (P8 .926 -> .880, `fp_dup` 5 -> 18, `fp_adjacent` 8 -> 22, `fp_noise` 5 -> 17): the pre-B1 shape survives the freeze and the mask. The P8 drop of .046 is more than twice the seed sd.

## Real data: workshop recording, 18000 frames, motion, 2 slow seeds

`qc_eval real <workshop raw> <out> --motion --frames 18000 --no-pass2 --checkpoints 15 --batch 8 --budget 30000000 --slow-seed S` (recipe of `fullextent-diag3/real.sh` without `--dump`), binary 81f041c. About 560 s and 1.05 GB per run, two at once.

| slow seed | cells at 18000 | explained | residual | snr median | adds/min |
| --- | --- | --- | --- | --- | --- |
| 1 | 719 | 0.816 | 2.148 | 13.0 | 24 |
| 2 | 709 | 0.800 | 2.331 | 12.3 | 26 |

Seed-to-seed reproducibility of the final library (`seed_jaccard.py`: one-to-one greedy matching on the cosine of unfiltered footprints, candidates within 12 px, a pair counts if cosine >= threshold; Jaccard = matched / (nA + nB - matched)):

| cosine threshold | matched | Jaccard | share of A / B matched | median cosine of matches |
| --- | --- | --- | --- | --- |
| 0.5 | 555 | **0.634** | 0.772 / 0.781 | 0.918 |
| 0.7 | 490 | 0.521 | 0.682 / 0.689 | 0.933 |

About a quarter of either seed's cells have no partner in the other seed at cosine 0.5. A Step 1 change that removes non-reproducible cells should raise this Jaccard without lowering the explained fraction. There is no ground truth here: this is agreement, not precision. `cells.tsv` carries no `edge_px` on real data (no sensor-mask edge is recorded), so S1.1's real-data edge count cannot be read from these runs; only 1 and 2 centroids lie within 10 px of the image border, which is not the swept mask edge under motion.

## Harness notes

- `run_arms.py` counts a light run only if the binary path contains `qc_eval` or `/cala-eval/bin/`. A binary kept elsewhere (here `scratchpad/e6/bin/81f041c`, and other agents' `s12/bin/...`) is invisible to every queue's cap, so more than 4 light runs can run at once without any queue noticing. Keep binaries under `tools/cala-eval/bin/` (gitignored) or put `qc_eval` in the file name.
- Other agents' queues shared the 4 slots, so the 25 sim runs took about 1.5 h of wall clock instead of about 35 min.
