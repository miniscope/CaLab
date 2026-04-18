//! Candidate proposal: max-variance patch → rank-1 NMF → quality gates
//! (thesis Algorithm 9).
//!
//! Task 3 lands the patch-selection stage: compute per-pixel residual
//! variance over the extend window, locate the argmax pixel, and
//! extract a radius-`r` time stack clipped to frame bounds for the
//! rank-1 NMF (Task 4) and quality gates (Task 5) to consume.

use std::ops::Range;

use crate::buffers::bipbuf::ResidualRingBuf;

/// Compute per-pixel residual variance over the full buffer window.
///
/// Returns a dense length-`frame_len` map. Formula is the population
/// variance `E[r²] − E[r]²`; a 60-frame default window at f32 keeps
/// accumulation error well below the signal scale on typical
/// miniscope residuals. An empty buffer yields an all-zero map.
pub fn variance_map(buf: &ResidualRingBuf) -> Vec<f32> {
    let frame_len = buf.frame_len();
    let t = buf.len();
    let mut map = vec![0.0f32; frame_len];
    if t == 0 {
        return map;
    }
    let inv_t = 1.0f32 / (t as f32);
    let window = buf.window();
    let mut sum = vec![0.0f32; frame_len];
    let mut sum_sq = vec![0.0f32; frame_len];
    for f in 0..t {
        let base = f * frame_len;
        for p in 0..frame_len {
            let v = window[base + p];
            sum[p] += v;
            sum_sq[p] += v * v;
        }
    }
    for p in 0..frame_len {
        let mean = sum[p] * inv_t;
        let mean_sq = sum_sq[p] * inv_t;
        // Clamp to zero — float subtraction can produce a tiny negative
        // when every residual at this pixel is essentially identical.
        map[p] = (mean_sq - mean * mean).max(0.0);
    }
    map
}

/// Argmax `(y, x, value)` of a row-major `height × width` map. Ties
/// are broken by lowest linear index. Returns `None` if the map is
/// empty or all non-finite.
pub fn argmax_yx(map: &[f32], height: usize, width: usize) -> Option<(usize, usize, f32)> {
    assert_eq!(
        map.len(),
        height * width,
        "map length {} must equal height * width = {}",
        map.len(),
        height * width
    );
    let mut best: Option<(usize, f32)> = None;
    for (i, &v) in map.iter().enumerate() {
        if !v.is_finite() {
            continue;
        }
        match best {
            None => best = Some((i, v)),
            Some((_, b)) if v > b => best = Some((i, v)),
            _ => {}
        }
    }
    best.map(|(i, v)| (i / width, i % width, v))
}

/// Inclusive-start / exclusive-end row and column ranges for a patch
/// of radius `radius` centered at `(center_y, center_x)`, clipped to
/// the frame bounds.
pub fn patch_bounds(
    center_y: usize,
    center_x: usize,
    radius: usize,
    height: usize,
    width: usize,
) -> (Range<usize>, Range<usize>) {
    assert!(center_y < height, "center_y {center_y} out of height {height}");
    assert!(center_x < width, "center_x {center_x} out of width {width}");
    let y0 = center_y.saturating_sub(radius);
    let y1 = (center_y + radius + 1).min(height);
    let x0 = center_x.saturating_sub(radius);
    let x1 = (center_x + radius + 1).min(width);
    (y0..y1, x0..x1)
}

/// Pack the residual ring window restricted to the given `y_range ×
/// x_range` patch into a row-major-per-frame time stack.
///
/// Output layout: `window_len` frames × `patch_h × patch_w` pixels,
/// in the order returned by `ResidualRingBuf::window` (oldest-first).
pub fn extract_patch_stack(
    buf: &ResidualRingBuf,
    height: usize,
    width: usize,
    y_range: Range<usize>,
    x_range: Range<usize>,
) -> Vec<f32> {
    assert_eq!(
        height * width,
        buf.frame_len(),
        "frame shape {}x{} must equal buffer frame_len {}",
        height,
        width,
        buf.frame_len()
    );
    assert!(y_range.end <= height, "y_range exceeds height");
    assert!(x_range.end <= width, "x_range exceeds width");
    let patch_h = y_range.end - y_range.start;
    let patch_w = x_range.end - x_range.start;
    let t = buf.len();
    let mut stack = Vec::with_capacity(t * patch_h * patch_w);
    let window = buf.window();
    for f in 0..t {
        let frame_base = f * buf.frame_len();
        for y in y_range.clone() {
            let row_base = frame_base + y * width;
            stack.extend_from_slice(&window[row_base + x_range.start..row_base + x_range.end]);
        }
    }
    stack
}

/// Output of [`select_max_variance_patch`].
#[derive(Debug)]
pub struct PatchSelection {
    /// Image-space `(y, x)` coordinates of the argmax pixel.
    pub center_yx: (usize, usize),
    /// Row range the patch occupies in the full frame.
    pub y_range: Range<usize>,
    /// Column range the patch occupies in the full frame.
    pub x_range: Range<usize>,
    /// Variance at the argmax pixel (the selection score).
    pub max_variance: f32,
    /// `window_len × patch_h × patch_w`, row-major per frame.
    pub time_stack: Vec<f32>,
    pub patch_h: usize,
    pub patch_w: usize,
    pub window_len: usize,
}

/// Locate the maximum-variance pixel over the residual window and
/// extract a radius-`radius` patch time stack around it (clipped to
/// frame bounds).
///
/// Returns `None` when the buffer is empty.
pub fn select_max_variance_patch(
    buf: &ResidualRingBuf,
    height: usize,
    width: usize,
    radius: usize,
) -> Option<PatchSelection> {
    if buf.is_empty() {
        return None;
    }
    assert_eq!(
        height * width,
        buf.frame_len(),
        "frame shape {}x{} must equal buffer frame_len {}",
        height,
        width,
        buf.frame_len()
    );
    let map = variance_map(buf);
    let (cy, cx, max_variance) = argmax_yx(&map, height, width)?;
    let (y_range, x_range) = patch_bounds(cy, cx, radius, height, width);
    let patch_h = y_range.end - y_range.start;
    let patch_w = x_range.end - x_range.start;
    let time_stack =
        extract_patch_stack(buf, height, width, y_range.clone(), x_range.clone());
    Some(PatchSelection {
        center_yx: (cy, cx),
        y_range,
        x_range,
        max_variance,
        time_stack,
        patch_h,
        patch_w,
        window_len: buf.len(),
    })
}
