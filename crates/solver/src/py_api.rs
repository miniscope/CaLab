use numpy::{PyArray1, PyReadonlyArray1, PyReadonlyArray2, PyUntypedArrayMethods};
use pyo3::prelude::*;

use crate::kernel::{build_kernel, compute_lipschitz};
use crate::{Constraint, ConvMode, Solver};

const BATCH_SIZE: u32 = 100;
const CONTIGUOUS_ERR: &str =
    "array must be C-contiguous; call numpy.ascontiguousarray() before passing";

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
        let slice = trace.as_slice().map_err(|_| {
            pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR)
        })?;
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
    let slice = kernel.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR)
    })?;
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

    let slice = trace.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR)
    })?;
    let trace_f32: Vec<f32> = slice.iter().map(|&v| v as f32).collect();
    solver.set_trace(&trace_f32);

    if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
        solver.apply_filter();
    }

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

/// Register the Python module.
/// The function name must match the leaf of module-name in pyproject.toml: "calab._solver" → "_solver".
#[pymodule]
fn _solver(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PySolver>()?;
    m.add_function(wrap_pyfunction!(py_build_kernel, m)?)?;
    m.add_function(wrap_pyfunction!(py_compute_lipschitz, m)?)?;
    m.add_function(wrap_pyfunction!(deconvolve_single, m)?)?;
    m.add_function(wrap_pyfunction!(deconvolve_batch, m)?)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
