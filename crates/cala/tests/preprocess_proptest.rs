//! Property tests for the streaming preprocess stages: Gaussian blur,
//! running-minimum background and the noise map.
//!
//! Raise the case count with `PROPTEST_CASES=1000 cargo test --test preprocess_proptest`.

use calab_cala::preprocess::background::{BackgroundConfig, RunningMinBackground};
use calab_cala::preprocess::gaussian::RecursiveGaussian;
use calab_cala::preprocess::noise::{NoiseConfig, NoiseEstimator, NoiseMap};
use calab_cala::preprocess::Dims;
use proptest::prelude::*;

fn dims() -> impl Strategy<Value = (usize, usize)> {
    (1usize..=40, 1usize..=40)
}

fn image(n: usize) -> impl Strategy<Value = Vec<f32>> {
    prop::collection::vec(0.0f32..1000.0, n)
}

// ---- Gaussian ------------------------------------------------------------------

proptest! {
    /// Output is finite, non-negative for non-negative input, and (zero
    /// padding only loses mass) never carries more total than the input.
    #[test]
    fn gaussian_finite_nonneg_mass_bounded(
        ((w, h), img) in dims().prop_flat_map(|(w, h)| (Just((w, h)), image(w * h))),
        sigma in 0.5f32..6.0,
    ) {
        let d = Dims::new(w, h).unwrap();
        let mut g = RecursiveGaussian::new(d, sigma).unwrap();
        let mut out = vec![0.0; w * h];
        g.blur(&img, &mut out).unwrap();
        let (si, so): (f64, f64) = (
            img.iter().map(|&v| f64::from(v)).sum(),
            out.iter().map(|&v| f64::from(v)).sum(),
        );
        prop_assert!(out.iter().all(|v| v.is_finite() && *v >= -1e-2));
        prop_assert!(so <= si * 1.01 + 1e-3, "{so} > {si}");
    }

    /// The blur is linear: blur(k * x) = k * blur(x).
    #[test]
    fn gaussian_is_linear(
        ((w, h), img) in dims().prop_flat_map(|(w, h)| (Just((w, h)), image(w * h))),
        sigma in 0.5f32..4.0,
        k in 0.1f32..4.0,
    ) {
        let d = Dims::new(w, h).unwrap();
        let mut g = RecursiveGaussian::new(d, sigma).unwrap();
        let (mut a, mut b) = (vec![0.0; w * h], vec![0.0; w * h]);
        g.blur(&img, &mut a).unwrap();
        let scaled: Vec<f32> = img.iter().map(|v| v * k).collect();
        g.blur(&scaled, &mut b).unwrap();
        for (x, y) in a.iter().zip(&b) {
            prop_assert!((x * k - y).abs() <= 1e-2 * (1.0 + y.abs()), "{} vs {y}", x * k);
        }
    }

    /// Far from the borders a constant image stays constant.
    #[test]
    fn gaussian_preserves_constant_interior(c in 0.0f32..1000.0, sigma in 0.5f32..3.0) {
        let d = Dims::new(48, 48).unwrap();
        let mut g = RecursiveGaussian::new(d, sigma).unwrap();
        let mut out = vec![0.0; 48 * 48];
        g.blur(&vec![c; 48 * 48], &mut out).unwrap();
        let v = out[24 * 48 + 24];
        prop_assert!((v - c).abs() <= 1e-2 * (1.0 + c), "{v} vs {c}");
    }

    /// Bad sigma and wrong buffer sizes are errors, not panics.
    #[test]
    fn gaussian_bad_inputs_err((w, h) in dims(), extra in 1usize..4) {
        let d = Dims::new(w, h).unwrap();
        for s in [0.0f32, 0.49, -1.0, f32::NAN, f32::INFINITY] {
            prop_assert!(RecursiveGaussian::new(d, s).is_err());
        }
        let mut g = RecursiveGaussian::new(d, 1.5).unwrap();
        let mut out = vec![0.0; w * h];
        prop_assert!(g.blur(&vec![0.0; w * h + extra], &mut out).is_err());
        prop_assert!(Dims::new(0, h).is_err());
    }
}

// ---- Background ------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Random configs and frames: no panics; valid configs give finite output.
    #[test]
    fn background_never_panics(
        (w, h) in (1usize..=16, 1usize..=16),
        boxcar in 0usize..300,
        relax in prop_oneof![Just(0.0f32), 1.0f32..500.0, -5.0f32..0.9, Just(f32::NAN)],
        frames in prop::collection::vec(prop::collection::vec(0.0f32..1000.0, 256), 1..12),
    ) {
        let d = Dims::new(w, h).unwrap();
        let cfg = BackgroundConfig { boxcar, relax_frames: relax, snapshot_every: 0 };
        let valid = cfg.validate().is_ok();
        match RunningMinBackground::new(d, &cfg) {
            Err(_) => prop_assert!(!valid),
            Ok(mut bg) => {
                prop_assert!(valid);
                for f in &frames {
                    let mut f = f[..w * h].to_vec();
                    bg.process(&mut f).unwrap();
                    prop_assert!(f.iter().all(|v| v.is_finite()));
                }
            }
        }
    }

    /// With no averaging (boxcar 1) and no relaxation the floor is the running
    /// minimum of the frames themselves, so the subtracted frame is
    /// non-negative. (A longer boxcar takes a minimum of averages, which can
    /// sit above a single frame.)
    #[test]
    fn background_pure_min_nonneg(
        (w, h) in (1usize..=16, 1usize..=16),
        frames in prop::collection::vec(prop::collection::vec(0.0f32..1000.0, 256), 1..12),
    ) {
        let d = Dims::new(w, h).unwrap();
        let cfg = BackgroundConfig { boxcar: 1, relax_frames: 0.0, snapshot_every: 0 };
        let mut bg = RunningMinBackground::new(d, &cfg).unwrap();
        for f in &frames {
            let mut f = f[..w * h].to_vec();
            bg.process(&mut f).unwrap();
            prop_assert!(f.iter().all(|v| *v >= -1e-3), "{:?}", f.iter().cloned().fold(f32::MAX, f32::min));
        }
    }
}

// ---- Noise map ---------------------------------------------------------------------

fn estimator() -> impl Strategy<Value = NoiseEstimator> {
    prop_oneof![
        Just(NoiseEstimator::MeanAbs),
        (0.0001f32..0.4).prop_map(|eta| NoiseEstimator::MedianTracker { eta }),
        Just(NoiseEstimator::MedianTracker { eta: 0.9 }),
        Just(NoiseEstimator::MedianTracker { eta: f32::NAN }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Random frames: sigma has one finite, non-negative value per pixel;
    /// invalid configs are rejected at construction.
    #[test]
    fn noise_sigma_finite_nonneg(
        (w, h) in (1usize..=16, 1usize..=16),
        est in estimator(),
        init_frames in 0u32..6,
        dither in any::<bool>(),
        frames in prop::collection::vec(prop::collection::vec(0.0f32..1000.0, 256), 1..12),
    ) {
        let d = Dims::new(w, h).unwrap();
        let cfg = NoiseConfig { estimator: est, init_frames, dither };
        let valid = cfg.validate().is_ok();
        match NoiseMap::new(d, &cfg) {
            Err(_) => prop_assert!(!valid),
            Ok(mut nm) => {
                prop_assert!(valid);
                for f in &frames {
                    nm.update(&f[..w * h]).unwrap();
                }
                let s = nm.sigma();
                prop_assert_eq!(s.len(), w * h);
                prop_assert!(s.iter().all(|v| v.is_finite() && *v >= 0.0));
            }
        }
    }

    /// A constant stream has no frame-to-frame noise.
    #[test]
    fn noise_constant_stream_is_zero((w, h) in (1usize..=16, 1usize..=16), c in 0.0f32..1000.0) {
        let d = Dims::new(w, h).unwrap();
        let cfg = NoiseConfig { estimator: NoiseEstimator::MeanAbs, init_frames: 1, dither: false };
        let mut nm = NoiseMap::new(d, &cfg).unwrap();
        for _ in 0..6 {
            nm.update(&vec![c; w * h]).unwrap();
        }
        prop_assert!(nm.sigma().iter().all(|v| v.abs() < 1e-3));
    }
}
