//! The footprint library: immutable, versioned, with every per-frame-constant
//! term of the trace solve precomputed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use super::background::BackgroundModel;
use super::{check_len, FrameTraces, TraceError};
use crate::preprocess::flatten::GlowFlattener;
use crate::preprocess::{Dims, PreprocessError};

/// Source of library version numbers when the caller gives none.
static NEXT_VERSION: AtomicU64 = AtomicU64::new(1);

/// One cell's footprint in the **unfiltered** image: a non-negative patch
/// whose top-left corner sits at `(y0, x0)` of the frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Footprint {
    /// Caller's stable cell id; warm starts follow it across library swaps.
    pub id: u64,
    pub y0: usize,
    pub x0: usize,
    pub height: usize,
    pub width: usize,
    /// `height * width` values, row-major, all finite and `>= 0`.
    pub values: Vec<f32>,
}

/// The preprocessing high-pass, applied to footprints so the model sees the
/// same filter as the data. It must be linear (no clipping, no per-frame
/// statistics) and act on a full `dims` frame in place.
pub trait LinearFilter {
    fn dims(&self) -> Dims;
    /// Distance in pixels beyond which one pixel's response is negligible
    /// (used to filter many far-apart footprints in one pass).
    fn reach_px(&self) -> f32;
    /// σ of the smooth low-pass the high-pass subtracts (`H = I − L`), px;
    /// 0 when there is none. It sets the coarse grid on which a filtered
    /// footprint's moat (`−L a`, the negative ring the high-pass leaves
    /// around every cell) is modelled ([`moat_geometry`]).
    fn lowpass_sigma_px(&self) -> f32 {
        0.0
    }
    fn apply(&mut self, frame: &mut [f32]) -> Result<(), PreprocessError>;
}

/// Block side (px) and reach beyond the support (px) of the coarse
/// low-pass part of a filtered footprint, for a high-pass `I − L` whose
/// low-pass has scale `sigma`; `None` without one.
///
/// A filtered footprint is `H a = a − L a`. On its support it is kept
/// exactly; outside, it is `−L a`, a negative moat as smooth as `L`
/// (σ = 20 px for the default flattener) that reaches far beyond the cell.
/// It is stored as block means on a grid of side σ / 2.5 (8 px), which
/// misses under 2 % of the moat's energy (within-block variation), out to
/// 2σ beyond the support, where the moat's energy has fallen to e⁻⁴ of its
/// peak density (what lies beyond is < 0.1 % of a cell's filtered energy).
/// Projections, the Gram, the background terms and the rendered model all
/// use this one representation, so the solve is an exact least-squares fit
/// of it.
pub fn moat_geometry(sigma: f32) -> Option<(usize, f32)> {
    (sigma.is_finite() && sigma > 0.0)
        .then(|| (((sigma / 2.5).round() as usize).max(1), 2.0 * sigma))
}

/// The moat blocks of a support disk: global indices (`by * gw + bx` on
/// the grid of side `b` over `dims`), ascending, of the blocks whose centre
/// lies within `radius + reach + b/√2` of `center`.
pub fn moat_blocks(center: (f32, f32), radius: f32, b: usize, reach: f32, dims: Dims) -> Vec<u32> {
    let gw = dims.width.div_ceil(b);
    let gh = dims.height.div_ceil(b);
    let lim = radius + reach + 0.7072 * b as f32;
    let bf = b as f32;
    let by0 = (((center.0 - lim) / bf).floor().max(0.0)) as usize;
    let by1 = ((((center.0 + lim) / bf).floor().max(0.0)) as usize).min(gh - 1);
    let bx0 = (((center.1 - lim) / bf).floor().max(0.0)) as usize;
    let bx1 = ((((center.1 + lim) / bf).floor().max(0.0)) as usize).min(gw - 1);
    let mut out = Vec::new();
    for by in by0..=by1 {
        // Centre of the block's in-frame part.
        let y1 = ((by + 1) * b).min(dims.height);
        let cy = 0.5 * ((by * b) as f32 + y1 as f32) - 0.5;
        for bx in bx0..=bx1 {
            let x1 = ((bx + 1) * b).min(dims.width);
            let cx = 0.5 * ((bx * b) as f32 + x1 as f32) - 0.5;
            let (dy, dx) = (cy - center.0, cx - center.1);
            if dy * dy + dx * dx <= lim * lim {
                out.push((by * gw + bx) as u32);
            }
        }
    }
    out
}

/// Add the skirt's blocks to the ascending block list `blks` (a skirt
/// block is normally a moat block already: the statistics disk lies well
/// inside the moat's reach).
pub(crate) fn merge_blocks(blks: &mut Vec<u32>, skirt: &[(u32, f32)]) {
    if skirt.iter().all(|s| blks.binary_search(&s.0).is_ok()) {
        return;
    }
    blks.extend(skirt.iter().map(|s| s.0));
    blks.sort_unstable();
    blks.dedup();
}

/// Radius of the disk around `center` that holds the support disk
/// (`radius`) and every skirt block (side `block`) whole: the moat of a
/// footprint with a skirt is [`moat_blocks`] of this radius, so it reaches
/// as far beyond the skirt as beyond the support. Without a skirt it is
/// `radius`.
pub(crate) fn skirt_radius(
    center: (f32, f32),
    radius: f32,
    skirt: &[(u32, f32)],
    block: usize,
    dims: Dims,
) -> f32 {
    if block == 0 {
        return radius;
    }
    let gw = dims.width.div_ceil(block);
    skirt.iter().fold(radius, |r, &(bq, _)| {
        let (by, bx) = (bq as usize / gw, bq as usize % gw);
        let y1 = ((by + 1) * block).min(dims.height);
        let x1 = ((bx + 1) * block).min(dims.width);
        let (cy, cx) = (
            0.5 * ((by * block) as f32 + y1 as f32) - 0.5,
            0.5 * ((bx * block) as f32 + x1 as f32) - 0.5,
        );
        let (dy, dx) = (cy - center.0, cx - center.1);
        r.max((dy * dy + dx * dx).sqrt() + 0.7072 * block as f32)
    })
}

/// The skirt as unfiltered light: `(pixel, skirt_b)` on every FOV pixel of
/// a skirt block outside the support `S` (the support disk pixels `pix`
/// with `raw ≠ 0`, as in [`apply_skirt`]). The column of a footprint with a
/// skirt is the filter applied to the support values plus this field, so
/// it carries the skirt's own low-pass (its negative lobe in the moat) and
/// sums to about zero like any filtered footprint.
pub(crate) fn skirt_field(
    pix: &[u32],
    raw: &[f32],
    skirt: &[(u32, f32)],
    block: usize,
    dims: Dims,
    fov: &[u8],
) -> Vec<(u32, f32)> {
    if skirt.is_empty() || block == 0 {
        return Vec::new();
    }
    let on_s: std::collections::HashSet<u32> = pix
        .iter()
        .zip(raw)
        .filter(|&(_, &v)| v != 0.0)
        .map(|(&g, _)| g)
        .collect();
    let (w, h) = (dims.width, dims.height);
    let gw = w.div_ceil(block);
    let mut out = Vec::new();
    for &(bq, s) in skirt {
        let (by, bx) = (bq as usize / gw, bq as usize % gw);
        for y in by * block..((by + 1) * block).min(h) {
            for x in bx * block..((bx + 1) * block).min(w) {
                let g = (y * w + x) as u32;
                if fov[g as usize] != 0 && !on_s.contains(&g) {
                    out.push((g, s));
                }
            }
        }
    }
    out
}

/// Fold a skirt into a column whose low-pass (`filt = raw − L f`, `low_b`
/// the block means of `L f`) was taken of the whole footprint `f`, support
/// values plus [`skirt_field`]: the column `f − L f` takes the
/// block-constant field `skirt_b` on the complement of the support
/// `S = {raw > 0}`. Off the support disk the column is `−low_b`, so
/// `low_b ← low_b − skirt_b`; on disk pixels outside `S` (`raw = 0`, FOV
/// only) `filt ← filt + skirt_b`; on `S` nothing changes. `blks` must hold
/// every skirt block.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_skirt(
    pix: &[u32],
    raw: &[f32],
    filt: &mut [f32],
    blks: &[u32],
    low: &mut [f32],
    skirt: &[(u32, f32)],
    block: usize,
    dims: Dims,
    fov: &[u8],
) {
    if skirt.is_empty() || block == 0 {
        return;
    }
    for &(bq, s) in skirt {
        if let Ok(k) = blks.binary_search(&bq) {
            low[k] -= s;
        }
    }
    let w = dims.width;
    let gw = w.div_ceil(block);
    for (k, (&g, &v)) in pix.iter().zip(raw).enumerate() {
        if v != 0.0 || fov[g as usize] == 0 {
            continue;
        }
        let (y, x) = (g as usize / w, g as usize % w);
        let bq = ((y / block) * gw + x / block) as u32;
        if let Ok(j) = skirt.binary_search_by_key(&bq, |s| s.0) {
            filt[k] += skirt[j].1;
        }
    }
}

impl LinearFilter for GlowFlattener {
    fn dims(&self) -> Dims {
        GlowFlattener::dims(self)
    }

    /// 6 σ: the Gaussian weight there is 1.5e-8 of its peak.
    fn reach_px(&self) -> f32 {
        6.0 * self.sigma()
    }

    fn lowpass_sigma_px(&self) -> f32 {
        self.sigma()
    }

    fn apply(&mut self, frame: &mut [f32]) -> Result<(), PreprocessError> {
        GlowFlattener::apply(self, frame).map(|_| ())
    }
}

/// No filtering (for unfiltered data and tests).
#[derive(Debug, Clone, Copy)]
pub struct IdentityFilter(pub Dims);

impl LinearFilter for IdentityFilter {
    fn dims(&self) -> Dims {
        self.0
    }
    fn reach_px(&self) -> f32 {
        0.0
    }
    fn apply(&mut self, _: &mut [f32]) -> Result<(), PreprocessError> {
        Ok(())
    }
}

/// The support a new footprint starts on, before its extent is measured.
///
/// The library itself never trims a footprint: a footprint's support is the
/// disk that holds every one of its non-zero values (its own extent, see
/// [`support_disk`]). Where to cut a *new* estimate is the caller's choice;
/// the slow loop seeds a candidate on this rule and then lets the running
/// statistics grow it to wherever its light is significant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LibraryConfig {
    /// Seed support radius as a multiple of the footprint's half-width at
    /// half maximum (from the area above half the peak).
    pub support_per_hwhm: f32,
    /// Smallest seed support radius, px.
    pub min_support_px: f32,
}

impl Default for LibraryConfig {
    fn default() -> LibraryConfig {
        LibraryConfig {
            support_per_hwhm: 2.5,
            min_support_px: 6.0,
        }
    }
}

impl LibraryConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        let ok = self.support_per_hwhm.is_finite()
            && self.support_per_hwhm > 0.0
            && self.min_support_px.is_finite()
            && self.min_support_px >= 1.0;
        if ok {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }

    /// Seed support radius for a footprint of half-width `hwhm` (no upper
    /// bound).
    pub fn seed_radius(&self, hwhm: f32) -> f32 {
        (self.support_per_hwhm * hwhm).max(self.min_support_px)
    }
}

/// Collects footprints and settings, then builds a [`Library`].
#[derive(Debug, Clone)]
pub struct LibraryBuilder {
    dims: Dims,
    footprints: Vec<Footprint>,
    /// Explicit support disks (`push_disk`), one per footprint.
    disks: Vec<Option<((f32, f32), f32)>>,
    /// Skirts (`push_disk_skirt`), one per footprint (empty: none).
    skirts: Vec<Vec<(u32, f32)>>,
    fov: Option<Vec<u8>>,
    noise: Option<Vec<f32>>,
    background: BackgroundModel,
    version: Option<u64>,
    reuse: Option<std::sync::Arc<Library>>,
}

impl LibraryBuilder {
    pub fn new(dims: Dims) -> LibraryBuilder {
        LibraryBuilder {
            dims,
            footprints: Vec::new(),
            disks: Vec::new(),
            skirts: Vec::new(),
            fov: None,
            noise: None,
            background: BackgroundModel::None,
            version: None,
            reuse: None,
        }
    }

    /// The lit field of view (non-zero = inside); ring pixels outside it are
    /// not used. Default: the whole frame.
    pub fn fov(mut self, mask: Vec<u8>) -> LibraryBuilder {
        self.fov = Some(mask);
        self
    }

    /// Per-pixel noise σ of the preprocessed frames (the preprocessing noise
    /// map); sets each trace's noise unit. Default: σ = 1 everywhere.
    pub fn noise(mut self, sigma: Vec<f32>) -> LibraryBuilder {
        self.noise = Some(sigma);
        self
    }

    pub fn background(mut self, model: BackgroundModel) -> LibraryBuilder {
        self.background = model;
        self
    }

    /// Explicit version number (default: a process-wide counter).
    pub fn version(mut self, v: u64) -> LibraryBuilder {
        self.version = Some(v);
        self
    }

    /// Take the filtered values of footprints that are unchanged from
    /// `prev` (same id, support and values) instead of filtering them again.
    /// `prev` must have been built with the same filter. An incremental
    /// rebuild after a few edits then filters only the edited cells.
    pub fn reuse(mut self, prev: std::sync::Arc<Library>) -> LibraryBuilder {
        self.reuse = Some(prev);
        self
    }

    pub fn push(&mut self, fp: Footprint) {
        self.footprints.push(fp);
        self.disks.push(None);
        self.skirts.push(Vec::new());
    }

    /// `fp` on an explicit support disk (centre `(y, x)`, radius): its
    /// window's pixels inside the disk, zero values included (the slow loop
    /// publishes its cells' supports exactly, so a footprint whose outer
    /// ring is zero keeps the room to grow into it).
    pub fn push_disk(&mut self, fp: Footprint, center: (f32, f32), radius: f32) {
        self.push_disk_skirt(fp, center, radius, Vec::new());
    }

    /// [`Self::push_disk`] with a skirt: block means (ascending global
    /// blocks of the moat grid) of the measured light outside the support
    /// that the column carries at block resolution (see [`apply_skirt`]).
    pub fn push_disk_skirt(
        &mut self,
        fp: Footprint,
        center: (f32, f32),
        radius: f32,
        skirt: Vec<(u32, f32)>,
    ) {
        self.footprints.push(fp);
        self.disks.push(Some((center, radius)));
        self.skirts.push(skirt);
    }

    pub fn footprint(mut self, fp: Footprint) -> LibraryBuilder {
        self.push(fp);
        self
    }

    /// Filter every footprint with `filter` and precompute the solve terms.
    pub fn build(self, filter: &mut dyn LinearFilter) -> Result<Library, TraceError> {
        let dims = self.dims;
        let n_px = dims.pixels();
        if filter.dims() != dims {
            return Err(TraceError::Incompatible(format!(
                "filter is {:?}, library {:?}",
                filter.dims(),
                dims
            )));
        }
        let fov = match self.fov {
            Some(m) => {
                check_len("fov mask", n_px, m.len())?;
                m
            }
            None => vec![1; n_px],
        };
        let noise = match self.noise {
            Some(s) => {
                check_len("noise map", n_px, s.len())?;
                if s.iter().any(|v| !v.is_finite() || *v < 0.0) {
                    return Err(TraceError::InvalidConfig(
                        "noise map must be finite and >= 0".into(),
                    ));
                }
                s
            }
            None => vec![1.0; n_px],
        };
        let mut ids = Vec::with_capacity(self.footprints.len());
        let mut index_of = HashMap::with_capacity(self.footprints.len());
        let mut centers = Vec::new();
        let mut radii = Vec::new();
        let mut col_start = vec![0usize];
        let mut pix = Vec::new();
        let mut raw = Vec::new();
        let geom = moat_geometry(filter.lowpass_sigma_px());
        let mut low_start = vec![0usize];
        let mut low_blk: Vec<u32> = Vec::new();
        let mut skirt_start = vec![0usize];
        let mut skirt_blk: Vec<u32> = Vec::new();
        let mut skirt_val: Vec<f32> = Vec::new();
        for (fp, disk) in self.footprints.iter().zip(&self.disks) {
            if index_of.insert(fp.id, ids.len()).is_some() {
                return Err(TraceError::InvalidFootprint(format!(
                    "duplicate id {}",
                    fp.id
                )));
            }
            ids.push(fp.id);
            let own = support_disk(fp, dims)?;
            let ((cy, cx), r) = match *disk {
                Some((c, r)) if c.0.is_finite() && c.1.is_finite() && r.is_finite() && r >= 0.0 => {
                    (c, r)
                }
                Some(_) => {
                    return Err(TraceError::InvalidFootprint(format!(
                        "id {}: bad support disk",
                        fp.id
                    )))
                }
                None => (own.center, own.radius),
            };
            centers.push((cy, cx));
            radii.push(r);
            let r2 = r * r;
            for y in 0..fp.height {
                for x in 0..fp.width {
                    let (gy, gx) = (fp.y0 + y, fp.x0 + x);
                    let dy = gy as f32 - cy;
                    let dx = gx as f32 - cx;
                    if dy * dy + dx * dx <= r2 {
                        pix.push((gy * dims.width + gx) as u32);
                        raw.push(fp.values[y * fp.width + x]);
                    }
                }
            }
            col_start.push(pix.len());
            let skirt = &self.skirts[ids.len() - 1];
            if let Some((b, reach)) = geom {
                let rm = skirt_radius((cy, cx), r, skirt, b, dims);
                let mut blks = moat_blocks((cy, cx), rm, b, reach, dims);
                merge_blocks(&mut blks, skirt);
                low_blk.extend(blks);
                skirt_blk.extend(skirt.iter().map(|s| s.0));
                skirt_val.extend(skirt.iter().map(|s| s.1));
            }
            low_start.push(low_blk.len());
            skirt_start.push(skirt_blk.len());
        }
        let n = ids.len();
        let mut val = vec![0.0f32; pix.len()];
        let mut low_val = vec![0.0f32; low_blk.len()];
        // Unchanged footprints keep the filtered values of `reuse`.
        let mut done = vec![false; n];
        if let Some(prev) = &self.reuse {
            if prev.dims() == dims {
                for i in 0..n {
                    let Some(slot) = prev.slot(ids[i]) else {
                        continue;
                    };
                    let (a, b) = (col_start[i], col_start[i + 1]);
                    let (pp, pr) = prev.unfiltered(slot);
                    let (lb, lv) = prev.lowpass(slot);
                    let (la, lz) = (low_start[i], low_start[i + 1]);
                    let (sa, sz) = (skirt_start[i], skirt_start[i + 1]);
                    if pp == &pix[a..b]
                        && pr == &raw[a..b]
                        && prev.core.block == geom.map_or(0, |g| g.0)
                        && lb == &low_blk[la..lz]
                        && prev.skirt(slot) == (&skirt_blk[sa..sz], &skirt_val[sa..sz])
                    {
                        val[a..b].copy_from_slice(prev.filtered(slot).1);
                        low_val[la..lz].copy_from_slice(lv);
                        done[i] = true;
                    }
                }
            }
        }
        // Filter the support-limited footprints, many per pass when they are
        // further apart than the filter's reach.
        let reach = filter.reach_px();
        // A footprint with a skirt is its support values plus the skirt
        // field, which reaches past the support disk.
        let fields: Vec<Vec<(u32, f32)>> = (0..n)
            .map(|i| match geom {
                Some((b, _)) if !done[i] => skirt_field(
                    &pix[col_start[i]..col_start[i + 1]],
                    &raw[col_start[i]..col_start[i + 1]],
                    &self.skirts[i],
                    b,
                    dims,
                    &fov,
                ),
                _ => Vec::new(),
            })
            .collect();
        let extent: Vec<f32> = (0..n)
            .map(|i| match geom {
                Some((b, _)) => skirt_radius(centers[i], radii[i], &self.skirts[i], b, dims),
                None => radii[i],
            })
            .collect();
        let mut canvases: Vec<Vec<usize>> = Vec::new();
        for i in (0..n).filter(|&i| !done[i]) {
            let fits = |members: &Vec<usize>| {
                members.iter().all(|&j| {
                    let (dy, dx) = (centers[i].0 - centers[j].0, centers[i].1 - centers[j].1);
                    let need = reach + extent[i] + extent[j] + 2.0;
                    dy * dy + dx * dx >= need * need
                })
            };
            match canvases.iter_mut().find(|m| fits(m)) {
                Some(m) => m.push(i),
                None => canvases.push(vec![i]),
            }
        }
        let mut img = vec![0.0f32; n_px];
        let mut src = vec![0.0f32; n_px];
        let w = dims.width;
        for members in &canvases {
            for &i in members {
                for k in col_start[i]..col_start[i + 1] {
                    img[pix[k] as usize] = raw[k];
                    src[pix[k] as usize] = raw[k];
                }
                for &(g, u) in &fields[i] {
                    img[g as usize] = u;
                    src[g as usize] = u;
                }
            }
            filter.apply(&mut img)?;
            for &i in members {
                if fields[i].is_empty() {
                    for k in col_start[i]..col_start[i + 1] {
                        val[k] = img[pix[k] as usize];
                    }
                } else {
                    // `raw − L f` (the skirt itself is added below).
                    for k in col_start[i]..col_start[i + 1] {
                        let q = pix[k] as usize;
                        val[k] = raw[k] - (src[q] - img[q]);
                    }
                }
                // Moat: block means of the low-pass `a − H a` (FOV only).
                if let Some((b, _)) = geom {
                    let gw = dims.width.div_ceil(b);
                    for k in low_start[i]..low_start[i + 1] {
                        let (by, bx) = (low_blk[k] as usize / gw, low_blk[k] as usize % gw);
                        let (mut s, mut m) = (0.0f64, 0usize);
                        for y in by * b..((by + 1) * b).min(dims.height) {
                            for x in bx * b..((bx + 1) * b).min(dims.width) {
                                let q = y * w + x;
                                if fov[q] != 0 {
                                    s += f64::from(src[q] - img[q]);
                                    m += 1;
                                }
                            }
                        }
                        low_val[k] = if m > 0 { (s / m as f64) as f32 } else { 0.0 };
                    }
                    let (sa, sz) = (skirt_start[i], skirt_start[i + 1]);
                    if sz > sa {
                        let skirt: Vec<(u32, f32)> = skirt_blk[sa..sz]
                            .iter()
                            .copied()
                            .zip(skirt_val[sa..sz].iter().copied())
                            .collect();
                        let (ca, cz) = (col_start[i], col_start[i + 1]);
                        let (la, lz) = (low_start[i], low_start[i + 1]);
                        apply_skirt(
                            &pix[ca..cz],
                            &raw[ca..cz],
                            &mut val[ca..cz],
                            &low_blk[la..lz],
                            &mut low_val[la..lz],
                            &skirt,
                            b,
                            dims,
                            &fov,
                        );
                    }
                }
            }
            img.iter_mut().for_each(|v| *v = 0.0);
            for &i in members {
                for k in col_start[i]..col_start[i + 1] {
                    src[pix[k] as usize] = 0.0;
                }
                for &(g, _) in &fields[i] {
                    src[g as usize] = 0.0;
                }
            }
        }
        let core = Core {
            block: geom.map_or(0, |g| g.0),
            low_start,
            low_blk,
            low_val,
            skirt_start,
            skirt_blk,
            skirt_val,
            vc: Vec::new(),
            blk_fov: Vec::new(),
            blk_noise2: Vec::new(),
            dims,
            ids,
            index_of,
            centers,
            radii,
            col_start,
            pix,
            val,
            raw,
            fov,
            noise,
        };
        let version = self
            .version
            .unwrap_or_else(|| NEXT_VERSION.fetch_add(1, Ordering::Relaxed));
        let prev = self.reuse.as_deref();
        Library::assemble(core.finish(), self.background, version, prev)
    }
}

/// A footprint's support disk.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Support {
    /// Intensity-weighted centre of the area above half the peak, `(y, x)`.
    pub center: (f32, f32),
    /// Distance from the centre to the farthest non-zero value, px: the
    /// footprint's own extent (no cap).
    pub radius: f32,
    /// Half-width at half maximum, px (radius of a disk with the half-max
    /// area).
    pub hwhm: f32,
}

/// The support of `fp`: the disk around its half-max centroid that holds
/// every non-zero value.
pub fn support_disk(fp: &Footprint, dims: Dims) -> Result<Support, TraceError> {
    let bad = |m: &str| TraceError::InvalidFootprint(format!("id {}: {m}", fp.id));
    if fp.height == 0 || fp.width == 0 {
        return Err(bad("empty patch"));
    }
    if fp.y0 + fp.height > dims.height || fp.x0 + fp.width > dims.width {
        return Err(bad("patch extends outside the frame"));
    }
    check_len("footprint values", fp.height * fp.width, fp.values.len())?;
    if fp.values.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return Err(bad("values must be finite and >= 0"));
    }
    let peak = fp.values.iter().copied().fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return Err(bad("all zero"));
    }
    let half = 0.5 * peak;
    let (mut sw, mut sy, mut sx, mut count) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for y in 0..fp.height {
        for x in 0..fp.width {
            let v = fp.values[y * fp.width + x];
            if v >= half {
                let w = f64::from(v);
                sw += w;
                sy += w * (fp.y0 + y) as f64;
                sx += w * (fp.x0 + x) as f64;
                count += 1;
            }
        }
    }
    let (cy, cx) = ((sy / sw) as f32, (sx / sw) as f32);
    let mut r2 = 0.0f32;
    for y in 0..fp.height {
        for x in 0..fp.width {
            if fp.values[y * fp.width + x] > 0.0 {
                let (dy, dx) = ((fp.y0 + y) as f32 - cy, (fp.x0 + x) as f32 - cx);
                r2 = r2.max(dy * dy + dx * dx);
            }
        }
    }
    Ok(Support {
        center: (cy, cx),
        // A hair over the farthest value, so rounding never drops it.
        radius: r2.sqrt() + 1e-3,
        hwhm: (count as f32 / std::f32::consts::PI).sqrt(),
    })
}

/// The footprint part of a library (independent of the background model).
#[derive(Debug, Clone)]
struct Core {
    dims: Dims,
    ids: Vec<u64>,
    index_of: HashMap<u64, usize>,
    centers: Vec<(f32, f32)>,
    radii: Vec<f32>,
    /// Support of cell `i`: `pix[col_start[i]..col_start[i + 1]]`.
    col_start: Vec<usize>,
    pix: Vec<u32>,
    /// Filtered footprint values on the support.
    val: Vec<f32>,
    /// Unfiltered footprint values on the support.
    raw: Vec<f32>,
    fov: Vec<u8>,
    noise: Vec<f32>,
    /// Moat grid block side, px (0: no moat, an identity filter).
    block: usize,
    /// Moat of cell `i`: blocks `low_blk[low_start[i]..low_start[i + 1]]`
    /// (ascending global block indices) with the block means `low_val` of
    /// the low-pass `L a_i`. The column is `val` on the support and
    /// `−low(B(p))` off it.
    low_start: Vec<usize>,
    low_blk: Vec<u32>,
    low_val: Vec<f32>,
    /// Skirt of cell `i`: blocks
    /// `skirt_blk[skirt_start[i]..skirt_start[i + 1]]` (ascending, a subset
    /// of its moat blocks) with the measured block means `skirt_val` it
    /// carries ([`apply_skirt`]; already folded into `val` and `low_val`).
    /// Empty for every cell under the ring support rule.
    skirt_start: Vec<usize>,
    skirt_blk: Vec<u32>,
    skirt_val: Vec<f32>,
    /// Derived ([`Core::finish`]): `val + low(B(p))` on the support, so the
    /// column is `vc · 1_S − P low` (P: block-constant expansion, FOV only).
    vc: Vec<f32>,
    /// FOV pixels and summed noise variance of each grid block.
    blk_fov: Vec<f32>,
    blk_noise2: Vec<f32>,
}

/// A compressed sparse row matrix over cells.
#[derive(Debug, Clone, Default)]
pub(crate) struct Csr {
    pub start: Vec<usize>,
    pub col: Vec<u32>,
    pub val: Vec<f32>,
}

impl Csr {
    fn from_rows(rows: Vec<Vec<(u32, f32)>>) -> Csr {
        let mut start = vec![0];
        let mut col = Vec::new();
        let mut val = Vec::new();
        for mut r in rows {
            r.sort_by_key(|e| e.0);
            for (c, v) in r {
                col.push(c);
                val.push(v);
            }
            start.push(col.len());
        }
        Csr { start, col, val }
    }

    #[inline]
    pub fn row(&self, i: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.start[i], self.start[i + 1]);
        (&self.col[a..b], &self.val[a..b])
    }
}

/// Background terms precomputed for the solver.
#[derive(Debug, Clone)]
pub(crate) enum BgTerms {
    None,
    /// `k` spatial maps; `x[i*k..]` = `ã_iᵀ g`, `w[i*k..]` = `P x_i` with
    /// `P = (GᵀG)⁻¹`.
    Basis {
        k: usize,
        maps: Vec<f32>,
        p: Vec<f64>,
        x: Vec<f32>,
        w: Vec<f32>,
    },
    /// Ring of cell `i`: `ring_pix[ring_start[i]..ring_start[i+1]]`;
    /// `s[i] = Σ ã_i`; `q` row `i` = ring mean of every overlapping `ã_j`.
    Ring {
        ring_start: Vec<usize>,
        ring_pix: Vec<u32>,
        s: Vec<f32>,
        q: Csr,
    },
}

/// Ring model: the local level depends on the cell's own trace through its
/// column in the ring (its moat), which adds `−s_i q_ii` to the coordinate
/// curvature, so `mdiag_i = ã_iᵀã_i − s_i q_ii`.
///
/// When that is not positive, the cell's own column dominates its ring
/// level (a large filtered footprint whose moat fills a ring clipped by the
/// field-of-view edge): raising `c_i` lowers the level by more than the
/// cell's own light, the coordinate equation has the wrong sign, and the
/// projected SOR step runs away (halo_s5: traces of 1e37, then inf). The
/// ring cannot separate such a cell from its local level, so its level is
/// taken from the ring without the cell's own term (`q_ii = 0`, curvature
/// `ã_iᵀã_i`). Cells with a positive curvature are unchanged (floored at
/// 1e-3 `ã_iᵀã_i`, which only shortens their step).
pub(crate) fn ring_self_curvature(gram_diag: &[f32], s: &[f32], q: &mut Csr, mdiag: &mut [f32]) {
    for i in 0..gram_diag.len() {
        let (a, b) = (q.start[i], q.start[i + 1]);
        let Ok(k) = q.col[a..b].binary_search(&(i as u32)) else {
            continue;
        };
        let m = gram_diag[i] - s[i] * q.val[a + k];
        if m > 0.0 {
            mdiag[i] = m.max(1e-3 * gram_diag[i]);
        } else {
            q.val[a + k] = 0.0;
            mdiag[i] = gram_diag[i];
        }
    }
}

/// Bitwise equality of two `f32` slices (`==` would take `-0.0` for `0.0`).
fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

/// The pair terms [`Library::assemble`] may copy from the library it
/// rebuilds (`prev`): those of two cells that are both unchanged, under the
/// same frame, FOV, moat grid and background model. A cell is unchanged
/// when its support, column values (`vc`), moat blocks and values, support
/// centre and radius are bit for bit those of its slot in `prev`.
///
/// Why a copy is exact: an off-diagonal Gram term is computed from its two
/// columns only (and the FOV block counts), with the lower slot's column as
/// the image (`pair`), so it is copied only when the two cells keep their
/// order; a ring coupling `q[i][j]` from column `j` and the ring of cell
/// `i` (its centre and radius). An entry `prev` lacks is a term that was
/// exactly 0: `prev`'s neighbour search reached every pair whose columns
/// (or ring) can meet. The per-cell terms (diagonal, noise, ring self term,
/// which `ring_self_curvature` may have zeroed in `prev`) are always
/// computed.
struct PairReuse<'a> {
    prev: &'a Library,
    /// `prev` slot of each cell, `None` for a new or changed one.
    slot: Vec<Option<usize>>,
}

impl<'a> PairReuse<'a> {
    fn new(prev: &'a Library, core: &Core, model: &BackgroundModel) -> Option<PairReuse<'a>> {
        let pc = &prev.core;
        if pc.dims != core.dims
            || pc.block != core.block
            || pc.fov != core.fov
            || prev.model != *model
        {
            return None;
        }
        let slot: Vec<Option<usize>> = (0..core.ids.len())
            .map(|i| {
                let s = *pc.index_of.get(&core.ids[i])?;
                let (pa, va) = core.core_col(i);
                let (pb, vb) = pc.core_col(s);
                let (la, wa) = core.low(i);
                let (lb, wb) = pc.low(s);
                let (ca, cb) = (core.centers[i], pc.centers[s]);
                let same = pa == pb
                    && same_bits(va, vb)
                    && la == lb
                    && same_bits(wa, wb)
                    && same_bits(&[ca.0, ca.1, core.radii[i]], &[cb.0, cb.1, pc.radii[s]]);
                same.then_some(s)
            })
            .collect();
        slot.iter()
            .any(Option::is_some)
            .then_some(PairReuse { prev, slot })
    }

    /// `prev`'s slots of cells `i` and `j` when both are unchanged.
    fn slots(&self, i: usize, j: usize) -> Option<(usize, usize)> {
        Some((self.slot[i]?, self.slot[j]?))
    }

    /// The Gram term of cells `i < j`: `Some(term)` copied (`Some(None)`:
    /// it is 0), `None` to compute it.
    fn gram(&self, i: usize, j: usize) -> Option<Option<f32>> {
        let (a, b) = self.slots(i, j)?;
        if (a < b) != (i < j) {
            return None;
        }
        let (cols, vals) = self.prev.gram.row(a);
        Some(cols.binary_search(&(b as u32)).ok().map(|k| vals[k]))
    }

    /// The ring coupling `q[i][j]` (`i != j`), as [`PairReuse::gram`].
    fn ring(&self, i: usize, j: usize) -> Option<Option<f32>> {
        if i == j {
            return None;
        }
        let (a, b) = self.slots(i, j)?;
        let BgTerms::Ring { q, .. } = &self.prev.bg else {
            return None;
        };
        let (cols, vals) = q.row(a);
        Some(cols.binary_search(&(b as u32)).ok().map(|k| vals[k]))
    }
}

/// An immutable, versioned footprint library with the solver's precomputed
/// terms. Share it as `Arc<Library>`; build a new one to change it.
#[derive(Debug, Clone)]
pub struct Library {
    version: u64,
    core: Core,
    model: BackgroundModel,
    /// Off-diagonal Gram `ã_iᵀ ã_j` (supports that overlap).
    pub(crate) gram: Csr,
    /// `ã_iᵀ ã_i`.
    pub(crate) gram_diag: Vec<f32>,
    /// Effective coordinate curvature (Gram diagonal with the background
    /// eliminated).
    pub(crate) mdiag: Vec<f32>,
    /// Noise σ of each trace's coordinate estimate.
    pub(crate) trace_noise: Vec<f32>,
    pub(crate) groups: Vec<Vec<u32>>,
    pub(crate) group_of: Vec<u32>,
    pub(crate) bg: BgTerms,
}

impl Library {
    /// The solver's terms of `core`. With `prev` (the library this one
    /// rebuilds), the pair terms of unchanged cells are copied from it
    /// instead of computed again ([`PairReuse`]): the same values, bit for
    /// bit, at a fraction of the cost when a few cells changed (a slow-loop
    /// publish refines a handful of footprints out of hundreds).
    fn assemble(
        core: Core,
        model: BackgroundModel,
        version: u64,
        prev: Option<&Library>,
    ) -> Result<Library, TraceError> {
        let n = core.ids.len();
        let dims = core.dims;
        let n_px = dims.pixels();
        // Each column's extent: its support, or its moat blocks.
        let (bs, gwb) = (core.block, core.grid_w());
        let ext: Vec<f32> = (0..n)
            .map(|i| {
                let (cy, cx) = core.centers[i];
                core.low(i)
                    .0
                    .iter()
                    .map(|&bq| {
                        let (by, bx) = (bq as usize / gwb, bq as usize % gwb);
                        let (dy, dx) = (
                            ((by * bs) as f32 + 0.5 * bs as f32) - cy,
                            ((bx * bs) as f32 + 0.5 * bs as f32) - cx,
                        );
                        (dy * dy + dx * dx).sqrt() + 0.7072 * bs as f32
                    })
                    .fold(core.radii[i], f32::max)
            })
            .collect();
        // Candidate neighbours from a coarse spatial grid.
        let rmax = ext.iter().copied().fold(0.0f32, f32::max);
        let ring_outer = match &model {
            BackgroundModel::Ring { outer_px, .. } => *outer_px,
            _ => 0.0,
        };
        let reach = 2.0 * rmax + ring_outer + 2.0;
        let cell = reach.max(8.0);
        let gw = (dims.width as f32 / cell).ceil() as usize + 1;
        let gh = (dims.height as f32 / cell).ceil() as usize + 1;
        let mut grid: Vec<Vec<u32>> = vec![Vec::new(); gw * gh];
        let gpos = |c: (f32, f32)| {
            let gy = ((c.0.max(0.0) / cell) as usize).min(gh - 1);
            let gx = ((c.1.max(0.0) / cell) as usize).min(gw - 1);
            (gy, gx)
        };
        for (i, &c) in core.centers.iter().enumerate() {
            let (gy, gx) = gpos(c);
            grid[gy * gw + gx].push(i as u32);
        }
        let near = |i: usize, dist: f32| -> Vec<usize> {
            let (gy, gx) = gpos(core.centers[i]);
            let mut out = Vec::new();
            for yy in gy.saturating_sub(1)..(gy + 2).min(gh) {
                for xx in gx.saturating_sub(1)..(gx + 2).min(gw) {
                    for &j in &grid[yy * gw + xx] {
                        let j = j as usize;
                        let (a, b) = (core.centers[i], core.centers[j]);
                        let (dy, dx) = (a.0 - b.0, a.1 - b.1);
                        if dy * dy + dx * dx <= dist * dist {
                            out.push(j);
                        }
                    }
                }
            }
            out
        };

        let reuse = prev.and_then(|p| PairReuse::new(p, &core, &model));
        // Gram of the columns `vc_i 1_S − P low_i`:
        // `Σ_S∩S vc vc − Σ_S_j vc_j low_i(B) − Σ_B low_j ccore_i + Σ_B low_i low_j n_B`.
        let gl = core.grid_len();
        let mut img = vec![0.0f32; n_px];
        let mut lim = vec![0.0f32; gl];
        let mut ccore = vec![0.0f32; gl];
        let mut rows: Vec<Vec<(u32, f32)>> = vec![Vec::new(); n];
        let mut gram_diag = vec![0.0f32; n];
        let mut noise_num = vec![0.0f32; n];
        let pair = |j: usize, img: &[f32], lim: &[f32], ccore: &[f32]| -> f64 {
            let (pj, vj) = core.core_col(j);
            let mut g = 0.0f64;
            for (&q, &a) in pj.iter().zip(vj) {
                let mut t = img[q as usize];
                if gl > 0 {
                    t -= lim[core.block_of(q)];
                }
                g += f64::from(a) * f64::from(t);
            }
            let (bj, lj) = core.low(j);
            for (&bq, &l) in bj.iter().zip(lj) {
                let bq = bq as usize;
                g += f64::from(l)
                    * (f64::from(lim[bq]) * f64::from(core.blk_fov[bq]) - f64::from(ccore[bq]));
            }
            g
        };
        for i in 0..n {
            let (p, v) = core.core_col(i);
            for (&q, &a) in p.iter().zip(v) {
                img[q as usize] = a;
                if gl > 0 {
                    ccore[core.block_of(q)] += a;
                }
            }
            let (bi, li) = core.low(i);
            for (&bq, &l) in bi.iter().zip(li) {
                lim[bq as usize] = l;
            }
            gram_diag[i] = pair(i, &img, &lim, &ccore) as f32;
            // Noise of hᵀy: Σ h² σ² in the same representation.
            let mut s2 = 0.0f64;
            for (&q, &a) in p.iter().zip(v) {
                let sg = f64::from(core.noise[q as usize]);
                let mut h2 = f64::from(a) * f64::from(a);
                if gl > 0 {
                    let l = f64::from(lim[core.block_of(q)]);
                    h2 -= 2.0 * f64::from(a) * l;
                }
                s2 += h2 * sg * sg;
            }
            for (&bq, &l) in bi.iter().zip(li) {
                s2 += f64::from(l) * f64::from(l) * f64::from(core.blk_noise2[bq as usize]);
            }
            noise_num[i] = s2.max(0.0).sqrt() as f32;
            for j in near(i, ext[i] + rmax + 1.0) {
                if j <= i {
                    continue;
                }
                let g = match reuse.as_ref().and_then(|r| r.gram(i, j)) {
                    Some(Some(g)) => g,
                    Some(None) => continue,
                    None => {
                        let g = pair(j, &img, &lim, &ccore);
                        if g == 0.0 {
                            continue;
                        }
                        g as f32
                    }
                };
                rows[i].push((j as u32, g));
                rows[j].push((i as u32, g));
            }
            for &q in p {
                img[q as usize] = 0.0;
                if gl > 0 {
                    ccore[core.block_of(q)] = 0.0;
                }
            }
            for &bq in bi {
                lim[bq as usize] = 0.0;
            }
        }
        if let Some(i) = gram_diag.iter().position(|&d| d.is_nan() || d <= 0.0) {
            return Err(TraceError::InvalidFootprint(format!(
                "id {}: filtered footprint is zero on its support (outside the field of view?)",
                core.ids[i]
            )));
        }
        // Overlap groups (connected components of the coupling graph).
        let mut uf: Vec<usize> = (0..n).collect();
        fn find(uf: &mut [usize], mut a: usize) -> usize {
            while uf[a] != a {
                uf[a] = uf[uf[a]];
                a = uf[a];
            }
            a
        }
        let union = |uf: &mut Vec<usize>, a: usize, b: usize| {
            let (ra, rb) = (find(uf, a), find(uf, b));
            if ra != rb {
                uf[ra.max(rb)] = ra.min(rb);
            }
        };
        for (i, r) in rows.iter().enumerate() {
            for &(j, _) in r {
                union(&mut uf, i, j as usize);
            }
        }
        let gram = Csr::from_rows(rows);

        // Background terms.
        let mut bg = match &model {
            BackgroundModel::None => BgTerms::None,
            BackgroundModel::Basis(maps) => {
                let k = maps.len();
                if k == 0 {
                    BgTerms::None
                } else {
                    let mut flat = Vec::with_capacity(k * n_px);
                    for m in maps {
                        check_len("background map", n_px, m.len())?;
                        if m.iter().any(|v| !v.is_finite()) {
                            return Err(TraceError::InvalidConfig(
                                "background map must be finite".into(),
                            ));
                        }
                        flat.extend_from_slice(m);
                    }
                    let mut gtg = vec![0.0f64; k * k];
                    for a in 0..k {
                        for b in a..k {
                            let s: f64 = flat[a * n_px..(a + 1) * n_px]
                                .iter()
                                .zip(&flat[b * n_px..(b + 1) * n_px])
                                .map(|(&u, &v)| f64::from(u) * f64::from(v))
                                .sum();
                            gtg[a * k + b] = s;
                            gtg[b * k + a] = s;
                        }
                    }
                    let p = invert_spd(&gtg, k).ok_or_else(|| {
                        TraceError::InvalidConfig("background maps are linearly dependent".into())
                    })?;
                    // Block sums of each map (FOV only) for the moat term.
                    let mut msum = vec![0.0f64; k * gl];
                    if gl > 0 {
                        for b in 0..k {
                            let m = &flat[b * n_px..(b + 1) * n_px];
                            for q in 0..n_px {
                                if core.fov[q] != 0 {
                                    msum[b * gl + core.block_of(q as u32)] += f64::from(m[q]);
                                }
                            }
                        }
                    }
                    let mut x = vec![0.0f32; n * k];
                    for i in 0..n {
                        let (pp, v) = core.core_col(i);
                        let (bi, li) = core.low(i);
                        for b in 0..k {
                            let m = &flat[b * n_px..(b + 1) * n_px];
                            let mut s: f64 = pp
                                .iter()
                                .zip(v)
                                .map(|(&q, &a)| f64::from(a) * f64::from(m[q as usize]))
                                .sum();
                            for (&bq, &l) in bi.iter().zip(li) {
                                s -= f64::from(l) * msum[b * gl + bq as usize];
                            }
                            x[i * k + b] = s as f32;
                        }
                    }
                    let mut w = vec![0.0f32; n * k];
                    for i in 0..n {
                        for a in 0..k {
                            let s: f64 =
                                (0..k).map(|b| p[a * k + b] * f64::from(x[i * k + b])).sum();
                            w[i * k + a] = s as f32;
                        }
                    }
                    BgTerms::Basis {
                        k,
                        maps: flat,
                        p,
                        x,
                        w,
                    }
                }
            }
            BackgroundModel::Ring { inner_px, outer_px } => {
                if !(inner_px.is_finite() && outer_px.is_finite() && *outer_px > *inner_px) {
                    return Err(TraceError::InvalidConfig(format!(
                        "ring needs outer > inner (got {inner_px}, {outer_px})"
                    )));
                }
                let mut ring_start = vec![0usize];
                let mut ring_pix = Vec::new();
                let mut s = vec![0.0f32; n];
                let mut qrows: Vec<Vec<(u32, f32)>> = vec![Vec::new(); n];
                for i in 0..n {
                    // `s_i` is the sum of the whole column (support `vc` minus
                    // the moat's block means over their FOV pixels), the same
                    // column the projection uses.
                    s[i] = {
                        let sc: f32 = core.core_col(i).1.iter().sum();
                        let (bj, lj) = core.low(i);
                        let sm: f32 = bj
                            .iter()
                            .zip(lj)
                            .map(|(&bq, &l)| l * core.blk_fov[bq as usize])
                            .sum();
                        sc - sm
                    };
                    let (cy, cx) = core.centers[i];
                    let inner = inner_px.max(core.radii[i] + 1.0);
                    let outer = outer_px.max(inner + 2.0);
                    let y0 = (cy - outer).floor().max(0.0) as usize;
                    let y1 = ((cy + outer).ceil() as usize).min(dims.height - 1);
                    let x0 = (cx - outer).floor().max(0.0) as usize;
                    let x1 = ((cx + outer).ceil() as usize).min(dims.width - 1);
                    let start = ring_pix.len();
                    for y in y0..=y1 {
                        for x in x0..=x1 {
                            let (dy, dx) = (y as f32 - cy, x as f32 - cx);
                            let d2 = dy * dy + dx * dx;
                            let q = y * dims.width + x;
                            if d2 >= inner * inner && d2 <= outer * outer && core.fov[q] != 0 {
                                ring_pix.push(q as u32);
                            }
                        }
                    }
                    let len = ring_pix.len() - start;
                    ring_start.push(ring_pix.len());
                    if len == 0 {
                        continue;
                    }
                    let inv = 1.0 / len as f32;
                    for &q in &ring_pix[start..] {
                        img[q as usize] = inv;
                        if gl > 0 {
                            ccore[core.block_of(q)] += inv;
                        }
                    }
                    // Ring mean of every column that reaches the ring, the
                    // cell's own moat included.
                    for j in near(i, outer + rmax + 1.0) {
                        if let Some(copied) = reuse.as_ref().and_then(|r| r.ring(i, j)) {
                            if let Some(g) = copied {
                                qrows[i].push((j as u32, g));
                            }
                            continue;
                        }
                        let (pj, vj) = core.core_col(j);
                        let mut g = 0.0f32;
                        for (&q, &a) in pj.iter().zip(vj) {
                            g += a * img[q as usize];
                        }
                        let (bj, lj) = core.low(j);
                        for (&bq, &l) in bj.iter().zip(lj) {
                            g -= l * ccore[bq as usize];
                        }
                        if g != 0.0 {
                            qrows[i].push((j as u32, g));
                        }
                    }
                    for &q in &ring_pix[start..] {
                        img[q as usize] = 0.0;
                        if gl > 0 {
                            ccore[core.block_of(q)] = 0.0;
                        }
                    }
                }
                for (i, r) in qrows.iter().enumerate() {
                    for &(j, _) in r {
                        union(&mut uf, i, j as usize);
                    }
                }
                BgTerms::Ring {
                    ring_start,
                    ring_pix,
                    s,
                    q: Csr::from_rows(qrows),
                }
            }
        };
        let mut mdiag = gram_diag.clone();
        if let BgTerms::Ring { s, q, .. } = &mut bg {
            ring_self_curvature(&gram_diag, s, q, &mut mdiag);
        }
        if let BgTerms::Basis { k, x, w, .. } = &bg {
            for i in 0..n {
                let xw: f32 = (0..*k).map(|b| x[i * k + b] * w[i * k + b]).sum();
                // Guard: a footprint almost inside the background span.
                mdiag[i] = (gram_diag[i] - xw).max(1e-3 * gram_diag[i]);
            }
        }
        let trace_noise = (0..n).map(|i| noise_num[i] / mdiag[i]).collect();
        let mut root_group: HashMap<usize, u32> = HashMap::new();
        let mut groups: Vec<Vec<u32>> = Vec::new();
        let mut group_of = vec![0u32; n];
        for (i, g) in group_of.iter_mut().enumerate() {
            let r = find(&mut uf, i);
            let gi = *root_group.entry(r).or_insert_with(|| {
                groups.push(Vec::new());
                (groups.len() - 1) as u32
            });
            groups[gi as usize].push(i as u32);
            *g = gi;
        }
        Ok(Library {
            version,
            core,
            model,
            gram,
            gram_diag,
            mdiag,
            trace_noise,
            groups,
            group_of,
            bg,
        })
    }

    /// The same footprints with another background model (a new version).
    pub fn with_background(&self, model: BackgroundModel) -> Result<Library, TraceError> {
        Library::assemble(
            self.core.clone(),
            model,
            NEXT_VERSION.fetch_add(1, Ordering::Relaxed),
            None,
        )
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn dims(&self) -> Dims {
        self.core.dims
    }

    /// Number of cells.
    pub fn len(&self) -> usize {
        self.core.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.core.ids.is_empty()
    }

    /// Cell ids in slot order (traces are reported in this order).
    pub fn ids(&self) -> &[u64] {
        &self.core.ids
    }

    /// Slot of cell `id`.
    pub fn slot(&self, id: u64) -> Option<usize> {
        self.core.index_of.get(&id).copied()
    }

    /// Support centre `(y, x)` and radius of the cell in `slot`.
    pub fn support(&self, slot: usize) -> ((f32, f32), f32) {
        (self.core.centers[slot], self.core.radii[slot])
    }

    /// Pixel indices and filtered values of the cell in `slot`.
    pub fn filtered(&self, slot: usize) -> (&[u32], &[f32]) {
        self.core.column(slot)
    }

    /// The moat of the cell in `slot`: grid blocks (ascending, `by * gw +
    /// bx` with blocks of [`Library::block_px`]) and the block means of the
    /// low-pass `L a`. The cell's filtered column is [`Library::filtered`]
    /// on its support and `−L a` (block means) off it, out to these blocks.
    pub fn lowpass(&self, slot: usize) -> (&[u32], &[f32]) {
        self.core.low(slot)
    }

    /// The skirt of the cell in `slot`: grid blocks (ascending) and the
    /// measured block means its column carries outside the support (see
    /// [`LibraryBuilder::push_disk_skirt`]); empty without one.
    pub fn skirt(&self, slot: usize) -> (&[u32], &[f32]) {
        self.core.skirt(slot)
    }

    /// Side of the moat grid's blocks, px (0: no moat, unfiltered data).
    pub fn block_px(&self) -> usize {
        self.core.block
    }

    /// The moat grid: block of every frame pixel (`None` without a moat).
    pub(crate) fn block_of(&self, q: u32) -> usize {
        self.core.block_of(q)
    }

    pub(crate) fn grid_len(&self) -> usize {
        self.core.grid_len()
    }

    /// Support pixels and `val + low(B(p))` (the column is this on the
    /// support minus the block-constant moat everywhere).
    pub(crate) fn core_col(&self, slot: usize) -> (&[u32], &[f32]) {
        self.core.core_col(slot)
    }

    /// Pixel indices and unfiltered values of the cell in `slot`.
    pub fn unfiltered(&self, slot: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.core.col_start[slot], self.core.col_start[slot + 1]);
        (&self.core.pix[a..b], &self.core.raw[a..b])
    }

    /// Noise σ of each trace (its unit for thresholds), slot order.
    pub fn trace_noise(&self) -> &[f32] {
        &self.trace_noise
    }

    /// Overlap groups: slots of cells that share pixels (directly or through
    /// a chain of neighbours, or a ring).
    pub fn groups(&self) -> &[Vec<u32>] {
        &self.groups
    }

    pub fn background_model(&self) -> &BackgroundModel {
        &self.model
    }

    /// Number of per-frame background coefficients.
    pub fn background_len(&self) -> usize {
        match &self.bg {
            BgTerms::Basis { k, .. } => *k,
            BgTerms::Ring { ring_start, .. } => ring_start.len() - 1,
            BgTerms::None => 0,
        }
    }

    /// Model image `Σ ã_i c_i` (+ background `Σ g_k β_k` when `background` is
    /// given for a basis model) into `out`, which is overwritten.
    pub fn render(
        &self,
        traces: &[f32],
        background: Option<&[f32]>,
        out: &mut [f32],
    ) -> Result<(), TraceError> {
        let n_px = self.core.dims.pixels();
        check_len("traces", self.len(), traces.len())?;
        check_len("output frame", n_px, out.len())?;
        out.iter_mut().for_each(|v| *v = 0.0);
        if let (Some(beta), BgTerms::Basis { k, maps, .. }) = (background, &self.bg) {
            check_len("background coefficients", *k, beta.len())?;
            for (b, &bk) in beta.iter().enumerate() {
                for (o, &g) in out.iter_mut().zip(&maps[b * n_px..(b + 1) * n_px]) {
                    *o += g * bk;
                }
            }
        }
        let gl = self.core.grid_len();
        let mut field = vec![0.0f32; gl];
        let mut any = false;
        for (i, &c) in traces.iter().enumerate() {
            if c == 0.0 {
                continue;
            }
            let (p, v) = self.core.core_col(i);
            for (&q, &a) in p.iter().zip(v) {
                out[q as usize] += a * c;
            }
            let (bi, li) = self.core.low(i);
            for (&bq, &l) in bi.iter().zip(li) {
                field[bq as usize] += l * c;
                any = true;
            }
        }
        if any {
            let (w, b, gw) = (self.core.dims.width, self.core.block, self.core.grid_w());
            for (y, (row, mrow)) in out.chunks_mut(w).zip(self.core.fov.chunks(w)).enumerate() {
                let frow = &field[(y / b) * gw..(y / b + 1) * gw];
                for ((seg, mseg), &f) in row.chunks_mut(b).zip(mrow.chunks(b)).zip(frow) {
                    if f != 0.0 {
                        for (o, &m) in seg.iter_mut().zip(mseg) {
                            if m != 0 {
                                *o -= f;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Residual `y − Σ ã_i c_i` (minus the basis background `Σ g_k β_k` for a
    /// basis model) of one solved frame into `out`: what the model leaves
    /// unexplained, as cell discovery scores it (the ring model's per-cell
    /// local levels are not drawn, as in discovery). Pixels missing from the
    /// frame (non-finite) stay non-finite. For the app's residual view.
    pub fn residual(
        &self,
        frame: &[f32],
        traces: &FrameTraces,
        out: &mut [f32],
    ) -> Result<(), TraceError> {
        check_len("frame", self.core.dims.pixels(), frame.len())?;
        if traces.library_version != self.version() {
            return Err(TraceError::Incompatible(
                "traces do not come from this library".into(),
            ));
        }
        let bg = match self.model {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        self.render(&traces.traces, bg, out)?;
        for (o, &y) in out.iter_mut().zip(frame) {
            *o = y - *o;
        }
        Ok(())
    }

    pub(crate) fn fov(&self) -> &[u8] {
        &self.core.fov
    }

    /// Add `Σ coef · column` of the listed `(slot, coef)` pairs into `out`
    /// (the same representation [`Library::render`] draws: exact on each
    /// support, the moat as block means over FOV pixels), without clearing
    /// it. Returns the touched pixel box `(y0, y1, x0, x1)`, end-exclusive
    /// (empty when nothing was drawn). For evaluation code that needs the
    /// model change of a few cells (`examples/qc_eval.rs`, the held-out
    /// score) without rendering a whole frame.
    pub fn add_columns(
        &self,
        coefs: &[(usize, f32)],
        out: &mut [f32],
    ) -> Result<(usize, usize, usize, usize), TraceError> {
        let dims = self.core.dims;
        check_len("output frame", dims.pixels(), out.len())?;
        let w = dims.width;
        let (mut y0, mut y1, mut x0, mut x1) = (usize::MAX, 0usize, usize::MAX, 0usize);
        let mut field: Vec<(u32, f32)> = Vec::new();
        for &(i, c) in coefs {
            if i >= self.len() {
                return Err(TraceError::Incompatible(format!(
                    "slot {i} of a {}-cell library",
                    self.len()
                )));
            }
            if c == 0.0 {
                continue;
            }
            let (p, v) = self.core.core_col(i);
            for (&q, &a) in p.iter().zip(v) {
                out[q as usize] += a * c;
                let (y, x) = (q as usize / w, q as usize % w);
                (y0, y1, x0, x1) = (y0.min(y), y1.max(y + 1), x0.min(x), x1.max(x + 1));
            }
            let (bi, li) = self.core.low(i);
            field.extend(bi.iter().zip(li).map(|(&b, &l)| (b, l * c)));
        }
        if !field.is_empty() {
            field.sort_unstable_by_key(|f| f.0);
            let (b, gw) = (self.core.block, self.core.grid_w());
            let mut k = 0;
            while k < field.len() {
                let blk = field[k].0;
                let mut f = 0.0f32;
                while k < field.len() && field[k].0 == blk {
                    f += field[k].1;
                    k += 1;
                }
                let (by, bx) = (blk as usize / gw, blk as usize % gw);
                let (ya, yb) = (by * b, ((by + 1) * b).min(dims.height));
                let (xa, xb) = (bx * b, ((bx + 1) * b).min(w));
                for y in ya..yb {
                    for x in xa..xb {
                        if self.core.fov[y * w + x] != 0 {
                            out[y * w + x] -= f;
                        }
                    }
                }
                (y0, y1, x0, x1) = (y0.min(ya), y1.max(yb), x0.min(xa), x1.max(xb));
            }
        }
        if y0 == usize::MAX {
            return Ok((0, 0, 0, 0));
        }
        Ok((y0, y1, x0, x1))
    }
}

/// Magic of [`Library::to_bytes`]: the footprints and the solver's
/// precomputed terms.
const LIBRARY_MAGIC: &[u8; 8] = b"CALALIB3";
/// [`LIBRARY_MAGIC`] with the cells' skirts (written only when a cell has
/// one, so a library without skirts keeps the old bytes).
const LIBRARY_SKIRT_MAGIC: &[u8; 8] = b"CALALIB4";
/// Magic of the footprints-only layout (no precomputed terms), which
/// [`Library::from_bytes`] still reads (and assembles).
pub(crate) const CORE_MAGIC: &[u8; 8] = b"CALALIB2";

/// Little-endian reader over a byte buffer, for [`Library::from_bytes`].
struct ByteReader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl ByteReader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], TraceError> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&e| e <= self.buf.len())
            .ok_or_else(|| TraceError::InvalidConfig("library bytes: truncated".into()))?;
        let s = &self.buf[self.at..end];
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, TraceError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, TraceError> {
        let lo = u64::from(self.u32()?);
        let hi = u64::from(self.u32()?);
        Ok(lo | (hi << 32))
    }

    fn f32(&mut self) -> Result<f32, TraceError> {
        Ok(f32::from_bits(self.u32()?))
    }

    fn u32s(&mut self, n: usize) -> Result<Vec<u32>, TraceError> {
        let len = n
            .checked_mul(4)
            .ok_or_else(|| TraceError::InvalidConfig("library bytes: length overflow".into()))?;
        Ok(self
            .take(len)?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }

    fn f32s(&mut self, n: usize) -> Result<Vec<f32>, TraceError> {
        Ok(self.u32s(n)?.into_iter().map(f32::from_bits).collect())
    }

    /// `n + 1` ascending offsets from 0 (the last is the total).
    fn offsets(&mut self, n: usize) -> Result<Vec<usize>, TraceError> {
        let len = n
            .checked_add(1)
            .ok_or_else(|| bytes_err("length overflow"))?;
        let s: Vec<usize> = self.u32s(len)?.into_iter().map(|v| v as usize).collect();
        if s[0] != 0 || s.windows(2).any(|w| w[0] > w[1]) {
            return Err(bytes_err("offsets"));
        }
        Ok(s)
    }

    /// A [`Csr`] of `n` rows whose columns are below `cols`.
    fn csr(&mut self, n: usize, cols: usize) -> Result<Csr, TraceError> {
        let start = self.offsets(n)?;
        let nnz = start[n];
        let col = self.u32s(nnz)?;
        if col.iter().any(|&c| c as usize >= cols) {
            return Err(bytes_err("matrix column out of range"));
        }
        let val = self.f32s(nnz)?;
        Ok(Csr { start, col, val })
    }
}

fn bytes_err(m: &str) -> TraceError {
    TraceError::InvalidConfig(format!("library bytes: {m}"))
}

fn put_csr(out: &mut Vec<u8>, m: &Csr) {
    put_u32s(out, m.start.iter().map(|&v| v as u32));
    put_u32s(out, m.col.iter().copied());
    put_f32s(out, &m.val);
}

fn put_u32s(out: &mut Vec<u8>, v: impl IntoIterator<Item = u32>) {
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
}

fn put_f32s(out: &mut Vec<u8>, v: &[f32]) {
    put_u32s(out, v.iter().map(|x| x.to_bits()));
}

/// Serialization, to hand a library from one worker to another (the slow
/// loop publishes, the fast loop solves) without filtering the footprints
/// again.
impl Library {
    /// The library as bytes: version, frame size, background model, and per
    /// cell its id, support centre and radius, support pixels with filtered
    /// and unfiltered values; then the FOV mask and the noise map; then the
    /// solver's precomputed terms (Gram, curvatures, trace noise, overlap
    /// groups, background terms). [`Library::from_bytes`] takes those terms
    /// as they are, so installing a library costs a copy rather than a
    /// rebuild (the fast loop installs one between frames, and a rebuild
    /// grows faster than the cell count), and the copy solves
    /// bit-identically.
    pub fn to_bytes(&self) -> Vec<u8> {
        let magic = if self.core.skirt_blk.is_empty() {
            LIBRARY_MAGIC
        } else {
            LIBRARY_SKIRT_MAGIC
        };
        let mut out = self.core_bytes(magic);
        put_csr(&mut out, &self.gram);
        put_f32s(&mut out, &self.gram_diag);
        put_f32s(&mut out, &self.mdiag);
        put_f32s(&mut out, &self.trace_noise);
        put_u32s(&mut out, self.group_of.iter().copied());
        match &self.bg {
            BgTerms::None => put_u32s(&mut out, [0]),
            BgTerms::Basis { k, p, x, w, .. } => {
                put_u32s(&mut out, [1, *k as u32]);
                put_u32s(
                    &mut out,
                    p.iter()
                        .flat_map(|v| [v.to_bits() as u32, (v.to_bits() >> 32) as u32]),
                );
                put_f32s(&mut out, x);
                put_f32s(&mut out, w);
            }
            BgTerms::Ring {
                ring_start,
                ring_pix,
                s,
                q,
            } => {
                put_u32s(&mut out, [2]);
                put_u32s(&mut out, ring_start.iter().map(|&v| v as u32));
                put_u32s(&mut out, ring_pix.iter().copied());
                put_f32s(&mut out, s);
                put_csr(&mut out, q);
            }
        }
        out
    }

    /// The footprints-only layout under `magic`: [`Library::from_bytes`]
    /// rebuilds the precomputed terms of a [`CORE_MAGIC`] buffer.
    pub(crate) fn core_bytes(&self, magic: &[u8; 8]) -> Vec<u8> {
        let c = &self.core;
        let n = c.ids.len();
        let nnz = c.pix.len();
        let mut out = Vec::with_capacity(64 + n * 24 + nnz * 12 + c.fov.len() * 5);
        out.extend_from_slice(magic);
        put_u32s(
            &mut out,
            [
                self.version as u32,
                (self.version >> 32) as u32,
                c.dims.width as u32,
                c.dims.height as u32,
                n as u32,
                nnz as u32,
            ],
        );
        match &self.model {
            BackgroundModel::None => put_u32s(&mut out, [0]),
            BackgroundModel::Ring { inner_px, outer_px } => {
                put_u32s(&mut out, [1, inner_px.to_bits(), outer_px.to_bits()])
            }
            BackgroundModel::Basis(maps) => {
                put_u32s(&mut out, [2, maps.len() as u32]);
                for m in maps {
                    put_f32s(&mut out, m);
                }
            }
        }
        put_u32s(
            &mut out,
            c.ids.iter().flat_map(|&id| [id as u32, (id >> 32) as u32]),
        );
        for &(y, x) in &c.centers {
            put_f32s(&mut out, &[y, x]);
        }
        put_f32s(&mut out, &c.radii);
        put_u32s(&mut out, c.col_start.iter().map(|&v| v as u32));
        put_u32s(&mut out, c.pix.iter().copied());
        put_f32s(&mut out, &c.val);
        put_f32s(&mut out, &c.raw);
        out.extend_from_slice(&c.fov);
        put_f32s(&mut out, &c.noise);
        put_u32s(&mut out, [c.block as u32, c.low_blk.len() as u32]);
        put_u32s(&mut out, c.low_start.iter().map(|&v| v as u32));
        put_u32s(&mut out, c.low_blk.iter().copied());
        put_f32s(&mut out, &c.low_val);
        if magic == LIBRARY_SKIRT_MAGIC {
            put_u32s(&mut out, [c.skirt_blk.len() as u32]);
            put_u32s(&mut out, c.skirt_start.iter().map(|&v| v as u32));
            put_u32s(&mut out, c.skirt_blk.iter().copied());
            put_f32s(&mut out, &c.skirt_val);
        }
        out
    }

    /// Inverse of [`Library::to_bytes`] (keeps the version number). Also
    /// reads the footprints-only layout, whose precomputed terms it
    /// rebuilds.
    pub fn from_bytes(bytes: &[u8]) -> Result<Library, TraceError> {
        let bad = bytes_err;
        let mut r = ByteReader { buf: bytes, at: 0 };
        let magic = r.take(8)?;
        let (with_terms, with_skirt) = if magic == LIBRARY_MAGIC {
            (true, false)
        } else if magic == LIBRARY_SKIRT_MAGIC {
            (true, true)
        } else if magic == CORE_MAGIC {
            (false, false)
        } else {
            return Err(bad("not a cala library"));
        };
        let version = r.u64()?;
        let width = r.u32()? as usize;
        let height = r.u32()? as usize;
        let dims = Dims::new(width, height).map_err(|e| bad(&e.to_string()))?;
        let n_px = dims.pixels();
        let n = r.u32()? as usize;
        let nnz = r.u32()? as usize;
        let model = match r.u32()? {
            0 => BackgroundModel::None,
            1 => BackgroundModel::Ring {
                inner_px: r.f32()?,
                outer_px: r.f32()?,
            },
            2 => {
                let k = r.u32()? as usize;
                let mut maps = Vec::with_capacity(k.min(64));
                for _ in 0..k {
                    maps.push(r.f32s(n_px)?);
                }
                BackgroundModel::Basis(maps)
            }
            _ => return Err(bad("unknown background model")),
        };
        let ids: Vec<u64> = r
            .u32s(n.checked_mul(2).ok_or_else(|| bad("cell count"))?)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u64::from(p[0]) | (u64::from(p[1]) << 32))
            .collect();
        let centers: Vec<(f32, f32)> = r
            .f32s(2 * n)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| (p[0], p[1]))
            .collect();
        let radii = r.f32s(n)?;
        let col_start: Vec<usize> = r.u32s(n + 1)?.into_iter().map(|v| v as usize).collect();
        if col_start[0] != 0 || col_start[n] != nnz || col_start.windows(2).any(|w| w[0] > w[1]) {
            return Err(bad("support offsets"));
        }
        let pix = r.u32s(nnz)?;
        if pix.iter().any(|&p| p as usize >= n_px) {
            return Err(bad("support pixel outside the frame"));
        }
        let val = r.f32s(nnz)?;
        let raw = r.f32s(nnz)?;
        let fov = r.take(n_px)?.to_vec();
        let noise = r.f32s(n_px)?;
        let block = r.u32()? as usize;
        let nlow = r.u32()? as usize;
        let low_start: Vec<usize> = r.u32s(n + 1)?.into_iter().map(|v| v as usize).collect();
        if low_start[0] != 0
            || low_start[n] != nlow
            || low_start.windows(2).any(|w| w[0] > w[1])
            || (block == 0 && nlow != 0)
        {
            return Err(bad("moat offsets"));
        }
        let low_blk = r.u32s(nlow)?;
        let low_val = r.f32s(nlow)?;
        if block > 0 {
            let gl = dims.width.div_ceil(block) * dims.height.div_ceil(block);
            if low_blk.iter().any(|&b| b as usize >= gl) {
                return Err(bad("moat block outside the grid"));
            }
        }
        let (skirt_start, skirt_blk, skirt_val) = if with_skirt {
            let ns = r.u32()? as usize;
            let start: Vec<usize> = r.u32s(n + 1)?.into_iter().map(|v| v as usize).collect();
            if start[0] != 0 || start[n] != ns || start.windows(2).any(|w| w[0] > w[1]) {
                return Err(bad("skirt offsets"));
            }
            let blk = r.u32s(ns)?;
            let val = r.f32s(ns)?;
            if val.iter().any(|v| !v.is_finite()) {
                return Err(bad("non-finite values"));
            }
            for i in 0..n {
                let (a, z) = (start[i], start[i + 1]);
                let (la, lz) = (low_start[i], low_start[i + 1]);
                if blk[a..z].windows(2).any(|w| w[0] >= w[1])
                    || blk[a..z]
                        .iter()
                        .any(|b| low_blk[la..lz].binary_search(b).is_err())
                {
                    return Err(bad("skirt block outside the moat"));
                }
            }
            (start, blk, val)
        } else {
            (vec![0; n + 1], Vec::new(), Vec::new())
        };
        let terms = if with_terms {
            Some(Terms::read(&mut r, n, n_px, &model)?)
        } else {
            None
        };
        if r.at != bytes.len() {
            return Err(bad("trailing bytes"));
        }
        if val
            .iter()
            .chain(&raw)
            .chain(&noise)
            .chain(&low_val)
            .any(|v| !v.is_finite())
        {
            return Err(bad("non-finite values"));
        }
        let mut index_of = HashMap::with_capacity(n);
        for (i, &id) in ids.iter().enumerate() {
            if index_of.insert(id, i).is_some() {
                return Err(TraceError::InvalidFootprint(format!("duplicate id {id}")));
            }
        }
        let core = Core {
            dims,
            ids,
            index_of,
            centers,
            radii,
            col_start,
            pix,
            val,
            raw,
            fov,
            noise,
            block,
            low_start,
            low_blk,
            low_val,
            skirt_start,
            skirt_blk,
            skirt_val,
            vc: Vec::new(),
            blk_fov: Vec::new(),
            blk_noise2: Vec::new(),
        };
        let Some(t) = terms else {
            return Library::assemble(core.finish(), model, version, None);
        };
        // The overlap groups, numbered in order of their first cell, as
        // `assemble` numbers them.
        let mut groups: Vec<Vec<u32>> = Vec::new();
        for (i, &g) in t.group_of.iter().enumerate() {
            let g = g as usize;
            if g == groups.len() {
                groups.push(Vec::new());
            } else if g > groups.len() {
                return Err(bad("group numbering"));
            }
            groups[g].push(i as u32);
        }
        let bg = match t.bg {
            BgRead::None => BgTerms::None,
            BgRead::Basis { k, p, x, w } => BgTerms::Basis {
                k,
                maps: match &model {
                    BackgroundModel::Basis(maps) => maps.concat(),
                    _ => unreachable!("Terms::read checks the model"),
                },
                p,
                x,
                w,
            },
            BgRead::Ring(ring) => ring,
        };
        Ok(Library {
            version,
            core: core.finish(),
            model,
            gram: t.gram,
            gram_diag: t.gram_diag,
            mdiag: t.mdiag,
            trace_noise: t.trace_noise,
            groups,
            group_of: t.group_of,
            bg,
        })
    }
}

/// The precomputed terms of a [`Library::to_bytes`] buffer.
struct Terms {
    gram: Csr,
    gram_diag: Vec<f32>,
    mdiag: Vec<f32>,
    trace_noise: Vec<f32>,
    group_of: Vec<u32>,
    bg: BgRead,
}

/// Background terms as read (the basis maps come from the model).
enum BgRead {
    None,
    Basis {
        k: usize,
        p: Vec<f64>,
        x: Vec<f32>,
        w: Vec<f32>,
    },
    Ring(BgTerms),
}

impl Terms {
    /// Read the terms of an `n`-cell library of `n_px` pixels with
    /// background `model` (which they must match).
    fn read(
        r: &mut ByteReader,
        n: usize,
        n_px: usize,
        model: &BackgroundModel,
    ) -> Result<Terms, TraceError> {
        let gram = r.csr(n, n)?;
        let gram_diag = r.f32s(n)?;
        let mdiag = r.f32s(n)?;
        let trace_noise = r.f32s(n)?;
        let group_of = r.u32s(n)?;
        let bg = match (r.u32()?, model) {
            (0, BackgroundModel::None) => BgRead::None,
            (0, BackgroundModel::Basis(maps)) if maps.is_empty() => BgRead::None,
            (1, BackgroundModel::Basis(maps)) => {
                let k = r.u32()? as usize;
                if k == 0 || k != maps.len() {
                    return Err(bytes_err("background terms"));
                }
                let p = r
                    .u32s(2 * k * k)?
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|h| f64::from_bits(u64::from(h[0]) | (u64::from(h[1]) << 32)))
                    .collect();
                let nk = n
                    .checked_mul(k)
                    .ok_or_else(|| bytes_err("length overflow"))?;
                let x = r.f32s(nk)?;
                let w = r.f32s(nk)?;
                BgRead::Basis { k, p, x, w }
            }
            (2, BackgroundModel::Ring { .. }) => {
                let ring_start = r.offsets(n)?;
                let ring_pix = r.u32s(ring_start[n])?;
                if ring_pix.iter().any(|&q| q as usize >= n_px) {
                    return Err(bytes_err("ring pixel outside the frame"));
                }
                let s = r.f32s(n)?;
                let q = r.csr(n, n)?;
                BgRead::Ring(BgTerms::Ring {
                    ring_start,
                    ring_pix,
                    s,
                    q,
                })
            }
            _ => return Err(bytes_err("background terms do not match the model")),
        };
        Ok(Terms {
            gram,
            gram_diag,
            mdiag,
            trace_noise,
            group_of,
            bg,
        })
    }
}

impl Core {
    #[inline]
    fn column(&self, i: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.col_start[i], self.col_start[i + 1]);
        (&self.pix[a..b], &self.val[a..b])
    }

    /// Support pixels and `vc` values of cell `i`.
    #[inline]
    fn core_col(&self, i: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.col_start[i], self.col_start[i + 1]);
        (&self.pix[a..b], &self.vc[a..b])
    }

    #[inline]
    fn low(&self, i: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.low_start[i], self.low_start[i + 1]);
        (&self.low_blk[a..b], &self.low_val[a..b])
    }

    #[inline]
    fn skirt(&self, i: usize) -> (&[u32], &[f32]) {
        let (a, b) = (self.skirt_start[i], self.skirt_start[i + 1]);
        (&self.skirt_blk[a..b], &self.skirt_val[a..b])
    }

    /// Moat grid width (blocks per row); 0 without a moat.
    fn grid_w(&self) -> usize {
        if self.block == 0 {
            0
        } else {
            self.dims.width.div_ceil(self.block)
        }
    }

    fn grid_len(&self) -> usize {
        if self.block == 0 {
            0
        } else {
            self.grid_w() * self.dims.height.div_ceil(self.block)
        }
    }

    /// Grid block of frame pixel `q`.
    #[inline]
    fn block_of(&self, q: u32) -> usize {
        let (y, x) = (q as usize / self.dims.width, q as usize % self.dims.width);
        (y / self.block) * self.grid_w() + x / self.block
    }

    /// Fill the derived terms.
    fn finish(mut self) -> Core {
        let gl = self.grid_len();
        self.blk_fov = vec![0.0; gl];
        self.blk_noise2 = vec![0.0; gl];
        if self.block > 0 {
            for q in 0..self.dims.pixels() {
                if self.fov[q] != 0 {
                    let bq = self.block_of(q as u32);
                    self.blk_fov[bq] += 1.0;
                    self.blk_noise2[bq] += self.noise[q] * self.noise[q];
                }
            }
        }
        self.vc = self.val.clone();
        if self.block > 0 {
            for i in 0..self.ids.len() {
                let (la, lz) = (self.low_start[i], self.low_start[i + 1]);
                for k in self.col_start[i]..self.col_start[i + 1] {
                    // Outside the FOV the column is 0 (the filtered data is).
                    if self.fov[self.pix[k] as usize] == 0 {
                        continue;
                    }
                    let bq = self.block_of(self.pix[k]) as u32;
                    if let Ok(j) = self.low_blk[la..lz].binary_search(&bq) {
                        self.vc[k] += self.low_val[la + j];
                    }
                }
            }
        }
        self
    }
}

/// Inverse of a small symmetric positive-definite matrix (Gauss-Jordan with
/// partial pivoting), `None` when it is singular to working precision.
pub(crate) fn invert_spd(a: &[f64], k: usize) -> Option<Vec<f64>> {
    let mut m = a.to_vec();
    let mut inv = vec![0.0f64; k * k];
    for i in 0..k {
        inv[i * k + i] = 1.0;
    }
    let scale = (0..k).map(|i| a[i * k + i].abs()).fold(0.0f64, f64::max);
    for col in 0..k {
        let piv =
            (col..k).max_by(|&r, &s| m[r * k + col].abs().total_cmp(&m[s * k + col].abs()))?;
        let pv = m[piv * k + col].abs();
        if pv.is_nan() || pv <= 1e-12 * scale {
            return None;
        }
        if piv != col {
            for c in 0..k {
                m.swap(piv * k + c, col * k + c);
                inv.swap(piv * k + c, col * k + c);
            }
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
