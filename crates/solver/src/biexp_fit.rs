/// Two-component bi-exponential fitting: extract tau_rise and tau_decay from a free-form kernel.
///
/// Fits h(t) = beta_s * (exp(-t/tau_d) - exp(-t/tau_r)) + beta_f * exp(-t/tau_f)
/// where:
/// - **Slow component** (biexp): real calcium kernel — tau_rise and tau_decay extracted here
/// - **Fast component** (exponential decay): absorbs noise artifact near t=0
///
/// The fast component uses a simple exponential exp(-t/τ_f). Since the kernel is a causal
/// impulse response with h(0)=0, bin 0 should be excluded from the fit (skip≥1). The fast
/// component absorbs the noise artifact at bins 1-3 that previously required skip=4.
///
/// When no artifact exists, beta_f converges to ~0, recovering the single-biexp result.
///
/// Uses grid search over (tau_r, tau_d, tau_f) with 2-variable NNLS for (beta_s, beta_f),
/// optionally refined by golden-section search.
///
/// # Why two components?
///
/// During iterative deconvolution, the free-form kernel develops a fast spike near t=0
/// from noise fitting. A single biexponential tries to explain both the real calcium
/// peak and this noise artifact with one curve, causing tau_rise to collapse toward 0.
/// The two-component model explicitly separates them: the fast component absorbs the
/// noise artifact while the slow component accurately captures the true calcium kernel.

#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct BiexpResult {
    pub tau_rise: f64,
    pub tau_decay: f64,
    pub beta: f64,
    pub residual: f64,
    pub tau_fast: f64,
    pub beta_fast: f64,
}

/// Fit a two-component bi-exponential model to a free-form kernel.
///
/// Uses a 20x20x8 log-spaced grid search over (tau_r, tau_d, tau_f) with
/// 2-variable NNLS at each grid point, followed by optional golden-section
/// refinement around the best grid point.
///
/// Arguments:
/// - `h_free`: the free-form kernel to fit (from estimate_free_kernel)
/// - `fs`: sampling rate used for the kernel
/// - `refine`: whether to apply golden-section refinement after grid search
/// - `skip`: number of early kernel samples to exclude from the least-squares fit
pub fn fit_biexponential(h_free: &[f32], fs: f64, refine: bool, skip: usize) -> BiexpResult {
    let n = h_free.len();
    let skip = skip.min(n.saturating_sub(1));
    if n == 0 {
        return BiexpResult {
            tau_rise: 0.02,
            tau_decay: 0.4,
            beta: 0.0,
            residual: f64::INFINITY,
            tau_fast: 0.0,
            beta_fast: 0.0,
        };
    }

    let dt = 1.0 / fs;

    // Grid search ranges (in seconds).
    // tau_r lower bound: at least 2 samples (Nyquist floor). A rise time shorter
    // than 2/fs is unresolvable and drives the iterative loop toward collapse.
    let tau_r_lo = (2.0 / fs).max(0.005_f64);
    let tau_r_hi = 0.5_f64;
    let tau_d_lo = 0.05_f64;
    let tau_d_hi = 5.0_f64;

    // tau_f range: fast component that peaks at t=0
    // Lower bound: at least 1 sample (1/fs) or 1ms
    // Upper bound: min(tau_r_lo, 50ms) — must be faster than the slowest rise time considered
    let tau_f_lo = (1.0 / fs).max(0.001);
    let tau_f_hi = tau_r_lo.min(0.05);
    let tau_f_grid_n = if tau_f_lo < tau_f_hi { 8 } else { 0 };

    let grid_n = 20;
    let log_tr_lo = tau_r_lo.ln();
    let log_tr_hi = tau_r_hi.ln();
    let log_td_lo = tau_d_lo.ln();
    let log_td_hi = tau_d_hi.ln();

    let mut best = BiexpResult {
        tau_rise: 0.02,
        tau_decay: 0.4,
        beta: 0.0,
        residual: f64::INFINITY,
        tau_fast: 0.0,
        beta_fast: 0.0,
    };

    // Phase 1: Grid search
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

            if tau_f_grid_n > 0 {
                // Scan tau_f values
                let log_tf_lo = tau_f_lo.ln();
                let log_tf_hi = tau_f_hi.ln();
                for k in 0..tau_f_grid_n {
                    let log_tf = log_tf_lo
                        + (log_tf_hi - log_tf_lo) * k as f64 / (tau_f_grid_n - 1) as f64;
                    let tau_f = log_tf.exp();

                    // Enforce tau_f < tau_r
                    if tau_f >= tau_r {
                        continue;
                    }

                    let (beta_s, beta_f, residual) =
                        eval_two_component(h_free, tau_r, tau_d, tau_f, dt, skip);
                    if residual < best.residual {
                        best = BiexpResult {
                            tau_rise: tau_r,
                            tau_decay: tau_d,
                            beta: beta_s,
                            residual,
                            tau_fast: tau_f,
                            beta_fast: beta_f,
                        };
                    }
                }
            } else {
                // No valid tau_f range — fit without fast component
                let (beta_s, _, residual) =
                    eval_two_component(h_free, tau_r, tau_d, dt, dt, skip);
                if residual < best.residual {
                    best = BiexpResult {
                        tau_rise: tau_r,
                        tau_decay: tau_d,
                        beta: beta_s,
                        residual,
                        tau_fast: 0.0,
                        beta_fast: 0.0,
                    };
                }
            }
        }
    }

    // Phase 2: Optional golden-section refinement
    if refine {
        let (refined_tr, refined_td, refined_tf) =
            golden_section_refine(h_free, &best, dt, 30, skip);
        let (beta_s, beta_f, residual) =
            eval_two_component(h_free, refined_tr, refined_td, refined_tf, dt, skip);
        if residual < best.residual {
            best = BiexpResult {
                tau_rise: refined_tr,
                tau_decay: refined_td,
                beta: beta_s,
                residual,
                tau_fast: refined_tf,
                beta_fast: beta_f,
            };
        }
    }

    // Recompute residual over the FULL kernel (skip=0) so it captures early-bin
    // divergence between the free kernel and the two-component template. The fit
    // itself was determined using skip..n to avoid noise bias, but the full-kernel
    // residual is a better overfitting metric: when iterations start explaining
    // noise rather than calcium, the early bins diverge and this residual rises.
    if skip > 0 {
        let (_, _, full_residual) = eval_two_component(
            h_free,
            best.tau_rise,
            best.tau_decay,
            best.tau_fast,
            dt,
            0,
        );
        best.residual = full_residual;
    }

    best
}

/// Evaluate two-component fit at fixed (tau_r, tau_d, tau_f) with NNLS for (beta_s, beta_f).
///
/// Model: h(t) = beta_s * (exp(-t/tau_d) - exp(-t/tau_r)) + beta_f * exp(-t/tau_f)
///
/// For fixed time constants, this is a 2-variable non-negative least squares problem.
/// We enumerate all 4 active sets and pick the one with minimum residual.
///
/// Returns (beta_s, beta_f, residual).
fn eval_two_component(
    h_free: &[f32],
    tau_r: f64,
    tau_d: f64,
    tau_f: f64,
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

    for i in skip..n {
        let t = i as f64 * dt;
        let ts = (-t / tau_d).exp() - (-t / tau_r).exp();
        let tf = (-t / tau_f).exp();
        let hi = h_free[i] as f64;

        g_ss += ts * ts;
        g_ff += tf * tf;
        g_sf += ts * tf;
        rhs_s += hi * ts;
        rhs_f += hi * tf;
        dot_hh += hi * hi;
    }

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
    let det = g_ss * g_ff - g_sf * g_sf;
    if det.abs() > 1e-30 {
        let bs = (rhs_s * g_ff - rhs_f * g_sf) / det;
        let bf = (rhs_f * g_ss - rhs_s * g_sf) / det;
        if bs >= 0.0 && bf >= 0.0 {
            let r = residual_fn(bs, bf);
            if r < best_res {
                best_bs = bs;
                best_bf = bf;
                best_res = r;
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

    // Active set 3: beta_f only (beta_s = 0)
    if g_ff > 1e-30 {
        let bf = rhs_f / g_ff;
        if bf >= 0.0 {
            let r = residual_fn(0.0, bf);
            if r < best_res {
                best_bs = 0.0;
                best_bf = bf;
                best_res = r;
            }
        }
    }

    // Active set 4: both zero — already covered by initial best_res = dot_hh

    (best_bs, best_bf, best_res)
}

/// Golden-section refinement around the best grid point.
/// Cycles through refining tau_r, tau_d, and tau_f for `max_steps` total.
fn golden_section_refine(
    h_free: &[f32],
    best: &BiexpResult,
    dt: f64,
    max_steps: usize,
    skip: usize,
) -> (f64, f64, f64) {
    let phi = (5.0_f64.sqrt() - 1.0) / 2.0; // golden ratio conjugate

    let mut tau_r = best.tau_rise;
    let mut tau_d = best.tau_decay;
    let mut tau_f = best.tau_fast;

    // If tau_f is zero (no fast component), skip tau_f refinement
    let has_fast = tau_f > 0.0;

    for step in 0..max_steps {
        let phase = if has_fast { step % 3 } else { step % 2 };

        if phase == 0 {
            // Refine tau_r (floor at 2 samples — same Nyquist limit as grid search)
            let mut lo = (tau_r * 0.5).max(2.0 * dt);
            let mut hi = tau_r * 2.0;
            // Ensure tau_r < tau_d
            hi = hi.min(tau_d * 0.99);
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let (_, _, r1) = eval_two_component(h_free, x1, tau_d, tau_f, dt, skip);
                let (_, _, r2) = eval_two_component(h_free, x2, tau_d, tau_f, dt, skip);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_r = (lo + hi) / 2.0;
        } else if phase == 1 {
            // Refine tau_d
            let mut lo = (tau_d * 0.5).max(tau_r * 1.01);
            let mut hi = tau_d * 2.0;
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let (_, _, r1) = eval_two_component(h_free, tau_r, x1, tau_f, dt, skip);
                let (_, _, r2) = eval_two_component(h_free, tau_r, x2, tau_f, dt, skip);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_d = (lo + hi) / 2.0;
        } else {
            // Refine tau_f
            let mut lo = (tau_f * 0.5).max(dt);
            let mut hi = (tau_f * 2.0).min(tau_r * 0.99);
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let (_, _, r1) = eval_two_component(h_free, tau_r, tau_d, x1, dt, skip);
                let (_, _, r2) = eval_two_component(h_free, tau_r, tau_d, x2, dt, skip);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_f = (lo + hi) / 2.0;
        }
    }

    (tau_r, tau_d, tau_f)
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
    fn make_two_component(
        tau_r: f64,
        tau_d: f64,
        beta_s: f64,
        tau_f: f64,
        beta_f: f64,
        fs: f64,
        n: usize,
    ) -> Vec<f32> {
        let dt = 1.0 / fs;
        (0..n)
            .map(|i| {
                let t = i as f64 * dt;
                let slow = beta_s * ((-t / tau_d).exp() - (-t / tau_r).exp());
                let fast = beta_f * (-t / tau_f).exp();
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

        let result = fit_biexponential(&h, fs, true, 0);

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
        let result = fit_biexponential(&h, 30.0, true, 0);

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
        let result = fit_biexponential(&h, 30.0, true, 0);

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

        let coarse = fit_biexponential(&h, 30.0, false, 0);
        let refined = fit_biexponential(&h, 30.0, true, 0);

        assert!(
            refined.residual <= coarse.residual + 1e-10,
            "Refinement should not worsen fit: refined {} vs coarse {}",
            refined.residual,
            coarse.residual
        );
    }

    #[test]
    fn empty_kernel() {
        let result = fit_biexponential(&[], 30.0, true, 0);
        assert_eq!(result.residual, f64::INFINITY);
    }

    #[test]
    fn positive_beta() {
        let h = make_biexp(0.02, 0.4, 3.0, 30.0, 40);
        let result = fit_biexponential(&h, 30.0, false, 0);

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
        let r = fit_biexponential(&h_fast, 100.0, true, 0);
        assert!(r.tau_decay > r.tau_rise);
        assert!(r.residual < 1.0); // should fit well

        // Test with slow dynamics
        let h_slow = make_biexp(0.1, 2.0, 1.0, 10.0, 50);
        let r = fit_biexponential(&h_slow, 10.0, true, 0);
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
        let no_skip = fit_biexponential(&h, fs, true, 0);

        // With skip=3: noise is excluded from fitting, tau estimates improve
        let with_skip = fit_biexponential(&h, fs, true, 3);

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
        let clean_result = fit_biexponential(&clean, fs, true, 3);
        assert!(
            with_skip.residual > clean_result.residual,
            "Corrupted kernel should have higher full-kernel residual: {:.6} vs {:.6}",
            with_skip.residual,
            clean_result.residual
        );
    }

    #[test]
    fn recovers_taus_with_fast_component() {
        // Generate h(t) = 2.0*(exp(-t/0.5) - exp(-t/0.08)) + 1.5*exp(-t/0.005)
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let tau_f_true = 0.005;
        let fs = 100.0; // high fs to resolve fast component
        let n = 200;
        let h = make_two_component(tau_r_true, tau_d_true, 2.0, tau_f_true, 1.5, fs, n);

        let result = fit_biexponential(&h, fs, true, 0);

        // Slow tau values should be recovered
        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        let td_err = (result.tau_decay - tau_d_true).abs() / tau_d_true;

        assert!(
            tr_err < 0.25,
            "Tau rise error {:.1}% (got {:.4}, expected {:.4})",
            tr_err * 100.0,
            result.tau_rise,
            tau_r_true
        );
        assert!(
            td_err < 0.25,
            "Tau decay error {:.1}% (got {:.4}, expected {:.4})",
            td_err * 100.0,
            result.tau_decay,
            tau_d_true
        );

        // Fast component should be detected
        assert!(
            result.beta_fast > 0.0,
            "beta_fast should be positive when fast component exists, got {}",
            result.beta_fast
        );
    }

    #[test]
    fn fast_absorbs_noise_spike() {
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 100.0; // high fs needed to resolve fast vs slow components
        let n = 200;
        let mut h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        // Simulate noise artifact: large values at bins 0-2
        h[0] += 5.0;
        h[1] += 3.0;
        h[2] += 1.0;

        let result = fit_biexponential(&h, fs, true, 0);

        // With two-component model, tau_rise should stay near true value
        // because the fast component absorbs the noise spike
        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        assert!(
            tr_err < 0.5,
            "tau_rise should stay near true value with noise spike: got {:.4} (err {:.1}%), expected {:.4}",
            result.tau_rise,
            tr_err * 100.0,
            tau_r_true
        );

        // The fast component should have picked up the spike
        assert!(
            result.beta_fast > 0.0,
            "beta_fast should be positive to absorb the noise spike"
        );
    }

    #[test]
    fn tau_f_less_than_tau_r() {
        // For various inputs, verify tau_f < tau_r always holds (when tau_f > 0)
        let test_cases = [
            (0.08, 0.5, 30.0),
            (0.05, 0.3, 100.0),
            (0.1, 2.0, 10.0),
        ];

        for (tau_r, tau_d, fs) in test_cases {
            let h = make_biexp(tau_r, tau_d, 2.0, fs, 60);
            let result = fit_biexponential(&h, fs, true, 0);

            if result.tau_fast > 0.0 {
                assert!(
                    result.tau_fast < result.tau_rise,
                    "tau_fast ({}) should be < tau_rise ({}) for (tau_r={}, tau_d={}, fs={})",
                    result.tau_fast,
                    result.tau_rise,
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

        // Case 1: Pure slow component — should yield beta_s > 0, beta_f ≈ 0
        let h_slow = make_biexp(0.05, 0.5, 2.0, fs, n);
        let (bs, bf, _) = eval_two_component(&h_slow, 0.05, 0.5, 0.005, dt, 0);
        assert!(bs > 0.0, "beta_s should be positive for slow-only input");
        assert!(
            bf < 0.1 * bs,
            "beta_f ({:.4}) should be near zero for slow-only input (beta_s={:.4})",
            bf,
            bs
        );

        // Case 2: Pure fast component — should yield beta_s ≈ 0, beta_f > 0
        let h_fast: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 * dt;
                (3.0 * (-t / 0.005).exp()) as f32
            })
            .collect();
        let (bs, bf, _) = eval_two_component(&h_fast, 0.05, 0.5, 0.005, dt, 0);
        assert!(bf > 0.0, "beta_f should be positive for fast-only input");
        assert!(
            bs < 0.1 * bf,
            "beta_s ({:.4}) should be near zero for fast-only input (beta_f={:.4})",
            bs,
            bf
        );

        // Case 3: Both components present
        let h_both = make_two_component(0.05, 0.5, 2.0, 0.005, 1.5, fs, n);
        let (bs, bf, _) = eval_two_component(&h_both, 0.05, 0.5, 0.005, dt, 0);
        assert!(bs > 0.0, "beta_s should be positive for mixed input");
        assert!(bf > 0.0, "beta_f should be positive for mixed input");

        // Case 4: Zero signal — both should be zero
        let h_zero = vec![0.0_f32; n];
        let (bs, bf, res) = eval_two_component(&h_zero, 0.05, 0.5, 0.005, dt, 0);
        assert_eq!(bs, 0.0, "beta_s should be zero for zero input");
        assert_eq!(bf, 0.0, "beta_f should be zero for zero input");
        assert!(res < 1e-20, "residual should be ~0 for zero input");
    }
}
