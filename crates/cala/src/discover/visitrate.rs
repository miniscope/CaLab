//! The Discover visit rate: a cap on ordinary tile visits per observed
//! Discover frame, and the schedule that sets it ([`VisitSchedule`]).
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
//! behind its target) by slowing the frames down; the engine reports what
//! it needs for that ([`VisitRateStats`]), the target included.
//!
//! # The schedule
//!
//! A fixed rate spends as many visits per frame at the end of a 3 h
//! recording, when the field is mapped, as at its start. **Auto** (the
//! app's opt-in, `?debug&visitrate=auto`; the fixed rate is its default) moves the target down a ladder while visits stop finding
//! new cells and back up when they find them again:
//!
//! * The signal is the **yield**: new cells (adds the add classification,
//!   `churn.rs`, calls new; re-adds where a cell was just removed do not
//!   count) per completed ordinary visit. Per visit, not per frame: births
//!   per frame fall with the rate itself (fewer visits, fewer births, lower
//!   rate), and frame counts depend on dropped frames, so on the machine.
//!   Nothing here reads a clock or a frame rate.
//! * Two windows, exponentially weighted over visits: a slow one (half-life
//!   [`VisitSchedule::slow_half_life`] visits) moves the target down, the
//!   fast one ([`VisitSchedule::fast_half_life`]) may also move it up.
//!   Both start full (a prior of `slow_half_life` visits at
//!   `full_yield`), and the target is held for the first
//!   `warmup_visits_per_tile` visits per tile, so a quiet start (cells
//!   that have not fired yet) does not drop the rate.
//! * The rate the yield asks for is `target × min(1, yield / full_yield)`;
//!   the target in force is a rung of a ladder from `target` down to the
//!   floor in steps of 1/√2 ([`VisitSchedule::rung_rate`]): down to the
//!   lowest rung at or above what the slow window asks for, up when the
//!   larger of the two windows asks for at least one rung more.
//! * The cap is the target times `cap_ratio` (the app: 4/3, as the fixed
//!   0.15 / 0.2 pair; `qc_eval`, which has no frame-loop hold: 1).
//!
//! The schedule is fed where a visit's result lands ([`SlowLoop::step`] for
//! a visit made in place, [`SlowLoop::apply_job`] for a job), so a run with
//! visit workers and one without see the same curve; a `VisitRunner` does
//! not feed it.
//!
//! The cap applies to ordinary visits only (`step`, `step_via`,
//! `take_job`), however their tiles came due (live frames, look-back
//! frames, edits nearby). Settle visits ([`SlowLoop::step_settle`],
//! [`SlowLoop::take_settle_job`]) and every visit outside
//! [`EditScope::All`] (the Final settle, Refine runs) are not counted or
//! held and do not feed the schedule. Off (rate 0) by default: the loop
//! then behaves exactly as before.

use super::{EditScope, SlowLoop};

/// Credit banked at most, in frames of the rate (and never under one
/// visit): a stretch where everything due was blocked can catch up by this
/// much at once, no more.
pub const VISIT_BANK_FRAMES: f64 = 16.0;

/// The frame-loop hold's floor as a share of the target (the app's
/// governor: 0.1 against 0.15).
pub const VISIT_HOLD_FLOOR_RATIO: f64 = 2.0 / 3.0;

/// The Discover visit rate's schedule ([`SlowLoop::set_visit_schedule`]).
/// See the module docs; the constants are in [`VisitSchedule::auto`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisitSchedule {
    /// Auto (the ladder) or fixed (always `target`).
    pub auto: bool,
    /// Visits per frame while visits find new cells (fixed: always).
    pub target: f64,
    /// Rungs below the target; the floor is `target × 2^(-steps/2)`.
    pub steps: u32,
    /// New cells per visit at or above which the target holds.
    pub full_yield: f64,
    /// Half-lives of the two windows, visits.
    pub slow_half_life: f64,
    pub fast_half_life: f64,
    /// The target holds for the first this many visits per tile.
    pub warmup_visits_per_tile: f64,
    /// The cap over the target in force.
    pub cap_ratio: f64,
}

impl VisitSchedule {
    /// The app's opt-in Auto schedule (the fixed rate is the default).
    ///
    /// * `target` 0.15 and the cap at 4/3 of it: the fixed rate's values
    ///   (PR #500: on full-length sims recall saturates by about 0.2 visits
    ///   per frame while late duplicate false cells keep growing).
    /// * Four rungs of 1/√2 below: 0.106, 0.075, 0.053 and the floor
    ///   0.0375 (a quarter of the target).
    /// * `full_yield` 0.2 (one new cell per five visits): on the sims at
    ///   0.15 the yield falls from above 1 in the first 2,000 frames to 0.23
    ///   by 4,000 and 0.02-0.05 by 8,000-9,000 frames; on 15 min of real
    ///   CA1 data it holds 0.18-0.21 to 5,000 frames, then 0.05-0.14.
    /// * Windows of 64 (down) and 24 (up) visits: about 400 and 160 frames
    ///   at the target, 1,700 and 640 at the floor.
    /// * Warm-up: 2 visits per tile.
    pub const fn auto() -> VisitSchedule {
        VisitSchedule {
            auto: true,
            target: 0.15,
            steps: 4,
            full_yield: 0.2,
            slow_half_life: 64.0,
            fast_half_life: 24.0,
            warmup_visits_per_tile: 2.0,
            cap_ratio: 4.0 / 3.0,
        }
    }

    /// The fixed rate (the app's default; `?debug&visitrate=auto` opts into Auto).
    pub const fn fixed() -> VisitSchedule {
        VisitSchedule {
            auto: false,
            ..VisitSchedule::auto()
        }
    }

    /// The rate of rung `k` (0: the target).
    pub fn rung_rate(&self, k: u32) -> f64 {
        self.target * 0.5f64.powf(f64::from(k) / 2.0)
    }

    /// The lowest rate Auto goes to.
    pub fn floor(&self) -> f64 {
        self.rung_rate(if self.auto { self.steps } else { 0 })
    }

    fn is_valid(&self) -> bool {
        self.target.is_finite()
            && self.target > 0.0
            && self.full_yield.is_finite()
            && self.full_yield > 0.0
            && self.slow_half_life >= 1.0
            && self.fast_half_life >= 1.0
            && self.warmup_visits_per_tile.is_finite()
            && self.cap_ratio.is_finite()
            && self.cap_ratio > 0.0
    }

    /// The lowest rung whose rate is at least what `yield_` asks for.
    fn rung_for(&self, yield_: f64) -> u32 {
        let want = self.target * (yield_ / self.full_yield).clamp(0.0, 1.0);
        (0..=self.steps)
            .rev()
            .find(|&k| self.rung_rate(k) >= want * (1.0 - 1e-9))
            .unwrap_or(0)
    }
}

/// Counters of the visit cap and its schedule ([`SlowLoop::visit_rate_stats`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VisitRateStats {
    /// Visits per observed frame at most now (0: off).
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
    /// Credit earned so far, visits (the sum of `rate` over observed frames).
    pub earned: f64,
    /// The target in force, visits per frame (0: off), and the frame-loop
    /// hold's floor under it.
    pub target: f64,
    pub hold_floor: f64,
    /// Auto (1) or fixed (0).
    pub auto: bool,
    /// The rung in force (0: the target).
    pub rung: u32,
    /// The yields of the slow and fast windows, new cells per visit.
    pub yield_slow: f64,
    pub yield_fast: f64,
    /// Ordinary visits completed and new cells they found (what the
    /// schedule was fed), and how often the rung changed.
    pub fed_visits: u64,
    pub fed_new: u64,
    pub rung_changes: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct VisitRate {
    /// The cap in force, visits per observed frame (0: off).
    pub rate: f64,
    pub credit: f64,
    pub earned: f64,
    pub frames: u64,
    pub visits: u64,
    pub capped_frames: u64,
    /// A due visit was held back since the last observed frame.
    pub capped_now: bool,
    /// The schedule (None: a bare cap from `set_visit_rate`).
    pub sched: Option<VisitSchedule>,
    pub rung: u32,
    /// The windows' weighted new cells and visits.
    pub slow: (f64, f64),
    pub fast: (f64, f64),
    pub fed_visits: u64,
    pub fed_new: u64,
    pub rung_changes: u64,
}

impl VisitRate {
    fn bank(&self) -> f64 {
        (self.rate * VISIT_BANK_FRAMES).max(1.0)
    }

    fn target(&self) -> f64 {
        match self.sched {
            Some(s) => s.rung_rate(self.rung),
            None => self.rate,
        }
    }

    /// One completed ordinary visit that found `new` new cells, on a loop
    /// with `tiles` tiles.
    fn feed(&mut self, new: u64, tiles: usize) {
        let Some(s) = self.sched else {
            return;
        };
        self.fed_visits += 1;
        self.fed_new += new;
        let n = new as f64;
        let ew = |w: (f64, f64), hl: f64| {
            let d = 0.5f64.powf(1.0 / hl);
            (w.0 * d + n, w.1 * d + 1.0)
        };
        self.slow = ew(self.slow, s.slow_half_life);
        self.fast = ew(self.fast, s.fast_half_life);
        if !s.auto || (self.fed_visits as f64) < s.warmup_visits_per_tile * tiles as f64 {
            return;
        }
        let ys = self.slow.0 / self.slow.1;
        let yf = self.fast.0 / self.fast.1;
        let down = s.rung_for(ys);
        // Up only when the yield asks for at least the rung above the one in
        // force (hysteresis: down needs the slow window at or below the rung
        // under it, so a steady yield between two rungs does not flap).
        let y_up = ys.max(yf);
        let asks = s.target * (y_up / s.full_yield).clamp(0.0, 1.0);
        let next = if down > self.rung {
            down
        } else if self.rung > 0 && asks >= s.rung_rate(self.rung - 1) * (1.0 - 1e-9) {
            s.rung_for(y_up)
        } else {
            self.rung
        };
        if next != self.rung {
            self.rung = next;
            self.rung_changes += 1;
            self.rate = s.rung_rate(next) * s.cap_ratio;
        }
    }
}

impl SlowLoop {
    /// Cap ordinary Discover visits at `rate` per observed frame (0 or
    /// less, or not finite: off, the default), with no schedule. The credit
    /// starts empty when the cap is turned on and is dropped when it is
    /// turned off.
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
        self.vrate.sched = None;
    }

    /// Run the visit cap from `s` (see the module docs): the cap starts at
    /// the target times `cap_ratio` with full windows. An invalid schedule
    /// turns the cap off.
    pub fn set_visit_schedule(&mut self, s: VisitSchedule) {
        if !s.is_valid() {
            self.set_visit_rate(0.0);
            return;
        }
        let v = &mut self.vrate;
        v.sched = Some(s);
        v.rung = 0;
        v.rate = s.target * s.cap_ratio;
        v.slow = (s.full_yield * s.slow_half_life, s.slow_half_life);
        v.fast = (s.full_yield * s.fast_half_life, s.fast_half_life);
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
        let ratio = |w: (f64, f64)| if w.1 > 0.0 { w.0 / w.1 } else { 0.0 };
        let target = v.target();
        VisitRateStats {
            rate: v.rate,
            credit: v.credit,
            frames: v.frames,
            visits: v.visits,
            capped_frames: v.capped_frames,
            due_tiles,
            earned: v.earned,
            target,
            hold_floor: target * VISIT_HOLD_FLOOR_RATIO,
            auto: v.sched.is_some_and(|s| s.auto),
            rung: v.rung,
            yield_slow: ratio(v.slow),
            yield_fast: ratio(v.fast),
            fed_visits: v.fed_visits,
            fed_new: v.fed_new,
            rung_changes: v.rung_changes,
        }
    }

    /// The schedule in force (None: none, or a bare cap).
    pub fn visit_schedule(&self) -> Option<VisitSchedule> {
        self.vrate.sched
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
        v.earned += v.rate;
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

    /// An ordinary visit's result landed with `new_before` the new-cell
    /// count (`ChurnCounts::adds_new`) before it: feed the schedule.
    pub(crate) fn visit_rate_done(&mut self, new_before: u64) {
        if !self.visit_cap_on() {
            return;
        }
        let new = self.churn.counts().adds_new.saturating_sub(new_before);
        let tiles = self.tiles.len();
        self.vrate.feed(new, tiles);
    }
}

#[cfg(test)]
mod schedule_tests {
    use super::*;

    fn start(s: VisitSchedule) -> VisitRate {
        VisitRate {
            sched: Some(s),
            rate: s.target * s.cap_ratio,
            slow: (s.full_yield * s.slow_half_life, s.slow_half_life),
            fast: (s.full_yield * s.fast_half_life, s.fast_half_life),
            ..VisitRate::default()
        }
    }

    /// Feed `n` visits finding one new cell every `every` visits (0: none).
    fn feed(v: &mut VisitRate, n: u64, every: u64, tiles: usize) {
        for i in 0..n {
            let new = u64::from(every > 0 && i % every == 0);
            v.feed(new, tiles);
        }
    }

    #[test]
    fn ladder() {
        let s = VisitSchedule::auto();
        assert!((s.rung_rate(0) - 0.15).abs() < 1e-12);
        assert!((s.floor() - 0.0375).abs() < 1e-12);
        assert_eq!(s.rung_for(0.5), 0);
        assert_eq!(s.rung_for(0.2), 0);
        assert_eq!(s.rung_for(0.0), s.steps);
        // Asks for 0.075: exactly rung 2.
        assert_eq!(s.rung_for(0.1), 2);
        // Asks for a bit more than rung 2: rung 1.
        assert_eq!(s.rung_for(0.11), 1);
        assert!((VisitSchedule::fixed().floor() - 0.15).abs() < 1e-12);
    }

    /// High yield holds the target; a yield that dies away slides the
    /// target to the floor; new cells again bring it back up, faster than
    /// it came down.
    #[test]
    fn slides_down_and_comes_back() {
        let s = VisitSchedule::auto();
        let tiles = 100;
        let mut v = start(s);
        feed(&mut v, 1000, 2, tiles);
        assert_eq!(v.rung, 0);
        assert!((v.rate - 0.2).abs() < 1e-12);
        // No new cells: down to the floor.
        let mut down_at = None;
        for i in 0..2000 {
            v.feed(0, tiles);
            if v.rung == s.steps && down_at.is_none() {
                down_at = Some(i);
            }
        }
        let down_at = down_at.expect("reached the floor");
        assert!(down_at > 100, "slid down after {down_at} visits");
        assert!((v.target() - s.floor()).abs() < 1e-12);
        assert!((v.rate - s.floor() * s.cap_ratio).abs() < 1e-12);
        // New cells on every other visit: back up to the target.
        let mut up_at = None;
        for i in 0..2000 {
            v.feed(u64::from(i % 2 == 0), tiles);
            if v.rung == 0 && up_at.is_none() {
                up_at = Some(i);
            }
        }
        let up_at = up_at.expect("back at the target");
        assert!(up_at < down_at, "up after {up_at}, down after {down_at}");
        assert!(v.rung_changes >= 2);
    }

    /// A steady yield between the target and the floor settles on one rung
    /// and does not flap.
    #[test]
    fn steady_yield_settles() {
        let s = VisitSchedule::auto();
        let mut v = start(s);
        // One new cell per 10 visits asks for 0.075: rung 2.
        feed(&mut v, 3000, 10, 100);
        assert_eq!(v.rung, 2);
        let changes = v.rung_changes;
        feed(&mut v, 3000, 10, 100);
        assert_eq!(v.rung_changes, changes, "flapped");
    }

    /// The warm-up holds the target however little the first visits find.
    #[test]
    fn warm_up_holds_the_target() {
        let s = VisitSchedule::auto();
        let tiles = 100;
        let mut v = start(s);
        feed(&mut v, 199, 0, tiles);
        assert_eq!(v.rung, 0);
        v.feed(0, tiles);
        assert!(v.rung > 0);
    }

    /// Fixed: the yields are kept, the target never moves.
    #[test]
    fn fixed_never_moves() {
        let s = VisitSchedule {
            cap_ratio: 1.0,
            ..VisitSchedule::fixed()
        };
        let mut v = start(s);
        feed(&mut v, 3000, 0, 10);
        assert_eq!(v.rung, 0);
        assert!((v.rate - 0.15).abs() < 1e-12);
        assert!(v.slow.0 / v.slow.1 < 1e-6);
        assert_eq!(v.fed_visits, 3000);
    }
}
