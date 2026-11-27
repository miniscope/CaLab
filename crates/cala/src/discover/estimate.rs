//! Footprint proposals from the running statistics, and the excess tests
//! that decide whether an estimate differs from the current footprint.

use super::local::{Cell, Rect};
use super::{RefineGate, SlowLoop};
use std::collections::HashMap;

impl SlowLoop {
    /// `id`'s footprint estimated from its running statistics (pixels of
    /// the statistics disk, unwhitened filtered values), once its peak is
    /// `stats_min_snr` standard errors above zero.
    pub(super) fn stats_estimate(&self, id: u64) -> Option<(Vec<u32>, Vec<f32>)> {
        let st = self.stats_of(id)?;
        let se = st.std_err();
        let h = st.estimate()?;
        let peak = h
            .iter()
            .zip(&st.pix)
            .map(|(&v, &p)| v * self.inv_sigma[p as usize])
            .fold(0.0f32, f32::max);
        (f64::from(peak) >= f64::from(self.cfg.stats_min_snr) * se).then(|| (st.pix.clone(), h))
    }

    /// The footprint of `cell` re-estimated from its running statistics.
    /// With `changed`, only when it differs from the current one by at
    /// least `refine_min_change` (sine of the angle between the whitened
    /// filtered columns).
    pub(super) fn stats_proposal(&mut self, cell: &Cell, changed: bool) -> Option<Cell> {
        let (pix, h) = self.stats_estimate(cell.id)?;
        // Under the split-half gate (with halves) `Î > 0` alone decides;
        // otherwise the χ² disagreement and the minimum change.
        let excess = match self.cfg.refine_gate {
            RefineGate::SplitHalf if changed => self.split_half_excess(cell, &pix, &h),
            _ => None,
        };
        let legacy = changed && excess.is_none();
        if excess.is_some_and(|i_hat| !(i_hat > 0.0)) {
            return None;
        }
        if legacy && !self.stats_disagree(cell, &pix, &h) {
            return None;
        }
        let se = self.fpstats.get(&cell.id).map(|st| st.std_err());
        let halves = self.stats_of(cell.id).and_then(|st| {
            let (ha, hb, sa, sb) = st.halves()?;
            Some((st.pix.clone(), ha, hb, sa, sb))
        });
        if halves.is_none() {
            // No measured standard error: no proposal, the cell keeps its
            // footprint.
            self.stats.support_no_se += 1;
            return None;
        }
        self.support_tmp = halves;
        let new = self.make_cell_global(cell.id, &pix, &h, Some(cell), se);
        self.support_tmp = None;
        let mut new = new?;
        new.born = cell.born;
        if legacy && self.change(cell, &new) < self.cfg.refine_min_change {
            return None;
        }
        Some(new)
    }

    /// How far the statistics' estimate `h` (on `pix`) is from the cell's
    /// current filtered footprint beyond the estimate's own split-half
    /// noise: `Î = D² − ½‖h_A − h_B‖²`, whitened, with the estimate and its
    /// halves divided by their least-squares scale `a` on the current
    /// column (so both terms are in the current column's units). `None`
    /// without split halves; `+∞` when the estimate does not project
    /// positively on the current column (any change is then real).
    fn split_half_excess(&self, cell: &Cell, pix: &[u32], h: &[f32]) -> Option<f64> {
        let st = self.stats_of(cell.id)?;
        let (ha, hb, _, _) = st.halves()?;
        Some(self.half_excess(cell, pix, h, &ha, &hb))
    }

    /// [`Self::split_half_excess`] of an estimate `h` with split halves
    /// `ha`, `hb` (all on `pix`).
    pub(super) fn half_excess(
        &self,
        cell: &Cell,
        pix: &[u32],
        h: &[f32],
        ha: &[f32],
        hb: &[f32],
    ) -> f64 {
        self.excess_over(cell, pix, h, Some((ha, hb)), 0.0)
    }

    /// [`Self::half_excess`] with the split-half term replaced by its
    /// expectation for a per-pixel fit whose halves have standard errors
    /// (per unit pixel noise) with `var_ab = s_A² + s_B²`: `½ n var_ab / a²`.
    pub(super) fn noise_excess(&self, cell: &Cell, pix: &[u32], h: &[f32], var_ab: f64) -> f64 {
        self.excess_over(cell, pix, h, None, var_ab)
    }

    fn excess_over(
        &self,
        cell: &Cell,
        pix: &[u32],
        h: &[f32],
        halves: Option<(&[f32], &[f32])>,
        var_ab: f64,
    ) -> f64 {
        let block = self.filter.moat().map_or(0, |m| m.0);
        let w = self.dims.width;
        let cur: Vec<f64> = pix
            .iter()
            .map(|&g| f64::from(cell.column_at(g, w, block)))
            .collect();
        let is: Vec<f64> = pix
            .iter()
            .map(|&p| f64::from(self.inv_sigma[p as usize]))
            .collect();
        split_excess(h, &cur, &is, halves, var_ab)
    }

    /// The split-half merge statistic of a pair (see [`MergeRule::SplitHalf`]):
    /// on the union of the two supports inside both statistics disks, the
    /// larger over the two directions of `‖h_X − a h_Y‖² − ½‖h_X,A −
    /// h_X,B‖² − a² ½‖h_Y,A − h_Y,B‖²` (whitened, `a` the least-squares
    /// scale of `h_Y` onto `h_X`): positive when the shapes differ by more
    /// than two re-draws of the estimates would. `None` when either cell
    /// has no split halves; `+∞` when the disks share too few support
    /// pixels to compare (no evidence that the shapes agree).
    pub(super) fn merge_shape_excess(&self, a: &Cell, b: &Cell) -> Option<f64> {
        let (sa, sb) = (self.stats_of(a.id)?, self.stats_of(b.id)?);
        let (ha, (ha1, ha2, _, _)) = (sa.estimate()?, sa.halves()?);
        let (hb, (hb1, hb2, _, _)) = (sb.estimate()?, sb.halves()?);
        let at: HashMap<u32, usize> = sa.pix.iter().enumerate().map(|(k, &p)| (p, k)).collect();
        let on_support =
            |p: u32| a.pix.binary_search(&p).is_ok() || b.pix.binary_search(&p).is_ok();
        // Whitened values on the compared pixels: (x, x_A − x_B, y, y_A − y_B).
        let v: Vec<[f64; 4]> = sb
            .pix
            .iter()
            .enumerate()
            .filter(|&(_, &p)| on_support(p))
            .filter_map(|(kb, &p)| {
                let ka = *at.get(&p)?;
                let is = f64::from(self.inv_sigma[p as usize]);
                Some([
                    f64::from(ha[ka]) * is,
                    f64::from(ha1[ka] - ha2[ka]) * is,
                    f64::from(hb[kb]) * is,
                    f64::from(hb1[kb] - hb2[kb]) * is,
                ])
            })
            .collect();
        if v.len() < 5 {
            return Some(f64::INFINITY);
        }
        let excess = |x: usize, y: usize| {
            let (xy, yy) = v
                .iter()
                .fold((0.0, 0.0), |(s, t), r| (s + r[x] * r[y], t + r[y] * r[y]));
            let s = if yy > 0.0 { xy / yy } else { 0.0 };
            v.iter().fold(0.0, |acc, r| {
                let d = r[x] - s * r[y];
                acc + d * d - 0.5 * r[x + 1] * r[x + 1] - 0.5 * s * s * r[y + 1] * r[y + 1]
            })
        };
        Some(excess(0, 2).max(excess(2, 0)))
    }

    /// Whether the statistics' estimate `h` (on `pix`) differs from the
    /// cell's current filtered footprint by more than its own noise: the
    /// whitened squared difference (current footprint scaled to fit, zero
    /// off its support) in units of the estimate's standard error, against
    /// its χ² null (`n + 3 sqrt(2 n)` on `n` pixels). As frames accumulate
    /// the standard error shrinks, so a real mismatch is found ever more
    /// surely while a converged footprint stops being proposed.
    fn stats_disagree(&self, cell: &Cell, pix: &[u32], h: &[f32]) -> bool {
        let Some(st) = self.fpstats.get(&cell.id) else {
            return false;
        };
        let se = st.std_err();
        if !(se > 0.0) || !se.is_finite() {
            return false;
        }
        let block = self.filter.moat().map_or(0, |m| m.0);
        let cur: Vec<f32> = pix
            .iter()
            .map(|&g| cell.column_at(g, self.dims.width, block))
            .collect();
        let (mut hc, mut cc) = (0.0f64, 0.0f64);
        for (k, &p) in pix.iter().enumerate() {
            let is = f64::from(self.inv_sigma[p as usize]);
            hc += f64::from(h[k]) * f64::from(cur[k]) * is * is;
            cc += f64::from(cur[k]) * f64::from(cur[k]) * is * is;
        }
        let a = if cc > 0.0 { hc / cc } else { 0.0 };
        let mut chi = 0.0f64;
        for (k, &p) in pix.iter().enumerate() {
            let is = f64::from(self.inv_sigma[p as usize]);
            let d = (f64::from(h[k]) - a * f64::from(cur[k])) * is / se;
            chi += d * d;
        }
        let n = pix.len() as f64;
        chi > n + 3.0 * (2.0 * n).sqrt()
    }

    /// Sine of the angle between two cells' whitened filtered columns.
    pub(super) fn change(&self, a: &Cell, b: &Cell) -> f32 {
        let mut m: HashMap<u32, f32> = HashMap::with_capacity(a.pix.len());
        let mut aa = 0.0f64;
        for (&p, &v) in a.pix.iter().zip(&a.filt) {
            let u = v * self.inv_sigma[p as usize];
            aa += f64::from(u * u);
            m.insert(p, u);
        }
        let (mut ab, mut bb) = (0.0f64, 0.0f64);
        for (&p, &v) in b.pix.iter().zip(&b.filt) {
            let w = f64::from(v * self.inv_sigma[p as usize]);
            bb += w * w;
            if let Some(&u) = m.get(&p) {
                ab += f64::from(u) * w;
            }
        }
        if aa <= 0.0 || bb <= 0.0 {
            return 1.0;
        }
        let c = ab / (aa * bb).sqrt();
        (1.0 - c * c).max(0.0).sqrt() as f32
    }

    /// FOV pixels inside `rect`.
    pub(super) fn fov_px(&self, rect: Rect) -> usize {
        (rect.y0..rect.y0 + rect.h)
            .map(|y| {
                self.fov[y * self.dims.width + rect.x0..y * self.dims.width + rect.x0 + rect.w]
                    .iter()
                    .filter(|&&m| m != 0)
                    .count()
            })
            .sum()
    }
}

/// `Î = D² − ½‖h_A − h_B‖²` of an estimate `h` against the current column
/// `cur` (whitening `is` per pixel; see [`SlowLoop::half_excess`]), with
/// the split-half term from `halves` or, without them, its expectation
/// `½ n var_ab / a²` for halves of per-pixel standard error
/// `var_ab = s_A² + s_B²`.
pub(crate) fn split_excess(
    h: &[f32],
    cur: &[f64],
    is: &[f64],
    halves: Option<(&[f32], &[f32])>,
    var_ab: f64,
) -> f64 {
    let (mut hc, mut cc) = (0.0f64, 0.0f64);
    for k in 0..h.len() {
        hc += f64::from(h[k]) * cur[k] * is[k] * is[k];
        cc += cur[k] * cur[k] * is[k] * is[k];
    }
    if !(cc > 0.0) || !(hc > 0.0) {
        return f64::INFINITY;
    }
    let a = hc / cc;
    let (mut d2, mut half) = (0.0f64, 0.0f64);
    for k in 0..h.len() {
        let d = (f64::from(h[k]) / a - cur[k]) * is[k];
        d2 += d * d;
        half += match halves {
            Some((ha, hb)) => {
                let e = f64::from(ha[k] - hb[k]) / a * is[k];
                0.5 * e * e
            }
            None => 0.5 * var_ab / (a * a),
        };
    }
    d2 - half
}
