//! Streaming motion correction: rigid registration plus piecewise-rigid
//! (non-rigid) refinement, one frame at a time.
//!
//! # Method
//!
//! 1. **Registration image.** Each frame's registration region (the largest
//!    square in the lit field of view, at most 384 px, [`Roi`]) plus a margin
//!    is median-filtered (3x3, to knock out hot pixels and shot-noise
//!    outliers) and band-passed with a difference of Gaussians (`sigma` about
//!    1.5 and 15 px). The low cut removes vignetting, neuropil haze and global
//!    brightness changes (including the rare single-frame flashes); the high
//!    cut removes pixel noise. What remains is the cell and vessel texture
//!    that moves with the tissue. Filtering the margin too means a crop taken
//!    at a shifted position sees the same filter response as the template,
//!    not an artificial region edge.
//! 2. **Rigid shift.** A region-sized crop of the band-passed image, cut at
//!    the previous frame's (integer) shift, is Tukey-windowed and
//!    cross-correlated with the template through the FFT ([`fft2d`],
//!    [`xcorr`]). The correlation is divided by the window-overlap envelope,
//!    and when the peak lies more than 0.75 px from the cut the crop is cut
//!    again at the new integer estimate and re-registered. Both steps remove
//!    the pull of the fixed window towards zero shift, which on a smooth
//!    texture is a sizeable fraction of the shift (0.7 px of 4.6 px on a
//!    108 px region before; under 0.015 px after). The peak is refined to a
//!    fraction of a pixel with an upsampled DFT (Guizar-Sicairos 2008).
//!    *Phase* correlation (whitening the cross-power spectrum) is
//!    deliberately not used: on Miniscope data it lets noise-only frequencies
//!    dominate and returns (0, 0) even for a known 3 px shift; plain
//!    cross-correlation of band-passed frames is unbiased.
//! 3. **Template.** A warm-up template is the mean of the first frames,
//!    iteratively re-registered and re-averaged
//!    ([`MotionCorrector::initialize`]). It then follows slow changes
//!    (bleaching, drift of the background) as an exponentially weighted mean
//!    of rigidly corrected registration images, whose *position* is pinned
//!    to the warm-up template (at every refresh the running template is
//!    registered onto it and the offset added to every shift; without this,
//!    slowly varying registration bias integrates into a drift of ~0.5 px
//!    over 20 minutes). Frames whose brightness or peak quality is anomalous
//!    against robust running statistics (flashes, blank or corrupt frames)
//!    are corrected but never folded into the template.
//! 4. **Piecewise-rigid refinement** (optional, [`NonRigidConfig`]). The
//!    registration region is tiled with a grid of half-overlapping patches.
//!    Each is registered against the matching template patch starting from
//!    the rigid shift; the residuals are screened (low peak quality,
//!    disagreement with the neighbours), smoothed over time, shrunk towards
//!    zero by their estimated signal fraction (so noisy patches cannot do
//!    worse than rigid), and interpolated with a natural cubic spline over
//!    the patch centres into a smooth displacement field.
//! 5. **Warp.** Rigid shift and field are applied in one bicubic resampling
//!    pass with replicated borders ([`warp`]), with an optional validity mask.
//!
//! Every frame yields a [`MotionRecord`] (rigid shift, peak quality, flags
//! and the small grid of residual patch shifts). The record fully determines
//! the correction, so [`MotionCorrector::apply`] (or a [`Warper`] built from
//! the [`MotionGeometry`]) replays any frame exactly, without re-estimating.
//!
//! # Sign convention
//!
//! A shift `(dy, dx)` is the one that registers the frame onto the template:
//! `corrected(p) = frame(p - s(p))`, as `scipy.ndimage.shift` does. The image
//! *content* moved by `-s`; minisim's ground-truth `shifts` are content
//! motion, so they compare to the negated record (`correction=True` in
//! `minisim.metrics.shift_rmse`).

pub mod corrector;
pub mod fft2d;
pub mod filter;
pub mod warp;
pub mod xcorr;

#[cfg(feature = "jsbindings")]
mod js;

use std::fmt;

pub use corrector::{
    Frame, Frames, MotionConfig, MotionCorrector, MotionGeometry, MotionRecord, NonRigidConfig,
    PrefilterParams, Roi, TemplateStrategy, FLAG_ANOMALOUS, FLAG_BOOTSTRAP, FLAG_HELD,
    FLAG_TEMPLATE_UPDATED,
};
pub use fft2d::Fft2d;
pub use warp::{Interpolation, SourceMask, Warper};
pub use xcorr::{Correlator, Peak};

/// Error returned by every fallible motion-correction entry point.
#[derive(Debug, Clone, PartialEq)]
pub enum MotionError {
    /// A configuration value is out of range or inconsistent with the frame.
    InvalidConfig(String),
    /// A buffer has the wrong length for the frame geometry.
    SizeMismatch(String),
    /// The frame contains NaN or infinite values.
    NonFinite(String),
    /// A motion record is malformed (wrong length, non-finite values).
    InvalidRecord(String),
    /// The call needs a template, set up by `initialize` or the first frame.
    NotInitialized,
    /// An internal FFT call failed (should not happen with valid sizes).
    Internal(String),
}

impl fmt::Display for MotionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MotionError::InvalidConfig(m) => write!(f, "invalid motion config: {m}"),
            MotionError::SizeMismatch(m) => write!(f, "size mismatch: {m}"),
            MotionError::NonFinite(m) => write!(f, "non-finite input: {m}"),
            MotionError::InvalidRecord(m) => write!(f, "invalid motion record: {m}"),
            MotionError::NotInitialized => write!(f, "motion corrector has no template yet"),
            MotionError::Internal(m) => write!(f, "internal error: {m}"),
        }
    }
}

impl std::error::Error for MotionError {}
