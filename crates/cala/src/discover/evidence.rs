//! Per-frame evidence on published cells: the ledger, the running footprint
//! statistics and the keep-test probes.

#[cfg(feature = "diagnostics")]
use super::diagnostics;
use super::fpstats::{parity_block, FpStats};
use super::ledger::Evidence;
use super::math::column_on;
use super::{timing, SlowLoop};
use crate::trace::{BackgroundModel, FrameTraces, Library};
use std::collections::HashMap;

/// Per library slot: the residual weights `h / σ²` on the support, the
/// coordinate normaliser `1 / Σ h² / σ²`, `Σ h / σ²` (for the ring level)
/// and the coordinate's noise σ.
#[derive(Default)]
pub(super) struct LedgerProj {
    pub(super) version: u64,
    pub(super) start: Vec<usize>,
    pub(super) pix: Vec<u32>,
    pub(super) w: Vec<f32>,
    /// `h w` per pixel: the pixel's share of the coordinate normaliser
    /// (what a missing pixel takes out of it).
    pub(super) nw: Vec<f32>,
    pub(super) inv_n: Vec<f32>,
    pub(super) wsum: Vec<f32>,
    pub(super) floor: Vec<f32>,
    /// Tile whose core holds the slot's centre (`usize::MAX`: none).
    pub(super) tile: Vec<usize>,
}

impl SlowLoop {
    /// Ledger update for one frame: each published cell's unconstrained
    /// coordinate `u = c + hᵀ Σ⁻¹ (y − model − level) / hᵀ Σ⁻¹ h`.
    pub(super) fn update_ledger(&mut self, frame: &[f32], lib: &Library, traces: &FrameTraces) {
        if self.lproj.version != lib.version() {
            self.build_lproj(lib);
        }
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. })
            && traces.background.len() == lib.len();
        let (ez, ef) = (self.cfg.event_z, self.cfg.event_frames);
        let lp = &self.lproj;
        let mut work = 0u64;
        for (slot, &id) in lib.ids().iter().enumerate() {
            let (a, b) = (lp.start[slot], lp.start[slot + 1]);
            let mut g = 0.0f32;
            // What the missing pixels of this frame take out of the
            // normaliser `hᵀΣ⁻¹h` and of `Σ h/σ²`: they have zero weight, so
            // the correction is over the valid pixels only.
            let (mut n_miss, mut w_miss) = (0.0f32, 0.0f32);
            for k in a..b {
                let p = lp.pix[k] as usize;
                let y = frame[p];
                if y.is_finite() {
                    g += lp.w[k] * (y - self.model[p]);
                } else {
                    n_miss += lp.nw[k];
                    w_miss += lp.w[k];
                }
            }
            work += (b - a) as u64 * 2;
            let level = if ring { traces.background[slot] } else { 0.0 };
            let c = traces.traces[slot];
            let u = if n_miss > 0.0 {
                let n = 1.0 / lp.inv_n[slot].max(1e-30);
                if n_miss > 0.75 * n {
                    // Too little of the cell is seen: no usable coordinate.
                    f32::NAN
                } else {
                    c + (g - level * (lp.wsum[slot] - w_miss)) * (1.0 / (n - n_miss))
                }
            } else {
                c + (g - level * lp.wsum[slot]) * lp.inv_n[slot]
            };
            if !u.is_finite() {
                continue;
            }
            self.ledger
                .entry(id)
                .or_insert_with(Evidence::new)
                .update(u, lp.floor[slot], ez, ef);
        }
        self.work += work;
    }

    /// Running footprint statistics (see `fpstats.rs`): a `fitting` frame's
    /// residual is accumulated. Returns the ms of the per-cell part and of
    /// the clusters' part (feature `timing`; zero otherwise).
    pub(super) fn update_fpstats(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        fitting: bool,
    ) -> (f64, f64) {
        if !fitting {
            return (0.0, 0.0);
        }
        let mut lap = timing::Lap::start();
        let (mut per_cell_ms, mut clusters_ms) = (0.0, 0.0);
        #[cfg(feature = "diagnostics")]
        let t0 = std::time::Instant::now();
        if self.fpstats.len() > lib.len() {
            let ids: std::collections::HashSet<u64> = lib.ids().iter().copied().collect();
            self.fpstats.retain(|id, _| ids.contains(id));
        }
        // A look-back frame for a few cells leaves the forgetting clock
        // alone (it would age every other cell's statistics): it enters at
        // the weight of the current frame.
        if self.lb_only.is_none() {
            self.stats_w /= self.stats_gamma;
        }
        if self.stats_w > 1024.0 {
            let f = 1.0 / self.stats_w;
            self.fpstats.values_mut().for_each(|s| s.scale(f));
            self.clusters.iter_mut().for_each(|c| c.scale(f64::from(f)));
            self.stats_w = 1.0;
        }
        let w = self.stats_w;
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. })
            && traces.background.len() == lib.len();
        let margin = self.cfg.stats_margin_cells * self.cfg.cell_diameter_px;
        let (width, height) = (self.dims.width, self.dims.height);
        let version = lib.version();
        let mut work = 0u64;
        for (slot, &id) in lib.ids().iter().enumerate() {
            if self.lb_only.as_ref().is_some_and(|o| !o.contains(&id)) {
                continue;
            }
            let (center, radius) = lib.support(slot);
            let want = radius + margin;
            let st = self.fpstats.entry(id).or_insert_with(|| {
                FpStats::new(
                    center,
                    want,
                    width,
                    height,
                    &self.fov,
                    parity_block(self.cfg.cell_diameter_px),
                )
            });
            // The disk also shrinks with the support (one margin of slack),
            // and pixels new to a moved disk start at the current model
            // rather than at zero.
            let mut old_pix = None;
            if !st.covers(center, radius) || st.radius > radius + 2.0 * margin {
                let moved = st.moved(center, want, width, height, &self.fov);
                let old = std::mem::replace(st, moved);
                old_pix = Some(old.pix);
            }
            if st.version != version || old_pix.is_some() {
                st.col = column_on(lib, slot, &st.pix);
                st.version = version;
            }
            if let Some(old) = &old_pix {
                st.seed_new(old);
            }
            let c = traces.traces[slot];
            let level = if ring { traces.background[slot] } else { 0.0 };
            // Missing pixels (non-finite `y`) get zero weight in the
            // statistics (NaN marks them; `FpStats::push` leaves their
            // moments alone).
            st.push_frame(frame, &self.model, level, c, w, &mut self.rbuf);
            work += st.pix.len() as u64 * 3;
        }
        #[cfg(feature = "diagnostics")]
        let t1 = std::time::Instant::now();
        lap.lap(&mut per_cell_ms);
        work += self.update_clusters(frame, lib, traces, w, ring);
        lap.lap(&mut clusters_ms);
        #[cfg(feature = "diagnostics")]
        {
            self.replay_stats.per_cell_ns += (t1 - t0).as_nanos() as u64;
            self.replay_stats.cluster_ns += t1.elapsed().as_nanos() as u64;
        }
        self.work += work;
        self.stats.work_stats += work;
        (per_cell_ms, clusters_ms)
    }

    /// The cell `id`'s running statistics start over with its next column
    /// (a merge or split replaced it).
    pub(super) fn stats_forget(&mut self, id: u64) {
        self.fpstats.remove(&id);
    }

    /// Held-out frame `frame`: store it as a probe in the tile of each cell
    /// that is in a confirmed transient of its ledger trace (the first
    /// held-out frame of that transient; at most once per
    /// `probe_gap_frames` per cell).
    pub(super) fn take_probes(&mut self, lib: &Library, frame: u64) {
        let gap = self.cfg.probe_gap_frames;
        let mut per_tile: Vec<(usize, u64)> = Vec::new();
        for (slot, &id) in lib.ids().iter().enumerate() {
            let Some(ev) = self.ledger.get_mut(&id) else {
                continue;
            };
            if !ev.probe_ready || ev.last_probe.is_some_and(|f| f + gap > frame) {
                continue;
            }
            ev.probe_ready = false;
            ev.run_probed = true;
            let ti = self.lproj.tile[slot];
            if ti == usize::MAX {
                continue;
            }
            ev.last_probe = Some(frame);
            per_tile.push((ti, id));
        }
        per_tile.sort_unstable();
        let w = self.dims.width;
        let cap = self.cfg.probes_per_tile;
        let mut i = 0;
        while i < per_tile.len() {
            let ti = per_tile[i].0;
            let mut cells = Vec::new();
            while i < per_tile.len() && per_tile[i].0 == ti {
                cells.push(per_tile[i].1);
                i += 1;
            }
            #[cfg(feature = "diagnostics")]
            diagnostics::probe(self, frame, ti, &cells);
            self.tiles[ti].probe(&self.z, w, frame, cells, cap);
            self.work += self.tiles[ti].rect.len() as u64;
        }
    }

    fn build_lproj(&mut self, lib: &Library) {
        let mut lp = LedgerProj {
            version: lib.version(),
            start: vec![0],
            ..LedgerProj::default()
        };
        for slot in 0..lib.len() {
            let (pix, h) = lib.filtered(slot);
            let (mut n, mut ws) = (0.0f64, 0.0f64);
            for (&p, &v) in pix.iter().zip(h) {
                let is = self.inv_sigma[p as usize];
                let w = v * is * is;
                lp.pix.push(p);
                lp.w.push(w);
                lp.nw.push(v * w);
                n += f64::from(v * w);
                ws += f64::from(w);
            }
            lp.start.push(lp.pix.len());
            let inv_n = if n > 0.0 { (1.0 / n) as f32 } else { 0.0 };
            lp.inv_n.push(inv_n);
            lp.wsum.push(ws as f32);
            lp.floor.push(inv_n.sqrt());
            let (c, _) = lib.support(slot);
            lp.tile.push(self.tile_of(c.0, c.1).unwrap_or(usize::MAX));
        }
        // Ledger entries of cells no longer published (deleted, merged);
        // cells whose column changed (a new coordinate scale) warm up again.
        let ids: std::collections::HashSet<u64> = lib.ids().iter().copied().collect();
        self.ledger.retain(|id, _| ids.contains(id));
        let old: HashMap<u64, f32> = self
            .lproj_ids
            .iter()
            .copied()
            .zip(self.lproj.inv_n.iter().copied())
            .collect();
        for (slot, &id) in lib.ids().iter().enumerate() {
            if let (Some(&o), Some(ev)) = (old.get(&id), self.ledger.get_mut(&id)) {
                let n = lp.inv_n[slot];
                if (n - o).abs() > 1e-3 * o.abs().max(1e-12) {
                    ev.rewarm();
                }
            }
        }
        self.lproj_ids = lib.ids().to_vec();
        self.lproj = lp;
    }
}
