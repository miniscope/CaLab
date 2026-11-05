//! Chain-consistent matching pursuit binarization at the spike-resolution
//! rate (an experimental candidate family; `indeca::Binarize::Pursuit`, not
//! the default).
//!
//! The threshold search builds its candidate trains from the relaxed
//! solution's tent: the count of an event is the width of its tent lobe
//! above the threshold, not its mass, so with isolated single spikes the
//! family keeps 15-37 sub-bins per event and never reaches the noise budget
//! (characterization on the experiment branch). This module builds the
//! train directly, one 0/1 sub-bin at a time, against the chain-processed
//! residual, and uses the noise budget as its stop. There is no sparsity
//! penalty: sparsity comes from stopping at the budget and from the 0/1 per
//! sub-bin pin (one action potential per 300 Hz bin).
//!
//! # Step
//!
//! State: the train `s` (0/1 per sub-bin), its exact chain score (amplitude
//! `alpha`, offset `b`, residual energy `e` over the selection grid; see
//! `chain::Scorer`), and the chained reconstruction `C(K s)`. The residual
//! on the grid is `r = C(y) - alpha C(K s) - b`. The next sub-bin is chosen
//! by correlating `r` (grid samples only, zero elsewhere) with the
//! shift-invariant template `phi = F(K delta)`: the kernel's impulse response
//! through the linear part of the chain (the bandpass), measured once at the
//! trace centre. The correlation is one FFT pair per pass. Every candidate
//! sub-bin is then scored EXACTLY (full chain pass, amplitude and offset
//! refit), so the template only orders the candidates; the quantile stage's
//! nonlinearity is in the decision.
//!
//! One pass takes the positive local maxima of the correlation (interior,
//! empty sub-bins), in descending order, at least one frame (`stride`
//! sub-bins) apart within the pass, and accepts each one whose exact score
//! lowers the residual energy ([`Gate`]). Multi-spike frames are reached by
//! the following passes (the residual then still carries the unexplained
//! spikes). Passes repeat until a stop fires.
//!
//! # The per-atom gate
//!
//! [`Gate::Decrease`] (the rule): any exact decrease. The amplitude is
//! shared by every spike, so an atom placed on a noise bump is scored at the
//! data's own per-spike amplitude `a`, not at the bump's: its energy change
//! is `a^2 E_phi - 2 a c_j` with `c_j` the residual's correlation there,
//! and on pure noise the largest `c_j` over the grid is about
//! `sigma sqrt(E_phi) sqrt(2 ln n_grid)`, so a noise atom lowers the energy
//! only when `a sqrt(E_phi) < 2 sigma sqrt(2 ln n_grid)` (a per-spike
//! energy below ~36 noise variances at `n_grid = 9000`), where the spike is
//! not detectable anyway. Above that, "no decrease" is the data's own
//! stop for noise. [`Gate::OneSe`] (comparison) requires the decrease to
//! exceed one standard error of the noise energy; that is the resolution
//! of the whole-grid statistic, not of one atom, and it drops every spike
//! whose energy is below the SE (measured: dense cells stop at 20-30% of
//! the spikes with the amplitude still 1.5-2x too high).
//!
//! # Moves
//!
//! With `moves`, a pass that accepts no atom is followed by a move sweep:
//! every spike tries the empty sub-bins at whole-frame steps (`stride`)
//! up to the kernel's peak time at the spike-resolution rate (the lag of
//! the largest kernel sample: on a slow rise the correlation peak is that
//! far from the spike) and at half a frame, each scored exactly, and takes
//! the best decrease. Pursuit passes resume after a sweep that moved a
//! spike; the stop fires when neither a pass nor a sweep changes the train.
//! (Measured need: on a 0.4 s rise, atoms land a frame or more off and the
//! residual's dipole leaves no positive gain anywhere.)
//!
//! # Stops (no tuned constants)
//!
//! - `Budget`: the residual energy is at or below the noise budget
//!   (`NoiseModel::budget`): the train explains the trace down to the noise.
//!   Since atoms are added in order of their correlation, this is the
//!   sparsest train along the greedy path that reaches the budget (the
//!   "noise path" of the threshold search).
//! - `NoGain`: no candidate of the pass passed the gate.
//! - `Exhausted`: no positive local maximum is left.
//!
//! # Prune
//!
//! The greedy path can carry atoms that a later amplitude refit made
//! redundant. With `prune`, spikes are removed while the energy stays within
//! `max(budget, e_full + SE)` (the threshold search's ceiling, with the
//! fullest train in the role of the best fit): each sweep orders the spikes
//! by the linear estimate of their removal cost (`alpha^2 ||phi||^2 -
//! 2 alpha c_j` on the grid) and checks each removal exactly, smallest
//! estimate first; sweeps repeat until none removes a spike.
use crate::banded::BandedAR2;
use crate::chain::Scorer;
use crate::threshold::{interior_pve, NoiseModel, SelectionDiag, ThresholdResult};
use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

/// Why the pursuit stopped adding spikes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PursuitStop {
    Budget,
    NoGain,
    Exhausted,
}

/// What an atom must do to the exact residual energy to be accepted (module
/// docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Gate {
    /// Any decrease (the rule).
    Decrease,
    /// A decrease of more than one standard error of the noise energy
    /// (comparison; without a noise model the same as `Decrease`).
    OneSe,
}

/// How the amplitude is handled while atoms are added.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Amplitude {
    /// Least-squares refit of amplitude and offset on every candidate (the
    /// scorer's rule). The residual-only decision cannot tell "one spike at
    /// alpha" from "m sub-bins at alpha / m" (both are within the noise), so
    /// the refit amplitude can drift down as atoms are added.
    Refit,
    /// The amplitude is pinned after the first pass to the median of its
    /// accepted atoms' single-atom least-squares amplitudes
    /// (`c_j / ||phi||^2_grid`, the amplitude the residual asks for at that
    /// sub-bin: data-derived, the first pass holds the strongest isolated
    /// events); only the offset is refit per candidate. The reported fit
    /// refits both at the end.
    FixedFromFirstPass,
    /// The amplitude is pinned to the given value (units of the scorer's
    /// target) from the first atom on; only the offset is refit per
    /// candidate. The reported fit refits both at the end. (Characterization
    /// oracle with the simulated per-spike amplitude; the quantal pin
    /// supplies it from the data.)
    Fixed(f64),
    /// The quantal pin: the amplitude estimated from the data before the
    /// walk as the most common isolated reliable event mass of the
    /// free-coefficient pursuit ([`free_pursuit`], [`quantal_pin`]); falls
    /// back to `Refit` when no estimate exists.
    Quantal,
}

/// Lag (samples) after the kernel's peak at which its impulse response has
/// fallen to `e^-2` of the peak: the decay support that separates events.
pub(crate) fn decay_support(banded: &BandedAR2, n: usize) -> usize {
    let mut imp = vec![0.0_f32; n];
    if n == 0 {
        return 0;
    }
    imp[0] = 1.0;
    let mut h = vec![0.0_f32; n];
    banded.convolve_forward(&imp, &mut h);
    let (pk, hp) = h
        .iter()
        .enumerate()
        .fold((0usize, f32::NEG_INFINITY), |b, (i, &v)| {
            if v > b.1 {
                (i, v)
            } else {
                b
            }
        });
    let lim = hp * (-2.0_f32).exp();
    (pk..n).find(|&i| h[i] < lim).unwrap_or(n)
}

/// The quantal pin from the free pursuit's atoms: events are atoms in
/// adjacent frames merged (mass = coefficient sum); reliable events exceed
/// the detection floor (`sqrt(2 ln n_grid)` coefficient SEs); isolated
/// events have no larger event within the decay support `sep` (sub-bins)
/// on either side. The pin is the mode of the isolated reliable masses: the
/// most common isolated event is the single spike (the background spikes
/// between bursts, or the single spikes of a sparse cell), while bursts are
/// spread over many masses. The mode is the largest Gaussian kernel density
/// in log mass evaluated at the events themselves, bandwidth by Silverman's
/// rule (`0.9 min(sd, IQR / 1.34) n^-1/5`): a data-derived width, no
/// constant of this module's own. `None` with fewer than two events.
pub(crate) fn quantal_pin(ca: &CorrAmps, stride: usize, sep: usize) -> Option<f64> {
    let stride = stride.max(1);
    let floor = ca.se * (2.0 * (ca.n_grid.max(2) as f64).ln()).sqrt();
    let mut atoms = ca.atoms.clone();
    atoms.sort_by_key(|&(j, _)| j);
    // (first frame, last frame, mass)
    let mut ev: Vec<(usize, usize, f64)> = Vec::new();
    for &(j, a) in &atoms {
        let f = j / stride;
        match ev.last_mut() {
            Some(e) if f <= e.1 + 1 => {
                e.1 = f;
                e.2 += a;
            }
            _ => ev.push((f, f, a)),
        }
    }
    let rel: Vec<(usize, usize, f64)> = ev.into_iter().filter(|e| e.2 > floor).collect();
    let sep_f = sep.div_ceil(stride);
    let mut iso: Vec<f64> = Vec::new();
    for (i, e) in rel.iter().enumerate() {
        let near_larger = rel.iter().enumerate().any(|(q, o)| {
            q != i && o.2 > e.2 && (o.0.abs_diff(e.1) <= sep_f || e.0.abs_diff(o.1) <= sep_f)
        });
        if !near_larger {
            iso.push(e.2);
        }
    }
    let n = iso.len();
    if n < 2 {
        return None;
    }
    let mut lx: Vec<f64> = iso.iter().map(|m| m.ln()).collect();
    lx.sort_by(|a, b| a.total_cmp(b));
    let mean = lx.iter().sum::<f64>() / n as f64;
    let sd = (lx.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1) as f64).sqrt();
    let iqr = lx[(3 * n) / 4] - lx[n / 4];
    let spread = if iqr > 0.0 { sd.min(iqr / 1.34) } else { sd };
    if spread.is_nan() || spread <= 0.0 {
        return Some(iso[0]);
    }
    let h = 0.9 * spread * (n as f64).powf(-0.2);
    let mut best = (f64::NEG_INFINITY, 0.0);
    for &x in &lx {
        let d: f64 = lx
            .iter()
            .map(|&v| (-(v - x) * (v - x) / (2.0 * h * h)).exp())
            .sum();
        if d > best.0 {
            best = (d, x);
        }
    }
    Some(best.1.exp())
}

/// The data's single-atom amplitudes at the positive local maxima of its
/// template correlation (no train): what one spike at that sub-bin would
/// be fitted at by the residual alone. The basis of the quantal pin.
#[derive(Clone, Debug, Default)]
pub(crate) struct CorrAmps {
    /// `(sub-bin, amplitude)` of every positive local maximum over the
    /// empty interior sub-bins, in correlation order (descending).
    pub atoms: Vec<(usize, f64)>,
    /// Standard error of one such amplitude under the noise model
    /// (`sigma sqrt(corr_sum) / sqrt(E_phi)`): the resolution of a single
    /// measurement. Zero without a noise model.
    pub se: f64,
    /// Number of grid samples (the extreme-value scale of noise maxima,
    /// `sqrt(2 ln n_grid)` standard errors, derives from it).
    pub n_grid: usize,
}

/// Free-coefficient matching pursuit against the chain template (the
/// linear part of the chain only, on the grid residual): a greedy
/// chain-consistent deconvolution of the target. Sequential and exact: one
/// atom per step, chosen as the largest exact energy decrease among the
/// positive local maxima of the residual's correlation (a new coefficient
/// `c_j / E_phi(j)`) and the negative local minima on occupied sub-bins (a
/// correction, bounded by the coefficient), the correlation recomputed after
/// every step. A burst frame is one atom with a several-spike coefficient
/// (sub-bins are not identifiable from the grid). Stops when the residual
/// energy is at or below the budget, when the best new atom is below the
/// detection floor (`sqrt(2 ln n_grid)` standard errors of one coefficient:
/// the expected largest noise correlation over the grid) and no correction
/// helps, or when nothing decreases the energy. Returns `(sub-bin,
/// coefficient)` of every atom with a positive coefficient plus the
/// coefficient SE.
pub(crate) fn free_pursuit(
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    stride: usize,
    noise: Option<NoiseModel>,
) -> CorrAmps {
    let n = scorer.target().len();
    let stride = stride.max(1);
    let lo = pad;
    let hi = n.saturating_sub(pad);
    let n_grid = (lo..hi).step_by(stride).count();
    if n_grid == 0 || n < 8 {
        return CorrAmps::default();
    }
    let mut corr = Corr::new(scorer, banded, n, stride);
    let y: Vec<f32> = scorer.target().to_vec();
    let budget = noise.map_or(0.0, |nm| nm.budget(n_grid));
    let se = noise.map_or(0.0, |nm| {
        nm.sigma * nm.corr_sum.max(1.0).sqrt() / corr.phi_grid_energy.max(1e-30).sqrt()
    });
    let floor = se * (2.0 * (n_grid as f64).ln()).sqrt();
    let centre = n / 2;
    let mut imp = vec![0.0_f32; n];
    imp[centre] = 1.0;
    let mut phi = vec![0.0_f32; n];
    banded.convolve_forward(&imp, &mut phi);
    scorer.apply_linear(&mut phi);
    let zero = vec![0.0_f32; n];
    let (_, b) = fixed_fit(&y, &zero, 0.0, pad, stride);
    let mut r = vec![0.0_f32; n];
    residual_on_grid(&y, &zero, 0.0, b, pad, stride, &mut r);
    let mut coef = vec![0.0_f64; n];
    let mut c = vec![0.0_f32; n];
    let mut e: f64 = r.iter().map(|&v| v as f64 * v as f64).sum();
    let mut steps = 0usize;
    while steps < 4 * n_grid && !(budget > 0.0 && e <= budget) {
        steps += 1;
        corr.correlate(&r, &mut c);
        // Best exact decrease: new atoms at positive maxima above the floor,
        // corrections at negative minima of occupied sub-bins.
        let mut best: Option<(f64, f64, usize)> = None;
        for j in lo.max(1)..hi.min(n - 1) {
            let cj = c[j] as f64;
            let ej = corr.energy_at(j, pad).max(1e-30);
            let a = if cj > 0.0 && c[j] >= c[j - 1] && c[j] > c[j + 1] {
                let a = cj / ej;
                if a <= floor {
                    continue;
                }
                a
            } else if cj < 0.0 && coef[j] > 0.0 && c[j] <= c[j - 1] && c[j] < c[j + 1] {
                (cj / ej).max(-coef[j])
            } else {
                continue;
            };
            let de = a * a * ej - 2.0 * a * cj;
            if de < 0.0 && best.is_none_or(|bst| de < bst.0) {
                best = Some((de, a, j));
            }
        }
        let Some((de, a, j)) = best else { break };
        for i in (lo..hi).step_by(stride) {
            let m = (i as isize - j as isize + centre as isize) as usize;
            if m < n {
                r[i] -= (a * phi[m] as f64) as f32;
            }
        }
        coef[j] += a;
        e += de;
    }
    let mut atoms: Vec<(usize, f64)> = (lo..hi)
        .filter(|&j| coef[j] > 0.0)
        .map(|j| (j, coef[j]))
        .collect();
    atoms.sort_by(|a, b| b.1.total_cmp(&a.1));
    CorrAmps { atoms, se, n_grid }
}

/// Compute [`CorrAmps`] for the scorer's target.
pub(crate) fn correlation_amplitudes(
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    stride: usize,
    noise: Option<NoiseModel>,
) -> CorrAmps {
    let n = scorer.target().len();
    let stride = stride.max(1);
    let lo = pad;
    let hi = n.saturating_sub(pad);
    let n_grid = (lo..hi).step_by(stride).count();
    if n_grid == 0 || n < 8 {
        return CorrAmps::default();
    }
    let mut corr = Corr::new(scorer, banded, n, stride);
    let y: Vec<f32> = scorer.target().to_vec();
    let zero = vec![0.0_f32; n];
    let (_, b) = fixed_fit(&y, &zero, 0.0, pad, stride);
    let mut r = vec![0.0_f32; n];
    residual_on_grid(&y, &zero, 0.0, b, pad, stride, &mut r);
    let mut c = vec![0.0_f32; n];
    corr.correlate(&r, &mut c);
    let mut atoms: Vec<(usize, f64)> = (lo.max(1)..hi.min(n - 1))
        .filter(|&j| c[j] > 0.0 && c[j] >= c[j - 1] && c[j] > c[j + 1])
        .map(|j| (j, c[j] as f64 / corr.energy_at(j, pad).max(1e-30)))
        .collect();
    atoms.sort_by(|a, b| b.1.total_cmp(&a.1));
    let se = noise.map_or(0.0, |nm| {
        nm.sigma * nm.corr_sum.max(1.0).sqrt() / corr.phi_grid_energy.max(1e-30).sqrt()
    });
    CorrAmps { atoms, se, n_grid }
}

/// What the pursuit did (diagnostics).
#[derive(Clone, Debug)]
pub(crate) struct PursuitStats {
    pub passes: usize,
    /// Exact chain evaluations (the cost unit).
    pub evals: usize,
    pub stop: PursuitStop,
    /// Spikes removed by the prune.
    pub pruned: usize,
    /// Residual energy before the prune.
    pub e_full: f64,
    /// The amplitude used for the scoring decisions (`Refit`: the last
    /// refit; `FixedFromFirstPass`: the pin).
    pub alpha_used: f64,
    /// `(count, alpha, error)` after every accepted atom (the add path).
    pub trajectory: Vec<(usize, f64, f64)>,
    /// Spikes moved by the move sweeps.
    pub moved: usize,
}

/// Residual of the fit on the grid positions (zero elsewhere), in place.
fn residual_on_grid(
    y: &[f32],
    conv: &[f32],
    alpha: f64,
    b: f64,
    pad: usize,
    stride: usize,
    out: &mut [f32],
) {
    out.iter_mut().for_each(|v| *v = 0.0);
    let n = y.len();
    for i in (pad..n.saturating_sub(pad)).step_by(stride.max(1)) {
        out[i] = (y[i] as f64 - (alpha * conv[i] as f64 + b)) as f32;
    }
}

/// Residual energy on the grid at a fixed amplitude with the offset refit
/// over the interior: `(error, offset)`.
fn fixed_fit(y: &[f32], conv: &[f32], alpha: f64, pad: usize, stride: usize) -> (f64, f64) {
    let n = y.len();
    let hi = n.saturating_sub(pad);
    if hi <= pad {
        return (0.0, 0.0);
    }
    let mut acc = 0.0_f64;
    for i in pad..hi {
        acc += y[i] as f64 - alpha * conv[i] as f64;
    }
    let b = acc / (hi - pad) as f64;
    let mut e = 0.0_f64;
    for i in (pad..hi).step_by(stride.max(1)) {
        let d = y[i] as f64 - (alpha * conv[i] as f64 + b);
        e += d * d;
    }
    (e, b)
}

/// Cross-correlation of the FFT-ready residual with the template spectrum.
struct Corr {
    r2c: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
    c2r: std::sync::Arc<dyn realfft::ComplexToReal<f32>>,
    /// `conj(FFT(phi0))`, `phi0[m] = phi[(centre + m) mod n]`.
    phi_conj: Vec<Complex<f32>>,
    /// Sum of `phi^2` over grid offsets: the energy one spike adds on the
    /// grid at unit amplitude (a spike on a grid sample).
    phi_grid_energy: f64,
    /// The same per sub-bin phase: `phi_phase_energy[p]` is the grid energy
    /// of a spike `p` sub-bins after a grid sample (`p = 0` is
    /// `phi_grid_energy`).
    phi_phase_energy: Vec<f64>,
    spec: Vec<Complex<f32>>,
    work: Vec<f32>,
}

impl Corr {
    fn new(scorer: &mut Scorer, banded: &BandedAR2, n: usize, stride: usize) -> Self {
        let centre = n / 2;
        let mut imp = vec![0.0_f32; n];
        imp[centre] = 1.0;
        let mut phi = vec![0.0_f32; n];
        banded.convolve_forward(&imp, &mut phi);
        scorer.apply_linear(&mut phi);
        let mut phi0: Vec<f32> = (0..n).map(|m| phi[(centre + m) % n]).collect();
        // Grid energy per phase: a spike `p` sub-bins after a grid sample
        // sees the grid at offsets `m = -p (mod stride)` from itself.
        let mut phi_phase_energy = vec![0.0_f64; stride];
        for (i, &v) in phi.iter().enumerate() {
            let m = i as isize - centre as isize;
            let p = (-m).rem_euclid(stride as isize) as usize;
            phi_phase_energy[p] += v as f64 * v as f64;
        }
        let phi_grid_energy = phi_phase_energy[0];
        let mut planner = RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(n);
        let c2r = planner.plan_fft_inverse(n);
        let mut spec = r2c.make_output_vec();
        // The template's FFT (the impulse response is finite and the filter
        // output is finite, so this cannot fail on real data).
        let _ = r2c.process(&mut phi0, &mut spec);
        let phi_conj: Vec<Complex<f32>> = spec.iter().map(|c| c.conj()).collect();
        Corr {
            r2c,
            c2r,
            phi_conj,
            phi_grid_energy,
            phi_phase_energy,
            spec,
            work: vec![0.0; n],
        }
    }

    /// Grid energy of a unit spike at sub-bin `j` (the grid starts at `pad`).
    fn energy_at(&self, j: usize, pad: usize) -> f64 {
        let stride = self.phi_phase_energy.len();
        let p = (j as isize - pad as isize).rem_euclid(stride as isize) as usize;
        self.phi_phase_energy[p]
    }

    /// `c[j] = sum_i r[i] phi[i - j]` for every `j`, into `out` (circular).
    fn correlate(&mut self, r: &[f32], out: &mut [f32]) {
        let n = r.len();
        self.work.copy_from_slice(r);
        if self.r2c.process(&mut self.work, &mut self.spec).is_err() {
            out.iter_mut().for_each(|v| *v = 0.0);
            return;
        }
        for (s, p) in self.spec.iter_mut().zip(&self.phi_conj) {
            *s *= *p;
        }
        if self.c2r.process(&mut self.spec, out).is_err() {
            out.iter_mut().for_each(|v| *v = 0.0);
            return;
        }
        let scale = 1.0 / n as f32;
        out.iter_mut().for_each(|v| *v *= scale);
    }
}

/// Lag (samples) of the kernel's largest sample: its peak time.
fn peak_lag(banded: &BandedAR2, n: usize) -> usize {
    let mut imp = vec![0.0_f32; n];
    imp[0] = 1.0;
    let mut h = vec![0.0_f32; n];
    banded.convolve_forward(&imp, &mut h);
    h.iter()
        .enumerate()
        .fold((0usize, f32::NEG_INFINITY), |b, (i, &v)| {
            if v > b.1 {
                (i, v)
            } else {
                b
            }
        })
        .0
}

/// Run the pursuit. `scorer`'s target is the preprocessed trace at the
/// spike-resolution rate; `banded` is the kernel at that rate; the grid is
/// every `stride`-th sample of `[pad, n - pad)`. Returns the train and its
/// fit as a [`ThresholdResult`] (`threshold` is 0: there is none) plus the
/// pursuit's diagnostics.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pursue(
    scorer: &mut Scorer,
    banded: &BandedAR2,
    pad: usize,
    stride: usize,
    noise: Option<NoiseModel>,
    prune: bool,
    amplitude: Amplitude,
    gate: Gate,
    moves: bool,
    init_free: bool,
    start: Option<&[f32]>,
) -> (ThresholdResult, PursuitStats) {
    let n = scorer.target().len();
    let stride = stride.max(1);
    let n_grid = (pad..n.saturating_sub(pad)).step_by(stride).count();
    let budget = noise.map_or(0.0, |nm| nm.budget(n_grid));
    let se = noise.map_or(0.0, |nm| nm.std_error(n_grid));
    let mut stats = PursuitStats {
        passes: 0,
        evals: 0,
        stop: PursuitStop::Exhausted,
        pruned: 0,
        e_full: f64::INFINITY,
        alpha_used: 0.0,
        trajectory: Vec::new(),
        moved: 0,
    };
    let mut s = vec![0.0_f32; n];
    let mut conv = vec![0.0_f32; n];
    let mut conv_acc = vec![0.0_f32; n];
    let empty = |s: Vec<f32>, baseline: f64| ThresholdResult {
        s_binary: s,
        alpha: 0.0,
        baseline,
        threshold: 0.0,
        pve: 0.0,
        error: f64::INFINITY,
        noise_path: false,
        diag: SelectionDiag::default(),
    };
    if n_grid == 0 || n < 8 {
        let baseline = if n == 0 {
            0.0
        } else {
            scorer.target().iter().map(|&v| v as f64).sum::<f64>() / n as f64
        };
        return (empty(s, baseline), stats);
    }
    let mut corr = Corr::new(scorer, banded, n, stride);
    let y: Vec<f32> = scorer.target().to_vec();
    // `pin`: when set, the energy is taken at that amplitude with the offset
    // refit; the returned amplitude is then the pin.
    let score =
        |scorer: &mut Scorer, s: &[f32], conv: &mut [f32], evals: &mut usize, pin: Option<f64>| {
            *evals += 1;
            let (e, a, b) = scorer.score(s, banded, pad, stride, f64::INFINITY, conv);
            match pin {
                None => (e, a, b),
                Some(ap) => {
                    let (e, b) = fixed_fit(scorer.target(), conv, ap, pad, stride);
                    (e, ap, b)
                }
            }
        };
    // The free pursuit's atoms, when the pin or the start needs them.
    let mut free: Option<CorrAmps> = None;
    let mut pin: Option<f64> = match amplitude {
        Amplitude::Fixed(a) if a > 0.0 && a.is_finite() => Some(a),
        Amplitude::Quantal => {
            let ca = free_pursuit(scorer, banded, pad, stride, noise);
            let sep = decay_support(banded, n);
            let p = quantal_pin(&ca, stride, sep).filter(|a| *a > 0.0 && a.is_finite());
            free = Some(ca);
            p
        }
        _ => None,
    };
    let mut count = 0usize;
    if let Some(st) = start.filter(|st| st.len() == n) {
        // A given 0/1 start (e.g. the chain-consistent relaxation rounded at
        // the pin, `chain_relax`): the walk adds, prunes and moves from it.
        for (sj, &v) in s.iter_mut().zip(st) {
            if v > 0.5 {
                *sj = 1.0;
                count += 1;
            }
        }
    } else if init_free {
        if let Some(a) = pin {
            // Start from the free pursuit's frame masses rounded at the pin:
            // `round(m_f / a)` spikes per frame (at most `stride`), placed at
            // the frame's atom sub-bins first, then outward from the largest
            // atom. The walk from the empty train at a fixed amplitude stops in
            // a local minimum with 40-60% of a bursting cell's spikes missing
            // (the first atoms of a burst overfill its peak frame and the
            // dipole residual improves under no single addition or move); the
            // rounded relaxation starts it near the right basin.
            let ca = match free.take() {
                Some(ca) => ca,
                None => free_pursuit(scorer, banded, pad, stride, noise),
            };
            let (lo, hi) = (pad, n.saturating_sub(pad));
            let n_frames = n_grid;
            let mut per_frame: Vec<Vec<(f64, usize)>> = vec![Vec::new(); n_frames];
            for &(j, c) in &ca.atoms {
                if j >= lo && j < hi {
                    per_frame[(j - lo) / stride].push((c, j));
                }
            }
            for (f, atoms) in per_frame.iter_mut().enumerate() {
                if atoms.is_empty() {
                    continue;
                }
                let mass: f64 = atoms.iter().map(|(c, _)| c).sum();
                let want = ((mass / a).round() as usize).min(stride);
                if want == 0 {
                    continue;
                }
                atoms.sort_by(|x, y| y.0.total_cmp(&x.0));
                let f_lo = lo + f * stride;
                let f_hi = (f_lo + stride).min(hi);
                let mut placed = 0usize;
                for &(_, j) in atoms.iter() {
                    if placed < want && s[j] == 0.0 {
                        s[j] = 1.0;
                        placed += 1;
                    }
                }
                let centre = atoms[0].1 as isize;
                let mut d = 1isize;
                while placed < want && d < stride as isize {
                    for t in [centre - d, centre + d] {
                        if placed < want
                            && t >= f_lo as isize
                            && t < f_hi as isize
                            && s[t as usize] == 0.0
                        {
                            s[t as usize] = 1.0;
                            placed += 1;
                        }
                    }
                    d += 1;
                }
                count += placed;
            }
        }
    }
    let (mut err, mut alpha, mut b) = score(scorer, &s, &mut conv, &mut stats.evals, pin);
    conv_acc.copy_from_slice(&conv);
    if count > 0 {
        stats.trajectory.push((count, alpha, err));
    }
    let mut r = vec![0.0_f32; n];
    let mut c = vec![0.0_f32; n];
    let lo = pad;
    let hi = n.saturating_sub(pad);
    let gate = match gate {
        Gate::OneSe if noise.is_some() => se,
        _ => 0.0,
    };
    let mut stop = None;
    if err <= budget && budget > 0.0 {
        stop = Some(PursuitStop::Budget);
    }
    // Each pass adds at least one spike or stops; n_grid bounds the passes.
    while stop.is_none() && stats.passes < n_grid {
        stats.passes += 1;
        residual_on_grid(&y, &conv_acc, alpha, b, pad, stride, &mut r);
        corr.correlate(&r, &mut c);
        // Positive local maxima of the correlation, descending. A maximum
        // on an occupied sub-bin (a frame that already holds a spike and
        // asks for more: the residual's peak does not move when a spike is
        // added at it) is proposed at the nearest empty sub-bin of the same
        // frame: the sub-bin inside a frame is not identifiable from the
        // grid, and the one-spike-per-sub-bin pin is what limits a frame to
        // `stride` spikes. (Restricting the maxima to empty sub-bins, the
        // first design, stopped every burst frame at one spike: measured
        // with the true amplitude pinned, 8-29% of the spikes, NoGain.)
        let mut cands: Vec<(f32, usize)> = (lo.max(1)..hi.min(n - 1))
            .filter(|&j| c[j] > 0.0 && c[j] >= c[j - 1] && c[j] > c[j + 1])
            .filter_map(|j| {
                if s[j] == 0.0 {
                    return Some((c[j], j));
                }
                let half = (stride / 2) as isize;
                (1..=half)
                    .flat_map(|d| [j as isize - d, j as isize + d])
                    .find(|&t| t >= lo as isize && t < hi as isize && s[t as usize] == 0.0)
                    .map(|t| (c[j], t as usize))
            })
            .collect();
        if cands.is_empty() {
            stop = Some(PursuitStop::Exhausted);
            break;
        }
        cands.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut taken: Vec<usize> = Vec::new();
        let mut accepted = 0usize;
        let mut atom_amps: Vec<f64> = Vec::new();
        for &(cj, j) in &cands {
            if taken.iter().any(|&t| t.abs_diff(j) < stride) {
                continue;
            }
            s[j] = 1.0;
            let (e2, a2, b2) = score(scorer, &s, &mut conv, &mut stats.evals, pin);
            if e2 < err - gate {
                err = e2;
                alpha = a2;
                b = b2;
                conv_acc.copy_from_slice(&conv);
                count += 1;
                accepted += 1;
                taken.push(j);
                atom_amps.push(cj as f64 / corr.phi_grid_energy.max(1e-30));
                stats.trajectory.push((count, alpha, err));
                if err <= budget && budget > 0.0 {
                    stop = Some(PursuitStop::Budget);
                    break;
                }
            } else {
                s[j] = 0.0;
            }
        }
        if stop.is_none() && accepted == 0 {
            // Move sweep: exact, frame steps up to the kernel's peak time.
            let mut moved_now = 0usize;
            if moves && count > 0 {
                let reach = peak_lag(banded, n).max(stride);
                let mut steps: Vec<isize> = vec![-(stride as isize / 2), stride as isize / 2];
                let mut d = stride as isize;
                while d as usize <= reach {
                    steps.push(-d);
                    steps.push(d);
                    d += stride as isize;
                }
                let spikes: Vec<usize> = (lo..hi).filter(|&j| s[j] > 0.0).collect();
                for j in spikes {
                    let mut best: Option<(f64, f64, f64, usize)> = None;
                    s[j] = 0.0;
                    for &d in &steps {
                        let t = j as isize + d;
                        if t < lo as isize || t >= hi as isize || s[t as usize] > 0.0 {
                            continue;
                        }
                        s[t as usize] = 1.0;
                        let (e2, a2, b2) = score(scorer, &s, &mut conv, &mut stats.evals, pin);
                        s[t as usize] = 0.0;
                        if e2 < err && best.is_none_or(|b| e2 < b.0) {
                            best = Some((e2, a2, b2, t as usize));
                        }
                    }
                    match best {
                        Some((e2, a2, b2, t)) => {
                            s[t] = 1.0;
                            err = e2;
                            alpha = a2;
                            b = b2;
                            // Refresh the accepted reconstruction.
                            let _ = score(scorer, &s, &mut conv, &mut stats.evals, pin);
                            conv_acc.copy_from_slice(&conv);
                            moved_now += 1;
                        }
                        None => s[j] = 1.0,
                    }
                }
                stats.moved += moved_now;
                if err <= budget && budget > 0.0 {
                    stop = Some(PursuitStop::Budget);
                }
            }
            if stop.is_none() && moved_now == 0 {
                stop = Some(PursuitStop::NoGain);
            }
        }
        if amplitude == Amplitude::FixedFromFirstPass && pin.is_none() && !atom_amps.is_empty() {
            atom_amps.sort_by(|a, b| a.total_cmp(b));
            let m = atom_amps.len();
            let med = if m % 2 == 1 {
                atom_amps[m / 2]
            } else {
                0.5 * (atom_amps[m / 2 - 1] + atom_amps[m / 2])
            };
            if med > 0.0 {
                pin = Some(med);
                // Re-score the current train at the pin so the path continues
                // from a consistent state.
                let (e2, a2, b2) = score(scorer, &s, &mut conv, &mut stats.evals, pin);
                err = e2;
                alpha = a2;
                b = b2;
                conv_acc.copy_from_slice(&conv);
                if err <= budget && budget > 0.0 {
                    stop = Some(PursuitStop::Budget);
                }
            }
        }
    }
    stats.alpha_used = alpha;
    stats.stop = stop.unwrap_or(PursuitStop::Exhausted);
    stats.e_full = err;
    let count_full = count;
    let ceiling = budget.max(err + se);

    if prune && count > 0 {
        loop {
            // Linear estimate of each spike's removal cost, from the current
            // residual's correlation.
            residual_on_grid(&y, &conv_acc, alpha, b, pad, stride, &mut r);
            corr.correlate(&r, &mut c);
            let mut order: Vec<(f64, usize)> = (lo..hi)
                .filter(|&j| s[j] > 0.0)
                .map(|j| {
                    (
                        alpha * alpha * corr.phi_grid_energy - 2.0 * alpha * c[j] as f64,
                        j,
                    )
                })
                .collect();
            order.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut removed = 0usize;
            for &(_, j) in &order {
                s[j] = 0.0;
                let (e2, a2, b2) = score(scorer, &s, &mut conv, &mut stats.evals, pin);
                if e2 <= ceiling {
                    alpha = a2;
                    b = b2;
                    conv_acc.copy_from_slice(&conv);
                    count -= 1;
                    removed += 1;
                } else {
                    s[j] = 1.0;
                }
            }
            stats.pruned += removed;
            if removed == 0 || count == 0 {
                break;
            }
        }
    }

    // Final exact pass for the reported fit (amplitude and offset refit).
    let (e_fin, alpha, baseline) = score(scorer, &s, &mut conv, &mut stats.evals, None);
    let pve = interior_pve(&y, &conv, alpha, baseline, pad);
    let noise_path = budget > 0.0 && e_fin <= budget;
    let diag = SelectionDiag {
        e_min: stats.e_full,
        level_min: 0,
        e_pick: e_fin,
        level_pick: 0,
        budget,
        std_error: se,
        ceiling,
        slack: ceiling - e_fin,
        e_next_sparser: f64::NAN,
        count_next_sparser: 0.0,
        count_pick: count as f64,
        count_min: count_full as f64,
        alpha_pick: alpha,
    };
    (
        ThresholdResult {
            s_binary: s,
            alpha,
            baseline,
            threshold: 0.0,
            pve,
            error: e_fin,
            noise_path,
            diag,
        },
        stats,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::banded::BandedAR2;

    fn lcg_noise(n: usize, amp: f32, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let u = ((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0;
                (u as f32) * amp
            })
            .collect()
    }

    fn spikes_of(s: &[f32]) -> Vec<usize> {
        s.iter()
            .enumerate()
            .filter(|(_, &v)| v > 0.0)
            .map(|(i, _)| i)
            .collect()
    }

    #[test]
    fn recovers_clean_spikes_including_a_doublet() {
        // 300 Hz model, stride 10 (30 Hz grid), four spikes of which two sit
        // in adjacent sub-bins (a doublet). Plain scorer, no noise model: the
        // pursuit must add every spike (each lowers the energy) and stop when
        // nothing positive is left; the frame counts are reproduced exactly
        // (the sub-bin inside a frame is not identifiable from the grid).
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        let n = 6000;
        let mut truth = vec![0.0_f32; n];
        for &p in &[1000usize, 2500, 2501, 4200] {
            truth[p] = 1.0;
        }
        let mut y = vec![0.0_f32; n];
        banded.convolve_forward(&truth, &mut y);
        let y: Vec<f32> = y.iter().map(|&v| 4.0 * v + 1.0).collect();
        let mut sc = Scorer::Plain { y: &y };
        let (r, st) = pursue(
            &mut sc,
            &banded,
            400,
            10,
            None,
            true,
            Amplitude::Refit,
            Gate::Decrease,
            true,
            false,
            None,
        );
        let counts = crate::upsample::downsample_binary(&r.s_binary, 10);
        assert_eq!(
            counts.iter().sum::<f32>(),
            4.0,
            "{:?}",
            spikes_of(&r.s_binary)
        );
        assert_eq!((counts[100], counts[250], counts[420]), (1.0, 2.0, 1.0));
        assert!((r.alpha - 4.0).abs() < 1e-2, "{}", r.alpha);
        assert!(r.pve > 0.999);
        // Without a noise model the gate is zero: the pass after the last true
        // spike either finds no positive maximum or none that improves.
        assert!(matches!(
            st.stop,
            PursuitStop::Exhausted | PursuitStop::NoGain
        ));
    }

    #[test]
    fn budget_stop_fires_on_noise_and_prune_keeps_the_ceiling() {
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        let n = 9000;
        let mut truth = vec![0.0_f32; n];
        for p in (800..n - 800).step_by(700) {
            truth[p] = 1.0;
        }
        let mut clean = vec![0.0_f32; n];
        banded.convolve_forward(&truth, &mut clean);
        let amp = 0.3_f32;
        let noise = lcg_noise(n, amp, 11);
        let y: Vec<f32> = clean
            .iter()
            .zip(&noise)
            .map(|(&c, &e)| 5.0 * c + e)
            .collect();
        let sigma = amp as f64 / 3.0_f64.sqrt();
        let nm = NoiseModel {
            sigma,
            corr_sum: 1.0,
        };
        let pad = 400;
        let stride = 10;
        let n_grid = (pad..n - pad).step_by(stride).count();
        let mut sc = Scorer::Plain { y: &y };
        let (r, st) = pursue(
            &mut sc,
            &banded,
            pad,
            stride,
            Some(nm),
            true,
            Amplitude::Refit,
            Gate::Decrease,
            true,
            false,
            None,
        );
        let ceiling = nm.budget(n_grid).max(st.e_full + nm.std_error(n_grid));
        assert!(r.error <= ceiling, "{} vs {}", r.error, ceiling);
        assert!(
            r.noise_path || st.stop == PursuitStop::NoGain,
            "{:?}",
            st.stop
        );
        // Every true spike in the interior is found within a frame, and the
        // count stays within the truth's.
        let got = spikes_of(&r.s_binary);
        let want: Vec<usize> = spikes_of(&truth)
            .into_iter()
            .filter(|&p| p >= pad && p < n - pad)
            .collect();
        for &p in &want {
            assert!(
                got.iter().any(|&g| g.abs_diff(p) <= stride),
                "spike {p} missing from {got:?}"
            );
        }
        assert!(got.len() <= want.len() + 1, "{got:?} vs {want:?}");
        for &g in &got {
            assert!(g >= pad && g < n - pad, "spike outside the interior: {g}");
        }
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        let banded = BandedAR2::new(0.1, 0.6, 300.0);
        for n in [0usize, 1, 5, 20] {
            let y = vec![1.0_f32; n];
            let mut sc = Scorer::Plain { y: &y };
            let (r, _) = pursue(
                &mut sc,
                &banded,
                4,
                2,
                None,
                true,
                Amplitude::FixedFromFirstPass,
                Gate::OneSe,
                true,
                false,
                None,
            );
            assert_eq!(r.s_binary.len(), n);
            assert!(r.alpha.is_finite() && r.baseline.is_finite());
        }
    }
}
