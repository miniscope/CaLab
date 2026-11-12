//! Running footprint statistics: every fitting frame refines every cell.
//!
//! The tile reservoir holds a few dozen frames per tile, so a footprint
//! re-estimated from it is noisy and changes on every visit (v2 made about
//! two refinements per cell per minute on real data, and the noise made
//! cells drift onto their neighbours). The fast loop, though, solves *every*
//! frame for every cell. Correlating each cell's own-signal residual
//! `r_t = y_t − model_t − level_t + h_t c_t` with a trace of the cell over
//! all fitting frames gives the footprint with the trace held fixed,
//!
//! `h(p) = cov(r(p), z) / cov(x, z)`,
//!
//! on a disk somewhat wider than the cell's support, so a footprint that
//! covers only part of its cell (a fragment) sees the rest of the cell in
//! its residual and grows to it. Centring removes static light and makes an
//! independent neighbour's signal average out instead of leaking in (the
//! overstretching Raymond Chang's cala ran into with uncentred updates).
//! The noise of `h` falls as `1 / sqrt(frames)`, so successive estimates
//! converge and the refinements they drive die out.
//!
//! **Cross-fitting** ([`super::CrossFit`]; opt-in, off by default: no
//! measured gain, S1.2). With `z = x = c_t`, the trace
//! the fast loop fitted from the same pixels in the same frame, a pixel's
//! noise multiplies itself: `E[h] ∝ s h + Σ ã / ãᵀΣã` (`s` the trace's
//! per-frame SNR², `ã` the current column, `Σ` the pixel noise covariance),
//! one step of power iteration on `Σ` per refinement. With spatially
//! correlated noise the fixed point is a textured blob at the noise's
//! correlation length, and the pull does not shrink with more frames. The
//! cross-fitted estimator is an instrumental-variable regression:
//!
//! * the instrument `z` of a pixel is the mean of the ledger's unclamped
//!   coordinates of the neighbouring frames, `(u_{t−1} + u_{t+1}) / 2`
//!   (`Loo`; `ParityLoo`: measured on the pixels of the other block parity
//!   only), so its noise is independent of frame `t`'s noise at the pixel;
//! * the regressor `x = u_t` is the unclamped coordinate of the frame
//!   itself (unit gain on the cell's trace), used only through `cov(x, z)`,
//!   whose noise terms are independent too.
//!
//! Then `cov(r(p), z) = h(p) cov(c_t, c̄_t)` and `cov(x, z) = cov(c_t, c̄_t)`
//! with `c̄_t = (c_{t−1} + c_{t+1}) / 2` (times the same gain of the
//! instrument), so `h` is unbiased
//! whatever the noise's spatial correlation, as long as the noise is
//! uncorrelated from one frame to the next (`Loo`), or between pixels a
//! block apart (`ParityLoo`). The trace's lag-1 autocorrelation (≳ 0.9 for
//! calcium at 20 fps) and the noise of the instrument cost precision, which
//! the standard error reports: it is the regression's `1 / sqrt(n_eff
//! var(z))` divided by `λ = cov(x, z) / var(z)`. The moments are kept per
//! pixel class (block parity), each class with its own instrument.
//!
//! The own-signal term `h_t c_t` uses the column the fast loop had at frame
//! `t`, so it cancels that frame's own model exactly whatever the footprint
//! was then. Old frames are forgotten with a half-life, because the other
//! cells' footprints (and so the residual) keep improving. Held-out frames
//! are never accumulated: the slow loop's tests stay out of sample. (A
//! held-out frame's coordinate can be the next fitting frame's instrument:
//! it is one scalar per cell and parity, the fast loop's own output.)

/// Trace moments of one pixel class over the frames that pushed it:
/// `[Σ w, Σ w², Σ w z, Σ w z², Σ w x, Σ w x z]` (`z` the instrument, `x`
/// the regressor; without cross-fitting both are the fast loop's trace).
pub(crate) type Mom = [f64; 6];

/// Statistics of one cell on a disk around its support.
#[derive(Debug, Clone)]
pub(crate) struct FpStats {
    /// Disk centre and radius, px.
    pub center: (f32, f32),
    pub radius: f32,
    /// Global pixels of the disk (FOV only), row-major.
    pub pix: Vec<u32>,
    /// Block parity (pixel class, 0 or 1) of each pixel of `pix`, and the
    /// block side it was computed with.
    pub cls: Vec<u8>,
    pub blk: u32,
    /// `Σ w r(p) z` and `Σ w r(p)`.
    pub rc: Vec<f32>,
    pub r: Vec<f32>,
    /// Trace moments per pixel class.
    pub m: [Mom; 2],
    /// Library version the column below belongs to, and that version's
    /// filtered column on `pix` (moat included).
    pub version: u64,
    pub col: Vec<f32>,
    /// DIAG split-half: the same sums over alternate 256-frame blocks only
    /// (`rc`, `r`, the class moments), and the frame counter.
    pub half: (Vec<f32>, Vec<f32>, [Mom; 2]),
    pub k: u64,
    /// Per-pixel moments over the frames in which the pixel was valid:
    /// `None` until a missing pixel has been pushed (a disk away from the
    /// FOV edge never needs them, and keeps the class moments above).
    pub pm: Option<PixMoments>,
    /// The split-half sums' per-pixel moments (owner only; not on the wire).
    pub half_pm: Option<PixMoments>,
    /// Transient-band statistics in interleaved block groups (`None` when
    /// [`super::CoreTest`] is `Off`).
    pub fast: Option<Fast>,
    /// Cross-fitting: the last fitting frame's residual on `pix` and its
    /// weight (NaN: none), pushed once the next frame's coordinate is
    /// known (owner only; not on the wire).
    pub pending: (Vec<f32>, f32),
}

/// A pixel is trusted only when it was valid in at least this share of the
/// (forgetting-weighted) frames: below it the estimate rests on too few
/// frames to centre, and the pixel keeps "no signal" (0), as a new pixel does.
pub(crate) const MIN_VALID_SHARE: f64 = 0.1;

/// Block parity of global pixel `p`: `(⌊y/blk⌋ + ⌊x/blk⌋) mod 2`.
#[inline]
pub(crate) fn parity(p: u32, width: usize, blk: u32) -> u8 {
    let (y, x) = (p as usize / width, p as usize % width);
    let b = blk.max(1) as usize;
    ((y / b + x / b) % 2) as u8
}

/// Block side of the parity split for cells of diameter `d`, px: half a
/// cell, longer than the residual's 2–4 px correlation length and short
/// enough that every support (radius ≥ 6 px) covers blocks of both parities.
pub(crate) fn parity_block(cell_diameter_px: f32) -> u32 {
    (cell_diameter_px / 2.0).round().max(1.0) as u32
}

/// `λ = cov(x, z) / var(z)` of class moments (`None` when the instrument
/// has no variance or does not follow the regressor). Exactly 1 when the
/// regressor is the instrument (no cross-fitting).
fn lambda(m: &Mom) -> Option<f64> {
    let [n, _, s1, s2, sx, sxz] = *m;
    if !(n > 0.0) {
        return None;
    }
    if s1 == sx && s2 == sxz {
        return Some(1.0);
    }
    let vz = s2 - s1 * s1 / n;
    let cxz = sxz - sx * s1 / n;
    (vz > 0.0 && cxz > 0.0).then(|| cxz / vz)
}

/// Per-pixel `Σ w`, `Σ w²`, `Σ w z`, `Σ w z²` over the frames in which the
/// pixel was valid (a missing sample has zero weight, not a value). Same
/// roles as the first four class moments, one set per pixel of the disk.
#[derive(Debug, Clone, Default)]
pub(crate) struct PixMoments {
    pub n: Vec<f64>,
    pub n2: Vec<f64>,
    pub s1: Vec<f64>,
    pub s2: Vec<f64>,
}

impl PixMoments {
    /// Every pixel starts with its class moments: all frames so far saw it
    /// valid (the missing samples are new).
    pub fn filled(cls: &[u8], m: &[Mom; 2]) -> PixMoments {
        let f = |j: usize| cls.iter().map(|&c| m[c as usize][j]).collect();
        PixMoments {
            n: f(0),
            n2: f(1),
            s1: f(2),
            s2: f(3),
        }
    }

    #[inline]
    fn add(&mut self, i: usize, w: f64, c: f64) {
        self.n[i] += w;
        self.n2[i] += w * w;
        self.s1[i] += w * c;
        self.s2[i] += w * c * c;
    }

    fn scale(&mut self, f: f64) {
        self.n.iter_mut().for_each(|v| *v *= f);
        self.n2.iter_mut().for_each(|v| *v *= f * f);
        self.s1.iter_mut().for_each(|v| *v *= f);
        self.s2.iter_mut().for_each(|v| *v *= f);
    }

    fn get(&self, i: usize) -> [f64; 4] {
        [self.n[i], self.n2[i], self.s1[i], self.s2[i]]
    }

    /// The moments of pixel `i` minus those of `other` (the other
    /// split-half block).
    fn minus(&self, other: &PixMoments, i: usize) -> [f64; 4] {
        let (a, b) = (self.get(i), other.get(i));
        [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]]
    }

    /// Keep the pixels `new_pix` shares with `old_pix` (both sorted); the
    /// other pixels get their class's moments `fresh`.
    fn moved(&self, old_pix: &[u32], new_pix: &[u32], cls: &[u8], fresh: &[Mom; 2]) -> PixMoments {
        let mut out = PixMoments::filled(cls, fresh);
        let mut j = 0;
        for (i, &p) in new_pix.iter().enumerate() {
            while j < old_pix.len() && old_pix[j] < p {
                j += 1;
            }
            if j < old_pix.len() && old_pix[j] == p {
                out.n[i] = self.n[j];
                out.n2[i] = self.n2[j];
                out.s1[i] = self.s1[j];
                out.s2[i] = self.s2[j];
            }
        }
        out
    }
}

/// The regression `(rc - r m) / vz`, `m = s1 / n`, `vz = s2 - s1^2 / n` of
/// one pixel from its moments `[n, n2, s1, s2]`, and its standard error per
/// unit pixel noise `1 / sqrt(n_eff vz / n)` (both before the division by
/// `λ`). `None` when the pixel has too little valid weight (`<
/// MIN_VALID_SHARE * n_ref`) or the instrument no variance.
fn pixel_estimate(rc: f64, r: f64, m: [f64; 4], n_ref: f64) -> Option<(f32, f64)> {
    let [n, n2, s1, s2] = m;
    if !(n > 0.0) || !(n2 > 0.0) || n < MIN_VALID_SHARE * n_ref {
        return None;
    }
    let vc = s2 - s1 * s1 / n;
    if !(vc > 0.0) {
        return None;
    }
    let h = ((rc - r * (s1 / n)) / vc) as f32;
    let se = 1.0 / ((n * n / n2) * (vc / n)).sqrt();
    Some((h, se))
}

/// Median of the finite values (`INFINITY` when there are none).
fn median_finite(mut v: Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return f64::INFINITY;
    }
    let mid = v.len() / 2;
    *v.select_nth_unstable_by(mid, f64::total_cmp).1
}

/// Number of interleaved block groups of the transient-band statistics.
pub(crate) const FAST_GROUPS: usize = 8;
/// Frames per block of the groups (block `k / FAST_BLOCK` goes to group
/// `(k / FAST_BLOCK) % FAST_GROUPS`).
pub(crate) const FAST_BLOCK: u64 = 256;

/// Transient-band ("fast") running statistics: the residual and the
/// trace high-passed in time by subtracting their exponential moving average
/// (time constant `1 / alpha` frames), `r~ = r - ema(r)`, `c~ = c - ema(c)`,
/// so that light following the trace only on slow time scales (drift,
/// vignetting-dependent baseline wander, slow motion or filtering
/// artifacts) does not count as footprint light; calcium transients keep
/// most of their energy. The sums `Σ w c~ r~(p)`, `Σ w c~²`, `Σ w² c~²`
/// are kept per interleaved block group so that the estimate's noise can be
/// measured from the spread of the group estimates (all spatial and
/// temporal correlation included) instead of being assumed white.
///
/// With cross-fitting, `c` is each pixel class's instrument (the band's
/// trace sums are per class) and the estimates are divided by the all-band
/// `λ` of the class, so they are on the all-band estimate's scale (the
/// band's own lag-1 autocorrelation is somewhat lower, so they are slightly
/// smaller; they are used through noise ratios).
#[derive(Debug, Clone)]
pub(crate) struct Fast {
    pub alpha: f32,
    /// Per-pixel moving average of `r` (NaN until the pixel's first frame).
    pub ema: Vec<f32>,
    /// Moving average of each class's instrument.
    pub ema_c: [f64; 2],
    /// `Σ w c~ r~(p)` per group.
    pub rc: Vec<Vec<f32>>,
    /// `[Σ w c~², Σ w² c~²]` per group and pixel class.
    pub w: [[[f64; 2]; 2]; FAST_GROUPS],
    /// The same per group and pixel over the frames in which the pixel was
    /// valid (`None` until a missing pixel has been pushed).
    pub wp: Option<Vec<Vec<[f64; 2]>>>,
}

impl Fast {
    pub fn new(n: usize, alpha: f32) -> Fast {
        Fast {
            alpha,
            ema: vec![f32::NAN; n],
            ema_c: [f64::NAN; 2],
            rc: vec![vec![0.0; n]; FAST_GROUPS],
            w: [[[0.0; 2]; 2]; FAST_GROUPS],
            wp: None,
        }
    }

    /// `[Σ w c~², Σ w² c~²]` of pixel `i` (class `c`) in group `g`.
    #[inline]
    fn wpix(&self, g: usize, i: usize, c: u8) -> [f64; 2] {
        match &self.wp {
            Some(wp) => wp[g][i],
            None => self.w[g][c as usize],
        }
    }

    /// Per-group estimates `h_g(p) = Σ c~ r~ / Σ c~² / λ` (groups without
    /// trace variance get `None`), for pixel classes `cls` with gains `lam`.
    pub fn groups(&self, cls: &[u8], lam: [f64; 2]) -> Vec<Option<Vec<f32>>> {
        (0..FAST_GROUPS)
            .map(|g| {
                let used = [0u8, 1].map(|c| cls.contains(&c));
                let ok = (0..2).all(|c| !used[c] || self.w[g][c][0] > 0.0);
                ok.then(|| {
                    self.rc[g]
                        .iter()
                        .zip(cls)
                        .enumerate()
                        .map(|(i, (&v, &c))| {
                            let w = self.wpix(g, i, c);
                            if w[0] > 0.0 {
                                (f64::from(v) / w[0] / lam[c as usize]) as f32
                            } else {
                                0.0
                            }
                        })
                        .collect()
                })
            })
            .collect()
    }

    /// Per-group `[Σ w c~², Σ w² c~²]` pooled over the classes (pixel-count
    /// weighted) and rescaled by `λ²`, so that their ratios are the white
    /// noise units of the rescaled estimates.
    pub fn group_weights(&self, cls: &[u8], lam: [f64; 2]) -> Vec<[f64; 2]> {
        let n1 = cls.iter().filter(|&&c| c == 1).count() as f64;
        let n = cls.len().max(1) as f64;
        let share = [(n - n1) / n, n1 / n];
        (0..FAST_GROUPS)
            .map(|g| {
                let mut out = [0.0; 2];
                for c in 0..2 {
                    let l2 = lam[c] * lam[c];
                    out[0] += share[c] * self.w[g][c][0] * l2;
                    out[1] += share[c] * self.w[g][c][1] * l2;
                }
                out
            })
            .collect()
    }

    /// The pooled estimate `Σ_g Σ c~ r~ / Σ_g Σ c~² / λ` and its white
    /// standard error per unit pixel noise `sqrt(Σ w² c~²) / Σ w c~² / λ`
    /// (median over pixels).
    pub fn estimate(&self, cls: &[u8], lam: [f64; 2]) -> Option<(Vec<f32>, f64)> {
        let tot = |c: usize, j: usize| self.w.iter().map(|w| w[c][j]).sum::<f64>();
        for c in 0..2 {
            if cls.contains(&(c as u8)) && !(tot(c, 0) > 0.0) {
                return None;
            }
        }
        let n = self.ema.len();
        let mut h = vec![0.0f64; n];
        for rc in &self.rc {
            for (a, &v) in h.iter_mut().zip(rc) {
                *a += f64::from(v);
            }
        }
        // Per pixel: only the frames in which it was valid count, in the
        // numerator and in the denominator; pixels valid in too few
        // frames keep 0. The standard error is the median over pixels.
        let mut se = Vec::with_capacity(n);
        let out: Vec<f32> = (0..n)
            .map(|i| {
                let c = cls[i];
                let l = lam[c as usize];
                let (d0, d1) = match &self.wp {
                    Some(wp) => (
                        wp.iter().map(|g| g[i][0]).sum::<f64>(),
                        wp.iter().map(|g| g[i][1]).sum::<f64>(),
                    ),
                    None => (tot(c as usize, 0), tot(c as usize, 1)),
                };
                if d0 > 0.0 && d0 >= MIN_VALID_SHARE * tot(c as usize, 0) {
                    se.push(d1.sqrt() / d0 / l);
                    (h[i] / d0 / l) as f32
                } else {
                    0.0
                }
            })
            .collect();
        Some((out, median_finite(se)))
    }
}

/// Time constant of the transient band's high-pass, frames: 2 s at the
/// Miniscope's 20 fps, longer than a calcium transient's rise and decay
/// (so transients keep most of their energy) and shorter than baseline
/// drift and bleaching.
pub(crate) const FAST_TAU_FRAMES: f32 = 40.0;

impl FpStats {
    /// Empty statistics on the FOV pixels of the disk `(center, radius)`,
    /// pixel classes from blocks of side `blk`.
    pub fn new(
        center: (f32, f32),
        radius: f32,
        width: usize,
        height: usize,
        fov: &[u8],
        fast: bool,
        blk: u32,
    ) -> FpStats {
        let pix = disk_pixels(center, radius, width, height, fov);
        let n = pix.len();
        let cls = pix.iter().map(|&p| parity(p, width, blk)).collect();
        FpStats {
            center,
            radius,
            pix,
            cls,
            blk,
            rc: vec![0.0; n],
            r: vec![0.0; n],
            m: [[0.0; 6]; 2],
            version: u64::MAX,
            col: Vec::new(),
            half: (vec![0.0; n], vec![0.0; n], [[0.0; 6]; 2]),
            k: 0,
            pm: None,
            half_pm: None,
            fast: fast.then(|| Fast::new(n, 1.0 / FAST_TAU_FRAMES)),
            pending: (Vec::new(), f32::NAN),
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
        let mut s = FpStats::new(
            center,
            radius,
            width,
            height,
            fov,
            self.fast.is_some(),
            self.blk,
        );
        s.m = self.m;
        s.half.2 = self.half.2;
        s.k = self.k;
        if let (Some(f), Some(nf)) = (&self.fast, &mut s.fast) {
            nf.ema_c = f.ema_c;
            nf.w = f.w;
            if let Some(wp) = &f.wp {
                // New pixels start as if valid in every frame so far.
                nf.wp = Some(
                    (0..FAST_GROUPS)
                        .map(|g| {
                            let mut v: Vec<[f64; 2]> =
                                s.cls.iter().map(|&c| f.w[g][c as usize]).collect();
                            let mut j = 0;
                            for (i, &p) in s.pix.iter().enumerate() {
                                while j < self.pix.len() && self.pix[j] < p {
                                    j += 1;
                                }
                                if j < self.pix.len() && self.pix[j] == p {
                                    v[i] = wp[g][j];
                                }
                            }
                            v
                        })
                        .collect(),
                );
            }
        }
        if let Some(pm) = &self.pm {
            s.pm = Some(pm.moved(&self.pix, &s.pix, &s.cls, &self.m));
        }
        if let Some(pm) = &self.half_pm {
            s.half_pm = Some(pm.moved(&self.pix, &s.pix, &s.cls, &self.half.2));
        }
        // Both pixel lists are sorted.
        let mut j = 0;
        for (i, &p) in s.pix.iter().enumerate() {
            while j < self.pix.len() && self.pix[j] < p {
                j += 1;
            }
            if j < self.pix.len() && self.pix[j] == p {
                s.rc[i] = self.rc[j];
                s.r[i] = self.r[j];
                s.half.0[i] = self.half.0[j];
                s.half.1[i] = self.half.1[j];
                if let (Some(f), Some(nf)) = (&self.fast, &mut s.fast) {
                    nf.ema[i] = f.ema[j];
                    for g in 0..FAST_GROUPS {
                        nf.rc[g][i] = f.rc[g][j];
                    }
                }
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
        self.half.0.iter_mut().for_each(|v| *v *= f);
        self.half.1.iter_mut().for_each(|v| *v *= f);
        let ff = f64::from(f);
        if let Some(fa) = &mut self.fast {
            for g in 0..FAST_GROUPS {
                fa.rc[g].iter_mut().for_each(|v| *v *= f);
                for c in 0..2 {
                    fa.w[g][c][0] *= ff;
                    fa.w[g][c][1] *= ff * ff;
                }
            }
        }
        if let Some(wp) = self.fast.as_mut().and_then(|fa| fa.wp.as_mut()) {
            for g in wp.iter_mut() {
                for w in g.iter_mut() {
                    w[0] *= ff;
                    w[1] *= ff * ff;
                }
            }
        }
        if let Some(pm) = &mut self.pm {
            pm.scale(ff);
        }
        if let Some(pm) = &mut self.half_pm {
            pm.scale(ff);
        }
        for m in self.m.iter_mut().chain(self.half.2.iter_mut()) {
            scale_mom(m, ff);
        }
        self.pending.1 *= f;
    }

    /// `λ` of each pixel class (1 for a class without a usable one, whose
    /// estimate is then `None` anyway).
    pub fn lambdas(&self) -> [f64; 2] {
        [0, 1].map(|c| lambda(&self.m[c]).unwrap_or(1.0))
    }

    /// Whether every pixel class present on the disk has an estimate: its
    /// instrument varies and follows the regressor.
    fn classes_ok(&self) -> bool {
        (0..2).all(|c| !self.cls.contains(&(c as u8)) || lambda(&self.m[c]).is_some())
    }

    /// Standard error of the estimate per unit pixel noise, the median over
    /// the disk's pixels of `1 / sqrt(n_eff var(z)) / λ`, `n_eff = (Σ w)² /
    /// Σ w²` (over the frames that saw the pixel).
    pub fn std_err(&self) -> f64 {
        let lam = [0, 1].map(|c| lambda(&self.m[c]));
        median_finite(
            (0..self.pix.len())
                .map(|i| {
                    let c = self.cls[i] as usize;
                    let Some(l) = lam[c] else {
                        return f64::INFINITY;
                    };
                    let mm = &self.m[c];
                    let [n, n2, s1, s2] = match &self.pm {
                        Some(pm) => pm.get(i),
                        None => [mm[0], mm[1], mm[2], mm[3]],
                    };
                    if !(n > 0.0) || !(n2 > 0.0) || n < MIN_VALID_SHARE * mm[0] {
                        return f64::INFINITY;
                    }
                    let vc = (s2 - s1 * s1 / n).max(0.0) / n;
                    if vc > 0.0 {
                        1.0 / ((n * n / n2) * vc).sqrt() / l
                    } else {
                        f64::INFINITY
                    }
                })
                .collect(),
        )
    }

    /// Add one frame: `r` on `pix`, the instrument `z[c]` of each pixel
    /// class `c` (NaN: the class is not updated this frame), the regressor
    /// `x`, weight `w`. A NaN in `r` is a missing sample: it has zero
    /// weight in that pixel's moments (see [`PixMoments`]) rather than a
    /// value. Without cross-fitting, `z = [c, c]` and `x = c`.
    pub fn push(&mut self, r: &[f32], z: [f32; 2], x: f32, w: f32) {
        if x.is_nan() || z.iter().all(|v| v.is_nan()) {
            return;
        }
        if self.pm.is_none() && !r.iter().any(|v| v.is_nan()) {
            self.ensure_fast_ema(z);
            let in_half = (self.k / 256).is_multiple_of(2);
            let g = ((self.k / FAST_BLOCK) % FAST_GROUPS as u64) as usize;
            let ct = self.fast_trace(z);
            for (i, &v) in r.iter().enumerate() {
                let c = self.cls[i] as usize;
                let zc = z[c];
                if zc.is_nan() {
                    continue;
                }
                let wz = w * zc;
                self.rc[i] += wz * v;
                self.r[i] += w * v;
                if in_half {
                    self.half.0[i] += wz * v;
                    self.half.1[i] += w * v;
                }
                if let Some(fa) = &mut self.fast {
                    let e = &mut fa.ema[i];
                    if e.is_nan() {
                        *e = v;
                    }
                    fa.rc[g][i] += w * ct[c] * (v - *e);
                    *e += fa.alpha * (v - *e);
                }
            }
            self.finish_push(z, x, w, in_half, g, ct);
            return;
        }
        self.push_masked(r, z, x, w);
    }

    /// The transient band's moving averages start at the first value.
    fn ensure_fast_ema(&mut self, z: [f32; 2]) {
        if let Some(fa) = &mut self.fast {
            for c in 0..2 {
                if fa.ema_c[c].is_nan() && !z[c].is_nan() {
                    fa.ema_c[c] = f64::from(z[c]);
                }
            }
        }
    }

    /// Each class's high-passed instrument `z~ = z − ema(z)` this frame.
    fn fast_trace(&self, z: [f32; 2]) -> [f32; 2] {
        match &self.fast {
            Some(fa) => [0, 1].map(|c| (f64::from(z[c]) - fa.ema_c[c]) as f32),
            None => [0.0; 2],
        }
    }

    /// The class moments, the transient band's trace sums and moving
    /// averages, and the frame counter, after the pixels of a frame.
    fn finish_push(&mut self, z: [f32; 2], x: f32, w: f32, in_half: bool, g: usize, ct: [f32; 2]) {
        let (wf, xf) = (f64::from(w), f64::from(x));
        for c in 0..2 {
            if z[c].is_nan() {
                continue;
            }
            let zf = f64::from(z[c]);
            add_mom(&mut self.m[c], wf, zf, xf);
            if in_half {
                add_mom(&mut self.half.2[c], wf, zf, xf);
            }
            if let Some(fa) = &mut self.fast {
                let cw = wf * f64::from(ct[c]) * f64::from(ct[c]);
                fa.w[g][c][0] += cw;
                fa.w[g][c][1] += wf * cw;
                fa.ema_c[c] += f64::from(fa.alpha) * (zf - fa.ema_c[c]);
            }
        }
        self.k += 1;
    }

    /// [`FpStats::push`] with missing (NaN) samples: the per-pixel sums skip
    /// them, and the per-pixel moments count only the frames that saw the
    /// pixel. The class moments still count every frame: they are the
    /// trace's own statistics.
    fn push_masked(&mut self, r: &[f32], z: [f32; 2], x: f32, w: f32) {
        if self.pm.is_none() {
            // Every earlier frame saw every pixel.
            self.pm = Some(PixMoments::filled(&self.cls, &self.m));
            self.half_pm = Some(PixMoments::filled(&self.cls, &self.half.2));
            if let Some(fa) = &mut self.fast {
                let cls = &self.cls;
                fa.wp = Some(
                    (0..FAST_GROUPS)
                        .map(|g| cls.iter().map(|&c| fa.w[g][c as usize]).collect())
                        .collect(),
                );
            }
        }
        self.ensure_fast_ema(z);
        let wf = f64::from(w);
        let in_half = (self.k / 256).is_multiple_of(2);
        let g = ((self.k / FAST_BLOCK) % FAST_GROUPS as u64) as usize;
        let ct = self.fast_trace(z);
        let pm = self.pm.as_mut().expect("set");
        let hpm = self.half_pm.as_mut().expect("set");
        for (i, &v) in r.iter().enumerate() {
            let c = self.cls[i] as usize;
            if v.is_nan() || z[c].is_nan() {
                continue;
            }
            let zf = f64::from(z[c]);
            let wz = w * z[c];
            self.rc[i] += wz * v;
            self.r[i] += w * v;
            pm.add(i, wf, zf);
            if in_half {
                self.half.0[i] += wz * v;
                self.half.1[i] += w * v;
                hpm.add(i, wf, zf);
            }
            if let Some(fa) = &mut self.fast {
                let e = &mut fa.ema[i];
                if e.is_nan() {
                    *e = v;
                }
                fa.rc[g][i] += w * ct[c] * (v - *e);
                *e += fa.alpha * (v - *e);
                let cw = wf * f64::from(ct[c]) * f64::from(ct[c]);
                let wp = fa.wp.as_mut().expect("set");
                wp[g][i][0] += cw;
                wp[g][i][1] += wf * cw;
            }
        }
        self.finish_push(z, x, w, in_half, g, ct);
    }

    /// The estimate of pixel `i` from `rc`, `r` and its (or its class's)
    /// moments `m`, before `λ`, and its standard error.
    fn pixel(
        &self,
        i: usize,
        rc: f64,
        r: f64,
        pm: Option<&PixMoments>,
        m: &Mom,
    ) -> Option<(f32, f64)> {
        let mm = match pm {
            Some(pm) => pm.get(i),
            None => [m[0], m[1], m[2], m[3]],
        };
        pixel_estimate(rc, r, mm, m[0])
    }

    /// DIAG: the two split-half estimates (block A, block B = total − A) and
    /// their standard errors per unit pixel noise. Both are divided by the
    /// full statistics' `λ`.
    pub fn halves(&self) -> Option<(Vec<f32>, Vec<f32>, f64, f64)> {
        if !self.classes_ok() {
            return None;
        }
        let lam = self.lambdas();
        let len = self.pix.len();
        let mb: [Mom; 2] = [0, 1].map(|c| {
            let mut out = [0.0; 6];
            for j in 0..6 {
                out[j] = self.m[c][j] - self.half.2[c][j];
            }
            out
        });
        let (mut ha, mut hb) = (vec![0.0f32; len], vec![0.0f32; len]);
        let (mut sa, mut sb) = (Vec::new(), Vec::new());
        let pmb: Option<PixMoments> = match (&self.pm, &self.half_pm) {
            (Some(pm), Some(hpm)) => {
                let mut d = pm.clone();
                for i in 0..len {
                    let v = pm.minus(hpm, i);
                    d.n[i] = v[0];
                    d.n2[i] = v[1];
                    d.s1[i] = v[2];
                    d.s2[i] = v[3];
                }
                Some(d)
            }
            _ => None,
        };
        for i in 0..len {
            let c = self.cls[i] as usize;
            let l = lam[c];
            let rca = f64::from(self.half.0[i]);
            let ra = f64::from(self.half.1[i]);
            let ma = self.half.2[c];
            let est_a = match &self.half_pm {
                Some(hpm) => self.pixel(i, rca, ra, Some(hpm), &ma),
                None => self.pixel(i, rca, ra, None, &ma),
            };
            match est_a {
                Some((h, se)) => {
                    ha[i] = (f64::from(h) / l) as f32;
                    sa.push(se / l);
                }
                None if self.pm.is_none() => return None,
                None => {}
            }
            let rcb = f64::from(self.rc[i] - self.half.0[i]);
            let rb = f64::from(self.r[i] - self.half.1[i]);
            match self.pixel(i, rcb, rb, pmb.as_ref(), &mb[c]) {
                Some((h, se)) => {
                    hb[i] = (f64::from(h) / l) as f32;
                    sb.push(se / l);
                }
                None if self.pm.is_none() => return None,
                None => {}
            }
        }
        let (sa, sb) = (median_finite(sa), median_finite(sb));
        (sa.is_finite() && sb.is_finite()).then_some((ha, hb, sa, sb))
    }

    /// The footprint estimate `cov(r, z) / cov(x, z)` on `pix` (unwhitened,
    /// filtered); `None` while a pixel class's instrument has no variance
    /// or does not follow the trace.
    pub fn estimate(&self) -> Option<Vec<f32>> {
        if !self.classes_ok() {
            return None;
        }
        let lam = self.lambdas();
        let mut out = Vec::with_capacity(self.pix.len());
        for i in 0..self.pix.len() {
            let c = self.cls[i] as usize;
            let e = self.pixel(
                i,
                f64::from(self.rc[i]),
                f64::from(self.r[i]),
                self.pm.as_ref(),
                &self.m[c],
            );
            match e {
                Some((h, _)) => out.push((f64::from(h) / lam[c]) as f32),
                // Scalar moments: the class has no variance (checked above
                // through λ, so only a degenerate disk gets here).
                None if self.pm.is_none() => return None,
                // A pixel valid in too few frames keeps "no signal".
                None => out.push(0.0),
            }
        }
        Some(out)
    }

    /// The transient-band estimate on the all-band scale (see [`Fast`]).
    pub fn fast_estimate(&self) -> Option<(Vec<f32>, f64)> {
        self.fast.as_ref()?.estimate(&self.cls, self.lambdas())
    }

    /// The transient band's per-group estimates (see [`Fast::groups`]).
    pub fn fast_groups(&self) -> Option<Vec<Option<Vec<f32>>>> {
        Some(self.fast.as_ref()?.groups(&self.cls, self.lambdas()))
    }

    /// The transient band's per-group weights (see [`Fast::group_weights`]).
    pub fn fast_weights(&self) -> Option<Vec<[f64; 2]>> {
        Some(self.fast.as_ref()?.group_weights(&self.cls, self.lambdas()))
    }
}

#[inline]
fn add_mom(m: &mut Mom, w: f64, z: f64, x: f64) {
    m[0] += w;
    m[1] += w * w;
    m[2] += w * z;
    m[3] += w * z * z;
    m[4] += w * x;
    m[5] += w * x * z;
}

fn scale_mom(m: &mut Mom, f: f64) {
    m[0] *= f;
    m[1] *= f * f;
    for v in &mut m[2..] {
        *v *= f;
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

#[cfg(test)]
mod fast_tests {
    use super::*;

    /// Push without cross-fitting: the trace is instrument and regressor.
    fn push1(st: &mut FpStats, r: &[f32], c: f32, w: f32) {
        st.push(r, [c, c], c, w);
    }

    /// Uniform(-0.5, 0.5) from a counter (variance 1/12).
    fn u(k: u64) -> f32 {
        (crate::discover::reservoir::mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }

    /// White noise: the transient-band estimate is unbiased and its group
    /// spread matches the white standard error; light that follows only
    /// the trace's slow component is removed by the high-pass.
    #[test]
    fn fast_band_groups_measure_white_noise_and_drop_slow_light() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], false, 5);
        st.fast = Some(Fast::new(st.pix.len(), 1.0 / 40.0));
        let m = st.pix.len();
        let sd = (1.0f32 / 12.0).sqrt();
        let mut c_fast = 0.0f32;
        let mut r = vec![0.0f32; m];
        for t in 0..(FAST_BLOCK * FAST_GROUPS as u64 * 4) {
            // fast transients (decay 10 frames) plus a slow sinusoid
            let kick = if u(t * 7 + 1) > 0.47 { 5.0 } else { 0.0 };
            c_fast = 0.9 * c_fast + kick;
            let slow = (t as f32 / 3000.0 * std::f32::consts::TAU).sin() * 5.0;
            let c = c_fast + slow;
            for (i, v) in r.iter_mut().enumerate() {
                // footprint 1 on the first half; light that follows only
                // the slow component on the second half
                let light = if i < m / 2 { c } else { slow };
                *v = light + u(t * 1000 + i as u64 + 99) / sd;
            }
            push1(&mut st, &r, c, 1.0);
        }
        let (h, se) = st.fast_estimate().unwrap();
        let mean_in = h[..m / 2].iter().sum::<f32>() / (m / 2) as f32;
        let mean_out = h[m / 2..].iter().sum::<f32>() / (m - m / 2) as f32;
        assert!((mean_in - 1.0).abs() < 0.05, "{mean_in}");
        assert!(mean_out.abs() < 0.15, "{mean_out}");
        // the all-band estimate keeps the slow-only light
        let all = st.estimate().unwrap();
        let all_out = all[m / 2..].iter().sum::<f32>() / (m - m / 2) as f32;
        assert!(all_out > 0.3, "{all_out}");
        // per-pixel group spread over the white variance ≈ 1
        let groups: Vec<Vec<f32>> = st
            .fast_groups()
            .unwrap()
            .into_iter()
            .map(|g| g.unwrap())
            .collect();
        let wg: Vec<f64> = st.fast_weights().unwrap().iter().map(|w| w[0]).collect();
        let sw: f64 = wg.iter().sum();
        let mut ratio = 0.0;
        for i in 0..m / 2 {
            let mu: f64 = (0..FAST_GROUPS)
                .map(|g| wg[g] * f64::from(groups[g][i]))
                .sum::<f64>()
                / sw;
            let s2: f64 = (0..FAST_GROUPS)
                .map(|g| wg[g] * (f64::from(groups[g][i]) - mu).powi(2))
                .sum::<f64>()
                / (FAST_GROUPS as f64 - 1.0)
                / sw;
            ratio += s2 / (se * se);
        }
        ratio /= (m / 2) as f64;
        assert!((0.75..1.35).contains(&ratio), "{ratio}");
    }

    /// A cell whose rim is missing on half the frames: with zero weight for
    /// the missing samples the rim estimate is unbiased (within 2 standard
    /// errors); standing in a value of 0 (what the sums saw before) halves it.
    #[test]
    fn fpstats_ignores_missing_pixels() {
        let side = 11usize;
        let mut st = FpStats::new(
            (5.0, 5.0),
            5.5,
            side,
            side,
            &vec![1u8; side * side],
            true,
            5,
        );
        let mut zero = st.clone();
        let m = st.pix.len();
        let rim: Vec<bool> = st
            .pix
            .iter()
            .map(|&p| {
                let (y, x) = (p as usize / side, p as usize % side);
                x >= 8 || y >= 8
            })
            .collect();
        assert!(rim.iter().filter(|&&r| r).count() > 15);
        let frames = 6000u64;
        let mut c_slow = 0.0f32;
        for t in 0..frames {
            let kick = if u(t * 7 + 1) > 0.45 { 4.0 } else { 0.0 };
            c_slow = 0.85 * c_slow + kick;
            let c = c_slow;
            // The rim is missing on a random half of the frames.
            let gone = u(t * 13 + 5) > 0.0;
            let mut r = vec![0.0f32; m];
            let mut r0 = vec![0.0f32; m];
            for i in 0..m {
                // true footprint 1 everywhere, unit-variance noise
                let v = c + u(t * 1000 + i as u64 + 99) * 12f32.sqrt();
                r[i] = if rim[i] && gone { f32::NAN } else { v };
                r0[i] = if rim[i] && gone { 0.0 } else { v };
            }
            push1(&mut st, &r, c, 1.0);
            push1(&mut zero, &r0, c, 1.0);
        }
        assert!(st.pm.is_some() && zero.pm.is_none());
        let h = st.estimate().unwrap();
        let hz = zero.estimate().unwrap();
        let se = st.std_err();
        assert!(se.is_finite() && se > 0.0);
        let n_rim = rim.iter().filter(|&&r| r).count() as f32;
        let mean = |h: &[f32]| -> f32 {
            h.iter()
                .zip(&rim)
                .filter(|(_, &r)| r)
                .map(|(&v, _)| v)
                .sum::<f32>()
                / n_rim
        };
        let (a, b) = (mean(&h), mean(&hz));
        // Mean over n_rim pixels of per-pixel error of sd about `se`.
        assert!((a - 1.0).abs() < 2.0 * se as f32, "valid-only {a}, se {se}");
        assert!((b - 0.5).abs() < 0.1, "zero-filled {b}");
        // Interior pixels are untouched by the masking.
        let inner = h.iter().zip(&rim).filter(|(_, &r)| !r).map(|(&v, _)| v);
        let (s, k) = inner.fold((0.0f32, 0.0f32), |(s, k), v| (s + v, k + 1.0));
        assert!((s / k - 1.0).abs() < 0.05);
        // The transient-band estimate uses the same per-pixel weights.
        let (hf, _) = st.fast_estimate().unwrap();
        let fm = hf
            .iter()
            .zip(&rim)
            .filter(|(_, &r)| r)
            .map(|(&v, _)| v)
            .sum::<f32>()
            / n_rim;
        assert!((fm - 1.0).abs() < 0.15, "fast rim {fm}");
        // The split halves too.
        let (ha, hb, ..) = st.halves().unwrap();
        assert!((mean(&ha) - 1.0).abs() < 0.3 && (mean(&hb) - 1.0).abs() < 0.3);
    }

    /// With no missing sample the masked path is the scalar one.
    #[test]
    fn masked_push_without_missing_equals_scalar_push() {
        let mut a = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], true, 5);
        let mut b = a.clone();
        let m = a.pix.len();
        // Per-pixel moments from the start: they must track the scalar ones.
        b.pm = Some(PixMoments::filled(&b.cls, &[[0.0; 6]; 2]));
        b.half_pm = Some(PixMoments::filled(&b.cls, &[[0.0; 6]; 2]));
        if let Some(f) = &mut b.fast {
            f.wp = Some(vec![vec![[0.0; 2]; m]; FAST_GROUPS]);
        }
        for t in 0..2000u64 {
            let r: Vec<f32> = (0..m)
                .map(|i| u(t * 100 + i as u64) * 3.0 + i as f32 * 0.1)
                .collect();
            let c = u(t + 5_000_000) + 1.0;
            push1(&mut a, &r, c, 0.99f32.powi((t % 50) as i32));
            push1(&mut b, &r, c, 0.99f32.powi((t % 50) as i32));
        }
        let (ea, eb) = (a.estimate().unwrap(), b.estimate().unwrap());
        for (x, y) in ea.iter().zip(&eb) {
            assert!((x - y).abs() < 1e-4 * x.abs().max(1.0), "{x} vs {y}");
        }
        assert!((a.std_err() - b.std_err()).abs() < 1e-6 * a.std_err());
        let (fa, fb) = (a.fast_estimate().unwrap(), b.fast_estimate().unwrap());
        for (x, y) in fa.0.iter().zip(&fb.0) {
            assert!((x - y).abs() < 1e-4 * x.abs().max(1.0), "{x} vs {y}");
        }
    }

    /// Per-pixel moments and weights cross the wire and survive a move.
    #[test]
    fn per_pixel_moments_cross_the_wire_and_a_move() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], true, 5);
        let m = st.pix.len();
        for t in 0..(FAST_BLOCK * 3) {
            let r: Vec<f32> = (0..m)
                .map(|i| {
                    if (i + t as usize).is_multiple_of(5) {
                        f32::NAN
                    } else {
                        i as f32 * 0.1 + u(t * 77 + i as u64)
                    }
                })
                .collect();
            push1(&mut st, &r, u(t) + 1.0, 1.0);
        }
        let mut w = crate::discover::wire::Writer::default();
        w.fpstats(&st);
        let back = crate::discover::wire::Reader::new(&w.buf)
            .fpstats()
            .unwrap();
        assert_eq!(st.estimate(), back.estimate());
        assert_eq!(st.std_err(), back.std_err());
        assert_eq!(st.fast_estimate(), back.fast_estimate());
        // A larger disk keeps the shared pixels' moments.
        let big = st.moved((4.0, 4.0), 4.0, 9, 9, &[1u8; 81]);
        assert_eq!(big.estimate(), st.estimate());
        let mut s2 = st.clone();
        s2.scale(0.5);
        let (e1, e2) = (st.estimate().unwrap(), s2.estimate().unwrap());
        for (x, y) in e1.iter().zip(&e2) {
            assert!((x - y).abs() < 1e-3 * x.abs().max(1.0));
        }
    }

    /// A visit in another worker sees the same transient-band estimate.
    #[test]
    fn fast_sums_cross_the_wire() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], false, 5);
        st.fast = Some(Fast::new(st.pix.len(), 1.0 / FAST_TAU_FRAMES));
        let r: Vec<f32> = (0..st.pix.len()).map(|i| i as f32).collect();
        for t in 0..(FAST_BLOCK * FAST_GROUPS as u64) {
            push1(&mut st, &r, u(t), 1.0);
        }
        let mut w = crate::discover::wire::Writer::default();
        w.fpstats(&st);
        let back = crate::discover::wire::Reader::new(&w.buf)
            .fpstats()
            .unwrap();
        assert_eq!(st.fast_estimate(), back.fast_estimate());
        assert_eq!(st.fast_groups(), back.fast_groups());
        let mut st2 = st.clone();
        st2.fast = None;
        let mut w = crate::discover::wire::Writer::default();
        w.fpstats(&st2);
        assert!(crate::discover::wire::Reader::new(&w.buf)
            .fpstats()
            .unwrap()
            .fast
            .is_none());
    }
}

/// Cross-fitting (model review, root cause B): on spatially correlated
/// noise, the same-pixel, same-frame estimator has a noise fixed point;
/// the cross-fitted one does not.
#[cfg(test)]
mod crossfit_tests {
    use super::*;
    use crate::discover::local::rank1;

    /// Standard normal-ish (sum of 4 uniforms, unit variance) from a counter.
    fn g(k: u64) -> f32 {
        let u = |j: u64| {
            (crate::discover::reservoir::mix(k * 4 + j) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
        };
        (u(0) + u(1) + u(2) + u(3)) * 3f32.sqrt()
    }

    /// White noise blurred by a Gaussian of σ `sb` px, unit variance per
    /// pixel, on a `side`² grid (frame `t`).
    fn blurred(t: u64, side: usize, sb: f32) -> Vec<f32> {
        let rad = (3.0 * sb).ceil() as i64;
        let k: Vec<f32> = (-rad..=rad)
            .map(|d| (-(d * d) as f32 / (2.0 * sb * sb)).exp())
            .collect();
        let k2: f32 = k.iter().map(|v| v * v).sum();
        let big = side + 2 * rad as usize;
        let white: Vec<f32> = (0..big * big)
            .map(|i| g(t * 1_000_003 + i as u64))
            .collect();
        let mut tmp = vec![0.0f32; big * side];
        for y in 0..big {
            for x in 0..side {
                tmp[y * side + x] = (0..k.len()).map(|j| k[j] * white[y * big + x + j]).sum();
            }
        }
        let mut out = vec![0.0f32; side * side];
        for y in 0..side {
            for x in 0..side {
                out[y * side + x] = (0..k.len())
                    .map(|j| k[j] * tmp[(y + j) * side + x])
                    .sum::<f32>()
                    / k2;
            }
        }
        out
    }

    fn corr(a: &[f32], b: &[f32]) -> f64 {
        let n = a.len() as f64;
        let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
        let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
        let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
        for (&x, &y) in a.iter().zip(b) {
            let (x, y) = (f64::from(x) - ma, f64::from(y) - mb);
            ab += x * y;
            aa += x * x;
            bb += y * y;
        }
        ab / (aa * bb).sqrt().max(1e-30)
    }

    /// The fast/slow loop on one cell, emulated: each frame the trace is the
    /// projection of the frame on the current column (`u`, per parity
    /// `u_k`), the statistics are pushed (cross-fitted: one frame later,
    /// with the neighbouring frames' other-parity coordinates), and every
    /// 300 frames the column becomes the estimate. Returns the final
    /// estimate's correlation with the true footprint on the disk, and the
    /// trace's per-frame SNR² against the projected noise.
    fn converge(crossfit: bool, frames: u64, amp: f32) -> (f64, f64) {
        let side = 33usize;
        let (cy, cx, sig) = (16.0f32, 16.0f32, 2.5f32);
        let fov = vec![1u8; side * side];
        let blk = parity_block(10.0);
        let mut st = FpStats::new((cy, cx + 1.5), 10.0, side, side, &fov, false, blk);
        let pix = st.pix.clone();
        let foot = |p: u32, dx: f32| {
            let (y, x) = ((p as usize / side) as f32, (p as usize % side) as f32);
            (-((y - cy).powi(2) + (x - cx - dx).powi(2)) / (2.0 * sig * sig)).exp()
        };
        let truth: Vec<f32> = pix.iter().map(|&p| foot(p, 0.0)).collect();
        // Start displaced by 3 px.
        let mut col: Vec<f32> = pix.iter().map(|&p| foot(p, 3.0)).collect();
        let mut c = 0.0f32;
        // `[u, u_0, u_1]` per frame since the last column change, and the
        // buffered residual.
        let mut hist: Vec<[f32; 3]> = Vec::new();
        let mut pending: Option<Vec<f32>> = None;
        let (mut cs, mut cs2, mut ns2) = (0.0f64, 0.0f64, 0.0f64);
        let hh: f32 = truth.iter().map(|v| v * v).sum();
        for t in 0..frames {
            let kick = if g(t * 31 + 7) > 1.6 { amp } else { 0.0 };
            c = 0.9 * c + kick;
            let noise = blurred(t, side, 1.5);
            let y: Vec<f32> = pix
                .iter()
                .zip(&truth)
                .map(|(&p, &h)| h * c + noise[p as usize])
                .collect();
            let pn: f32 = pix
                .iter()
                .zip(&truth)
                .map(|(&p, &h)| h * noise[p as usize])
                .sum::<f32>()
                / hh;
            cs += f64::from(c);
            cs2 += f64::from(c * c);
            ns2 += f64::from(pn * pn);
            let (mut num, mut den) = ([0.0f32; 3], [0.0f32; 3]);
            for ((&a, &v), &k) in col.iter().zip(&y).zip(&st.cls) {
                let a = a.max(0.0);
                for j in [0, 1 + k as usize] {
                    num[j] += a * v;
                    den[j] += a * a;
                }
            }
            let u = [0, 1, 2].map(|j| {
                if den[j] > 0.0 {
                    num[j] / den[j]
                } else {
                    f32::NAN
                }
            });
            hist.push(u);
            if crossfit {
                if let (Some(r), true) = (pending.take(), hist.len() >= 3) {
                    let n = hist.len();
                    let (old, mid, now) = (hist[n - 3], hist[n - 2], hist[n - 1]);
                    let z = [0, 1].map(|k| 0.5 * (old[2 - k] + now[2 - k]));
                    st.push(&r, z, mid[0], 1.0);
                }
                pending = Some(y);
            } else {
                let cf = u[0].max(0.0);
                st.push(&y, [cf, cf], cf, 1.0);
            }
            if (t + 1) % 300 == 0 {
                if let Some(h) = st.estimate() {
                    col = h;
                    // A new column: earlier coordinates are on another scale.
                    hist.clear();
                    pending = None;
                }
            }
        }
        let n = frames as f64;
        let snr = (cs2 / n - (cs / n).powi(2)) / (ns2 / n);
        (corr(&st.estimate().unwrap(), &truth), snr)
    }

    /// A dim cell (per-frame trace SNR² about 0.3 against the correlated
    /// noise) on Gaussian-blurred noise (σ 1.5 px), started from a footprint
    /// displaced by 3 px: the cross-fitted statistics converge to the true
    /// footprint; the same-frame ones settle on a noise-shaped blob.
    #[test]
    fn fpstats_converges_to_oracle_from_a_wrong_start() {
        let (off, snr) = converge(false, 3000, 1.1);
        let (on, _) = converge(true, 3000, 1.1);
        eprintln!("snr {snr:.3}; corr with oracle: off {off:.3}, parity-loo {on:.3}");
        assert!(on >= 0.95, "cross-fitted {on}");
        assert!(off <= 0.88, "same-frame {off}");
    }

    /// Residual with a fixed spatial structure and no cell: a static
    /// texture `T(p)` (log-normal, blurred σ 2 px) modulating noise that is
    /// correlated over 1.5 px and white in time, `n_t(p) = T(p) ξ_t(p) +
    /// 0.3 ε_t(p)`: its covariance is the same in every frame, as for
    /// shimmer behind a fixed pattern of pixel gains.
    fn textured(tex: u64, t: u64, side: usize) -> Vec<f32> {
        let tt = blurred(tex * 7_919 + 999_999, side, 2.0);
        let xi = blurred(tex * 1_000_000 + t, side, 1.5);
        (0..side * side)
            .map(|i| tt[i].exp() * xi[i] + 0.3 * g(tex * 77_777_777 + t * 4096 + i as u64))
            .collect()
    }

    /// Structured noise only, no cell: the rank-1 fit's footprint on two
    /// independent sets of 40 frames. Plain alternation is power iteration
    /// on the residual and returns the residual covariance's leading
    /// pattern both times; the cross-fitted fit has no such fixed point
    /// (its covariance between the parities is short-ranged).
    #[test]
    fn rank1_on_noise_only_does_not_return_the_noise_pattern() {
        let side = 24usize;
        let blk = parity_block(10.0);
        let dom: Vec<u32> = (0..(side * side) as u32)
            .filter(|&p| {
                let (y, x) = (
                    (p as usize / side) as f32 - 11.5,
                    (p as usize % side) as f32 - 11.5,
                );
                y * y + x * x <= 7.5 * 7.5
            })
            .collect();
        let cls: Vec<u8> = dom.iter().map(|&p| parity(p, side, blk)).collect();
        let fit = |tex: u64, half: u64, cross: bool| {
            let frames: Vec<Vec<f32>> = (0..40)
                .map(|t| textured(tex, half * 1000 + t, side))
                .collect();
            let refs: Vec<&[f32]> = frames.iter().map(|f| f.as_slice()).collect();
            // A start trace as a patch solve would give (positive).
            let mut c: Vec<f32> = (0..40).map(|t| g(tex * 77 + half * 7 + t).abs()).collect();
            rank1(
                &refs,
                &dom,
                &mut c,
                10,
                false,
                cross.then_some(cls.as_slice()),
            )
        };
        let mut rs = [Vec::new(), Vec::new()];
        for tex in 0..8u64 {
            for (i, cross) in [false, true].into_iter().enumerate() {
                let a = fit(tex, 1, cross);
                let b = fit(tex, 2, cross);
                rs[i].push(corr(&a, &b).abs());
            }
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let (plain, cross) = (mean(&rs[0]), mean(&rs[1]));
        eprintln!(
            "|r_split| plain {plain:.3} {:?}, cross-fitted {cross:.3} {:?}",
            rs[0], rs[1]
        );
        // Half of the cross-fitted fits find no co-varying traces at all
        // (h = 0); the others still reproduce part of the texture, whose
        // hot spots straddle the block boundaries. Parity alone halves the
        // reproducibility; reservoir frames have no time order for a
        // leave-one-out.
        assert!(cross < 0.5 * plain, "cross-fitted {cross} vs plain {plain}");
        assert!(plain > 0.6, "plain {plain}");
    }

    /// A published column that is a replicated texture (the plain rank-1
    /// fit to the structured noise of `textured`, no cell), refined by the
    /// running statistics: the same-frame statistics reproduce it, as a
    /// significant footprint; the cross-fitted ones do not (the noise is
    /// white in time, so its leave-one-out instrument does not follow it).
    #[test]
    fn replicated_texture_column_decays() {
        let side = 24usize;
        let blk = parity_block(10.0);
        let fov = vec![1u8; side * side];
        let tex = 3u64;
        let proto = FpStats::new((11.5, 11.5), 7.5, side, side, &fov, false, blk);
        let dom = proto.pix.clone();
        let frames: Vec<Vec<f32>> = (0..40).map(|t| textured(tex, t, side)).collect();
        let refs: Vec<&[f32]> = frames.iter().map(|f| f.as_slice()).collect();
        let mut c: Vec<f32> = (0..40).map(|t| g(tex * 77 + t).abs()).collect();
        let col = rank1(&refs, &dom, &mut c, 10, false, None);
        // Pixel noise sd (for the whitened significance of the estimate).
        let tt = blurred(tex * 7_919 + 999_999, side, 2.0);
        let sd: Vec<f32> = dom
            .iter()
            .map(|&p| (tt[p as usize].exp().powi(2) + 0.09).sqrt())
            .collect();
        let run = |cross: bool| {
            let mut st = proto.clone();
            let mut hist: Vec<[f32; 3]> = Vec::new();
            let mut pending: Option<Vec<f32>> = None;
            for t in 0..3000u64 {
                let full = textured(tex, 100_000 + t, side);
                let y: Vec<f32> = dom.iter().map(|&p| full[p as usize]).collect();
                let (mut num, mut den) = ([0.0f32; 3], [0.0f32; 3]);
                for ((&a, &v), (&k, &s)) in col.iter().zip(&y).zip(st.cls.iter().zip(&sd)) {
                    let w = a / (s * s);
                    for j in [0, 1 + k as usize] {
                        num[j] += w * v;
                        den[j] += w * a;
                    }
                }
                let u = [0, 1, 2].map(|j| {
                    if den[j] > 0.0 {
                        num[j] / den[j]
                    } else {
                        f32::NAN
                    }
                });
                hist.push(u);
                if cross {
                    if let (Some(r), true) = (pending.take(), hist.len() >= 3) {
                        let n = hist.len();
                        let (old, mid, now) = (hist[n - 3], hist[n - 2], hist[n - 1]);
                        let z = [0, 1].map(|k| 0.5 * (old[2 - k] + now[2 - k]));
                        st.push(&r, z, mid[0], 1.0);
                    }
                    pending = Some(y);
                } else {
                    let cf = u[0].max(0.0);
                    st.push(&y, [cf, cf], cf, 1.0);
                }
            }
            // `stats_estimate`'s gate: whitened peak in standard errors.
            st.estimate().map(|h| {
                let se = st.std_err();
                let peak = h
                    .iter()
                    .zip(&sd)
                    .map(|(&v, &s)| v / s)
                    .fold(0.0f32, f32::max);
                (corr(&h, &col), f64::from(peak) / se)
            })
        };
        let off = run(false).expect("same-frame estimate");
        let on = run(true);
        eprintln!("texture column: same-frame (r, peak z) {off:?}, cross-fitted {on:?}");
        assert!(off.0 > 0.8 && off.1 > 4.0, "same-frame {off:?}");
        let default_min_snr = 4.0;
        assert!(
            on.is_none_or(|(r, z)| r < 0.3 || z < default_min_snr),
            "cross-fitted {on:?}"
        );
    }

    /// Without cross-fitting the class sums are the scalar ones: both
    /// classes see the same trace, so splitting changes nothing.
    #[test]
    fn fpstats_push_parity_sums_equal_full_sums_without_crossfit() {
        let mut a = FpStats::new((6.0, 6.0), 6.0, 13, 13, &[1u8; 169], true, 1000);
        let mut b = FpStats::new((6.0, 6.0), 6.0, 13, 13, &[1u8; 169], true, 3);
        assert!(a.cls.iter().all(|&c| c == 0));
        assert!(b.cls.contains(&0) && b.cls.contains(&1));
        let m = a.pix.len();
        for t in 0..1500u64 {
            let r: Vec<f32> = (0..m)
                .map(|i| g(t * 1000 + i as u64) + i as f32 * 0.01)
                .collect();
            let c = g(t + 9_000_000).abs();
            a.push(&r, [c, c], c, 1.0);
            b.push(&r, [c, c], c, 1.0);
        }
        assert_eq!(a.estimate(), b.estimate());
        assert_eq!(a.std_err(), b.std_err());
        assert_eq!(a.fast_estimate(), b.fast_estimate());
        assert_eq!(a.lambdas(), [1.0, 1.0]);
    }
}
