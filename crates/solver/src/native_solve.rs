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
//! # When the certificate cannot be met: the stall detector and the cap
//!
//! The certificate is attainable in exact arithmetic (above) and FISTA
//! converges, but the iterate lives in f64: once `||delta||` reaches the
//! arithmetic floor of its own evaluation it stops improving, and if the
//! bound is below that floor (or zero: a resolution `SE` too small to
//! register against `||r||^2`) the certificate can never fire. The stop for
//! that case is a stall detector on the certificate itself
//! ([`StallDetector`]): at every check the bound `||delta||` is recorded,
//! and the solve stops with `converged = false` ([`StopReason::Stall`]) when
//! the running best has not improved by more than the arithmetic floor over
//! `W` consecutive checks.
//!
//! *The floor.* `||delta||` is evaluated as `K x` (forward AR(2)
//! recursion), `r = K x - y`, `g = K' r` (adjoint recursion), the clip, and
//! `delta = (K^+)' m` (3-tap filter). A recursion `c_t = g1 c_{t-1} + g2
//! c_{t-2} + s_t` commits a local rounding error of about
//! `eps (1 + |g1| + |g2|) |c_t|` per step and propagates it through `1/A`,
//! so the computed `K x` is off by about `||K|| ||K^+|| eps ||K x||`
//! (`||K|| = sqrt(L)`, `||K^+|| = peak (1 + |g1| + |g2|)`,
//! [`BandedAR2::inverse_norm`]); that error passes into `delta` through
//! `(K^+)' K'`, a projection, unamplified. The adjoint recursion likewise
//! errs by about `eps (1 + |g1| + |g2|)` relative to its raw output, which
//! `(K^+)'` (`= peak A' S`, the inverse filter) maps back to about
//! `||K^+|| eps ||g||`, with `||g|| <= sqrt(L) ||r||`. With `||K x|| <=
//! sqrt(L) ||x||` and `||r|| <= sqrt(L) ||x|| + ||y||`, each is at most
//! `eps ||K^+|| (L ||x|| + sqrt(L) ||y||)`, and
//!
//! ```text
//! floor = 2 sqrt(n) eps ||K^+|| (L ||x|| + sqrt(L) ||y||)
//! ```
//!
//! (`2`: the forward and the adjoint error; `sqrt(n)`: a worst-case
//! allowance for the length-`n` recursions and norm sums accumulating their
//! rounding incoherently). A one-ulp change of the iterate moves `delta` by
//! at most `||(K^+)' K' K|| eps ||x|| = sqrt(L) eps ||x||`, inside the same
//! bound. `x` and `y` are in solver units (the trace divided by the
//! prescale), the units of `||delta||`. Measured on the simulation presets
//! (30 s cells at 15, 30 and 60 Hz) the floor is 6e-14 to 4e-9 (GCaMP6s at
//! 60 Hz) against bounds of 2e-4 to 1e-2, at least 8e5 times larger: a
//! solve that is still converging improves by far more than the floor
//! within any window, and the floor's constant factors would have to be off
//! by about six orders of magnitude before it could matter.
//!
//! *The window.* FISTA is not monotone: between restarts its momentum can
//! carry the iterate along a plateau or overshoot, and with the
//! gradient-mapping restart the period between restarts is about
//! `e sqrt(kappa)` iterations, `kappa = L ||K^+||^2` (O'Donoghue & Candes
//! 2015, the optimal fixed restart interval). A plateau shorter than one such
//! period is a transient, not a stall, so the window spans one period in
//! checks, `W = ceil(e sqrt(kappa) / BATCH)`, and at least
//! [`MIN_STALL_WINDOW`] checks ([`stall_window`]). The window is counted from
//! the running best: a check that does not beat it by more than the floor
//! does not reset the count, so a creep below the floor per check cannot
//! keep the solve alive, while a creep that adds up to more than the floor
//! within the window does. On the simulation presets `W` runs from 3 checks
//! (jGCaMP8f at 15 Hz) through 12 (GCaMP6f at 30 Hz) to 564 (GCaMP6s at
//! 60 Hz, 28,000 iterations).
//!
//! The detector can only stop a solve before the certificate does, so a
//! solve the certificate stops is unchanged unless the detector would have
//! fired first. Measured on every simulation preset at 15, 30 and 60 Hz
//! (the solves of the `indeca` test
//! `native_solve_stops_on_the_certificate_at_15_30_and_60_hz`, which asserts
//! the certificate fired), the longest run of checks without a floor-sized
//! improvement before the certificate fired was 9 against a window of 564
//! (GCaMP6s at 60 Hz), at most 4 elsewhere, and 0 wherever the window is
//! 16 or less: it never comes near firing on a converging solve.
//!
//! *The cap* stays as the outer guard against runaway time, derived from the
//! problem by [`iteration_cap`]: FISTA's worst-case count for the true
//! remaining movement to fall under the bound, from `F(x_k) - F* <=
//! 2 L ||x_0 - x*||^2 / (k + 1)^2` and step 2 above, `||K x_k - K x*|| <=
//! 2 sqrt(L) ||x_0 - x*|| / (k + 1)`, with `||x_0 - x*|| <= sqrt(n)` on the
//! box from `x_0 = 0` and `tau` taken at the initial residual (where it is
//! smallest, since `tau` grows as the fit improves). It is loose by the box
//! worst case and grows as `sqrt(n)`: it is in the 1e5-1e9 range (measured
//! 3e5-3e8 on 30 s preset cells at 15, 30 and 60 Hz, larger on longer
//! recordings), two to six orders of magnitude above the iterations the
//! certificate needs (50-12,400 on those cells), so in practice it is not
//! reached and `converged = false` comes from the stall detector. (The caller's
//! `max_iters`, sized for the upsampled solve whose fixed budget acted as a
//! regularizer, is only a floor on it.)
use crate::banded::BandedAR2;

/// Iterations between certificate checks.
///
/// A check ([`certify`]) costs about one FISTA iteration: a forward and an
/// adjoint AR(2) pass plus the 3-tap inverse filter, all O(n). Checking
/// every `B` iterations of a solve that needs `N` costs `N / B` extra
/// iteration-equivalents plus, on average, `B / 2` iterations of overshoot
/// past the first iterate that would have passed; `N / B + B / 2` is
/// smallest at `B = sqrt(2 N)`, about 45 for the typical `N ~ 1,000`
/// iterations at 30 Hz (400-4,000 measured). The minimum is flat: 50 costs
/// under 1% of the solve more than 45 there, and at 60 Hz on GCaMP6s
/// (`N ~ 30,000`, optimum about 245) the checks cost about 2% of the solve.
/// The certificate is valid at any iterate, so `B` does not change what a
/// stop guarantees, but it decides *where* the loop stops (the first
/// multiple of `B` at which the certificate holds), so the output depends
/// on this granularity: it is a fixed constant, not a knob. (Unlike
/// `py_api::BATCH_SIZE`, which only sets how often control returns to the
/// caller between `Solver::step_batch` calls whose stop rule is tested at
/// every iteration, so the output does not depend on it.) The stall window
/// ([`stall_window`]) is counted in these checks.
const BATCH: u32 = 50;

/// Fewest checks the stall window may span ([`stall_window`]): a single
/// check without a floor-sized improvement can be one momentum transient
/// straddling a check boundary (the restart period is not aligned with the
/// check grid), so a stall needs that run to extend over a full check
/// interval on both sides of the boundary: three checks.
const MIN_STALL_WINDOW: u32 = 3;

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
    /// The certificate's bound stopped improving by more than its own
    /// arithmetic floor over the stall window ([`StallDetector`]): the
    /// certificate cannot be met in f64. Not converged.
    Stall,
    /// The iteration cap. Not converged.
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
        !matches!(self.reason, StopReason::Cap | StopReason::Stall)
    }
}

/// Number of consecutive certificate checks without a floor-sized
/// improvement that make a stall: one momentum/restart period of FISTA,
/// `e sqrt(kappa)` iterations with `kappa = L ||K^+||^2` (O'Donoghue &
/// Candes 2015), in checks of [`BATCH`] iterations, and at least
/// [`MIN_STALL_WINDOW`] (module docs, "The window").
pub(crate) fn stall_window(banded: &BandedAR2) -> u32 {
    let kappa = banded.lipschitz() * banded.inverse_norm().powi(2);
    let checks = (std::f64::consts::E * kappa.sqrt() / BATCH as f64).ceil();
    if checks.is_nan() {
        return MIN_STALL_WINDOW;
    }
    // (`as` saturates: an infinite period gives u32::MAX, i.e. no stall.)
    (checks as u32).max(MIN_STALL_WINDOW)
}

/// Stops a certificate-mode solve whose bound has stalled above the
/// certificate (module docs, "When the certificate cannot be met").
pub(crate) struct StallDetector {
    /// Checks without a floor-sized improvement that make a stall.
    window: u32,
    /// `2 sqrt(n) eps ||K^+||`: the part of the floor fixed per solve.
    floor_scale: f64,
    lipschitz: f64,
    /// `sqrt(L) ||y||`, fixed per solve.
    data_term: f64,
    best: f64,
    since_best: u32,
}

impl StallDetector {
    pub(crate) fn new(banded: &BandedAR2, y: &[f64]) -> Self {
        let lipschitz = banded.lipschitz();
        let y_norm = y.iter().map(|v| v * v).sum::<f64>().sqrt();
        Self {
            window: stall_window(banded),
            floor_scale: 2.0 * (y.len() as f64).sqrt() * f64::EPSILON * banded.inverse_norm(),
            lipschitz,
            data_term: lipschitz.sqrt() * y_norm,
            best: f64::INFINITY,
            since_best: 0,
        }
    }

    /// The arithmetic floor of `||delta||` at an iterate of norm `x_norm`:
    /// `2 sqrt(n) eps ||K^+|| (L ||x|| + sqrt(L) ||y||)`.
    pub(crate) fn floor(&self, x_norm: f64) -> f64 {
        self.floor_scale * (self.lipschitz * x_norm + self.data_term)
    }

    /// Record one check's bound `remaining` at the iterate `x`; `true` once
    /// the window has passed without the running best improving by more
    /// than the floor. (A NaN bound never improves, so it stalls too.)
    pub(crate) fn observe(&mut self, remaining: f64, x: &[f64]) -> bool {
        let x_norm = x.iter().map(|v| v * v).sum::<f64>().sqrt();
        if remaining < self.best - self.floor(x_norm) {
            self.best = remaining;
            self.since_best = 0;
        } else {
            self.since_best += 1;
        }
        self.since_best >= self.window
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
/// disables it, and with it the stall detector) and the cap `max_iters`. `warm` seeds the iterate.
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
    let mut stall = stop.as_ref().map(|_| StallDetector::new(banded, y));
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
            if let Some(sd) = stall.as_mut() {
                if sd.observe(c.remaining, &x) {
                    reason = StopReason::Stall;
                    break;
                }
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
            // `se = 0` never certifies, so each run ends at its cap until the
            // bound reaches its f64 floor; there the stall detector stops it
            // unconverged (measured: at 5,250 iterations with the bound at
            // 3e-12, so the 8,000 run ends on the stall, its iterate already
            // as close as f64 resolves). Before the stall detector it ran
            // on to 8,000; the bound, distance and monotonicity
            // assertions below hold either way.
            if iters < 5000 {
                assert_eq!(r.reason, StopReason::Cap, "{iters}");
                assert_eq!(r.iterations, iters);
            } else {
                assert_eq!(r.reason, StopReason::Stall, "{iters}");
                assert!(!r.converged() && r.iterations < iters, "{iters}");
            }
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

    // ── Stall detector, active upper bound, operator norm ───────────────

    fn norm(v: &[f64]) -> f64 {
        v.iter().map(|a| a * a).sum::<f64>().sqrt()
    }

    #[test]
    fn stall_detector_stops_an_unattainable_certificate_unconverged() {
        // `se = 0`: the bound is 0, so the certificate can never fire. The
        // solve must stop on the stall detector once `||delta||` has reached
        // its own arithmetic floor, far below the cap, with
        // `converged = false` (and no panic).
        let (y, banded) = problem(300, 0xA11CE);
        let n = y.len();
        let cap = 5_000_000;
        let r = solve_box(&y, &banded, 0.0, cap, 0.0, Some(stop(n, 0.0)), None);
        assert_eq!(r.reason, StopReason::Stall);
        assert!(!r.converged());
        assert!(r.iterations < cap / 10, "{}", r.iterations);
        // It stopped at the floor, not on a momentum transient: the bound it
        // left is at or below the floor estimate (measured: 1.6e-13 against
        // a floor of 3.7e-11; the estimate is a conservative upper bound).
        let c = r.certificate.unwrap();
        let floor = StallDetector::new(&banded, &y).floor(norm(&r.x));
        assert!(c.remaining <= floor, "{} vs floor {floor}", c.remaining);
    }

    #[test]
    fn stall_window_spans_one_restart_period_and_has_a_minimum() {
        // W = ceil(e sqrt(kappa) / BATCH), kappa = L ||K^+||^2; slower
        // kernels (larger kappa) get longer windows, never fewer than the
        // minimum.
        let fast = BandedAR2::new(0.01, 0.1, 15.0);
        let slow = BandedAR2::new(0.1, 1.8, 60.0);
        assert_eq!(stall_window(&fast), MIN_STALL_WINDOW);
        let kappa = slow.lipschitz() * slow.inverse_norm().powi(2);
        let want = (std::f64::consts::E * kappa.sqrt() / BATCH as f64).ceil() as u32;
        assert_eq!(stall_window(&slow), want);
        assert!(want > 50, "{want}");
    }

    #[test]
    fn inverse_norm_bounds_and_is_attained_by_the_inverse_adjoint() {
        // ||(K^+)' m|| <= inverse_norm ||m||, with near-equality on the
        // alternating sequence (w = pi, where |A| peaks).
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let n = 400;
        let mut out = vec![0.0; n];
        for seed in [1, 2, 3] {
            let m = lcg(n, 1.0, seed);
            banded.inverse_adjoint_f64(&m, &mut out);
            assert!(norm(&out) <= banded.inverse_norm() * norm(&m) * (1.0 + 1e-12));
        }
        let alt: Vec<f64> = (0..n)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        banded.inverse_adjoint_f64(&alt, &mut out);
        let ratio = norm(&out) / (banded.inverse_norm() * norm(&alt));
        assert!(ratio > 0.99 && ratio <= 1.0 + 1e-12, "{ratio}");
    }

    #[test]
    fn certificate_accounts_for_an_active_upper_bound() {
        // Spikes of mass 2 on a Box[0, 1] problem: the optimum pins those
        // frames at x = 1, where the gradient stays strictly negative (the
        // fit wants more). The certificate clips the KKT residual to the
        // admissible sign there (`m_i = min(-g_i, 0) = 0`), so it still
        // bounds the remaining movement along the run and vanishes at the
        // optimum, though the unclipped residual does not.
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let n = 600;
        let mut s = vec![0.0_f64; n];
        let pinned = [60usize, 200, 330, 470];
        for &p in &pinned {
            s[p] = 2.0;
        }
        s[130] = 0.4;
        s[400] = 0.6;
        let mut y = vec![0.0_f64; n];
        banded.convolve_forward_f64(&s, &mut y);
        for (v, e) in y.iter_mut().zip(lcg(n, 0.01, 0xC0FFEE)) {
            *v += e;
        }
        let far = solve_box(&y, &banded, 0.0, 200_000, 1e-14, None, None);
        for &p in &pinned {
            assert_eq!(far.x[p], 1.0, "frame {p} not at the upper bound");
        }
        let mut k_far = vec![0.0; n];
        banded.convolve_forward_f64(&far.x, &mut k_far);
        // At the far solve's iterate the certificate is tiny, while the
        // unclipped KKT residual at the pinned frames is not.
        let (mut conv, mut resid, mut grad) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        let c_far = certify(
            &far.x,
            &y,
            &banded,
            0.0,
            &stop(n, 0.0),
            &mut conv,
            &mut resid,
            &mut grad,
        );
        let r_far: Vec<f64> = k_far.iter().zip(&y).map(|(a, b)| a - b).collect();
        let mut g_far = vec![0.0; n];
        banded.convolve_adjoint_f64(&r_far, &mut g_far);
        let unclipped_min = pinned
            .iter()
            .map(|&p| -g_far[p])
            .fold(f64::INFINITY, f64::min);
        assert!(
            unclipped_min > 1e3 * c_far.remaining.max(1e-12),
            "{unclipped_min} vs {}",
            c_far.remaining
        );
        // Along the run, with the bound active: the certificate bounds the
        // remaining movement of the reconstruction.
        for iters in [600, 1000, 2000, 3000] {
            let r = solve_box(&y, &banded, 0.0, iters, 0.0, Some(stop(n, 0.0)), None);
            assert!(r.x.contains(&1.0), "{iters}: no active bound");
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
        }
    }
}
