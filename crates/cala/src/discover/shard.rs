//! Tile visits in parallel: one slow loop owns the state, other workers run
//! its visits.
//!
//! A visit (`SlowLoop::visit`) reads one tile's reservoir and the cells near
//! it, and edits only those cells and that neighbourhood. That locality is
//! what this module uses. The **owner** (the `SlowLoop` that observes every
//! frame) keeps the library, the ledger, the reservoirs and every other
//! piece of state, exactly as before. Instead of running a visit itself it
//! can hand one out as a [`VisitJob`]: the tile's reservoir and probes, a
//! copy of the cells within a cell diameter of the tile's patch with their
//! footprint statistics, and the small bookkeeping the visit reads
//! (rejected spots, tombstones, cooldown pairs). A [`VisitRunner`] in
//! another worker runs the unchanged visit code on that copy and records
//! every edit it makes as an [`Op`] (cell pushed / replaced / removed, keep
//! test counts, rejected spot, tombstone, merge cooldown, churn event, ...).
//! The owner applies the ops in order ([`SlowLoop::apply_job`]).
//!
//! **No conflicting visits.** Every job holds a *zone*: its patch widened
//! by a cell diameter plus the bounding boxes of the cells it copied. The
//! owner hands out a tile only when its zone overlaps no zone in flight, so
//! two concurrent visits never read or edit the same cell, and every cell a
//! visit creates lies inside its zone (adds and splits inside the patch,
//! merges inside the union of two copied cells, refinements 2 px beyond a
//! copied support; the zone has a 4 px guard). This is checkerboard
//! scheduling decided at run time: neighbouring tiles never run together,
//! tiles about three apart can. The owner's own edits while a visit is out
//! are the trimming decisions of `prune`; a cell copied into a job in
//! flight is not deleted until the job is back (it is decided again at the
//! next prune). The owner never waits for a job: frames keep being
//! observed, and a tile's frames that arrive meanwhile count toward its
//! next visit.
//!
//! **Ids.** A job numbers new cells from the owner's next id at hand-out;
//! the owner renumbers them on apply, so concurrent jobs never collide.
//!
//! **One worker = the old loop.** [`SlowLoop::step_via`] runs each visit
//! through a job, a byte round trip and an apply, in the order `step` would
//! visit; the tests check that the result is identical to `step`.

use std::collections::HashMap;

use super::churn::Churn;
use super::fpstats::FpStats;
#[cfg(feature = "diagnostics")]
use super::ledger::TestEvent;
use super::ledger::{EditCounts, EditEvent, EditKind, Evidence};
use super::local::{Cell, Rect};
use super::reservoir::{SharedFrames, Tile};
use super::wire::{Reader, Writer, MAGIC};
use super::{SlowLoop, SlowStats};
use crate::trace::{Library, TraceError};

/// One edit a visit made, replayed by the owner in order.
#[derive(Debug, Clone)]
pub(crate) enum Op {
    Push(Cell),
    Replace(u64, Cell),
    Remove(u64),
    Reject(usize, f32, f32),
    Entomb(f32, f32),
    Touch(Rect),
    Keep {
        id: u64,
        pass: u32,
        fail: u32,
        redundant: u32,
        partner: Option<u64>,
    },
    /// `(kept, gone)`: the merged-away cell's evidence goes to the kept
    /// cell; its lives and footprint statistics are dropped.
    LedgerAbsorb(u64, u64),
    ClearRedundant(u64),
    LivesInsert(u64, u32),
    FpRemove(u64),
    MergeRejected(u64, u64, u64),
    ForcedRemove(u64, u64),
    ChurnAdd(Cell),
    /// `(kept, gone cell)`.
    ChurnMerge(u64, Cell),
    ChurnSplit(u64),
}

/// A visit handed out and not yet applied.
#[derive(Debug, Clone)]
pub(crate) struct InFlight {
    pub seq: u64,
    pub ti: usize,
    pub zone: Rect,
    /// Cells copied into the job (not deleted while it is out).
    pub ids: Vec<u64>,
}

/// A tile visit to run elsewhere ([`VisitRunner::run`]).
#[derive(Debug, Clone)]
pub struct VisitJob {
    seq: u64,
    ti: usize,
    frames: u64,
    rho: f32,
    visits: u32,
    id_base: u64,
    noise_gen: u64,
    tile: Tile,
    /// Rejected spots and tombstones of the other tiles the zone reaches.
    others: Vec<(usize, Vec<(f32, f32, u64, u32)>, Vec<(f32, f32, u64, u32)>)>,
    cells: Vec<Cell>,
    /// Cells with an evidence record (the visit only needs to know which).
    ledger: Vec<u64>,
    lives: Vec<(u64, u32)>,
    fpstats: Vec<(u64, FpStats)>,
    merge_rejected: Vec<(u64, u64, u64)>,
    forced: Vec<(u64, u64)>,
}

/// What a visit did, for [`SlowLoop::apply_job`].
#[derive(Debug, Clone)]
pub struct VisitResult {
    seq: u64,
    ti: usize,
    id_base: u64,
    ids_used: u64,
    ops: Vec<Op>,
    log: Vec<EditEvent>,
    /// Held-out edit tests (`diagnostics` only; not carried on the wire).
    #[cfg(feature = "diagnostics")]
    tests: Vec<TestEvent>,
    stats: SlowStats,
    edits: EditCounts,
    pending: bool,
    /// The tile's own "due" count after the visit.
    fresh: u32,
    /// Background projections computed for reservoir slots:
    /// `(is_event, index, frame, projection)`.
    proj: Vec<(bool, u32, u64, (Vec<f64>, f64))>,
    work: u64,
}

impl VisitJob {
    pub fn to_bytes(&self) -> Vec<u8> {
        // A job's own tile carries every patch.
        self.encode(&self.tile, &SharedFrames::new(self.tile.rect))
    }

    /// The bytes, with the reservoir slots taken from `slots` (random
    /// slots without a patch of their own from `shared`).
    fn encode(&self, slots: &Tile, shared: &SharedFrames) -> Vec<u8> {
        let bytes: usize = (slots.events.len() + slots.randoms.len() + self.tile.probes.len())
            * (self.tile.rect.len() * 2 + 128);
        let mut w = Writer {
            buf: Vec::with_capacity(bytes + 4096),
        };
        w.u32(MAGIC);
        w.u64(self.seq);
        w.usize(self.ti);
        w.u64(self.frames);
        w.f32(self.rho);
        w.u32(self.visits);
        w.u64(self.id_base);
        w.u64(self.noise_gen);
        w.tile(&self.tile, slots, shared);
        w.usize(self.others.len());
        for (ti, rej, tombs) in &self.others {
            w.usize(*ti);
            w.spots(rej);
            w.spots(tombs);
        }
        w.usize(self.cells.len());
        for c in &self.cells {
            w.cell(c);
        }
        w.u64s(&self.ledger);
        w.usize(self.lives.len());
        for &(id, n) in &self.lives {
            w.u64(id);
            w.u32(n);
        }
        w.usize(self.fpstats.len());
        for (id, s) in &self.fpstats {
            w.u64(*id);
            w.fpstats(s);
        }
        w.usize(self.merge_rejected.len());
        for &(a, b, u) in &self.merge_rejected {
            w.u64(a);
            w.u64(b);
            w.u64(u);
        }
        w.usize(self.forced.len());
        for &(a, b) in &self.forced {
            w.u64(a);
            w.u64(b);
        }
        w.buf
    }

    pub fn from_bytes(b: &[u8]) -> Result<VisitJob, TraceError> {
        Self::decode(b).ok_or_else(|| TraceError::Incompatible("malformed visit job".into()))
    }

    fn decode(b: &[u8]) -> Option<VisitJob> {
        let mut r = Reader::new(b);
        if r.u32()? != MAGIC {
            return None;
        }
        let seq = r.u64()?;
        let ti = r.usize()?;
        let frames = r.u64()?;
        let rho = r.f32()?;
        let visits = r.u32()?;
        let id_base = r.u64()?;
        let noise_gen = r.u64()?;
        let tile = r.tile()?;
        let n = r.count(24)?;
        let others = (0..n)
            .map(|_| Some((r.usize()?, r.spots()?, r.spots()?)))
            .collect::<Option<_>>()?;
        let n = r.count(40)?;
        let cells = (0..n).map(|_| r.cell()).collect::<Option<_>>()?;
        let ledger = r.u64s()?;
        let n = r.count(12)?;
        let lives = (0..n)
            .map(|_| Some((r.u64()?, r.u32()?)))
            .collect::<Option<_>>()?;
        let n = r.count(40)?;
        let fpstats = (0..n)
            .map(|_| Some((r.u64()?, r.fpstats()?)))
            .collect::<Option<_>>()?;
        let n = r.count(24)?;
        let merge_rejected = (0..n)
            .map(|_| Some((r.u64()?, r.u64()?, r.u64()?)))
            .collect::<Option<_>>()?;
        let n = r.count(16)?;
        let forced = (0..n)
            .map(|_| Some((r.u64()?, r.u64()?)))
            .collect::<Option<_>>()?;
        r.done().then_some(VisitJob {
            seq,
            ti,
            frames,
            rho,
            visits,
            id_base,
            noise_gen,
            tile,
            others,
            cells,
            ledger,
            lives,
            fpstats,
            merge_rejected,
            forced,
        })
    }
}

impl VisitResult {
    /// Work spent on the visit (multiply-adds, as `SlowLoop::work`).
    pub fn work(&self) -> u64 {
        self.work
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(MAGIC);
        w.u64(self.seq);
        w.usize(self.ti);
        w.u64(self.id_base);
        w.u64(self.ids_used);
        w.usize(self.ops.len());
        for op in &self.ops {
            write_op(&mut w, op);
        }
        w.usize(self.log.len());
        for e in &self.log {
            w.event(e);
        }
        w.stats(&self.stats);
        w.edits(&self.edits);
        w.bool(self.pending);
        w.u32(self.fresh);
        w.usize(self.proj.len());
        for (ev, i, f, p) in &self.proj {
            w.bool(*ev);
            w.u32(*i);
            w.u64(*f);
            w.proj(Some(p));
        }
        w.u64(self.work);
        w.buf
    }

    pub fn from_bytes(b: &[u8]) -> Result<VisitResult, TraceError> {
        Self::decode(b).ok_or_else(|| TraceError::Incompatible("malformed visit result".into()))
    }

    fn decode(b: &[u8]) -> Option<VisitResult> {
        let mut r = Reader::new(b);
        if r.u32()? != MAGIC {
            return None;
        }
        let seq = r.u64()?;
        let ti = r.usize()?;
        let id_base = r.u64()?;
        let ids_used = r.u64()?;
        let n = r.count(1)?;
        let ops = (0..n).map(|_| read_op(&mut r)).collect::<Option<_>>()?;
        let n = r.count(41)?;
        let log = (0..n).map(|_| r.event()).collect::<Option<_>>()?;
        let stats = r.stats()?;
        let edits = r.edits()?;
        let pending = r.bool()?;
        let fresh = r.u32()?;
        let n = r.count(14)?;
        let proj = (0..n)
            .map(|_| Some((r.bool()?, r.u32()?, r.u64()?, r.proj()??)))
            .collect::<Option<_>>()?;
        let work = r.u64()?;
        r.done().then_some(VisitResult {
            seq,
            ti,
            id_base,
            ids_used,
            ops,
            log,
            #[cfg(feature = "diagnostics")]
            tests: Vec::new(),
            stats,
            edits,
            pending,
            fresh,
            proj,
            work,
        })
    }
}

fn write_op(w: &mut Writer, op: &Op) {
    match op {
        Op::Push(c) => {
            w.u8(0);
            w.cell(c);
        }
        Op::Replace(id, c) => {
            w.u8(1);
            w.u64(*id);
            w.cell(c);
        }
        Op::Remove(id) => {
            w.u8(2);
            w.u64(*id);
        }
        Op::Reject(ti, y, x) => {
            w.u8(3);
            w.usize(*ti);
            w.f32(*y);
            w.f32(*x);
        }
        Op::Entomb(y, x) => {
            w.u8(4);
            w.f32(*y);
            w.f32(*x);
        }
        Op::Touch(r) => {
            w.u8(5);
            w.rect(*r);
        }
        Op::Keep {
            id,
            pass,
            fail,
            redundant,
            partner,
        } => {
            w.u8(6);
            w.u64(*id);
            w.u32(*pass);
            w.u32(*fail);
            w.u32(*redundant);
            w.opt_u64(*partner);
        }
        Op::LedgerAbsorb(a, b) => {
            w.u8(7);
            w.u64(*a);
            w.u64(*b);
        }
        Op::ClearRedundant(id) => {
            w.u8(8);
            w.u64(*id);
        }
        Op::LivesInsert(id, n) => {
            w.u8(9);
            w.u64(*id);
            w.u32(*n);
        }
        Op::FpRemove(id) => {
            w.u8(10);
            w.u64(*id);
        }
        Op::MergeRejected(a, b, u) => {
            w.u8(11);
            w.u64(*a);
            w.u64(*b);
            w.u64(*u);
        }
        Op::ForcedRemove(a, b) => {
            w.u8(12);
            w.u64(*a);
            w.u64(*b);
        }
        Op::ChurnAdd(c) => {
            w.u8(13);
            w.cell(c);
        }
        Op::ChurnMerge(k, c) => {
            w.u8(14);
            w.u64(*k);
            w.cell(c);
        }
        Op::ChurnSplit(id) => {
            w.u8(15);
            w.u64(*id);
        }
    }
}

fn read_op(r: &mut Reader) -> Option<Op> {
    Some(match r.u8()? {
        0 => Op::Push(r.cell()?),
        1 => Op::Replace(r.u64()?, r.cell()?),
        2 => Op::Remove(r.u64()?),
        3 => Op::Reject(r.usize()?, r.f32()?, r.f32()?),
        4 => Op::Entomb(r.f32()?, r.f32()?),
        5 => Op::Touch(r.rect()?),
        6 => Op::Keep {
            id: r.u64()?,
            pass: r.u32()?,
            fail: r.u32()?,
            redundant: r.u32()?,
            partner: r.opt_u64()?,
        },
        7 => Op::LedgerAbsorb(r.u64()?, r.u64()?),
        8 => Op::ClearRedundant(r.u64()?),
        9 => Op::LivesInsert(r.u64()?, r.u32()?),
        10 => Op::FpRemove(r.u64()?),
        11 => Op::MergeRejected(r.u64()?, r.u64()?, r.u64()?),
        12 => Op::ForcedRemove(r.u64()?, r.u64()?),
        13 => Op::ChurnAdd(r.cell()?),
        14 => Op::ChurnMerge(r.u64()?, r.cell()?),
        15 => Op::ChurnSplit(r.u64()?),
        _ => return None,
    })
}

fn add_stats(a: &mut SlowStats, b: &SlowStats) {
    let (x, y) = (super::wire::stats_fields(a), super::wire::stats_fields(b));
    let mut s = [0u64; super::wire::N_STATS];
    for i in 0..s.len() {
        s[i] = x[i] + y[i];
    }
    *a = super::wire::stats_from(s);
}

fn grow(r: Rect, by: usize, dims: crate::preprocess::Dims) -> Rect {
    let y0 = r.y0.saturating_sub(by);
    let x0 = r.x0.saturating_sub(by);
    let y1 = (r.y0 + r.h + by).min(dims.height);
    let x1 = (r.x0 + r.w + by).min(dims.width);
    Rect {
        y0,
        x0,
        h: y1 - y0,
        w: x1 - x0,
    }
}

/// Extra pixels around a job's copied cells (refinement grows a support by
/// 2 px; the rest is a guard).
const ZONE_GUARD_PX: usize = 4;

impl SlowLoop {
    /// Pixels around a tile's patch whose cells a job copies.
    fn reach_px(&self) -> usize {
        self.cfg.cell_diameter_px.ceil().max(1.0) as usize
    }

    /// The cells a visit of tile `ti` may read or edit, and its zone.
    fn zone(&self, ti: usize) -> (Vec<usize>, Rect) {
        let wide = grow(self.tiles[ti].rect, self.reach_px(), self.dims);
        let mut zone = wide;
        let mut idx = Vec::new();
        for (i, c) in self.cells.iter().enumerate() {
            if c.bbox.intersects(&wide) {
                zone = zone.union(&c.bbox);
                idx.push(i);
            }
        }
        (idx, grow(zone, ZONE_GUARD_PX, self.dims))
    }

    /// Visits handed out and not yet applied.
    pub fn jobs_in_flight(&self) -> usize {
        self.inflight.len()
    }

    /// The tile `step` would visit next among those whose zone overlaps no
    /// job in flight.
    fn next_free_tile(&self) -> Option<usize> {
        if self.inflight.is_empty() {
            return self.next_tile();
        }
        let due = self.cfg.visit_after_slots;
        let mut order: Vec<(usize, u32)> = self
            .tiles
            .iter()
            .enumerate()
            .filter(|(i, t)| t.fresh >= due && !self.inflight.iter().any(|f| f.ti == *i))
            .map(|(i, t)| (i, t.fresh))
            .collect();
        // Most fresh first; ties to the lower index (as `next_tile`).
        order.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        order
            .into_iter()
            .find(|&(i, _)| {
                let (_, z) = self.zone(i);
                !self.inflight.iter().any(|f| f.zone.intersects(&z))
            })
            .map(|(i, _)| i)
    }

    /// Hand out the next tile visit that conflicts with none in flight, or
    /// `None` (nothing due, or everything due is blocked). The tile counts
    /// as visited now; apply the result with [`SlowLoop::apply_job`].
    pub fn take_job(&mut self) -> Option<VisitJob> {
        let ti = self.next_free_tile()?;
        Some(self.make_job(ti, true))
    }

    /// [`SlowLoop::take_job`] as bytes ([`VisitJob::to_bytes`]), without
    /// copying the tile's reservoir twice.
    pub fn take_job_bytes(&mut self) -> Option<Vec<u8>> {
        let ti = self.next_free_tile()?;
        let job = self.make_job(ti, false);
        Some(job.encode(&self.tiles[ti], &self.shared))
    }

    /// The job for tile `ti`; its tile holds a copy of the reservoir slots
    /// only with `slots`.
    fn make_job(&mut self, ti: usize, slots: bool) -> VisitJob {
        self.visit_begin(ti);
        let (idx, zone) = self.zone(ti);
        let probes = std::mem::take(&mut self.tiles[ti].probes);
        let t = &self.tiles[ti];
        let mut tile = Tile::new(t.core, t.rect);
        if slots {
            tile.events = t.events.clone();
            tile.randoms = t.randoms.clone();
            tile.fill_randoms(&self.shared);
        }
        tile.fresh = t.fresh;
        tile.rejected = t.rejected.clone();
        tile.tombs = t.tombs.clone();
        tile.last_visit = t.last_visit;
        tile.probes = probes;
        let cells: Vec<Cell> = idx.iter().map(|&i| self.cells[i].clone()).collect();
        let ids: Vec<u64> = cells.iter().map(|c| c.id).collect();
        let others = self
            .tiles
            .iter()
            .enumerate()
            .filter(|(i, t)| *i != ti && t.core.intersects(&zone))
            .map(|(i, t)| (i, t.rejected.clone(), t.tombs.clone()))
            .collect();
        let ledger = ids
            .iter()
            .copied()
            .filter(|id| self.ledger.contains_key(id))
            .collect();
        let lives = ids
            .iter()
            .filter_map(|id| self.lives.get(id).map(|&n| (*id, n)))
            .collect();
        let fpstats = ids
            .iter()
            .filter_map(|id| self.fpstats.get(id).map(|s| (*id, s.clone())))
            .collect();
        self.job_seq += 1;
        let seq = self.job_seq;
        self.inflight.push(InFlight { seq, ti, zone, ids });
        VisitJob {
            seq,
            ti,
            frames: self.frames,
            rho: self.rho,
            visits: self.tile_visits[ti],
            id_base: self.next_id,
            noise_gen: self.noise_gen,
            tile,
            others,
            cells,
            ledger,
            lives,
            fpstats,
            merge_rejected: self.merge_rejected.clone(),
            forced: self.forced.clone(),
        }
    }

    /// Apply a visit's edits (see the module docs). Results may come back
    /// in any order; each must come from a job this loop handed out.
    pub fn apply_job(&mut self, r: VisitResult) -> Result<(), TraceError> {
        let Some(k) = self.inflight.iter().position(|f| f.seq == r.seq) else {
            return Err(TraceError::Incompatible(format!(
                "visit result {} was not handed out by this slow loop",
                r.seq
            )));
        };
        let own = self.inflight.swap_remove(k);
        if own.ti != r.ti {
            return Err(TraceError::Incompatible("visit result tile".into()));
        }
        let base = r.id_base;
        let next = self.next_id;
        let map = |id: u64| if id >= base { id - base + next } else { id };
        self.next_id += r.ids_used;
        let ti = r.ti;
        let now = self.frames;
        self.merge_rejected.retain(|p| p.2 > now);
        for op in r.ops {
            match op {
                Op::Push(mut c) => {
                    c.id = map(c.id);
                    self.cells.push(c);
                }
                Op::Replace(id, mut c) => {
                    let id = map(id);
                    c.id = id;
                    if let Some(i) = self.cells.iter().position(|x| x.id == id) {
                        self.cells[i] = c;
                    }
                }
                Op::Remove(id) => {
                    let id = map(id);
                    if let Some(i) = self.cells.iter().position(|x| x.id == id) {
                        self.cells.remove(i);
                    }
                }
                Op::Reject(t, y, x) => self.reject_at(t, y, x),
                Op::Entomb(y, x) => self.entomb_at((y, x)),
                Op::Touch(bbox) => {
                    let due = self.cfg.visit_after_slots;
                    for (i, t) in self.tiles.iter_mut().enumerate() {
                        if i != ti && t.rect.intersects(&bbox) {
                            t.fresh = t.fresh.max(due);
                        }
                    }
                }
                Op::Keep {
                    id,
                    pass,
                    fail,
                    redundant,
                    partner,
                } => {
                    if let Some(ev) = self.ledger.get_mut(&map(id)) {
                        ev.passes += pass;
                        ev.fails += fail;
                        ev.redundant += redundant;
                        if let Some(p) = partner {
                            ev.partner = Some(map(p));
                        }
                    }
                }
                Op::LedgerAbsorb(kept, gone) => {
                    let (kept, gone) = (map(kept), map(gone));
                    if let Some(ev) = self.ledger.remove(&gone) {
                        self.ledger
                            .entry(kept)
                            .or_insert_with(Evidence::new)
                            .absorb(&ev);
                    }
                    self.lives.remove(&gone);
                    self.fpstats.remove(&gone);
                }
                Op::ClearRedundant(id) => {
                    if let Some(ev) = self.ledger.get_mut(&map(id)) {
                        ev.redundant = 0;
                        ev.partner = None;
                    }
                }
                Op::LivesInsert(id, n) => {
                    self.lives.insert(map(id), n);
                }
                Op::FpRemove(id) => {
                    self.stats_forget(map(id));
                }
                Op::MergeRejected(a, b, u) => {
                    let (a, b) = (map(a), map(b));
                    self.merge_rejected.push((a.min(b), a.max(b), u));
                }
                Op::ForcedRemove(a, b) => {
                    let (a, b) = (map(a), map(b));
                    let pair = (a.min(b), a.max(b));
                    self.forced.retain(|&p| p != pair);
                }
                Op::ChurnAdd(c) => {
                    self.churn
                        .on_add(self.frames, map(c.id), c.center, &c.pix, &c.filt);
                }
                Op::ChurnMerge(kept, g) => {
                    self.churn.on_merge(
                        self.frames,
                        map(kept),
                        map(g.id),
                        g.center,
                        &g.pix,
                        &g.filt,
                    );
                }
                Op::ChurnSplit(id) => self.churn.on_split(self.frames, map(id)),
            }
        }
        for mut e in r.log {
            e.id = map(e.id);
            if matches!(e.kind, EditKind::Add | EditKind::Merge | EditKind::Split) {
                e.other = map(e.other);
            }
            if self.edit_log.len() >= 100_000 {
                self.edit_log.drain(..50_000);
            }
            self.edit_log.push(e);
        }
        #[cfg(feature = "diagnostics")]
        for mut e in r.tests {
            e.id = map(e.id);
            if matches!(e.kind, EditKind::Merge | EditKind::Split) {
                e.other = map(e.other);
            }
            if self.test_log.len() >= 200_000 {
                self.test_log.drain(..100_000);
            }
            self.test_log.push(e);
        }
        add_stats(&mut self.stats, &r.stats);
        let e = &mut self.edits;
        e.adds += r.edits.adds;
        e.merges += r.edits.merges;
        e.deletes += r.edits.deletes;
        e.refines += r.edits.refines;
        e.commits += r.edits.commits;
        e.splits += r.edits.splits;
        e.absorbs += r.edits.absorbs;
        self.pending |= r.pending;
        let tile = &mut self.tiles[ti];
        tile.fresh += r.fresh;
        for (ev, i, frame, p) in r.proj {
            let slots = if ev {
                &mut tile.events
            } else {
                &mut tile.randoms
            };
            if let Some(s) = slots.get_mut(i as usize) {
                if s.frame == frame && s.proj.is_none() {
                    s.proj = Some(p);
                }
            }
        }
        self.work += r.work;
        Ok(())
    }

    /// The owner's share of a step when visits run elsewhere: the trimming
    /// decisions, and a new library when edits are due to be published.
    pub fn housekeep(&mut self) -> Result<Option<std::sync::Arc<Library>>, TraceError> {
        self.prune();
        if self.pending && self.frames >= self.last_commit + self.cfg.commit_interval_frames {
            return self.publish().map(Some);
        }
        Ok(None)
    }

    /// `step(budget)` with every visit run as a job by `runner` (through
    /// the byte encoding) and applied at once: the single-worker case of
    /// the parallel protocol, identical to `step`.
    pub fn step_via(
        &mut self,
        budget: u64,
        runner: &mut VisitRunner,
    ) -> Result<Option<std::sync::Arc<Library>>, TraceError> {
        self.prune();
        self.credit = self.credit.saturating_add(budget as i64);
        while self.credit > 0 {
            let Some(ti) = self.next_tile() else {
                self.credit = 0;
                break;
            };
            let job = self.make_job(ti, false);
            let bytes = job.encode(&self.tiles[ti], &self.shared);
            let job = VisitJob::from_bytes(&bytes)?;
            let res = runner.run(job)?;
            // The test log is not on the wire; this in-process round trip
            // keeps it.
            #[cfg(feature = "diagnostics")]
            let tests = res.tests.clone();
            #[allow(unused_mut)]
            let mut res = VisitResult::from_bytes(&res.to_bytes())?;
            #[cfg(feature = "diagnostics")]
            {
                res.tests = tests;
            }
            let w = res.work;
            self.apply_job(res)?;
            self.credit -= w as i64;
        }
        if self.pending && self.frames >= self.last_commit + self.cfg.commit_interval_frames {
            return self.publish().map(Some);
        }
        Ok(None)
    }
}

/// Runs tile visits handed out by another [`SlowLoop`] (in another worker).
/// Built with the same arguments as that loop, and given the same noise
/// maps in the same order.
pub struct VisitRunner {
    inner: SlowLoop,
    /// Tiles whose spots the last job set (cleared before the next).
    dirty: Vec<usize>,
}

impl VisitRunner {
    pub fn new(inner: SlowLoop) -> VisitRunner {
        VisitRunner {
            inner,
            dirty: Vec::new(),
        }
    }

    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
        self.inner.set_noise(noise)
    }

    /// Run one visit; the result goes back to the loop that made the job.
    pub fn run(&mut self, job: VisitJob) -> Result<VisitResult, TraceError> {
        let s = &mut self.inner;
        let ti = job.ti;
        if ti >= s.tiles.len()
            || s.tiles[ti].core != job.tile.core
            || s.tiles[ti].rect != job.tile.rect
        {
            return Err(TraceError::Incompatible(
                "visit job from a slow loop with another tile layout".into(),
            ));
        }
        if job.noise_gen != s.noise_gen {
            return Err(TraceError::Incompatible(format!(
                "visit job made with noise map {} but this runner has {}",
                job.noise_gen, s.noise_gen
            )));
        }
        for &t in &self.dirty {
            let tile = &mut s.tiles[t];
            tile.rejected.clear();
            tile.tombs.clear();
        }
        self.dirty.clear();
        for (t, rej, tombs) in job.others {
            let Some(tile) = s.tiles.get_mut(t) else {
                return Err(TraceError::Incompatible("visit job tile index".into()));
            };
            tile.rejected = rej;
            tile.tombs = tombs;
            self.dirty.push(t);
        }
        let (core, rect) = (job.tile.core, job.tile.rect);
        s.tiles[ti] = job.tile;
        s.tiles[ti].fresh = 0;
        self.dirty.push(ti);
        s.tile_visits[ti] = job.visits;
        s.frames = job.frames;
        s.rho = job.rho;
        s.next_id = job.id_base;
        s.cells = job.cells;
        s.ledger = job.ledger.iter().map(|&id| (id, Evidence::new())).collect();
        s.lives = job.lives.iter().copied().collect::<HashMap<_, _>>();
        s.fpstats = job.fpstats.into_iter().collect::<HashMap<_, _>>();
        s.merge_rejected = job.merge_rejected;
        s.forced = job.forced;
        s.stats = SlowStats::default();
        s.edits = EditCounts::default();
        s.edit_log.clear();
        #[cfg(feature = "diagnostics")]
        s.test_log.clear();
        s.pending = false;
        s.work = 0;
        s.churn = Churn::new(s.cfg.churn, s.cfg.cell_diameter_px);
        s.journal = Some(Vec::new());
        let unprojected: Vec<(bool, usize)> = s.tiles[ti]
            .slots()
            .into_iter()
            .filter(|&w| s.tiles[ti].slot(w).proj.is_none())
            .collect();
        let out = s.visit_body(ti);
        let ops = s.journal.take().unwrap_or_default();
        out?;
        let tile = std::mem::replace(&mut s.tiles[ti], Tile::new(core, rect));
        let proj = unprojected
            .into_iter()
            .filter_map(|w| {
                let slot = tile.slot(w);
                slot.proj.clone().map(|p| (w.0, w.1 as u32, slot.frame, p))
            })
            .collect();
        let res = VisitResult {
            seq: job.seq,
            ti,
            id_base: job.id_base,
            ids_used: s.next_id - job.id_base,
            ops,
            log: std::mem::take(&mut s.edit_log),
            #[cfg(feature = "diagnostics")]
            tests: std::mem::take(&mut s.test_log),
            stats: s.stats,
            edits: s.edits,
            pending: s.pending,
            fresh: tile.fresh,
            proj,
            work: s.work,
        };
        // Drop the copies (the next job brings its own).
        s.cells.clear();
        s.fpstats.clear();
        s.ledger.clear();
        Ok(res)
    }
}
