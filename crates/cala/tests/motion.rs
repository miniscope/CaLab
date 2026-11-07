//! Motion correction against the minisim fixture in `fixtures/motion_small`
//! (see its README), plus synthetic and degenerate inputs.

mod common;

use calab_cala::motion::{
    Frame, Frames, MotionConfig, MotionCorrector, MotionError, MotionRecord, NonRigidConfig,
};
use common::metrics::{patch_rmse_aligned, shift_rmse_aligned, Truth};
use common::npy::Npy;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/motion_small");

struct Fixture {
    n: usize,
    h: usize,
    w: usize,
    movie: Vec<u8>,
    truth: Truth,
}

fn load() -> Fixture {
    let m = Npy::read(format!("{FIX}/movie.npy")).unwrap();
    let (n, h, w) = (m.shape[0], m.shape[1], m.shape[2]);
    let movie = m.into_u8().unwrap();
    let pairs = |v: Vec<f64>| v.chunks(2).map(|c| (c[0], c[1])).collect::<Vec<_>>();
    let truth = Truth {
        shifts: pairs(Npy::read(format!("{FIX}/shifts.npy")).unwrap().into_f64()),
        field: Npy::read(format!("{FIX}/nonrigid_field.npy"))
            .unwrap()
            .into_f64(),
        nodes_y: Npy::read(format!("{FIX}/nonrigid_nodes_y.npy"))
            .unwrap()
            .into_f64(),
        nodes_x: Npy::read(format!("{FIX}/nonrigid_nodes_x.npy"))
            .unwrap()
            .into_f64(),
    };
    assert_eq!(truth.frames(), n);
    Fixture {
        n,
        h,
        w,
        movie,
        truth,
    }
}

fn run(fx: &Fixture, cfg: MotionConfig) -> (MotionCorrector, Vec<MotionRecord>, Vec<f32>) {
    let px = fx.h * fx.w;
    let mut mc = MotionCorrector::new(fx.h, fx.w, cfg).unwrap();
    let warm = fx.n.min(100);
    mc.initialize(Frames::U8(&fx.movie[..warm * px])).unwrap();
    let mut out = vec![0.0; fx.n * px];
    let mut recs = Vec::new();
    for i in 0..fx.n {
        let r = mc
            .process(
                Frame::U8(&fx.movie[i * px..(i + 1) * px]),
                &mut out[i * px..(i + 1) * px],
            )
            .unwrap();
        recs.push(r);
    }
    (mc, recs, out)
}

fn nonrigid_cfg() -> MotionConfig {
    MotionConfig {
        nonrigid: Some(NonRigidConfig::default()),
        ..MotionConfig::default()
    }
}

/// Pearson correlation of two series.
fn corr(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
    cov / (va * vb).sqrt()
}

/// Rigid shifts against minisim's ground truth (content-calibrated preset;
/// measured 0.28 px RMSE, correlation 0.97 / 0.96). Cell activity still moves
/// the registration peak by a few tenths of a pixel on a 128 px field (see
/// the fixture README); the sub-pixel accuracy check is
/// `recovers_known_shifts_of_a_static_image`.
#[test]
fn rigid_tracks_minisim_motion() {
    let fx = load();
    let (_, recs, _) = run(&fx, MotionConfig::default());
    let est: Vec<(f64, f64)> = recs.iter().map(|r| (r.dy as f64, r.dx as f64)).collect();
    let rmse = shift_rmse_aligned(&est, &fx.truth.shifts);
    let axis = |k: usize| {
        let e: Vec<f64> = est.iter().map(|v| -[v.0, v.1][k]).collect();
        let t: Vec<f64> = fx.truth.shifts.iter().map(|v| [v.0, v.1][k]).collect();
        corr(&e, &t)
    };
    let (cy, cx) = (axis(0), axis(1));
    eprintln!("rigid RMSE vs minisim shifts: {rmse:.4} px, corr dy {cy:.3} dx {cx:.3}");
    assert!(rmse < 0.35, "rigid RMSE {rmse}");
    assert!(cy > 0.94 && cx > 0.94, "corr {cy} {cx}");
    assert!(recs.iter().all(|r| r.quality > 0.3));
}

/// Patch shifts against the true (rigid + non-rigid) motion at the patch
/// centres. On this fixture the patch estimates are limited by the same
/// content changes as the rigid ones; the check is that the non-rigid stage
/// (with its shrinkage) does not make the local error materially worse.
#[test]
fn nonrigid_patch_error_on_minisim() {
    let fx = load();
    let (mc, nr, _) = run(&fx, nonrigid_cfg());
    let (_, rg, _) = run(&fx, MotionConfig::default());
    let g = mc.geometry().unwrap();
    let pts: Vec<(f64, f64)> = g
        .node_ys
        .iter()
        .flat_map(|&y| g.node_xs.iter().map(move |&x| (y, x)))
        .collect();
    let frames: Vec<usize> = (0..fx.n).collect();
    let on: Vec<Vec<(f64, f64)>> = nr
        .iter()
        .map(|r| {
            (0..pts.len())
                .map(|p| {
                    (
                        (r.dy + r.residual[2 * p]) as f64,
                        (r.dx + r.residual[2 * p + 1]) as f64,
                    )
                })
                .collect()
        })
        .collect();
    let off: Vec<Vec<(f64, f64)>> = rg
        .iter()
        .map(|r| vec![(r.dy as f64, r.dx as f64); pts.len()])
        .collect();
    let e_on = patch_rmse_aligned(&on, &fx.truth, &frames, &pts);
    let e_off = patch_rmse_aligned(&off, &fx.truth, &frames, &pts);
    eprintln!("patch RMSE: rigid-only {e_off:.4} px, non-rigid {e_on:.4} px");
    assert!(
        e_off < 0.4 && e_on < 1.3 * e_off,
        "non-rigid {e_on} vs rigid {e_off}"
    );
}

/// A static scene (the fixture's mean) moved by a known rigid trajectory plus
/// a smooth, slowly varying field on the corrector's patch grid: the
/// non-rigid stage must recover the local motion clearly better than rigid.
#[test]
fn nonrigid_recovers_a_known_field() {
    let fx = load();
    let (h, w) = (fx.h, fx.w);
    let px = h * w;
    let mut base = vec![0.0f32; px];
    for i in 0..fx.n {
        for (b, &v) in base.iter_mut().zip(&fx.movie[i * px..(i + 1) * px]) {
            *b += v as f32 / fx.n as f32;
        }
    }
    let cfg = MotionConfig {
        nonrigid: Some(NonRigidConfig {
            grid: (3, 3),
            ..NonRigidConfig::default()
        }),
        ..MotionConfig::default()
    };
    let mut mc = MotionCorrector::new(h, w, cfg).unwrap();
    mc.initialize(Frames::F32(&base)).unwrap();
    let g = mc.geometry().unwrap().clone();
    let mut warper = g.warper().unwrap();
    let ng = g.node_ys.len() * g.node_xs.len();
    let mut state = 11u64;
    let mut rnd = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64 / (1u64 << 53) as f64 - 0.5) as f32
    };
    // Smooth deformation, as measured on real data (local shear, not
    // rotation or scale): an AR(1) (rho 0.9) affine gradient across the grid
    // plus a small independent part per node, and a rigid AR(1) trajectory.
    let (gy, gx) = (g.node_ys.len(), g.node_xs.len());
    let mut grad = [0.0f32; 4];
    let mut local = vec![0.0f32; 2 * ng];
    let mut field = vec![0.0f32; 2 * ng];
    let mut rigid = (0.0f32, 0.0f32);
    let mut moved = vec![0.0; px];
    let mut out = vec![0.0; px];
    let (mut e_nr, mut e_rg, mut count) = (0.0f64, 0.0f64, 0.0f64);
    for t in 0..120 {
        for v in grad.iter_mut() {
            *v = 0.9 * *v + 0.9 * rnd();
        }
        for v in local.iter_mut() {
            *v = 0.9 * *v + 0.2 * rnd();
        }
        for i in 0..gy {
            for j in 0..gx {
                // Node position in [-1, 1] across the grid.
                let u = 2.0 * i as f32 / (gy - 1) as f32 - 1.0;
                let v = 2.0 * j as f32 / (gx - 1) as f32 - 1.0;
                let k = i * gx + j;
                field[2 * k] = grad[0] * u + grad[1] * v + local[2 * k];
                field[2 * k + 1] = grad[2] * u + grad[3] * v + local[2 * k + 1];
            }
        }
        rigid = (0.9 * rigid.0 + rnd(), 0.9 * rigid.1 + rnd());
        // Content moves by (rigid, field); the registering record is minus that.
        warper.warp(&base, rigid, &field, &mut moved, None).unwrap();
        let r = mc.process(Frame::F32(&moved), &mut out).unwrap();
        if t < 20 {
            continue; // let the temporal smoother and noise estimates settle
        }
        for k in 0..ng {
            for c in 0..2 {
                let truth = -([rigid.0, rigid.1][c] + field[2 * k + c]);
                let rig = [r.dy, r.dx][c];
                e_nr += ((rig + r.residual[2 * k + c] - truth) as f64).powi(2);
                e_rg += ((rig - truth) as f64).powi(2);
                count += 1.0;
            }
        }
    }
    let (e_nr, e_rg) = ((e_nr / count).sqrt(), (e_rg / count).sqrt());
    eprintln!("known field: patch RMSE rigid-only {e_rg:.4} px, non-rigid {e_nr:.4} px");
    assert!(e_nr < 0.7 * e_rg, "non-rigid {e_nr} vs rigid {e_rg}");
}

#[test]
fn replay_is_exact() {
    let fx = load();
    let px = fx.h * fx.w;
    let (mut mc, recs, out) = run(&fx, nonrigid_cfg());
    let geom = mc.geometry().unwrap().clone();
    let mut warper = geom.warper().unwrap();
    let mut a = vec![0.0; px];
    let mut b = vec![0.0; px];
    for i in [0, 37, fx.n - 1] {
        let frame = &fx.movie[i * px..(i + 1) * px];
        mc.apply(Frame::U8(frame), &recs[i], &mut a, None).unwrap();
        assert_eq!(a, out[i * px..(i + 1) * px], "frame {i}");
        // A warper built from the geometry alone replays identically,
        // including through the flat record format.
        let mut flat = vec![0.0; mc.record_len()];
        recs[i].write_flat(&mut flat).unwrap();
        let back = MotionRecord::from_flat(&flat).unwrap();
        let src: Vec<f32> = frame.iter().map(|&v| v as f32).collect();
        warper
            .warp(&src, (back.dy, back.dx), &back.residual, &mut b, None)
            .unwrap();
        assert_eq!(a, b, "frame {i} via geometry");
    }
}

#[test]
fn recovers_known_shifts_of_a_static_image() {
    let fx = load();
    let (h, w) = (fx.h, fx.w);
    let px = h * w;
    // Static scene: the mean of the movie (sharp enough after averaging).
    let mut base = vec![0.0f32; px];
    for i in 0..fx.n {
        for (b, &v) in base.iter_mut().zip(&fx.movie[i * px..(i + 1) * px]) {
            *b += v as f32 / fx.n as f32;
        }
    }
    let shifts = [
        (0.0f32, 0.0f32),
        (0.5, -0.25),
        (2.3, 1.7),
        (-3.0, 0.0),
        (-1.35, -4.6),
        (6.2, 3.1),
    ];
    // Moving frames: base sampled at p - d (content moves by d), so the
    // registering shift is -d. A bicubic warper does the resampling.
    let mut wp =
        calab_cala::motion::Warper::new(h, w, &[], &[], calab_cala::motion::Interpolation::Bicubic)
            .unwrap();
    let cfg = MotionConfig {
        template_tau: 0.0,
        // Away from the frame edge, where the synthetic warp replicates
        // border pixels that do not move with the scene.
        roi: Some(calab_cala::motion::Roi {
            y0: 16,
            x0: 16,
            height: 96,
            width: 96,
        }),
        ..MotionConfig::default()
    };
    let mut mc = MotionCorrector::new(h, w, cfg).unwrap();
    mc.initialize(Frames::F32(&base)).unwrap();
    let mut moved = vec![0.0; px];
    let mut out = vec![0.0; px];
    for &(dy, dx) in &shifts {
        wp.warp(&base, (dy, dx), &[], &mut moved, None).unwrap();
        let r = mc.process(Frame::F32(&moved), &mut out).unwrap();
        let (ey, ex) = (r.dy + dy, r.dx + dx);
        eprintln!("known ({dy}, {dx}): error ({ey:.4}, {ex:.4})");
        assert!(
            ey.abs() < 0.05 && ex.abs() < 0.05,
            "shift ({dy},{dx}) error ({ey},{ex})"
        );
    }
}

#[test]
fn degenerate_inputs_never_panic() {
    // Tiny frames are rejected up front.
    assert!(matches!(
        MotionCorrector::new(8, 8, MotionConfig::default()),
        Err(MotionError::InvalidConfig(_))
    ));
    // Bad configs are rejected.
    let bad = MotionConfig {
        upsample: 1000,
        ..MotionConfig::default()
    };
    assert!(MotionCorrector::new(64, 64, bad).is_err());

    let (h, w) = (64, 64);
    let px = h * w;
    let small_grid = MotionConfig {
        nonrigid: Some(NonRigidConfig {
            grid: (2, 2),
            ..NonRigidConfig::default()
        }),
        ..MotionConfig::default()
    };
    for cfg in [MotionConfig::default(), small_grid] {
        let mut mc = MotionCorrector::new(h, w, cfg).unwrap();
        let mut out = vec![0.0; px];
        // Wrong sizes.
        assert!(mc.process(Frame::U8(&[0u8; 10]), &mut out).is_err());
        // Blank frames before any template: bootstrap, then hold at zero.
        let blank = vec![0u8; px];
        let r = mc.process(Frame::U8(&blank), &mut out).unwrap();
        assert!(r.dy == 0.0 && r.dx == 0.0 && r.quality == 0.0);
        let r = mc.process(Frame::U8(&blank), &mut out).unwrap();
        assert!(r.flags & calab_cala::motion::FLAG_HELD != 0);
        // Saturated and NaN frames.
        let sat = vec![255u8; px];
        let r = mc.process(Frame::U8(&sat), &mut out).unwrap();
        assert!(r.dy.is_finite() && out.iter().all(|v| v.is_finite()));
        let mut nan = vec![1.0f32; px];
        nan[5] = f32::NAN;
        assert!(matches!(
            mc.process(Frame::F32(&nan), &mut out),
            Err(MotionError::NonFinite(_))
        ));
        // Malformed records on replay.
        let rec = MotionRecord {
            dy: f32::INFINITY,
            dx: 0.0,
            quality: 0.0,
            flags: 0,
            residual: Vec::new(),
        };
        assert!(mc.apply(Frame::U8(&blank), &rec, &mut out, None).is_err());
        assert!(MotionRecord::from_flat(&[1.0]).is_err());
    }

    // A textured template then a blank frame: hold the previous shift.
    let fx = load();
    let px = fx.h * fx.w;
    let mut mc = MotionCorrector::new(fx.h, fx.w, MotionConfig::default()).unwrap();
    mc.initialize(Frames::U8(&fx.movie[..20 * px])).unwrap();
    let mut out = vec![0.0; px];
    let r0 = mc.process(Frame::U8(&fx.movie[..px]), &mut out).unwrap();
    let r1 = mc.process(Frame::U8(&vec![0u8; px]), &mut out).unwrap();
    assert_eq!((r1.dy, r1.dx), (r0.dy, r0.dx));
    assert!(r1.flags & calab_cala::motion::FLAG_HELD != 0);
    // A flash (+15 grey levels) is corrected but not folded into the template.
    let flash: Vec<u8> = fx.movie[px..2 * px]
        .iter()
        .map(|&v| v.saturating_add(15))
        .collect();
    let r2 = mc.process(Frame::U8(&flash), &mut out).unwrap();
    assert!(
        r2.flags & calab_cala::motion::FLAG_ANOMALOUS != 0,
        "flags {}",
        r2.flags
    );
    assert!(r2.flags & calab_cala::motion::FLAG_TEMPLATE_UPDATED == 0);
}
