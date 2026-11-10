//! Byte encoding of visit jobs and results (`shard.rs`), so a visit can run
//! in another Web Worker. Little-endian, length-prefixed; the decoder checks
//! every length against the buffer and returns `None` on a short or
//! malformed buffer instead of panicking.

use super::ledger::{EditCounts, EditEvent, EditKind};
use super::local::{Cell, Rect};
use super::reservoir::{Probe, Slot, Tile};
use super::SlowStats;
use crate::discover::fpstats::FpStats;

/// Format tag at the start of every buffer (bump on any layout change).
pub(crate) const MAGIC: u32 = 0x5649_5331; // "VIS1"

#[derive(Default)]
pub(crate) struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn bool(&mut self, v: bool) {
        self.u8(u8::from(v));
    }
    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn usize(&mut self, v: usize) {
        self.u64(v as u64);
    }
    pub fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn opt_u64(&mut self, v: Option<u64>) {
        self.bool(v.is_some());
        if let Some(v) = v {
            self.u64(v);
        }
    }
    pub fn u32s(&mut self, v: &[u32]) {
        self.usize(v.len());
        for &x in v {
            self.u32(x);
        }
    }
    pub fn u64s(&mut self, v: &[u64]) {
        self.usize(v.len());
        for &x in v {
            self.u64(x);
        }
    }
    pub fn f32s(&mut self, v: &[f32]) {
        self.usize(v.len());
        for &x in v {
            self.f32(x);
        }
    }
    pub fn f64s(&mut self, v: &[f64]) {
        self.usize(v.len());
        for &x in v {
            self.f64(x);
        }
    }
    pub fn i16s(&mut self, v: &[i16]) {
        self.usize(v.len());
        let o = self.buf.len();
        self.buf.resize(o + v.len() * 2, 0);
        let (chunks, _) = self.buf[o..].as_chunks_mut::<2>();
        for (b, x) in chunks.iter_mut().zip(v) {
            *b = x.to_le_bytes();
        }
    }
    pub fn rect(&mut self, r: Rect) {
        for v in [r.y0, r.x0, r.h, r.w] {
            self.usize(v);
        }
    }
    pub fn spots(&mut self, v: &[(f32, f32, u64, u32)]) {
        self.usize(v.len());
        for &(y, x, f, k) in v {
            self.f32(y);
            self.f32(x);
            self.u64(f);
            self.u32(k);
        }
    }
    pub fn cell(&mut self, c: &Cell) {
        self.u64(c.id);
        self.f32(c.center.0);
        self.f32(c.center.1);
        self.f32(c.radius);
        self.rect(c.bbox);
        self.u32s(&c.pix);
        self.f32s(&c.raw);
        self.f32s(&c.filt);
        self.u64(c.born);
    }
    pub fn slot(&mut self, s: &Slot) {
        self.u64(s.frame);
        self.f32(s.score);
        self.bool(s.test);
        self.i16s(&s.data);
        self.proj(s.proj.as_ref());
    }
    pub fn proj(&mut self, p: Option<&(Vec<f64>, f64)>) {
        self.bool(p.is_some());
        if let Some((q, yy)) = p {
            self.f64s(q);
            self.f64(*yy);
        }
    }
    /// `t`, with the reservoir slots of `slots` (the owner's tile, so a
    /// job need not copy them first).
    pub fn tile(&mut self, t: &Tile, slots: &Tile) {
        self.rect(t.core);
        self.rect(t.rect);
        self.usize(slots.events.len());
        for s in &slots.events {
            self.slot(s);
        }
        self.usize(slots.randoms.len());
        for s in &slots.randoms {
            self.slot(s);
        }
        self.u64(t.seen);
        self.u32(t.fresh);
        self.spots(&t.rejected);
        self.spots(&t.tombs);
        self.usize(t.probes.len());
        for p in &t.probes {
            self.slot(&p.slot);
            self.u64s(&p.cells);
        }
        self.u64(t.last_visit);
    }
    pub fn fpstats(&mut self, s: &FpStats) {
        self.f32(s.center.0);
        self.f32(s.center.1);
        self.f32(s.radius);
        self.u32s(&s.pix);
        self.f32s(&s.rc);
        self.f32s(&s.r);
        for v in [s.n, s.n2, s.s1, s.s2] {
            self.f64(v);
        }
        self.u64(s.version);
        self.u32s(&s.map);
    }
    pub fn stats(&mut self, s: &SlowStats) {
        for v in stats_fields(s) {
            self.u64(v);
        }
    }
    pub fn edits(&mut self, e: &EditCounts) {
        for v in [
            e.adds, e.merges, e.deletes, e.refines, e.commits, e.splits, e.absorbs,
        ] {
            self.u64(v);
        }
    }
    pub fn event(&mut self, e: &EditEvent) {
        self.u64(e.frame);
        self.u8(kind_code(e.kind));
        self.u64(e.id);
        self.u64(e.other);
        self.f32(e.center.0);
        self.f32(e.center.1);
        self.f32(e.margin);
    }
}

pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }
    pub fn done(&self) -> bool {
        self.pos == self.buf.len()
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }
    pub fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    pub fn bool(&mut self) -> Option<bool> {
        self.u8().map(|v| v != 0)
    }
    pub fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn u64(&mut self) -> Option<u64> {
        self.take(8)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn usize(&mut self) -> Option<usize> {
        usize::try_from(self.u64()?).ok()
    }
    pub fn f32(&mut self) -> Option<f32> {
        self.take(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn f64(&mut self) -> Option<f64> {
        self.take(8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn opt_u64(&mut self) -> Option<Option<u64>> {
        Some(if self.bool()? {
            Some(self.u64()?)
        } else {
            None
        })
    }
    /// A length that `size` bytes per element can still fit.
    fn len(&mut self, size: usize) -> Option<usize> {
        let n = self.usize()?;
        (n.checked_mul(size)? <= self.buf.len() - self.pos).then_some(n)
    }
    pub fn u32s(&mut self) -> Option<Vec<u32>> {
        let n = self.len(4)?;
        (0..n).map(|_| self.u32()).collect()
    }
    pub fn u64s(&mut self) -> Option<Vec<u64>> {
        let n = self.len(8)?;
        (0..n).map(|_| self.u64()).collect()
    }
    pub fn f32s(&mut self) -> Option<Vec<f32>> {
        let n = self.len(4)?;
        (0..n).map(|_| self.f32()).collect()
    }
    pub fn f64s(&mut self) -> Option<Vec<f64>> {
        let n = self.len(8)?;
        (0..n).map(|_| self.f64()).collect()
    }
    pub fn i16s(&mut self) -> Option<Vec<i16>> {
        let n = self.len(2)?;
        let b = self.take(n * 2)?;
        Some(
            b.as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c))
                .collect(),
        )
    }
    /// A count of items at least `min` bytes each.
    pub fn count(&mut self, min: usize) -> Option<usize> {
        self.len(min)
    }
    pub fn rect(&mut self) -> Option<Rect> {
        Some(Rect {
            y0: self.usize()?,
            x0: self.usize()?,
            h: self.usize()?,
            w: self.usize()?,
        })
    }
    pub fn spots(&mut self) -> Option<Vec<(f32, f32, u64, u32)>> {
        let n = self.len(20)?;
        (0..n)
            .map(|_| Some((self.f32()?, self.f32()?, self.u64()?, self.u32()?)))
            .collect()
    }
    pub fn cell(&mut self) -> Option<Cell> {
        Some(Cell {
            id: self.u64()?,
            center: (self.f32()?, self.f32()?),
            radius: self.f32()?,
            bbox: self.rect()?,
            pix: self.u32s()?,
            raw: self.f32s()?,
            filt: self.f32s()?,
            born: self.u64()?,
        })
    }
    pub fn slot(&mut self) -> Option<Slot> {
        Some(Slot {
            frame: self.u64()?,
            score: self.f32()?,
            test: self.bool()?,
            data: self.i16s()?,
            proj: self.proj()?,
        })
    }
    pub fn proj(&mut self) -> Option<Option<(Vec<f64>, f64)>> {
        Some(if self.bool()? {
            Some((self.f64s()?, self.f64()?))
        } else {
            None
        })
    }
    pub fn tile(&mut self) -> Option<Tile> {
        let core = self.rect()?;
        let rect = self.rect()?;
        let mut t = Tile::new(core, rect);
        let n = self.count(22)?;
        t.events = (0..n).map(|_| self.slot()).collect::<Option<_>>()?;
        let n = self.count(22)?;
        t.randoms = (0..n).map(|_| self.slot()).collect::<Option<_>>()?;
        t.seen = self.u64()?;
        t.fresh = self.u32()?;
        t.rejected = self.spots()?;
        t.tombs = self.spots()?;
        let n = self.count(30)?;
        t.probes = (0..n)
            .map(|_| {
                Some(Probe {
                    slot: self.slot()?,
                    cells: self.u64s()?,
                })
            })
            .collect::<Option<_>>()?;
        t.last_visit = self.u64()?;
        Some(t)
    }
    pub fn fpstats(&mut self) -> Option<FpStats> {
        Some(FpStats {
            center: (self.f32()?, self.f32()?),
            radius: self.f32()?,
            pix: self.u32s()?,
            rc: self.f32s()?,
            r: self.f32s()?,
            n: self.f64()?,
            n2: self.f64()?,
            s1: self.f64()?,
            s2: self.f64()?,
            version: self.u64()?,
            map: self.u32s()?,
        })
    }
    pub fn stats(&mut self) -> Option<SlowStats> {
        let mut v = [0u64; N_STATS];
        for x in v.iter_mut() {
            *x = self.u64()?;
        }
        Some(stats_from(v))
    }
    pub fn edits(&mut self) -> Option<EditCounts> {
        Some(EditCounts {
            adds: self.u64()?,
            merges: self.u64()?,
            deletes: self.u64()?,
            refines: self.u64()?,
            commits: self.u64()?,
            splits: self.u64()?,
            absorbs: self.u64()?,
        })
    }
    pub fn event(&mut self) -> Option<EditEvent> {
        Some(EditEvent {
            frame: self.u64()?,
            kind: kind_from(self.u8()?)?,
            id: self.u64()?,
            other: self.u64()?,
            center: (self.f32()?, self.f32()?),
            margin: self.f32()?,
        })
    }
}

fn kind_code(k: EditKind) -> u8 {
    match k {
        EditKind::Add => 0,
        EditKind::Merge => 1,
        EditKind::Split => 2,
        EditKind::Delete => 3,
        EditKind::Refine => 4,
        EditKind::Absorb => 5,
    }
}

fn kind_from(v: u8) -> Option<EditKind> {
    Some(match v {
        0 => EditKind::Add,
        1 => EditKind::Merge,
        2 => EditKind::Split,
        3 => EditKind::Delete,
        4 => EditKind::Refine,
        5 => EditKind::Absorb,
        _ => return None,
    })
}

/// `SlowStats` as an array and back (one list, so the two never disagree).
macro_rules! stats_list {
    ($($f:ident),* $(,)?) => {
        pub(crate) const N_STATS: usize = [$(stringify!($f)),*].len();
        pub(crate) fn stats_fields(s: &SlowStats) -> [u64; N_STATS] {
            [$(s.$f),*]
        }
        pub(crate) fn stats_from(v: [u64; N_STATS]) -> SlowStats {
            let mut it = v.into_iter();
            SlowStats { $($f: it.next().unwrap_or(0)),* }
        }
    };
}

stats_list!(
    visits,
    proposals,
    adds,
    rejects,
    merges,
    merge_tests,
    refines,
    commits,
    deletes,
    pretest_rejects,
    merge_rejects,
    work_load,
    work_refine,
    work_merge,
    work_add,
    work_keep,
    keep_tests,
    keep_fails,
    keep_inconclusive,
    absorbs,
    splits,
    split_tests,
    work_split,
    work_stats,
);
