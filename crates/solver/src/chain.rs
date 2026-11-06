//! Chain-consistent scoring of candidate spike trains.
//!
//! The InDeCa fit compares a reconstruction `alpha K n + b` with the
//! *preprocessed* trace `C(y) = F(y) - RQ(F(y))`: the bandpass `F` and the
//! rolling-quantile baseline subtraction `RQ` (`indeca::prepare`). Scoring the
//! bare reconstruction against `C(y)` is inconsistent: the chain injects
//! structure into the trace that the model `K n` does not carry, so even the
//! true train scores well above the noise budget. Measured on the simulation
//! presets (drift off, 100 s traces), the chain injects:
//!
//! - the zero-phase high-pass sag: an activity-locked undershoot of one to
//!   several spike amplitudes (about two on gcamp6f) before and after events,
//!   and positive lobes carrying about 8% of the impulse area 20-120 s away
//!   from each event (the lobe sits at `~0.5 / f_hp`);
//! - the circular wrap of the FFT high-pass: a step of half the trace's
//!   end-to-start difference, spread over 8-45 s at both ends, when the
//!   bandpass input is not endpoint-detrended (the bandpass now detrends it,
//!   which removes the wrap step);
//! - the rolling quantile riding up under dense activity;
//! - and, when the trace is shorter than `1 / f_hp` (gcamp6s and ogb1 at
//!   100 s), the high-pass degenerates into a DC-only no-op: the sag is a
//!   constant, and the quantile is all the chain does.
//!
//! [`Scorer::Chain`] passes every candidate reconstruction through the
//! identical chain before computing the residual, so the linear part (`F`:
//! sag, lobes, wrap) cancels exactly, and only the quantile nonlinearity is
//! left: the clean calcium then scores at 1.00-1.10x the noise budget on the
//! drift-free presets (1.3-1.4x where the budget is smallest), against
//! 1.4-28x bare. What stays above the budget on the default simulations is
//! the random-walk drift, which the `25 * tau_d * fs` rolling window cannot
//! track (the true train scores 1.2-7x the budget on gcamp6s and gcamp6m
//! with drift on; this scorer does not address that).
//!
//! Cost: the chain runs once per distinct candidate (110-200 per trace on the
//! 300 Hz loop). The threshold search's candidates are nested (each lower
//! threshold adds bins to the train of the one above), so the linear part
//! `F(K n)` is built incrementally by [`Superposition`]: the previous
//! candidate's filtered reconstruction plus the filtered columns of the added
//! spikes, in f64, instead of one f32 FFT pair of the trace length per
//! candidate. It equals filtering each candidate from scratch up to the f32
//! rounding of that FFT (candidate errors within ~1e-6 relative; picks
//! identical on the equivalence set, see `nested_scoring_tests`). The O(n)
//! [`RollingQuantile`] then runs on every candidate as before, and the final
//! scoring of the picked train goes through [`Chain::apply`].
//!
//! The chain is invariant to the amplitude and offset of the reconstruction:
//! `F` is linear and removes the DC (or, high-pass off, passes it unchanged),
//! and the rolling quantile is positively homogeneous and shift-equivariant, so
//! `C(alpha K n + b) = alpha C(K n)` (plus `b` when the high-pass is off, which
//! the quantile then removes) for `alpha >= 0`. The candidate's amplitude and
//! offset therefore stay a 2x2 least-squares fit against `C(K n)`.
use crate::banded::BandedAR2;
use crate::baseline::{RollingQuantile, DEFAULT_BASELINE_QUANTILE};
use crate::filter::BandpassFilter;
use crate::threshold::lstsq_alpha_baseline;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// The preprocessing chain `C(z) = F(z) - RQ(F(z))` of `indeca::prepare`.
///
/// Scoring a candidate from scratch ([`Scorer::score`]) costs one pass of the
/// chain: the trace's own `BandpassFilter` (its FFT plans and gain curve are
/// cached, so a pass is one forward and one inverse FFT), then the O(n)
/// [`RollingQuantile`] with its buffers kept across candidates. A nested
/// search ([`Scorer::begin_nested`]) replaces the FFT pass by superposition.
pub(crate) struct Chain {
    /// The bandpass, when it was applied to the trace.
    filter: Option<BandpassFilter>,
    /// Rolling-quantile window (samples).
    window: usize,
    quantile: RollingQuantile,
    /// The linear part `F K` by superposition, built on the first nested
    /// search and kept for later ones on the same trace and kernel.
    superposition: Option<Box<Superposition>>,
}

impl Chain {
    pub(crate) fn new(filter: Option<BandpassFilter>, window: usize) -> Self {
        Self {
            filter,
            window,
            quantile: RollingQuantile::new(),
            superposition: None,
        }
    }

    /// Push `z` through the chain in place.
    pub(crate) fn apply(&mut self, z: &mut [f32]) {
        if let Some(f) = self.filter.as_mut() {
            f.apply(z);
        }
        self.quantile
            .subtract(z, self.window, DEFAULT_BASELINE_QUANTILE);
    }
}

/// How a candidate count train is scored against the trace.
pub(crate) enum Scorer<'a> {
    /// The bare reconstruction against `y` (the rule before chain scoring).
    Plain { y: &'a [f32] },
    /// The reconstruction passed through the trace's preprocessing chain.
    Chain { y: &'a [f32], chain: Box<Chain> },
}

impl Scorer<'_> {
    /// The vector reconstructions are compared with.
    pub(crate) fn target(&self) -> &[f32] {
        match self {
            Scorer::Plain { y } | Scorer::Chain { y, .. } => y,
        }
    }

    /// Score one train: reconstruct (through the chain), fit amplitude and
    /// offset over the interior, return `(residual energy at every stride-th
    /// interior sample, alpha, offset)`. Leaves the transformed reconstruction
    /// in `conv`.
    pub(crate) fn score(
        &mut self,
        s: &[f32],
        banded: &BandedAR2,
        pad: usize,
        stride: usize,
        max_alpha: f64,
        conv: &mut [f32],
    ) -> (f64, f64, f64) {
        if let Scorer::Plain { y } = self {
            return crate::threshold::fit_candidate(s, y, banded, pad, stride, max_alpha, conv);
        }
        banded.convolve_forward(s, conv);
        self.score_reconstruction(conv, pad, stride, max_alpha)
    }

    /// Score a reconstruction given in trace units before any preprocessing
    /// (e.g. `K n`, or a clean calcium trace): transform it in place like the
    /// trace, then fit amplitude and offset as in [`Scorer::score`].
    pub(crate) fn score_reconstruction(
        &mut self,
        conv: &mut [f32],
        pad: usize,
        stride: usize,
        max_alpha: f64,
    ) -> (f64, f64, f64) {
        if let Scorer::Chain { chain, .. } = self {
            chain.apply(conv);
        }
        fit_residual(self.target(), conv, pad, stride, max_alpha)
    }

    /// Prepare to score a nested family of `n`-sample trains with
    /// [`Self::score_added`], starting from the empty train. Returns false
    /// when the linear part cannot be superposed (no chain or no filter, the
    /// filter a no-op at this length, or a kernel that outlasts the trace);
    /// the caller then scores each train with [`Self::score`].
    pub(crate) fn begin_nested(&mut self, banded: &BandedAR2, n: usize) -> bool {
        let Scorer::Chain { chain, .. } = self else {
            return false;
        };
        let Some(filter) = chain.filter.as_mut() else {
            return false;
        };
        if !chain
            .superposition
            .as_ref()
            .is_some_and(|sp| sp.matches(banded, n))
        {
            chain.superposition = Superposition::new(filter, banded, n).map(Box::new);
        }
        match chain.superposition.as_mut() {
            Some(sp) => {
                sp.reset();
                true
            }
            None => false,
        }
    }

    /// Score the running nested train after adding the spikes at `added`
    /// (bins of the upsampled trace): as [`Self::score`] of the full train,
    /// with the linear part of the chain by superposition. Requires a
    /// successful [`Self::begin_nested`].
    pub(crate) fn score_added(
        &mut self,
        added: &[usize],
        pad: usize,
        stride: usize,
        max_alpha: f64,
        conv: &mut [f32],
    ) -> (f64, f64, f64) {
        self.score_changed(added, &[], pad, stride, max_alpha, conv)
    }

    /// [`Self::score_added`] for a train that also loses the spikes at
    /// `removed` (each a spike of the running train): the next candidate need
    /// not contain the previous one, only differ from it by a few spikes.
    pub(crate) fn score_changed(
        &mut self,
        added: &[usize],
        removed: &[usize],
        pad: usize,
        stride: usize,
        max_alpha: f64,
        conv: &mut [f32],
    ) -> (f64, f64, f64) {
        let Scorer::Chain { y, chain } = self else {
            unreachable!("score_changed without begin_nested");
        };
        let sp = chain
            .superposition
            .as_mut()
            .expect("score_changed without begin_nested");
        sp.remove(removed);
        sp.add(added);
        sp.write(conv);
        chain
            .quantile
            .subtract(conv, chain.window, DEFAULT_BASELINE_QUANTILE);
        fit_residual(y, conv, pad, stride, max_alpha)
    }
}

/// Least-squares amplitude and offset of `conv` against `y` over the
/// interior, and the residual energy at every `stride`-th interior sample.
fn fit_residual(
    y: &[f32],
    conv: &[f32],
    pad: usize,
    stride: usize,
    max_alpha: f64,
) -> (f64, f64, f64) {
    let (alpha, baseline) = lstsq_alpha_baseline(conv, y, pad, max_alpha);
    let n = y.len();
    let mut err = 0.0_f64;
    for i in (pad..n.saturating_sub(pad)).step_by(stride.max(1)) {
        let d = y[i] as f64 - (alpha * conv[i] as f64 + baseline);
        err += d * d;
    }
    (err, alpha, baseline)
}

/// Largest number of spikes added between two scored candidates that
/// [`Superposition`] adds column by column (one length-`n` pass each); a
/// larger batch is pushed through the f64 FFT operator in one go, which costs
/// about as much as this many column passes. A cost crossover only: both
/// routes compute the same linear map.
const SUPERPOSE_MAX_COLUMNS: usize = 128;

/// The linear part of the chain, `L(K s) = F(K s)`, for a nested family of
/// binary trains, by exact superposition.
///
/// `F` (the bandpass with its endpoint detrend, see
/// [`BandpassFilter::linear_operator`]) and `K` (the AR(2) convolution) are
/// both linear, so `L(K s) = sum_j L(K e_{t_j})` over the train's spikes. In
/// the threshold search the candidate trains are nested (each lower threshold
/// keeps a superset of the bins of a higher one), so each candidate is the
/// previous one plus a few spikes, and its filtered reconstruction is the
/// previous one plus a few columns: `O(added * n)` instead of an FFT pair of
/// the odd trace length per candidate. The rolling quantile, which is not
/// linear, still runs on every candidate.
///
/// One column, written with `H` the circular filter `IFFT(gain * FFT(.))`:
/// `K e_t` is the kernel `k` placed at `t` and cut at the trace end, which is
/// the circular shift of `k[0..n)` by `t` minus the part of it that wrapped
/// to the start (`wrap_t`), so
///
/// `L(K e_t) = shift(H k, t) - H(wrap_t) - c_t H(1) - b_t H(ramp)
///             [+ c_t + b_t ramp with the HP off]`
///
/// where `(c_t, b_t)` is the detrend line of `K e_t` (its window means, from
/// prefix sums of `k`). The wrapped part continues the AR(2) cascade past the
/// trace end from its state there: `wrap_t[i] = C_t r^(i+1) + U_t E[i]` with
/// `C_t = k[n-1-t]`, `U_t = d^(n-1-t) / peak` and `E[i] = sum_{j<=i}
/// r^(i-j) d^j`, so every column's wrap is a combination of the same two
/// vectors. (This counts lags `>= n` too, which is why the superposition is
/// only used when the kernel has decayed below `1e-14` of its peak within the
/// trace.) Per candidate the corrections are four scalars accumulated over
/// the spikes against four vectors filtered once per trace, all in f64.
///
/// The result equals the shipped per-candidate FFT up to rounding: f64 here,
/// f32 FFT rounding there (measured in the equivalence test).
pub(crate) struct Superposition {
    n: usize,
    /// Kernel parameters it was built for, `(d, r, peak)` as bits.
    key: [u64; 3],
    /// `H k` twice over (length `2n`): the column template, whose circular
    /// shift by `t` is the slice `g2[n - t..2n - t]`.
    g2: Vec<f64>,
    /// `H r^(i+1)`, `H E`, `H ramp`, and the DC gain `H 1 = gain[0]`.
    h_r1: Vec<f64>,
    h_e: Vec<f64>,
    h_ramp: Vec<f64>,
    g_dc: f64,
    hp: bool,
    /// Endpoint window of the detrend line.
    m: usize,
    /// The kernel `k[0..n)` and its prefix sums `kc[j] = sum_{l<j} k[l]`
    /// (length n+1).
    k: Vec<f64>,
    kc: Vec<f64>,
    /// Cascade roots and `1 / peak`.
    d: f64,
    r: f64,
    inv_peak: f64,
    op: LinearOp,
    // Running state of the current nested search.
    acc: Vec<f64>,
    wrap_c: f64,
    wrap_u: f64,
    line_c: f64,
    line_b: f64,
    /// Scratch of the large-batch route.
    batch_spikes: Vec<usize>,
    batch_conv: Vec<f64>,
}

/// `F` in f64: `H(z - line(z)) [+ line(z) with the HP off]`.
struct LinearOp {
    gain: Vec<f64>,
    m: usize,
    hp: bool,
    fwd: Arc<dyn RealToComplex<f64>>,
    inv: Arc<dyn ComplexToReal<f64>>,
    spectrum: Vec<Complex<f64>>,
    scratch_fwd: Vec<Complex<f64>>,
    scratch_inv: Vec<Complex<f64>>,
}

impl LinearOp {
    /// `v <- H v` (circular filter only, no detrend).
    fn circular(&mut self, v: &mut [f64]) {
        let n = v.len();
        // Neither transform can fail on these sizes with finite data; a
        // non-finite value would surface as NaN errors downstream.
        let _ = self
            .fwd
            .process_with_scratch(v, &mut self.spectrum, &mut self.scratch_fwd);
        for (s, &g) in self.spectrum.iter_mut().zip(&self.gain) {
            *s *= g;
        }
        // The real inverse requires zero imaginary DC (and Nyquist) bins.
        self.spectrum[0].im = 0.0;
        if n % 2 == 0 {
            self.spectrum[n / 2].im = 0.0;
        }
        let _ = self
            .inv
            .process_with_scratch(&mut self.spectrum, v, &mut self.scratch_inv);
        let scale = 1.0 / n as f64;
        for x in v.iter_mut() {
            *x *= scale;
        }
    }

    /// `v <- F v`.
    fn apply(&mut self, v: &mut [f64]) {
        let (c, b) = endpoint_line(v, self.m);
        for (i, x) in v.iter_mut().enumerate() {
            *x -= c + b * i as f64;
        }
        self.circular(v);
        if !self.hp {
            for (i, x) in v.iter_mut().enumerate() {
                *x += c + b * i as f64;
            }
        }
    }
}

/// The detrend line of `BandpassFilter` (`endpoint_line`) in f64:
/// `(intercept at 0, slope)` through the means of the first and last `m`
/// samples, anchored at the window centres.
fn endpoint_line(v: &[f64], m: usize) -> (f64, f64) {
    let n = v.len();
    let y0 = v[..m].iter().sum::<f64>() / m as f64;
    let y1 = v[n - m..].iter().sum::<f64>() / m as f64;
    line_through(y0, y1, n, m)
}

#[inline]
fn line_through(y0: f64, y1: f64, n: usize, m: usize) -> (f64, f64) {
    let t0 = (m as f64 - 1.0) / 2.0;
    let slope = (y1 - y0) / (n - m) as f64;
    (y0 - slope * t0, slope)
}

impl Superposition {
    /// Build for an `n`-sample trace, the filter `filter` and kernel
    /// `banded`. `None` when the filter is a no-op at this length or the
    /// kernel has not decayed within the trace.
    fn new(filter: &mut BandpassFilter, banded: &BandedAR2, n: usize) -> Option<Self> {
        let (gain, m, hp) = filter.linear_operator(n)?;
        let (d, r, peak) = banded.cascade();
        let inv_peak = 1.0 / peak;
        // k[0..=n] by the cascade of `BandedAR2::convolve_forward`, in f64.
        let mut k = vec![0.0_f64; n + 1];
        let (mut u, mut c) = (0.0_f64, 0.0_f64);
        for (t, kt) in k.iter_mut().enumerate().skip(1) {
            u = d * u + if t == 1 { inv_peak } else { 0.0 };
            c = r * c + u;
            *kt = c;
        }
        if !k.iter().all(|v| v.is_finite()) || k[n].abs() > 1e-14 {
            return None;
        }
        k.truncate(n);
        let mut kc = vec![0.0_f64; n + 1];
        for j in 0..n {
            kc[j + 1] = kc[j] + k[j];
        }
        let mut planner = RealFftPlanner::<f64>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let mut op = LinearOp {
            gain,
            m,
            hp,
            spectrum: fwd.make_output_vec(),
            scratch_fwd: fwd.make_scratch_vec(),
            scratch_inv: inv.make_scratch_vec(),
            fwd,
            inv,
        };
        let g_dc = op.gain[0];
        let mut g2 = k.clone();
        op.circular(&mut g2);
        g2.extend_from_within(..);
        let mut h_r1 = vec![0.0_f64; n];
        let mut h_e = vec![0.0_f64; n];
        let (mut rp, mut dp, mut e) = (r, 1.0_f64, 0.0_f64);
        for i in 0..n {
            h_r1[i] = rp;
            e = r * e + dp;
            h_e[i] = e;
            rp *= r;
            dp *= d;
        }
        op.circular(&mut h_r1);
        op.circular(&mut h_e);
        let mut h_ramp: Vec<f64> = (0..n).map(|i| i as f64).collect();
        op.circular(&mut h_ramp);
        Some(Self {
            n,
            key: [d.to_bits(), r.to_bits(), peak.to_bits()],
            g2,
            h_r1,
            h_e,
            h_ramp,
            g_dc,
            hp,
            m,
            k,
            kc,
            d,
            r,
            inv_peak,
            op,
            acc: vec![0.0; n],
            wrap_c: 0.0,
            wrap_u: 0.0,
            line_c: 0.0,
            line_b: 0.0,
            batch_spikes: Vec::new(),
            batch_conv: vec![0.0; n],
        })
    }

    fn matches(&self, banded: &BandedAR2, n: usize) -> bool {
        let (d, r, peak) = banded.cascade();
        self.n == n && self.key == [d.to_bits(), r.to_bits(), peak.to_bits()]
    }

    /// Start a new nested search from the empty train.
    fn reset(&mut self) {
        self.acc.fill(0.0);
        self.wrap_c = 0.0;
        self.wrap_u = 0.0;
        self.line_c = 0.0;
        self.line_b = 0.0;
    }

    /// The scalar corrections of one spike's column (see the struct docs),
    /// added with `sign` (+1 adds the spike, -1 removes it).
    fn add_column_scalars(&mut self, t: usize, sign: f64) {
        let (n, m) = (self.n, self.m);
        // C_t = k[n-1-t], U_t = d^(n-1-t) / peak.
        self.wrap_c += sign * self.k[n - 1 - t];
        self.wrap_u += sign * (self.inv_peak * self.d.powi((n - 1 - t) as i32));
        // Window sums of the cut column k[i - t], i in [t, n).
        let w0 = if t < m { self.kc[m - t] } else { 0.0 };
        let w1 = self.kc[n - t] - self.kc[(n - m).max(t) - t];
        let (c, b) = line_through(w0 / m as f64, w1 / m as f64, n, m);
        self.line_c += sign * c;
        self.line_b += sign * b;
    }

    /// Add (`sign` +1) or remove (-1) the columns of the spikes at `ts`. The
    /// shifted templates are contiguous slices of the doubled template
    /// (`shift(H k, t)[i] = g2[n - t + i]`), summed four at a time so the
    /// accumulator is read and written once per four columns (the pass is
    /// memory-bound). Multiplying by +1 is exact, so adding is unchanged.
    fn add_columns(&mut self, ts: &[usize], sign: f64) {
        let n = self.n;
        let g2 = &self.g2;
        let g = |t: usize| &g2[n - t..2 * n - t];
        let (quads, rest) = ts.as_chunks::<4>();
        for &[t0, t1, t2, t3] in quads {
            let quad = g(t0).iter().zip(g(t1)).zip(g(t2)).zip(g(t3));
            for (x, (((&a, &b), &d), &e)) in self.acc.iter_mut().zip(quad) {
                *x += sign * ((a + b) + (d + e));
            }
        }
        for &t in rest {
            for (x, &v) in self.acc.iter_mut().zip(g(t)) {
                *x += sign * v;
            }
        }
        for &t in ts {
            self.add_column_scalars(t, sign);
        }
    }

    /// Add the spikes at `added` to the running train.
    fn add(&mut self, added: &[usize]) {
        self.add_signed(added, 1.0);
    }

    /// Remove the spikes at `removed` from the running train (the train is
    /// linear in its spikes, so a removal is the same column subtracted).
    fn remove(&mut self, removed: &[usize]) {
        self.add_signed(removed, -1.0);
    }

    fn add_signed(&mut self, added: &[usize], sign: f64) {
        if added.is_empty() {
            return;
        }
        #[cfg(test)]
        let columns = added.len() <= SUPERPOSE_MAX_COLUMNS
            && crate::threshold::test_hooks::path()
                != crate::threshold::test_hooks::Path::NestedFft;
        #[cfg(not(test))]
        let columns = added.len() <= SUPERPOSE_MAX_COLUMNS;
        if columns {
            self.add_columns(added, sign);
            return;
        }
        // Large batch: L(K delta) through the f64 operator directly, with
        // K delta by the cascade over the sorted spikes.
        self.batch_spikes.clear();
        self.batch_spikes.extend_from_slice(added);
        self.batch_spikes.sort_unstable();
        let (d, r, inv_peak) = (self.d, self.r, sign * self.inv_peak);
        let (mut u, mut c, mut next) = (0.0_f64, 0.0_f64, 0);
        self.batch_conv[0] = 0.0;
        for t in 1..self.n {
            let mut src = 0.0;
            if next < self.batch_spikes.len() && self.batch_spikes[next] == t - 1 {
                src = inv_peak;
                next += 1;
            }
            u = d * u + src;
            c = r * c + u;
            self.batch_conv[t] = c;
        }
        self.op.apply(&mut self.batch_conv);
        for (a, &v) in self.acc.iter_mut().zip(&self.batch_conv) {
            *a += v;
        }
    }

    /// The running train's `L(K s)`, rounded to f32 into `out`.
    fn write(&self, out: &mut [f32]) {
        let (wc, wu, b) = (self.wrap_c, self.wrap_u, self.line_b);
        let mut konst = -self.line_c * self.g_dc;
        let mut lin = 0.0;
        if !self.hp {
            konst += self.line_c;
            lin = b;
        }
        for (i, o) in out.iter_mut().enumerate() {
            let v = self.acc[i] - wc * self.h_r1[i] - wu * self.h_e[i] - b * self.h_ramp[i]
                + konst
                + lin * i as f64;
            *o = v as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(fs: f64) -> BandpassFilter {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.1, 0.6, fs);
        f.set_hp_enabled(true);
        f.set_lp_enabled(true);
        f
    }

    #[test]
    fn chain_scoring_is_invariant_to_amplitude_and_offset() {
        let n = 600;
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let mut s = vec![0.0_f32; n];
        for p in (50..n - 50).step_by(37) {
            s[p] = 1.0 + (p % 3) as f32;
        }
        let mut k = vec![0.0_f32; n];
        banded.convolve_forward(&s, &mut k);
        let window = crate::baseline::baseline_window(0.6, 30.0);
        let mut y: Vec<f32> = k.iter().map(|&v| 3.0 * v + 7.0).collect();
        Chain::new(Some(filter(30.0)), window).apply(&mut y);
        let mut sc = Scorer::Chain {
            y: &y,
            chain: Box::new(Chain::new(Some(filter(30.0)), window)),
        };
        let mut conv = vec![0.0_f32; n];
        let (e, a, _) = sc.score(&s, &banded, 30, 1, f64::INFINITY, &mut conv);
        let energy: f64 = y.iter().map(|&v| v as f64 * v as f64).sum();
        assert!(e < 1e-8 * energy, "{e} vs {energy}");
        assert!((a - 3.0).abs() < 1e-3, "{a}");
    }
    /// The superposed linear part equals the filter applied to `K s`, for
    /// every filter mode, spikes at both trace ends, and both routes (column
    /// by column, and the f64 FFT batch).
    #[test]
    fn superposition_matches_filtered_reconstruction() {
        let (fs, n) = (300.0, 30_000);
        let banded = BandedAR2::new(0.1, 0.6, fs);
        for (hp, lp) in [(true, true), (true, false), (false, true)] {
            let mut f = BandpassFilter::new();
            f.update_cutoffs(0.1, 0.6, fs);
            f.set_hp_enabled(hp);
            f.set_lp_enabled(lp);
            let mut sp = Superposition::new(&mut f, &banded, n).expect("superposition");
            // Spikes at the very start and end, and spread through the trace.
            let mut spikes = vec![0, 1, n - 2, n - 1];
            let mut st = 7u64;
            while spikes.len() < 4 + 3 * SUPERPOSE_MAX_COLUMNS {
                st = st.wrapping_mul(6364136223846793005).wrapping_add(1);
                let t = (st >> 33) as usize % n;
                if !spikes.contains(&t) {
                    spikes.push(t);
                }
            }
            sp.reset();
            let mut got = vec![0.0_f32; n];
            let mut s = vec![0.0_f32; n];
            let mut taken = 0;
            // Small groups (columns), then one large group (FFT batch).
            for len in [1, 3, 4, 9, SUPERPOSE_MAX_COLUMNS + 1] {
                let group = &spikes[taken..(taken + len).min(spikes.len())];
                sp.add(group);
                for &t in group {
                    s[t] = 1.0;
                }
                taken += group.len();
                sp.write(&mut got);
                let mut want = vec![0.0_f32; n];
                banded.convolve_forward(&s, &mut want);
                f.apply(&mut want);
                let num: f64 = got
                    .iter()
                    .zip(&want)
                    .map(|(&a, &b)| (a as f64 - b as f64).powi(2))
                    .sum();
                let den: f64 = want.iter().map(|&b| (b as f64).powi(2)).sum();
                let rel = (num / den).sqrt();
                assert!(
                    rel < 2e-6,
                    "hp {hp} lp {lp}, {taken} spikes: rel L2 {rel:e}"
                );
            }
        }
    }

    /// Removing spikes from the running train (columns and the FFT batch)
    /// matches the filtered reconstruction of what is left.
    #[test]
    fn superposition_removal_matches_filtered_reconstruction() {
        let (fs, n) = (300.0, 30_000);
        let banded = BandedAR2::new(0.1, 0.6, fs);
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.1, 0.6, fs);
        f.set_hp_enabled(true);
        f.set_lp_enabled(true);
        let mut sp = Superposition::new(&mut f, &banded, n).expect("superposition");
        let mut spikes = vec![0, 1, n - 2, n - 1];
        let mut st = 11u64;
        while spikes.len() < 4 + 3 * SUPERPOSE_MAX_COLUMNS {
            st = st.wrapping_mul(6364136223846793005).wrapping_add(1);
            let t = (st >> 33) as usize % n;
            if !spikes.contains(&t) {
                spikes.push(t);
            }
        }
        sp.reset();
        sp.add(&spikes);
        let mut s = vec![0.0_f32; n];
        spikes.iter().for_each(|&t| s[t] = 1.0);
        let mut got = vec![0.0_f32; n];
        let mut gone = 0;
        // Small removals (columns), then one large removal (FFT batch).
        for len in [1, 3, 4, 9, SUPERPOSE_MAX_COLUMNS + 1] {
            let group = &spikes[gone..gone + len];
            sp.remove(group);
            group.iter().for_each(|&t| s[t] = 0.0);
            gone += len;
            sp.write(&mut got);
            let mut want = vec![0.0_f32; n];
            banded.convolve_forward(&s, &mut want);
            f.apply(&mut want);
            let num: f64 = got
                .iter()
                .zip(&want)
                .map(|(&a, &b)| (a as f64 - b as f64).powi(2))
                .sum();
            let den: f64 = want.iter().map(|&b| (b as f64).powi(2)).sum();
            let rel = (num / den).sqrt();
            assert!(rel < 2e-6, "{gone} removed: rel L2 {rel:e}");
        }
    }

    /// No superposition when the kernel outlasts the trace (its wrap would
    /// not be two-dimensional) or the filter is off.
    #[test]
    fn superposition_declines_short_traces_and_disabled_filters() {
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        assert!(Superposition::new(&mut filter(300.0), &banded, 300).is_none());
        let mut off = filter(300.0);
        off.set_enabled(false);
        assert!(Superposition::new(&mut off, &banded, 30_000).is_none());
    }
}
