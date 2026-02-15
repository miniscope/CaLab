mod kernel;
mod fista;
mod filter;

use kernel::{build_kernel, compute_lipschitz};
use filter::BandpassFilter;
use wasm_bindgen::prelude::*;

/// FISTA solver for calcium deconvolution.
///
/// Minimizes (1/2)||y - K*s||^2 + lambda*||s||_1 subject to s >= 0,
/// where K is the convolution matrix derived from a double-exponential kernel.
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

    // Bandpass filter
    bandpass: BandpassFilter,
}

#[wasm_bindgen]
impl Solver {
    /// Create a new Solver with default parameters.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Solver {
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
            bandpass: BandpassFilter::new(),
        };

        // Build kernel with default params
        solver.kernel = build_kernel(solver.tau_rise, solver.tau_decay, solver.fs);
        solver.lipschitz_constant = compute_lipschitz(&solver.kernel);

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
        self.bandpass.update_cutoffs(tau_rise, tau_decay, fs);
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
        self.trace[..trace.len()].copy_from_slice(trace);
        for i in 0..trace.len() {
            self.solution[i] = 0.0;
            self.solution_prev[i] = 0.0;
            self.gradient[i] = 0.0;
            self.reconvolution[i] = 0.0;
            self.residual_buf[i] = 0.0;
        }

        // Reset iteration state
        self.iteration = 0;
        self.t_fista = 1.0;
        self.converged = false;
        self.prev_objective = f64::INFINITY;
    }

    /// Returns a copy of the current solution (spike train) for the active region.
    pub fn get_solution(&self) -> Vec<f32> {
        self.solution[..self.active_len].to_vec()
    }

    /// Returns a copy of the reconvolution (K * solution) for the active region.
    pub fn get_reconvolution(&self) -> Vec<f32> {
        self.reconvolution[..self.active_len].to_vec()
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

    /// Serialize solver state for warm-start cache.
    /// Format: [active_len (u32)] [t_fista (f64)] [iteration (u32)] [solution f32...] [solution_prev f32...]
    pub fn export_state(&self) -> Vec<u8> {
        let n = self.active_len;
        // 4 bytes active_len + 8 bytes t_fista + 4 bytes iteration + 2*n*4 bytes solutions (f32)
        let mut buf = Vec::with_capacity(4 + 8 + 4 + 2 * n * 4);

        buf.extend_from_slice(&(n as u32).to_le_bytes());
        buf.extend_from_slice(&self.t_fista.to_le_bytes());
        buf.extend_from_slice(&self.iteration.to_le_bytes());

        for i in 0..n {
            buf.extend_from_slice(&self.solution[i].to_le_bytes());
        }
        for i in 0..n {
            buf.extend_from_slice(&self.solution_prev[i].to_le_bytes());
        }

        buf
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

        // Read header: active_len (u32)
        if state.len() < 16 {
            return; // too small, cold start
        }

        let saved_len = u32::from_le_bytes([state[0], state[1], state[2], state[3]]) as usize;
        let expected_size = 4 + 8 + 4 + 2 * saved_len * 4; // f32: 4 bytes per element

        if state.len() != expected_size || saved_len != self.active_len {
            return; // size mismatch, cold start
        }

        // Read t_fista and iteration
        self.t_fista = f64::from_le_bytes([
            state[4], state[5], state[6], state[7], state[8], state[9], state[10], state[11],
        ]);
        self.iteration = u32::from_le_bytes([state[12], state[13], state[14], state[15]]);
        self.converged = false;
        self.prev_objective = f64::INFINITY;

        // Read solution and solution_prev (f32: 4 bytes each)
        let mut offset = 16;
        for i in 0..saved_len {
            let bytes = [
                state[offset],
                state[offset + 1],
                state[offset + 2],
                state[offset + 3],
            ];
            self.solution[i] = f32::from_le_bytes(bytes);
            offset += 4;
        }
        for i in 0..saved_len {
            let bytes = [
                state[offset],
                state[offset + 1],
                state[offset + 2],
                state[offset + 3],
            ];
            self.solution_prev[i] = f32::from_le_bytes(bytes);
            offset += 4;
        }
    }
}
