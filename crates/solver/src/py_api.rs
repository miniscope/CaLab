use numpy::{PyArray1, PyReadonlyArray1, PyReadonlyArray2, PyUntypedArrayMethods};
use pyo3::prelude::*;

use crate::kernel::{build_kernel, compute_lipschitz};
use crate::simulate;
use crate::validate;
use crate::{biexp_fit, indeca, kernel_est, Constraint, ConvMode, Solver, SolverError};

/// Iterations per `Solver::step_batch` call in the Python solve loops. The
/// f32 `Solver` tests its stop rule (the relative-step tolerance) at every
/// iteration and returns `true` from the batch it converges in, so this only
/// sets how often control returns to Rust's loop between batches (and how
/// far `max_iters` is rounded up to whole batches); the solution does not
/// depend on it. That is not the same thing as `native_solve::BATCH` (50),
/// the interval between the native InDeCa solve's certificate checks, where
/// the stop is tested only at batch boundaries and the output does depend
/// on the granularity (its derivation is there).
const BATCH_SIZE: u32 = 100;
const CONTIGUOUS_ERR: &str =
    "array must be C-contiguous; call numpy.ascontiguousarray() before passing";

const NONFINITE_ERR: &str = "input array contains a non-finite value (NaN or infinity)";

/// Map a core validation/numerical error to the matching Python exception:
/// bad parameters or inputs raise `ValueError`, numerical failures `RuntimeError`.
fn py_err(e: SolverError) -> PyErr {
    match e {
        SolverError::InvalidParams(_) | SolverError::InvalidInput(_) => {
            pyo3::exceptions::PyValueError::new_err(e.to_string())
        }
        SolverError::Numerical(_) => pyo3::exceptions::PyRuntimeError::new_err(e.to_string()),
    }
}

/// Convert a numpy f64 array to a Vec<f32>, validating contiguity and finiteness.
fn to_f32_vec(arr: &PyReadonlyArray1<f64>) -> PyResult<Vec<f32>> {
    let slice = arr
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    let v: Vec<f32> = slice.iter().map(|&x| x as f32).collect();
    if let Some(i) = crate::first_nonfinite(&v) {
        return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "{NONFINITE_ERR} at index {i}"
        )));
    }
    Ok(v)
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
fn run_to_convergence(solver: &mut Solver, max_iters: u32) -> PyResult<()> {
    let n_batches = max_iters.div_ceil(BATCH_SIZE);
    for _ in 0..n_batches {
        if solver.step_batch(BATCH_SIZE).map_err(py_err)? {
            break;
        }
    }
    Ok(())
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
    ///
    /// Raises ValueError unless fs > 0, 0 < tau_rise < tau_decay, lambda >= 0
    /// (all finite) and the implied kernel is within the length cap.
    fn set_params(&mut self, tau_rise: f64, tau_decay: f64, lambda: f64, fs: f64) -> PyResult<()> {
        self.inner
            .set_params(tau_rise, tau_decay, lambda, fs)
            .map_err(py_err)
    }

    /// Load a trace (numpy float32 array) for deconvolution.
    fn set_trace(&mut self, trace: PyReadonlyArray1<f32>) -> PyResult<()> {
        let slice = trace
            .as_slice()
            .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
        self.inner.set_trace(slice).map_err(py_err)
    }

    /// Run n FISTA iterations. Returns true if converged.
    fn step_batch(&mut self, n_steps: u32) -> PyResult<bool> {
        self.inner.step_batch(n_steps).map_err(py_err)
    }

    /// Run solver to convergence (up to max_iters). Returns iterations run.
    fn solve(&mut self, max_iters: u32) -> PyResult<u32> {
        run_to_convergence(&mut self.inner, max_iters)?;
        Ok(self.inner.iteration_count())
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
) -> PyResult<Bound<'py, PyArray1<f32>>> {
    validate::validate_params(tau_rise, tau_decay, 0.0, fs).map_err(py_err)?;
    let kernel = build_kernel(tau_rise, tau_decay, fs);
    Ok(PyArray1::from_vec(py, kernel))
}

/// Compute Lipschitz constant for a kernel.
///
/// Raises ValueError for an empty or non-finite kernel.
#[pyfunction]
fn py_compute_lipschitz(kernel: PyReadonlyArray1<f32>) -> PyResult<f64> {
    let slice = kernel
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    validate::validate_kernel(slice).map_err(py_err)?;
    Ok(compute_lipschitz(slice))
}

/// One deconvolution result, in the caller's (input-trace) frame.
struct FrameResult {
    activity: Vec<f32>,
    baseline: f64,
    reconvolution: Vec<f32>,
    iterations: u32,
    converged: bool,
}

/// Build a solver for the one-shot deconvolution entry points.
fn one_shot_solver(
    tau_rise: f64,
    tau_decay: f64,
    lambda: f64,
    fs: f64,
    conv_mode: &str,
    constraint: &str,
    hp_enabled: bool,
    lp_enabled: bool,
) -> PyResult<Solver> {
    let mut solver = Solver::new();
    solver
        .set_params(tau_rise, tau_decay, lambda, fs)
        .map_err(py_err)?;
    solver.set_conv_mode(parse_conv_mode(conv_mode)?);
    solver.set_constraint(parse_constraint(constraint)?);
    if hp_enabled || lp_enabled {
        solver.set_hp_filter_enabled(hp_enabled);
        solver.set_lp_filter_enabled(lp_enabled);
    }
    Ok(solver)
}

/// Solve one trace and report the fit in the caller's frame.
///
/// The solver works on the trace with its rolling-percentile baseline removed
/// (`subtract_baseline`), so its own baseline / reconvolution are relative to
/// that subtracted trace. Here the removed baseline is added back:
///
/// - `reconvolution = K*s + b_fit + b_roll(t)`: the full model fit to the
///   input trace (to the filtered trace if HP/LP filtering is enabled),
///   including the slowly varying rolling baseline `b_roll`.
/// - `baseline = b_fit + mean(b_roll)`: the scalar baseline in input units —
///   for a trace with a constant offset, ≈ that offset.
///
/// Touches no Python objects, so it runs with the GIL released.
fn solve_in_input_frame(
    solver: &mut Solver,
    trace: &[f32],
    filter: bool,
    max_iters: u32,
) -> Result<FrameResult, SolverError> {
    solver.set_trace(trace)?;
    if filter {
        solver.apply_filter();
    }
    let before = solver.get_trace();
    solver.subtract_baseline();
    let after = solver.get_trace();

    let n_batches = max_iters.div_ceil(BATCH_SIZE);
    for _ in 0..n_batches {
        if solver.step_batch(BATCH_SIZE)? {
            break;
        }
    }

    let mut reconvolution = solver.get_reconvolution_with_baseline();
    let mut removed_sum = 0.0_f64;
    for ((r, &b), &a) in reconvolution.iter_mut().zip(&before).zip(&after) {
        let removed = b - a;
        *r += removed;
        removed_sum += removed as f64;
    }
    let removed_mean = if before.is_empty() {
        0.0
    } else {
        removed_sum / before.len() as f64
    };

    Ok(FrameResult {
        activity: solver.get_solution(),
        baseline: solver.get_baseline() + removed_mean,
        reconvolution,
        iterations: solver.iteration_count(),
        converged: solver.converged(),
    })
}

/// One-shot deconvolution for a single 1D trace.
/// Returns (activity, baseline, reconvolution, iterations, converged), with
/// `baseline` and `reconvolution` in the input trace's frame (see
/// `solve_in_input_frame`).
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
    let mut solver = one_shot_solver(
        tau_rise, tau_decay, lambda_, fs, conv_mode, constraint, hp_enabled, lp_enabled,
    )?;
    let trace_f32 = to_f32_vec(&trace)?;
    let filter = hp_enabled || lp_enabled;

    let r = py
        .allow_threads(|| solve_in_input_frame(&mut solver, &trace_f32, filter, max_iters))
        .map_err(py_err)?;

    Ok((
        PyArray1::from_vec(py, r.activity),
        r.baseline,
        PyArray1::from_vec(py, r.reconvolution),
        r.iterations,
        r.converged,
    ))
}

/// Batch deconvolution for a 2D array of traces (n_cells x n_timepoints).
/// Returns (activities, baselines, reconvolutions, iterations, convergeds),
/// with baselines / reconvolutions in the input frame (see `deconvolve_single`).
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
    let (n_cells, n_timepoints) = (shape[0], shape[1]);

    let mut solver = one_shot_solver(
        tau_rise, tau_decay, lambda_, fs, conv_mode, constraint, hp_enabled, lp_enabled,
    )?;
    let filter = hp_enabled || lp_enabled;

    // Copy the rows out (as f32, half the input's size) so the solve loop can
    // run with the GIL released without borrowing numpy memory.
    let traces_ref = traces.as_array();
    let mut rows: Vec<Vec<f32>> = Vec::with_capacity(n_cells);
    for cell_idx in 0..n_cells {
        let row: Vec<f32> = traces_ref.row(cell_idx).iter().map(|&v| v as f32).collect();
        if let Some(i) = crate::first_nonfinite(&row) {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "{NONFINITE_ERR} at row {cell_idx}, index {i}"
            )));
        }
        rows.push(row);
    }
    debug_assert!(rows.iter().all(|r| r.len() == n_timepoints));

    let results = py
        .allow_threads(|| {
            rows.iter()
                .map(|row| solve_in_input_frame(&mut solver, row, filter, max_iters))
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(py_err)?;

    let mut activities = Vec::with_capacity(n_cells);
    let mut baselines = Vec::with_capacity(n_cells);
    let mut reconvolutions = Vec::with_capacity(n_cells);
    let mut iterations = Vec::with_capacity(n_cells);
    let mut convergeds = Vec::with_capacity(n_cells);
    for r in results {
        activities.push(PyArray1::from_vec(py, r.activity));
        baselines.push(r.baseline);
        reconvolutions.push(PyArray1::from_vec(py, r.reconvolution));
        iterations.push(r.iterations);
        convergeds.push(r.converged);
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
    validate::validate_fs(fs).map_err(py_err)?;
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
/// (free_kernel, tau_rise, tau_decay, tau_rise_fast, tau_decay_fast, beta_fast,
/// n_seed_spikes, fit_mode).
///
/// `fit_mode` is "TwoComponent" / "SlowOnly" / "Degenerate" / "Empty". Check it
/// before using the time constants: on the no-events path this returns the
/// hardcoded (0.02, 0.4) without fitting anything, and those are not
/// distinguishable from a measurement by value.
#[pyfunction]
fn seed_kernel_estimate<'py>(
    py: Python<'py>,
    traces: PyReadonlyArray2<f64>,
    fs: f64,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>,
    f64,
    f64,
    f64,
    f64,
    f64,
    usize,
    String,
)> {
    validate::validate_fs(fs).map_err(py_err)?;
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
    if let Some(i) = crate::first_nonfinite(&traces_flat) {
        return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "{NONFINITE_ERR} at flattened index {i}"
        )));
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
        result.fit_mode.as_str().to_string(),
    ))
}

// ---------------------------------------------------------------------------
// InDeCa pipeline bindings
// ---------------------------------------------------------------------------

/// Run the full InDeCa pipeline on a single trace.
///
/// `max_firing_rate` (spikes/s, default 300) is the highest rate the cell can
/// reach in its strongest bursts; it fixes the per-frame ceiling `cap =
/// max(1, round(max_firing_rate / fs))` spikes. Everything runs at the
/// recorded frame rate and `s_counts` holds an integer count per frame.
///
/// The relaxed solve stops on a data-derived
/// convergence certificate (`native_solve`), so `max_iters` and `tol` are
/// effectively no-ops on the default path: `tol` (the relative-step rule)
/// applies only to a trace without a measurable noise floor (no
/// certificate), and `max_iters` is only a floor on the safety cap, which is
/// derived from the problem and lies in the 1e5-1e9 range (the default of
/// 500 cannot truncate the solve).
///
/// Returns (s_counts, alpha, baseline, threshold, pve, iterations, converged,
/// noise_var_processed, chain_noise_gain, (cap_limited, no_size_fit,
/// peak_outlier_ratio, dropped_spikes, rectified_input)): `noise_var_processed` is the
/// per-sample noise variance of the processed (working) trace, `sigma_raw^2`
/// through the bandpass times `chain_noise_gain`, the rolling-quantile
/// stage's measured gain on the noise (0 and 1 when no noise floor is
/// measurable); `iterations` is the iteration count of the relaxed solve (tens of
/// interior-point Newton steps; FISTA iterations only on the fallback paths)
/// and `converged`
/// says the certificate (or, without noise, the step rule) fired.
/// `converged = False` means the certificate could not be met in f64
/// arithmetic: in practice the stall detector on the certificate's bound
/// stopped the solve, since the derived cap is not reached. The last five are
/// per-cell diagnostics that never change the result: `cap_limited` (the pick
/// ended at the floor spike size, so the cap set the spike size),
/// `no_size_fit` (no spike size passed the one-standard-error test, so the
/// size that fits the data best was taken, usually the floor),
/// `peak_outlier_ratio` (largest event-peak frame mass over the second
/// largest), `dropped_spikes` (spikes no frame of their event had room
/// for) and `rectified_input` (the input trace is non-negative with at least a
/// fifth of the samples exactly 0: clipped at zero or already denoised, not a
/// supported input).
#[pyfunction]
#[pyo3(signature = (trace, tau_rise, tau_decay, fs, max_firing_rate=300.0, max_iters=500, tol=1e-4, hp_enabled=false, lp_enabled=false, warm_counts=None, lambda_=0.0))]
#[allow(clippy::too_many_arguments)]
fn py_indeca_solve_trace<'py>(
    py: Python<'py>,
    trace: PyReadonlyArray1<f64>,
    tau_rise: f64,
    tau_decay: f64,
    fs: f64,
    max_firing_rate: f64,
    max_iters: u32,
    tol: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    warm_counts: Option<PyReadonlyArray1<f64>>,
    lambda_: f64,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>,    // s_counts
    f64,                          // alpha
    f64,                          // baseline
    f64,                          // threshold
    f64,                          // pve
    u32,                          // iterations
    bool,                         // converged
    f64,                          // noise_var_processed
    f64,                          // chain_noise_gain
    (bool, bool, f64, u32, bool), // (cap_limited, no_size_fit, peak_outlier_ratio, dropped_spikes, rectified_input)
)> {
    let trace_f32 = to_f32_vec(&trace)?;
    let warm = optional_to_f32_vec(warm_counts)?;
    validate::validate_indeca_params(
        trace_f32.len(),
        tau_rise,
        tau_decay,
        fs,
        max_firing_rate,
        lambda_,
        tol,
    )
    .map_err(py_err)?;

    // Pure Rust on owned buffers: release the GIL for the solve.
    let result = py.allow_threads(|| {
        indeca::solve_trace_opts(
            &trace_f32,
            tau_rise,
            tau_decay,
            fs,
            max_firing_rate,
            max_iters,
            tol,
            warm.as_deref(),
            hp_enabled,
            lp_enabled,
            lambda_,
        )
    });

    Ok((
        PyArray1::from_vec(py, result.s_counts),
        result.alpha,
        result.baseline,
        result.threshold,
        result.pve,
        result.iterations,
        result.converged,
        result.noise_var_processed,
        result.chain_noise_gain,
        (
            result.cap_limited,
            result.no_size_fit,
            result.peak_outlier_ratio,
            result.dropped_spikes,
            result.rectified_input,
        ),
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
    // Reject negatives: `v as usize` wrapped -1 to usize::MAX, the length sum
    // wrapped back around, passed the consistency check, then indexing panicked.
    let lengths = validate::lengths_from_i64(lengths_slice).map_err(py_err)?;

    let alphas_slice = alphas
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;
    let baselines_slice = baselines
        .as_slice()
        .map_err(|_| pyo3::exceptions::PyValueError::new_err(CONTIGUOUS_ERR))?;

    let warm = optional_to_f32_vec(warm_kernel)?;

    // Shared with the WASM binding: array-length consistency, finiteness of
    // every array (alphas/baselines included), and kernel_length bounds, so a
    // caller mistake surfaces as a clear ValueError instead of a Rust panic.
    validate::validate_kernel_estimate_inputs(
        &traces_f32,
        &spikes_f32,
        &lengths,
        alphas_slice,
        baselines_slice,
        kernel_length,
        tol,
        warm.as_deref(),
        smooth_lambda,
    )
    .map_err(py_err)?;

    // Copy the (per-trace, small) numpy-backed slices so the GIL-free solve
    // never reads memory another Python thread could mutate.
    let alphas_v = alphas_slice.to_vec();
    let baselines_v = baselines_slice.to_vec();
    let result = py.allow_threads(|| {
        kernel_est::estimate_free_kernel(
            &traces_f32,
            &spikes_f32,
            &alphas_v,
            &baselines_v,
            &lengths,
            kernel_length,
            max_iters,
            tol,
            warm.as_deref(),
            smooth_lambda,
        )
    });

    Ok(PyArray1::from_vec(py, result))
}

/// Fit a bi-exponential model to a free-form kernel.
///
/// Returns (tau_rise, tau_decay, beta, residual, tau_rise_fast, tau_decay_fast, beta_fast).
///
/// Raises ValueError for a non-finite `h_free`, a bad `fs`, or (with
/// `use_warm`) non-finite or non-physical warm fields (see
/// `validate::biexp_fit_inputs`).
#[pyfunction]
#[pyo3(signature = (h_free, fs, refine=true, skip=0, warm_tau_rise=0.0, warm_tau_decay=0.0, warm_tau_rise_fast=0.0, warm_tau_decay_fast=0.0, warm_beta=0.0, warm_beta_fast=0.0, warm_residual=f64::INFINITY, use_warm=false))]
fn py_indeca_fit_biexponential(
    py: Python<'_>,
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
) -> PyResult<(f64, f64, f64, f64, f64, f64, f64, String)> {
    let h_f32 = to_f32_vec(&h_free)?;

    let warm_start = validate::biexp_fit_inputs(
        &h_f32,
        fs,
        use_warm,
        warm_tau_rise,
        warm_tau_decay,
        warm_tau_rise_fast,
        warm_tau_decay_fast,
        warm_beta,
        warm_beta_fast,
        warm_residual,
    )
    .map_err(py_err)?;

    let result = py.allow_threads(|| {
        biexp_fit::fit_biexponential(&h_f32, fs, refine, skip, warm_start.as_ref())
    });

    Ok((
        result.tau_rise,
        result.tau_decay,
        result.beta,
        result.residual,
        result.tau_rise_fast,
        result.tau_decay_fast,
        result.beta_fast,
        result.fit_mode.as_str().to_string(),
    ))
}

/// Generate synthetic calcium traces from a JSON config string.
///
/// Returns flat numpy arrays for efficient Python consumption:
///   (traces, spikes, clean_calcium, alphas, snrs, tau_rises, tau_decays,
///    noise_sigmas, snr_1aps, num_cells, num_timepoints)
#[pyfunction]
fn py_simulate_traces<'py>(
    py: Python<'py>,
    config_json: &str,
) -> PyResult<(
    Bound<'py, PyArray1<f32>>, // traces (flat, row-major)
    Bound<'py, PyArray1<f32>>, // spikes (flat, row-major)
    Bound<'py, PyArray1<f32>>, // clean_calcium (flat, row-major)
    Bound<'py, PyArray1<f64>>, // alphas (per-cell)
    Bound<'py, PyArray1<f64>>, // snrs (per-cell)
    Bound<'py, PyArray1<f64>>, // tau_rises (per-cell)
    Bound<'py, PyArray1<f64>>, // tau_decays (per-cell)
    Bound<'py, PyArray1<f64>>, // noise_sigmas (per-cell)
    Bound<'py, PyArray1<f64>>, // snr_1aps (per-cell, ground-truth diagnostic)
    usize,                     // num_cells
    usize,                     // num_timepoints
)> {
    let config: simulate::SimulationConfig = serde_json::from_str(config_json).map_err(|e| {
        pyo3::exceptions::PyValueError::new_err(format!("Invalid config JSON: {e}"))
    })?;
    // Sizes every buffer and the kernel before simulate() allocates them.
    validate::validate_simulation_config(&config).map_err(py_err)?;

    // Pure Rust on an owned config: release the GIL for the simulation.
    let result = py.allow_threads(|| simulate::simulate(&config));
    let n_cells = result.num_cells;
    let n_tp = result.num_timepoints;

    let mut spikes_flat = Vec::with_capacity(n_cells * n_tp);
    let mut clean_flat = Vec::with_capacity(n_cells * n_tp);
    let mut alphas = Vec::with_capacity(n_cells);
    let mut snrs = Vec::with_capacity(n_cells);
    let mut tau_rises = Vec::with_capacity(n_cells);
    let mut tau_decays = Vec::with_capacity(n_cells);
    let mut noise_sigmas = Vec::with_capacity(n_cells);
    let mut snr_1aps = Vec::with_capacity(n_cells);

    for gt in &result.ground_truth {
        spikes_flat.extend_from_slice(&gt.spikes);
        clean_flat.extend_from_slice(&gt.clean_calcium);
        alphas.push(gt.alpha);
        snrs.push(gt.snr);
        tau_rises.push(gt.tau_rise_s);
        tau_decays.push(gt.tau_decay_s);
        noise_sigmas.push(gt.noise_sigma);
        snr_1aps.push(gt.snr_1ap);
    }

    Ok((
        PyArray1::from_vec(py, result.traces),
        PyArray1::from_vec(py, spikes_flat),
        PyArray1::from_vec(py, clean_flat),
        PyArray1::from_vec(py, alphas),
        PyArray1::from_vec(py, snrs),
        PyArray1::from_vec(py, tau_rises),
        PyArray1::from_vec(py, tau_decays),
        PyArray1::from_vec(py, noise_sigmas),
        PyArray1::from_vec(py, snr_1aps),
        n_cells,
        n_tp,
    ))
}

/// Noise σ from the MAD of first differences (see `crate::snr`).
#[pyfunction]
fn py_snr_noise_sigma_mad_diff(trace: PyReadonlyArray1<f64>) -> PyResult<f64> {
    Ok(crate::snr::noise_sigma_mad_diff(&to_f32_vec(&trace)?))
}

/// CASCADE noise level ν (see `crate::snr`).
#[pyfunction]
fn py_snr_noise_level_nu(trace_dff: PyReadonlyArray1<f64>, fs: f64) -> PyResult<f64> {
    Ok(crate::snr::noise_level_nu(&to_f32_vec(&trace_dff)?, fs))
}

/// Descriptive peak SNR (see `crate::snr`).
#[pyfunction]
fn py_snr_peak(
    trace: PyReadonlyArray1<f64>,
    sigma: f64,
    top_fraction: f64,
    fs: f64,
) -> PyResult<f64> {
    Ok(crate::snr::peak_snr(
        &to_f32_vec(&trace)?,
        sigma,
        top_fraction,
        fs,
    ))
}

/// Measured SNR with the default top fraction (see `crate::snr`).
#[pyfunction]
fn py_snr_measured(trace: PyReadonlyArray1<f64>, fs: f64) -> PyResult<f64> {
    Ok(crate::snr::measured_snr(&to_f32_vec(&trace)?, fs))
}

/// Detect calcium events (see `crate::snr::detect_events`).
/// Returns (time_indices, heights, baselines) as parallel arrays.
#[pyfunction]
fn py_snr_detect_events<'py>(
    py: Python<'py>,
    trace: PyReadonlyArray1<f64>,
    sigma: f64,
    min_separation_samples: usize,
) -> PyResult<(
    Bound<'py, PyArray1<u64>>,
    Bound<'py, PyArray1<f64>>,
    Bound<'py, PyArray1<f64>>,
)> {
    let events = crate::snr::detect_events(&to_f32_vec(&trace)?, sigma, min_separation_samples);
    let idx: Vec<u64> = events.iter().map(|e| e.time_index as u64).collect();
    let heights: Vec<f64> = events.iter().map(|e| e.height).collect();
    let baselines: Vec<f64> = events.iter().map(|e| e.baseline).collect();
    Ok((
        PyArray1::from_vec(py, idx),
        PyArray1::from_vec(py, heights),
        PyArray1::from_vec(py, baselines),
    ))
}

/// Measured SNR with the silent flag (see `crate::snr::measured_snr_report`).
/// Returns (snr, sigma, n_events, is_silent).
#[pyfunction]
fn py_snr_measured_report(
    trace: PyReadonlyArray1<f64>,
    fs: f64,
    min_separation_samples: usize,
) -> PyResult<(f64, f64, usize, bool)> {
    let r = crate::snr::measured_snr_report(&to_f32_vec(&trace)?, fs, min_separation_samples);
    Ok((r.snr, r.sigma, r.n_events, r.is_silent))
}

/// The solver version (see `crate::SOLVER_VERSION`), used by the Python
/// bridge's version handshake. Same value as `calab._solver.__version__`.
#[pyfunction]
fn protocol_version() -> &'static str {
    crate::SOLVER_VERSION
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
    // Simulation
    m.add_function(wrap_pyfunction!(py_simulate_traces, m)?)?;
    m.add_function(wrap_pyfunction!(protocol_version, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_noise_sigma_mad_diff, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_noise_level_nu, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_peak, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_measured, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_detect_events, m)?)?;
    m.add_function(wrap_pyfunction!(py_snr_measured_report, m)?)?;
    m.add("SNR_DEFAULT_TOP_FRACTION", crate::snr::DEFAULT_TOP_FRACTION)?;
    m.add("__version__", crate::SOLVER_VERSION)?;
    Ok(())
}

// Rust-side unit tests for the pure-Rust helpers behind the Python bindings.
//
// `cargo test --features pybindings` cannot link a test binary on its own:
// pyo3's `extension-module` feature leaves the libpython symbols for the
// interpreter that loads the extension to provide. CI therefore only
// type-checks this module (`cargo clippy --all-targets --features
// pybindings`); the Python-facing behaviour is exercised end-to-end by pytest
// (python/tests/test_degenerate_inputs.py). To run these locally on macOS:
//
//   PYLIB=$(python3 -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')
//   RUSTFLAGS="-C link-arg=-undefined -C link-arg=dynamic_lookup" \
//   DYLD_INSERT_LIBRARIES="$PYLIB/libpython3.12.dylib" \
//   CARGO_TARGET_DIR=target/pytests \
//   cargo test --no-default-features --features pybindings --lib py_api
//
// None of these tests touch the interpreter: `PyErr::new_err` is lazy, so
// they only check `is_err()` / `is_ok()`.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_and_constraint_strings() {
        assert!(matches!(parse_conv_mode("fft"), Ok(ConvMode::Fft)));
        assert!(matches!(parse_conv_mode("banded"), Ok(ConvMode::BandedAR2)));
        assert!(matches!(
            parse_constraint("nonneg"),
            Ok(Constraint::NonNegative)
        ));
        assert!(matches!(parse_constraint("box01"), Ok(Constraint::Box01)));
        for bad in ["", "FFT", "fft ", "banded\0", "box", "nonnegative"] {
            assert!(parse_conv_mode(bad).is_err(), "{bad:?}");
            assert!(parse_constraint(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn one_shot_solver_rejects_degenerate_params_and_strings() {
        let build = |tr, td, lam, fs, mode, c| {
            one_shot_solver(tr, td, lam, fs, mode, c, false, false).map(|_| ())
        };
        assert!(build(0.02, 0.4, 0.01, 30.0, "fft", "nonneg").is_ok());
        for (tr, td, lam, fs) in [
            (0.4, 0.02, 0.01, 30.0),
            (0.0, 0.4, 0.01, 30.0),
            (-0.02, 0.4, 0.01, 30.0),
            (0.02, 0.4, 0.01, 0.0),
            (0.02, 0.4, 0.01, -30.0),
            (0.02, 0.4, -0.01, 30.0),
            (0.02, f64::NAN, 0.01, 30.0),
            (0.02, 1e12, 0.01, 30.0),
        ] {
            assert!(
                build(tr, td, lam, fs, "fft", "nonneg").is_err(),
                "({tr}, {td}, {lam}, {fs})"
            );
        }
        assert!(build(0.02, 0.4, 0.01, 30.0, "nope", "nonneg").is_err());
        assert!(build(0.02, 0.4, 0.01, 30.0, "fft", "nope").is_err());
    }

    fn solver(mode: &str) -> Solver {
        match one_shot_solver(0.02, 0.4, 0.01, 30.0, mode, "nonneg", false, false) {
            Ok(s) => s,
            Err(_) => panic!("valid params rejected"),
        }
    }

    #[test]
    fn solve_in_input_frame_handles_empty_and_tiny_traces() {
        for mode in ["fft", "banded"] {
            for n in [0_usize, 1, 2, 5] {
                for filter in [false, true] {
                    let mut s = solver(mode);
                    let trace: Vec<f32> = (0..n).map(|i| 3.0 + i as f32).collect();
                    let r = solve_in_input_frame(&mut s, &trace, filter, 200).unwrap();
                    let ctx = format!("{mode} n={n} filter={filter}");
                    assert_eq!(r.activity.len(), n, "{ctx}");
                    assert_eq!(r.reconvolution.len(), n, "{ctx}");
                    assert!(r.activity.iter().all(|v| v.is_finite()), "{ctx}");
                    assert!(r.reconvolution.iter().all(|v| v.is_finite()), "{ctx}");
                    assert!(r.baseline.is_finite(), "{ctx}");
                    if n == 0 {
                        assert_eq!(r.baseline, 0.0, "{ctx}");
                    }
                }
            }
        }
    }

    #[test]
    fn solve_in_input_frame_reports_baseline_in_the_input_frame() {
        // A constant trace is all baseline: activity ~0, baseline ~ the offset,
        // and the reconvolution reproduces the input.
        for mode in ["fft", "banded"] {
            let mut s = solver(mode);
            let r = solve_in_input_frame(&mut s, &[7.5; 300], false, 2000).unwrap();
            assert!(r.activity.iter().all(|v| v.abs() < 1e-3), "{mode}");
            assert!((r.baseline - 7.5).abs() < 1e-2, "{mode}: {}", r.baseline);
            assert!(
                r.reconvolution.iter().all(|v| (v - 7.5).abs() < 1e-2),
                "{mode}"
            );
        }
    }

    #[test]
    fn solve_in_input_frame_rejects_non_finite_and_recovers() {
        let mut s = solver("fft");
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let r = solve_in_input_frame(&mut s, &[1.0, bad, 1.0], false, 100);
            assert!(matches!(r, Err(SolverError::InvalidInput(_))), "{bad}");
        }
        // deconvolve_batch reuses one solver across rows: a later row must not
        // see state from an earlier one.
        let a = solve_in_input_frame(&mut s, &[2.0; 50], false, 500).unwrap();
        let mut fresh = solver("fft");
        let b = solve_in_input_frame(&mut fresh, &[2.0; 50], false, 500).unwrap();
        assert_eq!(a.activity, b.activity);
        assert_eq!(a.baseline, b.baseline);
    }

    #[test]
    fn zero_max_iters_runs_no_iterations() {
        let mut s = solver("fft");
        let r = solve_in_input_frame(&mut s, &[1.0; 40], false, 0).unwrap();
        assert_eq!(r.iterations, 0);
        assert!(!r.converged);
        assert!(r.activity.iter().all(|&v| v == 0.0));
        assert!(run_to_convergence(&mut s, 0).is_ok());
    }
}
