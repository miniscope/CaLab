/// WASM bindings for InDeCa pipeline functions.
///
/// These functions are exposed to JavaScript via wasm-bindgen and use
/// serde-wasm-bindgen for complex return types (InDecaResult, BiexpResult).

use wasm_bindgen::prelude::*;

use crate::biexp_fit;
use crate::indeca;
use crate::kernel_est;
use crate::upsample;

/// Solve a single trace using the InDeCa pipeline.
///
/// Returns a JsValue containing the serialized InDecaResult:
/// { s_counts, alpha, baseline, threshold, pve, iterations, converged }
#[wasm_bindgen]
pub fn indeca_solve_trace(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    upsample_factor: usize,
    max_iters: u32,
    tol: f64,
) -> JsValue {
    let result = indeca::solve_trace(trace, tau_r, tau_d, fs, upsample_factor, max_iters, tol, None);
    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Estimate a free-form kernel from multiple traces and their spike trains.
///
/// Arguments:
/// - `traces_flat`: concatenated trace data (all traces joined end-to-end)
/// - `spikes_flat`: concatenated binary spike trains
/// - `trace_lengths`: length of each individual trace (Uint32Array)
/// - `alphas`: per-trace scaling factors (Float64Array)
/// - `baselines`: per-trace baselines (Float64Array)
/// - `kernel_length`: desired kernel length in samples
/// - `fs`: sampling rate
/// - `max_iters`: maximum FISTA iterations
/// - `tol`: convergence tolerance
///
/// Returns the estimated kernel as Float32Array (via Vec<f32>).
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
) -> Vec<f32> {
    let lengths: Vec<usize> = trace_lengths.iter().map(|&v| v as usize).collect();
    kernel_est::estimate_free_kernel(
        traces_flat,
        spikes_flat,
        alphas,
        baselines,
        &lengths,
        kernel_length,
        max_iters,
        tol,
    )
}

/// Fit a bi-exponential model to a free-form kernel.
///
/// Returns a JsValue containing the serialized BiexpResult:
/// { tau_rise, tau_decay, beta, residual }
#[wasm_bindgen]
pub fn indeca_fit_biexponential(h_free: &[f32], fs: f64, refine: bool) -> JsValue {
    let result = biexp_fit::fit_biexponential(h_free, fs, refine);
    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Compute the upsample factor for a given sampling rate and target rate.
#[wasm_bindgen]
pub fn indeca_compute_upsample_factor(fs: f64, target_fs: f64) -> usize {
    upsample::compute_upsample_factor(fs, target_fs)
}
