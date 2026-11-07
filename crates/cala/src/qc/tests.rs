// Index loops over cells and frames read more clearly here.
#![allow(clippy::needless_range_loop)]

use std::sync::Arc;

use super::*;
use crate::trace::{
    BackgroundModel, Footprint, IdentityFilter, LibraryBuilder, SolverConfig, TraceEngine,
};

const W: usize = 48;
const H: usize = 40;

fn dims() -> Dims {
    Dims::new(W, H).unwrap()
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

/// Calcium-like train: instantaneous rise, exponential decay (τ frames).
fn calcium(n: usize, every: usize, amp: f32, tau: f32, phase: usize) -> Vec<f32> {
    let mut c = vec![0.0f32; n];
    let mut v = 0.0f32;
    for t in 0..n {
        v *= (-1.0 / tau).exp();
        if t % every == phase {
            v += amp;
        }
        c[t] = v;
    }
    c
}

#[test]
fn calcium_transients_read_as_calcium() {
    let mut rng = Lcg(7);
    let n = 1200;
    let x: Vec<f32> = calcium(n, 97, 10.0, 12.0, 20)
        .iter()
        .map(|&c| c + rng.normal())
        .collect();
    let mut sc = Vec::new();
    let st = trace_stats(&x, 4.0, 100, 5, f32::NEG_INFINITY, 1.0, &mut sc);
    assert!((st.sigma - 1.0).abs() < 0.15, "{st:?}");
    // 12 transients of amplitude 10; the top 1 % (12 samples) are the peaks.
    assert!(st.peak_snr > 8.0 && st.peak_snr < 12.0, "{st:?}");
    assert!((11..=15).contains(&st.events), "{st:?}");
    assert!(st.asymmetry > 2.5, "{st:?}");
    assert!(st.diff_skew > 1.0, "{st:?}");
    assert!(st.slow_frac < 0.3, "{st:?}");
}

#[test]
fn slow_humps_read_as_slow_and_symmetric() {
    let mut rng = Lcg(8);
    let n = 1200;
    // Gaussian humps 60 frames wide (σ), every 400 frames, flat between.
    let x: Vec<f32> = (0..n)
        .map(|t| {
            let d = (t % 400) as f32 - 200.0;
            8.0 * (-(d * d) / (2.0 * 60.0 * 60.0)).exp() + rng.normal()
        })
        .collect();
    let mut sc = Vec::new();
    let st = trace_stats(&x, 4.0, 100, 5, f32::NEG_INFINITY, 1.0, &mut sc);
    assert!(st.asymmetry < 1.6 && st.asymmetry > 0.6, "{st:?}");
    assert!(st.slow_frac > 0.7, "{st:?}");
    assert!(st.diff_skew.abs() < 0.3, "{st:?}");
    assert!(st.width_frames > 60.0, "{st:?}");
}

#[test]
fn noise_survives_long_zero_stretches() {
    // A non-negative trace at exactly zero most of the time: the plain MAD
    // of differences would be 0; zero-zero pairs are left out.
    let mut rng = Lcg(9);
    let x: Vec<f32> = (0..1200)
        .map(|t| {
            if (t / 100) % 3 == 0 {
                (5.0 + rng.normal()).max(0.0)
            } else {
                0.0
            }
        })
        .collect();
    let mut sc = Vec::new();
    let s = stats::sigma_mad_diff(&x, 0.0, &mut sc);
    assert!(s > 0.7 && s < 1.4, "{s}");
}

#[test]
fn inverse_corner_matches_2x2() {
    let r = 0.6f64;
    let v = inv00(&[1.0, r, r, 1.0], 2).unwrap();
    assert!((v - 1.0 / (1.0 - r * r)).abs() < 1e-9);
    assert!(inv00(&[1.0, 1.0, 1.0, 1.0], 2).is_none());
}

#[test]
fn sparse_corr_of_identical_is_one() {
    let mut img = vec![0.0f32; 16];
    let r = sparse_corr(
        &[1, 2, 3],
        &[1.0, 2.0, 1.0],
        &[1, 2, 3],
        &[1.0, 2.0, 1.0],
        &mut img,
    );
    assert!((r - 1.0).abs() < 1e-6);
    assert!(img.iter().all(|&v| v == 0.0));
    let r = sparse_corr(
        &[1, 2, 3],
        &[1.0, 2.0, 1.0],
        &[2, 3, 4],
        &[2.0, 1.0, 0.5],
        &mut img,
    );
    assert!(r < 1.0 && r > 0.0);
    assert!(img.iter().all(|&v| v == 0.0));
}

fn gauss(id: u64, cy: usize, cx: usize, s: f32) -> Footprint {
    let r = 6usize;
    let mut values = Vec::new();
    for y in 0..2 * r + 1 {
        for x in 0..2 * r + 1 {
            let (dy, dx) = (y as f32 - r as f32, x as f32 - r as f32);
            values.push((-(dy * dy + dx * dx) / (2.0 * s * s)).exp());
        }
    }
    Footprint {
        id,
        y0: cy - r,
        x0: cx - r,
        height: 2 * r + 1,
        width: 2 * r + 1,
        values,
    }
}

fn library(fps: &[Footprint], version: u64) -> Library {
    let mut b = LibraryBuilder::new(dims())
        .noise(vec![1.0; W * H])
        .background(BackgroundModel::None)
        .version(version);
    for f in fps {
        b.push(f.clone());
    }
    b.build(&mut IdentityFilter(dims())).unwrap()
}

/// Two overlapping cells and one isolated, with independent calcium trains;
/// frames = Σ footprint × trace + unit noise.
fn scene() -> (Vec<Footprint>, Vec<Vec<f32>>) {
    let fps = vec![
        gauss(1, 14, 14, 2.5),
        gauss(2, 14, 19, 2.5),
        gauss(3, 28, 36, 2.5),
    ];
    let n = 1500;
    let cs = vec![
        calcium(n, 83, 8.0, 10.0, 5),
        calcium(n, 131, 8.0, 10.0, 40),
        calcium(n, 101, 8.0, 10.0, 70),
    ];
    (fps, cs)
}

fn frame(fps: &[Footprint], cs: &[Vec<f32>], t: usize, rng: &mut Lcg) -> Vec<f32> {
    let mut y: Vec<f32> = (0..W * H).map(|_| rng.normal()).collect();
    for (f, c) in fps.iter().zip(cs) {
        for yy in 0..f.height {
            for xx in 0..f.width {
                y[(f.y0 + yy) * W + f.x0 + xx] += f.values[yy * f.width + xx] * c[t];
            }
        }
    }
    y
}

fn monitor() -> QcMonitor {
    let cfg = QcConfig {
        window_frames: 600,
        refresh_frames: 10,
        residual_every: 2,
        block_px: 4,
        ..QcConfig::default()
    };
    QcMonitor::new(dims(), vec![1; W * H], vec![1.0; W * H], cfg).unwrap()
}

#[test]
fn monitor_measures_a_clean_scene() {
    let (fps, cs) = scene();
    let lib = Arc::new(library(&fps, 1));
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut qc = monitor();
    let mut rng = Lcg(3);
    for t in 0..800 {
        let y = frame(&fps, &cs, t, &mut rng);
        let tr = eng.process(&y).unwrap();
        qc.observe(&y, &lib, &tr).unwrap();
    }
    let cells: Vec<CellQc> = qc.cells().copied().collect();
    assert_eq!(cells.len(), 3);
    for c in &cells {
        assert_eq!(c.frames, 600);
        assert!(c.trace.peak_snr > 5.0, "{c:?}");
        assert!(c.trace.asymmetry > 2.0, "{c:?}");
        // Correct footprints: residual is noise, active or not.
        assert!(c.residual_rest < 1.3 && c.residual_active < 1.5, "{c:?}");
        assert!(c.pass && c.flags == 0, "{c:?}");
        assert!(c.proj_r > 0.8 && c.fp_error < 0.05, "{c:?}");
    }
    // The overlapping pair: neighbours, inflated variance, low trace r.
    assert_eq!(cells[0].n_neighbours, 1);
    assert_eq!(cells[0].max_neighbour_id, 2);
    assert!(
        cells[0].vif > 1.05 && cells[0].max_overlap > 0.2,
        "{:?}",
        cells[0]
    );
    assert!(cells[0].max_neighbour_r.abs() < 0.3, "{:?}", cells[0]);
    assert_eq!(cells[2].n_neighbours, 0);
    assert!((cells[2].vif - 1.0).abs() < 1e-6);
    let g = qc.global();
    assert_eq!(g.cells, 3);
    assert_eq!(g.cells_measured, 3);
    assert!(g.explained > 0.9, "{g:?}");
    assert!(g.residual_excess < 0.3, "{g:?}");
    assert_eq!(g.pass_frac, 1.0);
    assert_eq!(g.total_adds, 3);
    let (bw, bh, map) = qc.residual_map();
    assert_eq!((bw, bh, map.len()), (12, 10, 120));
    let pairs = qc.neighbours_of(0);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].id, 2);
}

#[test]
fn split_cell_and_missing_cell_are_flagged() {
    let (fps, cs) = scene();
    // Library: cell 1 split into two halves (ids 10, 11), cell 2 kept, cell 3
    // missing.
    let mut a = fps[0].clone();
    let mut b = fps[0].clone();
    for y in 0..a.height {
        for x in 0..a.width {
            if x < a.width / 2 {
                a.values[y * a.width + x] = 0.0;
            } else {
                b.values[y * b.width + x] = 0.0;
            }
        }
    }
    a.id = 10;
    b.id = 11;
    let lib = Arc::new(library(&[a, b, fps[1].clone()], 1));
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut qc = monitor();
    let mut rng = Lcg(4);
    for t in 0..800 {
        let y = frame(&fps, &cs, t, &mut rng);
        let tr = eng.process(&y).unwrap();
        qc.observe(&y, &lib, &tr).unwrap();
    }
    let cells: Vec<CellQc> = qc.cells().copied().collect();
    // The halves follow each other.
    assert!(cells[0].max_neighbour_r > 0.8, "{:?}", cells[0]);
    for c in &cells[..2] {
        assert!(c.flags & FLAG_CORRELATED_PAIR != 0, "{c:?}");
    }
    // Exactly one half is called the extra cell and fails.
    let dup = |c: &CellQc| c.flags & FLAG_LIKELY_DUPLICATE != 0;
    assert!(dup(&cells[0]) != dup(&cells[1]), "{cells:?}");
    assert!(cells[0].pass != cells[1].pass);
    assert_eq!(cells[2].flags, 0, "{:?}", cells[2]);
    // The missing cell's light is unexplained: the residual map is hot there
    // (block of pixel (28, 36)) and cold far from every cell.
    let (bw, _, map) = qc.residual_map();
    let hot = map[(28 / 4) * bw + 36 / 4];
    let cold = map[(36 / 4) * bw + 4 / 4];
    assert!(hot > 1.0 && cold < 0.3, "hot {hot} cold {cold}");
    assert!(qc.global().explained < 0.9);
}

#[test]
fn library_swaps_carry_history_and_count_churn() {
    let (fps, cs) = scene();
    let lib1 = Arc::new(library(&fps[..2], 1));
    let mut moved = fps[1].clone();
    moved.x0 += 1;
    let lib2 = Arc::new(library(&[fps[0].clone(), moved, fps[2].clone()], 2));
    let lib3 = Arc::new(library(&fps[1..], 3));
    let mut eng = TraceEngine::new(lib1.clone(), SolverConfig::default()).unwrap();
    let mut qc = monitor();
    let mut rng = Lcg(5);
    for t in 0..300 {
        let lib = match t {
            0..100 => &lib1,
            100..200 => &lib2,
            _ => &lib3,
        };
        if t == 100 || t == 200 {
            eng.set_library(lib.clone()).unwrap();
        }
        let y = frame(&fps, &cs, t, &mut rng);
        let tr = eng.process(&y).unwrap();
        qc.observe(&y, lib, &tr).unwrap();
    }
    let cells: Vec<CellQc> = qc.cells().copied().collect();
    assert_eq!(cells.iter().map(|c| c.id).collect::<Vec<_>>(), vec![2, 3]);
    // Cell 2: 300 frames of history, one footprint change (lib 3 restores
    // the original position: two changes).
    assert!(cells[0].frames >= 298);
    assert_eq!(cells[0].fp_changes, 2);
    assert!(cells[0].fp_last_r < 1.0 && cells[0].fp_last_r > 0.5);
    assert!((198..=200).contains(&cells[1].frames));
    let g = qc.global();
    assert_eq!((g.total_adds, g.total_removes), (3, 1));
}

#[test]
fn bad_inputs_are_errors() {
    let (fps, _) = scene();
    let lib = library(&fps, 1);
    let mut qc = monitor();
    let tr = FrameTraces {
        traces: vec![0.0; 2],
        ..FrameTraces::default()
    };
    assert!(qc.observe(&vec![0.0; W * H], &lib, &tr).is_err());
    assert!(qc.observe(&[0.0; 3], &lib, &tr).is_err());
    assert!(qc.set_noise(vec![f32::NAN; W * H]).is_err());
    let cfg = QcConfig {
        window_frames: 4,
        ..QcConfig::default()
    };
    assert!(QcMonitor::new(dims(), vec![1; W * H], vec![1.0; W * H], cfg).is_err());
}
