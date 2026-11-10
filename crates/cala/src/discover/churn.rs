//! Accounting of the slow loop's adds: which are new cells, which come back
//! where a cell was just removed, and which are removed again soon after.
//!
//! Cell discovery never stops on long recordings (batch tools find nearly
//! twice the cells in 30-120 min as in 10-30 min), so the add rate alone
//! cannot say whether the library has converged. What should die out is
//! *churn*: a cell added and then merged or deleted again, or added back at
//! a spot where a cell was just removed. Every add is classified when it is
//! made, and every removal is checked against the age of the cell it
//! removes:
//!
//! * **re-add**: the new cell's filtered footprint overlaps one removed
//!   (deleted, or merged away) within `readd_window_frames` (cosine of the
//!   filtered footprints at least `readd_cos`, or centres closer than
//!   `readd_dist_cells` cell diameters);
//! * **new**: any other add;
//! * **churned**: a cell added by the slow loop and removed (deleted, merged
//!   away, or merged with an older cell) within `churn_frames` of its add.
//!   This is known only at the removal, so it is counted then;
//! * **established removal**: a merge or delete in which every cell
//!   involved is older than `churn_frames` (or was seeded).
//!
//! Frames are slow-loop frames (frames observed), like every other window of
//! the slow loop. Nothing here changes a decision of the slow loop.
//!
//! Thresholds, from `examples/qc_eval.rs` runs (`adds.tsv`, `removals.tsv`;
//! three minisim recordings and 15 min of real CA1 data):
//!
//! * The re-add test's two criteria agree: of late adds, those with a
//!   remembered removal within 5 px (half a cell diameter) and those with a
//!   filtered-footprint cosine of at least 0.5 are nearly the same set (48
//!   vs 50 on the motion sim, 104 vs 115 on real data), and the cosine falls
//!   off fast beyond (median 0.85 below 3 px, 0.26 at 6-9 px, 0 beyond 12).
//! * Window: re-adds keep arriving minutes after the removal, because the
//!   slow loop's tombstones hold a spot for a cooldown that grows with each
//!   removal (on real data 12 of the eventual 104 within 1 min, 31 within
//!   2, 61 within 4, 84 within 8). 4800 frames (4 min at 20 Hz) catches
//!   most of them while a random add lands within 5 px of a remembered
//!   removal only ~2 % of the time at real-data removal rates.
//! * Churn window: ages at removal of added cells have no natural break
//!   (median 1600-2700 frames, log-normal-like). 2400 frames (2 min) is
//!   the same horizon the QC uses for "existing" cells (`QcConfig::
//!   stable_min_age_s`), so a removal counts either as churn of a new add
//!   or as a removal of an established cell, never both; both feed the
//!   convergence rule, so the split only matters for display.

use std::collections::{HashMap, VecDeque};

/// Thresholds of the add classification.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChurnConfig {
    /// Removed cells are remembered this many frames for the re-add test.
    pub readd_window_frames: u64,
    /// An add is a re-add when its filtered footprint has at least this
    /// cosine with a recently removed cell's...
    pub readd_cos: f32,
    /// ...or its centre is within this many cell diameters of one.
    pub readd_dist_cells: f32,
    /// A cell removed within this many frames of its add is churn.
    pub churn_frames: u64,
}

impl Default for ChurnConfig {
    fn default() -> ChurnConfig {
        ChurnConfig {
            readd_window_frames: 4800,
            readd_cos: 0.5,
            readd_dist_cells: 0.5,
            churn_frames: 2400,
        }
    }
}

impl ChurnConfig {
    pub fn is_valid(&self) -> bool {
        self.readd_cos.is_finite()
            && self.readd_dist_cells.is_finite()
            && self.readd_dist_cells >= 0.0
    }
}

/// Class of an add.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AddClass {
    New,
    ReAdd,
}

impl AddClass {
    pub fn as_str(self) -> &'static str {
        match self {
            AddClass::New => "new",
            AddClass::ReAdd => "readd",
        }
    }
}

/// Cumulative counts of the add classification (since the start).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChurnCounts {
    pub adds_new: u64,
    pub adds_readd: u64,
    /// Adds removed again within `churn_frames` (counted at the removal).
    pub churned: u64,
    /// ...of which re-adds.
    pub churned_readd: u64,
    /// Merges and deletes among cells all older than `churn_frames`.
    pub established_removals: u64,
}

/// One add, with the evidence it was classified on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AddRecord {
    pub frame: u64,
    pub id: u64,
    pub class: AddClass,
    /// Centre of the new cell (row, column), px.
    pub center: (f32, f32),
    /// Best cosine of the filtered footprints with a remembered removed
    /// cell, the distance (px) of the nearest one's centre, and the frames
    /// since that nearest one's removal (NaN / `u64::MAX` when none).
    pub cos: f32,
    pub dist: f32,
    pub since: u64,
}

/// How a cell left the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RemovalKind {
    Delete,
    /// Merged with another cell (the younger of the pair is the removal).
    Merge,
}

impl RemovalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RemovalKind::Delete => "delete",
            RemovalKind::Merge => "merge",
        }
    }
}

/// One removal (a delete, or a merge counted against its younger cell).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemovalRecord {
    pub frame: u64,
    pub id: u64,
    pub kind: RemovalKind,
    /// Centre of the footprint that left (merge: the one merged away).
    pub center: (f32, f32),
    /// Frame of the cell's add, and its class (`None`: seeded or split).
    pub born: u64,
    pub class: Option<AddClass>,
    /// Counted as churn (an add removed within `churn_frames`).
    pub churned: bool,
}

/// A removed cell, remembered for the re-add test.
struct Removed {
    frame: u64,
    center: (f32, f32),
    pix: Vec<u32>,
    /// Filtered values, unit norm.
    val: Vec<f32>,
}

/// Birth of a cell the slow loop made.
#[derive(Clone, Copy)]
struct Birth {
    frame: u64,
    /// `None`: made by a split (not an add).
    class: Option<AddClass>,
}

/// The accounting state (`SlowLoop` holds one).
pub(crate) struct Churn {
    cfg: ChurnConfig,
    diameter: f32,
    removed: VecDeque<Removed>,
    births: HashMap<u64, Birth>,
    counts: ChurnCounts,
    adds: Vec<AddRecord>,
    removals: Vec<RemovalRecord>,
    dense: HashMap<u32, f32>,
}

/// Bound of the record logs between two `take_*` calls.
const MAX_LOG: usize = 100_000;

impl Churn {
    pub fn new(cfg: ChurnConfig, diameter: f32) -> Churn {
        Churn {
            cfg,
            diameter,
            removed: VecDeque::new(),
            births: HashMap::new(),
            counts: ChurnCounts::default(),
            adds: Vec::new(),
            removals: Vec::new(),
            dense: HashMap::new(),
        }
    }

    pub fn counts(&self) -> ChurnCounts {
        self.counts
    }

    pub fn take_adds(&mut self) -> Vec<AddRecord> {
        std::mem::take(&mut self.adds)
    }

    pub fn take_removals(&mut self) -> Vec<RemovalRecord> {
        std::mem::take(&mut self.removals)
    }

    fn forget(&mut self, now: u64) {
        while self
            .removed
            .front()
            .is_some_and(|r| now.saturating_sub(r.frame) > self.cfg.readd_window_frames)
        {
            self.removed.pop_front();
        }
    }

    /// A cell was added (`pix`, `filt`: its support and filtered values).
    pub fn on_add(&mut self, now: u64, id: u64, center: (f32, f32), pix: &[u32], filt: &[f32]) {
        self.forget(now);
        self.dense.clear();
        let nrm = filt.iter().map(|v| v * v).sum::<f32>().sqrt();
        if nrm > 0.0 {
            for (&p, &v) in pix.iter().zip(filt) {
                self.dense.insert(p, v / nrm);
            }
        }
        let (mut cos, mut dist, mut since) = (f32::NAN, f32::NAN, u64::MAX);
        let reach = 3.0 * self.diameter;
        for r in &self.removed {
            let d = ((r.center.0 - center.0).powi(2) + (r.center.1 - center.1).powi(2)).sqrt();
            if d > reach {
                continue;
            }
            let c: f32 = r
                .pix
                .iter()
                .zip(&r.val)
                .filter_map(|(p, v)| self.dense.get(p).map(|w| v * w))
                .sum();
            if !(c <= cos) {
                cos = c;
            }
            if !(d >= dist) {
                dist = d;
                since = now.saturating_sub(r.frame);
            }
        }
        let readd = cos >= self.cfg.readd_cos || dist <= self.cfg.readd_dist_cells * self.diameter;
        let class = if readd {
            self.counts.adds_readd += 1;
            AddClass::ReAdd
        } else {
            self.counts.adds_new += 1;
            AddClass::New
        };
        self.births.insert(
            id,
            Birth {
                frame: now,
                class: Some(class),
            },
        );
        if self.adds.len() >= MAX_LOG {
            self.adds.drain(..MAX_LOG / 2);
        }
        self.adds.push(AddRecord {
            frame: now,
            id,
            class,
            center,
            cos,
            dist,
            since,
        });
    }

    /// A cell was made by a split (tracked for age, not counted as an add).
    pub fn on_split(&mut self, now: u64, id: u64) {
        self.births.insert(
            id,
            Birth {
                frame: now,
                class: None,
            },
        );
    }

    fn remember(&mut self, now: u64, center: (f32, f32), pix: &[u32], filt: &[f32]) {
        let nrm = filt.iter().map(|v| v * v).sum::<f32>().sqrt();
        if nrm > 0.0 {
            self.removed.push_back(Removed {
                frame: now,
                center,
                pix: pix.to_vec(),
                val: filt.iter().map(|v| v / nrm).collect(),
            });
        }
        self.forget(now);
    }

    /// Age of `id` (`None`: seeded, older than anything tracked).
    fn age(&self, now: u64, id: u64) -> Option<u64> {
        self.births.get(&id).map(|b| now.saturating_sub(b.frame))
    }

    fn record(&mut self, now: u64, id: u64, kind: RemovalKind, center: (f32, f32)) {
        let b = self.births.get(&id).copied();
        let young = b.is_some_and(|b| now.saturating_sub(b.frame) < self.cfg.churn_frames);
        let class = b.and_then(|b| b.class);
        let churned = young && class.is_some();
        if churned {
            self.counts.churned += 1;
            if class == Some(AddClass::ReAdd) {
                self.counts.churned_readd += 1;
            }
        } else if !young {
            self.counts.established_removals += 1;
        }
        if self.removals.len() >= MAX_LOG {
            self.removals.drain(..MAX_LOG / 2);
        }
        self.removals.push(RemovalRecord {
            frame: now,
            id,
            kind,
            center,
            born: b.map_or(0, |b| b.frame),
            class,
            churned,
        });
    }

    /// A cell was deleted.
    pub fn on_delete(&mut self, now: u64, id: u64, center: (f32, f32), pix: &[u32], filt: &[f32]) {
        self.remember(now, center, pix, filt);
        self.record(now, id, RemovalKind::Delete, center);
        self.births.remove(&id);
    }

    /// Cells `kept` and `gone` were merged into `kept` (`gone`'s footprint
    /// before the merge is remembered for the re-add test). The younger of
    /// the two is the removal; `kept` carries on with the older's birth.
    #[allow(clippy::too_many_arguments)]
    pub fn on_merge(
        &mut self,
        now: u64,
        kept: u64,
        gone: u64,
        center: (f32, f32),
        pix: &[u32],
        filt: &[f32],
    ) {
        self.remember(now, center, pix, filt);
        let (ak, ag) = (self.age(now, kept), self.age(now, gone));
        // `None` (seeded) is the oldest.
        let kept_younger = match (ak, ag) {
            (Some(a), Some(b)) => a < b,
            (Some(_), None) => true,
            _ => false,
        };
        if kept_younger {
            self.record(now, kept, RemovalKind::Merge, center);
            match self.births.remove(&gone) {
                Some(b) => {
                    self.births.insert(kept, b);
                }
                None => {
                    self.births.remove(&kept);
                }
            }
        } else {
            self.record(now, gone, RemovalKind::Merge, center);
            self.births.remove(&gone);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(cy: f32, cx: f32, w: u32) -> (Vec<u32>, Vec<f32>) {
        let mut pix = Vec::new();
        let mut val = Vec::new();
        for y in 0..w {
            for x in 0..w {
                let d2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                if d2 <= 36.0 {
                    pix.push(y * w + x);
                    val.push((-d2 / 18.0).exp());
                }
            }
        }
        (pix, val)
    }

    #[test]
    fn classifies_new_readd_churn_and_established() {
        let cfg = ChurnConfig {
            readd_window_frames: 1000,
            readd_cos: 0.5,
            readd_dist_cells: 0.5,
            churn_frames: 500,
        };
        let mut c = Churn::new(cfg, 10.0);
        let (pa, va) = disk(20.0, 20.0, 64);
        let (pb, vb) = disk(20.0, 45.0, 64);
        c.on_add(0, 1, (20.0, 20.0), &pa, &va);
        c.on_add(10, 2, (20.0, 45.0), &pb, &vb);
        assert_eq!(c.counts().adds_new, 2);
        // Cell 1 deleted young: churn; re-added at the same spot: re-add.
        c.on_delete(100, 1, (20.0, 20.0), &pa, &va);
        assert_eq!(c.counts().churned, 1);
        c.on_add(200, 3, (20.5, 20.0), &pa, &va);
        assert_eq!(c.counts().adds_readd, 1);
        // Far from the removal: new. After the window: new again.
        c.on_add(300, 4, (50.0, 10.0), &pb, &vb);
        assert_eq!(c.counts().adds_new, 3);
        c.on_add(1200, 5, (20.0, 20.0), &pa, &va);
        assert_eq!(c.counts().adds_new, 4);
        // Old cells 2 and 4 merged: an established removal; the younger
        // (4) is the removal and 2 keeps its birth.
        c.on_merge(2000, 2, 4, (50.0, 10.0), &pb, &vb);
        assert_eq!(c.counts().established_removals, 1);
        assert_eq!(c.counts().churned, 1);
        // Young re-add 3? It is old by now (born 200): established.
        c.on_delete(2100, 3, (20.0, 20.0), &pa, &va);
        assert_eq!(c.counts().established_removals, 2);
        // A young cell merged into an old one is churn, whichever id stays.
        c.on_add(2200, 6, (30.0, 30.0), &pb, &vb);
        c.on_merge(2300, 6, 2, (20.0, 45.0), &pb, &vb);
        assert_eq!(c.counts().churned, 2);
        assert_eq!(c.age(2300, 6), Some(2290));
        let rem = c.take_removals();
        assert_eq!(rem.len(), 4);
        assert!(rem[0].churned && rem[0].kind == RemovalKind::Delete);
        assert!(rem[3].churned && rem[3].id == 6);
        let adds = c.take_adds();
        assert_eq!(adds.len(), 6);
        assert!(adds[2].cos > 0.99 && adds[2].since == 100);
    }
}
