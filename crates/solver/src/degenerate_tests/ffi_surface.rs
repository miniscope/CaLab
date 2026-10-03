//! Degenerate inputs for every free function the bindings export.
//!
//! The WASM wrappers (`js_indeca.rs`, `js_simulate.rs`) cannot run natively —
//! `JsError` / `serde_wasm_bindgen` call into JS — and the PyO3 wrappers can't
//! link into a `cargo test` binary (`extension-module`). Both are thin: run the
//! shared `validate::*` checks, then call the core function. So this module
//! exercises exactly those two halves for each export:
//!
//! 1. the validation the export runs rejects every degenerate value with an
//!    `InvalidParams` / `InvalidInput` error, and
//! 2. the core function never panics (and returns finite numbers) on anything
//!    that validation lets through — empty, single-sample, constant, zero
//!    inputs, and boundary parameters.
//!
//! The real call paths are covered end-to-end by
//! `python/tests/test_degenerate_inputs.py` (pyo3) and
//! `packages/core/src/__tests__/wasm-degenerate.test.ts` (wasm-bindgen).
//!
//! | export (JS / Python)                                         | validation                     | core                                   |
//! |--------------------------------------------------------------|--------------------------------|----------------------------------------|
//! | `indeca_solve_trace` / `py_indeca_solve_trace`               | finite trace+warm, indeca params | `indeca::solve_trace_opts`           |
//! | `indeca_estimate_kernel` / `py_indeca_estimate_kernel`       | `validate_kernel_estimate_inputs` | `kernel_est::estimate_free_kernel`  |
//! | `indeca_fit_biexponential` / `py_indeca_fit_biexponential`   | `biexp_fit_inputs`             | `biexp_fit::fit_biexponential`         |
//! | `indeca_compute_upsample_factor` / `py_..._upsample_factor`  | `validate_upsample_rates`      | `upsample::compute_upsample_factor`    |
//! | `seed_trace` / `py_seed_trace`                               | finite trace, `validate_fs`    | `peak_seed::seed_trace`                |
//! | — / `seed_kernel_estimate`                                   | finite traces, `validate_fs`   | `peak_seed::seed_kernel_estimate`      |
//! | — / `py_build_kernel`                                        | `validate_params`              | `kernel::build_kernel`                 |
//! | `simulate_traces` / `py_simulate_traces`                     | `validate_simulation_config`   | `simulate::simulate`                   |

use crate::biexp_fit::{self, FitMode};
use crate::indeca::{self, SolveOptions};
use crate::kernel::build_kernel;
use crate::validate::{self, SolverError, MAX_KERNEL_LEN};
use crate::{kernel_est, peak_seed, simulate, upsample};

const TAU_R: f64 = 0.02;
const TAU_D: f64 = 0.4;
const FS: f64 = 30.0;
const NAN: f64 = f64::NAN;
const INF: f64 = f64::INFINITY;

fn finite32(v: &[f32]) -> bool {
    v.iter().all(|x| x.is_finite())
}

fn is_param_err(r: Result<(), SolverError>) -> bool {
    matches!(r, Err(SolverError::InvalidParams(_)))
}

/// Traces every export must handle once validation accepts them.
fn degenerate_traces() -> Vec<(&'static str, Vec<f32>)> {
    vec![
        ("empty", vec![]),
        ("single sample", vec![1.0]),
        ("two samples", vec![0.0, 1.0]),
        ("constant", vec![2.5; 200]),
        ("zeros", vec![0.0; 200]),
        ("negative constant", vec![-3.0; 64]),
        ("single impulse", {
            let mut v = vec![0.0; 128];
            v[40] = 1.0;
            v
        }),
        ("huge finite", vec![1e30; 64]),
    ]
}

/// The trace checks every trace-taking export runs first.
fn trace_rejected(t: &[f32]) -> bool {
    matches!(
        validate::validate_finite_f32("trace", t),
        Err(SolverError::InvalidInput(_))
    )
}

#[test]
fn every_trace_export_rejects_nan_and_infinity() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(trace_rejected(&[bad]), "single {bad}");
        assert!(trace_rejected(&[bad; 10]), "all {bad}");
        assert!(trace_rejected(&[0.0, 1.0, bad]), "last {bad}");
    }
    assert!(!trace_rejected(&[]));
    assert!(!trace_rejected(&[f32::MAX, f32::MIN, 0.0]));
}

// --- indeca_solve_trace -----------------------------------------------------

#[test]
fn indeca_solve_trace_rejects_degenerate_params() {
    // (label, tau_r, tau_d, fs, upsample, lambda, tol)
    let cases: &[(&str, f64, f64, f64, usize, f64, f64)] = &[
        ("upsample = 0", TAU_R, TAU_D, FS, 0, 0.0, 1e-4),
        ("reversed taus", TAU_D, TAU_R, FS, 1, 0.0, 1e-4),
        ("equal taus", TAU_D, TAU_D, FS, 1, 0.0, 1e-4),
        ("tau_r = 0", 0.0, TAU_D, FS, 1, 0.0, 1e-4),
        ("tau_r < 0", -TAU_R, TAU_D, FS, 1, 0.0, 1e-4),
        ("tau_d < 0", TAU_R, -TAU_D, FS, 1, 0.0, 1e-4),
        ("fs = 0", TAU_R, TAU_D, 0.0, 1, 0.0, 1e-4),
        ("fs < 0", TAU_R, TAU_D, -FS, 1, 0.0, 1e-4),
        ("fs NaN", TAU_R, TAU_D, NAN, 1, 0.0, 1e-4),
        ("fs inf", TAU_R, TAU_D, INF, 1, 0.0, 1e-4),
        ("lambda < 0", TAU_R, TAU_D, FS, 1, -1.0, 1e-4),
        ("lambda NaN", TAU_R, TAU_D, FS, 1, NAN, 1e-4),
        ("tol < 0", TAU_R, TAU_D, FS, 1, 0.0, -1.0),
        ("tol NaN", TAU_R, TAU_D, FS, 1, 0.0, NAN),
        ("tau NaN", NAN, TAU_D, FS, 1, 0.0, 1e-4),
        // The kernel is built at fs * upsample, so the cap applies there.
        (
            "kernel over cap at upsampled rate",
            TAU_R,
            100.0,
            1000.0,
            1000,
            0.0,
            1e-4,
        ),
    ];
    for &(label, tr, td, fs, up, lam, tol) in cases {
        let r = validate::validate_indeca_params(100, tr, td, fs, up, lam, tol);
        assert!(is_param_err(r.clone()), "{label}: {r:?}");
    }
    // Trace length x upsample over the 2^26 cap.
    assert!(is_param_err(validate::validate_indeca_params(
        1 << 20,
        TAU_R,
        TAU_D,
        FS,
        1 << 7,
        0.0,
        1e-4
    )));
    assert!(validate::validate_indeca_params(1 << 19, TAU_R, TAU_D, FS, 1 << 7, 0.0, 1e-4).is_ok());
}

#[test]
fn indeca_solve_trace_core_handles_every_accepted_degenerate_trace() {
    for (label, trace) in degenerate_traces() {
        for up in [1_usize, 4] {
            for (hp, lp, noise) in [
                (false, false, false),
                (true, true, false),
                (false, false, true),
            ] {
                let ctx = format!("{label} up={up} hp={hp} lp={lp} noise={noise}");
                validate::validate_indeca_params(trace.len(), TAU_R, TAU_D, FS, up, 0.0, 1e-4)
                    .unwrap();
                let r = indeca::solve_trace_opts(
                    &trace,
                    TAU_R,
                    TAU_D,
                    FS,
                    up,
                    50,
                    1e-4,
                    None,
                    hp,
                    lp,
                    0.0,
                    SolveOptions {
                        noise_constrained: noise,
                    },
                );
                assert_eq!(r.s_counts.len(), trace.len(), "{ctx}");
                assert!(finite32(&r.s_counts), "{ctx}");
                for (name, v) in [
                    ("alpha", r.alpha),
                    ("baseline", r.baseline),
                    ("threshold", r.threshold),
                    ("pve", r.pve),
                ] {
                    assert!(v.is_finite(), "{ctx}: {name} = {v}");
                }
            }
        }
    }
}

#[test]
fn indeca_solve_trace_core_tolerates_mismatched_warm_counts_and_zero_iters() {
    let trace: Vec<f32> = (0..100).map(|i| ((i % 17) as f32).sin()).collect();
    for warm in [vec![], vec![1.0; 3], vec![1.0; 100], vec![0.5; 1000]] {
        for max_iters in [0_u32, 1, 50] {
            let r = indeca::solve_trace_opts(
                &trace,
                TAU_R,
                TAU_D,
                FS,
                2,
                max_iters,
                1e-4,
                if warm.is_empty() { None } else { Some(&warm) },
                false,
                false,
                0.0,
                SolveOptions::default(),
            );
            let ctx = format!("warm len {} max_iters {max_iters}", warm.len());
            assert_eq!(r.s_counts.len(), trace.len(), "{ctx}");
            assert!(finite32(&r.s_counts) && r.alpha.is_finite(), "{ctx}");
        }
    }
}

// --- indeca_estimate_kernel ---------------------------------------------------

#[test]
fn estimate_kernel_rejects_inconsistent_or_degenerate_inputs() {
    let t = vec![0.5_f32; 20];
    let ok = |lengths: &[usize], alphas: &[f64], baselines: &[f64], k: usize, tol: f64, sl: f64| {
        validate::validate_kernel_estimate_inputs(
            &t, &t, lengths, alphas, baselines, k, tol, None, sl,
        )
    };
    assert!(ok(&[10, 10], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, 0.0).is_ok());
    for (label, r) in [
        (
            "lengths sum short",
            ok(&[10, 9], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, 0.0),
        ),
        (
            "lengths sum long",
            ok(&[10, 11], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, 0.0),
        ),
        (
            "alphas short",
            ok(&[10, 10], &[1.0], &[0.0, 0.0], 5, 1e-4, 0.0),
        ),
        (
            "baselines long",
            ok(&[10, 10], &[1.0, 1.0], &[0.0; 3], 5, 1e-4, 0.0),
        ),
        (
            "alpha NaN",
            ok(&[10, 10], &[1.0, NAN], &[0.0, 0.0], 5, 1e-4, 0.0),
        ),
        (
            "baseline inf",
            ok(&[10, 10], &[1.0, 1.0], &[0.0, INF], 5, 1e-4, 0.0),
        ),
        (
            "kernel_length 0",
            ok(&[10, 10], &[1.0, 1.0], &[0.0, 0.0], 0, 1e-4, 0.0),
        ),
        (
            "kernel_length over cap",
            ok(
                &[10, 10],
                &[1.0, 1.0],
                &[0.0, 0.0],
                MAX_KERNEL_LEN + 1,
                1e-4,
                0.0,
            ),
        ),
        (
            "tol < 0",
            ok(&[10, 10], &[1.0, 1.0], &[0.0, 0.0], 5, -1.0, 0.0),
        ),
        (
            "smooth_lambda < 0",
            ok(&[10, 10], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, -1.0),
        ),
        (
            "smooth_lambda NaN",
            ok(&[10, 10], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, NAN),
        ),
        (
            "length overflow",
            ok(&[usize::MAX, 21], &[1.0, 1.0], &[0.0, 0.0], 5, 1e-4, 0.0),
        ),
    ] {
        assert!(r.is_err(), "{label}");
    }
    // kernel_length exactly at the cap is accepted.
    assert!(ok(
        &[10, 10],
        &[1.0, 1.0],
        &[0.0, 0.0],
        MAX_KERNEL_LEN,
        1e-4,
        0.0
    )
    .is_ok());
    // Non-finite traces, spikes and warm kernels.
    let mut nan_t = t.clone();
    nan_t[3] = f32::NAN;
    let lens = [10, 10];
    let a = [1.0, 1.0];
    let b = [0.0, 0.0];
    for (traces, spikes, warm) in [
        (&nan_t, &t, None),
        (&t, &nan_t, None),
        (&t, &t, Some(&[f32::INFINITY][..])),
    ] {
        assert!(validate::validate_kernel_estimate_inputs(
            traces, spikes, &lens, &a, &b, 5, 1e-4, warm, 0.0
        )
        .is_err());
    }
    // Negative numpy lengths are rejected rather than wrapped (pybindings path).
    assert!(validate::lengths_from_i64(&[10, -10]).is_err());
}

#[test]
fn estimate_kernel_core_handles_accepted_degenerate_inputs() {
    // (label, traces, spikes, lengths, alphas, baselines, kernel_length, warm)
    type Case = (
        &'static str,
        Vec<f32>,
        Vec<f32>,
        Vec<usize>,
        Vec<f64>,
        Vec<f64>,
        usize,
        Option<Vec<f32>>,
    );
    let cases: Vec<Case> = vec![
        (
            "no traces",
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            10,
            None,
        ),
        (
            "one empty trace",
            vec![],
            vec![],
            vec![0],
            vec![1.0],
            vec![0.0],
            10,
            None,
        ),
        (
            "trace shorter than kernel",
            vec![1.0; 3],
            vec![1.0; 3],
            vec![3],
            vec![1.0],
            vec![0.0],
            10,
            None,
        ),
        (
            "no spikes",
            vec![1.0; 30],
            vec![0.0; 30],
            vec![30],
            vec![1.0],
            vec![0.0],
            10,
            None,
        ),
        (
            "alpha 0",
            vec![1.0; 30],
            vec![1.0; 30],
            vec![30],
            vec![0.0],
            vec![0.0],
            10,
            None,
        ),
        (
            "kernel_length 1",
            vec![1.0; 30],
            vec![1.0; 30],
            vec![30],
            vec![1.0],
            vec![0.0],
            1,
            None,
        ),
        (
            "warm kernel too short",
            vec![1.0; 30],
            vec![1.0; 30],
            vec![30],
            vec![1.0],
            vec![0.0],
            10,
            Some(vec![1.0; 3]),
        ),
        (
            "warm kernel too long",
            vec![1.0; 30],
            vec![1.0; 30],
            vec![30],
            vec![1.0],
            vec![0.0],
            10,
            Some(vec![1.0; 50]),
        ),
        (
            "mixed empty and full",
            vec![1.0; 30],
            vec![1.0; 30],
            vec![0, 30, 0],
            vec![1.0; 3],
            vec![0.0; 3],
            10,
            None,
        ),
    ];
    for (label, traces, spikes, lengths, alphas, baselines, k, warm) in cases {
        validate::validate_kernel_estimate_inputs(
            &traces,
            &spikes,
            &lengths,
            &alphas,
            &baselines,
            k,
            1e-4,
            warm.as_deref(),
            0.0,
        )
        .unwrap_or_else(|e| panic!("{label}: {e}"));
        let h = kernel_est::estimate_free_kernel(
            &traces,
            &spikes,
            &alphas,
            &baselines,
            &lengths,
            k,
            50,
            1e-4,
            warm.as_deref(),
            0.0,
        );
        assert_eq!(h.len(), k, "{label}");
        assert!(finite32(&h), "{label}: {h:?}");
    }
}

// --- indeca_fit_biexponential -------------------------------------------------

#[test]
fn fit_biexponential_rejects_degenerate_inputs() {
    let h = [0.0_f32, 1.0, 0.5];
    let inf = INF;
    let call = |h: &[f32], fs: f64, warm: bool, w: [f64; 6], res: f64| {
        validate::biexp_fit_inputs(h, fs, warm, w[0], w[1], w[2], w[3], w[4], w[5], res).map(|_| ())
    };
    let w0 = [TAU_R, TAU_D, 0.0, 0.0, 1.0, 0.0];
    for fs in [0.0, -1.0, NAN, INF] {
        assert!(call(&h, fs, false, w0, inf).is_err(), "fs={fs}");
    }
    for bad in [f32::NAN, f32::INFINITY] {
        assert!(
            call(&[0.0, bad], FS, false, w0, inf).is_err(),
            "h_free {bad}"
        );
    }
    for i in 0..6 {
        for bad in [NAN, INF, -INF] {
            let mut w = w0;
            w[i] = bad;
            assert!(
                call(&h, FS, true, w, inf).is_err(),
                "warm field {i} = {bad}"
            );
            // Ignored when use_warm is false.
            assert!(call(&h, FS, false, w, inf).is_ok(), "warm field {i} unused");
        }
    }
    assert!(call(&h, FS, true, w0, NAN).is_err(), "warm_residual NaN");
    assert!(
        call(&h, FS, true, w0, inf).is_ok(),
        "warm_residual +inf means 'no previous fit'"
    );
}

#[test]
fn fit_biexponential_core_handles_accepted_degenerate_kernels() {
    let cases: Vec<(&str, Vec<f32>)> = vec![
        ("empty", vec![]),
        ("one sample", vec![1.0]),
        ("two samples", vec![1.0, 0.5]),
        ("all zeros", vec![0.0; 50]),
        ("all negative", vec![-1.0; 50]),
        ("constant", vec![1.0; 50]),
        ("huge", vec![1e30; 50]),
        ("build_kernel", build_kernel(TAU_R, TAU_D, FS)),
    ];
    for (label, h) in cases {
        for skip in [0_usize, 1, 1000] {
            for refine in [false, true] {
                for warm in [None, Some((TAU_R, TAU_D)), Some((0.1, 2.0))] {
                    let ctx = format!("{label} skip={skip} refine={refine} warm={warm:?}");
                    let ws = warm.map(|(tr, td)| {
                        validate::biexp_fit_inputs(&h, FS, true, tr, td, 0.0, 0.0, 1.0, 0.0, INF)
                            .unwrap()
                            .unwrap()
                    });
                    let r = biexp_fit::fit_biexponential(&h, FS, refine, skip, ws.as_ref());
                    for (name, v) in [
                        ("tau_rise", r.tau_rise),
                        ("tau_decay", r.tau_decay),
                        ("beta", r.beta),
                        ("tau_rise_fast", r.tau_rise_fast),
                        ("tau_decay_fast", r.tau_decay_fast),
                        ("beta_fast", r.beta_fast),
                    ] {
                        assert!(v.is_finite(), "{ctx}: {name} = {v}");
                    }
                    assert!(
                        r.residual.is_finite() || r.fit_mode == FitMode::Empty,
                        "{ctx}"
                    );
                    assert!(
                        r.tau_rise > 0.0 && r.tau_decay > 0.0,
                        "{ctx}: taus ({}, {})",
                        r.tau_rise,
                        r.tau_decay
                    );
                }
            }
        }
    }
}

#[test]
#[ignore = "real gap: biexp_fit_inputs only checks that warm-start fields are finite, so \
            negative or reversed warm taus pass validation, and fit_biexponential can return \
            them verbatim as the best candidate (e.g. tau_rise = -1, tau_decay = -2 for an \
            all-negative kernel). Follow-up: require 0 < warm_tau_rise < warm_tau_decay \
            (and the same for the fast pair when beta_fast != 0) in validate.rs."]
fn fit_biexponential_never_returns_non_physical_warm_taus() {
    let kernels: Vec<(&str, Vec<f32>)> = vec![
        ("all negative", vec![-1.0; 50]),
        ("all zeros", vec![0.0; 50]),
        ("build_kernel", build_kernel(TAU_R, TAU_D, FS)),
    ];
    for (label, h) in kernels {
        for (tr, td) in [(-1.0, -2.0), (0.0, 0.0), (TAU_D, TAU_R)] {
            let ctx = format!("{label} warm=({tr}, {td})");
            let ws = match validate::biexp_fit_inputs(&h, FS, true, tr, td, 0.0, 0.0, 1.0, 0.0, INF)
            {
                Err(_) => continue, // rejected up front: the fix
                Ok(ws) => ws.unwrap(),
            };
            let r = biexp_fit::fit_biexponential(&h, FS, true, 0, Some(&ws));
            assert!(
                r.tau_rise > 0.0 && r.tau_decay > r.tau_rise,
                "{ctx}: returned taus ({}, {})",
                r.tau_rise,
                r.tau_decay
            );
        }
    }
}

// --- indeca_compute_upsample_factor -------------------------------------------

#[test]
fn upsample_factor_rejects_degenerate_rates_and_is_at_least_one() {
    for (fs, target) in [
        (0.0, 300.0),
        (-30.0, 300.0),
        (NAN, 300.0),
        (INF, 300.0),
        (FS, 0.0),
        (FS, -1.0),
        (FS, NAN),
        (FS, INF),
        (1e-300, 1e300), // ratio overflows to inf
        (1.0, 1e12),     // finite ratio, absurd factor
    ] {
        assert!(
            is_param_err(validate::validate_upsample_rates(fs, target)),
            "({fs}, {target})"
        );
    }
    for (fs, target, expect) in [(FS, FS, 1), (FS, 1e-300, 1), (FS, 300.0, 10), (FS, 44.0, 1)] {
        validate::validate_upsample_rates(fs, target).unwrap();
        assert_eq!(
            upsample::compute_upsample_factor(fs, target),
            expect,
            "({fs}, {target})"
        );
    }
}

// --- seed_trace / seed_kernel_estimate ----------------------------------------

#[test]
fn seed_trace_core_handles_accepted_degenerate_traces() {
    for fs in [0.0, -1.0, NAN, INF] {
        assert!(is_param_err(validate::validate_fs(fs)), "fs={fs}");
    }
    for (label, trace) in degenerate_traces() {
        for fs in [FS, 1e-6, 1e6] {
            let r = peak_seed::seed_trace(&trace, fs);
            let ctx = format!("{label} fs={fs}");
            assert_eq!(r.s_counts.len(), trace.len(), "{ctx}");
            assert!(finite32(&r.s_counts), "{ctx}");
            assert!(r.alpha.is_finite() && r.baseline.is_finite(), "{ctx}");
        }
    }
}

#[test]
fn seed_kernel_estimate_core_handles_accepted_degenerate_inputs() {
    let cases: Vec<(&str, Vec<f32>, Vec<usize>)> = vec![
        ("no cells", vec![], vec![]),
        ("cells with no samples", vec![], vec![0, 0, 0]),
        ("one sample per cell", vec![1.0, 2.0], vec![1, 1]),
        ("constant", vec![1.0; 600], vec![300, 300]),
        ("zeros", vec![0.0; 600], vec![300, 300]),
    ];
    for (label, traces, lengths) in cases {
        let r = peak_seed::seed_kernel_estimate(&traces, &lengths, FS);
        assert!(finite32(&r.free_kernel), "{label}");
        for (name, v) in [
            ("tau_rise", r.tau_rise),
            ("tau_decay", r.tau_decay),
            ("tau_rise_fast", r.tau_rise_fast),
            ("tau_decay_fast", r.tau_decay_fast),
            ("beta_fast", r.beta_fast),
        ] {
            assert!(v.is_finite(), "{label}: {name} = {v}");
        }
    }
}

// --- py_build_kernel ------------------------------------------------------------

#[test]
fn build_kernel_validation_and_cap_boundary() {
    // py_build_kernel validates with lambda = 0.
    for (tr, td, fs) in [
        (TAU_D, TAU_R, FS),
        (0.0, TAU_D, FS),
        (TAU_R, TAU_D, 0.0),
        (TAU_R, 1e12, FS),
        (TAU_R, NAN, FS),
    ] {
        assert!(
            is_param_err(validate::validate_params(tr, td, 0.0, fs)),
            "({tr}, {td}, {fs})"
        );
    }
    // At fs = 1 Hz the kernel has ceil(-ln(1e-6) * tau_decay) samples; the cap
    // check and build_kernel use the same formula, so the boundary is exact.
    let tail = -(1e-6_f64.ln());
    let at = (MAX_KERNEL_LEN as f64 - 0.5) / tail;
    let over = (MAX_KERNEL_LEN as f64 + 0.5) / tail;
    validate::validate_params(1.0, at, 0.0, 1.0).unwrap();
    assert_eq!(build_kernel(1.0, at, 1.0).len(), MAX_KERNEL_LEN);
    assert!(is_param_err(validate::validate_params(1.0, over, 0.0, 1.0)));
}

// --- simulate_traces / py_simulate_traces ---------------------------------------

fn small_config() -> simulate::SimulationConfig {
    simulate::SimulationConfig {
        num_cells: 2,
        num_timepoints: 120,
        ..Default::default()
    }
}

#[test]
fn simulate_handles_zero_and_one_sized_configs() {
    for (cells, tp) in [(0_usize, 100_usize), (2, 0), (2, 1), (1, 2)] {
        let cfg = simulate::SimulationConfig {
            num_cells: cells,
            num_timepoints: tp,
            ..small_config()
        };
        validate::validate_simulation_config(&cfg).unwrap();
        let r = simulate::simulate(&cfg);
        assert_eq!(r.traces.len(), cells * tp, "({cells}, {tp})");
        assert_eq!(r.ground_truth.len(), cells, "({cells}, {tp})");
        assert!(finite32(&r.traces), "({cells}, {tp})");
    }
    // spike_sim_hz below fs is clamped to one bin per frame (documented).
    let cfg = simulate::SimulationConfig {
        spike_sim_hz: 10.0,
        ..small_config()
    };
    validate::validate_simulation_config(&cfg).unwrap();
    assert!(finite32(&simulate::simulate(&cfg).traces));
}

#[test]
fn simulate_presets_and_defaults_pass_validation() {
    validate::validate_simulation_config(&simulate::SimulationConfig::default()).unwrap();
    for (name, cfg) in simulate::presets::all() {
        validate::validate_simulation_config(&cfg).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

/// Regression: simulate_traces / py_simulate_traces used to run no input
/// validation. `fs_hz = 0` overflowed `n_tp * bins_per_frame` (panic: WASM
/// trap / Python PanicException), `tau_decay_s = 1e12` made `build_kernel`
/// request a ~10^14-sample Vec (OOM abort: SIGABRT in the Python interpreter),
/// `tau_rise_s = 0` produced NaN traces, reversed taus negative calcium, and
/// `num_cells * num_timepoints` overflowed. The bindings now reject all of
/// these before anything is allocated. (Only the validator is called here:
/// running simulate() on these configs is exactly what used to abort.)
#[test]
fn simulate_config_validation_rejects_degenerate_configs() {
    type Edit = fn(&mut simulate::SimulationConfig);
    let cases: &[(&str, &str, Edit)] = &[
        ("fs_hz = 0", "fs", |c| c.fs_hz = 0.0),
        ("fs_hz < 0", "fs", |c| c.fs_hz = -30.0),
        ("fs_hz NaN", "fs", |c| c.fs_hz = NAN),
        ("spike_sim_hz = 0", "spike_sim_hz", |c| c.spike_sim_hz = 0.0),
        ("spike_sim_hz inf", "spike_sim_hz", |c| c.spike_sim_hz = INF),
        ("tau_rise_s = 0", "tau_rise", |c| c.kernel.tau_rise_s = 0.0),
        ("tau_decay_s < 0", "tau_decay", |c| {
            c.kernel.tau_decay_s = -1.0
        }),
        ("reversed taus", "tau_rise", |c| {
            c.kernel.tau_rise_s = 1.0;
            c.kernel.tau_decay_s = 0.1;
        }),
        ("tau_decay_s = 1e12 (kernel would abort)", "kernel", |c| {
            c.kernel.tau_decay_s = 1e12
        }),
        ("tau_decay_s in ms (kernel over cap)", "kernel", |c| {
            c.kernel.tau_decay_s = 600.0
        }),
        ("cells x timepoints overflows", "num_cells", |c| {
            c.num_cells = usize::MAX / 2;
            c.num_timepoints = 4;
        }),
        ("cells x timepoints over cap", "num_cells", |c| {
            c.num_cells = 1 << 14;
            c.num_timepoints = 1 << 13;
        }),
        ("high-res bins over cap", "num_timepoints", |c| {
            c.num_cells = 1;
            c.num_timepoints = 1 << 22;
            c.spike_sim_hz = 3000.0; // 100 bins per frame
        }),
        ("fs tiny -> huge bins per frame", "num_timepoints", |c| {
            c.fs_hz = 1e-300
        }),
        ("tau cv over max", "tau_decay_cv", |c| {
            c.kernel.tau_decay_cv = 1e3
        }),
        ("alpha_mean = 0", "alpha_mean", |c| c.alpha_mean = 0.0),
        ("alpha_cv NaN", "alpha_cv", |c| c.alpha_cv = NAN),
        ("snr = 0", "snr", |c| c.noise.snr = 0.0),
        ("shot noise fraction > 1", "shot_noise_fraction", |c| {
            c.noise.shot_noise_fraction = 1.5
        }),
        ("probability > 1", "p_spike_when_active", |c| {
            c.spike_model = simulate::SpikeModel::Markov(simulate::MarkovConfig {
                p_spike_when_active: 2.0,
                ..Default::default()
            })
        }),
        ("poisson rate inf", "rate_hz", |c| {
            c.spike_model = simulate::SpikeModel::Poisson(simulate::PoissonConfig { rate_hz: INF })
        }),
        ("bleaching tau = 0", "decay_time_constant_s", |c| {
            c.photobleaching.decay_time_constant_s = 0.0
        }),
        ("hill coefficient NaN", "hill_coefficient", |c| {
            c.saturation.hill_coefficient = NAN
        }),
        ("k_d < 0", "k_d", |c| c.saturation.k_d = -1.0),
    ];
    for (label, needle, edit) in cases {
        let mut cfg = small_config();
        edit(&mut cfg);
        let err = validate::validate_simulation_config(&cfg).unwrap_err();
        assert!(
            matches!(err, SolverError::InvalidParams(_)),
            "{label}: {err}"
        );
        assert!(err.to_string().contains(needle), "{label}: {err}");
    }
}

#[test]
fn simulate_bounds_extreme_per_cell_tau_draws() {
    // The nominal taus are valid, but a CV of 10 makes exp(10 · N(0,1)) draws
    // span ~e^±40: without the per-cell clamp some cells' kernels would exceed
    // the length cap (allocation abort) or have rise >= decay.
    let mut cfg = simulate::SimulationConfig {
        num_cells: 8,
        num_timepoints: 60,
        ..small_config()
    };
    cfg.kernel.tau_rise_cv = validate::MAX_SIM_CV;
    cfg.kernel.tau_decay_cv = validate::MAX_SIM_CV;
    validate::validate_simulation_config(&cfg).unwrap();
    let r = simulate::simulate(&cfg);
    assert!(finite32(&r.traces));
    let max_tau_d = MAX_KERNEL_LEN as f64 / (-(1e-6_f64.ln()) * cfg.spike_sim_hz);
    for gt in &r.ground_truth {
        assert!(gt.tau_decay_s <= max_tau_d, "tau_decay {}", gt.tau_decay_s);
        assert!(
            0.0 < gt.tau_rise_s && gt.tau_rise_s < gt.tau_decay_s,
            "taus ({}, {})",
            gt.tau_rise_s,
            gt.tau_decay_s
        );
        assert!(gt.clean_calcium.iter().all(|&c| c.is_finite() && c >= 0.0));
    }
}
