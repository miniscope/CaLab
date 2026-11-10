//! Diagnostics: spatial denoising arms applied to preprocessed frames before
//! the trace fit / discovery (`CALA_PREFILTER=median3 | gauss<σ>`), shared by
//! the eval examples. Not part of the library: on the calibrated minisim
//! recordings neither arm helps (see `tools/cala-diagnostics/PIXEL_NOISE.md`).

/// A spatial filter on row-major `width x height` frames, restricted to the
/// FOV (pixels outside it are left alone and never read).
pub enum Prefilter {
    Median3,
    /// Normalised Gaussian (weights renormalised over the FOV pixels).
    Gauss(Vec<f32>),
}

impl Prefilter {
    /// From `CALA_PREFILTER` (`none`, `median3`, `gauss1`, `gauss0.7`, ...).
    pub fn from_env() -> Option<Prefilter> {
        let v = std::env::var("CALA_PREFILTER").ok()?;
        Prefilter::parse(&v)
    }

    pub fn parse(v: &str) -> Option<Prefilter> {
        if v == "median3" {
            return Some(Prefilter::Median3);
        }
        let s: f32 = v.strip_prefix("gauss")?.parse().ok()?;
        Some(Prefilter::Gauss(gauss_kernel(s)))
    }

    pub fn apply(
        &self,
        frame: &mut [f32],
        fov: &[u8],
        width: usize,
        height: usize,
        tmp: &mut Vec<f32>,
    ) {
        tmp.clear();
        tmp.extend_from_slice(frame);
        match self {
            Prefilter::Median3 => {
                let mut win = [0.0f32; 9];
                for y in 0..height {
                    for x in 0..width {
                        let p = y * width + x;
                        if fov[p] == 0 {
                            continue;
                        }
                        let mut n = 0;
                        for yy in y.saturating_sub(1)..(y + 2).min(height) {
                            for xx in x.saturating_sub(1)..(x + 2).min(width) {
                                let q = yy * width + xx;
                                if fov[q] != 0 {
                                    win[n] = tmp[q];
                                    n += 1;
                                }
                            }
                        }
                        let w = &mut win[..n];
                        w.sort_unstable_by(f32::total_cmp);
                        frame[p] = if n % 2 == 1 {
                            w[n / 2]
                        } else {
                            0.5 * (w[n / 2 - 1] + w[n / 2])
                        };
                    }
                }
            }
            Prefilter::Gauss(k) => {
                let r = k.len() / 2;
                let mask: Vec<f32> = fov.iter().map(|&m| f32::from(u8::from(m != 0))).collect();
                let blur = |src: &[f32], dst: &mut [f32]| {
                    let mut mid = vec![0.0f32; src.len()];
                    for y in 0..height {
                        for x in 0..width {
                            let mut s = 0.0;
                            for (j, &kv) in k.iter().enumerate() {
                                let xx = x as isize + j as isize - r as isize;
                                if xx >= 0 && (xx as usize) < width {
                                    s += kv * src[y * width + xx as usize];
                                }
                            }
                            mid[y * width + x] = s;
                        }
                    }
                    for y in 0..height {
                        for x in 0..width {
                            let mut s = 0.0;
                            for (j, &kv) in k.iter().enumerate() {
                                let yy = y as isize + j as isize - r as isize;
                                if yy >= 0 && (yy as usize) < height {
                                    s += kv * mid[yy as usize * width + x];
                                }
                            }
                            dst[y * width + x] = s;
                        }
                    }
                };
                let masked: Vec<f32> = tmp.iter().zip(&mask).map(|(v, m)| v * m).collect();
                let mut num = vec![0.0f32; masked.len()];
                let mut den = vec![0.0f32; masked.len()];
                blur(&masked, &mut num);
                blur(&mask, &mut den);
                for p in 0..frame.len() {
                    if fov[p] != 0 && den[p] > 1e-6 {
                        frame[p] = num[p] / den[p];
                    }
                }
            }
        }
    }

    /// The same filter on a footprint patch (zero outside it), for a model
    /// consistent with the filtered data. `None` for the median (nonlinear).
    pub fn apply_patch(&self, values: &mut [f32], width: usize, height: usize) -> Option<()> {
        let Prefilter::Gauss(k) = self else {
            return None;
        };
        let r = k.len() / 2;
        let src = values.to_vec();
        let mut mid = vec![0.0f32; src.len()];
        for y in 0..height {
            for x in 0..width {
                let mut s = 0.0;
                for (j, &kv) in k.iter().enumerate() {
                    let xx = x as isize + j as isize - r as isize;
                    if xx >= 0 && (xx as usize) < width {
                        s += kv * src[y * width + xx as usize];
                    }
                }
                mid[y * width + x] = s;
            }
        }
        for y in 0..height {
            for x in 0..width {
                let mut s = 0.0;
                for (j, &kv) in k.iter().enumerate() {
                    let yy = y as isize + j as isize - r as isize;
                    if yy >= 0 && (yy as usize) < height {
                        s += kv * mid[yy as usize * width + x];
                    }
                }
                values[y * width + x] = s.max(0.0);
            }
        }
        Some(())
    }
}

fn gauss_kernel(sigma: f32) -> Vec<f32> {
    let r = (3.0 * sigma).ceil().max(1.0) as isize;
    let mut k: Vec<f32> = (-r..=r)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let s: f32 = k.iter().sum();
    for v in &mut k {
        *v /= s;
    }
    k
}

/// Diagnostics: a sensor-fixed pixel gain map from the warm-up mean image,
/// `G = mean / median5(mean)` inside the FOV (1 at flagged hot pixels and
/// outside), clipped to [0.8, 1.25]. Dividing raw frames by it removes the
/// pixel-scale fixed pattern (PRNU, column gain) before motion correction.
pub fn flat_field(mean: &[f32], fov: &[u8], flags: &[u8], width: usize, height: usize) -> Vec<f32> {
    let mut g = vec![1.0f32; mean.len()];
    let mut win = Vec::with_capacity(25);
    for y in 0..height {
        for x in 0..width {
            let p = y * width + x;
            if fov[p] == 0 || flags[p] != 0 {
                continue;
            }
            win.clear();
            for yy in y.saturating_sub(2)..(y + 3).min(height) {
                for xx in x.saturating_sub(2)..(x + 3).min(width) {
                    let q = yy * width + xx;
                    if fov[q] != 0 && flags[q] == 0 {
                        win.push(mean[q]);
                    }
                }
            }
            win.sort_unstable_by(f32::total_cmp);
            let med = win[win.len() / 2];
            if med > 1.0 {
                g[p] = (mean[p] / med).clamp(0.8, 1.25);
            }
        }
    }
    g
}
