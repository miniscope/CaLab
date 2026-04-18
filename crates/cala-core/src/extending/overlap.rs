//! Spatial-support overlap detection between candidate and existing
//! components (thesis Algorithm 10, Phase 3 Task 6).
//!
//! Supports in this crate are `Vec<u32>` pixel-index lists, sorted
//! strictly ascending (same convention as `assets::Footprints`). The
//! candidate comes out of the extend loop on a patch, so we first
//! map it to full-frame indices, then intersect via two-pointer
//! merge.

use std::cmp::Ordering;
use std::ops::Range;

/// Convert a patch-relative spatial factor to a full-frame sorted
/// support list. Pixels with `a[pi] > rel_threshold × max(a)` are
/// retained. An all-zero `a` yields an empty list.
///
/// Output pixel indices are `u32`, sorted strictly ascending — the
/// row-major patch traversal already produces that order provided
/// the patch sits inside the frame (enforced by the `y_range` /
/// `x_range` from `patch_bounds`).
pub fn patch_to_frame_support(
    a: &[f32],
    patch_h: usize,
    patch_w: usize,
    y_range: Range<usize>,
    x_range: Range<usize>,
    frame_width: usize,
    rel_threshold: f32,
) -> Vec<u32> {
    assert_eq!(
        a.len(),
        patch_h * patch_w,
        "a length {} must equal patch_h * patch_w = {}",
        a.len(),
        patch_h * patch_w
    );
    assert_eq!(
        y_range.end - y_range.start,
        patch_h,
        "y_range span must equal patch_h"
    );
    assert_eq!(
        x_range.end - x_range.start,
        patch_w,
        "x_range span must equal patch_w"
    );
    assert!(x_range.end <= frame_width, "x_range exceeds frame width");
    assert!(
        (0.0..1.0).contains(&rel_threshold),
        "rel_threshold must be in [0, 1) (got {rel_threshold})"
    );

    let max = a.iter().cloned().fold(0.0f32, f32::max);
    if max <= 0.0 {
        return Vec::new();
    }
    let cutoff = rel_threshold * max;
    let mut out = Vec::new();
    for py in 0..patch_h {
        let y = y_range.start + py;
        let row_base = y * frame_width;
        for px in 0..patch_w {
            if a[py * patch_w + px] > cutoff {
                out.push((row_base + x_range.start + px) as u32);
            }
        }
    }
    out
}

/// Count pixels present in both sorted-ascending support lists.
pub fn overlap_count(a: &[u32], b: &[u32]) -> u32 {
    let (mut i, mut j) = (0usize, 0usize);
    let mut count = 0u32;
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            Ordering::Less => i += 1,
            Ordering::Greater => j += 1,
            Ordering::Equal => {
                count += 1;
                i += 1;
                j += 1;
            }
        }
    }
    count
}

/// Normalized overlap: `|a ∩ b| / min(|a|, |b|)`. 0 if either list
/// is empty. ∈ [0, 1].
pub fn overlap_fraction(a: &[u32], b: &[u32]) -> f32 {
    let denom = a.len().min(b.len());
    if denom == 0 {
        return 0.0;
    }
    overlap_count(a, b) as f32 / denom as f32
}
