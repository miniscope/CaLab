//! Property tests: random finite inputs never panic the public `Solver` API.
//!
//! Each case drives a solver through a random sequence of the operations the
//! bindings expose (set_params with in- and out-of-range values, set_trace,
//! step_batch, mode/constraint/filter toggles, baseline subtraction, getters,
//! warm-start load) and checks the invariants the FFI layers rely on:
//!
//! - nothing panics (a panic is a WASM trap or a Python `PanicException`);
//! - every `Err` is a `SolverError` of the expected kind;
//! - output lengths always match the loaded trace;
//! - after any successful `step_batch` the solution is finite.
//!
//! Case count is modest so `cargo test` stays fast in debug builds; raise it
//! locally with `PROPTEST_CASES=5000 cargo test --test solver_proptest`.

use calab_solver::{Constraint, ConvMode, Solver, SolverError};
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    SetParams(f64, f64, f64, f64),
    SetTrace(Vec<f32>),
    Step(u32),
    Mode(bool),
    Box01(bool),
    Filter(bool, bool),
    ApplyFilter,
    SubtractBaseline,
    ResetMomentum,
    ReloadState,
    LoadBytes(Vec<u8>),
    Poll,
}

/// Mostly-plausible parameter values plus edge values the validator must catch.
fn param() -> impl Strategy<Value = f64> {
    prop_oneof![
        6 => 1e-3..5.0_f64,
        1 => Just(0.0),
        1 => -5.0..0.0_f64,
        1 => Just(1e-300),
        1 => 1e3..1e9_f64,
    ]
}

fn fs() -> impl Strategy<Value = f64> {
    prop_oneof![
        6 => 1.0..1000.0_f64,
        1 => Just(0.0),
        1 => -100.0..0.0_f64,
        1 => 1e-6..1.0_f64,
    ]
}

fn trace() -> impl Strategy<Value = Vec<f32>> {
    let value = prop_oneof![
        8 => -10.0..10.0_f32,
        1 => -1e6..1e6_f32,
        1 => Just(0.0_f32),
    ];
    prop::collection::vec(value, 0..256)
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (param(), param(), prop_oneof![0.0..1.0_f64, -1.0..0.0_f64], fs())
            .prop_map(|(a, b, l, f)| Op::SetParams(a, b, l, f)),
        3 => trace().prop_map(Op::SetTrace),
        4 => (0_u32..30).prop_map(Op::Step),
        1 => any::<bool>().prop_map(Op::Mode),
        1 => any::<bool>().prop_map(Op::Box01),
        1 => (any::<bool>(), any::<bool>()).prop_map(|(h, l)| Op::Filter(h, l)),
        1 => Just(Op::ApplyFilter),
        1 => Just(Op::SubtractBaseline),
        1 => Just(Op::ResetMomentum),
        1 => Just(Op::ReloadState),
        1 => prop::collection::vec(any::<u8>(), 0..64).prop_map(Op::LoadBytes),
        2 => Just(Op::Poll),
    ]
}

/// 64 cases by default; `PROPTEST_CASES` overrides (an explicit `cases` in
/// the config would otherwise shadow the env var).
fn case_count() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64)
}

fn check_lengths(s: &mut Solver, n: usize) -> Result<(), TestCaseError> {
    prop_assert_eq!(s.get_solution().len(), n);
    prop_assert_eq!(s.get_trace().len(), n);
    prop_assert_eq!(s.get_reconvolution().len(), n);
    prop_assert_eq!(s.get_reconvolution_with_baseline().len(), n);
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: case_count(),
        // Shrinking re-runs whole op sequences; keep it bounded.
        max_shrink_iters: 256,
        ..ProptestConfig::default()
    })]

    #[test]
    fn random_operation_sequences_never_panic(ops in prop::collection::vec(op(), 1..24)) {
        let mut s = Solver::new();
        let mut n = 0_usize;
        for op in ops {
            match op {
                Op::SetParams(tr, td, lam, fs) => {
                    let kernel_before = s.get_kernel();
                    match s.set_params(tr, td, lam, fs) {
                        Ok(()) => {
                            let k = s.get_kernel();
                            prop_assert!(k.len() >= 2 && k.len() <= 1 << 20);
                            prop_assert!(k.iter().all(|v| v.is_finite()));
                        }
                        Err(e) => {
                            prop_assert!(matches!(e, SolverError::InvalidParams(_)), "{}", e);
                            prop_assert_eq!(s.get_kernel(), kernel_before);
                        }
                    }
                }
                Op::SetTrace(t) => {
                    s.set_trace(&t).unwrap();
                    n = t.len();
                }
                Op::Step(k) => match s.step_batch(k) {
                    Ok(_) => {
                        prop_assert!(s.get_solution().iter().all(|v| v.is_finite()));
                    }
                    // Overflow on extreme (but finite) data is reported, not hidden.
                    Err(e) => prop_assert!(matches!(e, SolverError::Numerical(_)), "{}", e),
                },
                Op::Mode(banded) => s.set_conv_mode(if banded {
                    ConvMode::BandedAR2
                } else {
                    ConvMode::Fft
                }),
                Op::Box01(b) => s.set_constraint(if b {
                    Constraint::Box01
                } else {
                    Constraint::NonNegative
                }),
                Op::Filter(hp, lp) => {
                    s.set_hp_filter_enabled(hp);
                    s.set_lp_filter_enabled(lp);
                }
                Op::ApplyFilter => {
                    s.apply_filter();
                    prop_assert!(s.get_trace().iter().all(|v| v.is_finite()));
                }
                Op::SubtractBaseline => {
                    s.subtract_baseline();
                    prop_assert!(s.get_trace().iter().all(|v| v.is_finite()));
                }
                Op::ResetMomentum => s.reset_momentum(),
                Op::ReloadState => {
                    let st = s.export_state();
                    s.load_state(&st);
                    prop_assert_eq!(s.export_state(), st);
                }
                Op::LoadBytes(b) => s.load_state(&b),
                Op::Poll => {
                    let b = s.get_baseline();
                    prop_assert!(!b.is_nan());
                    let _ = s.get_power_spectrum();
                    let _ = s.get_spectrum_frequencies();
                    let _ = s.get_filter_cutoffs();
                    let _ = (s.converged(), s.iteration_count(), s.filter_enabled());
                }
            }
            check_lengths(&mut s, n)?;
        }
    }

    #[test]
    fn non_finite_samples_anywhere_are_rejected(
        mut t in prop::collection::vec(-1e3..1e3_f32, 1..200),
        idx in any::<prop::sample::Index>(),
        bad in prop_oneof![Just(f32::NAN), Just(f32::INFINITY), Just(f32::NEG_INFINITY)],
    ) {
        let i = idx.index(t.len());
        t[i] = bad;
        let mut s = Solver::new();
        let err = s.set_trace(&t).unwrap_err();
        prop_assert!(matches!(err, SolverError::InvalidInput(_)));
        let msg = err.to_string();
        prop_assert!(msg.contains(&format!("index {i}")), "{}", msg);
        prop_assert!(s.get_trace().is_empty());
    }

    #[test]
    fn valid_params_always_yield_a_finite_solve(
        tau_rise in 1e-3..1.0_f64,
        ratio in 1.05..50.0_f64,
        lambda in 0.0..1.0_f64,
        fs in 1.0..500.0_f64,
        t in prop::collection::vec(-5.0..5.0_f32, 0..300),
        banded in any::<bool>(),
    ) {
        let tau_decay = tau_rise * ratio;
        let mut s = Solver::new();
        s.set_conv_mode(if banded { ConvMode::BandedAR2 } else { ConvMode::Fft });
        // Skip combinations whose kernel would exceed the 2^20 cap.
        prop_assume!(13.82 * tau_decay * fs < (1 << 20) as f64);
        s.set_params(tau_rise, tau_decay, lambda, fs).unwrap();
        s.set_trace(&t).unwrap();
        for _ in 0..10 {
            if s.step_batch(20).unwrap() {
                break;
            }
        }
        prop_assert!(s.get_solution().iter().all(|v| v.is_finite() && *v >= 0.0));
        prop_assert!(s.get_reconvolution_with_baseline().iter().all(|v| v.is_finite()));
        prop_assert!(s.get_baseline().is_finite());
    }
}
