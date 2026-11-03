//! The native-rate relaxed solve of InDeCa (`indeca::InnerSolve::Native`):
//! Box[0,1] FISTA on a trace at its recorded rate, in f64, stopped by a
//! convergence certificate derived from the binarization's resolution.
//!
//! This is the same iteration as [`crate::Solver::step_batch`] in banded
//! mode with the Box01 constraint and no baseline term (Beck & Teboulle
//! FISTA with the O'Donoghue & Candes gradient-mapping restart), kept apart
//! from the f32 `Solver` for two reasons: the iterate is held in f64, and
//! the stop is the certificate below rather than the relative-step test.
//!
//! # Why f64
//!
//! At the recorded rate the relaxed problem has a few thousand unknowns, so
//! memory is not a concern, but its conditioning is set by the kernel's
//! decay in samples, `tau_d * fs` (about 12 for GCaMP6f at 30 Hz, 45 for
//! GCaMP6s at 30 Hz, 90 at 60 Hz), and the condition number
//! `kappa = L ||K^+||^2` grows roughly as its fourth power (measured: 1e4 at
//! GCaMP6f/30 Hz, 3e5 at GCaMP6s/30 Hz, 5e6 at GCaMP6s/60 Hz, against
//! `1 / eps32 = 8e6`). In f32 the iterate stalls before the certificate:
//! a one-ulp change of `x_i` moves the KKT residual by about
//! `L eps32 x_i`, and that floor, mapped through the same operator as the
//! certificate, sits above the bound on slow kernels at 60 Hz (5e-3 against
//! 1e-3 for GCaMP6s). Measured on two cells per preset (seed 777, drift off):
//! an f32 iterate with the certificate evaluated in f64 never fires on
//! GCaMP6s/60 Hz, `clean`/60 Hz, one GCaMP6m and one OGB-1 cell at 60 Hz and
//! one GCaMP6s cell at 30 Hz (the stall is in the iterate, not in the
//! certificate's arithmetic); promoting to f64 only when the f32 floor
//! exceeds the bound still misses three of those cells, which stall with the
//! floor at 0.17-0.26 of the bound, so a data-derived switch would need an
//! empirical margin. The full f64 solve fires on every cell at 15, 30 and
//! 60 Hz and costs 0.9-1.2x the f32 iteration natively (the AR(2)
//! recursions are sequential; the vectors fit in cache), so it is what
//! ships. What remains at 60 Hz is the conditioning itself (GCaMP6s needs
//! about 30,000 iterations, 1 s per 100 s cell), which is reported, not
//! hidden.
//!
//! # The certificate ([`Stop`])
//!
//! The InDeCa binarization compares candidate trains by their residual
//! energy `e = ||r||^2` over the grid samples and treats differences below
//! one standard error `SE` of the noise energy (`NoiseModel::std_error`) as
//! unresolvable: candidates within `SE` of the best fit are "the same fit",
//! and the sparsest of them is taken. The relaxed solve feeds that
//! selection; once the relaxed fit's own energy can no longer move by `SE`,
//! the solve has nothing left to deliver that the selection could see.
//!
//! 1. A change `d` of the reconstruction on the grid moves the residual
//!    energy by `|e' - e| = |-2 <r, d> + ||d||^2| <= 2 ||r|| ||d|| + ||d||^2`,
//!    which stays below `SE` whenever
//!    `||d|| <= tau := sqrt(||r||^2 + SE) - sqrt(||r||^2)`.
//! 2. How far the reconstruction can still move: with `F(x) = f(x) +
//!    lambda 1'x`, `f = 0.5 ||K x - y||^2`, and `x*` the minimizer over the
//!    box, optimality (`<grad F(x*), x - x*> >= 0`) gives
//!    `F(x) - F* >= 0.5 ||K x - K x*||^2` for every feasible `x`: the fit is
//!    strongly convex in the reconstruction even where it is flat in `x`.
//! 3. `F(x) - F*` is bounded by weak duality. The dual function of the box
//!    problem is `G(r) = r'y - 0.5 ||r||^2 - sum_i (K'r - lambda)_i^+` and,
//!    with `s = y - K x` the current residual,
//!    `F(x) - G(r) = 0.5 ||s - r||^2 + sum_i [(K'r - lambda)_i^+ - x_i (K'r - lambda)_i]`
//!    for every `r` (each bracket is non-negative on the box). Take
//!    `r = s - delta` with `K'delta = m`, where `m` is the KKT residual of
//!    `x`: `m_i = -g_i` on the support (`0 < x_i < 1`), `m_i = max(-g_i, 0)`
//!    where `x_i = 0`, `m_i = min(-g_i, 0)` where `x_i = 1`
//!    (`g = K'(K x - y) + lambda` the gradient). Then every bracket is zero
//!    and `F(x) - F* <= 0.5 ||delta||^2`, with `delta = (K^+)' m` computed
//!    by the banded inverse's adjoint ([`BandedAR2::inverse_adjoint_f64`]).
//!    At the optimum `m = 0`; near it `||delta||` is first order in the KKT
//!    residual, so the bound on `F - F*` is second order: tight (for an
//!    unconstrained quadratic it is an equality), unlike the Frank-Wolfe gap
//!    `sum_i [g_i^+ x_i + g_i^- (1 - x_i)]`, which is first order and (as a
//!    first attempt showed) never reaches the required level.
//!
//! So the remaining movement of the reconstruction is at most `||delta||`,
//! and the rule, evaluated on the iterate at every batch boundary, is
//!
//! ```text
//! ||delta|| <= sqrt(||r||^2 + SE) - sqrt(||r||^2).
//! ```
//!
//! Nothing is tuned: `SE` is the selection's own resolution, derived from
//! the noise model (one standard error, the same allowance the pick uses),
//! scaled into the solver's units by the caller (the prescale squared);
//! `||r||^2` is the iterate's fit on the grid. At the noise floor
//! (`||r||^2 ~ sigma^2 n`) `tau` is about `sigma sqrt(corr / 2)`: the
//! reconstruction may still move by less than the noise on a single grid
//! sample.
//!
//! Why this and not the relative-step test: with `lambda = 0` the relaxed
//! problem has directions the data barely constrains (sub-bin rearrangements
//! at the upsampled rate; at the recorded rate, adjacent frames under a slow
//! kernel at high frame rates). The iterate keeps moving along them long
//! after the reconstruction has settled, so a test on `x` either never
//! fires or fires at an arbitrary point of that drift (measured: the step
//! rule at 1e-7 stopped two solves of the same GCaMP6s trace, differing by a
//! 1e-6 input perturbation, at 99,000 and 21,000 iterations, with relaxed
//! fits 24 standard errors apart). The bound sees those directions only
//! through what they do to the fit, which is what the selection sees too.
//! (A per-iteration step test on `K x` fires far too early: the slow
//! directions move the reconstruction by a small amount per iteration over
//! thousands of iterations; only a bound on the *remaining* movement works.
//! A bound against the threshold grid's spacing through `||K^+||` was also
//! tried: it is a worst-case bound and hits the cap on slow kernels.)
//!
//! # The cap
//!
//! The certificate is attainable (above) and FISTA converges, so the cap is
//! a guard against runaway time only. The caller's `max_iters` was sized for
//! the upsampled solve, whose fixed budget acted as a regularizer; here it
//! would truncate the solve (400-4,000 iterations at 30 Hz, 30,000 at 60 Hz
//! on GCaMP6s). [`iteration_cap`] therefore raises it to FISTA's worst-case
//! count for the true remaining movement to fall under the bound, which is
//! what the certificate certifies: from `F(x_k) - F* <= 2 L ||x_0 - x*||^2 /
//! (k + 1)^2` and step 2 above, `||K x_k - K x*|| <= 2 sqrt(L) ||x_0 - x*||
//! / (k + 1)`, with `||x_0 - x*|| <= sqrt(n)` on the box from `x_0 = 0` and
//! `tau` taken at the initial residual (where it is smallest, since `tau`
//! grows as the fit improves). Every quantity is the problem's own; the
//! bound is loose by the box worst case, so it is three to four orders of
//! magnitude above the iterations the certificate needs (measured: 1e7-1e8
//! at 30 Hz).
use crate::banded::BandedAR2;

/// Batch length between certificate checks (the iteration itself is
/// batched the same way as [`crate::Solver::step_batch`]).
const BATCH: u32 = 50;

/// The certificate and the grid it is evaluated on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Stop {
    /// One standard error of the noise energy over the grid, in solver
    /// units (trace units divided by the prescale, squared): the fit's
    /// resolution the remaining movement of the reconstruction is compared
    /// with.
    pub se: f64,
    /// Grid samples `[lo, hi)`, every `stride`-th.
    pub lo: usize,
    pub hi: usize,
    pub stride: usize,
}

/// What the certificate measured on the final iterate.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CertificateState {
    /// `||delta||`: upper bound on the remaining movement of `K x`.
    pub remaining: f64,
    /// The bound `remaining` had to reach.
    pub bound: f64,
    /// `||r||^2` on the grid.
    pub grid_fit: f64,
}

/// Why the solve stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopReason {
    /// The certificate held.
    Certificate,
    /// The relative-step rule at the caller's tolerance fired.
    Step,
    /// The iteration cap.
    Cap,
}

pub(crate) struct NativeResult {
    pub x: Vec<f64>,
    pub iterations: u32,
    pub reason: StopReason,
    /// The certificate on the final iterate (`None` without a certificate).
    pub certificate: Option<CertificateState>,
}

impl NativeResult {
    pub(crate) fn converged(&self) -> bool {
        self.reason != StopReason::Cap
    }
}

/// FISTA's worst-case iteration count for the reconstruction of a Box[0,1]
/// problem with `n` unknowns and Lipschitz constant `lipschitz` to come
/// within `tau` of its optimum (module docs, "The cap"). `tau <= 0` (no
/// resolution to certify against) gives `u32::MAX`.
pub(crate) fn iteration_cap(n: usize, lipschitz: f64, tau: f64) -> u32 {
    // (NaN falls through to "no cap", like a non-positive resolution.)
    if tau.is_nan() || tau <= 0.0 || lipschitz.is_nan() || lipschitz <= 0.0 {
        return u32::MAX;
    }
    let k = 2.0 * (lipschitz * n as f64).sqrt() / tau;
    if k >= u32::MAX as f64 {
        u32::MAX
    } else {
        k.ceil() as u32
    }
}

/// Box[0,1] FISTA on `y` (already prescaled, baseline-subtracted) with the
/// peak-normalized AR(2) operator `banded`, L1 weight `lambda` (the
/// solver's effective lambda; 0 on the InDeCa path), the relative-step
/// tolerance `tol` (`0` disables it), the certificate `stop` (`None`
/// disables it) and the cap `max_iters`. `warm` seeds the iterate.
pub(crate) fn solve_box(
    y: &[f64],
    banded: &BandedAR2,
    lambda: f64,
    max_iters: u32,
    tol: f64,
    stop: Option<Stop>,
    warm: Option<&[f64]>,
) -> NativeResult {
    let n = y.len();
    let mut x = vec![0.0_f64; n];
    if let Some(w) = warm {
        if w.len() == n {
            for (xi, &wi) in x.iter_mut().zip(w) {
                *xi = wi.clamp(0.0, 1.0);
            }
        }
    }
    let mut yk = x.clone();
    let mut x_old = vec![0.0_f64; n];
    let mut conv = vec![0.0_f64; n];
    let mut resid = vec![0.0_f64; n];
    let mut grad = vec![0.0_f64; n];
    let lipschitz = banded.lipschitz();
    let step = 1.0 / lipschitz;
    let shrink = step * lambda;
    let tol_sq = tol * tol;
    let mut t_fista = 1.0_f64;
    let mut iteration = 0_u32;
    let mut reason = StopReason::Cap;
    let mut certificate = None;
    if n == 0 {
        return NativeResult {
            x,
            iterations: 0,
            reason: StopReason::Certificate,
            certificate,
        };
    }

    'outer: while iteration < max_iters {
        let batch = BATCH.min(max_iters - iteration);
        for _ in 0..batch {
            // Gradient at the extrapolated point.
            banded.convolve_forward_f64(&yk, &mut conv);
            for i in 0..n {
                resid[i] = conv[i] - y[i];
            }
            banded.convolve_adjoint_f64(&resid, &mut grad);
            // Proximal step.
            let mut diff_sq = 0.0_f64;
            let mut xk_sq = 0.0_f64;
            let mut dot = 0.0_f64;
            for i in 0..n {
                x_old[i] = x[i];
                x[i] = (yk[i] - step * grad[i] - shrink).clamp(0.0, 1.0);
                let d = x[i] - x_old[i];
                diff_sq += d * d;
                xk_sq += x_old[i] * x_old[i];
                dot += (yk[i] - x[i]) * d;
            }
            iteration += 1;
            // Momentum, with the gradient-mapping restart.
            let t_new = (1.0 + (1.0 + 4.0 * t_fista * t_fista).sqrt()) / 2.0;
            if iteration > 1 && dot > 0.0 {
                t_fista = 1.0;
                yk.copy_from_slice(&x);
            } else {
                let momentum = (t_fista - 1.0) / t_new;
                t_fista = t_new;
                for i in 0..n {
                    yk[i] = (x[i] + momentum * (x[i] - x_old[i])).clamp(0.0, 1.0);
                }
            }
            if tol > 0.0 && iteration > 5 && diff_sq < tol_sq * (xk_sq + 1e-20) {
                reason = StopReason::Step;
                break 'outer;
            }
        }
        if let Some(st) = stop.as_ref() {
            let c = certify(&x, y, banded, lambda, st, &mut conv, &mut resid, &mut grad);
            let done = c.remaining <= c.bound && c.bound > 0.0;
            certificate = Some(c);
            if done {
                reason = StopReason::Certificate;
                break;
            }
        }
    }
    if certificate.is_none() {
        if let Some(st) = stop.as_ref() {
            certificate = Some(certify(
                &x, y, banded, lambda, st, &mut conv, &mut resid, &mut grad,
            ));
        }
    }
    NativeResult {
        x,
        iterations: iteration,
        reason,
        certificate,
    }
}

/// Evaluate the certificate on the iterate `x` (see the module docs). The
/// three buffers are scratch.
#[allow(clippy::too_many_arguments)]
fn certify(
    x: &[f64],
    y: &[f64],
    banded: &BandedAR2,
    lambda: f64,
    stop: &Stop,
    conv: &mut [f64],
    resid: &mut [f64],
    grad: &mut [f64],
) -> CertificateState {
    let n = x.len();
    // e = K x - y; the grid residual energy.
    banded.convolve_forward_f64(x, conv);
    let mut grid_fit = 0.0_f64;
    for i in 0..n {
        resid[i] = conv[i] - y[i];
    }
    for i in (stop.lo..stop.hi.min(n)).step_by(stop.stride.max(1)) {
        grid_fit += resid[i] * resid[i];
    }
    // g = K' e + lambda; the KKT residual m = -g on the support, clipped to
    // the admissible sign where x sits on a bound.
    banded.convolve_adjoint_f64(resid, grad);
    for i in 0..n {
        let mg = -(grad[i] + lambda);
        grad[i] = if x[i] <= 0.0 {
            mg.max(0.0)
        } else if x[i] >= 1.0 {
            mg.min(0.0)
        } else {
            mg
        };
    }
    // delta = (K^+)' m.
    banded.inverse_adjoint_f64(grad, resid);
    let remaining = resid.iter().map(|&v| v * v).sum::<f64>().sqrt();
    CertificateState {
        remaining,
        bound: (grid_fit + stop.se).sqrt() - grid_fit.sqrt(),
        grid_fit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(n: usize, amp: f64, seed: u64) -> Vec<f64> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0) * amp
            })
            .collect()
    }

    /// A noisy trace with spikes on the frame grid at prescale 1: masses in
    /// (0, 1), as the InDeCa path hands them over.
    fn problem(n: usize, seed: u64) -> (Vec<f64>, BandedAR2) {
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let mut s = vec![0.0_f64; n];
        let mut p = 37;
        while p < n {
            s[p] = 0.3;
            p += 23 + (p * 7) % 41;
        }
        let mut y = vec![0.0_f64; n];
        banded.convolve_forward_f64(&s, &mut y);
        for (v, e) in y.iter_mut().zip(lcg(n, 0.03, seed)) {
            *v += e;
        }
        (y, banded)
    }

    fn stop(n: usize, se: f64) -> Stop {
        Stop {
            se,
            lo: 0,
            hi: n,
            stride: 1,
        }
    }

    #[test]
    fn inverse_adjoint_is_the_adjoint_of_the_left_inverse() {
        // K' (K^+)' m = m for every m that ignores the unobservable last
        // sample: convolve_adjoint(inverse_adjoint(m)) == m.
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let n = 300;
        let mut m = lcg(n, 1.0, 7);
        m[n - 1] = 0.0;
        let mut delta = vec![0.0; n];
        banded.inverse_adjoint_f64(&m, &mut delta);
        let mut back = vec![0.0; n];
        banded.convolve_adjoint_f64(&delta, &mut back);
        for (a, b) in back.iter().zip(&m) {
            assert!((a - b).abs() < 1e-9, "{a} vs {b}");
        }
    }

    #[test]
    fn certificate_bounds_the_remaining_movement_and_shrinks() {
        // At several iteration counts the certificate must bound the
        // distance of K x to K x_far (a solve run much longer), and it
        // shrinks along the run.
        let (y, banded) = problem(900, 0xA11CE);
        let n = y.len();
        let far = solve_box(&y, &banded, 0.0, 200_000, 1e-13, None, None);
        let mut k_far = vec![0.0; n];
        banded.convolve_forward_f64(&far.x, &mut k_far);
        let mut last = f64::INFINITY;
        for iters in [50, 500, 2000, 8000] {
            let r = solve_box(&y, &banded, 0.0, iters, 0.0, Some(stop(n, 0.0)), None);
            let c = r.certificate.unwrap();
            let mut kx = vec![0.0; n];
            banded.convolve_forward_f64(&r.x, &mut kx);
            let dist = kx
                .iter()
                .zip(&k_far)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f64>()
                .sqrt();
            assert!(
                dist <= c.remaining * (1.0 + 1e-6) + 1e-9,
                "{iters}: moved {dist} with certificate {}",
                c.remaining
            );
            assert!(c.remaining < last, "{iters}: {} vs {last}", c.remaining);
            last = c.remaining;
        }
        assert!(last < 1e-4, "{last}");
    }

    #[test]
    fn fit_certificate_stops_before_the_cap_and_is_cap_independent() {
        let (y, banded) = problem(900, 0xBEEF);
        let n = y.len();
        // SE of the noise energy over the grid (white noise, sigma ~ 0.0173).
        let sigma_sq = 0.03_f64 * 0.03 / 3.0;
        let st = stop(n, sigma_sq * (2.0 * n as f64).sqrt());
        let a = solve_box(&y, &banded, 0.0, 1_000_000, 0.0, Some(st), None);
        assert_eq!(a.reason, StopReason::Certificate);
        assert!(a.converged());
        assert!(a.iterations < 100_000, "{}", a.iterations);
        let c = a.certificate.unwrap();
        assert!(c.remaining <= c.bound);
        let b = solve_box(&y, &banded, 0.0, 2 * a.iterations, 0.0, Some(st), None);
        assert_eq!(a.x, b.x);
        assert_eq!(a.iterations, b.iterations);
        // Without a certificate and tolerance the cap is the only stop.
        let c = solve_box(&y, &banded, 0.0, 100, 0.0, None, None);
        assert_eq!(c.reason, StopReason::Cap);
        assert!(!c.converged());
        assert_eq!(c.iterations, 100);
    }

    #[test]
    fn iteration_cap_is_far_above_the_certificate_and_degrades_to_no_cap() {
        let (y, banded) = problem(900, 0xBEEF);
        let n = y.len();
        let se = 0.03_f64 * 0.03 / 3.0 * (2.0 * n as f64).sqrt();
        let y2 = y.iter().map(|v| v * v).sum::<f64>();
        let tau0 = (y2 + se).sqrt() - y2.sqrt();
        let cap = iteration_cap(n, banded.lipschitz(), tau0);
        let a = solve_box(&y, &banded, 0.0, cap, 0.0, Some(stop(n, se)), None);
        assert_eq!(a.reason, StopReason::Certificate);
        assert!(cap > 100 * a.iterations, "{cap} vs {}", a.iterations);
        assert_eq!(iteration_cap(n, banded.lipschitz(), 0.0), u32::MAX);
        assert_eq!(iteration_cap(n, banded.lipschitz(), 1e-300), u32::MAX);
    }

    #[test]
    fn step_rule_and_warm_start_behave() {
        let (y, banded) = problem(600, 0xF00D);
        let a = solve_box(&y, &banded, 0.0, 100_000, 1e-6, None, None);
        assert_eq!(a.reason, StopReason::Step);
        // Warm start from the solution: a tiny step at once.
        let b = solve_box(&y, &banded, 0.0, 100_000, 1e-6, None, Some(&a.x));
        assert!(b.iterations < a.iterations);
        // The L1 weight sparsifies.
        let l1 = solve_box(&y, &banded, 0.05, 100_000, 1e-6, None, None);
        let nnz = |x: &[f64]| x.iter().filter(|&&v| v > 0.0).count();
        assert!(nnz(&l1.x) < nnz(&a.x));
        assert!(l1.x.iter().all(|&v| (0.0..=1.0).contains(&v)));
        // Empty input.
        let e = solve_box(&[], &banded, 0.0, 10, 1e-4, None, None);
        assert!(e.x.is_empty() && e.converged());
    }
}
