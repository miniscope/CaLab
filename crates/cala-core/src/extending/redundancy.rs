//! Temporal-trace correlation for the redundancy gate
//! (thesis Algorithm 10 line 3, Phase 3 Task 6).
//!
//! An overlapping spatial pair is only considered redundant if its
//! temporal traces are highly correlated over the extend window.
//! Distinct-but-touching cells (spatially close, independently
//! firing) keep separate estimators.

/// Pearson correlation coefficient of two equal-length vectors.
///
/// Returns 0 when either vector has zero variance or the vectors are
/// empty — in both cases the coefficient is mathematically undefined,
/// and the "safe" redundancy answer is non-redundant (i.e. below any
/// correlation threshold the caller checks).
pub fn pearson_correlation(x: &[f32], y: &[f32]) -> f32 {
    assert_eq!(
        x.len(),
        y.len(),
        "length mismatch: {} vs {}",
        x.len(),
        y.len()
    );
    if x.is_empty() {
        return 0.0;
    }
    let n = x.len() as f32;
    let mean_x: f32 = x.iter().sum::<f32>() / n;
    let mean_y: f32 = y.iter().sum::<f32>() / n;
    let mut cov = 0.0f32;
    let mut var_x = 0.0f32;
    let mut var_y = 0.0f32;
    for (xi, yi) in x.iter().zip(y) {
        let dx = xi - mean_x;
        let dy = yi - mean_y;
        cov += dx * dy;
        var_x += dx * dx;
        var_y += dy * dy;
    }
    let denom = (var_x * var_y).sqrt();
    if denom <= 0.0 {
        return 0.0;
    }
    (cov / denom).clamp(-1.0, 1.0)
}
