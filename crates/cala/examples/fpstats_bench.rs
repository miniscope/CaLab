//! Micro-benchmark of the footprint statistics' per-frame kernels (plain
//! against mean-field push, serial against eight-lane ledger sum) on the cell
//! shapes of a finished run (`calab_cala::discover::bench`). Needs the
//! `timing` feature:
//!
//! ```text
//! cargo run --release --no-default-features --features timing --example fpstats_bench -- \
//!     RUN_DIR [--frames 600] [--margin 4] [--nan-border 0] [--version-every 100] \
//!     [--repeats 3] [--cells N] [--clusters]
//! ```
//!
//! `RUN_DIR` holds a `qc_eval` run's `footprints.bin` (`CALAFP01`) and
//! `cells.tsv`. Each cell's statistics disk is its support disk (the support
//! centre and radius as `trace::support_disk` computes them) plus `--margin`
//! px (`stats_margin_cells × cell_diameter_px`, 4 px at the defaults); its
//! trace is zero on a share of frames equal to its `zero_frac` in the last
//! QC row of `cells.tsv`. `--cells N` repeats or truncates the cell list to
//! N cells. Prints one TSV header and one row.
//!
//! `--clusters` benchmarks the cluster stores' push instead (plain against
//! mean-field, `discover::bench::cluster_bench`): the cells are clustered as
//! the slow loop does (normalised footprint overlaps, `--rho-min 0.05`,
//! `--k-max 6`), each cluster on the union of its members' statistics
//! disks, with ring levels; every `--version-every` frames each cluster
//! takes new columns.

use calab_cala::discover::bench::{bench_clusters, cluster_bench, fpstats_bench, BenchCell};
use std::collections::HashMap;
use std::path::PathBuf;

fn arg<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// `(height, width, cells as (id, pixels, unfiltered values))`.
type Cells = Vec<(u32, Vec<u32>, Vec<f32>)>;

fn read_footprints(path: &PathBuf) -> (usize, usize, Cells) {
    let b = std::fs::read(path).expect("footprints.bin");
    assert_eq!(&b[..8], b"CALAFP01", "not a footprints.bin");
    let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let f = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let (h, w, n) = (u(8) as usize, u(12) as usize, u(16) as usize);
    let mut at = 20;
    let mut cells = Vec::with_capacity(n);
    for _ in 0..n {
        let (id, k) = (u(at), u(at + 4) as usize);
        at += 8;
        let pix = (0..k).map(|i| u(at + 4 * i)).collect();
        at += 4 * k;
        let val = (0..k).map(|i| f(at + 4 * i)).collect();
        at += 8 * k;
        cells.push((id, pix, val));
    }
    (h, w, cells)
}

/// `zero_frac` per cell id in the last frame's rows of `cells.tsv`.
fn zero_fracs(path: &PathBuf) -> HashMap<u32, f32> {
    let text = std::fs::read_to_string(path).expect("cells.tsv");
    let mut lines = text.lines();
    let head: Vec<&str> = lines.next().expect("header").split('\t').collect();
    let col = |n: &str| head.iter().position(|h| *h == n).expect(n);
    let (fi, ii, zi) = (col("frame"), col("id"), col("zero_frac"));
    let rows: Vec<Vec<&str>> = lines.map(|l| l.split('\t').collect()).collect();
    let last = rows
        .iter()
        .map(|r| r[fi])
        .max_by_key(|v| v.parse::<u64>().unwrap_or(0));
    rows.iter()
        .filter(|r| Some(r[fi]) == last)
        .filter_map(|r| {
            let id = r[ii].parse::<f32>().ok()? as u32;
            let z = r[zi].parse::<f32>().ok().filter(|z| z.is_finite())?;
            Some((id, z))
        })
        .collect()
}

/// Support centre (weighted over the values at least half the peak) and
/// radius (farthest positive value), as `trace::support_disk`.
fn support(pix: &[u32], val: &[f32], width: usize) -> ((f32, f32), f32) {
    let peak = val.iter().copied().fold(0.0f32, f32::max);
    let (mut sw, mut sy, mut sx) = (0.0f64, 0.0f64, 0.0f64);
    for (&p, &v) in pix.iter().zip(val) {
        if v >= 0.5 * peak {
            let (y, x) = ((p as usize / width) as f64, (p as usize % width) as f64);
            sw += f64::from(v);
            sy += f64::from(v) * y;
            sx += f64::from(v) * x;
        }
    }
    let (cy, cx) = ((sy / sw) as f32, (sx / sw) as f32);
    let mut r2 = 0.0f32;
    for (&p, &v) in pix.iter().zip(val) {
        if v > 0.0 {
            let (dy, dx) = (
                (p as usize / width) as f32 - cy,
                (p as usize % width) as f32 - cx,
            );
            r2 = r2.max(dy * dy + dx * dx);
        }
    }
    ((cy, cx), r2.sqrt() + 1e-3)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let run = PathBuf::from(args.get(1).expect("RUN_DIR"));
    let (h, w, fp) = read_footprints(&run.join("footprints.bin"));
    let zf = zero_fracs(&run.join("cells.tsv"));
    let margin: f32 = arg(&args, "--margin", 4.0);
    let mut cells: Vec<BenchCell> = fp
        .iter()
        .map(|(id, pix, val)| {
            let (center, r) = support(pix, val, w);
            let mut sup = pix.clone();
            sup.sort_unstable();
            BenchCell {
                center,
                disk_radius: r + margin,
                support: sup,
                zero_share: zf.get(id).copied().unwrap_or(0.0),
            }
        })
        .collect();
    if args.iter().any(|a| a == "--clusters") {
        let pix: Vec<Vec<u32>> = fp.iter().map(|c| c.1.clone()).collect();
        let vals: Vec<Vec<f32>> = fp.iter().map(|c| c.2.clone()).collect();
        let groups = bench_clusters(
            &pix,
            &vals,
            arg(&args, "--rho-min", 0.05),
            arg(&args, "--k-max", 6),
        );
        let rep = cluster_bench(
            w,
            h,
            &cells,
            &groups,
            arg(&args, "--frames", 600),
            arg(&args, "--version-every", 8),
            arg(&args, "--repeats", 3),
            1,
        );
        println!("clusters\tmembers\tpx_mean\trank_mean\tzero_share\told_ms\tnew_ms\tspeedup\tmax_rel_diff");
        println!(
            "{}\t{}\t{:.1}\t{:.2}\t{:.3}\t{:.4}\t{:.4}\t{:.2}\t{:.2e}",
            rep.clusters,
            rep.members,
            rep.px_mean,
            rep.rank_mean,
            rep.zero_share,
            rep.old_ms,
            rep.new_ms,
            rep.old_ms / rep.new_ms,
            rep.max_rel_diff
        );
        return;
    }
    let want: usize = arg(&args, "--cells", cells.len());
    let base = cells.clone();
    cells = (0..want).map(|i| base[i % base.len()].clone()).collect();
    let rep = fpstats_bench(
        w,
        h,
        &cells,
        arg(&args, "--frames", 600),
        arg(&args, "--version-every", 100),
        arg(&args, "--nan-border", 0),
        arg(&args, "--repeats", 3),
        1,
    );
    println!(
        "cells\tframes\tdisk_px\tsupport_px\tzero_share\tplain_cells\told_fp_ms\tnew_fp_ms\t\
         new_resid_ms\tnew_cells_ms\tnew_field_ms\tfp_speedup\told_ledger_ms\tnew_ledger_ms\t\
         ledger_speedup\tmax_rel_diff"
    );
    println!(
        "{}\t{}\t{:.1}\t{:.1}\t{:.3}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.2}\t{:.4}\t{:.4}\t{:.2}\t{:.2e}",
        rep.cells,
        rep.frames,
        rep.disk_px_mean,
        rep.support_px_mean,
        rep.zero_share,
        rep.plain_cells,
        rep.old_fp_ms,
        rep.new_fp_ms,
        rep.new_resid_ms,
        rep.new_cells_ms,
        rep.new_field_ms,
        rep.old_fp_ms / rep.new_fp_ms,
        rep.old_ledger_ms,
        rep.new_ledger_ms,
        rep.old_ledger_ms / rep.new_ledger_ms,
        rep.max_rel_diff
    );
}
