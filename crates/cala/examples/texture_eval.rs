//! Texture diagnostics (D4): where does high-spatial-frequency footprint
//! structure come from? Streams a real recording through the qc_eval
//! preprocessing + motion chain and writes, as little-endian f64 images:
//! * `bins.f64` / `bins.tsv`: sums of the raw sensor frame (scaled to the
//!   first frame's mean brightness) per integer rigid-shift bin, for a
//!   flat-field estimate from the motion dither (Kuhn-Lin-Loranz);
//! * `tis_{raw,pre,post}_{0,y,x}.f64`: tissue-coordinate sums of the raw frame
//!   warped by the motion record, the registered front output and the
//!   background-subtracted output, and their products with dy and dx (valid
//!   samples only);
//! * `sen_pre_{0,y,x}.f64`: the same for the front output in sensor
//!   coordinates; `motion.tsv`: per frame dy, dx, raw FOV mean.
//!
//! ```text
//! texture_eval <avi dir> <out dir> [--frames N]
//! ```
use std::fmt::Write as _;
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

/// The numbered AVIs of a recording directory as one frame stream.
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

fn save(path: PathBuf, v: &[f64]) {
    let mut f = BufWriter::new(File::create(path).unwrap());
    for x in v {
        f.write_all(&x.to_le_bytes()).unwrap();
    }
}

const R: i32 = 4;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    std::fs::create_dir_all(&out).unwrap();
    let av = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .map(|i| args[i + 1].clone())
    };
    let mut rec = Recording::open(&input);
    let dims = rec.dims;
    let n = dims.pixels();
    let frames = av("--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    let cfg = PreprocessConfig::for_fps(20.0);
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    let mut pre = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut inv_gain = vec![1.0f32; n];
    if let Some(f) = av("--flat-field") {
        let b = std::fs::read(&f).unwrap();
        let g: Vec<f32> = b
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        pre.set_flat_field(Some(&g)).unwrap();
        for (o, v) in inv_gain.iter_mut().zip(&g) {
            *o = 1.0 / v;
        }
    }
    let mut buf = vec![0.0f32; n];
    // Motion init as qc_eval's Pipeline: 200 front frames.
    let raw0 = rec.read(0, 200.min(frames));
    let mut fr = vec![0.0f32; raw0.len()];
    for (r, o) in raw0.chunks_exact(n).zip(fr.chunks_exact_mut(n)) {
        pre.front(r, o).unwrap();
    }
    let mcfg = MotionConfig {
        nonrigid: Some(NonRigidConfig::default()),
        ..MotionConfig::default()
    };
    let mut mc = MotionCorrector::new(dims.height, dims.width, mcfg).unwrap();
    mc.set_fov_mask(&fov).unwrap();
    mc.initialize(Frames::F32(&fr)).unwrap();
    drop(fr);
    let src = calab_cala::motion::SourceMask::new(
        dims.height,
        dims.width,
        &fov,
        calab_cala::motion::Interpolation::Bicubic,
    )
    .unwrap();
    let mut valid = vec![0u8; n];
    let nb = (2 * R + 1) as usize;
    let mut bins = vec![0.0f64; nb * nb * n];
    let mut bcnt = vec![0u64; nb * nb];
    let z = || vec![0.0f64; n];
    let mut tis: Vec<[Vec<f64>; 4]> = (0..3).map(|_| [z(), z(), z(), z()]).collect();
    let mut sen = [z(), z(), z()];
    let mut mlog = String::from("frame\tdy\tdx\tmean\n");
    let (mut reg, mut rawf, mut raww) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
    let nfov = fov.iter().filter(|&&m| m != 0).count() as f64;
    let mut gmean = 0.0f64;
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n).enumerate() {
            let t = s as usize + k;
            pre.front(f, &mut buf).unwrap();
            let r = mc.process(Frame::F32(&buf), &mut reg).unwrap();
            mc.validity(&r, &src, &mut valid).unwrap();
            let m: f64 = f
                .iter()
                .zip(&fov)
                .filter(|(_, &q)| q != 0)
                .map(|(&v, _)| f64::from(v))
                .sum::<f64>()
                / nfov;
            if t == 0 {
                gmean = m;
            }
            let sc = (gmean / m) as f32;
            for ((o, &v), &k) in rawf.iter_mut().zip(f).zip(&inv_gain) {
                *o = f32::from(v) * sc * k;
            }
            let _ = writeln!(mlog, "{t}\t{}\t{}\t{m}", r.dy, r.dx);
            let (iy, ix) = (r.dy.round() as i32, r.dx.round() as i32);
            if iy.abs() <= R && ix.abs() <= R {
                let b = ((iy + R) as usize) * nb + (ix + R) as usize;
                bcnt[b] += 1;
                for (a, &v) in bins[b * n..(b + 1) * n].iter_mut().zip(&rawf) {
                    *a += f64::from(v);
                }
            }
            mc.apply(Frame::F32(&rawf), &r, &mut raww, None).unwrap();
            let (dy, dx) = (f64::from(r.dy), f64::from(r.dx));
            let mut post = reg.clone();
            pre.back_masked(&mut post, &valid).unwrap();
            for (st, img) in [(0usize, &raww), (1, &reg), (2, &post)] {
                let [a0, ay, ax, an] = &mut tis[st];
                for p in 0..n {
                    let v = f64::from(img[p]);
                    if v.is_finite() && valid[p] != 0 {
                        a0[p] += v;
                        ay[p] += v * dy;
                        ax[p] += v * dx;
                        an[p] += 1.0;
                    }
                }
            }
            for p in 0..n {
                let v = f64::from(buf[p]);
                sen[0][p] += v;
                sen[1][p] += v * dy;
                sen[2][p] += v * dx;
            }
        }
        s += cnt;
        if s.is_multiple_of(1024) {
            eprintln!("{s}/{frames}");
        }
    }
    let mut bt = String::from("iy\tix\tcount\n");
    for (b, c) in bcnt.iter().enumerate() {
        let _ = writeln!(bt, "{}\t{}\t{c}", (b / nb) as i32 - R, (b % nb) as i32 - R);
    }
    std::fs::write(out.join("bins.tsv"), bt).unwrap();
    save(out.join("bins.f64"), &bins);
    for (st, name) in ["raw", "pre", "post"].iter().enumerate() {
        for (j, a) in ["0", "y", "x", "n"].iter().enumerate() {
            save(out.join(format!("tis_{name}_{a}.f64")), &tis[st][j]);
        }
    }
    for (j, a) in ["0", "y", "x"].iter().enumerate() {
        save(out.join(format!("sen_pre_{a}.f64")), &sen[j]);
    }
    save(
        out.join("fov.f64"),
        &fov.iter().map(|&v| f64::from(v)).collect::<Vec<_>>(),
    );
    std::fs::write(out.join("motion.tsv"), mlog).unwrap();
    println!("done {frames} frames, {}x{}", dims.width, dims.height);
}
