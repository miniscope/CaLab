//! Input validation shared by the WASM (`jsbindings`) and Python (`pybindings`)
//! FFI layers.
//!
//! Every check that guards a public entry point lives here, so the two
//! bindings reject exactly the same inputs with the same messages. The core
//! algorithms assume their inputs passed these checks; violating them used to
//! panic (a WASM trap that leaves the worker's module unusable) or silently
//! produce garbage.

use std::fmt;

use crate::biexp_fit::{BiexpResult, FitMode};

/// Upper bound on the number of kernel samples, `ceil(-ln(1e-6) · τ_decay · fs)`.
///
/// 2^20 samples is ~4 MiB of f32 kernel plus FFT buffers several times that,
/// and already corresponds to τ_decay ≈ 76 s at 1 kHz (or ≈ 2500 s at 30 Hz) —
/// orders of magnitude beyond any calcium indicator. Anything larger is a units
/// mistake (ms passed as s, Hz as kHz), and allocating it would abort the
/// process / trap the WASM module rather than fail cleanly.
pub const MAX_KERNEL_LEN: usize = 1 << 20;

/// Upper bound on `trace_len · upsample_factor` for the InDeCa pipeline.
///
/// 2^26 samples (~67 M) keeps the solver's ~10 working buffers under ~3 GiB,
/// i.e. inside wasm32's 4 GiB address space, while allowing e.g. a 1 h
/// recording at 1 kHz upsampled ×16.
pub const MAX_UPSAMPLED_LEN: usize = 1 << 26;

/// `-ln(1e-6)`: the kernel is truncated where the decay envelope drops below 1e-6.
const KERNEL_TAIL_FACTOR: f64 = 13.815_510_557_964_274;

/// Error returned by the validated (FFI-facing) solver entry points.
#[derive(Debug, Clone, PartialEq)]
pub enum SolverError {
    /// A scalar parameter is out of range (e.g. `fs <= 0`, `tau_rise >= tau_decay`).
    InvalidParams(String),
    /// An input array is malformed (non-finite values, inconsistent lengths, ...).
    InvalidInput(String),
    /// A numerical failure during iteration (e.g. overflow to a non-finite value).
    Numerical(String),
}

impl fmt::Display for SolverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolverError::InvalidParams(m) => write!(f, "invalid parameter: {m}"),
            SolverError::InvalidInput(m) => write!(f, "invalid input: {m}"),
            SolverError::Numerical(m) => write!(f, "numerical error: {m}"),
        }
    }
}

impl std::error::Error for SolverError {}

fn param_err(msg: String) -> SolverError {
    SolverError::InvalidParams(msg)
}

fn input_err(msg: String) -> SolverError {
    SolverError::InvalidInput(msg)
}

/// `fs` must be finite and strictly positive.
pub fn validate_fs(fs: f64) -> Result<(), SolverError> {
    if !(fs.is_finite() && fs > 0.0) {
        return Err(param_err(format!(
            "fs must be a finite sampling rate > 0 Hz, got {fs}"
        )));
    }
    Ok(())
}

/// Validate solver parameters: `fs > 0`, `0 < tau_rise < tau_decay`,
/// `lambda >= 0`, all finite, and a kernel no longer than [`MAX_KERNEL_LEN`].
pub fn validate_params(
    tau_rise: f64,
    tau_decay: f64,
    lambda: f64,
    fs: f64,
) -> Result<(), SolverError> {
    validate_fs(fs)?;
    if !(tau_rise.is_finite() && tau_rise > 0.0) {
        return Err(param_err(format!(
            "tau_rise must be finite and > 0 s, got {tau_rise}"
        )));
    }
    if !(tau_decay.is_finite() && tau_decay > 0.0) {
        return Err(param_err(format!(
            "tau_decay must be finite and > 0 s, got {tau_decay}"
        )));
    }
    if tau_rise >= tau_decay {
        return Err(param_err(format!(
            "tau_rise ({tau_rise} s) must be smaller than tau_decay ({tau_decay} s)"
        )));
    }
    if !(lambda.is_finite() && lambda >= 0.0) {
        return Err(param_err(format!(
            "lambda must be finite and >= 0, got {lambda}"
        )));
    }
    let kernel_len = (KERNEL_TAIL_FACTOR * tau_decay * fs).ceil();
    if kernel_len > MAX_KERNEL_LEN as f64 {
        return Err(param_err(format!(
            "tau_decay * fs = {} s·Hz implies a {kernel_len:.0}-sample kernel, above the \
             {MAX_KERNEL_LEN}-sample limit; check the units of tau_decay (s) and fs (Hz)",
            tau_decay * fs
        )));
    }
    Ok(())
}

/// Validate InDeCa pipeline parameters. The kernel is built at the upsampled
/// rate `fs · upsample_factor`, so the kernel-length bound applies there.
pub fn validate_indeca_params(
    trace_len: usize,
    tau_rise: f64,
    tau_decay: f64,
    fs: f64,
    upsample_factor: usize,
    lambda: f64,
    tol: f64,
) -> Result<(), SolverError> {
    if upsample_factor == 0 {
        return Err(param_err("upsample_factor must be >= 1, got 0".into()));
    }
    validate_fs(fs)?;
    validate_params(tau_rise, tau_decay, lambda, fs * upsample_factor as f64)?;
    if !(tol.is_finite() && tol >= 0.0) {
        return Err(param_err(format!("tol must be finite and >= 0, got {tol}")));
    }
    match trace_len.checked_mul(upsample_factor) {
        Some(n) if n <= MAX_UPSAMPLED_LEN => Ok(()),
        _ => Err(param_err(format!(
            "trace length {trace_len} x upsample_factor {upsample_factor} exceeds the \
             {MAX_UPSAMPLED_LEN}-sample limit"
        ))),
    }
}

/// Validate the target rate passed to `compute_upsample_factor`.
pub fn validate_upsample_rates(fs: f64, target_fs: f64) -> Result<(), SolverError> {
    validate_fs(fs)?;
    if !(target_fs.is_finite() && target_fs > 0.0) {
        return Err(param_err(format!(
            "target_fs must be finite and > 0 Hz, got {target_fs}"
        )));
    }
    if (target_fs / fs).round() > MAX_UPSAMPLED_LEN as f64 {
        return Err(param_err(format!(
            "target_fs / fs = {} is not a usable upsample factor",
            target_fs / fs
        )));
    }
    Ok(())
}

/// Reject non-finite values in an f32 array; `name` labels the error.
pub fn validate_finite_f32(name: &str, data: &[f32]) -> Result<(), SolverError> {
    match crate::first_nonfinite(data) {
        Some(i) => Err(input_err(format!(
            "{name} contains a non-finite value (NaN or infinity) at index {i}"
        ))),
        None => Ok(()),
    }
}

/// Reject non-finite values in an f64 array; `name` labels the error.
pub fn validate_finite_f64(name: &str, data: &[f64]) -> Result<(), SolverError> {
    match data.iter().position(|v| !v.is_finite()) {
        Some(i) => Err(input_err(format!(
            "{name} contains a non-finite value (NaN or infinity) at index {i}"
        ))),
        None => Ok(()),
    }
}

/// Convert signed trace lengths (numpy int64) to `usize`, rejecting negatives
/// instead of wrapping them to `usize::MAX`.
pub fn lengths_from_i64(lengths: &[i64]) -> Result<Vec<usize>, SolverError> {
    lengths
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            usize::try_from(v)
                .map_err(|_| input_err(format!("trace_lengths[{i}] must be >= 0, got {v}")))
        })
        .collect()
}

/// Sum of trace lengths, rejecting overflow (which on wasm32's 32-bit `usize`
/// is reachable with a handful of large `u32` lengths).
pub fn checked_total_len(lengths: &[usize]) -> Result<usize, SolverError> {
    lengths
        .iter()
        .try_fold(0_usize, |acc, &l| acc.checked_add(l))
        .ok_or_else(|| input_err("sum(trace_lengths) overflows".into()))
}

/// All checks for `estimate_free_kernel`'s inputs, shared by both bindings.
pub fn validate_kernel_estimate_inputs(
    traces_flat: &[f32],
    spikes_flat: &[f32],
    lengths: &[usize],
    alphas: &[f64],
    baselines: &[f64],
    kernel_length: usize,
    tol: f64,
    warm_kernel: Option<&[f32]>,
    smooth_lambda: f64,
) -> Result<(), SolverError> {
    let total_len = checked_total_len(lengths)?;
    if alphas.len() != lengths.len() || baselines.len() != lengths.len() {
        return Err(input_err(format!(
            "alphas ({}) and baselines ({}) must have one entry per trace ({})",
            alphas.len(),
            baselines.len(),
            lengths.len()
        )));
    }
    if traces_flat.len() != total_len || spikes_flat.len() != total_len {
        return Err(input_err(format!(
            "traces_flat ({}) and spikes_flat ({}) length must equal sum(trace_lengths) ({total_len})",
            traces_flat.len(),
            spikes_flat.len()
        )));
    }
    if kernel_length == 0 || kernel_length > MAX_KERNEL_LEN {
        return Err(param_err(format!(
            "kernel_length must be in 1..={MAX_KERNEL_LEN}, got {kernel_length}"
        )));
    }
    if !(tol.is_finite() && tol >= 0.0) {
        return Err(param_err(format!("tol must be finite and >= 0, got {tol}")));
    }
    if !(smooth_lambda.is_finite() && smooth_lambda >= 0.0) {
        return Err(param_err(format!(
            "smooth_lambda must be finite and >= 0, got {smooth_lambda}"
        )));
    }
    validate_finite_f32("traces_flat", traces_flat)?;
    validate_finite_f32("spikes_flat", spikes_flat)?;
    validate_finite_f64("alphas", alphas)?;
    validate_finite_f64("baselines", baselines)?;
    if let Some(w) = warm_kernel {
        validate_finite_f32("warm_kernel", w)?;
    }
    Ok(())
}

/// Validate `fit_biexponential` inputs and build the optional warm-start
/// candidate. `warm_residual` may be `+inf` (the "no previous fit" default);
/// every other warm field must be finite.
#[allow(clippy::too_many_arguments)]
pub fn biexp_fit_inputs(
    h_free: &[f32],
    fs: f64,
    use_warm: bool,
    warm_tau_rise: f64,
    warm_tau_decay: f64,
    warm_tau_rise_fast: f64,
    warm_tau_decay_fast: f64,
    warm_beta: f64,
    warm_beta_fast: f64,
    warm_residual: f64,
) -> Result<Option<BiexpResult>, SolverError> {
    validate_fs(fs)?;
    validate_finite_f32("h_free", h_free)?;
    if !use_warm {
        return Ok(None);
    }
    let named = [
        ("warm_tau_rise", warm_tau_rise),
        ("warm_tau_decay", warm_tau_decay),
        ("warm_tau_rise_fast", warm_tau_rise_fast),
        ("warm_tau_decay_fast", warm_tau_decay_fast),
        ("warm_beta", warm_beta),
        ("warm_beta_fast", warm_beta_fast),
    ];
    for (name, v) in named {
        if !v.is_finite() {
            return Err(param_err(format!("{name} must be finite, got {v}")));
        }
    }
    if warm_residual.is_nan() {
        return Err(param_err("warm_residual must not be NaN".into()));
    }
    Ok(Some(BiexpResult {
        tau_rise: warm_tau_rise,
        tau_decay: warm_tau_decay,
        beta: warm_beta,
        residual: warm_residual,
        tau_rise_fast: warm_tau_rise_fast,
        tau_decay_fast: warm_tau_decay_fast,
        beta_fast: warm_beta_fast,
        // Placeholder; fit_biexponential reclassifies the returned result.
        fit_mode: FitMode::default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_typical_params() {
        assert!(validate_params(0.02, 0.4, 0.01, 30.0).is_ok());
        assert!(validate_params(0.001, 2.0, 0.0, 1000.0).is_ok());
    }

    #[test]
    fn rejects_bad_fs() {
        for fs in [0.0, -30.0, f64::NAN, f64::INFINITY] {
            assert!(
                matches!(
                    validate_params(0.02, 0.4, 0.01, fs),
                    Err(SolverError::InvalidParams(_))
                ),
                "fs={fs}"
            );
        }
    }

    #[test]
    fn rejects_reversed_or_equal_taus() {
        assert!(validate_params(0.4, 0.02, 0.01, 30.0).is_err());
        assert!(validate_params(0.4, 0.4, 0.01, 30.0).is_err());
        assert!(validate_params(0.0, 0.4, 0.01, 30.0).is_err());
        assert!(validate_params(-0.1, 0.4, 0.01, 30.0).is_err());
        assert!(validate_params(0.02, f64::NAN, 0.01, 30.0).is_err());
    }

    #[test]
    fn rejects_bad_lambda() {
        assert!(validate_params(0.02, 0.4, -1e-3, 30.0).is_err());
        assert!(validate_params(0.02, 0.4, f64::NAN, 30.0).is_err());
        assert!(validate_params(0.02, 0.4, f64::INFINITY, 30.0).is_err());
    }

    #[test]
    fn rejects_enormous_kernel() {
        let err = validate_params(0.02, 1e12, 0.01, 30.0).unwrap_err();
        assert!(err.to_string().contains("kernel"), "{err}");
    }

    #[test]
    fn indeca_rejects_zero_upsample_and_huge_products() {
        assert!(validate_indeca_params(100, 0.02, 0.4, 30.0, 0, 0.0, 1e-4).is_err());
        assert!(validate_indeca_params(100, 0.02, 0.4, 30.0, 1, 0.0, 1e-4).is_ok());
        assert!(validate_indeca_params(usize::MAX, 0.02, 0.4, 30.0, 2, 0.0, 1e-4).is_err());
        assert!(validate_indeca_params(100, 0.02, 0.4, 30.0, 1, 0.0, f64::NAN).is_err());
    }

    #[test]
    fn negative_lengths_rejected_not_wrapped() {
        assert_eq!(lengths_from_i64(&[3, 4]).unwrap(), vec![3, 4]);
        assert!(lengths_from_i64(&[5, -1]).is_err());
    }

    #[test]
    fn total_len_overflow_detected() {
        assert_eq!(checked_total_len(&[1, 2, 3]).unwrap(), 6);
        assert!(checked_total_len(&[usize::MAX, 1]).is_err());
    }

    #[test]
    fn kernel_estimate_inputs_checked() {
        let t = [0.0_f32; 4];
        let ok = validate_kernel_estimate_inputs(
            &t,
            &t,
            &[2, 2],
            &[1.0, 1.0],
            &[0.0, 0.0],
            3,
            1e-4,
            None,
            0.0,
        );
        assert!(ok.is_ok());
        let nan_alpha = validate_kernel_estimate_inputs(
            &t,
            &t,
            &[2, 2],
            &[1.0, f64::NAN],
            &[0.0, 0.0],
            3,
            1e-4,
            None,
            0.0,
        );
        assert!(nan_alpha.unwrap_err().to_string().contains("alphas"));
        let bad_len = validate_kernel_estimate_inputs(
            &t,
            &t,
            &[2, 3],
            &[1.0, 1.0],
            &[0.0, 0.0],
            3,
            1e-4,
            None,
            0.0,
        );
        assert!(bad_len.is_err());
        let zero_k = validate_kernel_estimate_inputs(
            &t,
            &t,
            &[2, 2],
            &[1.0, 1.0],
            &[0.0, 0.0],
            0,
            1e-4,
            None,
            0.0,
        );
        assert!(zero_k.is_err());
        let nan_warm = validate_kernel_estimate_inputs(
            &t,
            &t,
            &[2, 2],
            &[1.0, 1.0],
            &[0.0, 0.0],
            3,
            1e-4,
            Some(&[f32::NAN]),
            0.0,
        );
        assert!(nan_warm.is_err());
    }

    #[test]
    fn biexp_inputs_checked() {
        let h = [0.0_f32, 1.0, 0.5];
        let inf = f64::INFINITY;
        assert!(
            biexp_fit_inputs(&h, 30.0, false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, inf)
                .unwrap()
                .is_none()
        );
        assert!(
            biexp_fit_inputs(&h, 30.0, true, 0.02, 0.4, 0.0, 0.0, 1.0, 0.0, inf)
                .unwrap()
                .is_some()
        );
        assert!(biexp_fit_inputs(&h, 0.0, false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, inf).is_err());
        assert!(
            biexp_fit_inputs(&[f32::NAN], 30.0, false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, inf).is_err()
        );
        assert!(biexp_fit_inputs(&h, 30.0, true, f64::NAN, 0.4, 0.0, 0.0, 1.0, 0.0, inf).is_err());
    }
}
