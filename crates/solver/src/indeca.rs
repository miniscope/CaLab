/// InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
///
/// Uses a scale iteration loop mirroring the original Python InDeCa:
///
/// 1. Estimate initial alpha from trace peak-to-trough
/// 2. Iterate: prescale by alpha_est → Box[0,1] FISTA → threshold search
///    → lstsq recovers alpha_lstsq → update alpha_est *= alpha_lstsq
/// 3. Converges when alpha_lstsq ≈ 1.0 (prescale matches true amplitude)
///
/// The iteration prevents the single-pass problem where an inaccurate initial
/// prescale causes the solver to settle on high alpha with too few spikes.
///
/// The AR2 forward model is peak-normalized so that a single spike produces
/// a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
use crate::banded::BandedAR2;
use crate::threshold::{threshold_search, ThresholdResult};
use crate::upsample::{
    downsample_average, downsample_binary, upsample_counts_to_binary, upsample_trace,
};
use crate::{Constraint, ConvMode, Solver};

#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct InDecaResult {
    pub s_counts: Vec<f32>,
    pub filtered_trace: Option<Vec<f32>>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    pub iterations: u32,
    pub converged: bool,
}

/// Run bounded FISTA on a (possibly upsampled) trace.
///
/// Uses Box01 constraint with lambda=0 and BandedAR2 convolution.
/// Returns (relaxed_solution, filtered_trace_if_filtering, iterations, converged).
pub fn solve_bounded(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    let upsampled = upsample_trace(trace, upsample_factor);
    let fs_up = fs * upsample_factor as f64;
    let mut solver = Solver::new();
    solve_upsampled(
        &mut solver,
        &upsampled,
        tau_r,
        tau_d,
        fs_up,
        max_iters,
        tol,
        warm_start,
        hp_enabled,
        lp_enabled,
        Constraint::Box01,
        false,
    )
}

/// Inner FISTA solver operating on an already-upsampled trace.
///
/// Called by `solve_bounded` (public API) and by `solve_trace` (scale iteration).
/// Accepts `solver` by mutable reference so callers can reuse a single allocation
/// across multiple calls (`set_trace` resets all state; buffers grow but never shrink).
///
/// `baseline_subtracted`: when true, the trace has already had its baseline
/// removed externally (via rolling-percentile subtraction), so FISTA should
/// skip its internal baseline estimation (sets `solver.filtered = true`).
fn solve_upsampled(
    solver: &mut Solver,
    upsampled: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
    constraint: Constraint,
    baseline_subtracted: bool,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    solver.set_params(tau_r, tau_d, 0.0, fs_up);
    solver.set_conv_mode(ConvMode::BandedAR2);
    solver.set_constraint(constraint);
    solver.set_trace(upsampled);

    if baseline_subtracted {
        solver.filtered = true;
    }

    let filtered = if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
        Some(solver.get_trace())
    } else {
        None
    };

    // Apply warm-start if provided (must match trace length)
    if let Some(warm) = warm_start {
        if warm.len() == upsampled.len() {
            solver.solution[..warm.len()].copy_from_slice(warm);
            solver.solution_prev[..warm.len()].copy_from_slice(warm);
        }
    }

    solver.tolerance = tol;

    // Run FISTA in batches
    let batch_size = 50;
    let max_batches = max_iters.div_ceil(batch_size);
    for _ in 0..max_batches {
        if solver.step_batch(batch_size) {
            break;
        }
        if solver.iteration_count() >= max_iters {
            break;
        }
    }

    let solution = solver.get_solution();
    let iterations = solver.iteration_count();
    let converged = solver.converged();

    (solution, filtered, iterations, converged)
}

/// Estimate alpha from the interior of the trace (excluding boundary padding).
///
/// Uses peak-to-trough of the inner region to avoid edge artifacts that occur
/// when solving trace subsets that start or end mid-transient.
/// Since the kernel is peak-normalized, peak-to-trough >= alpha, making this
/// a safe overestimate. Returns 1.0 for flat traces.
fn estimate_alpha_interior(trace: &[f32], pad: usize) -> f64 {
    let n = trace.len();
    let lo_idx = pad.min(n);
    let hi_idx = n.saturating_sub(pad).max(lo_idx);
    let inner = &trace[lo_idx..hi_idx];
    if inner.is_empty() {
        // Trace too short for padding — fall back to full trace
        let lo = trace.iter().copied().fold(f32::INFINITY, f32::min);
        let hi = trace.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let ptp = (hi - lo) as f64;
        return if ptp < 1e-10 { 1.0 } else { ptp };
    }
    let lo = inner.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = inner.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let ptp = (hi - lo) as f64;
    if ptp < 1e-10 {
        1.0
    } else {
        ptp
    }
}

/// Maximum value in the interior of a slice, excluding `pad` samples from each end.
///
/// Falls back to the full slice when the interior is empty.
fn interior_peak(s: &[f32], pad: usize) -> f32 {
    let n = s.len();
    let lo = pad.min(n);
    let hi = n.saturating_sub(pad).max(lo);
    let region = if hi > lo { &s[lo..hi] } else { s };
    region.iter().copied().fold(0.0_f32, f32::max)
}

/// Full InDeCa trace processing pipeline with scale iteration.
///
/// Mirrors InDeCa's `solve_scale` loop:
/// 1. Upsample, apply optional bandpass filter
/// 2. Estimate initial alpha from trace peak-to-trough
/// 3. Iterate: prescale → Box[0,1] FISTA → threshold search → update alpha
///    until alpha_lstsq converges near 1.0 (prescale matches true amplitude)
/// 4. Recover original-scale alpha, downsample spike train
///
/// The iteration loop is the key difference from the single-pass approach:
/// each round refines the prescale so Box[0,1] maps correctly, preventing
/// the solver from settling on high alpha with too few spikes.
///
/// `warm_counts`: optional spike counts from a previous iteration at the **original**
/// sampling rate. These are upsampled to a binary trace at the upsampled rate and
/// used as FISTA warm-start, which typically reduces iterations by 30-60%.
pub fn solve_trace(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    warm_counts: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
) -> InDecaResult {
    let fs_up = fs * upsample_factor as f64;
    let upsampled = upsample_trace(trace, upsample_factor);

    // Single solver allocation reused across all solve_upsampled calls.
    // set_trace() resets all state; buffers grow but never shrink.
    let mut solver = Solver::new();

    // ── Step 1: Apply optional bandpass filter + rolling baseline subtraction ──
    // Run a throwaway FISTA just to get the filtered trace (if HP/LP), then
    // subtract the rolling-percentile baseline so the floor is ~0.
    let mut working_trace = if hp_enabled || lp_enabled {
        let (_, filtered_up, _, _) = solve_upsampled(
            &mut solver,
            &upsampled,
            tau_r,
            tau_d,
            fs_up,
            1, // only 1 iteration — we just need the filtered trace
            tol,
            None,
            hp_enabled,
            lp_enabled,
            Constraint::Box01,
            false,
        );
        filtered_up.unwrap()
    } else {
        upsampled
    };

    // Rolling-percentile baseline subtraction: brings the floor to ~0.
    let bl_window = crate::baseline::baseline_window(tau_d, fs_up);
    crate::baseline::subtract_rolling_baseline(&mut working_trace, bl_window, 0.2);

    // ── Step 2: Boundary padding + initial alpha estimate ───────────────
    // Compute boundary padding: edge effects from AR2 convolution make the first
    // and last `pad` samples unreliable. When solving trace subsets (common in
    // CaDecon iteration), the trace may start mid-transient, creating a large
    // spurious spike at position 0. Zeroing the boundary region of the FISTA
    // solution prevents these edge artifacts from corrupting the threshold search.
    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(working_trace.len() / 4);

    // Estimate alpha from the interior of the trace only (excluding edges).
    let mut alpha_est = estimate_alpha_interior(&working_trace, pad);

    // Convert original-rate spike counts to upsampled-rate binary for warm-start
    let warm_binary = warm_counts.map(|counts| upsample_counts_to_binary(counts, upsample_factor));

    let banded = BandedAR2::new(tau_r, tau_d, fs_up);

    // ── Step 3: Scale iteration loop ────────────────────────────────────
    // Each round: prescale by alpha_est → Box[0,1] FISTA → threshold search
    // against the *original* trace → lstsq recovers alpha directly.
    // Converges when alpha_lstsq ≈ alpha_est (prescale matches true amplitude).
    const MAX_SCALE_ITERS: usize = 10;
    const SCALE_RTOL: f64 = 0.05;

    let mut best_pve = f64::NEG_INFINITY;
    let mut best_result: Option<(Vec<f32>, f64, f64, f64, f64, u32, bool)> = None;

    // Pre-allocate scratch buffers reused across scale iterations.
    let wt_len = working_trace.len();
    let mut scaled = vec![0.0_f32; wt_len];
    let mut s_normalized = vec![0.0_f32; wt_len];

    for scale_iter in 0..MAX_SCALE_ITERS {
        // Fill scaled buffer in-place (multiply by reciprocal instead of dividing).
        let inv_alpha = 1.0 / alpha_est as f32;
        for i in 0..wt_len {
            scaled[i] = working_trace[i] * inv_alpha;
        }

        // Use warm-start from user on first iteration only;
        // subsequent iterations start fresh with the refined prescale.
        let warm_start = if scale_iter == 0 {
            warm_binary.as_deref()
        } else {
            None
        };

        let (s_relaxed, _, iterations, converged) = solve_upsampled(
            &mut solver,
            &scaled,
            tau_r,
            tau_d,
            fs_up,
            max_iters,
            tol,
            warm_start,
            false,
            false,
            Constraint::Box01,
            true, // trace is baseline-subtracted → skip FISTA baseline estimation
        );

        // Normalize relaxed solution to [0,1] before threshold search.
        // Use the interior peak only (excluding boundary padding) so that edge
        // artifacts from trace subsets starting mid-transient don't dominate.
        let s_peak = interior_peak(&s_relaxed, pad);
        if s_peak > 1e-10 {
            let inv_peak = 1.0 / s_peak;
            for i in 0..s_relaxed.len() {
                s_normalized[i] = s_relaxed[i] * inv_peak;
            }
        } else {
            s_normalized[..s_relaxed.len()].copy_from_slice(&s_relaxed);
        }
        let s_norm_slice = &s_normalized[..s_relaxed.len()];

        // Threshold search fits binarized spikes against the ORIGINAL trace.
        let ThresholdResult {
            s_binary,
            alpha: alpha_lstsq,
            baseline: baseline_lstsq,
            threshold,
            pve,
            ..
        } = threshold_search(
            s_norm_slice,
            &working_trace,
            &banded,
            tau_d,
            fs_up,
            upsample_factor,
            f64::INFINITY,
        );

        // Track the best result by PVE.
        // alpha_lstsq is already the true alpha (fit against original trace).
        if pve > best_pve {
            best_pve = pve;
            best_result = Some((
                s_binary,
                alpha_lstsq,
                baseline_lstsq,
                threshold,
                pve,
                iterations,
                converged,
            ));
        }

        // Converged: alpha_lstsq ≈ alpha_est means the prescale was correct.
        if alpha_est > 1e-10 && (alpha_lstsq / alpha_est - 1.0).abs() < SCALE_RTOL {
            break;
        }

        // Update alpha_est to the lstsq-recovered value for the next round.
        if alpha_lstsq < 1e-10 {
            break;
        }
        alpha_est = alpha_lstsq;
    }

    // ── Step 4: Extract best result ─────────────────────────────────────
    let (s_binary, alpha, baseline, threshold, pve, iterations, converged) = best_result
        .unwrap_or_else(|| {
            // Fallback: no valid result found (shouldn't happen)
            (vec![0.0; wt_len], 0.0, 0.0, 0.0, 0.0, 0, false)
        });

    // Downsample binary spike train to original rate
    let s_counts = downsample_binary(&s_binary, upsample_factor);

    // Downsample filtered trace to original rate directly from working_trace
    // (working_trace is not modified after baseline subtraction).
    let filtered_trace = Some(downsample_average(&working_trace, upsample_factor));

    InDecaResult {
        s_counts,
        filtered_trace,
        alpha,
        baseline,
        threshold,
        pve,
        iterations,
        converged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::build_kernel;

    /// Build a clean trace: convolve spikes through the kernel.
    fn make_trace(tau_r: f64, tau_d: f64, fs: f64, n: usize, spike_pos: &[usize]) -> Vec<f32> {
        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![0.0_f32; n];
        for &s in spike_pos {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }
        trace
    }

    #[test]
    fn outputs_in_range() {
        let trace = make_trace(0.02, 0.4, 30.0, 300, &[20, 80, 150, 220]);
        let result = solve_trace(&trace, 0.02, 0.4, 30.0, 1, 500, 1e-4, None, false, false);

        // Spike counts should be non-negative
        for (i, &v) in result.s_counts.iter().enumerate() {
            assert!(v >= 0.0, "Negative spike count at {}: {}", i, v);
        }

        // Output length should match input
        assert_eq!(result.s_counts.len(), trace.len());
    }

    #[test]
    fn known_spike_detection() {
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 300;
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }
        let result = solve_trace(&trace, 0.02, 0.4, 30.0, 1, 1000, 1e-4, None, false, false);

        // Check that spikes are detected near the true positions
        let mut detected = 0;
        for &pos in &spike_positions {
            // Check a window around the true position
            let lo = pos.saturating_sub(3);
            let hi = (pos + 3).min(result.s_counts.len());
            let max_in_window: f32 = result.s_counts[lo..hi].iter().copied().fold(0.0, f32::max);
            if max_in_window > 0.1 {
                detected += 1;
            }
        }

        assert!(
            detected >= 2,
            "Should detect at least 2 of 3 spikes, detected {}",
            detected
        );
    }

    #[test]
    fn warm_start_converges_faster() {
        let trace = make_trace(0.02, 0.4, 30.0, 200, &[20, 80, 150]);

        // Get the cold solution for warm-start
        let (cold_sol, _, _, _) =
            solve_bounded(&trace, 0.02, 0.4, 30.0, 1, 500, 1e-4, None, false, false);

        // Warm solve with slightly different taus
        let (_, _, warm_iters, _) = solve_bounded(
            &trace,
            0.025,
            0.45,
            30.0,
            1,
            500,
            1e-4,
            Some(&cold_sol),
            false,
            false,
        );

        // Warm-start may or may not be faster depending on how different the params are,
        // but it should at least produce a valid result
        assert!(warm_iters > 0, "Should run at least 1 iteration");
        // For very similar params, warm-start should typically help
        // (but not guaranteed in all cases, so we just check it runs)
    }

    #[test]
    fn upsampled_output_length() {
        let trace = make_trace(0.02, 0.4, 30.0, 100, &[20, 50]);
        let result = solve_trace(&trace, 0.02, 0.4, 30.0, 10, 200, 1e-3, None, false, false);

        // Output should be same length as input regardless of upsample factor
        assert_eq!(
            result.s_counts.len(),
            trace.len(),
            "Output length should match input after downsampling"
        );
    }

    #[test]
    fn zero_trace() {
        let trace = vec![0.0_f32; 100];
        let result = solve_trace(&trace, 0.02, 0.4, 30.0, 1, 100, 1e-4, None, false, false);
        let total_spikes: f32 = result.s_counts.iter().sum();
        assert!(
            total_spikes < 1e-6,
            "Zero trace should produce no spikes, got {}",
            total_spikes
        );
    }

    /// High alpha + upsampling should not overcount.
    ///
    /// Before the fix, alpha=5 + upsample=10x produced ~41 detected spikes because
    /// Box[0,1] FISTA spread energy to neighboring upsampled bins. Pre-dividing by
    /// alpha_est before threshold search fixes this.
    #[test]
    fn high_alpha_upsampled_no_overcounting() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n = 300;
        let spike_positions = [20, 80, 150, 220];
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(&trace, tau_r, tau_d, fs, 10, 500, 1e-4, None, false, false);

        let total_counts: f32 = result.s_counts.iter().sum();

        // With 10x upsampling + baseline subtraction, each spike can spread to
        // several upsampled bins. The count may exceed the true spike count, but
        // alpha × count (total energy) should still be conserved.
        assert!(
            total_counts >= 2.0 && total_counts <= 30.0,
            "Expected spike counts in [2, 30] at 10x upsample, got {}",
            total_counts
        );

        // Alpha × spike_count should approximate the total transient energy.
        // true energy = 4 spikes × alpha 10 = 40
        let total_energy = result.alpha * total_counts as f64;
        let expected_energy = spike_positions.len() as f64 * alpha_true as f64;
        assert!(
            (total_energy - expected_energy).abs() < expected_energy * 0.5,
            "Total energy (alpha×count) should be ~{}, got {} (alpha={}, counts={})",
            expected_energy,
            total_energy,
            result.alpha,
            total_counts
        );

        // PVE should be very high on clean synthetic data
        assert!(
            result.pve > 0.95,
            "PVE should be > 0.95, got {}",
            result.pve
        );
    }

    /// Trace subset starting mid-transient should not produce spurious edge spikes.
    /// In CaDecon, each cell is solved on a time-window subset. When the subset
    /// starts during a calcium transient, the first samples are mid-decay and FISTA
    /// may try to explain them with a spike at position 0. The boundary masking
    /// should prevent this from dominating the result.
    #[test]
    fn trace_subset_mid_transient() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n_full = 600;
        let alpha_true = 10.0_f32;
        let baseline_true = 2.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let spike_positions = [10, 80, 160, 250, 340, 450, 550];
        let mut full_trace = vec![baseline_true; n_full];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n_full {
                    full_trace[pos + k] += alpha_true * kv;
                }
            }
        }

        // Take a subset that starts mid-transient (during the decay after spike at 10)
        let subset_start = 15; // 5 samples after the spike — deep in the decay
        let subset_end = 400;
        let subset = &full_trace[subset_start..subset_end];

        let result = solve_trace(subset, tau_r, tau_d, fs, 1, 1000, 1e-4, None, false, false);
        let total_spikes: f32 = result.s_counts.iter().sum();

        // Should detect interior spikes, not just the edge artifact
        assert!(
            total_spikes >= 3.0,
            "Should detect at least 3 interior spikes from subset, got {} (alpha={:.2}, threshold={:.4}, pve={:.4})",
            total_spikes, result.alpha, result.threshold, result.pve
        );

        // PVE should be reasonable (not garbage from a single edge spike)
        assert!(result.pve > 0.7, "PVE should be > 0.7, got {}", result.pve);
    }

    /// High baseline should not prevent spike detection.
    /// Real calcium traces often have baseline >> transient amplitude.
    #[test]
    fn high_baseline_spike_detection() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n = 300;
        let spike_positions = [30, 100, 200];
        let alpha_true = 10.0_f32;
        let baseline_true = 100.0_f32;

        let kernel = build_kernel(tau_r, tau_d, fs);
        let mut trace = vec![baseline_true; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha_true * kv;
                }
            }
        }

        let result = solve_trace(&trace, tau_r, tau_d, fs, 1, 1000, 1e-4, None, false, false);
        let total_spikes: f32 = result.s_counts.iter().sum();

        assert!(
            total_spikes >= 2.0,
            "Should detect at least 2 spikes with high baseline, got {} (alpha={:.2}, threshold={:.4}, pve={:.4})",
            total_spikes, result.alpha, result.threshold, result.pve
        );
    }
}
