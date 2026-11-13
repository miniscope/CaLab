//! Decisions on accumulated held-out evidence (S2.1c): pure functions.
//!
//! Every slow-loop decision this module serves asks one question of
//! held-out frames: is a per-frame effect `θ` above (or below) a bound? The
//! evidence comes in time blocks of [`BLOCK`] frames (the block the running
//! statistics' split halves already use): frames of one transient fall into
//! one block, so blocks, not frames, are the independent units. Per block
//! `b` the caller sums an effect `x_b` and a non-negative weight `w_b`; the
//! estimate is the weighted mean `θ̂ = Σx / Σw` with its cluster-robust
//! standard error, tested with a Student-t tail on `G_eff − 1` degrees of
//! freedom against the look-count margin `m(n) = z₀ + √(2 ln n)`,
//! `z₀ = Φ⁻¹(1 − α₀)`. Few blocks cost power through the degrees of freedom;
//! repeated looks at a growing record cost it through the margin. There is
//! no other constant.
//!
//! The functions know nothing about reservoirs or the slow loop: a reviewer
//! over a stored history can feed them its own blocks.
//!
//! PR 0 of the S2.1c plan uses them only for shadow logging (feature
//! `diagnostics`); no decision reads them yet.
#![cfg_attr(not(feature = "diagnostics"), allow(dead_code))]

use super::fpstats::FAST_BLOCK;
use super::norm_quantile;

/// Frames per evidence block (the statistics' time block).
pub(crate) const BLOCK: u64 = FAST_BLOCK;

/// The block of frame `t`.
pub(crate) fn block_of(t: u64) -> u64 {
    t / BLOCK
}

/// `z₀ = Φ⁻¹(1 − α₀)`.
pub(crate) fn z0(alpha0: f64) -> f64 {
    norm_quantile(1.0 - alpha0)
}

/// The margin at look `n` (`n ≥ 1`): `z₀ + √(2 ln n)`.
pub(crate) fn margin(z0: f64, n: u64) -> f64 {
    z0 + (2.0 * (n.max(1) as f64).ln()).sqrt()
}

/// Block sums of a cluster ratio. Six sums, so records accumulate across
/// looks (and travel in jobs) without keeping the blocks.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Acc {
    /// Blocks folded in.
    pub g: u32,
    pub sx: f64,
    pub sw: f64,
    pub sxx: f64,
    pub sxw: f64,
    pub sww: f64,
}

/// The cluster ratio of an [`Acc`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Ratio {
    /// `Σx / Σw` (NaN without weight).
    pub theta: f64,
    /// Cluster-robust standard error (infinite with fewer than 2 blocks).
    pub se: f64,
    /// `G_eff − 1`, `G_eff = (Σw)² / Σw²`.
    pub dof: f64,
    pub blocks: u32,
}

impl Acc {
    /// Fold in one block.
    pub fn push(&mut self, x: f64, w: f64) {
        self.g += 1;
        self.sx += x;
        self.sw += w;
        self.sxx += x * x;
        self.sxw += x * w;
        self.sww += w * w;
    }

    /// Fold in another record (disjoint blocks).
    pub fn add(&mut self, o: &Acc) {
        self.g += o.g;
        self.sx += o.sx;
        self.sw += o.sw;
        self.sxx += o.sxx;
        self.sxw += o.sxw;
        self.sww += o.sww;
    }

    /// `θ̂ = Σx / Σw`, `se² = G/(G−1) · Σ(x_b − θ̂ w_b)² / (Σw)²`,
    /// `dof = (Σw)² / Σw² − 1`.
    pub fn ratio(&self) -> Ratio {
        if !(self.sw > 0.0) {
            return Ratio {
                theta: f64::NAN,
                se: f64::INFINITY,
                dof: 0.0,
                blocks: self.g,
            };
        }
        let theta = self.sx / self.sw;
        let dof = self.sw * self.sw / self.sww - 1.0;
        let se = if self.g < 2 {
            f64::INFINITY
        } else {
            let g = f64::from(self.g);
            let ss = (self.sxx - 2.0 * theta * self.sxw + theta * theta * self.sww).max(0.0);
            (g / (g - 1.0) * ss).sqrt() / self.sw
        };
        Ratio {
            theta,
            se,
            dof,
            blocks: self.g,
        }
    }
}

/// One block's sums.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Block {
    pub block: u64,
    pub x: f64,
    pub w: f64,
    /// Frames in it.
    pub n: u32,
}

/// Per-frame `(x_t, w_t)` at frames `t` summed per block, in block order.
pub(crate) fn group(frames: &[u64], x: &[f64], w: &[f64]) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut order: Vec<usize> = (0..frames.len()).collect();
    order.sort_by_key(|&k| frames[k]);
    for k in order {
        let b = block_of(frames[k]);
        match out.last_mut() {
            Some(l) if l.block == b => {
                l.x += x[k];
                l.w += w[k];
                l.n += 1;
            }
            _ => out.push(Block {
                block: b,
                x: x[k],
                w: w[k],
                n: 1,
            }),
        }
    }
    out
}

/// The blocks of `blocks` that `keep` selects, folded.
pub(crate) fn acc_of(blocks: &[Block], mut keep: impl FnMut(&Block) -> bool) -> Acc {
    let mut a = Acc::default();
    for b in blocks.iter().filter(|b| keep(b)) {
        a.push(b.x, b.w);
    }
    a
}

/// Which side of the bound the test asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    /// `θ > bound`.
    Above,
    /// `θ < bound`.
    Below,
}

/// A one-sided test's outcome.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Verdict {
    /// `(θ̂ − bound) / se` toward the tested side.
    pub t: f64,
    /// Student-t tail of `t` on the ratio's degrees of freedom (1 when
    /// `dof < 1` or without weight).
    pub p: f64,
    pub margin: f64,
    pub pass: bool,
}

/// Test `θ ≷ bound` at margin `m`: passes when `P[T_dof > t] < 1 − Φ(m)`.
/// With `dof < 1` (fewer than two blocks' worth of weight) nothing passes.
pub(crate) fn test(r: &Ratio, bound: f64, side: Side, m: f64) -> Verdict {
    let d = match side {
        Side::Above => r.theta - bound,
        Side::Below => bound - r.theta,
    };
    let t = if r.se > 0.0 {
        d / r.se
    } else if d > 0.0 {
        f64::INFINITY
    } else if d < 0.0 {
        f64::NEG_INFINITY
    } else {
        0.0
    };
    let p = if !(r.dof >= 1.0) || t.is_nan() {
        1.0
    } else {
        t_sf(t, r.dof)
    };
    Verdict {
        t,
        p,
        margin: m,
        pass: p < norm_sf(m),
    }
}

/// Upper tail `P[T_ν > t]` of Student's t with real `ν > 0`.
pub(crate) fn t_sf(t: f64, nu: f64) -> f64 {
    if t.is_nan() || !(nu > 0.0) {
        return f64::NAN;
    }
    if t == f64::INFINITY {
        return 0.0;
    }
    if t == f64::NEG_INFINITY {
        return 1.0;
    }
    let half = 0.5 * betai(0.5 * nu, 0.5, nu / (nu + t * t));
    if t > 0.0 {
        half
    } else {
        1.0 - half
    }
}

/// Upper tail `1 − Φ(z)` (fractional error below 1.2e-7).
pub(crate) fn norm_sf(z: f64) -> f64 {
    0.5 * erfc(z / std::f64::consts::SQRT_2)
}

/// Complementary error function (Chebyshev fit, Numerical Recipes'
/// `erfcc`).
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let ans = t
        * (-z * z - 1.265_512_23
            + t * (1.000_023_68
                + t * (0.374_091_96
                    + t * (0.096_784_18
                        + t * (-0.186_288_06
                            + t * (0.278_868_07
                                + t * (-1.135_203_98
                                    + t * (1.488_515_87
                                        + t * (-0.822_152_23 + t * 0.170_872_77)))))))))
            .exp();
    if x >= 0.0 {
        ans
    } else {
        2.0 - ans
    }
}

/// `ln Γ(x)`, `x > 0` (Lanczos, g = 7, n = 9).
fn ln_gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        let pi = std::f64::consts::PI;
        return (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut a = G[0];
    let t = x + 7.5;
    for (i, &g) in G.iter().enumerate().skip(1) {
        a += g / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// Regularised incomplete beta `I_x(a, b)`.
fn betai(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let ln_front = ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln();
    let front = ln_front.exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        front * betacf(a, b, x) / a
    } else {
        1.0 - front * betacf(b, a, 1.0 - x) / b
    }
}

/// Continued fraction of the incomplete beta (modified Lentz).
fn betacf(a: f64, b: f64, x: f64) -> f64 {
    const TINY: f64 = 1e-300;
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..=300 {
        let m = f64::from(m);
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-15 {
            break;
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SplitMix64 and Box–Muller: a reproducible normal source.
    struct Rng(u64);
    impl Rng {
        fn u(&mut self) -> f64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            ((z >> 11) as f64 + 0.5) / (1u64 << 53) as f64
        }
        fn n(&mut self) -> f64 {
            let (a, b) = (self.u(), self.u());
            (-2.0 * a.ln()).sqrt() * (2.0 * std::f64::consts::PI * b).cos()
        }
    }

    /// One null block: `n` frames sharing a block effect (correlated
    /// frames), weights varying across frames (the cell's energy).
    fn null_block(r: &mut Rng, n: usize) -> (f64, f64) {
        let shared = r.n();
        let (mut x, mut w) = (0.0, 0.0);
        for _ in 0..n {
            let wt = 0.2 + 2.0 * r.u();
            // Zero mean per unit weight: θ = 0.
            x += wt.sqrt() * (0.8 * shared + 0.6 * r.n());
            w += wt;
        }
        (x, w)
    }

    #[test]
    fn cluster_ratio_matches_a_weighted_mean_on_equal_blocks() {
        // Equal weights: the plain mean and the textbook standard error
        // of the block means (G/(G−1) · Σ(x−x̄)²/G² = s²/G).
        let xs = [1.0, 2.0, 4.0, 3.0, 5.0];
        let mut a = Acc::default();
        for &x in &xs {
            a.push(x, 1.0);
        }
        let r = a.ratio();
        let g = xs.len() as f64;
        let mean = xs.iter().sum::<f64>() / g;
        let s2 = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (g - 1.0);
        assert!((r.theta - mean).abs() < 1e-12);
        assert!((r.se - (s2 / g).sqrt()).abs() < 1e-12);
        assert!((r.dof - (g - 1.0)).abs() < 1e-12);
        // Scaling every weight (and effect) leaves θ and t unchanged.
        let mut b = Acc::default();
        for &x in &xs {
            b.push(3.0 * x, 3.0);
        }
        let rb = b.ratio();
        assert!((rb.theta - r.theta).abs() < 1e-12 && (rb.se - r.se).abs() < 1e-12);
    }

    #[test]
    fn t_tail_matches_reference_values() {
        // scipy.stats.t.sf / norm.sf.
        let cases = [
            (2.0, 10.0, 0.036_694_017_385_370_2),
            (3.0, 5.0, 0.015_049_623_948_731_28),
            (4.5, 30.0, 4.759_679_696_056_22e-5),
            (2.5, 1.5, 0.084_903_251_307_348),
            (-1.0, 3.0, 0.804_498_890_552_114_8),
            (1.0, 1.0, 0.25),
        ];
        for (t, nu, p) in cases {
            let got = t_sf(t, nu);
            assert!(
                (got - p).abs() < 1e-9 * p.max(1e-3),
                "t_sf({t}, {nu}) = {got}, want {p}"
            );
        }
        assert!((norm_sf(3.09) - 0.001_000_782_476_614).abs() < 2e-10);
        assert!((norm_sf(5.5) / 1.898_956_246_588_768e-8 - 1.0).abs() < 1e-6);
        assert!((z0(1e-3) - 3.090_232).abs() < 1e-5);
    }

    #[test]
    fn margin_grows_as_sqrt_two_ln_n() {
        let z = z0(1e-3);
        assert_eq!(margin(z, 1), z);
        assert_eq!(margin(z, 0), z);
        for n in [2u64, 10, 100, 10_000] {
            let want = z + (2.0 * (n as f64).ln()).sqrt();
            assert!((margin(z, n) - want).abs() < 1e-12);
        }
        assert!(margin(z, 100) > margin(z, 10));
    }

    #[test]
    fn acc_accumulates_like_one_batch() {
        let mut r = Rng(7);
        let blocks: Vec<(f64, f64)> = (0..40).map(|_| null_block(&mut r, 5)).collect();
        let mut one = Acc::default();
        for &(x, w) in &blocks {
            one.push(x, w);
        }
        let mut looks = Acc::default();
        for chunk in blocks.chunks(7) {
            let mut a = Acc::default();
            for &(x, w) in chunk {
                a.push(x, w);
            }
            looks.add(&a);
        }
        let (p, q) = (one.ratio(), looks.ratio());
        assert_eq!(p.blocks, q.blocks);
        assert!((p.theta - q.theta).abs() < 1e-12);
        assert!((p.se - q.se).abs() < 1e-12);
        assert!((p.dof - q.dof).abs() < 1e-9);
        // Grouping frames into blocks.
        let frames = [3, BLOCK + 1, 2, BLOCK + 9, 5 * BLOCK];
        let x = [1.0, 2.0, 3.0, 4.0, 5.0];
        let w = [1.0; 5];
        let g = group(&frames, &x, &w);
        assert_eq!(g.len(), 3);
        assert_eq!((g[0].block, g[0].x, g[0].n), (0, 4.0, 2));
        assert_eq!((g[1].block, g[1].x, g[1].n), (1, 6.0, 2));
        assert_eq!((g[2].block, g[2].x, g[2].n), (5, 5.0, 1));
    }

    #[test]
    fn nothing_passes_with_one_block() {
        let mut a = Acc::default();
        a.push(1e6, 1.0);
        let r = a.ratio();
        assert!(!test(&r, 0.0, Side::Above, 0.0).pass);
        // Two blocks but almost all the weight in one: dof < 1.
        a.push(1e6, 1e-6);
        let r = a.ratio();
        assert!(r.dof < 1.0);
        assert!(!test(&r, 0.0, Side::Above, 0.0).pass);
        // No weight at all.
        let mut b = Acc::default();
        b.push(1.0, 0.0);
        b.push(2.0, 0.0);
        assert!(!test(&b.ratio(), 0.0, Side::Above, 0.0).pass);
    }

    #[test]
    fn null_blocks_pass_at_the_declared_rate() {
        let alpha0 = 1e-3;
        let m = margin(z0(alpha0), 1);
        let mut r = Rng(11);
        let trials = 20_000;
        let mut pass = 0;
        for k in 0..trials {
            // Few to many blocks, uneven block sizes.
            let g = 3 + k % 12;
            let mut a = Acc::default();
            for _ in 0..g {
                let n = 1 + (r.u() * 8.0) as usize;
                let (x, w) = null_block(&mut r, n);
                a.push(x, w);
            }
            if test(&a.ratio(), 0.0, Side::Above, m).pass {
                pass += 1;
            }
        }
        let rate = f64::from(pass) / trials as f64;
        assert!(rate <= 2.0 * alpha0, "null pass rate {rate}");
    }

    #[test]
    fn repeated_looks_on_noise_stay_within_alpha() {
        // A larger α₀ so the family-wise rate is measurable in a short test.
        let alpha0 = 0.01;
        let z = z0(alpha0);
        let mut r = Rng(23);
        let trials = 2_000;
        let mut hit = 0;
        for _ in 0..trials {
            let mut a = Acc::default();
            for look in 1..=200u64 {
                let (x, w) = null_block(&mut r, 4);
                a.push(x, w);
                if test(&a.ratio(), 0.0, Side::Above, margin(z, look)).pass {
                    hit += 1;
                    break;
                }
            }
        }
        let rate = f64::from(hit) / trials as f64;
        assert!(rate <= 3.0 * alpha0, "family-wise pass rate {rate}");
    }
}
