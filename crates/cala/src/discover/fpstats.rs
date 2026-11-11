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
    /// Library version the column below belongs to, and that version's
    /// filtered column on `pix` (moat included).
    pub version: u64,
    pub col: Vec<f32>,
    /// DIAG split-half: the same sums over alternate 256-frame blocks only
    /// (`rc`, `r`, `n`, `n2`, `s1`, `s2`), and the frame counter.
    pub half: (Vec<f32>, Vec<f32>, [f64; 4]),
    pub k: u64,
    /// Transient-band statistics in interleaved block groups (`None` when
    /// [`super::CoreTest`] is `Off`).
    pub fast: Option<Fast>,
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
#[derive(Debug, Clone)]
pub(crate) struct Fast {
    pub alpha: f32,
    /// Per-pixel moving average of `r` (NaN until the pixel's first frame).
    pub ema: Vec<f32>,
    pub ema_c: f64,
    /// `Σ w c~ r~(p)` per group.
    pub rc: Vec<Vec<f32>>,
    /// `[Σ w c~², Σ w² c~²]` per group.
    pub w: [[f64; 2]; FAST_GROUPS],
}

impl Fast {
    pub fn new(n: usize, alpha: f32) -> Fast {
        Fast {
            alpha,
            ema: vec![f32::NAN; n],
            ema_c: f64::NAN,
            rc: vec![vec![0.0; n]; FAST_GROUPS],
            w: [[0.0; 2]; FAST_GROUPS],
        }
    }

    /// Per-group estimates `h_g(p) = Σ c~ r~ / Σ c~²` and the groups'
    /// `[Σ w c~², Σ w² c~²]` (groups without trace variance get `None`).
    pub fn groups(&self) -> Vec<Option<Vec<f32>>> {
        self.rc
            .iter()
            .zip(&self.w)
            .map(|(rc, w)| {
                (w[0] > 0.0).then(|| rc.iter().map(|&v| (f64::from(v) / w[0]) as f32).collect())
            })
            .collect()
    }

    /// The pooled estimate `Σ_g Σ c~ r~ / Σ_g Σ c~²` and its white standard
    /// error per unit pixel noise `sqrt(Σ w² c~²) / Σ w c~²`.
    pub fn estimate(&self) -> Option<(Vec<f32>, f64)> {
        let w0: f64 = self.w.iter().map(|w| w[0]).sum();
        let w1: f64 = self.w.iter().map(|w| w[1]).sum();
        if !(w0 > 0.0) {
            return None;
        }
        let n = self.ema.len();
        let mut h = vec![0.0f64; n];
        for rc in &self.rc {
            for (a, &v) in h.iter_mut().zip(rc) {
                *a += f64::from(v);
            }
        }
        Some((h.iter().map(|v| (v / w0) as f32).collect(), w1.sqrt() / w0))
    }
}

/// Time constant of the transient band's high-pass, frames: 2 s at the
/// Miniscope's 20 fps, longer than a calcium transient's rise and decay
/// (so transients keep most of their energy) and shorter than baseline
/// drift and bleaching.
pub(crate) const FAST_TAU_FRAMES: f32 = 40.0;

impl FpStats {
    /// Empty statistics on the FOV pixels of the disk `(center, radius)`.
    pub fn new(
        center: (f32, f32),
        radius: f32,
        width: usize,
        height: usize,
        fov: &[u8],
        fast: bool,
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
            col: Vec::new(),
            half: (vec![0.0; n], vec![0.0; n], [0.0; 4]),
            k: 0,
            fast: fast.then(|| Fast::new(n, 1.0 / FAST_TAU_FRAMES)),
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
        let mut s = FpStats::new(center, radius, width, height, fov, self.fast.is_some());
        s.n = self.n;
        s.n2 = self.n2;
        s.s1 = self.s1;
        s.s2 = self.s2;
        s.half.2 = self.half.2;
        s.k = self.k;
        if let (Some(f), Some(nf)) = (&self.fast, &mut s.fast) {
            nf.ema_c = f.ema_c;
            nf.w = f.w;
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
                fa.w[g][0] *= ff;
                fa.w[g][1] *= ff * ff;
            }
        }
        self.half.2[0] *= ff;
        self.half.2[1] *= ff * ff;
        self.half.2[2] *= ff;
        self.half.2[3] *= ff;
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
        if (self.k / 256).is_multiple_of(2) {
            let wc = w * c;
            for ((a, b), &v) in self.half.0.iter_mut().zip(self.half.1.iter_mut()).zip(r) {
                *a += wc * v;
                *b += w * v;
            }
            let (w, c) = (f64::from(w), f64::from(c));
            self.half.2[0] += w;
            self.half.2[1] += w * w;
            self.half.2[2] += w * c;
            self.half.2[3] += w * c * c;
        }
        if let Some(fa) = &mut self.fast {
            let g = ((self.k / FAST_BLOCK) % FAST_GROUPS as u64) as usize;
            let a = fa.alpha;
            if fa.ema_c.is_nan() {
                fa.ema_c = f64::from(c);
            }
            let ct = (f64::from(c) - fa.ema_c) as f32;
            fa.ema_c += f64::from(a) * (f64::from(c) - fa.ema_c);
            let wc = w * ct;
            let acc = &mut fa.rc[g];
            for ((e, s), &v) in fa.ema.iter_mut().zip(acc.iter_mut()).zip(r) {
                if e.is_nan() {
                    *e = v;
                }
                *s += wc * (v - *e);
                *e += a * (v - *e);
            }
            let (wf, cf) = (f64::from(w), f64::from(ct));
            fa.w[g][0] += wf * cf * cf;
            fa.w[g][1] += wf * wf * cf * cf;
        }
        self.k += 1;
        let (w, c) = (f64::from(w), f64::from(c));
        self.n += w;
        self.n2 += w * w;
        self.s1 += w * c;
        self.s2 += w * c * c;
    }

    /// DIAG: the two split-half estimates (block A, block B = total − A) and
    /// their standard errors per unit pixel noise.
    pub fn halves(&self) -> Option<(Vec<f32>, Vec<f32>, f64, f64)> {
        let [na, n2a, s1a, s2a] = self.half.2;
        let (nb, n2b, s1b, s2b) = (self.n - na, self.n2 - n2a, self.s1 - s1a, self.s2 - s2a);
        let est = |rc: &dyn Fn(usize) -> f64,
                   r: &dyn Fn(usize) -> f64,
                   n: f64,
                   n2: f64,
                   s1: f64,
                   s2: f64| {
            if !(n > 0.0) || !(n2 > 0.0) {
                return None;
            }
            let vc = s2 - s1 * s1 / n;
            if !(vc > 0.0) {
                return None;
            }
            let m = s1 / n;
            let h: Vec<f32> = (0..self.pix.len())
                .map(|i| ((rc(i) - r(i) * m) / vc) as f32)
                .collect();
            let se = 1.0 / ((n * n / n2) * (vc / n)).sqrt();
            Some((h, se))
        };
        let (ha, sa) = est(
            &|i| f64::from(self.half.0[i]),
            &|i| f64::from(self.half.1[i]),
            na,
            n2a,
            s1a,
            s2a,
        )?;
        let (hb, sb) = est(
            &|i| f64::from(self.rc[i] - self.half.0[i]),
            &|i| f64::from(self.r[i] - self.half.1[i]),
            nb,
            n2b,
            s1b,
            s2b,
        )?;
        Some((ha, hb, sa, sb))
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

#[cfg(test)]
mod fast_tests {
    use super::*;

    /// Uniform(-0.5, 0.5) from a counter (variance 1/12).
    fn u(k: u64) -> f32 {
        (crate::discover::reservoir::mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }

    /// White noise: the transient-band estimate is unbiased and its group
    /// spread matches the white standard error; light that follows only
    /// the trace's slow component is removed by the high-pass.
    #[test]
    fn fast_band_groups_measure_white_noise_and_drop_slow_light() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], false);
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
            st.push(&r, c, 1.0);
        }
        let fa = st.fast.as_ref().unwrap();
        let (h, se) = fa.estimate().unwrap();
        let mean_in = h[..m / 2].iter().sum::<f32>() / (m / 2) as f32;
        let mean_out = h[m / 2..].iter().sum::<f32>() / (m - m / 2) as f32;
        assert!((mean_in - 1.0).abs() < 0.05, "{mean_in}");
        assert!(mean_out.abs() < 0.15, "{mean_out}");
        // the all-band estimate keeps the slow-only light
        let all = st.estimate().unwrap();
        let all_out = all[m / 2..].iter().sum::<f32>() / (m - m / 2) as f32;
        assert!(all_out > 0.3, "{all_out}");
        // per-pixel group spread over the white variance ≈ 1
        let groups: Vec<Vec<f32>> = fa.groups().into_iter().map(|g| g.unwrap()).collect();
        let wg: Vec<f64> = fa.w.iter().map(|w| w[0]).collect();
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

    /// A visit in another worker sees the same transient-band estimate.
    #[test]
    fn fast_sums_cross_the_wire() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], false);
        st.fast = Some(Fast::new(st.pix.len(), 1.0 / FAST_TAU_FRAMES));
        let r: Vec<f32> = (0..st.pix.len()).map(|i| i as f32).collect();
        for t in 0..(FAST_BLOCK * FAST_GROUPS as u64) {
            st.push(&r, u(t), 1.0);
        }
        let mut w = crate::discover::wire::Writer::default();
        w.fpstats(&st);
        let back = crate::discover::wire::Reader::new(&w.buf)
            .fpstats()
            .unwrap();
        let (a, b) = (st.fast.as_ref().unwrap(), back.fast.as_ref().unwrap());
        assert_eq!(a.estimate(), b.estimate());
        assert_eq!(a.groups(), b.groups());
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
