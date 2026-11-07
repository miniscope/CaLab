//! Scoring helpers mirroring `minisim.metrics.shift_rmse` /
//! `patch_shift_rmse` with `correction=True, align=True`: the estimate (a
//! registering shift) is negated to compare with minisim's content motion,
//! and the best constant per-axis offset is removed (the template's origin
//! is arbitrary).

use calab_cala::motion::warp::natural_spline_matrix;

/// RMSE (px) over frames and both axes between registering shifts `est`
/// `[(dy, dx)]` and content motion `truth`, after removing the mean offset.
pub fn shift_rmse_aligned(est: &[(f64, f64)], truth: &[(f64, f64)]) -> f64 {
    assert_eq!(est.len(), truth.len());
    let n = est.len() as f64;
    let d: Vec<(f64, f64)> = est
        .iter()
        .zip(truth)
        .map(|(e, t)| (-e.0 - t.0, -e.1 - t.1))
        .collect();
    let my = d.iter().map(|v| v.0).sum::<f64>() / n;
    let mx = d.iter().map(|v| v.1).sum::<f64>() / n;
    (d.iter()
        .map(|v| (v.0 - my).powi(2) + (v.1 - mx).powi(2))
        .sum::<f64>()
        / (2.0 * n))
        .sqrt()
}

/// Ground-truth content motion of a minisim recording.
pub struct Truth {
    pub shifts: Vec<(f64, f64)>,
    /// `(frame, gy, gx, 2)` flattened, or empty.
    pub field: Vec<f64>,
    pub nodes_y: Vec<f64>,
    pub nodes_x: Vec<f64>,
}

impl Truth {
    pub fn frames(&self) -> usize {
        self.shifts.len()
    }

    /// Total `(dy, dx)` content motion at points `pts` for frame `f`.
    pub fn displacement(&self, f: usize, pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
        let (gy, gx) = (self.nodes_y.len(), self.nodes_x.len());
        let ys: Vec<f64> = pts.iter().map(|p| p.0).collect();
        let xs: Vec<f64> = pts.iter().map(|p| p.1).collect();
        let my = natural_spline_matrix(&self.nodes_y, &ys);
        let mx = natural_spline_matrix(&self.nodes_x, &xs);
        pts.iter()
            .enumerate()
            .map(|(p, _)| {
                let (mut dy, mut dx) = self.shifts[f];
                if !self.field.is_empty() {
                    for i in 0..gy {
                        for j in 0..gx {
                            let w = my[p * gy + i] * mx[p * gx + j];
                            let base = ((f * gy + i) * gx + j) * 2;
                            dy += w * self.field[base];
                            dx += w * self.field[base + 1];
                        }
                    }
                }
                (dy, dx)
            })
            .collect()
    }
}

/// Patch RMSE (px): `est[f][p]` registering shifts at points `pts`, against
/// the true motion there, after removing one mean offset per axis.
pub fn patch_rmse_aligned(
    est: &[Vec<(f64, f64)>],
    truth: &Truth,
    frames: &[usize],
    pts: &[(f64, f64)],
) -> f64 {
    let mut d = Vec::new();
    for (k, &f) in frames.iter().enumerate() {
        let t = truth.displacement(f, pts);
        for (e, t) in est[k].iter().zip(&t) {
            d.push((-e.0 - t.0, -e.1 - t.1));
        }
    }
    let n = d.len() as f64;
    let my = d.iter().map(|v| v.0).sum::<f64>() / n;
    let mx = d.iter().map(|v| v.1).sum::<f64>() / n;
    (d.iter()
        .map(|v| (v.0 - my).powi(2) + (v.1 - mx).powi(2))
        .sum::<f64>()
        / (2.0 * n))
        .sqrt()
}
