//! Accuracy and runtime check of the event-mass binarization on simulated
//! cells (ignored test; run with `cargo test --release --lib eval_event_mass
//! -- --ignored --nocapture`). One tab-separated `EVAL` line per
//! (regime, preset, SNR): median count / true count, F1 within +-1 frame
//! (one-to-one matching of spike times, counts expanded), fraction of cells
//! whose pick is the floor, and seconds per cell. Env: EV_REGIME (markov |
//! poisson), EV_PRESETS, EV_SNRS, EV_CELLS, EV_DUR (s).
use crate::indeca::{solve_trace_cfg, SolveConfig};
use crate::simulate::{presets, simulate, MarkovConfig, PoissonConfig, SpikeModel};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn expand(c: &[f32]) -> Vec<i64> {
    let mut v = vec![];
    for (i, &x) in c.iter().enumerate() {
        for _ in 0..(x.round().max(0.0) as usize) {
            v.push(i as i64);
        }
    }
    v
}

/// F1 of one-to-one spike matching within `tol` frames.
fn f1(truth: &[f32], est: &[f32], tol: i64) -> f64 {
    let (a, b) = (expand(truth), expand(est));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
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
    2.0 * tp as f64 / (a.len() + b.len()) as f64
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

#[test]
#[ignore]
fn eval_event_mass() {
    let regime = env("EV_REGIME", "markov");
    let want: Vec<String> = env("EV_PRESETS", "gcamp6f,jgcamp8f,ogb1")
        .split(',')
        .map(String::from)
        .collect();
    let snrs: Vec<f64> = env("EV_SNRS", "8,30")
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    let cells: usize = env("EV_CELLS", "20").parse().unwrap();
    let dur: f64 = env("EV_DUR", "300").parse().unwrap();
    for (name, base) in presets::all() {
        if !want.iter().any(|w| w == name) {
            continue;
        }
        for &snr in &snrs {
            let mut cfg = base.clone();
            cfg.noise.snr = snr;
            cfg.num_cells = cells;
            cfg.num_timepoints = (dur * cfg.fs_hz) as usize;
            cfg.seed = 7 + (snr as u32) * 13;
            cfg.spike_model = match regime.as_str() {
                "poisson" => SpikeModel::Poisson(PoissonConfig { rate_hz: 1.0 }),
                _ => SpikeModel::Markov(MarkovConfig {
                    p_silent_to_active_cv: 0.3,
                    ..MarkovConfig::default()
                }),
            };
            let sim = simulate(&cfg);
            let nt = sim.num_timepoints;
            // (count / true, F1 +-1, at floor, seconds)
            let rows: Vec<(f64, f64, f64, f64)> = std::thread::scope(|s| {
                let hs: Vec<_> = (0..cells)
                    .map(|c| {
                        let (sim, fs) = (&sim, cfg.fs_hz);
                        s.spawn(move || {
                            let gt = &sim.ground_truth[c];
                            let t0 = std::time::Instant::now();
                            let (r, st) = solve_trace_cfg(
                                &sim.traces[c * nt..(c + 1) * nt],
                                gt.tau_rise_s,
                                gt.tau_decay_s,
                                fs,
                                300.0,
                                2000,
                                1e-4,
                                true,
                                true,
                                0.0,
                                SolveConfig::default(),
                            );
                            let secs = t0.elapsed().as_secs_f64();
                            let n_true = gt.spikes.iter().sum::<f32>() as f64;
                            (
                                r.s_counts.iter().sum::<f32>() as f64 / n_true.max(1e-9),
                                f1(&gt.spikes, &r.s_counts, 1),
                                st.diag.cap_limited as u8 as f64,
                                secs,
                            )
                        })
                    })
                    .collect();
                hs.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let col = |f: fn(&(f64, f64, f64, f64)) -> f64| rows.iter().map(f).collect::<Vec<_>>();
            println!(
                "EVAL\tregime={regime}\tpreset={name}\tsnr={snr}\tratio={:.3}\tf1_1={:.3}\tfloor={:.2}\tsecs={:.3}",
                median(col(|r| r.0)),
                median(col(|r| r.1)),
                col(|r| r.2).iter().sum::<f64>() / cells as f64,
                median(col(|r| r.3)),
            );
        }
    }
}
