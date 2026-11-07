//! Small robust-statistics helpers shared by the warm-up stages.

use super::Dims;

/// Φ⁻¹(0.75): the MAD of a standard normal (same constant as `solver::snr`).
pub const MAD_GAUSSIAN: f32 = 0.674_489_8;

/// The `q`-quantile (0..=1, nearest rank) of the finite values; `None` if none.
pub fn quantile(values: &[f32], q: f32) -> Option<f32> {
    let mut v: Vec<f32> = values.iter().copied().filter(|x| x.is_finite()).collect();
    quantile_in_place(&mut v, q)
}

/// [`quantile`] on a scratch vector the caller no longer needs in order.
/// Expects finite values.
pub fn quantile_in_place(v: &mut [f32], q: f32) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    let q = if q.is_finite() {
        q.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let k = ((v.len() - 1) as f32 * q).round() as usize;
    let k = k.min(v.len() - 1);
    let (_, x, _) = v.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
    Some(*x)
}

/// Median of a short list (sorted in place); `None` if empty.
pub fn median_small(v: &mut [f32]) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    })
}

/// Robust σ of the finite values: 1.4826 · median|x − median(x)|.
pub fn robust_sigma(values: &[f32]) -> Option<f32> {
    let mut v: Vec<f32> = values.iter().copied().filter(|x| x.is_finite()).collect();
    let med = quantile_in_place(&mut v, 0.5)?;
    for x in v.iter_mut() {
        *x = (*x - med).abs();
    }
    quantile_in_place(&mut v, 0.5).map(|m| m / MAD_GAUSSIAN)
}

/// `(2r+1)²` median filter; the window is clipped at the frame border (only
/// in-frame pixels count), so edges are not biased toward a padding value.
pub fn median_filter(src: &[f32], dims: Dims, radius: usize) -> Vec<f32> {
    let Dims { width, height } = dims;
    let mut out = vec![0.0f32; dims.pixels()];
    let mut buf = Vec::with_capacity((2 * radius + 1) * (2 * radius + 1));
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius).min(height - 1);
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(width - 1);
            buf.clear();
            for yy in y0..=y1 {
                buf.extend_from_slice(&src[yy * width + x0..=yy * width + x1]);
            }
            out[y * width + x] = median_small(&mut buf).unwrap_or(0.0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_and_medians() {
        assert_eq!(quantile(&[3.0, 1.0, 2.0], 0.5), Some(2.0));
        assert_eq!(quantile(&[], 0.5), None);
        assert_eq!(quantile(&[f32::NAN], 0.5), None);
        assert_eq!(median_small(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.5));
        let s = robust_sigma(&[0.0, 1.0, -1.0, 0.0, 100.0]).unwrap();
        assert!((s - 1.0 / MAD_GAUSSIAN).abs() < 1e-5);
    }

    #[test]
    fn median_filter_removes_a_spike() {
        let dims = Dims::new(7, 6).unwrap();
        let mut src = vec![1.0f32; dims.pixels()];
        src[3 * 7 + 3] = 50.0;
        let m = median_filter(&src, dims, 2);
        assert!(m.iter().all(|&v| v == 1.0));
    }
}
