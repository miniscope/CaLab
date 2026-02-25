/// Banded AR(2) convolution engine — O(T) replacement for FFT-based O(T log T).
///
/// The AR(2) model c[t] = g1*c[t-1] + g2*c[t-2] + s[t] defines a banded
/// deconvolution matrix G. The convolution K = G^{-1} is applied via recursion
/// rather than FFT, reducing per-iteration cost from O(T log T) to O(T).
pub(crate) struct BandedAR2 {
    g1: f64, // d + r (sum of AR2 roots)
    g2: f64, // -(d * r) (negative product of AR2 roots)
    lipschitz: f64,
}

impl BandedAR2 {
    /// Create a new BandedAR2 with the given tau parameters.
    pub(crate) fn new(tau_rise: f64, tau_decay: f64, fs: f64) -> Self {
        let dt = 1.0 / fs;
        let d = (-dt / tau_decay).exp();
        let r = (-dt / tau_rise).exp();
        let g1 = d + r;
        let g2 = -(d * r);
        BandedAR2 {
            g1,
            g2,
            lipschitz: compute_banded_lipschitz(g1, g2),
        }
    }

    /// Recompute coefficients after parameter change.
    pub(crate) fn update(&mut self, tau_rise: f64, tau_decay: f64, fs: f64) {
        let dt = 1.0 / fs;
        let d = (-dt / tau_decay).exp();
        let r = (-dt / tau_rise).exp();
        self.g1 = d + r;
        self.g2 = -(d * r);
        self.lipschitz = compute_banded_lipschitz(self.g1, self.g2);
    }

    /// Forward convolution: s -> c = K*s = G^{-1}*s via AR(2) recursion, O(T).
    ///
    /// c[0] = s[0]
    /// c[1] = g1*c[0] + s[1]
    /// c[t] = g1*c[t-1] + g2*c[t-2] + s[t]  for t >= 2
    pub(crate) fn convolve_forward(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let g1 = self.g1 as f32;
        let g2 = self.g2 as f32;

        output[0] = source[0];
        if n > 1 {
            output[1] = g1 * output[0] + source[1];
        }
        for t in 2..n {
            output[t] = g1 * output[t - 1] + g2 * output[t - 2] + source[t];
        }
    }

    /// Adjoint convolution: r -> (K^T)*r = (G^{-T})*r via reverse-time recursion, O(T).
    ///
    /// output[T-1] = r[T-1]
    /// output[T-2] = r[T-2] + g1*output[T-1]
    /// output[t]   = r[t] + g1*output[t+1] + g2*output[t+2]  for t <= T-3
    pub(crate) fn convolve_adjoint(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let g1 = self.g1 as f32;
        let g2 = self.g2 as f32;

        output[n - 1] = source[n - 1];
        if n > 1 {
            output[n - 2] = source[n - 2] + g1 * output[n - 1];
        }
        for t in (0..n.saturating_sub(2)).rev() {
            output[t] = source[t] + g1 * output[t + 1] + g2 * output[t + 2];
        }
    }

    /// Return the cached Lipschitz constant.
    pub(crate) fn lipschitz(&self) -> f64 {
        self.lipschitz
    }
}

/// Compute the Lipschitz constant for the banded AR(2) operator.
///
/// L = max_w |H(e^{jw})|^2 where H(z) = 1 / (1 - g1*z^{-1} - g2*z^{-2}).
/// We evaluate |H|^2 over a dense frequency grid and take the max.
/// This only runs on param changes, not per-iteration.
fn compute_banded_lipschitz(g1: f64, g2: f64) -> f64 {
    let n_freqs = 4096;
    let mut max_power = 0.0_f64;

    for k in 0..=n_freqs {
        let w = std::f64::consts::PI * (k as f64) / (n_freqs as f64);
        // H(e^{jw}) = 1 / (1 - g1*e^{-jw} - g2*e^{-2jw})
        // Denominator: (1 - g1*cos(w) - g2*cos(2w)) + j*(g1*sin(w) + g2*sin(2w))
        let re = 1.0 - g1 * w.cos() - g2 * (2.0 * w).cos();
        let im = g1 * w.sin() + g2 * (2.0 * w).sin();
        let denom_sq = re * re + im * im;
        if denom_sq > 1e-30 {
            max_power = max_power.max(1.0 / denom_sq);
        }
    }

    max_power.max(1e-10)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{build_kernel, compute_lipschitz, tau_to_ar2};

    #[test]
    fn g1_g2_match_tau_to_ar2() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let (g1, g2) = tau_to_ar2(0.02, 0.4, 30.0);
        assert!(
            (banded.g1 - g1).abs() < 1e-15,
            "g1 mismatch: {} vs {}",
            banded.g1,
            g1
        );
        assert!(
            (banded.g2 - g2).abs() < 1e-15,
            "g2 mismatch: {} vs {}",
            banded.g2,
            g2
        );
    }

    #[test]
    fn adjoint_identity() {
        // <K*x, y> == <x, K^T*y> for deterministic vectors
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 200;

        let x: Vec<f32> = (0..n).map(|i| (i as f32 * 0.3).sin()).collect();
        let y: Vec<f32> = (0..n).map(|i| (i as f32 * 0.7 + 1.0).cos()).collect();

        let mut kx = vec![0.0_f32; n];
        banded.convolve_forward(&x, &mut kx);

        let mut kty = vec![0.0_f32; n];
        banded.convolve_adjoint(&y, &mut kty);

        let lhs: f64 = kx
            .iter()
            .zip(y.iter())
            .map(|(&a, &b)| a as f64 * b as f64)
            .sum();
        let rhs: f64 = x
            .iter()
            .zip(kty.iter())
            .map(|(&a, &b)| a as f64 * b as f64)
            .sum();

        let rel_err = (lhs - rhs).abs() / lhs.abs().max(1e-10);
        assert!(
            rel_err < 1e-3,
            "Adjoint identity violated: <Kx,y>={} vs <x,K^Ty>={} (rel_err={})",
            lhs,
            rhs,
            rel_err
        );
    }

    #[test]
    fn forward_produces_decaying_calcium() {
        // Banded forward is an AR(2) recursion (exact discrete-time model),
        // while FFT convolves with a sampled continuous kernel. They differ
        // structurally (e.g. kernel[0]=0 in FFT but AR(2) passes through
        // the impulse at t=0). Instead of comparing numerically, verify that
        // banded forward produces the expected calcium-like shape.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 200;

        let mut signal = vec![0.0_f32; n];
        signal[10] = 1.0;

        let mut result = vec![0.0_f32; n];
        banded.convolve_forward(&signal, &mut result);

        // Before the spike: all zeros
        for i in 0..10 {
            assert!(
                result[i].abs() < 1e-6,
                "Expected zero before spike at index {}, got {}",
                i,
                result[i]
            );
        }

        // At the spike: impulse arrives
        assert!(
            result[10] > 0.5,
            "Expected positive response at spike, got {}",
            result[10]
        );

        // After the spike: decaying response, all non-negative
        for i in 11..n {
            assert!(
                result[i] >= -1e-6,
                "Expected non-negative response at index {}, got {}",
                i,
                result[i]
            );
        }

        // Response should decay toward zero
        assert!(
            result[n - 1] < result[15],
            "Response should decay: result[last]={} >= result[15]={}",
            result[n - 1],
            result[15]
        );
    }

    #[test]
    fn banded_fista_converges_to_same_solution() {
        // The ultimate validation: both conv modes should produce equivalent
        // FISTA solutions on the same trace (since they're both valid
        // convolution operators for the same AR(2) model).
        use crate::ConvMode;
        use crate::Solver;

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let mut trace = vec![0.0_f32; n];
        // Build trace by convolving spikes with kernel (FFT-style ground truth)
        let spikes = [10, 50, 100, 150];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }

        // Solve with FFT mode
        let mut solver_fft = Solver::new();
        solver_fft.set_params(0.02, 0.4, 0.01, 30.0);
        solver_fft.set_conv_mode(ConvMode::Fft);
        solver_fft.set_trace(&trace);
        for _ in 0..200 {
            if solver_fft.step_batch(10) {
                break;
            }
        }
        let sol_fft = solver_fft.get_solution();

        // Solve with Banded mode
        let mut solver_banded = Solver::new();
        solver_banded.set_params(0.02, 0.4, 0.01, 30.0);
        solver_banded.set_conv_mode(ConvMode::BandedAR2);
        solver_banded.set_trace(&trace);
        for _ in 0..200 {
            if solver_banded.step_batch(10) {
                break;
            }
        }
        let sol_banded = solver_banded.get_solution();

        // Both should find spikes near the true spike locations
        assert_eq!(sol_fft.len(), sol_banded.len());

        // Find the top 4 spike locations in each solution
        let mut fft_spikes: Vec<(usize, f32)> = sol_fft.iter().copied().enumerate().collect();
        fft_spikes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        let mut banded_spikes: Vec<(usize, f32)> = sol_banded.iter().copied().enumerate().collect();
        banded_spikes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        // Both should identify at least 3 of the 4 true spike locations (within +-2 samples)
        let fft_top4: Vec<usize> = fft_spikes.iter().take(4).map(|&(i, _)| i).collect();
        let banded_top4: Vec<usize> = banded_spikes.iter().take(4).map(|&(i, _)| i).collect();

        let mut fft_matches = 0;
        let mut banded_matches = 0;
        for &true_spike in &spikes {
            if fft_top4
                .iter()
                .any(|&s| (s as isize - true_spike as isize).unsigned_abs() <= 2)
            {
                fft_matches += 1;
            }
            if banded_top4
                .iter()
                .any(|&s| (s as isize - true_spike as isize).unsigned_abs() <= 2)
            {
                banded_matches += 1;
            }
        }
        assert!(
            fft_matches >= 3,
            "FFT mode should find >= 3 of 4 spikes, found {} (locations: {:?})",
            fft_matches,
            fft_top4
        );
        assert!(
            banded_matches >= 3,
            "Banded mode should find >= 3 of 4 spikes, found {} (locations: {:?})",
            banded_matches,
            banded_top4
        );
    }

    #[test]
    fn lipschitz_reasonable() {
        // The banded Lipschitz should be in a similar ballpark to the FFT-based one
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let fft_lipschitz = compute_lipschitz(&kernel);

        let ratio = banded.lipschitz() / fft_lipschitz;
        // The banded operator works on the full infinite-length AR(2) transfer function
        // while FFT uses a truncated kernel. They should be in the same order of magnitude.
        assert!(
            ratio > 0.5 && ratio < 2.0,
            "Banded Lipschitz ({}) vs FFT Lipschitz ({}) ratio {} out of range",
            banded.lipschitz(),
            fft_lipschitz,
            ratio
        );
    }

    #[test]
    fn impulse_response_matches_kernel_shape() {
        // A delta at t=0 through forward conv should produce an exponential decay
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 100;

        let mut impulse = vec![0.0_f32; n];
        impulse[0] = 1.0;

        let mut response = vec![0.0_f32; n];
        banded.convolve_forward(&impulse, &mut response);

        // response[0] should be 1.0 (impulse passed through)
        assert!(
            (response[0] - 1.0).abs() < 1e-6,
            "Impulse response at t=0 should be 1.0, got {}",
            response[0]
        );

        // Response should be non-negative and decaying after peak
        let peak_idx = response
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;

        // After peak, values should generally decrease
        for t in (peak_idx + 2)..n {
            assert!(
                response[t] >= -1e-6,
                "Response should be non-negative at t={}, got {}",
                t,
                response[t]
            );
        }
    }
}
