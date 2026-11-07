//! The frame reservoir: per tile, a bounded set of whitened patches of past
//! preprocessed frames, chosen to keep the frames with the strongest
//! unexplained signal (event slots, whose priority fades with age so late
//! events displace old ones) plus a uniform sample of all frames (random
//! slots). Every frame is assigned to the fitting or the held-out side by a
//! hash of its index, once, so a hypothesis is never tested on the frames
//! used to fit it.

use super::local::Rect;

/// Patches are stored as `round(z * QUANT)` in `i16` (z = value / noise σ):
/// a resolution of 1/16 σ and a range of ±2048 σ.
pub(crate) const QUANT: f32 = 16.0;

#[derive(Debug, Clone)]
pub(crate) struct Slot {
    pub frame: u64,
    pub score: f32,
    pub test: bool,
    pub data: Vec<i16>,
    /// Background projections and energy, filled lazily by the slow loop.
    pub proj: Option<(Vec<f64>, f64)>,
}

impl Slot {
    pub fn values(&self, out: &mut Vec<f32>) {
        out.clear();
        out.extend(self.data.iter().map(|&v| f32::from(v) / QUANT));
    }
}

/// splitmix64.
pub(crate) fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// A held-out frame on which some of the tile's cells fired (by the fast
/// loop's trace), kept until the next visit tests those cells on it.
#[derive(Debug, Clone)]
pub(crate) struct Probe {
    pub slot: Slot,
    pub cells: Vec<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct Tile {
    /// The pixels this tile is responsible for (candidates are centred here).
    pub core: Rect,
    /// `core` plus the margin: the stored patch.
    pub rect: Rect,
    pub events: Vec<Slot>,
    pub randoms: Vec<Slot>,
    /// Frames offered to the random sample.
    pub seen: u64,
    /// New slots since the tile was last visited (scheduling priority).
    pub fresh: u32,
    /// Spots recently rejected: `(y, x, until_frame, rejections)`.
    pub rejected: Vec<(f32, f32, u64, u32)>,
    /// Spots where a cell was deleted: `(y, x, frame, deletions)`. A new
    /// cell there needs held-out events from after the deletion.
    pub tombs: Vec<(f32, f32, u64, u32)>,
    pub probes: Vec<Probe>,
    pub last_visit: u64,
}

impl Tile {
    pub fn new(core: Rect, rect: Rect) -> Tile {
        Tile {
            core,
            rect,
            events: Vec::new(),
            randoms: Vec::new(),
            seen: 0,
            fresh: 0,
            rejected: Vec::new(),
            tombs: Vec::new(),
            probes: Vec::new(),
            last_visit: 0,
        }
    }

    fn copy(&self, z: &[f32], width: usize, frame: u64, score: f32, test: bool) -> Slot {
        let r = self.rect;
        let mut data = Vec::with_capacity(r.len());
        for y in 0..r.h {
            let row = (r.y0 + y) * width + r.x0;
            data.extend(
                z[row..row + r.w]
                    .iter()
                    .map(|&v| (v * QUANT).round().clamp(-32767.0, 32767.0) as i16),
            );
        }
        Slot {
            frame,
            score,
            test,
            data,
            proj: None,
        }
    }

    /// Offer frame `frame` (whitened, full frame `z`) with this tile's
    /// residual `score`. `decay` is the per-frame priority decay of event
    /// slots; `rand` a fresh random number.
    #[allow(clippy::too_many_arguments)]
    pub fn offer(
        &mut self,
        z: &[f32],
        width: usize,
        frame: u64,
        score: f32,
        test: bool,
        cap_events: usize,
        cap_random: usize,
        decay: f64,
        rand: u64,
    ) {
        // Event slots.
        if cap_events > 0 {
            let prio = |s: &Slot| f64::from(s.score) * decay.powf((frame - s.frame) as f64);
            // Neighbouring frames of one transient: keep the stronger.
            if let Some(i) = self.events.iter().position(|s| frame - s.frame <= 2) {
                if score > self.events[i].score {
                    self.events[i] = self.copy(z, width, frame, score, test);
                    self.fresh += 1;
                }
            } else if self.events.len() < cap_events {
                self.events.push(self.copy(z, width, frame, score, test));
                self.fresh += 1;
            } else {
                let (imin, pmin) = self
                    .events
                    .iter()
                    .enumerate()
                    .map(|(i, s)| (i, prio(s)))
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .expect("non-empty");
                if f64::from(score) > pmin {
                    self.events[imin] = self.copy(z, width, frame, score, test);
                    self.fresh += 1;
                }
            }
        }
        // Uniform sample of all frames (reservoir sampling).
        if cap_random > 0 {
            self.seen += 1;
            if self.randoms.len() < cap_random {
                self.randoms.push(self.copy(z, width, frame, score, test));
            } else {
                let j = (rand % self.seen) as usize;
                if j < cap_random {
                    self.randoms[j] = self.copy(z, width, frame, score, test);
                }
            }
        }
    }

    /// Store frame `frame` as a probe for `cells` (the oldest probe goes
    /// when `cap` are held).
    pub fn probe(&mut self, z: &[f32], width: usize, frame: u64, cells: Vec<u64>, cap: usize) {
        if cap == 0 || cells.is_empty() {
            return;
        }
        if self.probes.len() >= cap {
            self.probes.remove(0);
        }
        let slot = self.copy(z, width, frame, 0.0, true);
        self.probes.push(Probe { slot, cells });
        self.fresh += 1;
    }

    /// Indices of the distinct stored frames: `(is_event, index)`.
    pub fn slots(&self) -> Vec<(bool, usize)> {
        let mut out: Vec<(bool, usize)> = (0..self.events.len()).map(|i| (true, i)).collect();
        for (i, s) in self.randoms.iter().enumerate() {
            if !self.events.iter().any(|e| e.frame == s.frame) {
                out.push((false, i));
            }
        }
        out
    }

    pub fn slot(&self, which: (bool, usize)) -> &Slot {
        if which.0 {
            &self.events[which.1]
        } else {
            &self.randoms[which.1]
        }
    }

    pub fn slot_mut(&mut self, which: (bool, usize)) -> &mut Slot {
        if which.0 {
            &mut self.events[which.1]
        } else {
            &mut self.randoms[which.1]
        }
    }

    pub fn bytes(&self) -> usize {
        (self.events.len() + self.randoms.len() + self.probes.len()) * self.rect.len() * 2
    }
}
