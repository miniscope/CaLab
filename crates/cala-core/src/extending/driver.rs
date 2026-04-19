//! One-shot extend cycle driver (design §3 extend loop).
//!
//! This is the coordinator that stitches the extend submodules
//! together: variance map → argmax patch → rank-1 NMF → class gates →
//! redundancy check → mutation push. It mirrors exactly what the
//! Phase 3 cold-start E2E test drove inline. Extracting it here
//! lets both the test and the WASM bindings (`Extender`) share one
//! code path — one place to tune, one place to reason about
//! numerical parity across targets.
//!
//! The driver is stateless: callers pass in the residual window,
//! the current fit snapshot, and the mutation queue. Per-cycle
//! bookkeeping (`proposals_per_cycle_max`, patch variance cutoff,
//! etc.) comes from `ExtendConfig`.

use crate::buffers::bipbuf::ResidualRingBuf;
use crate::config::{ExtendConfig, RecordingMetadata};
use crate::extending::mutation::{MutationQueue, PipelineMutation};
use crate::extending::overlap::{overlap_fraction, patch_to_frame_support};
use crate::extending::redundancy::pearson_correlation;
use crate::extending::segment::{
    argmax_yx, classify_candidate, extract_patch_stack, patch_bounds, rank1_nmf, variance_map,
    ClassDecision,
};
use crate::fitting::FitPipeline;

/// Run a single extend cycle: up to `proposals_per_cycle_max`
/// candidate footprints are proposed and pushed onto `queue`.
/// Returns the number of mutations added to the queue.
pub fn run_cycle(
    buf: &ResidualRingBuf,
    pipeline: &FitPipeline,
    height: usize,
    width: usize,
    recording: &RecordingMetadata,
    extend_cfg: &ExtendConfig,
    queue: &mut MutationQueue,
) -> u32 {
    if buf.is_empty() {
        return 0;
    }
    let mut vmap = variance_map(buf);
    let radius_px = (extend_cfg.patch_radius_diameters * recording.neuron_diameter_um
        / recording.pixel_size_um) as usize;
    let radius_px = radius_px.max(2);

    let mut proposals = 0u32;
    let snap_epoch = pipeline.epoch();

    while proposals < extend_cfg.proposals_per_cycle_max {
        let Some((cy, cx, max_var)) = argmax_yx(&vmap, height, width) else {
            break;
        };
        if max_var < extend_cfg.patch_min_variance {
            break;
        }
        let (y_range, x_range) = patch_bounds(cy, cx, radius_px, height, width);
        let patch_h = y_range.end - y_range.start;
        let patch_w = x_range.end - x_range.start;
        let stack = extract_patch_stack(buf, height, width, y_range.clone(), x_range.clone());
        let nmf = rank1_nmf(
            &stack,
            buf.len(),
            patch_h * patch_w,
            extend_cfg.nmf_max_iter,
            extend_cfg.nmf_tol,
        );
        let decision = classify_candidate(&nmf, recording, extend_cfg, patch_h, patch_w);

        // Zero out this patch in vmap so the next iteration finds a
        // new region — same effect as thesis Alg 9 line 12.
        for y in y_range.clone() {
            for x in x_range.clone() {
                vmap[y * width + x] = 0.0;
            }
        }

        let class = match decision {
            ClassDecision::Accept { class, .. } => class,
            ClassDecision::Reject(_) => continue,
        };

        let support = patch_to_frame_support(
            &nmf.a,
            patch_h,
            patch_w,
            y_range.clone(),
            x_range.clone(),
            width,
            extend_cfg.footprint_support_threshold_rel,
        );
        if support.is_empty() {
            continue;
        }
        let a_max = nmf.a.iter().cloned().fold(0.0f32, f32::max);
        let cutoff = extend_cfg.footprint_support_threshold_rel * a_max;
        let mut values = Vec::with_capacity(support.len());
        for py in 0..patch_h {
            for px in 0..patch_w {
                let v = nmf.a[py * patch_w + px];
                if v > cutoff {
                    values.push(v);
                }
            }
        }

        let fp = pipeline.footprints();
        let mut is_redundant = false;
        for i in 0..fp.len() {
            let existing_support = fp.support(i);
            if overlap_fraction(&support, existing_support) < extend_cfg.overlap_fraction_min {
                continue;
            }
            let existing_col = pipeline.traces().column(i);
            let window = nmf.c.len();
            if existing_col.len() < window {
                continue;
            }
            let start = existing_col.len() - window;
            let r = pearson_correlation(&existing_col[start..], &nmf.c);
            if r >= extend_cfg.trace_corr_min {
                is_redundant = true;
                break;
            }
        }
        if is_redundant {
            continue;
        }

        queue.push(PipelineMutation::Register {
            snapshot_epoch: snap_epoch,
            class,
            support,
            values,
            trace: nmf.c.clone(),
        });
        proposals += 1;
    }
    proposals
}
