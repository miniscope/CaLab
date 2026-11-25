//! Time the compression of dumped windows, single thread.
//!
//! ```text
//! cargo run --release --example compress_bench -- <window.i16> [--tile N] [--frames N]
//!     [--window N] [--k0 N] [--n-iter N] [--adaptive] [--seed-offset N]
//! ```
//!
//! `<window.i16>` comes from `discover_eval --compress-dump` (`CALAWIN1`, u32
//! width, height, frames, f32 quant, then i16 frames). `--frames N` uses only
//! the first N frames; `--window N` cuts them into windows of N frames
//! (default: one window of all of them). Prints ms per frame, the mean kept
//! rank, the mean rank of the last randomized SVD and the share of tiles that
//! doubled their sketch. The same file goes to
//! `apps/cala/scripts/compress-bench.mjs`, which times the WASM build.
//!
//! The options under test: `--k0`, `--n-iter`, `--adaptive` (each tile's
//! sketch starts near the rank it kept in the previous window)
//! and `--seed-offset` (other random draws: the noise floor of the loss).
//! With any of them, every tile is also compressed with today's defaults and
//! the loss against them is printed: `‖Ŷ − Ŷ_ref‖² / ‖Ŷ_ref‖²` over the
//! low-rank parts `W Vᵀ`.

use std::time::Instant;

use calab_cala::compress::{compress_tile, tile_config, CompressConfig, TileFactors};

/// `W Vᵀ` of a tile, `P x T` row-major.
fn low_rank(tf: &TileFactors, p: usize, t: usize) -> Vec<f64> {
    let mut out = vec![0.0f64; p * t];
    for i in 0..p {
        let w = &tf.spatial[i * tf.rank..(i + 1) * tf.rank];
        for (j, o) in out[i * t..(i + 1) * t].iter_mut().enumerate() {
            let v = &tf.temporal[j * tf.rank..(j + 1) * tf.rank];
            *o = w
                .iter()
                .zip(v)
                .map(|(&a, &b)| f64::from(a) * f64::from(b))
                .sum();
        }
    }
    out
}

#[derive(Default)]
struct Totals {
    secs: f64,
    tiles: usize,
    rank: usize,
    svd_rank: usize,
    doubled: usize,
    bytes: usize,
    ref_secs: f64,
    ref_rank: usize,
    diff2: f64,
    ref2: f64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("window.i16");
    let value = |key: &str| {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .map(|v| v.parse::<usize>().unwrap())
    };
    let flag = |key: &str| args.iter().any(|a| a == key);
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..8], b"CALAWIN1", "not a window dump");
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize;
    let (width, height, stored) = (u32_at(8), u32_at(12), u32_at(16));
    let quant = f32::from_le_bytes(bytes[20..24].try_into().unwrap());
    let frames = value("--frames").map_or(stored, |n| n.min(stored));
    let window = value("--window").unwrap_or(frames).min(frames);
    let tile = value("--tile").unwrap_or(64);
    let adaptive = flag("--adaptive");
    let seed_offset = value("--seed-offset").unwrap_or(0) as u64;
    let px = width * height;
    let data: Vec<i16> = bytes[24..24 + frames * px * 2]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b))
        .collect();
    let base = CompressConfig {
        quant,
        ..CompressConfig::default()
    };
    let cfg = CompressConfig {
        k0: value("--k0").unwrap_or(base.k0),
        n_iter: value("--n-iter").unwrap_or(base.n_iter),
        ..base.clone()
    };
    let compare = cfg != base || adaptive || seed_offset != 0;
    let mut tot = Totals::default();
    let mut prev_rank: Vec<Option<usize>> = Vec::new();
    let mut raw = Vec::new();
    for w0 in (0..frames - window + 1).step_by(window) {
        let mut ti = 0;
        for y0 in (0..height).step_by(tile) {
            for x0 in (0..width).step_by(tile) {
                let (w, h) = (tile.min(width - x0), tile.min(height - y0));
                raw.clear();
                for t in w0..w0 + window {
                    for y in 0..h {
                        let row = t * px + (y0 + y) * width + x0;
                        raw.extend_from_slice(&data[row..row + w]);
                    }
                }
                if prev_rank.len() <= ti {
                    prev_rank.push(None);
                }
                let tcfg = tile_config(&cfg, prev_rank[ti].filter(|_| adaptive));
                let seed = (w0 * 1000 + ti) as u64;
                let t0 = Instant::now();
                let tf = compress_tile(&raw, window, w * h, &tcfg, seed + seed_offset);
                tot.secs += t0.elapsed().as_secs_f64();
                tot.rank += tf.rank;
                tot.svd_rank += tf.svd_rank;
                tot.bytes += tf.bytes();
                let k_cap = tcfg.max_rank.min(w * h - 1).min(window - 1);
                tot.doubled += usize::from(tf.svd_rank > tcfg.k0.min(k_cap));
                prev_rank[ti] = Some(tf.rank);
                if compare {
                    let t0 = Instant::now();
                    let rf = compress_tile(&raw, window, w * h, &base, seed);
                    tot.ref_secs += t0.elapsed().as_secs_f64();
                    tot.ref_rank += rf.rank;
                    let a = low_rank(&tf, w * h, window);
                    let b = low_rank(&rf, w * h, window);
                    tot.diff2 += a
                        .iter()
                        .zip(&b)
                        .map(|(x, y)| (x - y) * (x - y))
                        .sum::<f64>();
                    tot.ref2 += b.iter().map(|y| y * y).sum::<f64>();
                }
                tot.tiles += 1;
                ti += 1;
            }
        }
    }
    let used = (frames / window) * window;
    let n = tot.tiles as f64;
    println!(
        "native: {width}x{height}, {used} frames in windows of {window}, {} tiles: {:.2} ms/frame, \
         mean rank {:.1}, svd rank {:.1}, {:.0} % doubled, {:.0} bytes/frame",
        tot.tiles,
        tot.secs * 1e3 / used as f64,
        tot.rank as f64 / n,
        tot.svd_rank as f64 / n,
        100.0 * tot.doubled as f64 / n,
        tot.bytes as f64 / used as f64,
    );
    if compare {
        println!(
            "today (k0 {}, n_iter {}): {:.2} ms/frame, mean rank {:.1}; relative loss {:.2e}",
            base.k0,
            base.n_iter,
            tot.ref_secs * 1e3 / used as f64,
            tot.ref_rank as f64 / n,
            tot.diff2 / tot.ref2.max(1e-30)
        );
    }
}
