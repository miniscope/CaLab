//! FISTA vs interior-point relaxed solve on simulated cells (ignored test;
//! measurement only). Release:
//!
//! ```text
//! FR_PRESET=gcamp6s FR_FS=30 FR_DUR=600 FR_SNR=8 FR_MFR=300 FR_CELLS=4 \
//!   cargo test --release --lib fast_relaxed_eval -- --ignored --nocapture --test-threads 1
//! ```
use crate::banded::BandedAR2;
use crate::indeca::{solve_trace_cfg, Relaxed, SolveConfig};
use crate::native_solve::{certify, Stop};
use crate::simulate::{presets, simulate, MarkovConfig, SpikeModel};
use std::time::Instant;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn f1(truth: &[f32], est: &[f32], tol: i64) -> f64 {
    let expand = |c: &[f32]| -> Vec<i64> {
        let mut v = vec![];
        for (i, &x) in c.iter().enumerate() {
            for _ in 0..(x.round().max(0.0) as usize) {
                v.push(i as i64);
            }
        }
        v
    };
    let (a, b) = (expand(truth), expand(est));
    let (mut i, mut j, mut tp) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        if (a[i] - b[j]).abs() <= tol {
            tp += 1;
            i += 1;
            j += 1;
        } else if a[i] < b[j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (p, r) = (tp as f64 / b.len() as f64, tp as f64 / a.len() as f64);
    if p + r > 0.0 {
        2.0 * p * r / (p + r)
    } else {
        0.0
    }
}

#[test]
#[ignore]
fn fast_relaxed_eval() {
    let preset = env("FR_PRESET", "jgcamp8f");
    let fs: f64 = env("FR_FS", "30").parse().unwrap();
    let dur: f64 = env("FR_DUR", "600").parse().unwrap();
    let snr: f64 = env("FR_SNR", "8").parse().unwrap();
    let mfr: f64 = env("FR_MFR", "300").parse().unwrap();
    let cells: usize = env("FR_CELLS", "4").parse().unwrap();
    let do_fista = env("FR_FISTA", "1") == "1";
    // FR_TIGHT=1: the reference is FISTA at a 1e-6 tighter certificate.
    let tight = env("FR_TIGHT", "0") == "1";

    let mut cfg = presets::all()
        .into_iter()
        .find(|(n, _)| *n == preset)
        .expect("preset")
        .1;
    cfg.fs_hz = fs;
    cfg.num_cells = cells;
    cfg.num_timepoints = (dur * fs) as usize;
    cfg.seed = 11;
    cfg.noise.snr = snr;
    cfg.spike_model = SpikeModel::Markov(MarkovConfig {
        p_silent_to_active_cv: 0.3,
        ..MarkovConfig::default()
    });
    let sim = simulate(&cfg);
    let nt = sim.num_timepoints;
    let cap = crate::indeca::spike_cap(mfr, fs) as f64;

    let (mut t_f, mut t_i) = (0.0, 0.0);
    let (mut it_f, mut it_i) = (0u64, 0u64);
    let (mut same, mut conv_f, mut conv_i) = (0, 0, 0);
    let mut dmax_all = 0.0_f64;
    let mut dobj_max = 0.0_f64;
    let (mut f1_f, mut f1_i) = (0.0, 0.0);
    let (mut n_f, mut n_i, mut n_t) = (0.0, 0.0, 0.0);
    let (mut pve_d, mut rem_f_max, mut rem_i_max) = (0.0_f64, 0.0_f64, 0.0_f64);
    for c in 0..cells {
        let gt = &sim.ground_truth[c];
        let tr = &sim.traces[c * nt..(c + 1) * nt];
        let run = |relaxed: Relaxed| {
            let t0 = Instant::now();
            let out = solve_trace_cfg(
                tr,
                gt.tau_rise_s,
                gt.tau_decay_s,
                fs,
                mfr,
                500,
                1e-4,
                true,
                true,
                0.0,
                SolveConfig {
                    relaxed,
                    ..SolveConfig::default()
                },
            );
            (out, t0.elapsed().as_secs_f64())
        };
        let ((ri, si), ti) = run(Relaxed::Ipm);
        t_i += ti;
        it_i += si.iterations as u64;
        conv_i += si.converged as usize;
        let banded = BandedAR2::new(gt.tau_rise_s, gt.tau_decay_s, fs);
        let obj = |x: &[f64], y: &[f64]| {
            let mut cv = vec![0.0; x.len()];
            banded.convolve_forward_f64(x, &mut cv);
            0.5 * cv
                .iter()
                .zip(y)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f64>()
        };
        let rem = |x: &[f64], y: &[f64]| {
            let n = x.len();
            let stop = Stop {
                se: 1.0,
                lo: 0,
                hi: n,
            };
            let (mut a, mut b, mut cc) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
            certify(x, y, &banded, 0.0, &stop, &mut a, &mut b, &mut cc).remaining
        };
        let obj_i = obj(&si.relaxed_x, &si.relaxed_y);
        rem_i_max = rem_i_max.max(rem(&si.relaxed_x, &si.relaxed_y));
        let truth = &gt.spikes;
        f1_i += f1(truth, &ri.s_counts, 2);
        n_i += ri.s_counts.iter().sum::<f32>() as f64;
        n_t += truth.iter().sum::<f32>() as f64;
        if do_fista {
            let ((rf, sf), tf) = run(if tight {
                Relaxed::FistaTight
            } else {
                Relaxed::Fista
            });
            t_f += tf;
            it_f += sf.iterations as u64;
            conv_f += sf.converged as usize;
            let dmax = si
                .relaxed_x
                .iter()
                .zip(&sf.relaxed_x)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max)
                * cap;
            let obj_f = obj(&sf.relaxed_x, &sf.relaxed_y);
            dobj_max = dobj_max.max((obj_f - obj_i) / obj_i.max(1e-12));
            dmax_all = dmax_all.max(dmax);
            rem_f_max = rem_f_max.max(rem(&sf.relaxed_x, &sf.relaxed_y));
            let eq = rf.s_counts == ri.s_counts;
            same += eq as usize;
            f1_f += f1(truth, &rf.s_counts, 2);
            n_f += rf.s_counts.iter().sum::<f32>() as f64;
            pve_d = pve_d.max((rf.pve - ri.pve).abs());
            println!(
                "CELL {c} t_fista={:.0}ms t_ipm={:.0}ms it_f={} it_i={} max|dx|={:.2e} relobj(F-I)/I={:.1e} same_counts={eq} n_f={} n_i={}",
                tf * 1e3,
                ti * 1e3,
                sf.iterations,
                si.iterations,
                dmax,
                (obj_f - obj_i) / obj_i.max(1e-12),
                rf.s_counts.iter().sum::<f32>(),
                ri.s_counts.iter().sum::<f32>(),
            );
        }
    }
    let k = cells as f64;
    println!(
        "SUMMARY preset={preset} fs={fs} dur={dur} snr={snr} mfr={mfr} cells={cells} | ms/solve fista={:.1} ipm={:.1} speedup={:.1}x | iters fista={:.0} ipm={:.0} | conv fista={conv_f} ipm={conv_i} | exact_same={same}/{cells} max|dx|(spikes)={:.2e} max_relobj={:.1e} | F1 fista={:.3} ipm={:.3} | n_true={:.0} n_fista={:.0} n_ipm={:.0} | max dPVE={:.1e} | KKT||delta|| max fista={:.2e} ipm={:.2e}",
        1e3 * t_f / k,
        1e3 * t_i / k,
        t_f / t_i,
        it_f as f64 / k,
        it_i as f64 / k,
        dmax_all,
        dobj_max,
        f1_f / k,
        f1_i / k,
        n_t,
        n_f,
        n_i,
        pve_d,
        rem_f_max,
        rem_i_max,
    );
}

/// The CaDecon-equivalent loop: solve all cells, estimate the free kernel,
/// fit the bi-exponential, repeat from a wrong initial kernel; prints the
/// time constants per round for each method.
///
/// `FR_PRESET`, `FR_FS`, `FR_DUR`, `FR_CELLS`, `FR_ROUNDS`, `FR_METHODS` (comma list of ipm|fista).
#[test]
#[ignore]
fn fast_relaxed_kernel_loop() {
    let preset = env("FR_PRESET", "jgcamp8f");
    let fs: f64 = env("FR_FS", "30").parse().unwrap();
    let dur: f64 = env("FR_DUR", "300").parse().unwrap();
    let cells: usize = env("FR_CELLS", "6").parse().unwrap();
    let rounds: usize = env("FR_ROUNDS", "6").parse().unwrap();
    let mut cfg = presets::all()
        .into_iter()
        .find(|(n, _)| *n == preset)
        .expect("preset")
        .1;
    cfg.fs_hz = fs;
    cfg.num_cells = cells;
    cfg.num_timepoints = (dur * fs) as usize;
    cfg.seed = 21;
    cfg.spike_model = SpikeModel::Markov(MarkovConfig {
        p_silent_to_active_cv: 0.3,
        ..MarkovConfig::default()
    });
    let sim = simulate(&cfg);
    let nt = sim.num_timepoints;
    let gt0 = &sim.ground_truth[0];
    println!(
        "LOOP preset={preset} fs={fs} true tau_r={:.4} tau_d={:.4}",
        gt0.tau_rise_s, gt0.tau_decay_s
    );
    let kernel_len = ((5.0 * gt0.tau_decay_s * fs).ceil() as usize).max(10);
    for method in env("FR_METHODS", "ipm,fista").split(',') {
        let relaxed = if method == "ipm" {
            Relaxed::Ipm
        } else {
            Relaxed::Fista
        };
        let (mut tr, mut td) = (gt0.tau_rise_s * 0.5, gt0.tau_decay_s * 1.6);
        let mut warm: Option<Vec<f32>> = None;
        let t0 = Instant::now();
        for round in 0..rounds {
            let (mut tf, mut sf, mut lens, mut al, mut bl) =
                (vec![], vec![], vec![], vec![], vec![]);
            let mut total_spikes = 0.0_f32;
            for c in 0..cells {
                let (r, _) = solve_trace_cfg(
                    &sim.traces[c * nt..(c + 1) * nt],
                    tr,
                    td,
                    fs,
                    300.0,
                    500,
                    1e-4,
                    true,
                    true,
                    0.0,
                    SolveConfig {
                        relaxed,
                        ..SolveConfig::default()
                    },
                );
                if r.alpha == 0.0 {
                    continue;
                }
                total_spikes += r.s_counts.iter().sum::<f32>();
                tf.extend_from_slice(r.filtered_trace.as_ref().unwrap());
                sf.extend_from_slice(&r.s_counts);
                lens.push(nt);
                al.push(r.alpha);
                bl.push(r.baseline);
            }
            let h = crate::kernel_est::estimate_free_kernel(
                &tf,
                &sf,
                &al,
                &bl,
                &lens,
                kernel_len,
                200,
                1e-4,
                warm.as_deref(),
                0.0,
            );
            let fit = crate::biexp_fit::fit_biexponential(&h, fs, true, 0, None);
            tr = fit.tau_rise;
            td = fit.tau_decay;
            warm = Some(h);
            println!(
                "LOOP {method} round {round}: tau_r={tr:.4} tau_d={td:.4} spikes={total_spikes:.0}"
            );
        }
        println!("LOOP {method} total {:.1}s", t0.elapsed().as_secs_f64());
    }
}
