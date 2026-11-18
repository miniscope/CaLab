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
use super::{
    column_on, paired_z, solve_dense, EditScope, Frames, JointAdmit, JointSign, JointUpdate,
    SlowLoop,
};
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

    /// Room for `width` coordinates per frame (the new ones zero).
    fn widen(&mut self, width: usize) {
        let mut v = vec![0.0f32; self.cap * width];
        for s in 0..self.cap {
            v[s * width..s * width + self.width]
                .copy_from_slice(&self.v[s * self.width..(s + 1) * self.width]);
        }
        self.v = v;
        self.width = width;
    }

    /// Forget every stored frame.
    fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }
}

impl ClusterHistory for RingHistory {
    fn append(&mut self, v: &[f32], at: u64, half: bool) {
        if v.len() > self.width {
            self.widen(v.len());
        }
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
        if r_new > self.width {
            self.widen(r_new);
        }
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
    /// Forgetting sums of the whitened residual: `Σ w r̃ ĉ_k` (member-major),
    /// `Σ w r̃`, `Σ w ĉ`, `Σ w ĉ ĉᵀ` (`K x K`), `Σ w`.
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
    /// The store's own last joint estimate, whitened (pixel-major `n x K`),
    /// carried to the next replay's trace step (`joint_carry`).
    est: Option<Vec<f64>>,
    /// Leftover-light directions requested (`joint_leftover`). The basis
    /// is `[U | L]`: its first `ru` columns span the members' light
    /// (`orth(CY)`), the rest (`L`, at most `m`) the strongest residual
    /// patterns outside that span.
    m: usize,
    ru: usize,
    /// Streaming power iteration for `L`: `Σ w r̃ s_j` (leftover-major,
    /// `m x n`) and `Σ w s_j`, `s_j = L_jᵀ r̃` the frame's leftover
    /// coordinates.
    zl: Vec<f32>,
    sl: Vec<f64>,
    /// The provisional components (whitened, non-negative, pixel-major
    /// `n x mp`): fitted in every replay like a member, never published.
    prov: Option<(Vec<f64>, usize)>,
}

/// Per pixel of `pix`: the member whose ring level is subtracted there (the
/// largest positive column; else the nearest disk centre) and the bit mask
/// of the members whose disk covers it.
fn owner_cover(
    pix: &[u32],
    disks: &[((f32, f32), f32)],
    cols: &[f32],
    width: usize,
) -> (Vec<u8>, Vec<u8>) {
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
    (owner, cover)
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
        m: usize,
    ) -> ClusterStore {
        let kk = ids.len();
        let n = pix.len();
        let (owner, cover) = owner_cover(&pix, &disks, &cols, width);
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
            scc: vec![0.0; kk * kk],
            sw: 0.0,
            u: Vec::new(),
            rank: 0,
            hist: RingHistory::new(cap, kk + m),
            k: 0,
            est: None,
            m,
            ru: 0,
            zl: vec![0.0; m * n],
            sl: vec![0.0; m],
            prov: None,
        };
        // The first basis is the members' current whitened columns (the
        // statistics have not accumulated yet).
        let a = s.white_cols();
        let (u, rank) = orth(&a, n, kk);
        s.ru = rank;
        let (u, rank) = s.with_leftover(u, rank);
        s.set_basis(u, rank);
        s
    }

    /// `[U | L]`: the member basis `u` (pixel-major `n x ru`) extended by
    /// the leftover directions, `L = orth((I − U Uᵀ) Z)` with `Z` the
    /// centred power-iteration sums (one step of a streaming subspace
    /// iteration on the residual's second moment); a direction with no
    /// sums yet keeps its current column, or a fixed pseudo-random start.
    fn with_leftover(&self, u: Vec<f64>, ru: usize) -> (Vec<f64>, usize) {
        let n = self.pix.len();
        if self.m == 0 || n <= ru {
            return (u, ru);
        }
        let k = ru + self.m;
        let mut b = vec![0.0f64; n * k];
        for i in 0..n {
            b[i * k..i * k + ru].copy_from_slice(&u[i * ru..(i + 1) * ru]);
        }
        let old_l = self.rank.saturating_sub(self.ru);
        for j in 0..self.m {
            let zj = &self.zl[j * n..(j + 1) * n];
            let live = self.sw > 0.0 && zj.iter().any(|&x| x != 0.0);
            for i in 0..n {
                b[i * k + ru + j] = if live {
                    f64::from(zj[i]) - f64::from(self.sr[i]) * self.sl[j] / self.sw
                } else if j < old_l && self.u.len() == n * self.rank {
                    self.u[i * self.rank + self.ru + j]
                } else {
                    // Fixed pseudo-random start (by pixel and direction).
                    let h = (u64::from(self.pix[i]) ^ ((j as u64 + 1) << 32))
                        .wrapping_mul(0x9E37_79B9_7F4A_7C15);
                    ((h >> 11) as f64 / (1u64 << 53) as f64) - 0.5
                };
            }
        }
        let (q, r) = orth(&b, n, k);
        // Gram–Schmidt keeps the member columns first; if a member column
        // dropped out the leftover ones simply follow.
        (q, r)
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
        self.zl.iter_mut().for_each(|v| *v *= f32_);
        self.sl.iter_mut().for_each(|v| *v *= f);
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
            for l in 0..kk {
                self.scc[k * kk + l] += w * ck * f64::from(c[l]);
            }
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
        // Leftover directions: one more step of the power iteration.
        for j in 0..self.rank - self.ru {
            let s = v[self.ru + j];
            self.sl[j] += w * f64::from(s);
            let a = wf * s;
            for (z, &x) in self.zl[j * n..(j + 1) * n].iter_mut().zip(r) {
                *z += a * x;
            }
        }
        self.hist
            .append(&v, self.k, (self.k / 256).is_multiple_of(2));
        self.k += 1;
        // With leftover directions the basis follows the data between
        // replays too, so the stored frames carry new leftover light.
        if self.m > 0 && self.k.is_multiple_of(256) {
            self.refresh_basis();
        }
    }

    /// Refresh the basis to `orth(CY)` (centred; a member whose trace has no
    /// variance yet keeps its current column) and re-express the stored
    /// frames in it, `V ← U'ᵀ U V`.
    fn refresh_basis(&mut self) {
        let (u2, ru) = self.cy_basis();
        let (u2, r2) = self.with_leftover(u2, ru);
        self.ru = ru;
        let n = self.pix.len();
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

    /// `orth` of the centred `CY` (a member whose trace has no variance yet
    /// keeps its current column).
    fn cy_basis(&self) -> (Vec<f64>, usize) {
        let (n, kk) = (self.pix.len(), self.ids.len());
        let a = self.white_cols();
        let mut b = vec![0.0f64; n * kk];
        for k in 0..kk {
            let var = if self.sw > 0.0 {
                self.scc[k * kk + k] - self.sc[k] * self.sc[k] / self.sw
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
        orth(&b, n, kk)
    }

    /// Move the store to new pixels `pix` (sorted; whitening `is`, member
    /// disks `disks`, the members' current filtered columns `cols` there,
    /// member-major), keeping its history: pixels in both sets keep their
    /// sums and stored light; a pixel new to the store starts at the current
    /// model (its sums and every stored frame's light there are what the
    /// members' current columns predict from the frame's least-squares
    /// traces), the store's analogue of `FpStats::seed_new` (no evidence
    /// yet, rather than zero light). Linear in the stored coordinates, so it
    /// is one [`ClusterHistory::reexpress`]. `false` (store unchanged) when
    /// the current columns are degenerate in the basis.
    #[allow(clippy::too_many_arguments)]
    pub fn move_to(
        &mut self,
        disks: Vec<((f32, f32), f32)>,
        pix: Vec<u32>,
        is: Vec<f32>,
        width: usize,
        version: u64,
        cols: Vec<f32>,
    ) -> bool {
        let (n0, kk, r0) = (self.pix.len(), self.ids.len(), self.rank);
        let n1 = pix.len();
        if n1 == 0 || r0 == 0 {
            return false;
        }
        // Least-squares traces of a stored frame: c = P v, P = (BᵀB)⁻¹ Bᵀ,
        // B = Uᵀ A (A the current whitened columns).
        let a0 = self.white_cols();
        let mut b = vec![0.0f64; r0 * kk];
        for i in 0..n0 {
            for j in 0..r0 {
                let uij = self.u[i * r0 + j];
                for k in 0..kk {
                    b[j * kk + k] += uij * a0[i * kk + k];
                }
            }
        }
        let mut g = vec![0.0f64; kk * kk];
        for p in 0..kk {
            for q in 0..kk {
                g[p * kk + q] = (0..r0).map(|j| b[j * kk + p] * b[j * kk + q]).sum();
            }
        }
        let Some(gi) = inverse(&g, kk) else {
            return false;
        };
        let mut pm = vec![0.0f64; kk * r0];
        for k in 0..kk {
            for j in 0..r0 {
                pm[k * r0 + j] = (0..kk).map(|q| gi[k * kk + q] * b[j * kk + q]).sum();
            }
        }
        // The new pixels' whitened columns, sums and frame map (n1 x r0).
        let mut a1 = vec![0.0f64; n1 * kk];
        for k in 0..kk {
            for i in 0..n1 {
                a1[i * kk + k] = f64::from(cols[k * n1 + i]) * f64::from(is[i]);
            }
        }
        let mut cy = vec![0.0f32; n1 * kk];
        let mut sr = vec![0.0f32; n1];
        let mut zl = vec![0.0f32; n1 * self.m];
        let mut rc = vec![0.0f64; n1 * r0];
        for i in 0..n1 {
            match self.pix.binary_search(&pix[i]) {
                Ok(i0) => {
                    sr[i] = self.sr[i0];
                    for k in 0..kk {
                        cy[k * n1 + i] = self.cy[k * n0 + i0];
                    }
                    for j in 0..self.m {
                        zl[j * n1 + i] = self.zl[j * n0 + i0];
                    }
                    rc[i * r0..(i + 1) * r0].copy_from_slice(&self.u[i0 * r0..(i0 + 1) * r0]);
                }
                Err(_) => {
                    let ai = &a1[i * kk..(i + 1) * kk];
                    sr[i] = (0..kk).map(|l| ai[l] * self.sc[l]).sum::<f64>() as f32;
                    for k in 0..kk {
                        cy[k * n1 + i] =
                            (0..kk).map(|l| ai[l] * self.scc[l * kk + k]).sum::<f64>() as f32;
                    }
                    for j in 0..r0 {
                        rc[i * r0 + j] = (0..kk).map(|l| ai[l] * pm[l * r0 + j]).sum();
                    }
                }
            }
        }
        let est = self.est.take().map(|e| {
            let mut out = a1.clone();
            for i in 0..n1 {
                if let Ok(i0) = self.pix.binary_search(&pix[i]) {
                    out[i * kk..(i + 1) * kk].copy_from_slice(&e[i0 * kk..(i0 + 1) * kk]);
                }
            }
            out
        });
        let (owner, cover) = owner_cover(&pix, &disks, &cols, width);
        self.disks = disks;
        self.pix = pix;
        self.is = is;
        self.owner = owner;
        self.cover = cover;
        self.version = version;
        self.cols = cols;
        self.cy = cy;
        self.sr = sr;
        self.zl = zl;
        self.est = est;
        self.prov = None;
        // The basis on the new pixels, and every stored frame in it:
        // v' = U'ᵀ Rc v. (The old leftover columns live on the old pixels:
        // the new ones come from the moved sums.)
        let (u1, ru1) = self.cy_basis();
        self.rank = self.ru;
        let (u1, r1) = self.with_leftover(u1, ru1);
        self.ru = ru1;
        let mut rm = vec![0.0f64; r1 * r0];
        for i in 0..n1 {
            for a_ in 0..r1 {
                let x = u1[i * r1 + a_];
                for b_ in 0..r0 {
                    rm[a_ * r0 + b_] += x * rc[i * r0 + b_];
                }
            }
        }
        self.hist.reexpress(&rm, r1, r0);
        self.set_basis(u1, r1);
        true
    }

    /// Re-express the store for a new member set (`design_discover_lookback`
    /// §3.2): `ids` (sorted) with their statistics `disks`, the store's new
    /// pixels `pix` (sorted, whitening `is`) and the members' current
    /// filtered columns there (`cols`, member-major). `old[k]` is the new
    /// member `k`'s index in the store, or `None` for a cell new to it.
    /// `newborn[k]`: the cell was not in the library at the last build (its
    /// light is in every stored frame's residual); an established cell
    /// joining from outside the store had its light subtracted at push
    /// time, so its stored coordinates are truthfully zero. Kept members
    /// keep their sums; new pixels start at the current model (as
    /// [`ClusterStore::move_to`]); the members' basis is rebuilt and the
    /// leftover directions become the strongest stored light outside it,
    /// so a departed member's light stays in the history as leftover
    /// light. Returns `false` (the store must start over) when a newborn's
    /// light is mostly outside the stored span (the old frames would then
    /// say all its light had the older cells' shape) or the stored span
    /// is degenerate.
    #[allow(clippy::too_many_arguments)]
    pub fn rebase(
        &mut self,
        ids: Vec<u64>,
        disks: Vec<((f32, f32), f32)>,
        pix: Vec<u32>,
        is: Vec<f32>,
        width: usize,
        version: u64,
        cols: Vec<f32>,
        old: &[Option<usize>],
        newborn: &[bool],
    ) -> bool {
        let (n0, r0, kk0) = (self.pix.len(), self.rank, self.ids.len());
        let (n1, kk1) = (pix.len(), ids.len());
        if n1 == 0 || r0 == 0 {
            return false;
        }
        // The new members' whitened columns on the new pixels and, through
        // the shared pixels, the stored basis' view of them.
        let mut a1 = vec![0.0f64; n1 * kk1];
        for k in 0..kk1 {
            for i in 0..n1 {
                a1[i * kk1 + k] = f64::from(cols[k * n1 + i]) * f64::from(is[i]);
            }
        }
        let map: Vec<Option<usize>> = pix.iter().map(|p| self.pix.binary_search(p).ok()).collect();
        let mut b = vec![0.0f64; r0 * kk1];
        for (i, i0) in map.iter().enumerate() {
            let Some(i0) = *i0 else { continue };
            for j in 0..r0 {
                let uij = self.u[i0 * r0 + j];
                for k in 0..kk1 {
                    b[j * kk1 + k] += uij * a1[i * kk1 + k];
                }
            }
        }
        // A newborn's light must lie mostly in the stored span.
        for k in 0..kk1 {
            if !newborn[k] {
                continue;
            }
            let tot: f64 = (0..n1).map(|i| a1[i * kk1 + k].powi(2)).sum();
            let inside: f64 = (0..r0).map(|j| b[j * kk1 + k].powi(2)).sum();
            if !(tot > 0.0) || inside < 0.5 * tot {
                return false;
            }
        }
        // Least-squares traces of a stored frame under the new members
        // (those with light in the stored span): c = P v.
        let live: Vec<usize> = (0..kk1)
            .filter(|&k| (0..r0).any(|j| b[j * kk1 + k] != 0.0))
            .collect();
        let nl = live.len();
        let mut g = vec![0.0f64; nl * nl];
        for (p, &kp) in live.iter().enumerate() {
            for (q, &kq) in live.iter().enumerate() {
                g[p * nl + q] = (0..r0).map(|j| b[j * kk1 + kp] * b[j * kk1 + kq]).sum();
            }
        }
        let gi = if nl > 0 {
            inverse(&g, nl)
        } else {
            Some(Vec::new())
        };
        let Some(gi) = gi else {
            return false;
        };
        let mut pm = vec![0.0f64; kk1 * r0];
        for (p, &kp) in live.iter().enumerate() {
            for j in 0..r0 {
                pm[kp * r0 + j] = (0..nl).map(|q| gi[p * nl + q] * b[j * kk1 + live[q]]).sum();
            }
        }
        // Sums of the kept members; zero for cells new to the store.
        let mut sc = vec![0.0f64; kk1];
        let mut scc = vec![0.0f64; kk1 * kk1];
        for k in 0..kk1 {
            let Some(k0) = old[k] else { continue };
            sc[k] = self.sc[k0];
            for l in 0..kk1 {
                if let Some(l0) = old[l] {
                    scc[k * kk1 + l] = self.scc[k0 * kk0 + l0];
                }
            }
        }
        // A newborn takes over its light in the stored frames: its sums
        // start from its least-squares traces there (clipped at zero),
        // `Σ v c` in the stored coordinates, scaled to the store's weight.
        let born: Vec<usize> = (0..kk1).filter(|&k| newborn[k]).collect();
        let mut vc = vec![0.0f64; r0 * born.len()];
        if !born.is_empty() {
            let (mut cnt, mut s1, mut s2) =
                (0usize, vec![0.0f64; born.len()], vec![0.0f64; born.len()]);
            self.hist.for_each(r0, &mut |v, _, _| {
                cnt += 1;
                for (x, &k) in born.iter().enumerate() {
                    let c: f64 = (0..r0)
                        .map(|j| pm[k * r0 + j] * f64::from(v[j]))
                        .sum::<f64>()
                        .max(0.0);
                    s1[x] += c;
                    s2[x] += c * c;
                    for j in 0..r0 {
                        vc[j * born.len() + x] += f64::from(v[j]) * c;
                    }
                }
            });
            let f = if cnt > 0 { self.sw / cnt as f64 } else { 0.0 };
            vc.iter_mut().for_each(|x| *x *= f);
            for (x, &k) in born.iter().enumerate() {
                sc[k] = s1[x] * f;
                scc[k * kk1 + k] = s2[x] * f;
            }
        }
        let mut cy = vec![0.0f32; n1 * kk1];
        let mut sr = vec![0.0f32; n1];
        let mut zl = vec![0.0f32; n1 * self.m];
        let mut rc = vec![0.0f64; n1 * r0];
        for i in 0..n1 {
            match map[i] {
                Some(i0) => {
                    sr[i] = self.sr[i0];
                    for k in 0..kk1 {
                        if let Some(k0) = old[k] {
                            cy[k * n1 + i] = self.cy[k0 * n0 + i0];
                        }
                    }
                    for j in 0..self.m {
                        zl[j * n1 + i] = self.zl[j * n0 + i0];
                    }
                    rc[i * r0..(i + 1) * r0].copy_from_slice(&self.u[i0 * r0..(i0 + 1) * r0]);
                }
                None => {
                    let ai = &a1[i * kk1..(i + 1) * kk1];
                    sr[i] = (0..kk1).map(|l| ai[l] * sc[l]).sum::<f64>() as f32;
                    for k in 0..kk1 {
                        cy[k * n1 + i] =
                            (0..kk1).map(|l| ai[l] * scc[l * kk1 + k]).sum::<f64>() as f32;
                    }
                    for j in 0..r0 {
                        rc[i * r0 + j] = (0..kk1).map(|l| ai[l] * pm[l * r0 + j]).sum();
                    }
                }
            }
        }
        for (x, &k) in born.iter().enumerate() {
            for i in 0..n1 {
                cy[k * n1 + i] = (0..r0)
                    .map(|j| rc[i * r0 + j] * vc[j * born.len() + x])
                    .sum::<f64>() as f32;
            }
        }
        // The stored frames' second moment (r0 x r0), for the leftover
        // directions.
        let mut sm = vec![0.0f64; r0 * r0];
        self.hist.for_each(r0, &mut |v, _, _| {
            for a_ in 0..r0 {
                for b_ in 0..r0 {
                    sm[a_ * r0 + b_] += f64::from(v[a_]) * f64::from(v[b_]);
                }
            }
        });
        let (owner, cover) = owner_cover(&pix, &disks, &cols, width);
        self.ids = ids;
        self.disks = disks;
        self.pix = pix;
        self.is = is;
        self.owner = owner;
        self.cover = cover;
        self.version = version;
        self.cols = cols;
        self.cy = cy;
        self.sr = sr;
        self.sc = sc;
        self.scc = scc;
        self.zl = zl;
        self.est = None;
        self.prov = None;
        let (u1, ru1) = self.cy_basis();
        // Leftover directions: the strongest stored light in span(Rc)
        // outside the members' new basis (top eigenvectors of the stored
        // second moment there).
        let mut cand = vec![0.0f64; n1 * r0];
        for j in 0..r0 {
            let col: Vec<f64> = (0..n1).map(|i| rc[i * r0 + j]).collect();
            let proj: Vec<f64> = (0..ru1)
                .map(|a_| (0..n1).map(|i| u1[i * ru1 + a_] * col[i]).sum())
                .collect();
            for i in 0..n1 {
                cand[i * r0 + j] =
                    col[i] - (0..ru1).map(|a_| u1[i * ru1 + a_] * proj[a_]).sum::<f64>();
            }
        }
        let (qc, q) = orth(&cand, n1, r0);
        let ml = self.m.min(q);
        let mut full = vec![0.0f64; n1 * (ru1 + ml)];
        for i in 0..n1 {
            full[i * (ru1 + ml)..i * (ru1 + ml) + ru1].copy_from_slice(&u1[i * ru1..(i + 1) * ru1]);
        }
        if ml > 0 {
            // T = Qcᵀ Rc (q x r0); M = T S Tᵀ.
            let mut t = vec![0.0f64; q * r0];
            for i in 0..n1 {
                for a_ in 0..q {
                    let x = qc[i * q + a_];
                    for j in 0..r0 {
                        t[a_ * r0 + j] += x * rc[i * r0 + j];
                    }
                }
            }
            let mut mm = vec![0.0f64; q * q];
            for a_ in 0..q {
                for b_ in 0..q {
                    let mut acc = 0.0;
                    for j in 0..r0 {
                        let tj: f64 = (0..r0).map(|l| sm[j * r0 + l] * t[b_ * r0 + l]).sum();
                        acc += t[a_ * r0 + j] * tj;
                    }
                    mm[a_ * q + b_] = acc;
                }
            }
            let (_, vecs) = sym_eig(&mm, q);
            for j in 0..ml {
                for i in 0..n1 {
                    full[i * (ru1 + ml) + ru1 + j] =
                        (0..q).map(|a_| qc[i * q + a_] * vecs[a_ * q + j]).sum();
                }
            }
        }
        let (u1, r1) = orth(&full, n1, ru1 + ml);
        let mut rm = vec![0.0f64; r1 * r0];
        for i in 0..n1 {
            for a_ in 0..r1 {
                let x = u1[i * r1 + a_];
                for b_ in 0..r0 {
                    rm[a_ * r0 + b_] += x * rc[i * r0 + b_];
                }
            }
        }
        self.hist.reexpress(&rm, r1, r0);
        self.ru = ru1;
        self.set_basis(u1, r1);
        true
    }

    /// Forget the stored frames (the sums stay).
    pub fn drop_history(&mut self) {
        self.hist.clear();
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
    /// With `carry`, the traces are re-solved with the store's own last
    /// estimate (when it has one) instead of the published columns, and
    /// this replay's estimate is kept for the next one.
    pub fn replay(
        &mut self,
        gamma: f64,
        sign_rule: JointSign,
        iters: usize,
        carry: bool,
    ) -> Option<Replay> {
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
        // The provisional components (leftover light no member may claim):
        // seeded from the leftover directions (rectified, the sign with
        // more positive light), then carried from replay to replay like a
        // member's footprint; seeded again after a member-set change.
        let ml = r - self.ru;
        if self.prov.as_ref().is_none_or(|p| p.1 != ml) {
            self.prov = (ml > 0).then(|| {
                let mut p = vec![0.0f64; n * ml];
                for j in 0..ml {
                    let col = |i: usize| self.u[i * r + self.ru + j];
                    let pos: f64 = (0..n).map(|i| col(i).max(0.0).powi(2)).sum();
                    let neg: f64 = (0..n).map(|i| col(i).min(0.0).powi(2)).sum();
                    let sg = if pos >= neg { 1.0 } else { -1.0 };
                    for i in 0..n {
                        p[i * ml + j] = (sg * col(i)).max(0.0);
                    }
                }
                (p, ml)
            });
        }
        let mp = self.prov.as_ref().map_or(0, |p| p.1);
        let kt = kk + mp;
        // Trace step on every stored frame, with the current columns (and
        // the provisional components).
        let start = match (&self.est, carry) {
            (Some(e), true) => e.clone(),
            _ => self.white_cols(),
        };
        let extend = |a: &[f64]| -> Vec<f64> {
            let Some((p, _)) = self.prov.as_ref() else {
                return a.to_vec();
            };
            let mut x = vec![0.0f64; n * kt];
            for i in 0..n {
                x[i * kt..i * kt + kk].copy_from_slice(&a[i * kk..(i + 1) * kk]);
                x[i * kt + kk..(i + 1) * kt].copy_from_slice(&p[i * mp..(i + 1) * mp]);
            }
            x
        };
        let mut cs = solve_traces(&extend(&start), &self.u, n, kt, r, &vv)?;
        // Footprint step per subset of frames: all, half A, half B.
        let cover = |i: usize| -> usize { (self.cover[i] as usize) | (((1usize << mp) - 1) << kk) };
        let fit = |cs: &[f64], sel: &dyn Fn(usize) -> bool| -> Option<(Vec<Vec<f32>>, Vec<f64>)> {
            let (mut sw, mut sc, mut sv) = (0.0f64, vec![0.0f64; kt], vec![0.0f64; r]);
            for s in 0..m {
                if sel(s) {
                    sw += ws[s];
                    for p in 0..kt {
                        sc[p] += ws[s] * cs[s * kt + p];
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
            let mut mr = vec![0.0f64; kt * kt];
            let mut q = vec![0.0f64; kt * kt];
            let mut wv = vec![0.0f64; r * kt];
            for s in 0..m {
                if !sel(s) {
                    continue;
                }
                let w = ws[s];
                for p in 0..kt {
                    let dp = cs[s * kt + p] - sc[p];
                    for q_ in 0..kt {
                        let d = dp * (cs[s * kt + q_] - sc[q_]);
                        mr[p * kt + q_] += w * d;
                        q[p * kt + q_] += w * w * d;
                    }
                    for j in 0..r {
                        wv[j * kt + p] += w * (vv[s * r + j] - sv[j]) * dp;
                    }
                }
            }
            // Standard errors from the full set: diag(M⁻¹ Q M⁻¹).
            let minv = inverse(&mr, kt)?;
            let mut se = vec![0.0f64; kt];
            for k in 0..kt {
                let mut acc = 0.0;
                for p in 0..kt {
                    for q_ in 0..kt {
                        acc += minv[k * kt + p] * q[p * kt + q_] * minv[q_ * kt + k];
                    }
                }
                se[k] = acc.max(0.0).sqrt();
            }
            // Per pixel: rhs = U_p Wv, solved over the covering members
            // (and the provisional components, which cover every pixel).
            let mut inv_by_mask: HashMap<usize, Vec<f64>> = HashMap::new();
            let mut h = vec![vec![0.0f32; n]; kt];
            let mut rhs = vec![0.0f64; kt];
            for i in 0..n {
                let mask = cover(i);
                if mask == 0 {
                    continue;
                }
                let idx: Vec<usize> = (0..kt).filter(|&k| mask & (1 << k) != 0).collect();
                let ns = idx.len();
                if !inv_by_mask.contains_key(&mask) {
                    let mut sub = vec![0.0f64; ns * ns];
                    for (a_, &p) in idx.iter().enumerate() {
                        for (b_, &q_) in idx.iter().enumerate() {
                            sub[a_ * ns + b_] = mr[p * kt + q_];
                        }
                    }
                    inv_by_mask.insert(mask, inverse(&sub, ns)?);
                }
                let inv = &inv_by_mask[&mask];
                let ur = &self.u[i * r..(i + 1) * r];
                for (a_, &p) in idx.iter().enumerate() {
                    rhs[a_] = (0..r).map(|j| ur[j] * wv[j * kt + p]).sum();
                }
                let is = f64::from(self.is[i]);
                let mut x: Vec<f64> = (0..ns)
                    .map(|a_| (0..ns).map(|b_| inv[a_ * ns + b_] * rhs[b_]).sum())
                    .collect();
                // The provisional components are light: never negative.
                let lo: Vec<bool> = idx
                    .iter()
                    .map(|&p| {
                        p >= kk
                            || sign_rule == JointSign::All
                            || (sign_rule == JointSign::Own && self.cols[p * n + i] > 0.0)
                    })
                    .collect();
                if x.iter().zip(&lo).any(|(&v, &l)| l && v < 0.0) {
                    let mut sub = vec![0.0f64; ns * ns];
                    for (a_, &p) in idx.iter().enumerate() {
                        for (b_, &q_) in idx.iter().enumerate() {
                            sub[a_ * ns + b_] = mr[p * kt + q_];
                        }
                    }
                    bounded_ls(&sub, &rhs[..ns], &lo, ns, &mut x);
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
        let white = |h: &[Vec<f32>]| -> Vec<f64> {
            let mut a = vec![0.0f64; n * kt];
            for k in 0..kt {
                for i in 0..n {
                    let v = f64::from(h[k][i]) * f64::from(self.is[i]);
                    a[i * kt + k] = if k >= kk { v.max(0.0) } else { v };
                }
            }
            a
        };
        for _ in 1..iters.max(1) {
            let (h, _) = fit(&cs, &|_| true)?;
            cs = solve_traces(&white(&h), &self.u, n, kt, r, &vv)?;
        }
        let (mut h, mut se) = fit(&cs, &|_| true)?;
        let (mut ha, mut sa) = fit(&cs, &|s| hs[s])?;
        let (mut hb, mut sb) = fit(&cs, &|s| !hs[s])?;
        if mp > 0 {
            let a = white(&h);
            let mut p = vec![0.0f64; n * mp];
            let mut live = true;
            for j in 0..mp {
                let mut any = false;
                for i in 0..n {
                    p[i * mp + j] = a[i * kt + kk + j];
                    any |= p[i * mp + j] > 0.0;
                }
                live &= any;
            }
            // One that holds no light starts again from its direction.
            self.prov = live.then_some((p, mp));
            for v in [&mut h, &mut ha, &mut hb] {
                v.truncate(kk);
            }
            for v in [&mut se, &mut sa, &mut sb] {
                v.truncate(kk);
            }
        }
        if carry {
            let mut e = vec![0.0f64; n * kk];
            for k in 0..kk {
                for i in 0..n {
                    e[i * kk + k] = f64::from(h[k][i]) * f64::from(self.is[i]);
                }
            }
            self.est = Some(e);
        }
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
        let (disks, pix, is, cols) = self.store_geometry(lib, &ids)?;
        let cap = self.cfg.stats_half_life_frames.ceil().max(1.0) as usize;
        Some(ClusterStore::new(
            ids,
            disks,
            pix,
            is,
            self.dims.width,
            lib.version(),
            cols,
            cap,
            self.cfg.joint_leftover,
        ))
    }

    /// The pixels of a store for members `ids`: the union of their
    /// statistics disks (which already carry the statistics margin around
    /// each support), with the whitening and the members' current filtered
    /// columns there (member-major).
    #[allow(clippy::type_complexity)]
    fn store_geometry(
        &self,
        lib: &Library,
        ids: &[u64],
    ) -> Option<(Vec<((f32, f32), f32)>, Vec<u32>, Vec<f32>, Vec<f32>)> {
        let (width, height) = (self.dims.width, self.dims.height);
        let mut disks = Vec::with_capacity(ids.len());
        let mut pix: Vec<u32> = Vec::new();
        for id in ids {
            let st = self.fpstats.get(id)?;
            let disk = (st.center, st.radius);
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
        for id in ids {
            cols.extend(column_on(lib, lib.slot(*id)?, &pix));
        }
        Some((disks, pix, is, cols))
    }

    /// Clusters of the library's cells (greedy, `cluster_rho_min`,
    /// `cluster_max`). A store whose member set is unchanged is kept; with
    /// `joint_rebase` a changed member set is re-expressed from the old
    /// store with the most members in common ([`ClusterStore::rebase`]).
    fn build_clusters(&mut self, lib: &Library) {
        let edges = overlap_edges(lib);
        let (groups, _) = greedy_clusters(
            lib.len(),
            &edges,
            self.cfg.cluster_rho_min,
            self.cfg.cluster_max,
        );
        let olds: Vec<(ClusterStore, bool)> = self
            .clusters
            .drain(..)
            .zip(self.cluster_ok.drain(..))
            .collect();
        let mut by_set: HashMap<Vec<u64>, usize> = HashMap::new();
        let mut store_of: HashMap<u64, usize> = HashMap::new();
        for (x, (c, _)) in olds.iter().enumerate() {
            by_set.insert(c.ids.clone(), x);
            for &id in &c.ids {
                store_of.insert(id, x);
            }
        }
        let mut taken = vec![false; olds.len()];
        let mut olds: Vec<Option<(ClusterStore, bool)>> = olds.into_iter().map(Some).collect();
        let prev = std::mem::take(&mut self.cluster_ids);
        self.cluster_of.clear();
        let ids = lib.ids();
        // Exact member sets first (moved, not copied), so a store shared by
        // a split is only copied for the changed parts.
        let sets: Vec<Vec<u64>> = groups
            .iter()
            .map(|g| {
                let mut m: Vec<u64> = g.iter().map(|&s| ids[s]).collect();
                m.sort_unstable();
                m
            })
            .collect();
        let mut out: Vec<Option<(ClusterStore, bool)>> = vec![None; sets.len()];
        for (gi, m) in sets.iter().enumerate() {
            if let Some(&x) = by_set.get(m) {
                taken[x] = true;
                out[gi] = olds[x].take();
            }
        }
        for gi in 0..sets.len() {
            if out[gi].is_some() {
                continue;
            }
            let m = sets[gi].clone();
            let had: Vec<usize> = {
                let mut v: Vec<usize> = m
                    .iter()
                    .filter_map(|id| store_of.get(id).copied())
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            };
            if !self.cfg.joint_rebase || had.is_empty() {
                if had.is_empty() {
                    self.replay_stats.fresh += 1;
                } else {
                    self.replay_stats.set_restarts += 1;
                }
                out[gi] = self.new_store(lib, m).map(|s| (s, false));
                continue;
            }
            if had.len() > 1 {
                self.replay_stats.unions += 1;
            }
            // The base: the old store with the most members in common
            // (then the most stored frames, then the first).
            let count = |x: usize| m.iter().filter(|id| store_of.get(id) == Some(&x)).count();
            let base = had
                .iter()
                .copied()
                .max_by(|&x, &y| {
                    let sx = olds[x].as_ref().map_or(0, |o| o.0.stored());
                    let sy = olds[y].as_ref().map_or(0, |o| o.0.stored());
                    count(x).cmp(&count(y)).then(sx.cmp(&sy)).then(y.cmp(&x))
                })
                .expect("non-empty");
            // Each changed group gets its own copy (a split feeds several);
            // the last user takes the original.
            let last_user = !sets[gi + 1..]
                .iter()
                .zip(&out[gi + 1..])
                .any(|(mm, o)| o.is_none() && mm.iter().any(|id| store_of.get(id) == Some(&base)));
            let src = if last_user && !taken[base] {
                taken[base] = true;
                olds[base].take()
            } else {
                olds[base].clone()
            };
            let Some((mut st, _)) = src else {
                out[gi] = self.new_store(lib, m).map(|s| (s, false));
                continue;
            };
            let old_idx: Vec<Option<usize>> = m
                .iter()
                .map(|id| st.ids.iter().position(|x| x == id))
                .collect();
            let newborn: Vec<bool> = m.iter().map(|id| prev.binary_search(id).is_err()).collect();
            let has_birth = newborn.iter().any(|&b| b);
            let ok = self
                .store_geometry(lib, &m)
                .is_some_and(|(disks, pix, is, cols)| {
                    st.rebase(
                        m.clone(),
                        disks,
                        pix,
                        is,
                        self.dims.width,
                        lib.version(),
                        cols,
                        &old_idx,
                        &newborn,
                    )
                });
            if ok {
                self.replay_stats.rebased += 1;
                if has_birth {
                    self.replay_stats.rebased_birth += 1;
                }
                out[gi] = Some((st, false));
            } else {
                self.replay_stats.dropped += 1;
                out[gi] = self.new_store(lib, m).map(|s| (s, false));
            }
        }
        for (store, ok) in out.into_iter().flatten() {
            for &id in &store.ids {
                self.cluster_of.insert(id, self.clusters.len());
            }
            self.replay_stats.clusters += 1;
            self.replay_stats.members += store.ids.len() as u64;
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
                // Move the store to the members' current disks, keeping
                // its history; start over only when that is degenerate.
                let ids = self.clusters[ci].ids.clone();
                if let Some((disks, pix, is, cols)) = self.store_geometry(lib, &ids) {
                    let w = self.dims.width;
                    if self.clusters[ci].move_to(disks, pix, is, w, version, cols) {
                        self.replay_stats.moves += 1;
                    } else if let Some(s) = self.new_store(lib, ids) {
                        self.clusters[ci] = s;
                        self.cluster_ok[ci] = false;
                        self.replay_stats.restarts += 1;
                    }
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
            let rep = st.replay(
                gamma,
                self.cfg.joint_sign_rule,
                self.cfg.joint_iters,
                self.cfg.joint_carry,
            );
            #[cfg(feature = "diagnostics")]
            let mut sd = StageDiag::new(kk);
            'cluster: {
                let Some(rep) = rep.as_ref() else {
                    self.replay_stats.replay_none += 1;
                    self.cluster_ok[ci] = false;
                    #[cfg(feature = "diagnostics")]
                    sd.all("none");
                    break 'cluster;
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
                #[cfg(feature = "diagnostics")]
                {
                    sd.all("lowsnr");
                    for p in &props {
                        sd.exit[p.0] = "conv";
                    }
                }
                if props.is_empty() {
                    self.replay_stats.low_snr += 1;
                    self.cluster_ok[ci] = false;
                    break 'cluster;
                }
                self.cluster_ok[ci] = true;
                match self.cfg.joint_admit {
                    JointAdmit::Cluster => {
                        let excess: f64 = props
                            .iter()
                            .map(|(k, pix, h, ha, hb)| self.half_excess(&cells[*k], pix, h, ha, hb))
                            .sum();
                        if !(excess > 0.0) {
                            props.clear();
                        }
                    }
                    JointAdmit::Member => props.retain(|(k, pix, h, _, _)| {
                        let v = rep.sa[*k] * rep.sa[*k] + rep.sb[*k] * rep.sb[*k];
                        self.noise_excess(&cells[*k], pix, h, v) > 0.0
                    }),
                }
                if props.is_empty() {
                    self.replay_stats.converged += 1;
                    break 'cluster;
                }
                let mut news: Vec<Cell> = Vec::new();
                for (k, pix, h, ha, hb) in props {
                    self.fast_tmp = None;
                    self.support_tmp = Some((pix.clone(), ha, hb, rep.sa[k], rep.sb[k]));
                    #[cfg(feature = "diagnostics")]
                    {
                        sd.exit[k] = "fnone";
                        if stage_dump_on() {
                            let wd = self.dims.width;
                            let at = |c: (f32, f32)| {
                                (c.0.round() as usize * wd + c.1.round() as usize) as u32
                            };
                            self.probe =
                                Some((cells.iter().map(|c| at(c.center)).collect(), Vec::new()));
                        }
                    }
                    let new =
                        self.make_cell_global(ids[k], &pix, &h, Some(&cells[k]), Some(rep.se[k]));
                    self.support_tmp = None;
                    #[cfg(feature = "diagnostics")]
                    {
                        sd.probe[k] = self.probe.take().map(|p| p.1);
                    }
                    if let Some(mut new) = new {
                        new.born = cells[k].born;
                        #[cfg(feature = "diagnostics")]
                        {
                            sd.exit[k] = "rej";
                            sd.news[k] = Some(new.clone());
                        }
                        news.push(new);
                    }
                }
                #[cfg(feature = "diagnostics")]
                dump_replay(self, &cells, &cpix, rep);
                if news.is_empty() {
                    break 'cluster;
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
                #[cfg(feature = "diagnostics")]
                {
                    sd.gain = gain;
                    sd.z = z;
                    sd.frames = rep.frames;
                    if stage_dump_on() {
                        // Counterfactual: each member's new column alone
                        // (its work is not charged to the budget).
                        let w0 = self.work;
                        for nc in &news {
                            let Some(k) = ids.iter().position(|&x| x == nc.id) else {
                                continue;
                            };
                            let cols = self.columns(rect, &[nc.id], &[nc]);
                            let pr = self.problem(ti, cols);
                            let f = self.solve_all(&pr, test_fr);
                            sd.solo[k] = (chi_base - SlowLoop::total_chi2(&f)) / s2;
                        }
                        self.work = w0;
                    }
                }
                if accepted {
                    self.replay_stats.accepted += 1;
                    self.replay_stats.members_replaced += news.len() as u64;
                    #[cfg(feature = "diagnostics")]
                    for e in sd.exit.iter_mut() {
                        if *e == "rej" {
                            *e = "acc";
                        }
                    }
                    for new in news {
                        updates.push((new.id, new, z as f32, 3));
                    }
                }
            }
            #[cfg(feature = "diagnostics")]
            dump_stages(
                self,
                &cells,
                rep.as_ref(),
                &self.clusters[ci].pix.clone(),
                &sd,
            );
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

/// DIAG (`CALA_REPLAY_STAGES=path`): where a replay's estimate goes in
/// the finish path, per member: its exit (`none` no replay, `lowsnr` under
/// the minimum SNR, `conv` the cluster's split-half excess ≤ 0, `fnone` the
/// finish path gave no footprint, `rej` / `acc` gated), the samples of
/// `finish_basin` at the members' centres, and the new cell.
#[cfg(feature = "diagnostics")]
pub(super) struct StageDiag {
    pub exit: Vec<&'static str>,
    pub probe: Vec<Option<Vec<[f32; 8]>>>,
    pub news: Vec<Option<Cell>>,
    pub gain: f64,
    pub z: f64,
    pub frames: usize,
    pub solo: Vec<f64>,
}

#[cfg(feature = "diagnostics")]
impl StageDiag {
    pub fn new(kk: usize) -> StageDiag {
        StageDiag {
            exit: vec!["none"; kk],
            probe: vec![None; kk],
            news: vec![None; kk],
            gain: f64::NAN,
            z: f64::NAN,
            frames: 0,
            solo: vec![f64::NAN; kk],
        }
    }

    pub fn all(&mut self, e: &'static str) {
        self.exit.iter_mut().for_each(|x| *x = e);
    }
}

#[cfg(feature = "diagnostics")]
pub(super) fn stage_dump_on() -> bool {
    std::env::var_os("CALA_REPLAY_STAGES").is_some()
}

/// One row per ordered member pair (i, j): frame, ids, K, distance, i's
/// exit, gate gain and z, the raw replay estimate of i at c_j over c_i
/// (cluster pixels, filtered), `finish_basin`'s samples of i at c_i and at
/// c_j (h, smoothed target, q, tol, S0, X, inverted light, mask), and the
/// new and the current footprint of i at c_j over c_i (unfiltered raw,
/// filtered column).
#[cfg(feature = "diagnostics")]
fn dump_stages(
    slow: &SlowLoop,
    cells: &[Cell],
    rep: Option<&Replay>,
    cpix: &[u32],
    sd: &StageDiag,
) {
    use std::io::Write;
    let Ok(path) = std::env::var("CALA_REPLAY_STAGES") else {
        return;
    };
    let w = slow.dims.width;
    let at = |c: (f32, f32)| (c.0.round() as usize * w + c.1.round() as usize) as u32;
    let block = slow.filter.moat().map_or(0, |m| m.0);
    let raw_at = |c: &Cell, p: u32| c.pix.iter().position(|&q| q == p).map_or(0.0, |k| c.raw[k]);
    let ratio = |a: f32, b: f32| if a > 0.0 { b / a } else { f32::NAN };
    let mut s = String::new();
    for (i, ci) in cells.iter().enumerate() {
        let pi = at(ci.center);
        let in_disk = |p: u32| {
            slow.fpstats
                .get(&ci.id)
                .is_some_and(|st| st.pix.binary_search(&p).is_ok())
        };
        for (j, cj) in cells.iter().enumerate() {
            if i == j {
                continue;
            }
            let pj = at(cj.center);
            let r_rep = rep.map_or(f32::NAN, |r| {
                let get = |p: u32| cpix.binary_search(&p).map_or(f32::NAN, |x| r.h[i][x]);
                ratio(get(pi), get(pj))
            });
            let pr = |k: usize| -> String {
                sd.probe[i].as_ref().and_then(|v| v.get(k)).map_or_else(
                    || "nan\tnan\tnan\tnan\tnan\tnan\tnan\tnan".to_string(),
                    |v| {
                        v.iter()
                            .map(|x| format!("{x:.5}"))
                            .collect::<Vec<_>>()
                            .join("\t")
                    },
                )
            };
            let (nr, nc) = sd.news[i].as_ref().map_or((f32::NAN, f32::NAN), |c| {
                (
                    ratio(raw_at(c, pi), raw_at(c, pj)),
                    ratio(c.column_at(pi, w, block), c.column_at(pj, w, block)),
                )
            });
            let (or, oc) = (
                ratio(raw_at(ci, pi), raw_at(ci, pj)),
                ratio(ci.column_at(pi, w, block), ci.column_at(pj, w, block)),
            );
            let d =
                ((ci.center.0 - cj.center.0).powi(2) + (ci.center.1 - cj.center.1).powi(2)).sqrt();
            s.push_str(&format!(
                "{}\t{}\t{}\t{}\t{:.2}\t{}\t{:.3}\t{:.3}\t{}\t{:.4}\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\t{}\t{:.3}\t{:.3}\n",
                slow.frames,
                ci.id,
                cj.id,
                cells.len(),
                d,
                sd.exit[i],
                sd.gain,
                sd.z,
                u8::from(in_disk(pj)),
                r_rep,
                pr(i),
                pr(j),
                nr,
                nc,
                or,
                oc,
                sd.frames,
                sd.solo[i],
                sd.solo[j]
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

/// Eigen-decomposition of the symmetric `k x k` matrix `a` (cyclic
/// Jacobi): eigenvalues in descending order and the eigenvectors as the
/// columns of a row-major `k x k` matrix, in the same order.
fn sym_eig(a: &[f64], k: usize) -> (Vec<f64>, Vec<f64>) {
    let mut m = a.to_vec();
    let mut v = vec![0.0f64; k * k];
    for i in 0..k {
        v[i * k + i] = 1.0;
    }
    for _ in 0..64 {
        let off: f64 = (0..k)
            .flat_map(|i| (0..k).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| m[i * k + j].powi(2))
            .sum();
        let diag: f64 = (0..k).map(|i| m[i * k + i].powi(2)).sum();
        if off <= 1e-24 * diag.max(1e-300) {
            break;
        }
        for p in 0..k {
            for q in p + 1..k {
                let apq = m[p * k + q];
                if apq == 0.0 {
                    continue;
                }
                let theta = (m[q * k + q] - m[p * k + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for r in 0..k {
                    let (mrp, mrq) = (m[r * k + p], m[r * k + q]);
                    m[r * k + p] = c * mrp - s * mrq;
                    m[r * k + q] = s * mrp + c * mrq;
                }
                for r in 0..k {
                    let (mpr, mqr) = (m[p * k + r], m[q * k + r]);
                    m[p * k + r] = c * mpr - s * mqr;
                    m[q * k + r] = s * mpr + c * mqr;
                }
                for r in 0..k {
                    let (vrp, vrq) = (v[r * k + p], v[r * k + q]);
                    v[r * k + p] = c * vrp - s * vrq;
                    v[r * k + q] = s * vrp + c * vrq;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by(|&x, &y| m[y * k + y].total_cmp(&m[x * k + x]));
    let vals = order.iter().map(|&i| m[i * k + i]).collect();
    let mut vecs = vec![0.0f64; k * k];
    for (c, &i) in order.iter().enumerate() {
        for r in 0..k {
            vecs[r * k + c] = v[r * k + i];
        }
    }
    (vals, vecs)
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
    use crate::discover::split_excess;

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
            0,
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
                let rep = st.replay(gamma, JointSign::Off, 1, false).expect("replay");
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

    /// Two Gaussian cells 0.75 diameters apart on a 24 x 40 canvas
    /// (footprints j, i and the width).
    fn truth() -> (Vec<f32>, Vec<f32>, usize) {
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
        (gauss(cj), gauss(ci), w)
    }

    /// A store on `pix` (members j, i; columns `cols`, member-major on `pix`)
    /// fed `frames` noisy frames of the true cells, its fast traces solved
    /// with the store's columns. Returns the store and the true footprints.
    fn fed_store(
        pix: Vec<u32>,
        cols: Vec<f32>,
        frames: usize,
        seed: u64,
    ) -> (ClusterStore, Vec<f32>, Vec<f32>, usize) {
        let (aj, ai, w) = truth();
        let d = 14.0f32;
        let cj = (12.0f32, 20.0 - 0.375 * d);
        let ci = (12.0f32, 20.0 + 0.375 * d);
        let n = pix.len();
        let mut st = ClusterStore::new(
            vec![1, 2],
            vec![(cj, 30.0), (ci, 30.0)],
            pix,
            vec![1.0; n],
            w,
            0,
            cols,
            3000,
            0,
        );
        let mut rng = seed;
        let mut unif = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut c1, mut c2) = (0.0f64, 0.0f64);
        let mut x = [0.0f64; 2];
        for _ in 0..frames {
            for c in [&mut c1, &mut c2] {
                *c *= 0.95;
                if unif() < 0.01 {
                    *c += -unif().max(1e-12).ln();
                }
            }
            let y: Vec<f32> = st
                .pix
                .iter()
                .map(|&p| {
                    let p = p as usize;
                    let z = (-2.0 * unif().max(1e-12).ln()).sqrt()
                        * (2.0 * std::f64::consts::PI * unif()).cos();
                    (f64::from(aj[p]) * c1 + f64::from(ai[p]) * c2 + 0.5 * z) as f32
                })
                .collect();
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
            st.push(&y, &[x[0] as f32, x[1] as f32], 1.0);
        }
        (st, aj, ai, w)
    }

    fn on(a: &[f32], pix: &[u32]) -> Vec<f32> {
        pix.iter().map(|&p| a[p as usize]).collect()
    }

    /// Started at the truth, the per-member rule (split-half noise from the
    /// joint fit's standard errors) proposes neither member; the replay's
    /// own halves, which share one basis, understate the noise.
    #[test]
    fn a_member_at_the_truth_is_not_proposed() {
        let (n, mut members_rule, mut cluster_rule) = (24 * 40, 0, 0);
        for seed in [11u64, 12, 13, 14, 15] {
            let pix: Vec<u32> = (0..n as u32).collect();
            let (aj, ai, _) = truth();
            let cols = [on(&aj, &pix), on(&ai, &pix)].concat();
            let (mut st, aj, ai, _) = fed_store(pix.clone(), cols, 3000, seed);
            let gamma = 1.0;
            let rep = st.replay(gamma, JointSign::All, 1, false).expect("replay");
            let is = vec![1.0f64; n];
            for (k, a) in [(0usize, &aj), (1, &ai)] {
                let cur: Vec<f64> = a.iter().map(|&v| f64::from(v)).collect();
                let v = rep.sa[k] * rep.sa[k] + rep.sb[k] * rep.sb[k];
                if split_excess(&rep.h[k], &cur, &is, None, v) > 0.0 {
                    members_rule += 1;
                }
                if split_excess(&rep.h[k], &cur, &is, Some((&rep.ha[k], &rep.hb[k])), 0.0) > 0.0 {
                    cluster_rule += 1;
                }
            }
        }
        assert_eq!(
            members_rule, 0,
            "per-member rule proposed a member at the truth"
        );
        assert!(
            cluster_rule >= 5,
            "replay halves proposed only {cluster_rule} of 10"
        );
    }

    /// Moving a store to a larger, shifted pixel set keeps its stored frames
    /// and its estimate on the shared pixels; the new pixels start at the
    /// current model (the estimate there follows the current columns).
    #[test]
    fn a_moved_store_keeps_its_history_and_starts_new_pixels_at_the_model() {
        let (h, w) = (24usize, 40usize);
        let full: Vec<u32> = (0..(h * w) as u32).collect();
        let (aj, ai, _) = truth();
        // The old pixels: the left 30 columns.
        let old: Vec<u32> = full
            .iter()
            .copied()
            .filter(|&p| (p as usize % w) < 30)
            .collect();
        let cols = [on(&aj, &old), on(&ai, &old)].concat();
        let (mut st, aj, ai, _) = fed_store(old.clone(), cols, 2500, 7);
        let before = st.replay(1.0, JointSign::Off, 1, false).expect("replay");
        let stored = st.stored();
        // The new pixels: the right 34 columns (drops 6, adds 10).
        let new: Vec<u32> = full
            .iter()
            .copied()
            .filter(|&p| (p as usize % w) >= 6)
            .collect();
        let cols = [on(&aj, &new), on(&ai, &new)].concat();
        let disks = st.disks.clone();
        assert!(st.move_to(disks, new.clone(), vec![1.0; new.len()], w, 0, cols));
        assert_eq!(st.stored(), stored);
        let after = st.replay(1.0, JointSign::Off, 1, false).expect("replay");
        for k in 0..2 {
            // Shared pixels: the estimate is unchanged.
            let (mut num, mut den) = (0.0f64, 0.0f64);
            for (i1, p) in new.iter().enumerate() {
                if let Ok(i0) = old.binary_search(p) {
                    let d = f64::from(after.h[k][i1] - before.h[k][i0]);
                    num += d * d;
                    den += f64::from(before.h[k][i0]).powi(2);
                }
            }
            assert!(
                num / den < 0.01,
                "member {k}: shared-pixel change {}",
                num / den
            );
            // New pixels: proportional to the current (true) column.
            let truth = if k == 0 { &aj } else { &ai };
            let peak = new
                .iter()
                .enumerate()
                .max_by(|a, b| truth[*a.1 as usize].total_cmp(&truth[*b.1 as usize]))
                .map(|(i, _)| i)
                .expect("pixels");
            let scale = after.h[k][peak] / truth[new[peak] as usize];
            for (i1, &p) in new.iter().enumerate() {
                if (p as usize % w) >= 30 && truth[p as usize] > 0.2 {
                    let e = after.h[k][i1] / scale - truth[p as usize];
                    assert!(
                        e.abs() < 0.1,
                        "member {k}: new pixel {p} off the model by {e}"
                    );
                }
            }
        }
    }

    #[test]
    fn sym_eig_diagonalises() {
        let a = [4.0, 1.0, 0.5, 1.0, 3.0, 0.2, 0.5, 0.2, 1.0];
        let (vals, v) = sym_eig(&a, 3);
        assert!(vals[0] >= vals[1] && vals[1] >= vals[2]);
        for c in 0..3 {
            for r in 0..3 {
                let av: f64 = (0..3).map(|k| a[r * 3 + k] * v[k * 3 + c]).sum();
                assert!((av - vals[c] * v[r * 3 + c]).abs() < 1e-9);
            }
        }
    }

    /// Gaussian cells of diameter 14 px on a 24 x `w` canvas at the given
    /// centres (peak 1).
    fn cells_at(w: usize, centres: &[(f32, f32)]) -> Vec<Vec<f32>> {
        let sig = 14.0f32 / 2.3548;
        centres
            .iter()
            .map(|&c| {
                (0..24 * w)
                    .map(|p| {
                        let (y, x) = ((p / w) as f32, (p % w) as f32);
                        (-((y - c.0).powi(2) + (x - c.1).powi(2)) / (2.0 * sig * sig)).exp()
                    })
                    .collect()
            })
            .collect()
    }

    /// Feeds `frames` noisy frames of the true cells `truth` (independent
    /// sparse traces) to `st`, whose members' fast traces are solved with
    /// the store's columns; every 200 frames (after 512) the members'
    /// columns become the replay's joint estimate (clipped, peak 1).
    fn run_store(
        st: &mut ClusterStore,
        truth: &[Vec<f32>],
        frames: usize,
        rng: &mut u64,
        replays: bool,
    ) {
        let n = st.pix.len();
        let kk = st.ids.len();
        let mut unif = || {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 7;
            *rng ^= *rng << 17;
            (*rng >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut c = vec![0.0f64; truth.len()];
        let mut x = vec![0.0f64; kk];
        for t in 0..frames {
            for ck in c.iter_mut() {
                *ck *= 0.95;
                if unif() < 0.01 {
                    *ck += -unif().max(1e-12).ln();
                }
            }
            let y: Vec<f32> = st
                .pix
                .iter()
                .map(|&p| {
                    let z = (-2.0 * unif().max(1e-12).ln()).sqrt()
                        * (2.0 * std::f64::consts::PI * unif()).cos();
                    let l: f64 = truth
                        .iter()
                        .zip(&c)
                        .map(|(a, ck)| f64::from(a[p as usize]) * ck)
                        .sum();
                    (l + 0.5 * z) as f32
                })
                .collect();
            let a = st.white_cols();
            let mut g = vec![0.0f64; kk * kk];
            let mut b = vec![0.0f64; kk];
            for p in 0..n {
                for k in 0..kk {
                    b[k] += a[p * kk + k] * f64::from(y[p]);
                    for l in 0..kk {
                        g[k * kk + l] += a[p * kk + k] * a[p * kk + l];
                    }
                }
            }
            nnls(&g, &b, kk, &mut x);
            let xf: Vec<f32> = x.iter().map(|&v| v as f32).collect();
            st.push(&y, &xf, 1.0);
            if replays && t % 200 == 199 && st.stored() > 512 {
                if let Some(rep) = st.replay(1.0, JointSign::All, 1, false) {
                    let mut cols = Vec::with_capacity(kk * n);
                    for h in &rep.h {
                        let m = h.iter().cloned().fold(0.0f32, f32::max).max(1e-12);
                        cols.extend(h.iter().map(|v| v.max(0.0) / m));
                    }
                    st.cols = cols;
                }
            }
        }
    }

    /// Three cells in a line, j - i - k, one diameter apart; k is not in
    /// the library. Without leftover light the replay lets i swallow k;
    /// with one leftover direction (a provisional component) it does not
    /// (`design_discover_lookback.md` toy B).
    #[test]
    fn an_undetected_neighbour_is_not_absorbed() {
        let w = 64usize;
        let (cj, ci, ck) = ((12.0f32, 18.0f32), (12.0f32, 32.0f32), (12.0f32, 46.0f32));
        let t = cells_at(w, &[cj, ci, ck]);
        let pix: Vec<u32> = (0..(24 * w) as u32).collect();
        let pk = 12 * w + 46;
        let pi = 12 * w + 32;
        let mut res = Vec::new();
        for m in [0usize, 1] {
            let mut worst = 0.0f32;
            let mut own = f32::INFINITY;
            for seed in [3u64, 4, 5] {
                let cols = [on(&t[0], &pix), on(&t[1], &pix)].concat();
                let mut st = ClusterStore::new(
                    vec![1, 2],
                    vec![(cj, 40.0), (ci, 40.0)],
                    pix.clone(),
                    vec![1.0; pix.len()],
                    w,
                    0,
                    cols,
                    3000,
                    m,
                );
                // Disks cover the whole canvas (no support rule here).
                st.cover.iter_mut().for_each(|c| *c = 3);
                let mut rng = seed * 7919;
                run_store(&mut st, &t, 6000, &mut rng, true);
                let n = pix.len();
                let ci_col = &st.cols[n..2 * n];
                worst = worst.max(ci_col[pk] / t[1][pk]);
                own = own.min(ci_col[pi]);
            }
            res.push((worst, own));
        }
        assert!(
            res[0].0 > 1.3,
            "without leftover light i at k / truth = {}",
            res[0].0
        );
        assert!(
            res[1].0 < 1.3,
            "with a provisional component i at k / truth = {}",
            res[1].0
        );
    }

    /// A cell born next to a store whose leftover direction already holds
    /// its light keeps the store's history (no restart) and starts filling
    /// where its older neighbour sits from the first replays (a restarted
    /// store waits for 4 (K + 1) frames and then 512 in this toy, and sits
    /// at 0 for its first 400 frames); the older cell is not over-filled
    /// toward it. (In this toy the restarted store catches up after about
    /// 1500 frames: 0.66 vs 0.57 at 1600-2200 frames after the birth.)
    #[test]
    fn a_store_survives_a_birth() {
        let w = 40usize;
        let d = 14.0f32;
        let (cj, ci) = ((12.0f32, 20.0 - 0.375 * d), (12.0f32, 20.0 + 0.375 * d));
        let t = cells_at(w, &[cj, ci]);
        let pix: Vec<u32> = (0..(24 * w) as u32).collect();
        let n = pix.len();
        let (pj, pi) = (
            12 * w + cj.1.round() as usize,
            12 * w + ci.1.round() as usize,
        );
        let mut st = ClusterStore::new(
            vec![1],
            vec![(cj, 30.0)],
            pix.clone(),
            vec![1.0; n],
            w,
            0,
            on(&t[0], &pix),
            3000,
            1,
        );
        let mut rng = 4242u64;
        // j alone for 3000 frames: i's light is leftover light.
        run_store(&mut st, &t, 3000, &mut rng, false);
        let stored = st.stored();
        // i is born bitten: nothing on j's side of the midpoint.
        let bitten: Vec<f32> = (0..n)
            .map(|p| if (p % w) as f32 > 20.0 { t[1][p] } else { 0.0 })
            .collect();
        let cols = [on(&t[0], &pix), bitten].concat();
        assert!(st.rebase(
            vec![1, 2],
            vec![(cj, 30.0), (ci, 30.0)],
            pix.clone(),
            vec![1.0; n],
            w,
            1,
            cols,
            &[Some(0), None],
            &[false, true],
        ));
        assert_eq!(st.stored(), stored, "history kept across the birth");
        run_store(&mut st, &t, 1000, &mut rng, true);
        let truth_i = t[1][pj];
        let fill = st.cols[n + pj] / truth_i;
        assert!(
            fill > 0.3,
            "newborn at the older cell's centre / truth = {fill}"
        );
        let over = st.cols[pi] / t[0][pi];
        assert!(
            over < 1.3,
            "older cell at the newborn's centre / truth = {over}"
        );
    }
}
