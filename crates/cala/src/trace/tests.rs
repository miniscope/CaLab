// Index loops over cells read more clearly than zipped iterators here.
#![allow(clippy::needless_range_loop)]

use std::sync::Arc;

use super::*;
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::preprocess::hot_pixels::HotPixelMap;
use crate::preprocess::{Calibration, Dims, NoRegistration, PreprocessConfig, Preprocessor};

const W: usize = 64;
const H: usize = 56;

fn dims() -> Dims {
    Dims::new(W, H).unwrap()
}

/// Deterministic uniform numbers in [0, 1).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    fn normal(&mut self) -> f32 {
        // Sum of 12 uniforms − 6: unit variance, good enough here.
        (0..12).map(|_| self.next()).sum::<f32>() - 6.0
    }
}

/// Cell centres: two overlapping pairs and two isolated cells.
const CENTRES: [(f32, f32); 6] = [
    (14.0, 14.0),
    (17.0, 20.0),
    (40.0, 18.0),
    (28.0, 44.0),
    (33.0, 48.0),
    (12.0, 50.0),
];

fn footprint(id: u64, (cy, cx): (f32, f32)) -> Footprint {
    let r = 9usize;
    let (y0, x0) = (cy as usize - r, cx as usize - r);
    let mut values = Vec::new();
    for y in 0..2 * r + 1 {
        for x in 0..2 * r + 1 {
            let (dy, dx) = ((y0 + y) as f32 - cy, (x0 + x) as f32 - cx);
            values.push((-(dy * dy + dx * dx) / (2.0 * 2.2 * 2.2)).exp());
        }
    }
    Footprint {
        id,
        y0,
        x0,
        height: 2 * r + 1,
        width: 2 * r + 1,
        values,
    }
}

fn dense(fp: &Footprint) -> Vec<f32> {
    let mut out = vec![0.0f32; W * H];
    for y in 0..fp.height {
        for x in 0..fp.width {
            out[(fp.y0 + y) * W + fp.x0 + x] = fp.values[y * fp.width + x];
        }
    }
    out
}

/// Sparse bursty non-negative traces, `[cell][frame]`.
fn traces(n: usize, t: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = Lcg(seed);
    (0..n)
        .map(|_| {
            let mut c = 0.0f32;
            (0..t)
                .map(|_| {
                    c *= 0.8;
                    if rng.next() < 0.15 {
                        c += 5.0 + 10.0 * rng.next();
                    }
                    c
                })
                .collect()
        })
        .collect()
}

fn global_map() -> Vec<f32> {
    (0..W * H)
        .map(|i| {
            let (y, x) = ((i / W) as f32, (i % W) as f32);
            0.6 + 0.4 * (-((y - 28.0).powi(2) + (x - 30.0).powi(2)) / 1500.0).exp()
        })
        .collect()
}

fn flattener() -> GlowFlattener {
    let cfg = FlattenConfig {
        cell_diameter_px: 4.0,
        ..FlattenConfig::default()
    };
    GlowFlattener::new(&FovMask::full(dims()), &cfg).unwrap()
}

/// Preprocessed-domain frames: `H(Σ a_i c_i) + g s_t + noise`.
fn filtered_frames(c: &[Vec<f32>], noise: f32, seed: u64) -> Vec<Vec<f32>> {
    let mut flat = flattener();
    let fps: Vec<Vec<f32>> = (0..c.len())
        .map(|i| dense(&footprint(i as u64, CENTRES[i])))
        .collect();
    let g = global_map();
    let mut rng = Lcg(seed);
    (0..c[0].len())
        .map(|t| {
            let mut f = vec![0.0f32; W * H];
            for (fp, ci) in fps.iter().zip(c) {
                for (o, &a) in f.iter_mut().zip(fp) {
                    *o += a * ci[t];
                }
            }
            flat.apply(&mut f).unwrap();
            let s = 3.0 * (t as f32 * 0.9).sin();
            for (o, &gv) in f.iter_mut().zip(&g) {
                *o += gv * s + noise * rng.normal();
            }
            f
        })
        .collect()
}

fn library(ids: &[usize], model: BackgroundModel, version: u64) -> Library {
    let mut b = LibraryBuilder::new(dims())
        .background(model)
        .version(version);
    for &i in ids {
        b.push(footprint(i as u64, CENTRES[i]));
    }
    b.build(&mut flattener()).unwrap()
}

fn tight() -> SolverConfig {
    SolverConfig {
        tol: 1e-4,
        max_sweeps: 20_000,
        relax: 1.5,
    }
}

/// Unfiltered frames `Σ a_i c_i + g s_t` (no noise).
fn unfiltered_frames(c: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let fps: Vec<Vec<f32>> = (0..c.len())
        .map(|i| dense(&footprint(i as u64, CENTRES[i])))
        .collect();
    let g = global_map();
    (0..c[0].len())
        .map(|t| {
            let s = 3.0 * (t as f32 * 0.9).sin();
            let mut f: Vec<f32> = g.iter().map(|&v| v * s).collect();
            for (fp, ci) in fps.iter().zip(c) {
                for (o, &a) in f.iter_mut().zip(fp) {
                    *o += a * ci[t];
                }
            }
            f
        })
        .collect()
}

#[test]
fn recovers_traces_exactly_when_the_model_is_exact() {
    // Identity filter and supports wide enough to hold every footprint: the
    // forward model is exact, so the non-negative solve returns the truth.
    let t = 30;
    let c = traces(6, t, 1);
    let frames = unfiltered_frames(&c);
    let mut b = LibraryBuilder::new(dims())
        .background(BackgroundModel::Basis(vec![global_map()]))
        .version(1);
    for (i, &centre) in CENTRES.iter().enumerate() {
        b.push(footprint(i as u64, centre));
    }
    let lib = Arc::new(b.build(&mut IdentityFilter(dims())).unwrap());
    let mut e = TraceEngine::new(lib, tight()).unwrap();
    for (s, f) in frames.iter().enumerate() {
        let r = e.process(f).unwrap();
        assert_eq!(r.frame_index, s as u64);
        assert_eq!(r.library_version, 1);
        for i in 0..6 {
            assert!(
                (r.traces[i] - c[i][s]).abs() < 1e-3,
                "frame {s} cell {i}: {} vs {}",
                r.traces[i],
                c[i][s]
            );
        }
        let beta = 3.0 * (s as f32 * 0.9).sin();
        assert!((r.background[0] - beta).abs() < 1e-3);
    }
}

#[test]
fn recovers_traces_through_the_high_pass() {
    // High-passed data, filtered footprints on their full windows plus the
    // high-pass moat around them.
    let t = 30;
    let c = traces(6, t, 1);
    let frames = filtered_frames(&c, 0.0, 2);
    let lib = Arc::new(library(
        &[0, 1, 2, 3, 4, 5],
        BackgroundModel::Basis(vec![global_map()]),
        1,
    ));
    // Full-extent supports (every value of the 19 px windows) couple
    // neighbours into overlap groups.
    assert!(lib.groups().len() < 6, "overlapping cells share a group");
    let mut e = TraceEngine::new(lib, tight()).unwrap();
    let peak = c.iter().flatten().fold(0.0f32, |m, &v| m.max(v));
    let mut worst = 0.0f32;
    for (s, f) in frames.iter().enumerate() {
        let r = e.process(f).unwrap();
        for i in 0..6 {
            worst = worst.max((r.traces[i] - c[i][s]).abs());
        }
    }
    // With the moat modelled (block means of `L a` out to 2σ) the model is
    // all but exact: 0.05 % of the peak (1.1 % with the moat dropped).
    assert!(worst < 0.002 * peak, "worst error {worst}, peak {peak}");
    // Clipping the filtered footprints at zero (the tempting shortcut) is
    // measurably worse on the same data.
    let mut clipped =
        LibraryBuilder::new(dims()).background(BackgroundModel::Basis(vec![global_map()]));
    let mut flat = flattener();
    for (i, &centre) in CENTRES.iter().enumerate() {
        let fp = footprint(i as u64, centre);
        let mut img = dense(&fp);
        flat.apply(&mut img).unwrap();
        let values = (0..fp.height * fp.width)
            .map(|k| img[(fp.y0 + k / fp.width) * W + fp.x0 + k % fp.width].max(0.0))
            .collect();
        clipped.push(Footprint { values, ..fp });
    }
    let lib = Arc::new(clipped.build(&mut IdentityFilter(dims())).unwrap());
    let mut e = TraceEngine::new(lib, tight()).unwrap();
    let mut worst_clipped = 0.0f32;
    for (s, f) in frames.iter().enumerate() {
        let r = e.process(f).unwrap();
        for i in 0..6 {
            worst_clipped = worst_clipped.max((r.traces[i] - c[i][s]).abs());
        }
    }
    assert!(
        worst_clipped > 1.25 * worst,
        "clipped {worst_clipped} vs {worst}"
    );
}

#[test]
fn noise_units_and_robustness_to_noise() {
    let t = 200;
    let c = traces(6, t, 3);
    let frames = filtered_frames(&c, 0.5, 4);
    let lib = Arc::new(
        LibraryBuilder::new(dims())
            .noise(vec![0.5; W * H])
            .background(BackgroundModel::Basis(vec![global_map()]))
            .footprint(footprint(0, CENTRES[0]))
            .footprint(footprint(1, CENTRES[1]))
            .footprint(footprint(2, CENTRES[2]))
            .footprint(footprint(3, CENTRES[3]))
            .footprint(footprint(4, CENTRES[4]))
            .footprint(footprint(5, CENTRES[5]))
            .build(&mut flattener())
            .unwrap(),
    );
    let mut e = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut err = [0.0f64; 6];
    for (s, f) in frames.iter().enumerate() {
        let r = e.process(f).unwrap();
        for i in 0..6 {
            err[i] += f64::from(r.traces[i] - c[i][s]).powi(2);
        }
    }
    for i in 0..6 {
        let rms = (err[i] / t as f64).sqrt() as f32;
        // Errors stay within a few trace-noise units (more where cells overlap).
        assert!(
            rms < 4.0 * lib.trace_noise()[i],
            "cell {i}: rms {rms} noise {}",
            lib.trace_noise()[i]
        );
    }
}

#[test]
fn library_swap_carries_warm_start_and_converges_to_the_new_model() {
    let t = 24;
    let c = traces(6, t, 5);
    let frames = filtered_frames(&c, 0.0, 6);
    let lib1 = Arc::new(library(&[0, 1, 2, 3], BackgroundModel::None, 10));
    let lib2 = Arc::new(library(
        &[1, 2, 3, 4, 5],
        BackgroundModel::Basis(vec![global_map()]),
        11,
    ));
    let mut a = TraceEngine::new(lib1.clone(), tight()).unwrap();
    let mut b = TraceEngine::new(lib2.clone(), tight()).unwrap();
    for (s, f) in frames.iter().enumerate() {
        if s == 12 {
            let before = a.state();
            a.set_library(lib2.clone()).unwrap();
            // Surviving cells keep their warm start; the new ones start at 0.
            let after = a.state();
            for (k, &id) in after.ids.iter().enumerate() {
                let old = before.ids.iter().position(|&x| x == id);
                let want = old.map_or(0.0, |o| before.traces[o]);
                assert_eq!(after.traces[k], want, "id {id}");
            }
        }
        let ra = a.process(f).unwrap();
        let rb = b.process(f).unwrap();
        if s < 12 {
            assert_eq!(ra.library_version, 10);
            assert_eq!(ra.traces.len(), 4);
        } else {
            assert_eq!(ra.library_version, 11);
            assert_eq!(ra.traces.len(), 5);
            for k in 0..5 {
                assert!(
                    (ra.traces[k] - rb.traces[k]).abs() < 1e-2,
                    "frame {s} slot {k}: {} vs {}",
                    ra.traces[k],
                    rb.traces[k]
                );
            }
        }
    }
    // A library of another frame size is refused.
    let other = LibraryBuilder::new(Dims::new(32, 32).unwrap())
        .footprint(footprint(0, (10.0, 10.0)))
        .build(&mut IdentityFilter(Dims::new(32, 32).unwrap()))
        .unwrap();
    assert!(matches!(
        a.set_library(Arc::new(other)),
        Err(TraceError::Incompatible(_))
    ));
}

#[test]
fn ring_model_and_no_background_run() {
    let c = traces(6, 20, 7);
    let frames = filtered_frames(&c, 0.1, 8);
    for model in [
        BackgroundModel::None,
        BackgroundModel::Ring {
            inner_px: 7.0,
            outer_px: 12.0,
        },
    ] {
        let lib = Arc::new(library(&[0, 1, 2, 3, 4, 5], model.clone(), 3));
        let mut e = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
        for f in &frames {
            let r = e.process(f).unwrap();
            assert!(r.traces.iter().all(|v| v.is_finite() && *v >= 0.0));
            assert_eq!(r.background.len(), lib.background_len());
        }
    }
}

#[test]
fn invalid_input_is_an_error_not_a_panic() {
    let mut fl = IdentityFilter(dims());
    let dup = LibraryBuilder::new(dims())
        .footprint(footprint(1, CENTRES[0]))
        .footprint(footprint(1, CENTRES[2]))
        .build(&mut fl);
    assert!(matches!(dup, Err(TraceError::InvalidFootprint(_))));
    let mut off = footprint(2, CENTRES[0]);
    off.x0 = W - 3;
    assert!(LibraryBuilder::new(dims())
        .footprint(off)
        .build(&mut fl)
        .is_err());
    let mut neg = footprint(3, CENTRES[0]);
    neg.values[0] = -1.0;
    assert!(LibraryBuilder::new(dims())
        .footprint(neg)
        .build(&mut fl)
        .is_err());
    let lib = Arc::new(library(&[0], BackgroundModel::None, 1));
    let mut e = TraceEngine::new(lib, SolverConfig::default()).unwrap();
    assert!(matches!(
        e.process(&[0.0; 10]),
        Err(TraceError::LengthMismatch { .. })
    ));
    let mut nan = vec![0.0f32; W * H];
    nan[(CENTRES[0].0 as usize) * W + CENTRES[0].1 as usize] = f32::NAN;
    assert!(e.process(&nan).is_err());
    assert!(SolverConfig {
        relax: 2.0,
        ..SolverConfig::default()
    }
    .validate()
    .is_err());
}

/// Raw frames: unfiltered cells on a glow, with noise.
fn raw_frames(c: &[Vec<f32>], seed: u64) -> Vec<Vec<f32>> {
    let fps: Vec<Vec<f32>> = (0..c.len())
        .map(|i| dense(&footprint(i as u64, CENTRES[i])))
        .collect();
    let g = global_map();
    let mut rng = Lcg(seed);
    (0..c[0].len())
        .map(|t| {
            let mut f: Vec<f32> = g.iter().map(|&v| 80.0 * v).collect();
            for (fp, ci) in fps.iter().zip(c) {
                for (o, &a) in f.iter_mut().zip(fp) {
                    *o += a * ci[t];
                }
            }
            for o in f.iter_mut() {
                *o += 0.5 * rng.normal();
            }
            f
        })
        .collect()
}

#[test]
fn reextraction_reproduces_the_online_pass() {
    let t = 30;
    let c = traces(6, t, 9);
    let raw = raw_frames(&c, 10);
    let cfg = PreprocessConfig {
        flatten: FlattenConfig {
            cell_diameter_px: 4.0,
            ..FlattenConfig::default()
        },
        ..PreprocessConfig::default()
    };
    let cal = Calibration::new(FovMask::full(dims()), HotPixelMap::empty(dims())).unwrap();
    let mut pre = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();
    let mut b = LibraryBuilder::new(dims()).version(7);
    for (i, &centre) in CENTRES.iter().enumerate() {
        b.push(footprint(i as u64, centre));
    }
    let lib = Arc::new(b.build(&mut flat).unwrap());
    let mut engine = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut online = Vec::new();
    let mut buf = vec![0.0f32; W * H];
    let split = 11;
    let mut saved = None;
    for (s, f) in raw.iter().enumerate() {
        if s == split {
            saved = Some((pre.state(), engine.state()));
        }
        pre.process_frame(f, &mut buf).unwrap();
        online.push(engine.process(&buf).unwrap());
    }
    // Pass 2 over the tail, from the saved states.
    let (pstate, tstate) = saved.unwrap();
    let records = vec![(); t - split];
    let span: Vec<(&[f32], &())> = raw[split..]
        .iter()
        .map(|f| f.as_slice())
        .zip(records.iter())
        .collect();
    let mut replayed = Vec::new();
    let end = extract_span(
        lib.clone(),
        SolverConfig::default(),
        &pstate,
        &NoRegistration,
        span,
        Some(&tstate),
        |r| replayed.push(r.clone()),
    )
    .unwrap();
    assert_eq!(replayed.len(), t - split);
    for (a, b) in online[split..].iter().zip(&replayed) {
        assert_eq!(a, b, "frame {}", a.frame_index);
    }
    assert_eq!(end, engine.state());

    // And the solve alone on stored preprocessed frames.
    let mut pre = Preprocessor::new(cal, &cfg).unwrap();
    let pp: Vec<Vec<f32>> = raw
        .iter()
        .map(|f| {
            let mut o = vec![0.0f32; W * H];
            pre.process_frame(f, &mut o).unwrap();
            o
        })
        .collect();
    let mut again = Vec::new();
    extract_preprocessed(
        lib,
        SolverConfig::default(),
        pp.iter().map(|f| f.as_slice()),
        None,
        |r| again.push(r.clone()),
    )
    .unwrap();
    assert_eq!(again, online);
}

#[test]
fn library_bytes_round_trip_solves_identically() {
    let c = traces(6, 15, 21);
    let frames = filtered_frames(&c, 0.1, 22);
    for model in [
        BackgroundModel::None,
        BackgroundModel::Ring {
            inner_px: 7.0,
            outer_px: 12.0,
        },
        BackgroundModel::Basis(vec![global_map()]),
    ] {
        let lib = library(&[0, 1, 2, 3, 4, 5], model, 41);
        let bytes = lib.to_bytes();
        let back = Library::from_bytes(&bytes).unwrap();
        assert_eq!(back.version(), 41);
        assert_eq!(back.ids(), lib.ids());
        assert_eq!(back.to_bytes(), bytes);
        let mut a = TraceEngine::new(Arc::new(lib), SolverConfig::default()).unwrap();
        let mut b = TraceEngine::new(Arc::new(back), SolverConfig::default()).unwrap();
        for f in &frames {
            let ra = a.process(f).unwrap();
            let rb = b.process(f).unwrap();
            assert_eq!(ra.traces, rb.traces);
            assert_eq!(ra.background, rb.background);
        }
    }
    // An empty library round-trips too, and damaged bytes are an error.
    let empty = LibraryBuilder::new(dims())
        .version(0)
        .build(&mut flattener())
        .unwrap();
    let bytes = empty.to_bytes();
    assert_eq!(Library::from_bytes(&bytes).unwrap().len(), 0);
    assert!(Library::from_bytes(&bytes[..bytes.len() - 1]).is_err());
    let mut wrong = bytes.clone();
    wrong[0] = b'X';
    assert!(Library::from_bytes(&wrong).is_err());
}

/// One Gaussian cell (sigma 3 px, support radius 8) on a 64 x 64 field of view.
fn ring_probe_footprint() -> Footprint {
    let (cy, cx, r) = (32usize, 32usize, 8usize);
    let mut values = Vec::new();
    for y in 0..2 * r + 1 {
        for x in 0..2 * r + 1 {
            let (dy, dx) = (y as f32 - r as f32, x as f32 - r as f32);
            values.push((-(dy * dy + dx * dx) / (2.0 * 3.0 * 3.0)).exp());
        }
    }
    Footprint {
        id: 0,
        y0: cy - r,
        x0: cx - r,
        height: 2 * r + 1,
        width: 2 * r + 1,
        values,
    }
}

#[test]
fn ring_level_is_not_absorbed_into_the_trace() {
    // Ring background + high-pass + a background offset: with `s_i` summed
    // over the support only (not the whole column, moat included) the ring
    // level leaks into the trace by (s_support - s_full) * beta / |h|^2.
    let d = Dims::new(64, 64).unwrap();
    let mk_flat = || {
        let cfg = FlattenConfig {
            cell_diameter_px: 6.0,
            ..FlattenConfig::default()
        };
        GlowFlattener::new(&FovMask::full(d), &cfg).unwrap()
    };
    let fp = ring_probe_footprint();
    let mut dense_fp = vec![0.0f32; 64 * 64];
    for y in 0..fp.height {
        for x in 0..fp.width {
            dense_fp[(fp.y0 + y) * 64 + fp.x0 + x] = fp.values[y * fp.width + x];
        }
    }
    let mut lib_builder = LibraryBuilder::new(d)
        .background(BackgroundModel::Ring {
            inner_px: 12.0,
            outer_px: 20.0,
        })
        .version(1);
    lib_builder.push(fp);
    let lib = Arc::new(lib_builder.build(&mut mk_flat()).unwrap());

    let beta = 5.0f32;
    let c = 3.0f32;
    // `H(a c)` plus a flat offset: the offset is what the ring must carry.
    let frame = |level: f32| {
        let mut f: Vec<f32> = dense_fp.iter().map(|&a| a * level).collect();
        mk_flat().apply(&mut f).unwrap();
        for v in &mut f {
            *v += beta;
        }
        f
    };
    let mut e = TraceEngine::new(lib.clone(), tight()).unwrap();
    let r = e.process(&frame(c)).unwrap();
    assert!(
        (r.traces[0] - c).abs() < 1e-3 * c,
        "trace {} vs {c}",
        r.traces[0]
    );
    assert!(
        (r.background[0] - beta).abs() < 1e-3 * beta,
        "background {} vs {beta}",
        r.background[0]
    );
    // The same offset with no light: the trace stays at zero.
    let mut e = TraceEngine::new(lib, tight()).unwrap();
    let r = e.process(&frame(0.0)).unwrap();
    assert!(r.traces[0].abs() < 1e-3 * c, "trace {}", r.traces[0]);
    assert!((r.background[0] - beta).abs() < 1e-3 * beta);
}
