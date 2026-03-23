/// WASM bindings for the simulation module.
///
/// Accepts a JSON-serialized SimulationConfig and returns a JSON-serialized
/// SimulationResult. The JavaScript layer handles type marshalling via
/// the mirrored TypeScript interfaces in simulation-types.ts.
use wasm_bindgen::prelude::*;

use crate::simulate;

/// Generate synthetic calcium traces from a config object.
///
/// Accepts: JsValue containing a SimulationConfig-shaped object.
/// Returns: JsValue containing a SimulationResult-shaped object.
#[wasm_bindgen]
pub fn simulate_traces(config_js: JsValue) -> JsValue {
    let config: simulate::SimulationConfig = serde_wasm_bindgen::from_value(config_js)
        .expect("Invalid SimulationConfig");
    let result = simulate::simulate(&config);
    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Get all built-in simulation preset names and their configs.
///
/// Returns: JsValue containing Vec<(name, SimulationConfig)>.
#[wasm_bindgen]
pub fn get_simulation_presets() -> JsValue {
    let presets = simulate::presets::all();
    serde_wasm_bindgen::to_value(&presets).unwrap_or(JsValue::NULL)
}
