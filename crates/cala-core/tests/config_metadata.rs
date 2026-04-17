//! Tests for `RecordingMetadata`, `PreprocessConfig`, and the
//! Butterworth cutoff derivation.
//!
//! Every tuning knob — `neuron_diameter_um`, `high_pass_diameters` (K),
//! `high_pass_order` — has a documented default (sourced from a
//! `DEFAULT_*` constant) and is overridable through a builder method.
//! Algorithm code never reads the DEFAULT_* constant directly;
//! it reads from the config struct the caller passed in.

use calab_cala_core::config::{
    PreprocessConfig, RecordingMetadata, DEFAULT_HIGH_PASS_DIAMETERS, DEFAULT_HIGH_PASS_ORDER,
    DEFAULT_MOTION_MAX_SHIFT_PX, DEFAULT_MOTION_USE_GLOBAL_ANCHOR, DEFAULT_NEURON_DIAMETER_UM,
};
use calab_cala_core::preprocess::high_pass_cutoff_cycles_per_pixel;

const F32_TOL: f32 = 1e-6;

fn assert_close(actual: f32, expected: f32, ctx: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= F32_TOL,
        "{ctx}: expected {expected}, got {actual} (diff {diff} > tol {F32_TOL})"
    );
}

// ----- RecordingMetadata -----

#[test]
fn default_neuron_diameter_is_ten_microns() {
    assert_close(DEFAULT_NEURON_DIAMETER_UM, 10.0, "default neuron diameter");
}

#[test]
fn new_metadata_uses_default_neuron_diameter() {
    let md = RecordingMetadata::new(2.0);
    assert_close(md.pixel_size_um, 2.0, "pixel_size_um");
    assert_close(
        md.neuron_diameter_um,
        DEFAULT_NEURON_DIAMETER_UM,
        "neuron_diameter_um defaults",
    );
}

#[test]
fn with_neuron_diameter_overrides_default() {
    let md = RecordingMetadata::new(1.5).with_neuron_diameter(15.0);
    assert_close(md.pixel_size_um, 1.5, "pixel_size_um preserved");
    assert_close(md.neuron_diameter_um, 15.0, "neuron_diameter_um override");
}

// ----- PreprocessConfig -----

#[test]
fn default_high_pass_constants_match_design() {
    assert_close(DEFAULT_HIGH_PASS_DIAMETERS, 3.0, "K multiplier default");
    assert_eq!(DEFAULT_HIGH_PASS_ORDER, 4, "Butterworth order default");
}

#[test]
fn preprocess_config_default_uses_defaults() {
    let cfg = PreprocessConfig::default();
    assert_close(cfg.high_pass_diameters, DEFAULT_HIGH_PASS_DIAMETERS, "K");
    assert_eq!(cfg.high_pass_order, DEFAULT_HIGH_PASS_ORDER, "order");
}

#[test]
fn with_high_pass_diameters_overrides_k() {
    let cfg = PreprocessConfig::default().with_high_pass_diameters(2.5);
    assert_close(cfg.high_pass_diameters, 2.5, "K override");
    assert_eq!(
        cfg.high_pass_order, DEFAULT_HIGH_PASS_ORDER,
        "order untouched"
    );
}

#[test]
fn with_high_pass_order_overrides_order() {
    let cfg = PreprocessConfig::default().with_high_pass_order(6);
    assert_eq!(cfg.high_pass_order, 6, "order override");
    assert_close(
        cfg.high_pass_diameters,
        DEFAULT_HIGH_PASS_DIAMETERS,
        "K untouched",
    );
}

#[test]
fn builder_methods_chain() {
    let cfg = PreprocessConfig::default()
        .with_high_pass_diameters(2.0)
        .with_high_pass_order(8)
        .with_motion_max_shift_px(8);
    assert_close(cfg.high_pass_diameters, 2.0, "K");
    assert_eq!(cfg.high_pass_order, 8, "order");
    assert_eq!(cfg.motion_max_shift_px, 8, "max shift");
}

#[test]
fn default_motion_max_shift_matches_constant() {
    assert_eq!(DEFAULT_MOTION_MAX_SHIFT_PX, 20);
    let cfg = PreprocessConfig::default();
    assert_eq!(cfg.motion_max_shift_px, DEFAULT_MOTION_MAX_SHIFT_PX);
}

#[test]
fn with_motion_max_shift_px_overrides_default() {
    let cfg = PreprocessConfig::default().with_motion_max_shift_px(10);
    assert_eq!(cfg.motion_max_shift_px, 10);
    assert_close(
        cfg.high_pass_diameters,
        DEFAULT_HIGH_PASS_DIAMETERS,
        "K untouched",
    );
    assert_eq!(
        cfg.high_pass_order, DEFAULT_HIGH_PASS_ORDER,
        "order untouched"
    );
}

#[test]
fn default_motion_use_global_anchor_is_on() {
    // Static assertion: if someone flips DEFAULT_MOTION_USE_GLOBAL_ANCHOR
    // to false, this fails to compile — the on-by-default contract is
    // design-level (dual-anchor is required per §3), not a runtime opt-in.
    const _: () = assert!(DEFAULT_MOTION_USE_GLOBAL_ANCHOR);
    let cfg = PreprocessConfig::default();
    assert_eq!(
        cfg.motion_use_global_anchor,
        DEFAULT_MOTION_USE_GLOBAL_ANCHOR
    );
}

#[test]
fn with_motion_use_global_anchor_overrides_default() {
    let cfg = PreprocessConfig::default().with_motion_use_global_anchor(false);
    assert!(!cfg.motion_use_global_anchor);
    assert_eq!(
        cfg.motion_max_shift_px, DEFAULT_MOTION_MAX_SHIFT_PX,
        "other motion knobs untouched"
    );
}

// ----- Cutoff derivation -----

#[test]
fn cutoff_derivation_matches_hand_computed_value() {
    // pixel_size_um = 2.0, neuron_diameter_um = 10.0 (default) → 5 px/neuron.
    // K = 3 (default) → cutoff period = 15 px → cutoff = 1/15 cyc/px.
    let md = RecordingMetadata::new(2.0);
    let cfg = PreprocessConfig::default();
    let cutoff = high_pass_cutoff_cycles_per_pixel(&md, &cfg);
    assert_close(cutoff, 1.0 / 15.0, "derived cutoff");
}

#[test]
fn cutoff_scales_inversely_with_neuron_diameter() {
    let cfg = PreprocessConfig::default();
    let md_small = RecordingMetadata::new(1.0).with_neuron_diameter(10.0);
    let md_large = RecordingMetadata::new(1.0).with_neuron_diameter(20.0);
    let f_small = high_pass_cutoff_cycles_per_pixel(&md_small, &cfg);
    let f_large = high_pass_cutoff_cycles_per_pixel(&md_large, &cfg);
    assert_close(f_large * 2.0, f_small, "cutoff ∝ 1/d");
}

#[test]
fn cutoff_scales_with_pixel_size() {
    let cfg = PreprocessConfig::default();
    let md_coarse = RecordingMetadata::new(2.0); // neuron = 5 px
    let md_fine = RecordingMetadata::new(1.0); // neuron = 10 px
    let f_coarse = high_pass_cutoff_cycles_per_pixel(&md_coarse, &cfg);
    let f_fine = high_pass_cutoff_cycles_per_pixel(&md_fine, &cfg);
    assert_close(f_coarse, 2.0 * f_fine, "cutoff doubles when pixel doubles");
}

#[test]
fn overriding_k_changes_derived_cutoff() {
    // Algorithm code reads from the passed-in config, not from the
    // DEFAULT_* constant. Overriding K in cfg must change the derived cutoff.
    let md = RecordingMetadata::new(2.0); // neuron = 5 px
    let cfg_tight = PreprocessConfig::default().with_high_pass_diameters(2.0);
    let cfg_loose = PreprocessConfig::default().with_high_pass_diameters(5.0);
    let f_tight = high_pass_cutoff_cycles_per_pixel(&md, &cfg_tight);
    let f_loose = high_pass_cutoff_cycles_per_pixel(&md, &cfg_loose);
    assert_close(f_tight, 1.0 / 10.0, "K=2 → cutoff period 10 px");
    assert_close(f_loose, 1.0 / 25.0, "K=5 → cutoff period 25 px");
}
