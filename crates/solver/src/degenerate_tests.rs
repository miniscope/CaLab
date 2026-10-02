//! Degenerate-input tests for the validated (FFI-facing) entry points.
//!
//! Each case here used to panic (a WASM trap that kills the worker's module),
//! abort on allocation, or silently return garbage. They now either work or
//! return a `SolverError`, and the solver stays usable afterwards.

use crate::banded::BandedAR2;
use crate::kernel::build_kernel;
use crate::validate::{self, SolverError};
use crate::{ConvMode, Solver};

const MODES: [ConvMode; 2] = [ConvMode::Fft, ConvMode::BandedAR2];

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
fn empty_trace() {
    for mode in MODES {
        let mut s = solver(mode);
        s.set_trace(&[]).unwrap();
        s.subtract_baseline();
        assert!(s.step_batch(10).unwrap());
        assert!(s.get_solution().is_empty());
        assert!(s.get_reconvolution_with_baseline().is_empty());
        assert_eq!(s.get_baseline(), 0.0);
    }
}

#[test]
fn length_one_and_constant_traces() {
    for mode in MODES {
        for trace in [vec![1.0_f32], vec![3.0_f32; 64], vec![0.0_f32; 64]] {
            let mut s = solver(mode);
            s.set_trace(&trace).unwrap();
            s.subtract_baseline();
            run(&mut s);
            assert!(s.get_solution().iter().all(|v| v.is_finite()));
            assert!(s.get_baseline().is_finite());
        }
    }
}

#[test]
fn non_finite_trace_rejected_and_solver_still_usable() {
    for mode in MODES {
        let mut s = solver(mode);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut t = vec![0.5_f32; 50];
            t[7] = bad;
            let err = s.set_trace(&t).unwrap_err();
            assert!(matches!(err, SolverError::InvalidInput(_)));
            assert!(err.to_string().contains("index 7"), "{err}");
        }
        // Still usable afterwards.
        s.set_trace(&spiky_trace(200, 0.02, 0.4, 30.0)).unwrap();
        run(&mut s);
        assert!(s.get_solution().iter().any(|&v| v > 0.0));
    }
}

#[test]
fn overflowing_trace_errors_instead_of_panicking() {
    // Finite but enormous: the FFT overflows f32 and goes non-finite. This used
    // to panic in realfft's `.unwrap()`; now it is a recoverable error (or, if
    // the arithmetic happens to stay finite, a finite result).
    let mut s = solver(ConvMode::Fft);
    s.set_trace(&[3.0e38_f32; 64]).unwrap();
    match s.step_batch(5) {
        Err(SolverError::Numerical(_)) => {}
        Err(e) => panic!("unexpected error kind {e}"),
        Ok(_) => {}
    }
    // A fresh trace recovers.
    s.set_trace(&spiky_trace(100, 0.02, 0.4, 30.0)).unwrap();
    run(&mut s);
}

#[test]
fn invalid_params_rejected_and_state_unchanged() {
    let mut s = solver(ConvMode::Fft);
    let kernel_before = s.get_kernel();
    let cases = [
        (0.4, 0.02, 0.01, 30.0),      // reversed taus
        (0.4, 0.4, 0.01, 30.0),       // equal taus
        (0.02, 0.4, 0.01, 0.0),       // fs = 0
        (0.02, 0.4, 0.01, -30.0),     // fs < 0
        (0.02, 0.4, -0.1, 30.0),      // negative lambda
        (0.02, f64::NAN, 0.01, 30.0), // NaN tau
        (0.02, 1.0e12, 0.01, 30.0),   // kernel would abort on allocation
        (0.02, 0.4, 0.01, f64::INFINITY),
    ];
    for (tr, td, lam, fs) in cases {
        let err = s.set_params(tr, td, lam, fs).unwrap_err();
        assert!(
            matches!(err, SolverError::InvalidParams(_)),
            "({tr},{td},{lam},{fs}): {err}"
        );
        assert_eq!(
            s.get_kernel(),
            kernel_before,
            "state changed on rejected params"
        );
    }
}

#[test]
fn reversed_taus_no_longer_disagree_between_modes() {
    // Previously FFT mode built an all-negative kernel for tau_rise > tau_decay
    // while banded mode built a positive one. Both are now rejected up front.
    for mode in MODES {
        let mut s = Solver::new();
        s.set_conv_mode(mode);
        assert!(s.set_params(0.5, 0.05, 0.01, 30.0).is_err());
    }
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

#[test]
fn threshold_search_on_empty_trace_has_finite_baseline() {
    let banded = BandedAR2::new(0.02, 0.4, 30.0);
    let r = crate::threshold::threshold_search_opts(
        &[],
        &[],
        &banded,
        0.4,
        30.0,
        1,
        f64::INFINITY,
        crate::threshold::Selection::MaxPve,
    );
    assert_eq!(r.baseline, 0.0);
}

#[test]
fn indeca_param_checks() {
    // upsample_factor = 0 made fs_up = 0.
    assert!(validate::validate_indeca_params(100, 0.02, 0.4, 30.0, 0, 0.0, 1e-4).is_err());
    // The kernel cap applies at the upsampled rate.
    assert!(validate::validate_indeca_params(100, 0.02, 4000.0, 30.0, 10, 0.0, 1e-4).is_err());
    assert!(validate::validate_indeca_params(100, 0.02, 0.4, 30.0, 10, 0.0, 1e-4).is_ok());
    assert!(validate::validate_upsample_rates(0.0, 300.0).is_err());
    assert!(validate::validate_upsample_rates(30.0, f64::NAN).is_err());
    assert!(validate::validate_upsample_rates(30.0, 300.0).is_ok());
}

#[test]
fn negative_and_overflowing_lengths() {
    assert!(validate::lengths_from_i64(&[10, -1]).is_err());
    // u32 lengths summing past usize on wasm32 / any overflow natively.
    assert!(validate::checked_total_len(&[usize::MAX, 2]).is_err());
}
