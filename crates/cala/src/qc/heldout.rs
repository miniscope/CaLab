//! A ground-truth-free quality score from the slow loop's held-out frames.
//!
//! An evaluation tool (`examples/qc_eval.rs` drives it); the fast and slow
//! loops do not use it. It supersedes [`super::GlobalQc::explained`] as
//! the run-level quality axis: `explained` rewards any column that soaks up
//! light, a cell-shaped patch of structured noise included.
//!
//! # Definition (overhaul plan, section 3.3)
//!
//! On every frame `t` the slow loop holds out (never fits a footprint on),
//! with the library `L_t` that was published before the slow loop saw `t`
//! and the fast loop's solve for it:
//!
//! ```text
//! χ²_t(L)  = Σ_p ((y_t(p) − (model of L)_t(p)) / σ_p)²   over FOV pixels
//! s²       = running median of χ²_t(L_t) / dof            (dof = FOV pixels)
//! G_t      = (χ²_t(∅) − χ²_t(L_t)) / s²                   (held-out gain)
//! ```
//!
//! The model is what the slow loop subtracts ([`Library::render`]: the
//! cells, plus the basis background when there is one; the ring level is
//! not rendered).
//!
//! **Placebo columns.** The trace of each column is fitted on the frame it
//! is scored on, so any non-negative column gains on every frame, a column
//! on pure structured noise included; a white-noise null for that gain is
//! wrong by the residual's spatial correlation (5–12× on real data). The
//! null is measured instead: for a random share of the cells, redrawn for
//! every library version (and every `redraw_frames` held-out frames), the
//! footprint is translated by `2d` in one of the four axis directions (`d`
//! = cell diameter; moved another `d` outward, up to `max_steps` d, while
//! more than 10 % of its energy falls on a cell's core or another placebo)
//! and solved jointly with the library as an extra
//! non-negative column. A placebo's per-frame gain `g_k,t` is its drop-one
//! χ² increase in that augmented solve (0 when its trace is 0). Their sum
//! is taken as the joint gain `χ²_t(L) − χ²_t(L + placebos)` (the placebos
//! barely overlap, so the two agree, and the joint gain costs one render
//! instead of a drop-one refit per placebo).
//!
//! ```text
//! μ_t   = mean_k g_k,t                    (gain a cell-shaped non-cell gets)
//! S     = Σ_t (G_t − k_t μ_t) / |H|       (penalised held-out gain per frame)
//! ```
//!
//! The plan's estimator of `μ` was the median of `g_k,t`; it is 0 (most
//! placebos are clamped at 0 on most frames), so it would not penalise
//! anything. The mean is the expected gain of a non-cell column.
//!
//! **Per cell.** On every `drop_every`-th held-out frame each cell whose
//! trace exceeds `active_sigma` of its trace noise is dropped from the
//! solve (its neighbours re-converge, [`TraceEngine::drop_one`]) and
//! the χ² increase is accumulated: `ho_marginal` is the mean per such
//! frame (a random `max_drops` of the active cells per frame, so the cost
//! is bounded on dense real libraries). The placebos give the same
//! statistic (drop-one gain on frames where the placebo's trace exceeds
//! `active_sigma`, on the same frames, the same cap), pooled per
//! `tile_px` tile (the last `pool_len` samples); `ho_marginal_z =
//! (ho_marginal − median) / (1.4826 · MAD)` of the cell's tile pool (the
//! global pool when the tile has fewer than `min_pool` samples).
//!
//! Everything is in units of `s²`, so the score is comparable across
//! recordings with different noise levels.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use crate::preprocess::Dims;
use crate::trace::{
    check_len, BackgroundModel, Footprint, FrameTraces, Library, LibraryBuilder, LinearFilter,
    SolverConfig, TraceEngine, TraceError,
};

/// Settings of [`HeldOutScore`].
#[derive(Debug, Clone, PartialEq)]
pub struct HeldOutConfig {
    /// Cell diameter `d`, px: the placebo displacement unit.
    pub cell_diameter_px: f32,
    /// Share of the library's cells that get a placebo copy per version.
    pub placebo_share: f32,
    /// A placebo position is rejected while more than this share of its
    /// energy lies on a cell's core or another placebo's.
    pub max_overlap: f32,
    /// A cell's (or placebo's) core: where its footprint is at least this
    /// share of its peak. (Not the support: full-extent supports, zeros
    /// included, cover nearly the whole field of view on real data.)
    pub core_frac: f32,
    /// Farthest placebo displacement, in cell diameters (from 2).
    pub max_steps: u32,
    /// Redraw the placebos after this many held-out frames even when the
    /// library has not changed (a fixed library gets fresh placebos).
    pub redraw_frames: u64,
    /// Drop-one refits of the real cells on every `drop_every`-th held-out
    /// frame (they cost one group solve per active cell).
    pub drop_every: u32,
    /// At most this many drop-one refits per frame for the cells, and as
    /// many for the placebos: a random subset of the active ones.
    pub max_drops: usize,
    /// A cell (or placebo) is active in a frame when its trace exceeds this
    /// many trace-noise σ.
    pub active_sigma: f32,
    /// Side of the tiles the placebo pool is kept per, px.
    pub tile_px: usize,
    /// Samples kept per tile pool (the oldest are forgotten).
    pub pool_len: usize,
    /// Tile pools smaller than this fall back to the global pool.
    pub min_pool: usize,
    /// Held-out frames in the running median `s²`.
    pub s2_window: usize,
    /// Held-out frames per block of the penalty's confidence interval.
    pub block_frames: usize,
    pub seed: u64,
}

impl Default for HeldOutConfig {
    fn default() -> HeldOutConfig {
        HeldOutConfig {
            cell_diameter_px: 10.0,
            placebo_share: 0.25,
            max_overlap: 0.10,
            core_frac: 0.2,
            max_drops: 32,
            max_steps: 6,
            redraw_frames: 300,
            drop_every: 4,
            active_sigma: 2.0,
            tile_px: 128,
            pool_len: 4000,
            min_pool: 50,
            s2_window: 255,
            block_frames: 32,
            seed: 1,
        }
    }
}

/// Aggregates over a span of held-out frames (a checkpoint window or one
/// library version). All gains in units of `s²`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeldOutWindow {
    /// Held-out frames scored.
    pub frames: u64,
    /// Mean `G_t`.
    pub gain_per_frame: f64,
    /// Mean library size `k_t`.
    pub cells: f64,
    /// Mean placebo count per frame.
    pub placebos: f64,
    /// Mean `μ_t` (per-column placebo gain per frame).
    pub mu: f64,
    /// Mean penalty `k_t μ_t`.
    pub penalty: f64,
    /// `S = gain_per_frame − penalty`.
    pub score: f64,
    /// 95 % half-width of the penalty from the spread of its block means
    /// (`block_frames` held-out frames per block; NaN with < 2 blocks).
    pub penalty_ci: f64,
    /// Library version (version rows) or 0.
    pub version: u64,
    /// First and last frame index passed to [`HeldOutScore::frame`].
    pub first: u64,
    pub last: u64,
}

/// One cell's held-out statistics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeldOutCell {
    pub id: u64,
    /// Mean drop-one gain over its active scored frames (NaN without any).
    pub marginal: f64,
    /// Active scored frames.
    pub frames: u32,
    /// `marginal` against its tile's placebo pool.
    pub marginal_z: f64,
}

#[derive(Debug, Clone, Default)]
struct Acc {
    frames: u64,
    gain: f64,
    cells: f64,
    placebos: f64,
    mu: f64,
    penalty: f64,
    block: (u64, f64),
    blocks: Vec<f64>,
    first: u64,
    last: u64,
}

impl Acc {
    fn push(&mut self, t: u64, g: f64, k: usize, kp: usize, mu: f64, block_len: usize) {
        if self.frames == 0 {
            self.first = t;
        }
        self.last = t;
        self.frames += 1;
        self.gain += g;
        self.cells += k as f64;
        self.placebos += kp as f64;
        self.mu += mu;
        let pen = k as f64 * mu;
        self.penalty += pen;
        self.block.0 += 1;
        self.block.1 += pen;
        if self.block.0 as usize >= block_len {
            self.blocks.push(self.block.1 / self.block.0 as f64);
            self.block = (0, 0.0);
        }
    }

    fn finish(&self, version: u64) -> HeldOutWindow {
        let n = self.frames as f64;
        if self.frames == 0 {
            return HeldOutWindow {
                version,
                gain_per_frame: f64::NAN,
                cells: f64::NAN,
                placebos: f64::NAN,
                mu: f64::NAN,
                penalty: f64::NAN,
                score: f64::NAN,
                penalty_ci: f64::NAN,
                ..HeldOutWindow::default()
            };
        }
        let nb = self.blocks.len();
        let penalty_ci = if nb >= 2 {
            let mean = self.blocks.iter().sum::<f64>() / nb as f64;
            let var = self.blocks.iter().map(|b| (b - mean).powi(2)).sum::<f64>() / (nb - 1) as f64;
            1.96 * (var / nb as f64).sqrt()
        } else {
            f64::NAN
        };
        HeldOutWindow {
            frames: self.frames,
            gain_per_frame: self.gain / n,
            cells: self.cells / n,
            placebos: self.placebos / n,
            mu: self.mu / n,
            penalty: self.penalty / n,
            score: (self.gain - self.penalty) / n,
            penalty_ci,
            version,
            first: self.first,
            last: self.last,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct CellAcc {
    sum: f64,
    n: u32,
    center: (f32, f32),
}

/// The augmented library of one version and its engine.
struct Placebos {
    version: u64,
    drawn_at: u64,
    engine: TraceEngine,
    /// First placebo slot (the real cells come first, in library order).
    first: usize,
    centers: Vec<(f32, f32)>,
}

/// Held-out score state; feed it every held-out frame with
/// [`HeldOutScore::frame`].
pub struct HeldOutScore {
    cfg: HeldOutConfig,
    dims: Dims,
    fov: Vec<u8>,
    noise: Vec<f32>,
    inv_sigma: Vec<f32>,
    dof: f64,
    rng: u64,
    placebos: Option<Placebos>,
    s2: VecDeque<f32>,
    model: Vec<f32>,
    resid: Vec<f32>,
    dm: Vec<f32>,
    deltas: Vec<(usize, f32)>,
    coefs: Vec<(usize, f32)>,
    occupied: Vec<u8>,
    scored: u64,
    window: Acc,
    version: (u64, Acc),
    versions: Vec<HeldOutWindow>,
    cells: HashMap<u64, CellAcc>,
    pools: Vec<VecDeque<f32>>,
    global_pool: VecDeque<f32>,
    pool_w: usize,
    /// Wall time spent in [`HeldOutScore::frame`], s.
    pub seconds: f64,
    /// Wall time by stage, s: library gain, real-cell drop-one, placebo
    /// library builds, placebo solve, placebo gains.
    pub split: [f64; 5],
    /// Placebos asked for and placed (summed over versions).
    pub placebo_counts: (u64, u64),
}

impl HeldOutScore {
    /// `fov`: the lit field-of-view mask; `noise`: the per-pixel σ map the
    /// slow loop whitens with (replace it with [`HeldOutScore::set_noise`]
    /// whenever the slow loop's is).
    pub fn new(
        dims: Dims,
        fov: Vec<u8>,
        noise: Vec<f32>,
        cfg: HeldOutConfig,
    ) -> Result<HeldOutScore, TraceError> {
        check_len("fov mask", dims.pixels(), fov.len())?;
        if !(cfg.cell_diameter_px > 0.0
            && cfg.placebo_share >= 0.0
            && cfg.placebo_share <= 1.0
            && cfg.drop_every >= 1
            && cfg.tile_px >= 1
            && cfg.s2_window >= 1
            && cfg.block_frames >= 1)
        {
            return Err(TraceError::InvalidConfig(format!("{cfg:?}")));
        }
        let n_px = dims.pixels();
        let pool_w = dims.width.div_ceil(cfg.tile_px);
        let n_tiles = pool_w * dims.height.div_ceil(cfg.tile_px);
        let mut s = HeldOutScore {
            rng: cfg.seed ^ 0x9e37_79b9_7f4a_7c15,
            cfg,
            dims,
            fov,
            noise: Vec::new(),
            inv_sigma: Vec::new(),
            dof: 0.0,
            placebos: None,
            s2: VecDeque::new(),
            model: vec![0.0; n_px],
            resid: vec![0.0; n_px],
            dm: vec![0.0; n_px],
            deltas: Vec::new(),
            coefs: Vec::new(),
            occupied: vec![0; n_px],
            scored: 0,
            window: Acc::default(),
            version: (u64::MAX, Acc::default()),
            versions: Vec::new(),
            cells: HashMap::new(),
            pools: vec![VecDeque::new(); n_tiles],
            global_pool: VecDeque::new(),
            pool_w,
            seconds: 0.0,
            split: [0.0; 5],
            placebo_counts: (0, 0),
        };
        s.set_noise(noise)?;
        Ok(s)
    }

    pub fn config(&self) -> &HeldOutConfig {
        &self.cfg
    }

    /// Replace the noise map. The placebo library is rebuilt at the next
    /// frame (its trace-noise units follow the map).
    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
        check_len("noise map", self.dims.pixels(), noise.len())?;
        self.inv_sigma = noise
            .iter()
            .zip(&self.fov)
            .map(|(&s, &m)| {
                if m != 0 && s.is_finite() && s > 0.0 {
                    1.0 / s
                } else {
                    0.0
                }
            })
            .collect();
        self.dof = self.inv_sigma.iter().filter(|&&v| v > 0.0).count().max(1) as f64;
        self.noise = noise
            .iter()
            .map(|&s| if s.is_finite() && s > 0.0 { s } else { 0.0 })
            .collect();
        Ok(())
    }

    fn rand(&mut self) -> u64 {
        self.rng = self.rng.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn tile(&self, c: (f32, f32)) -> usize {
        let ty = (c.0.max(0.0) as usize / self.cfg.tile_px).min(self.pools.len() / self.pool_w - 1);
        let tx = (c.1.max(0.0) as usize / self.cfg.tile_px).min(self.pool_w - 1);
        ty * self.pool_w + tx
    }

    /// Score one held-out frame. `engine` must have just solved `frame`
    /// with `lib` (its result is `traces`); it is used for the drop-one
    /// refits and left unchanged. `filter` is the preprocessing high-pass
    /// the library was built with. `t` labels the frame in the outputs.
    pub fn frame(
        &mut self,
        t: u64,
        frame: &[f32],
        lib: &Arc<Library>,
        traces: &FrameTraces,
        engine: &mut TraceEngine,
        filter: &mut dyn LinearFilter,
    ) -> Result<(), TraceError> {
        let t0 = Instant::now();
        let n_px = self.dims.pixels();
        check_len("frame", n_px, frame.len())?;
        if traces.library_version != lib.version() || !Arc::ptr_eq(engine.library(), lib) {
            return Err(TraceError::Incompatible(
                "traces / engine do not come from this library".into(),
            ));
        }
        // Held-out gain of the library.
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        lib.render(&traces.traces, bg, &mut self.model)?;
        let (mut chi0, mut chil) = (0.0f64, 0.0f64);
        for p in 0..n_px {
            let is = self.inv_sigma[p];
            if is > 0.0 && frame[p].is_finite() {
                let r = frame[p] - self.model[p];
                self.resid[p] = r;
                chi0 += f64::from(frame[p] * is).powi(2);
                chil += f64::from(r * is).powi(2);
            } else {
                self.resid[p] = 0.0;
            }
        }
        self.s2.push_back((chil / self.dof) as f32);
        if self.s2.len() > self.cfg.s2_window {
            self.s2.pop_front();
        }
        let s2 = {
            let mut v: Vec<f32> = self.s2.iter().copied().collect();
            let m = v.len() / 2;
            f64::from(*v.select_nth_unstable_by(m, f32::total_cmp).1).max(1e-12)
        };
        let g = (chi0 - chil) / s2;
        let k = lib.len();

        // Real cells: drop-one gains on every `drop_every`-th held-out frame.
        self.split[0] += t0.elapsed().as_secs_f64();
        let t1 = Instant::now();
        if self.scored.is_multiple_of(u64::from(self.cfg.drop_every)) {
            let tn = lib.trace_noise();
            let mut act: Vec<usize> = (0..k)
                .filter(|&i| {
                    let c = traces.traces[i];
                    c > 0.0 && c > self.cfg.active_sigma * tn[i]
                })
                .collect();
            self.subsample(&mut act);
            for slot in act {
                let gain = self.drop_gain(engine, lib, traces, slot)? / s2;
                let e = self.cells.entry(lib.ids()[slot]).or_default();
                e.sum += gain;
                e.n += 1;
                e.center = lib.support(slot).0;
            }
        }

        self.split[1] += t1.elapsed().as_secs_f64();
        let t2 = Instant::now();
        // Placebos: the augmented solve and each placebo's drop-one gain.
        let need = self.placebos.as_ref().is_none_or(|p| {
            p.version != lib.version() || self.scored >= p.drawn_at + self.cfg.redraw_frames
        });
        if need {
            self.build_placebos(lib, filter)?;
        }
        self.split[2] += t2.elapsed().as_secs_f64();
        let t3 = Instant::now();
        let mut pl = self.placebos.take().expect("built above");
        let ptr = pl.engine.process(frame)?;
        self.split[3] += t3.elapsed().as_secs_f64();
        let t4 = Instant::now();
        let plib = pl.engine.library().clone();
        let pbg = match plib.background_model() {
            BackgroundModel::Basis(_) => Some(ptr.background.as_slice()),
            _ => None,
        };
        plib.render(&ptr.traces, pbg, &mut self.model)?;
        let mut chip = 0.0f64;
        for p in 0..n_px {
            let is = self.inv_sigma[p];
            self.resid[p] = if is > 0.0 && frame[p].is_finite() {
                let r = frame[p] - self.model[p];
                chip += f64::from(r * is).powi(2);
                r
            } else {
                0.0
            };
        }
        // All placebos' joint gain (they barely overlap, so it is the sum of
        // their own gains); the per-placebo drop-one gain only where the
        // placebo is active, for the per-cell pool.
        let kp = plib.len() - pl.first;
        let sum = (chil - chip) / s2;
        let drop_frame = self.scored.is_multiple_of(u64::from(self.cfg.drop_every));
        let mut act: Vec<usize> = (0..kp)
            .filter(|_| drop_frame)
            .filter(|&j| {
                let c = ptr.traces[pl.first + j];
                c > 0.0 && c > self.cfg.active_sigma * plib.trace_noise()[pl.first + j]
            })
            .collect();
        self.subsample(&mut act);
        for j in act {
            let slot = pl.first + j;
            {
                let gain = self.drop_gain(&mut pl.engine, &plib, &ptr, slot)? / s2;
                let ti = self.tile(pl.centers[j]);
                let pool = &mut self.pools[ti];
                pool.push_back(gain as f32);
                if pool.len() > self.cfg.pool_len {
                    pool.pop_front();
                }
                self.global_pool.push_back(gain as f32);
                if self.global_pool.len() > 4 * self.cfg.pool_len {
                    self.global_pool.pop_front();
                }
            }
        }
        self.placebos = Some(pl);
        self.split[4] += t4.elapsed().as_secs_f64();
        let mu = if kp > 0 { sum / kp as f64 } else { 0.0 };
        let bl = self.cfg.block_frames;
        self.window.push(t, g, k, kp, mu, bl);
        if self.version.0 != lib.version() {
            if self.version.1.frames > 0 {
                let row = self.version.1.finish(self.version.0);
                self.versions.push(row);
            }
            self.version = (lib.version(), Acc::default());
        }
        self.version.1.push(t, g, k, kp, mu, bl);
        self.scored += 1;
        self.seconds += t0.elapsed().as_secs_f64();
        Ok(())
    }

    /// Keep a random `max_drops` of `v` (a uniform subset; the per-cell
    /// means stay unbiased, the cost per frame is bounded).
    fn subsample(&mut self, v: &mut Vec<usize>) {
        let m = self.cfg.max_drops;
        if v.len() > m {
            for i in 0..m {
                let j = i + (self.rand() % (v.len() - i) as u64) as usize;
                v.swap(i, j);
            }
            v.truncate(m);
        }
    }

    /// χ² increase (unnormalised) when `slot` is dropped from `engine`'s
    /// last solve; `self.resid` must hold that solve's residual.
    fn drop_gain(
        &mut self,
        engine: &mut TraceEngine,
        lib: &Library,
        traces: &FrameTraces,
        slot: usize,
    ) -> Result<f64, TraceError> {
        engine.drop_one(slot, &mut self.deltas)?;
        // Model change: before − after, so the new residual is r + δm.
        // Changes below the solver's own tolerance (`SolverConfig::tol` =
        // 0.05 trace σ) are noise of the refit; drawing their moats would
        // make the touched box most of the frame.
        let tn = lib.trace_noise();
        let cut = 0.5 * engine.config().tol;
        self.coefs.clear();
        self.coefs
            .extend(self.deltas.iter().filter_map(|&(j, new)| {
                let d = traces.traces[j] - new;
                (j == slot || d.abs() >= cut * tn[j]).then_some((j, d))
            }));
        let (y0, y1, x0, x1) = lib.add_columns(&self.coefs, &mut self.dm)?;
        let w = self.dims.width;
        let mut d = 0.0f64;
        for y in y0..y1 {
            for x in x0..x1 {
                let p = y * w + x;
                let dm = self.dm[p];
                if dm != 0.0 {
                    let is = self.inv_sigma[p];
                    d += f64::from((2.0 * self.resid[p] + dm) * dm * is * is);
                    self.dm[p] = 0.0;
                }
            }
        }
        Ok(d)
    }

    /// Draw this version's placebos and build the augmented library.
    fn build_placebos(
        &mut self,
        lib: &Arc<Library>,
        filter: &mut dyn LinearFilter,
    ) -> Result<(), TraceError> {
        let dims = self.dims;
        let w = dims.width;
        let k = lib.len();
        let mut b = LibraryBuilder::new(dims)
            .fov(self.fov.clone())
            .noise(self.noise.clone())
            .background(lib.background_model().clone())
            .reuse(lib.clone());
        self.occupied.iter_mut().for_each(|v| *v = 0);
        let mut fps: Vec<(Footprint, (f32, f32), f32)> = Vec::with_capacity(k);
        for slot in 0..k {
            let (pix, raw) = lib.unfiltered(slot);
            let (center, radius) = lib.support(slot);
            let peak = raw.iter().copied().fold(0.0f32, f32::max);
            for (&q, &v) in pix.iter().zip(raw) {
                if v > 0.0 && v >= self.cfg.core_frac * peak {
                    self.occupied[q as usize] = 1;
                }
            }
            fps.push((
                patch(lib.ids()[slot], pix, raw, (0, 0), dims),
                center,
                radius,
            ));
        }
        // Which cells get a placebo: a random `placebo_share` of them.
        let n_pl = (self.cfg.placebo_share * k as f32).round() as usize;
        let mut order: Vec<usize> = (0..k).collect();
        for i in (1..k).rev() {
            let j = (self.rand() % (i as u64 + 1)) as usize;
            order.swap(i, j);
        }
        let d = self.cfg.cell_diameter_px;
        let mut placed: Vec<(Footprint, (f32, f32), f32)> = Vec::new();
        for &slot in order.iter().take(n_pl) {
            let (pix, raw) = lib.unfiltered(slot);
            let energy: f32 = raw.iter().map(|v| v * v).sum();
            if energy <= 0.0 {
                continue;
            }
            let (center, radius) = lib.support(slot);
            let dir0 = (self.rand() % 4) as usize;
            let mut found = None;
            'dirs: for dd in 0..4 {
                let (uy, ux) = [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)][(dir0 + dd) % 4];
                for step in 2..=self.cfg.max_steps.max(2) {
                    let s = (step as f32 * d).round() as i32;
                    let (sy, sx) = (uy * s, ux * s);
                    let mut over = 0.0f32;
                    let mut inside = 0.0f32;
                    let mut ok = true;
                    for (&q, &v) in pix.iter().zip(raw) {
                        let (y, x) = ((q as usize / w) as i32 + sy, (q as usize % w) as i32 + sx);
                        if y < 0 || x < 0 || y >= dims.height as i32 || x >= w as i32 {
                            if v > 0.0 {
                                ok = false;
                                break;
                            }
                            continue;
                        }
                        let p = y as usize * w + x as usize;
                        if self.fov[p] != 0 {
                            inside += v * v;
                        }
                        if self.occupied[p] != 0 {
                            over += v * v;
                        }
                    }
                    if !ok || inside < 0.9 * energy {
                        continue 'dirs;
                    }
                    if over <= self.cfg.max_overlap * energy {
                        found = Some((sy, sx));
                        break 'dirs;
                    }
                }
            }
            let Some((sy, sx)) = found else {
                continue;
            };
            let id = u64::MAX - placed.len() as u64;
            let fp = patch(id, pix, raw, (sy, sx), dims);
            let peak = fp.values.iter().copied().fold(0.0f32, f32::max);
            for y in fp.y0..fp.y0 + fp.height {
                for x in fp.x0..fp.x0 + fp.width {
                    let v = fp.values[(y - fp.y0) * fp.width + (x - fp.x0)];
                    if v > 0.0 && v >= self.cfg.core_frac * peak {
                        self.occupied[y * w + x] = 1;
                    }
                }
            }
            let c = (center.0 + sy as f32, center.1 + sx as f32);
            placed.push((fp, c, radius));
        }
        self.placebo_counts.0 += n_pl as u64;
        self.placebo_counts.1 += placed.len() as u64;
        let centers: Vec<(f32, f32)> = placed.iter().map(|p| p.1).collect();
        for (fp, c, r) in fps.into_iter().chain(placed) {
            b.push_disk(fp, c, r);
        }
        let plib = Arc::new(b.build(filter)?);
        let engine = match self.placebos.take() {
            Some(mut p) => {
                p.engine.set_library(plib)?;
                p.engine
            }
            None => TraceEngine::new(plib, SolverConfig::default())?,
        };
        self.placebos = Some(Placebos {
            version: lib.version(),
            drawn_at: self.scored,
            engine,
            first: k,
            centers,
        });
        Ok(())
    }

    /// Aggregates since the last call (a checkpoint window), and reset.
    pub fn take_window(&mut self) -> HeldOutWindow {
        let w = self.window.finish(0);
        self.window = Acc::default();
        w
    }

    /// One row per finished library version (the current one included when
    /// `include_current`).
    pub fn versions(&self, include_current: bool) -> Vec<HeldOutWindow> {
        let mut v = self.versions.clone();
        if include_current && self.version.1.frames > 0 {
            v.push(self.version.1.finish(self.version.0));
        }
        v
    }

    /// Held-out frames scored so far.
    pub fn scored(&self) -> u64 {
        self.scored
    }

    /// Per-cell statistics for the given ids (cells never scored get NaN).
    pub fn cells(&self, ids: &[u64]) -> Vec<HeldOutCell> {
        let stats = |v: &VecDeque<f32>| -> Option<(f64, f64)> {
            if v.is_empty() {
                return None;
            }
            let mut s: Vec<f32> = v.iter().copied().collect();
            let m = s.len() / 2;
            let med = *s.select_nth_unstable_by(m, f32::total_cmp).1;
            let mut dev: Vec<f32> = s.iter().map(|x| (x - med).abs()).collect();
            let mad = *dev.select_nth_unstable_by(m, f32::total_cmp).1;
            Some((f64::from(med), (1.4826 * f64::from(mad)).max(1e-9)))
        };
        let global = stats(&self.global_pool);
        let tiles: Vec<Option<(f64, f64)>> = self
            .pools
            .iter()
            .map(|p| {
                if p.len() >= self.cfg.min_pool {
                    stats(p)
                } else {
                    global
                }
            })
            .collect();
        ids.iter()
            .map(|&id| match self.cells.get(&id) {
                Some(a) if a.n > 0 => {
                    let marginal = a.sum / f64::from(a.n);
                    let z = tiles[self.tile(a.center)]
                        .map_or(f64::NAN, |(med, sd)| (marginal - med) / sd);
                    HeldOutCell {
                        id,
                        marginal,
                        frames: a.n,
                        marginal_z: z,
                    }
                }
                _ => HeldOutCell {
                    id,
                    marginal: f64::NAN,
                    frames: 0,
                    marginal_z: f64::NAN,
                },
            })
            .collect()
    }

    /// Size of the global placebo pool (active placebo samples kept).
    pub fn pool_len(&self) -> usize {
        self.global_pool.len()
    }
}

/// The footprint `(pix, raw)` translated by `shift` as a bounding-box patch
/// (pixels that leave the frame are dropped).
fn patch(id: u64, pix: &[u32], raw: &[f32], shift: (i32, i32), dims: Dims) -> Footprint {
    let w = dims.width;
    let pts: Vec<(usize, usize, f32)> = pix
        .iter()
        .zip(raw)
        .filter_map(|(&q, &v)| {
            let y = (q as usize / w) as i32 + shift.0;
            let x = (q as usize % w) as i32 + shift.1;
            (y >= 0 && x >= 0 && (y as usize) < dims.height && (x as usize) < w)
                .then_some((y as usize, x as usize, v))
        })
        .collect();
    let y0 = pts.iter().map(|p| p.0).min().unwrap_or(0);
    let y1 = pts.iter().map(|p| p.0).max().unwrap_or(0);
    let x0 = pts.iter().map(|p| p.1).min().unwrap_or(0);
    let x1 = pts.iter().map(|p| p.1).max().unwrap_or(0);
    let (h, wd) = (y1 - y0 + 1, x1 - x0 + 1);
    let mut values = vec![0.0f32; h * wd];
    for (y, x, v) in pts {
        values[(y - y0) * wd + (x - x0)] = v;
    }
    Footprint {
        id,
        y0,
        x0,
        height: h,
        width: wd,
        values,
    }
}

#[cfg(test)]
mod tests;
