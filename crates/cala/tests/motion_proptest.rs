//! Property tests for motion correction: the session warp, the FFT
//! cross-correlator and the streaming `MotionCorrector` on random input.
//!
//! Raise the case count with `PROPTEST_CASES=1000 cargo test --test motion_proptest`.

use calab_cala::motion::session::{SessionTransform, SessionWarp};
use calab_cala::motion::{Correlator, Frame, Frames, MotionConfig, MotionCorrector};
use proptest::prelude::*;

// ---- Session warp ----------------------------------------------------------

fn frame(h: usize, w: usize) -> impl Strategy<Value = Vec<f32>> {
    prop::collection::vec(0.0f32..255.0, h * w)
}

fn dims() -> impl Strategy<Value = (usize, usize)> {
    (1usize..=24, 1usize..=24)
}

proptest! {
    /// The identity transform copies the frame exactly.
    #[test]
    fn session_identity_is_copy(((h, w), img) in dims().prop_flat_map(|(h, w)| (Just((h, w)), frame(h, w)))) {
        let warp = SessionWarp::new(h, w, SessionTransform::IDENTITY).unwrap();
        let mut out = vec![0.0; h * w];
        warp.apply(&img, &mut out).unwrap();
        prop_assert_eq!(out, img);
    }

    /// Any finite transform yields finite output of the right size, and a
    /// constant frame stays (nearly) constant (bicubic weights sum to one).
    #[test]
    fn session_warp_finite_and_preserves_constant(
        (h, w) in dims(),
        rot in -180.0f32..180.0,
        dy in -30.0f32..30.0,
        dx in -30.0f32..30.0,
        c in 0.0f32..255.0,
    ) {
        let t = SessionTransform { rotation_deg: rot, dy, dx };
        let warp = SessionWarp::new(h, w, t).unwrap();
        let src = vec![c; h * w];
        let mut out = vec![0.0; h * w];
        warp.apply(&src, &mut out).unwrap();
        for v in out {
            prop_assert!(v.is_finite());
            prop_assert!((v - c).abs() < 1e-2 * (1.0 + c), "{v} vs {c}");
        }
    }

    /// Non-finite transforms and wrong buffer sizes are errors, not panics.
    #[test]
    fn session_bad_inputs_err((h, w) in dims(), bad in 0usize..3) {
        let mut v = [1.0f32, 2.0, 3.0];
        v[bad] = f32::NAN;
        prop_assert!(SessionTransform::from_array(v).is_err());
        let warp = SessionWarp::new(h, w, SessionTransform::IDENTITY).unwrap();
        let mut out = vec![0.0; h * w];
        prop_assert!(warp.apply(&vec![0.0; h * w + 1], &mut out).is_err());
    }
}

// ---- Cross-correlation -------------------------------------------------------

/// Smooth texture: a sum of Gaussian blobs, evaluated analytically at
/// `(y - sy, x - sx)` so a shift needs no interpolation.
fn texture(h: usize, w: usize, blobs: &[(f32, f32, f32)], sy: f32, sx: f32) -> Vec<f32> {
    let mut img = vec![0.0f32; h * w];
    for y in 0..h {
        for x in 0..w {
            let (py, px) = (y as f32 - sy, x as f32 - sx);
            img[y * w + x] = blobs
                .iter()
                .map(|&(cy, cx, a)| {
                    let d2 = (py - cy).powi(2) + (px - cx).powi(2);
                    a * (-d2 / (2.0 * 3.0 * 3.0)).exp()
                })
                .sum();
        }
    }
    // Zero mean, like the corrector's band-passed registration image.
    let mean = img.iter().sum::<f32>() / img.len() as f32;
    img.iter_mut().for_each(|v| *v -= mean);
    img
}

/// Window-filling texture: a sum of plane waves `(fy, fx, phase)` (cycles
/// per px), evaluated analytically at `(y - sy, x - sx)`.
fn waves(h: usize, w: usize, waves: &[(f32, f32, f32)], sy: f32, sx: f32) -> Vec<f32> {
    let mut img = vec![0.0f32; h * w];
    for y in 0..h {
        for x in 0..w {
            let (py, px) = (y as f32 - sy, x as f32 - sx);
            img[y * w + x] = waves
                .iter()
                .map(|&(fy, fx, p)| (std::f32::consts::TAU * (fy * py + fx * px) + p).cos())
                .sum();
        }
    }
    img
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// `register` recovers a known shift of a few blobs clustered in the
    /// middle of the window, with a high normalised correlation.
    ///
    /// The tolerance grows with the shift because the estimator has a known
    /// gain on this kind of content. Every correlation value is divided by
    /// the Tukey window's overlap envelope (its autocorrelation), which is
    /// exact for texture that fills the window (see `xcorr_exact_on_texture`)
    /// but over-corrects content that sits in the window's flat middle and so
    /// is not attenuated by it: a lone sigma-3 blob reads 2 px as 2.18, and
    /// a tight cluster of blobs, whose correlation peak is broad, can read
    /// 0.5 px as 0.96 and 4 px as 5.2 (worst of 20 000 random cases: 1.28 px
    /// off, 0.64 px beyond 0.35 |s|). It does not reach cala's registration:
    /// the corrector correlates band-passed frames that fill the region and
    /// re-cuts the crop at the integer estimate, so the final residual is
    /// under a pixel. End to end on the v3 motion sims (seeds 5-9, 9600
    /// frames each) the rigid shift's gain is 0.994-1.001 and its RMS error
    /// 0.04-0.05 px, the same with the envelope division switched off
    /// (`tools/cala-eval/results/2026-11-26-motion-xcorr-bias.md`).
    #[test]
    fn xcorr_recovers_shift(
        blobs in prop::collection::vec((20.0f32..44.0, 20.0f32..44.0, 0.5f32..2.0), 6..14),
        sy in -4.0f32..4.0,
        sx in -4.0f32..4.0,
    ) {
        let n = 64;
        let reference = texture(n, n, &blobs, 0.0, 0.0);
        let moved = texture(n, n, &blobs, sy, sx);
        let mut c = Correlator::new(n, n, 0.3).unwrap();
        let mut rs = c.make_spectrum();
        let mut ms = c.make_spectrum();
        let er = c.spectrum(&reference, &mut rs).unwrap();
        let em = c.spectrum(&moved, &mut ms).unwrap();
        let p = c.register(&rs, er, &ms, em, 8.0, 10).unwrap();
        // Content moved by (sy, sx); the registering shift is its negative.
        let tol = |s: f32| 0.8 + 0.35 * s.abs();
        prop_assert!((p.dy + sy).abs() < tol(sy), "dy {} vs {}", p.dy, -sy);
        prop_assert!((p.dx + sx).abs() < tol(sx), "dx {} vs {}", p.dx, -sx);
        prop_assert!(p.ncc > 0.5 && p.ncc <= 1.0 + 1e-3, "ncc {}", p.ncc);
    }

    /// On smooth texture that fills the window (what the corrector
    /// correlates: band-passed frames covering the region) `register` has no
    /// gain bias. Without the window-envelope division the taper pulls the
    /// estimate towards zero by about 4 % of the shift, which this catches
    /// (on 2000 random cases it fails 6 % of them, so nearly every 64-case
    /// run).
    #[test]
    fn xcorr_exact_on_texture(
        w in prop::collection::vec(
            (-0.1f32..0.1, -0.1f32..0.1, 0.0f32..std::f32::consts::TAU),
            40..80,
        ),
        sy in -4.0f32..4.0,
        sx in -4.0f32..4.0,
    ) {
        let n = 64;
        let reference = waves(n, n, &w, 0.0, 0.0);
        let moved = waves(n, n, &w, sy, sx);
        let mut c = Correlator::new(n, n, 0.3).unwrap();
        let mut rs = c.make_spectrum();
        let mut ms = c.make_spectrum();
        let er = c.spectrum(&reference, &mut rs).unwrap();
        let em = c.spectrum(&moved, &mut ms).unwrap();
        let p = c.register(&rs, er, &ms, em, 8.0, 10).unwrap();
        // Worst of 20 000 random cases: 0.069 px beyond 0.02 |s|.
        let tol = |s: f32| 0.1 + 0.02 * s.abs();
        prop_assert!((p.dy + sy).abs() < tol(sy), "dy {} vs {}", p.dy, -sy);
        prop_assert!((p.dx + sx).abs() < tol(sx), "dx {} vs {}", p.dx, -sx);
        prop_assert!(p.ncc > 0.8, "ncc {}", p.ncc);
    }

    /// A blank image has nothing to align: zero shift, zero quality.
    #[test]
    fn xcorr_blank_is_zero(n in 8usize..40) {
        let mut c = Correlator::new(n, n, 0.3).unwrap();
        let mut rs = c.make_spectrum();
        let mut ms = c.make_spectrum();
        let blank = vec![0.0f32; n * n];
        let er = c.spectrum(&blank, &mut rs).unwrap();
        let em = c.spectrum(&blank, &mut ms).unwrap();
        let p = c.register(&rs, er, &ms, em, 4.0, 10).unwrap();
        prop_assert_eq!((p.dy, p.dx, p.ncc), (0.0, 0.0, 0.0));
    }
}

// ---- MotionCorrector ---------------------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Process(Vec<u8>),
    ProcessWrongSize(usize),
    ProcessNonFinite(usize),
    Initialize(Vec<u8>),
}

fn op(px: usize) -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => prop::collection::vec(any::<u8>(), px).prop_map(Op::Process),
        1 => (0usize..px * 2).prop_filter("not px", move |n| *n != px).prop_map(Op::ProcessWrongSize),
        1 => (0..px).prop_map(Op::ProcessNonFinite),
        1 => (1usize..4).prop_flat_map(move |k| prop::collection::vec(any::<u8>(), px * k)).prop_map(Op::Initialize),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Random frame sequences (including blank, wrong-size and NaN frames)
    /// never panic; successful output is finite and the right size.
    #[test]
    fn corrector_never_panics(
        (h, w) in (8usize..48, 8usize..48),
        max_shift in prop_oneof![Just(0.0f32), 1.0f32..20.0, -5.0f32..0.0],
        ops in (8usize..48, 8usize..48).prop_flat_map(|(h, w)| {
            prop::collection::vec(op(h * w), 1..8).prop_map(move |o| (h, w, o))
        }),
    ) {
        let _ = (h, w);
        let (h, w, ops) = ops;
        let cfg = MotionConfig { max_shift, ..MotionConfig::default() };
        let Ok(mut mc) = MotionCorrector::new(h, w, cfg) else { return Ok(()); };
        let px = h * w;
        let mut out = vec![0.0f32; px];
        for o in ops {
            match o {
                Op::Process(f) => {
                    if mc.process(Frame::U8(&f), &mut out).is_ok() {
                        prop_assert!(out.iter().all(|v| v.is_finite()));
                    }
                }
                Op::ProcessWrongSize(n) => {
                    prop_assert!(mc.process(Frame::U8(&vec![0u8; n]), &mut out).is_err());
                }
                Op::ProcessNonFinite(i) => {
                    let mut f = vec![1.0f32; px];
                    f[i] = f32::NAN;
                    prop_assert!(mc.process(Frame::F32(&f), &mut out).is_err());
                }
                Op::Initialize(f) => {
                    let _ = mc.initialize(Frames::U8(&f));
                }
            }
        }
    }
}
