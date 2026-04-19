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
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
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
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
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
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
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
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct RecordingMetadata {
    /// Physical size of one image pixel in micrometers.
    pub pixel_size_um: f32,
    /// Typical neuron cell-body diameter in micrometers. Used for
    /// downstream cutoff derivations.
    #[cfg_attr(feature = "serde", serde(default = "default_neuron_diameter_um"))]
    pub neuron_diameter_um: f32,
}

#[cfg(feature = "serde")]
fn default_neuron_diameter_um() -> f32 {
    DEFAULT_NEURON_DIAMETER_UM
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
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
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

// ── Fit loop (Phase 2, OMF) ────────────────────────────────────────────

/// Relative convergence tolerance for `EvaluateTraces` (thesis Algorithm 7).
/// Inner loop exits when `‖c − c_step‖ < ε · ‖c_step‖`. 1e-3 is tight
/// enough that downstream suff-stats see well-converged traces without
/// blowing the per-frame iteration budget on asymptotic refinement.
pub const DEFAULT_TRACE_TOL: f32 = 1e-3;

/// Hard cap on `EvaluateTraces` iterations. Bounds per-frame latency
/// when BCD fails to converge (pathological overfit on an unmodeled
/// frame — see thesis §3.2.3 "bounded latency" discussion).
pub const DEFAULT_TRACE_MAX_ITER: u32 = 20;

/// Number of outer iterations of `EvaluateFootprints` per frame
/// (thesis Algorithm 8 `miter`). Footprint updates accumulate over
/// many frames via W/M, so a small per-frame iter count is fine.
pub const DEFAULT_FOOTPRINT_MAX_ITER: u32 = 5;

/// SNR threshold `c₀` for the Heaviside gate in `EvaluateSuffStats`
/// (thesis Eq. 3.25, `f(c) = c · H(c − c₀)`). Samples with `c_i ≤ c₀`
/// contribute nothing to `W`, `M` on this frame. Prevents footprints
/// from drifting toward noise on long recordings when a cell is quiet.
/// Units are the same as trace amplitude (same as preprocessed pixel
/// intensity). Tune per recording.
pub const DEFAULT_SNR_C0: f32 = 0.0;

/// Per-frame tuning for the OMF fit loop.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct FitConfig {
    /// Relative tolerance for `EvaluateTraces` BCD convergence.
    pub trace_tol: f32,
    /// Maximum BCD iterations inside one call to `EvaluateTraces`.
    pub trace_max_iter: u32,
    /// Outer iterations of `EvaluateFootprints` per frame.
    pub footprint_max_iter: u32,
    /// Heaviside SNR threshold `c₀` for suff-stats gating.
    pub snr_c0: f32,
}

impl Default for FitConfig {
    fn default() -> Self {
        Self {
            trace_tol: DEFAULT_TRACE_TOL,
            trace_max_iter: DEFAULT_TRACE_MAX_ITER,
            footprint_max_iter: DEFAULT_FOOTPRINT_MAX_ITER,
            snr_c0: DEFAULT_SNR_C0,
        }
    }
}

impl FitConfig {
    pub fn with_trace_tol(mut self, tol: f32) -> Self {
        assert!(tol > 0.0, "trace_tol must be positive (got {tol})");
        self.trace_tol = tol;
        self
    }

    pub fn with_trace_max_iter(mut self, n: u32) -> Self {
        assert!(n >= 1, "trace_max_iter must be ≥ 1 (got {n})");
        self.trace_max_iter = n;
        self
    }

    pub fn with_footprint_max_iter(mut self, n: u32) -> Self {
        assert!(n >= 1, "footprint_max_iter must be ≥ 1 (got {n})");
        self.footprint_max_iter = n;
        self
    }

    pub fn with_snr_c0(mut self, c0: f32) -> Self {
        assert!(c0 >= 0.0, "snr_c0 must be non-negative (got {c0})");
        self.snr_c0 = c0;
        self
    }
}

// ── Extend loop (Phase 3) ──────────────────────────────────────────────

/// Class tag carried on every component in `Ã`. Phase 3 extend proposes
/// a class per candidate based on shape + temporal dynamics priors
/// (design §3.1). Phase 2 footprints are implicitly `Cell` — the class
/// field was added in Phase 3 without disturbing existing callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum ComponentClass {
    /// Localized, compact, cell-scale footprint with fast transients.
    Cell,
    /// Large-support, near-DC temporal trace: illumination, vignetting,
    /// slow focus drift.
    SlowBaseline,
    /// Diffuse, larger-than-cell, moderately slow — correlated
    /// background tied to groups of nearby cells.
    Neuropil,
}

/// Default class assigned to components registered without an explicit
/// tag (e.g. Phase 2 `Footprints::push_component` keeps working).
pub const DEFAULT_COMPONENT_CLASS: ComponentClass = ComponentClass::Cell;

/// Number of recent residual frames the extend loop has access to when
/// searching for new components. Two seconds at 30 fps is long enough
/// for pixel-variance to stabilize over a few spikes but short enough
/// that a new cell's first transients still dominate the window.
pub const DEFAULT_EXTEND_WINDOW_FRAMES: u32 = 60;

/// Patch radius around the max-variance pixel, expressed as a multiple
/// of the recording's neuron diameter. 1.5 × neuron diameter captures
/// the cell plus a ring of context for the rank-1 NMF to pull a clean
/// spatial footprint without edge truncation.
pub const DEFAULT_PATCH_RADIUS_DIAMETERS: f32 = 1.5;

/// Floor on the window's max per-pixel residual variance for extend to
/// run at all. If the residual is effectively noise, proposing
/// components just adds spurious estimators. Units are squared
/// preprocessed-pixel intensity; tune per recording if noise floor
/// differs substantially from the minian-demo baseline.
pub const DEFAULT_PATCH_MIN_VARIANCE: f32 = 1e-4;

/// Maximum multiplicative-update iterations for rank-1 NMF on the
/// candidate patch. Chang's reference converges in ~20–30; 50 gives
/// headroom for pathological patches without unbounded runtime.
pub const DEFAULT_NMF_MAX_ITER: u32 = 50;

/// Relative convergence tolerance for the rank-1 NMF inner loop:
/// stop when `‖Δa‖ + ‖Δc‖ < tol · (‖a‖ + ‖c‖)`. 1e-4 is tight enough
/// that downstream shape gates see a stable footprint.
pub const DEFAULT_NMF_TOL: f32 = 1e-4;

/// Relative reconstruction-error ceiling for a candidate patch: the
/// rank-1 fit's residual Frobenius norm divided by the patch Frobenius
/// norm. Above this the patch is likely multi-source (two close cells)
/// and the candidate is rejected — design §3 quality gate.
pub const DEFAULT_RECON_ERROR_MAX: f32 = 0.5;

/// Relative threshold on the unit-L2 spatial factor for deciding which
/// pixels are "in" the footprint's support (for area / perimeter /
/// compactness). Pixels below `this × max(a)` are dropped. 10% of
/// max is a standard CNMF convention that keeps the support
/// compact without losing the bright core.
pub const DEFAULT_FOOTPRINT_SUPPORT_THRESHOLD_REL: f32 = 0.1;

/// Minimum equivalent diameter (pixels, derived from footprint support
/// area) for the cell class, as a multiple of `neuron_diameter_um` in
/// pixels. 0.5 × = cells cannot be smaller than half the expected body
/// size — rejects fragment footprints and shot-noise spikes.
pub const DEFAULT_CELL_DIAMETER_MIN_D: f32 = 0.5;

/// Maximum equivalent diameter for the cell class, as a multiple of
/// `neuron_diameter_um` in pixels. 1.5 × keeps the upper bound loose
/// enough to admit elongated / lopsided real cells while still
/// separating them from neuropil-scale support.
pub const DEFAULT_CELL_DIAMETER_MAX_D: f32 = 1.5;

/// Lower diameter bound for the neuropil class (multiples of neuron
/// diameter). Above `cell_diameter_max_d` and below this, the
/// candidate is ambiguous and rejected. 2.0 × matches the lower end
/// of the 20–100 px neuropil scale at 10 px cell bodies.
pub const DEFAULT_NEUROPIL_DIAMETER_MIN_D: f32 = 2.0;

/// Upper diameter bound for the neuropil class. Above this, the
/// candidate is classified as slow baseline (near-DC, large support).
/// 10 × neuron diameter comfortably covers full-FOV vignetting on
/// typical miniscope recordings.
pub const DEFAULT_NEUROPIL_DIAMETER_MAX_D: f32 = 10.0;

/// Isoperimetric-quotient floor for the cell class: `4π · area /
/// perimeter²`. 1.0 is a perfect circle. 0.5 allows elongated but
/// still compact cells while rejecting filament-like or fragmented
/// supports. Only applied to cell-class candidates.
pub const DEFAULT_CELL_COMPACTNESS_MIN: f32 = 0.5;

/// Minimum normalized spatial-support overlap between a candidate and
/// an existing component for them to be considered an overlap pair:
/// `|supp_new ∩ supp_i| / min(|supp_new|, |supp_i|)`. Below this, the
/// pair is spatially disjoint and proceeds as a new-component
/// registration regardless of trace correlation.
pub const DEFAULT_OVERLAP_FRACTION_MIN: f32 = 0.3;

/// Trace-correlation threshold (Pearson r over the extend window) for
/// collapsing an overlapping candidate + existing pair into a merge
/// proposal. Below this, they are treated as distinct components that
/// happen to share pixels (cells touching but firing independently).
pub const DEFAULT_TRACE_CORR_MIN: f32 = 0.85;

/// Mutation queue capacity — bounded ring, drop-oldest policy (design
/// §7.3). 32 slots absorbs a busy extend cycle without stalling while
/// the drop counter makes saturation user-visible in the UI.
pub const DEFAULT_MUTATION_QUEUE_CAPACITY: usize = 32;

/// Cap on proposals emitted per extend cycle (design §13 dense-scene
/// risk mitigation). Limits extend's work-per-cycle so its latency
/// stays bounded even when many components are proposable at once.
pub const DEFAULT_PROPOSALS_PER_CYCLE_MAX: u32 = 4;

/// Tuning for the Phase 3 extend loop. Every knob reads from its
/// `DEFAULT_*` constant via `ExtendConfig::default()`; algorithm code
/// never reads the constants directly.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct ExtendConfig {
    /// Number of recent residual frames retained for extend search.
    pub extend_window_frames: u32,
    /// Patch radius as a multiple of `neuron_diameter_um` in pixels.
    pub patch_radius_diameters: f32,
    /// Minimum max-pixel variance threshold to trigger an extend cycle.
    pub patch_min_variance: f32,
    /// Rank-1 NMF iteration cap on a candidate patch.
    pub nmf_max_iter: u32,
    /// Rank-1 NMF relative convergence tolerance.
    pub nmf_tol: f32,
    /// Relative reconstruction-error ceiling for candidate acceptance.
    pub recon_error_max: f32,
    /// Relative threshold on `a` for morphological support extraction.
    pub footprint_support_threshold_rel: f32,
    /// Minimum cell-class equivalent diameter (multiples of neuron d).
    pub cell_diameter_min_d: f32,
    /// Maximum cell-class equivalent diameter (multiples of neuron d).
    pub cell_diameter_max_d: f32,
    /// Minimum neuropil-class equivalent diameter.
    pub neuropil_diameter_min_d: f32,
    /// Maximum neuropil-class equivalent diameter (above → slow baseline).
    pub neuropil_diameter_max_d: f32,
    /// Isoperimetric-quotient floor for cell-class candidates.
    pub cell_compactness_min: f32,
    /// Minimum normalized spatial overlap to consider a merge pair.
    pub overlap_fraction_min: f32,
    /// Trace-correlation threshold for merge vs distinct components.
    pub trace_corr_min: f32,
    /// Mutation queue capacity.
    pub mutation_queue_capacity: usize,
    /// Cap on proposals emitted per extend cycle.
    pub proposals_per_cycle_max: u32,
}

impl Default for ExtendConfig {
    fn default() -> Self {
        Self {
            extend_window_frames: DEFAULT_EXTEND_WINDOW_FRAMES,
            patch_radius_diameters: DEFAULT_PATCH_RADIUS_DIAMETERS,
            patch_min_variance: DEFAULT_PATCH_MIN_VARIANCE,
            nmf_max_iter: DEFAULT_NMF_MAX_ITER,
            nmf_tol: DEFAULT_NMF_TOL,
            recon_error_max: DEFAULT_RECON_ERROR_MAX,
            footprint_support_threshold_rel: DEFAULT_FOOTPRINT_SUPPORT_THRESHOLD_REL,
            cell_diameter_min_d: DEFAULT_CELL_DIAMETER_MIN_D,
            cell_diameter_max_d: DEFAULT_CELL_DIAMETER_MAX_D,
            neuropil_diameter_min_d: DEFAULT_NEUROPIL_DIAMETER_MIN_D,
            neuropil_diameter_max_d: DEFAULT_NEUROPIL_DIAMETER_MAX_D,
            cell_compactness_min: DEFAULT_CELL_COMPACTNESS_MIN,
            overlap_fraction_min: DEFAULT_OVERLAP_FRACTION_MIN,
            trace_corr_min: DEFAULT_TRACE_CORR_MIN,
            mutation_queue_capacity: DEFAULT_MUTATION_QUEUE_CAPACITY,
            proposals_per_cycle_max: DEFAULT_PROPOSALS_PER_CYCLE_MAX,
        }
    }
}

impl ExtendConfig {
    pub fn with_extend_window_frames(mut self, n: u32) -> Self {
        assert!(n >= 1, "extend_window_frames must be ≥ 1 (got {n})");
        self.extend_window_frames = n;
        self
    }

    pub fn with_patch_radius_diameters(mut self, d: f32) -> Self {
        assert!(d > 0.0, "patch_radius_diameters must be positive (got {d})");
        self.patch_radius_diameters = d;
        self
    }

    pub fn with_patch_min_variance(mut self, v: f32) -> Self {
        assert!(
            v >= 0.0,
            "patch_min_variance must be non-negative (got {v})"
        );
        self.patch_min_variance = v;
        self
    }

    pub fn with_nmf_max_iter(mut self, n: u32) -> Self {
        assert!(n >= 1, "nmf_max_iter must be ≥ 1 (got {n})");
        self.nmf_max_iter = n;
        self
    }

    pub fn with_nmf_tol(mut self, tol: f32) -> Self {
        assert!(tol > 0.0, "nmf_tol must be positive (got {tol})");
        self.nmf_tol = tol;
        self
    }

    pub fn with_recon_error_max(mut self, e: f32) -> Self {
        assert!(e > 0.0, "recon_error_max must be positive (got {e})");
        self.recon_error_max = e;
        self
    }

    pub fn with_footprint_support_threshold_rel(mut self, t: f32) -> Self {
        assert!(
            (0.0..1.0).contains(&t),
            "footprint_support_threshold_rel must be in [0, 1) (got {t})"
        );
        self.footprint_support_threshold_rel = t;
        self
    }

    pub fn with_cell_diameter_range(mut self, min_d: f32, max_d: f32) -> Self {
        assert!(
            min_d > 0.0 && max_d >= min_d,
            "cell diameter range must satisfy 0 < min ≤ max (got {min_d}..={max_d})"
        );
        self.cell_diameter_min_d = min_d;
        self.cell_diameter_max_d = max_d;
        self
    }

    pub fn with_neuropil_diameter_range(mut self, min_d: f32, max_d: f32) -> Self {
        assert!(
            min_d > 0.0 && max_d >= min_d,
            "neuropil diameter range must satisfy 0 < min ≤ max (got {min_d}..={max_d})"
        );
        self.neuropil_diameter_min_d = min_d;
        self.neuropil_diameter_max_d = max_d;
        self
    }

    pub fn with_cell_compactness_min(mut self, q: f32) -> Self {
        assert!(
            (0.0..=1.0).contains(&q),
            "cell_compactness_min must be in [0, 1] (got {q})"
        );
        self.cell_compactness_min = q;
        self
    }

    pub fn with_overlap_fraction_min(mut self, f: f32) -> Self {
        assert!(
            (0.0..=1.0).contains(&f),
            "overlap_fraction_min must be in [0, 1] (got {f})"
        );
        self.overlap_fraction_min = f;
        self
    }

    pub fn with_trace_corr_min(mut self, r: f32) -> Self {
        assert!(
            (-1.0..=1.0).contains(&r),
            "trace_corr_min must be in [-1, 1] (got {r})"
        );
        self.trace_corr_min = r;
        self
    }

    pub fn with_mutation_queue_capacity(mut self, n: usize) -> Self {
        assert!(n >= 1, "mutation_queue_capacity must be ≥ 1 (got {n})");
        self.mutation_queue_capacity = n;
        self
    }

    pub fn with_proposals_per_cycle_max(mut self, n: u32) -> Self {
        assert!(n >= 1, "proposals_per_cycle_max must be ≥ 1 (got {n})");
        self.proposals_per_cycle_max = n;
        self
    }
}
