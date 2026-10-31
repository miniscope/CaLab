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
//!   end-to-start difference, spread over 8-45 s at both ends;
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
//! Cost: one pass of the chain per distinct candidate (110-200 per trace on
//! the 300 Hz loop): the trace's own FFT bandpass and the O(n)
//! [`RollingQuantile`], both producing the same bits the trace got. The
//! output is therefore identical to filtering and baselining each candidate
//! from scratch (pick hash checked on the characterization set).
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

/// The preprocessing chain `C(z) = F(z) - RQ(F(z))` of `indeca::prepare`.
///
/// Scoring a candidate costs one pass of the chain. The bandpass is the
/// trace's own `BandpassFilter` (its FFT plans and gain curve are cached, so
/// a pass is one forward and one inverse FFT), and the rolling quantile is
/// the O(n) [`RollingQuantile`] with its buffers kept across candidates.
pub(crate) struct Chain {
    /// The bandpass, when it was applied to the trace.
    filter: Option<BandpassFilter>,
    /// Rolling-quantile window (samples).
    window: usize,
    quantile: RollingQuantile,
}

impl Chain {
    pub(crate) fn new(filter: Option<BandpassFilter>, window: usize) -> Self {
        Self {
            filter,
            window,
            quantile: RollingQuantile::new(),
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
        let y = self.target();
        let (alpha, baseline) = lstsq_alpha_baseline(conv, y, pad, max_alpha);
        let n = y.len();
        let mut err = 0.0_f64;
        for i in (pad..n.saturating_sub(pad)).step_by(stride.max(1)) {
            let d = y[i] as f64 - (alpha * conv[i] as f64 + baseline);
            err += d * d;
        }
        (err, alpha, baseline)
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
}
