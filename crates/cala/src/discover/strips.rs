//! Strip helpers (experimental, off by default): the footprint statistics
//! of a batch of frames summed by row strip on other threads.
//!
//! The slow loop's `observe` spends about half its time updating every
//! cell's running footprint statistics and every cluster store
//! (`update_fpstats`, `update_clusters`). Each cell touches only its
//! statistics disk and each store only its pixels, so the update splits by
//! image area. For a batch of frames solved with one library
//! ([`SlowLoop::strips_begin`]) the slow loop
//!
//! 1. runs the statistics upkeep for the batch's library once (disk moves,
//!    store moves, columns), as the batch's first fitting frame would;
//! 2. hands out one [`SettleContext`] per row strip: the cells whose disk
//!    centre lies in the strip, the stores whose first member's does, each
//!    cell's frame count (split-half blocks), and the rows that hold all
//!    their pixels (a halo as wide as the data needs; nothing is cut);
//! 3. observes the batch's frames with the statistics update left out,
//!    while the helpers sum their strips ([`SettleDeltaBuilder`] on rows);
//! 4. adds the deltas that come back ([`SlowLoop::strips_apply`]) at the
//!    forgetting weight it had at step 1, then moves the clock by the
//!    batch's fitting frames.
//!
//! Nothing may read or write the statistics between 1 and 4 (the driver
//! holds visit results and look-back answers until the apply), so no delta
//! is ever dropped: the counters say so. Against `observe` the sums agree up
//! to f32/f64 rounding (frames are summed relative to the weight before the
//! batch); a ~1e-7 difference can still flip a discrete gate later.

use super::settle_delta::{SettleContext, SettleDelta};
use super::SlowLoop;
use crate::trace::{Library, TraceError};

/// One strip of a batch: the frame rows its helper is given and its
/// context.
#[derive(Debug, Clone)]
pub struct StripJob {
    pub row0: usize,
    pub row1: usize,
    pub ctx: SettleContext,
}

/// The batch between [`SlowLoop::strips_begin`] and
/// [`SlowLoop::strips_apply`].
#[derive(Debug, Clone)]
pub(super) struct StripPending {
    version: u64,
    /// The fitting slow-loop indices of the batch (each delta's frames).
    keys: Vec<u64>,
    /// Frames of the batch (all go through `observe` before the apply).
    count: u64,
    first: u64,
    w0: f32,
    strips: usize,
    /// Work `update_fpstats` would have spent per fitting frame.
    work_frame: u64,
}

/// Counters of the strip helpers ([`SlowLoop::strip_stats`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StripStats {
    /// Batches begun and applied, and their fitting frames.
    pub batches: u64,
    pub applied: u64,
    pub frames: u64,
    /// Strips handed out (summed over batches), and the largest number of
    /// rows one was given.
    pub strips: u64,
    pub max_rows: u64,
    /// Cell and store sums added, and dropped (a cell gone or moved, a
    /// store gone or of another basis; both must stay 0).
    pub cells: u64,
    pub clusters: u64,
    pub dropped_cells: u64,
    pub dropped_clusters: u64,
    pub cluster_skips: u64,
}

impl SlowLoop {
    /// Begin a strip batch: the next `count` frames, all solved with `lib`,
    /// go through [`SlowLoop::observe`] without the statistics update, and
    /// the returned jobs (at most `strips`, fewer when there are fewer
    /// cells and stores) sum it. `None`, nothing changed: observe the batch
    /// the ordinary way (no fitting frame in it, no cell, or the
    /// transient-band statistics on).
    pub fn strips_begin(
        &mut self,
        lib: &Library,
        count: u64,
        strips: usize,
    ) -> Result<Option<Vec<StripJob>>, TraceError> {
        if self.strip_pending.is_some() || self.stats_prepaid > 0 {
            return Err(TraceError::Incompatible(
                "the last strip batch is not applied yet".into(),
            ));
        }
        if lib.dims() != self.dims {
            return Err(TraceError::Incompatible(
                "a library of another frame size".into(),
            ));
        }
        let first = self.frames;
        let keys: Vec<u64> = (first..first + count)
            .filter(|&f| !self.is_test(f))
            .collect();
        if strips == 0
            || keys.is_empty()
            || lib.is_empty()
            || self.cfg.core_test.collects()
            || self.lb_only.is_some()
        {
            return Ok(None);
        }
        self.stats_upkeep_all(lib);
        let (w, h) = (self.dims.width, self.dims.height);
        let row = |p: u32| p as usize / w;
        // Items: (owner row, work, pixel rows, cell slot | store index).
        enum Item {
            Cell(usize),
            Store(usize),
        }
        let mut items: Vec<(f32, u64, usize, usize, Item)> = Vec::new();
        let mut work_frame = 0u64;
        for (slot, id) in lib.ids().iter().enumerate() {
            let st = &self.fpstats[id];
            // (A disk with no pixel still counts its frames: a strip of no rows.)
            let (a, b) = match (st.pix.first(), st.pix.last()) {
                (Some(&a), Some(&b)) => (row(a), row(b) + 1),
                _ => {
                    let r = (st.center.0.max(0.0) as usize).min(h);
                    (r, r)
                }
            };
            let n = st.pix.len() as u64;
            work_frame += 3 * n;
            items.push((st.center.0, n.max(1), a, b, Item::Cell(slot)));
        }
        if self.joint_active() {
            for (ci, c) in self.clusters.iter().enumerate() {
                // A store goes with its first member's disk centre.
                let y = c
                    .ids
                    .first()
                    .and_then(|id| self.fpstats.get(id))
                    .map_or(0.0, |s| s.center.0);
                let (a, b) = match (c.pix.first(), c.pix.last()) {
                    (Some(&a), Some(&b)) => (row(a), row(b) + 1),
                    _ => {
                        let r = (y.max(0.0) as usize).min(h);
                        (r, r)
                    }
                };
                let n = c.pix.len() as u64;
                let kk = c.ids.len() as u64;
                work_frame += n * (3 * kk + 3);
                items.push((y, (n * (kk + 1)).max(1), a, b, Item::Store(ci)));
            }
        }
        if items.is_empty() {
            return Ok(None);
        }
        items.sort_by(|a, b| a.0.total_cmp(&b.0));
        // Borders by cumulative work: strip `s` takes the items whose
        // work's midpoint on the running total falls in its share.
        let total: u64 = items.iter().map(|it| it.1).sum();
        let n = strips.min(items.len());
        let mut groups: Vec<Vec<&(f32, u64, usize, usize, Item)>> = vec![Vec::new(); n];
        let mut acc = 0u64;
        for it in &items {
            let mid = 2 * acc as u128 + it.1 as u128;
            let s = ((mid * n as u128) / (2 * total.max(1) as u128)) as usize;
            groups[s.min(n - 1)].push(it);
            acc += it.1;
        }
        let blk = super::fpstats::parity_block(self.cfg.cell_diameter_px);
        let mut jobs = Vec::new();
        for g in groups.into_iter().filter(|g| !g.is_empty()) {
            let row0 = g.iter().map(|it| it.2).min().unwrap_or(0);
            let row1 = g.iter().map(|it| it.3).max().unwrap_or(0);
            let mut cells = Vec::new();
            let mut ks = Vec::new();
            let mut clusters = Vec::new();
            for it in g {
                match it.4 {
                    Item::Cell(slot) => {
                        let id = lib.ids()[slot];
                        let st = &self.fpstats[&id];
                        cells.push((id, st.center, st.radius));
                        ks.push(st.k);
                    }
                    Item::Store(ci) => clusters.push(self.clusters[ci].snap()),
                }
            }
            self.strip_stats.max_rows = self.strip_stats.max_rows.max((row1 - row0) as u64);
            jobs.push(StripJob {
                row0,
                row1,
                ctx: SettleContext {
                    width: self.dims.width,
                    height: self.dims.height,
                    blk,
                    gamma: self.stats_gamma,
                    cells,
                    clusters,
                    upkeep: None,
                    rows: Some((row0, row1)),
                    ks,
                },
            });
        }
        self.strip_stats.batches += 1;
        self.strip_stats.strips += jobs.len() as u64;
        self.stats_prepaid = count;
        self.strip_pending = Some(StripPending {
            version: lib.version(),
            keys,
            count,
            first,
            w0: self.stats_w,
            strips: jobs.len(),
            work_frame,
        });
        Ok(Some(jobs))
    }

    /// Whether a strip batch waits for its deltas.
    pub fn strips_pending(&self) -> bool {
        self.strip_pending.is_some()
    }

    /// The fitting slow-loop indices of the pending strip batch (what each
    /// helper sums, in order; empty when none is pending).
    pub fn strips_keys(&self) -> &[u64] {
        self.strip_pending.as_ref().map_or(&[], |p| &p.keys)
    }

    /// Add the deltas of the pending strip batch, one per job of
    /// [`SlowLoop::strips_begin`], once all its frames went through
    /// `observe`. A delta of other frames or another library is refused
    /// (an error: the batch's statistics would be lost).
    pub fn strips_apply(&mut self, deltas: &[SettleDelta]) -> Result<(), TraceError> {
        let Some(p) = self.strip_pending.take() else {
            return Err(TraceError::Incompatible("no strip batch is pending".into()));
        };
        let refuse = |p: StripPending, s: &mut SlowLoop, msg: String| {
            s.strip_pending = Some(p);
            Err(TraceError::Incompatible(msg))
        };
        if self.stats_prepaid > 0 || self.frames != p.first + p.count {
            return refuse(
                p,
                self,
                "the strip batch's frames are not all observed".into(),
            );
        }
        if deltas.len() != p.strips {
            let msg = format!("{} strip deltas for {} strips", deltas.len(), p.strips);
            return refuse(p, self, msg);
        }
        if let Some(d) = deltas
            .iter()
            .find(|d| d.version() != p.version || d.frames() != p.keys.as_slice())
        {
            let msg = format!(
                "a strip delta of library {} and {} frames, not {} and {}",
                d.version(),
                d.frames().len(),
                p.version,
                p.keys.len()
            );
            return refuse(p, self, msg);
        }
        debug_assert_eq!(self.stats_w, p.w0);
        let mut work = 0u64;
        for d in deltas {
            let (wk, n) = self.add_delta_sums(d, p.w0);
            work += wk;
            let s = &mut self.strip_stats;
            s.cells += n.cells;
            s.clusters += n.clusters;
            s.dropped_cells += n.cells_gone + n.cells_moved;
            s.dropped_clusters += n.clusters_gone + n.clusters_stale + n.clusters_off;
            s.cluster_skips += d.cluster_skips();
            self.replay_stats.skipped_frames += d.cluster_skips();
        }
        self.advance_stats_clock(p.keys.len());
        self.strip_stats.applied += 1;
        self.strip_stats.frames += p.keys.len() as u64;
        // Charged what the per-frame update would have cost (the timing
        // model and the work counters see the same slow loop either way).
        let charged = p.work_frame * p.keys.len() as u64;
        let _ = work;
        self.work += charged;
        self.stats.work_stats += charged;
        Ok(())
    }

    /// Drop a pending strip batch whose deltas will never come (the run
    /// stopped): its frames' statistics are lost.
    pub fn strips_abandon(&mut self) {
        self.strip_pending = None;
        self.stats_prepaid = 0;
    }

    /// Counters of the strip helpers.
    pub fn strip_stats(&self) -> StripStats {
        self.strip_stats
    }
}
