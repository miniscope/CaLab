//! Oracle trace recovery on the minisim fixture in `fixtures/trace_small`
//! (see its README): the real preprocessing chain, ground-truth footprints,
//! the fast-loop solve, and Pearson r against the ground-truth traces.

mod common;

use std::sync::Arc;

use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};
use calab_cala::trace::{BackgroundModel, Footprint, LibraryBuilder, SolverConfig, TraceEngine};
use common::npy::Npy;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/trace_small");

struct Fixture {
    dims: Dims,
    t: usize,
    movie: Vec<u8>,
    /// `(unit, detectable, full, core)`.
    units: Vec<(usize, bool, Footprint, Footprint)>,
    /// `c[unit * t + s]`.
    c: Vec<f64>,
}

/// The part of a `s x s` window at `(y0, x0)` (may stick out) inside the frame.
fn clip(id: u64, win: &[f64], s: usize, y0: i64, x0: i64, dims: Dims) -> Footprint {
    let ys = y0.max(0)..(y0 + s as i64).min(dims.height as i64);
    let xs = x0.max(0)..(x0 + s as i64).min(dims.width as i64);
    let mut values = Vec::new();
    for y in ys.clone() {
        for x in xs.clone() {
            values.push(win[((y - y0) as usize) * s + (x - x0) as usize].max(0.0) as f32);
        }
    }
    Footprint {
        id,
        y0: ys.start as usize,
        x0: xs.start as usize,
        height: (ys.end - ys.start) as usize,
        width: (xs.end - xs.start) as usize,
        values,
    }
}

fn load() -> Fixture {
    let m = Npy::read(format!("{FIX}/movie.npy")).unwrap();
    let (t, h, w) = (m.shape[0], m.shape[1], m.shape[2]);
    let dims = Dims::new(w, h).unwrap();
    let movie = m.into_u8().unwrap();
    let fp = Npy::read(format!("{FIX}/footprints.npy")).unwrap();
    let (n, s) = (fp.shape[0], fp.shape[2]);
    let fp = fp.into_f64();
    let meta = Npy::read(format!("{FIX}/meta.npy")).unwrap().into_f64();
    let c = Npy::read(format!("{FIX}/C.npy")).unwrap().into_f64();
    assert_eq!(c.len(), n * t);
    let units = (0..n)
        .map(|i| {
            let row = &meta[i * 5..(i + 1) * 5];
            let (y0, x0) = (row[1] as i64, row[2] as i64);
            let win = |k: usize| &fp[(i * 2 + k) * s * s..(i * 2 + k + 1) * s * s];
            (
                i,
                row[3] != 0.0,
                clip(row[0] as u64, win(0), s, y0, x0, dims),
                clip(row[0] as u64, win(1), s, y0, x0, dims),
            )
        })
        .collect();
    Fixture {
        dims,
        t,
        movie,
        units,
        c,
    }
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        ab += (x - ma) * (y - mb);
        aa += (x - ma).powi(2);
        bb += (y - mb).powi(2);
    }
    ab / (aa * bb).sqrt()
}

/// Per-cell r of the oracle solve, for the detectable units.
fn run(fx: &Fixture, core: bool, model: BackgroundModel) -> Vec<f64> {
    let n_px = fx.dims.pixels();
    let mut cfg = PreprocessConfig::for_fps(20.0);
    cfg.warmup_frames = 40;
    let mut acc = WarmupAccumulator::new(fx.dims);
    for f in fx.movie.chunks_exact(n_px).take(cfg.warmup_frames) {
        acc.push(f).unwrap();
    }
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let pre0 = Preprocessor::new(cal.clone(), &cfg).unwrap();
    // Pass 1 settles the noise map and the background floor; pass 2 (the
    // solve) uses the floor frozen at the end of pass 1, as pass 2 of the
    // pipeline does. On a 4 s movie the streaming floor of pass 1 has not
    // settled yet (a cell active from frame 0 sets it too high).
    let mut pre = pre0;
    let mut buf = vec![0.0f32; n_px];
    for f in fx.movie.chunks_exact(n_px) {
        pre.process_frame(f, &mut buf).unwrap();
    }
    let fov = cal.fov().mask().to_vec();
    let mut b = LibraryBuilder::new(fx.dims)
        .fov(fov.clone())
        .noise(pre.noise().sigma())
        .background(model);
    let mut lib_units = Vec::new();
    for (u, det, full, cfp) in &fx.units {
        let fp = if core { cfp } else { full };
        if *det && fov[(fp.y0 + fp.height / 2) * fx.dims.width + fp.x0 + fp.width / 2] != 0 {
            b.push(fp.clone());
            lib_units.push(*u);
        }
    }
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();
    let lib = Arc::new(b.build(&mut flat).unwrap());
    let mut engine = TraceEngine::new(lib, SolverConfig::default()).unwrap();
    pre.background_mut().freeze();
    let mut est = vec![vec![0.0f64; fx.t]; lib_units.len()];
    for (s, f) in fx.movie.chunks_exact(n_px).enumerate() {
        pre.process_frame(f, &mut buf).unwrap();
        let r = engine.process(&buf).unwrap();
        for (k, v) in r.traces.iter().enumerate() {
            est[k][s] = f64::from(*v);
        }
    }
    lib_units
        .iter()
        .zip(&est)
        .map(|(&u, e)| pearson(e, &fx.c[u * fx.t..(u + 1) * fx.t]))
        .collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// The crop holds only out-of-focus cells (dim and blurry: the projection of
/// the raw movie onto the footprint correlates with the truth at r 0.2-0.7,
/// 0.9 for the one bright cell), so the bounds are modest; they pin down the
/// order of magnitude and that the local (ring) background helps.
#[test]
fn oracle_footprints_recover_the_ground_truth_traces() {
    let fx = load();
    let ring = BackgroundModel::Ring {
        inner_px: 12.0,
        outer_px: 20.0,
    };
    for core in [false, true] {
        let none = run(&fx, core, BackgroundModel::None);
        let local = run(&fx, core, ring.clone());
        assert_eq!(none.len(), 7);
        let (m0, m1) = (median(none.clone()), median(local.clone()));
        let worst = local.iter().copied().fold(1.0f64, f64::min);
        println!("core-only {core}: median r {m0:.3} without background, {m1:.3} with the ring (worst {worst:.3})");
        assert!(m0 > 0.55, "median r without background {m0}");
        assert!(m1 > 0.7, "median r with the ring {m1}");
        assert!(worst > 0.35, "worst r with the ring {worst}");
    }
}
