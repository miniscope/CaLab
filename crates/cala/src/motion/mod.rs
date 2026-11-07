//! Streaming motion correction for Miniscope video (work in progress).
//!
//! This commit adds the numerical building blocks: real 2-D FFTs
//! ([`fft2d`]), registration prefilters ([`filter`]), windowed FFT
//! cross-correlation with sub-pixel refinement ([`xcorr`]) and one-pass
//! resampling by a rigid shift plus a smooth field ([`warp`]).

pub mod fft2d;
pub mod filter;
pub mod warp;
pub mod xcorr;

use std::fmt;

pub use fft2d::Fft2d;
pub use warp::{Interpolation, Warper};
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
