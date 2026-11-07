// Index loops over cells and pixels read more clearly here.
#![allow(clippy::needless_range_loop)]

use std::sync::Arc;

use super::*;
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::trace::{Footprint, LibraryBuilder, SolverConfig, TraceEngine};

const N: usize = 96;

fn dims() -> Dims {
    Dims::new(N, N).unwrap()
}

fn flattener() -> GlowFlattener {
    let cfg = FlattenConfig {
        cell_diameter_px: 10.0,
        ..FlattenConfig::default()
    };
    GlowFlattener::new(&FovMask::full(dims()), &cfg).unwrap()
}

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
        (0..12).map(|_| self.next()).sum::<f32>() - 6.0
    }
}

/// Gaussian soma (σ 2.5 px, peak 1) as an unfiltered footprint.
fn blob(id: u64, cy: f32, cx: f32) -> Footprint {
    let r = 12usize;
    let (y0, x0) = (cy as usize - r, cx as usize - r);
    let side = 2 * r + 1;
    let mut values = vec![0.0f32; side * side];
    for y in 0..side {
        for x in 0..side {
            let (dy, dx) = ((y0 + y) as f32 - cy, (x0 + x) as f32 - cx);
            values[y * side + x] = (-(dy * dy + dx * dx) / (2.0 * 2.5 * 2.5)).exp();
        }
    }
    Footprint {
        id,
        y0,
        x0,
        height: side,
        width: side,
        values,
    }
}

/// Sparse calcium-like trace: events at random times, exponential decay.
fn trace(rng: &mut Lcg, t: usize, rate: f32, amp: f32) -> Vec<f32> {
    let mut c = vec![0.0f32; t];
    let mut v = 0.0f32;
    for k in 0..t {
        v *= 0.8;
        if rng.next() < rate {
            v += amp * (0.7 + 0.6 * rng.next());
        }
        c[k] = v;
    }
    c
}

/// The filtered movie `H Σ a_i c_i + noise` (σ = 1), frame-major.
fn movie(cells: &[(Footprint, Vec<f32>)], t: usize, seed: u64) -> Vec<f32> {
    let n_px = N * N;
    let mut flat = flattener();
    // Filtered footprints, once.
    let filt: Vec<Vec<f32>> = cells
        .iter()
        .map(|(fp, _)| {
            let mut img = vec![0.0f32; n_px];
            for y in 0..fp.height {
                for x in 0..fp.width {
                    img[(fp.y0 + y) * N + fp.x0 + x] = fp.values[y * fp.width + x];
                }
            }
            flat.apply(&mut img).unwrap();
            img
        })
        .collect();
    let mut rng = Lcg(seed);
    let mut out = vec![0.0f32; t * n_px];
    for k in 0..t {
        let f = &mut out[k * n_px..(k + 1) * n_px];
        for v in f.iter_mut() {
            *v = rng.normal();
        }
        for ((_, c), img) in cells.iter().zip(&filt) {
            if c[k] != 0.0 {
                for (o, &a) in f.iter_mut().zip(img) {
                    *o += a * c[k];
                }
            }
        }
    }
    out
}

fn config() -> SlowLoopConfig {
    SlowLoopConfig {
        tile_px: 48,
        reservoir_bytes: 8 << 20,
        commit_interval_frames: 20,
        ..SlowLoopConfig::default()
    }
}

/// Fast + slow loop over the movie; returns the final library.
fn run(movie: &[f32], t: usize, seed: &[Footprint]) -> (Arc<Library>, SlowLoop) {
    let n_px = N * N;
    let mut slow = SlowLoop::new(
        dims(),
        vec![1; n_px],
        vec![1.0; n_px],
        flattener(),
        config(),
    )
    .unwrap();
    slow.seed(seed).unwrap();
    let lib0 = slow.finalize().unwrap();
    let mut eng = TraceEngine::new(lib0, SolverConfig::default()).unwrap();
    for k in 0..t {
        let f = &movie[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        slow.observe(f, &lib, &tr).unwrap();
        if let Some(l) = slow.step(5_000_000).unwrap() {
            eng.set_library(l).unwrap();
        }
    }
    (slow.finalize().unwrap(), slow)
}

fn centres(lib: &Library) -> Vec<(f32, f32)> {
    (0..lib.len()).map(|s| lib.support(s).0).collect()
}

#[test]
fn a_single_cell_is_discovered() {
    let t = 500;
    let mut rng = Lcg(3);
    let cells = vec![(blob(0, 47.0, 51.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 11);
    let (lib, slow) = run(&m, t, &[]);
    let c = centres(&lib);
    assert_eq!(c.len(), 1, "cells {c:?}, stats {:?}", slow.stats());
    let (cy, cx) = c[0];
    assert!((cy - 47.0).abs() < 1.5 && (cx - 51.0).abs() < 1.5, "{c:?}");
}

#[test]
fn noise_only_yields_no_cells() {
    let t = 500;
    let m = movie(&[], t, 5);
    let (lib, slow) = run(&m, t, &[]);
    assert_eq!(lib.len(), 0, "stats {:?}", slow.stats());
    assert!(slow.stats().visits > 0, "the slow loop never looked");
}

#[test]
fn a_duplicate_is_merged() {
    let t = 500;
    let mut rng = Lcg(9);
    let cells = vec![(blob(0, 47.0, 47.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 13);
    // Two copies of the cell, offset by 2 px each way.
    let seed = [blob(1, 46.0, 46.0), blob(2, 48.0, 48.0)];
    let (lib, slow) = run(&m, t, &seed);
    let c = centres(&lib);
    assert_eq!(c.len(), 1, "cells {c:?}, stats {:?}", slow.stats());
    assert!(slow.stats().merges >= 1);
    assert_eq!(lib.ids(), &[1]);
}

#[test]
fn neighbours_with_independent_activity_stay_separate() {
    let t = 600;
    let mut rng = Lcg(21);
    let cells = vec![
        (blob(0, 40.0, 44.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(1, 48.0, 50.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(2, 20.0, 70.0), trace(&mut rng, t, 0.02, 4.0)),
    ];
    let m = movie(&cells, t, 17);
    let (lib, slow) = run(&m, t, &[]);
    let c = centres(&lib);
    assert_eq!(c.len(), 3, "cells {c:?}, stats {:?}", slow.stats());
    for (fp, _) in &cells {
        let (gy, gx) = (fp.y0 as f32 + 12.0, fp.x0 as f32 + 12.0);
        assert!(
            c.iter()
                .any(|&(y, x)| (y - gy).abs() < 2.0 && (x - gx).abs() < 2.0),
            "{gy},{gx} not found in {c:?}"
        );
    }
}

#[test]
fn library_from_seed_matches_builder() {
    let n_px = N * N;
    let mut slow = SlowLoop::new(
        dims(),
        vec![1; n_px],
        vec![1.0; n_px],
        flattener(),
        config(),
    )
    .unwrap();
    assert_eq!(slow.seed(&[blob(4, 30.0, 30.0)]).unwrap(), 1);
    let lib = slow.finalize().unwrap();
    let direct = LibraryBuilder::new(dims())
        .footprint(blob(4, 30.0, 30.0))
        .build(&mut flattener())
        .unwrap();
    assert_eq!(lib.support(0), direct.support(0));
    let (_, a) = lib.filtered(0);
    let (_, b) = direct.filtered(0);
    let err = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0f32, f32::max);
    assert!(err < 1e-5);
}
