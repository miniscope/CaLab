//! "Trace follows motion": cross-validated R² of a cell's trace on a
//! quadratic of the frame's rigid shift.
//!
//! A cell trace that is a smooth function of where the frame was shifted is
//! not a calcium signal: it is the sensor's gain pattern (fixed-pattern
//! shimmer) or a footprint sitting on texture, seen through the registration
//! jitter. Display and flag only, never part of the pass rule.
//!
//! Features per frame, with `d = (dy, dx)` minus the run's reference shift
//! (the median over the burn-in) and both axes divided by one scale (the
//! burn-in standard deviation, which only conditions the fit): intercept,
//! `dy`, `dx`, `|d|`, `dy²`, `dx²`, `dy·dx`. This is the diagnosis'
//! `shift` feature set (`a1_motion.py`: `dy, dx, dy², dx², dy·dx, |d|`
//! plus intercept, `|d|` about the median shift).
//!
//! Two folds of alternating contiguous blocks of frames (fit on one, predict
//! the other, both ways); R² = 1 − ΣSSE / ΣSST pooled over both test folds,
//! SST about the test fold's mean. Negative values are reported as they are.
//! The sums behind it are the 7×7 normal equations per fold, so the cost is
//! O(cells) per frame and the memory bounded (about 1 kB per cell).
//!
//! Differences from the diagnosis script, which ran offline on the final
//! traces: blocks alternate every `block` frames instead of two halves (so a
//! slow trend does not leak between folds); the reference shift is the median
//! of the first `burn_in` frames rather than of the whole run; the fit is
//! ridge-stabilised (1e-8 of the mean diagonal) so a few distinct shift values
//! give a minimum-norm-like fit instead of failing; and the trace is the one
//! the fast loop solved at the time (library version of that frame).

/// Features per frame (including the intercept).
pub const K: usize = 7;

/// Normal equations of one fold.
#[derive(Debug, Clone, Copy)]
struct Fold {
    n: f64,
    xtx: [f64; K * K],
    xty: [f64; K],
    yy: f64,
}

impl Fold {
    const EMPTY: Fold = Fold {
        n: 0.0,
        xtx: [0.0; K * K],
        xty: [0.0; K],
        yy: 0.0,
    };
}

/// The reference shift and scale of a run, fixed after the burn-in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShiftRef {
    pub dy: f64,
    pub dx: f64,
    pub scale: f64,
}

impl ShiftRef {
    /// Median and common standard deviation of `shifts`; `None` when there
    /// is no motion to speak of (scale below 1e-3 px) or nothing finite.
    pub fn from_burn_in(shifts: &[(f32, f32)]) -> Option<ShiftRef> {
        let mut ys: Vec<f64> = shifts
            .iter()
            .filter(|s| s.0.is_finite() && s.1.is_finite())
            .map(|s| f64::from(s.0))
            .collect();
        let mut xs: Vec<f64> = shifts
            .iter()
            .filter(|s| s.0.is_finite() && s.1.is_finite())
            .map(|s| f64::from(s.1))
            .collect();
        if ys.len() < 8 {
            return None;
        }
        let med = |v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.total_cmp(b));
            v[v.len() / 2]
        };
        let sd = |v: &[f64]| {
            let m = v.iter().sum::<f64>() / v.len() as f64;
            (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64).sqrt()
        };
        let scale = sd(&ys).max(sd(&xs));
        if scale < 1e-3 {
            return None;
        }
        Some(ShiftRef {
            dy: med(&mut ys),
            dx: med(&mut xs),
            scale,
        })
    }

    /// The feature row of a shift.
    pub fn features(&self, dy: f32, dx: f32) -> [f64; K] {
        let y = (f64::from(dy) - self.dy) / self.scale;
        let x = (f64::from(dx) - self.dx) / self.scale;
        [1.0, y, x, y.hypot(x), y * y, x * x, y * x]
    }
}

/// One cell's accumulated normal equations.
#[derive(Debug, Clone, Default)]
pub struct MotionAcc {
    folds: Option<Box<[Fold; 2]>>,
    /// Offset removed from the trace (its first value) for conditioning.
    y0: f64,
}

impl MotionAcc {
    /// Whether any frame was added.
    pub fn is_started(&self) -> bool {
        self.folds.is_some()
    }

    /// Add one frame to `fold` (0 or 1).
    pub fn push(&mut self, fold: usize, x: &[f64; K], y: f32) {
        if !y.is_finite() {
            return;
        }
        let folds = match &mut self.folds {
            Some(f) => f,
            None => {
                self.y0 = f64::from(y);
                self.folds.insert(Box::new([Fold::EMPTY; 2]))
            }
        };
        let y = f64::from(y) - self.y0;
        let f = &mut folds[fold & 1];
        f.n += 1.0;
        f.yy += y * y;
        for i in 0..K {
            f.xty[i] += x[i] * y;
            for j in i..K {
                f.xtx[i * K + j] += x[i] * x[j];
            }
        }
    }

    /// Cross-validated R², NaN until each fold holds `min_fold` frames or
    /// when the trace is constant in the test folds.
    pub fn r2(&self, min_fold: f64) -> f32 {
        let Some(folds) = &self.folds else {
            return f32::NAN;
        };
        if folds[0].n < min_fold || folds[1].n < min_fold {
            return f32::NAN;
        }
        let (mut sse, mut sst) = (0.0, 0.0);
        for k in 0..2 {
            let (train, test) = (&folds[k], &folds[1 - k]);
            let Some(b) = solve(train) else {
                return f32::NAN;
            };
            let mut xb = 0.0;
            let mut bxxb = 0.0;
            for i in 0..K {
                xb += b[i] * test.xty[i];
                for j in 0..K {
                    let (lo, hi) = if i <= j { (i, j) } else { (j, i) };
                    bxxb += b[i] * b[j] * test.xtx[lo * K + hi];
                }
            }
            sse += test.yy - 2.0 * xb + bxxb;
            // The intercept row of X'y is the sum of y.
            sst += test.yy - test.xty[0] * test.xty[0] / test.n;
        }
        if sst > 1e-12 {
            (1.0 - sse / sst) as f32
        } else {
            f32::NAN
        }
    }
}

/// Ridge-stabilised least squares of one fold (Gaussian elimination, partial
/// pivoting); `None` when singular.
fn solve(f: &Fold) -> Option<[f64; K]> {
    let mut a = [[0.0f64; K + 1]; K];
    let mut tr = 0.0;
    for i in 0..K {
        tr += f.xtx[i * K + i];
    }
    let ridge = 1e-8 * tr / K as f64;
    for i in 0..K {
        for j in 0..K {
            let (lo, hi) = if i <= j { (i, j) } else { (j, i) };
            a[i][j] = f.xtx[lo * K + hi];
        }
        a[i][i] += ridge;
        a[i][K] = f.xty[i];
    }
    for c in 0..K {
        let p = (c..K).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[p][c].abs() <= 1e-300 {
            return None;
        }
        a.swap(c, p);
        for r in c + 1..K {
            let m = a[r][c] / a[c][c];
            for k in c..=K {
                a[r][k] -= m * a[c][k];
            }
        }
    }
    let mut b = [0.0; K];
    for i in (0..K).rev() {
        let mut s = a[i][K];
        for j in i + 1..K {
            s -= a[i][j] * b[j];
        }
        b[i] = s / a[i][i];
    }
    b.iter().all(|v| v.is_finite()).then_some(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic standard-normal-ish noise (sum of uniforms).
    struct Rng(u64);
    impl Rng {
        fn u(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn n(&mut self) -> f64 {
            (0..12).map(|_| self.u()).sum::<f64>() - 6.0
        }
    }

    fn quad(x: &[f64; K]) -> f64 {
        0.5 * x[1] - 0.4 * x[2] + 0.3 * x[4] + 0.2 * x[6] + 0.3 * x[3]
    }

    fn run(signal: f64, seed: u64) -> f32 {
        let mut rng = Rng(seed);
        let (burn, block, frames) = (300usize, 500usize, 4300usize);
        let shifts: Vec<(f32, f32)> = (0..frames)
            .map(|_| (rng.n() as f32 * 0.7, rng.n() as f32 * 0.7))
            .collect();
        let r = ShiftRef::from_burn_in(&shifts[..burn]).unwrap();
        let mut acc = MotionAcc::default();
        for (t, &(dy, dx)) in shifts.iter().enumerate().skip(burn) {
            let x = r.features(dy, dx);
            let y = signal * quad(&x) + rng.n();
            acc.push(((t - burn) / block) % 2, &x, y as f32);
        }
        acc.r2(50.0)
    }

    #[test]
    fn quadratic_in_shift_gives_expected_r2() {
        // y = signal * q + unit noise: R2 = var(signal q) / (var(signal q) + 1);
        // var(q) from a long run on the same features.
        let mut rng = Rng(7);
        let shifts: Vec<(f32, f32)> = (0..20000)
            .map(|_| (rng.n() as f32 * 0.7, rng.n() as f32 * 0.7))
            .collect();
        let r = ShiftRef::from_burn_in(&shifts[..300]).unwrap();
        let qs: Vec<f64> = shifts
            .iter()
            .map(|&(dy, dx)| quad(&r.features(dy, dx)))
            .collect();
        let m = qs.iter().sum::<f64>() / qs.len() as f64;
        let vq = qs.iter().map(|q| (q - m) * (q - m)).sum::<f64>() / qs.len() as f64;
        let signal = 1.5;
        let expect = signal * signal * vq / (signal * signal * vq + 1.0);
        let got = f64::from(run(signal, 11));
        assert!(
            (got - expect).abs() < 0.05,
            "R2 {got:.3}, expected about {expect:.3}"
        );
        assert!(got > 0.2);
    }

    #[test]
    fn unrelated_trace_is_near_zero_or_negative() {
        for seed in 1..6 {
            let got = run(0.0, seed);
            assert!(got < 0.02 && got > -0.1, "R2 {got}");
        }
    }

    #[test]
    fn not_ready_or_no_motion_is_nan() {
        let acc = MotionAcc::default();
        assert!(acc.r2(50.0).is_nan());
        assert!(ShiftRef::from_burn_in(&[(0.5, 0.5); 300]).is_none());
        let r = ShiftRef {
            dy: 0.0,
            dx: 0.0,
            scale: 1.0,
        };
        let mut acc = MotionAcc::default();
        for t in 0..100 {
            acc.push(0, &r.features(t as f32 * 0.01, 0.0), 1.0);
        }
        assert!(acc.r2(50.0).is_nan(), "second fold empty");
    }
}
