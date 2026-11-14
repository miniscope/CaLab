//! One-pass resampling of a frame by a rigid shift plus a smooth non-rigid
//! displacement field.
//!
//! A record's displacement at output pixel `p` is
//! `s(p) = rigid + sum_ij By_i(y) Bx_j(x) R_ij`, where `R` is the small grid of
//! residual (non-rigid) patch shifts and `By`, `Bx` are natural cubic spline
//! basis functions over the patch-centre rows and columns (exact at the
//! centres, C2 between them, held constant beyond the outermost centres; the
//! same interpolant minisim uses for its ground-truth field). The corrected
//! frame is `out(p) = frame(p - s(p))`, sampled once, so rigid and non-rigid
//! correction do not compound interpolation blur.
//!
//! Sampling is bicubic (Catmull-Rom, Keys `a = -0.5`) or bilinear, with
//! replicated borders. Bilinear is a smoothing filter whose strength depends
//! on the fractional shift (a half-pixel shift averages two pixels and halves
//! the noise variance per axis), so it makes noise level and sharpness vary
//! from frame to frame with the motion; bicubic is close to interpolating and
//! keeps both nearly uniform, which matters for the noise-based stages
//! downstream. A rigid-only record takes a separable path (two 1-D passes with
//! constant weights), several times cheaper than the per-pixel general path.
//!
//! The optional validity mask marks output pixels whose source position lies
//! inside the frame (1) versus ones filled by border replication (0).

use super::MotionError;

/// Resampling kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interpolation {
    Bilinear,
    Bicubic,
}

/// Natural cubic spline basis: a `coords.len() x nodes.len()` row-major
/// matrix `M` with `M[c][j]` the weight of node `j` at `coords[c]`, so the
/// spline through node values `v` is `M v`. Coordinates are clamped to the
/// node span. Nodes must be strictly increasing.
pub fn natural_spline_matrix(nodes: &[f64], coords: &[f64]) -> Vec<f64> {
    let n = nodes.len();
    let mut out = vec![0.0; coords.len() * n];
    if n == 0 {
        return out;
    }
    if n == 1 {
        out.iter_mut().for_each(|v| *v = 1.0);
        return out;
    }
    // Second derivatives of the spline through each unit vector e_j.
    let mut m2 = vec![0.0; n * n];
    for j in 0..n {
        let y: Vec<f64> = (0..n).map(|i| if i == j { 1.0 } else { 0.0 }).collect();
        let m = second_derivatives(nodes, &y);
        for i in 0..n {
            m2[j * n + i] = m[i];
        }
    }
    for (c, &x0) in coords.iter().enumerate() {
        let x = x0.clamp(nodes[0], nodes[n - 1]);
        let mut i = 0;
        while i + 2 < n && x > nodes[i + 1] {
            i += 1;
        }
        let hseg = nodes[i + 1] - nodes[i];
        let a = (nodes[i + 1] - x) / hseg;
        let b = (x - nodes[i]) / hseg;
        for j in 0..n {
            let yi = if i == j { 1.0 } else { 0.0 };
            let yi1 = if i + 1 == j { 1.0 } else { 0.0 };
            let mi = m2[j * n + i];
            let mi1 = m2[j * n + i + 1];
            out[c * n + j] = a * yi
                + b * yi1
                + ((a * a * a - a) * mi + (b * b * b - b) * mi1) * hseg * hseg / 6.0;
        }
    }
    out
}

/// Second derivatives of the natural cubic spline through `(t, y)`.
fn second_derivatives(t: &[f64], y: &[f64]) -> Vec<f64> {
    let n = t.len();
    let mut m = vec![0.0; n];
    if n < 3 {
        return m;
    }
    // Thomas algorithm on the interior equations.
    let k = n - 2;
    let mut diag = vec![0.0; k];
    let mut upper = vec![0.0; k];
    let mut rhs = vec![0.0; k];
    for r in 0..k {
        let i = r + 1;
        let h0 = t[i] - t[i - 1];
        let h1 = t[i + 1] - t[i];
        diag[r] = 2.0 * (h0 + h1);
        upper[r] = h1;
        rhs[r] = 6.0 * ((y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0);
        if r > 0 {
            let lower = h0;
            let f = lower / diag[r - 1];
            diag[r] -= f * upper[r - 1];
            rhs[r] -= f * rhs[r - 1];
        }
    }
    for r in (0..k).rev() {
        let next = if r + 1 < k { m[r + 2] } else { 0.0 };
        m[r + 1] = (rhs[r] - upper[r] * next) / diag[r];
    }
    m
}

/// Catmull-Rom weights for taps at offsets -1, 0, 1, 2 and fraction `t`.
#[inline]
pub(crate) fn cubic_weights(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

/// Frame geometry and spline bases for warping by motion records.
#[derive(Clone)]
pub struct Warper {
    h: usize,
    w: usize,
    gy: usize,
    gx: usize,
    /// `h x gy` spline basis over the node rows (empty when rigid-only).
    by: Vec<f32>,
    /// `w x gx` spline basis over the node columns.
    bx: Vec<f32>,
    interp: Interpolation,
    tmp: Vec<f32>,
    row_coef: Vec<f32>,
}

impl Warper {
    /// Warper for `h x w` frames with a residual grid at node rows `node_ys`
    /// and columns `node_xs` (frame pixel coordinates; both empty for a
    /// rigid-only corrector).
    pub fn new(
        h: usize,
        w: usize,
        node_ys: &[f64],
        node_xs: &[f64],
        interp: Interpolation,
    ) -> Result<Self, MotionError> {
        if h == 0 || w == 0 {
            return Err(MotionError::InvalidConfig("empty frame".into()));
        }
        if node_ys.is_empty() != node_xs.is_empty() {
            return Err(MotionError::InvalidConfig(
                "node rows and columns must both be given or both be empty".into(),
            ));
        }
        for nodes in [node_ys, node_xs] {
            if nodes.windows(2).any(|p| p[1] <= p[0]) || nodes.iter().any(|v| !v.is_finite()) {
                return Err(MotionError::InvalidConfig(
                    "node coordinates must be finite and strictly increasing".into(),
                ));
            }
        }
        let ys: Vec<f64> = (0..h).map(|v| v as f64).collect();
        let xs: Vec<f64> = (0..w).map(|v| v as f64).collect();
        let to32 = |v: Vec<f64>| v.into_iter().map(|x| x as f32).collect::<Vec<f32>>();
        Ok(Warper {
            h,
            w,
            gy: node_ys.len(),
            gx: node_xs.len(),
            by: to32(natural_spline_matrix(node_ys, &ys)),
            bx: to32(natural_spline_matrix(node_xs, &xs)),
            interp,
            tmp: vec![0.0; h * w],
            row_coef: vec![0.0; 2 * node_xs.len()],
        })
    }

    pub fn interpolation(&self) -> Interpolation {
        self.interp
    }

    /// Number of residual values a record carries, `2 * gy * gx`.
    pub fn residual_len(&self) -> usize {
        2 * self.gy * self.gx
    }

    /// Total `(dy, dx)` displacement of a record at pixel `(y, x)`.
    pub fn displacement_at(
        &self,
        rigid: (f32, f32),
        residual: &[f32],
        y: usize,
        x: usize,
    ) -> (f32, f32) {
        let (mut dy, mut dx) = rigid;
        if self.gy > 0 && residual.len() == self.residual_len() {
            for i in 0..self.gy {
                let wy = self.by[y.min(self.h - 1) * self.gy + i];
                for j in 0..self.gx {
                    let wxy = wy * self.bx[x.min(self.w - 1) * self.gx + j];
                    dy += wxy * residual[(i * self.gx + j) * 2];
                    dx += wxy * residual[(i * self.gx + j) * 2 + 1];
                }
            }
        }
        (dy, dx)
    }

    /// Write `src` warped by `rigid` and `residual` into `out`, and the
    /// validity mask into `mask` when given. `residual` is empty or
    /// [`residual_len`](Self::residual_len) long; all-zero residuals take the
    /// rigid path.
    pub fn warp(
        &mut self,
        src: &[f32],
        rigid: (f32, f32),
        residual: &[f32],
        out: &mut [f32],
        mask: Option<&mut [u8]>,
    ) -> Result<(), MotionError> {
        let n = self.h * self.w;
        if src.len() != n || out.len() != n {
            return Err(MotionError::SizeMismatch(format!(
                "warp buffers hold {} and {} pixels, frame has {n}",
                src.len(),
                out.len()
            )));
        }
        if !residual.is_empty() && residual.len() != self.residual_len() {
            return Err(MotionError::SizeMismatch(format!(
                "record has {} residual values, expected {}",
                residual.len(),
                self.residual_len()
            )));
        }
        if !rigid.0.is_finite() || !rigid.1.is_finite() || residual.iter().any(|v| !v.is_finite()) {
            return Err(MotionError::InvalidRecord("non-finite shift".into()));
        }
        if let Some(m) = &mask {
            if m.len() != n {
                return Err(MotionError::SizeMismatch("mask size".into()));
            }
        }
        if residual.iter().all(|&v| v == 0.0) {
            self.warp_rigid(src, rigid, out);
        } else {
            self.warp_field(src, rigid, residual, out);
        }
        if let Some(m) = mask {
            self.fill_mask(rigid, residual, m);
        }
        Ok(())
    }

    fn warp_rigid(&mut self, src: &[f32], (dy, dx): (f32, f32), out: &mut [f32]) {
        let (h, w) = (self.h as isize, self.w as isize);
        // Source coordinate = p - s = p + base + t, t in [0, 1).
        let by = (-dy).floor();
        let bx = (-dx).floor();
        let (ty, tx) = (-dy - by, -dx - bx);
        let (by, bx) = (by as isize, bx as isize);
        let (taps, wy, wx): (std::ops::Range<isize>, [f32; 4], [f32; 4]) = match self.interp {
            Interpolation::Bicubic => (-1..3, cubic_weights(ty), cubic_weights(tx)),
            Interpolation::Bilinear => (0..2, [1.0 - ty, ty, 0.0, 0.0], [1.0 - tx, tx, 0.0, 0.0]),
        };
        let first = taps.start;
        // Vertical pass into tmp.
        for y in 0..h {
            let dst = &mut self.tmp[(y * w) as usize..][..w as usize];
            dst.fill(0.0);
            for a in taps.clone() {
                let sy = (y + by + a).clamp(0, h - 1) as usize;
                let wt = wy[(a - first) as usize];
                let row = &src[sy * w as usize..][..w as usize];
                for (d, &v) in dst.iter_mut().zip(row) {
                    *d += wt * v;
                }
            }
        }
        // Horizontal pass into out.
        let ntap = taps.len() as isize;
        let x_lo = (-(bx + first)).clamp(0, w);
        let x_hi = (w - (bx + first + ntap - 1)).clamp(x_lo, w);
        for y in 0..h as usize {
            let row = &self.tmp[y * w as usize..][..w as usize];
            let dst = &mut out[y * w as usize..][..w as usize];
            let sample = |x: isize| -> f32 {
                let mut acc = 0.0;
                for a in taps.clone() {
                    let sx = (x + bx + a).clamp(0, w - 1) as usize;
                    acc += wx[(a - first) as usize] * row[sx];
                }
                acc
            };
            for x in 0..x_lo {
                dst[x as usize] = sample(x);
            }
            // Interior: no clamping needed.
            for x in x_lo..x_hi {
                let s0 = (x + bx + first) as usize;
                let seg = &row[s0..s0 + ntap as usize];
                dst[x as usize] = seg.iter().zip(&wx).map(|(a, b)| a * b).sum();
            }
            for x in x_hi..w {
                dst[x as usize] = sample(x);
            }
        }
    }

    fn row_coefficients(&mut self, residual: &[f32], y: usize) {
        let (gy, gx) = (self.gy, self.gx);
        self.row_coef.fill(0.0);
        for i in 0..gy {
            let wy = self.by[y * gy + i];
            for j in 0..gx {
                self.row_coef[2 * j] += wy * residual[(i * gx + j) * 2];
                self.row_coef[2 * j + 1] += wy * residual[(i * gx + j) * 2 + 1];
            }
        }
    }

    fn warp_field(&mut self, src: &[f32], (ry, rx): (f32, f32), residual: &[f32], out: &mut [f32]) {
        let (h, w, gx) = (self.h, self.w, self.gx);
        let (hi, wi) = (h as isize, w as isize);
        for y in 0..h {
            self.row_coefficients(residual, y);
            for x in 0..w {
                let bxr = &self.bx[x * gx..][..gx];
                let mut dy = ry;
                let mut dx = rx;
                for (j, &b) in bxr.iter().enumerate() {
                    dy += b * self.row_coef[2 * j];
                    dx += b * self.row_coef[2 * j + 1];
                }
                let sy = y as f32 - dy;
                let sx = x as f32 - dx;
                let fy = sy.floor();
                let fx = sx.floor();
                let (ty, tx) = (sy - fy, sx - fx);
                let (iy, ix) = (fy as isize, fx as isize);
                out[y * w + x] = match self.interp {
                    Interpolation::Bicubic => {
                        let wy = cubic_weights(ty);
                        let wx = cubic_weights(tx);
                        let mut acc = 0.0;
                        for (a, &wya) in wy.iter().enumerate() {
                            let yy = (iy + a as isize - 1).clamp(0, hi - 1) as usize;
                            let row = &src[yy * w..][..w];
                            let mut r = 0.0;
                            for (b, &wxb) in wx.iter().enumerate() {
                                let xx = (ix + b as isize - 1).clamp(0, wi - 1) as usize;
                                r += wxb * row[xx];
                            }
                            acc += wya * r;
                        }
                        acc
                    }
                    Interpolation::Bilinear => {
                        let y0 = iy.clamp(0, hi - 1) as usize;
                        let y1 = (iy + 1).clamp(0, hi - 1) as usize;
                        let x0 = ix.clamp(0, wi - 1) as usize;
                        let x1 = (ix + 1).clamp(0, wi - 1) as usize;
                        let top = src[y0 * w + x0] * (1.0 - tx) + src[y0 * w + x1] * tx;
                        let bot = src[y1 * w + x0] * (1.0 - tx) + src[y1 * w + x1] * tx;
                        top * (1.0 - ty) + bot * ty
                    }
                };
            }
        }
    }

    /// Validity mask of a record alone (1 = source inside the frame).
    pub fn validity_mask(
        &self,
        rigid: (f32, f32),
        residual: &[f32],
        mask: &mut [u8],
    ) -> Result<(), MotionError> {
        if mask.len() != self.h * self.w {
            return Err(MotionError::SizeMismatch("mask size".into()));
        }
        if !residual.is_empty() && residual.len() != self.residual_len() {
            return Err(MotionError::SizeMismatch("record residual length".into()));
        }
        let mut copy = self.clone();
        copy.fill_mask(rigid, residual, mask);
        Ok(())
    }

    /// Validity of a frame warped by `rigid` and `residual` (see
    /// [`SourceMask`]): 1 where the output pixel was sampled only from
    /// inside `src`. An all-zero residual takes [`SourceMask::fill_rigid`].
    pub fn fill_validity(
        &mut self,
        rigid: (f32, f32),
        residual: &[f32],
        src: &SourceMask,
        out: &mut [u8],
    ) -> Result<(), MotionError> {
        let (h, w, gx) = (self.h, self.w, self.gx);
        if out.len() != h * w || src.h != h || src.w != w {
            return Err(MotionError::SizeMismatch("validity size".into()));
        }
        if !residual.is_empty() && residual.len() != self.residual_len() {
            return Err(MotionError::SizeMismatch("record residual length".into()));
        }
        if !rigid.0.is_finite() || !rigid.1.is_finite() || residual.iter().any(|v| !v.is_finite()) {
            return Err(MotionError::InvalidRecord("non-finite shift".into()));
        }
        if residual.iter().all(|&v| v == 0.0) {
            return src.fill_rigid(rigid, out);
        }
        // Only pixels whose rigid source lies within reach of the field of
        // the mask's edge need the field: a natural spline through the patch
        // shifts stays within twice their largest (generously; it is held
        // constant past the outer centres), plus one pixel for rounding.
        let reach = 2.0 * residual.iter().fold(0.0f32, |m, v| m.max(v.abs())) + 2.0;
        let reach = reach.min(f32::from(u16::MAX - 1)) as u16;
        let (by, bx) = ((-rigid.0).round() as isize, (-rigid.1).round() as isize);
        for y in 0..h {
            let sy = y as isize + by;
            let mut coef_row = None;
            for x in 0..w {
                let sx = x as isize + bx;
                let deep = sy >= 0
                    && sx >= 0
                    && sy < h as isize
                    && sx < w as isize
                    && src.depth[sy as usize * w + sx as usize] > reach;
                if deep {
                    out[y * w + x] = 1;
                    continue;
                }
                if coef_row != Some(y) {
                    self.row_coefficients(residual, y);
                    coef_row = Some(y);
                }
                let (mut dy, mut dx) = rigid;
                for j in 0..gx {
                    let b = self.bx[x * gx + j];
                    dy += b * self.row_coef[2 * j];
                    dx += b * self.row_coef[2 * j + 1];
                }
                out[y * w + x] = src.at(y as f32 - dy, x as f32 - dx);
            }
        }
        Ok(())
    }

    fn fill_mask(&mut self, rigid: (f32, f32), residual: &[f32], mask: &mut [u8]) {
        let (h, w, gx) = (self.h, self.w, self.gx);
        let eps = 1e-3;
        let (ymax, xmax) = ((h - 1) as f32 + eps, (w - 1) as f32 + eps);
        let field = !residual.is_empty() && residual.iter().any(|&v| v != 0.0);
        for y in 0..h {
            if field {
                self.row_coefficients(residual, y);
            }
            for x in 0..w {
                let (mut dy, mut dx) = rigid;
                if field {
                    for j in 0..gx {
                        let b = self.bx[x * gx + j];
                        dy += b * self.row_coef[2 * j];
                        dx += b * self.row_coef[2 * j + 1];
                    }
                }
                let sy = y as f32 - dy;
                let sx = x as f32 - dx;
                mask[y * w + x] = u8::from(sy >= -eps && sy <= ymax && sx >= -eps && sx <= xmax);
            }
        }
    }
}

/// Fractional parts this close to 0 or 1 count as an integer sample position,
/// where the kernel's other taps carry (numerically) zero weight.
const INTEGER_EPS: f32 = 1e-4;

/// Which pixels of a warped frame were computed only from source pixels
/// inside a fixed source-coordinate mask.
///
/// The FOV mask is fixed on the sensor and the preprocessing zeroes the frame
/// outside it. Registration moves that mask in tissue coordinates, so a
/// registered pixel near the mask edge holds tissue light in some frames and
/// 0, or an interpolation blend with 0, in others. Such a sample is not data:
/// [`SourceMask::fill_rigid`] and [`Warper::fill_validity`] mark it invalid
/// (0) so the stages downstream can treat it as missing.
///
/// A sample is valid when every kernel tap with non-zero weight lies inside
/// the mask and the frame: the 4 x 4 neighbourhood for bicubic, 2 x 2 for
/// bilinear, the pixel itself at an integer position. Either way it is one
/// look-up, in the mask itself or in the mask eroded by the kernel's
/// footprint (precomputed).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceMask {
    h: usize,
    w: usize,
    /// 1 where the source pixel is inside the mask (integer positions).
    point: Vec<u8>,
    /// 1 where every tap of the kernel anchored at this pixel is inside.
    core: Vec<u8>,
    /// Chessboard distance (px) to the nearest pixel where `core` is 0 (0
    /// there), capped at `u16::MAX`: how far a sample may move and stay
    /// valid ([`Warper::fill_validity`] skips the field for deep pixels).
    depth: Vec<u16>,
}

impl SourceMask {
    /// `mask` is `h * w`, nonzero = inside; `interp` is the warp's kernel.
    pub fn new(
        h: usize,
        w: usize,
        mask: &[u8],
        interp: Interpolation,
    ) -> Result<Self, MotionError> {
        if h == 0 || w == 0 || mask.len() != h * w {
            return Err(MotionError::SizeMismatch(format!(
                "source mask has {} pixels, frame has {}",
                mask.len(),
                h * w
            )));
        }
        let point: Vec<u8> = mask.iter().map(|&m| u8::from(m != 0)).collect();
        // Taps relative to the anchor floor(position).
        let (lo, hi): (isize, isize) = match interp {
            Interpolation::Bicubic => (-1, 2),
            Interpolation::Bilinear => (0, 1),
        };
        // Separable erosion by the tap box; out of frame counts as outside.
        let erode = |src: &[u8], stride: usize, step: usize, len: usize, lines: usize| {
            let mut out = vec![0u8; src.len()];
            for l in 0..lines {
                let base = l * stride;
                for i in 0..len as isize {
                    let inside = (lo..=hi).all(|t| {
                        let j = i + t;
                        j >= 0 && j < len as isize && src[base + j as usize * step] != 0
                    });
                    out[base + i as usize * step] = u8::from(inside);
                }
            }
            out
        };
        let rows = erode(&point, w, 1, w, h);
        let core = erode(&rows, 1, w, h, w);
        // Two-pass chessboard distance transform of `core`.
        let mut depth: Vec<u16> = core
            .iter()
            .map(|&c| if c != 0 { u16::MAX } else { 0 })
            .collect();
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if depth[i] == 0 {
                    continue;
                }
                let mut d = depth[i];
                if y == 0 || x == 0 || x + 1 == w {
                    d = 1;
                } else {
                    for j in [i - 1, i - w - 1, i - w, i - w + 1] {
                        d = d.min(depth[j].saturating_add(1));
                    }
                }
                depth[i] = d;
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                let i = y * w + x;
                if depth[i] == 0 {
                    continue;
                }
                let mut d = depth[i];
                if y + 1 == h || x == 0 || x + 1 == w {
                    d = 1;
                } else {
                    for j in [i + 1, i + w - 1, i + w, i + w + 1] {
                        d = d.min(depth[j].saturating_add(1));
                    }
                }
                depth[i] = d;
            }
        }
        Ok(SourceMask {
            h,
            w,
            point,
            core,
            depth,
        })
    }

    pub fn height(&self) -> usize {
        self.h
    }

    pub fn width(&self) -> usize {
        self.w
    }

    /// The source mask itself (1 = inside).
    pub fn mask(&self) -> &[u8] {
        &self.point
    }

    /// Anchor index of a sample coordinate, and whether it is an integer one.
    #[inline]
    fn anchor(s: f32) -> (isize, bool) {
        let f = s.floor();
        let t = s - f;
        if t < INTEGER_EPS {
            (f as isize, true)
        } else if t > 1.0 - INTEGER_EPS {
            (f as isize + 1, true)
        } else {
            (f as isize, false)
        }
    }

    /// Validity (0 / 1) of a sample at source position `(sy, sx)`.
    #[inline]
    pub fn at(&self, sy: f32, sx: f32) -> u8 {
        let (iy, ey) = Self::anchor(sy);
        let (ix, ex) = Self::anchor(sx);
        if iy < 0 || ix < 0 || iy >= self.h as isize || ix >= self.w as isize {
            return 0;
        }
        let m = if ey && ex { &self.point } else { &self.core };
        m[iy as usize * self.w + ix as usize]
    }

    /// Validity of a frame warped by the rigid shift `(dy, dx)`
    /// (`out(p) = frame(p - s)`, as [`Warper::warp`]), into `out`: a shifted
    /// copy of one of the two precomputed masks.
    pub fn fill_rigid(&self, (dy, dx): (f32, f32), out: &mut [u8]) -> Result<(), MotionError> {
        let (h, w) = (self.h, self.w);
        if out.len() != h * w {
            return Err(MotionError::SizeMismatch("validity size".into()));
        }
        if !dy.is_finite() || !dx.is_finite() {
            return Err(MotionError::InvalidRecord("non-finite shift".into()));
        }
        let (by, ey) = Self::anchor(-dy);
        let (bx, ex) = Self::anchor(-dx);
        let m = if ey && ex { &self.point } else { &self.core };
        // out(y, x) = m(y + by, x + bx), by row segments.
        let (wi, hi) = (w as isize, h as isize);
        let x0 = (-bx).clamp(0, wi) as usize;
        let x1 = (wi - bx).clamp(x0 as isize, wi) as usize;
        for y in 0..h {
            let row = &mut out[y * w..(y + 1) * w];
            let sy = y as isize + by;
            if sy < 0 || sy >= hi || x0 >= x1 {
                row.fill(0);
                continue;
            }
            let s0 = (x0 as isize + bx) as usize;
            let src = &m[sy as usize * w..(sy as usize + 1) * w];
            row[..x0].fill(0);
            row[x0..x1].copy_from_slice(&src[s0..s0 + (x1 - x0)]);
            row[x1..].fill(0);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spline_interpolates_nodes_and_is_linear_for_linear_data() {
        let nodes = [0.0, 10.0, 25.0, 40.0];
        let coords: Vec<f64> = (0..=40).map(|v| v as f64).collect();
        let m = natural_spline_matrix(&nodes, &coords);
        for (j, &t) in nodes.iter().enumerate() {
            let c = t as usize;
            for k in 0..4 {
                let want = if k == j { 1.0 } else { 0.0 };
                assert!((m[c * 4 + k] - want).abs() < 1e-12);
            }
        }
        // Natural splines reproduce linear functions exactly.
        let v: Vec<f64> = nodes.iter().map(|t| 2.0 * t - 3.0).collect();
        for (c, &x) in coords.iter().enumerate() {
            let s: f64 = (0..4).map(|j| m[c * 4 + j] * v[j]).sum();
            assert!((s - (2.0 * x - 3.0)).abs() < 1e-9);
        }
        // Rows sum to one (partition of unity).
        for c in 0..coords.len() {
            let s: f64 = (0..4).map(|j| m[c * 4 + j]).sum();
            assert!((s - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn integer_shift_is_exact_and_paths_agree() {
        let (h, w) = (12, 15);
        let src: Vec<f32> = (0..h * w).map(|i| ((i * 13) % 17) as f32).collect();
        for interp in [Interpolation::Bicubic, Interpolation::Bilinear] {
            let mut wp = Warper::new(h, w, &[2.0, 9.0], &[3.0, 11.0], interp).unwrap();
            let mut out = vec![0.0; h * w];
            let mut mask = vec![0u8; h * w];
            wp.warp(&src, (2.0, -3.0), &[], &mut out, Some(&mut mask))
                .unwrap();
            // out(y, x) = src(y - 2, x + 3) where in range.
            for y in 2..h {
                for x in 0..w - 3 {
                    assert!((out[y * w + x] - src[(y - 2) * w + x + 3]).abs() < 1e-4);
                    assert_eq!(mask[y * w + x], 1);
                }
            }
            assert_eq!(mask[0], 0);
            // A tiny constant residual through the field path matches the
            // rigid path with the same total shift.
            let r = [0.25f32, -0.4];
            let res: Vec<f32> = (0..4).flat_map(|_| r).collect();
            let mut a = vec![0.0; h * w];
            let mut b = vec![0.0; h * w];
            wp.warp(&src, (1.0, 0.5), &res, &mut a, None).unwrap();
            wp.warp(&src, (1.25, 0.1), &[], &mut b, None).unwrap();
            for (p, q) in a.iter().zip(&b) {
                assert!((p - q).abs() < 1e-3, "{p} vs {q}");
            }
        }
    }

    #[test]
    fn rejects_bad_records() {
        let mut wp = Warper::new(4, 4, &[], &[], Interpolation::Bicubic).unwrap();
        let src = vec![0.0; 16];
        let mut out = vec![0.0; 16];
        assert!(wp.warp(&src, (f32::NAN, 0.0), &[], &mut out, None).is_err());
        assert!(wp.warp(&src, (0.0, 0.0), &[1.0], &mut out, None).is_err());
        assert!(wp.warp(&src[..3], (0.0, 0.0), &[], &mut out, None).is_err());
    }

    /// A disk mask, off-centre so the edge is not symmetric.
    fn disk(h: usize, w: usize) -> Vec<u8> {
        (0..h * w)
            .map(|i| {
                let (y, x) = ((i / w) as f32 - 13.0, (i % w) as f32 - 15.5);
                u8::from(y * y + x * x <= 100.0)
            })
            .collect()
    }

    /// The defining property: a valid output pixel does not depend on the
    /// source outside the mask, and every pixel that does is invalid.
    #[test]
    fn validity_marks_exactly_the_samples_that_see_outside_the_mask() {
        let (h, w) = (28, 31);
        let mask = disk(h, w);
        let inside: Vec<f32> = (0..h * w).map(|i| 5.0 + ((i * 7) % 11) as f32).collect();
        let a: Vec<f32> = inside
            .iter()
            .zip(&mask)
            .map(|(&v, &m)| if m != 0 { v } else { 0.0 })
            .collect();
        let b: Vec<f32> = inside
            .iter()
            .zip(&mask)
            .map(|(&v, &m)| if m != 0 { v } else { 1000.0 })
            .collect();
        let res: Vec<f32> = (0..18).map(|k| 0.6 * ((k as f32) * 0.9).sin()).collect();
        for interp in [Interpolation::Bicubic, Interpolation::Bilinear] {
            let src = SourceMask::new(h, w, &mask, interp).unwrap();
            let mut wp = Warper::new(h, w, &[2.0, 13.0, 25.0], &[3.0, 15.0, 28.0], interp).unwrap();
            for (rigid, residual) in [
                ((1.3f32, -2.6f32), &[][..]),
                ((-2.0, 3.0), &[][..]),
                ((0.4, 0.7), &res[..]),
            ] {
                let (mut oa, mut ob) = (vec![0.0; h * w], vec![0.0; h * w]);
                wp.warp(&a, rigid, residual, &mut oa, None).unwrap();
                wp.warp(&b, rigid, residual, &mut ob, None).unwrap();
                let mut valid = vec![0u8; h * w];
                wp.fill_validity(rigid, residual, &src, &mut valid).unwrap();
                let (mut n_valid, mut n_moved) = (0, 0);
                for p in 0..h * w {
                    let moved = (oa[p] - ob[p]).abs() > 1e-3;
                    if valid[p] != 0 {
                        assert!(!moved, "{interp:?} {rigid:?}: valid pixel {p} sees outside");
                        n_valid += 1;
                    }
                    n_moved += usize::from(moved);
                }
                // Conservative only by the kernel's zero crossings: nearly
                // every invalid pixel inside the warped disk does see outside.
                let invalid = h * w - n_valid;
                assert!(n_valid > 150, "{n_valid}");
                assert!(n_moved > 0 && invalid >= n_moved);
                // Both paths (the rigid copy, the field with its deep-pixel
                // shortcut) are the per-pixel rule.
                for y in 0..h {
                    for x in 0..w {
                        let (dy, dx) = wp.displacement_at(rigid, residual, y, x);
                        let v = src.at(y as f32 - dy, x as f32 - dx);
                        assert_eq!(valid[y * w + x], v, "{interp:?} {rigid:?} ({y}, {x})");
                    }
                }
            }
            // An integer shift keeps the mask's own pixels (no blend).
            let mut valid = vec![0u8; h * w];
            src.fill_rigid((2.0, -1.0), &mut valid).unwrap();
            for y in 0..h {
                for x in 0..w {
                    let (sy, sx) = (y as isize - 2, x as isize + 1);
                    let want =
                        sy >= 0 && sx < w as isize && mask[sy as usize * w + sx as usize] != 0;
                    assert_eq!(valid[y * w + x], u8::from(want));
                }
            }
        }
    }
}
