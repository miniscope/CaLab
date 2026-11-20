//! Dense linear algebra of the compression, in float64: an economic
//! Householder QR whose trailing updates run eight columns at a time, and a
//! cyclic Jacobi eigensolver for small symmetric matrices. Ported from
//! MiniMe's `minime-core` (`compress.rs`, `linalg.rs`).

/// Columns of a register block in the QR's trailing updates.
const QR_W: usize = 8;

/// `acc[k] = Σ_{i > j} v_i t[i][col0 + k]` for `k < W` over the row-major
/// `(m, n)` matrix `t`: one pass over the rows with `W` sums in registers.
#[inline(always)]
fn dot_cols<const W: usize>(
    t: &[f64],
    n: usize,
    j: usize,
    v: &[f64],
    col0: usize,
    acc: &mut [f64],
) {
    let mut s = [0.0f64; W];
    for (row, &vi) in t[(j + 1) * n..].chunks_exact(n).zip(v) {
        let x = &row[col0..col0 + W];
        for k in 0..W {
            s[k] += vi * x[k];
        }
    }
    acc[..W].copy_from_slice(&s);
}

/// `t[i][col0 + k] -= f[k] * v_i` for `k < W` and the rows `i > j`.
#[inline(always)]
fn axpy_cols<const W: usize>(t: &mut [f64], n: usize, j: usize, v: &[f64], col0: usize, f: &[f64]) {
    let mut fv = [0.0f64; W];
    fv.copy_from_slice(&f[..W]);
    for (row, &vi) in t[(j + 1) * n..].chunks_exact_mut(n).zip(v) {
        let x = &mut row[col0..col0 + W];
        for k in 0..W {
            x[k] -= fv[k] * vi;
        }
    }
}

/// Apply the reflector `H = I − τ [1; v] [1; v]ᵀ` (row `j` is its implicit
/// 1) to the columns `cols` of the row-major `(m, n)` matrix `t`.
fn reflect(t: &mut [f64], n: usize, j: usize, v: &[f64], tau: f64, cols: std::ops::Range<usize>) {
    let mut acc = [0.0f64; QR_W];
    let mut col0 = cols.start;
    while col0 < cols.end {
        let w = match cols.end - col0 {
            8.. => 8,
            4..=7 => 4,
            2..=3 => 2,
            _ => 1,
        };
        match w {
            8 => dot_cols::<8>(t, n, j, v, col0, &mut acc),
            4 => dot_cols::<4>(t, n, j, v, col0, &mut acc),
            2 => dot_cols::<2>(t, n, j, v, col0, &mut acc),
            _ => dot_cols::<1>(t, n, j, v, col0, &mut acc),
        }
        for k in 0..w {
            let d = t[j * n + col0 + k] + acc[k];
            acc[k] = tau * d;
            t[j * n + col0 + k] -= acc[k];
        }
        match w {
            8 => axpy_cols::<8>(t, n, j, v, col0, &acc),
            4 => axpy_cols::<4>(t, n, j, v, col0, &acc),
            2 => axpy_cols::<2>(t, n, j, v, col0, &acc),
            _ => axpy_cols::<1>(t, n, j, v, col0, &acc),
        }
        col0 += w;
    }
}

/// Orthonormal basis (economic Householder QR, LAPACK's sign convention) of
/// the columns of `a` `(m, n)` row-major, as `(m, n)` row-major float32.
pub(super) fn qr_q(a: &[f32], m: usize, n: usize) -> Vec<f32> {
    let mut c: Vec<f64> = a.iter().map(|&x| f64::from(x)).collect();
    let r = n.min(m);
    let mut tau = vec![0.0f64; n];
    let mut v = vec![0.0f64; m];
    for j in 0..r {
        let alpha = c[j * n + j];
        let xnorm = (j + 1..m)
            .map(|i| c[i * n + j])
            .fold(0.0, |s, x| s + x * x)
            .sqrt();
        if xnorm == 0.0 {
            continue; // H = I
        }
        let beta = -alpha.signum() * alpha.hypot(xnorm);
        let scale = 1.0 / (alpha - beta);
        for (i, vi) in v[..m - j - 1].iter_mut().enumerate() {
            let x = &mut c[(j + 1 + i) * n + j];
            *x *= scale;
            *vi = *x;
        }
        tau[j] = (beta - alpha) / beta;
        c[j * n + j] = beta;
        reflect(&mut c, n, j, &v[..m - j - 1], tau[j], j + 1..n);
    }
    // Q = H_0 ... H_{r-1} I[:, :n], applied from the last reflector back.
    let mut q = vec![0.0f64; m * n];
    for j in 0..r {
        q[j * n + j] = 1.0;
    }
    for j in (0..r).rev() {
        if tau[j] == 0.0 {
            continue;
        }
        for (i, vi) in v[..m - j - 1].iter_mut().enumerate() {
            *vi = c[(j + 1 + i) * n + j];
        }
        reflect(&mut q, n, j, &v[..m - j - 1], tau[j], j..n);
    }
    q.iter().map(|&x| x as f32).collect()
}

/// Eigenvalues (ascending) and eigenvectors (column `j` of the row-major
/// result belongs to eigenvalue `j`) of the symmetric `n x n` matrix `a`,
/// by cyclic Jacobi rotations.
pub(super) fn sym_eig(a: &[f64], n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut m = a.to_vec();
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    let norm: f64 = m.iter().map(|x| x * x).sum::<f64>().sqrt();
    for _sweep in 0..100 {
        let mut off = 0.0f64;
        for i in 0..n {
            for j in 0..n {
                if i != j {
                    off += m[i * n + j] * m[i * n + j];
                }
            }
        }
        let off = off.sqrt();
        if off <= 1e-15 * norm || off == 0.0 {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = m[p * n + q];
                if apq == 0.0 {
                    continue;
                }
                let theta = (m[q * n + q] - m[p * n + p]) / (2.0 * apq);
                let t = if theta == 0.0 {
                    1.0
                } else {
                    theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt())
                };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (mkp, mkq) = (m[k * n + p], m[k * n + q]);
                    m[k * n + p] = c * mkp - s * mkq;
                    m[k * n + q] = s * mkp + c * mkq;
                }
                for k in 0..n {
                    let (mpk, mqk) = (m[p * n + k], m[q * n + k]);
                    m[p * n + k] = c * mpk - s * mqk;
                    m[q * n + k] = s * mpk + c * mqk;
                }
                for k in 0..n {
                    let (vkp, vkq) = (v[k * n + p], v[k * n + q]);
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| m[i * n + i].total_cmp(&m[j * n + j]));
    let evals = order.iter().map(|&i| m[i * n + i]).collect();
    let mut evecs = vec![0.0; n * n];
    for (jn, &jo) in order.iter().enumerate() {
        for k in 0..n {
            evecs[k * n + jn] = v[k * n + jo];
        }
    }
    (evals, evecs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_columns_are_orthonormal_and_span_the_input() {
        let (m, n) = (37, 11);
        let a: Vec<f32> = (0..m * n)
            .map(|i| ((i * 7919 % 101) as f32 - 50.0) / 13.0)
            .collect();
        let q = qr_q(&a, m, n);
        for i in 0..n {
            for j in 0..n {
                let d: f64 = (0..m)
                    .map(|r| f64::from(q[r * n + i]) * f64::from(q[r * n + j]))
                    .sum();
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((d - want).abs() < 1e-5, "QᵀQ[{i}][{j}] = {d}");
            }
        }
        // Q Qᵀ a = a.
        for j in 0..n {
            for r in 0..m {
                let mut s = 0.0f64;
                for c in 0..n {
                    let coef: f64 = (0..m)
                        .map(|i| f64::from(q[i * n + c]) * f64::from(a[i * n + j]))
                        .sum();
                    s += f64::from(q[r * n + c]) * coef;
                }
                assert!((s - f64::from(a[r * n + j])).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn eigenpairs_of_a_symmetric_matrix() {
        let n = 6;
        let mut a = vec![0.0f64; n * n];
        for i in 0..n {
            for j in 0..n {
                a[i * n + j] =
                    1.0 / (1.0 + (i as f64 - j as f64).abs()) + if i == j { i as f64 } else { 0.0 };
            }
        }
        let (lam, e) = sym_eig(&a, n);
        assert!(lam.windows(2).all(|w| w[0] <= w[1]));
        for j in 0..n {
            for i in 0..n {
                let av: f64 = (0..n).map(|k| a[i * n + k] * e[k * n + j]).sum();
                assert!((av - lam[j] * e[i * n + j]).abs() < 1e-10);
            }
        }
    }
}
