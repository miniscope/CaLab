//! Generalized square median filter, supporting odd kernel sizes.
//!
//! The 3×3 hot-pixel filter (`hot_pixel_median_3x3`) is kept as a
//! stack-allocated specialization for speed; this module provides the
//! variable-kernel version used for post-motion denoising (default 7×7
//! per Chang's cala reference).
//!
//! Replicate boundary: out-of-range coordinates clamp to the nearest
//! valid pixel, matching the rest of the pipeline's edge handling.
//!
//! Performance: the per-pixel patch lives on the stack (capped at
//! `MAX_KSIZE²` elements) and we use `select_nth_unstable_by` to find
//! the median in linear average time without a full sort. No heap
//! allocations in the hot loop.

use crate::assets::{Frame, FrameMut, ShapeError};

/// Upper bound on the supported square kernel size. 15 gives a 225-
/// element stack buffer (<1 KB of f32) — enough for every realistic
/// denoise kernel. Raising this costs stack per call; lower is fine if
/// you never intend to run a bigger filter.
pub const MAX_KSIZE: usize = 15;

/// Apply a `ksize × ksize` median filter from `input` into `output`.
///
/// `ksize` must be odd and in `1..=MAX_KSIZE`. `ksize == 1` is the
/// identity (passes through unchanged). Uses a stack-allocated patch
/// buffer + quickselect; zero heap allocations in the hot loop.
pub fn median_filter(
    input: Frame<'_>,
    output: &mut FrameMut<'_>,
    ksize: usize,
) -> Result<(), ShapeError> {
    let h = input.height();
    let w = input.width();
    let n = h * w;
    if output.height() != h || output.width() != w {
        return Err(ShapeError {
            expected: n,
            actual: output.pixels().len(),
        });
    }
    assert!(
        ksize >= 1 && ksize % 2 == 1,
        "ksize must be odd (got {ksize})"
    );
    assert!(
        ksize <= MAX_KSIZE,
        "ksize = {ksize} exceeds MAX_KSIZE = {MAX_KSIZE}; raise the const or pick a smaller kernel"
    );

    if ksize == 1 {
        output.pixels_mut().copy_from_slice(input.pixels());
        return Ok(());
    }

    let radius = (ksize / 2) as isize;
    let kcount = ksize * ksize;
    let median_idx = kcount / 2;
    let mut patch = [0.0_f32; MAX_KSIZE * MAX_KSIZE];

    let h_isize = h as isize;
    let w_isize = w as isize;

    for y in 0..h {
        for x in 0..w {
            let mut slot = 0;
            for dy in -radius..=radius {
                let sy = (y as isize + dy).clamp(0, h_isize - 1) as usize;
                let row = &input.pixels()[sy * w..(sy + 1) * w];
                for dx in -radius..=radius {
                    let sx = (x as isize + dx).clamp(0, w_isize - 1) as usize;
                    patch[slot] = row[sx];
                    slot += 1;
                }
            }
            // Quickselect: puts the median element at `median_idx` in
            // linear average time without a full sort. `total_cmp` keeps
            // behavior deterministic if NaN slips into the data.
            let window = &mut patch[..kcount];
            let (_, median, _) = window.select_nth_unstable_by(median_idx, |a, b| a.total_cmp(b));
            *output.get_mut(y, x) = *median;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ksize_1_is_identity() {
        let input = vec![1.0_f32, 2.0, 3.0, 4.0];
        let mut output = vec![0.0_f32; 4];
        median_filter(
            Frame::new(&input, 2, 2).unwrap(),
            &mut FrameMut::new(&mut output, 2, 2).unwrap(),
            1,
        )
        .unwrap();
        assert_eq!(output, input);
    }

    #[test]
    fn ksize_3_matches_hot_pixel_3x3_on_uniform() {
        let (h, w) = (5, 5);
        let input = vec![7.0_f32; h * w];
        let mut output = vec![0.0_f32; h * w];
        median_filter(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            3,
        )
        .unwrap();
        for &v in &output {
            assert_eq!(v, 7.0);
        }
    }

    #[test]
    fn ksize_7_kills_isolated_spike() {
        // A single outlier pixel surrounded by 0s should be erased
        // by the 7×7 median — it's 1 value vs 48 zeros.
        let (h, w) = (9, 9);
        let mut input = vec![0.0_f32; h * w];
        input[4 * w + 4] = 255.0;
        let mut output = vec![0.0_f32; h * w];
        median_filter(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            7,
        )
        .unwrap();
        assert_eq!(output[4 * w + 4], 0.0);
    }

    #[test]
    fn ksize_7_preserves_majority_bright_region() {
        // A 5×5 bright block larger than the kernel radius should
        // survive at the interior — median of a window fully inside
        // the block is still bright.
        let (h, w) = (11, 11);
        let mut input = vec![0.0_f32; h * w];
        for y in 3..=7 {
            for x in 3..=7 {
                input[y * w + x] = 100.0;
            }
        }
        let mut output = vec![0.0_f32; h * w];
        median_filter(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            3,
        )
        .unwrap();
        // Interior pixel: all 9 neighbors bright → median 100.
        assert_eq!(output[5 * w + 5], 100.0);
    }

    #[test]
    fn panics_on_even_ksize() {
        let input = vec![0.0_f32; 9];
        let mut output = vec![0.0_f32; 9];
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            median_filter(
                Frame::new(&input, 3, 3).unwrap(),
                &mut FrameMut::new(&mut output, 3, 3).unwrap(),
                4,
            )
        }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_shape_mismatch() {
        let input = vec![0.0_f32; 9];
        let mut output = vec![0.0_f32; 6];
        let r = median_filter(
            Frame::new(&input, 3, 3).unwrap(),
            &mut FrameMut::new(&mut output, 2, 3).unwrap(),
            3,
        );
        assert!(r.is_err());
    }
}
