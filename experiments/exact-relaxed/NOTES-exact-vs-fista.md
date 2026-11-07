# Exact (Ipm) vs shipped early-stopped FISTA: full sweep and mechanism (6 Nov 2026)

Branch `exp/exact-vs-fista` (from `exp/fast-relaxed` 0ed94ae). Local only. Harness:
`crates/solver/src/eval_exact_vs_fista.rs` (ignored tests `eval_evf_sweep`, `eval_evf_floor`, `eval_evf_kernel`; dataset
generator and F1 copied from `exp/auto-cap`). Raw CSVs and analysis in `experiments/exact-vs-fista/`
(`sweep.csv`, `floor.csv`, `floor23.csv`, `kernel.csv`, `analyze.py`, `analyze_extra.py`, `analysis*.txt`).
Test-only hooks added to the solver (no shipped behavior changes): `SolveConfig.x_hook` (edit relaxed masses before
binarization) and `event_mass::FLOOR_MODE` (counterfactual spike-size floor / fallback).

## Setup
- 42 datasets = regime {markov, markovlow, poisson} x preset {jgcamp8f, gcamp6s} x fs {30 (3 seeds), 60 (2), 10 (2)};
  the brief said 36, the `exp/auto-cap` branch actually ran 30; I ran all 42 combinations. 175 cells each (SNR 3,5,8,12,20,35,50 x 25), 300 s,
  true kernel, max firing rate 300 Hz, 7350 cells, every cell solved with Fista (shipped) and Ipm.
- F1 +-2 frames (greedy one-to-one, as auto-cap). Count ratio = sum(estimated) / sum(true) over the group (not a median).
- Bands: lo = SNR 3-5, mid = 8-12, hi = 20-50.
- Times are per-solve wall ms measured inside 16 worker threads (contended; use for ratios).

## 1. Pooled results (regime x preset x fs)
| regime | preset | fs | count ratio Fista | Ipm | F1 Fista | Ipm | dF1 | exact-train match |
|---|---|---|---|---|---|---|---|---|
| markov | gcamp6s | 10 | .552 | .533 | .408 | .410 | +.002 | 0.3% |
| markov | gcamp6s | 30 | .550 | .500 | .485 | .468 | **-.017** | 0% |
| markov | gcamp6s | 60 | .407 | .328 | .334 | .292 | **-.042** | 0% |
| markov | jgcamp8f | 10 | 2.174 | 2.176 | .429 | .430 | +.001 | 13% |
| markov | jgcamp8f | 30 | 1.594 | 1.616 | .552 | .552 | .000 | 0% |
| markov | jgcamp8f | 60 | .883 | .890 | .596 | .597 | +.002 | 0% |
| markovlow | gcamp6s | 10 | 1.680 | 1.679 | .460 | .460 | .000 | 0% |
| markovlow | gcamp6s | 30 | 1.527 | 1.432 | .391 | .399 | +.008 | 0% |
| markovlow | gcamp6s | 60 | 1.119 | .954 | .323 | .326 | +.003 | 0% |
| markovlow | jgcamp8f | 10 | 5.920 | 5.942 | .284 | .283 | -.001 | 9% |
| markovlow | jgcamp8f | 30 | 4.219 | 4.257 | .384 | .381 | -.003 | 0% |
| markovlow | jgcamp8f | 60 | 2.454 | 2.478 | .533 | .529 | -.004 | 0% |
| poisson | gcamp6s | 10 | 1.944 | 1.911 | .470 | .475 | +.005 | 8% |
| poisson | gcamp6s | 30 | 1.847 | 1.814 | .303 | .302 | -.001 | 0.6% |
| poisson | gcamp6s | 60 | 1.355 | 1.301 | .247 | .247 | .000 | 0.9% |
| poisson | jgcamp8f | 10 | 10.22 | 10.28 | .199 | .199 | -.001 | 6% |
| poisson | jgcamp8f | 30 | 6.079 | 6.080 | .307 | .307 | +.001 | 6% |
| poisson | jgcamp8f | 60 | 3.375 | 3.410 | .478 | .474 | -.004 | 7% |

Per-dataset table: `experiments/exact-vs-fista/analysis.txt`. Take-away: the only material F1 loss is **slow kernel (gcamp6s),
burst firing (markov), fs >= 30 Hz**; fast kernels are unchanged to within +-.004. Counts drop 5-20% on gcamp6s at 30/60 Hz in every regime
but only markov (undercounting regime, ratio .4-.55) turns that into an F1 loss; where the pipeline overcounts (markovlow, poisson) fewer
spikes is neutral or slightly better (+.008). Train identity is ~0% at 30/60 Hz: the exact optimum is a different train everywhere,
but at 10 Hz and for fast kernels with few events it often is the same.

### SNR-band breakdown where they differ (gcamp6s, markov)
| fs | band | count ratio F | I | F1 F | I | dF1 |
|---|---|---|---|---|---|---|
| 30 | lo | .297 | .291 | .237 | .233 | -.004 |
| 30 | mid | .577 | .498 | .512 | .480 | **-.032** |
| 30 | hi | .702 | .643 | .633 | .617 | -.016 |
All regimes pooled, gcamp6s 60 Hz: lo -.017, mid -.019, hi -.006 (count ratio .67/.82/.76 -> .53/.69/.73). 30 Hz pooled: -.005/-.005/-.001.
jgcamp8f: |dF1| <= .004 in every band at every rate.

## 2. Diagnosis (where the F1/count change comes from)

### (a) Event segmentation: not the mechanism
Events = maximal runs of positive relaxed mass. Event counts per cell are within a few percent (gcamp6s 30 Hz mid: 136.7 Fista vs 138.9 Ipm;
live events with round(m/a_pick)>=1: 113.9 vs 113.3). Ipm events are shorter (mean live length 4.16 vs 4.52 frames at 30 Hz mid, 8.76 vs 9.33
at 60 Hz mid) and carry fewer positive frames (311 vs 366 at 30 Hz lo), and peakier (sum of event peaks / mass .461 vs .389 at 30 Hz mid-band
markov; .611 vs .465 at 60 Hz lo). Decisive test: count the Ipm events at the Fista spike size (event-mass count, placement ignored):
`I@aF / F` = 1.000 in every one of the gcamp6s bands (0.998-1.000 at 60 Hz) while the real `I / F` is .72-.98. Segmentation plus event masses
(total mass ratio I/F = 1.000) give the same number of spikes at equal spike size; the entire count change is the spike size.

### (b) False-positive and missed spikes
Spikes > 2 frames from any true spike per true spike (off) and true spikes with no estimate within 2 frames (miss), gcamp6s, pooled regimes:
| fs | band | off F | off I | miss F | miss I |
|---|---|---|---|---|---|
| 30 | lo | .298 | .295 | .596 | .608 |
| 30 | mid | .363 | .333 | .390 | .398 |
| 30 | hi | .309 | .296 | .321 | .324 |
| 60 | lo | .414 | .331 | .692 | .715 |
| 60 | mid | .420 | .360 | .517 | .533 |
| 60 | hi | .379 | .362 | .490 | .495 |
Ipm makes FEWER off-event spikes and slightly more misses. The exact optimum does not add noise spikes; it loses recall.

### (c) Spike-size pick: the mechanism
`a_floor = frame_max / cap` (the largest single frame of the relaxed solution holds exactly `cap` spikes). On slow kernels at >= 30 Hz the pick
is mostly the floor already (gcamp6s 30 Hz markov mid/hi: `cap_limited` 44%/83% Fista), and the exact optimum is peakier, so its largest frame
is larger: median `frame_max` ratio I/F = 1.46 (lo), 1.35 (mid), 1.07 (hi) at 30 Hz, 1.51/1.32/1.04 at 60 Hz; median `a_pick` ratio I/F 1.00/1.14/1.05 at 30 Hz,
1.34/1.27/1.04 at 60 Hz. Cap-limited and no-size-fit shares rise (30 Hz markov: cap_limited lo/mid/hi 4/44/83% -> 24/73/87%; no_size_fit 2/23/71% -> 13/53/75%;
median a/floor 2.1/1.2/1.0 -> 1.4/1.0/1.0). Per-cell correlations (gcamp6s 30 Hz): corr(dCount/true, log a ratio) = -0.88; corr(dF1, log a ratio) +0.18
(F1 loss is real but modest per cell; pooled it is the undercount in the markov regime). Fast kernels: `a_I/a_F` = 0.97-1.00, nothing moves.
So an extreme statistic of the relaxed solution (one frame) sets the cap-limited size, and early-stopped FISTA's smoother iterate
happened to give a smaller `frame_max`, hence a smaller `a`, hence more spikes in a regime where the pipeline undercounts.

### (d) Sub-threshold crumbs: not the mechanism
Mass in events whose rounded count is 0 (gcamp6s 30 Hz, pooled): 2.8 / 1.0 / 0.9% of mass (lo/mid/hi) Fista vs 3.0 / 1.3 / 1.0% Ipm; at 60 Hz 2.3/1.6/1.9 vs 3.8/2.5/2.2.
Tiny positive frames (< 0.05 a_pick) are FEWER with Ipm (4.5% vs 10.9% of positive frames at 30 Hz lo; 4.4% vs 6.9% mid): the exact solve has more exact zeros.
Counterfactuals on the Ipm relaxed masses (`x_hook`, all cells; Ipm F1 / Ipm with edit), gcamp6s 30 Hz mid: zero frames < 1% of frame_max: .397 -> .398 (no change; the crumbs are not
carrying anything), < 5%: .391, zero events < 5% of the largest event: .360 (removes real mass). Nothing recovers Fista's .402.

### Counterfactual floors (Ipm, same cells; `floor.csv`, `floor23.csv`)
Mode 1 floor = `max_e m_e / (cap * len_e)` (every event fits its own span at `cap` spikes per frame; the placement already spills overflow to
neighbouring frames of the span). Mode 2 = mode 1 plus "if no size is within one SE, take the best-fitting size on the grid instead of the floor".
Mode 3 = shipped floor with the best-fitting-size fallback only.
| config | F1 Fista(0) | Ipm(0) | Ipm mode 1 | Ipm mode 2 | Ipm mode 3 |
|---|---|---|---|---|---|
| gcamp6s markov 30 Hz | .485 | .468 | .487 | .483 | .451 |
| gcamp6s markov 60 Hz | .334 | .292 | .371 | .355 | .278 |
| gcamp6s markovlow 30 Hz | .391 | .399 | .352 | .368 | .412 |
| gcamp6s poisson 30 Hz | .303 | .302 | .296 | .304 | .313 |
| jgcamp8f markov 30 Hz | .552 | .552 | .467 | .479 | .552 |
| jgcamp8f markov 60 Hz | .596 | .597 | .569 | .569 | .597 |
| jgcamp8f markovlow 60 Hz | .533 | .529 | .389 | .396 | .591 |
| jgcamp8f poisson 60 Hz | .478 | .474 | .400 | .563 | .675 |
Pooled over regimes (F1): gcamp6s 30 Hz .393 / .390 / .379 / .385 / .392; gcamp6s 60 Hz .301 / .288 / .300 / .300 / .285; jgcamp8f 30 Hz .414 / .414 / .327 / .351 / .438;
jgcamp8f 60 Hz .536 / .534 / .453 / .509 / .621.
Reading: the event-span floor (mode 1) restores gcamp6s-markov (the exact regime that lost) and beats Fista at 60 Hz, but lowers the size on every cell, so it overcounts the already
overcounted regimes (jgcamp8f, markovlow) and loses .05-.15 there. The best-fit fallback (mode 3) is a free gain exactly where the pipeline overcounts (jgcamp8f 60 Hz +.085 pooled,
poisson +.20) and neutral elsewhere, but does nothing for gcamp6s markov. Neither is a drop-in fix and both are single-sweep counterfactuals on the true kernel, not tuned.

## 3. Kernel-estimation loop (estimated kernel, app-equivalent)
Harness `eval_evf_kernel`: peak-seed phase on subset crops, then K=4 non-overlapping subsets at 25% coverage (tile + LCG as `subset-store.ts`), per-iteration
trace solve (Fista or Ipm) on every subset cell, free kernel (200 FISTA its, tol 1e-4) + biexp fit per subset, median merge of trustworthy fits,
shape-RMSE convergence tol .005 / patience 3 / min 2 iterations / max 30, final kernel = median of last 5 iterates in **tau space** (the app uses (t_peak, FWHM) space; small difference),
then a final pass over all 100 cells with the converged kernel. 100 cells x 600 s, 30 Hz, markov + markovlow, both presets, SNR 5/12/30, 3 seeds (36 runs per method; `kernel.csv`).
True taus (constant across cells): gcamp6s 0.40/1.80 s, jgcamp8f 0.05/0.30 s. Errors are mean relative errors over the 9 runs per row.

| regime | preset | method | tau_r err | tau_d err | iterations | converged | final F1 | count ratio | wall s/run |
|---|---|---|---|---|---|---|---|---|---|
| markov | gcamp6s | Fista | -21% | +6.6% | 8.4 | 9/9 | .448 | .606 | 3.27 |
| markov | gcamp6s | Ipm | -21% | +6.5% | 8.4 | 9/9 | .421 | .547 | 0.98 |
| markov | jgcamp8f | Fista | +44% | -11.5% | 18.9 | 8/9 | .551 | 1.67 | 1.36 |
| markov | jgcamp8f | Ipm | +39% | -15.0% | 19.6 | 6/9 | .549 | 1.72 | 1.62 |
| markovlow | gcamp6s | Fista | -19% | +2.5% | 8.6 | 9/9 | .376 | 1.69 | 4.18 |
| markovlow | gcamp6s | Ipm | -19% | +3.2% | 9.0 | 9/9 | .387 | 1.59 | 1.03 |
| markovlow | jgcamp8f | Fista | +39% | -15.0% | 18.8 | 6/9 | .378 | 4.38 | 1.51 |
| markovlow | jgcamp8f | Ipm | +38% | -15.8% | 19.8 | 6/9 | .372 | 4.50 | 1.71 |

The estimated kernels are the same for the two solvers: median per-run |delta tau_d| between them is 0.7% (gcamp6s) and 0.3% (jgcamp8f), |delta tau_r| < 0.1%; group means differ more only where a single run fails to settle. The jgcamp8f loop itself does not settle well with either solver: tau_r drifts to the 33 ms floor at SNR 5 and 12 and overshoots 2-3x at SNR 30; the 30-iteration cap is hit in 4/18 Fista vs 6/18 Ipm runs (gcamp6s: 0/18 both). Iteration counts
are equal on gcamp6s and ~1 higher with Ipm on jgcamp8f (not significant: single non-converging seeds). The gcamp6s-markov F1 loss (-.027, count ratio .606 -> .547) persists
with the estimated kernel and is the same mechanism. Per-run rows and iterate trails are in `kernel.csv`. Both kernel loops are poor at low SNR (tau_r pinned), independent of the solver.

## 4. Timing totals (sweep; sum of per-solve ms, 7350 cells each)
| preset | fs | Fista s | Ipm s | speedup |
|---|---|---|---|---|
| gcamp6s | 10 | 18 | 10 | 1.8x |
| gcamp6s | 30 | 483 | 52 | 9.3x |
| gcamp6s | 60 | 2826 | 102 | 27.6x |
| jgcamp8f | 10 | 6.3 | 10.4 | 0.61x |
| jgcamp8f | 30 | 43 | 48 | 0.90x |
| jgcamp8f | 60 | 105 | 67 | 1.56x |
| total | | 3483 | 291 | 12.0x |
Mean ms/solve: gcamp6s 30 Hz 307 -> 33; 60 Hz 2684 -> 97; jgcamp8f 30 Hz 27.6 -> 30.3 (Ipm is slightly slower on fast kernels at low rate, FISTA needs only ~50-500 its there). Whole sweep
wall 336 s on 16 threads (Fista + Ipm + 3 Ipm counterfactuals per cell). Ipm Newton iterations 15-34 on average (77 on gcamp6s 60 Hz hi SNR); whether the FISTA fallback ever fired was not instrumented.
Caveat: threads share cores (hyperthreading); ratios are indicative.

## Bottom line
- Ipm is the same optimum and 12x cheaper in total (28x on the slowest configs); accuracy is unchanged on fast kernels and at 10 Hz.
- It loses F1 on slow kernels with burst firing at >= 30 Hz (-.017 at 30 Hz, -.042 at 60 Hz, up to -.03 in the 8-12 SNR band), via spike counts 5-20% lower.
- Mechanism: not crumbs, not segmentation. The cap-limited spike size `frame_max / cap` is set by the single largest frame of the relaxed solution; the exact optimum is peakier, so
  its floor is 14-34% larger and the train is thinner. Fista's loose stop was a smoother iterate and therefore a smaller floor.
- Candidate fixes tested only as counterfactuals; see the main report.
