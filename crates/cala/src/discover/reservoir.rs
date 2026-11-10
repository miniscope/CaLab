//! The frame reservoir: a bounded set of whitened past preprocessed frames
//! per tile, chosen to keep the frames with the strongest unexplained signal
//! (event slots, per tile, whose priority fades with age so late events
//! displace old ones) plus a uniform sample of all frames (random slots).
//! The uniform sample is one sample for the whole frame, stored once as
//! full frames ([`SharedFrames`]) and read by every tile through its patch:
//! per-tile patches overlap about three times (core plus margin), so a
//! shared store holds the same sample in a third of the memory. Every frame
//! is assigned to the fitting or the held-out side by a hash of its index,
//! once, so a hypothesis is never tested on the frames used to fit it.

use super::local::Rect;

/// Patches are stored as `round(z * QUANT)` in `i16` (z = value / noise σ):
/// a resolution of 1/16 σ and a range of ±2048 σ.
pub(crate) const QUANT: f32 = 16.0;

#[derive(Debug, Clone)]
pub(crate) struct Slot {
    pub frame: u64,
    pub score: f32,
    pub test: bool,
    /// The patch (`Tile::rect`), quantised. Empty for a random slot of the
    /// slow loop that owns the reservoir: its pixels are frame `j` of the
    /// shared store ([`SharedFrames`], `j` = the slot's index), read with
    /// [`Tile::slot_values`]. A visit job carries the patch itself.
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

#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
#[inline]
pub(crate) fn quantize_round(v: f32) -> i16 {
    (v * QUANT).round().clamp(-32767.0, 32767.0) as i16
}

#[cfg(not(target_arch = "wasm32"))]
use quantize_round as quantize;
#[cfg(target_arch = "wasm32")]
use quantize_trunc as quantize;

/// `quantize_round` without `f32::round`, which WASM has no instruction
/// for (a libm call per pixel; this is ~8x faster there, a little slower
/// natively): `x − trunc(x)` is exact, so the rounding (half away from
/// zero) and the result are bit-identical.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
#[inline]
pub(crate) fn quantize_trunc(v: f32) -> i16 {
    let x = v * QUANT;
    let t = x.trunc();
    let r = if (x - t).abs() >= 0.5 {
        t + 1.0f32.copysign(x)
    } else {
        t
    };
    // NaN stays NaN through the clamp and casts to 0, as `as i16` does.
    r.clamp(-32767.0, 32767.0) as i32 as i16
}

/// Copy `r` out of the full frame `z` (row width `width`), quantised.
fn copy_rect(z: &[f32], width: usize, r: Rect, out: &mut Vec<i16>) {
    out.clear();
    out.reserve(r.len());
    for y in 0..r.h {
        let row = (r.y0 + y) * width + r.x0;
        out.extend(z[row..row + r.w].iter().map(|&v| quantize(v)));
    }
}

/// splitmix64.
pub(crate) fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// One frame of the shared uniform sample.
#[derive(Debug, Clone)]
pub(crate) struct SharedFrame {
    pub frame: u64,
    pub test: bool,
    /// `SharedFrames::rect` of the whitened frame, quantised.
    pub data: Vec<i16>,
}

/// The random slots of every tile: one uniform sample of all frames
/// (reservoir sampling), stored once over `rect` (the union of the tiles'
/// patches). Random slot `j` of every tile is frame `j` here, so the sample
/// is the same for every tile, and still uniform for each.
#[derive(Debug, Clone)]
pub(crate) struct SharedFrames {
    pub rect: Rect,
    pub frames: Vec<SharedFrame>,
    /// Frames offered so far.
    pub seen: u64,
}

impl SharedFrames {
    pub fn new(rect: Rect) -> SharedFrames {
        SharedFrames {
            rect,
            frames: Vec::new(),
            seen: 0,
        }
    }

    /// Offer frame `frame` (whitened, full frame `z`); `rand` is a fresh
    /// random number. Returns the slot it took, if any.
    pub fn offer(
        &mut self,
        z: &[f32],
        width: usize,
        frame: u64,
        test: bool,
        cap: usize,
        rand: u64,
    ) -> Option<usize> {
        if cap == 0 || self.rect.len() == 0 {
            return None;
        }
        self.seen += 1;
        let j = if self.frames.len() < cap {
            self.frames.push(SharedFrame {
                frame,
                test,
                data: Vec::new(),
            });
            self.frames.len() - 1
        } else {
            let j = (rand % self.seen) as usize;
            if j >= cap {
                return None;
            }
            j
        };
        let f = &mut self.frames[j];
        f.frame = frame;
        f.test = test;
        copy_rect(z, width, self.rect, &mut f.data);
        Some(j)
    }

    /// Offset in a stored frame of the first pixel of `r` (inside `rect`).
    fn origin(&self, r: Rect) -> usize {
        let s = self.rect;
        debug_assert!(r.y0 >= s.y0 && r.x0 >= s.x0);
        debug_assert!(r.y0 + r.h <= s.y0 + s.h && r.x0 + r.w <= s.x0 + s.w);
        (r.y0 - s.y0) * s.w + (r.x0 - s.x0)
    }

    /// The patch `r` (inside `rect`) of stored frame `j`, quantised.
    pub fn patch(&self, j: usize, r: Rect, out: &mut Vec<i16>) {
        let src = &self.frames[j].data;
        let o = self.origin(r);
        out.clear();
        out.reserve(r.len());
        for y in 0..r.h {
            let a = o + y * self.rect.w;
            out.extend_from_slice(&src[a..a + r.w]);
        }
    }

    /// The patch `r` of stored frame `j`, in σ units.
    pub fn values(&self, j: usize, r: Rect, out: &mut Vec<f32>) {
        let src = &self.frames[j].data;
        let o = self.origin(r);
        out.clear();
        out.reserve(r.len());
        for y in 0..r.h {
            let a = o + y * self.rect.w;
            out.extend(src[a..a + r.w].iter().map(|&v| f32::from(v) / QUANT));
        }
    }

    pub fn bytes(&self) -> usize {
        self.frames.len() * self.rect.len() * 2
    }
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
    /// Per event slot, the time-invariant log priority `ln score − frame ·
    /// ln decay` (its priority now is `exp(key + now · ln decay)`, so the
    /// order of the keys is the order of the priorities at any time), and
    /// the index of the smallest (`usize::MAX`: to be found again). Rebuilt
    /// when its length is not that of `events` (a decoded job's tile).
    ev_key: Vec<f64>,
    ev_min: usize,
    /// Random slot `j` is frame `j` of the shared uniform sample.
    pub randoms: Vec<Slot>,
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
            ev_key: Vec::new(),
            ev_min: usize::MAX,
            randoms: Vec::new(),
            fresh: 0,
            rejected: Vec::new(),
            tombs: Vec::new(),
            probes: Vec::new(),
            last_visit: 0,
        }
    }

    fn copy(&self, z: &[f32], width: usize, frame: u64, score: f32, test: bool) -> Slot {
        let mut data = Vec::new();
        copy_rect(z, width, self.rect, &mut data);
        Slot {
            frame,
            score,
            test,
            data,
            proj: None,
        }
    }

    /// Offer frame `frame` (whitened, full frame `z`) to the event slots,
    /// with this tile's residual `score`. An event slot's priority is its
    /// score times `exp(ln_decay)` per frame of age; a full tile replaces
    /// its lowest-priority slot when `score` beats it.
    #[allow(clippy::too_many_arguments)]
    pub fn offer(
        &mut self,
        z: &[f32],
        width: usize,
        frame: u64,
        score: f32,
        test: bool,
        cap_events: usize,
        ln_decay: f64,
    ) {
        if cap_events == 0 {
            return;
        }
        let key = |score: f32, frame: u64| f64::from(score).ln() - frame as f64 * ln_decay;
        if self.ev_key.len() != self.events.len() {
            self.ev_key = self.events.iter().map(|s| key(s.score, s.frame)).collect();
            self.ev_min = usize::MAX;
        }
        // Neighbouring frames of one transient: keep the stronger.
        if let Some(i) = self.events.iter().position(|s| frame - s.frame <= 2) {
            if score > self.events[i].score {
                self.events[i] = self.copy(z, width, frame, score, test);
                self.ev_key[i] = key(score, frame);
                self.ev_min = usize::MAX;
                self.fresh += 1;
            }
        } else if self.events.len() < cap_events {
            self.events.push(self.copy(z, width, frame, score, test));
            self.ev_key.push(key(score, frame));
            self.ev_min = usize::MAX;
            self.fresh += 1;
        } else {
            if self.ev_min == usize::MAX {
                // The first of the smallest, as a scan of the priorities.
                self.ev_min = self
                    .ev_key
                    .iter()
                    .enumerate()
                    .min_by(|a, b| a.1.total_cmp(b.1))
                    .expect("non-empty")
                    .0;
            }
            let imin = self.ev_min;
            // score > priority of slot imin now, in logs.
            if key(score, frame) > self.ev_key[imin] {
                self.events[imin] = self.copy(z, width, frame, score, test);
                self.ev_key[imin] = key(score, frame);
                self.ev_min = usize::MAX;
                self.fresh += 1;
            }
        }
    }

    /// Frame `frame` took slot `j` of the shared uniform sample.
    pub fn set_random(&mut self, j: usize, frame: u64, test: bool) {
        let slot = Slot {
            frame,
            score: 0.0,
            test,
            data: Vec::new(),
            proj: None,
        };
        if j == self.randoms.len() {
            self.randoms.push(slot);
        } else {
            self.randoms[j] = slot;
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

    /// The pixels of a slot (σ units): its own patch, or, for a random slot
    /// without one, its patch of the shared store.
    pub fn slot_values(&self, which: (bool, usize), shared: &SharedFrames, out: &mut Vec<f32>) {
        let s = self.slot(which);
        if !which.0 && s.data.is_empty() {
            debug_assert_eq!(shared.frames[which.1].frame, s.frame);
            shared.values(which.1, self.rect, out);
        } else {
            s.values(out);
        }
    }

    /// Give every random slot its own patch (from the shared store): a
    /// visit job carries its frames.
    pub fn fill_randoms(&mut self, shared: &SharedFrames) {
        for (j, s) in self.randoms.iter_mut().enumerate() {
            if s.data.is_empty() {
                shared.patch(j, self.rect, &mut s.data);
            }
        }
    }

    /// Bytes held by this tile's own slots: event slots, probes, and random
    /// slots that carry their patch (none in the owner's reservoir).
    pub fn bytes(&self) -> usize {
        let own = self.randoms.iter().filter(|s| !s.data.is_empty()).count();
        (self.events.len() + own + self.probes.len()) * self.rect.len() * 2
    }
}
