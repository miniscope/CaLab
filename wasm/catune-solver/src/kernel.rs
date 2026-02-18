/// Build a double-exponential calcium kernel normalized to peak = 1.0.
///
/// h(t) = exp(-t/tau_decay) - exp(-t/tau_rise), normalized so max(h) = 1.0.
/// Kernel length extends until the decay envelope drops below 1e-6 of peak.
/// Computed in f64 for precision, returned as Vec<f32>.
pub fn build_kernel(tau_rise: f64, tau_decay: f64, fs: f64) -> Vec<f32> {
    let dt = 1.0 / fs;

    // Kernel length: until decay drops below 1e-6 of peak
    // -ln(1e-6) = 6*ln(10) ~ 13.8155
    let kernel_len = ((-1e-6_f64.ln()) * tau_decay / dt).ceil() as usize;
    let kernel_len = kernel_len.max(2); // at least 2 samples

    let mut kernel_f64 = Vec::with_capacity(kernel_len);
    let mut peak = 0.0_f64;

    for i in 0..kernel_len {
        let t = (i as f64) * dt;
        let val = (-t / tau_decay).exp() - (-t / tau_rise).exp();
        kernel_f64.push(val);
        if val > peak {
            peak = val;
        }
    }

    // Normalize to peak = 1.0
    if peak > 0.0 {
        for v in kernel_f64.iter_mut() {
            *v /= peak;
        }
    }

    kernel_f64.iter().map(|&v| v as f32).collect()
}

/// Derive AR(2) coefficients (g1, g2) from tau parameters.
///
/// The AR(2) process c[t] = g1*c[t-1] + g2*c[t-2] + s[t] has characteristic
/// roots d = exp(-dt/tau_decay) and r = exp(-dt/tau_rise).
/// g1 = d + r (sum of roots), g2 = -(d * r) (negative product of roots).
///
/// Only used in tests; the WASM API relies on the TypeScript port in src/lib/ar2.ts.
#[cfg(test)]
pub fn tau_to_ar2(tau_rise: f64, tau_decay: f64, fs: f64) -> (f64, f64) {
    let dt = 1.0 / fs;
    let d = (-dt / tau_decay).exp(); // decay eigenvalue
    let r = (-dt / tau_rise).exp(); // rise eigenvalue

    let g1 = d + r;
    let g2 = -(d * r);

    (g1, g2)
}

/// Compute the Lipschitz constant of the gradient of (1/2)||y - K*s||^2.
///
/// L = max_w |H(w)|^2, where H(w) is the DFT of the kernel. This equals the
/// largest eigenvalue of K^T K for a circulant convolution matrix, and is a
/// tight upper bound for the Toeplitz (causal) convolution matrix used in practice.
///
/// Computed via direct DFT of the kernel (O(n^2) but kernel is short, ~100-200 samples).
/// Takes f32 kernel but uses f64 intermediates for DFT precision; returns f64.
///
/// Future optimization: could use `RealFftPlanner<f64>` for O(n log n), but this runs
/// only on parameter changes (not per-iteration) and the kernel is short enough that
/// the brute-force DFT is sub-millisecond. The f64 precision here is intentional since
/// the Lipschitz constant controls the FISTA step size.
pub fn compute_lipschitz(kernel: &[f32]) -> f64 {
    let n = kernel.len();
    if n == 0 {
        return 1e-10;
    }

    // Zero-pad to at least 2*n for proper spectral analysis
    let fft_len = (2 * n).next_power_of_two();

    // Compute max |H(w)|^2 via direct DFT
    let mut max_power = 0.0_f64;
    for w in 0..fft_len {
        let freq = 2.0 * std::f64::consts::PI * (w as f64) / (fft_len as f64);
        let mut re = 0.0_f64;
        let mut im = 0.0_f64;
        for (k, &hk) in kernel.iter().enumerate() {
            let hk64 = hk as f64;
            let angle = freq * (k as f64);
            re += hk64 * angle.cos();
            im -= hk64 * angle.sin();
        }
        let power = re * re + im * im;
        if power > max_power {
            max_power = power;
        }
    }

    max_power.max(1e-10)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: Kernel peak is 1.0 for typical params
    #[test]
    fn kernel_peak_is_one_typical_params() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let peak = kernel.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(
            (peak - 1.0).abs() < 1e-6,
            "Peak should be 1.0, got {}",
            peak
        );
    }

    // Test 2: Kernel peak is 1.0 for extreme params
    #[test]
    fn kernel_peak_is_one_extreme_params() {
        let kernel = build_kernel(0.001, 2.0, 100.0);
        let peak = kernel.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(
            (peak - 1.0).abs() < 1e-6,
            "Peak should be 1.0 for extreme params, got {}",
            peak
        );
    }

    // Test 3: Kernel first sample is 0.0 (h(0) = exp(0) - exp(0) = 0)
    #[test]
    fn kernel_first_sample_is_zero() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        assert!(
            kernel[0].abs() < 1e-7,
            "First sample should be 0.0, got {}",
            kernel[0]
        );
    }

    // Test 4: All kernel values are >= 0.0
    #[test]
    fn kernel_values_non_negative() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        for (i, &v) in kernel.iter().enumerate() {
            assert!(
                v >= -1e-7,
                "Kernel value at index {} is negative: {}",
                i,
                v
            );
        }
    }

    // Test 5: Kernel length scales with tau_decay * fs
    #[test]
    fn kernel_length_scales_with_tau_decay_fs() {
        let k1 = build_kernel(0.02, 0.4, 30.0);
        let k2 = build_kernel(0.02, 0.8, 30.0);
        // Doubling tau_decay should roughly double kernel length
        assert!(
            k2.len() > k1.len(),
            "Longer tau_decay should produce longer kernel: {} vs {}",
            k2.len(),
            k1.len()
        );

        let k3 = build_kernel(0.02, 0.4, 60.0);
        // Doubling fs should roughly double kernel length
        assert!(
            k3.len() > k1.len(),
            "Higher fs should produce longer kernel: {} vs {}",
            k3.len(),
            k1.len()
        );
    }

    // Test 6: AR(2) g1 and g2 match known values
    #[test]
    fn ar2_coefficients_match_known_values() {
        let tau_rise: f64 = 0.02;
        let tau_decay: f64 = 0.4;
        let fs: f64 = 30.0;
        let dt: f64 = 1.0 / fs;

        let d: f64 = (-dt / tau_decay).exp();
        let r: f64 = (-dt / tau_rise).exp();

        let (g1, g2) = tau_to_ar2(tau_rise, tau_decay, fs);

        assert!(
            (g1 - (d + r)).abs() < 1e-15,
            "g1 should be d + r = {}, got {}",
            d + r,
            g1
        );
        assert!(
            (g2 - (-(d * r))).abs() < 1e-15,
            "g2 should be -(d*r) = {}, got {}",
            -(d * r),
            g2
        );
    }

    // Test 7: AR(2) roots recoverable from g1, g2
    #[test]
    fn ar2_roots_recoverable_and_in_unit_interval() {
        let (g1, g2) = tau_to_ar2(0.02, 0.4, 30.0);

        // Discriminant must be >= 0 for real roots
        let discriminant = g1 * g1 + 4.0 * g2;
        assert!(
            discriminant >= 0.0,
            "Discriminant should be non-negative, got {}",
            discriminant
        );

        // Recover roots
        let d = (g1 + discriminant.sqrt()) / 2.0;
        let r = (g1 - discriminant.sqrt()) / 2.0;

        // Both roots in (0, 1) for stable decaying kernel
        assert!(d > 0.0 && d < 1.0, "Decay root d = {} not in (0,1)", d);
        assert!(r > 0.0 && r < 1.0, "Rise root r = {} not in (0,1)", r);
    }

    // Test 8: Lipschitz constant is positive and >= sum of kernel squared
    #[test]
    fn lipschitz_positive_and_valid() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let lipschitz = compute_lipschitz(&kernel);

        assert!(lipschitz > 0.0, "Lipschitz constant should be positive");

        // The Lipschitz constant (max power spectrum) should be >= sum of squares
        // (by Parseval's theorem, sum of squares = average power, max >= average)
        let sum_squares: f64 = kernel.iter().map(|&k| (k as f64) * (k as f64)).sum();
        assert!(
            lipschitz >= sum_squares * 0.99, // allow tiny numerical error
            "Lipschitz should be >= sum of squares: {} vs {}",
            lipschitz,
            sum_squares
        );

        // And bounded above by (sum of kernel)^2 (L1 norm squared)
        let l1_norm: f64 = kernel.iter().map(|&k| (k as f64).abs()).sum();
        assert!(
            lipschitz <= l1_norm * l1_norm * 1.01, // allow tiny numerical error
            "Lipschitz should be <= L1 norm squared: {} vs {}",
            lipschitz,
            l1_norm * l1_norm
        );
    }
}
