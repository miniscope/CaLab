mod banded;
#[allow(dead_code)]
pub(crate) mod biexp_fit;
mod fft;
mod filter;
mod fista;
#[allow(dead_code)]
pub(crate) mod indeca;
mod kernel;
#[allow(dead_code)]
pub(crate) mod kernel_est;
#[allow(dead_code)]
pub(crate) mod threshold;
#[allow(dead_code)]
pub(crate) mod upsample;

#[cfg(feature = "pybindings")]
mod py_api;

#[cfg(feature = "jsbindings")]
mod js_indeca;

use banded::BandedAR2;
use filter::BandpassFilter;
use kernel::{build_kernel, compute_lipschitz};
use std::io::{Cursor, Read};

#[cfg(feature = "jsbindings")]
use wasm_bindgen::prelude::*;

/// Convolution mode for forward/adjoint operations in FISTA.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
pub enum ConvMode {
    /// FFT-based O(T log T) per call — the original implementation.
    Fft = 0,
    /// Banded AR(2) recursion O(T) per call — faster for long traces.
    BandedAR2 = 1,
}

/// Constraint type for the proximal step.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
pub enum Constraint {
    /// Current: max(0, z - threshold) — L1 + non-negativity.
    NonNegative = 0,
    /// InDeCa Eq. 3: clamp(z, 0, 1) — box constraint, no L1 penalty.
    Box01 = 1,
}

/// FISTA solver for calcium deconvolution.
///
/// Minimizes (1/2)||y - K*s - b||^2 + lambda*G_dc*||s||_1 subject to s >= 0,
/// where K is the convolution matrix derived from a double-exponential kernel,
/// b is a scalar baseline estimated jointly, and G_dc = sum(K) scales lambda
/// so the sparsity slider is effective across all kernel configurations.
///
/// Pre-allocated buffers grow but never shrink to prevent WASM memory fragmentation.
#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
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
    baseline_ema: f64,
    baseline_ema_init: bool,
    kernel_dc_gain: f64,

    // Convolution engines
    pub(crate) fft: fft::FftConvolver,
    pub(crate) banded: BandedAR2,
    pub(crate) conv_mode: ConvMode,
    pub(crate) constraint: Constraint,
    pub(crate) reconvolution_stale: bool, // dirty flag for lazy reconvolution

    // Bandpass filter
    bandpass: BandpassFilter,
    pub(crate) filtered: bool, // true after apply_filter() succeeded on current trace
}

#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
impl Solver {
    /// Create a new Solver with default parameters.
    #[cfg_attr(feature = "jsbindings", wasm_bindgen(constructor))]
    pub fn new() -> Solver {
        #[cfg(all(feature = "jsbindings", target_arch = "wasm32"))]
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
            tolerance: 1e-4,
            lipschitz_constant: 1.0,
            baseline: 0.0,
            baseline_ema: 0.0,
            baseline_ema_init: false,
            kernel_dc_gain: 1.0,
            fft: fft::FftConvolver::new(),
            banded: BandedAR2::new(0.02, 0.4, 30.0),
            conv_mode: ConvMode::Fft,
            constraint: Constraint::NonNegative,
            reconvolution_stale: true,
            bandpass: BandpassFilter::new(),
            filtered: false,
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
        self.kernel_dc_gain = self.kernel.iter().map(|&k| k as f64).sum();
        self.bandpass.update_cutoffs(tau_rise, tau_decay, fs);

        // Update both convolution engines
        self.banded.update(tau_rise, tau_decay, fs);
        self.lipschitz_constant = self.current_lipschitz();

        // Update kernel FFT if buffers are already set up and large enough.
        // On re-enqueue quanta with unchanged trace length, this avoids a full
        // FFT plan + buffer rebuild in ensure_buffers.
        if self.conv_mode == ConvMode::Fft && self.fft.fft_len() > 0 && self.active_len > 0 {
            let min_len = self.active_len + self.kernel.len() - 1;
            if min_len <= self.fft.fft_len() {
                self.fft.prepare_kernel(&self.kernel);
            } else {
                self.fft.invalidate();
            }
        }
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
        self.baseline_ema = 0.0;
        self.baseline_ema_init = false;
        self.filtered = false;
        self.reconvolution_stale = true;

        // Prepare FFT infrastructure for this trace length (skip if using banded mode)
        if self.conv_mode == ConvMode::Fft {
            self.fft.ensure_buffers(self.active_len, &self.kernel);
        }
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
        let b = self.baseline_ema as f32;
        self.reconvolution[..self.active_len]
            .iter()
            .map(|&v| v + b)
            .collect()
    }

    /// Returns the estimated scalar baseline (EMA-smoothed for stable display).
    /// Lazily computes reconvolution if stale, to ensure the EMA is up to date.
    pub fn get_baseline(&mut self) -> f64 {
        if self.reconvolution_stale {
            self.compute_reconvolution();
        }
        self.baseline_ema
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

    /// Set the convolution mode (FFT or BandedAR2).
    /// Recomputes the Lipschitz constant for the selected mode.
    /// Does NOT reset solution/iteration state — warm-start is preserved.
    pub fn set_conv_mode(&mut self, mode: ConvMode) {
        self.conv_mode = mode;
        self.lipschitz_constant = self.current_lipschitz();
        // Ensure FFT buffers exist if switching to FFT mode with an active trace
        if mode == ConvMode::Fft && self.active_len > 0 {
            self.fft.ensure_buffers(self.active_len, &self.kernel);
        }
    }

    /// Set the constraint type (NonNegative or Box01).
    pub fn set_constraint(&mut self, c: Constraint) {
        self.constraint = c;
    }

    /// Lipschitz constant for the current convolution mode.
    fn current_lipschitz(&self) -> f64 {
        match self.conv_mode {
            ConvMode::Fft => compute_lipschitz(&self.kernel),
            ConvMode::BandedAR2 => self.banded.lipschitz(),
        }
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

    /// Compute reconvolution (K * solution) on demand for getters.
    /// Called lazily when get_reconvolution() or get_reconvolution_with_baseline() is invoked
    /// and reconvolution_stale is true.
    fn compute_reconvolution(&mut self) {
        let n = self.active_len;
        if n == 0 {
            return;
        }

        match self.conv_mode {
            ConvMode::BandedAR2 => {
                self.banded
                    .convolve_forward(&self.solution[..n], &mut self.reconvolution[..n]);
            }
            ConvMode::Fft if self.fft.fft_len() > 0 => {
                self.fft
                    .convolve_forward(&self.solution[..n], n, &mut self.reconvolution[..n]);
            }
            _ => {
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
        }

        // Recompute baseline at current solution for display alignment.
        // In step_batch, baseline is skipped when filtered (cancels in gradient),
        // but the display path always needs it to align fit with trace.
        {
            let mut sum = 0.0_f64;
            for i in 0..n {
                sum += (self.trace[i] - self.reconvolution[i]) as f64;
            }
            let raw_baseline = sum / n as f64;
            self.baseline = raw_baseline;

            // EMA smoothing for display (damps momentum-induced oscillation)
            if !self.baseline_ema_init {
                self.baseline_ema = raw_baseline;
                self.baseline_ema_init = true;
            } else {
                self.baseline_ema = 0.3 * raw_baseline + 0.7 * self.baseline_ema;
            }
        }

        self.reconvolution_stale = false;
    }

    // --- Bandpass filter methods ---

    /// Convenience: set both HP and LP together (used by CaTune's single toggle).
    pub fn set_filter_enabled(&mut self, enabled: bool) {
        self.bandpass.set_enabled(enabled);
    }

    pub fn set_hp_filter_enabled(&mut self, enabled: bool) {
        self.bandpass.set_hp_enabled(enabled);
    }

    pub fn set_lp_filter_enabled(&mut self, enabled: bool) {
        self.bandpass.set_lp_enabled(enabled);
    }

    pub fn filter_enabled(&self) -> bool {
        self.bandpass.is_enabled()
    }

    /// Apply bandpass filter to the active trace region. Returns true if filtering was applied.
    ///
    /// Sets `self.filtered = true` only when HP is active, because HP removes DC and
    /// baseline estimation should be skipped. LP-only preserves DC, so baseline
    /// estimation must still run.
    pub fn apply_filter(&mut self) -> bool {
        let n = self.active_len;
        let applied = self.bandpass.apply(&mut self.trace[..n]);
        if applied && self.bandpass.is_hp_enabled() {
            self.filtered = true;
        }
        applied
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
