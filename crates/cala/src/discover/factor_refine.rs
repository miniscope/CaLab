//! Refine on factors (spec §5, phase 3): Refine iterations on the
//! compressed history, with the cell set frozen
//! ([`EditScope::Refine`](super::EditScope::Refine))
//! and the library fixed within an iteration.
//!
//! An iteration reads the factor windows twice. **Pass A** solves each
//! window's traces with the current library ([`FactorExtractor`]) and fills
//! every cell's footprint statistics ([`FpStats`]) from the factors and
//! those traces, over the iteration's fitting frames, with weight 1 (no
//! forgetting: the library does not change). With `ŷ_t(p) = Σ_k b_k(p)
//! (μ_k(p) + W_k(p, :) · v_k(t))` and the cell's own column cancelling its
//! part of the model,
//!
//! ```text
//! Σ c r(p) = Σ c ŷ(p) − Σ_{j≠i} a_j(p) Σ c c_j − Σ_a g_a(p) Σ c β_a − Σ c ℓ
//! Σ r(p)   = Σ ŷ(p)   − Σ_{j≠i} a_j(p) Σ c_j   − Σ_a g_a(p) Σ β_a   − Σ ℓ
//! Σ c ŷ(p) = Σ_W Σ_k b_k(p) (W_k(p, :) · V_kᵀ c + μ_k(p) Σ c)
//! ```
//!
//! (`a_j` the columns as the fast loop models them, `g_a`, `β_a` a basis
//! background, `ℓ` the cell's ring level), and the same over the split
//! half's frames. Only `Σ c ŷ` and `Σ ŷ` read the factors. A pixel whose
//! valid share in a window is below [`MIN_VALID_SHARE`] is left out of that
//! window, as a missing pixel is in the frame route.
//!
//! **Pass B** rebuilds the patches of a few held-out frames per slow-loop
//! tile from the factors; they feed the unchanged refine visit. Accepted
//! refinements are published, and `refine_until_settled` repeats until
//! fewer than `settle_share` of the cells moved by more than `settle_corr`.

// Index loops over cells, tiles and pixels read more clearly here.
#![allow(clippy::needless_range_loop)]

use std::collections::HashMap;
use std::sync::Arc;

use super::fpstats::{add_mom, parity_block, FpStats, Mom, PixMoments, MIN_VALID_SHARE};
use super::local::BgBasis;
use super::reservoir::{decode, mix, quantize, take_missing};
use super::{column_on, Frames, SlowLoop};
use crate::compress::blend::BlendLayout;
use crate::compress::project::{FactorExtractor, WindowProjector};
use crate::compress::WindowFactors;
use crate::preprocess::Dims;
use crate::trace::{BgTerms, Library, SolverConfig, TraceError};

/// A valid share below this (and not below [`MIN_VALID_SHARE`]) marks a
/// pixel whose window mean entered as data (1 up to the blending's rounding).
pub(crate) const LOW_VALID: f32 = 0.999;

/// The stages of an iteration, reported to [`FactorSource::stage`] as they start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefineStage {
    /// Pass A: Extract on factors and the statistics.
    Sums,
    /// Pass B: the held-out patches.
    TestFrames,
    /// The refine visit of every tile.
    Gate,
    /// Publish and measure the change.
    Publish,
    /// The iteration is over.
    Done,
}

/// The compressed history a factor Refine reads: the windows of one
/// recording in frame order, from frame 0. Each window is read twice per
/// iteration.
pub trait FactorSource {
    fn windows(&self) -> usize;
    /// Window `w` (`0..windows()`).
    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError>;
    /// Called as an iteration enters `stage` (for the caller's timing).
    fn stage(&mut self, _stage: RefineStage) {}
}

impl FactorSource for Vec<WindowFactors> {
    fn windows(&self) -> usize {
        self.len()
    }

    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError> {
        self.get(w)
            .cloned()
            .ok_or_else(|| TraceError::InvalidConfig(format!("no factor window {w}")))
    }
}

/// Settings of Refine on factors (spec §5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FactorRefineConfig {
    /// A cell has settled when its footprint correlates at least this much
    /// with its footprint of the previous iteration.
    pub settle_corr: f32,
    /// The run has settled when fewer than this share of the cells have not.
    pub settle_share: f32,
    /// At most this many iterations.
    pub max_iterations: usize,
    /// Held-out frames per slow-loop tile for the gate; 0: what a tile's
    /// reservoir holds on average (`frames_per_tile / holdout_every`).
    pub test_frames: usize,
    /// The trace solver of the iteration's Extract.
    pub solver: SolverConfig,
}

impl Default for FactorRefineConfig {
    fn default() -> FactorRefineConfig {
        FactorRefineConfig {
            settle_corr: 0.99,
            settle_share: 0.02,
            max_iterations: 20,
            test_frames: 0,
            solver: SolverConfig::default(),
        }
    }
}

impl FactorRefineConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        let ok = self.settle_corr > 0.0
            && self.settle_corr <= 1.0
            && (0.0..=1.0).contains(&self.settle_share)
            && self.max_iterations >= 1;
        if ok {
            self.solver.validate()
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}

/// Trace sums of one cell over a set of fitting frames, `[full, half]`.
#[derive(Debug, Clone)]
struct WinSums {
    /// `[Σ w, Σ w², Σ c, Σ c²]` (w = 1).
    mom: [[f64; 4]; 2],
    /// `Σ c c_j` for the neighbours `j`.
    g: [Vec<f64>; 2],
    /// `Σ c ℓ` and `Σ ℓ` (the ring level; 0 without a ring).
    lc: [f64; 2],
    l1: [f64; 2],
    /// `Σ c β_a` per basis map.
    bc: [Vec<f64>; 2],
}

impl WinSums {
    fn new(nb: usize, k: usize) -> WinSums {
        WinSums {
            mom: [[0.0; 4]; 2],
            g: [vec![0.0; nb], vec![0.0; nb]],
            lc: [0.0; 2],
            l1: [0.0; 2],
            bc: [vec![0.0; k], vec![0.0; k]],
        }
    }

    fn add(&mut self, o: &WinSums) {
        for h in 0..2 {
            for j in 0..4 {
                self.mom[h][j] += o.mom[h][j];
            }
            for (a, b) in self.g[h].iter_mut().zip(&o.g[h]) {
                *a += b;
            }
            for (a, b) in self.bc[h].iter_mut().zip(&o.bc[h]) {
                *a += b;
            }
            self.lc[h] += o.lc[h];
            self.l1[h] += o.l1[h];
        }
    }
}

/// A window in which some of a cell's disk pixels were left out: those
/// pixels (indices into the disk), the cell's trace sums over the window,
/// and the window's `Σ c_j` (for the neighbours) and `Σ β_a`.
#[derive(Debug, Clone)]
struct Excluded {
    px: Vec<usize>,
    sums: WinSums,
    s: [Vec<f64>; 2],
    b1: [Vec<f64>; 2],
}

/// One cell's part of pass A.
#[derive(Debug, Clone)]
struct CellPass {
    /// Disk, classes, column and version set; the sums are written by `install`.
    st: FpStats,
    /// `[x0, y0, x1, y1)` around the disk.
    bx: [usize; 4],
    /// Slots of the other cells whose column can reach the disk.
    nb: Vec<usize>,
    /// `Σ c ŷ(p)` per disk pixel, `[full, half]`.
    dc: [Vec<f64>; 2],
    /// The class moments as `FpStats::push` adds them, `[full, half]`.
    m: [Mom; 2],
    tot: WinSums,
    excl: Vec<Excluded>,
    /// Smallest valid share of a disk pixel in any window.
    min_valid: f32,
}

/// What pass A gives.
struct Pass {
    cells: Vec<CellPass>,
    /// `Σ ŷ(p)` per frame pixel, `[full, half]`.
    d: [Vec<f64>; 2],
    /// `Σ c_j` per slot and `Σ β_a` per basis map, `[full, half]`.
    s: [Vec<f64>; 2],
    b1: [Vec<f64>; 2],
    /// Per slow-loop tile: its held-out frames, `(activity, frame, slow-loop index)`.
    scores: Vec<Vec<(f32, usize, u64)>>,
    /// Per slow-loop tile: whether a cell's centre lies in its core.
    has_cells: Vec<bool>,
    frames: usize,
    fitting: u64,
}

/// The held-out patches of one slow-loop tile, stored as the reservoir
/// stores a slot (quantised whitened values, [`MISSING`](super::reservoir::MISSING)
/// for a missing pixel), so the gate reads the values a raw pass would.
#[derive(Debug, Clone, Default)]
struct TestTile {
    data: Vec<Vec<i16>>,
    /// Background projections and energy of each decoded patch.
    proj: Vec<(Vec<f64>, f64)>,
    /// Slow-loop frame index of each.
    idx: Vec<u64>,
}

impl TestTile {
    fn len(&self) -> usize {
        self.data.len()
    }

    /// The patches decoded into the form the refine visit reads.
    fn frames(&self) -> Frames {
        let (y, miss) = self.data.iter().map(|d| decode_patch(d)).unzip();
        Frames {
            y,
            proj: self.proj.clone(),
            idx: self.idx.clone(),
            miss,
        }
    }
}

/// A stored patch decoded as `load` decodes a slot: values in σ units, a
/// missing pixel 0 and listed.
fn decode_patch(data: &[i16]) -> (Vec<f32>, Vec<u32>) {
    let mut v: Vec<f32> = data.iter().map(|&q| decode(q)).collect();
    let miss = take_missing(&mut v);
    (v, miss)
}

/// Per frame pixel: the blended share of the window's frames in which it
/// was not missing, `Σ_k b_k(p) valid_k(p)`.
fn valid_map(wf: &WindowFactors, layout: &BlendLayout) -> Vec<f32> {
    let width = wf.dims.width;
    let mut v = vec![0.0f32; wf.dims.pixels()];
    for (tf, wt) in wf.tiles.iter().zip(layout.weights()) {
        for y in 0..tf.h {
            for x in 0..tf.w {
                let p = y * tf.w + x;
                v[(tf.y0 + y) * width + tf.x0 + x] += wt[p] * tf.valid[p];
            }
        }
    }
    v
}

/// The window `wf` is the next one of a recording of frame size `dims`, at
/// frame `start`, and its tiles are those of its layout with arrays of the
/// right lengths.
fn check_window(wf: &WindowFactors, dims: Dims, start: usize) -> Result<(), TraceError> {
    if wf.dims != dims {
        return Err(TraceError::Incompatible(format!(
            "factors of {:?}, slow loop of {:?}",
            wf.dims, dims
        )));
    }
    if wf.frames == 0 || wf.start != start as u64 {
        return Err(TraceError::InvalidConfig(format!(
            "a window of {} frames at frame {}, expected one at {start}",
            wf.frames, wf.start
        )));
    }
    let layout = wf.layout();
    let fits = layout.grid().len() == wf.tiles.len()
        && layout.grid().iter().zip(&wf.tiles).all(|(g, t)| {
            let px = t.w * t.h;
            *g == (t.x0, t.y0, t.w, t.h)
                && t.spatial.len() == px * t.rank
                && t.temporal.len() == wf.frames * t.rank
                && t.mean.len() == px
                && t.valid.len() == px
        });
    if !fits {
        return Err(TraceError::InvalidConfig(
            "the tiles of the factors do not fit their layout".into(),
        ));
    }
    // A non-finite factor would spread into every sum it touches.
    for (k, t) in wf.tiles.iter().enumerate() {
        let arrays = [&t.mean, &t.spatial, &t.temporal, &t.valid];
        if arrays.iter().any(|a| a.iter().any(|v| !v.is_finite())) {
            return Err(TraceError::InvalidConfig(format!(
                "the factor window at frame {}: tile {k} holds a non-finite value",
                wf.start
            )));
        }
    }
    Ok(())
}

/// `[x0, y0, x1, y1)` around pixels `pix` (no pixel: a box that meets nothing).
fn pixel_box(pix: &[u32], width: usize) -> [usize; 4] {
    let mut b = [usize::MAX, usize::MAX, 0, 0];
    for &q in pix {
        let (y, x) = (q as usize / width, q as usize % width);
        b = [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)];
    }
    b
}

/// The box of cell `j`'s column as the fast loop models it: its support and
/// its moat's blocks.
fn column_box(lib: &Library, j: usize, width: usize, height: usize) -> [usize; 4] {
    let mut b = pixel_box(lib.core_col(j).0, width);
    let bs = lib.block_px();
    if bs > 0 {
        let gw = width.div_ceil(bs);
        for &blk in lib.lowpass(j).0 {
            let (by, bx) = (blk as usize / gw, blk as usize % gw);
            b = [
                b[0].min(bx * bs),
                b[1].min(by * bs),
                b[2].max(((bx + 1) * bs).min(width)),
                b[3].max(((by + 1) * bs).min(height)),
            ];
        }
    }
    b
}

fn boxes_meet(a: &[usize; 4], b: &[usize; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// Whether box `a` meets the tile `g = (x0, y0, w, h)`.
fn meets(a: &[usize; 4], g: (usize, usize, usize, usize)) -> bool {
    a[0] < g.0 + g.2 && g.0 < a[2] && a[1] < g.1 + g.3 && g.1 < a[3]
}

impl SlowLoop {
    /// Pass A of an iteration (see the module docs): Extract on factors with
    /// `lib`, and every cell's statistics sums. Reads the loop, changes nothing.
    fn sum_pass(
        &self,
        lib: &Arc<Library>,
        src: &mut dyn FactorSource,
        cfg: &FactorRefineConfig,
    ) -> Result<Pass, TraceError> {
        let dims = self.dims;
        if lib.dims() != dims {
            return Err(TraceError::Incompatible(
                "library of another frame size".into(),
            ));
        }
        let (width, height, n_px) = (dims.width, dims.height, dims.pixels());
        let n = lib.len();
        let margin = self.cfg.stats_margin_cells * self.cfg.cell_diameter_px;
        let blk = parity_block(self.cfg.cell_diameter_px);
        let k_bg = match &lib.bg {
            BgTerms::Basis { k, .. } => *k,
            _ => 0,
        };
        let ring = matches!(lib.bg, BgTerms::Ring { .. });
        let nbg = lib.background_len();
        let noise = lib.trace_noise();

        // Every cell's disk, as `update_fpstats` creates it for this library.
        let col_box: Vec<[usize; 4]> = (0..n).map(|j| column_box(lib, j, width, height)).collect();
        let mut cells: Vec<CellPass> = (0..n)
            .map(|i| {
                let (center, radius) = lib.support(i);
                let mut st = FpStats::new(
                    center,
                    radius + margin,
                    width,
                    height,
                    &self.fov,
                    false,
                    blk,
                );
                st.col = column_on(lib, i, &st.pix);
                st.version = lib.version();
                let bx = pixel_box(&st.pix, width);
                let len = st.pix.len();
                CellPass {
                    st,
                    bx,
                    nb: Vec::new(),
                    dc: [vec![0.0; len], vec![0.0; len]],
                    m: [[0.0; 6]; 2],
                    tot: WinSums::new(0, k_bg),
                    excl: Vec::new(),
                    min_valid: 1.0,
                }
            })
            .collect();
        for i in 0..n {
            let nb: Vec<usize> = (0..n)
                .filter(|&j| j != i && boxes_meet(&col_box[j], &cells[i].bx))
                .collect();
            cells[i].tot = WinSums::new(nb.len(), k_bg);
            cells[i].nb = nb;
        }
        // The cells each slow-loop tile refines (centre in its core).
        let mut core_cells: Vec<Vec<usize>> = vec![Vec::new(); self.tiles.len()];
        for i in 0..n {
            let (c, _) = lib.support(i);
            if let Some(ti) = self.tile_of(c.0, c.1) {
                core_cells[ti].push(i);
            }
        }

        let mut ex = FactorExtractor::new(lib.clone(), cfg.solver)?;
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let base = self.frames;
        let mut pass = Pass {
            cells: Vec::new(),
            d: [vec![0.0; n_px], vec![0.0; n_px]],
            s: [vec![0.0; n], vec![0.0; n]],
            b1: [vec![0.0; k_bg], vec![0.0; k_bg]],
            scores: vec![Vec::new(); self.tiles.len()],
            has_cells: core_cells.iter().map(|c| !c.is_empty()).collect(),
            frames: 0,
            fitting: 0,
        };
        let (mut cw, mut bw): (Vec<f32>, Vec<f32>) = (Vec::new(), Vec::new());
        for w in 0..src.windows() {
            let wf = src.window(w)?;
            check_window(&wf, dims, pass.frames)?;
            let proj = WindowProjector::new(lib, &wf)?;
            cw.clear();
            bw.clear();
            ex.solve(&wf, &proj, 0, wf.frames, |tr| {
                cw.extend_from_slice(&tr.traces);
                bw.extend_from_slice(&tr.background);
            })?;
            let frames = wf.frames;
            if cw.len() != frames * n || bw.len() != frames * nbg {
                return Err(TraceError::InvalidConfig(format!(
                    "window {w}: the solve skipped frames"
                )));
            }
            if let Some(v) = cw.iter().chain(&bw).find(|v| !v.is_finite()) {
                return Err(TraceError::InvalidConfig(format!(
                    "window {w}: a non-finite trace ({v})"
                )));
            }

            // The held-out split (the slow loop's hash of its frame index) and
            // the split half (alternate 256-frame blocks of the fitting frames).
            let (mut fit, mut half) = (vec![false; frames], vec![false; frames]);
            for t in 0..frames {
                let slow = base + (pass.frames + t) as u64;
                if self.cfg.is_test(slow) {
                    for (ti, cs) in core_cells.iter().enumerate() {
                        if cs.is_empty() {
                            continue;
                        }
                        let a: f32 = cs
                            .iter()
                            .map(|&i| {
                                let z = cw[t * n + i].max(0.0) / noise[i].max(1e-12);
                                z * z
                            })
                            .sum();
                        pass.scores[ti].push((a, pass.frames + t, slow));
                    }
                } else {
                    fit[t] = true;
                    half[t] = (pass.fitting / 256).is_multiple_of(2);
                    pass.fitting += 1;
                }
            }
            let layout = wf.layout();
            let vmap = valid_map(&wf, &layout);

            // Trace sums of the window.
            let mut win: Vec<WinSums> = cells
                .iter()
                .map(|c| WinSums::new(c.nb.len(), k_bg))
                .collect();
            let mut ws = [vec![0.0f64; n], vec![0.0f64; n]];
            let mut wb = [vec![0.0f64; k_bg], vec![0.0f64; k_bg]];
            for t in 0..frames {
                if !fit[t] {
                    continue;
                }
                let c = &cw[t * n..(t + 1) * n];
                let bg = &bw[t * nbg..(t + 1) * nbg];
                let hs = 1 + usize::from(half[t]);
                for h in 0..hs {
                    for (o, &x) in ws[h].iter_mut().zip(c) {
                        *o += f64::from(x);
                    }
                    if k_bg > 0 {
                        for (o, &x) in wb[h].iter_mut().zip(bg) {
                            *o += f64::from(x);
                        }
                    }
                }
                for (i, cp) in cells.iter_mut().enumerate() {
                    let ci = f64::from(c[i]);
                    // As `FpStats::push` adds them (w = 1, z = x = c).
                    add_mom(&mut cp.m[0], 1.0, ci, ci);
                    if half[t] {
                        add_mom(&mut cp.m[1], 1.0, ci, ci);
                    }
                    let lv = if ring { f64::from(bg[i]) } else { 0.0 };
                    let s = &mut win[i];
                    for h in 0..hs {
                        s.mom[h][0] += 1.0;
                        s.mom[h][1] += 1.0;
                        s.mom[h][2] += ci;
                        s.mom[h][3] += ci * ci;
                        s.lc[h] += ci * lv;
                        s.l1[h] += lv;
                        if ci != 0.0 {
                            for (o, &j) in s.g[h].iter_mut().zip(&cp.nb) {
                                *o += ci * f64::from(c[j]);
                            }
                            if k_bg > 0 {
                                for (o, &x) in s.bc[h].iter_mut().zip(bg) {
                                    *o += ci * f64::from(x);
                                }
                            }
                        }
                    }
                }
            }

            // Data sums: per tile the time sums of its temporal factors,
            // then one row per pixel (shared), and per cell under the tile.
            for (tf, wt) in wf.tiles.iter().zip(layout.weights()) {
                let r = tf.rank;
                let g = (tf.x0, tf.y0, tf.w, tf.h);
                let mut u = [vec![0.0f64; r], vec![0.0f64; r]];
                let mut cnt = [0.0f64; 2];
                for t in 0..frames {
                    if !fit[t] {
                        continue;
                    }
                    let v = &tf.temporal[t * r..(t + 1) * r];
                    for h in 0..1 + usize::from(half[t]) {
                        cnt[h] += 1.0;
                        for (o, &x) in u[h].iter_mut().zip(v) {
                            *o += f64::from(x);
                        }
                    }
                }
                for y in 0..tf.h {
                    for x in 0..tf.w {
                        let q = (tf.y0 + y) * width + tf.x0 + x;
                        if vmap[q] < MIN_VALID_SHARE as f32 {
                            continue;
                        }
                        let p = y * tf.w + x;
                        let row = &tf.spatial[p * r..(p + 1) * r];
                        let (b, mu) = (f64::from(wt[p]), f64::from(tf.mean[p]));
                        for h in 0..2 {
                            let s: f64 =
                                row.iter().zip(&u[h]).map(|(&a, &c)| f64::from(a) * c).sum();
                            pass.d[h][q] += b * (s + mu * cnt[h]);
                        }
                    }
                }
                for (slot, cp) in cells.iter_mut().enumerate() {
                    if !meets(&cp.bx, g) {
                        continue;
                    }
                    let mut uc = [vec![0.0f64; r], vec![0.0f64; r]];
                    let mut sc = [0.0f64; 2];
                    for t in 0..frames {
                        let c = f64::from(cw[t * n + slot]);
                        if !fit[t] || c == 0.0 {
                            continue;
                        }
                        let v = &tf.temporal[t * r..(t + 1) * r];
                        for h in 0..1 + usize::from(half[t]) {
                            sc[h] += c;
                            for (o, &x) in uc[h].iter_mut().zip(v) {
                                *o += c * f64::from(x);
                            }
                        }
                    }
                    for (i, &pg) in cp.st.pix.iter().enumerate() {
                        let (py, px) = (pg as usize / width, pg as usize % width);
                        let inside = px >= g.0 && px < g.0 + g.2 && py >= g.1 && py < g.1 + g.3;
                        if !inside || vmap[pg as usize] < MIN_VALID_SHARE as f32 {
                            continue;
                        }
                        let p = (py - g.1) * g.2 + (px - g.0);
                        let row = &tf.spatial[p * r..(p + 1) * r];
                        let (b, mu) = (f64::from(wt[p]), f64::from(tf.mean[p]));
                        for h in 0..2 {
                            let s: f64 = row
                                .iter()
                                .zip(&uc[h])
                                .map(|(&a, &c)| f64::from(a) * c)
                                .sum();
                            cp.dc[h][i] += b * (s + mu * sc[h]);
                        }
                    }
                }
            }

            // Pixels left out of this window, and the totals.
            for (i, cp) in cells.iter_mut().enumerate() {
                let mut px = Vec::new();
                for (q, &p) in cp.st.pix.iter().enumerate() {
                    let v = vmap[p as usize];
                    cp.min_valid = cp.min_valid.min(v);
                    if v < MIN_VALID_SHARE as f32 {
                        px.push(q);
                    }
                }
                cp.tot.add(&win[i]);
                if !px.is_empty() {
                    let s = [0, 1].map(|h| cp.nb.iter().map(|&j| ws[h][j]).collect::<Vec<f64>>());
                    cp.excl.push(Excluded {
                        px,
                        sums: win[i].clone(),
                        s,
                        b1: wb.clone(),
                    });
                }
            }
            for h in 0..2 {
                for (o, x) in pass.s[h].iter_mut().zip(&ws[h]) {
                    *o += x;
                }
                for (o, x) in pass.b1[h].iter_mut().zip(&wb[h]) {
                    *o += x;
                }
            }
            pass.frames += frames;
        }
        // Without a fitting frame `install` would replace every cell's
        // statistics with empty ones.
        if pass.fitting == 0 {
            return Err(TraceError::InvalidConfig(format!(
                "no fitting frame in {} factor windows ({} frames)",
                src.windows(),
                pass.frames
            )));
        }
        pass.cells = cells;
        Ok(pass)
    }

    /// The statistics of pass A as every cell's [`FpStats`] (replacing the
    /// loop's), as the frame route would leave them after the same frames
    /// with an infinite half-life.
    fn install(&mut self, lib: &Library, pass: &Pass) {
        let n_px = self.dims.pixels();
        let (k_bg, maps): (usize, &[f32]) = match &lib.bg {
            BgTerms::Basis { k, maps, .. } => (*k, maps.as_slice()),
            _ => (0, &[]),
        };
        let mut out: HashMap<u64, FpStats> = HashMap::with_capacity(pass.cells.len());
        for (slot, cp) in pass.cells.iter().enumerate() {
            let pix = &cp.st.pix;
            let len = pix.len();
            let cols: Vec<Vec<f32>> = cp.nb.iter().map(|&j| column_on(lib, j, pix)).collect();
            let map = |a: usize, q: usize| f64::from(maps[a * n_px + pix[q] as usize]);
            let mut rc = [vec![0.0f64; len], vec![0.0f64; len]];
            let mut r = [vec![0.0f64; len], vec![0.0f64; len]];
            for h in 0..2 {
                for q in 0..len {
                    let mut a = cp.dc[h][q] - cp.tot.lc[h];
                    let mut b = pass.d[h][pix[q] as usize] - cp.tot.l1[h];
                    for (jj, &j) in cp.nb.iter().enumerate() {
                        let v = f64::from(cols[jj][q]);
                        if v != 0.0 {
                            a -= v * cp.tot.g[h][jj];
                            b -= v * pass.s[h][j];
                        }
                    }
                    for ai in 0..k_bg {
                        let g = map(ai, q);
                        a -= g * cp.tot.bc[h][ai];
                        b -= g * pass.b1[h][ai];
                    }
                    rc[h][q] = a;
                    r[h][q] = b;
                }
                // A pixel left out of a window: its data part was never
                // added, so take that window's trace terms back out.
                for e in &cp.excl {
                    for &q in &e.px {
                        let mut a = e.sums.lc[h];
                        let mut b = e.sums.l1[h];
                        for jj in 0..cp.nb.len() {
                            let v = f64::from(cols[jj][q]);
                            a += v * e.sums.g[h][jj];
                            b += v * e.s[h][jj];
                        }
                        for ai in 0..k_bg {
                            let g = map(ai, q);
                            a += g * e.sums.bc[h][ai];
                            b += g * e.b1[h][ai];
                        }
                        rc[h][q] += a;
                        r[h][q] += b;
                    }
                }
            }
            let to32 = |v: &[f64]| v.iter().map(|&x| x as f32).collect::<Vec<f32>>();
            let mut st = cp.st.clone();
            st.rc = to32(&rc[0]);
            st.r = to32(&r[0]);
            st.half = (to32(&rc[1]), to32(&r[1]), [cp.m[1]; 2]);
            st.m = [cp.m[0]; 2];
            st.k = pass.fitting;
            if !cp.excl.is_empty() {
                let pm = |h: usize| {
                    let m = cp.m[h];
                    let mut p = PixMoments {
                        n: vec![m[0]; len],
                        n2: vec![m[1]; len],
                        s1: vec![m[2]; len],
                        s2: vec![m[3]; len],
                    };
                    for e in &cp.excl {
                        for &q in &e.px {
                            p.n[q] -= e.sums.mom[h][0];
                            p.n2[q] -= e.sums.mom[h][1];
                            p.s1[q] -= e.sums.mom[h][2];
                            p.s2[q] -= e.sums.mom[h][3];
                        }
                    }
                    p
                };
                st.pm = Some(pm(0));
                st.half_pm = Some(pm(1));
            }
            out.insert(lib.ids()[slot], st);
        }
        self.fpstats = out;
    }

    /// Held-out frames per tile for the gate: `cfg.test_frames`, or what a
    /// tile's reservoir holds on average.
    fn test_count(&self, cfg: &FactorRefineConfig) -> usize {
        if cfg.test_frames > 0 {
            cfg.test_frames
        } else {
            let k = self.plan.frames_per_tile as f64 / f64::from(self.cfg.holdout_every);
            (k.round() as usize).max(1)
        }
    }

    /// Per tile, `k` of its held-out frames: the share `1 − random_share`
    /// where its cells are most active, the rest uniformly (a hash of the
    /// frame, the tile and the seed); `(frame, slow-loop index)` by frame.
    fn pick_tests(&self, scores: &[Vec<(f32, usize, u64)>], k: usize) -> Vec<Vec<(usize, u64)>> {
        // At least one uniform frame, as the reservoir keeps one random slot.
        let k_r = ((k as f32 * self.cfg.random_share).round() as usize)
            .max(1)
            .min(k);
        let k_e = k - k_r;
        scores
            .iter()
            .enumerate()
            .map(|(ti, s)| {
                let key = |slow: u64| self.test_key(ti, slow);
                let mut ev: Vec<&(f32, usize, u64)> = s.iter().collect();
                // Equal scores (quiet frames score exactly 0) go by the
                // hash, so they are not the recording's earliest frames.
                ev.sort_by(|a, b| {
                    b.0.total_cmp(&a.0)
                        .then(key(a.2).cmp(&key(b.2)))
                        .then(a.1.cmp(&b.1))
                });
                let mut out: Vec<(usize, u64)> = ev.iter().take(k_e).map(|e| (e.1, e.2)).collect();
                let mut rest: Vec<&(f32, usize, u64)> = ev.into_iter().skip(k_e).collect();
                rest.sort_by_key(|e| (key(e.2), e.1));
                out.extend(rest.iter().take(k_r).map(|e| (e.1, e.2)));
                out.sort_unstable();
                out
            })
            .collect()
    }

    /// The uniform order of held-out frame `slow` in tile `ti`.
    fn test_key(&self, ti: usize, slow: u64) -> u64 {
        mix(slow ^ ((ti as u64) << 40) ^ self.cfg.seed)
    }

    /// Pass B: the chosen held-out frames of every tile, its patch rebuilt
    /// from the factors and stored as the reservoir stores a frame
    /// (`y · σ⁻¹` quantised; a pixel below the valid share missing).
    /// `t_len`: the frames pass A read. A refused call leaves the loop as
    /// it was.
    fn test_frames(
        &mut self,
        src: &mut dyn FactorSource,
        pick: &[Vec<(usize, u64)>],
        t_len: usize,
    ) -> Result<Vec<TestTile>, TraceError> {
        if pick.len() != self.tiles.len() {
            return Err(TraceError::InvalidConfig(format!(
                "held-out frames for {} tiles, the slow loop has {}",
                pick.len(),
                self.tiles.len()
            )));
        }
        let dims = self.dims;
        let width = dims.width;
        // Bases of tiles not visited yet; installed only on success.
        let fresh: Vec<Option<BgBasis>> = self
            .tiles
            .iter()
            .zip(&self.bgs)
            .map(|(t, b)| b.is_none().then(|| BgBasis::new(t.rect)))
            .collect();
        let mut out: Vec<TestTile> = (0..self.tiles.len()).map(|_| TestTile::default()).collect();
        let mut v = Vec::new();
        let mut t0 = 0usize;
        for w in 0..src.windows() {
            let wf = src.window(w)?;
            check_window(&wf, dims, t0)?;
            let layout = wf.layout();
            let vmap = valid_map(&wf, &layout);
            for (ti, chosen) in pick.iter().enumerate() {
                let rect = self.tiles[ti].rect;
                let Some(bg) = self.bgs[ti].as_ref().or(fresh[ti].as_ref()) else {
                    continue;
                };
                let in_window = chosen.iter().filter(|c| c.0 >= t0 && c.0 < t0 + wf.frames);
                for &(t, slow) in in_window {
                    v.clear();
                    v.resize(rect.len(), 0.0f32);
                    let r = (rect.x0, rect.y0, rect.w, rect.h);
                    if !layout.reconstruct_rect(&wf, t - t0, r, &mut v) {
                        return Err(TraceError::InvalidConfig(format!(
                            "window {w}: patch of tile {ti}"
                        )));
                    }
                    for yy in 0..rect.h {
                        for xx in 0..rect.w {
                            let g = (rect.y0 + yy) * width + rect.x0 + xx;
                            let l = yy * rect.w + xx;
                            v[l] = if vmap[g] < MIN_VALID_SHARE as f32 {
                                f32::NAN
                            } else {
                                v[l] * self.inv_sigma[g]
                            };
                        }
                    }
                    let data: Vec<i16> = v.iter().map(|&z| quantize(z)).collect();
                    // The projections of the decoded patch, as `load` takes them.
                    let (y, _) = decode_patch(&data);
                    out[ti].proj.push(bg.project(&y));
                    out[ti].idx.push(slow);
                    out[ti].data.push(data);
                }
            }
            t0 += wf.frames;
        }
        if t0 != t_len {
            return Err(TraceError::InvalidConfig(format!(
                "the factors held {t_len} frames in pass A and {t0} in pass B"
            )));
        }
        // A chosen frame past the windows would leave its tile short.
        if let Some(ti) = (0..pick.len()).find(|&ti| out[ti].len() != pick[ti].len()) {
            return Err(TraceError::InvalidConfig(format!(
                "tile {ti}: {} of {} held-out frames in the windows",
                out[ti].len(),
                pick[ti].len()
            )));
        }
        for (slot, b) in self.bgs.iter_mut().zip(fresh) {
            if slot.is_none() {
                *slot = b;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::blend::Tiling;
    use crate::compress::{CompressConfig, WindowCompressor};
    use crate::discover::reservoir::{MISSING, QUANT};
    use crate::discover::tests::{blob_w, dims, flattener, movie, trace, v2_config, Lcg, N};
    use crate::discover::EditScope;
    use crate::discover::SlowLoopConfig;
    use crate::trace::{BackgroundModel, Footprint, FrameTraces};

    pub(super) const T: usize = 1500;
    pub(super) const WIN: usize = 300;
    /// A pixel of both disks, missing in all but 10 frames of window 1:
    /// left out of that window.
    pub(super) const GONE: usize = 46 * N + 48;
    /// A pixel of the second cell's disk, missing in a third of window 2:
    /// kept with the window's mean, and counted.
    pub(super) const PART: usize = 50 * N + 50;

    pub(super) fn cfg(model: BackgroundModel) -> SlowLoopConfig {
        SlowLoopConfig {
            // The frame route without forgetting (weight 1 on every fitting frame).
            stats_half_life_frames: f32::INFINITY,
            background: model,
            ..v2_config()
        }
    }

    /// Centre of the third cell (id 3), a compact one ([`compact_blob`]):
    /// its support's box stays off the boxes of the first two disks (which
    /// reach x = 68), only its moat blocks reach them (see
    /// [`assert_moat_only`]).
    pub(super) const FAR: (f32, f32) = (46.0, 80.0);

    /// A Gaussian soma (σ 2.5 px, peak 1) cut to the disk of radius 7 px, so
    /// its support is small enough to stay off a neighbour's disk.
    pub(super) fn compact_blob(id: u64, cy: f32, cx: f32) -> Footprint {
        let r = 7usize;
        let side = 2 * r + 1;
        let (y0, x0) = (cy as usize - r, cx as usize - r);
        let mut values = vec![0.0f32; side * side];
        for y in 0..side {
            for x in 0..side {
                let (dy, dx) = ((y0 + y) as f32 - cy, (x0 + x) as f32 - cx);
                let d2 = dy * dy + dx * dx;
                if d2 <= (r * r) as f32 {
                    values[y * side + x] = (-d2 / (2.0 * 2.5 * 2.5)).exp();
                }
            }
        }
        Footprint {
            id,
            y0,
            x0,
            height: side,
            width: side,
            values,
        }
    }

    /// The `bitten_refill` set of `discover::tests`: two neighbours, cell 2
    /// seeded without the light under cell 1's centre, so a Refine has
    /// something to refill, and a third cell at [`FAR`]. The slow loop
    /// (Refine scope, library published) and the movie's factors (offset
    /// grids, 300-frame windows).
    pub(super) fn fixture(c: SlowLoopConfig) -> (SlowLoop, Vec<WindowFactors>) {
        let mut rng = Lcg(411);
        let (a, b) = ((46.0, 44.0), (46.0, 47.5));
        let cells = vec![
            (blob_w(0, a.0, a.1, 2.5), trace(&mut rng, T, 0.03, 6.0)),
            (blob_w(1, b.0, b.1, 2.5), trace(&mut rng, T, 0.03, 6.0)),
            (compact_blob(2, FAR.0, FAR.1), trace(&mut rng, T, 0.03, 6.0)),
        ];
        let m = movie(&cells, T, 423);
        let mut bitten = blob_w(2, b.0, b.1, 2.5);
        for y in 0..bitten.height {
            for x in 0..bitten.width {
                let (dy, dx) = ((bitten.y0 + y) as f32 - a.0, (bitten.x0 + x) as f32 - a.1);
                if dy * dy + dx * dx <= 2.5 * 2.5 {
                    bitten.values[y * bitten.width + x] = 0.0;
                }
            }
        }
        let n_px = N * N;
        let mut sl = SlowLoop::new(dims(), vec![1; n_px], vec![1.0; n_px], flattener(), c).unwrap();
        sl.seed(&[
            blob_w(1, a.0, a.1, 2.5),
            bitten,
            compact_blob(3, FAR.0, FAR.1),
        ])
        .unwrap();
        sl.finalize().unwrap();
        sl.set_edit_scope(EditScope::Refine);
        let ccfg = CompressConfig {
            window: WIN,
            tiling: Tiling::Offset,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims(), ccfg);
        let mut windows = Vec::new();
        for t in 0..T {
            let mut f = m[t * n_px..(t + 1) * n_px].to_vec();
            if (WIN..2 * WIN - 10).contains(&t) {
                f[GONE] = f32::NAN;
            }
            if (2 * WIN..2 * WIN + WIN / 3).contains(&t) {
                f[PART] = f32::NAN;
            }
            if let Some(wf) = wc.push(&f) {
                windows.push(wf);
            }
        }
        windows.extend(wc.flush());
        (sl, windows)
    }

    /// The frame route: the frames rebuilt from the same factors (a pixel
    /// left out of a window is missing in all its frames), solved by the same
    /// factor engine, fed to the existing `observe_lookback`.
    pub(super) fn frame_route(sl: &mut SlowLoop, windows: &[WindowFactors], solver: SolverConfig) {
        let lib = sl.library().unwrap().clone();
        let mut ex = FactorExtractor::new(lib.clone(), solver).unwrap();
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let base = sl.frames();
        let mut y = vec![0.0f32; dims().pixels()];
        let mut t0 = 0usize;
        for wf in windows {
            let proj = WindowProjector::new(&lib, wf).unwrap();
            let mut trs: Vec<FrameTraces> = Vec::new();
            ex.solve(wf, &proj, 0, wf.frames, |tr| trs.push(tr.clone()))
                .unwrap();
            let vmap = valid_map(wf, &wf.layout());
            for (t, tr) in trs.iter().enumerate() {
                wf.reconstruct(t, &mut y);
                for (v, &s) in y.iter_mut().zip(&vmap) {
                    if s < MIN_VALID_SHARE as f32 {
                        *v = f32::NAN;
                    }
                }
                sl.observe_lookback(&y, &lib, tr, base + (t0 + t) as u64, None)
                    .unwrap();
            }
            t0 += wf.frames;
        }
    }

    /// Per slot and disk pixel, over the fitting frames: the summed size of
    /// the terms the frame route adds in float32, `Σ |c| (|y| + |m| + |ℓ| +
    /// |a c|)` for `rc` and `Σ (|y| + |m| + |ℓ| + |a c|)` for `r` (the
    /// halves are bounded by the same).
    fn term_scale(
        sl: &SlowLoop,
        windows: &[WindowFactors],
        solver: SolverConfig,
    ) -> Vec<(Vec<f64>, Vec<f64>)> {
        let lib = sl.library().unwrap().clone();
        let n_px = dims().pixels();
        let mut ex = FactorExtractor::new(lib.clone(), solver).unwrap();
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. });
        let basis = matches!(lib.background_model(), BackgroundModel::Basis(_));
        let stats: Vec<&FpStats> = lib.ids().iter().map(|id| &sl.fpstats[id]).collect();
        let mut out: Vec<(Vec<f64>, Vec<f64>)> = stats
            .iter()
            .map(|s| (vec![0.0; s.pix.len()], vec![0.0; s.pix.len()]))
            .collect();
        let (mut y, mut m) = (vec![0.0f32; n_px], vec![0.0f32; n_px]);
        let mut t0 = 0usize;
        for wf in windows {
            let proj = WindowProjector::new(&lib, wf).unwrap();
            let mut trs: Vec<FrameTraces> = Vec::new();
            ex.solve(wf, &proj, 0, wf.frames, |tr| trs.push(tr.clone()))
                .unwrap();
            for (t, tr) in trs.iter().enumerate() {
                if sl.is_test(sl.frames() + (t0 + t) as u64) {
                    continue;
                }
                wf.reconstruct(t, &mut y);
                let bg = basis.then_some(tr.background.as_slice());
                lib.render(&tr.traces, bg, &mut m).unwrap();
                for (slot, st) in stats.iter().enumerate() {
                    let c = f64::from(tr.traces[slot]).abs();
                    let l = if ring {
                        f64::from(tr.background[slot]).abs()
                    } else {
                        0.0
                    };
                    for (q, &p) in st.pix.iter().enumerate() {
                        let e = f64::from(y[p as usize]).abs()
                            + f64::from(m[p as usize]).abs()
                            + l
                            + f64::from(st.col[q]).abs() * c;
                        out[slot].0[q] += c * e;
                        out[slot].1[q] += e;
                    }
                }
            }
            t0 += wf.frames;
        }
        out
    }

    /// Two non-constant basis maps (horizontal and vertical ramps), so a map
    /// read at the wrong pixel shows.
    fn ramps() -> Vec<Vec<f32>> {
        let ramp = |f: fn(usize) -> usize| (0..N * N).map(|p| f(p) as f32 / N as f32).collect();
        vec![ramp(|p| p % N), ramp(|p| p / N)]
    }

    fn models() -> Vec<BackgroundModel> {
        vec![
            v2_config().background,
            BackgroundModel::None,
            BackgroundModel::Basis(ramps()),
        ]
    }

    /// The third cell reaches the first two disks through its moat only: no
    /// support pixel on the disk, a non-zero column there, and it is counted
    /// as a neighbour. Pins the fixture so it cannot drift.
    fn assert_moat_only(lib: &Library, pass: &Pass) {
        let far = lib.slot(3).unwrap();
        for id in [1, 2] {
            let cp = &pass.cells[lib.slot(id).unwrap()];
            let pix = &cp.st.pix;
            let (sup, _) = lib.core_col(far);
            assert!(
                !boxes_meet(&pixel_box(sup, N), &cp.bx),
                "cell {id}: the far cell's support box meets the disk box"
            );
            let col = column_on(lib, far, pix);
            assert!(
                col.iter().filter(|v| **v != 0.0).count() > 100,
                "cell {id}: the far cell's moat does not reach the disk"
            );
            assert!(
                cp.nb.contains(&far),
                "cell {id}: the far cell is no neighbour"
            );
        }
    }

    /// `PART` keeps a valid share between [`MIN_VALID_SHARE`] and
    /// [`LOW_VALID`] in window 2, and no disk leaves it out of any window.
    fn assert_part_kept(windows: &[WindowFactors], pass: &Pass) {
        let share = valid_map(&windows[2], &windows[2].layout())[PART];
        assert!(
            share >= MIN_VALID_SHARE as f32 && share < LOW_VALID,
            "PART valid share {share}"
        );
        let mut on_disks = 0;
        for cp in &pass.cells {
            let Ok(q) = cp.st.pix.binary_search(&(PART as u32)) else {
                continue;
            };
            on_disks += 1;
            assert!(cp.min_valid <= share);
            assert!(cp.excl.iter().all(|e| !e.px.contains(&q)), "PART left out");
        }
        assert!(on_disks >= 1, "PART lies on no disk");
    }

    #[test]
    fn statistics_from_the_factors_equal_the_frame_route_on_rebuilt_frames() {
        let rc = FactorRefineConfig::default();
        for model in models() {
            // The basis maps would fill a failure message.
            let label = match &model {
                BackgroundModel::Basis(_) => "Basis".to_string(),
                m => format!("{m:?}"),
            };
            let (mut fa, windows) = fixture(cfg(model.clone()));
            let (mut fb, _) = fixture(cfg(model.clone()));
            let lib = fa.library().unwrap().clone();
            let pass = fa.sum_pass(&lib, &mut windows.clone(), &rc).unwrap();
            assert_moat_only(&lib, &pass);
            assert_part_kept(&windows, &pass);
            fa.install(&lib, &pass);
            assert_eq!(pass.frames, T);
            assert_eq!(
                pass.cells
                    .iter()
                    .filter(|c| c.min_valid < LOW_VALID)
                    .count(),
                2,
                "the two near disks hold a pixel with a valid share below 1"
            );
            frame_route(&mut fb, &windows, rc.solver);
            let scale = term_scale(&fb, &windows, rc.solver);
            let libb = fb.library().unwrap().clone();
            assert_eq!(lib.ids(), libb.ids());
            for (slot, id) in lib.ids().iter().enumerate() {
                let (a, b) = (&fa.fpstats[id], &fb.fpstats[id]);
                assert_eq!(a.pix, b.pix, "{label} cell {id}: disk");
                assert_eq!(a.col, b.col, "{label} cell {id}: column");
                assert_eq!(a.m, b.m, "{label} cell {id}: class moments, bit for bit");
                assert_eq!(a.half.2, b.half.2, "{label} cell {id}: half moments");
                assert_eq!(a.k, b.k, "{label} cell {id}: pushes");
                let gone = a.pix.binary_search(&(GONE as u32)).ok();
                assert_eq!(gone.is_some(), *id != 3, "GONE lies on the two near disks");
                assert_eq!(a.pm.is_some(), gone.is_some(), "{label} cell {id}: pm");
                assert_eq!(b.pm.is_some(), gone.is_some(), "{label} cell {id}: pm");
                let (src, sr) = &scale[slot];
                let sums = [
                    ("rc", &a.rc, &b.rc, src),
                    ("r", &a.r, &b.r, sr),
                    ("half rc", &a.half.0, &b.half.0, src),
                    ("half r", &a.half.1, &b.half.1, sr),
                ];
                for (name, x, y, s) in sums {
                    for q in 0..x.len() {
                        // The frame route's float32 accumulation (the
                        // factor route sums in float64): measured gaps reach
                        // up to 9 % of this tolerance, so a 1 % error in a
                        // neighbour, level or basis term fails by far.
                        let tol = 1e-5 * s[q] + 1e-4;
                        assert!(
                            f64::from((x[q] - y[q]).abs()) <= tol,
                            "{label} cell {id} {name} at pixel {}: {} from factors, {} from frames (tol {tol})",
                            a.pix[q],
                            x[q],
                            y[q]
                        );
                    }
                }
                let Some(gone) = gone else {
                    continue;
                };
                for (pa, pb) in [(&a.pm, &b.pm), (&a.half_pm, &b.half_pm)] {
                    let (pa, pb) = (pa.as_ref().unwrap(), pb.as_ref().unwrap());
                    for (x, y) in [
                        (&pa.n, &pb.n),
                        (&pa.n2, &pb.n2),
                        (&pa.s1, &pb.s1),
                        (&pa.s2, &pb.s2),
                    ] {
                        for (u, v) in x.iter().zip(y) {
                            assert!(
                                (u - v).abs() <= 1e-9 * u.abs().max(1.0),
                                "{label} cell {id}: {u} vs {v}"
                            );
                        }
                    }
                }
                assert!(
                    a.pm.as_ref().unwrap().n[gone] < a.m[0][0],
                    "GONE left out of window 1"
                );
                if let Ok(q) = a.pix.binary_search(&(PART as u32)) {
                    assert_eq!(
                        a.pm.as_ref().unwrap().n[q],
                        a.m[0][0],
                        "PART counted in every fitting frame"
                    );
                }
            }
        }
    }

    #[test]
    fn a_pass_without_fitting_frames_is_refused() {
        let rc = FactorRefineConfig::default();
        let (mut sl, windows) = fixture(cfg(BackgroundModel::None));
        let lib = sl.library().unwrap().clone();
        let none: &mut Vec<WindowFactors> = &mut Vec::new();
        assert!(matches!(
            sl.sum_pass(&lib, none, &rc),
            Err(TraceError::InvalidConfig(_))
        ));
        // One frame, held out: move the loop's clock to a held-out index.
        let mut one = windows[0].clone();
        one.frames = 1;
        for tf in &mut one.tiles {
            tf.temporal.truncate(tf.rank);
        }
        sl.frames = (0..).find(|&f| sl.is_test(f)).unwrap();
        let err = sl.sum_pass(&lib, &mut vec![one], &rc).err();
        assert!(matches!(err, Some(TraceError::InvalidConfig(_))), "{err:?}");
    }

    #[test]
    fn held_out_patches_are_the_whitened_rebuilt_frames() {
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let rc = FactorRefineConfig::default();
        let lib = sl.library().unwrap().clone();
        let mut src = windows.clone();
        let pass = sl.sum_pass(&lib, &mut src, &rc).unwrap();
        let k = sl.test_count(&rc);
        assert_eq!(k, (sl.plan.frames_per_tile as f64 / 3.0).round() as usize);
        let pick = sl.pick_tests(&pass.scores, k);
        assert_eq!(pick, sl.pick_tests(&pass.scores, k), "deterministic");
        for (ti, p) in pick.iter().enumerate() {
            assert!(p.len() <= k);
            assert!(p.windows(2).all(|w| w[0].0 < w[1].0), "sorted, no repeat");
            assert!(p
                .iter()
                .all(|&(t, slow)| sl.is_test(slow) && slow == sl.frames() + t as u64));
            if pass.scores[ti].len() >= k {
                assert_eq!(p.len(), k);
                // The event part holds the most active frame of the tile.
                let top = pass.scores[ti]
                    .iter()
                    .max_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)))
                    .unwrap();
                assert!(p.iter().any(|&(t, _)| t == top.1));
            }
        }
        // Refused: a source that lost a window between the passes, picks for
        // another number of tiles, a picked frame past the windows. Each
        // leaves the loop's tile bases as they were.
        let unset: Vec<bool> = sl.bgs.iter().map(Option::is_none).collect();
        assert!(unset.iter().any(|&u| u), "a tile without a basis yet");
        let mut past = pick.clone();
        past[0].push((T + 5, sl.frames() + (T + 5) as u64));
        let mut short = windows[..windows.len() - 1].to_vec();
        let refused = [
            (
                "short source",
                sl.test_frames(&mut short, &pick, pass.frames).err(),
            ),
            (
                "pick length",
                sl.test_frames(&mut src, &pick[..1], pass.frames).err(),
            ),
            (
                "past the windows",
                sl.test_frames(&mut src, &past, pass.frames).err(),
            ),
        ];
        for (name, err) in refused {
            assert!(
                matches!(err, Some(TraceError::InvalidConfig(_))),
                "{name}: {err:?}"
            );
            assert_eq!(
                sl.bgs.iter().map(Option::is_none).collect::<Vec<_>>(),
                unset,
                "{name}: bases changed"
            );
        }
        let stored = sl.test_frames(&mut src, &pick, pass.frames).unwrap();
        assert_eq!(stored.len(), sl.tiles.len());
        assert!(pick.iter().any(|p| p.len() == k), "a tile with K frames");
        // A tile with fewer held-out frames than asked for gets all of them.
        let all = sl.pick_tests(&pass.scores, T);
        for (p, s) in all.iter().zip(&pass.scores) {
            let mut want: Vec<(usize, u64)> = s.iter().map(|e| (e.1, e.2)).collect();
            want.sort_unstable();
            assert_eq!(*p, want);
        }
        let mut full = vec![0.0f32; dims().pixels()];
        let mut gone_listed = 0;
        for (ti, tt) in stored.iter().enumerate() {
            assert_eq!(tt.len(), pick[ti].len());
            let fr = tt.frames();
            assert_eq!(fr.len(), pick[ti].len());
            let rect = sl.tiles[ti].rect;
            for (j, &(t, slow)) in pick[ti].iter().enumerate() {
                assert_eq!(fr.idx[j], slow);
                let (w, tw) = (t / WIN, t % WIN);
                windows[w].layout().reconstruct(&windows[w], tw, &mut full);
                let vmap = valid_map(&windows[w], &windows[w].layout());
                for yy in 0..rect.h {
                    for xx in 0..rect.w {
                        let g = (rect.y0 + yy) * N + rect.x0 + xx;
                        let l = yy * rect.w + xx;
                        let at = format!("tile {ti} frame {t} pixel {g}");
                        let gone = vmap[g] < MIN_VALID_SHARE as f32;
                        let z = if gone {
                            f32::NAN
                        } else {
                            full[g] * sl.inv_sigma[g]
                        };
                        // Stored exactly as the reservoir stores `z`.
                        let q = tt.data[j][l];
                        assert_eq!(q, quantize(z), "{at}");
                        assert_eq!(q == MISSING, gone, "{at}");
                        let listed = fr.miss[j].binary_search(&(l as u32)).is_ok();
                        assert_eq!(listed, gone, "{at}");
                        gone_listed += usize::from(listed && g == GONE);
                        let y = fr.y[j][l];
                        if gone {
                            assert_eq!(y.to_bits(), 0.0f32.to_bits(), "{at}");
                        } else {
                            assert_eq!(y.to_bits(), decode(q).to_bits(), "{at}");
                            assert!((y - z).abs() <= 0.5 / QUANT, "{at}: {y} vs {z}");
                        }
                    }
                }
                assert_eq!(fr.proj[j], sl.bgs[ti].as_ref().unwrap().project(&fr.y[j]));
            }
        }
        assert!(
            gone_listed > 0,
            "GONE missing in a held-out patch of window 1"
        );
    }

    #[test]
    fn quiet_frames_are_picked_by_the_hash_and_one_frame_is_uniform() {
        let (sl, windows) = fixture(cfg(BackgroundModel::None));
        let rc = FactorRefineConfig::default();
        let lib = sl.library().unwrap().clone();
        let mut pass = sl.sum_pass(&lib, &mut windows.clone(), &rc).unwrap();
        // Tile 0 quiet: every held-out frame scores 0.
        for e in &mut pass.scores[0] {
            e.0 = 0.0;
        }
        let k = sl.test_count(&rc);
        assert!(pass.scores[0].len() > 2 * k, "candidates to choose from");
        let pick = sl.pick_tests(&pass.scores, k);
        assert_eq!(pick, sl.pick_tests(&pass.scores, k), "deterministic");
        let mut earliest: Vec<(usize, u64)> = pass.scores[0].iter().map(|e| (e.1, e.2)).collect();
        earliest.sort_unstable();
        earliest.truncate(k);
        assert_eq!(pick[0].len(), k);
        assert_ne!(pick[0], earliest, "not the recording's earliest frames");
        // With every score equal, event and uniform parts both follow the hash.
        let mut by_hash: Vec<(usize, u64)> = pass.scores[0].iter().map(|e| (e.1, e.2)).collect();
        by_hash.sort_by_key(|&(t, slow)| (sl.test_key(0, slow), t));
        by_hash.truncate(k);
        by_hash.sort_unstable();
        assert_eq!(pick[0], by_hash, "the hash's first k");
        // One frame per tile: the uniform one (the hash's first), not the
        // most active.
        let one = sl.pick_tests(&pass.scores, 1);
        for (ti, s) in pass.scores.iter().enumerate() {
            let want: Vec<(usize, u64)> = s
                .iter()
                .min_by_key(|e| (sl.test_key(ti, e.2), e.1))
                .map(|e| (e.1, e.2))
                .into_iter()
                .collect();
            assert_eq!(one[ti], want, "tile {ti}");
        }
    }

    #[test]
    fn non_finite_factors_are_refused() {
        let rc = FactorRefineConfig::default();
        let (sl, windows) = fixture(cfg(BackgroundModel::None));
        let lib = sl.library().unwrap().clone();
        let edits: [(&str, fn(&mut WindowFactors)); 2] = [
            ("valid", |w| w.tiles[3].valid[5] = f32::NAN),
            ("spatial", |w| w.tiles[3].spatial[7] = f32::INFINITY),
        ];
        for (name, edit) in edits {
            let mut ws = windows.clone();
            edit(&mut ws[1]);
            match sl.sum_pass(&lib, &mut ws, &rc) {
                Err(TraceError::InvalidConfig(m)) => {
                    assert!(
                        m.contains("frame 300") && m.contains("tile 3"),
                        "{name}: {m}"
                    )
                }
                other => panic!("{name}: {:?}", other.err()),
            }
        }
    }
}
