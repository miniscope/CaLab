//! Time the compression of one dumped window, single thread.
//!
//! ```text
//! cargo run --release --example compress_bench -- <window.i16> [--tile N] [--frames N]
//! ```
//!
//! `<window.i16>` comes from `discover_eval --compress-dump` (`CALAWIN1`, u32
//! width, height, frames, f32 quant, then i16 frames). `--frames N` uses only
//! the first N frames (a shorter window). Prints ms per frame, the mean kept
//! rank and the mean rank of the last randomized SVD. The same file goes to
//! `apps/cala/scripts/compress-bench.mjs`, which times the WASM build.

use std::time::Instant;

use calab_cala::compress::{compress_tile, CompressConfig};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("window.i16");
    let value = |key: &str| {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .map(|v| v.parse::<usize>().unwrap())
    };
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..8], b"CALAWIN1", "not a window dump");
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize;
    let (width, height, stored) = (u32_at(8), u32_at(12), u32_at(16));
    let quant = f32::from_le_bytes(bytes[20..24].try_into().unwrap());
    let frames = value("--frames").map_or(stored, |n| n.min(stored));
    let tile = value("--tile").unwrap_or(64);
    let px = width * height;
    let data: Vec<i16> = bytes[24..24 + frames * px * 2]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b))
        .collect();
    let cfg = CompressConfig {
        quant,
        ..CompressConfig::default()
    };
    let (mut secs, mut rank, mut svd_rank, mut tiles, mut bytes_out) = (0.0f64, 0, 0, 0, 0);
    let mut raw = Vec::new();
    for y0 in (0..height).step_by(tile) {
        for x0 in (0..width).step_by(tile) {
            let (w, h) = (tile.min(width - x0), tile.min(height - y0));
            raw.clear();
            for t in 0..frames {
                for y in 0..h {
                    let row = t * px + (y0 + y) * width + x0;
                    raw.extend_from_slice(&data[row..row + w]);
                }
            }
            let t0 = Instant::now();
            let tf = compress_tile(&raw, frames, w * h, &cfg, tiles as u64);
            secs += t0.elapsed().as_secs_f64();
            rank += tf.rank;
            svd_rank += tf.svd_rank;
            bytes_out += tf.bytes();
            tiles += 1;
        }
    }
    println!(
        "native: {width}x{height}, {frames} frames, {tiles} tiles: {:.2} ms/frame, mean rank {:.1}, svd rank {:.1}, {:.0} bytes/frame",
        secs * 1e3 / frames as f64,
        rank as f64 / tiles as f64,
        svd_rank as f64 / tiles as f64,
        bytes_out as f64 / frames as f64,
    );
}
