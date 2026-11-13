//! Background: a robust running minimum per pixel, in tissue coordinates.
//!
//! After flattening, what is left under a cell is a static floor: the cell's
//! own resting fluorescence, neuropil and tissue texture finer than the
//! flattening σ. A cell is "on" when it rises above that floor, so the floor is
//! estimated per pixel as a running minimum over time and subtracted, the
//! approach of Raymond's original cala. It runs **after motion correction**:
//! the floor belongs to a piece of tissue, and only registered frames keep a
//! piece of tissue on the same pixel. It takes already-registered frames.
//!
//! # Method
//!
//! ```text
//! s_t = mean(x_{t-k+1} .. x_t)                     boxcar of the last k frames
//! b_t = s_t                                        if s_t < b_{t-1}
//!     = b_{t-1} + α (s_t − b_{t-1})                otherwise (α = 1/relax_frames)
//! out = x_t − b_t
//! ```
//!
//! * **Boxcar before the minimum.** A minimum is an extreme-value statistic,
//!   so a raw per-frame minimum is pulled down by every negative noise
//!   excursion and by single dim frames. Averaging k frames first divides the
//!   noise by √k and caps a one-frame dip at 1/k of its depth. k = 5 (0.25 s
//!   at 20 fps) is shorter than any calcium transient, so it does not let a
//!   cell's activity into the floor. While fewer than k frames have been
//!   seen, the floor is just the running average.
//! * **Upward relaxation.** A pure minimum only ever goes down. That handles
//!   a downward step in baseline brightness (the workshop CA1 data drops from
//!   ~53 to ~41 at file 2) and bleaching, but it has two failure modes:
//!   1. *A rising baseline is never tracked.* If the floor rises (LED drift
//!      up, a change of focus, recovery after a dim period) the old, lower
//!      minimum stays, and everything after the rise reads as permanent
//!      activity above background.
//!   2. *The floor keeps sinking.* Over a long recording the minimum of the
//!      noise keeps finding new extremes (the expected minimum of N Gaussian
//!      samples falls like √(2 ln N)), so the subtracted background drifts
//!      down by a slowly growing amount, a non-stationary bias.
//!
//!   The leak `b += α (s − b)` when `s ≥ b` fixes both: a rise is followed
//!   with time constant `relax_frames`, and the floor settles at a stationary
//!   low quantile of `s` (balance of the slow leak against the downward
//!   snaps; about 2.7 σ_s below the mean for α = 1/2400) instead of drifting.
//!   The leak must be slow next to sustained activity, which it would
//!   otherwise absorb: a cell held on for `d` frames lifts its own floor by a
//!   fraction ≈ d/relax_frames of its amplitude, and the floor snaps back down
//!   as soon as the cell returns to rest. Default `relax_frames` = 2400
//!   (120 s at 20 fps): a 5 s burst loses about 4 % of its amplitude at its
//!   end, while a baseline rise is 95 % tracked after 3 · 120 s = 6 min.
//!   `relax_frames = 0` disables the leak (pure running minimum).
//!
//! # State, snapshots and replay
//!
//! The state ([`BackgroundState`]) is the k-frame ring buffer, the floor image
//! and a frame counter: `(k + 1) · W · H` floats (8.6 MB at 600x600, k = 5).
//! Restoring a state and feeding the same frames reproduces the outputs bit
//! for bit. With `snapshot_every > 0` the stage keeps a copy of its state
//! every that many frames, so pass 2 can replay any frame by restoring the
//! nearest earlier snapshot and stepping forward; mind the memory (one state
//! per snapshot). Pass 2 normally uses [`RunningMinBackground::final_estimate`]
//! instead: the floor at the end of pass 1, which has seen the whole
//! recording, frozen with [`RunningMinBackground::freeze`].

use super::{Dims, PreprocessError};

/// Default boxcar length in frames.
pub const DEFAULT_BOXCAR: usize = 5;
/// Default relaxation time constant in seconds (see the module docs).
pub const DEFAULT_RELAX_S: f32 = 120.0;
/// Pixels per block of the fused update loop.
const BLOCK: usize = 1024;
/// Default frame rate used when none is given.
pub const DEFAULT_FPS: f32 = 20.0;

/// Settings for [`RunningMinBackground`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundConfig {
    /// Frames averaged before the minimum (≥ 1).
    pub boxcar: usize,
    /// Upward relaxation time constant in frames (0 = pure minimum).
    pub relax_frames: f32,
    /// Keep a state snapshot every this many frames (0 = never).
    pub snapshot_every: u32,
}

impl Default for BackgroundConfig {
    fn default() -> BackgroundConfig {
        BackgroundConfig::for_fps(DEFAULT_FPS)
    }
}

impl BackgroundConfig {
    /// Defaults with the relaxation time converted at `fps` (falls back to
    /// [`DEFAULT_FPS`] for a non-positive or non-finite rate).
    pub fn for_fps(fps: f32) -> BackgroundConfig {
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            DEFAULT_FPS
        };
        BackgroundConfig {
            boxcar: DEFAULT_BOXCAR,
            relax_frames: DEFAULT_RELAX_S * fps,
            snapshot_every: 0,
        }
    }

    pub fn validate(&self) -> Result<(), PreprocessError> {
        if self.boxcar == 0 || self.boxcar > 256 {
            return Err(PreprocessError::InvalidConfig(format!(
                "background boxcar must be in 1..=256, got {}",
                self.boxcar
            )));
        }
        if !(self.relax_frames.is_finite()
            && (self.relax_frames == 0.0 || self.relax_frames >= 1.0))
        {
            return Err(PreprocessError::InvalidConfig(format!(
                "background relax_frames must be 0 or >= 1, got {}",
                self.relax_frames
            )));
        }
        Ok(())
    }
}

/// Everything needed to resume the stage exactly.
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundState {
    pub(crate) dims: Dims,
    pub(crate) boxcar: usize,
    /// `boxcar` frames, slot-major.
    pub(crate) ring: Vec<f32>,
    /// Next slot to write.
    pub(crate) ring_pos: usize,
    /// Slots holding data (≤ boxcar).
    pub(crate) ring_filled: usize,
    /// The floor `b`.
    pub(crate) floor: Vec<f32>,
    /// Frames fed so far.
    pub(crate) frames: u64,
}

impl BackgroundState {
    fn new(dims: Dims, boxcar: usize) -> BackgroundState {
        BackgroundState {
            dims,
            boxcar,
            ring: vec![0.0; boxcar * dims.pixels()],
            ring_pos: 0,
            ring_filled: 0,
            floor: vec![0.0; dims.pixels()],
            frames: 0,
        }
    }

    /// Frames fed when this state was taken.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// The floor image.
    pub fn floor(&self) -> &[f32] {
        &self.floor
    }

    pub(crate) fn check(&self) -> Result<(), PreprocessError> {
        let n = self.dims.pixels();
        if self.boxcar == 0
            || self.ring.len() != self.boxcar * n
            || self.floor.len() != n
            || self.ring_pos >= self.boxcar
            || self.ring_filled > self.boxcar
        {
            return Err(PreprocessError::InvalidState(
                "background state sizes are inconsistent".into(),
            ));
        }
        Ok(())
    }
}

/// A state copy taken after `state.frames()` frames.
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundSnapshot {
    pub state: BackgroundState,
}

/// Per-frame numbers from [`RunningMinBackground::process`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BackgroundStats {
    /// Mean of the floor that was subtracted.
    pub floor_mean: f32,
    /// Fraction of pixels whose floor snapped down this frame.
    pub lowered_fraction: f32,
    /// A snapshot was stored after this frame.
    pub snapshot: bool,
}

/// The running-minimum background stage.
#[derive(Debug, Clone)]
pub struct RunningMinBackground {
    cfg: BackgroundConfig,
    alpha: f32,
    st: BackgroundState,
    smooth: Vec<f32>,
    /// Known (non-NaN) ring slots per pixel ([`Self::process_masked`]),
    /// kept up to date while `known_ok`: a slot, once known, stays known.
    known: Vec<f32>,
    known_ok: bool,
    frozen: bool,
    snapshots: Vec<BackgroundSnapshot>,
}

impl RunningMinBackground {
    pub fn new(
        dims: Dims,
        cfg: &BackgroundConfig,
    ) -> Result<RunningMinBackground, PreprocessError> {
        cfg.validate()?;
        Ok(RunningMinBackground {
            cfg: *cfg,
            alpha: if cfg.relax_frames > 0.0 {
                1.0 / cfg.relax_frames
            } else {
                0.0
            },
            st: BackgroundState::new(dims, cfg.boxcar),
            smooth: vec![0.0; BLOCK],
            known: Vec::new(),
            known_ok: false,
            frozen: false,
            snapshots: Vec::new(),
        })
    }

    pub fn config(&self) -> &BackgroundConfig {
        &self.cfg
    }

    /// Update the floor with `frame`, then subtract it from `frame` in place.
    /// When frozen, only subtracts.
    pub fn process(&mut self, frame: &mut [f32]) -> Result<BackgroundStats, PreprocessError> {
        self.st.dims.check("frame", frame.len())?;
        let mut stats = BackgroundStats::default();
        let floor_sum = if self.frozen {
            let mut sum = 0.0f64;
            for (v, &b) in frame.iter_mut().zip(&self.st.floor) {
                *v -= b;
                sum += f64::from(b);
            }
            sum
        } else {
            let (sum, lowered) = self.update_and_subtract(frame);
            stats.lowered_fraction = lowered;
            if self.cfg.snapshot_every > 0
                && self
                    .st
                    .frames
                    .is_multiple_of(u64::from(self.cfg.snapshot_every))
            {
                self.snapshots.push(BackgroundSnapshot {
                    state: self.st.clone(),
                });
                stats.snapshot = true;
            }
            sum
        };
        stats.floor_mean = (floor_sum / self.st.floor.len().max(1) as f64) as f32;
        Ok(stats)
    }

    /// Push the frame into the boxcar, update the floor and subtract it, in
    /// one pass over the pixels (blocks of [`BLOCK`], so the k ring slots,
    /// the floor and the frame stay in cache together). Returns the sum of the
    /// floor and the fraction of pixels that snapped down.
    fn update_and_subtract(&mut self, frame: &mut [f32]) -> (f64, f32) {
        let n = self.st.dims.pixels();
        let k = self.st.boxcar;
        let slot = self.st.ring_pos;
        self.st.ring_pos = (slot + 1) % k;
        self.st.ring_filled = (self.st.ring_filled + 1).min(k);
        self.st.frames += 1;
        let filled = self.st.ring_filled;
        let inv = 1.0 / filled as f32;
        let warming = filled < k;
        let alpha = self.alpha;
        let ring = &mut self.st.ring;
        let floor = &mut self.st.floor;
        let smooth = &mut self.smooth;
        let mut sum = 0.0f64;
        let mut lowered = 0usize;
        let mut start = 0;
        while start < n {
            let end = (start + BLOCK).min(n);
            let len = end - start;
            let fr = &mut frame[start..end];
            ring[slot * n + start..slot * n + end].copy_from_slice(fr);
            // Boxcar sum over the filled slots, in slot order.
            let acc = &mut smooth[..len];
            acc.copy_from_slice(&ring[start..end]);
            for s in 1..filled {
                for (a, &v) in acc.iter_mut().zip(&ring[s * n + start..s * n + end]) {
                    *a += v;
                }
            }
            let fl = &mut floor[start..end];
            let mut block_sum = 0.0f32;
            if warming {
                for ((b, &a), v) in fl.iter_mut().zip(acc.iter()).zip(fr.iter_mut()) {
                    *b = a * inv;
                    *v -= *b;
                    block_sum += *b;
                }
            } else {
                let mut low = 0u32;
                for ((b, &a), v) in fl.iter_mut().zip(acc.iter()).zip(fr.iter_mut()) {
                    let s = a * inv;
                    let down = s < *b;
                    low += u32::from(down);
                    *b = if down { s } else { *b + alpha * (s - *b) };
                    *v -= *b;
                    block_sum += *b;
                }
                lowered += low as usize;
            }
            sum += f64::from(block_sum);
            start = end;
        }
        (sum, lowered as f32 / n as f32)
    }

    /// [`Self::process`] where only the pixels with `valid != 0` hold data.
    ///
    /// * **Boxcar.** A missing sample leaves the boxcar alone: each slot
    ///   keeps the pixel's latest valid sample written there, so the boxcar
    ///   averages `boxcar` valid samples (fewer only until it has seen that
    ///   many; unknown slots are NaN). The floor statistic is then the same
    ///   for a pixel valid in few frames as for one valid in all (averaging
    ///   fewer samples, its minimum would sit lower).
    /// * **Floor.** It moves only on frames where the pixel is valid, and is
    ///   unknown (NaN) until the pixel's first valid sample.
    /// * **Output.** A valid pixel gets `x − b` as in [`Self::process`]. A
    ///   missing one gets its recent level, `s − b` with `s` the boxcar of
    ///   its latest valid samples: no data, but no step either. (Filled with
    ///   0, a pixel that switches between data and none would switch between
    ///   its level above the floor, about 1.3 σ, and 0, an edge of false
    ///   events along the FOV edge; measured on the minisim motion
    ///   recordings.) It is NaN while the pixel has no valid sample yet, and
    ///   when frozen (pass 2), where the boxcar is not current.
    ///
    /// Start a recording in this mode (the first frame sets it up) and do
    /// not mix it with [`Self::process`].
    pub fn process_masked(
        &mut self,
        frame: &mut [f32],
        valid: &[u8],
    ) -> Result<BackgroundStats, PreprocessError> {
        self.st.dims.check("frame", frame.len())?;
        self.st.dims.check("validity mask", valid.len())?;
        let mut stats = BackgroundStats::default();
        if self.frozen {
            for ((v, &b), &ok) in frame.iter_mut().zip(&self.st.floor).zip(valid) {
                *v = if ok != 0 { *v - b } else { f32::NAN };
            }
        } else {
            if self.st.frames == 0 {
                self.st.floor.fill(f32::NAN);
                self.st.ring.fill(f32::NAN);
            }
            stats.lowered_fraction = self.update_and_subtract_masked(frame, valid);
            if self.cfg.snapshot_every > 0
                && self
                    .st
                    .frames
                    .is_multiple_of(u64::from(self.cfg.snapshot_every))
            {
                self.snapshots.push(BackgroundSnapshot {
                    state: self.st.clone(),
                });
                stats.snapshot = true;
            }
        }
        // Mean of the known floor. Eight running sums, branch-free: a single
        // sequential f64 sum is latency-bound and cost as much as the update.
        let (mut sums, mut counts) = ([0.0f64; 8], [0.0f64; 8]);
        for ch in self.st.floor.chunks(8) {
            for ((s, c), &b) in sums.iter_mut().zip(counts.iter_mut()).zip(ch) {
                let known = b.is_finite();
                *s += if known { f64::from(b) } else { 0.0 };
                *c += if known { 1.0 } else { 0.0 };
            }
        }
        let sum: f64 = sums.iter().sum();
        let known = counts.iter().sum::<f64>() as usize;
        stats.floor_mean = (sum / known.max(1) as f64) as f32;
        Ok(stats)
    }

    /// [`Self::update_and_subtract`] with missing samples (see
    /// [`Self::process_masked`]), in blocks of [`BLOCK`] pixels with
    /// branch-free inner loops; returns the fraction of pixels lowered.
    fn update_and_subtract_masked(&mut self, frame: &mut [f32], valid: &[u8]) -> f32 {
        let n = self.st.dims.pixels();
        let k = self.st.boxcar;
        let slot = self.st.ring_pos;
        self.st.ring_pos = (slot + 1) % k;
        self.st.ring_filled = (self.st.ring_filled + 1).min(k);
        self.st.frames += 1;
        let filled = self.st.ring_filled;
        let warming = filled < k;
        let alpha = self.alpha;
        let ring = &mut self.st.ring;
        let floor = &mut self.st.floor;
        let acc = &mut self.smooth;
        // While the ring fills (and after a restore) the counts are taken
        // afresh; after, a slot's count changes only when a valid sample
        // lands in a slot that never held one.
        let recount = warming || !self.known_ok || self.known.len() != n;
        self.known.resize(n, 0.0);
        let known = &mut self.known;
        let mut lowered = 0usize;
        let mut start = 0;
        while start < n {
            let end = (start + BLOCK).min(n);
            let len = end - start;
            let fr = &mut frame[start..end];
            let ok = &valid[start..end];
            // Missing samples as NaN (their output is overwritten below), so
            // the loops read f32 only.
            for (x, &o) in fr.iter_mut().zip(ok) {
                *x = if o != 0 { *x } else { f32::NAN };
            }
            // This frame's valid samples enter their slot; missing ones leave it.
            let c = &mut known[start..end];
            for ((r, &x), cv) in ring[slot * n + start..slot * n + end]
                .iter_mut()
                .zip(fr.iter())
                .zip(c.iter_mut())
            {
                let good = x.is_finite();
                *cv += if good & r.is_nan() { 1.0 } else { 0.0 };
                *r = if good { x } else { *r };
            }
            if recount {
                c.fill(0.0);
                for s in 0..filled {
                    for (cv, &v) in c.iter_mut().zip(&ring[s * n + start..s * n + end]) {
                        *cv += if v.is_nan() { 0.0 } else { 1.0 };
                    }
                }
            }
            // Boxcar of the known samples, in slot order.
            let a = &mut acc[..len];
            a.fill(0.0);
            for s in 0..filled {
                for (av, &v) in a.iter_mut().zip(&ring[s * n + start..s * n + end]) {
                    *av += if v.is_nan() { 0.0 } else { v };
                }
            }
            let mut low = 0u32;
            for ((b, x), (&av, &cv)) in floor[start..end]
                .iter_mut()
                .zip(fr.iter_mut())
                .zip(a.iter().zip(c.iter()))
            {
                // NaN when the pixel has no sample yet.
                let s = av / cv;
                let good = x.is_finite();
                let down = s < *b;
                let next = if warming | b.is_nan() | down {
                    s
                } else {
                    *b + alpha * (s - *b)
                };
                low += u32::from(good & down & !warming);
                *b = if good { next } else { *b };
                *x = if good { *x - *b } else { s - *b };
            }
            lowered += low as usize;
            start = end;
        }
        self.known_ok = true;
        lowered as f32 / n as f32
    }

    /// Mean of the boxcar's filled slots per pixel (its finite samples; NaN
    /// where there are none): the level of the last few frames, the
    /// reference a session boundary fits the new session against
    /// ([`super::session`]).
    pub fn boxcar_mean(&self) -> Vec<f32> {
        self.boxcar_mean_counts().0
    }

    /// [`Self::boxcar_mean`] and the number of samples behind each pixel.
    pub fn boxcar_mean_counts(&self) -> (Vec<f32>, Vec<u32>) {
        let n = self.st.dims.pixels();
        let mut sum = vec![0.0f32; n];
        let mut cnt = vec![0u32; n];
        for s in 0..self.st.ring_filled {
            for ((a, c), &v) in sum
                .iter_mut()
                .zip(&mut cnt)
                .zip(&self.st.ring[s * n..(s + 1) * n])
            {
                if v.is_finite() {
                    *a += v;
                    *c += 1;
                }
            }
        }
        let mean = sum
            .iter()
            .zip(&cnt)
            .map(|(&a, &c)| if c > 0 { a / c as f32 } else { f32::NAN })
            .collect();
        (mean, cnt)
    }

    /// Map the state into a new brightness, `v ← gain · v + offset`, for the
    /// floor and every boxcar slot (a session boundary, see
    /// [`super::session`]). Missing (NaN) samples stay missing.
    pub fn rescale(&mut self, gain: f32, offset: f32) {
        for v in self.st.floor.iter_mut().chain(self.st.ring.iter_mut()) {
            *v = gain * *v + offset;
        }
    }

    /// Stop updating; [`Self::process`] then subtracts the current floor only.
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    /// The current floor (after the last frame): the "final" estimate when
    /// called at the end of pass 1.
    pub fn final_estimate(&self) -> &[f32] {
        &self.st.floor
    }

    /// A copy of the full state.
    pub fn state(&self) -> BackgroundState {
        self.st.clone()
    }

    /// Resume from a state (from [`Self::state`] or a snapshot). Unfreezes.
    pub fn restore(&mut self, state: &BackgroundState) -> Result<(), PreprocessError> {
        state.check()?;
        if state.dims != self.st.dims || state.boxcar != self.cfg.boxcar {
            return Err(PreprocessError::InvalidState(
                "background state does not match this stage's size or boxcar".into(),
            ));
        }
        self.st = state.clone();
        self.known_ok = false;
        self.frozen = false;
        Ok(())
    }

    /// Snapshots stored so far (oldest first).
    pub fn snapshots(&self) -> &[BackgroundSnapshot] {
        &self.snapshots
    }

    /// The latest snapshot taken at or before `frames` frames.
    pub fn snapshot_before(&self, frames: u64) -> Option<&BackgroundSnapshot> {
        self.snapshots
            .iter()
            .rev()
            .find(|s| s.state.frames <= frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic standard-normal-ish noise (sum of 12 uniforms − 6).
    struct Lcg(u64);
    impl Lcg {
        fn uniform(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32) / (1u64 << 24) as f32
        }
        fn normal(&mut self) -> f32 {
            (0..12).map(|_| self.uniform()).sum::<f32>() - 6.0
        }
    }

    fn run(cfg: &BackgroundConfig, frames: usize, level: impl Fn(usize) -> f32) -> Vec<f32> {
        let dims = Dims::new(8, 8).unwrap();
        let mut bg = RunningMinBackground::new(dims, cfg).unwrap();
        let mut rng = Lcg(1);
        let mut floor = Vec::new();
        for t in 0..frames {
            let mut f: Vec<f32> = (0..64).map(|_| level(t) + 3.0 * rng.normal()).collect();
            bg.process(&mut f).unwrap();
            floor.push(bg.final_estimate().iter().sum::<f32>() / 64.0);
        }
        floor
    }

    #[test]
    fn recovers_static_floor_and_ignores_flash_and_dim_frame() {
        let cfg = BackgroundConfig::default();
        let floor = run(&cfg, 3000, |t| match t {
            1000 => 15.0 + 40.0, // bright flash
            2000 => 15.0 - 40.0, // dim frame
            _ => 15.0,
        });
        let end = *floor.last().unwrap();
        // Stationary low quantile of the 5-frame boxcar (σ_s = 3/√5 ≈ 1.34):
        // a few σ_s below the true level, and the dim frame costs ≤ 40/5 = 8.
        assert!(end > 15.0 - 6.0 && end < 15.0, "floor {end}");
        assert!(floor[2001] > 15.0 - 8.0 - 6.0);
    }

    #[test]
    fn down_step_tracked_immediately_up_step_needs_relaxation() {
        let level = |t: usize| if t < 500 { 20.0 } else { 40.0 };
        let pure = BackgroundConfig {
            relax_frames: 0.0,
            ..BackgroundConfig::default()
        };
        let leaky = BackgroundConfig {
            relax_frames: 300.0,
            ..BackgroundConfig::default()
        };
        let f_pure = run(&pure, 2000, level);
        let f_leaky = run(&leaky, 2000, level);
        // Failure mode: the pure minimum never follows the rise.
        assert!(f_pure[1999] < 20.0, "pure min rose to {}", f_pure[1999]);
        // With relaxation, 3 time constants after the step it is within a few σ.
        assert!(f_leaky[500 + 900] > 40.0 - 6.0, "leaky {}", f_leaky[1400]);
        // A down-step is followed within the boxcar either way.
        let down = |t: usize| if t < 500 { 40.0 } else { 20.0 };
        let f = run(&pure, 520, down);
        assert!(f[510] < 20.0 + 1.0);
    }

    #[test]
    fn pure_minimum_keeps_sinking_leaky_is_stationary() {
        let pure = BackgroundConfig {
            relax_frames: 0.0,
            ..BackgroundConfig::default()
        };
        let f_pure = run(&pure, 6000, |_| 0.0);
        let f_leaky = run(&BackgroundConfig::default(), 6000, |_| 0.0);
        assert!(
            f_pure[5999] < f_pure[999] - 0.2,
            "{} vs {}",
            f_pure[5999],
            f_pure[999]
        );
        assert!((f_leaky[5999] - f_leaky[2999]).abs() < 0.6);
    }

    #[test]
    fn snapshot_restore_replays_exactly() {
        let dims = Dims::new(5, 4).unwrap();
        let cfg = BackgroundConfig {
            snapshot_every: 7,
            ..BackgroundConfig::default()
        };
        let mut bg = RunningMinBackground::new(dims, &cfg).unwrap();
        let mut rng = Lcg(9);
        let frames: Vec<Vec<f32>> = (0..40)
            .map(|_| (0..20).map(|_| 10.0 + rng.normal()).collect())
            .collect();
        let mut outs = Vec::new();
        for f in &frames {
            let mut g = f.clone();
            bg.process(&mut g).unwrap();
            outs.push(g);
        }
        assert_eq!(bg.snapshots().len(), 5);
        let snap = bg.snapshot_before(30).unwrap().clone();
        assert_eq!(snap.state.frames(), 28);
        let mut replay = RunningMinBackground::new(dims, &cfg).unwrap();
        replay.restore(&snap.state).unwrap();
        for t in 28..40 {
            let mut g = frames[t].clone();
            replay.process(&mut g).unwrap();
            assert_eq!(g, outs[t], "frame {t}");
        }
        // Frozen: subtracts without updating.
        replay.freeze();
        let before = replay.final_estimate().to_vec();
        let mut g = vec![-100.0; 20];
        replay.process(&mut g).unwrap();
        assert_eq!(replay.final_estimate(), &before[..]);
    }

    #[test]
    fn bad_config_and_state() {
        let dims = Dims::new(3, 3).unwrap();
        let bad = BackgroundConfig {
            boxcar: 0,
            ..BackgroundConfig::default()
        };
        assert!(RunningMinBackground::new(dims, &bad).is_err());
        let bad = BackgroundConfig {
            relax_frames: 0.5,
            ..BackgroundConfig::default()
        };
        assert!(RunningMinBackground::new(dims, &bad).is_err());
        let mut bg = RunningMinBackground::new(dims, &BackgroundConfig::default()).unwrap();
        assert!(bg.process(&mut [0.0; 2]).is_err());
        let other =
            RunningMinBackground::new(Dims::new(2, 2).unwrap(), &BackgroundConfig::default())
                .unwrap();
        assert!(bg.restore(&other.state()).is_err());
    }

    /// A pixel that holds data (level 50, σ 3) in some frames and 0 in
    /// others: unmasked, the zeros pull the floor down, so the data reads as
    /// a large event; masked, the floor is that of the data and the missing
    /// frames get the pixel's recent level (no step). A pixel never valid
    /// stays unknown (NaN).
    #[test]
    fn masked_floor_uses_valid_samples_only() {
        let dims = Dims::new(1, 2).unwrap();
        let cfg = BackgroundConfig::default();
        let mut masked = RunningMinBackground::new(dims, &cfg).unwrap();
        let mut plain = RunningMinBackground::new(dims, &cfg).unwrap();
        let mut rng = Lcg(3);
        let (mut out_valid, mut out_missing) = (Vec::new(), Vec::new());
        for t in 0..3000 {
            // Pixel 0 valid 7 frames in 10, missing first; pixel 1 never.
            let on = t % 10 >= 3;
            let v = 50.0 + 3.0 * rng.normal();
            let mut f = [if on { v } else { 0.0 }, 0.0];
            let mut g = f;
            masked.process_masked(&mut f, &[u8::from(on), 0]).unwrap();
            plain.process(&mut g).unwrap();
            assert_eq!(f[0].is_nan(), t < 3);
            assert!(f[1].is_nan());
            if t > 1000 {
                if on {
                    out_valid.push(f[0]);
                } else {
                    out_missing.push(f[0]);
                }
            }
        }
        let floor = masked.final_estimate()[0];
        assert!((floor - 50.0).abs() < 6.0, "{floor}");
        assert!(masked.final_estimate()[1].is_nan());
        assert!(plain.final_estimate()[0] < 25.0);
        // The valid output sits a few σ above 0, never a 50-unit event, and
        // the missing frames sit at the same level.
        let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
        let (mv, mm) = (mean(&out_valid), mean(&out_missing));
        assert!(mv > 0.0 && mv < 6.0, "{mv}");
        assert!((mm - mv).abs() < 0.5, "missing {mm} vs valid {mv}");
        // Frozen (pass 2): missing samples stay NaN.
        masked.freeze();
        let mut f = [50.0, 50.0];
        masked.process_masked(&mut f, &[0, 1]).unwrap();
        assert!(f[0].is_nan() && f[1].is_nan());
    }
}
