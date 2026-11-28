//! Drift tests of the params: Rust defaults, the checked-in schema and
//! golden files, the metadata vocabulary, migrations, and parity with the
//! values the engine uses.

use serde_json::{json, Map, Value};

use super::meta::{self, block_ref, params_schema, AFFECTS, LEVELS, REQUIRED, SCOPES, UNITS, WHEN};
use super::migrate::{migrate, migrate_with, MigrateError, Migration};
use super::resolve::{self, frames, resolve, Context, DiameterSource, EngineView};
use super::*;

fn crate_file(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}; run `npm run gen:params`",
            path.display()
        )
    })
}

fn parsed(rel: &str) -> Value {
    serde_json::from_str(&crate_file(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn view(fps: f64) -> EngineView {
    resolve(
        &CalaParams::default(),
        Context {
            fps,
            frame: resolve::GOLDEN_FRAME,
        },
    )
    .unwrap()
}

// ---- checked-in files ----

/// Compared as parsed JSON, so formatting of the file does not matter.
#[test]
fn checked_in_schema_is_current() {
    assert!(
        parsed(meta::SCHEMA_PATH) == params_schema(),
        "{} is stale: run `npm run gen:params`",
        meta::SCHEMA_PATH
    );
}

#[test]
fn checked_in_goldens_are_current() {
    for fps in resolve::GOLDEN_FPS {
        let want: Value = serde_json::from_str(&resolve::golden_text(fps)).unwrap();
        assert!(
            parsed(&resolve::golden_path(fps)) == want,
            "{} is stale: an engine value changed. Run `npm run gen:params` only if the \
             change is intended",
            resolve::golden_path(fps)
        );
    }
}

// ---- metadata ----

/// Every leaf field of every block, as (JSON pointer, field schema).
fn leaves() -> Vec<(String, Value)> {
    let schema = params_schema();
    let defs = schema["$defs"].as_object().cloned().unwrap_or_default();
    let mut out = Vec::new();
    walk(&schema, "", &defs, &mut out);
    out
}

fn walk(block: &Value, at: &str, defs: &Map<String, Value>, out: &mut Vec<(String, Value)>) {
    for (name, prop) in block["properties"].as_object().unwrap() {
        let ptr = format!("{at}/{name}");
        match block_ref(prop, defs) {
            Some(def) if prop.get("x-unit").is_none() => {
                for k in ["title", "description", "default"] {
                    assert!(prop.get(k).is_some(), "block {ptr} has no `{k}`");
                }
                walk(&defs[&def], &ptr, defs, out);
            }
            _ => out.push((ptr, prop.clone())),
        }
    }
}

fn one_of(field: &str, key: &str, v: &Value, allowed: &[&str]) {
    let s = v
        .as_str()
        .unwrap_or_else(|| panic!("{field}: `{key}` is not a string"));
    assert!(
        allowed.contains(&s),
        "{field}: `{key}` = {s:?} is not one of {allowed:?}"
    );
}

/// The JSON types a field's value may take (`null` excluded).
fn value_types(f: &Value, defs: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match &f["type"] {
        Value::String(t) => out.push(t.clone()),
        Value::Array(ts) => out.extend(ts.iter().filter_map(|t| t.as_str().map(String::from))),
        _ => {}
    }
    if let Some(r) = f.get("$ref").and_then(Value::as_str) {
        let def = &defs[r.trim_start_matches("#/$defs/")];
        out.extend(value_types(def, defs));
        if def.get("oneOf").is_some() || def.get("enum").is_some() {
            out.push("enum".into());
        }
    }
    if let Some(alts) = f.get("anyOf").and_then(Value::as_array) {
        for a in alts {
            out.extend(value_types(a, defs));
        }
    }
    out.retain(|t| t != "null");
    out
}

#[test]
fn every_field_has_its_metadata() {
    let schema = params_schema();
    let all = leaves();
    assert!(all.len() > 100, "only {} fields found", all.len());
    for (ptr, f) in &all {
        for k in REQUIRED {
            assert!(f.get(*k).is_some(), "{ptr} has no `{k}`");
        }
        assert!(
            !f["description"].as_str().unwrap().trim().is_empty(),
            "{ptr}: empty description"
        );
        one_of(ptr, "x-unit", &f["x-unit"], UNITS);
        one_of(ptr, "x-level", &f["x-level"], LEVELS);
        one_of(ptr, "x-scope", &f["x-scope"], SCOPES);
        one_of(ptr, "x-affects", &f["x-affects"], AFFECTS);
        if let Some(w) = f.get("x-when") {
            one_of(ptr, "x-when", w, WHEN);
        }
        if let Some(labels) = f.get("x-enum-labels") {
            let n = f["enum"].as_array().map(Vec::len);
            assert_eq!(
                n,
                labels.as_array().map(Vec::len),
                "{ptr}: one label per enum value"
            );
        }
        // Every number has a range or a list of choices.
        let types = value_types(f, &schema["$defs"]);
        if types.iter().any(|t| t == "number" || t == "integer") {
            assert!(
                f.get("enum").is_some()
                    || (f.get("minimum").is_some() && f.get("maximum").is_some()),
                "{ptr}: a number needs `minimum` and `maximum`, or `enum`"
            );
        }
    }
}

#[test]
fn field_names_match_their_units() {
    let rules = [
        ("_s", "s"),
        ("_px", "px"),
        ("_frames", "frames"),
        ("_per_d", "d"),
        ("_d", "d"),
        ("_um", "um"),
        ("_mb", "MB"),
    ];
    for (ptr, f) in leaves() {
        let unit = f["x-unit"].as_str().unwrap();
        for (suffix, want) in rules {
            if ptr.ends_with(suffix) {
                assert_eq!(unit, want, "{ptr}: a `{suffix}` field has x-unit {want}");
                break;
            }
        }
        if unit == "s" {
            assert!(ptr.ends_with("_s"), "{ptr}: a duration's name ends in `_s`");
        }
    }
}

#[test]
fn compute_only_fields_are_in_the_compute_block() {
    for (ptr, f) in leaves() {
        if f["x-affects"] == "compute" {
            assert!(ptr.starts_with("/compute/"), "{ptr}");
        }
    }
    let rep = leaves()
        .into_iter()
        .find(|(p, _)| p == "/compute/repeatable");
    assert_eq!(rep.unwrap().1["x-affects"], "results");
}

#[test]
fn schema_names_its_version() {
    assert_eq!(params_schema()["x-params-version"], json!(PARAMS_VERSION));
}

// ---- defaults ----

/// `CalaParams::default()` serialised equals the defaults the schema
/// states, at every depth.
#[test]
fn schema_defaults_are_the_rust_defaults() {
    let rust = serde_json::to_value(CalaParams::default()).unwrap();
    for (ptr, f) in leaves() {
        assert_eq!(
            rust.pointer(&ptr),
            Some(&f["default"]),
            "{ptr}: schema default differs from Default"
        );
    }
    // Block defaults too.
    let schema = params_schema();
    for (name, prop) in schema["properties"].as_object().unwrap() {
        assert_eq!(prop["default"], rust[name], "/{name}");
    }
}

#[test]
fn defaults_round_trip_through_json() {
    let p = CalaParams::default();
    let text = serde_json::to_string(&p).unwrap();
    assert_eq!(serde_json::from_str::<CalaParams>(&text).unwrap(), p);
}

#[test]
fn a_partial_object_fills_in_the_defaults() {
    let p: CalaParams = serde_json::from_value(json!({
        "discover": { "accept_z": 6.0, "merge": { "guard_min_sep_d": null } },
        "settle": { "final": { "level": "quick" } },
        "not_a_setting": 1
    }))
    .unwrap();
    let mut want = CalaParams::default();
    want.discover.accept_z = 6.0;
    want.discover.merge.guard_min_sep_d = None;
    want.settle.final_.level = FinalSettleLevel::Quick;
    assert_eq!(p, want);
    assert_eq!(
        serde_json::from_value::<CalaParams>(json!({})).unwrap(),
        CalaParams::default()
    );
}

// ---- migrations ----

/// A made-up layout change: v0 named the diameter `diameter` at the top
/// level.
fn v0_to_v1(mut v: Value) -> Result<Value, String> {
    let obj = v.as_object_mut().ok_or("params must be an object")?;
    if let Some(d) = obj.remove("diameter") {
        obj.insert("scales".into(), json!({ "cell_diameter_px": d }));
    }
    Ok(v)
}

#[test]
fn a_made_up_migration_runs_and_the_result_reads() {
    let steps = [Migration {
        from: 0,
        step: v0_to_v1,
    }];
    let v0 = json!({ "diameter": 12.0, "discover": { "accept_z": 6.0 } });
    let v1 = migrate_with(v0, 0, 1, &steps).unwrap();
    let p: CalaParams = serde_json::from_value(v1).unwrap();
    assert_eq!(p.scales.cell_diameter_px, Some(12.0));
    assert_eq!(p.discover.accept_z, 6.0);
    assert_eq!(
        migrate_with(json!(3), 0, 1, &steps),
        Err(MigrateError::Step {
            from: 0,
            message: "params must be an object".into()
        })
    );
}

#[test]
fn migration_refuses_newer_and_unknown_versions() {
    let p = json!({ "discover": {} });
    assert_eq!(migrate(p.clone(), PARAMS_VERSION), Ok(p.clone()));
    assert_eq!(
        migrate(p.clone(), PARAMS_VERSION + 1),
        Err(MigrateError::Newer {
            found: PARAMS_VERSION + 1,
            current: PARAMS_VERSION
        })
    );
    assert_eq!(
        migrate_with(p, 0, 2, &[]),
        Err(MigrateError::Missing { from: 0 })
    );
}

#[test]
fn every_migration_step_is_below_the_current_version() {
    for (i, m) in migrate::MIGRATIONS.iter().enumerate() {
        assert_eq!(
            m.from as usize + migrate::MIGRATIONS.len() - i,
            PARAMS_VERSION as usize
        );
    }
}

// ---- resolve ----

#[test]
fn frames_rounds_and_keeps_zero() {
    assert_eq!(frames(0.0, 20.0), 0);
    assert_eq!(frames(0.01, 20.0), 1);
    assert_eq!(frames(0.15, 20.0), 3);
    assert_eq!(frames(0.25, 30.0), 8);
    assert_eq!(frames(240.0, 30.0), 7200);
}

#[test]
fn the_default_diameter_is_ten_pixels_set_directly() {
    let d = view(20.0).cell_diameter;
    assert_eq!(d.px, 10.0);
    assert_eq!(d.source, DiameterSource::Px);
    assert_eq!(d.um_per_px, None);
}

#[test]
fn the_diameter_follows_the_optics_when_pixels_are_not_set() {
    let mut p = CalaParams::default();
    p.scales.cell_diameter_px = None;
    p.scales.expected_cell_diameter_um = Some(15.0);
    p.optics.sensor_pixel_um = Some(2.2);
    p.optics.magnification = Some(2.2);
    p.optics.sensor_width_px = Some(1200);
    let ctx = Context {
        fps: 20.0,
        frame: [600, 600],
    };
    // Binning 2 from the sensor and frame widths: 2 µm per frame pixel.
    let d = resolve::cell_diameter(&p, ctx.frame).unwrap();
    assert_eq!(d.source, DiameterSource::Optics);
    assert_eq!(d.um_per_px, Some(2.0));
    assert_eq!(d.px, 7.5);
    assert_eq!(resolve(&p, ctx).unwrap().slow_loop.cell_diameter_px, 7.5);

    // Pixels set directly override the physical diameter.
    p.scales.cell_diameter_px = Some(12.0);
    let d = resolve::cell_diameter(&p, ctx.frame).unwrap();
    assert_eq!((d.px, d.source), (12.0, DiameterSource::Px));

    // Neither usable: an error at the physical field.
    p.scales.cell_diameter_px = None;
    p.optics.magnification = None;
    let e = resolve(&p, ctx).unwrap_err();
    assert_eq!(e.pointer, "/scales/expected_cell_diameter_um");
}

#[test]
fn an_invalid_frame_rate_is_an_error() {
    let mut p = CalaParams::default();
    p.time.fps_override = Some(0.0);
    let ctx = Context {
        fps: 20.0,
        frame: [64, 64],
    };
    assert_eq!(resolve(&p, ctx).unwrap_err().pointer, "/time/fps_override");
}

/// At 30 fps the durations converted at the recording's rate move; those
/// converted at `time.legacy_frame_fps` keep their 20 fps frame counts.
#[test]
fn the_two_groups_of_durations_at_30_fps() {
    let (a, b) = (view(20.0), view(30.0));
    assert_eq!(b.flat_field.first_frames, a.flat_field.first_frames * 3 / 2);
    assert_eq!(b.preprocess.background_relax_frames, 3600.0);
    assert_eq!(b.slow_loop.probation_frames, a.slow_loop.probation_frames);
    assert_eq!(b.lookback.max_frames, 3000);
    let mut p = CalaParams::default();
    p.time.legacy_frame_fps = None;
    let c = resolve(
        &p,
        Context {
            fps: 30.0,
            frame: resolve::GOLDEN_FRAME,
        },
    )
    .unwrap();
    assert_eq!(c.lookback.max_frames, 4500);
}

// ---- parity with the engine ----

/// The default params, resolved, give the values the engine uses: the
/// engine's own defaults, except where the app ships other values
/// (look-back's cluster replay and merge guard), which the TS drift test
/// checks against the app's constants.
#[test]
fn defaults_resolve_to_the_engines_values() {
    use crate::discover::{
        ChurnConfig, JointAdmit, JointSign, JointUpdate, MergeRule as EMerge, RefineGate as EGate,
        SlowLoopConfig, VisitSchedule,
    };
    use crate::motion::{MotionConfig, NonRigidConfig};
    use crate::preprocess::flatfield::OnlineFlatFieldConfig;
    use crate::preprocess::flicker::FlickerMode;
    use crate::preprocess::lines::LineMode;
    use crate::preprocess::PreprocessConfig;
    use crate::qc::QcConfig;
    use crate::trace::{BackgroundModel as EBg, SolverConfig};

    for fps in [20.0f32, 30.0] {
        let v = view(f64::from(fps));
        // The engine holds f32: each value converts to the engine's exactly.

        // Preprocessing (background relaxation at the recording's fps).
        let pre = PreprocessConfig::for_fps(fps);
        let pv = &v.preprocess;
        assert_eq!(pv.warmup_frames, pre.warmup_frames as u64);
        assert_eq!(pv.flicker, Flicker::Both);
        assert_eq!(pre.flicker.mode, FlickerMode::Both);
        assert_eq!(pv.lines, Lines::Both);
        assert_eq!(pre.lines, LineMode::Both);
        assert_eq!(pv.fov_rel_threshold as f32, pre.fov.rel_threshold);
        assert_eq!(pv.fov_fit_disk, pre.fov.fit_disk);
        assert_eq!(pv.fov_margin_px as usize, pre.fov.margin_px);
        assert_eq!(pv.hot_pixel_k_sigma as f32, pre.hot.k_sigma);
        assert_eq!(pv.background_boxcar as usize, pre.background.boxcar);
        assert_eq!(
            pv.background_relax_frames as f32,
            pre.background.relax_frames
        );
        assert_eq!(
            pv.flatten_cell_diameter_px as f32,
            pre.flatten.cell_diameter_px
        );
        assert_eq!(pre.flatten.sigma_px, None);
        assert_eq!(
            pv.flatten_sigma_px as f32,
            crate::preprocess::flatten::SIGMA_PER_DIAMETER * pre.flatten.cell_diameter_px
        );

        // Motion (the app's motion warm-up equals the calibration's).
        let mo = MotionConfig::default();
        let nr = NonRigidConfig::default();
        assert_eq!(v.motion.max_shift as f32, mo.max_shift);
        assert_eq!(v.motion.template_tau as f32, mo.template_tau);
        assert_eq!(v.motion.template_refresh as usize, mo.template_refresh);
        assert_eq!(v.motion.warmup_frames, 200);
        assert_eq!(mo.nonrigid, None);
        assert_eq!(v.motion.nonrigid, None);
        let mut p = CalaParams::default();
        p.motion.nonrigid.enabled = true;
        let on = resolve(
            &p,
            Context {
                fps: f64::from(fps),
                frame: [600, 600],
            },
        )
        .unwrap();
        let nv = on.motion.nonrigid.unwrap();
        assert_eq!((nv.grid[0] as usize, nv.grid[1] as usize), nr.grid);
        assert_eq!(nv.max_patch_shift as f32, nr.max_patch_shift);

        // Flat field, at the recording's fps.
        let ff = OnlineFlatFieldConfig::for_fps(fps);
        assert_eq!(
            v.flat_field.half_life_frames as f64,
            ff.estimator.half_life_frames
        );
        assert_eq!(
            v.flat_field.offset_half_life_frames as f64,
            ff.estimator.offset_half_life_frames
        );
        assert_eq!(v.flat_field.first_frames, ff.first_frames);
        assert_eq!(v.flat_field.refine_every_frames, ff.refine_every_frames);

        // Slow loop.
        let s = SlowLoopConfig::default();
        let sv = &v.slow_loop;
        assert_eq!(sv.cell_diameter_px as f32, s.cell_diameter_px);
        assert_eq!(sv.psf_sigma_px as f32, s.psf_sigma_px);
        assert_eq!(sv.tile_px as usize, s.tile_px);
        assert_eq!(sv.margin_px as usize, s.margin_px);
        assert_eq!(sv.frames_per_tile as usize, s.frames_per_tile);
        assert_eq!(sv.reservoir_max_bytes as usize, s.reservoir_max_bytes);
        assert_eq!(sv.event_half_life_frames as f32, s.event_half_life_frames);
        assert_eq!(sv.accept_z as f32, s.accept_z);
        assert_eq!(sv.event_z as f32, s.event_z);
        assert_eq!(sv.min_events, s.min_events);
        assert_eq!(sv.merge_corr as f32, s.merge_corr);
        assert_eq!(
            u64::from(sv.commit_interval_frames),
            s.commit_interval_frames
        );
        assert_eq!(sv.reject_cooldown_frames, s.reject_cooldown_frames);
        assert_eq!(sv.event_frames, u64::from(s.event_frames));
        assert_eq!(sv.probation_frames, s.probation_frames);
        assert_eq!(sv.probe_gap_frames, s.probe_gap_frames);
        assert_eq!(sv.stats_half_life_frames as f32, s.stats_half_life_frames);
        assert_eq!(sv.support_alpha as f32, s.support_alpha);
        assert_eq!(sv.refine_z as f32, s.refine_z);
        assert_eq!(s.refine_gate, EGate::SplitHalf);
        assert_eq!(sv.refine_gate, RefineGate::SplitHalf);
        assert_eq!(s.merge_rule, EMerge::SplitHalf);
        assert_eq!(sv.merge_rule, MergeRule::SplitHalf);
        assert_eq!(sv.reservoir_refine_frames, s.reservoir_refine_frames);
        assert_eq!(sv.merge_z as f32, s.merge_z);
        assert_eq!(sv.merge_guard_max_ovl as f32, s.merge_guard_max_ovl);
        assert_eq!(sv.merge_refit_max_ovl as f32, s.merge_refit_max_ovl);
        assert_eq!(sv.warm_start, s.warm_start);
        assert_eq!(sv.joint_neighbours, s.joint_neighbours);
        assert_eq!(sv.cluster_rho_min as f32, s.cluster_rho_min);
        assert_eq!(sv.cluster_max as usize, s.cluster_max);
        assert_eq!(s.joint_sign_rule, JointSign::All);
        assert_eq!(sv.joint_sign_rule, ClusterSign::All);
        assert_eq!(sv.joint_iters as usize, s.joint_iters);
        assert_eq!(s.joint_admit, JointAdmit::Cluster);
        assert_eq!(sv.joint_admit, ClusterAdmit::Cluster);
        assert_eq!(sv.joint_carry, s.joint_carry);
        assert_eq!(sv.joint_l1 as f32, s.joint_l1);
        let ch = ChurnConfig::default();
        assert_eq!(s.churn, ch);
        assert_eq!(sv.churn_readd_window_frames, ch.readd_window_frames);
        assert_eq!(sv.churn_frames, ch.churn_frames);
        assert_eq!(sv.background, BackgroundModel::Ring);
        assert_eq!(
            s.background,
            EBg::Ring {
                inner_px: sv.ring_px[0] as f32,
                outer_px: sv.ring_px[1] as f32
            }
        );
        assert_eq!(u64::from(sv.seed), s.seed);
        // Shipped by the app's look-back (`LOOKBACK` in slow-runner.ts),
        // not by the engine's Default.
        assert_eq!(s.joint_update, JointUpdate::Off);
        assert_eq!(sv.joint_update, ClusterUpdate::All);
        assert!(s.merge_guard_min_sep.is_infinite());
        assert_eq!(sv.merge_guard_min_sep, Some(0.6));

        // Visit rate: the fixed schedule.
        let vs = VisitSchedule::fixed();
        assert_eq!(v.visit.auto, vs.auto);
        assert_eq!(v.visit.target, vs.target);

        // Trace solve and QC pass rule.
        let so = SolverConfig::default();
        assert_eq!(v.trace.tol as f32, so.tol);
        assert_eq!(v.trace.max_sweeps, so.max_sweeps);
        let qc = QcConfig::for_fps(fps);
        assert_eq!(v.qc.min_snr as f32, qc.pass.min_snr);
        assert_eq!(v.qc.pair_r as f32, qc.pass.pair_r);
        assert_eq!(v.qc.motion_r2_flag as f32, qc.motion_r2_flag);
    }
}
