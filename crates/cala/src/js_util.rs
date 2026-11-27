//! Helpers shared by the wasm-bindgen surfaces (`jsbindings`).

use wasm_bindgen::JsError;

/// A JS `Error` with the message `"{func}: {e}"`.
pub(crate) fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Route Rust panics to `console.error` (idempotent). Every entry point
/// that builds a long-lived object calls it, so a panic in a worker is
/// reported with its message instead of a bare `unreachable` trap.
pub(crate) fn init_panic_hook() {
    console_error_panic_hook::set_once();
}
