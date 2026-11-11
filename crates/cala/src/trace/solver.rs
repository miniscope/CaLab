//! The per-frame solve.

use std::sync::Arc;

use super::library::{BgTerms, Library};
use super::{check_len, TraceError};

/// Solver settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolverConfig {
    /// A group has converged when a sweep moves none of its traces by more
    /// than `tol` times that trace's noise σ.
    pub tol: f32,
    /// Upper bound on sweeps per frame.
    pub max_sweeps: u32,
    /// Over-relaxation factor ω of each coordinate step (projected SOR;
    /// converges for 0 < ω < 2 on the convex models; 1 = plain coordinate
    /// descent).
    pub relax: f32,
}

impl Default for SolverConfig {
    fn default() -> SolverConfig {
        SolverConfig {
            tol: 0.05,
            max_sweeps: 200,
            relax: 1.5,
        }
    }
}

impl SolverConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        if self.tol.is_finite()
            && self.tol > 0.0
            && self.max_sweeps > 0
            && self.relax > 0.0
            && self.relax < 2.0
        {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}

/// One frame's result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FrameTraces {
    /// Index of the frame in the engine's stream.
    pub frame_index: u64,
    /// Version of the library that produced it.
    pub library_version: u64,
    /// One value per cell, in the library's slot order (`Library::ids`).
    pub traces: Vec<f32>,
    /// Background coefficients: one per map (basis model) or one local level
    /// per cell (ring model); empty without a background.
    pub background: Vec<f32>,
    /// Coordinate sweeps used (the longest any group needed).
    pub sweeps: u32,
}

/// The warm start: each cell's last trace value by id, so it survives a
/// library change. Captured with [`TraceEngine::state`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TraceState {
    pub next_frame: u64,
    pub ids: Vec<u64>,
    pub traces: Vec<f32>,
}

/// Streaming trace extraction against a swappable [`Library`].
#[derive(Debug, Clone)]
pub struct TraceEngine {
    lib: Arc<Library>,
    cfg: SolverConfig,
    c: Vec<f32>,
    b: Vec<f32>,
    /// Basis model: `u − Σ_j x_j c_j`, so `β = P q`.
    q: Vec<f64>,
    /// `q` when each group last converged (basis model).
    q_snap: Vec<f64>,
    /// Ring model: ring mean of the frame per cell.
    ring: Vec<f32>,
    /// The frame summed over each moat-grid block (FOV only).
    blocks: Vec<f32>,
    active: Vec<bool>,
    next_frame: u64,
    /// Missing-data imputation (see [`TraceEngine::process_into`]): the
    /// filled frame, the missing pixels, a per-pixel flag, the moat field of
    /// the prediction and the last frame's background coefficients.
    filled: Vec<f32>,
    missing: Vec<u32>,
    miss_flag: Vec<u8>,
    field: Vec<f32>,
    last_bg: Vec<f32>,
    /// The traces the current fill was made with.
    c_em: Vec<f32>,
    /// Per background map, the `f32` partial dot product of each
    /// [`BASIS_CHUNK`] of the last solved frame, and the moat blocks and
    /// chunks holding a missing pixel: a refilled frame differs from the
    /// last one only there, so later passes redo only those sums.
    chunk_acc: Vec<f32>,
    dirty_blocks: Vec<u32>,
    dirty_chunks: Vec<u32>,
    /// Per cell, the bounding box (`y0, y1, x0, x1`, inclusive) of its
    /// support and ring pixels (built on first use per library), and whether
    /// a refill touches its projection (a missing pixel in the box, or a
    /// dirty moat block).
    cell_box: Vec<[u32; 4]>,
    cell_dirty: Vec<bool>,
    block_flag: Vec<bool>,
}

/// Pixels per partial sum of the background-map projections.
const BASIS_CHUNK: usize = 4096;

/// Solves per frame with missing pixels, at most (see
/// [`TraceEngine::process_into`]). Each refill shrinks a trace's error by the
/// share of its column's energy on missing pixels; the edge band is a few
/// pixels wide, so a cell keeps most of its column and two refills suffice.
pub const EM_PASSES: usize = 3;

impl TraceEngine {
    pub fn new(lib: Arc<Library>, cfg: SolverConfig) -> Result<TraceEngine, TraceError> {
        cfg.validate()?;
        let mut e = TraceEngine {
            lib: lib.clone(),
            cfg,
            c: Vec::new(),
            b: Vec::new(),
            q: Vec::new(),
            q_snap: Vec::new(),
            ring: Vec::new(),
            blocks: Vec::new(),
            active: Vec::new(),
            next_frame: 0,
            filled: Vec::new(),
            missing: Vec::new(),
            miss_flag: Vec::new(),
            field: Vec::new(),
            last_bg: Vec::new(),
            c_em: Vec::new(),
            chunk_acc: Vec::new(),
            dirty_blocks: Vec::new(),
            dirty_chunks: Vec::new(),
            cell_box: Vec::new(),
            cell_dirty: Vec::new(),
            block_flag: Vec::new(),
        };
        e.install(lib, None);
        Ok(e)
    }

    pub fn library(&self) -> &Arc<Library> {
        &self.lib
    }

    pub fn config(&self) -> &SolverConfig {
        &self.cfg
    }

    /// Frames processed so far (the index the next frame gets).
    pub fn next_frame(&self) -> u64 {
        self.next_frame
    }

    /// Replace the library before the next frame. Cells present in both keep
    /// their warm start (matched by id); new cells start at 0. The frame
    /// size must not change.
    pub fn set_library(&mut self, lib: Arc<Library>) -> Result<(), TraceError> {
        if lib.dims() != self.lib.dims() {
            return Err(TraceError::Incompatible(format!(
                "library frame {:?} != engine frame {:?}",
                lib.dims(),
                self.lib.dims()
            )));
        }
        let old = (self.lib.ids().to_vec(), std::mem::take(&mut self.c));
        self.install(lib, Some((&old.0, &old.1)));
        Ok(())
    }

    fn install(&mut self, lib: Arc<Library>, warm: Option<(&[u64], &[f32])>) {
        let n = lib.len();
        self.c = vec![0.0; n];
        if let Some((ids, vals)) = warm {
            for (&id, &v) in ids.iter().zip(vals) {
                if let Some(s) = lib.slot(id) {
                    self.c[s] = v;
                }
            }
        }
        self.b = vec![0.0; n];
        let k = match &lib.bg {
            BgTerms::Basis { k, .. } => *k,
            _ => 0,
        };
        self.q = vec![0.0; k];
        self.q_snap = vec![0.0; k * lib.groups.len()];
        self.ring = match &lib.bg {
            BgTerms::Ring { .. } => vec![0.0; n],
            _ => Vec::new(),
        };
        self.active = vec![true; lib.groups.len()];
        self.last_bg = vec![0.0; k];
        self.cell_box.clear();
        self.lib = lib;
    }

    /// The warm start and frame counter.
    pub fn state(&self) -> TraceState {
        TraceState {
            next_frame: self.next_frame,
            ids: self.lib.ids().to_vec(),
            traces: self.c.clone(),
        }
    }

    /// Restore a warm start (cells matched by id; others start at 0).
    pub fn restore(&mut self, state: &TraceState) -> Result<(), TraceError> {
        check_len("trace state", state.ids.len(), state.traces.len())?;
        let lib = self.lib.clone();
        self.install(lib, Some((&state.ids, &state.traces)));
        self.next_frame = state.next_frame;
        Ok(())
    }

    /// Solve one preprocessed frame.
    pub fn process(&mut self, frame: &[f32]) -> Result<FrameTraces, TraceError> {
        let mut out = FrameTraces::default();
        self.process_into(frame, &mut out)?;
        Ok(out)
    }

    /// [`Self::process`] reusing `out`'s buffers.
    ///
    /// Non-finite pixels are missing data (registration moved them in from
    /// outside the sensor's FOV mask, [`crate::preprocess::Preprocessor::back_masked`])
    /// and get zero weight, by expectation-maximisation: they are filled with
    /// the model's prediction (first at the warm start, the last frame's
    /// traces and background), the frame is solved, and the fill is redone
    /// with the new traces, up to [`EM_PASSES`] solves or until no trace
    /// moves by `tol` of its noise. At the fixed point the missing pixels
    /// pull no trace away from what the valid pixels say. Frames without
    /// missing pixels take a single solve, as before.
    pub fn process_into(&mut self, frame: &[f32], out: &mut FrameTraces) -> Result<(), TraceError> {
        let lib = self.lib.clone();
        let lib = &*lib;
        let n_px = lib.dims().pixels();
        check_len("frame", n_px, frame.len())?;
        let mut filled = std::mem::take(&mut self.filled);
        let r = if self.find_missing(frame, &mut filled) {
            self.mark_dirty(lib);
            self.predict_missing(lib, &mut filled);
            let mut r = Ok(());
            for pass in 0..EM_PASSES {
                self.c_em.clear();
                self.c_em.extend_from_slice(&self.c);
                // Later passes changed only the missing pixels.
                r = self.solve_frame(lib, &filled, out, pass > 0);
                let tol = self.cfg.tol;
                let moved = self
                    .c
                    .iter()
                    .zip(&self.c_em)
                    .zip(lib.trace_noise.iter())
                    .any(|((&a, &b), &sd)| (a - b).abs() > tol * sd.max(f32::MIN_POSITIVE));
                if r.is_err() || !moved || pass + 1 == EM_PASSES {
                    break;
                }
                self.predict_missing(lib, &mut filled);
            }
            r
        } else {
            self.solve_frame(lib, frame, out, false)
        };
        self.filled = filled;
        self.next_frame += 1;
        r
    }

    /// List the missing (non-finite) pixels of `frame` and copy it into
    /// `filled`; `false` (and `filled` untouched) when nothing is missing.
    fn find_missing(&mut self, frame: &[f32], filled: &mut Vec<f32>) -> bool {
        self.missing.clear();
        // Whole chunks are checked branch-free first: missing pixels are few.
        for (c, chunk) in frame.chunks(1024).enumerate() {
            if chunk.iter().fold(true, |ok, v| ok & v.is_finite()) {
                continue;
            }
            for (j, v) in chunk.iter().enumerate() {
                if !v.is_finite() {
                    self.missing.push((c * 1024 + j) as u32);
                }
            }
        }
        if self.missing.is_empty() {
            return false;
        }
        filled.clear();
        filled.extend_from_slice(frame);
        true
    }

    /// The moat blocks and background chunks that hold a missing pixel
    /// (ascending, `self.missing` is).
    fn mark_dirty(&mut self, lib: &Library) {
        self.dirty_chunks.clear();
        for &q in &self.missing {
            let c = q / BASIS_CHUNK as u32;
            if self.dirty_chunks.last() != Some(&c) {
                self.dirty_chunks.push(c);
            }
        }
        self.dirty_blocks.clear();
        if lib.grid_len() > 0 {
            self.dirty_blocks
                .extend(self.missing.iter().map(|&q| lib.block_of(q) as u32));
            self.dirty_blocks.sort_unstable();
            self.dirty_blocks.dedup();
        }
        self.mark_cells(lib);
    }

    /// `cell_dirty`: the cells whose projection (support, moat or ring
    /// part) a change of the missing pixels can move.
    fn mark_cells(&mut self, lib: &Library) {
        let n = lib.len();
        let w = lib.dims().width as u32;
        if self.cell_box.len() != n {
            self.cell_box.clear();
            for i in 0..n {
                let mut bx = [u32::MAX, 0, u32::MAX, 0];
                let ring: &[u32] = match &lib.bg {
                    BgTerms::Ring {
                        ring_start,
                        ring_pix,
                        ..
                    } => &ring_pix[ring_start[i]..ring_start[i + 1]],
                    _ => &[],
                };
                for &q in lib.core_col(i).0.iter().chain(ring) {
                    let (y, x) = (q / w, q % w);
                    bx = [bx[0].min(y), bx[1].max(y), bx[2].min(x), bx[3].max(x)];
                }
                self.cell_box.push(bx);
            }
        }
        let gl = lib.grid_len();
        self.block_flag.clear();
        self.block_flag.resize(gl, false);
        for &bq in &self.dirty_blocks {
            self.block_flag[bq as usize] = true;
        }
        self.cell_dirty.clear();
        for (i, &[y0, y1, x0, x1]) in self.cell_box.iter().enumerate() {
            let inside = self.missing.iter().any(|&q| {
                let (y, x) = (q / w, q % w);
                (y0..=y1).contains(&y) && (x0..=x1).contains(&x)
            });
            let moat = gl > 0
                && lib
                    .lowpass(i)
                    .0
                    .iter()
                    .any(|&bq| self.block_flag[bq as usize]);
            self.cell_dirty.push(inside | moat);
        }
    }

    /// Fill the missing pixels of `filled` (the rest is the frame) with the
    /// prediction of the current traces and the last background.
    fn predict_missing(&mut self, lib: &Library, filled: &mut [f32]) {
        let n_px = filled.len();
        self.miss_flag.resize(n_px, 0);
        for &q in &self.missing {
            filled[q as usize] = 0.0;
            self.miss_flag[q as usize] = 1;
        }
        if let (BgTerms::Basis { k, maps, .. }, true) =
            (&lib.bg, self.last_bg.len() == self.q.len())
        {
            for a in 0..*k {
                let beta = self.last_bg[a];
                if beta != 0.0 {
                    let m = &maps[a * n_px..(a + 1) * n_px];
                    for &q in &self.missing {
                        filled[q as usize] += m[q as usize] * beta;
                    }
                }
            }
        }
        let gl = lib.grid_len();
        self.field.clear();
        self.field.resize(gl, 0.0);
        let mut moat = false;
        for (i, &c) in self.c.iter().enumerate() {
            if c == 0.0 {
                continue;
            }
            let (p, v) = lib.core_col(i);
            for (&q, &a) in p.iter().zip(v) {
                if self.miss_flag[q as usize] != 0 {
                    filled[q as usize] += a * c;
                }
            }
            let (bi, li) = lib.lowpass(i);
            for (&bq, &l) in bi.iter().zip(li) {
                self.field[bq as usize] += l * c;
                moat = true;
            }
        }
        let fov = lib.fov();
        for &q in &self.missing {
            let q = q as usize;
            self.miss_flag[q] = 0;
            if moat && fov[q] != 0 {
                filled[q] -= self.field[lib.block_of(q as u32)];
            }
        }
    }

    /// Solve `frame`. `refill`: it is the last solved frame with only the
    /// missing pixels changed, so only the moat blocks and background
    /// chunks that hold one are summed again (in the same order: the result
    /// is the full computation's, bit for bit).
    fn solve_frame(
        &mut self,
        lib: &Library,
        frame: &[f32],
        out: &mut FrameTraces,
        refill: bool,
    ) -> Result<(), TraceError> {
        let n_px = lib.dims().pixels();
        let n = lib.len();
        // Projections onto the filtered footprints: the support part, minus
        // the moat's block means against the frame's block sums.
        let gl = lib.grid_len();
        if gl > 0 && refill && self.blocks.len() == gl {
            let (w, bs) = (lib.dims().width, lib.block_px());
            let h = lib.dims().height;
            let gw = w.div_ceil(bs);
            let fov = lib.fov();
            for &bq in &self.dirty_blocks {
                let (by, bx) = (bq as usize / gw, bq as usize % gw);
                let (x0, x1) = (bx * bs, ((bx + 1) * bs).min(w));
                let mut o = 0.0f32;
                for y in by * bs..((by + 1) * bs).min(h) {
                    let mut acc = 0.0f32;
                    for (&v, &m) in frame[y * w + x0..y * w + x1]
                        .iter()
                        .zip(&fov[y * w + x0..y * w + x1])
                    {
                        if m != 0 && v.is_finite() {
                            acc += v;
                        }
                    }
                    o += acc;
                }
                self.blocks[bq as usize] = o;
            }
        } else if gl > 0 {
            self.blocks.clear();
            self.blocks.resize(gl, 0.0);
            let (w, bs) = (lib.dims().width, lib.block_px());
            let gw = lib.dims().width.div_ceil(bs);
            let fov = lib.fov();
            for (y, (row, mrow)) in frame.chunks(w).zip(fov.chunks(w)).enumerate() {
                let brow = &mut self.blocks[(y / bs) * gw..(y / bs + 1) * gw];
                for ((o, seg), mseg) in brow.iter_mut().zip(row.chunks(bs)).zip(mrow.chunks(bs)) {
                    let mut acc = 0.0f32;
                    for (&v, &m) in seg.iter().zip(mseg) {
                        if m != 0 && v.is_finite() {
                            acc += v;
                        }
                    }
                    *o += acc;
                }
            }
        }
        // A refill moves only the cells it touches (the others' sums would
        // come out the same).
        let skip = |i: usize| refill && self.cell_dirty.len() == n && !self.cell_dirty[i];
        for i in 0..n {
            if skip(i) {
                continue;
            }
            let (p, v) = lib.core_col(i);
            let mut s = 0.0f32;
            for (&q, &a) in p.iter().zip(v) {
                s += a * frame[q as usize];
            }
            let (bi, li) = lib.lowpass(i);
            for (&bq, &l) in bi.iter().zip(li) {
                s -= l * self.blocks[bq as usize];
            }
            self.b[i] = s;
        }
        if let Some(i) = self.b.iter().position(|v| !v.is_finite()) {
            return Err(TraceError::InvalidConfig(format!(
                "frame {} has non-finite pixels under cell {}",
                self.next_frame,
                lib.ids()[i]
            )));
        }
        match &lib.bg {
            BgTerms::Basis { k, maps, x, .. } => {
                let k = *k;
                let nc = n_px.div_ceil(BASIS_CHUNK);
                let dot = |a: usize, c: usize| -> f32 {
                    let r = c * BASIS_CHUNK..((c + 1) * BASIS_CHUNK).min(n_px);
                    let mut acc = 0.0f32;
                    for (&g, &y) in maps[a * n_px..(a + 1) * n_px][r.clone()]
                        .iter()
                        .zip(&frame[r])
                    {
                        acc += g * y;
                    }
                    acc
                };
                if refill && self.chunk_acc.len() == k * nc {
                    for a in 0..k {
                        for &c in &self.dirty_chunks {
                            self.chunk_acc[a * nc + c as usize] = dot(a, c as usize);
                        }
                    }
                } else {
                    self.chunk_acc.clear();
                    for a in 0..k {
                        for c in 0..nc {
                            self.chunk_acc.push(dot(a, c));
                        }
                    }
                }
                for a in 0..k {
                    let mut s = 0.0f64;
                    for &acc in &self.chunk_acc[a * nc..(a + 1) * nc] {
                        s += f64::from(acc);
                    }
                    self.q[a] = s;
                }
                for (i, &ci) in self.c.iter().enumerate() {
                    if ci != 0.0 {
                        for a in 0..k {
                            self.q[a] -= f64::from(x[i * k + a]) * f64::from(ci);
                        }
                    }
                }
            }
            BgTerms::Ring {
                ring_start,
                ring_pix,
                ..
            } => {
                for i in 0..n {
                    if skip(i) {
                        continue;
                    }
                    let px = &ring_pix[ring_start[i]..ring_start[i + 1]];
                    let mut s = 0.0f32;
                    for &q in px {
                        s += frame[q as usize];
                    }
                    self.ring[i] = if px.is_empty() {
                        0.0
                    } else {
                        s / px.len() as f32
                    };
                }
            }
            BgTerms::None => {}
        }
        let sweeps = self.solve(lib);
        out.frame_index = self.next_frame;
        out.library_version = lib.version();
        out.traces.clear();
        out.traces.extend_from_slice(&self.c);
        out.background.clear();
        match &lib.bg {
            BgTerms::Basis { k, p, .. } => {
                let k = *k;
                for a in 0..k {
                    let s: f64 = (0..k).map(|b| p[a * k + b] * self.q[b]).sum();
                    out.background.push(s as f32);
                }
            }
            BgTerms::Ring { q, .. } => {
                for i in 0..n {
                    let (cols, vals) = q.row(i);
                    let s: f32 = cols
                        .iter()
                        .zip(vals)
                        .map(|(&j, &v)| v * self.c[j as usize])
                        .sum();
                    out.background.push(self.ring[i] - s);
                }
            }
            BgTerms::None => {}
        }
        if matches!(lib.bg, BgTerms::Basis { .. }) {
            self.last_bg.clear();
            self.last_bg.extend_from_slice(&out.background);
        }
        out.sweeps = sweeps;
        Ok(())
    }

    /// Re-solve the last processed frame with the cell in `slot` held at 0
    /// (a drop-one refit): its neighbours re-converge from the current
    /// solution to the solver's tolerance, revisiting only cells coupled to
    /// one that moved (cells outside its overlap group cannot move). `out` receives
    /// `(slot, new value)` for every cell whose value changed, the dropped
    /// cell included. The engine's state is left as it was.
    ///
    /// For evaluation code (the held-out score in `examples/qc_eval.rs`);
    /// the fast loop does not use it. Not available with a basis
    /// background, which couples every group.
    pub fn drop_one(&mut self, slot: usize, out: &mut Vec<(usize, f32)>) -> Result<(), TraceError> {
        out.clear();
        let lib = self.lib.clone();
        let lib = &*lib;
        if slot >= lib.len() {
            return Err(TraceError::Incompatible(format!(
                "slot {slot} of a {}-cell library",
                lib.len()
            )));
        }
        if matches!(lib.bg, BgTerms::Basis { .. }) {
            return Err(TraceError::InvalidConfig(
                "drop_one: a basis background couples every cell".into(),
            ));
        }
        if self.c[slot] == 0.0 {
            return Ok(());
        }
        // Active-set Gauss-Seidel from the current solution: only the cells
        // coupled to one that moved by more than `tol` are revisited (the
        // Gram row, which includes the moats' overlap, and the ring row).
        let n = lib.len();
        let mut saved: Vec<(usize, f32)> = vec![(slot, self.c[slot])];
        let mut seen = vec![false; n];
        let mut queued = vec![false; n];
        seen[slot] = true;
        self.c[slot] = 0.0;
        let neighbours = |i: usize, next: &mut Vec<usize>, queued: &mut [bool]| {
            let mut push = |j: usize| {
                if j != slot && !queued[j] {
                    queued[j] = true;
                    next.push(j);
                }
            };
            for &j in lib.gram.row(i).0 {
                push(j as usize);
            }
            if let BgTerms::Ring { q, .. } = &lib.bg {
                for &j in q.row(i).0 {
                    push(j as usize);
                }
            }
        };
        let mut active = Vec::new();
        neighbours(slot, &mut active, &mut queued);
        let mut next = Vec::new();
        for _ in 0..self.cfg.max_sweeps {
            if active.is_empty() {
                break;
            }
            for &i in &active {
                queued[i] = false;
            }
            for &i in &active {
                if !seen[i] {
                    seen[i] = true;
                    saved.push((i, self.c[i]));
                }
                let d = self.update(lib, i);
                if d.abs() >= self.cfg.tol * lib.trace_noise[i].max(f32::MIN_POSITIVE) {
                    // Itself too: an over-relaxed step is not its minimum.
                    if !queued[i] {
                        queued[i] = true;
                        next.push(i);
                    }
                    neighbours(i, &mut next, &mut queued);
                }
            }
            std::mem::swap(&mut active, &mut next);
            next.clear();
        }
        for &(i, old) in &saved {
            if self.c[i] != old {
                out.push((i, self.c[i]));
            }
            self.c[i] = old;
        }
        Ok(())
    }

    /// Block-coordinate descent over overlap groups; returns the sweeps used.
    fn solve(&mut self, lib: &Library) -> u32 {
        let tol = self.cfg.tol;
        let k = self.q.len();
        self.active.iter_mut().for_each(|a| *a = true);
        let mut sweeps = 0;
        while sweeps < self.cfg.max_sweeps {
            sweeps += 1;
            let mut any = false;
            for (g, members) in lib.groups.iter().enumerate() {
                if !self.active[g] {
                    continue;
                }
                any = true;
                let mut worst = 0.0f32;
                for &i in members {
                    let i = i as usize;
                    let d = self.update(lib, i);
                    worst = worst.max(d.abs() / lib.trace_noise[i].max(f32::MIN_POSITIVE));
                }
                if worst < tol {
                    self.active[g] = false;
                    if k > 0 {
                        self.q_snap[g * k..(g + 1) * k].copy_from_slice(&self.q);
                    }
                }
            }
            if !any {
                break;
            }
            // The background couples every group: wake a converged group when
            // the background moved enough to shift one of its cells by `tol`.
            if let BgTerms::Basis { w, .. } = &lib.bg {
                for (g, members) in lib.groups.iter().enumerate() {
                    if self.active[g] {
                        continue;
                    }
                    let snap = &self.q_snap[g * k..(g + 1) * k];
                    let wake = members.iter().any(|&i| {
                        let i = i as usize;
                        let s: f64 = (0..k)
                            .map(|a| f64::from(w[i * k + a]) * (self.q[a] - snap[a]))
                            .sum();
                        (s as f32).abs() / lib.mdiag[i]
                            >= tol * lib.trace_noise[i].max(f32::MIN_POSITIVE)
                    });
                    if wake {
                        self.active[g] = true;
                    }
                }
            }
        }
        sweeps
    }

    /// Exact minimisation over `c_i` (background re-solved); returns the step.
    #[inline]
    fn update(&mut self, lib: &Library, i: usize) -> f32 {
        let (cols, vals) = lib.gram.row(i);
        let mut gc = lib.gram_diag[i] * self.c[i];
        for (&j, &g) in cols.iter().zip(vals) {
            gc += g * self.c[j as usize];
        }
        let mut grad = self.b[i] - gc;
        match &lib.bg {
            BgTerms::Basis { k, x, w, .. } => {
                let k = *k;
                let s: f64 = (0..k).map(|a| f64::from(w[i * k + a]) * self.q[a]).sum();
                grad -= s as f32;
                let new = (self.c[i] + self.cfg.relax * grad / lib.mdiag[i]).max(0.0);
                let d = new - self.c[i];
                if d != 0.0 {
                    self.c[i] = new;
                    for a in 0..k {
                        self.q[a] -= f64::from(x[i * k + a]) * f64::from(d);
                    }
                }
                d
            }
            BgTerms::Ring { s, q, .. } => {
                let (qc, qv) = q.row(i);
                let mut local = self.ring[i];
                for (&j, &v) in qc.iter().zip(qv) {
                    local -= v * self.c[j as usize];
                }
                grad -= s[i] * local;
                let new = (self.c[i] + self.cfg.relax * grad / lib.mdiag[i]).max(0.0);
                let d = new - self.c[i];
                self.c[i] = new;
                d
            }
            BgTerms::None => {
                let new = (self.c[i] + self.cfg.relax * grad / lib.mdiag[i]).max(0.0);
                let d = new - self.c[i];
                self.c[i] = new;
                d
            }
        }
    }
}
