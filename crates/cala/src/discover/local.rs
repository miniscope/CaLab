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
use crate::trace::{moat_blocks, moat_geometry, support_disk, Footprint, LibraryConfig, Support};

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

    /// Block side and reach of the moat grid ([`moat_geometry`]).
    pub fn moat(&self) -> Option<(usize, f32)> {
        moat_geometry(self.sigma)
    }

    pub fn sigma(&self) -> f32 {
        self.sigma
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

/// Where a new footprint's support ends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Extent {
    /// Keep every non-zero value (a footprint given from outside).
    Given,
    /// The seed rule ([`LibraryConfig::seed_radius`]): a candidate whose
    /// extent has not been measured yet.
    Seed,
    /// A measured radius around the half-max centroid (at least the seed
    /// rule's).
    Radius(f32),
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
    /// The moat: global grid blocks (ascending) and the block means of the
    /// low-pass `L a` there. Off the support the filtered column is
    /// `−low(B(p))` (see [`crate::trace::Library::lowpass`]).
    pub low_blk: Vec<u32>,
    pub low: Vec<f32>,
    /// Frame at which the cell entered the working set (seeded: 0).
    pub born: u64,
}

impl Cell {
    /// From unfiltered values `a` on canvas `rect`: the values cut to the
    /// support disk `extent` gives (around the half-max centroid) and to the
    /// FOV, and the filtered column. `None` when the footprint is empty.
    #[allow(clippy::too_many_arguments)]
    pub fn from_canvas(
        id: u64,
        rect: Rect,
        a: &[f32],
        dims: Dims,
        fov: &[u8],
        cfg: &LibraryConfig,
        extent: Extent,
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
        let Support {
            center: (cy, cx),
            radius: own,
            hwhm,
        } = support_disk(&fp, dims).ok()?;
        let r = match extent {
            Extent::Given => own,
            Extent::Seed => cfg.seed_radius(hwhm),
            // Never tighter than the seed rule: a dim cell's tail is not
            // significant ring by ring, but it is still the cell's light.
            Extent::Radius(r) => r.max(cfg.seed_radius(hwhm)),
        };
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
                    // Clipped at the lens edge (the filtered data is 0 there).
                    if fov[g] == 0 {
                        continue;
                    }
                    inside[y * bbox.w + x] = true;
                    pix.push(g as u32);
                    if let Some(l) = rect.local(gy, gx) {
                        canvas[y * bbox.w + x] = a[l];
                    }
                }
            }
        }
        let mut raw = Vec::with_capacity(pix.len());
        for p in 0..bbox.len() {
            if inside[p] {
                raw.push(canvas[p]);
            }
        }
        if !(raw.iter().copied().fold(0.0f32, f32::max) > 0.0) {
            return None;
        }
        let (filt, low_blk, low) = moat_column(&pix, &raw, (cy, cx), r, bbox, dims, fov, filter);
        Some(Cell {
            id,
            center: (cy, cx),
            radius: r,
            bbox,
            pix,
            raw,
            filt,
            low_blk,
            low,
            born: 0,
        })
    }

    /// The cell's filtered column at the global pixel `g`: `filt` on the
    /// support, `−low` of its block off it (0 beyond the moat).
    pub fn column_at(&self, g: u32, width: usize, block: usize) -> f32 {
        if let Ok(k) = self.pix.binary_search(&g) {
            return self.filt[k];
        }
        if block == 0 {
            return 0.0;
        }
        let (y, x) = (g as usize / width, g as usize % width);
        let b = ((y / block) * width.div_ceil(block) + x / block) as u32;
        self.low_blk.binary_search(&b).map_or(0.0, |k| -self.low[k])
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

/// The filtered column of the unfiltered values `raw` on the support `pix`
/// (centre, radius, bounding box `bbox`): `H a` on the support, and the
/// block means of `L a` on the moat grid out to its reach (FOV only), from
/// one blur on a canvas that holds all of the moat's blocks.
#[allow(clippy::too_many_arguments)]
pub(crate) fn moat_column(
    pix: &[u32],
    raw: &[f32],
    center: (f32, f32),
    radius: f32,
    bbox: Rect,
    dims: Dims,
    fov: &[u8],
    filter: &mut LocalFilter,
) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let w = dims.width;
    let Some((b, reach)) = filter.moat() else {
        return (raw.to_vec(), Vec::new(), Vec::new());
    };
    let blks = moat_blocks(center, radius, b, reach, dims);
    let gw = w.div_ceil(b);
    let mut canvas = bbox;
    for &bq in &blks {
        let (by, bx) = (bq as usize / gw, bq as usize % gw);
        let r = Rect {
            y0: by * b,
            x0: bx * b,
            h: ((by + 1) * b).min(dims.height) - by * b,
            w: ((bx + 1) * b).min(dims.width) - bx * b,
        };
        canvas = canvas.union(&r);
    }
    let mut a = vec![0.0f32; canvas.len()];
    for (&g, &v) in pix.iter().zip(raw) {
        let l = canvas
            .local(g as usize / w, g as usize % w)
            .expect("inside");
        a[l] = v;
    }
    let mut lo = vec![0.0f32; canvas.len()];
    filter.blur(canvas.h, canvas.w, &a, &mut lo);
    let filt = pix
        .iter()
        .zip(raw)
        .map(|(&g, &v)| {
            v - lo[canvas
                .local(g as usize / w, g as usize % w)
                .expect("inside")]
        })
        .collect();
    let mut low = Vec::with_capacity(blks.len());
    for &bq in &blks {
        let (by, bx) = (bq as usize / gw, bq as usize % gw);
        let (mut s, mut m) = (0.0f64, 0usize);
        for y in by * b..((by + 1) * b).min(dims.height) {
            for x in bx * b..((bx + 1) * b).min(dims.width) {
                if fov[y * w + x] != 0 {
                    s += f64::from(lo[canvas.local(y, x).expect("inside")]);
                    m += 1;
                }
            }
        }
        low.push(if m > 0 { (s / m as f64) as f32 } else { 0.0 });
    }
    (filt, blks, low)
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

/// The moat grid ([`crate::trace::moat_geometry`]) on one patch, with the
/// patch's whitening: what a column's block-constant moat needs.
#[derive(Debug)]
pub(crate) struct PatchGrid {
    pub rect: Rect,
    /// Block side, px, and the global grid's width in blocks.
    block: usize,
    gw: usize,
    /// Global block coordinates of the patch's first block, and the patch's
    /// width in blocks.
    by0: usize,
    bx0: usize,
    bw: usize,
    /// Local block of every patch pixel.
    pub of: Vec<u32>,
    /// Inverse noise σ of every patch pixel (0 outside the FOV).
    pub s: Vec<f32>,
    /// Σ s² over each block.
    pub v: Vec<f64>,
    /// Patch pixels of each block: `px[start[b]..start[b + 1]]`.
    start: Vec<usize>,
    px: Vec<u32>,
}

impl PatchGrid {
    pub fn new(rect: Rect, dims: Dims, inv_sigma: &[f32], fov: &[u8], block: usize) -> PatchGrid {
        let w = dims.width;
        let b = block.max(1);
        let (by0, bx0) = (rect.y0 / b, rect.x0 / b);
        let bw = (rect.x0 + rect.w).div_ceil(b) - bx0;
        let bh = (rect.y0 + rect.h).div_ceil(b) - by0;
        let nb = bw * bh;
        let mut of = vec![0u32; rect.len()];
        let mut s = vec![0.0f32; rect.len()];
        let mut v = vec![0.0f64; nb];
        let mut count = vec![0usize; nb + 1];
        for y in 0..rect.h {
            for x in 0..rect.w {
                let (gy, gx) = (rect.y0 + y, rect.x0 + x);
                let lb = (gy / b - by0) * bw + (gx / b - bx0);
                let p = y * rect.w + x;
                of[p] = lb as u32;
                let g = gy * w + gx;
                s[p] = if fov[g] != 0 { inv_sigma[g] } else { 0.0 };
                v[lb] += f64::from(s[p]) * f64::from(s[p]);
                count[lb + 1] += 1;
            }
        }
        for k in 0..nb {
            count[k + 1] += count[k];
        }
        let start = count.clone();
        let mut px = vec![0u32; rect.len()];
        let mut at = count;
        for (p, &lb) in of.iter().enumerate() {
            px[at[lb as usize]] = p as u32;
            at[lb as usize] += 1;
        }
        PatchGrid {
            rect,
            block,
            gw: w.div_ceil(b),
            by0,
            bx0,
            bw,
            of,
            s,
            v,
            start,
            px,
        }
    }

    pub fn len(&self) -> usize {
        self.v.len()
    }

    /// Local block of the global block `bq`, if it meets the patch.
    fn local(&self, bq: u32) -> Option<u32> {
        let (by, bx) = (bq as usize / self.gw, bq as usize % self.gw);
        let bh = self.v.len() / self.bw.max(1);
        (by >= self.by0 && by < self.by0 + bh && bx >= self.bx0 && bx < self.bx0 + self.bw)
            .then(|| ((by - self.by0) * self.bw + (bx - self.bx0)) as u32)
    }

    #[inline]
    fn block_px(&self, b: u32) -> &[u32] {
        &self.px[self.start[b as usize]..self.start[b as usize + 1]]
    }

    /// `Σ_{p ∈ B} s_p y_p` for every block.
    pub fn sums(&self, y: &[f32]) -> Vec<f64> {
        let mut z = vec![0.0f64; self.v.len()];
        let (w, b) = (self.rect.w, self.block.max(1));
        // Row segments that lie in one block.
        let first = (b - self.rect.x0 % b).min(w);
        for (yy, (row, srow)) in y.chunks(w).zip(self.s.chunks(w)).enumerate() {
            let base = ((self.rect.y0 + yy) / b - self.by0) * self.bw;
            let mut x = 0;
            let mut k = 0;
            while x < w {
                let len = if x == 0 { first } else { b.min(w - x) };
                let acc: f32 = row[x..x + len]
                    .iter()
                    .zip(&srow[x..x + len])
                    .map(|(&v, &s)| v * s)
                    .sum();
                z[base + k] += f64::from(acc);
                x += len;
                k += 1;
            }
        }
        z
    }
}

/// One column of a patch problem: patch-local pixels and whitened values.
///
/// With a moat grid the whitened column is `val` on the support pixels
/// `pix` minus `s_p low(B(p))` on every pixel of the blocks `blk`; `val`
/// holds `(filtered + low(B(p))) s_p`, so on the support the column is the
/// exact filtered footprint.
#[derive(Debug, Clone)]
pub(crate) struct Column {
    pub id: u64,
    pub pix: Vec<u32>,
    pub val: Vec<f32>,
    pub grid: Option<std::sync::Arc<PatchGrid>>,
    /// Local blocks of the moat and its low-pass block means (unwhitened).
    pub blk: Vec<u32>,
    pub low: Vec<f32>,
}

impl Column {
    /// The part of `cell`'s filtered column (moat included) inside the
    /// grid's patch, whitened.
    pub fn of(cell: &Cell, grid: &std::sync::Arc<PatchGrid>, width: usize) -> Column {
        let rect = grid.rect;
        let mut blk = Vec::new();
        let mut low = Vec::new();
        let mut gl: Vec<(u32, f32)> = Vec::new();
        if grid.block > 0 {
            for (&bq, &l) in cell.low_blk.iter().zip(&cell.low) {
                if let Some(lb) = grid.local(bq) {
                    blk.push(lb);
                    low.push(l);
                    gl.push((bq, l));
                }
            }
        }
        let mut pix = Vec::new();
        let mut val = Vec::new();
        for (&g, &v) in cell.pix.iter().zip(&cell.filt) {
            let (gy, gx) = (g as usize / width, g as usize % width);
            if let Some(l) = rect.local(gy, gx) {
                let mut u = v;
                if let (Some(by), Some(bx)) =
                    (gy.checked_div(grid.block), gx.checked_div(grid.block))
                {
                    let bq = (by * grid.gw + bx) as u32;
                    if let Ok(k) = gl.binary_search_by_key(&bq, |e| e.0) {
                        u += gl[k].1;
                    }
                }
                pix.push(l as u32);
                val.push(u * grid.s[l]);
            }
        }
        Column {
            id: cell.id,
            pix,
            val,
            grid: (grid.block > 0 && !blk.is_empty()).then(|| grid.clone()),
            blk,
            low,
        }
    }

    /// A column with no moat.
    #[cfg(test)]
    pub fn plain(id: u64, pix: Vec<u32>, val: Vec<f32>) -> Column {
        Column {
            id,
            pix,
            val,
            grid: None,
            blk: Vec::new(),
            low: Vec::new(),
        }
    }

    /// `out += c h̃` on the patch.
    pub fn add_to(&self, out: &mut [f32], c: f32) {
        for (&p, &v) in self.pix.iter().zip(&self.val) {
            out[p as usize] += v * c;
        }
        if let Some(g) = &self.grid {
            for (&b, &l) in self.blk.iter().zip(&self.low) {
                let lc = l * c;
                for &p in g.block_px(b) {
                    out[p as usize] -= lc * g.s[p as usize];
                }
            }
        }
    }

    /// The whole column as a dense patch.
    pub fn dense(&self, n: usize) -> Vec<f32> {
        let mut d = vec![0.0f32; n];
        self.add_to(&mut d, 1.0);
        d
    }

    /// The column's values on its support pixels (moat included).
    pub fn on_support(&self) -> Vec<f32> {
        match &self.grid {
            None => self.val.clone(),
            Some(g) => {
                let mut lo = vec![0.0f32; g.len()];
                for (&b, &l) in self.blk.iter().zip(&self.low) {
                    lo[b as usize] = l;
                }
                self.pix
                    .iter()
                    .zip(&self.val)
                    .map(|(&p, &v)| v - lo[g.of[p as usize] as usize] * g.s[p as usize])
                    .collect()
            }
        }
    }

    /// `h̃ᵀ y` for a dense patch `y`.
    pub fn dot(&self, y: &[f32]) -> f32 {
        let mut s: f64 = self
            .pix
            .iter()
            .zip(&self.val)
            .map(|(&p, &v)| f64::from(v * y[p as usize]))
            .sum();
        if let Some(g) = &self.grid {
            for (&b, &l) in self.blk.iter().zip(&self.low) {
                let z: f64 = g
                    .block_px(b)
                    .iter()
                    .map(|&p| f64::from(g.s[p as usize] * y[p as usize]))
                    .sum();
                s -= f64::from(l) * z;
            }
        }
        s as f32
    }

    /// `h̃ᵀ h̃`.
    pub fn norm2(&self) -> f32 {
        let mut s: f64 = self.val.iter().map(|&v| f64::from(v * v)).sum();
        if let Some(g) = &self.grid {
            let mut lo = vec![0.0f64; g.len()];
            for (&b, &l) in self.blk.iter().zip(&self.low) {
                lo[b as usize] = f64::from(l);
                s += f64::from(l) * f64::from(l) * g.v[b as usize];
            }
            for (&p, &v) in self.pix.iter().zip(&self.val) {
                s -=
                    2.0 * f64::from(v) * lo[g.of[p as usize] as usize] * f64::from(g.s[p as usize]);
            }
        }
        s.max(0.0) as f32
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
    /// The background the problem was built with (the per-frame solve with
    /// missing pixels takes their rows out of its Gram).
    bg: BgBasis,
    /// The moat grid of the patch (when any column has a moat).
    grid: Option<std::sync::Arc<PatchGrid>>,
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
        let grid = cols.iter().find_map(|c| c.grid.clone());
        let nb = grid.as_ref().map_or(0, |g| g.len());
        // Per column: its moat as a dense block vector, and its support
        // part summed per block (`Σ_{p∈S∩B} val_p s_p`).
        let mut lo_i = vec![0.0f64; nb];
        let mut cs_i = vec![0.0f64; nb];
        let cs: Vec<Vec<(u32, f64)>> = match &grid {
            Some(g) => cols
                .iter()
                .map(|c| {
                    let mut m: Vec<(u32, f64)> = Vec::new();
                    for (&p, &v) in c.pix.iter().zip(&c.val) {
                        let b = g.of[p as usize];
                        let x = f64::from(v * g.s[p as usize]);
                        match m.iter_mut().rev().find(|e| e.0 == b) {
                            Some(e) => e.1 += x,
                            None => m.push((b, x)),
                        }
                    }
                    *work += c.pix.len() as u64;
                    m
                })
                .collect(),
            None => Vec::new(),
        };
        for i in 0..n {
            for (&p, &v) in cols[i].pix.iter().zip(&cols[i].val) {
                buf[p as usize] = v;
            }
            if grid.is_some() {
                for (&b, &l) in cols[i].blk.iter().zip(&cols[i].low) {
                    lo_i[b as usize] = f64::from(l);
                }
                for &(b, x) in &cs[i] {
                    cs_i[b as usize] = x;
                }
            }
            for j in i..n {
                let mut d = 0.0f64;
                if !(cols[j].pix.is_empty() || lo[j] > hi[i] || hi[j] < lo[i]) {
                    d += cols[j]
                        .pix
                        .iter()
                        .zip(&cols[j].val)
                        .map(|(&p, &v)| f64::from(buf[p as usize] * v))
                        .sum::<f64>();
                    *work += cols[j].pix.len() as u64;
                }
                if let Some(g) = &grid {
                    // − Σ_{S_j} val_j s low_i − Σ_{B_j} low_j cs_i + Σ low_i low_j V.
                    if !cols[i].blk.is_empty() {
                        for &(b, x) in &cs[j] {
                            d -= x * lo_i[b as usize];
                        }
                    }
                    for (&b, &l) in cols[j].blk.iter().zip(&cols[j].low) {
                        let b = b as usize;
                        d += f64::from(l) * (lo_i[b] * g.v[b] - cs_i[b]);
                    }
                    *work += (cs[j].len() + cols[j].blk.len()) as u64;
                }
                gcc[i * n + j] = d;
                gcc[j * n + i] = d;
            }
            for &p in &cols[i].pix {
                buf[p as usize] = 0.0;
            }
            lo_i.iter_mut().for_each(|v| *v = 0.0);
            cs_i.iter_mut().for_each(|v| *v = 0.0);
        }
        // Background maps summed per block with the whitening.
        let mb: Vec<Vec<f64>> = match &grid {
            Some(g) => bg.maps.iter().map(|m| g.sums(m)).collect(),
            None => Vec::new(),
        };
        if grid.is_some() {
            *work += (k * n_px) as u64;
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
                if let Some(z) = mb.get(a) {
                    for (&b, &l) in c.blk.iter().zip(&c.low) {
                        gbc[a * n + i] -= f64::from(l) * z[b as usize];
                    }
                }
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
            bg: bg.clone(),
            grid,
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
        let s = self.column_dots(y, work);
        self.finish(&self.t, &self.q, &self.gbc, &self.bg_inv, &s, qb, yy, work)
    }

    /// `h̃_iᵀ y` per column.
    fn column_dots(&self, y: &[f32], work: &mut u64) -> Vec<f64> {
        let z = self.grid.as_ref().map(|g| {
            *work += y.len() as u64;
            g.sums(y)
        });
        self.cols
            .iter()
            .map(|col| {
                let mut s: f64 = col
                    .pix
                    .iter()
                    .zip(&col.val)
                    .map(|(&px, &v)| f64::from(v * y[px as usize]))
                    .sum();
                if let Some(z) = &z {
                    for (&b, &l) in col.blk.iter().zip(&col.low) {
                        s -= f64::from(l) * z[b as usize];
                    }
                }
                *work += (col.pix.len() + col.blk.len()) as u64;
                s
            })
            .collect()
    }

    /// [`Problem::solve`] on a frame some of whose pixels are missing
    /// (`miss`: sorted patch pixels, zero in `y`, and so in `qb` and `yy`):
    /// those pixels have zero weight. Zero weight is the whitening factor
    /// `s_p = 0` for that frame, i.e. the frame's normal equations are the
    /// full ones minus the missing pixels' design rows `a_p = (e_i(p), g_a(p))`
    /// (the column values, moat included, and the background maps):
    /// `G_t = G - Σ_p a_p a_pᵀ`. `y`, `qb`, `yy` already omit them, so only
    /// the Gram changes; the reduced Gram, `T` and the background inverse
    /// are re-derived for this frame (`k + n` is small).
    pub fn solve_missing(
        &self,
        y: &[f32],
        qb: &[f64],
        yy: f64,
        miss: &[u32],
        work: &mut u64,
    ) -> Fit {
        if miss.is_empty() {
            return self.solve(y, qb, yy, work);
        }
        let (n, k) = (self.n, self.k);
        let d = n + k;
        // Design rows of the missing pixels.
        let mut a = vec![0.0f64; miss.len() * d];
        for (i, col) in self.cols.iter().enumerate() {
            for (&px, &v) in col.pix.iter().zip(&col.val) {
                if let Ok(j) = miss.binary_search(&px) {
                    a[j * d + i] += f64::from(v);
                }
            }
            if let Some(g) = &col.grid {
                for (j, &px) in miss.iter().enumerate() {
                    let b = g.of[px as usize];
                    if let Some(m) = col.blk.iter().position(|&x| x == b) {
                        a[j * d + i] -= f64::from(col.low[m]) * f64::from(g.s[px as usize]);
                    }
                }
            }
        }
        for (j, &px) in miss.iter().enumerate() {
            for (b, m) in self.bg.maps.iter().enumerate() {
                a[j * d + n + b] = f64::from(m[px as usize]);
            }
        }
        *work += (miss.len() * (d * d + d)) as u64;
        // G_cc, G_bc, G_bb of the frame.
        let mut gcc = self.q.clone();
        for i in 0..n {
            for j in 0..n {
                gcc[i * n + j] += (0..k)
                    .map(|b| self.t[i * k + b] * self.gbc[b * n + j])
                    .sum::<f64>();
            }
        }
        let mut gbc = self.gbc.clone();
        let mut gbb = self.bg.gram.clone();
        for row in a.chunks_exact(d) {
            for i in 0..n {
                for j in 0..n {
                    gcc[i * n + j] -= row[i] * row[j];
                }
                for b in 0..k {
                    gbc[b * n + i] -= row[n + b] * row[i];
                }
            }
            for b in 0..k {
                for c in 0..k {
                    gbb[b * k + c] -= row[n + b] * row[n + c];
                }
            }
        }
        let tr = (0..k).map(|b| gbb[b * k + b]).sum::<f64>() / k.max(1) as f64;
        for b in 0..k {
            gbb[b * k + b] += 1e-9 * tr.max(0.0);
        }
        let Some(inv) = invert(&gbb, k) else {
            // The missing pixels took the background basis apart (a patch
            // that is mostly missing): no usable solution for the frame.
            return Fit {
                c: vec![0.0; n],
                beta: vec![0.0; k],
                chi2: yy,
            };
        };
        let mut t = vec![0.0f64; n * k];
        for i in 0..n {
            for b in 0..k {
                t[i * k + b] = (0..k).map(|c| gbc[c * n + i] * inv[c * k + b]).sum();
            }
        }
        let mut q = gcc;
        for i in 0..n {
            for j in 0..n {
                q[i * n + j] -= (0..k).map(|b| t[i * k + b] * gbc[b * n + j]).sum::<f64>();
            }
        }
        *work += (n * n * k + k * k * k) as u64;
        let s = self.column_dots(y, work);
        self.finish(&t, &q, &gbc, &inv, &s, qb, yy, work)
    }

    /// Non-negative solve from the column dots `s_i = h̃_iᵀ y`, the
    /// background projections `qb` and the energy `yy`, with the given
    /// Gram terms.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        t: &[f64],
        q_gram: &[f64],
        gbc: &[f64],
        bg_inv: &[f64],
        s: &[f64],
        qb: &[f64],
        yy: f64,
        work: &mut u64,
    ) -> Fit {
        let (n, k) = (self.n, self.k);
        let mut p = vec![0.0f64; n];
        for i in 0..n {
            let tb: f64 = (0..k).map(|a| t[i * k + a] * qb[a]).sum();
            p[i] = s[i] - tb;
        }
        let mut c = vec![0.0f64; n];
        let mut qc = vec![0.0f64; n];
        for _sweep in 0..100 {
            let mut worst = 0.0f64;
            for i in 0..n {
                let d_ii = q_gram[i * n + i];
                if d_ii <= 0.0 {
                    continue;
                }
                let new = (c[i] + (p[i] - qc[i]) / d_ii).max(0.0);
                let d = new - c[i];
                if d != 0.0 {
                    c[i] = new;
                    let row = &q_gram[i * n..(i + 1) * n];
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
                bb += qb[a] * bg_inv[a * k + b] * qb[b];
            }
        }
        let pc: f64 = p.iter().zip(&c).map(|(a, b)| a * b).sum();
        let cqc: f64 = c.iter().zip(&qc).map(|(a, b)| a * b).sum();
        let chi2 = yy - bb - 2.0 * pc + cqc;
        // β = G_bb⁻¹ (q_b − G_bc c).
        let mut beta = vec![0.0f64; k];
        let r: Vec<f64> = (0..k)
            .map(|a| qb[a] - (0..n).map(|i| gbc[a * n + i] * c[i]).sum::<f64>())
            .collect();
        for a in 0..k {
            beta[a] = (0..k).map(|b| bg_inv[a * k + b] * r[b]).sum();
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
        let mut field = self.grid.as_ref().map(|g| vec![0.0f32; g.len()]);
        for (col, &ci) in self.cols.iter().zip(&fit.c) {
            if ci != 0.0 {
                for (&p, &v) in col.pix.iter().zip(&col.val) {
                    out[p as usize] -= v * ci;
                }
                if let Some(f) = field.as_mut() {
                    for (&b, &l) in col.blk.iter().zip(&col.low) {
                        f[b as usize] += l * ci;
                    }
                }
            }
        }
        if let (Some(g), Some(f)) = (&self.grid, &field) {
            for ((o, &b), &s) in out.iter_mut().zip(&g.of).zip(&g.s) {
                *o += f[b as usize] * s;
            }
            *work += y.len() as u64;
        }
        *work += (y.len() * (bg.k + 1)) as u64;
    }
}

/// Alternating rank-1 fit on the pixels `dom` of residual frames `r`:
/// `r_t[dom] ≈ h c_t` with `c ≥ 0`, starting from `c` (updated in place).
/// Returns `h` on `dom`. `fixed_c` keeps the traces and does one `h` step.
///
/// Plain alternation, which is power iteration on the residual: with no
/// cell present it returns the top singular vector of the structured
/// residual.
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
/// factors (and the rank-1 one) when the parts look distinct on these frames: their traces
/// correlate below `max_corr`, each carries at least a fifth of the
/// energy, and the squared error drops by more than `2 (frames + pixels)`
/// (twice the parameters the second factor adds) against rank 1.
pub(crate) fn rank2_split(
    x: &[Vec<f32>],
    h0: &[f32],
    pix: &[u32],
    w: usize,
    max_corr: f32,
) -> Option<(Vec<f32>, Vec<f32>, Vec<f32>)> {
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
        .then_some((ha, hb, h1))
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
    fn moat_columns_solve_exact_mixtures_with_their_moats() {
        // Two cells' full filtered columns (support plus block-mean moat),
        // whitened by a non-uniform noise map, on a patch that clips one
        // moat: the solve recovers the mixture and its χ² is ~0.
        let dims = Dims {
            width: 100,
            height: 100,
        };
        let fov = vec![1u8; 10_000];
        let inv: Vec<f32> = (0..10_000).map(|i| 0.5 + (i % 7) as f32 * 0.1).collect();
        let mut filter = LocalFilter::new(20.0);
        let cfg = LibraryConfig::default();
        let mk = |id, cy: f32, cx: f32, filter: &mut LocalFilter| {
            let rect = Rect {
                y0: 0,
                x0: 0,
                h: 100,
                w: 100,
            };
            let a: Vec<f32> = (0..10_000)
                .map(|i| {
                    let (dy, dx) = ((i / 100) as f32 - cy, (i % 100) as f32 - cx);
                    let r2 = dy * dy + dx * dx;
                    if r2 < 100.0 {
                        (-r2 / 18.0).exp()
                    } else {
                        0.0
                    }
                })
                .collect();
            Cell::from_canvas(id, rect, &a, dims, &fov, &cfg, Extent::Given, filter).unwrap()
        };
        let c1 = mk(1, 40.0, 40.0, &mut filter);
        let c2 = mk(2, 48.0, 52.0, &mut filter);
        assert!(!c1.low.is_empty());
        let rect = Rect {
            y0: 16,
            x0: 16,
            h: 64,
            w: 64,
        };
        let grid = std::sync::Arc::new(PatchGrid::new(rect, dims, &inv, &fov, 8));
        let cols = vec![Column::of(&c1, &grid, 100), Column::of(&c2, &grid, 100)];
        let dense: Vec<Vec<f32>> = cols.iter().map(|c| c.dense(rect.len())).collect();
        // The dense columns are the cells' filtered columns, whitened.
        for (c, d) in [&c1, &c2].iter().zip(&dense) {
            for y in 0..rect.h {
                for x in 0..rect.w {
                    let g = ((rect.y0 + y) * 100 + rect.x0 + x) as u32;
                    let want = c.column_at(g, 100, 8) * inv[g as usize];
                    assert!((d[y * rect.w + x] - want).abs() < 1e-5);
                }
            }
        }
        let bg = BgBasis::new(rect);
        let mut work = 0;
        let pr = Problem::new(cols, &bg, rect.len(), &mut work);
        let y: Vec<f32> = (0..rect.len())
            .map(|p| 3.0 * dense[0][p] + 1.5 * dense[1][p] + 0.7 * bg.maps[4][p])
            .collect();
        let (qb, yy) = bg.project(&y);
        let fit = pr.solve(&y, &qb, yy, &mut work);
        assert!(
            (fit.c[0] - 3.0).abs() < 1e-2 && (fit.c[1] - 1.5).abs() < 1e-2,
            "{:?}",
            fit.c
        );
        assert!(fit.chi2.abs() < 1e-2, "chi2 {}", fit.chi2);
        let mut r = vec![0.0f32; rect.len()];
        pr.residual(&y, &fit, &bg, &mut r, &mut work);
        let rr: f32 = r.iter().map(|v| v * v).sum();
        assert!(rr < 1e-2, "residual energy {rr}");
        assert!(
            (pr.cols[0].dot(&dense[1])
                - dense[0]
                    .iter()
                    .zip(&dense[1])
                    .map(|(a, b)| a * b)
                    .sum::<f32>())
            .abs()
                < 1e-3
        );
        assert!((pr.cols[0].norm2() - dense[0].iter().map(|a| a * a).sum::<f32>()).abs() < 1e-3);
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
            Column::plain(id, pix, val)
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

    /// Missing pixels have zero weight: the per-frame Gram correction gives
    /// the least-squares solution on the valid pixels only (columns with
    /// moats, a non-uniform noise map, noise in the data), and the solve
    /// that ignores the problem (y = 0 there, full Gram) does not.
    #[test]
    fn patch_solve_with_missing_pixels_matches_full_solve_on_valid_pixels() {
        let dims = Dims {
            width: 100,
            height: 100,
        };
        let fov = vec![1u8; 10_000];
        let inv: Vec<f32> = (0..10_000).map(|i| 0.5 + (i % 7) as f32 * 0.1).collect();
        let mut filter = LocalFilter::new(20.0);
        let cfg = LibraryConfig::default();
        let mk = |id, cy: f32, cx: f32, filter: &mut LocalFilter| {
            let rect = Rect {
                y0: 0,
                x0: 0,
                h: 100,
                w: 100,
            };
            let a: Vec<f32> = (0..10_000)
                .map(|i| {
                    let (dy, dx) = ((i / 100) as f32 - cy, (i % 100) as f32 - cx);
                    let r2 = dy * dy + dx * dx;
                    if r2 < 100.0 {
                        (-r2 / 18.0).exp()
                    } else {
                        0.0
                    }
                })
                .collect();
            Cell::from_canvas(id, rect, &a, dims, &fov, &cfg, Extent::Given, filter).unwrap()
        };
        let c1 = mk(1, 40.0, 40.0, &mut filter);
        let c2 = mk(2, 48.0, 52.0, &mut filter);
        let rect = Rect {
            y0: 16,
            x0: 16,
            h: 64,
            w: 64,
        };
        let grid = std::sync::Arc::new(PatchGrid::new(rect, dims, &inv, &fov, 8));
        let cols = vec![Column::of(&c1, &grid, 100), Column::of(&c2, &grid, 100)];
        let dense: Vec<Vec<f32>> = cols.iter().map(|c| c.dense(rect.len())).collect();
        let bg = BgBasis::new(rect);
        let n_px = rect.len();
        let mut work = 0;
        let pr = Problem::new(cols, &bg, n_px, &mut work);
        // Data: the mixture plus noise (deterministic).
        let mut seed = 12345u64;
        let mut noise = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (((seed >> 40) as f32) / (1u64 << 24) as f32 - 0.5) * 1.5
        };
        let y_full: Vec<f32> = (0..n_px)
            .map(|p| 3.0 * dense[0][p] + 1.5 * dense[1][p] + 0.7 * bg.maps[4][p] + noise())
            .collect();
        // Missing: a band across both cells' flanks plus a few scattered
        // pixels (sorted).
        let miss: Vec<u32> = (0..n_px as u32)
            .filter(|&p| {
                let (y, x) = (p as usize / rect.w, p as usize % rect.w);
                ((20..44).contains(&y) && (30..33).contains(&x)) || p % 211 == 5
            })
            .collect();
        assert!(miss.len() > 60);
        let mut y = y_full.clone();
        for &p in &miss {
            y[p as usize] = 0.0;
        }
        let (qb, yy) = bg.project(&y);
        let got = pr.solve_missing(&y, &qb, yy, &miss, &mut work);
        // Reference: dense least squares on the valid pixels, columns and
        // background maps as they are (the ridge is negligible).
        let valid: Vec<usize> = (0..n_px)
            .filter(|p| miss.binary_search(&(*p as u32)).is_err())
            .collect();
        let design: Vec<&[f32]> = dense
            .iter()
            .map(|d| d.as_slice())
            .chain(bg.maps.iter().map(|m| m.as_slice()))
            .collect();
        let d = design.len();
        let mut g = vec![0.0f64; d * d];
        let mut b = vec![0.0f64; d];
        for a in 0..d {
            for c in 0..d {
                g[a * d + c] = valid
                    .iter()
                    .map(|&p| f64::from(design[a][p]) * f64::from(design[c][p]))
                    .sum();
            }
            b[a] = valid
                .iter()
                .map(|&p| f64::from(design[a][p]) * f64::from(y[p]))
                .sum();
        }
        let ginv = invert(&g, d).unwrap();
        let theta: Vec<f64> = (0..d)
            .map(|a| (0..d).map(|c| ginv[a * d + c] * b[c]).sum())
            .collect();
        let chi2: f64 = valid
            .iter()
            .map(|&p| {
                let m: f64 = (0..d).map(|a| theta[a] * f64::from(design[a][p])).sum();
                (f64::from(y[p]) - m).powi(2)
            })
            .sum();
        for i in 0..2 {
            assert!(
                (f64::from(got.c[i]) - theta[i]).abs() < 1e-3 * theta[i].abs().max(1.0),
                "cell {i}: {} vs {}",
                got.c[i],
                theta[i]
            );
        }
        assert!(
            (got.chi2 - chi2).abs() < 1e-3 * chi2.max(1.0),
            "{} vs {chi2}",
            got.chi2
        );
        // Without the correction (zeros, full Gram) the band drags the
        // amplitudes: the corrected solve is much closer.
        let plain = pr.solve(&y, &qb, yy, &mut work);
        let e_fix: f64 = (0..2).map(|i| (f64::from(got.c[i]) - theta[i]).abs()).sum();
        let e_plain: f64 = (0..2)
            .map(|i| (f64::from(plain.c[i]) - theta[i]).abs())
            .sum();
        assert!(e_fix < 0.05 * e_plain, "fixed {e_fix} vs plain {e_plain}");
        // No missing pixels: the plain solve exactly.
        let (qf, yf) = bg.project(&y_full);
        let none = pr.solve_missing(&y_full, &qf, yf, &[], &mut work);
        assert_eq!(none.c, pr.solve(&y_full, &qf, yf, &mut work).c);
    }
}
