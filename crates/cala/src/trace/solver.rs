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
}

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
        let r = if self.impute(lib, frame, &mut filled) {
            let mut r = Ok(());
            for pass in 0..EM_PASSES {
                self.c_em.clear();
                self.c_em.extend_from_slice(&self.c);
                r = self.solve_frame(lib, &filled, out);
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
                self.impute(lib, frame, &mut filled);
            }
            r
        } else {
            self.solve_frame(lib, frame, out)
        };
        self.filled = filled;
        self.next_frame += 1;
        r
    }

    /// Fill the missing (non-finite) pixels of `frame` into `filled` with the
    /// prediction of the warm start; `false` (and `filled` untouched) when
    /// nothing is missing.
    fn impute(&mut self, lib: &Library, frame: &[f32], filled: &mut Vec<f32>) -> bool {
        self.missing.clear();
        for (i, v) in frame.iter().enumerate() {
            if !v.is_finite() {
                self.missing.push(i as u32);
            }
        }
        if self.missing.is_empty() {
            return false;
        }
        let n_px = frame.len();
        filled.clear();
        filled.extend_from_slice(frame);
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
        true
    }

    fn solve_frame(
        &mut self,
        lib: &Library,
        frame: &[f32],
        out: &mut FrameTraces,
    ) -> Result<(), TraceError> {
        let n_px = lib.dims().pixels();
        let n = lib.len();
        // Projections onto the filtered footprints: the support part, minus
        // the moat's block means against the frame's block sums.
        let gl = lib.grid_len();
        if gl > 0 {
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
        for i in 0..n {
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
                for a in 0..k {
                    let m = &maps[a * n_px..(a + 1) * n_px];
                    let mut s = 0.0f64;
                    for (cm, cf) in m.chunks(4096).zip(frame.chunks(4096)) {
                        let mut acc = 0.0f32;
                        for (&g, &y) in cm.iter().zip(cf) {
                            acc += g * y;
                        }
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
