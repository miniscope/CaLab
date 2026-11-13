//! DIAG shadow of the S2.1c decision rules (PR 0): the block / cluster-ratio
//! statistics of [`super::decide`] computed beside the current decisions
//! and logged, without changing any of them.
//!
//! Compiled only with `diagnostics` and inactive unless
//! `CALA_DECIDE_SHADOW=<dir>` is set (`qc_eval --decide-shadow` sets it to
//! the run's output directory). Like the rest of the diagnostics it only
//! writes observations: it never solves a problem the loop solves, never
//! spends work credit and never touches loop state. Its own state (look
//! counts, accumulated evidence per cell, pair and claim) lives in a
//! process-wide table keyed by cell id, so it survives visits run as jobs
//! (`--via-jobs`: the runner keeps the owner's ids) without travelling on
//! the wire. Parallel visit workers renumber new cells, so the shadow of a
//! cell added inside a job is only exact with `step` or `--via-jobs`.
//!
//! Files (tab separated, header first):
//! * `decide_fp.tsv`: every refine / absorb proposal the current rule tested
//!   (and every refine proposal it declined that the new trigger would have
//!   made, `kind = declined`): the old paired z and verdict; the trigger
//!   (`D2`, `I_hat`, `z_pred`, new frames); the Δ test on the cell's
//!   energy-weighted gain and its frame-weighted fallback; the GT
//!   correlation of the current and proposed footprint (sims).
//! * `decide_pairs.tsv`: every merge evaluation: the three arms' accumulated
//!   per-frame net loss beyond a noise column and the shadow verdict.
//! * `decide_keep.tsv`: every keep decision after new probe blocks were
//!   folded: `θ` (share of the claimed light that survives a free local
//!   background) and the shadow verdict.
//! * `decide_silent.tsv`: claims at adds, the first time the derived silence
//!   wait would delete a cell, and every deletion the current rule made.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::decide::{self, Acc, Block, Side};
use super::ledger::Evidence;
use super::local::{Cell, Fit, Problem};
use super::{solve_dense, SlowLoop};

/// Per-cell shadow state.
#[derive(Debug, Clone, Default)]
struct CellState {
    looks_fp: u64,
    /// Newest held-out frame of the cell's last footprint look.
    fp_look_until: Option<u64>,
    keep: Acc,
    /// Lifetime keep record (never reset; for scoring only).
    keep_all: Acc,
    keep_pending: Option<Block>,
    looks_keep: u64,
    established: bool,
    /// `(k blocks, earliest event frame, λ)` recorded at the add.
    claim: Option<(u32, u64, f64)>,
    silent_logged: bool,
}

#[derive(Debug, Clone, Default)]
struct PairState {
    until: Option<u64>,
    arms: [Acc; 3],
    looks: u64,
    /// Skipped until the last complete block reaches this.
    hold_until_block: u64,
}

struct Gt {
    cols: Vec<Vec<(u32, f32)>>,
    /// `(y0, x0, y1, x1)` of each unit's pixels.
    bbox: Vec<(usize, usize, usize, usize)>,
    detectable: Vec<bool>,
    width: usize,
}

#[derive(Default)]
struct State {
    cells: HashMap<u64, CellState>,
    pairs: HashMap<(u64, u64), PairState>,
    gt: Option<Gt>,
}

struct Shadow {
    state: Mutex<State>,
    files: Mutex<Files>,
}

struct Files {
    fp: BufWriter<File>,
    pairs: BufWriter<File>,
    keep: BufWriter<File>,
    silent: BufWriter<File>,
}

const FP_HEADER: &str = "frame\tkind\tid\tsource\tage\tn_test\tblocks\told_z\told_gain\told_accept\tD2\tI_hat\tscale\tz_pred\tnew_frames\ttriggered\tlooks\tmargin\ttheta\tse\tdof\tp\tpass\tpublish\ttheta_fw\tse_fw\tdof_fw\tp_fw\tpass_fw\tpublish_fw\tfp_noise\tgt\tgt_det\tgt_r_cur\tgt_r_new\tshadow_alt\n";
const PAIR_HEADER: &str = "frame\tlo\thi\told_accept\told_z\tovl\tone\tn_test\tnew_blocks\ttotal_blocks\tlooks\tmargin\tverdict\tbest_arm\ttheta0\tse0\tdof0\tp0_below\tp0_above\ttheta1\tse1\tdof1\tp1_below\tp1_above\ttheta2\tse2\tdof2\tp2_below\tp2_above\tnet0\tnet1\tnet2\tgt_lo\tgt_hi\tgt_r_lo\tgt_r_hi\n";
const KEEP_HEADER: &str = "frame\tid\tage\tprobes\tnew_blocks\ttotal_blocks\tlooks\tmargin\ttheta\tse\tdof\tp_below\tp_above\tverdict\ttheta_all\tse_all\tdof_all\tblocks_all\told_pass\told_fail\told_redundant\told_inconclusive\tpasses\tfails\ttransients\tgt\tgt_det\tgt_r\n";
const SILENT_HEADER: &str =
    "frame\tid\tevent\tage\tk\tt1\tlambda\twait\tev_frames\ttransients\tpasses\tfails\tgt\tgt_det\tgt_r\n";

fn shadow() -> Option<&'static Shadow> {
    static S: OnceLock<Option<Shadow>> = OnceLock::new();
    S.get_or_init(|| {
        let dir = PathBuf::from(std::env::var_os("CALA_DECIDE_SHADOW")?);
        std::fs::create_dir_all(&dir).expect("create CALA_DECIDE_SHADOW dir");
        let open = |name: &str, header: &str| {
            let mut f = BufWriter::new(File::create(dir.join(name)).expect("shadow file"));
            f.write_all(header.as_bytes()).unwrap();
            f
        };
        Some(Shadow {
            state: Mutex::new(State::default()),
            files: Mutex::new(Files {
                fp: open("decide_fp.tsv", FP_HEADER),
                pairs: open("decide_pairs.tsv", PAIR_HEADER),
                keep: open("decide_keep.tsv", KEEP_HEADER),
                silent: open("decide_silent.tsv", SILENT_HEADER),
            }),
        })
    })
    .as_ref()
}

/// Whether the shadow log is on.
pub(super) fn on() -> bool {
    shadow().is_some()
}

fn state() -> std::sync::MutexGuard<'static, State> {
    shadow()
        .expect("shadow on")
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn write(pick: impl FnOnce(&mut Files) -> &mut BufWriter<File>, line: &str) {
    if let Some(s) = shadow() {
        let mut f = s.files.lock().unwrap_or_else(|e| e.into_inner());
        let w = pick(&mut f);
        w.write_all(line.as_bytes()).unwrap();
    }
}

/// Flush every shadow file (call at the end of a run).
pub fn flush() {
    if let Some(s) = shadow() {
        let mut f = s.files.lock().unwrap_or_else(|e| e.into_inner());
        f.fp.flush().unwrap();
        f.pairs.flush().unwrap();
        f.keep.flush().unwrap();
        f.silent.flush().unwrap();
    }
}

/// Register the ground-truth units (filtered columns as the QC matches
/// them, and their `detectable` flags) for the GT columns of the logs.
pub fn set_gt(cols: Vec<Vec<(u32, f32)>>, detectable: Vec<bool>, width: usize) {
    if !on() {
        return;
    }
    let bbox = cols
        .iter()
        .map(|c| {
            c.iter().fold(
                (usize::MAX, usize::MAX, 0, 0),
                |(y0, x0, y1, x1), &(p, _)| {
                    let (y, x) = (p as usize / width, p as usize % width);
                    (y0.min(y), x0.min(x), y1.max(y), x1.max(x))
                },
            )
        })
        .collect();
    state().gt = Some(Gt {
        cols,
        bbox,
        detectable,
        width,
    });
}

/// Pearson correlation of two sparse images over the union of their pixels
/// (the QC's `sparse_corr`).
fn sparse_corr(a: &[(u32, f32)], b: &[(u32, f32)]) -> f64 {
    let mut ia: HashMap<u32, usize> = HashMap::with_capacity(a.len());
    let mut union: Vec<(f64, f64)> = Vec::with_capacity(a.len() + b.len());
    for (i, &(p, v)) in a.iter().enumerate() {
        ia.insert(p, i);
        union.push((f64::from(v), 0.0));
    }
    for &(p, v) in b {
        match ia.get(&p) {
            Some(&i) => union[i].1 = f64::from(v),
            None => union.push((0.0, f64::from(v))),
        }
    }
    let n = union.len() as f64;
    if n == 0.0 {
        return 0.0;
    }
    let ma = union.iter().map(|u| u.0).sum::<f64>() / n;
    let mb = union.iter().map(|u| u.1).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for &(x, y) in &union {
        sab += (x - ma) * (y - mb);
        saa += (x - ma) * (x - ma);
        sbb += (y - mb) * (y - mb);
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        sab / (saa * sbb).sqrt()
    }
}

fn sparse(c: &Cell) -> Vec<(u32, f32)> {
    c.pix.iter().copied().zip(c.filt.iter().copied()).collect()
}

/// The GT unit best correlated with `c` (its filtered footprint), with
/// its detectable flag and the correlation; `None` without GT.
fn gt_match(gt: &Option<Gt>, c: &Cell) -> Option<(usize, bool, f64)> {
    let gt = gt.as_ref()?;
    let a = sparse(c);
    let b = c.bbox;
    let mut best: Option<(usize, f64)> = None;
    for (u, col) in gt.cols.iter().enumerate() {
        let (y0, x0, y1, x1) = gt.bbox[u];
        if y1 < b.y0 || x1 < b.x0 || y0 >= b.y0 + b.h || x0 >= b.x0 + b.w {
            continue;
        }
        let r = sparse_corr(&a, col);
        if best.is_none_or(|bb| r > bb.1) {
            best = Some((u, r));
        }
    }
    best.map(|(u, r)| (u, gt.detectable[u], r))
}

fn gt_corr(gt: &Option<Gt>, u: usize, c: &Cell) -> f64 {
    gt.as_ref()
        .map_or(f64::NAN, |g| sparse_corr(&sparse(c), &g.cols[u]))
}

fn fmt_gt(m: Option<(usize, bool, f64)>) -> String {
    match m {
        Some((u, d, r)) => format!("{u}\t{}\t{r:.4}", u8::from(d)),
        None => "-1\t-1\tnan".into(),
    }
}

fn z0(sl: &SlowLoop) -> f64 {
    decide::z0(f64::from(sl.cfg.alpha0))
}

/// Trigger quantities in the units of the cell's current (whitened,
/// filtered) column: `D² = ‖h/a − cur‖²`, `Î = D² − ½‖(h_A − h_B)/a‖²`
/// (stats path; `Î = D²` for a reservoir refit), `a` the scale fitting
/// `cur` to the estimate.
struct Trigger {
    d2: f64,
    i_hat: f64,
    scale: f64,
}

/// The statistics path's trigger (`None` without an estimate or halves).
fn stats_trigger(sl: &SlowLoop, cell: &Cell) -> Option<Trigger> {
    let (pix, h) = sl.stats_estimate(cell.id)?;
    let st = sl.fpstats.get(&cell.id)?;
    let (ha, hb, _, _) = st.halves()?;
    let block = sl.filter.moat().map_or(0, |m| m.0);
    let w = sl.dims.width;
    let (mut hc, mut cc) = (0.0f64, 0.0f64);
    let cur: Vec<f64> = pix
        .iter()
        .map(|&g| f64::from(cell.column_at(g, w, block)))
        .collect();
    for (k, &p) in pix.iter().enumerate() {
        let is = f64::from(sl.inv_sigma[p as usize]);
        hc += f64::from(h[k]) * cur[k] * is * is;
        cc += cur[k] * cur[k] * is * is;
    }
    if !(cc > 0.0) || !(hc > 0.0) {
        return None;
    }
    let a = hc / cc;
    let (mut d2, mut half) = (0.0f64, 0.0f64);
    for (k, &p) in pix.iter().enumerate() {
        let is = f64::from(sl.inv_sigma[p as usize]);
        let d = (f64::from(h[k]) / a - cur[k]) * is;
        d2 += d * d;
        let e = f64::from(ha[k] - hb[k]) / a * is;
        half += 0.5 * e * e;
    }
    Some(Trigger {
        d2,
        i_hat: d2 - half,
        scale: a,
    })
}

/// The reservoir path's trigger: the proposed column against the current
/// one on the union of their supports, `Î = D²`.
fn change_trigger(sl: &SlowLoop, cell: &Cell, new: &Cell) -> Option<Trigger> {
    let block = sl.filter.moat().map_or(0, |m| m.0);
    let w = sl.dims.width;
    let mut pix: Vec<u32> = cell.pix.iter().chain(&new.pix).copied().collect();
    pix.sort_unstable();
    pix.dedup();
    let (mut nc, mut cc) = (0.0f64, 0.0f64);
    let vals: Vec<(f64, f64, f64)> = pix
        .iter()
        .map(|&g| {
            let is = f64::from(sl.inv_sigma[g as usize]);
            (
                f64::from(new.column_at(g, w, block)),
                f64::from(cell.column_at(g, w, block)),
                is,
            )
        })
        .collect();
    for &(n, c, is) in &vals {
        nc += n * c * is * is;
        cc += c * c * is * is;
    }
    if !(cc > 0.0) || !(nc > 0.0) {
        return None;
    }
    let a = nc / cc;
    let d2: f64 = vals
        .iter()
        .map(|&(n, c, is)| ((n / a - c) * is).powi(2))
        .sum();
    Some(Trigger {
        d2,
        i_hat: d2,
        scale: a,
    })
}

/// `z_pred = ½ (Î / D) √(Σ c² / (ρ s²))` over the test frames.
fn z_pred(t: &Trigger, sum_c2: f64, rho: f64, s2: f64) -> f64 {
    if !(t.d2 > 0.0) {
        return 0.0;
    }
    0.5 * (t.i_hat / t.d2.sqrt()) * (sum_c2 / (rho * s2)).sqrt()
}

fn fmt_ratio(r: &decide::Ratio) -> String {
    format!("{:.5}\t{:.5}\t{:.3}", r.theta, r.se, r.dof)
}

/// Δ test of a replacement footprint on the test frames: per-frame
/// `d_t = (χ²_t(base) − χ²_t(alt)) / s²`, weight `w_t` (the cell's energy),
/// on the blocks `keep` selects; energy-weighted and frame-weighted.
struct FpTest {
    blocks: u32,
    r: decide::Ratio,
    v: decide::Verdict,
    r_fw: decide::Ratio,
    v_fw: decide::Verdict,
}

fn fp_test(
    idx: &[u64],
    d: &[f64],
    w: &[f64],
    m: f64,
    keep: impl Fn(&Block) -> bool + Copy,
) -> FpTest {
    let blocks = decide::group(idx, d, w);
    let a = decide::acc_of(&blocks, keep);
    let ones: Vec<f64> = vec![1.0; idx.len()];
    let fw = decide::group(idx, d, &ones);
    let a_fw = decide::acc_of(&fw, keep);
    let (r, r_fw) = (a.ratio(), a_fw.ratio());
    FpTest {
        blocks: a.g,
        r,
        v: decide::test(&r, 0.0, Side::Above, m),
        r_fw,
        v_fw: decide::test(&r_fw, 0.0, Side::Above, m),
    }
}

/// Shared inputs of a refine-type row.
pub(super) struct RefineCtx<'a> {
    pub i: usize,
    pub base: &'a Problem,
    pub base_test: &'a [Fit],
    pub idx: &'a [u64],
    pub s2: f64,
}

impl RefineCtx<'_> {
    fn sum_c2(&self) -> f64 {
        self.base_test
            .iter()
            .map(|f| f64::from(f.c[self.i]).powi(2))
            .sum()
    }

    fn weights(&self) -> Vec<f64> {
        let n = self.base.len();
        let q = self.base.q[self.i * n + self.i].max(0.0);
        self.base_test
            .iter()
            .map(|f| f64::from(f.c[self.i]).powi(2) * q / self.s2)
            .collect()
    }
}

/// Look bookkeeping of a refine proposal: `(looks before, margin, new
/// frames, triggered)`; a triggered proposal is one look.
fn look(
    st: &mut CellState,
    t: Option<&Trigger>,
    zp: f64,
    z0: f64,
    newest: u64,
) -> (u64, f64, bool, bool) {
    let looks = st.looks_fp;
    let m = decide::margin(z0, looks + 1);
    let fresh = st.fp_look_until.is_none_or(|u| newest > u);
    let trig = fresh && t.is_some_and(|t| t.i_hat > 0.0) && zp >= m;
    if trig {
        st.looks_fp += 1;
        st.fp_look_until = Some(newest);
    }
    (looks, m, fresh, trig)
}

/// A statistics refine proposal the current rule declined (the estimate
/// agrees with the footprint, or the change is below `refine_min_change`):
/// logged only when the new trigger would have proposed it.
pub(super) fn refine_declined(sl: &SlowLoop, cell: &Cell, cx: &RefineCtx) {
    let Some(t) = stats_trigger(sl, cell) else {
        return;
    };
    let zp = z_pred(&t, cx.sum_c2(), f64::from(sl.rho), cx.s2);
    let newest = cx.idx.iter().copied().max().unwrap_or(0);
    let mut s = state();
    let st = s.cells.entry(cell.id).or_default();
    let (looks, m, fresh, trig) = look(st, Some(&t), zp, z0(sl), newest);
    drop(s);
    if !trig {
        return;
    }
    let line = format!(
        "{}\tdeclined\t{}\t1\t{}\t{}\t-1\tnan\tnan\t0\t{:.4}\t{:.4}\t{:.4}\t{:.3}\t{}\t1\t{looks}\t{m:.3}\tnan\tnan\tnan\tnan\t0\t0\tnan\tnan\tnan\tnan\t0\t0\tnan\t-1\t-1\tnan\tnan\t-1\n",
        sl.frames,
        cell.id,
        sl.frames.saturating_sub(cell.born),
        cx.idx.len(),
        t.d2,
        t.i_hat,
        t.scale,
        zp,
        u8::from(fresh),
    );
    write(|f| &mut f.fp, &line);
}

/// A refine proposal the current rule tested (`from_stats`: source 1,
/// else the reservoir refit, source 2).
#[allow(clippy::too_many_arguments)]
pub(super) fn refine_tested(
    sl: &SlowLoop,
    cell: &Cell,
    new: &Cell,
    cx: &RefineCtx,
    alt: &[Fit],
    from_stats: bool,
    old_z: f64,
    old_gain: f64,
    accepted: bool,
) {
    let t = if from_stats {
        stats_trigger(sl, cell)
    } else {
        change_trigger(sl, cell, new)
    };
    let zp = t
        .as_ref()
        .map_or(0.0, |t| z_pred(t, cx.sum_c2(), f64::from(sl.rho), cx.s2));
    let newest = cx.idx.iter().copied().max().unwrap_or(0);
    let d: Vec<f64> = cx
        .base_test
        .iter()
        .zip(alt)
        .map(|(b, a)| (b.chi2 - a.chi2) / cx.s2)
        .collect();
    let w = cx.weights();
    let noise = sl.footprint_noise(cell.id, &cell.pix).unwrap_or(f64::NAN);
    let mut s = state();
    let gm = gt_match(&s.gt, cell);
    let r_new = gm.map_or(f64::NAN, |(u, ..)| gt_corr(&s.gt, u, new));
    let st = s.cells.entry(cell.id).or_default();
    let (looks, m, fresh, trig) = look(st, t.as_ref(), zp, z0(sl), newest);
    drop(s);
    let ft = fp_test(cx.idx, &d, &w, m, |_| true);
    let pass = ft.r.theta > 0.0 && ft.v.pass;
    let pass_fw = ft.r_fw.theta > 0.0 && ft.v_fw.pass;
    let (d2, ih, sc) = t
        .as_ref()
        .map_or((f64::NAN, f64::NAN, f64::NAN), |t| (t.d2, t.i_hat, t.scale));
    let line = format!(
        "{}\trefine\t{}\t{}\t{}\t{}\t{}\t{old_z:.3}\t{old_gain:.3}\t{}\t{d2:.4}\t{ih:.4}\t{sc:.4}\t{zp:.3}\t{}\t{}\t{looks}\t{m:.3}\t{}\t{:.3e}\t{}\t{}\t{}\t{:.3e}\t{}\t{}\t{noise:.4}\t{}\t{r_new:.4}\t-1\n",
        sl.frames,
        cell.id,
        if from_stats { 1 } else { 2 },
        sl.frames.saturating_sub(cell.born),
        cx.idx.len(),
        ft.blocks,
        u8::from(accepted),
        u8::from(fresh),
        u8::from(trig),
        fmt_ratio(&ft.r),
        ft.v.p,
        u8::from(pass),
        u8::from(trig && pass),
        fmt_ratio(&ft.r_fw),
        ft.v_fw.p,
        u8::from(pass_fw),
        u8::from(trig && pass_fw),
        fmt_gt(gm),
    );
    write(|f| &mut f.fp, &line);
}

/// Inputs of the absorb shadow, gathered in `assess_add`.
pub(super) struct AbsorbInput {
    pub idx: Vec<u64>,
    pub s2: f64,
    /// Per alternative: `d_t` and the neighbour's energy `w_t`.
    pub d: Vec<Vec<f64>>,
    pub w: Vec<Vec<f64>>,
    /// Held-out frames counted as the candidate's events.
    pub events: Vec<u64>,
}

/// `d_t`, `w_t` of one alternative against the base fits `b` (neighbour
/// at column `j` of `base`, if any).
pub(super) fn absorb_terms(
    b: &[Fit],
    alt: &[Fit],
    base: &Problem,
    j: Option<usize>,
    s2: f64,
) -> (Vec<f64>, Vec<f64>) {
    let n = base.len();
    let d = b
        .iter()
        .zip(alt)
        .map(|(x, y)| (x.chi2 - y.chi2) / s2)
        .collect();
    let w = match j {
        Some(j) => {
            let q = base.q[j * n + j].max(0.0);
            b.iter()
                .map(|f| f64::from(f.c[j]).powi(2) * q / s2)
                .collect()
        }
        None => vec![0.0; b.len()],
    };
    (d, w)
}

/// The absorb decision the current rule made (best alternative `old_k`
/// on even frames, paired z on odd ones) beside the shadow: best on even
/// blocks, Δ test on odd blocks at the neighbour's next look.
#[allow(clippy::too_many_arguments)]
pub(super) fn absorb(
    sl: &SlowLoop,
    alts: &[Cell],
    kinds: &[u64],
    old_k: usize,
    old_z: f64,
    old_gain: f64,
    accepted: bool,
    inp: &AbsorbInput,
) {
    // Shadow choice on even blocks.
    let mut best: Option<(usize, f64)> = None;
    for (k, d) in inp.d.iter().enumerate() {
        let g: f64 = d
            .iter()
            .zip(&inp.idx)
            .filter(|(_, &t)| decide::block_of(t).is_multiple_of(2))
            .map(|(x, _)| x)
            .sum();
        if best.is_none_or(|b| g > b.1) {
            best = Some((k, g));
        }
    }
    let Some((k, _)) = best else { return };
    let a = &alts[k];
    let cur = sl.cells.iter().find(|c| c.id == a.id);
    let mut s = state();
    let gm = cur.and_then(|c| gt_match(&s.gt, c));
    let r_old = gm.map_or(f64::NAN, |(u, ..)| gt_corr(&s.gt, u, &alts[old_k]));
    let st = s.cells.entry(a.id).or_default();
    let looks = st.looks_fp;
    let m = decide::margin(z0(sl), looks + 1);
    st.looks_fp += 1;
    let newest = inp.idx.iter().copied().max().unwrap_or(0);
    st.fp_look_until = Some(st.fp_look_until.map_or(newest, |u| u.max(newest)));
    drop(s);
    let ft = fp_test(&inp.idx, &inp.d[k], &inp.w[k], m, |b| b.block % 2 == 1);
    let pass = ft.r.theta > 0.0 && ft.v.pass;
    let pass_fw = ft.r_fw.theta > 0.0 && ft.v_fw.pass;
    let noise = sl.footprint_noise(a.id, &a.pix).unwrap_or(f64::NAN);
    let age = cur.map_or(0, |c| sl.frames.saturating_sub(c.born));
    // GT columns: the current footprint's unit; `gt_r_new` is the old
    // rule's chosen alternative (what it would publish); `shadow_alt` is
    // the shadow's choice kind (+10 when it differs from the old one).
    let line = format!(
        "{}\tabsorb\t{}\t{}\t{age}\t{}\t{}\t{old_z:.3}\t{old_gain:.3}\t{}\tnan\tnan\tnan\tnan\t1\t1\t{looks}\t{m:.3}\t{}\t{:.3e}\t{}\t{}\t{}\t{:.3e}\t{}\t{}\t{noise:.4}\t{}\t{r_old:.4}\t{}\n",
        sl.frames,
        a.id,
        kinds[old_k],
        inp.idx.len(),
        ft.blocks,
        u8::from(accepted),
        fmt_ratio(&ft.r),
        ft.v.p,
        u8::from(pass),
        u8::from(pass),
        fmt_ratio(&ft.r_fw),
        ft.v_fw.p,
        u8::from(pass_fw),
        u8::from(pass_fw),
        fmt_gt(gm),
        if k == old_k {
            kinds[k] as i64
        } else {
            10 + kinds[k] as i64
        },
    );
    write(|f| &mut f.fp, &line);
}

/// The claim of a new cell (from its add test's held-out events).
pub(super) fn claim(sl: &SlowLoop, cell: &Cell, events: &[u64]) {
    let mut blocks: Vec<u64> = events.iter().map(|&t| decide::block_of(t)).collect();
    blocks.sort_unstable();
    blocks.dedup();
    let k = blocks.len() as u32;
    let t1 = events.iter().copied().min();
    let now = sl.frames;
    let mut s = state();
    let gm = gt_match(&s.gt, cell);
    let st = s.cells.entry(cell.id).or_default();
    let (lam, t1v) = match t1 {
        Some(t1) if k > 0 => {
            let span = now.saturating_sub(t1).max(decide::BLOCK) as f64;
            (f64::from(k) / span, t1)
        }
        _ => (0.0, 0),
    };
    st.claim = (k > 0).then_some((k, t1v, lam));
    drop(s);
    let a0 = f64::from(sl.cfg.alpha0);
    let wait = ((1.0 - a0) / a0).ln() / lam;
    let line = format!(
        "{now}\t{}\tclaim\t0\t{k}\t{t1v}\t{lam:.3e}\t{wait:.0}\t0\t0\t0\t0\t{}\n",
        cell.id,
        fmt_gt(gm)
    );
    write(|f| &mut f.silent, &line);
}

/// A split: the new part starts at the parent's look count.
pub(super) fn split(parent: u64, part: u64) {
    let mut s = state();
    let looks = s.cells.get(&parent).map_or(0, |c| c.looks_fp);
    s.cells.entry(part).or_default().looks_fp = looks;
}

/// Inputs of a merge evaluation (per test frame χ²).
pub(super) struct MergeInput<'a> {
    pub ti: usize,
    pub lo: u64,
    pub hi: u64,
    pub idx: &'a [u64],
    pub base_k: usize,
    pub n_cols: usize,
    /// χ² of the pair as it stands (for `s²`).
    pub sep: Vec<f64>,
    /// The baseline: the better of the current and the refitted pair.
    pub pair: Vec<f64>,
    /// Arms: merged, keep `lo` (drop `hi`), keep `hi` (drop `lo`).
    pub arms: [Option<Vec<f64>>; 3],
    pub old_accept: bool,
    pub old_z: f64,
    pub ovl: f32,
    pub one: bool,
}

/// A merge evaluation of the current rule beside the shadow's accumulated
/// pair evidence (complete blocks newer than the pair's last evaluation).
pub(super) fn merge(sl: &SlowLoop, mi: &MergeInput) {
    let rect = sl.tiles[mi.ti].rect;
    let n = mi.idx.len();
    let n_px = sl.fov_px(rect) as f64;
    let dof = (n as f64 * (n_px - (mi.base_k + mi.n_cols) as f64)).max(1.0);
    let s2 = (mi.sep.iter().sum::<f64>() / dof).max(1.0);
    let mu1 = sl.null(1).0;
    let now = sl.frames;
    // Last complete block: block end ≤ now.
    let done = decide::block_of(now); // blocks < done are complete
    let mut s = state();
    let ps = s.pairs.entry((mi.lo, mi.hi)).or_default();
    let looks = ps.looks;
    let m = decide::margin(z0(sl), looks + 3);
    let until = ps.until;
    let held = done < ps.hold_until_block;
    let fresh = |t: u64| decide::block_of(t) < done && until.is_none_or(|u| t > u);
    let mut new_blocks = 0u32;
    let mut nets = [f64::NAN; 3];
    let mut verdict = "skip";
    let mut best_arm: i32 = -1;
    let mut rows = [(
        decide::Ratio {
            theta: f64::NAN,
            se: f64::NAN,
            dof: 0.0,
            blocks: 0,
        },
        1.0f64,
        1.0f64,
    ); 3];
    for (a, arm) in mi.arms.iter().enumerate() {
        let Some(arm) = arm else { continue };
        let x: Vec<f64> = arm
            .iter()
            .zip(&mi.pair)
            .map(|(c, p)| (c - p) / s2 - mu1)
            .collect();
        nets[a] = x.iter().sum::<f64>() / n.max(1) as f64;
        if held {
            continue;
        }
        // Frames newer than `until` in complete blocks only.
        let sel: Vec<usize> = (0..n).filter(|&t| fresh(mi.idx[t])).collect();
        let xi: Vec<f64> = sel.iter().map(|&t| x[t]).collect();
        let fi: Vec<u64> = sel.iter().map(|&t| mi.idx[t]).collect();
        let wi = vec![1.0; sel.len()];
        let nb = decide::group(&fi, &xi, &wi);
        new_blocks = new_blocks.max(nb.len() as u32);
        let add = decide::acc_of(&nb, |_| true);
        ps.arms[a].add(&add);
    }
    let total_blocks = ps.arms.iter().map(|a| a.g).max().unwrap_or(0);
    if !held && new_blocks > 0 {
        for (a, arm) in mi.arms.iter().enumerate() {
            if arm.is_none() {
                continue;
            }
            let r = ps.arms[a].ratio();
            let below = decide::test(&r, 0.0, Side::Below, m);
            let above = decide::test(&r, 0.0, Side::Above, m);
            rows[a] = (r, below.p, above.p);
        }
        let present: Vec<usize> = (0..3).filter(|&a| mi.arms[a].is_some()).collect();
        let thr = decide::norm_sf(m);
        let merge = present
            .iter()
            .filter(|&&a| rows[a].1 < thr)
            .min_by(|&&a, &&b| rows[a].1.total_cmp(&rows[b].1));
        if let Some(&a) = merge {
            verdict = "merge";
            best_arm = a as i32;
        } else if !present.is_empty() && present.iter().all(|&a| rows[a].2 < thr) {
            verdict = "apart";
            ps.hold_until_block = done + u64::from(total_blocks);
            ps.arms = [Acc::default(); 3];
        } else {
            verdict = "undecided";
        }
        ps.looks += 3;
        let newest = mi
            .idx
            .iter()
            .copied()
            .filter(|&t| decide::block_of(t) < done)
            .max();
        if let Some(u) = newest {
            ps.until = Some(ps.until.map_or(u, |v| v.max(u)));
        }
    } else if held {
        verdict = "held";
    }
    let cell = |id: u64| sl.cells.iter().find(|c| c.id == id);
    let g_lo = cell(mi.lo).and_then(|c| gt_match(&s.gt, c));
    let g_hi = cell(mi.hi).and_then(|c| gt_match(&s.gt, c));
    drop(s);
    let mut line = format!(
        "{now}\t{}\t{}\t{}\t{:.3}\t{:.3}\t{}\t{n}\t{new_blocks}\t{total_blocks}\t{looks}\t{m:.3}\t{verdict}\t{best_arm}",
        mi.lo,
        mi.hi,
        u8::from(mi.old_accept),
        mi.old_z,
        mi.ovl,
        u8::from(mi.one),
    );
    for (r, pb, pa) in &rows {
        line.push_str(&format!("\t{}\t{pb:.3e}\t{pa:.3e}", fmt_ratio(r)));
    }
    for v in nets {
        line.push_str(&format!("\t{v:.4}"));
    }
    let (u_lo, r_lo) = g_lo.map_or((-1i64, f64::NAN), |(u, _, r)| (u as i64, r));
    let (u_hi, r_hi) = g_hi.map_or((-1i64, f64::NAN), |(u, _, r)| (u as i64, r));
    line.push_str(&format!("\t{u_lo}\t{u_hi}\t{r_lo:.4}\t{r_hi:.4}\n"));
    write(|f| &mut f.pairs, &line);
}

/// The current rule merged `gone` into `kept`: the kept cell takes the
/// larger footprint look count; the pair's record ends.
pub(super) fn merged(kept: u64, gone: u64) {
    let mut s = state();
    let g = s.cells.remove(&gone).map_or(0, |c| c.looks_fp);
    let k = s.cells.entry(kept).or_default();
    k.looks_fp = k.looks_fp.max(g);
    s.pairs.remove(&(kept.min(gone), kept.max(gone)));
}

/// Inputs of one cell's keep tests in a visit.
pub(super) struct KeepInput<'a> {
    pub id: u64,
    pub frames: Vec<u64>,
    pub plain: Option<&'a [f64]>,
    pub full: &'a Problem,
    pub ki: usize,
    pub f: &'a [Fit],
    pub r: &'a [Fit],
    pub dof: f64,
    pub old: (u32, u32, u32, u32),
}

/// One cell's keep probes folded into its record (blocks complete by a
/// later block or by their end), and the shadow decision.
pub(super) fn keep(sl: &SlowLoop, k: &KeepInput) {
    let mu1 = sl.null(1).0;
    // S_ii = 1 / (Q⁻¹)_ii of the cell's column in the bump problem.
    let n = k.full.len();
    let mut q = k.full.q.clone();
    let mut e = vec![0.0f64; n];
    e[k.ki] = 1.0;
    let s_ii = if solve_dense(&mut q, &mut e, n) && e[k.ki] > 0.0 {
        1.0 / e[k.ki]
    } else {
        0.0
    };
    let mut x = Vec::with_capacity(k.f.len());
    let mut w = Vec::with_capacity(k.f.len());
    for (j, (ff, rr)) in k.f.iter().zip(k.r).enumerate() {
        let s2 = (ff.chi2 / k.dof).max(1.0);
        x.push((rr.chi2 - ff.chi2) / s2 - mu1);
        let c0 = k.plain.map_or(0.0, |c| c[j].max(0.0));
        w.push(c0 * c0 * s_ii / s2);
    }
    let blocks = decide::group(&k.frames, &x, &w);
    let now = sl.frames;
    let done = decide::block_of(now);
    let cellref = sl.cells.iter().find(|c| c.id == k.id);
    let ev: Option<&Evidence> = sl.ledger.get(&k.id);
    let mut s = state();
    let gm = cellref.and_then(|c| gt_match(&s.gt, c));
    let st = s.cells.entry(k.id).or_default();
    let mut pending = st.keep_pending.take();
    let mut folded = 0u32;
    let mut fold = |st: &mut CellState, b: Block| {
        st.keep.push(b.x, b.w);
        st.keep_all.push(b.x, b.w);
        folded += 1;
    };
    for b in blocks {
        match pending {
            Some(mut p) if p.block == b.block => {
                p.x += b.x;
                p.w += b.w;
                p.n += b.n;
                pending = Some(p);
            }
            Some(p) => {
                fold(st, p);
                pending = Some(b);
            }
            None => pending = Some(b),
        }
    }
    if let Some(p) = pending {
        if p.block < done {
            fold(st, p);
        } else {
            st.keep_pending = Some(p);
        }
    }
    if folded == 0 {
        return;
    }
    let looks = st.looks_keep;
    let m = decide::margin(z0(sl), looks + 1);
    let r = st.keep.ratio();
    let below = decide::test(&r, 0.5, Side::Below, m);
    let above = decide::test(&r, 0.5, Side::Above, m);
    let verdict = if below.pass {
        "delete"
    } else if above.pass {
        st.established = true;
        st.keep = Acc::default();
        "confirm"
    } else {
        "undecided"
    };
    st.looks_keep += 1;
    let all = st.keep_all.ratio();
    drop(s);
    let age = cellref.map_or(0, |c| now.saturating_sub(c.born));
    let (passes, fails, tr) = ev.map_or((0, 0, 0), |e| (e.passes, e.fails, e.transients));
    let line = format!(
        "{now}\t{}\t{age}\t{}\t{folded}\t{}\t{looks}\t{m:.3}\t{}\t{:.3e}\t{:.3e}\t{verdict}\t{}\t{}\t{}\t{}\t{}\t{}\t{passes}\t{fails}\t{tr}\t{}\n",
        k.id,
        k.frames.len(),
        r.blocks,
        fmt_ratio(&r),
        below.p,
        above.p,
        fmt_ratio(&all),
        all.blocks,
        k.old.0,
        k.old.1,
        k.old.2,
        k.old.3,
        fmt_gt(gm),
    );
    write(|f| &mut f.keep, &line);
}

/// The silence check over the cells with a claim and no transient yet
/// (from `prune`): logs the first time the derived wait has passed.
pub(super) fn silent_check(sl: &SlowLoop) {
    let a0 = f64::from(sl.cfg.alpha0);
    let bound = ((1.0 - a0) / a0).ln();
    let mut s = state();
    let mut out = String::new();
    for c in &sl.cells {
        let Some(ev) = sl.ledger.get(&c.id) else {
            continue;
        };
        if ev.transients > 0 {
            continue;
        }
        let Some(st) = s.cells.get_mut(&c.id) else {
            continue;
        };
        let Some((k, t1, lam)) = st.claim else {
            continue;
        };
        if st.silent_logged || lam * (ev.frames as f64) < bound {
            continue;
        }
        st.silent_logged = true;
        out.push_str(&format!(
            "{}\t{}\twould_delete\t{}\t{k}\t{t1}\t{lam:.3e}\t{:.0}\t{}\t{}\t{}\t{}\t",
            sl.frames,
            c.id,
            sl.frames.saturating_sub(c.born),
            bound / lam,
            ev.frames,
            ev.transients,
            ev.passes,
            ev.fails,
        ));
        out.push_str(&fmt_gt(gt_match(&s.gt, c)));
        out.push('\n');
    }
    drop(s);
    if !out.is_empty() {
        write(|f| &mut f.silent, &out);
    }
}

/// A deletion by the current rule (`reason`), with the shadow state.
pub(super) fn deleted(sl: &SlowLoop, c: &Cell, reason: &str) {
    let ev = sl.ledger.get(&c.id);
    let s = state();
    let st = s.cells.get(&c.id).cloned().unwrap_or_default();
    let gm = gt_match(&s.gt, c);
    drop(s);
    let (k, t1, lam) = st.claim.unwrap_or((0, 0, 0.0));
    let a0 = f64::from(sl.cfg.alpha0);
    let line = format!(
        "{}\t{}\told_{reason}\t{}\t{k}\t{t1}\t{lam:.3e}\t{:.0}\t{}\t{}\t{}\t{}\t{}\n",
        sl.frames,
        c.id,
        sl.frames.saturating_sub(c.born),
        ((1.0 - a0) / a0).ln() / lam,
        ev.map_or(0, |e| e.frames),
        ev.map_or(0, |e| e.transients),
        ev.map_or(0, |e| e.passes),
        ev.map_or(0, |e| e.fails),
        fmt_gt(gm),
    );
    write(|f| &mut f.silent, &line);
}
