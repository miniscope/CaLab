//! Chain-consistent box relaxation at the recorded rate (experimental; the
//! InDeCa binarization redesign, Phase 4). Behind `indeca::Relax::ChainLeastMass`,
//! not on any default path.
//!
//! The bare native solve ([`crate::native_solve`]) fits `K x` to the
//! preprocessed trace `C(y)`, where `C(z) = F(z) - RQ(F(z))` is the bandpass
//! followed by the rolling-quantile baseline (`indeca::prepare`). `K x`
//! carries none of what `C` injects (the high-pass sag around every event,
//! its far lobes, the quantile riding up under dense activity), so on
//! bursting cells the non-negative fit loses mass: .21-.56 of an isolated
//! spike survives on gcamp6f/6m/clean at per-spike noise. This module fits
//! through the chain instead, with `x` the frame masses at the recorded rate
//! (trace units: `x_i = alpha n_i`), `U` the uniform spread of a frame's mass
//! over its `k` sub-bins (the frames of `upsample::downsample_binary`), `K`
//! the kernel at the spike-resolution rate, a free offset, and the box
//! `0 <= x <= upper`.
//!
//! # The linear part: an exact, convex, FFT-applied operator ([`ChainOp`])
//!
//! On the grid, `S F K U` is a circular convolution at the recorded rate
//! (the bandpass is a circular FFT filter and `U` puts every frame's mass at
//! the same phase relative to the grid) plus a rank-two term: the filter
//! subtracts the line through its input's endpoint-window means before the
//! FFT (PR #241), which for a reconstruction is linear in `x` and is carried
//! exactly. What remains is the causal kernel's truncation at the trace's
//! end, which the circulant wraps (an edge effect: test
//! `operator_matches_the_exact_linear_chain_in_the_interior`, relative error
//! below 1e-4 over the interior). One real FFT pair of the recorded length
//! per product; the offset is eliminated by projecting the grid residual on
//! zero mean.
//!
//! # The quantile stage ([`QuantileModel`])
//!
//! Measured on Markov cells (NOTES-phase4):
//! - `ReconBaseline` (the baseline frozen at the current reconstruction's
//!   `RQ(F K U x)`, outer fixed point) DIVERGES: a slow positive baseline in
//!   the target is explained by added mass, which raises the reconstruction's
//!   quantile, which raises the target (exact chain energy 75 -> 4e4 B in
//!   three passes on gcamp6f).
//! - `Selection` (the quantile linearised as a gather `Q` at the current
//!   selection) does not converge either: in quiet stretches the selected
//!   sample of a smooth reconstruction is arbitrary (80-90% of the selection
//!   moves every pass) and the solve exploits the frozen gather.
//! - `DataBaseline` (the baseline frozen at the data's own `RQ(F(y))`, i.e.
//!   the target is `F(y)`) is one convex problem; the full chain is applied
//!   exactly once per side when the result is scored.
//!
//! # The floor is not identified: least mass at the noise budget
//!
//! The chain removes the DC and everything below the high-pass corner (and
//! the quantile removes the floor again), so a constant or slow mass floor is
//! invisible to `C K U`: with it, non-negativity never binds and the
//! unweighted chain fit is the deconvolved noise on a raised floor (Markov,
//! per-spike noise: total mass 4.8x the truth, 0.5% empty frames, fit at 0.000
//! of the budget). What fixes it is the discrepancy principle, `min sum x`
//! subject to `||P (A x - t)||^2 <= B` ([`solve_at_budget`]): the least mass
//! the data allow at the noise budget. This is an L1 weight, but not a tuned
//! one: the weight is whatever puts the fit at the budget `B` of the noise
//! model (to one standard error). The box's upper bound does not bind there
//! (the solution is the same with the oracle box and with the bare solve's
//! peak-to-trough box), so the relaxation needs no amplitude.
//!
//! # The inner stop: a duality-gap certificate
//!
//! A change `d` of the reconstruction moves the grid energy by less than one
//! standard error `SE` while `||d|| <= tau = sqrt(e + SE) - sqrt(e)`, and
//! `0.5 ||A (x - x*)||^2 <= F(x) - F*` bounds the remaining movement by
//! `sqrt(2 (F(x) - F*))`, bounded in turn by weak duality at any dual point
//! `r`: `F(x) - G(r)`, `G(r) = r't - 0.5 ||r||^2 - sum_i upper (A'r - lambda)_i^+`.
//! The bare solve's exact dual point (`A' delta = m` through the banded
//! inverse) does not exist here (`A` removes DC and the band above the
//! low-pass corner), so `r = theta (s - delta)` with `delta` the
//! Tikhonov-regularised inverse of `H'` applied to the KKT residual, the
//! regularisation and `theta` taken as the best of small families (every
//! choice is a valid bound). Measured: the certificate fires on the fast
//! kernels (jgcamp8f, ogb1, gcamp6f) and is 3-4x short of its bound on the
//! slow ones (gcamp6m/6s, clean) after 40,000 iterations, with the fit moving
//! by less than 1e-4 SE per thousand iterations: the dual point, not the
//! iterate, limits it there. The root search on the weight stops each trial
//! solve as soon as its side of the budget is certain
//! ([`InnerStop::Decided`]). `max_iters` is a guard, reported when hit.
use crate::banded::BandedAR2;
use crate::chain::Chain;
use crate::threshold::NoiseModel;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// Iterations between certificate checks (as in `native_solve`).
const BATCH: u32 = 50;

/// Guard on the outer fixed-point passes (reported when hit; the loop is
/// expected to stop on its own rule well before).
pub(crate) const MAX_PASSES: usize = 30;

/// The linear chain on the grid as a circular convolution at the recorded
/// rate (module docs).
pub(crate) struct ChainOp {
    /// Recorded samples.
    pub n: usize,
    /// Sub-bins per frame.
    pub k: usize,
    /// The grid `[lo, hi)` (recorded indices).
    pub lo: usize,
    pub hi: usize,
    h_spec: Vec<Complex<f64>>,
    /// The detrend's rank-two term: `H x = h * x + sum_e (w_e . x) g_e`.
    rank2: Vec<(Vec<f64>, Vec<f64>)>,
    /// The quantile selection on the grid (recorded indices, one per grid
    /// sample; empty: the linear chain alone).
    sel: Vec<usize>,
    pub lipschitz: f64,
    r2c: Arc<dyn RealToComplex<f64>>,
    c2r: Arc<dyn ComplexToReal<f64>>,
    spec: Vec<Complex<f64>>,
    work: Vec<f64>,
}

/// Sub-bins `[start, start + k)` of frame `i` at the spike-resolution rate
/// (the frames of `upsample::downsample_binary`: centred on the grid sample).
pub(crate) fn frame_start(i: usize, k: usize) -> isize {
    (i * k) as isize - (k / 2) as isize
}

/// A 0/1 train at the spike-resolution rate from frame masses `x` (trace
/// units) rounded at the per-spike amplitude `alpha`: `min(round(x_i /
/// alpha), k)` spikes in frame `i` of `[lo, hi)`, spread evenly over its `k`
/// sub-bins (the relaxation carries no sub-frame timing).
pub(crate) fn round_place(
    x: &[f64],
    alpha: f64,
    k: usize,
    n_up: usize,
    lo: usize,
    hi: usize,
) -> Vec<f32> {
    let mut s = vec![0.0_f32; n_up];
    if alpha.is_nan() || alpha <= 0.0 {
        return s;
    }
    for i in lo..hi.min(x.len()) {
        let c = ((x[i] / alpha).round().max(0.0) as usize).min(k);
        if c == 0 {
            continue;
        }
        let st = frame_start(i, k);
        for j in 0..c {
            let t = st + ((2 * j + 1) * k / (2 * c)) as isize;
            if t >= 0 && (t as usize) < n_up {
                s[t as usize] = 1.0;
            }
        }
    }
    s
}

/// `K U x` at the spike-resolution rate (f32, as the scorer reconstructs).
pub(crate) fn reconstruct_up(x: &[f64], k: usize, banded_up: &BandedAR2, n_up: usize) -> Vec<f32> {
    let mut s = vec![0.0_f32; n_up];
    for (i, &xi) in x.iter().enumerate() {
        if xi == 0.0 {
            continue;
        }
        let v = (xi / k as f64) as f32;
        let st = frame_start(i, k);
        for j in 0..k as isize {
            let t = st + j;
            if t >= 0 && (t as usize) < n_up {
                s[t as usize] += v;
            }
        }
    }
    let mut out = vec![0.0_f32; n_up];
    banded_up.convolve_forward(&s, &mut out);
    out
}

impl ChainOp {
    /// Build the operator from the trace's chain (`apply_linear` only),
    /// the kernel at the spike-resolution rate, the upsampled length and pad.
    pub(crate) fn new(
        chain: &mut Chain,
        banded_up: &BandedAR2,
        n_up: usize,
        pad_up: usize,
        k: usize,
    ) -> Self {
        let k = k.max(1);
        let n = n_up / k;
        let (lo, hi) = crate::indeca::native_grid(n_up, pad_up, k);
        let c = n / 2;
        let mut unit = vec![0.0_f64; n];
        unit[c] = 1.0;
        // The circulant part G (the gain curve without the detrend); a
        // filter that declines to run leaves the reconstruction unchanged.
        let mut phi = reconstruct_up(&unit, k, banded_up, n_up);
        let mut rank2 = Vec::new();
        let has_filter = match chain.filter_mut() {
            Some(f) => f.apply_gain(&mut phi),
            None => false,
        };
        if has_filter {
            // F z = G z + y0(z) q0 + y1(z) q1: `line(z) = y0 v0 + y1 v1`
            // with y0, y1 the means of z over the first and last m samples,
            // and q_e = F(v_e) - G(v_e) (exact by linearity).
            let f = chain.filter_mut().expect("filter present");
            let m = f.endpoint_window_len(n_up).max(1);
            let t0 = (m as f64 - 1.0) / 2.0;
            let span = (n_up - m).max(1) as f64;
            for e in 0..2 {
                let v: Vec<f32> = (0..n_up)
                    .map(|i| {
                        let a = (i as f64 - t0) / span;
                        (if e == 0 { 1.0 - a } else { a }) as f32
                    })
                    .collect();
                let mut fv = v.clone();
                f.apply(&mut fv);
                let mut gv = v;
                f.apply_gain(&mut gv);
                let g: Vec<f64> = (0..n).map(|i| (fv[i * k] - gv[i * k]) as f64).collect();
                // w_e = U' K' (window indicator / m).
                let mut ind = vec![0.0_f32; n_up];
                let range = if e == 0 { 0..m } else { n_up - m..n_up };
                for t in range {
                    ind[t] = 1.0 / m as f32;
                }
                let mut kt = vec![0.0_f32; n_up];
                banded_up.convolve_adjoint(&ind, &mut kt);
                let w: Vec<f64> = (0..n)
                    .map(|i| {
                        let st = frame_start(i, k);
                        (0..k as isize)
                            .map(|j| st + j)
                            .filter(|&t| t >= 0 && (t as usize) < n_up)
                            .map(|t| kt[t as usize] as f64)
                            .sum::<f64>()
                            / k as f64
                    })
                    .collect();
                rank2.push((w, g));
            }
        }
        let mut h0: Vec<f64> = (0..n).map(|m| phi[((c + m) % n) * k] as f64).collect();
        let mut planner = RealFftPlanner::<f64>::new();
        let r2c = planner.plan_fft_forward(n.max(2));
        let c2r = planner.plan_fft_inverse(n.max(2));
        let mut h_spec = r2c.make_output_vec();
        if n >= 2 {
            let _ = r2c.process(&mut h0, &mut h_spec);
        }
        // ||H|| <= ||circulant|| + sum_e ||w_e|| ||g_e||.
        let norm2 = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
        let lip_sqrt = h_spec.iter().map(|z| z.norm()).fold(0.0_f64, f64::max)
            + rank2.iter().map(|(w, g)| norm2(w) * norm2(g)).sum::<f64>();
        let lipschitz = lip_sqrt * lip_sqrt;
        let spec = r2c.make_output_vec();
        ChainOp {
            n,
            k,
            lo,
            hi,
            h_spec,
            rank2,
            sel: Vec::new(),
            lipschitz,
            r2c,
            c2r,
            spec,
            work: vec![0.0; n.max(2)],
        }
    }

    /// `||h||^2`: the grid energy of one frame's unit mass through the
    /// circulant part of the operator (Parseval over the spectrum).
    pub(crate) fn column_energy(&self) -> f64 {
        let n = self.n as f64;
        let mut e = 0.0;
        for (f, z) in self.h_spec.iter().enumerate() {
            let w = if f == 0 || (self.n % 2 == 0 && f == self.h_spec.len() - 1) {
                1.0
            } else {
                2.0
            };
            e += w * z.norm_sqr();
        }
        e / n
    }

    /// `out = H v` (`conj = false`) or `H' v` (`conj = true`), circular.
    fn apply(&mut self, v: &[f64], out: &mut [f64], conj: bool) {
        let n = self.n;
        self.work[..n].copy_from_slice(v);
        if self.r2c.process(&mut self.work, &mut self.spec).is_err() {
            out.iter_mut().for_each(|o| *o = 0.0);
            return;
        }
        for (s, h) in self.spec.iter_mut().zip(&self.h_spec) {
            *s *= if conj { h.conj() } else { *h };
        }
        self.finish(out);
        for (w, g) in &self.rank2 {
            let (a, b) = if conj { (g, w) } else { (w, g) };
            let d: f64 = a.iter().zip(v).map(|(p, q)| p * q).sum();
            for (o, bi) in out.iter_mut().zip(b) {
                *o += d * bi;
            }
        }
    }

    /// Inverse FFT of `self.spec` into `out`, normalised.
    fn finish(&mut self, out: &mut [f64]) {
        let n = self.n;
        if let Some(z) = self.spec.first_mut() {
            z.im = 0.0;
        }
        if n % 2 == 0 {
            if let Some(z) = self.spec.last_mut() {
                z.im = 0.0;
            }
        }
        if self.c2r.process(&mut self.spec, &mut self.work).is_err() {
            out.iter_mut().for_each(|o| *o = 0.0);
            return;
        }
        let scale = 1.0 / n as f64;
        for (o, &w) in out.iter_mut().zip(&self.work) {
            *o = w * scale;
        }
    }

    /// `out = IFFT(FFT(m) H / (|H|^2 + mu))`: the regularised inverse of `H'`.
    fn inverse_adjoint(&mut self, m: &[f64], mu: f64, out: &mut [f64]) {
        self.work[..self.n].copy_from_slice(m);
        if self.r2c.process(&mut self.work, &mut self.spec).is_err() {
            out.iter_mut().for_each(|o| *o = 0.0);
            return;
        }
        for (s, h) in self.spec.iter_mut().zip(&self.h_spec) {
            let d = h.norm_sqr() + mu;
            *s = if d > 0.0 {
                *s * *h / d
            } else {
                Complex::new(0.0, 0.0)
            };
        }
        self.finish(out);
    }

    /// Grid residual `P ((S - Q) H x - t)` into `res` (length `hi - lo`),
    /// using `buf` (length `n`); returns its energy. `Q` gathers the
    /// quantile selection (none on the linear chain).
    fn residual(&mut self, x: &[f64], t: &[f64], buf: &mut [f64], res: &mut [f64]) -> f64 {
        self.apply(x, buf, false);
        let (lo, hi) = (self.lo, self.hi);
        let mut mean = 0.0;
        for i in lo..hi {
            let q = if self.sel.is_empty() {
                0.0
            } else {
                buf[self.sel[i - lo]]
            };
            res[i - lo] = buf[i] - q - t[i - lo];
            mean += res[i - lo];
        }
        mean /= (hi - lo).max(1) as f64;
        let mut e = 0.0;
        for r in res.iter_mut() {
            *r -= mean;
            e += *r * *r;
        }
        e
    }

    /// `out = H' (S - Q)' v` for a grid vector `v` (length `hi - lo`), via
    /// `buf`.
    fn adjoint_grid(&mut self, v: &[f64], buf: &mut [f64], out: &mut [f64]) {
        buf.iter_mut().for_each(|b| *b = 0.0);
        buf[self.lo..self.hi].copy_from_slice(v);
        if !self.sel.is_empty() {
            for (i, &vi) in v.iter().enumerate() {
                buf[self.sel[i]] -= vi;
            }
        }
        let tmp = buf.to_vec();
        self.apply(&tmp, out, true);
    }

    /// Set the quantile selection and re-estimate the Lipschitz constant
    /// `||P (S - Q) H||^2` by power iteration.
    fn set_selection(&mut self, sel: Vec<usize>) {
        self.sel = sel;
        let n = self.n;
        let ng = self.hi - self.lo;
        let zero = vec![0.0; ng];
        let mut v: Vec<f64> = (0..n)
            .map(|i| 1.0 + ((i * 7919) % 13) as f64 / 13.0)
            .collect();
        let mut buf = vec![0.0; n];
        let mut res = vec![0.0; ng];
        let mut w = vec![0.0; n];
        let mut est = 0.0;
        // Power iteration on A'A to a relative change of 1e-6 (the step is
        // 1 / L; the estimate approaches the norm from below, so the step is
        // taken with the estimate inflated by the last change's bound).
        for it in 0..500 {
            let nv = v.iter().map(|a| a * a).sum::<f64>().sqrt().max(1e-300);
            v.iter_mut().for_each(|a| *a /= nv);
            self.residual(&v, &zero, &mut buf, &mut res);
            self.adjoint_grid(&res.clone(), &mut buf, &mut w);
            let lam: f64 = w.iter().zip(&v).map(|(a, b)| a * b).sum();
            let done = it > 10 && (lam - est).abs() <= 1e-6 * lam;
            est = lam;
            v.copy_from_slice(&w);
            if done {
                break;
            }
        }
        // A power-iteration estimate is a lower bound; FISTA needs L >= the
        // norm. The Rayleigh quotient's error after convergence to 1e-6 is
        // of that order, so 1% covers it with room.
        self.lipschitz = est * 1.01;
    }
}

/// Why an inner solve stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InnerStop {
    Certificate,
    /// The fit's side of the noise budget is certain (the remaining movement
    /// cannot carry it across): enough for the root search's bracket.
    Decided,
    Cap,
}

/// One inner solve's record.
#[derive(Clone, Copy, Debug)]
pub(crate) struct InnerRecord {
    pub iterations: u32,
    pub stop: InnerStop,
    /// `sqrt(2 gap)` at the stop.
    pub remaining: f64,
    /// The bound it had to reach.
    pub bound: f64,
    /// Grid energy of the linear model at the stop.
    pub grid_fit: f64,
}

/// One outer pass's record.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PassRecord {
    pub inner: InnerRecord,
    /// Exact chain energy of the reconstruction (offset refit, amplitude 1).
    pub exact_fit: f64,
    /// `||P (b_exact - b_model)||` on the grid: the exact quantile baseline
    /// of the reconstruction against the pass's frozen selection.
    pub baseline_change: f64,
    /// The resolution it is compared with.
    pub bound: f64,
    /// Grid samples whose quantile selection the exact chain moved.
    pub selection_changed: usize,
}

pub(crate) struct RelaxResult {
    /// Frame masses at the recorded rate (trace units).
    pub x: Vec<f64>,
    pub passes: Vec<PassRecord>,
    /// The outer loop stopped on its rule (not on [`MAX_PASSES`]).
    pub outer_converged: bool,
    /// Every inner solve stopped on its certificate.
    pub inner_converged: bool,
    pub iterations: u32,
    /// Grid `[lo, hi)`.
    pub lo: usize,
    pub hi: usize,
}

/// Box-constrained FISTA on `min 0.5 ||P (S H x - t)||^2`, `0 <= x <= upper`,
/// warm-started from `x`, stopped by the duality-gap certificate.
fn solve_inner(
    op: &mut ChainOp,
    t: &[f64],
    x: &mut [f64],
    upper: f64,
    se: f64,
    lambda: f64,
    decide: Option<f64>,
    max_iters: u32,
) -> InnerRecord {
    let n = op.n;
    let ng = op.hi - op.lo;
    let step = 1.0 / op.lipschitz.max(1e-300);
    let mut yk = x.to_vec();
    let mut x_old = vec![0.0; n];
    let mut buf = vec![0.0; n];
    let mut res = vec![0.0; ng];
    let mut grad = vec![0.0; n];
    let mut t_f = 1.0_f64;
    // The guard: FISTA's worst case for the remaining movement to fall
    // under the bound at the initial fit (module docs).
    let e0 = op.residual(x, t, &mut buf, &mut res);
    let tau0 = (e0 + se).sqrt() - e0.sqrt();
    let diam = upper * (n as f64).sqrt();
    let cap = if tau0 > 0.0 && upper.is_finite() {
        let kk = 2.0 * op.lipschitz.sqrt() * diam / tau0;
        if kk >= u32::MAX as f64 {
            u32::MAX
        } else {
            kk.ceil() as u32
        }
    } else {
        u32::MAX
    };
    let mut it = 0u32;
    let mut log_mu = (op.lipschitz.max(1e-300) * 1e-6).ln();
    loop {
        // Certificate at the current iterate.
        let e = op.residual(x, t, &mut buf, &mut res);
        let (rem, best_log_mu) =
            certificate(op, x, t, &res, upper, lambda, log_mu, &mut buf, &mut grad);
        log_mu = best_log_mu;
        let bound = (e + se).sqrt() - e.sqrt();
        let mut rec = InnerRecord {
            iterations: it,
            stop: InnerStop::Cap,
            remaining: rem,
            bound,
            grid_fit: e,
        };
        if rem <= bound && bound > 0.0 {
            rec.stop = InnerStop::Certificate;
            return rec;
        }
        if it >= max_iters {
            return rec;
        }
        if let Some(b) = decide {
            // The optimum's fit is within 2 ||r|| rem + rem^2 of this one.
            if (e - b).abs() > 2.0 * e.sqrt() * rem + rem * rem + se {
                rec.stop = InnerStop::Decided;
                return rec;
            }
        }
        if it >= cap {
            return rec;
        }
        for _ in 0..BATCH {
            op.residual(&yk, t, &mut buf, &mut res);
            op.adjoint_grid(&res, &mut buf, &mut grad);
            let mut dot = 0.0;
            for i in 0..n {
                x_old[i] = x[i];
                x[i] = (yk[i] - step * (grad[i] + lambda)).clamp(0.0, upper);
                dot += (yk[i] - x[i]) * (x[i] - x_old[i]);
            }
            it += 1;
            let t_new = (1.0 + (1.0 + 4.0 * t_f * t_f).sqrt()) / 2.0;
            if it > 1 && dot > 0.0 {
                t_f = 1.0;
                yk.copy_from_slice(x);
            } else {
                let mom = (t_f - 1.0) / t_new;
                t_f = t_new;
                for i in 0..n {
                    yk[i] = (x[i] + mom * (x[i] - x_old[i])).clamp(0.0, upper);
                }
            }
        }
    }
}

/// `sqrt(2 gap)` at `x` (module docs), with the residual `res = P (A x -
/// t)` given; returns it and the best `ln mu` of the family tried. Each dual
/// candidate `r0 = s - delta` is also scaled, `r = theta r0`, over a few
/// decades around 1 (the dual function is concave in `theta`; any `theta`
/// gives a valid bound).
#[allow(clippy::too_many_arguments)]
fn certificate(
    op: &mut ChainOp,
    x: &[f64],
    t: &[f64],
    res: &[f64],
    upper: f64,
    lambda: f64,
    log_mu: f64,
    buf: &mut [f64],
    grad: &mut [f64],
) -> (f64, f64) {
    let n = op.n;
    let (lo, hi) = (op.lo, op.hi);
    let mut tp = t.to_vec();
    demean(&mut tp);
    // Primal value F(x) = 0.5 ||res||^2 + lambda sum x.
    let primal = 0.5 * res.iter().map(|v| v * v).sum::<f64>() + lambda * x.iter().sum::<f64>();
    // g = A' res + lambda (the gradient); m = KKT residual.
    op.adjoint_grid(res, buf, grad);
    let g: Vec<f64> = grad.iter().map(|v| v + lambda).collect();
    let m: Vec<f64> = (0..n)
        .map(|i| {
            let mg = -g[i];
            if x[i] <= 0.0 {
                mg.max(0.0)
            } else if x[i] >= upper {
                mg.min(0.0)
            } else {
                mg
            }
        })
        .collect();
    let s: Vec<f64> = res.iter().map(|v| -v).collect();
    // Best gap over theta for a dual direction r0 with a = A' r0.
    let best_theta = |r0: &[f64], a: &[f64]| -> f64 {
        let rt: f64 = r0.iter().zip(&tp).map(|(a, b)| a * b).sum();
        let rr: f64 = r0.iter().map(|v| v * v).sum();
        let mut best = f64::INFINITY;
        for e in 0..=12 {
            for sign in [-1.0, 1.0] {
                let theta = if e == 0 {
                    1.0
                } else {
                    1.0 + sign * 10f64.powi(-e)
                };
                if e == 0 && sign > 0.0 {
                    continue;
                }
                let pen: f64 = a
                    .iter()
                    .map(|&ai| (theta * ai - lambda).max(0.0))
                    .sum::<f64>()
                    * upper;
                let dual = theta * rt - 0.5 * theta * theta * rr - pen;
                best = best.min(primal - dual);
            }
        }
        best.max(0.0)
    };
    // r0 = s: a = A's = -(g - lambda).
    let a0: Vec<f64> = g.iter().map(|v| -(v - lambda)).collect();
    let mut best = (best_theta(&s, &a0), f64::NAN);
    let ln10 = std::f64::consts::LN_10;
    let mut d = vec![0.0; n];
    let mut atd = vec![0.0; n];
    for j in -2..=2 {
        let lm = log_mu + j as f64 * ln10;
        op.inverse_adjoint(&m, lm.exp(), &mut d);
        let mut delta: Vec<f64> = d[lo..hi].to_vec();
        demean(&mut delta);
        op.adjoint_grid(&delta, buf, &mut atd);
        let r0: Vec<f64> = s.iter().zip(&delta).map(|(a, b)| a - b).collect();
        let a: Vec<f64> = a0.iter().zip(&atd).map(|(a, b)| a - b).collect();
        let gp = best_theta(&r0, &a);
        if gp < best.0 {
            best = (gp, lm);
        }
    }
    let lm = if best.1.is_nan() { log_mu } else { best.1 };
    ((2.0 * best.0).sqrt(), lm)
}

/// How the quantile stage enters the relaxation (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuantileModel {
    /// The bandpass alone against `C(y)` (one pass; the quantile baseline
    /// frozen at zero).
    Linear,
    /// The baseline frozen at the data's own, `RQ(F(y))`: the target is
    /// `C(y) + RQ(F(y)) = F(y)` (one pass).
    DataBaseline,
    /// Outer fixed point on the baseline from the current reconstruction,
    /// `b_p = RQ(F K U x_{p-1})`, started from the data's baseline.
    ReconBaseline,
    /// Outer fixed point on the quantile's selection: the stage linearised
    /// as `RQ(z) = Q z` with `Q` the selection of the current
    /// reconstruction (started from the data's).
    Selection,
}

/// The chain-consistent relaxation of the preprocessed trace `working` (the
/// spike-resolution rate, `C(y)`), with `filtered = F(y)`, the trace's chain,
/// the kernel at that rate, the pad, `k` sub-bins per frame, the noise model,
/// the per-frame box `upper` (trace units) and the quantile model.
#[allow(clippy::too_many_arguments)]
pub(crate) fn chain_relax(
    working: &[f32],
    filtered: &[f32],
    chain: &mut Chain,
    banded_up: &BandedAR2,
    pad_up: usize,
    k: usize,
    noise: Option<NoiseModel>,
    upper: f64,
    model: QuantileModel,
    min_mass: bool,
    max_iters: u32,
) -> RelaxResult {
    let k = k.max(1);
    let n_up = working.len();
    let mut op = ChainOp::new(chain, banded_up, n_up, pad_up, k);
    let (n, lo, hi) = (op.n, op.lo, op.hi);
    let ng = hi.saturating_sub(lo);
    let mut out = RelaxResult {
        x: vec![0.0; n],
        passes: vec![],
        outer_converged: true,
        inner_converged: true,
        iterations: 0,
        lo,
        hi,
    };
    if ng < 2 || n < 4 || op.lipschitz <= 0.0 {
        return out;
    }
    let se = noise.map_or(0.0, |nm| nm.std_error(ng));
    let budget = if min_mass {
        noise.map(|nm| nm.budget(ng))
    } else {
        None
    };
    let yg: Vec<f64> = (lo..hi).map(|i| working[i * k] as f64).collect();
    // The quantile selection, rounded to the recorded frame holding the
    // selected sub-bin.
    let half = k / 2;
    let to_grid = |idx: &[u32]| -> Vec<usize> {
        (lo..hi)
            .map(|i| ((idx[i * k] as usize + half) / k).min(n - 1))
            .collect()
    };
    // The data's baseline on the grid: F(y) - C(y).
    let data_b: Vec<f64> = (lo..hi)
        .map(|i| (filtered[i * k] - working[i * k]) as f64)
        .collect();
    let mut b = match model {
        QuantileModel::Linear | QuantileModel::Selection => vec![0.0; ng],
        QuantileModel::DataBaseline | QuantileModel::ReconBaseline => data_b,
    };
    let mut sel = if model == QuantileModel::Selection {
        to_grid(&chain.quantile_indices(filtered))
    } else {
        Vec::new()
    };
    op.set_selection(sel.clone());
    let one_pass = matches!(model, QuantileModel::Linear | QuantileModel::DataBaseline);
    let mut x = vec![0.0_f64; n];
    let mut prev_fit = f64::NAN;
    out.outer_converged = false;
    for _pass in 0..MAX_PASSES {
        let t: Vec<f64> = yg.iter().zip(&b).map(|(y, b)| y + b).collect();
        let inner = match budget {
            Some(bud) => solve_at_budget(&mut op, &t, &mut x, upper, se, bud, max_iters),
            None => solve_inner(&mut op, &t, &mut x, upper, se, 0.0, None, max_iters),
        };
        out.iterations += inner.iterations;
        out.inner_converged &= inner.stop == InnerStop::Certificate;
        // The exact chain on the reconstruction: fit, baseline, selection.
        let mut f = reconstruct_up(&x, k, banded_up, n_up);
        chain.apply_linear(&mut f);
        let new_sel = if model == QuantileModel::Selection {
            to_grid(&chain.quantile_indices(&f))
        } else {
            Vec::new()
        };
        let mut c = f.clone();
        chain.subtract_quantile(&mut c);
        let mut r: Vec<f64> = (lo..hi).map(|i| c[i * k] as f64 - yg[i - lo]).collect();
        demean(&mut r);
        let exact_fit = r.iter().map(|v| v * v).sum::<f64>();
        // The model's baseline against the reconstruction's exact one.
        let b_exact: Vec<f64> = (lo..hi).map(|i| (f[i * k] - c[i * k]) as f64).collect();
        let mut db: Vec<f64> = (lo..hi)
            .map(|i| {
                let model_b = if sel.is_empty() {
                    b[i - lo]
                } else {
                    f[sel[i - lo] * k] as f64
                };
                b_exact[i - lo] - model_b
            })
            .collect();
        demean(&mut db);
        let change = db.iter().map(|v| v * v).sum::<f64>().sqrt();
        let bound = (exact_fit + se).sqrt() - exact_fit.sqrt();
        let changed = new_sel.iter().zip(&sel).filter(|(a, b)| a != b).count();
        out.passes.push(PassRecord {
            inner,
            exact_fit,
            baseline_change: change,
            bound,
            selection_changed: changed,
        });
        // Stop: the model's baseline agrees with the exact one within the
        // resolution, the selection is a fixed point, or the exact fit moved
        // by less than one standard error since the previous pass.
        let still = (exact_fit - prev_fit).abs() <= se;
        let agree = change <= bound || (model == QuantileModel::Selection && changed == 0);
        if one_pass || agree || still {
            out.outer_converged = one_pass || agree || still;
            break;
        }
        prev_fit = exact_fit;
        match model {
            QuantileModel::Selection => {
                sel = new_sel;
                op.set_selection(sel.clone());
            }
            _ => b = b_exact,
        }
    }
    out.x = x;
    out
}

/// The least-mass solution whose fit reaches the noise budget (the
/// discrepancy principle): `min sum x` subject to `||P (A x - t)||^2 <= B`,
/// `0 <= x <= upper`, solved as the L1-weighted problem with the weight
/// found by a bracketed root search on `ln fit(ln lambda) = ln B` (regula
/// falsi, Illinois variant; warm-started solves) until the fit is within one
/// standard error of the budget. The fit is non-decreasing in `lambda`;
/// `lambda_max = max (A' P t)^+` empties the solution.
fn solve_at_budget(
    op: &mut ChainOp,
    t: &[f64],
    x: &mut [f64],
    upper: f64,
    se: f64,
    budget: f64,
    max_iters: u32,
) -> InnerRecord {
    let mut tg = t.to_vec();
    demean(&mut tg);
    let mut buf = vec![0.0; op.n];
    let mut g = vec![0.0; op.n];
    op.adjoint_grid(&tg, &mut buf, &mut g);
    let lam_max = g.iter().cloned().fold(0.0_f64, f64::max);
    let e_empty = tg.iter().map(|v| v * v).sum::<f64>();
    let target = budget.ln();
    let mut iters = 0u32;
    if lam_max <= 0.0 || e_empty <= budget {
        x.iter_mut().for_each(|v| *v = 0.0);
        let mut r = solve_inner(op, t, x, upper, se, lam_max.max(0.0), None, max_iters);
        r.iterations = 0;
        return r;
    }
    // Bracket ends as (ln lambda, ln fit - ln B): hi end at lambda_max.
    let mut hi = (lam_max.ln(), e_empty.ln() - target);
    let mut lo: Option<(f64, f64)> = None;
    let mut best: Option<(Vec<f64>, InnerRecord)> = None;
    let mut ll = lam_max.ln() + (1e-2_f64).ln();
    let mut side = 0i32;
    for _ in 0..60 {
        let r = solve_inner(op, t, x, upper, se, ll.exp(), Some(budget), max_iters);
        iters += r.iterations;
        let d = r.grid_fit.max(1e-300).ln() - target;
        let within = (r.grid_fit - budget).abs() <= se;
        if r.grid_fit <= budget || within {
            best = Some((x.to_vec(), r));
        }
        if within {
            break;
        }
        if d > 0.0 {
            hi = (ll, d);
            if side == 1 {
                if let Some(l) = lo.as_mut() {
                    l.1 *= 0.5;
                }
            }
            side = 1;
        } else {
            lo = Some((ll, d));
            if side == -1 {
                hi.1 *= 0.5;
            }
            side = -1;
        }
        ll = match lo {
            // Not bracketed yet: step down by a decade.
            None => ll - std::f64::consts::LN_10,
            Some(l) => {
                let next = l.0 - l.1 * (hi.0 - l.0) / (hi.1 - l.1);
                if next.is_finite() && next > l.0 && next < hi.0 {
                    next
                } else {
                    0.5 * (l.0 + hi.0)
                }
            }
        };
        if (hi.0 - lo.map_or(f64::NEG_INFINITY, |l| l.0)).abs() < 1e-12 {
            break;
        }
    }
    let mut rec = match best {
        Some((xb, r)) => {
            x.copy_from_slice(&xb);
            r
        }
        None => solve_inner(op, t, x, upper, se, 0.0, None, max_iters),
    };
    rec.iterations = iters;
    rec
}

fn demean(v: &mut [f64]) {
    let m = v.iter().sum::<f64>() / v.len().max(1) as f64;
    v.iter_mut().for_each(|x| *x -= m);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::BandpassFilter;

    fn chain(tr: f64, td: f64, fs_up: f64) -> Chain {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(tr, td, fs_up);
        f.set_hp_enabled(true);
        f.set_lp_enabled(true);
        Chain::new(Some(f), crate::baseline::baseline_window(td, fs_up))
    }

    #[test]
    fn operator_matches_the_exact_linear_chain_in_the_interior() {
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let n = 3000;
        let n_up = n * k;
        let fs_up = fs * k as f64;
        let banded_up = BandedAR2::new(tr, td, fs_up);
        let pad_up = crate::threshold::boundary_padding(td, fs_up);
        let mut ch = chain(tr, td, fs_up);
        let mut op = ChainOp::new(&mut ch, &banded_up, n_up, pad_up, k);
        let mut x = vec![0.0_f64; n];
        let mut p = 40;
        // Spikes stop 10 decay times before the end: the circulant wraps a
        // kernel tail cut off by the trace's end (an edge effect).
        while p < n - 200 {
            x[p] = 1.0 + (p % 4) as f64;
            p += 17 + (p * 13) % 29;
        }
        let mut hx = vec![0.0; n];
        op.apply(&x, &mut hx, false);
        let mut z = reconstruct_up(&x, k, &banded_up, n_up);
        ch.apply_linear(&mut z);
        let (lo, hi) = (op.lo, op.hi);
        let mut num = 0.0;
        let mut den = 0.0;
        for i in lo..hi {
            let d = hx[i] - z[i * k] as f64;
            num += d * d;
            den += hx[i] * hx[i];
        }
        assert!(num.sqrt() < 1e-4 * den.sqrt(), "rel {}", (num / den).sqrt());
    }

    #[test]
    fn adjoint_is_the_adjoint() {
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let n = 1000;
        let fs_up = fs * k as f64;
        let banded_up = BandedAR2::new(tr, td, fs_up);
        let mut ch = chain(tr, td, fs_up);
        let mut op = ChainOp::new(&mut ch, &banded_up, n * k, 60, k);
        let a: Vec<f64> = (0..n)
            .map(|i| ((i * 7919) % 101) as f64 / 50.0 - 1.0)
            .collect();
        let b: Vec<f64> = (0..n)
            .map(|i| ((i * 104729) % 97) as f64 / 48.0 - 1.0)
            .collect();
        let mut ha = vec![0.0; n];
        let mut htb = vec![0.0; n];
        op.apply(&a, &mut ha, false);
        op.apply(&b, &mut htb, true);
        let l: f64 = ha.iter().zip(&b).map(|(x, y)| x * y).sum();
        let r: f64 = a.iter().zip(&htb).map(|(x, y)| x * y).sum();
        assert!((l - r).abs() < 1e-9 * l.abs().max(1.0), "{l} {r}");
    }

    #[test]
    fn least_mass_at_budget_recovers_burst_mass_through_the_chain() {
        // Bursts plus white noise through the exact chain. The unweighted
        // chain fit is not identified (the chain removes the mass floor, so
        // it fits the noise on a raised floor); the least-mass solution at
        // the noise budget puts the bursts' mass back and leaves most frames
        // empty.
        let (tr, td, fs, k) = (0.1, 0.6, 30.0, 10usize);
        let n = 3000;
        let n_up = n * k;
        let fs_up = fs * k as f64;
        let banded_up = BandedAR2::new(tr, td, fs_up);
        let pad_up = crate::threshold::boundary_padding(td, fs_up);
        let mut x_true = vec![0.0_f64; n];
        let mut p = 100;
        while p < n - 100 {
            for (j, c) in [2.0, 5.0, 3.0].iter().enumerate() {
                x_true[p + j] = *c;
            }
            p += 97 + (p * 13) % 61;
        }
        let clean = reconstruct_up(&x_true, k, &banded_up, n_up);
        // Noise on the recorded samples, linearly interpolated (as
        // `upsample_trace` would carry it).
        let mut state = 12345u64;
        let raw: Vec<f32> = (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0) * 0.05) as f32
            })
            .collect();
        let noisy: Vec<f32> = (0..n).map(|i| clean[i * k] + raw[i]).collect();
        let mut fy = crate::upsample::upsample_trace(&noisy, k);
        let mut ch = chain(tr, td, fs_up);
        ch.apply_linear(&mut fy);
        let mut y = fy.clone();
        ch.subtract_quantile(&mut y);
        let mut ff = chain(tr, td, fs_up);
        let nm = crate::indeca::estimate_noise_model(&noisy, k, ff.filter_mut()).grid;
        let r = chain_relax(
            &y,
            &fy,
            &mut ch,
            &banded_up,
            pad_up,
            k,
            Some(nm),
            50.0,
            QuantileModel::DataBaseline,
            true,
            u32::MAX,
        );
        let (lo, hi) = (r.lo + 20, r.hi - 20);
        let mt: f64 = x_true[lo..hi].iter().sum();
        let me: f64 = r.x[lo..hi].iter().sum();
        let zeros = r.x[lo..hi].iter().filter(|&&v| v == 0.0).count() as f64 / (hi - lo) as f64;
        assert!((me / mt - 1.0).abs() < 0.05, "mass ratio {}", me / mt);
        assert!(zeros > 0.5, "zeros {zeros}");
    }
}
