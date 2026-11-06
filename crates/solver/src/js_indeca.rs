/// WASM bindings for InDeCa pipeline functions.
///
/// These functions are exposed to JavaScript via wasm-bindgen and use
/// serde-wasm-bindgen for complex return types (InDecaResult, BiexpResult).
///
/// Every entry point validates its inputs with the shared checks in
/// `crate::validate` (the same ones the Python bindings use) and throws a JS
/// `Error` on bad input instead of trapping the WASM module or returning
/// garbage.
use wasm_bindgen::prelude::*;

use crate::biexp_fit;
use crate::indeca;
use crate::kernel_est;
use crate::peak_seed;
use crate::validate::{self, SolverError};

/// Prefix a validation error with the function name, as a JS error.
fn js_err(func: &str, e: SolverError) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Serialize a result for JS, surfacing serialization failures as a thrown
/// error instead of silently returning `null`.
pub(crate) fn to_js<T: serde::Serialize>(func: &str, value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value)
        .map_err(|e| JsError::new(&format!("{func}: failed to serialize result: {e}")))
}

/// Solve a single trace using the InDeCa pipeline.
///
/// `max_firing_rate` (spikes/s, the app default is 300) is the highest rate
/// the cell can reach in its strongest bursts. It fixes the per-frame
/// ceiling `cap = max(1, round(max_firing_rate / fs))` spikes: the box of
/// the relaxed solve and the smallest spike size the binarization considers.
/// Everything runs at the recorded frame rate; `s_counts` is an integer
/// count per frame (`0..=cap`), the same length as `trace`.
///
/// `warm_counts`: accepted for API compatibility and has no effect (see
/// `indeca::solve_trace_opts`). Pass an empty slice.
///
/// `max_iters` and `tol` (CaDecon's `traceFistaMaxIters` / `traceFistaTol`)
/// are effectively no-ops on the default path: the relaxed solve stops on a
/// data-derived convergence certificate (`native_solve`). `tol` (the
/// relative-step rule) applies only to a trace without a measurable noise
/// floor (no certificate). `max_iters` is only a floor on the safety cap,
/// which is derived from the problem and lies in the 1e5-1e9 range, so the
/// apps' value (500) cannot truncate the solve and raising it changes
/// nothing unless it exceeds the derived cap.
///
/// Returns a JsValue containing the serialized InDecaResult:
/// { s_counts, filtered_trace, alpha, baseline, threshold, pve, iterations,
///   converged, loop_converged, noise_var_processed, chain_noise_gain,
///   cap_limited, no_size_fit, peak_outlier_ratio,
///   dropped_spikes }
/// where `iterations` is the FISTA iteration count (hundreds to a few
/// thousand at 30 Hz; tens of thousands for slow indicators at 60 Hz) and
/// `converged` says the certificate (or, without noise, the step rule)
/// fired. `converged = false` means the certificate could not be met in f64
/// arithmetic: in practice the stall detector on the certificate's bound
/// stopped the solve, since the derived cap is not reached.
/// `loop_converged` is always true (the solve is one round; kept so the
/// object's shape is unchanged). `threshold` is the picked spike size as a
/// fraction of the largest event's mass.
/// `noise_var_processed` is the per-sample noise variance of the working
/// trace (`filtered_trace`; baseline-subtracted, bandpassed), `sigma_raw^2`
/// times the bandpass's gain times `chain_noise_gain` (the rolling-quantile
/// stage's measured gain); 0 when the trace has no measurable noise floor.
/// `1 - noise_var_processed / var(filtered_trace)` is the PVE a fit can
/// reach before it starts fitting noise.
///
/// Per-cell diagnostics (none changes the result): `cap_limited` (the pick
/// ended at the floor spike size `frame_max / cap`, so the cap set the spike
/// size), `no_size_fit` (no spike size passed the one-standard-error test),
/// `peak_outlier_ratio` (largest event-peak frame mass over the second
/// largest) and `dropped_spikes` (spikes no frame of their event had room
/// for).
///
/// Throws a JS error (rather than returning garbage) if `trace` or
/// `warm_counts` contains a non-finite value, or if the parameters are invalid
/// (`fs <= 0`, `tau_r >= tau_d`, `max_firing_rate` outside (0, 10000],
/// negative `lambda`, ...).
#[wasm_bindgen]
pub fn indeca_solve_trace(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    max_firing_rate: f64,
    max_iters: u32,
    tol: f64,
    hp_enabled: bool,
    lp_enabled: bool,
    warm_counts: &[f32],
    lambda: f64,
) -> Result<JsValue, JsError> {
    const F: &str = "indeca_solve_trace";
    validate::validate_finite_f32("trace", trace).map_err(|e| js_err(F, e))?;
    validate::validate_finite_f32("warm_counts", warm_counts).map_err(|e| js_err(F, e))?;
    validate::validate_indeca_params(trace.len(), tau_r, tau_d, fs, max_firing_rate, lambda, tol)
        .map_err(|e| js_err(F, e))?;
    let warm = if warm_counts.is_empty() {
        None
    } else {
        Some(warm_counts)
    };
    let result = indeca::solve_trace_opts(
        trace,
        tau_r,
        tau_d,
        fs,
        max_firing_rate,
        max_iters,
        tol,
        warm,
        hp_enabled,
        lp_enabled,
        lambda,
    );
    to_js(F, &result)
}

/// Estimate a free-form kernel from multiple traces and their spike trains.
///
/// `warm_kernel`: optional kernel from a previous iteration. Pass an empty slice
/// for cold-start.
///
/// Returns the estimated kernel as Float32Array (via Vec<f32>).
///
/// Throws a JS error (rather than aborting the WASM module) if the input array
/// lengths are inconsistent — `alphas`/`baselines` must have one entry per
/// trace, and `traces_flat`/`spikes_flat` must each be the sum of
/// `trace_lengths` — if any array contains a non-finite value, or if
/// `kernel_length` is 0 or above the kernel-length cap.
#[wasm_bindgen]
pub fn indeca_estimate_kernel(
    traces_flat: &[f32],
    spikes_flat: &[f32],
    trace_lengths: &[u32],
    alphas: &[f64],
    baselines: &[f64],
    kernel_length: usize,
    max_iters: u32,
    tol: f64,
    warm_kernel: &[f32],
    smooth_lambda: f64,
) -> Result<Vec<f32>, JsError> {
    const F: &str = "indeca_estimate_kernel";
    let lengths: Vec<usize> = trace_lengths.iter().map(|&v| v as usize).collect();
    let warm = if warm_kernel.is_empty() {
        None
    } else {
        Some(warm_kernel)
    };
    validate::validate_kernel_estimate_inputs(
        traces_flat,
        spikes_flat,
        &lengths,
        alphas,
        baselines,
        kernel_length,
        tol,
        warm,
        smooth_lambda,
    )
    .map_err(|e| js_err(F, e))?;
    Ok(kernel_est::estimate_free_kernel(
        traces_flat,
        spikes_flat,
        alphas,
        baselines,
        &lengths,
        kernel_length,
        max_iters,
        tol,
        warm,
        smooth_lambda,
    ))
}

/// Fit a bi-exponential model to a free-form kernel.
///
/// Warm-start: pass `use_warm=true` and the previous result's fields to add
/// the previous result as an additional refined candidate alongside the cold
/// grid search. This gives faster convergence when the kernel evolves smoothly.
/// Pass `use_warm=false` (and any values for warm_* fields) for cold-start only.
///
/// Returns a JsValue containing the serialized BiexpResult:
/// { tau_rise, tau_decay, beta, residual, tau_rise_fast, tau_decay_fast, beta_fast, fit_mode }
///
/// Throws a JS error if `h_free` contains a non-finite value, `fs <= 0`, or
/// (with `use_warm`) a warm field is non-finite (`warm_residual` may be +inf)
/// or the warm taus are non-physical (see `validate::biexp_fit_inputs`).
#[wasm_bindgen]
pub fn indeca_fit_biexponential(
    h_free: &[f32],
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
) -> Result<JsValue, JsError> {
    const F: &str = "indeca_fit_biexponential";
    let warm_start = validate::biexp_fit_inputs(
        h_free,
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
    .map_err(|e| js_err(F, e))?;
    let result = biexp_fit::fit_biexponential(h_free, fs, refine, skip, warm_start.as_ref());
    to_js(F, &result)
}

/// Run peak-seeded spike detection on a single trace.
///
/// Returns a JsValue containing the serialized SeedTraceResult:
/// { s_counts, alpha, baseline }
///
/// Throws a JS error if `trace` contains a non-finite value or `fs <= 0`.
#[wasm_bindgen]
pub fn seed_trace(trace: &[f32], fs: f64) -> Result<JsValue, JsError> {
    const F: &str = "seed_trace";
    validate::validate_finite_f32("trace", trace).map_err(|e| js_err(F, e))?;
    validate::validate_fs(fs).map_err(|e| js_err(F, e))?;
    let result = peak_seed::seed_trace(trace, fs);
    to_js(F, &result)
}
