//! Keep tests on probes, deletions and tombstones.

#[cfg(feature = "diagnostics")]
use super::diagnostics;
use super::local::BgBasis;
use super::shard::Op;
use super::solve::Frames;
use super::{reservoir, DeleteReason, DeletedCell, EditKind, SlowLoop};

impl SlowLoop {
    /// Keep / delete decisions from the ledger (cheap; runs every step).
    ///
    /// * established: `establish_events` transients after birth, and
    ///   probes passed at least as often as failed;
    /// * deleted as unsupported (any status: a cell is never beyond
    ///   re-testing): failed probes reach `delete_fails` and outnumber the
    ///   passed ones `fail_ratio` to one;
    /// * deleted as silent: no transient at all within `probation_frames`
    ///   of its birth (times one plus the number of earlier deletions at
    ///   its spot);
    /// * mostly redundant with one neighbour: the pair is merge-tested.
    pub(super) fn prune(&mut self) {
        if !self.scope.prunes() {
            return;
        }
        let cfg = &self.cfg;
        let mut doomed = Vec::new();
        for c in &self.cells {
            let Some(ev) = self.ledger.get_mut(&c.id) else {
                continue;
            };
            let unsupported = ev.fails >= cfg.delete_fails
                && ev.fails as f32 >= cfg.fail_ratio * ev.passes as f32;
            ev.established =
                ev.transients >= cfg.establish_events && ev.passes >= ev.fails && !unsupported;
            if ev.redundant >= 2 && ev.redundant > ev.passes {
                if let Some(p) = ev.partner {
                    let pair = (c.id.min(p), c.id.max(p));
                    if !self.forced.contains(&pair) {
                        self.forced.push(pair);
                    }
                }
            }
            if self.inflight.iter().any(|f| f.ids.contains(&c.id)) {
                continue;
            }
            let lives = u64::from(self.lives.get(&c.id).copied().unwrap_or(0));
            if unsupported {
                doomed.push((c.id, DeleteReason::Unsupported));
            } else if ev.transients == 0 && ev.frames >= cfg.probation_frames * (1 + lives) {
                doomed.push((c.id, DeleteReason::Silent));
            }
        }
        for (id, reason) in doomed {
            self.delete(id, reason);
        }
        let live: std::collections::HashSet<u64> = self.cells.iter().map(|c| c.id).collect();
        self.forced
            .retain(|p| live.contains(&p.0) && live.contains(&p.1));
    }

    fn delete(&mut self, id: u64, reason: DeleteReason) {
        let Some(i) = self.cells.iter().position(|c| c.id == id) else {
            return;
        };
        #[cfg(feature = "diagnostics")]
        diagnostics::delete(self, &self.cells[i], reason.as_str());
        let info = self.info(&self.cells[i]);
        let cell = self.cells.remove(i);
        self.ledger.remove(&id);
        self.lives.remove(&id);
        self.deleted.push(DeletedCell {
            info,
            frame: self.frames,
            reason,
        });
        self.stats.deletes += 1;
        self.edits.deletes += 1;
        self.log(EditKind::Delete, id, 0, cell.center, 0.0);
        self.churn
            .on_delete(self.frames, id, cell.center, &cell.pix, &cell.filt);
        self.entomb(cell.center);
        self.pending = true;
        self.touch(cell.bbox);
    }

    /// Mark a spot where a cell was removed: nothing is added there for
    /// 4^k cooldowns after the k-th removal, and a new cell there needs
    /// held-out events from after it.
    pub(super) fn entomb(&mut self, (cy, cx): (f32, f32)) {
        journal!(self, Op::Entomb(cy, cx));
        self.entomb_at((cy, cx));
    }

    pub(super) fn entomb_at(&mut self, (cy, cx): (f32, f32)) {
        let now = self.frames;
        let d = self.cfg.cell_diameter_px;
        if let Some(ti) = self.tile_of(cy, cx) {
            let t = &mut self.tiles[ti];
            match t
                .tombs
                .iter_mut()
                .find(|r| (r.0 - cy).powi(2) + (r.1 - cx).powi(2) <= (0.5 * d).powi(2))
            {
                Some(r) => {
                    *r = (cy, cx, now, r.3 + 1);
                }
                None => t.tombs.push((cy, cx, now, 1)),
            }
            self.reject_at(ti, cy, cx);
        }
    }

    /// The tile whose core holds `(y, x)`.
    pub(super) fn tile_of(&self, y: f32, x: f32) -> Option<usize> {
        let (y, x) = (y.max(0.0) as usize, x.max(0.0) as usize);
        self.tiles.iter().position(|t| t.core.local(y, x).is_some())
    }

    /// The deletion record near `(y, x)`: `(frame, deletions)`.
    pub(super) fn tomb(&self, ti: usize, y: f32, x: f32) -> Option<(u64, u32)> {
        let d = self.cfg.cell_diameter_px;
        self.tiles[ti]
            .tombs
            .iter()
            .find(|r| (r.0 - y).powi(2) + (r.1 - x).powi(2) <= (0.5 * d).powi(2))
            .map(|r| (r.2, r.3))
    }

    /// Keep tests on the tile's probe frames: for each cell a probe was
    /// taken for, does dropping the cell raise that held-out frame's χ²
    /// (in units of the variance the full model leaves, at least the noise)
    /// by more than a noise column would, by `keep_z` standard deviations?
    /// Both arms have the free local bump, so diffuse light (neuropil, a
    /// neighbour's halo) does not count. Each probe is used once.
    ///
    /// The bump (σ = one cell diameter, centred on the cell) overlaps the
    /// cell itself: it takes most of a typical footprint's energy, so a weak transient of a real cell cannot pass.
    /// A probe that is not needed therefore only counts as a *fail* when
    /// the test had the power to pass it: when the cell's light on the
    /// probe, measured without the bump, would have passed by `keep_z`
    /// noise σ had it been shaped like the footprint. Otherwise (a weak
    /// transient, or none of the cell's light on the frame) the probe is
    /// inconclusive and counts neither way, so absence of evidence never
    /// accumulates as evidence against a cell.
    pub(super) fn keep_tests(&mut self, ti: usize) {
        let probes = std::mem::take(&mut self.tiles[ti].probes);
        if probes.is_empty() {
            return;
        }
        if self.bgs[ti].is_none() {
            self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
        }
        let rect = self.tiles[ti].rect;
        let mut ids: Vec<u64> = probes
            .iter()
            .flat_map(|p| p.cells.iter().copied())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let n_px = self.fov_px(rect) as f64;
        let (m, sd) = self.null(1);
        let pass_at = m + f64::from(self.cfg.keep_z) * sd;
        // Noise σ of √(χ² gain) of one column (the noise inflation ρ).
        let sd_unit = f64::from(self.rho).sqrt();
        for id in ids {
            let Some(cell) = self.cells.iter().find(|c| c.id == id) else {
                continue;
            };
            let center = cell.center;
            let mut ys = Vec::new();
            let mut proj = Vec::new();
            let mut ymiss = Vec::new();
            {
                let bg = self.bgs[ti].as_ref().expect("basis");
                for p in probes.iter().filter(|p| p.cells.contains(&id)) {
                    let mut v = Vec::new();
                    p.slot.values(&mut v);
                    ymiss.push(reservoir::take_missing(&mut v));
                    proj.push(bg.project(&v));
                    ys.push(v);
                }
                self.work += (ys.len() * rect.len() * (bg.k + 1)) as u64;
            }
            self.frames_seq += 1;
            let kf = Frames::new(self.frames_seq, ys, proj, Vec::new(), ymiss);
            let (ys, proj) = (&kf.y, &kf.proj);
            // The cell's amplitude on each probe without the bump: the light
            // a fail claims is not shaped like the cell.
            let plain = {
                let mut work = 0;
                let bg = self.bgs[ti].take().expect("basis");
                let pr = self.new_problem(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
                self.bgs[ti] = Some(bg);
                self.work += work + (rect.len() * ys.len()) as u64;
                let k0 = pr.cols.iter().position(|c| c.id == id);
                let fits = self.solve_all(&pr, &kf);
                (
                    k0.map(|k| fits.iter().map(|f| f64::from(f.c[k])).collect::<Vec<_>>()),
                    self.start_at(&pr, &fits),
                )
            };
            let (plain, start) = plain;
            let (bg, proj) = self.with_bump(ti, center, ys, proj);
            let mut work = 0;
            let full = self.new_problem(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
            let red = self.new_problem(self.columns(rect, &[id], &[]), &bg, rect.len(), &mut work);
            self.work += work + (rect.len() * (ys.len() + 2 * bg.k)) as u64;
            // Both arms start at the model without the bump.
            let f = self.solve_frames_from(&full, &kf, &proj, start.as_ref());
            let r = self.solve_frames_from(&red, &kf, &proj, start.as_ref());
            let dof = (n_px - (bg.k + full.len()) as f64).max(1.0);
            // Overlap of every other column with this cell's, normalised
            // by the cell's own energy: how much of the cell's signal an
            // increase of that neighbour's coefficient reproduces.
            let Some(ki) = full.cols.iter().position(|c| c.id == id) else {
                continue;
            };
            let dense = full.cols[ki].dense(rect.len());
            let ee: f32 = full.cols[ki].norm2().max(1e-12);
            let share: Vec<f32> = red.cols.iter().map(|c| c.dot(&dense) / ee).collect();
            #[cfg(feature = "diagnostics")]
            let diagnostic_before = self.ledger.get(&id).cloned();
            #[cfg(feature = "diagnostics")]
            let mut diagnostic_outcomes = Vec::new();
            let (mut pass, mut fail, mut redundant, mut inconclusive) = (0, 0, 0, 0);
            let mut partner: Option<(u64, f32)> = None;
            // χ² gain per unit amplitude² with the bump (the cell's energy
            // the bump and background cannot reproduce).
            let q_ii = full.q[ki * full.len() + ki].max(0.0);
            let power_at = pass_at.max(0.0).sqrt() + f64::from(self.cfg.keep_z) * sd_unit;
            for (j, (ff, rr)) in f.iter().zip(&r).enumerate() {
                let s2 = (ff.chi2 / dof).max(1.0);
                if (rr.chi2 - ff.chi2) / s2 > pass_at {
                    pass += 1;
                    #[cfg(feature = "diagnostics")]
                    diagnostic_outcomes.push(diagnostics::Outcome {
                        kind: "pass",
                        partner: 0,
                        took: 0.0,
                    });
                    continue;
                }
                // Not needed: did a neighbour take over at least half of
                // the cell's fitted signal?
                let ci = ff.c[ki];
                let mut best: Option<(u64, f32)> = None;
                for (j, c) in red.cols.iter().enumerate() {
                    let jf = full
                        .cols
                        .iter()
                        .position(|x| x.id == c.id)
                        .expect("same cells");
                    let took = (rr.c[j] - ff.c[jf]) * share[j];
                    if took > 0.5 * ci && best.is_none_or(|b| took > b.1) {
                        best = Some((c.id, took));
                    }
                }
                // Would a real cell with the light the probe shows (without
                // the bump) have passed? If not, the probe cannot tell.
                let c0 = plain.as_ref().map_or(0.0, |c| c[j].max(0.0));
                let powered = (c0 * c0 * q_ii / s2).sqrt() >= power_at;
                match best {
                    Some(b) if ci > 0.0 => {
                        redundant += 1;
                        partner = Some(b);
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "redundant",
                            partner: b.0,
                            took: b.1,
                        });
                    }
                    _ if !powered => {
                        inconclusive += 1;
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "inconclusive",
                            partner: best.map_or(0, |b| b.0),
                            took: best.map_or(0.0, |b| b.1),
                        });
                    }
                    _ => {
                        fail += 1;
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "fail",
                            partner: best.map_or(0, |b| b.0),
                            took: best.map_or(0.0, |b| b.1),
                        });
                    }
                }
            }
            self.stats.keep_tests += (pass + fail + redundant + inconclusive) as u64;
            self.stats.keep_fails += fail as u64;
            self.stats.keep_inconclusive += inconclusive as u64;
            if let Some(ev) = self.ledger.get_mut(&id) {
                ev.passes += pass;
                ev.fails += fail;
                ev.redundant += redundant;
                if let Some(p) = partner {
                    ev.partner = Some(p.0);
                }
                journal!(
                    self,
                    Op::Keep {
                        id,
                        pass,
                        fail,
                        redundant,
                        partner: partner.map(|p| p.0),
                    }
                );
            }
            #[cfg(feature = "diagnostics")]
            diagnostics::keep(
                self,
                id,
                ti,
                &probes,
                ys,
                &proj,
                &bg,
                &full,
                &red,
                &f,
                &r,
                &share,
                ki,
                dof,
                m,
                sd,
                pass_at,
                diagnostic_before.as_ref(),
                &diagnostic_outcomes,
            );
        }
    }
}
