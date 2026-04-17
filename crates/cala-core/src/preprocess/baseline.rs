//! Per-pixel running-minimum baseline subtraction.
//!
//! Streaming: each call updates a persistent `min_image` (elementwise
//! running min across all frames seen so far), then emits
//! `frame - min_image`. Initial state is `+infinity` per pixel, so the
//! first frame through always emits all zeros (baseline == current frame).

use crate::assets::{Frame, FrameMut, ShapeError};

/// State held across frames for the running-min baseline estimator.
pub struct BaselineState {
    min_image: Vec<f32>,
    height: usize,
    width: usize,
}

impl BaselineState {
    /// Allocate state for a `height × width` frame stream. All pixels
    /// start at +infinity so the very first frame sets the initial min.
    pub fn new(height: usize, width: usize) -> Self {
        Self {
            min_image: vec![f32::INFINITY; height * width],
            height,
            width,
        }
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    /// View of the current per-pixel running minimum. Returns an empty
    /// frame for zero-sized states.
    pub fn min_image(&self) -> Frame<'_> {
        Frame::new(&self.min_image, self.height, self.width)
            .expect("BaselineState invariant: min_image length == height * width")
    }

    /// Reset state — every pixel's min returns to +infinity.
    pub fn reset(&mut self) {
        for v in &mut self.min_image {
            *v = f32::INFINITY;
        }
    }

    /// Update `min_image` with `input`, then write `input - min_image`
    /// into `output`. Returns `Err` if shapes don't match the state's
    /// height × width.
    pub fn subtract_baseline(
        &mut self,
        input: Frame<'_>,
        output: &mut FrameMut<'_>,
    ) -> Result<(), ShapeError> {
        if input.height() != self.height || input.width() != self.width {
            return Err(ShapeError {
                expected: self.height * self.width,
                actual: input.pixels().len(),
            });
        }
        if output.height() != self.height || output.width() != self.width {
            return Err(ShapeError {
                expected: self.height * self.width,
                actual: output.pixels().len(),
            });
        }

        let pixels = input.pixels();
        let out = output.pixels_mut();
        for i in 0..self.min_image.len() {
            let v = pixels[i];
            if v < self.min_image[i] {
                self.min_image[i] = v;
            }
            out[i] = v - self.min_image[i];
        }
        Ok(())
    }
}
