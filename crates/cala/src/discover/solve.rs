//! A visit's patch problems: loading a tile's frames, building problems from
//! the working set, solving them per frame (with the visit's memos) and their
//! residuals.

use super::local::{BgBasis, Cell, Column, Fit, PatchGrid, Problem, Rect};
use super::reservoir::Slot;
use super::{local, reservoir, SlowLoop};
use std::collections::HashMap;
use std::sync::Arc;

/// A tile's model solved on its fitting frames.
pub(super) struct Solved {
    pub(super) base: Problem,
    pub(super) fits: Vec<Fit>,
    pub(super) resid: Vec<Vec<f32>>,
}

/// Where the per-frame solves of a comparison start
/// ([`SlowLoopConfig::warm_start`]): a reference model's solution on the same
/// frames, by cell id.
pub(super) struct Start {
    /// The reference problem's label ([`Problem::sig`]; 0: unlabelled),
    /// which with the frames determines the start (it is always the
    /// reference's solve from zero).
    key: u64,
    ids: Vec<u64>,
    /// Per frame, the reference's coefficients.
    c: Vec<Vec<f32>>,
}

impl Start {
    /// The start of each of `pr`'s columns on frame `f` (zero for a
    /// column the reference does not have).
    fn fill(&self, pr: &Problem, map: &[Option<usize>], f: usize, out: &mut Vec<f32>) {
        out.clear();
        out.extend(map.iter().map(|m| m.map_or(0.0, |k| self.c[f][k])));
        debug_assert_eq!(out.len(), pr.len());
    }

    fn map(&self, pr: &Problem) -> Vec<Option<usize>> {
        pr.cols
            .iter()
            .map(|col| self.ids.iter().position(|&id| id == col.id))
            .collect()
    }
}

/// A tile's frames loaded for a visit.
pub(super) struct Frames {
    /// Unique within the slow loop (keys the visit's solve memo).
    id: u64,
    pub(super) y: Vec<Vec<f32>>,
    pub(super) proj: Vec<(Vec<f64>, f64)>,
    /// Frame index of each.
    pub(super) idx: Vec<u64>,
    /// Patch pixels each frame lacks (registration moved them in from
    /// outside the FOV): zero in `y`, zero weight in the solves.
    miss: Vec<Vec<u32>>,
    /// The column dots of the solves on these frames, kept for the next
    /// solve with the same columns ([`SlowLoop::solve_frames`]).
    dots: std::cell::RefCell<FrameDots>,
}

/// Per column (by id, with the column they were computed for) its dots
/// `h̃ᵀ y` on every frame of a [`Frames`], and every frame's moat-grid
/// block sums, all for the moat grid `grid`.
#[derive(Default)]
struct FrameDots {
    set: bool,
    grid: Option<Arc<PatchGrid>>,
    z: Option<Vec<Vec<f64>>>,
    cols: HashMap<u64, (Column, std::rc::Rc<Vec<f64>>)>,
}

impl Frames {
    pub(super) fn new(
        id: u64,
        y: Vec<Vec<f32>>,
        proj: Vec<(Vec<f64>, f64)>,
        idx: Vec<u64>,
        miss: Vec<Vec<u32>>,
    ) -> Frames {
        Frames {
            id,
            y,
            proj,
            idx,
            miss,
            dots: Default::default(),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.y.len()
    }

    /// The dots of every column of `pr` on every frame: computed for the
    /// columns not seen before (on the same moat grid), kept for the next
    /// call.
    fn column_dots(&self, pr: &Problem) -> Vec<std::rc::Rc<Vec<f64>>> {
        let mut d = self.dots.borrow_mut();
        if !d.set || !local::same_grid(&d.grid, &pr.grid().cloned()) {
            *d = FrameDots {
                set: true,
                grid: pr.grid().cloned(),
                z: None,
                cols: HashMap::new(),
            };
        }
        if d.grid.is_some() && d.z.is_none() {
            d.z = Some(
                self.y
                    .iter()
                    .map(|y| pr.block_sums(y).expect("grid"))
                    .collect(),
            );
        }
        let d = &mut *d;
        let mut out = Vec::with_capacity(pr.len());
        for col in pr.cols.iter() {
            match d.cols.get(&col.id) {
                Some((c, v)) if c.same(col) => out.push(v.clone()),
                _ => {
                    let v: Vec<f64> = match &d.z {
                        Some(z) => self
                            .y
                            .iter()
                            .zip(z)
                            .map(|(y, z)| col.dot_with(y, Some(z)))
                            .collect(),
                        None => self.y.iter().map(|y| col.dot_with(y, None)).collect(),
                    };
                    let v = std::rc::Rc::new(v);
                    d.cols.insert(col.id, (col.clone(), v.clone()));
                    out.push(v);
                }
            }
        }
        out
    }
}

impl SlowLoop {
    pub(super) fn load(&mut self, ti: usize, test: bool) -> Frames {
        let ids: Vec<(bool, usize)> = self.tiles[ti]
            .slots()
            .into_iter()
            .filter(|&s| self.tiles[ti].slot(s).test == test)
            .collect();
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut y = Vec::with_capacity(ids.len());
        let mut proj = Vec::with_capacity(ids.len());
        let mut idx = Vec::with_capacity(ids.len());
        let mut miss = Vec::with_capacity(ids.len());
        for s in ids {
            let mut v = Vec::new();
            self.tiles[ti].slot_values(s, &self.shared, &mut v);
            miss.push(reservoir::take_missing(&mut v));
            let slot: &mut Slot = self.tiles[ti].slot_mut(s);
            idx.push(slot.frame);
            if slot.proj.is_none() {
                slot.proj = Some(bg.project(&v));
                self.work += (v.len() * (bg.k + 1)) as u64;
            }
            proj.push(slot.proj.clone().expect("set"));
            y.push(v);
        }
        self.frames_seq += 1;
        Frames::new(self.frames_seq, y, proj, idx, miss)
    }

    /// The moat grid and whitening of a patch.
    pub(super) fn grid(&self, rect: Rect) -> Arc<PatchGrid> {
        if !self.reuse {
            return Arc::new(PatchGrid::new(
                rect,
                self.dims,
                &self.inv_sigma,
                &self.fov,
                self.filter.moat().map_or(0, |m| m.0),
            ));
        }
        let mut memo = self.grid_memo.borrow_mut();
        if let Some(g) = memo.as_ref().filter(|g| g.rect == rect) {
            return g.clone();
        }
        let g = Arc::new(PatchGrid::new(
            rect,
            self.dims,
            &self.inv_sigma,
            &self.fov,
            self.filter.moat().map_or(0, |m| m.0),
        ));
        *memo = Some(g.clone());
        g
    }

    /// Columns of the cells whose supports meet `rect` (their moats too,
    /// clipped to the patch; cells that reach it only with their moat are
    /// left to the bump background).
    pub(super) fn columns(&self, rect: Rect, skip: &[u64], extra: &[&Cell]) -> Vec<Column> {
        let w = self.dims.width;
        let grid = self.grid(rect);
        let mut cols: Vec<Column> = self
            .cells
            .iter()
            .filter(|c| c.bbox.intersects(&rect) && !skip.contains(&c.id))
            .map(|c| Column::of(c, &grid, w))
            .filter(|c| !c.pix.is_empty())
            .collect();
        for c in extra {
            cols.push(Column::of(c, &grid, w));
        }
        cols
    }

    pub(super) fn solve_all(&mut self, pr: &Problem, fr: &Frames) -> Vec<Fit> {
        self.solve_all_from(pr, fr, None)
    }

    /// [`SlowLoop::solve_all`] started at `start` (`None`: at zero).
    pub(super) fn solve_all_from(
        &mut self,
        pr: &Problem,
        fr: &Frames,
        start: Option<&Start>,
    ) -> Vec<Fit> {
        let from = start.map_or(0, |s| s.key);
        if pr.sig == 0 || start.is_some() && from == 0 {
            return self.solve_frames_from(pr, fr, &fr.proj, start);
        }
        if let Some(m) = self
            .solve_memo
            .iter()
            .find(|m| m.0 == pr.sig && m.1 == fr.id && m.2 == from)
        {
            self.work += m.3;
            return m.4.clone();
        }
        let w0 = self.work;
        let fits = self.solve_frames_from(pr, fr, &fr.proj, start);
        if self.solve_memo.len() >= 8 {
            self.solve_memo.remove(0);
        }
        self.solve_memo
            .push((pr.sig, fr.id, from, self.work - w0, fits.clone()));
        fits
    }

    /// The start for comparisons against `pr`, whose solve from zero on
    /// these frames is `fits` (`None` with warm starts off).
    pub(super) fn start_at(&self, pr: &Problem, fits: &[Fit]) -> Option<Start> {
        self.cfg.warm_start.then(|| Start {
            key: pr.sig,
            ids: pr.cols.iter().map(|c| c.id).collect(),
            c: fits.iter().map(|f| f.c.clone()).collect(),
        })
    }

    /// Per-frame solves of `fr` with the background projections `proj`;
    /// frames with missing pixels give them zero weight
    /// ([`Problem::solve_missing`]). The column dots come from `fr`'s
    /// cache (bitwise what each solve would compute).
    fn solve_frames(&mut self, pr: &Problem, fr: &Frames, proj: &[(Vec<f64>, f64)]) -> Vec<Fit> {
        self.solve_frames_from(pr, fr, proj, None)
    }

    /// The reference arm of a comparison on `fr` with the background
    /// projections `proj`: its solve, and the start of the other arms
    /// ([`SlowLoopConfig::warm_start`]). With warm starts the reference is
    /// solved again from its own solution, so it too is solved from the
    /// arms' start and no arm is solved further than another.
    pub(super) fn reference(
        &mut self,
        pr: &Problem,
        fr: &Frames,
        proj: &[(Vec<f64>, f64)],
    ) -> (Vec<Fit>, Option<Start>) {
        let fits = self.solve_frames(pr, fr, proj);
        match self.start_at(pr, &fits) {
            Some(st) => (self.solve_frames_from(pr, fr, proj, Some(&st)), Some(st)),
            None => (fits, None),
        }
    }

    /// [`SlowLoop::reference`] on `fr`'s own background projections
    /// (through the solve memo).
    pub(super) fn reference_all(&mut self, pr: &Problem, fr: &Frames) -> (Vec<Fit>, Option<Start>) {
        let fits = self.solve_all(pr, fr);
        match self.start_at(pr, &fits) {
            Some(st) => (self.solve_all_from(pr, fr, Some(&st)), Some(st)),
            None => (fits, None),
        }
    }

    /// [`SlowLoop::solve_frames`] started at `start` (`None`: at zero).
    pub(super) fn solve_frames_from(
        &mut self,
        pr: &Problem,
        fr: &Frames,
        proj: &[(Vec<f64>, f64)],
        start: Option<&Start>,
    ) -> Vec<Fit> {
        let mut work = 0;
        let map = start.map(|st| st.map(pr));
        let mut c0 = Vec::new();
        if !self.reuse {
            let fits =
                fr.y.iter()
                    .zip(proj)
                    .zip(&fr.miss)
                    .enumerate()
                    .map(|(f, ((y, (qb, yy)), m))| {
                        if let (Some(st), Some(map)) = (start, &map) {
                            st.fill(pr, map, f, &mut c0);
                        }
                        let mut dw = 0;
                        let s = pr.column_dots(y, &mut dw);
                        pr.solve_missing_dots_from(&s, dw, qb, *yy, m, &c0, &mut work)
                    })
                    .collect();
            self.work += work;
            return fits;
        }
        let dots = fr.column_dots(pr);
        let mut s = vec![0.0f64; pr.len()];
        let fits =
            fr.y.iter()
                .zip(proj)
                .zip(&fr.miss)
                .enumerate()
                .map(|(f, ((y, (qb, yy)), m))| {
                    for (si, d) in s.iter_mut().zip(&dots) {
                        *si = d[f];
                    }
                    if let (Some(st), Some(map)) = (start, &map) {
                        st.fill(pr, map, f, &mut c0);
                    }
                    let dw = pr.dots_work(y.len());
                    pr.solve_missing_dots_from(&s, dw, qb, *yy, m, &c0, &mut work)
                })
                .collect();
        self.work += work;
        fits
    }

    pub(super) fn residuals(
        &mut self,
        pr: &Problem,
        fr: &Frames,
        fits: &[Fit],
        ti: usize,
    ) -> Vec<Vec<f32>> {
        // The same labelled model with the same fits on the same frames:
        // the same residuals.
        let same_fits = |a: &[Fit]| {
            a.len() == fits.len()
                && a.iter().zip(fits).all(|(x, y)| {
                    local::bits_eq(&x.c, &y.c)
                        && x.beta.len() == y.beta.len()
                        && x.beta
                            .iter()
                            .zip(&y.beta)
                            .all(|(p, q)| p.to_bits() == q.to_bits())
                })
        };
        if let Some(m) = self
            .resid_memo
            .as_ref()
            .filter(|m| pr.sig != 0 && m.0 == pr.sig && m.1 == fr.id && same_fits(&m.3))
        {
            self.work += m.2;
            return m.4.clone();
        }
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut work = 0;
        let out: Vec<Vec<f32>> =
            fr.y.iter()
                .zip(fits)
                .zip(&fr.miss)
                .map(|((y, f), m)| {
                    let mut r = vec![0.0f32; y.len()];
                    pr.residual(y, f, bg, &mut r, &mut work);
                    // No data there: no residual either.
                    for &p in m {
                        r[p as usize] = 0.0;
                    }
                    r
                })
                .collect();
        self.work += work;
        if pr.sig != 0 {
            self.resid_memo = Some((pr.sig, fr.id, work, fits.to_vec(), out.clone()));
        }
        out
    }

    pub(super) fn problem(&mut self, ti: usize, cols: Vec<Column>) -> Problem {
        let bg = self.bgs[ti].take().expect("basis");
        let mut work = 0;
        let mut pr = self.new_problem(cols, &bg, self.tiles[ti].rect.len(), &mut work);
        self.bgs[ti] = Some(bg);
        self.work += work;
        if !self.reuse {
            return pr;
        }
        // The same columns on the tile's background: the same problem.
        let same = self.tile_model.as_ref().is_some_and(|(_, cols)| {
            cols.len() == pr.cols.len()
                && cols
                    .iter()
                    .zip(pr.cols.iter())
                    .all(|(a, b)| a.same(b) && local::same_grid(&a.grid, &b.grid))
        });
        if same {
            pr.sig = self.tile_model.as_ref().expect("same").0;
        } else {
            self.model_seq += 1;
            pr.sig = self.model_seq;
            self.tile_model = Some((pr.sig, pr.cols.clone()));
        }
        pr
    }

    /// [`Problem::new`], reusing the Gram entries of the visit's last
    /// problem (bitwise the same result).
    pub(super) fn new_problem(
        &mut self,
        cols: Vec<Column>,
        bg: &BgBasis,
        n_px: usize,
        work: &mut u64,
    ) -> Problem {
        if !self.reuse {
            return Problem::new(cols, bg, n_px, work);
        }
        let pr = Problem::new_reusing(cols, bg, n_px, work, self.gram_memo.as_ref());
        self.gram_memo = Some(pr.gram_ref());
        pr
    }

    /// Held-out χ² improvement a column of noise would give: mean and sd.
    /// What a column of pure noise buys over `n` frames: mean and sd of the
    /// χ² gain (white noise: 0.5 and 1.25 per frame), scaled by the noise's
    /// cell-scale variance inflation.
    pub(super) fn null(&self, n: usize) -> (f64, f64) {
        let r = f64::from(self.rho);
        (0.5 * n as f64 * r, (1.25 * n as f64).sqrt() * r)
    }

    /// Trace noise of coordinate `i` of `pr` (white-noise σ times the
    /// inflation of correlated noise).
    pub(super) fn coord_noise(&self, pr: &Problem, i: usize) -> f32 {
        pr.coord_sigma(i) * self.rho.sqrt()
    }

    pub(super) fn total_chi2(fits: &[Fit]) -> f64 {
        fits.iter().map(|f| f.chi2).sum()
    }
}
