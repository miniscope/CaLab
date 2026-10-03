//! Degenerate-input tests for the public `Solver` API — the surface both FFI
//! layers wrap (`jsbindings` exports these methods directly; `pybindings`
//! wraps them in `PySolver` and the one-shot `deconvolve_*` functions).
//!
//! The contract under test: every input either works (finite output) or is
//! rejected with a `SolverError`, never a panic, and a rejected call leaves
//! the solver exactly as it was. The validation layer itself (`validate.rs`)
//! has its own unit tests; this file checks that the entry points actually
//! route through it, in every convolution mode and constraint, and that state
//! stays consistent across call sequences (parameter changes after
//! `set_trace`, getters before any solve, repeated getters).
//!
//! Complements `src/degenerate_tests.rs` (in-crate regressions for specific
//! fixed panics); this file only touches the public API.

use calab_solver::{Constraint, ConvMode, Solver, SolverError};

/// `validate::MAX_KERNEL_LEN` (crate-private): kernels are capped at 2^20 samples.
const MAX_KERNEL_LEN: usize = 1 << 20;
/// `-ln(1e-6)`, the kernel-length factor in both `build_kernel` and the cap check.
const KERNEL_TAIL_FACTOR: f64 = 13.815_510_557_964_274;

const MODES: [ConvMode; 2] = [ConvMode::Fft, ConvMode::BandedAR2];
const CONSTRAINTS: [Constraint; 2] = [Constraint::NonNegative, Constraint::Box01];

const TAU_R: f64 = 0.02;
const TAU_D: f64 = 0.4;
const LAMBDA: f64 = 0.01;
const FS: f64 = 30.0;

fn mode_name(m: ConvMode) -> &'static str {
    match m {
        ConvMode::Fft => "fft",
        ConvMode::BandedAR2 => "banded",
    }
}

fn constraint_name(c: Constraint) -> &'static str {
    match c {
        Constraint::NonNegative => "nonneg",
        Constraint::Box01 => "box01",
    }
}

fn solver(mode: ConvMode) -> Solver {
    let mut s = Solver::new();
    s.set_conv_mode(mode);
    s.set_params(TAU_R, TAU_D, LAMBDA, FS).unwrap();
    s
}

/// Run to convergence (bounded), panicking on a solver error.
fn run(s: &mut Solver) {
    for _ in 0..50 {
        if s.step_batch(20).unwrap() {
            break;
        }
    }
}

/// Noiseless trace: a constant floor plus a few calcium transients.
fn spiky_trace(n: usize) -> Vec<f32> {
    let mut t = vec![0.2_f32; n];
    for &sp in &[n / 5, n / 2, 4 * n / 5] {
        for j in 0..n.saturating_sub(sp) {
            let dt = j as f32 / FS as f32;
            t[sp + j] += (-dt / TAU_D as f32).exp() - (-dt / TAU_R as f32).exp();
        }
    }
    t
}

fn all_finite(v: &[f32]) -> bool {
    v.iter().all(|x| x.is_finite())
}

/// Everything a caller can observe after a solve, for exact comparisons.
#[derive(Debug, PartialEq)]
struct Snapshot {
    solution: Vec<f32>,
    reconvolution: Vec<f32>,
    reconvolution_with_baseline: Vec<f32>,
    baseline: f64,
    trace: Vec<f32>,
    kernel: Vec<f32>,
    iterations: u32,
    converged: bool,
    state: Vec<u8>,
}

fn snapshot(s: &mut Solver) -> Snapshot {
    Snapshot {
        solution: s.get_solution(),
        reconvolution: s.get_reconvolution(),
        reconvolution_with_baseline: s.get_reconvolution_with_baseline(),
        baseline: s.get_baseline(),
        trace: s.get_trace(),
        kernel: s.get_kernel(),
        iterations: s.iteration_count(),
        converged: s.converged(),
        state: s.export_state(),
    }
}

// ---------------------------------------------------------------------------
// Getters before any solve / before any trace
// ---------------------------------------------------------------------------

#[test]
fn getters_on_a_fresh_solver_are_empty_and_finite() {
    for mode in MODES {
        let mut s = Solver::new();
        s.set_conv_mode(mode);
        let m = mode_name(mode);
        assert!(s.get_solution().is_empty(), "{m}");
        assert!(s.get_reconvolution().is_empty(), "{m}");
        assert!(s.get_reconvolution_with_baseline().is_empty(), "{m}");
        assert!(s.get_trace().is_empty(), "{m}");
        assert_eq!(s.get_baseline(), 0.0, "{m}");
        let k = s.get_kernel();
        assert!(!k.is_empty() && all_finite(&k), "{m}: default kernel");
        assert!(!s.converged(), "{m}");
        assert_eq!(s.iteration_count(), 0, "{m}");
        assert!(s.get_power_spectrum().is_empty(), "{m}");
        // (get_spectrum_frequencies: see the ignored test below.)
        assert!(all_finite(&s.get_filter_cutoffs()), "{m}");
        assert_eq!(s.export_state().len(), 24, "{m}: header only");
        // Mutators with nothing loaded are no-ops, not panics.
        assert!(!s.apply_filter(), "{m}");
        s.subtract_baseline();
        s.reset_momentum();
        s.load_state(&[0u8; 24]);
        s.load_state(&[0xff; 7]);
        assert!(
            s.step_batch(5).unwrap(),
            "{m}: empty problem is trivially converged"
        );
        assert!(s.get_solution().is_empty(), "{m}");
    }
}

#[test]
#[ignore = "real gap: get_spectrum_frequencies() returns [NaN] (0 * fs/0) with no trace loaded, \
            and n/2+1 bins for 1..7-sample traces while get_power_spectrum() returns none; \
            follow-up: return an empty axis whenever the spectrum is empty (lib.rs)"]
fn spectrum_frequencies_match_the_power_spectrum_for_tiny_traces() {
    for n in [0_usize, 1, 2, 7, 8, 9] {
        let mut s = solver(ConvMode::Fft);
        s.set_trace(&vec![1.0; n]).unwrap();
        let freqs = s.get_spectrum_frequencies();
        let spectrum = s.get_power_spectrum();
        assert!(all_finite(&freqs), "n={n}: {freqs:?}");
        assert_eq!(freqs.len(), spectrum.len(), "n={n}");
    }
}

#[test]
fn spectrum_axis_is_finite_once_a_real_trace_is_loaded() {
    let mut s = solver(ConvMode::Fft);
    s.set_trace(&spiky_trace(64)).unwrap();
    let freqs = s.get_spectrum_frequencies();
    let spectrum = s.get_power_spectrum();
    assert_eq!(freqs.len(), spectrum.len());
    assert!(all_finite(&freqs) && all_finite(&spectrum));
    assert_eq!(freqs[0], 0.0);
    assert!((freqs[freqs.len() - 1] - FS as f32 / 2.0).abs() < 1e-4);
}

#[test]
fn getters_after_set_trace_before_any_step() {
    for mode in MODES {
        let trace = spiky_trace(120);
        let mut s = solver(mode);
        s.set_trace(&trace).unwrap();
        let m = mode_name(mode);
        assert_eq!(s.get_solution(), vec![0.0; 120], "{m}");
        assert_eq!(s.get_reconvolution(), vec![0.0; 120], "{m}");
        assert_eq!(s.get_trace(), trace, "{m}");
        // With s = 0 the display baseline is mean(trace).
        let mean = trace.iter().map(|&v| v as f64).sum::<f64>() / trace.len() as f64;
        assert!((s.get_baseline() - mean).abs() < 1e-6, "{m}");
        assert_eq!(s.iteration_count(), 0, "{m}");
        assert!(!s.converged(), "{m}");
    }
}

// ---------------------------------------------------------------------------
// Getter idempotence (regression for bug 1.2, fixed in #187: polling the
// display baseline used to write the solver's baseline and change the solve)
// ---------------------------------------------------------------------------

/// Call every display getter twice and assert both calls agree.
fn poll_twice(s: &mut Solver, ctx: &str) {
    let a = snapshot(s);
    let b = snapshot(s);
    assert_eq!(a, b, "{ctx}: a second round of getters changed the result");
    assert_eq!(s.get_power_spectrum(), s.get_power_spectrum(), "{ctx}");
}

#[test]
fn display_getters_are_idempotent_and_do_not_change_the_solve() {
    for mode in MODES {
        for constraint in CONSTRAINTS {
            for prep in ["raw", "subtract_baseline", "filter"] {
                let ctx = format!("{}/{}/{prep}", mode_name(mode), constraint_name(constraint));
                let trace: Vec<f32> = spiky_trace(300).iter().map(|v| v + 3.0).collect();
                let make = || {
                    let mut s = solver(mode);
                    s.set_constraint(constraint);
                    if prep == "filter" {
                        s.set_filter_enabled(true);
                    }
                    s.set_trace(&trace).unwrap();
                    match prep {
                        "subtract_baseline" => s.subtract_baseline(),
                        "filter" => assert!(s.apply_filter()),
                        _ => {}
                    }
                    s
                };

                let mut polled = make();
                let mut quiet = make();
                for batch in 0..40 {
                    poll_twice(&mut polled, &format!("{ctx} batch {batch}"));
                    let a = polled.step_batch(5).unwrap();
                    let b = quiet.step_batch(5).unwrap();
                    assert_eq!(a, b, "{ctx} batch {batch}: convergence flag diverged");
                    if a {
                        break;
                    }
                }
                // The optimisation state of the polled solver must match the
                // never-polled one bit for bit.
                assert_eq!(polled.export_state(), quiet.export_state(), "{ctx}: state");
                assert_eq!(polled.get_solution(), quiet.get_solution(), "{ctx}");
                assert_eq!(polled.iteration_count(), quiet.iteration_count(), "{ctx}");
                assert_eq!(polled.converged(), quiet.converged(), "{ctx}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Degenerate traces
// ---------------------------------------------------------------------------

#[test]
fn empty_and_tiny_traces_in_every_mode_constraint_and_preprocessing() {
    for mode in MODES {
        for constraint in CONSTRAINTS {
            for n in [0_usize, 1, 2, 3, 7, 8, 9] {
                for prep in ["raw", "subtract_baseline", "filter"] {
                    let ctx = format!(
                        "{}/{}/n={n}/{prep}",
                        mode_name(mode),
                        constraint_name(constraint)
                    );
                    let mut s = solver(mode);
                    s.set_constraint(constraint);
                    if prep == "filter" {
                        s.set_filter_enabled(true);
                    }
                    let trace: Vec<f32> = (0..n).map(|i| 1.0 + (i % 3) as f32).collect();
                    s.set_trace(&trace).unwrap();
                    match prep {
                        "subtract_baseline" => s.subtract_baseline(),
                        "filter" => {
                            s.apply_filter();
                        }
                        _ => {}
                    }
                    run(&mut s);
                    let snap = snapshot(&mut s);
                    assert_eq!(snap.solution.len(), n, "{ctx}");
                    assert_eq!(snap.reconvolution.len(), n, "{ctx}");
                    assert!(all_finite(&snap.solution), "{ctx}: {:?}", snap.solution);
                    assert!(all_finite(&snap.reconvolution_with_baseline), "{ctx}");
                    assert!(all_finite(&snap.trace), "{ctx}");
                    assert!(snap.baseline.is_finite(), "{ctx}");
                    let ps = s.get_power_spectrum();
                    assert!(all_finite(&ps), "{ctx}");
                    assert_eq!(ps.is_empty(), n < 8, "{ctx}: spectrum needs >= 8 samples");
                }
            }
        }
    }
}

#[test]
fn constant_and_zero_traces_give_zero_activity() {
    for mode in MODES {
        for value in [0.0_f32, 5.0, -5.0] {
            let mut s = solver(mode);
            s.set_trace(&[value; 200]).unwrap();
            run(&mut s);
            let ctx = format!("{} value={value}", mode_name(mode));
            assert!(s.get_solution().iter().all(|&v| v.abs() < 1e-3), "{ctx}");
            assert!((s.get_baseline() - value as f64).abs() < 1e-2, "{ctx}");
        }
    }
}

#[test]
fn extreme_but_finite_traces_do_not_panic() {
    let cases: Vec<(&str, Vec<f32>)> = vec![
        ("subnormal", vec![f32::MIN_POSITIVE / 4.0; 64]),
        (
            "alternating 1e30",
            (0..64)
                .map(|i| if i % 2 == 0 { 1e30 } else { -1e30 })
                .collect(),
        ),
        ("f32::MAX", vec![f32::MAX; 64]),
        ("f32::MIN", vec![f32::MIN; 64]),
        ("single spike of 1e38", {
            let mut v = vec![0.0; 64];
            v[10] = 1e38;
            v
        }),
    ];
    for mode in MODES {
        for (name, trace) in &cases {
            let ctx = format!("{} {name}", mode_name(mode));
            let mut s = solver(mode);
            s.set_trace(trace).unwrap();
            // Overflow inside the FFT/objective must surface as an error (or
            // stay finite) — never a panic.
            let mut failed = false;
            for _ in 0..20 {
                match s.step_batch(10) {
                    Ok(true) => break,
                    Ok(false) => {}
                    Err(SolverError::Numerical(_)) => {
                        failed = true;
                        break;
                    }
                    Err(e) => panic!("{ctx}: unexpected error kind {e}"),
                }
            }
            let _ = snapshot(&mut s);
            // The solver must remain usable afterwards.
            s.set_trace(&spiky_trace(100)).unwrap();
            run(&mut s);
            assert!(all_finite(&s.get_solution()), "{ctx} (failed={failed})");
        }
    }
}

#[test]
fn non_finite_traces_rejected_and_state_untouched() {
    let n = 50;
    let mut cases: Vec<(String, Vec<f32>, usize)> = Vec::new();
    for (label, bad) in [
        ("NaN", f32::NAN),
        ("+inf", f32::INFINITY),
        ("-inf", f32::NEG_INFINITY),
    ] {
        cases.push((format!("all {label}"), vec![bad; n], 0));
        cases.push((format!("single {label}"), vec![bad], 0));
        for idx in [0, n / 2, n - 1] {
            let mut t = vec![1.0_f32; n];
            t[idx] = bad;
            cases.push((format!("{label} at {idx}"), t, idx));
        }
    }
    for mode in MODES {
        let good = spiky_trace(80);
        let mut s = solver(mode);
        s.set_trace(&good).unwrap();
        s.step_batch(3).unwrap();
        let before = snapshot(&mut s);
        for (label, trace, idx) in &cases {
            let ctx = format!("{} {label}", mode_name(mode));
            let err = s.set_trace(trace).unwrap_err();
            assert!(matches!(err, SolverError::InvalidInput(_)), "{ctx}: {err}");
            assert!(
                err.to_string().contains(&format!("index {idx}")),
                "{ctx}: {err}"
            );
            assert_eq!(
                snapshot(&mut s),
                before,
                "{ctx}: rejected trace changed state"
            );
        }
        // And it carries on exactly as if nothing had happened.
        let mut reference = solver(mode);
        reference.set_trace(&good).unwrap();
        reference.step_batch(3).unwrap();
        run(&mut s);
        run(&mut reference);
        assert_eq!(
            s.get_solution(),
            reference.get_solution(),
            "{}",
            mode_name(mode)
        );
    }
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

const NAN: f64 = f64::NAN;
const INF: f64 = f64::INFINITY;

/// (label, tau_rise, tau_decay, lambda, fs) — every one must be rejected.
const BAD_PARAMS: &[(&str, f64, f64, f64, f64)] = &[
    ("reversed taus", 0.4, 0.02, LAMBDA, FS),
    ("equal taus", 0.4, 0.4, LAMBDA, FS),
    ("tau_rise = 0", 0.0, TAU_D, LAMBDA, FS),
    ("tau_decay = 0", TAU_R, 0.0, LAMBDA, FS),
    ("both taus 0", 0.0, 0.0, LAMBDA, FS),
    ("tau_rise < 0", -0.02, TAU_D, LAMBDA, FS),
    ("tau_decay < 0", TAU_R, -0.4, LAMBDA, FS),
    ("both taus < 0 (ordered)", -0.4, -0.02, LAMBDA, FS),
    ("tau_rise = -0.0", -0.0, TAU_D, LAMBDA, FS),
    ("tau_rise NaN", NAN, TAU_D, LAMBDA, FS),
    ("tau_decay NaN", TAU_R, NAN, LAMBDA, FS),
    ("tau_rise inf", INF, TAU_D, LAMBDA, FS),
    ("tau_decay inf", TAU_R, INF, LAMBDA, FS),
    ("tau_decay -inf", TAU_R, -INF, LAMBDA, FS),
    ("fs = 0", TAU_R, TAU_D, LAMBDA, 0.0),
    ("fs = -0.0", TAU_R, TAU_D, LAMBDA, -0.0),
    ("fs < 0", TAU_R, TAU_D, LAMBDA, -FS),
    ("fs NaN", TAU_R, TAU_D, LAMBDA, NAN),
    ("fs inf", TAU_R, TAU_D, LAMBDA, INF),
    ("fs -inf", TAU_R, TAU_D, LAMBDA, -INF),
    ("lambda < 0", TAU_R, TAU_D, -1e-9, FS),
    ("lambda NaN", TAU_R, TAU_D, NAN, FS),
    ("lambda inf", TAU_R, TAU_D, INF, FS),
    (
        "kernel over cap (units mixup: tau in ms)",
        20.0,
        400.0,
        LAMBDA,
        30_000.0,
    ),
    ("kernel product overflows", TAU_R, 1e300, LAMBDA, 1e300),
];

#[test]
fn invalid_params_rejected_in_every_mode_and_state_unchanged() {
    for mode in MODES {
        let trace = spiky_trace(150);
        let mut s = solver(mode);
        s.set_trace(&trace).unwrap();
        s.step_batch(4).unwrap();
        let before = snapshot(&mut s);
        for &(label, tr, td, lam, fs) in BAD_PARAMS {
            let ctx = format!("{} {label} ({tr}, {td}, {lam}, {fs})", mode_name(mode));
            let err = s.set_params(tr, td, lam, fs).unwrap_err();
            assert!(matches!(err, SolverError::InvalidParams(_)), "{ctx}: {err}");
            assert_eq!(
                snapshot(&mut s),
                before,
                "{ctx}: rejected params changed state"
            );
        }
        // The next solve is identical to one that never saw the bad params.
        let mut reference = solver(mode);
        reference.set_trace(&trace).unwrap();
        reference.step_batch(4).unwrap();
        run(&mut s);
        run(&mut reference);
        assert_eq!(
            s.get_solution(),
            reference.get_solution(),
            "{}",
            mode_name(mode)
        );
    }
}

#[test]
fn rejection_messages_name_the_offending_parameter() {
    let mut s = Solver::new();
    for (tr, td, lam, fs, needle) in [
        (0.4, 0.02, LAMBDA, FS, "tau_rise"),
        (0.0, TAU_D, LAMBDA, FS, "tau_rise"),
        (TAU_R, -1.0, LAMBDA, FS, "tau_decay"),
        (TAU_R, TAU_D, LAMBDA, 0.0, "fs"),
        (TAU_R, TAU_D, -1.0, FS, "lambda"),
        (TAU_R, 1e9, LAMBDA, FS, "kernel"),
    ] {
        let msg = s.set_params(tr, td, lam, fs).unwrap_err().to_string();
        assert!(msg.contains(needle), "({tr}, {td}, {lam}, {fs}): {msg}");
        assert!(msg.starts_with("invalid parameter"), "{msg}");
    }
}

#[test]
fn tiny_but_valid_params_are_accepted_and_solve() {
    // Not rejected (they are legal values) — so they must not panic either.
    for mode in MODES {
        for (tr, td, lam, fs) in [
            (1e-9, 2e-9, 0.0, 1e3),         // sub-sample kernel: clamped to 2 samples
            (TAU_R, TAU_D, 0.0, 1e-3),      // fs far below 1/tau: 2-sample kernel
            (TAU_R, TAU_D, 1e6, FS),        // huge sparsity: all-zero solution
            (0.399_999, TAU_D, LAMBDA, FS), // tau_rise ~ tau_decay (clamped)
            (TAU_R, TAU_D, LAMBDA, f64::MIN_POSITIVE),
        ] {
            let ctx = format!("{} ({tr}, {td}, {lam}, {fs})", mode_name(mode));
            let mut s = Solver::new();
            s.set_conv_mode(mode);
            s.set_params(tr, td, lam, fs)
                .unwrap_or_else(|e| panic!("{ctx}: {e}"));
            let k = s.get_kernel();
            assert!(k.len() >= 2 && all_finite(&k), "{ctx}: kernel {k:?}");
            s.set_trace(&spiky_trace(64)).unwrap();
            run(&mut s);
            assert!(all_finite(&s.get_solution()), "{ctx}");
            assert!(s.get_baseline().is_finite(), "{ctx}");
        }
    }
}

// ---------------------------------------------------------------------------
// Kernel-length cap (2^20 samples)
// ---------------------------------------------------------------------------

#[test]
fn kernel_length_at_the_cap_is_accepted_and_just_over_is_rejected() {
    // At fs = 1 Hz the kernel has ceil(KERNEL_TAIL_FACTOR * tau_decay) samples.
    let at_cap = (MAX_KERNEL_LEN as f64 - 0.5) / KERNEL_TAIL_FACTOR;
    let over_cap = (MAX_KERNEL_LEN as f64 + 0.5) / KERNEL_TAIL_FACTOR;

    let mut s = Solver::new();
    s.set_params(1.0, at_cap, LAMBDA, 1.0).unwrap();
    let k = s.get_kernel();
    assert_eq!(
        k.len(),
        MAX_KERNEL_LEN,
        "the cap and build_kernel must agree on length"
    );
    assert!(all_finite(&k));

    let before = s.get_kernel();
    let err = s.set_params(1.0, over_cap, LAMBDA, 1.0).unwrap_err();
    assert!(err.to_string().contains("kernel"), "{err}");
    assert_eq!(
        s.get_kernel(),
        before,
        "rejected kernel replaced the old one"
    );

    // The same boundary expressed through fs instead of tau_decay.
    let mut s2 = Solver::new();
    assert!(s2.set_params(0.01, 1.0, LAMBDA, at_cap).is_ok());
    assert!(s2.set_params(0.01, 1.0, LAMBDA, over_cap).is_err());
}

#[test]
fn a_cap_sized_kernel_still_solves_in_banded_mode() {
    // FFT mode would plan a ~2^21-point transform — fine, but slow in debug
    // builds — so exercise the full-size kernel through the O(T) engine.
    let at_cap = (MAX_KERNEL_LEN as f64 - 0.5) / KERNEL_TAIL_FACTOR;
    let mut s = Solver::new();
    s.set_conv_mode(ConvMode::BandedAR2);
    s.set_params(0.5, at_cap, LAMBDA, 1.0).unwrap();
    s.set_trace(&spiky_trace(64)).unwrap();
    s.step_batch(5).unwrap();
    assert!(all_finite(&s.get_solution()));
    assert!(all_finite(&s.get_reconvolution_with_baseline()));
}

// ---------------------------------------------------------------------------
// State consistency: parameter / mode changes after set_trace
// ---------------------------------------------------------------------------

/// `set_trace` then `change` (before any step) must solve exactly like a
/// solver configured with the changed setting before the trace was loaded.
fn assert_change_after_set_trace_matches_fresh(
    label: &str,
    start_mode: ConvMode,
    change: impl Fn(&mut Solver),
) {
    let trace = spiky_trace(400);
    let mut late = solver(start_mode);
    late.set_trace(&trace).unwrap();
    change(&mut late);
    run(&mut late);

    let mut early = solver(start_mode);
    change(&mut early);
    early.set_trace(&trace).unwrap();
    run(&mut early);

    // Kernel and iteration count must match exactly. Values match to f32
    // rounding: when the kernel shrinks after set_trace, FFT mode keeps its
    // (larger) padded buffers instead of re-planning, and a different FFT
    // length rounds differently (~1e-7 here). Anything beyond that would mean
    // a stale kernel spectrum or stale buffers.
    assert_eq!(late.get_kernel(), early.get_kernel(), "{label}: kernel");
    assert_eq!(
        late.iteration_count(),
        early.iteration_count(),
        "{label}: iterations"
    );
    assert_close(
        &late.get_solution(),
        &early.get_solution(),
        &format!("{label}: solution"),
    );
    assert_close(
        &late.get_reconvolution_with_baseline(),
        &early.get_reconvolution_with_baseline(),
        &format!("{label}: reconvolution"),
    );
}

fn assert_close(a: &[f32], b: &[f32], ctx: &str) {
    assert_eq!(a.len(), b.len(), "{ctx}: length");
    for (i, (&x, &y)) in a.iter().zip(b).enumerate() {
        assert!(
            (x - y).abs() <= 1e-5 + 1e-5 * y.abs(),
            "{ctx}: [{i}] {x} vs {y}"
        );
    }
}

#[test]
fn parameter_change_after_set_trace_is_consistent() {
    for mode in MODES {
        let m = mode_name(mode);
        let cases: Vec<(&str, Box<dyn Fn(&mut Solver)>)> = vec![
            (
                "longer kernel",
                Box::new(|s: &mut Solver| s.set_params(TAU_R, 3.0, LAMBDA, FS).unwrap()),
            ),
            (
                "shorter kernel",
                Box::new(|s: &mut Solver| s.set_params(0.01, 0.1, LAMBDA, FS).unwrap()),
            ),
            (
                "lambda only",
                Box::new(|s: &mut Solver| s.set_params(TAU_R, TAU_D, 0.5, FS).unwrap()),
            ),
            (
                "fs only",
                Box::new(|s: &mut Solver| s.set_params(TAU_R, TAU_D, LAMBDA, 100.0).unwrap()),
            ),
            (
                "rejected then accepted",
                Box::new(|s: &mut Solver| {
                    assert!(s.set_params(0.4, 0.02, LAMBDA, FS).is_err());
                    s.set_params(0.03, 0.6, LAMBDA, FS).unwrap();
                }),
            ),
            (
                "box constraint",
                Box::new(|s: &mut Solver| s.set_constraint(Constraint::Box01)),
            ),
        ];
        for (label, change) in cases {
            assert_change_after_set_trace_matches_fresh(&format!("{m} {label}"), mode, change);
        }
    }
}

#[test]
fn conv_mode_switch_after_set_trace_is_consistent() {
    for (from, to) in [
        (ConvMode::Fft, ConvMode::BandedAR2),
        (ConvMode::BandedAR2, ConvMode::Fft),
    ] {
        let label = format!("{} -> {}", mode_name(from), mode_name(to));
        assert_change_after_set_trace_matches_fresh(&label, from, move |s| s.set_conv_mode(to));
        // Params changed in one mode, then switched (each engine updates lazily).
        assert_change_after_set_trace_matches_fresh(&format!("{label} + params"), from, move |s| {
            s.set_params(0.05, 1.2, LAMBDA, FS).unwrap();
            s.set_conv_mode(to);
        });
    }
}

#[test]
fn parameter_change_mid_solve_keeps_solving_finitely() {
    // Warm-start path: params change with a partially solved state in place.
    for mode in MODES {
        let mut s = solver(mode);
        s.set_trace(&spiky_trace(300)).unwrap();
        s.step_batch(10).unwrap();
        for (tr, td, lam, fs) in [
            (TAU_R, 2.0, LAMBDA, FS),
            (0.01, 0.1, 0.1, FS),
            (TAU_R, TAU_D, LAMBDA, 90.0),
        ] {
            s.set_params(tr, td, lam, fs).unwrap();
            s.reset_momentum();
            for _ in 0..10 {
                if s.step_batch(10).unwrap() {
                    break;
                }
            }
            assert!(
                all_finite(&s.get_solution()),
                "{} ({tr}, {td})",
                mode_name(mode)
            );
            assert!(s.get_baseline().is_finite());
        }
    }
}

#[test]
fn shrinking_then_growing_traces_reuse_buffers_correctly() {
    // Buffers grow but never shrink; a shorter trace must not leak the tail
    // of a previous longer one into results.
    for mode in MODES {
        let mut s = solver(mode);
        for n in [500_usize, 20, 0, 1, 300, 500] {
            let trace = spiky_trace(n);
            s.set_trace(&trace).unwrap();
            run(&mut s);
            let mut fresh = solver(mode);
            fresh.set_trace(&trace).unwrap();
            run(&mut fresh);
            let ctx = format!("{} n={n}", mode_name(mode));
            assert_eq!(s.get_solution(), fresh.get_solution(), "{ctx}");
            assert_eq!(s.get_trace(), trace, "{ctx}");
        }
    }
}

#[test]
fn step_batch_zero_is_a_no_op() {
    for mode in MODES {
        let mut s = solver(mode);
        s.set_trace(&spiky_trace(100)).unwrap();
        let before = snapshot(&mut s);
        assert!(!s.step_batch(0).unwrap());
        assert_eq!(snapshot(&mut s), before, "{}", mode_name(mode));
    }
}

// ---------------------------------------------------------------------------
// Warm-start state (export_state / load_state)
// ---------------------------------------------------------------------------

#[test]
fn load_state_ignores_malformed_buffers() {
    for mode in MODES {
        let trace = spiky_trace(64);
        let mut s = solver(mode);
        s.set_trace(&trace).unwrap();
        s.step_batch(3).unwrap();
        let before = snapshot(&mut s);
        let valid = s.export_state();
        let mut garbage: Vec<Vec<u8>> = (0..64).map(|n| vec![0xab; n]).collect();
        garbage.push(valid[..valid.len() - 1].to_vec()); // one byte short
        garbage.push([valid.as_slice(), &[0]].concat()); // one byte long
        let mut wrong_len = valid.clone();
        wrong_len[0..4].copy_from_slice(&63_u32.to_le_bytes()); // header says 63 samples
        garbage.push(wrong_len);
        let mut huge_len = valid.clone();
        huge_len[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        garbage.push(huge_len);
        for g in &garbage {
            s.load_state(g);
            assert_eq!(
                snapshot(&mut s),
                before,
                "{} len={}",
                mode_name(mode),
                g.len()
            );
        }
    }
}

#[test]
fn export_load_round_trip_resumes_identically() {
    for mode in MODES {
        let trace = spiky_trace(200);
        let mut a = solver(mode);
        a.set_trace(&trace).unwrap();
        a.step_batch(7).unwrap();
        let state = a.export_state();

        let mut b = solver(mode);
        b.set_trace(&trace).unwrap();
        b.load_state(&state);
        assert_eq!(b.export_state(), state, "{}", mode_name(mode));
        a.step_batch(10).unwrap();
        b.step_batch(10).unwrap();
        assert_eq!(a.get_solution(), b.get_solution(), "{}", mode_name(mode));
    }
}

#[test]
fn non_finite_warm_start_payload_does_not_leak_into_the_solution() {
    // load_state does not validate its payload (it only ever receives what
    // export_state produced), so pin down that a corrupted one still cannot
    // surface NaN: either the solve reports a numerical error, or the
    // proximal step (max(0, ·) / clamp) scrubs it.
    for mode in MODES {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut s = solver(mode);
            s.set_trace(&spiky_trace(32)).unwrap();
            let mut state = s.export_state();
            state[24..28].copy_from_slice(&bad.to_le_bytes()); // solution[0]
            state[24 + 32 * 4..28 + 32 * 4].copy_from_slice(&bad.to_le_bytes()); // solution_prev[0]
            s.load_state(&state);
            match s.step_batch(10) {
                Err(SolverError::Numerical(_)) => {}
                Err(e) => panic!("{}: unexpected error kind {e}", mode_name(mode)),
                Ok(_) => assert!(
                    all_finite(&s.get_solution()),
                    "{} {bad}: non-finite warm start propagated: {:?}",
                    mode_name(mode),
                    &s.get_solution()[..4]
                ),
            }
        }
    }
}
