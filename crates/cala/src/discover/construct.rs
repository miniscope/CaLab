//! Building a cell from an estimated filtered footprint: the unfiltered
//! footprint, its support (the support rule) and the construction audit.

#[cfg(feature = "diagnostics")]
use super::diagnostics;
use super::local::{Cell, Extent, Rect};
use super::math::{basin, local_max, norm_quantile, solve_dense};
use super::SlowLoop;

/// The split halves of a cell's running statistics on its disk pixels:
/// `(pix, h_A, h_B, s_A, s_B)` ([`fpstats::FpStats::halves`]).
pub(super) type SplitHalves = (Vec<u32>, Vec<f32>, Vec<f32>, f64, f64);

/// The measured support of one footprint construction (S2.1, basin
/// rules), on the construction's canvas.
pub(crate) struct MeasuredSupport {
    /// The basin `S0` and the other significant light `X`.
    pub s0: Vec<bool>,
    pub x: Vec<bool>,
    /// A local maximum of the light inside `X` (a second soma).
    pub second: bool,
    /// Measured SE inflation, family-wise z and the number of tested
    /// pixels.
    pub phi: f64,
    pub z_fw: f64,
    pub n: usize,
    /// DIAG: the smoothed light and its threshold per canvas pixel.
    #[cfg(feature = "diagnostics")]
    pub q: Vec<f32>,
    #[cfg(feature = "diagnostics")]
    pub tol: Vec<f32>,
}

impl SlowLoop {
    /// Unwhiten a filtered footprint `h` on patch pixels `dom`, invert the
    /// high-pass on a canvas around it, and make a cell.
    pub(super) fn make_cell(
        &mut self,
        id: u64,
        rect: Rect,
        dom: &[u32],
        h: &[f32],
        start: Option<&Cell>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for &p in dom {
            let (y, x) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            ymin = ymin.min(y);
            ymax = ymax.max(y);
            xmin = xmin.min(x);
            xmax = xmax.max(x);
        }
        if dom.is_empty() {
            return None;
        }
        let canvas = Rect {
            y0: ymin,
            x0: xmin,
            h: ymax + 1 - ymin,
            w: xmax + 1 - xmin,
        };
        let mut target = vec![0.0f32; canvas.len()];
        let mut mask = vec![false; canvas.len()];
        for (&p, &v) in dom.iter().zip(h) {
            let (gy, gx) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            let l = canvas.local(gy, gx).expect("inside");
            target[l] = v * self.noise[gy * w + gx];
            mask[l] = true;
        }
        self.finish_cell(id, canvas, target, mask, start, None)
    }

    /// Make a cell from an unwhitened filtered footprint on global pixels.
    /// With `se` (the estimate's standard error per unit pixel noise), the
    /// support is measured ([`Self::finish_basin`]); without, it is seeded.
    pub(super) fn make_cell_global(
        &mut self,
        id: u64,
        pix: &[u32],
        h: &[f32],
        start: Option<&Cell>,
        se: Option<f64>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        if pix.is_empty() {
            return None;
        }
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for &g in pix {
            let (y, x) = (g as usize / w, g as usize % w);
            ymin = ymin.min(y);
            ymax = ymax.max(y);
            xmin = xmin.min(x);
            xmax = xmax.max(x);
        }
        let canvas = Rect {
            y0: ymin,
            x0: xmin,
            h: ymax + 1 - ymin,
            w: xmax + 1 - xmin,
        };
        let mut target = vec![0.0f32; canvas.len()];
        let mut mask = vec![false; canvas.len()];
        for (&g, &v) in pix.iter().zip(h) {
            let l = canvas
                .local(g as usize / w, g as usize % w)
                .expect("inside");
            target[l] = v;
            mask[l] = true;
        }
        self.finish_cell(id, canvas, target, mask, start, se)
    }

    /// Smooth the target at the optics' scale, invert the high-pass from
    /// `start` (or the target), normalise and cut to the support disk
    /// (measured with `se`, else seeded).
    fn finish_cell(
        &mut self,
        id: u64,
        canvas: Rect,
        mut target: Vec<f32>,
        mask: Vec<bool>,
        start: Option<&Cell>,
        se: Option<f64>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        let unsmoothed = se.map(|_| target.clone());
        // Footprints are smooth at the scale of the optics (a tenth of a
        // cell diameter): a masked, normalised blur of the target removes the
        // pixel noise of a footprint estimated from a few dozen frames.
        {
            let m: Vec<f32> = mask.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
            let tm: Vec<f32> = target.iter().zip(&m).map(|(t, m)| t * m).collect();
            let (mut bt, mut bm) = (vec![0.0f32; canvas.len()], vec![0.0f32; canvas.len()]);
            self.smooth.blur(canvas.h, canvas.w, &tm, &mut bt);
            self.smooth.blur(canvas.h, canvas.w, &m, &mut bm);
            for p in 0..canvas.len() {
                if mask[p] {
                    target[p] = bt[p] / bm[p].max(1e-6);
                }
            }
            self.work += (canvas.len() * 60) as u64;
        }
        let mut a: Vec<f32> = target.iter().map(|v| v.max(0.0)).collect();
        if let Some(c) = start {
            a.iter_mut().for_each(|v| *v = 0.0);
            for (&g, &v) in c.pix.iter().zip(&c.raw) {
                if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                    if mask[l] {
                        a[l] = v;
                    }
                }
            }
            // Keep the scale of the new target.
            let s: f32 = target.iter().zip(&a).map(|(t, v)| t * v).sum::<f32>()
                / a.iter().map(|v| v * v).sum::<f32>().max(1e-12);
            a.iter_mut().for_each(|v| *v *= s.max(0.0));
        }
        if let (Some(se), Some(h)) = (se, &unsmoothed) {
            return self.finish_basin(id, canvas, &target, &mask, a, start, se, h);
        }
        self.filter
            .invert(canvas.h, canvas.w, &mask, &target, &mut a, 40);
        self.work += (canvas.len() * 40 * 60) as u64;
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) {
            return None;
        }
        a.iter_mut().for_each(|v| *v /= peak);
        Cell::from_canvas(
            id,
            canvas,
            &a,
            self.dims,
            &self.fov,
            &self.cfg.library,
            Extent::Seed,
            &mut self.filter,
            &[],
        )
    }

    /// DIAG (`CALA_SUPPORT_AUDIT`): one `C` row for a footprint construction
    /// on the statistics path (see `diagnostics::support_construction`).
    #[cfg(feature = "diagnostics")]
    #[allow(clippy::too_many_arguments)]
    fn audit_construction(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        se: f64,
        halves: Option<&(Vec<f32>, Vec<f32>, f64, f64)>,
        ms: Option<&MeasuredSupport>,
        cell: &Cell,
        peak: f32,
    ) {
        let w = self.dims.width;
        // The published footprint (data units) on the canvas, and its
        // low-pass.
        let mut a = vec![0.0f32; canvas.len()];
        for (&g, &v) in cell.pix.iter().zip(&cell.raw) {
            if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                a[l] = v * peak;
            }
        }
        let mut low = vec![0.0f32; canvas.len()];
        self.filter.blur(canvas.h, canvas.w, &a, &mut low);
        let block = self.filter.moat().map_or(0, |m| m.0);
        let col: Vec<f32> = (0..canvas.len())
            .map(|p| {
                let (gy, gx) = (canvas.y0 + p / canvas.w, canvas.x0 + p % canvas.w);
                cell.column_at((gy * w + gx) as u32, w, block) * peak
            })
            .collect();
        diagnostics::support_construction(
            self,
            &diagnostics::SupportInput {
                canvas,
                h,
                mask,
                low: &low,
                col: &col,
                se,
                halves,
                ms,
                cell,
                block,
            },
        );
    }

    /// The split halves of `support_tmp` on `canvas` (zero off the disk):
    /// `(h_A, h_B, s_A, s_B)`.
    fn halves_on(&self, canvas: Rect) -> Option<(Vec<f32>, Vec<f32>, f64, f64)> {
        let (pix, ha, hb, sa, sb) = self.support_tmp.as_ref()?;
        let w = self.dims.width;
        let (mut ca, mut cb) = (vec![0.0f32; canvas.len()], vec![0.0f32; canvas.len()]);
        for (k, &g) in pix.iter().enumerate() {
            if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                ca[l] = ha[k];
                cb[l] = hb[k];
            }
        }
        Some((ca, cb, *sa, *sb))
    }

    /// PSF-smoothed light on the mask, `K * (v m) / K * m` (NaN where the
    /// mask's weight is negligible), and the normaliser `K * m`.
    fn psf_light(&mut self, canvas: Rect, v: &[f32], mask: &[bool]) -> (Vec<f32>, Vec<f32>) {
        let n = canvas.len();
        let m: Vec<f32> = mask.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
        let vm: Vec<f32> = (0..n).map(|p| if mask[p] { v[p] } else { 0.0 }).collect();
        let (mut bv, mut bm) = (vec![0.0f32; n], vec![0.0f32; n]);
        self.psf.blur(canvas.h, canvas.w, &vm, &mut bv);
        self.psf.blur(canvas.h, canvas.w, &m, &mut bm);
        let q = (0..n)
            .map(|p| {
                if mask[p] && bm[p] > 1e-3 {
                    bv[p] / bm[p]
                } else {
                    f32::NAN
                }
            })
            .collect();
        self.work += (n * 20) as u64;
        (q, bm)
    }

    /// The support rule of S2.1 on one construction's canvas: the light
    /// `q = K_psf * h` (measured light only; no `L a` add-back), its
    /// standard error `φ se σ_p sqrt(k² / K * m)` with the inflation `φ ≥ 1`
    /// measured from the split halves smoothed the same way, the
    /// family-wise threshold `z_fw = Φ⁻¹(1 − α / N)` over the `N` tested
    /// pixels, and the single-peaked basin of significant light from the
    /// cell's peak ([`basin`]). `None` when the peak is not significant.
    pub(super) fn measured_support(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        halves: &(Vec<f32>, Vec<f32>, f64, f64),
        se: f64,
        start: Option<&Cell>,
    ) -> Option<MeasuredSupport> {
        let n = canvas.len();
        let (ch, cw) = (canvas.h, canvas.w);
        let (q, bm) = self.psf_light(canvas, h, mask);
        let (qa, _) = self.psf_light(canvas, &halves.0, mask);
        let (qb, _) = self.psf_light(canvas, &halves.1, mask);
        let sp = f64::from(self.psf.sigma());
        let k2 = 1.0 / (4.0 * std::f64::consts::PI * sp * sp);
        let w = self.dims.width;
        // White standard error per pixel of the smoothed light, per unit se.
        let white: Vec<f64> = (0..n)
            .map(|p| {
                if q[p].is_finite() {
                    let (gy, gx) = (canvas.y0 + p / cw, canvas.x0 + p % cw);
                    f64::from(self.noise[gy * w + gx]) * (k2 / f64::from(bm[p]).max(k2)).sqrt()
                } else {
                    f64::NAN
                }
            })
            .collect();
        let vab = halves.2 * halves.2 + halves.3 * halves.3;
        let mut ratios: Vec<f64> = (0..n)
            .filter(|&p| q[p].is_finite() && white[p] > 0.0)
            .map(|p| {
                let d = f64::from(qa[p] - qb[p]);
                d * d / (vab * white[p] * white[p])
            })
            .filter(|r| r.is_finite())
            .collect();
        let n_test = (0..n).filter(|&p| q[p].is_finite()).count();
        if ratios.is_empty() || n_test == 0 || !(se > 0.0) || !se.is_finite() {
            return None;
        }
        ratios.sort_by(f64::total_cmp);
        // 0.4549: the median of chi-squared with one degree of freedom.
        let phi = (ratios[ratios.len() / 2] / 0.4549).max(1.0).sqrt();
        let alpha = f64::from(self.cfg.support_alpha);
        let z_fw = norm_quantile(1.0 - alpha / n_test as f64);
        let tol: Vec<f32> = (0..n)
            .map(|p| {
                if q[p].is_finite() {
                    (z_fw * phi * se * white[p]) as f32
                } else {
                    0.0
                }
            })
            .collect();
        // Seed: the brightest light on the current cell's positive pixels
        // (on the whole disk without one).
        let mut seeds: Vec<usize> = Vec::new();
        if let Some(c) = start {
            for (&g, &v) in c.pix.iter().zip(&c.raw) {
                if v > 0.0 {
                    if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                        if q[l].is_finite() {
                            seeds.push(l);
                        }
                    }
                }
            }
        }
        if seeds.is_empty() {
            seeds = (0..n).filter(|&p| q[p].is_finite()).collect();
        }
        let p0 = seeds.into_iter().max_by(|&i, &j| q[i].total_cmp(&q[j]))?;
        if !(q[p0] > tol[p0]) {
            return None;
        }
        let s0 = basin(&q, &tol, mask, ch, cw, p0);
        let x: Vec<bool> = (0..n)
            .map(|p| !s0[p] && q[p].is_finite() && q[p] > tol[p])
            .collect();
        let second = (0..n).any(|p| x[p] && local_max(&q, ch, cw, p));
        Some(MeasuredSupport {
            s0,
            x,
            second,
            phi,
            z_fw,
            n: n_test,
            #[cfg(feature = "diagnostics")]
            q,
            #[cfg(feature = "diagnostics")]
            tol,
        })
    }

    /// `finish_cell` on the statistics path: the support is the measured
    /// basin `S0` ([`Self::measured_support`]); the high-pass is inverted on
    /// it alone, and the moat blocks carry the measured block-mean light of
    /// the rest of the disk (the skirt, [`Self::skirt_blocks`]).
    #[allow(clippy::too_many_arguments)]
    fn finish_basin(
        &mut self,
        id: u64,
        canvas: Rect,
        target: &[f32],
        mask: &[bool],
        mut a: Vec<f32>,
        start: Option<&Cell>,
        se: f64,
        h: &[f32],
    ) -> Option<Cell> {
        let halves = self.halves_on(canvas)?;
        let ms = self.measured_support(canvas, h, mask, &halves, se, start)?;
        self.basin_diag.0 += 1;
        self.basin_diag.1 += u64::from(ms.second);
        self.filter
            .invert(canvas.h, canvas.w, &ms.s0, target, &mut a, 40);
        self.work += (canvas.len() * 40 * 60) as u64;
        #[cfg(feature = "diagnostics")]
        if let Some((px, out)) = self.probe.as_mut() {
            let w = self.dims.width;
            out.clear();
            for &g in px.iter() {
                out.push(
                    canvas
                        .local(g as usize / w, g as usize % w)
                        .map_or([f32::NAN; 8], |l| {
                            [
                                h[l],
                                target[l],
                                ms.q[l],
                                ms.tol[l],
                                f32::from(u8::from(ms.s0[l])),
                                f32::from(u8::from(ms.x[l])),
                                a[l],
                                f32::from(u8::from(mask[l])),
                            ]
                        }),
                );
            }
        }
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) {
            return None;
        }
        let skirt = self.skirt_blocks(canvas, h, mask, &a, &ms.x, peak);
        a.iter_mut().for_each(|v| *v /= peak);
        let cell = Cell::from_canvas(
            id,
            canvas,
            &a,
            self.dims,
            &self.fov,
            &self.cfg.library,
            Extent::Given,
            &mut self.filter,
            &skirt,
        );
        #[cfg(feature = "diagnostics")]
        if let Some(c) = &cell {
            if diagnostics::support_audit_on() {
                self.audit_construction(canvas, h, mask, se, Some(&halves), Some(&ms), c, peak);
            }
        }
        cell
    }

    /// The skirt (S2.1 section 4.2): per moat-grid block, the unfiltered
    /// light `u_b` outside the support `S = {a > 0}` whose column matches
    /// the measured light there. The filtered light of the footprint
    /// `f = a + u` is `h = f − L f`, so on the disk's measured pixels
    /// outside `S` and outside the other significant light `x`,
    /// `u = h + L a + L u`. Per block, averaged over the block's FOV pixels
    /// outside `S` (unmeasured pixels add nothing but count):
    /// `u_b = c_b + Σ_c K_bc u_c`, `c_b` the block mean of `h + L a` and
    /// `K_bc` that of the low-pass of block `c`'s skirt pixels, solved
    /// exactly (`K` is non-negative with row sums below 1). Divided by
    /// `peak`. Blocks without a measured pixel get no entry. No threshold:
    /// a block mean is an unbiased measurement.
    fn skirt_blocks(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        a: &[f32],
        x: &[bool],
        peak: f32,
    ) -> Vec<(u32, f32)> {
        let Some((b, _)) = self.filter.moat() else {
            return Vec::new();
        };
        let mut low = vec![0.0f32; canvas.len()];
        self.filter.blur(canvas.h, canvas.w, a, &mut low);
        self.work += (canvas.len() * 30) as u64;
        let (w, hgt) = (self.dims.width, self.dims.height);
        let gw = w.div_ceil(b);
        // Measured pixels (canvas-local) and the sum of `h + L a`, per block.
        let mut meas: std::collections::BTreeMap<u32, (Vec<usize>, f64)> =
            std::collections::BTreeMap::new();
        for p in 0..canvas.len() {
            if !mask[p] || a[p] > 0.0 || x[p] {
                continue;
            }
            let (gy, gx) = (canvas.y0 + p / canvas.w, canvas.x0 + p % canvas.w);
            let bq = ((gy / b) * gw + gx / b) as u32;
            let e = meas.entry(bq).or_default();
            e.0.push(p);
            e.1 += f64::from(h[p] + low[p]);
        }
        let in_s = |y: usize, xx: usize| canvas.local(y, xx).is_some_and(|l| a[l] > 0.0);
        let block_rect = |bq: u32| {
            let (by, bx) = (bq as usize / gw, bq as usize % gw);
            Rect {
                y0: by * b,
                x0: bx * b,
                h: ((by + 1) * b).min(hgt) - by * b,
                w: ((bx + 1) * b).min(w) - bx * b,
            }
        };
        let mut blks: Vec<(u32, Vec<usize>, f64, usize)> = Vec::with_capacity(meas.len());
        let mut ext = canvas;
        for (bq, (pts, sum)) in meas {
            let r = block_rect(bq);
            let mut nb = 0usize;
            for y in r.y0..r.y0 + r.h {
                for xx in r.x0..r.x0 + r.w {
                    nb += usize::from(self.fov[y * w + xx] != 0 && !in_s(y, xx));
                }
            }
            if nb > 0 {
                ext = ext.union(&r);
                blks.push((bq, pts, sum, nb));
            }
        }
        let m = blks.len();
        if m == 0 {
            return Vec::new();
        }
        // `K` from one blur per skirt block on a canvas that holds them all.
        let to_ext = |p: usize| {
            let (gy, gx) = (canvas.y0 + p / canvas.w, canvas.x0 + p % canvas.w);
            ext.local(gy, gx).expect("inside")
        };
        let mut kmat = vec![0.0f64; m * m];
        let mut chi = vec![0.0f32; ext.len()];
        let mut lchi = vec![0.0f32; ext.len()];
        for (c, (bq, ..)) in blks.iter().enumerate() {
            chi.iter_mut().for_each(|v| *v = 0.0);
            let r = block_rect(*bq);
            for y in r.y0..r.y0 + r.h {
                for xx in r.x0..r.x0 + r.w {
                    if self.fov[y * w + xx] != 0 && !in_s(y, xx) {
                        chi[ext.local(y, xx).expect("inside")] = 1.0;
                    }
                }
            }
            self.filter.blur(ext.h, ext.w, &chi, &mut lchi);
            self.work += (ext.len() * 30) as u64;
            for (r_, (_, pts, _, nb)) in blks.iter().enumerate() {
                let s: f64 = pts.iter().map(|&p| f64::from(lchi[to_ext(p)])).sum();
                kmat[r_ * m + c] = s / *nb as f64;
            }
        }
        // (I − K) u = c.
        let mut sys: Vec<f64> = (0..m * m)
            .map(|k| f64::from(u8::from(k / m == k % m)) - kmat[k])
            .collect();
        let mut u: Vec<f64> = blks.iter().map(|e| e.2 / e.3 as f64).collect();
        if !solve_dense(&mut sys, &mut u, m) {
            return Vec::new();
        }
        blks.iter()
            .zip(&u)
            .map(|(e, &v)| (e.0, (v / f64::from(peak)) as f32))
            .collect()
    }
}
