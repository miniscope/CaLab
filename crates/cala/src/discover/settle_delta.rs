//! Settle delta (experimental, off by default): the footprint-statistics
//! update of a background-settle chunk made away from the slow loop.
//!
//! The background settle re-reads saved frames 16 at a time on a look-back
//! worker, which solves them; today the slow loop then takes each fitting
//! frame through [`SlowLoop::observe_settle`] (render the model, update every
//! cell's running statistics and every cluster store), 1.4-3.9 ms per
//! re-read frame of the slow worker. The update is a weighted sum, so the
//! worker that solved the chunk can sum it as well: the slow loop hands out
//! a [`SettleContext`] with the request (each cell's statistics disk, each
//! cluster store's pixels and basis, the forgetting factor), the worker
//! feeds its solved frames to a [`SettleDeltaBuilder`], and the slow loop
//! adds the [`SettleDelta`] that comes back
//! ([`SlowLoop::apply_settle_delta`]).
//!
//! What it gives, against feeding the same frames to `observe_settle`:
//!
//! - Same library version, nothing changed between request and answer:
//!   the same sums up to f32/f64 rounding (the frames' weights are summed
//!   relative to the weight before the chunk and scaled once), except the
//!   split-half sums: a cell's whole chunk goes to the 256-frame block its
//!   first frame of the chunk falls in (a chunk that straddles a block
//!   boundary puts its later frames in the other block today).
//! - A cell is matched by id and by its statistics disk: a cell gone since
//!   the request, one whose disk moved, and one born after it get nothing
//!   from the chunk (today a frame solved with an older library is pushed
//!   on that library's cells, creating statistics for a deleted cell, moving
//!   disks to the old support and rebuilding the cluster sets for the old
//!   cell set; none of that happens here). A cluster store is matched by its
//!   members and basis epoch: a store moved, refreshed or rebuilt since the
//!   request gets nothing.
//! - Held-out frames never reach fitting: the builder is only fed the
//!   fitting frames, the delta lists every frame it summed, and the slow
//!   loop refuses a delta with any held-out frame in it.
//!
//! The forgetting clock moves by the chunk's fitting frames at the apply,
//! as it would have frame by frame (renormalisation included).

use super::cluster::{ClusterDelta, ClusterSnap};
use super::fpstats::{disk_pixels, parity, FpDelta};
use super::wire::{Reader, Writer};
use super::{column_on, SlowLoop};
use crate::trace::{BackgroundModel, FrameTraces, Library, TraceError};

/// Format tags (bump on any layout change).
const CTX_MAGIC: u32 = 0x5344_4331; // "SDC1"
const DELTA_MAGIC: u32 = 0x5344_4431; // "SDD1"

/// What a settle request carries for the worker that sums the chunk
/// ([`SlowLoop::settle_context`]).
#[derive(Debug, Clone, PartialEq)]
pub struct SettleContext {
    width: usize,
    height: usize,
    /// Pixel-class block side and the per-frame forgetting factor.
    blk: u32,
    gamma: f32,
    /// Every cell with statistics: id, disk centre, disk radius.
    cells: Vec<(u64, (f32, f32), f32)>,
    /// Every cluster store (none when the joint update is off).
    clusters: Vec<ClusterSnap>,
}

impl SettleContext {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(CTX_MAGIC);
        w.usize(self.width);
        w.usize(self.height);
        w.u32(self.blk);
        w.f32(self.gamma);
        w.usize(self.cells.len());
        for &(id, (cy, cx), r) in &self.cells {
            w.u64(id);
            w.f32(cy);
            w.f32(cx);
            w.f32(r);
        }
        w.usize(self.clusters.len());
        for c in &self.clusters {
            c.encode(&mut w);
        }
        w.buf
    }

    pub fn from_bytes(b: &[u8]) -> Result<SettleContext, TraceError> {
        let bad = || TraceError::Incompatible("not a settle context".into());
        let mut r = Reader::new(b);
        if r.u32() != Some(CTX_MAGIC) {
            return Err(bad());
        }
        let f = |r: &mut Reader| -> Option<SettleContext> {
            let (width, height, blk, gamma) = (r.usize()?, r.usize()?, r.u32()?, r.f32()?);
            let nc = r.count(20)?;
            let cells = (0..nc)
                .map(|_| Some((r.u64()?, (r.f32()?, r.f32()?), r.f32()?)))
                .collect::<Option<Vec<_>>>()?;
            let nk = r.count(1)?;
            let clusters = (0..nk)
                .map(|_| ClusterSnap::decode(r))
                .collect::<Option<Vec<_>>>()?;
            let n_px = width.checked_mul(height)?;
            let ok = clusters
                .iter()
                .all(|c| c.pix.iter().all(|&p| (p as usize) < n_px));
            (ok && r.done()).then_some(SettleContext {
                width,
                height,
                blk,
                gamma,
                cells,
                clusters,
            })
        };
        f(&mut r).ok_or_else(bad)
    }

    /// Cells and cluster stores it describes.
    pub fn cells(&self) -> usize {
        self.cells.len()
    }

    pub fn clusters(&self) -> usize {
        self.clusters.len()
    }
}

/// The summed statistics of one settle chunk ([`SettleDeltaBuilder`]).
#[derive(Debug, Clone, PartialEq)]
pub struct SettleDelta {
    /// Library version the chunk was solved with.
    version: u64,
    gamma: f32,
    /// The key of every frame summed (the caller's frame index: the
    /// stream index in the app, the slow-loop index in qc_eval), in order.
    frames: Vec<u64>,
    cells: Vec<(u64, (f32, f32), f32, FpDelta)>,
    clusters: Vec<ClusterDelta>,
    /// Work units `observe_settle` would have spent on these frames.
    work_equiv: u64,
    /// Context cells and stores the chunk's library did not have, and
    /// frames a store passed over (a missing pixel).
    absent_cells: u64,
    absent_clusters: u64,
    cluster_skips: u64,
}

impl SettleDelta {
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The keys of the frames summed.
    pub fn frames(&self) -> &[u64] {
        &self.frames
    }

    pub fn work_equiv(&self) -> u64 {
        self.work_equiv
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(DELTA_MAGIC);
        w.u64(self.version);
        w.f32(self.gamma);
        w.u64s(&self.frames);
        w.usize(self.cells.len());
        for (id, (cy, cx), r, d) in &self.cells {
            w.u64(*id);
            w.f32(*cy);
            w.f32(*cx);
            w.f32(*r);
            d.encode(&mut w);
        }
        w.usize(self.clusters.len());
        for c in &self.clusters {
            c.encode(&mut w);
        }
        w.u64(self.work_equiv);
        w.u64(self.absent_cells);
        w.u64(self.absent_clusters);
        w.u64(self.cluster_skips);
        w.buf
    }

    pub fn from_bytes(b: &[u8]) -> Result<SettleDelta, TraceError> {
        let bad = || TraceError::Incompatible("not a settle delta".into());
        let mut r = Reader::new(b);
        if r.u32() != Some(DELTA_MAGIC) {
            return Err(bad());
        }
        let f = |r: &mut Reader| -> Option<SettleDelta> {
            let version = r.u64()?;
            let gamma = r.f32()?;
            let frames = r.u64s()?;
            let nc = r.count(20)?;
            let cells = (0..nc)
                .map(|_| {
                    Some((
                        r.u64()?,
                        (r.f32()?, r.f32()?),
                        r.f32()?,
                        FpDelta::decode(r)?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            let nk = r.count(1)?;
            let clusters = (0..nk)
                .map(|_| ClusterDelta::decode(r))
                .collect::<Option<Vec<_>>>()?;
            let d = SettleDelta {
                version,
                gamma,
                frames,
                cells,
                clusters,
                work_equiv: r.u64()?,
                absent_cells: r.u64()?,
                absent_clusters: r.u64()?,
                cluster_skips: r.u64()?,
            };
            r.done().then_some(d)
        };
        f(&mut r).ok_or_else(bad)
    }
}

/// One context cell as the builder sums it.
struct BCell {
    id: u64,
    center: (f32, f32),
    radius: f32,
    slot: usize,
    pix: Vec<u32>,
    cls: Vec<u8>,
    col: Vec<f32>,
    d: FpDelta,
}

/// One context store as the builder sums it.
struct BCluster {
    snap: ClusterSnap,
    slots: Vec<usize>,
    /// The members' filtered columns on the store's pixels, member-major.
    cols: Vec<f32>,
    d: ClusterDelta,
}

/// Sums the fitting frames of one settle chunk (all solved with one
/// library) for a [`SettleContext`]: what [`SlowLoop::observe_settle`] adds
/// to the statistics, frame by frame, without the slow loop.
pub struct SettleDeltaBuilder {
    width: usize,
    height: usize,
    fov: Vec<u8>,
    ctx: SettleContext,
    version: Option<u64>,
    /// The next frame's weight relative to the weight before the chunk.
    rho: f32,
    model: Vec<f32>,
    cells: Vec<BCell>,
    clusters: Vec<BCluster>,
    frames: Vec<u64>,
    work_equiv: u64,
    absent_cells: u64,
    absent_clusters: u64,
    cluster_skips: u64,
    buf: Vec<f32>,
}

impl SettleDeltaBuilder {
    /// `fov` is the slow loop's FOV mask (the statistics disks keep its
    /// pixels only).
    pub fn new(
        width: usize,
        height: usize,
        fov: Vec<u8>,
        ctx: SettleContext,
    ) -> Result<SettleDeltaBuilder, TraceError> {
        crate::trace::check_len("fov", width * height, fov.len())?;
        if ctx.width != width || ctx.height != height {
            return Err(TraceError::Incompatible(
                "settle context of another frame size".into(),
            ));
        }
        Ok(SettleDeltaBuilder {
            width,
            height,
            fov,
            ctx,
            version: None,
            rho: 1.0,
            model: vec![0.0; width * height],
            cells: Vec::new(),
            clusters: Vec::new(),
            frames: Vec::new(),
            work_equiv: 0,
            absent_cells: 0,
            absent_clusters: 0,
            cluster_skips: 0,
            buf: Vec::new(),
        })
    }

    /// Start over on a new context (the same frame size), keeping the
    /// buffers.
    pub fn reset(&mut self, ctx: SettleContext) -> Result<(), TraceError> {
        if ctx.width != self.width || ctx.height != self.height {
            return Err(TraceError::Incompatible(
                "settle context of another frame size".into(),
            ));
        }
        self.ctx = ctx;
        self.version = None;
        self.rho = 1.0;
        self.cells.clear();
        self.clusters.clear();
        self.frames.clear();
        self.work_equiv = 0;
        self.absent_cells = 0;
        self.absent_clusters = 0;
        self.cluster_skips = 0;
        Ok(())
    }

    /// Frames summed so far.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// The chunk's library: the cells and stores it has, their disks and
    /// columns.
    fn start(&mut self, lib: &Library) {
        let (w, h) = (self.width, self.height);
        for &(id, center, radius) in &self.ctx.cells {
            let Some(slot) = lib.slot(id) else {
                self.absent_cells += 1;
                continue;
            };
            let pix = disk_pixels(center, radius, w, h, &self.fov);
            let cls = pix.iter().map(|&p| parity(p, w, self.ctx.blk)).collect();
            let col = column_on(lib, slot, &pix);
            let d = FpDelta::new(pix.len());
            self.cells.push(BCell {
                id,
                center,
                radius,
                slot,
                pix,
                cls,
                col,
                d,
            });
        }
        for snap in std::mem::take(&mut self.ctx.clusters) {
            let slots: Option<Vec<usize>> = snap.ids.iter().map(|&id| lib.slot(id)).collect();
            let Some(slots) = slots else {
                self.absent_clusters += 1;
                continue;
            };
            let mut cols = Vec::with_capacity(slots.len() * snap.pix.len());
            for &s in &slots {
                cols.extend(column_on(lib, s, &snap.pix));
            }
            let d = ClusterDelta::new(&snap);
            self.clusters.push(BCluster {
                snap,
                slots,
                cols,
                d,
            });
        }
    }

    /// Add one fitting frame (`frame` preprocessed, `traces` its solve with
    /// `lib`); `key` identifies it for the slow loop's held-out check.
    pub fn push(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        key: u64,
    ) -> Result<(), TraceError> {
        let n_px = self.width * self.height;
        crate::trace::check_len("frame", n_px, frame.len())?;
        let d = lib.dims();
        if d.width != self.width
            || d.height != self.height
            || traces.library_version != lib.version()
        {
            return Err(TraceError::Incompatible(
                "traces do not come from this library / frame size".into(),
            ));
        }
        match self.version {
            None => {
                self.version = Some(lib.version());
                self.start(lib);
            }
            Some(v) if v != lib.version() => {
                return Err(TraceError::Incompatible(
                    "a settle delta sums frames of one library".into(),
                ));
            }
            Some(_) => {}
        }
        self.rho /= self.ctx.gamma;
        let w = self.rho;
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        lib.render(&traces.traces, bg, &mut self.model)?;
        let mut work = n_px as u64;
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. })
            && traces.background.len() == lib.len();
        // Per cell, as `SlowLoop::update_fpstats`.
        for cell in &mut self.cells {
            let c = traces.traces[cell.slot];
            let level = if ring {
                traces.background[cell.slot]
            } else {
                0.0
            };
            self.buf.clear();
            self.buf.extend(cell.pix.iter().map(|&p| {
                let y = frame[p as usize];
                if y.is_finite() {
                    y - self.model[p as usize] - level
                } else {
                    f32::NAN
                }
            }));
            if c != 0.0 {
                for (r, &v) in self.buf.iter_mut().zip(&cell.col) {
                    *r += v * c;
                }
            }
            cell.d.push(&cell.cls, &self.buf, c, w);
            work += cell.pix.len() as u64 * 3;
        }
        // Per store, as `SlowLoop::update_clusters`.
        for cl in &mut self.clusters {
            let s = &cl.snap;
            let n = s.pix.len();
            let c: Vec<f32> = cl.slots.iter().map(|&k| traces.traces[k]).collect();
            let lv: Vec<f32> = cl
                .slots
                .iter()
                .map(|&k| if ring { traces.background[k] } else { 0.0 })
                .collect();
            self.buf.clear();
            self.buf.extend(
                s.pix
                    .iter()
                    .zip(&s.owner)
                    .map(|(&p, &o)| frame[p as usize] - self.model[p as usize] - lv[o as usize]),
            );
            for (k, &ck) in c.iter().enumerate() {
                if ck != 0.0 {
                    for (r, &a) in self.buf.iter_mut().zip(&cl.cols[k * n..(k + 1) * n]) {
                        *r += a * ck;
                    }
                }
            }
            for (r, &is) in self.buf.iter_mut().zip(&s.is) {
                *r *= is;
            }
            if !self.buf.iter().all(|v| v.is_finite()) || !c.iter().all(|v| v.is_finite()) {
                self.cluster_skips += 1;
                continue;
            }
            cl.d.push(&s.ut, &self.buf, &c, f64::from(w));
            work += (n * (3 * c.len() + 3)) as u64;
        }
        self.work_equiv += work;
        self.frames.push(key);
        Ok(())
    }

    /// The chunk's delta.
    pub fn finish(&mut self) -> SettleDelta {
        SettleDelta {
            version: self.version.unwrap_or(0),
            gamma: self.ctx.gamma,
            frames: std::mem::take(&mut self.frames),
            cells: self
                .cells
                .drain(..)
                .map(|c| (c.id, c.center, c.radius, c.d))
                .collect(),
            clusters: self.clusters.drain(..).map(|c| c.d).collect(),
            work_equiv: self.work_equiv,
            absent_cells: self.absent_cells,
            absent_clusters: self.absent_clusters,
            cluster_skips: self.cluster_skips,
        }
    }
}

/// What applying settle deltas did ([`SlowLoop::settle_delta_stats`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettleDeltaStats {
    /// Deltas applied, and refused because a frame in them is held out.
    pub applied: u64,
    pub rejected: u64,
    /// Deltas whose library version differs from the newest the slow loop
    /// published when it was applied.
    pub stale_version: u64,
    /// Frames they carried.
    pub frames: u64,
    /// Cell deltas added; dropped because the cell is gone, or its
    /// statistics disk changed since the request; context cells the
    /// chunk's library did not have.
    pub cells: u64,
    pub cells_gone: u64,
    pub cells_moved: u64,
    pub cells_absent: u64,
    /// Store deltas added; dropped because the store is gone or was
    /// rebuilt, moved or refreshed since the request (another epoch), or
    /// the joint update is not active now; context stores the chunk's
    /// library did not have; frames a store passed over (missing pixel).
    pub clusters: u64,
    pub clusters_gone: u64,
    pub clusters_stale: u64,
    pub clusters_off: u64,
    pub clusters_absent: u64,
    pub cluster_skips: u64,
    /// Work units of the applies, and what `observe_settle` would have
    /// spent on the same frames.
    pub work: u64,
    pub work_equiv: u64,
}

impl SlowLoop {
    /// What a settle request carries for the worker that will sum the chunk
    /// ([`SettleDeltaBuilder`]): every cell's statistics disk and every
    /// cluster store's pixels and basis. Refused with the transient-band
    /// statistics on (`CoreTest` other than `Off`: they run sequentially
    /// over frames).
    pub fn settle_context(&self) -> Result<SettleContext, TraceError> {
        if self.cfg.core_test.collects() {
            return Err(TraceError::Incompatible(
                "the settle delta needs core_test off".into(),
            ));
        }
        let mut cells: Vec<(u64, (f32, f32), f32)> = self
            .fpstats
            .iter()
            .map(|(&id, st)| (id, st.center, st.radius))
            .collect();
        cells.sort_unstable_by_key(|c| c.0);
        let clusters = if self.joint_active() {
            self.clusters
                .iter()
                .filter(|c| !c.pix.is_empty())
                .map(|c| c.snap())
                .collect()
        } else {
            Vec::new()
        };
        Ok(SettleContext {
            width: self.dims.width,
            height: self.dims.height,
            blk: super::fpstats::parity_block(self.cfg.cell_diameter_px),
            gamma: self.stats_gamma,
            cells,
            clusters,
        })
    }

    /// Add a settle chunk's statistics ([`SettleDelta`]) as feeding its
    /// frames through [`SlowLoop::observe_settle`] would (see the module
    /// docs for where it differs). `held(key)`: frame `key` of the delta
    /// is held out; a delta with any such frame is refused whole (counted
    /// in [`SettleDeltaStats::rejected`]; it cannot be taken apart). Needs
    /// the concurrent settle on, as `observe_settle`. Returns whether the
    /// delta was applied.
    pub fn apply_settle_delta(
        &mut self,
        d: &SettleDelta,
        held: &dyn Fn(u64) -> bool,
    ) -> Result<bool, TraceError> {
        if self.cs_fresh.is_empty() {
            return Err(TraceError::Incompatible(
                "the concurrent settle is not enabled".into(),
            ));
        }
        if d.gamma != self.stats_gamma {
            return Err(TraceError::Incompatible(
                "settle delta made with another forgetting factor".into(),
            ));
        }
        if d.frames.iter().any(|&f| held(f)) {
            self.cs_delta.rejected += 1;
            return Ok(false);
        }
        let s = &mut self.cs_delta;
        s.applied += 1;
        s.frames += d.frames.len() as u64;
        s.cells_absent += d.absent_cells;
        s.clusters_absent += d.absent_clusters;
        s.cluster_skips += d.cluster_skips;
        s.work_equiv += d.work_equiv;
        if self
            .published
            .as_ref()
            .is_some_and(|l| l.version() != d.version)
        {
            s.stale_version += 1;
        }
        if d.frames.is_empty() {
            return Ok(true);
        }
        let w0 = self.stats_w;
        let mut work = 0u64;
        for (id, center, radius, fd) in &d.cells {
            match self.fpstats.get_mut(id) {
                None => self.cs_delta.cells_gone += 1,
                Some(st)
                    if st.center != *center
                        || st.radius != *radius
                        || st.pix.len() != fd.rc.len() =>
                {
                    self.cs_delta.cells_moved += 1;
                }
                Some(st) => {
                    st.add_delta(fd, w0);
                    self.cs_delta.cells += 1;
                    work += st.pix.len() as u64 * 2;
                }
            }
        }
        let joint = self.joint_active();
        for cd in &d.clusters {
            if !joint {
                self.cs_delta.clusters_off += 1;
                continue;
            }
            let Some(&ci) = cd.ids.first().and_then(|id| self.cluster_of.get(id)) else {
                self.cs_delta.clusters_gone += 1;
                continue;
            };
            if self.clusters[ci].add_delta(cd, f64::from(w0)) {
                self.cs_delta.clusters += 1;
                work += cd.size() as u64;
            } else {
                self.cs_delta.clusters_stale += 1;
            }
        }
        // The forgetting clock, frame by frame as `update_fpstats` moves
        // it (the sums above went in at the un-renormalised weights, and a
        // renormalisation scales everything alike).
        for _ in 0..d.frames.len() {
            self.stats_w /= self.stats_gamma;
            if self.stats_w > 1024.0 {
                let f = 1.0 / self.stats_w;
                self.fpstats.values_mut().for_each(|s| s.scale(f));
                self.clusters.iter_mut().for_each(|c| c.scale(f64::from(f)));
                self.stats_w = 1.0;
            }
        }
        let charged = if self.cs_delta_charge_equiv {
            d.work_equiv
        } else {
            work
        };
        self.cs_delta.work += work;
        self.work += charged;
        self.cs_stats.frames_fit += d.frames.len() as u64;
        self.cs_stats.work += charged;
        Ok(true)
    }

    /// Counters of [`SlowLoop::apply_settle_delta`].
    pub fn settle_delta_stats(&self) -> SettleDeltaStats {
        self.cs_delta
    }

    /// Evaluation only: charge each applied settle delta the work
    /// `observe_settle` would have spent on its frames rather than the
    /// apply's own (so a timed model schedules as before and only the
    /// numbers differ).
    #[doc(hidden)]
    pub fn set_settle_delta_charge_equiv(&mut self, on: bool) {
        self.cs_delta_charge_equiv = on;
    }
}
