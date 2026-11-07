//! Evaluate the fast loop (per-frame trace solve) on a minisim recording with
//! oracle (ground-truth) footprints.
//!
//! ```text
//! cargo run --release --example trace_eval -- <sim dir> <out dir> [options]
//!   --frames N       evaluate the first N frames (default: all)
//!   --fp full,core   footprint arms (default both): GT observed footprint
//!                    including the scatter halo, or its core component only
//!   --bg LIST        background arms, any of none,global,rank3,rank5,rank8,ring
//!                    (default all)
//!   --learn N        frames used to learn the background maps (default 200)
//!   --learn-iters N  alternate solve / learn N times (default 3)
//!   --tol / --omega / --sweeps   solver settings (default: SolverConfig)
//! ```
//!
//! `<sim dir>` is written by the calibration tooling's `gen.py`: a DAQ folder
//! (`daq/Miniscope/N.avi`) plus `oracle.bin` (per-unit footprints in FOV
//! coordinates, already multiplied by the illumination / vignette / vessel
//! gains and the photon-to-ADU factor, and the GT traces `C`). The movie is
//! streamed from the AVIs; only the learning frames are held in memory.
//!
//! Per arm it reports, over the library cells (minisim `detectable`) and the
//! in-focus subset: Pearson r of each estimated trace against its GT trace,
//! crosstalk (each estimated trace regressed on its own GT trace and the GT
//! traces of every unit within 30 px; the largest neighbour coefficient
//! relative to the own one) and amplitude bias (own coefficient − 1; the
//! footprints are in the units of `C`, so 0 is unbiased). Then the
//! per-frame solve time. One summary line per arm goes to `<out>/summary.tsv`.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};
use calab_cala::trace::{
    BackgroundLearner, BackgroundModel, Footprint, Library, LibraryBuilder, SolverConfig,
    TraceEngine,
};

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

struct Unit {
    detectable: bool,
    in_focus: bool,
    center: (f32, f32),
    full: Footprint,
    core: Footprint,
}

struct Oracle {
    dims: Dims,
    units: Vec<Unit>,
    n_frames: usize,
    /// `C[unit * n_frames + t]`.
    c: Vec<f32>,
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

fn read_oracle(path: &Path) -> Oracle {
    let mut r = BufReader::new(File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}")));
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, b"CALAORC1");
    let h = read_u32(&mut r) as usize;
    let w = read_u32(&mut r) as usize;
    let n = read_u32(&mut r) as usize;
    let t = read_u32(&mut r) as usize;
    let mut units = Vec::with_capacity(n);
    for _ in 0..n {
        let id = read_u32(&mut r);
        let mut flags = [0u8; 4];
        r.read_exact(&mut flags).unwrap();
        let cy = read_f32s(&mut r, 1)[0];
        let cx = read_f32s(&mut r, 1)[0];
        let mut fps = Vec::new();
        for _ in 0..2 {
            let y0 = read_u32(&mut r) as i32;
            let x0 = read_u32(&mut r) as i32;
            let ph = read_u32(&mut r) as usize;
            let pw = read_u32(&mut r) as usize;
            let values: Vec<f32> = read_f32s(&mut r, ph * pw)
                .into_iter()
                .map(|v| v.max(0.0))
                .collect();
            fps.push(Footprint {
                id: u64::from(id),
                y0: y0.max(0) as usize,
                x0: x0.max(0) as usize,
                height: ph,
                width: pw,
                values,
            });
        }
        let core = fps.pop().unwrap();
        let full = fps.pop().unwrap();
        units.push(Unit {
            detectable: flags[0] != 0,
            in_focus: flags[1] != 0,
            center: (cy, cx),
            full,
            core,
        });
    }
    let c = read_f32s(&mut r, n * t);
    Oracle {
        dims: Dims::new(w, h).unwrap(),
        units,
        n_frames: t,
        c,
    }
}

fn pearson(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len() as f64;
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

/// Least squares `y ≈ X b + b0` (columns of `x` centred internally).
fn regress(y: &[f32], xs: &[&[f32]]) -> Option<Vec<f64>> {
    let k = xs.len();
    let t = y.len();
    let my = y.iter().map(|&v| f64::from(v)).sum::<f64>() / t as f64;
    let mx: Vec<f64> = xs
        .iter()
        .map(|x| x.iter().map(|&v| f64::from(v)).sum::<f64>() / t as f64)
        .collect();
    let mut a = vec![0.0f64; k * k];
    let mut rhs = vec![0.0f64; k];
    for s in 0..t {
        let yv = f64::from(y[s]) - my;
        for i in 0..k {
            let xi = f64::from(xs[i][s]) - mx[i];
            rhs[i] += xi * yv;
            for j in i..k {
                a[i * k + j] += xi * (f64::from(xs[j][s]) - mx[j]);
            }
        }
    }
    for i in 0..k {
        for j in 0..i {
            a[i * k + j] = a[j * k + i];
        }
        a[i * k + i] *= 1.0 + 1e-9;
    }
    // Gaussian elimination.
    let mut m = a;
    let mut b = rhs;
    for c in 0..k {
        let p = (c..k).max_by(|&r, &s| m[r * k + c].abs().total_cmp(&m[s * k + c].abs()))?;
        if m[p * k + c].abs() < 1e-12 {
            return None;
        }
        for j in 0..k {
            m.swap(p * k + j, c * k + j);
        }
        b.swap(p, c);
        for r in c + 1..k {
            let f = m[r * k + c] / m[c * k + c];
            for j in c..k {
                m[r * k + j] -= f * m[c * k + j];
            }
            b[r] -= f * b[c];
        }
    }
    let mut out = vec![0.0f64; k];
    for c in (0..k).rev() {
        let s: f64 = (c + 1..k).map(|j| m[c * k + j] * out[j]).sum();
        out[c] = (b[c] - s) / m[c * k + c];
    }
    Some(out)
}

/// R² of the fit `y ≈ Σ b_k x_k + b0`.
fn r2(y: &[f32], xs: &[&[f32]], b: &[f64]) -> f64 {
    let t = y.len();
    let fit: Vec<f64> = (0..t)
        .map(|s| xs.iter().zip(b).map(|(x, &bk)| bk * f64::from(x[s])).sum())
        .collect();
    let my = y.iter().map(|&v| f64::from(v)).sum::<f64>() / t as f64;
    let mf = fit.iter().sum::<f64>() / t as f64;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&yv, &fv) in y.iter().zip(&fit) {
        let (a, c) = (f64::from(yv) - my, fv - mf);
        sab += a * c;
        saa += a * a;
        sbb += c * c;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab * sab / (saa * sbb)
    }
}

fn quantile(v: &[f64], q: f64) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(f64::total_cmp);
    let pos = q * (s.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    s[lo] + (s[hi] - s[lo]) * (pos - lo as f64)
}

struct Metrics {
    r: Vec<f64>,
    xtalk: Vec<f64>,
    bias: Vec<f64>,
}

/// `traces[slot * t + s]` against the oracle, for the library slots.
fn metrics(oracle: &Oracle, lib_units: &[usize], traces: &[f32], t: usize) -> Metrics {
    let nf = oracle.n_frames;
    let gt = |u: usize| &oracle.c[u * nf..u * nf + t];
    let mut out = Metrics {
        r: Vec::new(),
        xtalk: Vec::new(),
        bias: Vec::new(),
    };
    for (slot, &u) in lib_units.iter().enumerate() {
        let est = &traces[slot * t..(slot + 1) * t];
        out.r.push(pearson(est, gt(u)));
        let cu = oracle.units[u].center;
        let mut nb: Vec<(f32, usize)> = oracle
            .units
            .iter()
            .enumerate()
            .filter(|&(j, v)| j != u && v.center.0 >= 0.0)
            .map(|(j, v)| {
                let (dy, dx) = (v.center.0 - cu.0, v.center.1 - cu.1);
                (dy * dy + dx * dx, j)
            })
            .filter(|&(d2, _)| d2 <= 30.0 * 30.0)
            .collect();
        nb.sort_by(|a, b| a.0.total_cmp(&b.0));
        nb.truncate(12);
        let mut xs: Vec<&[f32]> = vec![gt(u)];
        xs.extend(nb.iter().map(|&(_, j)| gt(j)));
        match regress(est, &xs) {
            Some(b) if b[0].abs() > 1e-9 => {
                out.bias.push(b[0] - 1.0);
                // Crosstalk: share of the explained variance that needs the
                // neighbours, (R²_all − R²_own) / R²_all.
                let r_own = pearson(est, gt(u)).powi(2);
                let r_all = r2(est, &xs, &b);
                out.xtalk.push(if r_all > 0.0 {
                    ((r_all - r_own) / r_all).max(0.0)
                } else {
                    f64::NAN
                });
            }
            _ => {
                out.bias.push(f64::NAN);
                out.xtalk.push(f64::NAN);
            }
        }
    }
    out
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sim = PathBuf::from(args.get(1).expect("sim dir"));
    let out_dir = PathBuf::from(args.get(2).expect("out dir"));
    std::fs::create_dir_all(&out_dir).unwrap();
    let fp_arms: Vec<String> = arg_value(&args, "--fp")
        .unwrap_or_else(|| "full,core".into())
        .split(',')
        .map(String::from)
        .collect();
    let bg_arms: Vec<String> = arg_value(&args, "--bg")
        .unwrap_or_else(|| "none,global,rank3,rank5,rank8,ring".into())
        .split(',')
        .map(String::from)
        .collect();
    let learn_iters: usize = arg_value(&args, "--learn-iters").map_or(3, |s| s.parse().unwrap());
    let learn: u32 = arg_value(&args, "--learn").map_or(200, |s| s.parse().unwrap());
    let mut solver = SolverConfig::default();
    if let Some(v) = arg_value(&args, "--tol") {
        solver.tol = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--omega") {
        solver.relax = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--sweeps") {
        solver.max_sweeps = v.parse().unwrap();
    }

    let oracle = read_oracle(&sim.join("oracle.bin"));
    let mut rec = Recording::open(&sim.join("daq/Miniscope"));
    let dims = rec.dims;
    assert_eq!(dims, oracle.dims);
    let n_px = dims.pixels();
    let frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total)
        .min(oracle.n_frames as u32);
    let t = frames as usize;
    // ---- calibration and the preprocessing start state
    let cfg = PreprocessConfig::for_fps(20.0);
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov_mask = cal.fov().mask().to_vec();
    // Library = minisim's detectable units whose centre is inside the lit FOV.
    let lib_units: Vec<usize> = (0..oracle.units.len())
        .filter(|&u| {
            let un = &oracle.units[u];
            let (cy, cx) = (un.center.0.round(), un.center.1.round());
            un.detectable && cy >= 0.0 && fov_mask[cy as usize * dims.width + cx as usize] != 0
        })
        .collect();
    let focus: Vec<bool> = lib_units
        .iter()
        .map(|&u| oracle.units[u].in_focus)
        .collect();
    println!(
        "sim {}: {}x{}, {} frames, {} units, {} in library ({} in focus)",
        sim.display(),
        dims.width,
        dims.height,
        t,
        oracle.units.len(),
        lib_units.len(),
        focus.iter().filter(|&&f| f).count()
    );

    let pre0 = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();

    // ---- learning pass: preprocess the first frames once, keep them
    let learn = learn.min(frames);
    let mut pre = pre0.clone();
    let mut learn_frames = vec![0.0f32; learn as usize * n_px];
    let t0 = Instant::now();
    let mut s = 0;
    while s < learn {
        let cnt = 64.min(learn - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let o = (s as usize + k) * n_px;
            pre.process_frame(f, &mut learn_frames[o..o + n_px])
                .unwrap();
        }
        s += cnt;
    }
    let noise = pre.noise().sigma();
    println!(
        "learning pass: {learn} frames preprocessed in {:.2} s",
        t0.elapsed().as_secs_f64()
    );

    let mut summary = File::options()
        .create(true)
        .append(true)
        .open(out_dir.join("summary.tsv"))
        .unwrap();
    let sim_name = sim.file_name().unwrap().to_string_lossy().to_string();

    for fp_arm in &fp_arms {
        let t_build = Instant::now();
        let mut b = LibraryBuilder::new(dims)
            .fov(fov_mask.clone())
            .noise(noise.clone());
        for &u in &lib_units {
            let unit = &oracle.units[u];
            let fp = if fp_arm == "core" {
                &unit.core
            } else {
                &unit.full
            };
            b.push(fp.clone());
        }
        let lib0 = b.build(&mut flat).unwrap();
        let build_s = t_build.elapsed().as_secs_f64();
        let sizes: Vec<f64> = (0..lib0.len())
            .map(|i| lib0.filtered(i).0.len() as f64)
            .collect();
        let gs: Vec<f64> = lib0.groups().iter().map(|g| g.len() as f64).collect();
        println!(
            "[{fp_arm}] library: {} cells built in {build_s:.2} s; support median {:.0} px; {} overlap groups (largest {})",
            lib0.len(),
            quantile(&sizes, 0.5),
            gs.len(),
            gs.iter().copied().fold(0.0, f64::max)
        );
        // Background maps from the learning frames' residual: solve without a
        // background, learn maps from the residual, then (`--learn-iters` > 1)
        // re-solve with them and learn again from the cell-only residual.
        let mut fit = None;
        for _ in 0..learn_iters {
            let lib_l = match &fit {
                None => lib0.clone(),
                Some(f) => {
                    let f: &calab_cala::trace::BackgroundFit = f;
                    lib0.with_background(BackgroundModel::Basis(f.maps[..6].to_vec()))
                        .unwrap()
                }
            };
            let mut learner =
                BackgroundLearner::new(dims, Some(&fov_mask), 4, 8.0, learn as usize).unwrap();
            let mut eng = TraceEngine::new(Arc::new(lib_l), solver).unwrap();
            let mut model = vec![0.0f32; n_px];
            for f in learn_frames.chunks_exact(n_px) {
                let r = eng.process(f).unwrap();
                lib0.render(&r.traces, None, &mut model).unwrap();
                for (m, &y) in model.iter_mut().zip(f) {
                    *m = y - *m;
                }
                learner.push(&model).unwrap();
            }
            fit = Some(learner.fit(9).unwrap());
        }
        let fit = fit.unwrap();
        let ef: Vec<String> = fit
            .energy
            .iter()
            .map(|e| format!("{:.3}", e / fit.total_energy))
            .collect();
        println!("[{fp_arm}] background energy fractions: {}", ef.join(" "));

        for bg in &bg_arms {
            let model = match bg.as_str() {
                "none" => BackgroundModel::None,
                "global" => BackgroundModel::Basis(fit.maps[..1].to_vec()),
                "ring" => BackgroundModel::Ring {
                    inner_px: 12.0,
                    outer_px: 20.0,
                },
                s if s.starts_with("rank") => {
                    let k: usize = s[4..].parse().unwrap();
                    BackgroundModel::Basis(fit.maps[..1 + k].to_vec())
                }
                other => panic!("unknown background arm {other}"),
            };
            let lib: Arc<Library> = Arc::new(lib0.with_background(model).unwrap());
            let mut engine = TraceEngine::new(lib.clone(), solver).unwrap();
            let n = lib.len();
            let mut traces = vec![0.0f32; n * t];
            let mut pre = pre0.clone();
            let mut buf = vec![0.0f32; n_px];
            let (mut t_pre, mut t_solve) = (0.0f64, 0.0f64);
            let mut sweeps = Vec::with_capacity(t);
            let mut s = 0u32;
            while s < frames {
                let cnt = 64.min(frames - s);
                let raw = rec.read(s, cnt);
                for (k, f) in raw.chunks_exact(n_px).enumerate() {
                    let a = Instant::now();
                    pre.process_frame(f, &mut buf).unwrap();
                    let bt = Instant::now();
                    let r = engine.process(&buf).unwrap();
                    t_solve += bt.elapsed().as_secs_f64();
                    t_pre += (bt - a).as_secs_f64();
                    let fi = s as usize + k;
                    for (i, &v) in r.traces.iter().enumerate() {
                        traces[i * t + fi] = v;
                    }
                    sweeps.push(f64::from(r.sweeps));
                }
                s += cnt;
            }
            let m = metrics(&oracle, &lib_units, &traces, t);
            let pick = |v: &[f64], f: bool| -> Vec<f64> {
                v.iter()
                    .zip(&focus)
                    .filter(|(_, &x)| !f || x)
                    .map(|(&a, _)| a)
                    .collect()
            };
            let line = |f: bool| {
                let r = pick(&m.r, f);
                let x = pick(&m.xtalk, f);
                let bi = pick(&m.bias, f);
                format!(
                    "{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:+.3}\t{:+.3}",
                    quantile(&r, 0.5),
                    quantile(&r, 0.1),
                    quantile(&x, 0.5),
                    quantile(&x, 0.9),
                    quantile(&bi, 0.5),
                    quantile(&bi, 0.1)
                )
            };
            let fps_solve = t as f64 / t_solve;
            println!(
                "[{fp_arm}/{bg}] all: r med/p10, xtalk med/p90, bias med/p10 = {}",
                line(false).replace('\t', " ")
            );
            println!(
                "[{fp_arm}/{bg}] in-focus: {}  | solve {:.0} fps (mean sweeps {:.1}, p99 {:.0}), preprocess {:.0} fps",
                line(true).replace('\t', " "),
                fps_solve,
                sweeps.iter().sum::<f64>() / t as f64,
                quantile(&sweeps, 0.99),
                t as f64 / t_pre
            );
            writeln!(
                summary,
                "{sim_name}\t{fp_arm}\t{bg}\t{n}\t{}\tfocus\t{}\t{fps_solve:.0}",
                line(false),
                line(true)
            )
            .unwrap();
            // Per-cell metrics and a few traces for figures.
            let mut f =
                File::create(out_dir.join(format!("{sim_name}_{fp_arm}_{bg}_cells.tsv"))).unwrap();
            writeln!(f, "unit\tin_focus\tr\txtalk\tbias").unwrap();
            for (slot, &u) in lib_units.iter().enumerate() {
                writeln!(
                    f,
                    "{u}\t{}\t{:.4}\t{:.4}\t{:.4}",
                    u8::from(focus[slot]),
                    m.r[slot],
                    m.xtalk[slot],
                    m.bias[slot]
                )
                .unwrap();
            }
            let mut f =
                File::create(out_dir.join(format!("{sim_name}_{fp_arm}_{bg}_traces.f32"))).unwrap();
            for v in &traces {
                f.write_all(&v.to_le_bytes()).unwrap();
            }
        }
    }
}
