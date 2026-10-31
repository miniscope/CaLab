use realfft::RealFftPlanner;
use rustfft::num_complex::Complex;
use std::f32::consts::PI;
use std::sync::Arc;

/// Margin factors for deriving bandpass cutoffs from kernel time constants.
/// HP cutoff = 1/(2π·τ_decay·M_HP), LP cutoff = M_LP/(2π·τ_rise).
/// HP uses 16× to preserve the slow calcium decay tail (~40s period for
/// typical τ_decay=0.4s) while still removing sub-calcium baseline drift.
/// LP uses 4× for tighter noise rejection above the kernel's rise band.
const MARGIN_FACTOR_HP: f32 = 16.0;
const MARGIN_FACTOR_LP: f32 = 4.0;

/// Shortest trace the filter and the power spectrum operate on. Below this the
/// spectrum (and its frequency axis) is empty and the filter is a no-op.
pub const MIN_SPECTRUM_LEN: usize = 8;

/// FFT-based bandpass filter derived from kernel time constants.
/// Buffers grow but never shrink (matching Solver convention).
///
/// The FFT treats the trace as periodic, so any level difference between the
/// first and last samples is a step at the wrap point, and the high-pass
/// smears its response to that step over ~1/f_hp at both ends (a linear ramp
/// of height R produced a 0.5·R edge step; photobleaching is such a ramp
/// inside every tile). Both `apply` and `compute_spectrum_only` therefore
/// subtract the straight line through the trace's endpoint levels, each
/// averaged over one HP period (`endpoint_line`, `endpoint_window`), before
/// the forward FFT. With HP active the line stays removed; in LP-only mode it
/// is added back after the inverse FFT.
pub struct BandpassFilter {
    hp_enabled: bool,
    lp_enabled: bool,
    f_hp: f32,
    f_lp: f32,
    fs: f32,
    valid: bool,
    /// Straight line (intercept at sample 0, slope per sample) subtracted from
    /// the trace before the last forward FFT; added back after LP-only.
    line: (f64, f64),

    // FFT infrastructure
    planner: RealFftPlanner<f32>,
    planned_len: usize,

    // Cached FFT plans (Arc from planner, avoids hash-map lookup per call)
    plan_fwd: Option<Arc<dyn realfft::RealToComplex<f32>>>,
    plan_inv: Option<Arc<dyn realfft::ComplexToReal<f32>>>,

    // Grow-only buffers
    fft_input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    gain_curve: Vec<f32>,
    power_spectrum: Vec<f32>,
    scratch_fwd: Vec<Complex<f32>>,
    scratch_inv: Vec<Complex<f32>>,
}

impl BandpassFilter {
    pub fn new() -> Self {
        BandpassFilter {
            hp_enabled: false,
            lp_enabled: false,
            f_hp: 0.0,
            f_lp: 0.0,
            fs: 30.0,
            valid: false,
            line: (0.0, 0.0),
            planner: RealFftPlanner::new(),
            planned_len: 0,
            plan_fwd: None,
            plan_inv: None,
            fft_input: Vec::new(),
            spectrum: Vec::new(),
            gain_curve: Vec::new(),
            power_spectrum: Vec::new(),
            scratch_fwd: Vec::new(),
            scratch_inv: Vec::new(),
        }
    }

    /// Convenience: set both HP and LP together (used by CaTune's single toggle).
    pub fn set_enabled(&mut self, enabled: bool) {
        self.hp_enabled = enabled;
        self.lp_enabled = enabled;
        self.invalidate_gain_curve();
    }

    /// The cached gain curve encodes which of HP/LP is active, so any toggle
    /// must force it to be rebuilt — otherwise e.g. enabling LP after an
    /// HP-only `apply` on a same-length trace silently re-applied HP-only.
    fn invalidate_gain_curve(&mut self) {
        self.planned_len = 0;
    }

    /// Returns true if either HP or LP is active.
    pub fn is_enabled(&self) -> bool {
        self.hp_enabled || self.lp_enabled
    }

    pub fn set_hp_enabled(&mut self, enabled: bool) {
        self.hp_enabled = enabled;
        self.invalidate_gain_curve();
    }

    pub fn set_lp_enabled(&mut self, enabled: bool) {
        self.lp_enabled = enabled;
        self.invalidate_gain_curve();
    }

    pub fn is_hp_enabled(&self) -> bool {
        self.hp_enabled
    }

    /// Compute bandpass cutoffs from kernel time constants.
    pub fn update_cutoffs(&mut self, tau_rise: f64, tau_decay: f64, fs: f64) {
        self.fs = fs as f32;
        let tau_rise = tau_rise as f32;
        let tau_decay = tau_decay as f32;

        if tau_rise <= 0.0 || tau_decay <= 0.0 || fs <= 0.0 {
            self.valid = false;
            return;
        }

        let nyquist = self.fs / 2.0;

        // High-pass: removes sub-calcium drift
        self.f_hp = 1.0 / (2.0 * PI * tau_decay * MARGIN_FACTOR_HP);
        // Low-pass: removes supra-calcium noise
        self.f_lp = MARGIN_FACTOR_LP / (2.0 * PI * tau_rise);

        // Clamp low-pass to Nyquist
        self.f_lp = self.f_lp.min(nyquist);

        // Validity depends on which filters are active (checked at apply time).
        // Pre-compute: both-on requires f_hp < f_lp; individual modes just need
        // positive cutoffs within Nyquist. Store the most permissive condition here
        // and let apply() + build_gain_curve() handle the mode-specific check.
        self.valid = self.f_hp > 0.0 && self.f_lp > 0.0;

        // Invalidate cached gain curve and FFT plans
        self.planned_len = 0;
        self.plan_fwd = None;
        self.plan_inv = None;
    }

    /// Grow-only buffer allocation for FFT of length n.
    fn ensure_buffers(&mut self, n: usize) {
        if n == self.planned_len {
            return;
        }

        let spectrum_len = n / 2 + 1;

        // Grow buffers (never shrink)
        if self.fft_input.len() < n {
            self.fft_input.resize(n, 0.0);
        }
        if self.spectrum.len() < spectrum_len {
            self.spectrum.resize(spectrum_len, Complex::new(0.0, 0.0));
        }
        if self.gain_curve.len() < spectrum_len {
            self.gain_curve.resize(spectrum_len, 0.0);
        }
        if self.power_spectrum.len() < spectrum_len {
            self.power_spectrum.resize(spectrum_len, 0.0);
        }

        // Cache FFT plans and allocate scratch
        let fwd = self.planner.plan_fft_forward(n);
        let inv = self.planner.plan_fft_inverse(n);
        let fwd_scratch = fwd.get_scratch_len();
        let inv_scratch = inv.get_scratch_len();
        if self.scratch_fwd.len() < fwd_scratch {
            self.scratch_fwd.resize(fwd_scratch, Complex::new(0.0, 0.0));
        }
        if self.scratch_inv.len() < inv_scratch {
            self.scratch_inv.resize(inv_scratch, Complex::new(0.0, 0.0));
        }
        self.plan_fwd = Some(fwd);
        self.plan_inv = Some(inv);

        self.build_gain_curve(n);
        self.planned_len = n;
    }

    /// Build cosine-tapered gain curve for the active filter mode.
    ///
    /// - HP+LP: full bandpass (HP taper → passband → LP taper)
    /// - HP-only: HP taper → passband to Nyquist (gain=1.0 above HP)
    /// - LP-only: passband from DC → LP taper → stopband (gain=1.0 below LP)
    fn build_gain_curve(&mut self, n: usize) {
        let spectrum_len = n / 2 + 1;
        let df = self.fs / n as f32;

        let w_hp = self.f_hp * 0.5;
        let w_lp = self.f_lp * 0.5;

        let hp_on = self.hp_enabled;
        let lp_on = self.lp_enabled;

        for i in 0..spectrum_len {
            let f = i as f32 * df;

            // High-pass contribution (1.0 when disabled)
            let hp_gain = if !hp_on {
                1.0
            } else if f < self.f_hp - w_hp {
                0.0
            } else if f < self.f_hp + w_hp {
                let t = (f - (self.f_hp - w_hp)) / (2.0 * w_hp);
                0.5 * (1.0 - (PI * t).cos())
            } else {
                1.0
            };

            // Low-pass contribution (1.0 when disabled)
            let lp_gain = if !lp_on {
                1.0
            } else if f < self.f_lp - w_lp {
                1.0
            } else if f < self.f_lp + w_lp {
                let t = (f - (self.f_lp - w_lp)) / (2.0 * w_lp);
                0.5 * (1.0 + (PI * t).cos())
            } else {
                0.0
            };

            self.gain_curve[i] = hp_gain * lp_gain;
        }
    }

    /// Samples averaged at each end of the trace to estimate the detrend
    /// line's endpoints: one high-pass period, `round(fs / f_hp)` with
    /// f_hp = 1/(2π·16·τ_decay), capped at half the trace so the two windows
    /// never overlap (on a trace shorter than 2/f_hp they are its two halves).
    ///
    /// The wrap artifact is the HP's response to a *persistent* level
    /// difference across the wrap point, smoothed at the HP's own scale: a
    /// transient or noise excursion localised at an edge contributes only
    /// ~alpha·τ_decay·f_hp to it. The endpoint estimate must therefore
    /// average at that same scale. A short window (a sample, or one τ_rise)
    /// would let an edge-cut transient tilt the whole line, converting a
    /// localised event into exactly the persistent 0.5·bias artifact the
    /// detrend is meant to remove (measured: 0.13–0.23 of the transient's
    /// peak with a τ_rise window, 0.02–0.03 with this one). The mean of a
    /// line over any window equals its value at the window's centre, so the
    /// window length costs nothing for a linear trend.
    fn endpoint_window(&self, n: usize) -> usize {
        let m = (self.fs / self.f_hp).round();
        let m = if m.is_finite() && m >= 1.0 {
            m as usize
        } else {
            1
        };
        m.min(n / 2).max(1)
    }

    /// Straight line through the robust endpoints of `trace`, as
    /// `(intercept at sample 0, slope per sample)`. The mean of a line over a
    /// window equals its value at the window's centre, so the line is anchored
    /// at the centres of the two endpoint windows and an exactly linear trace
    /// detrends to zero.
    fn endpoint_line(&self, trace: &[f32]) -> (f64, f64) {
        let n = trace.len();
        let m = self.endpoint_window(n);
        let mean = |s: &[f32]| s.iter().map(|&v| v as f64).sum::<f64>() / m as f64;
        let (y0, y1) = (mean(&trace[..m]), mean(&trace[n - m..]));
        let t0 = (m as f64 - 1.0) / 2.0;
        // Window centres sit at t0 and n-1-t0, which are n-m apart.
        let slope = (y1 - y0) / (n - m) as f64;
        (y0 - slope * t0, slope)
    }

    /// Detrend the trace, forward-FFT it and cache the power spectrum. Used by
    /// both `apply` and `compute_spectrum_only`, so the cached spectrum is
    /// always that of the endpoint-detrended trace (see `get_power_spectrum`).
    /// Returns false (leaving the trace untouched) if the transform fails.
    fn forward_fft_and_cache_power(&mut self, trace: &[f32]) -> bool {
        let n = trace.len();
        self.ensure_buffers(n);
        let spectrum_len = n / 2 + 1;

        // Subtract the line through the trace's endpoints so the periodic
        // extension the FFT assumes has no step at the wrap point.
        let (c, b) = self.endpoint_line(trace);
        self.line = (c, b);
        for (i, (dst, &src)) in self.fft_input[..n].iter_mut().zip(trace).enumerate() {
            *dst = (src as f64 - (c + b * i as f64)) as f32;
        }

        // Forward FFT
        let Some(fwd) = self.plan_fwd.as_ref() else {
            return false;
        };
        if fwd
            .process_with_scratch(
                &mut self.fft_input[..n],
                &mut self.spectrum[..spectrum_len],
                &mut self.scratch_fwd,
            )
            .is_err()
        {
            return false;
        }

        // Cache pre-filter power spectrum
        for (ps, c) in self.power_spectrum[..spectrum_len]
            .iter_mut()
            .zip(&self.spectrum[..spectrum_len])
        {
            *ps = c.re * c.re + c.im * c.im;
        }
        true
    }

    /// Apply bandpass filter in-place. Caches power spectrum. Returns false if skipped.
    pub fn apply(&mut self, trace: &mut [f32]) -> bool {
        if !self.is_enabled() || !self.valid || trace.len() < MIN_SPECTRUM_LEN {
            return false;
        }

        // Mode-specific validity: HP+LP requires f_hp < f_lp
        if self.hp_enabled && self.lp_enabled && self.f_hp >= self.f_lp {
            return false;
        }

        let n = trace.len();
        if !self.forward_fft_and_cache_power(trace) {
            return false;
        }
        let spectrum_len = n / 2 + 1;

        // Apply gain curve
        for (s, &g) in self.spectrum[..spectrum_len]
            .iter_mut()
            .zip(&self.gain_curve[..spectrum_len])
        {
            *s *= g;
        }

        // Inverse FFT (use cached plan — no hash-map lookup)
        // On failure (only possible with non-finite data, which the FFI rejects)
        // report "not applied" and leave the trace untouched instead of panicking.
        let Some(inv) = self.plan_inv.as_ref() else {
            return false;
        };
        if inv
            .process_with_scratch(
                &mut self.spectrum[..spectrum_len],
                &mut self.fft_input[..n],
                &mut self.scratch_inv,
            )
            .is_err()
        {
            return false;
        }

        // Normalize (realfft doesn't normalize). With HP active the detrend
        // line stays removed: it is a sub-corner trend of exactly the kind the
        // HP exists to reject (its slope spans the whole trace, far below
        // f_hp). LP-only promises to preserve DC and slow trends, so there the
        // line goes back in.
        let scale = 1.0 / n as f32;
        if self.hp_enabled {
            for (t, &f) in trace.iter_mut().zip(&self.fft_input[..n]) {
                *t = f * scale;
            }
        } else {
            let (c, b) = self.line;
            for (i, (t, &f)) in trace.iter_mut().zip(&self.fft_input[..n]).enumerate() {
                *t = ((f * scale) as f64 + c + b * i as f64) as f32;
            }
        }

        true
    }

    /// Compute power spectrum without filtering (for visualization when filter is off).
    /// Detrends exactly as `apply` does, so the cached spectrum is the same for
    /// a given trace whether or not the filter is on.
    pub fn compute_spectrum_only(&mut self, trace: &[f32]) {
        if trace.len() < MIN_SPECTRUM_LEN {
            return;
        }
        self.forward_fft_and_cache_power(trace);
    }

    /// Get the power spectrum (N/2+1 bins of |FFT|²) cached by the last
    /// `apply` or `compute_spectrum_only`.
    ///
    /// It is the spectrum of the endpoint-detrended trace, not of the raw
    /// one: the raw trace's periodic extension has a step at the wrap point
    /// whose 1/f² leakage would otherwise ride over every bin, and detrending
    /// in both paths keeps the cached spectrum identical for a given trace
    /// whether or not the filter is on. Only the DC bin and that leakage
    /// differ from the raw spectrum.
    pub fn get_power_spectrum(&self, n: usize) -> &[f32] {
        let spectrum_len = n / 2 + 1;
        if self.power_spectrum.len() >= spectrum_len {
            &self.power_spectrum[..spectrum_len]
        } else {
            &[]
        }
    }

    /// Get frequency axis in Hz for the spectrum bins of an `n`-sample trace:
    /// `n/2 + 1` bins, or empty when `n < MIN_SPECTRUM_LEN` (no spectrum is
    /// computed for such traces, and `n = 0` would divide by zero).
    pub fn get_spectrum_frequencies(&self, n: usize) -> Vec<f32> {
        if n < MIN_SPECTRUM_LEN {
            return Vec::new();
        }
        let spectrum_len = n / 2 + 1;
        let df = self.fs / n as f32;
        (0..spectrum_len).map(|i| i as f32 * df).collect()
    }

    /// Get filter cutoff frequencies [f_hp, f_lp].
    pub fn get_cutoffs(&self) -> [f32; 2] {
        [self.f_hp, self.f_lp]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_filter(tau_rise: f64, tau_decay: f64, fs: f64) -> BandpassFilter {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(tau_rise, tau_decay, fs);
        f.set_enabled(true);
        f
    }

    #[test]
    fn test_cutoff_computation() {
        let f = make_filter(0.02, 0.4, 30.0);
        assert!(f.valid);
        // f_hp = 1/(2*pi*0.4*16) ~ 0.0249 Hz
        assert!((f.f_hp - 0.0249).abs() < 0.005);
        // f_lp = 4/(2*pi*0.02) ~ 31.83 Hz, clamped to Nyquist=15 Hz
        assert!((f.f_lp - 15.0).abs() < 0.01);
    }

    #[test]
    fn test_passband_preservation() {
        let mut f = make_filter(0.02, 0.4, 100.0);
        let n = 1024;
        let fs = 100.0_f32;

        // Generate a sine wave in the passband (1 Hz — well within the band)
        let freq = 1.0_f32;
        let mut trace: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect();
        let orig_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let original_ac_power: f32 = trace.iter().map(|x| (x - orig_mean).powi(2)).sum();

        assert!(f.apply(&mut trace));

        // Compare AC power (variance) — robust to baseline shift
        let filt_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let filtered_ac_power: f32 = trace.iter().map(|x| (x - filt_mean).powi(2)).sum();
        // Passband should preserve >90% of AC power
        assert!(
            filtered_ac_power / original_ac_power > 0.9,
            "passband AC power ratio: {}",
            filtered_ac_power / original_ac_power
        );
    }

    #[test]
    fn test_stopband_attenuation() {
        let mut f = make_filter(0.02, 0.4, 100.0);
        let n = 65536;
        let fs = 100.0_f32;

        // Generate a very low frequency sine (0.005 Hz — well below high-pass cutoff ~0.025 Hz)
        // Use 65536 samples for sufficient frequency resolution at the low HP cutoff
        let freq = 0.005_f32;
        let mut trace: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect();
        let original_power: f32 = trace.iter().map(|x| x * x).sum();

        assert!(f.apply(&mut trace));

        let filtered_power: f32 = trace.iter().map(|x| x * x).sum();
        // Stopband should attenuate to <10% of original power
        assert!(
            filtered_power / original_power < 0.1,
            "stopband power ratio: {}",
            filtered_power / original_power
        );
    }

    #[test]
    fn test_dc_removal() {
        let mut f = make_filter(0.02, 0.4, 100.0);
        let n = 256;

        // Constant DC offset trace
        let mut trace = vec![5.0_f32; n];
        assert!(f.apply(&mut trace));

        // DC should be removed (mean near zero)
        let mean: f32 = trace.iter().sum::<f32>() / n as f32;
        assert!(mean.abs() < 0.1, "DC not removed, mean: {}", mean);
    }

    #[test]
    fn test_round_trip_fft() {
        let mut f = make_filter(0.001, 10.0, 100.0);
        // With extremely wide band, round-trip should approximately preserve signal.
        // The 2.56 s trace is far shorter than 1/f_hp (1000 s), so the endpoint
        // detrend removes any line through the endpoints that the HP itself
        // could not resolve; use a whole number of cosine cycles so the
        // endpoints match and the signal is what the round trip sees.
        let n = 256;
        let fs = 100.0_f32;
        let freq = 13.0 * fs / n as f32; // ~5.08 Hz, 13 cycles in the window
        let original: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).cos())
            .collect();
        let mut trace = original.clone();

        assert!(f.apply(&mut trace));

        // Mean-subtracted correlation — robust to baseline shift
        let mean_t: f32 = trace.iter().sum::<f32>() / n as f32;
        let mean_o: f32 = original.iter().sum::<f32>() / n as f32;
        let dot: f32 = trace
            .iter()
            .zip(original.iter())
            .map(|(a, b)| (a - mean_t) * (b - mean_o))
            .sum();
        let norm_t: f32 = trace
            .iter()
            .map(|x| (x - mean_t).powi(2))
            .sum::<f32>()
            .sqrt();
        let norm_o: f32 = original
            .iter()
            .map(|x| (x - mean_o).powi(2))
            .sum::<f32>()
            .sqrt();
        let correlation = dot / (norm_t * norm_o + 1e-10);
        assert!(
            correlation > 0.95,
            "round-trip correlation: {}",
            correlation
        );
    }

    #[test]
    fn test_short_trace_skip() {
        let mut f = make_filter(0.02, 0.4, 30.0);
        let mut trace = vec![1.0, 2.0, 3.0];
        assert!(!f.apply(&mut trace));
    }

    #[test]
    fn test_invalid_cutoffs_skip() {
        let mut f = BandpassFilter::new();
        // tau_rise very large, tau_decay very small -> f_hp > f_lp
        f.update_cutoffs(10.0, 0.001, 30.0);
        f.set_enabled(true); // both HP+LP: requires f_hp < f_lp
        let mut trace = vec![1.0; 64];
        assert!(!f.apply(&mut trace));
    }

    #[test]
    fn test_disabled_noop() {
        let mut f = make_filter(0.02, 0.4, 30.0);
        f.set_enabled(false);
        let mut trace = vec![1.0; 64];
        let original = trace.clone();
        assert!(!f.apply(&mut trace));
        assert_eq!(trace, original);
    }

    #[test]
    fn test_hp_only_removes_dc() {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.02, 0.4, 100.0);
        f.set_hp_enabled(true);
        f.set_lp_enabled(false);
        let n = 256;

        // Constant DC offset trace
        let mut trace = vec![5.0_f32; n];
        assert!(f.apply(&mut trace));

        // DC should be removed
        let mean: f32 = trace.iter().sum::<f32>() / n as f32;
        assert!(mean.abs() < 0.1, "HP-only: DC not removed, mean: {}", mean);
    }

    #[test]
    fn test_hp_only_preserves_passband() {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.02, 0.4, 100.0);
        f.set_hp_enabled(true);
        f.set_lp_enabled(false);
        let n = 1024;
        let fs = 100.0_f32;

        // 1 Hz sine — well above HP cutoff (~0.025 Hz)
        let freq = 1.0_f32;
        let mut trace: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect();
        let orig_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let original_ac_power: f32 = trace.iter().map(|x| (x - orig_mean).powi(2)).sum();

        assert!(f.apply(&mut trace));

        let filt_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let filtered_ac_power: f32 = trace.iter().map(|x| (x - filt_mean).powi(2)).sum();
        assert!(
            filtered_ac_power / original_ac_power > 0.9,
            "HP-only passband AC ratio: {}",
            filtered_ac_power / original_ac_power
        );
    }

    #[test]
    fn test_hp_only_preserves_high_freq() {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.02, 0.4, 100.0);
        f.set_hp_enabled(true);
        f.set_lp_enabled(false);
        let n = 1024;
        let fs = 100.0_f32;

        // 40 Hz sine — near Nyquist, should be preserved (no LP filter)
        let freq = 40.0_f32;
        let mut trace: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect();
        let orig_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let original_ac_power: f32 = trace.iter().map(|x| (x - orig_mean).powi(2)).sum();

        assert!(f.apply(&mut trace));

        let filt_mean: f32 = trace.iter().sum::<f32>() / n as f32;
        let filtered_ac_power: f32 = trace.iter().map(|x| (x - filt_mean).powi(2)).sum();
        assert!(
            filtered_ac_power / original_ac_power > 0.9,
            "HP-only should preserve high-freq, AC ratio: {}",
            filtered_ac_power / original_ac_power
        );
    }

    #[test]
    fn test_lp_only_preserves_dc() {
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.02, 0.4, 100.0);
        f.set_hp_enabled(false);
        f.set_lp_enabled(true);
        let n = 256;

        // Constant DC offset trace — LP-only should preserve it
        let mut trace = vec![5.0_f32; n];
        assert!(f.apply(&mut trace));

        let mean: f32 = trace.iter().sum::<f32>() / n as f32;
        assert!(
            (mean - 5.0).abs() < 0.1,
            "LP-only should preserve DC, mean: {}",
            mean
        );
    }

    #[test]
    fn test_lp_only_attenuates_high_freq() {
        let mut f = BandpassFilter::new();
        // Use tau_rise=0.02, tau_decay=0.4 at fs=100 → f_lp ≈ 31.8 Hz, clamped to 50 Hz Nyquist
        // For a tighter LP, use tau_rise=0.1 → f_lp ≈ 6.37 Hz
        f.update_cutoffs(0.1, 0.4, 100.0);
        f.set_hp_enabled(false);
        f.set_lp_enabled(true);
        let n = 1024;
        let fs = 100.0_f32;

        // 40 Hz sine — well above LP cutoff
        let freq = 40.0_f32;
        let mut trace: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
            .collect();
        let original_power: f32 = trace.iter().map(|x| x * x).sum();

        assert!(f.apply(&mut trace));

        let filtered_power: f32 = trace.iter().map(|x| x * x).sum();
        assert!(
            filtered_power / original_power < 0.1,
            "LP-only should attenuate high-freq, power ratio: {}",
            filtered_power / original_power
        );
    }

    // ── Edge-wrap (periodic-extension) artifact ─────────────────────────
    //
    // The FFT treats the trace as periodic; a level difference between the
    // first and last samples is a step at the wrap point. Before endpoint
    // detrending, HP of a unit ramp carried a 0.5 step at both edges that
    // decayed over ~1/f_hp (8 s jgcamp8f … 45 s gcamp6s at 300 Hz).

    /// Kernel time constants of every simulator preset, at the production
    /// upsampled rate.
    fn preset_taus() -> Vec<(&'static str, f64, f64)> {
        crate::simulate::presets::all()
            .into_iter()
            .map(|(name, cfg)| (name, cfg.kernel.tau_rise_s, cfg.kernel.tau_decay_s))
            .collect()
    }

    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| i as f32 / (n - 1) as f32).collect()
    }

    fn max_abs(x: &[f32]) -> f32 {
        x.iter().fold(0.0_f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn hp_ramp_has_no_edge_step() {
        let fs = 300.0;
        let n = (100.0 * fs) as usize;
        for (name, tr, td) in preset_taus() {
            for lp in [false, true] {
                let mut f = BandpassFilter::new();
                f.update_cutoffs(tr, td, fs);
                f.set_hp_enabled(true);
                f.set_lp_enabled(lp);
                let mut t = ramp(n);
                assert!(f.apply(&mut t));
                // Was 0.5·R at both edges; an exactly linear trace now detrends
                // to zero up to f32 rounding of the ramp itself.
                assert!(
                    max_abs(&t) < 1e-4,
                    "{name} lp={lp}: HP(ramp) edge residual {} of R",
                    max_abs(&t)
                );
            }
        }
    }

    #[test]
    fn hp_ramp_edge_robust_to_single_outlier() {
        // One corrupted sample at the edge must not set the detrend line. With
        // m samples averaged per endpoint an outlier of height R shifts the
        // line by R/m and the residual wrap step by 0.5·R/m; a single-sample
        // endpoint would have left the full 0.5·R step, a τ_rise window
        // (m = 30 here) 0.017·R.
        let fs = 300.0;
        let n = (100.0 * fs) as usize;
        for (name, tr, td) in preset_taus() {
            let mut f = BandpassFilter::new();
            f.update_cutoffs(tr, td, fs);
            f.set_hp_enabled(true);
            f.set_lp_enabled(false);
            let m = f.endpoint_window(n);
            let [f_hp, _] = f.get_cutoffs();
            assert_eq!(
                m,
                ((fs as f32 / f_hp).round() as usize).min(n / 2),
                "{name}"
            );
            let mut t = ramp(n);
            t[0] += 1.0;
            assert!(f.apply(&mut t));
            // Skip the outlier sample itself (HP passes the impulse).
            let residual = max_abs(&t[1..]);
            assert!(
                residual < 1e-3,
                "{name}: residual {residual} of R with m={m}"
            );
        }
    }

    #[test]
    fn edge_cut_transient_does_not_leak() {
        // A tile cut at a transient's onset (or mid-decay) is common. The
        // detrend must not turn that localised event into a persistent level
        // error: measure the HP output beyond 5·τ_decay from the transient,
        // relative to its peak. Without detrending this was 0.02–0.03 (the HP
        // removing the transient's own 1/f_hp-scale mean); a τ_rise endpoint
        // window gave 0.13–0.23; the HP-period window gives 0.03–0.07 (the
        // upper end is gcamp6s, whose window is capped at half this trace).
        let fs = 300.0;
        let n = (100.0 * fs) as usize;
        for (name, tr, td) in preset_taus() {
            let kernel = crate::kernel::build_kernel(tr, td, fs);
            let peak = kernel.iter().copied().fold(0.0_f32, f32::max);
            let far = ((5.0 * td * fs) as usize).min(n / 2);
            for at_end in [false, true] {
                let mut y = vec![0.0_f32; n];
                for (i, &kv) in kernel.iter().enumerate().take(n) {
                    let j = if at_end { n - 1 - i } else { i };
                    y[j] = kv;
                }
                let mut f = BandpassFilter::new();
                f.update_cutoffs(tr, td, fs);
                f.set_hp_enabled(true);
                f.set_lp_enabled(false);
                assert!(f.apply(&mut y));
                let leak = if at_end {
                    max_abs(&y[..n - far])
                } else {
                    max_abs(&y[far..])
                } / peak;
                assert!(
                    leak < 0.1,
                    "{name} at_end={at_end}: edge transient leak {leak} of peak"
                );
            }
        }
    }

    #[test]
    fn constant_offset_unchanged_behaviour() {
        let fs = 300.0;
        let n = (100.0 * fs) as usize;
        for (name, tr, td) in preset_taus() {
            // HP (either mode) removes a constant entirely, as before.
            for lp in [false, true] {
                let mut f = BandpassFilter::new();
                f.update_cutoffs(tr, td, fs);
                f.set_hp_enabled(true);
                f.set_lp_enabled(lp);
                let mut t = vec![7.5_f32; n];
                assert!(f.apply(&mut t));
                assert!(
                    max_abs(&t) < 1e-4,
                    "{name} lp={lp}: HP(const) {}",
                    max_abs(&t)
                );
            }
            // LP-only preserves it.
            let mut f = BandpassFilter::new();
            f.update_cutoffs(tr, td, fs);
            f.set_hp_enabled(false);
            f.set_lp_enabled(true);
            let mut t = vec![7.5_f32; n];
            assert!(f.apply(&mut t));
            let err = t.iter().fold(0.0_f32, |m, v| m.max((v - 7.5).abs()));
            assert!(err < 1e-4, "{name}: LP-only const error {err}");
        }
    }

    #[test]
    fn lp_only_preserves_ramp() {
        // LP-only promises to keep DC and slow trends; before detrending the
        // wrap step rang through the LP taper (0.3–0.5·R at the edges).
        let fs = 300.0;
        let n = (100.0 * fs) as usize;
        for (name, tr, td) in preset_taus() {
            let mut f = BandpassFilter::new();
            f.update_cutoffs(tr, td, fs);
            f.set_hp_enabled(false);
            f.set_lp_enabled(true);
            let r = ramp(n);
            let mut t = r.clone();
            assert!(f.apply(&mut t));
            let err = t
                .iter()
                .zip(&r)
                .fold(0.0_f32, |m, (a, b)| m.max((a - b).abs()));
            assert!(err < 1e-4, "{name}: LP-only ramp error {err} of R");
        }
    }

    /// HP of a bleaching trace against the same filter run on the trace's
    /// even (mirror) extension, a wrap-free reference. Returns the max
    /// deviation over the first/last 1/f_hp seconds and over the whole trace.
    fn bleach_edge_residual(tr: f64, td: f64, fs: f64, with_lp: bool) -> (f32, f32) {
        let dur = 100.0;
        let n = (dur * fs) as usize;
        let kernel = crate::kernel::build_kernel(tr, td, fs);
        // Baseline 1, transients of amplitude 1 (ΔF/F ≈ 1) in the interior.
        let mut y = vec![1.0_f32; n];
        for &t0 in &[0.2, 0.35, 0.5, 0.62, 0.8] {
            let s = (t0 * n as f64) as usize;
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    y[s + k] += kv;
                }
            }
        }
        // Photobleaching: exponential with a time constant several times the
        // trace length, i.e. a slow ramp (~28% drop over the trace).
        let tau_b = 3.0 * dur;
        for (i, v) in y.iter_mut().enumerate() {
            *v *= (-(i as f64 / fs) / tau_b).exp() as f32;
        }
        let run = |z: &[f32]| {
            let mut f = BandpassFilter::new();
            f.update_cutoffs(tr, td, fs);
            f.set_hp_enabled(true);
            f.set_lp_enabled(with_lp);
            let mut o = z.to_vec();
            assert!(f.apply(&mut o));
            o
        };
        let direct = run(&y);
        // Even (mirror) extension: [y, reversed y] is continuous across every
        // junction of its periodic extension, so filtering it is wrap-free.
        let mut padded = y.clone();
        padded.extend(y.iter().rev().copied());
        let reference = &run(&padded)[..n];
        let d: Vec<f32> = direct
            .iter()
            .zip(reference)
            .map(|(a, b)| (a - b).abs())
            .collect();
        let f_hp = 1.0 / (2.0 * std::f64::consts::PI * td * MARGIN_FACTOR_HP as f64);
        let w = ((fs / f_hp) as usize).min(n / 2);
        let edge = max_abs(&d[..w]).max(max_abs(&d[n - w..]));
        (edge, max_abs(&d))
    }

    #[test]
    fn photobleaching_edge_residual_bounded() {
        // Transient amplitude is 1, so residuals are in units of alpha. Before
        // detrending the edge residual was 0.3–1.6 alpha (HP-only) across the
        // presets; it is now a few percent of alpha. The remainder is the
        // bleach curvature and the transients' own bleach modulation, which a
        // linear detrend cannot (and should not) remove.
        let fs = 300.0;
        for (name, tr, td) in preset_taus() {
            for lp in [false, true] {
                let (edge, _) = bleach_edge_residual(tr, td, fs, lp);
                assert!(
                    edge < 0.1,
                    "{name} lp={lp}: bleach edge residual {edge} alpha"
                );
            }
        }
    }

    #[test]
    fn cached_spectrum_is_of_detrended_trace() {
        let fs = 300.0;
        let n = (10.0 * fs) as usize;
        let mut f = BandpassFilter::new();
        f.update_cutoffs(0.1, 0.6, fs);
        // A pure ramp detrends to ~0: no power anywhere, not even at DC.
        f.compute_spectrum_only(&ramp(n));
        let ps = f.get_power_spectrum(n).to_vec();
        assert_eq!(ps.len(), n / 2 + 1);
        assert!(max_abs(&ps) < 1e-4, "ramp power {}", max_abs(&ps));
        // apply() and compute_spectrum_only() cache the same spectrum.
        let trace: Vec<f32> = (0..n)
            .map(|i| 3.0 + 0.01 * i as f32 + (0.2 * i as f32).sin())
            .collect();
        f.compute_spectrum_only(&trace);
        let from_spectrum_only = f.get_power_spectrum(n).to_vec();
        f.set_enabled(true);
        let mut t = trace.clone();
        assert!(f.apply(&mut t));
        assert_eq!(f.get_power_spectrum(n), &from_spectrum_only[..]);
    }
}
