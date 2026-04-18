//! 2D image views with row-major storage.
//!
//! `Frame` / `FrameMut` are zero-cost borrowed views over a flat `f32`
//! slice plus a shape. Storage is owned elsewhere (`Vec<f32>`, a ring
//! buffer, a SharedArrayBuffer); these views are what preprocess nodes
//! accept and produce.

use super::Axis;

/// Reported when a slice length does not match the requested `height * width`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShapeError {
    pub expected: usize,
    pub actual: usize,
}

/// Immutable 2D view over a row-major `f32` slice.
///
/// Layout: pixel at `(y, x)` lives at index `y * width + x`.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
    pixels: &'a [f32],
    height: usize,
    width: usize,
}

impl<'a> Frame<'a> {
    pub fn new(pixels: &'a [f32], height: usize, width: usize) -> Result<Self, ShapeError> {
        check_shape(pixels.len(), height, width)?;
        Ok(Self {
            pixels,
            height,
            width,
        })
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn pixels(&self) -> &'a [f32] {
        self.pixels
    }

    /// Axis tags in storage order. For `Frame` this is always
    /// `[Height, Width]` (row-major, y then x).
    pub fn axes(&self) -> [Axis; 2] {
        [Axis::Height, Axis::Width]
    }

    pub fn get(&self, y: usize, x: usize) -> f32 {
        self.pixels[y * self.width + x]
    }

    pub fn row(&self, y: usize) -> &'a [f32] {
        let start = y * self.width;
        &self.pixels[start..start + self.width]
    }
}

/// Mutable 2D view over a row-major `f32` slice.
#[derive(Debug)]
pub struct FrameMut<'a> {
    pixels: &'a mut [f32],
    height: usize,
    width: usize,
}

impl<'a> FrameMut<'a> {
    pub fn new(pixels: &'a mut [f32], height: usize, width: usize) -> Result<Self, ShapeError> {
        check_shape(pixels.len(), height, width)?;
        Ok(Self {
            pixels,
            height,
            width,
        })
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn pixels(&self) -> &[f32] {
        self.pixels
    }

    pub fn pixels_mut(&mut self) -> &mut [f32] {
        self.pixels
    }

    pub fn axes(&self) -> [Axis; 2] {
        [Axis::Height, Axis::Width]
    }

    pub fn get_mut(&mut self, y: usize, x: usize) -> &mut f32 {
        &mut self.pixels[y * self.width + x]
    }

    pub fn row_mut(&mut self, y: usize) -> &mut [f32] {
        let start = y * self.width;
        &mut self.pixels[start..start + self.width]
    }
}

fn check_shape(len: usize, height: usize, width: usize) -> Result<(), ShapeError> {
    if height == 0 || width == 0 {
        return Err(ShapeError {
            expected: height.saturating_mul(width).max(1),
            actual: len,
        });
    }
    let expected = height * width;
    if len == expected {
        Ok(())
    } else {
        Err(ShapeError {
            expected,
            actual: len,
        })
    }
}
