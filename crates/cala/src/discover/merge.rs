//! Merge tests: a pair against one cell fitted to both.

use super::ledger::Evidence;
use super::local::{rank1, Cell, Fit, Problem, Rect};
use super::math::{corr, overlap};
#[cfg(feature = "diagnostics")]
use super::mergelog;
use super::shard::Op;
use super::solve::{Frames, Start};
use super::{EditKind, MergeRule, SlowLoop};

impl SlowLoop {
    /// The pair `(i, j)` of `base` refitted on the union `dom` of their
    /// supports: alternating rank-1 fits of each cell to `data` (the
    /// residual plus both cells' fitted signal on the fit frames), the
    /// other's signal removed, then both solved on `test_fr`. `fits` is
    /// `None` unless the refit stays two cells: the weaker part carries
    /// `merge_refit_min_share` of the stronger one's energy and both
    /// make a cell.
    #[allow(clippy::too_many_arguments)]
    fn refit_pair(
        &mut self,
        ti: usize,
        rect: Rect,
        base: &Problem,
        fits: &[Fit],
        data: &[Vec<f32>],
        dom: &[u32],
        (i, j): (usize, usize),
        test_fr: &Frames,
        want_ovl: bool,
        start: Option<&Start>,
    ) -> RefitPair {
        let mut ca: Vec<f32> = fits.iter().map(|f| f.c[i]).collect();
        let mut cb: Vec<f32> = fits.iter().map(|f| f.c[j]).collect();
        let mut other: Vec<Vec<f32>> = data
            .iter()
            .zip(fits)
            .map(|(d, f)| {
                let mut d = d.clone();
                base.cols[j].add_to(&mut d, -f.c[j]);
                d
            })
            .collect();
        let refs: Vec<&[f32]> = other.iter().map(|r| r.as_slice()).collect();
        let ha = rank1(&refs, dom, &mut ca, 5, false);
        for ((o, d), &ct) in other.iter_mut().zip(data).zip(&ca) {
            o.copy_from_slice(d);
            for (&p, &v) in dom.iter().zip(&ha) {
                o[p as usize] -= v * ct;
            }
        }
        let refs: Vec<&[f32]> = other.iter().map(|r| r.as_slice()).collect();
        let hb = rank1(&refs, dom, &mut cb, 5, false);
        self.work += (2 * dom.len() * data.len() * 30) as u64;
        let energy = |h: &[f32], c: &[f32]| {
            h.iter().map(|v| v * v).sum::<f32>() * c.iter().map(|v| v * v).sum::<f32>()
        };
        let (ea, eb) = (energy(&ha, &ca), energy(&hb, &cb));
        let share = ea.min(eb) / ea.max(eb);
        let two = ea.min(eb) >= self.cfg.merge_refit_min_share * ea.max(eb);
        let (idi, idj) = (base.cols[i].id, base.cols[j].id);
        let mut out = RefitPair {
            share,
            two,
            ha,
            hb,
            cells: None,
            fits: None,
            ovl: f32::NAN,
        };
        if let (Some(na), Some(nb)) = (
            self.make_cell(idi, rect, dom, &out.ha, None),
            self.make_cell(idj, rect, dom, &out.hb, None),
        ) {
            if two || want_ovl {
                let cols = self.columns(rect, &[idi, idj], &[&na, &nb]);
                let rp = self.problem(ti, cols);
                let (ka, kb) = (
                    rp.cols.iter().position(|c| c.id == idi),
                    rp.cols.iter().position(|c| c.id == idj),
                );
                if let (Some(ka), Some(kb)) = (ka, kb) {
                    out.ovl = overlap(&rp.cols[ka], &rp.cols[kb], rect.len());
                }
                if two {
                    out.fits = Some(self.solve_all_from(&rp, test_fr, start));
                }
            }
            out.cells = Some((na, nb));
        }
        out
    }

    pub(super) fn merge(&mut self, ti: usize, fit_fr: &Frames, test_fr: &Frames) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        let now = self.frames;
        self.merge_rejected.retain(|r| r.2 > now);
        for _ in 0..4 {
            let cols = self.columns(rect, &[], &[]);
            if cols.len() < 2 {
                return;
            }
            let base = self.problem(ti, cols);
            let fits = self.solve_all(&base, fit_fr);
            let n = base.len();
            let ids: Vec<u64> = base.cols.iter().map(|c| c.id).collect();
            let cell_of =
                |cells: &[Cell], id: u64| cells.iter().position(|c| c.id == id).expect("cell");
            // Best-correlated overlapping pair with the first cell in the core.
            let mut best: Option<(usize, usize, f32)> = None;
            for i in 0..n {
                let ci = &self.cells[cell_of(&self.cells, ids[i])];
                let (iy, ix) = (ci.center.0 as usize, ci.center.1 as usize);
                if core.local(iy, ix).is_none() {
                    continue;
                }
                for j in 0..n {
                    if j == i {
                        continue;
                    }
                    let cj = &self.cells[cell_of(&self.cells, ids[j])];
                    let dist = ((ci.center.0 - cj.center.0).powi(2)
                        + (ci.center.1 - cj.center.1).powi(2))
                    .sqrt();
                    if dist >= ci.radius + cj.radius {
                        continue;
                    }
                    // A pair kept apart recently is not re-tested until its
                    // cooldown ends (otherwise it would block every other
                    // pair of the tile).
                    let (lo, hi) = (ids[i].min(ids[j]), ids[i].max(ids[j]));
                    if self.merge_rejected.iter().any(|r| r.0 == lo && r.1 == hi) {
                        continue;
                    }
                    let a: Vec<f32> = fits.iter().map(|f| f.c[i]).collect();
                    let b: Vec<f32> = fits.iter().map(|f| f.c[j]).collect();
                    // Pairs the keep tests found redundant go first, then
                    // pairs whose footprints largely coincide (a duplicate
                    // takes no signal in an exact fit, so its trace does
                    // not correlate), then correlated pairs.
                    let r = if self.forced.contains(&(lo, hi)) {
                        2.0
                    } else if overlap(&base.cols[i], &base.cols[j], rect.len()) >= 0.5 {
                        1.5
                    } else {
                        corr(&a, &b)
                    };
                    if r >= self.cfg.merge_corr && best.is_none_or(|bb| r > bb.2) {
                        best = Some((i, j, r));
                    }
                }
            }
            let Some((i, j, _)) = best else { return };
            self.stats.merge_tests += 1;
            let resid = self.residuals(&base, fit_fr, &fits, ti);
            let (ci, cj) = (cell_of(&self.cells, ids[i]), cell_of(&self.cells, ids[j]));
            // Data: residual plus both cells' fitted signal.
            let data: Vec<Vec<f32>> = resid
                .iter()
                .zip(&fits)
                .map(|(r, f)| {
                    let mut d = r.clone();
                    for k in [i, j] {
                        base.cols[k].add_to(&mut d, f.c[k]);
                    }
                    d
                })
                .collect();
            let mut dom: Vec<u32> = base.cols[i].pix.clone();
            dom.extend(&base.cols[j].pix);
            dom.sort_unstable();
            dom.dedup();
            let mut c: Vec<f32> = fits.iter().map(|f| f.c[i] + f.c[j]).collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let h = rank1(&refs, &dom, &mut c, 10, false);
            self.work += (dom.len() * data.len() * 40) as u64;
            let keep = self.cells[ci].id.min(self.cells[cj].id);
            let pair = (ids[i].min(ids[j]), ids[i].max(ids[j]));
            let cooldown = now + 4 * self.cfg.reject_cooldown_frames;
            let was_forced = self.forced.contains(&pair);
            self.forced.retain(|&p| p != pair);
            journal!(self, Op::ForcedRemove(pair.0, pair.1));
            // Alternatives to keeping the pair, on held-out frames: one cell
            // fitted to both (rank 1 on the union of the supports), or either
            // cell alone with its footprint unchanged (the other being a
            // duplicate or a fragment of it). The best one is taken unless
            // keeping both beats it by the add margin.
            let (sep, start) = self.reference_all(&base, test_fr);
            let mut chi_sep = Self::total_chi2(&sep);
            #[cfg(feature = "diagnostics")]
            let mut frames_log = mergelog::Frames {
                pair: sep.iter().map(|f| f.chi2).collect(),
                pair_c: [i, j].map(|k| {
                    (
                        base.cols[k].id,
                        sep.iter().map(|f| f.c[k]).collect(),
                        1.0 / f64::from(base.coord_sigma(k)).powi(2),
                    )
                }),
                rho: f64::from(self.rho),
                ..Default::default()
            };
            let ovl = overlap(&base.cols[i], &base.cols[j], rect.len());
            // The merged arm is a fresh fit, so the pair is refitted on the
            // same frames too (alternating rank-1 fits of each cell on the
            // union support, the other's signal removed) and the better of
            // the current and the refitted pair is the baseline: otherwise
            // footprints that lag the data lose to any fresh footprint and
            // distinct cells are merged. The refitted pair counts only while
            // it stays two cells: supports that do not largely coincide, and
            // the weaker part carrying `merge_refit_min_share` of the
            // stronger one's energy. A duplicate or a fragment refits into
            // the whole cell plus a weak leftover that only soaks up
            // footprint mismatch (on the minisim recording with motion,
            // letting that leftover count kept 4 in 5 pairs on one GT unit
            // apart); then the current pair is the baseline.
            if self.cfg.merge_refit_pair && ovl < self.cfg.merge_refit_max_ovl {
                let rp = self.refit_pair(
                    ti,
                    rect,
                    &base,
                    &fits,
                    &data,
                    &dom,
                    (i, j),
                    test_fr,
                    false,
                    start.as_ref(),
                );
                if let Some(rf) = &rp.fits {
                    chi_sep = chi_sep.min(Self::total_chi2(rf));
                    #[cfg(feature = "diagnostics")]
                    {
                        frames_log.refit = Some(rf.iter().map(|f| f.chi2).collect());
                    }
                }
            }
            // DIAG: the refitted pair also where the rule skips it (the work
            // counter is restored, so the trajectory does not depend on it).
            #[cfg(feature = "diagnostics")]
            if mergelog::on() {
                let w0 = self.work;
                let rp = self.refit_pair(
                    ti,
                    rect,
                    &base,
                    &fits,
                    &data,
                    &dom,
                    (i, j),
                    test_fr,
                    true,
                    start.as_ref(),
                );
                self.work = w0;
                frames_log.refit_diag = Some(rp.diag());
            }
            let mut best_arm: Option<(f64, Option<Cell>, usize, usize)> = None;
            if let Some(m) = self.make_cell(keep, rect, &dom, &h, None) {
                let cols = self.columns(rect, &[ids[i], ids[j]], &[&m]);
                let mp = self.problem(ti, cols);
                let mf = self.solve_all_from(&mp, test_fr, start.as_ref());
                let loss = Self::total_chi2(&mf) - chi_sep;
                #[cfg(feature = "diagnostics")]
                {
                    frames_log.merged = Some(mf.iter().map(|f| f.chi2).collect());
                }
                let (stay, go) = if self.cells[ci].id == keep {
                    (ci, cj)
                } else {
                    (cj, ci)
                };
                best_arm = Some((loss, Some(m), stay, go));
            }
            for (stay, go) in [(ci, cj), (cj, ci)] {
                let cols = self.columns(rect, &[self.cells[go].id], &[]);
                let ap = self.problem(ti, cols);
                let af = self.solve_all_from(&ap, test_fr, start.as_ref());
                let loss = Self::total_chi2(&af) - chi_sep;
                #[cfg(feature = "diagnostics")]
                if let Some(k) = ap.cols.iter().position(|c| c.id == self.cells[stay].id) {
                    frames_log.solo.push((
                        self.cells[stay].id,
                        af.iter().map(|f| f.chi2).collect(),
                        af.iter().map(|f| f.c[k]).collect(),
                        1.0 / f64::from(ap.coord_sigma(k)).powi(2),
                    ));
                }
                if best_arm.as_ref().is_none_or(|b| loss < b.0) {
                    best_arm = Some((loss, None, stay, go));
                }
            }
            let (mu, s) = self.null(test_fr.len());
            // Footprints that largely coincide and whose held-out traces
            // move together act as one cell even when the second column
            // buys a little χ² (it absorbs footprint mismatch).
            let one = ovl >= 0.5 && {
                let a: Vec<f32> = sep.iter().map(|f| f.c[i]).collect();
                let b: Vec<f32> = sep.iter().map(|f| f.c[j]).collect();
                corr(&a, &b) >= self.cfg.merge_corr
            };
            let mut accept = best_arm
                .as_ref()
                .is_some_and(|b| one || b.0 < mu + f64::from(self.cfg.merge_z) * s);
            #[cfg(feature = "diagnostics")]
            let legacy_accept = accept;
            // The split-half rule: neighbours (footprints overlapping less
            // than half) whose measured shapes differ beyond their own
            // split-half noise stay two cells, whatever the held-out test
            // says. Without split halves the held-out test decides alone.
            let apart = {
                let (a, b) = (self.cells[ci].center, self.cells[cj].center);
                ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
                    >= self.cfg.merge_guard_min_sep * self.cfg.cell_diameter_px
            };
            let gated = accept
                && self.cfg.merge_rule == MergeRule::SplitHalf
                && (ovl < self.cfg.merge_guard_max_ovl || apart);
            #[cfg(feature = "diagnostics")]
            let want_shape = gated || mergelog::on();
            #[cfg(not(feature = "diagnostics"))]
            let want_shape = gated;
            let shape_excess = if want_shape {
                self.merge_shape_excess(&self.cells[ci], &self.cells[cj])
            } else {
                None
            };
            if gated {
                let px = self.cells[ci].pix.len() + self.cells[cj].pix.len();
                self.work += (px * 40) as u64;
                if shape_excess.is_some_and(|i_hat| !(i_hat <= 0.0)) {
                    accept = false;
                }
            }
            #[cfg(feature = "diagnostics")]
            self.log_test(
                EditKind::Merge,
                pair.0,
                pair.1,
                accept,
                best_arm.as_ref().map_or(f64::NAN, |b| (mu - b.0) / s),
            );
            #[cfg(feature = "diagnostics")]
            if mergelog::on() {
                let arm = match &best_arm {
                    None => -1,
                    Some((_, Some(_), ..)) => 0,
                    Some((_, None, _, go)) if self.cells[*go].id == pair.0 => 1,
                    Some(_) => 2,
                };
                let (lo_c, hi_c) = if self.cells[ci].id == pair.0 {
                    (ci, cj)
                } else {
                    (cj, ci)
                };
                let (ca, cb) = (self.cells[lo_c].clone(), self.cells[hi_c].clone());
                mergelog::merge(
                    self,
                    &mergelog::MergeRow {
                        lo: pair.0,
                        hi: pair.1,
                        accept,
                        legacy_accept,
                        z: best_arm.as_ref().map_or(f64::NAN, |b| (mu - b.0) / s),
                        ovl,
                        one,
                        forced: was_forced,
                        arm,
                        n_test: test_fr.len(),
                        shape: shape_excess,
                        frames: frames_log,
                        null: (mu, s),
                    },
                    &ca,
                    &cb,
                );
            }
            if let (true, Some((loss, merged, stay, go))) = (accept, best_arm) {
                self.stats.merges += 1;
                self.edits.merges += 1;
                let (kept_id, gone) = (self.cells[stay].id, self.cells[go].id);
                let gone_center = self.cells[go].center;
                let gone_young =
                    self.frames.saturating_sub(self.cells[go].born) < self.cfg.probation_frames;
                let mut new = match merged {
                    Some(m) => {
                        // A new footprint: its running statistics start over.
                        self.stats_forget(kept_id);
                        journal!(self, Op::FpRemove(kept_id));
                        m
                    }
                    None => self.cells[stay].clone(),
                };
                new.born = self.cells[ci].born.min(self.cells[cj].born);
                let bbox = new.bbox.union(&self.cells[go].bbox);
                let center = new.center;
                self.log(
                    EditKind::Merge,
                    kept_id,
                    gone,
                    center,
                    ((mu - loss) / s) as f32,
                );
                {
                    let g = &self.cells[go];
                    self.churn
                        .on_merge(self.frames, kept_id, gone, g.center, &g.pix, &g.filt);
                    journal!(self, Op::ChurnMerge(kept_id, g.clone()));
                }
                // The merged cell keeps the stronger evidence record.
                if let Some(ev) = self.ledger.remove(&gone) {
                    self.ledger
                        .entry(kept_id)
                        .or_insert_with(Evidence::new)
                        .absorb(&ev);
                }
                journal!(self, Op::LedgerAbsorb(kept_id, gone));
                self.lives.remove(&gone);
                self.fpstats.remove(&gone);
                journal!(self, Op::Replace(kept_id, new.clone()));
                journal!(self, Op::Remove(gone));
                self.cells[stay] = new;
                self.cells.remove(go);
                self.pending = true;
                self.touch(bbox);
                self.tiles[ti].fresh = 0;
                // The merged cell's surroundings are not re-proposed at once;
                // a young cell merged back marks its spot (the cooldown
                // doubles each time the same residual comes back).
                self.reject(ti, center.0, center.1);
                if gone_young {
                    // The same residual added and merged back again and
                    // again: treat the spot like a deletion's.
                    self.entomb(gone_center);
                }
            } else {
                self.merge_rejected.push((pair.0, pair.1, cooldown));
                journal!(self, Op::MergeRejected(pair.0, pair.1, cooldown));
                self.stats.merge_rejects += 1;
                // Kept apart: they are two cells after all, so the probes
                // that found them redundant no longer count.
                if was_forced {
                    for id in [pair.0, pair.1] {
                        if let Some(ev) = self.ledger.get_mut(&id) {
                            ev.redundant = 0;
                            ev.partner = None;
                        }
                        journal!(self, Op::ClearRedundant(id));
                    }
                }
            }
        }
    }
}

/// Cosine similarity of two patch columns.
/// A merge test's refitted pair (see `SlowLoop::refit_pair`).
struct RefitPair {
    /// Weaker over stronger part's energy.
    share: f32,
    /// `share >= merge_refit_min_share`.
    two: bool,
    /// The two refitted footprints on the union support.
    ha: Vec<f32>,
    hb: Vec<f32>,
    /// The cells made from them (both, or none).
    cells: Option<(Cell, Cell)>,
    /// Their solve on the test frames, when `two` and both cells exist.
    fits: Option<Vec<Fit>>,
    /// Overlap of the two refitted columns (NaN without cells).
    ovl: f32,
}

#[cfg(feature = "diagnostics")]
impl RefitPair {
    fn diag(&self) -> mergelog::RefitDiag {
        let argmax = |h: &[f32]| {
            h.iter()
                .enumerate()
                .fold((0, f32::MIN), |b, (k, &v)| if v > b.1 { (k, v) } else { b })
        };
        let ((pa, ma), (pb, mb)) = (argmax(&self.ha), argmax(&self.hb));
        let cross = |h: &[f32], m: f32, p: usize| if m > 0.0 { h[p] / m } else { f32::NAN };
        mergelog::RefitDiag {
            share: self.share,
            two: self.two,
            made: self.cells.is_some(),
            ovl: self.ovl,
            // Each refitted footprint at the other's peak, over its own peak.
            cross_a: cross(&self.ha, ma, pb),
            cross_b: cross(&self.hb, mb, pa),
            centers: self
                .cells
                .as_ref()
                .map(|(a, b)| (a.center, b.center, a.radius, b.radius)),
            chi: self
                .fits
                .as_ref()
                .map(|f| f.iter().map(|x| x.chi2).collect()),
        }
    }
}
