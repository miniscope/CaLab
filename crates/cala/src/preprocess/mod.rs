//! Non-motion preprocessing of raw 1-photon Miniscope frames.
//!
//! The stages, in pipeline order, each in its own module:
//!
//! | stage | module | per-frame state | what it removes |
//! |---|---|---|---|
//! | warm-up statistics | [`warmup`] | accumulates, then frozen | (estimates the two maps below) |
//! | FOV mask | [`fov`] | frozen | the unlit sensor outside the lens |
//! | hot / stuck pixels | [`hot_pixels`] | frozen | sensor defects that do not move with tissue |
//! | glow flattening | [`flatten`] | stateless | broad illumination, vignette, leakage |
//! | line artifacts | [`lines`] | stateless | per-frame row / column offsets (default on) |
//! | *motion correction* | external, [`FrameRegistrar`] | the registrar's | brain motion |
//! | noise map | [`noise`] | running, snapshot-able | (estimates per-pixel noise σ of the registered frame) |
//! | background | [`background`] | running, snapshot-able | the static per-pixel floor in tissue coordinates |
//!
//! [`Preprocessor`] chains them. The order follows where each artifact lives:
//! hot pixels, the glow and line offsets are fixed to the *sensor*, so they are
//! removed before registration (a hot pixel registered with the tissue would
//! smear into a streak); the background floor and the noise belong to the
//! *tissue* pixel, so they are estimated after registration.
//!
//! # Replayable by construction
//!
//! The pipeline has a fast loop and a slow loop and re-extracts traces later
//! (pass 2 re-reads past frames). So every stage is either stateless given its
//! frozen calibration ([`Calibration`]: the FOV mask, the hot-pixel map and the
//! flattening normaliser), or driven by explicit state that can be captured
//! and restored ([`background::BackgroundState`], [`noise::NoiseState`]). Any
//! past frame is reprocessed bit-for-bit by restoring the state recorded at or
//! before it and stepping forward (see [`Preprocessor::state`] and
//! [`PreprocessState`]); pass 2 normally uses the final background instead
//! ([`background::RunningMinBackground::final_estimate`]).
//!
//! # Cost
//!
//! Everything is O(pixels) per frame, independent of the filter sizes: the
//! large Gaussian is a recursive (IIR) filter ([`gaussian`]), not an FFT (the
//! motion stage owns the 2-D FFT). Native release throughput on 600x600 is
//! measured by `examples/preprocess_eval.rs`.
//!
//! Nothing on a public path panics: bad sizes and configs return
//! [`PreprocessError`], because a panic traps the WASM module.

pub mod background;
mod codec;
pub mod flatten;
pub mod fov;
pub mod gaussian;
pub mod hot_pixels;
pub mod lines;
pub mod noise;
mod pipeline;
mod stats;
pub mod warmup;

#[cfg(feature = "jsbindings")]
mod js;

pub use pipeline::{
    Calibration, FrameRegistrar, NoRegistration, PreprocessConfig, PreprocessRecord,
    PreprocessState, Preprocessor,
};

use std::fmt;

/// Largest frame accepted (pixels), so a corrupt size cannot make the caller
/// allocate gigabytes: 4096 x 4096.
pub const MAX_PIXELS: usize = 1 << 24;

/// Error returned by every fallible preprocessing entry point.
#[derive(Debug, Clone, PartialEq)]
pub enum PreprocessError {
    /// Zero or oversized frame dimensions.
    InvalidDims { width: usize, height: usize },
    /// A buffer does not hold the expected number of elements.
    LengthMismatch {
        what: &'static str,
        expected: usize,
        got: usize,
    },
    /// A configuration value is out of range.
    InvalidConfig(String),
    /// A stage was used before it had the data it needs (e.g. no warm-up frames).
    NotReady(String),
    /// Serialized state could not be decoded.
    InvalidState(String),
    /// The external registration step failed.
    Registration(String),
}

impl fmt::Display for PreprocessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PreprocessError::InvalidDims { width, height } => {
                write!(f, "invalid frame size {width}x{height}")
            }
            PreprocessError::LengthMismatch {
                what,
                expected,
                got,
            } => write!(f, "{what}: expected {expected} elements, got {got}"),
            PreprocessError::InvalidConfig(m) => write!(f, "invalid config: {m}"),
            PreprocessError::NotReady(m) => write!(f, "not ready: {m}"),
            PreprocessError::InvalidState(m) => write!(f, "invalid state: {m}"),
            PreprocessError::Registration(m) => write!(f, "registration failed: {m}"),
        }
    }
}

impl std::error::Error for PreprocessError {}

/// Frame geometry, validated once so the stages can index without checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dims {
    pub width: usize,
    pub height: usize,
}

impl Dims {
    /// Both sides non-zero and the area at most [`MAX_PIXELS`].
    pub fn new(width: usize, height: usize) -> Result<Dims, PreprocessError> {
        match width.checked_mul(height) {
            Some(n) if width > 0 && height > 0 && n <= MAX_PIXELS => Ok(Dims { width, height }),
            _ => Err(PreprocessError::InvalidDims { width, height }),
        }
    }

    pub fn pixels(self) -> usize {
        self.width * self.height
    }

    /// `Err` unless `len` equals the pixel count.
    pub(crate) fn check(self, what: &'static str, len: usize) -> Result<(), PreprocessError> {
        if len == self.pixels() {
            Ok(())
        } else {
            Err(PreprocessError::LengthMismatch {
                what,
                expected: self.pixels(),
                got: len,
            })
        }
    }
}

/// A raw sensor sample: 8- or 16-bit grey, converted to `f32` on entry.
pub trait RawPixel: Copy {
    fn to_f32(self) -> f32;
}

impl RawPixel for u8 {
    #[inline]
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
}

impl RawPixel for u16 {
    #[inline]
    fn to_f32(self) -> f32 {
        f32::from(self)
    }
}

impl RawPixel for f32 {
    #[inline]
    fn to_f32(self) -> f32 {
        self
    }
}
