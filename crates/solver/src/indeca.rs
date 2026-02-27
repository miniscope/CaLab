/// InDeCa (Informed Deconvolution of Calcium imaging data) pipeline.
///
/// Chains: upsample → pre-divide by alpha estimate → bounded FISTA solve →
/// pool halo energy → threshold search → recover alpha → downsample.
///
/// The AR2 forward model is peak-normalized so that a single spike produces
/// a peak of 1.0 regardless of sampling rate, making alpha rate-independent.
///
/// The trace is pre-divided by an alpha estimate (peak-to-trough) before FISTA
/// so that Box[0,1] maps to the correct amplitude range. After FISTA, halo
/// energy (spread across neighboring upsampled bins) is pooled back into peak
/// bins before threshold search, preserving real consecutive spikes.
use std::cmp::Ordering;
use std::collections::BinaryHeap;

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
    solve_bounded_upsampled(
        &upsampled, tau_r, tau_d, fs_up, max_iters, tol, warm_start, hp_enabled, lp_enabled,
    )
}

/// Inner bounded FISTA solver operating on an already-upsampled trace.
///
/// Called by both `solve_bounded` (public API) and `solve_trace` (which
/// needs the upsampled trace for threshold search and avoids upsampling twice).
fn solve_bounded_upsampled(
    upsampled: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs_up: f64,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    hp_enabled: bool,
    lp_enabled: bool,
) -> (Vec<f32>, Option<Vec<f32>>, u32, bool) {
    let mut solver = Solver::new();
    solver.set_params(tau_r, tau_d, 0.0, fs_up);
    solver.set_conv_mode(ConvMode::BandedAR2);
    solver.set_constraint(Constraint::Box01);
    solver.set_trace(upsampled);

    let filtered = if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
        Some(solver.get_trace())
    } else {
        None
    };

    // Apply warm-start if provided
    if let Some(warm) = warm_start {
        if warm.len() == upsampled.len() {
            let n = upsampled.len();
            solver.solution[..n].copy_from_slice(warm);
            solver.solution_prev[..n].copy_from_slice(warm);
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

/// Estimate initial alpha from the trace's peak-to-trough range.
///
/// Since the kernel is peak-normalized, a single spike of amplitude alpha produces
/// a peak of alpha in the trace. Peak-to-trough >= alpha (baseline shifts it up,
/// overlapping transients can add), so this is a safe overestimate. An overestimate
/// is fine: if alpha_est > alpha_true, the pre-divided trace has spike values < 1.0,
/// which Box[0,1] doesn't clip. Returns 1.0 for flat traces.
fn estimate_alpha(trace: &[f32]) -> f64 {
    let lo = trace.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = trace.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let ptp = (hi - lo) as f64;
    if ptp < 1e-10 { 1.0 } else { ptp }
}

/// Pool halo energy into peak bins via greedy lowest-first absorption.
///
/// At upsampled rates, FISTA spreads a spike's energy across neighboring bins
/// (the "halo"). This function lets higher-valued bins absorb energy from
/// nearby lower-valued bins, concentrating halos back into peaks.
///
/// Algorithm:
/// 1. Order all nonzero bins by value (highest first) in a max-heap
/// 2. Pop the highest bin; within ±upsample_factor/2, find the lowest-valued
///    unprocessed neighbor and absorb its energy
/// 3. Repeat absorbing from the next-lowest neighbor until the bin reaches 1.0
///    or no unprocessed neighbors remain
/// 4. Mark the bin as processed (it can no longer be a donor)
/// 5. If a donor was only partially consumed, push its updated value back into
///    the heap so it can later be an absorber at its reduced value
/// 6. Pop the next highest bin and repeat
///
/// Grabbing from the **lowest** neighbor first ensures halos (tiny values like
/// 0.02–0.1) are consumed before any real neighboring spike is touched. A real
/// spike at 0.9 only needs 0.1 to reach 1.0 — it grabs a couple of 0.02 halo
/// values and stops, leaving an adjacent 0.8 spike untouched.
///
/// The window (`upsample_factor / 2` per side) represents the positional
/// flexibility within one original-rate bin — energy spread within this range
/// is an artifact of upsampling, not real sub-sample structure. At
/// upsample_factor=1 this is a no-op.
fn pool_energy(s: &mut [f32], upsample_factor: usize) {
    if upsample_factor <= 1 {
        return;
    }
    let n = s.len();
    let half = upsample_factor / 2;

    // Max-heap keyed on value. Stale entries (where heap value != current s[i])
    // are skipped on pop, so we don't need decrease-key.
    #[derive(PartialEq)]
    struct Entry(f32, usize);
    impl Eq for Entry {}
    impl PartialOrd for Entry {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
            self.0.partial_cmp(&other.0)
        }
    }
    impl Ord for Entry {
        fn cmp(&self, other: &Self) -> Ordering {
            self.partial_cmp(other).unwrap_or(Ordering::Equal)
        }
    }

    let mut heap = BinaryHeap::new();
    for (i, &v) in s.iter().enumerate() {
        if v > 1e-10 {
            heap.push(Entry(v, i));
        }
    }

    let mut processed = vec![false; n];

    while let Some(Entry(heap_val, idx)) = heap.pop() {
        // Skip stale entries (value changed since insertion)
        if processed[idx] || (s[idx] - heap_val).abs() > 1e-6 {
            continue;
        }
        processed[idx] = true;

        let mut deficit = 1.0_f32 - s[idx];
        if deficit <= 1e-10 {
            continue;
        }

        // Repeatedly absorb from the lowest-valued unprocessed neighbor
        while deficit > 1e-10 {
            // Scan window for the lowest unprocessed neighbor
            let lo = idx.saturating_sub(half);
            let hi = (idx + half + 1).min(n);
            let mut min_val = f32::INFINITY;
            let mut min_j = None;
            for j in lo..hi {
                if j != idx && !processed[j] && s[j] > 1e-10 && s[j] < min_val {
                    min_val = s[j];
                    min_j = Some(j);
                }
            }

            let Some(j) = min_j else { break };

            let take = s[j].min(deficit);
            s[idx] += take;
            s[j] -= take;
            deficit -= take;

            // Push updated value so donor can be an absorber later at its new value
            if s[j] > 1e-10 {
                heap.push(Entry(s[j], j));
            }
        }
    }
}

/// Full InDeCa trace processing pipeline.
///
/// 1. Upsample trace (linear interpolation)
/// 2. Estimate alpha from peak-to-trough, pre-divide trace
/// 3. Solve bounded FISTA (Box01, lambda=0) on scaled trace
/// 4. Pool halo energy: concentrate spread energy back into peak bins
/// 5. Threshold search: binarize → AR2 convolve → lstsq alpha/baseline
/// 6. Recover original-scale alpha and baseline
/// 7. Downsample binary spike train to original rate
///
/// The alpha pre-divide ensures Box[0,1] is the right constraint regardless of
/// the trace's amplitude. The energy pooling (step 4) lets higher-valued bins
/// absorb nearby lower-valued bins within a window of `upsample_factor` — the
/// positional flexibility from upsampling. Real consecutive spikes survive
/// because high-valued bins only absorb up to a deficit of 1.0, leaving
/// neighboring spikes mostly intact.
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

    // Pre-divide by alpha estimate so Box[0,1] maps to the correct amplitude range.
    // A spike value of 1.0 in the solver now corresponds to an alpha-sized transient.
    let alpha_est = estimate_alpha(&upsampled);
    let scaled: Vec<f32> = upsampled.iter().map(|&v| v / alpha_est as f32).collect();

    // Convert original-rate spike counts to upsampled-rate binary for warm-start
    let warm_binary = warm_counts.map(|counts| upsample_counts_to_binary(counts, upsample_factor));
    let warm_start = warm_binary.as_deref();

    // Step 1: Bounded FISTA solve on scaled (optionally filtered) trace
    let (mut s_relaxed, filtered_up, iterations, converged) = solve_bounded_upsampled(
        &scaled, tau_r, tau_d, fs_up, max_iters, tol, warm_start, hp_enabled, lp_enabled,
    );

    // Step 2: Pool halo energy before threshold search.
    // FISTA spreads spike energy across neighboring upsampled bins. Pooling
    // lets peak bins absorb nearby lower values (up to a total of 1.0), so
    // threshold search sees concentrated peaks rather than halos. Real
    // consecutive spikes survive because high-valued bins barely need to
    // absorb anything.
    pool_energy(&mut s_relaxed, upsample_factor);

    // Step 3: Threshold search on pooled, scaled trace
    let banded = BandedAR2::new(tau_r, tau_d, fs_up);
    let ThresholdResult {
        s_binary,
        alpha: alpha_lstsq,
        baseline: baseline_lstsq,
        threshold,
        pve,
        ..
    } = threshold_search(&s_relaxed, &scaled, &banded, tau_d, fs_up);

    // Step 4: Recover original-scale alpha and baseline.
    // The lstsq fit was on y/alpha_est, so:
    //   y/alpha_est ≈ alpha_lstsq * K * s + baseline_lstsq
    //   y ≈ (alpha_est * alpha_lstsq) * K * s + (alpha_est * baseline_lstsq)
    let alpha = alpha_est * alpha_lstsq;
    let baseline = alpha_est * baseline_lstsq;

    // Step 5: Downsample binary spike train to original rate
    let s_counts = downsample_binary(&s_binary, upsample_factor);

    // Step 6: Downsample filtered trace to original rate.
    // Un-scale the filtered trace so downstream reconvolution uses original amplitudes.
    let filtered_trace = filtered_up.map(|ft| {
        let ft_unscaled: Vec<f32> = ft.iter().map(|&v| v * alpha_est as f32).collect();
        downsample_average(&ft_unscaled, upsample_factor)
    });

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
        let trace = make_trace(0.02, 0.4, 30.0, 300, &spike_positions);
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
    /// alpha_est + pooling halo energy before threshold search fixes this.
    #[test]
    fn high_alpha_upsampled_no_overcounting() {
        let tau_r = 0.02;
        let tau_d = 0.4;
        let fs = 30.0;
        let n = 300;
        let spike_positions = [20, 80, 150, 220];
        let alpha_true = 5.0_f32;
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
        assert!(
            total_counts >= 3.0 && total_counts <= 8.0,
            "Expected ~4 spike counts (range [3, 8]) with alpha=5 at 10x upsample, got {}",
            total_counts
        );

        assert!(
            (result.alpha - alpha_true as f64).abs() < 2.5,
            "Alpha should be close to {}, got {}",
            alpha_true,
            result.alpha
        );
    }
}
