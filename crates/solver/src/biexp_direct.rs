/// Direct bi-exponential kernel estimation from traces and spike trains.
///
/// Instead of estimating a free-form kernel and then fitting a bi-exponential
/// to it (the two-step approach in kernel_est.rs + biexp_fit.rs), this function
/// directly optimizes (tau_r, tau_d) against trace reconstruction error:
///
///   min_{tau_r, tau_d}  Σ_i projection_residual(y_adj_i, AR2_raw * s_i)
///
/// where y_adj_i = (trace_i - baseline_i) / alpha_i. The eval_reconstruction
/// function uses the **projection residual**: dot_yy - dot_yc² / dot_cc, which
/// is amplitude-invariant (measures pure shape mismatch regardless of scale).
///
/// In the hybrid kernel mode, this works reliably because the free kernel drives
/// early iterations, producing good spikes. With good spikes, the projection
/// residual correctly identifies the true (tau_r, tau_d) — collapsed kernels
/// produce a different convolution shape, not just a different amplitude.
///
/// The returned (tau_rise, tau_decay) are used by the iteration manager to build
/// a peak-normalized kernel for the next trace solve — normalization happens
/// downstream, not during the search.

use crate::biexp_fit::BiexpResult;

/// Direct bi-exponential kernel estimation from traces and spike trains.
///
/// Algorithm:
///   Phase 1: 20x20 log-spaced grid search over (tau_r, tau_d)
///   Phase 2: Golden-section refinement around the best grid point
///
/// At each candidate, we:
///   1. Validate the bi-exponential constraint (tau_d > tau_r, resolvable tau_r)
///   2. Convolve each trace's spikes via raw AR2 recursion
///   3. Compute the amplitude-invariant projection residual
///
/// Returns BiexpResult where residual is the total projection residual
/// and beta is the median of the input alphas.
pub fn fit_biexp_direct(
    traces: &[f32],
    spike_trains: &[f32],
    alphas: &[f64],
    baselines: &[f64],
    trace_lengths: &[usize],
    fs: f64,
    refine: bool,
) -> BiexpResult {
    let n_traces = trace_lengths.len();
    let total_len: usize = trace_lengths.iter().sum();
    if total_len == 0 || n_traces == 0 {
        return BiexpResult {
            tau_rise: 0.02,
            tau_decay: 0.4,
            beta: 0.0,
            residual: f64::INFINITY,
        };
    }

    assert_eq!(traces.len(), total_len);
    assert_eq!(spike_trains.len(), total_len);
    assert_eq!(alphas.len(), n_traces);
    assert_eq!(baselines.len(), n_traces);

    // Pre-compute y_adj = (trace - baseline) / alpha, matching the free kernel
    // approach (kernel_est.rs lines 104-120). This removes per-trace amplitude
    // and offset so the evaluation is a pure kernel-shape match.
    let mut y_adj = vec![0.0_f32; total_len];
    let mut offset = 0;
    for (i, &len) in trace_lengths.iter().enumerate() {
        let alpha = alphas[i];
        let baseline = baselines[i];
        if alpha.abs() < 1e-20 {
            offset += len;
            continue;
        }
        for j in 0..len {
            y_adj[offset + j] = ((traces[offset + j] as f64 - baseline) / alpha) as f32;
        }
        offset += len;
    }

    // Median of input alphas (for beta in result)
    let median_alpha = {
        let mut sorted: Vec<f64> = alphas.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if sorted.len() % 2 == 1 {
            sorted[sorted.len() / 2]
        } else {
            (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0
        }
    };

    let max_trace_len = *trace_lengths.iter().max().unwrap();
    let mut conv_buf = vec![0.0_f32; max_trace_len];

    // Grid search ranges (same as biexp_fit.rs)
    let tau_r_lo = (2.0 / fs).max(0.005_f64);
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
        beta: median_alpha,
        residual: f64::INFINITY,
    };

    // Phase 1: Grid search
    for i in 0..grid_n {
        let log_tr = log_tr_lo + (log_tr_hi - log_tr_lo) * i as f64 / (grid_n - 1) as f64;
        let tau_r = log_tr.exp();

        for j in 0..grid_n {
            let log_td = log_td_lo + (log_td_hi - log_td_lo) * j as f64 / (grid_n - 1) as f64;
            let tau_d = log_td.exp();

            if !is_valid_biexp(tau_r, tau_d, fs) {
                continue;
            }

            if let Some(ssr) = eval_reconstruction(
                &y_adj,
                spike_trains,
                trace_lengths,
                tau_r,
                tau_d,
                fs,
                &mut conv_buf,
            ) {
                if ssr < best.residual {
                    best = BiexpResult {
                        tau_rise: tau_r,
                        tau_decay: tau_d,
                        beta: median_alpha,
                        residual: ssr,
                    };
                }
            }
        }
    }

    // Phase 2: Optional golden-section refinement
    if refine {
        let (refined_tr, refined_td) = golden_section_refine(
            &y_adj,
            spike_trains,
            trace_lengths,
            &best,
            fs,
            20,
            &mut conv_buf,
        );
        if let Some(ssr) = eval_reconstruction(
            &y_adj,
            spike_trains,
            trace_lengths,
            refined_tr,
            refined_td,
            fs,
            &mut conv_buf,
        ) {
            if ssr < best.residual {
                best = BiexpResult {
                    tau_rise: refined_tr,
                    tau_decay: refined_td,
                    beta: median_alpha,
                    residual: ssr,
                };
            }
        }
    }

    best
}

/// Validate that (tau_r, tau_d) produces a real, non-oscillatory bi-exponential kernel.
///
/// The AR2 recursion c[t] = g1*c[t-1] + g2*c[t-2] + s[t] produces a real,
/// non-oscillatory (i.e., physical calcium-like) impulse response ONLY when
/// the AR2 characteristic polynomial z^2 - g1*z - g2 = 0 has two distinct
/// real roots in (0, 1). For a bi-exponential kernel:
///   d = exp(-dt / tau_d) in (0,1)  [guaranteed by tau_d > 0]
///   r = exp(-dt / tau_r) in (0,1)  [guaranteed by tau_r > 0]
///   g1 = d + r,  g2 = -(d * r)
///   discriminant = g1^2 + 4*g2 = (d - r)^2 >= 0  [always non-negative]
///
/// So for positive taus with tau_d > tau_r, the roots are always real and
/// in (0,1). We enforce tau_d > tau_r and both > 0 to guarantee this.
fn is_valid_biexp(tau_r: f64, tau_d: f64, fs: f64) -> bool {
    // tau_d must be strictly greater than tau_r, and both must be positive
    if tau_r <= 0.0 || tau_d <= tau_r {
        return false;
    }
    // Additional guard: tau_r must be at least 1 sample (resolvable)
    let dt = 1.0 / fs;
    if tau_r < dt {
        return false;
    }
    true
}

/// Evaluate reconstruction error for a candidate (tau_r, tau_d) using the
/// projection residual: dot_yy - dot_yc² / dot_cc.
///
/// This is amplitude-invariant: it measures pure shape mismatch between y_adj
/// and the convolution, regardless of scale. The projection residual equals the
/// squared norm of y_adj after removing its component along the convolution
/// direction — i.e., the residual after optimal scalar fitting.
///
/// In the hybrid kernel mode, this metric works reliably because the free kernel
/// drives early iterations, producing good spikes. With good spikes, different
/// kernel shapes produce genuinely different convolution waveforms, so the
/// projection residual correctly discriminates between candidates.
fn eval_reconstruction(
    y_adj: &[f32],
    spike_trains: &[f32],
    trace_lengths: &[usize],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    conv_buf: &mut [f32],
) -> Option<f64> {
    if !is_valid_biexp(tau_r, tau_d, fs) {
        return None;
    }

    // AR2 coefficients from (tau_r, tau_d)
    let dt = 1.0 / fs;
    let d = (-dt / tau_d).exp();
    let r = (-dt / tau_r).exp();
    let g1 = (d + r) as f32;
    let g2 = (-(d * r)) as f32;

    let mut dot_yy = 0.0_f64;
    let mut dot_yc = 0.0_f64;
    let mut dot_cc = 0.0_f64;
    let mut offset = 0;

    for &len in trace_lengths {
        let y_slice = &y_adj[offset..offset + len];
        let spike_slice = &spike_trains[offset..offset + len];

        // Raw AR2 recursion
        if len > 0 {
            conv_buf[0] = spike_slice[0];
        }
        if len > 1 {
            conv_buf[1] = g1 * conv_buf[0] + spike_slice[1];
        }
        for t in 2..len {
            conv_buf[t] = g1 * conv_buf[t - 1] + g2 * conv_buf[t - 2] + spike_slice[t];
        }

        // Accumulate dot products for projection residual
        for i in 0..len {
            let y = y_slice[i] as f64;
            let c = conv_buf[i] as f64;
            dot_yy += y * y;
            dot_yc += y * c;
            dot_cc += c * c;
        }

        offset += len;
    }

    // Guard: if convolution is near-zero, this candidate is degenerate
    if dot_cc < 1e-30 {
        return None;
    }

    // Projection residual: ||y - (y·c / c·c) * c||² = y·y - (y·c)² / (c·c)
    Some(dot_yy - dot_yc * dot_yc / dot_cc)
}

/// Golden-section refinement around the best grid point.
/// Alternates refining tau_r and tau_d for `max_steps` total.
fn golden_section_refine(
    y_adj: &[f32],
    spike_trains: &[f32],
    trace_lengths: &[usize],
    best: &BiexpResult,
    fs: f64,
    max_steps: usize,
    conv_buf: &mut [f32],
) -> (f64, f64) {
    let phi = (5.0_f64.sqrt() - 1.0) / 2.0;
    let dt = 1.0 / fs;

    let mut tau_r = best.tau_rise;
    let mut tau_d = best.tau_decay;

    for step in 0..max_steps {
        if step % 2 == 0 {
            // Refine tau_r (floor at 1 sample)
            let mut lo = (tau_r * 0.5).max(dt);
            let mut hi = tau_r * 2.0;
            hi = hi.min(tau_d * 0.99);
            if lo >= hi {
                continue;
            }

            for _ in 0..10 {
                let x1 = hi - phi * (hi - lo);
                let x2 = lo + phi * (hi - lo);
                let r1 = eval_reconstruction(
                    y_adj,
                    spike_trains,
                    trace_lengths,
                    x1,
                    tau_d,
                    fs,
                    conv_buf,
                )
                .unwrap_or(f64::INFINITY);
                let r2 = eval_reconstruction(
                    y_adj,
                    spike_trains,
                    trace_lengths,
                    x2,
                    tau_d,
                    fs,
                    conv_buf,
                )
                .unwrap_or(f64::INFINITY);
                if r1 < r2 {
                    hi = x2;
                } else {
                    lo = x1;
                }
            }
            tau_r = (lo + hi) / 2.0;
        } else {
            // Refine tau_d
            let lo = (tau_d * 0.5).max(tau_r * 1.01);
            let hi = tau_d * 2.0;
            if lo >= hi {
                continue;
            }

            let mut lo_inner = lo;
            let mut hi_inner = hi;
            for _ in 0..10 {
                let x1 = hi_inner - phi * (hi_inner - lo_inner);
                let x2 = lo_inner + phi * (hi_inner - lo_inner);
                let r1 = eval_reconstruction(
                    y_adj,
                    spike_trains,
                    trace_lengths,
                    tau_r,
                    x1,
                    fs,
                    conv_buf,
                )
                .unwrap_or(f64::INFINITY);
                let r2 = eval_reconstruction(
                    y_adj,
                    spike_trains,
                    trace_lengths,
                    tau_r,
                    x2,
                    fs,
                    conv_buf,
                )
                .unwrap_or(f64::INFINITY);
                if r1 < r2 {
                    hi_inner = x2;
                } else {
                    lo_inner = x1;
                }
            }
            tau_d = (lo_inner + hi_inner) / 2.0;
        }
    }

    (tau_r, tau_d)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::banded::BandedAR2;

    /// Generate synthetic traces from known spikes and kernel parameters.
    /// Uses BandedAR2 (peak-normalized) convolution to generate traces, matching
    /// the CaDecon pipeline where the trace solver uses peak-normalized kernels.
    /// The alphas are calibrated for peak-normalized convolution, so y_adj will
    /// have peaks ≈ 1 — exactly the setup the raw-convolution search expects.
    /// Returns (traces, spikes, alphas, baselines, trace_lengths).
    fn make_synthetic_data(
        tau_r: f64,
        tau_d: f64,
        fs: f64,
        n_traces: usize,
        trace_len: usize,
    ) -> (Vec<f32>, Vec<f32>, Vec<f64>, Vec<f64>, Vec<usize>) {
        let banded = BandedAR2::new(tau_r, tau_d, fs);
        let mut all_traces = Vec::new();
        let mut all_spikes = Vec::new();
        let mut all_alphas = Vec::new();
        let mut all_baselines = Vec::new();
        let mut trace_lengths = Vec::new();

        for i in 0..n_traces {
            let mut spikes = vec![0.0_f32; trace_len];
            // Place spikes at deterministic positions
            let positions = [
                20 + i * 7,
                80 + i * 3,
                150 + i * 5,
                220 + i * 2,
            ];
            for &pos in &positions {
                if pos < trace_len {
                    spikes[pos] = 1.0;
                }
            }

            // Use peak-normalized convolution (matching CaDecon trace solver)
            let mut conv = vec![0.0_f32; trace_len];
            banded.convolve_forward(&spikes, &mut conv);

            // trace = alpha * conv_normalized + baseline
            let alpha = 3.0 + i as f64 * 0.5;
            let baseline = 1.0 + i as f64 * 0.2;
            let trace: Vec<f32> = conv
                .iter()
                .map(|&c| (alpha * c as f64 + baseline) as f32)
                .collect();

            all_traces.extend_from_slice(&trace);
            all_spikes.extend_from_slice(&spikes);
            all_alphas.push(alpha);
            all_baselines.push(baseline);
            trace_lengths.push(trace_len);
        }

        (all_traces, all_spikes, all_alphas, all_baselines, trace_lengths)
    }

    #[test]
    fn recovers_known_taus() {
        let tau_r_true = 0.08;
        let tau_d_true = 0.5;
        let fs = 30.0;
        let (traces, spikes, alphas, baselines, lengths) =
            make_synthetic_data(tau_r_true, tau_d_true, fs, 3, 300);

        let result =
            fit_biexp_direct(&traces, &spikes, &alphas, &baselines, &lengths, fs, true);

        let tr_err = (result.tau_rise - tau_r_true).abs() / tau_r_true;
        let td_err = (result.tau_decay - tau_d_true).abs() / tau_d_true;

        // Projection residual recovers exact taus with perfect spikes since
        // it is amplitude-invariant and purely measures shape mismatch.
        assert!(
            tr_err < 0.10,
            "Tau rise error {:.1}% (got {:.4}, expected {:.4})",
            tr_err * 100.0,
            result.tau_rise,
            tau_r_true
        );
        assert!(
            td_err < 0.10,
            "Tau decay error {:.1}% (got {:.4}, expected {:.4})",
            td_err * 100.0,
            result.tau_decay,
            tau_d_true
        );
    }

    #[test]
    fn tau_d_greater_than_tau_r() {
        let (traces, spikes, alphas, baselines, lengths) =
            make_synthetic_data(0.05, 0.8, 30.0, 2, 300);
        let result =
            fit_biexp_direct(&traces, &spikes, &alphas, &baselines, &lengths, 30.0, true);

        assert!(
            result.tau_decay > result.tau_rise,
            "tau_d ({}) should be > tau_r ({})",
            result.tau_decay,
            result.tau_rise
        );
    }

    #[test]
    fn validation_rejects_invalid() {
        // tau_r >= tau_d
        assert!(!is_valid_biexp(0.5, 0.3, 30.0));
        // tau_r == tau_d
        assert!(!is_valid_biexp(0.3, 0.3, 30.0));
        // negative tau_r
        assert!(!is_valid_biexp(-0.1, 0.5, 30.0));
        // tau_r below 1 sample
        assert!(!is_valid_biexp(0.01, 0.5, 30.0)); // dt = 1/30 ≈ 0.033
    }

    #[test]
    fn validation_accepts_valid() {
        assert!(is_valid_biexp(0.05, 0.5, 30.0));
        assert!(is_valid_biexp(0.08, 1.0, 30.0));
        assert!(is_valid_biexp(0.02, 0.4, 100.0)); // dt = 0.01, tau_r = 0.02 > dt
    }

    #[test]
    fn refinement_improves_fit() {
        let (traces, spikes, alphas, baselines, lengths) =
            make_synthetic_data(0.04, 0.6, 30.0, 3, 300);

        let coarse =
            fit_biexp_direct(&traces, &spikes, &alphas, &baselines, &lengths, 30.0, false);
        let refined =
            fit_biexp_direct(&traces, &spikes, &alphas, &baselines, &lengths, 30.0, true);

        assert!(
            refined.residual <= coarse.residual + 1e-10,
            "Refinement should not worsen fit: refined {} vs coarse {}",
            refined.residual,
            coarse.residual
        );
    }

    #[test]
    fn empty_input() {
        let result = fit_biexp_direct(&[], &[], &[], &[], &[], 30.0, true);
        assert_eq!(result.residual, f64::INFINITY);
    }

    /// Diagnostic: print the SSR landscape to understand why the grid search
    /// picks the wrong minimum with imperfect spikes.
    #[test]
    fn landscape_diagnostic() {
        let tau_r_true = 0.1;
        let tau_d_true = 0.6;
        let fs = 30.0;
        let n_traces = 5;
        let trace_len = 600;

        // Generate traces with the TRUE kernel
        let banded_true = BandedAR2::new(tau_r_true, tau_d_true, fs);
        let mut all_traces = Vec::new();
        let mut all_spikes_perfect = Vec::new();
        let mut all_alphas = Vec::new();
        let mut all_baselines = Vec::new();
        let mut trace_lengths = Vec::new();

        for i in 0..n_traces {
            let mut spikes = vec![0.0_f32; trace_len];
            let positions = [
                20 + i * 7, 60 + i * 3, 110 + i * 5, 170 + i * 2,
                230 + i * 4, 300 + i * 6, 370 + i * 1, 440 + i * 8,
                500 + i * 3,
            ];
            for &pos in &positions {
                if pos < trace_len {
                    spikes[pos] = 1.0;
                }
            }
            let mut conv = vec![0.0_f32; trace_len];
            banded_true.convolve_forward(&spikes, &mut conv);
            let alpha = 3.0 + i as f64 * 0.5;
            let baseline = 100.0 + i as f64 * 5.0;
            let trace: Vec<f32> = conv
                .iter()
                .map(|&c| (alpha * c as f64 + baseline) as f32)
                .collect();

            all_traces.extend_from_slice(&trace);
            all_spikes_perfect.extend_from_slice(&spikes);
            all_alphas.push(alpha);
            all_baselines.push(baseline);
            trace_lengths.push(trace_len);
        }

        // Simulate imperfect spikes: solve with WRONG kernel (0.2, 0.3)
        // For simplicity, jitter spike positions by +1 sample and add some false positives
        let mut all_spikes_imperfect = vec![0.0_f32; all_spikes_perfect.len()];
        let mut offset = 0;
        for &len in &trace_lengths {
            for t in 0..len {
                let s = all_spikes_perfect[offset + t];
                if s > 0.0 && t + 1 < len {
                    // Shift spike forward by 1 sample
                    all_spikes_imperfect[offset + t + 1] = s;
                } else if s > 0.0 {
                    all_spikes_imperfect[offset + t] = s;
                }
            }
            // Add some false positive spikes
            for &pos in &[45, 135, 280, 420] {
                if pos < len {
                    all_spikes_imperfect[offset + pos] = 0.5;
                }
            }
            offset += len;
        }

        // Pre-compute y_adj
        let total_len = all_traces.len();
        let mut y_adj = vec![0.0_f32; total_len];
        offset = 0;
        for (i, &len) in trace_lengths.iter().enumerate() {
            let alpha = all_alphas[i];
            let baseline = all_baselines[i];
            for j in 0..len {
                y_adj[offset + j] = ((all_traces[offset + j] as f64 - baseline) / alpha) as f32;
            }
            offset += len;
        }

        let max_len = *trace_lengths.iter().max().unwrap();
        let mut conv_buf = vec![0.0_f32; max_len];

        // Evaluate SSR at key points with PERFECT spikes
        let test_points: Vec<(f64, f64, &str)> = vec![
            (0.10, 0.60, "TRUE"),
            (0.08, 0.50, "close"),
            (0.15, 0.80, "shifted"),
            (0.20, 0.40, "medium"),
            (0.30, 0.40, "collapse-like"),
            (0.25, 0.35, "near-equal"),
            (0.05, 1.00, "sharp/long"),
        ];

        eprintln!("\n=== SSR Landscape with PERFECT spikes ===");
        for &(tr, td, label) in &test_points {
            if let Some(ssr) = eval_reconstruction(
                &y_adj, &all_spikes_perfect, &trace_lengths, tr, td, fs, &mut conv_buf,
            ) {
                eprintln!("  ({:.3}, {:.3}) [{:14}] SSR = {:.6}", tr, td, label, ssr);
            }
        }

        eprintln!("\n=== SSR Landscape with IMPERFECT spikes ===");
        for &(tr, td, label) in &test_points {
            if let Some(ssr) = eval_reconstruction(
                &y_adj, &all_spikes_imperfect, &trace_lengths, tr, td, fs, &mut conv_buf,
            ) {
                eprintln!("  ({:.3}, {:.3}) [{:14}] SSR = {:.6}", tr, td, label, ssr);
            }
        }

        // Run the full fit with perfect vs imperfect spikes
        let result_perfect = fit_biexp_direct(
            &all_traces, &all_spikes_perfect, &all_alphas, &all_baselines, &trace_lengths, fs, true,
        );
        let result_imperfect = fit_biexp_direct(
            &all_traces, &all_spikes_imperfect, &all_alphas, &all_baselines, &trace_lengths, fs, true,
        );

        eprintln!("\n=== Fit Results ===");
        eprintln!(
            "  Perfect spikes:   tau_r={:.4}, tau_d={:.4}, residual={:.6}",
            result_perfect.tau_rise, result_perfect.tau_decay, result_perfect.residual
        );
        eprintln!(
            "  Imperfect spikes: tau_r={:.4}, tau_d={:.4}, residual={:.6}",
            result_imperfect.tau_rise, result_imperfect.tau_decay, result_imperfect.residual
        );

        // The test always passes — it's diagnostic output
        assert!(true);
    }

    #[test]
    fn single_trace() {
        let (traces, spikes, alphas, baselines, lengths) =
            make_synthetic_data(0.06, 0.4, 30.0, 1, 300);
        let result =
            fit_biexp_direct(&traces, &spikes, &alphas, &baselines, &lengths, 30.0, true);

        assert!(
            result.tau_decay > result.tau_rise,
            "tau_d ({}) should be > tau_r ({})",
            result.tau_decay,
            result.tau_rise
        );
        assert!(
            result.residual < f64::INFINITY,
            "Should produce finite residual"
        );
    }
}
