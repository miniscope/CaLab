use crate::kernel::clamp_tau_rise;

/// Banded AR(2) convolution engine — O(T) replacement for FFT-based O(T log T).
///
/// The AR(2) model c[t] = g1*c[t-1] + g2*c[t-2] + s[t-1] defines a banded
/// deconvolution matrix G. The convolution K = G^{-1} is applied via recursion
/// rather than FFT, reducing per-iteration cost from O(T log T) to O(T).
///
/// The recursion is evaluated as a cascade of two first-order filters,
/// `u[t] = d*u[t-1] + x[t]; c[t] = r*c[t-1] + u[t]`, with d = exp(-dt/tau_decay)
/// and r = exp(-dt/tau_rise) the AR(2) roots — algebraically identical to the
/// direct form since (1 - d z^-1)(1 - r z^-1) = 1 - g1 z^-1 - g2 z^-2. The
/// direct form is ill-conditioned once g1/g2 are rounded to f32: at high
/// sampling rates (CaDecon upsamples to 300 Hz) d and r are both close to 1
/// and to each other, so the roots of the f32-rounded polynomial land several
/// percent away from the requested time constants (up to ~40% at
/// tau_rise > tau_decay, and complex roots near tau_rise ≈ tau_decay). Each
/// cascade stage rounds its own root directly, so it has no such cancellation.
///
/// The cascade runs with f64 coefficients and state, rounding only the output
/// to f32. Measured against an f64 direct-form reference (fs 5–300 Hz,
/// tau_decay 0.05–5 s, T up to 270k) this is within ~3e-8 relative L2. An
/// all-f32 cascade is ~1e-6 for typical kernels but up to ~7e-6 at
/// tau_decay = 5 s / 300 Hz, almost entirely from rounding d to f32 (the DC
/// gain 1/(1-d) amplifies that rounding by 1/(1-d) ≈ 1500). The recursion is
/// serial and latency-bound either way (it cannot be SIMD-vectorized), and
/// f64 mul/add have the same latency as f32 on current CPUs and are native
/// WASM ops; natively the f64 cascade measured the same speed as the f32 one.
///
/// Note the one-sample delay on the source term (`s[t-1]`, not `s[t]`). This
/// makes the impulse response identical, sample-for-sample, to the FFT-mode
/// `build_kernel` bi-exponential: zero at the spike sample and rising after
/// (h[0] = 0, h[n] = build_kernel[n]). Without the delay the AR(2) recursion
/// places a nonzero value at the spike sample — the same shape advanced one
/// sample earlier — so the two conv modes would disagree by one sample. Both
/// modes, the ground-truth simulation, the kernel display, and the tau→shape
/// math all use this same "calcium rises from zero" convention.
///
/// The raw AR2 impulse peak is sampling-rate-dependent (larger at higher fs
/// because the recursion accumulates over more timesteps during the rise phase).
/// To make alpha rate-independent, the forward and adjoint convolutions are
/// normalized by the impulse peak so that a single spike always produces a
/// peak of 1.0 in the output regardless of sampling rate. The one-sample delay
/// leaves the peak *value* unchanged (it is the max over the same geometric
/// sequence), so the impulse-peak and Lipschitz calculations are unaffected.
pub(crate) struct BandedAR2 {
    d: f64,            // decay root exp(-dt/tau_decay)
    r: f64,            // rise root exp(-dt/tau_rise)
    g1: f64,           // d + r (sum of AR2 roots)
    g2: f64,           // -(d * r) (negative product of AR2 roots)
    impulse_peak: f64, // peak of raw AR2 impulse response (for normalization)
    lipschitz: f64,    // Lipschitz constant of the normalized operator
}

impl BandedAR2 {
    /// Create a new BandedAR2 with the given tau parameters.
    pub(crate) fn new(tau_rise: f64, tau_decay: f64, fs: f64) -> Self {
        let tau_rise = clamp_tau_rise(tau_rise, tau_decay);
        let dt = 1.0 / fs;
        let d = (-dt / tau_decay).exp();
        let r = (-dt / tau_rise).exp();
        let g1 = d + r;
        let g2 = -(d * r);
        let impulse_peak = compute_impulse_peak(g1, g2, tau_decay, fs);
        // Lipschitz of normalized operator: L_raw / peak^2
        let lipschitz = compute_banded_lipschitz(g1, g2) / (impulse_peak * impulse_peak);
        BandedAR2 {
            d,
            r,
            g1,
            g2,
            impulse_peak,
            lipschitz,
        }
    }

    /// Recompute coefficients after parameter change.
    pub(crate) fn update(&mut self, tau_rise: f64, tau_decay: f64, fs: f64) {
        *self = Self::new(tau_rise, tau_decay, fs);
    }

    /// Forward convolution: s -> normalized AR2 output, O(T).
    ///
    /// Pre-scales input by 1/peak so the recursion directly produces a
    /// peak-normalized output — no second normalization pass needed. The
    /// source is fed with a one-sample delay (`s[t-1]`) so the impulse response
    /// matches `build_kernel` exactly: output[0] = 0, and a spike at sample k
    /// begins its rise at k+1.
    ///
    /// Evaluated as the decay filter `u[t] = d*u[t-1] + s[t-1]/peak` followed
    /// by the rise filter `c[t] = r*c[t-1] + u[t]` (see the struct docs for
    /// why this beats the f32 direct form).
    pub(crate) fn convolve_forward(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let (d, r) = (self.d, self.r);
        let inv_peak = 1.0 / self.impulse_peak;

        // Delayed source: output[0] is always 0 (no s[-1] term), and both
        // filter states start at 0.
        output[0] = 0.0;
        let mut u = 0.0_f64;
        let mut c = 0.0_f64;
        for t in 1..n {
            u = d * u + source[t - 1] as f64 * inv_peak;
            c = r * c + u;
            output[t] = c as f32;
        }
    }

    /// Adjoint convolution: normalized adjoint, O(T).
    ///
    /// Pre-scales input by 1/peak so the backward recursion directly produces
    /// a peak-normalized output — no second normalization pass needed.
    ///
    /// The forward operator is `R^{-1} D^{-1} z^-1` (decay filter, then rise
    /// filter, after a one-sample delay), so its adjoint is the reversed
    /// cascade `z^+1 D^{-T} R^{-T}`: the anti-causal rise filter
    /// `v[t] = r*v[t+1] + s[t]/peak`, then the anti-causal decay filter
    /// `a[t] = d*a[t+1] + v[t]`, written shifted up one index —
    /// `output[t-1] = a[t]`, with `output[n-1] = 0`. Rolling state keeps it
    /// O(T) and allocation-free.
    pub(crate) fn convolve_adjoint(&self, source: &[f32], output: &mut [f32]) {
        let n = source.len();
        if n == 0 {
            return;
        }

        let (d, r) = (self.d, self.r);
        let inv_peak = 1.0 / self.impulse_peak;

        output[n - 1] = 0.0;
        let mut v = 0.0_f64;
        let mut a = 0.0_f64;
        for t in (1..n).rev() {
            v = r * v + source[t] as f64 * inv_peak;
            a = d * a + v;
            output[t - 1] = a as f32;
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
        // Banded forward (peak-normalized) produces a calcium-like shape with
        // peak = 1.0. With the one-sample source delay the spike sample itself
        // is zero and the response rises starting the sample after — matching
        // the build_kernel convention (h[0] = 0).
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 200;

        let mut signal = vec![0.0_f32; n];
        signal[10] = 1.0;

        let mut result = vec![0.0_f32; n];
        banded.convolve_forward(&signal, &mut result);

        // Up to and including the spike sample: zero (response is delayed one sample).
        for i in 0..=10 {
            assert!(
                result[i].abs() < 1e-6,
                "Expected zero at/before spike at index {}, got {}",
                i,
                result[i]
            );
        }

        // One sample after the spike: positive rise.
        assert!(
            result[11] > 0.01,
            "Expected positive response one sample after spike, got {}",
            result[11]
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
    fn impulse_response_matches_build_kernel() {
        // The banded forward operator and the FFT-mode build_kernel are the SAME
        // discrete operator: a unit impulse through convolve_forward must equal
        // build_kernel sample-for-sample. This is the direct regression guard for
        // the one-sample alignment between the two conv modes.
        // The last three cases are near-equal roots at 300 Hz, where the old
        // f32 direct-form recursion drifted visibly from build_kernel.
        for &(tau_r, tau_d, fs) in &[
            (0.02, 0.4, 30.0),
            (0.05, 0.25, 100.0),
            (0.01, 0.15, 300.0),
            (0.99, 1.0, 300.0),
            (4.5, 5.0, 300.0),
            (0.9, 1.0, 300.0),
        ] {
            let banded = BandedAR2::new(tau_r, tau_d, fs);
            let kernel = build_kernel(tau_r, tau_d, fs);
            let n = kernel.len();

            let mut impulse = vec![0.0_f32; n];
            impulse[0] = 1.0;
            let mut response = vec![0.0_f32; n];
            banded.convolve_forward(&impulse, &mut response);

            for i in 0..n {
                assert!(
                    (response[i] - kernel[i]).abs() < 1e-4,
                    "fs={} sample {}: banded {} != build_kernel {}",
                    fs,
                    i,
                    response[i],
                    kernel[i]
                );
            }
        }
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
        solver_fft.set_params(0.02, 0.4, 0.01, 30.0).unwrap();
        solver_fft.set_conv_mode(ConvMode::Fft);
        solver_fft.set_trace(&trace).unwrap();
        for _ in 0..200 {
            if solver_fft.step_batch(10).unwrap() {
                break;
            }
        }
        let sol_fft = solver_fft.get_solution();

        // Solve with Banded mode
        let mut solver_banded = Solver::new();
        solver_banded.set_params(0.02, 0.4, 0.01, 30.0).unwrap();
        solver_banded.set_conv_mode(ConvMode::BandedAR2);
        solver_banded.set_trace(&trace).unwrap();
        for _ in 0..200 {
            if solver_banded.step_batch(10).unwrap() {
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

        // Both should identify at least 3 of the 4 true spike locations exactly.
        // With the operators aligned, an exact-index match is achievable (the
        // ground-truth trace is built from build_kernel, which both modes now
        // implement identically) — a tolerance here would mask a re-introduced
        // one-sample shift, which is the whole point of this test.
        let mut fft_top4: Vec<usize> = fft_spikes.iter().take(4).map(|&(i, _)| i).collect();
        let mut banded_top4: Vec<usize> = banded_spikes.iter().take(4).map(|&(i, _)| i).collect();
        fft_top4.sort_unstable();
        banded_top4.sort_unstable();

        let fft_matches = spikes.iter().filter(|&&s| fft_top4.contains(&s)).count();
        let banded_matches = spikes.iter().filter(|&&s| banded_top4.contains(&s)).count();
        assert!(
            fft_matches >= 3,
            "FFT mode should find >= 3 of 4 spikes exactly, found {} (locations: {:?})",
            fft_matches,
            fft_top4
        );
        assert!(
            banded_matches >= 3,
            "Banded mode should find >= 3 of 4 spikes exactly, found {} (locations: {:?})",
            banded_matches,
            banded_top4
        );

        // The two modes are the same operator, so they must agree with each other
        // on the recovered spike locations — this is the direct alignment guard.
        assert_eq!(
            fft_top4, banded_top4,
            "FFT and Banded modes must recover identical spike locations; a mismatch \
             indicates a one-sample forward-model shift between conv modes"
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

    // ── Precision against an f64 reference ──────────────────────────────

    /// Deterministic xorshift PRNG (no external deps in unit tests).
    struct Rng(u64);
    impl Rng {
        fn next_f64(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Sparse non-negative spike train (forward-operator input in FISTA).
    fn sparse_spikes(n: usize, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed);
        (0..n)
            .map(|_| {
                if rng.next_f64() < 0.02 {
                    rng.next_f64() as f32
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// Dense signed noise (adjoint-operator input in FISTA: the residual).
    fn signed_noise(n: usize, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed);
        (0..n)
            .map(|_| (2.0 * rng.next_f64() - 1.0) as f32)
            .collect()
    }

    /// f64 direct-form forward: c[t] = g1 c[t-1] + g2 c[t-2] + s[t-1]/peak.
    fn forward_ref_f64(b: &BandedAR2, src: &[f32]) -> Vec<f64> {
        let n = src.len();
        let mut out = vec![0.0_f64; n];
        for t in 1..n {
            let c1 = out[t - 1];
            let c2 = if t >= 2 { out[t - 2] } else { 0.0 };
            out[t] = b.g1 * c1 + b.g2 * c2 + src[t - 1] as f64 / b.impulse_peak;
        }
        out
    }

    /// f64 direct-form adjoint: a[t] = s[t]/peak + g1 a[t+1] + g2 a[t+2],
    /// output[t-1] = a[t], output[n-1] = 0.
    fn adjoint_ref_f64(b: &BandedAR2, src: &[f32]) -> Vec<f64> {
        let n = src.len();
        let mut out = vec![0.0_f64; n];
        let (mut a1, mut a2) = (0.0_f64, 0.0_f64);
        for t in (1..n).rev() {
            let a = src[t] as f64 / b.impulse_peak + b.g1 * a1 + b.g2 * a2;
            out[t - 1] = a;
            a2 = a1;
            a1 = a;
        }
        out
    }

    fn rel_l2(x: &[f32], reference: &[f64]) -> f64 {
        let num: f64 = x
            .iter()
            .zip(reference)
            .map(|(&a, &b)| (a as f64 - b).powi(2))
            .sum();
        let den: f64 = reference.iter().map(|&b| b * b).sum();
        if den == 0.0 {
            num.sqrt()
        } else {
            (num / den).sqrt()
        }
    }

    /// (tau_rise, tau_decay, fs) grid from the numerical review: fs up to the
    /// CaDecon upsampled rate, rise from very fast to within 1% of decay, plus
    /// the exact-equality case `clamp_tau_rise` rewrites.
    fn precision_grid() -> Vec<(f64, f64, f64)> {
        let mut grid = Vec::new();
        for &fs in &[5.0, 30.0, 100.0, 300.0] {
            for &td in &[0.05, 0.4, 1.0, 5.0] {
                for &tr in &[0.005, 0.02, 0.2, 0.99 * td, td] {
                    grid.push((tr, td, fs));
                }
            }
        }
        grid
    }

    #[test]
    fn cascade_matches_f64_reference_across_grid() {
        let mut worst_fwd = (0.0_f64, (0.0, 0.0, 0.0, 0usize));
        let mut worst_adj = (0.0_f64, (0.0, 0.0, 0.0, 0usize));
        for &n in &[100usize, 27_000, 270_000] {
            let x = sparse_spikes(n, 0x9E37_79B9_7F4A_7C15 ^ n as u64);
            let y = signed_noise(n, 0xD1B5_4A32_D192_ED03 ^ n as u64);
            let mut out = vec![0.0_f32; n];
            for &(tr, td, fs) in &precision_grid() {
                let b = BandedAR2::new(tr, td, fs);

                b.convolve_forward(&x, &mut out);
                let e = rel_l2(&out, &forward_ref_f64(&b, &x));
                if e > worst_fwd.0 {
                    worst_fwd = (e, (tr, td, fs, n));
                }

                b.convolve_adjoint(&y, &mut out);
                let e = rel_l2(&out, &adjoint_ref_f64(&b, &y));
                if e > worst_adj.0 {
                    worst_adj = (e, (tr, td, fs, n));
                }
            }
        }
        // Measured worst case ~3e-8 (f64 cascade state; output rounded to
        // f32). For comparison, on this grid an all-f32 cascade reaches ~7e-6
        // and the previous f32 direct form ~6e-2.
        assert!(
            worst_fwd.0 <= 1e-7,
            "forward rel L2 {} at (tau_r, tau_d, fs, T) = {:?}",
            worst_fwd.0,
            worst_fwd.1
        );
        assert!(
            worst_adj.0 <= 1e-7,
            "adjoint rel L2 {} at (tau_r, tau_d, fs, T) = {:?}",
            worst_adj.0,
            worst_adj.1
        );
    }

    #[test]
    fn adjointness_across_grid() {
        // <K x, y> == <x, K^T y> for the f32 operators, on random inputs.
        let n = 5_000;
        let x = signed_noise(n, 17);
        let y = signed_noise(n, 29);
        let mut kx = vec![0.0_f32; n];
        let mut kty = vec![0.0_f32; n];
        for &(tr, td, fs) in &precision_grid() {
            let b = BandedAR2::new(tr, td, fs);
            b.convolve_forward(&x, &mut kx);
            b.convolve_adjoint(&y, &mut kty);
            let lhs: f64 = kx.iter().zip(&y).map(|(&a, &b)| a as f64 * b as f64).sum();
            let rhs: f64 = x.iter().zip(&kty).map(|(&a, &b)| a as f64 * b as f64).sum();
            // Scale by ||Kx|| ||y|| so cancellation in the inner product cannot
            // make a tiny absolute error look large.
            let kx_norm: f64 = kx.iter().map(|&a| (a as f64).powi(2)).sum::<f64>().sqrt();
            let y_norm: f64 = y.iter().map(|&a| (a as f64).powi(2)).sum::<f64>().sqrt();
            let err = (lhs - rhs).abs() / (kx_norm * y_norm).max(1e-30);
            assert!(
                err < 1e-6,
                "(tau_r, tau_d, fs) = ({tr}, {td}, {fs}): <Kx,y>={lhs} vs <x,K^Ty>={rhs}, err={err}"
            );
        }
    }
}
