use numpy::{PyArray1, PyReadonlyArray1, PyReadonlyArray2, PyUntypedArrayMethods};
use pyo3::prelude::*;

use crate::kernel::{build_kernel, compute_lipschitz};
use crate::simulate;
use crate::{biexp_fit, indeca, kernel_est, upsample, Constraint, ConvMode, Solver};

const BATCH_SIZE: u32 = 100;
const CONTIGUOUS_ERR: &str =
    "array must be C-contiguous; call numpy.ascontiguousarray() before passing";

/// Convert a numpy f64 array to a Vec<f32>, validating contiguity.
fn to_f32_vec(arr: &PyReadonlyArray1<f64>) -> PyResult<Vec<f32>> {
    let slice = arr
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    Ok(slice.iter().map(|&v| v as f32).collect())
}

/// Convert an optional numpy f64 array to an optional Vec<f32>.
fn optional_to_f32_vec(opt: Option<PyReadonlyArray1<f64>>) -> PyResult<Option<Vec<f32>>> {
    opt.map(|w| to_f32_vec(&w)).transpose()
}

fn parse_conv_mode(s: &str) -> PyResult<ConvMode> {
    match s {
        "fft" => Ok(ConvMode::Fft),
        "banded" => Ok(ConvMode::BandedAR2),
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            "conv_mode must be 'fft' or 'banded'",
        )),
    }
}

fn parse_constraint(s: &str) -> PyResult<Constraint> {
    match s {
        "nonneg" => Ok(Constraint::NonNegative),
        "box01" => Ok(Constraint::Box01),
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            "constraint must be 'nonneg' or 'box01'",
        )),
    }
}

/// Run the solver in batches until convergence or max_iters is reached.
fn run_to_convergence(solver: &mut Solver, max_iters: u32) {
    let n_batches = max_iters.div_ceil(BATCH_SIZE);
    for _ in 0..n_batches {
        if solver.step_batch(BATCH_SIZE) {
            break;
        }
    }
}

/// Python-facing wrapper around the Rust FISTA Solver.
///
/// Exposes the same API as the WASM bindings but with numpy array I/O.
#[pyclass]
pub struct PySolver {
    inner: Solver,
}

#[pymethods]
impl PySolver {
    #[new]
    fn new() -> Self {
        PySolver {
            inner: Solver::new(),
        }
    }

    /// Set solver parameters and rebuild kernel.
    fn set_params(&mut self, tau_rise: f64, tau_decay: f64, lambda: f64, fs: f64) {
        self.inner.set_params(tau_rise, tau_decay, lambda, fs);
    }

    /// Load a trace (numpy float32 array) for deconvolution.
    fn set_trace(&mut self, trace: PyReadonlyArray1<f32>) -> PyResult<()> {
        let slice = trace
            .as_slice()
            .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
        self.inner.set_trace(slice);
        Ok(())
    }

    /// Run n FISTA iterations. Returns true if converged.
    fn step_batch(&mut self, n_steps: u32) -> bool {
        self.inner.step_batch(n_steps)
    }

    /// Run solver to convergence (up to max_iters). Returns iterations run.
    fn solve(&mut self, max_iters: u32) -> u32 {
        run_to_convergence(&mut self.inner, max_iters);
        self.inner.iteration_count()
    }

    /// Get the deconvolved activity (non-negative spike train).
    fn get_solution<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<f32>> {
        PyArray1::from_vec(py, self.inner.get_solution())
    }

    /// Get reconvolution (K*s) for the active region.
    fn get_reconvolution<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyArray1<f32>> {
        PyArray1::from_vec(py, self.inner.get_reconvolution())
    }

    /// Get reconvolution + baseline (K*s + b).
    fn get_reconvolution_with_baseline<'py>(
        &mut self,
        py: Python<'py>,
    ) -> Bound<'py, PyArray1<f32>> {
        PyArray1::from_vec(py, self.inner.get_reconvolution_with_baseline())
    }

    /// Get estimated baseline.
    fn get_baseline(&mut self) -> f64 {
        self.inner.get_baseline()
    }

    /// Get the current trace (after filtering if applied).
    fn get_trace<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<f32>> {
        PyArray1::from_vec(py, self.inner.get_trace())
    }

    /// Get the kernel.
    fn get_kernel<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<f32>> {
        PyArray1::from_vec(py, self.inner.get_kernel())
    }

    /// Check convergence.
    fn converged(&self) -> bool {
        self.inner.converged()
    }

    /// Get iteration count.
    fn iteration_count(&self) -> u32 {
        self.inner.iteration_count()
    }

    /// Apply bandpass filter to loaded trace.
    fn apply_filter(&mut self) -> bool {
        self.inner.apply_filter()
    }

    /// Subtract rolling-percentile baseline from loaded trace.
    fn subtract_baseline(&mut self) {
        self.inner.subtract_baseline();
    }

    /// Convenience: set both HP and LP filter together.
    fn set_filter_enabled(&mut self, enabled: bool) {
        self.inner.set_filter_enabled(enabled);
    }

    /// Set high-pass filter enabled/disabled.
    fn set_hp_filter_enabled(&mut self, enabled: bool) {
        self.inner.set_hp_filter_enabled(enabled);
    }

    /// Set low-pass filter enabled/disabled.
    fn set_lp_filter_enabled(&mut self, enabled: bool) {
        self.inner.set_lp_filter_enabled(enabled);
    }

    /// Check if filter is enabled (either HP or LP).
    fn filter_enabled(&self) -> bool {
        self.inner.filter_enabled()
    }

    /// Set convolution mode: "fft" or "banded".
    fn set_conv_mode(&mut self, mode: &str) -> PyResult<()> {
        self.inner.set_conv_mode(parse_conv_mode(mode)?);
        Ok(())
    }

    /// Set constraint type: "nonneg" or "box01".
    fn set_constraint(&mut self, constraint: &str) -> PyResult<()> {
        self.inner.set_constraint(parse_constraint(constraint)?);
        Ok(())
    }
}

/// Build a double-exponential calcium kernel, returned as numpy float32 array.
#[pyfunction]
fn py_build_kernel<'py>(
    py: Python<'py>,
    tau_rise: f64,
    tau_decay: f64,
    fs: f64,
) -> Bound<'py, PyArray1<f32>> {
    let kernel = build_kernel(tau_rise, tau_decay, fs);
    PyArray1::from_vec(py, kernel)
}

/// Compute Lipschitz constant for a kernel.
#[pyfunction]
fn py_compute_lipschitz(kernel: PyReadonlyArray1<f32>) -> PyResult<f64> {
    let slice = kernel
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    Ok(compute_lipschitz(slice))
}

/// Configure solver conv_mode and constraint from string args.
fn configure_solver_options(
    solver: &mut Solver,
    conv_mode: &str,
    constraint: &str,
) -> PyResult<()> {
    solver.set_conv_mode(parse_conv_mode(conv_mode)?);
    solver.set_constraint(parse_constraint(constraint)?);
    Ok(())
}

/// One-shot deconvolution for a single 1D trace.
/// Returns (activity, baseline, reconvolution, iterations, converged).
#[pyfunction]
#[pyo3(signature = (trace, fs, tau_rise, tau_decay, lambda_, hp_enabled=false, lp_enabled=false, max_iters=2000, conv_mode="fft", constraint="nonneg"))]
fn deconvolve_single<'py>(
    py: Python<'py>,
    trace: PyReadonlyArray1<f64>,
    fs: f64,
    tau_rise: f64,
    tau_decay: f64,
    lambda_: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    max_iters: u32,
    conv_mode: &str,
    constraint: &str,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>,
    f64,
    Bound<'py, PyArray1<f32>>,
    u32,
    bool,
)> {
    let mut solver = Solver::new();
    solver.set_params(tau_rise, tau_decay, lambda_, fs);
    configure_solver_options(&mut solver, conv_mode, constraint)?;

    let trace_f32 = to_f32_vec(&trace)?;
    solver.set_trace(&trace_f32);

    if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
    }

    solver.subtract_baseline();

    run_to_convergence(&mut solver, max_iters);

    Ok((
        PyArray1::from_vec(py, solver.get_solution()),
        solver.get_baseline(),
        PyArray1::from_vec(py, solver.get_reconvolution_with_baseline()),
        solver.iteration_count(),
        solver.converged(),
    ))
}

/// Batch deconvolution for a 2D array of traces (n_cells x n_timepoints).
/// Returns (activities, baselines, reconvolutions, iterations, convergeds).
#[pyfunction]
#[pyo3(signature = (traces, fs, tau_rise, tau_decay, lambda_, hp_enabled=false, lp_enabled=false, max_iters=2000, conv_mode="fft", constraint="nonneg"))]
fn deconvolve_batch<'py>(
    py: Python<'py>,
    traces: PyReadonlyArray2<f64>,
    fs: f64,
    tau_rise: f64,
    tau_decay: f64,
    lambda_: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    max_iters: u32,
    conv_mode: &str,
    constraint: &str,
) -> PyResult<(
    Vec<Bound<'py, PyArray1<f32>>>,
    Vec<f64>,
    Vec<Bound<'py, PyArray1<f32>>>,
    Vec<u32>,
    Vec<bool>,
)> {
    let shape = traces.shape();
    let n_cells = shape[0];

    let mut solver = Solver::new();
    solver.set_params(tau_rise, tau_decay, lambda_, fs);
    configure_solver_options(&mut solver, conv_mode, constraint)?;

    if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
    }

    let mut activities = Vec::with_capacity(n_cells);
    let mut baselines = Vec::with_capacity(n_cells);
    let mut reconvolutions = Vec::with_capacity(n_cells);
    let mut iterations = Vec::with_capacity(n_cells);
    let mut convergeds = Vec::with_capacity(n_cells);

    let traces_ref = traces.as_array();
    let n_timepoints = shape[1];
    let mut trace_f32: Vec<f32> = Vec::with_capacity(n_timepoints);

    for cell_idx in 0..n_cells {
        trace_f32.clear();
        trace_f32.extend(traces_ref.row(cell_idx).iter().map(|&v| v as f32));
        solver.set_trace(&trace_f32);

        if hp_enabled || lp_enabled {
            solver.apply_filter();
        }

        solver.subtract_baseline();

        run_to_convergence(&mut solver, max_iters);

        activities.push(PyArray1::from_vec(py, solver.get_solution()));
        baselines.push(solver.get_baseline());
        reconvolutions.push(PyArray1::from_vec(
            py,
            solver.get_reconvolution_with_baseline(),
        ));
        iterations.push(solver.iteration_count());
        convergeds.push(solver.converged());
    }

    Ok((
        activities,
        baselines,
        reconvolutions,
        iterations,
        convergeds,
    ))
}

/// Run peak-seeded spike detection on a single trace.
///
/// Returns (s_counts, alpha, baseline).
#[pyfunction]
fn py_seed_trace<'py>(
    py: Python<'py>,
    trace: PyReadonlyArray1<f64>,
    fs: f64,
) -> PyResult<(Bound<'py, PyArray1<f32>>, f64, f64)> {
    let trace_f32 = to_f32_vec(&trace)?;
    let result = crate::peak_seed::seed_trace(&trace_f32, fs);
    Ok((
        PyArray1::from_vec(py, result.s_counts),
        result.alpha,
        result.baseline,
    ))
}

/// Auto-estimate kernel from raw traces via peak-seeded free kernel estimation.
///
/// Takes a 2D array (n_cells x n_timepoints) and returns
/// (free_kernel, tau_rise, tau_decay, tau_rise_fast, tau_decay_fast, beta_fast, n_seed_spikes).
#[pyfunction]
fn seed_kernel_estimate<'py>(
    py: Python<'py>,
    traces: PyReadonlyArray2<f64>,
    fs: f64,
) -> PyResult<(Bound<'py, PyArray1<f32>>, f64, f64, f64, f64, f64, usize)> {
    let shape = traces.shape();
    let n_cells = shape[0];
    let n_timepoints = shape[1];

    let mut traces_flat: Vec<f32> = Vec::with_capacity(n_cells * n_timepoints);
    let mut trace_lengths: Vec<usize> = Vec::with_capacity(n_cells);

    let traces_ref = traces.as_array();
    for cell_idx in 0..n_cells {
        traces_flat.extend(traces_ref.row(cell_idx).iter().map(|&v| v as f32));
        trace_lengths.push(n_timepoints);
    }

    let result = crate::peak_seed::seed_kernel_estimate(&traces_flat, &trace_lengths, fs);

    Ok((
        PyArray1::from_vec(py, result.free_kernel),
        result.tau_rise,
        result.tau_decay,
        result.tau_rise_fast,
        result.tau_decay_fast,
        result.beta_fast,
        result.n_seed_spikes,
    ))
}

// ---------------------------------------------------------------------------
// InDeCa pipeline bindings
// ---------------------------------------------------------------------------

/// Run the full InDeCa pipeline on a single trace.
///
/// Returns (s_counts, alpha, baseline, threshold, pve, iterations, converged).
#[pyfunction]
#[pyo3(signature = (trace, tau_rise, tau_decay, fs, upsample_factor=1, max_iters=500, tol=1e-4, hp_enabled=false, lp_enabled=false, warm_counts=None, lambda_=0.0))]
fn py_indeca_solve_trace<'py>(
    py: Python<'py>,
    trace: PyReadonlyArray1<f64>,
    tau_rise: f64,
    tau_decay: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    warm_counts: Option<PyReadonlyArray1<f64>>,
    lambda_: f64,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>, // s_counts
    f64,                       // alpha
    f64,                       // baseline
    f64,                       // threshold
    f64,                       // pve
    u32,                       // iterations
    bool,                      // converged
)> {
    let trace_f32 = to_f32_vec(&trace)?;
    let warm = optional_to_f32_vec(warm_counts)?;

    let result = indeca::solve_trace(
        &trace_f32,
        tau_rise,
        tau_decay,
        fs,
        upsample_factor,
        max_iters,
        tol,
        warm.as_deref(),
        hp_enabled,
        lp_enabled,
        lambda_,
    );

    Ok((
        PyArray1::from_vec(py, result.s_counts),
        result.alpha,
        result.baseline,
        result.threshold,
        result.pve,
        result.iterations,
        result.converged,
    ))
}

/// Estimate a free-form kernel from multiple traces and their spike trains.
///
/// Returns the estimated kernel as a numpy float32 array.
#[pyfunction]
#[pyo3(signature = (traces_flat, spikes_flat, trace_lengths, alphas, baselines, kernel_length, max_iters=200, tol=1e-4, warm_kernel=None, smooth_lambda=0.0))]
fn py_indeca_estimate_kernel<'py>(
    py: Python<'py>,
    traces_flat: PyReadonlyArray1<f64>,
    spikes_flat: PyReadonlyArray1<f64>,
    trace_lengths: PyReadonlyArray1<i64>,
    alphas: PyReadonlyArray1<f64>,
    baselines: PyReadonlyArray1<f64>,
    kernel_length: usize,
    max_iters: u32,
    tol: f64,
    warm_kernel: Option<PyReadonlyArray1<f64>>,
    smooth_lambda: f64,
) -> PyResult<Bound<'py, PyArray1<f32>>> {
    let traces_f32 = to_f32_vec(&traces_flat)?;
    let spikes_f32 = to_f32_vec(&spikes_flat)?;

    let lengths_slice = trace_lengths
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    let lengths: Vec<usize> = lengths_slice.iter().map(|&v| v as usize).collect();

    let alphas_slice = alphas
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    let baselines_slice = baselines
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;

    let warm = optional_to_f32_vec(warm_kernel)?;

    let result = kernel_est::estimate_free_kernel(
        &traces_f32,
        &spikes_f32,
        alphas_slice,
        baselines_slice,
        &lengths,
        kernel_length,
        max_iters,
        tol,
        warm.as_deref(),
        smooth_lambda,
    );

    Ok(PyArray1::from_vec(py, result))
}

/// Fit a bi-exponential model to a free-form kernel.
///
/// Returns (tau_rise, tau_decay, beta, residual, tau_rise_fast, tau_decay_fast, beta_fast).
#[pyfunction]
#[pyo3(signature = (h_free, fs, refine=true, skip=0, warm_tau_rise=0.0, warm_tau_decay=0.0, warm_tau_rise_fast=0.0, warm_tau_decay_fast=0.0, warm_beta=0.0, warm_beta_fast=0.0, warm_residual=f64::INFINITY, use_warm=false))]
fn py_indeca_fit_biexponential(
    h_free: PyReadonlyArray1<f64>,
    fs: f64,
    refine: bool,
    skip: usize,
    warm_tau_rise: f64,
    warm_tau_decay: f64,
    warm_tau_rise_fast: f64,
    warm_tau_decay_fast: f64,
    warm_beta: f64,
    warm_beta_fast: f64,
    warm_residual: f64,
    use_warm: bool,
) -> PyResult<(f64, f64, f64, f64, f64, f64, f64)> {
    let h_f32 = to_f32_vec(&h_free)?;

    let warm_start = if use_warm {
        Some(biexp_fit::BiexpResult {
            tau_rise: warm_tau_rise,
            tau_decay: warm_tau_decay,
            beta: warm_beta,
            residual: warm_residual,
            tau_rise_fast: warm_tau_rise_fast,
            tau_decay_fast: warm_tau_decay_fast,
            beta_fast: warm_beta_fast,
        })
    } else {
        None
    };

    let result = biexp_fit::fit_biexponential(&h_f32, fs, refine, skip, warm_start.as_ref());

    Ok((
        result.tau_rise,
        result.tau_decay,
        result.beta,
        result.residual,
        result.tau_rise_fast,
        result.tau_decay_fast,
        result.beta_fast,
    ))
}

/// Compute the upsample factor for a given sampling rate and target rate.
#[pyfunction]
fn py_indeca_compute_upsample_factor(fs: f64, target_fs: f64) -> usize {
    upsample::compute_upsample_factor(fs, target_fs)
}

/// Generate synthetic calcium traces from a JSON config string.
///
/// Returns flat numpy arrays for efficient Python consumption:
///   (traces, spikes, clean_calcium, alphas, snrs, tau_rises, tau_decays, num_cells, num_timepoints)
#[pyfunction]
fn py_simulate_traces<'py>(
    py: Python<'py>,
    config_json: &str,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>,  // traces (flat, row-major)
    Bound<'py, PyArray1<f32>>,  // spikes (flat, row-major)
    Bound<'py, PyArray1<f32>>,  // clean_calcium (flat, row-major)
    Bound<'py, PyArray1<f64>>,  // alphas (per-cell)
    Bound<'py, PyArray1<f64>>,  // snrs (per-cell)
    Bound<'py, PyArray1<f64>>,  // tau_rises (per-cell)
    Bound<'py, PyArray1<f64>>,  // tau_decays (per-cell)
    usize,                      // num_cells
    usize,                      // num_timepoints
)> {
    let config: simulate::SimulationConfig = serde_json::from_str(config_json)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Invalid config JSON: {e}")))?;

    let result = simulate::simulate(&config);
    let n_cells = result.num_cells;
    let n_tp = result.num_timepoints;

    let mut spikes_flat = Vec::with_capacity(n_cells * n_tp);
    let mut clean_flat = Vec::with_capacity(n_cells * n_tp);
    let mut alphas = Vec::with_capacity(n_cells);
    let mut snrs = Vec::with_capacity(n_cells);
    let mut tau_rises = Vec::with_capacity(n_cells);
    let mut tau_decays = Vec::with_capacity(n_cells);

    for gt in &result.ground_truth {
        spikes_flat.extend_from_slice(&gt.spikes);
        clean_flat.extend_from_slice(&gt.clean_calcium);
        alphas.push(gt.alpha);
        snrs.push(gt.snr);
        tau_rises.push(gt.tau_rise_s);
        tau_decays.push(gt.tau_decay_s);
    }

    Ok((
        PyArray1::from_vec(py, result.traces),
        PyArray1::from_vec(py, spikes_flat),
        PyArray1::from_vec(py, clean_flat),
        PyArray1::from_vec(py, alphas),
        PyArray1::from_vec(py, snrs),
        PyArray1::from_vec(py, tau_rises),
        PyArray1::from_vec(py, tau_decays),
        n_cells,
        n_tp,
    ))
}

/// Register the Python module.
/// The function name must match the leaf of module-name in pyproject.toml: "calab._solver" → "_solver".
#[pymodule]
fn _solver(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PySolver>()?;
    m.add_function(wrap_pyfunction!(py_build_kernel, m)?)?;
    m.add_function(wrap_pyfunction!(py_compute_lipschitz, m)?)?;
    m.add_function(wrap_pyfunction!(deconvolve_single, m)?)?;
    m.add_function(wrap_pyfunction!(deconvolve_batch, m)?)?;
    m.add_function(wrap_pyfunction!(py_seed_trace, m)?)?;
    m.add_function(wrap_pyfunction!(seed_kernel_estimate, m)?)?;
    // InDeCa pipeline
    m.add_function(wrap_pyfunction!(py_indeca_solve_trace, m)?)?;
    m.add_function(wrap_pyfunction!(py_indeca_estimate_kernel, m)?)?;
    m.add_function(wrap_pyfunction!(py_indeca_fit_biexponential, m)?)?;
    m.add_function(wrap_pyfunction!(py_indeca_compute_upsample_factor, m)?)?;
    // Simulation
    m.add_function(wrap_pyfunction!(py_simulate_traces, m)?)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
