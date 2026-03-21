/// Peak-seeded kernel bootstrap: auto-estimate initial calcium kernel from raw traces.
///
/// When no (tau_rise, tau_decay) are provided, this module bootstraps them:
/// 1. Estimate baseline per trace (median)
/// 2. Find prominent peaks (local maxima > baseline + k * MAD)
/// 3. Walk back from each peak to onset (where trace crosses baseline + 10% of peak height)
/// 4. Place spike = 1 at each onset → sparse binary spike trains
/// 5. Feed into estimate_free_kernel() → fit_biexponential() (already exist)
///
/// The result provides initial tau_rise, tau_decay for the normal iterative pipeline.
use crate::biexp_fit::{fit_biexponential, BiexpResult};
use crate::kernel_est::estimate_free_kernel;

/// Result of per-trace seed spike detection.
/// Mirrors the shape of InDecaResult so it can slot into the same kernel estimation pipeline.
#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct SeedTraceResult {
    pub s_counts: Vec<f32>,
    pub alpha: f64,
    pub baseline: f64,
}

/// Run peak-seeded spike detection on a single trace.
///
/// Returns a binary spike train (1 at each detected onset, 0 elsewhere),
/// alpha = 1.0, and baseline = median(trace). This can be fed directly
/// into the kernel estimation step as a replacement for FISTA trace inference.
pub fn seed_trace(trace: &[f32], fs: f64) -> SeedTraceResult {
    let n = trace.len();
    let (bl, _) = median_and_mad(trace);
    let onsets = find_seed_spikes(trace, fs, 5.0);

    let mut s_counts = vec![0.0_f32; n];
    for &idx in &onsets {
        s_counts[idx] = 1.0;
    }

    SeedTraceResult {
        s_counts,
        alpha: 1.0,
        baseline: bl as f64,
    }
}

/// Result of peak-seeded kernel estimation.
#[cfg_attr(feature = "jsbindings", derive(serde::Serialize))]
pub struct SeedKernelResult {
    pub free_kernel: Vec<f32>,
    pub tau_rise: f64,
    pub tau_decay: f64,
    pub beta: f64,
    pub residual: f64,
    pub tau_rise_fast: f64,
    pub tau_decay_fast: f64,
    pub beta_fast: f64,
    pub n_seed_spikes: usize,
}

/// Median of a slice (copies + sorts). Returns 0.0 for empty input.
#[cfg(test)]
fn median(data: &[f32]) -> f32 {
    if data.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f32> = data.to_vec();
    sorted.sort_unstable_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    }
}

/// Median absolute deviation of a slice.
#[cfg(test)]
fn mad(data: &[f32], median_val: f32) -> f32 {
    if data.is_empty() {
        return 0.0;
    }
    let deviations: Vec<f32> = data.iter().map(|&x| (x - median_val).abs()).collect();
    median(&deviations)
}

/// Compute median and MAD in one sort pass.
pub(crate) fn median_and_mad(data: &[f32]) -> (f32, f32) {
    if data.is_empty() {
        return (0.0, 0.0);
    }
    let mut sorted: Vec<f32> = data.to_vec();
    sorted.sort_unstable_by(|a, b| a.total_cmp(b));
    let n = sorted.len();
    let med = if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    };
    // Compute deviations in-place (reuse sorted buffer)
    for v in sorted.iter_mut() {
        *v = (*v - med).abs();
    }
    sorted.sort_unstable_by(|a, b| a.total_cmp(b));
    let mad_val = if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    };
    (med, mad_val)
}

/// Find seed spike onset locations from a single trace.
///
/// 1. Compute baseline = median(trace)
/// 2. Compute threshold = baseline + 4 * MAD
/// 3. Find local maxima above threshold, at least `min_peak_distance_s` seconds apart
/// 4. Walk back from each peak to onset (where trace drops to baseline + 10% of peak height)
///    with a max walk-back of 1 second
///
/// Returns indices into the trace where spikes should be placed.
pub fn find_seed_spikes(trace: &[f32], fs: f64, min_peak_distance_s: f64) -> Vec<usize> {
    let n = trace.len();
    if n < 3 {
        return Vec::new();
    }

    let (baseline, mad_val) = median_and_mad(trace);

    if mad_val < 1e-10 {
        return Vec::new();
    }
    let threshold = baseline + 4.0 * mad_val;

    let min_peak_dist = (min_peak_distance_s * fs).round() as usize;
    let max_walkback = (1.0 * fs).round() as usize;

    // Find local maxima above threshold
    let mut peaks: Vec<(usize, f32)> = Vec::new();
    for i in 1..n - 1 {
        if trace[i] > threshold && trace[i] >= trace[i - 1] && trace[i] >= trace[i + 1] {
            peaks.push((i, trace[i]));
        }
    }

    // Sort by amplitude (descending) for greedy selection
    peaks.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));

    // Greedy selection: keep peaks at least min_peak_dist apart
    let mut selected_peaks: Vec<usize> = Vec::new();
    for &(idx, _) in &peaks {
        let too_close = selected_peaks.iter().any(|&s| {
            let diff = if idx > s { idx - s } else { s - idx };
            diff < min_peak_dist
        });
        if !too_close {
            selected_peaks.push(idx);
        }
    }

    // Walk back from each peak to onset
    let mut onsets: Vec<usize> = Vec::with_capacity(selected_peaks.len());
    for &peak_idx in &selected_peaks {
        let peak_val = trace[peak_idx];
        let onset_threshold = baseline + 0.10 * (peak_val - baseline);

        let earliest = peak_idx.saturating_sub(max_walkback);

        let mut onset = peak_idx;
        for i in (earliest..peak_idx).rev() {
            if trace[i] <= onset_threshold {
                onset = i;
                break;
            }
        }
        // If we walked all the way back without finding onset, use earliest
        if onset == peak_idx && peak_idx > earliest {
            onset = earliest;
        }

        onsets.push(onset);
    }

    onsets.sort_unstable();
    onsets
}

/// Auto-estimate kernel from raw traces via peak-seeded free kernel estimation.
///
/// Pools seed spikes from all traces, runs `estimate_free_kernel`, then
/// `fit_biexponential` to recover (tau_rise, tau_decay).
///
/// Arguments:
/// - `traces_flat`: concatenated traces
/// - `trace_lengths`: length of each trace
/// - `fs`: sampling rate
///
/// Returns `SeedKernelResult` with free kernel and fitted tau parameters.
/// Returns default fallback values if no seed spikes are found.
pub fn seed_kernel_estimate(
    traces_flat: &[f32],
    trace_lengths: &[usize],
    fs: f64,
) -> SeedKernelResult {
    let total_len: usize = trace_lengths.iter().sum();
    assert_eq!(traces_flat.len(), total_len);

    let min_peak_distance_s = 5.0;

    // Kernel length: ~1.5 seconds at the given sampling rate
    let kernel_length = (1.5 * fs).ceil() as usize;
    let kernel_length = kernel_length.clamp(10, 200);

    let mut spike_trains = vec![0.0_f32; total_len];
    let mut alphas = Vec::with_capacity(trace_lengths.len());
    let mut baselines = Vec::with_capacity(trace_lengths.len());
    let mut total_seed_spikes = 0usize;

    let mut offset = 0;
    for &len in trace_lengths {
        let trace = &traces_flat[offset..offset + len];
        let (bl, _) = median_and_mad(trace);

        let onsets = find_seed_spikes(trace, fs, min_peak_distance_s);
        for &onset in &onsets {
            spike_trains[offset + onset] = 1.0;
            total_seed_spikes += 1;
        }

        alphas.push(1.0);
        baselines.push(bl as f64);
        offset += len;
    }

    if total_seed_spikes == 0 {
        return SeedKernelResult {
            free_kernel: vec![0.0; kernel_length],
            tau_rise: 0.02,
            tau_decay: 0.4,
            beta: 0.0,
            residual: f64::INFINITY,
            tau_rise_fast: 0.0,
            tau_decay_fast: 0.0,
            beta_fast: 0.0,
            n_seed_spikes: 0,
        };
    }

    let free_kernel = estimate_free_kernel(
        traces_flat,
        &spike_trains,
        &alphas,
        &baselines,
        trace_lengths,
        kernel_length,
        500,
        1e-5,
        None,
        0.001, // light TV smoothness for cleaner kernel from sparse seeds
    );

    let BiexpResult {
        tau_rise,
        tau_decay,
        beta,
        residual,
        tau_rise_fast,
        tau_decay_fast,
        beta_fast,
    } = fit_biexponential(&free_kernel, fs, true, 0, None);

    SeedKernelResult {
        free_kernel,
        tau_rise,
        tau_decay,
        beta,
        residual,
        tau_rise_fast,
        tau_decay_fast,
        beta_fast,
        n_seed_spikes: total_seed_spikes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::build_kernel;

    #[test]
    fn median_basic() {
        assert_eq!(median(&[1.0, 3.0, 2.0]), 2.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
        assert_eq!(median(&[]), 0.0);
        assert_eq!(median(&[5.0]), 5.0);
    }

    #[test]
    fn mad_basic() {
        let data = [1.0, 2.0, 3.0, 4.0, 5.0];
        let m = median(&data);
        let m_val = mad(&data, m);
        assert!(
            (m_val - 1.0).abs() < 1e-6,
            "MAD of [1..5] should be 1.0, got {}",
            m_val
        );
    }

    #[test]
    fn find_spikes_on_synthetic_trace() {
        let fs = 30.0;
        let tau_r = 0.02;
        let tau_d = 0.4;
        let n = 900; // 30 seconds
        let kernel = build_kernel(tau_r, tau_d, fs);

        // 3 well-separated spikes (~3.3s, ~11.7s, ~20s apart)
        let spike_positions = [100, 350, 600];
        let alpha = 10.0_f32;
        let baseline_val = 5.0_f32;
        let mut trace = vec![baseline_val; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha * kv;
                }
            }
        }

        let onsets = find_seed_spikes(&trace, fs, 5.0);

        assert!(
            onsets.len() >= 2 && onsets.len() <= 5,
            "Expected 2-5 seed spikes from 3 placed, got {}",
            onsets.len()
        );

        // Each onset should be near a true spike position (within 1 second)
        for &onset in &onsets {
            let near = spike_positions
                .iter()
                .any(|&sp| (onset as isize - sp as isize).unsigned_abs() < fs as usize);
            assert!(near, "Onset at {} is not near any true spike", onset);
        }
    }

    #[test]
    fn seed_kernel_recovers_taus() {
        let fs = 30.0;
        let tau_r_true = 0.02;
        let tau_d_true = 0.4;
        let n = 900;
        let kernel = build_kernel(tau_r_true, tau_d_true, fs);

        let spike_positions = [100, 350, 600];
        let alpha = 10.0_f32;
        let baseline_val = 5.0_f32;

        // Create 3 traces with well-separated spikes at slightly different offsets
        let mut all_traces = Vec::new();
        let mut trace_lengths = Vec::new();

        for &offset_base in &[0usize, 50, 100] {
            let mut trace = vec![baseline_val; n];
            for &pos in &spike_positions {
                let shifted = pos + offset_base;
                if shifted < n {
                    for (k, &kv) in kernel.iter().enumerate() {
                        if shifted + k < n {
                            trace[shifted + k] += alpha * kv;
                        }
                    }
                }
            }
            all_traces.extend_from_slice(&trace);
            trace_lengths.push(n);
        }

        let result = seed_kernel_estimate(&all_traces, &trace_lengths, fs);

        assert!(
            result.n_seed_spikes > 0,
            "Should find at least some seed spikes"
        );

        // tau_decay within 50% of truth (generous — this is bootstrapping)
        let td_err = (result.tau_decay - tau_d_true).abs() / tau_d_true;
        assert!(
            td_err < 0.5,
            "tau_decay error {:.0}%: got {:.4}, expected {:.4}",
            td_err * 100.0,
            result.tau_decay,
            tau_d_true
        );

        assert!(
            result.tau_rise < result.tau_decay,
            "tau_rise ({}) should be < tau_decay ({})",
            result.tau_rise,
            result.tau_decay
        );
    }

    #[test]
    fn noisy_trace_recovers_kernel_shape() {
        let fs = 30.0;
        let tau_r_true = 0.02;
        let tau_d_true = 0.4;
        let n = 1200;
        let kernel = build_kernel(tau_r_true, tau_d_true, fs);

        let spike_positions = [100, 350, 600, 900];
        let alpha = 15.0_f32;
        let baseline_val = 5.0_f32;

        let mut trace = vec![baseline_val; n];
        for &pos in &spike_positions {
            for (k, &kv) in kernel.iter().enumerate() {
                if pos + k < n {
                    trace[pos + k] += alpha * kv;
                }
            }
        }
        // Deterministic pseudo-noise
        for (i, v) in trace.iter_mut().enumerate() {
            *v += 0.5 * ((i as f64 * 0.7).sin() as f32);
        }

        let result = seed_kernel_estimate(&trace, &[n], fs);

        assert!(
            result.n_seed_spikes >= 2,
            "Should find at least 2 seed spikes in noisy trace, got {}",
            result.n_seed_spikes
        );

        let peak = result.free_kernel.iter().copied().fold(0.0_f32, f32::max);
        assert!(peak > 0.0, "Free kernel should have positive peak");

        assert!(
            result.tau_decay > 0.05 && result.tau_decay < 5.0,
            "tau_decay should be in reasonable range, got {}",
            result.tau_decay
        );
    }

    #[test]
    fn flat_trace_returns_defaults() {
        let trace = vec![5.0_f32; 300];
        let result = seed_kernel_estimate(&trace, &[300], 30.0);

        assert_eq!(result.n_seed_spikes, 0);
        assert_eq!(result.tau_rise, 0.02);
        assert_eq!(result.tau_decay, 0.4);
    }

    #[test]
    fn empty_traces() {
        let result = seed_kernel_estimate(&[], &[], 30.0);
        assert_eq!(result.n_seed_spikes, 0);
    }
}
