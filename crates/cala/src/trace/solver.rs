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
    active: Vec<bool>,
    next_frame: u64,
}

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
            active: Vec::new(),
            next_frame: 0,
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
    pub fn process_into(&mut self, frame: &[f32], out: &mut FrameTraces) -> Result<(), TraceError> {
        let lib = self.lib.clone();
        let lib = &*lib;
        let n_px = lib.dims().pixels();
        check_len("frame", n_px, frame.len())?;
        let n = lib.len();
        // Projections onto the filtered footprints.
        for i in 0..n {
            let (p, v) = lib.filtered(i);
            let mut s = 0.0f32;
            for (&q, &a) in p.iter().zip(v) {
                s += a * frame[q as usize];
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
        out.sweeps = sweeps;
        self.next_frame += 1;
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
