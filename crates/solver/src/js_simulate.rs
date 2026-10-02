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
