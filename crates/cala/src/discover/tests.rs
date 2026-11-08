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

// ---- v2: evidence ledger, pruning, merging of established cells ----------

fn v2_config() -> SlowLoopConfig {
    SlowLoopConfig {
        probation_frames: 300,
        probe_gap_frames: 20,
        ..config()
    }
}

/// Fast + slow loop over frames `range` of the movie, continuing `slow`
/// and `eng`; collects deletions.
fn drive(
    movie: &[f32],
    range: std::ops::Range<usize>,
    slow: &mut SlowLoop,
    eng: &mut TraceEngine,
    deleted: &mut Vec<DeletedCell>,
) {
    let n_px = N * N;
    for k in range {
        let f = &movie[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        slow.observe(f, &lib, &tr).unwrap();
        if let Some(l) = slow.step(5_000_000).unwrap() {
            eng.set_library(l).unwrap();
        }
        deleted.extend(slow.take_deleted());
    }
}

fn start(cfg: SlowLoopConfig, seed: &[Footprint]) -> (SlowLoop, TraceEngine) {
    let n_px = N * N;
    let mut slow = SlowLoop::new(dims(), vec![1; n_px], vec![1.0; n_px], flattener(), cfg).unwrap();
    slow.seed(seed).unwrap();
    let lib0 = slow.finalize().unwrap();
    let eng = TraceEngine::new(lib0, SolverConfig::default()).unwrap();
    (slow, eng)
}

fn near(c: (f32, f32), y: f32, x: f32) -> bool {
    (c.0 - y).abs() < 2.0 && (c.1 - x).abs() < 2.0
}

#[test]
fn a_spurious_cell_on_noise_is_deleted_and_not_re_added() {
    let t = 1500;
    let mut rng = Lcg(5);
    let cells = vec![(blob(0, 60.0, 60.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 23);
    // A true cell plus a cell where there is only noise.
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 60.0, 60.0), blob(2, 28.0, 30.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(
        lib.ids(),
        &[1],
        "deleted {deleted:?}, stats {:?}",
        slow.stats()
    );
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].info.id, 2);
    assert_eq!(deleted[0].reason, DeleteReason::Silent);
    // No add / delete cycle at the spot.
    assert!(!centres(&lib).iter().any(|&c| near(c, 28.0, 30.0)));
    assert_eq!(slow.stats().deletes, 1);
}

#[test]
fn a_true_cell_is_never_deleted_over_a_long_run() {
    let t = 3000;
    let mut rng = Lcg(31);
    // One sparse cell (an event every ~200 frames) and one busier, dimmer.
    let cells = vec![
        (blob(0, 40.0, 44.0), trace(&mut rng, t, 0.005, 6.0)),
        (blob(1, 56.0, 60.0), trace(&mut rng, t, 0.02, 4.0)),
    ];
    let m = movie(&cells, t, 37);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 40.0, 44.0), blob(2, 56.0, 60.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    assert!(deleted.is_empty(), "deleted {deleted:?}");
    let infos = slow.cell_infos();
    for id in [1, 2] {
        let c = infos.iter().find(|c| c.id == id).expect("kept");
        assert_eq!(c.status, CellStatus::Established, "{c:?}");
        assert!(c.transients >= 3 && c.passes > 0, "{c:?}");
    }
}

#[test]
fn a_duplicate_of_an_established_cell_is_merged() {
    let t = 1200;
    let mut rng = Lcg(41);
    let cells = vec![(blob(0, 47.0, 47.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 43);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 47.0, 47.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..600, &mut slow, &mut eng, &mut deleted);
    assert_eq!(
        slow.cell_info(1).map(|c| c.status),
        Some(CellStatus::Established)
    );
    // A second copy, 2 px off, appears later (as a late add would).
    assert_eq!(slow.seed(&[blob(9, 49.0, 48.0)]).unwrap(), 1);
    assert_eq!(slow.finalize().unwrap().len(), 2);
    drive(&m, 600..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.ids(), &[1], "stats {:?}", slow.stats());
    assert!(slow.stats().merges >= 1);
    assert!(deleted.is_empty(), "merged, not deleted: {deleted:?}");
}

#[test]
fn a_deleted_spot_comes_back_only_on_new_evidence() {
    // Quiet for the first half, then a real cell starts firing at the spot
    // of a deleted (silent) one: it is added again, once.
    let t = 2400;
    let mut rng = Lcg(51);
    let mut c = trace(&mut rng, t, 0.03, 6.0);
    c[..1200].iter_mut().for_each(|v| *v = 0.0);
    let m = movie(&[(blob(0, 47.0, 47.0), c)], t, 53);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 47.0, 47.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(deleted.len(), 1, "{deleted:?}");
    assert_eq!(deleted[0].reason, DeleteReason::Silent);
    let c = centres(&lib);
    assert_eq!(c.len(), 1, "{c:?}, stats {:?}", slow.stats());
    assert!(near(c[0], 47.0, 47.0), "{c:?}");
    assert_ne!(lib.ids()[0], 1, "a new cell, not the deleted one");
    assert_eq!(slow.stats().deletes, 1);
}

#[test]
fn edit_counts_are_per_interval() {
    let t = 500;
    let mut rng = Lcg(3);
    let cells = vec![(blob(0, 47.0, 51.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 11);
    let (mut slow, mut eng) = start(v2_config(), &[]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let e = slow.take_edit_counts();
    assert_eq!(e.adds, slow.stats().adds);
    assert!(e.adds >= 1 && e.commits >= 1, "{e:?}");
    assert_eq!(slow.take_edit_counts(), EditCounts::default());
}

// ---- v3: model comparison, running statistics, splits ---------------------

/// Gaussian soma of width `s` px (peak 1) as an unfiltered footprint.
fn blob_w(id: u64, cy: f32, cx: f32, s: f32) -> Footprint {
    let mut fp = blob(id, cy.round(), cx.round());
    for y in 0..fp.height {
        for x in 0..fp.width {
            let (dy, dx) = ((fp.y0 + y) as f32 - cy, (fp.x0 + x) as f32 - cx);
            fp.values[y * fp.width + x] = (-(dy * dy + dx * dx) / (2.0 * s * s)).exp();
        }
    }
    fp
}

/// Edits per interval: adds + merges + splits + deletes + refines.
fn edits(e: &EditCounts) -> u64 {
    e.adds + e.merges + e.splits + e.deletes + e.refines
}

#[test]
fn residual_of_a_slightly_wrong_footprint_is_absorbed_not_added() {
    let t = 1500;
    let mut rng = Lcg(61);
    let cells = vec![(blob(0, 47.0, 47.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 67);
    // The library's footprint is too small and 2 px off: the rest of the
    // cell is left in the residual, next to the cell.
    let (mut slow, mut eng) = start(v2_config(), &[blob_w(1, 45.5, 46.0, 1.6)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    let st = slow.stats();
    assert_eq!(lib.ids(), &[1], "stats {st:?}, deleted {deleted:?}");
    assert_eq!(st.adds, 0, "the residual became a new cell: {st:?}");
    assert!(near(centres(&lib)[0], 47.0, 47.0), "{:?}", centres(&lib));
}

#[test]
fn two_real_adjacent_cells_are_not_merged() {
    let t = 2000;
    let mut rng = Lcg(71);
    // Supports overlap (7 px apart); activity is independent.
    let cells = vec![
        (blob(0, 45.0, 44.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(1, 49.0, 50.0), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 73);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 45.0, 44.0), blob(2, 49.0, 50.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.len(), 2, "stats {:?}", slow.stats());
    assert_eq!(slow.stats().merges, 0, "stats {:?}", slow.stats());
    let c = centres(&lib);
    assert!(c.iter().any(|&p| near(p, 45.0, 44.0)), "{c:?}");
    assert!(c.iter().any(|&p| near(p, 49.0, 50.0)), "{c:?}");
}

#[test]
fn a_merged_pair_footprint_is_split() {
    let t = 2000;
    let mut rng = Lcg(81);
    let cells = vec![
        (blob(0, 44.0, 44.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(1, 50.0, 51.0), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 83);
    // One footprint covering both cells.
    let mut pair = blob_w(1, 47.0, 47.5, 2.5);
    let (a, b) = (blob(0, 44.0, 44.0), blob(0, 50.0, 51.0));
    for y in 0..pair.height {
        for x in 0..pair.width {
            let (gy, gx) = (pair.y0 + y, pair.x0 + x);
            let v = |f: &Footprint| {
                if gy >= f.y0 && gy < f.y0 + f.height && gx >= f.x0 && gx < f.x0 + f.width {
                    f.values[(gy - f.y0) * f.width + gx - f.x0]
                } else {
                    0.0
                }
            };
            pair.values[y * pair.width + x] = v(&a) + v(&b);
        }
    }
    let (mut slow, mut eng) = start(v2_config(), &[pair]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    let c = centres(&lib);
    assert_eq!(c.len(), 2, "{c:?}, stats {:?}", slow.stats());
    assert!(c.iter().any(|&p| near(p, 44.0, 44.0)), "{c:?}");
    assert!(c.iter().any(|&p| near(p, 50.0, 51.0)), "{c:?}");
}

#[test]
fn noise_only_adds_nothing_over_a_long_run() {
    let t = 2000;
    let m = movie(&[], t, 91);
    let (mut slow, mut eng) = start(v2_config(), &[]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.len(), 0, "stats {:?}", slow.stats());
    assert_eq!(edits(&slow.take_edit_counts()), 0);
}

#[test]
fn edits_die_out_on_a_stationary_movie() {
    let t = 3000;
    let mut rng = Lcg(101);
    let pos = [
        (20.0, 22.0),
        (24.0, 70.0),
        (46.0, 46.0),
        (52.0, 55.0),
        (72.0, 26.0),
        (74.0, 72.0),
    ];
    let cells: Vec<_> = pos
        .iter()
        .enumerate()
        .map(|(i, &(y, x))| (blob(i as u64, y, x), trace(&mut rng, t, 0.02, 5.0)))
        .collect();
    let m = movie(&cells, t, 103);
    let (mut slow, mut eng) = start(v2_config(), &[]);
    let mut deleted = Vec::new();
    let mut per = Vec::new();
    for q in 0..6 {
        drive(
            &m,
            q * 500..(q + 1) * 500,
            &mut slow,
            &mut eng,
            &mut deleted,
        );
        per.push(edits(&slow.take_edit_counts()));
    }
    let lib = slow.finalize().unwrap();
    assert_eq!(
        lib.len(),
        pos.len(),
        "edits {per:?}, stats {:?}",
        slow.stats()
    );
    let first: u64 = per[..2].iter().sum();
    let last: u64 = per[4..].iter().sum();
    assert!(
        first > 0 && last * 4 <= first,
        "edits per 500 frames {per:?}"
    );
}

/// Merges over a run of `t` frames from `seed` with `cfg`, and the final
/// library size.
fn merges_with(cfg: SlowLoopConfig, m: &[f32], t: usize, seed: &[Footprint]) -> (u64, usize) {
    let (mut slow, mut eng) = start(cfg, seed);
    let mut deleted = Vec::new();
    drive(m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    (slow.stats().merges, lib.len())
}

#[test]
fn neighbours_with_lagging_footprints_are_not_merged() {
    let t = 2000;
    let mut rng = Lcg(91);
    let cells = vec![
        (blob(0, 45.0, 44.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(1, 50.0, 51.0), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 93);
    // Both footprints too narrow and shifted toward each other: a fresh
    // single footprint over the pair can fit better than the two current
    // ones, but not better than the pair refitted on the same frames.
    let seed = [blob_w(1, 46.0, 45.5, 1.8), blob_w(2, 49.0, 49.5, 1.8)];
    let (merges, n) = merges_with(v2_config(), &m, t, &seed);
    assert_eq!(merges, 0, "{n} cells");
    assert_eq!(n, 2);
}

#[test]
fn a_fragment_beside_its_cell_is_not_kept() {
    let t = 1500;
    let mut rng = Lcg(97);
    let cells = vec![(blob(0, 47.0, 47.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 99);
    // The cell, and a small fragment on its edge (supports overlap by less
    // than half, so the refitted pair is tried): the fragment must not be
    // kept as a second cell (merged, or deleted by the keep tests).
    let seed = [blob(1, 47.0, 47.0), blob_w(2, 47.0, 52.0, 1.5)];
    let (merges, n) = merges_with(v2_config(), &m, t, &seed);
    assert_eq!(n, 1, "{merges} merges");
}

/// Pure noise resampled by a random sub-pixel shift on every frame (what
/// motion correction does to the sensor noise), and the per-pixel σ the
/// noise map would measure on it.
fn resampled_noise(t: usize, seed: u64) -> (Vec<f32>, f32) {
    use crate::motion::{Interpolation, Warper};
    let n_px = N * N;
    let mut rng = Lcg(seed);
    let mut wp = Warper::new(N, N, &[], &[], Interpolation::Bicubic).unwrap();
    let mut out = vec![0.0f32; t * n_px];
    let mut white = vec![0.0f32; n_px];
    for k in 0..t {
        for v in white.iter_mut() {
            *v = rng.normal();
        }
        let s = (rng.next() * 4.0 - 2.0, rng.next() * 4.0 - 2.0);
        wp.warp(&white, s, &[], &mut out[k * n_px..(k + 1) * n_px], None)
            .unwrap();
    }
    let var = out.iter().map(|&v| f64::from(v * v)).sum::<f64>() / out.len() as f64;
    (out, var.sqrt() as f32)
}

#[test]
fn resampled_noise_adds_nothing() {
    // Sub-pixel resampling lowers the per-pixel noise while the noise at
    // cell scale stays: against a white-noise null, noise blobs pass as
    // cells. The measured spatial correlation widens the null. (The border
    // rows the warp replicates are outside the FOV, as in a recording.)
    let t = 2000;
    let (m, sigma) = resampled_noise(t, 17);
    let fov: Vec<u8> = (0..N * N)
        .map(|p| {
            let (y, x) = (p / N, p % N);
            u8::from((4..N - 4).contains(&y) && (4..N - 4).contains(&x))
        })
        .collect();
    let mut slow =
        SlowLoop::new(dims(), fov, vec![sigma; N * N], flattener(), v2_config()).unwrap();
    let lib0 = slow.finalize().unwrap();
    let mut eng = TraceEngine::new(lib0, SolverConfig::default()).unwrap();
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let rho = slow.noise_inflation();
    assert!(rho > 1.3, "inflation {rho}");
    assert_eq!(slow.stats().adds, 0, "inflation {rho}");
}

#[test]
fn white_noise_is_not_inflated() {
    let t = 300;
    let m = movie(&[], t, 5);
    let (mut slow, mut eng) = start(v2_config(), &[]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let r = slow.noise_inflation();
    assert!((r - 1.0).abs() < 0.03, "{r}");
}

/// One bright cell whose position jitters by a registration error of
/// `sd` px per axis (every frame), filtered, plus unit noise.
fn jittered_cell(t: usize, sd: f32, amp: f32, seed: u64) -> Vec<f32> {
    let n_px = N * N;
    let mut flat = flattener();
    let mut rng = Lcg(seed);
    let c = trace(&mut rng, t, 0.05, amp);
    let mut out = vec![0.0f32; t * n_px];
    let mut img = vec![0.0f32; n_px];
    for k in 0..t {
        let f = &mut out[k * n_px..(k + 1) * n_px];
        for v in f.iter_mut() {
            *v = rng.normal();
        }
        if c[k] == 0.0 {
            continue;
        }
        let fp = blob(0, 47.0 + sd * rng.normal(), 47.0 + sd * rng.normal());
        img.iter_mut().for_each(|v| *v = 0.0);
        for y in 0..fp.height {
            for x in 0..fp.width {
                img[(fp.y0 + y) * N + fp.x0 + x] = fp.values[y * fp.width + x];
            }
        }
        flat.apply(&mut img).unwrap();
        for (o, &a) in f.iter_mut().zip(&img) {
            *o += a * c[k];
        }
    }
    out
}

#[test]
fn registration_error_beside_a_bright_cell_adds_nothing() {
    // A bright cell misregistered by a fraction of a pixel leaves a dipole
    // residual beside it on every active frame; the add test's shift terms
    // explain it.
    let t = 1500;
    let m = jittered_cell(t, 0.3, 30.0, 23);
    let run = |shift_nuisance: bool| {
        let cfg = SlowLoopConfig {
            shift_nuisance,
            ..v2_config()
        };
        let (mut slow, mut eng) = start(cfg, &[blob(1, 47.0, 47.0)]);
        let mut deleted = Vec::new();
        drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
        (slow.finalize().unwrap().len(), slow.stats().adds)
    };
    let (n, adds) = run(true);
    let (n_off, adds_off) = run(false);
    eprintln!("with shift terms: {n} cells, {adds} adds; without: {n_off} cells, {adds_off} adds");
    assert_eq!(n, 1);
    assert_eq!(adds, 0);
}

#[test]
fn a_dim_cell_beside_a_bright_one_is_still_found() {
    // The shift terms are dipoles: they cannot take up a second soma's
    // light beside a bright cell.
    let t = 1500;
    let mut rng = Lcg(29);
    let cells = vec![
        (blob(0, 47.0, 47.0), trace(&mut rng, t, 0.05, 30.0)),
        (blob(0, 47.0, 55.0), trace(&mut rng, t, 0.03, 5.0)),
    ];
    let m = movie(&cells, t, 31);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 47.0, 47.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let c = centres(&slow.finalize().unwrap());
    assert_eq!(c.len(), 2, "{c:?}");
    assert!(c.iter().any(|&p| near(p, 47.0, 55.0)), "{c:?}");
}
