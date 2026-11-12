//! Transient-band growth test and cell-shaped core test (opt-in with
//! `core_test` != Off, see [`super::CoreTest`]).
//!
//! Both use the transient-band running statistics ([`super::fpstats::Fast`]):
//! residual and trace high-passed in time, accumulated in `G` interleaved
//! block groups. The groups are independent replicates of the footprint
//! estimate, so the noise of any linear statistic of it (a ring mean, a
//! core-minus-surround contrast) is *measured* from their spread, with every
//! spatial and temporal correlation of the real noise included. Interleaving
//! makes slow changes of a cell's own light (bleaching, focus) common to all
//! groups, so they do not count as noise; the high-pass removes light that
//! follows the trace only on slow time scales, so it does not count as
//! footprint light either.
//!
//! * Growth: the per-ring measured variance over the white one, median over
//!   the rings (`f_ring`), scales the white standard error of the ring test.
//! * Core: the contrast `κ(q)` = mean whitened light in a soma-sized core
//!   (equal-area square of a disk of diameter `cell_diameter_px`) minus the
//!   mean in the surrounding square annulus of twice its side. The position
//!   is chosen on the even groups and tested on the odd ones (held out from
//!   the choice); its noise is the measured replicate variance of `κ` over
//!   all positions of the statistics disk (`f_core`, local, median). The
//!   core must also stand out of the footprint's own texture, searched
//!   sequentially so that a second cell in a merged footprint, or the far
//!   end of an elongated one, is masked instead of counted as texture
//!   ([`search_cores`]).
//!
//! Texture components (textured, coreless "cells" in dim regions)
//! reproduce in every group: on real data they are the sensor's gain
//! pattern moved by registration (D4), which the flat field removes
//! upstream; a noise-feedback fixed point would reproduce the same way. Group
//! spread cannot reject them; only their shape (no core that stands out of
//! their own texture) does.

use super::fpstats::FAST_GROUPS;
use super::SlowLoop;

/// Median of χ²₇ / 7 (spread of `G = 8` replicates).
const CHI2_7_MEDIAN: f64 = 0.9065;

#[derive(Debug, Clone, Default)]
pub(crate) struct FastInfo {
    /// Measured / white variance of ring means and of the core contrast.
    pub f_ring: f64,
    pub f_core: f64,
    /// Held-out core contrast over its measured noise, the chosen core
    /// position (global px) and its held-out level against the footprint's
    /// own texture with the bar that level must clear (see [`CoreTest`]).
    pub z_core: f64,
    pub z_tex: f64,
    pub z_tex_bar: f64,
    pub core: (f32, f32),
    /// Texture positions the core was compared with, and pixels of the
    /// core's region (soma square and basin).
    pub n_ref: usize,
    pub region: usize,
    /// Pooled transient-band estimate on the statistics disk (unwhitened)
    /// and its white standard error per unit pixel noise.
    pub h: Vec<f32>,
    pub se_white: f64,
    /// Rings of the measured-noise growth test (diagnostic only).
    pub rings: usize,
}

impl SlowLoop {
    /// Transient-band analysis of cell `id` (support disk `center`, `radius`).
    pub(crate) fn fast_info(&self, id: u64, center: (f32, f32), radius: f32) -> Option<FastInfo> {
        let st = self.fpstats.get(&id)?;
        let (h, se_white) = st.fast_estimate()?;
        let groups = st.fast_groups()?;
        if groups.iter().any(|g| g.is_none()) {
            return None;
        }
        let groups: Vec<Vec<f32>> = groups.into_iter().map(|g| g.expect("checked")).collect();
        let gw = st.fast_weights()?;
        let wg: Vec<f64> = gw.iter().map(|w| w[0]).collect();
        let w2: Vec<f64> = gw.iter().map(|w| w[1]).collect();
        let sw: f64 = wg.iter().sum();
        let sw2: f64 = w2.iter().sum();
        let white_unit = sw2 / (sw * sw);
        let w = self.dims.width;
        // Canvas: bounding box of the statistics disk.
        let (mut y0, mut y1, mut x0, mut x1) = (usize::MAX, 0, usize::MAX, 0);
        for &g in &st.pix {
            let (y, x) = (g as usize / w, g as usize % w);
            y0 = y0.min(y);
            y1 = y1.max(y);
            x0 = x0.min(x);
            x1 = x1.max(x);
        }
        if st.pix.len() < 16 {
            return None;
        }
        let (ch, cw) = (y1 + 1 - y0, x1 + 1 - x0);
        let n = ch * cw;
        let loc: Vec<usize> = st
            .pix
            .iter()
            .map(|&g| (g as usize / w - y0) * cw + (g as usize % w - x0))
            .collect();
        let isg: Vec<f64> = st
            .pix
            .iter()
            .map(|&g| f64::from(self.inv_sigma[g as usize]))
            .collect();
        // Whitened group maps on the canvas.
        let gm: Vec<Vec<f64>> = groups
            .iter()
            .map(|hg| {
                let mut m = vec![0.0f64; n];
                for (i, &l) in loc.iter().enumerate() {
                    m[l] = f64::from(hg[i]) * isg[i];
                }
                m
            })
            .collect();
        // A bright cell's own light differs between groups by more than
        // noise (which transients fell into which blocks, slow changes of
        // its brightness): remove each group's gain relative to the pooled
        // map, `m_g -> m_g - (β_g - 1) m̄` with `β_g = <m_g, m̄> / <m̄, m̄>`,
        // so the spread measures noise, not the cell's own amplitude.
        let mut gm = gm;
        let mut mbar = vec![0.0f64; n];
        for (m, w) in gm.iter().zip(&wg) {
            for (a, &v) in mbar.iter_mut().zip(m) {
                *a += w * v / sw;
            }
        }
        let nn: f64 = mbar.iter().map(|v| v * v).sum();
        if nn > 0.0 {
            for m in gm.iter_mut() {
                let beta = m.iter().zip(&mbar).map(|(a, b)| a * b).sum::<f64>() / nn;
                for (a, &b) in m.iter_mut().zip(&mbar) {
                    *a -= (beta - 1.0) * b;
                }
            }
        }
        let mut present = vec![0.0f64; n];
        for &l in &loc {
            present[l] = 1.0;
        }
        // --- growth: ring inflation around the support centre.
        let mut rings: Vec<(Vec<f64>, usize)> = Vec::new();
        for (i, &g) in st.pix.iter().enumerate() {
            let (y, x) = ((g as usize / w) as f32, (g as usize % w) as f32);
            let k = ((y - center.0).powi(2) + (x - center.1).powi(2)).sqrt() as usize;
            if k >= rings.len() {
                rings.resize(k + 1, (vec![0.0; FAST_GROUPS], 0));
            }
            for (gi, m) in gm.iter().enumerate() {
                rings[k].0[gi] += m[loc[i]];
            }
            rings[k].1 += 1;
        }
        let spread = |vals: &[f64]| -> f64 {
            let mean: f64 = vals.iter().zip(&wg).map(|(v, w)| v * w).sum::<f64>() / sw;
            vals.iter()
                .zip(&wg)
                .map(|(v, w)| w * (v - mean).powi(2))
                .sum::<f64>()
                / (FAST_GROUPS as f64 - 1.0)
                / sw
        };
        let mut fr: Vec<f64> = rings
            .iter()
            .filter(|r| r.1 >= 8)
            .map(|(s, m)| {
                let mu: Vec<f64> = s.iter().map(|v| v / *m as f64).collect();
                spread(&mu) / (white_unit / *m as f64)
            })
            .collect();
        if fr.len() < 3 {
            return None;
        }
        fr.sort_by(f64::total_cmp);
        let f_ring = fr[fr.len() / 2] / CHI2_7_MEDIAN;
        // --- the cell-shaped core.
        let (rcy, rcx) = (
            f64::from(center.0) - y0 as f64,
            f64::from(center.1) - x0 as f64,
        );
        let r = f64::from(radius);
        let maps = GroupMaps {
            ch,
            cw,
            maps: &gm,
            present: &present,
            wg: &wg,
            w2: &w2,
        };
        let inside =
            |cy: i64, cx: i64| ((cy as f64 - rcy).powi(2) + (cx as f64 - rcx).powi(2)).sqrt() <= r;
        let t = core_test(
            &maps,
            f64::from(self.cfg.cell_diameter_px),
            inside,
            f64::from(self.cfg.keep_z),
            f64::from(self.psf.sigma()),
            f64::from(self.cfg.support_z),
        )?;
        Some(FastInfo {
            f_ring,
            f_core: t.f_core,
            z_core: t.z_core,
            z_tex: t.z_tex,
            z_tex_bar: t.z_tex_bar,
            core: ((t.pos.0 + y0 as i64) as f32, (t.pos.1 + x0 as i64) as f32),
            n_ref: t.n_ref,
            region: t.region,
            h,
            se_white,
            rings: fr.len(),
        })
    }

    /// One line per cell: transient-band growth and core verdicts, for
    /// diagnostics.
    pub fn fast_report(&self) -> String {
        let mut out = String::from(
            "id\tcy\tcx\tradius\tsigma\tf_ring\tf_core\tz_core\tcore_y\tcore_x\tf_ring_all\tframes\tz_tex\tz_tex_bar\tn_ref\tregion\n",
        );
        for c in &self.cells {
            let Some(fi) = self.fast_info(c.id, c.center, c.radius) else {
                continue;
            };
            let (y, x) = (c.center.0.round() as usize, c.center.1.round() as usize);
            let sig = self
                .noise
                .get(y * self.dims.width + x)
                .copied()
                .unwrap_or(f32::NAN);
            let fra = self.ring_inflation(c.id).unwrap_or(f64::NAN);
            let frames = self.ledger.get(&c.id).map_or(0, |e| e.frames);
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "{}\t{:.1}\t{:.1}\t{:.1}\t{sig:.4}\t{:.3}\t{:.3}\t{:.3}\t{:.1}\t{:.1}\t{fra:.3}\t{frames}\t{:.3}\t{:.3}\t{}\t{}\n",
                    c.id,
                    c.center.0,
                    c.center.1,
                    c.radius,
                    fi.f_ring,
                    fi.f_core,
                    fi.z_core,
                    fi.core.0,
                    fi.core.1,
                    fi.z_tex,
                    fi.z_tex_bar,
                    fi.n_ref,
                    fi.region
                ),
            );
        }
        out
    }
}

impl FastInfo {
    /// Whether the cell has a compact, held-out core that stands out of
    /// the noise (`z`, standard deviations) and of its own texture.
    pub fn core_ok(&self, z: f64) -> bool {
        self.z_core >= z && self.z_tex >= self.z_tex_bar
    }
}

/// Whitened block-group maps of a footprint estimate on a canvas.
pub(crate) struct GroupMaps<'a> {
    pub ch: usize,
    pub cw: usize,
    /// Per group, row-major `ch x cw`; zero off the statistics disk.
    pub maps: &'a [Vec<f64>],
    /// 1 on the statistics disk, 0 elsewhere.
    pub present: &'a [f64],
    /// Per group `Σ w c~²` and `Σ w² c~²`.
    pub wg: &'a [f64],
    pub w2: &'a [f64],
}

/// Outcome of [`core_test`] (canvas positions).
#[derive(Debug, Clone)]
pub(crate) struct CoreTest {
    pub pos: (i64, i64),
    pub z_core: f64,
    pub f_core: f64,
    pub z_tex: f64,
    pub z_tex_bar: f64,
    pub n_ref: usize,
    pub region: usize,
}

/// Integral image of a `ch x cw` map.
fn integral(m: &[f64], ch: usize, cw: usize) -> Vec<f64> {
    let mut s = vec![0.0f64; (ch + 1) * (cw + 1)];
    for y in 0..ch {
        let mut row = 0.0;
        for x in 0..cw {
            row += m[y * cw + x];
            s[(y + 1) * (cw + 1) + x + 1] = s[y * (cw + 1) + x + 1] + row;
        }
    }
    s
}

/// Sum over the square of half-side `half` at `(cy, cx)` (clipped).
fn box_sum(s: &[f64], ch: usize, cw: usize, cy: i64, cx: i64, half: i64) -> f64 {
    let ya = (cy - half).clamp(0, ch as i64) as usize;
    let yb = (cy + half + 1).clamp(0, ch as i64) as usize;
    let xa = (cx - half).clamp(0, cw as i64) as usize;
    let xb = (cx + half + 1).clamp(0, cw as i64) as usize;
    if ya >= yb || xa >= xb {
        return 0.0;
    }
    s[yb * (cw + 1) + xb] - s[ya * (cw + 1) + xb] - s[yb * (cw + 1) + xa] + s[ya * (cw + 1) + xa]
}

/// Separable Gaussian blur (σ px, truncated at 3σ) of a `ch x cw` map.
fn blur(m: &[f64], ch: usize, cw: usize, sigma: f64) -> Vec<f64> {
    let r = (3.0 * sigma).ceil().max(1.0) as i64;
    let k: Vec<f64> = (-r..=r)
        .map(|i| (-0.5 * (i as f64 / sigma).powi(2)).exp())
        .collect();
    let pass = |src: &[f64], step: usize, len: usize, pos: &dyn Fn(usize) -> usize| -> Vec<f64> {
        let mut out = vec![0.0f64; src.len()];
        for (p, o) in out.iter_mut().enumerate() {
            let i = pos(p) as i64;
            *o = k
                .iter()
                .enumerate()
                .map(|(j, &kv)| (i + j as i64 - r, kv))
                .filter(|&(ii, _)| (0..len as i64).contains(&ii))
                .map(|(ii, kv)| kv * src[(p as i64 + (ii - i) * step as i64) as usize])
                .sum();
        }
        out
    };
    let t = pass(m, 1, cw, &|p| p % cw);
    pass(&t, cw, ch, &|p| p / cw)
}

/// The basin of a core: the pixels reached from it by a descent that
/// never climbs more than `tol` above the lowest light on its way and
/// stays more than `tol` above zero (`u`: smoothed light, `NaN` off the
/// support).
fn basin(u: &[f64], ch: usize, cw: usize, (cy, cx): (i64, i64), tol: f64) -> Vec<bool> {
    let mut inb = vec![false; ch * cw];
    let p0 = cy as usize * cw + cx as usize;
    if !(u[p0] > tol) {
        return inb;
    }
    let mut floor = vec![f64::NEG_INFINITY; ch * cw];
    let key = |v: f64| (v * 1e6) as i64;
    let mut heap = std::collections::BinaryHeap::new();
    inb[p0] = true;
    floor[p0] = u[p0];
    heap.push((key(u[p0]), p0));
    while let Some((_, p)) = heap.pop() {
        let (y, x) = (p / cw, p % cw);
        let nb = [
            (y > 0).then(|| p - cw),
            (y + 1 < ch).then(|| p + cw),
            (x > 0).then(|| p - 1),
            (x + 1 < cw).then(|| p + 1),
        ];
        for q in nb.into_iter().flatten() {
            if inb[q] || !(u[q] > tol) || u[q] > floor[p] + tol {
                continue;
            }
            inb[q] = true;
            floor[q] = floor[p].min(u[q]);
            heap.push((key(u[q]), q));
        }
    }
    inb
}

/// The cell-shaped core test of a footprint's whitened block-group maps
/// (soma diameter `d` px).
///
/// The core is the support position (`inside`) of largest contrast `κ` on
/// the even groups, `κ` being the mean light in a soma-sized square (equal
/// in area to the disk of diameter `d`) minus the mean in the square
/// annulus of twice its side. It is tested on the odd groups, held out from
/// the choice:
///
/// * Against the noise (`z_core`): its contrast over the replicate standard
///   error of `κ`, measured as the median spread of the groups' `κ` at the
///   positions outside the core's region (`f_core` times the white one; at
///   every position when the support has none outside). Inside the region
///   the groups also differ by the cell's own light (residual motion,
///   shape changes), which is not noise and would make a cell with steep
///   flanks look noisy.
/// * Against the footprint's own texture (`z_tex`): its mean light in the
///   soma square minus the median of that level at the support positions
///   whose square does not touch the core's region, over their lower-half
///   spread (median minus the 15.9th percentile). Texture is symmetric
///   about its median; another cell inside the support only adds a positive
///   tail, which the lower-half spread ignores. (The contrast `κ` would be
///   the wrong statistic here: a bright second cell in the annulus of a
///   texture position makes its contrast negative and widens the lower
///   half, which is how merged pairs failed.) `+inf` when no such position
///   exists (a compact footprint). The bar `z_tex_bar` is the keep level
///   corrected for the number of soma-sized positions the core was chosen
///   among.
///
/// The core's region is its soma square plus its basin: the light reached
/// from it by a descent on the even groups' PSF-smoothed light (`psf_sigma`)
/// that never climbs more than `basin_z` measured standard errors above the
/// lowest light on its way. That is the light the basin trim keeps for the
/// cell, so the far end of an elongated cell belongs to its core, not to
/// the texture, while a texture blob's basin ends at the saddles to its
/// neighbours.
pub(crate) fn core_test(
    m: &GroupMaps,
    d: f64,
    inside: impl Fn(i64, i64) -> bool,
    keep_z: f64,
    psf_sigma: f64,
    basin_z: f64,
) -> Option<CoreTest> {
    const P_LO: f64 = 0.1587;
    let (ch, cw) = (m.ch, m.cw);
    let n = ch * cw;
    let groups = m.maps.len();
    let sw: f64 = m.wg.iter().sum();
    let white_unit = m.w2.iter().sum::<f64>() / (sw * sw);
    // Square of the soma disk's area: side d √π / 2; half-side rounded.
    let hc = ((d * std::f64::consts::PI.sqrt() / 2.0 - 1.0) / 2.0)
        .round()
        .max(1.0) as i64;
    let ha = 2 * hc + 1;
    let full_c = ((2 * hc + 1) * (2 * hc + 1)) as f64;
    let full_a = ((2 * ha + 1) * (2 * ha + 1)) as f64 - full_c;
    let ip = integral(m.present, ch, cw);
    let ig: Vec<Vec<f64>> = m.maps.iter().map(|g| integral(g, ch, cw)).collect();
    // Per group: κ and the soma square's level at (cy, cx), and the pixel
    // counts; None if under-covered.
    let at = |cy: i64, cx: i64| -> Option<(Vec<f64>, Vec<f64>, f64, f64)> {
        let nc = box_sum(&ip, ch, cw, cy, cx, hc);
        let na = box_sum(&ip, ch, cw, cy, cx, ha) - nc;
        if nc < 0.9 * full_c || na < 0.5 * full_a {
            return None;
        }
        let (mut k, mut l) = (Vec::with_capacity(groups), Vec::with_capacity(groups));
        for s in &ig {
            let c = box_sum(s, ch, cw, cy, cx, hc);
            let t = box_sum(s, ch, cw, cy, cx, ha);
            k.push(c / nc - (t - c) / na);
            l.push(c / nc);
        }
        Some((k, l, nc, na))
    };
    let (even, odd): (Vec<usize>, Vec<usize>) = (0..groups).partition(|g| g % 2 == 0);
    let unit = |set: &[usize]| {
        let s: f64 = set.iter().map(|&g| m.wg[g]).sum();
        set.iter().map(|&g| m.w2[g]).sum::<f64>() / (s * s)
    };
    let pooled = |k: &[f64], set: &[usize]| -> f64 {
        set.iter().map(|&g| m.wg[g] * k[g]).sum::<f64>() / set.iter().map(|&g| m.wg[g]).sum::<f64>()
    };
    // replicate variance of the pooled value
    let spread = |k: &[f64]| -> f64 {
        let mean: f64 = k.iter().zip(m.wg).map(|(v, w)| v * w).sum::<f64>() / sw;
        k.iter()
            .zip(m.wg)
            .map(|(v, w)| w * (v - mean).powi(2))
            .sum::<f64>()
            / (groups as f64 - 1.0)
            / sw
    };
    // The core: largest even-group contrast among the support positions.
    let mut n_inside = 0usize;
    let mut best: Option<(f64, i64, i64)> = None;
    for cy in 0..ch as i64 {
        for cx in 0..cw as i64 {
            if !inside(cy, cx) {
                continue;
            }
            let Some((k, ..)) = at(cy, cx) else { continue };
            n_inside += 1;
            let ke = pooled(&k, &even);
            if best.is_none_or(|b| ke > b.0) {
                best = Some((ke, cy, cx));
            }
        }
    }
    let (_, by, bx) = best?;
    // Its region: soma square and basin on the even groups' smoothed light.
    let bp = blur(m.present, ch, cw, psf_sigma);
    let sm: Vec<Vec<f64>> = m
        .maps
        .iter()
        .map(|g| {
            let b = blur(g, ch, cw, psf_sigma);
            (0..n)
                .map(|p| {
                    if m.present[p] > 0.0 && bp[p] > 1e-3 {
                        b[p] / bp[p]
                    } else {
                        f64::NAN
                    }
                })
                .collect()
        })
        .collect();
    let mut pv: Vec<f64> = (0..n)
        .filter(|&p| sm[0][p].is_finite())
        .map(|p| spread(&sm.iter().map(|g| g[p]).collect::<Vec<_>>()))
        .collect();
    pv.sort_by(f64::total_cmp);
    let pv_med = pv.get(pv.len() / 2).copied()?;
    let tol = basin_z * (pv_med / CHI2_7_MEDIAN * unit(&even) / white_unit).sqrt();
    let u: Vec<f64> = (0..n)
        .map(|p| pooled(&sm.iter().map(|g| g[p]).collect::<Vec<_>>(), &even))
        .collect();
    let mut region = basin(&u, ch, cw, (by, bx), tol);
    for y in (by - hc).max(0)..=(by + hc).min(ch as i64 - 1) {
        for x in (bx - hc).max(0)..=(bx + hc).min(cw as i64 - 1) {
            region[y as usize * cw + x as usize] = true;
        }
    }
    let n_region = region.iter().filter(|&&b| b).count();
    // Positions whose soma square touches the region (dilation by hc).
    let ir = integral(
        &region
            .iter()
            .map(|&b| f64::from(u8::from(b)))
            .collect::<Vec<_>>(),
        ch,
        cw,
    );
    let touches = |cy: i64, cx: i64| box_sum(&ir, ch, cw, cy, cx, hc) > 0.0;
    let in_region = |cy: i64, cx: i64| region[cy as usize * cw + cx as usize];
    // Noise of κ outside the region (all positions if none).
    let mut fc_out: Vec<f64> = Vec::new();
    let mut fc_all: Vec<f64> = Vec::new();
    let mut levels: Vec<f64> = Vec::new();
    for cy in 0..ch as i64 {
        for cx in 0..cw as i64 {
            let Some((k, l, nc, na)) = at(cy, cx) else {
                continue;
            };
            if cy % 2 == 0 && cx % 2 == 0 {
                let f = spread(&k) / (white_unit * (1.0 / nc + 1.0 / na));
                fc_all.push(f);
                if !in_region(cy, cx) {
                    fc_out.push(f);
                }
            }
            if inside(cy, cx) && !touches(cy, cx) {
                levels.push(pooled(&l, &odd));
            }
        }
    }
    let mut fc = if fc_out.len() >= 3 { fc_out } else { fc_all };
    if fc.len() < 3 {
        return None;
    }
    fc.sort_by(f64::total_cmp);
    let f_core = fc[fc.len() / 2] / CHI2_7_MEDIAN;
    let (k, l, nc, na) = at(by, bx).expect("chosen among covered positions");
    let z_core = pooled(&k, &odd) / (f_core * unit(&odd) * (1.0 / nc + 1.0 / na)).sqrt();
    // independent soma-sized positions the core was chosen among
    let n_pos = (n_inside as f64 / (std::f64::consts::PI * d * d / 4.0)).max(1.0);
    let z_tex_bar = norm_isf(norm_sf(keep_z) / n_pos);
    let z_tex = if levels.len() < 4 {
        f64::INFINITY
    } else {
        levels.sort_by(f64::total_cmp);
        let med = levels[levels.len() / 2];
        let sd = med - levels[((levels.len() as f64) * P_LO) as usize];
        if sd > 0.0 {
            (pooled(&l, &odd) - med) / sd
        } else {
            f64::INFINITY
        }
    };
    Some(CoreTest {
        pos: (by, bx),
        z_core,
        f_core,
        z_tex,
        z_tex_bar,
        n_ref: levels.len(),
        region: n_region,
    })
}

/// Upper tail of the standard normal.
pub(crate) fn norm_sf(z: f64) -> f64 {
    0.5 * erfc(z / std::f64::consts::SQRT_2)
}

/// Inverse of [`norm_sf`] (bisection; plenty for thresholds).
pub(crate) fn norm_isf(p: f64) -> f64 {
    let (mut lo, mut hi) = (-10.0f64, 10.0f64);
    for _ in 0..80 {
        let m = 0.5 * (lo + hi);
        if norm_sf(m) > p {
            lo = m;
        } else {
            hi = m;
        }
    }
    0.5 * (lo + hi)
}

/// Complementary error function (Numerical Recipes erfcc, |err| < 1.2e-7).
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let r = t
        * (-z * z - 1.26551223
            + t * (1.00002368
                + t * (0.37409196
                    + t * (0.09678418
                        + t * (-0.18628806
                            + t * (0.27886807
                                + t * (-1.13520398
                                    + t * (1.48851638 + t * (-0.82215223 + t * 0.17087277)))))))))
            .exp();
    if x >= 0.0 {
        r
    } else {
        2.0 - r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = 61;
    const D: f64 = 10.0;
    const GROUPS: usize = 8;

    /// Standard normal from a counter (sum of 12 uniforms).
    fn gauss(k: u64) -> f64 {
        (0..12)
            .map(|i| {
                (crate::discover::reservoir::mix(k * 12 + i) >> 11) as f64 / (1u64 << 53) as f64
            })
            .sum::<f64>()
            - 6.0
    }

    /// Group maps on a 61 x 61 canvas, statistics disk of radius 25 and
    /// support of radius 22: `light` in every group plus unit white noise
    /// per group and pixel.
    fn test(light: &[f64], seed: u64) -> CoreTest {
        let c = (N / 2) as f64;
        let present: Vec<f64> = (0..N * N)
            .map(|p| {
                f64::from(u8::from(
                    ((p / N) as f64 - c).hypot((p % N) as f64 - c) <= 25.0,
                ))
            })
            .collect();
        let maps: Vec<Vec<f64>> = (0..GROUPS)
            .map(|g| {
                (0..N * N)
                    .map(|p| {
                        present[p] * (light[p] + gauss(seed * 1_000_003 + (g * N * N + p) as u64))
                    })
                    .collect()
            })
            .collect();
        let w = vec![1.0; GROUPS];
        let m = GroupMaps {
            ch: N,
            cw: N,
            maps: &maps,
            present: &present,
            wg: &w,
            w2: &w,
        };
        let inside = |y: i64, x: i64| (y as f64 - c).hypot(x as f64 - c) <= 22.0;
        core_test(&m, D, inside, 2.0, 1.5, 2.0).expect("covered")
    }

    fn blob(light: &mut [f64], (cy, cx): (f64, f64), (sy, sx): (f64, f64), amp: f64) {
        for (p, v) in light.iter_mut().enumerate() {
            let (y, x) = ((p / N) as f64, (p % N) as f64);
            *v += amp * (-0.5 * (((y - cy) / sy).powi(2) + ((x - cx) / sx).powi(2))).exp();
        }
    }

    fn ok(t: &CoreTest) -> bool {
        t.z_core >= 2.0 && t.z_tex >= t.z_tex_bar
    }

    #[test]
    fn one_cell_passes_at_its_centre() {
        let mut light = vec![0.0; N * N];
        blob(&mut light, (30.0, 30.0), (3.0, 3.0), 1.5);
        let t = test(&light, 1);
        assert!(ok(&t), "{t:?}");
        assert!(
            (t.pos.0 - 30).abs() <= 1 && (t.pos.1 - 30).abs() <= 1,
            "{t:?}"
        );
    }

    /// A dim cell: about six standard errors of its held-out contrast.
    #[test]
    fn dim_cell_passes() {
        let mut light = vec![0.0; N * N];
        blob(&mut light, (30.0, 30.0), (3.0, 3.0), 0.6);
        let t = test(&light, 4);
        assert!(ok(&t), "{t:?}");
    }

    /// Two cells in one footprint: the second one is a positive tail of
    /// the texture levels, not a widening of their spread.
    #[test]
    fn merged_pair_passes() {
        for (seed, amp2) in [(2, 1.5), (5, 3.0), (6, 0.8)] {
            let mut light = vec![0.0; N * N];
            blob(&mut light, (30.0, 21.0), (3.0, 3.0), 1.5);
            blob(&mut light, (30.0, 39.0), (3.0, 3.0), amp2);
            let t = test(&light, seed);
            assert!(ok(&t), "{amp2}: {t:?}");
        }
    }

    /// An elongated cell: its far end is part of its core's basin.
    #[test]
    fn elongated_cell_passes() {
        let mut light = vec![0.0; N * N];
        blob(&mut light, (30.0, 30.0), (3.0, 9.0), 1.5);
        let t = test(&light, 3);
        assert!(ok(&t), "{t:?}");
        assert!(t.region > 200, "{t:?}");
    }

    /// Texture that replicates in every group (a noise-feedback fixed
    /// point): its blobs stand out of the noise but not of the texture.
    #[test]
    fn replicated_texture_fails() {
        let mut fails = 0;
        for seed in 0..8u64 {
            // white noise blurred at a 1.5 px PSF, normalised to unit spread
            let raw: Vec<f64> = (0..N * N)
                .map(|p| gauss(77_000_000 + seed * 10_000 + p as u64))
                .collect();
            let tex = blur(&raw, N, N, 1.5);
            let sd = (tex.iter().map(|v| v * v).sum::<f64>() / (N * N) as f64).sqrt();
            let light: Vec<f64> = tex.iter().map(|v| 1.5 * v / sd).collect();
            let t = test(&light, 100 + seed);
            assert!(t.z_core > 2.0, "texture replicates: {t:?}");
            fails += usize::from(!ok(&t));
        }
        assert!(fails >= 7, "{fails} of 8 rejected");
    }

    /// A bright compact cell whose light jitters between the groups
    /// (residual motion): the jitter is the cell's own light, not noise.
    #[test]
    fn bright_jittering_cell_passes() {
        let c = (N / 2) as f64;
        let present: Vec<f64> = (0..N * N)
            .map(|p| {
                f64::from(u8::from(
                    ((p / N) as f64 - c).hypot((p % N) as f64 - c) <= 18.0,
                ))
            })
            .collect();
        let maps: Vec<Vec<f64>> = (0..GROUPS)
            .map(|g| {
                let mut light = vec![0.0; N * N];
                let s = if g % 2 == 0 { 0.8 } else { -0.8 };
                let (dy, dx) = (s * ((g / 2) % 2) as f64, s * (1 - (g / 2) % 2) as f64);
                blob(&mut light, (c + dy, c + dx), (2.5, 2.5), 20.0);
                (0..N * N)
                    .map(|p| present[p] * (light[p] + gauss(9_000_000 + (g * N * N + p) as u64)))
                    .collect()
            })
            .collect();
        let w = vec![1.0; GROUPS];
        let m = GroupMaps {
            ch: N,
            cw: N,
            maps: &maps,
            present: &present,
            wg: &w,
            w2: &w,
        };
        let inside = |y: i64, x: i64| (y as f64 - c).hypot(x as f64 - c) <= 9.0;
        let t = core_test(&m, D, inside, 2.0, 1.5, 2.0).expect("covered");
        assert!(ok(&t), "{t:?}");
    }

    #[test]
    fn basin_stops_at_saddles_and_descends_long_slopes() {
        // two peaks joined by a saddle 3 below them; a long gentle slope
        let (ch, cw) = (1, 9);
        let u = [1.0, 5.0, 9.0, 6.0, 7.0, 9.5, 8.0, 7.0, 6.0];
        let b = basin(&u, ch, cw, (0, 2), 0.5);
        assert_eq!(
            b,
            [true, true, true, true, false, false, false, false, false]
        );
        let b = basin(&u, ch, cw, (0, 5), 0.5);
        assert_eq!(b, [false, false, false, true, true, true, true, true, true]);
    }
}
