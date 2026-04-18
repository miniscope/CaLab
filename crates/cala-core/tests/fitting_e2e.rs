//! Phase 2 exit: end-to-end OMF run on a synthetic multi-cell
//! recording with seeded ground-truth footprints (thesis §3.2.3
//! invariants).
//!
//! Setup: three Gaussian cells — one pair overlapping, one cell
//! isolated — firing in different temporal patterns across 60 frames.
//! Footprints are seeded at the exact ground truth (no discovery —
//! that is Phase 3's job with Extend). Observations are `y = Ã c`
//! noise-free so we can assert exact recovery.
//!
//! Invariants checked:
//! 1. Trace history length equals number of frames (Algorithm 6 line 3).
//! 2. Recovered `C̃[:, t]` matches ground truth within tolerance.
//! 3. Final residual `R_t` is ≈ 0 (perfect reconstruction on noiseless
//!    input, Eq. 3.24).
//! 4. Footprints stay at ground truth (seeded-truth is a fixed point
//!    of Algorithm 8, as shown analytically above).
//! 5. `SuffStats` converges to the expected outer-product rolling means
//!    (Eqs. 3.20–3.21) over the series.

use calab_cala_core::assets::Footprints;
use calab_cala_core::config::FitConfig;
use calab_cala_core::fitting::FitPipeline;

const TRACE_TOL: f32 = 1e-3;

fn gaussian_footprint(
    height: usize,
    width: usize,
    cy: f32,
    cx: f32,
    sigma: f32,
    threshold: f32,
) -> (Vec<u32>, Vec<f32>) {
    let mut support = Vec::new();
    let mut values = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let dy = y as f32 - cy;
            let dx = x as f32 - cx;
            let v = (-0.5 * (dy * dy + dx * dx) / (sigma * sigma)).exp();
            if v >= threshold {
                support.push((y * width + x) as u32);
                values.push(v);
            }
        }
    }
    (support, values)
}

fn synthesize_frame(
    height: usize,
    width: usize,
    truth_supports: &[Vec<u32>],
    truth_values: &[Vec<f32>],
    c_gt: &[f32],
) -> Vec<f32> {
    let mut y = vec![0.0f32; height * width];
    for (i, &ci) in c_gt.iter().enumerate() {
        if ci == 0.0 {
            continue;
        }
        for (s_idx, &p) in truth_supports[i].iter().enumerate() {
            y[p as usize] += truth_values[i][s_idx] * ci;
        }
    }
    y
}

fn ground_truth_trace_series(n_frames: usize) -> Vec<Vec<f32>> {
    // Three cells with distinct temporal patterns: cell 0 fires at
    // every multiple of 5 with amplitude 3.0, cell 1 fires at every
    // multiple of 7 with amplitude 2.5, cell 2 fires at a few
    // hand-picked frames with amplitude 4.0. Deterministic so the
    // test outcome is fully reproducible.
    let mut c = vec![vec![0.0f32; 3]; n_frames];
    for (t, ct) in c.iter_mut().enumerate() {
        if t % 5 == 0 {
            ct[0] = 3.0;
        }
        if t % 7 == 0 {
            ct[1] = 2.5;
        }
        if t == 10 || t == 25 || t == 40 || t == 50 {
            ct[2] = 4.0;
        }
    }
    c
}

#[test]
fn noiseless_three_cell_recording_recovers_traces_and_residual() {
    let height = 16usize;
    let width = 16usize;

    // Cell 0 and cell 1 overlap (distance ≈ 2.2 < 3σ). Cell 2 is
    // isolated. Exercises both the coupled-BCD and decoupled-BCD
    // paths in one test.
    let cell_positions = [(4.0f32, 4.0), (5.0, 6.0), (12.0, 4.0)];
    let sigma = 1.5f32;
    let threshold = 0.1f32;

    let mut fp = Footprints::new(height, width);
    let mut truth_supports: Vec<Vec<u32>> = Vec::new();
    let mut truth_values: Vec<Vec<f32>> = Vec::new();
    for &(cy, cx) in &cell_positions {
        let (supp, vals) = gaussian_footprint(height, width, cy, cx, sigma, threshold);
        truth_supports.push(supp.clone());
        truth_values.push(vals.clone());
        fp.push_component(supp, vals);
    }
    let k = fp.len();
    assert_eq!(k, 3);

    let n_frames = 60usize;
    let c_gt = ground_truth_trace_series(n_frames);

    let cfg = FitConfig::default()
        .with_trace_max_iter(300)
        .with_trace_tol(1e-6)
        .with_footprint_max_iter(5);
    let mut pipe = FitPipeline::new(fp, cfg);

    for t in 0..n_frames {
        let y = synthesize_frame(height, width, &truth_supports, &truth_values, &c_gt[t]);
        pipe.step(&y);
    }

    // 1. History length.
    assert_eq!(pipe.traces().len(), n_frames);
    assert_eq!(pipe.suff_stats().frames(), n_frames as u64);

    // 2. Every frame's recovered trace matches ground truth.
    for t in 0..n_frames {
        let recovered = pipe.traces().get(t).unwrap();
        for i in 0..k {
            let diff = (recovered[i] - c_gt[t][i]).abs();
            assert!(
                diff <= TRACE_TOL,
                "trace [t={t}, i={i}]: expected {}, got {} (diff {} > tol {TRACE_TOL})",
                c_gt[t][i],
                recovered[i],
                diff
            );
        }
    }

    // 3. Final-frame residual is near zero (noise-free reconstruction).
    let r = pipe.last_residual();
    let r_l2: f32 = r.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        r_l2 < 1e-3,
        "final residual L2 {r_l2} exceeds tolerance — pipeline failed to fit noiseless frame"
    );

    // 4. Footprints remain at (or extremely close to) seeded truth.
    //    Seeded-truth is a fixed point of Algorithm 8 in noise-free
    //    setting; verify the pipeline didn't drift the support away.
    for i in 0..k {
        let got_support = pipe.footprints().support(i);
        let got_values = pipe.footprints().values(i);
        assert_eq!(
            got_support,
            truth_supports[i].as_slice(),
            "component {i} support drifted"
        );
        assert_eq!(got_values.len(), truth_values[i].len());
        for (j, (&a, &b)) in got_values.iter().zip(&truth_values[i]).enumerate() {
            let diff = (a - b).abs();
            assert!(
                diff < 1e-3,
                "component {i} value[{j}] drifted: truth {b}, got {a} (diff {diff})"
            );
        }
    }
}

#[test]
fn suff_stats_track_expected_rolling_means() {
    // W[p, i] at the end of t frames should equal (1/t) Σ y_τ[p] f(c_τ[i]).
    // With c₀ = 0 default, f(c) = c, so W[p, i] = mean(y[p] * c[i]).
    // Pinning this locks down the recursive-mean math through the
    // full pipeline (not just in the suff-stats unit test).
    let height = 8usize;
    let width = 8usize;
    let (supp, vals) = gaussian_footprint(height, width, 4.0, 4.0, 1.0, 0.1);
    let mut fp = Footprints::new(height, width);
    fp.push_component(supp.clone(), vals.clone());

    let traces = [1.0f32, 2.0, 0.5, 3.0, 1.5];
    let mut pipe = FitPipeline::new(fp, FitConfig::default());

    let mut expected_w: Vec<f32> = vec![0.0f32; height * width];
    for (t, &c) in traces.iter().enumerate() {
        let y = synthesize_frame(
            height,
            width,
            std::slice::from_ref(&supp),
            std::slice::from_ref(&vals),
            &[c],
        );
        pipe.step(&y);
        // Accumulate rolling mean for pixel-wise expected W[:, 0].
        let t_f = (t + 1) as f32;
        let decay = t as f32 / t_f;
        let inv = 1.0 / t_f;
        for p in 0..height * width {
            expected_w[p] = decay * expected_w[p] + inv * y[p] * c;
        }
    }

    let ss = pipe.suff_stats();
    assert_eq!(ss.frames(), traces.len() as u64);
    for p in 0..height * width {
        let got = ss.w_at(p, 0);
        let want = expected_w[p];
        let diff = (got - want).abs();
        assert!(
            diff < 1e-5,
            "W[{p}, 0]: expected {want}, got {got} (diff {diff})"
        );
    }

    // M[0, 0] is the rolling mean of c². Exact closed form.
    let expected_m00 = traces.iter().map(|&c| c * c).sum::<f32>() / traces.len() as f32;
    let diff = (ss.m_at(0, 0) - expected_m00).abs();
    assert!(
        diff < 1e-5,
        "M[0, 0]: expected {expected_m00}, got {} (diff {diff})",
        ss.m_at(0, 0)
    );
}
