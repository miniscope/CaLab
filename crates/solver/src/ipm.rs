//! Exact solver for the InDeCa relaxed problem by a primal-dual interior-point
//! method on the banded AR(2) structure.
//!
//! The relaxed problem is `min 0.5 ||K x - y||^2` over the box `0 <= x <= 1`
//! (`K` the peak-normalized AR(2) forward operator, [`BandedAR2`]). With the
//! calcium trace `c = K x` as the variable the objective is a plain
//! projection, `0.5 ||c - y||^2`, and the box becomes `0 <= G c <= 1` with
//! `G = K^+` the lower-banded AR(2) difference operator (three taps). A
//! Mehrotra predictor-corrector Newton step on the barrier-perturbed KKT
//! system reduces to `(I + G' D G) dc = rhs` with `D` diagonal and positive:
//! a pentadiagonal SPD system, solved by a banded Cholesky in O(n). The
//! iteration count (typically 15-40) does not depend on the conditioning of
//! `K`, which sets FISTA's count (`~ sqrt(kappa)`, tens of thousands of
//! iterations for slow kernels).
//!
//! The solution is the same unique minimizer FISTA converges to (strictly
//! convex in `c`; the one unobservable source sample `x[n-1]` is held at 0,
//! as FISTA's zero gradient leaves it). The active set is read off the
//! complementarity pair (`s_i < lambda_i`), those entries are set exactly to
//! the bound, and the result is checked with the same certificate as FISTA
//! ([`crate::native_solve::certify`]); if the check fails the point
//! warm-starts the FISTA solve, which finishes to the same certificate.
use crate::banded::BandedAR2;
use crate::native_solve::{certify, solve_box, CertificateState, NativeResult, Stop, StopReason};

/// Newton iteration cap before falling back to FISTA.
const MAX_ITERS: u32 = 120;
/// The point is accepted once its KKT bound `||delta||` is this fraction of
/// the certificate's bound: the optimum to a thousandth of the tolerance
/// FISTA stops at.
const TIGHTNESS: f64 = 1e-3;
/// ... or this fraction once the iterate has stopped improving.
const LOOSE: f64 = 1e-2;

/// Half-bandwidth of the interleaved `[v_0, w_0, v_1, w_1, ...]` KKT system.
const BW: usize = 5;

/// Banded `L D L'` factorization (no pivoting) of the symmetric
/// quasi-definite KKT matrix `[I G'; G -D^-1]`, interleaved so its
/// half-bandwidth is [`BW`]. Unlike the normal equations `I + G' D G` it
/// does not square the (up to 1e15) range of `D`, which destroys the `I`
/// part in floating point near the solution.
struct Ldl {
    /// `l[j][k-1]` = L[j][j-k], k = 1..=BW.
    l: Vec<[f64; BW]>,
    d: Vec<f64>,
    /// Band of the matrix being factored, same layout as `l`.
    a: Vec<[f64; BW]>,
    diag: Vec<f64>,
}

impl Ldl {
    fn new(m: usize) -> Self {
        Self {
            l: vec![[0.0; BW]; 2 * m],
            d: vec![0.0; 2 * m],
            a: vec![[0.0; BW]; 2 * m],
            diag: vec![0.0; 2 * m],
        }
    }

    /// Assemble `[I G'; G -1/D]` and factor it. `false` on a zero or
    /// non-finite pivot.
    fn factor(&mut self, taps: &Taps, inv_d: &[f64]) -> bool {
        let m = inv_d.len();
        for j in 0..2 * m {
            self.a[j] = [0.0; BW];
        }
        for i in 0..m {
            self.diag[2 * i] = 1.0;
            self.diag[2 * i + 1] = -inv_d[i];
            let w = 2 * i + 1;
            self.a[w][0] = taps.q0; // (w_i, v_i): lag 1
            if i >= 1 {
                self.a[w][2] = taps.q1; // (w_i, v_{i-1}): lag 3
            }
            if i >= 2 {
                self.a[w][4] = taps.q2; // (w_i, v_{i-2}): lag 5
            }
        }
        let n = 2 * m;
        for j in 0..n {
            let kmin = j.saturating_sub(BW);
            let mut lj = [0.0_f64; BW];
            for k in kmin..j {
                // l_jk = (a_jk - sum_{p<k} l_jp d_p l_kp) / d_k
                let mut v = self.a[j][j - k - 1];
                for p in k.saturating_sub(BW).max(kmin)..k {
                    v -= lj[j - p - 1] * self.d[p] * self.l[k][k - p - 1];
                }
                lj[j - k - 1] = v / self.d[k];
            }
            let mut dj = self.diag[j];
            for k in kmin..j {
                dj -= lj[j - k - 1] * lj[j - k - 1] * self.d[k];
            }
            if dj == 0.0 || !dj.is_finite() {
                return false;
            }
            self.d[j] = dj;
            self.l[j] = lj;
        }
        true
    }

    /// Solve in place.
    fn solve(&self, b: &mut [f64]) {
        let n = b.len();
        for j in 0..n {
            let mut v = b[j];
            for k in j.saturating_sub(BW)..j {
                v -= self.l[j][j - k - 1] * b[k];
            }
            b[j] = v;
        }
        for j in 0..n {
            b[j] /= self.d[j];
        }
        for j in (0..n).rev() {
            let mut v = b[j];
            for k in j + 1..(j + BW + 1).min(n) {
                v -= self.l[k][k - j - 1] * b[k];
            }
            b[j] = v;
        }
    }
}

struct Taps {
    q0: f64,
    q1: f64,
    q2: f64,
}

impl Taps {
    /// `out = G v` (row i: `q0 v[i] + q1 v[i-1] + q2 v[i-2]`).
    fn g(&self, v: &[f64], out: &mut [f64]) {
        for i in 0..v.len() {
            let mut a = self.q0 * v[i];
            if i >= 1 {
                a += self.q1 * v[i - 1];
            }
            if i >= 2 {
                a += self.q2 * v[i - 2];
            }
            out[i] = a;
        }
    }

    /// `out = G' w`.
    fn gt(&self, w: &[f64], out: &mut [f64]) {
        let m = w.len();
        for j in 0..m {
            let mut a = self.q0 * w[j];
            if j + 1 < m {
                a += self.q1 * w[j + 1];
            }
            if j + 2 < m {
                a += self.q2 * w[j + 2];
            }
            out[j] = a;
        }
    }
}

/// `x = G c` with the active set (read off complementarity) set exactly to
/// the bounds. The unobservable last sample stays 0.
fn snap(st: &State, gv: &[f64], x: &mut [f64]) {
    for i in 0..gv.len() {
        x[i] = if st.sl[i] < st.ll[i] {
            0.0
        } else if st.su[i] < st.lu[i] {
            1.0
        } else {
            gv[i].clamp(0.0, 1.0)
        };
    }
}

/// Largest `a` with `z + a dz >= 0`.
fn max_step(z: &[f64], dz: &[f64]) -> f64 {
    let mut a = f64::INFINITY;
    for (zi, di) in z.iter().zip(dz) {
        if *di < 0.0 {
            a = a.min(-zi / di);
        }
    }
    a
}

/// Buffers and fixed data of one Newton solve.
struct Dir {
    dv: Vec<f64>,
    dsl: Vec<f64>,
    dsu: Vec<f64>,
    dll: Vec<f64>,
    dlu: Vec<f64>,
}

impl Dir {
    fn new(m: usize) -> Self {
        Self {
            dv: vec![0.0; m],
            dsl: vec![0.0; m],
            dsu: vec![0.0; m],
            dll: vec![0.0; m],
            dlu: vec![0.0; m],
        }
    }

    fn max_step(&self, st: &State) -> f64 {
        1.0_f64
            .min(max_step(&st.sl, &self.dsl))
            .min(max_step(&st.su, &self.dsu))
            .min(max_step(&st.ll, &self.dll))
            .min(max_step(&st.lu, &self.dlu))
    }
}

struct State {
    v: Vec<f64>,
    sl: Vec<f64>,
    su: Vec<f64>,
    ll: Vec<f64>,
    lu: Vec<f64>,
}

/// Newton direction for complementarity targets `rcl`, `rcu`, given the
/// factored `I + G' D G`, the residuals and the scratch `tmp`, `rhs`.
#[allow(clippy::too_many_arguments)]
fn newton(
    taps: &Taps,
    fac: &Ldl,
    inv_d: &[f64],
    st: &State,
    rd: &[f64],
    rpl: &[f64],
    rpu: &[f64],
    rcl: &[f64],
    rcu: &[f64],
    rhs: &mut [f64],
    tmp: &mut [f64],
    out: &mut Dir,
) {
    let m = st.sl.len();
    for i in 0..m {
        tmp[i] = rcu[i] / st.su[i] - rcl[i] / st.sl[i] + (st.lu[i] / st.su[i]) * rpu[i]
            - (st.ll[i] / st.sl[i]) * rpl[i];
    }
    // rhs = [-rd; -t / D] interleaved; solve; dv = even entries.
    for i in 0..m {
        rhs[2 * i] = -rd[i];
        rhs[2 * i + 1] = -tmp[i] * inv_d[i];
    }
    fac.solve(rhs);
    for i in 0..m {
        out.dv[i] = rhs[2 * i];
    }
    taps.g(&out.dv, tmp);
    for i in 0..m {
        out.dsl[i] = tmp[i] - rpl[i];
        out.dsu[i] = -tmp[i] - rpu[i];
        out.dll[i] = (rcl[i] - st.ll[i] * out.dsl[i]) / st.sl[i];
        out.dlu[i] = (rcu[i] - st.lu[i] * out.dsu[i]) / st.su[i];
    }
}

/// Solve the relaxed problem exactly (to the certificate). `y` is the
/// prescaled trace; `stop` the certificate. Falls back to FISTA
/// (warm-started from the interior point) if the Newton system breaks down
/// or the certificate fails after snapping.
pub(crate) fn solve_box_ipm(
    y: &[f64],
    banded: &BandedAR2,
    stop: Stop,
    fista_cap: u32,
) -> NativeResult {
    let n = y.len();
    if n < 3 || y.iter().any(|v| !v.is_finite()) {
        return solve_box(y, banded, 0.0, fista_cap, 0.0, Some(stop), None);
    }
    let (d, r, peak) = banded.cascade();
    let (g1, g2) = (d + r, -(d * r));
    let taps = Taps {
        q0: peak,
        q1: -peak * g1,
        q2: -peak * g2,
    };
    let m = n - 1;
    let yt = &y[1..];
    let ynorm2: f64 = yt.iter().map(|v| v * v).sum();
    let gap_scale = 1.0 + ynorm2 / m as f64;

    // Start: x = 0.5 everywhere, so c = K (0.5 1) and G c = 0.5.
    let mut st = State {
        v: vec![0.0; m],
        sl: vec![0.5; m],
        su: vec![0.5; m],
        ll: vec![1.0; m],
        lu: vec![1.0; m],
    };
    {
        let half = vec![0.5_f64; n];
        let mut c = vec![0.0_f64; n];
        banded.convolve_forward_f64(&half, &mut c);
        st.v.copy_from_slice(&c[1..]);
    }

    let mut gv = vec![0.0_f64; m];
    let mut rd = vec![0.0_f64; m];
    let mut rpl = vec![0.0_f64; m];
    let mut rpu = vec![0.0_f64; m];
    let mut rhs = vec![0.0_f64; 2 * m];
    let mut inv_d = vec![0.0_f64; m];
    let mut tmp = vec![0.0_f64; m];
    let mut rcl = vec![0.0_f64; m];
    let mut rcu = vec![0.0_f64; m];
    let mut fac = Ldl::new(m);
    let mut dir = Dir::new(m);
    let mut aff = Dir::new(m);

    let mut iters = 0_u32;
    let mut x = vec![0.0_f64; n];
    let mut best_x = vec![0.0_f64; n];
    let mut best_rem = f64::INFINITY;
    let mut best_c: Option<CertificateState> = None;
    let mut since_best = 0_u32;
    let mut conv = vec![0.0_f64; n];
    let mut resid = vec![0.0_f64; n];
    let mut grad = vec![0.0_f64; n];

    while iters < MAX_ITERS {
        taps.g(&st.v, &mut gv);
        for i in 0..m {
            rpl[i] = st.sl[i] - gv[i];
            rpu[i] = st.su[i] - 1.0 + gv[i];
            tmp[i] = st.lu[i] - st.ll[i];
        }
        taps.gt(&tmp, &mut rd);
        for j in 0..m {
            rd[j] += st.v[j] - yt[j];
        }
        let comp: f64 = (0..m)
            .map(|i| st.ll[i] * st.sl[i] + st.lu[i] * st.su[i])
            .sum();
        let mu = comp / (2.0 * m as f64);
        let rp_inf = rpl
            .iter()
            .chain(rpu.iter())
            .fold(0.0_f64, |a, b| a.max(b.abs()));
        if iters >= 3 && mu < 1e-3 * gap_scale && rp_inf < 1e-6 {
            snap(&st, &gv, &mut x);
            let c = certify(&x, y, banded, 0.0, &stop, &mut conv, &mut resid, &mut grad);
            if c.remaining < best_rem {
                best_rem = c.remaining;
                best_x.clone_from(&x);
                best_c = Some(c);
                since_best = 0;
            } else {
                since_best += 1;
            }
            if c.bound > 0.0 && best_rem <= TIGHTNESS * c.bound {
                break;
            }
            // The KKT bound bottoms out at the arithmetic floor of the
            // factorization; accept the best iterate once it has plateaued
            // well inside the certificate.
            if c.bound > 0.0 && best_rem <= LOOSE * c.bound && since_best >= 2 {
                break;
            }
            if c.bound > 0.0 && best_rem <= c.bound && since_best >= 6 {
                break;
            }
        }

        for i in 0..m {
            inv_d[i] = 1.0 / (st.lu[i] / st.su[i] + st.ll[i] / st.sl[i]);
        }
        if !fac.factor(&taps, &inv_d) {
            break;
        }

        // Predictor.
        for i in 0..m {
            rcl[i] = -st.ll[i] * st.sl[i];
            rcu[i] = -st.lu[i] * st.su[i];
        }
        newton(
            &taps, &fac, &inv_d, &st, &rd, &rpl, &rpu, &rcl, &rcu, &mut rhs, &mut tmp, &mut aff,
        );
        let a_aff = aff.max_step(&st);
        let mut comp_aff = 0.0;
        for i in 0..m {
            comp_aff += (st.ll[i] + a_aff * aff.dll[i]) * (st.sl[i] + a_aff * aff.dsl[i])
                + (st.lu[i] + a_aff * aff.dlu[i]) * (st.su[i] + a_aff * aff.dsu[i]);
        }
        let mu_aff = comp_aff / (2.0 * m as f64);
        let sigma = (mu_aff / mu).powi(3).clamp(0.0, 1.0);

        // Corrector.
        for i in 0..m {
            rcl[i] = sigma * mu - st.ll[i] * st.sl[i] - aff.dsl[i] * aff.dll[i];
            rcu[i] = sigma * mu - st.lu[i] * st.su[i] - aff.dsu[i] * aff.dlu[i];
        }
        newton(
            &taps, &fac, &inv_d, &st, &rd, &rpl, &rpu, &rcl, &rcu, &mut rhs, &mut tmp, &mut dir,
        );
        let a = 0.995 * dir.max_step(&st);
        for i in 0..m {
            st.v[i] += a * dir.dv[i];
            st.sl[i] += a * dir.dsl[i];
            st.su[i] += a * dir.dsu[i];
            st.ll[i] += a * dir.dll[i];
            st.lu[i] += a * dir.dlu[i];
        }
        iters += 1;
        if !a.is_finite() || a < 1e-12 {
            break;
        }
    }

    if let Some(c) = best_c {
        if c.bound > 0.0 && c.remaining <= c.bound {
            return NativeResult {
                x: best_x,
                iterations: iters,
                reason: StopReason::Certificate,
                certificate: Some(c),
                ipm_fallback: false,
            };
        }
    }
    // Fallback: FISTA finishes from the best point (or from scratch if the
    // Newton iteration never got near).
    let warm = best_c.map(|_| best_x.as_slice());
    let mut res = solve_box(y, banded, 0.0, fista_cap, 0.0, Some(stop), warm);
    res.iterations += iters;
    res.ipm_fallback = true;
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(n: usize, seed: u64) -> Vec<f64> {
        let mut s = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (0..n)
            .map(|_| {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((s >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
            })
            .collect()
    }

    /// Sparse bursts of height up to `amp` (box units), noise `sigma`.
    fn trace(banded: &BandedAR2, n: usize, amp: f64, sigma: f64, seed: u64) -> Vec<f64> {
        let u = lcg(n, seed);
        let x: Vec<f64> = u
            .iter()
            .map(|&v| {
                if v > 0.93 {
                    amp * (v - 0.9) * 10.0
                } else {
                    0.0
                }
            })
            .collect();
        let mut c = vec![0.0; n];
        banded.convolve_forward_f64(&x, &mut c);
        let z = lcg(n, seed + 99);
        c.iter().zip(&z).map(|(a, b)| a + sigma * b).collect()
    }

    fn stop(n: usize, se: f64) -> Stop {
        Stop { se, lo: 0, hi: n }
    }

    fn agree(tau_r: f64, tau_d: f64, fs: f64, y: &[f64], se: f64) {
        let banded = BandedAR2::new(tau_r, tau_d, fs);
        let n = y.len();
        let ip = solve_box_ipm(y, &banded, stop(n, se), u32::MAX);
        assert_eq!(ip.reason, StopReason::Certificate);
        assert!(ip.iterations <= MAX_ITERS, "fell back to FISTA");
        // FISTA far past the certificate FISTA itself would stop at.
        let fi = solve_box(
            y,
            &banded,
            0.0,
            u32::MAX,
            0.0,
            Some(stop(n, se * 1e-8)),
            None,
        );
        assert!(fi.converged());
        let dmax =
            ip.x.iter()
                .zip(&fi.x)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max);
        let obj = |x: &[f64]| {
            let mut c = vec![0.0; n];
            banded.convolve_forward_f64(x, &mut c);
            0.5 * c.iter().zip(y).map(|(a, b)| (a - b) * (a - b)).sum::<f64>()
        };
        let (oi, of) = (obj(&ip.x), obj(&fi.x));
        assert!(dmax < 1e-4, "max|dx| = {dmax:.2e}");
        assert!(
            (oi - of).abs() <= 1e-7 * (1.0 + of),
            "objective {oi} vs {of}"
        );
        assert!(ip.x.iter().all(|&v| (0.0..=1.0).contains(&v)));
        assert_eq!(ip.x[n - 1], 0.0);
    }

    #[test]
    fn matches_converged_fista_on_fast_and_slow_kernels() {
        for (tr, td, fs, n) in [
            (0.02, 0.4, 30.0, 1500),
            (0.05, 1.2, 30.0, 1500),
            (0.05, 1.2, 60.0, 1200),
            (0.01, 0.15, 15.0, 800),
        ] {
            let b = BandedAR2::new(tr, td, fs);
            for seed in [1, 2, 3] {
                let y = trace(&b, n, 0.6, 0.05, seed);
                agree(tr, td, fs, &y, 0.5);
            }
        }
    }

    #[test]
    fn saturated_bursts_hit_the_upper_bound() {
        let b = BandedAR2::new(0.02, 0.4, 30.0);
        let y = trace(&b, 1500, 4.0, 0.05, 7);
        let ip = solve_box_ipm(&y, &b, stop(1500, 0.5), u32::MAX);
        assert!(ip.x.contains(&1.0), "upper bound not active");
        agree(0.02, 0.4, 30.0, &y, 0.5);
    }

    #[test]
    fn degenerate_inputs() {
        let b = BandedAR2::new(0.02, 0.4, 30.0);
        // All zero: the optimum is exactly zero.
        let z = vec![0.0; 300];
        let r = solve_box_ipm(&z, &b, stop(300, 0.5), u32::MAX);
        assert!(r.x.iter().all(|&v| v == 0.0));
        // Pure noise.
        let y: Vec<f64> = lcg(1000, 5).iter().map(|v| 0.1 * v).collect();
        agree(0.02, 0.4, 30.0, &y, 0.5);
        // Very short traces.
        for n in [0usize, 1, 2, 3, 4, 7, 20] {
            let y: Vec<f64> = lcg(n, 9).iter().map(|v| 0.3 * v.abs()).collect();
            let r = solve_box_ipm(&y, &b, stop(n, 0.5), u32::MAX);
            assert_eq!(r.x.len(), n);
            assert!(r.x.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
        }
        // Edge zones: the certificate on an interior grid only.
        let y = trace(&b, 600, 0.6, 0.05, 11);
        let st = Stop {
            se: 0.5,
            lo: 60,
            hi: 540,
        };
        let r = solve_box_ipm(&y, &b, st, u32::MAX);
        assert_eq!(r.reason, StopReason::Certificate);
    }
}
