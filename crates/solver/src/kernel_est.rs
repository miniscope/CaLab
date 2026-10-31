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
    let total_len: usize = trace_lengths.iter().sum();

    // Length invariants. These are guaranteed by the FFI wrappers, which
    // validate and return a typed error (see js_indeca / py_api). The
    // debug_assert keeps the contract loud for internal callers and tests;
    // the release-mode guard degrades to an empty kernel rather than panicking
    // across the WASM/PyO3 boundary (a panic there aborts the module).
    debug_assert_eq!(alphas.len(), n_traces);
    debug_assert_eq!(baselines.len(), n_traces);
    debug_assert_eq!(traces.len(), total_len);
    debug_assert_eq!(spike_trains.len(), total_len);

    if alphas.len() != n_traces
        || baselines.len() != n_traces
        || traces.len() != total_len
        || spike_trains.len() != total_len
        || kernel_length == 0
        || total_len == 0
    {
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

    // The objective is quadratic in h, so the gradient S^T(S h - y) equals
    // G h - b with G = S^T S (k x k) and b = S^T y. Both are computed once
    // (cost O(nnz(s) * k)); every FISTA iteration is then O(k^2), independent
    // of the data size.
    let (gram, rhs) = build_gram(spike_trains, &y_adj, trace_lengths, kernel_length);
    let lipschitz = gram_lipschitz(&gram, kernel_length);
    fista_kernel(
        kernel_length,
        max_iters,
        tol,
        warm_start,
        smooth_lambda,
        lipschitz,
        |h, grad| {
            for (i, g) in grad.iter_mut().enumerate() {
                let row = &gram[i * kernel_length..(i + 1) * kernel_length];
                let mut acc = 0.0_f64;
                for (&gij, &hj) in row.iter().zip(h.iter()) {
                    acc += gij * hj as f64;
                }
                *g = acc - rhs[i];
            }
        },
    )
}

/// Build y_adj = (y - baseline) / alpha per trace (zero for alpha ~ 0).
/// Exposed to the reference path in tests.
#[cfg(test)]
fn adjust_targets(
    traces: &[f32],
    alphas: &[f64],
    baselines: &[f64],
    trace_lengths: &[usize],
) -> Vec<f32> {
    let mut y_adj = vec![0.0_f32; traces.len()];
    let mut offset = 0;
    for (i, &len) in trace_lengths.iter().enumerate() {
        if alphas[i].abs() >= 1e-20 {
            for j in 0..len {
                y_adj[offset + j] = ((traces[offset + j] as f64 - baselines[i]) / alphas[i]) as f32;
            }
        }
        offset += len;
    }
    y_adj
}

/// Compute G = S^T S (row-major k x k, symmetric) and b = S^T y with f64
/// accumulation, respecting trace boundaries exactly as
/// `convolve_spikes_kernel` / `adjoint_spikes_kernel` do (column k of S at row
/// t is s[t-k] for k <= t, zero otherwise; no wrap across traces).
///
/// For one trace of length n: G[k1][k2] = sum_{u=0}^{n-k1-1} s[u] s[u+d],
/// d = k1-k2 >= 0. Along each diagonal d it satisfies
/// G[d+j][j] = G[d+j-1][j-1] - s[n-d-j] s[n-j], seeded by the autocorrelation
/// A[d] = G[d][0]. The autocorrelation and b only visit nonzero spikes.
fn build_gram(
    spikes: &[f32],
    y: &[f32],
    trace_lengths: &[usize],
    kernel_length: usize,
) -> (Vec<f64>, Vec<f64>) {
    let k = kernel_length;
    let mut gram = vec![0.0_f64; k * k];
    let mut b = vec![0.0_f64; k];
    let mut acorr = vec![0.0_f64; k];
    let mut offset = 0;
    for &n in trace_lengths {
        let s = &spikes[offset..offset + n];
        let yt = &y[offset..offset + n];
        offset += n;
        acorr.fill(0.0);
        for u in 0..n {
            let su = s[u] as f64;
            if su == 0.0 {
                continue;
            }
            let lag_max = k.min(n - u);
            for d in 0..lag_max {
                acorr[d] += su * s[u + d] as f64;
            }
            // b[kk] += s[u] * y[u + kk]
            for kk in 0..lag_max {
                b[kk] += su * yt[u + kk] as f64;
            }
        }
        // Rows k1 >= n have empty sums (S column entirely zero) -> stay 0.
        for d in 0..k.min(n) {
            let mut g = acorr[d];
            gram[d * k] += g;
            if d > 0 {
                gram[d] += g; // symmetric entry (0, d)
            }
            let j_max = (k - d).min(n - d);
            for j in 1..j_max {
                g -= s[n - d - j] as f64 * s[n - j] as f64;
                gram[(d + j) * k + j] += g;
                if d > 0 {
                    gram[j * k + d + j] += g;
                }
            }
        }
    }
    (gram, b)
}

/// Largest eigenvalue of G by 20-step power iteration (same scheme and
/// floor as the original S-based estimate).
fn gram_lipschitz(gram: &[f64], k: usize) -> f64 {
    let mut v = vec![1.0_f64 / (k as f64).sqrt(); k];
    let mut gv = vec![0.0_f64; k];
    let mut eigenvalue = 1.0_f64;
    for _ in 0..20 {
        for i in 0..k {
            let row = &gram[i * k..(i + 1) * k];
            gv[i] = row.iter().zip(v.iter()).map(|(&a, &b)| a * b).sum();
        }
        eigenvalue = gv.iter().map(|&x| x * x).sum::<f64>().sqrt();
        if eigenvalue < 1e-20 {
            eigenvalue = 1.0;
            break;
        }
        for (vi, &g) in v.iter_mut().zip(gv.iter()) {
            *vi = g / eigenvalue;
        }
    }
    eigenvalue.max(1.0)
}

/// Shared FISTA loop (TV prox + non-negativity, momentum, convergence rule).
/// `grad_fn(h_prev, out)` writes the data-fit gradient at `h_prev`.
fn fista_kernel<F: FnMut(&[f32], &mut [f64])>(
    kernel_length: usize,
    max_iters: u32,
    tol: f64,
    warm_start: Option<&[f32]>,
    smooth_lambda: f64,
    lipschitz: f64,
    mut grad_fn: F,
) -> Vec<f32> {
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
    let mut z = vec![0.0_f64; kernel_length];

    for iter in 0..max_iters {
        grad_fn(&h_prev, &mut gradient);

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

/// Original data-space implementation (O(total_len * k) per iteration), kept
/// as the reference for equivalence tests and benchmarks.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn estimate_free_kernel_reference(
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
    let total_len: usize = trace_lengths.iter().sum();
    if kernel_length == 0 || total_len == 0 {
        return vec![0.0; kernel_length];
    }
    let y_adj = adjust_targets(traces, alphas, baselines, trace_lengths);

    let lipschitz = {
        let mut v = vec![1.0_f64; kernel_length];
        let norm: f64 = (kernel_length as f64).sqrt();
        for val in v.iter_mut() {
            *val /= norm;
        }
        let mut sv = vec![0.0_f32; total_len];
        let mut stv = vec![0.0_f64; kernel_length];
        let mut eigenvalue = 1.0_f64;
        let mut v_f32 = vec![0.0_f32; kernel_length];
        for _ in 0..20 {
            for (dst, &src) in v_f32.iter_mut().zip(v.iter()) {
                *dst = src as f32;
            }
            convolve_spikes_kernel(spike_trains, trace_lengths, &v_f32, &mut sv);
            adjoint_spikes_kernel(&sv, spike_trains, trace_lengths, kernel_length, &mut stv);
            eigenvalue = stv.iter().map(|&x| x * x).sum::<f64>().sqrt();
            if eigenvalue < 1e-20 {
                eigenvalue = 1.0;
                break;
            }
            for (vi, &si) in v.iter_mut().zip(stv.iter()) {
                *vi = si / eigenvalue;
            }
        }
        eigenvalue.max(1.0)
    };

    let mut sh = vec![0.0_f32; total_len];
    fista_kernel(
        kernel_length,
        max_iters,
        tol,
        warm_start,
        smooth_lambda,
        lipschitz,
        |h, grad| {
            convolve_spikes_kernel(spike_trains, trace_lengths, h, &mut sh);
            for i in 0..total_len {
                sh[i] -= y_adj[i];
            }
            adjoint_spikes_kernel(&sh, spike_trains, trace_lengths, kernel_length, grad);
        },
    )
}

#[cfg(test)]
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

#[cfg(test)]
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

    // ── Gram-path equivalence and performance ────────────────────────

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
    }

    fn rel_l2(a: &[f32], b: &[f32]) -> f64 {
        let num: f64 = a
            .iter()
            .zip(b)
            .map(|(&x, &y)| (x as f64 - y as f64).powi(2))
            .sum();
        let den: f64 = b.iter().map(|&y| (y as f64).powi(2)).sum();
        (num / (den + 1e-30)).sqrt()
    }

    /// Random sparse (non-binary count) spikes, noisy traces from a bi-exp kernel.
    fn random_problem(
        seed: u64,
        lengths: &[usize],
        density: f64,
        k: usize,
    ) -> (Vec<f32>, Vec<f32>, Vec<f64>, Vec<f64>) {
        let mut rng = Lcg(seed);
        let kern = make_exponential_kernel(0.02, 0.4, 30.0, k);
        let mut traces = Vec::new();
        let mut spikes = Vec::new();
        let mut alphas = Vec::new();
        let mut baselines = Vec::new();
        for (ci, &n) in lengths.iter().enumerate() {
            let mut s = vec![0.0_f32; n];
            for v in s.iter_mut() {
                if rng.next() < density {
                    *v = (1.0 + (rng.next() * 3.0).floor()) as f32;
                }
            }
            let alpha = 1.0 + 0.1 * ci as f64;
            let base = 0.5 * ci as f64;
            let mut tr = vec![0.0_f32; n];
            for t in 0..n {
                let mut acc = 0.0_f64;
                for kk in 0..k.min(t + 1) {
                    acc += s[t - kk] as f64 * kern[kk] as f64;
                }
                tr[t] = (alpha * acc + base + 0.05 * (rng.next() - 0.5)) as f32;
            }
            traces.extend(tr);
            spikes.extend(s);
            alphas.push(alpha);
            baselines.push(base);
        }
        (traces, spikes, alphas, baselines)
    }

    #[test]
    fn gram_matches_reference_random() {
        let mut worst = 0.0_f64;
        // includes traces shorter than the kernel and a length-1 trace
        for (seed, lengths, density, k) in [
            (1u64, vec![300usize, 250, 400], 0.05, 30usize),
            (2, vec![500, 40, 1, 20, 700], 0.2, 50),
            (3, vec![1000, 1000], 0.01, 80),
            (4, vec![200; 8], 0.5, 25),
        ] {
            let (tr, sp, al, ba) = random_problem(seed, &lengths, density, k);
            for lambda in [0.0, 0.001] {
                let new =
                    estimate_free_kernel(&tr, &sp, &al, &ba, &lengths, k, 200, 1e-6, None, lambda);
                let old = estimate_free_kernel_reference(
                    &tr, &sp, &al, &ba, &lengths, k, 200, 1e-6, None, lambda,
                );
                let e = rel_l2(&new, &old);
                worst = worst.max(e);
                assert!(e < 1e-5, "seed {seed} lambda {lambda}: rel L2 {e}");
            }
        }
        eprintln!("gram vs reference (random) worst rel L2 = {worst:.3e}");
    }

    #[test]
    fn gram_matrix_matches_dense_s() {
        // Direct check of G and b against explicit S^T S, S^T y.
        let lengths = [30usize, 7, 1, 50];
        let k = 12;
        let (tr, sp, _, _) = random_problem(9, &lengths, 0.3, 10);
        let (g, b) = build_gram(&sp, &tr, &lengths, k);
        let mut off = 0;
        let mut gref = vec![0.0_f64; k * k];
        let mut bref = vec![0.0_f64; k];
        for &n in &lengths {
            for t in 0..n {
                for k1 in 0..k.min(t + 1) {
                    bref[k1] += sp[off + t - k1] as f64 * tr[off + t] as f64;
                    for k2 in 0..k.min(t + 1) {
                        gref[k1 * k + k2] += sp[off + t - k1] as f64 * sp[off + t - k2] as f64;
                    }
                }
            }
            off += n;
        }
        for i in 0..k * k {
            assert!(
                (g[i] - gref[i]).abs() < 1e-9,
                "G[{i}] {} vs {}",
                g[i],
                gref[i]
            );
        }
        for i in 0..k {
            assert!((b[i] - bref[i]).abs() < 1e-9, "b[{i}]");
        }
    }

    #[test]
    fn gram_matches_reference_presets() {
        let mut worst = 0.0_f64;
        for (name, mut cfg) in crate::simulate::presets::all() {
            cfg.num_cells = 6;
            cfg.num_timepoints = 3000;
            let sim = crate::simulate::simulate(&cfg);
            let n = sim.num_timepoints;
            let lengths = vec![n; sim.num_cells];
            let mut spikes = Vec::new();
            let mut alphas = Vec::new();
            for gt in &sim.ground_truth {
                spikes.extend_from_slice(&gt.spikes);
                alphas.push(gt.alpha.max(1e-3));
            }
            let baselines = vec![0.0; sim.num_cells];
            let k = 60;
            for lambda in [0.0, 0.002] {
                let new = estimate_free_kernel(
                    &sim.traces,
                    &spikes,
                    &alphas,
                    &baselines,
                    &lengths,
                    k,
                    200,
                    1e-6,
                    None,
                    lambda,
                );
                let old = estimate_free_kernel_reference(
                    &sim.traces,
                    &spikes,
                    &alphas,
                    &baselines,
                    &lengths,
                    k,
                    200,
                    1e-6,
                    None,
                    lambda,
                );
                let e = rel_l2(&new, &old);
                worst = worst.max(e);
                assert!(e < 1e-5, "preset {name} lambda {lambda}: rel L2 {e}");
            }
        }
        eprintln!("gram vs reference (presets) worst rel L2 = {worst:.3e}");
    }

    #[test]
    fn large_total_len_is_fast() {
        let lengths = vec![50_000usize; 50];
        let k = 150;
        let mut rng = Lcg(77);
        let total: usize = lengths.iter().sum();
        let mut sp = vec![0.0_f32; total];
        for v in sp.iter_mut() {
            if rng.next() < 0.01 {
                *v = 1.0;
            }
        }
        let kern = make_exponential_kernel(0.02, 0.4, 30.0, k);
        let mut tr = vec![0.0_f32; total];
        for t in 0..total {
            if sp[t] != 0.0 {
                for (kk, &hv) in kern.iter().enumerate() {
                    if t + kk < total {
                        tr[t + kk] += hv;
                    }
                }
            }
        }
        let al = vec![1.0; 50];
        let ba = vec![0.0; 50];
        let t0 = std::time::Instant::now();
        let h = estimate_free_kernel(&tr, &sp, &al, &ba, &lengths, k, 200, 1e-6, None, 0.0);
        let dt = t0.elapsed().as_secs_f64();
        eprintln!("large_total_len: {dt:.3}s");
        assert!(h.iter().any(|&v| v > 0.0));
        assert!(dt < 60.0, "took {dt}s");
    }

    /// Benchmark (run with --release --ignored --nocapture).
    #[test]
    #[ignore]
    fn bench_gram_vs_reference() {
        for &total in &[1_000_000usize, 10_000_000] {
            for &k in &[50usize, 150, 450] {
                let n_tr = total / 20_000;
                let lengths = vec![20_000usize; n_tr];
                let mut rng = Lcg(5);
                let mut sp = vec![0.0_f32; total];
                for v in sp.iter_mut() {
                    if rng.next() < 0.01 {
                        *v = 1.0;
                    }
                }
                let tr: Vec<f32> = (0..total).map(|_| rng.next() as f32).collect();
                let al = vec![1.0; n_tr];
                let ba = vec![0.0; n_tr];
                let t = std::time::Instant::now();
                let (g, _) = build_gram(&sp, &tr, &lengths, k);
                let t_gram = t.elapsed().as_secs_f64();
                std::hint::black_box(g);
                let t = std::time::Instant::now();
                let h1 =
                    estimate_free_kernel(&tr, &sp, &al, &ba, &lengths, k, 200, 1e-9, None, 0.0);
                let t_new = t.elapsed().as_secs_f64();
                let t = std::time::Instant::now();
                let h0 = estimate_free_kernel_reference(
                    &tr, &sp, &al, &ba, &lengths, k, 200, 1e-9, None, 0.0,
                );
                let t_old = t.elapsed().as_secs_f64();
                eprintln!(
                    "BENCH total={total} k={k}: old={t_old:.3}s new={t_new:.3}s (gram {t_gram:.3}s) relL2={:.2e}",
                    rel_l2(&h1, &h0)
                );
            }
        }
    }
}
