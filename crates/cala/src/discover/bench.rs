//! Micro-benchmark of the per-frame kernels of the footprint statistics and
//! the ledger (feature `timing`; measurement only, never in a shipped build):
//! the plain push ([`FpStats::push_frame`], every cell builds its residual)
//! against the mean-field push ([`FpStats::push_mean`] plus the shared field),
//! and the serial ledger sum against the eight-lane one, on given disk shapes
//! and trace zero shares. `examples/fpstats_bench.rs` drives it.

use super::evidence::{masked_dot, runs_dot};
use super::fpstats::pixel_runs;
use super::fpstats::{FpStats, Residual};
use super::reservoir::mix;
use std::time::Instant;

/// One cell of the benchmark: its statistics disk, its support (the ledger's
/// pixels, sorted) and the share of frames on which its trace is exactly 0.
#[derive(Debug, Clone)]
pub struct BenchCell {
    pub center: (f32, f32),
    pub disk_radius: f32,
    pub support: Vec<u32>,
    pub zero_share: f32,
}

/// Milliseconds per fitting frame of each arm (median of the repeats).
#[derive(Debug, Clone, Default)]
pub struct BenchReport {
    pub cells: usize,
    pub frames: usize,
    pub disk_px_mean: f64,
    pub support_px_mean: f64,
    /// Measured share of (cell, frame) pairs with a zero trace.
    pub zero_share: f64,
    /// Cells on the plain path at the end of the mean-field arm (a disk that
    /// met a missing sample).
    pub plain_cells: usize,
    pub old_fp_ms: f64,
    /// Mean-field arm in total, and its parts: the residual pass, the
    /// per-cell pushes and the field pass.
    pub new_fp_ms: f64,
    pub new_resid_ms: f64,
    pub new_cells_ms: f64,
    pub new_field_ms: f64,
    pub old_ledger_ms: f64,
    pub new_ledger_ms: f64,
    /// Largest difference between the arms' estimates at the end, relative to
    /// the disk's largest absolute estimate (over cells with estimates).
    pub max_rel_diff: f64,
}

fn unif(k: u64) -> f32 {
    (mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// Run both arms over `frames` fitting frames (`repeats` times each,
/// alternating). Frames are white noise plus a NaN border `nan_border` px
/// wide (0: none); every `version_every` frames each cell gets a new column.
#[allow(clippy::too_many_arguments)]
pub fn fpstats_bench(
    width: usize,
    height: usize,
    cells: &[BenchCell],
    frames: usize,
    version_every: usize,
    nan_border: usize,
    repeats: usize,
    seed: u64,
) -> BenchReport {
    let n_px = width * height;
    let fov = vec![1u8; n_px];
    let nf = 8;
    let frame_pool: Vec<Vec<f32>> = (0..nf)
        .map(|f| {
            (0..n_px)
                .map(|p| {
                    let (y, x) = (p / width, p % width);
                    let edge = y < nan_border
                        || x < nan_border
                        || y + nan_border >= height
                        || x + nan_border >= width;
                    if edge {
                        f32::NAN
                    } else {
                        3.0 * unif(seed ^ ((f * n_px + p) as u64))
                    }
                })
                .collect()
        })
        .collect();
    let model_pool: Vec<Vec<f32>> = (0..nf)
        .map(|f| {
            (0..n_px)
                .map(|p| unif(seed.wrapping_add(7) ^ ((f * n_px + p) as u64)))
                .collect()
        })
        .collect();
    let traces: Vec<Vec<f32>> = (0..frames)
        .map(|t| {
            cells
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let k = (t * cells.len() + i) as u64;
                    if unif(seed.wrapping_add(11) ^ k) + 0.5 < c.zero_share {
                        0.0
                    } else {
                        2.0 * unif(seed.wrapping_add(13) ^ k).abs() + 0.05
                    }
                })
                .collect()
        })
        .collect();
    let zeros = traces.iter().flatten().filter(|&&c| c == 0.0).count();
    let fresh = || -> Vec<FpStats> {
        cells
            .iter()
            .map(|c| FpStats::new(c.center, c.disk_radius, width, height, &fov, 5))
            .collect()
    };
    let col_of = |st: &FpStats, i: usize, v: usize| -> Vec<f32> {
        (0..st.pix.len())
            .map(|k| 0.5 + unif(seed ^ ((i * 1_000_003 + v * 7919 + k) as u64)))
            .collect()
    };
    let w_of = |t: usize| 1.0 + t as f32 * 1e-3;
    let level_of = |t: usize, i: usize| 0.1 * unif(seed.wrapping_add(17) ^ (t * 65_537 + i) as u64);

    let run_old = || -> (Vec<FpStats>, f64) {
        let mut sts = fresh();
        let mut buf = Vec::new();
        let t0 = Instant::now();
        for t in 0..frames {
            let (fr, md) = (&frame_pool[t % nf], &model_pool[t % nf]);
            for (i, st) in sts.iter_mut().enumerate() {
                if t % version_every == 0 {
                    st.col = col_of(st, i, t / version_every);
                }
                st.push_frame(fr, md, level_of(t, i), traces[t][i], w_of(t), &mut buf);
            }
        }
        (sts, t0.elapsed().as_secs_f64() * 1e3)
    };
    let run_new = || -> (Vec<FpStats>, Vec<f64>, [f64; 3]) {
        let mut sts = fresh();
        let mut p = vec![0.0f64; n_px];
        let mut resid = Residual::default();
        let mut buf = Vec::new();
        let mut ms = [0.0f64; 3];
        for t in 0..frames {
            let gen = t as u64;
            let (fr, md) = (&frame_pool[t % nf], &model_pool[t % nf]);
            let w = w_of(t);
            let t0 = Instant::now();
            resid.fill(fr, md);
            let t1 = Instant::now();
            for (i, st) in sts.iter_mut().enumerate() {
                if t % version_every == 0 {
                    let col = col_of(st, i, t / version_every);
                    st.set_col(col);
                }
                let (level, c) = (level_of(t, i), traces[t][i]);
                let complete = !resid.missing_in(st.runs());
                if complete {
                    st.rebase(&p, gen);
                } else {
                    st.materialise(&p);
                }
                if st.mf.is_none() {
                    st.push_frame(fr, md, level, c, w, &mut buf);
                } else {
                    st.push_mean(&resid.d, &p, level, c, w, true, gen + 1);
                }
            }
            let t2 = Instant::now();
            resid.add_to(&mut p, w);
            let t3 = Instant::now();
            ms[0] += (t1 - t0).as_secs_f64() * 1e3;
            ms[1] += (t2 - t1).as_secs_f64() * 1e3;
            ms[2] += (t3 - t2).as_secs_f64() * 1e3;
        }
        (sts, p, ms)
    };
    // Ledger: one weight per support pixel.
    let lw: Vec<Vec<f32>> = cells
        .iter()
        .enumerate()
        .map(|(i, c)| {
            (0..c.support.len())
                .map(|k| 0.1 + unif(seed.wrapping_add(19) ^ (i * 100_003 + k) as u64).abs())
                .collect()
        })
        .collect();
    let run_ledger_old = || -> (f64, f64) {
        let mut acc = 0.0f64;
        let t0 = Instant::now();
        for t in 0..frames {
            let (fr, md) = (&frame_pool[t % nf], &model_pool[t % nf]);
            for (c, w) in cells.iter().zip(&lw) {
                // The serial sum over the support, as the ledger kept it.
                let mut g = 0.0f32;
                let (mut n_miss, mut w_miss) = (0.0f32, 0.0f32);
                for (&p, &wk) in c.support.iter().zip(w) {
                    let y = fr[p as usize];
                    if y.is_finite() {
                        g += wk * (y - md[p as usize]);
                    } else {
                        n_miss += wk;
                        w_miss += wk;
                    }
                }
                acc += f64::from(g + n_miss + w_miss);
            }
        }
        (t0.elapsed().as_secs_f64() * 1e3, acc)
    };
    let runs: Vec<Vec<(u32, u32)>> = cells.iter().map(|c| pixel_runs(&c.support)).collect();
    let run_ledger_new = || -> (f64, f64) {
        let mut resid = Residual::default();
        let mut acc = 0.0f64;
        let mut ms = 0.0;
        for t in 0..frames {
            // The residual pass is shared with the statistics (timed there).
            resid.fill(&frame_pool[t % nf], &model_pool[t % nf]);
            let t0 = Instant::now();
            for ((c, w), r) in cells.iter().zip(&lw).zip(&runs) {
                let mut g = runs_dot(&resid.d, r, w);
                let (mut n_miss, mut w_miss) = (0.0f32, 0.0f32);
                if g.is_nan() {
                    (g, n_miss, w_miss) = masked_dot(&resid.d, &c.support, w, w);
                }
                acc += f64::from(g + n_miss + w_miss);
            }
            ms += t0.elapsed().as_secs_f64() * 1e3;
        }
        (ms, acc)
    };

    let mut rep = BenchReport {
        cells: cells.len(),
        frames,
        zero_share: zeros as f64 / (frames * cells.len()).max(1) as f64,
        ..BenchReport::default()
    };
    let (mut o, mut n, mut parts, mut lo, mut ln) =
        (vec![], vec![], vec![[0.0; 3]; 0], vec![], vec![]);
    let mut last = None;
    for _ in 0..repeats.max(1) {
        let (a, ms) = run_old();
        o.push(ms);
        let (b, p, ms3) = run_new();
        n.push(ms3.iter().sum());
        parts.push(ms3);
        lo.push(run_ledger_old().0);
        ln.push(run_ledger_new().0);
        last = Some((a, b, p));
    }
    let f = frames as f64;
    rep.old_fp_ms = median(o) / f;
    rep.new_fp_ms = median(n) / f;
    for (k, slot) in [
        &mut rep.new_resid_ms,
        &mut rep.new_cells_ms,
        &mut rep.new_field_ms,
    ]
    .into_iter()
    .enumerate()
    {
        *slot = median(parts.iter().map(|m| m[k]).collect()) / f;
    }
    rep.old_ledger_ms = median(lo) / f;
    rep.new_ledger_ms = median(ln) / f;
    let (a, b, p) = last.expect("one repeat");
    rep.plain_cells = b.iter().filter(|s| s.mf.is_none()).count();
    rep.disk_px_mean = a.iter().map(|s| s.pix.len() as f64).sum::<f64>() / a.len().max(1) as f64;
    rep.support_px_mean =
        cells.iter().map(|c| c.support.len() as f64).sum::<f64>() / cells.len().max(1) as f64;
    for (sa, sb) in a.iter().zip(&b) {
        let (Some(ea), Some(eb)) = (sa.estimate(), sb.materialised(&p).estimate()) else {
            continue;
        };
        let top = ea.iter().fold(0.0f32, |m, v| m.max(v.abs())).max(1e-12);
        for (x, y) in ea.iter().zip(&eb) {
            rep.max_rel_diff = rep.max_rel_diff.max(f64::from((x - y).abs() / top));
        }
    }
    rep
}
