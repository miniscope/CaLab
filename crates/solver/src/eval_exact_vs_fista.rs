//! Exact (Ipm) vs shipped early-stopped FISTA relaxed solve, full simulation
//! sweep with diagnostics (branch `exp/exact-vs-fista`; ignored tests, measurement only).
//!
//! ```text
//! EV_OUT=sweep.csv cargo test --release --lib eval_evf_sweep -- --ignored --nocapture
//! EV_OUT=kern.csv  cargo test --release --lib eval_evf_kernel -- --ignored --nocapture
//! ```
//!
//! Sweep: dataset = regime x preset x fs x seed (generator copied from
//! `exp/auto-cap`), 7 SNR levels x EV_CELLS cells, 300 s, TRUE kernel,
//! max firing rate 300 Hz. Every cell is solved with Fista and Ipm (and,
//! with EV_VARIANTS=1, Ipm with counterfactual edits of the relaxed masses) and one
//! wide CSV row is written. Env: EV_REGIMES, EV_PRESETS, EV_FS, EV_SEEDS, EV_SNRS, EV_CELLS,
//! EV_DUR, EV_MFR, EV_THREADS, EV_OUT, EV_VARIANTS.
use crate::biexp_fit::{fit_biexponential, FitMode};
use crate::event_mass::segment;
use crate::indeca::{solve_trace_cfg, InDecaResult, Relaxed, SolveConfig, SolveStats, XHook};
use crate::simulate::{presets, simulate, MarkovConfig, PoissonConfig, SpikeModel};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

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

/// F1 with a +-tol frame tolerance (greedy one-to-one matching, as exp/auto-cap).
pub(crate) fn f1(truth: &[f32], est: &[f32], tol: i64) -> f64 {
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

/// (estimated spikes > tol from every true spike, true spikes with no estimate within tol).
fn off_and_missed(truth: &[f32], est: &[f32], tol: i64) -> (usize, usize) {
    let (a, b) = (expand(truth), expand(est));
    let near = |v: &[i64], x: i64| -> bool {
        let k = v.partition_point(|&y| y < x - tol);
        k < v.len() && v[k] <= x + tol
    };
    let off = b.iter().filter(|&&x| !near(&a, x)).count();
    let miss = a.iter().filter(|&&x| !near(&b, x)).count();
    (off, miss)
}

pub(crate) fn spike_model(regime: &str) -> SpikeModel {
    match regime {
        "poisson" => SpikeModel::Poisson(PoissonConfig { rate_hz: 1.0 }),
        "markovlow" => SpikeModel::Markov(MarkovConfig {
            p_spike_when_active: 0.1,
            p_silent_to_active_cv: 0.3,
            ..MarkovConfig::default()
        }),
        _ => SpikeModel::Markov(MarkovConfig {
            p_silent_to_active_cv: 0.3,
            ..MarkovConfig::default()
        }),
    }
}

pub(crate) struct Cell {
    pub trace: Vec<f32>,
    pub tau_r: f64,
    pub tau_d: f64,
    pub snr: f64,
    pub spikes: Vec<f32>,
}

pub(crate) fn make_cells(
    regime: &str,
    base: &crate::simulate::SimulationConfig,
    fs: f64,
    seed: u32,
    snrs: &[f64],
    per: usize,
    dur: f64,
) -> Vec<Cell> {
    let mut cells = vec![];
    for (si, &snr) in snrs.iter().enumerate() {
        let mut cfg = base.clone();
        cfg.fs_hz = fs;
        cfg.noise.snr = snr;
        cfg.num_cells = per;
        cfg.num_timepoints = (dur * fs) as usize;
        cfg.seed = seed * 1000 + si as u32 * 17 + 3;
        cfg.spike_model = spike_model(regime);
        let sim = simulate(&cfg);
        let nt = sim.num_timepoints;
        for c in 0..per {
            let gt = &sim.ground_truth[c];
            cells.push(Cell {
                trace: sim.traces[c * nt..(c + 1) * nt].to_vec(),
                tau_r: gt.tau_rise_s,
                tau_d: gt.tau_decay_s,
                snr,
                spikes: gt.spikes.clone(),
            });
        }
    }
    cells
}

/// Everything recorded for one (cell, method) solve.
struct M {
    ms: f64,
    iters: u32,
    conv: bool,
    count: f64,
    f1: f64,
    pve: f64,
    off: usize,
    miss: usize,
    cap_limited: bool,
    no_size_fit: bool,
    fb: bool,
    dropped: u32,
    a_over_floor: f64,
    a_over_max: f64,
    gap_se: f64,
    n_ev: usize,
    n_live: usize,
    n_pos: usize,
    mass_in_units: f64,
    crumb_mass: f64,
    tiny_frames: usize,
    tiny_mass: f64,
    med_ev: f64,
    len_ev: f64,
    len_live: f64,
    a_pick: f64,
    a_floor: f64,
    frame_max: f64,
    mass_abs: f64,
    peak_share: f64,
    ev_mass: Vec<f64>,
    counts: Vec<f32>,
    x: Vec<f32>,
}

const M_HEADER: &str = "ms,iters,conv,count,f1,pve,off,miss,cap_limited,no_size_fit,dropped,a_over_floor,a_over_max,gap_se,n_ev,n_live,n_pos,mass,crumb_mass,tiny_frames,tiny_mass,med_ev,len_ev,len_live,a_pick,a_floor,frame_max,mass_abs,peak_share";

impl M {
    fn csv(&self) -> String {
        format!(
            "{:.2},{},{},{},{:.4},{:.5},{},{},{},{},{},{:.4},{:.4},{:.3},{},{},{},{:.3},{:.4},{},{:.4},{:.4},{:.3},{:.3},{:.6e},{:.6e},{:.6e},{:.6e},{:.4}",
            self.ms,
            self.iters,
            self.conv as u8,
            self.count,
            self.f1,
            self.pve,
            self.off,
            self.miss,
            self.cap_limited as u8,
            self.no_size_fit as u8,
            self.dropped,
            self.a_over_floor,
            self.a_over_max,
            self.gap_se,
            self.n_ev,
            self.n_live,
            self.n_pos,
            self.mass_in_units,
            self.crumb_mass,
            self.tiny_frames,
            self.tiny_mass,
            self.med_ev,
            self.len_ev,
            self.len_live,
            self.a_pick,
            self.a_floor,
            self.frame_max,
            self.mass_abs,
            self.peak_share,
        )
    }
}

fn run(c: &Cell, fs: f64, mfr: f64, cfg: SolveConfig) -> (InDecaResult, SolveStats, f64) {
    let t0 = Instant::now();
    let (r, st) = solve_trace_cfg(
        &c.trace, c.tau_r, c.tau_d, fs, mfr, 500, 1e-4, true, true, 0.0, cfg,
    );
    (r, st, t0.elapsed().as_secs_f64() * 1e3)
}

fn analyze(c: &Cell, fs: f64, mfr: f64, r: InDecaResult, st: SolveStats, ms: f64) -> M {
    let cap = crate::indeca::spike_cap(mfr, fs) as f32;
    let n = r.s_counts.len();
    let pad = crate::threshold::boundary_padding(c.tau_d, fs).min(n / 4);
    let (lo, hi) = (pad.min(n), n.saturating_sub(pad));
    let x: Vec<f32> = st.relaxed_x.iter().map(|&v| v as f32 * cap).collect();
    let ev = segment(&x, lo, hi);
    let a = st.diag.a_pick.max(1e-300);
    let live: Vec<_> = ev.iter().filter(|e| (e.mass / a).round() >= 1.0).collect();
    let crumb_mass: f64 = ev
        .iter()
        .filter(|e| (e.mass / a).round() < 1.0)
        .map(|e| e.mass / a)
        .sum();
    let tiny = |v: f32| (v as f64) > 0.0 && (v as f64) < 0.05 * a;
    let tiny_frames = x[lo..hi].iter().filter(|&&v| tiny(v)).count();
    let tiny_mass: f64 = x[lo..hi]
        .iter()
        .filter(|&&v| tiny(v))
        .map(|&v| v as f64 / a)
        .sum();
    let n_pos = x[lo..hi].iter().filter(|&&v| v > 0.0).count();
    let mut ms_sorted: Vec<f64> = ev.iter().map(|e| e.mass / a).collect();
    ms_sorted.sort_by(|p, q| p.partial_cmp(q).unwrap());
    let med_ev = if ms_sorted.is_empty() {
        0.0
    } else {
        ms_sorted[ms_sorted.len() / 2]
    };
    let mean_len = |v: &[&crate::event_mass::Event]| {
        if v.is_empty() {
            0.0
        } else {
            v.iter().map(|e| (e.end - e.start) as f64).sum::<f64>() / v.len() as f64
        }
    };
    let all: Vec<&crate::event_mass::Event> = ev.iter().collect();
    let (off, miss) = off_and_missed(&c.spikes, &r.s_counts, 2);
    let d = &st.diag;
    M {
        ms,
        iters: r.iterations,
        conv: r.converged,
        count: r.s_counts.iter().sum::<f32>() as f64,
        f1: f1(&c.spikes, &r.s_counts, 2),
        pve: r.pve,
        off,
        miss,
        cap_limited: r.cap_limited,
        no_size_fit: r.no_size_fit,
        fb: st.ipm_fallback,
        dropped: r.dropped_spikes,
        a_over_floor: if d.a_floor > 0.0 {
            d.a_pick / d.a_floor
        } else {
            0.0
        },
        a_over_max: if d.a_max > 0.0 {
            d.a_pick / d.a_max
        } else {
            0.0
        },
        gap_se: if d.std_error > 0.0 {
            (d.e_pick - d.e_relaxed) / d.std_error
        } else {
            f64::NAN
        },
        n_ev: ev.len(),
        n_live: live.len(),
        n_pos,
        mass_in_units: ev.iter().map(|e| e.mass).sum::<f64>() / a,
        crumb_mass,
        tiny_frames,
        tiny_mass,
        med_ev,
        len_ev: mean_len(&all),
        len_live: mean_len(&live),
        a_pick: d.a_pick,
        a_floor: d.a_floor,
        frame_max: x[lo..hi].iter().fold(0.0_f64, |m, &v| m.max(v as f64)),
        mass_abs: ev.iter().map(|e| e.mass).sum::<f64>(),
        peak_share: ev.iter().map(|e| e.peak).sum::<f64>()
            / ev.iter().map(|e| e.mass).sum::<f64>().max(1e-300),
        ev_mass: ev.iter().map(|e| e.mass).collect(),
        counts: r.s_counts,
        x,
    }
}

fn solve_m(c: &Cell, fs: f64, mfr: f64, relaxed: Relaxed, hook: XHook) -> M {
    let (r, st, ms) = run(
        c,
        fs,
        mfr,
        SolveConfig {
            relaxed,
            x_hook: hook,
            ..SolveConfig::default()
        },
    );
    analyze(c, fs, mfr, r, st, ms)
}

#[test]
#[ignore]
fn eval_evf_sweep() {
    let list =
        |k: &str, d: &str| -> Vec<String> { env(k, d).split(',').map(String::from).collect() };
    let regimes = list("EV_REGIMES", "markov,markovlow,poisson");
    let want = list("EV_PRESETS", "jgcamp8f,gcamp6s");
    let fss: Vec<f64> = list("EV_FS", "30,60,10")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let snrs: Vec<f64> = list("EV_SNRS", "3,5,8,12,20,35,50")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let per: usize = env("EV_CELLS", "25").parse().unwrap();
    let dur: f64 = env("EV_DUR", "300").parse().unwrap();
    let mfr: f64 = env("EV_MFR", "300").parse().unwrap();
    let variants = env("EV_VARIANTS", "0") == "1";
    let threads: usize = env(
        "EV_THREADS",
        &std::thread::available_parallelism()
            .unwrap()
            .get()
            .to_string(),
    )
    .parse()
    .unwrap();
    let out = env("EV_OUT", "evf_sweep.csv");
    let hooks: Vec<(&str, XHook)> = vec![
        ("iz1", XHook::ZeroFrames(0.01)),
        ("iz5", XHook::ZeroFrames(0.05)),
        ("ie5", XHook::ZeroEvents(0.05)),
    ];
    let mut w = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    let pref = |p: &str| {
        M_HEADER
            .split(',')
            .map(|h| format!("{p}_{h}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut head = format!(
        "ds,regime,preset,fs,seed,cell,snr,true_count,{},{},same,max_dx,ev_match,i_cnt_at_aF,f_cnt_at_aI",
        pref("f"),
        pref("i")
    );
    if variants {
        for (n, _) in &hooks {
            head += &format!(",{n}_count,{n}_f1,{n}_n_ev,{n}_off,{n}_miss");
        }
    }
    writeln!(w, "{head}").unwrap();
    let t_all = Instant::now();
    for regime in &regimes {
        for (pname, base) in presets::all() {
            if !want.iter().any(|x| x == pname) {
                continue;
            }
            for &fs in &fss {
                let nseeds = if fs == 30.0 { 3 } else { 2 };
                for seed in 1..=nseeds as u32 {
                    let ds = format!("{regime}/{pname}/{fs}/s{seed}");
                    let cells = make_cells(regime, &base, fs, seed, &snrs, per, dur);
                    let next = AtomicUsize::new(0);
                    let lines: std::sync::Mutex<Vec<(usize, String)>> = Default::default();
                    let t0 = Instant::now();
                    std::thread::scope(|s| {
                        for _ in 0..threads {
                            s.spawn(|| loop {
                                let ci = next.fetch_add(1, Ordering::Relaxed);
                                if ci >= cells.len() {
                                    break;
                                }
                                let c = &cells[ci];
                                let f = solve_m(c, fs, mfr, Relaxed::Fista, XHook::None);
                                let i = solve_m(c, fs, mfr, Relaxed::Ipm, XHook::None);
                                let same = f.counts == i.counts;
                                let max_dx = f
                                    .x
                                    .iter()
                                    .zip(&i.x)
                                    .map(|(a, b)| (a - b).abs())
                                    .fold(0.0_f32, f32::max);
                                let ev_match = (f.n_ev == i.n_ev) as u8;
                                let at = |m: &M, a: f64| -> f64 {
                                    m.ev_mass.iter().map(|&q| (q / a).round()).sum::<f64>()
                                };
                                let (i_at_af, f_at_ai) = (at(&i, f.a_pick), at(&f, i.a_pick));
                                let mut line = format!(
                                    "{ds},{regime},{pname},{fs},{seed},{ci},{},{},{},{},{},{:.4},{},{},{}",
                                    c.snr,
                                    c.spikes.iter().sum::<f32>(),
                                    f.csv(),
                                    i.csv(),
                                    same as u8,
                                    max_dx,
                                    ev_match,
                                    i_at_af,
                                    f_at_ai
                                );
                                if variants {
                                    for (_, h) in &hooks {
                                        let v = solve_m(c, fs, mfr, Relaxed::Ipm, *h);
                                        line += &format!(
                                            ",{},{:.4},{},{},{}",
                                            v.count, v.f1, v.n_ev, v.off, v.miss
                                        );
                                    }
                                }
                                lines.lock().unwrap().push((ci, line));
                            });
                        }
                    });
                    let mut ls = lines.into_inner().unwrap();
                    ls.sort_by_key(|l| l.0);
                    for (_, l) in ls {
                        writeln!(w, "{l}").unwrap();
                    }
                    w.flush().unwrap();
                    println!(
                        "DONE {ds} {} cells in {:.0}s",
                        cells.len(),
                        t0.elapsed().as_secs_f64()
                    );
                }
            }
        }
    }
    println!("TOTAL sweep wall {:.0}s", t_all.elapsed().as_secs_f64());
}

/// Counterfactual: event-span spike-size floor (`FLOOR_MODE = 1`) with both
/// relaxed solvers, same datasets/cells as the sweep. One row per cell.
#[test]
#[ignore]
fn eval_evf_floor() {
    let list =
        |k: &str, d: &str| -> Vec<String> { env(k, d).split(',').map(String::from).collect() };
    let regimes = list("EV_REGIMES", "markov,markovlow,poisson");
    let want = list("EV_PRESETS", "jgcamp8f,gcamp6s");
    let fss: Vec<f64> = list("EV_FS", "30,60,10")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let snrs: Vec<f64> = list("EV_SNRS", "3,5,8,12,20,35,50")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let per: usize = env("EV_CELLS", "25").parse().unwrap();
    let dur: f64 = env("EV_DUR", "300").parse().unwrap();
    let mfr: f64 = env("EV_MFR", "300").parse().unwrap();
    let do_f = env("EV_FISTA", "1") == "1";
    let modes: Vec<u8> = list("EV_MODES", "1")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let threads: usize = env(
        "EV_THREADS",
        &std::thread::available_parallelism()
            .unwrap()
            .get()
            .to_string(),
    )
    .parse()
    .unwrap();
    let out = env("EV_OUT", "evf_floor.csv");
    let mut w = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    writeln!(
        w,
        "ds,cell,snr,true_count,m,count,f1,off,miss,cap_limited,no_size_fit,fb,a_over_floor,dropped,pve,ms"
    )
    .unwrap();
    for regime in &regimes {
        for (pname, base) in presets::all() {
            if !want.iter().any(|x| x == pname) {
                continue;
            }
            for &fs in &fss {
                let nseeds = if fs == 30.0 { 3 } else { 2 };
                for seed in 1..=nseeds as u32 {
                    let ds = format!("{regime}/{pname}/{fs}/s{seed}");
                    let cells = make_cells(regime, &base, fs, seed, &snrs, per, dur);
                    let next = AtomicUsize::new(0);
                    let lines: std::sync::Mutex<Vec<(usize, String)>> = Default::default();
                    std::thread::scope(|s| {
                        for _ in 0..threads {
                            s.spawn(|| loop {
                                let ci = next.fetch_add(1, Ordering::Relaxed);
                                if ci >= cells.len() {
                                    break;
                                }
                                let c = &cells[ci];
                                for &mode in &modes {
                                crate::event_mass::FLOOR_MODE.with(|m| m.set(mode));
                                let mut methods = vec![(format!("I{mode}"), Relaxed::Ipm)];
                                if do_f {
                                    methods.push((format!("F{mode}"), Relaxed::Fista));
                                }
                                for (nm, rl) in methods {
                                    let v = solve_m(c, fs, mfr, rl, XHook::None);
                                    let l = format!(
                                        "{ds},{ci},{},{},{nm},{},{:.4},{},{},{},{},{},{:.4},{},{:.5},{:.2}",
                                        c.snr,
                                        c.spikes.iter().sum::<f32>(),
                                        v.count,
                                        v.f1,
                                        v.off,
                                        v.miss,
                                        v.cap_limited as u8,
                                        v.no_size_fit as u8,
                                        v.fb as u8,
                                        v.a_over_floor,
                                        v.dropped,
                                        v.pve,
                                        v.ms
                                    );
                                    lines.lock().unwrap().push((ci, l));
                                }
                                crate::event_mass::FLOOR_MODE.with(|m| m.set(255));
                                }
                            });
                        }
                    });
                    let mut ls = lines.into_inner().unwrap();
                    ls.sort_by_key(|l| l.0);
                    for (_, l) in ls {
                        writeln!(w, "{l}").unwrap();
                    }
                    w.flush().unwrap();
                    println!("DONE {ds}");
                }
            }
        }
    }
}

/// Pure-noise traces (600 frames, 30 Hz, uniform noise as the degenerate-trace
/// unit test): spikes per trace under each pick rule and relaxed solver.
#[test]
#[ignore]
fn eval_evf_noise() {
    let nseeds: u64 = env("EV_NSEEDS", "200").parse().unwrap();
    let mfr: f64 = env("EV_MFR", "300").parse().unwrap();
    for mode in 0u8..6 {
        for (nm, rl) in [("Ipm", Relaxed::Ipm), ("Fista", Relaxed::Fista)] {
            crate::event_mass::FLOOR_MODE.with(|m| m.set(mode));
            let mut tot = vec![];
            let mut fixed = 0.0;
            for seed in 0..nseeds {
                let mut state = if seed == 0 {
                    0x9E3779B97F4A7C15_u64
                } else {
                    0x9E3779B97F4A7C15_u64 ^ seed.wrapping_mul(0xD1B54A32D192ED03)
                };
                let mut next = || {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    ((state >> 40) as f32 / (1u64 << 24) as f32) - 0.5
                };
                let trace: Vec<f32> = (0..600).map(|_| next() * 0.2).collect();
                let c = Cell {
                    trace,
                    tau_r: 0.02,
                    tau_d: 0.4,
                    snr: 0.0,
                    spikes: vec![0.0; 600],
                };
                let (r, _, _) = run(
                    &c,
                    30.0,
                    mfr,
                    SolveConfig {
                        relaxed: rl,
                        ..SolveConfig::default()
                    },
                );
                let n: f32 = r.s_counts.iter().sum();
                if seed == 0 {
                    fixed = n as f64;
                }
                tot.push(n as f64);
            }
            let mean = tot.iter().sum::<f64>() / tot.len() as f64;
            let mx = tot.iter().cloned().fold(0.0, f64::max);
            println!("NOISE mode={mode} {nm}: fixed-trace {fixed} mean/600 {mean:.2} max {mx} (n={nseeds})");
        }
    }
    crate::event_mass::FLOOR_MODE.with(|m| m.set(255));
}

// ---------------------------------------------------------------------------
// CaDecon-equivalent kernel-estimation loop (estimated kernel, subsets).
// ---------------------------------------------------------------------------

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn shape_rmse(r1: f64, d1: f64, r2: f64, d2: f64, fs: f64) -> f64 {
    let window = 5.0 * d1.max(d2);
    let n = ((window * fs).ceil() as usize).max(24);
    let dt = window / n as f64;
    let samp = |tr: f64, td: f64| -> Vec<f64> {
        let mut y: Vec<f64> = (0..n)
            .map(|i| (-(i as f64 * dt) / td).exp() - (-(i as f64 * dt) / tr).exp())
            .collect();
        let pk = y.iter().cloned().fold(0.0_f64, f64::max);
        if pk > 0.0 {
            y.iter_mut().for_each(|v| *v /= pk);
        }
        y
    };
    let (a, b) = (samp(r1, d1), samp(r2, d2));
    (a.iter().zip(&b).map(|(p, q)| (p - q).powi(2)).sum::<f64>() / n as f64).sqrt()
}

struct Sub {
    t0: usize,
    t1: usize,
    c0: usize,
    c1: usize,
}

/// Kernel loop of the app (seed phase, K subsets at 25% coverage, per-subset
/// free kernel + biexp fit, median merge, shape-RMSE convergence tol .005,
/// patience 3, min 2 iterations, max 30). Returns (final tau_r, tau_d,
/// iterations run, converged_at, trail).
#[allow(clippy::too_many_arguments)]
fn kernel_loop(
    traces: &[Vec<f32>],
    fs: f64,
    mfr: f64,
    relaxed: Relaxed,
    k: usize,
    seed: u64,
    threads: usize,
) -> (f64, f64, usize, Option<usize>, Vec<(f64, f64)>, f64) {
    let n_cells = traces.len();
    let t_len = traces[0].len();
    let scale = (0.25 / k as f64).sqrt();
    let t_sub = (t_len as f64 * scale) as usize;
    let n_sub = ((n_cells as f64 * scale) as usize).max(1);
    // Non-overlapping tiles, shuffled with the app's LCG.
    let cols = (t_len / t_sub).max(1);
    let rows = (n_cells / n_sub).max(1);
    let mut slots: Vec<usize> = (0..cols * rows).collect();
    let mut st = seed as u32;
    let mut rng = || {
        st = st.wrapping_mul(1664525).wrapping_add(1013904223);
        st as f64 / 4294967296.0
    };
    for i in (1..slots.len()).rev() {
        let j = (rng() * (i + 1) as f64) as usize;
        slots.swap(i, j);
    }
    let (tw, th) = (t_len / cols, n_cells / rows);
    let subs: Vec<Sub> = (0..k.min(slots.len()))
        .map(|q| {
            let (col, row) = (slots[q] % cols, slots[q] / cols);
            let ts = col * tw + (rng() * (tw.saturating_sub(t_sub) + 1) as f64) as usize;
            let cs = row * th + (rng() * (th.saturating_sub(n_sub) + 1) as f64) as usize;
            Sub {
                t0: ts,
                t1: ts + t_sub,
                c0: cs,
                c1: cs + n_sub,
            }
        })
        .collect();
    let par = |jobs: usize, f: &(dyn Fn(usize) + Sync)| {
        let next = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..threads {
                s.spawn(|| loop {
                    let j = next.fetch_add(1, Ordering::Relaxed);
                    if j >= jobs {
                        break;
                    }
                    f(j);
                });
            }
        });
    };
    // One kernel job per subset from per-cell (working trace, counts, alpha, baseline).
    type Cellres = Option<(Vec<f32>, Vec<f32>, f64, f64)>;
    let kernel_jobs = |res: &Vec<Vec<Cellres>>,
                       klen: usize|
     -> Vec<crate::biexp_fit::BiexpResult> {
        let out: std::sync::Mutex<Vec<(usize, crate::biexp_fit::BiexpResult)>> = Default::default();
        par(subs.len(), &|si| {
            let (mut tr, mut sp, mut lens, mut al, mut bl) =
                (vec![], vec![], vec![], vec![], vec![]);
            for (t, s, a, b) in res[si].iter().flatten() {
                if *a == 0.0 || s.iter().all(|&v| v == 0.0) {
                    continue;
                }
                tr.extend_from_slice(t);
                sp.extend_from_slice(s);
                lens.push(t.len());
                al.push(*a);
                bl.push(*b);
            }
            if lens.is_empty() {
                return;
            }
            let h = crate::kernel_est::estimate_free_kernel(
                &tr, &sp, &al, &bl, &lens, klen, 200, 1e-4, None, 0.0,
            );
            let fit = fit_biexponential(&h, fs, true, 0, None);
            out.lock().unwrap().push((si, fit));
        });
        let mut o = out.into_inner().unwrap();
        o.sort_by_key(|x| x.0);
        o.into_iter().map(|x| x.1).collect()
    };
    let merge = |fits: &[crate::biexp_fit::BiexpResult]| -> Option<(f64, f64)> {
        let good: Vec<_> = fits
            .iter()
            .filter(|f| f.fit_mode != FitMode::Degenerate && f.fit_mode != FitMode::Empty)
            .collect();
        let use_f: Vec<_> = if good.is_empty() {
            fits.iter().collect()
        } else {
            good
        };
        if use_f.is_empty() {
            return None;
        }
        let mut r: Vec<f64> = use_f.iter().map(|f| f.tau_rise).collect();
        let mut d: Vec<f64> = use_f.iter().map(|f| f.tau_decay).collect();
        Some((median(&mut r), median(&mut d)))
    };
    let t0 = Instant::now();
    // Seed phase: peak-seeded spikes on the raw crops.
    let mut seedres: Vec<Vec<Cellres>> = vec![];
    for sb in &subs {
        let mut v = vec![];
        for c in sb.c0..sb.c1 {
            let tr = traces[c][sb.t0..sb.t1].to_vec();
            let sr = crate::peak_seed::seed_trace(&tr, fs);
            v.push(Some((tr, sr.s_counts, sr.alpha, sr.baseline)));
        }
        seedres.push(v);
    }
    let seed_len = ((1.5 * fs).ceil() as usize).clamp(10, 200);
    let seed_fits = kernel_jobs(&seedres, seed_len);
    let (mut tau_r, mut tau_d) = merge(&seed_fits).unwrap_or((0.2, 1.0));
    let klen = |td: f64| ((5.0 * td * fs).ceil() as usize).max(10);
    let (mut prev_r, mut prev_d) = (tau_r, tau_d);
    let mut trail: Vec<(f64, f64)> = vec![];
    let (mut stable, mut first_stable, mut conv_at) = (0usize, None::<usize>, None);
    let mut iters = 0;
    for it in 0..30 {
        iters = it + 1;
        // Trace inference per subset cell.
        let jobs: Vec<(usize, usize)> = subs
            .iter()
            .enumerate()
            .flat_map(|(si, sb)| (sb.c0..sb.c1).map(move |c| (si, c)))
            .collect();
        let slots: Vec<std::sync::Mutex<Cellres>> =
            jobs.iter().map(|_| std::sync::Mutex::new(None)).collect();
        par(jobs.len(), &|j| {
            let (si, c) = jobs[j];
            let sb = &subs[si];
            let tr = &traces[c][sb.t0..sb.t1];
            let (r, _) = solve_trace_cfg(
                tr,
                tau_r,
                tau_d,
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
            *slots[j].lock().unwrap() =
                Some((r.filtered_trace.unwrap(), r.s_counts, r.alpha, r.baseline));
        });
        let mut res: Vec<Vec<Cellres>> = subs.iter().map(|_| vec![]).collect();
        for (j, (si, _)) in jobs.iter().enumerate() {
            res[*si].push(slots[j].lock().unwrap().take());
        }
        let fits = kernel_jobs(&res, klen(tau_d));
        let Some((nr, nd)) = merge(&fits) else { break };
        tau_r = nr;
        tau_d = nd;
        trail.push((tau_r, tau_d));
        let rmse = if tau_d > tau_r && tau_r > 0.0 {
            Some(shape_rmse(prev_r, prev_d, tau_r, tau_d, fs))
        } else {
            None
        };
        if rmse.is_some_and(|e| e < 0.005) && it + 1 >= 2 {
            if stable == 0 {
                first_stable = Some(it + 1);
            }
            stable += 1;
        } else {
            stable = 0;
            first_stable = None;
        }
        prev_r = tau_r;
        prev_d = tau_d;
        if stable >= 3 {
            conv_at = first_stable;
            break;
        }
    }
    // Final kernel: tail median (tau-space; the app uses (t_peak, FWHM) space).
    let tail: Vec<_> = trail.iter().rev().take(5).cloned().collect();
    let mut r: Vec<f64> = tail.iter().map(|t| t.0).collect();
    let mut d: Vec<f64> = tail.iter().map(|t| t.1).collect();
    let (fr, fd) = if tail.is_empty() {
        (tau_r, tau_d)
    } else {
        (median(&mut r), median(&mut d))
    };
    (fr, fd, iters, conv_at, trail, t0.elapsed().as_secs_f64())
}

#[test]
#[ignore]
fn eval_evf_kernel() {
    let list =
        |k: &str, d: &str| -> Vec<String> { env(k, d).split(',').map(String::from).collect() };
    let regimes = list("EK_REGIMES", "markov,markovlow");
    let want = list("EK_PRESETS", "jgcamp8f,gcamp6s");
    let fs: f64 = env("EK_FS", "30").parse().unwrap();
    let snr_list: Vec<f64> = list("EK_SNR", "12")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let ncells: usize = env("EK_CELLS", "100").parse().unwrap();
    let dur: f64 = env("EK_DUR", "600").parse().unwrap();
    let k: usize = env("EK_K", "4").parse().unwrap();
    let mfr: f64 = env("EK_MFR", "300").parse().unwrap();
    let seeds: Vec<u32> = list("EK_SEEDS", "1")
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
    let threads: usize = env(
        "EK_THREADS",
        &std::thread::available_parallelism()
            .unwrap()
            .get()
            .to_string(),
    )
    .parse()
    .unwrap();
    let out = env("EK_OUT", "evf_kernel.csv");
    let mut w = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    writeln!(
        w,
        "regime,preset,fs,snr,seed,method,mean_true_tau_r,mean_true_tau_d,tau_r,tau_d,iters,conv_at,wall_s,final_f1,final_count,true_count,final_pve,trail"
    )
    .unwrap();
    for regime in &regimes {
        for (pname, base) in presets::all() {
            if !want.iter().any(|x| x == pname) {
                continue;
            }
            for (&seed, &snr) in seeds
                .iter()
                .flat_map(|s| snr_list.iter().map(move |q| (s, q)))
            {
                let cells = make_cells(regime, &base, fs, seed, &[snr], ncells, dur);
                let mean_tr = cells.iter().map(|c| c.tau_r).sum::<f64>() / cells.len() as f64;
                let mean_td = cells.iter().map(|c| c.tau_d).sum::<f64>() / cells.len() as f64;
                let traces: Vec<Vec<f32>> = cells.iter().map(|c| c.trace.clone()).collect();
                for (mname, relaxed, mode) in [
                    ("shipped", Relaxed::Fista, 0u8),
                    ("ipm_old_pick", Relaxed::Ipm, 0),
                    ("ipm_new_pick", Relaxed::Ipm, 3),
                ] {
                    crate::event_mass::GLOBAL_MODE
                        .store(mode, std::sync::atomic::Ordering::Relaxed);
                    let (tr, td, iters, conv_at, trail, wall) =
                        kernel_loop(&traces, fs, mfr, relaxed, k, 42 + seed as u64, threads);
                    // Final pass over the whole dataset with the converged kernel.
                    let next = AtomicUsize::new(0);
                    let acc: std::sync::Mutex<(f64, f64, f64, f64)> = Default::default();
                    std::thread::scope(|s| {
                        for _ in 0..threads {
                            s.spawn(|| loop {
                                let ci = next.fetch_add(1, Ordering::Relaxed);
                                if ci >= cells.len() {
                                    break;
                                }
                                let c = &cells[ci];
                                let (r, _) = solve_trace_cfg(
                                    &c.trace,
                                    tr,
                                    td,
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
                                let mut a = acc.lock().unwrap();
                                a.0 += f1(&c.spikes, &r.s_counts, 2);
                                a.1 += r.s_counts.iter().sum::<f32>() as f64;
                                a.2 += c.spikes.iter().sum::<f32>() as f64;
                                a.3 += r.pve;
                            });
                        }
                    });
                    let a = acc.into_inner().unwrap();
                    let nc = cells.len() as f64;
                    let tl = trail
                        .iter()
                        .map(|(r, d)| format!("{:.4}/{:.4}", r, d))
                        .collect::<Vec<_>>()
                        .join(";");
                    let line = format!(
                        "{regime},{pname},{fs},{snr},{seed},{mname},{:.4},{:.4},{:.4},{:.4},{iters},{},{:.1},{:.4},{},{},{:.4},{tl}",
                        mean_tr,
                        mean_td,
                        tr,
                        td,
                        conv_at.map_or(-1, |v| v as i64),
                        wall,
                        a.0 / nc,
                        a.1,
                        a.2,
                        a.3 / nc
                    );
                    writeln!(w, "{line}").unwrap();
                    w.flush().unwrap();
                    println!("{line}");
                }
            }
        }
    }
}
