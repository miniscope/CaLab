//! Convergence of the footprint library: how much each cell's footprint still
//! changes from one checkpoint to the next, against its own noise.
//!
//! At checkpoint `v` and for a lag of `k` checkpoints, every cell present at
//! both `v` and `v − k` gets the relative change `‖a_v − a_{v−k}‖ / ‖a_v‖`
//! (norms over the union of the two supports; a pixel missing from one
//! footprint is zero there). The scale-free `shape` change compares the unit
//! norm footprints instead, so a drift of the overall scale (absorbed by the
//! trace) does not count.
//!
//! "Changing" means the change exceeds the cell's own noise level: the
//! split-half noise of its footprint estimate (see
//! `SlowLoop::footprint_noise`). Because the estimate at `v − k` shares most
//! of its data with the estimate at `v`, the noise of their difference is
//! smaller than the noise of either, so a change above the noise level is
//! conservative evidence of real movement. Cells without a noise level are
//! left out of the shares (counted separately).

use std::collections::{HashMap, VecDeque};

/// Lags in checkpoints that [`Tracker::checkpoint`] reports.
pub const LAGS: [usize; 2] = [1, 4];

/// Age bin edges, frames since the cell was born: `[0, 1200)`, `[1200, 3000)`,
/// `[3000, 6000)`, `[6000, ∞)`.
pub const AGE_EDGES: [u64; 3] = [1200, 3000, 6000];
/// A relative change counted as "big" regardless of noise (10 % of the norm).
pub const BIG_CHANGE: f64 = 0.1;
/// Changes below this (0.1 % of the norm) are rounding of a rescaled
/// footprint, not a move: about a third of the cells show them every checkpoint.
pub const MOVED_EPS: f64 = 1e-3;
/// Number of age bins.
pub const N_BINS: usize = AGE_EDGES.len() + 1;

/// One cell at a checkpoint.
#[derive(Debug, Clone)]
pub struct CellSnap {
    pub id: u64,
    /// Support pixels (any order) and footprint values on them.
    pub pix: Vec<u32>,
    pub val: Vec<f32>,
    /// Recording frame at which the cell was born.
    pub born: u64,
    /// Split-half noise of the footprint relative to its size.
    pub noise: Option<f64>,
}

/// Summary of one `(checkpoint, lag)`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConvRow {
    pub frame: u64,
    pub k: usize,
    /// Cells present at both checkpoints.
    pub pairs: usize,
    /// Of those, cells with a noise level.
    pub with_noise: usize,
    pub median_change: f64,
    pub median_shape: f64,
    pub median_noise: f64,
    /// Share of all pairs whose footprint changed by more than [`MOVED_EPS`]
    /// (a footprint only changes when its tile is visited and an edit is
    /// published).
    pub share_moved: f64,
    /// Median change over those pairs.
    pub median_moved: f64,
    /// Share of all pairs that changed by more than [`BIG_CHANGE`].
    pub share_big: f64,
    /// Share of the cells with a noise level whose change exceeds it.
    pub share_changing: f64,
    /// Per age bin: cells with a noise level, share changing, median change.
    pub bins: [(usize, f64, f64); N_BINS],
}

/// `(‖a − b‖ / ‖a‖`, the same for the unit-norm footprints)` with `a` the
/// newer footprint. NaN when `a` is empty.
pub fn rel_change(a: &CellSnap, b: &CellSnap) -> (f64, f64) {
    let old: HashMap<u32, f64> = b
        .pix
        .iter()
        .zip(&b.val)
        .map(|(&p, &v)| (p, f64::from(v)))
        .collect();
    let na: f64 = a.val.iter().map(|&v| f64::from(v).powi(2)).sum();
    let nb: f64 = b.val.iter().map(|&v| f64::from(v).powi(2)).sum();
    let (na, nb) = (na.sqrt(), nb.sqrt());
    if !(na > 0.0) {
        return (f64::NAN, f64::NAN);
    }
    let mut seen = 0.0f64; // Σ over a's pixels of b's value squared
    let (mut d2, mut s2) = (0.0f64, 0.0f64);
    let inv_b = if nb > 0.0 { 1.0 / nb } else { 0.0 };
    for (&p, &v) in a.pix.iter().zip(&a.val) {
        let v = f64::from(v);
        let o = old.get(&p).copied().unwrap_or(0.0);
        seen += o * o;
        d2 += (v - o).powi(2);
        s2 += (v / na - o * inv_b).powi(2);
    }
    // Pixels of b outside a's support.
    let rest = (nb * nb - seen).max(0.0);
    d2 += rest;
    s2 += rest * inv_b * inv_b;
    (d2.sqrt() / na, s2.sqrt())
}

fn median(v: &mut Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Keeps the last `max(LAGS)` checkpoints.
#[derive(Debug, Default)]
pub struct Tracker {
    hist: VecDeque<HashMap<u64, CellSnap>>,
}

impl Tracker {
    pub fn new() -> Tracker {
        Tracker::default()
    }

    /// Add the library at checkpoint `frame`; returns one row per lag that
    /// has history (checkpoints must be passed in order, one per call).
    pub fn checkpoint(&mut self, frame: u64, cells: Vec<CellSnap>) -> Vec<ConvRow> {
        let now: HashMap<u64, CellSnap> = cells.into_iter().map(|c| (c.id, c)).collect();
        let mut rows = Vec::new();
        for &k in &LAGS {
            if self.hist.len() < k {
                continue;
            }
            let prev = &self.hist[self.hist.len() - k];
            rows.push(Self::row(frame, k, &now, prev));
        }
        self.hist.push_back(now);
        while self.hist.len() > *LAGS.iter().max().unwrap() {
            self.hist.pop_front();
        }
        rows
    }

    fn row(
        frame: u64,
        k: usize,
        now: &HashMap<u64, CellSnap>,
        prev: &HashMap<u64, CellSnap>,
    ) -> ConvRow {
        let (mut chg, mut shp, mut noi) = (Vec::new(), Vec::new(), Vec::new());
        let (mut pairs, mut big) = (0, 0usize);
        let mut moved: Vec<f64> = Vec::new();
        let mut bin_chg: Vec<Vec<f64>> = vec![Vec::new(); N_BINS];
        let mut bin_up = [0usize; N_BINS];
        let (mut with_noise, mut up) = (0usize, 0usize);
        let mut ids: Vec<&u64> = now.keys().collect();
        ids.sort();
        for id in ids {
            let (Some(a), Some(b)) = (now.get(id), prev.get(id)) else {
                continue;
            };
            let (c, s) = rel_change(a, b);
            if !c.is_finite() {
                continue;
            }
            pairs += 1;
            chg.push(c);
            shp.push(s);
            if c > MOVED_EPS {
                moved.push(c);
            }
            if c > BIG_CHANGE {
                big += 1;
            }
            if let Some(n) = a.noise.filter(|n| n.is_finite()) {
                let age = frame.saturating_sub(a.born);
                let bin = AGE_EDGES.iter().filter(|&&e| age >= e).count();
                with_noise += 1;
                noi.push(n);
                bin_chg[bin].push(c);
                if c > n {
                    up += 1;
                    bin_up[bin] += 1;
                }
            }
        }
        let mut bins = [(0usize, f64::NAN, f64::NAN); N_BINS];
        for (b, slot) in bins.iter_mut().enumerate() {
            let n = bin_chg[b].len();
            let share = if n > 0 {
                bin_up[b] as f64 / n as f64
            } else {
                f64::NAN
            };
            *slot = (n, share, median(&mut bin_chg[b]));
        }
        ConvRow {
            frame,
            k,
            pairs,
            with_noise,
            median_change: median(&mut chg),
            median_shape: median(&mut shp),
            median_noise: median(&mut noi),
            share_moved: if pairs > 0 {
                moved.len() as f64 / pairs as f64
            } else {
                f64::NAN
            },
            median_moved: median(&mut moved),
            share_big: if pairs > 0 {
                big as f64 / pairs as f64
            } else {
                f64::NAN
            },
            share_changing: if with_noise > 0 {
                up as f64 / with_noise as f64
            } else {
                f64::NAN
            },
            bins,
        }
    }
}

/// Header of `convergence.tsv`.
pub fn header() -> String {
    let mut h = String::from(
        "frame\tk\tpairs\twith_noise\tmedian_change\tmedian_shape\tmedian_noise\tshare_moved\tmedian_moved\tshare_big\tshare_changing",
    );
    for b in 0..N_BINS {
        h.push_str(&format!("\tn_b{b}\tshare_b{b}\tmedian_b{b}"));
    }
    h.push('\n');
    h
}

impl ConvRow {
    pub fn to_line(&self) -> String {
        let mut s = format!(
            "{}\t{}\t{}\t{}\t{:.5}\t{:.5}\t{:.5}\t{:.4}\t{:.5}\t{:.4}\t{:.4}",
            self.frame,
            self.k,
            self.pairs,
            self.with_noise,
            self.median_change,
            self.median_shape,
            self.median_noise,
            self.share_moved,
            self.median_moved,
            self.share_big,
            self.share_changing
        );
        for &(n, share, med) in &self.bins {
            s.push_str(&format!("\t{n}\t{share:.4}\t{med:.5}"));
        }
        s.push('\n');
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(id: u64, pix: &[u32], val: &[f32], born: u64, noise: Option<f64>) -> CellSnap {
        CellSnap {
            id,
            pix: pix.to_vec(),
            val: val.to_vec(),
            born,
            noise,
        }
    }

    #[test]
    fn identical_footprints_do_not_change() {
        let a = snap(1, &[0, 1, 2], &[1.0, 2.0, 1.0], 0, None);
        let (c, s) = rel_change(&a, &a);
        assert!(c.abs() < 1e-6 && s.abs() < 1e-6);
    }

    #[test]
    fn change_is_relative_to_the_newer_footprint_and_counts_missing_pixels() {
        let new = snap(1, &[0, 1], &[3.0, 4.0], 0, None); // norm 5
        let old = snap(1, &[0, 2], &[3.0, 12.0], 0, None);
        // diff: pixel 1: 4, pixel 2: -12 -> sqrt(16 + 144) / 5
        let (c, _) = rel_change(&new, &old);
        assert!((c - 160f64.sqrt() / 5.0).abs() < 1e-9, "{c}");
    }

    #[test]
    fn shape_change_ignores_scale() {
        let a = snap(1, &[0, 1], &[2.0, 4.0], 0, None);
        let b = snap(1, &[0, 1], &[1.0, 2.0], 0, None);
        let (c, s) = rel_change(&a, &b);
        assert!((c - 0.5).abs() < 1e-9);
        assert!(s.abs() < 1e-6);
    }

    #[test]
    fn tracker_reports_lags_shares_and_age_bins() {
        let mut t = Tracker::new();
        let lib = |shift: f32| {
            vec![
                // old cell, noise 0.05, changes by `shift`
                snap(1, &[0, 1], &[1.0, 1.0 + shift], 0, Some(0.05)),
                // young cell, noise 0.5, same change: below its noise
                snap(2, &[2, 3], &[1.0, 1.0 + shift], 9000, Some(0.5)),
                // cell without noise level
                snap(3, &[4], &[1.0], 0, None),
            ]
        };
        assert!(t.checkpoint(300, lib(0.0)).is_empty());
        let rows = t.checkpoint(600, lib(0.5));
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r.k, r.pairs, r.with_noise), (1, 3, 2));
        assert!((r.share_changing - 0.5).abs() < 1e-12);
        // Cell 3 did not move; cells 1 and 2 changed by 0.5 / sqrt(2) ... > 0.1.
        assert!((r.share_moved - 2.0 / 3.0).abs() < 1e-12);
        assert!((r.share_big - 2.0 / 3.0).abs() < 1e-12);
        assert!(r.median_moved > 0.1);
        // Both cells are younger than 1200 frames here (cell 2 born later).
        assert_eq!(r.bins[0].0, 2);
        assert!((r.bins[0].1 - 0.5).abs() < 1e-12);
        let rows = t.checkpoint(9300, lib(0.5));
        let r = rows.iter().find(|r| r.k == 1).unwrap();
        assert_eq!(r.bins[3].0, 1); // cell 1, age 9300
        assert_eq!(r.bins[0].0, 1); // cell 2, age 300
        assert_eq!(r.bins[3].1, 0.0); // unchanged at this lag
        assert!(rows.iter().all(|r| r.k != 4));
        t.checkpoint(9600, lib(0.5));
        let rows = t.checkpoint(9900, lib(0.5));
        assert!(rows.iter().any(|r| r.k == 4));
    }
}
