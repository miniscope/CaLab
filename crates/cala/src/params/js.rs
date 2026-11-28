//! wasm binding of the params: the defaults as JSON.

use wasm_bindgen::prelude::*;

use super::CalaParams;

/// `CalaParams::default()` as JSON: the app's shipped configuration. The
/// schema's defaults are the same values (a vitest checks that the wasm and
/// the schema come from the same commit).
#[wasm_bindgen(js_name = defaultParams)]
pub fn default_params() -> String {
    serde_json::to_string(&CalaParams::default()).expect("params serialise")
}
