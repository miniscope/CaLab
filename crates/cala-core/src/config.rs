//! Recording metadata and pipeline configuration.
//!
//! **Rule:** algorithm code never reads `DEFAULT_*` constants directly.
//! It reads from a config struct the caller passed in. The `DEFAULT_*`
//! constants are only the *source* of each builder's initial value —
//! they set the default, they don't control behavior at call sites.
//! This keeps every tuning knob overridable without source edits.

/// Default assumption for neuron cell-body diameter, used when the caller
/// doesn't specify one on `RecordingMetadata`.
pub const DEFAULT_NEURON_DIAMETER_UM: f32 = 10.0;

/// Default Butterworth high-pass cutoff period, expressed as a multiple
/// of neuron diameters. Cutoff period (pixels) = this × neuron diameter
/// in pixels. K = 3 attenuates spatial features larger than ~3 cell
/// bodies (illumination glow, broad shading) while letting neuron-scale
/// content pass untouched. Only read when the Butterworth stage is
/// enabled — see `DEFAULT_HIGH_PASS_ENABLED`.
pub const DEFAULT_HIGH_PASS_DIAMETERS: f32 = 3.0;

/// Default Butterworth filter order. Higher = sharper rolloff; 4 is a
/// common compromise between sharpness and avoiding ringing artifacts.
pub const DEFAULT_HIGH_PASS_ORDER: u32 = 4;

/// Butterworth high-pass is **off** by default as of the Phase 1
/// minimal-preprocessing decision (design §3.1): broad illumination
/// artifacts are OMF's problem to absorb via a vignetting background
/// component, not preprocessing's problem to subtract. Enable per-
/// recording if OMF struggles.
pub const DEFAULT_HIGH_PASS_ENABLED: bool = false;

/// Row+column mean subtraction is **off** by default. Same rationale
/// as the Butterworth default — structured row/col sensor artifacts
/// are low-rank and OMF will absorb them cleanly.
pub const DEFAULT_BAND_ENABLED: bool = false;

/// Default motion-correction search radius, in pixels. Phase correlation
/// finds the peak only within `|dy|, |dx| ≤ this`. 20 px comfortably
/// covers frame-to-frame jitter on typical miniscope recordings while
/// keeping search cheap.
pub const DEFAULT_MOTION_MAX_SHIFT_PX: u32 = 20;

/// Whether motion correction does a second phase-correlation pass
/// against the running mean of corrected frames (the "global anchor").
/// Local-anchor alone handles jitter well; the global pass catches
/// slow drift. On by default per design §3.
pub const DEFAULT_MOTION_USE_GLOBAL_ANCHOR: bool = true;

/// Sigma (in pixels) of the optional Gaussian low-pass applied *inside*
/// the motion stage before the row+column demean. 0 disables — the
/// demean alone is usually enough, since the upstream 3×3 hot-pixel
/// median already kills shot noise. Bump to ~4 if the correlator needs
/// extra smoothing on a noisy recording.
pub const DEFAULT_MOTION_SMOOTH_SIGMA_PX: f32 = 0.0;

/// Fraction of each axis fed to the motion correlator as a center crop.
/// The sharp bilinear shift is still applied to the full frame — this
/// only restricts what the correlator sees. Miniscope lenses have
/// strong edge rolloff / vignetting artifacts that bias the correlation
/// peak; cropping to the cleaner center region avoids that.
/// 1.0 = no crop (full frame). 0.6 = keep middle 60% of each axis
/// (15% trimmed per side).
pub const DEFAULT_MOTION_CORR_CROP_FRAC: f32 = 0.6;

/// Square kernel size of the median filter applied *after* motion
/// correction for spatial denoising (Chang's cala reference uses 7,
/// we validated 9 on real data). Must be odd. **Default 1 (disabled)**
/// per the minimal-preprocessing decision — per-pixel shot noise is
/// OMF's job (it falls in the residual, unmodeled), and the median's
/// spatial extent overlaps the cell-body scale which risks smearing
/// the signal we're trying to extract.
pub const DEFAULT_DENOISE_MEDIAN_KSIZE: usize = 1;

/// How to reduce a multi-channel AVI frame to grayscale. Miniscope
/// recordings are physically monochrome — 3-channel files usually have
/// R=G=B or have the real signal only in the green channel — so `Green`
/// is the pragmatic default. `Luminance` is there for recordings that
/// carry meaningful information across all three channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrayscaleMethod {
    /// Take the green channel as the grayscale value. Single-channel
    /// (already grayscale) inputs are passed through unchanged.
    Green,
    /// Rec. 601 luminance: `0.299·R + 0.587·G + 0.114·B`.
    Luminance,
}

/// Default conversion method for multi-channel AVI frames.
pub const DEFAULT_GRAYSCALE_METHOD: GrayscaleMethod = GrayscaleMethod::Green;

/// Correlation method used by motion correction to find the peak
/// offset between frames.
///
/// `Cross` (default): straight FFT cross-correlation (`F · conj(G)`,
/// then IFFT). Peak magnitude scales with signal amplitude, so bright
/// coherent features dominate the surface. Robust to sparse/noisy
/// data where weak bins would otherwise be amplified.
///
/// `Phase`: classic phase correlation (`F · conj(G) / |F · conj(G)|`),
/// which normalizes every frequency bin to unit magnitude. Gives
/// sharper peaks on clean signals but breaks down when most bins
/// carry only noise — it amplifies that noise. Kept for back-compat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionCorrelation {
    /// FFT cross-correlation: `F · conj(G)`. Peak stays dominated by
    /// real coherent structure, works on diffuse miniscope data.
    Cross,
    /// FFT phase correlation: normalized per-bin. Sharper peak on
    /// clean signals, but noise-sensitive when the spectrum is sparse.
    Phase,
}

/// Default correlation method. Cross-correlation works better on
/// diffuse, noisy miniscope frames (validated on real V4 recordings);
/// phase correlation needs a cleaner spectrum than we can provide.
pub const DEFAULT_MOTION_CORRELATION: MotionCorrelation = MotionCorrelation::Cross;

/// How the motion stage refines the integer-bin peak into a subpixel
/// shift.
///
/// `Centroid` (default): weighted center-of-mass over a `(2r+1)²`
/// neighborhood, with the neighborhood's local minimum subtracted so
/// the weights are bias-free. Robust on broad/diffuse peaks (miniscope
/// data), which is the common case.
///
/// `Parabolic`: 1D parabolic fit through the peak and its ±1 neighbors
/// on each axis. Tighter when the peak is sharp and Gaussian-shaped,
/// but over-trusts the two immediate neighbors when they carry noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionSubpixel {
    Centroid,
    Parabolic,
}

/// Default subpixel method. Centroid consistently tracks diffuse
/// miniscope peaks better than parabolic fit in ablation testing.
pub const DEFAULT_MOTION_SUBPIXEL: MotionSubpixel = MotionSubpixel::Centroid;

/// Radius (in bins) of the centroid neighborhood used when
/// `motion_subpixel == Centroid`. Ignored by the parabolic path.
/// Window size is `(2r+1)²`; r=2 → 5×5, r=3 → 7×7.
pub const DEFAULT_MOTION_SUBPIXEL_RADIUS: usize = 2;

/// Physical properties of a recording.
///
/// Required: `pixel_size_um`. Every other field has a documented default
/// that can be overridden with `with_*` builder methods.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecordingMetadata {
    /// Physical size of one image pixel in micrometers.
    pub pixel_size_um: f32,
    /// Typical neuron cell-body diameter in micrometers. Used for
    /// downstream cutoff derivations.
    pub neuron_diameter_um: f32,
}

impl RecordingMetadata {
    /// Construct metadata with the given pixel size and the default
    /// neuron diameter (`DEFAULT_NEURON_DIAMETER_UM`). Override the
    /// neuron diameter with `with_neuron_diameter`.
    pub fn new(pixel_size_um: f32) -> Self {
        Self {
            pixel_size_um,
            neuron_diameter_um: DEFAULT_NEURON_DIAMETER_UM,
        }
    }

    pub fn with_neuron_diameter(mut self, um: f32) -> Self {
        self.neuron_diameter_um = um;
        self
    }
}

/// Per-stage tuning for the preprocess pipeline. Every field is
/// overridable; `PreprocessConfig::default()` reads each field's value
/// from its `DEFAULT_*` constant so defaults stay in one place.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreprocessConfig {
    /// Butterworth high-pass cutoff period, as a multiple of the neuron
    /// diameter in pixels. See `high_pass_cutoff_cycles_per_pixel` for
    /// the derivation.
    pub high_pass_diameters: f32,
    /// Butterworth filter order (number of poles).
    pub high_pass_order: u32,
    /// Enable the Butterworth high-pass stage. See the `DEFAULT_*`
    /// constant for the default rationale.
    pub high_pass_enabled: bool,
    /// Enable the row+column mean-subtraction ("band") stage.
    pub band_enabled: bool,
    /// Motion-correction search radius in pixels. The phase-correlation
    /// peak is searched only within `|dy|, |dx| ≤ this`.
    pub motion_max_shift_px: u32,
    /// Whether to run a second phase-correlation pass against the
    /// global anchor (cumulative mean of corrected frames) after the
    /// local-anchor pass.
    pub motion_use_global_anchor: bool,
    /// Gaussian σ (in pixels) of the optional low-pass applied to the
    /// frame before the row+column demean inside motion. 0 disables.
    pub motion_smooth_sigma_px: f32,
    /// Fraction of each axis the motion correlator sees (center crop).
    /// See `DEFAULT_MOTION_CORR_CROP_FRAC` for the rationale. 1.0
    /// disables cropping.
    pub motion_corr_crop_frac: f32,
    /// Square median kernel size applied after motion correction to
    /// suppress per-pixel shot noise. Must be odd. 1 disables.
    pub denoise_median_ksize: usize,
    /// Correlation method inside motion correction.
    pub motion_correlation: MotionCorrelation,
    /// Subpixel refinement method for the correlation peak.
    pub motion_subpixel: MotionSubpixel,
    /// Radius (in bins) of the centroid neighborhood. Ignored when
    /// `motion_subpixel` is `Parabolic`.
    pub motion_subpixel_radius: usize,
}

impl Default for PreprocessConfig {
    fn default() -> Self {
        Self {
            high_pass_diameters: DEFAULT_HIGH_PASS_DIAMETERS,
            high_pass_order: DEFAULT_HIGH_PASS_ORDER,
            high_pass_enabled: DEFAULT_HIGH_PASS_ENABLED,
            band_enabled: DEFAULT_BAND_ENABLED,
            motion_max_shift_px: DEFAULT_MOTION_MAX_SHIFT_PX,
            motion_use_global_anchor: DEFAULT_MOTION_USE_GLOBAL_ANCHOR,
            motion_smooth_sigma_px: DEFAULT_MOTION_SMOOTH_SIGMA_PX,
            motion_corr_crop_frac: DEFAULT_MOTION_CORR_CROP_FRAC,
            denoise_median_ksize: DEFAULT_DENOISE_MEDIAN_KSIZE,
            motion_correlation: DEFAULT_MOTION_CORRELATION,
            motion_subpixel: DEFAULT_MOTION_SUBPIXEL,
            motion_subpixel_radius: DEFAULT_MOTION_SUBPIXEL_RADIUS,
        }
    }
}

impl PreprocessConfig {
    pub fn with_high_pass_diameters(mut self, k: f32) -> Self {
        self.high_pass_diameters = k;
        self
    }

    pub fn with_high_pass_order(mut self, order: u32) -> Self {
        self.high_pass_order = order;
        self
    }

    pub fn with_high_pass_enabled(mut self, enabled: bool) -> Self {
        self.high_pass_enabled = enabled;
        self
    }

    pub fn with_band_enabled(mut self, enabled: bool) -> Self {
        self.band_enabled = enabled;
        self
    }

    pub fn with_motion_max_shift_px(mut self, px: u32) -> Self {
        self.motion_max_shift_px = px;
        self
    }

    pub fn with_motion_use_global_anchor(mut self, enabled: bool) -> Self {
        self.motion_use_global_anchor = enabled;
        self
    }

    pub fn with_motion_smooth_sigma_px(mut self, sigma: f32) -> Self {
        self.motion_smooth_sigma_px = sigma;
        self
    }

    pub fn with_motion_corr_crop_frac(mut self, frac: f32) -> Self {
        assert!(
            frac > 0.0 && frac <= 1.0,
            "motion_corr_crop_frac must be in (0, 1] (got {frac})"
        );
        self.motion_corr_crop_frac = frac;
        self
    }

    pub fn with_denoise_median_ksize(mut self, ksize: usize) -> Self {
        assert!(
            ksize >= 1 && ksize % 2 == 1,
            "ksize must be odd (got {ksize})"
        );
        self.denoise_median_ksize = ksize;
        self
    }

    pub fn with_motion_subpixel(mut self, mode: MotionSubpixel) -> Self {
        self.motion_subpixel = mode;
        self
    }

    pub fn with_motion_subpixel_radius(mut self, r: usize) -> Self {
        assert!(r >= 1, "motion_subpixel_radius must be ≥ 1 (got {r})");
        self.motion_subpixel_radius = r;
        self
    }
}
