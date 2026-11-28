//! Params for `qc_eval`'s flags, which name engine values in frames and
//! absolute pixels.
//!
//! A flag leaves every value it does not set at the engine's own value,
//! which differs from the [`CalaParams`] default in three places: the
//! cluster replay and the merge guard are off, and so is look-back. The
//! ring and the margin of the slow loop are absolute pixel sizes there,
//! whatever the cell diameter. [`engine_params`] gives that configuration.

use super::{CalaParams, ClusterUpdate};

/// The slow loop's ring radii and tile margin at any cell diameter, px.
pub const ENGINE_RING_PX: [f64; 2] = [12.0, 20.0];
/// See [`ENGINE_RING_PX`].
pub const ENGINE_MARGIN_PX: u32 = 24;

/// The engine's own configuration, as params: [`CalaParams::default`] with
/// the cluster replay, the merge guard and look-back off.
pub fn engine_params() -> CalaParams {
    let mut p = CalaParams::default();
    p.discover.cluster.update = ClusterUpdate::Off;
    p.discover.merge.guard_min_sep_d = None;
    p.lookback.enabled = false;
    p
}

/// Set the cell diameter (px) and keep the slow loop's ring and margin at
/// their pixel sizes ([`ENGINE_RING_PX`], [`ENGINE_MARGIN_PX`]), as
/// `qc_eval`'s flags keep them. The ratios are chosen so that
/// `ratio × d` gives the pixel size back exactly in f32.
pub fn set_diameter_fixed_ring(p: &mut CalaParams, d: f64) {
    p.scales.cell_diameter_px = Some(d);
    p.discover.ring.inner_per_d = ENGINE_RING_PX[0] / d;
    p.discover.ring.outer_per_d = ENGINE_RING_PX[1] / d;
    p.discover.margin_px = Some(ENGINE_MARGIN_PX);
}

/// A duration a flag counts in frames at the recording's `fps`, as the
/// seconds [`super::resolve::resolve`] converts back to those frames.
pub fn frames_to_seconds(fps: f64, frames: f64) -> f64 {
    frames / fps
}
