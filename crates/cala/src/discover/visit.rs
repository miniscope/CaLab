//! Stepping: which tile to visit, the visit itself, and publishing the library.

#[cfg(feature = "diagnostics")]
use super::diagnostics;
use super::local::{BgBasis, Cell, Rect};
use super::shard::Op;
use super::solve::Solved;
use super::{timing, SlowLoop, SlowStats};
use crate::trace::{Library, LibraryBuilder, TraceError};
use std::sync::Arc;

impl SlowLoop {
    /// Whether slow-loop frame `frame` (0 = the first frame observed) is
    /// held out: never used to fit footprints, only to test edits. See
    /// [`SlowLoopConfig::is_test`].
    pub fn is_test(&self, frame: u64) -> bool {
        self.cfg.is_test(frame)
    }

    /// Spend about `budget` work units (multiply-adds; ~1e9/s native) on
    /// tile visits, carrying any overrun into the next call. Returns a new
    /// library when edits were published; swap it into the fast loop.
    pub fn step(&mut self, budget: u64) -> Result<Option<Arc<Library>>, TraceError> {
        self.prune();
        self.credit = self.credit.saturating_add(budget as i64);
        while self.credit > 0 {
            let Some(ti) = self.next_tile() else {
                // Nothing to do: idle budget is not banked.
                self.credit = 0;
                break;
            };
            if !self.visit_allowed(true) {
                // Held by the visit cap: the work budget is not banked either.
                self.credit = self.credit.min(budget as i64);
                break;
            }
            self.visit_spent();
            let w0 = self.work;
            let new0 = self.churn.counts().adds_new;
            self.visit(ti)?;
            self.visit_rate_done(new0);
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

    pub(super) fn next_tile(&self) -> Option<usize> {
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

    pub(super) fn publish(&mut self) -> Result<Arc<Library>, TraceError> {
        let mut b = LibraryBuilder::new(self.dims)
            .fov(self.fov.clone())
            .noise(self.noise.clone())
            .background(self.cfg.background.clone());
        // Only edited cells are filtered again.
        let mut changed = self.cells.len();
        if let Some(prev) = &self.published {
            b = b.reuse(prev.clone());
            changed = self
                .cells
                .iter()
                .filter(|c| {
                    prev.slot(c.id).is_none_or(|s| {
                        prev.unfiltered(s).1 != c.raw.as_slice()
                            || prev.skirt(s) != (c.skirt_blk.as_slice(), c.skirt.as_slice())
                    })
                })
                .count();
        }
        let support: usize = self.cells.iter().map(|c| c.pix.len()).sum();
        for c in &self.cells {
            if c.skirt_blk.is_empty() {
                b.push_disk(c.footprint(self.dims), c.center, c.radius);
            } else {
                let skirt = c.skirt_blk.iter().copied().zip(c.skirt.iter().copied());
                b.push_disk_skirt(c.footprint(self.dims), c.center, c.radius, skirt.collect());
            }
        }
        let lib = b.build_timed(&mut self.flattener, &mut self.build)?;
        let mut lap = timing::Lap::start();
        // The working set takes the exact filtered columns.
        let w = self.dims.width;
        let mut cells = Vec::with_capacity(lib.len());
        let born: std::collections::HashMap<u64, u64> =
            self.cells.iter().map(|c| (c.id, c.born)).collect();
        for slot in 0..lib.len() {
            let (center, radius) = lib.support(slot);
            let (pix, raw) = lib.unfiltered(slot);
            let (_, filt) = lib.filtered(slot);
            let (low_blk, low) = lib.lowpass(slot);
            let (skirt_blk, skirt) = lib.skirt(slot);
            let bbox = Rect::around(center.0, center.1, radius, self.dims);
            debug_assert!(pix
                .iter()
                .all(|&g| bbox.local(g as usize / w, g as usize % w).is_some()));
            cells.push(Cell {
                id: lib.ids()[slot],
                center,
                radius,
                bbox,
                pix: pix.to_vec(),
                raw: raw.to_vec(),
                filt: filt.to_vec(),
                low_blk: low_blk.to_vec(),
                low: low.to_vec(),
                skirt_blk: skirt_blk.to_vec(),
                skirt: skirt.to_vec(),
                born: born.get(&lib.ids()[slot]).copied().unwrap_or(0),
            });
        }
        // Filtering the edited cells (full-frame passes, many cells per
        // pass) and assembling the solve terms.
        self.work +=
            (self.dims.pixels() * 40) as u64 * (1 + changed as u64 / 50) + support as u64 * 40;
        self.cells = cells;
        lap.lap(&mut self.build.ms[timing::part::CELLS]);
        if let Some(tap) = self.publish_tap.as_mut() {
            tap(&lib);
        }
        #[cfg(feature = "diagnostics")]
        diagnostics::support_library(self);
        let lib = Arc::new(lib);
        self.published = Some(lib.clone());
        self.pending = false;
        self.last_commit = self.frames;
        self.stats.commits += 1;
        self.edits.commits += 1;
        Ok(lib)
    }

    fn visit(&mut self, ti: usize) -> Result<(), TraceError> {
        self.visit_begin(ti);
        self.visit_body(ti)
    }

    /// The bookkeeping of a visit (on the slow loop that owns the tile).
    pub(super) fn visit_begin(&mut self, ti: usize) {
        self.stats.visits += 1;
        self.tiles[ti].fresh = 0;
        self.tiles[ti].last_visit = self.frames;
        self.tile_visits[ti] += 1;
        let now = self.frames;
        self.tiles[ti]
            .rejected
            .retain(|r| r.2 > now || r.3 > 0 && r.2 + 4 * self.cfg.reject_cooldown_frames > now);
    }

    /// Whether a tile's visit number `visit` (counted from 1) refines.
    pub(super) fn refines_on(&self, visit: u32) -> bool {
        self.cfg.refine_every_visits > 0 && visit.is_multiple_of(self.cfg.refine_every_visits)
    }

    /// Whether the next visit of tile `ti` would do nothing but read the
    /// tile's reservoir: in [`EditScope::Refine`] (no keep tests, merges or
    /// adds), a visit that is not a refinement visit.
    pub(crate) fn idle_visit(&self, ti: usize) -> bool {
        let s = self.scope;
        !s.prunes() && !s.merges() && !s.grows() && !self.refines_on(self.tile_visits[ti] + 1)
    }

    /// The tests and edits of a visit (here, or in a [`VisitRunner`]).
    pub(super) fn visit_body(&mut self, ti: usize) -> Result<(), TraceError> {
        self.clear_visit_memos();
        let r = self.visit_tests(ti);
        self.clear_visit_memos();
        r
    }

    /// Turn the visit memos and caches off (tests: the plain computation
    /// to compare against).
    #[cfg(test)]
    pub(crate) fn set_reuse(&mut self, on: bool) {
        self.reuse = on;
    }

    fn clear_visit_memos(&mut self) {
        self.gram_memo = None;
        *self.grid_memo.get_mut() = None;
        self.tile_model = None;
        self.solve_memo.clear();
        self.resid_memo = None;
    }

    fn visit_tests(&mut self, ti: usize) -> Result<(), TraceError> {
        if self.bgs[ti].is_none() {
            self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
        }
        self.stage.visit_calls += u64::from(timing::ON);
        let mut lap = timing::Lap::start();
        let mut snap = self.stats;
        let scope = self.scope;
        let w0 = self.work;
        if scope.prunes() {
            self.keep_tests(ti);
        }
        self.stats.work_keep += self.work - w0;
        self.stage_visit(0, &mut lap, &mut snap);
        let w0 = self.work;
        let fit_fr = self.load(ti, false);
        let test_fr = self.load(ti, true);
        self.stats.work_load += self.work - w0;
        self.stage_visit(1, &mut lap, &mut snap);
        if fit_fr.len() < self.cfg.min_fit_frames || test_fr.len() < self.cfg.min_test_frames {
            return Ok(());
        }
        let refine = self.refines_on(self.tile_visits[ti]);
        if !refine && !scope.merges() && !scope.grows() {
            // Nothing this visit would use the tile's solve for.
            return Ok(());
        }
        // One solve of the tile's model serves all three edits; refinements
        // and merges made on this visit leave its residual slightly stale for
        // the add proposals, but every edit is tested on the current model.
        let w0 = self.work;
        let mut solved = self.solve_tile(ti, &fit_fr);
        self.stats.work_load += self.work - w0;
        self.stage_visit(2, &mut lap, &mut snap);
        let split = scope.grows()
            && self.cfg.split_every_visits > 0
            && self.tile_visits[ti].is_multiple_of(self.cfg.split_every_visits);
        if split {
            let w0 = self.work;
            if self.split(ti, &solved, &test_fr) {
                solved = self.solve_tile(ti, &fit_fr);
            }
            self.stats.work_split += self.work - w0;
            self.stage_visit(3, &mut lap, &mut snap);
        }
        if refine {
            let w0 = self.work;
            self.refine(ti, &solved, &test_fr);
            self.stats.work_refine += self.work - w0;
            self.stage_visit(4, &mut lap, &mut snap);
        }
        if scope.merges() {
            let w0 = self.work;
            self.merge(ti, &fit_fr, &test_fr);
            self.stats.work_merge += self.work - w0;
            self.stage_visit(5, &mut lap, &mut snap);
        }
        if scope.grows() {
            let w0 = self.work;
            let Solved { base, fits, resid } = solved;
            self.add(ti, resid, &base, &fits, &test_fr);
            self.stats.work_add += self.work - w0;
            self.stage_visit(6, &mut lap, &mut snap);
        }
        Ok(())
    }

    /// Feature `timing`: charge a visit phase its time since the last mark
    /// and the edits it made since `snap` (then move `snap`). A no-op
    /// otherwise.
    #[inline(always)]
    fn stage_visit(&mut self, phase: usize, lap: &mut timing::Lap, snap: &mut SlowStats) {
        if !timing::ON {
            return;
        }
        lap.lap(&mut self.stage.visit[phase]);
        let (a, b) = (*snap, self.stats);
        let d = [
            b.adds - a.adds,
            b.merges - a.merges,
            b.refines - a.refines,
            b.splits - a.splits,
            b.deletes - a.deletes,
            b.absorbs - a.absorbs,
            b.proposals - a.proposals,
        ];
        for (x, y) in self.stage.visit_edits[phase].iter_mut().zip(d) {
            *x += y;
        }
        *snap = b;
    }

    /// Mark the tiles whose patch overlaps `bbox` as due for a visit.
    pub(super) fn touch(&mut self, bbox: Rect) {
        journal!(self, Op::Touch(bbox));
        let due = self.cfg.visit_after_slots;
        for t in self.tiles.iter_mut() {
            if t.rect.intersects(&bbox) {
                self.due_diag.touch += u64::from(t.fresh < due);
                t.fresh = t.fresh.max(due);
            }
        }
    }
}
