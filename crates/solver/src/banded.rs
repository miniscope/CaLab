/// Banded AR(2) convolution engine — O(T) replacement for FFT-based O(T log T).
///
/// The AR(2) model c[t] = g1*c[t-1] + g2*c[t-2] + s[t] defines a banded
/// deconvolution matrix G. The convolution K = G^{-1} is applied via recursion
/// rather than FFT, reducing per-iteration cost from O(T log T) to O(T).
///
/// The raw AR2 impulse peak is sampling-rate-dependent (larger at higher fs
/// because the recursion accumulates over more timesteps during the rise phase).
/// To make alpha rate-independent, the forward and adjoint convolutions are
/// normalized by the impulse peak so that a single spike always produces a
/// peak of 1.0 in the output regardless of sampling rate.
pub(crate) struct BandedAR2 {
    g1: f64,          // d + r (sum of AR2 roots)
    g2: f64,          // -(d * r) (negative product of AR2 roots)
    impulse_peak: f64, // peak of raw AR2 impulse response (for normalization)
    lipschitz: f64,    // Lipschitz constant of the normalized operator
}

impl BandedAR2 {
    /// Create a new BandedAR2 with the given tau parameters.
    pub(crate) fn new(tau_rise: f64, tau_decay: f64, fs: f64) -> Self {
        let dt = 1.0 / fs;
        let d = (-dt / tau_decay).exp();
        let r = (-dt / tau_rise).exp();
        let g1 = d + r;
        let g2 = -(d * r);
        let impulse_peak = compute_impulse_peak(g1, g2, tau_decay, fs);
        // Lipschitz of normalized operator: L_raw / peak^2
        let lipschitz = compute_banded_lipschitz(g1, g2) / (impulse_peak * impulse_peak);
        BandedAR2 {
            g1,
            g2,
            impulse_peak,
            lipschitz,
        }
    }

    /// Recompute coefficients after parameter change.
    pub(crate) fn update(&mut self, tau_rise: f64, tau_decay: f64, fs: f64) {
        let dt = 1.0 / fs;
        let d = (-dt / tau_decay).exp();
        let r = (-dt / tau_rise).exp();
        self.g1 = d + r;
        self.g2 = -(d * r);
        self.impulse_peak = compute_impulse_peak(self.g1, self.g2, tau_decay, fs);
        self.lipschitz = compute_banded_lipschitz(self.g1, self.g2)
            / (self.impulse_peak * self.impulse_peak);
    }

    /// Forward convolution: s -> normalized AR2 output, O(T).
    ///
    /// Runs the raw AR2 recursion then divides by the impulse peak so that
    /// a single spike produces a peak of 1.0 at all sampling rates.
    pub(crate) fn convolve_forward(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let g1 = self.g1 as f32;
        let g2 = self.g2 as f32;
        let inv_peak = (1.0 / self.impulse_peak) as f32;

        output[0] = source[0];
        if n > 1 {
            output[1] = g1 * output[0] + source[1];
        }
        for t in 2..n {
            output[t] = g1 * output[t - 1] + g2 * output[t - 2] + source[t];
        }

        // Normalize by impulse peak
        for t in 0..n {
            output[t] *= inv_peak;
        }
    }

    /// Adjoint convolution: normalized adjoint, O(T).
    ///
    /// Adjoint of (K / peak) = K^T / peak.
    pub(crate) fn convolve_adjoint(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let g1 = self.g1 as f32;
        let g2 = self.g2 as f32;
        let inv_peak = (1.0 / self.impulse_peak) as f32;

        output[n - 1] = source[n - 1];
        if n > 1 {
            output[n - 2] = source[n - 2] + g1 * output[n - 1];
        }
        for t in (0..n.saturating_sub(2)).rev() {
            output[t] = source[t] + g1 * output[t + 1] + g2 * output[t + 2];
        }

        // Normalize by impulse peak
        for t in 0..n {
            output[t] *= inv_peak;
        }
    }

    /// Return the cached Lipschitz constant (of the normalized operator).
    pub(crate) fn lipschitz(&self) -> f64 {
        self.lipschitz
    }

    /// Return the raw AR2 impulse response peak (for diagnostics).
    #[allow(dead_code)]
    pub(crate) fn impulse_peak(&self) -> f64 {
        self.impulse_peak
    }
}

/// Compute the peak of the raw AR2 impulse response.
///
/// Runs the AR2 recursion c[t] = g1*c[t-1] + g2*c[t-2] + delta[t] until
/// the response decays past its maximum. This peak is used to normalize
/// the forward/adjoint convolutions so alpha is sampling-rate-independent.
fn compute_impulse_peak(g1: f64, g2: f64, tau_decay: f64, fs: f64) -> f64 {
    let max_steps = (5.0 * tau_decay * fs).ceil() as usize + 10;
    let mut c_prev2 = 0.0_f64;
    let mut c_prev1 = 1.0_f64; // c[0] = 1 (impulse)
    let mut peak = 1.0_f64;

    for _ in 1..max_steps {
        let c = g1 * c_prev1 + g2 * c_prev2;
        if c > peak {
            peak = c;
        }
        if c < peak * 0.95 {
            break; // past the peak, decaying
        }
        c_prev2 = c_prev1;
        c_prev1 = c;
    }

    peak.max(1.0) // at minimum 1.0 (the impulse at t=0)
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
        // Use double-angle identities: cos(2w) = 2cos^2(w)-1, sin(2w) = 2sin(w)cos(w)
        let cw = w.cos();
        let sw = w.sin();
        let c2w = 2.0 * cw * cw - 1.0;
        let s2w = 2.0 * sw * cw;
        let re = 1.0 - g1 * cw - g2 * c2w;
        let im = g1 * sw + g2 * s2w;
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
    use crate::kernel::{build_kernel, tau_to_ar2};

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
        // Banded forward (now peak-normalized) should produce a calcium-like shape
        // with peak = 1.0 regardless of sampling rate.
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

        // At the spike: positive response
        assert!(
            result[10] > 0.01,
            "Expected positive response at spike, got {}",
            result[10]
        );

        // After the spike: non-negative response
        for i in 11..n {
            assert!(
                result[i] >= -1e-6,
                "Expected non-negative response at index {}, got {}",
                i,
                result[i]
            );
        }

        // Peak should be ~1.0 (normalized)
        let peak: f32 = result.iter().copied().fold(0.0_f32, f32::max);
        assert!(
            (peak - 1.0).abs() < 0.05,
            "Peak should be ~1.0, got {}",
            peak
        );

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
    fn lipschitz_positive() {
        // The normalized Lipschitz constant should be positive and finite
        for &fs in &[30.0, 100.0, 300.0] {
            let banded = BandedAR2::new(0.02, 0.4, fs);
            assert!(
                banded.lipschitz() > 0.0 && banded.lipschitz().is_finite(),
                "fs={}: Lipschitz should be positive and finite, got {}",
                fs,
                banded.lipschitz()
            );
        }
    }

    #[test]
    fn impulse_response_peak_is_one() {
        // After normalization, the impulse peak should be ~1.0 at any sampling rate
        for &fs in &[30.0, 100.0, 300.0, 1000.0] {
            let banded = BandedAR2::new(0.02, 0.4, fs);
            let n = (5.0 * 0.4 * fs).ceil() as usize + 10;

            let mut impulse = vec![0.0_f32; n];
            impulse[0] = 1.0;

            let mut response = vec![0.0_f32; n];
            banded.convolve_forward(&impulse, &mut response);

            let peak: f32 = response.iter().copied().fold(0.0_f32, f32::max);
            assert!(
                (peak - 1.0).abs() < 0.02,
                "fs={}: impulse peak should be ~1.0, got {}",
                fs,
                peak
            );

            // Response should be non-negative
            for (t, &v) in response.iter().enumerate() {
                assert!(
                    v >= -1e-5,
                    "fs={}: response should be non-negative at t={}, got {}",
                    fs,
                    t,
                    v
                );
            }
        }
    }
}
