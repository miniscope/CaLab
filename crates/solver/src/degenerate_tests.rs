//! Degenerate-input tests for the validated (FFI-facing) entry points.
//!
//! Each case here is a call sequence that used to panic (a WASM trap that
//! kills the worker's module) and must now match a fresh solve.
//!
//! `ffi_surface` covers the free functions each binding exports; the public
//! `Solver` API is covered by `tests/solver_degenerate.rs`.

mod ffi_surface;

use crate::kernel::build_kernel;
use crate::{ConvMode, Solver};

fn solver(mode: ConvMode) -> Solver {
    let mut s = Solver::new();
    s.set_conv_mode(mode);
    s.set_params(0.02, 0.4, 0.01, 30.0).unwrap();
    s
}

fn run(s: &mut Solver) {
    for _ in 0..100 {
        if s.step_batch(20).unwrap() {
            break;
        }
    }
}

fn spiky_trace(n: usize, tau_r: f64, tau_d: f64, fs: f64) -> Vec<f32> {
    let k = build_kernel(tau_r, tau_d, fs);
    let mut t = vec![0.1_f32; n];
    for &sp in &[n / 5, n / 2, 4 * n / 5] {
        for (j, &kv) in k.iter().enumerate() {
            if sp + j < n {
                t[sp + j] += kv;
            }
        }
    }
    t
}

#[test]
fn longer_kernel_after_set_trace_in_fft_mode() {
    // set_params with a longer kernel after set_trace used to invalidate the
    // FFT plan, and the next step_batch panicked ("slice index starts at 100
    // but ends at 0"). It must now rebuild and match a fresh solve.
    let trace = spiky_trace(100, 0.02, 0.4, 30.0);
    let mut s = solver(ConvMode::Fft);
    s.set_trace(&trace).unwrap();
    s.step_batch(3).unwrap();
    s.set_params(0.02, 4.0, 0.01, 30.0).unwrap(); // kernel 13 -> ~1660 samples
    s.set_trace(&trace).unwrap();
    run(&mut s);

    let mut fresh = Solver::new();
    fresh.set_params(0.02, 4.0, 0.01, 30.0).unwrap();
    fresh.set_trace(&trace).unwrap();
    run(&mut fresh);
    assert_eq!(s.get_solution(), fresh.get_solution());

    // And without the intervening set_trace (the exact reported sequence).
    let mut s2 = solver(ConvMode::Fft);
    s2.set_trace(&trace).unwrap();
    s2.set_params(0.02, 4.0, 0.01, 30.0).unwrap();
    run(&mut s2);
    assert!(s2.get_solution().iter().all(|v| v.is_finite()));
}

#[test]
fn params_changed_in_banded_then_switch_to_fft_uses_current_kernel() {
    let trace = spiky_trace(300, 0.02, 0.4, 30.0);
    let mut s = Solver::new();
    s.set_params(0.02, 0.4, 0.01, 30.0).unwrap();
    s.set_trace(&trace).unwrap(); // FFT plan + kernel spectrum for tau_d = 0.4
    s.set_conv_mode(ConvMode::BandedAR2);
    s.set_params(0.03, 0.5, 0.01, 30.0).unwrap(); // same padded FFT length
    s.set_conv_mode(ConvMode::Fft);
    s.set_trace(&trace).unwrap();
    run(&mut s);

    let mut fresh = Solver::new();
    fresh.set_params(0.03, 0.5, 0.01, 30.0).unwrap();
    fresh.set_trace(&trace).unwrap();
    run(&mut fresh);
    assert_eq!(s.get_solution(), fresh.get_solution());
}

#[test]
fn filter_toggle_rebuilds_gain_curve() {
    // HP-only apply, then enable LP too on a same-length trace: must apply the
    // full bandpass, not the cached HP-only gain curve.
    let trace: Vec<f32> = (0..512)
        .map(|i| {
            let t = i as f32 / 30.0;
            (0.05 * t).sin() + 0.3 * (2.0 * std::f32::consts::PI * 12.0 * t).sin()
        })
        .collect();

    let mut toggled = solver(ConvMode::Fft);
    toggled.set_hp_filter_enabled(true);
    toggled.set_lp_filter_enabled(false);
    toggled.set_trace(&trace).unwrap();
    assert!(toggled.apply_filter());
    toggled.set_lp_filter_enabled(true);
    toggled.set_trace(&trace).unwrap();
    assert!(toggled.apply_filter());

    let mut fresh = solver(ConvMode::Fft);
    fresh.set_hp_filter_enabled(true);
    fresh.set_lp_filter_enabled(true);
    fresh.set_trace(&trace).unwrap();
    assert!(fresh.apply_filter());

    assert_eq!(toggled.get_trace(), fresh.get_trace());
}
