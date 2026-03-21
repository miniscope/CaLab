/// Two-component bi-exponential fitting: extract tau_rise and tau_decay from a free-form kernel.
///
/// # Physical motivation
///
/// Iterative deconvolution alternates between two steps:
///   1. **Spike solve**: given a kernel K, find spikes s that explain the trace y ≈ K*s + b
///   2. **Kernel solve**: given spikes s, re-estimate the free-form kernel h_free
///
/// The spike solver detects events by correlating the trace with the current kernel.
/// Where noise happens to correlate with the kernel's rising edge (bins 1-3), the
/// solver produces false-positive spikes. When these spurious spikes are fed back
/// into kernel estimation, they imprint an artifact onto h_free whose shape is
/// determined by the noise autocorrelation structure, not the calcium kernel's
/// time constants.
///
/// A single biexponential fit would try to explain both the true calcium kernel and
/// this artifact with one curve, causing tau_rise to collapse toward zero. The
/// two-component model explicitly separates them.
///
/// # Model
///
/// Fits h(t) = beta_s * T_s(t) + beta_f * T_f(t)
/// where:
/// - **Slow component** (calcium kernel): T_s(t) = exp(-t/tau_d) - exp(-t/tau_r)
/// - **Fast component** (noise artifact):  T_f(t) = exp(-t/tau_d_fast) - exp(-t/tau_r_fast)
///
/// The fast component has independent time constants (tau_r_fast, tau_d_fast),
/// decoupled from the slow component. This avoids the oscillation problem that
/// occurred when the fast component was parameterized as a uniform time-scaling
/// of the slow component (tau_r*r, tau_d*r) — with large tau_d the fast template's
/// decay would extend too far, overlapping the calcium rise.
///
/// Both components are 0 at t=0 by the biexponential identity (exp(0)-exp(0)=0),
/// so no skip or null hacks are needed at bin 0.
///
/// When no artifact exists, beta_f converges to ~0, recovering the single-biexp result.
///
/// Uses grid search over (tau_r, tau_d, tau_r_fast, tau_d_fast) with 2-variable NNLS
/// for (beta_s, beta_f), optionally refined by golden-section search. Supports warm-
/// starting from a previous result.
///
/// # Sequential-ceiling on the fast component
///
/// In the iterative deconvolution loop, the slow component's tau_rise starts
/// too high and gradually converges to the true value.  While it is still
/// converging, the slow template under-predicts the kernel's rise, leaving
/// a residual that the fast template can absorb.  Because the joint NNLS
/// optimizes both amplitudes simultaneously, the fast component can "steal"
/// slow-component amplitude — the overall fit improves on the current
/// (still-evolving) kernel, but both components drift from their true values.
///
/// To prevent this we compute a **sequential estimate** of beta_f at each
/// grid point: first fit the slow component alone (beta_s = <h, T_s> / <T_s, T_s>),
/// then fit the fast component to the slow residual:
///
///   bf_seq = max(0,  (<h, T_f> − beta_s · <T_s, T_f>) / <T_f, T_f>)
///
/// This gives the fast component's amplitude if it could only explain what
/// the slow template at this grid point leaves behind — it cannot steal
/// slow amplitude.  The joint NNLS is then gated with  bf ≤ bf_seq × HEADROOM,
/// which lets the joint solve redistribute some amplitude (essential — the
/// fast component must absorb the artifact so the slow component doesn't
/// distort) while preventing unbounded redistribution.
///
/// Key properties:
///   • Self-contained: computed from the same inner products already
///     available inside eval_two_component — zero extra O(n) work.
///   • Self-calibrating: large artifact → large residual → generous ceiling.
///   • Physically motivated: the fast component picks up features that
///     the slow component at this (tau_r, tau_d) genuinely cannot explain.
///   • No external state: works identically on iteration 1 and iteration N,
///     no dependence on warm-start or previous iteration history.
///
/// **TODO**: investigate whether this sequential ceiling is still necessary
/// now that the fast grid ranges have been tightened (tau_r_fast ≤ 2×dt,
/// tau_d_fast ≤ min(8×dt, tau_d×0.15), sub-sample floors).  The original
/// slow/fast mixing problem may have been caused entirely by the fast grid
/// floors being too high (tau_r_fast ≥ dt, tau_d_fast ≥ 2×dt), which at
/// low sampling rates left almost no search range and forced wide fast
/// templates that overlapped heavily with the slow component.  If removing
/// the ceiling with the current grid ranges does not reintroduce mixing,
/// the ceiling logic in eval_two_component can be simplified back to a
/// plain `bs >= bf` gate.

#[derive(Clone)]
#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct BiexpResult {
    pub tau_rise: f64,
    pub tau_decay: f64,
    pub beta: f64,
    pub residual: f64,
    pub tau_rise_fast: f64,
    pub tau_decay_fast: f64,
    pub beta_fast: f64,
}

impl BiexpResult {
    fn sentinel() -> Self {
        BiexpResult {
            tau_rise: 0.02,
            tau_decay: 0.4,
            beta: 0.0,
            residual: f64::INFINITY,
            tau_rise_fast: 0.0,
            tau_decay_fast: 0.0,
            beta_fast: 0.0,
        }
    }

    /// Returns true if the fit includes a fast component.
    pub fn has_fast_component(&self) -> bool {
        self.tau_rise_fast > 0.0 && self.tau_decay_fast > self.tau_rise_fast
    }
}

/// Fit a two-component bi-exponential model to a free-form kernel.
///
/// Uses a 20×20×(5×8+1) grid search over (tau_r, tau_d, tau_r_fast, tau_d_fast)
/// with 2-variable NNLS at each grid point, followed by optional golden-section
/// refinement. When `warm_start` is provided, skips the grid and refines directly
/// from the previous result's parameters.
///
/// Arguments:
/// - `h_free`: the free-form kernel to fit (from estimate_free_kernel)
/// - `fs`: sampling rate used for the kernel
/// - `refine`: whether to apply golden-section refinement after grid search
/// - `skip`: number of early kernel samples to exclude from the least-squares fit
/// - `warm_start`: optional previous BiexpResult to warm-start refinement from
pub fn fit_biexponential(
    h_free: &[f32],
    fs: f64,
    refine: bool,
    skip: usize,
    warm_start: Option<&BiexpResult>,
) -> BiexpResult {
    let n = h_free.len();
    let skip = skip.min(n.saturating_sub(1));
    if n == 0 {
        return BiexpResult::sentinel();
    }

    let dt = 1.0 / fs;

    // Always run cold grid search so the fast component can be discovered
    // at any iteration (the artifact builds up over the spike↔kernel loop).
    // The grid is ~16k O(n) evals — negligible vs kernel FISTA.
    let (mut best_slow, mut best_two) = cold_grid_search(h_free, fs, dt, skip);

    if refine {
        refine_candidate(h_free, &mut best_slow, dt, 40, skip);
        if best_two.residual < f64::INFINITY {
            refine_candidate(h_free, &mut best_two, dt, 40, skip);
        }
    }

    // If warm-start provided, also refine from previous values as an
    // additional candidate. This gives faster convergence when the kernel
    // is evolving smoothly between iterations.
    if let Some(warm) = warm_start {
        let mut warm_candidate = warm.clone();
        // Re-evaluate on the CURRENT h_free (warm residual was from previous h_free)
        let (bs, bf, res) = eval_two_component(
            h_free,
            warm_candidate.tau_rise,
            warm_candidate.tau_decay,
            warm_candidate.tau_rise_fast,
            warm_candidate.tau_decay_fast,
            dt,
            skip,
        );
        warm_candidate.beta = bs;
        warm_candidate.beta_fast = bf;
        warm_candidate.residual = res;

        if refine {
            refine_candidate(h_free, &mut warm_candidate, dt, 40, skip);
        }
        // Warm candidate competes with the appropriate track
        if warm_candidate.has_fast_component() {
            if warm_candidate.residual < best_two.residual {
                best_two = warm_candidate;
            }
        } else if warm_candidate.residual < best_slow.residual {
            best_slow = warm_candidate;
        }
    }

    // Pick whichever path (slow-only or two-component) achieved the lowest
    // residual after independent refinement. Both were grid-searched and
    // golden-section refined separately, so the better fit wins naturally.
    let mut best = if best_two.residual < best_slow.residual {
        best_two
    } else {
        best_slow
    };

    // Recompute residual over the FULL kernel (skip=0) so it captures early-bin
    // divergence. When skip=0 this is a no-op (both components are 0 at t=0).
    if skip > 0 {
        let (_, _, full_residual) = eval_two_component(
            h_free,
            best.tau_rise,
            best.tau_decay,
            best.tau_rise_fast,
            best.tau_decay_fast,
            dt,
            0,
        );
        best.residual = full_residual;
    }

    best
}

/// Refine a candidate BiexpResult in-place via golden-section search.
fn refine_candidate(
    h_free: &[f32],
    candidate: &mut BiexpResult,
    dt: f64,
    max_steps: usize,
    skip: usize,
) {
    let (refined_tr, refined_td, refined_trf, refined_tdf) =
        golden_section_refine(h_free, candidate, dt, max_steps, skip);
    let (beta_s, beta_f, residual) = eval_two_component(
        h_free,
        refined_tr,
        refined_td,
        refined_trf,
        refined_tdf,
        dt,
        skip,
    );
    if residual < candidate.residual {
        *candidate = BiexpResult {
            tau_rise: refined_tr,
            tau_decay: refined_td,
            beta: beta_s,
            residual,
            tau_rise_fast: refined_trf,
            tau_decay_fast: refined_tdf,
            beta_fast: beta_f,
        };
    }
}

/// Cold-start grid search. Returns (best_slow_only, best_two_component).
fn cold_grid_search(h_free: &[f32], fs: f64, dt: f64, skip: usize) -> (BiexpResult, BiexpResult) {
    // Slow component grid ranges (in seconds).
    let tau_r_lo = (1.0 / fs).max(0.005_f64);
    let tau_r_hi = 0.5_f64;
    let tau_d_lo = 0.05_f64;
    let tau_d_hi = 5.0_f64;

    let grid_n = 20;
    let log_tr_lo = tau_r_lo.ln();
    let log_tr_hi = tau_r_hi.ln();
    let log_td_lo = tau_d_lo.ln();
    let log_td_hi = tau_d_hi.ln();

    // Fast component grid: independent (tau_r_fast, tau_d_fast)
    //
    // Concrete bounds at representative sampling rates:
    //
    //   fs=30Hz  (dt=33.3ms): tau_r_fast ∈ [8.3, 66.7] ms
    //                          tau_d_fast ∈ [16.7, min(267, tau_d×0.15)] ms
    //                          e.g. tau_d=348ms → tau_d_fast ∈ [16.7, 52.2] ms
    //
    //   fs=100Hz (dt=10ms):   tau_r_fast ∈ [2.5, 20] ms
    //                          tau_d_fast ∈ [5.0, min(80, tau_d×0.15)] ms
    //                          e.g. tau_d=500ms → tau_d_fast ∈ [5.0, 75] ms
    //
    // tau_r_fast: 5 points linearly spaced in [0.25×dt, 2×dt]
    // tau_d_fast: 8 points log-spaced in [0.5×dt, min(8×dt, tau_d × 0.15)]
    //   - sub-sample floors (0.25×dt, 0.5×dt) let the grid represent very
    //     narrow transients that occupy only 1-3 bins — critical at low
    //     sampling rates where the noise artifact is essentially a spike
    //   - tau_r_fast upper cap (2×dt) prevents the fast rise from approaching
    //     the slow tau_r, which would make the templates collinear
    //   - relative cap (tau_d × 0.15) prevents the fast template's decay
    //     from extending into the slow component's domain
    //
    // TODO: revisit whether these bounds should depend on dt at all, or
    // whether fixed absolute limits in milliseconds would be more physically
    // meaningful.  The noise artifact's shape comes from the noise
    // autocorrelation structure, which has a characteristic timescale
    // independent of the sampling rate.  dt-relative bounds were chosen
    // pragmatically (the artifact occupies 1-3 discrete bins), but the
    // underlying physics may justify fixed ms bounds (e.g. tau_r_fast ≤ 20ms,
    // tau_d_fast ≤ 60ms) that would behave more consistently across sampling
    // rates.
    let trf_grid_n = 5;
    let tdf_grid_n = 8;
    let trf_lo = 0.25 * dt;
    let trf_hi = 2.0 * dt;
    let tdf_lo = 0.5 * dt;
    let tdf_abs_hi = 8.0 * dt;

    let mut best_slow = BiexpResult::sentinel();
    let mut best_two = BiexpResult::sentinel();

    for i in 0..grid_n {
        let log_tr = log_tr_lo + (log_tr_hi - log_tr_lo) * i as f64 / (grid_n - 1) as f64;
        let tau_r = log_tr.exp();

        for j in 0..grid_n {
            let log_td = log_td_lo + (log_td_hi - log_td_lo) * j as f64 / (grid_n - 1) as f64;
            let tau_d = log_td.exp();

            // Enforce tau_d > tau_r
            if tau_d <= tau_r {
                continue;
            }

            // Slow-only evaluation at this (tau_r, tau_d) grid point
            let (beta_s, _, residual) =
                eval_two_component(h_free, tau_r, tau_d, 0.0, 0.0, dt, skip);
            if residual < best_slow.residual {
                best_slow = BiexpResult {
                    tau_rise: tau_r,
                    tau_decay: tau_d,
                    beta: beta_s,
                    residual,
                    tau_rise_fast: 0.0,
                    tau_decay_fast: 0.0,
                    beta_fast: 0.0,
                };
            }

            // Inner grid: scan independent (tau_r_fast, tau_d_fast)
            // Upper bound for tau_d_fast is the tighter of the absolute cap
            // (8×dt) and a relative cap (tau_d × 0.15) to prevent degeneracy.
            let tdf_hi = tdf_abs_hi.min(tau_d * 0.15);
            if tdf_hi <= tdf_lo {
                continue; // tau_d too small for a distinct fast component
            }
            let log_tdf_lo = tdf_lo.ln();
            let log_tdf_hi = tdf_hi.ln();

            for ki in 0..trf_grid_n {
                let tau_r_fast = trf_lo + (trf_hi - trf_lo) * ki as f64 / (trf_grid_n - 1) as f64;

                for kj in 0..tdf_grid_n {
                    let log_tdf = log_tdf_lo
                        + (log_tdf_hi - log_tdf_lo) * kj as f64 / (tdf_grid_n - 1) as f64;
                    let tau_d_fast = log_tdf.exp();

                    // Skip when tau_d_fast ≤ tau_r_fast
                    if tau_d_fast <= tau_r_fast {
                        continue;
                    }

                    let (beta_s, beta_f, residual) =
                        eval_two_component(h_free, tau_r, tau_d, tau_r_fast, tau_d_fast, dt, skip);
                    if residual < best_two.residual {
                        best_two = BiexpResult {
                            tau_rise: tau_r,
                            tau_decay: tau_d,
                            beta: beta_s,
                            residual,
                            tau_rise_fast: tau_r_fast,
                            tau_decay_fast: tau_d_fast,
                            beta_fast: beta_f,
                        };
                    }
                }
            }
        }
    }

    (best_slow, best_two)
}

/// Evaluate two-component fit at fixed (tau_r, tau_d, tau_r_fast, tau_d_fast) with NNLS for (beta_s, beta_f).
///
/// Model: h(t) = beta_s * (exp(-t/tau_d) - exp(-t/tau_r))
///              + beta_f * (exp(-t/tau_d_fast) - exp(-t/tau_r_fast))
///
/// The fast component has independent time constants, decoupled from the slow component.
/// Both are 0 at t=0 by construction.
///
/// For fixed time constants, this is a 2-variable non-negative least squares problem.
/// We enumerate all 4 active sets and pick the one with minimum residual.
///
/// The sequential ceiling on beta_f (see module doc) is computed internally
/// from the same inner products — no external state required.
///
/// Returns (beta_s, beta_f, residual).
fn eval_two_component(
    h_free: &[f32],
    tau_r: f64,
    tau_d: f64,
    tau_r_fast: f64,
    tau_d_fast: f64,
    dt: f64,
    skip: usize,
) -> (f64, f64, f64) {
    let n = h_free.len();

    // Gram matrix G (2x2), rhs vector (2x1), and ||h||^2
    let mut g_ss = 0.0_f64; // <T_s, T_s>
    let mut g_ff = 0.0_f64; // <T_f, T_f>
    let mut g_sf = 0.0_f64; // <T_s, T_f>
    let mut rhs_s = 0.0_f64; // <h, T_s>
    let mut rhs_f = 0.0_f64; // <h, T_f>
    let mut dot_hh = 0.0_f64; // <h, h>

    let fast_active = tau_r_fast > 1e-10 && tau_d_fast > tau_r_fast;

    for i in skip..n {
        let t = i as f64 * dt;
        let ts = (-t / tau_d).exp() - (-t / tau_r).exp();
        let tf = if fast_active {
            (-t / tau_d_fast).exp() - (-t / tau_r_fast).exp()
        } else {
            0.0
        };
        let hi = h_free[i] as f64;

        g_ss += ts * ts;
        g_ff += tf * tf;
        g_sf += ts * tf;
        rhs_s += hi * ts;
        rhs_f += hi * tf;
        dot_hh += hi * hi;
    }

    // Sequential ceiling: fit slow alone first, then ask how much fast
    // component the slow residual warrants.
    //   beta_s_solo = <h, T_s> / <T_s, T_s>
    //   bf_seq = max(0, (<h, T_f> - beta_s_solo * <T_s, T_f>) / <T_f, T_f>)
    // This is what beta_f would be if it could only explain what the slow
    // template at this grid point leaves behind.  The joint NNLS is capped
    // at bf_seq × HEADROOM so it can redistribute some amplitude but cannot
    // steal unboundedly from the slow component.
    const BF_HEADROOM: f64 = 2.0;
    let bf_ceiling = if fast_active && g_ss > 1e-30 && g_ff > 1e-30 {
        let bs_solo = (rhs_s / g_ss).max(0.0);
        ((rhs_f - bs_solo * g_sf) / g_ff).max(0.0) * BF_HEADROOM
    } else {
        f64::INFINITY
    };

    // Compute residual: ||h - beta_s*T_s - beta_f*T_f||^2
    // = ||h||^2 - 2*beta_s*<h,T_s> - 2*beta_f*<h,T_f>
    //   + beta_s^2*<T_s,T_s> + 2*beta_s*beta_f*<T_s,T_f> + beta_f^2*<T_f,T_f>
    let residual_fn = |bs: f64, bf: f64| -> f64 {
        dot_hh - 2.0 * bs * rhs_s - 2.0 * bf * rhs_f
            + bs * bs * g_ss
            + 2.0 * bs * bf * g_sf
            + bf * bf * g_ff
    };

    let mut best_bs = 0.0;
    let mut best_bf = 0.0;
    let mut best_res = dot_hh; // residual when both are zero

    // Active set 1: both free — solve 2x2 system via Cramer's rule
    // Gates: bs >= 0, bf >= 0, bs >= bf (slow dominates), bf <= bf_ceiling
    // (residual-guided ceiling from previous slow response).
    let det = g_ss * g_ff - g_sf * g_sf;
    if det.abs() > 1e-30 {
        let bs = (rhs_s * g_ff - rhs_f * g_sf) / det;
        let bf = (rhs_f * g_ss - rhs_s * g_sf) / det;
        if bs >= 0.0 && bf >= 0.0 && bs >= bf && bf <= bf_ceiling {
            let r = residual_fn(bs, bf);
            if r < best_res {
                best_bs = bs;
                best_bf = bf;
                best_res = r;
            }
        }
    }

    // Active set 1b: if the unconstrained joint solve exceeded the ceiling,
    // try clamping bf to the ceiling and re-solving for bs.  This gives the
    // joint solve the best possible fit within the ceiling constraint rather
    // than falling all the way back to slow-only.
    if det.abs() > 1e-30 && bf_ceiling < f64::INFINITY {
        let bf_clamped = bf_ceiling;
        // bs that minimises residual with bf fixed at ceiling:
        // d/d(bs) [... ] = 0  →  bs = (rhs_s - bf_clamped * g_sf) / g_ss
        if g_ss > 1e-30 {
            let bs = ((rhs_s - bf_clamped * g_sf) / g_ss).max(0.0);
            if bs >= bf_clamped {
                let r = residual_fn(bs, bf_clamped);
                if r < best_res {
                    best_bs = bs;
                    best_bf = bf_clamped;
                    best_res = r;
                }
            }
        }
    }

    // Active set 2: beta_s only (beta_f = 0)
    if g_ss > 1e-30 {
        let bs = rhs_s / g_ss;
        if bs >= 0.0 {
            let r = residual_fn(bs, 0.0);
            if r < best_res {
                best_bs = bs;
                best_bf = 0.0;
                best_res = r;
            }
        }
    }

    // Active set 3 (beta_f only) is NOT tried: the fast component is a correction
    // for noise artifacts and should never appear without the slow component.

    // Active set 4: both zero — already covered by initial best_res = dot_hh

    (best_bs, best_bf, best_res)
}

/// Run one golden-section narrowing pass on a 1D interval [lo, hi].
/// `cost` takes a candidate value and returns the residual.
/// Returns the midpoint of the narrowed interval.
fn golden_bracket(mut lo: f64, mut hi: f64, cost: impl Fn(f64) -> f64) -> f64 {
    const PHI: f64 = 0.6180339887498949; // (sqrt(5) - 1) / 2
    for _ in 0..10 {
        let x1 = hi - PHI * (hi - lo);
        let x2 = lo + PHI * (hi - lo);
        if cost(x1) < cost(x2) {
            hi = x2;
        } else {
            lo = x1;
        }
    }
    (lo + hi) / 2.0
}

/// Golden-section refinement around the best grid point.
/// Cycles through refining tau_r, tau_d, tau_r_fast, and tau_d_fast for `max_steps` total.
fn golden_section_refine(
    h_free: &[f32],
    best: &BiexpResult,
    dt: f64,
    max_steps: usize,
    skip: usize,
) -> (f64, f64, f64, f64) {
    let mut tau_r = best.tau_rise;
    let mut tau_d = best.tau_decay;
    let mut tau_r_fast = best.tau_rise_fast;
    let mut tau_d_fast = best.tau_decay_fast;

    let has_fast = best.has_fast_component();
    let n_phases = if has_fast { 4 } else { 2 };

    for step in 0..max_steps {
        match step % n_phases {
            0 => {
                // Refine tau_r
                let lo = (tau_r * 0.5).max(dt);
                let hi = (tau_r * 2.0).min(tau_d * 0.99);
                if lo < hi {
                    tau_r = golden_bracket(lo, hi, |x| {
                        eval_two_component(h_free, x, tau_d, tau_r_fast, tau_d_fast, dt, skip).2
                    });
                }
            }
            1 => {
                // Refine tau_d
                let lo = (tau_d * 0.5).max(tau_r * 1.01);
                let hi = tau_d * 2.0;
                if lo < hi {
                    tau_d = golden_bracket(lo, hi, |x| {
                        eval_two_component(h_free, tau_r, x, tau_r_fast, tau_d_fast, dt, skip).2
                    });
                }
            }
            2 => {
                // Refine tau_r_fast
                let lo = (tau_r_fast * 0.5).max(0.1 * dt);
                let hi = (tau_r_fast * 2.0).min((2.0 * dt).min(tau_d_fast * 0.99));
                if lo < hi {
                    tau_r_fast = golden_bracket(lo, hi, |x| {
                        eval_two_component(h_free, tau_r, tau_d, x, tau_d_fast, dt, skip).2
                    });
                }
            }
            _ => {
                // Refine tau_d_fast
                let lo = (tau_d_fast * 0.5).max(tau_r_fast * 1.01);
                let hi = (tau_d_fast * 2.0).min((8.0 * dt).min(tau_d * 0.15));
                if lo < hi {
                    tau_d_fast = golden_bracket(lo, hi, |x| {
                        eval_two_component(h_free, tau_r, tau_d, tau_r_fast, x, dt, skip).2
                    });
                }
            }
        }
    }

    (tau_r, tau_d, tau_r_fast, tau_d_fast)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate a bi-exponential kernel with known parameters.
    fn make_biexp(tau_r: f64, tau_d: f64, beta: f64, fs: f64, n: usize) -> Vec<f32> {
        let dt = 1.0 / fs;
        (0..n)
            .map(|i| {
                let t = i as f64 * dt;
                (beta * ((-t / tau_d).exp() - (-t / tau_r).exp())) as f32
            })
            .collect()
    }

    /// Generate a two-component kernel with known parameters.
    /// Fast component has independent time constants (tau_r_fast, tau_d_fast).
    fn make_two_component(
        tau_r: f64,
        tau_d: f64,
        beta_s: f64,
        tau_r_fast: f64,
        tau_d_fast: f64,
        beta_f: f64,
        fs: f64,
        n: usize,
    ) -> Vec<f32> {
        let dt = 1.0 / fs;
        (0..n)
            .map(|i| {
                let t = i as f64 * dt;
                let slow = beta_s * ((-t / tau_d).exp() - (-t / tau_r).exp());
                let fast = beta_f * ((-t / tau_d_fast).exp() - (-t / tau_r_fast).exp());
                (slow + fast) as f32
            })
            .collect()
    }

    #[test]
    fn recovers_known_taus() {
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 30.0;
        let n = 60; // 2 seconds
        let h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        let result = fit_biexponential(&h, fs, true, 0, None);

        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        let td_err = (result.tau_decay - tau_d_true).abs() / tau_d_true;

        assert!(
            tr_err < 0.15,
            "Tau rise error {:.1}% (got {:.4}, expected {:.4})",
            tr_err * 100.0,
            result.tau_rise,
            tau_r_true
        );
        assert!(
            td_err < 0.15,
            "Tau decay error {:.1}% (got {:.4}, expected {:.4})",
            td_err * 100.0,
            result.tau_decay,
            tau_d_true
        );
    }

    #[test]
    fn clean_biexp_has_near_zero_beta_fast() {
        let h = make_biexp(0.08, 0.5, 2.0, 30.0, 60);
        let result = fit_biexponential(&h, 30.0, true, 0, None);

        // For a clean biexponential input, beta_fast should be negligible
        assert!(
            result.beta_fast < 0.1 * result.beta,
            "beta_fast ({:.4}) should be much smaller than beta ({:.4}) for clean biexp input",
            result.beta_fast,
            result.beta
        );
    }

    #[test]
    fn tau_d_greater_than_tau_r() {
        let h = make_biexp(0.05, 0.8, 1.5, 30.0, 60);
        let result = fit_biexponential(&h, 30.0, true, 0, None);

        assert!(
            result.tau_decay > result.tau_rise,
            "tau_d ({}) should be > tau_r ({})",
            result.tau_decay,
            result.tau_rise
        );
    }

    #[test]
    fn refinement_improves_fit() {
        let h = make_biexp(0.04, 0.6, 2.0, 30.0, 60);

        let coarse = fit_biexponential(&h, 30.0, false, 0, None);
        let refined = fit_biexponential(&h, 30.0, true, 0, None);

        assert!(
            refined.residual <= coarse.residual + 1e-10,
            "Refinement should not worsen fit: refined {} vs coarse {}",
            refined.residual,
            coarse.residual
        );
    }

    #[test]
    fn empty_kernel() {
        let result = fit_biexponential(&[], 30.0, true, 0, None);
        assert_eq!(result.residual, f64::INFINITY);
    }

    #[test]
    fn positive_beta() {
        let h = make_biexp(0.02, 0.4, 3.0, 30.0, 40);
        let result = fit_biexponential(&h, 30.0, false, 0, None);

        assert!(
            result.beta > 0.0,
            "Beta should be positive for standard calcium kernel, got {}",
            result.beta
        );
    }

    #[test]
    fn various_parameter_ranges() {
        // Test with fast dynamics
        let h_fast = make_biexp(0.01, 0.1, 1.0, 100.0, 50);
        let r = fit_biexponential(&h_fast, 100.0, true, 0, None);
        assert!(r.tau_decay > r.tau_rise);
        assert!(r.residual < 1.0); // should fit well

        // Test with slow dynamics
        let h_slow = make_biexp(0.1, 2.0, 1.0, 10.0, 50);
        let r = fit_biexponential(&h_slow, 10.0, true, 0, None);
        assert!(r.tau_decay > r.tau_rise);
    }

    #[test]
    fn skip_ignores_early_samples() {
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 30.0;
        let n = 60;
        let mut h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        // Corrupt first 3 samples with high-frequency noise
        h[0] = 10.0;
        h[1] = -5.0;
        h[2] = 8.0;

        // Without skip: noise biases the fit
        let no_skip = fit_biexponential(&h, fs, true, 0, None);

        // With skip=3: noise is excluded from fitting, tau estimates improve
        let with_skip = fit_biexponential(&h, fs, true, 3, None);

        let err_no_skip = (no_skip.tau_rise - tau_r_true).abs();
        let err_with_skip = (with_skip.tau_rise - tau_r_true).abs();

        assert!(
            err_with_skip < err_no_skip,
            "skip=3 should improve tau_rise fit: err_skip={:.4} vs err_noskip={:.4}",
            err_with_skip,
            err_no_skip
        );

        // The residual should be evaluated over the FULL kernel (including
        // corrupted bins), so it reflects the total mismatch. With corrupted
        // early bins, the full-kernel residual should be larger than the
        // residual from a clean kernel.
        let clean = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);
        let clean_result = fit_biexponential(&clean, fs, true, 3, None);
        assert!(
            with_skip.residual > clean_result.residual,
            "Corrupted kernel should have higher full-kernel residual: {:.6} vs {:.6}",
            with_skip.residual,
            clean_result.residual
        );
    }

    #[test]
    fn recovers_taus_with_fast_component() {
        // A typical calcium kernel with a small noise artifact: slow rise time
        // well above the fast template range, moderate artifact amplitude.
        // This mimics the real iterative deconvolution scenario where the artifact
        // is a minor correction, not a dominant signal.
        let tau_r_true = 0.08;
        let tau_d_true = 1.5; // large tau_d — the motivating case for independent fast params
        let fs = 100.0;
        let n = 500;
        let dt = 1.0 / fs;
        let tau_r_fast_true = dt;
        let tau_d_fast_true = 5.0 * dt;
        let h = make_two_component(
            tau_r_true,
            tau_d_true,
            2.0,
            tau_r_fast_true,
            tau_d_fast_true,
            0.8, // moderate artifact (40% of slow amplitude)
            fs,
            n,
        );

        let result = fit_biexponential(&h, fs, true, 0, None);

        // Slow tau_decay should be well-recovered (the primary benefit of this refactor)
        let td_err = (result.tau_decay - tau_d_true).abs() / tau_d_true;
        assert!(
            td_err < 0.30,
            "Tau decay error {:.1}% (got {:.4}, expected {:.4})",
            td_err * 100.0,
            result.tau_decay,
            tau_d_true
        );

        // tau_rise should be in the right ballpark
        assert!(
            result.tau_rise > 0.02 && result.tau_rise < 0.3,
            "tau_rise ({:.4}) should be in reasonable range for true={:.4}",
            result.tau_rise,
            tau_r_true
        );
    }

    #[test]
    fn fast_absorbs_noise_artifact() {
        // Simulate the actual deconvolution artifact: a fast biexponential
        // (compressed copy of the kernel from false-positive spikes) added
        // to the true slow kernel. The two-component fit should separate them.
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 100.0;
        let dt = 1.0 / fs;
        let n = 200;

        // Fast artifact: narrow biexponential at bins 1-3
        let tau_r_artifact = dt;
        let tau_d_artifact = 5.0 * dt;
        let h = make_two_component(
            tau_r_true,
            tau_d_true,
            2.0,
            tau_r_artifact,
            tau_d_artifact,
            1.5,
            fs,
            n,
        );

        let result = fit_biexponential(&h, fs, true, 0, None);

        // With two-component model, tau_rise should stay near true value
        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        assert!(
            tr_err < 0.5,
            "tau_rise should stay near true value with artifact: got {:.4} (err {:.1}%), expected {:.4}",
            result.tau_rise,
            tr_err * 100.0,
            tau_r_true
        );

        // The fast component should have picked up the artifact
        assert!(
            result.beta_fast > 0.0,
            "beta_fast should be positive to absorb the artifact"
        );
    }

    #[test]
    fn fast_tau_in_valid_range() {
        // For various inputs, verify fast component time constants are in expected ranges
        let test_cases = [(0.08, 0.5, 30.0), (0.05, 0.3, 100.0), (0.1, 2.0, 10.0)];

        for (tau_r, tau_d, fs) in test_cases {
            let h = make_biexp(tau_r, tau_d, 2.0, fs, 60);
            let result = fit_biexponential(&h, fs, true, 0, None);
            let dt = 1.0 / fs;

            if result.tau_rise_fast > 0.0 {
                assert!(
                    result.tau_decay_fast > result.tau_rise_fast,
                    "tau_d_fast ({}) should be > tau_r_fast ({}) for (tau_r={}, tau_d={}, fs={})",
                    result.tau_decay_fast,
                    result.tau_rise_fast,
                    tau_r,
                    tau_d,
                    fs
                );
                let tdf_cap = (8.0 * dt).min(tau_d * 0.15);
                assert!(
                    result.tau_decay_fast <= tdf_cap * 1.05,
                    "tau_d_fast ({:.6}) should be ≤ cap ({:.6}) for (tau_r={}, tau_d={}, fs={})",
                    result.tau_decay_fast,
                    tdf_cap,
                    tau_r,
                    tau_d,
                    fs
                );
            }
        }
    }

    #[test]
    fn nnls_active_sets() {
        let fs = 100.0;
        let dt = 1.0 / fs;
        let n = 100;
        let tau_r_fast = 2.0 * dt;
        let tau_d_fast = 8.0 * dt;

        // Case 1: Pure slow component — should yield beta_s > 0, beta_f ≈ 0
        let h_slow = make_biexp(0.05, 0.5, 2.0, fs, n);
        let (bs, bf, _) = eval_two_component(&h_slow, 0.05, 0.5, tau_r_fast, tau_d_fast, dt, 0);
        assert!(bs > 0.0, "beta_s should be positive for slow-only input");
        assert!(
            bf < 0.1 * bs,
            "beta_f ({:.4}) should be near zero for slow-only input (beta_s={:.4})",
            bf,
            bs
        );

        // Case 2: Pure fast component — the NNLS does NOT try
        // beta_f-only, so it falls back to beta_s-only (imperfect fit) or zero.
        // This is by design: the fast component is a correction, not a standalone signal.
        let h_fast: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 * dt;
                (3.0 * ((-t / tau_d_fast).exp() - (-t / tau_r_fast).exp())) as f32
            })
            .collect();
        let (bs, _bf, _) = eval_two_component(&h_fast, 0.05, 0.5, tau_r_fast, tau_d_fast, dt, 0);
        // With no fast-only active set, the slow template absorbs what it can
        assert!(bs >= 0.0, "beta_s should be non-negative for any input");

        // Case 3: Both components present
        let h_both = make_two_component(0.05, 0.5, 2.0, tau_r_fast, tau_d_fast, 1.5, fs, n);
        let (bs, bf, _) = eval_two_component(&h_both, 0.05, 0.5, tau_r_fast, tau_d_fast, dt, 0);
        assert!(bs > 0.0, "beta_s should be positive for mixed input");
        assert!(bf > 0.0, "beta_f should be positive for mixed input");

        // Case 4: Zero signal — both should be zero
        let h_zero = vec![0.0_f32; n];
        let (bs, bf, res) = eval_two_component(&h_zero, 0.05, 0.5, tau_r_fast, tau_d_fast, dt, 0);
        assert_eq!(bs, 0.0, "beta_s should be zero for zero input");
        assert_eq!(bf, 0.0, "beta_f should be zero for zero input");
        assert!(res < 1e-20, "residual should be ~0 for zero input");
    }

    #[test]
    fn warm_start_comparable_to_cold() {
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 30.0;
        let n = 60;
        let h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        let cold = fit_biexponential(&h, fs, true, 0, None);
        let warm = fit_biexponential(&h, fs, true, 0, Some(&cold));

        // Warm-started result should have residual within 5% of cold-start
        let ratio = warm.residual / (cold.residual + 1e-30);
        assert!(
            ratio < 1.05,
            "Warm-start residual ({:.6}) should be within 5% of cold-start ({:.6}), ratio={:.3}",
            warm.residual,
            cold.residual,
            ratio
        );
    }

    #[test]
    fn fast_confined_with_large_tau_d() {
        // Kernel with tau_d=1.5s at 30Hz — the motivating case for this refactor.
        // Verify tau_d_fast stays confined (≤ 15×dt) and doesn't absorb real signal.
        let tau_r_true = 0.05; // 50ms
        let tau_d_true = 1.5; // 1500ms
        let fs = 30.0;
        let dt = 1.0 / fs;
        let n = (5.0_f64 * tau_d_true * fs).ceil() as usize;
        let h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        let result = fit_biexponential(&h, fs, true, 0, None);

        // Slow component should recover the true kernel shape
        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        assert!(
            tr_err < 0.5,
            "tau_rise should be near true value: got {:.4} (err {:.1}%), expected {:.4}",
            result.tau_rise,
            tr_err * 100.0,
            tau_r_true
        );

        // If there's a fast component, it should be confined
        if result.tau_decay_fast > 0.0 {
            let tdf_cap = (8.0 * dt).min(tau_d_true * 0.15);
            assert!(
                result.tau_decay_fast <= tdf_cap * 1.05,
                "tau_d_fast ({:.6}s = {:.1} bins) should be ≤ cap ({:.6}s) for large tau_d",
                result.tau_decay_fast,
                result.tau_decay_fast / dt,
                tdf_cap
            );
        }
    }

    #[test]
    fn sequential_ceiling_limits_fast_on_clean_kernel() {
        // On a clean single-biexponential kernel (no artifact), the sequential
        // ceiling should prevent the fast component from claiming significant
        // amplitude.  The slow-only fit already explains the kernel well, so
        // its residual is small and bf_seq is near zero.
        let tau_r_true = 0.05;
        let tau_d_true = 0.5;
        let fs = 100.0;
        let n = 200;

        let h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);
        let result = fit_biexponential(&h, fs, true, 0, None);

        assert!(
            result.beta_fast < 0.15 * result.beta,
            "Sequential ceiling should keep beta_fast ({:.4}) small relative to beta ({:.4}) \
             on a clean kernel with no artifact",
            result.beta_fast,
            result.beta
        );
    }
}
