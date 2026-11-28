//! The schema of [`CalaParams`] and its per-field metadata vocabulary.
//!
//! Standard JSON Schema keywords carry the label (`title`), the help text
//! (`description`, from the doc comment), the default (from `Default`) and
//! the range (`minimum` / `maximum` / `enum`). The `x-` keywords below carry
//! the rest. [`params_schema`] fills `x-scope` and `x-affects` with their
//! common values where a field does not set them, so every field in the
//! generated schema states all of its required keywords.

use schemars::{schema_for, Schema};
use serde_json::{json, Map, Value};

use super::{CalaParams, PARAMS_VERSION};

/// Values of `x-unit`. `um` is micrometres at the sample or sensor, `d` is
/// cell diameters, `sigma` a z-score, `r` a
/// correlation, `ratio` any other dimensionless share or factor.
pub const UNITS: &[&str] = &[
    "px",
    "um",
    "s",
    "Hz",
    "frames",
    "cells",
    "count",
    "sigma",
    "r",
    "ratio",
    "d",
    "bytes",
    "MB",
    "visits_per_frame",
    "work_per_frame",
    "none",
];

/// Values of `x-level`: `main` (the pre-run sheet), `advanced` (its
/// Advanced section), `internal` (config files and debug only).
pub const LEVELS: &[&str] = &["main", "advanced", "internal"];

/// Values of `x-scope`: one value per `run`, or one per `stream` of a Joint
/// run.
pub const SCOPES: &[&str] = &["run", "stream"];

/// Values of `x-affects`: `results`, `compute` (how long a run takes, not
/// what it finds) or `output` (what is written).
pub const AFFECTS: &[&str] = &["results", "compute", "output"];

/// Values of `x-when`: the runs a field applies to.
pub const WHEN: &[&str] = &["recording", "live", "joint", "lookback"];

/// Keywords every field carries.
pub const REQUIRED: &[&str] = &[
    "title",
    "description",
    "default",
    "x-unit",
    "x-level",
    "x-scope",
    "x-affects",
];

/// The checked-in schema's path, relative to the crate root.
pub const SCHEMA_PATH: &str = "schema/cala-params.schema.json";

/// The JSON Schema of [`CalaParams`], with every field's metadata filled
/// in. The checked-in schema file is this value, pretty-printed.
pub fn params_schema() -> Value {
    let schema: Schema = schema_for!(CalaParams);
    let mut root = schema.to_value();
    let defs = root
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut blocks = Vec::new();
    collect_blocks(&root, &defs, &mut blocks);
    let obj = root
        .as_object_mut()
        .expect("a struct's schema is an object");
    fill_fields(obj);
    if let Some(Value::Object(defs)) = obj.get_mut("$defs") {
        for name in &blocks {
            if let Some(Value::Object(def)) = defs.get_mut(name) {
                fill_fields(def);
            }
        }
    }
    obj.insert("x-params-version".into(), json!(PARAMS_VERSION));
    unwrap_descriptions(&mut root);
    root
}

/// Joins the lines of every `description` (a doc comment's hard wraps) into
/// one paragraph, so the help text reflows in the UI.
fn unwrap_descriptions(v: &mut Value) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(d)) = m.get_mut("description") {
                *d = d.replace('\n', " ");
            }
            m.values_mut().for_each(unwrap_descriptions);
        }
        Value::Array(a) => a.iter_mut().for_each(unwrap_descriptions),
        _ => {}
    }
}

/// The checked-in form of [`params_schema`]: pretty-printed, two-space
/// indent, trailing newline.
pub fn params_schema_text() -> String {
    let mut s = serde_json::to_string_pretty(&params_schema()).expect("a Value serialises");
    s.push('\n');
    s
}

/// The `$defs` names of the parameter blocks reachable from `schema`
/// through plain `$ref` properties. Leaves (enums, nullable values, the
/// crop rectangle) are not blocks.
fn collect_blocks(schema: &Value, defs: &Map<String, Value>, out: &mut Vec<String>) {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return;
    };
    for prop in props.values() {
        if let Some(name) = block_ref(prop, defs) {
            if !out.contains(&name) {
                out.push(name.clone());
                collect_blocks(&defs[&name], defs, out);
            }
        }
    }
}

/// The `$defs` name when `prop` is a block: a direct `$ref` to an object.
pub(crate) fn block_ref(prop: &Value, defs: &Map<String, Value>) -> Option<String> {
    let name = prop.get("$ref")?.as_str()?.strip_prefix("#/$defs/")?;
    let def = defs.get(name)?;
    (def.get("type").and_then(Value::as_str) == Some("object")).then(|| name.to_string())
}

/// Sets `x-scope: run` and `x-affects: results` on the leaf fields of a
/// block that do not set them. Block-valued fields are left alone; their
/// own fields are filled when their definition is.
fn fill_fields(block: &mut Map<String, Value>) {
    let Some(Value::Object(props)) = block.get_mut("properties") else {
        return;
    };
    for prop in props.values_mut() {
        let Value::Object(p) = prop else { continue };
        if p.contains_key("$ref") && !p.contains_key("x-unit") {
            continue;
        }
        p.entry("x-scope").or_insert_with(|| json!("run"));
        p.entry("x-affects").or_insert_with(|| json!("results"));
    }
}
