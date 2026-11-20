//! Run the history review ([`calab_cala::compress::review`]) on a finished
//! run: `footprints.bin` (`CALAFP01`) and `factors/w*.fac` (`CALAFAC1`, from
//! `discover_eval --factors-out`).
//!
//! ```text
//! cargo run --release --example history_review -- <run dir> [--threads N] [--stride S]
//! ```
//!
//! Writes `<run dir>/history_review.tsv` (one row per grid spot) and
//! `history_review_candidates.tsv`, the tables
//! tools/cala-diagnostics/history_wholetest.py writes offline.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use calab_cala::compress::review::{candidates, scan, KnownCell, ReviewConfig};
use calab_cala::compress::WindowFactors;
use calab_cala::preprocess::Dims;

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// A library cell: pixel indices and unfiltered values.
type Cell = (Vec<u32>, Vec<f32>);

/// `(dims, cells)` of a `footprints.bin`.
fn read_library(path: &Path) -> (Dims, Vec<Cell>) {
    let b = fs::read(path).expect("footprints.bin");
    assert_eq!(&b[..8], b"CALAFP01", "not a footprints.bin");
    let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
    let (h, w, n) = (u(8), u(12), u(16));
    let mut at = 20;
    let mut cells = Vec::with_capacity(n);
    for _ in 0..n {
        let k = u(at + 4);
        at += 8;
        let pix = (0..k).map(|i| u(at + 4 * i) as u32).collect();
        at += 4 * k;
        let val = (0..k)
            .map(|i| f32::from_le_bytes(b[at + 4 * i..at + 4 * i + 4].try_into().unwrap()))
            .collect();
        at += 8 * k;
        cells.push((pix, val));
    }
    (Dims::new(w, h).expect("frame size"), cells)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let run = PathBuf::from(args.get(1).expect("run dir"));
    let (dims, lib) = read_library(&run.join("footprints.bin"));
    let mut files: Vec<PathBuf> = fs::read_dir(run.join("factors"))
        .expect("factors dir")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "fac"))
        .collect();
    files.sort();
    let windows: Vec<WindowFactors> = files
        .iter()
        .map(|p| WindowFactors::from_bytes(&fs::read(p).unwrap()).expect("factor file"))
        .collect();
    let cfg = ReviewConfig {
        threads: arg_value(&args, "--threads").map_or(8, |s| s.parse().unwrap()),
        stride: arg_value(&args, "--stride").map_or(4, |s| s.parse().unwrap()),
        ..ReviewConfig::default()
    };
    let cells: Vec<KnownCell> = lib
        .iter()
        .map(|(pix, val)| KnownCell { pix, val })
        .collect();
    let t0 = Instant::now();
    let stats = scan(&windows, &cells, dims, &cfg);
    let scan_s = t0.elapsed().as_secs_f64();
    let cands = candidates(&stats, &cells, dims, &cfg);
    let mut t = String::from("y\tx\tcos\tgain\twidth\tshift\tnb_corr\txscore\n");
    for s in &stats {
        t.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            s.y, s.x, s.cos, s.gain, s.width, s.shift, s.neighbour_corr, s.events
        ));
    }
    fs::write(run.join("history_review.tsv"), t).unwrap();
    let mut t = String::from("y\tx\tgain_z\tevents_z\n");
    for c in &cands {
        t.push_str(&format!(
            "{}\t{}\t{:.2}\t{:.2}\n",
            c.center.0, c.center.1, c.gain_z, c.events_z
        ));
    }
    fs::write(run.join("history_review_candidates.tsv"), t).unwrap();
    println!(
        "{} windows, {} cells, {} spots in {scan_s:.1} s ({} threads): {} candidates",
        windows.len(),
        cells.len(),
        stats.len(),
        cfg.threads,
        cands.len()
    );
}
