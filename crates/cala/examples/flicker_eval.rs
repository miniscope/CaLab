//! Evaluate the global flicker stage (`preprocess::flicker`).
//!
//! ```text
//! cargo run --release --example flicker_eval -- real <recording dir> [--start S] [--frames N] [--stride K]
//! cargo run --release --example flicker_eval -- inject <recording dir> [--frames N] [--m-rms X] [--a-rms Y] [--seed S]
//!
//! both also take --tau T (reference time constant, frames), --grid N (fitted
//! grid pixels) and (inject) --mode 0..=3 (off, additive, multiplicative, both)
//! ```
//!
//! `real`: on a real recording (frames `S..S+N`, default 5000..7000: files 5
//! and 6 of the workshop CA1 data) it runs the front half of the chain with
//! the flicker stage on and off, plus rigid + piecewise motion correction of
//! the uncorrected front output, and keeps every `K`-th FOV pixel (default 6)
//! of the raw, flicker-corrected and flattened frames. Reports:
//!
//! * the 2–8 Hz band power of the pixels before and after correction, and the
//!   fraction of it explained by the band-passed FOV-mean (the common mode);
//! * the additive / multiplicative split: band-limited σ of `a_t` and `m_t`,
//!   and per-pixel loadings on them against the pixel's mean brightness;
//! * whether `m_t` / `a_t` follow cell activity: Pearson r against the mean of
//!   the most active pixels, full band and below 1 Hz;
//! * sensor- vs tissue-coordinate estimation: the same estimator run on the
//!   raw frames after the recorded motion correction;
//! * cost of the stage per frame.
//!
//! `inject`: on a (simulated) recording, adds a known flicker
//! `y = a_t + (1 + m_t) x` (2–8 Hz broadband series, re-quantized to 8 bits)
//! and reports how well the stage recovers `a_t` and `m_t` (Pearson r, RMSE).
//!
//! Memory: the kept grid (3 x frames x pixels/K² floats) plus 200 frames for
//! the motion template; ~0.5 GB for the defaults on 600x600.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::motion::{Frame, Frames, MotionConfig, MotionCorrector};
use calab_cala::preprocess::flicker::{FlickerConfig, FlickerCorrector, FlickerMode};
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};
use rustfft::num_complex::Complex64;
use rustfft::FftPlanner;

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

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

// ------------------------------------------------------------ statistics

fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len().max(1) as f64
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let (ma, mb) = (mean(a), mean(b));
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        sab += (x - ma) * (y - mb);
        saa += (x - ma) * (x - ma);
        sbb += (y - mb) * (y - mb);
    }
    sab / (saa * sbb).sqrt().max(1e-300)
}

fn rms(x: &[f64]) -> f64 {
    (x.iter().map(|v| v * v).sum::<f64>() / x.len().max(1) as f64).sqrt()
}

fn quantile(v: &[f64], q: f64) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(f64::total_cmp);
    s[((s.len() - 1) as f64 * q).round() as usize]
}

/// Band-pass `lo..=hi` Hz (FFT mask, mean removed).
struct Band {
    fft: std::sync::Arc<dyn rustfft::Fft<f64>>,
    ifft: std::sync::Arc<dyn rustfft::Fft<f64>>,
    keep: Vec<bool>,
    buf: Vec<Complex64>,
}

impl Band {
    fn new(n: usize, fps: f64, lo: f64, hi: f64) -> Band {
        let mut p = FftPlanner::new();
        let keep = (0..n)
            .map(|k| {
                let f = k.min(n - k) as f64 * fps / n as f64;
                k != 0 && f >= lo && f <= hi
            })
            .collect();
        Band {
            fft: p.plan_fft_forward(n),
            ifft: p.plan_fft_inverse(n),
            keep,
            buf: vec![Complex64::new(0.0, 0.0); n],
        }
    }

    fn apply(&mut self, x: &[f64]) -> Vec<f64> {
        let n = x.len();
        for (b, &v) in self.buf.iter_mut().zip(x) {
            *b = Complex64::new(v, 0.0);
        }
        self.fft.process(&mut self.buf);
        for (b, &k) in self.buf.iter_mut().zip(&self.keep) {
            if !k {
                *b = Complex64::new(0.0, 0.0);
            }
        }
        self.ifft.process(&mut self.buf);
        self.buf.iter().map(|c| c.re / n as f64).collect()
    }
}

/// Centred moving average over `w` frames (a < 1 Hz low-pass for w = 20).
fn smooth(x: &[f64], w: usize) -> Vec<f64> {
    let n = x.len();
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(w / 2);
            let hi = (i + w / 2 + 1).min(n);
            mean(&x[lo..hi])
        })
        .collect()
}

/// 2–8 Hz broadband series with RMS `amp`: a sum of 64 sinusoids at uniformly
/// random frequencies in the band with random phases (deterministic in `seed`).
fn flicker_series(n: usize, fps: f64, amp: f64, seed: u64) -> Vec<f64> {
    let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut rnd = || {
        s = s
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    let comps: Vec<(f64, f64)> = (0..64)
        .map(|_| (2.0 + 6.0 * rnd(), std::f64::consts::TAU * rnd()))
        .collect();
    let x: Vec<f64> = (0..n)
        .map(|t| {
            let tt = t as f64 / fps;
            comps
                .iter()
                .map(|&(f, p)| (std::f64::consts::TAU * f * tt + p).sin())
                .sum()
        })
        .collect();
    let r = rms(&x);
    x.iter().map(|v| v * amp / r).collect()
}

// ------------------------------------------------------------------ real

/// 2–8 Hz statistics of a `frames x pixels` matrix (`val(t, p)`).
struct BandStats {
    /// Mean per-pixel band variance.
    power: f64,
    /// Fraction of it explained, pixel by pixel, by the band-passed FOV mean.
    common_frac: f64,
    /// ... by a fixed reference common mode.
    ref_frac: f64,
    /// The band-passed FOV mean.
    g: Vec<f64>,
}

fn band_stats(
    t_len: usize,
    p_len: usize,
    val: impl Fn(usize, usize) -> f64,
    band: &mut Band,
    reference: Option<&[f64]>,
) -> BandStats {
    let mut series: Vec<Vec<f64>> = Vec::with_capacity(p_len);
    let mut col = vec![0.0; t_len];
    for p in 0..p_len {
        for (t, c) in col.iter_mut().enumerate() {
            *c = val(t, p);
        }
        series.push(band.apply(&col).iter().map(|&v| v as f32 as f64).collect());
    }
    let g: Vec<f64> = (0..t_len)
        .map(|t| series.iter().map(|s| s[t]).sum::<f64>() / p_len as f64)
        .collect();
    let explained = |g: &[f64]| {
        let gg: f64 = g.iter().map(|v| v * v).sum();
        let (mut tot, mut exp) = (0.0, 0.0);
        for s in &series {
            let sg: f64 = s.iter().zip(g).map(|(a, b)| a * b).sum();
            tot += s.iter().map(|v| v * v).sum::<f64>();
            exp += sg * sg / gg.max(1e-300);
        }
        (tot, exp / tot.max(1e-300))
    };
    let (tot, common_frac) = explained(&g);
    let ref_frac = reference.map_or(common_frac, |r| explained(r).1);
    BandStats {
        power: tot / (p_len * t_len) as f64,
        common_frac,
        ref_frac,
        g,
    }
}

fn real(args: &[String]) {
    let dir = PathBuf::from(args.get(2).expect("recording dir"));
    let start: u32 = arg_value(args, "--start").map_or(5000, |s| s.parse().unwrap());
    let frames: u32 = arg_value(args, "--frames").map_or(2000, |s| s.parse().unwrap());
    let stride: usize = arg_value(args, "--stride").map_or(6, |s| s.parse().unwrap());
    let fps = 20.0;
    let mut rec = Recording::open(&dir);
    let frames = frames.min(rec.total - start);
    let t_len = frames as usize;
    let dims = rec.dims;
    let n_px = dims.pixels();
    let mut cfg = PreprocessConfig::for_fps(fps as f32);
    if let Some(m) = arg_value(args, "--tau") {
        cfg.flicker.tau_frames = m.parse().unwrap();
    }
    if let Some(m) = arg_value(args, "--grid") {
        cfg.flicker.grid_pixels = m.parse().unwrap();
    }
    let warm = rec.read(start, cfg.warmup_frames as u32);
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let off_cfg = PreprocessConfig {
        flicker: FlickerConfig {
            mode: FlickerMode::Off,
            ..cfg.flicker
        },
        ..cfg
    };
    let mut on = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut off = Preprocessor::new(cal.clone(), &off_cfg).unwrap();
    let mut bench = FlickerCorrector::new(cal.fov(), &cfg.flicker).unwrap();
    let mut tissue = FlickerCorrector::new(cal.fov(), &cfg.flicker).unwrap();
    println!(
        "{}: frames {start}..{}, {}x{}, FOV {} px, flicker grid {} px (stride {}), tau {} frames",
        dir.display(),
        start + frames,
        dims.width,
        dims.height,
        cal.fov().area(),
        bench.grid_len(),
        bench.stride(),
        cfg.flicker.tau_frames
    );

    // Kept pixels.
    let grid: Vec<usize> = (stride / 2..dims.height)
        .step_by(stride)
        .flat_map(|y| {
            (stride / 2..dims.width)
                .step_by(stride)
                .map(move |x| y * dims.width + x)
        })
        .filter(|&i| cal.fov().contains(i) && cal.hot_pixels().flags()[i] == 0)
        .collect();
    let p_len = grid.len();
    let mut x0 = vec![0.0f32; t_len * p_len];
    let mut f_off = vec![0.0f32; t_len * p_len];
    let mut f_on = vec![0.0f32; t_len * p_len];
    let (mut a_s, mut m_s, mut a_t, mut m_t) = (vec![], vec![], vec![], vec![]);
    let (mut sep, mut contrast, mut kept, mut shift) = (0usize, vec![], vec![], vec![]);
    let mut cost_us = Vec::with_capacity(t_len);

    // Motion template from the first 200 uncorrected front frames.
    let mut mc = MotionCorrector::new(dims.height, dims.width, MotionConfig::default()).unwrap();
    mc.set_fov_mask(cal.fov().mask()).unwrap();
    {
        let n0 = 200.min(frames);
        let raw = rec.read(start, n0);
        let mut fronts = vec![0.0f32; n0 as usize * n_px];
        let mut tmp = off.clone();
        for (f, o) in raw.chunks_exact(n_px).zip(fronts.chunks_exact_mut(n_px)) {
            tmp.front(f, o).unwrap();
        }
        mc.initialize(Frames::F32(&fronts)).unwrap();
    }

    let mut out_on = vec![0.0f32; n_px];
    let mut out_off = vec![0.0f32; n_px];
    let mut repaired = vec![0.0f32; n_px];
    let mut warped = vec![0.0f32; n_px];
    let mut scratch = vec![0.0f32; n_px];
    let wall = Instant::now();
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(start + s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            for (r, &v) in repaired.iter_mut().zip(f) {
                *r = f32::from(v);
            }
            cal.hot_pixels().apply(&mut repaired).unwrap();
            scratch.copy_from_slice(&repaired);
            let c0 = Instant::now();
            bench.apply(&mut scratch).unwrap();
            cost_us.push(c0.elapsed().as_secs_f64() * 1e6);

            let r = on.front(f, &mut out_on).unwrap().flicker;
            off.front(f, &mut out_off).unwrap();
            a_s.push(f64::from(r.offset));
            m_s.push(f64::from(r.gain));
            sep += usize::from(r.separable);
            contrast.push(f64::from(r.contrast));
            kept.push(f64::from(r.kept_fraction));

            // Tissue coordinates: the raw frame warped by the motion record.
            let mrec = mc.process(Frame::F32(&out_off), &mut warped).unwrap();
            shift.push(f64::from(mrec.dy.hypot(mrec.dx)));
            mc.apply(Frame::F32(&repaired), &mrec, &mut warped, None)
                .unwrap();
            let rt = tissue.apply(&mut warped).unwrap();
            a_t.push(f64::from(rt.offset));
            m_t.push(f64::from(rt.gain));

            for (j, &i) in grid.iter().enumerate() {
                x0[t * p_len + j] = repaired[i];
                f_off[t * p_len + j] = out_off[i];
                f_on[t * p_len + j] = out_on[i];
            }
        }
        s += cnt;
    }
    println!(
        "streamed {t_len} frames in {:.1} s; kept {p_len} pixels",
        wall.elapsed().as_secs_f64()
    );
    println!(
        "flicker stage cost: median {:.0} us, p90 {:.0} us per frame (native, {}x{})",
        quantile(&cost_us, 0.5),
        quantile(&cost_us, 0.9),
        dims.width,
        dims.height
    );
    println!(
        "fit: separable {:.1} % of frames, contrast median {:.3}, kept fraction median {:.3} (p10 {:.3}), rigid shift median {:.2} px (p99 {:.2})",
        100.0 * sep as f64 / t_len as f64,
        quantile(&contrast, 0.5),
        quantile(&kept, 0.5),
        quantile(&kept, 0.1),
        quantile(&shift, 0.5),
        quantile(&shift, 0.99)
    );

    let mut band = Band::new(t_len, fps, 2.0, 8.0);
    let ab = band.apply(&a_s);
    let mb = band.apply(&m_s);
    let at = band.apply(&a_t);
    let mt = band.apply(&m_t);
    println!(
        "estimates: a_t rms {:.3} (2-8 Hz {:.3}) grey levels, m_t rms {:.5} (2-8 Hz {:.5}); corr(a, m) 2-8 Hz {:.3}",
        rms(&a_s),
        rms(&ab),
        rms(&m_s),
        rms(&mb),
        pearson(&ab, &mb)
    );
    println!(
        "sensor vs tissue coordinates: m r {:.4} (2-8 Hz {:.4}), rms diff {:.5}; a r {:.4} (2-8 Hz {:.4})",
        pearson(&m_s, &m_t),
        pearson(&mb, &mt),
        rms(&m_s.iter().zip(&m_t).map(|(a, b)| a - b).collect::<Vec<_>>()),
        pearson(&a_s, &a_t),
        pearson(&ab, &at)
    );

    // Mean brightness per kept pixel.
    let f0: Vec<f64> = (0..p_len)
        .map(|p| {
            (0..t_len)
                .map(|t| f64::from(x0[t * p_len + p]))
                .sum::<f64>()
                / t_len as f64
        })
        .collect();
    let raw_at = |t: usize, p: usize| f64::from(x0[t * p_len + p]);
    let corr_with = |a: &[f64], m: &[f64]| {
        let (a, m) = (a.to_vec(), m.to_vec());
        move |t: usize, p: usize| (raw_at(t, p) - a[t]) / (1.0 + m[t])
    };
    let s_raw = band_stats(t_len, p_len, raw_at, &mut band, None);
    let g_raw = s_raw.g.clone();
    let s_cs = band_stats(t_len, p_len, corr_with(&a_s, &m_s), &mut band, Some(&g_raw));
    let s_ct = band_stats(t_len, p_len, corr_with(&a_t, &m_t), &mut band, Some(&g_raw));
    let s_fo = band_stats(
        t_len,
        p_len,
        |t, p| f64::from(f_off[t * p_len + p]),
        &mut band,
        Some(&g_raw),
    );
    let s_fn = band_stats(
        t_len,
        p_len,
        |t, p| f64::from(f_on[t * p_len + p]),
        &mut band,
        Some(&g_raw),
    );
    println!("2-8 Hz power per pixel (grey levels^2) and common-mode fraction:");
    println!("  stage                         power    ratio  common(own)  raw common mode");
    let row = |name: &str, s: &BandStats, base: &BandStats| {
        println!(
            "  {name:<28} {:>8.4} {:>8.3} {:>12.3} {:>12.3}",
            s.power,
            s.power / base.power,
            s.common_frac,
            s.ref_frac
        )
    };
    row("raw (hot pixels repaired)", &s_raw, &s_raw);
    row("raw, corrected (sensor est)", &s_cs, &s_raw);
    row("raw, corrected (tissue est)", &s_ct, &s_raw);
    row("flattened, flicker off", &s_fo, &s_fo);
    row("flattened, flicker on", &s_fn, &s_fo);

    // Per-pixel loadings on a and m (2-8 Hz, two-regressor fit).
    let (saa, smm, sam) = (
        ab.iter().map(|v| v * v).sum::<f64>(),
        mb.iter().map(|v| v * v).sum::<f64>(),
        ab.iter().zip(&mb).map(|(a, b)| a * b).sum::<f64>(),
    );
    let det = saa * smm - sam * sam;
    let mut col = vec![0.0; t_len];
    let (mut alpha, mut mu) = (vec![0.0; p_len], vec![0.0; p_len]);
    for p in 0..p_len {
        for (t, c) in col.iter_mut().enumerate() {
            *c = raw_at(t, p);
        }
        let b = band.apply(&col);
        let ya: f64 = b.iter().zip(&ab).map(|(x, y)| x * y).sum();
        let ym: f64 = b.iter().zip(&mb).map(|(x, y)| x * y).sum();
        alpha[p] = (smm * ya - sam * ym) / det;
        mu[p] = (saa * ym - sam * ya) / det;
    }
    // mu vs f0: slope and intercept.
    let (mf, mm) = (mean(&f0), mean(&mu));
    let sl = f0
        .iter()
        .zip(&mu)
        .map(|(f, u)| (f - mf) * (u - mm))
        .sum::<f64>()
        / f0.iter().map(|f| (f - mf).powi(2)).sum::<f64>();
    println!(
        "loadings: on a_t median {:.3} (1 = additive offset as estimated); on m_t = {:.3} + {:.3} x F0 (1 x F0 = gain as estimated)",
        quantile(&alpha, 0.5),
        mm - sl * mf,
        sl
    );
    let (va, vm) = (rms(&ab).powi(2), rms(&mb).powi(2));
    for (name, q) in [
        ("dim (5 %)", 0.05),
        ("median", 0.5),
        ("bright (95 %)", 0.95),
    ] {
        let f = quantile(&f0, q);
        let tot = rms(&ab
            .iter()
            .zip(&mb)
            .map(|(a, m)| a + m * f)
            .collect::<Vec<_>>());
        println!(
            "  pixel {name:<14} F0 {f:6.1}: 2-8 Hz flicker {tot:.3} grey levels; multiplicative share of variance {:.2} (additive {:.2})",
            vm * f * f / (va + vm * f * f),
            va / (va + vm * f * f)
        );
    }

    // Do the estimates follow cell activity?
    let mut act: Vec<(f64, usize)> = (0..p_len)
        .map(|p| {
            let v: Vec<f64> = (0..t_len).map(|t| f64::from(f_on[t * p_len + p])).collect();
            (quantile(&v, 0.99) - quantile(&v, 0.5), p)
        })
        .collect();
    act.sort_by(|a, b| b.0.total_cmp(&a.0));
    let top: Vec<usize> = act[..(p_len / 100).max(20).min(p_len)]
        .iter()
        .map(|x| x.1)
        .collect();
    let cell = |f: &[f32]| -> Vec<f64> {
        (0..t_len)
            .map(|t| {
                top.iter()
                    .map(|&p| f64::from(f[t * p_len + p]))
                    .sum::<f64>()
                    / top.len() as f64
            })
            .collect()
    };
    let c_on = cell(&f_on);
    let c_off = cell(&f_off);
    let lp = |x: &[f64]| smooth(x, 20);
    println!(
        "activity: top {} pixels (p99 - median of the corrected flattened output). r(m, cells) {:.3} full, {:.3} < 1 Hz, {:.3} 2-8 Hz; r(a, cells) {:.3} full, {:.3} < 1 Hz",
        top.len(),
        pearson(&m_s, &c_on),
        pearson(&lp(&m_s), &lp(&c_on)),
        pearson(&mb, &band.apply(&c_on)),
        pearson(&a_s, &c_on),
        pearson(&lp(&a_s), &lp(&c_on))
    );
    println!(
        "  same cells, uncorrected output: r(m, cells) 2-8 Hz {:.3}; cells' 2-8 Hz rms {:.3} -> {:.3} grey levels",
        pearson(&mb, &band.apply(&c_off)),
        rms(&band.apply(&c_off)),
        rms(&band.apply(&c_on))
    );
}

// ---------------------------------------------------------------- inject

fn inject(args: &[String]) {
    let dir = PathBuf::from(args.get(2).expect("recording dir"));
    let fps = 20.0;
    let m_amp: f64 = arg_value(args, "--m-rms").map_or(0.004, |s| s.parse().unwrap());
    let a_amp: f64 = arg_value(args, "--a-rms").map_or(0.1, |s| s.parse().unwrap());
    let seed: u64 = arg_value(args, "--seed").map_or(1, |s| s.parse().unwrap());
    let mut rec = Recording::open(&dir);
    let frames: u32 = arg_value(args, "--frames").map_or(rec.total, |s| s.parse().unwrap());
    let frames = frames.min(rec.total);
    let t_len = frames as usize;
    let dims = rec.dims;
    let n_px = dims.pixels();
    let mut cfg = PreprocessConfig::for_fps(fps as f32);
    if let Some(m) = arg_value(args, "--tau") {
        cfg.flicker.tau_frames = m.parse().unwrap();
    }
    if let Some(m) = arg_value(args, "--grid") {
        cfg.flicker.grid_pixels = m.parse().unwrap();
    }
    if let Some(m) = arg_value(args, "--mode") {
        cfg.flicker.mode = FlickerMode::from_code(m.parse().unwrap()).unwrap();
    }
    let m_true = flicker_series(t_len, fps, m_amp, seed);
    let a_true = flicker_series(t_len, fps, a_amp, seed + 1000);
    let warm = rec.read(0, cfg.warmup_frames as u32);
    let mut acc = WarmupAccumulator::new(dims);
    for (k, f) in warm.chunks_exact(n_px).enumerate() {
        acc.push(&apply_flicker(f, a_true[k], m_true[k])).unwrap();
    }
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let mut pre = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut clean = pre.clone();
    let mut out = vec![0.0f32; n_px];
    let (mut a_e, mut m_e, mut a_c, mut m_c) = (vec![], vec![], vec![], vec![]);
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            let r = pre
                .front(&apply_flicker(f, a_true[t], m_true[t]), &mut out)
                .unwrap()
                .flicker;
            a_e.push(f64::from(r.offset));
            m_e.push(f64::from(r.gain));
            // The same recording without injected flicker: what the stage
            // reads from the scene itself (a floor for the recovery error).
            let r = clean.front(f, &mut out).unwrap().flicker;
            a_c.push(f64::from(r.offset));
            m_c.push(f64::from(r.gain));
        }
        s += cnt;
    }
    let mut band = Band::new(t_len, fps, 2.0, 8.0);
    let mut low = Band::new(t_len, fps, 0.0, 1.0);
    let (mb, ab) = (band.apply(&m_e), band.apply(&a_e));
    let skip = 20; // the reference's first frames
    let sl = |v: &[f64]| v[skip..].to_vec();
    let diff = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| x - y).collect::<Vec<_>>();
    println!(
        "{}: {t_len} frames; injected m rms {m_amp}, a rms {a_amp} grey levels (2-8 Hz)",
        dir.display()
    );
    println!(
        "  m: r {:.4}, RMSE {:.5} ({:.1} % of rms); a: r {:.4}, RMSE {:.4} ({:.1} % of rms)",
        pearson(&sl(&m_e), &sl(&m_true)),
        rms(&diff(&sl(&m_e), &sl(&m_true))),
        100.0 * rms(&diff(&sl(&m_e), &sl(&m_true))) / m_amp,
        pearson(&sl(&a_e), &sl(&a_true)),
        rms(&diff(&sl(&a_e), &sl(&a_true))),
        100.0 * rms(&diff(&sl(&a_e), &sl(&a_true))) / a_amp.max(1e-12)
    );
    println!(
        "  2-8 Hz part of the estimate: m r {:.4}, RMSE {:.5} ({:.1} %); a r {:.4}, RMSE {:.4} ({:.1} %)",
        pearson(&sl(&mb), &sl(&m_true)),
        rms(&diff(&sl(&mb), &sl(&m_true))),
        100.0 * rms(&diff(&sl(&mb), &sl(&m_true))) / m_amp,
        pearson(&sl(&ab), &sl(&a_true)),
        rms(&diff(&sl(&ab), &sl(&a_true))),
        100.0 * rms(&diff(&sl(&ab), &sl(&a_true))) / a_amp.max(1e-12)
    );
    println!(
        "  without injection the stage reads m rms {:.5} (2-8 Hz {:.5}, < 1 Hz {:.5}), a rms {:.4} (2-8 Hz {:.4}, < 1 Hz {:.4}) from the scene",
        rms(&sl(&m_c)),
        rms(&sl(&band.apply(&m_c))),
        rms(&sl(&low.apply(&m_c))),
        rms(&sl(&a_c)),
        rms(&sl(&band.apply(&a_c))),
        rms(&sl(&low.apply(&a_c)))
    );
}

fn apply_flicker(f: &[u8], a: f64, m: f64) -> Vec<u8> {
    let (a, g) = (a as f32, (1.0 + m) as f32);
    f.iter()
        .map(|&v| (a + g * f32::from(v)).round().clamp(0.0, 255.0) as u8)
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("real") => real(&args),
        Some("inject") => inject(&args),
        _ => eprintln!("usage: flicker_eval real|inject <recording dir> [options]"),
    }
}
