// Index loops over cells and pixels read more clearly here.
#![allow(clippy::needless_range_loop)]

use std::sync::Arc;

use super::*;
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::test_rng::Lcg;
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
    // The seeded cell's support holds the whole disk (zeros past the given
    // window); compare on the window's pixels.
    let (pa, a) = lib.filtered(0);
    let (pb, b) = direct.filtered(0);
    let mut err = 0.0f32;
    for (p, y) in pb.iter().zip(b) {
        let k = pa.binary_search(p).expect("window pixel in the support");
        err = err.max((a[k] - y).abs());
    }
    assert!(err < 1e-5, "err {err}");
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

/// Under either merge rule a duplicate of an established cell is merged
/// (under the split-half rule: its light and the cell's form one basin).
#[test]
fn a_duplicate_of_an_established_cell_is_merged() {
    let t = 1200;
    let mut rng = Lcg(41);
    let cells = vec![(blob(0, 47.0, 47.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 43);
    for rule in [MergeRule::Legacy, MergeRule::SplitHalf] {
        let cfg = SlowLoopConfig {
            merge_rule: rule,
            ..v2_config()
        };
        let (mut slow, mut eng) = start(cfg, &[blob(1, 47.0, 47.0)]);
        let mut deleted = Vec::new();
        drive(&m, 0..600, &mut slow, &mut eng, &mut deleted);
        assert_eq!(
            slow.cell_info(1).map(|c| c.status),
            Some(CellStatus::Established),
            "{rule:?}"
        );
        // A second copy, 2 px off, appears later (as a late add would).
        assert_eq!(slow.seed(&[blob(9, 49.0, 48.0)]).unwrap(), 1);
        assert_eq!(slow.finalize().unwrap().len(), 2);
        drive(&m, 600..t, &mut slow, &mut eng, &mut deleted);
        let lib = slow.finalize().unwrap();
        assert_eq!(lib.ids(), &[1], "{rule:?}: stats {:?}", slow.stats());
        assert!(slow.stats().merges >= 1, "{rule:?}");
        assert!(
            deleted.is_empty(),
            "{rule:?}: merged, not deleted: {deleted:?}"
        );
    }
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

// ---- history review (compress/review.rs) -------------------------------------

#[test]
fn reviewed_candidates_are_added_as_new_cells_on_free_spots() {
    let (mut slow, _eng) = start(v2_config(), &[blob(1, 30.0, 30.0)]);
    // One candidate on empty tissue, one on the seeded cell.
    let added = slow
        .add_reviewed(&[blob(0, 60.0, 60.0), blob(0, 31.0, 30.0)])
        .unwrap();
    assert_eq!(added, 1);
    assert_eq!(slow.stats().review_adds, 1);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.len(), 2);
    assert!(lib.ids().contains(&1) && lib.ids().iter().all(|&id| id >= 1));
    assert!(centres(&lib).iter().any(|&c| near(c, 60.0, 60.0)));
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
    // Seeds cut to tight disks (a footprint keeps its given extent, and
    // the concurrency test needs small zones).
    let seed = vec![
        blob(1, 20.0, 22.0),
        blob(2, 21.0, 23.0),
        blob_w(3, 47.0, 47.5, 4.0),
        blob(4, 30.0, 48.0),
    ]
    .into_iter()
    .map(|mut fp| {
        let c = (fp.y0 + fp.height / 2, fp.x0 + fp.width / 2);
        for y in 0..fp.height {
            for x in 0..fp.width {
                let (dy, dx) = (
                    (fp.y0 + y) as f32 - c.0 as f32,
                    (fp.x0 + x) as f32 - c.1 as f32,
                );
                if dy * dy + dx * dx > 64.0 {
                    fp.values[y * fp.width + x] = 0.0;
                }
            }
        }
        fp
    })
    .collect();
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
    // The runner rebuilds each tile's background basis per visit, so it holds none between jobs.
    assert_eq!(runner.cached_bases(), 0);
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

/// The visit memos and caches (Gram reuse, the frames' column dots, the
/// solve and residual memos, the patch grid) change nothing: a loop with
/// them and one without make the same edits, count the same work and
/// publish the same libraries, frame by frame, on a busy movie with a
/// sweeping missing band. With warm starts (the default) the memo is
/// keyed by the start as well; without them every solve starts at zero.
#[test]
fn visit_reuse_matches_the_plain_computation_exactly() {
    visit_reuse_matches_the_plain_computation(true);
}

#[test]
fn visit_reuse_matches_the_plain_computation_without_warm_starts() {
    visit_reuse_matches_the_plain_computation(false);
}

/// Warm starts change the visits' numbers, so visit workers must be built
/// with the slow loop's setting: it is part of the fingerprint the configs
/// built from params carry.
#[test]
fn warm_start_is_a_visit_option() {
    use crate::params::engine::Engine;
    use crate::params::resolve::Context;
    use crate::params::CalaParams;
    let ctx = Context {
        fps: Some(20.0),
        frame: [64, 64],
    };
    let on = CalaParams::default();
    let mut off = on.clone();
    off.discover.warm_start = false;
    let (on, off) = (
        Engine::build(&on, ctx).unwrap().slow_loop,
        Engine::build(&off, ctx).unwrap().slow_loop,
    );
    assert!(on.warm_start && !off.warm_start);
    assert_ne!(on.fingerprint, off.fingerprint);
}

fn visit_reuse_matches_the_plain_computation(warm_start: bool) {
    let t = 1500;
    let (mut m, seed) = busy_movie(t);
    sweep_missing(&mut m, t, 10..86, 20..70);
    let cfg = SlowLoopConfig {
        warm_start,
        ..shard_config()
    };
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    b.set_reuse(false);
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        assert_eq!(ta.traces, tb.traces, "frame {k}");
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        a.observe(f, &la, &ta).unwrap();
        b.observe(f, &lb, &tb).unwrap();
        if k % 400 == 399 {
            let noise: Vec<f32> = (0..n_px)
                .map(|i| 1.0 + 0.01 * (k / 400) as f32 + 0.001 * (i % 5) as f32)
                .collect();
            a.set_noise(noise.clone()).unwrap();
            b.set_noise(noise).unwrap();
        }
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step(5_000_000).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        assert_eq!(a.work(), b.work(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            // (Bytes 8..16: the version, from a process-wide counter.)
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    let s = a.stats();
    assert!(
        s.adds > 0 && s.merges > 0 && s.refines > 0 && s.keep_tests > 0 && s.split_tests > 0,
        "{s:?}"
    );
    assert_eq!(s, b.stats());
    assert_eq!(a.cell_infos(), b.cell_infos());
    assert_eq!(
        format!("{:?}", a.take_add_log()),
        format!("{:?}", b.take_add_log())
    );
    assert_eq!(
        format!("{:?}", a.take_removal_log()),
        format!("{:?}", b.take_removal_log())
    );
    assert_eq!(a.take_edit_log(), b.take_edit_log());
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
            // A missing sample stays missing (NaN; residual 0).
            z0[i] = if y.is_finite() { y * s } else { f32::NAN };
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

#[test]
fn config_defaults_are_valid_without_joint_neighbours() {
    let cfg = SlowLoopConfig::default();
    assert!(!cfg.joint_neighbours);
    cfg.validate().unwrap();
}

/// Mark a band of columns as missing (NaN) in every frame of `m`; the band
/// sweeps across the patch (width 4 px, 6 frames per column step), the way
/// a mask edge sweeps under motion. `rows` limits it vertically.
fn sweep_missing(
    m: &mut [f32],
    t: usize,
    rows: std::ops::Range<usize>,
    cols: std::ops::Range<usize>,
) {
    let n_px = N * N;
    for k in 0..t {
        let x0 = cols.start + (k / 6) % cols.len();
        for y in rows.clone() {
            for x in x0..(x0 + 4).min(N) {
                m[k * n_px + y * N + x] = f32::NAN;
            }
        }
    }
}

/// A mask edge sweeping across noise (the movie's NaN band keeps moving,
/// the pixels behind it are ordinary noise) is not a cell: nothing is added
/// in 2000 frames.
#[test]
fn edge_candidate_made_of_the_sweeping_mask_gets_no_held_out_gain() {
    let t = 2000;
    let mut m = movie(&[], t, 91);
    sweep_missing(&mut m, t, 10..86, 20..70);
    let (mut slow, mut eng) = start(v2_config(), &[]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.len(), 0, "stats {:?}", slow.stats());
    assert_eq!(edits(&slow.take_edit_counts()), 0);
}

/// A real cell under the sweeping band on a share of the frames is still
/// established, not deleted, and its footprint stays where it was.
#[test]
fn a_cell_under_a_sweeping_band_is_kept() {
    let t = 3000;
    let mut rng = Lcg(31);
    let cells = vec![(blob(0, 40.0, 44.0), trace(&mut rng, t, 0.02, 5.0))];
    let mut m = movie(&cells, t, 37);
    sweep_missing(&mut m, t, 20..60, 30..60);
    let (mut slow, mut eng) = start(v2_config(), &[blob(1, 40.0, 44.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    assert!(deleted.is_empty(), "deleted {deleted:?}");
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.len(), 1, "stats {:?}", slow.stats());
    assert!(near(centres(&lib)[0], 40.0, 44.0), "{:?}", centres(&lib));
}

/// A missing sample survives the reservoir (event slot, shared random slot,
/// the wire encoding of a visit's tile) as NaN, is zeroed with its index
/// handed to the solves by `take_missing`, and no real value collides with
/// the marker.
#[test]
fn missing_samples_round_trip_through_the_reservoir() {
    use reservoir::{take_missing, SharedFrames, Tile, MISSING};
    let rect = Rect {
        y0: 0,
        x0: 0,
        h: 3,
        w: 4,
    };
    let mut z: Vec<f32> = (0..12).map(|i| i as f32 - 5.5).collect();
    z[2] = f32::NAN;
    z[7] = f32::NAN;
    z[11] = -1.0e9; // clamps to -32767, never to the marker
    let mut tile = Tile::new(rect, rect);
    tile.offer(&z, 4, 10, 1.0, false, 4, -0.01);
    let mut shared = SharedFrames::new(rect);
    let j = shared.offer(&z, 4, 10, false, 4, 1).unwrap();
    tile.set_random(j, 10, false);
    for which in [(true, 0), (false, 0)] {
        let mut v = Vec::new();
        tile.slot_values(which, &shared, &mut v);
        assert!(v[2].is_nan() && v[7].is_nan(), "{v:?}");
        assert_eq!(v[11], -32767.0 / 16.0);
        let miss = take_missing(&mut v);
        assert_eq!(miss, vec![2, 7]);
        assert!(v.iter().all(|x| x.is_finite()) && v[2] == 0.0 && v[7] == 0.0);
    }
    assert_ne!(tile.events[0].data[11], MISSING);
    // The wire carries the marker verbatim.
    tile.fill_randoms(&shared);
    let mut w = wire::Writer::default();
    w.i16s(&tile.events[0].data);
    let back = wire::Reader::new(&w.buf).i16s().unwrap();
    assert_eq!(back[2], MISSING);
    assert_eq!(back[7], MISSING);
}

#[test]
fn a_refine_only_scope_freezes_the_cell_set() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let (mut slow, mut eng) = start(shard_config(), &seed);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let before = slow.stats();
    let ids: Vec<u64> = slow.cell_infos().iter().map(|c| c.id).collect();
    // A second pass over the same movie that may only refine.
    slow.set_edit_scope(EditScope::Refine);
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let after = slow.stats();
    let ids_after: Vec<u64> = slow.cell_infos().iter().map(|c| c.id).collect();
    assert_eq!(ids, ids_after);
    let structural = |s: &SlowStats| {
        (
            s.adds,
            s.absorbs,
            s.merges,
            s.splits,
            s.deletes,
            s.keep_tests,
        )
    };
    assert_eq!(structural(&before), structural(&after), "{after:?}");
    // Visits go on, and so do the refinement tests.
    assert!(
        after.visits > before.visits && after.work_refine > before.work_refine,
        "{before:?} -> {after:?}"
    );
}

// ---- S2.1: the support rule ------------------------------------------------

/// A library cell's filtered column at global pixel `g`: the support
/// values, `−low` of the pixel's block off it, 0 beyond the moat.
fn lib_column_at(lib: &Library, slot: usize, g: u32) -> f32 {
    let (pix, val) = lib.filtered(slot);
    if let Ok(k) = pix.binary_search(&g) {
        return val[k];
    }
    let b = lib.block_px();
    if b == 0 {
        return 0.0;
    }
    let (y, x) = (g as usize / N, g as usize % N);
    let bq = ((y / b) * N.div_ceil(b) + x / b) as u32;
    let (blk, low) = lib.lowpass(slot);
    blk.binary_search(&bq).map_or(0.0, |k| -low[k])
}

/// A cell of `blob` (σ 2.5 px) cut to `r` px, centre (40, 44), on a disk of
/// 8 px with a ring of zero values, and a skirt on four blocks.
fn skirt_cell(skirt: &[(u32, f32)]) -> Cell {
    let fp = blob(9, 40.0, 44.0);
    let rect = Rect {
        y0: fp.y0,
        x0: fp.x0,
        h: fp.height,
        w: fp.width,
    };
    let mut a = fp.values.clone();
    for y in 0..rect.h {
        for x in 0..rect.w {
            let (dy, dx) = ((rect.y0 + y) as f32 - 40.0, (rect.x0 + x) as f32 - 44.0);
            if dy * dy + dx * dx > 25.0 {
                a[y * rect.w + x] = 0.0;
            }
        }
    }
    // A single far pixel keeps zeros inside the support disk.
    a[0] = 1e-3;
    let mut f = LocalFilter::new(flattener().sigma());
    Cell::from_canvas(
        9,
        rect,
        &a,
        dims(),
        &vec![1u8; N * N],
        &LibraryConfig::default(),
        Extent::Given,
        &mut f,
        skirt,
    )
    .unwrap()
}

/// The skirt is the same block-constant field on the complement of the
/// support in the slow loop's cell and in the published library (and in
/// its bytes): zero on `S`, `skirt_b` on zero-valued disk pixels and off
/// the disk.
#[test]
fn library_skirt_matches_slow_loop_column() {
    let b = LocalFilter::new(flattener().sigma()).moat().unwrap().0;
    let gw = N.div_ceil(b) as u32;
    let blk = |y: u32, x: u32| (y / b as u32) * gw + x / b as u32;
    let mut skirt = vec![
        (blk(40, 44), 0.03f32),
        (blk(40, 56), 0.02),
        (blk(30, 44), -0.01),
        (blk(56, 60), 0.015),
    ];
    skirt.sort_by_key(|s| s.0);
    let plain = skirt_cell(&[]);
    let cell = skirt_cell(&skirt);
    assert!(plain.raw.contains(&0.0), "the disk has zero-valued pixels");
    assert_eq!(
        cell.skirt_blk,
        skirt.iter().map(|s| s.0).collect::<Vec<_>>()
    );
    let build = |c: &Cell, sk: bool| {
        let mut bld = LibraryBuilder::new(dims());
        if sk {
            bld.push_disk_skirt(c.footprint(dims()), c.center, c.radius, skirt.clone());
        } else {
            bld.push_disk(c.footprint(dims()), c.center, c.radius);
        }
        bld.build(&mut flattener()).unwrap()
    };
    let (lp, ls) = (build(&plain, false), build(&cell, true));
    assert_eq!(ls.skirt(0).0, cell.skirt_blk.as_slice());
    // Bytes: CALALIB3 without a skirt, CALALIB4 with one; both round-trip.
    assert_eq!(&lp.to_bytes()[..8], b"CALALIB3");
    assert_eq!(&ls.to_bytes()[..8], b"CALALIB4");
    let back = Library::from_bytes(&ls.to_bytes()).unwrap();
    assert_eq!(back.skirt(0), ls.skirt(0));
    let in_s: std::collections::HashSet<u32> = cell
        .pix
        .iter()
        .zip(&cell.raw)
        .filter(|(_, &v)| v > 0.0)
        .map(|(&g, _)| g)
        .collect();
    // The skirt as unfiltered light `u` (block-constant outside `S`); the
    // column of the footprint with a skirt is `H (a + u)`, so the skirt
    // adds `u − L u`: on the disk exactly, off it at block resolution.
    let field: Vec<f32> = (0..(N * N) as u32)
        .map(|g| {
            let (y, x) = (g / N as u32, g % N as u32);
            if in_s.contains(&g) {
                0.0
            } else {
                skirt.iter().find(|s| s.0 == blk(y, x)).map_or(0.0, |s| s.1)
            }
        })
        .collect();
    let mut lu = vec![0.0f32; N * N];
    LocalFilter::new(flattener().sigma()).blur(N, N, &field, &mut lu);
    // The library is built with the flattener, which matches the local
    // filter in the FOV interior only; this 96 px frame (σ = 20 px) has no
    // interior, so the plain column's own gap bounds the skirt's.
    let gap = (0..(N * N) as u32)
        .map(|g| (lib_column_at(&lp, 0, g) - plain.column_at(g, N, b)).abs())
        .fold(0.0f32, f32::max);
    let (mut on_zero, mut off_disk) = (0, 0);
    for g in 0..(N * N) as u32 {
        let (y, x) = (g / N as u32, g % N as u32);
        let d_cell = cell.column_at(g, N, b) - plain.column_at(g, N, b);
        let d_lib = lib_column_at(&ls, 0, g) - lib_column_at(&lp, 0, g);
        let d_back = lib_column_at(&back, 0, g) - lib_column_at(&lp, 0, g);
        assert_eq!(d_back.to_bits(), d_lib.to_bits(), "bytes at ({y}, {x})");
        assert!(
            (d_lib - d_cell).abs() <= gap,
            "library at ({y}, {x}): {d_lib} vs cell {d_cell} (gap {gap})"
        );
        let on_disk = cell.pix.binary_search(&g).is_ok();
        if on_disk {
            let want = field[g as usize] - lu[g as usize];
            assert!(
                (d_cell - want).abs() < 1e-5,
                "disk ({y}, {x}): {d_cell} vs {want}"
            );
        }
        if field[g as usize] != 0.0 {
            if on_disk {
                on_zero += 1;
            } else {
                off_disk += 1;
            }
        }
    }
    assert!(on_zero > 0 && off_disk > 0, "{on_zero} {off_disk}");
}

/// Visit jobs carry the split halves (with per-pixel moments) and the
/// cells' skirts.
#[test]
fn wire_round_trips_halves_and_skirt() {
    let skirt = [(10u32, 0.02f32), (11, -0.01)];
    let mut cell = skirt_cell(&[]);
    cell.skirt_blk = skirt.iter().map(|s| s.0).collect();
    cell.skirt = skirt.iter().map(|s| s.1).collect();
    let mut w = wire::Writer::default();
    w.cell(&cell);
    let back = wire::Reader::new(&w.buf).cell().unwrap();
    assert_eq!(back.skirt_blk, cell.skirt_blk);
    assert_eq!(back.skirt, cell.skirt);
    assert_eq!(back.low, cell.low);
    for missing in [false, true] {
        let mut st = fpstats::FpStats::new((8.0, 8.0), 6.0, 17, 17, &[1u8; 289], 5);
        let m = st.pix.len();
        let mut rng = Lcg(5);
        for t in 0..1100usize {
            let c = rng.next() + 0.5;
            let r: Vec<f32> = (0..m)
                .map(|i| {
                    if missing && (i + t).is_multiple_of(9) {
                        f32::NAN
                    } else {
                        0.1 * i as f32 * c + rng.normal()
                    }
                })
                .collect();
            st.push(&r, [c, c], c, 1.0);
        }
        let mut w = wire::Writer::default();
        w.fpstats(&st);
        let back = wire::Reader::new(&w.buf).fpstats().unwrap();
        assert_eq!(back.half_pm.is_some(), missing);
        assert_eq!(
            format!("{:?}", st.halves()),
            format!("{:?}", back.halves()),
            "missing {missing}"
        );
        assert!(st.halves().is_some());
    }
}

/// A loop on a `side`² frame (full FOV, unit noise).
fn basin_loop(side: usize) -> SlowLoop {
    let d = Dims::new(side, side).unwrap();
    let cfg = FlattenConfig {
        cell_diameter_px: 10.0,
        ..FlattenConfig::default()
    };
    let flat = GlowFlattener::new(&FovMask::full(d), &cfg).unwrap();
    SlowLoop::new(
        d,
        vec![1; side * side],
        vec![1.0; side * side],
        flat,
        config(),
    )
    .unwrap()
}

/// Gaussian of σ `s` (and σ `s * e` along x) at `(cy, cx)`, peak `amp`, on
/// a `side`² frame.
fn gauss(side: usize, cy: f32, cx: f32, s: f32, e: f32, amp: f32) -> Vec<f32> {
    (0..side * side)
        .map(|i| {
            let (dy, dx) = ((i / side) as f32 - cy, ((i % side) as f32 - cx) / e);
            amp * (-(dy * dy + dx * dx) / (2.0 * s * s)).exp()
        })
        .collect()
}

/// Spatially correlated unit-variance noise: white noise blurred at 2 px.
fn corr_noise(side: usize, rng: &mut Lcg) -> Vec<f32> {
    let white: Vec<f32> = (0..side * side).map(|_| rng.normal()).collect();
    let mut out = vec![0.0f32; side * side];
    LocalFilter::new(2.0).blur(side, side, &white, &mut out);
    let k = (4.0 * std::f32::consts::PI * 4.0).sqrt();
    out.iter_mut().for_each(|v| *v *= k);
    out
}

/// The disk of radius `r` around `(cy, cx)` on a `side`² frame (global
/// pixels, the mask on the full-frame canvas).
fn disk_mask(side: usize, cy: f32, cx: f32, r: f32) -> (Vec<u32>, Vec<bool>) {
    let mask: Vec<bool> = (0..side * side)
        .map(|i| {
            let (dy, dx) = ((i / side) as f32 - cy, (i % side) as f32 - cx);
            dy * dy + dx * dx <= r * r
        })
        .collect();
    let pix = (0..side * side)
        .filter(|&i| mask[i])
        .map(|i| i as u32)
        .collect();
    (pix, mask)
}

fn full(side: usize) -> Rect {
    Rect {
        y0: 0,
        x0: 0,
        h: side,
        w: side,
    }
}

/// The filtered truth `H a` of an unfiltered footprint on the full frame.
fn filtered(side: usize, a: &[f32]) -> Vec<f32> {
    let mut out = vec![0.0f32; side * side];
    LocalFilter::new(flattener().sigma()).apply(side, side, a, &mut out);
    out
}

/// One noisy measurement of `truth` with per-pixel noise `se` (correlated
/// at 2 px): `(h, (h_A, h_B, s_A, s_B))`, the halves independent with twice
/// the variance and `h` their mean.
fn measure(truth: &[f32], se: f32, rng: &mut Lcg) -> (Vec<f32>, (Vec<f32>, Vec<f32>, f64, f64)) {
    measure_with(truth, se, rng, true)
}

/// [`measure`], with white noise when `!correlated`.
fn measure_with(
    truth: &[f32],
    se: f32,
    rng: &mut Lcg,
    correlated: bool,
) -> (Vec<f32>, (Vec<f32>, Vec<f32>, f64, f64)) {
    let side = (truth.len() as f64).sqrt() as usize;
    let s2 = se * std::f32::consts::SQRT_2;
    let noise = |rng: &mut Lcg| -> Vec<f32> {
        if correlated {
            corr_noise(side, rng)
        } else {
            (0..side * side).map(|_| rng.normal()).collect()
        }
    };
    let na = noise(rng);
    let nb = noise(rng);
    let ha: Vec<f32> = truth.iter().zip(&na).map(|(t, n)| t + s2 * n).collect();
    let hb: Vec<f32> = truth.iter().zip(&nb).map(|(t, n)| t + s2 * n).collect();
    let h = ha.iter().zip(&hb).map(|(a, b)| 0.5 * (a + b)).collect();
    (h, (ha, hb, f64::from(s2), f64::from(s2)))
}

/// Pixels of `set` farther than 1 px (8-neighbourhood) from `lobe`.
fn outside_lobe(side: usize, set: &[bool], lobe: &[bool]) -> usize {
    (0..side * side)
        .filter(|&p| {
            set[p] && {
                let (y, x) = ((p / side) as i64, (p % side) as i64);
                !(-1i64..=1).any(|dy| {
                    (-1i64..=1).any(|dx| {
                        let (yy, xx) = (y + dy, x + dx);
                        yy >= 0
                            && xx >= 0
                            && (yy as usize) < side
                            && (xx as usize) < side
                            && lobe[yy as usize * side + xx as usize]
                    })
                })
            }
        })
        .count()
}

/// The declared error rate holds in spatially correlated noise because the
/// inflation φ is measured from the halves: a planted cell's basin leaves
/// its true positive lobe (by more than 1 px) in at most 3 α of 200
/// constructions; with φ forced to 1 (identical halves) it leaves it in
/// most of them.
#[test]
fn basin_support_holds_the_declared_error_rate() {
    let side = 64;
    let mut slow = basin_loop(side);
    let alpha = f64::from(slow.cfg.support_alpha);
    let truth = filtered(side, &gauss(side, 32.0, 32.0, 2.5, 1.0, 12.0));
    let lobe: Vec<bool> = truth.iter().map(|&v| v > 0.0).collect();
    let (_, mask) = disk_mask(side, 32.0, 32.0, 24.0);
    let mut rng = Lcg(77);
    let reps = 200;
    let (mut bad, mut bad_phi1, mut phis) = (0, 0, Vec::new());
    for _ in 0..reps {
        let (h, halves) = measure(&truth, 1.0, &mut rng);
        let ms = slow
            .measured_support(full(side), &h, &mask, &halves, 1.0, None)
            .expect("the cell is significant");
        phis.push(ms.phi);
        bad += usize::from(outside_lobe(side, &ms.s0, &lobe) > 0);
        let same = (h.clone(), h.clone(), halves.2, halves.3);
        let m1 = slow
            .measured_support(full(side), &h, &mask, &same, 1.0, None)
            .unwrap();
        assert_eq!(m1.phi, 1.0);
        bad_phi1 += usize::from(outside_lobe(side, &m1.s0, &lobe) > 0);
    }
    phis.sort_by(f64::total_cmp);
    let limit = (3.0 * alpha * reps as f64).ceil() as usize;
    assert!(
        bad <= limit,
        "{bad} of {reps} constructions left the lobe (limit {limit}); phi median {}",
        phis[reps / 2]
    );
    assert!(
        bad_phi1 > reps / 2,
        "phi = 1: only {bad_phi1} of {reps} left the lobe"
    );
}

/// A cell with a faint scatter halo (0.04 of its peak, decaying over
/// 15 px): as frames accumulate (standard error ∝ 1 / sqrt(n)) the basin
/// support grows toward its limit, the part of the positive lobe of `H a*`
/// reached from the peak, and never leaves that fixed, finite set.
#[test]
fn support_converges_as_frames_accumulate() {
    let side = 128;
    let c = 64.0;
    let a: Vec<f32> = gauss(side, c, c, 2.5, 1.0, 20.0)
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            let (dy, dx) = ((i / side) as f32 - c, (i % side) as f32 - c);
            let r = (dy * dy + dx * dx).sqrt();
            v + 0.8 * (-r / 15.0).exp()
        })
        .collect();
    let truth = filtered(side, &a);
    let lobe: Vec<bool> = truth.iter().map(|&v| v > 0.0).collect();
    let mut slow = basin_loop(side);
    let mut basin = Vec::new();
    for n in [2_000.0f32, 8_000.0, 32_000.0, 128_000.0] {
        let se = 40.0 / n.sqrt();
        let mut rng = Lcg(5);
        let (h, halves) = measure(&truth, se, &mut rng);
        let (pix, _) = disk_mask(side, c, c, 48.0);
        let hp: Vec<f32> = pix.iter().map(|&g| h[g as usize]).collect();
        let ha: Vec<f32> = pix.iter().map(|&g| halves.0[g as usize]).collect();
        let hb: Vec<f32> = pix.iter().map(|&g| halves.1[g as usize]).collect();
        slow.support_tmp = Some((pix.clone(), ha, hb, halves.2, halves.3));
        let cell = slow
            .make_cell_global(1, &pix, &hp, None, Some(f64::from(se)))
            .unwrap();
        slow.support_tmp = None;
        let mut s = vec![false; side * side];
        for (&g, &v) in cell.pix.iter().zip(&cell.raw) {
            s[g as usize] = v > 0.0;
        }
        assert_eq!(outside_lobe(side, &s, &lobe), 0, "n {n}");
        basin.push(s.iter().filter(|&&v| v).count());
    }
    let n_lobe = lobe.iter().filter(|&&v| v).count();
    assert!(
        basin.windows(2).all(|w| w[0] <= w[1]) && basin[3] <= n_lobe,
        "basin sizes {basin:?}, lobe {n_lobe}"
    );
}

/// The skirt carries the faint light outside the support: on a halo cell,
/// the block-mean leftover `h − column` over the disk outside the support
/// is within noise, and significant for the same support without its skirt.
#[test]
fn skirt_blocks_carry_the_truncated_light() {
    let side = 96;
    let c = 48.0;
    let a: Vec<f32> = gauss(side, c, c, 2.5, 1.0, 20.0)
        .iter()
        .zip(gauss(side, c, c, 9.0, 1.0, 1.0))
        .map(|(&v, w)| v + w)
        .collect();
    let truth = filtered(side, &a);
    let mut slow = basin_loop(side);
    let b = slow.filter.moat().unwrap().0;
    let se = 0.2f32;
    let mut rng = Lcg(11);
    // White noise: a block sum then averages it down (8 px blocks).
    let (h, halves) = measure_with(&truth, se, &mut rng, false);
    let (pix, _) = disk_mask(side, c, c, 30.0);
    let pick = |v: &[f32]| -> Vec<f32> { pix.iter().map(|&g| v[g as usize]).collect() };
    slow.support_tmp = Some((
        pix.clone(),
        pick(&halves.0),
        pick(&halves.1),
        halves.2,
        halves.3,
    ));
    let skirted = slow
        .make_cell_global(1, &pix, &pick(&h), None, Some(f64::from(se)))
        .unwrap();
    assert!(!skirted.skirt_blk.is_empty());
    // The same support without a skirt.
    let mut raw = vec![0.0f32; side * side];
    for (&g, &v) in skirted.pix.iter().zip(&skirted.raw) {
        raw[g as usize] = v;
    }
    let bare = Cell::from_canvas(
        1,
        full(side),
        &raw,
        slow.dims,
        &slow.fov,
        &slow.cfg.library,
        Extent::Given,
        &mut slow.filter,
        &[],
    )
    .unwrap();
    let mut worst = Vec::new();
    for cell in [&bare, &skirted] {
        // The column's scale: least squares on the support.
        let (mut hc, mut cc) = (0.0f64, 0.0f64);
        for (&g, &v) in cell.pix.iter().zip(&cell.raw) {
            if v > 0.0 {
                let col = f64::from(cell.column_at(g, side, b));
                hc += f64::from(h[g as usize]) * col;
                cc += col * col;
            }
        }
        let k = hc / cc;
        // Leftover z of each moat block that lies wholly inside the disk
        // and outside the support.
        let mut z_max = 0.0f64;
        for by in 0..side / b {
            for bx in 0..side / b {
                let (mut sum, mut n, mut ok) = (0.0f64, 0usize, true);
                for y in by * b..(by + 1) * b {
                    for x in bx * b..(bx + 1) * b {
                        let g = (y * side + x) as u32;
                        let in_s = cell.pix.binary_search(&g).is_ok_and(|k| cell.raw[k] > 0.0);
                        ok &= pix.binary_search(&g).is_ok() && !in_s;
                        sum += f64::from(h[g as usize]) - k * f64::from(cell.column_at(g, side, b));
                        n += 1;
                    }
                }
                if ok {
                    let sd = f64::from(se) * (n as f64).sqrt();
                    z_max = z_max.max((sum / sd).abs());
                }
            }
        }
        worst.push(z_max);
    }
    assert!(worst[0] > 3.0, "no-skirt leftover max |z| {:.2}", worst[0]);
    assert!(worst[1] < 2.0, "skirt leftover max |z| {:.2}", worst[1]);
}

/// A second soma inside the statistics disk is other significant light:
/// it is neither in the support nor painted into the skirt, and it is
/// counted as a second peak.
#[test]
fn neighbour_light_is_not_skirt() {
    let side = 96;
    let a: Vec<f32> = gauss(side, 48.0, 44.0, 2.5, 1.0, 20.0)
        .iter()
        .zip(gauss(side, 48.0, 58.0, 2.5, 1.0, 20.0))
        .map(|(&v, w)| v + w)
        .collect();
    let truth = filtered(side, &a);
    let mut slow = basin_loop(side);
    let b = slow.filter.moat().unwrap().0;
    let mut rng = Lcg(3);
    let (h, halves) = measure(&truth, 0.5, &mut rng);
    let (pix, _) = disk_mask(side, 48.0, 44.0, 22.0);
    let pick = |v: &[f32]| -> Vec<f32> { pix.iter().map(|&g| v[g as usize]).collect() };
    // The current cell (the start): the first soma only.
    let start = skirt_cell(&[]);
    let mut start = start;
    start.pix = vec![(48 * side + 44) as u32];
    start.raw = vec![1.0];
    slow.support_tmp = Some((
        pix.clone(),
        pick(&halves.0),
        pick(&halves.1),
        halves.2,
        halves.3,
    ));
    let seconds = slow.basin_diag.1;
    let cell = slow
        .make_cell_global(1, &pix, &pick(&h), Some(&start), Some(0.5))
        .unwrap();
    assert_eq!(slow.basin_diag.1, seconds + 1, "second peak counted");
    let g2 = (48 * side + 58) as u32;
    assert!(
        cell.pix
            .binary_search(&g2)
            .map_or(true, |k| cell.raw[k] == 0.0),
        "the neighbour is not in the support"
    );
    let near =
        |g: u32| ((g as usize / side) as f32 - 48.0).hypot((g as usize % side) as f32 - 58.0);
    assert!(
        cell.pix
            .iter()
            .zip(&cell.raw)
            .all(|(&g, &v)| v == 0.0 || near(g) > 4.0),
        "no support pixel within 4 px of the neighbour"
    );
    // The neighbour's block carries (almost) none of its light.
    let bq = ((48 / b) * side.div_ceil(b) + 58 / b) as u32;
    let sk = cell
        .skirt_blk
        .binary_search(&bq)
        .map_or(0.0, |k| cell.skirt[k]);
    assert!(
        sk.abs() < 0.1,
        "skirt at the neighbour {sk} of the cell's peak"
    );
}

/// An elongated (2:1) single cell is one single-peaked basin: the support
/// keeps all but 2 % of its energy.
#[test]
fn elongated_single_cell_is_not_cut() {
    let side = 96;
    let a = gauss(side, 48.0, 48.0, 2.5, 2.0, 20.0);
    let truth = filtered(side, &a);
    let mut slow = basin_loop(side);
    let mut rng = Lcg(19);
    let (h, halves) = measure(&truth, 0.5, &mut rng);
    let (pix, _) = disk_mask(side, 48.0, 48.0, 24.0);
    let pick = |v: &[f32]| -> Vec<f32> { pix.iter().map(|&g| v[g as usize]).collect() };
    slow.support_tmp = Some((
        pix.clone(),
        pick(&halves.0),
        pick(&halves.1),
        halves.2,
        halves.3,
    ));
    let cell = slow
        .make_cell_global(1, &pix, &pick(&h), None, Some(0.5))
        .unwrap();
    let tot: f64 = a.iter().map(|&v| f64::from(v * v)).sum();
    let kept: f64 = cell
        .pix
        .iter()
        .zip(&cell.raw)
        .filter(|(_, &v)| v > 0.0)
        .map(|(&g, _)| f64::from(a[g as usize] * a[g as usize]))
        .sum();
    assert!(kept / tot > 0.98, "kept {:.4} of the energy", kept / tot);
}

/// The largest published support (positive pixels) of the loop's cells.
fn largest_support(slow: &SlowLoop) -> usize {
    slow.cells
        .iter()
        .map(|c| c.raw.iter().filter(|&&v| v > 0.0).count())
        .max()
        .unwrap_or(0)
}

/// Refinement-only passes over the same movie keep
/// the supports bounded: the refinements the later passes keep accepting
/// move the largest support up to a plateau (at most 15 % over pass 1,
/// and within 5 % over passes 5 to 7: no runaway, no oscillation), and
/// every statistics disk follows its support. (Here: 165 px after pass 1,
/// 178 to 185 px over passes 3 to 10. Under the old refine gate, z 3, it
/// was 179 px from pass 1 on and almost no refinement was accepted after.)
#[test]
fn refine_only_passes_keep_supports_bounded() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let (mut slow, mut eng) = start(shard_config(), &seed);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let pass1 = largest_support(&slow);
    let refines1 = slow.stats().refines;
    slow.set_edit_scope(EditScope::Refine);
    let mut later = Vec::new();
    for _ in 2..=7 {
        drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
        later.push(largest_support(&slow));
    }
    let s = slow.stats();
    assert!(s.refines > refines1, "{s:?}");
    let hi = *later.iter().max().unwrap();
    assert!(
        hi as f64 <= 1.15 * pass1 as f64,
        "largest support {pass1} -> {later:?}"
    );
    let late = &later[3..];
    let (lo, top) = (*late.iter().min().unwrap(), *late.iter().max().unwrap());
    assert!(
        (top - lo) as f64 <= 0.05 * lo as f64,
        "no plateau: largest support {pass1} -> {later:?}"
    );
    let margin = slow.cfg.stats_margin_cells * slow.cfg.cell_diameter_px;
    let lib = slow.finalize().unwrap();
    for (slot, id) in lib.ids().iter().enumerate() {
        if let Some(st) = slow.fpstats.get(id) {
            let r = lib.support(slot).1;
            assert!(
                st.radius <= r + 2.0 * margin + 1e-3,
                "disk {} for support {r}",
                st.radius
            );
        }
    }
}

/// When the outer light goes, the support follows: a cell seeded with a
/// footprint much wider than its light ends with a compact support (no
/// memory of the old extent).
#[test]
fn support_shrinks_when_light_goes() {
    let t = 3000;
    let mut rng = Lcg(41);
    let cells = vec![(blob(0, 48.0, 48.0), trace(&mut rng, t, 0.03, 6.0))];
    let m = movie(&cells, t, 43);
    let wide = blob_w(1, 48.0, 48.0, 6.0);
    let (mut slow, mut eng) = start(v2_config(), std::slice::from_ref(&wide));
    let before = largest_support(&slow);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let after = largest_support(&slow);
    assert!(slow.stats().refines > 0, "{:?}", slow.stats());
    assert!(
        (after as f64) < 0.6 * before as f64,
        "support {before} -> {after}"
    );
}

/// Visits run as jobs give the same libraries as `step` (the halves and
/// the skirts cross the wire).
#[test]
fn basin_skirt_visits_run_as_jobs_match_step_exactly() {
    let t = 1200;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        a.observe(f, &la, &ta).unwrap();
        b.observe(f, &lb, &tb).unwrap();
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step_via(5_000_000, &mut runner).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    let s = a.stats();
    assert!(s.refines > 0, "{s:?}");
    assert_eq!(s, b.stats());
    let lib = a.finalize().unwrap();
    assert!(
        (0..lib.len()).any(|s| !lib.skirt(s).0.is_empty()),
        "some cell carries a skirt"
    );
    assert!(lib.to_bytes()[16..] == b.finalize().unwrap().to_bytes()[16..]);
}

/// The split-half refine gate still refines (cells move off their seed
/// footprints) and runs identically as jobs and in `step`.
#[test]
fn split_half_refine_gate_refines_and_matches_jobs() {
    let t = 1200;
    let (m, seed) = busy_movie(t);
    let cfg = SlowLoopConfig {
        refine_gate: RefineGate::SplitHalf,
        ..shard_config()
    };
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        a.observe(f, &la, &ta).unwrap();
        b.observe(f, &lb, &tb).unwrap();
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step_via(5_000_000, &mut runner).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    let s = a.stats();
    assert!(s.refines > 0, "{s:?}");
    assert_eq!(s, b.stats());
}

/// The app's path (`TraceEngine.processFrames` + `lastBackground` in the
/// fast worker, one frame's slice to `SlowLoop.observe` in the slow worker)
/// leaves the slow loop in exactly the state the native `observe` with the
/// engine's `FrameTraces` does; without the levels it does not.
#[cfg(feature = "jsbindings")]
#[test]
fn js_observe_with_background_levels_matches_native() {
    use crate::trace::js::{JsTraceEngine, JsTraceLibrary};
    let t = 600;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    assert!(matches!(cfg.background, BackgroundModel::Ring { .. }));
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    // The JS surface, levels passed (b) and dropped as the app used to (c).
    let js = |cfg: &SlowLoopConfig| {
        let (s, e) = start(cfg.clone(), &seed);
        let lib = e.library().clone();
        let params = crate::params::js::ResolvedParams::new(
            crate::params::CalaParams::default(),
            crate::params::resolve::Context {
                fps: Some(20.0),
                frame: [N as u32, N as u32],
            },
        )
        .unwrap();
        let eng = JsTraceEngine::new(&JsTraceLibrary::from_arc(lib.clone()), &params).unwrap();
        (super::js::JsSlowLoop::from_parts(s, lib, None), eng)
    };
    let (mut b, mut eb) = js(&cfg);
    let (mut c, mut ec) = js(&cfg);
    let mut published = 0;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let ta = ea.process(f).unwrap();
        let la = ea.library().clone();
        assert_eq!(ta.background.len(), la.len(), "ring: one level per cell");
        a.observe(f, &la, &ta).unwrap();
        for (js, eng, levels) in [(&mut b, &mut eb, true), (&mut c, &mut ec, false)] {
            let tr = eng.process_frames(f, 1).unwrap();
            let bg = eng.last_background();
            assert_eq!(bg.len(), eng.inner.library().background_len());
            let version = eng.inner.library().version() as f64;
            assert!(js
                .observe(f, version, &tr, levels.then_some(bg), None)
                .unwrap());
        }
        assert_eq!(eb.out.traces, ta.traces, "frame {k}");
        assert_eq!(eb.last_background(), ta.background, "frame {k}");
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step(5_000_000.0).unwrap();
        let pc = c.step(5_000_000.0).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            // Past the header: versions come from a global counter.
            assert!(
                la.to_bytes()[16..] == lb.arc().to_bytes()[16..],
                "frame {k}"
            );
            ea.set_library(la).unwrap();
            eb.set_library(&lb).unwrap();
            published += 1;
        }
        if let Some(lc) = pc {
            ec.set_library(&lc).unwrap();
        }
    }
    assert!(published > 0);
    let bits = |s: &SlowLoop| -> Vec<(u64, u32, u32, u32)> {
        s.debug_ledger()
            .into_iter()
            .map(|(id, x, y, z)| (id, x.to_bits(), y.to_bits(), z.to_bits()))
            .collect()
    };
    assert_eq!(a.stats(), b.inner().stats());
    assert_eq!(bits(&a), bits(b.inner()));
    assert_ne!(bits(&a), bits(c.inner()), "the levels matter");
}

// ---- Run stages: the Refine replay (apps/cala/docs/stages.md) ---------------

/// The structural counters a refine replay must leave alone.
fn structural(s: &SlowStats) -> (u64, u64, u64, u64, u64, u64) {
    (
        s.adds,
        s.absorbs,
        s.merges,
        s.splits,
        s.deletes,
        s.keep_tests,
    )
}

#[test]
fn edit_scope_names_round_trip() {
    for s in EditScope::ALL {
        assert_eq!(EditScope::from_name(s.name()), Some(s));
        assert_eq!(EditScope::from_code(s.code()), Some(s));
    }
    assert_eq!(EditScope::from_name("refine"), Some(EditScope::Refine));
    assert_eq!(EditScope::from_name("discover"), None);
    assert_eq!(EditScope::from_code(4), None);
}

/// A Refine run as qc_eval's `--later-passes refine` makes it on a
/// `SlowLoop` (the reference): Discover over the movie, the final library
/// to the fast loop, the `refine` scope, then `refines` more passes from
/// frame 0. Returns the bytes (past the version) of every published library
/// of the Refine passes and of each pass's final library.
///
/// The traces go with the engine's ring-background levels, as the app's
/// wire carries them (and as qc_eval passes the engine's `FrameTraces`).
fn refine_reference(m: &[f32], t: usize, seed: &[Footprint], refines: usize) -> Vec<Vec<u8>> {
    let n_px = N * N;
    let (mut slow, mut eng) = start(shard_config(), seed);
    let mut out = Vec::new();
    let pass = |slow: &mut SlowLoop, eng: &mut TraceEngine, out: &mut Vec<Vec<u8>>, keep: bool| {
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            // The engine's ring levels go along, as the app sends them.
            let mut tr = eng.process(f).unwrap();
            tr.frame_index = slow.frames();
            let lib = eng.library().clone();
            slow.observe(f, &lib, &tr).unwrap();
            if let Some(l) = slow.step(5_000_000).unwrap() {
                if keep {
                    out.push(l.to_bytes()[16..].to_vec());
                }
                eng.set_library(l).unwrap();
            }
        }
        let lib = slow.finalize().unwrap();
        out.push(lib.to_bytes()[16..].to_vec());
        eng.set_library(lib).unwrap();
    };
    pass(&mut slow, &mut eng, &mut out, false);
    slow.set_edit_scope(EditScope::Refine);
    for _ in 0..refines {
        pass(&mut slow, &mut eng, &mut out, true);
    }
    out
}

/// The same through the app's JS `SlowLoop` surface: `observe` by library
/// version, `step`, `finalize`, `setEditScope("refine")`. Also returns the
/// structural counters after Discover and after the last Refine.
#[cfg(feature = "jsbindings")]
#[allow(clippy::type_complexity)]
fn refine_js(
    m: &[f32],
    t: usize,
    seed: &[Footprint],
    refines: usize,
) -> (
    Vec<Vec<u8>>,
    (u64, u64, u64, u64, u64, u64),
    (u64, u64, u64, u64, u64, u64),
    Vec<u64>,
    Vec<u64>,
) {
    use super::js::JsSlowLoop;
    let n_px = N * N;
    let (slow, mut eng) = start(shard_config(), seed);
    let mut js = JsSlowLoop::from_parts(slow, eng.library().clone(), None);
    let feed = |js: &mut JsSlowLoop, eng: &mut TraceEngine, out: &mut Vec<Vec<u8>>, keep: bool| {
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let tr = eng.process(f).unwrap();
            let v = eng.library().version() as f64;
            assert!(
                js.observe(f, v, &tr.traces, Some(tr.background.clone()), None)
                    .unwrap(),
                "frame {k}: version {v}"
            );
            if let Some(l) = js.step(5_000_000.0).unwrap() {
                if keep {
                    out.push(l.arc().to_bytes()[16..].to_vec());
                }
                eng.set_library(l.arc().clone()).unwrap();
            }
        }
    };
    let mut out = Vec::new();
    feed(&mut js, &mut eng, &mut out, false);
    let lib = js.finalize().unwrap();
    out.push(lib.arc().to_bytes()[16..].to_vec());
    eng.set_library(lib.arc().clone()).unwrap();
    let after_discover = structural(&js.inner().stats());
    let ids_discover: Vec<u64> = js.inner().cell_infos().iter().map(|c| c.id).collect();
    js.set_edit_scope("refine").unwrap();
    assert_eq!(js.inner().edit_scope().name(), "refine");
    for _ in 0..refines {
        feed(&mut js, &mut eng, &mut out, true);
        let lib = js.finalize().unwrap();
        out.push(lib.arc().to_bytes()[16..].to_vec());
        eng.set_library(lib.arc().clone()).unwrap();
    }
    let after_refine = structural(&js.inner().stats());
    let ids_refine: Vec<u64> = js.inner().cell_infos().iter().map(|c| c.id).collect();
    (out, after_discover, after_refine, ids_discover, ids_refine)
}

/// Refine replays through the JS surface: no adds, absorbs, merges,
/// splits, keep tests or deletions; footprints still change; the same
/// libraries as the reference (qc_eval's later refine passes), bit for bit;
/// and the same again on a second run (deterministic).
#[cfg(feature = "jsbindings")]
#[test]
fn js_refine_replay_is_refine_only_deterministic_and_matches_qc_eval() {
    // Long enough for a refine publish in the replays: with the ring levels
    // taken off the statistics, 1500 frames give none.
    let t = 2400;
    let (m, seed) = busy_movie(t);
    let (js, s_discover, s_refine, ids_discover, ids_refine) = refine_js(&m, t, &seed, 2);
    assert_eq!(s_discover, s_refine, "structural edits in a Refine run");
    assert_eq!(ids_discover, ids_refine, "the cell set changed");
    // Discover's final library, then at least one refine publish.
    assert!(js.len() > 3, "{} libraries", js.len());
    assert!(
        js[1..].iter().any(|b| *b != js[0]),
        "Refine changed no footprint"
    );
    let reference = refine_reference(&m, t, &seed, 2);
    assert_eq!(js.len(), reference.len());
    for (k, (a, b)) in js.iter().zip(&reference).enumerate() {
        assert!(a == b, "library {k} differs from the reference");
    }
    let (again, ..) = refine_js(&m, t, &seed, 2);
    assert!(again == js, "a second run differs");
}

/// With visit workers the scope travels in the job: a refine replay whose
/// visits run as jobs (`step_via`) matches the in-process one exactly, and
/// makes no structural edit.
#[test]
fn refine_scope_travels_with_visit_jobs() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let (mut a, mut ea) = start(cfg.clone(), &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut a, &mut ea, &mut deleted);
    drive(&m, 0..t, &mut b, &mut eb, &mut deleted);
    let before = structural(&a.stats());
    let ids: Vec<u64> = a.cell_infos().iter().map(|c| c.id).collect();
    a.set_edit_scope(EditScope::Refine);
    b.set_edit_scope(EditScope::Refine);
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        a.observe(f, &la, &ta).unwrap();
        b.observe(f, &lb, &tb).unwrap();
        let pa = a.step(5_000_000).unwrap();
        let pb = b.step_via(5_000_000, &mut runner).unwrap();
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    assert_eq!(structural(&b.stats()), before);
    assert_eq!(b.cell_infos().iter().map(|c| c.id).collect::<Vec<_>>(), ids);
    assert!(b.stats().refines > 0);
    assert!(a.finalize().unwrap().to_bytes()[16..] == b.finalize().unwrap().to_bytes()[16..]);
}

/// With visit workers, Refine makes the visits that would not refine at
/// hand-out instead of as jobs (`SlowLoop::skip_unused`). The footprints
/// are the same, bit for bit, with and without the skip (one worker whose
/// results come back at once), and about half the visits go out as jobs.
#[test]
fn refine_makes_idle_visits_at_hand_out_without_changing_footprints() {
    let t = 2400;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    // Discover, then two Refine runs with every visit through `take_job_bytes`.
    let run = |skip: bool| -> (Vec<Vec<u8>>, u64, u64) {
        let (mut s, mut eng) = start(cfg.clone(), &seed);
        drive(&m, 0..t, &mut s, &mut eng, &mut Vec::new());
        let lib = s.finalize().unwrap();
        let mut out = vec![lib.to_bytes()[16..].to_vec()];
        eng.set_library(lib).unwrap();
        s.skip_unused = skip;
        s.set_edit_scope(EditScope::Refine);
        let mut runner = VisitRunner::new(new_loop(&cfg));
        let (visits0, mut jobs) = (s.stats().visits, 0);
        for _ in 0..2 {
            for k in 0..t {
                let f = &m[k * n_px..(k + 1) * n_px];
                let tr = eng.process(f).unwrap();
                let lib = eng.library().clone();
                s.observe(f, &lib, &tr).unwrap();
                while let Some(b) = s.take_job_bytes() {
                    let r = runner.run(VisitJob::from_bytes(&b).unwrap()).unwrap();
                    s.apply_job(VisitResult::from_bytes(&r.to_bytes()).unwrap())
                        .unwrap();
                    jobs += 1;
                }
                if let Some(l) = s.housekeep().unwrap() {
                    out.push(l.to_bytes()[16..].to_vec());
                    eng.set_library(l).unwrap();
                }
            }
            let l = s.finalize().unwrap();
            out.push(l.to_bytes()[16..].to_vec());
            eng.set_library(l).unwrap();
        }
        (out, jobs, s.stats().visits - visits0)
    };
    let (a, jobs_a, visits_a) = run(true);
    let (b, jobs_b, visits_b) = run(false);
    assert!(a.len() > 3, "{} libraries", a.len());
    assert!(
        a[1..].iter().any(|x| *x != a[0]),
        "Refine changed no footprint"
    );
    assert_eq!(a.len(), b.len());
    for (k, (x, y)) in a.iter().zip(&b).enumerate() {
        assert!(x == y, "library {k} differs with the skip");
    }
    assert_eq!(visits_a, visits_b);
    assert_eq!(jobs_b, visits_b);
    assert!(
        jobs_a * 3 < jobs_b * 2,
        "{jobs_a} of {jobs_b} visits went out as jobs"
    );
}

/// `take_job_bytes` (one counted, exactly sized pass that reads the random
/// slots straight from the owner's shared store) gives the bytes the plain
/// path gives for the same job: decoded, the job carries its own copy of
/// every slot, and `to_bytes` writes those. Every job of a Discover and a
/// Refine run. (The bulk writers against element-by-element bytes:
/// `wire::tests`.)
#[test]
fn take_job_bytes_equal_the_plain_encoding() {
    let t = 900;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let (mut s, mut eng) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    let mut jobs = [0usize; 2];
    let mut shared = 0;
    for (pass, scope) in [EditScope::All, EditScope::Refine].into_iter().enumerate() {
        s.set_edit_scope(scope);
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let tr = eng.process(f).unwrap();
            let lib = eng.library().clone();
            s.observe(f, &lib, &tr).unwrap();
            while let Some(x) = s.take_job_bytes() {
                let job = VisitJob::from_bytes(&x).unwrap();
                // The owner's random slots carry no patch: the job's come from the shared store.
                let ti = job.tile_index();
                shared += s.tiles[ti]
                    .randoms
                    .iter()
                    .filter(|r| r.data.is_empty())
                    .count();
                assert!(
                    x == job.to_bytes(),
                    "pass {pass} frame {k}: job bytes differ"
                );
                let r = runner.run(job).unwrap().to_bytes();
                s.apply_job(VisitResult::from_bytes(&r).unwrap()).unwrap();
                jobs[pass] += 1;
            }
            if let Some(l) = s.housekeep().unwrap() {
                eng.set_library(l).unwrap();
            }
        }
    }
    assert!(jobs[0] > 0 && jobs[1] > 0, "jobs per run: {jobs:?}");
    assert!(shared > 0, "no job read random slots from the shared store");
}

/// The split-half merge statistic: two independent neighbours (supports
/// overlapping, 7 px apart) have measured shapes that differ far beyond
/// their split-half noise (`Î > 0`, the rule keeps them apart), while a
/// cell compared with itself is within its noise (`Î ≤ 0`).
#[test]
fn merge_shape_excess_tells_neighbours_from_one_cell() {
    let t = 2000;
    let mut rng = Lcg(71);
    let cells = vec![
        (blob(0, 45.0, 44.0), trace(&mut rng, t, 0.03, 6.0)),
        (blob(1, 49.0, 50.0), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 73);
    let cfg = SlowLoopConfig {
        merge_rule: MergeRule::SplitHalf,
        ..v2_config()
    };
    let (mut slow, mut eng) = start(cfg, &[blob(1, 45.0, 44.0), blob(2, 49.0, 50.0)]);
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    assert_eq!(slow.stats().merges, 0, "stats {:?}", slow.stats());
    let a = slow.cells.iter().find(|c| c.id == 1).unwrap().clone();
    let b = slow.cells.iter().find(|c| c.id == 2).unwrap().clone();
    let two = slow.merge_shape_excess(&a, &b).expect("split halves");
    assert!(two > 0.0, "neighbours: {two}");
    let one = slow.merge_shape_excess(&a, &a).expect("split halves");
    assert!(one <= 0.0, "a cell against itself: {one}");
}

/// Either merge rule runs identically as jobs and in `step` (the default,
/// `MergeRule::SplitHalf`, and `MergeRule::Legacy`).
#[test]
fn merge_rules_match_jobs() {
    let t = 1200;
    let (m, seed) = busy_movie(t);
    for rule in [MergeRule::Legacy, MergeRule::SplitHalf] {
        let cfg = SlowLoopConfig {
            merge_rule: rule,
            ..shard_config()
        };
        let n_px = N * N;
        let (mut a, mut ea) = start(cfg.clone(), &seed);
        let (mut b, mut eb) = start(cfg.clone(), &seed);
        let mut runner = VisitRunner::new(new_loop(&cfg));
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
            let (la, lb) = (ea.library().clone(), eb.library().clone());
            a.observe(f, &la, &ta).unwrap();
            b.observe(f, &lb, &tb).unwrap();
            let pa = a.step(5_000_000).unwrap();
            let pb = b.step_via(5_000_000, &mut runner).unwrap();
            assert_eq!(pa.is_some(), pb.is_some(), "{rule:?} frame {k}");
            if let (Some(la), Some(lb)) = (pa, pb) {
                assert!(
                    la.to_bytes()[16..] == lb.to_bytes()[16..],
                    "{rule:?} frame {k}"
                );
                ea.set_library(la).unwrap();
                eb.set_library(lb).unwrap();
            }
        }
        let s = a.stats();
        assert!(s.merge_tests > 0, "{rule:?} {s:?}");
        assert_eq!(s, b.stats(), "{rule:?}");
    }
}

// ---- refine gate: a footprint born without its neighbour-side light ------

/// Peak-normalised unfiltered footprint value of `id` at pixel (y, x).
fn fp_at(lib: &Library, id: u64, y: usize, x: usize) -> f32 {
    let (px, v) = lib.unfiltered(lib.slot(id).expect("cell kept"));
    let peak = v.iter().cloned().fold(0.0f32, f32::max);
    let k = (y * N + x) as u32;
    px.iter().position(|&p| p == k).map_or(0.0, |i| v[i] / peak)
}

/// Two neighbours 3.5 px apart (about 0.6 soma diameters at half max),
/// independent activity. The second cell is seeded with a hole at the
/// first cell's centre, as Discover births a close newcomer (no light
/// where the older cell already explains the data). Returns the second
/// cell's footprint value there (truth exp(-3.5²/(2·2.5²)) ≈ 0.38) after
/// 4000 frames with refine gate `z`, and the number of refinements.
fn bitten_refill(z: f32) -> (f32, u64) {
    let (v, refines, _) = bitten_refill_with(z, JointUpdate::Off);
    (v, refines)
}

/// [`bitten_refill`] with the joint update `joint`, in the Refine scope
/// (the cell set frozen, as the app's Refine stage), also returning the
/// joint update's counters.
fn bitten_refill_with(z: f32, joint: JointUpdate) -> (f32, u64, ReplayStats) {
    let t = 4000;
    let mut rng = Lcg(411);
    let (a, b) = ((46.0, 44.0), (46.0, 47.5));
    let cells = vec![
        (blob_w(0, a.0, a.1, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        (blob_w(1, b.0, b.1, 2.5), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 423);
    let mut bitten = blob_w(2, b.0, b.1, 2.5);
    for y in 0..bitten.height {
        for x in 0..bitten.width {
            let (dy, dx) = ((bitten.y0 + y) as f32 - a.0, (bitten.x0 + x) as f32 - a.1);
            if dy * dy + dx * dx <= 2.5 * 2.5 {
                bitten.values[y * bitten.width + x] = 0.0;
            }
        }
    }
    let cfg = SlowLoopConfig {
        refine_z: z,
        joint_update: joint,
        ..v2_config()
    };
    let (mut slow, mut eng) = start(cfg, &[blob_w(1, a.0, a.1, 2.5), bitten]);
    if joint != JointUpdate::Off {
        slow.set_edit_scope(EditScope::Refine);
    }
    let mut deleted = Vec::new();
    drive(&m, 0..t, &mut slow, &mut eng, &mut deleted);
    let lib = slow.finalize().unwrap();
    assert_eq!(lib.ids(), &[1, 2], "stats {:?}", slow.stats());
    (
        fp_at(&lib, 2, a.0 as usize, a.1 as usize),
        slow.stats().refines,
        slow.replay_stats,
    )
}

/// The cluster history replay ([`JointUpdate::Refine`]) refills the
/// bitten footprint too, from the two cells' joint proposals.
#[test]
fn a_bitten_footprint_is_refilled_by_the_cluster_replay() {
    let (v, refines, rs) = bitten_refill_with(0.0, JointUpdate::Refine);
    assert!(rs.clusters >= 1 && rs.replays > 0, "{rs:?}");
    assert!(rs.accepted > 0, "{rs:?}");
    assert!(
        v > 0.1,
        "value at the neighbour centre {v} (truth 0.38), {refines} refines, {rs:?}"
    );
}

/// The refine gate accepts a statistics-path refill with a positive
/// held-out gain: the bitten footprint takes up light at its neighbour's
/// centre. Under the old gate (paired z > 3 on the held-out frames) the
/// same proposals are vetoed and the hole stays.
#[test]
fn a_bitten_footprint_is_refilled_from_its_statistics() {
    let (now, refines) = bitten_refill(SlowLoopConfig::default().refine_z);
    let (old, _) = bitten_refill(3.0);
    assert!(
        now > 0.1,
        "value at the neighbour centre {now} (truth 0.38), {refines} refines"
    );
    assert!(old < 0.05 && now > old + 0.1, "new {now}, old gate {old}");
}

/// The cluster history replay runs when the refine visits run as jobs
/// (`step_via`, through the byte encoding of job and result): the same
/// libraries as in process, frame by frame, the same joint-update
/// counters, and the replay really happens in the runner (the stores
/// travel in the job; the visit no longer falls back to the per-cell path).
#[test]
fn the_cluster_replay_runs_in_visit_jobs_and_matches_step() {
    for carry in [false, true] {
        let t = 4000;
        let mut rng = Lcg(411);
        let (a, b) = ((46.0, 44.0), (46.0, 47.5));
        let cells = vec![
            (blob_w(0, a.0, a.1, 2.5), trace(&mut rng, t, 0.03, 6.0)),
            (blob_w(1, b.0, b.1, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        ];
        let m = movie(&cells, t, 423);
        let mut bitten = blob_w(2, b.0, b.1, 2.5);
        for y in 0..bitten.height {
            for x in 0..bitten.width {
                let (dy, dx) = ((bitten.y0 + y) as f32 - a.0, (bitten.x0 + x) as f32 - a.1);
                if dy * dy + dx * dx <= 2.5 * 2.5 {
                    bitten.values[y * bitten.width + x] = 0.0;
                }
            }
        }
        let cfg = SlowLoopConfig {
            refine_z: 0.0,
            joint_update: JointUpdate::Refine,
            joint_carry: carry,
            ..v2_config()
        };
        let seed = [blob_w(1, a.0, a.1, 2.5), bitten];
        let (mut sa, mut ea) = start(cfg.clone(), &seed);
        let (mut sb, mut eb) = start(cfg.clone(), &seed);
        let mut runner = VisitRunner::new(new_loop(&cfg));
        sa.set_edit_scope(EditScope::Refine);
        sb.set_edit_scope(EditScope::Refine);
        let n_px = N * N;
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
            let (la, lb) = (ea.library().clone(), eb.library().clone());
            sa.observe(f, &la, &ta).unwrap();
            sb.observe(f, &lb, &tb).unwrap();
            let pa = sa.step(5_000_000).unwrap();
            let pb = sb.step_via(5_000_000, &mut runner).unwrap();
            assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
            if let (Some(la), Some(lb)) = (pa, pb) {
                assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
                ea.set_library(la).unwrap();
                eb.set_library(lb).unwrap();
            }
        }
        let (ra, rb) = (sa.replay_stats, sb.replay_stats);
        assert!(ra.replays > 0 && ra.accepted > 0, "{ra:?}");
        assert_eq!(ra.visit_fields(), rb.visit_fields(), "{ra:?} vs {rb:?}");
        assert!(rb.job_stores > 0 && rb.job_store_bytes > 0, "{rb:?}");
        assert!(sa.finalize().unwrap().to_bytes()[16..] == sb.finalize().unwrap().to_bytes()[16..]);
    }
}

/// A live stream with `?factors` runs Discover with `JointUpdate::Refine`:
/// in Discover's own scope that must publish exactly what `Off` publishes
/// (the store accumulates only in refine-scope visits).
#[test]
fn joint_update_refine_leaves_discover_unchanged() {
    let t = 3000;
    let mut rng = Lcg(97);
    let cells = vec![
        (blob_w(0, 30.0, 30.0, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        (blob_w(1, 30.0, 33.5, 2.5), trace(&mut rng, t, 0.03, 6.0)),
        (blob_w(2, 60.0, 50.0, 2.5), trace(&mut rng, t, 0.03, 6.0)),
    ];
    let m = movie(&cells, t, 211);
    let with = |ju: JointUpdate| SlowLoopConfig {
        joint_update: ju,
        ..v2_config()
    };
    let (mut sa, mut ea) = start(with(JointUpdate::Off), &[]);
    let (mut sb, mut eb) = start(with(JointUpdate::Refine), &[]);
    let n_px = N * N;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        let (la, lb) = (ea.library().clone(), eb.library().clone());
        sa.observe(f, &la, &ta).unwrap();
        sb.observe(f, &lb, &tb).unwrap();
        let (pa, pb) = (sa.step(5_000_000).unwrap(), sb.step(5_000_000).unwrap());
        assert_eq!(pa.is_some(), pb.is_some(), "frame {k}");
        if let (Some(la), Some(lb)) = (pa, pb) {
            assert!(la.to_bytes()[16..] == lb.to_bytes()[16..], "frame {k}");
            ea.set_library(la).unwrap();
            eb.set_library(lb).unwrap();
        }
    }
    assert!(sa.finalize().unwrap().to_bytes()[16..] == sb.finalize().unwrap().to_bytes()[16..]);
    assert_eq!(sb.replay_stats.replays, 0, "{:?}", sb.replay_stats);
}

/// Look-back frames (concurrent Refine) reach only the named cells'
/// running statistics, keep held-out frames out and leave the slow loop's
/// frame clock alone.
#[test]
fn lookback_frames_feed_only_the_named_cells_statistics() {
    let t = 200;
    let mut rng = Lcg(5);
    let cells = vec![
        (blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0)),
        (blob(1, 70.0, 70.0), trace(&mut rng, t, 0.05, 6.0)),
    ];
    let m = movie(&cells, t, 7);
    let seed: Vec<Footprint> = cells.iter().map(|(f, _)| f.clone()).collect();
    let (mut slow, mut eng) = start(config(), &seed);
    let lib = eng.library().clone();
    let (a, b) = (lib.ids()[0], lib.ids()[1]);
    let n_px = N * N;
    let mut fitted = 0;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let fit = slow
            .observe_lookback(f, &lib, &tr, k as u64, Some(&[a]))
            .unwrap();
        assert_eq!(fit, !slow.is_test(k as u64));
        fitted += usize::from(fit);
    }
    assert!(fitted > 0 && fitted < t);
    assert_eq!(slow.frames(), 0);
    assert!(slow.fpstats.contains_key(&a));
    assert!(!slow.fpstats.contains_key(&b));
}

/// With the reservoir frozen (evaluation switch), `observe` still feeds
/// the statistics and advances the frame clock but stores no frame and
/// makes no tile due; unfrozen, it stores frames again.
#[test]
fn frozen_reservoir_takes_no_frames_but_statistics_and_clock_run() {
    let t = 60;
    let mut rng = Lcg(5);
    let cells = vec![(blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0))];
    let m = movie(&cells, t, 7);
    let seed: Vec<Footprint> = cells.iter().map(|(f, _)| f.clone()).collect();
    let (mut slow, mut eng) = start(config(), &seed);
    let lib = eng.library().clone();
    let n_px = N * N;
    slow.set_reservoir_frozen(true);
    for k in 0..t / 2 {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        slow.observe(f, &lib, &tr).unwrap();
    }
    assert_eq!(slow.frames(), (t / 2) as u64);
    assert!(slow.fpstats.contains_key(&lib.ids()[0]));
    assert_eq!(slow.reservoir_bytes(), 0);
    assert!(slow.tiles.iter().all(|tile| tile.fresh == 0));
    slow.set_reservoir_frozen(false);
    for k in t / 2..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        slow.observe(f, &lib, &tr).unwrap();
    }
    assert_eq!(slow.frames(), t as u64);
    assert!(slow.reservoir_bytes() > 0);
}

// ---- look-back scheduler (`lookback.rs`) ----------------------------------

fn lb_lib(version: u64, cells: &[Footprint]) -> Library {
    let mut b = LibraryBuilder::new(dims()).version(version);
    for c in cells {
        b = b.footprint(c.clone());
    }
    b.build(&mut flattener()).unwrap()
}

/// Drain every request the scheduler makes with `credit` frames of budget:
/// (frame, ids) per request, every one observed.
fn lb_take(lb: &mut LookBack, sl: &SlowLoop, lib: &Library, credit: f64) -> Vec<(usize, Vec<u64>)> {
    lb.add_credit(credit);
    let mut out = Vec::new();
    while let LookbackNext::Frame(r) = lb.next(sl, lib) {
        out.push((r.frame, r.ids));
        lb.frame_done(LookbackOutcome::Observed);
    }
    out
}

/// A birth asks for the `K` frames before it, for the newborn and the cells
/// touching it only, block by block and within the budget; the scheduler
/// idles (budget not banked) when no cell needs anything.
#[test]
fn lookback_serves_a_birth_and_its_neighbours_the_frames_before_it() {
    let (slow, _) = start(config(), &[]);
    let (a, far, c) = (
        blob(1, 30.0, 30.0),
        blob(2, 75.0, 75.0),
        blob(3, 33.0, 31.0),
    );
    let mut lb = LookBack::new(LookbackConfig {
        max_frames: 100,
        ..LookbackConfig::default()
    });
    // The first library: its cells are births at frame 10 (window 0..10).
    let lib1 = lb_lib(1, &[a.clone(), far.clone()]);
    lb.note_frame(&lib1, 10);
    assert_eq!(lb.births(), 2);
    let got = lb_take(&mut lb, &slow, &lib1, 1000.0);
    assert_eq!(got.len(), 10);
    assert!(got.iter().enumerate().all(|(k, (f, _))| *f == k));
    assert_eq!(lb.next(&slow, &lib1), LookbackNext::Idle);
    // Idle budget is not banked: at most one frame's credit is kept.
    assert_eq!(lb_take(&mut lb, &slow, &lib1, 500.0), vec![]);

    // A cell born at frame 300 beside `a`: it and `a` need 200..300, `far`
    // nothing.
    let lib2 = lb_lib(2, &[a, far, c]);
    lb.note_frame(&lib2, 300);
    assert_eq!(lb.births(), 3);
    let (ia, ic) = (lib2.ids()[0], lib2.ids()[2]);
    let got = lb_take(&mut lb, &slow, &lib2, 30.0);
    assert_eq!(got.len(), 31, "budget-limited (30 + the one kept)");
    let mut got2 = got;
    got2.extend(lb_take(&mut lb, &slow, &lib2, 1000.0));
    let mut frames: Vec<usize> = got2.iter().map(|g| g.0).collect();
    frames.sort_unstable();
    assert_eq!(frames, (200..300).collect::<Vec<_>>());
    for (_, ids) in &got2 {
        let mut ids = ids.clone();
        ids.sort_unstable();
        assert_eq!(ids, vec![ia.min(ic), ia.max(ic)]);
    }
    // Shared order: the most recent block (256..300) is served first.
    assert_eq!(got2[0].0, 256);
    assert_eq!(lb.in_need(), 0);
    assert_eq!(lb.frames(), 110);
}

/// A cell dropped from the library stops taking frames; a block whose cells
/// are all gone ends.
#[test]
fn lookback_drops_cells_no_longer_in_the_library() {
    let (slow, _) = start(config(), &[]);
    let mut lb = LookBack::new(LookbackConfig::default());
    let lib1 = lb_lib(1, &[blob(1, 30.0, 30.0)]);
    lb.note_frame(&lib1, 200);
    let first = lb_take(&mut lb, &slow, &lib1, 3.0);
    assert_eq!(first.len(), 3);
    let empty = lb_lib(2, &[]);
    lb.note_frame(&empty, 201);
    assert_eq!(lb_take(&mut lb, &slow, &empty, 1000.0), vec![]);
    assert_eq!(lb.in_need(), 0);
}

/// The held-out record returns the decision `observe` made for each stream
/// frame the slow loop saw (whatever its slow-loop index), and the
/// `u64::MAX - stream` decision for frames it never saw; the flagged
/// look-back observe is the indexed one with that decision.
#[test]
fn held_out_record_keeps_observes_decisions_and_flagged_lookback_matches() {
    let (slow, _) = start(config(), &[]);
    let mut rec = HeldOutRecord::default();
    // Stream frames 100..400 seen as slow frames 0..300 except a dropped
    // batch 200..216.
    let mut k = 0u64;
    for s in 100..400u64 {
        if (200..216).contains(&s) {
            continue;
        }
        rec.note(s, k, &slow);
        k += 1;
    }
    let mut k = 0u64;
    for s in 0..500u64 {
        let seen = (100..400).contains(&s) && !(200..216).contains(&s);
        let want = if seen {
            slow.is_test(k)
        } else {
            slow.is_test(u64::MAX - s)
        };
        assert_eq!(rec.held_out(s, &slow), want, "stream {s}");
        k += u64::from(seen);
    }
    let held = (0..500).filter(|&s| rec.held_out(s, &slow)).count();
    assert!(held > 100 && held < 250, "{held}");

    // Flagged == indexed.
    let t = 120;
    let mut rng = Lcg(9);
    let cells = vec![(blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0))];
    let m = movie(&cells, t, 3);
    let seed: Vec<Footprint> = cells.iter().map(|(f, _)| f.clone()).collect();
    let (mut sa, mut eng) = start(config(), &seed);
    let (mut sb, _) = start(config(), &seed);
    let lib = eng.library().clone();
    let n_px = N * N;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let a = sa.observe_lookback(f, &lib, &tr, k as u64, None).unwrap();
        let held = sb.is_test(k as u64);
        let b = sb
            .observe_lookback_flagged(f, &lib, &tr, held, None)
            .unwrap();
        assert_eq!(a, b);
    }
    sa.mark_all_due();
    sb.mark_all_due();
    for _ in 0..20 {
        sa.step(5_000_000).unwrap();
        sb.step(5_000_000).unwrap();
    }
    assert!(sa.finalize().unwrap().to_bytes()[16..] == sb.finalize().unwrap().to_bytes()[16..]);
}

/// Look-back through the app's JS `SlowLoop` surface (`observe` with the
/// stream index, `lookbackNote`, `lookbackTake`, `observeLookback`) gives
/// the libraries of the native driver (qc_eval's: the scheduler beside the
/// slow loop, held-out by the slow-loop index), bit for bit; look-back
/// frames reach the statistics without moving the slow loop's clock.
#[cfg(feature = "jsbindings")]
#[test]
fn js_lookback_matches_the_native_driver() {
    use super::js::JsSlowLoop;
    let t = 1200;
    let (m, seed) = busy_movie(t);
    // Half the cells seeded: the rest are born during the run.
    let seed = &seed[..seed.len() / 2];
    let cfg = SlowLoopConfig {
        joint_update: JointUpdate::All,
        merge_guard_min_sep: 0.6,
        ..shard_config()
    };
    let n_px = N * N;
    let frame = |k: usize| &m[k * n_px..(k + 1) * n_px];

    // Native.
    let (mut sl, mut eng) = start(cfg.clone(), seed);
    let mut lb = LookBack::new(LookbackConfig::default());
    let mut lb_eng = eng.clone();
    let mut native = Vec::new();
    let mut pushed_native = 0;
    for k in 0..t {
        let tr = eng.process(frame(k)).unwrap();
        let lib = eng.library().clone();
        sl.observe(frame(k), &lib, &tr).unwrap();
        if let Some(l) = sl.step(5_000_000).unwrap() {
            native.push(l.to_bytes()[16..].to_vec());
            eng.set_library(l).unwrap();
        }
        lb.note_frame(eng.library(), k + 1);
        lb.add_credit(2.0);
        while let LookbackNext::Frame(r) = lb.next(&sl, eng.library()) {
            lb_eng.set_library(eng.library().clone()).unwrap();
            let tr = lb_eng.process(frame(r.frame)).unwrap();
            let lib = lb_eng.library().clone();
            let fit = sl
                .observe_lookback(frame(r.frame), &lib, &tr, r.frame as u64, Some(&r.ids))
                .unwrap();
            pushed_native += usize::from(fit);
            lb.frame_done(LookbackOutcome::Observed);
        }
    }
    native.push(sl.finalize().unwrap().to_bytes()[16..].to_vec());

    // JS surface.
    let (slow, mut eng) = start(cfg, seed);
    let mut js = JsSlowLoop::from_parts(slow, eng.library().clone(), Some(lookback_2_3000()));
    let mut lb_eng = eng.clone();
    let mut via_js = Vec::new();
    for k in 0..t {
        let tr = eng.process(frame(k)).unwrap();
        let v = eng.library().version() as f64;
        let bg = Some(tr.background.clone());
        assert!(js
            .observe(frame(k), v, &tr.traces, bg, Some(k as f64))
            .unwrap());
        if let Some(l) = js.step(5_000_000.0).unwrap() {
            via_js.push(l.arc().to_bytes()[16..].to_vec());
            eng.set_library(l.arc().clone()).unwrap();
        }
        let frames_before = js.frames();
        js.lookback_note((k + 1) as f64, 1.0);
        let req = js.lookback_take(1000);
        let mut i = 0;
        while i < req.len() {
            let (f, n) = (req[i] as usize, req[i + 2] as usize);
            let ids = &req[i + 3..i + 3 + n];
            i += 3 + n;
            lb_eng.set_library(eng.library().clone()).unwrap();
            let tr = lb_eng.process(frame(f)).unwrap();
            let v = lb_eng.library().version() as f64;
            js.observe_lookback(
                frame(f),
                v,
                &tr.traces,
                Some(tr.background.clone()),
                f as f64,
                ids,
            )
            .unwrap();
        }
        assert_eq!(js.frames(), frames_before, "look-back moved the clock");
    }
    via_js.push(js.finalize().unwrap().arc().to_bytes()[16..].to_vec());

    // Split-half noise of every published cell, by id, as the native call.
    let lib = js.finalize().unwrap();
    let noise = js.footprint_noise();
    let lib = lib.arc();
    assert_eq!(noise.len(), 2 * lib.len());
    let mut finite = 0;
    for slot in 0..lib.len() {
        let id = lib.ids()[slot];
        assert_eq!(noise[2 * slot], id as f64);
        let want = js
            .inner()
            .footprint_noise(id, lib.filtered(slot).0)
            .unwrap_or(f64::NAN);
        let got = noise[2 * slot + 1];
        assert!(
            got == want || (got.is_nan() && want.is_nan()),
            "{id}: {got} {want}"
        );
        finite += usize::from(got.is_finite() && got > 0.0);
    }
    assert!(finite > 0, "no cell has a noise estimate");

    let st = js.lookback_stats();
    assert!(st[1] > 100.0, "pushed {st:?}");
    assert_eq!(st[1] as usize, pushed_native, "{st:?}");
    assert_eq!(st[3], 0.0, "dropped {st:?}");
    assert!(st[4] > seed.len() as f64, "births {st:?}");
    assert_eq!(native.len(), via_js.len());
    assert!(native == via_js, "libraries differ");
}

/// The app's look-back: two look-back frames per Discover frame, at most
/// 3000 frames before a cell's birth.
#[cfg(feature = "jsbindings")]
fn lookback_2_3000() -> super::LookbackConfig {
    super::LookbackConfig {
        rate: 2.0,
        max_frames: 3000,
        ..super::LookbackConfig::default()
    }
}

/// Hardening: a visit runner built with other slow-loop options refuses the
/// job; with look-back on, `observe` needs the stream index.
#[cfg(feature = "jsbindings")]
#[test]
fn lookback_misuse_is_refused() {
    use super::js::JsSlowLoop;
    let t = 400;
    let (m, seed) = busy_movie(t);
    let n_px = N * N;
    // The fingerprints of the default params and of params with the
    // cluster replay and the merge guard off.
    use crate::params::engine::Engine;
    use crate::params::resolve::Context;
    use crate::params::{CalaParams, ClusterUpdate};
    let fp = |p: &CalaParams| {
        let ctx = Context {
            fps: Some(20.0),
            frame: [N as u32, N as u32],
        };
        Engine::build(p, ctx).unwrap().slow_loop.fingerprint
    };
    let mut off = CalaParams::default();
    off.discover.cluster.update = ClusterUpdate::Off;
    off.discover.merge.guard_min_sep_d = None;
    let cfg = SlowLoopConfig {
        joint_update: JointUpdate::All,
        merge_guard_min_sep: 0.6,
        fingerprint: fp(&CalaParams::default()),
        ..shard_config()
    };
    let (mut sl, mut eng) = start(cfg.clone(), &seed);
    let plain = SlowLoop::new(
        dims(),
        vec![1; n_px],
        vec![1.0; n_px],
        flattener(),
        SlowLoopConfig {
            fingerprint: fp(&off),
            ..shard_config()
        },
    )
    .unwrap();
    let mut runner = VisitRunner::new(plain);
    let mut job = None;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        sl.observe(f, &lib, &tr).unwrap();
        if let Some(b) = sl.take_job_bytes() {
            job = Some(b);
            break;
        }
    }
    let job = VisitJob::from_bytes(&job.expect("a visit job")).unwrap();
    let err = runner.run(job).unwrap_err();
    assert!(err.to_string().contains("other options"), "{err}");

    // (The JS error paths themselves need a wasm target; their guards:)
    let (slow, _) = start(cfg.clone(), &seed);
    let js = JsSlowLoop::from_parts(slow, eng.library().clone(), None);
    assert!(js.stream_ok(None));
    let (slow, _) = start(cfg, &seed);
    let js = JsSlowLoop::from_parts(slow, eng.library().clone(), Some(lookback_2_3000()));
    assert!(!js.stream_ok(None));
    assert!(js.stream_ok(Some(0.0)));
}

/// The concurrent settle's frames: a held-out frame never reaches the
/// footprint statistics, nothing enters the reservoir, no tile comes due
/// and the loop's frame clock does not move. Before `enable_settle` the
/// call is refused.
#[test]
fn settle_frames_keep_their_side_and_leave_discover_clocks_alone() {
    let t = 90;
    let mut rng = Lcg(5);
    let cells = vec![(blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0))];
    let m = movie(&cells, t, 7);
    let seed: Vec<Footprint> = cells.iter().map(|(f, _)| f.clone()).collect();
    let n_px = N * N;
    let run = |skip_held: bool| {
        let (mut slow, mut eng) = start(config(), &seed);
        let lib = eng.library().clone();
        let f = &m[..n_px];
        let tr = eng.process(f).unwrap();
        assert!(slow.observe_settle(f, &lib, &tr, false).is_err());
        slow.enable_settle();
        // Live frames with the reservoir frozen: the clock runs, nothing
        // is stored.
        slow.set_reservoir_frozen(true);
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let tr = eng.process(f).unwrap();
            slow.observe(f, &lib, &tr).unwrap();
        }
        slow.set_reservoir_frozen(false);
        let frames = slow.frames();
        let fresh: Vec<u32> = slow.tiles.iter().map(|t| t.fresh).collect();
        for _ in 0..2 {
            for k in 0..t {
                let held = slow.is_test(k as u64);
                let f = &m[k * n_px..(k + 1) * n_px];
                let tr = eng.process(f).unwrap();
                if held && skip_held {
                    continue;
                }
                slow.observe_settle(f, &lib, &tr, held).unwrap();
            }
        }
        assert_eq!(slow.frames(), frames);
        let after: Vec<u32> = slow.tiles.iter().map(|t| t.fresh).collect();
        assert_eq!(after, fresh, "a settle frame made a tile due for Discover");
        slow
    };
    let full = run(false);
    let st = full.settle_stats();
    assert!(st.frames_fit > 0 && st.frames_test > 0);
    assert_eq!(full.reservoir_bytes(), 0);
    // Held-out frames never reach the statistics.
    let id = full.fpstats.keys().next().copied().unwrap();
    let dbg = |s: &SlowLoop| {
        let mut st = s.fpstats[&id].clone();
        st.version = 0;
        format!("{st:?}")
    };
    assert!(dbg(&full) == dbg(&run(true)));
}

/// The app's concurrent settle (frames only; `SlowLoop.enableSettle`,
/// `settleTake`, `observeSettle`): the frames taken are spread in chunks
/// over the saved history and carry the held-out decision `observe`
/// recorded; a fitting frame moves the footprint statistics and nothing
/// else (no frame counter, no reservoir slot, no tile made due); a held-out
/// frame is refused, so it never reaches fitting.
#[cfg(feature = "jsbindings")]
#[test]
fn js_settle_frames_only_feeds_fitting_frames_to_the_statistics() {
    use super::js::JsSlowLoop;
    let t = 96;
    let mut rng = Lcg(5);
    let cells = vec![(blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0))];
    let m = movie(&cells, t, 7);
    let seed: Vec<Footprint> = cells.iter().map(|(f, _)| f.clone()).collect();
    let n_px = N * N;
    let (slow, mut eng) = start(config(), &seed);
    let mut js = JsSlowLoop::from_parts(slow, eng.library().clone(), Some(lookback_2_3000()));
    let v = eng.library().version() as f64;
    // Off: nothing to take.
    assert!(js.settle_take(96.0, 16).is_empty());
    js.enable_settle(16).unwrap();
    // Live frames at stream indices 100.. (frames before the slow loop
    // started get the hashed decision).
    let off = 100usize;
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let ok = js
            .observe(
                f,
                v,
                &tr.traces,
                Some(tr.background.clone()),
                Some((off + k) as f64),
            )
            .unwrap();
        assert!(ok);
    }
    // Less than one chunk saved: nothing.
    assert!(js.settle_take(15.0, 16).is_empty());
    let seen = off + t;
    let frames = js.inner().frames();
    let fresh: Vec<u32> = js.inner().tiles.iter().map(|t| t.fresh).collect();
    let bytes = js.inner().reservoir_bytes();
    let id = js.inner().fpstats.keys().next().copied().unwrap();
    let dbg = |s: &SlowLoop| {
        let mut st = s.fpstats[&id].clone();
        st.version = 0;
        format!("{st:?}")
    };
    let (mut fit, mut held, mut blocks) = (0u64, 0u64, std::collections::BTreeSet::new());
    for _ in 0..8 {
        let take = js.settle_take(seen as f64, 16);
        assert_eq!(take.len(), 48);
        for i in 0..take.len() / 3 {
            let (f, block, h) = (
                take[3 * i] as usize,
                take[3 * i + 1],
                take[3 * i + 2] == 1.0,
            );
            assert!(f < seen);
            assert!(block < -1_000_000.0);
            assert_eq!(block, take[1], "one request, one chunk");
            assert_eq!(f, take[0] as usize + i, "a chunk is frames in a row");
            blocks.insert(block as i64);
            // The decision `observe` recorded for an observed frame.
            if f >= off {
                assert_eq!(h, js.inner().is_test((f - off) as u64), "frame {f}");
            }
            if f < off {
                // Never seen live by the slow loop: not in this test's movie.
                continue;
            }
            let y = &m[(f - off) * n_px..(f - off + 1) * n_px];
            let tr = eng.process(y).unwrap();
            let before = dbg(js.inner());
            let took = js
                .observe_settle(y, v, &tr.traces, Some(tr.background.clone()), f as f64)
                .unwrap();
            assert_eq!(took, !h, "frame {f}");
            assert_eq!(dbg(js.inner()) != before, took, "frame {f}");
            fit += u64::from(took);
            held += u64::from(!took);
        }
    }
    assert_eq!(blocks.len(), 8);
    assert!(fit > 0 && held > 0, "{fit} fit, {held} held out");
    assert_eq!(js.inner().frames(), frames);
    assert_eq!(js.inner().reservoir_bytes(), bytes);
    let after: Vec<u32> = js.inner().tiles.iter().map(|t| t.fresh).collect();
    assert_eq!(after, fresh, "a settle frame made a tile due for Discover");
    js.settle_skipped(3.0);
    assert_eq!(
        js.settle_stats(),
        vec![128.0, fit as f64, (held + 3) as f64, 0.0]
    );
    // A version no longer held is dropped, not an error.
    let y = &m[..n_px];
    let f = (off..seen)
        .find(|&f| !js.inner().is_test((f - off) as u64))
        .unwrap();
    assert!(!js
        .observe_settle(y, 9999.0, &[0.0], None, f as f64)
        .unwrap());
    assert_eq!(js.settle_stats()[3], 1.0);
}

/// The settle scheduler: the share sets the frames owed per live frame,
/// and the chunks cover the saved history about evenly.
#[test]
fn settle_sched_spreads_chunks_over_the_history() {
    let mut s = SettleSched::new(0.5, 16);
    assert!(s.next_frame(15).is_none());
    let seen = 1600;
    let mut hits = [0usize; 10];
    let mut last = usize::MAX;
    for i in 0..1600 {
        let (f, new) = s.next_frame(seen).unwrap();
        assert!(f < seen);
        assert_eq!(new, i % 16 == 0);
        if !new {
            assert_eq!(f, last + 1);
        }
        last = f;
        hits[f * 10 / seen] += 1;
    }
    assert!(hits.iter().all(|&h| (112..=208).contains(&h)), "{hits:?}");
    // One settle frame per live frame at a share of one half; a third of
    // one at a quarter.
    let mut owed = 0;
    for _ in 0..100 {
        s.earn(1.0);
        while s.take() {
            owed += 1;
        }
    }
    assert_eq!(owed, 100);
    s.set_share(0.25);
    owed = 0;
    for _ in 0..300 {
        s.earn(1.0);
        while s.take() {
            owed += 1;
        }
    }
    assert!((99..=101).contains(&owed), "{owed}");
}

/// A floor (a new session of a Joint run starts there) keeps look-back
/// within `floor..`: a cell born before it needs nothing more, a block in
/// progress is cut to it, and a later birth's window is clipped to it.
#[test]
fn lookback_floor_keeps_look_back_in_the_current_session() {
    let (slow, _) = start(config(), &[]);
    let mut lb = LookBack::new(LookbackConfig::default());
    let lib1 = lb_lib(1, &[blob(1, 30.0, 30.0)]);
    lb.note_frame(&lib1, 1000);
    // Part of its window is served, then the session changes at 1100.
    assert_eq!(lb_take(&mut lb, &slow, &lib1, 10.0).len(), 10);
    lb.set_floor(1100);
    assert_eq!(lb.floor(), 1100);
    assert_eq!(lb_take(&mut lb, &slow, &lib1, 10_000.0), vec![]);
    assert_eq!(lb.in_need(), 0);
    // A floor never goes down.
    lb.set_floor(10);
    assert_eq!(lb.floor(), 1100);
    // A cell born at 1300 (K = 3000) looks back to 1100 at most.
    let lib2 = lb_lib(2, &[blob(1, 30.0, 30.0), blob(2, 75.0, 75.0)]);
    lb.note_frame(&lib2, 1300);
    let got = lb_take(&mut lb, &slow, &lib2, 10_000.0);
    let mut frames: Vec<usize> = got.iter().map(|g| g.0).collect();
    frames.sort_unstable();
    frames.dedup();
    assert_eq!(frames, (1100..1300).collect::<Vec<_>>());
    assert!(got.iter().all(|g| g.1 == vec![2]));
}

/// The settle scheduler with a floor re-reads frames `floor..seen` only,
/// in whole chunks from the floor, and still covers that span.
#[test]
fn settle_sched_floor_keeps_chunks_in_the_current_session() {
    let mut s = SettleSched::new(0.5, 16);
    // A chunk in progress below the floor is dropped at once.
    assert!(s.next_frame(1600).is_some());
    s.set_floor(1000);
    assert!(s.next_frame(1010).is_none());
    let seen = 1640;
    let mut hits = [0usize; 4];
    for _ in 0..1600 {
        let (f, _) = s.next_frame(seen).unwrap();
        assert!((1000..seen).contains(&f), "{f}");
        assert!((f - 1000) / 16 * 16 + 1000 + 16 <= seen);
        hits[(f - 1000) * 4 / 640] += 1;
    }
    assert!(hits.iter().all(|&h| h > 250), "{hits:?}");
    s.set_floor(5);
    assert!(s.next_frame(seen).unwrap().0 >= 1000);
}

/// The Discover visit cap (`visitrate.rs`): with a large work budget, a
/// capped loop makes at most `rate` ordinary visits per observed frame (plus
/// the bank), an uncapped one more; a rate of 0 or less is off and changes
/// nothing.
#[test]
fn visit_rate_caps_ordinary_visits_per_frame() {
    let t = 1200;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let run = |rate: f64| -> (SlowLoop, Vec<u8>) {
        let (mut s, mut eng) = start(cfg.clone(), &seed);
        s.set_visit_rate(rate);
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let tr = eng.process(f).unwrap();
            let lib = eng.library().clone();
            s.observe(f, &lib, &tr).unwrap();
            if let Some(l) = s.step(1_000_000_000).unwrap() {
                eng.set_library(l).unwrap();
            }
        }
        let lib = s.finalize().unwrap().to_bytes()[16..].to_vec();
        (s, lib)
    };
    let (free, free_lib) = run(0.0);
    let (off, off_lib) = run(-1.0);
    assert_eq!(free.stats(), off.stats(), "rate <= 0 must be off");
    assert!(free_lib == off_lib);
    assert_eq!(free.visit_rate_stats().frames, 0);
    let per_frame = free.stats().visits as f64 / t as f64;
    let rate = 0.25;
    assert!(
        per_frame > 2.0 * rate,
        "uncapped {per_frame:.3} visits per frame"
    );
    let (capped, _) = run(rate);
    let v = capped.visit_rate_stats();
    assert_eq!(v.frames, t as u64);
    assert_eq!(v.visits, capped.stats().visits);
    assert!(
        (v.visits as f64) <= rate * t as f64 + rate * VISIT_BANK_FRAMES + 1.0,
        "{} visits over {t} frames at {rate}",
        v.visits
    );
    // Demand is far above the cap: it binds on most frames and the visits sit close to it.
    assert!(
        v.visits as f64 >= 0.9 * rate * t as f64,
        "{} visits",
        v.visits
    );
    assert!(
        v.capped_frames as f64 > 0.5 * t as f64,
        "{} capped frames",
        v.capped_frames
    );
}

/// The Auto schedule (`visitrate.rs`) is fed where a visit's result lands:
/// visits made in place (`step`) and run as jobs (`step_via`) give the same
/// curve, the same visits and the same library; it counts every ordinary
/// visit and the new cells they found, and a fixed schedule with the cap at
/// its target behaves exactly as the bare cap.
#[test]
fn visit_schedule_same_in_place_and_as_jobs() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let sched = VisitSchedule {
        // Small enough that the busy movie's few tiles leave the warm-up and move the target.
        slow_half_life: 8.0,
        fast_half_life: 4.0,
        cap_ratio: 1.0,
        target: 0.5,
        ..VisitSchedule::auto()
    };
    let run = |via: bool, s: Option<VisitSchedule>, rate: f64| {
        let (mut a, mut ea) = start(cfg.clone(), &seed);
        let mut runner = VisitRunner::new(new_loop(&cfg));
        a.set_visit_rate(rate);
        if let Some(s) = s {
            a.set_visit_schedule(s);
        }
        let mut targets = Vec::new();
        for k in 0..t {
            let f = &m[k * n_px..(k + 1) * n_px];
            let tr = ea.process(f).unwrap();
            let lib = ea.library().clone();
            a.observe(f, &lib, &tr).unwrap();
            let p = if via {
                a.step_via(1_000_000_000, &mut runner).unwrap()
            } else {
                a.step(1_000_000_000).unwrap()
            };
            if let Some(l) = p {
                ea.set_library(l).unwrap();
            }
            targets.push(a.visit_rate_stats().target);
        }
        let lib = a.finalize().unwrap().to_bytes()[16..].to_vec();
        (
            a.visit_rate_stats(),
            a.stats(),
            a.churn_counts(),
            targets,
            lib,
        )
    };
    let (va, sa, ca, ta, la) = run(false, Some(sched), 0.0);
    let (vb, sb, _, tb, lb) = run(true, Some(sched), 0.0);
    assert_eq!(va, vb);
    assert_eq!(sa, sb);
    assert_eq!(ta, tb);
    assert!(la == lb);
    assert!(va.auto);
    assert_eq!(va.fed_visits, sa.visits);
    assert_eq!(va.fed_new, ca.adds_new);
    assert!(va.fed_new > 0);
    assert!(
        va.rung_changes > 0,
        "the target never moved: {va:?} over {} visits",
        sa.visits
    );
    // Fixed at the bare cap's rate: the same visits and library as the bare cap.
    let fixed = VisitSchedule {
        auto: false,
        ..sched
    };
    let (vf, sf, _, tf, lf) = run(false, Some(fixed), 0.0);
    let (vc, sc, _, _, lc) = run(false, None, 0.5);
    assert_eq!(sf, sc);
    assert!(lf == lc);
    assert_eq!(vf.visits, vc.visits);
    assert!(tf.iter().all(|&x| x == 0.5));
    assert_eq!(vf.rung_changes, 0);
}

/// The cap holds visits handed out as jobs as well (`take_job_bytes`), and
/// leaves Refine-scope visits alone.
#[test]
fn visit_rate_caps_jobs_and_not_refine() {
    let t = 900;
    let (m, seed) = busy_movie(t);
    let cfg = shard_config();
    let n_px = N * N;
    let (mut s, mut eng) = start(cfg.clone(), &seed);
    let mut runner = VisitRunner::new(new_loop(&cfg));
    let rate = 0.5;
    s.set_visit_rate(rate);
    let feed = |s: &mut SlowLoop, eng: &mut TraceEngine, runner: &mut VisitRunner, k: usize| {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        s.observe(f, &lib, &tr).unwrap();
        while let Some(b) = s.take_job_bytes() {
            let r = runner.run(VisitJob::from_bytes(&b).unwrap()).unwrap();
            s.apply_job(VisitResult::from_bytes(&r.to_bytes()).unwrap())
                .unwrap();
        }
        if let Some(l) = s.housekeep().unwrap() {
            eng.set_library(l).unwrap();
        }
    };
    for k in 0..t {
        feed(&mut s, &mut eng, &mut runner, k);
    }
    let v = s.visit_rate_stats();
    assert_eq!(v.visits, s.stats().visits);
    assert!((v.visits as f64) <= rate * t as f64 + rate * VISIT_BANK_FRAMES + 1.0);
    assert!(
        v.visits as f64 >= 0.9 * rate * t as f64,
        "{} visits",
        v.visits
    );
    // Refine scope: the cap is still set but neither counts nor holds.
    let lib = s.finalize().unwrap();
    eng.set_library(lib).unwrap();
    s.set_edit_scope(EditScope::Refine);
    let visits0 = s.stats().visits;
    for k in 0..t {
        feed(&mut s, &mut eng, &mut runner, k);
    }
    assert_eq!(s.visit_rate_stats().frames, v.frames);
    assert_eq!(s.visit_rate_stats().visits, v.visits);
    assert!(
        (s.stats().visits - visits0) as f64 > 1.2 * (rate * t as f64 + rate * VISIT_BANK_FRAMES),
        "{} Refine visits",
        s.stats().visits - visits0
    );
}

/// The mean-field statistics read back (`stats_of`) as the plain sums a loop
/// that keeps every cell plain accumulates, to rounding: live frames on one
/// library interleaved with look-back frames on another (alternating
/// versions fold the own-signal sums; a cell of the live library misses
/// the look-back frames' field pushes; a shifted footprint moves its disk), look-back pushes to a subset, missing samples on one cell's disk
/// (it turns plain) and elsewhere, forgetting rescales and split-half block
/// changes.
#[test]
fn mean_field_statistics_match_the_plain_sums() {
    let t = 1100;
    let mut rng = Lcg(11);
    let cells = vec![
        (blob(0, 30.0, 30.0), trace(&mut rng, t, 0.05, 6.0)),
        (blob(1, 70.0, 70.0), trace(&mut rng, t, 0.05, 6.0)),
        (blob(2, 48.0, 20.0), trace(&mut rng, t, 0.05, 6.0)),
        (blob(3, 75.0, 25.0), trace(&mut rng, t, 0.05, 6.0)),
    ];
    let n_px = N * N;
    let mut m = movie(&cells, t, 3);
    for k in 0..t {
        let f = &mut m[k * n_px..(k + 1) * n_px];
        // A missing sample away from every disk on some frames, and a
        // missing patch on cell 2 on a few.
        if k % 5 == 0 {
            f[2 * N + 93] = f32::NAN;
        }
        if (700..720).contains(&k) {
            for y in 46..51 {
                for x in 18..23 {
                    f[y * N + x] = f32::NAN;
                }
            }
        }
    }
    let ring = crate::trace::BackgroundModel::Ring {
        inner_px: 12.0,
        outer_px: 20.0,
    };
    let build = |fps: Vec<Footprint>, v: u64| {
        let mut b = LibraryBuilder::new(dims())
            .background(ring.clone())
            .version(v);
        for fp in fps {
            b = b.footprint(fp);
        }
        Arc::new(b.build(&mut flattener()).unwrap())
    };
    let live_a = build(
        vec![
            blob(0, 30.0, 30.0),
            blob(1, 70.0, 70.0),
            blob(3, 75.0, 25.0),
        ],
        1,
    );
    let live_b = build(
        vec![
            blob_w(0, 30.0, 36.0, 3.0),
            blob(1, 70.0, 70.0),
            blob(2, 48.0, 20.0),
        ],
        3,
    );
    let back = build(
        vec![
            blob_w(0, 30.0, 36.0, 3.0),
            blob(1, 70.0, 70.0),
            blob(2, 48.0, 20.0),
        ],
        2,
    );
    let cfg = SlowLoopConfig {
        stats_half_life_frames: 40.0,
        ..config()
    };
    let new_loop = || {
        SlowLoop::new(
            dims(),
            vec![1; n_px],
            vec![1.0; n_px],
            flattener(),
            cfg.clone(),
        )
    };
    let (mut sm, mut sp) = (new_loop().unwrap(), new_loop().unwrap());
    sp.stats_plain = true;
    let mut eng_a = TraceEngine::new(live_a.clone(), SolverConfig::default()).unwrap();
    let mut eng_b = TraceEngine::new(live_b.clone(), SolverConfig::default()).unwrap();
    let mut eng_back = TraceEngine::new(back.clone(), SolverConfig::default()).unwrap();
    let frame = |k: usize| &m[k * n_px..(k + 1) * n_px];
    let check = |sm: &SlowLoop, sp: &SlowLoop, at: usize| {
        assert_eq!(
            sm.fpstats.keys().collect::<std::collections::BTreeSet<_>>(),
            sp.fpstats.keys().collect::<std::collections::BTreeSet<_>>()
        );
        for (id, want) in &sp.fpstats {
            let got = sm.stats_of(*id).unwrap();
            assert_eq!(got.pix, want.pix, "cell {id} frame {at}");
            assert_eq!(got.k, want.k);
            assert_eq!(got.pm.is_some(), want.pm.is_some());
            let close_tol = |a: &[f32], b: &[f32], what: &str, tol: f32| {
                let top = b.iter().fold(0.0f32, |t, v| t.max(v.abs())).max(1e-6);
                for (x, y) in a.iter().zip(b) {
                    assert!(
                        (x - y).abs() <= tol * top,
                        "cell {id} frame {at} {what}: {x} vs {y} (top {top})"
                    );
                }
            };
            let close = |a: &[f32], b: &[f32], what: &str| close_tol(a, b, what, 1e-5);
            close(&got.rc, &want.rc, "rc");
            close(&got.r, &want.r, "r");
            close(&got.half.0, &want.half.0, "half rc");
            close(&got.half.1, &want.half.1, "half r");
            if want.k < 100 {
                // Too few frames: the estimates are ill-conditioned.
                continue;
            }
            match (got.estimate(), want.estimate()) {
                (Some(a), Some(b)) => close(&a, &b, "estimate"),
                (a, b) => assert_eq!(a.is_some(), b.is_some()),
            }
            match (got.halves(), want.halves()) {
                (Some(a), Some(b)) => {
                    // Half B is total − A of f32 sums: the reference's own
                    // rounding is amplified there.
                    close_tol(&a.0, &b.0, "half A", 1e-4);
                    close_tol(&a.1, &b.1, "half B", 1e-4);
                    assert!((a.2 - b.2).abs() <= 1e-5 * b.2 && (a.3 - b.3).abs() <= 1e-5 * b.3);
                }
                (a, b) => assert_eq!(a.is_some(), b.is_some()),
            }
            let (ea, eb) = (got.std_err(), want.std_err());
            assert!(ea == eb || (ea - eb).abs() <= 1e-5 * eb, "{ea} vs {eb}");
        }
    };
    let mut plain_seen = false;
    for k in 0..t {
        let (eng, lib) = if k < 600 {
            (&mut eng_a, &live_a)
        } else {
            (&mut eng_b, &live_b)
        };
        let tr = eng.process(frame(k)).unwrap();
        sm.observe(frame(k), lib, &tr).unwrap();
        sp.observe(frame(k), lib, &tr).unwrap();
        if k >= 50 {
            let j = k - 50;
            let tr = eng_back.process(frame(j)).unwrap();
            let only = [1u64];
            let only = (k % 2 == 0).then_some(&only[..]);
            sm.observe_lookback(frame(j), &back, &tr, j as u64, only)
                .unwrap();
            sp.observe_lookback(frame(j), &back, &tr, j as u64, only)
                .unwrap();
        }
        plain_seen |= sm.fpstats.get(&2).is_some_and(|s| s.mf.is_none());
        if k % 100 == 99 {
            check(&sm, &sp, k);
        }
    }
    check(&sm, &sp, t);
    // The paths the test is meant to cover were taken.
    assert!(plain_seen && sm.fpstats[&2].pm.is_some());
    assert!(sm.fpstats[&1].mf.is_some());
    assert!(sm.stats_gen > 0 && sm.fpstats[&1].k > 600);
}

/// The cluster stores of a loop on the mean-field push hold what a loop on
/// the plain push accumulates, to rounding: overlapping cells (two
/// clusters), live frames on one library interleaved with look-back frames
/// on another (a moved member: its columns change at every alternation;
/// the other cluster's columns do not), look-back pushes to a subset,
/// missing samples on a cluster's pixels (skipped frames), forgetting
/// rescales, and a new live library with a moved member. (Moved stores are
/// covered by `cluster::push_frame_tests::push_mean_matches_the_plain_push`.)
#[test]
fn mean_field_cluster_stores_match_the_plain_push() {
    let t = 900;
    let mut rng = Lcg(5);
    let cells = vec![
        (blob_w(0, 30.0, 30.0, 2.5), trace(&mut rng, t, 0.05, 6.0)),
        (blob_w(1, 30.0, 34.0, 2.5), trace(&mut rng, t, 0.05, 6.0)),
        (blob_w(2, 70.0, 66.0, 2.5), trace(&mut rng, t, 0.05, 6.0)),
        (blob_w(3, 70.0, 70.0, 2.5), trace(&mut rng, t, 0.05, 6.0)),
    ];
    let n_px = N * N;
    let mut m = movie(&cells, t, 4);
    for k in 0..t {
        if (300..310).contains(&k) {
            m[k * n_px + 70 * N + 68] = f32::NAN;
        }
    }
    let ring = crate::trace::BackgroundModel::Ring {
        inner_px: 12.0,
        outer_px: 20.0,
    };
    let build = |fps: Vec<Footprint>, v: u64| {
        let mut b = LibraryBuilder::new(dims())
            .background(ring.clone())
            .version(v);
        for fp in fps {
            b = b.footprint(fp);
        }
        Arc::new(b.build(&mut flattener()).unwrap())
    };
    let live_a = build(
        vec![
            blob_w(0, 30.0, 30.0, 2.5),
            blob_w(1, 30.0, 34.0, 2.5),
            blob_w(2, 70.0, 66.0, 2.5),
            blob_w(3, 70.0, 70.0, 2.5),
        ],
        1,
    );
    let back = build(
        vec![
            blob_w(0, 31.0, 30.0, 2.5),
            blob_w(1, 30.0, 34.0, 2.5),
            blob_w(2, 70.0, 66.0, 2.5),
            blob_w(3, 70.0, 70.0, 2.5),
        ],
        2,
    );
    let live_b = build(
        vec![
            blob_w(0, 31.0, 30.0, 2.5),
            blob_w(1, 30.0, 34.0, 2.5),
            blob_w(2, 70.0, 66.0, 2.5),
            blob_w(3, 70.0, 73.0, 2.5),
        ],
        3,
    );
    let cfg = SlowLoopConfig {
        stats_half_life_frames: 40.0,
        joint_update: JointUpdate::All,
        ..config()
    };
    let new_loop = || {
        SlowLoop::new(
            dims(),
            vec![1; n_px],
            vec![1.0; n_px],
            flattener(),
            cfg.clone(),
        )
    };
    let (mut sm, mut sp) = (new_loop().unwrap(), new_loop().unwrap());
    sp.stats_plain = true;
    let mut eng_a = TraceEngine::new(live_a.clone(), SolverConfig::default()).unwrap();
    let mut eng_b = TraceEngine::new(live_b.clone(), SolverConfig::default()).unwrap();
    let mut eng_back = TraceEngine::new(back.clone(), SolverConfig::default()).unwrap();
    let frame = |k: usize| &m[k * n_px..(k + 1) * n_px];
    let rel = |x: &[f32], y: &[f32]| -> f32 {
        let top = y.iter().fold(0.0f32, |a, v| a.max(v.abs())).max(1e-6);
        x.iter()
            .zip(y)
            .fold(0.0f32, |a, (p, q)| a.max((p - q).abs()))
            / top
    };
    let check = |sm: &SlowLoop, sp: &SlowLoop, at: usize| {
        assert_eq!(sm.clusters.len(), sp.clusters.len(), "frame {at}");
        for (a, b) in sm.clusters.iter().zip(&sp.clusters) {
            assert_eq!(a.ids, b.ids);
            assert_eq!((a.k, &a.pix), (b.k, &b.pix), "frame {at}");
            let ((cya, sra, va), (cyb, srb, vb)) = (a.sums(), b.sums());
            assert!(rel(&cya, &cyb) < 1e-5, "cy {:?} frame {at}", a.ids);
            assert!(rel(&sra, &srb) < 1e-5, "sr {:?} frame {at}", a.ids);
            assert!(rel(va, vb) < 1e-5, "v {:?} frame {at}", a.ids);
        }
        assert_eq!(
            sm.replay_stats.skipped_frames,
            sp.replay_stats.skipped_frames
        );
    };
    for k in 0..t {
        let (eng, lib) = if k < 500 {
            (&mut eng_a, &live_a)
        } else {
            (&mut eng_b, &live_b)
        };
        let tr = eng.process(frame(k)).unwrap();
        sm.observe(frame(k), lib, &tr).unwrap();
        sp.observe(frame(k), lib, &tr).unwrap();
        if k >= 50 {
            let j = k - 50;
            let tr = eng_back.process(frame(j)).unwrap();
            let only = [2u64];
            let only = (k % 3 == 0).then_some(&only[..]);
            sm.observe_lookback(frame(j), &back, &tr, j as u64, only)
                .unwrap();
            sp.observe_lookback(frame(j), &back, &tr, j as u64, only)
                .unwrap();
        }
        if k % 100 == 99 {
            check(&sm, &sp, k);
        }
    }
    check(&sm, &sp, t);
    // The paths the test is meant to cover were taken.
    eprintln!(
        "clusters {} skipped {} moves {} k {:?}",
        sm.clusters.len(),
        sm.replay_stats.skipped_frames,
        sm.replay_stats.moves,
        sm.clusters.iter().map(|c| c.k).collect::<Vec<_>>()
    );
    assert!(!sm.clusters.is_empty());
    assert!(sm.replay_stats.skipped_frames > 0);
    assert!(sm.clusters.iter().all(|c| c.k > 600));
}

/// The ledger's run-wise eight-lane sum is the serial sum to rounding, and
/// NaN when a sample on the pixels is missing (the ledger then takes the
/// masked sum, which skips it).
#[test]
fn runs_dot_matches_the_serial_sum() {
    use super::evidence::{masked_dot, runs_dot};
    use super::fpstats::pixel_runs;
    let mut rng = Lcg(3);
    let d: Vec<f32> = (0..4000).map(|_| rng.normal()).collect();
    for len in [0usize, 1, 7, 9, 33, 700] {
        let pix: Vec<u32> = (0..len as u32).map(|i| 5 + i + (i / 13) * 40).collect();
        let w: Vec<f32> = (0..len).map(|_| rng.next()).collect();
        let runs = pixel_runs(&pix);
        let got = runs_dot(&d, &runs, &w);
        let (want, n_miss, w_miss) = masked_dot(&d, &pix, &w, &w);
        assert_eq!((n_miss, w_miss), (0.0, 0.0));
        let scale: f32 = pix
            .iter()
            .zip(&w)
            .map(|(&p, &k)| (k * d[p as usize]).abs())
            .sum();
        assert!(
            (got - want).abs() <= 1e-5 * scale.max(1.0),
            "{len}: {got} vs {want}"
        );
        if len > 0 {
            let mut dm = d.clone();
            dm[pix[len / 2] as usize] = f32::NAN;
            assert!(runs_dot(&dm, &runs, &w).is_nan());
            let (g, n_miss, _) = masked_dot(&dm, &pix, &w, &w);
            assert!(g.is_finite() && n_miss == w[len / 2]);
        }
    }
}
