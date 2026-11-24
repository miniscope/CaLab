//! Property tests for the 2-D real FFT used by motion registration.
//!
//! Raise the case count locally with `PROPTEST_CASES=2000 cargo test --test fft_proptest`.

use calab_cala::motion::fft2d::{fft_friendly_size, signed_freq, Fft2d};
use proptest::prelude::*;

/// Image of random size (2..=24 per side, odd and even) with finite pixels.
fn image() -> impl Strategy<Value = (usize, usize, Vec<f32>)> {
    (2usize..=24, 2usize..=24).prop_flat_map(|(h, w)| {
        (
            Just(h),
            Just(w),
            prop::collection::vec(-100.0f32..100.0, h * w),
        )
    })
}

proptest! {
    /// forward then inverse returns the input scaled by h*w (unnormalised).
    #[test]
    fn round_trip_recovers_input((h, w, img) in image()) {
        let mut fft = Fft2d::new(h, w).unwrap();
        let mut spec = fft.make_spectrum();
        let mut out = vec![0.0f32; h * w];
        fft.forward(&img, &mut spec).unwrap();
        fft.inverse(&mut spec, &mut out).unwrap();
        let n = (h * w) as f32;
        for (a, b) in img.iter().zip(&out) {
            prop_assert!((a - b / n).abs() < 1e-3, "{a} vs {}", b / n);
        }
    }

    /// DC bin equals the pixel sum.
    #[test]
    fn dc_is_sum((h, w, img) in image()) {
        let mut fft = Fft2d::new(h, w).unwrap();
        let mut spec = fft.make_spectrum();
        fft.forward(&img, &mut spec).unwrap();
        let sum: f32 = img.iter().sum();
        let dc = spec[fft.index(0, 0)];
        prop_assert!((dc.re - sum).abs() < 1e-2 * (1.0 + sum.abs()));
        prop_assert!(dc.im.abs() < 1e-2 * (1.0 + sum.abs()));
    }

    /// Wrong buffer lengths are an Err, never a panic.
    #[test]
    fn wrong_lengths_err((h, w, img) in image(), extra in 1usize..5) {
        let mut fft = Fft2d::new(h, w).unwrap();
        let mut spec = fft.make_spectrum();
        prop_assert!(fft.forward(&img[..img.len() - extra.min(img.len())], &mut spec).is_err());
        let mut out = vec![0.0f32; h * w + extra];
        prop_assert!(fft.inverse(&mut spec, &mut out).is_err());
    }

    #[test]
    fn friendly_size_is_valid_and_not_larger(n in 0usize..5000) {
        let m = fft_friendly_size(n);
        prop_assert!(m <= n.max(1) || n < 2);
        if n >= 2 {
            prop_assert!(m >= 2 && m.is_multiple_of(2));
            let mut r = m;
            for p in [2, 3, 5] { while r.is_multiple_of(p) { r /= p; } }
            prop_assert_eq!(r, 1);
        }
    }

    #[test]
    fn signed_freq_in_range(n in 1usize..512, k in 0usize..512) {
        let k = k % n;
        let f = signed_freq(k, n);
        prop_assert!(f > -(n as isize) && f <= (n as isize) / 2);
        prop_assert_eq!(f.rem_euclid(n as isize) as usize, k);
    }
}
