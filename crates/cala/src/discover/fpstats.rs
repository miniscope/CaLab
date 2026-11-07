//! Running footprint statistics: every fitting frame refines every cell.
//!
//! The tile reservoir holds a few dozen frames per tile, so a footprint
//! re-estimated from it is noisy and changes on every visit (v2 made about
//! two refinements per cell per minute on real data, and the noise made
//! cells drift onto their neighbours). The fast loop, though, solves *every*
//! frame for every cell's trace `c_t`. Correlating each cell's own-signal
//! residual `r_t = y_t − model_t − level_t + h_t c_t` with `c_t` over all
//! fitting frames gives the least-squares filtered footprint with the trace
//! held fixed,
//!
//! `h(p) = cov(r(p), c) / var(c)`,
//!
//! on a disk somewhat wider than the cell's support, so a footprint that
//! covers only part of its cell (a fragment) sees the rest of the cell in
//! its residual and grows to it. Centring removes static light and makes an
//! independent neighbour's signal average out instead of leaking in (the
//! overstretching Raymond Chang's cala ran into with uncentred updates).
//! The noise of `h` falls as `1 / sqrt(frames)`, so successive estimates
//! converge and the refinements they drive die out.
//!
//! The own-signal term `h_t c_t` uses the column the fast loop had at frame
//! `t`, so it cancels that frame's own model exactly whatever the footprint
//! was then. Old frames are forgotten with a half-life, because the other
//! cells' footprints (and so the residual) keep improving. Held-out frames
//! are never accumulated: the slow loop's tests stay out of sample.

/// Statistics of one cell on a disk around its support.
#[derive(Debug, Clone)]
pub(crate) struct FpStats {
    /// Disk centre and radius, px.
    pub center: (f32, f32),
    pub radius: f32,
    /// Global pixels of the disk (FOV only), row-major.
    pub pix: Vec<u32>,
    /// `Σ w r(p) c` and `Σ w r(p)`.
    pub rc: Vec<f32>,
    pub r: Vec<f32>,
    /// `Σ w`, `Σ w²`, `Σ w c`, `Σ w c²`.
    pub n: f64,
    pub n2: f64,
    pub s1: f64,
    pub s2: f64,
    /// Library version the support map below belongs to, and for each
    /// support pixel of that version's column its index in `pix`.
    pub version: u64,
    pub map: Vec<u32>,
}

impl FpStats {
    /// Empty statistics on the FOV pixels of the disk `(center, radius)`.
    pub fn new(
        center: (f32, f32),
        radius: f32,
        width: usize,
        height: usize,
        fov: &[u8],
    ) -> FpStats {
        let pix = disk_pixels(center, radius, width, height, fov);
        let n = pix.len();
        FpStats {
            center,
            radius,
            pix,
            rc: vec![0.0; n],
            r: vec![0.0; n],
            n: 0.0,
            n2: 0.0,
            s1: 0.0,
            s2: 0.0,
            version: u64::MAX,
            map: Vec::new(),
        }
    }

    /// Move to a new disk, keeping the sums of the pixels both disks share.
    /// New pixels start at zero (no signal: what the current footprint, zero
    /// outside its old support, says there).
    pub fn moved(
        &self,
        center: (f32, f32),
        radius: f32,
        width: usize,
        height: usize,
        fov: &[u8],
    ) -> FpStats {
        let mut s = FpStats::new(center, radius, width, height, fov);
        s.n = self.n;
        s.n2 = self.n2;
        s.s1 = self.s1;
        s.s2 = self.s2;
        // Both pixel lists are sorted.
        let mut j = 0;
        for (i, &p) in s.pix.iter().enumerate() {
            while j < self.pix.len() && self.pix[j] < p {
                j += 1;
            }
            if j < self.pix.len() && self.pix[j] == p {
                s.rc[i] = self.rc[j];
                s.r[i] = self.r[j];
            }
        }
        s
    }

    /// Whether the support disk `(center, radius)` lies inside this disk.
    pub fn covers(&self, center: (f32, f32), radius: f32) -> bool {
        let d = ((center.0 - self.center.0).powi(2) + (center.1 - self.center.1).powi(2)).sqrt();
        d + radius <= self.radius + 0.5
    }

    /// Scale all sums (renormalisation of the forgetting weights).
    pub fn scale(&mut self, f: f32) {
        self.rc.iter_mut().for_each(|v| *v *= f);
        self.r.iter_mut().for_each(|v| *v *= f);
        let f = f64::from(f);
        self.n *= f;
        self.n2 *= f * f;
        self.s1 *= f;
        self.s2 *= f;
    }

    /// Variance of the trace per unit weight (0 when undefined).
    pub fn var_c(&self) -> f64 {
        if self.n <= 0.0 {
            return 0.0;
        }
        ((self.s2 - self.s1 * self.s1 / self.n) / self.n).max(0.0)
    }

    /// Standard error of the estimate per unit pixel noise:
    /// `1 / sqrt(n_eff var(c))`, `n_eff = (Σ w)² / Σ w²`.
    pub fn std_err(&self) -> f64 {
        let vc = self.var_c();
        if !(vc > 0.0) || !(self.n2 > 0.0) {
            return f64::INFINITY;
        }
        let n_eff = self.n * self.n / self.n2;
        1.0 / (n_eff * vc).sqrt()
    }

    /// Add one frame: `r` on `pix`, trace `c`, weight `w`.
    pub fn push(&mut self, r: &[f32], c: f32, w: f32) {
        let wc = w * c;
        if wc != 0.0 {
            for ((a, b), &v) in self.rc.iter_mut().zip(self.r.iter_mut()).zip(r) {
                *a += wc * v;
                *b += w * v;
            }
        } else {
            for (b, &v) in self.r.iter_mut().zip(r) {
                *b += w * v;
            }
        }
        let (w, c) = (f64::from(w), f64::from(c));
        self.n += w;
        self.n2 += w * w;
        self.s1 += w * c;
        self.s2 += w * c * c;
    }

    /// The footprint estimate `cov(r, c) / var(c)` on `pix` (unwhitened,
    /// filtered); `None` while the trace has no variance.
    pub fn estimate(&self) -> Option<Vec<f32>> {
        if self.n <= 0.0 {
            return None;
        }
        let vc = self.s2 - self.s1 * self.s1 / self.n;
        if !(vc > 0.0) {
            return None;
        }
        let m = self.s1 / self.n;
        Some(
            self.rc
                .iter()
                .zip(&self.r)
                .map(|(&rc, &r)| ((f64::from(rc) - f64::from(r) * m) / vc) as f32)
                .collect(),
        )
    }
}

/// FOV pixels of a disk, row-major, as global indices.
pub(crate) fn disk_pixels(
    center: (f32, f32),
    radius: f32,
    width: usize,
    height: usize,
    fov: &[u8],
) -> Vec<u32> {
    let mut out = Vec::new();
    let y0 = (center.0 - radius).floor().max(0.0) as usize;
    let y1 = ((center.0 + radius).ceil() as usize).min(height.saturating_sub(1));
    let x0 = (center.1 - radius).floor().max(0.0) as usize;
    let x1 = ((center.1 + radius).ceil() as usize).min(width.saturating_sub(1));
    for y in y0..=y1 {
        for x in x0..=x1 {
            let (dy, dx) = (y as f32 - center.0, x as f32 - center.1);
            if dy * dy + dx * dx <= radius * radius && fov[y * width + x] != 0 {
                out.push((y * width + x) as u32);
            }
        }
    }
    out
}
