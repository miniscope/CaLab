//! Evaluate motion correction on real or simulated Miniscope recordings.
//!
//! ```text
//! cargo run --release --example motion_eval -- minisim <daq_dir> <gt_dir> [frames]
//! cargo run --release --example motion_eval -- real <avi_dir> <ref_dir> [frames]
//! cargo run --release --example motion_eval -- synthetic <avi_dir>
//! ```
//!
//! * `minisim`: `<daq_dir>/Miniscope/*.avi` with ground truth in `<gt_dir>`
//!   (`shifts.npy`, `nonrigid_field.npy`, `nonrigid_nodes_{y,x}.npy`, as
//!   extracted from minisim's `arrays.npz`). Reports rigid RMSE against the
//!   true rigid shifts and patch RMSE at the corrector's patch centres with
//!   and without the non-rigid stage (minisim's `shift_rmse` /
//!   `patch_shift_rmse` with `correction=True, align=True`), and throughput.
//! * `real`: `<avi_dir>/*.avi` against a reference registration in
//!   `<ref_dir>`: `shifts.npy` (or `shifts_it2.npy`), `(frame, 2)` registering
//!   shifts, and `patch_shifts.npy` / `patch_idx.npy`, `(k, 3, 3, 2)` shifts of
//!   93 px patches at rows/cols 160 + {0, 93, 187} for the frames `patch_idx`.
//! * `synthetic`: warps the mean of the first frames with known rigid +
//!   non-rigid motion and checks the recovered records.
//!
//! Set `MOTION_UPSAMPLE`, `MOTION_ANCHOR`, `MOTION_ALPHA` (temporal), `MOTION_GRID`
//! (e.g. `5x5`), `MOTION_SAVE=<dir>` (write rigid shifts as .npy), `MOTION_BILINEAR=1`, `MOTION_NOSHRINK=1`, `MOTION_TAU`, `MOTION_SIGMA2` to vary the
//! configuration.

#[path = "../tests/common/metrics.rs"]
mod metrics;
#[path = "../tests/common/npy.rs"]
mod npy;

use std::path::{Path, PathBuf};
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::motion::{
    Frame, Frames, Interpolation, MotionConfig, MotionCorrector, MotionGeometry, MotionRecord,
    NonRigidConfig, Warper,
};
use metrics::{patch_rmse_aligned, shift_rmse_aligned, Truth};
use npy::Npy;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

/// Frames of a folder of numbered AVIs, read one file at a time.
struct AviFrames {
    files: Vec<PathBuf>,
    width: usize,
    height: usize,
    /// In-memory movie (from `movie.npy`) instead of files.
    movie: Option<Vec<u8>>,
}

impl AviFrames {
    fn open(dir: &Path) -> Res<Self> {
        let mut files: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "avi"))
            .filter_map(|p| {
                let n = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
                Some((n, p))
            })
            .collect();
        files.sort();
        let files: Vec<PathBuf> = files.into_iter().map(|f| f.1).collect();
        let first = files.first().ok_or("no numbered .avi files")?;
        let (h, _) = Self::load(first)?;
        let (width, height) = (h.info().width as usize, h.info().height as usize);
        Ok(AviFrames {
            files,
            width,
            height,
            movie: None,
        })
    }

    fn from_npy(path: &Path) -> Res<Self> {
        let m = Npy::read(path)?;
        let (height, width) = (m.shape[1], m.shape[2]);
        Ok(AviFrames {
            files: Vec::new(),
            width,
            height,
            movie: Some(m.into_u8()?),
        })
    }

    fn load(path: &Path) -> Res<(AviHeader, Vec<u8>)> {
        let bytes = std::fs::read(path)?;
        let layout = AviHeader::parse_header(&bytes)?;
        let movi_end = layout.info.movi_end as usize;
        let idx1 = if movi_end > 0 && movi_end + 8 <= bytes.len() {
            idx1_payload_len(&bytes[movi_end..movi_end + 8])
                .ok()
                .and_then(|len| bytes.get(movi_end + 8..movi_end + 8 + len as usize))
        } else {
            None
        };
        let header = AviHeader::parse_with_size(&bytes, idx1, bytes.len() as u64)?;
        Ok((header, bytes))
    }

    /// Call `f(index, pixels)` for up to `max` frames.
    fn for_each(&self, max: usize, mut f: impl FnMut(usize, &[u8]) -> Res<()>) -> Res<usize> {
        let mut k = 0;
        if let Some(m) = &self.movie {
            for px in m.chunks(self.width * self.height).take(max) {
                f(k, px)?;
                k += 1;
            }
            return Ok(k);
        }
        for path in &self.files {
            if k >= max {
                break;
            }
            let (h, bytes) = Self::load(path)?;
            for i in 0..h.frame_count() {
                if k >= max {
                    break;
                }
                let (a, b) = h.frame_range(i)?;
                let px = h.decode_frame(&bytes[a as usize..b as usize])?;
                f(k, &px)?;
                k += 1;
            }
        }
        Ok(k)
    }

    fn first(&self, n: usize) -> Res<Vec<u8>> {
        let mut out = Vec::with_capacity(n * self.width * self.height);
        self.for_each(n, |_, px| {
            out.extend_from_slice(px);
            Ok(())
        })?;
        Ok(out)
    }
}

fn env_f32(name: &str) -> Option<f32> {
    std::env::var(name).ok()?.parse().ok()
}

fn config(nonrigid: bool) -> MotionConfig {
    let mut c = MotionConfig::default();
    if let Some(v) = env_f32("MOTION_UPSAMPLE") {
        c.upsample = v as u32;
    }
    if let Some(v) = env_f32("MOTION_ANCHOR") {
        c.anchor_weight = v;
    }
    if let Some(v) = env_f32("MOTION_TAU") {
        c.template_tau = v;
    }
    if let Some(v) = env_f32("MOTION_SIGMA2") {
        c.dog_sigma_large = v;
    }
    if std::env::var("MOTION_BILINEAR").is_ok_and(|v| v == "1") {
        c.interpolation = Interpolation::Bilinear;
    }
    if nonrigid {
        let mut n = NonRigidConfig::default();
        if let Some(v) = env_f32("MOTION_ALPHA") {
            n.temporal_alpha = v;
        }
        if std::env::var("MOTION_NOSHRINK").is_ok() {
            n.shrink = false;
        }
        if let Ok(g) = std::env::var("MOTION_GRID") {
            if let Some((a, b)) = g.split_once('x') {
                n.grid = (a.parse().unwrap_or(4), b.parse().unwrap_or(4));
            }
        }
        c.nonrigid = Some(n);
    }
    c
}

struct Run {
    records: Vec<MotionRecord>,
    geometry: MotionGeometry,
    fps: f64,
    warmup_s: f64,
    crispness: f64,
}

fn run(src: &AviFrames, cfg: MotionConfig, max: usize, warm: usize) -> Res<Run> {
    let (h, w) = (src.height, src.width);
    let mut mc = MotionCorrector::new(h, w, cfg)?;
    let t0 = Instant::now();
    let warm_frames = src.first(warm.min(max))?;
    mc.initialize(Frames::U8(&warm_frames))?;
    let warmup_s = t0.elapsed().as_secs_f64();
    drop(warm_frames);
    let mut out = vec![0.0f32; h * w];
    let mut mean = vec![0.0f64; h * w];
    let mut records = Vec::new();
    let mut busy = 0.0f64;
    // Optional probe: a second, non-rigid corrector (no smoothing or
    // shrinkage, frozen template) run on the corrected output. Its residual
    // patch shifts measure the deformation the first pass left behind.
    let probe_on = std::env::var("MOTION_PROBE").is_ok();
    let probe_warm = 100usize;
    let mut probe_buf: Vec<f32> = Vec::new();
    let mut probe: Option<MotionCorrector> = None;
    let mut probe_res: Vec<Vec<f32>> = Vec::new();
    let probe_cfg = MotionConfig {
        template_tau: 0.0,
        nonrigid: Some(NonRigidConfig {
            temporal_alpha: 1.0,
            shrink: false,
            ..NonRigidConfig::default()
        }),
        ..MotionConfig::default()
    };
    src.for_each(max, |_, px| {
        let t = Instant::now();
        let r = mc.process(Frame::U8(px), &mut out)?;
        busy += t.elapsed().as_secs_f64();
        records.push(r);
        for (m, &v) in mean.iter_mut().zip(&out) {
            *m += v as f64;
        }
        if probe_on {
            let mut tmp = vec![0.0f32; h * w];
            if let Some(p) = probe.as_mut() {
                probe_res.push(p.process(Frame::F32(&out), &mut tmp)?.residual);
            } else {
                probe_buf.extend_from_slice(&out);
                if probe_buf.len() == probe_warm * h * w {
                    let mut p = MotionCorrector::new(h, w, probe_cfg.clone())?;
                    p.initialize(Frames::F32(&probe_buf))?;
                    for f in probe_buf.chunks(h * w) {
                        probe_res.push(p.process(Frame::F32(f), &mut tmp)?.residual);
                    }
                    probe_buf = Vec::new();
                    probe = Some(p);
                }
            }
        }
        Ok(())
    })?;
    if !probe_res.is_empty() {
        let k = probe_res[0].len();
        let n = probe_res.len() as f64;
        let (mut acc, mut dacc) = (0.0, 0.0);
        for c in 0..k {
            let m = probe_res.iter().map(|r| r[c] as f64).sum::<f64>() / n;
            acc += probe_res
                .iter()
                .map(|r| (r[c] as f64 - m).powi(2))
                .sum::<f64>();
            dacc += probe_res
                .windows(2)
                .map(|w| ((w[1][c] - w[0][c]) as f64).powi(2) / 2.0)
                .sum::<f64>();
        }
        let total = acc / (n * k as f64);
        let white = dacc / ((n - 1.0) * k as f64);
        println!(
            "    probe: residual deformation left after correction, RMS {:.4} px over {} frames (frame-to-frame white part {:.4}, slow part {:.4})",
            total.sqrt(),
            probe_res.len(),
            white.sqrt(),
            (total - white).max(0.0).sqrt()
        );
    }
    let geometry = mc.geometry().ok_or("no geometry")?.clone();
    let n = records.len() as f64;
    mean.iter_mut().for_each(|m| *m /= n);
    Ok(Run {
        fps: n / busy,
        crispness: crispness(&mean, w, geometry.roi),
        records,
        geometry,
        warmup_s,
    })
}

/// Crispness of a mean image (Pnevmatikakis & Giovannucci 2017): the
/// Frobenius norm of its gradient over the region, per pixel. A sharper mean
/// (better registered movie) scores higher.
fn crispness(img: &[f64], w: usize, roi: calab_cala::motion::Roi) -> f64 {
    let mut acc = 0.0;
    for y in roi.y0 + 1..roi.y0 + roi.height - 1 {
        for x in roi.x0 + 1..roi.x0 + roi.width - 1 {
            let gy = (img[(y + 1) * w + x] - img[(y - 1) * w + x]) / 2.0;
            let gx = (img[y * w + x + 1] - img[y * w + x - 1]) / 2.0;
            acc += gy * gy + gx * gx;
        }
    }
    (acc / ((roi.height - 2) * (roi.width - 2)) as f64).sqrt()
}

fn pairs(v: Vec<f64>) -> Vec<(f64, f64)> {
    v.chunks(2).map(|c| (c[0], c[1])).collect()
}

fn rigid(r: &Run) -> Vec<(f64, f64)> {
    r.records
        .iter()
        .map(|r| (r.dy as f64, r.dx as f64))
        .collect()
}

/// Registering shift of a run at `pts` for every frame (rigid + field).
fn at_points(r: &Run, pts: &[(usize, usize)]) -> Res<Vec<Vec<(f64, f64)>>> {
    let warper = r.geometry.warper()?;
    Ok(r.records
        .iter()
        .map(|rec| {
            pts.iter()
                .map(|&(y, x)| {
                    let (dy, dx) = warper.displacement_at((rec.dy, rec.dx), &rec.residual, y, x);
                    (dy as f64, dx as f64)
                })
                .collect()
        })
        .collect())
}

fn summary(name: &str, r: &Run) {
    let held = r.records.iter().filter(|x| x.flags & 4 != 0).count();
    let bright = r.records.iter().filter(|x| x.flags & 16 != 0).count();
    let lowq = r.records.iter().filter(|x| x.flags & 32 != 0).count();
    let anom = format!(
        "{} (brightness {bright}, low quality {lowq})",
        r.records.iter().filter(|x| x.flags & 2 != 0).count()
    );
    let mut q: Vec<f32> = r.records.iter().map(|x| x.quality).collect();
    q.sort_by(f32::total_cmp);
    println!(
        "  [{name}] {} frames, {:.0} frames/s, warm-up {:.2} s, roi {:?}, crispness {:.4}, quality median {:.3} p1 {:.3}, anomalous {anom}, held {held}",
        r.records.len(),
        r.fps,
        r.warmup_s,
        r.geometry.roi,
        r.crispness,
        q[q.len() / 2],
        q[q.len() / 100],
    );
}

fn minisim(dir: &Path, gt: &Path, max: usize) -> Res<()> {
    let src = if dir.join("movie.npy").exists() {
        AviFrames::from_npy(&dir.join("movie.npy"))?
    } else {
        AviFrames::open(&dir.join("Miniscope"))?
    };
    let truth = Truth {
        shifts: pairs(Npy::read(gt.join("shifts.npy"))?.into_f64()),
        field: Npy::read(gt.join("nonrigid_field.npy"))?.into_f64(),
        nodes_y: Npy::read(gt.join("nonrigid_nodes_y.npy"))?.into_f64(),
        nodes_x: Npy::read(gt.join("nonrigid_nodes_x.npy"))?.into_f64(),
    };
    let n = max.min(truth.frames());
    let rg = run(&src, config(false), n, 200)?;
    summary("rigid", &rg);
    let nr = run(&src, config(true), n, 200)?;
    summary("non-rigid", &nr);
    let shifts = &truth.shifts[..rg.records.len()];
    println!(
        "  rigid RMSE vs true rigid shifts: rigid-only run {:.4} px, non-rigid run {:.4} px",
        shift_rmse_aligned(&rigid(&rg), shifts),
        shift_rmse_aligned(&rigid(&nr), shifts),
    );
    for (ax, label) in [(0, "dy"), (1, "dx")] {
        let a: Vec<f64> = rigid(&rg)
            .iter()
            .map(|v| -if ax == 0 { v.0 } else { v.1 })
            .collect();
        let b: Vec<f64> = shifts
            .iter()
            .map(|v| if ax == 0 { v.0 } else { v.1 })
            .collect();
        let (c, rms) = corr_rms(&a, &b);
        println!("    {label}: corr {c:.4} with the true rigid shift, RMS diff {rms:.4} px");
    }
    let g = &nr.geometry;
    let pts: Vec<(usize, usize)> = g
        .node_ys
        .iter()
        .flat_map(|&y| {
            g.node_xs
                .iter()
                .map(move |&x| (y.round() as usize, x.round() as usize))
        })
        .collect();
    let ptsf: Vec<(f64, f64)> = pts.iter().map(|&(y, x)| (y as f64, x as f64)).collect();
    let frames: Vec<usize> = (0..nr.records.len()).collect();
    let e_on = patch_rmse_aligned(&at_points(&nr, &pts)?, &truth, &frames, &ptsf);
    let e_off = patch_rmse_aligned(&at_points(&rg, &pts)?, &truth, &frames, &ptsf);
    println!(
        "  patch RMSE at the {} patch centres: rigid-only {e_off:.4} px, non-rigid {e_on:.4} px",
        pts.len()
    );
    // Residual (local minus rigid) parts: true vs estimated, per patch.
    let est = at_points(&nr, &pts)?;
    let (mut tv, mut ev) = (Vec::new(), Vec::new());
    for (f, rec) in nr.records.iter().enumerate() {
        let t = truth.displacement(f, &ptsf);
        let tm = (
            t.iter().map(|v| v.0).sum::<f64>() / t.len() as f64,
            t.iter().map(|v| v.1).sum::<f64>() / t.len() as f64,
        );
        for (p, tp) in t.iter().enumerate() {
            tv.push(tp.0 - tm.0);
            tv.push(tp.1 - tm.1);
            ev.push(-(est[f][p].0 - rec.dy as f64));
            ev.push(-(est[f][p].1 - rec.dx as f64));
        }
    }
    let (c, rms) = corr_rms(&ev, &tv);
    let r = |v: &[f64]| (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt();
    println!(
        "  residual (patch minus patch-mean): true RMS {:.4}, estimated RMS {:.4}, corr {c:.3}, RMS diff {rms:.4}",
        r(&tv),
        r(&ev)
    );
    Ok(())
}

fn real(dir: &Path, refdir: &Path, max: usize) -> Res<()> {
    let src = AviFrames::open(dir)?;
    let ref_path = if refdir.join("shifts.npy").exists() {
        refdir.join("shifts.npy")
    } else {
        refdir.join("shifts_it2.npy")
    };
    let reference = pairs(Npy::read(&ref_path)?.into_f64());
    let n = max.min(reference.len());
    for (name, cfg) in [("rigid", config(false)), ("non-rigid", config(true))] {
        let r = run(&src, cfg, n, 200)?;
        summary(name, &r);
        let est = rigid(&r);
        if let Ok(dir) = std::env::var("MOTION_SAVE") {
            save_shifts(&Path::new(&dir).join(format!("cala_{name}.npy")), &est)?;
        }
        let m = est.len();
        for (ax, label) in [(0, "dy"), (1, "dx")] {
            let a: Vec<f64> = est
                .iter()
                .map(|v| if ax == 0 { v.0 } else { v.1 })
                .collect();
            let b: Vec<f64> = reference[..m]
                .iter()
                .map(|v| if ax == 0 { v.0 } else { v.1 })
                .collect();
            let (c, rms) = corr_rms(&a, &b);
            println!(
                "    {label}: corr {c:.4}, RMS diff {rms:.4} px (after removing the mean offset)"
            );
        }
        if name == "non-rigid" {
            compare_patches(&r, refdir)?;
        }
    }
    Ok(())
}

/// Write `(n, 2)` float64 shifts as `.npy` (for offline analysis).
fn save_shifts(path: &Path, v: &[(f64, f64)]) -> Res<()> {
    let header = format!(
        "{{'descr': '<f8', 'fortran_order': False, 'shape': ({}, 2), }}",
        v.len()
    );
    let mut h = header.into_bytes();
    while (10 + h.len() + 1) % 64 != 0 {
        h.push(b' ');
    }
    h.push(b'\n');
    let mut out = b"\x93NUMPY\x01\x00".to_vec();
    out.extend_from_slice(&(h.len() as u16).to_le_bytes());
    out.extend_from_slice(&h);
    for &(a, b) in v {
        out.extend_from_slice(&a.to_le_bytes());
        out.extend_from_slice(&b.to_le_bytes());
    }
    std::fs::write(path, out)?;
    Ok(())
}

fn corr_rms(a: &[f64], b: &[f64]) -> (f64, f64) {
    let n = a.len() as f64;
    let ma = a.iter().sum::<f64>() / n;
    let mb = b.iter().sum::<f64>() / n;
    let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
    let rms = (a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - ma - y + mb).powi(2))
        .sum::<f64>()
        / n)
        .sqrt();
    (cov / (va * vb).sqrt(), rms)
}

/// Compare the non-rigid part (patch minus global) with the reference.
fn compare_patches(r: &Run, refdir: &Path) -> Res<()> {
    let ps = Npy::read(refdir.join("patch_shifts.npy"))?.into_f64();
    let idx: Vec<usize> = Npy::read(refdir.join("patch_idx.npy"))?
        .into_f64()
        .into_iter()
        .map(|v| v as usize)
        .collect();
    let refs = pairs(
        Npy::read(if refdir.join("shifts.npy").exists() {
            refdir.join("shifts.npy")
        } else {
            refdir.join("shifts_it2.npy")
        })?
        .into_f64(),
    );
    let centres: Vec<usize> = [0usize, 93, 187].iter().map(|o| 160 + o + 46).collect();
    let pts: Vec<(usize, usize)> = centres
        .iter()
        .flat_map(|&y| centres.iter().map(move |&x| (y, x)))
        .collect();
    let mine = at_points(r, &pts)?;
    let used: Vec<(usize, usize)> = idx
        .iter()
        .enumerate()
        .filter(|(_, &f)| f < r.records.len())
        .map(|(k, &f)| (k, f))
        .collect();
    if used.is_empty() {
        return Ok(());
    }
    // Non-rigid parts, per patch, with the per-patch temporal mean removed
    // (the templates differ, so static offsets are arbitrary).
    let mut a = vec![Vec::new(); 18];
    let mut b = vec![Vec::new(); 18];
    for &(k, f) in &used {
        let rec = &r.records[f];
        for p in 0..9 {
            for c in 0..2 {
                let rv = ps[(k * 9 + p) * 2 + c] - if c == 0 { refs[f].0 } else { refs[f].1 };
                let mv = if c == 0 {
                    mine[f][p].0 - rec.dy as f64
                } else {
                    mine[f][p].1 - rec.dx as f64
                };
                b[p * 2 + c].push(rv);
                a[p * 2 + c].push(mv);
            }
        }
    }
    let demean = |v: &mut Vec<f64>| {
        let m = v.iter().sum::<f64>() / v.len() as f64;
        v.iter_mut().for_each(|x| *x -= m);
    };
    a.iter_mut().for_each(demean);
    b.iter_mut().for_each(demean);
    let fa: Vec<f64> = a.concat();
    let fb: Vec<f64> = b.concat();
    let rms = |v: &[f64]| (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt();
    let diff: Vec<f64> = fa.iter().zip(&fb).map(|(x, y)| x - y).collect();
    let (c, _) = corr_rms(&fa, &fb);
    println!(
        "    patch non-rigid part vs reference ({} frames x 9 patches): ref RMS {:.4}, ours {:.4}, corr {c:.3}, RMS diff {:.4} px",
        used.len(),
        rms(&fb),
        rms(&fa),
        rms(&diff)
    );
    Ok(())
}

fn synthetic(dir: &Path) -> Res<()> {
    let src = AviFrames::open(dir)?;
    let (h, w) = (src.height, src.width);
    let px = h * w;
    let frames = src.first(100)?;
    let mut base = vec![0.0f32; px];
    for f in frames.chunks(px) {
        for (b, &v) in base.iter_mut().zip(f) {
            *b += v as f32 / 100.0;
        }
    }
    let mut mc = MotionCorrector::new(
        h,
        w,
        MotionConfig {
            template_tau: 0.0,
            // The synthetic field is independent from frame to frame, so
            // the temporal smoother and the shrinkage (which would read it
            // as noise) are off.
            nonrigid: Some(NonRigidConfig {
                temporal_alpha: 1.0,
                shrink: false,
                ..NonRigidConfig::default()
            }),
            ..MotionConfig::default()
        },
    )?;
    mc.initialize(Frames::F32(&base))?;
    let g = mc.geometry().ok_or("no geometry")?.clone();
    let mut warper: Warper = g.warper()?;
    let ng = g.node_ys.len() * g.node_xs.len();
    let mut state = 7u64;
    let mut rnd = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64 / (1u64 << 53) as f64 - 0.5) as f32
    };
    let (mut e_rigid, mut e_field, mut n) = (0.0f64, 0.0f64, 0.0f64);
    let mut moved = vec![0.0; px];
    let mut out = vec![0.0; px];
    for _ in 0..40 {
        let rig = (4.0 * rnd(), 4.0 * rnd());
        let res: Vec<f32> = (0..2 * ng).map(|_| rnd()).collect();
        warper.warp(&base, rig, &res, &mut moved, None)?;
        let rec = mc.process(Frame::F32(&moved), &mut out)?;
        // Expected record: the negation (to first order).
        e_rigid += ((rec.dy + rig.0).powi(2) + (rec.dx + rig.1).powi(2)) as f64 / 2.0;
        // Total shift at each node: rigid + residual.
        for k in 0..ng {
            let ey = rec.dy + rec.residual[2 * k] + rig.0 + res[2 * k];
            let ex = rec.dx + rec.residual[2 * k + 1] + rig.1 + res[2 * k + 1];
            e_field += ((ey * ey + ex * ex) / 2.0) as f64 / ng as f64;
        }
        n += 1.0;
    }
    println!(
        "  synthetic: rigid RMS error {:.4} px, total shift at the patch centres RMS error {:.4} px (applied residual RMS 0.29 px)",
        (e_rigid / n).sqrt(),
        (e_field / n).sqrt()
    );
    Ok(())
}

/// A movie stored as `movie.npy` (u8, `(frame, h, w)`) with `shifts.npy`.
fn npy_movie(dir: &Path) -> Res<()> {
    let m = Npy::read(dir.join("movie.npy"))?;
    let (n, h, w) = (m.shape[0], m.shape[1], m.shape[2]);
    let movie = m.into_u8()?;
    let shifts = pairs(Npy::read(dir.join("shifts.npy"))?.into_f64());
    let px = h * w;
    for (name, cfg) in [("rigid", config(false))] {
        let mut mc = MotionCorrector::new(h, w, cfg)?;
        mc.initialize(Frames::U8(&movie[..n.min(200) * px]))?;
        let mut out = vec![0.0; px];
        let mut est = Vec::new();
        for i in 0..n {
            let r = mc.process(Frame::U8(&movie[i * px..(i + 1) * px]), &mut out)?;
            est.push((r.dy as f64, r.dx as f64));
        }
        println!(
            "  [{name}] {n} frames {h}x{w}, roi {:?}: rigid RMSE {:.4} px",
            mc.geometry().map(|g| g.roi),
            shift_rmse_aligned(&est, &shifts)
        );
    }
    Ok(())
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: motion_eval minisim <daq_dir> <gt_dir> [frames] | real <avi_dir> <ref_dir> [frames] | synthetic <avi_dir>";
    let mode = args.get(1).ok_or(usage)?;
    let max = |i: usize| {
        args.get(i)
            .and_then(|v| v.parse().ok())
            .unwrap_or(usize::MAX)
    };
    match mode.as_str() {
        "minisim" => minisim(
            Path::new(args.get(2).ok_or(usage)?),
            Path::new(args.get(3).ok_or(usage)?),
            max(4),
        ),
        "real" => real(
            Path::new(args.get(2).ok_or(usage)?),
            Path::new(args.get(3).ok_or(usage)?),
            max(4),
        ),
        "synthetic" => synthetic(Path::new(args.get(2).ok_or(usage)?)),
        "npy" => npy_movie(Path::new(args.get(2).ok_or(usage)?)),
        _ => Err(usage.into()),
    }
}
