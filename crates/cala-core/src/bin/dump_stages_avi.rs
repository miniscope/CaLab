//! Dev-only CLI: run each preprocess stage on a subset of frames and
//! emit one AVI per stage, each autoscaled so it's visible in a player.
//!
//! Lets you eyeball exactly where the pipeline is working or not —
//! is the Butterworth actually flattening illumination? Is motion
//! producing clean output? Is denoise suppressing speckle? — without
//! squinting at a single composed result.
//!
//! Gated behind the `native-cli` feature. Usage:
//!     cargo run --features native-cli --release \
//!         --bin cala-dump-stages-avi -- OUTPUT_DIR INPUT.avi \
//!             [PIXEL_SIZE_UM] [--frames N] [--smooth-sigma S] \
//!             [--denoise-ksize K]
//!
//! Emits files named `<DIR>/NN_<stage>.avi` where NN is the stage's
//! execution order:
//!     00_input       — raw grayscale frame (no processing)
//!     01_hotpix      — after 3×3 hot-pixel median
//!     02_butter      — after Butterworth high-pass
//!     03_band        — after row+col double-centering
//!     04_motion      — after dual-anchor motion correction
//!     05_denoise     — after post-motion square median (= final pipeline output)
//!
//! Each stage is autoscaled independently ([its global_min, global_max]
//! → [0, 255]), so absolute magnitudes aren't comparable across
//! stages, but each stage gets full visible contrast on its own.

use std::process::ExitCode;

use calab_cala_core::assets::{Frame, FrameMut};
use calab_cala_core::config::{GrayscaleMethod, PreprocessConfig, RecordingMetadata};
use calab_cala_core::io::{write_uncompressed_avi_8bit, AviUncompressedReader};
use calab_cala_core::preprocess::{
    band_subtract, butterworth_highpass, high_pass_cutoff_cycles_per_pixel, hot_pixel_median_3x3,
    median_filter, MotionState,
};

const STAGE_NAMES: &[&str] = &[
    "00_input",
    "01_hotpix",
    "02_butter",
    "03_band",
    "04_motion",
    "05_denoise",
];

fn take_flag_value<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == flag)
        .and_then(|i| argv.get(i + 1).map(String::as_str))
}

fn autoscale_to_u8(frames: &[Vec<f32>]) -> (f32, f32, Vec<Vec<u8>>) {
    let mut vmin = f32::INFINITY;
    let mut vmax = f32::NEG_INFINITY;
    for f in frames {
        for &v in f {
            if v.is_finite() {
                if v < vmin {
                    vmin = v;
                }
                if v > vmax {
                    vmax = v;
                }
            }
        }
    }
    if !vmin.is_finite() || !vmax.is_finite() {
        // Degenerate: pass zeros through.
        let n = frames.first().map(|f| f.len()).unwrap_or(0);
        return (0.0, 0.0, vec![vec![0u8; n]; frames.len()]);
    }
    let span = (vmax - vmin).max(1e-12);
    let u8_frames = frames
        .iter()
        .map(|f| {
            f.iter()
                .map(|&v| ((v - vmin) / span * 255.0).clamp(0.0, 255.0) as u8)
                .collect::<Vec<u8>>()
        })
        .collect();
    (vmin, vmax, u8_frames)
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().collect();
    let enable_butter = raw_args.iter().any(|a| a == "--enable-butter");
    let enable_band = raw_args.iter().any(|a| a == "--enable-band");
    let frames_override: Option<u32> =
        take_flag_value(&raw_args, "--frames").and_then(|s| s.parse().ok());
    let smooth_sigma_override: Option<f32> =
        take_flag_value(&raw_args, "--smooth-sigma").and_then(|s| s.parse().ok());
    let crop_frac_override: Option<f32> =
        take_flag_value(&raw_args, "--corr-crop").and_then(|s| s.parse().ok());
    let denoise_ksize_override: Option<usize> =
        take_flag_value(&raw_args, "--denoise-ksize").and_then(|s| s.parse().ok());
    let value_flags = [
        "--frames",
        "--smooth-sigma",
        "--corr-crop",
        "--denoise-ksize",
    ];
    let args: Vec<&String> = raw_args
        .iter()
        .enumerate()
        .filter(|(i, a)| {
            if a.starts_with("--") {
                return false;
            }
            if *i > 0 && value_flags.contains(&raw_args[i - 1].as_str()) {
                return false;
            }
            true
        })
        .map(|(_, a)| a)
        .collect();
    if args.len() < 3 {
        eprintln!(
            "usage: {} OUTPUT_DIR INPUT.avi [PIXEL_SIZE_UM] [--frames N] \
             [--smooth-sigma S] [--denoise-ksize K]",
            raw_args
                .first()
                .map(String::as_str)
                .unwrap_or("cala-dump-stages-avi")
        );
        return ExitCode::from(2);
    }
    let output_dir = args[1];
    let input_path = args[2];
    let pixel_size_um: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(2.0);

    if let Err(e) = std::fs::create_dir_all(output_dir) {
        eprintln!("error: could not create {output_dir}: {e}");
        return ExitCode::from(1);
    }

    let bytes = match std::fs::read(input_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("error reading {input_path}: {e}");
            return ExitCode::from(1);
        }
    };
    let reader = match AviUncompressedReader::new(&bytes) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error parsing AVI: {e:?}");
            return ExitCode::from(1);
        }
    };
    let h = reader.height() as usize;
    let w = reader.width() as usize;
    let n = h * w;
    let avail = reader.frame_count();
    let n_frames = frames_override.unwrap_or(avail).min(avail);
    let fps = reader.fps().round().max(1.0) as u32;

    let metadata = RecordingMetadata::new(pixel_size_um);
    let mut cfg = PreprocessConfig::default()
        .with_high_pass_enabled(enable_butter)
        .with_band_enabled(enable_band);
    if let Some(s) = smooth_sigma_override {
        cfg = cfg.with_motion_smooth_sigma_px(s);
    }
    if let Some(f) = crop_frac_override {
        if !(f > 0.0 && f <= 1.0) {
            eprintln!("error: --corr-crop must be in (0, 1] (got {f})");
            return ExitCode::from(2);
        }
        cfg = cfg.with_motion_corr_crop_frac(f);
    }
    if let Some(k) = denoise_ksize_override {
        if k < 1 || k % 2 == 0 {
            eprintln!("error: --denoise-ksize must be odd and ≥ 1 (got {k})");
            return ExitCode::from(2);
        }
        cfg = cfg.with_denoise_median_ksize(k);
    }
    let cutoff = high_pass_cutoff_cycles_per_pixel(&metadata, &cfg);
    let mut motion = MotionState::with_config(h, w, &cfg);

    eprintln!(
        "input: {w}x{h}, {avail} frames available, using {n_frames}\n\
         pixel_size_um = {pixel_size_um}\n\
         stages: butter={butter}, band={band}, motion_smooth={sigma}, \
         denoise_ksize={ksize}",
        butter = cfg.high_pass_enabled,
        band = cfg.band_enabled,
        sigma = cfg.motion_smooth_sigma_px,
        ksize = cfg.denoise_median_ksize,
    );

    // One Vec<Vec<f32>> per stage, collecting every frame's output.
    let mut stage_accum: Vec<Vec<Vec<f32>>> = (0..STAGE_NAMES.len())
        .map(|_| Vec::with_capacity(n_frames as usize))
        .collect();

    // Per-frame scratch buffers, ping-ponged through the stages.
    let mut input_buf = vec![0.0_f32; n];
    let mut buf_a = vec![0.0_f32; n];
    let mut buf_b = vec![0.0_f32; n];

    for i in 0..n_frames {
        if let Err(e) = reader.read_frame_grayscale_f32(i, &mut input_buf, GrayscaleMethod::Green) {
            eprintln!("error reading frame {i}: {e:?}");
            return ExitCode::from(1);
        }
        // Stage 0: raw input.
        stage_accum[0].push(input_buf.clone());

        // Stage 1: hot-pixel median → buf_a.
        {
            let inp = Frame::new(&input_buf, h, w).expect("input invariant");
            let mut out = FrameMut::new(&mut buf_a, h, w).expect("buf_a invariant");
            if let Err(e) = hot_pixel_median_3x3(inp, &mut out) {
                eprintln!("hotpix err frame {i}: {e:?}");
                return ExitCode::from(1);
            }
        }
        stage_accum[1].push(buf_a.clone());

        // Stage 2: Butterworth → buf_b (or swap when disabled).
        if cfg.high_pass_enabled {
            let inp = Frame::new(&buf_a, h, w).expect("buf_a invariant");
            let mut out = FrameMut::new(&mut buf_b, h, w).expect("buf_b invariant");
            if let Err(e) = butterworth_highpass(inp, &mut out, cutoff, cfg.high_pass_order) {
                eprintln!("butter err frame {i}: {e:?}");
                return ExitCode::from(1);
            }
        } else {
            std::mem::swap(&mut buf_a, &mut buf_b);
        }
        stage_accum[2].push(buf_b.clone());

        // Stage 3: band subtract → buf_a (or swap when disabled).
        if cfg.band_enabled {
            let inp = Frame::new(&buf_b, h, w).expect("buf_b invariant");
            let mut out = FrameMut::new(&mut buf_a, h, w).expect("buf_a invariant");
            if let Err(e) = band_subtract(inp, &mut out) {
                eprintln!("band err frame {i}: {e:?}");
                return ExitCode::from(1);
            }
        } else {
            std::mem::swap(&mut buf_a, &mut buf_b);
        }
        stage_accum[3].push(buf_a.clone());

        // Stage 4: motion correction → buf_b.
        {
            let inp = Frame::new(&buf_a, h, w).expect("buf_a invariant");
            let mut out = FrameMut::new(&mut buf_b, h, w).expect("buf_b invariant");
            if let Err(e) = motion.motion_correct(inp, &mut out, &cfg) {
                eprintln!("motion err frame {i}: {e:?}");
                return ExitCode::from(1);
            }
        }
        stage_accum[4].push(buf_b.clone());

        // Stage 5: post-motion denoise → buf_a (or identity swap).
        let ksize = cfg.denoise_median_ksize;
        if ksize <= 1 {
            std::mem::swap(&mut buf_a, &mut buf_b);
        } else {
            let inp = Frame::new(&buf_b, h, w).expect("buf_b invariant");
            let mut out = FrameMut::new(&mut buf_a, h, w).expect("buf_a invariant");
            if let Err(e) = median_filter(inp, &mut out, ksize) {
                eprintln!("denoise err frame {i}: {e:?}");
                return ExitCode::from(1);
            }
        }
        stage_accum[5].push(buf_a.clone());
    }

    for (idx, name) in STAGE_NAMES.iter().enumerate() {
        let frames = &stage_accum[idx];
        let (vmin, vmax, u8_frames) = autoscale_to_u8(frames);
        let out_path = format!("{output_dir}/{name}.avi");
        let bytes = write_uncompressed_avi_8bit(w as u32, h as u32, fps, &u8_frames);
        if let Err(e) = std::fs::write(&out_path, &bytes) {
            eprintln!("error writing {out_path}: {e}");
            return ExitCode::from(1);
        }
        eprintln!("  {name}: range [{vmin:.4}, {vmax:.4}] → {out_path}");
    }

    ExitCode::SUCCESS
}
