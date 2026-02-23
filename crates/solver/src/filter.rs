use realfft::RealFftPlanner;
use rustfft::num_complex::Complex;
use std::f32::consts::PI;

/// Margin factors for deriving bandpass cutoffs from kernel time constants.
/// HP cutoff = 1/(2π·τ_decay·M_HP), LP cutoff = M_LP/(2π·τ_rise).
/// HP uses 16× to preserve the slow calcium decay tail (~40s period for
/// typical τ_decay=0.4s) while still removing sub-calcium baseline drift.
/// LP uses 4× for tighter noise rejection above the kernel's rise band.
const MARGIN_FACTOR_HP: f32 = 16.0;
const MARGIN_FACTOR_LP: f32 = 4.0;

/// FFT-based bandpass filter derived from kernel time constants.
/// Buffers grow but never shrink (matching Solver convention).
pub struct BandpassFilter {
    enabled: bool,
    f_hp: f32,
    f_lp: f32,
    fs: f32,
    valid: bool,

    // FFT infrastructure
    planner: RealFftPlanner<f32>,
    planned_len: usize,

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
            enabled: false,
            f_hp: 0.0,
            f_lp: 0.0,
            fs: 30.0,
            valid: false,
            planner: RealFftPlanner::new(),
            planned_len: 0,
            fft_input: Vec::new(),
            spectrum: Vec::new(),
            gain_curve: Vec::new(),
            power_spectrum: Vec::new(),
            scratch_fwd: Vec::new(),
            scratch_inv: Vec::new(),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
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
        if self.f_lp > nyquist {
            self.f_lp = nyquist;
        }

        // Invalid if high-pass >= low-pass
        self.valid = self.f_hp < self.f_lp;

        // Invalidate cached gain curve
        self.planned_len = 0;
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

        self.build_gain_curve(n);
        self.planned_len = n;
    }

    /// Build cosine-tapered bandpass gain curve.
    fn build_gain_curve(&mut self, n: usize) {
        let spectrum_len = n / 2 + 1;
        let df = self.fs / n as f32;

        // Taper widths: 50% of respective cutoff frequency
        let w_hp = self.f_hp * 0.5;
        let w_lp = self.f_lp * 0.5;

        for i in 0..spectrum_len {
            let f = i as f32 * df;

            let gain = if f < self.f_hp - w_hp {
                // Stopband (below high-pass)
                0.0
            } else if f < self.f_hp + w_hp {
                // High-pass transition (cosine taper 0 -> 1)
                let t = (f - (self.f_hp - w_hp)) / (2.0 * w_hp);
                0.5 * (1.0 - (PI * t).cos())
            } else if f < self.f_lp - w_lp {
                // Passband
                1.0
            } else if f < self.f_lp + w_lp {
                // Low-pass transition (cosine taper 1 -> 0)
                let t = (f - (self.f_lp - w_lp)) / (2.0 * w_lp);
                0.5 * (1.0 + (PI * t).cos())
            } else {
                // Stopband (above low-pass)
                0.0
            };

            self.gain_curve[i] = gain;
        }
    }

    /// Apply bandpass filter in-place. Caches power spectrum. Returns false if skipped.
    pub fn apply(&mut self, trace: &mut [f32]) -> bool {
        if !self.enabled || !self.valid || trace.len() < 8 {
            return false;
        }

        let n = trace.len();
        self.ensure_buffers(n);
        let spectrum_len = n / 2 + 1;

        // Copy trace into fft_input
        self.fft_input[..n].copy_from_slice(trace);

        // Forward FFT
        let fwd = self.planner.plan_fft_forward(n);
        fwd.process_with_scratch(
            &mut self.fft_input[..n],
            &mut self.spectrum[..spectrum_len],
            &mut self.scratch_fwd,
        )
        .unwrap();

        // Cache pre-filter power spectrum
        for i in 0..spectrum_len {
            let c = self.spectrum[i];
            self.power_spectrum[i] = c.re * c.re + c.im * c.im;
        }

        // Apply gain curve
        for i in 0..spectrum_len {
            self.spectrum[i] *= self.gain_curve[i];
        }

        // Inverse FFT
        let inv = self.planner.plan_fft_inverse(n);
        inv.process_with_scratch(
            &mut self.spectrum[..spectrum_len],
            &mut self.fft_input[..n],
            &mut self.scratch_inv,
        )
        .unwrap();

        // Normalize (realfft doesn't normalize)
        let scale = 1.0 / n as f32;
        for i in 0..n {
            trace[i] = self.fft_input[i] * scale;
        }

        true
    }

    /// Compute power spectrum without filtering (for visualization when filter is off).
    pub fn compute_spectrum_only(&mut self, trace: &[f32]) {
        if trace.len() < 8 {
            return;
        }

        let n = trace.len();
        self.ensure_buffers(n);
        let spectrum_len = n / 2 + 1;

        self.fft_input[..n].copy_from_slice(trace);

        let fwd = self.planner.plan_fft_forward(n);
        fwd.process_with_scratch(
            &mut self.fft_input[..n],
            &mut self.spectrum[..spectrum_len],
            &mut self.scratch_fwd,
        )
        .unwrap();

        for i in 0..spectrum_len {
            let c = self.spectrum[i];
            self.power_spectrum[i] = c.re * c.re + c.im * c.im;
        }
    }

    /// Get power spectrum (N/2+1 bins of |FFT|²).
    pub fn get_power_spectrum(&self, n: usize) -> &[f32] {
        let spectrum_len = n / 2 + 1;
        if self.power_spectrum.len() >= spectrum_len {
            &self.power_spectrum[..spectrum_len]
        } else {
            &[]
        }
    }

    /// Get frequency axis in Hz for the spectrum bins.
    pub fn get_spectrum_frequencies(&self, n: usize) -> Vec<f32> {
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
        // With extremely wide band, round-trip should approximately preserve signal
        let n = 256;
        let fs = 100.0_f32;
        let freq = 5.0_f32;
        let original: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / fs).sin())
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
        f.set_enabled(true);
        assert!(!f.valid);
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
}
