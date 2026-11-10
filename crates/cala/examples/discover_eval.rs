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
//!   --checkpoints K   full library snapshots matched against GT (default 10)
//!   --fps F           recording sampling rate (default 20)
//!   --no-pass2        skip re-extraction
//!   --compress-window N[,M...]   after pass 2, compress the frames in
//!                     windows of N (crate::compress) at three points of the
//!                     chain (raw, after the front half, the fast loop's
//!                     input), replay pass 2 from the factors and compare the
//!                     traces with pass 2 from the frames (`compress.tsv`)
//!   --compress-taps LIST   any of final,front,raw (default all)
//!   --compress-threads N   threads sharing a window's tiles (default: all
//!                     cores; 1 for clean single-thread timings)
//!   --seed-file F --seed-at N   at recording frame N, seed the slow loop with
//!                     the footprints in F (`CALASEED`, u32 n, then per cell
//!                     u32 id, y0, x0, h, w and f32 h*w unfiltered values),
//!                     e.g. a batch detection on the first frames
//!   --compress-dump   also write the first window of each tap, quantized
//!                     (`window_<tap>_<N>.i16`: `CALAWIN1`, u32 width, height,
//!                     frames, f32 quant, then i16 frames), the input of
//!                     examples/compress_bench.rs and
//!                     apps/cala/scripts/compress-bench.mjs
//!   --accept-z Z / --merge-corr R / --reservoir-mb M   slow-loop settings
//!   --no-prune / --no-pretest / --probation N / --keep-z Z   slow loop v2
//!   --v1              all v2 additions off (prune, pre-test)
//!   --no-merge-refit  merge test against the pair's current footprints only
//!   --no-noise-corr / --no-shift-nuisance   white-noise nulls / no gradient
//!                     nuisance terms in the add test
//! Diagnostics (environment): CALA_MC_ORACLE=<file> corrects with the
//! simulator's true motion (file from export_gt_motion.py: u32 T, gy, gx,
//! f64 node rows, node cols, then per frame f32 dy, dx, field), CALA_JITTER=<file>
//! moves a still recording by those shifts and back (resampling only),
//! CALA_NR=off rigid-only corrector, CALA_INTERP=bilinear.
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
//! `traces.f32` (frames x cells). `footprint_history.bin` streams changed
//! footprints at every publication; `library_versions.tsv` records full ID
//! membership. See emitted `diagnostics-format.txt` for binary schemas, frame
//! conventions, publication-level limits, and stage timing/work counters.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use calab_cala::avi::{idx1_payload_len, AviHeader};
use calab_cala::compress::{quantize, CompressConfig, WindowCompressor, WindowFactors};
use calab_cala::discover::{CellStatus, DeletedCell, SlowLoop, SlowLoopConfig};
use calab_cala::motion::{
    Frame, Frames, Interpolation, MotionConfig, MotionCorrector, NonRigidConfig, Warper,
};
use calab_cala::preprocess::flatten::GlowFlattener;
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, Preprocessor, RawPixel};
use calab_cala::trace::{Footprint, Library, LibraryBuilder, SolverConfig, TraceEngine};
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
    /// Diagnostics: oracle correction from the simulator's true motion
    /// (`CALA_MC_ORACLE=<file from export_gt_motion.py>`): warper, per-frame
    /// records (dy, dx, field) and record length.
    oracle: Option<(Warper, Vec<f32>, usize)>,
    /// Diagnostics: `CALA_JITTER=<motion file>` moves a still recording by
    /// the file's shifts (bilinear, like the simulator) and back (bicubic,
    /// like the corrector): resampling without any registration error.
    jitter: Option<Jitter>,
    t: usize,
    /// Last frame's (dy, dx, residual rms).
    pub last: (f32, f32, f32),
}

fn read_mc_oracle(
    path: &str,
    h: usize,
    w: usize,
    interp: Interpolation,
) -> (Warper, Vec<f32>, usize) {
    let b = std::fs::read(path).unwrap();
    let u = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap()) as usize;
    let (t, gy, gx) = (u(0), u(4), u(8));
    let mut o = 12;
    let mut f64s = |n: usize| {
        let v: Vec<f64> = (0..n)
            .map(|i| f64::from_le_bytes(b[o + 8 * i..o + 8 * i + 8].try_into().unwrap()))
            .collect();
        o += 8 * n;
        v
    };
    let ny = f64s(gy);
    let nx = f64s(gx);
    let rl = 2 + 2 * gy * gx;
    let rec: Vec<f32> = b[o..o + 4 * t * rl]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    (Warper::new(h, w, &ny, &nx, interp).unwrap(), rec, rl)
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
                // Diagnostics: CALA_NR=off for a rigid-only corrector.
                nonrigid: (std::env::var("CALA_NR").ok().as_deref() != Some("off"))
                    .then(NonRigidConfig::default),
                interpolation: if std::env::var("CALA_INTERP").ok().as_deref() == Some("bilinear") {
                    Interpolation::Bilinear
                } else {
                    Interpolation::Bicubic
                },
                ..MotionConfig::default()
            };
            let mut mc = MotionCorrector::new(dims.height, dims.width, cfg).unwrap();
            mc.set_fov_mask(cal.fov().mask()).unwrap();
            mc.initialize(Frames::F32(&frames)).unwrap();
            Some(mc)
        } else {
            None
        };
        let interp = match std::env::var("CALA_INTERP").ok().as_deref() {
            Some("bilinear") => Interpolation::Bilinear,
            _ => Interpolation::Bicubic,
        };
        let oracle = std::env::var("CALA_MC_ORACLE")
            .ok()
            .map(|p| read_mc_oracle(&p, dims.height, dims.width, interp));
        if oracle.is_some() {
            println!("motion: ORACLE correction ({interp:?})");
        }
        let jitter = std::env::var("CALA_JITTER").ok().map(|p| {
            let (fw, rec, rl) =
                read_mc_oracle(&p, dims.height, dims.width, Interpolation::Bilinear);
            let (bw, _, _) = read_mc_oracle(&p, dims.height, dims.width, interp);
            println!("JITTER: bilinear forward, {interp:?} back");
            Jitter {
                fwd: fw,
                back: bw,
                rec,
                rl,
                tmp: vec![0.0f32; n_px],
            }
        });
        Pipeline {
            pre,
            mc: if oracle.is_some() { None } else { mc },
            buf: vec![0.0; n_px],
            oracle,
            jitter,
            t: 0,
            last: (0.0, 0.0, 0.0),
        }
    }

    /// Returns the rigid motion shift `(dy, dx)` (zero without motion).
    fn frame<T: RawPixel>(&mut self, raw: &[T], out: &mut [f32]) -> (f32, f32) {
        self.pre.front(raw, &mut self.buf).unwrap();
        self.finish(out)
    }

    /// The chain from a front-half frame on (`--compress-window`, tap `front`).
    fn frame_from_front(&mut self, front: &[f32], out: &mut [f32]) -> (f32, f32) {
        self.buf.copy_from_slice(front);
        self.finish(out)
    }

    /// Motion correction and the back half, on the front-half frame in `buf`.
    fn finish(&mut self, out: &mut [f32]) -> (f32, f32) {
        let t = self.t;
        self.t += 1;
        if let Some(Jitter {
            fwd: fw,
            back: bw,
            rec,
            rl,
            tmp,
        }) = &mut self.jitter
        {
            let r = &rec[t * *rl..(t + 1) * *rl];
            let res: Vec<f32> = r[2..].to_vec();
            let neg: Vec<f32> = r[2..].iter().map(|v| -v).collect();
            fw.warp(&self.buf, (r[0], r[1]), &res, tmp, None).unwrap();
            bw.warp(tmp, (-r[0], -r[1]), &neg, &mut self.buf, None)
                .unwrap();
        }
        if let Some((wp, rec, rl)) = &mut self.oracle {
            let r = &rec[t * *rl..(t + 1) * *rl];
            let res: Vec<f32> = r[2..].iter().map(|v| -v).collect();
            wp.warp(&self.buf, (-r[0], -r[1]), &res, out, None).unwrap();
            self.pre.back(out).unwrap();
            self.last = (-r[0], -r[1], 0.0);
            return (-r[0], -r[1]);
        }
        let sh = match &mut self.mc {
            Some(mc) => {
                let r = mc.process(Frame::F32(&self.buf), out).unwrap();
                let n = (r.residual.len() / 2).max(1);
                let ss: f32 = r.residual.iter().map(|v| v * v).sum();
                self.last = (r.dy, r.dx, (ss / n as f32).sqrt());
                (r.dy, r.dx)
            }
            None => {
                out.copy_from_slice(&self.buf);
                (0.0, 0.0)
            }
        };
        self.pre.back(out).unwrap();
        sh
    }
}

/// Diagnostics: moves forward (bilinear) and back (corrector's kernel) by
/// recorded shifts.
struct Jitter {
    fwd: Warper,
    back: Warper,
    rec: Vec<f32>,
    rl: usize,
    tmp: Vec<f32>,
}

/// Footprints (unfiltered and filtered) as `CALAFP01`.
fn write_footprints(path: &Path, lib: &Library) {
    let dims = lib.dims();
    let mut f = std::io::BufWriter::new(File::create(path).unwrap());
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

/// Append-only changed footprints: only two published libraries are retained.
/// Membership for each version is streamed separately, so deleted IDs remain
/// inspectable without repeating every unchanged footprint at every commit.
struct EvolutionWriter {
    history: std::io::BufWriter<File>,
    versions: std::io::BufWriter<File>,
    previous: Option<Arc<Library>>,
}

impl EvolutionWriter {
    fn new(out: &Path, dims: Dims) -> Self {
        let mut history =
            std::io::BufWriter::new(File::create(out.join("footprint_history.bin")).unwrap());
        history.write_all(b"CALAFPH1").unwrap();
        history
            .write_all(&(dims.height as u32).to_le_bytes())
            .unwrap();
        history
            .write_all(&(dims.width as u32).to_le_bytes())
            .unwrap();
        let mut versions =
            std::io::BufWriter::new(File::create(out.join("library_versions.tsv")).unwrap());
        writeln!(
            versions,
            "observed_frames\tslow_frames\tversion\tcells\tchanged\tremoved_ids\tids"
        )
        .unwrap();
        Self {
            history,
            versions,
            previous: None,
        }
    }

    fn capture(&mut self, observed_frames: usize, slow_frames: u64, lib: &Arc<Library>) {
        if self
            .previous
            .as_ref()
            .is_some_and(|p| p.version() == lib.version())
        {
            return;
        }
        let removed: Vec<_> = self.previous.as_ref().map_or_else(Vec::new, |p| {
            p.ids()
                .iter()
                .copied()
                .filter(|&id| lib.slot(id).is_none())
                .collect()
        });
        let mut changed = 0;
        for (slot, &id) in lib.ids().iter().enumerate() {
            let unchanged = self
                .previous
                .as_ref()
                .and_then(|p| p.slot(id).map(|old| (p, old)))
                .is_some_and(|(p, old)| {
                    p.unfiltered(old) == lib.unfiltered(slot)
                        && p.filtered(old) == lib.filtered(slot)
                });
            if unchanged {
                continue;
            }
            changed += 1;
            let (pixels, raw) = lib.unfiltered(slot);
            let (filtered_pixels, filtered) = lib.filtered(slot);
            assert_eq!(pixels, filtered_pixels);
            for v in [observed_frames as u64, lib.version(), id] {
                self.history.write_all(&v.to_le_bytes()).unwrap();
            }
            self.history
                .write_all(&(pixels.len() as u32).to_le_bytes())
                .unwrap();
            for q in pixels {
                self.history.write_all(&q.to_le_bytes()).unwrap();
            }
            write_f32s(&mut self.history, raw);
            write_f32s(&mut self.history, filtered);
        }
        let ids = |ids: &[u64]| ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        writeln!(
            self.versions,
            "{observed_frames}\t{slow_frames}\t{}\t{}\t{changed}\t{}\t{}",
            lib.version(),
            lib.len(),
            ids(&removed),
            ids(lib.ids())
        )
        .unwrap();
        // Publish boundaries survive an interrupted long recording; a partially
        // written trailing binary record can be discarded by readers.
        self.history.flush().unwrap();
        self.versions.flush().unwrap();
        self.previous = Some(lib.clone());
    }
}

fn drain_edits(
    sl: &mut SlowLoop,
    edits: &mut impl Write,
    recording_frame: usize,
    visible_version: u64,
) {
    for e in sl.take_edit_log() {
        writeln!(
            edits,
            "{}\t{}\t{}\t{}\t{:.6}\t{:.6}\t{:.6}\t{recording_frame}\t{visible_version}",
            e.frame,
            e.kind.as_str(),
            e.id,
            e.other,
            e.center.0,
            e.center.1,
            e.margin
        )
        .unwrap();
    }
}

/// `--compress-window`: compress the frames at three points of the chain,
/// replay pass 2 from the factors and compare with `reference` (pass 2 from
/// the frames, `frames x cells`).
#[allow(clippy::too_many_arguments)]
fn compress_report(
    rec: &mut Recording,
    pre0: &Preprocessor,
    cal: &Calibration,
    motion: bool,
    lib: &Arc<Library>,
    reference: &[f32],
    frames: u32,
    windows_list: &[usize],
    taps: &[String],
    threads: usize,
    dump: bool,
    pass2_ms: f64,
    out_dir: &Path,
) {
    let dims = rec.dims;
    let n_px = dims.pixels();
    let n = lib.len();
    let t_len = frames as usize;
    let mut report = String::from(
        "tap\tcells\tframes\twindow\tmean_rank\tsvd_rank\tbuffer_mb\tkept_energy\tbytes_per_frame\tratio_vs_u8\tcompress_ms\treplay_ms\tpass2_ms\ttrace_r_median\ttrace_r_p10\trel_rmse_median\trel_rmse_p90\n",
    );
    let jobs: Vec<(usize, &str)> = windows_list
        .iter()
        .flat_map(|&w| taps.iter().map(move |t| (w, t.as_str())))
        .collect();
    for (window, tap) in jobs {
        let mut src = Pipeline::new(rec, pre0.clone(), cal, motion, 200);
        let mut rest = Pipeline::new(rec, pre0.clone(), cal, motion, 200);
        let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
        let cfg = CompressConfig {
            window,
            threads,
            ..CompressConfig::default()
        };
        let quant = cfg.quant;
        let mut wc = WindowCompressor::new(dims, cfg);
        let mut dump_file = dump.then(|| {
            let path = out_dir.join(format!("window_{tap}_{window}.i16"));
            let mut f = std::io::BufWriter::new(File::create(path).unwrap());
            f.write_all(b"CALAWIN1").unwrap();
            let n = window.min(t_len) as u32;
            for v in [dims.width as u32, dims.height as u32, n] {
                f.write_all(&v.to_le_bytes()).unwrap();
            }
            f.write_all(&quant.to_le_bytes()).unwrap();
            f
        });
        let mut pushed = 0usize;
        let mut got = vec![0.0f32; reference.len()];
        let (mut y, mut hat, mut y2) = (vec![0.0f32; n_px], vec![0.0f32; n_px], vec![0.0f32; n_px]);
        let mut rawf = vec![0.0f32; n_px];
        let (mut bytes, mut rank_sum, mut e_all, mut e_kept) = (0usize, 0.0f64, 0.0f64, 0.0f64);
        let (mut t_comp, mut t_replay, mut windows) = (0.0f64, 0.0f64, 0usize);
        let (mut svd_rank, mut buffer) = (0.0f64, 0usize);
        let mut replay = |wf: WindowFactors, rest: &mut Pipeline, eng: &mut TraceEngine| {
            bytes += wf.bytes();
            rank_sum += wf.mean_rank();
            svd_rank +=
                wf.tiles.iter().map(|t| t.svd_rank as f64).sum::<f64>() / wf.tiles.len() as f64;
            e_all += wf.tiles.iter().map(|t| t.energy).sum::<f64>();
            e_kept += wf.tiles.iter().map(|t| t.kept_energy).sum::<f64>();
            t_comp += wf.compress_seconds;
            windows += 1;
            let t0 = Instant::now();
            for i in 0..wf.frames {
                wf.reconstruct(i, &mut hat);
                let r = match tap {
                    "final" => eng.process(&hat).unwrap(),
                    "front" => {
                        rest.frame_from_front(&hat, &mut y2);
                        eng.process(&y2).unwrap()
                    }
                    _ => {
                        rest.frame(&hat, &mut y2);
                        eng.process(&y2).unwrap()
                    }
                };
                let t = wf.start as usize + i;
                got[t * n..(t + 1) * n].copy_from_slice(&r.traces);
            }
            t_replay += t0.elapsed().as_secs_f64();
        };
        let mut s = 0u32;
        while s < frames {
            let cnt = 64.min(frames - s);
            let raw = rec.read(s, cnt);
            for f in raw.chunks_exact(n_px) {
                src.frame(f, &mut y);
                let tapped: &[f32] = match tap {
                    "final" => &y,
                    "front" => &src.buf,
                    _ => {
                        for (o, &v) in rawf.iter_mut().zip(f) {
                            *o = f32::from(v);
                        }
                        &rawf
                    }
                };
                if let Some(f) = dump_file.as_mut().filter(|_| pushed < window) {
                    for &v in tapped {
                        f.write_all(&quantize(v, quant).to_le_bytes()).unwrap();
                    }
                }
                pushed += 1;
                let wf = wc.push(tapped);
                buffer = buffer.max(wc.buffer_bytes());
                if let Some(wf) = wf {
                    replay(wf, &mut rest, &mut eng);
                }
            }
            s += cnt;
        }
        if let Some(wf) = wc.flush() {
            replay(wf, &mut rest, &mut eng);
        }
        // Per cell: Pearson r with the reference trace, and the RMS
        // difference in units of the reference trace's standard deviation.
        let (mut rs, mut es) = (Vec::new(), Vec::new());
        for i in 0..n {
            let a: Vec<f32> = (0..t_len).map(|t| reference[t * n + i]).collect();
            let b: Vec<f32> = (0..t_len).map(|t| got[t * n + i]).collect();
            let mu = a.iter().map(|&v| f64::from(v)).sum::<f64>() / t_len as f64;
            let var = a.iter().map(|&v| (f64::from(v) - mu).powi(2)).sum::<f64>() / t_len as f64;
            if var <= 0.0 {
                continue;
            }
            let mse = a
                .iter()
                .zip(&b)
                .map(|(&x, &y)| f64::from(x - y).powi(2))
                .sum::<f64>()
                / t_len as f64;
            rs.push(pearson(&a, &b));
            es.push((mse / var).sqrt());
        }
        let mut f = std::io::BufWriter::new(
            File::create(out_dir.join(format!("traces_compress_{tap}_{window}.f32"))).unwrap(),
        );
        write_f32s(&mut f, &got);
        let per_frame = bytes as f64 / t_len as f64;
        let line = format!(
            "{tap}\t{}\t{t_len}\t{window}\t{:.1}\t{:.1}\t{:.0}\t{:.4}\t{:.0}\t{:.1}\t{:.2}\t{:.2}\t{pass2_ms:.2}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\n",
            rs.len(),
            rank_sum / windows.max(1) as f64,
            svd_rank / windows.max(1) as f64,
            buffer as f64 / 1048576.0,
            e_kept / e_all.max(1e-300),
            per_frame,
            n_px as f64 / per_frame,
            t_comp * 1e3 / t_len as f64,
            t_replay * 1e3 / t_len as f64,
            quantile(&rs, 0.5),
            quantile(&rs, 0.1),
            quantile(&es, 0.5),
            quantile(&es, 0.9),
        );
        print!("compress {line}");
        report.push_str(&line);
    }
    std::fs::write(out_dir.join("compress.tsv"), report).unwrap();
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
    let compress_windows: Vec<usize> = arg_value(&args, "--compress-window")
        .map_or(Vec::new(), |s| {
            s.split(',').map(|v| v.parse().unwrap()).collect()
        });
    let compress_taps: Vec<String> = arg_value(&args, "--compress-taps")
        .unwrap_or("final,front,raw".into())
        .split(',')
        .map(str::to_string)
        .collect();
    let compress_dump = args.iter().any(|a| a == "--compress-dump");
    let seed_at: u32 = arg_value(&args, "--seed-at").map_or(u32::MAX, |s| s.parse().unwrap());
    let seed_fps: Vec<Footprint> = arg_value(&args, "--seed-file").map_or(Vec::new(), |p| {
        let b = std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e}"));
        assert_eq!(&b[..8], b"CALASEED", "not a seed file");
        let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
        let n = u(8);
        let mut at = 12;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let (id, y0, x0, h, w) = (u(at), u(at + 4), u(at + 8), u(at + 12), u(at + 16));
            at += 20;
            let values: Vec<f32> = b[at..at + 4 * h * w]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
                .collect();
            at += 4 * h * w;
            out.push(Footprint {
                id: id as u64,
                y0,
                x0,
                height: h,
                width: w,
                values,
            });
        }
        println!("seed file: {n} footprints, applied at frame {seed_at}");
        out
    });
    let compress_threads: usize = arg_value(&args, "--compress-threads").map_or(
        std::thread::available_parallelism().map_or(1, |v| v.get()),
        |s| s.parse().unwrap(),
    );
    let budget: u64 = arg_value(&args, "--budget").map_or(30_000_000, |s| s.parse().unwrap());
    let start: u32 = arg_value(&args, "--start").map_or(50, |s| s.parse().unwrap());
    let n_checkpoints: u32 = arg_value(&args, "--checkpoints").map_or(10, |s| s.parse().unwrap());
    let fps: f32 = arg_value(&args, "--fps").map_or(20.0, |s| s.parse().unwrap());
    assert!(
        fps.is_finite() && fps > 0.0,
        "--fps must be positive and finite"
    );
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
    let v1 = args.iter().any(|a| a == "--v1");
    if v1 || args.iter().any(|a| a == "--no-prune") {
        scfg.prune = false;
    }
    if v1 || args.iter().any(|a| a == "--no-pretest") {
        scfg.pretest = false;
    }
    if let Some(v) = arg_value(&args, "--probation") {
        scfg.probation_frames = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--keep-z") {
        scfg.keep_z = v.parse().unwrap();
    }
    if args.iter().any(|a| a == "--no-compare") {
        scfg.compare = false;
    }
    if args.iter().any(|a| a == "--no-stats") {
        scfg.stats_half_life_frames = 0.0;
    }
    if let Some(v) = arg_value(&args, "--split-every") {
        scfg.split_every_visits = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--refine-z") {
        scfg.refine_z = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--stats-snr") {
        scfg.stats_min_snr = v.parse().unwrap();
    }
    if args.iter().any(|a| a == "--no-noise-corr") {
        scfg.noise_corr = false;
    }
    if args.iter().any(|a| a == "--no-shift-nuisance") {
        scfg.shift_nuisance = false;
    }
    if args.iter().any(|a| a == "--no-merge-refit") {
        scfg.merge_refit_pair = false;
    }
    if let Some(v) = arg_value(&args, "--refit-min-share") {
        scfg.merge_refit_min_share = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--merge-z") {
        scfg.merge_z = v.parse().unwrap();
    }
    if let Some(v) = arg_value(&args, "--weak-share") {
        scfg.merge_weak_share = v.parse().unwrap();
    }

    let avi_dir = if sim {
        input.join("daq/Miniscope")
    } else {
        input.clone()
    };
    let mut rec = Recording::open(&avi_dir);
    let dims = rec.dims;
    let n_px = dims.pixels();
    let oracle = sim.then(|| read_oracle(&input.join("oracle.bin")));
    let mut frames = arg_value(&args, "--frames")
        .map_or(rec.total, |s| s.parse().unwrap())
        .min(rec.total);
    if let Some(o) = &oracle {
        assert_eq!(o.dims, dims);
        frames = frames.min(o.n_frames as u32);
    }
    let t_len = frames as usize;
    let cfg = PreprocessConfig::for_fps(fps);
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
    let mut evolution = EvolutionWriter::new(&out_dir, dims);
    evolution.capture(0, 0, engine.library());
    std::fs::write(out_dir.join("run.txt"), format!("args: {args:?}\ninput: {}\nwidth: {}\nheight: {}\nframes: {frames}\nfps: {fps}\nslow_start_recording_frame: {start}\nconfig: {scfg:#?}\n", input.display(), dims.width, dims.height)).unwrap();
    std::fs::write(out_dir.join("diagnostics-format.txt"), r#"All binary integers/floats little-endian. Full fp_*.bin checkpoints and footprints.bin use CALAFP01.
footprint_history.bin: CALAFPH1, u32 H,W; repeated records u64 observed_frames,version,id; u32 n; u32 pixels[n]; f32 raw[n]; f32 filtered[n]. Append only changed/new cells at each published version (including final). Records are sparse, not full-frame images. Ignore a truncated trailing record after interruption.
library_versions.tsv: full ID membership in slot order per publication, comma-separated IDs; removed_ids explicit. Initial empty library at observed_frames=0. Join history by version/id, carry unchanged cells forward, drop removed IDs. Membership row is flushed after its history records.
Frames: observed_frames counts consumed recording frames (1-based); edits.frame is slow-loop observed count starting at 1; edits.recording_frame is zero-based recording frame where drained; absolute decision frame = slow_start_recording_frame + edits.frame - 1. visible_version is the library visible after that step; an edit can remain pending until a later publication.
Accepted edits and margins are public-API decisions. Rejected proposal details and unpublished intermediate footprints are unavailable. Multiple decisions between publishes share the same publication-level before/after; no extra publishes are forced. Add/merge/split lineage and deleted cells are preserved, including the final partial interval.
Full fp_NNNNNN.bin files are periodic full-library snapshots; final snapshot includes finalize. --checkpoints bounds their count approximately (integer spacing can add one); these libraries remain in RAM for optional GT evaluation. Evolution streaming retains only one additional previous library and no movie frames. Disk footprint history scales with changed sparse support; membership TSV scales with published versions times cell count, not movie pixels.
timings.tsv: zero-based recording frame; ms for preprocessing+motion, spatial diagnostics, fast solve, observe, slow step, library swap, ledger dumping, evolution capture; per-frame work counter deltas for load/keep/split/refine/merge/add/running stats. Step timing excludes ledger dumping and swapping. No wall timing within individual private slow-loop stages; work deltas are an operation-count proxy, not milliseconds.
"#).unwrap();
    let mut timings = std::io::BufWriter::new(File::create(out_dir.join("timings.tsv")).unwrap());
    writeln!(timings, "frame\tpre_ms\tspatial_diag_ms\tfast_ms\tobserve_ms\tstep_ms\tswap_ms\tledger_ms\tevolution_ms\twork_load\twork_keep\twork_split\twork_refine\twork_merge\twork_add\twork_stats").unwrap();
    let mut read_timings =
        std::io::BufWriter::new(File::create(out_dir.join("read_timings.tsv")).unwrap());
    writeln!(read_timings, "start_frame\tframes\tread_ms").unwrap();
    let mut slow: Option<SlowLoop> = None;
    let mut y = vec![0.0f32; n_px];
    let mut maxproj = vec![f32::MIN; n_px];
    let (mut t_pre, mut t_fast, mut t_obs, mut t_step) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut step_ms: Vec<f64> = Vec::with_capacity(t_len);
    let mut checkpoints: Vec<(usize, Arc<Library>)> = Vec::new();
    let every = (t_len as u32 / n_checkpoints.max(1)).max(1) as usize;
    let mut curve = File::create(out_dir.join("curve.tsv")).unwrap();
    writeln!(
        curve,
        "frame\tcells\tpublished\tadds\tmerges\trefines\trejects\tvisits\tcommits\treservoir_mb\tdeletes\tpretest_rejects\testablished\tabsorbs\tsplits"
    )
    .unwrap();
    let mut deleted_log: Vec<DeletedCell> = Vec::new();
    let mut edits = std::io::BufWriter::new(File::create(out_dir.join("edits.tsv")).unwrap());
    writeln!(
        edits,
        "frame\tkind\tid\tother\tcy\tcx\tmargin\trecording_frame\tvisible_version"
    )
    .unwrap();
    let mut ldump = args
        .iter()
        .any(|a| a == "--dump-ledger")
        .then(|| std::io::BufWriter::new(File::create(out_dir.join("ledger.bin")).unwrap()));
    let mut flog = std::io::BufWriter::new(File::create(out_dir.join("frames1.tsv")).unwrap());
    writeln!(flog, "frame\tdy\tdx\tnr_rms\tdvar\trho_x\trho_y\trho_xy").unwrap();
    let mut yprev = vec![0.0f32; n_px];
    let mut s = 0u32;
    let t_all = Instant::now();
    while s < frames {
        let cnt = 64.min(frames - s);
        let read_start = Instant::now();
        let raw = rec.read(s, cnt);
        writeln!(
            read_timings,
            "{s}\t{cnt}\t{:.6}",
            read_start.elapsed().as_secs_f64() * 1e3
        )
        .unwrap();
        for (k, f) in raw.chunks_exact(n_px).enumerate() {
            let t = s as usize + k;
            let t0 = Instant::now();
            pipe.frame(f, &mut y);
            let t1 = Instant::now();
            {
                // Spatial correlation of the frame-to-frame difference (mostly
                // noise): lag (0,1), (1,0), (1,1), robust to the FOV edge.
                let w = dims.width;
                let (mut s0, mut sx, mut sy, mut sd, mut n) =
                    (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0u64);
                for yy in 8..dims.height - 8 {
                    for xx in 8..w - 8 {
                        let p = yy * w + xx;
                        if fov[p] == 0 || fov[p + w + 1] == 0 {
                            continue;
                        }
                        let d = |q: usize| f64::from(y[q] - yprev[q]);
                        let d0 = d(p);
                        s0 += d0 * d0;
                        sx += d0 * d(p + 1);
                        sy += d0 * d(p + w);
                        sd += d0 * d(p + w + 1);
                        n += 1;
                    }
                }
                yprev.copy_from_slice(&y);
                writeln!(
                    flog,
                    "{t}\t{:.3}\t{:.3}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{:.4}",
                    pipe.last.0,
                    pipe.last.1,
                    pipe.last.2,
                    s0 / n.max(1) as f64,
                    sx / s0.max(1e-12),
                    sy / s0.max(1e-12),
                    sd / s0.max(1e-12)
                )
                .unwrap();
            }
            // Spatial diagnostics are recorded separately from fast-loop time.
            let t1b = Instant::now();
            let tr = engine.process(&y).unwrap();
            let t2 = Instant::now();
            t_pre += (t1 - t0).as_secs_f64();
            t_fast += (t2 - t1b).as_secs_f64();
            for (m, &v) in maxproj.iter_mut().zip(&y) {
                *m = m.max(v);
            }
            if t == start as usize {
                slow = Some(
                    SlowLoop::new(
                        dims,
                        fov.clone(),
                        pipe.pre.noise().sigma(),
                        flat.clone(),
                        scfg.clone(),
                    )
                    .unwrap(),
                );
            }
            let mut profile = [0.0f64; 5];
            let mut work_delta = [0u64; 7];
            if let Some(sl) = slow.as_mut() {
                if t == seed_at as usize && !seed_fps.is_empty() {
                    let kept = sl.seed(&seed_fps).unwrap();
                    println!("frame {t}: seeded {kept} of {} footprints", seed_fps.len());
                }
                let before = sl.stats();
                if t.is_multiple_of(200) {
                    sl.set_noise(pipe.pre.noise().sigma()).unwrap();
                }
                let lib = engine.library().clone();
                let a = Instant::now();
                sl.observe(&y, &lib, &tr).unwrap();
                let b = Instant::now();
                if let Some(f) = ldump.as_mut() {
                    for (id, u, b, sc) in sl.debug_ledger() {
                        f.write_all(&(t as u32).to_le_bytes()).unwrap();
                        f.write_all(&(id as u32).to_le_bytes()).unwrap();
                        write_f32s(f, &[u, b, sc]);
                    }
                }
                let step_start = Instant::now();
                let published = sl.step(budget).unwrap();
                let c = Instant::now();
                if let Some(l) = published {
                    engine.set_library(l).unwrap();
                }
                let swap_end = Instant::now();
                evolution.capture(t + 1, sl.frames(), engine.library());
                let capture_end = Instant::now();
                profile = [
                    (b - a).as_secs_f64() * 1e3,
                    (c - step_start).as_secs_f64() * 1e3,
                    (swap_end - c).as_secs_f64() * 1e3,
                    (step_start - b).as_secs_f64() * 1e3,
                    (capture_end - swap_end).as_secs_f64() * 1e3,
                ];
                let after = sl.stats();
                work_delta = [
                    after.work_load - before.work_load,
                    after.work_keep - before.work_keep,
                    after.work_split - before.work_split,
                    after.work_refine - before.work_refine,
                    after.work_merge - before.work_merge,
                    after.work_add - before.work_add,
                    after.work_stats - before.work_stats,
                ];
                drain_edits(sl, &mut edits, t, engine.library().version());
                deleted_log.extend(sl.take_deleted());
                t_obs += (b - a).as_secs_f64();
                t_step += (c - step_start).as_secs_f64();
                step_ms.push((c - step_start).as_secs_f64() * 1e3);
                if (t + 1).is_multiple_of(100) {
                    let st = sl.stats();
                    let est = sl
                        .cell_infos()
                        .iter()
                        .filter(|c| c.status == CellStatus::Established)
                        .count();
                    writeln!(
                        curve,
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.1}\t{}\t{}\t{est}\t{}\t{}",
                        t + 1,
                        sl.len(),
                        engine.library().len(),
                        st.adds,
                        st.merges,
                        st.refines,
                        st.rejects,
                        st.visits,
                        st.commits,
                        sl.reservoir_bytes() as f64 / 1048576.0,
                        st.deletes,
                        st.pretest_rejects,
                        st.absorbs,
                        st.splits
                    )
                    .unwrap();
                }
                if (t + 1).is_multiple_of(600) {
                    println!(
                        "  frame {}: {} cells ({} published), noise rho {:.2}, {:?}, {:.0} s",
                        t + 1,
                        sl.len(),
                        engine.library().len(),
                        sl.noise_inflation(),
                        sl.stats(),
                        t_all.elapsed().as_secs_f64()
                    );
                }
            }
            writeln!(timings, "{t}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{}\t{}\t{}\t{}\t{}\t{}\t{}", (t1-t0).as_secs_f64()*1e3, (t1b-t1).as_secs_f64()*1e3, (t2-t1b).as_secs_f64()*1e3, profile[0], profile[1], profile[2], profile[3], profile[4], work_delta[0], work_delta[1], work_delta[2], work_delta[3], work_delta[4], work_delta[5], work_delta[6]).unwrap();
            if (t + 1).is_multiple_of(every) || t + 1 == t_len {
                checkpoints.push((t + 1, engine.library().clone()));
            }
        }
        s += cnt;
    }
    let mut sl = slow.expect("slow loop started");
    let finalize_start = Instant::now();
    let lib = sl.finalize().unwrap();
    let finalize_ms = finalize_start.elapsed().as_secs_f64() * 1e3;
    evolution.capture(t_len, sl.frames(), &lib);
    drain_edits(&mut sl, &mut edits, t_len.saturating_sub(1), lib.version());
    edits.flush().unwrap();
    timings.flush().unwrap();
    read_timings.flush().unwrap();
    std::fs::write(
        out_dir.join("finalize_ms.txt"),
        format!("{finalize_ms:.6}\n"),
    )
    .unwrap();
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
        write_footprints(&out_dir.join("footprints.bin"), &lib);
        let mut f = File::create(out_dir.join("maxproj.f32")).unwrap();
        write_f32s(&mut f, &maxproj);
        let mut f = File::create(out_dir.join("births.tsv")).unwrap();
        writeln!(f, "id\tborn").unwrap();
        for (id, b) in sl.births() {
            writeln!(f, "{id}\t{b}").unwrap();
        }
        let mut f = File::create(out_dir.join("ledger.tsv")).unwrap();
        writeln!(
            f,
            "id\tborn\tstatus\tframes\ttransients\tdips\tpeak_z\tcy\tcx\tpasses\tfails"
        )
        .unwrap();
        for c in sl.cell_infos() {
            writeln!(
                f,
                "{}\t{}\t{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{:.1}\t{}\t{}",
                c.id,
                c.born,
                c.status.as_str(),
                c.frames,
                c.transients,
                c.dips,
                c.peak_z,
                c.center.0,
                c.center.1,
                c.passes,
                c.fails
            )
            .unwrap();
        }
        deleted_log.extend(sl.take_deleted());
        let mut f = File::create(out_dir.join("deleted.tsv")).unwrap();
        writeln!(
            f,
            "id\tborn\tdeleted\treason\tframes\ttransients\tdips\tpeak_z\tcy\tcx\tpasses\tfails"
        )
        .unwrap();
        for d in &deleted_log {
            let c = d.info;
            writeln!(
                f,
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.1}\t{:.1}\t{:.1}\t{}\t{}",
                c.id,
                c.born,
                d.frame,
                d.reason.as_str(),
                c.frames,
                c.transients,
                c.dips,
                c.peak_z,
                c.center.0,
                c.center.1,
                c.passes,
                c.fails
            )
            .unwrap();
        }
        for (t, l) in &checkpoints {
            write_footprints(&out_dir.join(format!("fp_{t:06}.bin")), l);
        }
    }

    // ---- pass 2: re-extract every frame with the final library
    let mut traces = vec![0.0f32; if pass2 { t_len * lib.len() } else { 0 }];
    if pass2 {
        let mut pipe = Pipeline::new(&mut rec, pre0.clone(), &cal, motion, 200);
        let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
        let mut s = 0u32;
        let t0 = Instant::now();
        let mut meanimg = vec![0.0f64; n_px];
        let mut finfo = std::io::BufWriter::new(File::create(out_dir.join("frames.tsv")).unwrap());
        writeln!(finfo, "frame\tdy\tdx\tmean").unwrap();
        let n_fov = fov.iter().filter(|&&m| m != 0).count().max(1) as f64;
        while s < frames {
            let cnt = 64.min(frames - s);
            let raw = rec.read(s, cnt);
            for (k, f) in raw.chunks_exact(n_px).enumerate() {
                let t = s as usize + k;
                let (dy, dx) = pipe.frame(f, &mut y);
                let mut m = 0.0f64;
                for ((a, &v), &k) in meanimg.iter_mut().zip(&y).zip(&fov) {
                    if v.is_finite() {
                        *a += f64::from(v);
                        if k != 0 {
                            m += f64::from(v);
                        }
                    }
                }
                writeln!(finfo, "{t}\t{dy}\t{dx}\t{}", m / n_fov).unwrap();
                let r = eng.process(&y).unwrap();
                traces[t * lib.len()..(t + 1) * lib.len()].copy_from_slice(&r.traces);
            }
            s += cnt;
        }
        let pass2_s = t0.elapsed().as_secs_f64();
        println!("pass 2: {t_len} frames in {pass2_s:.1} s");
        if !compress_windows.is_empty() && !lib.is_empty() {
            compress_report(
                &mut rec,
                &pre0,
                &cal,
                motion,
                &lib,
                &traces,
                frames,
                &compress_windows,
                &compress_taps,
                compress_threads,
                compress_dump,
                pass2_s * 1e3 / t_len as f64,
                &out_dir,
            );
        }
        let mut f = std::io::BufWriter::new(File::create(out_dir.join("traces.f32")).unwrap());
        write_f32s(&mut f, &traces);
        let mi: Vec<f32> = meanimg.iter().map(|&v| (v / t_len as f64) as f32).collect();
        let mut f = File::create(out_dir.join("meanimg.f32")).unwrap();
        write_f32s(&mut f, &mi);
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
    let off = if motion {
        best_offset(&lib, &gt_lib, dims, 16)
    } else {
        (0, 0)
    };
    println!(
        "GT units with centre in FOV: {} ({} detectable); offset {:?}",
        kept.len(),
        kept.iter().filter(|&&u| oracle.units[u].detectable).count(),
        off
    );
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
            let (k, peak) =
                v.iter()
                    .enumerate()
                    .fold((0, f32::MIN), |b, (i, &x)| if x > b.1 { (i, x) } else { b });
            f64::from(amp * peak / noise[p[k] as usize].max(1e-6))
        })
        .collect();
    write_footprints(&out_dir.join("gt_footprints.bin"), &gt_lib);
    std::fs::write(
        out_dir.join("gt_offset.tsv"),
        format!("dy\tdx\n{}\t{}\n", off.0, off.1),
    )
    .unwrap();
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
    let mut gt_units = std::io::BufWriter::new(File::create(out_dir.join("gt_units.tsv")).unwrap());
    writeln!(
        gt_units,
        "slot\toracle_id\tdetectable\tin_focus\tcy\tcx\tpeak_snr\tlate\toracle_unit_index"
    )
    .unwrap();
    for (slot, &u) in kept.iter().enumerate() {
        let unit = &oracle.units[u];
        writeln!(
            gt_units,
            "{slot}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{u}",
            unit.full.id,
            unit.detectable,
            unit.in_focus,
            unit.center.0,
            unit.center.1,
            snr[slot],
            late[slot]
        )
        .unwrap();
    }
    gt_units.flush().unwrap();
    let thr = 0.7;
    let mut summary = String::new();
    let mut cp_file = File::create(out_dir.join("checkpoints.tsv")).unwrap();
    writeln!(
        cp_file,
        "frame\tcells\tmatched\trecall\trecall_focus\trecall_snr10\trecall_late\tprecision"
    )
    .unwrap();
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
        let matched_det = mt
            .iter()
            .filter(|m| m.is_some_and(|(j, _)| detectable[j]))
            .count();
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
        let mut unexpl_log =
            String::from("det\tcy\tcx\tnpx\tgt_trace_r\tnb_trace_r\tnb_dist\ttrace_snr\n");
        let mut split_log =
            String::from("det\tmatched_det\tdist\ttrace_r_pair\ttrace_r_gt\tfocus\tsnr\n");
        let mut unexpl_tr: Vec<f64> = Vec::new();
        let mut labels = String::from("slot\tid\tclass\tgt\tr\n");
        for (i, m) in mt.iter().enumerate() {
            let (bj, br) = best[i];
            let cls = match m {
                Some((j, _)) if !detectable[*j] => "nondet",
                Some(_) => "match",
                None if bj != usize::MAX && br >= 0.5 && gt_hit[bj] => "dup",
                None if bj != usize::MAX && br >= thr => "nondet",
                None => "fp",
            };
            let _ = writeln!(
                labels,
                "{i}\t{}\t{cls}\t{}\t{br:.3}",
                l.ids()[i],
                m.map_or(bj as i64, |(j, _)| j as i64)
            );
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
                                    let r = pearson(&tr, c_of(kept[jj]));
                                    if r > b {
                                        b = r;
                                        bj = jj;
                                    }
                                }
                            }
                            unexpl_tr.push(b);
                            {
                                let mut nb = (0.0f64, f32::MAX);
                                for (k, m) in mt.iter().enumerate() {
                                    if m.is_none() {
                                        continue;
                                    }
                                    let ck = centroid(&det[k], dims.width);
                                    let dd = ((ck.0 - ci.0).powi(2) + (ck.1 - ci.1).powi(2)).sqrt();
                                    if dd < 25.0 {
                                        let tk: Vec<f32> =
                                            (0..t_len).map(|t| traces[t * n + k]).collect();
                                        let r = pearson(&tr, &tk);
                                        if r > nb.0 {
                                            nb = (r, dd);
                                        }
                                    }
                                }
                                let mut s: Vec<f32> = tr.clone();
                                s.sort_by(f32::total_cmp);
                                let med = s[s.len() / 2];
                                let mut d: Vec<f32> =
                                    tr.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
                                d.sort_by(f32::total_cmp);
                                let sd = d[d.len() / 2] / 0.6745 / std::f32::consts::SQRT_2;
                                let _ = writeln!(
                                    unexpl_log,
                                    "{i}\t{:.1}\t{:.1}\t{}\t{:.3}\t{:.3}\t{:.1}\t{:.1}",
                                    ci.0,
                                    ci.1,
                                    det[i].len(),
                                    b,
                                    nb.0,
                                    nb.1,
                                    (s[s.len() - 1] - med) / sd.max(1e-9)
                                );
                            }
                            if b >= 0.6 && gt_hit[bj] {
                                unexpl_split += 1;
                                if let Some(k) =
                                    mt.iter().position(|m| m.is_some_and(|(g, _)| g == bj))
                                {
                                    let tk: Vec<f32> =
                                        (0..t_len).map(|t| traces[t * n + k]).collect();
                                    let ck = centroid(&det[k], dims.width);
                                    let _ = writeln!(
                                        split_log,
                                        "{i}\t{k}\t{:.1}\t{:.3}\t{:.3}\t{}\t{:.1}",
                                        ((ck.0 - ci.0).powi(2) + (ck.1 - ci.1).powi(2)).sqrt(),
                                        pearson(&tr, &tk),
                                        b,
                                        focus[bj],
                                        snr[bj]
                                    );
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
        let _ = writeln!(
            summary,
            "precision {:.3} (any GT unit: {:.3})",
            matched_det as f64 / l.len().max(1) as f64,
            (matched_det + nondet) as f64 / l.len().max(1) as f64
        );
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
        std::fs::write(out_dir.join("labels.tsv"), &labels).unwrap();
        // Deleted cells: the nearest GT unit (centre within 5 px), whether
        // it is matched at the end, its SNR.
        let gt_c: Vec<(f32, f32)> = gt_cols.iter().map(|g| centroid(g, dims.width)).collect();
        let mut dl = String::from(
            "id\treason\tdeleted\ttransients\tdips\tpasses\tfails\tgt\tdist\tgt_matched_end\tsnr\n",
        );
        let (mut d_true, mut d_true_lost) = (0, 0);
        for d in &deleted_log {
            let (cy, cx) = (
                d.info.center.0 + off.0 as f32,
                d.info.center.1 + off.1 as f32,
            );
            let (j, dist) = gt_c
                .iter()
                .enumerate()
                .fold((usize::MAX, f32::MAX), |b, (j, c)| {
                    let dd = ((c.0 - cy).powi(2) + (c.1 - cx).powi(2)).sqrt();
                    if dd < b.1 {
                        (j, dd)
                    } else {
                        b
                    }
                });
            let near = dist <= 5.0;
            if near {
                d_true += 1;
                if !gt_hit[j] {
                    d_true_lost += 1;
                }
            }
            let _ = writeln!(
                dl,
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{dist:.1}\t{}\t{:.1}",
                d.info.id,
                d.reason.as_str(),
                d.frame,
                d.info.transients,
                d.info.dips,
                d.info.passes,
                d.info.fails,
                if near { j as i64 } else { -1 },
                near && gt_hit[j],
                if near { snr[j] } else { 0.0 }
            );
        }
        std::fs::write(out_dir.join("deleted_gt.tsv"), &dl).unwrap();
        let _ = writeln!(
            summary,
            "deleted {} cells: {d_true} within 5 px of a GT centre ({d_true_lost} of those GT units unmatched at the end)",
            deleted_log.len()
        );
        let corr_m: Vec<f64> = mt.iter().flatten().map(|m| m.1).collect();
        let _ = writeln!(
            summary,
            "footprint r of matches: median {:.3} p10 {:.3}",
            quantile(&corr_m, 0.5),
            quantile(&corr_m, 0.1)
        );
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
