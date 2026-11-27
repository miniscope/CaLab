//! Split and refine: per-cell edits on a tile's solved model.

#[cfg(feature = "diagnostics")]
use super::diagnostics;
use super::local::{rank1, rank2_split, Rect};
use super::math::{clip, corr, paired_z};
use super::shard::Op;
use super::solve::{Frames, Solved};
use super::{EditKind, SlowLoop};

impl SlowLoop {
    /// Split tests: is one of the tile's cells better explained as two
    /// cells with distinct traces? On the fitting frames where the cell is
    /// active, its signal plus the residual on its support is factorised at
    /// rank 2 (non-negative traces), started from the footprint cut in two
    /// across its long axis. When the two parts look distinct there (traces
    /// below `merge_corr`, each with a fifth of the energy, a clear drop in
    /// squared error), both are made cells and tested on held-out frames
    /// like an add: the pair must beat the single cell by the add margin,
    /// and each part needs its own held-out events with traces that do not
    /// move together (or the merge test would undo it). At most one split
    /// per visit. Returns whether the tile's cells changed.
    pub(super) fn split(&mut self, ti: usize, solved: &Solved, test_fr: &Frames) -> bool {
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let Solved { base, fits, resid } = solved;
        let d = self.cfg.cell_diameter_px;
        for i in 0..base.len() {
            let id = base.cols[i].id;
            let Some(ci) = self.cells.iter().position(|c| c.id == id) else {
                continue;
            };
            let cell = self.cells[ci].clone();
            if core
                .local(cell.center.0 as usize, cell.center.1 as usize)
                .is_none()
            {
                continue;
            }
            let sig = self.coord_noise(base, i);
            let active: Vec<usize> = (0..fits.len())
                .filter(|&t| fits[t].c[i] >= 2.0 * sig)
                .collect();
            if active.len() < 8 {
                continue;
            }
            let col = &base.cols[i];
            let np = col.pix.len();
            // The column on its support, moat included.
            let cv = col.on_support();
            let data: Vec<Vec<f32>> = active
                .iter()
                .map(|&t| {
                    col.pix
                        .iter()
                        .zip(&cv)
                        .map(|(&p, &v)| resid[t][p as usize] + v * fits[t].c[i])
                        .collect()
                })
                .collect();
            self.stats.split_tests += 1;
            self.work += (np * active.len() * 60) as u64;
            let Some((ha, hb, h1)) = rank2_split(&data, &cv, &col.pix, rect.w, self.cfg.merge_corr)
            else {
                continue;
            };
            let new_id = self.next_id;
            let Some(mut a) = self.make_cell(id, rect, &col.pix, &ha, None) else {
                continue;
            };
            let Some(mut b) = self.make_cell(new_id, rect, &col.pix, &hb, None) else {
                continue;
            };
            let sep =
                ((a.center.0 - b.center.0).powi(2) + (a.center.1 - b.center.1).powi(2)).sqrt();
            if sep < 0.3 * d {
                continue;
            }
            a.born = cell.born;
            b.born = self.frames;
            // Held-out test, free bump at the cell in both arms.
            let (bg, proj) = self.with_bump(ti, cell.center, &test_fr.y, &test_fr.proj);
            let mut work = 0;
            let one = self.new_problem(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
            let two = self.new_problem(
                self.columns(rect, &[id], &[&a, &b]),
                &bg,
                rect.len(),
                &mut work,
            );
            self.work += work + (rect.len() * (test_fr.len() + 2 * bg.k)) as u64;
            let (f1, start) = self.reference(&one, test_fr, &proj);
            let f2 = self.solve_frames_from(&two, test_fr, &proj, start.as_ref());
            let n_px = self.fov_px(rect) as f64;
            let dof = (test_fr.len() as f64 * (n_px - (bg.k + one.len()) as f64)).max(1.0);
            let chi1 = Self::total_chi2(&f1);
            let s2 = (chi1 / dof).max(1.0);
            let gain = (chi1 - Self::total_chi2(&f2)) / s2;
            let (m, sd) = self.null(test_fr.len());
            if gain <= m + f64::from(self.cfg.accept_z) * sd {
                #[cfg(feature = "diagnostics")]
                self.log_test(EditKind::Split, id, 0, false, (gain - m) / sd);
                continue;
            }
            // Two columns also fit an imperfect single footprint better
            // than one does: the pair must beat the best single-cell
            // re-estimate (rank 1 on the same frames, or the running
            // statistics) by the add margin too.
            let mut singles = Vec::new();
            if let Some(mut c1) = self.make_cell(id, rect, &col.pix, &h1, None) {
                c1.born = cell.born;
                singles.push(c1);
            }
            if let Some(c1) = self.stats_proposal(&cell, false) {
                singles.push(c1);
            }
            let mut best_single = 0.0f64;
            for c1 in &singles {
                let mut work = 0;
                let pr =
                    self.new_problem(self.columns(rect, &[id], &[c1]), &bg, rect.len(), &mut work);
                self.work += work;
                let f = self.solve_frames_from(&pr, test_fr, &proj, start.as_ref());
                best_single = best_single.max((chi1 - Self::total_chi2(&f)) / s2);
            }
            if gain - best_single <= m + f64::from(self.cfg.accept_z) * sd {
                #[cfg(feature = "diagnostics")]
                self.log_test(EditKind::Split, id, 0, false, (gain - m) / sd);
                continue;
            }
            let (ka, kb) = (two.len() - 2, two.len() - 1);
            let ta: Vec<f32> = f2.iter().map(|f| f.c[ka]).collect();
            let tb: Vec<f32> = f2.iter().map(|f| f.c[kb]).collect();
            if corr(&ta, &tb) >= self.cfg.merge_corr {
                #[cfg(feature = "diagnostics")]
                self.log_test(EditKind::Split, id, 0, false, (gain - m) / sd);
                continue;
            }
            let events = |t: &[f32], k: usize| {
                let mut s: Vec<f32> = t.to_vec();
                s.sort_by(f32::total_cmp);
                let lvl = s[s.len() / 2];
                let sig = self.coord_noise(&two, k) * s2.sqrt() as f32;
                t.iter()
                    .filter(|&&v| v - lvl >= self.cfg.event_z * sig)
                    .count() as u32
            };
            if events(&ta, ka) < self.cfg.min_events || events(&tb, kb) < self.cfg.min_events {
                #[cfg(feature = "diagnostics")]
                self.log_test(EditKind::Split, id, 0, false, (gain - m) / sd);
                continue;
            }
            // Each part is a cell by the add test's rules: its held-out
            // trace must not follow a neighbour's (then it is that
            // neighbour's light, for refinement to give back).
            // Neighbours whose supports touch the part's.
            let follows = |t: &[f32], c: (f32, f32), r: f32| {
                (0..two.len() - 2).any(|j| {
                    self.cells
                        .iter()
                        .find(|x| x.id == two.cols[j].id)
                        .is_some_and(|cj| {
                            (cj.center.0 - c.0).powi(2) + (cj.center.1 - c.1).powi(2)
                                <= (cj.radius + r).powi(2)
                                && corr(t, &f2.iter().map(|f| f.c[j]).collect::<Vec<_>>())
                                    >= self.cfg.merge_corr
                        })
                })
            };
            if follows(&ta, a.center, a.radius) || follows(&tb, b.center, b.radius) {
                #[cfg(feature = "diagnostics")]
                self.log_test(EditKind::Split, id, 0, false, (gain - m) / sd);
                continue;
            }
            // Accepted.
            #[cfg(feature = "diagnostics")]
            self.log_test(EditKind::Split, id, new_id, true, (gain - m) / sd);
            self.next_id += 1;
            self.stats.splits += 1;
            self.edits.splits += 1;
            self.log(
                EditKind::Split,
                id,
                new_id,
                a.center,
                ((gain - m) / sd) as f32,
            );
            self.churn.on_split(self.frames, new_id);
            self.stats_forget(id);
            journal!(self, Op::ChurnSplit(new_id));
            journal!(self, Op::FpRemove(id));
            journal!(self, Op::Replace(id, a.clone()));
            journal!(self, Op::Push(b.clone()));
            let bbox = a.bbox.union(&b.bbox).union(&cell.bbox);
            self.cells[ci] = a;
            self.cells.push(b);
            // The merge test does not undo it for a long cooldown.
            let until = self.frames + 16 * self.cfg.reject_cooldown_frames;
            self.merge_rejected
                .push((id.min(new_id), id.max(new_id), until));
            journal!(
                self,
                Op::MergeRejected(id.min(new_id), id.max(new_id), until)
            );
            self.pending = true;
            self.touch(bbox);
            self.tiles[ti].fresh = 0;
            return true;
        }
        false
    }

    /// The tile's current model solved on its fitting frames.
    pub(super) fn solve_tile(&mut self, ti: usize, fit_fr: &Frames) -> Solved {
        let rect = self.tiles[ti].rect;
        let cols = self.columns(rect, &[], &[]);
        let base = self.problem(ti, cols);
        let fits = self.solve_all(&base, fit_fr);
        let resid = self.residuals(&base, fit_fr, &fits, ti);
        Solved { base, fits, resid }
    }

    /// Refinement of the tile's cells. A cell whose running statistics are
    /// precise enough is re-estimated from them (all fitting frames so
    /// far); otherwise from the reservoir's fitting frames where it is
    /// active. The new footprint is kept when it lowers held-out χ² with a
    /// paired z above `refine_z` (statistics path, 0 by default) or
    /// `absorb_z` (reservoir path). Converged footprints (the
    /// statistics' estimate within `refine_min_change` of the current one)
    /// are not proposed. (Under the split-half gate with `refine_z` 0,
    /// refinements do not die out in count: later passes keep accepting
    /// many small ones on a dense recording, each pass moving footprints
    /// less: `tools/cala-eval/results/2026-11-17-refine-gate-refill.md`.)
    pub(super) fn refine(&mut self, ti: usize, solved: &Solved, test_fr: &Frames) {
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let Solved { base, fits, resid } = solved;
        if base.len() == 0 {
            return;
        }
        let (base_test, start) = self.reference_all(base, test_fr);
        let chi_base = Self::total_chi2(&base_test);
        let n_px = self.fov_px(rect) as f64;
        let dof = (test_fr.len() as f64
            * (n_px - (self.bgs[ti].as_ref().expect("basis").k + base.len()) as f64))
            .max(1.0);
        let s2 = (chi_base / dof).max(1.0);
        let mut updates = Vec::new();
        let joint = self.refine_clusters(
            ti,
            base,
            test_fr,
            (&base_test, start.as_ref()),
            chi_base,
            s2,
            &mut updates,
        );
        for i in 0..base.len() {
            let id = base.cols[i].id;
            if joint.contains(&id) {
                continue;
            }
            let Some(ci) = self.cells.iter().position(|c| c.id == id) else {
                continue;
            };
            let cell = self.cells[ci].clone();
            if core
                .local(cell.center.0 as usize, cell.center.1 as usize)
                .is_none()
            {
                continue;
            }
            let from_stats = self.stats_estimate(id).is_some();
            let new = if from_stats {
                match self.stats_proposal(&cell, true) {
                    Some(n) => n,
                    None => continue,
                }
            } else if self.frames.saturating_sub(cell.born) > self.cfg.reservoir_refine_frames {
                // Past its youth a cell is refined from its running
                // statistics only (a footprint from a few dozen reservoir
                // frames is too noisy to keep replacing).
                continue;
            } else {
                let sig = self.coord_noise(base, i);
                let active: Vec<usize> = (0..fits.len())
                    .filter(|&t| fits[t].c[i] >= 2.0 * sig)
                    .collect();
                if active.len() < 3 {
                    continue;
                }
                let r = cell.radius + 2.0;
                // A footprint the patch cannot hold whole is left to its
                // running statistics (which see all of it).
                let whole = Rect::around(cell.center.0, cell.center.1, r, self.dims);
                if clip(whole, rect) != whole {
                    continue;
                }
                let dom = self.disk(rect, cell.center.0, cell.center.1, r);
                let data: Vec<Vec<f32>> = active
                    .iter()
                    .map(|&t| {
                        let mut d = resid[t].clone();
                        base.cols[i].add_to(&mut d, fits[t].c[i]);
                        d
                    })
                    .collect();
                let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
                let mut c: Vec<f32> = active.iter().map(|&t| fits[t].c[i]).collect();
                let h = rank1(&refs, &dom, &mut c, 1, true);
                self.work += (dom.len() * data.len()) as u64;
                let Some(mut new) = self.make_cell(id, rect, &dom, &h, Some(&cell)) else {
                    continue;
                };
                new.born = cell.born;
                if self.change(&cell, &new) < self.cfg.refine_min_change {
                    continue;
                }
                new
            };
            let cols = self.columns(rect, &[id], &[&new]);
            let pr = self.problem(ti, cols);
            let f = self.solve_all_from(&pr, test_fr, start.as_ref());
            let gain = (chi_base - Self::total_chi2(&f)) / s2;
            let z = paired_z(&base_test, &f);
            // A reservoir estimate is noisy and re-proposed on every
            // visit, so it needs the stronger evidence an absorption does.
            let need = if from_stats {
                self.cfg.refine_z
            } else {
                self.cfg.absorb_z
            };
            let accepted = gain > 0.0 && z > f64::from(need);
            #[cfg(feature = "diagnostics")]
            self.log_test(
                EditKind::Refine,
                id,
                if from_stats { 1 } else { 2 },
                accepted,
                z,
            );
            if accepted {
                updates.push((id, new, z as f32, if from_stats { 1 } else { 2 }));
            }
        }
        for (id, new, margin, source) in updates {
            if let Some(ci) = self.cells.iter().position(|c| c.id == id) {
                #[cfg(feature = "diagnostics")]
                diagnostics::refine(self, &self.cells[ci], &new, margin, source);
                self.stats.refines += 1;
                self.edits.refines += 1;
                self.log(EditKind::Refine, id, source, new.center, margin);
                let bbox = new.bbox;
                journal!(self, Op::Replace(id, new.clone()));
                self.cells[ci] = new;
                self.pending = true;
                self.touch(bbox);
            }
        }
        self.tiles[ti].fresh = 0;
    }
}
