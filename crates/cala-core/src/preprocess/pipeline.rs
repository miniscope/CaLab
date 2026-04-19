//! Composite preprocess pipeline: hot-pixel → Butterworth high-pass
//! → band subtraction → dual-anchor motion correction → post-motion
//! median denoise. Owns ping-pong scratch buffers and the stateful
//! motion stage so callers just push frames through it one at a time.
//!
//! No baseline stage by design (§3.1): slow spatial baseline /
//! vignetting / illumination are OMF background components, not
//! preprocessing's job.

use super::{
    band_subtract, butterworth_highpass, high_pass_cutoff_cycles_per_pixel, hot_pixel_median_3x3,
    median_filter, MotionShift, MotionState,
};
use crate::assets::{Frame, FrameMut, ShapeError};
use crate::config::{PreprocessConfig, RecordingMetadata};

/// Streaming preprocess for a fixed-shape frame sequence. `process_frame`
/// runs all preprocess stages and returns the detected motion shift
/// for the frame it just saw.
pub struct PreprocessPipeline {
    height: usize,
    width: usize,
    cfg: PreprocessConfig,
    butterworth_cutoff: f32,
    buf_a: Vec<f32>,
    buf_b: Vec<f32>,
    motion: MotionState,
}

impl PreprocessPipeline {
    pub fn new(
        height: usize,
        width: usize,
        metadata: &RecordingMetadata,
        cfg: PreprocessConfig,
    ) -> Self {
        let cutoff = high_pass_cutoff_cycles_per_pixel(metadata, &cfg);
        let n = height * width;
        Self {
            height,
            width,
            cfg,
            butterworth_cutoff: cutoff,
            buf_a: vec![0.0; n],
            buf_b: vec![0.0; n],
            motion: MotionState::with_config(height, width, &cfg),
        }
    }

    pub fn motion_state(&self) -> &MotionState {
        &self.motion
    }

    /// Reset all stateful stages. `process_frame` after this call
    /// behaves as first-frame (motion anchors empty).
    pub fn reset(&mut self) {
        self.motion.reset();
    }

    /// Run the full preprocess pipeline, copying two intermediate
    /// stages out so the dashboard's 4-canvas frame panel (design
    /// §12, Phase 7 task 5) can render them alongside the final
    /// motion-corrected frame. Hot path still uses `process_frame`.
    ///
    /// Outputs written:
    /// - `output`: final frame (same as `process_frame`).
    /// - `hot_pixel_out`: post hot-pixel median, pre-motion.
    /// - `motion_out`: post-motion, pre-denoise.
    pub fn process_frame_with_stages(
        &mut self,
        input: Frame<'_>,
        output: &mut FrameMut<'_>,
        hot_pixel_out: &mut FrameMut<'_>,
        motion_out: &mut FrameMut<'_>,
    ) -> Result<MotionShift, ShapeError> {
        let shift = self.process_frame(input, output)?;
        // `buf_a` or `buf_b` hold the intermediate stages depending on
        // which opt-in filters fired. Re-run the minimal capture here
        // rather than instrumenting the hot path: callers only invoke
        // this method at preview-stride cadence so the extra work is
        // amortized over many frames.
        //
        // Simpler: just copy from the internal buffers. `buf_b` holds
        // the post-motion frame at the end of `process_frame` (before
        // the final denoise copy). After `process_frame`, if denoise
        // was off, output == buf_b; if denoise was on, buf_b is still
        // the pre-denoise motion-corrected frame. We copy that
        // unconditionally.
        //
        // `buf_a` contains the stage immediately before motion — which
        // is either the hot-pixel output (default stack) or a later
        // opt-in filter. For the 4-canvas we want the hot-pixel stage;
        // the current default stack passes hot-pixel output through
        // unchanged to motion input, so re-running the hot-pixel stage
        // into `hot_pixel_out` gives the right frame without depending
        // on which opt-in filters are enabled.
        crate::preprocess::hot_pixel_median_3x3(input, hot_pixel_out)?;
        motion_out.pixels_mut().copy_from_slice(&self.buf_b);
        Ok(shift)
    }

    /// Run the full preprocess pipeline on one frame.
    ///
    /// Stages marked "opt-in" are skipped (buffer passthrough via
    /// `mem::swap`) when disabled in config. The default stack is
    /// hot-pix → motion; everything else is for ablation or
    /// recordings where OMF needs help.
    ///
    ///   input → [hot_pixel]   → buf_a   (always)
    ///   buf_a → [butterworth] → buf_b   (opt-in: high_pass_enabled)
    ///   buf_b → [band]        → buf_a   (opt-in: band_enabled)
    ///   buf_a → [motion]      → buf_b   (always)
    ///   buf_b → [denoise]     → output  (opt-in: denoise_median_ksize > 1;
    ///                                    when off, buf_b copies to output)
    pub fn process_frame(
        &mut self,
        input: Frame<'_>,
        output: &mut FrameMut<'_>,
    ) -> Result<MotionShift, ShapeError> {
        let n = self.height * self.width;
        if input.height() != self.height || input.width() != self.width {
            return Err(ShapeError {
                expected: n,
                actual: input.pixels().len(),
            });
        }
        if output.height() != self.height || output.width() != self.width {
            return Err(ShapeError {
                expected: n,
                actual: output.pixels().len(),
            });
        }

        // 1. hot-pixel median: input → buf_a
        {
            let mut buf_a_mut = FrameMut::new(&mut self.buf_a, self.height, self.width)
                .expect("pipeline buf_a invariant");
            hot_pixel_median_3x3(input, &mut buf_a_mut)?;
        }

        // 2. Butterworth high-pass: buf_a → buf_b (or pass through via swap).
        if self.cfg.high_pass_enabled {
            let buf_a_view =
                Frame::new(&self.buf_a, self.height, self.width).expect("pipeline buf_a invariant");
            let mut buf_b_mut = FrameMut::new(&mut self.buf_b, self.height, self.width)
                .expect("pipeline buf_b invariant");
            butterworth_highpass(
                buf_a_view,
                &mut buf_b_mut,
                self.butterworth_cutoff,
                self.cfg.high_pass_order,
            )?;
        } else {
            std::mem::swap(&mut self.buf_a, &mut self.buf_b);
        }

        // 3. Band (double-centering): buf_b → buf_a (or swap).
        if self.cfg.band_enabled {
            let buf_b_view =
                Frame::new(&self.buf_b, self.height, self.width).expect("pipeline buf_b invariant");
            let mut buf_a_mut = FrameMut::new(&mut self.buf_a, self.height, self.width)
                .expect("pipeline buf_a invariant");
            band_subtract(buf_b_view, &mut buf_a_mut)?;
        } else {
            std::mem::swap(&mut self.buf_a, &mut self.buf_b);
        }

        // 4. Motion correction (dual anchor): buf_a → buf_b
        let shift = {
            let buf_a_view =
                Frame::new(&self.buf_a, self.height, self.width).expect("pipeline buf_a invariant");
            let mut buf_b_mut = FrameMut::new(&mut self.buf_b, self.height, self.width)
                .expect("pipeline buf_b invariant");
            self.motion
                .motion_correct(buf_a_view, &mut buf_b_mut, &self.cfg)?
        };

        // 5. Post-motion median denoise: buf_b → output, else straight
        //    copy. Last stage, so we write to the caller's output buffer
        //    in both branches.
        let ksize = self.cfg.denoise_median_ksize;
        if ksize <= 1 {
            output.pixels_mut().copy_from_slice(&self.buf_b);
        } else {
            let buf_b_view =
                Frame::new(&self.buf_b, self.height, self.width).expect("pipeline buf_b invariant");
            median_filter(buf_b_view, output, ksize)?;
        }

        Ok(shift)
    }
}
