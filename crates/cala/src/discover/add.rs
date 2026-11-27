//! Adds: residual candidates, their held-out test, and the competing
//! explanations (absorb, merge-in) they must beat.

use super::local::{rank1, BgBasis, Cell, Column, Fit, Problem, Rect};
use super::math::{adjusted_r2, clip, corr, paired_z, MAD_TO_SIGMA};
use super::shard::Op;
use super::solve::Frames;
use super::{EditKind, SlowLoop};

/// What a residual candidate became.
// (Short-lived, one per candidate: boxing the cells buys nothing.)
#[allow(clippy::large_enum_variant)]
pub(super) enum Outcome {
    Add(Cell, f32),
    /// The candidate, the existing cell re-estimated to take it up, margin.
    Absorb(Cell, Cell, u64, f32),
    Reject,
}

/// Held-out verdict on a residual candidate (`SlowLoop::assess_add`).
struct AddVerdict {
    /// χ² gain of adding it (units of the variance the model leaves).
    gain: f64,
    /// It passes the event and neighbour-trace checks.
    ok: bool,
    /// Best competing explanation: its index, gain, and the paired z of
    /// its per-frame gains (`paired_z`).
    alt: Option<(usize, f64, f64)>,
    /// Noise-column null of the test frames (mean, sd).
    null: (f64, f64),
}

impl SlowLoop {
    pub(super) fn add(
        &mut self,
        ti: usize,
        resid: Vec<Vec<f32>>,
        base: &Problem,
        fits: &[Fit],
        test_fr: &Frames,
    ) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        let d = self.cfg.cell_diameter_px;
        let (mut adds, mut rejects) = (0, 0);
        // Residual maps of the fitting frames, computed once; an accepted
        // cell's signal is subtracted from them in place.
        let mut maps: Option<(Vec<Vec<f32>>, Vec<Vec<f32>>, f32, Vec<f32>)> = None;
        let mut resid = Some(resid);
        let mut test_maps: Option<(Vec<Vec<f32>>, f32)> = None;
        while adds < self.cfg.max_adds_per_visit && rejects < self.cfg.max_rejects_per_visit {
            if maps.is_none() {
                let resid = resid.take().expect("first pass");
                let (blurred, scale) = self.blurred_maps(rect, core, &resid);
                let mut score = vec![0.0f32; core.len()];
                self.score_window(rect, core, core, &blurred, scale, &mut score);
                maps = Some((resid, blurred, scale, score));
            }
            let (resid, blurred, scale, score) = maps.as_ref().expect("computed");
            let scale = *scale;
            let mut best: Option<(usize, usize, f32)> = None;
            let now = self.frames;
            for gy in core.y0..core.y0 + core.h {
                for gx in core.x0..core.x0 + core.w {
                    if self.fov[gy * self.dims.width + gx] == 0 {
                        continue;
                    }
                    let (fy, fx) = (gy as f32, gx as f32);
                    let s = score[(gy - core.y0) * core.w + gx - core.x0];
                    if best.is_some_and(|b| s <= b.2) {
                        continue;
                    }
                    let quiet = self.cfg.reject_cooldown_frames;
                    let suppressed = self.tiles[ti].rejected.iter().any(|r| {
                        r.2 > now && (r.0 - fy).powi(2) + (r.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    }) || self.tiles[ti].tombs.iter().any(|r| {
                        // After the k-th deletion at a spot, nothing is
                        // added there for 4^k cooldowns (no add / delete
                        // oscillation).
                        r.2 + quiet * (1u64 << (2 * r.3.min(6))) > now
                            && (r.0 - fy).powi(2) + (r.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    }) || self.cells.iter().any(|c| {
                        (c.center.0 - fy).powi(2) + (c.center.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    });
                    if !suppressed {
                        best = Some((gy, gx, s));
                    }
                }
            }
            let ev = self.cfg.event_z - 2.0;
            let Some((py, px, s)) = best else { break };
            if s < self.cfg.min_events as f32 * ev * ev {
                break;
            }
            self.stats.proposals += 1;
            let l = rect.local(py, px).expect("inside");
            if !self.pretest(ti, test_fr, &mut test_maps, l) {
                self.stats.pretest_rejects += 1;
                self.stats.rejects += 1;
                self.reject(ti, py as f32, px as f32);
                rejects += 1;
                continue;
            }
            let mut c0: Vec<f32> = blurred
                .iter()
                .map(|b| (b[l] / scale - 2.0).max(0.0))
                .collect();
            let id = self.next_id;
            let cand = self.fit_new(id, rect, resid, &mut c0, (py as f32, px as f32));
            let mut lives = 0;
            // Model comparison on held-out frames: a new cell, or an existing
            // cell re-estimated to take the residual up (grown, or with the
            // candidate merged in). A new cell costs a column, so it must
            // beat the best alternative by the add margin (that is what an
            // extra column of pure noise would buy, plus `accept_z` sd); an
            // alternative costs nothing extra but must itself improve on the
            // current model.
            let mut outcome = Outcome::Reject;
            if let Some(cell) = cand {
                let tomb = self
                    .tile_of(cell.center.0, cell.center.1)
                    .and_then(|t| self.tomb(t, cell.center.0, cell.center.1));
                lives = tomb.map_or(0, |t| t.1);
                let (mut alts, kinds) = {
                    let (resid, ..) = maps.as_ref().expect("computed");
                    self.alternatives(ti, &cell, &c0, resid, base, fits)
                };
                let v = self.assess_add(ti, test_fr, &cell, tomb.map(|t| t.0), &alts);
                let (m, sd) = v.null;
                let alt_gain = v.alt.map_or(0.0, |a| a.1.max(0.0));
                let margin = v.gain - alt_gain - m;
                let pen = f64::from(self.cfg.accept_z) * sd;
                // An alternative that explains only part of the new cell's
                // gain is a neighbour stretched over a distinct cell (on the
                // minisim recordings, letting it win cost much of the recall):
                // the candidate is then added if it passes the add test on
                // its own. Only an alternative that explains most of it
                // (`absorb_share`) holds the add to the stricter margin.
                let distinct = alt_gain < f64::from(self.cfg.absorb_share) * v.gain;
                if v.ok && (margin > pen || distinct && v.gain - m > pen) {
                    outcome = Outcome::Add(cell, (margin / sd) as f32);
                } else if let Some((k, g, z)) = v.alt {
                    // The best of several alternatives, chosen on these
                    // frames: it needs a larger paired z than a single
                    // refinement does.
                    #[cfg(feature = "diagnostics")]
                    self.log_test(
                        EditKind::Absorb,
                        alts[k].id,
                        0,
                        g > 0.0 && z > f64::from(self.cfg.absorb_z),
                        z,
                    );
                    if g > 0.0 && z > f64::from(self.cfg.absorb_z) {
                        let alt = alts.swap_remove(k);
                        outcome = Outcome::Absorb(cell, alt, kinds[k], z as f32);
                    }
                }
            }
            let taken = match outcome {
                Outcome::Add(mut cell, margin) => {
                    cell.born = self.frames;
                    self.edits.adds += 1;
                    let nb = self.nearest(cell.center.0, cell.center.1, cell.id);
                    self.log(EditKind::Add, cell.id, nb, cell.center, margin);
                    self.churn
                        .on_add(self.frames, cell.id, cell.center, &cell.pix, &cell.filt);
                    journal!(self, Op::ChurnAdd(cell.clone()));
                    if lives > 0 {
                        self.lives.insert(cell.id, lives);
                        journal!(self, Op::LivesInsert(cell.id, lives));
                    }
                    self.next_id += 1;
                    self.stats.adds += 1;
                    self.cells.push(cell.clone());
                    journal!(self, Op::Push(cell.clone()));
                    cell
                }
                Outcome::Absorb(cell, alt, kind, margin) => {
                    // The existing cell takes the residual up; the spot is not
                    // proposed again for a cooldown (doubling with each time).
                    self.stats.absorbs += 1;
                    self.stats.refines += 1;
                    self.edits.absorbs += 1;
                    self.edits.refines += 1;
                    self.log(EditKind::Absorb, alt.id, kind, alt.center, margin);
                    self.touch(alt.bbox);
                    if let Some(ci) = self.cells.iter().position(|c| c.id == alt.id) {
                        journal!(self, Op::Replace(alt.id, alt.clone()));
                        self.cells[ci] = alt;
                    }
                    self.reject(ti, py as f32, px as f32);
                    cell
                }
                Outcome::Reject => {
                    self.stats.rejects += 1;
                    self.reject(ti, py as f32, px as f32);
                    rejects += 1;
                    continue;
                }
            };
            // Blank the explained signal from the residual maps (the
            // candidate's least-squares trace per frame), so the same signal
            // is not proposed again; neighbours are re-solved on the next
            // visit.
            let bbox = taken.bbox;
            let col = Column::of(&taken, &self.grid(rect), self.dims.width);
            let (resid, blurred, scale, score) = maps.as_mut().expect("computed");
            let cc: f32 = col.norm2().max(1e-12);
            for r in resid.iter_mut() {
                let c = (col.dot(r) / cc).max(0.0);
                col.add_to(r, -c);
            }
            let m = (3.0 * self.detect_sigma()).ceil() as usize;
            let win = clip(
                Rect {
                    y0: bbox.y0.saturating_sub(m),
                    x0: bbox.x0.saturating_sub(m),
                    h: bbox.h + 2 * m,
                    w: bbox.w + 2 * m,
                },
                core,
            );
            let scale = *scale;
            for (r, b) in resid.iter().zip(blurred.iter_mut()) {
                self.blur_window(rect, win, r, b);
            }
            self.work += (resid.len() * col.pix.len() * 2) as u64;
            self.score_window(rect, core, win, blurred, scale, score);
            self.pending = true;
            self.touch(bbox);
            self.tiles[ti].fresh = 0;
            adds += 1;
        }
    }

    /// Cheap held-out pre-test of a proposal at patch pixel `l`: the
    /// current model's residual on the held-out frames, blurred to cell
    /// scale, must rise 2 σ above its robust level on at least `min_events`
    /// frames (the add test needs `min_events` held-out transients). The
    /// held-out maps are made once per visit; cells accepted later in the
    /// visit leave them stale, which only makes the pre-test more lenient.
    fn pretest(
        &mut self,
        ti: usize,
        test_fr: &Frames,
        maps: &mut Option<(Vec<Vec<f32>>, f32)>,
        l: usize,
    ) -> bool {
        if maps.is_none() {
            let rect = self.tiles[ti].rect;
            let core = self.tiles[ti].core;
            let cols = self.columns(rect, &[], &[]);
            let base = self.problem(ti, cols);
            let fits = self.solve_all(&base, test_fr);
            let resid = self.residuals(&base, test_fr, &fits, ti);
            let (blurred, scale) = self.blurred_maps(rect, core, &resid);
            *maps = Some((blurred, scale));
        }
        let (blurred, scale) = maps.as_ref().expect("computed");
        let hits = blurred.iter().filter(|b| b[l] / scale > 2.0).count();
        hits >= self.cfg.min_events as usize
    }

    /// Each residual of `rect` blurred to cell scale over `core` (zero
    /// elsewhere), and their robust noise scale: `MAD_TO_SIGMA` times the
    /// median |value| over every third core pixel and row of every map (at
    /// least 1e-6; 1 when there are none).
    fn blurred_maps(&mut self, rect: Rect, core: Rect, resid: &[Vec<f32>]) -> (Vec<Vec<f32>>, f32) {
        let mut blurred = Vec::with_capacity(resid.len());
        for r in resid {
            let mut b = vec![0.0f32; r.len()];
            self.blur_window(rect, core, r, &mut b);
            blurred.push(b);
        }
        let mut sample: Vec<f32> = blurred
            .iter()
            .flat_map(|b| {
                (0..core.h).step_by(3).flat_map(move |y| {
                    let row = (core.y0 - rect.y0 + y) * rect.w + core.x0 - rect.x0;
                    b[row..row + core.w].iter().step_by(3).map(|v| v.abs())
                })
            })
            .collect();
        let mid = sample.len() / 2;
        let scale = if sample.is_empty() {
            1.0
        } else {
            MAD_TO_SIGMA * *sample.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
        }
        .max(1e-6);
        (blurred, scale)
    }

    fn detect_sigma(&self) -> f32 {
        (self.cfg.cell_diameter_px / 4.0).max(0.6)
    }

    /// Cell-scale blur of the patch residual `r` into `out`, only over the
    /// window `win` (read with a 3 σ margin, so the window is exact).
    fn blur_window(&mut self, rect: Rect, win: Rect, r: &[f32], out: &mut [f32]) {
        let m = (3.0 * self.detect_sigma()).ceil() as usize;
        let full = Rect {
            y0: rect.y0,
            x0: rect.x0,
            h: rect.h,
            w: rect.w,
        };
        let canvas = clip(
            Rect {
                y0: win.y0.saturating_sub(m),
                x0: win.x0.saturating_sub(m),
                h: win.h + 2 * m,
                w: win.w + 2 * m,
            },
            full,
        );
        let mut src = vec![0.0f32; canvas.len()];
        for y in 0..canvas.h {
            let row = (canvas.y0 - rect.y0 + y) * rect.w + canvas.x0 - rect.x0;
            src[y * canvas.w..(y + 1) * canvas.w].copy_from_slice(&r[row..row + canvas.w]);
        }
        let mut dst = vec![0.0f32; canvas.len()];
        self.detect.blur(canvas.h, canvas.w, &src, &mut dst);
        for y in 0..win.h {
            let crow = (win.y0 - canvas.y0 + y) * canvas.w + win.x0 - canvas.x0;
            let row = (win.y0 - rect.y0 + y) * rect.w + win.x0 - rect.x0;
            out[row..row + win.w].copy_from_slice(&dst[crow..crow + win.w]);
        }
        self.work += (canvas.len() * 15) as u64;
    }

    /// Detection score (summed squared excursions above 2 σ over the fitting
    /// frames) of the core pixels inside `win`.
    fn score_window(
        &mut self,
        rect: Rect,
        core: Rect,
        win: Rect,
        blurred: &[Vec<f32>],
        scale: f32,
        score: &mut [f32],
    ) {
        for y in win.y0..win.y0 + win.h {
            for x in win.x0..win.x0 + win.w {
                let l = rect.local(y, x).expect("window inside rect");
                let mut s = 0.0f32;
                for b in blurred {
                    let z = b[l] / scale - 2.0;
                    if z > 0.0 {
                        s += z * z;
                    }
                }
                score[(y - core.y0) * core.w + x - core.x0] = s;
            }
        }
        self.work += (win.len() * blurred.len()) as u64;
    }

    pub(super) fn reject(&mut self, ti: usize, y: f32, x: f32) {
        journal!(self, Op::Reject(ti, y, x));
        self.reject_at(ti, y, x);
    }

    pub(super) fn reject_at(&mut self, ti: usize, y: f32, x: f32) {
        let now = self.frames;
        let d = self.cfg.cell_diameter_px;
        let base = self.cfg.reject_cooldown_frames;
        let t = &mut self.tiles[ti];
        if let Some(r) = t
            .rejected
            .iter_mut()
            .find(|r| (r.0 - y).powi(2) + (r.1 - x).powi(2) <= (0.5 * d).powi(2))
        {
            r.3 = (r.3 + 1).min(6);
            r.2 = now + base * (1 << r.3);
            r.0 = y;
            r.1 = x;
        } else {
            t.rejected.push((y, x, now + base, 0));
        }
    }

    /// Patch-local pixels of the disk `(cy, cx, r)` inside `rect`.
    pub(super) fn disk(&self, rect: Rect, cy: f32, cx: f32, r: f32) -> Vec<u32> {
        let mut out = Vec::new();
        for y in 0..rect.h {
            for x in 0..rect.w {
                let (gy, gx) = (rect.y0 + y, rect.x0 + x);
                let (dy, dx) = (gy as f32 - cy, gx as f32 - cx);
                if dy * dy + dx * dx <= r * r && self.fov[gy * self.dims.width + gx] != 0 {
                    out.push((y * rect.w + x) as u32);
                }
            }
        }
        out
    }

    /// Rank-1 fit of a new cell on a small disk around `peak`.
    fn fit_new(
        &mut self,
        id: u64,
        rect: Rect,
        resid: &[Vec<f32>],
        c: &mut [f32],
        peak: (f32, f32),
    ) -> Option<Cell> {
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let refs: Vec<&[f32]> = resid.iter().map(|r| r.as_slice()).collect();
        let dom = self.disk(rect, peak.0, peak.1, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        // Recentre on the half-max centroid and fit again.
        let hmax = h.iter().copied().fold(0.0f32, f32::max);
        if !(hmax > 0.0) {
            return None;
        }
        let (mut sw, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
        for (&p, &v) in dom.iter().zip(&h) {
            if v >= 0.5 * hmax {
                sw += v;
                sy += v * (rect.y0 + p as usize / rect.w) as f32;
                sx += v * (rect.x0 + p as usize % rect.w) as f32;
            }
        }
        let (cy, cx) = (sy / sw, sx / sw);
        let dom = self.disk(rect, cy, cx, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        self.work += (dom.len() * resid.len() * 42) as u64;
        self.make_cell(id, rect, &dom, &h, None)
    }

    /// The tile's background basis plus a free Gaussian bump (σ = one cell
    /// diameter) at `center`, and the frames' projections extended by it.
    pub(super) fn with_bump(
        &self,
        ti: usize,
        center: (f32, f32),
        ys: &[Vec<f32>],
        proj: &[(Vec<f64>, f64)],
    ) -> (BgBasis, Vec<(Vec<f64>, f64)>) {
        let rect = self.tiles[ti].rect;
        let s = self.cfg.cell_diameter_px;
        let mut bump = vec![0.0f32; rect.len()];
        for y in 0..rect.h {
            for x in 0..rect.w {
                let dy = (rect.y0 + y) as f32 - center.0;
                let dx = (rect.x0 + x) as f32 - center.1;
                bump[y * rect.w + x] = (-(dy * dy + dx * dx) / (2.0 * s * s)).exp();
            }
        }
        let bg = self.bgs[ti].as_ref().expect("basis").with_extra(&bump);
        let proj = ys
            .iter()
            .zip(proj)
            .map(|(y, (q, yy))| {
                let mut q = q.clone();
                q.push(bump.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum());
                (q, *yy)
            })
            .collect();
        (bg, proj)
    }

    /// `bg` plus the spatial derivatives of the (up to two) nearest cells
    /// whose support the candidate disk at `center` touches, as free
    /// nuisance maps: a registration error `δ` moves a cell's light by
    /// `(δ · ∇h + ½ δᵀ ∇∇h δ) c_t`, a dipole (and a blur) next to the cell
    /// that is not a new cell.
    fn with_shift_terms(
        &mut self,
        ti: usize,
        center: (f32, f32),
        mut bg: BgBasis,
        mut proj: Vec<(Vec<f64>, f64)>,
        ys: &[Vec<f32>],
    ) -> (BgBasis, Vec<(Vec<f64>, f64)>) {
        let rect = self.tiles[ti].rect;
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let mut nb: Vec<(f32, usize)> = self
            .cells
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let d = ((c.center.0 - center.0).powi(2) + (c.center.1 - center.1).powi(2)).sqrt();
                (d < c.radius + r0 && c.bbox.intersects(&rect)).then_some((d, i))
            })
            .collect();
        nb.sort_by(|a, b| a.0.total_cmp(&b.0));
        nb.truncate(2);
        let w = self.dims.width;
        let grid = self.grid(rect);
        for (_, i) in nb {
            let col = Column::of(&self.cells[i], &grid, w);
            if col.pix.is_empty() {
                continue;
            }
            // The support part only: the block-constant moat would put
            // steps (not a registration dipole) into the gradients.
            let mut dense = vec![0.0f32; rect.len()];
            for (&p, &v) in col.pix.iter().zip(&col.on_support()) {
                dense[p as usize] = v;
            }
            let n = rect.len();
            let (mut gy, mut gx) = (vec![0.0f32; n], vec![0.0f32; n]);
            let (mut gyy, mut gxx, mut gxy) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
            for y in 0..rect.h {
                for x in 0..rect.w {
                    let at = |yy: usize, xx: usize| dense[yy * rect.w + xx];
                    let p = y * rect.w + x;
                    let (yu, yd) = (y.saturating_sub(1), (y + 1).min(rect.h - 1));
                    let (xl, xr) = (x.saturating_sub(1), (x + 1).min(rect.w - 1));
                    gy[p] = 0.5 * (at(yd, x) - at(yu, x));
                    gx[p] = 0.5 * (at(y, xr) - at(y, xl));
                    gyy[p] = at(yd, x) - 2.0 * at(y, x) + at(yu, x);
                    gxx[p] = at(y, xr) - 2.0 * at(y, x) + at(y, xl);
                    gxy[p] = 0.25 * (at(yd, xr) - at(yd, xl) - at(yu, xr) + at(yu, xl));
                }
            }
            // Second order (`½ δᵀ ∇∇h δ`): with the moat modelled, the
            // cell's amplitude is pinned by light the misregistration does
            // not change, so the core's blur by the registration error is
            // left over and must be a nuisance too.
            for g in [gy, gx, gyy, gxx, gxy] {
                bg = bg.with_extra(&g);
                for (y, (q, _)) in ys.iter().zip(proj.iter_mut()) {
                    q.push(g.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum());
                }
                self.work += (rect.len() * (ys.len() + bg.k)) as u64;
            }
        }
        (bg, proj)
    }

    /// Held-out test of adding `cell` to the tile's problem.
    ///
    /// Both arms get one extra free background term, a Gaussian of σ = one
    /// cell diameter centred on the candidate: broad local signal (scatter
    /// halo of the neighbours, neuropil, out-of-focus light) is explained
    /// without the candidate, so the candidate must explain *compact*
    /// signal (the patch's 3 x 3 bumps are too smooth to do this alone).
    ///
    /// Near a spot where a cell was deleted (`after` = the frame of the
    /// deletion), only held-out frames after the deletion count as events:
    /// a deleted cell comes back only on new evidence.
    ///
    /// `alts` are the competing explanations of the same residual (an
    /// existing cell's footprint re-estimated to take it up, same id): each
    /// is solved on the same held-out frames, and the verdict reports the
    /// best one's gain.
    fn assess_add(
        &mut self,
        ti: usize,
        test_fr: &Frames,
        cell: &Cell,
        after: Option<u64>,
        alts: &[Cell],
    ) -> AddVerdict {
        let rect = self.tiles[ti].rect;
        let (bg, proj) = self.with_bump(ti, cell.center, &test_fr.y, &test_fr.proj);
        let (bg, proj) = if self.cfg.shift_nuisance {
            self.with_shift_terms(ti, cell.center, bg, proj, &test_fr.y)
        } else {
            (bg, proj)
        };
        self.work += (rect.len() * (test_fr.len() + 2 * bg.k)) as u64;
        let mut work = 0;
        let base = self.new_problem(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
        let ext = self.new_problem(self.columns(rect, &[], &[cell]), &bg, rect.len(), &mut work);
        self.work += work;
        let (b, start) = self.reference(&base, test_fr, &proj);
        let e = self.solve_frames_from(&ext, test_fr, &proj, start.as_ref());
        let k = ext.len() - 1;
        // What the base model leaves is noise *plus* everything not modelled
        // (dim cells below detection, neuropil): measure its variance per
        // pixel and express gains and events in that unit (>= 1, the noise).
        let n_px = self.fov_px(rect) as f64;
        let dof = (test_fr.len() as f64 * (n_px - (bg.k + base.len()) as f64)).max(1.0);
        let chi_b = Self::total_chi2(&b);
        let s2 = (chi_b / dof).max(1.0);
        let sig = self.coord_noise(&ext, k) * s2.sqrt() as f32;
        let null = self.null(test_fr.len());
        let gain = (chi_b - Self::total_chi2(&e)) / s2;
        // Competing explanations, on the same frames and background. The
        // best one is chosen on the even held-out frames and confirmed on
        // the odd ones (its paired z there), so picking the luckiest of
        // several does not pass for evidence.
        let mut alt: Option<(usize, f64, f64)> = None;
        let mut best_even = f64::NEG_INFINITY;
        let even = |f: &[Fit]| f.iter().step_by(2).map(|x| x.chi2).sum::<f64>();
        let odd = |f: &[Fit]| -> Vec<Fit> { f.iter().skip(1).step_by(2).cloned().collect() };
        let (b_even, b_odd) = (even(&b), odd(&b));
        for (i, a) in alts.iter().enumerate() {
            let mut work = 0;
            let pr = self.new_problem(
                self.columns(rect, &[a.id], &[a]),
                &bg,
                rect.len(),
                &mut work,
            );
            self.work += work;
            let f = self.solve_frames_from(&pr, test_fr, &proj, start.as_ref());
            let g_even = b_even - even(&f);
            if g_even > best_even {
                best_even = g_even;
                let g = (chi_b - Self::total_chi2(&f)) / s2;
                alt = Some((i, g, paired_z(&b_odd, &odd(&f))));
            }
        }
        // Events are transients above the candidate's own held-out median:
        // a static pattern (a floor or vessel-edge residual) with a constant
        // trace explains held-out χ² but is not a cell.
        let mut sorted: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
        sorted.sort_by(f32::total_cmp);
        let base_level = sorted[sorted.len() / 2];
        let events = e
            .iter()
            .zip(&test_fr.idx)
            .filter(|(f, &fi)| {
                after.is_none_or(|a| fi > a) && f.c[k] - base_level >= self.cfg.event_z * sig
            })
            .count() as u32;
        let mut ok = events >= self.cfg.min_events;
        // A candidate whose held-out trace follows a nearby cell's is that
        // cell's unmodelled light (scatter halo, a footprint mismatch), not
        // a new cell: left to the alternatives (and refinement, merging).
        if ok {
            let ck: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
            let mut near: Vec<Vec<f32>> = Vec::new();
            for j in 0..k {
                let Some(cj) = self.cells.iter().find(|c| c.id == ext.cols[j].id) else {
                    continue;
                };
                // Supports that touch.
                let reach = cj.radius + cell.radius;
                let d2 =
                    (cj.center.0 - cell.center.0).powi(2) + (cj.center.1 - cell.center.1).powi(2);
                if d2 <= reach * reach {
                    let tj: Vec<f32> = e.iter().map(|f| f.c[j]).collect();
                    if corr(&ck, &tj) >= self.cfg.merge_corr {
                        ok = false;
                        break;
                    }
                    near.push(tj);
                }
            }
            if ok && self.cfg.joint_neighbours && near.len() >= 2 {
                let r2 = adjusted_r2(&ck, &near);
                self.work += (ck.len() * near.len() * near.len()) as u64;
                if r2 >= self.cfg.merge_corr * self.cfg.merge_corr {
                    ok = false;
                }
            }
        }
        AddVerdict {
            gain,
            ok,
            alt,
            null,
        }
    }

    /// Competing explanations of a residual candidate: each existing cell
    /// whose support the candidate's disk touches (the two nearest),
    /// re-estimated (a) from its running statistics, (b) with its fitted
    /// trace held fixed on its support plus the candidate's disk (the
    /// footprint grows into the residual), (c) by a rank-1 fit of its
    /// signal plus the residual on that domain (the candidate merged in).
    fn alternatives(
        &mut self,
        ti: usize,
        cand: &Cell,
        cand_trace: &[f32],
        resid: &[Vec<f32>],
        base: &Problem,
        fits: &[Fit],
    ) -> (Vec<Cell>, Vec<u64>) {
        let rect = self.tiles[ti].rect;
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let mut kinds = Vec::new();
        let mut nb: Vec<(f32, u64)> = self
            .cells
            .iter()
            .filter_map(|c| {
                let d = ((c.center.0 - cand.center.0).powi(2)
                    + (c.center.1 - cand.center.1).powi(2))
                .sqrt();
                (d < c.radius + r0).then_some((d, c.id))
            })
            .collect();
        nb.sort_by(|a, b| a.0.total_cmp(&b.0));
        nb.truncate(2);
        let mut out = Vec::new();
        for (_, id) in nb {
            let Some(cell) = self.cells.iter().find(|c| c.id == id).cloned() else {
                continue;
            };
            if let Some(new) = self.stats_proposal(&cell, false) {
                out.push(new);
                kinds.push(1);
            }
            let Some(k) = base.cols.iter().position(|c| c.id == id) else {
                continue;
            };
            let mut dom: Vec<u32> = base.cols[k].pix.clone();
            dom.extend(self.disk(rect, cand.center.0, cand.center.1, r0));
            dom.sort_unstable();
            dom.dedup();
            let dense = base.cols[k].dense(rect.len());
            // The cell's signal plus the residual, on the domain only.
            let data: Vec<Vec<f32>> = resid
                .iter()
                .zip(fits)
                .map(|(r, f)| {
                    let ck = f.c[k];
                    dom.iter()
                        .map(|&p| r[p as usize] + dense[p as usize] * ck)
                        .collect()
                })
                .collect();
            let local: Vec<u32> = (0..dom.len() as u32).collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let c0: Vec<f32> = fits.iter().map(|f| f.c[k]).collect();
            if !c0.iter().any(|&v| v > 0.0) {
                continue;
            }
            // Grown or merged in only when the candidate's fitting-frame
            // trace follows the cell's (the residual is that cell's light):
            // otherwise a neighbouring cell would be swallowed whenever a
            // stretched footprint happens to explain part of it (on the
            // minisim recordings this cost much of the recall).
            if corr(cand_trace, &c0) < self.cfg.merge_corr {
                continue;
            }
            self.work += (dom.len() * data.len() * 13) as u64;
            let mut c = c0.clone();
            let h = rank1(&refs, &local, &mut c, 1, true);
            if let Some(mut new) = self.make_cell(id, rect, &dom, &h, Some(&cell)) {
                new.born = cell.born;
                out.push(new);
                kinds.push(2);
            }
            let mut c = c0;
            let h = rank1(&refs, &local, &mut c, 10, false);
            if let Some(mut new) = self.make_cell(id, rect, &dom, &h, None) {
                new.born = cell.born;
                out.push(new);
                kinds.push(3);
            }
        }
        (out, kinds)
    }
}
