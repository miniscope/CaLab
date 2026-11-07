//! Image prefilters for registration: 3x3 median, Gaussian blur, difference
//! of Gaussians, and the Tukey (tapered cosine) window.
//!
//! All operate on row-major `f32` images with replicated borders and write
//! into caller-provided buffers. Gaussians wider than [`EXACT_SIGMA_MAX`] use
//! three stacked box blurs (O(1) per pixel whatever the sigma); the large DoG
//! sigma only removes the slowly varying background, so the box
//! approximation's small shape error does not matter there.

/// Sigmas up to this use an exact sampled kernel; wider ones the box cascade.
pub const EXACT_SIGMA_MAX: f32 = 4.0;

/// 3x3 median with replicated borders.
///
/// Uses the separable "sorted columns" form: each vertical triple is sorted
/// once, and the median of the 3x3 block is the median of (max of the column
/// minima, median of the column medians, min of the column maxima).
pub fn median3x3(src: &[f32], h: usize, w: usize, dst: &mut [f32], scratch: &mut Vec<f32>) {
    debug_assert_eq!(src.len(), h * w);
    debug_assert_eq!(dst.len(), h * w);
    scratch.resize(3 * (w + 2), 0.0);
    let (lo, rest) = scratch.split_at_mut(w + 2);
    let (mid, hi) = rest.split_at_mut(w + 2);
    for y in 0..h {
        let a = &src[y.saturating_sub(1) * w..][..w];
        let b = &src[y * w..][..w];
        let c = &src[(y + 1).min(h - 1) * w..][..w];
        for x in 0..w {
            let (p, q, r) = (a[x], b[x], c[x]);
            let mn = p.min(q);
            let mx = p.max(q);
            lo[x + 1] = mn.min(r);
            hi[x + 1] = mx.max(r);
            mid[x + 1] = mn.max(mx.min(r));
        }
        lo[0] = lo[1];
        mid[0] = mid[1];
        hi[0] = hi[1];
        lo[w + 1] = lo[w];
        mid[w + 1] = mid[w];
        hi[w + 1] = hi[w];
        let out = &mut dst[y * w..][..w];
        for x in 0..w {
            let l = lo[x].max(lo[x + 1]).max(lo[x + 2]);
            let u = hi[x].min(hi[x + 1]).min(hi[x + 2]);
            let (m0, m1, m2) = (mid[x], mid[x + 1], mid[x + 2]);
            let m = m0.min(m1).max(m0.max(m1).min(m2));
            out[x] = med3(l, m, u);
        }
    }
}

#[inline]
fn med3(a: f32, b: f32, c: f32) -> f32 {
    a.min(b).max(a.max(b).min(c))
}

/// Gaussian blur of `src` into `dst` with replicated borders. `tmp` is
/// scratch (resized as needed).
pub fn gaussian_blur(
    src: &[f32],
    h: usize,
    w: usize,
    sigma: f32,
    dst: &mut [f32],
    tmp: &mut Vec<f32>,
) {
    debug_assert_eq!(src.len(), h * w);
    if sigma <= 0.0 {
        dst.copy_from_slice(src);
        return;
    }
    tmp.resize(h * w, 0.0);
    if sigma <= EXACT_SIGMA_MAX {
        let k = gaussian_kernel(sigma);
        conv_rows(src, h, w, &k, tmp);
        conv_cols(tmp, h, w, &k, dst);
    } else {
        let boxes = box_sizes(sigma, 3);
        dst.copy_from_slice(src);
        for &b in &boxes {
            box_rows(dst, h, w, b / 2, tmp);
            box_cols(tmp, h, w, b / 2, dst);
        }
    }
}

/// Normalised sampled Gaussian of radius `ceil(3 sigma)`.
fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let r = (3.0 * sigma).ceil().max(1.0) as isize;
    let mut k: Vec<f32> = (-r..=r)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let s: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= s);
    k
}

fn conv_rows(src: &[f32], h: usize, w: usize, k: &[f32], dst: &mut [f32]) {
    let r = k.len() / 2;
    let mut line = vec![0.0f32; w + 2 * r];
    for y in 0..h {
        let row = &src[y * w..][..w];
        line[..r].fill(row[0]);
        line[r..r + w].copy_from_slice(row);
        line[r + w..].fill(row[w - 1]);
        let out = &mut dst[y * w..][..w];
        for (x, o) in out.iter_mut().enumerate() {
            let seg = &line[x..x + k.len()];
            *o = seg.iter().zip(k).map(|(a, b)| a * b).sum();
        }
    }
}

fn conv_cols(src: &[f32], h: usize, w: usize, k: &[f32], dst: &mut [f32]) {
    let r = k.len() as isize / 2;
    for y in 0..h {
        let out = &mut dst[y * w..][..w];
        out.fill(0.0);
        for (t, &kv) in k.iter().enumerate() {
            let sy = (y as isize + t as isize - r).clamp(0, h as isize - 1) as usize;
            let row = &src[sy * w..][..w];
            for (o, &v) in out.iter_mut().zip(row) {
                *o += kv * v;
            }
        }
    }
}

/// Odd box widths whose `n`-fold cascade approximates a Gaussian of `sigma`
/// (Kovesi, "Fast almost-Gaussian filtering", 2010).
fn box_sizes(sigma: f32, n: usize) -> Vec<usize> {
    let nf = n as f32;
    let w_ideal = (12.0 * sigma * sigma / nf + 1.0).sqrt();
    let mut wl = w_ideal.floor() as isize;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let wlf = wl as f32;
    let m = ((12.0 * sigma * sigma - nf * wlf * wlf - 4.0 * nf * wlf - 3.0 * nf)
        / (-4.0 * wlf - 4.0))
        .round()
        .clamp(0.0, nf) as usize;
    (0..n)
        .map(|i| if i < m { wl as usize } else { wu as usize })
        .collect()
}

/// Horizontal moving average of radius `r` with replicated borders.
fn box_rows(src: &[f32], h: usize, w: usize, r: usize, dst: &mut [f32]) {
    let inv = 1.0 / (2 * r + 1) as f32;
    let wi = w as isize;
    let ri = r as isize;
    for y in 0..h {
        let row = &src[y * w..][..w];
        let at = |i: isize| row[i.clamp(0, wi - 1) as usize];
        let mut acc: f32 = (-ri..=ri).map(at).sum();
        let out = &mut dst[y * w..][..w];
        for x in 0..wi {
            out[x as usize] = acc * inv;
            acc += at(x + ri + 1) - at(x - ri);
        }
    }
}

/// Vertical moving average of radius `r` with replicated borders.
fn box_cols(src: &[f32], h: usize, w: usize, r: usize, dst: &mut [f32]) {
    let inv = 1.0 / (2 * r + 1) as f32;
    let hi = h as isize;
    let ri = r as isize;
    let row = |i: isize| &src[i.clamp(0, hi - 1) as usize * w..][..w];
    let mut acc = vec![0.0f32; w];
    for i in -ri..=ri {
        for (a, &v) in acc.iter_mut().zip(row(i)) {
            *a += v;
        }
    }
    for y in 0..hi {
        let out = &mut dst[y as usize * w..][..w];
        for (o, &a) in out.iter_mut().zip(&acc) {
            *o = a * inv;
        }
        let add = row(y + ri + 1);
        let sub = row(y - ri);
        for ((a, &p), &m) in acc.iter_mut().zip(add).zip(sub) {
            *a += p - m;
        }
    }
}

/// Difference of Gaussians `G(sigma_small) * src - G(sigma_large) * src`.
pub fn difference_of_gaussians(
    src: &[f32],
    h: usize,
    w: usize,
    sigma_small: f32,
    sigma_large: f32,
    dst: &mut [f32],
    scratch: &mut DogScratch,
) {
    scratch.large.resize(h * w, 0.0);
    gaussian_blur(src, h, w, sigma_small, dst, &mut scratch.tmp);
    gaussian_blur(src, h, w, sigma_large, &mut scratch.large, &mut scratch.tmp);
    for (d, &l) in dst.iter_mut().zip(&scratch.large) {
        *d -= l;
    }
}

/// Reusable buffers for [`difference_of_gaussians`].
#[derive(Default)]
pub struct DogScratch {
    large: Vec<f32>,
    tmp: Vec<f32>,
}

/// Tukey window of `n` points: flat in the middle, cosine tapers over a
/// fraction `alpha` of the length (0 = rectangular, 1 = Hann).
pub fn tukey(n: usize, alpha: f32) -> Vec<f32> {
    if n <= 1 || alpha <= 0.0 {
        return vec![1.0; n];
    }
    let alpha = alpha.min(1.0);
    let m = (n - 1) as f32;
    let edge = alpha * m / 2.0;
    (0..n)
        .map(|i| {
            let x = i as f32;
            let d = x.min(m - x);
            if d < edge {
                0.5 * (1.0 - (std::f32::consts::PI * d / edge).cos())
            } else {
                1.0
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_matches_brute_force() {
        let (h, w) = (7, 9);
        let src: Vec<f32> = (0..h * w).map(|i| ((i * 7919) % 31) as f32).collect();
        let mut dst = vec![0.0; h * w];
        let mut s = Vec::new();
        median3x3(&src, h, w, &mut dst, &mut s);
        for y in 0..h {
            for x in 0..w {
                let mut v = Vec::new();
                for dy in -1..=1isize {
                    for dx in -1..=1isize {
                        let yy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                        let xx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                        v.push(src[yy * w + xx]);
                    }
                }
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                assert_eq!(dst[y * w + x], v[4], "at {y},{x}");
            }
        }
    }

    #[test]
    fn blur_preserves_constant_and_mass() {
        let (h, w) = (40, 50);
        let c = vec![3.5f32; h * w];
        let mut d = vec![0.0; h * w];
        let mut t = Vec::new();
        for s in [1.5, 10.0] {
            gaussian_blur(&c, h, w, s, &mut d, &mut t);
            assert!(d.iter().all(|v| (v - 3.5).abs() < 1e-4));
        }
        // Box cascade variance is close to sigma^2.
        let n = 201;
        let mut imp = vec![0.0f32; n];
        imp[n / 2] = 1.0;
        let mut out = vec![0.0; n];
        gaussian_blur(&imp, 1, n, 15.0, &mut out, &mut t);
        let var: f32 = out
            .iter()
            .enumerate()
            .map(|(i, v)| v * (i as f32 - (n / 2) as f32).powi(2))
            .sum();
        assert!((var.sqrt() - 15.0).abs() < 0.6, "sigma {}", var.sqrt());
    }

    #[test]
    fn tukey_shape() {
        let t = tukey(11, 0.4);
        assert_eq!(t[0], 0.0);
        assert_eq!(t[5], 1.0);
        assert!((t[1] - t[9]).abs() < 1e-6);
        assert_eq!(tukey(5, 0.0), vec![1.0; 5]);
    }
}
