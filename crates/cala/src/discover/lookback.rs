//! Look-back scheduler (concurrent Refine inside Discover).
//!
//! Discover's slow loop is also fed *past* frames, re-read from the saved
//! recording (raw is always saved), preprocessed as the live pipeline did,
//! solved with a separate trace engine on the *current* library, and pushed
//! into the running footprint statistics and cluster stores only
//! ([`SlowLoop::observe_lookback`]). The live fast loop and the slow loop's
//! clocks are never touched.
//!
//! This module decides *which* past frames to re-read and for which cells.
//! It never reads a frame itself: the driver asks [`LookBack::next`] for the
//! next frame, supplies it preprocessed (with its traces) to
//! [`SlowLoop::observe_lookback`], and reports back with
//! [`LookBack::frame_done`]. So the same scheduler serves `qc_eval` (frames
//! from the recording on disk) and the app (frames from the loaded file, or a
//! history store for a live stream).
//!
//! * Need-driven (the design): a cell born at frame `b` (a new id in the
//!   published library; a merge or split result is new too), and every cell
//!   whose support touches it, *needs* the frames `b - K..b` it never had
//!   ([`LookbackConfig::max_frames`], the per-cell bound). The cursor works in
//!   [`LB_BLOCK`]-frame blocks (each block forward): it takes the block the
//!   most cells still need (ties: the most recent block) and serves it to all
//!   of them, so one re-read serves every cell born within `K` frames of it.
//!   [`LookbackConfig::rate`] look-back frames per Discover frame; idle budget
//!   is not banked, so the work follows the birth rate (proportional to new
//!   cells, not to the recording's length).
//! * Precision demand ([`LookbackConfig::target`] > 0): instead of the
//!   `K`-frame window, every cell whose split-half footprint noise
//!   ([`SlowLoop::footprint_noise`]) is above the target needs look-back
//!   frames it has not had (frames before its birth first); newborns and
//!   their neighbours are served first.
//!
//! Each block starts from the live preprocessor's state at the moment the
//! block is chosen (the driver copies it when [`LookbackRequest::block`]
//! changes) and runs it forward over the frames it re-reads.

use std::collections::{BTreeMap, HashSet};

use super::SlowLoop;
use crate::trace::Library;

/// Frames per look-back block.
pub const LB_BLOCK: usize = 64;
/// Precision demand: re-enter need only above this multiple of the target
/// (hysteresis).
const LB_REENTER: f64 = 1.15;
/// Precision demand: look-back frames between two noise evaluations of
/// every cell.
const LB_NOISE_EVERY: u64 = 256;

/// Which block the need-driven cursor serves next.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LookbackOrder {
    /// The block most cells still need (ties: the most recent).
    #[default]
    Shared,
    /// The newest cell's most recent block not yet served (to every cell
    /// that needs it).
    Newest,
}

/// Look-back settings.
#[derive(Clone, Debug)]
pub struct LookbackConfig {
    /// Look-back frames per Discover frame.
    pub rate: f64,
    /// At most this many frames before its birth per cell (`K`).
    pub max_frames: usize,
    pub order: LookbackOrder,
    /// Precision demand target (0: the `K`-frame window).
    pub target: f64,
}

impl Default for LookbackConfig {
    /// The validated configuration (`COMBO`): 2 look-back frames per
    /// Discover frame, `K` = 3000, shared order, no precision demand.
    fn default() -> Self {
        LookbackConfig {
            rate: 2.0,
            max_frames: 3000,
            order: LookbackOrder::Shared,
            target: 0.0,
        }
    }
}

/// One frame the driver must supply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LookbackRequest {
    /// Recording frame index.
    pub frame: usize,
    /// The cells that take it (`only` of [`SlowLoop::observe_lookback`]).
    pub ids: Vec<u64>,
    /// Block sequence number: when it changes, the driver starts a fresh
    /// copy of the live preprocessor for the new block.
    pub block: u64,
}

/// What [`LookBack::next`] returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LookbackNext {
    /// Supply this frame, then call [`LookBack::frame_done`].
    Frame(LookbackRequest),
    /// The budget is spent; more comes with [`LookBack::add_credit`].
    NoCredit,
    /// No cell needs anything (idle budget is not banked).
    Idle,
}

/// How the driver handled a [`LookbackRequest`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookbackOutcome {
    /// Preprocessed, solved and passed to [`SlowLoop::observe_lookback`]
    /// (whether or not it was held out there).
    Observed,
    /// Preprocessed (the block's preprocessor ran forward) but not solved:
    /// a held-out frame in precision mode. It costs no budget there.
    Skipped,
}

/// A cell of the precision demand.
struct LbCell {
    /// Frame (recording) at which it entered the published library.
    born: usize,
    /// Look-back blocks already served to it (never twice).
    served: HashSet<usize>,
    /// Born, or a neighbour of a birth, and still above the target.
    prio: bool,
    /// Above the target (with hysteresis), or no usable noise yet.
    need: bool,
}

/// The block in progress: next frame `cur`, `end`, and its cells with the
/// frames `from..to` each takes from it.
struct Block {
    cur: usize,
    end: usize,
    cells: Vec<(u64, usize, usize)>,
    seq: u64,
}

/// The look-back scheduler. See the module docs.
pub struct LookBack {
    cfg: LookbackConfig,
    credit: f64,
    /// Need-driven: id -> (birth frame, blocks of `born - K..born` not yet
    /// served).
    need: BTreeMap<u64, (usize, Vec<usize>)>,
    block: Option<Block>,
    blocks_started: u64,
    known: HashSet<u64>,
    lib_version: u64,
    /// Precision demand cells.
    cells: BTreeMap<u64, LbCell>,
    /// Look-back frames when the noise was last evaluated.
    noise_eval_at: u64,
    frames: u64,
    skipped: u64,
    births: u64,
    /// Discover frames seen (recording frames `0..seen`).
    seen: usize,
}

impl LookBack {
    pub fn new(cfg: LookbackConfig) -> LookBack {
        LookBack {
            cfg,
            credit: 0.0,
            need: Default::default(),
            block: None,
            blocks_started: 0,
            known: Default::default(),
            lib_version: u64::MAX,
            cells: Default::default(),
            noise_eval_at: 0,
            frames: 0,
            skipped: 0,
            births: 0,
            seen: 0,
        }
    }

    pub fn config(&self) -> &LookbackConfig {
        &self.cfg
    }

    /// Look-back frames observed.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Frames passed over (precision mode, held out).
    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    /// New ids seen in published libraries.
    pub fn births(&self) -> u64 {
        self.births
    }

    /// Cells still in need: the `K`-window registry, or the precision
    /// cells above the target.
    pub fn in_need(&self) -> usize {
        if self.cfg.target > 0.0 {
            self.cells.values().filter(|c| c.need).count()
        } else {
            self.need.len()
        }
    }

    /// Entries of the `K`-window need registry (cells with blocks left, as
    /// of the last block choice).
    pub fn window_need(&self) -> usize {
        self.need.len()
    }

    /// Precision mode: (cells, above target, priority left).
    pub fn precision_counts(&self) -> (usize, usize, usize) {
        (
            self.cells.len(),
            self.cells.values().filter(|c| c.need).count(),
            self.cells.values().filter(|c| c.prio).count(),
        )
    }

    /// Discover frames seen so far.
    pub fn seen(&self) -> usize {
        self.seen
    }

    /// Discover has observed recording frames `0..seen` and the live library
    /// is `lib`: note its new ids (births) and their neighbours.
    pub fn note_frame(&mut self, lib: &Library, seen: usize) {
        self.seen = seen;
        if self.cfg.target > 0.0 {
            self.note_births_target(lib, seen);
        } else {
            self.note_births(lib, seen);
        }
    }

    /// Add look-back budget (frames).
    pub fn add_credit(&mut self, add: f64) {
        self.credit += add;
    }

    /// The next frame to supply, with `lib` the library the driver will
    /// solve it with (cells no longer in it are dropped).
    pub fn next(&mut self, sl: &SlowLoop, lib: &Library) -> LookbackNext {
        loop {
            if self.credit < 1.0 {
                return LookbackNext::NoCredit;
            }
            let done = self.block.as_ref().is_none_or(|b| b.cur >= b.end);
            if done && self.cfg.target > 0.0 {
                self.eval_noise(sl, lib);
            }
            if done
                && !(if self.cfg.target > 0.0 {
                    self.next_block_target()
                } else {
                    self.next_block()
                })
            {
                // Nothing needed: idle budget is not banked.
                self.block = None;
                self.credit = self.credit.min(1.0);
                return LookbackNext::Idle;
            }
            let b = self.block.as_mut().expect("block");
            let cur = b.cur;
            b.cells
                .retain(|&(id, _, to)| lib.slot(id).is_some() && to > cur);
            let ids: Vec<u64> = b
                .cells
                .iter()
                .filter(|&&(_, from, _)| from <= cur)
                .map(|c| c.0)
                .collect();
            if !ids.is_empty() {
                return LookbackNext::Frame(LookbackRequest {
                    frame: cur,
                    ids,
                    block: b.seq,
                });
            }
            Self::advance(b);
        }
    }

    /// The driver handled the frame [`LookBack::next`] returned last.
    pub fn frame_done(&mut self, outcome: LookbackOutcome) {
        match outcome {
            LookbackOutcome::Observed => {
                self.frames += 1;
                self.credit -= 1.0;
            }
            LookbackOutcome::Skipped => {
                self.skipped += 1;
                if self.cfg.target <= 0.0 {
                    self.credit -= 1.0;
                }
            }
        }
        if let Some(b) = self.block.as_mut() {
            Self::advance(b);
        }
    }

    /// Past the current frame; no cell left: the block ends here.
    fn advance(b: &mut Block) {
        if b.cells.is_empty() {
            b.end = b.cur + 1;
        }
        b.cur += 1;
    }

    fn start_block(&mut self, cur: usize, end: usize, cells: Vec<(u64, usize, usize)>) {
        self.blocks_started += 1;
        self.block = Some(Block {
            cur,
            end,
            cells,
            seq: self.blocks_started,
        });
    }

    /// Precision mode: births (new ids) and neighbours of births get
    /// priority; every new id starts in need.
    fn note_births_target(&mut self, lib: &Library, seen: usize) {
        if lib.version() == self.lib_version {
            return;
        }
        self.lib_version = lib.version();
        let ids = lib.ids();
        let fresh: Vec<usize> = (0..ids.len())
            .filter(|&s| !self.cells.contains_key(&ids[s]))
            .collect();
        let live: HashSet<u64> = ids.iter().copied().collect();
        self.cells.retain(|id, _| live.contains(id));
        self.births += fresh.len() as u64;
        for &f in &fresh {
            self.cells.insert(
                ids[f],
                LbCell {
                    born: seen,
                    served: Default::default(),
                    prio: true,
                    need: true,
                },
            );
        }
        if fresh.is_empty() {
            return;
        }
        for (s, id) in ids.iter().enumerate() {
            let ((y, x), r) = lib.support(s);
            let touch = fresh.iter().any(|&f| {
                let ((fy, fx), fr) = lib.support(f);
                (fy - y).hypot(fx - x) < fr + r
            });
            if touch {
                let c = self.cells.get_mut(id).expect("cell");
                c.prio = true;
                c.need = true;
            }
        }
    }

    /// Precision mode: every cell's split-half footprint noise against the
    /// target (at most every `LB_NOISE_EVERY` look-back frames).
    fn eval_noise(&mut self, sl: &SlowLoop, lib: &Library) {
        if self.frames < self.noise_eval_at + LB_NOISE_EVERY {
            return;
        }
        self.noise_eval_at = self.frames;
        let target = self.cfg.target;
        for slot in 0..lib.len() {
            let id = lib.ids()[slot];
            let Some(c) = self.cells.get_mut(&id) else {
                continue;
            };
            let (pix, _) = lib.filtered(slot);
            let noise = sl.footprint_noise(id, pix);
            c.need = match noise {
                None => true,
                Some(n) if c.need => n > target,
                Some(n) => n > target * LB_REENTER,
            };
            if !c.need {
                c.prio = false;
            }
        }
    }

    /// Precision mode: the next block. A cell in need wants the blocks of
    /// frames before its birth it has not had, then any other seen block it
    /// has not had from look-back. The block chosen has the most priority
    /// cells wanting it, then the most cells, then is the oldest; every
    /// cell in need that has not had it takes it.
    fn next_block_target(&mut self) -> bool {
        let nb = self.seen / LB_BLOCK;
        if nb == 0 {
            return false;
        }
        let mut count = vec![(0u32, 0u32); nb];
        let mut any = false;
        for c in self.cells.values().filter(|c| c.need) {
            let pre = c.born.div_ceil(LB_BLOCK).min(nb);
            let pre_left = (0..pre).any(|b| !c.served.contains(&b));
            let range = if pre_left { 0..pre } else { 0..nb };
            for b in range {
                if !c.served.contains(&b) {
                    count[b].0 += u32::from(c.prio);
                    count[b].1 += 1;
                    any = true;
                }
            }
        }
        if !any {
            return false;
        }
        let blk = (0..nb)
            .filter(|&b| count[b].1 > 0)
            .max_by_key(|&b| (count[b].0, count[b].1, std::cmp::Reverse(b)))
            .expect("block");
        let (lo, hi) = (blk * LB_BLOCK, (blk + 1) * LB_BLOCK);
        let mut cells = Vec::new();
        for (&id, c) in self.cells.iter_mut() {
            if c.need && c.served.insert(blk) {
                cells.push((id, lo, hi));
            }
        }
        self.start_block(lo, hi, cells);
        true
    }

    /// New ids in the live library since the last call: they and the cells
    /// whose supports touch theirs need the frames before `seen`.
    fn note_births(&mut self, lib: &Library, seen: usize) {
        if lib.version() == self.lib_version {
            return;
        }
        self.lib_version = lib.version();
        let ids = lib.ids();
        let fresh: Vec<usize> = (0..ids.len())
            .filter(|&s| !self.known.contains(&ids[s]))
            .collect();
        self.known = ids.iter().copied().collect();
        self.need.retain(|id, _| self.known.contains(id));
        self.births += fresh.len() as u64;
        for (s, &id) in ids.iter().enumerate() {
            let ((y, x), r) = lib.support(s);
            let touch = fresh.iter().any(|&f| {
                let ((fy, fx), fr) = lib.support(f);
                (fy - y).hypot(fx - x) < fr + r
            });
            if touch {
                // A neighbour already in need keeps its window.
                let lo = seen.saturating_sub(self.cfg.max_frames) / LB_BLOCK;
                let blocks = (lo..seen.div_ceil(LB_BLOCK)).collect();
                self.need.entry(id).or_insert((seen, blocks));
            }
        }
    }

    /// The next block: the one the most cells still need (ties: the most
    /// recent), with each of those cells' frames in it.
    fn next_block(&mut self) -> bool {
        self.need.retain(|_, (_, blocks)| !blocks.is_empty());
        let mut count: BTreeMap<usize, usize> = Default::default();
        for (_, blocks) in self.need.values() {
            for &b in blocks {
                *count.entry(b).or_default() += 1;
            }
        }
        let blk = match self.cfg.order {
            // The newest cell in need, its most recent block not served.
            LookbackOrder::Newest => self
                .need
                .values()
                .max_by_key(|(born, _)| *born)
                .and_then(|(_, blocks)| blocks.iter().max().copied()),
            LookbackOrder::Shared => count.iter().max_by_key(|&(&b, &n)| (n, b)).map(|(&b, _)| b),
        };
        let Some(blk) = blk else {
            return false;
        };
        let k = self.cfg.max_frames;
        let mut cells = Vec::new();
        for (&id, (born, blocks)) in self.need.iter_mut() {
            if let Some(i) = blocks.iter().position(|&b| b == blk) {
                blocks.swap_remove(i);
                let from = (blk * LB_BLOCK).max(born.saturating_sub(k));
                let to = ((blk + 1) * LB_BLOCK).min(*born);
                cells.push((id, from, to));
            }
        }
        let lo = cells.iter().map(|c| c.1).min().expect("cells");
        let hi = cells.iter().map(|c| c.2).max().expect("cells");
        self.start_block(lo, hi, cells);
        true
    }
}

/// The scheduler of the concurrent settle (experimental): how much settle
/// work is due and which saved frames it re-reads.
///
/// The settle gets a share of the slow loop's compute. Where the credit
/// comes from is the only thing that differs between the two modes: on a
/// recording read at full speed every live frame earns `share / (1 -
/// share)` settle frames ([`SettleSched::earn`]); on a live stream the
/// driver spends `share` of the slow worker's idle time and asks for
/// frames directly. The share can be changed at any time
/// ([`SettleSched::set_share`]): an adaptive schedule only has to set it.
///
/// Frames are re-read in chunks of `chunk` frames in a row; the chunks are
/// spread evenly over everything saved so far (a golden-ratio sequence, so
/// any stretch of the schedule covers the history about uniformly).
#[derive(Debug, Clone)]
pub struct SettleSched {
    share: f64,
    chunk: usize,
    k: u64,
    cur: usize,
    left: usize,
    credit: f64,
}

impl SettleSched {
    /// `share` in [0, 1); chunks of `chunk` frames (at least 1).
    pub fn new(share: f64, chunk: usize) -> SettleSched {
        SettleSched {
            share: share.clamp(0.0, 0.99),
            chunk: chunk.max(1),
            k: 0,
            cur: 0,
            left: 0,
            credit: 0.0,
        }
    }

    /// The share of the slow loop's compute the settle gets.
    pub fn share(&self) -> f64 {
        self.share
    }

    /// Change the share (an adaptive schedule).
    pub fn set_share(&mut self, share: f64) {
        self.share = share.clamp(0.0, 0.99);
    }

    /// `live` frames of Discover work were done (a weight may stand in
    /// for a schedule over the recording): the settle is owed its share.
    /// At most 64 frames are banked.
    pub fn earn(&mut self, live: f64) {
        self.credit = (self.credit + live * self.share / (1.0 - self.share)).min(64.0);
    }

    /// Take one settle frame of credit, if owed.
    pub fn take(&mut self) -> bool {
        if self.credit >= 1.0 {
            self.credit -= 1.0;
            true
        } else {
            false
        }
    }

    /// The next frame to re-read among the first `seen` saved frames, and
    /// whether it starts a new chunk (the frame before it was not the one
    /// re-read last). `None` while less than one chunk is saved.
    pub fn next_frame(&mut self, seen: usize) -> Option<(usize, bool)> {
        let mut new = false;
        if self.left == 0 || self.cur >= seen {
            let n = seen / self.chunk;
            if n == 0 {
                return None;
            }
            self.k += 1;
            let u = (self.k as f64 * 0.618_033_988_749_894_9).fract();
            self.cur = ((u * n as f64) as usize).min(n - 1) * self.chunk;
            self.left = self.chunk;
            new = true;
        }
        let f = self.cur;
        self.cur += 1;
        self.left -= 1;
        Some((f, new))
    }
}

/// The held-out decision of every stream frame, for look-back in a driver
/// whose slow loop does not see every frame (the app's Discover drops
/// batches when the slow loop is busy, so a stream frame's slow-loop index
/// is unknown when it is re-read). Two bits per stream frame: observed by
/// the slow loop, and held out there. A frame the slow loop never observed
/// (dropped, or before it started) gets the decision of index
/// `u64::MAX - stream`, as qc_eval gives warm-up frames, so it is
/// deterministic and about as often held out. About 0.5 MB per day at
/// 30 fps.
#[derive(Clone, Debug, Default)]
pub struct HeldOutRecord {
    observed: Vec<u64>,
    held: Vec<u64>,
}

impl HeldOutRecord {
    /// Stream frame `stream` was observed by the slow loop as its frame
    /// `slow_index`.
    pub fn note(&mut self, stream: u64, slow_index: u64, sl: &SlowLoop) {
        let (w, b) = ((stream / 64) as usize, stream % 64);
        if self.observed.len() <= w {
            self.observed.resize(w + 1, 0);
            self.held.resize(w + 1, 0);
        }
        self.observed[w] |= 1 << b;
        if sl.is_test(slow_index) {
            self.held[w] |= 1 << b;
        } else {
            self.held[w] &= !(1 << b);
        }
    }

    /// Whether stream frame `stream` is held out (see the type docs).
    pub fn held_out(&self, stream: u64, sl: &SlowLoop) -> bool {
        let (w, b) = ((stream / 64) as usize, stream % 64);
        match self.observed.get(w) {
            Some(o) if o >> b & 1 == 1 => self.held[w] >> b & 1 == 1,
            _ => sl.is_test(u64::MAX - stream),
        }
    }

    /// Bytes held.
    pub fn bytes(&self) -> usize {
        16 * self.observed.len()
    }
}
