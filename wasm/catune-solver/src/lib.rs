mod kernel;
mod fista;
mod filter;

use kernel::{build_kernel, compute_lipschitz};
use filter::BandpassFilter;
use realfft::RealFftPlanner;
use rustfft::num_complex::Complex;
use std::io::{Cursor, Read};
use wasm_bindgen::prelude::*;

/// FISTA solver for calcium deconvolution.
///
/// Minimizes (1/2)||y - K*s - b||^2 + lambda*G_dc*||s||_1 subject to s >= 0,
/// where K is the convolution matrix derived from a double-exponential kernel,
/// b is a scalar baseline estimated jointly, and G_dc = sum(K) scales lambda
/// so the sparsity slider is effective across all kernel configurations.
///
/// Pre-allocated buffers grow but never shrink to prevent WASM memory fragmentation.
#[wasm_bindgen]
pub struct Solver {
    // Parameters
    tau_rise: f64,
    tau_decay: f64,
    lambda: f64,
    fs: f64,

    // Pre-allocated working buffers (f32 to halve memory per worker)
    pub(crate) trace: Vec<f32>,
    pub(crate) solution: Vec<f32>,
    pub(crate) solution_prev: Vec<f32>,
    pub(crate) gradient: Vec<f32>,
    pub(crate) reconvolution: Vec<f32>,
    pub(crate) residual_buf: Vec<f32>,
    pub(crate) kernel: Vec<f32>,

    // FISTA state
    pub(crate) iteration: u32,
    pub(crate) t_fista: f64,
    pub(crate) converged: bool,
    pub(crate) active_len: usize,

    // Convergence tracking
    pub(crate) prev_objective: f64,
    pub(crate) tolerance: f64,
    pub(crate) lipschitz_constant: f64,

    // Baseline and kernel scaling
    pub(crate) baseline: f64,
    kernel_dc_gain: f64,

    // FFT-based convolution infrastructure
    pub(crate) fft_planner: RealFftPlanner<f32>,
    pub(crate) fft_len: usize,             // padded FFT length (power of 2 >= n + k_len - 1)
    pub(crate) kernel_fft: Vec<Complex<f32>>,      // pre-computed FFT of kernel (spectrum_len)
    pub(crate) kernel_conj_fft: Vec<Complex<f32>>, // conjugate of kernel FFT (for adjoint)
    pub(crate) fft_input: Vec<f32>,                // scratch: real input buffer (fft_len)
    pub(crate) fft_spectrum: Vec<Complex<f32>>,    // scratch: complex spectrum (fft_len/2 + 1)
    pub(crate) fft_scratch_fwd: Vec<Complex<f32>>, // scratch for forward FFT
    pub(crate) fft_scratch_inv: Vec<Complex<f32>>, // scratch for inverse FFT
    pub(crate) fft_output: Vec<f32>,               // scratch: real output buffer (fft_len)
    pub(crate) reconvolution_stale: bool,          // dirty flag for lazy reconvolution

    // Bandpass filter
    bandpass: BandpassFilter,
}

#[wasm_bindgen]
impl Solver {
    /// Create a new Solver with default parameters.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Solver {
        #[cfg(target_arch = "wasm32")]
        console_error_panic_hook::set_once();

        let mut solver = Solver {
            tau_rise: 0.02,
            tau_decay: 0.4,
            lambda: 0.01,
            fs: 30.0,
            trace: Vec::new(),
            solution: Vec::new(),
            solution_prev: Vec::new(),
            gradient: Vec::new(),
            reconvolution: Vec::new(),
            residual_buf: Vec::new(),
            kernel: Vec::new(),
            iteration: 0,
            t_fista: 1.0,
            converged: false,
            active_len: 0,
            prev_objective: f64::INFINITY,
            tolerance: 1e-6,
            lipschitz_constant: 1.0,
            baseline: 0.0,
            kernel_dc_gain: 1.0,
            fft_planner: RealFftPlanner::new(),
            fft_len: 0,
            kernel_fft: Vec::new(),
            kernel_conj_fft: Vec::new(),
            fft_input: Vec::new(),
            fft_spectrum: Vec::new(),
            fft_scratch_fwd: Vec::new(),
            fft_scratch_inv: Vec::new(),
            fft_output: Vec::new(),
            reconvolution_stale: true,
            bandpass: BandpassFilter::new(),
        };

        // Build kernel with default params
        solver.kernel = build_kernel(solver.tau_rise, solver.tau_decay, solver.fs);
        solver.lipschitz_constant = compute_lipschitz(&solver.kernel);
        solver.kernel_dc_gain = solver.kernel.iter().map(|&k| k as f64).sum();

        solver
    }

    /// Update solver parameters and rebuild kernel.
    pub fn set_params(&mut self, tau_rise: f64, tau_decay: f64, lambda: f64, fs: f64) {
        self.tau_rise = tau_rise;
        self.tau_decay = tau_decay;
        self.lambda = lambda;
        self.fs = fs;
        self.kernel = build_kernel(tau_rise, tau_decay, fs);
        self.lipschitz_constant = compute_lipschitz(&self.kernel);
        self.kernel_dc_gain = self.kernel.iter().map(|&k| k as f64).sum();
        self.bandpass.update_cutoffs(tau_rise, tau_decay, fs);

        // Update kernel FFT if buffers are already set up and large enough.
        // On re-enqueue quanta with unchanged trace length, this avoids a full
        // FFT plan + buffer rebuild in ensure_fft_buffers.
        if self.fft_len > 0 && self.active_len > 0 {
            let min_len = self.active_len + self.kernel.len() - 1;
            if min_len <= self.fft_len {
                // Existing FFT buffers are large enough — just re-FFT the kernel
                self.prepare_kernel_fft();
            } else {
                // New kernel is longer; need larger FFT — invalidate
                self.fft_len = 0;
            }
        }
        // If fft_len == 0 or active_len == 0, ensure_fft_buffers in set_trace handles it
    }

    /// Load a trace for deconvolution. Grows buffers if needed (never shrinks).
    /// Resets iteration state for a fresh solve.
    pub fn set_trace(&mut self, trace: &[f32]) {
        self.active_len = trace.len();

        // Grow buffers if needed (never shrink to prevent WASM memory fragmentation)
        if self.trace.len() < trace.len() {
            let n = trace.len();
            self.trace.resize(n, 0.0);
            self.solution.resize(n, 0.0);
            self.solution_prev.resize(n, 0.0);
            self.gradient.resize(n, 0.0);
            self.reconvolution.resize(n, 0.0);
            self.residual_buf.resize(n, 0.0);
        }

        // Copy trace data and zero out solution buffers for active region
        let n = trace.len();
        self.trace[..n].copy_from_slice(trace);
        self.solution[..n].fill(0.0);
        self.solution_prev[..n].fill(0.0);
        self.gradient[..n].fill(0.0);
        self.reconvolution[..n].fill(0.0);
        self.residual_buf[..n].fill(0.0);

        // Reset iteration state
        self.iteration = 0;
        self.t_fista = 1.0;
        self.converged = false;
        self.prev_objective = f64::INFINITY;
        self.baseline = 0.0;
        self.reconvolution_stale = true;

        // Prepare FFT infrastructure for this trace length
        self.ensure_fft_buffers();
    }

    /// Returns a copy of the kernel.
    ///
    /// Returns `Vec<f32>` which wasm-bindgen copies into a JS-owned `Float32Array`.
    /// A WASM memory view would be unsound here: any subsequent WASM allocation
    /// (e.g. `set_trace`) can grow the memory and invalidate the view. The JS side
    /// also transfers these buffers via `postMessage`, which requires ownership.
    pub fn get_kernel(&self) -> Vec<f32> {
        self.kernel.clone()
    }

    /// Returns the current solution (spike train) for the active region.
    ///
    /// See `get_kernel` for why this returns an owned copy rather than a memory view.
    pub fn get_solution(&self) -> Vec<f32> {
        self.solution[..self.active_len].to_vec()
    }

    /// Returns the reconvolution (K * solution) for the active region.
    /// Computes the reconvolution lazily if it is stale (not computed during iteration).
    ///
    /// See `get_kernel` for why this returns an owned copy rather than a memory view.
    pub fn get_reconvolution(&mut self) -> Vec<f32> {
        if self.reconvolution_stale {
            self.compute_reconvolution();
        }
        self.reconvolution[..self.active_len].to_vec()
    }

    /// Returns reconvolution with baseline added: K*s + b for the active region.
    /// Computes the reconvolution lazily if it is stale.
    ///
    /// See `get_kernel` for why this returns an owned copy rather than a memory view.
    pub fn get_reconvolution_with_baseline(&mut self) -> Vec<f32> {
        if self.reconvolution_stale {
            self.compute_reconvolution();
        }
        let b = self.baseline as f32;
        self.reconvolution[..self.active_len].iter().map(|&v| v + b).collect()
    }

    /// Returns the estimated scalar baseline.
    pub fn get_baseline(&self) -> f64 {
        self.baseline
    }

    /// Returns the current trace for the active region.
    /// After apply_filter(), this contains the filtered trace.
    ///
    /// See `get_kernel` for why this returns an owned copy rather than a memory view.
    pub fn get_trace(&self) -> Vec<f32> {
        self.trace[..self.active_len].to_vec()
    }

    /// Returns whether the solver has converged.
    pub fn converged(&self) -> bool {
        self.converged
    }

    /// Returns the current iteration count.
    pub fn iteration_count(&self) -> u32 {
        self.iteration
    }

    /// Reset FISTA momentum. Used for warm-start after kernel change.
    /// Sets t_fista = 1.0 and copies solution into solution_prev.
    pub fn reset_momentum(&mut self) {
        self.t_fista = 1.0;
        let n = self.active_len;
        self.solution_prev[..n].copy_from_slice(&self.solution[..n]);
    }

    /// Effective lambda scaled by kernel DC gain: lambda * G_dc.
    pub(crate) fn effective_lambda(&self) -> f64 {
        self.lambda * self.kernel_dc_gain
    }

    /// Serialize solver state for warm-start cache.
    /// Format: [active_len (u32)] [t_fista (f64)] [iteration (u32)] [baseline (f64)] [solution f32...] [solution_prev f32...]
    pub fn export_state(&self) -> Vec<u8> {
        let n = self.active_len;
        // 4 bytes active_len + 8 bytes t_fista + 4 bytes iteration + 8 bytes baseline + 2*n*4 bytes solutions (f32)
        let mut buf = Vec::with_capacity(4 + 8 + 4 + 8 + 2 * n * 4);

        buf.extend_from_slice(&(n as u32).to_le_bytes());
        buf.extend_from_slice(&self.t_fista.to_le_bytes());
        buf.extend_from_slice(&self.iteration.to_le_bytes());
        buf.extend_from_slice(&self.baseline.to_le_bytes());

        for i in 0..n {
            buf.extend_from_slice(&self.solution[i].to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&self.solution_prev[i].to_le_bytes());
        }

        buf
    }

    // --- FFT convolution infrastructure ---

    /// Ensure FFT buffers are allocated for the current active_len + kernel size.
    /// Recomputes kernel FFT when the padded FFT length changes.
    /// Buffers grow but never shrink.
    pub(crate) fn ensure_fft_buffers(&mut self) {
        let n = self.active_len;
        let k_len = self.kernel.len();
        if n == 0 || k_len == 0 {
            return;
        }

        // Padded length: next power of 2 >= n + k_len - 1 for linear (non-circular) convolution
        let min_len = n + k_len - 1;
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
            self.fft_spectrum.resize(spectrum_len, Complex::new(0.0, 0.0));
        }
        if self.kernel_fft.len() < spectrum_len {
            self.kernel_fft.resize(spectrum_len, Complex::new(0.0, 0.0));
        }
        if self.kernel_conj_fft.len() < spectrum_len {
            self.kernel_conj_fft.resize(spectrum_len, Complex::new(0.0, 0.0));
        }

        // Plan FFTs and allocate scratch
        let fwd = self.fft_planner.plan_fft_forward(padded_len);
        let inv = self.fft_planner.plan_fft_inverse(padded_len);
        let fwd_scratch = fwd.get_scratch_len();
        let inv_scratch = inv.get_scratch_len();
        if self.fft_scratch_fwd.len() < fwd_scratch {
            self.fft_scratch_fwd.resize(fwd_scratch, Complex::new(0.0, 0.0));
        }
        if self.fft_scratch_inv.len() < inv_scratch {
            self.fft_scratch_inv.resize(inv_scratch, Complex::new(0.0, 0.0));
        }

        // Pre-compute kernel FFT and its conjugate
        self.prepare_kernel_fft();
    }

    /// Compute and cache the FFT of the kernel (forward) and its conjugate (adjoint).
    fn prepare_kernel_fft(&mut self) {
        let k_len = self.kernel.len();
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad kernel into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < k_len { self.kernel[i] } else { 0.0 };
        }

        // Forward FFT of kernel
        let fwd = self.fft_planner.plan_fft_forward(padded_len);
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

    /// FFT-based forward convolution: writes K * source into self.reconvolution[..n].
    /// source must have at least n elements.
    pub(crate) fn convolve_forward_fft(&mut self, source: &[f32]) {
        let n = self.active_len;
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad source into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < n { source[i] } else { 0.0 };
        }

        // Forward FFT of source
        let fwd = self.fft_planner.plan_fft_forward(padded_len);
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
        let inv = self.fft_planner.plan_fft_inverse(padded_len);
        inv.process_with_scratch(
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_output[..padded_len],
            &mut self.fft_scratch_inv,
        )
        .unwrap();

        // Normalize and copy first n samples to reconvolution
        let scale = 1.0 / padded_len as f32;
        for i in 0..n {
            self.reconvolution[i] = self.fft_output[i] * scale;
        }
    }

    /// FFT-based adjoint convolution (correlation): writes K^T * source into self.gradient[..n].
    /// Uses the conjugate kernel FFT. source must have at least n elements.
    pub(crate) fn convolve_adjoint_fft(&mut self, source: &[f32]) {
        let n = self.active_len;
        let padded_len = self.fft_len;
        let spectrum_len = padded_len / 2 + 1;

        // Zero-pad source into fft_input
        for i in 0..padded_len {
            self.fft_input[i] = if i < n { source[i] } else { 0.0 };
        }

        // Forward FFT of source
        let fwd = self.fft_planner.plan_fft_forward(padded_len);
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
        let inv = self.fft_planner.plan_fft_inverse(padded_len);
        inv.process_with_scratch(
            &mut self.fft_spectrum[..spectrum_len],
            &mut self.fft_output[..padded_len],
            &mut self.fft_scratch_inv,
        )
        .unwrap();

        // Normalize and copy first n samples to gradient
        let scale = 1.0 / padded_len as f32;
        for i in 0..n {
            self.gradient[i] = self.fft_output[i] * scale;
        }
    }

    /// Compute reconvolution (K * solution) on demand for getters.
    /// Called lazily when get_reconvolution() or get_reconvolution_with_baseline() is invoked
    /// and reconvolution_stale is true.
    fn compute_reconvolution(&mut self) {
        let n = self.active_len;
        if n == 0 {
            return;
        }

        // Use FFT-based convolution if infrastructure is ready
        if self.fft_len > 0 {
            // We need a temporary copy of solution since convolve_forward_fft borrows &[f32]
            // but also mutates self. Use fft_output as temporary storage (it will be overwritten).
            // Actually, we can use a slice reference trick: copy solution to a temp vec.
            let solution_copy: Vec<f32> = self.solution[..n].to_vec();
            self.convolve_forward_fft(&solution_copy);
        } else {
            // Fallback to time-domain convolution for very small cases
            let k_len = self.kernel.len();
            for t in 0..n {
                let mut sum = 0.0;
                let k_max = k_len.min(t + 1);
                for k in 0..k_max {
                    sum += self.kernel[k] * self.solution[t - k];
                }
                self.reconvolution[t] = sum;
            }
        }

        // Recompute baseline at current solution
        {
            let mut sum = 0.0_f64;
            for i in 0..n {
                sum += (self.trace[i] - self.reconvolution[i]) as f64;
            }
            self.baseline = sum / n as f64;
        }

        self.reconvolution_stale = false;
    }

    // --- Bandpass filter methods ---

    pub fn set_filter_enabled(&mut self, enabled: bool) {
        self.bandpass.set_enabled(enabled);
    }

    pub fn filter_enabled(&self) -> bool {
        self.bandpass.is_enabled()
    }

    /// Apply bandpass filter to the active trace region. Returns true if filtering was applied.
    pub fn apply_filter(&mut self) -> bool {
        let n = self.active_len;
        self.bandpass.apply(&mut self.trace[..n])
    }

    /// Get the power spectrum of the current trace (N/2+1 bins).
    pub fn get_power_spectrum(&mut self) -> Vec<f32> {
        let n = self.active_len;
        if n < 8 {
            return Vec::new();
        }
        // If power spectrum is not already cached from apply(), compute it
        let spectrum = self.bandpass.get_power_spectrum(n);
        if spectrum.is_empty() {
            self.bandpass.compute_spectrum_only(&self.trace[..n]);
            self.bandpass.get_power_spectrum(n).to_vec()
        } else {
            spectrum.to_vec()
        }
    }

    /// Get frequency axis in Hz for the spectrum bins.
    pub fn get_spectrum_frequencies(&self) -> Vec<f32> {
        self.bandpass.get_spectrum_frequencies(self.active_len)
    }

    /// Get filter cutoff frequencies as [f_hp, f_lp].
    pub fn get_filter_cutoffs(&self) -> Vec<f32> {
        let c = self.bandpass.get_cutoffs();
        vec![c[0], c[1]]
    }

    /// Load warm-start state. If state is empty or wrong size, performs cold-start (zero solution).
    pub fn load_state(&mut self, state: &[u8]) {
        if state.is_empty() {
            return; // cold start -- solution already zeroed by set_trace
        }

        // Header: active_len (u32) + t_fista (f64) + iteration (u32) + baseline (f64) = 24 bytes
        if state.len() < 24 {
            return; // too small, cold start
        }

        let mut cur = Cursor::new(state);

        let saved_len = read_u32_le(&mut cur) as usize;
        let expected_size = 4 + 8 + 4 + 8 + 2 * saved_len * 4;

        if state.len() != expected_size || saved_len != self.active_len {
            return; // size mismatch, cold start
        }

        self.t_fista = read_f64_le(&mut cur);
        self.iteration = read_u32_le(&mut cur);
        self.baseline = read_f64_le(&mut cur);
        self.converged = false;
        self.prev_objective = f64::INFINITY;

        for i in 0..saved_len {
            self.solution[i] = read_f32_le(&mut cur);
        }
        for i in 0..saved_len {
            self.solution_prev[i] = read_f32_le(&mut cur);
        }
    }
}

// --- Little-endian cursor read helpers ---
// These wrap the repetitive read_exact + from_le_bytes pattern used by load_state.
// Each panics on short reads, which cannot occur when the caller has already
// validated the total buffer length (as load_state does above).

fn read_u32_le(cur: &mut Cursor<&[u8]>) -> u32 {
    let mut buf = [0u8; 4];
    cur.read_exact(&mut buf).unwrap();
    u32::from_le_bytes(buf)
}

fn read_f32_le(cur: &mut Cursor<&[u8]>) -> f32 {
    let mut buf = [0u8; 4];
    cur.read_exact(&mut buf).unwrap();
    f32::from_le_bytes(buf)
}

fn read_f64_le(cur: &mut Cursor<&[u8]>) -> f64 {
    let mut buf = [0u8; 8];
    cur.read_exact(&mut buf).unwrap();
    f64::from_le_bytes(buf)
}
