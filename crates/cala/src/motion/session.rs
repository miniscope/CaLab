//! Session-level alignment: where a new recording session sits relative to
//! the previous one, as one similarity transform (rotation + translation).
//!
//! The per-frame corrector ([`super::MotionCorrector`]) searches a rigid
//! shift of ±`max_shift` (15 px) around the previous frame's shift and does
//! not model rotation. Between two sessions of one animal the scope is
//! taken off and put back: the tissue can move by more than the search
//! window and turn by a degree or more. On stitched two-session sims
//! (`tools/cala-eval/results/2026-11-13-session-boundary.md`) a 1° rotation
//! cost P8 .95 → .80 and doubled the adds, because neither the rigid shift
//! nor the 4 x 4 patch field absorbs a rotation (up to 5 px at the edge).
//!
//! So at a session boundary the new session's first frames are registered
//! once to a reference in the run's registered coordinates, over a wide
//! translation range and a range of rotations ([`estimate`]), and the
//! resulting transform is applied to every frame of that session before the
//! per-frame corrector ([`SessionWarp`]). The corrector then sees frames
//! that are already within a fraction of a pixel of its template and works
//! as within a session.
//!
//! # Reference
//!
//! The reference is the mean of the previous session's last registered
//! frames (the corrector's output, before the background stage): it is in
//! the coordinates every later stage works in (the corrector pins its
//! template to them), it covers the whole frame (the corrector's template
//! covers only its registration region, too small for a wide search), and it
//! is recent, so slow changes within the previous session (bleaching, drift)
//! are already in it.
//!
//! # Method
//!
//! Both images are band-passed with the corrector's difference of Gaussians
//! (σ 1.5 and 15 px: cell texture, without the glow and without pixel
//! noise). For each rotation on a grid (`rotation_step_deg` over
//! ±`max_rotation_deg`, about the frame centre) the moving image is rotated,
//! band-passed and cross-correlated with the reference over the largest
//! square inside the FOV (at most `roi_max_side`), searching ±`max_shift`
//! px. The best rotation is refined by a parabola through its neighbours.
//!
//! # When the transform is applied
//!
//! A warp interpolates, which blurs a little; it is applied only when it
//! does something the per-frame corrector cannot:
//!
//! * a rotation of at least `min_rotation_deg` (a 0.1° rotation moves the
//!   frame edge by 0.5 px at 300 px radius) that removes at least
//!   `min_rotation_gain` of the unrotated fit's decorrelation `1 − ncc` (a
//!   rotation the data do not ask for still raises the peak a little: on a
//!   64 x 48 test movie with no rotation, 0.28° gave ncc .9633 against
//!   .9630);
//! * otherwise a translation beyond `min_translation_px`, rounded to whole
//!   pixels (an integer shift is an exact copy; the corrector finds the
//!   sub-pixel rest, as it does within a session).
//!
//! Anything smaller is left to the corrector: the transform is the identity
//! and the session's frames are not touched.

use super::fft2d::fft_friendly_size;
use super::filter::{difference_of_gaussians, DogScratch};
use super::warp::{cubic_weights, Interpolation, SourceMask};
use super::xcorr::Correlator;
use super::MotionError;

/// A session-level similarity transform (scale 1).
///
/// `out(p) = frame(c + R(θ) (p − t − c))`, `c` the frame centre: rotate by
/// `rotation_deg` about the centre, then shift by `t = (dy, dx)`. With no
/// rotation this is the corrector's convention, `out(p) = frame(p − t)`
/// (a shift registers the frame onto the reference; the content moved by
/// `−t`), so a translation-only transform composes with a frame's rigid
/// shift `s` to the total shift `s + t`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionTransform {
    pub rotation_deg: f32,
    pub dy: f32,
    pub dx: f32,
}

impl SessionTransform {
    pub const IDENTITY: SessionTransform = SessionTransform {
        rotation_deg: 0.0,
        dy: 0.0,
        dx: 0.0,
    };

    pub fn is_identity(&self) -> bool {
        self.rotation_deg == 0.0 && self.dy == 0.0 && self.dx == 0.0
    }

    /// No rotation: the transform is a shift.
    pub fn is_translation(&self) -> bool {
        self.rotation_deg == 0.0
    }

    /// As `[rotation_deg, dy, dx]`.
    pub fn to_array(&self) -> [f32; 3] {
        [self.rotation_deg, self.dy, self.dx]
    }

    pub fn from_array(v: [f32; 3]) -> Result<SessionTransform, MotionError> {
        if v.iter().any(|x| !x.is_finite()) {
            return Err(MotionError::InvalidRecord(
                "non-finite session transform".into(),
            ));
        }
        Ok(SessionTransform {
            rotation_deg: v[0],
            dy: v[1],
            dx: v[2],
        })
    }
}

/// Settings for [`estimate`].
#[derive(Debug, Clone, PartialEq)]
pub struct SessionAlignConfig {
    /// Largest translation searched, px (default 40).
    pub max_shift: f32,
    /// Largest rotation searched, degrees (default 3).
    pub max_rotation_deg: f32,
    /// Rotation grid step, degrees (default 0.5).
    pub rotation_step_deg: f32,
    /// A smaller rotation is not applied (default 0.1°).
    pub min_rotation_deg: f32,
    /// Share of the unrotated fit's `1 − ncc` a rotation must remove to be
    /// applied (default 0.1).
    pub min_rotation_gain: f32,
    /// Without a rotation, a translation within this (px, either axis) is
    /// left to the per-frame corrector (default 10, inside its ±15 search).
    pub min_translation_px: f32,
    /// Side cap of the correlation square (default 384, as the corrector).
    pub roi_max_side: usize,
    /// Band-pass σ, px (defaults 1.5 and 15, as the corrector).
    pub dog_sigma_small: f32,
    pub dog_sigma_large: f32,
}

impl Default for SessionAlignConfig {
    fn default() -> Self {
        SessionAlignConfig {
            max_shift: 40.0,
            max_rotation_deg: 3.0,
            rotation_step_deg: 0.5,
            min_rotation_deg: 0.1,
            min_rotation_gain: 0.1,
            min_translation_px: 10.0,
            roi_max_side: 384,
            dog_sigma_small: 1.5,
            dog_sigma_large: 15.0,
        }
    }
}

/// What [`estimate`] found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionEstimate {
    /// The transform to apply (the identity when the corrector can manage).
    pub transform: SessionTransform,
    /// The best fit before the apply rule (rotation, shift).
    pub fitted: SessionTransform,
    /// Correlation of the best fit, and of the best unrotated shift.
    pub ncc: f32,
    pub ncc_unrotated: f32,
}

/// Resampling of whole frames by one [`SessionTransform`] (bicubic,
/// replicated borders, as the corrector's warp).
#[derive(Debug, Clone)]
pub struct SessionWarp {
    h: usize,
    w: usize,
    t: SessionTransform,
    /// Integer translation: the warp is an exact copy.
    integer: Option<(isize, isize)>,
}

impl SessionWarp {
    pub fn new(h: usize, w: usize, t: SessionTransform) -> Result<SessionWarp, MotionError> {
        if h == 0 || w == 0 {
            return Err(MotionError::InvalidConfig("empty frame".into()));
        }
        SessionTransform::from_array(t.to_array())?;
        let integer = (t.rotation_deg == 0.0 && t.dy.fract() == 0.0 && t.dx.fract() == 0.0)
            .then_some((t.dy as isize, t.dx as isize));
        Ok(SessionWarp { h, w, t, integer })
    }

    pub fn transform(&self) -> SessionTransform {
        self.t
    }

    /// Source coordinates of output pixel `(y, x)`.
    #[inline]
    fn source(&self, cos: f64, sin: f64, y: usize, x: usize) -> (f32, f32) {
        let cy = (self.h as f64 - 1.0) / 2.0;
        let cx = (self.w as f64 - 1.0) / 2.0;
        let py = y as f64 - f64::from(self.t.dy) - cy;
        let px = x as f64 - f64::from(self.t.dx) - cx;
        let sy = cy + cos * py + sin * px;
        let sx = cx - sin * py + cos * px;
        (sy as f32, sx as f32)
    }

    fn trig(&self) -> (f64, f64) {
        let a = f64::from(self.t.rotation_deg).to_radians();
        (a.cos(), a.sin())
    }

    /// Warp one `h x w` frame from `src` into `out`.
    pub fn apply(&self, src: &[f32], out: &mut [f32]) -> Result<(), MotionError> {
        let (h, w) = (self.h, self.w);
        if src.len() != h * w || out.len() != h * w {
            return Err(MotionError::SizeMismatch("session warp frame size".into()));
        }
        let (hi, wi) = (h as isize, w as isize);
        if let Some((dy, dx)) = self.integer {
            for y in 0..h {
                let sy = (y as isize - dy).clamp(0, hi - 1) as usize;
                let row = &src[sy * w..][..w];
                for (x, o) in out[y * w..][..w].iter_mut().enumerate() {
                    *o = row[(x as isize - dx).clamp(0, wi - 1) as usize];
                }
            }
            return Ok(());
        }
        let (cos, sin) = self.trig();
        for y in 0..h {
            for x in 0..w {
                let (sy, sx) = self.source(cos, sin, y, x);
                let fy = sy.floor();
                let fx = sx.floor();
                let wy = cubic_weights(sy - fy);
                let wx = cubic_weights(sx - fx);
                let (iy, ix) = (fy as isize, fx as isize);
                let mut acc = 0.0f32;
                for (a, &wya) in wy.iter().enumerate() {
                    let yy = (iy + a as isize - 1).clamp(0, hi - 1) as usize;
                    let row = &src[yy * w..][..w];
                    let mut r = 0.0f32;
                    for (b, &wxb) in wx.iter().enumerate() {
                        let xx = (ix + b as isize - 1).clamp(0, wi - 1) as usize;
                        r += wxb * row[xx];
                    }
                    acc += wya * r;
                }
                out[y * w + x] = acc;
            }
        }
        Ok(())
    }

    /// Warp `count` frames in place (`scratch` is one frame).
    pub fn apply_in_place(
        &self,
        frames: &mut [f32],
        scratch: &mut Vec<f32>,
    ) -> Result<(), MotionError> {
        let px = self.h * self.w;
        if !frames.len().is_multiple_of(px) {
            return Err(MotionError::SizeMismatch("session warp batch size".into()));
        }
        scratch.resize(px, 0.0);
        for f in frames.chunks_exact_mut(px) {
            scratch.copy_from_slice(f);
            self.apply(scratch, f)?;
        }
        Ok(())
    }

    /// Which pixels of a warped frame hold data: 1 where every bicubic tap
    /// lies inside `mask` (the sensor FOV mask) and the frame. This is the
    /// source mask for the per-frame corrector's validity
    /// ([`SourceMask::fill_rigid`]) on the warped frames.
    pub fn source_mask(&self, mask: &[u8]) -> Result<Vec<u8>, MotionError> {
        let (h, w) = (self.h, self.w);
        let src = SourceMask::new(h, w, mask, Interpolation::Bicubic)?;
        let (cos, sin) = self.trig();
        let mut out = vec![0u8; h * w];
        for y in 0..h {
            for x in 0..w {
                let (sy, sx) = match self.integer {
                    Some((dy, dx)) => ((y as isize - dy) as f32, (x as isize - dx) as f32),
                    None => self.source(cos, sin, y, x),
                };
                out[y * w + x] = src.at(sy, sx);
            }
        }
        Ok(out)
    }
}

/// The largest square inside the FOV around its centroid, side capped at
/// `max_side` and made FFT-friendly: `(y0, x0, side)`.
fn fov_square(mask: &[u8], h: usize, w: usize, max_side: usize) -> Option<(usize, usize, usize)> {
    // Prefix sums of the mask for O(1) "all inside" checks.
    let mut ps = vec![0u32; (h + 1) * (w + 1)];
    let (mut sy, mut sx, mut n) = (0.0f64, 0.0f64, 0.0f64);
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            let m = u32::from(mask[y * w + x] != 0);
            row += m;
            ps[(y + 1) * (w + 1) + x + 1] = ps[y * (w + 1) + x + 1] + row;
            if m != 0 {
                sy += y as f64;
                sx += x as f64;
                n += 1.0;
            }
        }
    }
    if n == 0.0 {
        return None;
    }
    let (cy, cx) = ((sy / n).round() as isize, (sx / n).round() as isize);
    let inside = |y0: isize, x0: isize, s: isize| -> bool {
        if y0 < 0 || x0 < 0 || y0 + s > h as isize || x0 + s > w as isize {
            return false;
        }
        let (y0, x0, s) = (y0 as usize, x0 as usize, s as usize);
        let at = |y: usize, x: usize| ps[y * (w + 1) + x];
        let sum = at(y0 + s, x0 + s) + at(y0, x0) - at(y0, x0 + s) - at(y0 + s, x0);
        sum as usize == s * s
    };
    let mut best = 0usize;
    let cap = max_side.min(h).min(w);
    let mut s = 8usize;
    while s <= cap && inside(cy - s as isize / 2, cx - s as isize / 2, s as isize) {
        best = s;
        s += 8;
    }
    if best < 32 {
        return None;
    }
    let side = fft_friendly_size(best);
    Some((
        (cy - side as isize / 2) as usize,
        (cx - side as isize / 2) as usize,
        side,
    ))
}

/// Band-passes whole frames and cuts the correlation square out of them.
struct BandCrop {
    h: usize,
    w: usize,
    sq: (usize, usize, usize),
    s1: f32,
    s2: f32,
    full: Vec<f32>,
    scratch: DogScratch,
}

impl BandCrop {
    /// Band-pass `img` and copy the square out of it into `out`.
    fn run(&mut self, img: &[f32], out: &mut [f32]) {
        let (h, w) = (self.h, self.w);
        self.full.resize(h * w, 0.0);
        difference_of_gaussians(
            img,
            h,
            w,
            self.s1,
            self.s2,
            &mut self.full,
            &mut self.scratch,
        );
        let (y0, x0, s) = self.sq;
        for y in 0..s {
            out[y * s..][..s].copy_from_slice(&self.full[(y0 + y) * w + x0..][..s]);
        }
    }
}

/// Register `moving` (the mean of the new session's first frames, front
/// half output, sensor coordinates) onto `reference` (the mean of the
/// previous session's last registered frames). Both are `h x w`; `fov` is
/// the sensor FOV mask. See the module docs.
pub fn estimate(
    reference: &[f32],
    moving: &[f32],
    h: usize,
    w: usize,
    fov: &[u8],
    cfg: &SessionAlignConfig,
) -> Result<SessionEstimate, MotionError> {
    let px = h * w;
    if reference.len() != px || moving.len() != px || fov.len() != px {
        return Err(MotionError::SizeMismatch(
            "session estimate image size".into(),
        ));
    }
    if !(cfg.max_shift > 0.0 && cfg.max_rotation_deg >= 0.0 && cfg.rotation_step_deg > 0.0) {
        return Err(MotionError::InvalidConfig(
            "session alignment ranges".into(),
        ));
    }
    let clean = |v: &[f32]| -> Vec<f32> {
        v.iter()
            .map(|&x| if x.is_finite() { x } else { 0.0 })
            .collect()
    };
    let (reference, moving) = (clean(reference), clean(moving));
    let identity = SessionEstimate {
        transform: SessionTransform::IDENTITY,
        fitted: SessionTransform::IDENTITY,
        ncc: 0.0,
        ncc_unrotated: 0.0,
    };
    let Some(sq) = fov_square(fov, h, w, cfg.roi_max_side) else {
        return Ok(identity);
    };
    let side = sq.2;
    let mut corr = Correlator::new(side, side, 0.3)?;
    let mut band = BandCrop {
        h,
        w,
        sq,
        s1: cfg.dog_sigma_small,
        s2: cfg.dog_sigma_large,
        full: Vec::new(),
        scratch: DogScratch::default(),
    };
    let mut crop = vec![0.0f32; side * side];
    band.run(&reference, &mut crop);
    let mut ref_spec = corr.make_spectrum();
    let e_ref = corr.spectrum(&crop, &mut ref_spec)?;
    let mut mov_spec = corr.make_spectrum();
    let mut rotated = vec![0.0f32; px];
    let max_shift = cfg.max_shift.min(side as f32 / 4.0);
    // (ncc, dy, dx) at rotation `deg`.
    let mut score = |deg: f32| -> Result<(f32, f32, f32), MotionError> {
        let src = if deg == 0.0 {
            &moving
        } else {
            let t = SessionTransform {
                rotation_deg: deg,
                dy: 0.0,
                dx: 0.0,
            };
            SessionWarp::new(h, w, t)?.apply(&moving, &mut rotated)?;
            &rotated
        };
        band.run(src, &mut crop);
        let e = corr.spectrum(&crop, &mut mov_spec)?;
        let p = corr.register(&ref_spec, e_ref, &mov_spec, e, max_shift, 10)?;
        Ok((p.ncc, p.dy, p.dx))
    };
    let n = (cfg.max_rotation_deg / cfg.rotation_step_deg).floor() as i32;
    let mut grid: Vec<(f32, (f32, f32, f32))> = Vec::new();
    for k in -n..=n {
        let deg = k as f32 * cfg.rotation_step_deg;
        grid.push((deg, score(deg)?));
    }
    let unrot = grid[n as usize].1;
    let (bi, &(bdeg, bres)) = grid
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1 .0.total_cmp(&b.1 .1 .0))
        .expect("the grid has the zero rotation");
    // Parabolic refinement of the rotation through the neighbours.
    let (mut deg, mut res) = (bdeg, bres);
    if bi > 0 && bi + 1 < grid.len() {
        let (l, c, r) = (grid[bi - 1].1 .0, bres.0, grid[bi + 1].1 .0);
        let den = l - 2.0 * c + r;
        if den < 0.0 {
            let off = (0.5 * (l - r) / den).clamp(-0.5, 0.5);
            let d2 = bdeg + off * cfg.rotation_step_deg;
            if off != 0.0 {
                let r2 = score(d2)?;
                if r2.0 >= bres.0 {
                    deg = d2;
                    res = r2;
                }
            }
        }
    }
    let fitted = SessionTransform {
        rotation_deg: deg,
        dy: res.1,
        dx: res.2,
    };
    let gain = (res.0 - unrot.0) / (1.0 - unrot.0).max(1e-6);
    let transform = if deg.abs() >= cfg.min_rotation_deg && gain >= cfg.min_rotation_gain {
        fitted
    } else if unrot.1.abs() > cfg.min_translation_px || unrot.2.abs() > cfg.min_translation_px {
        SessionTransform {
            rotation_deg: 0.0,
            dy: unrot.1.round(),
            dx: unrot.2.round(),
        }
    } else {
        SessionTransform::IDENTITY
    };
    Ok(SessionEstimate {
        transform,
        fitted,
        ncc: res.0,
        ncc_unrotated: unrot.0,
    })
}

/// Running sum of registered frames: the reference for [`estimate`].
#[derive(Debug, Clone, Default)]
pub struct ReferenceMean {
    sum: Vec<f64>,
    frames: u32,
}

impl ReferenceMean {
    pub fn new() -> ReferenceMean {
        ReferenceMean::default()
    }

    /// Add `frames` (whole `px`-pixel frames).
    pub fn push(&mut self, frames: &[f32], px: usize) {
        if px == 0 {
            return;
        }
        if self.sum.len() != px {
            self.sum = vec![0.0; px];
            self.frames = 0;
        }
        for f in frames.chunks_exact(px) {
            for (s, &v) in self.sum.iter_mut().zip(f) {
                *s += if v.is_finite() { f64::from(v) } else { 0.0 };
            }
            self.frames += 1;
        }
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }

    /// The mean, or `None` before any frame.
    pub fn mean(&self) -> Option<Vec<f32>> {
        (self.frames > 0).then(|| {
            let k = 1.0 / f64::from(self.frames);
            self.sum.iter().map(|&s| (s * k) as f32).collect()
        })
    }

    pub fn clear(&mut self) {
        self.sum.clear();
        self.frames = 0;
    }
}

/// Mean of `count` frames of `px` pixels.
pub fn frames_mean(frames: &[f32], px: usize) -> Vec<f32> {
    let mut m = ReferenceMean::new();
    m.push(frames, px);
    m.mean().unwrap_or_else(|| vec![0.0; px])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smooth random texture (cell-sized blobs) on a flat field.
    fn texture(h: usize, w: usize, seed: u64) -> Vec<f32> {
        let mut s = seed;
        let mut rnd = || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (s >> 33) as f32 / (1u64 << 31) as f32
        };
        let mut img = vec![0.0f32; h * w];
        for _ in 0..(h * w / 120) {
            let (cy, cx, a) = (rnd() * h as f32, rnd() * w as f32, 5.0 + 10.0 * rnd());
            let r = 3.0;
            let (y0, y1) = ((cy - 9.0).max(0.0) as usize, ((cy + 9.0) as usize).min(h));
            let (x0, x1) = ((cx - 9.0).max(0.0) as usize, ((cx + 9.0) as usize).min(w));
            for y in y0..y1 {
                for x in x0..x1 {
                    let d2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                    img[y * w + x] += a * (-d2 / (2.0 * r * r)).exp();
                }
            }
        }
        img
    }

    #[test]
    fn recovers_rotation_and_large_shift() {
        let (h, w) = (256, 256);
        let reference = texture(h, w, 7);
        let fov = vec![1u8; h * w];
        let truth = SessionTransform {
            rotation_deg: 1.2,
            dy: 22.0,
            dx: -27.0,
        };
        // The new session sees the tissue moved: the inverse warp of the
        // reference. Build it by warping with the inverse transform.
        let inv = inverse(truth, h, w);
        let mut moving = vec![0.0; h * w];
        SessionWarp::new(h, w, inv)
            .unwrap()
            .apply(&reference, &mut moving)
            .unwrap();
        let cfg = SessionAlignConfig {
            roi_max_side: 128,
            ..SessionAlignConfig::default()
        };
        let est = estimate(&reference, &moving, h, w, &fov, &cfg).unwrap();
        let t = est.transform;
        assert!((t.rotation_deg - 1.2).abs() < 0.1, "{est:?}");
        assert!(
            (t.dy - 22.0).abs() < 0.6 && (t.dx + 27.0).abs() < 0.6,
            "{est:?}"
        );
        assert!(est.ncc > est.ncc_unrotated);
        // Warping the moving image by the estimate lands it on the reference.
        let mut back = vec![0.0; h * w];
        SessionWarp::new(h, w, t)
            .unwrap()
            .apply(&moving, &mut back)
            .unwrap();
        let mut err = 0.0f64;
        let mut n = 0.0f64;
        for y in 70..186 {
            for x in 70..186 {
                err += f64::from((back[y * w + x] - reference[y * w + x]).abs());
                n += 1.0;
            }
        }
        let scale = reference.iter().map(|v| f64::from(v.abs())).sum::<f64>() / (h * w) as f64;
        assert!(err / n < 0.25 * scale, "residual {} vs {}", err / n, scale);
    }

    /// The transform `u` with `warp(warp(x, t), u) = x` (centre-rotation).
    fn inverse(t: SessionTransform, h: usize, w: usize) -> SessionTransform {
        // out(p) = f(c + R(p − t − c)); invert: f(q) = out(R⁻¹(q − c) + c + t),
        // i.e. rotation −θ then shift −R⁻¹ t … as a transform of our form:
        // g(p) = f(c + R(−θ)(p − u − c)) with u = −R(θ)·t.
        let a = f64::from(t.rotation_deg).to_radians();
        let (c, s) = (a.cos(), a.sin());
        let (ty, tx) = (f64::from(t.dy), f64::from(t.dx));
        let _ = (h, w);
        SessionTransform {
            rotation_deg: -t.rotation_deg,
            dy: (-(c * ty + s * tx)) as f32,
            dx: (-(-s * ty + c * tx)) as f32,
        }
    }

    #[test]
    fn small_moves_are_left_to_the_corrector_and_integer_shifts_are_exact() {
        let (h, w) = (192, 192);
        let reference = texture(h, w, 3);
        let fov = vec![1u8; h * w];
        let cfg = SessionAlignConfig {
            roi_max_side: 128,
            ..SessionAlignConfig::default()
        };
        // 4 px: identity. 18 px: integer shift.
        for (shift, expect) in [(4.0f32, 0.0f32), (18.0, 18.0)] {
            let t = SessionTransform {
                rotation_deg: 0.0,
                dy: -shift,
                dx: 0.0,
            };
            let mut moving = vec![0.0; h * w];
            SessionWarp::new(h, w, t)
                .unwrap()
                .apply(&reference, &mut moving)
                .unwrap();
            let est = estimate(&reference, &moving, h, w, &fov, &cfg).unwrap();
            assert_eq!(est.transform.rotation_deg, 0.0, "{est:?}");
            assert_eq!(est.transform.dy, expect, "{est:?}");
            assert_eq!(est.transform.dx, 0.0, "{est:?}");
        }
        // An integer warp is a copy, and its source mask is the shifted mask.
        let t = SessionTransform {
            rotation_deg: 0.0,
            dy: 3.0,
            dx: -2.0,
        };
        let wp = SessionWarp::new(h, w, t).unwrap();
        let mut out = vec![0.0; h * w];
        wp.apply(&reference, &mut out).unwrap();
        assert_eq!(out[50 * w + 50], reference[47 * w + 52]);
        let m = wp.source_mask(&fov).unwrap();
        assert_eq!(m[0], 0);
        assert_eq!(m[3 * w + 10], 1);
        assert_eq!(m[2 * w + 10], 0);
        assert_eq!(m[10 * w + w - 3], 1);
        assert_eq!(m[10 * w + w - 2], 0);
    }

    #[test]
    fn rotated_source_mask_marks_the_corners_missing() {
        let (h, w) = (100, 100);
        let fov = vec![1u8; h * w];
        let t = SessionTransform {
            rotation_deg: 2.0,
            dy: 0.0,
            dx: 0.0,
        };
        let m = SessionWarp::new(h, w, t)
            .unwrap()
            .source_mask(&fov)
            .unwrap();
        assert_eq!(m[0], 0);
        assert_eq!(m[50 * w + 50], 1);
        assert!(m.iter().filter(|&&v| v == 0).count() > 4 * 50);
    }
}
