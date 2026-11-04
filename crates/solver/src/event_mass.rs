//! Event-mass quantisation of the native-rate relaxed solution (an
//! experimental candidate family; `indeca::Binarize::EventMass`, not the
//! default).
//!
//! The threshold search reads the relaxed solution's tent: an event's count
//! is the width of its lobe above the threshold. This family reads the
//! event's MASS instead: the relaxed frame masses `x` (spike units at the
//! solve's prescale) are segmented into events, each with a mass `m_e` and
//! a mass-weighted centroid `t_e` (sub-frame, in spike-resolution sub-bins),
//! and a candidate train places `n_e(a) = round(m_e / a)` spikes in
//! consecutive sub-bins centred on `t_e` (never more than one per sub-bin:
//! the refractory pin). The family is indexed by the per-spike amplitude
//! `a`, on [`THRESHOLD_GRID_LEVELS`] levels over `[a_max / k, a_max]` with
//! `a_max` the largest event mass (above it every event vanishes) and `k`
//! the upsample factor (the refractory cap on spikes per frame: below
//! `a_max / k` the largest single-frame event would need more spikes than a
//! frame can hold). Each candidate is scored exactly through the chain and
//! the pick is the threshold search's rule (`select_sparsest`: sparsest
//! within `max(budget, e_min + SE)`).
//!
//! # Segmentation
//!
//! Events are maximal runs of positive frame mass inside the interior,
//! split at interior local minima (a frame whose mass is below both its
//! neighbours starts a new event). The relaxed solve spreads one spike over
//! about three frames (measured 0.24 / 0.50 / 0.20 at f-1 / f / f+1 on the
//! simulation presets), so a run is one event unless the masses dip; two
//! spikes closer than the dip resolution merge into one event of mass 2 and
//! are placed together at the centroid (a timing error of up to one frame).
//!
//! What this family cannot fix: the relaxed solve loses mass on dense cells
//! (measured 0.17-0.49 of a spike within +-2 frames of an isolated event at
//! 1.9 Hz), and a mass-based count inherits that loss as an undercount.
use crate::banded::BandedAR2;
use crate::chain::Scorer;
use crate::threshold::{
    interior_pve, select_sparsest, threshold_grid, NoiseModel, Selection, ThresholdResult,
};

/// One event of the relaxed solution.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Event {
    /// Mass (spike units at the solve's prescale).
    pub mass: f64,
    /// Mass-weighted centre in sub-bins of the spike-resolution grid
    /// (frame `i` sits at `i * k`).
    pub centre: f64,
}

/// Segment the frame masses `x` over the interior `[lo, hi)` into events.
pub(crate) fn segment(x: &[f32], k: usize, lo: usize, hi: usize) -> Vec<Event> {
    let k = k.max(1);
    let hi = hi.min(x.len());
    let mut out = Vec::new();
    let mut i = lo;
    while i < hi {
        if x[i] <= 0.0 {
            i += 1;
            continue;
        }
        // Run start: extend while positive and not past an interior local
        // minimum.
        let start = i;
        let mut end = i + 1;
        while end < hi && x[end] > 0.0 {
            let is_min = end + 1 < hi && x[end] < x[end - 1] && x[end] < x[end + 1];
            if is_min && end > start {
                break;
            }
            end += 1;
        }
        let mut mass = 0.0_f64;
        let mut moment = 0.0_f64;
        for (j, &v) in x.iter().enumerate().take(end).skip(start) {
            mass += v as f64;
            moment += (j * k) as f64 * v as f64;
        }
        if mass > 0.0 {
            out.push(Event {
                mass,
                centre: moment / mass,
            });
        }
        i = end;
    }
    out
}

/// Place `n` spikes per event (`counts[e]`) around the events' centres into
/// `s` (0/1 per sub-bin), inside `[pad, n_up - pad)`. Returns the number
/// placed.
fn place(events: &[Event], counts: &[usize], pad: usize, s: &mut [f32]) -> usize {
    s.iter_mut().for_each(|v| *v = 0.0);
    let n = s.len();
    let hi = n.saturating_sub(pad);
    if hi <= pad {
        return 0;
    }
    let mut total = 0usize;
    for (e, &c) in events.iter().zip(counts) {
        if c == 0 {
            continue;
        }
        let centre = e.centre.round() as isize;
        let mut first = centre - (c as isize) / 2;
        first = first.clamp(pad as isize, (hi as isize - c as isize).max(pad as isize));
        let mut placed = 0usize;
        let mut j = first as usize;
        while placed < c && j < hi {
            if s[j] == 0.0 {
                s[j] = 1.0;
                placed += 1;
            }
            j += 1;
        }
        total += placed;
    }
    total
}

/// Run the event-mass search. `x` are the native-rate frame masses, the
/// candidates are scored on the spike-resolution grid (`scorer`, `banded`
/// at the upsampled rate, every `k`-th sample of `[pad, n_up - pad)`).
/// Returns the pick as a [`ThresholdResult`] (`threshold` is the picked
/// per-spike amplitude relative to `a_max`) and the number of chain passes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn event_mass_search(
    x: &[f32],
    k: usize,
    lo: usize,
    hi: usize,
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    selection: Selection,
    noise: Option<NoiseModel>,
) -> (ThresholdResult, usize) {
    let k = k.max(1);
    let n = scorer.target().len();
    let events = segment(x, k, lo, hi);
    let a_max = events.iter().map(|e| e.mass).fold(0.0_f64, f64::max);
    let mut s = vec![0.0_f32; n];
    let mut conv = vec![0.0_f32; n];
    if a_max <= 0.0 || n == 0 {
        let baseline = if n == 0 {
            0.0
        } else {
            scorer.target().iter().map(|&v| v as f64).sum::<f64>() / n as f64
        };
        return (
            ThresholdResult {
                s_binary: s,
                alpha: 0.0,
                baseline,
                threshold: 0.0,
                pve: 0.0,
                error: f64::INFINITY,
                noise_path: false,
                diag: Default::default(),
            },
            0,
        );
    }
    // Levels ascending in `a` (relative to a_max): the last is the sparsest.
    let levels = threshold_grid(1.0 / k as f64);
    let mut errors = vec![f64::INFINITY; levels.len()];
    let mut alphas = vec![0.0_f64; levels.len()];
    let mut counts = vec![0.0_f64; levels.len()];
    let mut per_event = vec![0usize; events.len()];
    let mut last_count = usize::MAX;
    let mut last = (f64::INFINITY, 0.0_f64);
    let mut passes = 0usize;
    for (i, &rel) in levels.iter().enumerate().rev() {
        let a = rel * a_max;
        for (c, e) in per_event.iter_mut().zip(&events) {
            *c = (e.mass / a).round().max(0.0) as usize;
        }
        let count = place(&events, &per_event, pad, &mut s);
        if count != last_count {
            passes += 1;
            let (e, al, _) = scorer.score(&s, banded, pad, k, f64::INFINITY, &mut conv);
            last = (e, al);
            last_count = count;
        }
        errors[i] = last.0;
        alphas[i] = last.1;
        counts[i] = count as f64;
    }
    let n_grid = (pad..n.saturating_sub(pad)).step_by(k).count();
    let sel = select_sparsest(
        &errors,
        &alphas,
        &counts,
        (0..levels.len()).rev(),
        selection,
        noise,
        n_grid,
    );
    let pick = sel.index;
    let a = levels[pick] * a_max;
    for (c, e) in per_event.iter_mut().zip(&events) {
        *c = (e.mass / a).round().max(0.0) as usize;
    }
    place(&events, &per_event, pad, &mut s);
    passes += 1;
    let (_, alpha, baseline) = scorer.score(&s, banded, pad, k, f64::INFINITY, &mut conv);
    let pve = interior_pve(scorer.target(), &conv, alpha, baseline, pad);
    (
        ThresholdResult {
            s_binary: s,
            alpha,
            baseline,
            threshold: levels[pick],
            pve,
            error: errors[pick],
            noise_path: sel.noise_path,
            diag: sel.diag,
        },
        passes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segmentation_splits_at_local_minima_and_keeps_mass() {
        // Two humps separated by a dip, and an isolated frame.
        let x = [0.0, 0.2, 0.6, 0.2, 0.1, 0.3, 0.5, 0.0, 0.0, 1.0, 0.0];
        let ev = segment(&x, 10, 0, x.len());
        assert_eq!(ev.len(), 3, "{ev:?}");
        assert!((ev[0].mass - 1.0).abs() < 1e-6);
        assert!((ev[0].centre - 20.0).abs() < 1e-6);
        assert!((ev[1].mass - 0.9).abs() < 1e-6);
        assert!((ev[2].mass - 1.0).abs() < 1e-6 && (ev[2].centre - 90.0).abs() < 1e-6);
        let total: f64 = ev.iter().map(|e| e.mass).sum();
        assert!((total - x.iter().map(|&v| v as f64).sum::<f64>()).abs() < 1e-6);
    }

    #[test]
    fn recovers_counts_of_clean_events_including_a_doublet() {
        // Frame masses of three events (1, 2, 1 spikes) spread over three
        // frames each; the clean trace is the 300 Hz truth. The sparsest
        // within the (zero) allowance is the exact count per event.
        let k = 10;
        let n_nat = 400;
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        let mut x = vec![0.0_f32; n_nat];
        let mut truth = vec![0.0_f32; n_nat * k];
        for (f, c) in [(80usize, 1usize), (200, 2), (320, 1)] {
            x[f - 1] = 0.25 * c as f32;
            x[f] = 0.5 * c as f32;
            x[f + 1] = 0.25 * c as f32;
            for j in 0..c {
                truth[f * k + j] = 1.0;
            }
        }
        let mut y = vec![0.0_f32; n_nat * k];
        banded.convolve_forward(&truth, &mut y);
        let y: Vec<f32> = y.iter().map(|&v| 3.0 * v + 0.5).collect();
        let mut sc = Scorer::Plain { y: &y };
        let (r, passes) = event_mass_search(
            &x,
            k,
            20,
            n_nat - 20,
            &mut sc,
            &banded,
            200,
            Selection::MaxPve,
            None,
        );
        let counts = crate::upsample::downsample_binary(&r.s_binary, k);
        assert_eq!(counts[80], 1.0);
        assert_eq!(counts[200], 2.0);
        assert_eq!(counts[320], 1.0);
        assert_eq!(counts.iter().sum::<f32>(), 4.0);
        assert!((r.alpha - 3.0).abs() < 0.05, "{}", r.alpha);
        assert!(passes <= crate::threshold::THRESHOLD_GRID_LEVELS + 1);
        for (j, &v) in r.s_binary.iter().enumerate() {
            assert!(v == 0.0 || (j >= 200 && j < n_nat * k - 200));
        }
    }

    #[test]
    fn empty_mass_is_handled() {
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        let y = vec![1.0_f32; 100];
        let mut sc = Scorer::Plain { y: &y };
        let x = vec![0.0_f32; 10];
        let (r, p) = event_mass_search(
            &x,
            10,
            0,
            10,
            &mut sc,
            &banded,
            5,
            Selection::NoiseFloor,
            None,
        );
        assert_eq!(p, 0);
        assert!(r.s_binary.iter().all(|&v| v == 0.0));
    }
}
