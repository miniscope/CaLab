//! Per-cell evidence that accumulates after a cell enters the library.
//!
//! Every frame the fast loop solves the traces with the library it had
//! *before* that frame arrived, so each frame after a cell's birth is a
//! held-out test of it (prequential evaluation). The ledger reads, per
//! cell, an unconstrained trace coordinate `u_t` (the fast loop's trace plus
//! the residual projected onto the cell's filtered footprint, so noise is
//! symmetric about the truth instead of clipped at zero) and counts
//! excursions of `u_t` from a running baseline in units of a running noise
//! scale:
//!
//! * a **transient** is a run of frames above +2 σ that peaks above
//!   `event_z` σ and lasts at least `event_frames` frames;
//! * a **dip** is the mirror image (below −2 σ, trough below −`event_z` σ).
//!
//! White noise almost never makes either (three frames in a row above 2 σ
//! is ~1e-5 per frame). Transients mark the frames where a cell claims
//! activity; the slow loop stores those that are held-out frames as
//! *probes* and tests on them whether the cell's footprint is needed (see
//! `SlowLoop::keep_tests`). Dips are reported but not used for decisions:
//! on real data, crosstalk with overlapping neighbours makes true cells in
//! dense regions dip more often than junk does.

/// Where a cell stands in the slow loop's evidence ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CellStatus {
    /// Added recently and not yet confirmed by transients after its birth.
    Probation,
    /// Has shown enough transients (and few enough dips) after its birth.
    Established,
}

impl CellStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CellStatus::Probation => "probation",
            CellStatus::Established => "established",
        }
    }
}

/// Why a cell was removed from the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeleteReason {
    /// No transients after its birth within the probation window.
    Silent,
    /// On held-out frames where the fast loop says it fired, a smooth local
    /// background explains the signal about as well as its footprint does
    /// (diffuse light, neuropil, a neighbour's halo, a noise pattern).
    Unsupported,
}

impl DeleteReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DeleteReason::Silent => "silent",
            DeleteReason::Unsupported => "unsupported",
        }
    }
}

/// The evidence the slow loop holds on one cell of its working set.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellInfo {
    pub id: u64,
    /// Frame at which the cell entered the working set.
    pub born: u64,
    pub status: CellStatus,
    /// Frames the fast loop has solved with this cell in its library.
    pub frames: u64,
    /// Transients after birth.
    pub transients: u32,
    /// Dips after birth.
    pub dips: u32,
    /// Largest transient peak after birth, in noise units.
    pub peak_z: f32,
    /// Held-out probe frames (frames where it fired after its birth) on
    /// which its footprint was needed (`passes`), not needed because a
    /// smooth local background explained the signal (`fails`), or not
    /// needed because a neighbouring cell took the signal over
    /// (`redundant`: a duplicate or fragment, resolved by a merge test).
    pub passes: u32,
    pub fails: u32,
    pub redundant: u32,
    /// Centre (row, column) of the support, px.
    pub center: (f32, f32),
}

/// A cell the slow loop deleted, with the evidence it was deleted on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeletedCell {
    pub info: CellInfo,
    pub frame: u64,
    pub reason: DeleteReason,
}

/// Edit counts (since the last [`SlowLoop::take_edit_counts`](super::SlowLoop::take_edit_counts)).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditCounts {
    pub adds: u64,
    pub merges: u64,
    pub deletes: u64,
    pub refines: u64,
    /// Published library versions.
    pub commits: u64,
}

/// Running evidence of one published cell.
#[derive(Debug, Clone)]
pub(crate) struct Evidence {
    pub frames: u64,
    pub transients: u32,
    pub dips: u32,
    pub peak_z: f32,
    pub established: bool,
    pub passes: u32,
    pub fails: u32,
    /// Failed probes where a neighbour took over the signal, and which.
    pub redundant: u32,
    pub partner: Option<u64>,
    /// Frame of the last probe taken for this cell.
    pub last_probe: Option<u64>,
    /// `z` of the latest frame (after warm-up).
    pub z: f32,
    /// In a confirmed transient (at least `event_frames` frames above 2 σ,
    /// peaked beyond `event_z`) that has not been probed yet.
    pub probe_ready: bool,
    /// The current transient has been probed.
    pub run_probed: bool,
    pub base: f32,
    pub scale: f32,
    /// Last coordinate read.
    pub last_u: f32,
    /// Warm-up buffer (`Some` while warming up).
    warm: Option<Vec<f32>>,
    /// Sign of the run in progress (0 = none), its length and extreme.
    run: i8,
    run_len: u32,
    run_peak: f32,
}

/// Frames the trackers start from.
const WARM: usize = 32;
/// Longest excursion (frames) during which the trackers stay frozen.
const MAX_FREEZE: u32 = 100;

impl Evidence {
    pub fn new() -> Evidence {
        Evidence {
            frames: 0,
            transients: 0,
            dips: 0,
            peak_z: 0.0,
            established: false,
            passes: 0,
            fails: 0,
            redundant: 0,
            partner: None,
            last_probe: None,
            z: 0.0,
            probe_ready: false,
            run_probed: false,
            base: 0.0,
            scale: 0.0,
            last_u: 0.0,
            warm: Some(Vec::with_capacity(WARM)),
            run: 0,
            run_len: 0,
            run_peak: 0.0,
        }
    }

    /// One frame: `u` the unconstrained coordinate, `floor` its noise σ
    /// from the noise map alone (the scale never drops below it).
    pub fn update(&mut self, u: f32, floor: f32, event_z: f32, event_frames: u32) {
        if !u.is_finite() {
            return;
        }
        let floor = floor.max(1e-12);
        self.last_u = u;
        self.frames += 1;
        // Warm-up (at birth, and again whenever the cell's footprint
        // changes): the baseline starts at a low quantile of the first
        // frames (a cell is often born during a transient) and the scale
        // at the robust spread of their frame-to-frame differences.
        if let Some(buf) = self.warm.as_mut() {
            buf.push(u);
            if buf.len() < WARM {
                return;
            }
            let mut d: Vec<f32> = buf.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
            buf.sort_by(f32::total_cmp);
            self.base = buf[buf.len() * 3 / 10];
            let mid = d.len() / 2;
            let (_, m, _) = d.select_nth_unstable_by(mid, f32::total_cmp);
            self.scale = (*m / 0.6745 / std::f32::consts::SQRT_2).max(floor);
            self.warm = None;
            return;
        }
        let s = self.scale.max(floor);
        let z = (u - self.base) / s;
        self.z = z;
        // Baseline: a median tracker; scale: a median-|z| tracker (0.6745 σ
        // for Gaussian noise). Both are frozen during a positive excursion
        // beyond 2 σ, so a calcium transient does not lift the baseline nor
        // inflate the scale, but only for `MAX_FREEZE` frames, so a
        // baseline that ended up too low recovers.
        let frozen = z >= 2.0 && self.run_len < MAX_FREEZE;
        if !frozen {
            self.base += 0.02 * s * z.clamp(-1.0, 1.0);
            if z.abs() > 0.6745 {
                self.scale = s * 1.01;
            } else {
                self.scale = (s * 0.99).max(floor);
            }
        }
        // Runs above +2 σ / below −2 σ.
        let sign: i8 = if z > 2.0 {
            1
        } else if z < -2.0 {
            -1
        } else {
            0
        };
        if sign != self.run {
            self.close(event_z, event_frames);
            self.run = sign;
        }
        if sign != 0 {
            self.run_len += 1;
            self.run_peak = self.run_peak.max(z.abs());
        }
        self.probe_ready = sign > 0
            && self.run_len >= event_frames
            && self.run_peak >= event_z
            && !self.run_probed;
    }

    /// The cell's footprint changed (refined or merged): its coordinate has
    /// a new scale, so the trackers start over (the counts are kept).
    pub fn rewarm(&mut self) {
        self.run = 0;
        self.run_len = 0;
        self.run_peak = 0.0;
        self.warm = Some(Vec::with_capacity(WARM));
    }

    fn close(&mut self, event_z: f32, event_frames: u32) {
        if self.run != 0 && self.run_peak >= event_z && self.run_len >= event_frames {
            if self.run > 0 {
                self.transients += 1;
                self.peak_z = self.peak_z.max(self.run_peak);
            } else {
                self.dips += 1;
            }
        }
        self.run = 0;
        self.run_len = 0;
        self.run_peak = 0.0;
        self.run_probed = false;
    }

    /// Combine the evidence of two merged cells (the merged cell inherits
    /// the stronger record).
    pub fn absorb(&mut self, o: &Evidence) {
        if o.transients > self.transients {
            let (fr, est) = (self.frames.max(o.frames), self.established || o.established);
            let (p, f) = (self.passes + o.passes, self.fails + o.fails);
            *self = o.clone();
            self.frames = fr;
            self.established = est;
            self.passes = p;
            self.fails = f;
        } else {
            self.frames = self.frames.max(o.frames);
            self.established |= o.established;
            self.passes += o.passes;
            self.fails += o.fails;
        }
    }
}
