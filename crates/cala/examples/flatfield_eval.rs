//! Stability of the dither flat field across a recording (motion correction
//! and [`DitherFlatField`] only, no cell discovery).
//!
//! ```text
//! cargo run --release --example flatfield_eval -- <avi dir> <out dir> [--frames N] [--third T]
//! ```
//!
//! One pass over the recording (rigid shifts from the motion corrector, as
//! `qc_eval` runs it) feeds, for the offset model off (`off`) and on (`on`,
//! offset half-life 2400 frames, no gain forgetting), these estimators:
//! `third{k}` (frames `kT..(k+1)T`, T = 6000), `third{k}_even` / `_odd` (the
//! even / odd 250-frame blocks of the third: the noise floor of a third's map)
//! and `whole`, solved at `whole_N` for N in 1500, 3000, 6000, 9000 and at the
//! end. Outputs in `<out>`: `maps/<variant>_<name>.logg.f32` (high-passed log
//! gain, one f32 LE per pixel), `maps/<variant>_<name>.col.f32` (column
//! offsets of the offset model, `on` only), `fov.u8`, `maps.tsv` (one row per
//! map) and `col_offsets.tsv` (running column offsets of the `on` whole
//! estimator every 500 frames, grey levels, one row per sample).

use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::motion::{Frame, Frames, MotionConfig, MotionCorrector, NonRigidConfig};
use calab_cala::preprocess::flatfield::{DitherFlatField, FlatFieldConfig};
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

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn write_f32s(path: &Path, v: &[f32]) {
    let mut f = BufWriter::new(File::create(path).unwrap());
    for x in v {
        f.write_all(&x.to_le_bytes()).unwrap();
    }
}

struct Est {
    variant: &'static str,
    name: String,
    est: DitherFlatField,
    /// Frame range `[lo, hi)`.
    lo: usize,
    hi: usize,
    /// `Some(parity)`: only the 250-frame blocks of that parity (relative to `lo`).
    parity: Option<usize>,
    /// Frame counts at which a map is written besides the final one.
    snapshots: Vec<usize>,
}

fn solve_write(e: &Est, label: &str, out: &Path, width: usize, maps: &mut String) {
    match e.est.solve() {
        Ok(ff) => {
            let base = format!("{}_{}", e.variant, label);
            write_f32s(
                &out.join("maps").join(format!("{base}.logg.f32")),
                &ff.log_gain,
            );
            if let Some(o) = &ff.offset {
                write_f32s(
                    &out.join("maps").join(format!("{base}.col.f32")),
                    &o[..width],
                );
            }
            let _ = writeln!(
                maps,
                "{}\t{label}\t{}\t{}\t{}\t{:.5}\t{:.5}\t{:.3e}\t{:.3}",
                e.variant,
                e.est.frames(),
                ff.bins_used,
                ff.frames_used,
                ff.gain_sd,
                ff.tissue_sd,
                ff.residual,
                ff.dark
            );
        }
        Err(err) => {
            let _ = writeln!(
                maps,
                "{}\t{label}\t{}\tERR {err}",
                e.variant,
                e.est.frames()
            );
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "extract" {
        extract(&args);
        return;
    }
    let avi_dir = Path::new(&args[1]).to_path_buf();
    let out = Path::new(&args[2]).to_path_buf();
    std::fs::create_dir_all(out.join("maps")).unwrap();
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let n_px = dims.pixels();
    let frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total) as usize;
    let third: usize = arg_value(&args, "--third").map_or(6000, |s| s.parse().unwrap());
    let cfg = PreprocessConfig::for_fps(20.0);
    let warm = rec.read(0, cfg.warmup_frames as u32);
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    std::fs::write(out.join("fov.u8"), &fov).unwrap();
    let mut pre = Preprocessor::new(cal.clone(), &cfg).unwrap();

    // Motion corrector initialised as in qc_eval's Pipeline.
    let raw = rec.read(0, 200);
    let mut buf = vec![0.0f32; raw.len()];
    for (r, o) in raw.chunks_exact(n_px).zip(buf.chunks_exact_mut(n_px)) {
        pre.front(r, o).unwrap();
    }
    let mcfg = MotionConfig {
        nonrigid: Some(NonRigidConfig::default()),
        ..MotionConfig::default()
    };
    let mut mc = MotionCorrector::new(dims.height, dims.width, mcfg).unwrap();
    mc.set_fov_mask(cal.fov().mask()).unwrap();
    mc.initialize(Frames::F32(&buf)).unwrap();
    drop(buf);
    drop(raw);

    let mut ests: Vec<Est> = Vec::new();
    for (variant, ohl) in [("off", 0.0), ("on", 2400.0)] {
        let mk = || {
            let c = FlatFieldConfig {
                half_life_frames: 0.0,
                offset_half_life_frames: ohl,
                ..FlatFieldConfig::default()
            };
            DitherFlatField::new(dims, &fov, c).unwrap()
        };
        for k in 0..frames.div_ceil(third) {
            let (lo, hi) = (k * third, ((k + 1) * third).min(frames));
            ests.push(Est {
                variant,
                name: format!("third{k}"),
                est: mk(),
                lo,
                hi,
                parity: None,
                snapshots: vec![],
            });
            for p in 0..2 {
                ests.push(Est {
                    variant,
                    name: format!("third{k}_{}", ["even", "odd"][p]),
                    est: mk(),
                    lo,
                    hi,
                    parity: Some(p),
                    snapshots: vec![],
                });
            }
        }
        ests.push(Est {
            variant,
            name: "whole".into(),
            est: mk(),
            lo: 0,
            hi: frames,
            parity: None,
            snapshots: vec![1500, 3000, 6000, 9000],
        });
    }
    let mut maps = String::from(
        "variant\tname\tframes\tbins\tframes_used\tgain_sd\ttissue_sd\tresidual\tdark\n",
    );
    let mut cols = String::from("frame\tdark_level\tcol_offsets\n");
    let mut y = vec![0.0f32; n_px];
    let mut pf = vec![0.0f32; n_px];
    let mut s = 0usize;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s as u32, cnt as u32);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s + k;
            pre.front(f, &mut pf).unwrap();
            let r = mc.process(Frame::F32(&pf), &mut y).unwrap();
            let d = (r.dy, r.dx);
            let n = t + 1;
            for e in ests.iter_mut() {
                if t >= e.lo && t < e.hi {
                    let take = match e.parity {
                        None => true,
                        Some(p) => ((t - e.lo) / 250) % 2 == p,
                    };
                    if take {
                        e.est.push(f, d).unwrap();
                    }
                }
                if e.snapshots.contains(&n) {
                    let label = format!("{}_{n}", e.name);
                    solve_write(e, &label, &out, dims.width, &mut maps);
                }
                if n == e.hi {
                    solve_write(e, &e.name, &out, dims.width, &mut maps);
                }
            }
            if n.is_multiple_of(500) {
                let e = ests
                    .iter()
                    .find(|e| e.variant == "on" && e.name == "whole")
                    .unwrap();
                if let Some(o) = e.est.offset_map() {
                    let strs: Vec<String> =
                        o[..dims.width].iter().map(|v| format!("{v:.2}")).collect();
                    let _ = writeln!(cols, "{n}\t{:.3}\t{}", e.est.dark_level(), strs.join(","));
                }
            }
        }
        s += cnt;
        if s % 2000 < 64 {
            eprintln!("flatfield_eval: {s}/{frames}");
        }
    }
    std::fs::write(out.join("maps.tsv"), maps).unwrap();
    std::fs::write(out.join("col_offsets.tsv"), cols).unwrap();
}

// ---------------------------------------------------------------------------
// `extract` mode: replay of qc_eval's pass 2 (re-extract the traces of a
// finished run's final library) WITH the online flat field of that run, which
// qc_eval's own `--dump` pass leaves out. Same frames, same drift injection,
// same OnlineFlatField config as the run (flags as in qc_eval), so the maps
// switch at the same frames (written to `<run>/extract_updates.tsv`);
// traces to `<run>/dump_trace_ff.f32` (frames x cells, library order).
// ---------------------------------------------------------------------------

use std::io::BufReader;
use std::sync::Arc;

use calab_cala::discover::SlowLoopConfig;
use calab_cala::preprocess::flatfield::{
    FlatField, FlatFieldSeed, OnlineFlatField, OnlineFlatFieldConfig, RefineOutcome, FIRST_MAP_S,
    GAIN_HALF_LIFE_S, OFFSET_HALF_LIFE_S, REFINE_EVERY_S,
};
use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::trace::{
    Footprint, FrameTraces, Library, LibraryBuilder, SolverConfig, TraceEngine,
};

struct Pipeline {
    pre: Preprocessor,
    mc: MotionCorrector,
    buf: Vec<f32>,
}

impl Pipeline {
    fn new(rec: &mut Recording, pre: Preprocessor, cal: &Calibration) -> Pipeline {
        let dims = rec.dims;
        let n_px = dims.pixels();
        let mut pre = pre;
        let raw = rec.read(0, 200);
        let mut frames = vec![0.0f32; raw.len()];
        for (r, o) in raw.chunks_exact(n_px).zip(frames.chunks_exact_mut(n_px)) {
            pre.front(r, o).unwrap();
        }
        let cfg = MotionConfig {
            nonrigid: Some(NonRigidConfig::default()),
            ..MotionConfig::default()
        };
        let mut mc = MotionCorrector::new(dims.height, dims.width, cfg).unwrap();
        mc.set_fov_mask(cal.fov().mask()).unwrap();
        mc.initialize(Frames::F32(&frames)).unwrap();
        Pipeline {
            pre,
            mc,
            buf: vec![0.0; n_px],
        }
    }

    /// qc_eval's `frame` (registered, masked back stage); returns the shift.
    fn frame(
        &mut self,
        raw: &[u8],
        out: &mut [f32],
        src: &calab_cala::motion::SourceMask,
        valid: &mut [u8],
    ) -> (f32, f32) {
        self.pre.front(raw, &mut self.buf).unwrap();
        let rec = self.mc.process(Frame::F32(&self.buf), out).unwrap();
        self.mc.validity(&rec, src, valid).unwrap();
        self.pre.back_masked(out, valid).unwrap();
        (rec.dy, rec.dx)
    }
}

struct Drift {
    gain: f32,
    offset: f32,
    p: Vec<f32>,
    c: Vec<f32>,
    width: usize,
    total: f32,
}

impl Drift {
    fn parse(spec: &str, dims: Dims, total: u32) -> Drift {
        let (mut gain, mut offset) = (0.0, 0.0);
        for kv in spec.split(',') {
            let (k, v) = kv.split_once('=').expect("--inject-drift gain=A,offset=B");
            match k {
                "gain" => gain = v.parse().unwrap(),
                "offset" => offset = v.parse().unwrap(),
                _ => panic!("--inject-drift: unknown {k}"),
            }
        }
        let mut st = 0x9e37_79b9_7f4a_7c15u64;
        let mut sign = move || {
            st = st
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if (st >> 40) & 1 == 1 {
                1.0f32
            } else {
                -1.0
            }
        };
        let p = (0..dims.pixels()).map(|_| sign()).collect();
        let c = (0..dims.width).map(|_| sign()).collect();
        Drift {
            gain,
            offset,
            p,
            c,
            width: dims.width,
            total: total.max(2) as f32 - 1.0,
        }
    }

    fn apply(&self, frame: &mut [u8], t: usize) {
        let a = t as f32 / self.total;
        let mut h = (t as u32).wrapping_mul(2654435761);
        for (i, v) in frame.iter_mut().enumerate() {
            h ^= h << 13;
            h ^= h >> 17;
            h ^= h << 5;
            let dith = (h >> 8) as f32 / (1u32 << 24) as f32;
            let x = f32::from(*v) * (1.0 + self.gain * a * self.p[i])
                + self.offset * a * self.c[i % self.width];
            *v = (x + dith).floor().clamp(0.0, 255.0) as u8;
        }
    }
}

fn read_u32(r: &mut impl Read) -> u32 {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).unwrap();
    u32::from_le_bytes(b)
}

fn read_f32s(r: &mut impl Read, n: usize) -> Vec<f32> {
    let mut b = vec![0u8; 4 * n];
    r.read_exact(&mut b).unwrap();
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

fn read_footprints(
    path: &Path,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    scfg: &SlowLoopConfig,
    flat: &mut GlowFlattener,
) -> Library {
    let mut f = BufReader::new(File::open(path).unwrap());
    let mut magic = [0u8; 8];
    f.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"CALAFP01");
    let (h, w, n) = (read_u32(&mut f), read_u32(&mut f), read_u32(&mut f));
    assert_eq!((h as usize, w as usize), (dims.height, dims.width));
    let mut b = LibraryBuilder::new(dims)
        .fov(fov.to_vec())
        .noise(noise.to_vec())
        .background(scfg.background.clone());
    let wd = dims.width;
    for _ in 0..n {
        let id = u64::from(read_u32(&mut f));
        let np = read_u32(&mut f) as usize;
        let pix: Vec<u32> = (0..np).map(|_| read_u32(&mut f)).collect();
        let a = read_f32s(&mut f, np);
        let _ = read_f32s(&mut f, np);
        if !a.iter().any(|&v| v > 0.0) {
            continue;
        }
        let y0 = pix.iter().map(|&q| q as usize / wd).min().unwrap();
        let y1 = pix.iter().map(|&q| q as usize / wd).max().unwrap();
        let x0 = pix.iter().map(|&q| q as usize % wd).min().unwrap();
        let x1 = pix.iter().map(|&q| q as usize % wd).max().unwrap();
        let (fh, fw) = (y1 - y0 + 1, x1 - x0 + 1);
        let mut values = vec![0.0f32; fh * fw];
        for (&q, &v) in pix.iter().zip(&a) {
            values[(q as usize / wd - y0) * fw + (q as usize % wd - x0)] = v.max(0.0);
        }
        b.push(Footprint {
            id,
            y0,
            x0,
            height: fh,
            width: fw,
            values,
        });
    }
    b.build(flat).unwrap()
}

fn extract(args: &[String]) {
    let avi_dir = Path::new(&args[2]).to_path_buf();
    let run = Path::new(&args[3]).to_path_buf();
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let n_px = dims.pixels();
    let frames = arg_value(args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    let cfg = PreprocessConfig::for_fps(20.0);
    let scfg = SlowLoopConfig {
        cell_diameter_px: cfg.flatten.cell_diameter_px,
        ..SlowLoopConfig::default()
    };
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    let pre0 = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let drift = arg_value(args, "--inject-drift").map(|d| Drift::parse(&d, dims, frames));
    let mut online: Option<OnlineFlatField> = None;
    if arg_value(args, "--flat-field")
        .as_deref()
        .unwrap_or("online")
        == "online"
        && !args.iter().any(|a| a == "--no-flat-field")
    {
        let secs = |k: &str, d: f32| arg_value(args, k).map_or(d, |s| s.parse().unwrap());
        let mut c = OnlineFlatFieldConfig::for_fps(20.0);
        let fr = |s: f32| (s * 20.0).round();
        c.estimator.half_life_frames = f64::from(fr(secs("--ff-gain-half-life", GAIN_HALF_LIFE_S)));
        c.estimator.offset_half_life_frames =
            f64::from(fr(secs("--ff-offset-half-life", OFFSET_HALF_LIFE_S)));
        c.first_frames = fr(secs("--ff-first", FIRST_MAP_S)).max(1.0) as u64;
        c.refine_every_frames = fr(secs("--ff-refine", REFINE_EVERY_S)).max(1.0) as u64;
        online = Some(OnlineFlatField::new(dims, &fov, c, None::<FlatFieldSeed>).unwrap());
    }
    let mut pipe = Pipeline::new(&mut rec, pre0, &cal);
    let src = calab_cala::motion::SourceMask::new(
        dims.height,
        dims.width,
        cal.fov().mask(),
        calab_cala::motion::Interpolation::Bicubic,
    )
    .unwrap();
    let mut valid = vec![0u8; n_px];
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();
    let noise = pipe.pre.noise().sigma();
    let lib = Arc::new(read_footprints(
        &run.join("footprints.bin"),
        dims,
        &fov,
        &noise,
        &scfg,
        &mut flat,
    ));
    let n = lib.len();
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut tr = FrameTraces::default();
    let mut out = BufWriter::new(File::create(run.join("dump_trace_ff.f32")).unwrap());
    let mut log = String::from("frame\tfirst\n");
    let mut y = vec![0.0f32; n_px];
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let mut raw = rec.read(s, cnt);
        if let Some(d) = &drift {
            for (k, f) in raw.chunks_exact_mut(n_px).enumerate() {
                d.apply(f, s as usize + k);
            }
        }
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            let shift = pipe.frame(f, &mut y, &src, &mut valid);
            if let Some(o) = online.as_mut() {
                o.push(f, shift).unwrap();
                if o.due() {
                    if let RefineOutcome::Updated(u) = o.refine() {
                        let ff: &FlatField = o.current().unwrap();
                        ff.apply(&mut pipe.pre).unwrap();
                        let _ = writeln!(log, "{t}\t{}", u8::from(u.first));
                    }
                }
            }
            eng.process_into(&y, &mut tr).unwrap();
            for v in &tr.traces {
                out.write_all(&v.to_le_bytes()).unwrap();
            }
        }
        s += cnt;
    }
    std::fs::write(run.join("extract_updates.tsv"), log).unwrap();
    eprintln!("extract: {n} cells x {frames} frames");
}
