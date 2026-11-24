//! One tile of a window compressed on the GPU: the sketch sizes and random
//! draws `compress_tile` would use, and the finish from the GPU's range basis
//! `Q` and `Bᵀ = Yᵀ Q` (the eigen step, the lag-1 cut, the growth rule, the
//! bytes). With the same draws the result is `compress_tile`'s up to float
//! rounding (CholeskyQR instead of Householder QR, other summation order).

use super::{
    grow, omega_draws, pack_tile, rank_cap, rank_threshold, sketch_dims, svd_from_qb, tile_config,
    CompressConfig, TileStats,
};

/// The CPU side of one tile's GPU sketch: what to sketch with, and the
/// finish once the GPU has the range basis.
pub struct GpuTile {
    cfg: CompressConfig,
    stats: Option<TileStats>,
    seed: u64,
    t: usize,
    p: usize,
    pos: (usize, usize, usize, usize),
    k: usize,
    k_cap: usize,
    thr: f64,
    /// Draws taken by earlier sketches of this tile.
    drawn: usize,
    rank: usize,
}

impl GpuTile {
    /// The tile at `pos = (x0, y0, w, h)` of a window of `t` frames with
    /// statistics `stats`; `prev_rank` is the rank it kept in the previous
    /// window (see [`tile_config`]).
    pub fn new(
        cfg: &CompressConfig,
        stats: TileStats,
        pos: (usize, usize, usize, usize),
        t: usize,
        seed: u64,
        prev_rank: Option<usize>,
    ) -> GpuTile {
        let p = pos.2 * pos.3;
        let cfg = tile_config(cfg, prev_rank);
        let k_cap = rank_cap(&cfg, p, t);
        GpuTile {
            k: cfg.k0.clamp(1, k_cap),
            thr: rank_threshold(&cfg, t),
            cfg,
            stats: Some(stats),
            seed,
            t,
            p,
            pos,
            k_cap,
            drawn: 0,
            rank: 0,
        }
    }

    /// Sketch columns of the current sketch.
    pub fn l(&self) -> usize {
        sketch_dims(self.p, self.t, self.k).0
    }

    /// Power iterations of a sketch.
    pub fn n_iter(&self) -> usize {
        self.cfg.n_iter
    }

    /// The current sketch's `Ω` (`t x l`, row-major).
    pub fn omega(&self) -> Vec<f32> {
        omega_draws(self.seed, self.t, self.drawn, self.l())
    }

    /// Finish from `q` (`p x stride`) and `bt` (`t x stride`), both row-major
    /// with the first `l` columns read. `None`: the sketch grew (call `l`,
    /// `omega` again and sketch anew).
    ///
    /// # Panics
    ///
    /// When called again after it returned the tile.
    pub fn finish(&mut self, q: &[f32], bt: &[f32], stride: usize) -> Option<Vec<u8>> {
        let (l, k) = sketch_dims(self.p, self.t, self.k);
        let svd = svd_from_qb(q, bt, self.p, self.t, l, k, stride);
        if let Some(k2) = grow(&svd, self.k, self.k_cap, self.thr, self.t) {
            self.drawn += self.t * l;
            self.k = k2;
            return None;
        }
        let stats = self.stats.take().expect("GpuTile finished once");
        let mut tf = pack_tile(svd, stats, self.t, self.p, self.thr);
        (tf.x0, tf.y0, tf.w, tf.h) = self.pos;
        self.rank = tf.rank;
        Some(tf.to_bytes())
    }

    /// The rank the finished tile kept (0 before).
    pub fn rank(&self) -> usize {
        self.rank
    }

    /// `(p, t)`: the tile's pixels and the window's frames.
    pub fn dims(&self) -> (usize, usize) {
        (self.p, self.t)
    }

    /// Whether `finish` has returned the tile.
    pub fn finished(&self) -> bool {
        self.stats.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::{
        chol_inv_upper, compress_tile, k0_after, quantize, TileFactors, WindowStats, MISSING,
    };

    /// `C = A B` with `A` `m x k`, `B` `k x n` (row-major, f32).
    fn mm(a: &[f32], b: &[f32], m: usize, k: usize, n: usize) -> Vec<f32> {
        let mut c = vec![0.0f32; m * n];
        for i in 0..m {
            for kk in 0..k {
                let v = a[i * k + kk];
                if v == 0.0 {
                    continue;
                }
                for j in 0..n {
                    c[i * n + j] += v * b[kk * n + j];
                }
            }
        }
        c
    }

    fn tr(a: &[f32], m: usize, n: usize) -> Vec<f32> {
        let mut o = vec![0.0f32; m * n];
        for i in 0..m {
            for j in 0..n {
                o[j * m + i] = a[i * n + j];
            }
        }
        o
    }

    fn cholqr2(y: &[f32], m: usize, l: usize) -> Vec<f32> {
        let mut q = y.to_vec();
        for _ in 0..2 {
            let g = mm(&tr(&q, m, l), &q, l, m, l);
            let r = chol_inv_upper(&g, l, l).expect("positive definite");
            q = mm(&q, &r, m, l, l);
        }
        q
    }

    /// The GPU path in plain Rust: centred `A` (`p x t`), `Ω` from the tile,
    /// CholeskyQR2, `n_iter` power iterations, `Bᵀ = Aᵀ Q`, `finish`.
    fn via_gpu_path(
        raw: &[i16],
        w: usize,
        h: usize,
        t: usize,
        cfg: &CompressConfig,
        seed: u64,
        prev: Option<usize>,
    ) -> TileFactors {
        let mut stats = WindowStats::new(w, h);
        stats.push(raw);
        let s = stats.tile(0, 0, w, h, cfg.quant);
        let p = w * h;
        let mut a = vec![0.0f32; p * t];
        for tt in 0..t {
            for i in 0..p {
                let v = raw[tt * p + i];
                a[i * t + tt] = if v == MISSING {
                    0.0
                } else {
                    f32::from(v) / cfg.quant - s.mean[i]
                };
            }
        }
        let mut job = GpuTile::new(cfg, s, (0, 0, w, h), t, seed, prev);
        loop {
            let l = job.l();
            let mut q = cholqr2(&mm(&a, &job.omega(), p, t, l), p, l);
            for _ in 0..job.n_iter() {
                let z = cholqr2(&mm(&tr(&a, p, t), &q, t, p, l), t, l);
                q = cholqr2(&mm(&a, &z, p, t, l), p, l);
            }
            let bt = mm(&tr(&a, p, t), &q, t, p, l);
            if let Some(bytes) = job.finish(&q, &bt, l) {
                return TileFactors::from_bytes(&bytes).unwrap();
            }
        }
    }

    /// 5 Gaussian blobs with slow random-walk traces plus white noise,
    /// quantized at 64; with `missing`, every 7th sample of pixel 3 is missing.
    fn synth_raw(w: usize, h: usize, t: usize, missing: bool) -> Vec<i16> {
        let mut out = Vec::with_capacity(w * h * t);
        let mut state = 12345u64;
        let mut rnd = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        let centres = [
            (5.0, 6.0),
            (20.0, 9.0),
            (12.0, 22.0),
            (27.0, 27.0),
            (8.0, 28.0),
        ];
        let mut amp = [0.0f32; 5];
        for tt in 0..t {
            for a in amp.iter_mut() {
                *a = (*a * 0.95 + rnd()).max(0.0);
            }
            for y in 0..h {
                for x in 0..w {
                    let mut v = 2.0 * rnd();
                    for (c, (cx, cy)) in centres.iter().enumerate() {
                        let d2 = (x as f32 - cx).powi(2) + (y as f32 - cy).powi(2);
                        v += 8.0 * amp[c] * (-d2 / 8.0).exp();
                    }
                    let i = y * w + x;
                    out.push(if missing && i == 3 && tt % 7 == 0 {
                        MISSING
                    } else {
                        quantize(v, 64.0)
                    });
                }
            }
        }
        out
    }

    /// Relative squared difference of the low-rank parts `W Vᵀ` (sign- and
    /// rotation-free).
    fn low_rank_diff(g: &TileFactors, c: &TileFactors) -> f64 {
        let t = c.temporal.len() / c.rank;
        let p = c.mean.len();
        let lr = |f: &TileFactors| {
            let mut o = vec![0.0f64; p * t];
            for i in 0..p {
                for j in 0..t {
                    for r in 0..f.rank {
                        o[i * t + j] += f64::from(f.spatial[i * f.rank + r])
                            * f64::from(f.temporal[j * f.rank + r]);
                    }
                }
            }
            o
        };
        let (a, b) = (lr(g), lr(c));
        let d: f64 = a.iter().zip(&b).map(|(x, y)| (x - y).powi(2)).sum();
        let n: f64 = b.iter().map(|y| y * y).sum();
        d / n
    }

    fn assert_close(g: &TileFactors, c: &TileFactors) {
        assert_eq!(g.rank, c.rank, "rank");
        assert_eq!(g.svd_rank, c.svd_rank, "svd rank");
        assert_eq!(g.mean, c.mean);
        assert_eq!(g.valid, c.valid);
        let rel = low_rank_diff(g, c);
        eprintln!(
            "rank {} svd_rank {} relative difference {rel:e}",
            c.rank, c.svd_rank
        );
        assert!(rel < 1e-6, "relative difference {rel}");
        for (x, y) in g.discarded.iter().zip(&c.discarded) {
            assert!(
                (x - y).abs() <= 1e-3 * y.abs().max(1e-3),
                "discarded {x} vs {y}"
            );
        }
    }

    #[test]
    fn the_gpu_path_gives_compress_tiles_factors() {
        let (w, h, t) = (32, 32, 300);
        let base = CompressConfig::default();
        for (missing, prev) in [(false, None), (true, None), (false, Some(6))] {
            let raw = synth_raw(w, h, t, missing);
            let cfg = CompressConfig {
                k0: prev.map_or(base.k0, |r| k0_after(r, base.k0)),
                ..base.clone()
            };
            let cpu = compress_tile(&raw, t, w * h, &cfg, 9);
            // `GpuTile::new` applies `tile_config` itself.
            let gpu = via_gpu_path(&raw, w, h, t, &base, 9, prev);
            assert_close(&gpu, &cpu);
        }
    }

    #[test]
    fn a_tile_whose_tail_passes_grows_and_draws_on() {
        // k0 = 2 forces growth on a 5-blob tile.
        let (w, h, t) = (32, 32, 300);
        let raw = synth_raw(w, h, t, false);
        let cfg = CompressConfig {
            k0: 2,
            adapt_k0: false,
            ..CompressConfig::default()
        };
        let cpu = compress_tile(&raw, t, w * h, &cfg, 4);
        assert!(cpu.svd_rank > 2, "the CPU tile grew");
        let mut stats = WindowStats::new(w, h);
        stats.push(&raw);
        let job = GpuTile::new(
            &cfg,
            stats.tile(0, 0, w, h, cfg.quant),
            (0, 0, w, h),
            t,
            4,
            None,
        );
        assert_eq!(job.l(), 12);
        let gpu = via_gpu_path(&raw, w, h, t, &cfg, 4, None);
        assert_close(&gpu, &cpu);
    }

    /// Independent slow AR(1) noise per pixel, quantized at 64: a flat
    /// spectrum whose every component passes the lag-1 cut.
    fn ar_noise_raw(w: usize, h: usize, t: usize) -> Vec<i16> {
        let mut state = 777u64;
        let mut rnd = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        let mut x = vec![0.0f32; w * h];
        let mut out = Vec::with_capacity(w * h * t);
        for _ in 0..t {
            for v in x.iter_mut() {
                *v = 0.9 * *v + rnd();
                out.push(quantize(*v, 64.0));
            }
        }
        out
    }

    #[test]
    fn the_gpu_path_uses_the_cpus_draws_after_growth() {
        // On a flat spectrum the kept subspace depends on `Ω`, so only the
        // CPU's draws (the first sketches' and those after) reproduce it.
        let (w, h, t) = (32, 32, 300);
        let raw = ar_noise_raw(w, h, t);
        let cfg = CompressConfig {
            k0: 2,
            adapt_k0: false,
            max_rank: 24,
            ..CompressConfig::default()
        };
        let cpu = compress_tile(&raw, t, w * h, &cfg, 4);
        assert_eq!((cpu.svd_rank, cpu.rank), (24, 24), "grew to the cap");
        let gpu = via_gpu_path(&raw, w, h, t, &cfg, 4, None);
        assert_close(&gpu, &cpu);
        let other = via_gpu_path(&raw, w, h, t, &cfg, 5, None);
        let rel = low_rank_diff(&other, &cpu);
        assert!(rel > 1e-3, "other draws differ: {rel}");
    }
}
