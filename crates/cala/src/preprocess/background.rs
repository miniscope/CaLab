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

    /// Stop updating; [`Self::process`] then subtracts the current floor only.
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
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

    /// Drop stored snapshots (they can be large).
    pub fn clear_snapshots(&mut self) {
        self.snapshots.clear();
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
}
