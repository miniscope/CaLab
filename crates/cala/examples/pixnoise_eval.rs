//! Per-frame pixel-noise diagnostics of the preprocessing chain.
//!
//! ```text
//! cargo run --release --example pixnoise_eval -- real <avi dir> <out dir> [options]
//! cargo run --release --example pixnoise_eval -- sim  <sim dir> <out dir> [options]
//!   --frames N         first N frames (default all)
//!   --motion           run the motion corrector between front and back
//!   --fps F            sampling rate (default 20)
//!   --crop C0 C1 S     dump a centred S x S crop of the preprocessed (and raw)
//!                      frames C0..C1 (crop.f32, rawcrop.u8)
//!   --full-every K     dump every K-th whole preprocessed frame (full.f32)
//! ```
//!
//! Writes `frames.tsv`: per frame the flicker offset / gain, the input and
//! background-floor means, the motion shift, and robust noise levels inside
//! the eroded FOV — of the preprocessed output (`out_diff`: MAD of the
//! frame-to-frame difference / (0.6745 √2); `out_hp`: MAD of the 4-neighbour
//! Laplacian residual / (0.6745 √1.25)) and of the raw input (`raw_diff`,
//! `raw_hp`) — plus the excess kurtosis and > 5 σ fraction of the output
//! difference, the mean and 99th percentile of the output (population
//! activity), and the 0.5 / 99.5 % quantiles that the app's per-frame
//! auto-contrast used (`disp_lo`, `disp_hi`).

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::motion::{Frame, Frames, MotionConfig, MotionCorrector, NonRigidConfig};
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};

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

fn arg_value(args: &[String], key: &str, k: usize) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1 + k).cloned())
}

const MAD_DIFF: f32 = 0.674_489_75 * std::f32::consts::SQRT_2;
/// MAD of `y − mean of 4 neighbours` for white noise: σ √(1 + 1/4).
const MAD_LAP: f32 = 0.674_489_75 * 1.118_034;

fn median_abs(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return f32::NAN;
    }
    for x in v.iter_mut() {
        *x = x.abs();
    }
    let k = v.len() / 2;
    *v.select_nth_unstable_by(k, |a, b| a.total_cmp(b)).1
}

fn quantile(v: &mut [f32], q: f32) -> f32 {
    let k = ((v.len() - 1) as f32 * q).round() as usize;
    *v.select_nth_unstable_by(k, |a, b| a.total_cmp(b)).1
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sim = args.get(1).map(String::as_str) == Some("sim");
    let input = PathBuf::from(args.get(2).expect("input dir"));
    let out_dir = PathBuf::from(args.get(3).expect("out dir"));
    std::fs::create_dir_all(&out_dir).unwrap();
    let motion = args.iter().any(|a| a == "--motion");
    let fps: f32 = arg_value(&args, "--fps", 0).map_or(20.0, |s| s.parse().unwrap());
    let avi_dir = if sim {
        input.join("daq/Miniscope")
    } else {
        input.clone()
    };
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let (w, h, n_px) = (dims.width, dims.height, dims.pixels());
    let frames = arg_value(&args, "--frames", 0)
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    let crop = arg_value(&args, "--crop", 0).map(|c0| {
        let c0: u32 = c0.parse().unwrap();
        let c1: u32 = arg_value(&args, "--crop", 1).unwrap().parse().unwrap();
        let s: usize = arg_value(&args, "--crop", 2).unwrap().parse().unwrap();
        (c0, c1, s)
    });
    let full_every: u32 = arg_value(&args, "--full-every", 0).map_or(0, |s| s.parse().unwrap());

    let cfg = PreprocessConfig::for_fps(fps);
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    let mut pre = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut mc = motion.then(|| {
        let mut p0 = pre.clone();
        let raw = rec.read(0, 200.min(rec.total));
        let mut fr = vec![0.0f32; raw.len()];
        for (r, o) in raw.chunks_exact(n_px).zip(fr.chunks_exact_mut(n_px)) {
            p0.front(r, o).unwrap();
        }
        let mcfg = MotionConfig {
            nonrigid: Some(NonRigidConfig::default()),
            ..MotionConfig::default()
        };
        let mut mc = MotionCorrector::new(h, w, mcfg).unwrap();
        mc.set_fov_mask(cal.fov().mask()).unwrap();
        mc.initialize(Frames::F32(&fr)).unwrap();
        mc
    });
    // Interior pixels: 12 px away from the FOV edge (motion, flattening edge).
    let m = 12usize;
    let mut interior = Vec::new();
    for yy in m..h - m {
        for xx in m..w - m {
            let p = yy * w + xx;
            if fov[p] != 0
                && fov[p - m * w] != 0
                && fov[p + m * w] != 0
                && fov[p - m] != 0
                && fov[p + m] != 0
            {
                interior.push(p);
            }
        }
    }
    println!(
        "{}x{} frames {frames} motion {motion}; interior {} px",
        w,
        h,
        interior.len()
    );

    let mut tsv = BufWriter::new(File::create(out_dir.join("frames.tsv")).unwrap());
    writeln!(tsv, "frame\toffset\tgain\tinput_mean\tlowpass_mean\tfloor_mean\tdy\tdx\tout_diff\tout_hp\traw_diff\traw_hp\tdiff_kurt\tdiff_out5\tact_mean\tact_p99\tdisp_lo\tdisp_hi").unwrap();
    let mut crop_f = crop.map(|_| BufWriter::new(File::create(out_dir.join("crop.f32")).unwrap()));
    let mut rawcrop_f =
        crop.map(|_| BufWriter::new(File::create(out_dir.join("rawcrop.u8")).unwrap()));
    let mut full_f =
        (full_every > 0).then(|| BufWriter::new(File::create(out_dir.join("full.f32")).unwrap()));
    std::fs::write(out_dir.join("fov.u8"), &fov).unwrap();

    let mut buf = vec![0.0f32; n_px];
    let mut y = vec![0.0f32; n_px];
    let mut yprev = vec![0.0f32; n_px];
    let mut rprev = vec![0u8; n_px];
    let mut scratch = vec![0.0f32; interior.len()];
    let mut all = vec![0.0f32; n_px];
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, r) in raw.chunks_exact(n_px).enumerate() {
            let t = s + k as u32;
            let front = pre.front(r, &mut buf).unwrap();
            let (dy, dx) = match &mut mc {
                Some(mc) => {
                    let res = mc.process(Frame::F32(&buf), &mut y).unwrap();
                    (res.dy, res.dx)
                }
                None => {
                    y.copy_from_slice(&buf);
                    (0.0, 0.0)
                }
            };
            let back = pre.back(&mut y).unwrap();
            let lap = |img: &dyn Fn(usize) -> f32, p: usize| {
                img(p) - 0.25 * (img(p - 1) + img(p + 1) + img(p - w) + img(p + w))
            };
            let (od, rd, kurt, out5) = if t > 0 {
                for (o, &p) in scratch.iter_mut().zip(&interior) {
                    *o = y[p] - yprev[p];
                }
                // moments of the difference, standardized by the robust σ
                let mut tmp = scratch.clone();
                let sd_rob = median_abs(&mut tmp) / 0.674_489_75;
                let mean: f64 =
                    scratch.iter().map(|&v| f64::from(v)).sum::<f64>() / scratch.len() as f64;
                let (mut m2, mut m4, mut n5) = (0.0f64, 0.0f64, 0usize);
                for &v in &scratch {
                    let d = f64::from(v) - mean;
                    m2 += d * d;
                    m4 += d * d * d * d;
                    if (d.abs() as f32) > 5.0 * sd_rob {
                        n5 += 1;
                    }
                }
                let nn = scratch.len() as f64;
                let kurt = (m4 / nn) / (m2 / nn).powi(2) - 3.0;
                let od = sd_rob / std::f32::consts::SQRT_2;
                for (o, &p) in scratch.iter_mut().zip(&interior) {
                    *o = f32::from(r[p]) - f32::from(rprev[p]);
                }
                let rd = median_abs(&mut scratch) / MAD_DIFF;
                (od, rd, kurt as f32, n5 as f32 / nn as f32)
            } else {
                (f32::NAN, f32::NAN, f32::NAN, f32::NAN)
            };
            let yy = |p: usize| y[p];
            for (o, &p) in scratch.iter_mut().zip(&interior) {
                *o = lap(&yy, p);
            }
            let oh = median_abs(&mut scratch) / MAD_LAP;
            let rr = |p: usize| f32::from(r[p]);
            for (o, &p) in scratch.iter_mut().zip(&interior) {
                *o = lap(&rr, p);
            }
            let rh = median_abs(&mut scratch) / MAD_LAP;
            let mut am = 0.0f64;
            for (o, &p) in scratch.iter_mut().zip(&interior) {
                *o = y[p];
                am += f64::from(y[p]);
            }
            let am = am / interior.len() as f64;
            let p99 = quantile(&mut scratch, 0.99);
            all.copy_from_slice(&y);
            let lo = quantile(&mut all, 0.005);
            let hi = quantile(&mut all, 0.995);
            writeln!(
                tsv,
                "{t}\t{}\t{}\t{}\t{}\t{}\t{dy}\t{dx}\t{od}\t{oh}\t{rd}\t{rh}\t{kurt}\t{out5}\t{am}\t{p99}\t{lo}\t{hi}",
                front.flicker.offset,
                front.flicker.gain,
                front.input_mean,
                front.lowpass_mean,
                back.floor_mean
            )
            .unwrap();
            if let (Some((c0, c1, cs)), Some(cf), Some(rf)) = (crop, &mut crop_f, &mut rawcrop_f) {
                if t >= c0 && t < c1 {
                    let (y0, x0) = ((h - cs) / 2, (w - cs) / 2);
                    for row in y0..y0 + cs {
                        for &v in &y[row * w + x0..row * w + x0 + cs] {
                            cf.write_all(&v.to_le_bytes()).unwrap();
                        }
                        rf.write_all(&r[row * w + x0..row * w + x0 + cs]).unwrap();
                    }
                }
            }
            if let Some(ff) = &mut full_f {
                if t.is_multiple_of(full_every) {
                    for &v in &y {
                        ff.write_all(&v.to_le_bytes()).unwrap();
                    }
                }
            }
            yprev.copy_from_slice(&y);
            rprev.copy_from_slice(r);
        }
        s += cnt;
        if s % 2048 < 64 {
            println!("{s}/{frames}");
        }
    }
    println!("done");
}
