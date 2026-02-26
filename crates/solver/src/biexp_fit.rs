/// Bi-exponential fitting: extract tau_rise and tau_decay from a free-form kernel.
///
/// Fits h(t) = beta * (exp(-t/tau_d) - exp(-t/tau_r)) to the estimated kernel
/// using grid search over (tau_r, tau_d) with closed-form beta, optionally
/// refined by golden-section search.

#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct BiexpResult {
    pub tau_rise: f64,
    pub tau_decay: f64,
    pub beta: f64,
    pub residual: f64,
}

/// Fit a bi-exponential model to a free-form kernel.
///
/// Uses a 20x20 log-spaced grid search over (tau_r, tau_d) with
/// closed-form beta at each grid point, followed by optional
/// golden-section refinement around the best grid point.
///
/// Arguments:
/// - `h_free`: the free-form kernel to fit (from estimate_free_kernel)
/// - `fs`: sampling rate used for the kernel
/// - `refine`: whether to apply golden-section refinement after grid search
pub fn fit_biexponential(h_free: &[f32], fs: f64, refine: bool) -> BiexpResult {
    let n = h_free.len();
    if n == 0 {
        return BiexpResult {
            tau_rise: 0.02,
            tau_decay: 0.4,
            beta: 0.0,
            residual: f64::INFINITY,
        };
    }

    let dt = 1.0 / fs;

    // Grid search ranges (in seconds)
    let tau_r_lo = 0.005_f64;
    let tau_r_hi = 0.5_f64;
    let tau_d_lo = 0.05_f64;
    let tau_d_hi = 5.0_f64;

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

            let (beta, residual) = eval_biexp(h_free, tau_r, tau_d, dt);
            if residual < best.residual {
                best = BiexpResult {
                    tau_rise: tau_r,
                    tau_decay: tau_d,
                    beta,
                    residual,
                };
            }
        }
    }

    // Phase 2: Optional golden-section refinement
    if refine {
        let (refined_tr, refined_td) = golden_section_refine(h_free, &best, dt, 20);
        let (beta, residual) = eval_biexp(h_free, refined_tr, refined_td, dt);
        if residual < best.residual {
            best = BiexpResult {
                tau_rise: refined_tr,
                tau_decay: refined_td,
                beta,
                residual,
            };
        }
    }

    best
}

/// Evaluate bi-exponential fit at (tau_r, tau_d) with closed-form beta.
///
/// Model: h(t) = beta * (exp(-t/tau_d) - exp(-t/tau_r))
/// Beta is the least-squares optimal scalar: beta = <h_free, template> / <template, template>
///
/// Uses the identity ||h - beta*t||^2 = ||h||^2 - <h,t>^2 / ||t||^2
/// to compute both beta and residual in a single pass over the data.
fn eval_biexp(h_free: &[f32], tau_r: f64, tau_d: f64, dt: f64) -> (f64, f64) {
    let n = h_free.len();

    let mut dot_ht = 0.0_f64; // <h_free, template>
    let mut dot_tt = 0.0_f64; // <template, template>
    let mut dot_hh = 0.0_f64; // <h_free, h_free>

    for i in 0..n {
        let t = i as f64 * dt;
        let template = (-t / tau_d).exp() - (-t / tau_r).exp();
        let hi = h_free[i] as f64;
        dot_ht += hi * template;
        dot_tt += template * template;
        dot_hh += hi * hi;
    }

    if dot_tt < 1e-30 {
        return (0.0, f64::INFINITY);
    }

    let beta = dot_ht / dot_tt;
    // ||h - beta*t||^2 = ||h||^2 - 2*beta*<h,t> + beta^2*||t||^2
    //                   = ||h||^2 - <h,t>^2 / ||t||^2
    let residual = dot_hh - dot_ht * dot_ht / dot_tt;

    (beta, residual)
}

/// Golden-section refinement around the best grid point.
/// Alternates refining tau_r and tau_d for `max_steps` total.
fn golden_section_refine(
    h_free: &[f32],
    best: &BiexpResult,
    dt: f64,
    max_steps: usize,
) -> (f64, f64) {
    let phi = (5.0_f64.sqrt() - 1.0) / 2.0; // golden ratio conjugate

    let mut tau_r = best.tau_rise;
    let mut tau_d = best.tau_decay;

    for step in 0..max_steps {
        if step % 2 == 0 {
            // Refine tau_r
            let mut lo = (tau_r * 0.5).max(0.001);
            let mut hi = tau_r * 2.0;
            // Ensure tau_r < tau_d
            hi = hi.min(tau_d * 0.99);
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let (_, r1) = eval_biexp(h_free, x1, tau_d, dt);
                let (_, r2) = eval_biexp(h_free, x2, tau_d, dt);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_r = (lo + hi) / 2.0;
        } else {
            // Refine tau_d
            let mut lo = (tau_d * 0.5).max(tau_r * 1.01);
            let mut hi = tau_d * 2.0;
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let (_, r1) = eval_biexp(h_free, tau_r, x1, dt);
                let (_, r2) = eval_biexp(h_free, tau_r, x2, dt);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_d = (lo + hi) / 2.0;
        }
    }

    (tau_r, tau_d)
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

    #[test]
    fn recovers_known_taus() {
        let tau_r_true = 0.03;
        let tau_d_true = 0.5;
        let fs = 30.0;
        let n = 60; // 2 seconds
        let h = make_biexp(tau_r_true, tau_d_true, 2.0, fs, n);

        let result = fit_biexponential(&h, fs, true);

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
    fn tau_d_greater_than_tau_r() {
        let h = make_biexp(0.05, 0.8, 1.5, 30.0, 60);
        let result = fit_biexponential(&h, 30.0, true);

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

        let coarse = fit_biexponential(&h, 30.0, false);
        let refined = fit_biexponential(&h, 30.0, true);

        assert!(
            refined.residual <= coarse.residual + 1e-10,
            "Refinement should not worsen fit: refined {} vs coarse {}",
            refined.residual,
            coarse.residual
        );
    }

    #[test]
    fn empty_kernel() {
        let result = fit_biexponential(&[], 30.0, true);
        assert_eq!(result.residual, f64::INFINITY);
    }

    #[test]
    fn positive_beta() {
        let h = make_biexp(0.02, 0.4, 3.0, 30.0, 40);
        let result = fit_biexponential(&h, 30.0, false);

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
        let r = fit_biexponential(&h_fast, 100.0, true);
        assert!(r.tau_decay > r.tau_rise);
        assert!(r.residual < 1.0); // should fit well

        // Test with slow dynamics
        let h_slow = make_biexp(0.1, 2.0, 1.0, 10.0, 50);
        let r = fit_biexponential(&h_slow, 10.0, true);
        assert!(r.tau_decay > r.tau_rise);
    }
}
