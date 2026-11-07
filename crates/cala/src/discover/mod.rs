//! The slow loop: streaming cell discovery (add, merge, refine).
//!
//! The fast loop ([`crate::trace`]) solves every frame for the traces of a
//! fixed footprint [`Library`]. The slow loop watches what that library
//! leaves unexplained and proposes structural edits: **add** a cell where
//! the residual holds a compact, recurring signal; **merge** two cells that
//! are one cell (overlapping, correlated); **refine** a footprint from the
//! frames where it is active. Each edit is a hypothesis tested on frames it
//! was not fitted on, and accepted edits are published as a new immutable
//! library version that the driver swaps into the fast loop between frames
//! ([`TraceEngine::set_library`](crate::trace::TraceEngine::set_library)).
//!
//! # Data flow
//!
//! * [`SlowLoop::observe`] (every frame, cheap): the residual `y − Σ ã_i c_i`
//!   of the fast loop, whitened by the noise map, block-averaged 2 x 2 and
//!   blurred to cell scale, gives each tile (64 px squares) a score, the
//!   largest residual excursion in noise units (robust scale per frame).
//!   The tile's **reservoir** keeps the whitened patch (tile + 24 px margin)
//!   of high-scoring frames (event slots whose priority halves every
//!   `event_half_life_frames`, so late-born cells' events displace old ones)
//!   plus a uniform sample of all frames (random slots), within a byte
//!   budget.
//! * [`SlowLoop::step`] (budgeted): visits the tile with the most new frames.
//!   On its patches, a [`local::Problem`] solves the working set's cells plus
//!   a smooth 3 x 3 bump background exactly (non-negative traces) and gives
//!   whitened residuals and χ² values. Frames are split once, by a hash of
//!   the frame index, into fitting frames and held-out frames.
//!
//! # Edits
//!
//! * **Add.** The residual of the fitting frames, blurred to cell scale, is
//!   summed over significant excursions; at its peak a rank-1 factorisation
//!   `r_t ≈ h c_t` (c ≥ 0) is fitted on a *small* disk (0.75 cell diameters):
//!   detect small, merge later. `h` is a filtered footprint; the unfiltered
//!   footprint `a ≥ 0` with `H a ≈ h` comes from projected gradient through
//!   the same high-pass the preprocessing applies (`a − G_σ * a`, exact away
//!   from the lens edge), normalised to peak 1, cut to the library's support
//!   disk. The candidate is accepted when, on the **held-out** frames, adding
//!   its column lowers χ² by more than adding a column of pure noise would
//!   (0.5 per frame for a non-negative coefficient, variance 1.25 per frame)
//!   by `accept_z` standard deviations, and its trace exceeds `event_z`
//!   noise σ on at least `min_events` held-out frames. Thresholds are in
//!   noise units throughout, never raw intensity.
//! * **Merge.** Two cells whose supports overlap and whose traces correlate
//!   over the fitting frames are refitted as one (rank 1 on the union of the
//!   supports, from the residual plus both cells' fitted signal). The merge
//!   is accepted unless keeping them separate beats it on held-out frames by
//!   the same margin an add needs, so add and merge share one test.
//! * **Refine.** Each cell's footprint is re-estimated on a disk 2 px wider
//!   than its support, from the residual plus its own signal over the
//!   fitting frames where its trace is above 2 σ (activity-gated), and kept
//!   if held-out χ² improves.
//!
//! Accepted edits update the slow loop's working set at once (so the next
//! proposal on that tile sees them: no re-detection of the same signal) and
//! are published at most every `commit_interval_frames`. Rejected spots are
//! suppressed for a cooldown that doubles with each rejection.
//!
//! # Threading
//!
//! The slow loop is a plain struct with no clock: `step(budget)` spends a
//! work budget (approximately multiply-adds) with carry-over, so a single
//! WASM worker can interleave it with the fast loop deterministically, and
//! it could move to its own worker by sending it frames.

mod local;
mod reservoir;

use std::sync::Arc;

use local::{rank1, BgBasis, Cell, Column, Fit, LocalFilter, Problem, Rect};
use reservoir::{mix, Slot, Tile};

use crate::preprocess::flatten::GlowFlattener;
use crate::preprocess::gaussian::RecursiveGaussian;
use crate::preprocess::Dims;
use crate::trace::{
    BackgroundModel, Footprint, FrameTraces, Library, LibraryBuilder, LibraryConfig, LinearFilter, TraceError,
};

/// Settings of the slow loop. Pixel sizes follow the expected cell diameter.
#[derive(Debug, Clone, PartialEq)]
pub struct SlowLoopConfig {
    /// Expected soma diameter, px (the preprocessing's `cell_diameter_px`).
    pub cell_diameter_px: f32,
    /// Tile side, px.
    pub tile_px: usize,
    /// Extra margin stored around each tile, px (at least the largest
    /// support radius, so a cell centred in the tile is inside its patch).
    pub margin_px: usize,
    /// Reservoir budget, bytes.
    pub reservoir_bytes: usize,
    /// Share of each tile's slots that hold a uniform sample of all frames.
    pub random_share: f32,
    /// Event-slot priority halves every this many frames.
    pub event_half_life_frames: f32,
    /// One frame in this many is held out for testing.
    pub holdout_every: u32,
    /// Required held-out χ² improvement over a noise column, in standard
    /// deviations of that null.
    pub accept_z: f32,
    /// A held-out trace value counts as an event above this many σ.
    pub event_z: f32,
    /// Held-out events a new cell needs.
    pub min_events: u32,
    /// Trace correlation (fitting frames) above which a merge is tried.
    pub merge_corr: f32,
    /// Accepted adds per tile visit.
    pub max_adds_per_visit: usize,
    /// Rejected proposals per tile visit before moving on.
    pub max_rejects_per_visit: usize,
    /// Refine footprints on every n-th visit of a tile (0 = never).
    pub refine_every_visits: u32,
    /// Minimum frames between published library versions.
    pub commit_interval_frames: u64,
    /// Base cooldown of a rejected spot, frames.
    pub reject_cooldown_frames: u64,
    /// Fitting / held-out frames a tile needs before it is visited.
    pub min_fit_frames: usize,
    pub min_test_frames: usize,
    /// New slots that make a tile due for a visit.
    pub visit_after_slots: u32,
    pub library: LibraryConfig,
    /// Background model of the published libraries.
    pub background: BackgroundModel,
    pub seed: u64,
}

impl Default for SlowLoopConfig {
    fn default() -> SlowLoopConfig {
        SlowLoopConfig {
            cell_diameter_px: 10.0,
            tile_px: 64,
            margin_px: 24,
            reservoir_bytes: 256 << 20,
            random_share: 0.3,
            event_half_life_frames: 2000.0,
            holdout_every: 3,
            accept_z: 5.0,
            event_z: 4.0,
            min_events: 2,
            merge_corr: 0.6,
            max_adds_per_visit: 4,
            max_rejects_per_visit: 3,
            refine_every_visits: 2,
            commit_interval_frames: 100,
            reject_cooldown_frames: 400,
            min_fit_frames: 16,
            min_test_frames: 8,
            visit_after_slots: 6,
            library: LibraryConfig::default(),
            background: BackgroundModel::Ring {
                inner_px: 12.0,
                outer_px: 20.0,
            },
            seed: 0,
        }
    }
}

impl SlowLoopConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        self.library.validate()?;
        let ok = self.cell_diameter_px.is_finite()
            && self.cell_diameter_px >= 2.0
            && self.tile_px >= 8
            && self.margin_px as f32 >= self.library.max_support_px
            && self.random_share >= 0.0
            && self.random_share < 1.0
            && self.event_half_life_frames > 0.0
            && self.holdout_every >= 2
            && self.accept_z.is_finite()
            && self.event_z.is_finite()
            && self.merge_corr.is_finite()
            && self.min_fit_frames >= 2
            && self.min_test_frames >= 2;
        if ok {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}

/// Counters for diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlowStats {
    pub visits: u64,
    pub proposals: u64,
    pub adds: u64,
    pub rejects: u64,
    pub merges: u64,
    pub merge_tests: u64,
    pub refines: u64,
    pub commits: u64,
    /// Work spent loading frames, refining, merging and adding.
    pub work_load: u64,
    pub work_refine: u64,
    pub work_merge: u64,
    pub work_add: u64,
}

/// The slow loop. See the module docs.
pub struct SlowLoop {
    dims: Dims,
    cfg: SlowLoopConfig,
    fov: Vec<u8>,
    noise: Vec<f32>,
    inv_sigma: Vec<f32>,
    flattener: GlowFlattener,
    filter: LocalFilter,
    detect: LocalFilter,
    smooth: LocalFilter,
    tiles: Vec<Tile>,
    tile_visits: Vec<u32>,
    bgs: Vec<Option<BgBasis>>,
    cap_events: usize,
    cap_random: usize,
    decay: f64,
    cells: Vec<Cell>,
    next_id: u64,
    frames: u64,
    pending: bool,
    last_commit: u64,
    credit: i64,
    work: u64,
    rng: u64,
    published: Option<Arc<Library>>,
    stats: SlowStats,
    // observe() buffers
    model: Vec<f32>,
    z: Vec<f32>,
    coarse: Vec<f32>,
    coarse_blur: Vec<f32>,
    coarse_fov: Vec<bool>,
    coarse_dims: Dims,
    coarse_gauss: RecursiveGaussian,
    sample: Vec<f32>,
}

/// A tile's model solved on its fitting frames.
struct Solved {
    base: Problem,
    fits: Vec<Fit>,
    resid: Vec<Vec<f32>>,
}

/// A tile's frames loaded for a visit.
struct Frames {
    y: Vec<Vec<f32>>,
    proj: Vec<(Vec<f64>, f64)>,
}

impl Frames {
    fn len(&self) -> usize {
        self.y.len()
    }
}

impl SlowLoop {
    /// `flattener` is the preprocessing high-pass (used to build published
    /// libraries); `fov` the FOV mask; `noise` the per-pixel noise σ.
    pub fn new(
        dims: Dims,
        fov: Vec<u8>,
        noise: Vec<f32>,
        flattener: GlowFlattener,
        cfg: SlowLoopConfig,
    ) -> Result<SlowLoop, TraceError> {
        cfg.validate()?;
        let n_px = dims.pixels();
        crate::trace::check_len("fov mask", n_px, fov.len())?;
        if LinearFilter::dims(&flattener) != dims {
            return Err(TraceError::Incompatible("flattener frame size".into()));
        }
        let sigma = flattener.sigma();
        // Tiles over the bounding box of the FOV.
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for (i, &m) in fov.iter().enumerate() {
            if m != 0 {
                let (y, x) = (i / dims.width, i % dims.width);
                ymin = ymin.min(y);
                ymax = ymax.max(y);
                xmin = xmin.min(x);
                xmax = xmax.max(x);
            }
        }
        let mut tiles = Vec::new();
        if ymin <= ymax {
            let t = cfg.tile_px;
            let m = cfg.margin_px;
            let mut y = ymin;
            while y <= ymax {
                let mut x = xmin;
                while x <= xmax {
                    let core = Rect {
                        y0: y,
                        x0: x,
                        h: t.min(ymax + 1 - y),
                        w: t.min(xmax + 1 - x),
                    };
                    let any = (core.y0..core.y0 + core.h).any(|yy| {
                        fov[yy * dims.width + core.x0..yy * dims.width + core.x0 + core.w]
                            .iter()
                            .any(|&v| v != 0)
                    });
                    if any {
                        let y0 = core.y0.saturating_sub(m);
                        let x0 = core.x0.saturating_sub(m);
                        let y1 = (core.y0 + core.h + m).min(dims.height);
                        let x1 = (core.x0 + core.w + m).min(dims.width);
                        let rect = Rect {
                            y0,
                            x0,
                            h: y1 - y0,
                            w: x1 - x0,
                        };
                        tiles.push(Tile::new(core, rect));
                    }
                    x += t;
                }
                y += t;
            }
        }
        let bytes_per_set: usize = tiles.iter().map(|t| t.rect.len() * 2).sum::<usize>().max(1);
        let per_tile = (cfg.reservoir_bytes / bytes_per_set).max(4);
        let cap_random = ((per_tile as f32 * cfg.random_share).round() as usize).max(1);
        let cap_events = per_tile.saturating_sub(cap_random).max(1);
        let coarse_dims = Dims {
            width: dims.width.div_ceil(2),
            height: dims.height.div_ceil(2),
        };
        let mut coarse_fov = vec![false; coarse_dims.pixels()];
        for (i, &m) in fov.iter().enumerate() {
            if m != 0 {
                let (y, x) = (i / dims.width, i % dims.width);
                coarse_fov[(y / 2) * coarse_dims.width + x / 2] = true;
            }
        }
        let coarse_sigma = (cfg.cell_diameter_px / 8.0).max(0.6);
        let coarse_gauss = RecursiveGaussian::new(coarse_dims, coarse_sigma)
            .map_err(|e| TraceError::InvalidConfig(e.to_string()))?;
        let n_tiles = tiles.len();
        let mut s = SlowLoop {
            dims,
            fov,
            noise: Vec::new(),
            inv_sigma: Vec::new(),
            flattener,
            filter: LocalFilter::new(sigma),
            detect: LocalFilter::new((cfg.cell_diameter_px / 4.0).max(0.6)),
            smooth: LocalFilter::new((cfg.cell_diameter_px / 10.0).max(0.6)),
            tiles,
            tile_visits: vec![0; n_tiles],
            bgs: vec![None; n_tiles],
            cap_events,
            cap_random,
            decay: 0.5f64.powf(1.0 / f64::from(cfg.event_half_life_frames)),
            cells: Vec::new(),
            next_id: 1,
            frames: 0,
            pending: false,
            last_commit: 0,
            credit: 0,
            work: 0,
            rng: mix(cfg.seed ^ 0x5eed),
            published: None,
            stats: SlowStats::default(),
            model: vec![0.0; n_px],
            z: vec![0.0; n_px],
            coarse: vec![0.0; coarse_dims.pixels()],
            coarse_blur: vec![0.0; coarse_dims.pixels()],
            coarse_fov,
            coarse_dims,
            coarse_gauss,
            sample: Vec::new(),
            cfg,
        };
        s.set_noise(noise)?;
        Ok(s)
    }

    /// Replace the noise map (σ per pixel). New patches are whitened with it.
    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
        crate::trace::check_len("noise map", self.dims.pixels(), noise.len())?;
        if noise.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(TraceError::InvalidConfig("noise map must be finite and >= 0".into()));
        }
        self.inv_sigma = noise
            .iter()
            .zip(&self.fov)
            .map(|(&s, &m)| if m != 0 && s > 0.0 { 1.0 / s } else { 0.0 })
            .collect();
        self.noise = noise;
        Ok(())
    }

    pub fn config(&self) -> &SlowLoopConfig {
        &self.cfg
    }

    pub fn stats(&self) -> SlowStats {
        self.stats
    }

    /// Cells in the working set (published or not).
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Frames observed so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Work spent so far (approximately multiply-adds).
    pub fn work(&self) -> u64 {
        self.work
    }

    /// Bytes held by the reservoir now, and the per-tile slot counts.
    pub fn reservoir_bytes(&self) -> usize {
        self.tiles.iter().map(Tile::bytes).sum()
    }

    pub fn slots_per_tile(&self) -> (usize, usize) {
        (self.cap_events, self.cap_random)
    }

    /// The last published library.
    pub fn library(&self) -> Option<&Arc<Library>> {
        self.published.as_ref()
    }

    /// Start from existing footprints (unfiltered, `id`s kept), e.g. to
    /// resume or to refine a library from another source. They are cut to
    /// the library's support disks; ones that leave the FOV are dropped.
    /// Returns how many were kept. Published with the next commit.
    pub fn seed(&mut self, footprints: &[Footprint]) -> Result<usize, TraceError> {
        let mut kept = 0;
        for fp in footprints {
            crate::trace::check_len("footprint values", fp.height * fp.width, fp.values.len())?;
            if self.cells.iter().any(|c| c.id == fp.id) {
                return Err(TraceError::InvalidFootprint(format!(
                    "duplicate id {}",
                    fp.id
                )));
            }
            if fp.y0 + fp.height > self.dims.height || fp.x0 + fp.width > self.dims.width {
                return Err(TraceError::InvalidFootprint(format!(
                    "id {}: outside the frame",
                    fp.id
                )));
            }
            let rect = Rect {
                y0: fp.y0,
                x0: fp.x0,
                h: fp.height,
                w: fp.width,
            };
            if let Some(c) = Cell::from_canvas(
                fp.id,
                rect,
                &fp.values,
                self.dims,
                &self.fov,
                &self.cfg.library,
                &mut self.filter,
            ) {
                self.next_id = self.next_id.max(fp.id + 1);
                self.cells.push(c);
                kept += 1;
            }
        }
        self.pending = true;
        Ok(kept)
    }

    /// Feed one preprocessed frame and the fast loop's result for it.
    /// `lib` must be the library that produced `traces`.
    pub fn observe(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<(), TraceError> {
        let n_px = self.dims.pixels();
        crate::trace::check_len("frame", n_px, frame.len())?;
        if lib.dims() != self.dims || traces.library_version != lib.version() {
            return Err(TraceError::Incompatible(
                "traces do not come from this library / frame size".into(),
            ));
        }
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        lib.render(&traces.traces, bg, &mut self.model)?;
        // Whitened frame (stored) and whitened residual (scored).
        let w = self.dims.width;
        let cw = self.coarse_dims.width;
        self.coarse.iter_mut().for_each(|v| *v = 0.0);
        for i in 0..n_px {
            let s = self.inv_sigma[i];
            let y = frame[i];
            self.z[i] = if y.is_finite() { y * s } else { 0.0 };
            let r = if y.is_finite() { (y - self.model[i]) * s } else { 0.0 };
            self.coarse[(i / w / 2) * cw + (i % w) / 2] += 0.25 * r;
        }
        self.coarse_gauss
            .blur(&self.coarse, &mut self.coarse_blur)
            .map_err(TraceError::Preprocess)?;
        // Robust noise scale of the blurred residual (cells are sparse).
        self.sample.clear();
        for (i, &v) in self.coarse_blur.iter().enumerate().step_by(3) {
            if self.coarse_fov[i] {
                self.sample.push(v.abs());
            }
        }
        let scale = if self.sample.is_empty() {
            1.0
        } else {
            let mid = self.sample.len() / 2;
            let (_, m, _) = self.sample.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
            (1.4826 * *m).max(1e-6)
        };
        self.work += (n_px * 4 + self.coarse.len() * 30) as u64;
        let frame_idx = self.frames;
        let test = self.is_test(frame_idx);
        for ti in 0..self.tiles.len() {
            let core = self.tiles[ti].core;
            let mut best = f32::MIN;
            for y in (core.y0 / 2)..(core.y0 + core.h).div_ceil(2) {
                for x in (core.x0 / 2)..(core.x0 + core.w).div_ceil(2) {
                    let i = y * cw + x;
                    if self.coarse_fov[i] {
                        best = best.max(self.coarse_blur[i]);
                    }
                }
            }
            let score = (best / scale).max(0.0);
            self.rng = mix(self.rng);
            let (ce, cr, decay, rand) = (self.cap_events, self.cap_random, self.decay, self.rng);
            let tile = &mut self.tiles[ti];
            let before = tile.events.len() + tile.randoms.len();
            tile.offer(&self.z, w, frame_idx, score, test, ce, cr, decay, rand);
            let _ = before;
        }
        self.frames += 1;
        Ok(())
    }

    fn is_test(&self, frame: u64) -> bool {
        mix(frame ^ self.cfg.seed.rotate_left(17)) % u64::from(self.cfg.holdout_every) == 0
    }

    /// Spend about `budget` work units (multiply-adds; ~1e9/s native) on
    /// tile visits, carrying any overrun into the next call. Returns a new
    /// library when edits were published; swap it into the fast loop.
    pub fn step(&mut self, budget: u64) -> Result<Option<Arc<Library>>, TraceError> {
        self.credit = self.credit.saturating_add(budget as i64);
        while self.credit > 0 {
            let Some(ti) = self.next_tile() else {
                // Nothing to do: idle budget is not banked.
                self.credit = 0;
                break;
            };
            let w0 = self.work;
            self.visit(ti)?;
            self.credit -= (self.work - w0) as i64;
        }
        if self.pending && self.frames >= self.last_commit + self.cfg.commit_interval_frames {
            return self.publish().map(Some);
        }
        Ok(None)
    }

    /// Publish any accepted edits now (end of pass 1).
    pub fn finalize(&mut self) -> Result<Arc<Library>, TraceError> {
        if self.pending || self.published.is_none() {
            return self.publish();
        }
        Ok(self.published.clone().expect("published"))
    }

    fn next_tile(&self) -> Option<usize> {
        let mut best: Option<(usize, u32)> = None;
        for (i, t) in self.tiles.iter().enumerate() {
            if t.fresh < self.cfg.visit_after_slots {
                continue;
            }
            if best.is_none_or(|(_, f)| t.fresh > f) {
                best = Some((i, t.fresh));
            }
        }
        best.map(|b| b.0)
    }

    fn publish(&mut self) -> Result<Arc<Library>, TraceError> {
        let mut b = LibraryBuilder::new(self.dims)
            .config(self.cfg.library)
            .fov(self.fov.clone())
            .noise(self.noise.clone())
            .background(self.cfg.background.clone());
        for c in &self.cells {
            b.push(c.footprint(self.dims));
        }
        let lib = b.build(&mut self.flattener)?;
        // The working set takes the exact filtered columns.
        let w = self.dims.width;
        let mut cells = Vec::with_capacity(lib.len());
        for slot in 0..lib.len() {
            let (center, radius) = lib.support(slot);
            let (pix, raw) = lib.unfiltered(slot);
            let (_, filt) = lib.filtered(slot);
            let bbox = Rect::around(center.0, center.1, radius, self.dims);
            debug_assert!(pix.iter().all(|&g| bbox.local(g as usize / w, g as usize % w).is_some()));
            cells.push(Cell {
                id: lib.ids()[slot],
                center,
                radius,
                bbox,
                pix: pix.to_vec(),
                raw: raw.to_vec(),
                filt: filt.to_vec(),
            });
        }
        self.work += (self.dims.pixels() * 40) as u64 * (1 + lib.len() as u64 / 50);
        self.cells = cells;
        let lib = Arc::new(lib);
        self.published = Some(lib.clone());
        self.pending = false;
        self.last_commit = self.frames;
        self.stats.commits += 1;
        Ok(lib)
    }

    // ---- tile visits ------------------------------------------------------

    fn load(&mut self, ti: usize, test: bool) -> Frames {
        let ids: Vec<(bool, usize)> = self.tiles[ti]
            .slots()
            .into_iter()
            .filter(|&s| self.tiles[ti].slot(s).test == test)
            .collect();
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut y = Vec::with_capacity(ids.len());
        let mut proj = Vec::with_capacity(ids.len());
        for s in ids {
            let slot: &mut Slot = self.tiles[ti].slot_mut(s);
            let mut v = Vec::new();
            slot.values(&mut v);
            if slot.proj.is_none() {
                slot.proj = Some(bg.project(&v));
                self.work += (v.len() * (bg.k + 1)) as u64;
            }
            proj.push(slot.proj.clone().expect("set"));
            y.push(v);
        }
        Frames { y, proj }
    }

    fn columns(&self, rect: Rect, skip: &[u64], extra: &[&Cell]) -> Vec<Column> {
        let w = self.dims.width;
        let mut cols: Vec<Column> = self
            .cells
            .iter()
            .filter(|c| c.bbox.intersects(&rect) && !skip.contains(&c.id))
            .map(|c| Column::of(c, rect, w, &self.inv_sigma))
            .filter(|c| !c.pix.is_empty())
            .collect();
        for c in extra {
            cols.push(Column::of(c, rect, w, &self.inv_sigma));
        }
        cols
    }

    fn solve_all(&mut self, pr: &Problem, fr: &Frames) -> Vec<Fit> {
        self.solve_with(pr, &fr.y, &fr.proj)
    }

    fn solve_with(&mut self, pr: &Problem, ys: &[Vec<f32>], proj: &[(Vec<f64>, f64)]) -> Vec<Fit> {
        let mut work = 0;
        let fits = ys
            .iter()
            .zip(proj)
            .map(|(y, (qb, yy))| pr.solve(y, qb, *yy, &mut work))
            .collect();
        self.work += work;
        fits
    }

    fn residuals(&mut self, pr: &Problem, fr: &Frames, fits: &[Fit], ti: usize) -> Vec<Vec<f32>> {
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut work = 0;
        let out = fr
            .y
            .iter()
            .zip(fits)
            .map(|(y, f)| {
                let mut r = vec![0.0f32; y.len()];
                pr.residual(y, f, bg, &mut r, &mut work);
                r
            })
            .collect();
        self.work += work;
        out
    }

    fn problem(&mut self, ti: usize, cols: Vec<Column>) -> Problem {
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut work = 0;
        let pr = Problem::new(cols, bg, self.tiles[ti].rect.len(), &mut work);
        self.work += work;
        pr
    }

    /// Held-out χ² improvement a column of noise would give: mean and sd.
    fn null(&self, n: usize) -> (f64, f64) {
        (0.5 * n as f64, (1.25 * n as f64).sqrt())
    }

    fn visit(&mut self, ti: usize) -> Result<(), TraceError> {
        self.stats.visits += 1;
        self.tiles[ti].fresh = 0;
        self.tiles[ti].last_visit = self.frames;
        self.tile_visits[ti] += 1;
        let now = self.frames;
        self.tiles[ti].rejected.retain(|r| r.2 > now || r.3 > 0 && r.2 + 4 * self.cfg.reject_cooldown_frames > now);
        if self.bgs[ti].is_none() {
            self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
        }
        let w0 = self.work;
        let fit_fr = self.load(ti, false);
        let test_fr = self.load(ti, true);
        self.stats.work_load += self.work - w0;
        if fit_fr.len() < self.cfg.min_fit_frames || test_fr.len() < self.cfg.min_test_frames {
            return Ok(());
        }
        let refine = self.cfg.refine_every_visits > 0
            && self.tile_visits[ti] % self.cfg.refine_every_visits == 0;
        // One solve of the tile's model serves all three edits; refinements
        // and merges made on this visit leave its residual slightly stale for
        // the add proposals, but every edit is tested on the current model.
        let w0 = self.work;
        let solved = self.solve_tile(ti, &fit_fr);
        self.stats.work_load += self.work - w0;
        if refine {
            let w0 = self.work;
            self.refine(ti, &solved, &test_fr);
            self.stats.work_refine += self.work - w0;
        }
        let w0 = self.work;
        self.merge(ti, &fit_fr, &test_fr);
        self.stats.work_merge += self.work - w0;
        let w0 = self.work;
        self.add(ti, solved.resid, &test_fr);
        self.stats.work_add += self.work - w0;
        Ok(())
    }

    /// Mark the tiles whose patch overlaps `bbox` as due for a visit.
    fn touch(&mut self, bbox: Rect) {
        let due = self.cfg.visit_after_slots;
        for t in self.tiles.iter_mut() {
            if t.rect.intersects(&bbox) {
                t.fresh = t.fresh.max(due);
            }
        }
    }

    fn total_chi2(fits: &[Fit]) -> f64 {
        fits.iter().map(|f| f.chi2).sum()
    }

    fn add(&mut self, ti: usize, resid: Vec<Vec<f32>>, test_fr: &Frames) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        let d = self.cfg.cell_diameter_px;
        let (mut adds, mut rejects) = (0, 0);
        // Residual maps of the fitting frames, computed once; an accepted
        // cell's signal is subtracted from them in place.
        let mut maps: Option<(Vec<Vec<f32>>, Vec<Vec<f32>>, f32, Vec<f32>)> = None;
        let mut resid = Some(resid);
        while adds < self.cfg.max_adds_per_visit && rejects < self.cfg.max_rejects_per_visit {
            if maps.is_none() {
                let resid = resid.take().expect("first pass");
                // Cell-scale blur of each residual (over the core only), then
                // a robust noise scale.
                let mut blurred = Vec::with_capacity(resid.len());
                for r in &resid {
                    let mut b = vec![0.0f32; r.len()];
                    self.blur_window(rect, core, r, &mut b);
                    blurred.push(b);
                }
                let mut sample: Vec<f32> = blurred
                    .iter()
                    .flat_map(|b| {
                        (0..core.h).step_by(3).flat_map(move |y| {
                            let row = (core.y0 - rect.y0 + y) * rect.w + core.x0 - rect.x0;
                            b[row..row + core.w].iter().step_by(3).map(|v| v.abs())
                        })
                    })
                    .collect();
                let mid = sample.len() / 2;
                let scale = if sample.is_empty() {
                    1.0
                } else {
                    1.4826 * *sample.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
                }
                .max(1e-6);
                let mut score = vec![0.0f32; core.len()];
                self.score_window(rect, core, core, &blurred, scale, &mut score);
                maps = Some((resid, blurred, scale, score));
            }
            let (resid, blurred, scale, score) = maps.as_ref().expect("computed");
            let scale = *scale;
            let mut best: Option<(usize, usize, f32)> = None;
            let now = self.frames;
            for gy in core.y0..core.y0 + core.h {
                for gx in core.x0..core.x0 + core.w {
                    if self.fov[gy * self.dims.width + gx] == 0 {
                        continue;
                    }
                    let (fy, fx) = (gy as f32, gx as f32);
                    let s = score[(gy - core.y0) * core.w + gx - core.x0];
                    if best.is_some_and(|b| s <= b.2) {
                        continue;
                    }
                    let suppressed = self.tiles[ti].rejected.iter().any(|r| {
                        r.2 > now && (r.0 - fy).powi(2) + (r.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    }) || self.cells.iter().any(|c| {
                        (c.center.0 - fy).powi(2) + (c.center.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    });
                    if !suppressed {
                        best = Some((gy, gx, s));
                    }
                }
            }
            let ev = self.cfg.event_z - 2.0;
            let Some((py, px, s)) = best else { break };
            if s < self.cfg.min_events as f32 * ev * ev {
                break;
            }
            self.stats.proposals += 1;
            let l = rect.local(py, px).expect("inside");
            let mut c0: Vec<f32> = blurred.iter().map(|b| (b[l] / scale - 2.0).max(0.0)).collect();
            let id = self.next_id;
            let cand = self.fit_new(id, rect, &resid, &mut c0, (py as f32, px as f32));
            let accepted = match cand {
                Some(cell) => self.test_add(ti, test_fr, &cell).then_some(cell),
                None => None,
            };
            match accepted {
                Some(cell) => {
                    self.next_id += 1;
                    self.stats.adds += 1;
                    let bbox = cell.bbox;
                    // Blank the new cell's signal from the residual maps (its
                    // least-squares trace per frame), so the same signal is
                    // not proposed again; neighbours are re-solved on the
                    // next visit.
                    let col = Column::of(&cell, rect, self.dims.width, &self.inv_sigma);
                    let (resid, blurred, scale, score) = maps.as_mut().expect("computed");
                    let cc: f32 = col.val.iter().map(|v| v * v).sum::<f32>().max(1e-12);
                    for r in resid.iter_mut() {
                        let c = (col.pix.iter().zip(&col.val).map(|(&p, &v)| v * r[p as usize]).sum::<f32>() / cc).max(0.0);
                        for (&p, &v) in col.pix.iter().zip(&col.val) {
                            r[p as usize] -= v * c;
                        }
                    }
                    let m = (3.0 * self.detect_sigma()).ceil() as usize;
                    let win = clip(
                        Rect {
                            y0: bbox.y0.saturating_sub(m),
                            x0: bbox.x0.saturating_sub(m),
                            h: bbox.h + 2 * m,
                            w: bbox.w + 2 * m,
                        },
                        core,
                    );
                    let scale = *scale;
                    for (r, b) in resid.iter().zip(blurred.iter_mut()) {
                        self.blur_window(rect, win, r, b);
                    }
                    self.work += (resid.len() * col.pix.len() * 2) as u64;
                    self.score_window(rect, core, win, blurred, scale, score);
                    self.cells.push(cell);
                    self.pending = true;
                    self.touch(bbox);
                    self.tiles[ti].fresh = 0;
                    adds += 1;
                }
                None => {
                    self.stats.rejects += 1;
                    self.reject(ti, py as f32, px as f32);
                    rejects += 1;
                }
            }
        }
    }

    fn detect_sigma(&self) -> f32 {
        (self.cfg.cell_diameter_px / 4.0).max(0.6)
    }

    /// Cell-scale blur of the patch residual `r` into `out`, only over the
    /// window `win` (read with a 3 σ margin, so the window is exact).
    fn blur_window(&mut self, rect: Rect, win: Rect, r: &[f32], out: &mut [f32]) {
        let m = (3.0 * self.detect_sigma()).ceil() as usize;
        let full = Rect {
            y0: rect.y0,
            x0: rect.x0,
            h: rect.h,
            w: rect.w,
        };
        let canvas = clip(
            Rect {
                y0: win.y0.saturating_sub(m),
                x0: win.x0.saturating_sub(m),
                h: win.h + 2 * m,
                w: win.w + 2 * m,
            },
            full,
        );
        let mut src = vec![0.0f32; canvas.len()];
        for y in 0..canvas.h {
            let row = (canvas.y0 - rect.y0 + y) * rect.w + canvas.x0 - rect.x0;
            src[y * canvas.w..(y + 1) * canvas.w].copy_from_slice(&r[row..row + canvas.w]);
        }
        let mut dst = vec![0.0f32; canvas.len()];
        self.detect.blur(canvas.h, canvas.w, &src, &mut dst);
        for y in 0..win.h {
            let crow = (win.y0 - canvas.y0 + y) * canvas.w + win.x0 - canvas.x0;
            let row = (win.y0 - rect.y0 + y) * rect.w + win.x0 - rect.x0;
            out[row..row + win.w].copy_from_slice(&dst[crow..crow + win.w]);
        }
        self.work += (canvas.len() * 15) as u64;
    }

    /// Detection score (summed squared excursions above 2 σ over the fitting
    /// frames) of the core pixels inside `win`.
    fn score_window(&mut self, rect: Rect, core: Rect, win: Rect, blurred: &[Vec<f32>], scale: f32, score: &mut [f32]) {
        for y in win.y0..win.y0 + win.h {
            for x in win.x0..win.x0 + win.w {
                let l = rect.local(y, x).expect("window inside rect");
                let mut s = 0.0f32;
                for b in blurred {
                    let z = b[l] / scale - 2.0;
                    if z > 0.0 {
                        s += z * z;
                    }
                }
                score[(y - core.y0) * core.w + x - core.x0] = s;
            }
        }
        self.work += (win.len() * blurred.len()) as u64;
    }

    fn reject(&mut self, ti: usize, y: f32, x: f32) {
        let now = self.frames;
        let d = self.cfg.cell_diameter_px;
        let base = self.cfg.reject_cooldown_frames;
        let t = &mut self.tiles[ti];
        if let Some(r) = t
            .rejected
            .iter_mut()
            .find(|r| (r.0 - y).powi(2) + (r.1 - x).powi(2) <= (0.5 * d).powi(2))
        {
            r.3 = (r.3 + 1).min(6);
            r.2 = now + base * (1 << r.3);
            r.0 = y;
            r.1 = x;
        } else {
            t.rejected.push((y, x, now + base, 0));
        }
    }

    /// Patch-local pixels of the disk `(cy, cx, r)` inside `rect`.
    fn disk(&self, rect: Rect, cy: f32, cx: f32, r: f32) -> Vec<u32> {
        let mut out = Vec::new();
        for y in 0..rect.h {
            for x in 0..rect.w {
                let (gy, gx) = (rect.y0 + y, rect.x0 + x);
                let (dy, dx) = (gy as f32 - cy, gx as f32 - cx);
                if dy * dy + dx * dx <= r * r && self.fov[gy * self.dims.width + gx] != 0 {
                    out.push((y * rect.w + x) as u32);
                }
            }
        }
        out
    }

    /// Unwhiten a filtered footprint `h` on patch pixels `dom`, invert the
    /// high-pass on a canvas around it, and make a cell.
    fn to_cell(&mut self, id: u64, rect: Rect, dom: &[u32], h: &[f32], start: Option<&Cell>) -> Option<Cell> {
        let w = self.dims.width;
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for &p in dom {
            let (y, x) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            ymin = ymin.min(y);
            ymax = ymax.max(y);
            xmin = xmin.min(x);
            xmax = xmax.max(x);
        }
        if dom.is_empty() {
            return None;
        }
        let canvas = Rect {
            y0: ymin,
            x0: xmin,
            h: ymax + 1 - ymin,
            w: xmax + 1 - xmin,
        };
        let mut target = vec![0.0f32; canvas.len()];
        let mut mask = vec![false; canvas.len()];
        for (&p, &v) in dom.iter().zip(h) {
            let (gy, gx) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            let l = canvas.local(gy, gx).expect("inside");
            target[l] = v * self.noise[gy * w + gx];
            mask[l] = true;
        }
        // Footprints are smooth at the scale of the optics (a tenth of a
        // cell diameter): a masked, normalised blur of the target removes the
        // pixel noise of a footprint estimated from a few dozen frames.
        {
            let m: Vec<f32> = mask.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
            let tm: Vec<f32> = target.iter().zip(&m).map(|(t, m)| t * m).collect();
            let (mut bt, mut bm) = (vec![0.0f32; canvas.len()], vec![0.0f32; canvas.len()]);
            self.smooth.blur(canvas.h, canvas.w, &tm, &mut bt);
            self.smooth.blur(canvas.h, canvas.w, &m, &mut bm);
            for p in 0..canvas.len() {
                if mask[p] {
                    target[p] = bt[p] / bm[p].max(1e-6);
                }
            }
            self.work += (canvas.len() * 60) as u64;
        }
        let mut a: Vec<f32> = target.iter().map(|v| v.max(0.0)).collect();
        if let Some(c) = start {
            a.iter_mut().for_each(|v| *v = 0.0);
            for (&g, &v) in c.pix.iter().zip(&c.raw) {
                if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                    if mask[l] {
                        a[l] = v;
                    }
                }
            }
            // Keep the scale of the new target.
            let s: f32 = target.iter().zip(&a).map(|(t, v)| t * v).sum::<f32>()
                / a.iter().map(|v| v * v).sum::<f32>().max(1e-12);
            a.iter_mut().for_each(|v| *v *= s.max(0.0));
        }
        self.filter.invert(canvas.h, canvas.w, &mask, &target, &mut a, 40);
        self.work += (canvas.len() * 40 * 60) as u64;
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) {
            return None;
        }
        a.iter_mut().for_each(|v| *v /= peak);
        Cell::from_canvas(id, canvas, &a, self.dims, &self.fov, &self.cfg.library, &mut self.filter)
    }

    /// Rank-1 fit of a new cell on a small disk around `peak`.
    fn fit_new(&mut self, id: u64, rect: Rect, resid: &[Vec<f32>], c: &mut [f32], peak: (f32, f32)) -> Option<Cell> {
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let refs: Vec<&[f32]> = resid.iter().map(|r| r.as_slice()).collect();
        let dom = self.disk(rect, peak.0, peak.1, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        // Recentre on the half-max centroid and fit again.
        let hmax = h.iter().copied().fold(0.0f32, f32::max);
        if !(hmax > 0.0) {
            return None;
        }
        let (mut sw, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
        for (&p, &v) in dom.iter().zip(&h) {
            if v >= 0.5 * hmax {
                sw += v;
                sy += v * (rect.y0 + p as usize / rect.w) as f32;
                sx += v * (rect.x0 + p as usize % rect.w) as f32;
            }
        }
        let (cy, cx) = (sy / sw, sx / sw);
        let dom = self.disk(rect, cy, cx, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        self.work += (dom.len() * resid.len() * 42) as u64;
        self.to_cell(id, rect, &dom, &h, None)
    }

    /// Held-out test of adding `cell` to the tile's problem.
    ///
    /// Both arms get one extra free background term, a Gaussian of σ = one
    /// cell diameter centred on the candidate: broad local signal (scatter
    /// halo of the neighbours, neuropil, out-of-focus light) is explained
    /// without the candidate, so the candidate must explain *compact*
    /// signal (the patch's 3 x 3 bumps are too smooth to do this alone).
    fn test_add(&mut self, ti: usize, test_fr: &Frames, cell: &Cell) -> bool {
        let rect = self.tiles[ti].rect;
        let s = self.cfg.cell_diameter_px;
        let mut bump = vec![0.0f32; rect.len()];
        for y in 0..rect.h {
            for x in 0..rect.w {
                let dy = (rect.y0 + y) as f32 - cell.center.0;
                let dx = (rect.x0 + x) as f32 - cell.center.1;
                bump[y * rect.w + x] = (-(dy * dy + dx * dx) / (2.0 * s * s)).exp();
            }
        }
        let bg = self.bgs[ti].as_ref().expect("basis").with_extra(&bump);
        let proj: Vec<(Vec<f64>, f64)> = test_fr
            .y
            .iter()
            .zip(&test_fr.proj)
            .map(|(y, (q, yy))| {
                let mut q = q.clone();
                q.push(bump.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum());
                (q, *yy)
            })
            .collect();
        self.work += (rect.len() * (test_fr.len() + 2 * bg.k)) as u64;
        let mut work = 0;
        let base = Problem::new(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
        let ext = Problem::new(self.columns(rect, &[], &[cell]), &bg, rect.len(), &mut work);
        self.work += work;
        let b = self.solve_with(&base, &test_fr.y, &proj);
        let e = self.solve_with(&ext, &test_fr.y, &proj);
        let k = ext.len() - 1;
        // What the base model leaves is noise *plus* everything not modelled
        // (dim cells below detection, neuropil): measure its variance per
        // pixel and express gains and events in that unit (>= 1, the noise).
        let n_px = self.fov_px(rect) as f64;
        let dof = (test_fr.len() as f64 * (n_px - (bg.k + base.len()) as f64)).max(1.0);
        let s2 = (Self::total_chi2(&b) / dof).max(1.0);
        let sig = ext.coord_sigma(k) * s2.sqrt() as f32;
        // Events are transients above the candidate's own held-out median:
        // a static pattern (a floor or vessel-edge residual) with a constant
        // trace explains held-out χ² but is not a cell.
        let mut sorted: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
        sorted.sort_by(f32::total_cmp);
        let base_level = sorted[sorted.len() / 2];
        let events = e
            .iter()
            .filter(|f| f.c[k] - base_level >= self.cfg.event_z * sig)
            .count() as u32;
        let gain = (Self::total_chi2(&b) - Self::total_chi2(&e)) / s2;
        let (m, s) = self.null(test_fr.len());
        if events < self.cfg.min_events || gain <= m + f64::from(self.cfg.accept_z) * s {
            return false;
        }
        // A candidate whose held-out trace follows a nearby cell's is that
        // cell's unmodelled light (scatter halo, a footprint mismatch), not
        // a new cell: leave it to refinement and merging.
        let ck: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
        let reach = 2.0 * self.cfg.library.max_support_px;
        for j in 0..k {
            let Some(cj) = self.cells.iter().find(|c| c.id == ext.cols[j].id) else {
                continue;
            };
            let d2 = (cj.center.0 - cell.center.0).powi(2) + (cj.center.1 - cell.center.1).powi(2);
            if d2 <= reach * reach {
                let tj: Vec<f32> = e.iter().map(|f| f.c[j]).collect();
                if corr(&ck, &tj) >= self.cfg.merge_corr {
                    return false;
                }
            }
        }
        true
    }

    /// FOV pixels inside `rect`.
    fn fov_px(&self, rect: Rect) -> usize {
        (rect.y0..rect.y0 + rect.h)
            .map(|y| {
                self.fov[y * self.dims.width + rect.x0..y * self.dims.width + rect.x0 + rect.w]
                    .iter()
                    .filter(|&&m| m != 0)
                    .count()
            })
            .sum()
    }

    fn merge(&mut self, ti: usize, fit_fr: &Frames, test_fr: &Frames) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        for _ in 0..4 {
            let cols = self.columns(rect, &[], &[]);
            if cols.len() < 2 {
                return;
            }
            let base = self.problem(ti, cols);
            let fits = self.solve_all(&base, fit_fr);
            let n = base.len();
            let ids: Vec<u64> = base.cols.iter().map(|c| c.id).collect();
            let cell_of = |cells: &[Cell], id: u64| cells.iter().position(|c| c.id == id).expect("cell");
            // Best-correlated overlapping pair with the first cell in the core.
            let mut best: Option<(usize, usize, f32)> = None;
            for i in 0..n {
                let ci = &self.cells[cell_of(&self.cells, ids[i])];
                let (iy, ix) = (ci.center.0 as usize, ci.center.1 as usize);
                if core.local(iy, ix).is_none() {
                    continue;
                }
                for j in 0..n {
                    if j == i {
                        continue;
                    }
                    let cj = &self.cells[cell_of(&self.cells, ids[j])];
                    let dist = ((ci.center.0 - cj.center.0).powi(2) + (ci.center.1 - cj.center.1).powi(2)).sqrt();
                    if dist >= ci.radius + cj.radius {
                        continue;
                    }
                    let a: Vec<f32> = fits.iter().map(|f| f.c[i]).collect();
                    let b: Vec<f32> = fits.iter().map(|f| f.c[j]).collect();
                    let r = corr(&a, &b);
                    if r >= self.cfg.merge_corr && best.is_none_or(|bb| r > bb.2) {
                        best = Some((i, j, r));
                    }
                }
            }
            let Some((i, j, _)) = best else { return };
            self.stats.merge_tests += 1;
            let resid = self.residuals(&base, fit_fr, &fits, ti);
            let (ci, cj) = (cell_of(&self.cells, ids[i]), cell_of(&self.cells, ids[j]));
            // Data: residual plus both cells' fitted signal.
            let data: Vec<Vec<f32>> = resid
                .iter()
                .zip(&fits)
                .map(|(r, f)| {
                    let mut d = r.clone();
                    for k in [i, j] {
                        for (&p, &v) in base.cols[k].pix.iter().zip(&base.cols[k].val) {
                            d[p as usize] += v * f.c[k];
                        }
                    }
                    d
                })
                .collect();
            let mut dom: Vec<u32> = base.cols[i].pix.clone();
            dom.extend(&base.cols[j].pix);
            dom.sort_unstable();
            dom.dedup();
            let mut c: Vec<f32> = fits.iter().map(|f| f.c[i] + f.c[j]).collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let h = rank1(&refs, &dom, &mut c, 10, false);
            self.work += (dom.len() * data.len() * 40) as u64;
            let keep = self.cells[ci].id.min(self.cells[cj].id);
            let Some(m) = self.to_cell(keep, rect, &dom, &h, None) else {
                self.reject(ti, self.cells[ci].center.0, self.cells[ci].center.1);
                return;
            };
            let sep = self.solve_all(&base, test_fr);
            let cols = self.columns(rect, &[ids[i], ids[j]], &[&m]);
            let mp = self.problem(ti, cols);
            let mf = self.solve_all(&mp, test_fr);
            let loss = Self::total_chi2(&mf) - Self::total_chi2(&sep);
            let (mu, s) = self.null(test_fr.len());
            if loss < mu + f64::from(self.cfg.accept_z) * s {
                self.stats.merges += 1;
                let (drop, keep_idx) = if self.cells[ci].id == keep { (cj, ci) } else { (ci, cj) };
                let bbox = m.bbox;
                let center = m.center;
                self.cells[keep_idx] = m;
                self.cells.remove(drop);
                self.pending = true;
                self.touch(bbox);
                self.tiles[ti].fresh = 0;
                // The merged cell's surroundings are not re-proposed at once.
                self.reject(ti, center.0, center.1);
            } else {
                return;
            }
        }
    }

    /// The tile's current model solved on its fitting frames.
    fn solve_tile(&mut self, ti: usize, fit_fr: &Frames) -> Solved {
        let rect = self.tiles[ti].rect;
        let cols = self.columns(rect, &[], &[]);
        let base = self.problem(ti, cols);
        let fits = self.solve_all(&base, fit_fr);
        let resid = self.residuals(&base, fit_fr, &fits, ti);
        Solved { base, fits, resid }
    }

    fn refine(&mut self, ti: usize, solved: &Solved, test_fr: &Frames) {
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let Solved { base, fits, resid } = solved;
        if base.len() == 0 {
            return;
        }
        let base_test = self.solve_all(&base, test_fr);
        let chi_base = Self::total_chi2(&base_test);
        let mut updates = Vec::new();
        for i in 0..base.len() {
            let id = base.cols[i].id;
            let Some(ci) = self.cells.iter().position(|c| c.id == id) else { continue };
            let cell = self.cells[ci].clone();
            if core.local(cell.center.0 as usize, cell.center.1 as usize).is_none() {
                continue;
            }
            let sig = base.coord_sigma(i);
            let active: Vec<usize> = (0..fits.len()).filter(|&t| fits[t].c[i] >= 2.0 * sig).collect();
            if active.len() < 3 {
                continue;
            }
            let r = (cell.radius + 2.0).min(self.cfg.library.max_support_px);
            let dom = self.disk(rect, cell.center.0, cell.center.1, r);
            let data: Vec<Vec<f32>> = active
                .iter()
                .map(|&t| {
                    let mut d = resid[t].clone();
                    for (&p, &v) in base.cols[i].pix.iter().zip(&base.cols[i].val) {
                        d[p as usize] += v * fits[t].c[i];
                    }
                    d
                })
                .collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let mut c: Vec<f32> = active.iter().map(|&t| fits[t].c[i]).collect();
            let h = rank1(&refs, &dom, &mut c, 1, true);
            self.work += (dom.len() * data.len()) as u64;
            let Some(new) = self.to_cell(id, rect, &dom, &h, Some(&cell)) else { continue };
            let cols = self.columns(rect, &[id], &[&new]);
            let pr = self.problem(ti, cols);
            let f = self.solve_all(&pr, test_fr);
            if Self::total_chi2(&f) < chi_base {
                updates.push((id, new));
            }
        }
        for (id, new) in updates {
            if let Some(ci) = self.cells.iter().position(|c| c.id == id) {
                self.stats.refines += 1;
                let bbox = new.bbox;
                self.cells[ci] = new;
                self.pending = true;
                self.touch(bbox);
            }
        }
        self.tiles[ti].fresh = 0;
    }
}

/// Intersection of two rectangles (empty when disjoint).
fn clip(a: Rect, b: Rect) -> Rect {
    let y0 = a.y0.max(b.y0);
    let x0 = a.x0.max(b.x0);
    let y1 = (a.y0 + a.h).min(b.y0 + b.h).max(y0);
    let x1 = (a.x0 + a.w).min(b.x0 + b.w).max(x0);
    Rect {
        y0,
        x0,
        h: y1 - y0,
        w: x1 - x0,
    }
}

fn corr(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
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
        (sab / (saa * sbb).sqrt()) as f32
    }
}

#[cfg(test)]
mod tests;
