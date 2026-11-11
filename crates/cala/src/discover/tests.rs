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
        // About what the old 8 MB byte budget gave on this frame.
        frames_per_tile: 200,
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
    // Accounting: the seeded cell's deletion is an established removal and
    // the cell added back at its spot is a re-add, not a new cell.
    let cc = slow.churn_counts();
    assert_eq!((cc.adds_new, cc.adds_readd), (0, 1), "{cc:?}");
    assert_eq!((cc.churned, cc.established_removals), (0, 1), "{cc:?}");
    let adds = slow.take_add_log();
    assert_eq!(adds.len(), 1);
    assert!(adds[0].dist < 2.0 && adds[0].cos > 0.5, "{adds:?}");
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
    let cc = slow.churn_counts();
    assert_eq!(cc.adds_new + cc.adds_readd, e.adds);
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
    // (A 96 x 96 frame samples few pixels per frame: a long run keeps the
    // estimate's own noise below the tolerance.)
    let t = 1500;
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

/// Unsupported deletions of the cell seeded as `seed` (id 1) and the slow
/// loop's stats, over a movie of `cells`.
fn keep_run(cells: &[(Footprint, Vec<f32>)], seed: Footprint, noise: u64) -> (usize, SlowStats) {
    let t = cells[0].1.len();
    let m = movie(cells, t, noise);
    let (mut slow, mut eng) = start(v2_config(), &[seed]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let n = deleted
        .iter()
        .filter(|d| d.info.id == 1 && d.reason == DeleteReason::Unsupported)
        .count();
    (n, slow.stats())
}

#[test]
fn weak_transients_of_a_true_cell_are_not_failures() {
    // A soma about the size of the free bump, with weak transients: on
    // many probes too little of its light is left once the bump has taken
    // its share for the test to pass. Those probes are inconclusive;
    // counted as failures (as before) they were 13 of 71.
    let t = 3000;
    let mut rng = Lcg(77);
    let cells = vec![(blob_w(0, 48.0, 48.0, 7.0), trace(&mut rng, t, 0.05, 1.5))];
    let (n, stats) = keep_run(&cells, blob_w(1, 48.0, 48.0, 7.0), 41);
    assert_eq!(n, 0, "{stats:?}");
    assert_eq!(stats.keep_fails, 0, "{stats:?}");
    assert!(stats.keep_inconclusive > 0, "{stats:?}");
}

#[test]
fn a_cell_on_diffuse_light_is_still_deleted() {
    // Only broad light (σ 10 px, a neuropil-like glow) where a compact
    // cell was seeded: the keep tests had the power to see the cell's
    // shape and did not, so they fail and the cell goes.
    let t = 3000;
    let mut rng = Lcg(77);
    let cells = vec![(blob_w(0, 48.0, 48.0, 10.0), trace(&mut rng, t, 0.03, 4.0))];
    let (n, stats) = keep_run(&cells, blob(1, 48.0, 48.0), 41);
    assert_eq!(n, 1, "{stats:?}");
}

// ---- parallel visits (shard.rs) ---------------------------------------------

/// A movie with something for every edit: cells to add, a duplicate pair
/// to merge, a merged pair to split, a seeded cell on empty sky to delete,
/// and cells in most tiles.
fn busy_movie(t: usize) -> (Vec<f32>, Vec<Footprint>) {
    let mut rng = Lcg(211);
    let pos = [
        (20.0, 22.0),
        (24.0, 70.0),
        (44.0, 44.0),
        (50.0, 51.0),
        (72.0, 26.0),
        (74.0, 72.0),
    ];
    let cells: Vec<_> = pos
        .iter()
        .enumerate()
        .map(|(i, &(y, x))| (blob(i as u64, y, x), trace(&mut rng, t, 0.03, 6.0)))
        .collect();
    let m = movie(&cells, t, 223);
    let seed = vec![
        blob(1, 20.0, 22.0),
        blob(2, 21.0, 23.0),
        blob_w(3, 47.0, 47.5, 4.0),
        blob(4, 30.0, 48.0),
    ];
    (m, seed)
}

fn shard_config() -> SlowLoopConfig {
    SlowLoopConfig {
        probation_frames: 300,
        probe_gap_frames: 20,
        tile_px: 24,
        ..config()
    }
}

fn new_loop(cfg: &SlowLoopConfig) -> SlowLoop {
    let n_px = N * N;
    SlowLoop::new(
        dims(),
        vec![1; n_px],
        vec![1.0; n_px],
        flattener(),
        cfg.clone(),
    )
    .unwrap()
}

#[test]
fn visits_run_as_jobs_match_step_exactly() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        assert_eq!(ta.traces, tb.traces, "frame {k}");
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        a.observe(f, &la, &ta).unwrap();
        b.observe(f, &lb, &tb).unwrap();
        if k % 400 == 399 {
            // A new noise map mid-run reaches the runner too.
            let noise = vec![1.0 + 0.01 * (k / 400) as f32; n_px];
            a.set_noise(noise.clone()).unwrap();
            b.set_noise(noise.clone()).unwrap();
            runner.set_noise(noise).unwrap();
        }
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step_via(5_000_000, &mut runner).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(
                la.to_bytes()[16..] == lb.to_bytes()[16..],
                "frame {k}: {:?} vs {:?}; {:?} vs {:?}; {:?} vs {:?}",
                la.ids(),
                lb.ids(),
                (0..la.len()).map(|s| la.support(s)).collect::<Vec<_>>(),
                (0..lb.len()).map(|s| lb.support(s)).collect::<Vec<_>>(),
                a.stats(),
                b.stats()
            );
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    let s = a.stats();
    assert!(
        s.adds > 0 && s.merges > 0 && s.refines > 0 && s.keep_tests > 0,
        "{s:?}"
    );
    assert_eq!(s, b.stats());
    assert_eq!(a.work(), b.work());
    assert_eq!(a.cell_infos(), b.cell_infos());
    assert_eq!(a.churn_counts(), b.churn_counts());
    // (NaN fields: compare as text.)
    assert_eq!(
        format!("{:?}", a.take_add_log()),
        format!("{:?}", b.take_add_log())
    );
    assert_eq!(
        format!("{:?}", a.take_removal_log()),
        format!("{:?}", b.take_removal_log())
    );
    // The edit logs agree except for the nearest-cell note of an add (a
    // job holds only the cells near its tile).
    let strip = |v: Vec<EditEvent>| -> Vec<EditEvent> {
        v.into_iter()
            .map(|mut e| {
                if e.kind == EditKind::Add {
                    e.other = 0;
                }
                e
            })
            .collect()
    };
    assert_eq!(strip(a.take_edit_log()), strip(b.take_edit_log()));
    // (Bytes 8..16: the version, from a process-wide counter.)
    assert!(a.finalize().unwrap().to_bytes()[16..] == b.finalize().unwrap().to_bytes()[16..]);
}

#[test]
fn concurrent_jobs_never_share_cells_and_apply_in_any_order() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    // Small patches, so that tiles at opposite corners of the small test
    // frame can run at once.
    let cfg = SlowLoopConfig {
        tile_px: 16,
        margin_px: 10,
        library: crate::trace::LibraryConfig {
            max_support_px: 10.0,
            ..crate::trace::LibraryConfig::default()
        },
        ..shard_config()
    };
    let n_px = N * N;
    let (mut s, mut eng) = start(cfg.clone(), &seed);
    let mut runners: Vec<VisitRunner> = (0..4).map(|_| VisitRunner::new(new_loop(&cfg))).collect();
    let mut max_out = 0;
    let mut out: Vec<VisitResult> = Vec::new();
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        s.observe(f, &lib, &tr).unwrap();
        // Results come back one batch late, newest first.
        if k % 8 == 7 {
            while let Some(r) = out.pop() {
                s.apply_job(r).unwrap();
            }
            let mut jobs = Vec::new();
            while jobs.len() < runners.len() {
                let Some(j) = s.take_job() else { break };
                jobs.push(j);
            }
            max_out = max_out.max(jobs.len());
            // Zones of the jobs out at once are disjoint, so are their cells.
            for i in 0..s.inflight.len() {
                for j in i + 1..s.inflight.len() {
                    let (x, y) = (&s.inflight[i], &s.inflight[j]);
                    assert!(!x.zone.intersects(&y.zone));
                    assert!(x.ids.iter().all(|id| !y.ids.contains(id)));
                }
            }
            for (j, r) in jobs.into_iter().zip(runners.iter_mut()) {
                let j = VisitJob::from_bytes(&j.to_bytes()).unwrap();
                out.push(VisitResult::from_bytes(&r.run(j).unwrap().to_bytes()).unwrap());
            }
            if let Some(l) = s.housekeep().unwrap() {
                eng.set_library(l).unwrap();
            }
        }
    }
    while let Some(r) = out.pop() {
        s.apply_job(r).unwrap();
    }
    assert_eq!(s.jobs_in_flight(), 0);
    assert!(max_out >= 2, "never more than {max_out} job at once");
    let lib = s.finalize().unwrap();
    let mut ids = lib.ids().to_vec();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), lib.len(), "duplicate ids");
    let c = centres(&lib);
    for (y, x) in [(24.0, 70.0), (72.0, 26.0), (74.0, 72.0)] {
        assert!(c.iter().any(|&p| near(p, y, x)), "{c:?}");
    }
    assert!(c.len() <= 7, "{c:?}, stats {:?}", s.stats());
}

#[test]
fn a_result_from_elsewhere_or_a_bad_buffer_is_an_error() {
    let cfg = shard_config();
    let n_px = N * N;
    let (m, seed) = busy_movie(200);
    let (mut s, mut eng) = start(cfg.clone(), &seed);
    let mut job = None;
    for k in 0..200 {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        s.observe(f, &lib, &tr).unwrap();
        if job.is_none() {
            job = s.take_job();
        }
    }
    let job = job.expect("a tile became due");
    let bytes = job.to_bytes();
    for cut in [0, 3, bytes.len() / 2, bytes.len() - 1] {
        assert!(VisitJob::from_bytes(&bytes[..cut]).is_err());
    }
    let mut runner = VisitRunner::new(new_loop(&cfg));
    let r = runner.run(job).unwrap();
    let rb = r.to_bytes();
    assert!(VisitResult::from_bytes(&rb[..rb.len() - 1]).is_err());
    // A runner with an older noise map refuses; a loop that did not hand
    // the job out refuses its result.
    s.set_noise(vec![1.1; n_px]).unwrap();
    if let Some(j2) = s.take_job() {
        assert!(runner.run(j2).is_err());
    }
    let mut other = new_loop(&cfg);
    assert!(other.apply_job(r).is_err());
}

#[test]
fn the_reservoir_is_sized_by_frames_per_tile_within_its_cap() {
    let s = new_loop(&config());
    let p = s.reservoir_plan();
    assert_eq!(p.frames_per_tile, 200);
    assert_eq!((p.event_slots, p.random_slots), (140, 60));
    assert!(!p.limited() && p.warning().is_none());
    // Random frames are stored once for the whole frame: the 2 x 2 tiles'
    // patches (72 x 72 each) would hold 4 x 5184 px per frame, the shared
    // store holds the 96 x 96 frame.
    let patches: usize = s.tiles.iter().map(|t| t.rect.len() * 2).sum();
    assert_eq!(patches, 4 * 72 * 72 * 2);
    assert_eq!(
        p.capacity_bytes,
        (140 + config().probes_per_tile) * patches + 60 * N * N * 2
    );
    // A cap below that cuts the frames per tile, and says so.
    let capped = |share: f64| {
        new_loop(&SlowLoopConfig {
            reservoir_max_bytes: (p.capacity_bytes as f64 * share) as usize,
            ..config()
        })
        .reservoir_plan()
    };
    let half = capped(0.5);
    assert!(half.limited() && half.capacity_bytes <= half.max_bytes);
    assert!(half.frames_per_tile < 200 && half.frames_per_tile > 80);
    assert!(half.warning().unwrap().contains("frames per tile"));
    let starved = capped(0.05);
    assert_eq!(starved.min_frames_per_tile, 24);
    assert!(starved.frames_per_tile < 36);
    assert!(starved
        .warning()
        .unwrap()
        .starts_with("Cell discovery is starved"));
}

#[test]
fn random_slots_share_one_uniform_sample() {
    let cfg = SlowLoopConfig {
        frames_per_tile: 10,
        ..config()
    };
    let n_px = N * N;
    let (m, seed) = busy_movie(120);
    let (mut s, mut eng) = start(cfg, &seed);
    for k in 0..120 {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        s.observe(f, &lib, &tr).unwrap();
    }
    assert_eq!(s.shared.frames.len(), 3);
    assert!(s.reservoir_bytes() <= s.reservoir_plan().capacity_bytes);
    let frames: Vec<u64> = s.shared.frames.iter().map(|f| f.frame).collect();
    for t in &s.tiles {
        let own: Vec<u64> = t.randoms.iter().map(|r| r.frame).collect();
        assert_eq!(own, frames);
        assert!(t.randoms.iter().all(|r| r.data.is_empty()));
    }
    // A tile's random patch read from the shared store is the patch a job
    // carries.
    let t = &s.tiles[3];
    let mut job_tile = t.clone();
    job_tile.fill_randoms(&s.shared);
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for j in 0..3 {
        t.slot_values((false, j), &s.shared, &mut a);
        job_tile.slot((false, j)).values(&mut b);
        assert_eq!(a.len(), t.rect.len());
        assert_eq!(a, b);
    }
}

#[test]
fn two_pass_whitening_is_bit_identical_to_the_pixel_loop() {
    let mut rng = Lcg(7);
    for (h, w) in [(6usize, 8usize), (7, 9), (1, 5), (33, 31)] {
        let n = h * w;
        let mut frame: Vec<f32> = (0..n).map(|_| 40.0 * rng.normal()).collect();
        frame[n / 3] = f32::NAN;
        frame[n / 2] = f32::INFINITY;
        let inv: Vec<f32> = (0..n).map(|_| 0.2 + rng.next()).collect();
        let model: Vec<f32> = (0..n).map(|_| 30.0 * rng.next()).collect();
        let cw = w.div_ceil(2);
        // The original pixel-by-pixel loop.
        let mut z0 = vec![0.0f32; n];
        let mut c0 = vec![0.0f32; cw * h.div_ceil(2)];
        for i in 0..n {
            let (s, y) = (inv[i], frame[i]);
            z0[i] = if y.is_finite() { y * s } else { 0.0 };
            let r = if y.is_finite() {
                (y - model[i]) * s
            } else {
                0.0
            };
            c0[(i / w / 2) * cw + (i % w) / 2] += 0.25 * r;
        }
        let mut z = vec![1.0f32; n];
        let mut c = vec![1.0f32; c0.len()];
        let mut q = Vec::new();
        whiten(&frame, &inv, &model, &mut z, &mut c, w, &mut q);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&z), bits(&z0), "{h}x{w}");
        assert_eq!(bits(&c), bits(&c0), "{h}x{w}");
    }
}

#[test]
fn event_slots_keep_the_highest_decayed_priority() {
    // The cached log-priority keys pick the slot a direct scan of
    // `score · decay^age` would, over a long random stream.
    let rect = Rect {
        y0: 0,
        x0: 0,
        h: 2,
        w: 2,
    };
    let z = vec![0.0f32; 4];
    let ln_decay = -std::f64::consts::LN_2 / 50.0;
    let mut tile = Tile::new(rect, rect);
    let mut reference: Vec<(u64, f32)> = Vec::new();
    let mut rng = Lcg(3);
    for frame in 0..5000u64 {
        let score = if rng.next() < 0.3 {
            0.0
        } else {
            10.0 * rng.next()
        };
        tile.offer(&z, 2, frame, score, false, 12, ln_decay);
        // Reference: the original rule.
        if let Some(i) = reference.iter().position(|s| frame - s.0 <= 2) {
            if score > reference[i].1 {
                reference[i] = (frame, score);
            }
        } else if reference.len() < 12 {
            reference.push((frame, score));
        } else {
            let prio = |s: &(u64, f32)| f64::from(s.1) * ln_decay.exp().powf((frame - s.0) as f64);
            let (imin, pmin) = reference
                .iter()
                .enumerate()
                .map(|(i, s)| (i, prio(s)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .unwrap();
            if f64::from(score) > pmin {
                reference[imin] = (frame, score);
            }
        }
        let got: Vec<(u64, f32)> = tile.events.iter().map(|s| (s.frame, s.score)).collect();
        assert_eq!(got, reference, "frame {frame}");
    }
}

#[test]
fn wasm_quantisation_rounds_like_f32_round() {
    use super::reservoir::{quantize_round, quantize_trunc};
    let mut vals = vec![
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        0.0,
        -0.0,
        1e9,
        -1e9,
        2047.99,
        -2047.99,
    ];
    // Every tie (k + 1/2) / 16 and its neighbours, over the stored range.
    for k in -40_000i32..40_000 {
        let tie = (k as f32 + 0.5) / 16.0;
        vals.extend([tie, tie.next_up(), tie.next_down(), k as f32 / 16.0]);
    }
    let mut rng = Lcg(11);
    vals.extend((0..100_000).map(|_| 300.0 * rng.normal()));
    for v in vals {
        assert_eq!(quantize_round(v), quantize_trunc(v), "{v}");
    }
}

#[test]
fn joint_neighbour_fit_sees_mixtures_not_noise() {
    // A candidate trace that is a mix of three neighbours' traces (none of
    // which follows it alone) is explained jointly; an independent one, or
    // too few frames for the neighbours, is not.
    let mut rng = Lcg(7);
    let n = 40;
    let spiky = |rng: &mut Lcg| -> Vec<f32> {
        (0..n)
            .map(|_| {
                let u = rng.next();
                if u > 0.85 {
                    5.0 * u
                } else {
                    0.0
                }
            })
            .collect()
    };
    let nb: Vec<Vec<f32>> = (0..3).map(|_| spiky(&mut rng)).collect();
    let mix: Vec<f32> = (0..n)
        .map(|t| 0.6 * nb[0][t] + 0.5 * nb[1][t] + 0.4 * nb[2][t] + 0.3 * rng.normal())
        .collect();
    for j in 0..3 {
        assert!(corr(&mix, &nb[j]) < 0.8, "one neighbour alone explains it");
    }
    assert!(adjusted_r2(&mix, &nb) > 0.6);
    let own = spiky(&mut rng);
    assert!(adjusted_r2(&own, &nb) < 0.36);
    let short: Vec<Vec<f32>> = nb.iter().map(|v| v[..5].to_vec()).collect();
    assert_eq!(adjusted_r2(&mix[..5], &short), 0.0);
}
