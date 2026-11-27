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
//! The moments are kept per pixel class (block parity) with a separate
//! instrument `z` and regressor `x`, `h = cov(r, z) / cov(x, z)` scaled by
//! `λ = cov(x, z) / var(z)` in the standard error. Both are the fast loop's
//! trace `c_t` (`λ = 1`), so a pixel's noise enters its own estimate through
//! the trace. Cross-fitted instruments (leave one frame out, other parity)
//! were measured in S1.2 and gave no gain
//! (`tools/cala-eval/results/2026-11-11-s12-crossfit.md`); they were removed
//! after a64cd09.
//!
//! The own-signal term `h_t c_t` uses the column the fast loop had at frame
//! `t`, so it cancels that frame's own model exactly whatever the footprint
//! was then. Old frames are forgotten with a half-life, because the other
//! cells' footprints (and so the residual) keep improving. Held-out frames
//! are never accumulated: the slow loop's tests stay out of sample.

/// Trace moments of one pixel class over the frames that pushed it:
/// `[Σ w, Σ w², Σ w z, Σ w z², Σ w x, Σ w x z]` (`z` the instrument, `x`
/// the regressor; both are the fast loop's trace).
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
    /// Split-half: the same sums over alternate 256-frame blocks only
    /// (`rc`, `r`, the class moments), and the frame counter. The support
    /// rule measures its standard error from them ([`FpStats::halves`]).
    pub half: (Vec<f32>, Vec<f32>, [Mom; 2]),
    pub k: u64,
    /// Per-pixel moments over the frames in which the pixel was valid:
    /// `None` until a missing pixel has been pushed (a disk away from the
    /// FOV edge never needs them, and keeps the class moments above).
    pub pm: Option<PixMoments>,
    /// The split-half sums' per-pixel moments.
    pub half_pm: Option<PixMoments>,
    /// Cache of `pix` as contiguous row runs ([`pixel_runs`]; empty until
    /// [`FpStats::push_frame`] first needs it).
    pub runs: Vec<(u32, u32)>,
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
/// regressor is the instrument (as the slow loop pushes).
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

impl FpStats {
    /// Empty statistics on the FOV pixels of the disk `(center, radius)`,
    /// pixel classes from blocks of side `blk`.
    pub fn new(
        center: (f32, f32),
        radius: f32,
        width: usize,
        height: usize,
        fov: &[u8],
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
            runs: Vec::new(),
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
        let mut s = FpStats::new(center, radius, width, height, fov, self.blk);
        s.m = self.m;
        s.half.2 = self.half.2;
        s.k = self.k;
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
            }
        }
        s
    }

    /// Whether the support disk `(center, radius)` lies inside this disk.
    /// Start the pixels of this disk that are not in `old_pix` (sorted; the
    /// disk before [`FpStats::moved`]) at the current model: after `col` is
    /// set, their sums are made so that [`FpStats::estimate`] and both
    /// [`FpStats::halves`] return exactly `col` there (a new pixel otherwise
    /// starts at zero sums under the full trace moments, which dilutes its
    /// estimate toward 0 for about a half-life). Real frames then pull it
    /// toward the truth. A class without a usable `λ` is left alone.
    pub fn seed_new(&mut self, old_pix: &[u32]) {
        if self.col.len() != self.pix.len() {
            return;
        }
        let lam = [0, 1].map(|c| lambda(&self.m[c]));
        let mut j = 0;
        for i in 0..self.pix.len() {
            let p = self.pix[i];
            while j < old_pix.len() && old_pix[j] < p {
                j += 1;
            }
            if j < old_pix.len() && old_pix[j] == p {
                continue;
            }
            let c = self.cls[i] as usize;
            let Some(l) = lam[c] else {
                continue;
            };
            let v = f64::from(self.col[i]) * l;
            let (full, half) = match (&self.pm, &self.half_pm) {
                (Some(pm), Some(hpm)) => ([pm.s1[i], pm.s2[i]], [hpm.s1[i], hpm.s2[i]]),
                _ => (
                    [self.m[c][2], self.m[c][3]],
                    [self.half.2[c][2], self.half.2[c][3]],
                ),
            };
            self.r[i] = (v * full[0]) as f32;
            self.rc[i] = (v * full[1]) as f32;
            self.half.1[i] = (v * half[0]) as f32;
            self.half.0[i] = (v * half[1]) as f32;
        }
    }

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
        if let Some(pm) = &mut self.pm {
            pm.scale(ff);
        }
        if let Some(pm) = &mut self.half_pm {
            pm.scale(ff);
        }
        for m in self.m.iter_mut().chain(self.half.2.iter_mut()) {
            scale_mom(m, ff);
        }
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
    /// value. The slow loop passes `z = [c, c]` and `x = c`.
    pub fn push(&mut self, r: &[f32], z: [f32; 2], x: f32, w: f32) {
        if x.is_nan() || z.iter().all(|v| v.is_nan()) {
            return;
        }
        if self.pm.is_none() && !r.iter().any(|v| v.is_nan()) {
            let in_half = (self.k / 256).is_multiple_of(2);
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
            }
            self.finish_push(z, x, w, in_half);
            return;
        }
        self.push_masked(r, z, x, w);
    }

    /// The slow loop's push of one fitting frame: the residual
    /// `r = y − model − level + col c` on the disk (a non-finite `y` is a
    /// missing sample), with `c` the instrument and regressor. The same
    /// arithmetic, element by element, as building `r` and calling
    /// `push(r, [c, c], c, w)`, but read in contiguous row runs and, for a
    /// complete disk, accumulated in vectorisable loops without per-pixel class lookups or branches.
    /// `buf` is scratch. `col` must be the column on `pix` (or empty with
    /// `c == 0`).
    #[allow(clippy::too_many_arguments)]
    pub fn push_frame(
        &mut self,
        frame: &[f32],
        model: &[f32],
        level: f32,
        c: f32,
        w: f32,
        buf: &mut Vec<f32>,
    ) {
        let n = self.pix.len();
        if self.runs.is_empty() && n > 0 {
            self.runs = pixel_runs(&self.pix);
        }
        // Scratch of at least `n` (grown only: no fill per call).
        if buf.len() < n {
            buf.resize(n, 0.0);
        }
        let buf = &mut buf[..n];
        let with_col = c != 0.0;
        debug_assert!(!with_col || self.col.len() == n);
        let mut bad = false;
        let mut i = 0;
        for &(s, len) in &self.runs {
            let (s, len) = (s as usize, len as usize);
            let (y, m) = (&frame[s..s + len], &model[s..s + len]);
            let out = &mut buf[i..i + len];
            if with_col {
                let col = &self.col[i..i + len];
                for j in 0..len {
                    let yv = y[j];
                    let v = if yv.is_finite() {
                        yv - m[j] - level
                    } else {
                        f32::NAN
                    };
                    let v = v + col[j] * c;
                    out[j] = v;
                    bad |= v.is_nan();
                }
            } else {
                for j in 0..len {
                    let yv = y[j];
                    let v = if yv.is_finite() {
                        yv - m[j] - level
                    } else {
                        f32::NAN
                    };
                    out[j] = v;
                    bad |= v.is_nan();
                }
            }
            i += len;
        }
        assert_eq!(i, n, "runs cover the pixels");
        if bad || c.is_nan() || self.pm.is_some() {
            self.push(buf, [c, c], c, w);
            return;
        }
        // `push` for a complete disk, `z = [c, c]`.
        let in_half = (self.k / 256).is_multiple_of(2);
        let wz = w * c;
        for ((rc, r), &v) in self.rc.iter_mut().zip(self.r.iter_mut()).zip(buf.iter()) {
            *rc += wz * v;
            *r += w * v;
        }
        if in_half {
            let (h0, h1) = (&mut self.half.0, &mut self.half.1);
            for ((rc, r), &v) in h0.iter_mut().zip(h1.iter_mut()).zip(buf.iter()) {
                *rc += wz * v;
                *r += w * v;
            }
        }
        self.finish_push([c, c], c, w, in_half);
    }

    /// The class moments and the frame counter, after the pixels of a frame.
    fn finish_push(&mut self, z: [f32; 2], x: f32, w: f32, in_half: bool) {
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
        }
        let wf = f64::from(w);
        let in_half = (self.k / 256).is_multiple_of(2);
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
        }
        self.finish_push(z, x, w, in_half);
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

/// Sorted global pixels `pix` as runs of consecutive indices `(first,
/// length)`, in order.
pub(crate) fn pixel_runs(pix: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &p in pix {
        match out.last_mut() {
            Some((s, l)) if *s + *l == p => *l += 1,
            _ => out.push((p, 1)),
        }
    }
    out
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
mod stats_tests {
    use super::*;

    /// Push as the slow loop does: the trace is instrument and regressor.
    fn push1(st: &mut FpStats, r: &[f32], c: f32, w: f32) {
        st.push(r, [c, c], c, w);
    }

    /// Uniform(-0.5, 0.5) from a counter (variance 1/12).
    fn u(k: u64) -> f32 {
        (crate::discover::reservoir::mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }

    /// A cell whose rim is missing on half the frames: with zero weight for
    /// the missing samples the rim estimate is unbiased (within 2 standard
    /// errors); standing in a value of 0 (what the sums saw before) halves it.
    #[test]
    fn fpstats_ignores_missing_pixels() {
        let side = 11usize;
        let mut st = FpStats::new((5.0, 5.0), 5.5, side, side, &vec![1u8; side * side], 5);
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
        // The split halves too.
        let (ha, hb, ..) = st.halves().unwrap();
        assert!((mean(&ha) - 1.0).abs() < 0.3 && (mean(&hb) - 1.0).abs() < 0.3);
    }

    /// With no missing sample the masked path is the scalar one.
    #[test]
    fn masked_push_without_missing_equals_scalar_push() {
        let mut a = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], 5);
        let mut b = a.clone();
        let m = a.pix.len();
        // Per-pixel moments from the start: they must track the scalar ones.
        b.pm = Some(PixMoments::filled(&b.cls, &[[0.0; 6]; 2]));
        b.half_pm = Some(PixMoments::filled(&b.cls, &[[0.0; 6]; 2]));
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
    }

    /// Per-pixel moments cross the wire and survive a move.
    #[test]
    fn per_pixel_moments_cross_the_wire_and_a_move() {
        let mut st = FpStats::new((4.0, 4.0), 4.0, 9, 9, &[1u8; 81], 5);
        let m = st.pix.len();
        for t in 0..768u64 {
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

    /// Pixels new to a moved disk start at the current model: after
    /// `moved` and `seed_new`, the estimate and both split halves equal the
    /// column there (with and without per-pixel moments), and the shared
    /// pixels keep their estimate.
    #[test]
    fn moved_seeds_new_pixels_at_the_model() {
        for missing in [false, true] {
            let mut st = FpStats::new((8.0, 8.0), 3.0, 17, 17, &[1u8; 289], 5);
            let m = st.pix.len();
            for t in 0..1300u64 {
                let r: Vec<f32> = (0..m)
                    .map(|i| {
                        if missing && (i + t as usize).is_multiple_of(7) {
                            f32::NAN
                        } else {
                            i as f32 * 0.1 + u(t * 77 + i as u64)
                        }
                    })
                    .collect();
                push1(&mut st, &r, u(t) + 1.0, 1.0);
            }
            assert_eq!(st.pm.is_some(), missing);
            let before = st.estimate().unwrap();
            let old = st.pix.clone();
            let mut big = st.moved((8.0, 8.0), 6.0, 17, 17, &[1u8; 289]);
            big.col = big.pix.iter().map(|&p| 0.25 + 0.01 * p as f32).collect();
            big.seed_new(&old);
            let est = big.estimate().unwrap();
            let (ha, hb, _, _) = big.halves().unwrap();
            let mut new = 0;
            for (i, p) in big.pix.iter().enumerate() {
                match old.binary_search(p) {
                    Ok(j) => assert!((est[i] - before[j]).abs() < 1e-4, "shared {p}"),
                    Err(_) => {
                        new += 1;
                        let want = big.col[i];
                        for (what, v) in [("all", est[i]), ("A", ha[i]), ("B", hb[i])] {
                            assert!(
                                (v - want).abs() < 1e-3 * want.abs().max(1.0),
                                "{what} {p}: {v} vs {want} (missing {missing})"
                            );
                        }
                    }
                }
            }
            assert!(new > 50);
        }
    }
}

/// The per-class moments with one trace for both classes.
#[cfg(test)]
mod parity_tests {
    use super::*;

    /// Standard normal-ish (sum of 4 uniforms, unit variance) from a counter.
    fn g(k: u64) -> f32 {
        let u = |j: u64| {
            (crate::discover::reservoir::mix(k * 4 + j) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
        };
        (u(0) + u(1) + u(2) + u(3)) * 3f32.sqrt()
    }

    /// The class sums are the scalar ones: both classes see the same
    /// trace, so splitting changes nothing.
    #[test]
    fn fpstats_push_parity_sums_equal_full_sums() {
        let mut a = FpStats::new((6.0, 6.0), 6.0, 13, 13, &[1u8; 169], 1000);
        let mut b = FpStats::new((6.0, 6.0), 6.0, 13, 13, &[1u8; 169], 3);
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
        assert_eq!(a.lambdas(), [1.0, 1.0]);
    }
}

#[cfg(test)]
mod push_frame_tests {
    use super::*;

    fn u(k: u64) -> f32 {
        (crate::discover::reservoir::mix(k) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }

    /// The slow loop's push before `push_frame`: build the residual per
    /// pixel, add the own-signal term, push.
    fn reference(st: &mut FpStats, frame: &[f32], model: &[f32], level: f32, c: f32, w: f32) {
        let mut r: Vec<f32> = st
            .pix
            .iter()
            .map(|&p| {
                let y = frame[p as usize];
                if y.is_finite() {
                    y - model[p as usize] - level
                } else {
                    f32::NAN
                }
            })
            .collect();
        if c != 0.0 {
            for (r, &v) in r.iter_mut().zip(&st.col) {
                *r += v * c;
            }
        }
        st.push(&r, [c, c], c, w);
    }

    fn state(st: &FpStats) -> String {
        let mut s = st.clone();
        s.runs.clear();
        format!("{s:?}")
    }

    /// `push_frame` leaves every sum bit for bit where building the
    /// residual and calling `push` does: complete and masked disks (a NaN
    /// or infinite pixel, and every frame after), FOV holes, zero and NaN
    /// traces, ring levels, split-half block changes and a moved disk.
    #[test]
    fn push_frame_matches_building_the_residual() {
        let (wd, ht) = (40usize, 32usize);
        let mut fov = vec![1u8; wd * ht];
        fov[15 * wd + 18] = 0;
        fov[16 * wd + 18] = 0;
        let col_of = |st: &FpStats, k: u64| -> Vec<f32> {
            (0..st.pix.len())
                .map(|i| u(k * 1000 + i as u64) + 0.2)
                .collect()
        };
        for masked in [false, true] {
            let mut a = FpStats::new((15.0, 20.0), 9.0, wd, ht, &fov, 5);
            a.col = col_of(&a, 1);
            let mut b = a.clone();
            let mut buf = Vec::new();
            for t in 0..700u64 {
                let mut frame: Vec<f32> =
                    (0..wd * ht).map(|i| 3.0 * u(t * 5000 + i as u64)).collect();
                let model: Vec<f32> = (0..wd * ht).map(|i| u(t * 5000 + i as u64 + 77)).collect();
                if masked && (t == 300 || t == 450) {
                    frame[15 * wd + 20] = f32::NAN;
                    frame[17 * wd + 22] = f32::INFINITY;
                }
                let c = match t % 9 {
                    0 => 0.0,
                    4 if t == 13 => f32::NAN,
                    _ => 2.0 * u(t * 31 + 5) + 0.5,
                };
                let level = if t % 2 == 0 { 0.25 * u(t) } else { 0.0 };
                let w = 1.0 + t as f32 * 1e-3;
                if t == 500 {
                    a = a.moved((16.0, 21.0), 10.0, wd, ht, &fov);
                    b = b.moved((16.0, 21.0), 10.0, wd, ht, &fov);
                    a.col = col_of(&a, 2);
                    b.col = a.col.clone();
                }
                reference(&mut a, &frame, &model, level, c, w);
                b.push_frame(&frame, &model, level, c, w, &mut buf);
                assert_eq!(state(&a), state(&b), "masked {masked} t {t}");
            }
            assert_eq!(a.pm.is_some(), masked);
            assert!(a.k > 600);
        }
    }

    #[test]
    fn pixel_runs_split_at_gaps() {
        assert_eq!(pixel_runs(&[]), vec![]);
        assert_eq!(
            pixel_runs(&[3, 4, 5, 9, 10, 12]),
            vec![(3, 3), (9, 2), (12, 1)]
        );
    }
}
