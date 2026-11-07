//! Preprocessing against minisim ground truth (tests/fixtures/preprocess_small,
//! see its README): hot pixels, flattening, background, noise, replay.

// Image statistics written as index loops over pixels read more plainly than
// zipped iterators here.
#![allow(clippy::needless_range_loop)]

use std::path::PathBuf;

use calab_cala::preprocess::background::{BackgroundConfig, RunningMinBackground};
use calab_cala::preprocess::flatten::{FlattenConfig, GlowFlattener};
use calab_cala::preprocess::flicker::{FlickerConfig, FlickerMode};
use calab_cala::preprocess::gaussian::RecursiveGaussian;
use calab_cala::preprocess::hot_pixels::{FLAG_HOT, FLAG_OK, FLAG_STUCK};
use calab_cala::preprocess::lines::LineMode;
use calab_cala::preprocess::noise::{NoiseConfig, NoiseEstimator};
use calab_cala::preprocess::warmup::WarmupAccumulator;
use calab_cala::preprocess::{Calibration, Dims, PreprocessConfig, PreprocessState, Preprocessor};

// ---------------------------------------------------------------- .npy reader

struct Npy {
    shape: Vec<usize>,
    descr: String,
    data: Vec<u8>,
}

impl Npy {
    fn load(name: &str) -> Npy {
        let path: PathBuf = [
            env!("CARGO_MANIFEST_DIR"),
            "tests",
            "fixtures",
            "preprocess_small",
            name,
        ]
        .iter()
        .collect();
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        assert_eq!(&bytes[..6], b"\x93NUMPY");
        let (hlen, start) = if bytes[6] == 1 {
            (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10)
        } else {
            (
                u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
                12,
            )
        };
        let header = std::str::from_utf8(&bytes[start..start + hlen]).unwrap();
        assert!(header.contains("'fortran_order': False"), "{header}");
        let descr = header
            .split("'descr': '")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap()
            .to_string();
        let shape_txt = header
            .split("'shape': (")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap();
        let shape = shape_txt
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().parse().unwrap())
            .collect();
        Npy {
            shape,
            descr,
            data: bytes[start + hlen..].to_vec(),
        }
    }

    fn u8(&self) -> Vec<u8> {
        assert_eq!(self.descr, "|u1");
        self.data.clone()
    }

    fn f32(&self) -> Vec<f32> {
        assert_eq!(self.descr, "<f4");
        let (words, _) = self.data.as_chunks::<4>();
        words.iter().map(|&c| f32::from_le_bytes(c)).collect()
    }

    fn u16(&self) -> Vec<u16> {
        assert_eq!(self.descr, "<u2");
        let (words, _) = self.data.as_chunks::<2>();
        words.iter().map(|&c| u16::from_le_bytes(c)).collect()
    }
}

struct Fixture {
    dims: Dims,
    frames: Vec<Vec<u8>>,
}

fn fixture() -> Fixture {
    let m = Npy::load("movie_u8.npy");
    let (t, h, w) = (m.shape[0], m.shape[1], m.shape[2]);
    let data = m.u8();
    Fixture {
        dims: Dims::new(w, h).unwrap(),
        frames: data
            .chunks_exact(w * h)
            .map(|c| c.to_vec())
            .take(t)
            .collect(),
    }
}

fn calibrate(fx: &Fixture, cfg: &PreprocessConfig) -> Calibration {
    let mut acc = WarmupAccumulator::new(fx.dims);
    for f in fx.frames.iter().take(cfg.warmup_frames) {
        acc.push(f).unwrap();
    }
    Calibration::from_warmup(&acc, cfg).unwrap()
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

// ---------------------------------------------------------------- tests

/// Precision / recall of the defect map against minisim's hot and stuck masks.
fn score_defects(fx: &Fixture, k_sigma: f32) -> (Calibration, usize, usize, usize) {
    let mut cfg = PreprocessConfig::default();
    cfg.hot.k_sigma = k_sigma;
    let cal = calibrate(fx, &cfg);
    let hot_gt = Npy::load("hot_pixel_mask.npy").u8();
    let stuck_gt = Npy::load("stuck_pixel_mask.npy").u8();
    let flags = cal.hot_pixels().flags();
    let (mut tp, mut fp, mut fn_) = (0, 0, 0);
    for i in 0..flags.len() {
        let truth = hot_gt[i] != 0 || stuck_gt[i] != 0;
        let found = flags[i] != FLAG_OK;
        match (truth, found) {
            (true, true) => tp += 1,
            (false, true) => fp += 1,
            (true, false) => fn_ += 1,
            _ => {}
        }
    }
    (cal, tp, fp, fn_)
}

#[test]
fn hot_pixel_precision_and_recall() {
    let fx = fixture();
    for k in [4.0f32, 6.0, 7.0] {
        let (_, tp, fp, fn_) = score_defects(&fx, k);
        eprintln!("hot pixels k = {k}: tp {tp} fp {fp} fn {fn_}");
    }
    let k = PreprocessConfig::default().hot.k_sigma;
    let (cal, tp, fp, fn_) = score_defects(&fx, k);
    let precision = tp as f32 / (tp + fp).max(1) as f32;
    let recall = tp as f32 / (tp + fn_).max(1) as f32;
    let flags = cal.hot_pixels().flags();
    // Stuck pixels inside the FOV must be flagged as stuck (not just hot).
    let stuck_gt = Npy::load("stuck_pixel_mask.npy").u8();
    let stuck_in_fov = (0..flags.len())
        .filter(|&i| stuck_gt[i] != 0 && cal.fov().contains(i))
        .count();
    let stuck_found = (0..flags.len())
        .filter(|&i| stuck_gt[i] != 0 && cal.fov().contains(i) && flags[i] == FLAG_STUCK)
        .count();
    eprintln!(
        "hot pixels k = {k} (default): tp {tp} fp {fp} fn {fn_} precision {precision:.3} \
         recall {recall:.3} (flagged hot {}, stuck {stuck_found}/{stuck_in_fov} in FOV), \
         global sigma_r {:.3}, FOV area {}",
        cal.hot_pixels().count(FLAG_HOT),
        cal.hot_pixels().sigma(),
        cal.fov().area()
    );
    assert!(precision >= 0.8, "precision {precision}");
    assert!(recall >= 0.75, "recall {recall}");
    assert!(stuck_in_fov > 0 && stuck_found == stuck_in_fov);
}

/// Flattening metrics at one σ: (glow LF std, leftover LF std, removed-vs-truth
/// R², per-cell contrast ratios after/before).
fn flatten_metrics(fx: &Fixture, sigma: f32) -> (f32, f32, f64, Vec<f32>) {
    let cfg = PreprocessConfig {
        flatten: FlattenConfig {
            sigma_px: Some(sigma),
            ..FlattenConfig::default()
        },
        ..PreprocessConfig::default()
    };
    let cal = calibrate(fx, &cfg);
    let dims = fx.dims;
    let n = dims.pixels();
    let fov = cal.fov();
    // Mean image, raw (hot pixels fixed) and flattened.
    let mut raw_mean = vec![0.0f64; n];
    let mut flat_mean = vec![0.0f64; n];
    let mut fl = GlowFlattener::new(fov, &cfg.flatten).unwrap();
    let mut buf = vec![0.0f32; n];
    for f in &fx.frames {
        for (b, &v) in buf.iter_mut().zip(f) {
            *b = f32::from(v);
        }
        cal.hot_pixels().apply(&mut buf).unwrap();
        for (m, &v) in raw_mean.iter_mut().zip(&buf) {
            *m += f64::from(v);
        }
        fl.apply(&mut buf).unwrap();
        for (m, &v) in flat_mean.iter_mut().zip(&buf) {
            *m += f64::from(v);
        }
    }
    let t = fx.frames.len() as f64;
    let raw_mean: Vec<f32> = raw_mean.iter().map(|v| (v / t) as f32).collect();
    let flat_mean: Vec<f32> = flat_mean.iter().map(|v| (v / t) as f32).collect();

    // Ground truth (expected counts, see the fixture README): the cells'
    // light and everything else ("glow": neuropil and leakage through the
    // illumination falloff and the vignette).
    let cells = Npy::load("cells_mean.npy").f32();
    let glow = Npy::load("glow_mean.npy").f32();
    let std_in = |img: &[f32]| -> f32 {
        let v: Vec<f32> = (0..n)
            .filter(|&i| fov.contains(i))
            .map(|i| img[i])
            .collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
    };
    // NLP = normalized (order-0) low-pass at the same σ inside the FOV. Any
    // such low-pass also takes the cells' own blurred light; that is expected.
    let nlp = |img: &[f32]| -> Vec<f32> {
        let mut g = RecursiveGaussian::new(dims, sigma).unwrap();
        let w: Vec<f32> = fov.weights();
        let mut num = vec![0.0f32; n];
        let mut den = vec![0.0f32; n];
        g.blur_weighted(img, &w, &mut num).unwrap();
        g.blur(&w, &mut den).unwrap();
        num.iter()
            .zip(&den)
            .map(|(a, b)| if *b > 1e-6 { a / b } else { 0.0 })
            .collect()
    };
    let cells_lp = nlp(&cells);
    // 1. Glow left in the flattened image: flattened mean minus the ideal
    //    flattened cells (cells − NLP(cells)); its low-frequency part (the
    //    cell term is only approximate at the pixel scale: PRNU, clipping)
    //    against the glow's own low-frequency spread.
    let leftover: Vec<f32> = (0..n)
        .map(|i| flat_mean[i] - (cells[i] - cells_lp[i]))
        .collect();
    let glow_std = std_in(&nlp(&glow));
    let left_std = std_in(&nlp(&leftover));
    if let Ok(dir) = std::env::var("CALA_DUMP_DIR") {
        for (name, img) in [("leftover", &leftover), ("flat_mean", &flat_mean)] {
            let bytes: Vec<u8> = img.iter().flat_map(|v| v.to_le_bytes()).collect();
            std::fs::write(format!("{dir}/{name}_s{sigma}.f32"), bytes).unwrap();
        }
    }
    // 2. What was removed matches the true glow plus the cells' low-pass.
    let removed: Vec<f32> = raw_mean
        .iter()
        .zip(&flat_mean)
        .map(|(r, f)| r - f)
        .collect();
    let idx: Vec<usize> = (0..n).filter(|&i| fov.contains(i)).collect();
    let x: Vec<f64> = idx
        .iter()
        .map(|&i| f64::from(glow[i] + cells_lp[i]))
        .collect();
    let y: Vec<f64> = idx.iter().map(|&i| f64::from(removed[i])).collect();
    let r2 = r_squared(&[x], &y);

    // 3. Cell contrast: peak of each cell minus a ring around it, on the raw
    //    and flattened mean images.
    let labels = Npy::load("cell_label.npy").u16();
    let n_cells = *labels.iter().max().unwrap() as usize;
    let mut ratios = Vec::new();
    for c in 1..=n_cells {
        let pix: Vec<usize> = (0..n).filter(|&i| labels[i] as usize == c).collect();
        if pix.is_empty() || !pix.iter().all(|&i| fov.contains(i)) {
            continue;
        }
        let (cy, cx) = pix.iter().fold((0.0, 0.0), |(a, b), &i| {
            (a + (i / dims.width) as f32, b + (i % dims.width) as f32)
        });
        let (cy, cx) = (cy / pix.len() as f32, cx / pix.len() as f32);
        let contrast = |img: &[f32]| -> f32 {
            let (mut core, mut nc, mut ring, mut nr) = (0.0, 0, 0.0, 0);
            for i in 0..n {
                let d = (((i / dims.width) as f32 - cy).powi(2)
                    + ((i % dims.width) as f32 - cx).powi(2))
                .sqrt();
                if d < 2.5 {
                    core += img[i];
                    nc += 1;
                } else if (7.0..9.0).contains(&d) && labels[i] == 0 && fov.contains(i) {
                    ring += img[i];
                    nr += 1;
                }
            }
            if nc == 0 || nr == 0 {
                return f32::NAN;
            }
            core / nc as f32 - ring / nr as f32
        };
        let (a, b) = (contrast(&raw_mean), contrast(&flat_mean));
        if a.is_finite() && b.is_finite() && a > 5.0 {
            ratios.push(b / a);
        }
    }
    (glow_std, left_std, r2, ratios)
}

/// Flattening removes the smooth illumination field and keeps the cells.
///
/// No subtractive low-pass removes a field's curvature: a σ high-pass leaves
/// ≈ −σ²/2·∇²glow, and the fixture's glow dome is only ~2σ wide at the
/// default σ = 20 (a 128 px frame; on 600 px CA1 frames that term is under a
/// grey level, and the background stage absorbs it anyway because it is
/// static). So glow removal is asserted at σ = 10, where that term is 4x
/// smaller, and cell contrast at the default σ.
#[test]
fn flattening_removes_glow_and_preserves_cell_contrast() {
    let fx = fixture();
    let default_sigma = FlattenConfig::default().sigma();
    for sigma in [10.0f32, default_sigma] {
        let (glow_std, left_std, r2, ratios) = flatten_metrics(&fx, sigma);
        let med_ratio = median(ratios.clone());
        let min_ratio = ratios.iter().cloned().fold(f32::INFINITY, f32::min);
        eprintln!(
            "flatten sigma {sigma}: glow LF std {glow_std:.2} -> leftover {left_std:.2} \
             ({:.1} %), removed-vs-truth R² {r2:.4}, cell contrast after/before median \
             {med_ratio:.3} min {min_ratio:.3} over {} cells",
            100.0 * left_std / glow_std,
            ratios.len()
        );
        assert!(ratios.len() >= 20);
        assert!(
            r2 > 0.97,
            "sigma {sigma}: removed low-pass vs truth R² {r2}"
        );
        if sigma == 10.0 {
            assert!(
                left_std < 0.1 * glow_std,
                "glow left {left_std} of {glow_std}"
            );
        } else {
            assert!(
                left_std < 0.3 * glow_std,
                "glow left {left_std} of {glow_std}"
            );
            assert!(
                med_ratio > 0.95 && med_ratio < 1.05,
                "contrast ratio {med_ratio}"
            );
            assert!(min_ratio > 0.85, "worst cell contrast ratio {min_ratio}");
        }
    }
}

/// R² of an ordinary least-squares fit of `y` on the columns `xs` plus a constant.
fn r_squared(xs: &[Vec<f64>], y: &[f64]) -> f64 {
    let k = xs.len() + 1;
    let n = y.len();
    let col = |j: usize, i: usize| if j == 0 { 1.0 } else { xs[j - 1][i] };
    let mut a = vec![vec![0.0f64; k + 1]; k];
    for i in 0..n {
        for r in 0..k {
            for c in 0..k {
                a[r][c] += col(r, i) * col(c, i);
            }
            a[r][k] += col(r, i) * y[i];
        }
    }
    for p in 0..k {
        let piv = (p..k)
            .max_by(|&i, &j| a[i][p].abs().total_cmp(&a[j][p].abs()))
            .unwrap();
        a.swap(p, piv);
        for r in 0..k {
            if r != p {
                let f = a[r][p] / a[p][p];
                for c in p..=k {
                    a[r][c] -= f * a[p][c];
                }
            }
        }
    }
    let beta: Vec<f64> = (0..k).map(|r| a[r][k] / a[r][r]).collect();
    let mean = y.iter().sum::<f64>() / n as f64;
    let (mut ss_res, mut ss_tot) = (0.0, 0.0);
    for i in 0..n {
        let pred: f64 = (0..k).map(|j| beta[j] * col(j, i)).sum();
        ss_res += (y[i] - pred).powi(2);
        ss_tot += (y[i] - mean).powi(2);
    }
    1.0 - ss_res / ss_tot
}

struct Lcg(u64);
impl Lcg {
    fn uniform(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32 + 0.5) / (1u64 << 24) as f32
    }
    fn normal(&mut self) -> f32 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
    }
}

/// The background stage recovers a known static floor under sparse
/// transients, and follows an upward step once relaxation is on.
#[test]
fn background_recovers_static_floor_and_tracks_up_step() {
    let fx = fixture();
    let dims = fx.dims;
    let n = dims.pixels();
    // Known static floor: the fixture's flattened median-ish structure,
    // here simply the flattened first frame smoothed in time by taking the
    // temporal mean (any fixed image works; this one has realistic texture).
    let cal = calibrate(&fx, &PreprocessConfig::default());
    let mut fl = GlowFlattener::new(cal.fov(), &FlattenConfig::default()).unwrap();
    let mut floor_true = vec![0.0f32; n];
    let mut buf = vec![0.0f32; n];
    for f in &fx.frames {
        for (b, &v) in buf.iter_mut().zip(f) {
            *b = f32::from(v);
        }
        fl.apply(&mut buf).unwrap();
        for (a, &v) in floor_true.iter_mut().zip(&buf) {
            *a += v / fx.frames.len() as f32;
        }
    }
    let sigma = 3.0f32;
    let mut bg = RunningMinBackground::new(dims, &BackgroundConfig::default()).unwrap();
    let mut rng = Lcg(11);
    // Sparse transients: each pixel block of 8x8 lights up for 40 frames
    // (+30) once every ~600 frames, staggered.
    let frames = 3000;
    let mut errs = Vec::new();
    for t in 0..frames {
        let step = if t >= 2000 { 15.0 } else { 0.0 };
        let mut f: Vec<f32> = (0..n)
            .map(|i| {
                let block = (i / dims.width / 8) * 16 + (i % dims.width) / 8;
                let on = (t + block * 37) % 600 < 40;
                floor_true[i] + step + if on { 30.0 } else { 0.0 } + sigma * rng.normal()
            })
            .collect();
        bg.process(&mut f).unwrap();
        if t == 1999 {
            errs = bg
                .final_estimate()
                .iter()
                .zip(&floor_true)
                .enumerate()
                .filter(|&(i, _)| cal.fov().contains(i))
                .map(|(_, (b, a))| b - a)
                .collect();
        }
    }
    // Before the step: the floor sits a stationary ~2-3 σ_s below the truth
    // (σ_s = σ/√5 = 1.34), uniformly (that offset is the same everywhere).
    let bias = median(errs.clone());
    let spread = median(errs.iter().map(|e| (e - bias).abs()).collect()) * 1.4826;
    eprintln!(
        "background: bias {bias:.2} spread {spread:.2} (sigma_s {:.2})",
        sigma / 5f32.sqrt()
    );
    assert!(
        bias < 0.0 && bias > -4.5 * sigma / 5f32.sqrt(),
        "bias {bias}"
    );
    assert!(spread < 0.6 * sigma, "spread {spread}");
    // After an upward step of 15 at frame 2000, 1000 frames later (0.42 τ at
    // the default τ = 2400) the floor has moved up by ≈ 15·(1 − e^-0.42) ≈ 5;
    // a pure minimum would not move at all.
    let after: Vec<f32> = bg
        .final_estimate()
        .iter()
        .zip(&floor_true)
        .enumerate()
        .filter(|&(i, _)| cal.fov().contains(i))
        .map(|(_, (b, a))| b - a)
        .collect();
    let moved = median(after) - bias;
    eprintln!("background: moved {moved:.2} after the +15 step");
    assert!(moved > 3.0 && moved < 9.0, "moved {moved}");
}

#[test]
fn noise_map_matches_simulator_noise() {
    let fx = fixture();
    for (name, est) in [
        ("median tracker", NoiseConfig::default().estimator),
        ("mean abs", NoiseEstimator::MeanAbs),
    ] {
        // The noise map is checked against the sensor model with the flicker
        // stage off: this fixture has no flicker, and its dense, synchronous
        // cells and neuropil give it a common mode that the flicker stage
        // partly removes, which changes the frame-to-frame fluctuations (see
        // `flicker_stage_on_a_flicker_free_scene`).
        let cfg = PreprocessConfig {
            noise: NoiseConfig {
                estimator: est,
                ..NoiseConfig::default()
            },
            flicker: FlickerConfig {
                mode: FlickerMode::Off,
                ..FlickerConfig::default()
            },
            ..PreprocessConfig::default()
        };
        let cal = calibrate(&fx, &cfg);
        let mut p = Preprocessor::new(cal.clone(), &cfg).unwrap();
        let mut out = vec![0.0f32; fx.dims.pixels()];
        for f in &fx.frames {
            p.process_frame(f, &mut out).unwrap();
        }
        let est = p.noise().sigma();
        let truth = Npy::load("noise_sigma.npy").f32();
        let labels = Npy::load("cell_label.npy").u16();
        let ratio = |cells: bool| {
            median(
                (0..truth.len())
                    .filter(|&i| {
                        cal.fov().contains(i)
                            && cal.hot_pixels().flags()[i] == FLAG_OK
                            && (labels[i] != 0) == cells
                    })
                    .map(|i| est[i] / truth[i])
                    .collect(),
            )
        };
        let (r_bg, r_cells) = (ratio(false), ratio(true));
        eprintln!(
            "noise ({name}): estimate / truth median {r_bg:.3} off cells, {r_cells:.3} on cells"
        );
        if name == "median tracker" {
            assert!((r_bg - 1.0).abs() < 0.04, "{name}: {r_bg}");
            assert!((r_cells - 1.0).abs() < 0.06, "{name}: {r_cells}");
        }
    }
}

#[test]
fn replay_from_serialized_state_is_bit_exact() {
    let fx = fixture();
    let cfg = PreprocessConfig {
        background: BackgroundConfig {
            snapshot_every: 50,
            ..BackgroundConfig::default()
        },
        ..PreprocessConfig::default()
    };
    let cal = calibrate(&fx, &cfg);
    let n = fx.dims.pixels();
    let mut p = Preprocessor::new(cal, &cfg).unwrap();
    let mut outs = Vec::new();
    let mut fronts = Vec::new();
    let mut flicker = Vec::new();
    let mut states = Vec::new();
    for (t, f) in fx.frames.iter().enumerate() {
        if t == 80 {
            states.push(p.state().to_bytes());
        }
        let mut out = vec![0.0f32; n];
        let rec = p.process_frame(f, &mut out).unwrap();
        outs.push(out);
        fronts.push(rec.front);
        flicker.push(rec.front.flicker);
    }
    // The fixture has no flicker, but the stage does estimate something.
    assert!(flicker[1..].iter().any(|r| r.gain != 0.0));
    let final_sigma = p.noise().sigma();

    // Resume from the serialized state at frame 80.
    let st = PreprocessState::from_bytes(&states[0]).unwrap();
    assert_eq!(st.to_bytes(), states[0]);
    let mut q = Preprocessor::from_state(&st).unwrap();
    assert_eq!(q.frames_processed(), 80);
    for t in 80..fx.frames.len() {
        let mut out = vec![0.0f32; n];
        let rec = q.process_frame(&fx.frames[t], &mut out).unwrap();
        assert_eq!(rec.back.frame_index, t as u64);
        assert_eq!(out, outs[t], "frame {t}");
    }
    assert_eq!(q.noise().sigma(), final_sigma);

    // Resume from an in-memory background snapshot (frame 100) as well: the
    // flicker reference is not in the snapshot, so the front half replays
    // the recorded flicker.
    let snap = p.background().snapshot_before(110).unwrap().state.clone();
    assert_eq!(snap.frames(), 100);
    let mut r = Preprocessor::from_state(&st).unwrap();
    r.background_mut().restore(&snap).unwrap();
    for t in 100..fx.frames.len() {
        let mut out = vec![0.0f32; n];
        let fr = r
            .front_replay(&fx.frames[t], &mut out, &flicker[t])
            .unwrap();
        assert_eq!(fr, fronts[t]);
        r.background_mut().process(&mut out).unwrap();
        assert_eq!(out, outs[t], "snapshot replay frame {t}");
    }

    // With its flicker record, the front half is stateless: any frame, any
    // order, and the same as the online pass.
    let mut front_a = vec![0.0f32; n];
    let mut front_b = vec![0.0f32; n];
    let mut online = Preprocessor::new(p.calibration().clone(), &cfg).unwrap();
    let mut front_3 = vec![0.0f32; n];
    for f in &fx.frames[..4] {
        online.front(f, &mut front_3).unwrap();
    }
    q.front_replay(&fx.frames[3], &mut front_a, &flicker[3])
        .unwrap();
    q.front_replay(&fx.frames[150], &mut front_b, &flicker[150])
        .unwrap();
    q.front_replay(&fx.frames[3], &mut front_b, &flicker[3])
        .unwrap();
    assert_eq!(front_a, front_b);
    assert_eq!(front_a, front_3);
}

/// Column fixed-pattern noise survives flattening (it is one pixel wide) and
/// the line stage removes it.
#[test]
fn column_mode_removes_column_fixed_pattern() {
    let fx = fixture();
    let fpn = Npy::load("fpn_column.npy").f32();
    let labels = Npy::load("cell_label.npy").u16();
    let w = fx.dims.width;
    let mut res = Vec::new();
    for mode in [LineMode::Off, LineMode::Columns] {
        let cfg = PreprocessConfig {
            lines: mode,
            ..PreprocessConfig::default()
        };
        let cal = calibrate(&fx, &cfg);
        let mut p = Preprocessor::new(cal.clone(), &cfg).unwrap();
        let mut mean = vec![0.0f64; fx.dims.pixels()];
        let mut out = vec![0.0f32; fx.dims.pixels()];
        for f in &fx.frames {
            p.front(f, &mut out).unwrap();
            for (m, &v) in mean.iter_mut().zip(&out) {
                *m += f64::from(v);
            }
        }
        // Column profile of the mean over off-cell FOV pixels (columns with
        // >= 32 of them; the line stage itself averages all FOV pixels),
        // minus its own 9-column moving average (slow structure).
        let mut prof = vec![f64::NAN; w];
        for (x, p) in prof.iter_mut().enumerate() {
            let v: Vec<f64> = (0..fx.dims.height)
                .map(|y| y * w + x)
                .filter(|&i| cal.fov().contains(i) && labels[i] == 0)
                .map(|i| mean[i] / fx.frames.len() as f64)
                .collect();
            if v.len() >= 32 {
                *p = v.iter().sum::<f64>() / v.len() as f64;
            }
        }
        let cols: Vec<usize> = (4..w - 4)
            .filter(|&x| (x - 4..=x + 4).all(|j| prof[j].is_finite()))
            .collect();
        let hp: Vec<f64> = cols
            .iter()
            .map(|&x| prof[x] - (x - 4..=x + 4).map(|j| prof[j]).sum::<f64>() / 9.0)
            .collect();
        let gt: Vec<f64> = cols
            .iter()
            .map(|&x| {
                f64::from(fpn[x]) - (x - 4..=x + 4).map(|j| f64::from(fpn[j])).sum::<f64>() / 9.0
            })
            .collect();
        let rms = (hp.iter().map(|v| v * v).sum::<f64>() / hp.len() as f64).sqrt();
        let corr = pearson(&hp, &gt);
        // Gain of the true FPN in the profile (1 = all of it left).
        let beta = hp.iter().zip(&gt).map(|(a, b)| a * b).sum::<f64>()
            / gt.iter().map(|b| b * b).sum::<f64>();
        eprintln!(
            "lines {mode:?}: off-cell column structure rms {rms:.3} (cells' grid included), \
             correlation with true FPN {corr:.3}, FPN gain {beta:.3}"
        );
        res.push((corr, beta));
    }
    assert!(
        res[0].0 > 0.7 && res[0].1 > 0.8,
        "column FPN visible before: {:?}",
        res[0]
    );
    assert!(
        res[1].0.abs() < 0.2 && res[1].1.abs() < 0.2,
        "FPN left after: {:?}",
        res[1]
    );
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
    cov / (va * vb).sqrt()
}

/// The lens-disk check of the FOV mask must not touch a recording that has a
/// disk: the strongly vignetted fixture keeps exactly the mask the plain
/// relative threshold gave before the check existed (area and FNV-1a hash of
/// the mask bytes, recorded from that version).
#[test]
fn vignetted_fixture_keeps_its_fov_mask() {
    let fx = fixture();
    let cal = calibrate(&fx, &PreprocessConfig::default());
    let mask = cal.fov().mask();
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in mask {
        h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    let area = cal.fov().area();
    eprintln!("FOV mask: area {area} of {}, hash {h:#x}", mask.len());
    assert_eq!((area, h), (EXPECTED_AREA, EXPECTED_HASH));
}

const EXPECTED_AREA: usize = 12468;
const EXPECTED_HASH: u64 = 0x9e65794d8c789191;

/// The flicker stage on a scene without flicker: what it reads from the
/// scene itself, and what that does to the per-pixel noise. This fixture is
/// a worst case (128 px, 30 % of the FOV covered by cells, strong neuropil, so
/// the scene has a large common mode of its own).
#[test]
fn flicker_stage_on_a_flicker_free_scene() {
    let fx = fixture();
    let truth = Npy::load("noise_sigma.npy").f32();
    let mut res = Vec::new();
    for mode in [
        FlickerMode::Off,
        FlickerMode::Additive,
        FlickerMode::Multiplicative,
        FlickerMode::Both,
    ] {
        let cfg = PreprocessConfig {
            flicker: FlickerConfig {
                mode,
                ..FlickerConfig::default()
            },
            ..PreprocessConfig::default()
        };
        let cal = calibrate(&fx, &cfg);
        let mut p = Preprocessor::new(cal.clone(), &cfg).unwrap();
        let mut out = vec![0.0f32; fx.dims.pixels()];
        let (mut sa, mut sm) = (0.0f64, 0.0f64);
        for f in &fx.frames {
            let r = p.process_frame(f, &mut out).unwrap().front.flicker;
            sa += f64::from(r.offset).powi(2);
            sm += f64::from(r.gain).powi(2);
        }
        let n = fx.frames.len() as f64;
        let (a_rms, m_rms) = ((sa / n).sqrt(), (sm / n).sqrt());
        let est = p.noise().sigma();
        let ratio = median(
            (0..truth.len())
                .filter(|&i| cal.fov().contains(i) && cal.hot_pixels().flags()[i] == FLAG_OK)
                .map(|i| est[i] / truth[i])
                .collect(),
        );
        eprintln!(
            "flicker {mode:?}: grid {} px, reads a rms {a_rms:.3}, m rms {m_rms:.4}; noise estimate / truth {ratio:.3}",
            p.flicker().grid_len()
        );
        res.push((a_rms, m_rms, ratio));
    }
    assert_eq!((res[0].0, res[0].1), (0.0, 0.0));
    assert!((res[0].2 - 1.0).abs() < 0.04);
    // The scene's own common mode raises the noise estimate by a few percent
    // at most (the 600 px calibrated simulation shows no loss in trace
    // accuracy, see examples/flicker_eval.rs).
    for &(_, _, ratio) in &res[1..] {
        assert!(ratio < 1.07, "{ratio}");
    }
}
