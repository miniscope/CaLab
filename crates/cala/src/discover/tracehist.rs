//! Each cell's fast-loop trace over the whole session, for the merge veto
//! (`SlowLoopConfig::merge_history_corr`).
//!
//! A merge is decided on the frames a tile's reservoir holds: a short,
//! event-biased sample. Two neighbouring cells that fired together in those
//! frames look like one cell there. Their traces over the session tell them
//! apart: fragments and duplicates of one cell follow each other all the
//! time, two cells do not.
//!
//! The traces are kept as means over [`BIN_FRAMES`] frames (4 bytes per cell
//! and bin: 1000 cells for an hour at 20 fps are 72 MB). Bins are aligned to
//! the slow loop's frame count, so two cells' histories line up whenever both
//! were in the library.

use std::collections::HashMap;

/// Frames averaged into one stored value.
pub(crate) const BIN_FRAMES: u64 = 4;
/// Two cells are compared only over at least this many common frames.
pub(crate) const MIN_FRAMES: u64 = 600;

#[derive(Debug, Clone, Default)]
struct CellHistory {
    /// Index of the first stored bin.
    start: u64,
    bins: Vec<f32>,
    /// Sum and count of the open bin (`start + bins.len()`).
    acc: f32,
    n: u32,
}

/// Binned traces by cell id.
#[derive(Debug, Clone, Default)]
pub(crate) struct TraceHistory {
    cells: HashMap<u64, CellHistory>,
}

impl TraceHistory {
    /// Add frame `frame`'s traces (`ids` and `traces` in the same order).
    /// A cell that was absent for a whole bin starts over.
    pub fn push(&mut self, frame: u64, ids: &[u64], traces: &[f32]) {
        let bin = frame / BIN_FRAMES;
        for (&id, &v) in ids.iter().zip(traces) {
            let h = self.cells.entry(id).or_insert_with(|| CellHistory {
                start: bin,
                ..CellHistory::default()
            });
            let open = h.start + h.bins.len() as u64;
            if bin == open + 1 && h.n > 0 {
                h.bins.push(h.acc / h.n as f32);
                (h.acc, h.n) = (0.0, 0);
            } else if bin != open {
                h.start = bin;
                h.bins.clear();
                (h.acc, h.n) = (0.0, 0);
            }
            h.acc += v;
            h.n += 1;
        }
    }

    /// Drop the cells `keep` rejects.
    pub fn retain(&mut self, keep: impl Fn(u64) -> bool) {
        self.cells.retain(|&id, _| keep(id));
    }

    /// Correlation of two cells' traces over the bins both have, and the
    /// frames those bins span. `None` when either is unknown or they share
    /// no bin.
    pub fn corr(&self, a: u64, b: u64) -> Option<(f32, u64)> {
        let (ha, hb) = (self.cells.get(&a)?, self.cells.get(&b)?);
        let from = ha.start.max(hb.start);
        let to = (ha.start + ha.bins.len() as u64).min(hb.start + hb.bins.len() as u64);
        if to <= from {
            return None;
        }
        let xa = &ha.bins[(from - ha.start) as usize..(to - ha.start) as usize];
        let xb = &hb.bins[(from - hb.start) as usize..(to - hb.start) as usize];
        Some((super::corr(xa, xb), (to - from) * BIN_FRAMES))
    }

    /// Whether the two cells' traces differed over the session: at least
    /// [`MIN_FRAMES`] common frames with a correlation below `below`.
    pub fn distinct(&self, a: u64, b: u64, below: f32) -> bool {
        self.corr(a, b)
            .is_some_and(|(r, frames)| frames >= MIN_FRAMES && r < below)
    }

    /// Cells with a history.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.cells.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic trace: sparse events of a few frames.
    fn events(seed: u64, t: usize) -> Vec<f32> {
        let mut s = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        let mut out = vec![0.0f32; t];
        let mut i = 0;
        while i < t {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            i += 20 + (s % 200) as usize;
            for k in 0..12 {
                if i + k < t {
                    out[i + k] += 1.0 - k as f32 / 12.0;
                }
            }
        }
        out
    }

    fn fill(h: &mut TraceHistory, from: u64, ids: &[u64], traces: &[&[f32]]) {
        for t in 0..traces[0].len() {
            let row: Vec<f32> = traces.iter().map(|x| x[t]).collect();
            h.push(from + t as u64, ids, &row);
        }
    }

    #[test]
    fn independent_cells_are_distinct_and_fragments_are_not() {
        let (a, b) = (events(1, 4000), events(2, 4000));
        let half: Vec<f32> = a.iter().map(|v| 0.5 * v).collect();
        let mut h = TraceHistory::default();
        fill(&mut h, 0, &[1, 2, 3], &[&a, &b, &half]);
        let (r, frames) = h.corr(1, 2).unwrap();
        assert!(r.abs() < 0.2, "independent traces correlate {r}");
        // The open bin is not counted.
        assert_eq!(frames, 4000 - BIN_FRAMES);
        assert!(h.distinct(1, 2, 0.3));
        assert!(h.corr(1, 3).unwrap().0 > 0.99);
        assert!(!h.distinct(1, 3, 0.3));
    }

    #[test]
    fn a_short_common_history_decides_nothing() {
        let (a, b) = (events(1, 4000), events(2, 4000));
        let mut h = TraceHistory::default();
        fill(&mut h, 0, &[1], &[&a[..3600]]);
        // Cell 2 joins 400 frames before the end.
        fill(&mut h, 3600, &[1, 2], &[&a[3600..], &b[3600..]]);
        let (_, frames) = h.corr(1, 2).unwrap();
        assert!(frames < MIN_FRAMES);
        assert!(!h.distinct(1, 2, 0.3));
        assert!(h.corr(1, 9).is_none());
    }

    #[test]
    fn a_cell_that_was_away_starts_over_and_stays_aligned() {
        let (a, b) = (events(3, 3000), events(4, 3000));
        let mut h = TraceHistory::default();
        fill(&mut h, 0, &[1, 2], &[&a[..1000], &b[..1000]]);
        // Cell 2 is out of the library for 400 frames.
        fill(&mut h, 1000, &[1], &[&a[1000..1400]]);
        fill(&mut h, 1400, &[1, 2], &[&a[1400..], &a[1400..]]);
        // Only the common stretch after the gap counts, and there cell 2
        // follows cell 1 exactly.
        let (r, frames) = h.corr(1, 2).unwrap();
        assert_eq!(frames, 1600 - BIN_FRAMES);
        assert!(r > 0.99, "{r}");
        h.retain(|id| id == 1);
        assert_eq!(h.len(), 1);
    }
}
