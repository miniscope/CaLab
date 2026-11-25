//! The Discover visit rate: a cap on ordinary tile visits per observed
//! Discover frame ([`SlowLoop::set_visit_rate`]).
//!
//! How many tile visits Discover makes per frame sets how many cells it
//! finds and, at high rates, how many false cells it adds
//! (`tools/cala-eval/results/2026-11-24-visit-budget-sweep.md`). Without a
//! cap that rate is whatever the machine has time for: a run paced at a
//! stream's rate visits every tile as soon as it is due (about 20 times
//! the visits of a run at full speed). With the cap, visits are handed out
//! against a credit that grows by `rate` per frame `observe` takes in
//! [`EditScope::All`], so a slow or paced run visits no more than `rate`
//! per frame. The driver keeps the other side (a visit rate that falls
//! behind its target) by slowing the frames down; the engine only reports
//! what it needs for that ([`VisitRateStats`]).
//!
//! The cap applies to ordinary visits only (`step`, `step_via`,
//! `take_job`), however their tiles came due (live frames, look-back
//! frames, edits nearby). Settle visits ([`SlowLoop::step_settle`],
//! [`SlowLoop::take_settle_job`]) and every visit outside
//! [`EditScope::All`] (the Final settle, Refine runs) are not counted or
//! held. Off (rate 0) by default: the loop then behaves exactly as before.

use super::{EditScope, SlowLoop};

/// Credit banked at most, in frames of the rate (and never under one
/// visit): a stretch where everything due was blocked can catch up by this
/// much at once, no more.
pub const VISIT_BANK_FRAMES: f64 = 16.0;

/// Counters of the visit cap ([`SlowLoop::visit_rate_stats`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VisitRateStats {
    /// Visits per observed frame (0: off).
    pub rate: f64,
    /// Unspent credit, visits.
    pub credit: f64,
    /// Frames observed under the cap.
    pub frames: u64,
    /// Ordinary visits made under the cap.
    pub visits: u64,
    /// Frames on which a due visit was held back for lack of credit (the
    /// cap was what limited the visits).
    pub capped_frames: u64,
    /// Tiles due for a visit now (not in flight).
    pub due_tiles: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct VisitRate {
    pub rate: f64,
    pub credit: f64,
    pub frames: u64,
    pub visits: u64,
    pub capped_frames: u64,
    /// A due visit was held back since the last observed frame.
    pub capped_now: bool,
}

impl VisitRate {
    fn bank(&self) -> f64 {
        (self.rate * VISIT_BANK_FRAMES).max(1.0)
    }
}

impl SlowLoop {
    /// Cap ordinary Discover visits at `rate` per observed frame (0 or
    /// less, or not finite: off, the default). The credit starts empty
    /// when the cap is turned on and is dropped when it is turned off.
    pub fn set_visit_rate(&mut self, rate: f64) {
        let rate = if rate.is_finite() && rate > 0.0 {
            rate
        } else {
            0.0
        };
        if rate == 0.0 {
            self.vrate.credit = 0.0;
        }
        self.vrate.rate = rate;
    }

    /// The cap's counters.
    pub fn visit_rate_stats(&self) -> VisitRateStats {
        let v = &self.vrate;
        let due = self.cfg.visit_after_slots;
        let due_tiles = self
            .tiles
            .iter()
            .enumerate()
            .filter(|(i, t)| t.fresh >= due && !self.inflight.iter().any(|f| f.ti == *i))
            .count() as u64;
        VisitRateStats {
            rate: v.rate,
            credit: v.credit,
            frames: v.frames,
            visits: v.visits,
            capped_frames: v.capped_frames,
            due_tiles,
        }
    }

    /// The cap is on and applies now.
    fn visit_cap_on(&self) -> bool {
        self.vrate.rate > 0.0 && self.scope == EditScope::All
    }

    /// `observe` took in a frame: earn its credit. Credit is not banked
    /// while nothing is due (a quiet stretch must not become a burst).
    pub(crate) fn visit_rate_frame(&mut self) {
        if !self.visit_cap_on() {
            return;
        }
        let idle = self.next_tile().is_none();
        let v = &mut self.vrate;
        if idle {
            v.credit = v.credit.min(1.0);
        }
        v.credit = (v.credit + v.rate).min(v.bank());
        v.frames += 1;
        v.capped_now = false;
    }

    /// May an ordinary visit be made now? With `due` (a tile is due), a
    /// refusal counts the frame as capped.
    pub(crate) fn visit_allowed(&mut self, due: bool) -> bool {
        if !self.visit_cap_on() || self.vrate.credit >= 1.0 {
            return true;
        }
        if due && !self.vrate.capped_now {
            self.vrate.capped_now = true;
            self.vrate.capped_frames += 1;
        }
        false
    }

    /// An ordinary visit was made: spend its credit.
    pub(crate) fn visit_spent(&mut self) {
        if self.visit_cap_on() {
            self.vrate.credit -= 1.0;
            self.vrate.visits += 1;
        }
    }
}
