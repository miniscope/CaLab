/// Free-form kernel estimation via FISTA with non-negativity.
///
/// Given observed traces and inferred spike trains, estimate the shared
/// calcium kernel h by solving:
///   min_h (1/2)||y - S*h||^2 + λ_smooth * ||Δh||_1  subject to h >= 0
/// where S is the spike convolution matrix, y is the concatenated traces,
/// and ||Δh||_1 is the total variation (L1 norm of first differences).
///
/// Uses FISTA with non-negativity constraint and optional TV smoothness penalty.
///
/// # Why free-form estimation instead of direct (tau_r, tau_d) optimization
///
/// An alternative approach — optimizing tau_rise and tau_decay directly by
/// evaluating trace-level reconstruction quality for each (tau_r, tau_d) pair —
/// was investigated and found to be fundamentally ill-conditioned.
///
/// The free-form kernel has ~50 degrees of freedom, which is enough to resolve
/// the bi-exponential structure unambiguously: the sharp rise edge and long
/// decay tail are geometrically distinct features in the kernel vector. The
/// subsequent bi-exponential fit (see `biexp_fit.rs`) operates on this
/// recovered shape where the two time constants are clearly separable.
///
/// Direct (tau_r, tau_d) optimization against trace reconstruction fails
/// because different bi-exponential parameterizations produce nearly identical
/// convolutions when convolved with realistic (overlapping) spike trains.
/// The loss surface becomes a shallow valley where tau_r and tau_d drift
/// toward each other — the optimizer cannot distinguish rise from decay at
/// the trace level. This happens regardless of the metric used (raw SSE,
/// projection residual, correlation). The problem is not the metric but the
/// information content: trace-level reconstruction simply does not contain
/// enough signal to separately identify two time constants.
///
/// This matches findings from Pachitariu et al. (2018), who showed that all
/// tested methods fail to recover accurate calcium indicator time constants
/// from data, and recommended fixing them to literature values. The two-step
/// approach here (free kernel → biexp fit) works because the kernel-shape
/// fitting step sidesteps the trace-level ambiguity entirely.
///
/// See also: OASIS (Friedrich et al. 2017) uses autocovariance-based
/// estimation (Yule-Walker) for initial time constants, avoids joint
/// (tau_r, tau_d) optimization, and refines on isolated large events only.

/// In-place 1D total variation proximal operator (Chambolle 2004).
///
/// Solves: argmin_z (1/2)||z - x||² + lambda * sum |z[i+1] - z[i]|
/// via dual projected gradient descent on:
///   min_u (1/2)||x - D^T u||²  s.t. ||u||_inf <= lambda
/// where D is the forward-difference operator: (Dz)[i] = z[i+1] - z[i].
///
/// Primal reconstruction: z = x - D^T u, where:
///   (D^T u)[0] = -u[0], (D^T u)[j] = u[j-1]-u[j], (D^T u)[n-1] = u[n-2]
///
/// O(n * iters) — fast for short kernels (n <= 50).
fn prox_tv_1d(x: &mut [f64], lambda: f64) {
    let n = x.len();
    if n <= 1 || lambda <= 0.0 {
        return;
    }

    let mut u = vec![0.0_f64; n - 1]; // dual variable, ||u||_inf <= lambda
    let mut z = vec![0.0_f64; n]; // primal reconstruction buffer
    let tau = 0.249; // step size < 1/||DD^T|| = 1/4

    for _ in 0..100 {
        // Reconstruct primal: z = x - D^T u
        //   z[0]   = x[0]   - (-u[0])     = x[0] + u[0]
        //   z[j]   = x[j]   - (u[j-1]-u[j]) = x[j] - u[j-1] + u[j]
        //   z[n-1] = x[n-1] - u[n-2]
        z[0] = x[0] + u[0];
        for j in 1..n - 1 {
            z[j] = x[j] - u[j - 1] + u[j];
        }
        z[n - 1] = x[n - 1] - u[n - 2];

        // Gradient descent: u <- clamp(u + tau * Dz, -lambda, lambda)
        //   (Dz)[i] = z[i+1] - z[i]
        for i in 0..n - 1 {
            u[i] = (u[i] + tau * (z[i + 1] - z[i])).clamp(-lambda, lambda);
        }
    }

    // Final primal reconstruction: x <- x - D^T u (in-place)
    x[0] += u[0];
    for j in 1..n - 1 {
        x[j] += u[j] - u[j - 1];
    }
    x[n - 1] -= u[n - 2];
}

/// Estimate a free-form kernel from multiple traces and their spike trains.
///
/// Concatenates all (trace, spike) pairs into a single regression problem
/// to improve the estimate. Each trace is pre-processed: y_adj = (y - baseline) / alpha.
///
/// `warm_start`: optional kernel from a previous iteration, used as initial guess
/// for FISTA. Must be the same length as `kernel_length`. FISTA momentum is reset
/// since the spike trains have changed between iterations.
///
/// Arguments:
/// - `traces`: flat array of concatenated traces (each of length trace_lengths[i])
/// - `spike_trains`: flat array of concatenated binary spike trains
/// - `alphas`: per-trace scaling factors from threshold search
/// - `baselines`: per-trace baselines from threshold search
/// - `trace_lengths`: length of each individual trace
/// - `kernel_length`: desired length of the output kernel
/// - `max_iters`: maximum FISTA iterations
/// - `tol`: convergence tolerance
/// - `warm_start`: optional previous kernel estimate for warm-starting FISTA
/// - `smooth_lambda`: TV-L1 smoothness penalty weight (0 = no smoothness)
///
/// Returns the estimated kernel of length `kernel_length`.
pub fn estimate_free_kernel(
    traces: &[f32],
    spike_trains: &[f32],
    alphas: &[f64],
    baselines: &[f64],
    trace_lengths: &[usize],
    kernel_length: usize,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    smooth_lambda: f64,
) -> Vec<f32> {
    let n_traces = trace_lengths.len();
    assert_eq!(alphas.len(), n_traces);
    assert_eq!(baselines.len(), n_traces);

    let total_len: usize = trace_lengths.iter().sum();
    assert_eq!(traces.len(), total_len);
    assert_eq!(spike_trains.len(), total_len);

    if kernel_length == 0 || total_len == 0 {
        return vec![0.0; kernel_length];
    }

    // Build adjusted targets: y_adj = (y - baseline) / alpha
    let mut y_adj = vec![0.0_f32; total_len];
    let mut offset = 0;
    for i in 0..n_traces {
        let len = trace_lengths[i];
        let alpha = alphas[i];
        let baseline = baselines[i];
        if alpha.abs() < 1e-20 {
            // Skip traces with zero alpha (no spikes detected)
            offset += len;
            continue;
        }
        for j in 0..len {
            y_adj[offset + j] = ((traces[offset + j] as f64 - baseline) / alpha) as f32;
        }
        offset += len;
    }

    // FISTA for kernel estimation: min_h (1/2)||y_adj - S*h||^2  s.t. h >= 0
    // S*h = sum_t s[t] * h[t-k] (convolution of spikes with kernel)
    // Gradient: S^T * (S*h - y_adj)

    // Estimate Lipschitz constant via power iteration on S^T S.
    // The simple bound L = sum(s^2) underestimates for dense/correlated spikes,
    // causing FISTA to oscillate. Power iteration gives a tighter estimate.
    let lipschitz = {
        // Power iteration: v_{k+1} = S^T S v_k / ||S^T S v_k||
        let mut v = vec![1.0_f64; kernel_length];
        let norm: f64 = (kernel_length as f64).sqrt();
        for val in v.iter_mut() {
            *val /= norm;
        }
        let mut sv = vec![0.0_f32; total_len]; // S*v
        let mut stv = vec![0.0_f64; kernel_length]; // S^T S v
        let mut eigenvalue = 1.0_f64;

        let mut v_f32 = vec![0.0_f32; kernel_length];

        for _ in 0..20 {
            // Cast v to f32 into pre-allocated buffer
            for (dst, &src) in v_f32.iter_mut().zip(v.iter()) {
                *dst = src as f32;
            }
            // S*v: convolve spikes with v
            convolve_spikes_kernel(spike_trains, trace_lengths, &v_f32, &mut sv);

            // S^T (S*v)
            adjoint_spikes_kernel(&sv, spike_trains, trace_lengths, kernel_length, &mut stv);

            // eigenvalue estimate = ||S^T S v||
            eigenvalue = stv.iter().map(|&x| x * x).sum::<f64>().sqrt();
            if eigenvalue < 1e-20 {
                eigenvalue = 1.0;
                break;
            }

            // Normalize
            for (vi, &si) in v.iter_mut().zip(stv.iter()) {
                *vi = si / eigenvalue;
            }
        }
        eigenvalue.max(1.0)
    };
    let step_size = 1.0 / lipschitz;

    let mut h = vec![0.0_f32; kernel_length];
    let mut h_prev = vec![0.0_f32; kernel_length];
    if let Some(warm) = warm_start {
        if warm.len() == kernel_length {
            h.copy_from_slice(warm);
            h_prev.copy_from_slice(warm);
        }
    }
    let mut gradient = vec![0.0_f64; kernel_length];
    let mut t_fista = 1.0_f64;

    // Working buffer for S*h (convolution result)
    let mut sh = vec![0.0_f32; total_len];

    let mut z = vec![0.0_f64; kernel_length];

    for iter in 0..max_iters {
        // Forward: S*h (convolve each trace's spikes with h)
        convolve_spikes_kernel(spike_trains, trace_lengths, &h_prev, &mut sh);

        // Residual: r = S*h - y_adj (compute in-place in sh)
        for i in 0..total_len {
            sh[i] -= y_adj[i];
        }

        // Gradient: S^T * r
        adjoint_spikes_kernel(
            &sh,
            spike_trains,
            trace_lengths,
            kernel_length,
            &mut gradient,
        );

        // Proximal gradient step: gradient descent on data-fidelity, then
        // TV proximal operator, then non-negativity projection.
        for k in 0..kernel_length {
            z[k] = h_prev[k] as f64 - step_size * gradient[k];
        }

        // Apply TV-L1 proximal operator to resist kernel sharpening.
        // The proximal parameter is smooth_lambda (not scaled by step_size,
        // so that lambda is interpretable as an absolute TV strength on the
        // kernel shape, independent of the data-fidelity Lipschitz constant).
        if smooth_lambda > 0.0 && kernel_length > 1 {
            prox_tv_1d(&mut z, smooth_lambda);
        }

        // Non-negativity projection + convergence tracking
        let mut diff_sq = 0.0_f64;
        let mut h_sq = 0.0_f64;
        for k in 0..kernel_length {
            let h_old = h[k];
            h[k] = z[k].max(0.0) as f32;
            let d = h[k] as f64 - h_old as f64;
            diff_sq += d * d;
            h_sq += (h_old as f64) * (h_old as f64);
        }

        // Convergence check
        if iter > 5 && diff_sq < tol * tol * (h_sq + 1e-20) {
            break;
        }

        // FISTA momentum
        let t_new = (1.0 + (1.0 + 4.0 * t_fista * t_fista).sqrt()) / 2.0;
        let momentum = (t_fista - 1.0) / t_new;
        for k in 0..kernel_length {
            let extrapolated = h[k] as f64 + momentum * (h[k] as f64 - h_prev[k] as f64);
            h_prev[k] = extrapolated.max(0.0) as f32;
        }
        t_fista = t_new;
    }

    h
}

/// Adjoint of spike convolution: output[k] += sum_t input[t] * s[t-k].
/// This is S^T * input, the transpose of convolve_spikes_kernel.
fn adjoint_spikes_kernel(
    input: &[f32],
    spikes: &[f32],
    trace_lengths: &[usize],
    kernel_length: usize,
    output: &mut [f64],
) {
    output[..kernel_length].fill(0.0);
    let mut offset = 0;
    for &len in trace_lengths {
        for t in 0..len {
            let val = input[offset + t] as f64;
            let k_max = kernel_length.min(t + 1);
            for k in 0..k_max {
                output[k] += val * spikes[offset + t - k] as f64;
            }
        }
        offset += len;
    }
}

/// Convolve spike trains with kernel h: output[t] = sum_k h[k] * s[t-k].
fn convolve_spikes_kernel(spikes: &[f32], trace_lengths: &[usize], h: &[f32], output: &mut [f32]) {
    let k_len = h.len();
    let mut offset = 0;
    for &len in trace_lengths {
        for t in 0..len {
            let mut sum = 0.0_f32;
            let k_max = k_len.min(t + 1);
            for k in 0..k_max {
                sum += h[k] * spikes[offset + t - k];
            }
            output[offset + t] = sum;
        }
        offset += len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prox_tv_reduces_total_variation() {
        // Noisy step function: TV should decrease after prox
        let mut x: Vec<f64> = vec![
            0.0, 0.1, -0.1, 0.05, 0.0, // low plateau with noise
            1.0, 1.1, 0.9, 1.05, 1.0, // high plateau with noise
        ];
        let original_tv: f64 = x.windows(2).map(|w| (w[1] - w[0]).abs()).sum();

        prox_tv_1d(&mut x, 0.2);

        let smoothed_tv: f64 = x.windows(2).map(|w| (w[1] - w[0]).abs()).sum();

        assert!(
            smoothed_tv < original_tv,
            "TV prox should reduce TV: {:.4} -> {:.4}",
            original_tv,
            smoothed_tv
        );
    }

    #[test]
    fn prox_tv_identity_on_constant() {
        let mut x = vec![3.0_f64; 10];
        let original = x.clone();
        prox_tv_1d(&mut x, 0.5);
        for (i, (&a, &b)) in x.iter().zip(original.iter()).enumerate() {
            assert!(
                (a - b).abs() < 1e-10,
                "Constant signal should be unchanged at {}: got {}",
                i,
                a
            );
        }
    }

    /// Build an exponential kernel: h[t] = exp(-t * dt / tau_d) - exp(-t * dt / tau_r)
    fn make_exponential_kernel(tau_r: f64, tau_d: f64, fs: f64, length: usize) -> Vec<f32> {
        let dt = 1.0 / fs;
        let mut h = vec![0.0_f32; length];
        for t in 0..length {
            let time = t as f64 * dt;
            h[t] = ((-time / tau_d).exp() - (-time / tau_r).exp()) as f32;
        }
        // Normalize to unit peak
        let peak = h.iter().cloned().fold(0.0_f32, f32::max);
        if peak > 0.0 {
            for v in h.iter_mut() {
                *v /= peak;
            }
        }
        h
    }

    #[test]
    fn recovers_exponential_kernel() {
        let fs = 30.0;
        let tau_r = 0.02;
        let tau_d = 0.4;
        let k_len = 30; // ~1 second at 30 Hz
        let true_kernel = make_exponential_kernel(tau_r, tau_d, fs, k_len);

        // Generate synthetic data: 3 traces with known spikes
        let trace_len = 200;
        let spike_sets: Vec<Vec<usize>> = vec![vec![10, 60, 130], vec![20, 80, 160], vec![30, 100]];

        let mut all_traces = Vec::new();
        let mut all_spikes = Vec::new();
        let mut trace_lengths = Vec::new();
        let mut alphas = Vec::new();
        let mut baselines = Vec::new();

        for spikes in &spike_sets {
            let mut trace = vec![0.0_f32; trace_len];
            let mut s = vec![0.0_f32; trace_len];
            for &pos in spikes {
                s[pos] = 1.0;
                for (k, &hv) in true_kernel.iter().enumerate() {
                    if pos + k < trace_len {
                        trace[pos + k] += 3.0 * hv + 1.0; // alpha=3, baseline contribution
                    }
                }
            }
            // Add baseline
            for v in trace.iter_mut() {
                *v += 1.0;
            }
            all_traces.extend_from_slice(&trace);
            all_spikes.extend_from_slice(&s);
            trace_lengths.push(trace_len);
            alphas.push(3.0);
            baselines.push(1.0);
        }

        let est_kernel = estimate_free_kernel(
            &all_traces,
            &all_spikes,
            &alphas,
            &baselines,
            &trace_lengths,
            k_len,
            500,
            1e-5,
            None,
            0.0,
        );

        // Normalize both kernels to unit peak for comparison
        let est_peak = est_kernel.iter().cloned().fold(0.0_f32, f32::max);
        assert!(est_peak > 0.0, "Estimated kernel should have positive peak");

        let est_norm: Vec<f32> = est_kernel.iter().map(|&v| v / est_peak).collect();

        // Check correlation between true and estimated kernel
        let mut dot = 0.0_f64;
        let mut norm_true = 0.0_f64;
        let mut norm_est = 0.0_f64;
        for k in 0..k_len {
            let t = true_kernel[k] as f64;
            let e = est_norm[k] as f64;
            dot += t * e;
            norm_true += t * t;
            norm_est += e * e;
        }
        let corr = dot / (norm_true.sqrt() * norm_est.sqrt() + 1e-20);

        assert!(
            corr > 0.8,
            "Kernel correlation should be > 0.8, got {}",
            corr
        );
    }

    #[test]
    fn non_negativity_enforced() {
        let trace = vec![1.0_f32; 100];
        let spikes = vec![0.0_f32; 100];
        // With no spikes, the kernel should stay at zero (non-negative constraint)
        let kernel = estimate_free_kernel(
            &trace,
            &spikes,
            &[1.0],
            &[0.0],
            &[100],
            20,
            100,
            1e-4,
            None,
            0.0,
        );

        for (i, &v) in kernel.iter().enumerate() {
            assert!(
                v >= 0.0,
                "Kernel at {} should be non-negative, got {}",
                i,
                v
            );
        }
    }

    #[test]
    fn multi_trace_runs() {
        // Just verify it doesn't panic with multiple traces
        let traces = vec![1.0_f32; 300]; // 3 traces of 100
        let spikes = vec![0.0_f32; 300];
        let lengths = vec![100, 100, 100];
        let alphas = vec![1.0, 1.0, 1.0];
        let baselines = vec![0.0, 0.0, 0.0];

        let kernel = estimate_free_kernel(
            &traces, &spikes, &alphas, &baselines, &lengths, 20, 50, 1e-4, None, 0.0,
        );
        assert_eq!(kernel.len(), 20);
    }

    #[test]
    fn empty_input() {
        let kernel = estimate_free_kernel(&[], &[], &[], &[], &[], 10, 100, 1e-4, None, 0.0);
        assert_eq!(kernel.len(), 10);
        assert!(kernel.iter().all(|&v| v == 0.0));
    }

    /// Reproduce the conditions from the browser: high spike density, large spike values
    /// (from 10x downsample), negative baselines, ~1.0 alphas.
    #[test]
    fn dense_spikes_realistic_data() {
        let n_traces = 10;
        let trace_len = 2250; // 2250 samples at 30Hz ≈ 75 seconds
        let kernel_length = 36;

        let mut traces = Vec::new();
        let mut spikes = Vec::new();
        let mut trace_lengths = Vec::new();
        let mut alphas = Vec::new();
        let mut baselines = Vec::new();

        for i in 0..n_traces {
            let alpha = 0.95 + 0.05 * (i as f64 / n_traces as f64);
            let baseline = -30.0 - 5.0 * (i as f64);

            // Generate a trace with dense spikes (~30% density with values 1-10)
            let mut trace = vec![0.0_f32; trace_len];
            let mut spike = vec![0.0_f32; trace_len];

            // Simple deterministic pattern: spike every ~3 samples, value 1-10 cycling
            for t in 0..trace_len {
                if t % 3 == 0 {
                    spike[t] = ((t % 10) + 1) as f32;
                }
            }

            // Build trace = alpha * conv(spikes, true_kernel) + baseline
            // True kernel: exponential decay
            for t in 0..trace_len {
                trace[t] = baseline as f32;
                let k_max = kernel_length.min(t + 1);
                for k in 0..k_max {
                    let kernel_val = (-(k as f64) / 12.0).exp() as f32;
                    trace[t] += alpha as f32 * spike[t - k] * kernel_val;
                }
            }

            traces.extend_from_slice(&trace);
            spikes.extend_from_slice(&spike);
            trace_lengths.push(trace_len);
            alphas.push(alpha);
            baselines.push(baseline);
        }

        let kernel = estimate_free_kernel(
            &traces,
            &spikes,
            &alphas,
            &baselines,
            &trace_lengths,
            kernel_length,
            200,
            1e-4,
            None,
            0.0,
        );

        let peak = kernel.iter().cloned().fold(0.0_f32, f32::max);
        assert!(
            peak > 0.0,
            "Kernel should have positive values, got all zeros (peak={})",
            peak
        );
    }

    /// Verify that smooth_lambda > 0 produces a smoother kernel (lower total variation)
    /// than smooth_lambda = 0, when data is noisy and spikes are dense.
    #[test]
    fn smoothness_reduces_total_variation() {
        // Dense spikes with noisy traces — the regime where TV smoothness matters.
        let k_len = 30;
        let trace_len = 300;
        let n_traces = 5;

        let mut all_traces = Vec::new();
        let mut all_spikes = Vec::new();
        let mut trace_lengths = Vec::new();
        let mut alphas = Vec::new();
        let mut baselines = Vec::new();

        // True kernel: simple exponential decay
        let true_kernel: Vec<f32> = (0..k_len)
            .map(|k| (-(k as f64) / 10.0).exp() as f32)
            .collect();

        for i in 0..n_traces {
            let mut trace = vec![0.0_f32; trace_len];
            let mut s = vec![0.0_f32; trace_len];

            // Dense spikes: every 3-4 samples with varying amplitude
            for t in 0..trace_len {
                if (t + i * 7) % 3 == 0 {
                    s[t] = ((t % 5) + 1) as f32;
                }
            }

            // Build trace = conv(spikes, kernel) + noise
            for t in 0..trace_len {
                let k_max = k_len.min(t + 1);
                for k in 0..k_max {
                    trace[t] += s[t - k] * true_kernel[k];
                }
                // Add deterministic pseudo-noise to make the problem ill-conditioned
                trace[t] += 0.1 * ((t as f64 * 0.7 + i as f64 * 1.3).sin() as f32);
            }

            all_traces.extend_from_slice(&trace);
            all_spikes.extend_from_slice(&s);
            trace_lengths.push(trace_len);
            alphas.push(1.0);
            baselines.push(0.0);
        }

        let kernel_no_smooth = estimate_free_kernel(
            &all_traces,
            &all_spikes,
            &alphas,
            &baselines,
            &trace_lengths,
            k_len,
            500,
            1e-6,
            None,
            0.0,
        );

        let kernel_smooth = estimate_free_kernel(
            &all_traces,
            &all_spikes,
            &alphas,
            &baselines,
            &trace_lengths,
            k_len,
            500,
            1e-6,
            None,
            0.001,
        );

        // Total variation = sum of |h[k+1] - h[k]|
        let tv = |h: &[f32]| -> f64 {
            h.windows(2)
                .map(|w| (w[1] as f64 - w[0] as f64).abs())
                .sum()
        };

        let tv_no_smooth = tv(&kernel_no_smooth);
        let tv_smooth = tv(&kernel_smooth);

        assert!(
            tv_smooth < tv_no_smooth,
            "Smoothed kernel TV ({:.4}) should be less than unsmoothed ({:.4})",
            tv_smooth,
            tv_no_smooth
        );

        // The smoothed kernel should still have a positive peak
        let peak = kernel_smooth.iter().cloned().fold(0.0_f32, f32::max);
        assert!(peak > 0.0, "Smoothed kernel should have positive peak");
    }
}
