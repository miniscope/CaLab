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
//!   --inject-flicker M,A[,SEED]  add a global flicker y = a_t + (1 + m_t) x to
//!                    the movie (2-8 Hz broadband series with RMS M and A grey
//!                    levels, re-quantized to 8 bits), see examples/flicker_eval.rs
//!   --flicker-mode N 0 off, 1 additive, 2 multiplicative, 3 both (default)
//!   --flicker-tau T  flicker reference time constant, frames
//! ```
//!
//! `<sim dir>` is written by `tools/minisim-calibration/make_trace_sim.py`: a DAQ folder
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

#[path = "common/oracle.rs"]
mod oracle;
use oracle::{read_oracle, Oracle};

#[path = "common/avi.rs"]
mod avi;
#[path = "common/util.rs"]
mod util;
use avi::Recording;
use util::{arg_value, pearson, quantile};

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, PreprocessConfig, Preprocessor};
use calab_cala::trace::{
    BackgroundLearner, BackgroundModel, Library, LibraryBuilder, SolverConfig, TraceEngine,
};

/// Frames `start..start + count` of `rec` with the injected flicker
/// `y = a_t + (1 + m_t) x` (rounded, clamped to 8 bits), if any.
fn read_flickered(
    rec: &mut Recording,
    flicker: &Option<(Vec<f64>, Vec<f64>)>,
    start: u32,
    count: u32,
) -> Vec<u8> {
    let mut out = rec.read(start, count);
    if let Some((a, m)) = flicker {
        let px = rec.dims.pixels();
        for (k, f) in out.chunks_exact_mut(px).enumerate() {
            let t = start as usize + k;
            let (a, g) = (a[t] as f32, (1.0 + m[t]) as f32);
            for v in f {
                *v = (a + g * f32::from(*v)).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// 2-8 Hz broadband series with RMS `amp` (same as examples/flicker_eval.rs).
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
    let r = (x.iter().map(|v| v * v).sum::<f64>() / n.max(1) as f64).sqrt();
    x.iter().map(|v| v * amp / r).collect()
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
    let mut rec = Recording::open(&sim.join("daq/Miniscope"), 1);
    // Injected flicker `(a_t, m_t)` per frame (`--inject-flicker`).
    let mut flicker: Option<(Vec<f64>, Vec<f64>)> = None;
    let dims = rec.dims;
    assert_eq!(dims, oracle.dims);
    let n_px = dims.pixels();
    let frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total)
        .min(oracle.n_frames as u32);
    let t = frames as usize;
    if let Some(spec) = arg_value(&args, "--inject-flicker") {
        let v: Vec<f64> = spec.split(',').map(|x| x.parse().unwrap()).collect();
        let seed = v.get(2).map_or(1, |&s| s as u64);
        let n = rec.total as usize;
        flicker = Some((
            flicker_series(n, 20.0, v[1], seed + 1000),
            flicker_series(n, 20.0, v[0], seed),
        ));
        println!(
            "injected flicker: m rms {}, a rms {} grey levels",
            v[0], v[1]
        );
    }
    // ---- calibration and the preprocessing start state
    let mut cfg = PreprocessConfig::for_fps(20.0);
    if let Some(m) = arg_value(&args, "--flicker-mode") {
        cfg.flicker.mode =
            calab_cala::preprocess::flicker::FlickerMode::from_code(m.parse().unwrap())
                .expect("flicker mode 0..=3");
    }
    if let Some(v) = arg_value(&args, "--flicker-tau") {
        cfg.flicker.tau_frames = v.parse().unwrap();
    }
    let warm = read_flickered(
        &mut rec,
        &flicker,
        0,
        (cfg.warmup_frames as u32).min(frames),
    );
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
        let raw = read_flickered(&mut rec, &flicker, s, cnt);
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
                let raw = read_flickered(&mut rec, &flicker, s, cnt);
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
