//! Phase 1 end-to-end integration test.
//!
//! Drives synthetic frames through the preprocess pipeline (hot-pixel
//! → Butterworth → band → motion → denoise) via an AVI round-trip:
//! in-memory AVI → AVI reader → PreprocessPipeline → AVI writer →
//! AVI reader. Pins composite invariants and checks the reader + writer
//! + pipeline agree on frame count and shape.

use calab_cala_core::assets::{Frame, FrameMut};
use calab_cala_core::config::{GrayscaleMethod, PreprocessConfig, RecordingMetadata};
use calab_cala_core::io::{write_uncompressed_avi_8bit, AviUncompressedReader};
use calab_cala_core::preprocess::{MotionShift, PreprocessPipeline};

/// Build a short synthetic recording:
///   - constant background
///   - mild row + column gradient (exercises band subtraction)
///   - a bright square "neuron" that drifts a pixel every other frame
///     (exercises motion correction)
fn make_synthetic_frames(w: usize, h: usize, n: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::with_capacity(n);
    for t in 0..n {
        let brightness = 100 + ((t as i32 * 10).min(100)) as u8;
        let drift_y = (t % 3) as i32 - 1; // cycles through -1, 0, 1
        let drift_x = (t % 2) as i32;
        let center_y = (h / 2) as i32 + drift_y;
        let center_x = (w / 2) as i32 + drift_x;
        let radius: i32 = 2;
        let mut f = vec![50u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut v: i32 = f[y * w + x] as i32 + (y as i32) + (x as i32);
                let dy = (y as i32 - center_y).abs();
                let dx = (x as i32 - center_x).abs();
                if dy <= radius && dx <= radius {
                    v += brightness as i32;
                }
                f[y * w + x] = v.clamp(0, 255) as u8;
            }
        }
        frames.push(f);
    }
    frames
}

struct PipelineRun {
    frame_count: u32,
    n: usize,
    u8_outputs: Vec<Vec<u8>>,
}

fn drive_pipeline(w: usize, h: usize, frames: &[Vec<u8>]) -> PipelineRun {
    let avi_bytes = write_uncompressed_avi_8bit(w as u32, h as u32, 20, frames);
    let reader = AviUncompressedReader::new(&avi_bytes).unwrap();
    assert_eq!(reader.width() as usize, w);
    assert_eq!(reader.height() as usize, h);
    assert_eq!(reader.frame_count() as usize, frames.len());

    let metadata = RecordingMetadata::new(2.0);
    let cfg = PreprocessConfig::default();
    let mut pipeline = PreprocessPipeline::new(h, w, &metadata, cfg);

    let n = h * w;
    let mut in_buf = vec![0.0_f32; n];
    let mut out_buf = vec![0.0_f32; n];
    let mut u8_outputs = Vec::with_capacity(frames.len());

    for i in 0..reader.frame_count() {
        reader
            .read_frame_grayscale_f32(i, &mut in_buf, GrayscaleMethod::Green)
            .unwrap();
        pipeline
            .process_frame(
                Frame::new(&in_buf, h, w).unwrap(),
                &mut FrameMut::new(&mut out_buf, h, w).unwrap(),
            )
            .unwrap();
        u8_outputs.push(
            out_buf
                .iter()
                .map(|&v| v.clamp(0.0, 255.0) as u8)
                .collect::<Vec<u8>>(),
        );
    }

    PipelineRun {
        frame_count: reader.frame_count(),
        n,
        u8_outputs,
    }
}

#[test]
fn pipeline_preserves_frame_count_and_shape() {
    let (w, h) = (32, 32);
    let frames = make_synthetic_frames(w, h, 8);
    let run = drive_pipeline(w, h, &frames);
    assert_eq!(run.frame_count, frames.len() as u32);
    assert_eq!(run.u8_outputs.len(), frames.len());
    for f in &run.u8_outputs {
        assert_eq!(f.len(), run.n);
    }
    // Regression guard: the pipeline is not a pass-through. With the
    // synthetic drift + hot-pixel stage, at least one output frame must
    // differ from its corresponding input in at least one pixel.
    let any_diff = run
        .u8_outputs
        .iter()
        .zip(frames.iter())
        .any(|(o, i)| o != i);
    assert!(
        any_diff,
        "pipeline output bitwise-matches input on every frame"
    );
}

#[test]
fn pipeline_recovers_known_drift() {
    // Drive a textured anchor plus three deliberately-shifted frames
    // through the pipeline and assert the motion stage reports shifts
    // matching the ground truth. Confirms the full pipeline runs — not
    // just that it doesn't panic.
    let (w, h) = (32, 32);
    let metadata = RecordingMetadata::new(2.0);
    // Override the default 0.6 center crop: the 32×32 synthetic is too
    // small to give the correlator enough signal after cropping.
    let cfg = PreprocessConfig::default().with_motion_corr_crop_frac(1.0);
    let mut pipeline = PreprocessPipeline::new(h, w, &metadata, cfg);

    // Smooth Gaussian blob — compact peak gives cross-correlation a
    // clean peak to lock onto.
    let n = h * w;
    let mut anchor = vec![0.0_f32; n];
    for y in 0..h {
        for x in 0..w {
            let dy = y as f32 - (h / 2) as f32;
            let dx = x as f32 - (w / 2) as f32;
            anchor[y * w + x] = 200.0 * (-(dy * dy + dx * dx) / 18.0).exp();
        }
    }

    let drifts: [(isize, isize); 4] = [(0, 0), (2, 1), (-1, 2), (3, -1)];
    let mut in_buf = vec![0.0_f32; n];
    let mut out_buf = vec![0.0_f32; n];
    let mut recovered = Vec::with_capacity(drifts.len());

    for &(dy, dx) in &drifts {
        for y in 0..h {
            for x in 0..w {
                let sy = (y as isize - dy).rem_euclid(h as isize) as usize;
                let sx = (x as isize - dx).rem_euclid(w as isize) as usize;
                in_buf[y * w + x] = anchor[sy * w + sx];
            }
        }
        let shift = pipeline
            .process_frame(
                Frame::new(&in_buf, h, w).unwrap(),
                &mut FrameMut::new(&mut out_buf, h, w).unwrap(),
            )
            .unwrap();
        recovered.push(shift);
    }

    // First frame is identity.
    assert_eq!(recovered[0], MotionShift { dy: 0.0, dx: 0.0 });

    // Non-first frames: shift recovered within 1 px of ground truth.
    // Tolerance is loose because the hot-pixel median perturbs the input
    // before it reaches the correlator.
    for (i, &(dy_true, dx_true)) in drifts.iter().enumerate().skip(1) {
        let s = recovered[i];
        assert!(
            (s.dy - dy_true as f32).abs() < 1.0,
            "frame {i}: dy = {}, expected ≈ {dy_true}",
            s.dy
        );
        assert!(
            (s.dx - dx_true as f32).abs() < 1.0,
            "frame {i}: dx = {}, expected ≈ {dx_true}",
            s.dx
        );
    }
    assert_eq!(pipeline.motion_state().global_count(), drifts.len() as u64);
}

#[test]
fn pipeline_reset_drops_motion_state() {
    let (w, h) = (16, 16);
    let frames = make_synthetic_frames(w, h, 3);
    let metadata = RecordingMetadata::new(2.0);
    let cfg = PreprocessConfig::default();
    let mut pipeline = PreprocessPipeline::new(h, w, &metadata, cfg);

    let n = h * w;
    let mut in_buf = vec![0.0_f32; n];
    let mut out_buf = vec![0.0_f32; n];
    // Run a couple frames directly (skip the AVI round-trip, this test
    // is about pipeline state only).
    for bytes in frames.iter().take(2) {
        for (i, &b) in bytes.iter().enumerate() {
            in_buf[i] = b as f32;
        }
        pipeline
            .process_frame(
                Frame::new(&in_buf, h, w).unwrap(),
                &mut FrameMut::new(&mut out_buf, h, w).unwrap(),
            )
            .unwrap();
    }
    assert!(pipeline.motion_state().has_anchor());

    pipeline.reset();
    assert!(!pipeline.motion_state().has_anchor());
}

#[test]
fn pipeline_output_roundtrips_through_avi_writer_and_reader() {
    // Write pipeline output back out as AVI, read it back, assert
    // the reader + writer agree on dimensions and frame bytes.
    let (w, h) = (32, 32);
    let frames = make_synthetic_frames(w, h, 4);
    let run = drive_pipeline(w, h, &frames);

    let out_bytes = write_uncompressed_avi_8bit(w as u32, h as u32, 20, &run.u8_outputs);
    let re_read = AviUncompressedReader::new(&out_bytes).unwrap();
    assert_eq!(re_read.width() as usize, w);
    assert_eq!(re_read.height() as usize, h);
    assert_eq!(re_read.frame_count() as usize, run.u8_outputs.len());
    for i in 0..run.u8_outputs.len() {
        assert_eq!(
            re_read.frame_bytes(i as u32).unwrap(),
            &run.u8_outputs[i][..],
            "frame {i} bytes disagree after round-trip"
        );
    }
}
