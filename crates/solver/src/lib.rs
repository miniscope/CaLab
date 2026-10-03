mod banded;
pub(crate) mod baseline;
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
pub(crate) mod peak_seed;
pub(crate) mod simulate;
#[allow(dead_code)]
pub(crate) mod threshold;
#[allow(dead_code)]
pub(crate) mod upsample;
pub(crate) mod validate;

pub use validate::SolverError;

/// The solver's version: the one number shared by the WASM build
/// (`solver_version()`), the native extension (`calab._solver.__version__` and
/// `calab._solver.protocol_version()`), and the Python bridge's version
/// handshake.
///
/// Sourced from `version` in this crate's Cargo.toml, so there is exactly one
/// place to bump. Semver, read with Cargo's caret rules: bump the major (the
/// minor while still `0.x`) when the same inputs no longer produce results a
/// consumer of the previous version can accept as equivalent; bump the minor
/// (the patch while `0.x`) for compatible changes. The Python bridge rejects a
/// result produced by an incompatible solver and warns on compatible drift.
pub const SOLVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// WASM export of [`SOLVER_VERSION`], so the web apps can report which solver
/// produced a result.
#[cfg(feature = "jsbindings")]
#[wasm_bindgen]
pub fn solver_version() -> String {
    SOLVER_VERSION.to_string()
}

#[cfg(test)]
mod version_tests {
    use super::SOLVER_VERSION;

    /// `version = "..."` from the `[package]` table of this crate's Cargo.toml.
    fn cargo_toml_package_version() -> String {
        let manifest = include_str!("../Cargo.toml");
        let mut in_package = false;
        for line in manifest.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_package = line == "[package]";
                continue;
            }
            if in_package {
                if let Some(rest) = line.strip_prefix("version") {
                    let value = rest.trim_start().trim_start_matches('=').trim();
                    return value.trim_matches('"').to_string();
                }
            }
        }
        panic!("no version in the [package] table of Cargo.toml");
    }

    #[test]
    fn solver_version_matches_cargo_toml() {
        assert_eq!(SOLVER_VERSION, cargo_toml_package_version());
    }

    #[test]
    fn solver_version_is_plain_semver() {
        // The Python handshake parses MAJOR.MINOR.PATCH; keep it parseable.
        let parts: Vec<&str> = SOLVER_VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "expected MAJOR.MINOR.PATCH, got {SOLVER_VERSION}"
        );
        for part in parts {
            assert!(
                part.parse::<u64>().is_ok(),
                "non-numeric component in {SOLVER_VERSION}"
            );
        }
    }

    #[cfg(feature = "jsbindings")]
    #[test]
    fn wasm_export_returns_solver_version() {
        assert_eq!(super::solver_version(), SOLVER_VERSION);
    }
}

#[cfg(test)]
mod degenerate_tests;

#[cfg(feature = "pybindings")]
mod py_api;

#[cfg(feature = "jsbindings")]
mod js_indeca;
#[cfg(feature = "jsbindings")]
mod js_simulate;

use banded::BandedAR2;
use filter::BandpassFilter;
use kernel::{build_kernel, compute_lipschitz};
use std::io::{Cursor, Read};

#[cfg(feature = "jsbindings")]
use wasm_bindgen::prelude::*;

/// Index of the first non-finite (NaN or ±infinity) value in `data`, if any.
///
/// Used by the FFI boundaries (PyO3 / WASM) to reject non-finite input traces
/// up front. A NaN would otherwise propagate silently — e.g. `total_cmp` sorts
/// NaN last, corrupting the rolling-baseline percentile — and yield garbage
/// alpha/PVE results that are indistinguishable from a legitimately hard trace.
pub(crate) fn first_nonfinite(data: &[f32]) -> Option<usize> {
    data.iter().position(|v| !v.is_finite())
}

/// EMA weight for the displayed scalar baseline. The per-iteration raw baseline
/// is smoothed as `ema = W·raw + (1-W)·ema` purely to keep the displayed value
/// steady across iterations; it does not enter the solve. Named here so the
/// smoothing strength is a single, documented knob rather than a bare literal.
const BASELINE_EMA_WEIGHT: f64 = 0.3;

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
    /// clamp(z - threshold, 0, 1) — box constraint [0, 1] with the same
    /// L1 shrinkage (`step · lambda · G_dc`) as `NonNegative`. With
    /// `lambda = 0` (what `indeca::solve_bounded` uses) this is exactly the
    /// unpenalized box constraint of InDeCa Eq. 3; CaDecon passes a non-zero
    /// lambda to add sparsity on top of the box.
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
    /// Scalar baseline `b` that enters the FISTA residual. Written ONLY by
    /// `step_batch` (and reset by `set_trace`); display getters never touch it,
    /// so polling the fit mid-solve cannot change the optimization. When the
    /// trace is `filtered` the solver treats `b` as 0 regardless of this value.
    pub(crate) baseline: f64,
    /// Display-only EMA of the raw baseline `mean(trace - K*s)`. Read by
    /// `get_baseline` / `get_reconvolution_with_baseline`; never read by the solver.
    baseline_ema: f64,
    baseline_ema_init: bool,
    kernel_dc_gain: f64,

    // Convolution engines
    pub(crate) fft: fft::FftConvolver,
    pub(crate) banded: BandedAR2,
    pub(crate) conv_mode: ConvMode,
    pub(crate) constraint: Constraint,
    pub(crate) reconvolution_stale: bool, // dirty flag for lazy reconvolution
    /// Kernel changed since the FFT kernel spectrum was last computed.
    fft_kernel_stale: bool,
    /// Last FFT setup failure, if any; cleared by a later successful setup.
    /// Setup runs eagerly from infallible setters, so the error is reported by
    /// the next `step_batch` instead of being lost.
    fft_setup_error: Option<SolverError>,

    // Bandpass filter
    bandpass: BandpassFilter,
    pub(crate) filtered: bool, // true after apply_filter() succeeded on current trace
}

#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
impl Solver {
    /// Create a new Solver with default parameters.
    #[cfg_attr(feature = "jsbindings", wasm_bindgen(constructor))]
    #[allow(clippy::new_without_default)] // wasm_bindgen constructor — JS `new Solver()` is the public API
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
            fft_kernel_stale: true,
            fft_setup_error: None,
            bandpass: BandpassFilter::new(),
            filtered: false,
        };

        // Build kernel with default params
        solver.kernel = build_kernel(solver.tau_rise, solver.tau_decay, solver.fs);
        solver.lipschitz_constant = compute_lipschitz(&solver.kernel);
        solver.kernel_dc_gain = solver.kernel.iter().map(|&k| k as f64).sum();

        solver
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
        match mode {
            ConvMode::BandedAR2 => {
                // Ensure banded coefficients are current (may have been skipped in set_params)
                self.banded.update(self.tau_rise, self.tau_decay, self.fs);
            }
            ConvMode::Fft => {
                // Ensure FFT buffers exist (and the kernel spectrum is current —
                // params may have changed while in banded mode).
                self.fft_setup_error = self.sync_fft_exact().err();
            }
        }
        self.lipschitz_constant = self.current_lipschitz();
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
        let mut buf = Vec::with_capacity(state_byte_len(n));

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

        let fft_ok = self.conv_mode == ConvMode::Fft
            && self.ensure_fft_ready().is_ok()
            && self
                .fft
                .convolve_forward(&self.solution[..n], n, &mut self.reconvolution[..n])
                .is_ok();
        if self.conv_mode == ConvMode::BandedAR2 {
            self.banded
                .convolve_forward(&self.solution[..n], &mut self.reconvolution[..n]);
        } else if !fft_ok {
            // Time-domain fallback: the display path must not fail, so if the
            // FFT engine is unusable (step_batch reports that error) or the
            // trace is tiny, convolve directly.
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

        // Recompute baseline at current solution for display alignment.
        // In step_batch, baseline is skipped when filtered (cancels in gradient),
        // but the display path always needs it to align fit with trace.
        // This only feeds the display EMA — it must NOT write `self.baseline`,
        // which step_batch consumes (see `baseline` field docs).
        let raw = compute_raw_baseline(&self.trace[..n], &self.reconvolution[..n], n);
        self.update_display_baseline(raw);

        self.reconvolution_stale = false;
    }

    /// Fold a raw baseline estimate into the display-only EMA.
    /// Called by both `step_batch` (per-iteration) and `compute_reconvolution`
    /// (lazy display path). Never touches the solver's `baseline`.
    pub(crate) fn update_display_baseline(&mut self, raw_baseline: f64) {
        if !self.baseline_ema_init {
            self.baseline_ema = raw_baseline;
            self.baseline_ema_init = true;
        } else {
            self.baseline_ema = BASELINE_EMA_WEIGHT * raw_baseline
                + (1.0 - BASELINE_EMA_WEIGHT) * self.baseline_ema;
        }
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
            self.baseline = 0.0;
        }
        applied
    }

    /// Subtract a rolling-percentile baseline from the active trace.
    ///
    /// Brings the trace floor to ~0, removing slow baseline drift while
    /// preserving positive-going calcium transients. After subtraction the
    /// baseline is ~0 so FISTA baseline estimation can be skipped (same
    /// rationale as when HP removes DC).
    pub fn subtract_baseline(&mut self) {
        let n = self.active_len;
        if n == 0 {
            return;
        }
        let window = baseline::baseline_window(self.tau_decay, self.fs);
        baseline::subtract_rolling_baseline(
            &mut self.trace[..n],
            window,
            baseline::DEFAULT_BASELINE_QUANTILE,
        );
        self.filtered = true;
        self.baseline = 0.0;
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
        self.bandpass.get_cutoffs().to_vec()
    }

    /// Load warm-start state. If state is empty or wrong size, performs cold-start (zero solution).
    ///
    /// The serialized baseline is restored only for unfiltered traces; when
    /// the trace is `filtered` the solver's baseline is pinned to 0, so a
    /// warm start continues exactly like the solve that produced the state.
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
        let expected_size = state_byte_len(saved_len);

        if state.len() != expected_size || saved_len != self.active_len {
            return; // size mismatch, cold start
        }

        self.t_fista = read_f64_le(&mut cur);
        self.iteration = read_u32_le(&mut cur);
        let saved_baseline = read_f64_le(&mut cur);
        self.baseline = if self.filtered { 0.0 } else { saved_baseline };
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

/// Rust-native, validated entry points. The `jsbindings` wrappers below and the
/// Python bindings both go through these, so both FFIs reject the same inputs.
impl Solver {
    /// Validate and apply solver parameters, rebuilding the kernel.
    ///
    /// Rejects `fs <= 0`, `tau_rise >= tau_decay`, negative `lambda`, any
    /// non-finite value, and kernels longer than [`validate::MAX_KERNEL_LEN`]
    /// (see [`validate::validate_params`]). On error the solver is unchanged.
    pub fn set_params(
        &mut self,
        tau_rise: f64,
        tau_decay: f64,
        lambda: f64,
        fs: f64,
    ) -> Result<(), SolverError> {
        validate::validate_params(tau_rise, tau_decay, lambda, fs)?;
        self.apply_params(tau_rise, tau_decay, lambda, fs);
        Ok(())
    }

    /// Validate and load a trace for deconvolution (see [`Solver::load_trace`]).
    /// Rejects non-finite samples, which would otherwise poison the FFT.
    pub fn set_trace(&mut self, trace: &[f32]) -> Result<(), SolverError> {
        validate::validate_finite_f32("trace", trace)?;
        self.load_trace(trace);
        Ok(())
    }

    /// Apply parameters without validation. Callers must have validated them
    /// (internal pipelines whose public entry point already did).
    pub(crate) fn apply_params(&mut self, tau_rise: f64, tau_decay: f64, lambda: f64, fs: f64) {
        self.tau_rise = tau_rise;
        self.tau_decay = tau_decay;
        self.lambda = lambda;
        self.fs = fs;
        self.kernel = build_kernel(tau_rise, tau_decay, fs);
        self.kernel_dc_gain = self.kernel.iter().map(|&k| k as f64).sum();
        self.bandpass.update_cutoffs(tau_rise, tau_decay, fs);
        self.fft_kernel_stale = true;

        // Update convolution engines (only the active one + compute Lipschitz)
        match self.conv_mode {
            ConvMode::BandedAR2 => {
                self.banded.update(tau_rise, tau_decay, fs);
            }
            ConvMode::Fft => {
                // banded will be updated lazily if conv_mode switches
            }
        }
        self.lipschitz_constant = self.current_lipschitz();

        // Update the kernel FFT now if a trace is loaded. If the existing FFT
        // buffers are large enough they are reused (on re-enqueue quanta with
        // unchanged trace length this avoids a plan + buffer rebuild);
        // otherwise they are rebuilt for the longer kernel. (Previously the
        // too-short case only invalidated the plan, and the next step_batch
        // panicked slicing a zero-length FFT buffer.)
        self.fft_setup_error = self.ensure_fft_ready().err();
    }

    /// Load a trace without validation. Grows buffers if needed (never shrinks).
    /// Resets iteration state for a fresh solve.
    pub(crate) fn load_trace(&mut self, trace: &[f32]) {
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
        self.fft_setup_error = self.sync_fft_exact().err();
    }

    /// Size the FFT buffers exactly for the active trace + kernel and make sure
    /// the kernel spectrum is current. No-op outside FFT mode or without a trace.
    fn sync_fft_exact(&mut self) -> Result<(), SolverError> {
        if self.conv_mode != ConvMode::Fft || self.active_len == 0 {
            return Ok(());
        }
        let len_before = self.fft.fft_len();
        self.fft.ensure_buffers(self.active_len, &self.kernel)?;
        // ensure_buffers recomputes the kernel spectrum only when it re-plans.
        if self.fft_kernel_stale && self.fft.fft_len() == len_before {
            self.fft.prepare_kernel(&self.kernel)?;
        }
        self.fft_kernel_stale = false;
        Ok(())
    }

    /// Make the FFT engine usable for the current trace and kernel, reusing
    /// existing buffers when they are large enough. Called eagerly by setters
    /// and defensively at the top of `step_batch`.
    pub(crate) fn ensure_fft_ready(&mut self) -> Result<(), SolverError> {
        if self.conv_mode != ConvMode::Fft || self.active_len == 0 {
            return Ok(());
        }
        let min_len = self
            .active_len
            .checked_add(self.kernel.len().saturating_sub(1))
            .ok_or_else(|| SolverError::InvalidInput("trace + kernel length overflows".into()))?;
        let fft_len = self.fft.fft_len();
        let result = if fft_len == 0 || fft_len < min_len || self.fft_setup_error.is_some() {
            self.sync_fft_exact()
        } else if self.fft_kernel_stale {
            let r = self.fft.prepare_kernel(&self.kernel);
            if r.is_ok() {
                self.fft_kernel_stale = false;
            }
            r
        } else {
            Ok(())
        };
        self.fft_setup_error = result.clone().err();
        result
    }
}

/// WASM exports of the validated entry points. Errors surface in JS as a
/// thrown `Error` carrying the `SolverError` message, instead of a WASM trap
/// (which would leave the worker's module unusable).
#[cfg(feature = "jsbindings")]
#[wasm_bindgen]
impl Solver {
    /// Update solver parameters and rebuild kernel. Throws on invalid parameters.
    #[wasm_bindgen(js_name = set_params)]
    pub fn js_set_params(
        &mut self,
        tau_rise: f64,
        tau_decay: f64,
        lambda: f64,
        fs: f64,
    ) -> Result<(), JsError> {
        Ok(self.set_params(tau_rise, tau_decay, lambda, fs)?)
    }

    /// Load a trace for deconvolution. Throws if it contains NaN/infinity.
    #[wasm_bindgen(js_name = set_trace)]
    pub fn js_set_trace(&mut self, trace: &[f32]) -> Result<(), JsError> {
        Ok(self.set_trace(trace)?)
    }

    /// Run n_steps of FISTA iterations. Returns true if converged.
    /// Throws on a numerical failure instead of trapping.
    #[wasm_bindgen(js_name = step_batch)]
    pub fn js_step_batch(&mut self, n_steps: u32) -> Result<bool, JsError> {
        Ok(self.step_batch(n_steps)?)
    }
}

/// Compute the mean residual (trace - reconvolution) as the raw baseline estimate.
pub(crate) fn compute_raw_baseline(trace: &[f32], reconvolution: &[f32], n: usize) -> f64 {
    let mut sum = 0.0_f64;
    for i in 0..n {
        sum += (trace[i] - reconvolution[i]) as f64;
    }
    sum / n as f64
}

/// Byte length of serialized solver state for a trace of length `n`.
fn state_byte_len(n: usize) -> usize {
    4 + 8 + 4 + 8 + 2 * n * 4 // u32 + f64 + u32 + f64 + 2×n×f32
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

#[cfg(test)]
mod finite_guard_tests {
    use super::first_nonfinite;

    #[test]
    fn clean_slice_has_no_nonfinite() {
        assert_eq!(first_nonfinite(&[0.0, 1.5, -2.0, 3.0]), None);
        assert_eq!(first_nonfinite(&[]), None);
    }

    #[test]
    fn detects_nan_and_inf_at_first_index() {
        assert_eq!(first_nonfinite(&[0.0, 1.0, f32::NAN, 3.0]), Some(2));
        assert_eq!(first_nonfinite(&[f32::INFINITY, 1.0]), Some(0));
        assert_eq!(first_nonfinite(&[1.0, 2.0, f32::NEG_INFINITY]), Some(2));
    }
}
