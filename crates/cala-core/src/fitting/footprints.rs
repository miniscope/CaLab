//! `EvaluateFootprints` — per-column coordinate descent on positive
//! support using accumulated statistics `W`, `M` (thesis §3.2.3,
//! Algorithm 8).
//!
//! For each component `i`:
//! ```text
//! Ã[p, i] ← max(Ã[p, i] + (W[p, i] − Ã[p, :] M[:, i]) / M[i, i], 0)    ∀ p ∈ supp(i)
//! ```
//! After the outer sweep we compact each column so any entry that
//! got clamped to zero leaves the sparse rep — that is how
//! morphological shrink is recorded in this algorithm. Support never
//! expands here; expanding is Extend's job (Phase 3).

use crate::assets::{Footprints, SuffStats};
use crate::config::FitConfig;

pub fn evaluate_footprints(fp: &mut Footprints, ss: &SuffStats, cfg: &FitConfig) {
    let k = fp.len();
    if k == 0 {
        return;
    }
    assert_eq!(
        ss.pixels(),
        fp.pixels(),
        "SuffStats pixels {} must match Footprints pixels {}",
        ss.pixels(),
        fp.pixels()
    );
    assert_eq!(
        ss.k(),
        k,
        "SuffStats k {} must match Footprints len {}",
        ss.k(),
        k
    );

    let pixels = fp.pixels();
    // Reused per-i buffer: r[p] = Σⱼ Ã[p, j] · M[j, i] (the "reconstruction
    // weighted by M[:, i]" term). Allocated once and zeroed each pass.
    let mut r = vec![0.0f32; pixels];

    for _ in 0..cfg.footprint_max_iter {
        for i in 0..k {
            let mii = ss.m_at(i, i);
            if mii <= 0.0 {
                // No accumulated observations for this component's
                // trace, so Algorithm 8's division by M[i, i] is
                // undefined. Skip — leaves Ã untouched.
                continue;
            }

            // Rebuild r from current Ã. Gauss-Seidel across `i` means
            // earlier columns' updates within this outer iter propagate
            // into this SpMV.
            r.fill(0.0);
            for j in 0..k {
                let mji = ss.m_at(j, i);
                if mji == 0.0 {
                    continue;
                }
                for (&p, &val) in fp.support(j).iter().zip(fp.values(j)) {
                    r[p as usize] += val * mji;
                }
            }

            let inv_mii = 1.0f32 / mii;
            let support_len = fp.support(i).len();
            for s_idx in 0..support_len {
                let p = fp.support(i)[s_idx] as usize;
                let w_pi = ss.w_at(p, i);
                let cur = fp.values(i)[s_idx];
                let new_val = (cur + (w_pi - r[p]) * inv_mii).max(0.0);
                fp.values_mut(i)[s_idx] = new_val;
            }
        }

        // Remove any zeroed entries so subsequent iterations see only
        // positive support (the Algorithm 8 `find(Ã[:, i] > 0)` step).
        for i in 0..k {
            fp.compact(i);
        }
    }
}
