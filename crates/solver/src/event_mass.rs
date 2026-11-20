//! Event-mass binarization of the native-rate relaxed solution: the spike
//! counts per frame the InDeCa pipeline reports.
//!
//! Everything here runs at the recorded frame rate; nothing is upsampled.
//! The relaxed solve (`native_solve`) gives each frame `j` a mass `x_j` (in
//! units of the solve's prescale), boxed to `[0, cap]` spikes' worth with
//! `cap = max(1, round(max_firing_rate / fs))`, the most spikes a frame can
//! hold. This module turns the masses into integer spike counts per frame
//! (0..=cap).
//!
//! # Events and counts
//!
//! The interior frames (the edge zone of `2 tau_decay` at each end is
//! excluded) are cut into **events**: maximal runs of positive mass. A run
//! is not split at local minima, so a long burst is one event whatever the
//! noise does to its profile. A spike size `a` turns each event's mass `m_e`
//! into `n_e(a) = round(m_e / a)` spikes.
//!
//! # Placement
//!
//! The `n` spikes of an event go where its cumulative mass crosses
//! `(i - 1/2) / n`, `i = 1..=n` (the quantiles of the mass profile, so a
//! burst keeps its shape and extent); a single spike goes to the centroid
//! frame. A frame holds an integer count up to `cap`; a spike whose frame is
//! full moves to the nearest frame of the event's span with room. If the
//! whole span is full, the spike cannot be placed and is recorded in
//! [`EventMassDiag::dropped_spikes`] (the count never exceeds what the span
//! can hold).
//!
//! # The size search and the pick
//!
//! `a` is swept over [`THRESHOLD_GRID_LEVELS`] levels on `[frame_max / cap,
//! a_max]`, with `frame_max` the largest single-frame interior mass and
//! `a_max` the largest event mass (above it every event vanishes). The
//! floor `frame_max / cap` is the densest allowed train: at that size the
//! busiest frame holds exactly `cap` spikes, so no frame is asked for more
//! than it can hold. Each candidate train is scored exactly through the
//! trace's own preprocessing chain ([`Scorer`]), with the amplitude and
//! offset fit freely, and compared with `E_relaxed`, the score of the
//! continuous relaxed solution `x` itself through the same scorer: how much
//! error does quantizing the relaxed solution into whole spikes of size `a`
//! cost?
//!
//! The pick is the **largest** `a` whose cost `E_q(a) - E_relaxed` is at most
//! one standard error of the noise energy ([`NoiseModel::std_error`] over the
//! interior): the sparsest quantization the data cannot tell from the
//! relaxed fit. If none qualifies (the relaxed fit is out of reach of every
//! whole-spike train, which is the usual case once the cap binds), the pick
//! is the size on the grid that fits the data best, `argmin E_q(a)`;
//! without a noise model it is the floor. There is
//! no penalty on the spike count: sparsity comes from the quantization (a
//! size a, an integer count) and from the fit ceiling alone.
//!
//! The relaxed solution these masses come from is the exact optimum of the
//! relaxed problem (interior point; `ipm`), so the floor `frame_max / cap`
//! is a property of the data and not of where an iteration happened to stop.
//!
//! # Diagnostics
//!
//! [`EventMassDiag`] reports, per cell and without acting on them:
//! `cap_limited` (the pick ended at the floor, so the cap set the spike
//! size), `no_size_fit` (no size passed the one-SE test, so the best-fitting
//! size was used), `peak_outlier_ratio`
//! (one frame dominating the floor) and `dropped_spikes` (spikes that could
//! not be placed).
use crate::banded::BandedAR2;
use crate::chain::Scorer;
use crate::threshold::{interior_pve, threshold_grid, NoiseModel};

/// The size-pick rule in effect. Production always uses [`DEFAULT_MODE`]; the
/// evaluation harnesses (`eval_exact_vs_fista`) switch it to compare the
/// alternatives:
///
/// | mode | spike-size floor | when no size is within one SE |
/// |---|---|---|
/// | 0 | busiest frame / cap | the floor |
/// | 1 | event span | the floor |
/// | 2 | event span | the best-fitting size |
/// | 3 | busiest frame / cap | the best-fitting size (default) |
/// | 4 | busiest frame / cap | (one-SE rule against the best-fitting size) |
/// | 5 | event span | (one-SE rule against the best-fitting size) |
///
/// The event-span floor is `max_e m_e / (cap * len_e)`: the smallest size at
/// which every event fits its own span at `cap` spikes per frame.
///
/// Open question: the busiest-frame floor ties a cell's scale to one extreme
/// frame of the relaxed solution (artifact-sensitive; the exact solve is
/// peakier than early-stopped FISTA, which costs bursting slow-indicator
/// cells F1). The event-span floor fixes bursts but loses on fast
/// indicators. A better floor is worth investigating later.
pub(crate) const DEFAULT_MODE: u8 = 3;

#[cfg(test)]
thread_local! {
    /// Per-thread override of the pick rule (255 = use [`GLOBAL_MODE`]).
    pub(crate) static FLOOR_MODE: std::cell::Cell<u8> = const { std::cell::Cell::new(255) };
}
/// Process-wide pick rule for tests that solve on worker threads.
#[cfg(test)]
pub(crate) static GLOBAL_MODE: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(DEFAULT_MODE);

fn mode() -> u8 {
    #[cfg(test)]
    {
        let local = FLOOR_MODE.with(|m| m.get());
        if local != 255 {
            return local;
        }
        GLOBAL_MODE.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(not(test))]
    DEFAULT_MODE
}

/// One event of the relaxed solution.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Event {
    /// Mass (units of the solve's prescale; `mass / a` is a spike count).
    pub mass: f64,
    /// Mass-weighted centre, in frames.
    pub centre: f64,
    /// Frames `[start, end)` the event spans.
    pub start: usize,
    pub end: usize,
    /// Largest single-frame mass inside the event.
    pub peak: f64,
}

/// Per-cell diagnostics of the binarization. None of them changes the result.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct EventMassDiag {
    /// Chain-scored error of the continuous relaxed solution (0 without a
    /// noise model, where it is not computed).
    pub e_relaxed: f64,
    /// One standard error of the noise energy over the interior (0 without a
    /// noise model).
    pub std_error: f64,
    /// Chain-scored error of the picked train.
    pub e_pick: f64,
    /// Picked spike size, the floor and the largest event mass (units of the
    /// solve's prescale).
    pub a_pick: f64,
    pub a_floor: f64,
    pub a_max: f64,
    /// Spikes placed at the pick.
    pub count_pick: f64,
    /// The pick ended at the floor size `frame_max / cap` (the densest train
    /// the cap allows): the cap, not the data, set the spike size. With no
    /// size inside one SE, the best-fitting size is picked and it ends at the
    /// floor when no coarser size fits better. Always
    /// true without a noise model, where the floor is the rule.
    pub cap_limited: bool,
    /// A noise model was available and no spike size passed the one-SE test
    /// against the relaxed solution, so the best-fitting size on the grid
    /// was taken (which is the floor when finer quantization only fits
    /// better, the usual case).
    pub no_size_fit: bool,
    /// Largest event-peak frame mass over the second largest (each event's
    /// peak being its largest single-frame mass): how much one event
    /// dominates the floor `frame_max / cap`. 1 with fewer than two events
    /// (0 with none).
    pub peak_outlier_ratio: f64,
    /// Spikes the picked size asked for that no frame of their event's span
    /// had room for.
    pub dropped_spikes: u32,
}

/// The result of [`event_mass_search`].
pub(crate) struct EventMassResult {
    /// Integer spike count per frame (`0..=cap`), native length.
    pub counts: Vec<f32>,
    pub alpha: f64,
    pub baseline: f64,
    pub pve: f64,
    /// Chain-scored error of the picked train.
    pub error: f64,
    pub diag: EventMassDiag,
}

/// Cut the frame masses `x` over the interior `[lo, hi)` into events:
/// maximal runs of positive mass.
pub(crate) fn segment(x: &[f32], lo: usize, hi: usize) -> Vec<Event> {
    let hi = hi.min(x.len());
    let mut out = Vec::new();
    let mut i = lo;
    while i < hi {
        if x[i] <= 0.0 {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        while end < hi && x[end] > 0.0 {
            end += 1;
        }
        let (mut mass, mut moment, mut peak) = (0.0_f64, 0.0_f64, 0.0_f64);
        for (j, &v) in x.iter().enumerate().take(end).skip(start) {
            mass += v as f64;
            moment += j as f64 * v as f64;
            peak = peak.max(v as f64);
        }
        out.push(Event {
            mass,
            centre: moment / mass,
            start,
            end,
            peak,
        });
        i = end;
    }
    out
}

/// Place `n` spikes of event `e` into `s` (an integer count per frame, each
/// at most `cap`). Spike `i` of `n` goes to the frame where the event's
/// cumulative mass reaches `(i + 1/2) / n` of its total (the centroid frame
/// for `n = 1`); a full frame sends the spike to the nearest frame of the
/// event's span with room. Returns the number placed (less than `n` only
/// when the span is full).
fn place_event(e: &Event, x: &[f32], n: usize, cap: f32, s: &mut [f32]) -> usize {
    let len = e.end - e.start;
    if n == 0 || len == 0 {
        return 0;
    }
    // cum[m] = event mass in frames [start, start + m).
    let mut cum = Vec::with_capacity(len + 1);
    cum.push(0.0_f64);
    for j in e.start..e.end {
        cum.push(cum[j - e.start] + x[j].max(0.0) as f64);
    }
    let total = cum[len];
    let mut placed = 0usize;
    for i in 0..n {
        let target = if n == 1 {
            (e.centre.round() as isize - e.start as isize).clamp(0, len as isize - 1) as usize
        } else {
            let t = (i as f64 + 0.5) / n as f64 * total;
            // First frame whose cumulative mass reaches t.
            cum.partition_point(|&c| c < t)
                .saturating_sub(1)
                .min(len - 1)
        };
        for d in 0..len {
            let below = target.checked_sub(d);
            let above = (target + d < len).then_some(target + d);
            let slot = [below, above]
                .into_iter()
                .flatten()
                .find(|&b| s[e.start + b] < cap);
            if let Some(b) = slot {
                s[e.start + b] += 1.0;
                placed += 1;
                break;
            }
        }
    }
    placed
}

/// Per-event counts `round(m_e / a)` at spike size `a`.
fn counts_at(events: &[Event], a: f64, out: &mut [usize]) {
    for (c, e) in out.iter_mut().zip(events) {
        *c = (e.mass / a).round().max(0.0) as usize;
    }
}

/// Place every event's `counts[e]` spikes into `s` (cleared first). Returns
/// the number placed.
fn place_all(events: &[Event], x: &[f32], counts: &[usize], cap: usize, s: &mut [f32]) -> usize {
    s.iter_mut().for_each(|v| *v = 0.0);
    events
        .iter()
        .zip(counts)
        .map(|(e, &c)| place_event(e, x, c, cap as f32, s))
        .sum()
}

/// The frames where `next` gains (`added`) or loses (`removed`) spikes
/// relative to `prev`: one entry per spike gained or lost.
fn diff(prev: &[f32], next: &[f32], added: &mut Vec<usize>, removed: &mut Vec<usize>) {
    added.clear();
    removed.clear();
    for (j, (&p, &q)) in prev.iter().zip(next).enumerate() {
        if q > p {
            added.extend(std::iter::repeat_n(j, (q - p).round() as usize));
        } else if q < p {
            removed.extend(std::iter::repeat_n(j, (p - q).round() as usize));
        }
    }
}

/// The relaxed solution restricted to the interior (the edge zone carries no
/// spikes in any candidate, so it carries none here).
fn relaxed_profile(x: &[f32], lo: usize, hi: usize, out: &mut [f32]) {
    out.iter_mut().for_each(|v| *v = 0.0);
    for j in lo..hi.min(x.len()) {
        out[j] = x[j].max(0.0);
    }
}

/// Run the event-mass search. `x` are the frame masses of the relaxed
/// native-rate solve; candidates are scored through `scorer` with `banded`
/// over the interior `[pad, n - pad)`. `cap` is the most spikes one frame
/// holds. `noise` (the interior's noise model) enables the one-SE pick;
/// without it the pick is the floor.
pub(crate) fn event_mass_search(
    x: &[f32],
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    cap: usize,
    noise: Option<NoiseModel>,
) -> EventMassResult {
    let n = scorer.target().len();
    let cap = cap.max(1);
    let (lo, hi) = (pad.min(n), n.saturating_sub(pad));
    let events = if lo < hi { segment(x, lo, hi) } else { vec![] };
    let a_max = events.iter().map(|e| e.mass).fold(0.0_f64, f64::max);
    let mut s = vec![0.0_f32; n];
    let mut conv = vec![0.0_f32; n];
    if a_max <= 0.0 || n == 0 {
        let baseline = if n == 0 {
            0.0
        } else {
            scorer.target().iter().map(|&v| v as f64).sum::<f64>() / n as f64
        };
        return EventMassResult {
            counts: s,
            alpha: 0.0,
            baseline,
            pve: 0.0,
            error: f64::INFINITY,
            diag: EventMassDiag::default(),
        };
    }
    let frame_max = x[lo..hi].iter().fold(0.0_f64, |m, &v| m.max(v as f64));
    let a_floor = if matches!(mode(), 1 | 2 | 5) {
        // Every event fits its own span at `cap` spikes per frame.
        events
            .iter()
            .map(|e| e.mass / (cap as f64 * (e.end - e.start) as f64))
            .fold(0.0_f64, f64::max)
    } else {
        frame_max / cap as f64
    };
    let floor_rel = (a_floor / a_max).clamp(1e-6, 1.0);
    // Levels ascending in `a` (relative to a_max): the last is the sparsest.
    let levels = threshold_grid(floor_rel);
    let mut errors = vec![f64::INFINITY; levels.len()];
    let mut per_event = vec![0usize; events.len()];
    let mut last_requested = usize::MAX;
    let mut last_error = f64::INFINITY;
    // Sparsest first. Consecutive candidates differ by a few spikes, so
    // where the chain allows it each candidate is scored from the previous
    // one by superposition, adding the spikes it gains and removing the ones
    // it loses (`Scorer::score_changed`).
    let nested = scorer.begin_nested(banded, n);
    let mut prev = vec![0.0_f32; n];
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    for (i, &rel) in levels.iter().enumerate().rev() {
        counts_at(&events, rel * a_max, &mut per_event);
        let requested: usize = per_event.iter().sum();
        // Counts only grow as `a` falls, so an unchanged total is an
        // unchanged train: reuse its error instead of rescoring.
        if requested != last_requested {
            place_all(&events, x, &per_event, cap, &mut s);
            last_error = if nested {
                diff(&prev, &s, &mut added, &mut removed);
                prev.copy_from_slice(&s);
                scorer
                    .score_changed(&added, &removed, pad, f64::INFINITY, &mut conv)
                    .0
            } else {
                scorer.score(&s, banded, pad, f64::INFINITY, &mut conv).0
            };
            last_requested = requested;
        }
        errors[i] = last_error;
    }
    let n_grid = hi - lo;
    let mut diag = EventMassDiag {
        a_floor,
        a_max,
        peak_outlier_ratio: peak_outlier_ratio(&events),
        ..Default::default()
    };
    let pick = match noise {
        Some(nm) => {
            let mut prof = vec![0.0_f32; n];
            relaxed_profile(x, lo, hi, &mut prof);
            let (e_rel, _, _) = scorer.score(&prof, banded, pad, f64::INFINITY, &mut conv);
            let se = nm.std_error(n_grid);
            diag.e_relaxed = e_rel;
            diag.std_error = se;
            // Largest size whose quantization cost is within one SE of the
            // relaxed fit (of the best-fitting size in modes 4 and 5).
            let reference = if matches!(mode(), 4 | 5) {
                errors.iter().cloned().fold(f64::INFINITY, f64::min)
            } else {
                e_rel
            };
            let fit = (0..levels.len())
                .rev()
                .find(|&i| errors[i] - reference <= se);
            diag.no_size_fit = fit.is_none();
            // With none, the size that fits the data best (modes 0 and 1: the floor).
            let fallback = if matches!(mode(), 2 | 3) {
                (0..levels.len())
                    .min_by(|&p, &q| errors[p].total_cmp(&errors[q]))
                    .unwrap_or(0)
            } else {
                0
            };
            fit.unwrap_or(fallback)
        }
        None => 0,
    };
    diag.cap_limited = pick == 0;
    diag.a_pick = levels[pick] * a_max;
    diag.e_pick = errors[pick];
    counts_at(&events, diag.a_pick, &mut per_event);
    let requested: usize = per_event.iter().sum();
    let placed = place_all(&events, x, &per_event, cap, &mut s);
    diag.dropped_spikes = (requested - placed) as u32;
    diag.count_pick = placed as f64;
    let (_, alpha, baseline) = scorer.score(&s, banded, pad, f64::INFINITY, &mut conv);
    let pve = interior_pve(scorer.target(), &conv, alpha, baseline, pad);
    EventMassResult {
        counts: s,
        alpha,
        baseline,
        pve,
        error: errors[pick],
        diag,
    }
}

/// The binarization at a GIVEN spike size `a` (units of the solve's
/// prescale): counts from [`unit_counts`], placed exactly as in
/// [`event_mass_search`] (per-frame ceiling `cap` unchanged), amplitude and
/// offset fit by the scorer for the pve. No size search, no floor.
pub(crate) fn event_mass_at(
    x: &[f32],
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    cap: usize,
    a: f64,
    occupancy: Option<(f64, f64, f64, f64)>,
) -> EventMassResult {
    let n = scorer.target().len();
    let cap = cap.max(1);
    let (lo, hi) = (pad.min(n), n.saturating_sub(pad));
    let events = if lo < hi { segment(x, lo, hi) } else { vec![] };
    let a_max = events.iter().map(|e| e.mass).fold(0.0_f64, f64::max);
    let mut s = vec![0.0_f32; n];
    let mut conv = vec![0.0_f32; n];
    if a_max <= 0.0 || n == 0 || a.is_nan() || a <= 0.0 {
        let baseline = if n == 0 {
            0.0
        } else {
            scorer.target().iter().map(|&v| v as f64).sum::<f64>() / n as f64
        };
        return EventMassResult {
            counts: s,
            alpha: 0.0,
            baseline,
            pve: 0.0,
            error: f64::INFINITY,
            diag: EventMassDiag::default(),
        };
    }
    let frame_max = x[lo..hi].iter().fold(0.0_f64, |m, &v| m.max(v as f64));
    let per_event = unit_counts(&events, a, occupancy);
    let requested: usize = per_event.iter().sum();
    let placed = place_all(&events, x, &per_event, cap, &mut s);
    let (error, alpha, baseline) = scorer.score(&s, banded, pad, f64::INFINITY, &mut conv);
    let pve = interior_pve(scorer.target(), &conv, alpha, baseline, pad);
    let diag = EventMassDiag {
        a_pick: a,
        a_floor: frame_max / cap as f64,
        a_max,
        e_pick: error,
        count_pick: placed as f64,
        dropped_spikes: (requested - placed) as u32,
        peak_outlier_ratio: peak_outlier_ratio(&events),
        ..Default::default()
    };
    EventMassResult {
        counts: s,
        alpha,
        baseline,
        pve,
        error,
        diag,
    }
}

/// Per-event counts at the unit `a`. Without `occupancy`: `round(m_e / a)`. With it (the unit estimator's level
/// model `(q, g, s_, rho)`): each run is classed as noise or event ([`occupancy_fit`]); noise runs count 0, event
/// runs `max(round(z), 1)`, and where the burst rule's `n^2 / n1` total is the smaller, its counts ([`burst_counts`]).
fn unit_counts(events: &[Event], a: f64, occupancy: Option<(f64, f64, f64, f64)>) -> Vec<usize> {
    let mut per_event = vec![0usize; events.len()];
    counts_at(events, a, &mut per_event);
    if let Some((q, g, s_, rho)) = occupancy {
        let z: Vec<f64> = events.iter().map(|e| e.mass / a).collect();
        if let Some((keep, p0, w1)) = occupancy_fit(&z, q, g, s_, rho) {
            for ((c, k), zz) in per_event.iter_mut().zip(&keep).zip(&z) {
                *c = if *k {
                    (zz.round().max(1.0)) as usize
                } else {
                    0
                };
            }
            if let Some(cb) = burst_counts(&z, &keep, p0, w1) {
                per_event = cb;
            }
        }
    }
    per_event
}

/// The burst-count rule. From the occupancy fit: `n = n_runs (1 - pi0)` events, `n1 = n_runs w1` singles (`w1` =
/// mean posterior of the N = 1 class). When `T = n^2 / n1` is below the summed masses of the event runs, the cell
/// total is `max(round(T), K)` (K event runs), shared by rank ([`allot`]); otherwise `None` (the per-run counts
/// stand).
fn burst_counts(z: &[f64], keep: &[bool], p0: f64, w1: f64) -> Option<Vec<usize>> {
    let nr = z.len() as f64;
    let (n, n1) = (nr * (1.0 - p0), nr * w1);
    let zk: Vec<f64> = z
        .iter()
        .zip(keep)
        .filter(|(_, k)| **k)
        .map(|(v, _)| *v)
        .collect();
    let sum: f64 = zk.iter().sum();
    let t1 = if n1 > 0.0 { n * n / n1 } else { f64::INFINITY };
    if t1.partial_cmp(&sum) != Some(std::cmp::Ordering::Less) {
        return None;
    }
    let mut ck = allot(&zk, (t1 + 0.5).floor() as usize, 1.0 - n1 / n).into_iter();
    Some(
        keep.iter()
            .map(|&k| if k { ck.next().unwrap() } else { 0 })
            .collect(),
    )
}

/// Integer counts for events of masses `zk`, each at least 1, summing to `max(total, K)`: the counts beyond one per
/// event go in proportion to `N_i - 1`, `N_i = 1 + floor(ln(r_i / K) / ln(rho_hat))`, `r_i` the rank by mass from the
/// top (in proportion to the mass if every `N_i` is 1); largest remainders, ties to the larger mass.
fn allot(zk: &[f64], total: usize, rho_hat: f64) -> Vec<usize> {
    let k = zk.len();
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by(|&i, &j| zk[j].total_cmp(&zk[i])); // stable: ties keep the earlier run first
    let mut r = vec![0.0_f64; k];
    order
        .iter()
        .enumerate()
        .for_each(|(pos, &i)| r[i] = (pos + 1) as f64);
    let mut w: Vec<f64> = if rho_hat > 0.0 && rho_hat < 1.0 {
        r.iter()
            .map(|ri| ((ri / k as f64).ln() / rho_hat.ln()).floor())
            .collect()
    } else {
        vec![0.0; k]
    };
    if w.iter().sum::<f64>() <= 0.0 {
        w = zk.to_vec();
    }
    let sw: f64 = w.iter().sum();
    let e = total.saturating_sub(k) as f64;
    let share: Vec<f64> = w.iter().map(|wi| e * wi / sw).collect();
    let mut c: Vec<usize> = share.iter().map(|v| v.floor() as usize).collect();
    let left = (e as usize).saturating_sub(c.iter().sum::<usize>());
    let mut top: Vec<usize> = (0..k).collect();
    top.sort_by(|&i, &j| {
        (share[j] - c[j] as f64)
            .total_cmp(&(share[i] - c[i] as f64))
            .then(r[i].total_cmp(&r[j]))
    });
    top.iter().take(left).for_each(|&i| c[i] += 1);
    c.iter().map(|v| v + 1).collect()
}

/// Posterior occupancy of the relaxed runs. The run masses
/// in units `z` follow `pi0 * halfnormal(s) + (1 - pi0) * sum_N (1 - rho) rho^(N-1)
/// Normal(N^q, s^2 + (cv_N N^q)^2)`, `cv_N = sqrt(g^2 / N + s_^2 [N > 1])` (the unit
/// estimator's own level model, unit fixed). `pi0` and `s` by EM. Returns which runs are
/// more probably events than noise, the fitted `pi0`, and the mean posterior probability of the
/// single-spike class (the burst rule's `w1`); `None` when the fit has no event class (the
/// `round(m / a)` counts then stand) or there are no runs.
fn occupancy_fit(z: &[f64], q: f64, g: f64, s_: f64, rho: f64) -> Option<(Vec<bool>, f64, f64)> {
    if z.is_empty() {
        return None;
    }
    let sq2pi = (2.0 * std::f64::consts::PI).sqrt();
    let zmax = z.iter().cloned().fold(f64::MIN, f64::max);
    let nmax = (((zmax + 1.0).powf(1.0 / q)).ceil() + 2.0).max(3.0) as usize;
    let lev: Vec<f64> = (1..=nmax).map(|n| (n as f64).powf(q)).collect();
    let cv: Vec<f64> = (1..=nmax)
        .map(|n| (g * g / n as f64 + if n > 1 { s_ * s_ } else { 0.0 }).sqrt())
        .collect();
    let mut w: Vec<f64> = (1..=nmax)
        .map(|n| (1.0 - rho) * rho.powi(n as i32 - 1))
        .collect();
    let ws: f64 = w.iter().sum();
    w.iter_mut().for_each(|v| *v /= ws);
    let f1 = |zz: f64, s: f64| -> f64 {
        (0..nmax)
            .map(|k| {
                let sd = (s * s + (cv[k] * lev[k]).powi(2)).sqrt();
                w[k] * (-0.5 * ((zz - lev[k]) / sd).powi(2)).exp() / (sd * sq2pi)
            })
            .sum()
    };
    let f0 = |zz: f64, s: f64| 2.0 * (-0.5 * (zz / s).powi(2)).exp() / (s * sq2pi);
    let mut sorted = z.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = sorted.len();
    let med = if m % 2 == 1 {
        sorted[m / 2]
    } else {
        0.5 * (sorted[m / 2 - 1] + sorted[m / 2])
    };
    let (mut s, mut p) = ((med / 0.6745).max(1e-6), 0.5_f64);
    for _ in 0..200 {
        let (mut rs, mut rz) = (0.0_f64, 0.0_f64);
        for &zz in z {
            let a0 = p * f0(zz, s);
            let r = a0 / (a0 + (1.0 - p) * f1(zz, s) + 1e-300);
            rs += r;
            rz += r * zz * zz;
        }
        let p_new = rs / m as f64;
        let s_new = (rz / rs.max(1e-300)).sqrt();
        let done = (p_new - p).abs() < 1e-10 && (s_new - s).abs() < 1e-10 * s;
        p = p_new;
        s = s_new.max(1e-9);
        if done {
            break;
        }
    }
    let keep: Vec<bool> = z
        .iter()
        .map(|&zz| {
            let a0 = p * f0(zz, s);
            a0 / (a0 + (1.0 - p) * f1(zz, s) + 1e-300) < 0.5
        })
        .collect();
    let sd1 = (s * s + g * g).sqrt();
    let w1 = z
        .iter()
        .map(|&zz| {
            (1.0 - p) * w[0] * (-0.5 * ((zz - 1.0) / sd1).powi(2)).exp()
                / (sd1 * sq2pi)
                / (p * f0(zz, s) + (1.0 - p) * f1(zz, s) + 1e-300)
        })
        .sum::<f64>()
        / m as f64;
    keep.iter().any(|&k| k).then_some((keep, p, w1))
}

/// Largest event peak over the second largest (see
/// [`EventMassDiag::peak_outlier_ratio`]).
fn peak_outlier_ratio(events: &[Event]) -> f64 {
    let (mut first, mut second) = (0.0_f64, 0.0_f64);
    for e in events {
        if e.peak > first {
            second = first;
            first = e.peak;
        } else if e.peak > second {
            second = e.peak;
        }
    }
    match events.len() {
        0 => 0.0,
        1 => 1.0,
        _ if second > 0.0 => first / second,
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::Chain;
    use crate::filter::BandpassFilter;

    #[test]
    fn burst_rule_allots_by_rank_and_takes_the_smaller_total() {
        let c = allot(&[5., 1., 3., 2., 1.5, 9.], 11, 0.5);
        assert_eq!(c.iter().sum::<usize>(), 11);
        assert!(
            c.iter().all(|&v| v >= 1) && c[5] == *c.iter().max().unwrap() && c[1] == 1,
            "{c:?}"
        );
        assert_eq!(allot(&[2., 1.], 1, 0.5), vec![1, 1]); // never under one per event
        assert_eq!(allot(&[3.], 4, 0.5), vec![4]); // every N_i = 1: in proportion to the mass
                                                   // 10 runs, 4 events, pi0 = 0.6, w1 = 0.2: n = 4, n1 = 2, T = 8 < summed masses 14 -> total 8 over the 4 events, noise runs 0
        let z = [0.1, 6.0, 0.2, 4.0, 0.1, 3.0, 0.2, 1.0, 0.1, 0.1];
        let keep: Vec<bool> = z.iter().map(|&v| v >= 1.0).collect();
        let cb = burst_counts(&z, &keep, 0.6, 0.2).unwrap();
        assert_eq!(cb.iter().sum::<usize>(), 8);
        assert!(
            cb.iter()
                .zip(&keep)
                .all(|(&c, &k)| if k { c >= 1 } else { c == 0 })
                && cb[1] >= cb[3]
                && cb[3] >= cb[5]
                && cb[5] >= cb[7],
            "{cb:?}"
        );
        // T = n^2 / n1 = 16 / 0.5 = 32 above the summed masses: the per-run counts stand
        assert!(burst_counts(&z, &keep, 0.6, 0.05).is_none());
    }

    /// Counts per frame of a placed event set.
    fn place(
        events: &[Event],
        x: &[f32],
        counts: &[usize],
        cap: usize,
        n: usize,
    ) -> (Vec<f32>, usize) {
        let mut s = vec![0.0_f32; n];
        let placed = place_all(events, x, counts, cap, &mut s);
        (s, placed)
    }

    /// A smooth burst over frames 40..60 of total mass 12.
    fn burst() -> Vec<f32> {
        let mut x = vec![0.0_f32; 100];
        for (j, v) in x.iter_mut().enumerate().take(60).skip(40) {
            let u = (j as f32 - 49.5) / 6.0;
            *v = (-u * u).exp();
        }
        let total: f32 = x.iter().sum();
        x.iter_mut().for_each(|v| *v *= 12.0 / total);
        x
    }

    #[test]
    fn events_are_maximal_runs_and_are_not_split_at_local_minima() {
        let mut x = vec![0.0_f32; 30];
        // A run with a dip in the middle, then a separate singleton.
        for (j, v) in [(5, 1.0), (6, 0.5), (7, 0.1), (8, 0.6), (9, 1.2), (20, 0.4)] {
            x[j] = v;
        }
        let ev = segment(&x, 0, 30);
        assert_eq!(ev.len(), 2);
        assert_eq!((ev[0].start, ev[0].end), (5, 10));
        assert_eq!((ev[1].start, ev[1].end), (20, 21));
        assert!((ev[0].mass - 3.4).abs() < 1e-6);
        assert!((ev[0].peak - 1.2).abs() < 1e-6);
        assert!((ev[1].centre - 20.0).abs() < 1e-12);
    }

    #[test]
    fn events_outside_the_interior_are_excluded() {
        let mut x = vec![0.0_f32; 30];
        x[2] = 1.0;
        x[27] = 1.0;
        x[15] = 1.0;
        let ev = segment(&x, 5, 25);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].start, 15);
    }

    #[test]
    fn a_single_spike_goes_to_the_centroid_frame() {
        let mut x = vec![0.0_f32; 40];
        x[19] = 0.25;
        x[20] = 0.5;
        x[21] = 0.25;
        let ev = segment(&x, 0, 40);
        let (s, placed) = place(&ev, &x, &[1], 10, 40);
        assert_eq!(placed, 1);
        assert_eq!(s[20], 1.0);
    }

    #[test]
    fn spikes_follow_the_mass_quantiles_of_the_event() {
        let x = burst();
        let ev = segment(&x, 0, 100);
        let (s, placed) = place(&ev, &x, &[12], 10, 100);
        assert_eq!(placed, 12);
        assert_eq!(s.iter().sum::<f32>(), 12.0);
        // The train spreads over the burst and keeps its centroid.
        let first = s.iter().position(|&v| v > 0.0).unwrap();
        let last = s.iter().rposition(|&v| v > 0.0).unwrap();
        assert!(last - first >= 6, "spread {first}..{last}");
        let centroid: f64 = s
            .iter()
            .enumerate()
            .map(|(j, &v)| j as f64 * v as f64)
            .sum::<f64>()
            / 12.0;
        assert!((centroid - ev[0].centre).abs() < 0.6, "{centroid}");
        // Frame counts are integers within the cap.
        assert!(s.iter().all(|&v| v == v.round() && v <= 10.0));
    }

    #[test]
    fn overflow_moves_to_the_nearest_frame_with_room_and_drops_when_full() {
        // A 3-frame event with all its mass on the middle frame.
        let mut x = vec![0.0_f32; 20];
        x[9] = 0.01;
        x[10] = 5.0;
        x[11] = 0.01;
        let ev = segment(&x, 0, 20);
        // cap 4: 6 spikes -> 4 in the middle, the rest in the neighbours.
        let (s, placed) = place(&ev, &x, &[6], 4, 20);
        assert_eq!(placed, 6);
        assert_eq!(s[10], 4.0);
        assert_eq!(s[9] + s[11], 2.0);
        // 13 spikes cannot fit in 3 frames of capacity 4: 12 placed.
        let (s, placed) = place(&ev, &x, &[13], 4, 20);
        assert_eq!(placed, 12);
        assert_eq!(s.iter().sum::<f32>(), 12.0);
        assert!(s.iter().all(|&v| v <= 4.0));
    }

    #[test]
    fn peak_outlier_ratio_is_largest_over_second_largest_event_peak() {
        let mk = |peak: f64| Event {
            mass: peak,
            centre: 0.0,
            start: 0,
            end: 1,
            peak,
        };
        assert_eq!(peak_outlier_ratio(&[]), 0.0);
        assert_eq!(peak_outlier_ratio(&[mk(3.0)]), 1.0);
        assert_eq!(peak_outlier_ratio(&[mk(1.0), mk(6.0), mk(2.0)]), 3.0);
        assert_eq!(peak_outlier_ratio(&[mk(2.0), mk(2.0)]), 1.0);
    }

    /// Frame masses for isolated events of `c` spikes, each smeared over
    /// three frames as the relaxed solve does (0.25 / 0.5 / 0.25).
    fn smeared(n: usize, events: &[(usize, usize)]) -> (Vec<f32>, Vec<f32>) {
        let mut x = vec![0.0_f32; n];
        let mut truth = vec![0.0_f32; n];
        for &(f, c) in events {
            x[f - 1] += 0.25 * c as f32;
            x[f] += 0.5 * c as f32;
            x[f + 1] += 0.25 * c as f32;
            truth[f] = c as f32;
        }
        (x, truth)
    }

    fn clean_trace(banded: &BandedAR2, truth: &[f32]) -> Vec<f32> {
        let mut y = vec![0.0_f32; truth.len()];
        banded.convolve_forward(truth, &mut y);
        y.iter().map(|&v| 3.0 * v + 0.5).collect()
    }

    #[test]
    fn without_a_noise_model_the_pick_is_the_floor() {
        let n = 400;
        let banded = BandedAR2::new(0.05, 0.4, 30.0);
        let (x, truth) = smeared(n, &[(80, 1), (200, 2), (320, 1)]);
        let y = clean_trace(&banded, &truth);
        let mut sc = Scorer::Plain { y: &y };
        let r = event_mass_search(&x, &mut sc, &banded, 24, 10, None);
        // The floor is frame_max / cap: the busiest frame (mass 1.0) holds
        // cap spikes, so a unit of 0.1 and ten spikes per mass unit.
        assert!(r.diag.cap_limited && !r.diag.no_size_fit);
        assert!((r.diag.a_pick - r.diag.a_floor).abs() < 1e-9);
        assert_eq!(r.counts.iter().sum::<f32>(), 40.0);
        assert!(r.counts.iter().all(|&v| v <= 10.0));
    }

    #[test]
    fn the_quantal_pick_finds_the_exact_counts_on_clean_events() {
        let n = 400;
        let banded = BandedAR2::new(0.05, 0.4, 30.0);
        // Clean relaxed masses (the events are exact: 1, 2 and 1 spikes).
        let (_, truth) = smeared(n, &[(80, 1), (200, 2), (320, 1)]);
        let x = truth.clone();
        let y = clean_trace(&banded, &truth);
        let mut sc = Scorer::Plain { y: &y };
        let nm = NoiseModel {
            sigma: 0.05,
            corr_sum: 1.0,
        };
        let r = event_mass_search(&x, &mut sc, &banded, 24, 10, Some(nm));
        // The pick is one spike per unit of mass: 1, 2 and 1 spikes.
        assert_eq!(
            (r.counts[80], r.counts[200], r.counts[320]),
            (1.0, 2.0, 1.0)
        );
        assert_eq!(r.counts.iter().sum::<f32>(), 4.0);
        assert!(!r.diag.cap_limited && !r.diag.no_size_fit);
        assert_eq!(r.diag.dropped_spikes, 0);
        assert!((r.alpha - 3.0).abs() < 0.1, "{}", r.alpha);
        assert!(r.diag.peak_outlier_ratio >= 1.0);
        assert!(r.diag.e_pick - r.diag.e_relaxed <= r.diag.std_error);
        // Nothing in the edge zone.
        assert!(r.counts[..24]
            .iter()
            .chain(&r.counts[n - 24..])
            .all(|&v| v == 0.0));
    }

    #[test]
    fn a_trace_the_sizes_cannot_fit_reports_no_size_fit_and_takes_the_best_fit() {
        // Masses that no whole-spike size reproduces within one SE of a tiny
        // noise level: two events whose masses are not commensurate.
        let n = 400;
        let banded = BandedAR2::new(0.05, 0.4, 30.0);
        let mut x = vec![0.0_f32; n];
        x[100] = 0.37;
        x[200] = 1.0;
        let mut y = vec![0.0_f32; n];
        banded.convolve_forward(&x, &mut y);
        let y: Vec<f32> = y.iter().map(|&v| 5.0 * v).collect();
        let mut sc = Scorer::Plain { y: &y };
        let nm = NoiseModel {
            sigma: 1e-4,
            corr_sum: 1.0,
        };
        let r = event_mass_search(&x, &mut sc, &banded, 24, 3, Some(nm));
        assert!(r.diag.no_size_fit);
        // The pick is the grid's best-fitting size: it fits at least as well
        // as the floor the earlier rule fell back to (mode 0).
        FLOOR_MODE.with(|m| m.set(0));
        let at_floor = event_mass_search(&x, &mut sc, &banded, 24, 3, Some(nm));
        FLOOR_MODE.with(|m| m.set(255));
        assert!((at_floor.diag.a_pick - at_floor.diag.a_floor).abs() < 1e-9);
        assert!(
            r.error <= at_floor.error,
            "{} vs {}",
            r.error,
            at_floor.error
        );
        assert_eq!(r.diag.cap_limited, r.diag.a_pick == r.diag.a_floor);
    }

    #[test]
    fn empty_mass_is_handled() {
        let banded = BandedAR2::new(0.1, 0.6, 30.0);
        let y = vec![1.0_f32; 100];
        let mut sc = Scorer::Plain { y: &y };
        let x = vec![0.0_f32; 100];
        let r = event_mass_search(&x, &mut sc, &banded, 5, 10, None);
        assert!(r.counts.iter().all(|&v| v == 0.0));
        assert_eq!(r.diag.peak_outlier_ratio, 0.0);
        assert!(!r.diag.cap_limited);
    }

    /// The nested (superposition) scoring of the integer trains equals
    /// scoring each from scratch through the chain, on a trace with repeated
    /// spikes per frame and a bandpass filter.
    #[test]
    fn nested_scoring_matches_from_scratch_chain_scoring() {
        let (fs, n) = (30.0, 3000);
        let banded = BandedAR2::new(0.05, 0.4, fs);
        let window = crate::baseline::baseline_window(0.4, fs);
        let mk_filter = || {
            let mut f = BandpassFilter::new();
            f.update_cutoffs(0.05, 0.4, fs);
            f.set_hp_enabled(true);
            f.set_lp_enabled(true);
            f
        };
        // Smeared events of 1..4 spikes through the trace.
        let events: Vec<(usize, usize)> = (0..25).map(|i| (60 + 110 * i, 1 + i % 4)).collect();
        let (x, truth) = smeared(n, &events);
        let mut y = vec![0.0_f32; n];
        banded.convolve_forward(&truth, &mut y);
        let noise = crate::test_util::white(n, 0.02, 3);
        y.iter_mut()
            .zip(&noise)
            .for_each(|(v, &e)| *v = 2.0 * *v + e);
        Chain::new(Some(mk_filter()), window).apply(&mut y);
        let nm = NoiseModel {
            sigma: 0.02,
            corr_sum: 1.0,
        };
        let run = |nested: bool| {
            let chain = Box::new(Chain::new(Some(mk_filter()), window));
            let mut sc = Scorer::Chain { y: &y, chain };
            if !nested {
                // A scorer that declines superposition: score every
                // candidate from scratch.
                return event_mass_search_scratch(&x, &mut sc, &banded, 24, 10, Some(nm));
            }
            event_mass_search(&x, &mut sc, &banded, 24, 10, Some(nm))
        };
        let (a, b) = (run(true), run(false));
        assert_eq!(a.counts, b.counts, "same pick");
        assert!((a.error - b.error).abs() < 1e-5 * b.error.max(1e-12));
    }

    /// The search with every candidate scored from scratch (the reference).
    fn event_mass_search_scratch(
        x: &[f32],
        scorer: &mut Scorer,
        banded: &BandedAR2,
        pad: usize,
        cap: usize,
        noise: Option<NoiseModel>,
    ) -> EventMassResult {
        let n = scorer.target().len();
        let (lo, hi) = (pad, n - pad);
        let events = segment(x, lo, hi);
        let a_max = events.iter().map(|e| e.mass).fold(0.0_f64, f64::max);
        let frame_max = x[lo..hi].iter().fold(0.0_f64, |m, &v| m.max(v as f64));
        let floor_rel = (frame_max / cap as f64 / a_max).clamp(1e-6, 1.0);
        let levels = threshold_grid(floor_rel);
        let mut s = vec![0.0_f32; n];
        let mut conv = vec![0.0_f32; n];
        let mut per_event = vec![0usize; events.len()];
        let mut errors = Vec::new();
        for &rel in &levels {
            counts_at(&events, rel * a_max, &mut per_event);
            place_all(&events, x, &per_event, cap, &mut s);
            errors.push(scorer.score(&s, banded, pad, f64::INFINITY, &mut conv).0);
        }
        let mut prof = vec![0.0_f32; n];
        relaxed_profile(x, lo, hi, &mut prof);
        let e_rel = scorer.score(&prof, banded, pad, f64::INFINITY, &mut conv).0;
        let se = noise.unwrap().std_error(hi - lo);
        let pick = (0..levels.len())
            .rev()
            .find(|&i| errors[i] - e_rel <= se)
            .unwrap_or(0);
        counts_at(&events, levels[pick] * a_max, &mut per_event);
        place_all(&events, x, &per_event, cap, &mut s);
        EventMassResult {
            counts: s,
            alpha: 0.0,
            baseline: 0.0,
            pve: 0.0,
            error: errors[pick],
            diag: EventMassDiag::default(),
        }
    }
}
