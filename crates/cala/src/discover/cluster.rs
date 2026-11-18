//! Cluster history replay: a joint footprint update for overlapping cells
//! (`demix-bench/design_joint_update.md`, Stage 1; [`super::JointUpdate`]).
//!
//! A later-born neighbour is born from a residual that the older cell's
//! trace already explains, so it starts "bitten": without the light under
//! the older cell, whose trace carries a copy of the newcomer's events. A
//! regression of the data on the traces of the past (the per-cell running
//! statistics of `fpstats.rs`, or a joint CaImAn-style M-step alike)
//! reproduces that rotation exactly wherever both footprints are positive;
//! only traces re-solved with the current footprints pull it back, and the
//! running statistics re-solve only new frames, one half-life at a time.
//!
//! For a cluster of K overlapping cells this module keeps, per fitting
//! frame, the K numbers `v_t = Uᵀ r̃_t` of the cluster's whitened residual
//! (`r = y − model + Σ_members a_k c_k − ring level`) in the basis `U =
//! orth(CY)`, `CY = Σ w r̃ ĉᵀ`. `CY` lies in the span of the true
//! footprints whatever the traces' mixing, so the K numbers keep the
//! cluster's signal. A **replay** re-solves every stored frame's traces with
//! the current footprints (non-negative, in the K-dim space) and refits the
//! footprints jointly per pixel on those traces: one alternation of batch
//! NMF on the stored window, in bounded memory (K f32 per member per frame,
//! `stats_half_life_frames` fitting frames).

use std::collections::HashMap;

use super::fpstats::disk_pixels;
use super::local::{Cell, Fit, Problem};
use super::{column_on, paired_z, solve_dense, EditScope, Frames, JointUpdate, SlowLoop};
use crate::trace::{FrameTraces, Library};

/// The normalised whitened Gram overlaps `ρ_ij = G_ij / sqrt(G_ii G_jj)`
/// of the library's overlapping pairs (`i < j`, `ρ > 0`), in descending
/// `ρ` (ties by slot).
pub(crate) fn overlap_edges(lib: &Library) -> Vec<(f32, u32, u32)> {
    let mut e = Vec::new();
    for i in 0..lib.len() {
        let (cols, vals) = lib.gram.row(i);
        for (&j, &g) in cols.iter().zip(vals) {
            if (j as usize) <= i {
                continue;
            }
            let d = (f64::from(lib.gram_diag[i]) * f64::from(lib.gram_diag[j as usize])).sqrt();
            if d > 0.0 && g > 0.0 {
                e.push(((f64::from(g) / d) as f32, i as u32, j));
            }
        }
    }
    e.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    e
}

/// Union-find root with path halving.
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Clusters of `n` slots from `edges` (descending `ρ`): edges with `ρ ≥
/// rho_min` are joined greedily, strongest first (Kruskal), and a union
/// that would exceed `k_max` members is refused (`k_max` 0: no cap).
/// Returns the clusters of two or more slots (each sorted, in order of
/// their smallest slot) and the number of edges `≥ rho_min` left between
/// clusters by the cap.
pub(crate) fn greedy_clusters(
    n: usize,
    edges: &[(f32, u32, u32)],
    rho_min: f32,
    k_max: usize,
) -> (Vec<Vec<usize>>, usize) {
    let mut parent: Vec<usize> = (0..n).collect();
    let mut size = vec![1usize; n];
    for &(rho, i, j) in edges {
        if rho < rho_min {
            break;
        }
        let (a, b) = (root(&mut parent, i as usize), root(&mut parent, j as usize));
        if a == b || (k_max > 0 && size[a] + size[b] > k_max) {
            continue;
        }
        let (big, small) = if size[a] >= size[b] { (a, b) } else { (b, a) };
        parent[small] = big;
        size[big] += size[small];
    }
    let mut cut = 0;
    for &(rho, i, j) in edges {
        if rho < rho_min {
            break;
        }
        if root(&mut parent, i as usize) != root(&mut parent, j as usize) {
            cut += 1;
        }
    }
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut at = vec![usize::MAX; n];
    for s in 0..n {
        let r = root(&mut parent, s);
        if size[r] < 2 {
            continue;
        }
        if at[r] == usize::MAX {
            at[r] = groups.len();
            groups.push(Vec::new());
        }
        groups[at[r]].push(s);
    }
    (groups, cut)
}

/// The stored history of one cluster: per fitting frame, the coordinates
/// `v_t = Uᵀ r̃_t` of the cluster's whitened residual in the cluster's basis
/// `U`, with the frame's push index (its forgetting weight) and split-half
/// block. This is all the replay reads of past frames. [`RingHistory`] keeps
/// the coordinates themselves; another backing (a compressed store of the
/// frames that can project any past frame onto a new basis) can stand in
/// for it by implementing these methods.
pub(crate) trait ClusterHistory {
    /// Append one fitting frame: its coordinates `v` (length = the basis
    /// rank at the time), push index `at` and split-half block `half`.
    fn append(&mut self, v: &[f32], at: u64, half: bool);
    /// Re-express every stored frame in a new basis, `v ← R v` (`R` row
    /// major `r_new x r_old`, `R = U_newᵀ U_old`).
    fn reexpress(&mut self, r: &[f64], r_new: usize, r_old: usize);
    /// Stored frames.
    fn stored(&self) -> usize;
    /// Visit the stored frames, newest first: the first `rank` coordinates,
    /// the push index and the split-half block.
    fn for_each(&self, rank: usize, f: &mut dyn FnMut(&[f32], u64, bool));
    /// Bytes held.
    fn bytes(&self) -> usize;
}

/// [`ClusterHistory`] as a ring buffer of the coordinates (`cap` frames of
/// `width` f32 each, oldest dropped first).
#[derive(Debug, Clone)]
pub(crate) struct RingHistory {
    v: Vec<f32>,
    at: Vec<u64>,
    half: Vec<bool>,
    head: usize,
    len: usize,
    cap: usize,
    width: usize,
}

impl RingHistory {
    pub fn new(cap: usize, width: usize) -> RingHistory {
        RingHistory {
            v: vec![0.0; cap * width],
            at: vec![0; cap],
            half: vec![false; cap],
            head: 0,
            len: 0,
            cap,
            width,
        }
    }

    fn slot(&self, s: usize) -> usize {
        (self.head + self.cap - 1 - s) % self.cap
    }
}

impl ClusterHistory for RingHistory {
    fn append(&mut self, v: &[f32], at: u64, half: bool) {
        let w = self.width;
        let dst = &mut self.v[self.head * w..(self.head + 1) * w];
        dst.iter_mut().for_each(|x| *x = 0.0);
        dst[..v.len()].copy_from_slice(v);
        self.at[self.head] = at;
        self.half[self.head] = half;
        self.head = (self.head + 1) % self.cap;
        self.len = (self.len + 1).min(self.cap);
    }

    fn reexpress(&mut self, r: &[f64], r_new: usize, r_old: usize) {
        let w = self.width;
        let mut tmp = vec![0.0f64; r_new];
        for s in 0..self.len {
            let slot = self.slot(s);
            let vs = &mut self.v[slot * w..(slot + 1) * w];
            for (a, t) in tmp.iter_mut().enumerate() {
                *t = (0..r_old)
                    .map(|b| r[a * r_old + b] * f64::from(vs[b]))
                    .sum();
            }
            for (j, x) in vs.iter_mut().enumerate() {
                *x = if j < r_new { tmp[j] as f32 } else { 0.0 };
            }
        }
    }

    fn stored(&self) -> usize {
        self.len
    }

    fn for_each(&self, rank: usize, f: &mut dyn FnMut(&[f32], u64, bool)) {
        let w = self.width;
        for s in 0..self.len {
            let slot = self.slot(s);
            f(
                &self.v[slot * w..slot * w + rank],
                self.at[slot],
                self.half[slot],
            );
        }
    }

    fn bytes(&self) -> usize {
        self.v.len() * 4 + self.at.len() * 9
    }
}

/// The history store of one cluster (see the module docs).
#[derive(Debug, Clone)]
pub(crate) struct ClusterStore {
    /// Member cell ids (sorted).
    pub ids: Vec<u64>,
    /// Each member's disk the pixel set was built from (centre, radius).
    pub disks: Vec<((f32, f32), f32)>,
    /// Cluster pixels (sorted, FOV, positive whitening).
    pub pix: Vec<u32>,
    /// Whitening `1 / σ` per pixel.
    pub is: Vec<f32>,
    /// The member whose ring level is subtracted at each pixel (the largest
    /// column there; the nearest disk centre where no column is positive).
    pub owner: Vec<u8>,
    /// Bit `k`: member `k`'s disk covers the pixel (its footprint may be
    /// non-zero there).
    pub cover: Vec<u8>,
    /// Library version of `cols`, and the members' filtered columns on
    /// `pix` (member-major, unwhitened, moat included).
    pub version: u64,
    pub cols: Vec<f32>,
    /// Forgetting sums of the whitened residual: `Σ w r̃ ĉ_k` (pixel-major),
    /// `Σ w r̃`, `Σ w ĉ`, `Σ w ĉ_k²`, `Σ w`.
    cy: Vec<f32>,
    sr: Vec<f32>,
    sc: Vec<f64>,
    scc: Vec<f64>,
    sw: f64,
    /// Basis (pixel-major, `pix.len() x rank`).
    u: Vec<f64>,
    /// The basis again, member-major f32 (`rank x pix.len()`), for the
    /// per-frame projection.
    ut: Vec<f32>,
    rank: usize,
    /// The stored frames' coordinates in the basis (see [`ClusterHistory`]).
    hist: RingHistory,
    /// Frames pushed.
    pub k: u64,
}

/// What a replay gives each member, on the cluster's pixels: the estimate
/// (unwhitened filtered footprint, as `FpStats::estimate`), its split
/// halves, and their standard errors per unit pixel noise (joint
/// coefficients: the sandwich `M⁻¹ Q M⁻¹` of the weighted fit).
#[derive(Debug, Clone)]
pub(crate) struct Replay {
    pub h: Vec<Vec<f32>>,
    pub ha: Vec<Vec<f32>>,
    pub hb: Vec<Vec<f32>>,
    pub se: Vec<f64>,
    pub sa: Vec<f64>,
    pub sb: Vec<f64>,
    /// Stored frames replayed.
    pub frames: usize,
}

impl ClusterStore {
    /// An empty store on `pix` (sorted) for members `ids`, with `cols` the
    /// members' current filtered columns there (member-major) and `disks`
    /// their (margin-widened) statistics disks. Holds at most `cap` frames.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ids: Vec<u64>,
        disks: Vec<((f32, f32), f32)>,
        pix: Vec<u32>,
        is: Vec<f32>,
        width: usize,
        version: u64,
        cols: Vec<f32>,
        cap: usize,
    ) -> ClusterStore {
        let kk = ids.len();
        let n = pix.len();
        let mut owner = vec![0u8; n];
        let mut cover = vec![0u8; n];
        for (i, &p) in pix.iter().enumerate() {
            let (y, x) = ((p as usize / width) as f32, (p as usize % width) as f32);
            let mut best = (f32::NEG_INFINITY, f32::INFINITY, 0usize);
            for (k, &((cy, cx), r)) in disks.iter().enumerate() {
                let d2 = (y - cy).powi(2) + (x - cx).powi(2);
                if d2 <= r * r {
                    cover[i] |= 1 << k;
                }
                let c = cols[k * n + i];
                // Largest positive column; else nearest centre.
                let key = (c.max(0.0), d2);
                if key.0 > best.0 || (key.0 == best.0 && key.1 < best.1) {
                    best = (key.0, key.1, k);
                }
            }
            owner[i] = best.2 as u8;
        }
        let mut s = ClusterStore {
            ids,
            disks,
            pix,
            is,
            owner,
            cover,
            version,
            cols,
            cy: vec![0.0; n * kk],
            sr: vec![0.0; n],
            ut: Vec::new(),
            sc: vec![0.0; kk],
            scc: vec![0.0; kk],
            sw: 0.0,
            u: Vec::new(),
            rank: 0,
            hist: RingHistory::new(cap, kk),
            k: 0,
        };
        // The first basis is the members' current whitened columns (the
        // statistics have not accumulated yet).
        let a = s.white_cols();
        let (u, rank) = orth(&a, n, kk);
        s.set_basis(u, rank);
        s
    }

    fn set_basis(&mut self, u: Vec<f64>, rank: usize) {
        let n = self.pix.len();
        self.ut = (0..rank * n)
            .map(|x| u[(x % n) * rank + x / n] as f32)
            .collect();
        self.u = u;
        self.rank = rank;
    }

    pub fn members(&self) -> usize {
        self.ids.len()
    }

    /// Stored frames.
    pub fn stored(&self) -> usize {
        self.hist.stored()
    }

    /// Bytes held (for the memory report).
    pub fn bytes(&self) -> usize {
        self.hist.bytes()
            + (self.cy.len() + self.sr.len() + self.ut.len()) * 4
            + self.u.len() * 8
            + self.cols.len() * 4
            + self.pix.len() * 10
    }

    /// The members' current columns, whitened (pixel-major `n x K`).
    pub fn white_cols(&self) -> Vec<f64> {
        let (n, kk) = (self.pix.len(), self.ids.len());
        let mut a = vec![0.0f64; n * kk];
        for k in 0..kk {
            for i in 0..n {
                a[i * kk + k] = f64::from(self.cols[k * n + i]) * f64::from(self.is[i]);
            }
        }
        a
    }

    /// Whether every member's statistics disk `(center, radius)` still
    /// lies inside the disk the pixel set was built with.
    pub fn covers(&self, k: usize, center: (f32, f32), radius: f32) -> bool {
        let ((cy, cx), r) = self.disks[k];
        let d = ((center.0 - cy).powi(2) + (center.1 - cx).powi(2)).sqrt();
        d + radius <= r + 0.5
    }

    /// Scale the forgetting sums (renormalisation of the weights).
    pub fn scale(&mut self, f: f64) {
        let f32_ = f as f32;
        self.cy.iter_mut().for_each(|v| *v *= f32_);
        self.sr.iter_mut().for_each(|v| *v *= f32_);
        self.sc.iter_mut().for_each(|v| *v *= f);
        self.scc.iter_mut().for_each(|v| *v *= f);
        self.sw *= f;
    }

    /// Add one fitting frame: `r` the whitened cluster residual on `pix`
    /// (finite), `c` the members' fast-loop traces, `w` the forgetting
    /// weight of the running statistics.
    pub fn push(&mut self, r: &[f32], c: &[f32], w: f64) {
        let (n, kk) = (self.pix.len(), self.ids.len());
        debug_assert_eq!(r.len(), n);
        self.sw += w;
        for k in 0..kk {
            let ck = f64::from(c[k]);
            self.sc[k] += w * ck;
            self.scc[k] += w * ck * ck;
        }
        // Member-major axpy / dot loops (vectorise).
        let wf = w as f32;
        for (s, &x) in self.sr.iter_mut().zip(r) {
            *s += wf * x;
        }
        for k in 0..kk {
            let a = wf * c[k];
            if a != 0.0 {
                for (s, &x) in self.cy[k * n..(k + 1) * n].iter_mut().zip(r) {
                    *s += a * x;
                }
            }
        }
        let v: Vec<f32> = (0..self.rank)
            .map(|j| {
                self.ut[j * n..(j + 1) * n]
                    .iter()
                    .zip(r)
                    .map(|(u, x)| u * x)
                    .sum()
            })
            .collect();
        self.hist
            .append(&v, self.k, (self.k / 256).is_multiple_of(2));
        self.k += 1;
    }

    /// Refresh the basis to `orth(CY)` (centred; a member whose trace has no
    /// variance yet keeps its current column) and re-express the stored
    /// frames in it, `V ← U'ᵀ U V`.
    fn refresh_basis(&mut self) {
        let (n, kk) = (self.pix.len(), self.ids.len());
        let a = self.white_cols();
        let mut b = vec![0.0f64; n * kk];
        for k in 0..kk {
            let var = if self.sw > 0.0 {
                self.scc[k] - self.sc[k] * self.sc[k] / self.sw
            } else {
                0.0
            };
            let use_cy = var > 0.0;
            for i in 0..n {
                b[i * kk + k] = if use_cy {
                    f64::from(self.cy[k * n + i]) - f64::from(self.sr[i]) * self.sc[k] / self.sw
                } else {
                    a[i * kk + k]
                };
            }
        }
        let (u2, r2) = orth(&b, n, kk);
        // R = U'ᵀ U (r2 x rank).
        let mut rm = vec![0.0f64; r2 * self.rank];
        for i in 0..n {
            for a_ in 0..r2 {
                let x = u2[i * r2 + a_];
                for b_ in 0..self.rank {
                    rm[a_ * self.rank + b_] += x * self.u[i * self.rank + b_];
                }
            }
        }
        self.hist.reexpress(&rm, r2, self.rank);
        self.set_basis(u2, r2);
    }

    /// One alternation on the stored window (see the module docs): refresh
    /// the basis, re-solve every stored frame's traces with the current
    /// columns (non-negative), refit the footprints jointly per pixel
    /// (each pixel over the members whose disk covers it). `gamma` is the
    /// per-frame forgetting factor. `None` when too few frames are stored
    /// or a trace has no variance.
    /// With `sign_rule`, a member's coefficient is kept ≥ 0 at the pixels
    /// where its current filtered column is positive (its own light; the
    /// high-pass moat, negative in filtered space, stays free).
    /// `iters` alternations are run on the store (the design: 1).
    pub fn replay(&mut self, gamma: f64, sign_rule: bool, iters: usize) -> Option<Replay> {
        let (n, kk) = (self.pix.len(), self.ids.len());
        if self.hist.stored() < 4 * (kk + 1) || self.sw <= 0.0 {
            return None;
        }
        self.refresh_basis();
        let r = self.rank;
        if r == 0 {
            return None;
        }
        // The stored frames: coordinates, forgetting weights, halves.
        let m = self.hist.stored();
        let mut ws = vec![0.0f64; m];
        let mut hs = vec![false; m];
        let mut vv = vec![0.0f64; m * r];
        let now = self.k - 1;
        let mut s = 0usize;
        self.hist.for_each(r, &mut |vs, at, half| {
            ws[s] = gamma.powf((now - at) as f64);
            hs[s] = half;
            for j in 0..r {
                vv[s * r + j] = f64::from(vs[j]);
            }
            s += 1;
        });
        // Trace step on every stored frame, with the current columns.
        let mut cs = solve_traces(&self.white_cols(), &self.u, n, kk, r, &vv)?;
        // Footprint step per subset of frames: all, half A, half B.
        let fit = |cs: &[f64], sel: &dyn Fn(usize) -> bool| -> Option<(Vec<Vec<f32>>, Vec<f64>)> {
            let (mut sw, mut sc, mut sv) = (0.0f64, vec![0.0f64; kk], vec![0.0f64; r]);
            for s in 0..m {
                if sel(s) {
                    sw += ws[s];
                    for p in 0..kk {
                        sc[p] += ws[s] * cs[s * kk + p];
                    }
                    for j in 0..r {
                        sv[j] += ws[s] * vv[s * r + j];
                    }
                }
            }
            if !(sw > 0.0) {
                return None;
            }
            sc.iter_mut().for_each(|x| *x /= sw);
            sv.iter_mut().for_each(|x| *x /= sw);
            let mut mr = vec![0.0f64; kk * kk];
            let mut q = vec![0.0f64; kk * kk];
            let mut wv = vec![0.0f64; r * kk];
            for s in 0..m {
                if !sel(s) {
                    continue;
                }
                let w = ws[s];
                for p in 0..kk {
                    let dp = cs[s * kk + p] - sc[p];
                    for q_ in 0..kk {
                        let d = dp * (cs[s * kk + q_] - sc[q_]);
                        mr[p * kk + q_] += w * d;
                        q[p * kk + q_] += w * w * d;
                    }
                    for j in 0..r {
                        wv[j * kk + p] += w * (vv[s * r + j] - sv[j]) * dp;
                    }
                }
            }
            // Standard errors from the full set: diag(M⁻¹ Q M⁻¹).
            let minv = inverse(&mr, kk)?;
            let mut se = vec![0.0f64; kk];
            for k in 0..kk {
                let mut acc = 0.0;
                for p in 0..kk {
                    for q_ in 0..kk {
                        acc += minv[k * kk + p] * q[p * kk + q_] * minv[q_ * kk + k];
                    }
                }
                se[k] = acc.max(0.0).sqrt();
            }
            // Per pixel: rhs = U_p Wv, solved over the covering members.
            let mut inv_by_mask: Vec<Option<Vec<f64>>> = vec![None; 1 << kk];
            let mut h = vec![vec![0.0f32; n]; kk];
            let mut rhs = vec![0.0f64; kk];
            for i in 0..n {
                let mask = self.cover[i] as usize;
                if mask == 0 {
                    continue;
                }
                let idx: Vec<usize> = (0..kk).filter(|&k| mask & (1 << k) != 0).collect();
                if inv_by_mask[mask].is_none() {
                    let ns = idx.len();
                    let mut sub = vec![0.0f64; ns * ns];
                    for (a_, &p) in idx.iter().enumerate() {
                        for (b_, &q_) in idx.iter().enumerate() {
                            sub[a_ * ns + b_] = mr[p * kk + q_];
                        }
                    }
                    inv_by_mask[mask] = Some(inverse(&sub, idx.len())?);
                }
                let inv = inv_by_mask[mask].as_ref().expect("set");
                let ur = &self.u[i * r..(i + 1) * r];
                for (a_, &p) in idx.iter().enumerate() {
                    rhs[a_] = (0..r).map(|j| ur[j] * wv[j * kk + p]).sum();
                }
                let ns = idx.len();
                let is = f64::from(self.is[i]);
                let mut x: Vec<f64> = (0..ns)
                    .map(|a_| (0..ns).map(|b_| inv[a_ * ns + b_] * rhs[b_]).sum())
                    .collect();
                if sign_rule {
                    let lo: Vec<bool> = idx.iter().map(|&p| self.cols[p * n + i] > 0.0).collect();
                    if x.iter().zip(&lo).any(|(&v, &l)| l && v < 0.0) {
                        let mut sub = vec![0.0f64; ns * ns];
                        for (a_, &p) in idx.iter().enumerate() {
                            for (b_, &q_) in idx.iter().enumerate() {
                                sub[a_ * ns + b_] = mr[p * kk + q_];
                            }
                        }
                        bounded_ls(&sub, &rhs[..ns], &lo, ns, &mut x);
                    }
                }
                for (a_, &p) in idx.iter().enumerate() {
                    h[p][i] = (x[a_] / is) as f32;
                }
            }
            Some((h, se))
        };
        // Further alternations inside the store (diagnostic; 1 = the
        // design's one alternation per visit): the joint estimate becomes
        // the columns the traces are re-solved with.
        for _ in 1..iters.max(1) {
            let (h, _) = fit(&cs, &|_| true)?;
            let mut a = vec![0.0f64; n * kk];
            for k in 0..kk {
                for i in 0..n {
                    a[i * kk + k] = f64::from(h[k][i]) * f64::from(self.is[i]);
                }
            }
            cs = solve_traces(&a, &self.u, n, kk, r, &vv)?;
        }
        let (h, se) = fit(&cs, &|_| true)?;
        let (ha, sa) = fit(&cs, &|s| hs[s])?;
        let (hb, sb) = fit(&cs, &|s| !hs[s])?;
        Some(Replay {
            h,
            ha,
            hb,
            se,
            sa,
            sb,
            frames: m,
        })
    }
}

impl SlowLoop {
    /// Whether the joint update runs now ([`JointUpdate`], the edit scope).
    pub(super) fn joint_active(&self) -> bool {
        match self.cfg.joint_update {
            JointUpdate::Off => false,
            JointUpdate::Refine => self.scope == EditScope::Refine,
            JointUpdate::All => true,
        }
    }

    pub(super) fn clear_clusters(&mut self) {
        self.clusters.clear();
        self.cluster_of.clear();
        self.cluster_ids.clear();
        self.cluster_ok.clear();
    }

    /// A fresh store for the members `ids` (published in `lib`), on the
    /// union of their statistics disks widened by the statistics margin.
    fn new_store(&self, lib: &Library, ids: Vec<u64>) -> Option<ClusterStore> {
        let margin = self.cfg.stats_margin_cells * self.cfg.cell_diameter_px;
        let (width, height) = (self.dims.width, self.dims.height);
        let mut disks = Vec::with_capacity(ids.len());
        let mut pix: Vec<u32> = Vec::new();
        for id in &ids {
            let st = self.fpstats.get(id)?;
            let disk = (st.center, st.radius + margin);
            pix.extend(disk_pixels(disk.0, disk.1, width, height, &self.fov));
            disks.push(disk);
        }
        pix.sort_unstable();
        pix.dedup();
        pix.retain(|&p| self.inv_sigma[p as usize] > 0.0);
        if pix.is_empty() {
            return None;
        }
        let is: Vec<f32> = pix.iter().map(|&p| self.inv_sigma[p as usize]).collect();
        let mut cols = Vec::with_capacity(ids.len() * pix.len());
        for id in &ids {
            cols.extend(column_on(lib, lib.slot(*id)?, &pix));
        }
        let cap = self.cfg.stats_half_life_frames.ceil().max(1.0) as usize;
        Some(ClusterStore::new(
            ids,
            disks,
            pix,
            is,
            width,
            lib.version(),
            cols,
            cap,
        ))
    }

    /// Clusters of the library's cells (greedy, `cluster_rho_min`,
    /// `cluster_max`). A store whose member set is unchanged is kept.
    fn build_clusters(&mut self, lib: &Library) {
        let edges = overlap_edges(lib);
        let (groups, _) = greedy_clusters(
            lib.len(),
            &edges,
            self.cfg.cluster_rho_min,
            self.cfg.cluster_max,
        );
        let mut old: HashMap<Vec<u64>, (ClusterStore, bool)> = self
            .clusters
            .drain(..)
            .zip(self.cluster_ok.drain(..))
            .map(|(c, ok)| (c.ids.clone(), (c, ok)))
            .collect();
        self.cluster_of.clear();
        let ids = lib.ids();
        for g in groups {
            let mut m: Vec<u64> = g.iter().map(|&s| ids[s]).collect();
            m.sort_unstable();
            let (store, ok) = match old.remove(&m) {
                Some(kept) => kept,
                None => match self.new_store(lib, m.clone()) {
                    Some(s) => (s, false),
                    None => continue,
                },
            };
            for &id in &m {
                self.cluster_of.insert(id, self.clusters.len());
            }
            self.replay_stats.clusters += 1;
            self.replay_stats.members += m.len() as u64;
            self.clusters.push(store);
            self.cluster_ok.push(ok);
        }
        self.replay_stats.builds += 1;
        self.cluster_ids = ids.to_vec();
        self.cluster_ids.sort_unstable();
    }

    /// The clusters' part of a fitting frame (after the per-cell
    /// statistics, whose disks it reads): each cluster's whitened residual
    /// `y − model − ring level + Σ_members a_k c_k` on its pixels is
    /// accumulated. Returns the work done.
    pub(super) fn update_clusters(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        w: f32,
        ring: bool,
    ) -> u64 {
        if !self.joint_active() {
            return 0;
        }
        let mut sorted = lib.ids().to_vec();
        sorted.sort_unstable();
        if sorted != self.cluster_ids {
            self.build_clusters(lib);
        }
        let version = lib.version();
        let mut work = 0u64;
        let mut cbuf = std::mem::take(&mut self.cbuf);
        for ci in 0..self.clusters.len() {
            let slots: Option<Vec<usize>> = self.clusters[ci]
                .ids
                .iter()
                .map(|&id| lib.slot(id))
                .collect();
            let Some(slots) = slots else {
                continue;
            };
            // A member's statistics disk outside the cluster's pixels:
            // start the store over on the current disks.
            let covered = self.clusters[ci].ids.iter().enumerate().all(|(k, id)| {
                self.fpstats
                    .get(id)
                    .is_some_and(|st| self.clusters[ci].covers(k, st.center, st.radius))
            });
            if !covered {
                if let Some(s) = self.new_store(lib, self.clusters[ci].ids.clone()) {
                    self.clusters[ci] = s;
                    self.cluster_ok[ci] = false;
                    self.replay_stats.restarts += 1;
                }
            }
            let st = &mut self.clusters[ci];
            let n = st.pix.len();
            if st.version != version {
                st.cols.clear();
                for &s in &slots {
                    st.cols.extend(column_on(lib, s, &st.pix));
                }
                st.version = version;
            }
            let c: Vec<f32> = slots.iter().map(|&s| traces.traces[s]).collect();
            let lv: Vec<f32> = slots
                .iter()
                .map(|&s| if ring { traces.background[s] } else { 0.0 })
                .collect();
            cbuf.clear();
            cbuf.extend(
                st.pix
                    .iter()
                    .zip(&st.owner)
                    .map(|(&p, &o)| frame[p as usize] - self.model[p as usize] - lv[o as usize]),
            );
            for (k, &ck) in c.iter().enumerate() {
                if ck != 0.0 {
                    for (r, &a) in cbuf.iter_mut().zip(&st.cols[k * n..(k + 1) * n]) {
                        *r += a * ck;
                    }
                }
            }
            for (r, &is) in cbuf.iter_mut().zip(&st.is) {
                *r *= is;
            }
            let ok = cbuf.iter().all(|v| v.is_finite());
            if !ok || !c.iter().all(|v| v.is_finite()) {
                self.replay_stats.skipped_frames += 1;
                continue;
            }
            st.push(&cbuf, &c, f64::from(w));
            work += (n * (3 * c.len() + 3)) as u64;
        }
        self.cbuf = cbuf;
        let bytes: usize = self.clusters.iter().map(|c| c.bytes()).sum();
        self.replay_stats.peak_bytes = self.replay_stats.peak_bytes.max(bytes as u64);
        work
    }

    /// The joint refinement of the clusters this visit owns (see
    /// [`JointUpdate`]): a cluster belongs to the tile whose core holds its
    /// first member's centre. Its stored history is replayed; each member
    /// whose joint estimate is significant goes through the same finish
    /// path (support, inversion) as a per-cell proposal, and the members'
    /// new columns are gated together (paired held-out gain over the
    /// current model, above `refine_z`), so a rotation between two cells is
    /// never accepted one leg at a time. Accepted members are pushed to
    /// `updates`. Returns the cells of the tile the per-cell refinement
    /// must skip (members of clusters with a usable replay).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn refine_clusters(
        &mut self,
        ti: usize,
        base: &Problem,
        test_fr: &Frames,
        base_test: &[Fit],
        chi_base: f64,
        s2: f64,
        updates: &mut Vec<(u64, Cell, f32, u64)>,
    ) -> Vec<u64> {
        if !self.joint_active() || self.clusters.is_empty() {
            return Vec::new();
        }
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let w = self.dims.width;
        let gamma = f64::from(self.stats_gamma);
        let in_rect = |c: (f32, f32)| rect.local(c.0 as usize, c.1 as usize).is_some();
        let tile_ids: Vec<u64> = (0..base.len()).map(|i| base.cols[i].id).collect();
        let mut owned: Vec<usize> = Vec::new();
        for &id in &tile_ids {
            let Some(&ci) = self.cluster_of.get(&id) else {
                continue;
            };
            if self.clusters[ci].ids[0] != id || owned.contains(&ci) {
                continue;
            }
            let Some(cell) = self.cells.iter().find(|c| c.id == id) else {
                continue;
            };
            if core
                .local(cell.center.0 as usize, cell.center.1 as usize)
                .is_some()
            {
                owned.push(ci);
            }
        }
        for ci in owned {
            let ids = self.clusters[ci].ids.clone();
            let cells: Option<Vec<Cell>> = ids
                .iter()
                .map(|id| self.cells.iter().find(|c| c.id == *id).cloned())
                .collect();
            let Some(cells) = cells.filter(|cs| cs.iter().all(|c| in_rect(c.center))) else {
                self.cluster_ok[ci] = false;
                continue;
            };
            self.replay_stats.replays += 1;
            let st = &mut self.clusters[ci];
            let n = st.pix.len();
            let kk = ids.len();
            self.work += (st.stored() * kk * (kk + 8) + n * kk * kk * 4) as u64;
            let Some(rep) = st.replay(gamma, self.cfg.joint_sign_rule, self.cfg.joint_iters) else {
                self.replay_stats.replay_none += 1;
                self.cluster_ok[ci] = false;
                continue;
            };
            let cpix = self.clusters[ci].pix.clone();
            // Each member's estimate on its own statistics disk.
            let mut props: Vec<(usize, Vec<u32>, Vec<f32>, Vec<f32>, Vec<f32>)> = Vec::new();
            for (k, id) in ids.iter().enumerate() {
                let Some(st) = self.fpstats.get(id) else {
                    continue;
                };
                let pick = |v: &[f32]| -> Vec<f32> {
                    st.pix
                        .iter()
                        .map(|p| cpix.binary_search(p).map_or(0.0, |i| v[i]))
                        .collect()
                };
                let h = pick(&rep.h[k]);
                let peak = h
                    .iter()
                    .zip(&st.pix)
                    .map(|(&v, &p)| v * self.inv_sigma[p as usize])
                    .fold(0.0f32, f32::max);
                if f64::from(peak) >= f64::from(self.cfg.stats_min_snr) * rep.se[k] {
                    props.push((k, st.pix.clone(), h, pick(&rep.ha[k]), pick(&rep.hb[k])));
                }
            }
            if props.is_empty() {
                self.replay_stats.low_snr += 1;
                self.cluster_ok[ci] = false;
                continue;
            }
            self.cluster_ok[ci] = true;
            let excess: f64 = props
                .iter()
                .map(|(k, pix, h, ha, hb)| self.half_excess(&cells[*k], pix, h, ha, hb))
                .sum();
            if !(excess > 0.0) {
                self.replay_stats.converged += 1;
                continue;
            }
            let mut news: Vec<Cell> = Vec::new();
            for (k, pix, h, ha, hb) in props {
                self.fast_tmp = None;
                self.support_tmp = Some((pix.clone(), ha, hb, rep.sa[k], rep.sb[k]));
                let new = self.make_cell_global(ids[k], &pix, &h, Some(&cells[k]), Some(rep.se[k]));
                self.support_tmp = None;
                if let Some(mut new) = new {
                    new.born = cells[k].born;
                    news.push(new);
                }
            }
            #[cfg(feature = "diagnostics")]
            dump_replay(self, &cells, &cpix, &rep);
            if news.is_empty() {
                continue;
            }
            self.replay_stats.proposals += 1;
            let skip: Vec<u64> = news.iter().map(|c| c.id).collect();
            let refs: Vec<&Cell> = news.iter().collect();
            let cols = self.columns(rect, &skip, &refs);
            let pr = self.problem(ti, cols);
            let f = self.solve_all(&pr, test_fr);
            let gain = (chi_base - SlowLoop::total_chi2(&f)) / s2;
            let z = paired_z(base_test, &f);
            let accepted = gain > 0.0 && z > f64::from(self.cfg.refine_z);
            if accepted {
                self.replay_stats.accepted += 1;
                self.replay_stats.members_replaced += news.len() as u64;
                for new in news {
                    updates.push((new.id, new, z as f32, 3));
                }
            }
        }
        let _ = w;
        tile_ids
            .into_iter()
            .filter(|id| {
                self.cluster_of
                    .get(id)
                    .is_some_and(|&ci| self.cluster_ok[ci])
            })
            .collect()
    }

    /// Cluster census of `lib` for the design's Stage 0: per `rho_min`, the
    /// sizes of the uncut connected components and of the clusters cut to
    /// `k_max`, and for cell pairs closer than one cell diameter the share
    /// whose overlap reaches `rho_min` and the share of those left in one
    /// cluster. Also `ρ` by centre distance (in cell diameters).
    pub fn cluster_census(&self, lib: &Library, rho_mins: &[f32], k_max: usize) -> String {
        use std::fmt::Write;
        let edges = overlap_edges(lib);
        let d = self.cfg.cell_diameter_px;
        let dist = |i: u32, j: u32| {
            let (a, _) = lib.support(i as usize);
            let (b, _) = lib.support(j as usize);
            ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt() / d
        };
        let n = lib.len();
        let mut out = String::new();
        let _ = writeln!(
            out,
            "cluster census: {n} cells, {} overlapping pairs, D {d} px",
            edges.len()
        );
        // Pairs closer than 1 D (centre distance), all of them.
        let mut close = 0usize;
        for i in 0..n {
            for j in i + 1..n {
                if dist(i as u32, j as u32) < 1.0 {
                    close += 1;
                }
            }
        }
        let hist = |groups: &[Vec<usize>]| {
            let mut h = std::collections::BTreeMap::new();
            for g in groups {
                *h.entry(g.len()).or_insert(0usize) += 1;
            }
            let clustered: usize = groups.iter().map(|g| g.len()).sum();
            let s: Vec<String> = h.iter().map(|(k, v)| format!("{k}:{v}")).collect();
            format!("{} clustered cells, sizes {}", clustered, s.join(" "))
        };
        for &rho in rho_mins {
            let (uncut, _) = greedy_clusters(n, &edges, rho, 0);
            let (cut, ncut) = greedy_clusters(n, &edges, rho, k_max);
            let mut lab = vec![usize::MAX; n];
            for (g, m) in cut.iter().enumerate() {
                for &s in m {
                    lab[s] = g;
                }
            }
            let (mut close_edge, mut close_kept) = (0usize, 0usize);
            for &(r, i, j) in &edges {
                if r >= rho && dist(i, j) < 1.0 {
                    close_edge += 1;
                    if lab[i as usize] != usize::MAX && lab[i as usize] == lab[j as usize] {
                        close_kept += 1;
                    }
                }
            }
            // Members of clusters within K_max for 99 %.
            let mut sizes: Vec<usize> = uncut.iter().flat_map(|g| vec![g.len(); g.len()]).collect();
            sizes.sort_unstable();
            let p99 = sizes
                .get(sizes.len().saturating_sub(1) * 99 / 100)
                .copied()
                .unwrap_or(0);
            let _ = writeln!(
                out,
                "  rho >= {rho}: uncut {} (p99 member's component {p99}); cut to {k_max}: {} ({ncut} edges cut); pairs < 1 D: {close}, with rho >= {rho}: {close_edge}, in one cluster: {close_kept}",
                hist(&uncut),
                hist(&cut),
            );
        }
        let bins = [0.0f32, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
        let _ = writeln!(
            out,
            "  rho by centre distance (D): bin n median p10 p90 share>=0.05"
        );
        for b in bins.windows(2) {
            let mut v: Vec<f32> = edges
                .iter()
                .filter(|&&(_, i, j)| {
                    let x = dist(i, j);
                    x >= b[0] && x < b[1]
                })
                .map(|e| e.0)
                .collect();
            if v.is_empty() {
                continue;
            }
            v.sort_by(f32::total_cmp);
            let q = |p: f32| v[((v.len() - 1) as f32 * p) as usize];
            let share = v.iter().filter(|&&r| r >= 0.05).count() as f32 / v.len() as f32;
            let _ = writeln!(
                out,
                "    {:.2}-{:.2}: {} {:.3} {:.3} {:.3} {:.2}",
                b[0],
                b[1],
                v.len(),
                q(0.5),
                q(0.1),
                q(0.9),
                share
            );
        }
        out
    }
}

/// DIAG (`CALA_REPLAY_DUMP=path`): per replay, each pair of members, the
/// replayed raw estimate of member i at member j's centre over its own
/// peak, next to the same ratio of i's per-cell statistics estimate and of
/// i's current filtered column.
#[cfg(feature = "diagnostics")]
fn dump_replay(slow: &SlowLoop, cells: &[Cell], cpix: &[u32], rep: &Replay) {
    use std::io::Write;
    let Ok(path) = std::env::var("CALA_REPLAY_DUMP") else {
        return;
    };
    let w = slow.dims.width;
    let at = |c: (f32, f32)| (c.0.round() as usize * w + c.1.round() as usize) as u32;
    let block = slow.filter.moat().map_or(0, |m| m.0);
    let ratio = |pix: &[u32], h: &[f32], own: u32, other: u32| -> f32 {
        let get = |p: u32| pix.binary_search(&p).map_or(f32::NAN, |i| h[i]);
        let (a, b) = (get(own), get(other));
        if a > 0.0 {
            b / a
        } else {
            f32::NAN
        }
    };
    let mut s = String::new();
    for (i, ci) in cells.iter().enumerate() {
        let stats = slow
            .fpstats
            .get(&ci.id)
            .and_then(|st| Some((st.pix.clone(), st.estimate()?)));
        for (j, cj) in cells.iter().enumerate() {
            if i == j {
                continue;
            }
            let (pi, pj) = (at(ci.center), at(cj.center));
            let r_rep = ratio(cpix, &rep.h[i], pi, pj);
            let r_st = stats
                .as_ref()
                .map_or(f32::NAN, |(p, h)| ratio(p, h, pi, pj));
            let cur = |p: u32| ci.column_at(p, w, block);
            let r_cur = if cur(pi) > 0.0 {
                cur(pj) / cur(pi)
            } else {
                f32::NAN
            };
            let d =
                ((ci.center.0 - cj.center.0).powi(2) + (ci.center.1 - cj.center.1).powi(2)).sqrt();
            s.push_str(&format!(
                "{}\t{}\t{}\t{}\t{:.2}\t{:.4}\t{:.4}\t{:.4}\t{}\n",
                slow.frames,
                ci.id,
                cj.id,
                cells.len(),
                d,
                r_rep,
                r_st,
                r_cur,
                rep.frames
            ));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(s.as_bytes());
    }
}

/// The traces of `m` stored frames (`vv`, `m x r` coordinates in the basis
/// `u`, pixel-major `n x r`) under the whitened columns `a` (pixel-major
/// `n x kk`): `argmin_{c ≥ 0} ‖U v − A c‖²` per frame. `None` when a
/// column is empty.
fn solve_traces(
    a: &[f64],
    u: &[f64],
    n: usize,
    kk: usize,
    r: usize,
    vv: &[f64],
) -> Option<Vec<f64>> {
    let mut g = vec![0.0f64; kk * kk];
    let mut bm = vec![0.0f64; kk * r];
    for i in 0..n {
        let ar = &a[i * kk..(i + 1) * kk];
        let ur = &u[i * r..(i + 1) * r];
        for p in 0..kk {
            for q in 0..kk {
                g[p * kk + q] += ar[p] * ar[q];
            }
            for j in 0..r {
                bm[p * r + j] += ar[p] * ur[j];
            }
        }
    }
    if (0..kk).any(|k| !(g[k * kk + k] > 0.0)) {
        return None;
    }
    let m = vv.len() / r;
    let mut cs = vec![0.0f64; m * kk];
    let mut b = vec![0.0f64; kk];
    for s in 0..m {
        for p in 0..kk {
            b[p] = (0..r).map(|j| bm[p * r + j] * vv[s * r + j]).sum();
        }
        nnls(&g, &b, kk, &mut cs[s * kk..(s + 1) * kk]);
    }
    Some(cs)
}

/// Orthonormal basis of the columns of `b` (pixel-major `n x k`) by
/// modified Gram–Schmidt; columns that are (numerically) in the span of
/// the earlier ones are dropped. Returns `(U, rank)`, `U` pixel-major.
fn orth(b: &[f64], n: usize, k: usize) -> (Vec<f64>, usize) {
    let mut cols: Vec<Vec<f64>> = Vec::with_capacity(k);
    for j in 0..k {
        let mut c: Vec<f64> = (0..n).map(|i| b[i * k + j]).collect();
        let norm0 = c.iter().map(|x| x * x).sum::<f64>().sqrt();
        if !(norm0 > 0.0) || !norm0.is_finite() {
            continue;
        }
        for q in &cols {
            let d: f64 = c.iter().zip(q).map(|(x, y)| x * y).sum();
            c.iter_mut().zip(q).for_each(|(x, y)| *x -= d * y);
        }
        let norm = c.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm > 1e-6 * norm0 {
            c.iter_mut().for_each(|x| *x /= norm);
            cols.push(c);
        }
    }
    let r = cols.len();
    let mut u = vec![0.0f64; n * r];
    for (j, c) in cols.iter().enumerate() {
        for i in 0..n {
            u[i * r + j] = c[i];
        }
    }
    (u, r)
}

/// Inverse of the `k x k` matrix `a` (row major), `None` when singular.
fn inverse(a: &[f64], k: usize) -> Option<Vec<f64>> {
    let mut out = vec![0.0f64; k * k];
    for j in 0..k {
        let mut m = a.to_vec();
        let mut e = vec![0.0f64; k];
        e[j] = 1.0;
        if !solve_dense(&mut m, &mut e, k) {
            return None;
        }
        for i in 0..k {
            out[i * k + j] = e[i];
        }
    }
    Some(out)
}

/// `argmin xᵀ G x − 2 xᵀ b` with `x_p ≥ 0` where `lo[p]` (projected
/// Gauss–Seidel from `x`, clipped).
fn bounded_ls(g: &[f64], b: &[f64], lo: &[bool], k: usize, x: &mut [f64]) {
    for p in 0..k {
        if lo[p] {
            x[p] = x[p].max(0.0);
        }
    }
    for _ in 0..200 {
        let (mut change, mut scale) = (0.0f64, 0.0f64);
        for p in 0..k {
            let mut s = b[p];
            for q in 0..k {
                if q != p {
                    s -= g[p * k + q] * x[q];
                }
            }
            let mut new = s / g[p * k + p];
            if lo[p] {
                new = new.max(0.0);
            }
            change = change.max((new - x[p]).abs());
            scale = scale.max(new.abs());
            x[p] = new;
        }
        if change <= 1e-9 * scale.max(1e-12) {
            break;
        }
    }
}

/// `argmin_{x ≥ 0} xᵀ G x − 2 xᵀ b` for a small positive-definite `G`
/// (projected Gauss–Seidel to convergence, as the fast loop's solver).
pub(crate) fn nnls(g: &[f64], b: &[f64], k: usize, x: &mut [f64]) {
    for p in 0..k {
        x[p] = (b[p] / g[p * k + p]).max(0.0);
    }
    for _ in 0..200 {
        let mut change = 0.0f64;
        let mut scale = 0.0f64;
        for p in 0..k {
            let mut s = b[p];
            for q in 0..k {
                if q != p {
                    s -= g[p * k + q] * x[q];
                }
            }
            let new = (s / g[p * k + p]).max(0.0);
            change = change.max((new - x[p]).abs());
            scale = scale.max(new.abs());
            x[p] = new;
        }
        if change <= 1e-9 * scale.max(1e-12) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greedy_clusters_respect_the_cap_and_strength_order() {
        // A chain 0-1-2-3 with strengths .9, .2, .8 and a weak 3-4.
        let edges = vec![(0.9, 0, 1), (0.8, 2, 3), (0.2, 1, 2), (0.04, 3, 4)];
        let (g, cut) = greedy_clusters(5, &edges, 0.05, 2);
        assert_eq!(g, vec![vec![0, 1], vec![2, 3]]);
        assert_eq!(cut, 1);
        let (g, cut) = greedy_clusters(5, &edges, 0.05, 0);
        assert_eq!(g, vec![vec![0, 1, 2, 3]]);
        assert_eq!(cut, 0);
    }

    #[test]
    fn nnls_matches_the_two_column_closed_form() {
        let g = [2.0, 0.5, 0.5, 1.0];
        let mut x = [0.0; 2];
        nnls(&g, &[1.0, 1.0], 2, &mut x);
        // Unconstrained solution is positive: (1 - .5)/(2 - .25)... solve.
        let det = 2.0 * 1.0 - 0.25;
        assert!((x[0] - (1.0 * 1.0 - 0.5 * 1.0) / det).abs() < 1e-8);
        assert!((x[1] - (2.0 * 1.0 - 0.5 * 1.0) / det).abs() < 1e-8);
        nnls(&g, &[1.0, -1.0], 2, &mut x);
        assert!((x[0] - 0.5).abs() < 1e-8 && x[1] == 0.0);
    }

    /// The toy of the design (two Gaussian cells 0.75 D apart, the newer
    /// one born bitten, with no light at the older one's centre and the
    /// older one over-filled): one replay per 200 frames, footprints from
    /// the replay's joint estimate (clipped at zero, peak 1), heals the
    /// bite within a few thousand frames.
    #[test]
    fn replay_heals_a_bitten_newcomer() {
        let (h, w) = (24usize, 40usize);
        let d = 14.0f32;
        let sig = d / 2.3548;
        let cj = (12.0f32, 20.0 - 0.375 * d);
        let ci = (12.0f32, 20.0 + 0.375 * d);
        let gauss = |c: (f32, f32)| -> Vec<f32> {
            (0..h * w)
                .map(|p| {
                    let (y, x) = ((p / w) as f32, (p % w) as f32);
                    (-((y - c.0).powi(2) + (x - c.1).powi(2)) / (2.0 * sig * sig)).exp()
                })
                .collect()
        };
        let (aj, ai) = (gauss(cj), gauss(ci));
        let n = h * w;
        let pix: Vec<u32> = (0..n as u32).collect();
        let pj = 12 * w + cj.1.round() as usize;
        // Bitten start: i has nothing at j's half (x < midpoint); j
        // carries a share of i.
        let mut cur_i: Vec<f32> = (0..n)
            .map(|p| if (p % w) as f32 > 20.0 { ai[p] } else { 0.0 })
            .collect();
        let mut cur_j: Vec<f32> = (0..n).map(|p| aj[p] + 0.3 * ai[p]).collect();
        let mut rng = 12345u64;
        let mut unif = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 11) as f64 / (1u64 << 53) as f64
        };
        let disks = vec![(cj, 30.0), (ci, 30.0)];
        let cols = |a: &[f32], b: &[f32]| [a, b].concat();
        let mut st = ClusterStore::new(
            vec![1, 2],
            disks,
            pix,
            vec![1.0; n],
            w,
            0,
            cols(&cur_j, &cur_i),
            3000,
        );
        let (mut c1, mut c2) = (0.0f64, 0.0f64);
        let gamma = 0.5f64.powf(1.0 / 3000.0);
        let mut wgt = 1.0f64;
        let mut x = [0.0f64; 2];
        for t in 0..4000 {
            for c in [&mut c1, &mut c2] {
                *c *= 0.95;
                if unif() < 0.01 {
                    *c += -unif().max(1e-12).ln();
                }
            }
            let y: Vec<f32> = (0..n)
                .map(|p| {
                    let z = (-2.0 * unif().max(1e-12).ln()).sqrt()
                        * (2.0 * std::f64::consts::PI * unif()).cos();
                    (f64::from(aj[p]) * c1 + f64::from(ai[p]) * c2 + 0.5 * z) as f32
                })
                .collect();
            // Fast-loop traces with the current footprints.
            let a = st.white_cols();
            let (mut g, mut b) = ([0.0f64; 4], [0.0f64; 2]);
            for p in 0..n {
                for k in 0..2 {
                    b[k] += a[p * 2 + k] * f64::from(y[p]);
                    for l in 0..2 {
                        g[k * 2 + l] += a[p * 2 + k] * a[p * 2 + l];
                    }
                }
            }
            nnls(&g, &b, 2, &mut x);
            wgt /= gamma;
            st.push(&y, &[x[0] as f32, x[1] as f32], wgt);
            if t % 200 == 199 && t > 512 {
                let rep = st.replay(gamma, false, 1).expect("replay");
                let norm = |h: &[f32]| {
                    let m = h.iter().cloned().fold(0.0f32, f32::max).max(1e-12);
                    h.iter().map(|v| v.max(0.0) / m).collect::<Vec<f32>>()
                };
                cur_j = norm(&rep.h[0]);
                cur_i = norm(&rep.h[1]);
                st.cols = cols(&cur_j, &cur_i);
            }
        }
        let truth = ai[pj] / ai.iter().cloned().fold(0.0, f32::max);
        let ratio = cur_i[pj] / truth;
        assert!(ratio > 0.6, "i at j's centre / truth = {ratio}");
        let over = cur_j[12 * w + ci.1.round() as usize]
            / (aj[12 * w + ci.1.round() as usize] / aj.iter().cloned().fold(0.0, f32::max));
        assert!(over < 1.3, "j over-fill at i's centre = {over}");
    }
}
