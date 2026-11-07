# Fast relaxed solve (InDeCa native-rate, f64), 6 Nov 2026

Branch `exp/fast-relaxed` (from PR #269, `feat/max-firing-rate-event-mass`; profiling scaffolding cherry-picked from
`exp/profile-eventmass`). Local only.

## What was built

`crates/solver/src/ipm.rs`: a primal-dual (Mehrotra predictor-corrector) interior-point solve of the relaxed problem
`min 0.5||c - y||^2  s.t. 0 <= G c <= 1`, `c = K x`, `G = K^+` the 3-tap banded AR(2) difference operator (same f64
operator, prescale, cap-as-upper-bound = 1 in scaled units, one unobservable last sample held at 0). The Newton system is
the banded quasi-definite KKT matrix `[I G'; G -1/D]` (interleaved, half-bandwidth 5, LDL' without pivoting): O(n) per
iteration. The normal-equations form `I + G'DG` was tried first and fails (squares the 1e15 range of D; the `I` part is
lost, KKT bound stalls at 1e-4). Active set read off complementarity and snapped to the bounds; the point is then judged
by the code's own certificate (`native_solve::certify`) and accepted at `||delta|| <= 1e-3 x bound` (or `<= 1e-2 x bound`
once plateaued at the arithmetic floor). If that is not reached in 120 Newton iterations it warm-starts the existing
FISTA, which finishes to the same certificate (never triggered in the matrix below after the final fix).
Wired behind `SolveConfig.relaxed` (`Relaxed::Ipm | Fista | FistaTight[test]`); **default left at `Fista`** (see below).

Other candidates: OASIS-style/PAVA is exact only for AR(1) without the cap; the AR(2) bi-exponential does not decompose
into a monotone chain under the box, so not attempted. Preconditioned FISTA/active set not needed.

## Result 1: it IS the optimum

IPM vs FISTA run to a 1e-6-tighter certificate (`tight=1`; `exact` = identical spike counts per frame, 3 cells):

| config                | FISTA-tight ms | IPM ms | FISTA it | IPM it | max abs dx (spikes) | rel obj diff | spike trains identical                                               | F1 both |
| --------------------- | -------------- | ------ | -------- | ------ | ------------------- | ------------ | -------------------------------------------------------------------- | ------- |
| jgcamp8f 30 Hz 10 min | 161            | 53     | 1600     | 18     | 4e-6                | 1e-15        | 3/3                                                                  | .481    |
| jgcamp8f 60 Hz 5 min  | 445            | 51     | 4850     | 20     | 8e-6                | 0            | 2/2                                                                  | .470    |
| gcamp6s 30 Hz 10 min  | 4439           | 58     | 51567    | 25     | 7e-6                | 7e-16        | 3/3                                                                  | .405    |
| gcamp6s 60 Hz 5 min   | 18853          | 59     | 219000   | 30     | 2e-5                | 0            | 1/2 (612 vs 613 spikes; tight FISTA stalled unconverged on one cell) | .258    |

Unit tests (`ipm::tests`, `indeca::ipm_relaxed_solve_matches_a_converged_fista_solve_end_to_end`) assert this.
Edge cases tested: all-zero trace, pure noise, saturated bursts (cap active), n = 0..20 samples, certificate on an interior
grid with edge zones.

## Result 2 (negative): it does NOT reproduce the SHIPPED FISTA output

The shipped FISTA stops at the first check where `||delta|| <= bound` (bound ~ SE/(2||r||)), so its iterate is far from
the optimum (KKT `||delta||` 3e-3 to 2e-2, vs IPM 1e-6 .. 5e-4) and path dependent. That sub-tolerance difference (max
|dx| 0.01-0.14 spikes per frame) changes the binarization: counts differ by -30% .. +4%, F1 differs by -0.06 .. +0.01.
3 cells each, Markov-burst sims, mfr 300 (matrix_raw.txt):

| config                        | speedup | FISTA it | IPM it | F1 FISTA | F1 IPM | n true / FISTA / IPM  |
| ----------------------------- | ------- | -------- | ------ | -------- | ------ | --------------------- |
| jgcamp8f 30 Hz 10 min snr 5   | 0.8x    | 200      | 18     | .371     | .372   | 7332 / 9948 / 10203   |
| jgcamp8f 30 Hz 10 min snr 12  | 0.9x    | 267      | 19     | .577     | .581   | 7332 / 7690 / 7855    |
| jgcamp8f 30 Hz 30 min snr 12  | 0.9x    | 333      | 20     | .568     | .569   | 23899 / 22901 / 22957 |
| jgcamp8f 60 Hz 10 min snr 12  | 1.5x    | 750      | 21     | .570     | .580   | 7372 / 4122 / 4295    |
| jgcamp8f 60 Hz 30 min snr 5   | 1.5x    | 800      | 22     | .335     | .340   | 23049 / 10694 / 11000 |
| gcamp6s 30 Hz 10 min snr 5    | 4.1x    | 2383     | 24     | .350     | .287   | 7332 / 2809 / 2124    |
| gcamp6s 30 Hz 10 min snr 12   | 6.1x    | 4200     | 29     | .590     | .543   | 7332 / 4450 / 3805    |
| gcamp6s 30 Hz 30 min snr 12   | 6.4x    | 6350     | 38     | .473     | .444   | 23899 / 9095 / 8403   |
| gcamp6s 60 Hz 10 min snr 5    | 11.6x   | 8883     | 32     | .267     | .202   | 7372 / 2160 / 1453    |
| gcamp6s 60 Hz 10 min snr 12   | 25.4x   | 22450    | 37     | .278     | .275   | 7372 / 1932 / 1916    |
| gcamp6s 60 Hz 30 min snr 12   | 26.6x   | 26917    | 38     | .242     | .240   | 23049 / 4768 / 4754   |
| jgcamp8f 30 Hz 10 min mfr 100 | 0.9x    | 250      | 17     | .256     | .255   | 7332 / 1800 / 1792    |
| gcamp6s 30 Hz 10 min mfr 100  | 5.6x    | 3117     | 25     | .205     | .160   | 7332 / 1094 / 782     |

(Exact train match with shipped FISTA: 0 of 3 cells in every row; max |dPVE| 4e-4 .. 1.5e-2; certificate pass 3/3 both.)
Reading: on fast kernels the exact optimum scores the same or marginally better. On slow kernels the early-stopped FISTA
iterate scores HIGHER F1 (by .03-.06 at 30 Hz and low-SNR 60 Hz) than the true optimum, i.e. the loose stop acts as an
implicit regularizer that the lambda=0 problem lacks. Where both are far from the optimum the same (60 Hz high SNR) they
agree. So an exact method cannot be a drop-in with identical downstream results; the shipped result is not "the optimum
to tolerance" in a sense the binarization respects.

## Result 3: kernel estimation loop (6 cells x 5 min, 6 rounds from tau x0.5/x1.6, `fast_relaxed_kernel_loop`)

Both converge to the same kernel (round 5, tau_r/tau_d): jgcamp8f IPM .0793/.2691 vs FISTA .0794/.2691 (true .05/.30);
gcamp6s IPM .386/1.843 vs FISTA .389/1.842 (true .40/1.80). Wall: jgcamp8f 0.9 s vs 0.9 s; gcamp6s 1.2 s vs 15.5 s.

## WASM (wasm-pack release, Node, 1 thread, ms/trace, 10 min traces, 3 cells)

| config                                                             | FISTA | IPM        |
| ------------------------------------------------------------------ | ----- | ---------- |
| jgcamp8f 30 Hz                                                     | 67    | 71         |
| gcamp6s 30 Hz                                                      | 1066  | 91 (11.8x) |
| `npm run build:wasm` path compiles (wasm-pack with both defaults). |

## Reproduce

`cargo test --release --lib fast_relaxed_eval -- --ignored --nocapture` (env FR_*), `sh crates/solver/fast-relaxed/run_matrix.sh`.
Per-iteration IPM cost ~140 ns per sample (generic banded LDL'); a hand-specialized factor could give maybe 2x on fast kernels.
