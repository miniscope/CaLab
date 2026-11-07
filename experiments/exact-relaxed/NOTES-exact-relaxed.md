# Exact relaxed solve + spike-size pick (6 Nov 2026)

Branch `feat/exact-relaxed-solve` (from PR #269 `feat/max-firing-rate-event-mass`). Local only.
Inputs: `exp/fast-relaxed` (`ipm.rs`), `exp/exact-vs-fista` (harness; its notes are `NOTES-exact-vs-fista.md`
and `NOTES-fast-relaxed.md` in this directory). Raw per-cell CSVs: `data/*.csv.gz`; full tables: `report.md`
(`python3 experiments/exact-relaxed/report.py`); harness: `crates/solver/src/eval_exact_vs_fista.rs`
(`eval_evf_floor`, `eval_evf_noise`, `eval_evf_kernel`, `eval_evf_sweep`, all `#[ignore]`).

## Setup
42 datasets (regime markov/markovlow/poisson x preset jgcamp8f/gcamp6s x fs 30 (3 seeds), 60 (2), 10 (2)),
175 cells each (SNR 3,5,8,12,20,35,50 x 25), 300 s, true kernel, max firing rate 300 spikes/s (7350 cells);
plus max firing rate 100 on the 30 Hz datasets (18 datasets = 3 regimes x 2 presets x 3 seeds, 3150 cells).
F1 +-2 frames, mean over cells; count ratio = sum(est)/sum(true) over the group. SNR bands lo 3-5, mid 8-12, hi 20-50.

Pick rules (all with the exact interior-point solve; `event_mass::DEFAULT_MODE`):

| label | floor | when no size is within 1 SE of the relaxed fit |
|---|---|---|
| F0 | frame (`frame_max/cap`) | floor, **shipped FISTA** (reference) |
| I0 | frame | floor (Ipm, nothing else changed) |
| I1 | event span (`max_e m_e/(cap len_e)`) | floor |
| I2 | event span | best-fitting size (argmin chain-scored error) |
| **I3** | frame | **best-fitting size (chosen)** |
| I4 | frame | none needed: 1-SE rule taken against the best-fitting size instead of the relaxed fit |
| I5 | event span | same as I4 |

I4/I5 are the "principled refinement" tests (textbook one-standard-error rule: sparsest size within 1 SE of the best fit;
no fallback concept, no constants).

## Result 1: pooled F1 and count ratio, max rate 300 (preset x fs, regimes pooled)

| preset | fs | F1 F0 | I0 | I1 | I2 | I3 | I4 | I5 | ratio F0 | I0 | I1 | I2 | I3 | I4 | I5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gcamp6s | 10 | .446 | .448 | .436 | .446 | .449 | .435 | .433 | 1.08 | 1.06 | 1.22 | 1.10 | 1.05 | 1.12 | 1.14 |
| gcamp6s | 30 | .393 | .390 | .379 | .385 | .392 | .385 | .378 | 1.03 | .97 | 1.21 | 1.13 | .91 | .88 | 1.14 |
| gcamp6s | 60 | .301 | .288 | .300 | .300 | .285 | .283 | .297 | .75 | .66 | .93 | .84 | .61 | .60 | .83 |
| jgcamp8f | 10 | .304 | .304 | .272 | .328 | .304 | .320 | .345 | 4.64 | 4.66 | 5.48 | 4.30 | 4.66 | 4.14 | 3.72 |
| jgcamp8f | 30 | .414 | .414 | .327 | .351 | .438 | .454 | .374 | 3.08 | 3.10 | 4.36 | 4.06 | 2.94 | 2.59 | 3.52 |
| jgcamp8f | 60 | .536 | .534 | .453 | .509 | .621 | .630 | .519 | 1.73 | 1.74 | 2.51 | 2.25 | 1.47 | 1.40 | 2.13 |
| **all 7350 cells** | | .400 | .397 | .360 | .384 | .415 | .418 | .389 | 2.05 | 2.03 | 2.64 | 2.32 | 1.93 | 1.78 | 2.11 |

F1 by regime (rows with the largest differences; the full 18-row table is in `report.md`):

| regime | preset | fs | F0 | I0 | I1 | I2 | I3 | I4 | I5 |
|---|---|---|---|---|---|---|---|---|---|
| markov | gcamp6s | 30 | .485 | .468 | .487 | .483 | .451 | .429 | .472 |
| markov | gcamp6s | 60 | .334 | .292 | .371 | .355 | .278 | .273 | .346 |
| markov | jgcamp8f | 30 | .552 | .552 | .467 | .479 | .552 | .546 | .484 |
| markovlow | jgcamp8f | 30 | .384 | .381 | .264 | .275 | .384 | .409 | .306 |
| markovlow | jgcamp8f | 60 | .533 | .529 | .389 | .396 | .591 | .603 | .407 |
| poisson | jgcamp8f | 30 | .307 | .307 | .250 | .298 | .376 | .406 | .330 |
| poisson | jgcamp8f | 60 | .478 | .474 | .400 | .563 | .675 | .693 | .586 |

Means over groups (regime x preset x fs): all 18 groups F0 .399, I3 .415, I4 .418, I2 .387, I5 .391; markov only (6) F0 .467,
I2 .462, I5 .458, I3 .453, I4 .448; markov+markovlow (12) F0 .432, I3 .431, I4 .434, I2 .407, I5 .411. Worst group vs F0:
I3 -.056, I4 -.061, I5 -.126, I2 -.137, I1 -.143. Best group vs F0: I4 +.215, I3 +.197.

## Result 2: max firing rate 100 (30 Hz datasets, cap 3)

| preset | F1 F0 | I0 | I1 | I2 | I3 | I4 | I5 | ratio F0 | I2 | I3 | I5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gcamp6s | .369 | .347 | .385 | .384 | .343 | .340 | .380 | .41 | .49 | .34 | .48 |
| jgcamp8f | .583 | .584 | .547 | .609 | .623 | .624 | .620 | .84 | 1.08 | .77 | 1.01 |
| all | .476 | .466 | .466 | .496 | .483 | .482 | .500 | .62 | .79 | .55 | .74 |

At this cap the markov burst regime is heavily undercounted (ratio .15-.37) and the span floor is clearly better there
(markov gcamp6s .257 F0 / .209 I3 / .303 I2; markov jgcamp8f .315 / .313 / .435).

## Result 3: cap_limited, no_size_fit

| % of cells | F0 | I0 | I1 | I2 | I3 | I4 | I5 |
|---|---|---|---|---|---|---|---|
| cap_limited, rate 300 | 59.7 | 63.1 | 53.9 | 36.4 | 45.5 | 28.7 | 21.5 |
| no_size_fit, rate 300 | 51.7 | 55.2 | 48.8 | 48.8 | 55.2 | 0 | 0 |
| cap_limited, rate 100 | 97.9 | 98.5 | 96.1 | 57.4 | 59.7 | 32.0 | 29.0 |
| no_size_fit, rate 100 | 97.6 | 98.3 | 95.2 | 95.2 | 98.3 | 0 | 0 |

By preset x fs, rate 300, F0 -> I3: gcamp6s 14/43/78% -> 13/32/39% (10/30/60 Hz), jgcamp8f 38/85/96% -> 38/74/70%.
The one-SE test against the relaxed fit fails in 55% of cells (96% for jgcamp8f at 60 Hz, 98% at rate 100): whole-spike trains
essentially never get within one SE of the relaxed fit once the cap binds, so the fallback decides most sizes.
Picking the best-fitting size makes most of those cells non-floor (cap_limited 63% -> 45.5%).

## Result 4: pure noise (600 frames, 30 Hz, 200 seeds, spikes/trace)

| rule | Ipm | Fista |
|---|---|---|
| I0 / I1 / I2 / I3 (modes 0-3) | 34.4 (fixed trace 32, max 59) | 34.4 (fixed trace 33) |
| I4 / I5 | 40.3 (fixed trace 34, max 90-94) | 40.4 |

The fixed unit-test trace gives 32 (Ipm) / 33 (FISTA), about 33/600 as on #269 (main's 14 is a property of #269, not of this change).
The pick fallback and the floor do not change pure noise (isolated one-frame events: the floors coincide); the 1-SE-vs-best rule (I4/I5)
adds 17%.

## Result 5: does Ipm's FISTA fallback fire?
Yes, rarely: 130 of 7350 cells (1.8%) at rate 300, all gcamp6s at 60 Hz with SNR >= 12 (poisson 91, markovlow 32, markov 7;
SNR 50: 77, 35: 41, 20: 11, 12: 1); never at rate 100 (0 of 3150). Those solves cost ~230 ms vs ~37 ms for the others
(FISTA total 2874 s vs Ipm 105 s over the 60 Hz gcamp6s sweep, fallbacks included).

## Result 6: speed (sum of per-solve ms, 16 contended threads; mode 0)

| preset | fs | FISTA s | Ipm s | speedup |
|---|---|---|---|---|
| gcamp6s | 10 | 18.0 | 10.1 | 1.8x |
| gcamp6s | 30 | 494.6 | 53.2 | 9.3x |
| gcamp6s | 60 | 2874 | 104.7 | 27.5x |
| jgcamp8f | 10 | 6.2 | 10.4 | 0.60x |
| jgcamp8f | 30 | 43.2 | 47.9 | 0.90x |
| jgcamp8f | 60 | 105.3 | 68.2 | 1.54x |
| total | | 3542 | 294 | 12.0x |

Rate 100 (30 Hz only): 534 s vs 92 s (5.8x). Pick-rule cost is nil (I0-I5 within 1%). Fast kernels at low rate are 10-40% slower with Ipm.

## Result 7: kernel-estimation loop (app-equivalent, 25% coverage, 4 subsets, estimated kernel)
100 cells x 600 s, 30 Hz, markov + markovlow, both presets, SNR 5/12/30, 3 seeds = 9 runs per row. Errors are mean relative errors of the
final taus vs truth (gcamp6s true 0.40/1.80 s, jgcamp8f 0.05/0.30 s). `shipped` = FISTA + frame floor + floor fallback;
`ipm_old_pick` = Ipm alone; `ipm_new_pick` = the chosen default.

| regime | preset | method | tau_r err | tau_d err | iterations | converged | final F1 | count ratio | wall s/run |
|---|---|---|---|---|---|---|---|---|---|
| markov | gcamp6s | shipped | -21% | +6.6% | 8.4 | 9/9 | .448 | .61 | 3.21 |
| markov | gcamp6s | ipm_old_pick | -21% | +6.5% | 8.4 | 9/9 | .421 | .55 | 0.93 |
| markov | gcamp6s | ipm_new_pick | -21% | +6.3% | 8.4 | 9/9 | .412 | .53 | 0.94 |
| markov | jgcamp8f | shipped | +44% | -11.5% | 18.9 | 8/9 | .551 | 1.67 | 1.32 |
| markov | jgcamp8f | ipm_old_pick | +39% | -15.0% | 19.6 | 6/9 | .549 | 1.72 | 1.63 |
| markov | jgcamp8f | ipm_new_pick | +42% | -12.4% | 19.4 | 7/9 | .549 | 1.68 | 1.61 |
| markovlow | gcamp6s | shipped | -19% | +2.5% | 8.6 | 9/9 | .376 | 1.69 | 4.16 |
| markovlow | gcamp6s | ipm_old_pick | -19% | +3.2% | 9.0 | 9/9 | .387 | 1.59 | 1.00 |
| markovlow | gcamp6s | ipm_new_pick | -19% | +4.3% | 9.3 | 9/9 | .397 | 1.51 | 1.07 |
| markovlow | jgcamp8f | shipped | +39% | -15.0% | 18.8 | 6/9 | .378 | 4.38 | 1.50 |
| markovlow | jgcamp8f | ipm_old_pick | +38% | -15.8% | 19.8 | 6/9 | .372 | 4.50 | 1.68 |
| markovlow | jgcamp8f | ipm_new_pick | +39% | -16.0% | 19.1 | 6/9 | .383 | 4.43 | 1.63 |

Median per-run |delta tau_d| new vs shipped: 0.7% (gcamp6s), 0.3% (jgcamp8f); |delta tau_r| <= 0.2%. The final kernels are the same;
iteration counts equal within one. The kernel loop itself still pins tau_r on jgcamp8f (+40%) and misses the 30-iteration cap in 3 of 9
runs per row with either solver. Wall: gcamp6s 3.5-3.9x faster; jgcamp8f 1.2x slower. Final F1 vs shipped, mean of 9 runs: markov gcamp6s -.036,
markovlow gcamp6s +.021, jgcamp8f markov -.002, markovlow +.004.

## Decision: I3 (Ipm, frame floor, best-fitting size when no size passes the 1-SE test)

Evidence for: pooled F1 .415 vs .400 shipped (max rate 300) and .483 vs .476 (rate 100); smallest worst-case regression of the
variants that change anything (-.056, markov gcamp6s 60 Hz); neutral (-.001) vs shipped on burst regimes (markov+markovlow) at the default cap;
biggest gains exactly where the pipeline overcounts (jgcamp8f 30/60 Hz +.024/+.085, poisson jgcamp8f 60 Hz +.20; count ratio 1.73 -> 1.47);
it uses no new constant (the fallback is the score the 1-SE test already uses), leaves pure noise unchanged, and keeps the `no_size_fit`
semantics. I4 has a marginally higher pooled F1 (.418) but costs +17% pure-noise spikes and -.045 on poisson gcamp6s 10 Hz.

What got worse, and no variant dominates:
- Burst firing on slow indicators (markov gcamp6s): 30 Hz -.034, 60 Hz -.056 vs shipped FISTA (the exact optimum's larger frame_max
  gives a larger floor; the best-fit fallback cannot go below the floor). Same -.036 in the kernel loop. At max rate 100 markov
  F1 falls .286 -> .261 pooled (gcamp6s -.048).
- Span-floor rules (I1/I2/I5) fix exactly that (markov gcamp6s 30/60 Hz .472-.487/.346-.371; markov at rate 100 +.08 to +.12) and are the
  better choice if burst firing at a binding cap is the target, but they overcount the fast-indicator regimes further and lose up to
  .13-.14 F1 (jgcamp8f markovlow 30/60 Hz) and 4-8 points pooled on jgcamp8f.
- Ipm is 10-40% slower than FISTA on jgcamp8f at 10-30 Hz (and 1.2x in the kernel loop).
- Ipm falls back to FISTA in 1.8% of cells (gcamp6s 60 Hz, SNR >= 12), at ~6x the cost of an Ipm solve.
- Output is no longer bit-identical under a prescale change (equal to the certificate, 1e-4).
