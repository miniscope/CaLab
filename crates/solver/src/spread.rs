//! Spreading a native-rate frame mass over its spike-resolution sub-bins
//! (the seam between the native-rate relaxed solve and the 300 Hz
//! binarization; see `indeca::InnerSolve::Native`).
//!
//! The relaxed native-rate solve gives each recorded frame `i` a mass `m_i`
//! (in spike units at the solve's prescale). The threshold binarization runs
//! at the spike-resolution rate (300 Hz) on a vector of `k` sub-bins per
//! frame, and one sub-bin at or above the threshold is one spike. Sub-frame
//! timing is not used anywhere downstream (counts are summed back per
//! frame), so where inside the frame the mass is placed is free; what
//! matters is how many sub-bins a given mass clears a threshold with.
//!
//! Sub-bins are laid out as [`crate::upsample::downsample_binary`] reads them
//! back: frame `i` owns the centred bin `[i k - k/2, i k + k - k/2)`, and its
//! centre sub-bin `i k` carries the frame's own value.
use crate::upsample::upsample_trace;

/// How a frame's mass is laid over its sub-bins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Spread {
    /// Linear interpolation between frame masses: the tent
    /// [`upsample_trace`] applies to the trace itself, so the binarization
    /// sees the same kind of vector it saw from the upsampled solve (whose
    /// relaxed solution spreads a spike over neighbouring sub-bins at about
    /// `1 / k` each). An isolated mass `m` clears a threshold `t` (relative
    /// to the peak mass `M`) with `2 floor(k (1 - t M / m)) + 1` sub-bins
    /// (at most `k`, the frame's own): the count is the width of the tent
    /// above the threshold, not the mass in spike units, and the per-spike
    /// amplitude absorbs the difference (the same tent overcount the
    /// upsampled solve has, see the `indeca` module docs; a frame's count
    /// is capped at `k` by the sub-bins it owns). Other spreads were tried on the experiment
    /// branch (run-length, fraction merging, harmonic); the tent scored best
    /// on timing F1 and is scale-free: scaling the masses scales the vector,
    /// which the peak normalization before the threshold search undoes, so
    /// the binarization does not depend on the solve's prescale.
    Interp,
}

/// Lay the frame masses `x` (one per recorded frame) over `k` sub-bins per
/// frame. Output length `x.len() * k`; the caller normalizes the vector to
/// its interior peak before the threshold search, as the upsampled loop does.
pub(crate) fn spread(x: &[f32], k: usize, rule: Spread) -> Vec<f32> {
    match rule {
        Spread::Interp => upsample_trace(x, k.max(1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upsample::downsample_binary;

    fn binarize(v: &[f32], t: f32) -> Vec<f32> {
        v.iter().map(|&x| if x >= t { 1.0 } else { 0.0 }).collect()
    }

    #[test]
    fn interp_is_the_trace_upsampler() {
        let x = vec![0.0, 1.0, 2.0, 0.0];
        assert_eq!(spread(&x, 10, Spread::Interp), upsample_trace(&x, 10));
        assert_eq!(spread(&x, 1, Spread::Interp), x);
        assert_eq!(spread(&x, 0, Spread::Interp), x);
    }

    #[test]
    fn interp_count_is_the_tent_width_above_the_threshold() {
        // Isolated masses 1 and 2 with peak 2: a threshold t (relative to
        // the peak) keeps 2 floor(k (1 - 2 t / m)) + 1 sub-bins of mass m,
        // at most the k the frame owns, and never fewer for the larger mass.
        let k = 10;
        let x = vec![0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let v = spread(&x, k, Spread::Interp);
        let peak = v.iter().cloned().fold(0.0_f32, f32::max);
        assert_eq!(peak, 2.0);
        for t in [0.3_f32, 0.5, 0.7, 0.95] {
            let c = downsample_binary(&binarize(&v, t * peak), k);
            // (`+ 1e-4`: the tent sub-bin at exactly the threshold counts,
            // and f32 rounding of `k (1 - t M / m)` must not drop it. A
            // frame owns `k` sub-bins, so that is the most it can count.)
            let want = |m: f32| {
                let w = k as f32 * (1.0 - t * peak / m) + 1e-4;
                if w < 0.0 {
                    0.0
                } else {
                    (2.0 * w.floor() + 1.0).min(k as f32)
                }
            };
            assert_eq!(c[2], want(1.0), "t={t} singlet");
            assert_eq!(c[5], want(2.0), "t={t} doublet");
            assert!(
                c[5] <= k as f32 && c[5] >= c[2],
                "t={t}: {} vs {}",
                c[5],
                c[2]
            );
        }
    }
}
