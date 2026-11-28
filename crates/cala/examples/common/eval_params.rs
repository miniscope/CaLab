//! `qc_eval`'s run parameters: [`CalaParams`] from `--params FILE` and the
//! config flags, which are overrides of params fields applied on top.
//!
//! With neither, the params are the app's defaults ([`CalaParams`]); the
//! run-control flags (visit schedule, budget, settle model, ...) are not
//! params and keep `qc_eval`'s own defaults. `tools/cala-eval/presets/qc-eval-legacy.json`
//! is the engine's own configuration (cluster replay, merge guard and
//! look-back off, non-rigid motion), the no-flag arm of older results notes.
//!
//! Each config flag maps to the params fields in [`PARAM_FLAGS`]; a flag
//! keeps the meaning it had as a direct engine setting (`--motion` turns
//! on non-rigid motion correction). A params file is
//! a partial params object (any subset of keys, at any depth, with an
//! optional `params_version`); a key that is not a params field is an
//! error, since an ignored key in an eval arm is a wrong measurement.

use calab_cala::params::loose::{frames_to_seconds, set_diameter_fixed_ring};
use calab_cala::params::migrate::migrate;
use calab_cala::params::{CalaParams, PARAMS_VERSION};
use serde_json::{json, Value};

/// Every config flag and the params fields (JSON pointers) it sets.
pub const PARAM_FLAGS: &[(&str, &[&str])] = &[
    (
        "--cell-diameter",
        &[
            "/scales/cell_diameter_px",
            "/discover/ring/inner_per_d",
            "/discover/ring/outer_per_d",
            "/discover/margin_px",
        ],
    ),
    ("--flatten-sigma", &["/scales/flatten_sigma_px"]),
    ("--psf-sigma", &["/scales/psf_sigma_px"]),
    ("--tile-px", &["/discover/tile_px"]),
    ("--margin-px", &["/discover/margin_px"]),
    ("--slow-seed", &["/discover/seed"]),
    ("--accept-z", &["/discover/accept_z"]),
    ("--support-alpha", &["/discover/support_alpha"]),
    ("--refine-gate", &["/discover/refine/gate"]),
    ("--refine-z", &["/discover/refine/z"]),
    ("--joint-update", &["/discover/cluster/update"]),
    ("--cluster-rho-min", &["/discover/cluster/rho_min"]),
    ("--cluster-max", &["/discover/cluster/max"]),
    ("--joint-sign", &["/discover/cluster/sign"]),
    ("--bg", &["/discover/background"]),
    ("--joint-admit", &["/discover/cluster/admit"]),
    ("--joint-carry", &["/discover/cluster/carry"]),
    ("--joint-l1", &["/discover/cluster/l1"]),
    ("--joint-iters", &["/discover/cluster/iters"]),
    ("--joint", &["/discover/cluster/neighbours"]),
    ("--merge-rule", &["/discover/merge/rule"]),
    (
        "--merge-guard-max-ovl",
        &[
            "/discover/merge/guard_max_ovl",
            "/discover/merge/refit_max_ovl",
        ],
    ),
    ("--merge-refit-max-ovl", &["/discover/merge/refit_max_ovl"]),
    ("--warm-start", &["/discover/warm_start"]),
    ("--merge-guard-sep", &["/discover/merge/guard_min_sep_d"]),
    ("--stats-half-life", &["/discover/stats_half_life_s"]),
    ("--frames-per-tile", &["/discover/frames_per_tile"]),
    ("--reservoir-max-mb", &["/discover/reservoir_max_mb"]),
    ("--readd-window", &["/discover/churn/readd_window_s"]),
    ("--churn-frames", &["/discover/churn/churn_s"]),
    ("--ff-gain-half-life", &["/flat_field/gain_half_life_s"]),
    ("--ff-offset-half-life", &["/flat_field/offset_half_life_s"]),
    ("--ff-first", &["/flat_field/first_map_s"]),
    ("--ff-refine", &["/flat_field/refine_every_s"]),
    ("--motion", &["/motion/nonrigid/enabled"]),
    ("--lookback", &["/lookback/enabled", "/lookback/rate"]),
    ("--lookback-frames", &["/lookback/horizon_s"]),
];

/// Flags in [`PARAM_FLAGS`] that take no value.
const SWITCHES: &[&str] = &["--joint-carry", "--joint", "--motion"];

/// The value after `flag` in `args`.
fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    Some(
        args.get(i + 1)
            .unwrap_or_else(|| panic!("{flag} needs a value")),
    )
}

/// The params of a `qc_eval` run: the defaults, then `--params FILE`, then
/// the config flags. `fps` is the recording's frame rate (the flags that
/// count frames are converted to seconds at the rate `resolve` converts
/// them back at). Panics with the offending keys or values.
pub fn eval_params(args: &[String], fps: f64) -> CalaParams {
    let mut v = serde_json::to_value(CalaParams::default()).expect("params serialise");
    if let Some(path) = value_of(args, "--params") {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("--params {path}: {e}"));
        let file: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("--params {path}: {e}"));
        merge(&mut v, &file_params(file, path));
        check_known(&v, path);
    }
    let base: CalaParams =
        serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("--params: {e}"));
    for (flag, _) in PARAM_FLAGS {
        let raw = if SWITCHES.contains(flag) {
            args.iter().any(|a| a == flag).then_some("")
        } else {
            value_of(args, flag)
        };
        if let Some(raw) = raw {
            apply_flag(&mut v, &base, fps, flag, raw);
        }
    }
    serde_json::from_value(v).unwrap_or_else(|e| panic!("params after the flags: {e}"))
}

/// A params file's object, migrated to [`PARAMS_VERSION`].
fn file_params(file: Value, path: &str) -> Value {
    let Value::Object(mut m) = file else {
        panic!("--params {path}: not a JSON object");
    };
    let from = match m.remove("params_version") {
        None => PARAMS_VERSION,
        Some(n) => n
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or_else(|| panic!("--params {path}: params_version {n} is not a version")),
    };
    migrate(Value::Object(m), from).unwrap_or_else(|e| panic!("--params {path}: {e}"))
}

/// Merge `layer` into `base` key by key: objects merge, everything else
/// replaces.
pub fn merge(base: &mut Value, layer: &Value) {
    match (base, layer) {
        (Value::Object(b), Value::Object(l)) => {
            for (k, x) in l {
                match b.get_mut(k) {
                    Some(y) => merge(y, x),
                    None => {
                        b.insert(k.clone(), x.clone());
                    }
                }
            }
        }
        (b, l) => *b = l.clone(),
    }
}

/// Panic when `v` (defaults merged with a file) has a key that is not a
/// params field: it survives the merge but not a round trip through
/// [`CalaParams`].
fn check_known(v: &Value, path: &str) {
    let parsed: CalaParams =
        serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("--params {path}: {e}"));
    let known = serde_json::to_value(parsed).expect("params serialise");
    let mut unknown = Vec::new();
    extra_keys(v, &known, "", &mut unknown);
    assert!(
        unknown.is_empty(),
        "--params {path}: not params fields: {}",
        unknown.join(", ")
    );
}

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

/// Set the field at `ptr` (it must exist).
fn set(v: &mut Value, ptr: &str, x: Value) {
    *v.pointer_mut(ptr)
        .unwrap_or_else(|| panic!("{ptr} is not a params field")) = x;
}

/// An f32 setting as JSON: parsed as f32, as the engine field it sets is,
/// so the value reaches the engine unchanged.
fn f32_value(flag: &str, raw: &str) -> Value {
    let x: f32 = raw
        .parse()
        .unwrap_or_else(|_| panic!("{flag}: not a number: {raw}"));
    json!(f64::from(x))
}

fn f64_value(flag: &str, raw: &str) -> Value {
    let x: f64 = raw
        .parse()
        .unwrap_or_else(|_| panic!("{flag}: not a number: {raw}"));
    json!(x)
}

fn int_value(flag: &str, raw: &str) -> Value {
    let x: u64 = raw
        .parse()
        .unwrap_or_else(|_| panic!("{flag}: not a whole number: {raw}"));
    json!(x)
}

/// `raw` must be one of `allowed` (flag spelling, params spelling).
fn choice(flag: &str, raw: &str, allowed: &[(&str, &str)]) -> Value {
    let (_, to) = allowed
        .iter()
        .find(|(from, _)| *from == raw)
        .unwrap_or_else(|| {
            let names: Vec<&str> = allowed.iter().map(|(f, _)| *f).collect();
            panic!("{flag}: {}, not {raw}", names.join("|"))
        });
    json!(to)
}

/// Apply one config flag. `base` holds the params before the flags: a
/// frame count converts at its `time.fps_override`, else at `fps`.
fn apply_flag(v: &mut Value, base: &CalaParams, fps: f64, flag: &str, raw: &str) {
    let fps = base.time.fps_override.unwrap_or(fps);
    let secs = |frames: Value| json!(frames_to_seconds(fps, frames.as_f64().unwrap()));
    let rule = &[("legacy", "legacy"), ("split-half", "split_half")];
    match flag {
        "--cell-diameter" => {
            let d = f32_value(flag, raw).as_f64().unwrap();
            let mut p: CalaParams = serde_json::from_value(v.clone()).unwrap();
            set_diameter_fixed_ring(&mut p, d);
            for ptr in [
                "/scales/cell_diameter_px",
                "/discover/ring/inner_per_d",
                "/discover/ring/outer_per_d",
                "/discover/margin_px",
            ] {
                let x = serde_json::to_value(&p)
                    .unwrap()
                    .pointer(ptr)
                    .unwrap()
                    .clone();
                set(v, ptr, x);
            }
        }
        "--flatten-sigma" => set(v, "/scales/flatten_sigma_px", f32_value(flag, raw)),
        "--psf-sigma" => set(v, "/scales/psf_sigma_px", f32_value(flag, raw)),
        "--tile-px" => set(v, "/discover/tile_px", int_value(flag, raw)),
        "--margin-px" => set(v, "/discover/margin_px", int_value(flag, raw)),
        "--slow-seed" => set(v, "/discover/seed", int_value(flag, raw)),
        "--accept-z" => set(v, "/discover/accept_z", f32_value(flag, raw)),
        "--support-alpha" => set(v, "/discover/support_alpha", f32_value(flag, raw)),
        "--refine-gate" => set(v, "/discover/refine/gate", choice(flag, raw, rule)),
        "--refine-z" => set(v, "/discover/refine/z", f32_value(flag, raw)),
        "--joint-update" => set(
            v,
            "/discover/cluster/update",
            choice(
                flag,
                raw,
                &[("off", "off"), ("refine", "refine"), ("all", "all")],
            ),
        ),
        "--cluster-rho-min" => set(v, "/discover/cluster/rho_min", f32_value(flag, raw)),
        "--cluster-max" => set(v, "/discover/cluster/max", int_value(flag, raw)),
        "--joint-sign" => set(
            v,
            "/discover/cluster/sign",
            choice(flag, raw, &[("off", "off"), ("own", "own"), ("all", "all")]),
        ),
        "--bg" => set(
            v,
            "/discover/background",
            choice(flag, raw, &[("none", "none"), ("ring", "ring")]),
        ),
        "--joint-admit" => set(
            v,
            "/discover/cluster/admit",
            choice(flag, raw, &[("cluster", "cluster"), ("member", "member")]),
        ),
        "--joint-carry" => set(v, "/discover/cluster/carry", json!(true)),
        "--joint-l1" => set(v, "/discover/cluster/l1", f32_value(flag, raw)),
        "--joint-iters" => set(v, "/discover/cluster/iters", int_value(flag, raw)),
        "--joint" => set(v, "/discover/cluster/neighbours", json!(true)),
        "--merge-rule" => set(v, "/discover/merge/rule", choice(flag, raw, rule)),
        "--merge-guard-max-ovl" => {
            let x = f32_value(flag, raw);
            set(v, "/discover/merge/guard_max_ovl", x.clone());
            set(v, "/discover/merge/refit_max_ovl", x);
        }
        "--merge-refit-max-ovl" => set(v, "/discover/merge/refit_max_ovl", f32_value(flag, raw)),
        "--warm-start" => set(
            v,
            "/discover/warm_start",
            match raw {
                "on" => json!(true),
                "off" => json!(false),
                _ => panic!("--warm-start on|off"),
            },
        ),
        "--merge-guard-sep" => {
            // Infinity (off) is `null`: JSON has no infinity.
            let d: f32 = raw
                .parse()
                .unwrap_or_else(|_| panic!("{flag}: not a number: {raw}"));
            let x = if d.is_finite() {
                json!(f64::from(d))
            } else {
                Value::Null
            };
            set(v, "/discover/merge/guard_min_sep_d", x);
        }
        "--stats-half-life" => set(v, "/discover/stats_half_life_s", secs(f32_value(flag, raw))),
        "--frames-per-tile" => set(v, "/discover/frames_per_tile", int_value(flag, raw)),
        "--reservoir-max-mb" => set(v, "/discover/reservoir_max_mb", int_value(flag, raw)),
        "--readd-window" => set(
            v,
            "/discover/churn/readd_window_s",
            secs(int_value(flag, raw)),
        ),
        "--churn-frames" => set(v, "/discover/churn/churn_s", secs(int_value(flag, raw))),
        "--ff-gain-half-life" => set(v, "/flat_field/gain_half_life_s", f32_value(flag, raw)),
        "--ff-offset-half-life" => set(v, "/flat_field/offset_half_life_s", f32_value(flag, raw)),
        "--ff-first" => set(v, "/flat_field/first_map_s", f32_value(flag, raw)),
        "--ff-refine" => set(v, "/flat_field/refine_every_s", f32_value(flag, raw)),
        "--motion" => set(v, "/motion/nonrigid/enabled", json!(true)),
        "--lookback" => {
            let r = f64_value(flag, raw);
            let on = r.as_f64().unwrap() > 0.0;
            set(v, "/lookback/enabled", json!(on));
            if on {
                set(v, "/lookback/rate", r);
            }
        }
        "--lookback-frames" => set(v, "/lookback/horizon_s", secs(int_value(flag, raw))),
        _ => unreachable!("{flag} is in PARAM_FLAGS"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    /// A sample value per flag, valid for its field.
    fn sample(flag: &str) -> &'static str {
        match flag {
            "--refine-gate" | "--merge-rule" => "legacy",
            "--joint-update" => "refine",
            "--joint-sign" => "own",
            "--bg" => "none",
            "--joint-admit" => "member",
            "--warm-start" => "off",
            "--cluster-max" | "--joint-iters" => "3",
            "--merge-guard-max-ovl" | "--merge-refit-max-ovl" | "--cluster-rho-min" => "0.3",
            "--support-alpha" => "0.1",
            "--lookback" => "1.5",
            _ => "48",
        }
    }

    /// Every flag maps to existing params fields and sets only those.
    #[test]
    fn each_flag_sets_its_params_fields() {
        let base = serde_json::to_value(CalaParams::default()).unwrap();
        for (flag, ptrs) in PARAM_FLAGS {
            for p in *ptrs {
                assert!(
                    base.pointer(p).is_some(),
                    "{flag}: {p} is not a params field"
                );
            }
            let line = if SWITCHES.contains(flag) {
                format!("qc_eval {flag}")
            } else {
                format!("qc_eval {flag} {}", sample(flag))
            };
            let got = serde_json::to_value(eval_params(&args(&line), 20.0)).unwrap();
            let mut changed = Vec::new();
            diff(&base, &got, "", &mut changed);
            for c in &changed {
                assert!(ptrs.contains(&c.as_str()), "{flag} also set {c}");
            }
            assert!(!changed.is_empty(), "{flag} set nothing");
        }
    }

    fn diff(a: &Value, b: &Value, at: &str, out: &mut Vec<String>) {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for (k, v) in x {
                    diff(v, &y[k], &format!("{at}/{k}"), out);
                }
            }
            _ if a != b => out.push(at.to_string()),
            _ => {}
        }
    }

    /// Frame-counted flags come back as the same frame counts.
    #[test]
    fn frame_counts_round_trip() {
        use calab_cala::params::resolve::{resolve, Context};
        let ctx = Context {
            fps: Some(30.0),
            frame: [64, 64],
        };
        for n in [1u64, 3, 400, 2400, 2999, 3000, 4800, 6000, 9601, 123_457] {
            let p = eval_params(
                &args(&format!(
                    "q --stats-half-life {n} --readd-window {n} --churn-frames {n} --lookback-frames {n}"
                )),
                30.0,
            );
            let s = resolve(&p, ctx).unwrap();
            assert_eq!(s.slow_loop.stats_half_life_frames, n);
            assert_eq!(s.slow_loop.churn_readd_window_frames, n);
            assert_eq!(s.slow_loop.churn_frames, n);
            assert_eq!(s.lookback.max_frames, n);
        }
    }

    #[test]
    fn an_infinite_guard_is_off() {
        let p = eval_params(&args("q --merge-guard-sep inf"), 20.0);
        assert_eq!(p.discover.merge.guard_min_sep_d, None);
        let p = eval_params(&args("q --merge-guard-sep 0.6"), 20.0);
        assert_eq!(p.discover.merge.guard_min_sep_d, Some(f64::from(0.6f32)));
    }

    #[test]
    fn look_back_zero_is_off() {
        let p = eval_params(&args("q --lookback 0"), 20.0);
        assert!(!p.lookback.enabled);
        let p = eval_params(&args("q --lookback 2"), 20.0);
        assert!(p.lookback.enabled && p.lookback.rate == 2.0);
    }

    #[test]
    fn a_params_file_merges_and_flags_win() {
        let dir = std::env::temp_dir().join(format!("qc_eval_params_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("p.json");
        std::fs::write(
            &f,
            r#"{"params_version": 1, "discover": {"accept_z": 6, "cluster": {"update": "off"}}}"#,
        )
        .unwrap();
        let p = eval_params(&args(&format!("q --params {}", f.display())), 20.0);
        assert_eq!(p.discover.accept_z, 6.0);
        assert_eq!(
            p.discover.cluster.update,
            calab_cala::params::ClusterUpdate::Off
        );
        assert_eq!(p.discover.event_z, CalaParams::default().discover.event_z);
        let p = eval_params(
            &args(&format!("q --params {} --accept-z 4", f.display())),
            20.0,
        );
        assert_eq!(p.discover.accept_z, 4.0);
        std::fs::write(&f, r#"{"discover": {"acept_z": 6}}"#).unwrap();
        let r = std::panic::catch_unwind(|| {
            eval_params(&args(&format!("q --params {}", f.display())), 20.0)
        });
        assert!(r.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The legacy preset is a valid params file.
    #[test]
    fn the_legacy_preset_reads() {
        let f = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/cala-eval/presets/qc-eval-legacy.json"
        );
        let p = eval_params(&args(&format!("q --params {f}")), 20.0);
        assert_eq!(
            p.discover.cluster.update,
            calab_cala::params::ClusterUpdate::Off
        );
        assert_eq!(p.discover.merge.guard_min_sep_d, None);
        assert!(!p.lookback.enabled);
    }
}
