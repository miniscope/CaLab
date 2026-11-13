//! DIAG (`diagnostics` feature): one JSON line per merge test, accepted or
//! rejected, with the inputs of a split-half equivalence test (merge
//! redesign, Phase 1). `CALA_MERGE_LOG=<file>` turns it on; nothing is
//! decided from it.
//!
//! Per candidate: the current rule's statistic and overlap, and for each
//! cell its support (pixels, filtered values), its footprint statistics'
//! disk, full estimate and split halves (`h`, `h_A`, `h_B`, same units as
//! [`super::fpstats::FpStats::halves`]), the inverse pixel noise on the
//! disk, and (with ground truth registered) its best-matching GT unit.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::{Mutex, OnceLock};

use super::local::Cell;
use super::SlowLoop;

struct Gt {
    cols: Vec<Vec<(u32, f32)>>,
    bbox: Vec<(usize, usize, usize, usize)>,
}

struct Log {
    out: Mutex<BufWriter<File>>,
    gt: Mutex<Option<Gt>>,
}

fn log() -> Option<&'static Log> {
    static L: OnceLock<Option<Log>> = OnceLock::new();
    L.get_or_init(|| {
        let path = std::env::var_os("CALA_MERGE_LOG")?;
        let f = BufWriter::new(File::create(path).expect("create CALA_MERGE_LOG file"));
        Some(Log {
            out: Mutex::new(f),
            gt: Mutex::new(None),
        })
    })
    .as_ref()
}

/// Whether the merge log is on.
pub(super) fn on() -> bool {
    log().is_some()
}

/// Register the ground-truth units' filtered columns (as the QC matches
/// them) for the logged GT matches.
pub fn set_gt(cols: Vec<Vec<(u32, f32)>>, width: usize) {
    let Some(l) = log() else { return };
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
    *l.gt.lock().unwrap_or_else(|e| e.into_inner()) = Some(Gt { cols, bbox });
}

/// Flush the log (call at the end of a run).
pub fn flush() {
    if let Some(l) = log() {
        l.out
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .flush()
            .unwrap();
    }
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

/// The best and second-best GT units for `c` (its filtered footprint).
fn gt_match(gt: &Gt, c: &Cell) -> [(i64, f64); 2] {
    let a: Vec<(u32, f32)> = c.pix.iter().copied().zip(c.filt.iter().copied()).collect();
    let b = c.bbox;
    let mut best = [(-1i64, f64::NEG_INFINITY); 2];
    for (u, col) in gt.cols.iter().enumerate() {
        let (y0, x0, y1, x1) = gt.bbox[u];
        if y1 < b.y0 || x1 < b.x0 || y0 >= b.y0 + b.h || x0 >= b.x0 + b.w {
            continue;
        }
        let r = sparse_corr(&a, col);
        if r > best[0].1 {
            best[1] = best[0];
            best[0] = (u as i64, r);
        } else if r > best[1].1 {
            best[1] = (u as i64, r);
        }
    }
    best
}

fn arr<T: std::fmt::Display>(s: &mut String, name: &str, v: impl IntoIterator<Item = T>) {
    let _ = write!(s, ",\"{name}\":[");
    for (k, x) in v.into_iter().enumerate() {
        if k > 0 {
            s.push(',');
        }
        let _ = write!(s, "{x}");
    }
    s.push(']');
}

fn num(x: f64) -> String {
    if x.is_finite() {
        format!("{x:.6e}")
    } else {
        "null".into()
    }
}

fn f32s(v: &[f32]) -> impl Iterator<Item = String> + '_ {
    v.iter().map(|&x| num(f64::from(x)))
}

/// One cell's record.
fn cell_json(sl: &SlowLoop, c: &Cell, gt: Option<&Gt>) -> String {
    let mut s = String::new();
    let _ = write!(
        s,
        "{{\"id\":{},\"cy\":{},\"cx\":{},\"radius\":{},\"born\":{}",
        c.id, c.center.0, c.center.1, c.radius, c.born
    );
    if let Some(g) = gt {
        let m = gt_match(g, c);
        let _ = write!(
            s,
            ",\"gt\":{},\"gt_r\":{},\"gt2\":{},\"gt2_r\":{}",
            m[0].0,
            num(m[0].1),
            m[1].0,
            num(m[1].1)
        );
    }
    arr(&mut s, "pix", c.pix.iter());
    arr(&mut s, "filt", f32s(&c.filt));
    if let Some(st) = sl.fpstats.get(&c.id) {
        let _ = write!(
            s,
            ",\"st_k\":{},\"st_se\":{},\"st_version\":{}",
            st.k,
            num(st.std_err()),
            st.version
        );
        arr(&mut s, "st_pix", st.pix.iter());
        arr(
            &mut s,
            "st_is",
            st.pix
                .iter()
                .map(|&p| num(f64::from(sl.inv_sigma[p as usize]))),
        );
        let block = sl.filter.moat().map_or(0, |m| m.0);
        arr(
            &mut s,
            "st_cur",
            st.pix
                .iter()
                .map(|&g| num(f64::from(c.column_at(g, sl.dims.width, block)))),
        );
        if let Some(h) = st.estimate() {
            arr(&mut s, "st_h", f32s(&h));
        }
        if let Some((ha, hb, sa, sb)) = st.halves() {
            arr(&mut s, "st_ha", f32s(&ha));
            arr(&mut s, "st_hb", f32s(&hb));
            let _ = write!(s, ",\"st_sa\":{},\"st_sb\":{}", num(sa), num(sb));
        }
    }
    s.push('}');
    s
}

/// Per held-out test frame (whitened χ² units): the pair's χ² (current
/// footprints; refitted pair when tried), each single-column arm's χ², and
/// the traces each cell claims alone or in the pair, with the diagonal of
/// the reduced Gram (`c² Q` is the light the cell claims on the frame).
#[derive(Debug, Default)]
pub(super) struct Frames {
    pub pair: Vec<f64>,
    /// `(id, c_t, Q_kk)` of both cells in the pair fit.
    pub pair_c: [(u64, Vec<f32>, f64); 2],
    pub refit: Option<Vec<f64>>,
    pub merged: Option<Vec<f64>>,
    /// Drop-one arms: `(kept id, χ²_t, kept cell's c_t, Q_kk)`.
    pub solo: Vec<(u64, Vec<f64>, Vec<f32>, f64)>,
    pub rho: f64,
}

/// The current rule's view of one merge test.
pub(super) struct MergeRow {
    pub lo: u64,
    pub hi: u64,
    pub accept: bool,
    /// The held-out test's own verdict (before the split-half rule).
    pub legacy_accept: bool,
    /// `(μ − best loss) / s`, the legacy statistic (NaN without an arm).
    pub z: f64,
    pub ovl: f32,
    pub one: bool,
    pub forced: bool,
    /// Best arm: 0 merged footprint, 1 drop `lo`, 2 drop `hi`, −1 none.
    pub arm: i32,
    pub n_test: usize,
    /// The split-half merge statistic `Î` (see `merge_shape_excess`).
    pub shape: Option<f64>,
    pub frames: Frames,
    /// The held-out null `(μ, s)` of one extra column on these frames.
    pub null: (f64, f64),
}

pub(super) fn merge(sl: &SlowLoop, row: &MergeRow, a: &Cell, b: &Cell) {
    let Some(l) = log() else { return };
    let gt = l.gt.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = String::new();
    let _ = write!(
        s,
        "{{\"frame\":{},\"lo\":{},\"hi\":{},\"accept\":{},\"legacy_accept\":{},\"z\":{},\"ovl\":{},\"one\":{},\"forced\":{},\"arm\":{},\"n_test\":{},\"width\":{}",
        sl.frames,
        row.lo,
        row.hi,
        row.accept,
        row.legacy_accept,
        num(row.z),
        num(f64::from(row.ovl)),
        row.one,
        row.forced,
        row.arm,
        row.n_test,
        sl.dims.width
    );
    let _ = write!(
        s,
        ",\"shape_excess\":{}",
        row.shape.map_or("null".into(), num)
    );
    {
        let fr = &row.frames;
        let _ = write!(
            s,
            ",\"rho\":{},\"mu\":{},\"s\":{}",
            num(fr.rho),
            num(row.null.0),
            num(row.null.1)
        );
        arr(&mut s, "chi_pair", fr.pair.iter().map(|&x| num(x)));
        if let Some(v) = &fr.refit {
            arr(&mut s, "chi_refit", v.iter().map(|&x| num(x)));
        }
        if let Some(v) = &fr.merged {
            arr(&mut s, "chi_merged", v.iter().map(|&x| num(x)));
        }
        for (k, (id, c, q)) in fr.pair_c.iter().enumerate() {
            let _ = write!(s, ",\"pair_id{k}\":{id},\"pair_q{k}\":{}", num(*q));
            arr(&mut s, &format!("pair_c{k}"), f32s(c));
        }
        for (k, (id, chi, c, q)) in fr.solo.iter().enumerate() {
            let _ = write!(s, ",\"solo_id{k}\":{id},\"solo_q{k}\":{}", num(*q));
            arr(&mut s, &format!("solo_chi{k}"), chi.iter().map(|&x| num(x)));
            arr(&mut s, &format!("solo_c{k}"), f32s(c));
        }
    }
    let _ = writeln!(
        s,
        ",\"a\":{},\"b\":{}}}",
        cell_json(sl, a, gt.as_ref()),
        cell_json(sl, b, gt.as_ref())
    );
    drop(gt);
    l.out
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .write_all(s.as_bytes())
        .unwrap();
}
