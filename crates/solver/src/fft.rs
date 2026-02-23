use realfft::RealFftPlanner;
use rustfft::num_complex::Complex;
use std::sync::Arc;

/// Self-contained FFT convolution engine.
///
/// Owns all FFT plans, scratch buffers, and the pre-computed kernel spectrum.
/// Because it is a separate struct from `Solver`, callers can borrow it mutably
/// while simultaneously borrowing other `Solver` fields (split borrows),
/// eliminating the per-iteration `to_vec()` copies that were previously needed.
///
/// Buffers grow but never shrink to prevent WASM memory fragmentation.
pub(crate) struct FftConvolver {
    planner: RealFftPlanner<f32>,
    fft_len: usize, // padded FFT length (power of 2), 0 = uninitialized

    // Cached FFT plans (Arc from planner, avoids hash-map lookup per call)
    plan_fwd: Option<Arc<dyn realfft::RealToComplex<f32>>>,
    plan_inv: Option<Arc<dyn realfft::ComplexToReal<f32>>>,

    // Pre-computed kernel spectra
    kernel_fft: Vec<Complex<f32>>,
    kernel_conj_fft: Vec<Complex<f32>>,

    // Scratch buffers
    fft_input: Vec<f32>,
    fft_output: Vec<f32>,
    fft_spectrum: Vec<Complex<f32>>,
    fft_scratch_fwd: Vec<Complex<f32>>,
    fft_scratch_inv: Vec<Complex<f32>>,
}

impl FftConvolver {
    pub(crate) fn new() -> Self {
        FftConvolver {
            planner: RealFftPlanner::new(),
            fft_len: 0,
            plan_fwd: None,
            plan_inv: None,
            kernel_fft: Vec::new(),
            kernel_conj_fft: Vec::new(),
            fft_input: Vec::new(),
            fft_output: Vec::new(),
            fft_spectrum: Vec::new(),
            fft_scratch_fwd: Vec::new(),
            fft_scratch_inv: Vec::new(),
        }
    }

    /// Current padded FFT length (0 = uninitialized).
    pub(crate) fn fft_len(&self) -> usize {
        self.fft_len
    }

    /// Invalidate cached FFT length, forcing a full rebuild on next `ensure_buffers`.
    pub(crate) fn invalidate(&mut self) {
        self.fft_len = 0;
        self.plan_fwd = None;
        self.plan_inv = None;
    }

    /// Ensure FFT buffers are allocated for the given signal + kernel size.
    /// Recomputes kernel FFT when the padded FFT length changes.
    /// Buffers grow but never shrink.
    pub(crate) fn ensure_buffers(&mut self, signal_len: usize, kernel: &[f32]) {
        let k_len = kernel.len();
        if signal_len == 0 || k_len == 0 {
            return;
        }

        let min_len = signal_len + k_len - 1;
        let padded_len = min_len.next_power_of_two();

        if padded_len == self.fft_len {
            return; // Already set up for this length
        }

        self.fft_len = padded_len;
        let spectrum_len = padded_len / 2 + 1;

        // Grow buffers (never shrink)
        if self.fft_input.len() < padded_len {
            self.fft_input.resize(padded_len, 0.0);
        }
        if self.fft_output.len() < padded_len {
            self.fft_output.resize(padded_len, 0.0);
        }
        if self.fft_spectrum.len() < spectrum_len {
            self.fft_spectrum
                .resize(spectrum_len, Complex::new(0.0, 0.0));
        }
        if self.kernel_fft.len() < spectrum_len {
            self.kernel_fft.resize(spectrum_len, Complex::new(0.0, 0.0));
        }
        if self.kernel_conj_fft.len() < spectrum_len {
            self.kernel_conj_fft
                .resize(spectrum_len, Complex::new(0.0, 0.0));
        }

        // Cache FFT plans and allocate scratch
        let fwd = self.planner.plan_fft_forward(padded_len);
        let inv = self.planner.plan_fft_inverse(padded_len);
        let fwd_scratch = fwd.get_scratch_len();
        let inv_scratch = inv.get_scratch_len();
        if self.fft_scratch_fwd.len() < fwd_scratch {
            self.fft_scratch_fwd
                .resize(fwd_scratch, Complex::new(0.0, 0.0));
        }
        if self.fft_scratch_inv.len() < inv_scratch {
            self.fft_scratch_inv
                .resize(inv_scratch, Complex::new(0.0, 0.0));
        }
        self.plan_fwd = Some(fwd);
        self.plan_inv = Some(inv);

        // Pre-compute kernel FFT and its conjugate
        self.prepare_kernel(kernel);
    }

    /// Recompute kernel FFT using the current padded length.
    /// Call after kernel changes when buffers are already large enough.
    pub(crate) fn prepare_kernel(&mut self, kernel: &[f32]) {
        let k_len = kernel.len();
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad kernel into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < k_len { kernel[i] } else { 0.0 };
        }

        // Forward FFT of kernel
        let fwd = self
            .plan_fwd
            .as_ref()
            .expect("plans not initialized")
            .clone();
        fwd.process_with_scratch(
            &mut self.fft_input[..padded_len],
            &mut self.kernel_fft[..spectrum_len],
            &mut self.fft_scratch_fwd,
        )
        .unwrap();

        // Conjugate for adjoint (correlation = convolution with reversed kernel)
        for i in 0..spectrum_len {
            self.kernel_conj_fft[i] = self.kernel_fft[i].conj();
        }
    }

    /// FFT-based forward convolution: output[..signal_len] = (K * source)[..signal_len].
    pub(crate) fn convolve_forward(
        &mut self,
        source: &[f32],
        signal_len: usize,
        output: &mut [f32],
    ) {
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad source into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < signal_len { source[i] } else { 0.0 };
        }

        // Forward FFT of source
        let fwd = self
            .plan_fwd
            .as_ref()
            .expect("plans not initialized")
            .clone();
        fwd.process_with_scratch(
            &mut self.fft_input[..padded_len],
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_scratch_fwd,
        )
        .unwrap();

        // Pointwise multiply with kernel FFT
        for i in 0..spectrum_len {
            self.fft_spectrum[i] *= self.kernel_fft[i];
        }

        // Inverse FFT
        let inv = self
            .plan_inv
            .as_ref()
            .expect("plans not initialized")
            .clone();
        inv.process_with_scratch(
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_output[..padded_len],
            &mut self.fft_scratch_inv,
        )
        .unwrap();

        // Normalize and copy first signal_len samples to output
        let scale = 1.0 / padded_len as f32;
        for i in 0..signal_len {
            output[i] = self.fft_output[i] * scale;
        }
    }

    /// FFT-based adjoint convolution (correlation): output[..signal_len] = (K^T * source)[..signal_len].
    pub(crate) fn convolve_adjoint(
        &mut self,
        source: &[f32],
        signal_len: usize,
        output: &mut [f32],
    ) {
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad source into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < signal_len { source[i] } else { 0.0 };
        }

        // Forward FFT of source
        let fwd = self
            .plan_fwd
            .as_ref()
            .expect("plans not initialized")
            .clone();
        fwd.process_with_scratch(
            &mut self.fft_input[..padded_len],
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_scratch_fwd,
        )
        .unwrap();

        // Pointwise multiply with conjugate kernel FFT
        for i in 0..spectrum_len {
            self.fft_spectrum[i] *= self.kernel_conj_fft[i];
        }

        // Inverse FFT
        let inv = self
            .plan_inv
            .as_ref()
            .expect("plans not initialized")
            .clone();
        inv.process_with_scratch(
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_output[..padded_len],
            &mut self.fft_scratch_inv,
        )
        .unwrap();

        // Normalize and copy first signal_len samples to output
        let scale = 1.0 / padded_len as f32;
        for i in 0..signal_len {
            output[i] = self.fft_output[i] * scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::build_kernel;

    /// Delta test: convolving an impulse at t=0 recovers the kernel.
    #[test]
    fn impulse_recovers_kernel() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = kernel.len();

        let mut conv = FftConvolver::new();
        conv.ensure_buffers(n, &kernel);

        // Impulse at t=0
        let mut impulse = vec![0.0_f32; n];
        impulse[0] = 1.0;

        let mut output = vec![0.0_f32; n];
        conv.convolve_forward(&impulse, n, &mut output);

        for i in 0..n {
            let diff = (output[i] - kernel[i]).abs();
            assert!(
                diff < 1e-5,
                "Impulse response differs from kernel at index {}: got {} expected {} (diff {})",
                i,
                output[i],
                kernel[i],
                diff
            );
        }
    }

    /// Adjoint identity: <Kx, y> == <x, K^T y> for deterministic vectors.
    #[test]
    fn adjoint_identity() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 64;

        let mut conv = FftConvolver::new();
        conv.ensure_buffers(n, &kernel);

        // Deterministic test vectors
        let x: Vec<f32> = (0..n).map(|i| (i as f32 * 0.3).sin()).collect();
        let y: Vec<f32> = (0..n).map(|i| (i as f32 * 0.7 + 1.0).cos()).collect();

        // Kx = forward convolution of x
        let mut kx = vec![0.0_f32; n];
        conv.convolve_forward(&x, n, &mut kx);

        // K^T y = adjoint convolution of y
        let mut kty = vec![0.0_f32; n];
        conv.convolve_adjoint(&y, n, &mut kty);

        // <Kx, y>
        let lhs: f64 = kx
            .iter()
            .zip(y.iter())
            .map(|(&a, &b)| a as f64 * b as f64)
            .sum();
        // <x, K^T y>
        let rhs: f64 = x
            .iter()
            .zip(kty.iter())
            .map(|(&a, &b)| a as f64 * b as f64)
            .sum();

        let rel_err = (lhs - rhs).abs() / lhs.abs().max(1e-10);
        assert!(
            rel_err < 1e-4,
            "Adjoint identity violated: <Kx,y>={} vs <x,K^Ty>={} (rel_err={})",
            lhs,
            rhs,
            rel_err
        );
    }
}
