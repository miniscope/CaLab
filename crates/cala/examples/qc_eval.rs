//! Validate the online QC metrics ([`calab_cala::qc`]) against ground truth.
//!
//! ```text
//! cargo run --release --example qc_eval -- sim    <sim dir> <out dir> [options]
//! cargo run --release --example qc_eval -- oracle <sim dir> <out dir> [options]
//! cargo run --release --example qc_eval -- real   <avi dir> <out dir> [options]
//!   --frames N         first N frames (default all)
//!   --motion           run the motion corrector upstream
//!   --budget U         slow-loop work units per frame (default 3e7)
//!   --start N          frame at which the slow loop / oracle library starts (50)
//!   --every K          checkpoint every K frames (default 300)
//!   --perturb-frac F   oracle: share of cells perturbed (default 0.3)
//!   --seed S           oracle: perturbation seed
//!   --slow-seed S      slow-loop seed (held-out split, random slots)
//!   --dump             re-extract with the final library and write per-cell
//!                      trace, ring background and the footprint projection of
//!                      the frame before and after the background floor
//!   --batch B          forward frames to the slow loop in batches of B (the
//!                      app uses 8); library swaps land between batches (1)
//!   --slow-keep F      forward only a share F of the batches to the slow loop
//!                      (it observes and steps on those only), modelling the
//!                      app's drops when the slow worker is busy (1)
//!   --drop-mode M      `uniform`: evenly spaced batches; `score`: the batches
//!                      whose residual excursion score (`SlowLoop::tile_scores`,
//!                      summed over tiles above 4 σ) is in the top F of
//!                      recent batches go whenever capacity (a share F of
//!                      the batches, at most 4 banked) allows; quiet ones
//!                      only when capacity would otherwise go unused
//!   --frames-per-tile N / --reservoir-max-mb M   reservoir size target and cap
//!   --readd-window N / --churn-frames N   add classification windows
//!   --joint            add test with the joint neighbour-trace check
//!   --core-test M      transient-band core test: off (default) | report
//!                      (also writes fast.tsv, split.tsv) | trim | delete
//!   --basin-trim       trim refined footprints to their significant basin
//!   --drop-step        keep stepping the slow loop on dropped batches (only
//!                      the observation is lost, not the compute)
//!   --offered-fps R    model the app's workers on a virtual clock instead
//!                      (`Timed`): the fast loop reads R frames per second,
//!                      batches of `--batch` frames are dropped when the
//!                      `--pool` (2) forward buffers are busy, and work
//!                      costs time at `--units-per-ms` (WASM calibration)
//!   --visit-workers K  with --offered-fps: the slow worker only observes and
//!                      hands its tile visits to K workers (0: it observes
//!                      and steps itself, as the app did before)
//!   --via-jobs         run every tile visit as a job through the parallel
//!                      protocol, one at a time (`SlowLoop::step_via`): must
//!                      give the same results as without
//!   --observe-ms O     with --offered-fps: cost of observing one frame (the
//!                      app's measured time; default: its work units)
//!   --job-ms C         with K > 0: owner-side cost of a visit job, hand-out
//!                      and result together (encode, copy, decode), ms; a
//!                      worker also spends it on top of the visit's work
//!   --visit-depth D    visits a worker may hold at once (1)
//!   --no-heldout       skip the ground-truth-free held-out score
//!   --library F        a fixed library (`footprints.bin` of an earlier run,
//!                      `CALAFP01`) from `--start` on, no slow loop: scores
//!                      a given cell set (held-out frames: the split the
//!                      slow loop would use with `--slow-seed`)
//! ```
//!
//! **Held-out score** ([`calab_cala::qc::heldout`], on unless
//! `--no-heldout`): every frame the slow loop holds out is scored with the
//! library the fast loop used for it, against placebo columns (displaced
//! copies of a quarter of the cells). Checkpoint rows of `global.tsv` get
//! `ho_frames`, `ho_gain_per_frame`, `ho_cells`, `ho_placebos`, `ho_mu`,
//! `ho_penalty`, `ho_score` (S, per held-out frame, units of
//! s²) and `ho_penalty_ci` over the window since the previous checkpoint;
//! `ho_cells.tsv` holds per checkpoint and cell `ho_marginal`, `ho_frames`,
//! `ho_marginal_z` (also columns of `final.tsv`), `heldout.tsv` one row per
//! library version, and `cost.txt` the score's share of the wall time.
//!
//! * `sim`: the merged fast and slow loops on a minisim recording, from an
//!   empty library, with a [`QcMonitor`] on the fast loop. At every
//!   checkpoint each cell's QC metrics are written next to its ground-truth
//!   labels: matched to a detectable GT unit (footprint r ≥ 0.7, Hungarian),
//!   duplicate, the true trace r over the QC window, and the true crosstalk
//!   (least squares of the trace on its own GT trace and those of GT units
//!   within 20 px: neighbours' share of the trace variance, and the largest
//!   neighbour coefficient relative to its own).
//! * `oracle`: the fast loop alone with the GT footprints, a share of them
//!   deliberately wrong (shifted 3 px, merged with the nearest overlapping
//!   neighbour, split in two halves, or deleted so its neighbours absorb its
//!   light), to test the demixing metrics on known errors.
//! * `real`: no ground truth; QC time course and final per-cell metrics, plus
//!   `footprints.bin` for matching to another pipeline's cells.
//!
//! `cells.tsv` rows carry `fp_class` (`tp`, or the FP class: `noise`,
//! `adjacent`, `partial`, `dup`, `nondetectable` for a match to a GT unit
//! that is not detectable) and `edge_px` (distance of the centroid to the
//! sensor-mask edge, capped at 40).
//!
//! Outputs: `cells.tsv` (one row per cell per checkpoint), `global.tsv` (QC
//! every 100 frames, GT precision / recall / trace r at checkpoints, and the
//! slow loop's cumulative add classification), `adds.tsv` / `removals.tsv`
//! (every add with its class, every removal with its age; recording frames),
//! `final.tsv` (each cell of the final library: centroid, footprint match,
//! and the slow loop's evidence record) and, with GT, `gt.tsv` (GT units:
//! centroid, detectable, peak SNR) and `traces_gt.tsv` (each final cell's
//! best trace correlation with *any* GT unit and that unit's distance, which
//! tells a distant unit's light from signal no GT unit made), and, with
//! `--dump`, `dump_{trace,ring,pre,post}.f32` (frames x cells, final library
//! order) and `cells_pass2.tsv` (QC of the re-extracted traces).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::discover::{CoreTest, SlowLoop, SlowLoopConfig, VisitResult, VisitRunner};
use calab_cala::motion::{Frame, Frames, MotionConfig, MotionCorrector, NonRigidConfig};
use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor};
use calab_cala::qc::heldout::{HeldOutConfig, HeldOutScore, HeldOutWindow};
use calab_cala::qc::{CellQc, GlobalQc, QcConfig, QcMonitor};
use calab_cala::trace::{
    BackgroundModel, Footprint, FrameTraces, Library, LibraryBuilder, SolverConfig, TraceEngine,
};
use std::fmt::Write as _;

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

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1).cloned())
}

fn write_f32s(f: &mut impl Write, v: &[f32]) {
    for x in v {
        f.write_all(&x.to_le_bytes()).unwrap();
    }
}

/// Preprocessing (and optionally motion correction) of raw frames.
struct Pipeline {
    pre: Preprocessor,
    mc: Option<MotionCorrector>,
    buf: Vec<f32>,
}

impl Pipeline {
    fn new(
        rec: &mut Recording,
        pre: Preprocessor,
        cal: &Calibration,
        motion: bool,
        warm: u32,
    ) -> Pipeline {
        let dims = rec.dims;
        let n_px = dims.pixels();
        let mut pre = pre;
        let mc = if motion {
            let raw = rec.read(0, warm.min(rec.total));
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
            Some(mc)
        } else {
            None
        };
        Pipeline {
            pre,
            mc,
            buf: vec![0.0; n_px],
        }
    }

    fn frame(&mut self, raw: &[u8], out: &mut [f32]) {
        self.pre.front(raw, &mut self.buf).unwrap();
        match &mut self.mc {
            Some(mc) => {
                mc.process(Frame::F32(&self.buf), out).unwrap();
            }
            None => out.copy_from_slice(&self.buf),
        }
        self.pre.back(out).unwrap();
    }
}

/// A cell's filtered footprint as `(pixel, value)` pairs, shifted by `off`.
fn columns(lib: &Library, dims: Dims, off: (i32, i32)) -> Vec<Vec<(u32, f32)>> {
    (0..lib.len())
        .map(|s| {
            let (p, v) = lib.filtered(s);
            p.iter()
                .zip(v)
                .filter_map(|(&q, &a)| {
                    let (y, x) = (
                        (q as usize / dims.width) as i32 + off.0,
                        (q as usize % dims.width) as i32 + off.1,
                    );
                    (y >= 0 && x >= 0 && (y as usize) < dims.height && (x as usize) < dims.width)
                        .then(|| ((y as usize * dims.width + x as usize) as u32, a))
                })
                .collect()
        })
        .collect()
}

/// Pearson correlation of two sparse images over the union of their pixels.
fn sparse_corr(a: &[(u32, f32)], b: &[(u32, f32)], scratch: &mut [f32]) -> f64 {
    for &(p, v) in a {
        scratch[p as usize] = v;
    }
    let mut union: Vec<(f64, f64)> = a
        .iter()
        .map(|&(_, v)| (f64::from(v), 0.0))
        .collect::<Vec<_>>();
    let mut ia: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for (i, &(p, _)) in a.iter().enumerate() {
        ia.insert(p, i);
    }
    for &(p, v) in b {
        match ia.get(&p) {
            Some(&i) => union[i].1 = f64::from(v),
            None => union.push((0.0, f64::from(v))),
        }
    }
    for &(p, _) in a {
        scratch[p as usize] = 0.0;
    }
    let n = union.len() as f64;
    let ma = union.iter().map(|u| u.0).sum::<f64>() / n;
    let mb = union.iter().map(|u| u.1).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for &(x, y) in &union {
        sab += (x - ma) * (y - mb);
        saa += (x - ma) * (x - ma);
        sbb += (y - mb) * (y - mb);
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

fn centroid(col: &[(u32, f32)], width: usize) -> (f32, f32) {
    let (mut s, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
    for &(p, v) in col {
        if v > 0.0 {
            s += v;
            sy += v * (p as usize / width) as f32;
            sx += v * (p as usize % width) as f32;
        }
    }
    (sy / s.max(1e-12), sx / s.max(1e-12))
}

/// Minimum-cost assignment (rows <= cols), e-maxx Hungarian. Returns the
/// column of each row.
fn hungarian(cost: &[f64], n: usize, m: usize) -> Vec<usize> {
    assert!(n <= m);
    let inf = f64::INFINITY;
    let (mut u, mut v) = (vec![0.0; n + 1], vec![0.0; m + 1]);
    let (mut p, mut way) = (vec![0usize; m + 1], vec![0usize; m + 1]);
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![inf; m + 1];
        let mut used = vec![false; m + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = inf;
            let mut j1 = 0;
            for j in 1..=m {
                if !used[j] {
                    let cur = cost[(i0 - 1) * m + j - 1] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=m {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut out = vec![0usize; n];
    for j in 1..=m {
        if p[j] > 0 {
            out[p[j] - 1] = j - 1;
        }
    }
    out
}

const NO: f64 = 1e3;

type Matches = (Vec<Option<(usize, f64)>>, Vec<(usize, f64)>);

/// Match detected to GT footprints: Hungarian on 1 − r over pairs with
/// centres within 15 px and r ≥ `thr`. Returns per detected cell the GT
/// index and r, plus every detected cell's best r against any GT cell.
fn match_cells(det: &[Vec<(u32, f32)>], gt: &[Vec<(u32, f32)>], dims: Dims, thr: f64) -> Matches {
    let w = dims.width;
    let dc: Vec<(f32, f32)> = det.iter().map(|c| centroid(c, w)).collect();
    let gc: Vec<(f32, f32)> = gt.iter().map(|c| centroid(c, w)).collect();
    let mut scratch = vec![0.0f32; dims.pixels()];
    let mut pairs: Vec<Vec<(usize, f64)>> = vec![Vec::new(); det.len()];
    for (i, a) in det.iter().enumerate() {
        for (j, b) in gt.iter().enumerate() {
            let (dy, dx) = (dc[i].0 - gc[j].0, dc[i].1 - gc[j].1);
            if dy * dy + dx * dx <= 225.0 {
                pairs[i].push((j, sparse_corr(a, b, &mut scratch)));
            }
        }
    }
    let best: Vec<(usize, f64)> = pairs
        .iter()
        .map(|p| {
            p.iter()
                .copied()
                .fold((usize::MAX, -1.0), |b, x| if x.1 > b.1 { x } else { b })
        })
        .collect();
    let (n, m) = (det.len(), gt.len());
    let mut out = vec![None; n];
    if n == 0 || m == 0 {
        return (out, best);
    }
    // Rows must not outnumber columns: transpose when needed.
    let transpose = n > m;
    let (r, c) = if transpose { (m, n) } else { (n, m) };
    let mut cost = vec![NO; r * c];
    for (i, p) in pairs.iter().enumerate() {
        for &(j, v) in p {
            if v >= thr {
                let (ri, ci) = if transpose { (j, i) } else { (i, j) };
                cost[ri * c + ci] = 1.0 - v;
            }
        }
    }
    let asg = hungarian(&cost, r, c);
    for (ri, &ci) in asg.iter().enumerate() {
        if cost[ri * c + ci] < NO {
            let (i, j) = if transpose { (ci, ri) } else { (ri, ci) };
            out[i] = Some((j, 1.0 - cost[ri * c + ci]));
        }
    }
    (out, best)
}

/// Integer shift (dy, dx) of the detected footprints onto the GT ones that
/// maximises the overlap of their summed images (motion runs register to the
/// warm-up template, not to the simulator's canvas).
fn best_offset(det: &Library, gt: &Library, dims: Dims, max: i32) -> (i32, i32) {
    let img = |lib: &Library| {
        let mut m = vec![0.0f32; dims.pixels()];
        for s in 0..lib.len() {
            let (p, v) = lib.filtered(s);
            for (&q, &a) in p.iter().zip(v) {
                m[q as usize] += a.max(0.0);
            }
        }
        m
    };
    let (a, b) = (img(det), img(gt));
    let (w, h) = (dims.width as i32, dims.height as i32);
    let mut best = ((0, 0), f64::MIN);
    for dy in -max..=max {
        for dx in -max..=max {
            let mut s = 0.0f64;
            for y in max..h - max {
                for x in max..w - max {
                    s += f64::from(a[(y * w + x) as usize])
                        * f64::from(b[((y + dy) * w + x + dx) as usize]);
                }
            }
            if s > best.1 {
                best = ((dy, dx), s);
            }
        }
    }
    best.0
}

impl Pipeline {
    /// Like `frame`, also returning the registered frame before the floor.
    fn frame_split(&mut self, raw: &[u8], pre: &mut [f32], out: &mut [f32]) {
        self.pre.front(raw, &mut self.buf).unwrap();
        match &mut self.mc {
            Some(mc) => {
                mc.process(Frame::F32(&self.buf), pre).unwrap();
            }
            None => pre.copy_from_slice(&self.buf),
        }
        out.copy_from_slice(pre);
        self.pre.back(out).unwrap();
    }
}

/// Trace history of every cell id seen: (first frame, values).
#[derive(Default)]
struct History {
    map: HashMap<u64, (usize, Vec<f32>)>,
}

impl History {
    fn push(&mut self, t: usize, ids: &[u64], traces: &[f32]) {
        for (&id, &c) in ids.iter().zip(traces) {
            let e = self.map.entry(id).or_insert((t, Vec::new()));
            e.1.push(c);
        }
    }

    /// The last `len` values of `id` ending at frame `t_end` (exclusive).
    fn window(&self, id: u64, len: usize, t_end: usize) -> Option<(usize, &[f32])> {
        let (start, v) = self.map.get(&id)?;
        let end = start + v.len();
        if end != t_end || len > v.len() {
            return None;
        }
        Some((t_end - len, &v[v.len() - len..]))
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Least squares of `y` on centred columns (with intercept); coefficients.
fn lstsq(cols: &[&[f32]], y: &[f32]) -> Option<Vec<f64>> {
    let k = cols.len();
    let n = y.len();
    let mean = |v: &[f32]| v.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
    let mc: Vec<f64> = cols.iter().map(|c| mean(c)).collect();
    let my = mean(y);
    let mut a = vec![0.0f64; k * k];
    let mut b = vec![0.0f64; k];
    for t in 0..n {
        let yt = f64::from(y[t]) - my;
        for i in 0..k {
            let xi = f64::from(cols[i][t]) - mc[i];
            b[i] += xi * yt;
            for j in i..k {
                a[i * k + j] += xi * (f64::from(cols[j][t]) - mc[j]);
            }
        }
    }
    for i in 0..k {
        for j in 0..i {
            a[i * k + j] = a[j * k + i];
        }
        a[i * k + i] *= 1.0 + 1e-9;
    }
    // Gaussian elimination with partial pivoting.
    let mut m = a;
    let mut x = b;
    for c in 0..k {
        let p = (c..k).max_by(|&r, &s| m[r * k + c].abs().total_cmp(&m[s * k + c].abs()))?;
        if m[p * k + c].abs() < 1e-12 {
            return None;
        }
        for j in 0..k {
            m.swap(p * k + j, c * k + j);
        }
        x.swap(p, c);
        for r in (c + 1)..k {
            let f = m[r * k + c] / m[c * k + c];
            for j in c..k {
                m[r * k + j] -= f * m[c * k + j];
            }
            x[r] -= f * x[c];
        }
    }
    for c in (0..k).rev() {
        let mut s = x[c];
        for j in (c + 1)..k {
            s -= m[c * k + j] * x[j];
        }
        x[c] = s / m[c * k + c];
    }
    Some(x)
}

fn sd(v: &[f32]) -> f64 {
    let n = v.len() as f64;
    let m = v.iter().map(|&x| f64::from(x)).sum::<f64>() / n;
    (v.iter().map(|&x| (f64::from(x) - m).powi(2)).sum::<f64>() / n).sqrt()
}

/// True crosstalk of a trace: regress it on its own GT trace and the GT
/// traces of `nbs`. Returns (neighbours' variance share, largest neighbour
/// coefficient x sd relative to own, largest |r| with a neighbour's GT trace).
fn crosstalk(trace: &[f32], own: &[f32], nbs: &[&[f32]]) -> (f64, f64, f64) {
    let r_nb = nbs
        .iter()
        .map(|c| pearson(trace, c))
        .fold(
            f64::NAN,
            |a: f64, b| if a.is_nan() || b > a { b } else { a },
        );
    if nbs.is_empty() {
        return (0.0, 0.0, f64::NAN);
    }
    let mut cols: Vec<&[f32]> = vec![own];
    cols.extend_from_slice(nbs);
    // Drop constant columns (silent neighbours in the window).
    let keep: Vec<usize> = (0..cols.len()).filter(|&i| sd(cols[i]) > 0.0).collect();
    if keep.first() != Some(&0) || keep.len() < 2 {
        return (0.0, 0.0, r_nb);
    }
    let cols: Vec<&[f32]> = keep.iter().map(|&i| cols[i]).collect();
    let Some(b) = lstsq(&cols, trace) else {
        return (f64::NAN, f64::NAN, r_nb);
    };
    let n = trace.len();
    let means: Vec<f64> = cols
        .iter()
        .map(|c| c.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64)
        .collect();
    let mut leak = vec![0.0f64; n];
    for (i, c) in cols.iter().enumerate().skip(1) {
        for t in 0..n {
            leak[t] += b[i] * (f64::from(c[t]) - means[i]);
        }
    }
    let var_leak = leak.iter().map(|v| v * v).sum::<f64>() / n as f64;
    let var_tr = sd(trace).powi(2);
    let own_amp = (b[0] * sd(cols[0])).abs();
    let max_rel = (1..cols.len())
        .map(|i| (b[i] * sd(cols[i])).abs() / own_amp.max(1e-12))
        .fold(0.0f64, f64::max);
    (var_leak / var_tr.max(1e-12), max_rel, r_nb)
}

struct Gt {
    kept: Vec<usize>,
    cols: Vec<Vec<(u32, f32)>>,
    centers: Vec<(f32, f32)>,
    detectable: Vec<bool>,
    snr: Vec<f64>,
    t_gt: usize,
    /// Distance in px from each pixel to the nearest masked-out pixel (or
    /// the image border), capped at [`EDGE_CAP`].
    edge: Vec<f32>,
}

/// Cap of the edge-distance map (px).
const EDGE_CAP: f32 = 40.0;

/// Distance from every pixel to the nearest pixel outside the sensor mask
/// (the image border counts as outside), capped at [`EDGE_CAP`]. Two-pass
/// chamfer (3-4) transform: within a few percent of the Euclidean distance,
/// which is plenty against a 10 px threshold.
fn edge_distance(fov: &[u8], dims: Dims) -> Vec<f32> {
    let (h, w) = (dims.height as i32, dims.width as i32);
    let at = |d: &Vec<f32>, y: i32, x: i32| -> f32 {
        if y < 0 || x < 0 || y >= h || x >= w {
            0.0
        } else {
            d[(y * w + x) as usize]
        }
    };
    let mut d: Vec<f32> = fov
        .iter()
        .map(|&m| if m != 0 { EDGE_CAP + 10.0 } else { 0.0 })
        .collect();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let v = d[i]
                .min(at(&d, y - 1, x) + 1.0)
                .min(at(&d, y, x - 1) + 1.0)
                .min(at(&d, y - 1, x - 1) + std::f32::consts::SQRT_2)
                .min(at(&d, y - 1, x + 1) + std::f32::consts::SQRT_2);
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = (y * w + x) as usize;
            let v = d[i]
                .min(at(&d, y + 1, x) + 1.0)
                .min(at(&d, y, x + 1) + 1.0)
                .min(at(&d, y + 1, x + 1) + std::f32::consts::SQRT_2)
                .min(at(&d, y + 1, x - 1) + std::f32::consts::SQRT_2);
            d[i] = v;
        }
    }
    for v in &mut d {
        *v = v.min(EDGE_CAP);
    }
    d
}

impl Gt {
    fn c<'a>(&self, o: &'a Oracle, j: usize) -> &'a [f32] {
        let u = self.kept[j];
        &o.c[u * self.t_gt..(u + 1) * self.t_gt]
    }

    /// GT units (other than `j`) within `d` px of `p`.
    fn near(&self, p: (f32, f32), d: f32, skip: &[usize]) -> Vec<usize> {
        let mut v: Vec<(f32, usize)> = self
            .centers
            .iter()
            .enumerate()
            .filter(|(k, _)| !skip.contains(k))
            .map(|(k, c)| ((c.0 - p.0).powi(2) + (c.1 - p.1).powi(2), k))
            .filter(|e| e.0 <= d * d)
            .collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.into_iter().take(8).map(|e| e.1).collect()
    }
}

fn build_gt(
    o: &Oracle,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    flat: &mut GlowFlattener,
) -> (Gt, Library) {
    let mut b = LibraryBuilder::new(dims).fov(fov.to_vec());
    let mut kept = Vec::new();
    for (u, un) in o.units.iter().enumerate() {
        let (cy, cx) = (un.center.0.round(), un.center.1.round());
        let inside = cy >= 0.0
            && cx >= 0.0
            && (cy as usize) < dims.height
            && (cx as usize) < dims.width
            && fov[cy as usize * dims.width + cx as usize] != 0;
        if inside && un.full.values.iter().any(|&v| v > 0.0) {
            b.push(un.full.clone());
            kept.push(u);
        }
    }
    let lib = b.build(flat).unwrap();
    let cols = columns(&lib, dims, (0, 0));
    let centers = cols.iter().map(|c| centroid(c, dims.width)).collect();
    let snr = (0..kept.len())
        .map(|j| {
            let c = &o.c[kept[j] * o.n_frames..(kept[j] + 1) * o.n_frames];
            let mut s: Vec<f32> = c.to_vec();
            s.sort_by(f32::total_cmp);
            let amp = s[s.len() - 1] - s[s.len() / 2];
            let (p, v) = lib.filtered(j);
            let (k, peak) =
                v.iter()
                    .enumerate()
                    .fold((0, f32::MIN), |b, (i, &x)| if x > b.1 { (i, x) } else { b });
            f64::from(amp * peak / noise[p[k] as usize].max(1e-6))
        })
        .collect();
    let detectable = kept.iter().map(|&u| o.units[u].detectable).collect();
    (
        Gt {
            kept,
            cols,
            centers,
            detectable,
            snr,
            t_gt: o.n_frames,
            edge: edge_distance(fov, dims),
        },
        lib,
    )
}

const LABELS: &str =
    "frame\tslot\tmatched\ttp\tdup\tfp_r\tgt\tgt_snr\ttrue_r\ttrue_r_any\txt_var\txt_rel\txt_r\tperturb\tfp_class\tedge_px";

/// Per-cell labels of `lib`'s cells at frame `t_end`. `own` maps a cell to
/// its GT units when known (oracle); otherwise footprints are matched.
#[allow(clippy::too_many_arguments)]
fn label_rows(
    t_end: usize,
    lib: &Library,
    qc: &QcMonitor,
    hist: &History,
    gt: &Gt,
    o: &Oracle,
    dims: Dims,
    own: Option<&HashMap<u64, (Vec<usize>, u32)>>,
    out: &mut String,
    summary: &mut Vec<f64>,
) {
    let det = columns(lib, dims, (0, 0));
    let (mt, best) = match own {
        Some(_) => (vec![None; det.len()], vec![(usize::MAX, 0.0); det.len()]),
        None => match_cells(&det, &gt.cols, dims, 0.7),
    };
    let mut gt_hit = vec![false; gt.kept.len()];
    for m in mt.iter().flatten() {
        gt_hit[m.0] = true;
    }
    let (mut tp_n, mut r_tp) = (0usize, Vec::new());
    for (s, q) in qc.cells().enumerate() {
        let id = lib.ids()[s];
        let row = q.to_row();
        let len = q.frames as usize;
        let (units, perturb): (Vec<usize>, u32) = match own {
            Some(m) => m.get(&id).cloned().unwrap_or((Vec::new(), 0)),
            None => (mt[s].map(|m| vec![m.0]).unwrap_or_default(), 0),
        };
        let matched = !units.is_empty();
        let tp = matched && units.iter().any(|&j| gt.detectable[j]);
        if tp {
            tp_n += 1;
        }
        let dup = !matched && best[s].0 != usize::MAX && best[s].1 >= 0.5 && gt_hit[best[s].0];
        let fp_r = mt[s].map_or(best[s].1, |m| m.1);
        let ctr0 = centroid(&det[s], dims.width);
        let fp_class = if tp {
            "tp"
        } else if matched {
            // Matched only non-detectable GT units: not a real error of the
            // pipeline, reported apart from the other FP classes.
            "nondetectable"
        } else if dup {
            "dup"
        } else if best[s].0 != usize::MAX && best[s].1 >= 0.5 {
            "partial"
        } else if !gt.near(ctr0, 10.0, &[]).is_empty() {
            "adjacent"
        } else {
            "noise"
        };
        let edge_px = {
            let (cy, cx) = (
                (ctr0.0.round() as i64).clamp(0, dims.height as i64 - 1) as usize,
                (ctr0.1.round() as i64).clamp(0, dims.width as i64 - 1) as usize,
            );
            gt.edge[cy * dims.width + cx]
        };
        let mut vals = [f64::NAN; 8];
        if len >= qc.config().min_frames {
            if let Some((t0, w)) = hist.window(id, len, t_end) {
                let ctr = centroid(&det[s], dims.width);
                if matched {
                    // Own unit: the best-correlated of the cell's units.
                    let (j, r) = units
                        .iter()
                        .map(|&j| (j, pearson(w, &gt.c(o, j)[t0..t_end])))
                        .fold((usize::MAX, f64::NAN), |b, x| {
                            if b.1.is_nan() || x.1 > b.1 {
                                x
                            } else {
                                b
                            }
                        });
                    vals[0] = j as f64;
                    vals[1] = gt.snr[j];
                    vals[2] = r;
                    if tp && r.is_finite() {
                        r_tp.push(r);
                    }
                    let nbs: Vec<&[f32]> = gt
                        .near(gt.centers[j], 20.0, &units)
                        .into_iter()
                        .map(|k| &gt.c(o, k)[t0..t_end])
                        .collect();
                    let (xv, xr, xn) = crosstalk(w, &gt.c(o, j)[t0..t_end], &nbs);
                    vals[4] = xv;
                    vals[5] = xr;
                    vals[6] = xn;
                }
                vals[3] = gt
                    .near(ctr, 15.0, &[])
                    .into_iter()
                    .map(|k| pearson(w, &gt.c(o, k)[t0..t_end]))
                    .fold(
                        f64::NAN,
                        |a: f64, b| if a.is_nan() || b > a { b } else { a },
                    );
            }
        }
        let _ = write!(
            out,
            "{t_end}\t{s}\t{}\t{}\t{}\t{:.4}\t{}\t{:.3}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{perturb}\t{fp_class}\t{edge_px:.1}",
            u8::from(matched),
            u8::from(tp),
            u8::from(dup),
            fp_r,
            if vals[0].is_nan() { -1 } else { vals[0] as i64 },
            vals[1],
            vals[2],
            vals[3],
            vals[4],
            vals[5],
            vals[6],
        );
        for v in row {
            let _ = write!(out, "\t{v:.5}");
        }
        out.push('\n');
    }
    let det_total = gt.detectable.iter().filter(|&&d| d).count();
    summary.clear();
    summary.push(tp_n as f64 / lib.len().max(1) as f64);
    summary.push(tp_n as f64 / det_total.max(1) as f64);
    summary.push(quantile(&r_tp, 0.5));
}

/// The oracle library: GT footprints of detectable units, a share perturbed.
/// Returns the library and, per id, its GT units and perturbation code
/// (0 none, 1 shifted, 2 merged, 3 split half, 4 neighbour of a deleted unit).
#[allow(clippy::too_many_arguments)]
fn oracle_library(
    o: &Oracle,
    gt: &Gt,
    dims: Dims,
    fov: &[u8],
    noise: &[f32],
    flat: &mut GlowFlattener,
    frac: f64,
    seed: u64,
) -> (Library, HashMap<u64, (Vec<usize>, u32)>) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let n = gt.kept.len();
    let mut code = vec![0u32; n];
    let mut partner = vec![usize::MAX; n];
    let mut gone = vec![false; n];
    let fp = |j: usize| o.units[gt.kept[j]].full.clone();
    for j in 0..n {
        if !gt.detectable[j] || code[j] != 0 || gone[j] || rng.unit() >= frac {
            continue;
        }
        let kind = 1 + (rng.next() % 4) as u32;
        // Nearest overlapping (≤ 12 px) unperturbed detectable neighbour.
        let nb = gt
            .near(gt.centers[j], 12.0, &[j])
            .into_iter()
            .find(|&k| gt.detectable[k] && code[k] == 0 && !gone[k]);
        match kind {
            2 | 4 if nb.is_none() => continue,
            2 => {
                let k = nb.unwrap();
                code[j] = 2;
                code[k] = 2;
                partner[j] = k;
                partner[k] = j;
            }
            4 => {
                gone[j] = true;
                for k in gt.near(gt.centers[j], 12.0, &[j]) {
                    if code[k] == 0 && !gone[k] {
                        code[k] = 4;
                    }
                }
            }
            k => code[j] = k,
        }
    }
    let mut b = LibraryBuilder::new(dims)
        .fov(fov.to_vec())
        .noise(noise.to_vec())
        .background(BackgroundModel::Ring {
            inner_px: 12.0,
            outer_px: 20.0,
        });
    let mut own: HashMap<u64, (Vec<usize>, u32)> = HashMap::new();
    for j in 0..n {
        if !gt.detectable[j] || gone[j] {
            continue;
        }
        let f = fp(j);
        match code[j] {
            1 => {
                let a = rng.unit() * std::f64::consts::TAU;
                let (dy, dx) = (
                    (3.0 * a.sin()).round() as i64,
                    (3.0 * a.cos()).round() as i64,
                );
                let y0 = (f.y0 as i64 + dy).clamp(0, (dims.height - f.height) as i64) as usize;
                let x0 = (f.x0 as i64 + dx).clamp(0, (dims.width - f.width) as i64) as usize;
                b.push(Footprint {
                    id: j as u64,
                    y0,
                    x0,
                    ..f
                });
                own.insert(j as u64, (vec![j], 1));
            }
            2 => {
                let k = partner[j];
                if k < j {
                    continue;
                }
                let g = fp(k);
                let y0 = f.y0.min(g.y0);
                let x0 = f.x0.min(g.x0);
                let y1 = (f.y0 + f.height).max(g.y0 + g.height);
                let x1 = (f.x0 + f.width).max(g.x0 + g.width);
                let (h, w) = (y1 - y0, x1 - x0);
                let mut v = vec![0.0f32; h * w];
                for p in [&f, &g] {
                    let pk = p.values.iter().copied().fold(0.0f32, f32::max);
                    for yy in 0..p.height {
                        for xx in 0..p.width {
                            v[(p.y0 + yy - y0) * w + p.x0 + xx - x0] +=
                                p.values[yy * p.width + xx] / pk;
                        }
                    }
                }
                let id = 100_000 + j as u64;
                b.push(Footprint {
                    id,
                    y0,
                    x0,
                    height: h,
                    width: w,
                    values: v,
                });
                own.insert(id, (vec![j, k], 2));
            }
            3 => {
                let a = rng.unit() * std::f64::consts::PI;
                let (sa, ca) = (a.sin() as f32, a.cos() as f32);
                let (mut sw, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
                for yy in 0..f.height {
                    for xx in 0..f.width {
                        let v = f.values[yy * f.width + xx];
                        sw += v;
                        sy += v * yy as f32;
                        sx += v * xx as f32;
                    }
                }
                let (cy, cx) = (sy / sw, sx / sw);
                for half in 0..2u64 {
                    let mut v = f.values.clone();
                    for yy in 0..f.height {
                        for xx in 0..f.width {
                            let side = (yy as f32 - cy) * sa + (xx as f32 - cx) * ca >= 0.0;
                            if side != (half == 0) {
                                v[yy * f.width + xx] = 0.0;
                            }
                        }
                    }
                    if v.iter().all(|&x| x <= 0.0) {
                        continue;
                    }
                    let id = 200_000 + 2 * j as u64 + half;
                    b.push(Footprint {
                        id,
                        values: v,
                        ..f.clone()
                    });
                    own.insert(id, (vec![j], 3));
                }
            }
            c => {
                b.push(Footprint { id: j as u64, ..f });
                own.insert(j as u64, (vec![j], c));
            }
        }
    }
    (b.build(flat).unwrap(), own)
}

fn qc_header() -> String {
    let mut h = String::from(LABELS);
    for f in CellQc::FIELDS {
        h.push('\t');
        h.push_str(f);
    }
    h.push('\n');
    h
}

fn global_line(g: &GlobalQc, extra: &[f64]) -> String {
    let mut s = String::new();
    for v in g.to_row(0).iter().take(GlobalQc::FIELDS.len() - 1) {
        let _ = write!(s, "{v:.5}\t");
    }
    for v in extra {
        let _ = write!(s, "{v:.4}\t");
    }
    s.pop();
    s.push('\n');
    s
}

/// A batch forwarded to the slow loop: frames with their traces, library
/// and recording frame, and a new noise map when one was due.
type Batch = (
    Vec<(Vec<f32>, FrameTraces, Arc<Library>, usize)>,
    Option<Vec<f32>>,
);

enum Msg {
    Batch(Batch),
    /// A visit result and the worker it came from.
    Result(Box<VisitResult>, usize),
}

/// The app's slow-loop workers on a virtual clock (`--offered-fps`).
///
/// The fast loop reads `fps` frames per second of wall time and offers the
/// slow loop a batch of frames whenever one is full. A batch is forwarded
/// when one of `pool` buffers is free (a buffer is busy from forwarding
/// until the owner has handled the batch) and dropped otherwise, as in
/// `ForwardPool`. The owner (the slow worker) handles its messages one at
/// a time in arrival order: a batch costs its work (observe, and with no
/// visit workers `step(budget)` per frame, as the app's single slow worker
/// does); a visit result costs applying it. With `k` visit workers the owner
/// hands out a tile visit to every idle worker after each message
/// (`SlowLoop::take_job`); a visit costs its work on the worker, and each
/// hand-out and result costs `job_ms` on the owner (encode, copy, decode).
/// Work converts to time at `units_per_ms` (calibrated on the app's WASM
/// build). Visits are computed at hand-out (they are pure functions of the
/// job) and applied when their virtual time is up, so the run is
/// deterministic.
struct Timed {
    fps: f64,
    units_per_ms: f64,
    observe_ms: Option<f64>,
    job_ms: f64,
    pool: usize,
    budget: u64,
    inbox: std::collections::VecDeque<(f64, Msg)>,
    owner_free: f64,
    /// Release time of each forwarded buffer (infinite until handled).
    bufs: Vec<f64>,
    /// Each visit worker, when it is free, and its visits not yet applied.
    runners: Vec<(VisitRunner, f64, usize)>,
    /// Visits handed to a worker before its last one has come back.
    depth: usize,
    libs: std::collections::VecDeque<(f64, Arc<Library>)>,
    pub forwarded: u64,
    pub dropped: u64,
    pub jobs: u64,
    pub owner_busy: f64,
    pub runner_busy: f64,
    pub last_ms: f64,
    /// The recording ended: no more hand-outs.
    pub ending: bool,
}

impl Timed {
    #[allow(clippy::too_many_arguments)]
    fn new(
        fps: f64,
        units_per_ms: f64,
        observe_ms: Option<f64>,
        job_ms: f64,
        pool: usize,
        budget: u64,
        runners: Vec<VisitRunner>,
        depth: usize,
    ) -> Timed {
        Timed {
            fps,
            units_per_ms,
            observe_ms,
            job_ms,
            pool,
            budget,
            inbox: Default::default(),
            owner_free: 0.0,
            bufs: Vec::new(),
            runners: runners.into_iter().map(|r| (r, 0.0, 0)).collect(),
            depth: depth.max(1),
            libs: Default::default(),
            forwarded: 0,
            dropped: 0,
            jobs: 0,
            owner_busy: 0.0,
            runner_busy: 0.0,
            last_ms: 0.0,
            ending: false,
        }
    }

    /// Wall time (ms) at which frame `t` has been read.
    fn at(&self, t: usize) -> f64 {
        t as f64 * 1e3 / self.fps
    }

    /// A forward buffer is free at `now`.
    fn has_buffer(&mut self, now: f64) -> bool {
        self.bufs.retain(|&r| r > now);
        self.bufs.len() < self.pool
    }

    /// Forward a full batch at `now` (after `has_buffer`).
    fn forward(&mut self, now: f64, batch: Batch) {
        self.bufs.push(f64::INFINITY);
        self.forwarded += batch.0.len() as u64;
        self.push(now, Msg::Batch(batch));
    }

    fn push(&mut self, at: f64, m: Msg) {
        let i = self.inbox.partition_point(|(a, _)| *a <= at);
        self.inbox.insert(i, (at, m));
    }

    /// Handle every message the owner starts by `until` (all of them with
    /// `f64::INFINITY`). `log` gets each handled batch's frames (recording
    /// frame of each slow-loop frame).
    fn advance(&mut self, until: f64, sl: &mut SlowLoop, slow_rec: &mut Vec<u32>) {
        while let Some(&(arr, _)) = self.inbox.front() {
            let start = arr.max(self.owner_free);
            if start > until {
                break;
            }
            let (_, msg) = self.inbox.pop_front().unwrap();
            let w0 = sl.work();
            let mut extra = 0.0;
            let mut lib = None;
            let is_batch = matches!(msg, Msg::Batch(_));
            match msg {
                Msg::Batch((frames, noise)) => {
                    if let Some(n) = noise {
                        sl.set_noise(n.clone()).unwrap();
                        for (r, ..) in &mut self.runners {
                            r.set_noise(n.clone()).unwrap();
                        }
                    }
                    for (y, tr, l, tf) in &frames {
                        let o = sl.work();
                        sl.observe(y, l, tr).unwrap();
                        if let Some(ms) = self.observe_ms {
                            extra += ms - (sl.work() - o) as f64 / self.units_per_ms;
                        }
                        slow_rec.push(*tf as u32);
                        if self.runners.is_empty() {
                            if let Some(l) = sl.step(self.budget).unwrap() {
                                lib = Some(l);
                            }
                        }
                    }
                }
                Msg::Result(r, i) => {
                    // The visit's work was done by its worker; `apply_job`
                    // adds it to the loop's total.
                    extra -= r.work() as f64 / self.units_per_ms;
                    sl.apply_job(*r).unwrap();
                    // Half the owner's cost of a job is the hand-out.
                    extra += 0.5 * self.job_ms;
                    self.runners[i].2 -= 1;
                }
            }
            if !self.runners.is_empty() {
                if let Some(l) = sl.housekeep().unwrap() {
                    lib = Some(l);
                }
            }
            let mut end = start + (sl.work() - w0) as f64 / self.units_per_ms + extra;
            if is_batch {
                // The batch's buffer goes back now.
                if let Some(b) = self.bufs.iter_mut().find(|b| b.is_infinite()) {
                    *b = end;
                }
            }
            if let Some(l) = lib {
                self.libs.push_back((end, l));
            }
            // Hand out visits to workers with fewer than `depth` out (as
            // `SlowRunner.dispatch`; a worker runs its visits in turn).
            'hand: for _ in 0..self.depth {
                for i in 0..self.runners.len() {
                    if self.ending || self.runners[i].2 >= self.depth {
                        continue;
                    }
                    let Some(job) = sl.take_job() else {
                        break 'hand;
                    };
                    end += 0.5 * self.job_ms;
                    let res = self.runners[i].0.run(job).unwrap();
                    let dur = res.work() as f64 / self.units_per_ms + self.job_ms;
                    self.runner_busy += dur;
                    self.jobs += 1;
                    let done = end.max(self.runners[i].1) + dur;
                    self.runners[i].1 = done;
                    self.runners[i].2 += 1;
                    self.push(done, Msg::Result(Box::new(res), i));
                }
            }
            self.owner_busy += end - start;
            self.owner_free = end;
            self.last_ms = self.last_ms.max(end);
        }
    }

    /// The newest library published by `now`.
    fn library(&mut self, now: f64) -> Option<Arc<Library>> {
        let mut out = None;
        while self.libs.front().is_some_and(|l| l.0 <= now) {
            out = self.libs.pop_front().map(|l| l.1);
        }
        out
    }
}

/// Move the slow loop's add and removal logs into the TSV buffers.
fn write_logs(
    sl: &mut SlowLoop,
    rf: &dyn Fn(u64) -> u32,
    add_log: &mut String,
    rem_log: &mut String,
) {
    for a in sl.take_add_log() {
        let _ = writeln!(
            add_log,
            "{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{:.4}\t{:.2}\t{}",
            a.frame,
            rf(a.frame),
            a.id,
            a.class.as_str(),
            a.center.0,
            a.center.1,
            a.cos,
            a.dist,
            a.since as i64
        );
    }
    for r in sl.take_removal_log() {
        let _ = writeln!(
            rem_log,
            "{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{}\t{}\t{}\t{}",
            r.frame,
            rf(r.frame),
            r.id,
            r.kind.as_str(),
            r.center.0,
            r.center.1,
            r.born,
            rf(r.born),
            r.class.map_or("none", |c| c.as_str()),
            u8::from(r.churned)
        );
    }
}

/// A fixed library from a `footprints.bin` (`CALAFP01`: height, width, n;
/// per cell id, pixel count, pixels, unfiltered values, filtered values),
/// built with this run's filter, noise map and background.
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
    assert_eq!(
        &magic,
        b"CALAFP01",
        "{}: not a footprints.bin",
        path.display()
    );
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).expect("mode: sim | oracle | real").clone();
    let input = PathBuf::from(args.get(2).expect("input dir"));
    let out_dir = PathBuf::from(args.get(3).expect("out dir"));
    std::fs::create_dir_all(&out_dir).unwrap();
    let has_gt = mode == "sim" || mode == "oracle";
    let oracle_mode = mode == "oracle";
    let motion = args.iter().any(|a| a == "--motion");
    let dump = args.iter().any(|a| a == "--dump");
    let budget: u64 = arg_value(&args, "--budget").map_or(30_000_000, |s| s.parse().unwrap());
    let start: usize = arg_value(&args, "--start").map_or(50, |s| s.parse().unwrap());
    let every: usize = arg_value(&args, "--every").map_or(300, |s| s.parse().unwrap());
    let frac: f64 = arg_value(&args, "--perturb-frac").map_or(0.3, |s| s.parse().unwrap());
    let seed: u64 = arg_value(&args, "--seed").map_or(1, |s| s.parse().unwrap());
    let batch_n: usize = arg_value(&args, "--batch").map_or(1, |s| s.parse().unwrap());
    let keep: f64 = arg_value(&args, "--slow-keep").map_or(1.0, |s| s.parse().unwrap());
    let score_mode = arg_value(&args, "--drop-mode").is_some_and(|m| m == "score");
    let drop_step = args.iter().any(|a| a == "--drop-step");
    let via_jobs = args.iter().any(|a| a == "--via-jobs");
    let offered_fps: Option<f64> = arg_value(&args, "--offered-fps").map(|s| s.parse().unwrap());
    let visit_workers: usize =
        arg_value(&args, "--visit-workers").map_or(0, |s| s.parse().unwrap());
    let units_per_ms: f64 =
        arg_value(&args, "--units-per-ms").map_or(2.0e6, |s| s.parse().unwrap());
    let observe_ms: Option<f64> = arg_value(&args, "--observe-ms").map(|s| s.parse().unwrap());
    let depth: usize = arg_value(&args, "--visit-depth").map_or(1, |s| s.parse().unwrap());
    let job_ms: f64 = arg_value(&args, "--job-ms").map_or(1.0, |s| s.parse().unwrap());
    let pool: usize = arg_value(&args, "--pool").map_or(2, |s| s.parse().unwrap());
    let heldout_on = !args.iter().any(|a| a == "--no-heldout");
    let fixed_lib: Option<PathBuf> = arg_value(&args, "--library").map(PathBuf::from);
    assert!(
        fixed_lib.is_none() || !oracle_mode,
        "--library and oracle mode both set the library"
    );
    assert!(batch_n >= 1 && keep > 0.0 && keep <= 1.0);

    let avi_dir = if has_gt {
        input.join("daq/Miniscope")
    } else {
        input.clone()
    };
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let n_px = dims.pixels();
    let oracle = has_gt.then(|| read_oracle(&input.join("oracle.bin")));
    let mut frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    if let Some(o) = &oracle {
        frames = frames.min(o.n_frames as u32);
    }
    let t_len = frames as usize;
    let cfg = PreprocessConfig::for_fps(20.0);
    let mut scfg = SlowLoopConfig {
        cell_diameter_px: cfg.flatten.cell_diameter_px,
        ..SlowLoopConfig::default()
    };
    if let Some(v) = arg_value(&args, "--slow-seed") {
        scfg.seed = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--accept-z") {
        scfg.accept_z = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--core-test") {
        scfg.core_test = match v.as_str() {
            "off" => CoreTest::Off,
            "report" => CoreTest::Report,
            "trim" => CoreTest::Trim,
            "delete" => CoreTest::Delete,
            other => panic!("--core-test: off|report|trim|delete, not {other}"),
        };
    }
    if args.iter().any(|a| a == "--basin-trim") {
        scfg.basin_trim = true;
    }
    if args.iter().any(|a| a == "--joint") {
        scfg.joint_neighbours = true;
    }
    if let Some(v) = arg_value(&args, "--frames-per-tile") {
        scfg.frames_per_tile = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--reservoir-max-mb") {
        scfg.reservoir_max_bytes = v.parse::<usize>().unwrap() << 20;
    }
    if let Some(v) = arg_value(&args, "--readd-window") {
        scfg.churn.readd_window_frames = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--churn-frames") {
        scfg.churn.churn_frames = v.parse().unwrap();
    }
    let warm = rec.read(0, (cfg.warmup_frames as u32).min(frames));
    let mut acc = WarmupAccumulator::new(dims);
    for f in warm.chunks_exact(n_px) {
        acc.push(f).unwrap();
    }
    drop(warm);
    let cal = Calibration::from_warmup(&acc, &cfg).unwrap();
    let fov = cal.fov().mask().to_vec();
    let pre0 = Preprocessor::new(cal.clone(), &cfg).unwrap();
    let mut flat = GlowFlattener::new(cal.fov(), &cfg.flatten).unwrap();
    println!(
        "{mode} {}: {}x{}, {t_len} frames, motion {motion}",
        input.display(),
        dims.width,
        dims.height
    );

    let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
    let empty = LibraryBuilder::new(dims)
        .fov(fov.clone())
        .background(scfg.background.clone())
        .build(&mut flat)
        .unwrap();
    let mut engine = TraceEngine::new(Arc::new(empty), SolverConfig::default()).unwrap();
    let mut slow: Option<SlowLoop> = None;
    let mut timed: Option<Timed> = None;
    let mut timed_noise: Option<Vec<f32>> = None;
    // `--via-jobs`: every visit through the parallel protocol, one at a time.
    let mut via: Option<VisitRunner> = None;
    let mut qc: Option<QcMonitor> = None;
    let mut gt: Option<Gt> = None;
    let mut own: Option<HashMap<u64, (Vec<usize>, u32)>> = None;
    let mut hist = History::default();
    let mut y = vec![0.0f32; n_px];
    let mut cells_out = qc_header();
    let mut global = String::new();
    for f in GlobalQc::FIELDS.iter().take(GlobalQc::FIELDS.len() - 1) {
        let _ = write!(global, "{f}\t");
    }
    global.push_str("gt_precision\tgt_recall\tgt_median_true_r\t");
    global.push_str("adds_new\tadds_readd\tchurned\tchurned_readd\testablished_removals\tslow_adds\tslow_merges\tslow_deletes\tslow_splits\tslow_frames\tslow_cells\tforwarded_frames\tdropped_frames\tslow_visits\tvisit_jobs\tvirtual_ms\tho_frames\tho_gain_per_frame\tho_cells\tho_placebos\tho_mu\tho_penalty\tho_score\tho_penalty_ci\n");
    // Batches waiting to be forwarded: (frame, traces, library, recording frame).
    let mut pending: Vec<(Vec<f32>, FrameTraces, Arc<Library>, usize)> = Vec::new();
    let (mut n_batches, mut n_fwd, mut fwd_frames) = (0u64, 0u64, 0u64);
    let mut recent_scores: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
    let mut tokens = 1.0f64;
    // Recording frame of each slow-loop frame.
    let mut slow_rec: Vec<u32> = Vec::new();
    let mut add_log = String::from("frame\trecording_frame\tid\tclass\tcy\tcx\tcos\tdist\tsince\n");
    let mut rem_log = String::from(
        "frame\trecording_frame\tid\tkind\tcy\tcx\tborn\tborn_recording\tclass\tchurned\n",
    );
    let mut qc_ms: Vec<f64> = Vec::with_capacity(t_len);
    let mut summary = Vec::new();
    let mut ho: Option<HeldOutScore> = None;
    let mut ho_cells_out = String::from("frame\tslot\tid\tho_marginal\tho_frames\tho_marginal_z\n");
    let mut s = 0u32;
    let t_all = Instant::now();
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            pipe.frame(f, &mut y);
            if t == start {
                let noise = pipe.pre.noise().sigma();
                if let Some(o) = &oracle {
                    let (g, _) = build_gt(o, dims, &fov, &noise, &mut flat);
                    let mut t = String::from("gt\tcy\tcx\tdetectable\tsnr\n");
                    for j in 0..g.kept.len() {
                        let _ = writeln!(
                            t,
                            "{j}\t{:.2}\t{:.2}\t{}\t{:.3}",
                            g.centers[j].0,
                            g.centers[j].1,
                            u8::from(g.detectable[j]),
                            g.snr[j]
                        );
                    }
                    std::fs::write(out_dir.join("gt.tsv"), t).unwrap();
                    if oracle_mode {
                        let (lib, m) =
                            oracle_library(o, &g, dims, &fov, &noise, &mut flat, frac, seed);
                        println!("oracle library: {} cells", lib.len());
                        engine.set_library(Arc::new(lib)).unwrap();
                        own = Some(m);
                    }
                    gt = Some(g);
                }
                if let Some(path) = &fixed_lib {
                    let lib = read_footprints(path, dims, &fov, &noise, &scfg, &mut flat);
                    println!("fixed library: {} cells from {}", lib.len(), path.display());
                    engine.set_library(Arc::new(lib)).unwrap();
                }
                if heldout_on {
                    let hcfg = HeldOutConfig {
                        cell_diameter_px: scfg.cell_diameter_px,
                        seed: scfg.seed ^ 0x5eed,
                        ..HeldOutConfig::default()
                    };
                    ho = Some(HeldOutScore::new(dims, fov.clone(), noise.clone(), hcfg).unwrap());
                }
                if !oracle_mode && fixed_lib.is_none() {
                    let mk = || {
                        SlowLoop::new(dims, fov.clone(), noise.clone(), flat.clone(), scfg.clone())
                            .unwrap()
                    };
                    slow = Some(mk());
                    if let Some(s) = &slow {
                        let p = s.reservoir_plan();
                        println!(
                            "reservoir: {} frames/tile ({} event + {} random, target {}), capacity {:.0} MB of {:.0} MB",
                            p.frames_per_tile,
                            p.event_slots,
                            p.random_slots,
                            p.target_frames_per_tile,
                            p.capacity_bytes as f64 / 1048576.0,
                            p.max_bytes as f64 / 1048576.0
                        );
                        if let Some(w) = p.warning() {
                            println!("reservoir warning: {w}");
                        }
                    }
                    if via_jobs {
                        via = Some(VisitRunner::new(mk()));
                    }
                    if let Some(fps) = offered_fps {
                        let runners = (0..visit_workers).map(|_| VisitRunner::new(mk())).collect();
                        timed = Some(Timed::new(
                            fps,
                            units_per_ms,
                            observe_ms,
                            job_ms,
                            pool,
                            budget,
                            runners,
                            depth,
                        ));
                    }
                }
                qc = Some(QcMonitor::new(dims, fov.clone(), noise, QcConfig::default()).unwrap());
            }
            if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
                let now = tm.at(t);
                tm.advance(now, sl, &mut slow_rec);
                if let Some(l) = tm.library(now) {
                    engine.set_library(l).unwrap();
                }
            }
            let tr = engine.process(&y).unwrap();
            let Some(q) = qc.as_mut() else { continue };
            let lib = engine.library().clone();
            if let Some(h) = ho.as_mut() {
                if t.is_multiple_of(200) {
                    h.set_noise(pipe.pre.noise().sigma()).unwrap();
                }
                // The slow-loop index this frame will get when forwarded
                // (exact with every batch forwarded; `--slow-keep` < 1 and
                // `--offered-fps` drop batches, which shifts it).
                let idx = match (&slow, &fixed_lib) {
                    (Some(sl), _) => Some(sl.frames() + pending.len() as u64),
                    (None, Some(_)) => Some((t - start) as u64),
                    _ => None,
                };
                if idx.is_some_and(|i| scfg.is_test(i)) {
                    h.frame(t as u64, &y, &lib, &tr, &mut engine, &mut flat)
                        .unwrap();
                }
            }
            hist.push(t, lib.ids(), &tr.traces);
            let a = Instant::now();
            q.observe(&y, &lib, &tr).unwrap();
            qc_ms.push(a.elapsed().as_secs_f64() * 1e3);
            if t.is_multiple_of(200) {
                q.set_noise(pipe.pre.noise().sigma()).unwrap();
            }
            if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
                if t.is_multiple_of(200) {
                    timed_noise = Some(pipe.pre.noise().sigma());
                }
                pending.push((y.clone(), tr.clone(), lib.clone(), t));
                if pending.len() >= batch_n || t + 1 == t_len {
                    n_batches += 1;
                    let now = tm.at(t + 1);
                    let n = pending.len() as u64;
                    if tm.has_buffer(now) {
                        let batch = (std::mem::take(&mut pending), timed_noise.take());
                        tm.forward(now, batch);
                        n_fwd += 1;
                        fwd_frames += n;
                    } else {
                        pending.clear();
                        tm.dropped += n;
                    }
                    tm.advance(now, sl, &mut slow_rec);
                    let rf = |f: u64| slow_rec.get(f as usize).copied().unwrap_or(t as u32);
                    write_logs(sl, &rf, &mut add_log, &mut rem_log);
                }
            } else if let Some(sl) = slow.as_mut() {
                if t.is_multiple_of(200) {
                    sl.set_noise(pipe.pre.noise().sigma()).unwrap();
                    if let Some(r) = via.as_mut() {
                        r.set_noise(pipe.pre.noise().sigma()).unwrap();
                    }
                }
                pending.push((y.clone(), tr.clone(), lib.clone(), t));
                if pending.len() >= batch_n || t + 1 == t_len {
                    n_batches += 1;
                    let forward = if keep >= 1.0 {
                        true
                    } else if score_mode {
                        // Residual excursions above 4 σ, per tile the
                        // largest in the batch, summed over tiles.
                        let mut best: Vec<f32> = Vec::new();
                        for (yy, tt, ll, _) in &pending {
                            let sc = sl.tile_scores(yy, ll, tt).unwrap();
                            if best.is_empty() {
                                best = sc;
                            } else {
                                for (b, v) in best.iter_mut().zip(sc) {
                                    *b = b.max(v);
                                }
                            }
                        }
                        let score: f32 = best.iter().map(|v| (v - 4.0).max(0.0)).sum();
                        let mut v: Vec<f32> = recent_scores.iter().copied().collect();
                        let busy = if v.len() < 16 {
                            true
                        } else {
                            v.sort_by(f32::total_cmp);
                            let k = ((1.0 - keep) * (v.len() - 1) as f64).round() as usize;
                            score > v[k] || score >= v[v.len() - 1]
                        };
                        // Capacity: `keep` batches' worth per batch, at most
                        // 4 banked. A busy batch goes whenever there is
                        // capacity; a quiet one only when capacity would
                        // otherwise go unused.
                        tokens = (tokens + keep).min(4.0);
                        let fwd = tokens >= 1.0 && (busy || tokens >= 3.0);
                        if fwd {
                            tokens -= 1.0;
                        }
                        recent_scores.push_back(score);
                        if recent_scores.len() > 256 {
                            recent_scores.pop_front();
                        }
                        fwd
                    } else {
                        // Evenly spaced: the k-th batch goes when the share
                        // forwarded so far falls behind `keep`.
                        (n_fwd as f64) < keep * n_batches as f64
                    };
                    if forward {
                        n_fwd += 1;
                    }
                    for (yy, tt, ll, tf) in pending.drain(..) {
                        if forward {
                            sl.observe(&yy, &ll, &tt).unwrap();
                            slow_rec.push(tf as u32);
                            fwd_frames += 1;
                        } else if !drop_step {
                            continue;
                        }
                        let published = match via.as_mut() {
                            Some(r) => sl.step_via(budget, r).unwrap(),
                            None => sl.step(budget).unwrap(),
                        };
                        if let Some(l) = published {
                            engine.set_library(l).unwrap();
                        }
                    }
                    let rf = |f: u64| slow_rec.get(f as usize).copied().unwrap_or(t as u32);
                    write_logs(sl, &rf, &mut add_log, &mut rem_log);
                }
            }
            let t_end = t + 1;
            let cp = t_end.is_multiple_of(every) || t_end == t_len;
            let ho_win: Option<HeldOutWindow> = if cp {
                ho.as_mut().map(|h| {
                    for (sl_, c) in h.cells(lib.ids()).iter().enumerate() {
                        let _ = writeln!(
                            ho_cells_out,
                            "{t_end}\t{sl_}\t{}\t{:.4}\t{}\t{:.3}",
                            c.id, c.marginal, c.frames, c.marginal_z
                        );
                    }
                    h.take_window()
                })
            } else {
                None
            };
            if cp {
                if let (Some(g), Some(o)) = (&gt, &oracle) {
                    label_rows(
                        t_end,
                        &lib,
                        q,
                        &hist,
                        g,
                        o,
                        dims,
                        own.as_ref(),
                        &mut cells_out,
                        &mut summary,
                    );
                } else {
                    // No GT: metrics only.
                    for (sl_, c) in q.cells().enumerate() {
                        let _ = write!(
                            cells_out,
                            "{t_end}\t{sl_}\t-1\t-1\t-1\tnan\t-1\tnan\tnan\tnan\tnan\tnan\tnan\t0\t-\tnan"
                        );
                        for v in c.to_row() {
                            let _ = write!(cells_out, "\t{v:.5}");
                        }
                        cells_out.push('\n');
                    }
                    summary = vec![f64::NAN; 3];
                }
            }
            if t_end.is_multiple_of(100) || cp {
                let g = q.global();
                let extra = if cp {
                    summary.clone()
                } else {
                    vec![f64::NAN; 3]
                };
                let mut extra = extra;
                let (cc, st, sf, sn) = slow
                    .as_ref()
                    .map_or((Default::default(), Default::default(), 0, 0), |sl| {
                        (sl.churn_counts(), sl.stats(), sl.frames(), sl.len())
                    });
                let (dropped, jobs, vms) = timed
                    .as_ref()
                    .map_or((0, 0, 0.0), |tm| (tm.dropped, tm.jobs, tm.at(t_end)));
                extra.extend(
                    [
                        cc.adds_new,
                        cc.adds_readd,
                        cc.churned,
                        cc.churned_readd,
                        cc.established_removals,
                        st.adds,
                        st.merges,
                        st.deletes,
                        st.splits,
                        sf,
                        sn as u64,
                        fwd_frames,
                        dropped,
                        st.visits,
                        jobs,
                    ]
                    .map(|v| v as f64),
                );
                extra.push(vms);
                match &ho_win {
                    Some(w) => extra.extend([
                        w.frames as f64,
                        w.gain_per_frame,
                        w.cells,
                        w.placebos,
                        w.mu,
                        w.penalty,
                        w.score,
                        w.penalty_ci,
                    ]),
                    None => extra.extend([f64::NAN; 8]),
                }
                global.push_str(&global_line(&g, &extra));
                if t_end.is_multiple_of(1200) || t_end == t_len {
                    println!(
                        "  frame {t_end}: {} cells, explained {:.3}, residual {:.3}, snr median {:.1}, pass {:.2}, adds/min {:.0}; GT {:?}; {:.0} s",
                        g.cells, g.explained, g.residual_excess, g.snr_median, g.pass_frac, g.adds_per_min, extra,
                        t_all.elapsed().as_secs_f64()
                    );
                }
            }
        }
        s += cnt;
    }
    if let (Some(tm), Some(sl)) = (timed.as_mut(), slow.as_mut()) {
        tm.ending = true;
        tm.advance(f64::INFINITY, sl, &mut slow_rec);
        let wall = t_len as f64 * 1e3 / tm.fps;
        let msg = format!(
            "timed: {} visit workers, offered {} fps over {:.1} s: forwarded {} frames, dropped {}, observed {}; visits {} ({} jobs); owner busy {:.0}% , visit workers busy {:.0}%, slow loop done at {:.1} s, {:.0} observed frames/s\n",
            tm.runners.len(),
            tm.fps,
            wall / 1e3,
            tm.forwarded,
            tm.dropped,
            sl.frames(),
            sl.stats().visits,
            tm.jobs,
            100.0 * tm.owner_busy / wall,
            100.0 * tm.runner_busy / (wall * tm.runners.len().max(1) as f64),
            tm.last_ms / 1e3,
            sl.frames() as f64 / (wall / 1e3),
        );
        print!("{msg}");
        std::fs::write(out_dir.join("timed.txt"), &msg).unwrap();
    }
    // Each cell's best trace correlation with any GT unit (over its whole
    // life), wherever that unit is: tells light from a distant unit (a
    // dendrite, an out-of-focus blur) from signal no GT unit made.
    if let (Some(g), Some(o)) = (&gt, &oracle) {
        let lib = engine.library().clone();
        let det = columns(&lib, dims, (0, 0));
        let mut t = String::from("id\tcy\tcx\tgr\tgr_gt\tgr_dist\tgr_detectable\n");
        for (&id, col) in lib.ids().iter().zip(&det) {
            let Some((t0, w)) = hist.map.get(&id) else {
                continue;
            };
            if w.len() < 200 || t0 + w.len() > g.t_gt {
                continue;
            }
            let (mut bj, mut br) = (usize::MAX, f64::NEG_INFINITY);
            for j in 0..g.kept.len() {
                let r = pearson(w, &g.c(o, j)[*t0..t0 + w.len()]);
                if r > br {
                    (bj, br) = (j, r);
                }
            }
            let c = centroid(col, dims.width);
            let (d, det_j) = if bj == usize::MAX {
                (f32::NAN, 0)
            } else {
                let gc = g.centers[bj];
                (
                    ((gc.0 - c.0).powi(2) + (gc.1 - c.1).powi(2)).sqrt(),
                    u8::from(g.detectable[bj]),
                )
            };
            let _ = writeln!(
                t,
                "{id}\t{:.2}\t{:.2}\t{br:.4}\t{}\t{d:.1}\t{det_j}",
                c.0,
                c.1,
                if bj == usize::MAX { -1 } else { bj as i64 }
            );
        }
        std::fs::write(out_dir.join("traces_gt.tsv"), t).unwrap();
    }
    std::fs::write(out_dir.join("cells.tsv"), &cells_out).unwrap();
    std::fs::write(out_dir.join("global.tsv"), &global).unwrap();
    std::fs::write(out_dir.join("adds.tsv"), &add_log).unwrap();
    std::fs::write(out_dir.join("removals.tsv"), &rem_log).unwrap();
    println!("slow loop: {n_fwd} of {n_batches} batches forwarded ({fwd_frames} frames)");
    if let Some(sl) = &slow {
        if sl.config().core_test != CoreTest::Off {
            let (fp, ff, fd) = sl.fast_diag;
            println!("fast: proposals with core {fp}, without {ff}, nocore deletions {fd}");
            std::fs::write(out_dir.join("split.tsv"), sl.split_report()).unwrap();
            std::fs::write(out_dir.join("fast.tsv"), sl.fast_report()).unwrap();
        }
        if sl.config().basin_trim {
            let (c, f, s2) = sl.basin_diag;
            println!(
                "basin: {c} trims, mean light cut {:.3}, second peaks {s2}",
                if c > 0 { f / c as f64 } else { 0.0 }
            );
        }
    }
    let q = qc.expect("QC started");
    let mut sorted = qc_ms.clone();
    sorted.sort_by(f64::total_cmp);
    let mean = qc_ms.iter().sum::<f64>() / qc_ms.len() as f64;
    let msg = format!(
        "QC cost per frame: mean {:.3} ms, p50 {:.3}, p99 {:.3}, max {:.1} ms; state {:.1} MB; cells {}\n",
        mean,
        sorted[sorted.len() / 2],
        sorted[(sorted.len() - 1) * 99 / 100],
        sorted[sorted.len() - 1],
        q.state_bytes() as f64 / 1048576.0,
        engine.library().len()
    );
    let mut msg = msg;
    if let Some(h) = &ho {
        let wall = t_all.elapsed().as_secs_f64();
        let (asked, placed) = h.placebo_counts;
        let _ = writeln!(
            msg,
            "held-out score: {:.1} s of {:.1} s wall ({:.1} %), {} held-out frames, placebos placed {placed} of {asked}; stages (gain, drop-one, placebo builds, placebo solve, placebo gains) {:.1?} s",
            h.seconds,
            wall,
            100.0 * h.seconds / wall,
            h.scored(),
            h.split
        );
        let mut t = String::from("version\tfirst\tlast\tho_frames\tho_gain_per_frame\tho_cells\tho_placebos\tho_mu\tho_penalty\tho_score\tho_penalty_ci\n");
        for v in h.versions(true) {
            let _ = writeln!(
                t,
                "{}\t{}\t{}\t{}\t{:.4}\t{:.1}\t{:.1}\t{:.5}\t{:.4}\t{:.4}\t{:.4}",
                v.version,
                v.first,
                v.last,
                v.frames,
                v.gain_per_frame,
                v.cells,
                v.placebos,
                v.mu,
                v.penalty,
                v.score,
                v.penalty_ci
            );
        }
        std::fs::write(out_dir.join("heldout.tsv"), t).unwrap();
        std::fs::write(out_dir.join("ho_cells.tsv"), &ho_cells_out).unwrap();
    }
    print!("{msg}");
    std::fs::write(out_dir.join("cost.txt"), &msg).unwrap();

    // Final library (finalize publishes pending edits).
    let lib = match slow.as_mut() {
        Some(sl) => sl.finalize().unwrap(),
        None => engine.library().clone(),
    };
    {
        // Final cells: centroid and footprint match (GT runs).
        let det = columns(&lib, dims, (0, 0));
        let mut t = String::from(
            "slot\tid\tcy\tcx\tmatched\tbest_gt\tbest_r\tstatus\ttransients\tpasses\tfails\tredundant\tpeak_z\tho_marginal\tho_frames\tho_marginal_z\n",
        );
        let (mt, best) = match &gt {
            Some(g) => match_cells(&det, &g.cols, dims, 0.7),
            None => (
                vec![None; det.len()],
                vec![(usize::MAX, f64::NAN); det.len()],
            ),
        };
        let hc = ho.as_ref().map(|h| h.cells(lib.ids()));
        for s in 0..lib.len() {
            let c = centroid(&det[s], dims.width);
            let hs = hc.as_ref().map_or("nan\t0\tnan".to_string(), |v| {
                format!(
                    "{:.4}\t{}\t{:.3}",
                    v[s].marginal, v[s].frames, v[s].marginal_z
                )
            });
            let (bg, br) = mt[s].unwrap_or(best[s]);
            let info = slow.as_ref().and_then(|sl| sl.cell_info(lib.ids()[s]));
            let ev = info.map_or("na\t-1\t-1\t-1\t-1\tnan".to_string(), |i| {
                format!(
                    "{}\t{}\t{}\t{}\t{}\t{:.2}",
                    i.status.as_str(),
                    i.transients,
                    i.passes,
                    i.fails,
                    i.redundant,
                    i.peak_z
                )
            });
            let _ = writeln!(
                t,
                "{s}\t{}\t{:.2}\t{:.2}\t{}\t{}\t{:.4}\t{ev}\t{hs}",
                lib.ids()[s],
                c.0,
                c.1,
                u8::from(mt[s].is_some()),
                if bg == usize::MAX { -1 } else { bg as i64 },
                br
            );
        }
        std::fs::write(out_dir.join("final.tsv"), t).unwrap();
    }
    {
        let mut f = BufWriter::new(File::create(out_dir.join("footprints.bin")).unwrap());
        f.write_all(b"CALAFP01").unwrap();
        for v in [dims.height as u32, dims.width as u32, lib.len() as u32] {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
        for s in 0..lib.len() {
            let (p, a) = lib.unfiltered(s);
            let (_, h) = lib.filtered(s);
            f.write_all(&(lib.ids()[s] as u32).to_le_bytes()).unwrap();
            f.write_all(&(p.len() as u32).to_le_bytes()).unwrap();
            for q in p {
                f.write_all(&q.to_le_bytes()).unwrap();
            }
            write_f32s(&mut f, a);
            write_f32s(&mut f, h);
        }
    }
    if !dump {
        return;
    }
    // Pass 2: re-extract with the final library; per cell the trace, its ring
    // background, and the footprint projection ã_iᵀ y / ã_iᵀ ã_i of the frame
    // before and after the floor.
    let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
    let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
    let mut q2 = QcMonitor::new(
        dims,
        fov.clone(),
        pipe.pre.noise().sigma(),
        QcConfig::default(),
    )
    .unwrap();
    let n = lib.len();
    let norms: Vec<f32> = (0..n)
        .map(|s| lib.filtered(s).1.iter().map(|a| a * a).sum())
        .collect();
    let mut files: Vec<BufWriter<File>> = ["trace", "ring", "pre", "post"]
        .iter()
        .map(|k| BufWriter::new(File::create(out_dir.join(format!("dump_{k}.f32"))).unwrap()))
        .collect();
    let mut pre = vec![0.0f32; n_px];
    let mut tr = FrameTraces::default();
    let mut proj = vec![0.0f32; n];
    let mut hist2 = History::default();
    let mut s = 0u32;
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            pipe.frame_split(f, &mut pre, &mut y);
            eng.process_into(&y, &mut tr).unwrap();
            if t.is_multiple_of(200) {
                q2.set_noise(pipe.pre.noise().sigma()).unwrap();
            }
            q2.observe(&y, &lib, &tr).unwrap();
            hist2.push(t, lib.ids(), &tr.traces);
            write_f32s(&mut files[0], &tr.traces);
            write_f32s(&mut files[1], &tr.background);
            for (img, file) in [(&pre, 2usize), (&y, 3usize)] {
                for (sl_, pr) in proj.iter_mut().enumerate() {
                    let (p, v) = lib.filtered(sl_);
                    let d: f32 = p.iter().zip(v).map(|(&qq, &a)| a * img[qq as usize]).sum();
                    *pr = d / norms[sl_];
                }
                write_f32s(&mut files[file], &proj);
            }
        }
        s += cnt;
    }
    let mut out = qc_header();
    if let (Some(g), Some(o)) = (&gt, &oracle) {
        label_rows(
            t_len,
            &lib,
            &q2,
            &hist2,
            g,
            o,
            dims,
            own.as_ref(),
            &mut out,
            &mut summary,
        );
    } else {
        for (sl_, c) in q2.cells().enumerate() {
            let _ = write!(
                out,
                "{t_len}\t{sl_}\t-1\t-1\t-1\tnan\t-1\tnan\tnan\tnan\tnan\tnan\tnan\t0\t-\tnan"
            );
            for v in c.to_row() {
                let _ = write!(out, "\t{v:.5}");
            }
            out.push('\n');
        }
    }
    std::fs::write(out_dir.join("cells_pass2.tsv"), out).unwrap();
    println!("pass 2 dump: {n} cells x {t_len} frames");
}
