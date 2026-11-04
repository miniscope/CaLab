/// WASM bindings for the simulation module.
///
/// Accepts a JSON-serialized SimulationConfig and returns a JSON-serialized
/// SimulationResult. The JavaScript layer handles type marshalling via
/// the mirrored TypeScript interfaces in simulation-types.ts.
use wasm_bindgen::prelude::*;

use crate::js_indeca::to_js;
use crate::simulate;

/// Generate synthetic calcium traces from a config object.
///
/// Accepts: JsValue containing a SimulationConfig-shaped object.
/// Returns: JsValue containing a SimulationResult-shaped object.
///
/// Throws a JS error if the config does not deserialize as a SimulationConfig
/// (previously this trapped the WASM module) or the result fails to serialize.
#[wasm_bindgen]
pub fn simulate_traces(config_js: JsValue) -> Result<JsValue, JsError> {
    let config: simulate::SimulationConfig = serde_wasm_bindgen::from_value(config_js)
        .map_err(|e| JsError::new(&format!("simulate_traces: invalid SimulationConfig: {e}")))?;
    // Validate before simulate() sizes its buffers and kernel from the config
    // (an unchecked fs_hz = 0 or tau_decay_s in ms used to trap the module).
    crate::validate::validate_simulation_config(&config)
        .map_err(|e| JsError::new(&format!("simulate_traces: {e}")))?;
    let result = simulate::simulate(&config);
    to_js("simulate_traces", &result)
}

/// Get all built-in simulation preset names and their configs.
///
/// Returns: JsValue containing Vec<(name, SimulationConfig)>.
#[wasm_bindgen]
pub fn get_simulation_presets() -> Result<JsValue, JsError> {
    let presets = simulate::presets::all();
    to_js("get_simulation_presets", &presets)
}

// ── Real-data SNR metrics (see `crate::snr`) ─────────────────────

/// Noise σ from the MAD of first differences (Krisha Aghi's estimator).
#[wasm_bindgen]
pub fn snr_noise_sigma_mad_diff(trace: &[f32]) -> f64 {
    crate::snr::noise_sigma_mad_diff(trace)
}

/// CASCADE noise level ν = median|Δ(ΔF/F)| / √fs (pass ΔF/F in percent).
#[wasm_bindgen]
pub fn snr_noise_level_nu(trace_dff: &[f32], fs: f64) -> f64 {
    crate::snr::noise_level_nu(trace_dff, fs)
}

/// Descriptive peak SNR: (mean of the top `top_fraction` of samples − median) / σ.
#[wasm_bindgen]
pub fn snr_peak(trace: &[f32], sigma: f64, top_fraction: f64) -> f64 {
    crate::snr::peak_snr(trace, sigma, top_fraction)
}

/// Measured SNR: `snr_peak` with the MAD-diff σ and the default 1 % top
/// fraction. Burst-based: compares cells that share a burst-size distribution.
#[wasm_bindgen]
pub fn snr_measured(trace: &[f32]) -> f64 {
    crate::snr::measured_snr(trace)
}

/// The default top fraction used by `snr_measured`.
#[wasm_bindgen]
pub fn snr_default_top_fraction() -> f64 {
    crate::snr::DEFAULT_TOP_FRACTION
}

/// Detect calcium events (see `crate::snr::detect_events`).
///
/// `sigma` is the noise std (pass `snr_noise_sigma_mad_diff(trace)`);
/// `min_separation_samples` is about the indicator decay time in samples.
/// Returns `{ time_index, height, baseline }[]`.
#[wasm_bindgen]
pub fn snr_detect_events(
    trace: &[f32],
    sigma: f64,
    min_separation_samples: u32,
) -> Result<JsValue, JsError> {
    let events = crate::snr::detect_events(trace, sigma, min_separation_samples as usize);
    to_js("snr_detect_events", &events)
}

/// Measured SNR with the silent flag (see `crate::snr::measured_snr_report`).
/// Returns `{ snr, sigma, n_events, is_silent }`.
#[wasm_bindgen]
pub fn snr_measured_report(trace: &[f32], min_separation_samples: u32) -> Result<JsValue, JsError> {
    let report = crate::snr::measured_snr_report(trace, min_separation_samples as usize);
    to_js("snr_measured_report", &report)
}
