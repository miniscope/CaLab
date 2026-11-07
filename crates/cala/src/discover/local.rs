//! Patch-local machinery: the high-pass on small canvases, footprints on
//! their support disks, and an exact trace solve on one patch with a smooth
//! local background (the slow loop's model of a few dozen cells at a time).
//!
//! Everything a [`Problem`] sees is **whitened**: data and columns are
//! divided by the per-pixel noise σ, so squared residuals are χ² values and
//! one unit of a trace's coordinate is one noise standard deviation of it
//! (`1 / sqrt(Q_ii)`).

#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::preprocess::gaussian::RecursiveGaussian;
use crate::preprocess::Dims;
use crate::trace::{support_disk, Footprint, LibraryConfig};

/// A rectangle of the frame (rows `y0..y0 + h`, columns `x0..x0 + w`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rect {
    pub y0: usize,
    pub x0: usize,
    pub h: usize,
    pub w: usize,
}

impl Rect {
    pub fn len(&self) -> usize {
        self.h * self.w
    }

    /// Patch-local index of the global pixel `(gy, gx)`, if inside.
    #[inline]
    pub fn local(&self, gy: usize, gx: usize) -> Option<usize> {
        if gy >= self.y0 && gy < self.y0 + self.h && gx >= self.x0 && gx < self.x0 + self.w {
            Some((gy - self.y0) * self.w + (gx - self.x0))
        } else {
            None
        }
    }

    /// The square of half-width `r` around `(cy, cx)`, clipped to `dims`.
    pub fn around(cy: f32, cx: f32, r: f32, dims: Dims) -> Rect {
        let y0 = (cy - r).floor().max(0.0) as usize;
        let x0 = (cx - r).floor().max(0.0) as usize;
        let y1 = ((cy + r).ceil() as usize + 1).min(dims.height);
        let x1 = ((cx + r).ceil() as usize + 1).min(dims.width);
        Rect {
            y0,
            x0,
            h: y1.saturating_sub(y0),
            w: x1.saturating_sub(x0),
        }
    }

    /// Smallest rectangle holding both.
    pub fn union(&self, o: &Rect) -> Rect {
        let y0 = self.y0.min(o.y0);
        let x0 = self.x0.min(o.x0);
        let y1 = (self.y0 + self.h).max(o.y0 + o.h);
        let x1 = (self.x0 + self.w).max(o.x0 + o.w);
        Rect {
            y0,
            x0,
            h: y1 - y0,
            w: x1 - x0,
        }
    }

    pub fn intersects(&self, o: &Rect) -> bool {
        self.y0 < o.y0 + o.h
            && o.y0 < self.y0 + self.h
            && self.x0 < o.x0 + o.w
            && o.x0 < self.x0 + self.w
    }
}

/// The preprocessing high-pass `H a = a − G_σ * a` on a small canvas.
///
/// The glow flattener divides by the blurred FOV mask, which is 1 away from
/// the lens edge, so in the FOV interior this is the flattener exactly; the
/// blur's zero padding is exact for a footprint that is zero outside the
/// canvas. (The published library is still built with the real flattener.)
#[derive(Debug)]
pub(crate) struct LocalFilter {
    sigma: f32,
    cache: Vec<RecursiveGaussian>,
    tmp: Vec<f32>,
}

impl LocalFilter {
    pub fn new(sigma: f32) -> LocalFilter {
        LocalFilter {
            sigma,
            cache: Vec::new(),
            tmp: Vec::new(),
        }
    }

    pub fn blur(&mut self, h: usize, w: usize, a: &[f32], out: &mut [f32]) {
        let dims = Dims {
            width: w,
            height: h,
        };
        let pos = match self.cache.iter().position(|g| g.dims() == dims) {
            Some(p) => p,
            None => {
                if self.cache.len() >= 16 {
                    self.cache.remove(0);
                }
                // σ ≥ 0.5 was validated with the flattener's config.
                self.cache
                    .push(RecursiveGaussian::new(dims, self.sigma).expect("valid sigma"));
                self.cache.len() - 1
            }
        };
        self.cache[pos].blur(a, out).expect("canvas sizes match");
    }

    /// `out = H a` on an `h x w` canvas.
    pub fn apply(&mut self, h: usize, w: usize, a: &[f32], out: &mut [f32]) {
        self.blur(h, w, a, out);
        for (o, &v) in out.iter_mut().zip(a) {
            *o = v - *o;
        }
    }

    /// Non-negative `a` on `dom` (canvas mask) with `H a ≈ target` on `dom`:
    /// projected gradient with Nesterov momentum (`H` is symmetric with
    /// spectrum in [0, 1), so a unit step is safe). `a` holds the start and
    /// the result.
    pub fn invert(
        &mut self,
        h: usize,
        w: usize,
        dom: &[bool],
        target: &[f32],
        a: &mut [f32],
        iters: usize,
    ) {
        let n = h * w;
        let mut x_prev = a.to_vec();
        let mut z = a.to_vec();
        let mut hz = vec![0.0f32; n];
        let mut g = vec![0.0f32; n];
        let mut t = 1.0f32;
        self.tmp.resize(n, 0.0);
        for _ in 0..iters {
            self.apply(h, w, &z, &mut hz);
            for p in 0..n {
                hz[p] = if dom[p] { hz[p] - target[p] } else { 0.0 };
            }
            self.apply(h, w, &hz, &mut g);
            let t_next = 0.5 * (1.0 + (1.0 + 4.0 * t * t).sqrt());
            let mom = (t - 1.0) / t_next;
            for p in 0..n {
                let xn = if dom[p] { (z[p] - g[p]).max(0.0) } else { 0.0 };
                z[p] = xn + mom * (xn - x_prev[p]);
                x_prev[p] = xn;
            }
            t = t_next;
        }
        a.copy_from_slice(&x_prev);
    }
}

/// A footprint in the slow loop's working set, on its library support disk.
#[derive(Debug, Clone)]
pub(crate) struct Cell {
    pub id: u64,
    pub center: (f32, f32),
    pub radius: f32,
    /// Bounding box of the support.
    pub bbox: Rect,
    /// Global pixel indices of the support.
    pub pix: Vec<u32>,
    /// Unfiltered values (peak 1 at creation).
    pub raw: Vec<f32>,
    /// Filtered values `(H a)` on the support (unwhitened).
    pub filt: Vec<f32>,
    /// Frame at which the cell entered the working set (seeded: 0).
    pub born: u64,
}

impl Cell {
    /// From unfiltered values `a` on canvas `rect`: the library's support
    /// rule (2.5 half-widths around the half-max centroid), the values cut to
    /// that disk, and the filtered column. `None` when the footprint is
    /// empty or its support leaves the FOV or the canvas.
    pub fn from_canvas(
        id: u64,
        rect: Rect,
        a: &[f32],
        dims: Dims,
        fov: &[u8],
        cfg: &LibraryConfig,
        filter: &mut LocalFilter,
    ) -> Option<Cell> {
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) || !peak.is_finite() {
            return None;
        }
        let fp = Footprint {
            id,
            y0: rect.y0,
            x0: rect.x0,
            height: rect.h,
            width: rect.w,
            values: a.to_vec(),
        };
        let (cy, cx, r) = support_disk(&fp, dims, cfg).ok()?;
        let bbox = Rect::around(cy, cx, r, dims);
        let mut canvas = vec![0.0f32; bbox.len()];
        let mut inside = vec![false; bbox.len()];
        let mut pix = Vec::new();
        for y in 0..bbox.h {
            for x in 0..bbox.w {
                let (gy, gx) = (bbox.y0 + y, bbox.x0 + x);
                let (dy, dx) = (gy as f32 - cy, gx as f32 - cx);
                if dy * dy + dx * dx <= r * r {
                    let g = gy * dims.width + gx;
                    if fov[g] == 0 {
                        return None;
                    }
                    inside[y * bbox.w + x] = true;
                    pix.push(g as u32);
                    if let Some(l) = rect.local(gy, gx) {
                        canvas[y * bbox.w + x] = a[l];
                    }
                }
            }
        }
        let mut hf = vec![0.0f32; bbox.len()];
        filter.apply(bbox.h, bbox.w, &canvas, &mut hf);
        let mut raw = Vec::with_capacity(pix.len());
        let mut filt = Vec::with_capacity(pix.len());
        for p in 0..bbox.len() {
            if inside[p] {
                raw.push(canvas[p]);
                filt.push(hf[p]);
            }
        }
        if !(raw.iter().copied().fold(0.0f32, f32::max) > 0.0) {
            return None;
        }
        Some(Cell {
            id,
            center: (cy, cx),
            radius: r,
            bbox,
            pix,
            raw,
            filt,
            born: 0,
        })
    }

    /// The footprint as the library builder takes it (zero off the support).
    pub fn footprint(&self, dims: Dims) -> Footprint {
        let b = self.bbox;
        let mut values = vec![0.0f32; b.len()];
        for (&g, &v) in self.pix.iter().zip(&self.raw) {
            let (gy, gx) = (g as usize / dims.width, g as usize % dims.width);
            values[(gy - b.y0) * b.w + (gx - b.x0)] = v;
        }
        Footprint {
            id: self.id,
            y0: b.y0,
            x0: b.x0,
            height: b.h,
            width: b.w,
            values,
        }
    }
}

/// Smooth local background on a patch: a 3 x 3 grid of Gaussian bumps
/// (spacing a third of the patch side, σ about the spacing), whitened space.
#[derive(Debug, Clone)]
pub(crate) struct BgBasis {
    pub k: usize,
    pub maps: Vec<Vec<f32>>,
    /// `G_bb⁻¹` (k x k).
    pub inv: Vec<f64>,
    /// `G_bb` without the ridge.
    gram: Vec<f64>,
}

impl BgBasis {
    pub fn new(rect: Rect) -> BgBasis {
        let mut maps = Vec::new();
        let sy = rect.h as f32 / 3.0;
        let sx = rect.w as f32 / 3.0;
        let s = 0.5 * (sy + sx);
        for by in 0..3 {
            for bx in 0..3 {
                let cy = (by as f32 + 0.5) * sy;
                let cx = (bx as f32 + 0.5) * sx;
                let mut m = vec![0.0f32; rect.len()];
                for y in 0..rect.h {
                    for x in 0..rect.w {
                        let (dy, dx) = (y as f32 + 0.5 - cy, x as f32 + 0.5 - cx);
                        m[y * rect.w + x] = (-(dy * dy + dx * dx) / (2.0 * s * s)).exp();
                    }
                }
                maps.push(m);
            }
        }
        BgBasis::from_maps(maps)
    }

    /// This basis plus one more map (same patch): only the new Gram row is
    /// computed.
    pub fn with_extra(&self, map: &[f32]) -> BgBasis {
        let k = self.k;
        let k1 = k + 1;
        let mut g = vec![0.0f64; k1 * k1];
        for a in 0..k {
            for b in 0..k {
                g[a * k1 + b] = self.gram[a * k + b];
            }
            let d: f64 = self.maps[a]
                .iter()
                .zip(map)
                .map(|(&u, &v)| f64::from(u) * f64::from(v))
                .sum();
            g[a * k1 + k] = d;
            g[k * k1 + a] = d;
        }
        g[k * k1 + k] = map.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
        let mut maps = self.maps.clone();
        maps.push(map.to_vec());
        BgBasis::from_gram(maps, g)
    }

    fn from_maps(maps: Vec<Vec<f32>>) -> BgBasis {
        let k = maps.len();
        let mut g = vec![0.0f64; k * k];
        for a in 0..k {
            for b in a..k {
                let d: f64 = maps[a]
                    .iter()
                    .zip(&maps[b])
                    .map(|(&u, &v)| f64::from(u) * f64::from(v))
                    .sum();
                g[a * k + b] = d;
                g[b * k + a] = d;
            }
        }
        BgBasis::from_gram(maps, g)
    }

    fn from_gram(maps: Vec<Vec<f32>>, gram: Vec<f64>) -> BgBasis {
        let k = maps.len();
        let mut g = gram.clone();
        // A tiny ridge keeps a nearly dependent extra map solvable.
        let tr = (0..k).map(|a| g[a * k + a]).sum::<f64>() / k as f64;
        for a in 0..k {
            g[a * k + a] += 1e-9 * tr;
        }
        let inv = invert(&g, k).expect("ridge keeps the basis invertible");
        BgBasis { k, maps, inv, gram }
    }

    /// Projections `g_kᵀ y` and `yᵀy` of a patch.
    pub fn project(&self, y: &[f32]) -> (Vec<f64>, f64) {
        let q = self
            .maps
            .iter()
            .map(|m| m.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum())
            .collect();
        let yy = y.iter().map(|&v| f64::from(v * v)).sum();
        (q, yy)
    }
}

/// Inverse of a small symmetric positive-definite matrix (Gauss-Jordan).
pub(crate) fn invert(a: &[f64], k: usize) -> Option<Vec<f64>> {
    let mut m = a.to_vec();
    let mut inv = vec![0.0f64; k * k];
    for i in 0..k {
        inv[i * k + i] = 1.0;
    }
    for col in 0..k {
        let piv =
            (col..k).max_by(|&r, &s| m[r * k + col].abs().total_cmp(&m[s * k + col].abs()))?;
        if m[piv * k + col].abs() < 1e-12 {
            return None;
        }
        for c in 0..k {
            m.swap(piv * k + c, col * k + c);
            inv.swap(piv * k + c, col * k + c);
        }
        let d = m[col * k + col];
        for c in 0..k {
            m[col * k + c] /= d;
            inv[col * k + c] /= d;
        }
        for r in 0..k {
            if r != col {
                let f = m[r * k + col];
                if f != 0.0 {
                    for c in 0..k {
                        m[r * k + c] -= f * m[col * k + c];
                        inv[r * k + c] -= f * inv[col * k + c];
                    }
                }
            }
        }
    }
    Some(inv)
}

/// One column of a patch problem: patch-local pixels and whitened values.
#[derive(Debug, Clone)]
pub(crate) struct Column {
    pub id: u64,
    pub pix: Vec<u32>,
    pub val: Vec<f32>,
}

impl Column {
    /// The part of `cell`'s filtered footprint inside `rect`, divided by σ.
    pub fn of(cell: &Cell, rect: Rect, width: usize, inv_sigma: &[f32]) -> Column {
        let mut pix = Vec::new();
        let mut val = Vec::new();
        for (&g, &v) in cell.pix.iter().zip(&cell.filt) {
            let (gy, gx) = (g as usize / width, g as usize % width);
            if let Some(l) = rect.local(gy, gx) {
                pix.push(l as u32);
                val.push(v * inv_sigma[g as usize]);
            }
        }
        Column {
            id: cell.id,
            pix,
            val,
        }
    }
}

/// One frame's solution.
#[derive(Debug, Clone)]
pub(crate) struct Fit {
    pub c: Vec<f32>,
    pub beta: Vec<f64>,
    pub chi2: f64,
}

/// Non-negative least squares for a few cells plus the bump background on
/// one patch, with every frame-independent term precomputed.
#[derive(Debug, Clone)]
pub(crate) struct Problem {
    pub cols: Vec<Column>,
    n: usize,
    k: usize,
    /// `T = G_cb G_bb⁻¹` (n x k).
    t: Vec<f64>,
    /// Reduced Gram `Q = G_cc − G_cb G_bb⁻¹ G_bc` (n x n).
    pub q: Vec<f64>,
    /// `G_bc` (k x n), for the background coefficients.
    gbc: Vec<f64>,
    bg_inv: Vec<f64>,
}

impl Problem {
    /// Builds the precomputed terms; `work` counts multiply-adds.
    pub fn new(cols: Vec<Column>, bg: &BgBasis, n_px: usize, work: &mut u64) -> Problem {
        let n = cols.len();
        let k = bg.k;
        let mut gcc = vec![0.0f64; n * n];
        let mut buf = vec![0.0f32; n_px];
        let lo: Vec<u32> = cols
            .iter()
            .map(|c| c.pix.iter().copied().min().unwrap_or(0))
            .collect();
        let hi: Vec<u32> = cols
            .iter()
            .map(|c| c.pix.iter().copied().max().unwrap_or(0))
            .collect();
        for i in 0..n {
            for (&p, &v) in cols[i].pix.iter().zip(&cols[i].val) {
                buf[p as usize] = v;
            }
            for j in i..n {
                if cols[j].pix.is_empty() || lo[j] > hi[i] || hi[j] < lo[i] {
                    continue;
                }
                let d: f64 = cols[j]
                    .pix
                    .iter()
                    .zip(&cols[j].val)
                    .map(|(&p, &v)| f64::from(buf[p as usize] * v))
                    .sum();
                *work += cols[j].pix.len() as u64;
                gcc[i * n + j] = d;
                gcc[j * n + i] = d;
            }
            for &p in &cols[i].pix {
                buf[p as usize] = 0.0;
            }
        }
        let mut gbc = vec![0.0f64; k * n];
        for (i, c) in cols.iter().enumerate() {
            for a in 0..k {
                let m = &bg.maps[a];
                gbc[a * n + i] = c
                    .pix
                    .iter()
                    .zip(&c.val)
                    .map(|(&p, &v)| f64::from(m[p as usize] * v))
                    .sum();
            }
            *work += (k * c.pix.len()) as u64;
        }
        // T = G_cb G_bb⁻¹ ; Q = G_cc − T G_bc.
        let mut t = vec![0.0f64; n * k];
        for i in 0..n {
            for a in 0..k {
                t[i * k + a] = (0..k).map(|b| gbc[b * n + i] * bg.inv[b * k + a]).sum();
            }
        }
        let mut q = gcc;
        for i in 0..n {
            for j in 0..n {
                let s: f64 = (0..k).map(|a| t[i * k + a] * gbc[a * n + j]).sum();
                q[i * n + j] -= s;
            }
        }
        *work += (n * n * k) as u64;
        Problem {
            cols,
            n,
            k,
            t,
            q,
            gbc,
            bg_inv: bg.inv.clone(),
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    /// Noise σ of coordinate `i` (whitened units).
    pub fn coord_sigma(&self, i: usize) -> f32 {
        (1.0 / self.q[i * self.n + i].max(1e-12)).sqrt() as f32
    }

    /// Solve one whitened patch `y` given its background projections and
    /// energy (from [`BgBasis::project`]).
    pub fn solve(&self, y: &[f32], qb: &[f64], yy: f64, work: &mut u64) -> Fit {
        let (n, k) = (self.n, self.k);
        let mut p = vec![0.0f64; n];
        for (i, col) in self.cols.iter().enumerate() {
            let s: f64 = col
                .pix
                .iter()
                .zip(&col.val)
                .map(|(&px, &v)| f64::from(v * y[px as usize]))
                .sum();
            *work += col.pix.len() as u64;
            let tb: f64 = (0..k).map(|a| self.t[i * k + a] * qb[a]).sum();
            p[i] = s - tb;
        }
        let mut c = vec![0.0f64; n];
        let mut qc = vec![0.0f64; n];
        for _sweep in 0..100 {
            let mut worst = 0.0f64;
            for i in 0..n {
                let d_ii = self.q[i * n + i];
                if d_ii <= 0.0 {
                    continue;
                }
                let new = (c[i] + (p[i] - qc[i]) / d_ii).max(0.0);
                let d = new - c[i];
                if d != 0.0 {
                    c[i] = new;
                    let row = &self.q[i * n..(i + 1) * n];
                    for (q, &r) in qc.iter_mut().zip(row) {
                        *q += r * d;
                    }
                    worst = worst.max(d.abs() * d_ii.sqrt());
                }
            }
            *work += (n * n) as u64;
            if worst < 1e-2 {
                break;
            }
        }
        // χ² = yᵀy − q_bᵀ G_bb⁻¹ q_b − 2 pᵀc + cᵀQc.
        let mut bb = 0.0f64;
        for a in 0..k {
            for b in 0..k {
                bb += qb[a] * self.bg_inv[a * k + b] * qb[b];
            }
        }
        let pc: f64 = p.iter().zip(&c).map(|(a, b)| a * b).sum();
        let cqc: f64 = c.iter().zip(&qc).map(|(a, b)| a * b).sum();
        let chi2 = yy - bb - 2.0 * pc + cqc;
        // β = G_bb⁻¹ (q_b − G_bc c).
        let mut beta = vec![0.0f64; k];
        let r: Vec<f64> = (0..k)
            .map(|a| qb[a] - (0..n).map(|i| self.gbc[a * n + i] * c[i]).sum::<f64>())
            .collect();
        for a in 0..k {
            beta[a] = (0..k).map(|b| self.bg_inv[a * k + b] * r[b]).sum();
        }
        Fit {
            c: c.iter().map(|&v| v as f32).collect(),
            beta,
            chi2,
        }
    }

    /// `out = y − Σ col_i c_i − Σ g_k β_k` (whitened residual).
    pub fn residual(&self, y: &[f32], fit: &Fit, bg: &BgBasis, out: &mut [f32], work: &mut u64) {
        out.copy_from_slice(y);
        for (a, m) in bg.maps.iter().enumerate() {
            let b = fit.beta[a] as f32;
            if b != 0.0 {
                for (o, &g) in out.iter_mut().zip(m) {
                    *o -= g * b;
                }
            }
        }
        for (col, &ci) in self.cols.iter().zip(&fit.c) {
            if ci != 0.0 {
                for (&p, &v) in col.pix.iter().zip(&col.val) {
                    out[p as usize] -= v * ci;
                }
            }
        }
        *work += (y.len() * (bg.k + 1)) as u64;
    }
}

/// Alternating rank-1 fit on the pixels `dom` of residual frames `r`:
/// `r_t[dom] ≈ h c_t` with `c ≥ 0`, starting from `c` (updated in place).
/// Returns `h` on `dom`. `fixed_c` keeps the traces and does one `h` step.
pub(crate) fn rank1(
    r: &[&[f32]],
    dom: &[u32],
    c: &mut [f32],
    iters: usize,
    fixed_c: bool,
) -> Vec<f32> {
    let mut h = vec![0.0f32; dom.len()];
    for it in 0..iters.max(1) {
        let cc: f64 = c.iter().map(|&v| f64::from(v * v)).sum();
        if cc <= 0.0 {
            return h;
        }
        let mut acc = vec![0.0f64; dom.len()];
        for (rt, &ct) in r.iter().zip(c.iter()) {
            if ct != 0.0 {
                for (a, &p) in acc.iter_mut().zip(dom) {
                    *a += f64::from(rt[p as usize] * ct);
                }
            }
        }
        for (hv, a) in h.iter_mut().zip(&acc) {
            *hv = (a / cc) as f32;
        }
        if fixed_c || it + 1 == iters {
            break;
        }
        let hh: f64 = h.iter().map(|&v| f64::from(v * v)).sum();
        if hh <= 0.0 {
            return h;
        }
        for (rt, ct) in r.iter().zip(c.iter_mut()) {
            let d: f64 = h
                .iter()
                .zip(dom)
                .map(|(&hv, &p)| f64::from(hv * rt[p as usize]))
                .sum();
            *ct = ((d / hh) as f32).max(0.0);
        }
    }
    h
}

/// Rank-2 factorisation `x_t ≈ h_a a_t + h_b b_t` (`a, b ≥ 0`) of frames
/// `x` (each on the pixels `pix` of a patch `w` wide), started from the
/// footprint `h0` cut in two across its long axis. Returns the two spatial
/// factors when the parts look distinct on these frames: their traces
/// correlate below `max_corr`, each carries at least a fifth of the
/// energy, and the squared error drops by more than `2 (frames + pixels)`
/// (twice the parameters the second factor adds) against rank 1.
pub(crate) fn rank2_split(
    x: &[Vec<f32>],
    h0: &[f32],
    pix: &[u32],
    w: usize,
    max_corr: f32,
) -> Option<(Vec<f32>, Vec<f32>)> {
    let (nt, np) = (x.len(), h0.len());
    if nt < 2 || np < 4 {
        return None;
    }
    // Long axis of the positive part of the footprint.
    let (mut sw, mut my, mut mx) = (0.0f64, 0.0f64, 0.0f64);
    for (&p, &v) in pix.iter().zip(h0) {
        if v > 0.0 {
            let v = f64::from(v);
            sw += v;
            my += v * (p as usize / w) as f64;
            mx += v * (p as usize % w) as f64;
        }
    }
    if !(sw > 0.0) {
        return None;
    }
    let (my, mx) = (my / sw, mx / sw);
    let (mut cyy, mut cxx, mut cxy) = (0.0f64, 0.0f64, 0.0f64);
    for (&p, &v) in pix.iter().zip(h0) {
        if v > 0.0 {
            let v = f64::from(v);
            let (dy, dx) = ((p as usize / w) as f64 - my, (p as usize % w) as f64 - mx);
            cyy += v * dy * dy;
            cxx += v * dx * dx;
            cxy += v * dy * dx;
        }
    }
    // Major eigenvector of [[cyy, cxy], [cxy, cxx]].
    let th = 0.5 * (2.0 * cxy).atan2(cyy - cxx);
    let (vy, vx) = (th.cos(), th.sin());
    let mut ha = vec![0.0f32; np];
    let mut hb = vec![0.0f32; np];
    for (k, &p) in pix.iter().enumerate() {
        let (dy, dx) = ((p as usize / w) as f64 - my, (p as usize % w) as f64 - mx);
        if dy * vy + dx * vx > 0.0 {
            ha[k] = h0[k];
        } else {
            hb[k] = h0[k];
        }
    }
    let dot = |a: &[f32], b: &[f32]| -> f64 {
        a.iter()
            .zip(b)
            .map(|(&u, &v)| f64::from(u) * f64::from(v))
            .sum()
    };
    let mut ca = vec![0.0f32; nt];
    let mut cb = vec![0.0f32; nt];
    for _ in 0..30 {
        // Traces: 2 x 2 non-negative least squares per frame.
        let (gaa, gab, gbb) = (dot(&ha, &ha), dot(&ha, &hb), dot(&hb, &hb));
        if !(gaa > 0.0) || !(gbb > 0.0) {
            return None;
        }
        for t in 0..nt {
            let (ra, rb) = (dot(&ha, &x[t]), dot(&hb, &x[t]));
            let det = gaa * gbb - gab * gab;
            let (mut a, mut b) = if det > 1e-12 * gaa * gbb {
                ((gbb * ra - gab * rb) / det, (gaa * rb - gab * ra) / det)
            } else {
                (-1.0, -1.0)
            };
            if a < 0.0 || b < 0.0 {
                let (a1, b1) = ((ra / gaa).max(0.0), (rb / gbb).max(0.0));
                // The better of the two one-sided solutions.
                let ea = a1 * a1 * gaa - 2.0 * a1 * ra;
                let eb = b1 * b1 * gbb - 2.0 * b1 * rb;
                if ea <= eb {
                    (a, b) = (a1, 0.0);
                } else {
                    (a, b) = (0.0, b1);
                }
            }
            ca[t] = a as f32;
            cb[t] = b as f32;
        }
        // Footprints: least squares per pixel with the traces fixed.
        let (maa, mab, mbb) = (dot(&ca, &ca), dot(&ca, &cb), dot(&cb, &cb));
        let det = maa * mbb - mab * mab;
        if !(det > 1e-9 * (maa * mbb).max(1e-30)) {
            return None;
        }
        for k in 0..np {
            let (mut sa, mut sb) = (0.0f64, 0.0f64);
            for t in 0..nt {
                let v = f64::from(x[t][k]);
                sa += f64::from(ca[t]) * v;
                sb += f64::from(cb[t]) * v;
            }
            ha[k] = ((mbb * sa - mab * sb) / det) as f32;
            hb[k] = ((maa * sb - mab * sa) / det) as f32;
        }
    }
    let mut sse2 = 0.0f64;
    for t in 0..nt {
        for k in 0..np {
            let e = f64::from(x[t][k] - ha[k] * ca[t] - hb[k] * cb[t]);
            sse2 += e * e;
        }
    }
    // Rank 1 from the whole footprint.
    let refs: Vec<&[f32]> = x.iter().map(|v| v.as_slice()).collect();
    let local: Vec<u32> = (0..np as u32).collect();
    let mut c1: Vec<f32> = x
        .iter()
        .map(|v| (dot(h0, v) / dot(h0, h0).max(1e-30)).max(0.0) as f32)
        .collect();
    let h1 = rank1(&refs, &local, &mut c1, 10, false);
    let mut sse1 = 0.0f64;
    for t in 0..nt {
        for k in 0..np {
            let e = f64::from(x[t][k] - h1[k] * c1[t]);
            sse1 += e * e;
        }
    }
    let ea = dot(&ha, &ha) * dot(&ca, &ca);
    let eb = dot(&hb, &hb) * dot(&cb, &cb);
    let share = ea.min(eb) / (ea + eb).max(1e-30);
    let r = {
        let n = nt as f64;
        let (ma, mb) = (
            ca.iter().map(|&v| f64::from(v)).sum::<f64>() / n,
            cb.iter().map(|&v| f64::from(v)).sum::<f64>() / n,
        );
        let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
        for t in 0..nt {
            let (u, v) = (f64::from(ca[t]) - ma, f64::from(cb[t]) - mb);
            sab += u * v;
            saa += u * u;
            sbb += v * v;
        }
        if saa > 0.0 && sbb > 0.0 {
            sab / (saa * sbb).sqrt()
        } else {
            1.0
        }
    };
    (sse1 - sse2 > 2.0 * (nt + np) as f64 && share >= 0.2 && r < f64::from(max_corr))
        .then_some((ha, hb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invert_recovers_a_footprint_through_the_highpass() {
        let (h, w) = (31usize, 31usize);
        let mut a = vec![0.0f32; h * w];
        let mut dom = vec![false; h * w];
        for y in 0..h {
            for x in 0..w {
                let (dy, dx) = (y as f32 - 15.0, x as f32 - 15.0);
                let r2 = dy * dy + dx * dx;
                if r2 <= 144.0 {
                    dom[y * w + x] = true;
                    a[y * w + x] = (-r2 / (2.0 * 16.0)).exp();
                }
            }
        }
        let mut f = LocalFilter::new(20.0);
        let mut target = vec![0.0f32; h * w];
        f.apply(h, w, &a, &mut target);
        // The high-pass removes a sizeable share of the peak.
        assert!(target[15 * w + 15] < 0.97);
        let mut est: Vec<f32> = target.iter().map(|v| v.max(0.0)).collect();
        f.invert(h, w, &dom, &target, &mut est, 200);
        let err = a
            .iter()
            .zip(&est)
            .map(|(x, y)| (x - y).abs())
            .fold(0.0f32, f32::max);
        assert!(err < 0.03, "max error {err}");
    }

    #[test]
    fn problem_solves_exact_mixtures() {
        let rect = Rect {
            y0: 0,
            x0: 0,
            h: 40,
            w: 40,
        };
        let bg = BgBasis::new(rect);
        let mk = |cy: f32, cx: f32, id| {
            let mut pix = Vec::new();
            let mut val = Vec::new();
            for y in 0..40 {
                for x in 0..40 {
                    let (dy, dx) = (y as f32 - cy, x as f32 - cx);
                    let r2 = dy * dy + dx * dx;
                    if r2 < 64.0 {
                        pix.push((y * 40 + x) as u32);
                        val.push((-r2 / 18.0).exp());
                    }
                }
            }
            Column { id, pix, val }
        };
        let cols = vec![mk(15.0, 15.0, 1), mk(20.0, 22.0, 2)];
        let mut y = vec![0.0f32; 1600];
        for (col, c) in cols.iter().zip([3.0f32, 1.5]) {
            for (&p, &v) in col.pix.iter().zip(&col.val) {
                y[p as usize] += v * c;
            }
        }
        for (o, &g) in y.iter_mut().zip(&bg.maps[4]) {
            *o += 0.7 * g;
        }
        let mut work = 0;
        let pr = Problem::new(cols, &bg, 1600, &mut work);
        let (qb, yy) = bg.project(&y);
        let fit = pr.solve(&y, &qb, yy, &mut work);
        assert!(
            (fit.c[0] - 3.0).abs() < 1e-3 && (fit.c[1] - 1.5).abs() < 1e-3,
            "{:?}",
            fit.c
        );
        assert!(fit.chi2.abs() < 1e-3, "chi2 {}", fit.chi2);
    }
}
