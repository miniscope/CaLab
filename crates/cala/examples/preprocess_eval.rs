//! Evaluate the non-motion preprocessing chain on a real Miniscope recording.
//!
//! ```text
//! cargo run --release --example preprocess_eval -- <recording dir> <out dir> [frames]
//! ```
//!
//! Reads `0.avi, 1.avi, ...` with the crate's AVI parser, calibrates on the
//! first `warmup_frames`, runs the whole chain (no motion correction) over the
//! first `frames` frames (default 4000: on the workshop CA1 data that spans
//! the brightness step at the file 1 -> 2 boundary, frame 2000), and reports:
//! FOV area, hot-pixel counts, row/column structure before and after, the
//! background across the brightness step, the noise map, and throughput.
//! Images go to `<out dir>` as little-endian float PFM (`Pf`) files.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::preprocess::hot_pixels::{FLAG_COLD, FLAG_HOT, FLAG_STUCK};
use calab_cala::preprocess::lines::{LineCorrector, LineMode};
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};

/// One AVI file of the recording.
struct Avi {
    file: File,
    header: AviHeader,
}

impl Avi {
    fn open(path: &Path) -> Avi {
        let mut file = File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let size = file.metadata().unwrap().len();
        let mut prefix = vec![0u8; (64 * 1024).min(size as usize)];
        file.read_exact(&mut prefix).unwrap();
        let layout = AviHeader::parse_header(&prefix).expect("AVI header");
        let mut idx1 = None;
        if layout.info.movi_end > 0 && layout.info.movi_end + 8 <= size {
            let mut hdr = [0u8; 8];
            file.seek(SeekFrom::Start(layout.info.movi_end)).unwrap();
            file.read_exact(&mut hdr).unwrap();
            if let Ok(len) = idx1_payload_len(&hdr) {
                let mut payload = vec![0u8; len as usize];
                file.read_exact(&mut payload).unwrap();
                idx1 = Some(payload);
            }
        }
        let header = AviHeader::parse_with_size(&prefix, idx1.as_deref(), size).expect("AVI index");
        Avi { file, header }
    }

    /// Append frames `start..start + count` (8-bit) to `out`.
    fn read(&mut self, start: u32, count: u32, out: &mut Vec<u8>) {
        let px = self.header.pixel_bytes();
        let mut s = start;
        while s < start + count {
            let run = self.header.contiguous_run(s, start + count - s).max(1);
            let (a, b) = self.header.span_range(s, run).unwrap();
            let mut span = vec![0u8; (b - a) as usize];
            self.file.seek(SeekFrom::Start(a)).unwrap();
            self.file.read_exact(&mut span).unwrap();
            let o = out.len();
            out.resize(o + run as usize * px, 0);
            self.header
                .decode_span_into(&span, run, &mut out[o..])
                .unwrap();
            s += run;
        }
    }
}

/// The numbered AVIs of a recording directory, read as one frame stream.
struct Recording {
    files: Vec<Avi>,
    starts: Vec<u32>,
    dims: Dims,
    total: u32,
}

impl Recording {
    fn open(dir: &Path) -> Recording {
        let mut files = Vec::new();
        for i in 0.. {
            let p = dir.join(format!("{i}.avi"));
            if !p.exists() {
                break;
            }
            files.push(Avi::open(&p));
        }
        assert!(!files.is_empty(), "no 0.avi in {dir:?}");
        let mut starts = Vec::new();
        let mut total = 0;
        for f in &files {
            starts.push(total);
            total += f.header.frame_count();
        }
        let info = files[0].header.info();
        assert_eq!(info.bit_depth, 8, "this evaluation reads 8-bit video");
        let dims = Dims::new(info.width as usize, info.height as usize).unwrap();
        Recording {
            files,
            starts,
            dims,
            total,
        }
    }

    /// Frames `start..start + count` as one buffer.
    fn read(&mut self, start: u32, count: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(count as usize * self.dims.pixels());
        let mut s = start;
        while s < start + count {
            let k = self.starts.partition_point(|&x| x <= s) - 1;
            let local = s - self.starts[k];
            let n = (self.files[k].header.frame_count() - local).min(start + count - s);
            self.files[k].read(local, n, &mut out);
            s += n;
        }
        out
    }
}

fn write_pfm(dir: &Path, name: &str, dims: Dims, img: &[f32]) {
    let mut f = File::create(dir.join(format!("{name}.pfm"))).unwrap();
    write!(f, "Pf\n{} {}\n-1.0\n", dims.width, dims.height).unwrap();
    // PFM stores rows bottom-up.
    for row in img.chunks_exact(dims.width).rev() {
        for v in row {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }
}

fn median(mut v: Vec<f32>) -> f32 {
    if v.is_empty() {
        return f32::NAN;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// Profiles of an image along rows and columns (FOV pixels; lines with
/// < 32 of them are NaN), and the RMS of each profile minus its own 9-sample
/// moving average (line-scale structure; the slow vignette part is removed).
fn line_structure(img: &[f32], mask: &[u8], dims: Dims) -> (f32, f32, f32, f32) {
    let profile = |rows: bool| -> Vec<f64> {
        let (outer, inner) = if rows {
            (dims.height, dims.width)
        } else {
            (dims.width, dims.height)
        };
        (0..outer)
            .map(|a| {
                let (mut s, mut k) = (0.0f64, 0usize);
                for b in 0..inner {
                    let i = if rows {
                        a * dims.width + b
                    } else {
                        b * dims.width + a
                    };
                    if mask[i] != 0 {
                        s += f64::from(img[i]);
                        k += 1;
                    }
                }
                if k >= 32 {
                    s / k as f64
                } else {
                    f64::NAN
                }
            })
            .collect()
    };
    let stats = |p: &[f64]| -> (f32, f32) {
        let fin: Vec<f64> = p.iter().cloned().filter(|v| v.is_finite()).collect();
        let m = fin.iter().sum::<f64>() / fin.len() as f64;
        let std = (fin.iter().map(|v| (v - m).powi(2)).sum::<f64>() / fin.len() as f64).sqrt();
        let hp: Vec<f64> = (4..p.len().saturating_sub(4))
            .filter(|&i| (i - 4..=i + 4).all(|j| p[j].is_finite()))
            .map(|i| p[i] - (i - 4..=i + 4).map(|j| p[j]).sum::<f64>() / 9.0)
            .collect();
        let hp_rms = (hp.iter().map(|v| v * v).sum::<f64>() / hp.len().max(1) as f64).sqrt();
        (std as f32, hp_rms as f32)
    };
    let (rs, rh) = stats(&profile(true));
    let (cs, ch) = stats(&profile(false));
    (rs, rh, cs, ch)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(args.get(1).map(String::as_str).unwrap_or(
        "/Users/daharoni/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw",
    ));
    let out_dir = PathBuf::from(
        args.get(2)
            .map(String::as_str)
            .unwrap_or("preprocess_eval_out"),
    );
    std::fs::create_dir_all(&out_dir).unwrap();
    let mut rec = Recording::open(&dir);
    let frames: u32 = args
        .get(3)
        .map(|s| s.parse().unwrap())
        .unwrap_or(4000)
        .min(rec.total);
    let dims = rec.dims;
    let n = dims.pixels();
    let fps = 20.0;
    let cfg = PreprocessConfig::for_fps(fps);
    println!(
        "recording: {} files, {} frames, {}x{}; evaluating {frames} frames",
        rec.files.len(),
        rec.total,
        dims.width,
        dims.height
    );

    // ---- warm-up and calibration
    let t0 = Instant::now();
    let warm = rec.read(0, cfg.warmup_frames as u32);
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n) {
        acc.push(f).unwrap();
    }
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let t_cal = t0.elapsed().as_secs_f64();
    let fov = cal.fov();
    let hot = cal.hot_pixels();
    let mean_w = acc.mean().unwrap();
    // The reference metric used to describe this recording: mean image vs
    // its 5x5 median, raw counts above +10 / +25.
    let mut ref10 = 0;
    let mut ref25 = 0;
    let mut maxdev = 0.0f32;
    {
        let w = dims.width;
        for y in 0..dims.height {
            for x in 0..w {
                let mut v = Vec::with_capacity(25);
                for yy in y.saturating_sub(2)..=(y + 2).min(dims.height - 1) {
                    for xx in x.saturating_sub(2)..=(x + 2).min(w - 1) {
                        v.push(mean_w[yy * w + xx]);
                    }
                }
                let d = mean_w[y * w + x] - median(v);
                ref10 += usize::from(d > 10.0);
                ref25 += usize::from(d > 25.0);
                maxdev = maxdev.max(d);
            }
        }
    }
    println!(
        "\n== calibration ({} warm-up frames, {t_cal:.2} s)",
        cfg.warmup_frames
    );
    println!(
        "FOV: area {} px ({:.1} % of the frame), threshold {:.1} grey levels",
        fov.area(),
        100.0 * fov.area() as f64 / n as f64,
        fov.threshold()
    );
    println!(
        "defects: {} hot, {} cold, {} stuck (k = {}, global sigma_r {:.2}); \
         reference metric on these frames: {ref10} > +10, {ref25} > +25, max +{maxdev:.0} \
         (recording description: ~209 / ~18 / +126)",
        hot.count(FLAG_HOT),
        hot.count(FLAG_COLD),
        hot.count(FLAG_STUCK),
        cfg.hot.k_sigma,
        hot.sigma()
    );
    let flags_hot: Vec<f32> = hot.flags().iter().map(|&f| f32::from(f)).collect();
    write_pfm(&out_dir, "fov_mask", dims, &fov.weights());
    write_pfm(&out_dir, "hot_pixels", dims, &flags_hot);

    // ---- the chain over `frames` frames
    let mut p = Preprocessor::new(cal.clone(), &cfg).unwrap();
    // The same chain with the line stage off, for the line-structure analysis.
    let cfg_off = PreprocessConfig {
        lines: LineMode::Off,
        ..cfg
    };
    let mut p_off = Preprocessor::new(cal.clone(), &cfg_off).unwrap();
    let mut lines_both = LineCorrector::new(fov, LineMode::Both);
    let mut out = vec![0.0f32; n];
    let mut front = vec![0.0f32; n];
    let mean_span = 2000.min(frames);
    let mut raw_mean = vec![0.0f64; n];
    let mut flat_mean = vec![0.0f64; n];
    let mut lines_mean = vec![0.0f64; n];
    let mut out_mean = vec![0.0f64; n];
    let mut records = Vec::with_capacity(frames as usize);
    // Per-frame row / column means of the flattened frame (FOV pixels).
    let mut row_means: Vec<Vec<f32>> = Vec::new();
    let mut col_means: Vec<Vec<f32>> = Vec::new();
    let row_n: Vec<usize> = (0..dims.height)
        .map(|y| {
            fov.mask()[y * dims.width..(y + 1) * dims.width]
                .iter()
                .filter(|&&m| m != 0)
                .count()
        })
        .collect();
    let col_n: Vec<usize> = (0..dims.width)
        .map(|x| {
            (0..dims.height)
                .filter(|&y| fov.mask()[y * dims.width + x] != 0)
                .count()
        })
        .collect();
    // 9x9 blocks fully inside the FOV (stand-ins for cell footprints), for
    // trace-level noise with and without line correction.
    let blocks: Vec<usize> = (0..dims.height.saturating_sub(9))
        .step_by(30)
        .flat_map(|y| {
            (0..dims.width.saturating_sub(9))
                .step_by(30)
                .map(move |x| (y, x))
        })
        .filter(|&(y, x)| {
            (0..9).all(|dy| (0..9).all(|dx| fov.contains((y + dy) * dims.width + x + dx)))
        })
        .map(|(y, x)| y * dims.width + x)
        .collect();
    let block_mean = |img: &[f32], b: usize| -> f32 {
        let mut s = 0.0f32;
        for dy in 0..9 {
            for dx in 0..9 {
                s += img[b + dy * dims.width + dx];
            }
        }
        s / 81.0
    };
    let mut block_traces: [Vec<Vec<f32>>; 3] = [vec![], vec![], vec![]];
    let mut lines_rows = LineCorrector::new(fov, LineMode::Rows);
    let mut tmp = vec![0.0f32; n];
    // Every 97th FOV pixel of the final output, for the noise estimators.
    let sample_px: Vec<usize> = (0..n).filter(|&i| fov.contains(i)).step_by(97).collect();
    let mut px_traces: Vec<Vec<f32>> = Vec::new();
    let mut chain_secs = 0.0f64;
    let mut io_secs = 0.0f64;
    let batch = 100u32;
    let mut t = 0u32;
    while t < frames {
        let k = batch.min(frames - t);
        let ti = Instant::now();
        let buf = rec.read(t, k);
        io_secs += ti.elapsed().as_secs_f64();
        for (j, raw) in buf.chunks_exact(n).enumerate() {
            let ft = t + j as u32;
            let tc = Instant::now();
            let r = p.process_frame(raw, &mut out).unwrap();
            chain_secs += tc.elapsed().as_secs_f64();
            records.push(r);
            px_traces.push(sample_px.iter().map(|&i| out[i]).collect());
            if ft < mean_span {
                p_off.front(raw, &mut front).unwrap();
                let mut rm = vec![0.0f64; dims.height];
                let mut cm = vec![0.0f64; dims.width];
                for i in 0..n {
                    raw_mean[i] += f64::from(raw[i]);
                    flat_mean[i] += f64::from(front[i]);
                    out_mean[i] += f64::from(out[i]);
                    if fov.contains(i) {
                        rm[i / dims.width] += f64::from(front[i]);
                        cm[i % dims.width] += f64::from(front[i]);
                    }
                }
                row_means.push(
                    rm.iter()
                        .zip(&row_n)
                        .map(|(s, &c)| (s / c.max(1) as f64) as f32)
                        .collect(),
                );
                col_means.push(
                    cm.iter()
                        .zip(&col_n)
                        .map(|(s, &c)| (s / c.max(1) as f64) as f32)
                        .collect(),
                );
                block_traces[0].push(blocks.iter().map(|&b| block_mean(&front, b)).collect());
                tmp.copy_from_slice(&front);
                lines_rows.apply(&mut tmp).unwrap();
                block_traces[1].push(blocks.iter().map(|&b| block_mean(&tmp, b)).collect());
                lines_both.apply(&mut front).unwrap();
                block_traces[2].push(blocks.iter().map(|&b| block_mean(&front, b)).collect());
                for i in 0..n {
                    lines_mean[i] += f64::from(front[i]);
                }
            }
        }
        t += k;
    }
    let scale = |v: &[f64]| -> Vec<f32> {
        v.iter()
            .map(|x| (x / f64::from(mean_span)) as f32)
            .collect()
    };
    let (raw_mean, flat_mean, lines_mean, out_mean) = (
        scale(&raw_mean),
        scale(&flat_mean),
        scale(&lines_mean),
        scale(&out_mean),
    );
    write_pfm(&out_dir, "mean_raw", dims, &raw_mean);
    write_pfm(&out_dir, "mean_flattened", dims, &flat_mean);
    write_pfm(&out_dir, "mean_preprocessed", dims, &out_mean);
    write_pfm(
        &out_dir,
        "background",
        dims,
        p.background().final_estimate(),
    );
    let sigma = p.noise().sigma();
    write_pfm(&out_dir, "noise_sigma", dims, &sigma);

    // ---- row / column structure
    println!("\n== row / column structure (mean of the first {mean_span} frames, FOV pixels)");
    println!("profile std and line-scale RMS (profile minus its 9-line moving average):");
    for (name, img) in [
        ("raw", &raw_mean),
        ("flattened", &flat_mean),
        ("flattened + lines (both)", &lines_mean),
        ("preprocessed output", &out_mean),
    ] {
        let (rs, rh, cs, ch) = line_structure(img, fov.mask(), dims);
        println!("  {name:26} rows: std {rs:7.3} line-scale {rh:6.3} | cols: std {cs:7.3} line-scale {ch:6.3}");
    }
    // Per-frame line noise: temporal std of each row's (column's) mean after
    // flattening, against what pixel noise alone gives (σ / √n).
    let temporal = |m: &[Vec<f32>], counts: &[usize]| -> (f32, f32) {
        let l = m[0].len();
        let mut obs = Vec::new();
        let mut exp = Vec::new();
        let sig_med = median(
            (0..n)
                .filter(|&i| fov.contains(i))
                .map(|i| sigma[i])
                .collect(),
        );
        for j in 0..l {
            if counts[j] < 32 {
                continue;
            }
            // Differences of consecutive frames remove the slow part (cells'
            // activity, drift); /√2 for the difference.
            let d: Vec<f32> = m.windows(2).map(|w| (w[1][j] - w[0][j]).abs()).collect();
            obs.push(median(d) / (0.674_49 * std::f32::consts::SQRT_2));
            exp.push(sig_med / (counts[j] as f32).sqrt());
        }
        (median(obs), median(exp))
    };
    let (ro, re) = temporal(&row_means, &row_n);
    let (co, ce) = temporal(&col_means, &col_n);
    println!(
        "per-frame line noise (MAD-diff σ of a line's mean, flattened): rows {ro:.3} \
         (pixel noise alone {re:.3}), columns {co:.3} (pixel noise alone {ce:.3})"
    );
    // Trace-level effect: MAD-diff σ of 9x9 block means.
    let trace_sigma = |tr: &[Vec<f32>], j: usize| -> f32 {
        let d: Vec<f32> = tr.windows(2).map(|w| (w[1][j] - w[0][j]).abs()).collect();
        median(d) / (0.674_49 * std::f32::consts::SQRT_2)
    };
    let mut ratio_rows = Vec::new();
    let mut ratio_both = Vec::new();
    let mut base = Vec::new();
    for j in 0..blocks.len() {
        let s0 = trace_sigma(&block_traces[0], j);
        base.push(s0);
        ratio_rows.push(trace_sigma(&block_traces[1], j) / s0);
        ratio_both.push(trace_sigma(&block_traces[2], j) / s0);
    }
    println!(
        "9x9-block trace noise over {} blocks: off {:.3} (white-noise expectation {:.3}); \
         rows / off {:.3}, both / off {:.3} (medians)",
        blocks.len(),
        median(base),
        median(
            (0..n)
                .filter(|&i| fov.contains(i))
                .map(|i| sigma[i])
                .collect()
        ) / 9.0,
        median(ratio_rows),
        median(ratio_both)
    );
    // Shared line noise correlates the noise of cells on the same rows:
    // mean correlation of block-trace differences for block pairs on the same
    // block-row versus pairs on different block-rows.
    let corr_by_row = |tr: &[Vec<f32>]| -> (f32, f32) {
        let nb = blocks.len();
        let diffs: Vec<Vec<f32>> = (0..nb)
            .map(|j| {
                let d: Vec<f32> = tr.windows(2).map(|w| w[1][j] - w[0][j]).collect();
                let m = d.iter().sum::<f32>() / d.len() as f32;
                let sd = (d.iter().map(|v| (v - m).powi(2)).sum::<f32>() / d.len() as f32).sqrt();
                d.iter().map(|v| (v - m) / sd.max(1e-6)).collect()
            })
            .collect();
        let (mut same, mut ns, mut other, mut no) = (0.0f32, 0, 0.0f32, 0);
        for a in 0..nb {
            for b in a + 1..nb {
                let c = diffs[a]
                    .iter()
                    .zip(&diffs[b])
                    .map(|(x, y)| x * y)
                    .sum::<f32>()
                    / diffs[a].len() as f32;
                if blocks[a] / dims.width == blocks[b] / dims.width {
                    same += c;
                    ns += 1;
                } else {
                    other += c;
                    no += 1;
                }
            }
        }
        (same / ns.max(1) as f32, other / no.max(1) as f32)
    };
    for (name, tr) in [
        ("off", &block_traces[0]),
        ("rows", &block_traces[1]),
        ("both", &block_traces[2]),
    ] {
        let (same, other) = corr_by_row(tr);
        println!(
            "  noise correlation of block traces ({name}): same rows {same:.3}, different rows {other:.3}"
        );
    }

    // ---- background across the brightness step
    println!("\n== global brightness and background (frame: input mean in FOV, glow mean, background mean, % px lowered)");
    for &f in &[
        0u32,
        100,
        500,
        1000,
        1500,
        1990,
        1999,
        2000,
        2001,
        2010,
        2100,
        2500,
        3000,
        3500,
        frames - 1,
    ] {
        if let Some(r) = records.get(f as usize) {
            println!(
                "  {f:5}: input {:7.2}  glow {:7.2}  background {:7.3}  lowered {:6.3} %",
                r.front.input_mean,
                r.front.lowpass_mean,
                r.back.floor_mean,
                100.0 * r.back.floor_lowered_fraction
            );
        }
    }
    // Flashes: frames whose input mean jumps above both neighbours.
    let flashes: Vec<(usize, f32)> = (1..records.len().saturating_sub(1))
        .filter_map(|i| {
            let (a, b, c) = (
                records[i - 1].front.input_mean,
                records[i].front.input_mean,
                records[i + 1].front.input_mean,
            );
            let jump = b - 0.5 * (a + c);
            (jump > 5.0).then_some((i, jump))
        })
        .collect();
    println!(
        "single-frame brightness flashes (> +5 over neighbours): {} frames, {flashes:?}",
        flashes.len()
    );
    let dips: Vec<(usize, f32)> = (1..records.len().saturating_sub(1))
        .filter_map(|i| {
            let (a, b, c) = (
                records[i - 1].front.input_mean,
                records[i].front.input_mean,
                records[i + 1].front.input_mean,
            );
            let dip = b - 0.5 * (a + c);
            (dip < -5.0).then_some((i, dip))
        })
        .collect();
    println!("single-frame dips (< -5): {} frames {dips:?}", dips.len());
    let dip_lowered: Vec<f32> = dips
        .iter()
        .filter_map(|&(i, _)| {
            records
                .get(i)
                .map(|r| 100.0 * r.back.floor_lowered_fraction)
        })
        .collect();
    println!("  background lowered at those frames (% px): {dip_lowered:?}");
    let flash_lowered: Vec<f32> = flashes
        .iter()
        .filter_map(|&(i, _)| {
            records
                .get(i)
                .map(|r| 100.0 * r.back.floor_lowered_fraction)
        })
        .collect();
    println!("  background lowered at those frames (% px): {flash_lowered:?}");

    // ---- noise
    let fov_sigma: Vec<f32> = (0..n)
        .filter(|&i| fov.contains(i))
        .map(|i| sigma[i])
        .collect();
    println!(
        "\n== noise map (median tracker after {frames} frames): FOV median {:.3}, 10-90 % {:.3}-{:.3}",
        median(fov_sigma.clone()),
        {
            let mut v = fov_sigma.clone();
            v.sort_by(|a, b| a.total_cmp(b));
            v[v.len() / 10]
        },
        {
            let mut v = fov_sigma.clone();
            v.sort_by(|a, b| a.total_cmp(b));
            v[v.len() * 9 / 10]
        }
    );

    // Streaming estimate against the batch estimators on sampled pixels.
    let mut batch_med = Vec::new();
    let mut batch_mean = Vec::new();
    let mut batch_recent = Vec::new();
    let mut tracker = Vec::new();
    // The tracker forgets over ~600 frames, so also compare with the batch
    // estimate over the last 600 frames (the noise falls with the brightness
    // step at frame 2000: shot noise).
    let recent = px_traces.len().saturating_sub(600);
    for (j, &i) in sample_px.iter().enumerate() {
        let d: Vec<f32> = px_traces
            .windows(2)
            .map(|w| (w[1][j] - w[0][j]).abs())
            .collect();
        batch_mean.push(d.iter().sum::<f32>() / d.len() as f32 / std::f32::consts::FRAC_2_SQRT_PI);
        batch_recent.push(median(d[recent..].to_vec()) / (0.674_49 * std::f32::consts::SQRT_2));
        batch_med.push(median(d) / (0.674_49 * std::f32::consts::SQRT_2));
        tracker.push(sigma[i]);
    }
    let ratio_recent: Vec<f32> = tracker
        .iter()
        .zip(&batch_recent)
        .map(|(a, b)| a / b)
        .collect();
    let ratio: Vec<f32> = tracker.iter().zip(&batch_med).map(|(a, b)| a / b).collect();
    println!(
        "   on {} sampled pixels, all {frames} frames: batch MAD-diff {:.3}, batch mean-abs {:.3}, \
         streaming tracker {:.3} (tracker / batch median {:.3})",
        sample_px.len(),
        median(batch_med),
        median(batch_mean),
        median(tracker),
        median(ratio)
    );
    println!(
        "   batch MAD-diff over the last 600 frames {:.3} (tracker / that {:.3})",
        median(batch_recent),
        median(ratio_recent)
    );

    // ---- throughput
    println!(
        "\n== throughput: whole chain {:.1} fps ({:.3} ms/frame) over {frames} frames; AVI read {:.0} fps",
        f64::from(frames) / chain_secs,
        1e3 * chain_secs / f64::from(frames),
        f64::from(frames) / io_secs
    );
    // Per stage on 300 frames held in memory.
    let sample = rec.read(0, 300.min(frames));
    let mut q = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut buf = vec![0.0f32; n];
    let time = |label: &str, f: &mut dyn FnMut()| {
        let t = Instant::now();
        f();
        let s = t.elapsed().as_secs_f64();
        println!("  {label:28} {:.3} ms/frame", 1e3 * s / 300.0);
    };
    let hotmap = cal.hot_pixels().clone();
    time("convert + hot pixels", &mut || {
        for raw in sample.chunks_exact(n) {
            for (b, &v) in buf.iter_mut().zip(raw) {
                *b = f32::from(v);
            }
            hotmap.apply(&mut buf).unwrap();
        }
    });
    time("front (hot+flatten+lines both)", &mut || {
        for raw in sample.chunks_exact(n) {
            q.front(raw, &mut buf).unwrap();
        }
    });
    time("back (background+noise)", &mut || {
        for _ in 0..300 {
            q.back(&mut buf).unwrap();
        }
    });
    let mut lc = LineCorrector::new(fov, LineMode::Rows);
    time("lines (rows), if enabled", &mut || {
        for _ in 0..300 {
            lc.apply(&mut buf).unwrap();
        }
    });
    let mut lc = LineCorrector::new(fov, LineMode::Both);
    time("lines (both), if enabled", &mut || {
        for _ in 0..300 {
            lc.apply(&mut buf).unwrap();
        }
    });
    println!("\nimages written to {out_dir:?}");
}
