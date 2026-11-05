//! GPU-planning instrumentation for the CaDecon trace solve (test-only).
//!
//! A phase-timed copy of `solve_trace_native` under the shipped defaults
//! (native inner solve, certificate stop, chain scoring, chain budget,
//! noise-constrained selection), checked bit-for-bit against the shipped
//! path, plus the kernel-estimation and bi-exponential timings and the
//! f32-then-f64-polish precision prototype.
//!
//! Run (release, single thread per test):
//!
//! ```text
//! CALAB_NPY=.../synthetic_1000x54000.npy CALAB_OUT=.../out \
//!   cargo test --release --lib gpu_profile -- --ignored --nocapture --test-threads 1
//! ```
//!
//! Environment: `CALAB_NPY` (f32 C-order cells x time), `CALAB_OUT` (output
//! directory), `CALAB_CELLS`, `CALAB_TLEN` (subset geometry), `CALAB_THREADS`.
use super::*;
use crate::baseline::RollingQuantile;
use crate::threshold::{lstsq_alpha_baseline, threshold_grid};
use std::time::Instant;

/// Accumulated seconds per phase.
#[derive(Clone, Default, Debug)]
pub(crate) struct Phases {
    pub prep_upsample: f64,
    pub prep_filter: f64,
    pub prep_baseline: f64,
    pub prep_noise_model: f64,
    pub prep_chain_gain: f64,
    pub fista: f64,
    pub fista_iters: u64,
    pub fista_checks: u64,
    pub spread: f64,
    pub ts_binarize: f64,
    pub ts_convolve: f64,
    pub ts_filter: f64,
    pub ts_quantile: f64,
    pub ts_lstsq: f64,
    pub ts_candidates: u64,
    pub ts_levels: u64,
    /// Ones in the densest candidate (lowest level): the spike bins a
    /// superposition scorer would add.
    pub ts_max_ones: u64,
    pub final_refit: f64,
    pub traces: u64,
    pub samples_native: u64,
    pub total: f64,
}

impl Phases {
    pub(crate) fn add(&mut self, o: &Phases) {
        macro_rules! f {
            ($($x:ident),*) => { $( self.$x += o.$x; )* };
        }
        f!(
            prep_upsample,
            prep_filter,
            prep_baseline,
            prep_noise_model,
            prep_chain_gain,
            fista,
            fista_iters,
            fista_checks,
            spread,
            ts_binarize,
            ts_convolve,
            ts_filter,
            ts_quantile,
            ts_lstsq,
            ts_candidates,
            ts_levels,
            ts_max_ones,
            final_refit,
            traces,
            samples_native,
            total
        );
    }

    pub(crate) fn prep(&self) -> f64 {
        self.prep_upsample
            + self.prep_filter
            + self.prep_baseline
            + self.prep_noise_model
            + self.prep_chain_gain
    }

    pub(crate) fn threshold(&self) -> f64 {
        self.ts_binarize + self.ts_convolve + self.ts_filter + self.ts_quantile + self.ts_lstsq
    }

    pub(crate) fn report(&self, label: &str) -> String {
        let tot = self.total.max(1e-12);
        let row =
            |name: &str, s: f64| format!("  {name:<28} {s:10.3} s  {:6.2} %\n", 100.0 * s / tot);
        let mut out = format!(
            "{label}: {} traces, {} native samples, total {:.3} s ({:.2} ms/trace, {:.1} ns/native sample)\n",
            self.traces,
            self.samples_native,
            self.total,
            1e3 * self.total / self.traces.max(1) as f64,
            1e9 * self.total / self.samples_native.max(1) as f64
        );
        out += &row("prep: upsample (x3)", self.prep_upsample);
        out += &row("prep: bandpass FFT (x3+1)", self.prep_filter);
        out += &row("prep: rolling quantile (x2)", self.prep_baseline);
        out += &row("prep: noise model", self.prep_noise_model);
        out += &row("prep: chain gain misc", self.prep_chain_gain);
        out += &row("relaxed FISTA f64 + cert", self.fista);
        out += &row("spread + normalize", self.spread);
        out += &row("thresh: binarize (200)", self.ts_binarize);
        out += &row("thresh: AR2 convolve", self.ts_convolve);
        out += &row("thresh: bandpass FFT", self.ts_filter);
        out += &row("thresh: rolling quantile", self.ts_quantile);
        out += &row("thresh: lstsq + grid err", self.ts_lstsq);
        out += &row("final refit + downsample", self.final_refit);
        out += &format!(
            "  FISTA iters/trace {:.0}, cert checks/trace {:.1}; distinct candidates/trace {:.1} of {:.0} levels; ones in densest candidate {:.0} of {:.0} bins\n",
            self.fista_iters as f64 / self.traces.max(1) as f64,
            self.fista_checks as f64 / self.traces.max(1) as f64,
            self.ts_candidates as f64 / self.traces.max(1) as f64,
            self.ts_levels as f64 / self.traces.max(1) as f64,
            self.ts_max_ones as f64 / self.traces.max(1) as f64,
            10.0 * self.samples_native as f64 / self.traces.max(1) as f64
        );
        out += &format!(
            "  groups: prep {:.1} %, FISTA {:.1} %, threshold search {:.1} %, other {:.1} %\n",
            100.0 * self.prep() / tot,
            100.0 * self.fista / tot,
            100.0 * self.threshold() / tot,
            100.0 * (self.spread + self.final_refit) / tot
        );
        out
    }
}

fn t<R>(acc: &mut f64, f: impl FnOnce() -> R) -> R {
    let s = Instant::now();
    let r = f();
    *acc += s.elapsed().as_secs_f64();
    r
}

/// How the relaxed native-rate problem is solved.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Inner {
    /// The shipped f64 FISTA with the certificate.
    Shipped,
    /// GPU stand-in: f32 FISTA (`Solver::step_batch`, banded, Box01, the
    /// iteration the WebGPU kernel reproduces to ~1e-5 relL2) to the
    /// relative-step tolerance `tol` (or `iters` iterations), then, when
    /// `polish`, the shipped f64 solve warm-started from it until the
    /// certificate. `perturb` adds relative noise of that size to the f32
    /// result (models GPU-vs-WASM f32 reduction differences).
    F32 {
        tol: f64,
        iters: u32,
        polish: bool,
        perturb: f64,
    },
}

/// Per-trace outcome of the relaxed solve beyond `InDecaResult`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct InnerStats {
    pub f32_iters: u32,
    pub f64_iters: u32,
    pub certified: bool,
    pub objective: f64,
    pub std_error: f64,
}

/// `solve_trace_native` under the shipped defaults with
/// `noise_constrained = true`, timed by phase.
#[allow(clippy::too_many_arguments)]
pub(crate) fn solve_profiled(
    trace: &[f32],
    tau_r: f64,
    tau_d: f64,
    fs: f64,
    k: usize,
    inner: Inner,
    ph: &mut Phases,
) -> (InDecaResult, InnerStats) {
    let t_all = Instant::now();
    let (hp, lp) = (true, true);
    let fs_up = fs * k as f64;
    // ── prepare(), inlined with timers ──
    let mut filtered = t(&mut ph.prep_upsample, || upsample_trace(trace, k));
    let mut filter = Some(trace_filter(tau_r, tau_d, fs_up, hp, lp));
    let applied = t(&mut ph.prep_filter, || {
        filter.as_mut().unwrap().apply(&mut filtered)
    });
    if !applied {
        filter = None;
    }
    let bl_window = crate::baseline::baseline_window(tau_d, fs_up);
    let mut working = filtered.clone();
    t(&mut ph.prep_baseline, || {
        crate::baseline::subtract_rolling_baseline(
            &mut working,
            bl_window,
            crate::baseline::DEFAULT_BASELINE_QUANTILE,
        )
    });
    let pad_up = crate::threshold::boundary_padding(tau_d, fs_up).min(working.len() / 4);
    let noise = t(&mut ph.prep_noise_model, || {
        estimate_noise_model(trace, k, filter.as_mut())
    });
    // chain_noise_gain = 2 upsample + 2 bandpass + 1 rolling quantile + misc;
    // timed whole here and apportioned below from the measured unit costs.
    let gain = t(&mut ph.prep_chain_gain, || {
        chain_noise_gain(
            trace,
            &working,
            filter.as_mut(),
            k,
            bl_window,
            pad_up,
            high_band_sigma(trace),
        )
    });
    let noise = noise.with_chain_gain(gain);
    let noise_model_lin = (noise.grid.sigma > 0.0).then_some(noise.grid);
    let noise_model = noise_model_lin.map(|_| noise.grid_chain);

    // ── native solve ──
    let n_up = working.len();
    let (lo, hi) = native_grid(n_up, pad_up, k);
    let n = n_up / k;
    let y = recorded_samples(&working, k);
    let banded = BandedAR2::new(tau_r, tau_d, fs);
    let banded_up = BandedAR2::new(tau_r, tau_d, fs_up);
    let cap = max_spikes_per_frame(fs) as f64;
    let n_grid = hi - lo;
    let budget = noise_model.map_or(0.0, |nm| nm.budget(n_grid));
    let _ = budget;
    let std_error = noise_model.map_or(0.0, |nm| nm.std_error(n_grid));
    let alpha_est = estimate_alpha_interior(&y, lo);
    let mut conv = vec![0.0_f32; n];
    let scale = alpha_est * cap;
    let inv = (1.0 / scale) as f32;
    let scaled64: Vec<f64> = y.iter().map(|&v| (v * inv) as f64).collect();
    let stop = (std_error > 0.0).then(|| native_solve::Stop {
        se: std_error / (scale * scale),
        lo,
        hi,
        stride: 1,
    });
    let tol = if stop.is_some() { 0.0 } else { 1e-4 };
    let cap_iters = match stop {
        Some(st) => {
            let y2: f64 = scaled64[lo..hi].iter().map(|v| v * v).sum();
            let tau0 = (y2 + st.se).sqrt() - y2.sqrt();
            native_solve::iteration_cap(n, banded.lipschitz(), tau0).max(500)
        }
        None => 500,
    };
    let mut ist = InnerStats {
        std_error,
        ..Default::default()
    };
    let t_f = Instant::now();
    let x64: Vec<f64> = match inner {
        Inner::Shipped => {
            let nr = native_solve::solve_box(&scaled64, &banded, 0.0, cap_iters, tol, stop, None);
            ist.f64_iters = nr.iterations;
            ist.certified = nr.converged();
            nr.x
        }
        Inner::F32 {
            tol: ftol,
            iters,
            polish,
            perturb,
        } => {
            let yf: Vec<f32> = scaled64.iter().map(|&v| v as f32).collect();
            let mut s = Solver::new();
            s.set_conv_mode(ConvMode::BandedAR2);
            s.apply_params(tau_r, tau_d, 0.0, fs);
            s.set_constraint(Constraint::Box01);
            s.load_trace(&yf);
            s.filtered = true;
            s.tolerance = ftol;
            while s.iteration_count() < iters {
                let b = 50.min(iters - s.iteration_count());
                if matches!(s.step_batch(b), Ok(true) | Err(_)) {
                    break;
                }
            }
            ist.f32_iters = s.iteration_count();
            let mut xf: Vec<f64> = s.get_solution()[..n].iter().map(|&v| v as f64).collect();
            if perturb > 0.0 {
                let mut st: u64 = 0x1234_5678 ^ (n as u64);
                for v in xf.iter_mut() {
                    st = st
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    let u = ((st >> 11) as f64) / (1u64 << 53) as f64 * 2.0 - 1.0;
                    *v = (*v * (1.0 + perturb * u)).clamp(0.0, 1.0);
                }
            }
            if polish {
                let nr = native_solve::solve_box(
                    &scaled64,
                    &banded,
                    0.0,
                    cap_iters,
                    tol,
                    stop,
                    Some(&xf),
                );
                ist.f64_iters = nr.iterations;
                ist.certified = nr.converged();
                nr.x
            } else {
                xf
            }
        }
    };
    ph.fista += t_f.elapsed().as_secs_f64();
    ph.fista_iters += (ist.f32_iters + ist.f64_iters) as u64;
    ph.fista_checks += (ist.f64_iters / 50) as u64;
    let u: Vec<f32> = x64.iter().map(|&v| v as f32).collect();
    let x: Vec<f32> = u.iter().map(|&v| v * cap as f32).collect();
    banded.convolve_forward(&x, &mut conv);
    ist.objective = grid_energy(&y, &conv, alpha_est, lo, 1);

    // ── spread ──
    let s_normalized = t(&mut ph.spread, || {
        let mut s = spread(&x, k, Spread::Interp);
        let s_peak = interior_peak(&s, pad_up);
        if s_peak > 1e-10 {
            let inv_peak = 1.0 / s_peak;
            for v in s.iter_mut() {
                *v *= inv_peak;
            }
        }
        s
    });

    // ── threshold search (threshold_search_scored + Scorer::Chain), timed ──
    let selection = Selection::NoiseFloor;
    let nn = s_normalized.len();
    let pad = crate::threshold::boundary_padding(tau_d, fs_up).min(nn / 4);
    let stride = k;
    let mut rq = RollingQuantile::new();
    let mut s_bin = vec![0.0_f32; nn];
    let mut cbuf = vec![0.0_f32; nn];
    let yt = &working;
    let mut score = |s_bin: &[f32], cbuf: &mut [f32], ph: &mut Phases| -> (f64, f64, f64) {
        t(&mut ph.ts_convolve, || {
            banded_up.convolve_forward(s_bin, cbuf)
        });
        if let Some(f) = filter.as_mut() {
            t(&mut ph.ts_filter, || f.apply(cbuf));
        }
        t(&mut ph.ts_quantile, || {
            rq.subtract(cbuf, bl_window, crate::baseline::DEFAULT_BASELINE_QUANTILE)
        });
        t(&mut ph.ts_lstsq, || {
            let (alpha, baseline) = lstsq_alpha_baseline(cbuf, yt, pad, f64::INFINITY);
            let mut err = 0.0_f64;
            for i in (pad..nn.saturating_sub(pad)).step_by(stride) {
                let d = yt[i] as f64 - (alpha * cbuf[i] as f64 + baseline);
                err += d * d;
            }
            (err, alpha, baseline)
        })
    };
    let bin = |s: &[f32], thr: f64, out: &mut [f32]| -> usize {
        let th = thr as f32;
        let mut c = 0;
        for (o, &v) in out.iter_mut().zip(s) {
            let on = v >= th;
            c += on as usize;
            *o = if on { 1.0 } else { 0.0 };
        }
        c
    };
    let (s_binary, threshold) = if !s_normalized.iter().any(|&v| v > 1e-10) {
        (vec![0.0_f32; nn], 0.0)
    } else {
        let levels = threshold_grid(0.5 / stride as f64);
        let mut errors = vec![f64::INFINITY; levels.len()];
        let mut alphas = vec![0.0_f64; levels.len()];
        let mut counts = vec![0.0_f64; levels.len()];
        let mut last_count = usize::MAX;
        let mut last = (f64::INFINITY, 0.0_f64);
        for (i, &thr) in levels.iter().enumerate().rev() {
            let count = t(&mut ph.ts_binarize, || bin(&s_normalized, thr, &mut s_bin));
            ph.ts_levels += 1;
            if count != last_count {
                let (e, a, _) = score(&s_bin, &mut cbuf, ph);
                ph.ts_candidates += 1;
                last = (e, a);
                last_count = count;
            }
            errors[i] = last.0;
            alphas[i] = last.1;
            counts[i] = count as f64;
            if i == 0 {
                ph.ts_max_ones += count as u64;
            }
        }
        let n_grid_up = (pad..nn.saturating_sub(pad)).step_by(stride).count();
        let sel = crate::threshold::select_sparsest(
            &errors,
            &alphas,
            &counts,
            (0..levels.len()).rev(),
            selection,
            noise_model,
            n_grid_up,
        );
        let thr = levels[sel.index];
        bin(&s_normalized, thr, &mut s_bin);
        (s_bin.clone(), thr)
    };

    // ── final refit + downsample ──
    let (s_counts, alpha_out, baseline_out) = t(&mut ph.final_refit, || {
        let s_counts = downsample_binary(&s_binary, k);
        let mut cv = vec![0.0_f32; n_up];
        banded_up.convolve_forward(&s_binary, &mut cv);
        let (a, b) = lstsq_alpha_baseline(&cv, &working, pad_up, f64::INFINITY);
        (s_counts, a, b)
    });
    ph.traces += 1;
    ph.samples_native += trace.len() as u64;
    ph.total += t_all.elapsed().as_secs_f64();
    (
        InDecaResult {
            s_counts,
            filtered_trace: None,
            alpha: alpha_out,
            baseline: baseline_out,
            threshold,
            pve: 0.0,
            iterations: ist.f32_iters + ist.f64_iters,
            converged: ist.certified,
            loop_converged: true,
            noise_var_processed: noise.processed_var(),
            chain_noise_gain: noise.chain_gain,
        },
        ist,
    )
}

// ───────────────────────── data helpers ─────────────────────────

/// Load a little-endian f32 C-order 2-D `.npy` (cells x time).
pub(crate) fn load_npy(path: &str) -> (Vec<f32>, usize, usize) {
    let bytes = std::fs::read(path).expect("read npy");
    assert_eq!(&bytes[..6], b"\x93NUMPY");
    let hlen = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let header = std::str::from_utf8(&bytes[10..10 + hlen]).unwrap();
    assert!(header.contains("'<f4'") && header.contains("'fortran_order': False"));
    let shape = header.split("'shape': (").nth(1).unwrap();
    let dims: Vec<usize> = shape
        .split(')')
        .next()
        .unwrap()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let data: Vec<f32> = bytes[10 + hlen..]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(data.len(), dims[0] * dims[1]);
    (data, dims[0], dims[1])
}

fn env_or<T: std::str::FromStr>(key: &str, d: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn out_dir() -> String {
    let d = std::env::var("CALAB_OUT").unwrap_or_else(|_| "/tmp".into());
    std::fs::create_dir_all(&d).ok();
    d
}

/// Run `jobs` (cell, t0, t1) over `threads` OS threads, each with its own
/// `Phases`; returns (wall seconds, merged phases, per-job results).
fn run_pool(
    data: &[f32],
    t_total: usize,
    jobs: &[(usize, usize, usize)],
    tau: (f64, f64),
    fs: f64,
    k: usize,
    threads: usize,
) -> (f64, Phases, Vec<InDecaResult>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    let merged = Mutex::new(Phases::default());
    let results: Mutex<Vec<Option<InDecaResult>>> =
        Mutex::new((0..jobs.len()).map(|_| None).collect());
    let t0 = Instant::now();
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                let mut ph = Phases::default();
                loop {
                    let j = next.fetch_add(1, Ordering::Relaxed);
                    if j >= jobs.len() {
                        break;
                    }
                    let (c, a, b) = jobs[j];
                    let tr = &data[c * t_total + a..c * t_total + b];
                    let (r, _) = solve_profiled(tr, tau.0, tau.1, fs, k, Inner::Shipped, &mut ph);
                    results.lock().unwrap()[j] = Some(r);
                }
                merged.lock().unwrap().add(&ph);
            });
        }
    });
    let wall = t0.elapsed().as_secs_f64();
    let res = results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|r| r.unwrap())
        .collect();
    (wall, merged.into_inner().unwrap(), res)
}

/// Unit costs of the chain stages on one vector of length `n_up`.
fn unit_costs(n_up: usize, tau: (f64, f64), fs_up: f64) -> String {
    let mut v: Vec<f32> = (0..n_up)
        .map(|i| ((i * 7919) % 1000) as f32 * 1e-3)
        .collect();
    let mut f = trace_filter(tau.0, tau.1, fs_up, true, true);
    f.apply(&mut v);
    let reps = 20;
    let s = Instant::now();
    for _ in 0..reps {
        f.apply(&mut v);
    }
    let filt = s.elapsed().as_secs_f64() / reps as f64;
    let w = crate::baseline::baseline_window(tau.1, fs_up);
    let mut rq = RollingQuantile::new();
    let s = Instant::now();
    for _ in 0..reps {
        rq.subtract(&mut v, w, 0.2);
    }
    let q = s.elapsed().as_secs_f64() / reps as f64;
    let b = BandedAR2::new(tau.0, tau.1, fs_up);
    let mut out = vec![0.0_f32; n_up];
    let s = Instant::now();
    for _ in 0..reps {
        b.convolve_forward(&v, &mut out);
    }
    let c = s.elapsed().as_secs_f64() / reps as f64;
    format!(
        "unit costs at n_up={n_up}: bandpass {:.3} ms, rolling quantile (w={w}) {:.3} ms, AR2 convolve {:.3} ms\n",
        filt * 1e3,
        q * 1e3,
        c * 1e3
    )
}

// ───────────────────────── tests ─────────────────────────

/// The instrumented copy reproduces the shipped `solve_trace_opts` exactly.
#[test]
fn profiled_copy_matches_shipped() {
    let cfg = SimulationConfig {
        num_cells: 4,
        num_timepoints: 3000,
        ..crate::simulate::presets::gcamp6f()
    };
    let sim = crate::simulate::simulate(&cfg);
    for c in 0..4 {
        let tr = &sim.traces[c * 3000..(c + 1) * 3000];
        let a = solve_trace_opts(
            tr,
            0.1,
            0.6,
            30.0,
            10,
            500,
            1e-4,
            None,
            true,
            true,
            0.0,
            SolveOptions {
                noise_constrained: true,
            },
        );
        let mut ph = Phases::default();
        let (b, _) = solve_profiled(tr, 0.1, 0.6, 30.0, 10, Inner::Shipped, &mut ph);
        assert_eq!(a.s_counts, b.s_counts, "cell {c}");
        assert_eq!(a.threshold, b.threshold);
        assert_eq!(a.alpha, b.alpha);
        assert_eq!(a.iterations, b.iterations);
    }
}

use crate::simulate::SimulationConfig;

/// Phase profile on the synthetic dataset: one CaDecon iteration's trace jobs
/// at 25 % coverage (subset geometry from subset-store.ts with K = 8), a
/// sample of full-length finalization traces, and unit costs.
#[test]
#[ignore]
fn profile_cadecon_iteration() {
    let path = std::env::var("CALAB_NPY").expect("CALAB_NPY");
    let (data, n_cells, t_total) = load_npy(&path);
    let fs = 30.0;
    let k = 10;
    let tau = (env_or("CALAB_TAU_R", 0.1), env_or("CALAB_TAU_D", 0.6));
    let threads = env_or("CALAB_THREADS", 8usize);
    let n_subsets = env_or("CALAB_SUBSETS", 8usize);
    let coverage: f64 = env_or("CALAB_COVERAGE", 0.25);
    let scale = (coverage / n_subsets as f64).sqrt();
    let t_sub = ((t_total as f64 * scale).floor() as usize).max(1);
    let n_sub = ((n_cells as f64 * scale).floor() as usize).max(1);
    // Even, non-overlapping subset placement (cells and time stride).
    let mut jobs = vec![];
    let cols = (t_total / t_sub).max(1);
    let rows = (n_cells / n_sub).max(1);
    for s in 0..n_subsets {
        let col = (s * 3) % cols;
        let row = s % rows;
        let t0 = col * (t_total / cols);
        let c0 = row * (n_cells / rows);
        for c in c0..c0 + n_sub {
            jobs.push((c, t0, (t0 + t_sub).min(t_total)));
        }
    }
    let mut report = format!(
        "dataset {path}: {n_cells} cells x {t_total} samples, fs {fs}, k {k}, tau {tau:?}\n\
         subsets: K={n_subsets}, {n_sub} cells x {t_sub} samples each, {} trace jobs, coverage {:.3}\n\
         threads {threads}\n",
        jobs.len(),
        (jobs.len() * t_sub) as f64 / (n_cells * t_total) as f64
    );
    report += &unit_costs(t_sub * k, tau, fs * k as f64);
    report += &unit_costs(t_total * k, tau, fs * k as f64);
    let (wall, ph, res) = run_pool(&data, t_total, &jobs, tau, fs, k, threads);
    report += &format!(
        "\n== subset trace jobs (one iteration): wall {wall:.2} s on {threads} threads ==\n"
    );
    report += &ph.report("subset jobs");

    // Kernel estimation + biexp per subset, as the kernel job does.
    let mut t_kernel = 0.0;
    let mut t_biexp = 0.0;
    let kernel_length = ((5.0 * tau.1 * fs).ceil() as usize).max(10);
    for s in 0..n_subsets {
        let js: Vec<usize> = (0..jobs.len()).filter(|&j| j / n_sub == s).collect();
        let mut tr = vec![];
        let mut sp = vec![];
        let mut lens = vec![];
        let mut al = vec![];
        let mut bl = vec![];
        for &j in &js {
            let (c, a, b) = jobs[j];
            let r = &res[j];
            if r.alpha == 0.0 || r.s_counts.iter().all(|&v| v == 0.0) {
                continue;
            }
            // Working trace at native rate (the kernel job uses the filtered trace).
            let raw = &data[c * t_total + a..c * t_total + b];
            let full = solve_trace_opts(
                raw,
                tau.0,
                tau.1,
                fs,
                k,
                500,
                1e-4,
                None,
                true,
                true,
                0.0,
                SolveOptions {
                    noise_constrained: true,
                },
            );
            let ft = full.filtered_trace.unwrap();
            tr.extend_from_slice(&ft);
            sp.extend_from_slice(&r.s_counts);
            lens.push(ft.len());
            al.push(r.alpha);
            bl.push(r.baseline);
        }
        let s0 = Instant::now();
        let h = crate::kernel_est::estimate_free_kernel(
            &tr,
            &sp,
            &al,
            &bl,
            &lens,
            kernel_length,
            200,
            1e-4,
            None,
            0.0,
        );
        t_kernel += s0.elapsed().as_secs_f64();
        let s0 = Instant::now();
        let _ = crate::biexp_fit::fit_biexponential(&h, fs, true, 0, None);
        t_biexp += s0.elapsed().as_secs_f64();
        if s == 0 {
            report += &format!(
                "subset 0 kernel input: {} traces, {} samples, kernel_length {kernel_length}\n",
                lens.len(),
                tr.len()
            );
        }
    }
    report += &format!(
        "kernel estimation (Gram + FISTA), all {n_subsets} subsets serial: {:.3} s; biexp fit: {:.3} s\n",
        t_kernel, t_biexp
    );

    // Finalization sample: full-length traces.
    let n_fin = env_or("CALAB_FIN_CELLS", 32usize);
    let fin_jobs: Vec<(usize, usize, usize)> = (0..n_fin)
        .map(|i| ((i * n_cells) / n_fin, 0, t_total))
        .collect();
    let (wall_f, ph_f, _) = run_pool(&data, t_total, &fin_jobs, tau, fs, k, threads);
    report += &format!(
        "\n== finalization sample: {n_fin} full-length traces, wall {wall_f:.2} s on {threads} threads (x{:.1} for all {n_cells}) ==\n",
        n_cells as f64 / n_fin as f64
    );
    report += &ph_f.report("finalization sample");
    println!("{report}");
    let tag = std::env::var("CALAB_TAG").unwrap_or_else(|_| "profile".into());
    std::fs::write(format!("{}/{tag}.txt", out_dir()), &report).unwrap();
}

// ───────────────────── precision prototype ─────────────────────

/// F1 of count-level matching within `tol` frames (as in the indeca tests).
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

#[derive(Clone, Default)]
struct VariantAgg {
    f1: f64,
    count: f64,
    same_counts: usize,
    same_threshold: usize,
    certified: usize,
    f32_iters: u64,
    f64_iters: u64,
    obj_dev_se: f64,
    obj_dev_se_max: f64,
    count_dev_max: f64,
    secs: f64,
    cells: usize,
}

/// f32 GPU-style relaxed solve followed by a short f64 polish to the
/// certificate, against the shipped f64 solve, on simulated presets with
/// ground truth. Also a phase profile per preset (slow kernels shift the
/// balance toward FISTA).
#[test]
#[ignore]
fn precision_f32_then_polish() {
    use crate::simulate::presets;
    let n_cells = env_or("CALAB_SIM_CELLS", 16usize);
    let minutes: f64 = env_or("CALAB_SIM_MIN", 5.0);
    let threads = env_or("CALAB_THREADS", 8usize);
    let rates: Vec<f64> = std::env::var("CALAB_SIM_FS")
        .unwrap_or_else(|_| "30,60".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    let variants: Vec<(&str, Option<Inner>, f64)> = vec![
        ("shipped f64+cert", Some(Inner::Shipped), 0.0),
        ("input perturbed 1e-6 (floor)", Some(Inner::Shipped), 1e-6),
        (
            "f32 tol1e-4 -> f64 polish",
            Some(Inner::F32 {
                tol: 1e-4,
                iters: 100_000,
                polish: true,
                perturb: 0.0,
            }),
            0.0,
        ),
        (
            "f32 tol1e-4 +6e-4 jitter -> polish",
            Some(Inner::F32 {
                tol: 1e-4,
                iters: 100_000,
                polish: true,
                perturb: 6e-4,
            }),
            0.0,
        ),
        (
            "f32 tol1e-5 -> f64 polish",
            Some(Inner::F32 {
                tol: 1e-5,
                iters: 100_000,
                polish: true,
                perturb: 0.0,
            }),
            0.0,
        ),
        (
            "f32 tol1e-4 only (no polish)",
            Some(Inner::F32 {
                tol: 1e-4,
                iters: 100_000,
                polish: false,
                perturb: 0.0,
            }),
            0.0,
        ),
        (
            "f32 tol1e-6 only (no polish)",
            Some(Inner::F32 {
                tol: 1e-6,
                iters: 100_000,
                polish: false,
                perturb: 0.0,
            }),
            0.0,
        ),
    ];
    let mut report = format!(
        "precision prototype: {n_cells} cells x {minutes} min per preset, rates {rates:?}, measured-SNR presets (Markov bursts)\n\
         'same counts' = s_counts bit-identical to the shipped result; obj dev = |relaxed objective - shipped| / SE\n\n"
    );
    let mut csv = String::from(
        "preset,fs,variant,f1,count_ratio,same_counts,same_threshold,certified,cells,f32_iters,f64_iters,obj_dev_se_mean,obj_dev_se_max,count_dev_max,secs\n",
    );
    for &fs in &rates {
        for (name, base) in presets::all() {
            if name == "clean" {
                continue;
            }
            let cfg = SimulationConfig {
                fs_hz: fs,
                num_cells: n_cells,
                num_timepoints: (minutes * 60.0 * fs) as usize,
                ..base
            };
            let sim = crate::simulate::simulate(&cfg);
            let t_len = cfg.num_timepoints;
            let k = (300.0 / fs).round() as usize;
            let (tr, td) = (cfg.kernel.tau_rise_s, cfg.kernel.tau_decay_s);
            // Shipped results (reference) + phase profile.
            let mut refs: Vec<Option<(Vec<f32>, f64, InnerStats)>> = vec![None; n_cells];
            let mut aggs = vec![VariantAgg::default(); variants.len()];
            let mut prof = Phases::default();
            for (vi, (_vname, inner, input_pert)) in variants.iter().enumerate() {
                use std::sync::atomic::{AtomicUsize, Ordering};
                use std::sync::Mutex;
                let next = AtomicUsize::new(0);
                let out: Mutex<Vec<Option<(InDecaResult, InnerStats, f64)>>> =
                    Mutex::new((0..n_cells).map(|_| None).collect());
                let ph_all = Mutex::new(Phases::default());
                std::thread::scope(|s| {
                    for _ in 0..threads {
                        s.spawn(|| {
                            let mut ph = Phases::default();
                            loop {
                                let c = next.fetch_add(1, Ordering::Relaxed);
                                if c >= n_cells {
                                    break;
                                }
                                let mut trace = sim.traces[c * t_len..(c + 1) * t_len].to_vec();
                                if *input_pert > 0.0 {
                                    let mut st: u64 = 99 + c as u64;
                                    for v in trace.iter_mut() {
                                        st = st
                                            .wrapping_mul(6364136223846793005)
                                            .wrapping_add(1442695040888963407);
                                        let u =
                                            ((st >> 11) as f64) / (1u64 << 53) as f64 * 2.0 - 1.0;
                                        *v = (*v as f64 * (1.0 + input_pert * u)) as f32;
                                    }
                                }
                                let s0 = Instant::now();
                                let (r, ist) =
                                    solve_profiled(&trace, tr, td, fs, k, inner.unwrap(), &mut ph);
                                let secs = s0.elapsed().as_secs_f64();
                                out.lock().unwrap()[c] = Some((r, ist, secs));
                            }
                            ph_all.lock().unwrap().add(&ph);
                        });
                    }
                });
                if vi == 0 {
                    prof = ph_all.into_inner().unwrap();
                }
                let out = out.into_inner().unwrap();
                let a = &mut aggs[vi];
                for (c, o) in out.into_iter().enumerate() {
                    let (r, ist, secs) = o.unwrap();
                    if vi == 0 {
                        refs[c] = Some((r.s_counts.clone(), r.threshold, ist));
                    }
                    let (rcounts, rthr, rist) = refs[c].as_ref().unwrap();
                    let truth = &sim.ground_truth[c].spikes;
                    a.f1 += timing_f1(truth, &r.s_counts, 2);
                    a.count += r.s_counts.iter().map(|&v| v as f64).sum::<f64>();
                    a.same_counts += (&r.s_counts == rcounts) as usize;
                    a.same_threshold += (r.threshold == *rthr) as usize;
                    a.certified += ist.certified as usize;
                    a.f32_iters += ist.f32_iters as u64;
                    a.f64_iters += ist.f64_iters as u64;
                    let dev = if rist.std_error > 0.0 {
                        (ist.objective - rist.objective).abs() / rist.std_error
                    } else {
                        0.0
                    };
                    a.obj_dev_se += dev;
                    a.obj_dev_se_max = a.obj_dev_se_max.max(dev);
                    let rc: f64 = rcounts.iter().map(|&v| v as f64).sum();
                    let cc: f64 = r.s_counts.iter().map(|&v| v as f64).sum();
                    a.count_dev_max =
                        a.count_dev_max
                            .max(if rc > 0.0 { (cc / rc - 1.0).abs() } else { 0.0 });
                    a.secs += secs;
                    a.cells += 1;
                }
            }
            report += &format!("── {name} @ {fs} Hz (k={k}, tau {tr}/{td}) ──\n");
            report += &format!(
                "  profile (shipped): FISTA {:.1} %, threshold search {:.1} % (FFT {:.1}, RQ {:.1}), prep {:.1} %; {:.0} f64 iters/trace, {:.0} candidates/trace, {:.1} ms/trace\n",
                100.0 * prof.fista / prof.total,
                100.0 * prof.threshold() / prof.total,
                100.0 * prof.ts_filter / prof.total,
                100.0 * prof.ts_quantile / prof.total,
                100.0 * prof.prep() / prof.total,
                prof.fista_iters as f64 / prof.traces as f64,
                prof.ts_candidates as f64 / prof.traces as f64,
                1e3 * prof.total / prof.traces as f64,
            );
            let c0 = aggs[0].count;
            for (vi, (vname, _, _)) in variants.iter().enumerate() {
                let a = &aggs[vi];
                let n = a.cells as f64;
                report += &format!(
                    "  {vname:<36} F1 {:.4}  count {:.4}x  same-counts {:>2}/{}  same-thr {:>2}/{}  cert {:>2}/{}  iters f32 {:>6.0} f64 {:>6.0}  objdev/SE mean {:.3} max {:.3}  max|count dev| {:.3}\n",
                    a.f1 / n,
                    a.count / c0.max(1e-30),
                    a.same_counts, a.cells, a.same_threshold, a.cells, a.certified, a.cells,
                    a.f32_iters as f64 / n, a.f64_iters as f64 / n,
                    a.obj_dev_se / n, a.obj_dev_se_max, a.count_dev_max
                );
                csv += &format!(
                    "{name},{fs},{vname},{:.5},{:.5},{},{},{},{},{:.1},{:.1},{:.4},{:.4},{:.4},{:.3}\n",
                    a.f1 / n, a.count / c0.max(1e-30), a.same_counts, a.same_threshold, a.certified, a.cells,
                    a.f32_iters as f64 / n, a.f64_iters as f64 / n, a.obj_dev_se / n, a.obj_dev_se_max, a.count_dev_max, a.secs
                );
            }
            println!("{report}");
        }
    }
    let d = out_dir();
    std::fs::write(format!("{d}/precision.txt"), &report).unwrap();
    std::fs::write(format!("{d}/precision.csv"), &csv).unwrap();
}

/// Native single-thread counterpart of `gpu-bench/wasm_bench.mjs single`:
/// the same traces through the shipped entry point.
#[test]
#[ignore]
fn single_thread_timing() {
    let path = std::env::var("CALAB_NPY").expect("CALAB_NPY");
    let (data, _n_cells, t_total) = load_npy(&path);
    let t_sub = (t_total as f64 * (0.25f64 / 8.0).sqrt()).floor() as usize;
    for (label, len, n) in [("subset", t_sub, 16usize), ("full", t_total, 2)] {
        let s = Instant::now();
        let mut iters = 0u64;
        for c in 0..n {
            let tr = &data[c * t_total..c * t_total + len];
            let r = solve_trace_opts(
                tr,
                0.1,
                0.6,
                30.0,
                10,
                500,
                1e-4,
                None,
                true,
                true,
                0.0,
                SolveOptions {
                    noise_constrained: true,
                },
            );
            iters += r.iterations as u64;
        }
        println!(
            "native single {label}: len {len}, {:.1} ms/trace, {:.0} iters/trace",
            1e3 * s.elapsed().as_secs_f64() / n as f64,
            iters as f64 / n as f64
        );
    }
}

/// Dump real chain-scoring rows (candidate reconstructions after the bandpass,
/// before the rolling quantile) for the GPU rolling-quantile microbenchmark
/// (`gpu-bench/rq-bench`): per row the f32 values, the dense ranks, the sorted
/// keys and the CPU `RollingQuantile` baselines.
///
/// File layout (little endian): u32 rows, u32 n, u32 window, f32 quantile,
/// then per row: f32 values[n], u32 rank[n], u32 sorted_key[n], f32 baseline[n].
#[test]
#[ignore]
fn dump_rq_rows() {
    let path = std::env::var("CALAB_NPY").expect("CALAB_NPY");
    let (data, n_cells, t_total) = load_npy(&path);
    let (fs, k, tau) = (30.0, 10usize, (0.1, 0.6));
    let t_sub = (t_total as f64 * (0.25f64 / 8.0).sqrt()).floor() as usize;
    let fs_up = fs * k as f64;
    let n = t_sub * k;
    let window = crate::baseline::baseline_window(tau.1, fs_up);
    let rows_wanted = env_or("CALAB_RQ_ROWS", 16usize);
    let mut out: Vec<u8> = vec![];
    let push_u32 = |o: &mut Vec<u8>, v: u32| o.extend_from_slice(&v.to_le_bytes());
    push_u32(&mut out, rows_wanted as u32);
    push_u32(&mut out, n as u32);
    push_u32(&mut out, window as u32);
    out.extend_from_slice(&0.2f32.to_le_bytes());
    let banded_up = BandedAR2::new(tau.0, tau.1, fs_up);
    let mut rq = RollingQuantile::new();
    let mut rows = 0;
    let mut c = 0;
    while rows < rows_wanted && c < n_cells {
        let tr = &data[c * t_total..c * t_total + t_sub];
        c += 37;
        if !tr.iter().all(|v| v.is_finite()) {
            continue;
        }
        let mut filt = trace_filter(tau.0, tau.1, fs_up, true, true);
        // Candidate-like rows: binary trains (the trace thresholded at four
        // levels) through K and the bandpass, i.e. what the chain scorer hands
        // the rolling quantile.
        let up = upsample_trace(tr, k);
        let mx = up.iter().cloned().fold(f32::MIN, f32::max);
        let mn = up.iter().cloned().fold(f32::MAX, f32::min);
        for lvl in [0.5f32, 0.6, 0.7, 0.8] {
            if rows >= rows_wanted {
                break;
            }
            let thr = mn + lvl * (mx - mn);
            let s: Vec<f32> = up
                .iter()
                .map(|&v| if v >= thr { 1.0 } else { 0.0 })
                .collect();
            let mut v = vec![0.0f32; n];
            banded_up.convolve_forward(&s, &mut v);
            filt.apply(&mut v);
            let keys: Vec<u32> = v
                .iter()
                .map(|&x| {
                    let b = x.to_bits();
                    if b & 0x8000_0000 != 0 {
                        !b
                    } else {
                        b | 0x8000_0000
                    }
                })
                .collect();
            let mut idx: Vec<u32> = (0..n as u32).collect();
            idx.sort_by_key(|&i| keys[i as usize]); // stable: ties by index
            let mut rank = vec![0u32; n];
            for (r, &i) in idx.iter().enumerate() {
                rank[i as usize] = r as u32;
            }
            let sorted_key: Vec<u32> = idx.iter().map(|&i| keys[i as usize]).collect();
            let base = rq.baselines(&v, window, 0.2).to_vec();
            for x in &v {
                out.extend_from_slice(&x.to_le_bytes());
            }
            for x in &rank {
                out.extend_from_slice(&x.to_le_bytes());
            }
            for x in &sorted_key {
                out.extend_from_slice(&x.to_le_bytes());
            }
            for x in &base {
                out.extend_from_slice(&x.to_le_bytes());
            }
            rows += 1;
        }
    }
    let f = format!("{}/rq_rows.bin", out_dir());
    std::fs::write(&f, &out).unwrap();
    println!("wrote {rows} rows of n={n}, window={window} to {f}");
}
