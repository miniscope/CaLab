//! S1.7 PR-1: the joint sufficient statistics (`suffstats.rs`) kept beside
//! `fpstats` by the owner, end to end through the fast loop.

use super::*;
use crate::discover::suffstats::ALL_GROUPS;

fn joint_cfg() -> SlowLoopConfig {
    SlowLoopConfig {
        footprint_stats: FootprintStats::Joint,
        // No forgetting (the weight stays exactly 1), so a from-scratch fit
        // over the same frames is unweighted.
        stats_half_life_frames: 1e9,
        ..config()
    }
}

/// Trace of a cell that co-fires with `with` (share `rho`).
fn cofiring(rng: &mut Lcg, with: &[f32], rho: f32) -> Vec<f32> {
    let own = trace(rng, with.len(), 0.03, 6.0);
    own.iter()
        .zip(with)
        .map(|(&o, &w)| rho * w + (1.0 - rho) * o)
        .collect()
}

/// The filtered footprint image of `fp` (what the movie adds per unit
/// trace).
fn filtered(fp: &Footprint) -> Vec<f32> {
    let mut img = vec![0.0f32; N * N];
    for y in 0..fp.height {
        for x in 0..fp.width {
            img[(fp.y0 + y) * N + fp.x0 + x] = fp.values[y * fp.width + x];
        }
    }
    flattener().apply(&mut img).unwrap();
    img
}

fn pearson(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len() as f64;
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (f64::from(x) - ma, f64::from(y) - mb);
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    ab / (aa * bb).sqrt()
}

/// One observed frame: data, the library that solved it, its result.
struct Seen {
    frame: Vec<f32>,
    lib: Arc<Library>,
    traces: FrameTraces,
    fitting: bool,
}

/// Fast loop + `observe` only (no visits, so no column changes but the
/// ones the test makes), recording every frame.
fn observe(
    movie: &[f32],
    range: std::ops::Range<usize>,
    slow: &mut SlowLoop,
    eng: &mut TraceEngine,
    log: &mut Vec<Seen>,
) {
    let n_px = N * N;
    for k in range {
        let f = &movie[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        let fitting = !slow.is_test(slow.frames);
        slow.observe(f, &lib, &tr).unwrap();
        log.push(Seen {
            frame: f.to_vec(),
            lib,
            traces: tr.clone(),
            fitting,
        });
    }
}

/// The least-squares fit of cell `id`'s filtered column on `pix` from the
/// logged fitting frames (at the pixels flagged `late`, only frames from
/// `from` on), under the columns and ring coupling of `lib`: the regression
/// of `x − Σ_{j≠i} g_j c_j − β_i` on `c_i`, with each frame's raw ring mean
/// recovered under that frame's own library.
fn from_scratch(
    log: &[Seen],
    lib: &Library,
    id: u64,
    pix: &[u32],
    late: &[bool],
    from: usize,
) -> Vec<f32> {
    let slot = lib.slot(id).unwrap();
    let ids = lib.ids();
    let cols: Vec<(u64, Vec<f32>)> = ids
        .iter()
        .enumerate()
        .filter(|&(s, _)| s != slot)
        .map(|(s, &j)| (j, column_on(lib, s, pix)))
        .collect();
    let (qc, qv) = lib.ring_row(slot);
    let q: Vec<(u64, f32)> = qc
        .iter()
        .zip(qv)
        .map(|(&j, &v)| (ids[j as usize], v))
        .collect();
    let n = pix.len();
    let mut acc = vec![[0.0f64; 5]; n];
    for (t, s) in log.iter().enumerate() {
        if !s.fitting {
            continue;
        }
        let tl = &s.lib;
        let c = |j: u64| tl.slot(j).map_or(0.0, |k| f64::from(s.traces.traces[k]));
        let si = tl.slot(id).unwrap();
        let (tq, tv) = tl.ring_row(si);
        let rho = f64::from(s.traces.background[si])
            + tq.iter()
                .zip(tv)
                .map(|(&j, &v)| f64::from(v) * f64::from(s.traces.traces[j as usize]))
                .sum::<f64>();
        let beta = rho - q.iter().map(|&(j, v)| f64::from(v) * c(j)).sum::<f64>();
        let ci = c(id);
        for p in 0..n {
            if t < from && late[p] {
                continue;
            }
            let mut y = f64::from(s.frame[pix[p] as usize]) - beta;
            for (j, col) in &cols {
                y -= f64::from(col[p]) * c(*j);
            }
            let a = &mut acc[p];
            a[0] += 1.0;
            a[1] += y;
            a[2] += ci;
            a[3] += ci * ci;
            a[4] += y * ci;
        }
    }
    acc.iter()
        .map(|a| ((a[4] - a[1] * a[2] / a[0]) / (a[3] - a[2] * a[2] / a[0])) as f32)
        .collect()
}

fn max_abs(v: &[f32]) -> f32 {
    v.iter().fold(0.0f32, |m, &x| m.max(x.abs()))
}

fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .fold(0.0f32, |m, (x, y)| m.max((x - y).abs()))
}

#[test]
fn joint_matches_fpstats_when_no_column_changed() {
    let t = 3000;
    let mut rng = Lcg(31);
    let c0 = trace(&mut rng, t, 0.03, 6.0);
    let c1 = cofiring(&mut rng, &c0, 0.6);
    let c2 = trace(&mut rng, t, 0.03, 6.0);
    let fps = [
        blob(1, 44.0, 42.0),
        blob(2, 45.0, 49.0),
        blob(3, 51.0, 45.0),
    ];
    let cells: Vec<_> = fps.iter().cloned().zip([c0, c1, c2]).collect();
    let m = movie(&cells, t, 5);
    // With the default forgetting, as in a real run.
    let cfg = SlowLoopConfig {
        stats_half_life_frames: SlowLoopConfig::default().stats_half_life_frames,
        ..joint_cfg()
    };
    let (mut slow, mut eng) = start(cfg, &fps);
    let mut log = Vec::new();
    observe(&m, 0..t, &mut slow, &mut eng, &mut log);
    let lib = eng.library().clone();
    for id in 1..=3 {
        let (pj, ej) = slow.joint_estimate(&lib, id, ALL_GROUPS).unwrap();
        let (pr, er) = slow.residual_estimate(id).unwrap();
        assert_eq!(pj, pr);
        let rel = max_diff(&ej, &er) / max_abs(&er);
        eprintln!("cell {id}: joint vs fpstats max rel diff {rel:.2e}");
        assert!(rel < 1e-4, "cell {id}: {rel}");
    }
    let d = slow.joint_stats_diag();
    assert_eq!(d.cells, 3);
    assert_eq!(d.restarted_px, 0);
}

#[test]
fn neighbour_change_is_corrected_immediately() {
    let t = 3000;
    let mut rng = Lcg(77);
    let ci = trace(&mut rng, t + 1, 0.03, 6.0);
    let cj = cofiring(&mut rng, &ci, 0.8);
    let (fi, fj) = (blob(1, 48.0, 44.0), blob(2, 48.0, 50.0));
    let m = movie(&[(fi.clone(), ci), (fj.clone(), cj)], t + 1, 9);
    // Cell 2 is published 3 px off for 3000 frames...
    let (mut slow, mut eng) = start(joint_cfg(), &[fi.clone(), blob(2, 48.0, 53.0)]);
    let mut log = Vec::new();
    observe(&m, 0..t, &mut slow, &mut eng, &mut log);
    // ...then corrected (same ids, a new library version).
    let (mut other, _) = start(joint_cfg(), &[fi.clone(), fj.clone()]);
    let fixed = other.finalize().unwrap();
    eng.set_library(fixed.clone()).unwrap();
    observe(&m, t..t + 1, &mut slow, &mut eng, &mut log);
    let lib = eng.library().clone();
    assert_eq!(lib.version(), fixed.version());
    let (pix, joint) = slow.joint_estimate(&lib, 1, ALL_GROUPS).unwrap();
    let scratch = from_scratch(&log, &lib, 1, &pix, &vec![false; pix.len()], 0);
    let rel = max_diff(&joint, &scratch) / max_abs(&scratch);
    let (_, stale) = slow.residual_estimate(1).unwrap();
    let img = filtered(&fi);
    let truth: Vec<f32> = pix.iter().map(|&p| img[p as usize]).collect();
    let (rj, rs) = (pearson(&joint, &truth), pearson(&stale, &truth));
    // The ceiling: the same frames solved with the right column throughout
    // (the store is exact for the traces as solved; traces solved under
    // the wrong column are biased, and nothing re-solves them).
    let (mut right, mut eng2) = start(joint_cfg(), &[fi.clone(), fj.clone()]);
    observe(&m, 0..t + 1, &mut right, &mut eng2, &mut Vec::new());
    let (_, best) = right
        .joint_estimate(&eng2.library().clone(), 1, ALL_GROUPS)
        .unwrap();
    let rb = pearson(&best, &truth);
    eprintln!(
        "neighbour change: store vs from-scratch {rel:.2e}; oracle r: store {rj:.4}, \
         fpstats {rs:.4}, right column throughout {rb:.4}"
    );
    assert!(rel < 1e-3, "store vs from-scratch: {rel}");
    assert!(rs < rj - 0.05, "fpstats {rs} vs store {rj}");
    // What remains is the traces' bias, not the statistics'.
    assert!(rj > rb - 0.04, "store {rj} vs ceiling {rb}");
}

#[test]
fn a_birth_restarts_the_pixels_under_the_newborn() {
    let (t, tb) = (4000, 1500);
    let mut rng = Lcg(5);
    let ci = trace(&mut rng, t, 0.03, 6.0);
    let cj = cofiring(&mut rng, &ci, 0.8);
    let (fi, fj) = (blob(1, 48.0, 44.0), blob(2, 48.0, 50.0));
    let m = movie(&[(fi.clone(), ci), (fj.clone(), cj)], t, 13);
    let (mut slow, mut eng) = start(joint_cfg(), std::slice::from_ref(&fi));
    let mut log = Vec::new();
    observe(&m, 0..tb, &mut slow, &mut eng, &mut log);
    // Cell 2 is found at frame `tb`.
    let (mut other, _) = start(joint_cfg(), &[fi.clone(), fj.clone()]);
    eng.set_library(other.finalize().unwrap()).unwrap();
    observe(&m, tb..t, &mut slow, &mut eng, &mut log);
    let lib = eng.library().clone();
    let d = slow.joint_stats_diag();
    let (pix, joint) = slow.joint_estimate(&lib, 1, ALL_GROUPS).unwrap();
    let (spix, _) = lib.filtered(lib.slot(2).unwrap());
    let mut late = vec![false; pix.len()];
    mark(&pix, spix, &mut late);
    let n_late = late.iter().filter(|&&l| l).count();
    assert!(n_late > 0);
    assert_eq!(d.restarted_px as usize, n_late, "{d:?}");
    // Exactly the fit of the frames since the birth on those pixels, of
    // every frame elsewhere.
    let scratch = from_scratch(&log, &lib, 1, &pix, &late, tb);
    let rel = max_diff(&joint, &scratch) / max_abs(&scratch);
    assert!(rel < 1e-3, "store vs from-scratch with epochs: {rel}");
    // The newborn's light is not in cell 1's footprint; the residual
    // statistics keep it from the frames before the birth.
    let (_, stale) = slow.residual_estimate(1).unwrap();
    let img = filtered(&fi);
    let bias = |e: &[f32]| -> f32 {
        (0..pix.len())
            .filter(|&k| late[k])
            .map(|k| (e[k] - img[pix[k] as usize]).abs())
            .fold(0.0, f32::max)
    };
    let (bj, bs) = (bias(&joint), bias(&stale));
    eprintln!("birth: max bias under the newborn: store {bj:.3}, fpstats {bs:.3}");
    assert!(bj * 2.0 < bs, "{bj} {bs}");
}

#[test]
fn keeping_the_store_changes_no_decision() {
    let t = 1500;
    let (m, seed) = busy_movie(t);
    let base = shard_config();
    let cfg = SlowLoopConfig {
        footprint_stats: FootprintStats::Joint,
        ..base.clone()
    };
    let n_px = N * N;
    let (mut a, mut ea) = start(base, &seed);
    let (mut b, mut eb) = start(cfg.clone(), &seed);
    // The joint run's visits go through the byte encoding.
    let mut runner = VisitRunner::new(new_loop(&cfg));
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let (ta, tb) = (ea.process(f).unwrap(), eb.process(f).unwrap());
        assert_eq!(ta.traces, tb.traces, "frame {k}");
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
    assert!(s.adds > 0 && s.merges > 0 && s.refines > 0, "{s:?}");
    assert_eq!(s, b.stats());
    assert_eq!(a.work(), b.work());
    let d = b.joint_stats_diag();
    assert_eq!(d.cells, b.fpstats.len());
    assert!(d.births > 0 && d.restarted_px > 0, "{d:?}");
    eprintln!("store after the busy run: {d:?}");
}

#[test]
fn a_job_carries_the_zone_stores_through_the_wire() {
    let t = 600;
    let (m, seed) = busy_movie(t);
    let cfg = SlowLoopConfig {
        footprint_stats: FootprintStats::Joint,
        ..shard_config()
    };
    let n_px = N * N;
    let (mut s, mut eng) = start(cfg, &seed);
    for k in 0..t {
        let f = &m[k * n_px..(k + 1) * n_px];
        let tr = eng.process(f).unwrap();
        let lib = eng.library().clone();
        s.observe(f, &lib, &tr).unwrap();
    }
    let mut jobs = 0;
    while let Some(job) = s.take_job() {
        let bytes = job.to_bytes();
        let back = VisitJob::from_bytes(&bytes).unwrap();
        assert_eq!(job.suff(), back.suff());
        for (id, st) in back.suff() {
            assert_eq!(st, &s.suff[id]);
        }
        if !job.suff().is_empty() {
            jobs += 1;
        }
        // A truncated buffer is an error, not a panic.
        assert!(VisitJob::from_bytes(&bytes[..bytes.len() - 9]).is_err());
    }
    assert!(jobs > 0);
}
