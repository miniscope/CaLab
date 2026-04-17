//! Band (row + column) mean subtraction — the "double-centering"
//! identity: `x'[i,j] = x[i,j] - rowmean[i] - colmean[j] + globalmean`.
//!
//! Removes sensor-level row and column stripe artifacts (common on
//! CMOS sensors) in a single pass. The operation is parameter-free.

use crate::assets::{Frame, FrameMut, ShapeError};

pub fn band_subtract(input: Frame<'_>, output: &mut FrameMut<'_>) -> Result<(), ShapeError> {
    let h = input.height();
    let w = input.width();
    if h != output.height() || w != output.width() {
        return Err(ShapeError {
            expected: h * w,
            actual: output.pixels().len(),
        });
    }

    let inv_w = 1.0 / w as f32;
    let inv_h = 1.0 / h as f32;

    let mut row_means = vec![0.0_f32; h];
    for (y, rm) in row_means.iter_mut().enumerate() {
        *rm = input.row(y).iter().sum::<f32>() * inv_w;
    }

    let mut col_means = vec![0.0_f32; w];
    for y in 0..h {
        let row = input.row(y);
        for (x, cm) in col_means.iter_mut().enumerate() {
            *cm += row[x];
        }
    }
    for cm in col_means.iter_mut() {
        *cm *= inv_h;
    }

    // Global mean: average of row means (== average of column means).
    let global_mean: f32 = row_means.iter().sum::<f32>() * inv_h;

    for y in 0..h {
        let rm = row_means[y];
        for x in 0..w {
            *output.get_mut(y, x) = input.get(y, x) - rm - col_means[x] + global_mean;
        }
    }
    Ok(())
}
