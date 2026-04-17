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
/// content pass untouched.
pub const DEFAULT_HIGH_PASS_DIAMETERS: f32 = 3.0;

/// Default Butterworth filter order. Higher = sharper rolloff; 4 is a
/// common compromise between sharpness and avoiding ringing artifacts.
pub const DEFAULT_HIGH_PASS_ORDER: u32 = 4;

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
    /// Motion-correction search radius in pixels. The phase-correlation
    /// peak is searched only within `|dy|, |dx| ≤ this`.
    pub motion_max_shift_px: u32,
    /// Whether to run a second phase-correlation pass against the
    /// global anchor (cumulative mean of corrected frames) after the
    /// local-anchor pass.
    pub motion_use_global_anchor: bool,
}

impl Default for PreprocessConfig {
    fn default() -> Self {
        Self {
            high_pass_diameters: DEFAULT_HIGH_PASS_DIAMETERS,
            high_pass_order: DEFAULT_HIGH_PASS_ORDER,
            motion_max_shift_px: DEFAULT_MOTION_MAX_SHIFT_PX,
            motion_use_global_anchor: DEFAULT_MOTION_USE_GLOBAL_ANCHOR,
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

    pub fn with_motion_max_shift_px(mut self, px: u32) -> Self {
        self.motion_max_shift_px = px;
        self
    }

    pub fn with_motion_use_global_anchor(mut self, enabled: bool) -> Self {
        self.motion_use_global_anchor = enabled;
        self
    }
}
