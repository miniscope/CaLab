//! Per-frame preprocessing stages (design §3 "Preprocess").
//!
//! Each stage is a pure function: immutable `Frame` in, `FrameMut` out.
//! The caller owns the input / output buffers and ping-pongs them between
//! stages. Preprocess holds no global mutable state; per-stream state
//! (motion anchors, baseline min-image) is explicit and passed in.

mod band;
mod baseline;
mod butterworth;
mod hot_pixel;

pub use band::band_subtract;
pub use baseline::BaselineState;
pub use butterworth::{butterworth_highpass, high_pass_cutoff_cycles_per_pixel};
pub use hot_pixel::hot_pixel_median_3x3;
