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
use super::wire::{Reader, Writer};
use super::{
    column_on, paired_z, solve_dense, EditScope, Frames, JointAdmit, JointSign, JointUpdate,
    ReplayStats, SlowLoop, Start,
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

/// `Σ a_i b_i` in eight interleaved f32 partial sums (lane `i mod 8`),
/// added pairwise at the end: vectorises, where one running sum is a
/// serial chain of dependent adds. Differs from the serial sum by float
/// rounding only.
#[inline]
pub(crate) fn dot_lanes(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut acc = [0.0f32; 8];
    let (ca, ra) = a.as_chunks::<8>();
    let (cb, rb) = b.as_chunks::<8>();
    for (x, y) in ca.iter().zip(cb) {
        for l in 0..8 {
            acc[l] += x[l] * y[l];
        }
    }
    for (l, (x, y)) in ra.iter().zip(rb).enumerate() {
        acc[l] += x * y;
    }
    ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]))
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
    /// Cache of `pix` as contiguous row runs (empty until
    /// [`ClusterStore::push_frame`] first needs it).
    runs: Vec<(u32, u32)>,
    /// Frames pushed.
    pub k: u64,
    /// The store's own last joint estimate, whitened (pixel-major `n x K`),
    /// carried to the next replay's trace step (`joint_carry`).
    est: Option<Vec<f64>>,
    /// Set by [`ClusterStore::replay`] once it has refreshed the basis, and
    /// when it has set `est`; read by a visit job to tell the owner what its
    /// copy of the store changed ([`ClusterOut`]). Not part of the store.
    visited: bool,
    est_dirty: bool,
    /// On a runner: the visited tile owns this cluster (a visit may change
    /// its flag and store), so the result reports it.
    touched: bool,
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
            hist: RingHistory::new(cap, kk),
            runs: Vec::new(),
            k: 0,
            est: None,
            visited: false,
            est_dirty: false,
            touched: true,
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
            .map(|j| dot_lanes(&self.ut[j * n..(j + 1) * n], r))
            .collect();
        self.hist
            .append(&v, self.k, (self.k / 256).is_multiple_of(2));
        self.k += 1;
    }

    /// Test access: the running sums `cy`, `sr` and the stored coordinates.
    #[cfg(test)]
    pub fn sums(&self) -> (&[f32], &[f32], &[f32]) {
        (&self.cy, &self.sr, &self.hist.v)
    }

    /// The slow loop's push of one fitting frame: the whitened cluster
    /// residual `r̃ = (y − model − lv_owner + Σ_k a_k c_k) / σ` on `pix`
    /// (`lv` each member's ring level, `None` without a ring background),
    /// `c` the members' traces. Element by element the same arithmetic as
    /// building `r̃` and calling [`ClusterStore::push`], read in contiguous
    /// row runs. `false` (nothing pushed) when `r̃` or `c` is not finite.
    /// `buf` is scratch.
    pub fn push_frame(
        &mut self,
        frame: &[f32],
        model: &[f32],
        lv: Option<&[f32]>,
        c: &[f32],
        w: f64,
        buf: &mut Vec<f32>,
    ) -> bool {
        let n = self.pix.len();
        if self.runs.is_empty() && n > 0 {
            self.runs = super::fpstats::pixel_runs(&self.pix);
        }
        // Scratch of at least `n` (grown only: no fill per call).
        if buf.len() < n {
            buf.resize(n, 0.0);
        }
        let buf = &mut buf[..n];
        let mut i = 0;
        for &(s, len) in &self.runs {
            let (s, len) = (s as usize, len as usize);
            let (y, m) = (&frame[s..s + len], &model[s..s + len]);
            let out = &mut buf[i..i + len];
            match lv {
                None => {
                    for j in 0..len {
                        out[j] = y[j] - m[j];
                    }
                }
                Some(lv) => {
                    let own = &self.owner[i..i + len];
                    for j in 0..len {
                        out[j] = y[j] - m[j] - lv[own[j] as usize];
                    }
                }
            }
            i += len;
        }
        assert_eq!(i, n, "runs cover the pixels");
        for (k, &ck) in c.iter().enumerate() {
            if ck != 0.0 {
                for (r, &a) in buf.iter_mut().zip(&self.cols[k * n..(k + 1) * n]) {
                    *r += a * ck;
                }
            }
        }
        let mut bad = false;
        for (r, &is) in buf.iter_mut().zip(&self.is) {
            *r *= is;
            bad |= !r.is_finite();
        }
        if bad || !c.iter().all(|v| v.is_finite()) {
            return false;
        }
        self.push(buf, c, w);
        true
    }

    /// Refresh the basis to `orth(CY)` (centred; a member whose trace has no
    /// variance yet keeps its current column) and re-express the stored
    /// frames in it, `V ← U'ᵀ U V`.
    fn refresh_basis(&mut self) {
        let (u2, r2) = self.cy_basis();
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
        let mut rc = vec![0.0f64; n1 * r0];
        for i in 0..n1 {
            match self.pix.binary_search(&pix[i]) {
                Ok(i0) => {
                    sr[i] = self.sr[i0];
                    for k in 0..kk {
                        cy[k * n1 + i] = self.cy[k * n0 + i0];
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
        self.runs.clear();
        self.is = is;
        self.owner = owner;
        self.cover = cover;
        self.version = version;
        self.cols = cols;
        self.cy = cy;
        self.sr = sr;
        self.est = est;
        // The basis on the new pixels, and every stored frame in it:
        // v' = U'ᵀ Rc v.
        let (u1, r1) = self.cy_basis();
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
    /// `l1` is the trace step's L1 weight (see `SlowLoopConfig::joint_l1`).
    pub fn replay(
        &mut self,
        gamma: f64,
        sign_rule: JointSign,
        iters: usize,
        carry: bool,
        l1: f64,
    ) -> Option<Replay> {
        let (n, kk) = (self.pix.len(), self.ids.len());
        if self.hist.stored() < 4 * (kk + 1) || self.sw <= 0.0 {
            return None;
        }
        self.refresh_basis();
        self.visited = true;
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
        let start = match (&self.est, carry) {
            (Some(e), true) => e.clone(),
            _ => self.white_cols(),
        };
        // The L1 trace step, unless it silences a member in either half of
        // the stored frames (a dim member whose events all fall below the
        // threshold leaves its footprint fit singular): then the plain one.
        let traces = |a: &[f64]| -> Option<Vec<f64>> {
            let cs = solve_traces(a, &self.u, n, kk, r, &vv, l1)?;
            let live = |k: usize, half: bool| {
                (0..m)
                    .filter(|&s| hs[s] == half && cs[s * kk + k] > 0.0)
                    .nth(1)
                    .is_some()
            };
            if l1 > 0.0 && !(0..kk).all(|k| live(k, true) && live(k, false)) {
                return solve_traces(a, &self.u, n, kk, r, &vv, 0.0);
            }
            Some(cs)
        };
        let mut cs = traces(&start)?;
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
                if sign_rule != JointSign::Off {
                    let lo: Vec<bool> = idx
                        .iter()
                        .map(|&p| sign_rule == JointSign::All || self.cols[p * n + i] > 0.0)
                        .collect();
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
            cs = traces(&a)?;
        }
        let (h, se) = fit(&cs, &|_| true)?;
        let (ha, sa) = fit(&cs, &|s| hs[s])?;
        let (hb, sb) = fit(&cs, &|s| !hs[s])?;
        if carry {
            let mut e = vec![0.0f64; n * kk];
            for k in 0..kk {
                for i in 0..n {
                    e[i * kk + k] = f64::from(h[k][i]) * f64::from(self.is[i]);
                }
            }
            self.est = Some(e);
            self.est_dirty = true;
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
        #[cfg_attr(feature = "threads", allow(unused_mut))]
        let mut cbuf = std::mem::take(&mut self.cbuf);
        // Feature `threads` (measurement): the clusters' pushes, prepared
        // here in order, run on a rayon pool after this loop.
        #[cfg(feature = "threads")]
        let mut prep: Vec<Option<(Vec<f32>, Option<Vec<f32>>)>> =
            Vec::with_capacity(self.clusters.len());
        for ci in 0..self.clusters.len() {
            #[cfg(feature = "threads")]
            prep.push(None);
            if let Some(o) = &self.lb_only {
                if !self.clusters[ci].ids.iter().any(|id| o.contains(id)) {
                    continue;
                }
            }
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
            if st.version != version {
                st.cols.clear();
                for &s in &slots {
                    st.cols.extend(column_on(lib, s, &st.pix));
                }
                st.version = version;
            }
            let c: Vec<f32> = slots.iter().map(|&s| traces.traces[s]).collect();
            let lv: Option<Vec<f32>> =
                ring.then(|| slots.iter().map(|&s| traces.background[s]).collect());
            #[cfg(feature = "threads")]
            {
                prep[ci] = Some((c, lv));
            }
            #[cfg(not(feature = "threads"))]
            {
                let n = st.pix.len();
                if !st.push_frame(
                    frame,
                    &self.model,
                    lv.as_deref(),
                    &c,
                    f64::from(w),
                    &mut cbuf,
                ) {
                    self.replay_stats.skipped_frames += 1;
                    continue;
                }
                work += (n * (3 * c.len() + 3)) as u64;
            }
        }
        #[cfg(feature = "threads")]
        {
            use rayon::prelude::*;
            let model = &self.model;
            let (skipped, w_sum) = self
                .clusters
                .par_iter_mut()
                .zip(prep.par_iter())
                .map_init(Vec::new, |buf, (st, p)| {
                    let Some((c, lv)) = p else {
                        return (0u64, 0u64);
                    };
                    let n = st.pix.len();
                    if st.push_frame(frame, model, lv.as_deref(), c, f64::from(w), buf) {
                        (0, (n * (3 * c.len() + 3)) as u64)
                    } else {
                        (1, 0)
                    }
                })
                .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
            self.replay_stats.skipped_frames += skipped;
            work += w_sum;
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
        (base_test, start): (&[Fit], Option<&Start>),
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
                f64::from(self.cfg.joint_l1),
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
                let f = self.solve_all_from(&pr, test_fr, start);
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
                            let f = self.solve_all_from(&pr, test_fr, start);
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
/// `n x kk`): `argmin_{c ≥ 0} ‖U v − A c‖² + 2 l1 Σ_k ‖a_k‖ c_k` per
/// frame (`l1` in trace-noise SDs, scale-invariant). `None` when a column
/// is empty.
fn solve_traces(
    a: &[f64],
    u: &[f64],
    n: usize,
    kk: usize,
    r: usize,
    vv: &[f64],
    l1: f64,
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
    let shrink: Vec<f64> = (0..kk).map(|k| l1 * g[k * kk + k].sqrt()).collect();
    let m = vv.len() / r;
    let mut cs = vec![0.0f64; m * kk];
    let mut b = vec![0.0f64; kk];
    for s in 0..m {
        for p in 0..kk {
            b[p] = (0..r).map(|j| bm[p * r + j] * vv[s * r + j]).sum::<f64>() - shrink[p];
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

// ---------------------------------------------------------------------------
// Visit jobs (`shard.rs`): a refine visit run by a `VisitRunner` replays the
// stores it is sent and reports what its copies changed.
//
// The owner keeps the stores (frames keep arriving into them while a job is
// out). A job carries the full store of every cluster the visited tile owns
// and can replay (`ClusterStore::encode`; about 100-700 KB each, only the
// visited tile's, not all stores), and the member ids and `ok` flag of the
// other clusters its cells belong to (the visit reads those flags to decide
// which cells the per-cell refinement skips). The runner installs them, runs
// the unchanged visit (`refine_clusters`: replay, proposal, gate; the gate
// needs the tile's held-out frames, which the job holds anyway) and returns,
// per owned cluster, a [`ClusterOut`]: the `ok` flag, whether the replay
// refreshed the basis, and its carried estimate. The owner re-does the cheap
// basis refresh on its own, current store (it gives the same store as the
// replay's own when no frame arrived in between, and the right one when
// some did) and takes the estimate. The proposals themselves travel as
// ordinary ops of the visit result, applied by the owner in order, so the
// owner's gate-and-commit is the existing `apply_job`.
// ---------------------------------------------------------------------------

/// A cluster as a visit job carries it.
#[derive(Debug, Clone)]
pub(crate) struct JobCluster {
    pub ids: Vec<u64>,
    pub ok: bool,
    /// The visited tile owns the cluster (its first member's centre is in
    /// the tile's core).
    pub owned: bool,
    /// The store, when the visit can replay it (every member within reach
    /// of the tile).
    pub store: Option<ClusterStore>,
}

/// What a visit did to a cluster it owned, for the owner to apply.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClusterOut {
    pub ids: Vec<u64>,
    pub ok: bool,
    /// The replay refreshed the basis of the store.
    pub refreshed: bool,
    /// The store's carried estimate after the replay (`joint_carry`), with
    /// the pixel set it is on.
    pub est: Option<(Vec<f64>, (usize, u32, u32))>,
}

impl ReplayStats {
    /// The counters a visit's replays move (the rest are the owner's).
    pub(crate) fn visit_fields(&self) -> [u64; 7] {
        [
            self.replays,
            self.replay_none,
            self.low_snr,
            self.converged,
            self.proposals,
            self.accepted,
            self.members_replaced,
        ]
    }

    pub(crate) fn from_visit_fields(v: [u64; 7]) -> ReplayStats {
        ReplayStats {
            replays: v[0],
            replay_none: v[1],
            low_snr: v[2],
            converged: v[3],
            proposals: v[4],
            accepted: v[5],
            members_replaced: v[6],
            ..ReplayStats::default()
        }
    }

    pub(crate) fn add_visit(&mut self, d: &ReplayStats) {
        self.replays += d.replays;
        self.replay_none += d.replay_none;
        self.low_snr += d.low_snr;
        self.converged += d.converged;
        self.proposals += d.proposals;
        self.accepted += d.accepted;
        self.members_replaced += d.members_replaced;
    }
}

impl RingHistory {
    /// The frames newest first, with the ring's capacity and width.
    fn write(&self, w: &mut Writer) {
        w.usize(self.cap);
        w.usize(self.width);
        w.usize(self.len);
        for s in 0..self.len {
            let slot = self.slot(s);
            for &x in &self.v[slot * self.width..(slot + 1) * self.width] {
                w.f32(x);
            }
            w.u64(self.at[slot]);
            w.bool(self.half[slot]);
        }
    }

    fn read(r: &mut Reader) -> Option<RingHistory> {
        let (cap, width, len) = (r.usize()?, r.usize()?, r.usize()?);
        if cap == 0 || cap > 1 << 20 || width > 8 || len > cap {
            return None;
        }
        // The empty tail of the ring is allocated here, not sent; every
        // frame present is read with bounds checks below.
        let mut h = RingHistory::new(cap, width);
        for s in 0..len {
            let slot = len - 1 - s;
            for j in 0..width {
                h.v[slot * width + j] = r.f32()?;
            }
            h.at[slot] = r.u64()?;
            h.half[slot] = r.bool()?;
        }
        h.len = len;
        h.head = len % cap;
        Some(h)
    }
}

impl ClusterStore {
    /// A store of no pixels, standing for a cluster the visited tile does
    /// not own (a visit only reads its members and `ok` flag) or owns but
    /// cannot replay (`owned`: a member is out of reach of the tile, so the
    /// visit only marks the cluster not ok).
    pub fn stub(ids: Vec<u64>, owned: bool) -> ClusterStore {
        let kk = ids.len();
        ClusterStore {
            ids,
            disks: Vec::new(),
            pix: Vec::new(),
            is: Vec::new(),
            owner: Vec::new(),
            cover: Vec::new(),
            version: 0,
            cols: Vec::new(),
            cy: Vec::new(),
            sr: Vec::new(),
            sc: vec![0.0; kk],
            scc: vec![0.0; kk * kk],
            sw: 0.0,
            u: Vec::new(),
            ut: Vec::new(),
            rank: 0,
            hist: RingHistory::new(1, kk),
            runs: Vec::new(),
            k: 0,
            est: None,
            visited: false,
            est_dirty: false,
            touched: owned,
        }
    }

    /// Identifies the pixel set (the carried estimate is only valid on it).
    pub fn pix_key(&self) -> (usize, u32, u32) {
        (
            self.pix.len(),
            self.pix.first().copied().unwrap_or(0),
            self.pix.last().copied().unwrap_or(0),
        )
    }

    /// What a visit's replay changed in its copy of this store.
    pub fn out(&self, ok: bool) -> ClusterOut {
        ClusterOut {
            ids: self.ids.clone(),
            ok,
            refreshed: self.visited,
            est: self
                .est_dirty
                .then(|| self.est.clone().map(|e| (e, self.pix_key())))
                .flatten(),
        }
    }

    /// Bytes of [`ClusterStore::encode`] (pinned by a test).
    pub fn wire_bytes(&self) -> usize {
        let (kk, n) = (self.ids.len(), self.pix.len());
        let h = &self.hist;
        8 + 8 * kk
            + 8
            + 12 * self.disks.len()
            + 8
            + 4 * n
            + 8
            + 4 * self.is.len()
            + 8
            + self.owner.len()
            + 8
            + self.cover.len()
            + 8
            + 8
            + 4 * self.cols.len()
            + 8
            + 4 * self.cy.len()
            + 8
            + 4 * self.sr.len()
            + 8
            + 8 * self.sc.len()
            + 8
            + 8 * self.scc.len()
            + 8
            + 8
            + 8
            + 8 * self.u.len()
            + 24
            + h.len * (4 * h.width + 9)
            + 8
            + 1
            + self.est.as_ref().map_or(0, |e| 8 + 8 * e.len())
    }

    pub fn encode(&self, w: &mut Writer) {
        w.u64s(&self.ids);
        w.usize(self.disks.len());
        for &((cy, cx), r) in &self.disks {
            w.f32(cy);
            w.f32(cx);
            w.f32(r);
        }
        w.u32s(&self.pix);
        w.f32s(&self.is);
        w.usize(self.owner.len());
        self.owner.iter().for_each(|&b| w.u8(b));
        w.usize(self.cover.len());
        self.cover.iter().for_each(|&b| w.u8(b));
        w.u64(self.version);
        w.f32s(&self.cols);
        w.f32s(&self.cy);
        w.f32s(&self.sr);
        w.f64s(&self.sc);
        w.f64s(&self.scc);
        w.f64(self.sw);
        // `ut` is the same basis as f32, rebuilt on decode.
        w.usize(self.rank);
        w.f64s(&self.u);
        self.hist.write(w);
        w.u64(self.k);
        w.bool(self.est.is_some());
        if let Some(e) = &self.est {
            w.f64s(e);
        }
    }

    pub fn decode(r: &mut Reader) -> Option<ClusterStore> {
        let ids = r.u64s()?;
        let kk = ids.len();
        if kk == 0 || kk > 8 {
            return None;
        }
        let nd = r.count(12)?;
        let disks = (0..nd)
            .map(|_| Some(((r.f32()?, r.f32()?), r.f32()?)))
            .collect::<Option<Vec<_>>>()?;
        let pix = r.u32s()?;
        let n = pix.len();
        let is = r.f32s()?;
        let bytes = |r: &mut Reader| -> Option<Vec<u8>> {
            let m = r.count(1)?;
            (0..m).map(|_| r.u8()).collect()
        };
        let owner = bytes(r)?;
        let cover = bytes(r)?;
        let version = r.u64()?;
        let cols = r.f32s()?;
        let cy = r.f32s()?;
        let sr = r.f32s()?;
        let sc = r.f64s()?;
        let scc = r.f64s()?;
        let sw = r.f64()?;
        let rank = r.usize()?;
        let u = r.f64s()?;
        let hist = RingHistory::read(r)?;
        let k = r.u64()?;
        let est = if r.bool()? { Some(r.f64s()?) } else { None };
        let ok = n > 0
            && nd == kk
            && is.len() == n
            && owner.len() == n
            && cover.len() == n
            && cols.len() == kk * n
            && cy.len() == kk * n
            && sr.len() == n
            && sc.len() == kk
            && scc.len() == kk * kk
            && rank <= kk
            && u.len() == rank * n
            && hist.width == kk
            && est.as_ref().is_none_or(|e| e.len() == n * kk);
        if !ok {
            return None;
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
            cy,
            sr,
            sc,
            scc,
            sw,
            u: Vec::new(),
            ut: Vec::new(),
            rank: 0,
            hist,
            runs: Vec::new(),
            k,
            est,
            visited: false,
            est_dirty: false,
            touched: true,
        };
        s.set_basis(u, rank);
        Some(s)
    }
}

impl JobCluster {
    pub fn encode(&self, w: &mut Writer) {
        w.u64s(&self.ids);
        w.bool(self.ok);
        w.bool(self.owned);
        w.bool(self.store.is_some());
        if let Some(s) = &self.store {
            s.encode(w);
        }
    }

    pub fn decode(r: &mut Reader) -> Option<JobCluster> {
        let ids = r.u64s()?;
        let ok = r.bool()?;
        let owned = r.bool()?;
        let store = if r.bool()? {
            let s = ClusterStore::decode(r)?;
            if s.ids != ids || !owned {
                return None;
            }
            Some(s)
        } else {
            None
        };
        Some(JobCluster {
            ids,
            ok,
            owned,
            store,
        })
    }
}

impl ClusterOut {
    pub fn encode(&self, w: &mut Writer) {
        w.u64s(&self.ids);
        w.bool(self.ok);
        w.bool(self.refreshed);
        w.bool(self.est.is_some());
        if let Some((e, (n, a, b))) = &self.est {
            w.f64s(e);
            w.usize(*n);
            w.u32(*a);
            w.u32(*b);
        }
    }

    pub fn decode(r: &mut Reader) -> Option<ClusterOut> {
        let ids = r.u64s()?;
        let ok = r.bool()?;
        let refreshed = r.bool()?;
        let est = if r.bool()? {
            Some((r.f64s()?, (r.usize()?, r.u32()?, r.u32()?)))
        } else {
            None
        };
        Some(ClusterOut {
            ids,
            ok,
            refreshed,
            est,
        })
    }
}

impl SlowLoop {
    /// The clusters visit `ti` needs (see above): for every cluster that has
    /// a member among the job's cells `cell_ids`, its ids and `ok` flag, and
    /// the store itself when its first member's centre lies in the tile's
    /// core (the cluster the visit may replay).
    pub(super) fn job_clusters(&self, ti: usize, cell_ids: &[u64]) -> Vec<JobCluster> {
        if !self.joint_active() || self.clusters.is_empty() {
            return Vec::new();
        }
        let core = self.tiles[ti].core;
        // The visit replays a cluster only when every member is within the
        // tile's rectangle; ship the store when they are within 2 px of it
        // (a centre may move that far before the visit gets to the cluster).
        let reach = super::shard::grow(self.tiles[ti].rect, 2, self.dims);
        let mut seen: Vec<usize> = Vec::new();
        for id in cell_ids {
            if let Some(&ci) = self.cluster_of.get(id) {
                if !seen.contains(&ci) {
                    seen.push(ci);
                }
            }
        }
        seen.sort_unstable();
        seen.into_iter()
            .map(|ci| {
                let st = &self.clusters[ci];
                let centre = |id: u64| self.cells.iter().find(|c| c.id == id).map(|c| c.center);
                let owned = centre(st.ids[0])
                    .is_some_and(|c| core.local(c.0 as usize, c.1 as usize).is_some());
                let reachable = owned
                    && st.ids.iter().all(|&id| {
                        centre(id)
                            .is_some_and(|c| reach.local(c.0 as usize, c.1 as usize).is_some())
                    });
                JobCluster {
                    ids: st.ids.clone(),
                    ok: self.cluster_ok[ci],
                    owned,
                    store: reachable.then(|| st.clone()),
                }
            })
            .collect()
    }

    /// [`SlowLoop::job_clusters`], counting what it sends.
    pub(super) fn job_clusters_counted(&mut self, ti: usize, cell_ids: &[u64]) -> Vec<JobCluster> {
        #[cfg(not(target_arch = "wasm32"))]
        let t0 = std::time::Instant::now();
        let jc = self.job_clusters(ti, cell_ids);
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.replay_stats.job_copy_ns += t0.elapsed().as_nanos() as u64;
        }
        for c in &jc {
            if let Some(s) = &c.store {
                let b = s.wire_bytes() as u64;
                self.replay_stats.job_stores += 1;
                self.replay_stats.job_store_bytes += b;
                self.replay_stats.job_store_max = self.replay_stats.job_store_max.max(b);
            }
        }
        jc
    }

    /// A runner's side of [`SlowLoop::job_clusters`]: the job's clusters
    /// become this loop's, and the counters start from zero.
    pub(super) fn install_clusters(&mut self, jc: Vec<JobCluster>) {
        self.clear_clusters();
        self.replay_stats = ReplayStats::default();
        for c in jc {
            let ci = self.clusters.len();
            for &id in &c.ids {
                self.cluster_of.insert(id, ci);
            }
            self.cluster_ok.push(c.ok);
            self.clusters.push(
                c.store
                    .unwrap_or_else(|| ClusterStore::stub(c.ids, c.owned)),
            );
        }
    }

    /// After the visit: what it did to the stores it owned and the counters
    /// it moved. The copies are dropped.
    pub(super) fn take_cluster_outs(&mut self) -> (Vec<ClusterOut>, ReplayStats) {
        let outs = self
            .clusters
            .iter()
            .zip(&self.cluster_ok)
            .filter(|(c, _)| c.touched)
            .map(|(c, &ok)| c.out(ok))
            .collect();
        self.clear_clusters();
        (outs, std::mem::take(&mut self.replay_stats))
    }

    /// The owner applies a visit's [`ClusterOut`]s to its own stores (found
    /// by member ids; one that was rebuilt meanwhile is left alone).
    pub(super) fn apply_cluster_outs(&mut self, outs: Vec<ClusterOut>) {
        for o in outs {
            let Some(&ci) = o.ids.first().and_then(|id| self.cluster_of.get(id)) else {
                continue;
            };
            let st = &mut self.clusters[ci];
            if st.ids != o.ids {
                continue;
            }
            self.cluster_ok[ci] = o.ok;
            if o.refreshed {
                st.refresh_basis();
            }
            if let Some((e, key)) = o.est {
                if key == st.pix_key() {
                    st.est = Some(e);
                }
            }
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

    /// A small store with a wrapped ring, pushed with a fixed noise
    /// sequence, as a visit job would copy it.
    fn toy_store(frames: usize, cap: usize) -> ClusterStore {
        let (h, w) = (10usize, 16usize);
        let n = h * w;
        let g = |cy: f32, cx: f32| -> Vec<f32> {
            (0..n)
                .map(|p| {
                    let (y, x) = ((p / w) as f32, (p % w) as f32);
                    (-((y - cy).powi(2) + (x - cx).powi(2)) / 8.0).exp()
                })
                .collect()
        };
        let (a, b) = (g(5.0, 6.0), g(5.0, 9.0));
        let mut st = ClusterStore::new(
            vec![3, 7],
            vec![((5.0, 6.0), 9.0), ((5.0, 9.0), 9.0)],
            (0..n as u32).collect(),
            vec![1.0; n],
            w,
            4,
            [a.clone(), b.clone()].concat(),
            cap,
        );
        let mut rng = 99u64;
        let mut unif = move || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 11) as f64 / (1u64 << 53) as f64
        };
        for t in 0..frames {
            let (c1, c2) = (unif() as f32 * 3.0, unif() as f32 * 3.0);
            let y: Vec<f32> = (0..n)
                .map(|p| a[p] * c1 + b[p] * c2 + 0.2 * (unif() as f32 - 0.5))
                .collect();
            st.push(&y, &[c1, c2], 1.0 + t as f64 * 1e-3);
        }
        st
    }

    fn encoded(s: &ClusterStore) -> Vec<u8> {
        let mut w = Writer::default();
        s.encode(&mut w);
        w.buf
    }

    /// The job encoding of a store is lossless: a decoded copy encodes to
    /// the same bytes, replays to the same footprints bit for bit (with a
    /// full and with a wrapped ring), and a truncated or corrupted buffer
    /// is refused rather than panicking.
    #[test]
    fn a_store_round_trips_through_the_job_encoding() {
        for (frames, cap) in [(300, 600), (700, 280)] {
            let st = toy_store(frames, cap);
            let bytes = encoded(&st);
            let mut back = ClusterStore::decode(&mut Reader::new(&bytes)).expect("decode");
            assert_eq!(encoded(&back), bytes, "{frames} frames, ring {cap}");
            assert_eq!(st.wire_bytes(), bytes.len());
            let mut orig = st.clone();
            let a = orig
                .replay(0.99, JointSign::All, 1, true, 0.0)
                .expect("replay");
            let b = back
                .replay(0.99, JointSign::All, 1, true, 0.0)
                .expect("replay");
            assert_eq!(a.h, b.h);
            assert_eq!(a.ha, b.ha);
            assert_eq!(a.hb, b.hb);
            assert_eq!((a.se, a.sa, a.sb), (b.se, b.sa, b.sb));
            assert_eq!(encoded(&orig), encoded(&back));
        }
        let bytes = encoded(&toy_store(300, 600));
        for cut in [0, 1, 7, bytes.len() / 3, bytes.len() / 2, bytes.len() - 1] {
            assert!(ClusterStore::decode(&mut Reader::new(&bytes[..cut])).is_none());
        }
        for at in (0..bytes.len()).step_by(37) {
            let mut bad = bytes.clone();
            bad[at] ^= 0xFF;
            // May decode (a changed float) or not; must not panic.
            let _ = ClusterStore::decode(&mut Reader::new(&bad));
        }
    }

    /// A replay run on the job's copy, with its [`ClusterOut`] applied to
    /// the owner's store, leaves the owner exactly as the replay in place
    /// does (no frame arrives in between), and when frames did arrive the
    /// owner keeps them and still refreshes its basis.
    #[test]
    fn a_replay_on_a_copy_and_its_out_equal_the_replay_in_place() {
        let mut inplace = toy_store(400, 450);
        let rep = inplace
            .replay(0.99, JointSign::All, 1, true, 0.0)
            .expect("replay");
        let owner0 = toy_store(400, 450);
        let mut owner = owner0.clone();
        // The worker's copy, through the wire.
        let mut copy = ClusterStore::decode(&mut Reader::new(&encoded(&owner0))).expect("decode");
        let rep2 = copy
            .replay(0.99, JointSign::All, 1, true, 0.0)
            .expect("replay");
        assert_eq!(rep.h, rep2.h);
        let out = copy.out(true);
        assert!(out.refreshed && out.est.is_some());
        // The result's own encoding is lossless.
        let mut w = Writer::default();
        out.encode(&mut w);
        let out = ClusterOut::decode(&mut Reader::new(&w.buf)).expect("out");
        // Apply as the owner does.
        owner.refresh_basis();
        let (e, key) = out.est.clone().unwrap();
        assert_eq!(key, owner.pix_key());
        owner.est = Some(e);
        assert_eq!(encoded(&owner), encoded(&inplace));
        // Stubs and flag-only outs stay empty-handed.
        assert!(!ClusterStore::stub(vec![1, 2], false).out(true).refreshed);
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
                let rep = st
                    .replay(gamma, JointSign::Off, 1, false, 0.0)
                    .expect("replay");
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

    /// A wide cell `j` (1.4x the small cell's width) and a small cell `i`
    /// `sep` diameters apart, started at the leak fixed point: `j` is
    /// `max(a_j − λ a_i, 0)` (its tail under `i` cut away) and `i` is true,
    /// so `i`'s fast trace carries `λ c_j`. Frames are fed for `frames`
    /// steps, the store replayed every 200 (footprints clipped at zero,
    /// peak 1, as the finish path publishes them; no gate). Returns `j` at
    /// `i`'s centre over the truth, and the leak `b / a` of `i`'s and `j`'s
    /// fast traces (`trace ~ a own + b partner + c`) over the last 1500
    /// frames.
    fn bitten_pair(l1: f64, sep: f32, bite: f32, frames: usize, seed: u64) -> (f32, f64, f64) {
        let (h, w) = (28usize, 48usize);
        let d = 12.0f32;
        let (sig_i, sig_j) = (d / 2.3548, 1.4 * d / 2.3548);
        let cj = (14.0f32, 24.0 - 0.5 * sep * d);
        let ci = (14.0f32, 24.0 + 0.5 * sep * d);
        let gauss = |c: (f32, f32), sig: f32| -> Vec<f32> {
            (0..h * w)
                .map(|p| {
                    let (y, x) = ((p / w) as f32, (p % w) as f32);
                    (-((y - c.0).powi(2) + (x - c.1).powi(2)) / (2.0 * sig * sig)).exp()
                })
                .collect()
        };
        let (aj, ai) = (gauss(cj, sig_j), gauss(ci, sig_i));
        let n = h * w;
        let pix: Vec<u32> = (0..n as u32).collect();
        let pi = 14 * w + ci.1.round() as usize;
        let dot = |a: &[f32], b: &[f32]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
        let lam = bite * dot(&aj, &ai) / dot(&ai, &ai);
        let norm = |h: &[f32]| {
            let m = h.iter().cloned().fold(0.0f32, f32::max).max(1e-12);
            h.iter().map(|v| v.max(0.0) / m).collect::<Vec<f32>>()
        };
        let mut cur_j = norm(
            &aj.iter()
                .zip(&ai)
                .map(|(a, b)| a - lam * b)
                .collect::<Vec<_>>(),
        );
        let mut cur_i = ai.clone();
        let mut rng = seed;
        let mut unif = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 11) as f64 / (1u64 << 53) as f64
        };
        let cols = |a: &[f32], b: &[f32]| [a, b].concat();
        let mut st = ClusterStore::new(
            vec![1, 2],
            vec![(cj, 40.0), (ci, 40.0)],
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
        let mut rec: Vec<[f64; 4]> = Vec::new();
        for t in 0..frames {
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
            if t + 1500 >= frames {
                rec.push([x[0], x[1], c1, c2]);
            }
            wgt /= gamma;
            st.push(&y, &[x[0] as f32, x[1] as f32], wgt);
            if t % 200 == 199 && t > 512 {
                let rep = st
                    .replay(gamma, JointSign::All, 1, false, l1)
                    .expect("replay");
                cur_j = norm(&rep.h[0]);
                cur_i = norm(&rep.h[1]);
                st.cols = cols(&cur_j, &cur_i);
            }
        }
        // trace ~ a own + b partner + c (least squares on the record).
        let leak = |own: usize, other: usize, tr: usize| -> f64 {
            let m = rec.len() as f64;
            let mean = |k: usize| rec.iter().map(|r| r[k]).sum::<f64>() / m;
            let (mo, mp, mt) = (mean(own), mean(other), mean(tr));
            let (mut soo, mut spp, mut sop, mut sot, mut spt) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for r in &rec {
                let (o, p, y) = (r[own] - mo, r[other] - mp, r[tr] - mt);
                soo += o * o;
                spp += p * p;
                sop += o * p;
                sot += o * y;
                spt += p * y;
            }
            let det = soo * spp - sop * sop;
            let a = (spp * sot - sop * spt) / det;
            let b = (soo * spt - sop * sot) / det;
            b / a
        };
        let truth_j = aj[pi] / aj.iter().cloned().fold(0.0, f32::max);
        (cur_j[pi] / truth_j, leak(3, 2, 1), leak(2, 3, 0))
    }

    /// The leak fixed point: a wide cell bitten by its small neighbour's
    /// light (`a_j − λ a_i`) reconstructs the frames as well as the truth,
    /// so the plain replay stays there and the small cell's trace keeps
    /// `λ c_j`. The L1 trace step (`joint_l1` 2) prefers the sparse split:
    /// the wide tail comes back and both leaks vanish; started at the truth
    /// it stays there.
    #[test]
    fn l1_trace_step_heals_the_leak_fixed_point() {
        let (bite0, leak0, _) = bitten_pair(0.0, 0.5, 1.0, 20000, 7);
        assert!(
            leak0 > 0.3,
            "plain replay left the fixed point: leak {leak0}, bite {bite0}"
        );
        let (bite, leak, back) = bitten_pair(2.0, 0.5, 1.0, 20000, 7);
        assert!(
            bite > 0.8,
            "wide tail under the small cell / truth = {bite}"
        );
        assert!(leak < 0.1, "leak wide -> small {leak}");
        assert!(back.abs() < 0.05, "leak small -> wide {back}");
        let (bite, leak, back) = bitten_pair(2.0, 0.5, 0.0, 8000, 7);
        assert!(
            bite > 0.85,
            "started at the truth: wide tail / truth = {bite}"
        );
        assert!(
            leak < 0.08 && back.abs() < 0.05,
            "started at the truth: leaks {leak} {back}"
        );
    }

    /// Exploration (`cargo test --release -p calab-cala bitten_pair_sweep
    /// -- --ignored --nocapture`): bite and leak by L1 weight.
    #[test]
    #[ignore]
    fn bitten_pair_sweep() {
        let frames: usize = std::env::var("PAIR_FRAMES").map_or(8000, |v| v.parse().unwrap());
        let bite: f32 = std::env::var("PAIR_BITE").map_or(1.0, |v| v.parse().unwrap());
        for sep in [0.5f32, 0.75, 1.0] {
            for l1 in [0.0, 1.0, 2.0, 3.0] {
                let mut acc = (0.0f32, 0.0f64, 0.0f64);
                for seed in [7u64, 8, 9] {
                    let r = bitten_pair(l1, sep, bite, frames, seed);
                    acc = (acc.0 + r.0 / 3.0, acc.1 + r.1 / 3.0, acc.2 + r.2 / 3.0);
                }
                println!(
                    "sep {sep} l1 {l1}: j at i / truth {:.2}, leak j->i {:.3}, i->j {:.3}",
                    acc.0, acc.1, acc.2
                );
            }
        }
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
            let rep = st
                .replay(gamma, JointSign::All, 1, false, 0.0)
                .expect("replay");
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
        let before = st
            .replay(1.0, JointSign::Off, 1, false, 0.0)
            .expect("replay");
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
        let after = st
            .replay(1.0, JointSign::Off, 1, false, 0.0)
            .expect("replay");
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
}

#[cfg(test)]
mod push_frame_tests {
    use super::*;
    use crate::discover::fpstats::disk_pixels;

    fn u(k: u64) -> f32 {
        (crate::discover::reservoir::mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }

    /// The slow loop's cluster push before `push_frame`.
    fn reference(
        st: &mut ClusterStore,
        frame: &[f32],
        model: &[f32],
        lv: &[f32],
        c: &[f32],
        w: f64,
    ) -> bool {
        let n = st.pix.len();
        let mut r: Vec<f32> = st
            .pix
            .iter()
            .zip(&st.owner)
            .map(|(&p, &o)| frame[p as usize] - model[p as usize] - lv[o as usize])
            .collect();
        for (k, &ck) in c.iter().enumerate() {
            if ck != 0.0 {
                for (r, &a) in r.iter_mut().zip(&st.cols[k * n..(k + 1) * n]) {
                    *r += a * ck;
                }
            }
        }
        for (r, &is) in r.iter_mut().zip(&st.is) {
            *r *= is;
        }
        if !r.iter().all(|v| v.is_finite()) || !c.iter().all(|v| v.is_finite()) {
            return false;
        }
        st.push(&r, c, w);
        true
    }

    fn state(st: &ClusterStore) -> String {
        let mut s = st.clone();
        s.runs.clear();
        format!("{s:?}")
    }

    fn geometry(
        disks: &[((f32, f32), f32)],
        wd: usize,
        ht: usize,
        fov: &[u8],
        k: u64,
    ) -> (Vec<u32>, Vec<f32>, Vec<f32>) {
        let mut pix: Vec<u32> = disks
            .iter()
            .flat_map(|d| disk_pixels(d.0, d.1, wd, ht, fov))
            .collect();
        pix.sort_unstable();
        pix.dedup();
        let n = pix.len();
        let is = (0..n).map(|i| 1.0 + 0.2 * u(k + i as u64)).collect();
        let cols = (0..n * disks.len())
            .map(|i| u(k * 7 + i as u64).max(0.0))
            .collect();
        (pix, is, cols)
    }

    /// `push_frame` leaves the store bit for bit where building the
    /// whitened residual and calling `push` does: with and without ring
    /// levels (per-pixel owner), zero and NaN traces, missing pixels (the
    /// frame is skipped), FOV holes and a moved store.
    #[test]
    fn push_frame_matches_building_the_residual() {
        let (wd, ht) = (48usize, 40usize);
        let mut fov = vec![1u8; wd * ht];
        fov[18 * wd + 20] = 0;
        let disks = vec![
            ((18.0, 18.0), 8.0),
            ((20.0, 25.0), 8.0),
            ((24.0, 20.0), 7.0),
        ];
        for ring in [false, true] {
            let (pix, is, cols) = geometry(&disks, wd, ht, &fov, 1);
            let mut a = ClusterStore::new(vec![1, 2, 3], disks.clone(), pix, is, wd, 1, cols, 300);
            let mut b = a.clone();
            let mut buf = Vec::new();
            for t in 0..600u64 {
                let mut frame: Vec<f32> =
                    (0..wd * ht).map(|i| 3.0 * u(t * 9000 + i as u64)).collect();
                let model: Vec<f32> = (0..wd * ht).map(|i| u(t * 9000 + i as u64 + 55)).collect();
                if t == 200 {
                    frame[20 * wd + 22] = f32::NAN;
                }
                let mut c: Vec<f32> = (0..3).map(|k| 2.0 * u(t * 3 + k) + 0.6).collect();
                if t % 5 == 0 {
                    c[1] = 0.0;
                }
                if t == 77 {
                    c[2] = f32::NAN;
                }
                let lv: Vec<f32> = (0..3)
                    .map(|k| if ring { 0.3 * u(t * 11 + k) } else { 0.0 })
                    .collect();
                if t == 400 {
                    let moved = vec![
                        ((19.0, 18.0), 9.0),
                        ((20.0, 26.0), 8.0),
                        ((24.0, 20.0), 7.0),
                    ];
                    let (pix, is, cols) = geometry(&moved, wd, ht, &fov, 2);
                    let ok_a =
                        a.move_to(moved.clone(), pix.clone(), is.clone(), wd, 1, cols.clone());
                    let ok_b = b.move_to(moved, pix, is, wd, 1, cols);
                    assert!(ok_a && ok_b);
                }
                let w = 1.0 + t as f64 * 1e-3;
                let ra = reference(&mut a, &frame, &model, &lv, &c, w);
                let rb = b.push_frame(&frame, &model, ring.then_some(&lv[..]), &c, w, &mut buf);
                assert_eq!(ra, rb, "ring {ring} t {t}");
                assert_eq!(state(&a), state(&b), "ring {ring} t {t}");
            }
            assert!(a.k > 590);
        }
    }
}

#[cfg(test)]
mod dot_lanes_tests {
    use super::dot_lanes;

    /// Lane sums agree with the serial sum (f64 reference) to f32
    /// rounding, at every length's remainder.
    #[test]
    fn dot_lanes_matches_the_serial_sum() {
        for n in [0usize, 1, 7, 8, 9, 63, 64, 1000, 1777] {
            let a: Vec<f32> = (0..n)
                .map(|i| ((i * 37 % 101) as f32 - 50.0) / 7.0)
                .collect();
            let b: Vec<f32> = (0..n)
                .map(|i| ((i * 53 % 97) as f32 - 48.0) / 5.0)
                .collect();
            let exact: f64 = a
                .iter()
                .zip(&b)
                .map(|(x, y)| f64::from(*x) * f64::from(*y))
                .sum();
            let scale: f64 = a
                .iter()
                .zip(&b)
                .map(|(x, y)| f64::from((x * y).abs()))
                .sum();
            let got = f64::from(dot_lanes(&a, &b));
            assert!(
                (got - exact).abs() <= 1e-6 * scale.max(1.0),
                "n {n}: {got} vs {exact}"
            );
        }
    }
}
