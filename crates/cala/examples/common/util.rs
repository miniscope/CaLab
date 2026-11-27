//! Small helpers shared by the evaluation programs.

use std::io::Write;

/// Pearson correlation of equal-length series, accumulated in f64; 0 when
/// either is constant.
pub fn pearson(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len() as f64;
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

/// Linearly interpolated `q` quantile of the finite values (NaN if none).
pub fn quantile(v: &[f64], q: f64) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(f64::total_cmp);
    let pos = q * (s.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    s[lo] + (s[hi] - s[lo]) * (pos - lo as f64)
}

/// The value after flag `key` in `args`.
pub fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

/// Write `v` as little-endian f32s.
pub fn write_f32s(f: &mut impl Write, v: &[f32]) {
    for x in v {
        f.write_all(&x.to_le_bytes()).unwrap();
    }
}
