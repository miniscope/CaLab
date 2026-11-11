use std::sync::Arc;

use super::*;
use crate::trace::{BackgroundModel, Footprint, IdentityFilter, LibraryBuilder, SolverConfig};

const W: usize = 64;
const H: usize = 64;

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

fn calcium(n: usize, every: usize, amp: f32, tau: f32, phase: usize) -> Vec<f32> {
    let mut c = vec![0.0f32; n];
    let mut v = 0.0f32;
    for (t, ct) in c.iter_mut().enumerate() {
        v *= (-1.0 / tau).exp();
        if t % every == phase {
            v += amp;
        }
        *ct = v;
    }
    c
}

fn gauss(id: u64, cy: usize, cx: usize) -> Footprint {
    let (r, s) = (6usize, 2.0f32);
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

fn library(fps: &[Footprint]) -> Arc<Library> {
    let mut b = LibraryBuilder::new(dims())
        .noise(vec![1.0; W * H])
        .background(BackgroundModel::None);
    for f in fps {
        b.push(f.clone());
    }
    Arc::new(b.build(&mut IdentityFilter(dims())).unwrap())
}

/// Three cells (two overlapping) with calcium trains in unit white noise;
/// `junk` is a cell-shaped column where there is no cell.
fn scene() -> (Vec<Footprint>, Vec<Vec<f32>>, Footprint) {
    let fps = vec![gauss(1, 16, 16), gauss(2, 16, 22), gauss(3, 40, 44)];
    let n = 900;
    let cs = vec![
        calcium(n, 83, 6.0, 10.0, 5),
        calcium(n, 131, 6.0, 10.0, 40),
        calcium(n, 101, 6.0, 10.0, 70),
    ];
    (fps, cs, gauss(9, 48, 14))
}

/// Run the score over the scene with `lib`, every frame held out.
fn run(lib: Arc<Library>) -> (HeldOutWindow, Vec<HeldOutCell>) {
    let (fps, cs, _) = scene();
    let cfg = HeldOutConfig {
        cell_diameter_px: 6.0,
        placebo_share: 1.0,
        drop_every: 1,
        min_pool: 20,
        ..HeldOutConfig::default()
    };
    let mut ho = HeldOutScore::new(dims(), vec![1; W * H], vec![1.0; W * H], cfg).unwrap();
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut rng = Lcg(11);
    let mut filt = IdentityFilter(dims());
    for t in 0..cs[0].len() {
        let mut y: Vec<f32> = (0..W * H).map(|_| rng.normal()).collect();
        for (f, c) in fps.iter().zip(&cs) {
            for yy in 0..f.height {
                for xx in 0..f.width {
                    y[(f.y0 + yy) * W + f.x0 + xx] += f.values[yy * f.width + xx] * c[t];
                }
            }
        }
        let tr = eng.process(&y).unwrap();
        ho.frame(t as u64, &y, &lib, &tr, &mut eng, &mut filt)
            .unwrap();
    }
    let cells = ho.cells(lib.ids());
    (ho.take_window(), cells)
}

#[test]
fn empty_library_scores_zero() {
    let (w, _) = run(library(&[]));
    assert_eq!(w.frames, 900);
    assert!(
        w.gain_per_frame.abs() < 1e-9 && w.score.abs() < 1e-9,
        "{w:?}"
    );
}

#[test]
fn true_cells_score_and_junk_is_not_rewarded() {
    let (fps, _, junk) = scene();
    let (t, cells) = run(library(&fps));
    assert!(t.score > 5.0, "{t:?}");
    assert!(t.placebos > 2.5, "{t:?}");
    // Placebo columns on white noise gain a little on every frame.
    assert!(t.mu > 0.0 && t.mu < 1.0, "{t:?}");
    for c in &cells {
        assert!(c.frames > 50 && c.marginal_z > 3.0, "{c:?}");
    }
    let mut with = fps.clone();
    with.push(junk.clone());
    let (tj, cj) = run(library(&with));
    // A non-cell's held-out gain is what a placebo gets: S is not raised.
    assert!(tj.score < t.score + 0.05 * t.score, "{tj:?} vs {t:?}");
    let jz = cj[3].marginal_z;
    assert!(
        cj[..3].iter().all(|c| c.marginal_z > jz + 2.0),
        "junk {:?} vs cells {:?}",
        cj[3],
        &cj[..3]
    );
    // A junk-only library has no score to speak of.
    let (j, _) = run(library(&[junk]));
    assert!(j.score.abs() < 0.05 * t.score, "{j:?} vs {t:?}");
}

#[test]
fn drop_one_matches_a_full_resolve() {
    // Two overlapping cells: dropping one must equal solving without it.
    let (fps, cs, _) = scene();
    let lib = library(&fps[..2]);
    let lib1 = library(&fps[1..2]);
    let mut e = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut e1 = TraceEngine::new(lib1, SolverConfig::default()).unwrap();
    let mut rng = Lcg(3);
    let t = 6; // inside a transient of cell 1
    let mut y: Vec<f32> = (0..W * H).map(|_| rng.normal()).collect();
    for (f, c) in fps[..2].iter().zip(&cs) {
        for yy in 0..f.height {
            for xx in 0..f.width {
                y[(f.y0 + yy) * W + f.x0 + xx] += f.values[yy * f.width + xx] * c[t];
            }
        }
    }
    let tr = e.process(&y).unwrap();
    let tr1 = e1.process(&y).unwrap();
    assert!(tr.traces[0] > 1.0);
    let mut out = Vec::new();
    e.drop_one(0, &mut out).unwrap();
    let got = out.iter().find(|d| d.0 == 1).map_or(tr.traces[1], |d| d.1);
    assert!(
        (got - tr1.traces[0]).abs() < 0.05,
        "{got} vs {}",
        tr1.traces[0]
    );
    assert!(out.iter().any(|d| d.0 == 0 && d.1 == 0.0));
    // The engine is unchanged.
    assert_eq!(e.state().traces, tr.traces);
    // The model change drawn by `add_columns` is what `render` gives.
    let mut a = vec![0.0f32; W * H];
    let mut b = vec![0.0f32; W * H];
    lib.render(&tr.traces, None, &mut a).unwrap();
    let mut after = tr.traces.clone();
    for &(j, v) in &out {
        after[j] = v;
    }
    lib.render(&after, None, &mut b).unwrap();
    let mut d = vec![0.0f32; W * H];
    let coefs: Vec<(usize, f32)> = out.iter().map(|&(j, v)| (j, tr.traces[j] - v)).collect();
    lib.add_columns(&coefs, &mut d).unwrap();
    for p in 0..W * H {
        assert!((d[p] - (a[p] - b[p])).abs() < 1e-4);
    }
}
