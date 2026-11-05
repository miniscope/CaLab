//! Equivalence gate for the nested-superposition threshold search
//! (`chain::Superposition`): the shipped path against the reference path that
//! pushes every candidate through the f32 FFT chain from scratch.
//!
//! What must hold, and why it is not bit-identity: the superposition
//! evaluates in f64 the linear map that the reference evaluates with an f32
//! FFT of the trace length, so per-candidate errors differ by the reference's
//! own f32 FFT rounding. Measured (4 Nov 2026, 480 simulated cells over every
//! preset, 30/60 Hz, SNR 30/10/4, Markov and Poisson, plus 599 rows and
//! windows of the synthetic datasets): candidate errors within 8.4e-7
//! relative of the reference, against 8.4e-11 between the column route and
//! the f64 FFT route (`Path::NestedFft`; that floor is the f32 rounding of
//! the reconstruction both routes hand to the rolling quantile). Every cell's
//! pick, train, amplitude and noise path were identical, and F1 with them.
//! The rolling quantile and everything after it are the shipped code on both
//! paths, and the final pass at the pick is the reference scorer, so a cell
//! whose pick is unchanged returns bit-identical results.
use crate::indeca::{solve_trace_opts, SolveOptions};
use crate::simulate::{presets, simulate, PoissonConfig, SimulationConfig, SpikeModel};
use crate::threshold::test_hooks::{self, Path};

/// One solve with the given threshold-search path, returning the result and
/// every threshold search's per-level errors.
fn solve_with(
    path: Path,
    trace: &[f32],
    tau: (f64, f64),
    fs: f64,
) -> (crate::indeca::InDecaResult, Vec<Vec<f64>>) {
    test_hooks::PATH.with(|p| p.set(path));
    test_hooks::ERRORS.with(|e| *e.borrow_mut() = Some(Vec::new()));
    let k = (300.0 / fs).round() as usize;
    let r = solve_trace_opts(
        trace,
        tau.0,
        tau.1,
        fs,
        k,
        2000,
        1e-4,
        None,
        true,
        true,
        0.0,
        SolveOptions {
            noise_constrained: true,
        },
    );
    let errs = test_hooks::ERRORS.with(|e| e.borrow_mut().take().unwrap());
    test_hooks::PATH.with(|p| p.set(Path::Nested));
    (r, errs)
}

/// F1 of count-level matching within `tol` frames.
fn timing_f1(truth: &[f32], est: &[f32], tol: i64) -> f64 {
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

/// Largest relative difference between two runs' per-level errors (finite
/// levels only; both runs must have searched the same number of times).
fn max_rel_dev(a: &[Vec<f64>], b: &[Vec<f64>]) -> f64 {
    assert_eq!(a.len(), b.len(), "different number of threshold searches");
    let mut m = 0.0_f64;
    for (ea, eb) in a.iter().zip(b) {
        for (&x, &y) in ea.iter().zip(eb) {
            if x.is_finite() && y.is_finite() && y > 0.0 {
                m = m.max((x - y).abs() / y);
            }
        }
    }
    m
}

#[derive(Default, Debug)]
struct Agg {
    cells: usize,
    same: usize,
    f1_ref: f64,
    f1_new: f64,
    rel_ref: f64,
    rel_fft: f64,
    secs_ref: f64,
    secs_new: f64,
    mismatches: Vec<String>,
}

/// Solve every cell of `cfg` on the reference and nested paths (and, with
/// `fft_route`, the nested path with every batch through the f64 FFT).
fn run_config(name: &str, cfg: &SimulationConfig, threads: usize, fft_route: bool) -> Agg {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let sim = simulate(cfg);
    let t_len = cfg.num_timepoints;
    let fs = cfg.fs_hz;
    let tau = (cfg.kernel.tau_rise_s, cfg.kernel.tau_decay_s);
    let next = AtomicUsize::new(0);
    let agg = Mutex::new(Agg::default());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let c = next.fetch_add(1, Ordering::Relaxed);
                if c >= cfg.num_cells {
                    break;
                }
                let trace = &sim.traces[c * t_len..(c + 1) * t_len];
                let t0 = std::time::Instant::now();
                let (r_ref, e_ref) = solve_with(Path::Reference, trace, tau, fs);
                let t1 = std::time::Instant::now();
                let (r_new, e_new) = solve_with(Path::Nested, trace, tau, fs);
                let t2 = std::time::Instant::now();
                let e_fft = if fft_route {
                    solve_with(Path::NestedFft, trace, tau, fs).1
                } else {
                    e_new.clone()
                };
                let truth = &sim.ground_truth[c].spikes;
                let same = r_new.s_counts == r_ref.s_counts
                    && r_new.threshold.to_bits() == r_ref.threshold.to_bits()
                    && r_new.alpha.to_bits() == r_ref.alpha.to_bits()
                    && r_new.noise_path == r_ref.noise_path;
                let mut a = agg.lock().unwrap();
                a.cells += 1;
                a.same += same as usize;
                a.f1_ref += timing_f1(truth, &r_ref.s_counts, 2);
                a.f1_new += timing_f1(truth, &r_new.s_counts, 2);
                a.rel_ref = a.rel_ref.max(max_rel_dev(&e_new, &e_ref));
                a.rel_fft = a.rel_fft.max(max_rel_dev(&e_new, &e_fft));
                a.secs_ref += (t1 - t0).as_secs_f64();
                a.secs_new += (t2 - t1).as_secs_f64();
                if !same {
                    let cnt = |v: &[f32]| v.iter().map(|&x| x as f64).sum::<f64>();
                    a.mismatches.push(format!(
                        "{name} cell {c}: threshold {:.6} -> {:.6}, count {} -> {}, alpha {:.6} -> {:.6}",
                        r_ref.threshold,
                        r_new.threshold,
                        cnt(&r_ref.s_counts),
                        cnt(&r_new.s_counts),
                        r_ref.alpha,
                        r_new.alpha
                    ));
                }
            });
        }
    });
    agg.into_inner().unwrap()
}

fn configs(
    rates: &[f64],
    snrs: &[f64],
    minutes: f64,
    cells: usize,
) -> Vec<(String, SimulationConfig)> {
    let mut out = vec![];
    for &fs in rates {
        for (name, base) in presets::all() {
            if name == "clean" {
                continue;
            }
            for &snr in snrs {
                for poisson in [false, true] {
                    let mut cfg = SimulationConfig {
                        fs_hz: fs,
                        num_cells: cells,
                        num_timepoints: (minutes * 60.0 * fs) as usize,
                        ..base.clone()
                    };
                    cfg.noise.snr = snr;
                    if poisson {
                        cfg.spike_model = SpikeModel::Poisson(PoissonConfig::default());
                    }
                    let label = format!(
                        "{name} {fs} Hz snr {snr} {}",
                        if poisson { "poisson" } else { "markov" }
                    );
                    out.push((label, cfg));
                }
            }
        }
    }
    out
}

/// The gate on a small matrix (every preset, both firing models, 30 Hz, one
/// 90 s cell each): per-candidate errors within the reference's f32 FFT
/// rounding, and identical picks. The full matrix is the ignored
/// `nested_superposition_gate_full`.
#[test]
fn nested_superposition_matches_reference_scoring() {
    let mut total = Agg::default();
    for (name, cfg) in configs(&[30.0], &[30.0], 1.5, 1) {
        let a = run_config(&name, &cfg, 2, false);
        assert!(
            a.rel_ref < 1e-5,
            "{name}: superposition vs f32 reference differ by {:e}",
            a.rel_ref
        );
        total.cells += a.cells;
        total.same += a.same;
        total.mismatches.extend(a.mismatches);
    }
    assert_eq!(total.same, total.cells, "{:#?}", total.mismatches);
}

/// The full gate (ignored; run with `--ignored --nocapture`): presets x
/// {30, 60} Hz x SNR x {Markov, Poisson}. Env: `CALAB_GATE_CELLS` (8),
/// `CALAB_GATE_MIN` (5), `CALAB_GATE_SNR` ("30,10,4"), `CALAB_GATE_FS`
/// ("30,60"), `CALAB_THREADS` (8), `CALAB_GATE_TIMING` (skip the f64 FFT
/// route, for timing).
#[test]
#[ignore]
fn nested_superposition_gate_full() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let list = |s: String| -> Vec<f64> { s.split(',').map(|x| x.parse().unwrap()).collect() };
    let cells: usize = env("CALAB_GATE_CELLS", "8").parse().unwrap();
    let minutes: f64 = env("CALAB_GATE_MIN", "5").parse().unwrap();
    let threads: usize = env("CALAB_THREADS", "8").parse().unwrap();
    let fft_route = std::env::var("CALAB_GATE_TIMING").is_err();
    let rates = list(env("CALAB_GATE_FS", "30,60"));
    let snrs = list(env("CALAB_GATE_SNR", "30,10,4"));
    let mut total = Agg::default();
    for (name, cfg) in configs(&rates, &snrs, minutes, cells) {
        let a = run_config(&name, &cfg, threads, fft_route);
        println!(
            "{name:<34} cells {:>3} same {:>3}  F1 ref {:.4} new {:.4}  max rel dev vs f32 ref {:.2e}, vs f64 FFT {:.2e}  time ref {:.2}s new {:.2}s ({:.2}x)",
            a.cells,
            a.same,
            a.f1_ref / a.cells as f64,
            a.f1_new / a.cells as f64,
            a.rel_ref,
            a.rel_fft,
            a.secs_ref,
            a.secs_new,
            a.secs_ref / a.secs_new.max(1e-12)
        );
        for m in &a.mismatches {
            println!("    MISMATCH {m}");
        }
        total.cells += a.cells;
        total.same += a.same;
        total.f1_ref += a.f1_ref;
        total.f1_new += a.f1_new;
        total.rel_ref = total.rel_ref.max(a.rel_ref);
        total.rel_fft = total.rel_fft.max(a.rel_fft);
        total.secs_ref += a.secs_ref;
        total.secs_new += a.secs_new;
        total.mismatches.extend(a.mismatches);
    }
    println!(
        "TOTAL cells {} same {} ({:.2} %)  F1 ref {:.5} new {:.5}  max rel dev vs ref {:.2e} vs f64 FFT {:.2e}  time ref {:.1}s new {:.1}s ({:.2}x)",
        total.cells,
        total.same,
        100.0 * total.same as f64 / total.cells as f64,
        total.f1_ref / total.cells as f64,
        total.f1_new / total.cells as f64,
        total.rel_ref,
        total.rel_fft,
        total.secs_ref,
        total.secs_new,
        total.secs_ref / total.secs_new
    );
}

/// The gate on a recorded-format dataset (ignored): `CALAB_NPY` (f32 C-order
/// cells x time, 30 Hz, solved with tau 0.1 / 0.6 s as CaDecon's default),
/// every `CALAB_STRIDE`-th cell, as full-length rows or (`CALAB_SUBSET`) as
/// windows of the 25 % subset length. Cells with non-finite samples are
/// skipped, as the WASM entry rejects them.
#[test]
#[ignore]
fn nested_superposition_gate_npy() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let path = std::env::var("CALAB_NPY").expect("CALAB_NPY");
    let bytes = std::fs::read(&path).unwrap();
    let hlen = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let header = std::str::from_utf8(&bytes[10..10 + hlen]).unwrap();
    let shape = header.split("'shape': (").nth(1).unwrap();
    let dims: Vec<usize> = shape
        .split(')')
        .next()
        .unwrap()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let (n_cells, t_total) = (dims[0], dims[1]);
    let data: Vec<f32> = bytes[10 + hlen..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&b| f32::from_le_bytes(b))
        .collect();
    let stride: usize = std::env::var("CALAB_STRIDE").map_or(10, |v| v.parse().unwrap());
    let threads: usize = std::env::var("CALAB_THREADS").map_or(8, |v| v.parse().unwrap());
    let t_len = if std::env::var("CALAB_SUBSET").is_ok() {
        (t_total as f64 * (0.25f64 / 8.0).sqrt()).floor() as usize
    } else {
        t_total
    };
    let jobs: Vec<(usize, usize)> = (0..n_cells)
        .step_by(stride)
        .map(|c| (c, ((c * 7919) % (t_total - t_len + 1))))
        .filter(|&(c, a)| {
            data[c * t_total + a..c * t_total + a + t_len]
                .iter()
                .all(|v| v.is_finite())
        })
        .collect();
    let next = AtomicUsize::new(0);
    let agg = Mutex::new(Agg::default());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::Relaxed);
                if j >= jobs.len() {
                    break;
                }
                let (c, a) = jobs[j];
                let trace = &data[c * t_total + a..c * t_total + a + t_len];
                let (r_ref, e_ref) = solve_with(Path::Reference, trace, (0.1, 0.6), 30.0);
                let (r_new, e_new) = solve_with(Path::Nested, trace, (0.1, 0.6), 30.0);
                let same = r_new.s_counts == r_ref.s_counts
                    && r_new.threshold.to_bits() == r_ref.threshold.to_bits()
                    && r_new.alpha.to_bits() == r_ref.alpha.to_bits()
                    && r_new.noise_path == r_ref.noise_path;
                let mut g = agg.lock().unwrap();
                g.cells += 1;
                g.same += same as usize;
                g.rel_ref = g.rel_ref.max(max_rel_dev(&e_new, &e_ref));
                if !same {
                    g.mismatches.push(format!(
                        "cell {c} @ {a}: threshold {} -> {}, noise_path {} -> {}",
                        r_ref.threshold, r_new.threshold, r_ref.noise_path, r_new.noise_path
                    ));
                }
            });
        }
    });
    let g = agg.into_inner().unwrap();
    println!(
        "{path}: {} jobs of {t_len} samples, identical {} ({:.2} %), max rel dev of candidate errors vs reference {:.2e}",
        g.cells,
        g.same,
        100.0 * g.same as f64 / g.cells as f64,
        g.rel_ref
    );
    for m in &g.mismatches {
        println!("    MISMATCH {m}");
    }
}
