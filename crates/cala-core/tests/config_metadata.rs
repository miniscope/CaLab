//! Tests for `RecordingMetadata`, `PreprocessConfig`, and the
//! Butterworth cutoff derivation.
//!
//! Every tuning knob — `neuron_diameter_um`, `high_pass_diameters` (K),
//! `high_pass_order` — has a documented default (sourced from a
//! `DEFAULT_*` constant) and is overridable through a builder method.
//! Algorithm code never reads the DEFAULT_* constant directly;
//! it reads from the config struct the caller passed in.

use calab_cala_core::config::{
    ComponentClass, ExtendConfig, FitConfig, PreprocessConfig, RecordingMetadata,
    DEFAULT_CELL_COMPACTNESS_MIN, DEFAULT_CELL_DIAMETER_MAX_D, DEFAULT_CELL_DIAMETER_MIN_D,
    DEFAULT_COMPONENT_CLASS, DEFAULT_EXTEND_WINDOW_FRAMES, DEFAULT_FOOTPRINT_MAX_ITER,
    DEFAULT_HIGH_PASS_DIAMETERS, DEFAULT_HIGH_PASS_ORDER, DEFAULT_MOTION_MAX_SHIFT_PX,
    DEFAULT_MOTION_USE_GLOBAL_ANCHOR, DEFAULT_MUTATION_QUEUE_CAPACITY,
    DEFAULT_NEURON_DIAMETER_UM, DEFAULT_NEUROPIL_DIAMETER_MAX_D,
    DEFAULT_NEUROPIL_DIAMETER_MIN_D, DEFAULT_NMF_MAX_ITER, DEFAULT_NMF_TOL,
    DEFAULT_OVERLAP_FRACTION_MIN, DEFAULT_PATCH_MIN_VARIANCE, DEFAULT_PATCH_RADIUS_DIAMETERS,
    DEFAULT_PROPOSALS_PER_CYCLE_MAX, DEFAULT_RECON_ERROR_MAX, DEFAULT_SNR_C0,
    DEFAULT_TRACE_CORR_MIN, DEFAULT_TRACE_MAX_ITER, DEFAULT_TRACE_TOL,
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

// ----- FitConfig -----

#[test]
fn fit_config_default_uses_defaults() {
    let cfg = FitConfig::default();
    assert_close(cfg.trace_tol, DEFAULT_TRACE_TOL, "trace_tol default");
    assert_eq!(cfg.trace_max_iter, DEFAULT_TRACE_MAX_ITER);
    assert_eq!(cfg.footprint_max_iter, DEFAULT_FOOTPRINT_MAX_ITER);
    assert_close(cfg.snr_c0, DEFAULT_SNR_C0, "snr_c0 default");
}

#[test]
fn fit_config_builder_overrides_are_independent() {
    let cfg = FitConfig::default()
        .with_trace_tol(5e-4)
        .with_trace_max_iter(50)
        .with_footprint_max_iter(3)
        .with_snr_c0(2.5);
    assert_close(cfg.trace_tol, 5e-4, "trace_tol override");
    assert_eq!(cfg.trace_max_iter, 50);
    assert_eq!(cfg.footprint_max_iter, 3);
    assert_close(cfg.snr_c0, 2.5, "snr_c0 override");
}

#[test]
#[should_panic(expected = "trace_tol must be positive")]
fn fit_config_rejects_nonpositive_tol() {
    let _ = FitConfig::default().with_trace_tol(0.0);
}

#[test]
#[should_panic(expected = "trace_max_iter must be ≥ 1")]
fn fit_config_rejects_zero_trace_iter() {
    let _ = FitConfig::default().with_trace_max_iter(0);
}

#[test]
#[should_panic(expected = "snr_c0 must be non-negative")]
fn fit_config_rejects_negative_snr_c0() {
    let _ = FitConfig::default().with_snr_c0(-0.1);
}

// ----- ExtendConfig -----

#[test]
fn default_component_class_is_cell() {
    // The default class applied to components registered without an
    // explicit tag (back-compat with Phase 2 callers) is `Cell`.
    const _: () = match DEFAULT_COMPONENT_CLASS {
        ComponentClass::Cell => (),
        _ => panic!("DEFAULT_COMPONENT_CLASS must be ComponentClass::Cell"),
    };
}

#[test]
fn extend_config_default_uses_defaults() {
    let cfg = ExtendConfig::default();
    assert_eq!(cfg.extend_window_frames, DEFAULT_EXTEND_WINDOW_FRAMES);
    assert_close(
        cfg.patch_radius_diameters,
        DEFAULT_PATCH_RADIUS_DIAMETERS,
        "patch_radius_diameters",
    );
    assert_close(
        cfg.patch_min_variance,
        DEFAULT_PATCH_MIN_VARIANCE,
        "patch_min_variance",
    );
    assert_eq!(cfg.nmf_max_iter, DEFAULT_NMF_MAX_ITER);
    assert_close(cfg.nmf_tol, DEFAULT_NMF_TOL, "nmf_tol");
    assert_close(
        cfg.recon_error_max,
        DEFAULT_RECON_ERROR_MAX,
        "recon_error_max",
    );
    assert_close(
        cfg.cell_diameter_min_d,
        DEFAULT_CELL_DIAMETER_MIN_D,
        "cell_diameter_min_d",
    );
    assert_close(
        cfg.cell_diameter_max_d,
        DEFAULT_CELL_DIAMETER_MAX_D,
        "cell_diameter_max_d",
    );
    assert_close(
        cfg.neuropil_diameter_min_d,
        DEFAULT_NEUROPIL_DIAMETER_MIN_D,
        "neuropil_diameter_min_d",
    );
    assert_close(
        cfg.neuropil_diameter_max_d,
        DEFAULT_NEUROPIL_DIAMETER_MAX_D,
        "neuropil_diameter_max_d",
    );
    assert_close(
        cfg.cell_compactness_min,
        DEFAULT_CELL_COMPACTNESS_MIN,
        "cell_compactness_min",
    );
    assert_close(
        cfg.overlap_fraction_min,
        DEFAULT_OVERLAP_FRACTION_MIN,
        "overlap_fraction_min",
    );
    assert_close(cfg.trace_corr_min, DEFAULT_TRACE_CORR_MIN, "trace_corr_min");
    assert_eq!(cfg.mutation_queue_capacity, DEFAULT_MUTATION_QUEUE_CAPACITY);
    assert_eq!(cfg.proposals_per_cycle_max, DEFAULT_PROPOSALS_PER_CYCLE_MAX);
}

#[test]
fn extend_config_builder_overrides_are_independent() {
    let cfg = ExtendConfig::default()
        .with_extend_window_frames(120)
        .with_patch_radius_diameters(2.0)
        .with_patch_min_variance(1e-3)
        .with_nmf_max_iter(100)
        .with_nmf_tol(1e-5)
        .with_recon_error_max(0.3)
        .with_cell_diameter_range(0.4, 1.8)
        .with_neuropil_diameter_range(2.5, 12.0)
        .with_cell_compactness_min(0.7)
        .with_overlap_fraction_min(0.4)
        .with_trace_corr_min(0.9)
        .with_mutation_queue_capacity(64)
        .with_proposals_per_cycle_max(8);
    assert_eq!(cfg.extend_window_frames, 120);
    assert_close(cfg.patch_radius_diameters, 2.0, "patch_radius override");
    assert_close(cfg.patch_min_variance, 1e-3, "patch_min_variance override");
    assert_eq!(cfg.nmf_max_iter, 100);
    assert_close(cfg.nmf_tol, 1e-5, "nmf_tol override");
    assert_close(cfg.recon_error_max, 0.3, "recon_error_max override");
    assert_close(cfg.cell_diameter_min_d, 0.4, "cell min override");
    assert_close(cfg.cell_diameter_max_d, 1.8, "cell max override");
    assert_close(cfg.neuropil_diameter_min_d, 2.5, "neuropil min override");
    assert_close(cfg.neuropil_diameter_max_d, 12.0, "neuropil max override");
    assert_close(cfg.cell_compactness_min, 0.7, "compactness override");
    assert_close(cfg.overlap_fraction_min, 0.4, "overlap override");
    assert_close(cfg.trace_corr_min, 0.9, "trace_corr override");
    assert_eq!(cfg.mutation_queue_capacity, 64);
    assert_eq!(cfg.proposals_per_cycle_max, 8);
}

#[test]
#[should_panic(expected = "extend_window_frames must be ≥ 1")]
fn extend_config_rejects_zero_window() {
    let _ = ExtendConfig::default().with_extend_window_frames(0);
}

#[test]
#[should_panic(expected = "patch_radius_diameters must be positive")]
fn extend_config_rejects_nonpositive_patch_radius() {
    let _ = ExtendConfig::default().with_patch_radius_diameters(0.0);
}

#[test]
#[should_panic(expected = "patch_min_variance must be non-negative")]
fn extend_config_rejects_negative_min_variance() {
    let _ = ExtendConfig::default().with_patch_min_variance(-1.0);
}

#[test]
#[should_panic(expected = "nmf_max_iter must be ≥ 1")]
fn extend_config_rejects_zero_nmf_iter() {
    let _ = ExtendConfig::default().with_nmf_max_iter(0);
}

#[test]
#[should_panic(expected = "nmf_tol must be positive")]
fn extend_config_rejects_nonpositive_nmf_tol() {
    let _ = ExtendConfig::default().with_nmf_tol(0.0);
}

#[test]
#[should_panic(expected = "recon_error_max must be positive")]
fn extend_config_rejects_nonpositive_recon_error() {
    let _ = ExtendConfig::default().with_recon_error_max(0.0);
}

#[test]
#[should_panic(expected = "cell diameter range")]
fn extend_config_rejects_inverted_cell_range() {
    let _ = ExtendConfig::default().with_cell_diameter_range(1.5, 0.5);
}

#[test]
#[should_panic(expected = "neuropil diameter range")]
fn extend_config_rejects_inverted_neuropil_range() {
    let _ = ExtendConfig::default().with_neuropil_diameter_range(10.0, 2.0);
}

#[test]
#[should_panic(expected = "cell_compactness_min must be in [0, 1]")]
fn extend_config_rejects_out_of_range_compactness() {
    let _ = ExtendConfig::default().with_cell_compactness_min(1.5);
}

#[test]
#[should_panic(expected = "overlap_fraction_min must be in [0, 1]")]
fn extend_config_rejects_out_of_range_overlap() {
    let _ = ExtendConfig::default().with_overlap_fraction_min(1.1);
}

#[test]
#[should_panic(expected = "trace_corr_min must be in [-1, 1]")]
fn extend_config_rejects_out_of_range_corr() {
    let _ = ExtendConfig::default().with_trace_corr_min(1.5);
}

#[test]
#[should_panic(expected = "mutation_queue_capacity must be ≥ 1")]
fn extend_config_rejects_zero_queue_capacity() {
    let _ = ExtendConfig::default().with_mutation_queue_capacity(0);
}

#[test]
#[should_panic(expected = "proposals_per_cycle_max must be ≥ 1")]
fn extend_config_rejects_zero_proposals_cap() {
    let _ = ExtendConfig::default().with_proposals_per_cycle_max(0);
}

#[test]
fn extend_config_cell_neuropil_ranges_are_ordered() {
    let cfg = ExtendConfig::default();
    assert!(cfg.cell_diameter_max_d <= cfg.neuropil_diameter_min_d,
        "defaults should leave an ambiguous gap (or be flush) between cell and neuropil classes"
    );
    assert!(cfg.neuropil_diameter_min_d < cfg.neuropil_diameter_max_d);
}
