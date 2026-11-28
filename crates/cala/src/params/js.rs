//! wasm binding of the params: the one entry every engine object is built
//! from.
//!
//! The app resolves its params once per run (`resolveParams`) and sends
//! the resolved JSON (`ResolvedParams.toJson`) in every worker's init
//! message; each worker rebuilds the handle (`ResolvedParams.fromJson`)
//! and passes it to the constructors (`SlowLoop`, `QcMonitor`, ...), which
//! take their configs from its [`Engine`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;

use super::engine::{fingerprint_hex, Engine};
use super::layer::params_from_layer;
use super::resolve::{Context, EngineView, ResolveError};
use super::CalaParams;
use crate::js_util::init_panic_hook;

/// `CalaParams::default()` as JSON: the app's shipped configuration. The
/// schema's defaults are the same values (a vitest checks that the wasm and
/// the schema come from the same commit).
#[wasm_bindgen(js_name = defaultParams)]
pub fn default_params() -> String {
    serde_json::to_string(&CalaParams::default()).expect("params serialise")
}

/// Params resolved for one recording, and the engine configs built from
/// them.
#[wasm_bindgen(js_name = ResolvedParams)]
pub struct ResolvedParams {
    params: CalaParams,
    context: Context,
    engine: Engine,
}

/// The JSON of [`ResolvedParams`]: `params` and `context` define it;
/// `fingerprint` and `engine` are derived from them, for readers without
/// the wasm module (the app's TS reads `engine`).
#[derive(Serialize, Deserialize)]
struct Wire {
    params: CalaParams,
    context: Context,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<EngineView>,
}

/// A resolve error as one `JsError` whose message is the JSON list
/// `[{pointer, message}]`.
fn resolve_err(e: ResolveError) -> JsError {
    JsError::new(&serde_json::json!([{ "pointer": e.pointer, "message": e.message }]).to_string())
}

fn parse_err(what: &str, e: impl std::fmt::Display) -> JsError {
    resolve_err(ResolveError {
        pointer: String::new(),
        message: format!("{what}: {e}"),
    })
}

impl ResolvedParams {
    /// Resolve `params` for `context` and build the engine configs.
    pub fn new(params: CalaParams, context: Context) -> Result<ResolvedParams, ResolveError> {
        let engine = Engine::build(&params, context)?;
        Ok(ResolvedParams {
            params,
            context,
            engine,
        })
    }

    /// The engine configs of the run.
    pub fn engine(&self) -> &Engine {
        &self.engine
    }
}

/// Resolve a params layer (a partial params object, JSON; keys it leaves
/// out keep their default) for a recording, `context` = `{"fps": Hz,
/// "frame": [width, height]}`. Fails with `[{pointer, message}]` on a key
/// that is not a params field, a value of the wrong type, or params that
/// do not resolve.
#[wasm_bindgen(js_name = resolveParams)]
pub fn resolve_params(layer_json: &str, context_json: &str) -> Result<ResolvedParams, JsError> {
    init_panic_hook();
    let layer: Value = serde_json::from_str(layer_json).map_err(|e| parse_err("layer", e))?;
    let params = params_from_layer(&layer).map_err(resolve_err)?;
    let context: Context =
        serde_json::from_str(context_json).map_err(|e| parse_err("context", e))?;
    ResolvedParams::new(params, context).map_err(resolve_err)
}

#[wasm_bindgen(js_class = ResolvedParams)]
impl ResolvedParams {
    /// Rebuild from `toJson`'s text (in each worker). A `fingerprint` in the
    /// text must match the params', so a worker cannot run other params
    /// than the ones resolved.
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<ResolvedParams, JsError> {
        init_panic_hook();
        let w: Wire = serde_json::from_str(json).map_err(|e| parse_err("resolved params", e))?;
        let r = ResolvedParams::new(w.params, w.context).map_err(resolve_err)?;
        if w.fingerprint.is_some_and(|fp| fp != r.fingerprint()) {
            return Err(parse_err(
                "resolved params",
                "the fingerprint does not match the params",
            ));
        }
        Ok(r)
    }

    /// `{params, context, fingerprint, engine}`: what the workers' init
    /// messages carry.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&Wire {
            params: self.params.clone(),
            context: self.context,
            fingerprint: Some(self.fingerprint()),
            engine: Some(self.engine.view.clone()),
        })
        .expect("resolved params serialise")
    }

    /// The params' fingerprint, 64 hex digits (`params::engine::fingerprint`).
    pub fn fingerprint(&self) -> String {
        fingerprint_hex(&self.params)
    }

    /// The engine view (every engine value the params set, in frames and
    /// pixels) as JSON, the form of the golden files.
    #[wasm_bindgen(js_name = engineJson)]
    pub fn engine_json(&self) -> String {
        serde_json::to_string(&self.engine.view).expect("the view serialises")
    }
}
