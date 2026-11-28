//! A params layer: a partial params object (any subset of keys, at any
//! depth) over the defaults.

use serde_json::Value;

use super::resolve::ResolveError;
use super::CalaParams;

/// [`CalaParams::default`] with `layer` applied: every block is
/// `#[serde(default)]`, so the keys `layer` leaves out keep their default.
/// A key that is not a params field is an error naming its JSON pointer
/// (serde would ignore it, and the value would silently not apply).
pub fn params_from_layer(layer: &Value) -> Result<CalaParams, ResolveError> {
    let err = |pointer: String, message: String| ResolveError { pointer, message };
    if !layer.is_object() {
        return Err(err(String::new(), "a params layer is a JSON object".into()));
    }
    let p: CalaParams =
        serde_json::from_value(layer.clone()).map_err(|e| err(String::new(), e.to_string()))?;
    let known = serde_json::to_value(&p).expect("params serialise");
    let mut unknown = Vec::new();
    extra_keys(layer, &known, "", &mut unknown);
    match unknown.into_iter().next() {
        None => Ok(p),
        Some(ptr) => Err(err(ptr, "not a params field".into())),
    }
}

/// JSON pointers of the keys of `v` that `known` does not have.
fn extra_keys(v: &Value, known: &Value, at: &str, out: &mut Vec<String>) {
    if let (Value::Object(a), Value::Object(b)) = (v, known) {
        for (k, x) in a {
            let p = format!("{at}/{k}");
            match b.get(k) {
                None => out.push(p),
                Some(y) => extra_keys(x, y, &p, out),
            }
        }
    }
}
