//! Evaluate the slow loop (streaming cell discovery) end to end.
//!
//! ```text
//! cargo run --release --example discover_eval -- sim  <sim dir> <out dir> [options]
//! cargo run --release --example discover_eval -- real <avi dir> <out dir> [options]
//!   --frames N        first N frames (default all)
//!   --motion          run the real motion corrector (piecewise rigid) upstream
//!   --budget U        slow-loop work units per frame (default 3e7)
//!   --start N         frame at which the slow loop starts (default 50; the
//!                     noise map needs a few frames)
//!   --checkpoints K   library snapshots matched against GT (default 10)
//!   --no-pass2        skip re-extraction
//!   --accept-z Z / --merge-corr R / --reservoir-mb M   slow-loop settings
//! ```
//!
//! Pass 1 runs preprocessing (and motion correction), the fast loop and the
//! slow loop frame by frame, starting from an empty library and swapping in
//! each published version. Pass 2 re-extracts every frame with the final
//! library. With a minisim recording (`tools/minisim-calibration/make_trace_sim.py`)
//! the detected footprints are matched to the GT units (Hungarian on the
//! correlation of the *filtered* footprints, r ≥ 0.7, centres within 15 px)
//! and the report gives recall (all detectable units, in focus, by peak SNR,
//! late-born = silent in the first half), precision, duplicates / splits,
//! pass-2 trace r of the matched cells, and recall against frames read.
//! Writes `curve.tsv` (library size against frames), `checkpoints.tsv`,
//! `summary.txt`, `footprints.bin` (`CALAFP01`, H, W, n, then per cell id,
//! n_px, pixel indices, unfiltered and filtered values), `maxproj.f32` and
//! `traces.f32` (frames x cells).

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
    Footprint, Library, LibraryBuilder, SolverConfig, TraceEngine,
};
use calab_cala::discover::{SlowLoop, SlowLoopConfig};
use calab_cala::motion::{Frame, Frames, MotionConfig, MotionCorrector, NonRigidConfig};
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
    fn new(rec: &mut Recording, pre: Preprocessor, cal: &Calibration, motion: bool, warm: u32) -> Pipeline {
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
                    let (y, x) = ((q as usize / dims.width) as i32 + off.0, (q as usize % dims.width) as i32 + off.1);
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
    let mut union: Vec<(f64, f64)> = a.iter().map(|&(_, v)| (f64::from(v), 0.0)).collect::<Vec<_>>();
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

/// Match detected to GT footprints: Hungarian on 1 − r over pairs with
/// centres within 15 px and r ≥ `thr`. Returns per detected cell the GT
/// index and r, plus every detected cell's best r against any GT cell.
fn match_cells(
    det: &[Vec<(u32, f32)>],
    gt: &[Vec<(u32, f32)>],
    dims: Dims,
    thr: f64,
) -> (Vec<Option<(usize, f64)>>, Vec<(usize, f64)>) {
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
        .map(|p| p.iter().copied().fold((usize::MAX, -1.0), |b, x| if x.1 > b.1 { x } else { b }))
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
                    s += f64::from(a[(y * w + x) as usize]) * f64::from(b[((y + dy) * w + x + dx) as usize]);
                }
            }
            if s > best.1 {
                best = ((dy, dx), s);
            }
        }
    }
    best.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).expect("mode: sim | real").clone();
    let input = PathBuf::from(args.get(2).expect("input dir"));
    let out_dir = PathBuf::from(args.get(3).expect("out dir"));
    std::fs::create_dir_all(&out_dir).unwrap();
    let sim = mode == "sim";
    let motion = args.iter().any(|a| a == "--motion");
    let pass2 = !args.iter().any(|a| a == "--no-pass2");
    let budget: u64 = arg_value(&args, "--budget").map_or(30_000_000, |s| s.parse().unwrap());
    let start: u32 = arg_value(&args, "--start").map_or(50, |s| s.parse().unwrap());
    let n_checkpoints: u32 = arg_value(&args, "--checkpoints").map_or(10, |s| s.parse().unwrap());
    let mut scfg = SlowLoopConfig::default();
    if let Some(v) = arg_value(&args, "--accept-z") {
        scfg.accept_z = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--reservoir-mb") {
        scfg.reservoir_bytes = v.parse::<usize>().unwrap() << 20;
    }
    if let Some(v) = arg_value(&args, "--merge-corr") {
        scfg.merge_corr = v.parse().unwrap();
    }

    let avi_dir = if sim { input.join("daq/Miniscope") } else { input.clone() };
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let n_px = dims.pixels();
    let oracle = sim.then(|| read_oracle(&input.join("oracle.bin")));
    let mut frames = arg_value(&args, "--frames").map_or(rec.total, |s| s.parse().unwrap()).min(rec.total);
    if let Some(o) = &oracle {
        assert_eq!(o.dims, dims);
        frames = frames.min(o.n_frames as u32);
    }
    let t_len = frames as usize;
    let cfg = PreprocessConfig::for_fps(20.0);
    scfg.cell_diameter_px = cfg.flatten.cell_diameter_px;
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
        "{mode} {}: {}x{}, {t_len} frames, motion {motion}, budget {budget}/frame, fov {} px",
        input.display(),
        dims.width,
        dims.height,
        fov.iter().filter(|&&m| m != 0).count()
    );

    // ---- pass 1: fast + slow loop
    let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
    let empty = LibraryBuilder::new(dims)
        .fov(fov.clone())
        .background(scfg.background.clone())
        .build(&mut flat)
        .unwrap();
    let mut engine = TraceEngine::new(Arc::new(empty), SolverConfig::default()).unwrap();
    let mut slow: Option<SlowLoop> = None;
    let mut y = vec![0.0f32; n_px];
    let mut maxproj = vec![f32::MIN; n_px];
    let (mut t_pre, mut t_fast, mut t_obs, mut t_step) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut step_ms: Vec<f64> = Vec::with_capacity(t_len);
    let mut checkpoints: Vec<(usize, Arc<Library>)> = Vec::new();
    let every = (t_len as u32 / n_checkpoints.max(1)).max(1) as usize;
    let mut curve = File::create(out_dir.join("curve.tsv")).unwrap();
    writeln!(curve, "frame\tcells\tpublished\tadds\tmerges\trefines\trejects\tvisits\tcommits\treservoir_mb").unwrap();
    let mut s = 0u32;
    let t_all = Instant::now();
    while s < frames {
        let cnt = 64.min(frames - s);
        let raw = rec.read(s, cnt);
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            let t0 = Instant::now();
            pipe.frame(f, &mut y);
            let t1 = Instant::now();
            let tr = engine.process(&y).unwrap();
            let t2 = Instant::now();
            t_pre += (t1 - t0).as_secs_f64();
            t_fast += (t2 - t1).as_secs_f64();
            for (m, &v) in maxproj.iter_mut().zip(&y) {
                *m = m.max(v);
            }
            if t == start as usize {
                slow = Some(SlowLoop::new(dims, fov.clone(), pipe.pre.noise().sigma(), flat.clone(), scfg.clone()).unwrap());
            }
            if let Some(sl) = slow.as_mut() {
                if t % 200 == 0 {
                    sl.set_noise(pipe.pre.noise().sigma()).unwrap();
                }
                let lib = engine.library().clone();
                let a = Instant::now();
                sl.observe(&y, &lib, &tr).unwrap();
                let b = Instant::now();
                if let Some(l) = sl.step(budget).unwrap() {
                    engine.set_library(l).unwrap();
                }
                let c = Instant::now();
                t_obs += (b - a).as_secs_f64();
                t_step += (c - b).as_secs_f64();
                step_ms.push((c - b).as_secs_f64() * 1e3);
                if (t + 1) % 100 == 0 {
                    let st = sl.stats();
                    writeln!(
                        curve,
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.1}",
                        t + 1,
                        sl.len(),
                        engine.library().len(),
                        st.adds,
                        st.merges,
                        st.refines,
                        st.rejects,
                        st.visits,
                        st.commits,
                        sl.reservoir_bytes() as f64 / 1048576.0
                    )
                    .unwrap();
                }
                if (t + 1) % 600 == 0 {
                    println!(
                        "  frame {}: {} cells ({} published), {:?}, {:.0} s",
                        t + 1,
                        sl.len(),
                        engine.library().len(),
                        sl.stats(),
                        t_all.elapsed().as_secs_f64()
                    );
                }
            }
            if (t + 1) % every == 0 || t + 1 == t_len {
                checkpoints.push((t + 1, engine.library().clone()));
            }
        }
        s += cnt;
    }
    let mut sl = slow.expect("slow loop started");
    let lib = sl.finalize().unwrap();
    if let Some(last) = checkpoints.last_mut() {
        last.1 = lib.clone();
    }
    let nf = t_len as f64;
    let ns = step_ms.len() as f64;
    let mut sorted = step_ms.clone();
    sorted.sort_by(f64::total_cmp);
    let pct = |q: f64| sorted[((sorted.len() - 1) as f64 * q) as usize];
    println!(
        "pass 1: {} cells; per frame: preprocess{} {:.2} ms, fast {:.2} ms, observe {:.2} ms, step {:.2} ms (p50 {:.2}, p99 {:.1}, max {:.0} ms); work {:.2e}/frame; reservoir {:.0} MB ({:?} slots/tile); {:?}",
        lib.len(),
        if motion { "+motion" } else { "" },
        t_pre / nf * 1e3,
        t_fast / nf * 1e3,
        t_obs / ns * 1e3,
        t_step / ns * 1e3,
        pct(0.5),
        pct(0.99),
        pct(1.0),
        sl.work() as f64 / ns,
        sl.reservoir_bytes() as f64 / 1048576.0,
        sl.slots_per_tile(),
        sl.stats()
    );

    // ---- export footprints, max projection
    {
        let mut f = std::io::BufWriter::new(File::create(out_dir.join("footprints.bin")).unwrap());
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
        let mut f = File::create(out_dir.join("maxproj.f32")).unwrap();
        write_f32s(&mut f, &maxproj);
    }

    // ---- pass 2: re-extract every frame with the final library
    let mut traces = vec![0.0f32; if pass2 { t_len * lib.len() } else { 0 }];
    if pass2 {
        let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
        let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
        let mut s = 0u32;
        let t0 = Instant::now();
        while s < frames {
            let cnt = 64.min(frames - s);
            let raw = rec.read(s, cnt);
            for (k, f) in raw.chunks_exact(n_px).enumerate() {
                let t = s as usize + k;
                pipe.frame(f, &mut y);
                let r = eng.process(&y).unwrap();
                traces[t * lib.len()..(t + 1) * lib.len()].copy_from_slice(&r.traces);
            }
            s += cnt;
        }
        println!("pass 2: {t_len} frames in {:.1} s", t0.elapsed().as_secs_f64());
        let mut f = std::io::BufWriter::new(File::create(out_dir.join("traces.f32")).unwrap());
        write_f32s(&mut f, &traces);
    }

    // ---- curve of library size (also for real data)
    let Some(oracle) = oracle else {
        let mut f = File::create(out_dir.join("checkpoints.tsv")).unwrap();
        writeln!(f, "frame\tcells").unwrap();
        for (t, l) in &checkpoints {
            writeln!(f, "{t}\t{}", l.len()).unwrap();
        }
        return;
    };

    // ---- metrics against ground truth
    let noise = pipe.pre.noise().sigma();
    let gt_units: Vec<usize> = (0..oracle.units.len())
        .filter(|&u| {
            let un = &oracle.units[u];
            let (cy, cx) = (un.center.0.round(), un.center.1.round());
            cy >= 0.0
                && cx >= 0.0
                && (cy as usize) < dims.height
                && (cx as usize) < dims.width
                && fov[cy as usize * dims.width + cx as usize] != 0
        })
        .collect();
    let mut b = LibraryBuilder::new(dims).fov(fov.clone());
    let mut kept = Vec::new();
    for &u in &gt_units {
        let fp = &oracle.units[u].full;
        if fp.values.iter().any(|&v| v > 0.0) {
            b.push(fp.clone());
            kept.push(u);
        }
    }
    let gt_lib = b.build(&mut flat).unwrap();
    let off = if motion { best_offset(&lib, &gt_lib, dims, 16) } else { (0, 0) };
    println!("GT units with centre in FOV: {} ({} detectable); offset {:?}", kept.len(), kept.iter().filter(|&&u| oracle.units[u].detectable).count(), off);
    let gt_cols = columns(&gt_lib, dims, (0, 0));
    let t_gt = oracle.n_frames;
    let c_of = |u: usize| &oracle.c[u * t_gt..u * t_gt + t_len];
    // Per GT unit: peak SNR (event amplitude x filtered peak / noise), late-born flag.
    let snr: Vec<f64> = (0..kept.len())
        .map(|j| {
            let c = c_of(kept[j]);
            let mut s: Vec<f32> = c.to_vec();
            s.sort_by(f32::total_cmp);
            let amp = s[s.len() - 1] - s[s.len() / 2];
            let (p, v) = gt_lib.filtered(j);
            let (k, peak) = v.iter().enumerate().fold((0, f32::MIN), |b, (i, &x)| if x > b.1 { (i, x) } else { b });
            f64::from(amp * peak / noise[p[k] as usize].max(1e-6))
        })
        .collect();
    let late: Vec<bool> = (0..kept.len())
        .map(|j| {
            let c = c_of(kept[j]);
            let lo = c.iter().copied().fold(f32::MAX, f32::min);
            let hi = c.iter().copied().fold(f32::MIN, f32::max);
            let first = c[..t_len / 2].iter().copied().fold(f32::MIN, f32::max);
            hi > lo && first - lo < 0.1 * (hi - lo)
        })
        .collect();
    let detectable: Vec<bool> = kept.iter().map(|&u| oracle.units[u].detectable).collect();
    let focus: Vec<bool> = kept.iter().map(|&u| oracle.units[u].in_focus).collect();
    let thr = 0.7;
    let mut summary = String::new();
    let mut cp_file = File::create(out_dir.join("checkpoints.tsv")).unwrap();
    writeln!(cp_file, "frame\tcells\tmatched\trecall\trecall_focus\trecall_snr10\trecall_late\tprecision").unwrap();
    let frac = |m: &[bool], sel: &dyn Fn(usize) -> bool| {
        let n = (0..m.len()).filter(|&j| sel(j)).count();
        let k = (0..m.len()).filter(|&j| sel(j) && m[j]).count();
        (k, n)
    };
    let mut split_log_out = String::new();
    for (ci, (t, l)) in checkpoints.iter().enumerate() {
        let det = columns(l, dims, off);
        let (mt, best) = match_cells(&det, &gt_cols, dims, thr);
        let mut gt_hit = vec![false; kept.len()];
        for m in mt.iter().flatten() {
            gt_hit[m.0] = true;
        }
        let matched_det = mt.iter().filter(|m| m.is_some_and(|(j, _)| detectable[j])).count();
        let all = frac(&gt_hit, &|j| detectable[j]);
        let foc = frac(&gt_hit, &|j| detectable[j] && focus[j]);
        let br = frac(&gt_hit, &|j| detectable[j] && snr[j] >= 10.0);
        let lt = frac(&gt_hit, &|j| detectable[j] && late[j]);
        let rt = |k: (usize, usize)| k.0 as f64 / k.1.max(1) as f64;
        writeln!(
            cp_file,
            "{t}\t{}\t{matched_det}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}",
            l.len(),
            rt(all),
            rt(foc),
            rt(br),
            rt(lt),
            matched_det as f64 / l.len().max(1) as f64
        )
        .unwrap();
        if ci + 1 < checkpoints.len() {
            continue;
        }
        // Final library: the full report.
        let mut dup = 0;
        let mut nondet = 0;
        let mut unexplained = 0;
        let mut unexpl_r: Vec<f64> = Vec::new();
        let mut unexpl_hit = 0;
        let mut unexpl_split = 0;
        let mut unexpl_log = String::from("det\tcy\tcx\tnpx\tgt_trace_r\tnb_trace_r\tnb_dist\ttrace_snr\n");
        let mut split_log = String::from("det\tmatched_det\tdist\ttrace_r_pair\ttrace_r_gt\tfocus\tsnr\n");
        let mut unexpl_tr: Vec<f64> = Vec::new();
        for (i, m) in mt.iter().enumerate() {
            match m {
                Some((j, _)) if !detectable[*j] => nondet += 1,
                Some(_) => {}
                None => {
                    let (j, r) = best[i];
                    if j != usize::MAX && r >= 0.5 && gt_hit[j] {
                        dup += 1;
                    } else if j != usize::MAX && r >= thr {
                        nondet += 1;
                    } else {
                        unexplained += 1;
                        unexpl_r.push(if j == usize::MAX { 0.0 } else { r });
                        if j != usize::MAX && gt_hit[j] {
                            unexpl_hit += 1;
                        }
                        // Is its trace a real cell's? Best r against GT
                        // units whose centre is within 15 px.
                        if pass2 {
                            let n = lib.len();
                            let tr: Vec<f32> = (0..t_len).map(|t| traces[t * n + i]).collect();
                            let ci = centroid(&det[i], dims.width);
                            let mut b = 0.0f64;
                            let mut bj = 0usize;
                            for (jj, g) in gt_cols.iter().enumerate() {
                                let cg = centroid(g, dims.width);
                                if (cg.0 - ci.0).powi(2) + (cg.1 - ci.1).powi(2) <= 225.0 {
                                    let r = pearson(&tr, c_of(kept[jj])); if r > b { b = r; bj = jj; }
                                }
                            }
                            unexpl_tr.push(b);
                            {
                                let mut nb = (0.0f64, f32::MAX);
                                for (k, m) in mt.iter().enumerate() {
                                    if m.is_none() { continue; }
                                    let ck = centroid(&det[k], dims.width);
                                    let dd = ((ck.0 - ci.0).powi(2) + (ck.1 - ci.1).powi(2)).sqrt();
                                    if dd < 25.0 {
                                        let tk: Vec<f32> = (0..t_len).map(|t| traces[t * n + k]).collect();
                                        let r = pearson(&tr, &tk);
                                        if r > nb.0 { nb = (r, dd); }
                                    }
                                }
                                let mut s: Vec<f32> = tr.clone(); s.sort_by(f32::total_cmp);
                                let med = s[s.len() / 2];
                                let mut d: Vec<f32> = tr.windows(2).map(|w| (w[1] - w[0]).abs()).collect(); d.sort_by(f32::total_cmp);
                                let sd = d[d.len() / 2] / 0.6745 / std::f32::consts::SQRT_2;
                                let _ = writeln!(unexpl_log, "{i}\t{:.1}\t{:.1}\t{}\t{:.3}\t{:.3}\t{:.1}\t{:.1}", ci.0, ci.1, det[i].len(), b, nb.0, nb.1, (s[s.len() - 1] - med) / sd.max(1e-9));
                            }
                            if b >= 0.6 && gt_hit[bj] {
                                unexpl_split += 1;
                                if let Some(k) = mt.iter().position(|m| m.is_some_and(|(g, _)| g == bj)) {
                                    let tk: Vec<f32> = (0..t_len).map(|t| traces[t * n + k]).collect();
                                    let ck = centroid(&det[k], dims.width);
                                    let _ = writeln!(split_log, "{i}\t{k}\t{:.1}\t{:.3}\t{:.3}\t{}\t{:.1}", ((ck.0 - ci.0).powi(2) + (ck.1 - ci.1).powi(2)).sqrt(), pearson(&tr, &tk), b, focus[bj], snr[bj]);
                                }
                            }
                        }
                    }
                }
            }
        }
        let mid = frac(&gt_hit, &|j| detectable[j] && (5.0..10.0).contains(&snr[j]));
        let low = frac(&gt_hit, &|j| detectable[j] && snr[j] < 5.0);
        let vbr = frac(&gt_hit, &|j| detectable[j] && snr[j] >= 20.0);
        let _ = writeln!(summary, "detected {} | matched to detectable GT {matched_det} | duplicates/splits {dup} | matched non-detectable units {nondet} | unexplained {unexplained}", l.len());
        let _ = writeln!(summary, "precision {:.3} (any GT unit: {:.3})", matched_det as f64 / l.len().max(1) as f64, (matched_det + nondet) as f64 / l.len().max(1) as f64);
        let _ = writeln!(
            summary,
            "recall: all {}/{} = {:.3} | in focus {}/{} = {:.3} | SNR>=20 {}/{} = {:.3} | 10-20 {:.3} | 5-10 {}/{} = {:.3} | <5 {}/{} = {:.3} | late-born {}/{} = {:.3}",
            all.0, all.1, rt(all), foc.0, foc.1, rt(foc), vbr.0, vbr.1, rt(vbr),
            rt((br.0 - vbr.0, br.1 - vbr.1)), mid.0, mid.1, rt(mid), low.0, low.1, rt(low), lt.0, lt.1, rt(lt)
        );
        let _ = writeln!(
            summary,
            "unexplained: best footprint r vs any GT unit quantiles 10/50/90 {:.2}/{:.2}/{:.2}; {} of them overlap an already matched GT unit",
            quantile(&unexpl_r, 0.1),
            quantile(&unexpl_r, 0.5),
            quantile(&unexpl_r, 0.9),
            unexpl_hit
        );
        let _ = writeln!(
            summary,
            "unexplained: best trace r vs GT units within 15 px quantiles 10/50/90 {:.2}/{:.2}/{:.2}; {} above 0.6, of which {} on a GT unit that is already matched (trace-level splits)",
            quantile(&unexpl_tr, 0.1),
            quantile(&unexpl_tr, 0.5),
            quantile(&unexpl_tr, 0.9),
            unexpl_tr.iter().filter(|&&r| r >= 0.6).count(), unexpl_split
        );
        split_log_out = split_log.clone();
        std::fs::write(out_dir.join("unexplained.tsv"), &unexpl_log).unwrap();
        let corr_m: Vec<f64> = mt.iter().flatten().map(|m| m.1).collect();
        let _ = writeln!(summary, "footprint r of matches: median {:.3} p10 {:.3}", quantile(&corr_m, 0.5), quantile(&corr_m, 0.1));
        if pass2 {
            let n = lib.len();
            let (mut r_all, mut r_foc) = (Vec::new(), Vec::new());
            for (i, m) in mt.iter().enumerate() {
                if let Some((j, _)) = m {
                    let tr: Vec<f32> = (0..t_len).map(|t| traces[t * n + i]).collect();
                    let r = pearson(&tr, c_of(kept[*j]));
                    r_all.push(r);
                    if focus[*j] {
                        r_foc.push(r);
                    }
                }
            }
            let _ = writeln!(
                summary,
                "pass-2 trace r (matched): all median {:.3} p10 {:.3} | in focus median {:.3} p10 {:.3}",
                quantile(&r_all, 0.5),
                quantile(&r_all, 0.1),
                quantile(&r_foc, 0.5),
                quantile(&r_foc, 0.1)
            );
        }
    }
    print!("{summary}");
    std::fs::write(out_dir.join("summary.txt"), summary).unwrap();
    std::fs::write(out_dir.join("splits.tsv"), split_log_out).unwrap();
}
