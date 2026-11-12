//! Joint sufficient statistics of the footprints (S1.7): a neighbour's
//! change reaches every cell at once.
//!
//! [`super::fpstats`] estimates each cell's filtered column from running
//! sums of its *residual* `r_t = x_t − Σ_{j≠i} g_j^{(t)} c_{j,t} − β_{i,t}`,
//! in which every neighbour's column is the one of frame `t`. When a
//! neighbour's column changes nothing rewrites the old frames: the stale
//! part fades with the forgetting half-life. This store keeps the sums of
//! the *data* instead, and the neighbours' traces separately, so that the
//! neighbours' columns enter only when the footprint is estimated, with
//! their current values (the OnACID / online CNMF statistics, `W = Σ x cᵀ`
//! on each cell's region and `M = Σ c cᵀ` over the neighbours whose columns
//! reach it). Per cell `i`, on its region `D_i` (the same disk as its
//! `FpStats`), with forgetting weights `w_t`:
//!
//! ```text
//! W(p) = Σ w x_t(p) c_i      S(p) = Σ w x_t(p)                     per pixel
//! n = Σ w,  n2 = Σ w²,  a_k = Σ w c_k,  b_k = Σ w c_i c_k          per neighbour k (k = 0: i)
//! P = Σ w ρ_i c_i,  pr = Σ w ρ_i                                   ring (raw ring mean ρ_i)
//! ```
//!
//! and the estimate is, with `C_ik = b_k − a_0 a_k / n` and the ring level
//! `β_i = ρ_i − Σ_j q_ij c_j` taken apart (`q` the library's current ring
//! coupling, so a neighbour's change reaches the background term exactly
//! too: `B = P − Σ q_k b_k`, `b = pr − Σ q_k a_k`),
//!
//! ```text
//! g_i(p) = [ W(p) − S(p) a_0/n − (B − b a_0/n) − Σ_{k≥1} g_k(p) C_ik ] / C_ii.
//! ```
//!
//! With no column ever changed this is `FpStats::estimate` (z = c) up to
//! rounding; after a neighbour's change it is the least-squares fit of the
//! same frames under the neighbour's new column, at once.
//!
//! **Block groups.** Every sum is kept per block group `g` (frames of block
//! `b` go to group `b mod GROUPS`), so a fold is a subset of groups (a
//! [`GroupMask`]): fixed or rotating 2- or 4-fold hold-out, split halves
//! and the group-spread standard error all read the same sums. A visit job
//! carries the store [`CellStats::reduced`] to the groups it needs.
//!
//! **Classes.** A pixel's sums count only the frames in which it was valid
//! (#322) and only the frames since its epoch began (a birth under it), so
//! the trace moments must be over the same frames. Pixels with identical
//! counted-frame histories share one moment vector (a *class*): a frame
//! whose missing pixels cut a class splits it (partition refinement), and
//! a restart moves its pixels to a fresh, empty class. This is exact for
//! any validity pattern; under rigid motion the classes are the distinct
//! distances to the mask edge (a few dozen on an edge cell, one inside).
//!
//! **Near and far neighbours.** A neighbour whose *support* reaches `D_i`
//! is *near*: its `a_k`, `b_k` are kept per class (exact). One that reaches
//! `D_i` only through its moat (block means of `−L a_k`, small and smooth)
//! or couples only through the ring is *far*: its sums are kept once per
//! cell over every frame pushed (`a_0`, `b_0`, `a_k`, `b_k`, f32), and a
//! class's `C_ik` is taken as `C_ii^c β_k` with `β_k = C_ik / C_ii` the
//! slope of `c_k` on `c_i` over the cell's whole history. The far terms of
//! the estimate are then the same for every class, and the error at pixel
//! `p` of class `c` is exactly
//!
//! ```text
//! ĝ_i(p) − g_i(p) = Σ_{k far} (β_k^c − β_k) (g_k(p) − q_k)
//! ```
//!
//! (`β_k^c` the slope over the class's own frames, `q_k = 0` off the ring
//! row): zero for a class that counts every frame (an interior pixel with
//! no restart since the store began), and otherwise the moat's value times
//! the change of a regression slope between the pixel's frames and all
//! frames. A far neighbour whose support later reaches `D_i` becomes near;
//! its class terms start from the same approximation and are exact for
//! every frame after. Near stays near until the neighbour is deleted.
//!
//! The store accepts only `z = c` (no cross-fitting instrument yet).

use super::fpstats::MIN_VALID_SHARE;

/// Number of block groups (2-fold folds are even/odd groups, 4-fold the
/// single groups).
pub(crate) const GROUPS: usize = 4;

/// A set of block groups (bit `g` = group `g`; bits past the store's group
/// count are ignored).
pub(crate) type GroupMask = u8;

/// Every group.
pub(crate) const ALL_GROUPS: GroupMask = (1 << GROUPS) - 1;

/// The two halves (even and odd groups): the fit and test sums of a 2-fold
/// hold-out, and what a visit job carries.
pub(crate) const HALVES: [GroupMask; 2] = [0b0101, 0b1010];

/// Offsets inside one group's moment block of a class.
const N: usize = 0;
const N2: usize = 1;
const P: usize = 2;
const PR: usize = 3;
/// Near neighbour `k` (position `j` among the near ones, the cell itself
/// first): `a_k` at `HEAD + 2j`, `b_k` at `HEAD + 2j + 1`.
const HEAD: usize = 4;
/// One group's far block: `[a_0, b_0]` over every frame, then far neighbour
/// `k` (position `j` among the far ones) at `FAR_HEAD + 2j` (`a_k`) and
/// `FAR_HEAD + 2j + 1` (`b_k`).
const FAR_HEAD: usize = 2;

/// The joint statistics of one cell (see the module docs).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CellStats {
    /// Disk of the region `D_i`, px, and its FOV pixels (row-major).
    pub center: (f32, f32),
    pub radius: f32,
    pub pix: Vec<u32>,
    /// Class of each pixel.
    pub cls: Vec<u32>,
    /// Neighbour ids; `nb[0]` is the cell itself.
    pub nb: Vec<u64>,
    /// Whether each neighbour is near (per-class terms) or far (per cell).
    pub near: Vec<bool>,
    /// Block groups held: [`GROUPS`], fewer once [`CellStats::reduced`].
    pub groups: usize,
    /// `W` and `S`, group-major: `w[g * pix.len() + i]`.
    pub w: Vec<f32>,
    pub s: Vec<f32>,
    /// Per class: `groups` blocks of `[n, n2, P, pr, a_0, b_0, a_k, b_k …]`
    /// (near neighbours only).
    pub mom: Vec<Vec<f64>>,
    /// Per group, over every frame pushed: `[a_0, b_0, a_k, b_k …]` (far
    /// neighbours only).
    pub far: Vec<f32>,
    /// `Σ w` of every frame pushed, per group (the reference weight of a
    /// pixel's valid share, and the far sums' `n`).
    pub tot: Vec<f64>,
    /// Pixels restarted so far (diagnostic).
    pub restarts: u64,
    /// Position of each neighbour in its block (near or far); derived.
    pos: Vec<u32>,
}

impl CellStats {
    /// Empty statistics of cell `id` on `pix` (the disk `center`, `radius`).
    pub fn new(id: u64, center: (f32, f32), radius: f32, pix: Vec<u32>) -> CellStats {
        let n = pix.len();
        CellStats {
            center,
            radius,
            cls: vec![0; n],
            pix,
            nb: vec![id],
            near: vec![true],
            groups: GROUPS,
            w: vec![0.0; GROUPS * n],
            s: vec![0.0; GROUPS * n],
            mom: vec![vec![0.0; GROUPS * stride(1)]],
            far: vec![0.0; GROUPS * FAR_HEAD],
            tot: vec![0.0; GROUPS],
            restarts: 0,
            pos: vec![0],
        }
    }

    /// A store from its wire fields; `None` when they are inconsistent.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_parts(
        center: (f32, f32),
        radius: f32,
        pix: Vec<u32>,
        cls: Vec<u32>,
        nb: Vec<u64>,
        near: Vec<bool>,
        groups: usize,
        w: Vec<f32>,
        s: Vec<f32>,
        mom: Vec<Vec<f64>>,
        far: Vec<f32>,
        tot: Vec<f64>,
        restarts: u64,
    ) -> Option<CellStats> {
        let mut st = CellStats {
            center,
            radius,
            pix,
            cls,
            nb,
            near,
            groups,
            w,
            s,
            mom,
            far,
            tot,
            restarts,
            pos: Vec::new(),
        };
        st.index().then_some(st)
    }

    /// Rebuild `pos` from `near`; false when the layout is inconsistent
    /// (wire input).
    fn index(&mut self) -> bool {
        let (mut a, mut b) = (0u32, 0u32);
        self.pos = self
            .near
            .iter()
            .map(|&n| {
                let p = if n { &mut a } else { &mut b };
                *p += 1;
                *p - 1
            })
            .collect();
        let (nn, nf) = (a as usize, b as usize);
        let n = self.pix.len();
        self.near.len() == self.nb.len()
            && self.near.first() == Some(&true)
            && self.groups >= 1
            && self.groups <= GROUPS
            && self.tot.len() == self.groups
            && self.w.len() == self.groups * n
            && self.s.len() == self.groups * n
            && self.cls.len() == n
            && self.far.len() == self.groups * (FAR_HEAD + 2 * nf)
            && !self.mom.is_empty()
            && self.mom.iter().all(|m| m.len() == self.groups * stride(nn))
            && self.cls.iter().all(|&c| (c as usize) < self.mom.len())
    }

    /// Number of near neighbours (the cell itself included).
    fn n_near(&self) -> usize {
        self.near.iter().filter(|&&n| n).count()
    }

    fn stride(&self) -> usize {
        stride(self.n_near())
    }

    fn far_stride(&self) -> usize {
        FAR_HEAD + 2 * (self.nb.len() - self.n_near())
    }

    /// Whether the support disk `(center, radius)` lies inside the region.
    pub fn covers(&self, center: (f32, f32), radius: f32) -> bool {
        let d = ((center.0 - self.center.0).powi(2) + (center.1 - self.center.1).powi(2)).sqrt();
        d + radius <= self.radius + 0.5
    }

    /// Whether a support disk `(center, radius)` reaches the region: its
    /// column is then near (its exact values, not only its moat, fall on
    /// `D_i`).
    pub fn reached_by(&self, center: (f32, f32), radius: f32) -> bool {
        let d = ((center.0 - self.center.0).powi(2) + (center.1 - self.center.1).powi(2)).sqrt();
        d <= self.radius + radius + 0.5
    }

    /// Add one frame of group `g` with weight `w`: `x` on `pix` (NaN: the
    /// pixel is missing in this frame), the traces `c` of the neighbours
    /// (aligned with `nb`) and the raw ring mean `rho` (0 without a ring).
    pub fn push(&mut self, x: &[f32], g: usize, w: f32, c: &[f32], rho: f32) {
        debug_assert_eq!(x.len(), self.pix.len());
        debug_assert_eq!(c.len(), self.nb.len());
        debug_assert!(g < self.groups);
        let n = self.pix.len();
        let wf = f64::from(w);
        self.tot[g] += wf;
        // Classes cut by this frame's missing pixels split; a class is
        // then valid or missing as a whole.
        let active = self.refine(x);
        let ci = c[0];
        let (wo, so) = (g * n, g * n);
        let wc = w * ci;
        let (wg, sg) = (&mut self.w[wo..wo + n], &mut self.s[so..so + n]);
        if active.is_none() && ci != 0.0 {
            for i in 0..n {
                let v = x[i];
                wg[i] += wc * v;
                sg[i] += w * v;
            }
        } else if active.is_none() {
            for i in 0..n {
                sg[i] += w * x[i];
            }
        } else {
            for i in 0..n {
                let v = x[i];
                if v.is_finite() {
                    wg[i] += wc * v;
                    sg[i] += w * v;
                }
            }
        }
        let st = self.stride();
        let (cf, rf) = (f64::from(ci), f64::from(rho));
        for (k, m) in self.mom.iter_mut().enumerate() {
            if let Some(a) = &active {
                if !a[k] {
                    continue;
                }
            }
            let blk = &mut m[g * st..(g + 1) * st];
            blk[N] += wf;
            blk[N2] += wf * wf;
            blk[P] += wf * rf * cf;
            blk[PR] += wf * rf;
            for (j, &cj) in c.iter().enumerate() {
                if cj != 0.0 && self.near[j] {
                    let v = wf * f64::from(cj);
                    let o = HEAD + 2 * self.pos[j] as usize;
                    blk[o] += v;
                    blk[o + 1] += v * cf;
                }
            }
        }
        if ci != 0.0 {
            let fs = self.far_stride();
            let blk = &mut self.far[g * fs..(g + 1) * fs];
            blk[0] += wc;
            blk[1] += wc * ci;
            for (j, &cj) in c.iter().enumerate() {
                if cj != 0.0 && !self.near[j] {
                    let o = FAR_HEAD + 2 * self.pos[j] as usize;
                    blk[o] += w * cj;
                    blk[o + 1] += wc * cj;
                }
            }
        } else {
            // `b_k = Σ w c_i c_k` gains nothing; only `a_k` does.
            let fs = self.far_stride();
            let blk = &mut self.far[g * fs..(g + 1) * fs];
            for (j, &cj) in c.iter().enumerate() {
                if cj != 0.0 && !self.near[j] {
                    blk[FAR_HEAD + 2 * self.pos[j] as usize] += w * cj;
                }
            }
        }
    }

    /// Split every class that `x`'s missing pixels cut, so that each class
    /// is wholly valid or wholly missing; `None` when no pixel is missing,
    /// else whether each class is valid.
    fn refine(&mut self, x: &[f32]) -> Option<Vec<bool>> {
        if x.iter().all(|v| v.is_finite()) {
            return None;
        }
        let k = self.mom.len();
        let (mut all, mut ok) = (vec![0u32; k], vec![0u32; k]);
        for (i, &v) in x.iter().enumerate() {
            let c = self.cls[i] as usize;
            all[c] += 1;
            if v.is_finite() {
                ok[c] += 1;
            }
        }
        // Missing pixels of a cut class move to a copy of it.
        let mut to = vec![u32::MAX; k];
        for c in 0..k {
            if ok[c] > 0 && ok[c] < all[c] {
                to[c] = self.mom.len() as u32;
                self.mom.push(self.mom[c].clone());
            }
        }
        for (i, &v) in x.iter().enumerate() {
            let c = self.cls[i] as usize;
            if !v.is_finite() && to[c] != u32::MAX {
                self.cls[i] = to[c];
            }
        }
        let mut active: Vec<bool> = ok.iter().map(|&o| o > 0).collect();
        active.resize(self.mom.len(), false);
        Some(active)
    }

    /// Start the pixels `idx` (indices into `pix`) over: their sums are
    /// dropped and they form a fresh class with no frames (an epoch).
    pub fn restart(&mut self, idx: &[usize]) {
        if idx.is_empty() {
            return;
        }
        let n = self.pix.len();
        let new = self.mom.len() as u32;
        self.mom.push(vec![0.0; self.groups * self.stride()]);
        for &i in idx {
            self.cls[i] = new;
            for g in 0..self.groups {
                self.w[g * n + i] = 0.0;
                self.s[g * n + i] = 0.0;
            }
        }
        self.restarts += idx.len() as u64;
        self.compact();
    }

    /// Drop classes without pixels and renumber the rest in order.
    fn compact(&mut self) {
        let k = self.mom.len();
        let mut used = vec![false; k];
        for &c in &self.cls {
            used[c as usize] = true;
        }
        if used.iter().all(|&u| u) {
            return;
        }
        let mut map = vec![u32::MAX; k];
        let mut next = 0u32;
        let mut mom = Vec::with_capacity(k);
        for (c, m) in std::mem::take(&mut self.mom).into_iter().enumerate() {
            if used[c] {
                map[c] = next;
                next += 1;
                mom.push(m);
            }
        }
        self.mom = mom;
        for c in &mut self.cls {
            *c = map[*c as usize];
        }
    }

    /// The same statistics on a new disk: shared pixels keep their sums and
    /// class, new pixels form a fresh class (no frames yet).
    pub fn moved(&self, center: (f32, f32), radius: f32, pix: Vec<u32>) -> CellStats {
        let n = pix.len();
        let old_n = self.pix.len();
        let gs = self.groups;
        let mut out = CellStats {
            center,
            radius,
            cls: vec![u32::MAX; n],
            pix,
            nb: self.nb.clone(),
            near: self.near.clone(),
            groups: gs,
            w: vec![0.0; gs * n],
            s: vec![0.0; gs * n],
            mom: self.mom.clone(),
            far: self.far.clone(),
            tot: self.tot.clone(),
            restarts: self.restarts,
            pos: self.pos.clone(),
        };
        let mut j = 0;
        let mut fresh = Vec::new();
        for i in 0..n {
            let p = out.pix[i];
            while j < old_n && self.pix[j] < p {
                j += 1;
            }
            if j < old_n && self.pix[j] == p {
                out.cls[i] = self.cls[j];
                for g in 0..gs {
                    out.w[g * n + i] = self.w[g * old_n + j];
                    out.s[g * n + i] = self.s[g * old_n + j];
                }
            } else {
                fresh.push(i);
            }
        }
        if !fresh.is_empty() {
            let new = out.mom.len() as u32;
            out.mom.push(vec![0.0; gs * out.stride()]);
            for &i in &fresh {
                out.cls[i] = new;
            }
        }
        out.compact();
        out
    }

    /// Replace the neighbour list by `nb` (`nb[0]` the cell itself), with
    /// `near` saying which are near now: neighbours kept keep their moments
    /// (a near one stays near), new ones start at zero, the others are
    /// dropped. A far neighbour that becomes near gets class terms from the
    /// far approximation (module docs).
    pub fn set_neighbours(&mut self, nb: &[u64], near: &[bool]) {
        debug_assert_eq!(nb.first(), self.nb.first());
        debug_assert_eq!(nb.len(), near.len());
        let from: Vec<Option<usize>> = nb
            .iter()
            .map(|id| self.nb.iter().position(|o| o == id))
            .collect();
        let near: Vec<bool> = near
            .iter()
            .zip(&from)
            .enumerate()
            .map(|(k, (&n, f))| k == 0 || n || f.is_some_and(|j| self.near[j]))
            .collect();
        if nb == self.nb.as_slice() && near == self.near {
            return;
        }
        let gs = self.groups;
        let (old, old_f) = (self.stride(), self.far_stride());
        let (nn, nf) = (
            near.iter().filter(|&&n| n).count(),
            near.iter().filter(|&&n| !n).count(),
        );
        let (new, new_f) = (stride(nn), FAR_HEAD + 2 * nf);
        // Slopes of the far neighbours promoted now, over every group.
        let slope = self.far_slopes(ALL_GROUPS);
        for m in &mut self.mom {
            let mut out = vec![0.0; gs * new];
            for g in 0..gs {
                let (src, dst) = (&m[g * old..(g + 1) * old], &mut out[g * new..(g + 1) * new]);
                dst[..HEAD].copy_from_slice(&src[..HEAD]);
                let mut o = HEAD;
                for (k, f) in from.iter().enumerate() {
                    if !near[k] {
                        continue;
                    }
                    match *f {
                        Some(j) if self.near[j] => {
                            let s = HEAD + 2 * self.pos[j] as usize;
                            dst[o] = src[s];
                            dst[o + 1] = src[s + 1];
                        }
                        Some(j) => {
                            // Promoted: the class's own variance times the
                            // far slope, the far mean scaled to the class.
                            let (n, a0, b0) = (src[N], src[HEAD], src[HEAD + 1]);
                            let tot = self.tot[g];
                            if n > 0.0 && tot > 0.0 {
                                let fa = f64::from(
                                    self.far[g * old_f + FAR_HEAD + 2 * self.pos[j] as usize],
                                );
                                let ak = fa * n / tot;
                                dst[o] = ak;
                                dst[o + 1] = (b0 - a0 * a0 / n) * slope[j] + a0 * ak / n;
                            }
                        }
                        None => {}
                    }
                    o += 2;
                }
            }
            *m = out;
        }
        let mut far = vec![0.0f32; gs * new_f];
        for g in 0..gs {
            let (src, dst) = (
                &self.far[g * old_f..(g + 1) * old_f],
                &mut far[g * new_f..(g + 1) * new_f],
            );
            dst[..FAR_HEAD].copy_from_slice(&src[..FAR_HEAD]);
            let mut o = FAR_HEAD;
            for (k, f) in from.iter().enumerate() {
                if near[k] {
                    continue;
                }
                if let Some(j) = *f {
                    // Far before too (near stays near).
                    let s = FAR_HEAD + 2 * self.pos[j] as usize;
                    dst[o] = src[s];
                    dst[o + 1] = src[s + 1];
                }
                o += 2;
            }
        }
        self.far = far;
        self.nb = nb.to_vec();
        self.near = near;
        let ok = self.index();
        debug_assert!(ok);
    }

    /// Forget neighbour `k`'s trace history (its id now names a new
    /// column with a new trace: a merge or split result).
    pub fn zero_neighbour(&mut self, k: usize) {
        let o = 2 * self.pos[k] as usize;
        if self.near[k] {
            let st = self.stride();
            for m in &mut self.mom {
                for g in 0..self.groups {
                    m[g * st + HEAD + o] = 0.0;
                    m[g * st + HEAD + o + 1] = 0.0;
                }
            }
        } else {
            let fs = self.far_stride();
            for g in 0..self.groups {
                self.far[g * fs + FAR_HEAD + o] = 0.0;
                self.far[g * fs + FAR_HEAD + o + 1] = 0.0;
            }
        }
    }

    /// Scale every sum (renormalisation of the forgetting weights).
    pub fn scale(&mut self, f: f32) {
        self.w.iter_mut().for_each(|v| *v *= f);
        self.s.iter_mut().for_each(|v| *v *= f);
        self.far.iter_mut().for_each(|v| *v *= f);
        let ff = f64::from(f);
        let st = self.stride();
        for m in &mut self.mom {
            for (j, v) in m.iter_mut().enumerate() {
                *v *= if j % st == N2 { ff * ff } else { ff };
            }
        }
        self.tot.iter_mut().for_each(|v| *v *= ff);
    }

    /// The store with its groups summed into one group per mask of `masks`
    /// (what a visit job needs: e.g. [`HALVES`]). Its estimates over a
    /// set of new groups equal the full store's over the union of masks.
    pub fn reduced(&self, masks: &[GroupMask]) -> CellStats {
        let gs = masks.len();
        let n = self.pix.len();
        let sel = |m: GroupMask| (0..self.groups).filter(move |g| m & (1 << g) != 0);
        let sum32 = |v: &[f32], len: usize| {
            let mut out = vec![0.0f32; gs * len];
            for (j, &m) in masks.iter().enumerate() {
                for g in sel(m) {
                    for (o, &x) in out[j * len..(j + 1) * len]
                        .iter_mut()
                        .zip(&v[g * len..(g + 1) * len])
                    {
                        *o += x;
                    }
                }
            }
            out
        };
        let st = self.stride();
        let mom = self
            .mom
            .iter()
            .map(|m| {
                let mut out = vec![0.0f64; gs * st];
                for (j, &mk) in masks.iter().enumerate() {
                    for g in sel(mk) {
                        for (o, &x) in out[j * st..(j + 1) * st]
                            .iter_mut()
                            .zip(&m[g * st..(g + 1) * st])
                        {
                            *o += x;
                        }
                    }
                }
                out
            })
            .collect();
        CellStats {
            center: self.center,
            radius: self.radius,
            pix: self.pix.clone(),
            cls: self.cls.clone(),
            nb: self.nb.clone(),
            near: self.near.clone(),
            groups: gs,
            w: sum32(&self.w, n),
            s: sum32(&self.s, n),
            mom,
            far: sum32(&self.far, self.far_stride()),
            tot: masks
                .iter()
                .map(|&m| sel(m).map(|g| self.tot[g]).sum())
                .collect(),
            restarts: self.restarts,
            pos: self.pos.clone(),
        }
    }

    /// Bytes held (memory diagnostic).
    pub fn bytes(&self) -> usize {
        self.pix.len() * 4
            + self.cls.len() * 4
            + (self.w.len() + self.s.len()) * 4
            + self.nb.len() * (8 + 1 + 4)
            + self.mom.iter().map(|m| m.len() * 8).sum::<usize>()
            + self.far.len() * 4
            + self.tot.len() * 8
            + std::mem::size_of::<CellStats>()
    }

    /// Number of classes.
    pub fn classes(&self) -> usize {
        self.mom.len()
    }

    /// Number of near neighbours, the cell itself excluded (diagnostic).
    pub fn near_neighbours(&self) -> usize {
        self.n_near() - 1
    }

    /// The class moments summed over the groups of `mask`.
    fn class_sums(&self, c: usize, mask: GroupMask) -> Vec<f64> {
        let st = self.stride();
        let mut out = vec![0.0; st];
        for g in (0..self.groups).filter(|g| mask & (1 << g) != 0) {
            for (o, &v) in out.iter_mut().zip(&self.mom[c][g * st..(g + 1) * st]) {
                *o += v;
            }
        }
        out
    }

    /// The far slopes `β_k = C_ik / C_ii` over the groups of `mask`, every
    /// frame pushed (aligned with `nb`; 0 for near neighbours, or without
    /// own trace variance).
    fn far_slopes(&self, mask: GroupMask) -> Vec<f64> {
        let fs = self.far_stride();
        let mut sum = vec![0.0f64; fs];
        let mut n = 0.0f64;
        for g in (0..self.groups).filter(|g| mask & (1 << g) != 0) {
            n += self.tot[g];
            for (o, &v) in sum.iter_mut().zip(&self.far[g * fs..(g + 1) * fs]) {
                *o += f64::from(v);
            }
        }
        let mean = if n > 0.0 { sum[0] / n } else { 0.0 };
        let cii = sum[1] - sum[0] * mean;
        (0..self.nb.len())
            .map(|k| {
                if self.near[k] || !(cii > 0.0) {
                    return 0.0;
                }
                let o = FAR_HEAD + 2 * self.pos[k] as usize;
                (sum[o + 1] - sum[o] * mean) / cii
            })
            .collect()
    }

    /// The filtered-column estimate (2) of the cell on `pix` from the
    /// frames of the groups in `mask`, with the neighbours' current
    /// columns `cols` on `pix` (aligned with `nb`; `cols[0]`, the cell's
    /// own, is not read; an empty slice is a zero column) and the current
    /// ring coupling `q` (`(index into nb, q_ik)`). Pixels valid in too few
    /// of the frames (`MIN_VALID_SHARE`), or whose class has no trace
    /// variance, are 0; `None` when no pixel has an estimate. Far
    /// neighbours enter through their slopes (module docs).
    pub fn estimate(
        &self,
        mask: GroupMask,
        cols: &[&[f32]],
        q: &[(usize, f32)],
    ) -> Option<Vec<f32>> {
        debug_assert_eq!(cols.len(), self.nb.len());
        let n = self.pix.len();
        let nref: f64 = (0..self.groups)
            .filter(|g| mask & (1 << g) != 0)
            .map(|g| self.tot[g])
            .sum();
        let k = self.nb.len();
        let slope = self.far_slopes(mask);
        // The far terms per unit `C_ii`: the ring's constant, and the
        // per-pixel shift `Σ_far β_k g_k(p)` below.
        let far_ring: f64 = q
            .iter()
            .filter(|&&(j, _)| !self.near[j])
            .map(|&(j, qv)| f64::from(qv) * slope[j])
            .sum();
        let near: Vec<(usize, usize)> = (1..k)
            .filter(|&j| self.near[j])
            .map(|j| (j, HEAD + 2 * self.pos[j] as usize))
            .collect();
        // Per class: `[a_0 / n, R, C_ii]` and `C_ik` of the near ones, or
        // `None`.
        let classes: Vec<Option<(f64, f64, f64, Vec<f64>)>> = (0..self.mom.len())
            .map(|c| {
                let m = self.class_sums(c, mask);
                let (nn, n2) = (m[N], m[N2]);
                if !(nn > 0.0) || !(n2 > 0.0) || nn < MIN_VALID_SHARE * nref {
                    return None;
                }
                let mean = m[HEAD] / nn;
                let cii = m[HEAD + 1] - m[HEAD] * mean;
                if !(cii > 0.0) {
                    return None;
                }
                let cik: Vec<f64> = near.iter().map(|&(_, o)| m[o + 1] - m[o] * mean).collect();
                let (mut bb, mut br) = (m[P], m[PR]);
                for &(j, qv) in q {
                    if self.near[j] {
                        let o = HEAD + 2 * self.pos[j] as usize;
                        bb -= f64::from(qv) * m[o + 1];
                        br -= f64::from(qv) * m[o];
                    }
                }
                Some((mean, bb - br * mean - cii * far_ring, cii, cik))
            })
            .collect();
        if classes.iter().all(Option::is_none) {
            return None;
        }
        let far: Vec<(usize, f64)> = (1..k)
            .filter(|&j| !self.near[j] && slope[j] != 0.0)
            .map(|j| (j, slope[j]))
            .collect();
        let groups: Vec<usize> = (0..self.groups).filter(|g| mask & (1 << g) != 0).collect();
        let mut out = vec![0.0f32; n];
        for (i, o) in out.iter_mut().enumerate() {
            let Some((mean, ring, cii, cik)) = &classes[self.cls[i] as usize] else {
                continue;
            };
            let (mut w, mut s) = (0.0f64, 0.0f64);
            for &g in &groups {
                w += f64::from(self.w[g * n + i]);
                s += f64::from(self.s[g * n + i]);
            }
            let mut num = w - s * mean - ring;
            for (&(j, _), &c) in near.iter().zip(cik) {
                if let Some(&gv) = cols[j].get(i) {
                    if gv != 0.0 {
                        num -= f64::from(gv) * c;
                    }
                }
            }
            let mut shift = 0.0f64;
            for &(j, b) in &far {
                if let Some(&gv) = cols[j].get(i) {
                    shift += f64::from(gv) * b;
                }
            }
            *o = (num / cii - shift) as f32;
        }
        Some(out)
    }
}

/// Bytes of `s` on the wire (`Writer::cellstats`).
pub(crate) fn wire_bytes(s: &CellStats) -> usize {
    let n = s.pix.len();
    let nf = s.near.iter().filter(|&&v| !v).count();
    12 + (8 + 4 * n) * 2
        + 8
        + 8 * s.nb.len()
        + 8
        + 4 * (s.nb.len() - nf)
        + 8
        + (8 + 4 * s.groups * n) * 2
        + 8
        + s.mom.iter().map(|m| 8 + 8 * m.len()).sum::<usize>()
        + 8
        + 4 * s.far.len()
        + 8
        + 8 * s.groups
        + 8
}

/// Length of one group's moment block with `k` near neighbours (self
/// included).
fn stride(k: usize) -> usize {
    HEAD + 2 * k
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic standard-normal-ish samples.
    struct Rng(u64);
    impl Rng {
        fn u(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32) / (1u64 << 24) as f32
        }
        fn normal(&mut self) -> f32 {
            (0..12).map(|_| self.u()).sum::<f32>() - 6.0
        }
    }

    /// Sparse non-negative trace; with `with`, a share `rho` of another's.
    fn trace(r: &mut Rng, t: usize, with: Option<(&[f32], f32)>) -> Vec<f32> {
        let mut v = 0.0f32;
        (0..t)
            .map(|k| {
                v *= 0.85;
                if r.u() < 0.03 {
                    v += 2.0 + r.u();
                }
                match with {
                    Some((o, rho)) => rho * o[k] + (1.0 - rho) * v,
                    None => v,
                }
            })
            .collect()
    }

    /// A blob on `n` pixels of a 1-D strip, centred at `c`.
    fn blob(n: usize, c: f32, s: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let d = i as f32 - c;
                (-(d * d) / (2.0 * s * s)).exp()
            })
            .collect()
    }

    /// Weighted least squares from scratch at each pixel: regress
    /// `x(p) − Σ_{k≥1} g_k(p) c_k − β` on `c_0` (with intercept) over the
    /// frames in which the pixel is counted (`use_[t][p]`), weights `w`.
    #[allow(clippy::too_many_arguments)]
    fn scratch(
        x: &[Vec<f32>],
        c: &[Vec<f32>],
        cols: &[Vec<f32>],
        beta: &[f32],
        w: &[f32],
        use_: &dyn Fn(usize, usize) -> bool,
        n: usize,
    ) -> Vec<f32> {
        (0..n)
            .map(|p| {
                let (mut sw, mut sy, mut sc, mut scc, mut syc) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
                for t in 0..x.len() {
                    if !use_(t, p) {
                        continue;
                    }
                    let mut y = f64::from(x[t][p]) - f64::from(beta[t]);
                    for k in 1..c.len() {
                        y -= f64::from(cols[k][p]) * f64::from(c[k][t]);
                    }
                    let (wt, ct) = (f64::from(w[t]), f64::from(c[0][t]));
                    sw += wt;
                    sy += wt * y;
                    sc += wt * ct;
                    scc += wt * ct * ct;
                    syc += wt * y * ct;
                }
                ((syc - sy * sc / sw) / (scc - sc * sc / sw)) as f32
            })
            .collect()
    }

    fn max_err(a: &[f32], b: &[f32]) -> f32 {
        a.iter()
            .zip(b)
            .map(|(x, y)| (x - y).abs())
            .fold(0.0, f32::max)
    }

    /// Two cells and a ring: data, traces, columns, ring means.
    struct Scene {
        x: Vec<Vec<f32>>,
        c: Vec<Vec<f32>>,
        rho: Vec<f32>,
        n: usize,
    }

    fn scene(t: usize, cofire: f32) -> (Scene, Vec<Vec<f32>>) {
        let n = 40;
        let mut r = Rng(7);
        let ci = trace(&mut r, t, None);
        let cj = trace(&mut r, t, Some((&ci, cofire)));
        let truth = vec![blob(n, 15.0, 3.0), blob(n, 22.0, 3.0)];
        let mut x = Vec::with_capacity(t);
        let mut rho = Vec::with_capacity(t);
        for k in 0..t {
            let level = 0.5 + 0.3 * (k as f32 * 0.01).sin();
            x.push(
                (0..n)
                    .map(|p| truth[0][p] * ci[k] + truth[1][p] * cj[k] + level + 0.3 * r.normal())
                    .collect(),
            );
            rho.push(level + 0.1 * ci[k] + 0.2 * cj[k] + 0.05 * r.normal());
        }
        (
            Scene {
                x,
                c: vec![ci, cj],
                rho,
                n,
            },
            truth,
        )
    }

    fn fill(sc: &Scene, groups: &dyn Fn(usize) -> usize) -> CellStats {
        let mut st = CellStats::new(1, (0.0, 0.0), 30.0, (0..sc.n as u32).collect());
        st.set_neighbours(&[1, 2], &[true, true]);
        for t in 0..sc.x.len() {
            let c = [sc.c[0][t], sc.c[1][t]];
            st.push(&sc.x[t], groups(t), 1.0, &c, sc.rho[t]);
        }
        st
    }

    #[test]
    fn estimate_is_the_least_squares_fit_under_the_current_columns() {
        let (sc, truth) = scene(3000, 0.6);
        let st = fill(&sc, &|t| (t / 128) % GROUPS);
        let q = [0.1f32, 0.2];
        let beta: Vec<f32> = (0..sc.x.len())
            .map(|t| sc.rho[t] - q[0] * sc.c[0][t] - q[1] * sc.c[1][t])
            .collect();
        let w = vec![1.0; sc.x.len()];
        // Any neighbour column: the store's answer is the fit under it.
        for shift in [0.0f32, 3.0, -2.0] {
            let gj = blob(sc.n, 22.0 + shift, 3.0);
            let cols = vec![Vec::new(), gj.clone()];
            let est = st
                .estimate(ALL_GROUPS, &[&[], &gj], &[(0, q[0]), (1, q[1])])
                .unwrap();
            let want = scratch(&sc.x, &sc.c, &cols, &beta, &w, &|_, _| true, sc.n);
            assert!(
                max_err(&est, &want) < 2e-3,
                "shift {shift}: {}",
                max_err(&est, &want)
            );
        }
        // And under the true column it recovers the true footprint.
        let est = st
            .estimate(ALL_GROUPS, &[&[], &truth[1]], &[(0, q[0]), (1, q[1])])
            .unwrap();
        assert!(
            max_err(&est, &truth[0]) < 0.05,
            "{}",
            max_err(&est, &truth[0])
        );
    }

    #[test]
    fn groups_sum_to_the_totals() {
        let (sc, truth) = scene(2000, 0.5);
        let grouped = fill(&sc, &|t| (t / 128) % GROUPS);
        let single = fill(&sc, &|_| 0);
        let cols: [&[f32]; 2] = [&[], &truth[1]];
        let q = [(0usize, 0.1f32), (1, 0.2)];
        let a = grouped.estimate(ALL_GROUPS, &cols, &q).unwrap();
        let b = single.estimate(1, &cols, &q).unwrap();
        assert!(max_err(&a, &b) < 1e-4, "{}", max_err(&a, &b));
        // Every group's sums add up to the single store's.
        let n = sc.n;
        for i in 0..n {
            let w: f32 = (0..GROUPS).map(|g| grouped.w[g * n + i]).sum();
            assert!((w - single.w[i]).abs() <= 1e-3 * single.w[i].abs().max(1.0));
        }
        let (sg, ss) = (grouped.class_sums(0, ALL_GROUPS), single.class_sums(0, 1));
        for (x, y) in sg.iter().zip(&ss) {
            assert!((x - y).abs() <= 1e-9 * y.abs().max(1.0), "{x} {y}");
        }
        // A fold (a subset of groups) is the store of that fold's frames.
        let fold: GroupMask = 0b0101;
        let only = fill(&sc, &|t| {
            if fold & (1 << ((t / 128) % GROUPS)) != 0 {
                0
            } else {
                1
            }
        });
        let a = grouped.estimate(fold, &cols, &q).unwrap();
        let b = only.estimate(1, &cols, &q).unwrap();
        assert!(max_err(&a, &b) < 1e-4, "{}", max_err(&a, &b));
        // The complement too.
        let a = grouped.estimate(!fold, &cols, &q).unwrap();
        let b = only.estimate(2, &cols, &q).unwrap();
        assert!(max_err(&a, &b) < 1e-4, "{}", max_err(&a, &b));
    }

    #[test]
    fn ring_term_is_exact_through_a_neighbour_change() {
        // The background coupling q changes with the neighbour's column:
        // the estimate under the new q is the fit with the new level.
        let (sc, _) = scene(2500, 0.7);
        let st = fill(&sc, &|t| t % GROUPS);
        let w = vec![1.0; sc.x.len()];
        let gj = blob(sc.n, 24.0, 3.0);
        for q in [[0.1f32, 0.2], [0.05, 0.4], [0.0, 0.0]] {
            let beta: Vec<f32> = (0..sc.x.len())
                .map(|t| sc.rho[t] - q[0] * sc.c[0][t] - q[1] * sc.c[1][t])
                .collect();
            let est = st
                .estimate(ALL_GROUPS, &[&[], &gj], &[(0, q[0]), (1, q[1])])
                .unwrap();
            let want = scratch(
                &sc.x,
                &sc.c,
                &[Vec::new(), gj.clone()],
                &beta,
                &w,
                &|_, _| true,
                sc.n,
            );
            assert!(
                max_err(&est, &want) < 2e-3,
                "{q:?}: {}",
                max_err(&est, &want)
            );
        }
    }

    /// A band of missing pixels sweeping over the strip (#322's pattern),
    /// with a co-firing neighbour.
    fn missing(t: usize, p: usize) -> bool {
        let edge = 20.0 + 15.0 * (t as f32 * 0.013).sin();
        (p as f32) > edge && (p as f32) < edge + 6.0
    }

    #[test]
    fn validity_classes_match_the_per_pixel_fit() {
        let (mut sc, truth) = scene(4000, 0.8);
        for t in 0..sc.x.len() {
            for p in 0..sc.n {
                if missing(t, p) {
                    sc.x[t][p] = f32::NAN;
                }
            }
        }
        let st = fill(&sc, &|t| (t / 128) % GROUPS);
        assert!(st.classes() > 1 && st.classes() < sc.n, "{}", st.classes());
        let q = [0.1f32, 0.2];
        let beta: Vec<f32> = (0..sc.x.len())
            .map(|t| sc.rho[t] - q[0] * sc.c[0][t] - q[1] * sc.c[1][t])
            .collect();
        let w = vec![1.0; sc.x.len()];
        let cols = vec![Vec::new(), truth[1].clone()];
        let est = st
            .estimate(ALL_GROUPS, &[&[], &truth[1]], &[(0, q[0]), (1, q[1])])
            .unwrap();
        let want = scratch(&sc.x, &sc.c, &cols, &beta, &w, &|t, p| !missing(t, p), sc.n);
        let exact = max_err(&est, &want);
        assert!(exact < 2e-3, "classes vs per-pixel: {exact}");
        // The scaling approximation C_ij^(p) ≈ C_ij n_p / n (one class for
        // the cross terms) is worse when validity follows activity; report it.
        let mut approx = st.clone();
        for c in 1..approx.mom.len() {
            let full = approx.mom[0].clone();
            let st_ = approx.stride();
            for g in 0..GROUPS {
                let (nf, np) = (full[g * st_ + N], approx.mom[c][g * st_ + N]);
                let f = if nf > 0.0 { np / nf } else { 0.0 };
                for j in HEAD..st_ {
                    approx.mom[c][g * st_ + j] = full[g * st_ + j] * f;
                }
            }
        }
        let est2 = approx
            .estimate(ALL_GROUPS, &[&[], &truth[1]], &[(0, q[0]), (1, q[1])])
            .unwrap();
        let scaled = max_err(&est2, &want);
        eprintln!(
            "validity: classes {} max err {exact:.2e}; scaling approx {scaled:.2e}",
            st.classes()
        );
    }

    #[test]
    fn restart_drops_the_frames_before_a_birth() {
        // Cell j is born at frame t_b over part of i's region: before it
        // the model had no column j, so those frames carry j's light
        // unmodelled. A restart of the covered pixels is the fit of the
        // frames after the birth; other pixels keep every frame.
        let (sc, truth) = scene(4000, 0.8);
        let tb = 1500;
        let covered: Vec<usize> = (0..sc.n).filter(|&p| truth[1][p] > 0.05).collect();
        let mut st = CellStats::new(1, (0.0, 0.0), 30.0, (0..sc.n as u32).collect());
        let mut c_seen = sc.c.clone();
        for t in 0..sc.x.len() {
            if t == tb {
                st.set_neighbours(&[1, 2], &[true, true]);
                st.restart(&covered);
            }
            if t < tb {
                c_seen[1][t] = 0.0;
                st.push(&sc.x[t], t % GROUPS, 1.0, &[sc.c[0][t]], sc.rho[t]);
            } else {
                st.push(
                    &sc.x[t],
                    t % GROUPS,
                    1.0,
                    &[sc.c[0][t], sc.c[1][t]],
                    sc.rho[t],
                );
            }
        }
        assert_eq!(st.classes(), 2);
        let q = [(0usize, 0.1f32), (1, 0.2)];
        let beta: Vec<f32> = (0..sc.x.len())
            .map(|t| sc.rho[t] - 0.1 * c_seen[0][t] - 0.2 * c_seen[1][t])
            .collect();
        let est = st.estimate(ALL_GROUPS, &[&[], &truth[1]], &q).unwrap();
        let after = |t: usize, p: usize| t >= tb || !covered.contains(&p);
        let want = scratch(
            &sc.x,
            &c_seen,
            &[Vec::new(), truth[1].clone()],
            &beta,
            &vec![1.0; sc.x.len()],
            &after,
            sc.n,
        );
        assert!(max_err(&est, &want) < 2e-3, "{}", max_err(&est, &want));
        // The covered pixels carry no j-shaped bias; without the restart
        // they would.
        let bias = |e: &[f32]| {
            covered
                .iter()
                .map(|&p| (e[p] - truth[0][p]).abs())
                .fold(0.0, f32::max)
        };
        let mut norestart = CellStats::new(1, (0.0, 0.0), 30.0, (0..sc.n as u32).collect());
        for t in 0..sc.x.len() {
            if t == tb {
                norestart.set_neighbours(&[1, 2], &[true, true]);
            }
            let c: Vec<f32> = if t < tb {
                vec![sc.c[0][t]]
            } else {
                vec![sc.c[0][t], sc.c[1][t]]
            };
            norestart.push(&sc.x[t], t % GROUPS, 1.0, &c, sc.rho[t]);
        }
        let stale = norestart
            .estimate(ALL_GROUPS, &[&[], &truth[1]], &q)
            .unwrap();
        eprintln!(
            "restart: bias with {:.3}, without {:.3}",
            bias(&est),
            bias(&stale)
        );
        assert!(bias(&est) < 0.1, "{}", bias(&est));
        assert!(
            bias(&stale) > 2.0 * bias(&est),
            "{} {}",
            bias(&stale),
            bias(&est)
        );
    }

    #[test]
    fn moved_keeps_shared_pixels_and_starts_new_ones() {
        let (sc, truth) = scene(1000, 0.3);
        let st = fill(&sc, &|t| t % GROUPS);
        // Shift the region by 5 pixels: 35 shared, 5 new.
        let pix: Vec<u32> = (5..45).collect();
        let mv = st.moved((0.0, 5.0), 30.0, pix);
        assert_eq!(mv.classes(), 2);
        let n = 40;
        for i in 0..35 {
            for g in 0..GROUPS {
                assert_eq!(mv.w[g * n + i], st.w[g * n + i + 5]);
            }
        }
        // The new pixels have no frames: no estimate (0) yet.
        let gj: Vec<f32> = (5..45)
            .map(|p| if p < 40 { truth[1][p] } else { 0.0 })
            .collect();
        let e = mv.estimate(ALL_GROUPS, &[&[], &gj], &[]).unwrap();
        assert!(e[35..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn scale_preserves_the_estimate() {
        let (sc, truth) = scene(1500, 0.5);
        let mut st = fill(&sc, &|t| t % GROUPS);
        let cols: [&[f32]; 2] = [&[], &truth[1]];
        let a = st.estimate(ALL_GROUPS, &cols, &[(1, 0.2)]).unwrap();
        st.scale(1.0 / 1024.0);
        let b = st.estimate(ALL_GROUPS, &cols, &[(1, 0.2)]).unwrap();
        assert!(max_err(&a, &b) < 1e-4);
    }

    #[test]
    fn wire_round_trip() {
        use crate::discover::wire::{Reader, Writer};
        let (mut sc, _) = scene(800, 0.5);
        for t in 0..sc.x.len() {
            for p in 0..sc.n {
                if missing(t, p) {
                    sc.x[t][p] = f32::NAN;
                }
            }
        }
        let mut st = fill(&sc, &|t| (t / 128) % GROUPS);
        st.restart(&[1, 2, 3]);
        assert!(st.classes() > 2);
        let mut w = Writer::default();
        w.cellstats(&st);
        let mut r = Reader::new(&w.buf);
        assert_eq!(r.cellstats().as_ref(), Some(&st));
        assert!(r.done());
        // Truncated or inconsistent buffers are rejected.
        assert!(Reader::new(&w.buf[..w.buf.len() - 1]).cellstats().is_none());
        let mut bad = st.clone();
        bad.cls[0] = bad.mom.len() as u32;
        let mut w = Writer::default();
        w.cellstats(&bad);
        assert!(Reader::new(&w.buf).cellstats().is_none());
    }

    #[test]
    fn neighbour_list_changes_keep_moments() {
        let (sc, truth) = scene(1500, 0.5);
        let st = fill(&sc, &|t| t % GROUPS);
        let mut re = st.clone();
        re.set_neighbours(&[1, 9, 2], &[true; 3]);
        re.set_neighbours(&[1, 2], &[true, true]);
        assert_eq!(re, st);
        let mut z = st.clone();
        z.set_neighbours(&[1, 2, 9], &[true; 3]);
        let cols: [&[f32]; 3] = [&[], &truth[1], &[]];
        let a = st.estimate(ALL_GROUPS, &cols[..2], &[]).unwrap();
        let b = z.estimate(ALL_GROUPS, &cols, &[]).unwrap();
        assert!(max_err(&a, &b) < 1e-6);
        z.zero_neighbour(1);
        let c0 = z.class_sums(0, ALL_GROUPS);
        assert_eq!(c0[HEAD + 2], 0.0);
        assert_eq!(c0[HEAD + 3], 0.0);
    }

    /// The scene with the sweeping band of missing pixels, pushed into a
    /// store whose neighbour 2 is near or far; pixels 3..9 restart at
    /// frame `t_r` (a second epoch).
    fn edge_store(sc: &Scene, near2: bool, t_r: usize) -> CellStats {
        let mut st = CellStats::new(1, (0.0, 0.0), 30.0, (0..sc.n as u32).collect());
        st.set_neighbours(&[1, 2], &[true, near2]);
        for t in 0..sc.x.len() {
            if t == t_r {
                st.restart(&(3..9).collect::<Vec<_>>());
            }
            st.push(
                &sc.x[t],
                (t / 128) % GROUPS,
                1.0,
                &[sc.c[0][t], sc.c[1][t]],
                sc.rho[t],
            );
        }
        st
    }

    fn edge_scene() -> (Scene, Vec<Vec<f32>>) {
        let (mut sc, truth) = scene(4000, 0.8);
        for t in 0..sc.x.len() {
            for p in 0..sc.n {
                if missing(t, p) {
                    sc.x[t][p] = f32::NAN;
                }
            }
        }
        (sc, truth)
    }

    #[test]
    fn far_neighbours_follow_the_derived_error() {
        let (sc, _) = edge_scene();
        let exact = edge_store(&sc, true, 2500);
        let approx = edge_store(&sc, false, 2500);
        assert_eq!(exact.cls, approx.cls);
        assert_eq!(approx.near_neighbours(), 0);
        assert!(approx.bytes() < exact.bytes());
        // A moat-like column (small, negative, blocky) and a ring coupling.
        let moat: Vec<f32> = (0..sc.n).map(|p| -0.03 - 0.01 * (p / 8) as f32).collect();
        let cols: [&[f32]; 2] = [&[], &moat];
        let q = [(0usize, 0.1f32), (1, 0.2)];
        let e = exact.estimate(ALL_GROUPS, &cols, &q).unwrap();
        let a = approx.estimate(ALL_GROUPS, &cols, &q).unwrap();
        // approx − exact = (β^c − β)(g_k(p) − q_k), β^c the class's slope.
        let beta = approx.far_slopes(ALL_GROUPS)[1];
        let scale = max_err(&e, &vec![0.0; sc.n]);
        let (mut worst, mut seen) = (0.0f32, 0.0f32);
        for p in 0..sc.n {
            if e[p] == 0.0 {
                assert_eq!(a[p], 0.0);
                continue;
            }
            let m = exact.class_sums(exact.cls[p] as usize, ALL_GROUPS);
            let mean = m[HEAD] / m[N];
            let bc = (m[HEAD + 3] - m[HEAD + 2] * mean) / (m[HEAD + 1] - m[HEAD] * mean);
            let want = ((bc - beta) * f64::from(moat[p] - 0.2)) as f32;
            worst = worst.max((a[p] - e[p] - want).abs());
            seen = seen.max((a[p] - e[p]).abs());
        }
        assert!(worst < 1e-4 * scale, "derived error off by {worst}");
        // A class that counts every frame has no error.
        let full = (0..sc.n)
            .filter(|&p| !(0..sc.x.len()).any(|t| missing(t, p)) && !(3..9).contains(&p))
            .collect::<Vec<_>>();
        assert!(!full.is_empty());
        for &p in &full {
            assert!((a[p] - e[p]).abs() < 1e-5 * scale, "{p}");
        }
        eprintln!(
            "far approximation: max |error| {:.2e} of max |estimate| {scale:.2e} \
             (moat column, co-firing 0.8, sweeping band + restart)",
            seen
        );
    }

    #[test]
    fn promotion_seeds_from_the_far_terms() {
        // Neighbour 2 is far for the first half, then its support reaches
        // the region: the class terms start from the far approximation.
        let (sc, truth) = edge_scene();
        let exact = edge_store(&sc, true, usize::MAX);
        let far = edge_store(&sc, false, usize::MAX);
        let mut st = CellStats::new(1, (0.0, 0.0), 30.0, (0..sc.n as u32).collect());
        st.set_neighbours(&[1, 2], &[true, false]);
        let cols: [&[f32]; 2] = [&[], &truth[1]];
        let q = [(1usize, 0.2f32)];
        let tp = 2000;
        for t in 0..sc.x.len() {
            if t == tp {
                let before = st.estimate(ALL_GROUPS, &cols, &q).unwrap();
                st.set_neighbours(&[1, 2], &[true, true]);
                assert_eq!(st.near_neighbours(), 1);
                let after = st.estimate(ALL_GROUPS, &cols, &q).unwrap();
                let d = max_err(&before, &after) / max_err(&before, &vec![0.0; sc.n]);
                assert!(d < 0.02, "promotion moved the estimate by {d}");
                // Near stays near.
                st.set_neighbours(&[1, 2], &[true, false]);
                assert_eq!(st.near_neighbours(), 1);
            }
            st.push(
                &sc.x[t],
                (t / 128) % GROUPS,
                1.0,
                &[sc.c[0][t], sc.c[1][t]],
                sc.rho[t],
            );
        }
        let e = exact.estimate(ALL_GROUPS, &cols, &q).unwrap();
        let (dp, df) = (
            max_err(&st.estimate(ALL_GROUPS, &cols, &q).unwrap(), &e),
            max_err(&far.estimate(ALL_GROUPS, &cols, &q).unwrap(), &e),
        );
        // Both are the far approximation's size (the seeded half carries
        // it, the frames after the promotion are exact).
        let scale = max_err(&e, &vec![0.0; sc.n]);
        eprintln!("promotion: error {dp:.2e}, kept far {df:.2e}, of {scale:.2e}");
        assert!(dp < 1e-2 * scale && df < 1e-2 * scale, "{dp} {df}");
    }

    #[test]
    fn a_reduced_store_is_the_sum_of_its_groups() {
        let (sc, truth) = edge_scene();
        let st = edge_store(&sc, false, 2500);
        let r = st.reduced(&HALVES);
        assert_eq!(r.groups, 2);
        let cols: [&[f32]; 2] = [&[], &truth[1]];
        let q = [(0usize, 0.1f32), (1, 0.2)];
        for (h, &mask) in HALVES.iter().enumerate() {
            let a = r.estimate(1 << h, &cols, &q).unwrap();
            let b = st.estimate(mask, &cols, &q).unwrap();
            assert!(max_err(&a, &b) < 1e-5, "half {h}: {}", max_err(&a, &b));
        }
        let a = r.estimate(0b11, &cols, &q).unwrap();
        let b = st.estimate(ALL_GROUPS, &cols, &q).unwrap();
        assert!(max_err(&a, &b) < 1e-5, "{}", max_err(&a, &b));
        assert!(wire_bytes(&r) < wire_bytes(&st));
        // And it travels.
        use crate::discover::wire::{Reader, Writer};
        let mut w = Writer::default();
        w.cellstats(&r);
        assert_eq!(w.buf.len(), wire_bytes(&r));
        assert_eq!(Reader::new(&w.buf).cellstats().as_ref(), Some(&r));
    }
}
